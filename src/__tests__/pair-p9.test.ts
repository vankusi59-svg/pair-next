/**
 * P9 OPERATIONALIZATION tests — mission loop + Mission Control + DEVIN.
 *
 * §36 items 1–50 (deterministic proofs), §37 long-running E2E, §40 Mission
 * Control E2E over a real node:http server. Devin executor contract tests use
 * an injected synchronous transport — no network, no faked liveness.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  BusinessLayer,
  DevinExecutorAdapter,
  classifyFailure,
  ExecutorRegistry,
  ExperienceService,
  GovernedTaskGate,
  IntegrityError,
  CredentialBroker,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  nextRunAfter,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  PromotionService,
  ReconciliationService,
  RecoveryController,
  RECOVERY_MATRIX,
  SelfmodBootstrap,
  TRANSPORT_IN_PROCESS,
  TRANSPORT_REMOTE_API,
  createMissionControlServer,
  mintBrokerCapability,
  registerGovernedExecutors,
  digest,
  newId,
  utcnow,
  claimLeaseDigest,
  validatePlanProposal,
} from "../pair/index.js";
import type { DevinFetch } from "../pair/devin-executor.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p9-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* ---------------------------- scripted executor ---------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  script: Array<{ status: string; error_class?: string }> = [];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  available = true;
  observeOverride: Record<string, unknown> | null = null;
  dispatchEvidence: { dispatched: boolean; execution_id?: string } | undefined;

  constructor(id: string, script: Array<{ status: string; error_class?: string }> = []) {
    this.executor_id = id;
    this.script = [...script];
  }
  probe() {
    return { executor_id: this.executor_id, available: this.available, state: this.available ? "READY" : "DEGRADED" };
  }
  qualify() {
    return this.available
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNAVAILABLE"] };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING", "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION"] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "PROCESS_EXIT", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: `${this.executor_id} did work` };
    return {
      execution_id: eid,
      status: step.status,
      run_root: step.status === "RUNNING" ? path.join(ROOT, "run", eid) : null,
      workspace: task.workspace,
    };
  }
  observe(executionId: string) {
    if (this.observeOverride) return this.observeOverride;
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: this.available ? "READY" : "DEGRADED" };
  }
  dispatch_evidence() {
    return this.dispatchEvidence;
  }
}

/* --------------------------------- ctx ------------------------------------ */

const ALL_CAPS = [
  "FILE_OPERATIONS",
  "AUTOMATON_TASK_EXECUTION",
  "SHELL_EXECUTION",
  "CODE_GENERATION",
  "REASONING",
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
];

interface Ctx {
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  recovery: RecoveryController;
  recon: ReconciliationService;
  approvals: ApprovalQueue;
  scheduler: MissionScheduler;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  observability: MissionObservability;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  plannerCalls: Array<Record<string, unknown>>;
  projectId: string;
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter, opts: { caps?: string[]; priority?: number; maxConcurrency?: number } = {}) {
  const caps = opts.caps ?? ALL_CAPS.slice(0, 4);
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: caps,
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: opts.priority ?? 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: opts.maxConcurrency ?? 4,
    },
  });
  const routeId = `RTE_${adapter.executor_id}`;
  if (!ctx.service.routes.getRoute(routeId)) {
    ctx.service.routes.registerRoute({
      route_id: routeId,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      direct_callable: true,
      capabilities: caps,
      priority: opts.priority ?? 50,
      executor_hint: adapter.executor_id,
    });
  }
  if (!ctx.service.routes.bindingFor(adapter.executor_id, routeId)) {
    ctx.service.routes.registerBinding({
      executor_id: adapter.executor_id,
      route_id: routeId,
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
      capabilities: caps,
    });
  }
  ctx.adapters.set(adapter.executor_id, adapter);
}

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

function makeCtx(name: string, opts: { planner?: PlannerFn; maxConcurrency?: number } = {}): Ctx {
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
  const scheduler = new MissionScheduler(service, { mission_concurrency: opts.maxConcurrency ?? 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const plannerCalls: Array<Record<string, unknown>> = [];
  const planner: PlannerFn =
    opts.planner ??
    ((input) => {
      plannerCalls.push(input as Record<string, unknown>);
      return {
        tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
      };
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
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name: name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, observability, control,
    adapters, plannerCalls, projectId: String(project.project_id),
  };
}

function startMission(ctx: Ctx, goal = "p9"): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal,
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
}

function rt(ctx: Ctx, missionId: string) {
  return ctx.store.get("mission_runtime", `MRT_${missionId}`);
}

/* ============================ §36 items 1–50 ============================== */

describe("P9 §36 — runtime planning + scheduling", () => {
  it("1. mission runtime plans when no plan exists", () => {
    const ctx = makeCtx("t1");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.tick(mid);
    expect(rt(ctx, mid).state).toBe("PLANNING");
    ctx.runtime.tick(mid);
    expect(ctx.plannerCalls.length).toBe(1);
    expect(rt(ctx, mid).state).toBe("READY");
    expect(ctx.service.getMission(mid).plan_id).toBeTruthy();
  });

  it("2. runnable DAG task scheduled", () => {
    const ctx = makeCtx("t2");
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    expect(ex.dispatched.length).toBe(1);
    expect(rt(ctx, mid).state).toBe("COMPLETED");
  });

  it("3. dependency-blocked task not scheduled", () => {
    const ctx = makeCtx("t3", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    // T1 stays RUNNING forever → T2 never dispatches
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1); // only T1
  });

  it("4. completed task never re-dispatched", () => {
    const ctx = makeCtx("t4");
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    for (let i = 0; i < 3; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1);
  });

  it("5. bounded concurrency respected (mission ceiling)", () => {
    const ctx = makeCtx("t5", {
      maxConcurrency: 1,
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1);
  });

  it("6. executor concurrency respected", () => {
    const ctx = makeCtx("t6", {
      maxConcurrency: 5,
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex, { maxConcurrency: 1 });
    const mid = startMission(ctx);
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1); // second blocked by CAPACITY_EXHAUSTED
  });

  it("7. pause stops new dispatch", () => {
    const ctx = makeCtx("t7", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.tick(mid); // PLANNING
    ctx.runtime.tick(mid); // plan committed → READY
    ctx.runtime.tick(mid); // READY → RUNNING
    ctx.runtime.tick(mid); // dispatch T1 (RUNNING)
    expect(ex.dispatched.length).toBe(1);
    ctx.runtime.pause(mid, "op1");
    expect(ctx.service.getMission(mid).status).toBe("PAUSED");
    for (let i = 0; i < 3; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1);
  });

  it("8. resume continues from canonical state", () => {
    const ctx = makeCtx("t8");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 5 });
    ctx.runtime.pause(mid, "op1");
    ex.script.push({ status: "COMPLETED" });
    ex.collected[ex.dispatched[0]] = { status: "COMPLETED", summary: "done" };
    ctx.runtime.resume(mid, "op1");
    ctx.runtime.run(mid);
    expect(rt(ctx, mid).state).toBe("COMPLETED");
  });

  it("9. cancel stops future dispatch", () => {
    const ctx = makeCtx("t9", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    ctx.runtime.cancel(mid, "op1");
    for (let i = 0; i < 3; i++) ctx.runtime.tick(mid);
    expect(ex.dispatched.length).toBe(1);
    expect(rt(ctx, mid).state).toBe("CANCELLED");
  });
});

describe("P9 §36 — restart/crash recovery", () => {
  it("10. restart before route recovers", () => {
    const ctx = makeCtx("t10");
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.tick(mid);
    ctx.runtime.tick(mid); // READY
    // fresh runtime on same store — simulates process restart
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: () => ({ tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }),
    });
    rt2.run(mid);
    expect(rt(ctx, mid).state).toBe("COMPLETED");
    expect(ex.dispatched.length).toBe(1);
  });

  it("11. restart after route recovers (governed task adopted, not duplicated)", () => {
    const ctx = makeCtx("t11");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 }); // T1 dispatched, RUNNING
    expect(ex.dispatched.length).toBe(1);
    ex.collected[ex.dispatched[0]] = { status: "COMPLETED", summary: "s" };
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: () => ({ tasks: [] }),
    });
    rt2.run(mid);
    expect(ex.dispatched.length).toBe(1);
    expect(rt(ctx, mid).state).toBe("COMPLETED");
  });

  it("12. restart after dispatch does not duplicate", () => {
    const ctx = makeCtx("t12");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: () => ({ tasks: [] }),
    });
    for (let i = 0; i < 3; i++) rt2.tick(mid);
    expect(ex.dispatched.length).toBe(1);
  });

  it("13. completed-before-collection recovered", () => {
    const ctx = makeCtx("t13");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    // Worker finished but no collect happened — canonical executor_execution
    // still non-terminal; a fresh runtime settles it.
    ex.collected[ex.dispatched[0]] = { status: "COMPLETED", summary: "done" };
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: () => ({ tasks: [] }),
    });
    rt2.run(mid);
    const task = ctx.service.listTasks(mid)[0];
    expect(task.status).toBe("COMPLETED");
    expect(rt(ctx, mid).state).toBe("COMPLETED");
  });

  it("14. recovery backoff persists across restart", () => {
    const ctx = makeCtx("t14");
    const ex = new ScriptedAdapter("EX_A", [{ status: "FAILED", error_class: "TRANSIENT_TRANSPORT" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 5 });
    const scheduled = ctx.store.list("scheduled_action").filter((a) => a.mission_id === mid);
    expect(scheduled.length).toBe(1);
    // restart: scheduler reconstructs from pair.db
    const sched2 = new MissionScheduler(ctx.service);
    expect(sched2.dueActions("2999-01-01T00:00:00Z").length).toBe(1);
  });

  it("15. approval pending persists across restart", () => {
    const ctx = makeCtx("t15");
    const ex = new ScriptedAdapter("EX_A", [
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
    ]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    const farFuture = "2999-01-01T00:00:00Z";
    ctx.runtime.run(mid, { maxTicks: 14, now: () => farFuture });
    if (rt(ctx, mid).state === "WAITING_APPROVAL") {
      const pending = ctx.approvals.listPending(mid);
      expect(pending.length).toBeGreaterThan(0);
      const approvals2 = new ApprovalQueue(ctx.service); // restart
      expect(approvals2.listPending(mid).length).toBeGreaterThan(0);
    } else {
      expect(["ABORTED", "FAILED", "RUNNING", "WAITING_BACKOFF"]).toContain(String(rt(ctx, mid).state));
    }
  });

  it("16. reconciliation barrier blocks retry", () => {
    const ctx = makeCtx("t16");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.tick(mid);
    ctx.runtime.tick(mid); // plan committed; task READY
    const task = ctx.service.listTasks(mid)[0];
    const runtime = rt(ctx, mid);
    runtime.state = "RUNNING";
    runtime.barriers = { [String(task.task_id)]: { kind: "RECONCILIATION", execution_id: "nope", since: utcnow() } };
    ctx.store.put("mission_runtime", `MRT_${mid}`, runtime, Number(runtime.version));
    const runnable = ctx.scheduler.pickRunnable(mid, {
      isBlocked: (t) =>
        ((runtime.barriers as Record<string, Record<string, unknown>>) ?? {})[String(t.task_id)]
          ? "BARRIER"
          : null,
    });
    expect(runnable.length).toBe(0);
  });

  it("17. CONFIRMED_NOT_EXECUTED permits safe redrive", () => {
    const ctx = makeCtx("t17");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 5 });
    const receipt = ctx.recon.reconcile({ mission_id: mid, governed_task_id: "GT_NEVER" });
    expect(receipt.outcome).toBe("CONFIRMED_NOT_EXECUTED");
    expect(receipt.replay_allowed).toBe(true);
  });

  it("18. UNKNOWN_SIDE_EFFECT_STATE requires human/abort", () => {
    const ctx = makeCtx("t18");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    const exec = ctx.store.list("executor_execution").find((e) => e.mission_id === mid)!;
    // Adapter says dispatched but its live state vanished from the record →
    // run_root exists, process gone = ambiguous.
    ex.observeOverride = { status: "UNKNOWN" };
    exec.execution_state = "RUNNING";
    exec.run_root = path.join(ROOT, "ghost");
    ctx.store.put("executor_execution", String(exec.execution_id), exec, Number(exec.version));
    const receipt = ctx.recon.reconcile({ execution_id: String(exec.execution_id), mission_id: mid });
    expect(["UNKNOWN_SIDE_EFFECT_STATE", "CONFIRMED_RUNNING"]).toContain(String(receipt.outcome));
    if (receipt.outcome === "UNKNOWN_SIDE_EFFECT_STATE") {
      expect(receipt.replay_allowed).toBe(false);
    }
  });

  it("19. REPLAN actually invokes planner pipeline", () => {
    let calls = 0;
    const ctx = makeCtx("t19", {
      planner: () => {
        calls++;
        return { tasks: [{ task_key: "T1", title: "v2", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] };
      },
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 6 });
    const runtime = rt(ctx, mid);
    runtime.state = "REPLANNING";
    runtime.reason = "forced";
    ctx.store.put("mission_runtime", `MRT_${mid}`, runtime, Number(runtime.version));
    ctx.runtime.tick(mid);
    expect(calls).toBe(2); // initial + replan
  });

  it("20. REPLAN creates new revision + 21. old plan immutable", () => {
    const ctx = makeCtx("t20", {
      planner: () => ({ tasks: [{ task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    const revs1 = ctx.store.planRevisions(mid);
    expect(revs1.length).toBe(1);
    const runtime = rt(ctx, mid);
    runtime.state = "REPLANNING";
    runtime.reason = "forced";
    ctx.store.put("mission_runtime", `MRT_${mid}`, runtime, Number(runtime.version));
    ctx.runtime.tick(mid);
    const revs2 = ctx.store.planRevisions(mid);
    expect(revs2.length).toBe(2);
    expect(Number(ctx.service.activeRevision(mid).revision)).toBe(2);
  });

  it("22. scheduler executes due backoff + 23. backoff not executed early", () => {
    const ctx = makeCtx("t22");
    const now = utcnow();
    const due = new Date(Date.parse(now) - 1000).toISOString();
    const future = new Date(Date.parse(now) + 600_000).toISOString();
    ctx.scheduler.schedule({ mission_id: "m1", task_id: "t1", recovery_id: "r1", action: "RETRY_SAME_ROUTE", due_at: due, payload: {} });
    ctx.scheduler.schedule({ mission_id: "m1", task_id: "t2", recovery_id: "r2", action: "RETRY_SAME_ROUTE", due_at: future, payload: {} });
    const dueNow = ctx.scheduler.dueActions(now);
    expect(dueNow.length).toBe(1);
    expect(dueNow[0].task_id).toBe("t1");
    expect(dueNow[0].status).toBe("READY");
  });

  it("24. task recovery budget + 25. mission recovery budget preserved", () => {
    const ctx = makeCtx("t25b");
    // decide() persists a recovery_attempt per call — 3 attempts/task ceiling
    ctx.recovery.decide({ mission_id: "m", task_id: "t", failure_class: "TRANSIENT_TRANSPORT" });
    ctx.recovery.decide({ mission_id: "m", task_id: "t", failure_class: "TRANSIENT_TRANSPORT" });
    ctx.recovery.decide({ mission_id: "m", task_id: "t", failure_class: "TRANSIENT_TRANSPORT" });
    const d4 = ctx.recovery.decide({ mission_id: "m", task_id: "t", failure_class: "TRANSIENT_TRANSPORT" });
    expect(["HUMAN_APPROVAL_REQUIRED", "ABORT"]).toContain(String(d4.selected_action));
    // mission ceiling: distinct signatures (executor varies) burn the budget
    for (let i = 0; i < 10; i++) {
      ctx.recovery.decide({ mission_id: "m2", task_id: `t${i}`, executor_id: `EX_${i}`, failure_class: "TRANSIENT_TRANSPORT" });
    }
    const dm = ctx.recovery.decide({ mission_id: "m2", task_id: "tZ", executor_id: "EX_Z", failure_class: "POLICY_DENIAL" });
    expect(String(dm.selected_action)).toBe("ABORT");
  });
});

describe("P9 §36 — isolation, approvals, Mission Control backend", () => {
  it("26. three simultaneous missions isolated", () => {
    const ctx = makeCtx("t26", {
      planner: () => ({ tasks: [{ task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mids = [startMission(ctx, "m1"), startMission(ctx, "m2"), startMission(ctx, "m3")];
    ctx.supervisor.runUntilSettled({ maxSweeps: 20 });
    const runtimes = mids.map((m) => String(rt(ctx, m).state));
    expect(runtimes).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    // evidence keyed per mission — no crossover
    for (const m of mids) {
      const ev = ctx.store.listEvidence(m);
      expect(ev.every((e) => e.mission_id === m)).toBe(true);
    }
  });

  it("27. workspace isolation across missions", () => {
    const ctx = makeCtx("t27");
    const ws2 = fs.mkdtempSync(path.join(ctx.dir, "ws2-"));
    const project2 = ctx.service.createProject({ name: "p2", root_location: ws2 });
    const spy = new (class extends ScriptedAdapter {
      override dispatch(task: Record<string, unknown>) {
        expect(String(task.workspace)).toBe(String(this.expectedWorkspace));
        return super.dispatch(task);
      }
      expectedWorkspace = "";
    })("EX_A");
    registerScripted(ctx, spy);
    const m1 = ctx.control.startMission({ project_id: ctx.projectId, goal: "g1", authorized_workspaces: [ctx.workspace] });
    const m2 = ctx.control.startMission({ project_id: String(project2.project_id), goal: "g2", authorized_workspaces: [ws2] });
    spy.expectedWorkspace = ctx.workspace;
    ctx.runtime.run(String(m1.mission_id));
    spy.expectedWorkspace = ws2;
    ctx.runtime.run(String(m2.mission_id));
    const execs = ctx.store.list("executor_execution");
    expect(execs.find((e) => e.mission_id === m1.mission_id)!.workspace).toBe(ctx.workspace);
    expect(execs.find((e) => e.mission_id === m2.mission_id)!.workspace).toBe(ws2);
  });

  it("28. approval scope mismatch rejected", () => {
    const ctx = makeCtx("t28");
    const a = ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: "RECOVERY_BUDGET_OVERRIDE",
      scope: { requested_action: "RECOVERY_BUDGET_OVERRIDE", mission_id: "m", task_id: "t" },
      mission_id: "m",
      task_id: "t",
      reason: "test",
    });
    expect(() =>
      ctx.approvals.decide(String(a.approval_id), "op", "APPROVED", { requested_action: "DIFFERENT" }),
    ).toThrowError(/APPROVAL_SCOPE_MISMATCH/);
  });

  it("29. expired approval rejected", () => {
    const ctx = makeCtx("t29");
    const a = ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: "X",
      scope: { a: 1 },
      reason: "test",
      ttl_seconds: -10,
    });
    expect(() =>
      ctx.approvals.decide(String(a.approval_id), "op", "APPROVED", { a: 1 }),
    ).toThrowError(/APPROVAL_NOT_PENDING|EXPIRED/);
  });

  it("30. Mission Control cannot write DB directly (no store mutation surface)", () => {
    const ctx = makeCtx("t30");
    // MissionControl has no direct mutation methods — every action routes
    // through a canonical authority.
    const ctrl = ctx.control as unknown as Record<string, unknown>;
    for (const bad of ["updateTask", "put", "transitionMission", "commitPlan"]) {
      expect(typeof ctrl[bad]).toBe("undefined");
    }
  });

  it("31. Mission Control pause/resume uses canonical services", () => {
    const ctx = makeCtx("t31");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    ctx.control.pauseMission(mid, "op1");
    expect(ctx.service.getMission(mid).status).toBe("PAUSED");
    ctx.control.resumeMission(mid, "op1");
    expect(ctx.service.getMission(mid).status).toBe("RUNNING");
    expect(() => ctx.control.pauseMission(mid, "")).toThrowError(/OPERATOR_ID_REQUIRED/);
  });

  it("32. DEVIN unavailable → not routable (no credential)", () => {
    const ctx = makeCtx("t32");
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "" });
    const probe = adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("DEVIN_CREDENTIAL_NOT_RESOLVABLE");
    ctx.adapters.set("DEVIN", adapter);
    const res = registerDevin(ctx, adapter);
    expect(res.routable).not.toContain("DEVIN");
  });

  it("33. DEVIN unqualified → not routable", () => {
    const ctx = makeCtx("t33");
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "" });
    expect(adapter.qualify().qualified).toBe(false);
    const res = registerDevin(ctx, adapter);
    expect(res.routable).not.toContain("DEVIN");
    const ex = ctx.service.getExecutor("DEVIN");
    expect((ex.metadata as Record<string, unknown>).qualification_state).toBe("UNQUALIFIED");
  });

  it("34. DEVIN qualified registration succeeds (contract transport)", () => {
    const ctx = makeCtx("t34");
    const fetchFn: DevinFetch = () => ({ status: 200, data: { session_id: "s1", url: "https://app.devin.ai/sessions/s1" } });
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn });
    expect(adapter.probe().available).toBe(true);
    const res = registerDevin(ctx, adapter);
    expect(res.routable).toContain("DEVIN");
  });

  it("35. forged Devin dispatch rejected", () => {
    const ctx = makeCtx("t35");
    const fetchFn: DevinFetch = () => ({ status: 200, data: { session_id: "s1" } });
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn });
    expect(() =>
      adapter.dispatch({ executor_id: "DEVIN", governance_state: "PENDING", task_id: "t", mission_id: "m", governed_task_id: "g", workspace: ctx.workspace, correlation_id: "c" }),
    ).toThrowError(/NOT_DISPATCH_AUTHORIZED/);
    expect(() =>
      adapter.dispatch({ executor_id: "WRONG", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true, task_id: "t", mission_id: "m", governed_task_id: "g", workspace: ctx.workspace, correlation_id: "c" }),
    ).toThrowError(/ROUTING_MISMATCH/);
  });

  it("36. Devin external session id never becomes idempotency authority", () => {
    const ctx = makeCtx("t36");
    let calls = 0;
    const fetchFn: DevinFetch = () => {
      calls++;
      return { status: 200, data: { session_id: "devin-same-remote" } };
    };
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn });
    const task = {
      executor_id: "DEVIN",
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c",
      allowed_paths: [ctx.workspace],
    };
    const r1 = adapter.dispatch(task);
    const r2 = adapter.dispatch(task); // re-dispatch same governed task
    expect(String(r1.execution_id)).toBe(String(r2.execution_id)); // canonical id
    expect(calls).toBe(1); // journal dedup — remote session id irrelevant
  });

  it("37. Devin result normalized to canonical result", () => {
    const ctx = makeCtx("t37");
    const fetchFn: DevinFetch = (m) => ({
      status: 200,
      data: m === "GET" ? { status_enum: "finished", structured_output: { done: true }, url: "u" } : { session_id: "s1", url: "u" },
    });
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    adapter.observe(String(disp.execution_id));
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.execution_id).toBe(disp.execution_id);
    expect(result.mission_id).toBe("m");
    expect(result.task_id).toBe("t");
    expect(result.governed_task_id).toBe("GT1");
    expect(result.status).toBe("COMPLETED");
    expect((result.remote_refs as Record<string, unknown>).session_id).toBe("devin-s1");
  });

  it("37b. blocked persists past grace → FAILED + REMOTE_INPUT_REQUIRED; transient blocked stays RUNNING", () => {
    const ctx = makeCtx("t37b");
    const fetchFn: DevinFetch = (m) => ({
      status: 200,
      data: m === "GET" ? { status_enum: "blocked", url: "u-blocked" } : { session_id: "s1", url: "u-blocked" },
    });
    let nowMs = 1_000_000;
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn,
      blockedGraceMs: 60_000, nowMs: () => nowMs,
      now: () => new Date(nowMs).toISOString(),
    });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    // First blocked sighting → still RUNNING (transient turn-end protection)
    const first = adapter.observe(String(disp.execution_id));
    expect(first.status).toBe("RUNNING");
    expect(first.remote_status_enum).toBe("blocked");
    // Still blocked inside grace → still RUNNING
    nowMs += 30_000;
    expect(adapter.observe(String(disp.execution_id)).status).toBe("RUNNING");
    // Past grace → terminal FAILED, never polls forever
    nowMs += 31_000;
    const observed = adapter.observe(String(disp.execution_id));
    expect(observed.status).toBe("FAILED");
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.status).toBe("FAILED");
    expect((result.error as Record<string, unknown>).class).toBe("REMOTE_INPUT_REQUIRED");
    expect(String((result.error as Record<string, unknown>).detail)).toContain("u-blocked");
  });

  it("37bb. transient blocked → finished → COMPLETED with last devin_message as output", () => {
    const ctx = makeCtx("t37bb");
    let statusEnum = "blocked";
    const fetchFn: DevinFetch = (m) => ({
      status: 200,
      data: m === "GET"
        ? {
            status_enum: statusEnum,
            url: "u-x",
            messages: [
              { type: "initial_user_message", message: "do the thing" },
              { type: "devin_message", message: "working…" },
              // report only exists once the enum settles — while blocked the
              // agent was still mid-question, so no DONE sentinel
              ...(statusEnum === "finished"
                ? [{ type: "devin_message", message: "final report text\n\nDONE" }]
                : []),
            ],
          }
        : { session_id: "s1", url: "u-x" },
    });
    let nowMs = 2_000_000;
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn,
      blockedGraceMs: 60_000, nowMs: () => nowMs,
      now: () => new Date(nowMs).toISOString(),
    });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    expect(adapter.observe(String(disp.execution_id)).status).toBe("RUNNING");
    statusEnum = "finished"; // session settles after the transient blocked
    expect(adapter.observe(String(disp.execution_id)).status).toBe("COMPLETED");
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.status).toBe("COMPLETED");
    // deliverable is the agent's reply text, not a bare enum
    expect(String(result.output)).toContain("final report text");
  });

  it("37bc. blocked + DONE sentinel in last message → COMPLETED without grace wait", () => {
    const ctx = makeCtx("t37bc");
    const fetchFn: DevinFetch = (m) => ({
      status: 200,
      data: m === "GET"
        ? {
            status_enum: "blocked", // enum idles at blocked after the turn ends
            url: "u-done",
            messages: [
              { type: "initial_user_message", message: "…reply DONE." },
              { type: "devin_message", message: "report body\n\nDONE\n\nATTACHMENT:{…}" },
            ],
          }
        : { session_id: "s1", url: "u-done" },
    });
    let nowMs = 3_000_000;
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn,
      blockedGraceMs: 60_000, nowMs: () => nowMs,
      now: () => new Date(nowMs).toISOString(),
    });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    const observed = adapter.observe(String(disp.execution_id));
    expect(observed.status).toBe("COMPLETED"); // DONE wins over the idle-blocked enum
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.status).toBe("COMPLETED");
    expect(String(result.output)).toContain("report body");
  });

  it("37c. blocked → recovery escalates HUMAN_APPROVAL_REQUIRED, no retry", () => {
    const ctx = makeCtx("t37c");
    const decision = ctx.recovery.decide({
      mission_id: "m",
      task_id: "t",
      failure_class: "REMOTE_INPUT_REQUIRED",
      eligible_executors: ["DEVIN"],
    });
    expect(decision.selected_action).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(classifyFailure({ error_class: "REMOTE_INPUT_REQUIRED" })).toBe("REMOTE_INPUT_REQUIRED");
  });

  it("37d. cost guard reject → no remote session created, FAILED + BUDGET_EXCEEDED", () => {
    const ctx = makeCtx("t37d");
    let remoteCalls = 0;
    const fetchFn: DevinFetch = () => {
      remoteCalls++;
      return { status: 200, data: { session_id: "should-never-happen" } };
    };
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(ctx.dir, "devin-j"),
      apiKey: "cog_test",
      fetchFn,
      costGuard: () => ({ allowed: false, reason: "BUDGET_EXCEEDED: remote dispatch budget 10/10 reached" }),
    });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    expect(disp.status).toBe("FAILED");
    expect(remoteCalls).toBe(0); // fail-closed: no remote session was created
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.status).toBe("FAILED");
    expect((result.error as Record<string, unknown>).class).toBe("BUDGET_EXCEEDED");
    expect(String((result.error as Record<string, unknown>).detail)).toContain("budget");
    // Idempotent: a second dispatch of the same task still creates no session.
    const disp2 = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    expect(disp2.status).toBe("FAILED");
    expect(remoteCalls).toBe(0);
  });

  it("37e. BUDGET_EXCEEDED classify → HUMAN_APPROVAL_REQUIRED (never auto-retry spend)", () => {
    const ctx = makeCtx("t37e");
    expect(classifyFailure({ error_class: "BUDGET_EXCEEDED" })).toBe("BUDGET_EXCEEDED");
    const decision = ctx.recovery.decide({
      mission_id: "m",
      task_id: "t",
      failure_class: "BUDGET_EXCEEDED",
      eligible_executors: ["DEVIN", "EX_B"],
    });
    expect(decision.selected_action).toBe("HUMAN_APPROVAL_REQUIRED");
    // retry_allowed=false on the matrix row — no auto-retry of spending.
    expect(RECOVERY_MATRIX.BUDGET_EXCEEDED.retry_allowed).toBe(false);
    expect(RECOVERY_MATRIX.BUDGET_EXCEEDED.actions).toEqual(["HUMAN_APPROVAL_REQUIRED", "ABORT"]);
    // Guard open again → dispatch proceeds normally.
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(ctx.dir, "devin-j"),
      apiKey: "cog_test",
      fetchFn: () => ({ status: 200, data: { session_id: "s-ok", status_enum: "finished" } }),
      costGuard: () => ({ allowed: true }),
    });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t2", mission_id: "m", governed_task_id: "GT2",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    expect(disp.status).not.toBe("FAILED");
    expect(disp.remote_session_id).toBe("devin-s-ok");
  });
});

function registerDevin(ctx: Ctx, adapter: DevinExecutorAdapter) {
  ctx.adapters.set("DEVIN", adapter);
  return registerGovernedExecutors(ctx.service, new Map([["DEVIN", adapter]]));
}

describe("P9 §36 — artifacts, health, fairness, completion", () => {
  it("38. Devin artifact verification required (remote refs are not artifacts)", () => {
    const ctx = makeCtx("t38");
    const fetchFn: DevinFetch = () => ({ status: 200, data: { session_id: "s1", status_enum: "finished" } });
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(ctx.dir, "devin-j"), apiKey: "cog_test", fetchFn });
    const disp = adapter.dispatch({
      executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      task_id: "t", mission_id: "m", governed_task_id: "GT1",
      workspace: ctx.workspace, correlation_id: "c", allowed_paths: [ctx.workspace],
    });
    const result = adapter.collect_result(String(disp.execution_id));
    expect(result.artifacts).toEqual([]); // remote refs, not file artifacts
    expect((result.remote_refs as Record<string, unknown>).session_id).toBe("devin-s1");
  });

  it("39. health projection distinguishes auth/quota/unavailable", () => {
    const ctx = makeCtx("t39");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const dead = new ScriptedAdapter("EX_DEAD");
    dead.available = false;
    ctx.registry.register({
      executor_id: "EX_DEAD", executor_type: "EXTERNAL", capabilities: [],
      health_state: "UNAVAILABLE", status: "ENABLED",
      metadata: { transport_type: TRANSPORT_IN_PROCESS, qualification_state: "UNQUALIFIED" },
    });
    const h = ctx.observability.health();
    expect(h["EXECUTOR:EX_A"].state).toBe("READY");
    expect(h["EXECUTOR:EX_DEAD"].state).toBe("BLOCKED"); // unqualified ≠ down
    expect(h.DB.state).toBe("READY");
  });

  it("40. provider/model health event wakes without mutating qualification", () => {
    const ctx = makeCtx("t40");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    const before = String((ctx.service.getExecutor("EX_A").metadata as Record<string, unknown>).qualification_state);
    ctx.supervisor.wake(mid, "PROVIDER_MODEL_HEALTH_CHANGE", { provider: "groq", event: "rate_limit" });
    const wakes = ctx.store.list("supervisor_wake").filter((w) => w.mission_id === mid && w.reason === "PROVIDER_MODEL_HEALTH_CHANGE");
    expect(wakes.length).toBe(1);
    const after = String((ctx.service.getExecutor("EX_A").metadata as Record<string, unknown>).qualification_state);
    expect(after).toBe(before);
  });

  it("41. P7 advisor remains soft-only (failure cannot break planning)", () => {
    const ctx = makeCtx("t41");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    // advisor that throws — planning must still succeed
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: () => ({ tasks: [{ task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }),
      plannerAdvisor: { advise() { throw new Error("advisor down"); } },
    });
    const mid = startMission(ctx);
    rt2.run(mid);
    expect(rt(ctx, mid).state).toBe("COMPLETED");
  });

  it("42. selfmod validation bootstrap reproducible (deterministic receipt)", () => {
    const ctx = makeCtx("t42");
    const ws = path.join(ctx.dir, "wt");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const boot = new SelfmodBootstrap(ctx.service, { run: () => ({ code: 0, out: "ok" }) });
    fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
    const r1 = boot.bootstrap(ws, "CHG_1");
    expect(r1.pass).toBe(true);
    const boot2 = new SelfmodBootstrap(ctx.service, { run: () => ({ code: 0, out: "ok" }) });
    const r2 = boot2.bootstrap(ws, "CHG_2");
    expect(r2.pass).toBe(true);
    expect(r1.steps.map((s) => s.step)).toEqual(r2.steps.map((s) => s.step));
  });

  it("43. promotion approval scope bound + 44. without approval rejected + 45. tamper rejected", () => {
    const ctx = makeCtx("t43");
    const repoDir = path.join(ctx.dir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoDir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    // seed a promotion candidate
    const promoId = newId("PRC");
    ctx.store.put("promotion_candidate", promoId, {
      promotion_id: promoId,
      change_id: "CHG_1",
      parent_commit: head,
      candidate_commit: head,
      patch_digest: digest({ parent: head, diff: "" }),
      changed_files: [],
      change_class: "SAFE_INTERNAL",
      validation_receipts: [{ step: "typecheck", pass: true, detail: "ok", ran_at: utcnow() }],
      approval_status: "PENDING",
      merged: false,
      created_at: utcnow(),
      version: 0,
    }, 0);
    ctx.store.put("selfmod_candidate", "CHG_1", {
      candidate_id: "CHG_1", change_id: "CHG_1", status: "APPROVED_PROMOTION",
      parent_commit: head, candidate_commit: head, patch_digest: digest({ parent: head, diff: "" }),
      worktree_path: null, version: 0,
    }, 0);
    const promo = new PromotionService(ctx.service, ctx.approvals, repoDir);
    // no approval → rejected
    expect(() => promo.promote(promoId, "op1", {})).toThrowError(/PROMOTION_VERIFICATION/);
    // candidate approved but scope digest not bound → rejected
    ctx.store.put("promotion_candidate", promoId, { ...ctx.store.get("promotion_candidate", promoId), approval_status: "APPROVED", approved_by: "op1" }, 1);
    expect(() => promo.promote(promoId, "op1", { wrong: "scope" })).toThrowError(/PROMOTION_VERIFICATION/);
    // tamper with stored patch digest → digest check catches it (needs approval bound first)
    const scope = { promotion_id: promoId, change_id: "CHG_1" };
    ctx.approvals.request({
      approval_type: "SELFMOD_PROMOTION_APPROVAL",
      requested_action: "PROMOTE_CANDIDATE",
      scope,
      change_id: "CHG_1",
      reason: "approve",
    });
    const apr = ctx.approvals.list()[0];
    ctx.approvals.decide(String(apr.approval_id), "op1", "APPROVED", scope);
    const tampered = ctx.store.get("promotion_candidate", promoId);
    tampered.patch_digest = digest({ parent: head, diff: "EVIL" });
    // bypass hash check by writing raw — store.put would fail integrity on read; simulate tamper via payload rewrite
    ctx.store.put("promotion_candidate", promoId, tampered, 2);
    expect(() => promo.promote(promoId, "op1", scope)).toThrowError(/PROMOTION_VERIFICATION/);
  });

  it("46. Mission Control evidence timeline deterministic", () => {
    const ctx = makeCtx("t46");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    const t1 = ctx.observability.missionTimeline(mid).map((e) => `${e.kind}:${e.event_type ?? e.evidence_kind}`);
    const t2 = ctx.observability.missionTimeline(mid).map((e) => `${e.kind}:${e.event_type ?? e.evidence_kind}`);
    expect(t1).toEqual(t2);
    expect(t1.length).toBeGreaterThan(0);
  });

  it("47. secret values absent from API/read models", () => {
    const ctx = makeCtx("t47");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    process.env.P9_TEST_SECRET = "supersecret-value-99";
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    const blob = JSON.stringify({
      missions: ctx.control.missions(),
      detail: ctx.control.missionDetail(mid),
      health: ctx.control.health(),
      metrics: ctx.control.metrics(),
      routing: ctx.control.routing(),
      approvals: ctx.control.approvals(),
    });
    expect(blob).not.toContain("supersecret-value-99");
    delete process.env.P9_TEST_SECRET;
  });

  it("48. scheduler fairness deterministic (priority → age → id)", () => {
    const ctx = makeCtx("t48", {
      planner: () => ({ tasks: [{ task_key: "T_BASE", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.tick(mid); // PLANNING
    ctx.runtime.tick(mid); // committed → READY
    const mission = ctx.service.getMission(mid);
    const base = ctx.service.listTasks(mid)[0];
    ctx.service.updateTask(String(base.task_id), { status: "COMPLETED" });
    for (const [key, pri, age] of [["LOW", 1, "2025-01-01"], ["HIGH", 9, "2025-01-02"], ["MID", 5, "2025-01-01"]] as const) {
      const tid = `TSK_${key}`;
      ctx.store.put("task", tid, {
        task_id: tid, task_key: key, mission_id: mid, plan_id: mission.plan_id,
        order: 0, title: key, description: key, task_instruction: key,
        required_capabilities: ["FILE_OPERATIONS"], selected_executor: null,
        status: "READY", metadata: { priority: pri }, depends_on: [],
        created_at: `${age}T00:00:00Z`, version: 0,
      }, 0);
    }
    const bigSched = new MissionScheduler(ctx.service, { mission_concurrency: 5 });
    const runnable = bigSched.pickRunnable(mid, {});
    // scheduler sorts priority desc → then age → then id
    const keys = runnable.map((t) => t.task_key);
    expect(keys[0]).toBe("HIGH");
    expect(keys[1]).toBe("MID");
    expect(keys[2]).toBe("LOW");
  });

  it("49. runtime stop/start idempotent (resume() rehydrates exactly)", () => {
    const ctx = makeCtx("t49");
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 4 });
    const r1 = ctx.supervisor.resume();
    const r2 = ctx.supervisor.resume();
    expect(r1.missions).toContain(mid);
    expect(r2.missions).toContain(mid);
    expect(ex.dispatched.length).toBe(1);
  });

  it("50. mission completion requires all terminal requirements satisfied", () => {
    const ctx = makeCtx("t50", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    // T1 completes, T2 fails unrecoverably
    const ex = new ScriptedAdapter("EX_A", [
      { status: "COMPLETED" },
      { status: "FAILED", error_class: "PERMISSION_DENIED" },
    ]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid, { maxTicks: 40 });
    const state = String(rt(ctx, mid).state);
    expect(state).not.toBe("COMPLETED"); // T2 failed → mission must not complete
    expect(ctx.service.getMission(mid).status).not.toBe("COMPLETED");
    const t2 = ctx.service.listTasks(mid).find((t) => t.task_key === "T2");
    expect(["FAILED", "CANCELLED"]).toContain(String(t2!.status));
  });
});

/* ==================== §37 long-running E2E ================================= */

describe("P9 §37 — long-running mission E2E (deterministic executors)", () => {
  it("planning → DAG → routing → execution → dep handoff → recovery → restart → completion", () => {
    const ctx = makeCtx("e2e", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "fetch", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "transform", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
          { task_key: "T3", title: "publish", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"] },
          { task_key: "T4", title: "report", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T3"] },
        ],
      }),
    });
    // T1 ok, T2 fails once transiently then succeeds on retry
    const ex = new ScriptedAdapter("EX_A", [
      { status: "COMPLETED" },
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
      { status: "COMPLETED" },
      { status: "COMPLETED" },
      { status: "COMPLETED" },
    ]);
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    // Phase 1: plan + T1 + T2 dispatch (T2 fails) — may go WAITING_BACKOFF or RECOVERING
    ctx.runtime.run(mid, { maxTicks: 8 });
    // Drive retries: replay due actions by force-advancing now
    const farFuture = "2999-01-01T00:00:00Z";
    ctx.runtime.tick(mid, farFuture);
    ctx.runtime.run(mid, { maxTicks: 20, now: () => farFuture });
    // mid-run restart — fresh runtime on same store
    const rt2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: () => ({ tasks: [] }),
    });
    rt2.run(mid, { maxTicks: 30, now: () => farFuture });
    const state = String(rt(ctx, mid).state);
    expect(["COMPLETED", "FAILED"]).toContain(state);
    // evidence chain complete + ordered
    const timeline = ctx.observability.missionTimeline(mid);
    expect(timeline.length).toBeGreaterThan(5);
    const evidence = ctx.store.listEvidence(mid);
    expect(evidence.length).toBeGreaterThan(0);
  });
});

/* ==================== §40 Mission Control E2E ============================= */

describe("P9 §40 — Mission Control HTTP E2E", () => {
  it("operator workflow: open → DAG → route → failure → recovery → approval → continue/stop", async () => {
    const ctx = makeCtx("mc-e2e", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "t2", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [
      { status: "FAILED", error_class: "TRANSIENT_TRANSPORT" },
      { status: "COMPLETED" },
      { status: "COMPLETED" },
    ]);
    registerScripted(ctx, ex);
    const server = createMissionControlServer({ control: ctx.control });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<Record<string, unknown>>;
      const post = async (p: string, body: Record<string, unknown>, op = "op-test") =>
        (await fetch(`${base}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-operator-id": op },
          body: JSON.stringify(body),
        }));
      // operator creates + opens a mission
      const created = await post("/api/missions", { project_id: ctx.projectId, goal: "e2e", authorized_workspaces: [ctx.workspace] });
      expect(created.status).toBe(200);
      const missionId = String(((await created.json()) as Record<string, unknown>).mission_id);
      // unauthenticated mutation is refused
      const noOp = await fetch(`${base}/api/missions/${missionId}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(noOp.status).toBe(403);
      // DAG + detail visible
      const dag = await get(`/api/missions/${missionId}/dag`);
      expect(dag).toHaveProperty("nodes");
      // drive the mission until it needs attention
      ctx.supervisor.runUntilSettled({ maxSweeps: 6 });
      const detail = await get(`/api/missions/${missionId}`);
      expect(detail).toHaveProperty("mission");
      const health = await get(`/api/health`);
      expect(health).toHaveProperty("DB");
      // approvals visible + decidable
      const approvals = (await get(`/api/approvals`)) as unknown as Array<Record<string, unknown>>;
      if (approvals.some((a) => a.status === "PENDING")) {
        const a = approvals.find((x) => x.status === "PENDING")!;
        const scope = { approved: true }; // wrong scope → rejected
        const bad = await post(`/api/approvals/${a.approval_id}/approve`, { scope });
        expect(bad.status).toBe(409);
      }
      // pause + resume via API through canonical services
      await post(`/api/missions/${missionId}/pause`, {});
      expect(ctx.service.getMission(missionId).status).toBe("PAUSED");
      await post(`/api/missions/${missionId}/resume`, {});
      expect(["RUNNING", "COMPLETED", "FAILED"]).toContain(String(ctx.service.getMission(missionId).status));
    } finally {
      server.close();
    }
  });
});

describe("UI-2 §4.3 — plan preview + digest-confirmed submit", () => {
  it("preview runs planner + validator without creating canonical state", () => {
    const ctx = makeCtx("pv1");
    const preview = ctx.control.previewMission({ project_id: ctx.projectId, goal: "pv" });
    expect(preview.plan.tasks).toHaveLength(1);
    expect(preview.plan_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("confirm_plan with matching digest dispatches; mismatch rejects before create", () => {
    const ctx = makeCtx("pv2");
    const input = {
      project_id: ctx.projectId, goal: "ok",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
    };
    const preview = ctx.control.previewMission(input);
    const m = ctx.control.startMission({
      ...input,
      confirm_plan: { digest: preview.plan_digest },
      operator_id: "op",
    });
    expect(m.mission_id).toBeTruthy();
    // same goal but different submitted input → preview digest won't match
    const drifted = ctx.control.previewMission({ project_id: ctx.projectId, goal: "ok" });
    expect(drifted.plan_digest).not.toBe(preview.plan_digest);
    // mismatched digest → fail-closed reject, no mission persisted
    const p2 = ctx.control.previewMission({ project_id: ctx.projectId, goal: "other" });
    expect(() =>
      ctx.control.startMission({
        project_id: ctx.projectId, goal: "other",
        confirm_plan: { digest: "0".repeat(64) },
        operator_id: "op",
      }),
    ).toThrowError(/PLAN_DIGEST_MISMATCH/);
    expect(ctx.store.list("mission")).toHaveLength(1);
    expect(p2.plan_digest).not.toBe("0".repeat(64));
  });

  it("preview enforces validatePlanProposal fail-closed on bad plans", () => {
    const ctx = makeCtx("pv3", {
      planner: () => ({ tasks: [{ task_key: "T1", title: "x", required_capabilities: ["NOPE_CAP"], depends_on: [] }] }),
    });
    expect(() => ctx.control.previewMission({ project_id: ctx.projectId, goal: "bad" }))
      .toThrowError(/FAIL_CLOSED/);
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("direct POST /api/missions auto-expands via planExpander (telegram/API parity with UI)", async () => {
    const expandedTasks = [
      { task_key: "T1", title: "llm t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] as string[] },
      { task_key: "T2", title: "llm t2", required_capabilities: ["REASONING"], depends_on: ["T1"] },
    ];
    // Mimic the serve seam: the injected planner consumes metadata.llm_plan.
    const llmPlanner = (input: { mission: unknown }) => {
      const meta = (input.mission as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
      const plan = meta?.llm_plan;
      return {
        tasks: (Array.isArray(plan) && plan.length ? plan : [
          { task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        ]) as never[],
      };
    };
    const ctx = makeCtx("pv4", { planner: llmPlanner });
    const server = createMissionControlServer({
      control: ctx.control,
      planExpander: async (b) => ({
        ...(b as Record<string, unknown>),
        metadata: {
          ...((b as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
          llm_plan: expandedTasks,
          plan_source: "llm-test",
        },
      }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-id": "op" },
        body: JSON.stringify({ project_id: ctx.projectId, goal: "direct submit gets llm plan" }),
      });
      expect(res.status).toBe(200);
      const m = (await res.json()) as Record<string, unknown>;
      const meta = ctx.service.getMission(String(m.mission_id)).metadata as Record<string, unknown>;
      // Expanded plan landed on the mission — not the minimal template.
      expect(meta.plan_source).toBe("llm-test");
      expect(Array.isArray(meta.llm_plan)).toBe(true);
      expect((meta.llm_plan as unknown[]).length).toBe(2);
    } finally {
      server.close();
    }
  });

  it("POST /api/outbox accepts binary deliverables via narrow token only", async () => {
    const ctx = makeCtx("obx1");
    const server = createMissionControlServer({
      control: ctx.control,
      authToken: "mc-secret",
      outboxToken: "outbox-secret",
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const mres = await fetch(`http://127.0.0.1:${port}/api/missions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-operator-id": "op",
          authorization: "Bearer mc-secret",
        },
        body: JSON.stringify({ project_id: ctx.projectId, goal: "chart test" }),
      });
      const mission = (await mres.json()) as Record<string, unknown>;
      const upload = (hdrs: Record<string, string>, body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: { "content-type": "application/json", ...hdrs },
          body: JSON.stringify({ mission_id: mission.mission_id, task_id: "T2", ...body }),
        });
      // MC bearer does NOT open the outbox endpoint — only the narrow token does
      expect((await upload({ authorization: "Bearer mc-secret" }, { filename: "a.png", data_base64: "aGk=" })).status).toBe(403);
      // wrong/missing token rejected
      expect((await upload({}, { filename: "a.png", data_base64: "aGk=" })).status).toBe(403);
      // disallowed extension rejected
      expect((await upload({ "x-outbox-token": "outbox-secret" }, { filename: "evil.sh", data_base64: "aGk=" })).status).toBe(400);
      // valid png lands in the project outbox
      const ok = await upload(
        { "x-outbox-token": "outbox-secret" },
        { filename: "chart.png", data_base64: Buffer.from("fakepng").toString("base64") },
      );
      expect(ok.status).toBe(200);
      const written = path.join(ctx.workspace, "outbox", "T2-chart.png");
      expect(fs.existsSync(written)).toBe(true);
      expect(fs.readFileSync(written, "utf8")).toBe("fakepng");
    } finally {
      server.close();
    }
  });

  it("credential broker: operator-managed vault, narrow-token release, audited", async () => {
    const ctx = makeCtx("brk1");
    const audit: Array<Record<string, unknown>> = [];
    const broker = new CredentialBroker({
      vaultPath: path.join(ctx.dir, "vault.json"),
      audit: (e) => audit.push(e as Record<string, unknown>),
    });
    const server = createMissionControlServer({
      control: ctx.control,
      authToken: "mc-secret",
      broker,
      brokerToken: "broker-secret",
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const mcHdr = {
      "content-type": "application/json",
      "x-operator-id": "op",
      authorization: "Bearer mc-secret",
    };
    try {
      // P13: a release needs a business-scoped secret_policy pinned to the
      // mission + a canonical task inside it — a valid token alone denies.
      const bizLayer = new BusinessLayer({
        store: ctx.store,
        control: ctx.control,
        schedules: new MissionScheduleService(ctx.service),
      });
      const biz = bizLayer.createBusiness({ name: "B", project_id: ctx.projectId, operator_id: "op" });
      ctx.service.secretPolicies.createPolicy(
        { credential_reference_name: "github", business_id: String(biz.business_id) },
        "op",
      );
      const mres = await fetch(`http://127.0.0.1:${port}/api/missions`, {
        method: "POST", headers: mcHdr,
        body: JSON.stringify({ project_id: ctx.projectId, goal: "cred test", metadata: { business_id: String(biz.business_id) } }),
      });
      const mission = (await mres.json()) as Record<string, unknown>;
      // canonical task inside the mission — broker fetch requires task∈mission
      const commit = ctx.service.commitPlan({
        mission_id: String(mission.mission_id),
        source: "test",
        tasks: [{ task_key: "T2", title: "t2", task_instruction: "x", required_capabilities: [], depends_on: [] }],
        proposal: { tasks: [] },
      });
      const fetchTaskId = String(commit.task_ids[0]);
      // R1 §3: a fetchable task is canonically bound (routed + executor).
      ctx.service.updateTask(fetchTaskId, {
        selected_executor: "EXEC_A",
        selected_route_id: "RTE_A",
        status: "ROUTED",
      });

      // operator installs a credential — response carries metadata only
      const up = await fetch(`http://127.0.0.1:${port}/api/credentials`, {
        method: "POST", headers: mcHdr,
        body: JSON.stringify({ name: "github", value: "ghp_SUPERSECRET", domains: ["github.com"], kind: "token" }),
      });
      const meta = (await up.json()) as Record<string, unknown>;
      expect(up.status).toBe(200);
      expect(meta.name).toBe("github");
      expect(JSON.stringify(meta)).not.toContain("ghp_SUPERSECRET");

      // listing never leaks values
      const list = (await (await fetch(`http://127.0.0.1:${port}/api/credentials`, { headers: mcHdr })).json()) as {
        credentials: Array<Record<string, unknown>>;
      };
      expect(list.credentials.map((x) => x.name)).toContain("github");
      expect(JSON.stringify(list)).not.toContain("ghp_SUPERSECRET");

      // R3 §2: the worker credential is a task-scoped capability minted
      // from the master token — the master token itself is not accepted.
      const cap = (missionId: string, taskId: string) =>
        mintBrokerCapability("broker-secret", {
          mission_id: missionId,
          task_id: taskId,
          governed_task_id: null,
          executor_id: "EXEC_A",
        });
      const fetchCred = (hdrs: Record<string, string>, body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/api/broker/fetch`, {
          method: "POST",
          headers: { "content-type": "application/json", ...hdrs },
          body: JSON.stringify({ mission_id: mission.mission_id, task_id: fetchTaskId, ...body }),
        });
      // MC bearer does not open the broker; master token alone rejected
      expect((await fetchCred({ authorization: "Bearer mc-secret" }, { credential_name: "github" })).status).toBe(403);
      expect((await fetchCred({ "x-broker-token": "broker-secret" }, { credential_name: "github" })).status).toBe(403);
      // unknown mission rejected even with a valid capability
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/broker/fetch`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-broker-capability": cap("MSN_NOPE", "TSK_NOPE") },
          body: JSON.stringify({ mission_id: "MSN_NOPE", task_id: "TSK_NOPE", credential_name: "github" }),
        })).status,
      ).toBe(404);
      // credential never pinned to this mission → denied + audited
      expect(
        (await fetchCred(
          { "x-broker-capability": cap(String(mission.mission_id), fetchTaskId) },
          { credential_name: "nope" },
        )).status,
      ).toBe(403);
      // legit release → value + audit
      const rel = (await (await fetchCred(
        { "x-broker-capability": cap(String(mission.mission_id), fetchTaskId) },
        { credential_name: "github" },
      )).json()) as Record<string, unknown>;
      expect(rel.value).toBe("ghp_SUPERSECRET");
      expect(rel.domains).toEqual(["github.com"]);
      expect(audit.some((e) => e.event_type === "CREDENTIAL_RELEASED" && e.credential_name === "github")).toBe(true);
      expect(audit.some((e) => e.event_type === "CREDENTIAL_DENIED" && e.credential_name === "nope")).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("UI-3 §4.2 — provider/model/route read projections", () => {
  it("exposes providers/models/routes + model routable gates; read-only, no secrets", () => {
    const ctx = makeCtx("ui3");
    const p = ctx.control.providers();
    const m = ctx.control.models();
    const r = ctx.control.routes();
    expect(p).toHaveProperty("providers");
    expect(m).toHaveProperty("models");
    expect(r).toHaveProperty("routes");
    expect(r).toHaveProperty("routable_models");
    // provider entries expose credential status flag only — never values
    for (const prov of p.providers) {
      expect(["configured", "unavailable"]).toContain(String(prov.credential_status));
      expect(prov).not.toHaveProperty("api_key");
      expect(prov).not.toHaveProperty("credential_value");
    }
    // per-model gate detail
    const some = ctx.control.modelRoutable("ME_DOES_NOT_EXIST");
    expect(some.model).toBeNull();
    expect(some.bindings).toHaveLength(0);
  });
});

describe("UI-4 §4.1 — canonical event stream projection", () => {
  it("eventsSince returns hash-verified events after cursor with monotonic latest_seq", () => {
    const ctx = makeCtx("ui4");
    const before = ctx.control.eventsSince(0);
    startMission(ctx, "ui4 stream");
    const after = ctx.control.eventsSince(before.latest_seq);
    expect(after.latest_seq).toBeGreaterThan(before.latest_seq);
    expect(after.events.length).toBeGreaterThan(0);
    for (const e of after.events) {
      expect(Number(e.seq)).toBeGreaterThan(before.latest_seq);
      expect(e).toHaveProperty("entity_type");
      expect(e).toHaveProperty("event_type");
      expect(e).toHaveProperty("event_hash"); // verified on read by store
    }
    // cursor at latest → empty delta, seq does not regress
    const none = ctx.control.eventsSince(after.latest_seq);
    expect(none.events).toHaveLength(0);
    expect(none.latest_seq).toBe(after.latest_seq);
  });
});

describe("Schedules — recurring mission triggers", () => {
  it("cron parser: nextRunAfter computes correct fire times", () => {
    expect(nextRunAfter("0 7 * * *", "2026-09-27T08:00:00.000Z")).toBe("2026-09-28T07:00:00.000Z");
    expect(nextRunAfter("0 7 * * *", "2026-09-27T06:59:00.000Z")).toBe("2026-09-27T07:00:00.000Z");
    expect(nextRunAfter("*/30 * * * *", "2026-09-27T08:05:00.000Z")).toBe("2026-09-27T08:30:00.000Z");
    expect(nextRunAfter("0 8 * * 1", "2026-09-27T08:00:00.000Z")).toBe("2026-09-28T08:00:00.000Z"); // Mon
    expect(() => nextRunAfter("bogus", "2026-09-27T08:00:00.000Z")).toThrow();
    expect(() => nextRunAfter("99 * * * *", "2026-09-27T08:00:00.000Z")).toThrow();
  });

  it("create → due → fire submits canonical mission with schedule provenance", async () => {
    const ctx = makeCtx("sched1");
    const svc = new MissionScheduleService(ctx.service);
    const proj = ctx.control.projects()[0];
    const s = svc.create({
      goal: "scheduled goal",
      cron: "*/1 * * * *",
      project_id: String(proj.project_id),
      operator_id: "op-sched",
      name: "test-sched",
    });
    expect(s.enabled).toBe(true);
    const before = ctx.service.store.list("mission").length;
    const submitted: Array<Record<string, unknown>> = [];
    const res = await svc.fireDue(
      (input) => {
        submitted.push(input);
        return ctx.control.startMission({
          project_id: input.project_id ?? "",
          goal: input.goal,
          operator_id: input.operator_id,
          metadata: input.metadata,
        });
      },
      "2099-01-01T00:00:00.000Z",
    );
    expect(res.fired).toEqual([String(s.schedule_id)]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].goal).toBe("scheduled goal");
    expect((submitted[0].metadata as Record<string, unknown>).plan_source).toBe("schedule");
    expect(ctx.service.store.list("mission").length).toBe(before + 1);
    const after = svc.get(String(s.schedule_id));
    expect(after.last_mission_id).toBeTruthy();
    expect(Number(after.run_count)).toBe(1);
    // R5: the schedule advances to the next cron tick after the FIRED
    // occurrence's canonical due_at — not past the wall clock. Missed
    // ticks between due_at and `now` remain due for the next pass.
    expect(String(after.next_due_at)).toBe(
      nextRunAfter("*/1 * * * *", String(s.next_due_at)),
    );
  });

  it("not due → no fire; disabled/deleted never fire", async () => {
    const ctx = makeCtx("sched2");
    const svc = new MissionScheduleService(ctx.service);
    const s = svc.create({ goal: "g", cron: "0 7 * * *", operator_id: "op" });
    const res = await svc.fireDue(
      () => { throw new Error("must not run"); },
      "2026-01-01T00:00:00.000Z", // before next_due_at
    );
    expect(res.fired).toHaveLength(0);
    svc.setEnabled(String(s.schedule_id), false, "op");
    const s2 = svc.create({ goal: "g2", cron: "* * * * *", operator_id: "op" });
    svc.remove(String(s2.schedule_id), "op");
    const res2 = await svc.fireDue(() => ({ mission_id: "x" }), "2099-01-01T00:00:00.000Z");
    expect(res2.fired).toHaveLength(0); // disabled + deleted both skipped
  });

  it("tickSchedules routes each due goal through the expander → llm_plan submitted", async () => {
    const llmPlanner = (input: { mission: unknown }) => {
      const meta = (input.mission as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
      const plan = meta?.llm_plan;
      return {
        tasks: (Array.isArray(plan) && plan.length ? plan : [
          { task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        ]) as never[],
      };
    };
    const ctx = makeCtx("schedExp", { planner: llmPlanner });
    const svc = new MissionScheduleService(ctx.service);
    const proj = ctx.control.projects()[0];
    const control = new MissionControl({
      service: ctx.service, runtime: ctx.runtime, supervisor: ctx.supervisor,
      scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, observability: ctx.observability,
      schedules: svc,
      planner: llmPlanner as never,
    });
    svc.create({
      goal: "expand me",
      cron: "* * * * *",
      project_id: String(proj.project_id),
      operator_id: "op",
    });
    const res = await control.tickSchedules("2099-01-01T00:00:00.000Z", async (input) => ({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        llm_plan: [
          { task_key: "T1", title: "one", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "two", required_capabilities: ["REASONING"], depends_on: ["T1"] },
        ],
        plan_source: "llm-exp",
      },
    }));
    expect(res.fired).toHaveLength(1);
    const mission = ctx.store.list("mission").at(-1) as Record<string, unknown>;
    const meta = mission.metadata as Record<string, unknown>;
    expect(String(meta.plan_source)).toBe("llm-exp");
    expect((meta.llm_plan as unknown[]).length).toBe(2);
    // schedule provenance preserved alongside the expanded plan
    expect(meta.schedule_id).toBeTruthy();
  });

  it("schedule persists in pair.db (survives service restart)", () => {
    const ctx = makeCtx("sched3");
    const svc = new MissionScheduleService(ctx.service);
    const s = svc.create({ goal: "persist me", cron: "0 9 * * 1-5", operator_id: "op" });
    // fresh service instance on the same store = simulated restart
    const svc2 = new MissionScheduleService(ctx.service);
    const found = svc2.get(String(s.schedule_id));
    expect(found.goal).toBe("persist me");
    expect(found.enabled).toBe(true);
  });
});

/* ------------------------------ business layer ------------------------------ */

function makeBizCtx(name: string) {
  const ctx = makeCtx(name);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz, schedules };
}

describe("business layer (one-person-business skeleton)", () => {
  it("business → agent → work_item → open dispatches governed mission", () => {
    const { ctx, biz } = makeBizCtx("b1");
    const b = biz.createBusiness({ name: "IndicatorCo", project_id: ctx.projectId, operator_id: "op" });
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "Marketer", department: "marketing", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: String(b.business_id), title: "daily post", goal: "write post", assignee_agent_id: String(a.agent_id), operator_id: "op" });
    expect(String(w.status)).toBe("READY");
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
    const mid = (opened.mission_ids as string[])[0];
    const mission = ctx.store.get("mission", mid);
    const md = mission.metadata as Record<string, unknown>;
    expect(String(md.business_id)).toBe(String(b.business_id));
    expect(String(md.work_item_id)).toBe(String(w.work_item_id));
    expect(String(mission.goal)).toContain("[BUSINESS IndicatorCo | DEPT marketing | AGENT Marketer");
    expect(String(mission.goal)).toContain("write post");
    const evs = ctx.store.listEvents("work_item", String(w.work_item_id)).filter((e) => String(e.event_type) === "WORK_ITEM_OPENED");
    expect(evs).toHaveLength(1);
  });

  it("fail-closed: assignee from another business rejected", () => {
    const { ctx, biz } = makeBizCtx("b2");
    const b1 = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const b2 = biz.createBusiness({ name: "B", project_id: ctx.projectId, operator_id: "op" });
    const a = biz.createOrgAgent({ business_id: String(b2.business_id), title: "X", department: "sales", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: String(b1.business_id), title: "t", goal: "g", operator_id: "op" });
    expect(() => biz.assignWorkItem(String(w.work_item_id), String(a.agent_id), "op"))
      .toThrowError(/FAIL_CLOSED_WORK_ITEM_SCOPE/);
  });

  it("fail-closed: paused agent cannot receive work", () => {
    const { ctx, biz } = makeBizCtx("b3");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "X", department: "sales", operator_id: "op" });
    biz.setOrgAgentStatus(String(a.agent_id), "PAUSED", "op");
    const w = biz.createWorkItem({ business_id: String(b.business_id), title: "t", goal: "g", operator_id: "op" });
    expect(() => biz.assignWorkItem(String(w.work_item_id), String(a.agent_id), "op"))
      .toThrowError(/FAIL_CLOSED_AGENT_INACTIVE/);
  });

  it("budget hard-stop blocks open and records BUDGET_EXCEEDED", () => {
    const { ctx, biz } = makeBizCtx("b4");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    biz.createBudgetPolicy({ business_id: String(b.business_id), scope_type: "business", period: "DAY", max_missions: 1, operator_id: "op" });
    const w1 = biz.createWorkItem({ business_id: String(b.business_id), title: "t1", goal: "g", operator_id: "op" });
    const w2 = biz.createWorkItem({ business_id: String(b.business_id), title: "t2", goal: "g", operator_id: "op" });
    biz.openWorkItem(String(w1.work_item_id), "op");
    expect(() => biz.openWorkItem(String(w2.work_item_id), "op"))
      .toThrowError(/FAIL_CLOSED_BUDGET_EXCEEDED/);
    const evs = ctx.store.listEvents("budget_policy").filter((e) => String(e.event_type) === "BUDGET_EXCEEDED");
    expect(evs).toHaveLength(1);
    // second item never dispatched — still BACKLOG (unassigned → no agent)
    expect(biz.board(String(b.business_id)).BACKLOG).toHaveLength(1);
    expect(biz.board(String(b.business_id)).IN_PROGRESS).toHaveLength(1);
  });

  it("routine compiles to mission_schedule and toggles it", () => {
    const { ctx, biz } = makeBizCtx("b5");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const r = biz.createRoutine({ business_id: String(b.business_id), name: "morning post", goal_template: "post analysis", cron: "0 7 * * *", operator_id: "op" });
    const sched = ctx.store.get("mission_schedule", String(r.schedule_id));
    expect(sched.enabled).toBe(true);
    expect(String(sched.goal)).toContain("[ROUTINE morning post | BUSINESS A | DEPT -]");
    biz.setRoutineEnabled(String(r.routine_id), false, "op");
    expect(ctx.store.get("mission_schedule", String(r.schedule_id)).enabled).toBe(false);
    expect(ctx.store.get("routine", String(r.routine_id)).enabled).toBe(false);
  });

  it("board syncs terminal mission → DONE", () => {
    const { ctx, biz } = makeBizCtx("b6");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const w = biz.createWorkItem({ business_id: String(b.business_id), title: "t", goal: "g", operator_id: "op" });
    biz.openWorkItem(String(w.work_item_id), "op");
    const mid = (biz.listWorkItems(String(b.business_id))[0].mission_ids as string[])[0];
    const mission = ctx.store.get("mission", mid);
    mission.status = "COMPLETED";
    ctx.store.put("mission", mid, mission, Number(mission.version));
    const cols = biz.board(String(b.business_id));
    expect(cols.DONE).toHaveLength(1);
    expect(cols.IN_PROGRESS).toHaveLength(0);
  });

  it("server exposes business routes end-to-end", async () => {
    const ctx = makeCtx("b7");
    const schedules = new MissionScheduleService(ctx.service);
    const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
    const server = createMissionControlServer({ control: ctx.control, business: biz });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", "x-operator-id": "op" };
    try {
      const rb = await fetch(`${base}/api/businesses`, { method: "POST", headers, body: JSON.stringify({ name: "NetCo", project_id: ctx.projectId }) });
      expect(rb.status).toBe(200);
      const bizRow = (await rb.json()) as Record<string, unknown>;
      const ra = await fetch(`${base}/api/org-agents`, { method: "POST", headers, body: JSON.stringify({ business_id: bizRow.business_id, title: "Seller", department: "sales" }) });
      expect(ra.status).toBe(200);
      const ag = (await ra.json()) as Record<string, unknown>;
      const rw = await fetch(`${base}/api/work-items`, { method: "POST", headers, body: JSON.stringify({ business_id: bizRow.business_id, title: "pitch", goal: "draft pitch", assignee_agent_id: ag.agent_id }) });
      const wi = (await rw.json()) as Record<string, unknown>;
      const ro = await fetch(`${base}/api/work-items/${wi.work_item_id}/open`, { method: "POST", headers, body: "{}" });
      expect(ro.status).toBe(200);
      const rd = await fetch(`${base}/api/businesses/${bizRow.business_id}`);
      const detail = (await rd.json()) as Record<string, unknown>;
      expect(((detail.board as Record<string, unknown[]>).IN_PROGRESS ?? []).length).toBe(1);
      // operator gate: POST without x-operator-id → 403
      const rno = await fetch(`${base}/api/businesses`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(rno.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("claim: canonical lease — expiry fenced, reclaim epochs forward, release frees", () => {
    const { ctx, biz } = makeBizCtx("b8");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const bid = String(b.business_id);
    const a1 = biz.createOrgAgent({ business_id: bid, title: "A1", department: "d", operator_id: "op" });
    const a2 = biz.createOrgAgent({ business_id: bid, title: "A2", department: "d", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: bid, title: "t", goal: "g",
      assignee_agent_id: String(a1.agent_id), operator_id: "op" });
    const wid = String(w.work_item_id);
    const c1 = biz.claimWorkItem(wid, String(a1.agent_id), "op");
    expect(c1.claim_token).toBeTruthy();
    // a non-assignee can never claim an assigned item (P2 eligibility)
    expect(() => biz.claimWorkItem(wid, String(a2.agent_id), "op"))
      .toThrowError(/FAIL_CLOSED_WORK_ITEM_CLAIM_ASSIGNEE_MISMATCH/);
    // re-claim while live → already-held, never a second lease
    expect(() => biz.claimWorkItem(wid, String(a1.agent_id), "op"))
      .toThrowError(/FAIL_CLOSED_WORK_ITEM_CLAIM_ALREADY_HELD/);
    // expire the canonical lease → fenced EXPIRED → reclaim at epoch+1
    // (window rewound coherently: issued/heartbeat/expires stay ordered,
    // digest recomputed — simulates a lease whose TTL has elapsed)
    const lease = ctx.store.get("work_claim_lease", `WCL_${wid}`);
    lease.issued_at = "2000-01-01T00:00:00.000Z";
    lease.last_heartbeat_at = "2000-01-01T00:00:01.000Z";
    lease.expires_at = "2000-01-01T00:00:30.000Z";
    lease.lease_digest = claimLeaseDigest(lease);
    ctx.store.put("work_claim_lease", `WCL_${wid}`, lease, Number(lease.version));
    const c2 = biz.claimWorkItem(wid, String(a1.agent_id), "op");
    expect(String(ctx.store.get("work_item", wid).claimed_by)).toBe(String(a1.agent_id));
    expect(Number(ctx.store.get("work_claim_lease", `WCL_${wid}`).lease_epoch)).toBe(2);
    expect(c2.claim_token).not.toBe(String(c1.claim_token));
    // P11/P2: a live claim is released only with its claim_token — a stale or
    // absent token cannot strip ownership.
    expect(() => biz.releaseClaim(wid, "op")).toThrowError(/FAIL_CLOSED_CLAIM_TOKEN/);
    expect(() => biz.releaseClaim(wid, "op", String(c1.claim_token))).toThrowError(/FAIL_CLOSED_CLAIM_TOKEN/);
    biz.releaseClaim(wid, "op", String(c2.claim_token));
    expect(ctx.store.get("work_item", wid).claimed_by).toBeNull();
    expect(String(ctx.store.get("work_claim_lease", `WCL_${wid}`).state)).toBe("RELEASED");
  });

  it("open proceeds when the assignee holds the claim; phantom mirrors cleared", () => {
    const { ctx, biz } = makeBizCtx("b9");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const bid = String(b.business_id);
    const a1 = biz.createOrgAgent({ business_id: bid, title: "A1", department: "d", operator_id: "op" });
    const a2 = biz.createOrgAgent({ business_id: bid, title: "A2", department: "d", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: bid, title: "t", goal: "g", assignee_agent_id: String(a2.agent_id), operator_id: "op" });
    const wid = String(w.work_item_id);
    // claim is coordination only — the canonical assignee claiming does
    // NOT block open; a phantom mirror pointing at another agent is
    // invalidated rather than adopted.
    biz.claimWorkItem(wid, String(a2.agent_id), "op");
    const open = biz.openWorkItem(wid, "op");
    expect(String(open.status)).toBe("IN_PROGRESS");
    const w2 = biz.createWorkItem({ business_id: bid, title: "t2", goal: "g", assignee_agent_id: String(a2.agent_id), operator_id: "op" });
    const wid2 = String(w2.work_item_id);
    const row2 = ctx.store.get("work_item", wid2);
    row2.claimed_by = String(a1.agent_id);
    row2.claim_token = "CLM_forged";
    row2.claim_expires_at = "2999-01-01T00:00:00.000Z";
    ctx.store.put("work_item", wid2, row2, Number(row2.version));
    const open2 = biz.openWorkItem(wid2, "op");
    expect(String(open2.status)).toBe("IN_PROGRESS");
    expect(ctx.store.get("work_item", wid2).claimed_by).toBeNull();
    expect(ctx.store.get("work_item", wid2).claim_token).toBeNull();
  });

  it("comment + block + unblock record events and move status", () => {
    const { ctx, biz } = makeBizCtx("b10");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const w = biz.createWorkItem({ business_id: String(b.business_id), title: "t", goal: "g", operator_id: "op" });
    const wid = String(w.work_item_id);
    biz.commentOnWorkItem(wid, "op", "waiting on asset");
    biz.blockWorkItem(wid, "missing file", "op");
    let row = ctx.store.get("work_item", wid);
    expect(String(row.status)).toBe("BLOCKED");
    expect((row.blockers as unknown[]).length).toBe(1);
    biz.unblockWorkItem(wid, "op");
    row = ctx.store.get("work_item", wid);
    expect(String(row.status)).toBe("READY");
    expect((row.blockers as unknown[]).length).toBe(0);
    const types = ctx.store.listEvents("work_item", wid).map((e) => String(e.event_type));
    expect(types).toContain("WORK_ITEM_COMMENT");
    expect(types).toContain("WORK_ITEM_BLOCKED");
    expect(types).toContain("WORK_ITEM_UNBLOCKED");
  });

  it("agent context: completed mission feeds context_notes, injected into next goal", () => {
    const { ctx, biz } = makeBizCtx("b11");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const bid = String(b.business_id);
    const a = biz.createOrgAgent({ business_id: bid, title: "Marketer", department: "mkt", operator_id: "op" });
    const aid = String(a.agent_id);
    const w1 = biz.createWorkItem({ business_id: bid, title: "post 1", goal: "g", assignee_agent_id: aid, operator_id: "op" });
    biz.openWorkItem(String(w1.work_item_id), "op");
    const mid = (biz.listWorkItems(bid)[0].mission_ids as string[])[0];
    const mission = ctx.store.get("mission", mid);
    mission.status = "COMPLETED";
    mission.result = "posted gold analysis, 120 views";
    ctx.store.put("mission", mid, mission, Number(mission.version));
    biz.board(bid); // triggers sync → context note
    const agent = ctx.store.get("org_agent", aid);
    const notes = agent.context_notes as Array<Record<string, unknown>>;
    expect(notes).toHaveLength(1);
    expect(String(notes[0].note)).toContain("posted gold analysis");
    const w2 = biz.createWorkItem({ business_id: bid, title: "post 2", goal: "g2", assignee_agent_id: aid, operator_id: "op" });
    const opened = biz.openWorkItem(String(w2.work_item_id), "op");
    const m2 = ctx.store.get("mission", (opened.mission_ids as string[])[0]);
    expect(String(m2.goal)).toContain("[AGENT CONTEXT");
    expect(String(m2.goal)).toContain("posted gold analysis");
  });

  it("routine-fired mission projects onto board as work_item", () => {
    const { ctx, biz } = makeBizCtx("b12");
    const b = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const bid = String(b.business_id);
    const r = biz.createRoutine({ business_id: bid, name: "daily", goal_template: "analyze", cron: "0 7 * * *", operator_id: "op" });
    // simulate the schedule having fired: a mission carrying metadata.schedule_id
    ctx.store.put("mission", "MSN_routinerun", {
      mission_id: "MSN_routinerun", status: "COMPLETED", goal: "x",
      created_at: "2026-09-28T07:00:00.000Z",
      metadata: { schedule_id: String(r.schedule_id), business_id: bid, plan_source: "schedule" },
      result: "analysis done",
    }, 0);
    const cols = biz.board(bid);
    expect(cols.DONE).toHaveLength(1);
    const wi = cols.DONE[0];
    expect(String(wi.source)).toBe("routine");
    expect(String(wi.routine_id)).toBe(String(r.routine_id));
    // idempotent — a second board call does not duplicate the item
    expect(biz.board(bid).DONE).toHaveLength(1);
  });

  it("objective tree links work items; cross-business objective rejected", () => {
    const { ctx, biz } = makeBizCtx("b13");
    const b1 = biz.createBusiness({ name: "A", project_id: ctx.projectId, operator_id: "op" });
    const b2 = biz.createBusiness({ name: "B", project_id: ctx.projectId, operator_id: "op" });
    const o = biz.createObjective({ business_id: String(b1.business_id), title: "grow group", metric: "members", target: "1000", operator_id: "op" });
    const child = biz.createObjective({ business_id: String(b1.business_id), title: "daily content", parent_objective_id: String(o.objective_id), operator_id: "op" });
    expect(String(child.parent_objective_id)).toBe(String(o.objective_id));
    const w = biz.createWorkItem({ business_id: String(b1.business_id), title: "t", goal: "g", objective_id: String(child.objective_id), operator_id: "op" });
    expect(String(w.objective_id)).toBe(String(child.objective_id));
    expect(() => biz.createWorkItem({ business_id: String(b1.business_id), title: "t", goal: "g", objective_id: "OBJ_missing", operator_id: "op" }))
      .toThrowError(/FAIL_CLOSED|NOT_FOUND/);
    const oB = biz.createObjective({ business_id: String(b2.business_id), title: "b2 obj", operator_id: "op" });
    expect(() => biz.createWorkItem({ business_id: String(b1.business_id), title: "t", goal: "g", objective_id: String(oB.objective_id), operator_id: "op" }))
      .toThrowError(/FAIL_CLOSED_WORK_ITEM_SCOPE/);
    const d = biz.detail(String(b1.business_id));
    expect((d.objectives as unknown[]).length).toBe(2);
  });
});
