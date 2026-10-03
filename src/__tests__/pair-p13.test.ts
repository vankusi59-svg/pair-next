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
  createMissionControlServer,
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
  mintBrokerCapability,
  sanitizeUntrustedRemote,
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
  tasks: Record<string, Record<string, unknown>> = {};
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
    this.tasks[eid] = task;
    return { execution_id: eid, status: "COMPLETED", run_root: null, workspace: task.workspace };
  }
  observe() {
    return { status: "COMPLETED" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const t = this.tasks[executionId] ?? {};
    return {
      execution_id: executionId,
      mission_id: t.mission_id,
      task_id: t.task_id,
      governed_task_id: t.governed_task_id,
      ...this.resultPayload,
    };
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

/** R1 §3: a fetchable task is canonically bound — executor + route + routed state. */
function bindTask(ctx: Ctx, task: Record<string, unknown>, executorId = "EXEC_A", routeId = `RTE_${executorId}`) {
  ctx.service.updateTask(String(task.task_id), {
    selected_executor: executorId,
    selected_route_id: routeId,
    status: "ROUTED",
  });
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

  it("G2. UNKNOWN billing + hard policy → FAIL_CLOSED_COST_UNKNOWN; no hard policy stays unpriced", () => {
    const { ctx, biz } = makeBizCtx("cg2");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    // R2 §2: UNKNOWN may be a paid external route — a hard cap requires
    // knowing the cost shape. Fail closed, never fabricate $0.
    const pol = ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 10, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_UNKNOWN/);
    expect(a.dispatched.length).toBe(0);
    expect(ctx.store.list("cost_reservation").length).toBe(0);
    // With no hard monetary policy, UNKNOWN stays explicitly unpriced.
    ctx.service.cost.upsertCostPolicy(
      { cost_policy_id: pol.cost_policy_id, business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 10, hard_stop: false },
      "test",
      Number(pol.version),
    );
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const routed = dispatchOne(ctx, m2.mission);
    const res = reservationOf(ctx, String(routed.governed_task.governed_task_id))!;
    expect(String(res.billing_mode)).toBe("UNKNOWN");
    expect(Number(res.reserved_microusd)).toBe(0);
    expect(res.unbounded).toBe(true);
    expect(a.dispatched.length).toBe(1);
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
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", {
      allowed_agent_ids: [String(ag.agent_id)],
      allowed_executor_ids: ["EXEC_A"],
      allowed_project_ids: [ctx.projectId],
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
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
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
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
    bindTask(ctx, task);
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_NOT_PINNED");
  });

  it("G. pinned agent allow-list excludes this mission's agent → denied", () => {
    const { ctx, biz } = makeBizCtx("sg1");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag1 = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const ag2 = biz.createOrgAgent({ business_id: String(b.business_id), title: "ops", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_agent_ids: [String(ag2.agent_id)] });
    const { mission } = boundMission(ctx, String(ag1.agent_id), String(b.business_id));
    bindTask(ctx, taskOf(ctx, mission));
    const authz = ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(taskOf(ctx, mission).task_id),
      "openai",
    );
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_AGENT_DENIED");
  });

  it("H. denied executor in policy allow-set → FAIL_CLOSED_SECRET_EXECUTOR_DENIED", () => {
    const { ctx, biz } = makeBizCtx("sh1");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    registerScripted(ctx, new ScriptedAdapter("EXEC_B"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_executor_ids: ["EXEC_B"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });

  it("J. revocation narrows future releases; audit events emitted", () => {
    const { ctx, biz } = makeBizCtx("sj1");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const pol = secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
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
    bindTask(ctx, taskOf(ctx, mission));
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
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    registerScripted(ctx, new ScriptedAdapter("EXEC_B"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const pol = secretPolicy(ctx, String(b.business_id), "openai", {
      allowed_executor_ids: ["EXEC_A"],
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    // policy widens later — pinned grant only allows EXEC_A anyway
    ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { allowed_executor_ids: ["EXEC_A", "EXEC_B"] }, Number(pol.version), "op");
    expect(
      ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai").granted,
    ).toBe(true);
    // and if the task were bound to EXEC_B, pinned snapshot still denies it
    bindTask(ctx, taskOf(ctx, mission), "EXEC_B");
    const denied = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(taskOf(ctx, mission).task_id), "openai");
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
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.granted).toBe(true);
    const broker = makeBroker(ctx); // vault empty — credential never installed
    expect(broker.release("openai", { mission_id: String(mission.mission_id), task_id: String(task.task_id) })).toBeNull();
  });
});

describe("P13.secret O/P: sentinel + P12 boundary", () => {
  it("O. sentinel value lives only in vault + release response — never in canonical state", () => {
    const { ctx, biz } = makeBizCtx("so1");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
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
    bindTask(ctx, task);
    // P12 contract now denies EXEC_A — release must fail closed.
    biz.upsertAgentContract(String(ag.agent_id), "op", { denied_executor_ids: ["EXEC_A"] });
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(task.task_id), "openai");
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });
});

describe("P13.secret policy integrity", () => {
  it("tampered pin digest → FAIL_CLOSED_SECRET_PIN_PROVENANCE", () => {
    const { ctx, biz } = makeBizCtx("sq1");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    bindTask(ctx, taskOf(ctx, mission));
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
    ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { status: "DISABLED" }, Number(pol.version), "op");
    expect(() =>
      ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { status: "ACTIVE" }, 0, "op"),
    ).toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
  });

  it("project allow-set must reference the business' own canonical project (§8)", () => {
    const { ctx, biz } = makeBizCtx("sq3");
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const other = ctx.service.createProject({ name: "other", root_location: ctx.workspace });
    // A foreign/unknown project id can never be allow-listed for this business.
    expect(() =>
      secretPolicy(ctx, String(b.business_id), "openai", { allowed_project_ids: [String(other.project_id)] }),
    ).toThrowError(/FAIL_CLOSED_SECRET_PROJECT_REF/);
    // A policy scoped to the business' own project admits the mission.
    secretPolicy(ctx, String(b.business_id), "openai", { allowed_project_ids: [ctx.projectId] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    bindTask(ctx, taskOf(ctx, mission));
    const authz = ctx.control.authorizeCredentialFetch(String(mission.mission_id), String(taskOf(ctx, mission).task_id), "openai");
    expect(authz.granted).toBe(true);
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
  } else if (op === "costProfileCreate") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const row = service.cost.createCostProfile(args.input, "worker");
    parentPort.postMessage({ ok: true, out: { reservation_id: String(row.cost_profile_id), status: "CREATED" } });
  } else if (op === "costPolicyCreate") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const row = service.cost.createCostPolicy(args.input, "worker");
    parentPort.postMessage({ ok: true, out: { reservation_id: String(row.cost_policy_id), status: "CREATED" } });
  } else if (op === "vaultSetup") {
    // R6 "process A": install a credential, then rotate or delete it —
    // retiring the old value as redaction-only material in the same vault.
    const broker = new PAIR.CredentialBroker({ vaultPath: args.vaultPath });
    broker.upsert({ name: args.name, value: args.oldValue, domains: ["api.x"], kind: "token" });
    if (args.mode === "rotate") {
      broker.upsert({ name: args.name, value: args.newValue, domains: ["api.x"], kind: "token" });
    } else {
      broker.remove(args.name);
    }
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    parentPort.postMessage({ ok: true, out: { status: "VAULTED" } });
  } else if (op === "restartSanitize") {
    // R5 §3 + R6 §3: fresh worker = fresh module registry = EMPTY
    // sensitive-material Set. Constructing the broker from the EXISTING
    // vault must re-register every installed (and retired) credential —
    // no upsert/release needed for redaction.
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    const gate = new PAIR.GovernedTaskGate(service);
    const broker = new PAIR.CredentialBroker({ vaultPath: args.vaultPath });
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    store.put("executor_execution", args.executionId, {
      execution_id: args.executionId,
      governed_task_id: "GTSK_restart",
      mission_id: "MSN_restart",
      task_id: "TSK_restart",
      executor_id: "EXEC_A",
      plan_revision: 1,
      correlation_id: "corr-restart",
      workspace: null,
      version: 0,
    });
    const adapter = {
      executor_id: "EXEC_A",
      collect_result: () => ({
        status: "COMPLETED",
        output: args.hostile,
        execution_id: args.executionId,
        governed_task_id: "GTSK_restart",
        mission_id: "MSN_restart",
        task_id: "TSK_restart",
      }),
    };
    gate.collect_execution_result(adapter, args.executionId);
    const dump = JSON.stringify({
      execution: store.get("executor_execution", args.executionId),
      missions: store.list("mission"),
      tasks: store.list("task"),
      governed: store.list("governed_task"),
      evidence: store.listEvidence("MSN_restart"),
      events: store.listEvents(),
    });
    // R6 §3: current credential stays releasable, retired value never does.
    let release_ok = null;
    if (args.releaseName) {
      const rel = broker.release(args.releaseName, { mission_id: "MSN_restart", task_id: "TSK_restart" });
      release_ok = args.expectRelease
        ? !!rel && rel.value === args.newValue && rel.value !== args.retiredValue
        : rel === null;
    }
    store.verifyIntegrity();
    parentPort.postMessage({ ok: true, out: { status: "COLLECTED", dump, release_ok } });
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
      { op: "secretPolicyUpdate", dbPath, args: { policyId: pol.policy_id, patch: { status: "DISABLED" }, expectedVersion: Number(pol.version) } },
      { op: "secretPolicyUpdate", dbPath, args: { policyId: pol.policy_id, patch: { status: "DISABLED" }, expectedVersion: Number(pol.version) } },
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

/* =========================== R1 audit remediations ======================== */

describe("P13-R1.cost: retry must re-run the full CURRENT authority", () => {
  /** Governed task authorized + reservation HELD, intent recorded. */
  function heldReservation(ctx: Ctx, mission: Record<string, unknown>, a: ScriptedAdapter) {
    const task = taskOf(ctx, mission);
    bindTask(ctx, task, a.executor_id);
    const { governed_task } = ctx.gate.create_governed_task(
      a,
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))),
    );
    const gtid = String(governed_task.governed_task_id);
    ctx.gate.authorize_dispatch(a, gtid);
    ctx.service.cost.assertAndReserve({
      mission: ctx.service.getMission(String(mission.mission_id)),
      task: ctx.service.getTask(String(task.task_id)),
      governedTask: ctx.store.get("governed_task", gtid),
      executorId: a.executor_id,
    });
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtid}`,
      { intent_id: `INTENT_${gtid}`, governed_task_id: gtid, executor_id: a.executor_id, state: "INTENT_RECORDED", created_at: utcnow(), version: 0 },
      0,
    );
    return gtid;
  }

  it("COST-R1-A: RELEASED + cost halt → retry FAIL_CLOSED_COST_HALT, zero dispatch", () => {
    const { ctx, biz } = makeBizCtx("r1ca");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gtid = heldReservation(ctx, mission, a);
    a.evidence[gtid] = { dispatched: false };
    ctx.service.cost.reconcileForTask(gtid, a);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("RELEASED");
    process.env.PAIR_COST_HALT = "1";
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(/FAIL_CLOSED_COST_HALT/);
    expect(a.dispatched.length).toBe(0);
  });

  it("COST-R1-B: RELEASED + tightened cap → retry FAIL_CLOSED_COST_BUDGET_EXCEEDED", () => {
    const { ctx, biz } = makeBizCtx("r1cb");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const pol = ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gtid = heldReservation(ctx, mission, a);
    a.evidence[gtid] = { dispatched: false };
    ctx.service.cost.reconcileForTask(gtid, a);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("RELEASED");
    // Tighten the cap AFTER the failed attempt — the retry must obey it.
    ctx.service.cost.updateCostPolicy(
      { cost_policy_id: String(pol.cost_policy_id), business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 40, hard_stop: true },
      "test",
      Number(pol.version),
    );
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(/FAIL_CLOSED_COST_BUDGET_EXCEEDED/);
    expect(a.dispatched.length).toBe(0);
    // the RELEASED row is never re-held under a denied retry
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("RELEASED");
  });

  it("COST-R1-C: ambiguous HELD → retry fails closed, never silently adopts", () => {
    const { ctx, biz } = makeBizCtx("r1cc");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const gtid = heldReservation(ctx, mission, a);
    // intent INTENT_RECORDED + no adapter evidence → outcome ambiguous.
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("HELD");
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(/FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS/);
    expect(a.dispatched.length).toBe(0);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("HELD");
  });

  it("COST-R1-D: settlement prices the V1 pin, not a later V2 profile", () => {
    const { ctx, biz } = makeBizCtx("r1cd");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const v1 = ctx.service.cost.upsertCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", reserve_microusd: 100, input_microusd_per_mtok: 1000, source: "operator" },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    a.resultPayload = { status: "COMPLETED", input_tokens: 2000, output_tokens: 0 };
    const routed = dispatchOne(ctx, mission);
    const gtid = String(routed.governed_task.governed_task_id);
    const res = reservationOf(ctx, gtid)!;
    expect(Number(res.cost_profile_version)).toBe(Number(v1.version));
    expect(res.cost_profile_digest).toBeTruthy();
    // V2 doubles the input rate — settlement must ignore it.
    ctx.service.cost.updateCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", reserve_microusd: 100, input_microusd_per_mtok: 2000, source: "operator" },
      "test",
      Number(v1.version),
    );
    ctx.gate.collect_execution_result(a, String(routed.execution.execution_id));
    const settled = ctx.store.get("cost_reservation", `CRSV_${gtid}`);
    expect(String(settled.status)).toBe("SETTLED");
    // V1: ceil(2000 * 1000 / 1e6) = 2 — V2 would give 4.
    expect(Number(settled.settled_microusd)).toBe(2);
  });

  it("COST-R1-E: METERED_API zero-supplied bounds cannot fake-bound a hard policy", () => {
    const { ctx, biz } = makeBizCtx("r1ce");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    ctx.service.cost.upsertCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", reserve_microusd: 0, fixed_microusd: 0, input_microusd_per_mtok: 500, source: "operator" },
      "test",
    );
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_UNBOUNDED/);
    expect(a.dispatched.length).toBe(0);
  });
});

describe("P13-R2.cost: dispatch/cost crash-gap + unknown-cost hard-cap closure", () => {
  it("COST-R2-A: INTENT_RECORDED + COMMITTED + no execution proof → fail closed, never redispatch", () => {
    const { ctx, biz } = makeBizCtx("r2ca");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    const { governed_task } = ctx.gate.create_governed_task(
      a,
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))),
    );
    const gtid = String(governed_task.governed_task_id);
    ctx.gate.authorize_dispatch(a, gtid);
    ctx.service.cost.assertAndReserve({
      mission: ctx.service.getMission(String(mission.mission_id)),
      task: ctx.service.getTask(String(task.task_id)),
      governedTask: ctx.store.get("governed_task", gtid),
      executorId: "EXEC_A",
    });
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtid}`,
      { intent_id: `INTENT_${gtid}`, governed_task_id: gtid, executor_id: "EXEC_A", state: "INTENT_RECORDED", created_at: utcnow(), version: 0 },
      0,
    );
    // Simulated pre-R2 crash shape: money committed, execution row +
    // EXECUTION_PERSISTED never became durable, evidence absent.
    ctx.service.cost.markCommitted(gtid);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(
      /FAIL_CLOSED_COST_COMMITTED_EXECUTION_UNRESOLVED/,
    );
    expect(a.dispatched.length).toBe(0);
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
    expect(String(ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`).state)).toBe("INTENT_RECORDED");
    expect(ctx.store.list("executor_execution").length).toBe(0);
    expect(String(ctx.store.verifyIntegrity().errors ?? 0)).toBe("0");
  });

  it("COST-R2-A2: normal dispatch after ordering change commits with durable execution", () => {
    const { ctx, biz } = makeBizCtx("r2ca2");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const routed = dispatchOne(ctx, mission);
    const gtid = String(routed.governed_task.governed_task_id);
    // evidence durable BEFORE money committed; idempotent redispatch intact
    const exec = ctx.store.get("executor_execution", String(routed.execution.execution_id));
    expect(String(exec.governed_task_id)).toBe(gtid);
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent.state)).toBe("EXECUTION_PERSISTED");
    expect(String(reservationOf(ctx, gtid)!.status)).toBe("COMMITTED");
    const again = dispatchOne(ctx, ctx.service.getMission(String(mission.mission_id)));
    expect(String(again.execution.execution_id)).toBe(String(routed.execution.execution_id));
    expect(a.dispatched.length).toBe(1);
  });

  it("COST-R2-B: UNKNOWN billing + hard policy → FAIL_CLOSED_COST_UNKNOWN, zero reservation", () => {
    const { ctx, biz } = makeBizCtx("r2cb");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    // no cost profile at all → billing UNKNOWN
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_UNKNOWN/);
    expect(a.dispatched.length).toBe(0);
    expect(ctx.store.list("cost_reservation").length).toBe(0);
  });

  it("COST-R2-C: METERED_API fixed_microusd=0 with no rates is NOT bounded → UNBOUNDED", () => {
    const { ctx, biz } = makeBizCtx("r2cc");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    ctx.service.cost.upsertCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", fixed_microusd: 0, source: "operator" },
      "test",
    );
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
      "test",
    );
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, mission)).toThrowError(/FAIL_CLOSED_COST_UNBOUNDED/);
    expect(a.dispatched.length).toBe(0);
    // a positive stated fixed fee with no rates remains a bounded charge
    ctx.service.cost.upsertCostProfile(
      { ref_type: "route", ref_id: "RTE_EXEC_A", billing_mode: "METERED_API", fixed_microusd: 10, source: "operator" },
      "test",
    );
    const m2 = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    expect(() => dispatchOne(ctx, m2.mission)).not.toThrow();
    expect(Number(reservationOf(ctx, String(ctx.store.list("cost_reservation")[0].governed_task_id))!.reserved_microusd)).toBe(10);
  });
});

describe("P13-R1.secret: canonical binding + full P12 narrowing at release", () => {
  function secretCtx(name: string) {
    const { ctx, biz } = makeBizCtx(name);
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    return { ctx, biz, b, ag, mission };
  }
  const fetchFor = (ctx: Ctx, mission: Record<string, unknown>) =>
    ctx.control.authorizeCredentialFetch(
      String(mission.mission_id),
      String(taskOf(ctx, mission).task_id),
      "openai",
    );

  it("SECRET-R1-A: unrouted/unbound task → FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND + audited", () => {
    const { ctx, mission } = secretCtx("r1sa");
    const authz = fetchFor(ctx, mission);
    expect(authz.reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND");
    const denials = ctx.store
      .listEvidence(String(mission.mission_id))
      .filter((e) => (e.payload as Record<string, unknown>).kind === "CREDENTIAL_RELEASE_DENIED");
    expect(denials.length).toBe(1);
  });

  it("SECRET-R1-B: contract allowed_executor_ids excludes the bound executor → denied", () => {
    const { ctx, biz, ag, mission } = secretCtx("r1sb");
    bindTask(ctx, taskOf(ctx, mission));
    biz.upsertAgentContract(String(ag.agent_id), "op", { allowed_executor_ids: ["EXEC_B"] });
    expect(fetchFor(ctx, mission).reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });

  it("SECRET-R1-C: hard executor restriction excludes the bound executor → denied", () => {
    const { ctx, biz, ag, mission } = secretCtx("r1sc");
    registerScripted(ctx, new ScriptedAdapter("EXEC_B"));
    bindTask(ctx, taskOf(ctx, mission));
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      preferred_executor_ids: ["EXEC_B"],
      executor_fallback_allowed: false,
    });
    expect(fetchFor(ctx, mission).reason).toBe("FAIL_CLOSED_SECRET_EXECUTOR_DENIED");
  });

  it("SECRET-R1-D: denied route / route restriction without binding → denied", () => {
    const { ctx, biz, ag, mission } = secretCtx("r1sd");
    bindTask(ctx, taskOf(ctx, mission));
    biz.upsertAgentContract(String(ag.agent_id), "op", { denied_route_ids: ["RTE_EXEC_A"] });
    expect(fetchFor(ctx, mission).reason).toBe("FAIL_CLOSED_SECRET_ROUTE_DENIED");
    // route-scoped release on an unbound task fails closed too
    const { ctx: ctx2, biz: biz2 } = makeBizCtx("r1sd2");
    registerScripted(ctx2, new ScriptedAdapter("EXEC_A"));
    const b2 = makeBiz(biz2, ctx2.projectId);
    const ag2 = biz2.createOrgAgent({ business_id: String(b2.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx2, String(b2.business_id), "openai", { allowed_route_ids: ["RTE_EXEC_A"] });
    const { mission: m2 } = boundMission(ctx2, String(ag2.agent_id), String(b2.business_id));
    bindTask(ctx2, taskOf(ctx2, m2));
    expect(fetchFor(ctx2, m2).granted).toBe(true);
    bindTask(ctx2, taskOf(ctx2, m2), "EXEC_A", "RTE_OTHER");
    expect(fetchFor(ctx2, m2).reason).toBe("FAIL_CLOSED_SECRET_ROUTE_DENIED");
  });

  it("SECRET-R1-E: forged metadata.business_id on another project mints nothing", () => {
    const { ctx, biz } = makeBizCtx("r1se");
    const b = makeBiz(biz, ctx.projectId);
    const other = ctx.service.createProject({ name: "other", root_location: ctx.workspace });
    secretPolicy(ctx, String(b.business_id), "openai");
    // Mission on PRJ_other carrying B1's business_id → fail closed at start.
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: String(other.project_id),
        operator_id: "op",
        metadata: { business_id: String(b.business_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_SECRET_CROSS_BUSINESS/);
    // Unknown business_id also fails closed.
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: "BIZ_FORGED" },
      }),
    ).toThrowError(/FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN/);
  });
});

describe("P13-R1.purpose + API control fields", () => {
  it("PURPOSE-R1: non-null allowed_purpose rejected until an enforceable subject exists", () => {
    const { ctx, biz } = makeBizCtx("r1pu");
    const b = makeBiz(biz, ctx.projectId);
    expect(() =>
      secretPolicy(ctx, String(b.business_id), "openai", { allowed_purpose: "read" }),
    ).toThrowError(/FAIL_CLOSED_SECRET_PURPOSE_UNSUPPORTED/);
    const pol = secretPolicy(ctx, String(b.business_id), "openai");
    expect(() =>
      ctx.service.secretPolicies.updatePolicy(String(pol.policy_id), { allowed_purpose: "x" }, Number(pol.version), "op"),
    ).toThrowError(/FAIL_CLOSED_SECRET_PURPOSE_UNSUPPORTED/);
  });

  it("API-R1: update endpoints split control fields; stale CAS + unknown fields fail; no silent create", async () => {
    const { ctx, biz } = makeBizCtx("r1api");
    const b = makeBiz(biz, ctx.projectId);
    const server = createMissionControlServer({ control: ctx.control });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const hdr = { "content-type": "application/json", "x-operator-id": "op" };
    const post = (p: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
    try {
      const pol = ctx.service.cost.upsertCostPolicy(
        { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
        "op",
      );
      const prof = ctx.service.cost.upsertCostProfile(
        { ref_type: "route", ref_id: "RTE_X", billing_mode: "METERED_API", reserve_microusd: 10, source: "op" },
        "op",
      );
      const sp = secretPolicy(ctx, String(b.business_id), "openai");

      // valid updates with expected_version → 200
      expect((await post("/api/cost-policies/update", {
        cost_policy_id: pol.cost_policy_id, expected_version: pol.version,
        business_id: b.business_id, scope_type: "business", scope_id: b.business_id, period: "DAY", max_microusd: 90,
      })).status).toBe(200);
      expect((await post("/api/cost-profiles/update", {
        ref_type: "route", ref_id: "RTE_X", billing_mode: "METERED_API", reserve_microusd: 20, expected_version: prof.version,
      })).status).toBe(200);
      expect((await post("/api/secret-policies/update", {
        policy_id: sp.policy_id, expected_version: sp.version, status: "DISABLED",
      })).status).toBe(200);

      // stale expected_version → 409 FAIL_CLOSED_VERSION_CONFLICT
      const stale = await post("/api/cost-policies/update", {
        cost_policy_id: pol.cost_policy_id, expected_version: 0,
        business_id: b.business_id, scope_type: "business", scope_id: b.business_id, period: "DAY", max_microusd: 80,
      });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(await stale.json())).toContain("FAIL_CLOSED_VERSION_CONFLICT");

      // unknown payload field → strict validator still rejects (409)
      const badField = await post("/api/cost-policies/update", {
        cost_policy_id: pol.cost_policy_id, expected_version: 1, bogus_field: 1,
        business_id: b.business_id, scope_type: "business", scope_id: b.business_id, period: "DAY", max_microusd: 70,
      });
      expect(badField.status).toBe(409);

      // update must never silently create
      const noCreate = await post("/api/cost-policies/update", {
        cost_policy_id: "CPO_NOPE", expected_version: 0,
        business_id: b.business_id, scope_type: "business", scope_id: b.business_id, period: "DAY", max_microusd: 60,
      });
      expect(noCreate.status).toBe(409);
      expect(JSON.stringify(await noCreate.json())).toContain("FAIL_CLOSED_COST_POLICY_NOT_FOUND");
      const noCreateProfile = await post("/api/cost-profiles/update", {
        ref_type: "route", ref_id: "RTE_GHOST", billing_mode: "METERED_API", reserve_microusd: 1, expected_version: 0,
      });
      expect(noCreateProfile.status).toBe(409);
      expect(ctx.store.list("cost_policy").length).toBe(1);
      expect(ctx.store.list("cost_profile").length).toBe(1);
    } finally {
      server.close();
    }
  });
});

afterEach(() => {
  delete process.env.PAIR_COST_HALT;
});

describe("P13-R3.cost: canonical business context", () => {
  it("COST-R3-A: agent-bound mission without business_id still applies the business hard cap", () => {
    const { ctx, biz } = makeBizCtx("r3a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    meteredProfile(ctx, "EXEC_A", 50);
    ctx.service.cost.upsertCostPolicy(
      { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "MISSION_LIFETIME", max_microusd: 40, hard_stop: true },
      "op",
    );
    // No caller business_id at all — the canonical agent business must win.
    const mission = ctx.control.startMission({
      goal: "g",
      project_id: ctx.projectId,
      operator_id: "op",
      metadata: { org_agent_id: String(ag.agent_id) },
    });
    const m2 = ctx.service.getMission(String(mission.mission_id));
    const bc = (m2.metadata as Record<string, unknown>).business_context as Record<string, unknown>;
    expect(String(bc.business_id)).toBe(String(b.business_id));
    ctx.service.transitionMission(String(mission.mission_id), "READY");
    ctx.service.commitPlan({
      mission_id: String(mission.mission_id),
      source: "test",
      tasks: [{ task_key: "T1", title: "t1", task_instruction: "do", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
      proposal: { tasks: [] },
    });
    const m3 = ctx.service.getMission(String(mission.mission_id));
    expect(() => dispatchOne(ctx, m3)).toThrowError(/FAIL_CLOSED_COST_BUDGET_EXCEEDED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("COST-R3-B: caller department contradicting the canonical agent department fails closed", () => {
    const { ctx, biz } = makeBizCtx("r3b");
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "engineering", operator_id: "op" });
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { org_agent_id: String(ag.agent_id), department: "marketing" },
      }),
    ).toThrowError(/FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH/);
    // A matching department is accepted and canonicalized into the pin.
    const ok = ctx.control.startMission({
      goal: "g",
      project_id: ctx.projectId,
      operator_id: "op",
      metadata: { org_agent_id: String(ag.agent_id), department: "engineering" },
    });
    const bc = ((ok.metadata as Record<string, unknown>).business_context ?? {}) as Record<string, unknown>;
    expect(String(bc.department)).toBe("engineering");
    expect(String(bc.business_id)).toBe(String(b.business_id));
  });

  it("COST-R3-C: agent/business/project mismatches fail closed at mission start", () => {
    const { ctx, biz } = makeBizCtx("r3c");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const ag = biz.createOrgAgent({ business_id: String(b1.business_id), title: "eng", department: "eng", operator_id: "op" });
    // Supplied business_id ≠ agent's canonical business → fail closed.
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { org_agent_id: String(ag.agent_id), business_id: String(b2.business_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_(BUSINESS_CONTEXT_MISMATCH|AGENT_BUSINESS_MISMATCH|AGENT_CONTRACT_SCOPE)/);
    // Agent's canonical business project ≠ mission project → fail closed.
    const otherProject = ctx.service.createProject({ name: "other", root_location: ctx.workspace });
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: String(otherProject.project_id),
        operator_id: "op",
        metadata: { org_agent_id: String(ag.agent_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_(SECRET_CROSS_BUSINESS|AGENT_CONTRACT_SCOPE|BUSINESS_CONTEXT_MISMATCH|AGENT_PROJECT_DENIED)/);
    // A non-business mission with no binding still works.
    const free = ctx.control.startMission({ goal: "g", project_id: ctx.projectId, operator_id: "op" });
    expect(free.mission_id).toBeTruthy();
  });
});

describe("P13-R3.broker: task-scoped capability", () => {
  async function brokerServerCtx(name: string) {
    const { ctx, biz } = makeBizCtx(name);
    registerScripted(ctx, new ScriptedAdapter("EXEC_A"));
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    const broker = makeBroker(ctx);
    broker.upsert({ name: "openai", value: SENTINEL, domains: ["api.openai.com"], kind: "token" });
    const server = createMissionControlServer({ control: ctx.control, broker, brokerToken: "master-secret" });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const cap = (over: Partial<{ mission: string; task: string; exec: string }> = {}) =>
      mintBrokerCapability("master-secret", {
        mission_id: over.mission ?? String(mission.mission_id),
        task_id: over.task ?? String(task.task_id),
        governed_task_id: null,
        executor_id: over.exec ?? "EXEC_A",
      });
    const fetchCred = (hdrs: Record<string, string>, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/api/broker/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hdrs },
        body: JSON.stringify({ mission_id: mission.mission_id, task_id: task.task_id, ...body }),
      });
    return { ctx, mission, task, server, cap, fetchCred };
  }

  it("SECRET-R3-A/B/C/D: scoped capability binds exactly; master token and tampering denied", async () => {
    const { ctx, mission, task, server, cap, fetchCred } = await brokerServerCtx("r3s");
    try {
      // A. Task-scoped token + matching ids → released when policy permits.
      const ok = await fetchCred({ "x-broker-capability": cap() }, { credential_name: "openai" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as Record<string, unknown>).value).toBe(SENTINEL);

      // B1. Capability minted for different ids + this task's ids → deny.
      const other = await fetchCred(
        { "x-broker-capability": cap({ task: "TSK_other" }) },
        { credential_name: "openai" },
      );
      expect(other.status).toBe(403);
      expect(JSON.stringify(await other.json())).toContain("FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");

      // B2. Capability for a different executor than the canonically bound one → deny.
      const wrongExec = await fetchCred(
        { "x-broker-capability": cap({ exec: "EXEC_B" }) },
        { credential_name: "openai" },
      );
      expect(wrongExec.status).toBe(403);
      expect(JSON.stringify(await wrongExec.json())).toContain("FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR");

      // C. Tampered capability → deny.
      const forged = await fetchCred(
        { "x-broker-capability": `${cap().slice(0, -4)}AAAA` },
        { credential_name: "openai" },
      );
      expect(forged.status).toBe(403);
      expect(JSON.stringify(await forged.json())).toContain("FAIL_CLOSED_BROKER_CAPABILITY");

      // D. The master token alone is not a worker credential.
      const master = await fetchCred({ "x-broker-token": "master-secret" }, { credential_name: "openai" });
      expect(master.status).toBe(403);
      expect(JSON.stringify(await master.json())).toContain("UNAUTHORIZED_BROKER_CAPABILITY");

      // Every denial above was audited.
      const denials = ctx.store
        .listEvidence(String(mission.mission_id))
        .filter((e) => (e.payload as Record<string, unknown>).kind === "CREDENTIAL_RELEASE_DENIED");
      expect(denials.length).toBeGreaterThanOrEqual(3);
      void task;
    } finally {
      server.close();
    }
  });

  it("SECRET-R3-E: capability + master secret never leak into canonical state", async () => {
    const { ctx, mission, server, cap, fetchCred } = await brokerServerCtx("r3leak");
    const capability = cap();
    try {
      const ok = await fetchCred({ "x-broker-capability": capability }, { credential_name: "openai" });
      expect(ok.status).toBe(200);
      const dump = JSON.stringify({
        entities: ctx.store.list("cost_reservation"),
        tasks: ctx.store.list("task"),
        missions: ctx.store.list("mission"),
        evidence: ctx.store.listEvidence(String(mission.mission_id)),
        events: ctx.store.listEvents(),
      });
      for (const needle of [SENTINEL, "master-secret", capability]) {
        expect(dump).not.toContain(needle);
      }
      expect(() => ctx.store.verifyIntegrity()).not.toThrow();
    } finally {
      server.close();
    }
  });
});

describe("P13-R3.api: create-only endpoints + CAS update", () => {
  it("API-R3: create fails closed on existing identity; update keeps CAS", async () => {
    const { ctx, biz } = makeBizCtx("r3api");
    const b = makeBiz(biz, ctx.projectId);
    const server = createMissionControlServer({ control: ctx.control });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const hdr = { "content-type": "application/json", "x-operator-id": "op" };
    const post = (p: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: hdr, body: JSON.stringify(body) });
    try {
      // A. Create new profile succeeds.
      const created = await post("/api/cost-profiles", {
        ref_type: "route", ref_id: "RTE_R3", billing_mode: "METERED_API", reserve_microusd: 25, source: "op",
      });
      expect(created.status).toBe(200);
      const prof = (await created.json()) as Record<string, unknown>;

      // B. Same identity again → EXISTS fail closed; row unchanged.
      const dupe = await post("/api/cost-profiles", {
        ref_type: "route", ref_id: "RTE_R3", billing_mode: "FREE", source: "op",
      });
      expect(dupe.status).toBe(409);
      expect(JSON.stringify(await dupe.json())).toContain("FAIL_CLOSED_COST_PROFILE_EXISTS");
      const still = ctx.store.get("cost_profile", String(prof.cost_profile_id));
      expect(String(still.billing_mode)).toBe("METERED_API");
      expect(Number(still.reserve_microusd)).toBe(25);

      // C. Create policy carrying an existing cost_policy_id → fail closed.
      const pol = ctx.service.cost.upsertCostPolicy(
        { business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id), period: "DAY", max_microusd: 100, hard_stop: true },
        "op",
      );
      const polDupe = await post("/api/cost-policies", {
        cost_policy_id: String(pol.cost_policy_id),
        business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id),
        period: "DAY", max_microusd: 1, hard_stop: true,
      });
      expect(polDupe.status).toBe(409);
      expect(JSON.stringify(await polDupe.json())).toContain("FAIL_CLOSED_COST_POLICY_EXISTS");
      expect(Number(ctx.store.get("cost_policy", String(pol.cost_policy_id)).max_microusd)).toBe(100);

      // Fresh policy create (no id) still works.
      const newPol = await post("/api/cost-policies", {
        business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id),
        period: "WEEK", max_microusd: 500, hard_stop: true,
      });
      expect(newPol.status).toBe(200);

      // D. CAS update with the correct expected_version succeeds.
      const profNow = ctx.store.get("cost_profile", String(prof.cost_profile_id));
      const upd = await post("/api/cost-profiles/update", {
        ref_type: "route", ref_id: "RTE_R3", billing_mode: "METERED_API", reserve_microusd: 30,
        expected_version: Number(profNow.version),
      });
      expect(upd.status).toBe(200);
      expect(Number(ctx.store.get("cost_profile", String(prof.cost_profile_id)).reserve_microusd)).toBe(30);

      // E. A stale concurrent update loses: first writer wins, second gets
      // VERSION_CONFLICT — one-winner CAS preserved.
      const vNow = Number(ctx.store.get("cost_profile", String(prof.cost_profile_id)).version);
      const w1 = await post("/api/cost-profiles/update", {
        ref_type: "route", ref_id: "RTE_R3", billing_mode: "METERED_API", reserve_microusd: 31, expected_version: vNow,
      });
      const w2 = await post("/api/cost-profiles/update", {
        ref_type: "route", ref_id: "RTE_R3", billing_mode: "METERED_API", reserve_microusd: 32, expected_version: vNow,
      });
      expect(w1.status).toBe(200);
      expect(w2.status).toBe(409);
      expect(JSON.stringify(await w2.json())).toContain("FAIL_CLOSED_VERSION_CONFLICT");
      expect(Number(ctx.store.get("cost_profile", String(prof.cost_profile_id)).reserve_microusd)).toBe(31);
    } finally {
      server.close();
    }
  });
});

describe("P13-R4.ingress: hostile remote output cannot persist broker material", () => {
  function dumpCanonical(ctx: Ctx, missionId: string) {
    return JSON.stringify({
      missions: ctx.store.list("mission"),
      tasks: ctx.store.list("task"),
      governed: ctx.store.list("governed_task"),
      executions: ctx.store.list("executor_execution"),
      intents: ctx.store.list("executor_dispatch_intent"),
      reservations: ctx.store.list("cost_reservation"),
      evidence: ctx.store.listEvidence(missionId),
      events: ctx.store.listEvents(),
    });
  }

  it("SANITIZE-R4-A: echoed capability + master + released credential are redacted, audited without the value", () => {
    const { ctx, biz } = makeBizCtx("r4san");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    secretPolicy(ctx, String(b.business_id), "openai");
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const task = taskOf(ctx, mission);
    bindTask(ctx, task);
    const mid = String(mission.mission_id);
    const tid = String(task.task_id);
    const broker = makeBroker(ctx);
    broker.upsert({ name: "openai", value: SENTINEL, domains: ["api.openai.com"], kind: "token" });

    // Legitimate scoped-capability fetch still works pre-dispatch.
    const cap = mintBrokerCapability("master-secret", {
      mission_id: mid, task_id: tid, governed_task_id: null, executor_id: "EXEC_A",
    });
    expect(ctx.control.authorizeBrokerFetch(mid, tid, "openai", cap, "master-secret").granted).toBe(true);
    const cred = broker.release("openai", { mission_id: mid, task_id: tid });
    expect(cred?.value).toBe(SENTINEL);

    // Hostile worker echoes everything it ever saw.
    a.resultPayload = {
      status: "COMPLETED",
      output: `cap=${cap} master=master-secret cred=${SENTINEL}`,
      detail: { echoed: [cap, SENTINEL] },
    };
    const routed = dispatchOne(ctx, mission);
    ctx.gate.collect_execution_result(a, String(routed.execution.execution_id));

    const dump = dumpCanonical(ctx, mid);
    expect(dump).not.toContain("bcap1.");
    expect(dump).not.toContain("master-secret");
    expect(dump).not.toContain(SENTINEL);
    const exec = ctx.store.get("executor_execution", String(routed.execution.execution_id));
    expect(JSON.stringify(exec.result)).toContain("[REDACTED:BROKER_CAPABILITY]");
    expect(JSON.stringify(exec.result)).toContain("[REDACTED:SECRET_MATERIAL]");

    // Redaction audit: counts only — never the raw material.
    const redacted = ctx.store
      .listEvidence(mid)
      .filter((e) => (e.payload as Record<string, unknown>).kind === "REMOTE_RESULT_REDACTED");
    expect(redacted.length).toBe(1);
    const payload = (redacted[0].payload as Record<string, unknown>).payload as Record<string, unknown>;
    expect(Number(payload.capability_redactions)).toBeGreaterThanOrEqual(2);
    expect(Number(payload.secret_redactions)).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);

    // Capability remains functional and bound post-dispatch (governed id
    // now exists → remint with the real binding).
    const cap2 = mintBrokerCapability("master-secret", {
      mission_id: mid, task_id: tid,
      governed_task_id: String(routed.governed_task.governed_task_id),
      executor_id: "EXEC_A",
    });
    expect(ctx.control.authorizeBrokerFetch(mid, tid, "openai", cap2, "master-secret").granted).toBe(true);

    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  });

  it("SANITIZE-R4-B: defense-in-depth — a raw bcap reaching the store/event/evidence plane fails closed", () => {
    const { ctx, biz } = makeBizCtx("r4deep");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(b.business_id));
    const cap = mintBrokerCapability("master-secret", {
      mission_id: String(mission.mission_id), task_id: "TSK_x", governed_task_id: null, executor_id: "EXEC_A",
    });
    // Entities.
    expect(() =>
      ctx.store.put("mission", "MSN_forge", { goal: "x", note: cap }),
    ).toThrowError(/FAIL_CLOSED_SENSITIVE_MATERIAL/);
    // Evidence plane.
    expect(() =>
      ctx.store.appendEvidence(String(mission.mission_id), "X", { leaked: cap }),
    ).toThrowError(/FAIL_CLOSED_SENSITIVE_MATERIAL/);
    // Events plane.
    expect(() =>
      ctx.store.event({
        entity_type: "mission", entity_id: String(mission.mission_id),
        event_type: "X", actor: "t", metadata: { leaked: cap },
      }),
    ).toThrowError(/FAIL_CLOSED_SENSITIVE_MATERIAL/);
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  });
});

describe("P13-R4.create: atomic insert-only authority creation", () => {
  it("CREATE-R4-A: racing createCostProfile — exactly one winner, losers FAIL_CLOSED_COST_PROFILE_EXISTS, row untouched", async () => {
    const { ctx, biz } = makeBizCtx("r4cp");
    makeBiz(biz, ctx.projectId);
    const input = {
      ref_type: "route", ref_id: "RTE_RACE", billing_mode: "METERED_API",
      reserve_microusd: 42, source: "race",
    };
    const workers = 4;
    const res = await runRace(
      Array.from({ length: workers }, () => ({
        op: "costProfileCreate", dbPath: path.join(ctx.dir, "pair.db"), args: { input },
      })),
    );
    const wins = res.filter((r) => r.ok);
    const losses = res.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(workers - 1);
    for (const l of losses) {
      expect((l as { code: string }).code).toBe("FAIL_CLOSED_COST_PROFILE_EXISTS");
    }
    const stored = ctx.store.tryGet("cost_profile", String((wins[0] as { out: { reservation_id: string } }).out.reservation_id));
    expect(stored).toBeTruthy();
    expect(Number(stored!.reserve_microusd)).toBe(42);
    expect(Number(stored!.version)).toBe(1);
    // Sequential dup create also fails closed without mutating the row.
    expect(() =>
      ctx.service.cost.createCostProfile({ ...input, reserve_microusd: 999 }, "op"),
    ).toThrowError(/FAIL_CLOSED_COST_PROFILE_EXISTS/);
    expect(Number(ctx.store.get("cost_profile", String(stored!.cost_profile_id)).reserve_microusd)).toBe(42);
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  });

  it("CREATE-R4-B: racing createCostPolicy on a supplied identity — one winner at that exact id", async () => {
    const { ctx, biz } = makeBizCtx("r4pol");
    const b = makeBiz(biz, ctx.projectId);
    const input = {
      cost_policy_id: "CPO_SUPPLIED_RACE",
      business_id: String(b.business_id), scope_type: "business", scope_id: String(b.business_id),
      period: "DAY", max_microusd: 100, hard_stop: true,
    };
    const workers = 3;
    const res = await runRace(
      Array.from({ length: workers }, () => ({
        op: "costPolicyCreate", dbPath: path.join(ctx.dir, "pair.db"), args: { input },
      })),
    );
    const wins = res.filter((r) => r.ok);
    const losses = res.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect((wins[0] as { out: { reservation_id: string } }).out.reservation_id).toBe("CPO_SUPPLIED_RACE");
    for (const l of losses) {
      expect((l as { code: string }).code).toBe("FAIL_CLOSED_COST_POLICY_EXISTS");
    }
    const stored = ctx.store.get("cost_policy", "CPO_SUPPLIED_RACE");
    expect(Number(stored.max_microusd)).toBe(100);
    expect(Number(stored.version)).toBe(1);
    // A fresh supplied id is honored exactly — never silently replaced.
    const p2 = ctx.service.cost.createCostPolicy({ ...input, cost_policy_id: "CPO_OTHER_OK" }, "op");
    expect(String(p2.cost_policy_id)).toBe("CPO_OTHER_OK");
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  });
});

describe("P13-R5.restart: sanitizer protection survives process restart", () => {
  const RESTART_CRED = "restart-vault-secret-7d2f";

  it("RESTART-R5: fresh process loads existing vault at broker ctor and redacts an echoed credential", async () => {
    const { ctx } = makeBizCtx("r5rs");
    const vaultPath = path.join(ctx.dir, "vault.json");
    // Simulate a previous process's vault: write it directly — the test
    // process never touches the value through any broker call, and the
    // worker below starts with an EMPTY sensitive-material Set (fresh
    // module registry), proving restart re-registration at ctor.
    fs.writeFileSync(
      vaultPath,
      JSON.stringify({
        credentials: {
          api: { name: "api", value: RESTART_CRED, domains: ["api.x"], kind: "token", updated_at: "t" },
        },
      }),
      { mode: 0o600 },
    );
    const hostile = `echo ${RESTART_CRED} tail`;
    const res = await runRace([
      {
        op: "restartSanitize",
        dbPath: path.join(ctx.dir, "pair.db"),
        args: { vaultPath, executionId: "EXEC_restart_1", hostile },
      },
    ]);
    expect(res[0].ok).toBe(true);
    const dump = (res[0] as { out: { dump: string } }).out.dump;
    expect(dump).not.toContain(RESTART_CRED);
    expect(dump).toContain("[REDACTED:SECRET_MATERIAL]");
    expect(dump).toContain("REMOTE_RESULT_REDACTED");
  });

  it("SHORT-R5: broker enforces the documented minimum credential length at install and load", () => {
    const { ctx } = makeBizCtx("r5short");
    const vaultPath = path.join(ctx.dir, "vault.json");
    const broker = new CredentialBroker({ vaultPath });
    // Below the minimum → rejected at install, never silently accepted.
    expect(() =>
      broker.upsert({ name: "short", value: "abc1234", domains: [], kind: "token" }),
    ).toThrowError(/FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT/);
    // Exactly at the minimum → accepted, protected by the sanitizer.
    broker.upsert({ name: "ok", value: "cv8chars", domains: [], kind: "token" });
    const out = sanitizeUntrustedRemote({ output: "leak cv8chars end" });
    expect(JSON.stringify(out.value)).not.toContain("cv8chars");
    expect(JSON.stringify(out.value)).toContain("[REDACTED:SECRET_MATERIAL]");
    // A legacy vault holding a sub-minimum value fails closed at load —
    // it can never slip under sanitizer coverage.
    fs.writeFileSync(
      vaultPath,
      JSON.stringify({
        credentials: { old: { name: "old", value: "tiny", domains: [], kind: "token", updated_at: "t" } },
      }),
    );
    expect(() => broker.list()).toThrowError(/FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT/);
    expect(() => new CredentialBroker({ vaultPath })).toThrowError(/FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT/);
  });
});

describe("P13-R6.lifecycle: retired credentials stay redaction-protected across restart", () => {
  const OLD = "secret-old-a1b2c3";
  const NEW = "secret-new-x9y8z7";
  const DEL = "secret-del-q5w6e7";

  const collect = async (
    tag: string,
    args: Record<string, unknown>,
  ): Promise<{ dump: string; release_ok: boolean | null }> => {
    const { ctx } = makeBizCtx(tag);
    const res = await runRace([
      { op: "restartSanitize", dbPath: path.join(ctx.dir, "pair.db"), args },
    ]);
    expect(res[0].ok).toBe(true);
    return res[0].out as { dump: string; release_ok: boolean | null };
  };

  it("ROTATE-R6: fresh process redacts a retired value echoed by a stale execution; new value stays releasable", async () => {
    const { ctx } = makeBizCtx("r6rot");
    const vaultPath = path.join(ctx.dir, "vault.json");
    // Process A: install + rotate — the old value is retired in the vault.
    const setup = await runRace([
      {
        op: "vaultSetup",
        dbPath: path.join(ctx.dir, "pair.db"),
        args: { vaultPath, name: "api", oldValue: OLD, newValue: NEW, mode: "rotate" },
      },
    ]);
    expect(setup[0].ok).toBe(true);
    // Process B (fresh registry): NO upsert/release before the hostile echo.
    const { dump, release_ok } = await collect("r6rot2", {
      vaultPath,
      executionId: "EXEC_rot_1",
      hostile: `tail ${OLD} end`,
      releaseName: "api",
      expectRelease: true,
      newValue: NEW,
      retiredValue: OLD,
    });
    expect(dump).not.toContain(OLD);
    expect(dump).not.toContain(NEW);
    expect(dump).toContain("[REDACTED:SECRET_MATERIAL]");
    expect(release_ok).toBe(true); // NEW releasable, OLD unreachable
  });

  it("DELETE-R6: fresh process redacts a deleted value; deleted credential is not releasable", async () => {
    const { ctx } = makeBizCtx("r6del");
    const vaultPath = path.join(ctx.dir, "vault.json");
    const setup = await runRace([
      {
        op: "vaultSetup",
        dbPath: path.join(ctx.dir, "pair.db"),
        args: { vaultPath, name: "api", oldValue: DEL, mode: "delete" },
      },
    ]);
    expect(setup[0].ok).toBe(true);
    const { dump, release_ok } = await collect("r6del2", {
      vaultPath,
      executionId: "EXEC_del_1",
      hostile: `tail ${DEL} end`,
      releaseName: "api",
      expectRelease: false,
    });
    expect(dump).not.toContain(DEL);
    expect(dump).toContain("[REDACTED:SECRET_MATERIAL]");
    expect(release_ok).toBe(true); // release("api") === null
  });

  it("VAULT-INVALID-R6: malformed or inconsistent vault fails closed at construction", () => {
    const { ctx } = makeBizCtx("r6bad");
    const vaultPath = path.join(ctx.dir, "vault.json");
    // Malformed JSON.
    fs.writeFileSync(vaultPath, "{not json!!", { mode: 0o600 });
    expect(() => new CredentialBroker({ vaultPath })).toThrowError(/FAIL_CLOSED_CREDENTIAL_VAULT_INVALID/);
    // Malformed credential record (missing value).
    fs.writeFileSync(vaultPath, JSON.stringify({ credentials: { a: { name: "a" } } }), { mode: 0o600 });
    expect(() => new CredentialBroker({ vaultPath })).toThrowError(/FAIL_CLOSED_CREDENTIAL_VAULT_INVALID/);
    // Invalid retired record.
    fs.writeFileSync(
      vaultPath,
      JSON.stringify({ credentials: {}, retired: [{ name: "r", value: "long-enough-value" }] }),
      { mode: 0o600 },
    );
    expect(() => new CredentialBroker({ vaultPath })).toThrowError(/FAIL_CLOSED_CREDENTIAL_VAULT_INVALID/);
    // Wrong top-level shape.
    fs.writeFileSync(vaultPath, JSON.stringify([1, 2, 3]), { mode: 0o600 });
    expect(() => new CredentialBroker({ vaultPath })).toThrowError(/FAIL_CLOSED_CREDENTIAL_VAULT_INVALID/);
  });
});
