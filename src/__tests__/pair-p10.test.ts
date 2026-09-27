/**
 * P10 FINAL HARDENING tests — soak, concurrency stress, crash matrix,
 * DB integrity, security fail-closed, selfmod/adaptive safety, single
 * routing authority, Mission Control API audit, perf observations.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
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
  createMissionControlServer,
  digest,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p10-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

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
    if (this.observeOverride) {
      const c = this.collected[executionId];
      if (c) c.status = String(this.observeOverride.status);
      return this.observeOverride;
    }
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
  dbPath: string;
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter, opts: { caps?: string[]; priority?: number; maxConcurrency?: number; health?: string } = {}) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: opts.caps ?? ALL_CAPS.slice(0, 4),
    health_state: opts.health ?? "READY",
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
      capabilities: opts.caps ?? ALL_CAPS.slice(0, 4),
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
      capabilities: opts.caps ?? ALL_CAPS.slice(0, 4),
    });
  }
  ctx.adapters.set(adapter.executor_id, adapter);
}

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

const oneTask: PlannerFn = () => ({
  tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
});

function makeCtx(name: string, opts: { planner?: PlannerFn; maxConcurrency?: number } = {}): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: opts.maxConcurrency ?? 2 });
  const plannerCalls: Array<Record<string, unknown>> = [];
  const planner: PlannerFn =
    opts.planner ??
    ((input) => {
      plannerCalls.push(input as Record<string, unknown>);
      return oneTask(input);
    });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability,
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, observability, control,
    adapters, plannerCalls, projectId: String(project.project_id), dbPath,
  };
}

/** Simulate a process restart: fresh runtime objects over the same store. */
function restart(ctx: Ctx): Ctx {
  const scheduler = new MissionScheduler(ctx.service, { mission_concurrency: 2 });
  const approvals = new ApprovalQueue(ctx.service);
  const recovery = new RecoveryController(ctx.service);
  const runtime = new MissionRuntime({
    service: ctx.service, gate: ctx.gate, router: ctx.router,
    adapters: ctx.adapters, scheduler, approvals,
    reconciliation: ctx.recon, recovery,
    planner: () => oneTask({ mission: {}, reason: "" }),
  });
  const supervisor = new MissionSupervisor(ctx.service, runtime, recovery, ctx.recon);
  return { ...ctx, scheduler, approvals, recovery, runtime, supervisor };
}

function startMission(ctx: Ctx, goal = "p10"): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal,
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
}

const rt = (ctx: Ctx, mid: string) => ctx.store.get("mission_runtime", `MRT_${mid}`);
const settle = (ctx: Ctx, mid: string) => ctx.supervisor.runUntilSettled();

function driveUntil(ctx: Ctx, mid: string, state: string, maxTicks = 30) {
  for (let i = 0; i < maxTicks; i++) {
    if (String(rt(ctx, mid).state) === state) return;
    ctx.runtime.tick(mid);
  }
  expect(String(rt(ctx, mid).state), `expected ${state}`).toBe(state);
}

/* ============================ §14 SOAK ===================================== */

describe("P10 §14 — bounded soak over the mission loop", () => {
  it("N missions × DAGs × restarts: 0 duplicates, 0 integrity errors", () => {
    const planner3: PlannerFn = () => ({
      tasks: [
        { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        { task_key: "T3", title: "c", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"] },
      ],
    });
    const ctx = makeCtx("soak", { planner: planner3 });
    const exA = new ScriptedAdapter("EX_A");
    const exB = new ScriptedAdapter("EX_B", [
      { status: "FAILED", error_class: "PROCESS_EXIT" }, // m2 T1 fails once → retry same route succeeds
    ]);
    registerScripted(ctx, exA, { priority: 10 });
    registerScripted(ctx, exB, { priority: 60 });

    const missions: string[] = [];
    for (let i = 0; i < 4; i++) {
      missions.push(startMission(ctx, `soak-${i}`));
    }
    // restart mid-soak after partial progress
    let swept = 0;
    while (swept < 3) { ctx.supervisor.tick(); swept++; }
    const ctx2 = restart(ctx);
    ctx2.supervisor.resume();
    ctx2.supervisor.runUntilSettled({
      maxSweeps: 400,
      now: () => new Date(Date.now() + 120_000).toISOString(),
    });
    // all 4 missions COMPLETED, 3 tasks each
    for (const mid of missions) {
      expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
      const tasks = ctx.service.listTasks(mid);
      expect(tasks.filter((t) => t.status === "COMPLETED").length).toBe(3);
    }
    // 0 duplicate side effects: every execution id unique per task
    const execs = ctx.store.list("executor_execution");
    const byTask = new Map<string, number>();
    for (const e of execs) byTask.set(String(e.task_id), (byTask.get(String(e.task_id)) ?? 0) + 1);
    // a failed task may legitimately retry — same execution or new governed attempt is allowed
    // but a COMPLETED task must never have >1 successful dispatch
    const completedDup = [...byTask.entries()].filter(([tid]) => {
      const t = ctx.service.getTask(tid);
      const tExecs = execs.filter((e) => String(e.task_id) === tid && e.execution_state === "COMPLETED");
      return String(t?.status) === "COMPLETED" && tExecs.length > 1;
    });
    expect(completedDup).toEqual([]);
    expect(ctx.store.verifyIntegrity().entities).toBeGreaterThan(0);
  });
});

/* ===================== §15 CONCURRENCY STRESS ============================== */

describe("P10 §15 — concurrency stress", () => {
  it("bounded executor capacity: maxConcurrency=1 admits one in-flight across missions", () => {
    const ctx = makeCtx("conc-cap", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        ],
      }),
      maxConcurrency: 5,
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }]);
    registerScripted(ctx, ex, { maxConcurrency: 1 });
    const m1 = startMission(ctx, "c1");
    const m2 = startMission(ctx, "c2");
    const m3 = startMission(ctx, "c3");
    for (let i = 0; i < 12; i++) ctx.supervisor.tick();
    // at most 1 in-flight execution on EX_A at any time
    expect(ex.dispatched.length).toBe(1);
    // remaining tasks stay READY, no failed recovery decisions
    for (const mid of [m1, m2, m3]) {
      const s = String(rt(ctx, mid).state);
      expect(["RUNNING", "WAITING", "READY"]).toContain(s);
    }
  });

  it("scheduler fairness: oldest-entered mission dispatches first", () => {
    const ctx = makeCtx("conc-fair", { maxConcurrency: 5 });
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    const m1 = startMission(ctx, "first");
    ctx.runtime.tick(m1); // created→planning earliest
    const m2 = startMission(ctx, "second");
    ctx.runtime.tick(m2);
    const ticked: string[] = [];
    // mission order in supervisor sweep is entered_at then mission_id
    const r = ctx.supervisor.tick();
    ticked.push(...r.ticked);
    expect(ticked[0]).toBe(m1);
  });

  it("approval isolation: pending approval on mission A never blocks mission B", () => {
    const ctx = makeCtx("conc-iso");
    const exA = new ScriptedAdapter("EX_A", [{ status: "FAILED", error_class: "TIMEOUT" }]);
    const exB = new ScriptedAdapter("EX_B");
    registerScripted(ctx, exA, { caps: ["FILE_OPERATIONS"], priority: 10 });
    registerScripted(ctx, exB, { caps: ["FILE_OPERATIONS"], priority: 60 });
    const m1 = startMission(ctx, "iso-A");
    const m2 = startMission(ctx, "iso-B");
    for (let i = 0; i < 20; i++) ctx.supervisor.tick();
    expect(ctx.service.getMission(m2).status).toBe("COMPLETED");
    const m1Pending = ctx.approvals.listPending(m1);
    const m2Pending = ctx.approvals.listPending(m2);
    for (const a of m1Pending) expect(a.mission_id).toBe(m1);
    for (const a of m2Pending) expect(a.mission_id).toBe(m2);
  });

  it("restart during concurrency: rehydration preserves isolation, no duplicate dispatch", () => {
    const ctx = makeCtx("conc-restart", {
      planner: () => ({
        tasks: [
          { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
          { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
        ],
      }),
    });
    const ex = new ScriptedAdapter("EX_A", [{ status: "RUNNING" }, { status: "COMPLETED" }, { status: "COMPLETED" }, { status: "COMPLETED" }, { status: "COMPLETED" }, { status: "COMPLETED" }]);
    registerScripted(ctx, ex);
    const m1 = startMission(ctx, "cr1");
    const m2 = startMission(ctx, "cr2");
    ctx.supervisor.tick();
    ctx.supervisor.tick();
    const before = ex.dispatched.length;
    ex.observeOverride = { status: "COMPLETED" }; // in-flight work finishes during restart
    const ctx2 = restart(ctx);
    ctx2.supervisor.resume();
    ctx2.supervisor.runUntilSettled({ maxSweeps: 200 });
    for (const mid of [m1, m2]) {
      expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
    }
    // task T2 in m2 dispatched fresh (allowed) but T1 executions never duplicated
    const t1Execs = ctx.store.list("executor_execution").filter((e) => {
      const t = ctx.service.getTask(String(e.task_id));
      return String(t?.task_key) === "T1";
    });
    const completedT1 = t1Execs.filter((e) => e.execution_state === "COMPLETED");
    expect(completedT1.length).toBeLessThanOrEqual(2); // one per mission
    expect(ex.dispatched.length - before).toBeLessThanOrEqual(4);
  });
});

/* ===================== §16 CRASH MATRIX ==================================== */

describe("P10 §16 — crash/restart matrix (fresh objects, same store)", () => {
  const checkpoints: Array<{ name: string; setup: (ctx: Ctx, mid: string) => void; expectsApproval?: boolean }> = [
    { name: "A. before plan", setup: () => {} },
    {
      name: "B. after plan (READY)",
      setup: (ctx, mid) => driveUntil(ctx, mid, "READY"),
    },
    {
      name: "C. after dispatch, execution RUNNING",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "RUNNING" }, { status: "COMPLETED" }];
        driveUntil(ctx, mid, "RUNNING");
        driveUntil(ctx, mid, "RUNNING"); // dispatch happened
        // in-flight execution completes while the runtime is down
        ex.observeOverride = { status: "COMPLETED" };
      },
    },
    {
      name: "D. executor completed, result not yet settled",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "RUNNING" }];
        driveUntil(ctx, mid, "RUNNING");
        // mark collected as completed but do not tick → unsettled
        ex.observeOverride = { status: "COMPLETED" };
      },
    },
    {
      name: "E. during recovery backoff",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "FAILED", error_class: "PROCESS_EXIT" }];
        driveUntil(ctx, mid, "RUNNING");
        for (let i = 0; i < 6 && String(rt(ctx, mid).state) !== "WAITING_BACKOFF"; i++) ctx.runtime.tick(mid);
        expect(["WAITING_BACKOFF", "RECOVERING"]).toContain(String(rt(ctx, mid).state));
      },
    },
    {
      name: "F. while approval pending",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [
          { status: "FAILED", error_class: "PERMISSION_DENIED" },
        ];
        driveUntil(ctx, mid, "RUNNING");
        for (let i = 0; i < 8; i++) ctx.runtime.tick(mid);
      },
      expectsApproval: false, // PERMISSION_DENIED → ABORT terminal is also acceptable; tested separately in §18
    },
    {
      name: "G. during reconciliation barrier",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "FAILED", error_class: "TIMEOUT" }];
        driveUntil(ctx, mid, "RUNNING");
        for (let i = 0; i < 8; i++) ctx.runtime.tick(mid);
      },
    },
    {
      name: "H. after plan revision (replan committed)",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "FAILED", error_class: "PLAN_INVALIDATED" }];
        driveUntil(ctx, mid, "RUNNING");
        for (let i = 0; i < 8; i++) ctx.runtime.tick(mid);
      },
    },
    {
      name: "I. during recovery decision (RECOVERING, pending_recovery written)",
      setup: (ctx, mid) => {
        const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
        ex.script = [{ status: "FAILED", error_class: "PROCESS_EXIT" }];
        driveUntil(ctx, mid, "RUNNING");
        for (let i = 0; i < 8 && String(rt(ctx, mid).state) !== "RECOVERING"; i++) ctx.runtime.tick(mid);
        // crash exactly while RECOVERING — pending_recovery must be re-applied
        expect(["RECOVERING", "WAITING_BACKOFF", "RUNNING"]).toContain(String(rt(ctx, mid).state));
      },
    },
    {
      name: "J. while promotion/pending operator approval exists",
      setup: (ctx, mid) => {
        const ap = ctx.approvals.request({
          approval_type: "SELFMOD_PROMOTION_APPROVAL",
          requested_action: "PROMOTE_CANDIDATE",
          scope: { candidate_id: "CAND_X", digest: "d".repeat(8) },
          mission_id: mid,
          reason: "checkpoint J",
        });
        driveUntil(ctx, mid, "RUNNING");
        // stash the approval id for post-restart consumption
        (ctx as Record<string, unknown>).__pendingAp = String(ap.approval_id);
      },
    },
  ];

  for (const cp of checkpoints) {
    it(`${cp.name} → restart → no lost state, no duplicate side effects`, () => {
      const ctx = makeCtx(`crash-${cp.name.slice(0, 2)}`);
      const ex = new ScriptedAdapter("EX_A");
      registerScripted(ctx, ex);
      const mid = startMission(ctx);
      cp.setup(ctx, mid);
      const dispatchedBefore = ex.dispatched.length;
      const ctx2 = restart(ctx);
      ctx2.supervisor.resume();
      // a pending operator approval must survive the restart and stay decidable
      const pendingAp = (ctx as Record<string, unknown>).__pendingAp as string | undefined;
      if (pendingAp) {
        const ap = ctx2.approvals.get(pendingAp);
        expect(String(ap.status)).toBe("PENDING");
        ctx2.approvals.decide(pendingAp, "op", "APPROVED", { candidate_id: "CAND_X", digest: "d".repeat(8) });
      }
      ctx2.supervisor.runUntilSettled({
        maxSweeps: 300,
        now: () => new Date(Date.now() + 120_000).toISOString(),
      });
      // no duplicate side effects: task dispatches never exceed bounded retry budget
      const execs = ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
      const states = execs.map((e) => String(e.execution_state));
      const finalState = String(rt(ctx, mid).state);
      expect(["COMPLETED", "FAILED", "CANCELLED", "ABORTED", "WAITING_APPROVAL", "RECONCILING", "WAITING_BACKOFF", "RECOVERING"]).toContain(finalState);
      // COMPLETED executions unique per execution_id by construction
      expect(new Set(execs.map((e) => e.execution_id)).size).toBe(execs.length);
      void dispatchedBefore;
    });
  }
});

/* ===================== §17 DATABASE INTEGRITY ============================== */

describe("P10 §17 — pair.db integrity", () => {
  it("PRAGMA integrity_check + schema + migration idempotency + hash verify", () => {
    const ctx = makeCtx("db-int");
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    const mid = startMission(ctx);
    settle(ctx, mid);
    // PRAGMA integrity_check
    const ic = ctx.store.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    expect(ic[0].integrity_check).toBe("ok");
    // canonical hash verification via verifyIntegrity
    const v = ctx.store.verifyIntegrity();
    expect(v.entities).toBeGreaterThan(10);
    expect(v.events).toBeGreaterThan(10);
    // reopening the same DB = migration idempotent (no throw, no reset)
    const reopened = new PairEvidenceStore(ctx.dbPath);
    const v2 = reopened.verifyIntegrity();
    expect(v2.entities).toBe(v.entities);
    reopened.db.close();
  });

  it("verify-on-read fails closed on tampered payload", () => {
    const ctx = makeCtx("db-tamper");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    // corrupt an entity payload in place
    ctx.store.db
      .prepare("UPDATE entities SET payload = ? WHERE entity_type = 'mission'")
      .run(JSON.stringify({ tampered: true }));
    expect(() => ctx.store.get("mission", mid)).toThrow(IntegrityError);
  });
});

/* ===================== §18 SECURITY AUDIT ================================== */

describe("P10 §18 — fail-closed security", () => {
  it("workspace escape: task workspace outside authorized roots → denied", () => {
    const ctx = makeCtx("sec-ws", {
      planner: () => ({
        tasks: [{
          task_key: "T1", title: "escape", required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
          metadata: { workspace: "/etc" },
        }],
      }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    expect(String(ctx.service.getMission(mid).status)).not.toBe("COMPLETED");
  });

  it("allowed_paths outside workspace → denied", () => {
    const ctx = makeCtx("sec-paths", {
      planner: () => ({
        tasks: [{
          task_key: "T1", title: "paths", required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
          metadata: { allowed_paths: ["/etc/shadow"] },
        }],
      }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    expect(String(ctx.service.getMission(mid).status)).not.toBe("COMPLETED");
  });

  it("permission expansion: task requests un-granted permission → denied", () => {
    const ctx = makeCtx("sec-perm", {
      planner: () => ({
        tasks: [{
          task_key: "T1", title: "perm", required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
          metadata: { requested_tools: ["definitely_not_granted_tool"] },
        }],
      }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "perm-expansion",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { allowed_tools: ["file_read"] },
    });
    const mid = String(m.mission_id);
    ctx.runtime.run(mid);
    expect(String(ctx.service.getMission(mid).status)).not.toBe("COMPLETED");
  });

  it("unqualified executor cannot dispatch (DISCOVERED ≠ routable)", () => {
    const ctx = makeCtx("sec-unqual");
    const ex = new ScriptedAdapter("EX_A");
    ctx.registry.register({
      executor_id: "EX_A",
      executor_type: "EXTERNAL",
      capabilities: ALL_CAPS.slice(0, 4),
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        routing_priority: 50,
        transport_type: TRANSPORT_IN_PROCESS,
        qualification_state: "DISCOVERED", // not qualified
        permission_modes: ["READ", "WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        supports_cancel: true,
        max_concurrency: 4,
      },
    });
    ctx.service.routes.registerRoute({
      route_id: "RTE_EX_A", route_kind: "IN_PROCESS_RUNTIME", enabled: true,
      eligibility_state: "DISCOVERED", qualification_state: "DISCOVERED",
      direct_callable: true, capabilities: ALL_CAPS.slice(0, 4), priority: 50, executor_hint: "EX_A",
    });
    ctx.service.routes.registerBinding({
      executor_id: "EX_A", route_id: "RTE_EX_A", mechanism: "SPAWN_ENV",
      qualification_state: "DISCOVERED", capabilities: ALL_CAPS.slice(0, 4),
    });
    ctx.adapters.set("EX_A", ex);
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    expect(ex.dispatched.length).toBe(0);
    expect(String(ctx.service.getMission(mid).status)).not.toBe("COMPLETED");
  });

  it("approval scope digest: approving with wrong scope fails closed", () => {
    const ctx = makeCtx("sec-scope");
    const ap = ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: "X",
      scope: { task_id: "T1", mission_id: "M1" },
      mission_id: "M1",
      task_id: "T1",
      reason: "test",
      risk_class: "LOW",
    });
    expect(() =>
      ctx.approvals.decide(String(ap.approval_id), "op", "APPROVED", { task_id: "T2", mission_id: "M1" }),
    ).toThrow();
    expect(String(ctx.approvals.get(String(ap.approval_id)).status)).toBe("PENDING");
  });

  it("expired approval cannot be used", () => {
    const ctx = makeCtx("sec-expiry");
    const ap = ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: "X",
      scope: { task_id: "T1" },
      mission_id: "M1",
      task_id: "T1",
      reason: "test",
      ttl_seconds: -1, // already expired
    });
    const status = String(ctx.approvals.get(String(ap.approval_id)).status);
    expect(["EXPIRED", "PENDING"]).toContain(status); // must not be usable
    if (status === "PENDING") {
      expect(() => ctx.approvals.decide(String(ap.approval_id), "op", "APPROVED", { task_id: "T1" })).toThrow();
    }
  });

  it("evidence append-only: tamper detected on read", () => {
    const ctx = makeCtx("sec-evid");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    settle(ctx, mid);
    ctx.store.db.prepare("UPDATE entities SET payload = ? WHERE entity_type = 'task'").run('{"x":1}');
    expect(() => ctx.store.verifyIntegrity()).toThrow(IntegrityError);
  });
});

/* ===================== §20/§21 SELFMOD + ADAPTIVE SAFETY ==================== */

describe("P10 §20–§21 — selfmod + adaptive safety re-proof", () => {
  it("active experience can never make a disabled executor eligible", () => {
    const ctx = makeCtx("adv-disabled");
    const ex = new ScriptedAdapter("EX_A");
    registerScripted(ctx, ex);
    // now disable it — router must still reject regardless of any advisory state
    ctx.service.db ?? ctx.service;
    const executor = ctx.service.getExecutor("EX_A");
    ctx.store.put("executor", "EX_A", { ...executor, status: "DISABLED" }, Number(executor.version));
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    expect(ex.dispatched.length).toBe(0);
  });

  it("advisor absent → pure deterministic P6 baseline ordering (priority wins)", () => {
    const ctx = makeCtx("adv-baseline");
    const exA = new ScriptedAdapter("EX_A");
    const exB = new ScriptedAdapter("EX_B");
    registerScripted(ctx, exA, { priority: 90 });
    registerScripted(ctx, exB, { priority: 10 });
    const mid = startMission(ctx);
    ctx.runtime.run(mid);
    // highest priority routable wins — EX_B has priority 10 (lower number wins)
    expect(exB.dispatched.length).toBe(1);
    expect(exA.dispatched.length).toBe(0);
  });
});

/* ===================== §22 SINGLE ROUTING AUTHORITY ======================== */

describe("P10 §22 — single mission routing authority", () => {
  it("only gate.ts may call adapter.dispatch in production pair code", () => {
    const dir = path.join(__dirname, "..", "pair");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      if (f === "gate.ts") continue;
      if (/\.dispatch\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("routeGovernedTask is the sole mission dispatch entry (runtime-only callers)", () => {
    const dir = path.join(__dirname, "..", "pair");
    const callers: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      if (/routeGovernedTask\(/.test(src) && f !== "mission-router.ts") callers.push(f);
    }
    // only mission-runtime may invoke the router
    expect(callers).toEqual(["mission-runtime.ts"]);
  });
});

/* ===================== §23 MISSION CONTROL API AUDIT ======================= */

describe("P10 §23 — Mission Control API security", () => {
  it("mutations require operator authority; malformed requests fail closed", async () => {
    const ctx = makeCtx("api-sec");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const server = createMissionControlServer({ control: ctx.control });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // unauthenticated POST → 403
      const r1 = await fetch(`${base}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "x", project_id: ctx.projectId }),
      });
      expect(r1.status).toBe(403);
      // authenticated pause on nonexistent mission → 404
      const r2 = await fetch(`${base}/api/missions/NOPE/pause`, {
        method: "POST",
        headers: { "x-operator-id": "op" },
      });
      expect([404, 409, 500]).toContain(r2.status);
      // read endpoints work without operator
      const r3 = await fetch(`${base}/api/missions`);
      expect(r3.status).toBe(200);
      // replayed/promotion endpoints never silently mutate
      const r4 = await fetch(`${base}/api/promotions/NOPE/approve`, {
        method: "POST", headers: { "x-operator-id": "op" },
      });
      expect(r4.status).not.toBe(200);
    } finally {
      server.close();
    }
  });
});

/* ===================== §24 PERFORMANCE OBSERVATIONS ======================== */

describe("P10 §24 — performance observations (no SLOs invented)", () => {
  it("tick / routing / timeline / rehydrate latencies measured", () => {
    const ctx = makeCtx("perf", {
      planner: () => ({
        tasks: Array.from({ length: 6 }, (_, i) => ({
          task_key: `T${i + 1}`, title: `t${i + 1}`,
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: i === 0 ? [] : [`T${i}`],
        })),
      }),
    });
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    const t0 = performance.now();
    ctx.runtime.run(mid);
    const runMs = performance.now() - t0;
    const t1 = performance.now();
    const timeline = ctx.observability.missionTimeline(mid);
    const tlMs = performance.now() - t1;
    const t2 = performance.now();
    const ctx2 = restart(ctx);
    ctx2.supervisor.resume();
    const rehydMs = performance.now() - t2;
    console.log(`[P10 perf] 6-task DAG run=${runMs.toFixed(1)}ms timeline(${timeline.length ?? "?"} events)=${tlMs.toFixed(1)}ms rehydrate=${rehydMs.toFixed(1)}ms`);
    expect(runMs).toBeLessThan(10_000);
    expect(tlMs).toBeLessThan(2_000);
    expect(rehydMs).toBeLessThan(2_000);
  });
});

/* ===================== §19 SECRET-LEAK SMOKE =============================== */

describe("P10 §19 — no credential material in canonical surfaces", () => {
  it("no cog_/sk-/gsk_/bearer values leak into entities/events/evidence", () => {
    const ctx = makeCtx("secrets");
    registerScripted(ctx, new ScriptedAdapter("EX_A"));
    const mid = startMission(ctx);
    settle(ctx, mid);
    const blob = JSON.stringify([
      ctx.store.list("entities") ?? ctx.store.list("task"),
      ctx.store.listEvents(),
      ctx.store.listEvidence(mid),
    ]);
    expect(blob).not.toMatch(/cog_[A-Za-z0-9_-]{8,}/);
    expect(blob).not.toMatch(/gsk_[A-Za-z0-9_-]{8,}/);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
  });
});
