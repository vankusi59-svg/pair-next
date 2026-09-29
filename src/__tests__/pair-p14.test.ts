/**
 * P14 AUTONOMOUS WORKFORCE + GOVERNED WORK GRAPH tests — the §17 matrix.
 *
 *  GRAPH      valid create, self-dep, cycle, cross-biz edge, unknown node,
 *             readiness propagation, failed prerequisite, versionless
 *             dep mutation
 *  ASSIGN     valid, inactive agent, foreign business, capability gate,
 *             BLOCKED_CAPABILITY when nobody is eligible
 *  DELEGATE   valid + idempotent, cross-biz, inactive, depth bound,
 *             capability narrowing
 *  DECOMPOSE  deterministic materialization, idempotent retry, cyclic
 *             proposal rejected, canonical business context, child cap
 *  INBOX      READY / WAITING_DEPENDENCY / BLOCKED / REVIEW_REQUIRED /
 *             recently-completed projections
 *  HEARTBEAT  claims+opens eligible work, ignores blocked/waiting, real
 *             worker_threads race → one owner + one mission, restart resume
 *             creates no duplicate
 *  REVIEW     requires_review → REVIEW_REQUIRED, accept → DONE propagates,
 *             rework → READY, self-review + cross-biz reviewer rejected
 *  RECOVERY   stale pending-open intent reconciled once, readiness rebuilt
 *             from canonical state on a fresh context
 *
 * Every executable path travels the canonical seam — openWorkItem →
 * startMission → MissionRouter → GovernedTaskGate. No second dispatcher.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
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
  WorkforceService,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14-"));
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

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: string[] = [];
  available = true;
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

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

interface Ctx {
  dir: string;
  workspace: string;
  dbPath: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  projectId: string;
}

function wireCtx(dir: string, name: string): Ctx {
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
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
  return { dir, workspace, dbPath, store, service, gate, registry, router, control, adapters, projectId: String(project.project_id) };
}

function makeCtx(name: string): Ctx {
  return wireCtx(freshDir(name), name);
}

/** Fresh context over an EXISTING db — a restart with zero process memory. */
function reopenCtx(dir: string, name: string): Ctx {
  const ctx = wireCtx(dir, name);
  // wireCtx created a fresh project on the existing store — reuse the
  // canonical business project instead.
  const projects = ctx.store.list("project") as Array<Record<string, unknown>>;
  if (projects.length) ctx.projectId = String(projects[0].project_id);
  return ctx;
}

interface BizCtx {
  ctx: Ctx;
  biz: BusinessLayer;
  workforce: WorkforceService;
}

function makeBizCtx(name: string, existing?: Ctx): BizCtx {
  const ctx = existing ?? makeCtx(name);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  const workforce = new WorkforceService({ store: ctx.store, business: biz });
  return { ctx, biz, workforce };
}

function makeBiz(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

function makeAgent(biz: BusinessLayer, businessId: string, title: string, caps: string[] = []) {
  return biz.createOrgAgent({
    business_id: businessId, title, department: "eng",
    capabilities: caps, operator_id: "op",
  });
}

function wi(biz: BusinessLayer, businessId: string, over: Record<string, unknown> = {}) {
  return biz.createWorkItem({
    business_id: businessId, title: String(over.title ?? "w"), goal: String(over.goal ?? "g"),
    ...over,
    operator_id: "op",
  } as never);
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: ALL_CAPS,
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
  if (!ctx.service.routes.getRoute(routeId)) {
    ctx.service.routes.registerRoute({
      route_id: routeId,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      direct_callable: true,
      capabilities: ALL_CAPS,
      priority: 50,
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

/**
 * Drive a work item's mission to COMPLETED via the canonical chain:
 * transition → commitPlan → routeGovernedTask → collect_execution_result →
 * syncWorkItem folds it back. Returns the mission row.
 */
function completeWorkMission(ctx: Ctx, biz: BusinessLayer, adapter: ScriptedAdapter, workItemId: string) {
  const wiRow = biz.listWorkItems().find((w) => String(w.work_item_id) === workItemId)!;
  const missionId = String((wiRow.mission_ids as string[]).at(-1));
  ctx.service.transitionMission(missionId, "READY");
  ctx.service.commitPlan({
    mission_id: missionId,
    source: "test",
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "do", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
    proposal: { tasks: [] },
  });
  const mission = ctx.service.getMission(missionId);
  const routed = ctx.router.routeGovernedTask(govRequest(ctx, mission) as never, ctx.adapters);
  ctx.gate.collect_execution_result(adapter, String(routed.execution.execution_id));
  // Same convention as P11: terminal mission state is canonical — drive the
  // row to COMPLETED and let syncWorkItem fold it into the work item.
  const mRow = ctx.store.get("mission", missionId);
  mRow.status = "COMPLETED";
  ctx.store.put("mission", missionId, mRow, Number(mRow.version));
  return biz.syncWorkItem(workItemId);
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message);
  }
  throw new Error("expected throw");
}

/* ------------------------- worker race harness ------------------------- */

const CACHE = path.join(process.cwd(), "node_modules/.cache/pair-p14");
const BUNDLE = path.join(CACHE, "pair-bundle.mjs");
const WORKER_FILE = path.join(CACHE, "worker.mjs");

// Plain JS — runs as .mjs; TypeScript annotations would break the worker.
const WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, args, barrier } = workerData;

function wire() {
  const store = new PAIR.PairEvidenceStore(dbPath);
  const service = new PAIR.PairControlPlane(store);
  const gate = new PAIR.GovernedTaskGate(service);
  const router = new PAIR.MissionRouter(service, gate);
  const recovery = new PAIR.RecoveryController(service);
  const recon = new PAIR.ReconciliationService(service, new Map());
  const approvals = new PAIR.ApprovalQueue(service);
  const scheduler = new PAIR.MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map();
  const planner = () => ({ tasks: [] });
  const runtime = new PAIR.MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new PAIR.MissionSupervisor(service, runtime, recovery, recon);
  const observability = new PAIR.MissionObservability(service);
  const control = new PAIR.MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
    costHaltFile: dbPath + ".halt",
  });
  const schedules = new PAIR.MissionScheduleService(service);
  const business = new PAIR.BusinessLayer({ store, control, schedules });
  const workforce = new PAIR.WorkforceService({ store, business });
  return { store, service, business, workforce };
}

try {
  const { store, business, workforce } = wire();
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  if (op === "heartbeat") {
    const out = workforce.heartbeat(args.agentId, "worker");
    parentPort.postMessage({ ok: true, out });
  } else if (op === "delegate") {
    const row = workforce.delegateWorkItem(args, "worker");
    parentPort.postMessage({ ok: true, out: { work_item_id: String(row.work_item_id) } });
  } else if (op === "claim") {
    const row = business.claimWorkItem(args.workItemId, args.agentId, "worker");
    parentPort.postMessage({ ok: true, out: { claimed_by: String(row.claimed_by) } });
  } else if (op === "deps") {
    const row = business.updateWorkItemDeps(args.workItemId, args.deps, args.expectedVersion, "worker");
    parentPort.postMessage({ ok: true, out: { version: Number(row.version) } });
  } else if (op === "decompose") {
    const out = workforce.decomposeWorkItem(args.workItemId, args.input, "worker");
    parentPort.postMessage({ ok: true, out: { children: out.children.map((c) => String(c.work_item_id)) } });
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

type RaceOutcome = { ok: true; out: Record<string, unknown> } | { ok: false; code: string; message: string };

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

/* -------------------------------- GRAPH -------------------------------- */

describe("P14 graph", () => {
  it("GRAPH-A: valid edges — graph projection + child listing", () => {
    const { ctx, biz, workforce } = makeBizCtx("graph-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const a1 = wi(biz, bid, { title: "A1" });
    const a2 = wi(biz, bid, { title: "A2" });
    const dep = wi(biz, bid, {
      title: "D", depends_on: [String(a1.work_item_id), String(a2.work_item_id)],
      parent_work_item_id: String(a1.work_item_id),
    });
    const g = workforce.workGraph(bid);
    expect(g.nodes.length).toBe(3);
    const edges = g.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain(`${String(dep.work_item_id)}->${String(a1.work_item_id)}`);
    expect(edges).toContain(`${String(dep.work_item_id)}->${String(a2.work_item_id)}`);
    expect(edges).toContain(`${String(a1.work_item_id)}->${String(dep.work_item_id)}`);
    expect(workforce.childrenOf(String(a1.work_item_id)).map((c) => String(c.work_item_id))).toContain(String(dep.work_item_id));
    // Unsatisfied deps → the node waits in BACKLOG even with no assignee.
    expect(String(dep.status)).toBe("BACKLOG");
  });

  it("GRAPH-B: self-dependency fails closed", () => {
    const { ctx, biz } = makeBizCtx("graph-b");
    const b = makeBiz(biz, ctx.projectId);
    const n = wi(biz, String(b.business_id), {});
    expect(errCode(() => biz.updateWorkItemDeps(String(n.work_item_id), [String(n.work_item_id)], Number(n.version), "op")))
      .toBe("FAIL_CLOSED_WORK_GRAPH_CYCLE");
  });

  it("GRAPH-C: dependency cycle fails closed", () => {
    const { ctx, biz } = makeBizCtx("graph-c");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const x = wi(biz, bid, { title: "X" });
    const y = wi(biz, bid, { title: "Y", depends_on: [String(x.work_item_id)] });
    // Making X depend on Y would close X ← Y ← X.
    expect(errCode(() => biz.updateWorkItemDeps(String(x.work_item_id), [String(y.work_item_id)], Number(x.version), "op")))
      .toBe("FAIL_CLOSED_WORK_GRAPH_CYCLE");
    // Direct sibling chain stays legal.
    const z = wi(biz, bid, { title: "Z", depends_on: [String(y.work_item_id)] });
    expect((z.depends_on as string[])).toEqual([String(y.work_item_id)]);
  });

  it("GRAPH-D: cross-business edge and unknown node fail closed", () => {
    const { ctx, biz } = makeBizCtx("graph-d");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const foreign = wi(biz, String(b2.business_id), {});
    expect(errCode(() =>
      wi(biz, String(b1.business_id), { depends_on: [String(foreign.work_item_id)] }),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_SCOPE");
    expect(errCode(() =>
      wi(biz, String(b1.business_id), { depends_on: ["WI_nonexistent"] }),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_NODE");
  });

  it("GRAPH-E: dep mutation without version fails closed (CAS boundary)", () => {
    const { ctx, biz } = makeBizCtx("graph-e");
    const b = makeBiz(biz, ctx.projectId);
    const x = wi(biz, String(b.business_id), {});
    const y = wi(biz, String(b.business_id), {});
    expect(errCode(() =>
      biz.updateWorkItemDeps(String(y.work_item_id), [String(x.work_item_id)], Number(x.version) + 9, "op"),
    )).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    const ok = biz.updateWorkItemDeps(String(y.work_item_id), [String(x.work_item_id)], Number(y.version), "op");
    expect((ok.depends_on as string[])).toEqual([String(x.work_item_id)]);
  });

  it("GRAPH-F: completion propagates readiness; failed prerequisite blocks dependents", () => {
    const { ctx, biz } = makeBizCtx("graph-f");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "w1", ["CODE"]);
    const pre = wi(biz, bid, { title: "pre", assignee_agent_id: String(ag.agent_id) });
    const dep = wi(biz, bid, { title: "dep", depends_on: [String(pre.work_item_id)], assignee_agent_id: String(ag.agent_id) });
    // Dep gated until prerequisite DONE.
    expect(String(dep.status)).toBe("BACKLOG");
    expect(errCode(() => biz.openWorkItem(String(dep.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_DEPENDENCY");
    // Execute the prerequisite through the canonical path.
    biz.openWorkItem(String(pre.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(pre.work_item_id));
    const depAfter = biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(dep.work_item_id))!;
    expect(String(depAfter.status)).toBe("READY");
    expect(ctx.store.listEvents().some((e) => e.event_type === "WORK_READY" && e.entity_id === String(dep.work_item_id))).toBe(true);
    // Now a failed prerequisite deterministically blocks dependents.
    const fail = wi(biz, bid, { title: "fail", assignee_agent_id: String(ag.agent_id) });
    const victim = wi(biz, bid, { title: "victim", depends_on: [String(fail.work_item_id)], assignee_agent_id: String(ag.agent_id) });
    biz.cancelWorkItem(String(fail.work_item_id), "op");
    const v = biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(victim.work_item_id))!;
    expect(String(v.status)).toBe("BLOCKED");
    expect(String(v.blocked_code)).toBe("DEPENDENCY_FAILED");
    // Still not executable: the dependency gate fires before dispatch —
    // a node under a dead prerequisite can never execute.
    expect(errCode(() => biz.openWorkItem(String(v.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_DEPENDENCY");
  });
});

/* ------------------------------- ASSIGN -------------------------------- */

describe("P14 assignment", () => {
  it("ASSIGN-A: valid assignment reaches READY; capability required", () => {
    const { ctx, biz, workforce } = makeBizCtx("asg-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const coder = makeAgent(biz, bid, "coder", ["CODE"]);
    const runner = makeAgent(biz, bid, "runner", []);
    const item = wi(biz, bid, { required_capability: "CODE" });
    // Agent lacking the capability cannot be assigned.
    expect(errCode(() => biz.assignWorkItem(String(item.work_item_id), String(runner.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_CAPABILITY");
    const assigned = workforce.assignWork(String(item.work_item_id), String(coder.agent_id), "op");
    expect(String(assigned.status)).toBe("READY");
    expect(String(assigned.assignee_agent_id)).toBe(String(coder.agent_id));
  });

  it("ASSIGN-B: inactive + foreign-business agents fail closed", () => {
    const { ctx, biz, workforce } = makeBizCtx("asg-b");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const paused = makeAgent(biz, String(b1.business_id), "p");
    biz.setOrgAgentStatus(String(paused.agent_id), "PAUSED", "op");
    const foreign = makeAgent(biz, String(b2.business_id), "f");
    const item = wi(biz, String(b1.business_id), {});
    expect(errCode(() => workforce.assignWork(String(item.work_item_id), String(paused.agent_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(errCode(() => workforce.assignWork(String(item.work_item_id), String(foreign.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_SCOPE");
  });

  it("ASSIGN-C: no eligible agent → explicit BLOCKED_CAPABILITY", () => {
    const { ctx, biz, workforce } = makeBizCtx("asg-c");
    const b = makeBiz(biz, ctx.projectId);
    makeAgent(biz, String(b.business_id), "noCaps", []);
    const item = wi(biz, String(b.business_id), { required_capability: "RARE" });
    const out = workforce.autoAssign(String(item.work_item_id), "op");
    expect(String(out.status)).toBe("BLOCKED");
    expect(String(out.blocked_code)).toBe("BLOCKED_CAPABILITY");
    expect(ctx.store.listEvents().some((e) => e.event_type === "WORK_ITEM_BLOCKED")).toBe(true);
  });

  it("ASSIGN-D: autoAssign picks the capable, least-loaded agent", () => {
    const { ctx, biz, workforce } = makeBizCtx("asg-d");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const busy = makeAgent(biz, bid, "busy", ["CODE"]);
    const idle = makeAgent(biz, bid, "idle", ["CODE"]);
    makeAgent(biz, bid, "noCap", []);
    const held = wi(biz, bid, { assignee_agent_id: String(busy.agent_id) });
    biz.claimWorkItem(String(held.work_item_id), String(busy.agent_id), "op");
    const item = wi(biz, bid, { required_capability: "CODE" });
    const assigned = workforce.autoAssign(String(item.work_item_id), "op");
    expect(String(assigned.assignee_agent_id)).toBe(String(idle.agent_id));
  });
});

/* ------------------------------ DELEGATE ------------------------------- */

describe("P14 delegation", () => {
  it("DELEG-A: canonical child with provenance + WORK_DELEGATED event", () => {
    const { ctx, biz, workforce } = makeBizCtx("del-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const worker = makeAgent(biz, bid, "worker");
    const parent = wi(biz, bid, { title: "root", assignee_agent_id: String(lead.agent_id), requires_review: true });
    const child = workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      reason: "split scope",
    }, "op");
    expect(String(child.parent_work_item_id)).toBe(String(parent.work_item_id));
    expect(String(child.delegated_from_work_item_id)).toBe(String(parent.work_item_id));
    expect(String(child.delegated_by_agent_id)).toBe(String(lead.agent_id));
    expect(String(child.assignee_agent_id)).toBe(String(worker.agent_id));
    expect(Number(child.delegation_depth)).toBe(1);
    expect(String(child.business_id)).toBe(bid);
    expect(child.requires_review).toBe(true);
    const ev = ctx.store.listEvents().find((e) => e.event_type === "WORK_DELEGATED");
    expect(ev).toBeTruthy();
  });

  it("DELEG-B: idempotent — same key returns the same child, no duplicate", () => {
    const { ctx, biz, workforce } = makeBizCtx("del-b");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const worker = makeAgent(biz, String(b.business_id), "worker");
    const parent = wi(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const args = {
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      reason: "r",
      delegation_key: "K1",
    };
    const c1 = workforce.delegateWorkItem(args, "op");
    const c2 = workforce.delegateWorkItem(args, "op");
    expect(String(c1.work_item_id)).toBe(String(c2.work_item_id));
    expect(ctx.store.listEvents().filter((e) => e.event_type === "WORK_DELEGATED").length).toBe(1);
  });

  it("DELEG-C: cross-business target + inactive agents fail closed", () => {
    const { ctx, biz, workforce } = makeBizCtx("del-c");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const lead = makeAgent(biz, String(b1.business_id), "lead");
    const foreign = makeAgent(biz, String(b2.business_id), "foreign");
    const parent = wi(biz, String(b1.business_id), { assignee_agent_id: String(lead.agent_id) });
    expect(errCode(() => workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(foreign.agent_id),
    }, "op"))).toBe("FAIL_CLOSED_WORK_DELEGATE_SCOPE");
    const paused = makeAgent(biz, String(b1.business_id), "paused");
    biz.setOrgAgentStatus(String(paused.agent_id), "PAUSED", "op");
    expect(errCode(() => workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(paused.agent_id),
    }, "op"))).toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(errCode(() => workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(lead.agent_id),
    }, "op"))).toBe("FAIL_CLOSED_WORK_DELEGATE_SELF");
  });

  it("DELEG-D: depth cap fails closed", () => {
    const { ctx, biz, workforce } = makeBizCtx("del-d");
    const b = makeBiz(biz, ctx.projectId);
    const a0 = makeAgent(biz, String(b.business_id), "a0");
    const a1 = makeAgent(biz, String(b.business_id), "a1");
    let cur = wi(biz, String(b.business_id), { assignee_agent_id: String(a0.agent_id) });
    for (let i = 0; i < 5; i++) {
      cur = workforce.delegateWorkItem({
        work_item_id: String(cur.work_item_id),
        delegated_by_agent_id: String(a0.agent_id),
        delegated_to_agent_id: String(a1.agent_id),
        reason: `hop-${i}`,
      }, "op");
    }
    expect(Number(cur.delegation_depth)).toBe(5);
    expect(errCode(() => workforce.delegateWorkItem({
      work_item_id: String(cur.work_item_id),
      delegated_by_agent_id: String(a1.agent_id),
      delegated_to_agent_id: String(a0.agent_id),
      reason: "hop-over",
    }, "op"))).toBe("FAIL_CLOSED_WORK_DELEGATION_BOUND");
  });

  it("DELEG-E: delegatee must satisfy the required capability — never widened", () => {
    const { ctx, biz, workforce } = makeBizCtx("del-e");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead", ["CODE"]);
    const noCap = makeAgent(biz, String(b.business_id), "nocap");
    const parent = wi(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id), required_capability: "CODE" });
    expect(errCode(() => workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(noCap.agent_id),
    }, "op"))).toBe("FAIL_CLOSED_WORK_CAPABILITY");
  });
});

/* ------------------------------ DECOMPOSE ------------------------------ */

describe("P14 decomposition", () => {
  it("DEC-A: deterministic materialization + canonical business context", () => {
    const { ctx, biz, workforce } = makeBizCtx("dec-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "w", ["CODE"]);
    const parent = wi(biz, bid, { title: "epic", required_capability: "CODE" });
    const out = workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "DC1",
      children: [
        { title: "c0", goal: "g0", assignee_agent_id: String(ag.agent_id) },
        { title: "c1", goal: "g1", assignee_agent_id: String(ag.agent_id), depends_on_indices: [0] },
      ],
    }, "op");
    expect(out.children.length).toBe(2);
    expect(String(out.parent.decomposition_id)).toBe("DC1");
    const [c0, c1] = out.children;
    expect(String(c0.business_id)).toBe(bid);
    expect(String(c0.parent_work_item_id)).toBe(String(parent.work_item_id));
    expect(String(c0.required_capability)).toBe("CODE");
    expect(String(c0.status)).toBe("READY");
    expect(String(c1.status)).toBe("BACKLOG");
    expect((c1.depends_on as string[])).toEqual([String(c0.work_item_id)]);
    expect(ctx.store.listEvents().some((e) => e.event_type === "WORK_DECOMPOSED")).toBe(true);
  });

  it("DEC-B: duplicate retry is idempotent — same children, no re-materialize", () => {
    const { ctx, biz, workforce } = makeBizCtx("dec-b");
    const b = makeBiz(biz, ctx.projectId);
    const parent = wi(biz, String(b.business_id), {});
    const spec = { decomposition_id: "DUP", children: [{ title: "x", goal: "g" }] };
    const first = workforce.decomposeWorkItem(String(parent.work_item_id), spec, "op");
    const again = workforce.decomposeWorkItem(String(parent.work_item_id), spec, "op");
    expect(again.children.map((c) => String(c.work_item_id))).toEqual(first.children.map((c) => String(c.work_item_id)));
    expect(ctx.store.listEvents().filter((e) => e.event_type === "WORK_DECOMPOSED").length).toBe(1);
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "DIFFERENT", children: [{ title: "y", goal: "g" }],
    }, "op"))).toBe("FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT");
  });

  it("DEC-C: cyclic/out-of-range proposals + foreign assignees fail closed", () => {
    const { ctx, biz, workforce } = makeBizCtx("dec-c");
    const b = makeBiz(biz, ctx.projectId);
    const other = makeBiz(biz, ctx.projectId, "B2");
    const foreign = makeAgent(biz, String(other.business_id), "f");
    const parent = wi(biz, String(b.business_id), {});
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "CYC",
      children: [
        { title: "c0", goal: "g", depends_on_indices: [1] },
        { title: "c1", goal: "g" },
      ],
    }, "op"))).toBe("FAIL_CLOSED_WORK_GRAPH_CYCLE");
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "OOR",
      children: [{ title: "c0", goal: "g", depends_on_indices: [9] }],
    }, "op"))).toBe("FAIL_CLOSED_WORK_GRAPH_NODE");
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "FORGED",
      children: [{ title: "c0", goal: "g", assignee_agent_id: String(foreign.agent_id) }],
    }, "op"))).toBe("FAIL_CLOSED_WORK_ITEM_SCOPE");
  });
});

/* -------------------------------- INBOX -------------------------------- */

describe("P14 agent inbox projection", () => {
  it("INBOX-A: buckets READY / WAITING_DEP / BLOCKED / REVIEW / completed", () => {
    const { ctx, biz, workforce } = makeBizCtx("inbox-a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "me");
    const reviewer = makeAgent(biz, bid, "rev");
    const ready = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const pre = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const waiting = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), depends_on: [String(pre.work_item_id)] });
    const blocked = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    biz.blockWorkItem(String(blocked.work_item_id), "ops", "op");
    const reviewItem = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), requires_review: true, reviewer_agent_id: String(reviewer.agent_id) });
    biz.openWorkItem(String(reviewItem.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(reviewItem.work_item_id));
    const done = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    biz.openWorkItem(String(done.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(done.work_item_id));
    const inbox = workforce.agentInbox(String(ag.agent_id));
    expect(inbox.ready.map((w) => String(w.work_item_id))).toContain(String(ready.work_item_id));
    expect(inbox.waiting_dependency.map((w) => String(w.work_item_id))).toContain(String(waiting.work_item_id));
    expect(inbox.blocked.map((w) => String(w.work_item_id))).toContain(String(blocked.work_item_id));
    expect(inbox.review_required.map((w) => String(w.work_item_id))).toContain(String(reviewItem.work_item_id));
    expect(inbox.recently_completed.map((w) => String(w.work_item_id))).toContain(String(done.work_item_id));
    // Read model: computing the inbox never mutates state.
    expect(String(biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(reviewItem.work_item_id))!.status)).toBe("REVIEW_REQUIRED");
  });
});

/* ------------------------------- REVIEW -------------------------------- */

describe("P14 review lifecycle", () => {
  it("REVIEW-A: requires_review parks in REVIEW_REQUIRED; accept → DONE propagates", () => {
    const { ctx, biz } = makeBizCtx("rev-a");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "doer");
    const reviewer = makeAgent(biz, bid, "boss");
    const item = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), requires_review: true });
    const downstream = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), depends_on: [String(item.work_item_id)] });
    biz.openWorkItem(String(item.work_item_id), "op");
    const parked = completeWorkMission(ctx, biz, a, String(item.work_item_id));
    expect(String(parked.status)).toBe("REVIEW_REQUIRED");
    // Not DONE → the dependent does NOT become ready yet.
    expect(String(biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(downstream.work_item_id))!.status)).toBe("BACKLOG");
    const accepted = biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(reviewer.agent_id), decision: "ACCEPT",
    }, "op");
    expect(String(accepted.status)).toBe("DONE");
    expect(ctx.store.listEvents().some((e) => e.event_type === "WORK_REVIEW_ACCEPTED")).toBe(true);
    expect(String(biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(downstream.work_item_id))!.status)).toBe("READY");
  });

  it("REVIEW-B: rework returns to READY + WORK_REWORK_REQUESTED", () => {
    const { ctx, biz } = makeBizCtx("rev-b");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "doer");
    const reviewer = makeAgent(biz, String(b.business_id), "boss");
    const item = wi(biz, String(b.business_id), { assignee_agent_id: String(ag.agent_id), requires_review: true });
    biz.openWorkItem(String(item.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(item.work_item_id));
    const rework = biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(reviewer.agent_id), decision: "REWORK", note: "needs more",
    }, "op");
    expect(String(rework.status)).toBe("READY");
    expect(ctx.store.listEvents().some((e) => e.event_type === "WORK_REWORK_REQUESTED")).toBe(true);
  });

  it("REVIEW-C: self-approval, cross-business reviewer, wrong state fail closed", () => {
    const { ctx, biz } = makeBizCtx("rev-c");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const ag = makeAgent(biz, String(b1.business_id), "doer");
    const foreign = makeAgent(biz, String(b2.business_id), "f");
    const item = wi(biz, String(b1.business_id), { assignee_agent_id: String(ag.agent_id), requires_review: true });
    // Not yet in REVIEW_REQUIRED.
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(foreign.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_STATE");
    biz.openWorkItem(String(item.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(item.work_item_id));
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(ag.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_SELF");
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(foreign.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_SCOPE");
  });
});

/* ------------------------------ HEARTBEAT ------------------------------ */

describe("P14 autonomous heartbeat", () => {
  it("HB-A: claims and opens eligible READY work through the canonical seam", () => {
    const { ctx, biz, workforce } = makeBizCtx("hb-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const item = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const out = workforce.heartbeat(String(ag.agent_id), "op");
    expect(out.opened.map((o) => o.work_item_id)).toEqual([String(item.work_item_id)]);
    expect(out.opened[0].mission_id).toBeTruthy();
    const row = biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(item.work_item_id))!;
    expect(String(row.status)).toBe("IN_PROGRESS");
    expect(String(row.claimed_by)).toBe(String(ag.agent_id));
    expect(String((row.mission_ids as string[]).at(-1))).toBe(String(out.opened[0].mission_id));
    // A second heartbeat finds nothing new to open — terminal/in-flight
    // work never silently reopens.
    const again = workforce.heartbeat(String(ag.agent_id), "op");
    expect(again.opened.length).toBe(0);
    expect((biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(item.work_item_id))!.mission_ids as string[]).length).toBe(1);
  });

  it("HB-B: blocked and dependency-waiting work is ignored", () => {
    const { ctx, biz, workforce } = makeBizCtx("hb-b");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const pre = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const waiting = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), depends_on: [String(pre.work_item_id)] });
    const blocked = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    biz.blockWorkItem(String(blocked.work_item_id), "x", "op");
    const out = workforce.heartbeat(String(ag.agent_id), "op");
    // Only `pre` (READY, deps satisfied) opens; waiting + blocked stay put.
    expect(out.opened.map((o) => o.work_item_id)).toEqual([String(pre.work_item_id)]);
    const items = biz.listWorkItems(bid);
    expect(String(items.find((w) => String(w.work_item_id) === String(waiting.work_item_id))!.status)).toBe("BACKLOG");
    expect(String(items.find((w) => String(w.work_item_id) === String(blocked.work_item_id))!.status)).toBe("BLOCKED");
  });

  it("HB-C: heartbeat requires an ACTIVE agent", () => {
    const { ctx, biz, workforce } = makeBizCtx("hb-c");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "auto");
    biz.setOrgAgentStatus(String(ag.agent_id), "PAUSED", "op");
    expect(errCode(() => workforce.heartbeat(String(ag.agent_id), "op"))).toBe("FAIL_CLOSED_AGENT_INACTIVE");
  });

  it("HB-RACE: two concurrent heartbeats — one owner, one mission", async () => {
    const { ctx, biz } = makeBizCtx("hb-race");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const item = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const [r1, r2] = await runRace([
      { op: "heartbeat", dbPath: ctx.dbPath, args: { agentId: String(ag.agent_id) } },
      { op: "heartbeat", dbPath: ctx.dbPath, args: { agentId: String(ag.agent_id) } },
    ]);
    const openings = [r1, r2].map((r) => (r.ok ? (r.out.opened as Array<{ work_item_id: string }>).length : 0));
    expect(openings.reduce((x, y) => x + y, 0)).toBe(1);
    // Canonical state: exactly one mission, exactly one claimed owner.
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const row = store2.get("work_item", String(item.work_item_id));
    expect((row.mission_ids as string[]).length).toBe(1);
    expect(String(row.claimed_by)).toBe(String(ag.agent_id));
    store2.verifyIntegrity();
  });

  it("HB-RESTART: a fresh context over the same db never duplicates a mission", () => {
    const { ctx, biz, workforce } = makeBizCtx("hb-restart");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const item = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    workforce.heartbeat(String(ag.agent_id), "op");
    // Process "crashes": a brand-new context over the same database file —
    // zero in-memory state, all reconstruction from canonical rows.
    const re = makeBizCtx("hb-restart-2", reopenCtx(ctx.dir, "re"));
    const out = re.workforce.heartbeat(String(ag.agent_id), "op");
    expect(out.opened.length).toBe(0);
    const row = re.biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(item.work_item_id))!;
    expect((row.mission_ids as string[]).length).toBe(1);
    expect(String(row.status)).toBe("IN_PROGRESS");
  });
});

/* ------------------------------- RECOVERY ------------------------------ */

describe("P14 crash/recovery", () => {
  it("REC-A: stale pending open intent is reconciled once — no double open", () => {
    const { ctx, biz, workforce } = makeBizCtx("rec-a");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const item = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    // Crash between transition and mission create: stale pending intent,
    // no mission — backdated past the reconcile grace period.
    const row = ctx.store.get("work_item", String(item.work_item_id));
    row.status = "IN_PROGRESS";
    row.pending_open_id = "OPI_stale";
    row.pending_open_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    ctx.store.put("work_item", String(item.work_item_id), row, Number(row.version));
    // A fresh context reconciles the stale intent — mission never existed,
    // so the item returns to READY and heartbeat may open it exactly once.
    const re = makeBizCtx("rec-a2", reopenCtx(ctx.dir, "re"));
    re.biz.board(bid);
    const healed = re.biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(item.work_item_id))!;
    expect(String(healed.status)).toBe("READY");
    expect(healed.pending_open_id).toBeNull();
    const out = re.workforce.heartbeat(String(ag.agent_id), "op");
    expect(out.opened.length).toBe(1);
    const final = re.biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(item.work_item_id))!;
    expect((final.mission_ids as string[]).length).toBe(1);
    re.ctx.store.verifyIntegrity();
  });

  it("REC-B: readiness reconstructed on restart from canonical dep state", () => {
    const { ctx, biz } = makeBizCtx("rec-b");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "auto");
    const pre = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    const dep = wi(biz, bid, { assignee_agent_id: String(ag.agent_id), depends_on: [String(pre.work_item_id)] });
    // Force the prerequisite DONE directly via canonical mutation (the
    // crash window: mission finished, propagation never ran).
    const row = ctx.store.get("work_item", String(pre.work_item_id));
    row.status = "DONE";
    ctx.store.put("work_item", String(pre.work_item_id), row, Number(row.version));
    const re = makeBizCtx("rec-b2", reopenCtx(ctx.dir, "re"));
    re.biz.rebuildReadiness(bid);
    const healed = re.biz.listWorkItems(bid).find((w) => String(w.work_item_id) === String(dep.work_item_id))!;
    expect(String(healed.status)).toBe("READY");
  });
});

/* --------------------------- WORKER DELEGATION -------------------------- */

describe("P14 races — genuine worker_threads", () => {
  it("D-RACE: two workers delegate with the same key — one child survives", async () => {
    const { ctx, biz } = makeBizCtx("d-race");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const worker = makeAgent(biz, bid, "worker");
    const parent = wi(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    const args = {
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      delegation_key: "RACE-K",
    };
    const [r1, r2] = await runRace([
      { op: "delegate", dbPath: ctx.dbPath, args },
      { op: "delegate", dbPath: ctx.dbPath, args },
    ]);
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const children = store2
      .list("work_item")
      .filter((w) => String(w.parent_work_item_id ?? "") === String(parent.work_item_id));
    expect(children.length).toBe(1);
    const winners = [r1, r2].filter((r) => r.ok && String(r.out.work_item_id) === String(children[0].work_item_id));
    expect(winners.length).toBeGreaterThanOrEqual(1);
    store2.verifyIntegrity();
  });

  it("C-RACE: two workers claim the same item — exactly one owner", async () => {
    const { ctx, biz } = makeBizCtx("c-race");
    const b = makeBiz(biz, ctx.projectId);
    const a1 = makeAgent(biz, String(b.business_id), "a1");
    const a2 = makeAgent(biz, String(b.business_id), "a2");
    const item = wi(biz, String(b.business_id), { assignee_agent_id: String(a1.agent_id) });
    const [r1, r2] = await runRace([
      { op: "claim", dbPath: ctx.dbPath, args: { workItemId: String(item.work_item_id), agentId: String(a1.agent_id) } },
      { op: "claim", dbPath: ctx.dbPath, args: { workItemId: String(item.work_item_id), agentId: String(a2.agent_id) } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const row = store2.get("work_item", String(item.work_item_id));
    expect([String(a1.agent_id), String(a2.agent_id)]).toContain(String(row.claimed_by));
    store2.verifyIntegrity();
  });
});

/* ------------------------------ R1 REMEDIATIONS -------------------------- */

describe("P14 R1 remediations", () => {
  it("GRAPH-R1-RACE: concurrent reciprocal dep mutation cannot create a cycle", async () => {
    const { ctx, biz } = makeBizCtx("g-r1-race");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const A = wi(biz, bid, { title: "A" });
    const B = wi(biz, bid, { title: "B" });
    const [r1, r2] = await runRace([
      {
        op: "deps", dbPath: ctx.dbPath,
        args: { workItemId: String(A.work_item_id), deps: [String(B.work_item_id)], expectedVersion: Number(A.version) },
      },
      {
        op: "deps", dbPath: ctx.dbPath,
        args: { workItemId: String(B.work_item_id), deps: [String(A.work_item_id)], expectedVersion: Number(B.version) },
      },
    ]);
    // Exactly one legal mutation may succeed; the loser fails closed and
    // the final canonical graph is acyclic.
    expect([r1, r2].filter((r) => r.ok).length).toBe(1);
    const loser = [r1, r2].find((r) => !r.ok) as { ok: false; code: string };
    expect(String(loser.code).startsWith("FAIL_CLOSED")).toBe(true);
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const aDeps = (store2.get("work_item", String(A.work_item_id)).depends_on as string[]) ?? [];
    const bDeps = (store2.get("work_item", String(B.work_item_id)).depends_on as string[]) ?? [];
    expect(
      aDeps.includes(String(B.work_item_id)) && bDeps.includes(String(A.work_item_id)),
    ).toBe(false);
    store2.verifyIntegrity();
  });

  it("DECOMP-R1-SAME-RACE: same decomposition race → one canonical child set", async () => {
    const { ctx, biz } = makeBizCtx("dc-same-race");
    const b = makeBiz(biz, ctx.projectId);
    const parent = wi(biz, String(b.business_id), {});
    const spec = {
      decomposition_id: "SAME",
      children: [{ title: "c0", goal: "g" }, { title: "c1", goal: "g" }],
    };
    const args = { workItemId: String(parent.work_item_id), input: spec };
    const [r1, r2] = await runRace([
      { op: "decompose", dbPath: ctx.dbPath, args },
      { op: "decompose", dbPath: ctx.dbPath, args },
    ]);
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const children = store2
      .list("work_item")
      .filter((w) => String(w.parent_work_item_id ?? "") === String(parent.work_item_id));
    expect(children.length).toBe(2);
    const canonical = children.map((c) => String(c.work_item_id)).sort();
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(true);
      expect(((r as { ok: true; out: { children: string[] } }).out.children).slice().sort()).toEqual(canonical);
    }
    expect(store2.listEvents().filter((e) => e.event_type === "WORK_DECOMPOSED").length).toBe(1);
    store2.verifyIntegrity();
  });

  it("DECOMP-R1-CONFLICT-RACE: different decomposition ids → one winner, zero loser children", async () => {
    const { ctx, biz } = makeBizCtx("dc-conf-race");
    const b = makeBiz(biz, ctx.projectId);
    const parent = wi(biz, String(b.business_id), {});
    const [r1, r2] = await runRace([
      {
        op: "decompose", dbPath: ctx.dbPath,
        args: {
          workItemId: String(parent.work_item_id),
          input: { decomposition_id: "PROP-A", children: [{ title: "a0", goal: "g" }, { title: "a1", goal: "g" }] },
        },
      },
      {
        op: "decompose", dbPath: ctx.dbPath,
        args: {
          workItemId: String(parent.work_item_id),
          input: { decomposition_id: "PROP-B", children: [{ title: "b0", goal: "g" }] },
        },
      },
    ]);
    const winners = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok) as Array<{ ok: false; code: string }>;
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].code).toBe("FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT");
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const children = store2
      .list("work_item")
      .filter((w) => String(w.parent_work_item_id ?? "") === String(parent.work_item_id));
    const winnerChildIds = ((winners[0] as { ok: true; out: { children: string[] } }).out.children).slice().sort();
    expect(children.map((c) => String(c.work_item_id)).sort()).toEqual(winnerChildIds);
    expect(store2.get("work_item", String(parent.work_item_id)).decomposition_id)
      .toBeTruthy();
    store2.verifyIntegrity();
  });

  it("DECOMP-R1-CRASH: failed materialization rolls back — no partial decomposition", () => {
    const { ctx, biz, workforce } = makeBizCtx("dc-crash");
    const b = makeBiz(biz, ctx.projectId);
    const parent = wi(biz, String(b.business_id), {});
    // Inject a crash mid-transaction: the second child write throws —
    // the whole decomposition transaction must roll back, leaving no
    // orphan children and no parent binding.
    const original = biz.createWorkItem.bind(biz);
    let calls = 0;
    biz.createWorkItem = ((input: Parameters<typeof biz.createWorkItem>[0]) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("crash mid-materialization"), { code: "FAIL_CLOSED_TEST_INJECTED" });
      }
      return original(input);
    }) as typeof biz.createWorkItem;
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "CRASHY",
      children: [{ title: "c0", goal: "g" }, { title: "c1", goal: "g" }],
    }, "op"))).toBe("FAIL_CLOSED_TEST_INJECTED");
    biz.createWorkItem = original;
    expect(workforce.childrenOf(String(parent.work_item_id)).length).toBe(0);
    expect(String(ctx.store.get("work_item", String(parent.work_item_id)).decomposition_id ?? "")).toBe("");
    // Recovery converges: a different decomposition materializes cleanly.
    const ok = workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "HEALTHY",
      children: [{ title: "h0", goal: "g" }],
    }, "op");
    expect(ok.children.length).toBe(1);
    expect(String(ctx.store.get("work_item", String(parent.work_item_id)).decomposition_id)).toBe("HEALTHY");
    ctx.store.verifyIntegrity();
  });

  it("REVIEW-R1-NAMED: only the configured reviewer may decide", () => {
    const { ctx, biz } = makeBizCtx("rev-r1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const doer = makeAgent(biz, bid, "doer");
    const named = makeAgent(biz, bid, "named");
    const other = makeAgent(biz, bid, "other");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const foreign = makeAgent(biz, String(b2.business_id), "f");
    const item = wi(biz, bid, {
      assignee_agent_id: String(doer.agent_id), requires_review: true,
      reviewer_agent_id: String(named.agent_id),
    });
    biz.openWorkItem(String(item.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(item.work_item_id));
    // Wrong reviewers fail closed — mismatch is checked before scope.
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(other.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEWER_MISMATCH");
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(foreign.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEWER_MISMATCH");
    // Named reviewer inactive → fail closed.
    biz.setOrgAgentStatus(String(named.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(named.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_AGENT_INACTIVE");
    biz.setOrgAgentStatus(String(named.agent_id), "ACTIVE", "op");
    // Assignee configured as its own reviewer → self-review still denied.
    const self = wi(biz, bid, {
      assignee_agent_id: String(doer.agent_id), requires_review: true,
      reviewer_agent_id: String(doer.agent_id),
    });
    biz.openWorkItem(String(self.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(self.work_item_id));
    expect(errCode(() => biz.reviewWorkItem(String(self.work_item_id), {
      reviewer_agent_id: String(doer.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_SELF");
    // The named reviewer succeeds.
    const accepted = biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(named.agent_id), decision: "ACCEPT",
    }, "op");
    expect(String(accepted.status)).toBe("DONE");
  });

  it("REVIEW-R1-API: invalid/missing decisions fail closed — never default ACCEPT", () => {
    const { ctx, biz } = makeBizCtx("rev-r1-api");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const doer = makeAgent(biz, bid, "doer");
    const rev = makeAgent(biz, bid, "rev");
    const item = wi(biz, bid, { assignee_agent_id: String(doer.agent_id), requires_review: true });
    biz.openWorkItem(String(item.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(item.work_item_id));
    for (const bad of ["accept", "", "MAYBE", "DONE", "REWORKED", "ACCEPT "]) {
      expect(errCode(() => biz.reviewWorkItem(String(item.work_item_id), {
        reviewer_agent_id: String(rev.agent_id), decision: bad as never,
      }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_DECISION");
    }
    // Nothing silently defaulted — the item is still awaiting review.
    expect(String(ctx.store.get("work_item", String(item.work_item_id)).status)).toBe("REVIEW_REQUIRED");
    const accepted = biz.reviewWorkItem(String(item.work_item_id), {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT",
    }, "op");
    expect(String(accepted.status)).toBe("DONE");
  });

  it("PARENT-R1: parent cannot DONE while mandatory children incomplete; all DONE releases it", () => {
    const { ctx, biz, workforce } = makeBizCtx("par-r1");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const worker = makeAgent(biz, bid, "worker");
    const parent = wi(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    const child = workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      reason: "r",
    }, "op");
    biz.openWorkItem(String(parent.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(parent.work_item_id));
    const parked = ctx.store.get("work_item", String(parent.work_item_id));
    expect(String(parked.status)).toBe("IN_PROGRESS");
    expect(String(parked.blocked_code)).toBe("CHILD_INCOMPLETE");
    // Review ACCEPT cannot fabricate completion while the child is open —
    // exercised via a second parent already awaiting review, then
    // delegated (children materialize onto a REVIEW_REQUIRED parent).
    const reviewer = makeAgent(biz, bid, "rev");
    const parent2 = wi(biz, bid, {
      assignee_agent_id: String(lead.agent_id), requires_review: true,
      reviewer_agent_id: String(reviewer.agent_id),
    });
    biz.openWorkItem(String(parent2.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(parent2.work_item_id));
    expect(String(ctx.store.get("work_item", String(parent2.work_item_id)).status)).toBe("REVIEW_REQUIRED");
    workforce.delegateWorkItem({
      work_item_id: String(parent2.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      reason: "late child",
    }, "op");
    expect(errCode(() => biz.reviewWorkItem(String(parent2.work_item_id), {
      reviewer_agent_id: String(reviewer.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_PARENT_INCOMPLETE");
    // Child completes → the parked parent resumes and finishes.
    biz.openWorkItem(String(child.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(child.work_item_id));
    expect(String(ctx.store.get("work_item", String(parent.work_item_id)).status)).toBe("DONE");
  });

  it("PARENT-R1-RESTART: a reopened context reconstructs the same completion gate", () => {
    const { ctx, biz, workforce } = makeBizCtx("par-rst");
    const a = new ScriptedAdapter("EXEC_A");
    registerScripted(ctx, a);
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const worker = makeAgent(biz, bid, "worker");
    const parent = wi(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    const child = workforce.delegateWorkItem({
      work_item_id: String(parent.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(worker.agent_id),
      reason: "r",
    }, "op");
    biz.openWorkItem(String(parent.work_item_id), "op");
    completeWorkMission(ctx, biz, a, String(parent.work_item_id));
    expect(String(ctx.store.get("work_item", String(parent.work_item_id)).blocked_code)).toBe("CHILD_INCOMPLETE");
    // Fresh process context — the gate is reconstructed from canonical
    // state, not memory.
    const re = makeBizCtx("par-rst-re", reopenCtx(ctx.dir, "re"));
    // The reopened context keeps the canonical project's workspace.
    re.ctx.workspace = ctx.workspace;
    const a2 = new ScriptedAdapter("EXEC_A2");
    registerScripted(re.ctx, a2);
    re.biz.openWorkItem(String(child.work_item_id), "op");
    completeWorkMission(re.ctx, re.biz, a2, String(child.work_item_id));
    const after = re.ctx.store.get("work_item", String(parent.work_item_id));
    expect(String(after.status)).toBe("DONE");
    expect(String(after.blocked_code ?? "")).toBe("");
    re.ctx.store.verifyIntegrity();
  });

  it("INBOX-R1: inbox is strictly read-only — repeated reads change nothing", () => {
    const { ctx, biz, workforce } = makeBizCtx("inbox-r1");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const ag = makeAgent(biz, bid, "me");
    const pre = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    wi(biz, bid, { assignee_agent_id: String(ag.agent_id), depends_on: [String(pre.work_item_id)] });
    const blocked = wi(biz, bid, { assignee_agent_id: String(ag.agent_id) });
    biz.blockWorkItem(String(blocked.work_item_id), "ops", "op");
    const snapshot = () =>
      JSON.stringify(ctx.store.list("work_item")) +
      "|" + JSON.stringify(ctx.store.list("mission")) +
      "|" + String(ctx.store.listEvents().length);
    const before = snapshot();
    workforce.agentInbox(String(ag.agent_id));
    workforce.agentInbox(String(ag.agent_id));
    workforce.agentInbox(String(ag.agent_id));
    expect(snapshot()).toBe(before);
  });

  it("CAP-R1: incapable assignment never reaches READY at any admission point", () => {
    const { ctx, biz, workforce } = makeBizCtx("cap-r1");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const runner = makeAgent(biz, bid, "runner", []);
    // Direct create with an incapable assignee fails closed.
    expect(errCode(() => wi(biz, bid, {
      assignee_agent_id: String(runner.agent_id), required_capability: "CODE",
    }))).toBe("FAIL_CLOSED_WORK_CAPABILITY");
    // Decomposition to an incapable assignee fails before any child
    // materializes.
    const parent = wi(biz, bid, { required_capability: "CODE" });
    expect(errCode(() => workforce.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: "INCAP",
      children: [{ title: "c", goal: "g", assignee_agent_id: String(runner.agent_id) }],
    }, "op"))).toBe("FAIL_CLOSED_WORK_CAPABILITY");
    expect(workforce.childrenOf(String(parent.work_item_id)).length).toBe(0);
    // Rebuild never promotes an incapable (e.g. legacy) assignment to
    // READY — it lands in explicit BLOCKED_CAPABILITY.
    const legacy = wi(biz, bid, {});
    const row = ctx.store.get("work_item", String(legacy.work_item_id));
    row.assignee_agent_id = String(runner.agent_id);
    row.required_capability = "CODE";
    row.status = "BACKLOG";
    ctx.store.put("work_item", String(legacy.work_item_id), row, Number(row.version));
    biz.rebuildReadiness(bid);
    const healed = ctx.store.get("work_item", String(legacy.work_item_id));
    expect(String(healed.status)).toBe("BLOCKED");
    expect(String(healed.blocked_code)).toBe("BLOCKED_CAPABILITY");
  });
});
