/**
 * P15.6 — OBJECTIVE OPERATING LOOP — adversarial + restart + race matrix.
 *
 * Convention: "forging" = raw SQL rewrite of persisted rows/events,
 * never a new service seam. Every service call that succeeds is REAL —
 * FakeInvoker is only ever the transport boundary of the EXISTING
 * P15.3 CEO cycle. The pass mints real WOB/missions through
 * BusinessLayer.openWorkItem on a REAL MissionControl stack.
 */

import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  assertCanonicalMissionInFlight,
  createDefaultCeoPlanningCycle,
  createDefaultObjectiveOperatingService,
  digest,
  ensureCodexCliCatalog,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
  OBJECTIVE_STRATEGY_REVISION_ENTITY,
  ObjectiveAdaptiveReviewService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  WORKFORCE_ALLOCATION_COMMITTED_EVENT,
  workforceAllocationDigest,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = mkTmpDir("pair-p156-");
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function sqlRewriteEntity(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  fn: (body: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare("SELECT payload FROM entities WHERE entity_type=? AND entity_id=?")
    .get(entityType, entityId) as { payload: string } | undefined;
  if (!row) throw new Error(`entity ${entityType}:${entityId} absent`);
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  fn(body);
  dbOf(store)
    .prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), entityType, entityId);
}

type Stack = {
  dbPath: string;
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  alloc: WorkforceAllocationService;
};

type FullStack = Stack & {
  service: PairControlPlane;
  control: MissionControl;
  runtime: MissionRuntime;
  projectId: string;
};

/** Full governed stack — real MissionControl so openWorkItem mints
 *  canonical bound missions. */
function freshFullStack(name: string): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
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
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({ store, control, schedules,
    // Phase C — the shared async Planner Pool seam: this stub returns a
    // canned canonical llm_plan so delegated opens plan "through the
    // pool" exactly once per open (same shape the production expander
    // yields after failover+canonicalize).
    planExpander: async (input) => ({
      input: {
        ...input,
        metadata: {
          ...(input.metadata as Record<string, unknown> | undefined),
          llm_plan: [{ task_key: "T2", title: "delegated", task_instruction: "work",
            required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
          plan_source: "LLM", plan_model: "test-planner",
        },
      },
      planner: { planner_run_id: "PLR_TEST", attempts: [], winner: { attempt_no: 1 } },
    }) });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { dbPath, dir, store, biz, wf, workstreams, alloc, service,
    control, runtime, projectId: String(project.project_id) };
}

function mkBusiness(s: FullStack) {
  const b = s.biz.createBusiness({ name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  return String(b.business_id);
}

function mkObjective(
  s: Stack, businessId: string,
  kpis: Array<Record<string, unknown>> = [
    { name: "ea_orders", unit: "orders", baseline: 2, target: 10 }],
) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "Tăng đơn EA trên MQL5 từ 2 lên ít nhất 10",
    statement: "Grow EA orders on MQL5",
    kpis,
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["Chỉ bán qua MQL5"],
    success_conditions: ["10 orders"],
    dedup_key: `dk-${counter}`,
    operator_id: OP,
  });
}

function decompose(s: Stack, oid: string, keys: string[] | Array<Record<string, unknown>>) {
  const o = s.biz.objectives.get(oid);
  const workstreams = keys.map((k) => typeof k === "string"
    ? { workstream_key: k, title: `ws ${k}`, goal: `g ${k}` }
    : k);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: workstreams as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Record<string, unknown>, key: string): string {
  const ws = (binding.workstreams as Array<Record<string, unknown>>)
    .find((w) => String(w.workstream_key) === key)!;
  return String(ws.work_item_id);
}

function mkAgent(s: Stack, businessId: string, opts: Record<string, unknown> = {}) {
  return s.biz.createOrgAgent({
    business_id: businessId,
    title: `agent ${counter}`,
    department: "ops",
    operator_id: OP,
    ...opts,
  });
}

function recordKpi(
  s: Stack, oid: string, kpiId: string, value: number, key?: string,
) {
  const bid = String(s.biz.objectives.get(oid).business_id);
  return s.biz.objectives.recordProgress(oid, {
    business_id: bid,
    kpi_id: kpiId,
    value,
    evidence: {
      evidence_key: key ?? `ev-${counter}`,
      verifier: OWNER,
      source: "operator:console",
    },
    actor: OWNER,
  });
}

function expectFail(fn: () => unknown, code: string | RegExp) {
  try {
    fn();
  } catch (e) {
    if (code instanceof RegExp) {
      expect(String((e as { code?: string }).code)).toMatch(code);
    } else {
      expect((e as { code?: string }).code).toBe(code);
    }
    return;
  }
  throw new Error(`expected ${String(code)} — call succeeded`);
}

function rowCount(store: PairEvidenceStore, entity: string): number {
  return store.list(entity).length;
}

/* ---------------- CEO model seeding + fake transport ---------------- */

function qualifyCodexProvider(store: PairEvidenceStore) {
  const id = providerEntryId(CODEX_CLI_PROVIDER_ID);
  const existing = store.tryGet("provider", id) as Record<string, unknown> | null;
  store.put("provider", id, {
    ...(existing ?? { provider_id: CODEX_CLI_PROVIDER_ID, entry_id: id }),
    lifecycle_state: "QUALIFIED",
    auth_state: "AUTH_OK",
    health_state: "READY",
    conditions: [],
    probe_state: "PROBED",
    provider_type: "LOCAL_CLI",
    protocol_family: "CODEX_CLI",
    endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [],
    credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(
    CODEX_CLI_PROVIDER_ID, { policy_version: "test-policy", actor: "test" });
}

function seedDefaultCeoModel(store: PairEvidenceStore): string {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  qualifyCodexProvider(store);
  const mcat = new ModelEvidenceCatalog(store);
  mcat.recordProbeReceipt({
    probe_id: `PRB_ceo_${counter++}`,
    model_entry_id: meId,
    provider_id: CODEX_CLI_PROVIDER_ID,
    result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" },
    latency_ms: 1,
  });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`model qualification failed: ${JSON.stringify(q.gates)}`);
  return meId;
}

class FakeInvoker implements CeoDecisionInvoker {
  inputs: CeoInvokeInput[] = [];
  private queue: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>;
  constructor(...raw: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>) {
    this.queue = raw;
  }
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.inputs.push(input);
    const item = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    const out = typeof item === "function" ? await item(input) : {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: item,
    };
    return out;
  }
}

const decisionJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: "pair.ceo-decision.v1",
    decision_kind: "WAIT",
    workstreams: null,
    priority_order: null,
    wait_reason: "AWAITING_PROGRESS",
    summary: null,
    ...over,
  });

const INIT_JSON = (keys: string[] = ["w1", "w2"]) =>
  decisionJson({
    decision_kind: "INITIALIZE_WORKSTREAMS",
    wait_reason: null,
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}`, depends_on_keys: [],
    })),
    priority_order: keys,
    summary: "initialize workstreams",
  });

const WAIT_JSON = decisionJson();
const PRIORITIZE_JSON = (order: string[]) =>
  decisionJson({
    decision_kind: "PRIORITIZE_EXISTING",
    wait_reason: null,
    priority_order: order,
  });

/** Compose the operating service through §30 wiring — ONE shared CEO
 *  cycle for both P15.6 bootstrap and P15.5 review. */
function opStack(s: FullStack, invoker: CeoDecisionInvoker) {
  return createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams,
    invoker,
  }).service;
}

/** A P15.5 review service over the same stack — commits canonical
 *  review/strategy authority the tests then consume or tamper with. */
function reviewSvc(s: FullStack, invoker: CeoDecisionInvoker) {
  const { service: ceoCycle } = createDefaultCeoPlanningCycle({
    store: s.store, business: s.biz, workforce: s.wf, invoker,
  });
  return new ObjectiveAdaptiveReviewService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams, ceoCycle,
  });
}

function seeded(
  name: string,
  invoker: CeoDecisionInvoker,
  keys: Array<string | Record<string, unknown>> = [
    "w1", { workstream_key: "w2", title: "w2", goal: "g2", depends_on_keys: ["w1"] }],
  kpis?: Array<Record<string, unknown>>,
) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid, kpis);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, keys as never);
  const agent = mkAgent(s, bid);
  seedDefaultCeoModel(s.store);
  const ops = opStack(s, invoker);
  return { s, oid, bid, binding, agent, ops, invoker };
}

/** The delegated child pinned by a workstream's canonical WAL. */
function childOfKey(
  s: Stack, binding: Record<string, unknown>, key: string,
): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
    .find((r) =>
      String((r as Record<string, unknown>).workstream_work_item_id) === wid) as
      Record<string, unknown> | undefined;
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: Stack, childId: string): string {
  const row = s.store.get("work_item", childId);
  const mission = s.biz.boundMissionForWorkItem(row);
  if (!mission) throw new Error(`no bound mission for ${childId}`);
  return String(mission.mission_id);
}

/** Drive mission mid to canonical RUNNING. */
function missionRunning(s: FullStack, mid: string) {
  if (String(s.store.get("mission", mid).status) === "CREATED") {
    s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
  }
  s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
}

/** Fold a workstream's delegated child to canonical DONE: open,
 *  complete the bound mission, sync + cascade through the real seams. */
function completeWorkstream(s: FullStack, binding: Record<string, unknown>, key: string) {
  const cid = childOfKey(s, binding, key);
  const row = s.store.get("work_item", cid);
  if (String(row.status) === "READY") {
    s.biz.openWorkItem(cid, OP);
  }
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  s.biz.syncWorkItem(cid);
  s.biz.advanceCompletionCascade(cid);
  return cid;
}

/* ============================ TESTS ============================ */

describe("P15.6 §31 — end-to-end initial objective", () => {
  it("1. ACTIVE objective → CEO INITIALIZE → binding → allocate → open → ONE mission", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1", "w2"]));
    const s = freshFullStack("e2e");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const ops = opStack(s, inv);

    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w1");
    expect(inv.inputs.length).toBe(1); // exactly ONE CEO call

    const binding = s.workstreams.getBinding(oid)!;
    expect(binding).toBeTruthy();
    // Root + containers never opened
    const root = s.store.get("work_item", String(binding.root_work_item_id));
    expect(String(root.status)).not.toBe("IN_PROGRESS");
    const w1id = wsWorkItemId(binding, "w1");
    const w1 = s.store.get("work_item", w1id);
    expect(String(w1.status)).not.toBe("IN_PROGRESS"); // container — never opened
    // Exactly one WAL / WDEL / WOB / Mission for the child
    const wals = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
      .filter((x) => String((x as Record<string, unknown>).objective_id) === oid);
    expect(wals.length).toBe(1);
    const childId = String((wals[0] as Record<string, unknown>).delegated_child_work_item_id);
    expect(childId.startsWith("DL_")).toBe(true);
    const child = s.store.get("work_item", childId);
    expect(String(child.status)).toBe("IN_PROGRESS");
    expect(String(child.assignee_agent_id)).toBeTruthy();
    const wobs = s.store.list("work_open_binding")
      .filter((x) => String((x as Record<string, unknown>).work_item_id) === childId);
    expect(wobs.length).toBe(1);
    const missions = s.store.list("mission");
    expect(missions.length).toBe(1);
    const mid = boundMissionId(s, childId);
    expect(String(r.mission_id)).toBe(mid);
    const mission = s.store.get("mission", mid);
    expect(String((mission.metadata as Record<string, unknown>).work_item_id)).toBe(childId);
    // Zero executor routing / telegram writes by the pass itself
    expect(rowCount(s.store, "routing_decision")).toBe(0);
    expect(rowCount(s.store, "telegram_delivery")).toBe(0);
    s.store.close();
  });
});

describe("P15.6 §32 — restart convergence", () => {
  it("2. restart-A: INITIALIZE committed, no allocation → continue, no 2nd CEO call", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const s = freshFullStack("ra");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const ops = opStack(s, inv);
    // Simulate: CEO INITIALIZE already committed by an earlier pass.
    const cycle = await (await import("../pair/index.js")).createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
    }).service.runCycle({ objective_id: oid, actor: OP });
    expect(String(cycle.decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    expect(inv.inputs.length).toBe(1);
    // Crash — next pass continues from the binding, zero new CEO call.
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(inv.inputs.length).toBe(1); // no second CEO initialization
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("3. restart-B: WAL + canonical READY child, no mission → open exact same child", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, ops } = seeded("rb", inv);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(a.delegated_child_work_item_id);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.delegated_child_work_item_id).toBe(childId); // exact child
    expect(inv.inputs.length).toBe(0); // zero CEO/model calls — §13
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("4. restart-C: live bound mission → AWAITING_EXECUTION, zero new Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("rc", inv);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = boundMissionId(s, childId);
    missionRunning(s, mid);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_EXECUTION");
    expect(r.mission_id).toBe(mid);
    expect(s.store.list("mission").length).toBe(1);
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("5. restart-D: terminal mission, child IN_PROGRESS → fold + cascade → dispatch w2", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, ops } = seeded("rd", inv);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = boundMissionId(s, childId);
    canonicallyCompleteMission(s.store, s.service, mid);
    // Crash BEFORE sync — child still IN_PROGRESS with terminal mission.
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    // fold happened through existing sync/cascade; w1 exhausted → w2
    // (depends w1) is now unlockable → non-bootstrap → P15.5 review runs
    // first per §12; FakeInvoker WAIT → WAITING.
    expect(["DISPATCHED", "WAITING", "AWAITING_EXECUTION"]).toContain(r.outcome);
    const c1 = s.store.get("work_item", childId);
    expect(String(c1.status)).not.toBe("IN_PROGRESS"); // folded
    // No duplicate mission for child 1
    const wobs = s.store.list("work_open_binding")
      .filter((x) => String((x as Record<string, unknown>).work_item_id) === childId);
    expect(wobs.length).toBe(1);
    s.store.close();
  });

  it("6. restart-E: committed PRIORITIZE strategy → pass consumes same strategy order", async () => {
    const inv = new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"]));
    const { s, oid, binding, ops } = seeded("re", inv, ["w1", "w2"]); // both independent
    // Commit the strategy through the canonical P15.5 path.
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      ceoCycle: (await import("../pair/index.js")).createDefaultCeoPlanningCycle({
        store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
      }).service,
    });
    const rev = await review.runReview({ objective_id: oid, actor: OP });
    expect(rev.outcome).toBe("PRIORITIZE_EXISTING");
    expect(rev.strategy_revision).toBeTruthy();
    // Crash before launch — next pass consumes the SAME strategy.
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w2"); // actionable_order [w2,w1]
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });
});

describe("P15.6 §33 — strategy application", () => {
  // R2.E — non-vacuous: canonical strategy [w2,w1] committed while no
  // work is active, then canonical WALs for BOTH workstreams (both
  // delegated children READY, zero Missions). The pass must still obey
  // the strategy order: w2 opens, w1 stays READY with zero Mission.
  it("7. strategy [w2,w1] + BOTH children READY → w2 opens, w1 stays READY (non-vacuous)", async () => {
    const inv = new FakeInvoker(WAIT_JSON); // pass never reaches a model call
    const { s, oid, bid, ops, binding } = seeded("st1", inv, ["w1", "w2"]);
    void bid;
    // Commit canonical P15.5 PRIORITIZE strategy [w2,w1] while no work
    // is active (separate review service instance — same canonical
    // seams, the committed strategy is what matters).
    const rr = await reviewSvc(
      s, new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])))
      .runReview({ objective_id: oid, actor: OP });
    expect(String(rr.outcome)).toBe("PRIORITIZE_EXISTING");
    // Canonical P15.4 allocations for BOTH workstreams — no opens.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w2", actor: OP });
    const w1child = childOfKey(s, binding, "w1");
    const w2child = childOfKey(s, binding, "w2");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w2"); // strategy order wins
    expect(r.mission_id).toBeTruthy();
    const mission = s.store.get("mission", String(r.mission_id));
    expect(String((mission.metadata as Record<string, unknown>).work_item_id))
      .toBe(w2child);
    // w1 remains READY with zero bound Mission; total Missions = 1.
    expect(String(s.store.get("work_item", w1child).status)).toBe("READY");
    expect(s.biz.boundMissionForWorkItem(s.store.get("work_item", w1child))).toBe(null);
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("7b. no strategy + BOTH children READY → canonical binding order (w1)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("st1b", inv, ["w1", "w2"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w2", actor: OP });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w1");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("7c. (superseded-by-7) strategy single-allocation ordering still holds", async () => {
    const inv = new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"]));
    const { s, oid, ops } = seeded("st1c", inv, ["w1", "w2"]);
    // Allocate w2 only — WAL exists → launchable path opens w2.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w2", actor: OP });
    // Commit strategy w2>w1 via canonical review.
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      ceoCycle: (await import("../pair/index.js")).createDefaultCeoPlanningCycle({
        store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
      }).service,
    });
    await review.runReview({ objective_id: oid, actor: OP });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key === undefined || r.workstream_key === "w2").toBe(true);
    expect(s.store.list("mission").length).toBe(1); // w1 never dispatched
    s.store.close();
  });

  it("8. no strategy → canonical binding order dispatch", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1", "w2"]));
    const s = freshFullStack("st2");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const ops = opStack(s, inv);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    const binding = s.workstreams.getBinding(oid)!;
    const first = String((binding.workstreams as Array<Record<string, unknown>>)[0]!.workstream_key);
    expect(r.workstream_key).toBe(first);
    s.store.close();
  });

  it("9. strategy head dependency_blocked → next independent item dispatches", async () => {
    const inv = new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"]));
    const { s, oid, binding, ops } = seeded("st3", inv,
      ["w1", { workstream_key: "w2", title: "w2", goal: "g2", depends_on_keys: ["w1"] }]);
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      ceoCycle: (await import("../pair/index.js")).createDefaultCeoPlanningCycle({
        store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
      }).service,
    });
    const rev = await review.runReview({ objective_id: oid, actor: OP });
    expect(rev.outcome).toBe("PRIORITIZE_EXISTING");
    expect(rev.strategy_revision!.actionable_order).toEqual(["w2", "w1"]);
    // w2 depends on incomplete w1 → dependency_blocked → w1 dispatches.
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w1");
    expect(r.blocked_workstream_keys).toEqual(["w2"]);
    s.store.close();
  });

  it("10. forged latest strategy → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("st4", inv);
    // Forge a strategy revision row attributed to this objective.
    s.store.put(OBJECTIVE_STRATEGY_REVISION_ENTITY, "SR_FORGED", {
      schema: "pair.os.vnext.strategy-revision.v1",
      strategy_revision_id: "SR_FORGED",
      objective_id: oid,
      review_id: "REV_FAKE",
      previous_revision_id: null,
      priority_order: ["w2", "w1"],
      actionable_order: ["w2", "w1"],
      reason: "forged",
      created_at: "t", created_by: "x", version: 0,
    }, 0);
    await expect(
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("11. strategy changes only through canonical P15.5 → next pass follows it", async () => {
    const inv = new FakeInvoker(
      PRIORITIZE_JSON(["w2", "w1"]),
      PRIORITIZE_JSON(["w1", "w2"]),
    );
    const { s, oid, ops } = seeded("st5", inv, ["w1", "w2"]);
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      ceoCycle: (await import("../pair/index.js")).createDefaultCeoPlanningCycle({
        store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
      }).service,
    });
    const r1 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("PRIORITIZE_EXISTING");
    const pass1 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(pass1.outcome).toBe("DISPATCHED");
    expect(pass1.workstream_key).toBe("w2");
    // w2 now has a live bound mission → AWAITING; move state forward:
    // complete w2 canonically, then a NEW canonical P15.5 review flips
    // priority to w1 (different observation → new model call).
    completeWorkstream(s, s.workstreams.getBinding(oid)!, "w2");
    const r2 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r2.outcome).toBe("PRIORITIZE_EXISTING");
    const pass2 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(pass2.outcome).toBe("DISPATCHED");
    expect(pass2.workstream_key).toBe("w1");
    s.store.close();
  });
});

describe("P15.6 §34 — stop boundaries", () => {
  it("12. all KPI targets canonically MET → TARGET_MET_CANDIDATE, zero alloc/open", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const { s, oid, ops } = seeded("sb1", inv);
    recordKpi(s, oid, "KPI_1", 10, "ev-met");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(r.owner_action_required).toBe(true);
    // Committed via the canonical P15.5 review
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(1);
    expect(s.store.list("mission").length).toBe(0);
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY).length).toBe(0);
    s.store.close();
  });

  it("12b. targets MET pre-binding → non-authoritative TARGET_MET, zero CEO call", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const s = freshFullStack("sb1b");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    recordKpi(s, oid, "KPI_1", 10, "ev-met2");
    const ops = opStack(s, inv);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(inv.inputs.length).toBe(0); // ZERO CEO initialization
    expect(s.workstreams.getBinding(oid)).toBeNull();
    s.store.close();
  });

  it("13. budget exhausted → OBJECTIVE_BUDGET_EXHAUSTED, zero Mission/CEO", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const s = freshFullStack("sb2");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    // Canonical spend up to the ceiling.
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-x",
      amount_microusd: 500_000_000, actor: "op",
    });
    const ops = opStack(s, inv);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_BUDGET_EXHAUSTED");
    expect(inv.inputs.length).toBe(0);
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("14. P15.5 WAIT → zero new Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("sb3", inv);
    // Bootstrap exception does NOT apply — seed a review so the pass
    // must consult P15.5 before allocating (binding + zero launchable).
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    // child BLOCKED → intervention; nothing launchable; WAL exists → not bootstrap.
    const wal = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
      .find((x) => String((x as Record<string, unknown>).objective_id) === oid)!;
    const cid = String((wal as Record<string, unknown>).delegated_child_work_item_id);
    s.biz.blockWorkItem(cid, "op block", OP);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("WAITING");
    expect(inv.inputs.length).toBe(1); // one bounded review model call
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("15. TOPOLOGY_CHANGE_REQUIRED → zero graph mutation / zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, ops } = seeded("sb4", inv, ["w1"]);
    // Complete w1 canonically while KPIs still GAP → exhausted+gap → TOPOLOGY.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    completeWorkstream(s, binding, "w1");
    const bindingBefore = s.workstreams.getBinding(oid)!;
    recordKpi(s, oid, "KPI_1", 5, "ev-gap"); // verified GAP (5 < 10)
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TOPOLOGY_CHANGE_REQUIRED");
    expect(s.store.list("mission").length).toBe(1); // only the completed one
    const bindingAfter = s.workstreams.getBinding(oid)!;
    expect(String(bindingAfter.binding_id)).toBe(String(bindingBefore.binding_id));
    s.store.close();
  });

  it("16. INSUFFICIENT_VERIFIED_PROGRESS → zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, ops } = seeded("sb5", inv, ["w1"], [
      { name: "a", unit: "u", baseline: 0, target: 10 },
      { name: "b", unit: "u", baseline: 0, target: 5 },
    ]);
    // w1 complete; KPI_1 met, KPI_2 UNVERIFIED (no evidence) → INSUFFICIENT.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    completeWorkstream(s, binding, "w1");
    recordKpi(s, oid, "KPI_1", 10, "ev-a");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("INSUFFICIENT_VERIFIED_PROGRESS");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("17. REVIEW_REQUIRED claim → never auto-ACCEPT/REWORK (forged claim fails closed)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("sb6", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, s.workstreams.getBinding(oid)!, "w1");
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(cid); // honest fold → DONE
    // A forged REVIEW_REQUIRED claim contradicts the derived DONE state
    // — the strict observation fails closed BEFORE any auto action.
    sqlRewriteEntity(s.store, "work_item", cid, (b) => { b.status = "REVIEW_REQUIRED"; });
    await expect(
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    s.store.close();
  });

  it("18. OBJECTIVE_NOT_ACTIVE → zero CEO/allocation/open", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const { s, oid, bid, ops } = seeded("sb7", inv);
    const o = s.biz.objectives.get(oid);
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "CANCELLED",
      expected_objective_version: Number(o.version),
      expected_objective_digest: String(o.objective_digest),
      actor: OWNER, reason: "op cancel",
    });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_NOT_ACTIVE");
    expect(inv.inputs.length).toBe(0);
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY).length).toBe(0);
    s.store.close();
  });
});

describe("P15.6 §35 — execution lifecycle states", () => {
  it("19. PAUSED bound mission → not active progress, no duplicate open", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("lc1", inv, ["w1"]);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    missionRunning(s, mid);
    s.control.pauseMission(mid, OP);
    expect(String(s.store.get("mission", mid).status)).toBe("PAUSED");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("AWAITING_EXECUTION"); // PAUSED ≠ progress
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(s.store.list("mission").length).toBe(1); // no duplicate
    s.store.close();
  });

  it("20. forged child READY→IN_PROGRESS claim without mission → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("lc2", inv, ["w1"]);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = String(a.delegated_child_work_item_id);
    sqlRewriteEntity(s.store, "work_item", cid, (b) => { b.status = "IN_PROGRESS"; });
    await expect(
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    s.store.close();
  });

  it("21. forged child DONE without WCP → fail closed; deps never unlock", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("lc3", inv);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = String(a.delegated_child_work_item_id);
    sqlRewriteEntity(s.store, "work_item", cid, (b) => { b.status = "DONE"; });
    await expect(
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    // w2 still dependency-blocked — forged DONE never unlocks.
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });
});

describe("P15.6 §20/§38 — race convergence + no executor bypass", () => {
  it("22. production diff never references router/executor seams", () => {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "src/pair/objective-operating-loop.ts"), "utf8");
    // Strip comments — the doc header legitimately NAMES the seams it
    // must never call; what matters is code, not prose.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "MissionRouter", "CapabilityRouter", ".route(",
      "CodexExecutor", "DevinExecutor", "DshExecutor", "Hermes",
      "executor_id", "selected_executor",
      "startMission(", "telegram", "Telegram",
    ]) {
      expect(src.includes(forbidden), `source contains ${forbidden}`).toBe(false);
    }
    // The ONLY execution crossing.
    expect(src.includes("openWorkItem")).toBe(true);
  });
});

/* ---------- §37 — REAL concurrency: two worker_threads, two stores ---------- */

const RACE_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p156-race");
const RACE_BUNDLE = path.join(RACE_CACHE, "pair-bundle.mjs");
const RACE_WORKER = path.join(RACE_CACHE, "race-worker.mjs");

const RACE_WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { dbPath, barrier, args, projectId } = workerData;
const store = new PAIR.PairEvidenceStore(dbPath);
const service = new PAIR.PairControlPlane(store);
const gate = new PAIR.GovernedTaskGate(service);
const registry = new PAIR.ExecutorRegistry(service);
const router = new PAIR.MissionRouter(service, gate);
const recovery = new PAIR.RecoveryController(service);
const recon = new PAIR.ReconciliationService(service, new Map());
const approvals = new PAIR.ApprovalQueue(service);
const scheduler = new PAIR.MissionScheduler(service, { mission_concurrency: 2 });
const planner = () => ({ tasks: [] });
const runtime = new PAIR.MissionRuntime({
  service, gate, router, adapters: new Map(), scheduler, approvals,
  reconciliation: recon, recovery, planner,
});
const supervisor = new PAIR.MissionSupervisor(service, runtime, recovery, recon);
const observability = new PAIR.MissionObservability(service);
const control = new PAIR.MissionControl({
  service, runtime, supervisor, scheduler, approvals,
  reconciliation: recon, observability, planner,
});
const schedules = new PAIR.MissionScheduleService(service);
// Phase C — the delegated open needs an authorized plan: stub the shared
// expander with a canonical llm_plan (the open seam only needs non-empty
// plan authority; the race asserts dedup/convergence, not plan quality).
const biz = new PAIR.BusinessLayer({
  store, control, schedules,
  planExpander: async (input) => ({
    input: {
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        llm_plan: [{ task_id: "T1", title: "r", instructions: "r", required_capabilities: [] }],
        plan_source: "LLM",
      },
    },
  }),
});
const wf = new PAIR.WorkforceService({ store, business: biz });
const workstreams = new PAIR.ObjectiveWorkstreamService({
  store, business: biz, workforce: wf, objectives: biz.objectives,
});
const { service: ops } = PAIR.createDefaultObjectiveOperatingService({
  store, business: biz, workforce: wf,
  objectives: biz.objectives, workstreams,
  invoker: { invoke: async (input) => ({
    model_entry_id: input.transport.model_entry_id,
    provider_id: input.transport.provider_id,
    model_id: input.transport.model_id,
    raw_text: JSON.stringify(args.ceoJson),
  }) },
});
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);
try {
  const r = await ops.runObjectivePass({ objective_id: args.objective_id, actor: args.actor });
  parentPort.postMessage({ ok: true, outcome: r.outcome, mission_id: r.mission_id ?? null });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e && e.code ? e.code : String(e) });
}
`;

function ensureRaceBundle() {
  fs.mkdirSync(RACE_CACHE, { recursive: true });
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found");
  // bin/esbuild is a node launcher script (#!/usr/bin/env node) — spawn it
  // through the interpreter so the bundle build is platform-portable.
  execFileSync(process.execPath, [
    esbuild,
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${RACE_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(RACE_WORKER, RACE_WORKER_SOURCE);
}

type PassOutcome2 =
  | { ok: true; outcome: string; mission_id: string | null }
  | { ok: false; code: string };

async function runPassRace(
  ops: Array<{ dbPath: string; projectId: string; args: Record<string, unknown> }>,
): Promise<PassOutcome2[]> {
  ensureRaceBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    ops.map((o) => new Promise<PassOutcome2>((resolve, reject) => {
      const w = new Worker(RACE_WORKER, {
        workerData: { dbPath: o.dbPath, projectId: o.projectId, barrier: gate, args: o.args },
      });
      w.on("message", (msg: Record<string, unknown>) => {
        if (msg.ready === true) {
          readyCount += 1;
          if (readyCount === ops.length) {
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
          }
          return;
        }
        resolve(msg as unknown as PassOutcome2);
      });
      w.on("error", reject);
    })),
  );
}

describe("P15.6 §37 — real concurrency", () => {
  it("23. two passes race one READY allocated child → at most ONE mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid } = seeded("race1", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const results = await runPassRace([
      { dbPath: s.dbPath, projectId: s.projectId,
        args: { objective_id: oid, actor: OP, ceoJson: JSON.parse(WAIT_JSON) } },
      { dbPath: s.dbPath, projectId: s.projectId,
        args: { objective_id: oid, actor: OP, ceoJson: JSON.parse(WAIT_JSON) } },
    ]);
    const missions = s.store.list("mission");
    expect(missions.length).toBe(1); // never duplicate mission authority
    // §21 — exactly one DISPATCHED; the loser either converged through
    // canonical authority (AWAITING_EXECUTION) or failed closed through
    // an existing canonical gate — never a duplicate Mission.
    const dispatched = results.filter((r) => r.ok && r.outcome === "DISPATCHED");
    expect(dispatched.length).toBe(1);
    for (const r of results) {
      if (!r.ok) {
        expect(String(r.code), `loser error ${String(r.code)}`).toMatch(/^FAIL_CLOSED/);
      } else {
        expect(["DISPATCHED", "AWAITING_EXECUTION"]).toContain(r.outcome);
      }
    }
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY).length).toBe(1);
    s.store.close();
  });

  it("24. two passes race INITIALIZE+allocate+open on fresh objective → single binding/WAL/child/mission", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1"]));
    const s = freshFullStack("race2");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const results = await runPassRace([
      { dbPath: s.dbPath, projectId: s.projectId,
        args: { objective_id: oid, actor: OP,
          ceoJson: JSON.parse(INIT_JSON(["w1"])) } },
      { dbPath: s.dbPath, projectId: s.projectId,
        args: { objective_id: oid, actor: OP,
          ceoJson: JSON.parse(INIT_JSON(["w1"])) } },
    ]);
    expect(s.store.list("mission").length).toBe(1);
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY)
      .filter((x) => String((x as Record<string, unknown>).objective_id) === oid).length).toBe(1);
    expect(s.store.list("work_item").filter((x) =>
      String((x as Record<string, unknown>).work_item_id ?? "").startsWith("DL_")).length).toBe(1);
    // Loser may converge or fail closed through a canonical gate
    // (e.g. FAIL_CLOSED_CEO_DECISION_INFLIGHT) — never duplicate authority.
    for (const r of results) {
      if (!r.ok) {
        expect(String(r.code), `loser error ${String(r.code)}`).toMatch(/^FAIL_CLOSED/);
      }
    }
    s.store.close();
  });
});

/* ---------- R2.A — open-race in-flight mission proof ---------- */

describe("P15.6 R2.A — assertCanonicalMissionInFlight", () => {
  /** Canonical child with a bound CREATED mission (post-open state). */
  function openedChild(name: string) {
    const { s, oid, binding } = seeded(name, new FakeInvoker(WAIT_JSON), ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    return { s, oid, cid, mid };
  }

  it("A1. canonical CREATED bound mission → proven in-flight", () => {
    const { s, cid, mid } = openedChild("r2a-created");
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child)).not.toThrow();
    s.store.close();
  });

  it("A2. canonical RUNNING mission (spine + runtime evidence) → in-flight", () => {
    const { s, cid, mid } = openedChild("r2a-running");
    missionRunning(s, mid);
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    // mint + drive the canonical runtime row
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.runtime.transitionRuntime(mid, "RUNNING", "r2a");
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child)).not.toThrow();
    s.store.close();
  });

  it("A2b. mission RUNNING + canonical runtime PAUSED → FAIL in-flight", () => {
    const { s, cid, mid } = openedChild("r2a-rtp");
    missionRunning(s, mid);
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.runtime.transitionRuntime(mid, "RUNNING", "r2a");
    s.runtime.transitionRuntime(mid, "PAUSED", "r2a"); // canonical runtime spine
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/runtime state PAUSED incompatible/);
    s.store.close();
  });

  it("A2c. mission RUNNING + canonical runtime terminal (FAILED) → FAIL in-flight", () => {
    const { s, cid, mid } = openedChild("r2a-rtf");
    missionRunning(s, mid);
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.runtime.transitionRuntime(mid, "RUNNING", "r2a");
    s.runtime.transitionRuntime(mid, "FAILED", "r2a");
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/incompatible|REPLAY|replays? to|runtime/);
    s.store.close();
  });

  it("A2d. canonical PAUSED runtime + forged row.state=RUNNING (recomputed hash) → FAIL", () => {
    const { s, cid, mid } = openedChild("r2a-rtforge");
    missionRunning(s, mid);
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.runtime.transitionRuntime(mid, "RUNNING", "r2a");
    s.runtime.transitionRuntime(mid, "PAUSED", "r2a");
    sqlRewriteEntity(s.store, "mission_runtime", `MRT_${mid}`,
      (b) => { b.state = "RUNNING"; });
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/claims runtime RUNNING but replay derives PAUSED/);
    s.store.close();
  });

  it("A2e. canonical terminal runtime + forged row.state=RUNNING → FAIL", () => {
    const { s, cid, mid } = openedChild("r2a-rtforge2");
    missionRunning(s, mid);
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.runtime.transitionRuntime(mid, "RUNNING", "r2a");
    s.runtime.transitionRuntime(mid, "FAILED", "r2a");
    sqlRewriteEntity(s.store, "mission_runtime", `MRT_${mid}`,
      (b) => { b.state = "RUNNING"; });
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/claims runtime RUNNING but replay derives FAILED/);
    s.store.close();
  });

  it("A2f. forged runtime transition without valid predecessor → FAIL", () => {
    const { s, cid, mid } = openedChild("r2a-rtpred");
    missionRunning(s, mid);
    // Runtime row exists only as CREATED; inject a transition whose
    // old_state does not follow the replayed state.
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    s.store.event({
      entity_type: "mission_runtime", entity_id: `MRT_${mid}`,
      event_type: "MISSION_RUNTIME_TRANSITION",
      old_state: "FAILED", new_state: "RUNNING",
      actor: "forged", metadata: { mission_id: mid },
    });
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/runtime transition from FAILED but replay at READY/);
    s.store.close();
  });

  it("A2g. runtime evidence without a runtime row → FAIL (no silent orphan evidence)", () => {
    const { s, cid, mid } = openedChild("r2a-rtorphan");
    s.runtime.transitionRuntime(mid, "READY", "r2a");
    // Delete the row, leave the committed evidence — corrupt authority.
    dbOf(s.store)
      .prepare("DELETE FROM entities WHERE entity_type=? AND entity_id=?")
      .run("mission_runtime", `MRT_${mid}`);
    const mission = s.store.get("mission", mid); // claimed CREATED
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/runtime evidence exists but the row is missing/);
    s.store.close();
  });

  it("A3. PAUSED mission is NEVER in-flight → converge must fail closed", () => {
    const { s, cid, mid } = openedChild("r2a-paused");
    missionRunning(s, mid);
    s.service.transitionMission(mid, "PAUSED", `OPERATOR:${OP}`);
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/not an in-flight state/);
    s.store.close();
  });

  it("A4. terminal mission never converges as in-flight", () => {
    const { s, cid, mid } = openedChild("r2a-term");
    canonicallyCompleteMission(s.store, s.service, mid);
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/not an in-flight state/);
    s.store.close();
  });

  it("A5. forged RUNNING claim (no transition evidence) → fail closed", () => {
    const { s, cid, mid } = openedChild("r2a-forge");
    sqlRewriteEntity(s.store, "mission", mid, (b) => { b.status = "RUNNING"; });
    const mission = s.store.get("mission", mid);
    const child = s.store.get("work_item", cid);
    expect(() =>
      assertCanonicalMissionInFlight(s.store, mission, child))
      .toThrow(/FAIL_CLOSED/);
    s.store.close();
  });

  it("A6. exactly one Mission remains after a race converge", async () => {
    // covered live by test 23 — here assert the pass-level outcome on a
    // child already in-flight: AWAITING_EXECUTION, zero new Mission.
    const { s, oid, ops, mid } = (() => {
      const r = openedChild("r2a-live");
      const ops = opStack(r.s, new FakeInvoker(WAIT_JSON));
      return { ...r, ops };
    })();
    void mid;
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_EXECUTION");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });
});

/* ---------- R2.B — immutable review/strategy attribution ---------- */

describe("P15.6 R2.B — immutable attribution", () => {
  it("B1. canonical WAIT review rewritten to foreign objective → FAIL CLOSED, never bootstrap", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2b1", inv, ["w1"]);
    // Canonical review history exists for the objective.
    const rr = await reviewSvc(s, new FakeInvoker(WAIT_JSON))
      .runReview({ objective_id: oid, actor: OP });
    const rid = String(rr.review.review_id);
    // Rewrite ONLY the mutable row attribution — the immutable
    // COMMITTED anchor still pins the objective, so the row is
    // discovered through the anchor and strict validation must fail.
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, rid,
      (b) => { b.objective_id = "OBJ_foreign"; });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("B2. canonical strategy row rewritten away → strategy read fails closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2b2", inv, ["w1", "w2"]);
    const rr = await reviewSvc(s, new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])))
      .runReview({ objective_id: oid, actor: OP });
    const sid = String(rr.strategy_revision!.strategy_revision_id);
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY, sid,
      (b) => { b.objective_id = "OBJ_foreign"; });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("B3. foreign objective review/strategy history does not contaminate O", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, ops } = seeded("r2b3a", inv, ["w1"]);
    // A second objective with its own canonical review + strategy.
    const o2 = mkObjective(s, bid);
    const oid2 = String(o2.objective_id);
    decompose(s, oid2, ["x1"]);
    const rr2 = await reviewSvc(s, new FakeInvoker(PRIORITIZE_JSON(["x1"])))
      .runReview({ objective_id: oid2, actor: OP });
    expect(String(rr2.outcome)).toBe("PRIORITIZE_EXISTING");
    // O1 still bootstraps cleanly (zero WAL + zero reviews for O1).
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });
});

/* ---------- R2.C — final dispatch authority re-proof ---------- */

describe("P15.6 R2.C — injected drift before open", () => {
  it("C-A. objective CANCELLED after allocation → OBJECTIVE_NOT_ACTIVE, zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, binding, ops } = seeded("r2c-cancel", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const o = s.biz.objectives.get(oid);
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "CANCELLED",
      expected_objective_version: Number(o.version),
      expected_objective_digest: String(o.objective_digest),
      actor: OWNER, reason: "cancelled mid-flight",
    });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_NOT_ACTIVE");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C-B. KPI target reached after allocation → TARGET_MET_CANDIDATE, zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2c-kpi", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    recordKpi(s, oid, "KPI_1", 10, "ev-r2c");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C-C. budget reaches ceiling after allocation → OBJECTIVE_BUDGET_EXHAUSTED, zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, ops } = seeded("r2c-budget", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-r2c",
      amount_microusd: 500_000_000, actor: OWNER,
    });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_BUDGET_EXHAUSTED");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C-D. WAL child pin tampered after allocation → FAIL CLOSED, zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, ops } = seeded("r2c-wal", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const walRow = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
      .find((r) => String((r as Record<string, unknown>).delegated_child_work_item_id) === cid)!;
    sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
      String((walRow as Record<string, unknown>).allocation_id ??
             (walRow as Record<string, unknown>).workforce_allocation_id),
      (b) => { b.delegated_child_work_item_id = "WI_forged"; });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C-E. strategy tampered after review → FAIL CLOSED, zero Mission", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2c-strat", inv, ["w1", "w2"]);
    const rr = await reviewSvc(s, new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])))
      .runReview({ objective_id: oid, actor: OP });
    const sid = String(rr.strategy_revision!.strategy_revision_id);
    // Mutate the committed order — the strict chain read must fail
    // before P15.6 may allocate/open anything.
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY, sid,
      (b) => { b.actionable_order = ["w1", "w2"]; });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C-F. admission pin: stale objective version → FAIL at open seam, zero intent/mission", () => {
    const { s, oid, binding } = seeded("r2c-adm", new FakeInvoker(WAIT_JSON), ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const o = s.biz.objectives.get(oid);
    expect(() => s.biz.openWorkItem(cid, OP, {
      objective_id: oid,
      expected_objective_version: Number(o.version) + 1,
    })).toThrow(/FAIL_CLOSED_OBJECTIVE_STALE_FOR_OPEN/);
    expect(s.store.list("mission").length).toBe(0);
    expect(s.store.list("work_open_binding").length).toBe(0);
    expect(String(s.store.get("work_item", cid).status)).toBe("READY");
    s.store.close();
  });

  it("C-G. admission pin: exact version → opens normally", () => {
    const { s, oid, binding } = seeded("r2c-admok", new FakeInvoker(WAIT_JSON), ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const o = s.biz.objectives.get(oid);
    const row = s.biz.openWorkItem(cid, OP, {
      objective_id: oid,
      expected_objective_version: Number(o.version),
    });
    expect(String(row.status)).toBe("IN_PROGRESS");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });
});

/* ---------- R2.D — per-pass internal step bound ---------- */

describe("P15.6 R2.D — independent per-pass bounds", () => {
  it("D1. concurrent passes on ONE service instance → independent bounds, no false trip", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2d", inv, ["w1", "w2", "w3", "w4"]);
    // Each pass consumes several internal steps (review + allocate +
    // open); four concurrent passes on a shared global counter would
    // exceed 8 and trip PassBoundExceeded — per-pass ctx must not.
    const results = await Promise.all([
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ]);
    for (const r of results) {
      expect(r.detail ?? "").not.toBe("internal step bound reached");
      expect(["DISPATCHED", "AWAITING_EXECUTION", "WAITING"]).toContain(r.outcome);
    }
    expect(s.store.list("mission").length).toBeLessThanOrEqual(1);
    s.store.close();
  });

  it("D2. sequential passes each get a fresh 8-step budget", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, ops } = seeded("r2d2", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const r1 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("DISPATCHED");
    // Passes 2..5 observe AWAITING_EXECUTION — a shared counter would
    // eventually trip the bound; each must return the real outcome.
    for (let i = 0; i < 4; i++) {
      const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
      expect(r.outcome).toBe("AWAITING_EXECUTION");
      expect(r.detail ?? "").not.toBe("internal step bound reached");
    }
    s.store.close();
  });
});

/* ---------- R3.B — stale strategy / injected-drift closure ---------- */

describe("P15.6 R3.B — injected drift at real between-seam boundaries", () => {
  /** Exit bootstrap: commit ONE canonical WAIT review, then move KPI
   *  so the pass's own review is fresh → PRIORITIZE path reached. */
  async function nonBootstrap(name: string, invoker: CeoDecisionInvoker,
      keys: Array<string | Record<string, unknown>> = ["w1", "w2"]) {
    const first = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, binding, ops } = seeded(name, invoker, keys);
    await reviewSvc(s, first).runReview({ objective_id: oid, actor: OP });
    // move canonical external state so the next review is new
    recordKpi(s, oid, "KPI_1", 3, `ev-nb-${counter}`);
    return { s, oid, bid, binding, ops };
  }

  it("A. KPI drift AFTER review BEFORE allocation → stale strategy not applied, zero Mission", async () => {
    const { s, oid, ops } = await nonBootstrap(
      "r3b-drift", new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])));
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      hooks: { afterReview: () => {
        // still-GAP but materially different measurement
        recordKpi(s, oid, "KPI_1", 4, `ev-drift-${counter}`);
      } },
    });
    expect(r.outcome).toBe("WAITING");
    expect(String(r.detail ?? "")).toContain("drifted");
    expect(s.store.list("mission").length).toBe(0);
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY).length).toBe(0);
    s.store.close();
  });

  it("B. newer valid strategy committed after review → old order cannot dispatch", async () => {
    const { s, oid, ops } = await nonBootstrap(
      "r3b-newstrat", new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])));
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      hooks: { afterReview: () => {
        // Canonical external change + a NEWER committed strategy.
        recordKpi(s, oid, "KPI_1", 4, `ev-ns-${counter}`);
        void reviewSvc(s, new FakeInvoker(PRIORITIZE_JSON(["w1", "w2"])))
          .runReview({ objective_id: oid, actor: OP });
      } },
    });
    expect(r.outcome).toBe("WAITING");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("C. KPI target reached AFTER allocation BEFORE open → zero Mission", async () => {
    const { s, oid, ops } = seeded(
      "r3b-kpi", new FakeInvoker(WAIT_JSON), ["w1"]);
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      hooks: { beforeOpen: () => {
        recordKpi(s, oid, "KPI_1", 10, `ev-met-bo-${counter}`);
      } },
    });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("D. objective CANCELLED after allocation before open → zero Mission", async () => {
    const { s, oid, bid, ops } = seeded(
      "r3b-cancel", new FakeInvoker(WAIT_JSON), ["w1"]);
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      hooks: { beforeOpen: () => {
        const o = s.biz.objectives.get(oid);
        s.biz.objectives.transitionStatus(oid, {
          business_id: bid, to: "CANCELLED",
          expected_objective_version: Number(o.version),
          expected_objective_digest: String(o.objective_digest),
          actor: OWNER, reason: "cancelled between allocate and open",
        });
      } },
    });
    expect(r.outcome).toBe("OBJECTIVE_NOT_ACTIVE");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("E. budget reaches ceiling after allocation before open → zero Mission", async () => {
    const { s, oid, bid, ops } = seeded(
      "r3b-budget", new FakeInvoker(WAIT_JSON), ["w1"]);
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      hooks: { beforeOpen: () => {
        s.biz.objectives.accountBudget(oid, {
          business_id: bid, spend_key: `sp-bo-${counter}`,
          amount_microusd: 500_000_000, actor: OWNER,
        });
      } },
    });
    expect(r.outcome).toBe("OBJECTIVE_BUDGET_EXHAUSTED");
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("F. normal PRIORITIZE → allocate → open PASS; own WAL write does not false-trip", async () => {
    const { s, oid, ops } = await nonBootstrap(
      "r3b-normal", new FakeInvoker(PRIORITIZE_JSON(["w2", "w1"])));
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.workstream_key).toBe("w2");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  it("G. restart with existing canonical WAL READY → same child opens via governed seam, no duplicate allocation", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding } = seeded("r3b-restart", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const walBefore = s.store.list(WORKFORCE_ALLOCATION_ENTITY).length;
    // Fresh operating service over the same durable store — restart.
    const ops2 = opStack(s, new FakeInvoker(WAIT_JSON));
    const r = await ops2.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(r.delegated_child_work_item_id).toBe(cid);
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY).length).toBe(walBefore); // zero duplicate
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });
});

/* ---------- R3 followup F1 — every AWAITING_EXECUTION is proven ---------- */

describe("P15.6 F1 — early AWAITING_EXECUTION must be proven", () => {
  /** child IN_PROGRESS + canonical RUNNING mission (spine + runtime). */
  function runningChild(name: string) {
    const { s, oid, binding, ops } = seeded(name, new FakeInvoker(WAIT_JSON), ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    missionRunning(s, mid);
    s.runtime.transitionRuntime(mid, "READY", "f1");
    s.runtime.transitionRuntime(mid, "RUNNING", "f1");
    return { s, oid, ops, cid, mid };
  }

  it("F1-control: canonical in-flight child → proven AWAITING_EXECUTION", async () => {
    const { s, oid, ops } = runningChild("f1-ok");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_EXECUTION");
    s.store.close();
  });

  it("F1-a. runtime row rewritten after canonical RUNNING spine → FAIL CLOSED, not AWAITING", async () => {
    const { s, oid, ops, mid } = runningChild("f1-rewrite");
    sqlRewriteEntity(s.store, "mission_runtime", `MRT_${mid}`,
      (b) => { b.state = "FAILED"; });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    s.store.close();
  });

  it("F1-b. runtime transition evidence forged → FAIL CLOSED, not AWAITING", async () => {
    const { s, oid, ops, mid } = runningChild("f1-evforge");
    s.store.event({
      entity_type: "mission_runtime", entity_id: `MRT_${mid}`,
      event_type: "MISSION_RUNTIME_TRANSITION",
      old_state: "FAILED", new_state: "RUNNING",
      actor: "forged", metadata: { mission_id: mid },
    });
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    s.store.close();
  });

  it("F1-c. runtime evidence orphaned (row deleted) → FAIL CLOSED", async () => {
    const { s, oid, ops, mid } = runningChild("f1-orphan");
    dbOf(s.store)
      .prepare("DELETE FROM entities WHERE entity_type=? AND entity_id=?")
      .run("mission_runtime", `MRT_${mid}`);
    await expect(ops.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: /FAIL_CLOSED/ });
    s.store.close();
  });
});

/* ---------- R3 followup F2 — admission pins the actual child lineage ---------- */

describe("P15.6 F2 — objective admission bound to the child lineage", () => {
  it("F2-a. admission pinned to a FOREIGN objective (same version) → FAIL before WOB/mission", async () => {
    const { s, bid, binding } = seeded("f2-lineage", new FakeInvoker(WAIT_JSON), ["w1"]);
    // Objective A (the child's canonical lineage) and foreign B.
    const oA = s.biz.objectives.get(
      String(binding.objective_id));
    const oidA = String(oA.objective_id);
    s.alloc.allocateWorkstream({ objective_id: oidA, workstream_key: "w1", actor: OP });
    const cidA = childOfKey(s, binding, "w1");
    const oB = mkObjective(s, bid);
    const oidB = String(oB.objective_id);
    // Deliberately pin objective B on child of A — even a matching
    // version can never be its lineage.
    expect(() => s.biz.openWorkItem(cidA, OP, {
      objective_id: oidB,
      expected_objective_version: Number(oB.version),
    })).toThrow(/FAIL_CLOSED_OBJECTIVE_LINEAGE_FOR_OPEN/);
    expect(s.store.list("work_open_binding").length).toBe(0);
    expect(s.store.list("mission").length).toBe(0);
    expect(String(s.store.get("work_item", cidA).status)).toBe("READY");
    s.store.close();
  });

  it("F2-b. admission without any WAL lineage → FAIL closed", () => {
    const { s, bid } = seeded("f2-nowal", new FakeInvoker(WAIT_JSON), ["w1"]);
    // Plain P14 work item with zero objective lineage.
    const wi = s.biz.createWorkItem({
      business_id: bid, title: "p14 item", goal: "g", operator_id: OP,
    });
    const oB = mkObjective(s, bid);
    expect(() => s.biz.openWorkItem(String(wi.work_item_id), OP, {
      objective_id: String(oB.objective_id),
      expected_objective_version: Number(oB.version),
    })).toThrow(/FAIL_CLOSED_OBJECTIVE_LINEAGE_FOR_OPEN/);
    s.store.close();
  });

  it("F2-c. correct lineage admission still opens (control)", () => {
    const { s, binding } = seeded("f2-ok", new FakeInvoker(WAIT_JSON), ["w1"]);
    const oid = String(binding.objective_id);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const o = s.biz.objectives.get(oid);
    const row = s.biz.openWorkItem(cid, OP, {
      objective_id: oid,
      expected_objective_version: Number(o.version),
    });
    expect(String(row.status)).toBe("IN_PROGRESS");
    expect(s.store.list("mission").length).toBe(1);
    s.store.close();
  });

  /** Locate the single WAL row + its committed anchor for a child. */
  function walOf(
    s: { store: PairEvidenceStore }, childId: string) {
    const row = s.store.list(WORKFORCE_ALLOCATION_ENTITY).find((r) =>
      String((r as Record<string, unknown>).delegated_child_work_item_id)
        === childId) as Record<string, unknown>;
    const anchor = s.store
      .listEvents(WORKFORCE_ALLOCATION_ENTITY, String(row.allocation_id))
      .find((e) => String(e.event_type) === WORKFORCE_ALLOCATION_COMMITTED_EVENT)!;
    return { row, anchor };
  }

  it("R4-a. WAL objective_id rewritten to B (anchor untouched) → admission B FAIL CLOSED", () => {
    const { s, bid, binding } = seeded("r4-forge", new FakeInvoker(WAIT_JSON), ["w1"]);
    const oidA = String(binding.objective_id);
    s.alloc.allocateWorkstream({ objective_id: oidA, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const oB = mkObjective(s, bid);
    const oidB = String(oB.objective_id);
    const { row } = walOf(s, cid);
    // Rewrite the mutable pin — the immutable anchor keeps saying A.
    sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
      String(row.allocation_id), (b) => { b.objective_id = oidB; });
    expect(() => s.biz.openWorkItem(cid, OP, {
      objective_id: oidB,
      expected_objective_version: Number(oB.version),
    })).toThrow(/FAIL_CLOSED/);
    expect(s.store.list("work_open_binding").length).toBe(0);
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("R4-b. coherent re-hash forgery (objective→B + recomputed allocation_digest) → still FAIL", () => {
    const { s, bid, binding } = seeded("r4-rehash", new FakeInvoker(WAIT_JSON), ["w1"]);
    const oidA = String(binding.objective_id);
    s.alloc.allocateWorkstream({ objective_id: oidA, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const oB = mkObjective(s, bid);
    const oidB = String(oB.objective_id);
    const { row } = walOf(s, cid);
    // Fully self-consistent mutable forgery: payload_hash AND
    // allocation_digest recomputed — only the immutable anchor
    // disagrees. On audited HEAD this passed F2's row-field check.
    sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
      String(row.allocation_id), (b) => {
        b.objective_id = oidB;
        b.allocation_digest = workforceAllocationDigest(b);
      });
    expect(() => s.biz.openWorkItem(cid, OP, {
      objective_id: oidB,
      expected_objective_version: Number(oB.version),
    })).toThrow(/FAIL_CLOSED/);
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("R4-c. WAL committed anchor deleted → FAIL CLOSED", () => {
    const { s, binding } = seeded("r4-noanchor", new FakeInvoker(WAIT_JSON), ["w1"]);
    const oid = String(binding.objective_id);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const cid = childOfKey(s, binding, "w1");
    const { anchor } = walOf(s, cid);
    dbOf(s.store).prepare("DELETE FROM events WHERE event_id=?")
      .run(String(anchor.event_id));
    const o = s.biz.objectives.get(oid);
    expect(() => s.biz.openWorkItem(cid, OP, {
      objective_id: oid,
      expected_objective_version: Number(o.version),
    })).toThrow(/FAIL_CLOSED/);
    expect(s.store.list("mission").length).toBe(0);
    s.store.close();
  });

  it("R4-d. P14 open WITHOUT objective admission still works (unchanged)", () => {
    const { s, bid } = seeded("r4-p14", new FakeInvoker(WAIT_JSON), ["w1"]);
    const agent = mkAgent(s, bid, { title: "p14-agent" });
    const wi = s.biz.createWorkItem({
      business_id: bid, title: "p14 item", goal: "g",
      assignee_agent_id: String(agent.agent_id), operator_id: OP,
    });
    const row = s.biz.openWorkItem(String(wi.work_item_id), OP);
    expect(String(row.status)).toBe("IN_PROGRESS");
    s.store.close();
  });
});

/* ===================== P0-F3 — ZERO_BUDGET classification =====================
 * Defect: objective with unset/default budget (ceiling_microusd=0,
 * consumed=0) was classified OBJECTIVE_BUDGET_EXHAUSTED. Canonical
 * semantics (P15.7 budgetView contract): ceiling=0 is ZERO_BUDGET — a
 * hard bound, never "exhausted", never "uncapped". The loop must report
 * OBJECTIVE_ZERO_BUDGET and still refuse new work. */
describe("P0-F3 — objective zero-budget classification", () => {
  /** Objective with NO budget_ceiling_microusd — the UI/API default. */
  function mkZeroBudgetObjective(s: FullStack, bid: string) {
    return s.biz.objectives.create({
      business_id: bid,
      title: "zero-budget objective",
      statement: "prove default 0/0 classification",
      kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      dedup_key: `dk-${counter}`,
      operator_id: OP,
    });
  }

  it("F3-a. default 0/0 objective → OBJECTIVE_ZERO_BUDGET (never EXHAUSTED), blocked, zero CEO spend", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1"]));
    const s = freshFullStack("zb");
    const bid = mkBusiness(s);
    const o = mkZeroBudgetObjective(s, bid);
    const oid = String(o.objective_id);
    expect(Number((o.budget as Record<string, unknown>).ceiling_microusd)).toBe(0);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const ops = opStack(s, inv);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_ZERO_BUDGET");
    expect(r.outcome).not.toBe("OBJECTIVE_BUDGET_EXHAUSTED");
    expect(inv.inputs.length).toBe(0); // zero bound — no CEO call authorized
    s.store.close();
  });

  it("F3-b. explicit positive ceiling with headroom is unaffected (dispatches)", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1", "w2"]));
    const { s, oid, ops } = seeded("pb-pos", inv, ["w1", "w2"]);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    s.store.close();
  });

  it("F3-c. positive ceiling genuinely consumed → OBJECTIVE_BUDGET_EXHAUSTED preserved", async () => {
    const inv = new FakeInvoker(INIT_JSON(["w1"]));
    const s = freshFullStack("pb-exh");
    const bid = mkBusiness(s);
    const o = s.biz.objectives.create({
      business_id: bid, title: "exhausted", statement: "cap reached",
      kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 100,
      dedup_key: `dk-${counter}`, operator_id: OP,
    });
    const oid = String(o.objective_id);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "s1", amount_microusd: 100, actor: OWNER,
    });
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const ops = opStack(s, inv);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_BUDGET_EXHAUSTED");
    s.store.close();
  });

  it("F3-d. explicit zero ceiling still hard-blocks any positive spend at the ledger", () => {
    const s = freshFullStack("zb-ledger");
    const bid = mkBusiness(s);
    const o = mkZeroBudgetObjective(s, bid);
    const oid = String(o.objective_id);
    expect(() =>
      s.biz.objectives.accountBudget(oid, {
        business_id: bid, spend_key: "s1", amount_microusd: 1, actor: OWNER,
      }),
    ).toThrow(/FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED/);
    s.store.close();
  });

  it("F3-e. ZERO_BUDGET outcome continues as owner-action block in the auto scheduler", async () => {
    const { outcomeContinuation } = await import("../pair/objective-auto-scheduler.js");
    const c = outcomeContinuation("OBJECTIVE_ZERO_BUDGET");
    expect(c.state).toBe("BLOCKED_AUTHORITY");
    expect(c.blocked_reason).toBe("BUDGET_OWNER_ACTION_REQUIRED");
  });
});
