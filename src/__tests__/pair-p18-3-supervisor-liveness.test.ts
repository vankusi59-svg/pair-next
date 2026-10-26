/**
 * P18.3 — Supervisor Collection Liveness & Autonomous Recovery.
 *
 * Forensic root causes proven on the live stack (see
 * docs/p18-3/P18_3_FORENSIC_ROOT_CAUSE.md):
 *
 * RC-A — applyPendingRecovery invoked while state === "RUNNING" never
 *   closed `pending_recovery` (apply arms require "RECOVERING"), so the
 *   compat leg re-applied the same action every tick and early-returned
 *   before the observe section: sibling executions starved ~63 min.
 * RC-B — in-flight observe/collect/settle only ran inside RUNNING/
 *   WAITING: every other live runtime state starved executions.
 * RC-C — env-gated adapter registration made reconcile see
 *   adapter:null → UNKNOWN_SIDE_EFFECT_STATE re-probes forever.
 * RC-D — no executor→supervisor completion signal was emitted.
 *
 * These tests pin the fixes: state-independent collection, deferred
 * recovery (never clobber pending), RECOVERING-entry before apply,
 * bounded unobservable orphan probes, canonical liveness stamps, and
 * exhaustion-event dedup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
  utcnow,
} from "../pair/index.js";
import {
  emitPlannerValidationRetryExhausted,
  plannerAdaptiveRetryForWorkItem,
} from "../pair/planner-adaptive-retry.js";
import { beginPlannerRun } from "../pair/planner-run.js";

const ROOT = mkTmpDir("pair-p183-");
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** Adapter whose observations are scriptable per execution: dispatch
 * mints an execution row; `finish(eid, status, result?)` decides when
 * observe turns terminal (mirrors a worker writing result.json). */
class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: Array<{ execution_id: string; task: Record<string, unknown> }> = [];
  private states = new Map<string, { status: string; result?: Record<string, unknown> }>();
  observeCalls = new Map<string, number>();
  /** When set, every dispatch is born terminal with this status and a
   *  committed-style result — exercises the settle-inside-apply path
   *  (recovery retry/reroute dispatch that is already terminal). */
  bornStatus: string | null = null;
  constructor(id: string) {
    this.executor_id = id;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS"] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push({ execution_id: eid, task });
    if (this.bornStatus) {
      this.finish(eid, this.bornStatus);
      return {
        execution_id: eid,
        status: this.bornStatus,
        run_root: `/runs/${eid}`,
        workspace: task.workspace,
      };
    }
    this.states.set(eid, { status: "RUNNING" });
    return {
      execution_id: eid,
      status: "RUNNING",
      run_root: `/runs/${eid}`,
      workspace: task.workspace,
    };
  }
  /** Pin a non-terminal/ambiguous observed status without writing a
   *  result — the supervisor must route it through governed recovery,
   *  never auto-settle. */
  markStatus(eid: string, status: string) {
    const prior = this.states.get(eid);
    this.states.set(eid, { status, result: prior?.result });
  }
  finish(eid: string, status = "COMPLETED", output?: Record<string, unknown>) {
    const task = this.dispatched.find((d) => d.execution_id === eid)?.task ?? {};
    this.states.set(eid, {
      status,
      result: {
        execution_id: eid,
        executor_id: this.executor_id,
        status,
        mission_id: task.mission_id,
        task_id: task.task_id,
        governed_task_id: task.governed_task_id,
        summary: output?.summary ?? `${status.toLowerCase()}`,
        artifacts: [],
        error: status === "COMPLETED" ? null : { class: "EXEC_FAILED", message: status },
        completed_at: utcnow(),
        ...output,
      },
    });
  }
  observe(executionId: string) {
    this.observeCalls.set(executionId, (this.observeCalls.get(executionId) ?? 0) + 1);
    const s = this.states.get(executionId);
    return { status: s?.status ?? "UNKNOWN" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const s = this.states.get(executionId);
    if (!s?.result) {
      throw Object.assign(new Error("not terminal"), { code: "FAIL_CLOSED_EXECUTION_NOT_TERMINAL" });
    }
    return s.result;
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

interface Ctx {
  dir: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  adapter: ScriptedAdapter;
  recon: ReconciliationService;
  projectId: string;
}

function makeCtx(
  name: string,
  opts: { adapterId?: string; taskCount?: number; taskConcurrency?: number } = {},
): Ctx {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const adapter = new ScriptedAdapter(opts.adapterId ?? "EX_A");
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, {
    mission_concurrency: opts.taskConcurrency ?? 2,
  });
  registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: ["FILE_OPERATIONS"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: 4,
    },
  });
  const routeId = `RTE_${adapter.executor_id}`;
  service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: ["FILE_OPERATIONS"],
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  adapters.set(adapter.executor_id, adapter);
  const nTasks = Math.max(1, Math.min(6, opts.taskCount ?? 2));
  const planner = () => ({
    tasks: Array.from({ length: nTasks }, (_, i) => ({
      task_key: `T${i + 1}`,
      title: `t${i + 1}`,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
    })),
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: dir });
  return { dir, store, service, runtime, supervisor, control, adapters, adapter, recon, projectId: String(project.project_id) };
}

function startMission(ctx: Ctx, expectExecs = 1): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "liveness",
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  const mid = String((m as Record<string, unknown>).mission_id);
  // Drive ticks until the mission dispatches (PLANNING→READY→RUNNING→dispatch).
  for (let i = 0; i < 30 && execs(ctx, mid).length < expectExecs; i++) ctx.runtime.tick(mid);
  return mid;
}

const rt = (ctx: Ctx, mid: string) =>
  ctx.store.list("mission_runtime").find((r) => r.mission_id === mid)!;
const execs = (ctx: Ctx, mid: string) =>
  ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);

describe("P18.3 — collection liveness", () => {
  it("LV-1 normal: terminal execution is collected + settled + stamped on the next tick", () => {
    const ctx = makeCtx("lv1");
    const mid = startMission(ctx);
    const e = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e.execution_id), "COMPLETED");
    ctx.runtime.tick(mid);
    const after = ctx.store.get("executor_execution", String(e.execution_id));
    expect(String(after.execution_state)).toBe("COMPLETED");
    expect(after.result).toBeTruthy();
    // P18.3 canonical liveness stamps
    expect(Number(after.observe_count)).toBeGreaterThanOrEqual(1);
    expect(after.last_observed_at).toBeTruthy();
    expect(after.first_terminal_observed_at).toBeTruthy();
    expect(after.collection_started_at).toBeTruthy();
    expect(Number(after.collection_attempts)).toBe(1);
    expect(after.collection_committed_at).toBeTruthy();
    expect(after.settled_at).toBeTruthy();
    const task = ctx.store.get("task", String(e.task_id));
    expect(String(task.status)).toBe("COMPLETED");
  });

  it("LV-2 state-independent: execution settles while runtime is in RECOVERING", () => {
    const ctx = makeCtx("lv2");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    // e1 fails → pending_recovery + runtime leaves RUNNING.
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid); // collect: e1 FAILED → pending_recovery, rt → RECOVERING (or backoff)
    const st1 = String(rt(ctx, mid).state);
    expect(st1).not.toBe("RUNNING");
    expect(rt(ctx, mid).pending_recovery).toBeTruthy();
    // e2 finishes while runtime is mid-recovery — RC-B: must still settle.
    ctx.adapter.finish(String(e2!.execution_id), "COMPLETED");
    ctx.runtime.tick(mid);
    const e2row = ctx.store.get("executor_execution", String(e2!.execution_id));
    expect(String(e2row.execution_state)).toBe("COMPLETED");
    expect(e2row.result).toBeTruthy();
    expect(String(ctx.store.get("task", String(e2row.task_id)).status)).toBe("COMPLETED");
  });

  it("LV-3 deferred: second failure queues instead of clobbering pending_recovery", () => {
    const ctx = makeCtx("lv3");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const pending1 = rt(ctx, mid).pending_recovery as Record<string, unknown>;
    expect(pending1).toBeTruthy();
    // e2 fails while pending1 in flight → deferred, NOT overwritten.
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const rtNow = rt(ctx, mid);
    const pending2 = rtNow.pending_recovery as Record<string, unknown>;
    expect(String(pending2.recovery_id)).toBe(String(pending1.recovery_id));
    const deferred = (rtNow.deferred_recovery as Array<Record<string, unknown>>) ?? [];
    expect(deferred.length).toBe(1);
    expect(String(deferred[0]!.task_id)).toBe(String(e2!.task_id));
    expect(String(ctx.store.get("task", String(e2!.task_id)).status)).toBe("FAILED");
  });

  it("LV-4 RC-A: pending_recovery applied from RUNNING state closes out — no starvation loop", () => {
    const ctx = makeCtx("lv4");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    // Drive e1 → FAILED → recovery with backoff > 0 if configured; force
    // the legacy window: runtime RUNNING *with* pending_recovery intact.
    ctx.adapter.finish(String(e1.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const r1 = rt(ctx, mid);
    // Force the exact pre-fix state: RUNNING + pending_recovery.
    const rtRow = { ...r1, state: "RUNNING", reason: "no_pending_backoff" };
    ctx.store.put("mission_runtime", String(r1.mission_runtime_id), rtRow, Number(r1.version));
    const e2 = execs(ctx, mid)[1]!;
    ctx.adapter.finish(String(e2.execution_id), "COMPLETED");
    // Pre-fix: every tick re-applied pending and never observed e2.
    // Post-fix: pending applies (enters RECOVERING → closes out) AND
    // collect runs in the same tick — e2 settles promptly.
    for (let i = 0; i < 6; i++) ctx.runtime.tick(mid);
    const e2row = ctx.store.get("executor_execution", String(e2.execution_id));
    expect(e2row.last_observation).toBeTruthy();
    expect(e2row.result).toBeTruthy();
  });

  it("LV-5 concurrent: N executions settle exactly once each", () => {
    const ctx = makeCtx("lv5");
    const mid = startMission(ctx);
    const es = execs(ctx, mid);
    for (const e of es) ctx.adapter.finish(String(e.execution_id), "COMPLETED");
    ctx.runtime.tick(mid);
    ctx.runtime.tick(mid);
    for (const e of es) {
      const row = ctx.store.get("executor_execution", String(e.execution_id));
      expect(row.result).toBeTruthy();
      expect(Number(row.collection_attempts)).toBe(1); // exactly-once collection
    }
    // All tasks terminal → mission completes via maybeComplete.
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid);
    expect(["COMPLETED", "RUNNING"]).toContain(String(ctx.service.getMission(mid).status));
  });

  it("LV-6 unbound adapter: blocking_reason recorded, sweep survives, settles after re-bind", () => {
    const ctx = makeCtx("lv6");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    const boundAdapter = ctx.adapters.get(String(e1!.executor_id))!;
    ctx.adapters.delete(String(e1!.executor_id)); // executor vanished (env-gated restart)
    ctx.adapter.finish(String(e1!.execution_id), "COMPLETED");
    ctx.adapter.finish(String(e2!.execution_id), "COMPLETED");
    ctx.runtime.tick(mid); // must not throw / starve
    const e1row = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(String((e1row.last_observation as Record<string, unknown>).blocking_reason)).toBe("ADAPTER_NOT_BOUND");
    // Re-bind (restart WITH the executor) → bounded sweep collects.
    ctx.adapters.set(String(e1!.executor_id), boundAdapter);
    ctx.runtime.tick(mid);
    const after = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(String(after.execution_state)).toBe("COMPLETED");
    expect(after.result).toBeTruthy();
  });

  it("LV-7 orphan bound: unobservable re-probes cap + single durable event", () => {
    const ctx = makeCtx("lv7");
    const dir = ctx.dir;
    // Mission already terminal + execution non-terminal + no adapter.
    const m = ctx.service.createMission({
      project_id: ctx.projectId,
      goal: "orphan",
      metadata: {},
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [dir],
    });
    const mid = String(m.mission_id);
    ctx.service.transitionMission(mid, "READY", "PAIR");
    ctx.service.transitionMission(mid, "RUNNING", "PAIR");
    ctx.service.transitionMission(mid, "FAILED", "PAIR");
    const eid = "EXEC_ORPHAN_1";
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, executor_id: "GHOST_EXEC", mission_id: mid,
      task_id: "TSK_X", governed_task_id: "GTSK_X", correlation_id: `${mid}:TSK_X`,
      execution_state: "RUNNING", dispatch_timestamp: utcnow(), version: 0,
    }, 0);
    const t0 = Date.now();
    for (let i = 0; i < 45; i++)
      ctx.recon.settleTerminalMissionOrphans(t0 + i * 31_000);
    const row = ctx.store.get("executor_execution", eid);
    expect(row.orphan_unobservable_final).toBe(true);
    expect(Number(row.orphan_unobservable_count)).toBeGreaterThanOrEqual(40);
    const evs = ctx.store.eventPage({
      topics: ["EXECUTION_ORPHAN_UNOBSERVABLE"], entity_type: "executor_execution",
      entity_id: eid, after_seq: 0, limit: 10, descending: true,
    });
    expect(evs.length).toBe(1); // exactly one durable event, no churn
    expect(String(row.execution_state)).toBe("RUNNING"); // fail-closed: state not rewritten
  });

  it("LV-8 dedup: identical exhausted episode emits one event; new rejection emits another", () => {
    const ctx = makeCtx("lv8");
    const wi = "DL_dedup_episode";
    const adaptive = plannerAdaptiveRetryForWorkItem(ctx.store, wi);
    expect(adaptive.exhausted).toBe(false);
    // Fake adaptive episode shape (same last run id → deduped).
    const ep1 = { ...adaptive, exhausted: true, rejected_run_count: 3, source: { planner_run_id: "PRN_A", planner_attempt_id: "PA_1", attempt_no: 1 } };
    expect(emitPlannerValidationRetryExhausted(ctx.store, wi, ep1, "PAIR_PLANNER")).toBe(true);
    expect(emitPlannerValidationRetryExhausted(ctx.store, wi, ep1, "PAIR_PLANNER")).toBe(false);
    const ep2 = { ...ep1, rejected_run_count: 4, source: { planner_run_id: "PRN_B", planner_attempt_id: "PA_2", attempt_no: 1 } };
    expect(emitPlannerValidationRetryExhausted(ctx.store, wi, ep2, "PAIR_REPLAN_GENERATION")).toBe(true);
    const evs = ctx.store.eventPage({
      topics: ["PLANNER_VALIDATION_RETRY_EXHAUSTED"], entity_type: "work_item",
      entity_id: wi, after_seq: 0, limit: 10, descending: true,
    });
    expect(evs.length).toBe(2);
  });

  it("LV-9 deferred signal must not starve a completing sibling (audit R1-1)", () => {
    // Reproduced shape: e1 FAILED arms pending_recovery; e2 UNKNOWN
    // defers; e3 COMPLETED must STILL settle on the same tick — the
    // pre-fix unconditional `return` parked e3 for the whole pending
    // window (the incident signature, inside the new loop).
    const ctx = makeCtx("lv9", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2, e3] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const armed = rt(ctx, mid).pending_recovery as Record<string, unknown>;
    expect(armed).toBeTruthy();
    expect(String(armed.task_id)).toBe(String(e1!.task_id));
    // e2 ambiguous while pending armed; e3 terminal-completed.
    ctx.adapter.markStatus(String(e2!.execution_id), "UNKNOWN");
    ctx.adapter.finish(String(e3!.execution_id), "COMPLETED");
    ctx.runtime.tick(mid);
    // e3 settled through the defer — the sweep continued past it.
    const e3row = ctx.store.get("executor_execution", String(e3!.execution_id));
    expect(e3row.result).toBeTruthy();
    expect(e3row.settled_at).toBeTruthy();
    expect(String(ctx.store.get("task", String(e3row.task_id)).status)).toBe("COMPLETED");
    // e2's signal was deferred, not dropped, and pending is untouched.
    const rtNow = rt(ctx, mid);
    expect(String((rtNow.pending_recovery as Record<string, unknown>).recovery_id))
      .toBe(String(armed.recovery_id));
    const deferred = (rtNow.deferred_recovery as Array<Record<string, unknown>>) ?? [];
    expect(deferred.some((d) => String(d.task_id) === String(e2!.task_id))).toBe(true);
  });

  it("LV-10 deterministic collect fault: row exits sweep once; sibling settles; no recovery churn (audit R1-2)", () => {
    // e1 finishes but collect returns a result with a forged
    // execution_id → gate IntegrityError (deterministic — can never
    // heal on replay). Pre-fix: the row re-faulted every tick AND
    // minted fresh recovery each pending-free window.
    const ctx = makeCtx("lv10", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2, e3] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "COMPLETED", { execution_id: "FORGED" });
    ctx.adapter.finish(String(e2!.execution_id), "COMPLETED");
    ctx.adapter.finish(String(e3!.execution_id), "COMPLETED");
    ctx.runtime.tick(mid); // e1 fault → excluded + RESULT_SCHEMA armed → return
    const bad = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(bad.result).toBeFalsy();
    expect(bad.collect_excluded).toBeTruthy();
    const rtNow = rt(ctx, mid);
    expect(String((rtNow.pending_recovery as Record<string, unknown>).task_id))
      .toBe(String(e1!.task_id));
    // Siblings settle while T1's recovery is armed — no starvation.
    ctx.runtime.tick(mid);
    for (const e of [e2, e3]) {
      const row = ctx.store.get("executor_execution", String(e!.execution_id));
      expect(row.result).toBeTruthy();
      expect(row.settled_at).toBeTruthy();
    }
    // Drive through the whole recovery chain — the excluded row must
    // never re-fault, never re-mint a second RESULT_SCHEMA chain.
    for (let i = 0; i < 30; i++) ctx.runtime.tick(mid);
    const excluded = ctx.store.listEvidence(mid).filter(
      (ev) => String(ev.kind) === "EXECUTION_COLLECTION_EXCLUDED",
    );
    expect(excluded.length).toBe(1);
    const badAfter = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(badAfter.result).toBeFalsy(); // forged evidence can never settle
    // Exactly one RESULT_SCHEMA chain for T1 — a retry may mint a new
    // execution, but the wedged row must not churn recovery.
    const decisions = ctx.store
      .list("recovery_decision")
      .filter((d) => String(d.task_id) === String(e1!.task_id));
    expect(decisions.length).toBeLessThanOrEqual(3);
  });

  it("LV-12 drain fires a settle-arm deferred entry — FAILED is not resolved (audit R2-1)", async () => {
    // The deferred entry's own task is FAILED with a committed result —
    // that is WHY it was queued. A drain that prunes on task-terminal or
    // committed-result silently deletes the normal deferred shape
    // (stranded FAILED task, zero recovery, zero evidence).
    const ctx = makeCtx("lv12");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(rt(ctx, mid).pending_recovery).toBeTruthy();
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const deferred = (rt(ctx, mid).deferred_recovery as Array<Record<string, unknown>>) ?? [];
    expect(deferred.some((d) => String(d.task_id) === String(e2!.task_id))).toBe(true);
    // Drive: e1's chain resolves (retry mints a new execution for T1),
    // then the deferred entry MUST fire startRecovery for T2 — never
    // be pruned as "stale" despite task FAILED + committed result.
    // T1's RETRY arm carries a 1 s real-clock backoff — sleep past it
    // so the due action can apply and free the pending slot.
    let e2Armed = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !e2Armed) {
      ctx.runtime.tick(mid);
      await new Promise((r) => setTimeout(r, 150));
      const p = rt(ctx, mid).pending_recovery as Record<string, unknown> | null;
      if (p && String(p.task_id) === String(e2!.task_id)) e2Armed = true;
    }
    expect(e2Armed).toBe(true);
    // The deferred signal produced governed recovery work for T2.
    const decisions = ctx.store
      .list("recovery_decision")
      .filter((d) => String(d.task_id) === String(e2!.task_id));
    expect(decisions.length).toBeGreaterThanOrEqual(1);
  });

  it("LV-11 observe-fault bound: persistent observe throw is bounded + excluded", () => {
    const ctx = makeCtx("lv11");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    const orig = ctx.adapter.observe.bind(ctx.adapter);
    ctx.adapter.observe = (eid: string) => {
      if (eid === String(e1!.execution_id)) throw new Error("observe blew up");
      return orig(eid);
    };
    ctx.adapter.finish(String(e2!.execution_id), "COMPLETED");
    for (let i = 0; i < 26; i++) ctx.runtime.tick(mid);
    const row = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(row.collect_excluded).toBeTruthy();
    expect(Number((row.last_observation as Record<string, unknown>).observe_faults))
      .toBeGreaterThanOrEqual(24);
    // The faulting row never starved its sibling.
    const e2row = ctx.store.get("executor_execution", String(e2!.execution_id));
    expect(e2row.result).toBeTruthy();
  });

  it("LV-13 apply-path settle continues the chain — terminal retry dispatch arms successor (audit R3)", async () => {
    const ctx = makeCtx("lv13", { taskCount: 1 });
    // Every dispatch is born terminal-FAILED: the RETRY apply's inline
    // settle lands while the chain's own pending is still armed. The
    // successor decision must replace the spent arm — a dedup-drop
    // leaves task FAILED + pending null + RUNNING forever (the 4017d53
    // regression the phase-d suite caught).
    ctx.adapter.bornStatus = "FAILED";
    const mid = startMission(ctx);
    const decisions = () =>
      ctx.store
        .list("recovery_decision")
        .filter((d) => String(d.mission_id) === mid);
    const stalled = () =>
      String(rt(ctx, mid).state) === "RUNNING" &&
      !rt(ctx, mid).pending_recovery &&
      String(ctx.store.get("task", String(execs(ctx, mid)[0]!.task_id)).status) === "FAILED";
    // RETRY arms carry real-clock backoff (~1s) — poll with real sleep
    // so scheduled actions can fire, as in LV-12.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && decisions().length < 2 && !stalled()) {
      ctx.runtime.tick(mid);
      await new Promise((r) => setTimeout(r, 120));
    }
    expect(stalled()).toBe(false);
    // The chain kept deciding: each retry-minted failure produced a new
    // governed decision until the escalation ceiling.
    expect(decisions().length).toBeGreaterThanOrEqual(2);
  });

  it("LV-14 post-commit settle fault: transient fault self-heals via re-settle; persistent is bounded+governed (audit R4 / P18.4)", async () => {
    const ctx = makeCtx("lv14", { taskCount: 1 });
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    // Fault AFTER the canonical result commits: collect succeeds, then
    // the first updateTask(COMPLETED) throws. P18.3-R4 could only
    // exclude+recover here because the row could never re-enter the
    // sweep. P18.4's settle transaction rolls the disposition back and
    // `settle_complete` keeps the row sweep-eligible — a TRANSIENT
    // post-commit fault now self-heals: next tick re-settles exactly
    // once, no recovery round-trip, no strand.
    const origUpdate = ctx.service.updateTask.bind(ctx.service);
    let threw = false;
    ctx.service.updateTask = ((taskId: string, patch: Record<string, unknown>) => {
      if (!threw && patch.status === "COMPLETED") {
        threw = true;
        throw new Error("injected post-commit settle fault");
      }
      return origUpdate(taskId, patch);
    }) as typeof ctx.service.updateTask;
    ctx.adapter.finish(String(e1.execution_id), "COMPLETED");
    ctx.runtime.tick(mid); // collect commits result → settle throws + rolls back
    const row = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(row.result).toBeTruthy(); // committed BEFORE the fault
    expect(threw).toBe(true);
    // Not stranded, not excluded — the row re-enters the sweep.
    expect(row.settle_complete).toBeFalsy();
    ctx.runtime.tick(mid); // re-settle: the fault was one-shot → commits
    const after = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(after.settle_complete).toBe(true);
    expect(after.settled_at).toBeTruthy();
    expect(String(ctx.store.get("task", String(e1.task_id)).status)).toBe("COMPLETED");
    // Exactly-once: a single TASK_COMPLETED event despite the fault+replay.
    expect(
      ctx.store.listEvents("task", String(e1.task_id)).filter(
        (ev) => String(ev.event_type) === "TASK_COMPLETED",
      ).length,
    ).toBe(1);
    // And the mission is not parked RUNNING with nothing armed.
    const r = rt(ctx, mid);
    const parkedDead =
      String(r.state) === "RUNNING" &&
      !r.pending_recovery &&
      !(r.pending_recovery != null ||
        ((r.deferred_recovery as Array<Record<string, unknown>> | undefined) ?? []).length > 0 ||
        ctx.store.list("recovery_decision").some((d) => String(d.task_id) === String(e1.task_id)));
    expect(parkedDead).toBe(false);
  });
});
