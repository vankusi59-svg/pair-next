/**
 * P18.4-A — Recovery Atomicity & Durable Handoff.
 *
 * Crash-injection tests over the real durable store. `faultInjector`
 * fires before EVERY canonical write (put/event/evidence); a throw
 * inside `immediate()` rolls the whole transaction back — exactly the
 * durable state a power-loss/SIGKILL leaves at that write boundary.
 * Every scenario then replays on the same store (a fresh
 * MissionRuntime+Supervisor stands in for process restart: all runtime
 * state is durable).
 *
 * Invariants pinned (docs/p18-4/P18_4_RECOVERY_ATOMICITY_AUDIT.md):
 *  - no lost recovery signal at any crash boundary;
 *  - deferred→pending handoff is all-or-nothing;
 *  - canonical settlement is all-or-nothing — a committed-but-unsettled
 *    result re-enters the sweep and settles exactly once;
 *  - a faulting arm is bounded (drain_attempts), never an infinite loop;
 *  - apply-path dispatch replay never duplicates external side effects
 *    (executor_dispatch_intent adoption);
 *  - resolved tasks can never mint new recovery chains.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p184-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: Array<{ execution_id: string; task: Record<string, unknown> }> = [];
  private states = new Map<string, { status: string; result?: Record<string, unknown> }>();
  observeCalls = new Map<string, number>();
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
      return { execution_id: eid, status: this.bornStatus, run_root: `/runs/${eid}`, workspace: task.workspace };
    }
    this.states.set(eid, { status: "RUNNING" });
    return { execution_id: eid, status: "RUNNING", run_root: `/runs/${eid}`, workspace: task.workspace };
  }
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
  projectId: string;
}

function makeCtx(
  name: string,
  opts: { adapterId?: string; taskCount?: number; taskConcurrency?: number; dir?: string; store?: PairEvidenceStore } = {},
): Ctx {
  const dir = opts.dir ?? freshDir(name);
  const store = opts.store ?? new PairEvidenceStore(path.join(dir, "pair.db"));
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
  if (!opts.store) {
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
  }
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
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: undefined, planner,
  });
  if (!opts.store) {
    service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
    const project = service.createProject({ name, root_location: dir });
    return { dir, store, service, runtime, supervisor, control, adapters, adapter, projectId: String(project.project_id) };
  }
  return { dir, store, service, runtime, supervisor, control, adapters, adapter, projectId: "" };
}

function startMission(ctx: Ctx, expectExecs = 1): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "atomicity",
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  const mid = String((m as Record<string, unknown>).mission_id);
  for (let i = 0; i < 30 && execs(ctx, mid).length < expectExecs; i++) ctx.runtime.tick(mid);
  return mid;
}

const rt = (ctx: Ctx, mid: string) =>
  ctx.store.list("mission_runtime").find((r) => r.mission_id === mid)!;
const execs = (ctx: Ctx, mid: string) =>
  ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
const deferredOf = (ctx: Ctx, mid: string) =>
  ((rt(ctx, mid).deferred_recovery as Array<Record<string, unknown>> | undefined) ?? []);

/** Set `pending_recovery` null + state RUNNING — models a pending arm
 *  that resolved; isolates the deferred→pending handoff boundary. */
function freePending(ctx: Ctx, mid: string) {
  const row = rt(ctx, mid);
  row.pending_recovery = null;
  row.state = "RUNNING";
  ctx.store.put("mission_runtime", String(row.mission_runtime_id), row, Number(row.version));
}

/** Inject a crash that throws on the Nth canonical write seen after
 *  arming. Returns the observed-write counter. */
function crashOnWrite(ctx: Ctx, n: number) {
  const c = { writes: 0 };
  ctx.store.faultInjector = () => {
    c.writes++;
    if (c.writes === n) throw new Error("INJECTED_CRASH");
  };
  return c;
}

describe("P18.4-A — recovery atomicity", () => {
  it("RA-1 every crash point inside the deferred→pending handoff leaves the signal durable", () => {
    const ctx = makeCtx("ra1", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(rt(ctx, mid).pending_recovery).toBeTruthy();
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(deferredOf(ctx, mid).some((d) => String(d.task_id) === String(e2!.task_id))).toBe(true);
    freePending(ctx, mid);

    // Crash at each of the first 10 canonical writes the handoff
    // performs (pop, decision, arm, transition, schedule, events…).
    // Under the transaction EVERY prefix must roll back identically:
    // entry still queued AND no pending armed — the signal can never
    // vanish between the two states.
    for (let crashAt = 1; crashAt <= 10; crashAt++) {
      // Between boundaries, restore the exact queued state — the drain
      // fault bound legitimately drops an entry after 5 arm failures,
      // which is RA-6's scenario, not this one's.
      const seedRow = rt(ctx, mid);
      const q = (seedRow.deferred_recovery as Array<Record<string, unknown>> | undefined) ?? [];
      const qi = q.findIndex((d) => String(d.task_id) === String(e2!.task_id));
      const seedEntry = {
        task_id: String(e2!.task_id),
        execution_id: String(e2!.execution_id),
        failure_class: "UNKNOWN",
        extra: null,
        queued_at: utcnow(),
      };
      if (qi >= 0) {
        q[qi] = { ...q[qi]!, drain_attempts: 0 };
      } else {
        q.push(seedEntry);
      }
      seedRow.deferred_recovery = q;
      ctx.store.put("mission_runtime", String(seedRow.mission_runtime_id), seedRow, Number(seedRow.version));
      const counterRef = crashOnWrite(ctx, crashAt);
      try {
        ctx.runtime.tick(mid);
      } catch (err) {
        expect(String((err as Error).message)).toBe("INJECTED_CRASH");
      }
      ctx.store.faultInjector = undefined;
      const row = rt(ctx, mid);
      const hasEntry = deferredOf(ctx, mid).some((d) => String(d.task_id) === String(e2!.task_id));
      const armed = String((row.pending_recovery as Record<string, unknown> | null)?.task_id ?? "");
      if (armed === String(e2!.task_id)) {
        // The handoff committed before the injected write fired — the
        // ONLY other legal outcome: entry gone AND pending armed.
        expect(hasEntry).toBe(false);
        break;
      }
      expect(hasEntry).toBe(true);
      expect(armed).toBe("");
      // Retry the next deeper write boundary — a rolled-back entry is
      // re-drained on the next tick.
    }
    // With no injector the handoff commits: entry consumed + armed.
    ctx.runtime.tick(mid);
    const after = rt(ctx, mid);
    expect(String((after.pending_recovery as Record<string, unknown> | null)?.task_id ?? ""))
      .toBe(String(e2!.task_id));
    expect(deferredOf(ctx, mid).some((d) => String(d.task_id) === String(e2!.task_id))).toBe(false);
  });

  it("RA-2 crash inside settle txn: committed result re-settles exactly once (COMPLETED)", () => {
    const ctx = makeCtx("ra2");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e1.execution_id), "COMPLETED");
    // Crash on the task write inside the settle transaction — the
    // injected throw is deliberately swallowed by the sweep's fault
    // accounting (that IS its job); the durable rollback state below is
    // the assertion target.
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "task") throw new Error("INJECTED_CRASH");
    };
    ctx.runtime.tick(mid);
    ctx.store.faultInjector = undefined;
    const midRow = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(midRow.result).toBeTruthy();            // committed — survives
    expect(midRow.settle_complete).toBeFalsy();     // disposition rolled back
    expect(String(ctx.store.get("task", String(e1.task_id)).status)).not.toBe("COMPLETED");
    expect(ctx.store.listEvents("task", String(e1.task_id)).filter(
      (ev) => String(ev.event_type) === "TASK_COMPLETED",
    ).length).toBe(0);                              // no partial event either
    // Replay: the committed-but-unsettled row re-enters the sweep.
    ctx.runtime.tick(mid);
    const after = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(after.settle_complete).toBe(true);
    expect(after.settled_at).toBeTruthy();
    expect(String(ctx.store.get("task", String(e1.task_id)).status)).toBe("COMPLETED");
    // Exactly-once: a single TASK_COMPLETED event across the replay.
    expect(ctx.store.listEvents("task", String(e1.task_id)).filter(
      (ev) => String(ev.event_type) === "TASK_COMPLETED",
    ).length).toBe(1);
  });

  it("RA-3 crash inside settle txn: FAILED result re-settles into exactly one recovery arm", () => {
    const ctx = makeCtx("ra3");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e1.execution_id), "FAILED");
    // Crash on the pending_recovery arm write inside the settle txn.
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "mission_runtime") throw new Error("INJECTED_CRASH");
    };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    ctx.store.faultInjector = undefined;
    const midRow = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(midRow.result).toBeTruthy();
    expect(midRow.settle_complete).toBeFalsy();
    expect(rt(ctx, mid).pending_recovery).toBeFalsy(); // arm rolled back
    // Replay → one arm, one persisted decision for this signal.
    ctx.runtime.tick(mid);
    const armed = rt(ctx, mid).pending_recovery as Record<string, unknown>;
    expect(String(armed.task_id)).toBe(String(e1.task_id));
    const decisions = ctx.store.list("recovery_decision").filter(
      (d) => String(d.task_id) === String(e1.task_id),
    );
    expect(decisions.length).toBe(1);
    expect(String(ctx.store.get("task", String(e1.task_id)).status)).toBe("FAILED");
    expect(ctx.store.get("executor_execution", String(e1.execution_id)).settle_complete).toBe(true);
  });

  it("RA-4 restart replay: a fresh runtime/supervisor over the same store recovers a crashed handoff", () => {
    const ctx = makeCtx("ra4", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    freePending(ctx, mid);
    // Crash the handoff, then discard the whole in-process runtime —
    // "restart" constructs new instances over the same store.
    ctx.store.faultInjector = () => { throw new Error("INJECTED_CRASH"); };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    ctx.store.faultInjector = undefined; // disarm before the restart
    const fresh = makeCtx("ra4-restart", { dir: ctx.dir, store: ctx.store, taskConcurrency: 3 });
    fresh.adapters.set(String(ctx.adapter.executor_id), ctx.adapter);
    fresh.supervisor.resume();
    for (let i = 0; i < 20; i++) {
      fresh.runtime.tick(mid);
      const armed = String((rt(fresh, mid).pending_recovery as Record<string, unknown> | null)?.task_id ?? "");
      if (armed === String(e2!.task_id)) break;
    }
    expect(String((rt(fresh, mid).pending_recovery as Record<string, unknown> | null)?.task_id ?? ""))
      .toBe(String(e2!.task_id));
    // Exactly one arm for e2's signal — no duplicate chain.
    const decisions = fresh.store.list("recovery_decision").filter(
      (d) => String(d.task_id) === String(e2!.task_id),
    );
    expect(decisions.length).toBe(1);
  });

  it("RA-5 concurrent siblings: a crashed drain preserves every queued signal", () => {
    const ctx = makeCtx("ra5", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2, e3] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.adapter.finish(String(e3!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(deferredOf(ctx, mid).length).toBe(2);
    freePending(ctx, mid);
    ctx.store.faultInjector = () => { throw new Error("INJECTED_CRASH"); };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    ctx.store.faultInjector = undefined;
    // Both queued signals survived — rollback cannot consume one.
    expect(deferredOf(ctx, mid).length).toBe(2);
    // Drain converges one-per-tick; both arm in order.
    for (let i = 0; i < 6 && !(deferredOf(ctx, mid).length === 0 && rt(ctx, mid).pending_recovery); i++) {
      freePendingIfArmedForDrain(ctx, mid);
      ctx.runtime.tick(mid);
    }
    const armedIds = new Set(
      ctx.store.list("recovery_decision").map((d) => String(d.task_id)),
    );
    expect(armedIds.has(String(e2!.task_id))).toBe(true);
    expect(armedIds.has(String(e3!.task_id))).toBe(true);
  });

  it("RA-6 a persistently faulting arm is bounded and dropped with evidence, never an infinite loop", () => {
    const ctx = makeCtx("ra6", { taskCount: 3, taskConcurrency: 3 });
    const mid = startMission(ctx, 3);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(deferredOf(ctx, mid).length).toBe(1);
    freePending(ctx, mid);
    // e3 stays RUNNING — the mission can never terminalize, so every
    // tick reaches the drain and the fault bound accumulates.
    // Fault every arm attempt (the decision write inside startRecovery).
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "recovery_decision") throw new Error("INJECTED_CRASH");
    };
    for (let i = 0; i < 8; i++) {
      try {
        ctx.runtime.tick(mid);
      } catch { /* drain catches internally; tick-level throws tolerated */ }
      // freePending each round in case an arm half-landed elsewhere.
      if (!rt(ctx, mid).pending_recovery) {
        const q = deferredOf(ctx, mid);
        if (q.length === 0) break;
      } else {
        freePending(ctx, mid);
      }
    }
    ctx.store.faultInjector = undefined;
    expect(deferredOf(ctx, mid).length).toBe(0);
    const drops = ctx.store.listEvidence(mid).filter(
      (ev) => String(ev.kind) === "DEFERRED_RECOVERY_DROPPED",
    );
    expect(drops.length).toBeGreaterThanOrEqual(1);
    const drop = drops[drops.length - 1]!;
    const dropPayload = (drop.payload as Record<string, unknown>).payload as Record<string, unknown>;
    expect(String(dropPayload.task_id)).toBe(String(e2!.task_id));
    // No arm minted, no pending — the bound held.
    expect(rt(ctx, mid).pending_recovery).toBeFalsy();
  });

  it("RA-7 deferred entry for a resolved task is dropped with evidence, never armed", () => {
    const ctx = makeCtx("ra7");
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    expect(deferredOf(ctx, mid).length).toBe(1);
    // Operator cancels e2's task while it sits in the deferred queue.
    const task = ctx.store.get("task", String(e2!.task_id));
    task.status = "CANCELLED";
    ctx.store.put("task", String(task.task_id), task, Number(task.version));
    freePending(ctx, mid);
    ctx.runtime.tick(mid);
    expect(deferredOf(ctx, mid).length).toBe(0);
    expect(rt(ctx, mid).pending_recovery).toBeFalsy();
    const drops = ctx.store.listEvidence(mid).filter(
      (ev) => String(ev.kind) === "DEFERRED_RECOVERY_DROPPED" &&
        String(((ev.payload as Record<string, unknown>).payload as Record<string, unknown>).task_id) === String(e2!.task_id),
    );
    expect(drops.length).toBe(1);
  });

  it("RA-8 apply-path born-terminal crash: replay adopts the dispatch — zero duplicate side effects", () => {
    const ctx = makeCtx("ra8");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e1.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const armed = rt(ctx, mid).pending_recovery as Record<string, unknown>;
    expect(armed).toBeTruthy();
    // Drive the apply deterministically: born-terminal retry dispatch.
    ctx.adapter.bornStatus = "FAILED";
    const row = rt(ctx, mid);
    row.state = "RECOVERING";
    ctx.store.put("mission_runtime", String(row.mission_runtime_id), row, Number(row.version));
    const dispatchesBefore = ctx.adapter.dispatched.length;
    // Crash INSIDE the inline settle transaction (sameChainContinuation).
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "executor_execution") throw new Error("INJECTED_CRASH");
    };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    ctx.store.faultInjector = undefined;
    const dispatchCountAfterCrash = ctx.adapter.dispatched.length;
    expect(dispatchCountAfterCrash).toBeGreaterThanOrEqual(dispatchesBefore);
    // Replay the apply: routing must ADOPT the prior dispatch via the
    // executor_dispatch_intent — no second external dispatch.
    for (let i = 0; i < 8; i++) {
      try {
        ctx.runtime.tick(mid);
      } catch { /* keep driving through transient faults */ }
      const p = rt(ctx, mid).pending_recovery as Record<string, unknown> | null;
      if (p && String(p.recovery_id) !== String(armed.recovery_id)) break;
    }
    expect(ctx.adapter.dispatched.length).toBe(dispatchCountAfterCrash);
    // The chain continued: a successor decision/arm exists for e1.
    const decisions = ctx.store.list("recovery_decision").filter(
      (d) => String(d.task_id) === String(e1.task_id),
    );
    expect(decisions.length).toBeGreaterThanOrEqual(2);
  });

  it("RA-9 committed-result settlement needs no adapter (re-bind never required)", () => {
    const ctx = makeCtx("ra9");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e1.execution_id), "COMPLETED");
    // Commit the result but crash the disposition — then drop the adapter.
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "task") throw new Error("INJECTED_CRASH");
    };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    ctx.store.faultInjector = undefined;
    ctx.adapters.clear(); // executor unbound — adapter gone entirely
    ctx.runtime.tick(mid);
    const after = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(after.settle_complete).toBe(true);
    expect(String(ctx.store.get("task", String(e1.task_id)).status)).toBe("COMPLETED");
  });

  it("RA-10 bounded re-settle faults: persistent transient fault is capped + governed, not a silent spin", () => {
    const ctx = makeCtx("ra10");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e1.execution_id), "COMPLETED");
    // Commit the result, then fault every settle (non-deterministic).
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "task") {
        throw Object.assign(new Error("transient-io"), { transient: true });
      }
    };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected */ }
    expect(ctx.store.get("executor_execution", String(e1.execution_id)).result).toBeTruthy();
    // Faulting Error is non-deterministic → bounded re-settle attempts.
    for (let i = 0; i < 30; i++) {
      try {
        ctx.runtime.tick(mid);
      } catch { /* keep driving */ }
      const row = ctx.store.get("executor_execution", String(e1.execution_id));
      if (row.collect_excluded) break;
    }
    ctx.store.faultInjector = undefined;
    const row = ctx.store.get("executor_execution", String(e1.execution_id));
    expect(row.collect_excluded).toBeTruthy();
    // Governed recovery now owns the task — armed or deferred, never lost.
    const rtNow = rt(ctx, mid);
    const signaled =
      Boolean(rtNow.pending_recovery) || deferredOf(ctx, mid).length > 0;
    expect(signaled).toBe(true);
    expect(Number(row.settle_faults)).toBeGreaterThanOrEqual(24);
  });

  it("RA-11 crash inside the exclusion→signal boundary: exclusion and recovery commit atomically", () => {
    const ctx = makeCtx("ra11");
    const mid = startMission(ctx);
    const e1 = execs(ctx, mid)[0]!;
    // Reach COLLECT_FAULT_BOUND on the very next collect fault:
    // collection_attempts seeds just below the bound; a FAILED status
    // with no result makes collect_result throw (non-deterministic —
    // the bound, not determinism, drives the handoff).
    const seeded = ctx.store.get("executor_execution", String(e1.execution_id));
    seeded.collection_attempts = 23;
    ctx.store.put("executor_execution", String(e1.execution_id), seeded, Number(seeded.version));
    ctx.adapter.markStatus(String(e1.execution_id), "FAILED");
    // Crash on the recovery_decision write INSIDE the exclusion txn —
    // the exclusion put + evidence + every arm write must roll back.
    ctx.store.faultInjector = (op) => {
      if (op.kind === "put" && op.entityType === "recovery_decision") {
        throw new Error("INJECTED_CRASH");
      }
    };
    try {
      ctx.runtime.tick(mid);
    } catch { /* injected faults may surface */ }
    ctx.store.faultInjector = undefined;
    const row = ctx.store.get("executor_execution", String(e1.execution_id));
    const rtNow = rt(ctx, mid);
    const excluded = row.collect_excluded != null;
    const signaled =
      rtNow.pending_recovery != null ||
      deferredOf(ctx, mid).some((d) => String(d.task_id) === String(e1.task_id)) ||
      ctx.store
        .list("recovery_decision")
        .some((d) => String(d.execution_id ?? "") === String(e1.execution_id));
    // Atomic boundary: neither side may exist without the other.
    expect(excluded).toBe(false);
    expect(signaled).toBe(false);
    // Next tick retries the whole boundary — now both commit together.
    ctx.runtime.tick(mid);
    const row2 = ctx.store.get("executor_execution", String(e1.execution_id));
    const rt2 = rt(ctx, mid);
    expect(row2.collect_excluded).toBeTruthy();
    const signaled2 =
      rt2.pending_recovery != null ||
      deferredOf(ctx, mid).some((d) => String(d.task_id) === String(e1.task_id)) ||
      ctx.store
        .list("recovery_decision")
        .some((d) => String(d.execution_id ?? "") === String(e1.execution_id));
    expect(signaled2).toBe(true);
  });

  it("RA-12 upgrade backfill: pre-settle_complete rows stamp the marker, never re-settle", () => {
    const ctx = makeCtx("ra12");
    const mid = startMission(ctx, 2);
    const [e1, e2] = execs(ctx, mid);
    // PASS witness: a committed result carrying settled_at but no
    // settle_complete (a row written by a pre-upgrade binary).
    ctx.adapter.finish(String(e1!.execution_id), "COMPLETED");
    ctx.runtime.tick(mid);
    const settled = ctx.store.get("executor_execution", String(e1!.execution_id));
    expect(settled.result).toBeTruthy();
    expect(settled.settle_complete).toBe(true);
    const completedEvents = () =>
      ctx.store.list("event").filter(
        (ev) =>
          ev.event_type === "TASK_COMPLETED" &&
          String((ev as Record<string, unknown>).entity_id ?? "") === String(e1!.task_id),
      ).length;
    const eventsBefore = completedEvents();
    // Simulate the upgrade edge: strip settle_complete (as if the row
    // was committed by the old binary), keep result.settled_at.
    const legacy = ctx.store.get("executor_execution", String(e1!.execution_id));
    delete legacy.settle_complete;
    ctx.store.put("executor_execution", String(e1!.execution_id), legacy, Number(legacy.version));
    ctx.runtime.tick(mid);
    const backfilled = ctx.store.get("executor_execution", String(e1!.execution_id));
    // Marker stamped — NO re-settle: no duplicate TASK_COMPLETED event,
    // no second validation pass, no recovery chain.
    expect(backfilled.settle_complete).toBe(true);
    expect(completedEvents()).toBe(eventsBefore);
    expect(
      ctx.store
        .list("recovery_decision")
        .some((d) => String(d.execution_id ?? "") === String(e1!.execution_id)),
    ).toBe(false);
    // REJECT witness: a committed FAILED result with no settled_at and
    // no settle_complete, but a decision already minted for (task, exec)
    // — the pre-upgrade chain owns it; stamping must not mint another.
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const decCount = () =>
      ctx.store
        .list("recovery_decision")
        .filter((d) => String(d.execution_id ?? "") === String(e2!.execution_id)).length;
    expect(decCount()).toBe(1);
    const rejected = ctx.store.get("executor_execution", String(e2!.execution_id));
    if (rejected.settle_complete === true) {
      delete rejected.settle_complete;
      ctx.store.put("executor_execution", String(e2!.execution_id), rejected, Number(rejected.version));
      ctx.runtime.tick(mid);
      const re2 = ctx.store.get("executor_execution", String(e2!.execution_id));
      expect(re2.settle_complete).toBe(true);
      expect(decCount()).toBe(1);
    }
  });
});

/** Test helper: clear a pending arm so the drain can fire next tick. */
function freePendingIfArmedForDrain(ctx: Ctx, mid: string) {
  const row = rt(ctx, mid);
  if (!row.pending_recovery) return;
  row.pending_recovery = null;
  row.state = "RUNNING";
  ctx.store.put("mission_runtime", String(row.mission_runtime_id), row, Number(row.version));
}
