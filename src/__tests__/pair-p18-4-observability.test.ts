/**
 * P18.4-B — canonical observability projections.
 *
 * Pins the executionHealth / recoveryOps / operationsOverview contract:
 * every field is classified persisted/observed/derived/unknown, no
 * timestamps or states are synthesized, and mission scoping never
 * leaks another mission's rows.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p184-obs-"));
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
    this.states.set(eid, { status: "RUNNING" });
    return { execution_id: eid, status: "RUNNING", run_root: `/runs/${eid}`, workspace: task.workspace };
  }
  finish(eid: string, status = "COMPLETED") {
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
        summary: status.toLowerCase(),
        artifacts: [],
        error: status === "COMPLETED" ? null : { class: "EXEC_FAILED", message: status },
        completed_at: utcnow(),
      },
    });
  }
  observe(executionId: string) {
    const s = this.states.get(executionId);
    return { status: s?.status ?? "UNKNOWN" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const s = this.states.get(executionId);
    if (!s?.result) throw new Error("FAIL_CLOSED_EXECUTION_NOT_TERMINAL");
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
  store: PairEvidenceStore;
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  observability: MissionObservability;
  adapter: ScriptedAdapter;
  projectId: string;
  dir: string;
}

function makeCtx(name: string, taskCount = 2): Ctx {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const adapter = new ScriptedAdapter("EX_A");
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 4 });
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
  service.routes.registerRoute({
    route_id: `RTE_${adapter.executor_id}`,
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
    route_id: `RTE_${adapter.executor_id}`,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  adapters.set(adapter.executor_id, adapter);
  const planner = () => ({
    tasks: Array.from({ length: taskCount }, (_, i) => ({
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
  return { dir, store, service, runtime, supervisor, control, observability, adapter, projectId: String(project.project_id) };
}

function startMission(ctx: Ctx): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "obs",
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  const mid = String((m as Record<string, unknown>).mission_id);
  for (let i = 0; i < 30; i++) {
    ctx.runtime.tick(mid);
    if (ctx.store.list("executor_execution").filter((e) => e.mission_id === mid).length >= 1) break;
  }
  return mid;
}

const execs = (ctx: Ctx, mid: string) =>
  ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);

describe("P18.4-B — execution health projection", () => {
  it("OBS-1: settled execution reports persisted stamps, derived stage SETTLED, real latencies", () => {
    const ctx = makeCtx("obs1", 1);
    const mid = startMission(ctx);
    const e = execs(ctx, mid)[0]!;
    ctx.adapter.finish(String(e.execution_id), "COMPLETED");
    for (let i = 0; i < 10; i++) ctx.runtime.tick(mid);
    const h = ctx.observability.executionHealth(mid);
    const row = h.executions.find((r) => r.execution_id === e.execution_id)!;
    const persisted = row.persisted as Record<string, unknown>;
    const observed = row.observed as Record<string, unknown>;
    const derived = row.derived as Record<string, unknown>;
    expect(persisted.execution_state).toBe("COMPLETED");
    expect(persisted.result_committed).toBe(true);
    expect(persisted.settle_complete).toBe(true);
    expect(persisted.settled_at).toBeTruthy();
    expect(persisted.collection_started_at).toBeTruthy();
    expect(Number(persisted.collection_attempts)).toBeGreaterThanOrEqual(1);
    expect(persisted.dispatch_timestamp).toBeTruthy();
    expect(observed.first_terminal_observed_at).toBeTruthy();
    expect(observed.last_observed_at).toBeTruthy();
    expect(derived.stage).toBe("SETTLED");
    const lat = derived.latency_ms as Record<string, unknown>;
    expect(typeof lat.terminal_observed_to_settled).toBe("number");
    expect(row.executor_id).toBe("EX_A");
    expect(row.task_id).toBe(e.task_id);
  });

  it("OBS-2: never-observed execution — DISPATCHED, NEVER_OBSERVED, honest unknowns (no fabricated timestamps)", () => {
    const ctx = makeCtx("obs2", 2);
    const mid = startMission(ctx);
    const e = execs(ctx, mid)[0]!;
    const h = ctx.observability.executionHealth(mid);
    const row = h.executions.find((r) => r.execution_id === e.execution_id)!;
    const derived = row.derived as Record<string, unknown>;
    const observed = row.observed as Record<string, unknown>;
    expect(derived.stage).toBe("DISPATCHED");
    expect(derived.abnormal).toContain("NEVER_OBSERVED");
    expect(row.unknowns).toContain("no_observation_yet");
    // Nothing synthesized — absent facts stay null.
    expect(observed.last_observed_at).toBeNull();
    expect(observed.first_terminal_observed_at).toBeNull();
    expect(observed.finished_at).toBeNull();
    const persisted = row.persisted as Record<string, unknown>;
    expect(persisted.settled_at).toBeNull();
    expect(persisted.collection_committed_at).toBeNull();
  });

  it("OBS-3: committed-but-unsettled crash orphan — RESULT_COMMITTED + COMMITTED_UNSETTLED flag", () => {
    const ctx = makeCtx("obs3", 2);
    const mid = startMission(ctx);
    const e = execs(ctx, mid)[0]!;
    // Simulate the P18.4 crash orphan: result committed, no settlement.
    const row = ctx.store.get("executor_execution", String(e.execution_id));
    ctx.store.put("executor_execution", String(e.execution_id), {
      ...row,
      execution_state: "COMPLETED",
      result: { execution_id: e.execution_id, status: "COMPLETED", completed_at: utcnow() },
      collection_committed_at: utcnow(),
      first_terminal_observed_at: utcnow(),
    });
    const h = ctx.observability.executionHealth(mid);
    const out = h.executions.find((r) => r.execution_id === e.execution_id)!;
    expect((out.derived as Record<string, unknown>).stage).toBe("RESULT_COMMITTED");
    expect((out.derived as Record<string, unknown>).abnormal).toContain("COMMITTED_UNSETTLED");
    expect(out.unknowns).toContain("settlement_pending");
  });

  it("OBS-4: UNKNOWN outcome and neutralized rows are classified distinctly", () => {
    const ctx = makeCtx("obs4", 3);
    const mid = startMission(ctx);
    const es = execs(ctx, mid);
    const eU = es[0]!;
    ctx.store.put("executor_execution", String(eU.execution_id), {
      ...ctx.store.get("executor_execution", String(eU.execution_id)),
      execution_state: "UNKNOWN",
    });
    const eN = es[1]!;
    ctx.store.put("executor_execution", String(eN.execution_id), {
      ...ctx.store.get("executor_execution", String(eN.execution_id)),
      execution_state: "COMPLETED",
      terminal_outcome: { kind: "NEUTRALIZED", at: utcnow() },
    });
    const h = ctx.observability.executionHealth(mid);
    const rowU = h.executions.find((r) => r.execution_id === eU.execution_id)!;
    const rowN = h.executions.find((r) => r.execution_id === eN.execution_id)!;
    expect((rowU.derived as Record<string, unknown>).abnormal).toContain("UNKNOWN_OUTCOME");
    expect((rowN.derived as Record<string, unknown>).stage).toBe("NEUTRALIZED");
  });

  it("OBS-5: mission scoping — health projection never leaks a sibling mission's executions", () => {
    const ctx = makeCtx("obs5", 1);
    const midA = startMission(ctx);
    const midB = startMission(ctx);
    const hA = ctx.observability.executionHealth(midA);
    const hB = ctx.observability.executionHealth(midB);
    expect(hA.executions.length).toBeGreaterThanOrEqual(1);
    expect(hB.executions.length).toBeGreaterThanOrEqual(1);
    const idsA = new Set(hA.executions.map((r) => r.execution_id));
    for (const r of hB.executions) expect(idsA.has(r.execution_id)).toBe(false);
    // Every row traces to its own mission's canonical executions.
    const canonA = new Set(execs(ctx, midA).map((e) => String(e.execution_id)));
    for (const r of hA.executions) expect(canonA.has(String(r.execution_id))).toBe(true);
    // recoveryOps follows the same scope.
    const opsA = ctx.observability.recoveryOps(midA) as Record<string, unknown>;
    expect(opsA.mission_id).toBe(midA);
    expect((opsA.decisions as Array<Record<string, unknown>>).every((d) => d.mission_id === midA)).toBe(true);
  });
});

describe("P18.4-B — recovery operations projection", () => {
  it("OPS-1: pending recovery, deferred queue and approvals surface canonically", () => {
    const ctx = makeCtx("ops1", 3);
    const mid = startMission(ctx);
    const [e1, e2] = execs(ctx, mid);
    ctx.adapter.finish(String(e1!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const r1 = ctx.store.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;
    expect(r1.pending_recovery).toBeTruthy();
    // Second failure while pending → deduped deferred entry.
    ctx.adapter.finish(String(e2!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const ops = ctx.observability.recoveryOps(mid) as Record<string, unknown>;
    expect(ops.mission_id).toBe(mid);
    expect(ops.pending_recovery).toBeTruthy();
    const deferred = ops.deferred_recovery as Array<Record<string, unknown>>;
    const rtRow = ctx.store.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;
    expect(deferred.length).toBe((rtRow.deferred_recovery as unknown[]).length);
    const allowed = ops.allowed_actions as Record<string, unknown>;
    expect(allowed.decide_approval).toBe(true);
    expect(allowed.lifecycle).toBe(true);
    // decisions + attempts are canonical rows for THIS mission.
    const decisions = ops.decisions as Array<Record<string, unknown>>;
    expect(decisions.every((d) => d.mission_id === mid)).toBe(true);
  });

  it("OPS-2: clean mission reports empty recovery surface and truthful runtime_state", () => {
    const ctx = makeCtx("ops2", 1);
    const mid = startMission(ctx);
    const ops = ctx.observability.recoveryOps(mid) as Record<string, unknown>;
    expect(ops.runtime_state).toBeTruthy();
    expect(ops.pending_recovery).toBeNull();
    expect(ops.deferred_recovery).toEqual([]);
    expect(ops.approvals_pending).toEqual([]);
    expect(ops.decisions).toEqual([]);
  });
});

describe("P18.4-B — operations overview rollup", () => {
  it("OVW-1: aggregate counts match seeded canonical state", () => {
    const ctx = makeCtx("ovw1", 3);
    const mid = startMission(ctx);
    const es = execs(ctx, mid);
    const before = ctx.observability.operationsOverview() as Record<string, unknown>;
    expect(Number(before.missions_running)).toBeGreaterThanOrEqual(0);
    ctx.adapter.finish(String(es[0]!.execution_id), "FAILED");
    ctx.adapter.finish(String(es[1]!.execution_id), "FAILED");
    ctx.runtime.tick(mid);
    const after = ctx.observability.operationsOverview() as Record<string, unknown>;
    expect(Number(after.recoveries_active)).toBeGreaterThanOrEqual(1);
    expect(after).toHaveProperty("liveness_detect_ms_p50");
    expect(after).toHaveProperty("executions_awaiting_collection");
    expect(after).toHaveProperty("recovery_blocked_or_escalated");
  });

  it("OVW-2: committed-unsettled rows are counted honestly", () => {
    const ctx = makeCtx("ovw2", 1);
    const mid = startMission(ctx);
    const e = execs(ctx, mid)[0]!;
    ctx.store.put("executor_execution", String(e.execution_id), {
      ...ctx.store.get("executor_execution", String(e.execution_id)),
      result: { execution_id: e.execution_id, status: "COMPLETED", completed_at: utcnow() },
    });
    const ov = ctx.observability.operationsOverview() as Record<string, unknown>;
    expect(Number(ov.executions_committed_unsettled)).toBe(1);
  });
});
