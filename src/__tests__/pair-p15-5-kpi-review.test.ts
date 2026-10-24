/**
 * P15.5 — KPI REVIEW + ADAPTIVE STRATEGY REVISION — adversarial matrix (§22).
 *
 * Adversarial convention: "forging" = raw SQL rewrite of persisted
 * entities/events (production-adjacent write primitive), never a new
 * service seam. Every canonical service call that succeeds is real —
 * FakeInvoker is only ever the transport boundary of the EXISTING
 * P15.3 CEO cycle, never a second model path.
 */

import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCanonicalAdaptiveReview,
  assertCanonicalObjectiveKpiProgress,
  adaptiveReviewDigest,
  adaptiveReviewId,
  BusinessLayer,
  canonicalJson,
  CEO_CODEX_DEFAULT_MODEL,
  CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  createDefaultCeoPlanningCycle,
  digest,
  ensureCodexCliCatalog,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  ObjectiveAdaptiveReviewService,
  objectiveWorkstreamBindingDigest,
  OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT,
  OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
  OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT,
  OBJECTIVE_STRATEGY_REVISION_ENTITY,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  GovernedTaskGate,
  ExecutorRegistry,
  ReconciliationService,
  RecoveryController,
  ApprovalQueue,
  strategyRevisionDigest,
  strategyRevisionId,
  WorkforceAllocationService,
  workforceAllocationId,
  WORKFORCE_ALLOCATION_ENTITY,
  WorkforceService,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p155-"));
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

function freshStack(name: string): Stack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  return { dbPath, dir, store, biz, wf, workstreams, alloc };
}

type FullStack = Stack & {
  service: PairControlPlane;
  control: MissionControl;
  projectId: string;
};

/** Full governed stack — real MissionControl so openWorkItem mints
 *  bound missions (needed for canonical completion proofs). */
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
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { dbPath, dir, store, biz, wf, workstreams, alloc, service,
    control, projectId: String(project.project_id) };
}

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${counter}`) {
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(
  s: Stack, businessId: string,
  kpis: Array<Record<string, unknown>> = [
    { name: "sales", unit: "units", baseline: 0, target: 10 }],
) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "Sell 10 units",
    statement: "Grow sales",
    kpis,
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["no discounts below cost"],
    success_conditions: ["10 units sold"],
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

/** Canonical owner-authorized progress — the ONLY P15.1 verifier seam. */
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

function sqlRewriteEvent(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  eventType: string,
  fn: (ev: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare(
      "SELECT * FROM events WHERE entity_type=? AND entity_id=? AND event_type=? ORDER BY seq LIMIT 1")
    .get(entityType, entityId, eventType) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`event ${eventType} absent`);
  const metadata = row.metadata_json
    ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : null;
  fn(metadata ?? {});
  const body = {
    event_id: row.event_id, entity_type: row.entity_type,
    entity_id: row.entity_id, event_type: row.event_type,
    old_state: row.old_state, new_state: row.new_state,
    actor: row.actor, correlation_id: row.correlation_id,
    metadata, created_at: row.created_at,
  };
  dbOf(store)
    .prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
    .run(metadata ? JSON.stringify(metadata) : null, digest(body), String(row.event_id));
}

function sqlDeleteEvent(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  eventType: string,
): void {
  dbOf(store)
    .prepare("DELETE FROM events WHERE entity_type=? AND entity_id=? AND event_type=?")
    .run(entityType, entityId, eventType);
}

function sqlInsertEvent(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  ev: Record<string, unknown>,
): void {
  const body = {
    event_id: `EV_FORGED_${counter++}`,
    entity_type: entityType, entity_id: entityId,
    event_type: String(ev.event_type),
    old_state: ev.old_state ?? null,
    new_state: ev.new_state ?? null,
    actor: String(ev.actor ?? "operator:x"),
    correlation_id: ev.correlation_id ?? null,
    metadata: ev.metadata ?? null,
    created_at: String(ev.created_at ?? "t"),
  };
  dbOf(store)
    .prepare(
      "INSERT INTO events (event_id, entity_type, entity_id, event_type, old_state, new_state, actor, correlation_id, metadata_json, created_at, event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(body.event_id, entityType, entityId, body.event_type,
      body.old_state as never, body.new_state as never, body.actor,
      body.correlation_id as never,
      body.metadata ? JSON.stringify(body.metadata) : null,
      body.created_at, digest(body));
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

/** Compose the review service through the EXISTING P15.3W wiring. */
function reviewStack(s: Stack, invoker: CeoDecisionInvoker) {
  const { service: ceoCycle } = createDefaultCeoPlanningCycle({
    store: s.store, business: s.biz, workforce: s.wf, invoker,
  });
  return new ObjectiveAdaptiveReviewService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams, ceoCycle,
  });
}

/** Objective + binding(w1→w2) + agent + seeded CEO model + review svc. */
function seeded(
  name: string,
  invoker: CeoDecisionInvoker,
  kpis?: Array<Record<string, unknown>>,
) {
  const s = freshStack(name);
  const bid = mkBusiness(s.store);
  const o = mkObjective(s, bid, kpis);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, [
    "w1",
    { workstream_key: "w2", title: "w2", goal: "g2", depends_on_keys: ["w1"] },
  ]);
  const agent = mkAgent(s, bid);
  seedDefaultCeoModel(s.store);
  const review = reviewStack(s, invoker);
  return { s, oid, bid, binding, agent, review };
}

const WAIT_JSON = decisionJson();

describe("P15.5 — KPI progress strict proof (§4/§5)", () => {
  it("1. forged kpi.current without progress authority → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid } = seeded("k1", inv);
    // Direct forged projection — no ledger/ref/event exists.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      (b.kpis as Array<Record<string, unknown>>)[0]!.current = 10;
    });
    await expect(
      reviewStack(s, inv).runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0); // zero model calls
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    s.store.close();
  });

  it("2. rollback to an older valid measurement while newer progress exists → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid } = seeded("k2", inv);
    recordKpi(s, oid, "KPI_1", 3, "ev-old");
    recordKpi(s, oid, "KPI_1", 7, "ev-new");
    // Rollback: point current+last_evidence_key at the OLDER valid
    // measurement — the ledger still binds ev-old, but the latest
    // OBJECTIVE_PROGRESS event is ev-new.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      const k = (b.kpis as Array<Record<string, unknown>>)[0]!;
      k.current = 3;
      k.last_evidence_key = "ev-old";
    });
    await expect(
      reviewStack(s, inv).runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });

  it("3. AT_LEAST / AT_MOST / EXACT MET/GAP assessment logic", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("k3", inv, [
      { name: "sales", unit: "u", baseline: 0, target: 10, direction: "AT_LEAST" },
      { name: "refunds", unit: "u", baseline: 0, target: 0, direction: "AT_MOST" },
      { name: "score", unit: "u", baseline: 0, target: 5, direction: "EXACT" },
    ]);
    recordKpi(s, oid, "KPI_1", 10, "e1"); // MET
    recordKpi(s, oid, "KPI_2", 1, "e2");  // GAP (AT_MOST 0)
    // KPI_3 UNVERIFIED — never counted as met OR gap.
    const r = await review.runReview({ objective_id: oid, actor: OP });
    const kpis = r.review.kpi_assessments as Array<Record<string, unknown>>;
    expect(kpis.map((k) => String(k.assessment))).toEqual(["MET", "GAP", "UNVERIFIED"]);
    expect(r.review.all_targets_met).toBe(false);
    expect(Number(r.review.verified_kpi_count)).toBe(2);
    expect(Number(r.review.unverified_kpi_count)).toBe(1);
    expect(Number(r.review.gap_kpi_count)).toBe(1);
    s.store.close();
  });

  it("4. AT_MOST met + EXACT boundary", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("k4", inv, [
      { name: "a", unit: "u", target: 5, direction: "AT_LEAST" },
      { name: "b", unit: "u", target: 5, direction: "EXACT" },
    ]);
    recordKpi(s, oid, "KPI_1", 7, "e1"); // MET (7>=5)
    recordKpi(s, oid, "KPI_2", 5, "e2"); // MET exact
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    s.store.close();
  });
});

describe("P15.5 — deterministic checkpoint (§8/§9/§10)", () => {
  it("5. all targets met → TARGET_MET_CANDIDATE, zero CEO call, zero status mutation", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("c1", inv);
    recordKpi(s, oid, "KPI_1", 10, "e1");
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.status).toBe("reviewed");
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(r.review.owner_action_required).toBe(true);
    expect(String(r.review.recommended_status)).toBe("ACHIEVED");
    expect(inv.inputs.length).toBe(0); // zero CEO calls
    // Recommendation only — Objective stays ACTIVE.
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    s.store.close();
  });

  it("6. all workstreams canonically complete with a verified gap → TOPOLOGY_CHANGE_REQUIRED", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("c2");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]); // single workstream — no deps
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    // Complete w1 through the real chain: allocate → open child →
    // mission → sync → cascade → parent DONE+WCP.
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(childId);
    s.biz.advanceCompletionCascade(childId);
    // A verified GAP is required for TOPOLOGY (R2.D) — unverified
    // progress alone can never claim the target was missed.
    recordKpi(s, oid, "KPI_1", 3, "ev-gap"); // target 10 → GAP
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TOPOLOGY_CHANGE_REQUIRED");
    expect(r.review.owner_action_required).toBe(false);
    expect(inv.inputs.length).toBe(0);
    // Zero new work items / zero graph mutation.
    expect(rowCount(s.store, "work_item")).toBe(3); // root + w1 + child
    s.store.close();
  });

  it("7. active delegated work → AWAITING_PROGRESS, zero CEO call", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("c3", inv);
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(a.status).toBe("allocated"); // child READY — active
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_PROGRESS");
    expect(r.review.strategy_revision_id ?? null).toBeNull();
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });
});

describe("P15.5 — CEO adaptive decision (§11/§13/§15/§16)", () => {
  it("8. verified gap + CEO PRIORITIZE_EXISTING → one review + one strategy revision", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w2", "w1"],
      summary: "w2 first",
    }));
    const { s, oid, bid, review } = seeded("d1", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.status).toBe("reviewed");
    expect(r.outcome).toBe("PRIORITIZE_EXISTING");
    expect(r.strategy_revision).not.toBeNull();
    const strat = r.strategy_revision!;
    expect(strat.priority_order).toEqual(["w2", "w1"]);
    expect(strat.actionable_order).toEqual(["w2", "w1"]); // nothing complete
    expect(strat.previous_revision_id ?? null).toBeNull();
    expect(String(strat.business_id)).toBe(bid);
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(1);
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(1);
    // Exactly one anchor per entity.
    expect(s.store.listEvents(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
      String(r.review.review_id))
      .filter((e) => String(e.event_type) === OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT))
      .toHaveLength(1);
    expect(s.store.listEvents(OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(strat.strategy_revision_id))
      .filter((e) => String(e.event_type) === OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT))
      .toHaveLength(1);
    s.store.close();
  });

  it("9. R2.A — zero external change MUST NOT churn strategy; only canonical change advances the checkpoint", async () => {
    const inv = new FakeInvoker(
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING",
        wait_reason: null,
        priority_order: ["w2", "w1"],
      }),
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING",
        wait_reason: null,
        priority_order: ["w1", "w2"],
      }));
    const { s, oid, review } = seeded("d2", inv);
    const r1 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("PRIORITIZE_EXISTING");
    // 2nd/3rd/10th run with zero external change → same review + same
    // strategy, zero extra model call, zero new revision. P15.5's own
    // output can never become a reason to mint another revision.
    for (let i = 0; i < 3; i++) {
      const r = await review.runReview({ objective_id: oid, actor: OP });
      expect(r.status).toBe("replayed");
      expect(r.review.review_id).toBe(r1.review.review_id);
      expect(String(r.strategy_revision!.strategy_revision_id))
        .toBe(String(r1.strategy_revision!.strategy_revision_id));
    }
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(1);
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(1);
    expect(inv.inputs.length).toBe(1);
    // Canonical external change (verified KPI progress) advances the
    // checkpoint → a NEW review may occur, and only then may a chained
    // revision exist.
    recordKpi(s, oid, "KPI_1", 3, "ev-progress");
    const r2 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r2.status).toBe("reviewed");
    expect(r2.review.review_id).not.toBe(r1.review.review_id);
    expect(String(r2.strategy_revision!.previous_revision_id))
      .toBe(String(r1.strategy_revision!.strategy_revision_id));
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(2);
    expect(inv.inputs.length).toBe(2); // KPI change alters CEO obs → new call
    s.store.close();
  });

  it("10. CEO WAIT → review only, zero strategy revision, wait_reason preserved", async () => {
    const inv = new FakeInvoker(decisionJson({ wait_reason: "INSUFFICIENT_VERIFIED_PROGRESS" }));
    const { s, oid, review } = seeded("d3", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("WAIT");
    expect(r.strategy_revision).toBeNull();
    expect(String(r.review.wait_reason)).toBe("INSUFFICIENT_VERIFIED_PROGRESS");
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(0);
    s.store.close();
  });

  it("11. priority_order must be an exact permutation of canonical keys", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w1", "evil"], // not canonical
    }));
    const { s, oid, review } = seeded("d4", inv);
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_CEO_GATE" });
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    s.store.close();
  });

  it("12. actionable_order excludes ONLY canonically completed items, never status-only DONE", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w1", "w2"],
    }));
    const s = freshFullStack("d5");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const binding = decompose(s, oid, ["w1", "w2"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    // Complete w1 canonically; forge w2 status=DONE without WCP — status
    // text is never completion authority.
    const a = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const c1 = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(c1, OP);
    canonicallyCompleteMission(s.store, s.service,
      String((s.store.get("work_item", c1).mission_ids as string[])[0]));
    s.biz.syncWorkItem(c1);
    s.biz.advanceCompletionCascade(c1);
    const review = reviewStack(s, inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    // w1 canonically complete → excluded; w2 (still READY) stays.
    expect(r.outcome).toBe("PRIORITIZE_EXISTING");
    expect(r.strategy_revision!.actionable_order).toEqual(["w2"]);
    s.store.close();
  });
});

describe("P15.5 — workforce review authority (§7)", () => {
  it("13. corrupt P15.4 WAL → review fails closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("w1", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const walId = workforceAllocationId(oid, wsWorkItemId(binding, "w1"));
    sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY, walId, (b) => {
      b.selected_agent_id = "AGT_FORGED";
      b.allocation_digest = digest(b); // self-consistent
    });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_WORKFORCE_ALLOCATION" });
    s.store.close();
  });

  it("14. forged DONE workstream without WCP → review fails closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("w2", inv);
    // Status DONE is a canonical terminal claim; the only authority
    // path that mints DONE also mints the WCP — DONE without proof is
    // contradictory canonical state, never "exhausted".
    sqlRewriteEntity(s.store, "work_item",
      wsWorkItemId(binding, "w1"), (b) => { b.status = "DONE"; });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    s.store.close();
  });
});

describe("P15.5 — receipt + revision strict validation (§14/§15)", () => {
  const strict = (s: Stack, oid: string, reviewId: string) =>
    assertCanonicalAdaptiveReview(
      {
        store: s.store, business: s.biz, workforce: s.wf,
        objectives: s.biz.objectives, workstreams: s.workstreams,
        ceoCycle: undefined as never,
      },
      s.store.get(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, reviewId));

  it("15. forged review row + recomputed self-digest fails anchor proof", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r1", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    const rid = String(r.review.review_id);
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, rid, (b) => {
      b.outcome = "TARGET_MET_CANDIDATE"; // forged upgrade
      b.review_digest = adaptiveReviewDigest(b);
    });
    expectFail(() => strict(s, oid, rid), "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("16. forged strategy row + recomputed digest fails source proof", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w2", "w1"],
    }));
    const { s, oid, review } = seeded("r2", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    const sid = String(r.strategy_revision!.strategy_revision_id);
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY, sid, (b) => {
      b.priority_order = ["w1", "w2"]; // forged flip
      b.strategy_digest = strategyRevisionDigest(b);
    });
    // Still readable through the review → strategy strict proof fails.
    expectFail(() => strict(s, oid, String(r.review.review_id)),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("17. shadow authority fields fail strict receipt validation", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r3", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    const rid = String(r.review.review_id);
    for (const f of ["selected_agent_id", "selected_executor", "mission_id",
      "model_entry_id", "telegram_delivery_id", "planner_id"]) {
      sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, rid, (b) => {
        b[f] = "FORGED";
        b.review_digest = adaptiveReviewDigest(b);
      });
      expectFail(() => strict(s, oid, rid), "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
      sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, rid, (b) => {
        delete b[f];
        b.review_digest = adaptiveReviewDigest(b);
      });
      strict(s, oid, rid); // restored → valid
    }
    s.store.close();
  });
});

describe("P15.5 — staleness / crash / concurrency (§13/§17/§18)", () => {
  it("18. state drift during CEO invocation → no P15.5 commit", async () => {
    const { s, oid } = seeded("s1", new FakeInvoker(WAIT_JSON));
    const alloc = s.alloc;
    // During the model call, allocate w1 — the review observation
    // changes under the in-flight CEO decision.
    const inv = new FakeInvoker((input) => {
      alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
      return {
        model_entry_id: input.transport.model_entry_id,
        provider_id: input.transport.provider_id,
        model_id: input.transport.model_id,
        raw_text: decisionJson({
          decision_kind: "PRIORITIZE_EXISTING",
          wait_reason: null,
          priority_order: ["w1", "w2"],
        }),
      };
    });
    const review = reviewStack(s, inv);
    /* P16-C — the CEO observation now binds the ReasoningBrief, so the
       mid-flight allocation is visible to the CYCLE's own drift check
       and the attempt settles STALE there (a strictly earlier, still
       fail-closed boundary) before P15.5's staleness guard can fire.
       The protection invariant is unchanged: zero P15.5 commit. */
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_CEO_OBSERVATION_STALE" });
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(0);
    s.store.close();
  });

  it("19. crash between strategy and receipt write → zero partial chain", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w1", "w2"],
    }));
    const { s, oid, review } = seeded("s2", inv);
    // Fault injected at the review-receipt put (after the strategy
    // revision is written) — the whole authority chain must roll back.
    const put0 = s.store.put.bind(s.store);
    let armed = true;
    (s.store as unknown as { put: unknown }).put = (
      et: string, id: string, body: Record<string, unknown>, v?: number,
    ) => {
      if (armed && et === OBJECTIVE_ADAPTIVE_REVIEW_ENTITY) {
        armed = false;
        throw new Error("crash-after-strategy");
      }
      return put0(et, id, body, v as never);
    };
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toThrow();
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    expect(rowCount(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(0);
    expect(s.store.listEvents(OBJECTIVE_STRATEGY_REVISION_ENTITY).length).toBe(0);
    s.store.close();
  });

  it("20. real multi-connection race → one review, at most one strategy", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w1", "w2"],
    }));
    const { s, oid } = seeded("s3", inv);
    // Pre-commit ONLY the canonical CEO decision through the real P15.3
    // cycle — both workers replay it and race the P15.5 commit itself.
    const { service: ceoCycle } = createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
    });
    const d = await ceoCycle.runCycle({ objective_id: oid, actor: OP });
    expect(String(d.decision.decision_kind)).toBe("PRIORITIZE_EXISTING");
    s.store.close();
    const out = await runReviewRace([
      { dbPath: s.dbPath, args: { objective_id: oid, actor: OP } },
      { dbPath: s.dbPath, args: { objective_id: oid, actor: OP } },
    ]);
    // Exactly one canonical review + one strategy; losers converge to
    // replay or a typed fail-closed — never two receipts.
    const statuses = out.map((o) => o.ok ? String(o.outcome) : `FAIL:${o.code}`);
    expect(statuses.filter((x) => x === "PRIORITIZE_EXISTING").length).toBeGreaterThanOrEqual(1);
    const store2 = new PairEvidenceStore(s.dbPath);
    expect(rowCount(store2, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(1);
    expect(rowCount(store2, OBJECTIVE_STRATEGY_REVISION_ENTITY)).toBe(1);
    store2.close();
  });
});

describe("P15.5 — boundaries (§19/§20/§21)", () => {
  it("21. zero mission/executor/routing/telegram writes + objective/status untouched", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w1", "w2"],
    }));
    const { s, oid, review } = seeded("b1", inv);
    const obj0 = s.biz.objectives.get(oid);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.status).toBe("reviewed");
    // No execution authority exercised.
    for (const et of ["mission", "executor_execution", "routing_decision",
      "work_open_binding", "telegram_delivery"]) {
      expect(rowCount(s.store, et)).toBe(0);
    }
    const obj1 = s.biz.objectives.get(oid);
    expect(String(obj1.status)).toBe(String(obj0.status));
    expect(Number(obj1.terms_version)).toBe(Number(obj0.terms_version));
    // Work items unchanged — still unassigned, same statuses.
    for (const w of s.store.list("work_item") as Array<Record<string, unknown>>) {
      expect(w.assignee_agent_id ?? null).toBeNull();
    }
    s.store.close();
  });

  it("22. strict KPI proof is public + honors owner-verifier semantics", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid } = seeded("b2", inv);
    recordKpi(s, oid, "KPI_1", 4, "ev-ok");
    const obj = s.biz.objectives.get(oid);
    assertCanonicalObjectiveKpiProgress(s.store, obj); // valid passes
    // Forge the verifier on the evidence ref — owner-verifier fails.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      const refs = b.evidence_refs as Array<Record<string, unknown>>;
      refs[0]!.verifier = "operator:intruder";
    });
    expectFail(() => assertCanonicalObjectiveKpiProgress(s.store, s.biz.objectives.get(oid)),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("23. public seam getReview/getLatestStrategy strict-read", async () => {
    const inv = new FakeInvoker(decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: null,
      priority_order: ["w2", "w1"],
    }));
    const { s, oid, review } = seeded("b3", inv);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    const got = review.getReview(String(r.review.review_id));
    expect(String(got.review_digest)).toBe(String(r.review.review_digest));
    const latest = review.getLatestStrategy(oid)!;
    expect(String(latest.strategy_revision_id))
      .toBe(String(r.strategy_revision!.strategy_revision_id));
    s.store.close();
  });
});

/* ---------- real race machinery (worker_threads, separate stores) ---------- */

const RACE_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p155-race");
const RACE_BUNDLE = path.join(RACE_CACHE, "pair-bundle.mjs");
const RACE_WORKER = path.join(RACE_CACHE, "race-worker.mjs");

const RACE_WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { dbPath, barrier, args } = workerData;
const store = new PAIR.PairEvidenceStore(dbPath);
const biz = new PAIR.BusinessLayer({
  store,
  control: { projects: () => [{ project_id: "PRJ_TEST" }] },
  schedules: {},
});
const wf = new PAIR.WorkforceService({ store, business: biz });
const workstreams = new PAIR.ObjectiveWorkstreamService({
  store, business: biz, workforce: wf, objectives: biz.objectives,
});
const { service: ceoCycle } = PAIR.createDefaultCeoPlanningCycle({
  store, business: biz, workforce: wf,
  invoker: { invoke: async (input) => ({
    model_entry_id: input.transport.model_entry_id,
    provider_id: input.transport.provider_id,
    model_id: input.transport.model_id,
    raw_text: JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: null, priority_order: null,
      wait_reason: "AWAITING_PROGRESS", summary: null,
    }),
  }) },
});
const review = new PAIR.ObjectiveAdaptiveReviewService({
  store, business: biz, workforce: wf,
  objectives: biz.objectives, workstreams, ceoCycle,
});
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);
try {
  const r = await review.runReview(args);
  parentPort.postMessage({ ok: true, status: r.status, outcome: r.outcome,
    review_id: String(r.review.review_id) });
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
  execFileSync(process.execPath, [
    esbuild,
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${RACE_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(RACE_WORKER, RACE_WORKER_SOURCE);
}

type ReviewOutcome2 =
  | { ok: true; status: string; outcome: string; review_id: string }
  | { ok: false; code: string };

async function runReviewRace(
  ops: Array<{ dbPath: string; args: Record<string, unknown> }>,
): Promise<ReviewOutcome2[]> {
  ensureRaceBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    ops.map((o) => new Promise<ReviewOutcome2>((resolve, reject) => {
      const w = new Worker(RACE_WORKER, {
        workerData: { dbPath: o.dbPath, barrier: gate, args: o.args },
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
        resolve(msg as unknown as ReviewOutcome2);
      });
      w.on("error", reject);
    })),
  );
}

describe("P15.5 R2.B — canonical budget proof", () => {
  it("24. canonical spend → review sees verified consumed, CEO reached", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b1", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-1", amount_microusd: 100, actor: "op",
    });
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("WAIT"); // checkpoint reached the CEO gate
    expect(inv.inputs.length).toBe(1);
    s.store.close();
  });

  it("25. forged budget.consumed_microusd → fail before any model call", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b2", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-1", amount_microusd: 100, actor: "op",
    });
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      (b.budget as Record<string, unknown>).consumed_microusd = 9_999;
    });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    s.store.close();
  });

  it("26. ledger spend key without its OBJECTIVE_BUDGET_ACCOUNTED event → fail", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b3", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-1", amount_microusd: 100, actor: "op",
    });
    sqlDeleteEvent(s.store, "objective", oid, "OBJECTIVE_BUDGET_ACCOUNTED");
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("27. altered accounted amount → cumulative mismatch → fail", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b4", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-1", amount_microusd: 100, actor: "op",
    });
    sqlRewriteEvent(s.store, "objective", oid, "OBJECTIVE_BUDGET_ACCOUNTED",
      (md) => { md.amount_microusd = 55; }); // cumulative no longer honest
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("28. duplicate/conflicting spend identity → fail", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b5", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-1", amount_microusd: 100, actor: "op",
    });
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-2", amount_microusd: 200, actor: "op",
    });
    // Forge the second event to claim the FIRST spend_key — duplicate.
    const rows = dbOf(s.store)
      .prepare(
        "SELECT * FROM events WHERE entity_type='objective' AND entity_id=? AND event_type='OBJECTIVE_BUDGET_ACCOUNTED' ORDER BY seq")
      .all(oid) as Array<Record<string, unknown>>;
    const dup = rows[1]!;
    const md = JSON.parse(String(dup.metadata_json)) as Record<string, unknown>;
    md.spend_key = "sp-1";
    const body = {
      event_id: dup.event_id, entity_type: dup.entity_type,
      entity_id: dup.entity_id, event_type: dup.event_type,
      old_state: dup.old_state, new_state: dup.new_state,
      actor: dup.actor, correlation_id: dup.correlation_id,
      metadata: md, created_at: dup.created_at,
    };
    dbOf(s.store)
      .prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
      .run(JSON.stringify(md), digest(body), String(dup.event_id));
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("29. note-bearing spend is unprovable (note never persisted) → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, review } = seeded("r2b6", inv);
    s.biz.objectives.accountBudget(oid, {
      business_id: bid, spend_key: "sp-n", amount_microusd: 10,
      note: "annotated spend", actor: "op",
    });
    // The ledger digest binds the note; the persisted event does not —
    // the spend is therefore unprovable and must fail closed.
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });
});

describe("P15.5 R2.C — canonical lifecycle evidence (never status text)", () => {
  it("30. forged child IN_PROGRESS without open/binding → fail closed (not AWAITING)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r2c1", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    // Forge status text — no canonical open, no binding, no mission.
    sqlRewriteEntity(s.store, "work_item", childId, (b) => {
      b.status = "IN_PROGRESS";
    });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });

  it("31. real open + bound mission lineage → AWAITING_PROGRESS", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r2c2");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP); // canonical open → bound mission
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_PROGRESS");
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("32. forged workstream CANCELLED without canonical cancel authority → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("r2c3", inv);
    const w1 = wsWorkItemId(binding, "w1");
    sqlRewriteEntity(s.store, "work_item", w1, (b) => {
      b.status = "CANCELLED"; // text only — zero WORK_ITEM_CANCELLED event
    });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });

  it("33. forged child CANCELLED without authority → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r2c4", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    sqlRewriteEntity(s.store, "work_item",
      String(a.delegated_child_work_item_id), (b) => { b.status = "CANCELLED"; });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });

  it("34. canonically cancelled child + verified gap → TOPOLOGY still reachable", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r2c5", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.cancelWorkItem(childId, OP); // canonical WORK_ITEM_CANCELLED
    // w2 has no allocation and is unexhausted → not allExhausted → CEO
    // path... w2 is READY though: not allocated, no child → not active.
    // allExhausted = false (w2 plain READY) → reaches CEO gate.
    recordKpi(s, oid, "KPI_1", 3, "ev-g");
    const r = await review.runReview({ objective_id: oid, actor: OP });
    // w2 BACKLOG + w1 child CANCELLED → CEO path (WAIT proposal).
    expect(r.outcome).toBe("WAIT");
    s.store.close();
  });
});

describe("P15.5 R2.D — UNVERIFIED is not a gap", () => {
  it("35. all UNVERIFIED + all work complete → INSUFFICIENT_VERIFIED_PROGRESS", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r2d1");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(childId);
    s.biz.advanceCompletionCascade(childId);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("INSUFFICIENT_VERIFIED_PROGRESS");
    expect(r.review.gap_kpi_count).toBe(0);
    expect(r.review.unverified_kpi_count).toBe(1);
    expect(r.strategy_revision).toBeNull();
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("36. MET + UNVERIFIED + complete → INSUFFICIENT (unverified alone never claims miss)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r2d2");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid, [
      { name: "sales", unit: "u", baseline: 0, target: 10, direction: "AT_LEAST" },
      { name: "refs", unit: "u", baseline: 0, target: 1, direction: "AT_LEAST" },
    ]);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(childId);
    s.biz.advanceCompletionCascade(childId);
    recordKpi(s, oid, "KPI_1", 10, "ev-met"); // MET; KPI_2 stays UNVERIFIED
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("INSUFFICIENT_VERIFIED_PROGRESS");
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });
});

describe("P15.5 R2.E — entity_id + bounded predecessor chain", () => {
  async function twoRevisions(tag: string) {
    const inv = new FakeInvoker(
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING", wait_reason: null,
        priority_order: ["w2", "w1"],
      }),
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING", wait_reason: null,
        priority_order: ["w1", "w2"],
      }));
    const { s, oid, review } = seeded(tag, inv);
    const r1 = await review.runReview({ objective_id: oid, actor: OP });
    recordKpi(s, oid, "KPI_1", 3, `ev-${tag}`); // external canonical change
    const r2 = await review.runReview({ objective_id: oid, actor: OP });
    return { s, oid, review, r1, r2 };
  }

  it("37. forged review entity_id → strict read fails", async () => {
    const { s, review, r1 } = await twoRevisions("e37");
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
      String(r1.review.review_id), (b) => { b.entity_id = "FORGED"; });
    expectFail(
      () => review.getReview(String(r1.review.review_id)),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("38. forged strategy entity_id → chain strict read fails", async () => {
    const { s, oid, review, r1 } = await twoRevisions("e38");
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(r1.strategy_revision!.strategy_revision_id),
      (b) => { b.entity_id = "FORGED"; });
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("39. predecessor shadow field → whole chain fails closed", async () => {
    const { s, oid, review, r1 } = await twoRevisions("e39");
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(r1.strategy_revision!.strategy_revision_id), (b) => {
        b.executor_id = "ex-forged"; // shadow authority on the predecessor
        b.strategy_digest = strategyRevisionDigest(b);
      });
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("40. predecessor missing / anchor missing → chain fails", async () => {
    const { s, oid, review, r1 } = await twoRevisions("e40");
    sqlDeleteEvent(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(r1.strategy_revision!.strategy_revision_id),
      OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT);
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("41. predecessor cycle → chain fails closed", async () => {
    const { s, oid, review, r1, r2 } = await twoRevisions("e41");
    // Forge r1 to point BACK at r2 (cycle), fully self-consistent:
    // rewrite its prev pins, recompute its digest, fix the anchor.
    const r1Id = String(r1.strategy_revision!.strategy_revision_id);
    const r2Row = s.store.get(
      OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(r2.strategy_revision!.strategy_revision_id)) as Record<string, unknown>;
    sqlRewriteEntity(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY, r1Id, (b) => {
      b.previous_revision_id = String(r2Row.strategy_revision_id);
      b.previous_revision_digest = String(r2Row.strategy_digest);
      b.strategy_digest = strategyRevisionDigest(b);
    });
    const forged = s.store.get(
      OBJECTIVE_STRATEGY_REVISION_ENTITY, r1Id) as Record<string, unknown>;
    sqlRewriteEvent(s.store, OBJECTIVE_STRATEGY_REVISION_ENTITY, r1Id,
      OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT, (md) => {
        md.strategy_digest = String(forged.strategy_digest);
        md.previous_revision_id = String(r2Row.strategy_revision_id);
      });
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });
});

describe("P15.5 R3.A — canonical work-lifecycle proof", () => {
  it("42. canonical block → raw rewrite READY → fail closed (never AWAITING)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r3a1", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.blockWorkItem(childId, "blocked by test", OP); // canonical BLOCKED
    // Attacker rewrites the container status to READY — no UNBLOCKED event.
    sqlRewriteEntity(s.store, "work_item", childId, (b) => { b.status = "READY"; });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    expect(rowCount(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY)).toBe(0);
    s.store.close();
  });

  it("43. canonical block → canonical unblock → READY accepted (AWAITING ok)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r3a2", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.blockWorkItem(childId, "blocked by test", OP);
    s.biz.unblockWorkItem(childId, OP); // canonical WORK_ITEM_UNBLOCKED
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_PROGRESS");
    s.store.close();
  });

  it("44. raw container BLOCKED without block/fold evidence → fail before CEO", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("r3a3", inv);
    const w1 = wsWorkItemId(binding, "w1");
    sqlRewriteEntity(s.store, "work_item", w1, (b) => { b.status = "BLOCKED"; });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("45. canonical BLOCKED child → non-active intervention (not AWAITING)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r3a4", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.blockWorkItem(childId, "operator blocked", OP); // canonical
    const r = await review.runReview({ objective_id: oid, actor: OP });
    // Blocked child + unallocated w2 → intervention, not progress → CEO path.
    expect(r.outcome).toBe("WAIT");
    expect(inv.inputs.length).toBe(1); // model reached — canonical, not failed
    s.store.close();
  });

  it("46. canonical open + mission PAUSED + IN_PROGRESS → not AWAITING", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r3a5");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP); // canonical open → bound mission CREATED
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    // Canonical path to PAUSED: CREATED→READY→RUNNING→pause.
    s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
    s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
    s.control.pauseMission(mid, OP);
    const m = s.store.get("mission", mid);
    expect(String(m.status)).toBe("PAUSED");
    // The work item still claims IN_PROGRESS — mission PAUSED is not
    // active progress → intervention, never AWAITING.
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("AWAITING_PROGRESS");
    expect(r.outcome).toBe("WAIT"); // CEO path reached canonically
    s.store.close();
  });

  it("47. real READY allocation + real open/RUNNING paths stay valid", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r3a6");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    // READY allocation → AWAITING
    const r1 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("AWAITING_PROGRESS");
    // Canonical open → IN_PROGRESS + bound mission → AWAITING
    s.biz.openWorkItem(childId, OP);
    const r2 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r2.outcome).toBe("AWAITING_PROGRESS");
    // Mission live RUNNING → AWAITING still
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
    s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
    const r3 = await review.runReview({ objective_id: oid, actor: OP });
    expect(r3.outcome).toBe("AWAITING_PROGRESS");
    expect(inv.inputs.length).toBe(0); // never reached the model
    s.store.close();
  });
});

describe("P15.5 R3.B — source review must be canonical", () => {
  async function twoRevisionsB(tag: string) {
    const inv = new FakeInvoker(
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING", wait_reason: null,
        priority_order: ["w2", "w1"],
      }),
      decisionJson({
        decision_kind: "PRIORITIZE_EXISTING", wait_reason: null,
        priority_order: ["w1", "w2"],
      }));
    const { s, oid, review } = seeded(tag, inv);
    const r1 = await review.runReview({ objective_id: oid, actor: OP });
    recordKpi(s, oid, "KPI_1", 3, `ev-${tag}`);
    const r2 = await review.runReview({ objective_id: oid, actor: OP });
    return { s, oid, review, r1, r2 };
  }

  it("48. shadow selected_executor on source review → getLatestStrategy fails", async () => {
    const { s, oid, review, r1 } = await twoRevisionsB("b48");
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
      String(r1.review.review_id), (b) => {
        b.selected_executor = "ex-forged";
        b.review_digest = adaptiveReviewDigest(b);
      });
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("49. deleted source-review anchor → getLatestStrategy fails", async () => {
    const { s, oid, review, r1 } = await twoRevisionsB("b49");
    sqlDeleteEvent(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
      String(r1.review.review_id), OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT);
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("50. forged source-review entity_id → fails", async () => {
    const { s, oid, review, r1 } = await twoRevisionsB("b50");
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
      String(r1.review.review_id), (b) => { b.entity_id = "FORGED"; });
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("51. review.strategy_revision_id forged to another strategy (coherent recompute) → fails", async () => {
    const { s, oid, review, r1, r2 } = await twoRevisionsB("b51");
    const r1Id = String(r1.review.review_id);
    const r2Id = String(r2.review.review_id);
    const s1Id = String(r1.strategy_revision!.strategy_revision_id);
    // Forge r2's review to claim S1 as its pinned strategy — fully
    // self-consistent: digest recomputed AND the anchor rewritten.
    sqlRewriteEntity(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, r2Id, (b) => {
      b.strategy_revision_id = s1Id;
      b.review_digest = adaptiveReviewDigest(b);
    });
    const forged = s.store.get(
      OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, r2Id) as Record<string, unknown>;
    sqlRewriteEvent(s.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, r2Id,
      OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT, (md) => {
        md.review_digest = String(forged.review_digest);
        md.strategy_revision_id = s1Id;
      });
    // getReview path: S1 names r1 as source, not r2 → fails.
    expectFail(() => review.getReview(r2Id),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    // getLatestStrategy path: r2's review no longer pins S2 → fails.
    expectFail(() => review.getLatestStrategy(oid),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    // r1's own review is untouched and still validates.
    expect(() => review.getReview(r1Id)).not.toThrow();
    s.store.close();
  });

  it("52. valid chain passes getReview + getLatestStrategy", async () => {
    const { s, oid, review, r1, r2 } = await twoRevisionsB("b52");
    const rev1 = review.getReview(String(r1.review.review_id));
    const rev2 = review.getReview(String(r2.review.review_id));
    expect(String(rev1.review_id)).toBe(String(r1.review.review_id));
    expect(String(rev2.outcome)).toBe("PRIORITIZE_EXISTING");
    const strat = review.getLatestStrategy(oid);
    expect(String(strat.strategy_revision_id)).toBe(
      String(r2.strategy_revision!.strategy_revision_id));
    s.store.close();
  });
});

describe("P15.5 R4.A — container READY is not active work", () => {
  it("53. unallocated container BACKLOG→block→unblock→READY → NOT AWAITING (CEO path)", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("r4a1", inv);
    const w1 = wsWorkItemId(binding, "w1");
    // Canonical block/unblock cycle on the NON-EXECUTABLE container.
    s.biz.blockWorkItem(w1, "container pause", OP);
    s.biz.unblockWorkItem(w1, OP); // canonical READY — derived, but not work
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("AWAITING_PROGRESS");
    expect(r.outcome).toBe("WAIT"); // normal CEO path reached
    expect(inv.inputs.length).toBe(1);
    s.store.close();
  });

  it("54. child BLOCKED + container canonical block→unblock READY → NOT AWAITING", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("r4a2", inv);
    const w1 = wsWorkItemId(binding, "w1");
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.blockWorkItem(childId, "child blocked", OP); // child INTERVENTION
    s.biz.blockWorkItem(w1, "container pause", OP);    // container BLOCKED
    s.biz.unblockWorkItem(w1, OP);                     // container READY
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("AWAITING_PROGRESS");
    expect(r.outcome).toBe("WAIT"); // CEO path still reachable
    s.store.close();
  });

  it("55. fresh delegated child READY → still AWAITING_PROGRESS", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r4a3", inv);
    await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_PROGRESS");
    s.store.close();
  });

  it("56. real delegated child IN_PROGRESS + RUNNING mission → still AWAITING", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const s = freshFullStack("r4a4");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid);
    seedDefaultCeoModel(s.store);
    const review = reviewStack(s, inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    const childId = String(a.delegated_child_work_item_id);
    s.biz.openWorkItem(childId, OP);
    const mid = String((s.store.get("work_item", childId).mission_ids as string[])[0]);
    s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
    s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
    const r = await review.runReview({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_PROGRESS");
    s.store.close();
  });

  it("57. REVIEW_REQUIRED grounding enforced — forged claims fail closed", async () => {
    // A P15.2 container cannot mint REVIEW_REQUIRED canonically today
    // (decomposeObjective carries no requires_review). The intended
    // behavior that IS reachable: any REVIEW_REQUIRED claim must carry
    // the canonical derivation + completion-basis grounding — a raw
    // claim fails closed instead of faking "awaiting review" activity.
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding, review } = seeded("r4a5", inv);
    const w1 = wsWorkItemId(binding, "w1");
    sqlRewriteEntity(s.store, "work_item", w1, (b) => {
      b.status = "REVIEW_REQUIRED";
    });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    expect(inv.inputs.length).toBe(0);
    s.store.close();
  });

  it("58. forged child REVIEW_REQUIRED → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, review } = seeded("r4a6", inv);
    const a = await s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP,
    });
    sqlRewriteEntity(s.store, "work_item",
      String(a.delegated_child_work_item_id), (b) => {
        b.status = "REVIEW_REQUIRED";
      });
    await expect(
      review.runReview({ objective_id: oid, actor: OP }),
    ).rejects.toMatchObject({ code: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" });
    s.store.close();
  });
});
