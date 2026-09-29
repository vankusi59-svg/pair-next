/**
 * P13 COST + SECRETS GOVERNANCE tests — the mandate §36/§37 matrices.
 *
 *  COST A–N   lifecycle, isolation, scope, hard cap, atomic race, warning,
 *             unbounded metered, subscription/free, historical idempotency,
 *             true crash, proven no-dispatch release, ambiguous held,
 *             settlement, unknown-usage accounting
 *  SECRET A–P authorized release, token-insufficient, fake mission/task,
 *             mismatch, cross-business, wrong agent/executor, unpinned,
 *             revocation, no retro-broaden, new mission gets new ref,
 *             missing vault, CAS race, sentinel leakage, P12 not bypassed
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  BusinessLayer,
  CredentialBroker,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p13-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const ALL_CAPS = [
  "FILE_OPERATIONS",
  "AUTOMATON_TASK_EXECUTION",
  "SHELL_EXECUTION",
  "CODE_GENERATION",
  "REASONING",
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
  "NETWORK_ACCESS",
];

/* ---------------------------- scripted executor --------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: string[] = [];
  available = true;
  throwOnDispatch = false;
  resultPayload: Record<string, unknown> = { status: "COMPLETED", summary: "ok" };
  constructor(id: string) {
    this.executor_id = id;
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
    return { capability_ids: [...ALL_CAPS] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    if (this.throwOnDispatch) throw new Error("ADAPTER_DISPATCH_FAILED");
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    return { execution_id: eid, status: "COMPLETED", run_root: null, workspace: task.workspace };
  }
  observe() {
    return { status: "COMPLETED" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result() {
    return this.resultPayload;
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: this.available ? "READY" : "DEGRADED" };
  }
  evidence: Record<string, { dispatched: boolean; execution_id?: string }> = {};
  dispatch_evidence(governedTaskId: string) {
    return this.evidence[governedTaskId];
  }
}

/* --------------------------------- ctx ------------------------------------ */

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

interface Ctx {
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  projectId: string;
}

function makeCtx(name: string): Ctx {
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
  const planner: PlannerFn = () => ({
    tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
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
    costHaltFile: path.join(dir, "COST_HALT"),
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return { dir, workspace, store, service, gate, registry, router, control, adapters, projectId: String(project.project_id) };
}

function makeBizCtx(name: string) {
  const ctx = makeCtx(name);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz, schedules };
}

function makeBiz(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter, opts: { priority?: number } = {}) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: ALL_CAPS,
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: opts.priority ?? 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: 4,
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
      capabilities: ALL_CAPS,
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
      capabilities: ALL_CAPS,
    });
  }
  ctx.adapters.set(adapter.executor_id, adapter);
}

function boundMission(ctx: Ctx, agentId: string | null, businessId: string) {
  const mission = ctx.control.startMission({
    goal: "g",
    project_id: ctx.projectId,
    operator_id: "op",
    metadata: {
      business_id: businessId,
      ...(agentId ? { org_agent_id: agentId, department: "eng" } : {}),
    },
  });
  const missionId = String(mission.mission_id);
  ctx.service.transitionMission(missionId, "READY");
  const commit = ctx.service.commitPlan({
    mission_id: missionId,
    source: "test",
    tasks: [
      {
        task_key: "T1",
        title: "t1",
        task_instruction: "do it",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
      },
    ],
    proposal: { tasks: [] },
  });
  return { mission: ctx.service.getMission(missionId), commit };
}

function govRequest(ctx: Ctx, mission: Record<string, unknown>) {
  const task = ctx.service.listTasks(String(mission.mission_id))[0];
  return {
    mission_id: String(mission.mission_id),
    task_id: String(task.task_id),
    plan_revision: Number(mission.plan_revision),
    task_instruction: String(task.task_instruction),
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: (mission.granted_permissions as string[]) ?? [],
    constraints: [],
    timeout: 60,
    expected_output_contract: { type: "TASK_RESULT" },
    correlation_id: `${String(mission.mission_id)}:${String(task.task_id)}`,
  };
}

/** Route + authorize + dispatch one governed task through the canonical path. */
function dispatchOne(ctx: Ctx, mission: Record<string, unknown>) {
  return ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
}

function taskOf(ctx: Ctx, mission: Record<string, unknown>) {
  return ctx.service.listTasks(String(mission.mission_id))[0];
}

function meteredProfile(ctx: Ctx, executorId: string, reserveMicrousd: number) {
  return ctx.service.cost.upsertCostProfile(
    {
      ref_type: "route",
      ref_id: `RTE_${executorId}`,
      billing_mode: "METERED_API",
      reserve_microusd: reserveMicrousd,
      input_microusd_per_mtok: 100,
      output_microusd_per_mtok: 200,
      source: "operator",
    },
    "test",
  );
}

function freeProfile(ctx: Ctx, executorId: string, mode: "FREE" | "SUBSCRIPTION" | "UNMETERED" = "FREE") {
  return ctx.service.cost.upsertCostProfile(
    { ref_type: "route", ref_id: `RTE_${executorId}`, billing_mode: mode, source: "operator" },
    "test",
  );
}

function reservationOf(ctx: Ctx, governedTaskId: string) {
  return ctx.store.tryGet("cost_reservation", `CRSV_${governedTaskId}`);
}

/* ============================== COST A–N ================================== */

describe("P13.cost A: lifecycle", () => {
  it("metered dispatch reserves HELD → COMMITTED → SETTLED exact", () => {
    const { ctx, biz } = makeBizCtx("ca1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    a.resultPayload = { status: "COMPLETED", actual_microusd: 30 };
    const routed = dispatchOne(ctx, mission);
    const gtid = String(routed.governed_task.governed_task_id);
    const held = reservationOf(ctx, gtid)!;
    expect(String(held.status)).toBe("COMMITTED");
    expect(Number(held.reserved_microusd)).toBe(50);
    expect(a.dispatched.length).toBe(1);
    ctx.gate.collect_execution_result(a, String(routed.execution.execution_id));
    const settled = ctx.store.get("cost_reservation", `CRSV_${gtid}`);
    expect(String(settled.status)).toBe("SETTLED");
    expect(Number(settled.settled_microusd)).toBe(30);
    expect(String(settled.usage_state)).toBe("ACTUAL_SETTLED");
  });
});

describe("P13.cost B/C: isolation + scopes", () => {
  it("policy of another business does not constrain this mission", () => {
    const { ctx, biz } = makeBizCtx("cb1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const ag2 = biz.createOrgAgent({ business_id: String(b2.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 100);
    // B1 hard cap 1 microusd — B2 mission unaffected.
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b1.business_id), scope_type: "business", scope_id: String(b1.business_id), period: "DAY", max_microusd: 1, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag2.agent_id), String(b2.business_id));
    expect(() => dispatchOne(ctx, mission)).not.toThrow();
    expect(a.dispatched.length).toBe(1);
  });

  it("agent + mission scopes stack with the business cap", () => {
    const { ctx, biz } = makeBizCtx("cc1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 60);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "agent", scope_id: String(ag.agent_id), period: "DAY", max_microusd: 50, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_BUDGET_EXCEEDED/);
    expect(a.dispatched.length).toBe(0);
    const exceed = ctx.store.listEvents("cost_policy").filter((e) => e.event_type === "COST_BUDGET_EXCEEDED");
    expect(exceed.length).toBe(1);
  });
});

describe("P13.cost D/F: hard cap + warning", () => {
  it("D. last-cap exceeded → FAIL_CLOSED_COST_BUDGET_EXCEEDED, zero dispatch", () => {
    const { ctx, biz } = makeBizCtx("cd1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 40);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const m1 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    dispatchOne(ctx, m1.mission); // 40 committed
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    dispatchOne(ctx, m2.mission); // 80 committed
    const m3 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, m3.mission)).toThrowError(/FAIL_CLOSED_COST_BUDGET_EXCEEDED/);
    expect(a.dispatched.length).toBe(2);
  });

  it("F. crossing the warning threshold emits COST_BUDGET_WARNING but dispatches", () => {
    const { ctx, biz } = makeBizCtx("cf1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 60);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true, warning_threshold_pct: 50 },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    dispatchOne(ctx, mission);
    const warns = ctx.store
      .listEvidence(String(mission.mission_id))
      .filter((e) => (e.payload as Record<string, unknown>).kind === "COST_BUDGET_WARNING");
    expect(warns.length).toBe(1);
  });
});

describe("P13.cost G/H: unbounded + non-metered billing", () => {
  it("G. METERED_API without conservative bound + hard policy → FAIL_CLOSED_COST_UNBOUNDED", () => {
    const { ctx, biz } = makeBizCtx("cg1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    ctx.service.cost.upsertCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", source: "operator" },
      "test",
    );
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 10_000, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_UNBOUNDED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("G2. UNKNOWN profile + hard policy is allowed but counted unbounded-flagged (no fabricated USD)", () => {
    const { ctx, biz } = makeBizCtx("cg2");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 10, hard_stop: true },
      "test",
    );
    // no profile → billing UNKNOWN → reserve 0, marked unbounded
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const routed = dispatchOne(ctx, mission);
    const res = reservationOf(ctx, String(routed.governed_task.governed_task_id))!;
    expect(String(res.billing_mode)).toBe("UNKNOWN");
    expect(Number(res.reserved_microusd)).toBe(0);
    expect(res.unbounded).toBe(true);
  });

  it("H. SUBSCRIPTION/FREE reserve 0 and never fabricate USD", () => {
    const { ctx, biz } = makeBizCtx("ch1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    freeProfile(ctx, "EXEC_A", "SUBSCRIPTION");
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 1, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const routed = dispatchOne(ctx, mission);
    const res = reservationOf(ctx, String(routed.governed_task.governed_task_id))!;
    expect(String(res.billing_mode)).toBe("SUBSCRIPTION");
    expect(Number(res.reserved_microusd)).toBe(0);
    expect(a.dispatched.length).toBe(1);
  });
});

describe("P13.cost I/J/K/L/M/N: idempotency + crash + settlement", () => {
  function persistCrash(ctx: Ctx, mission: Record<string, unknown>, adapter: ScriptedAdapter) {
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), {
      selected_executor: adapter.executor_id,
      selected_route_id: `RTE_${adapter.executor_id}`,
      status: "ROUTED",
    });
    const { governed_task } = ctx.gate.create_governed_task(
      adapter,
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))),
    );
    const gtid = String(governed_task.governed_task_id);
    ctx.gate.authorize_dispatch(adapter, gtid);
    return gtid;
  }

  it("I. proven historical dispatch → COMMITTED, never re-dispatched or re-charged", () => {
    const { ctx, biz } = makeBizCtx("ci1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const first = dispatchOne(ctx, mission);
    const gtid = String(first.governed_task.governed_task_id);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
    const second = dispatchOne(ctx, ctx.service.getMission(String(mission.mission_id)));
    expect(String(second.execution.execution_id)).toBe(String(first.execution.execution_id));
    expect(a.dispatched.length).toBe(1);
    expect(ctx.store.list("cost_reservation").length).toBe(1);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
  });

  it("J. true crash — HELD reservation + INTENT_RECORDED + no evidence stays conservatively HELD", () => {
    const { ctx, biz } = makeBizCtx("cj1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gtid = persistCrash(ctx, mission, a);
    // reserve the way the dispatch path does, then simulate the crash:
    // intent recorded, adapter dispatched but local write never happened.
    ctx.service.cost.assertAndReserve({
      mission: ctx.service.getMission(String(mission.mission_id)),
      task: taskOf(ctx, mission),
      governedTask: ctx.store.get("governed_task", gtid),
      executorId: "EXEC_A",
    });
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtid}`,
      { intent_id: `INTENT_${gtid}`, governed_task_id: gtid, executor_id: "EXEC_A", state: "INTENT_RECORDED", created_at: utcnow(), version: 0 },
      0,
    );
    ctx.service.cost.reconcileForTask(gtid, a); // no evidence → stays HELD
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("HELD");
    // then the adapter surfaces evidence that the dispatch did happen
    a.evidence[gtid] = { dispatched: true, execution_id: "EXEC_EXT_1" };
    ctx.service.cost.reconcileForTask(gtid, a);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
  });

  it("K. proven no-dispatch (intent + evidence dispatched:false) → RELEASED", () => {
    const { ctx, biz } = makeBizCtx("ck1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gtid = persistCrash(ctx, mission, a);
    ctx.service.cost.assertAndReserve({
      mission: ctx.service.getMission(String(mission.mission_id)),
      task: taskOf(ctx, mission),
      governedTask: ctx.store.get("governed_task", gtid),
      executorId: "EXEC_A",
    });
    a.evidence[gtid] = { dispatched: false };
    ctx.service.cost.reconcileForTask(gtid, a);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("RELEASED");
  });

  it("L. dispatch throws, adapter cannot prove outcome → reservation stays HELD", () => {
    const { ctx, biz } = makeBizCtx("cl1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    a.throwOnDispatch = true; // evidence absent → ambiguous
    expect(() => dispatchOne(ctx, mission)).toThrowError(/ADAPTER_DISPATCH_FAILED/);
    const res = ctx.store.list("cost_reservation");
    expect(res.length).toBe(1);
    expect(String(res[0].status)).toBe("HELD");
  });

  it("M. settlement without provable usage → COMMITTED + ACTUAL_USAGE_UNKNOWN", () => {
    const { ctx, biz } = makeBizCtx("cm1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    a.resultPayload = { status: "COMPLETED" }; // no usage fields
    const routed = dispatchOne(ctx, mission);
    ctx.gate.collect_execution_result(a, String(routed.execution.execution_id));
    const res = reservationOf(ctx, String(routed.governed_task.governed_task_id))!;
    expect(String(res.status)).toBe("COMMITTED");
    expect(String(res.usage_state)).toBe("ACTUAL_USAGE_UNKNOWN");
  });

  it("N. committed reservations count at reserved maximum — unknown usage is never zero", () => {
    const { ctx, biz } = makeBizCtx("cn1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 60);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const m1 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    dispatchOne(ctx, m1.mission); // 60 committed, usage unknown
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    // a second task needs 60 more → 60+60 > 100 → denied even though nothing settled
    expect(() => dispatchOne(ctx, m2.mission)).toThrowError(/FAIL_CLOSED_COST_BUDGET_EXCEEDED/);
  });
});

describe("P13.cost §18 halt", () => {
  it("cost halt blocks NEW cost-bearing dispatch; idempotent history still returns", () => {
    const { ctx, biz } = makeBizCtx("halt");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const m1 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const first = dispatchOne(ctx, m1.mission);
    // halt on
    process.env.PAIR_COST_HALT = "1";
    try {
      const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
      expect(() => dispatchOne(ctx, m2.mission)).toThrowError(/FAIL_CLOSED_COST_HALT/);
      // historical idempotent return still works under halt
      const again = dispatchOne(ctx, ctx.service.getMission(String(m1.mission.mission_id)));
      expect(String(again.execution.execution_id)).toBe(String(first.execution.execution_id));
      expect(a.dispatched.length).toBe(1);
    } finally {
      delete process.env.PAIR_COST_HALT;
    }
  });
});

/* ============================ SECRET A–P =================================== */

const SENTINEL = "FAKE-P13-SENTINEL-9f4d2c71-NEVER-REAL";

function makeBroker(ctx: Ctx) {
  return new CredentialBroker({
    vaultPath: path.join(ctx.dir, "vault.json"),
    audit: (e: { mission_id: string | null; event_type: string; credential_name: string; task_id: string | null; granted: boolean }) =>
      ctx.store.event({
        entity_type: "mission",
        entity_id: e.mission_id ?? "unknown",
        event_type: e.event_type,
        actor: "credential-broker",
        metadata: { credential_name: e.credential_name, task_id: e.task_id, granted: e.granted },
      }),
  });
}

function secretPolicy(ctx: Ctx, businessId: string, ref: string, extra: Record<string, unknown> = {}) {
  return ctx.service.secretPolicies.createPolicy(
    { credential_reference_name: ref, business_id: businessId, ...extra },
    "op",
  );
}

describe("P13.secret A/B/C/D/E: release + early denials", () => {
  it("A. fully authorized release → broker returns value, audited granted", () => {
    const { ctx, biz } = makeBizCtx("sa1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", {
      allowed_agent_ids: [String(ag.agent_id)],
      allowed_executor_ids: ["EXEC_A"],
      allowed_project_ids: [ctx.projectId],
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), { selected_executor: "EXEC_A", status: "ROUTED" });
    const broker = makeBroker(ctx);
    broker.upsert({ name: "openai", value: SENTINEL, domains: ["api.openai.com"], kind: "token" });
    const authz = ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(task.task_id),
      "openai",
    );
    expect(authz.granted).toBe(true);
    const cred = broker.release("openai", { mission_id: String(mission.mission_id), task_id: String(task.task_id) });
    expect(cred?.value).toBe(SENTINEL);
    const grants = ctx.store
      .listEvidence(String(mission.mission_id))
      .filter((e) => (e.payload as Record<string, unknown>).kind === "CREDENTIAL_RELEASE_GRANTED");
    expect(grants.length).toBe(1);
  });

  it("B. token alone is insufficient — no pin → FAIL_CLOSED_SECRET_NOT_PINNED", () => {
    const { ctx, biz } = makeBizCtx("sb1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    const authz = ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(task.task_id),
      "openai",
    );
    expect(authz.granted).toBe(false);
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_NOT_PINNED");
  });

  it("C. fake mission → FAIL_CLOSED_MISSION_NOT_FOUND + audited", () => {
    const { ctx } = makeBizCtx("sc1");
    const authz = ctx.control.authorizeCredentialFetch("MSN_fake", "TSK_fake", "openai");
    expect(authz.granted).toBe(false);
    expect(authz.reason).toBe("FAIL_CLOSED_MISSION_NOT_FOUND");
    // denial is audited on the (nonexistent) mission's evidence axis
    const evs = ctx.store
      .listEvidence("MSN_fake")
      .filter((e) => (e.payload as Record<string, unknown>).kind === "CREDENTIAL_RELEASE_DENIED");
    expect(evs.length).toBe(1);
  });

  it("D. fake task → FAIL_CLOSED_TASK_NOT_FOUND", () => {
    const { ctx, biz } = makeBizCtx("sd1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), "TSK_fake", "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_TASK_NOT_FOUND");
  });

  it("E. task not belonging to the mission → FAIL_CLOSED_TASK_NOT_IN_MISSION", () => {
    const { ctx, biz } = makeBizCtx("se1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const m1 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const authz = ctx.control.authorizeCredentialFetch(
      String(m1.mission.mission_id),
      String(taskOf(ctx, m2.mission).task_id),
      "openai",
    );
    expect(authz.reason).toBe("FAIL_CLOSED_TASK_NOT_IN_MISSION");
  });
});

describe("P13.secret F–J: scope + revocation", () => {
  it("F. cross-business: policy of B2 never authorizes a B1 mission", () => {
    const { ctx, biz } = makeBizCtx("sf1");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const ag1 = biz.createOrgAgent({ business_id: String(b1.business_id), title: "eng", department: "eng", operator_id: "op" });
    // policy lives on B2 only → B1 mission is never pinned for it
    secretPolicy(ctx, String(b2.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag1.agent_id), String(b1.business_id));
    const task = taskOf(ctx, mission);
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_NOT_PINNED");
  });

  it("G. pinned agent allow-list excludes this mission's agent → denied", () => {
    const { ctx, biz } = makeBizCtx("sg1");
    const b = makeBiz(biz, ctx.projectId);
    const ag1 = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const ag2 = biz.createOrgAgent({ business_id: String(b.business_id), title: "ops", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_agent_ids: [String(ag2.agent_id)] });
    const { mission } = boundMission(ctx, String(ag1.agent_id), String(b.business_id));
    const authz = ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(taskOf(ctx, mission).task_id),
      "openai",
    );
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_AGENT_DENIED");
  });

  it("H. denied executor in policy allow-set → FAIL_CLOSED_SECRET_EXECUTOR_DENIED", () => {
    const { ctx, biz } = makeBizCtx("sh1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_executor_ids: ["EXEC_B"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), { selected_executor: "EXEC_A", status: "ROUTED" });
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });

  it("J. revocation narrows future releases; audit events emitted", () => {
    const { ctx, biz } = makeBizCtx("sj1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const pol = secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    expect(
      ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai").granted,
    ).toBe(true);
    ctx.service.secretPolicies.setPolicyStatus(String(pol.policy_id), "REVOKED", "op");
    const after = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(after.granted).toBe(false);
    expect(after.reason).toBe("FAIL_CLOSED_SECRET_POLICY_REVOKED");
    const revoked = ctx.store.listEvents("secret_policy").filter((e) => e.event_type === "SECRET_POLICY_REVOKED");
    expect(revoked.length).toBe(1);
  });
});

describe("P13.secret K/L/M: pin semantics + vault", () => {
  it("K. policy created after mission → old mission stays unpinned; expansion cannot retro-broaden", () => {
    const { ctx, biz } = makeBizCtx("sk1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    // policy created AFTER mission creation
    secretPolicy(ctx, String(b.business_id), "openai");
    const authz = ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(taskOf(ctx, mission).task_id),
      "openai",
    );
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_NOT_PINNED");
  });

  it("K2. pinned allow-set snapshot wins — later widening does not expand the pinned grant", () => {
    const { ctx, biz } = makeBizCtx("sk2");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const pol = secretPolicy(ctx, String(b.business_id), "openai", {
      allowed_executor_ids: ["EXEC_A"],
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), { selected_executor: "EXEC_A", status: "ROUTED" });
    // policy widens later — pinned grant only allows EXEC_A anyway
    ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { allowed_executor_ids: ["EXEC_A", "EXEC_B"] }, Number(pol.version), "op");
    expect(
      ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai").granted,
    ).toBe(true);
    // and if the task were bound to EXEC_B, pinned snapshot still denies it
    ctx.service.updateTask(String(task.task_id), { selected_executor: "EXEC_B" });
    const denied = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(denied.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });

  it("L. a new mission gets the new policy pin", () => {
    const { ctx, biz } = makeBizCtx("sl1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const grants = (mission.metadata as Record<string, unknown>).secret_grants as Array<Record<string, unknown>>;
    expect(grants.length).toBe(1);
    expect(String(grants[0].credential_reference_name)).toBe("openai");
  });

  it("M. authorized fetch but vault value absent → 404 path, audited", () => {
    const { ctx, biz } = makeBizCtx("sm1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.granted).toBe(true);
    const broker = makeBroker(ctx); // vault empty — credential never installed
    expect(broker.release("openai", { mission_id: String(mission.mission_id), task_id: String(task.task_id) })).toBeNull();
  });
});

describe("P13.secret O/P: sentinel + P12 boundary", () => {
  it("O. sentinel value lives only in vault + release response — never in canonical state", () => {
    const { ctx, biz } = makeBizCtx("so1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    const broker = makeBroker(ctx);
    broker.upsert({ name: "openai", value: SENTINEL, domains: ["api.openai.com"], kind: "token" });
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.granted).toBe(true);
    const cred = broker.release("openai", { mission_id: String(mission.mission_id), task_id: String(task.task_id) });
    expect(cred?.value).toBe(SENTINEL);
    // denied fetch too — full audit trail
    ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "missing");
    // Scan every canonical surface: entities, events, evidence, cost model.
    const dump = JSON.stringify({
      entities: ctx.store.list("cost_policy")
        .concat(ctx.store.list("cost_profile"), ctx.store.list("cost_reservation"), ctx.store.list("secret_policy"), ctx.store.list("mission"), ctx.store.list("task")),
      events: ctx.store.listEvents(),
      evidence: ctx.store.listEvidence(),
      cost: ctx.control.cost(),
    });
    expect(dump).not.toContain(SENTINEL);
    // the value exists only in the vault file and the release response
    const vault = JSON.parse(fs.readFileSync(path.join(ctx.dir, "vault.json"), "utf8")) as {
      credentials: Record<string, { value: string }>;
    };
    expect(vault.credentials.openai.value).toBe(SENTINEL);
    expect(String(ctx.store.verifyIntegrity().errors ?? 0)).toBe("0");
  });

  it("P. secret release cannot bypass a P12 executor deny", () => {
    const { ctx, biz } = makeBizCtx("sp1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_executor_ids: ["EXEC_A"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), { selected_executor: "EXEC_A", status: "ROUTED" });
    // P12 contract now denies EXEC_A — release must fail closed.
    biz.upsertAgentContract(String(ag.agent_id), "op", { denied_executor_ids: ["EXEC_A"] });
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });
});

describe("P13.secret policy integrity", () => {
  it("tampered pin digest → FAIL_CLOSED_SECRET_PIN_PROVENANCE", () => {
    const { ctx, biz } = makeBizCtx("sq1");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const row = ctx.store.get("mission", String(mission.mission_id));
    const md = row.metadata as Record<string, unknown>;
    const grants = md.secret_grants as Array<Record<string, unknown>>;
    grants[0].policy_version = 99;
    ctx.store.put("mission", String(mission.mission_id), row, Number(row.version));
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(taskOf(ctx, mission).task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_PIN_PROVENANCE");
  });

  it("update under stale version → FAIL_CLOSED_VERSION_CONFLICT", () => {
    const { ctx, biz } = makeBizCtx("sq2");
    const b = makeBiz(biz, ctx.projectId);
    const pol = secretPolicy(ctx, String(b.business_id), "openai");
    ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { allowed_purpose: "x" }, Number(pol.version), "op");
    expect(() =>
      ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { allowed_purpose: "y" }, 0, "op"),
    ).toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
  });

  it("project scope narrowing denies out-of-scope missions", () => {
    const { ctx, biz } = makeBizCtx("sq3");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_project_ids: ["PRJ_OTHER"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(taskOf(ctx, mission).task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_PROJECT_DENIED");
  });
});

/* ===================== worker_threads races ================================ */

const CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p13");
const BUNDLE = path.join(CACHE, "pair-bundle.mjs");
const WORKER_FILE = path.join(CACHE, "p13-worker.mjs");

const WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, args, barrier } = workerData;

try {
  if (op === "costReserve") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const res = service.cost.assertAndReserve({
      mission: store.get("mission", args.missionId),
      task: store.get("task", args.taskId),
      governedTask: store.get("governed_task", args.governedTaskId),
      executorId: args.executorId,
    });
    parentPort.postMessage({ ok: true, out: { reservation_id: String(res.reservation_id), status: String(res.status) } });
  } else if (op === "secretPolicyUpdate") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const svc = new PAIR.SecretPolicyService(new PAIR.PairControlPlane(store));
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const row = svc.updatePolicy(args.policyId, args.patch, args.expectedVersion, "worker");
    parentPort.postMessage({ ok: true, out: { policy_version: Number(row.policy_version) } });
  } else if (op === "costRecover") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    service.cost.reconcileForTask(args.governedTaskId, {
      dispatch_evidence() { return { dispatched: true, execution_id: args.evidenceExecId }; },
    });
    const res = store.get("cost_reservation", "CRSV_" + args.governedTaskId);
    parentPort.postMessage({ ok: true, out: { status: String(res.status) } });
  } else {
    throw new Error("unknown op " + op);
  }
} catch (e) {
  parentPort.postMessage({ ok: false, code: e && e.code ? e.code : String(e), message: e && e.message });
}
`;

function ensureWorkerBundle() {
  fs.mkdirSync(CACHE, { recursive: true });
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found under node_modules/.pnpm");
  execFileSync(esbuild, [
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(WORKER_FILE, WORKER_SOURCE);
}

type RaceOutcome =
  | { ok: true; out: { reservation_id?: string; status?: string; policy_version?: number } }
  | { ok: false; code: string; message: string };

async function runRace(
  ops: Array<{ op: string; dbPath: string; args: Record<string, unknown> }>,
): Promise<RaceOutcome[]> {
  ensureWorkerBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    ops.map(
      (o) =>
        new Promise<RaceOutcome>((resolve, reject) => {
          const w = new Worker(WORKER_FILE, {
            workerData: { op: o.op, dbPath: o.dbPath, barrier: gate, args: o.args },
          });
          let settled = false;
          w.on("message", (msg: Record<string, unknown>) => {
            if (msg.ready === true) {
              readyCount += 1;
              if (readyCount === ops.length) {
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
              return;
            }
            settled = true;
            resolve(msg as unknown as RaceOutcome);
          });
          w.on("error", reject);
          w.on("exit", (code) => {
            if (!settled) reject(new Error(`worker exited without result code=${code}`));
          });
        }),
    ),
  );
}

describe("P13 races — genuine worker_threads", () => {
  it("R1. two dispatches race the last capacity — one wins, one FAIL_CLOSED", async () => {
    const { ctx, biz } = makeBizCtx("race1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 100);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    // Two governed tasks, each reserving 100 — only one fits.
    const m1 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gt = (m: Record<string, unknown>) => {
      const task = taskOf(ctx, m);
      ctx.service.updateTask(String(task.task_id), {
        selected_executor: "EXEC_A",
        selected_route_id: "RTE_EXEC_A",
        status: "ROUTED",
      });
      return ctx.gate.create_governed_task(
        a,
        govRequest(ctx, ctx.service.getMission(String(m.mission_id))),
      ).governed_task;
    };
    const g1 = gt(m1.mission);
    const g2 = gt(m2.mission);
    const dbPath = path.join(ctx.dir, "pair.db");
    const [r1, r2] = await runRace([
      { op: "costReserve", dbPath, args: { missionId: m1.mission.mission_id, taskId: g1.task_id, governedTaskId: g1.governed_task_id, executorId: "EXEC_A" } },
      { op: "costReserve", dbPath, args: { missionId: m2.mission.mission_id, taskId: g2.task_id, governedTaskId: g2.governed_task_id, executorId: "EXEC_A" } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toBe("FAIL_CLOSED_COST_BUDGET_EXCEEDED");
    expect(ctx.store.list("cost_reservation").length).toBe(1);
    expect(String(ctx.store.verifyIntegrity().errors ?? 0)).toBe("0");
  }, 60_000);

  it("R2. concurrent crash-reconcile converges on one COMMITTED reservation", async () => {
    const { ctx, biz } = makeBizCtx("race2");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    ctx.service.updateTask(String(task.task_id), {
      selected_executor: "EXEC_A",
      selected_route_id: "RTE_EXEC_A",
      status: "ROUTED",
    });
    const { governed_task } = ctx.gate.create_governed_task(
      a,
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))),
    );
    const gtid = String(governed_task.governed_task_id);
    ctx.gate.authorize_dispatch(a, gtid);
    ctx.service.cost.assertAndReserve({
      mission: ctx.service.getMission(String(mission.mission_id)),
      task: taskOf(ctx, mission),
      governedTask: ctx.store.get("governed_task", gtid),
      executorId: "EXEC_A",
    });
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtid}`,
      { intent_id: `INTENT_${gtid}`, governed_task_id: gtid, executor_id: "EXEC_A", state: "INTENT_RECORDED", created_at: utcnow(), version: 0 },
      0,
    );
    const dbPath = path.join(ctx.dir, "pair.db");
    const [r1, r2] = await runRace([
      { op: "costRecover", dbPath, args: { governedTaskId: gtid, evidenceExecId: "EXEC_EXT_9" } },
      { op: "costRecover", dbPath, args: { governedTaskId: gtid, evidenceExecId: "EXEC_EXT_9" } },
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const res = reservationOf(ctx, gtid)!;
    expect(String(res.status)).toBe("COMMITTED");
    expect(ctx.store.list("cost_reservation").length).toBe(1);
  }, 60_000);

  it("R3. two workers update the same secret policy — one wins, one FAIL_CLOSED_VERSION_CONFLICT", async () => {
    const { ctx, biz } = makeBizCtx("race3");
    const b = makeBiz(biz, ctx.projectId);
    const pol = secretPolicy(ctx, String(b.business_id), "openai");
    const dbPath = path.join(ctx.dir, "pair.db");
    const [r1, r2] = await runRace([
      { op: "secretPolicyUpdate", dbPath, args: { policyId: pol.policy_id, patch: { allowed_purpose: "a" }, expectedVersion: Number(pol.version) } },
      { op: "secretPolicyUpdate", dbPath, args: { policyId: pol.policy_id, patch: { allowed_purpose: "b" }, expectedVersion: Number(pol.version) } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    const row = ctx.store.get("secret_policy", String(pol.policy_id));
    expect(Number(row.policy_version)).toBe(2);
  }, 60_000);
});

afterEach(() => {
  delete process.env.PAIR_COST_HALT;
});
