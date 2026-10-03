/**
 * Live-ops recovery closure — Bug C + Devin completion protocol.
 *
 * A: an apply-path governed routing throw (PolicyError from the router)
 *    becomes recovery evidence (`infeasible_actions`) fed back into the
 *    canonical decide() — the identical attempt is rejected with
 *    APPLY_INFEASIBLE:<code> and the NEXT matrix action is evaluated, so a
 *    mission can never sit RECOVERING replaying the same throw forever
 *    (observed on MSN_01M3VHGS6HPA62V6K9JR57MNEK). Unexpected defects are
 *    NOT normalized into routing infeasibility — they re-decide under
 *    INTERNAL_RUNTIME_DEFECT. Every step persists recovery_decision rows.
 *
 * B: governed completion protocol — `PAIR_EXECUTION_COMPLETE` marker in the
 *    remote devin_message is the completion contract; legacy bare-DONE is
 *    the fallback. A blocked/suspended enum after verified completion can
 *    no longer downgrade the execution to FAILED/REMOTE_INPUT_REQUIRED,
 *    and a late-arriving remote fetch at the timeout boundary can still
 *    prove completion.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  DevinExecutorAdapter,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";
import type { DevinFetch } from "../pair/devin-executor.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-lorc-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* ---------------------------- scripted executor ---------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  script: Array<{ status: string; error_class?: string }>;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};

  constructor(
    id: string,
    script: Array<{ status: string; error_class?: string }> = [],
    caps: string[] = ["FILE_OPERATIONS"],
  ) {
    this.executor_id = id;
    this.script = [...script];
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "FAILED", error_class: "RATE_LIMITED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "RATE_LIMITED", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: "ok" };
    return { execution_id: eid, status: step.status, run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

/* --------------------------------- ctx ------------------------------------ */

function makeCtx(name: string) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["ONLY_EX_A"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service), planner,
  });
  service.registerCapability("ONLY_EX_A", { risk_class: "LOW" });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId: String(project.project_id),
  };
}

function registerAdapter(
  ctx: ReturnType<typeof makeCtx>,
  adapter: ExecutorAdapter,
  caps: string[],
) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: caps,
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
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: caps,
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: caps,
  });
  ctx.adapters.set(adapter.executor_id, adapter);
}

function startMission(ctx: ReturnType<typeof makeCtx>): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "lorc",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
}

function rt(ctx: ReturnType<typeof makeCtx>, missionId: string) {
  return ctx.store.get("mission_runtime", `MRT_${missionId}`);
}

function decisions(ctx: ReturnType<typeof makeCtx>, missionId: string) {
  return ctx.store.list("recovery_decision").filter((d) => d.mission_id === missionId);
}

const FAR = "2999-01-01T00:00:00Z";

/** Monotonically increasing fake clock — scheduled backoff actions become
 *  due on the next tick without real-time waits. */
function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

describe("LORC A — apply-path routing throw → bounded re-decide", () => {
  it("A1. single-executor capability: RE_ROUTE throws NO_ELIGIBLE_EXECUTOR → APPLY_INFEASIBLE → bounded (never RECOVERING limbo)", () => {
    const ctx = makeCtx("a1");
    const exA = new ScriptedAdapter(
      "EX_A",
      [
        { status: "FAILED", error_class: "RATE_LIMITED" },
        { status: "FAILED", error_class: "RATE_LIMITED" },
        { status: "FAILED", error_class: "RATE_LIMITED" },
        { status: "FAILED", error_class: "RATE_LIMITED" },
        { status: "FAILED", error_class: "RATE_LIMITED" },
        { status: "FAILED", error_class: "RATE_LIMITED" },
      ],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
    );
    registerAdapter(ctx, exA, exA.caps);
    // Second routable executor exists (so decide() sees RE_ROUTE alternates)
    // but lacks the capability — the exact live limbo shape.
    registerAdapter(ctx, new ScriptedAdapter("EX_B", []), ["FILE_OPERATIONS"]);
    const mid = startMission(ctx);
    const clock = fakeClock();
    for (let i = 0; i < 80; i++) {
      ctx.runtime.tick(mid, clock());
      if (["WAITING_APPROVAL", "ABORTED", "FAILED"].includes(String(rt(ctx, mid).state))) break;
    }
    const state = String(rt(ctx, mid).state);
    expect(["WAITING_APPROVAL", "ABORTED", "FAILED"]).toContain(state);
    const all = decisions(ctx, mid);
    const infeasible = all.some((d) =>
      (d.rejected_actions as Array<{ action: string; reason: string }>).some(
        (r) => r.action === "RE_ROUTE" && String(r.reason).startsWith("APPLY_INFEASIBLE:FAIL_CLOSED_"),
      ),
    );
    expect(infeasible).toBe(true);
    if (state === "WAITING_APPROVAL") {
      expect(ctx.approvals.listPending(mid).length).toBeGreaterThan(0);
    }
  });

  it("A2. RETRY_SAME_ROUTE with constraint executor unbound → ADAPTER_NOT_BOUND evidence, not a swallowed throw", () => {
    const ctx = makeCtx("a2");
    const exA = new ScriptedAdapter(
      "EX_A",
      [{ status: "FAILED", error_class: "TRANSIENT_TRANSPORT" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
    );
    registerAdapter(ctx, exA, exA.caps);
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    // Seed a RETRY_SAME_ROUTE pending_recovery pinned to an executor that
    // has no adapter bound — the router throws FAIL_CLOSED_ADAPTER_NOT_BOUND
    // or NO_ELIGIBLE_EXECUTOR; either is governed PolicyError evidence.
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed",
      action: "RETRY_SAME_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "GHOST_EXECUTOR",
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    const clock = fakeClock();
    for (let i = 0; i < 6; i++) ctx.runtime.tick(mid, clock());
    // Bounded: the throw became canonical decision evidence instead of a
    // silently swallowed per-tick exception.
    const rejected = decisions(ctx, mid)
      .flatMap((d) => d.rejected_actions as Array<{ action: string; reason: string }>);
    expect(
      rejected.some(
        (r) => r.action === "RETRY_SAME_ROUTE" && String(r.reason).startsWith("APPLY_INFEASIBLE:FAIL_CLOSED_"),
      ),
    ).toBe(true);
    const latest = decisions(ctx, mid).at(-1)!;
    expect(String(latest.selected_action)).not.toBe("RETRY_SAME_ROUTE");
  });

  it("A3. RE_ROUTE when no alternate route exists → bounded re-decide (APPLY_INFEASIBLE persisted)", () => {
    const ctx = makeCtx("a3");
    const exA3 = new ScriptedAdapter(
      "EX_A",
      [{ status: "FAILED", error_class: "RATE_LIMITED" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
    );
    registerAdapter(ctx, exA3, exA3.caps);
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed3",
      action: "RE_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "EX_A",
      failure_class: "RATE_LIMITED",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    ctx.runtime.tick(mid, FAR);
    const latest = decisions(ctx, mid).at(-1)!;
    expect(
      (latest.rejected_actions as Array<{ action: string; reason: string }>).some(
        (r) => r.action === "RE_ROUTE" && String(r.reason).includes("APPLY_INFEASIBLE:FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR"),
      ),
    ).toBe(true);
    expect(String(latest.selected_action)).toBe("RETRY_SAME_ROUTE");
  });

  it("A4. unexpected programmer error is NOT normalized into routing evidence — INTERNAL_RUNTIME_DEFECT decides", () => {
    const ctx = makeCtx("a4");
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed4",
      action: "RE_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "EX_A",
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    // Router that throws a non-PolicyError defect.
    const defective = new MissionRuntime({
      service: ctx.service, gate: ctx.gate,
      router: { routeGovernedTask: () => { throw new IntegrityError("integrity_corrupt"); } } as never,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: (() => ({ tasks: [] })) as never,
    });
    defective.tick(mid, FAR);
    const latest = decisions(ctx, mid).at(-1)!;
    expect(String(latest.failure_class)).toBe("INTERNAL_RUNTIME_DEFECT");
    expect(String(latest.selected_action)).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(String(rt(ctx, mid).state)).toBe("WAITING_APPROVAL");
  });

  it("A5. infeasible_actions persist on pending_recovery across runtime restart", () => {
    const ctx = makeCtx("a5");
    const exA5 = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA5, exA5.caps);
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed5",
      action: "RE_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "EX_A",
      failure_class: "RATE_LIMITED",
      backoff_ms: 0,
      infeasible_actions: [{ action: "RE_ROUTE", reason: "FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR" }],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    // "restart": fresh runtime object over the same store sees the evidence.
    const runtime2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router, adapters: ctx.adapters,
      scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: (() => ({ tasks: [] })) as never,
    });
    runtime2.tick(mid, FAR);
    const latest = decisions(ctx, mid).at(-1)!;
    // The persisted infeasible entry reached decide() — RE_ROUTE never
    // replays its throw and the chain moves to the next matrix action.
    const rejected = latest.rejected_actions as Array<{ action: string; reason: string }>;
    expect(
      rejected.some(
        (r) => r.action === "RE_ROUTE" && String(r.reason).includes("APPLY_INFEASIBLE"),
      ),
    ).toBe(true);
    expect(String(latest.selected_action)).not.toBe("RE_ROUTE");
  });

  it("A6. non-router apply-path throw (supersede on missing governed_task) → bounded defect decision, not supervisor-swallowed limbo", () => {
    const ctx = makeCtx("a6");
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed6",
      action: "RETRY_SAME_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      // governed_task row does not exist — supersedeGovernedTask throws a
      // non-PolicyError defect OUTSIDE the router call site.
      governed_task_id: "GTSK_missing",
      executor_id: null,
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    ctx.runtime.tick(mid, FAR);
    const latest = decisions(ctx, mid).at(-1)!;
    expect(String(latest.failure_class)).toBe("INTERNAL_RUNTIME_DEFECT");
    // The throw became a canonical bounded decision — the mission is no
    // longer replaying an unchanged pending_recovery on every tick.
    expect(["WAITING_APPROVAL", "ABORTED"]).toContain(String(rt(ctx, mid).state));
    for (let i = 0; i < 3; i++) ctx.runtime.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).not.toBe("RECOVERING");
  });

  it("A7. RECONCILING-state throw (reconcile dep defect) → bounded defect decision, not silent RECONCILING limbo", () => {
    const ctx = makeCtx("a7");
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECONCILING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed7",
      action: "RECONCILIATION_REQUIRED",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: null,
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    rtEnt.barriers = {
      [String(task.task_id)]: { kind: "RECONCILIATION", execution_id: "EXE_x", settled: false },
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    const defective = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: { reconcile: () => { throw new IntegrityError("recon_corrupt"); } } as never,
      recovery: ctx.recovery, planner: (() => ({ tasks: [] })) as never,
    });
    defective.tick(mid, FAR);
    const latest = decisions(ctx, mid).at(-1)!;
    expect(String(latest.failure_class)).toBe("INTERNAL_RUNTIME_DEFECT");
    expect(["WAITING_APPROVAL", "ABORTED"]).toContain(String(rt(ctx, mid).state));
    for (let i = 0; i < 3; i++) defective.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).not.toBe("RECONCILING");
  });

  it("A8. failure-handler itself throws (decide defect) → abortMission fallback, never silent replay", () => {
    const ctx = makeCtx("a8");
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed8",
      action: "RE_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "EX_A",
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    // Router throws PolicyError (normal infeasible path) BUT decide() also
    // throws — the failure handler cannot land a decision; the boundary must
    // still end the mission visibly instead of escaping to the supervisor.
    const defective = new MissionRuntime({
      service: ctx.service, gate: ctx.gate,
      router: { routeGovernedTask: () => { throw new PolicyError("FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR", "none"); } } as never,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon,
      recovery: { ...ctx.recovery, decide: () => { throw new IntegrityError("decide_corrupt"); } } as never,
      planner: (() => ({ tasks: [] })) as never,
    });
    defective.tick(mid, FAR);
    const ent = rt(ctx, mid);
    expect(String(ent.state)).toBe("ABORTED");
    expect(String(ent.reason)).toContain("recovery_boundary_defect");
  });

  it("A9. mission entity unavailable → failure handler fails → emergency runtime abort WITHOUT service path (audit finding)", () => {
    const ctx = makeCtx("a9");
    const mid = startMission(ctx);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const task = ctx.service.listTasks(mid)[0];
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_recovery = {
      recovery_id: "RCV_seed9",
      action: "RE_ROUTE",
      task_id: String(task.task_id),
      execution_id: null,
      governed_task_id: null,
      executor_id: "EX_A",
      failure_class: "TRANSIENT_TRANSPORT",
      backoff_ms: 0,
      infeasible_actions: [],
    };
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    // Mission entity corrupt: service.getMission throws persistently. The
    // apply arm fails (its mission fetch), the failure handler fails
    // (startRecovery reads mission metadata), and old abortMission would
    // throw AGAIN on the same getMission — escaping to the supervisor.
    // The emergency boundary must terminalize the runtime without it.
    const badService = new Proxy(ctx.service, {
      get(t, k) {
        if (k === "getMission") {
          return () => { throw new IntegrityError("mission_entity_corrupt"); };
        }
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const decisionsBefore = decisions(ctx, mid).length;
    const defective = new MissionRuntime({
      service: badService, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: (() => ({ tasks: [] })) as never,
    });
    defective.tick(mid, FAR); // must NOT escape merely because mission is missing
    const ent = rt(ctx, mid);
    expect(String(ent.state)).toBe("ABORTED");
    expect(String(ent.reason)).toContain("recovery_boundary_defect");
    // actionable recovery neutralized, forensic evidence preserved
    expect(ent.pending_recovery).toBeNull();
    const aborted = ent.aborted_recovery as Record<string, unknown>;
    expect(String(aborted.action)).toBe("RE_ROUTE");
    expect(String(aborted.task_id)).toBe(String(task.task_id));
    // subsequent ticks do not re-drive the recovery action
    const before = decisions(ctx, mid).length;
    for (let i = 0; i < 3; i++) defective.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(decisions(ctx, mid).length).toBe(before);
    // restart over the same store still sees terminal ABORTED
    const fresh = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: (() => ({ tasks: [] })) as never,
    });
    fresh.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(decisions(ctx, mid).length).toBeGreaterThanOrEqual(decisionsBefore);
  });
});

/* ------------------------------ Devin observe ------------------------------ */

function devinWith(
  statusEnum: string,
  lastMessage: string | null,
  opts: { nowStart?: number; taskTimeoutMs?: number } = {},
) {
  const dir = freshDir(`dv-${statusEnum}`);
  const fetchFn: DevinFetch = (m) => ({
    status: 200,
    data:
      m === "GET"
        ? {
            status_enum: statusEnum,
            url: "u-x",
            messages: [
              { type: "initial_user_message", message: "do the thing" },
              ...(lastMessage != null ? [{ type: "devin_message", message: lastMessage }] : []),
            ],
          }
        : { session_id: "s1", url: "u-x" },
  });
  let nowMs = opts.nowStart ?? 5_000_000;
  const adapter = new DevinExecutorAdapter({
    journalRoot: path.join(dir, "devin-j"),
    apiKey: "cog_test", apiVersion: "v1",
    fetchFn,
    blockedGraceMs: 60_000,
    taskTimeoutMs: opts.taskTimeoutMs ?? 300_000,
    nowMs: () => nowMs,
    now: () => new Date(nowMs).toISOString(),
  });
  const ws = fs.mkdtempSync(path.join(dir, "ws-"));
  const disp = adapter.dispatch({
    executor_id: "DEVIN",
    governance_state: "DISPATCH_AUTHORIZED",
    dispatch_enabled: true,
    task_id: "t",
    mission_id: "m",
    governed_task_id: "GT1",
    workspace: ws,
    correlation_id: "c",
    allowed_paths: [ws],
  });
  return { adapter, eid: String(disp.execution_id), advance: (ms: number) => (nowMs += ms) };
}

describe("LORC B — governed completion protocol", () => {
  it("B1. blocked + PAIR_EXECUTION_COMPLETE marker → COMPLETED", () => {
    const { adapter, eid } = devinWith("blocked", "report body\n\nPAIR_EXECUTION_COMPLETE");
    expect(adapter.observe(eid).status).toBe("COMPLETED");
    expect(adapter.collect_result(eid).status).toBe("COMPLETED");
  });

  it("B2. legacy 'DONE.'-prose + marker → COMPLETED (prose alone is not evidence)", () => {
    const { adapter, eid } = devinWith(
      "blocked",
      "DONE. I took a screenshot and uploaded it.\nPAIR_EXECUTION_COMPLETE",
    );
    expect(adapter.observe(eid).status).toBe("COMPLETED");
  });

  it("B3. suspended-after-deliverable + marker → COMPLETED (enum cannot downgrade verified completion)", () => {
    const { adapter, eid } = devinWith("suspended", "final report\nPAIR_EXECUTION_COMPLETE");
    expect(adapter.observe(eid).status).toBe("COMPLETED");
  });

  it("B4. blocked with NO completion evidence → grace → FAILED (REMOTE_INPUT_REQUIRED class preserved)", () => {
    const { adapter, eid, advance } = devinWith("blocked", "still thinking, need input");
    expect(adapter.observe(eid).status).toBe("RUNNING");
    advance(61_000);
    expect(adapter.observe(eid).status).toBe("FAILED");
    const result = adapter.collect_result(eid);
    expect(result.status).toBe("FAILED");
    expect(String((result.error as Record<string, unknown>).class)).toBe("REMOTE_INPUT_REQUIRED");
  });

  it("B5. blocked + bare-DONE legacy sentinel → COMPLETED (fallback tier still works)", () => {
    const { adapter, eid } = devinWith("blocked", "report body\n\nDONE");
    expect(adapter.observe(eid).status).toBe("COMPLETED");
  });

  it("B6. casual 'done' prose is NOT completion evidence → grace → FAILED", () => {
    const { adapter, eid, advance } = devinWith("blocked", "ok i'm basically done now, anything else?");
    expect(adapter.observe(eid).status).toBe("RUNNING");
    advance(61_000);
    expect(adapter.observe(eid).status).toBe("FAILED");
  });

  it("B7. marker text inside prose (not own line) does NOT complete → grace → FAILED", () => {
    const { adapter, eid, advance } = devinWith("blocked", "worked on it: PAIR_EXECUTION_COMPLETE-ish things");
    expect(adapter.observe(eid).status).toBe("RUNNING");
    advance(61_000);
    expect(adapter.observe(eid).status).toBe("FAILED");
  });

  it("B8. remote FAILED enum (no marker) → FAILED", () => {
    const { adapter, eid } = devinWith("expired", "crashed");
    expect(adapter.observe(eid).status).toBe("FAILED");
  });

  it("B9. timeout boundary: remote fetch past the budget still proves completion (late marker wins over TIMEOUT)", () => {
    // Advance past the 10s budget BEFORE the first status poll: observe()
    // still fetches remote, sees the marker → COMPLETED, not TIMEOUT
    // (the live XSMN incident: done work flagged REMOTE_INPUT_REQUIRED).
    const { adapter, eid, advance } = devinWith(
      "blocked",
      "uploaded screenshot\nPAIR_EXECUTION_COMPLETE",
      { taskTimeoutMs: 10_000 },
    );
    advance(11_000);
    expect(adapter.observe(eid).status).toBe("COMPLETED");
  });

  it("B10. timeout with NO completion evidence → TIMEOUT (unchanged canonical outcome)", () => {
    const { adapter, eid, advance } = devinWith("working", "still working", {
      taskTimeoutMs: 10_000,
    });
    advance(11_000);
    expect(adapter.observe(eid).status).toBe("TIMEOUT");
  });

  it("B11. dispatch prompt carries the governed completion-marker instruction", () => {
    const dir = freshDir("dv-prompt");
    let prompt = "";
    const fetchFn: DevinFetch = (_m, _u, body) => {
      prompt = String((body as Record<string, unknown>).prompt ?? "");
      return { status: 200, data: { session_id: "s1" } };
    };
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(dir, "devin-j"),
      apiKey: "cog_test", apiVersion: "v1",
      fetchFn,
    });
    const ws = fs.mkdtempSync(path.join(dir, "ws-"));
    adapter.dispatch({
      executor_id: "DEVIN",
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      task_id: "t",
      mission_id: "m",
      governed_task_id: "GT1",
      workspace: ws,
      correlation_id: "c",
      allowed_paths: [ws],
    });
    expect(prompt).toContain("PAIR_EXECUTION_COMPLETE");
    expect(prompt).toContain("on its own line");
  });
});
