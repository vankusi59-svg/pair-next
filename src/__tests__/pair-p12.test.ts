/**
 * P12 AGENT EXECUTION CONTRACT tests — the mandate §20 matrix.
 *
 *  A. contract lifecycle (materialize/create/update/disable/inspect + events)
 *  B. legacy agents materialize a baseline contract (audit, no narrowing)
 *  C. business isolation (contract↔agent business, mission cross-business)
 *  D. capability enforcement (allow-list, missing, deny-wins, unknown cap)
 *  E. agent/contract status fail-closed (PAUSED agent, DISABLED contract)
 *  F. executor policy (allowed/denied/preferred/fallback/empty-set)
 *  G. provider/model route policy (preferred/denied/restricted/fallback)
 *  H. project scope (allowed_project_ids deny + revoke mid-flight)
 *  I. provenance pin (contract id+version+digest, digest tamper, future pin)
 *  J. revocation semantics (tightening revokes in-flight; expansion cannot
 *     retro-broaden a pinned mission — pinned ∩ current)
 *  K. planner is advisory — the GATE is authoritative (planner emits a
 *     denied capability → still denied)
 *  L. genuine worker_threads CAS race on contract update — one winner,
 *     one FAIL_CLOSED_VERSION_CONFLICT, integrity clean
 *  M. context-scope gating in openWorkItem goal construction
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  AgentContractService,
  ApprovalQueue,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
  contractDigest,
  digest,
  normalizeContractPolicy,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p12-"));
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
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.tasks[eid] = task;
    return {
      execution_id: eid,
      status: "COMPLETED",
      run_root: null,
      workspace: task.workspace,
    };
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
      status: "COMPLETED",
      summary: "ok",
      execution_id: executionId,
      mission_id: t.mission_id,
      task_id: t.task_id,
      governed_task_id: t.governed_task_id,
      artifacts: [],
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
  plannerCalls: Array<Record<string, unknown>>;
  projectId: string;
}

function makeCtx(name: string, opts: { planner?: PlannerFn } = {}): Ctx {
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
  const project = service.createProject({ name, root_location: workspace });
  return { dir, workspace, store, service, gate, registry, router, control, adapters, plannerCalls, projectId: String(project.project_id) };
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter, opts: { caps?: string[]; priority?: number } = {}) {
  const caps = opts.caps ?? ALL_CAPS;
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

function makeBizCtx(name: string, opts: { planner?: PlannerFn } = {}) {
  const ctx = makeCtx(name, opts);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz, schedules };
}

function makeBiz(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

/** Start an agent-bound mission and commit a plan with the given task caps. */
function boundMission(
  ctx: Ctx,
  agentId: string,
  businessId: string,
  caps: string[] = ["FILE_OPERATIONS"],
) {
  const mission = ctx.control.startMission({
    goal: "g",
    project_id: ctx.projectId,
    operator_id: "op",
    metadata: { business_id: businessId, org_agent_id: agentId },
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
        required_capabilities: caps,
        depends_on: [],
      },
    ],
    proposal: { tasks: [] },
  });
  return { mission: ctx.service.getMission(missionId), commit };
}

/** Build the governed-task request the runtime would send for task 0. */
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

function contractEvents(store: PairEvidenceStore, type: string, agentId?: string) {
  return store
    .listEvents("agent_execution_contract")
    .filter((e) => e.event_type === type && (agentId ? e.metadata?.org_agent_id === agentId : true));
}

/** AGENT_EXECUTION_DENIED events are emitted on the org_agent entity. */
function denialEvents(store: PairEvidenceStore, agentId?: string) {
  return store
    .listEvents("org_agent")
    .filter((e) => e.event_type === "AGENT_EXECUTION_DENIED" && (agentId ? e.entity_id === agentId : true));
}

/** Extra route + binding on an EXISTING executor (route selection is per-executor). */
function addRoute(ctx: Ctx, routeId: string, executorId: string, priority: number, caps: string[] = ALL_CAPS) {
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: caps,
    priority,
    executor_hint: executorId,
  });
  ctx.service.routes.registerBinding({
    executor_id: executorId,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: caps,
  });
}

/* ============================ A. lifecycle ================================ */

describe("P12.A contract lifecycle", () => {
  it("createOrgAgent auto-materializes a baseline contract + MATERIALIZED event", () => {
    const { ctx, biz } = makeBizCtx("a1");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const contract = biz.getAgentContract(String(a.agent_id));
    expect(contract).not.toBeNull();
    expect(String(contract!.status)).toBe("ACTIVE");
    expect(Number(contract!.contract_version)).toBe(1);
    expect(String(contract!.business_id)).toBe(String(b.business_id));
    expect(contract!.contract_digest).toMatch(/^[0-9a-f]{64}$/);
    // baseline: no allow-list narrowing, project pinned to the business's own
    const policy = contract!.policy as Record<string, unknown>;
    expect(policy.allowed_capabilities).toBeNull();
    expect(policy.allowed_executor_ids).toBeNull();
    expect(policy.allowed_project_ids).toEqual([ctx.projectId]);
    const ev = contractEvents(ctx.store, "AGENT_EXECUTION_CONTRACT_MATERIALIZED", String(a.agent_id));
    expect(ev.length).toBe(1);
  });

  it("update under correct version bumps contract_version + re-digests + UPDATED event", () => {
    const { ctx, biz } = makeBizCtx("a2");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const v1 = biz.getAgentContract(aid)!;
    const updated = biz.upsertAgentContract(aid, "op", { allowed_capabilities: ["FILE_OPERATIONS"] }, Number(v1.version));
    expect(Number(updated.contract_version)).toBe(2);
    expect(String(updated.contract_digest)).not.toBe(String(v1.contract_digest));
    expect(contractEvents(ctx.store, "AGENT_EXECUTION_CONTRACT_UPDATED", aid).length).toBe(1);
  });

  it("update under stale version fails closed VERSION_CONFLICT", () => {
    const { ctx, biz } = makeBizCtx("a3");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    biz.upsertAgentContract(aid, "op", { denied_capabilities: ["SHELL_EXECUTION"] });
    // the first update consumed version → same stale version now loses
    expect(() =>
      biz.upsertAgentContract(aid, "op", { denied_capabilities: [] }, 0),
    ).toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
  });

  it("disable/enable flips status + emits events; inspect returns resolved view", () => {
    const { ctx, biz } = makeBizCtx("a4");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const dis = biz.setAgentContractStatus(aid, "DISABLED", "op");
    expect(String(dis.status)).toBe("DISABLED");
    const en = biz.setAgentContractStatus(aid, "ACTIVE", "op");
    expect(String(en.status)).toBe("ACTIVE");
    expect(contractEvents(ctx.store, "AGENT_EXECUTION_CONTRACT_DISABLED", aid).length).toBe(1);
    const view = biz.inspectAgentPolicy(aid);
    expect(String(view.agent_status)).toBe("ACTIVE");
    expect(String(view.status)).toBe("ACTIVE");
    expect(view.contract_version).toBe(1);
  });

  it("unknown capability in policy fails closed at write time", () => {
    const { ctx, biz } = makeBizCtx("a5");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    expect(() =>
      biz.upsertAgentContract(String(a.agent_id), "op", { allowed_capabilities: ["INVENTED_CAP"] }),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_UNKNOWN/);
  });
});

/* ========================= B. legacy agents =============================== */

describe("P12.B legacy materialization", () => {
  it("org_agent row without a contract gets a baseline on first mission pin", () => {
    const { ctx, biz } = makeBizCtx("b1");
    const b = makeBiz(biz, ctx.projectId);
    // Simulate a pre-P12 agent: raw store row, no contract materialization.
    const agentId = "AGT_legacy1";
    ctx.store.put(
      "org_agent",
      agentId,
      {
        agent_id: agentId,
        business_id: String(b.business_id),
        title: "legacy",
        department: "eng",
        role: "",
        status: "ACTIVE",
        reports_to: null,
        executor_binding: null,
        context_notes: [],
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      },
      0,
    );
    expect(biz.getAgentContract(agentId)).toBeNull();
    const mission = ctx.control.startMission({
      goal: "g",
      project_id: ctx.projectId,
      operator_id: "op",
      metadata: { business_id: String(b.business_id), org_agent_id: agentId },
    });
    const contract = biz.getAgentContract(agentId);
    expect(contract).not.toBeNull();
    expect(contractEvents(ctx.store, "AGENT_EXECUTION_CONTRACT_MATERIALIZED", agentId).length).toBe(1);
    // mission carries the pin
    const md = mission.metadata as Record<string, unknown>;
    const pin = md.agent_contract as Record<string, unknown>;
    expect(String(pin.org_agent_id)).toBe(agentId);
    expect(String(pin.contract_id)).toBe(String(contract!.contract_id));
    expect(Number(pin.contract_version)).toBe(1);
    expect(pin.contract_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ======================= C. business isolation ============================ */

describe("P12.C business isolation", () => {
  it("agent bound to a mission of another business fails closed at pin", () => {
    const { ctx, biz } = makeBizCtx("c1");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const a = biz.createOrgAgent({ business_id: String(b1.business_id), title: "eng", department: "eng", operator_id: "op" });
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: String(b2.business_id), org_agent_id: String(a.agent_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_BUSINESS_MISMATCH/);
  });

  it("forged contract row with wrong business fails closed", () => {
    const { ctx, biz } = makeBizCtx("c2");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const a = biz.createOrgAgent({ business_id: String(b1.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    // Tamper: point the contract at the other business.
    const svc = new AgentContractService(ctx.store);
    const row = svc.get(aid)!;
    row.business_id = String(b2.business_id);
    ctx.store.put("agent_execution_contract", String(row.contract_id), row, Number(row.version));
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: String(b1.business_id), org_agent_id: aid },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_SCOPE/);
  });
});

/* ===================== D. capability enforcement ========================== */

describe("P12.D capability enforcement at the gate", () => {
  it("allowed capability routes and dispatches", () => {
    const { ctx, biz } = makeBizCtx("d1");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(a.agent_id), "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id), ["FILE_OPERATIONS"]);
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_A");
  });

  it("capability outside the allow-list fails closed + audited", () => {
    const { ctx, biz } = makeBizCtx("d2");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(a.agent_id), "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id), ["SHELL_EXECUTION"]);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
    const denials = denialEvents(ctx.store, String(a.agent_id));
    expect(denials.length).toBe(1);
    expect(String(denials[0].metadata?.reason)).toBe("FAIL_CLOSED_AGENT_CAPABILITY_DENIED");
    expect(String(denials[0].metadata?.detail)).toContain("SHELL_EXECUTION");
    expect(denials[0].metadata?.contract_version).toBe(2);
  });

  it("explicit deny wins over allow", () => {
    const { ctx, biz } = makeBizCtx("d3");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(a.agent_id), "op", {
      allowed_capabilities: ["FILE_OPERATIONS", "SHELL_EXECUTION"],
      denied_capabilities: ["SHELL_EXECUTION"],
    });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id), ["SHELL_EXECUTION"]);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
    const denials = denialEvents(ctx.store);
    expect(String(denials[0].metadata?.detail)).toContain("explicit-deny");
  });

  it("capability not in the global registry fails closed even with null allow-list", () => {
    const { ctx, biz } = makeBizCtx("d4");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter, { caps: ["FILE_OPERATIONS", "INVENTED_CAP"] });
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    // baseline contract (null allow-list) — the GATE still requires the
    // capability ⊆ adapter caps AND registered: global registry wins.
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id), ["INVENTED_CAP"]);
    // adapter claims it, but the PAIR capability registry does not →
    // pre-existing gate check FAIL_CLOSED_CAPABILITY_UNKNOWN.
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED/);
  });
});

/* ======================= E. status fail-closed ============================ */

describe("P12.E status enforcement", () => {
  it("PAUSED agent cannot start a bound mission", () => {
    const { ctx, biz } = makeBizCtx("e1");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.setOrgAgentStatus(String(a.agent_id), "PAUSED", "op");
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: String(b.business_id), org_agent_id: String(a.agent_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_INACTIVE/);
  });

  it("DISABLED contract fails closed at the gate even with ACTIVE agent", () => {
    const { ctx, biz } = makeBizCtx("e2");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const { mission } = boundMission(ctx, aid, String(b.business_id));
    biz.setAgentContractStatus(aid, "DISABLED", "op");
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_DISABLED/);
    const denials = denialEvents(ctx.store, aid);
    expect(denials.length).toBe(1);
    expect(String(denials[0].metadata?.reason)).toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
  });

  it("PAUSED mid-mission: gate re-checks status and denies in-flight task", () => {
    const { ctx, biz } = makeBizCtx("e3");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const { mission } = boundMission(ctx, aid, String(b.business_id));
    biz.setOrgAgentStatus(aid, "PAUSED", "op");
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_INACTIVE/);
  });
});

/* ======================= F. executor policy =============================== */

describe("P12.F executor policy", () => {
  function twoExecs(ctx: Ctx) {
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a, { priority: 90 }); // worse priority
    registerScripted(ctx, b, { priority: 10 }); // better priority
    return { a, b };
  }

  it("contract preferred executor wins over routing priority", () => {
    const { ctx, biz } = makeBizCtx("f1");
    const { a } = twoExecs(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { preferred_executor_ids: ["EXEC_A"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_A");
    expect(a.dispatched.length).toBe(1);
  });

  it("allowed_executor_ids narrows the candidate set — denied executor never picked", () => {
    const { ctx, biz } = makeBizCtx("f2");
    twoExecs(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { allowed_executor_ids: ["EXEC_B"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_B");
  });

  it("denied_executor_ids removes it even when allowed", () => {
    const { ctx, biz } = makeBizCtx("f3");
    twoExecs(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      allowed_executor_ids: ["EXEC_A", "EXEC_B"],
      denied_executor_ids: ["EXEC_B"],
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_A");
  });

  it("no eligible executor fails closed", () => {
    const { ctx, biz } = makeBizCtx("f4");
    twoExecs(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { allowed_executor_ids: ["EXEC_GHOST"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/);
  });

  it("unavailable preferred + fallback allowed → next eligible serves", () => {
    const { ctx, biz } = makeBizCtx("f5");
    const { a } = twoExecs(ctx);
    a.available = false;
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { preferred_executor_ids: ["EXEC_A"], executor_fallback_allowed: true });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_B");
  });
});

/* ==================== G. provider/model route policy ====================== */

describe("P12.G provider/model route policy", () => {
  it("preferred_route_ids selects the preferred route despite lower priority", () => {
    const { ctx, biz } = makeBizCtx("g1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a, { priority: 10 });
    addRoute(ctx, "RTE_A_ALT", "EXEC_A", 90);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { preferred_route_ids: ["RTE_A_ALT"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    const dec = ctx.store.list("route_decision").at(-1)!;
    expect(String(dec.selected_route_id)).toBe("RTE_A_ALT");
    expect(((dec.agent_route_policy as Record<string, unknown>)?.preferred as string[]) ?? []).toEqual(["RTE_A_ALT"]);
  });

  it("denied_route_ids hard-rejects the route", () => {
    const { ctx, biz } = makeBizCtx("g2");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a, { priority: 10 });
    addRoute(ctx, "RTE_A_ALT", "EXEC_A", 90);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", { denied_route_ids: ["RTE_A_ALT"] });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    const dec = ctx.store.list("route_decision").at(-1)!;
    expect(String(dec.selected_route_id)).toBe("RTE_EXEC_A");
    const rejected = dec.hard_rejections as Array<Record<string, unknown>>;
    expect(
      rejected.some(
        (r) =>
          String(r.route_id) === "RTE_A_ALT" &&
          (r.reason_codes as string[]).includes("AGENT_CONTRACT_ROUTE_DENIED"),
      ),
    ).toBe(true);
  });

  it("route_fallback_allowed=false restricts to preferred — non-eligible preferred fails closed", () => {
    const { ctx, biz } = makeBizCtx("g3");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a, { priority: 10 });
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      preferred_route_ids: ["RTE_GHOST"],
      route_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
  });

  it("route_fallback_allowed=true with unknown preferred falls back to eligible", () => {
    const { ctx, biz } = makeBizCtx("g4");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a, { priority: 10 });
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      preferred_route_ids: ["RTE_GHOST"],
      route_fallback_allowed: true,
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    const dec = ctx.store.list("route_decision").at(-1)!;
    expect(String(dec.selected_route_id)).toBe("RTE_EXEC_A");
  });
});

/* ======================== H. project scope ================================ */

describe("P12.H project scope", () => {
  it("mission outside allowed_project_ids fails closed at pin", () => {
    const { ctx, biz } = makeBizCtx("h1");
    const other = ctx.service.createProject({ name: "other", root_location: fs.mkdtempSync(path.join(ctx.dir, "ws2-")) });
    const b = makeBiz(biz, String(other.project_id));
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    // baseline allows only the business's own project — mission on the
    // first project is out of scope.
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: String(b.business_id), org_agent_id: String(a.agent_id) },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_PROJECT_DENIED/);
  });

  it("revoking project scope mid-flight denies at the gate", () => {
    const { ctx, biz } = makeBizCtx("h2");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const { mission } = boundMission(ctx, aid, String(b.business_id));
    biz.upsertAgentContract(aid, "op", { allowed_project_ids: ["PRJ_no"] });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_PROJECT_DENIED/);
  });
});

/* ===================== I. provenance pin ================================== */

describe("P12.I provenance pin", () => {
  it("pin captures contract id+version+digest; a later update does NOT rewrite it", () => {
    const { ctx, biz } = makeBizCtx("i1");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const { mission } = boundMission(ctx, aid, String(b.business_id));
    const pin = (mission.metadata as Record<string, unknown>).agent_contract as Record<string, unknown>;
    expect(Number(pin.contract_version)).toBe(1);
    const digestV1 = String(pin.contract_digest);
    biz.upsertAgentContract(aid, "op", { denied_capabilities: ["NETWORK_ACCESS"] });
    const pinned = (ctx.service.getMission(String(mission.mission_id)).metadata as Record<string, unknown>).agent_contract as Record<string, unknown>;
    expect(Number(pinned.contract_version)).toBe(1); // history immutable
    expect(String(pinned.contract_digest)).toBe(digestV1);
    // but the live contract moved to v2
    expect(Number(biz.getAgentContract(aid)!.contract_version)).toBe(2);
  });

  it("tampered pinned digest fails closed at the gate", () => {
    const { ctx, biz } = makeBizCtx("i2");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id));
    const row = ctx.store.get("mission", String(mission.mission_id));
    const md = row.metadata as Record<string, unknown>;
    (md.agent_contract as Record<string, unknown>).contract_digest = "0".repeat(64);
    ctx.store.put("mission", String(mission.mission_id), row, Number(row.version));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_DIGEST/);
  });

  it("pin claiming a future version fails closed as invalid provenance", () => {
    const { ctx, biz } = makeBizCtx("i3");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id));
    const row = ctx.store.get("mission", String(mission.mission_id));
    const md = row.metadata as Record<string, unknown>;
    const pin = md.agent_contract as Record<string, unknown>;
    pin.contract_version = 99;
    // keep digest consistent with the forged policy so only the version
    // check can catch it
    pin.contract_digest = digest({
      schema: pin.schema_version,
      contract_id: pin.contract_id,
      org_agent_id: pin.org_agent_id,
      business_id: pin.business_id,
      contract_version: pin.contract_version,
      policy: pin.policy,
    });
    ctx.store.put("mission", String(mission.mission_id), row, Number(row.version));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE/);
  });
});

/* ==================== J. revocation semantics ============================= */

describe("P12.J revocation semantics", () => {
  it("tightening the contract revokes in-flight mission authority", () => {
    const { ctx, biz } = makeBizCtx("j1");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const { mission } = boundMission(ctx, aid, String(b.business_id), ["SHELL_EXECUTION"]);
    // baseline allowed it; now tighten
    biz.upsertAgentContract(aid, "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
  });

  it("expansion never retro-broadens a pinned mission (pinned ∩ current)", () => {
    const { ctx, biz } = makeBizCtx("j2");
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    // V2 contract: explicitly deny SHELL_EXECUTION
    biz.upsertAgentContract(aid, "op", { denied_capabilities: ["SHELL_EXECUTION"] });
    const { mission } = boundMission(ctx, aid, String(b.business_id), ["SHELL_EXECUTION"]);
    // V3 contract: expand — remove the deny entirely
    biz.upsertAgentContract(aid, "op", { denied_capabilities: [] });
    // pinned V2 deny ∪ current V3 deny → still denied: expansion can't
    // retro-broaden a mission pinned under tighter policy.
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
  });
});

/* ==================== K. planner is not authority ========================= */

describe("P12.K planner cannot bypass the gate", () => {
  it("planner-emitted denied capability is still denied at routing", () => {
    const { ctx, biz } = makeBizCtx("k1", {
      planner: () => ({
        tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["SHELL_EXECUTION"], depends_on: [] }],
      }),
    });
    const adapter = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, adapter);
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(a.agent_id), "op", { denied_capabilities: ["SHELL_EXECUTION"] });
    const { mission } = boundMission(ctx, String(a.agent_id), String(b.business_id), ["SHELL_EXECUTION"]);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
  });
});

/* ==================== M. context scope gating ============================= */

describe("P12.M context scopes", () => {
  it("allowed_context_scopes gates business/agent context injection", () => {
    const { ctx, biz } = makeBizCtx("m1");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({
      business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op",
    });
    const aid = String(a.agent_id);
    // seed one outcome note
    const svc = new AgentContractService(ctx.store);
    svc.resolve(aid); // contract exists already from createOrgAgent
    const agentRow = ctx.store.get("org_agent", aid);
    agentRow.context_notes = [{ at: utcnow(), note: "shipped X" }];
    ctx.store.put("org_agent", aid, agentRow, Number(agentRow.version));

    const w = biz.createWorkItem({ business_id: String(b.business_id), title: "w", goal: "goal-body", operator_id: "op" });
    biz.assignWorkItem(String(w.work_item_id), aid, "op");
    // remove both context scopes
    biz.upsertAgentContract(aid, "op", { allowed_context_scopes: ["project"] });
    biz.openWorkItem(String(w.work_item_id), "op");
    const mission = ctx.store.list("mission")[0];
    expect(String(mission.goal)).not.toContain("BUSINESS");
    expect(String(mission.goal)).not.toContain("AGENT CONTEXT");
    expect(String(mission.goal)).toContain("goal-body");
  });
});

/* ===================== L. worker CAS race ================================= */

const CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p12");
const BUNDLE = path.join(CACHE, "pair-bundle.mjs");
const WORKER_FILE = path.join(CACHE, "p12-worker.mjs");

const WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, args, barrier } = workerData;

try {
  if (op === "contractUpdate") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const svc = new PAIR.AgentContractService(store);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const row = svc.update(args.agentId, args.patch, args.expectedVersion, "worker");
    parentPort.postMessage({ ok: true, out: { contract_version: Number(row.contract_version) } });
  } else if (op === "dispatchRecover") {
    // Independent stack on the same db: proven-external-dispatch recovery.
    const store = new PAIR.PairEvidenceStore(dbPath);
    const service = new PAIR.PairControlPlane(store);
    const gate = new PAIR.GovernedTaskGate(service);
    const adapter = {
      executor_id: args.executorId,
      probe() { return { executor_id: args.executorId, available: true, state: "READY" }; },
      qualify() { return { qualified: true, dispatch_enabled: true }; },
      capabilities() { return { capability_ids: [] }; },
      prepare_task(t) { return t; },
      dispatch() { throw new Error("MUST_NOT_DISPATCH_AGAIN"); },
      observe() { return { status: "RUNNING" }; },
      cancel() { return { status: "CANCELLED" }; },
      collect_result(executionId) {
        const exec = new PAIR.PairEvidenceStore(dbPath).get("executor_execution", executionId);
        return {
          status: "COMPLETED",
          execution_id: executionId,
          governed_task_id: exec.governed_task_id,
          mission_id: exec.mission_id,
          task_id: exec.task_id,
          artifacts: [],
        };
      },
      collect_artifacts() { return []; },
      health() { return { state: "READY" }; },
      dispatch_evidence() { return { dispatched: true, execution_id: args.evidenceExecId }; },
    };
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    const exec = gate.dispatch_governed_task(adapter, args.governedTaskId);
    parentPort.postMessage({ ok: true, out: { execution_id: String(exec.execution_id) } });
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
  execFileSync(process.execPath, [
    esbuild,
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(WORKER_FILE, WORKER_SOURCE);
}

type RaceOutcome =
  | { ok: true; out: { contract_version?: number; execution_id?: string } }
  | { ok: false; code: string; message: string };

async function runRace(
  ops: Array<{ op: string; dir: string; dbPath: string; args: Record<string, unknown> }>,
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
            workerData: { op: o.op, dbPath: o.dbPath, dir: o.dir, barrier: gate, args: o.args },
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

describe("P12.L genuine worker_threads CAS race", () => {
  it("two workers update the same contract at the same version — one wins, one FAIL_CLOSED_VERSION_CONFLICT", async () => {
    const { ctx, biz } = makeBizCtx("l1");
    const dir = ctx.dir;
    const dbPath = path.join(dir, "pair.db");
    const b = makeBiz(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(a.agent_id);
    const current = Number(biz.getAgentContract(aid)!.version);

    const [r1, r2] = await runRace([
      { op: "contractUpdate", dir, dbPath, args: { agentId: aid, patch: { denied_capabilities: ["SHELL_EXECUTION"] }, expectedVersion: current } },
      { op: "contractUpdate", dir, dbPath, args: { agentId: aid, patch: { denied_capabilities: ["NETWORK_ACCESS"] }, expectedVersion: current } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    // exactly one contract row, bumped once
    const rows = ctx.store.list("agent_execution_contract").filter((r) => r.org_agent_id === aid);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].contract_version)).toBe(2);
    const integrity = ctx.store.verifyIntegrity() as Record<string, number>;
    expect(integrity.errors ?? 0).toBe(0);
  }, 60_000);
});

/* ============ R1 — audit defect closures ============ */

describe("P12.R1.1 executor_fallback_allowed=false is a hard restriction", () => {
  it("A. fallback=false + preferred unavailable → no eligible executor", () => {
    const { ctx, biz } = makeBizCtx("r1a");
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a);
    registerScripted(ctx, b);
    a.available = false;
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      preferred_executor_ids: ["EXEC_A"],
      executor_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR|FAIL_CLOSED/);
    expect(b.dispatched.length).toBe(0); // fallback NOT taken
  });

  it("B. fallback=false + preferred eligible → preferred executes", () => {
    const { ctx, biz } = makeBizCtx("r1b");
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a, { priority: 90 });
    registerScripted(ctx, b, { priority: 10 });
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    biz.upsertAgentContract(String(ag.agent_id), "op", {
      preferred_executor_ids: ["EXEC_A"],
      executor_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, String(ag.agent_id), String(bz.business_id));
    const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    expect(String(routed.route_decision.executor_id)).toBe("EXEC_A");
  });

  it("C. pinned no-fallback EXEC_A + current switched to EXEC_B → old mission gains nothing", () => {
    const { ctx, biz } = makeBizCtx("r1c");
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a);
    registerScripted(ctx, b);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", {
      preferred_executor_ids: ["EXEC_A"],
      executor_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    // V3: operator switches the hard restriction to B — the pinned V2
    // restriction intersects to empty: the old mission acquires neither.
    biz.upsertAgentContract(aid, "op", {
      preferred_executor_ids: ["EXEC_B"],
      executor_fallback_allowed: false,
    });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED/);
    expect(a.dispatched.length).toBe(0);
    expect(b.dispatched.length).toBe(0);
  });

  it("D. current tightening still revokes pinned no-fallback authority", () => {
    const { ctx, biz } = makeBizCtx("r1d");
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a);
    registerScripted(ctx, b);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", {
      preferred_executor_ids: ["EXEC_A"],
      executor_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    // tighten: deny A outright — pinned ∩ current restriction stays {A}
    // but denied union wins → fail closed.
    biz.upsertAgentContract(aid, "op", { denied_executor_ids: ["EXEC_A"] });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED/);
    expect(a.dispatched.length).toBe(0);
  });
});

describe("P12.R1.2 agent-bound mission without pin fails closed", () => {
  it("org_agent_id present + stripped agent_contract pin → denied, audited, no dispatch", () => {
    const { ctx, biz } = makeBizCtx("r1e");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    // strip the pin — simulates a pre-P12 in-flight agent-bound mission
    const row = ctx.store.get("mission", String(mission.mission_id));
    const md = row.metadata as Record<string, unknown>;
    delete md.agent_contract;
    ctx.store.put("mission", String(mission.mission_id), row, Number(row.version));
    const stripped = ctx.service.getMission(String(mission.mission_id));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, stripped) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_PIN_MISSING/);
    const denials = denialEvents(ctx.store, aid);
    expect(denials.length).toBe(1);
    expect(String(denials[0].metadata?.reason)).toBe("FAIL_CLOSED_AGENT_CONTRACT_PIN_MISSING");
    expect(a.dispatched.length).toBe(0);
  });
});

describe("P12.R1.3 pinned route restriction cannot be retro-broadened", () => {
  function twoRoutes(ctx: Ctx) {
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a, { priority: 10 });
    addRoute(ctx, "RTE_A_ALT", "EXEC_A", 90);
    return a;
  }

  it("A. pinned no-fallback [RTE_A] + current prefers [RTE_ALT] → old mission keeps RTE_A only", () => {
    const { ctx, biz } = makeBizCtx("r1f");
    twoRoutes(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_EXEC_A"],
      route_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    // current switches preference (fallback allowed → advisory only, no new hard set)
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_A_ALT"],
      route_fallback_allowed: true,
    });
    ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    const dec = ctx.store.list("route_decision").at(-1)!;
    // pinned hard set {RTE_EXEC_A} stands — B-preference cannot broaden it
    expect(String(dec.selected_route_id)).toBe("RTE_EXEC_A");
  });

  it("B. pinned no-fallback A + current no-fallback ALT → empty intersection → NO_ELIGIBLE_ROUTE", () => {
    const { ctx, biz } = makeBizCtx("r1g");
    twoRoutes(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_EXEC_A"],
      route_fallback_allowed: false,
    });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_A_ALT"],
      route_fallback_allowed: false,
    });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
  });

  it("C. fallback=true on both snapshots → preference is advisory reorder inside eligibility", () => {
    const { ctx, biz } = makeBizCtx("r1h");
    twoRoutes(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", { preferred_route_ids: ["RTE_EXEC_A"] });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    biz.upsertAgentContract(aid, "op", { preferred_route_ids: ["RTE_A_ALT"] });
    ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
    const dec = ctx.store.list("route_decision").at(-1)!;
    // advisory current preference wins ordering — but ALT was eligible anyway
    expect(String(dec.selected_route_id)).toBe("RTE_A_ALT");
  });

  it("D. denied route still wins over any preference", () => {
    const { ctx, biz } = makeBizCtx("r1i");
    twoRoutes(ctx);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_A_ALT"],
      route_fallback_allowed: false,
      denied_route_ids: ["RTE_A_ALT"],
    });
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
  });
});

describe("P12.R1.4 current contract row revalidation", () => {
  function tamper(store: PairEvidenceStore, agentId: string, mutate: (row: Record<string, unknown>) => void) {
    const svc = new AgentContractService(store);
    const row = svc.get(agentId)!;
    mutate(row);
    store.put("agent_execution_contract", String(row.contract_id), row, Number(row.version));
  }

  it("A. tampered policy + stale digest → fail closed at gate", () => {
    const { ctx, biz } = makeBizCtx("r1j");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamper(ctx.store, aid, (row) => {
      (row.policy as Record<string, unknown>).allowed_capabilities = ["SHELL_EXECUTION"];
      // digest left stale → no longer self-consistent
    });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_DIGEST|FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY/);
  });

  it("B. tampered digest → fail closed", () => {
    const { ctx, biz } = makeBizCtx("r1k");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamper(ctx.store, aid, (row) => {
      row.contract_digest = "f".repeat(64);
    });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED/);
  });

  it("C. wrong schema_version → fail closed", () => {
    const { ctx, biz } = makeBizCtx("r1l");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamper(ctx.store, aid, (row) => {
      row.schema_version = "evil.v0";
    });
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never, ctx.adapters),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY|FAIL_CLOSED/);
  });
});

describe("P12.R1.5 unknown policy fields fail closed", () => {
  it("typo field allowed_executor_id is rejected, not silently unrestricted", () => {
    const { ctx, biz } = makeBizCtx("r1m");
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    expect(() =>
      biz.upsertAgentContract(String(ag.agent_id), "op", { allowed_executor_id: ["EXEC_A"] } as never),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_FIELDS/);
    expect(() =>
      biz.upsertAgentContract(String(ag.agent_id), "op", { typo: 1 } as never),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_FIELDS/);
  });
});

describe("P12.R1.6 pin-time denial audit", () => {
  it("inactive agent at startMission → denial audited", () => {
    const { ctx, biz } = makeBizCtx("r1n");
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    biz.setOrgAgentStatus(aid, "PAUSED", "op");
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: String(bz.business_id), org_agent_id: aid },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_INACTIVE/);
    const denials = denialEvents(ctx.store, aid);
    expect(denials.length).toBe(1);
    expect(String(denials[0].metadata?.reason)).toBe("FAIL_CLOSED_AGENT_INACTIVE");
  });

  it("project denied at startMission → denial audited", () => {
    const { ctx, biz } = makeBizCtx("r1o");
    const other = ctx.service.createProject({ name: "o", root_location: fs.mkdtempSync(path.join(ctx.dir, "ws2-")) });
    const bz = makeBiz(biz, String(other.project_id));
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    expect(() =>
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId, // not the business project → out of scope
        operator_id: "op",
        metadata: { business_id: String(bz.business_id), org_agent_id: aid },
      }),
    ).toThrowError(/FAIL_CLOSED_AGENT_PROJECT_DENIED/);
    const denials = denialEvents(ctx.store, aid);
    expect(denials.length).toBe(1);
    expect(String(denials[0].metadata?.reason)).toBe("FAIL_CLOSED_AGENT_PROJECT_DENIED");
  });
});

/* ============ R2 — crash/restart pre-dispatch authority ============ */

/** Persist a governed task in VALIDATED state — bound executor+route, no dispatch. */
function persistValidated(
  ctx: Ctx,
  mission: Record<string, unknown>,
  adapter: ScriptedAdapter,
  opts: { routeId?: string } = {},
) {
  const task = ctx.service.listTasks(String(mission.mission_id))[0];
  ctx.service.updateTask(String(task.task_id), {
    selected_executor: adapter.executor_id,
    selected_route_id: opts.routeId ?? `RTE_${adapter.executor_id}`,
    status: "ROUTED",
  });
  const { governed_task } = ctx.gate.create_governed_task(
    adapter,
    govRequest(ctx, ctx.service.getMission(String(mission.mission_id))),
  );
  return governed_task;
}

describe("P12.R2 crash/restart — final pre-dispatch authority", () => {
  it("A. capability revoked after VALIDATED → adopted task cannot dispatch", () => {
    const { ctx, biz } = makeBizCtx("r2a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id), ["SHELL_EXECUTION"]);
    persistValidated(ctx, mission, a);
    // V2 revokes the capability — restart + adoption must fail closed.
    biz.upsertAgentContract(aid, "op", { denied_capabilities: ["SHELL_EXECUTION"] });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_CAPABILITY_DENIED/);
    expect(a.dispatched.length).toBe(0);
    expect(
      denialEvents(ctx.store, aid).some((e) => String(e.metadata?.reason) === "FAIL_CLOSED_AGENT_CAPABILITY_DENIED"),
    ).toBe(true);
  });

  it("B. executor revoked after VALIDATED → adopted task cannot dispatch", () => {
    const { ctx, biz } = makeBizCtx("r2b");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    persistValidated(ctx, mission, a);
    biz.upsertAgentContract(aid, "op", { denied_executor_ids: ["EXEC_A"] });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_EXECUTOR_DENIED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("C. hard executor restriction switched to EXEC_B → old EXEC_A-bound task cannot dispatch", () => {
    const { ctx, biz } = makeBizCtx("r2c");
    const a = new ScriptedAdapter("EXEC_A");
    const b = new ScriptedAdapter("EXEC_B");
    registerScripted(ctx, a);
    registerScripted(ctx, b);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    persistValidated(ctx, mission, a);
    biz.upsertAgentContract(aid, "op", {
      preferred_executor_ids: ["EXEC_B"],
      executor_fallback_allowed: false,
    });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_EXECUTOR_DENIED/);
    expect(a.dispatched.length).toBe(0);
    expect(b.dispatched.length).toBe(0);
  });

  it("D. route revoked after VALIDATED → adopted task cannot dispatch on denied route", () => {
    const { ctx, biz } = makeBizCtx("r2d");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    persistValidated(ctx, mission, a, { routeId: "RTE_EXEC_A" });
    biz.upsertAgentContract(aid, "op", { denied_route_ids: ["RTE_EXEC_A"] });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_ROUTE_DENIED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("E. hard route restriction switched to RTE_ALT → RTE_A-bound task cannot dispatch", () => {
    const { ctx, biz } = makeBizCtx("r2e");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    addRoute(ctx, "RTE_A_ALT", "EXEC_A", 90);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    persistValidated(ctx, mission, a, { routeId: "RTE_EXEC_A" });
    biz.upsertAgentContract(aid, "op", {
      preferred_route_ids: ["RTE_A_ALT"],
      route_fallback_allowed: false,
    });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_ROUTE_RESTRICTED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("F. already-dispatched execution is a historical fact — tighten, re-route, returns same execution", () => {
    const { ctx, biz } = makeBizCtx("r2f");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const first = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(a.dispatched.length).toBe(1);
    const firstExec = String(first.execution.execution_id);
    // tighten after the fact — historical execution must NOT be re-dispatched
    biz.upsertAgentContract(aid, "op", { denied_executor_ids: ["EXEC_A"] });
    const second = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(second.adopted).toBe(true);
    expect(String(second.execution.execution_id)).toBe(firstExec);
    expect(a.dispatched.length).toBe(1); // no second external dispatch
    expect(ctx.store.list("executor_execution").length).toBe(1);
  });

  it("G. INTENT_RECORDED + dispatch evidence → reconcile, no second dispatch", () => {
    const { ctx, biz } = makeBizCtx("r2g");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const first = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(a.dispatched.length).toBe(1);
    const gtid = String(first.governed_task.governed_task_id);
    const eid = String(first.execution.execution_id);
    // crash between intent write and execution persist: flip back to
    // INTENT_RECORDED while adapter evidence proves the dispatch happened
    const intentId = `INTENT_${gtid}`;
    const intent = ctx.store.get("executor_dispatch_intent", intentId);
    ctx.store.put(
      "executor_dispatch_intent",
      intentId,
      { ...intent, state: "INTENT_RECORDED", execution_id: undefined },
      Number(intent.version),
    );
    a.evidence[gtid] = { dispatched: true, execution_id: eid };
    biz.upsertAgentContract(aid, "op", { denied_executor_ids: ["EXEC_A"] });
    const second = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(String(second.execution.execution_id)).toBe(eid);
    expect(a.dispatched.length).toBe(1);
    expect(ctx.store.list("executor_execution").length).toBe(1);
  });
});

describe("P12.R2.6 pinned provenance hardening", () => {
  function tamperPin(
    store: PairEvidenceStore,
    missionId: string,
    mutate: (pin: Record<string, unknown>) => void,
  ) {
    const row = store.get("mission", missionId);
    const md = row.metadata as Record<string, unknown>;
    const pin = md.agent_contract as Record<string, unknown>;
    mutate(pin);
    // recompute the digest so the tampered field — not a digest mismatch —
    // is what triggers the failure.
    pin.contract_digest = contractDigest({
      contract_id: String(pin.contract_id),
      org_agent_id: String(pin.org_agent_id),
      business_id: String(pin.business_id),
      contract_version: Number(pin.contract_version),
      policy: normalizeContractPolicy(pin.policy),
    });
    store.put("mission", missionId, row, Number(row.version));
  }

  it("A. tampered pin.schema_version with valid digest → FAIL CLOSED", () => {
    const { ctx, biz } = makeBizCtx("r2h");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamperPin(ctx.store, String(mission.mission_id), (pin) => {
      pin.schema_version = "evil.schema.v9";
    });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE/);
    expect(a.dispatched.length).toBe(0);
  });

  it("B. pin.contract_version = 0 with recomputed digest → FAIL CLOSED", () => {
    const { ctx, biz } = makeBizCtx("r2i");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamperPin(ctx.store, String(mission.mission_id), (pin) => {
      pin.contract_version = 0;
    });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED/);
    expect(a.dispatched.length).toBe(0);
  });

  it("C. pin.contract_version = -1 → FAIL CLOSED", () => {
    const { ctx, biz } = makeBizCtx("r2j");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    tamperPin(ctx.store, String(mission.mission_id), (pin) => {
      pin.contract_version = -1;
    });
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED/);
    expect(a.dispatched.length).toBe(0);
  });
});

/* ============ R3 — true dispatch crash recovery + historical idempotency ============ */

/**
 * Persist the real crash window: governed_task DISPATCH_AUTHORIZED +
 * intent INTENT_RECORDED + NO executor_execution row — the adapter's
 * external dispatch happened, the local write never did.
 */
function persistCrashState(
  ctx: Ctx,
  mission: Record<string, unknown>,
  adapter: ScriptedAdapter,
) {
  const gov = persistValidated(ctx, mission, adapter);
  const gtid = String(gov.governed_task_id);
  ctx.gate.authorize_dispatch(adapter, gtid);
  const intentId = `INTENT_${gtid}`;
  ctx.store.put(
    "executor_dispatch_intent",
    intentId,
    {
      intent_id: intentId,
      governed_task_id: gtid,
      executor_id: adapter.executor_id,
      state: "INTENT_RECORDED",
      created_at: utcnow(),
      version: 0,
    },
    0,
  );
  return gtid;
}

describe("P12.R3 dispatch crash recovery", () => {
  it("A. missing-local-row crash → proven external dispatch reconciled, zero new dispatch", () => {
    const { ctx, biz } = makeBizCtx("r3a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    a.evidence[gtid] = { dispatched: true, execution_id: "EXEC_EXTERNAL_1" };
    expect(ctx.store.list("executor_execution").length).toBe(0);

    const routed = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(a.dispatched.length).toBe(0); // no second external dispatch
    const execs = ctx.store.list("executor_execution");
    expect(execs.length).toBe(1);
    const exec = execs[0];
    expect(String(exec.execution_id)).toBe("EXEC_EXTERNAL_1");
    expect(String(routed.execution.execution_id)).toBe("EXEC_EXTERNAL_1");
    // canonical identity bound to the governed task
    expect(String(exec.governed_task_id)).toBe(gtid);
    expect(String(exec.mission_id)).toBe(String(mission.mission_id));
    expect(String(exec.executor_id)).toBe("EXEC_A");
    expect(exec.reconciled_from_dispatch_evidence).toBe(true);
    expect(exec.dispatch_timestamp ?? null).toBeNull(); // recovery time is NOT dispatch time
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent.state)).toBe("EXECUTION_PERSISTED");
    expect(String(intent.execution_id)).toBe("EXEC_EXTERNAL_1");
    const integrity = ctx.store.verifyIntegrity() as Record<string, number>;
    expect(integrity.errors ?? 0).toBe(0);
  });

  it("B. concurrent recovery — two independent stacks converge on ONE execution row", async () => {
    const { ctx, biz } = makeBizCtx("r3b");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    const dbPath = path.join(ctx.dir, "pair.db");
    const [r1, r2] = await runRace([
      { op: "dispatchRecover", dir: ctx.dir, dbPath, args: { executorId: "EXEC_A", governedTaskId: gtid, evidenceExecId: "EXEC_EXTERNAL_2" } },
      { op: "dispatchRecover", dir: ctx.dir, dbPath, args: { executorId: "EXEC_A", governedTaskId: gtid, evidenceExecId: "EXEC_EXTERNAL_2" } },
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const outs = [r1, r2].map((r) => String((r as { out: { execution_id: string } }).out.execution_id));
    expect(outs[0]).toBe("EXEC_EXTERNAL_2");
    expect(outs[1]).toBe("EXEC_EXTERNAL_2");
    // exactly one canonical row, one persisted intent outcome, zero dispatches
    const execs = ctx.store.list("executor_execution");
    expect(execs.length).toBe(1);
    expect(String(execs[0].execution_id)).toBe("EXEC_EXTERNAL_2");
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent.state)).toBe("EXECUTION_PERSISTED");
    expect(a.dispatched.length).toBe(0);
    const integrity = ctx.store.verifyIntegrity() as Record<string, number>;
    expect(integrity.errors ?? 0).toBe(0);
  }, 60_000);

  it("C. dispatched=true without execution_id → FAIL CLOSED, no dispatch, intent recoverable", () => {
    const { ctx, biz } = makeBizCtx("r3c");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    a.evidence[gtid] = { dispatched: true }; // positive but incomplete
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(
      /FAIL_CLOSED_DISPATCH_EVIDENCE_INCOMPLETE/,
    );
    expect(a.dispatched.length).toBe(0);
    expect(ctx.store.list("executor_execution").length).toBe(0); // no fabricated row
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent.state)).toBe("INTENT_RECORDED"); // still recoverable
  });

  it("D. EXECUTION_PERSISTED + contract disabled afterward → historical execution still returned", () => {
    const { ctx, biz } = makeBizCtx("r3d");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const first = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    const eid = String(first.execution.execution_id);
    biz.setAgentContractStatus(aid, "DISABLED", "op");
    const second = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(String(second.execution.execution_id)).toBe(eid);
    expect(a.dispatched.length).toBe(1);
    expect(ctx.store.list("executor_execution").length).toBe(1);
  });

  it("E. EXECUTION_PERSISTED + agent PAUSED afterward → historical execution still returned", () => {
    const { ctx, biz } = makeBizCtx("r3e");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const first = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    const eid = String(first.execution.execution_id);
    biz.setOrgAgentStatus(aid, "PAUSED", "op");
    const second = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(String(second.execution.execution_id)).toBe(eid);
    expect(a.dispatched.length).toBe(1);
  });

  it("F. INTENT_RECORDED + proven dispatch + contract disabled → reconcile history, no second dispatch", () => {
    const { ctx, biz } = makeBizCtx("r3f");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    a.evidence[gtid] = { dispatched: true, execution_id: "EXEC_EXTERNAL_3" };
    biz.setAgentContractStatus(aid, "DISABLED", "op");
    const routed = ctx.router.routeGovernedTask(
      govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
      ctx.adapters,
    );
    expect(String(routed.execution.execution_id)).toBe("EXEC_EXTERNAL_3");
    expect(a.dispatched.length).toBe(0);
    expect(ctx.store.list("executor_execution").length).toBe(1);
  });

  it("G. control — NEW dispatch with disabled contract still fails closed", () => {
    const { ctx, biz } = makeBizCtx("r3g");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    biz.setAgentContractStatus(aid, "DISABLED", "op");
    expect(() =>
      ctx.router.routeGovernedTask(
        govRequest(ctx, ctx.service.getMission(String(mission.mission_id))) as never,
        ctx.adapters,
      ),
    ).toThrowError(/FAIL_CLOSED/);
    expect(a.dispatched.length).toBe(0);
  });
});

/* ====== R4 — reconciliation identity + evidence durability ====== */

/** Persist a foreign executor_execution row bound to another governed task. */
function persistForeignExec(
  ctx: Ctx,
  mission: Record<string, unknown>,
  adapter: ScriptedAdapter,
  executionId: string,
) {
  const gov = persistValidated(ctx, mission, adapter);
  const gtid = String(gov.governed_task_id);
  ctx.store.put(
    "executor_execution",
    executionId,
    {
      execution_id: executionId,
      governed_task_id: gtid,
      mission_id: gov.mission_id,
      task_id: gov.task_id,
      executor_id: adapter.executor_id,
      plan_revision: gov.plan_revision,
      correlation_id: gov.correlation_id,
      execution_state: "RUNNING",
      dispatch_timestamp: utcnow(),
      workspace: gov.workspace,
      version: 0,
    },
    0,
  );
  return gtid;
}

describe("P12.R4 reconciliation identity + evidence durability", () => {
  it("A. evidence id collision — EXEC bound to GTASK_B cannot be adopted for GTASK_A", () => {
    const { ctx, biz } = makeBizCtx("r4a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission: mA } = boundMission(ctx, aid, String(bz.business_id));
    const { mission: mB } = boundMission(ctx, aid, String(bz.business_id));
    const gtidA = persistCrashState(ctx, mA, a);
    const gtidB = persistForeignExec(ctx, mB, a, "EXEC_X");
    expect(gtidA).not.toBe(gtidB);
    a.evidence[gtidA] = { dispatched: true, execution_id: "EXEC_X" };
    expect(() => ctx.gate.dispatch_governed_task(a, gtidA)).toThrowError(
      /FAIL_CLOSED_EXECUTION_RECONCILE_IDENTITY_MISMATCH/,
    );
    expect(a.dispatched.length).toBe(0);
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtidA}`);
    expect(String(intent.state)).toBe("INTENT_RECORDED");
    const execX = ctx.store.get("executor_execution", "EXEC_X");
    expect(String(execX.governed_task_id)).toBe(gtidB); // unchanged
  });

  it("B. EXECUTION_PERSISTED intent pointing at a foreign execution fails closed", () => {
    const { ctx, biz } = makeBizCtx("r4b");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission: mA } = boundMission(ctx, aid, String(bz.business_id));
    const { mission: mB } = boundMission(ctx, aid, String(bz.business_id));
    const gtidA = persistCrashState(ctx, mA, a);
    persistForeignExec(ctx, mB, a, "EXEC_X");
    const intentRow = ctx.store.get("executor_dispatch_intent", `INTENT_${gtidA}`);
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtidA}`,
      { ...intentRow, state: "EXECUTION_PERSISTED", execution_id: "EXEC_X" },
      intentRow.version,
    );
    expect(() => ctx.gate.dispatch_governed_task(a, gtidA)).toThrowError(
      /FAIL_CLOSED_EXECUTION_RECONCILE_IDENTITY_MISMATCH/,
    );
    expect(a.dispatched.length).toBe(0);
  });

  it("C. intent payload mismatch (key GTASK_A, payload GTASK_B) fails closed first", () => {
    const { ctx, biz } = makeBizCtx("r4c");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission: mA } = boundMission(ctx, aid, String(bz.business_id));
    const { mission: mB } = boundMission(ctx, aid, String(bz.business_id));
    const gtidA = persistCrashState(ctx, mA, a);
    const gtidB = String(persistValidated(ctx, mB, a).governed_task_id);
    const row = ctx.store.get("executor_dispatch_intent", `INTENT_${gtidA}`);
    ctx.store.put(
      "executor_dispatch_intent",
      `INTENT_${gtidA}`,
      { ...row, governed_task_id: gtidB },
      row.version,
    );
    a.evidence[gtidA] = { dispatched: true, execution_id: "EXEC_Y" };
    expect(() => ctx.gate.dispatch_governed_task(a, gtidA)).toThrowError(
      /FAIL_CLOSED_DISPATCH_INTENT_IDENTITY_MISMATCH/,
    );
    expect(a.dispatched.length).toBe(0);
  });

  it("D. non-CAS failure after insert propagates; intent stays INTENT_RECORDED; retry repairs", () => {
    const { ctx, biz } = makeBizCtx("r4d");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    a.evidence[gtid] = { dispatched: true, execution_id: "EXEC_Z" };
    const origEvent = ctx.store.event.bind(ctx.store);
    ctx.store.event = () => { throw new Error("INJECTED_EVENT_FAILURE"); };
    expect(() => ctx.gate.dispatch_governed_task(a, gtid)).toThrowError(
      /INJECTED_EVENT_FAILURE/,
    );
    ctx.store.event = origEvent;
    // row durable, intent NOT promoted
    expect(ctx.store.tryGet("executor_execution", "EXEC_Z")).toBeTruthy();
    const intent1 = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent1.state)).toBe("INTENT_RECORDED");
    // retry: adopts + repairs missing audit, then promotes
    const exec = ctx.gate.dispatch_governed_task(a, gtid);
    expect(String(exec.execution_id)).toBe("EXEC_Z");
    expect(a.dispatched.length).toBe(0);
    const intent2 = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent2.state)).toBe("EXECUTION_PERSISTED");
  });

  it("E. crash after row insert, before reconcile evidence → restart repairs audit, no redispatch", () => {
    const { ctx, biz } = makeBizCtx("r4e");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const bz = makeBiz(biz, ctx.projectId);
    const ag = biz.createOrgAgent({ business_id: String(bz.business_id), title: "eng", department: "eng", operator_id: "op" });
    const aid = String(ag.agent_id);
    const { mission } = boundMission(ctx, aid, String(bz.business_id));
    const gtid = persistCrashState(ctx, mission, a);
    const gov = ctx.store.get("governed_task", gtid);
    // canonical reconciled row present; event/evidence intentionally absent
    ctx.store.put(
      "executor_execution",
      "EXEC_CRASH",
      {
        execution_id: "EXEC_CRASH",
        governed_task_id: gtid,
        mission_id: gov.mission_id,
        task_id: gov.task_id,
        executor_id: "EXEC_A",
        plan_revision: gov.plan_revision,
        correlation_id: gov.correlation_id,
        execution_state: "RUNNING",
        reconciled_from_dispatch_evidence: true,
        reconciled_at: utcnow(),
        workspace: gov.workspace,
        version: 0,
      },
      0,
    );
    a.evidence[gtid] = { dispatched: true, execution_id: "EXEC_CRASH" };
    const exec = ctx.gate.dispatch_governed_task(a, gtid);
    expect(String(exec.execution_id)).toBe("EXEC_CRASH");
    expect(a.dispatched.length).toBe(0);
    expect(
      ctx.store.listEvents("executor_execution", "EXEC_CRASH")
        .some((e) => String(e.event_type) === "EXECUTION_RECONCILED"),
    ).toBe(true);
    const mid = String(mission.mission_id);
    expect(
      ctx.store.listEvidence(mid).some(
        (e) =>
          String(e.kind) === "EXECUTION_RECONCILED" &&
          String((e.payload as Record<string, Record<string, unknown>>).payload.governed_task_id) === gtid,
      ),
    ).toBe(true);
    const intent = ctx.store.get("executor_dispatch_intent", `INTENT_${gtid}`);
    expect(String(intent.state)).toBe("EXECUTION_PERSISTED");
    const integrity = ctx.store.verifyIntegrity() as Record<string, number>;
    expect(integrity.errors ?? 0).toBe(0);
  });
});
