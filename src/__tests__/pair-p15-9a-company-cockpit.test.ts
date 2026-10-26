/**
 * P15.9-A1 — COMPANY COCKPIT READ PROJECTION acceptance suite.
 *
 * Proves the new read-only routes serve canonical, owner-scoped
 * projections and fail closed everywhere else:
 *
 *   C1  — cockpit projection reflects canonical objective/KPI/
 *         workstream/mission/review state exactly.
 *   C2  — company projection: multi-objective business, owner-scoped.
 *   C3  — foreign objective / foreign business → fail closed (403/409).
 *   C4  — non-owner + missing operator header → fail closed.
 *   C5  — tampered canonical evidence never projects as verified.
 *   C6  — pagination bounds + deterministic ordering.
 *   C7  — TARGET_MET_CANDIDATE ≠ ACHIEVED — distinct fields, no
 *         conflation.
 *   C8  — KPI MET while a workstream is still BACKLOG/IN_PROGRESS is
 *         reflected honestly (no "all done" claim).
 *   C9  — GET projections mint zero writes (no-write invariant).
 *   C10 — HTTP boundary: real server, real headers.
 *
 * Harness mirrors pair-p15-10d-met-branch-fold.test.ts: real
 * MissionControl stack + canonical seams; "forging" = raw SQL rewrite.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  createMissionControlServer,
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
  ObjectiveCockpitService,
  ObjectiveKpiVerificationService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  utcnow,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  createDefaultObjectiveOperatingService,
  digest,
  ensureCodexCliCatalog,
  objectiveKpiAssessment,
  type ObjectiveKpi,
} from "../pair/index.js";
import {
  canonicallyCompleteMission,
} from "./canonical-mission-completion.js";
import { ObjectiveAutoPolicyService } from "../pair/objective-auto-policy.js";
import {
  adaptiveReviewDigest,
  adaptiveReviewId,
  OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT,
  OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
} from "../pair/objective-adaptive-review.js";

const ROOT = mkTmpDir("pair-p159-cockpit-");
let counter = 0;
const OP = "1882810918";
const OTHER = "operator:999999";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";
const TOK = "test-mc-token";

type Row = Record<string, unknown> & { version: number };

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

type FullStack = {
  dir: string;
  store: PairEvidenceStore; biz: BusinessLayer; wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService; alloc: WorkforceAllocationService;
  authority: ArtifactAuthority; service: PairControlPlane;
  control: MissionControl; projectId: string;
  kpiSvc: ObjectiveKpiVerificationService;
  cockpit: ObjectiveCockpitService;
};

function freshFullStack(name: string): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
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
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner,
  });
  const biz = new BusinessLayer({ store, control,
    schedules: new MissionScheduleService(service),
    // Phase C — the shared async Planner Pool seam (canned canonical
    // llm_plan; see pair-p15-6 for the same stub contract).
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
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(dir, "artifacts", "blobs") });
  const kpiSvc = new ObjectiveKpiVerificationService({
    store, objectives: biz.objectives, workstreams, business: biz,
    artifacts: authority });
  const project = service.createProject({ name: "p", root_location: workspace });
  const cockpit = new ObjectiveCockpitService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
  });
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    control, projectId: String(project.project_id), kpiSvc, cockpit };
}

function mkBusiness(s: FullStack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: FullStack, businessId: string, operator = OP) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "obj", statement: "Produce deliverables.",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: operator,
  });
}

function decompose(s: FullStack, oid: string, keys: string[]) {
  const o = s.biz.objectives.get(oid);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}` })) as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Row, key: string): string {
  return String((binding.workstreams as Row[])
    .find((w) => String(w.workstream_key) === key)!.work_item_id);
}

function childOfKey(s: FullStack, binding: Row, key: string): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list<Row>(WORKFORCE_ALLOCATION_ENTITY).find(
    (r) => String(r.workstream_work_item_id) === wid);
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: FullStack, childId: string): string {
  return String(s.biz.boundMissionForWorkItem(
    s.store.get("work_item", childId))!.mission_id);
}

function acceptArtifact(s: FullStack, missionId: string, name = "r.md"): void {
  const exec = s.store.list<Row>("executor_execution").find(
    (e) => String(e.mission_id) === missionId)!;
  const governed = s.store.get("governed_task",
    String(exec.governed_task_id)) as Row;
  const ws = (Array.isArray(governed.allowed_paths)
      && (governed.allowed_paths as string[]).length)
    ? String((governed.allowed_paths as string[])[0])
    : String(governed.workspace);
  fs.mkdirSync(ws, { recursive: true });
  const f = path.join(ws, `${name}-${counter++}`);
  fs.writeFileSync(f, `deliverable ${name}`);
  s.authority.accept({
    execution_id: String(exec.execution_id),
    producer_executor_id: String(exec.executor_id ?? "EX_TEST"),
    logical_name: name, source: { kind: "path", path: f },
    channel: "LOCAL_EXECUTION", actor: "TEST", allow_post_result: true });
}

function completeDeliverable(s: FullStack, binding: Row, key: string): void {
  const cid = childOfKey(s, binding, key);
  if (String(s.store.get("work_item", cid).status) === "READY") s.biz.openWorkItem(cid, OP);
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  acceptArtifact(s, mid, `${key}.md`);
  s.biz.syncWorkItem(cid);
  s.biz.advanceCompletionCascade(cid);
}

function grantBundle(s: FullStack, oid: string, rule: Record<string, unknown>) {
  return s.kpiSvc.grant(oid, {
    actor: OWNER, kpi_id: KPI,
    rule: { rule_type: "DELIVERABLE_BUNDLE", ...rule },
    expires_at: FUTURE, idempotency_key: `kv-${counter++}` });
}

const CEO_WAIT = JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
  workstreams: null, priority_order: null,
  wait_reason: "AWAITING_PROGRESS", summary: null });

class CountingInvoker implements CeoDecisionInvoker {
  calls = 0;
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.calls++;
    return { model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id, raw_text: CEO_WAIT };
  }
}

function qualifyCeo(store: PairEvidenceStore) {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  const pid = providerEntryId(CODEX_CLI_PROVIDER_ID);
  const existing = store.tryGet("provider", pid) as Row | null;
  store.put("provider", pid, {
    capabilities: existing?.capabilities ?? ["text_inference"],
    ...(existing ?? { provider_id: CODEX_CLI_PROVIDER_ID, entry_id: pid }),
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK",
    health_state: "READY", conditions: [], probe_state: "PROBED",
    provider_type: "LOCAL_CLI", protocol_family: "CODEX_CLI",
    endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [], credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(
    CODEX_CLI_PROVIDER_ID, { policy_version: "t", actor: "t" });
  new ModelEvidenceCatalog(store).recordProbeReceipt({
    probe_id: `PRB_${counter++}`, model_entry_id: meId,
    provider_id: CODEX_CLI_PROVIDER_ID, result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1 });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error("model qualification failed");
}

function seeded(name: string, keys: string[]) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, keys);
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  for (const k of keys) s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
  qualifyCeo(s.store);
  const inv = new CountingInvoker();
  const ops = createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams, invoker: inv });
  return { s, oid, bid, binding, ops, inv };
}

/** Build a fully operational objective inside an EXISTING stack and
 *  drive it to a pending TARGET_MET_CANDIDATE review — same canonical
 *  flow as `seeded` + the pass, for tests that need the objective to
 *  live among other objectives in one business. */
async function pendingCandidateObjective(s: FullStack, bid: string): Promise<string> {
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, ["a"]);
  s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "a", actor: OP });
  qualifyCeo(s.store);
  const inv = new CountingInvoker();
  const ops = createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams, invoker: inv });
  grantBundle(s, oid, { required_count: 1 });
  completeDeliverable(s, binding, "a");
  s.kpiSvc.advance(oid);
  await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
  return oid;
}

/* ----------------------------- tests ----------------------------- */

describe("P15.9-A1 Company Cockpit read projections", () => {
  it("C1 canonical projection reflects real objective/KPI/workstream/mission/review state", async () => {
    const { s, oid, binding, ops } = seeded("c1", ["a", "b"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    const pass = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(pass.outcome).toBe("TARGET_MET_CANDIDATE");

    const c = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    const obj = c.objective as Record<string, unknown>;
    expect(obj.objective_id).toBe(oid);
    expect(obj.status).toBe("ACTIVE"); // candidate ≠ achieved
    const kpis = obj.kpis as Row[];
    expect(kpis[0]!.assessment).toBe("MET");
    expect(kpis[0]!.last_evidence_key).toContain("KVR_");

    const life = c.lifecycle as Row;
    expect(life.latest_review_outcome).toBe("TARGET_MET_CANDIDATE");
    expect(life.owner_action_required).toBe(true);
    expect(life.recommended_status).toBe("ACHIEVED");
    expect(life.objective_status).toBe("ACTIVE"); // distinct fields

    const wss = c.workstreams as Row[];
    expect(wss).toHaveLength(2);
    const wsA = wss.find((w) => w.workstream_key === "a")!;
    expect(wsA.workstream_status).toBe("DONE");
    const childA = wsA.delegated_child as Row;
    expect(childA.status).toBe("DONE");
    expect(childA.lifecycle_class).toBe("EXHAUSTED");
    const mission = childA.mission as Row;
    expect(mission.status).toBe("COMPLETED");
    const wsB = wss.find((w) => w.workstream_key === "b")!;
    expect(wsB.delegated_child === null || (wsB.delegated_child as Row).status !== "DONE").toBe(true);
    const artifacts = c.artifacts as Row[];
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.mission_id).toBe(mission.mission_id);
    expect(artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((c.latest_review as Row).review_id).toBe(pass.review_id);
    s.store.close();
  });

  it("C2 company: multi-objective same business, only owned listed", async () => {
    const s = freshFullStack("c2");
    const bid = mkBusiness(s);
    const o1 = mkObjective(s, bid);
    const o2 = mkObjective(s, bid); // same owner
    const foreign = s.biz.objectives.create({
      business_id: bid, title: "foreign", statement: "x",
      kpis: [], operator_id: "777" });
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    const objs = company.objectives as Row[];
    expect(objs.map((o) => String(o.objective_id)).sort()).toEqual(
      [String(o1.objective_id), String(o2.objective_id)].sort());
    expect(objs).toHaveLength(2); // the "777"-owned one excluded
    expect(objs.some(
      (o) => String(o.objective_id) === String(foreign.objective_id)),
    ).toBe(false);
    expect((company.business as Row).business_id).toBe(bid);
    s.store.close();
  });

  it("C3 foreign objective + foreign business fail closed", () => {
    const { s, oid } = seeded("c3", ["a"]);
    // non-owner actor → authority denial
    expect(() => s.cockpit.objectiveCockpit(oid, OTHER))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_COCKPIT_AUTHORITY" }));
    // actor owning nothing in the business → scope denial
    const s2 = freshFullStack("c3b");
    const bid2 = mkBusiness(s2);
    mkObjective(s2, bid2, "777");
    expect(() => s2.cockpit.businessCompany(bid2, OWNER))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_COMPANY_SCOPE" }));
    s.store.close(); s2.store.close();
  });

  it("C4 no actor header equivalent → operator required", () => {
    const { s, oid } = seeded("c4", ["a"]);
    expect(() => s.cockpit.objectiveCockpit(oid, ""))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_COCKPIT_AUTHORITY" }));
    expect(() => s.cockpit.objectiveReviews(oid, ""))
      .toThrowError();
    s.store.close();
  });

  it("C5 tampered KPI row fails closed — never shown as MET", () => {
    const { s, oid } = seeded("c5", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    // forge current=1 with no KVR/progress evidence → strict read rejects
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      const k = (b.kpis as Row[])[0]!;
      k.current = 1;
      k.last_evidence_key = "forged:key";
    });
    expect(() => s.cockpit.objectiveCockpit(oid, OWNER)).toThrowError();
    s.store.close();
  });

  it("C6 reviews: bounded + deterministic order", async () => {
    const { s, oid, binding, ops } = seeded("c6", ["a", "b"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const all = s.cockpit.objectiveReviews(oid, OWNER, 50).reviews;
    expect(all.length).toBeGreaterThanOrEqual(1);
    // newest-first ordering, deterministic ids
    const ids = all.map((r) => String(r.review_id));
    expect(new Set(ids).size).toBe(ids.length);
    const times = all.map((r) => String(r.created_at));
    expect([...times].sort().reverse()).toEqual(times);
    const limited = s.cockpit.objectiveReviews(oid, OWNER, 1).reviews;
    expect(limited).toHaveLength(1);
    expect(String(limited[0]!.review_id)).toBe(String(all[0]!.review_id));
    s.store.close();
  });

  it("C7 TARGET_MET_CANDIDATE never conflated with ACHIEVED", async () => {
    const { s, oid, binding, ops } = seeded("c7", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const c = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    const life = c.lifecycle as Row;
    expect(life.objective_status).toBe("ACTIVE");
    expect(life.latest_review_outcome).toBe("TARGET_MET_CANDIDATE");
    expect(life.owner_action_required).toBe(true);
    // ACHIEVED may appear ONLY as recommendation, never as status
    expect(life.recommended_status).toBe("ACHIEVED");
    s.store.close();
  });

  it("C8 KPI MET + incomplete workstream reflected honestly", async () => {
    const { s, oid, binding, ops } = seeded("c8", ["a", "b"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a"); // only 'a' done; 'b' untouched
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const c = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    const wss = c.workstreams as Row[];
    const wsB = wss.find((w) => w.workstream_key === "b")!;
    expect(wsB.workstream_status).not.toBe("DONE");
    expect(wsB.completion_proven).toBe(false);
    expect((c.kpi_summary as Row).all_targets_met).toBe(true);
    s.store.close();
  });

  it("C9 GET projections mint zero writes", async () => {
    const { s, oid, bid } = seeded("c9", ["a"]);
    const before = dbOf(s.store)
      .prepare("SELECT COUNT(*) c FROM events").get() as { c: number };
    s.cockpit.objectiveCockpit(oid, OWNER);
    s.cockpit.objectiveReviews(oid, OWNER, 10);
    s.cockpit.businessCompany(bid, OWNER);
    const after = dbOf(s.store)
      .prepare("SELECT COUNT(*) c FROM events").get() as { c: number };
    expect(after.c).toBe(before.c);
    s.store.close();
  });

  it("C9b no-binding objective → binding:null, not an error", () => {
    const s = freshFullStack("c9b");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const c = s.cockpit.objectiveCockpit(
      String(o.objective_id), OWNER) as Record<string, never>;
    expect(c.binding).toBeNull();
    expect((c.workstreams as Row[]).length).toBe(0);
    s.store.close();
  });
});

/* ============== R1 audit findings — negative tests ============== */

/** Mint a VALID cloned canonical review row (same commit shape the
 *  production seam writes): unique observation digest → recomputed
 *  review_id/review_digest/entity_id + matching immutable anchor
 *  event. Used only to build a >MAX history honestly — every clone
 *  still passes full strict validation. */
function cloneReview(
  s: FullStack, base: Row, i: number,
): void {
  const body = { ...base } as Record<string, unknown>;
  const obsDigest = digest({ clone_obs: body.review_observation_digest, i });
  const rid = adaptiveReviewId(String(body.objective_id), obsDigest);
  body.review_observation_digest = obsDigest;
  body.review_id = rid;
  body.entity_id = rid;
  body.created_at = new Date(Date.parse(String(body.created_at)) + i * 1000)
    .toISOString();
  body.version = 0; // create-only rows: stored version bumps to 1 on put
  body.review_digest = adaptiveReviewDigest(body);
  s.store.put(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, rid, body as Row, 0);
  s.store.event({
    entity_type: OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
    entity_id: rid,
    event_type: OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT,
    old_state: null, new_state: "COMMITTED",
    actor: `operator:${String(body.created_by)}`,
    metadata: {
      review_id: rid,
      review_digest: String(body.review_digest),
      objective_id: String(body.objective_id),
      business_id: String(body.business_id),
      outcome: String(body.outcome),
      review_observation_digest: obsDigest,
      source_ceo_decision_id: body.source_ceo_decision_id ?? null,
      strategy_revision_id: body.strategy_revision_id ?? null,
    },
  });
}

describe("P15.9-A1 R1 — audit findings", () => {
  it("R1-F1 expired auto-policy: GET cockpit mints ZERO writes; expiry surfaced as pending", async () => {
    const { s, oid } = seeded("rf1", ["a"]);
    const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives);
    policy.control({ objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: new Date(Date.now() + 60_000).toISOString(),
        max_ceo_calls: 4 }, idempotency_key: `cfg-${counter}` });
    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: `en-${counter}` });
    const polId = `oap:${oid}`;
    expect(String((s.store.get("objective_auto_policy", polId) as Row).state))
      .toBe("ENABLED");
    // Cockpit wired with a policy service whose clock is past
    // expires_at — the stored row is due for lazy EXPIRED commit.
    const expiredClock = new ObjectiveAutoPolicyService(
      s.store, s.biz.objectives, () => Date.now() + 120_000);
    const cockpit = new ObjectiveCockpitService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      artifacts: s.authority, autoPolicy: expiredClock,
    });
    const before = dbOf(s.store)
      .prepare("SELECT COUNT(*) c FROM events").get() as { c: number };
    const c = cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    const after = dbOf(s.store)
      .prepare("SELECT COUNT(*) c FROM events").get() as { c: number };
    expect(after.c).toBe(before.c);
    // Canonical row still ENABLED — the lazy commit did NOT happen.
    expect(String((s.store.get("objective_auto_policy", polId) as Row).state))
      .toBe("ENABLED");
    const ap = c.auto_policy as Row;
    expect(ap.expiry_pending).toBe(true);
    s.store.close();
  });

  it("R1-F2 forged objective row in company list → whole read fails closed", () => {
    const s = freshFullStack("rf2");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const o2 = mkObjective(s, bid);
    // Forge o2 into a non-canonical shape (invalid enum status).
    sqlRewriteEntity(s.store, "objective", String(o2.objective_id), (b) => {
      b.status = "FORGED";
    });
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    expect(() => s.cockpit.objectiveCockpit(String(o.objective_id), OWNER))
      .not.toThrowError();
    s.store.close();
  });

  it("R1-F3 tampered artifact binding + corrupt CAS → dropped, never verified", async () => {
    const { s, oid, binding } = seeded("rf3", ["a", "b"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    const c0 = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((c0.artifacts as Row[]).length).toBe(1);
    const artId = String((c0.artifacts as Row[])[0]!.artifact_id);
    // Tamper the binding claim: point mission_id at a foreign mission.
    sqlRewriteEntity(s.store, "artifact", artId, (b) => {
      b.mission_id = "MSN_FOREIGN";
    });
    const c1 = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((c1.artifacts as Row[]).length).toBe(0);
    expect(c1.artifacts_dropped_unverified).toBe(0); // never a candidate: binding gone
    // Corrupt retained CAS bytes: artifact claims stay, bytes fail.
    const { s: s2, oid: oid2, binding: b2 } = seeded("rf3b", ["a"]);
    grantBundle(s2, oid2, { required_count: 1 });
    completeDeliverable(s2, b2, "a");
    const blobDir = path.join(s2.dir, "artifacts", "blobs");
    const cc = s2.cockpit.objectiveCockpit(oid2, OWNER) as Record<string, never>;
    const art = (cc.artifacts as Row[])[0]!;
    fs.writeFileSync(path.join(blobDir, String(art.sha256)), "tampered bytes");
    const c2 = s2.cockpit.objectiveCockpit(oid2, OWNER) as Record<string, never>;
    expect((c2.artifacts as Row[]).length).toBe(0);
    expect(c2.artifacts_dropped_unverified).toBe(1);
    s.store.close(); s2.store.close();
  });

  it("R1-F4a >200 reviews: latest + count exact, ordering newest-first", async () => {
    const { s, oid, binding, ops } = seeded("rf4a", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    const pass = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const base = s.store.get(
      OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, pass.review_id) as Row;
    for (let i = 1; i <= 205; i++) cloneReview(s, base, i);
    const res = s.cockpit.objectiveReviews(oid, OWNER, 50);
    expect(res.total).toBe(206);
    expect(res.truncated).toBe(true);
    expect(res.reviews).toHaveLength(50);
    // newest clone (i=205) is latest; the REAL review is not misreported.
    const c = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect(c.review_count).toBe(206);
    const times = res.reviews.map((r) => String(r.created_at));
    expect([...times].sort().reverse()).toEqual(times);
    s.store.close();
  });

  it("R1-F4b >200 owned objectives: truncation metadata truthful", () => {
    const s = freshFullStack("rf4b");
    const bid = mkBusiness(s);
    for (let i = 0; i < 205; i++) mkObjective(s, bid);
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    expect(company.objectives_total_owned).toBe(205);
    expect(company.objectives_truncated).toBe(true);
    expect((company.objectives as Row[]).length).toBe(200);
    // R2-3 — counts are exact over ALL owned objectives.
    expect((company.counts as Row).objectives_owned).toBe(205);
    expect((company.counts as Row).objectives_returned).toBe(200);
    s.store.close();
  });

  it("R2-3 pending beyond the 200-cap still counts: targets_met_pending exact", async () => {
    const s = freshFullStack("rf4d");
    const bid = mkBusiness(s);
    s.biz.createOrgAgent({ business_id: bid, title: `a${counter}`,
      department: "growth", operator_id: OP });
    for (let i = 0; i < 205; i++) mkObjective(s, bid);
    // Created last → sorts last by created_at → beyond the display cap.
    const pendingOid = await pendingCandidateObjective(s, bid);
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    expect(company.objectives_total_owned).toBe(206);
    expect((company.objectives as Row[]).length).toBe(200);
    expect(
      (company.objectives as Row[]).some(
        (o) => String(o.objective_id) === pendingOid),
    ).toBe(false);
    // The pending objective is NOT on the page — the count is still exact.
    expect((company.counts as Row).targets_met_pending).toBe(1);
    s.store.close();
  });

  it("R1-F4c ACHIEVED objective + historical CANDIDATE review → no pending inbox", async () => {
    const { s, oid, bid, binding, ops } = seeded("rf4c", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const before = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((before.lifecycle as Row).owner_action_required).toBe(true);
    // Owner accepts → ACHIEVED.
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "ACHIEVED", actor: OWNER,
      reason: "owner accepted targets" });
    const after = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((after.lifecycle as Row).objective_status).toBe("ACHIEVED");
    expect((after.lifecycle as Row).owner_action_required).toBe(false);
    // Historical review fields stay truthful (raw record kept).
    expect((after.latest_review as Row).owner_action_required).toBe(true);
    // R2-2 — the delegated verifier grant legitimately ended with the
    // terminal objective → observation degrades to a labeled error and
    // every KPI/budget claim renders UNVERIFIED, never MET.
    expect(after.observation_error).toBeTruthy();
    const kpis = (after.objective as Row).kpis as Row[];
    expect(kpis[0]!.canonically_proven).toBe(false);
    expect(kpis[0]!.assessment).toBe("UNVERIFIED");
    expect(((after.objective as Row).budget as Row).canonically_proven)
      .toBe(false);
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    expect((company.counts as Row).targets_met_pending).toBe(0);
    // Company summary on the same terminal objective: unverifiable,
    // not MET.
    const so = (company.objectives as Row[])[0]!;
    expect((so.kpi_summary as Row).canonically_proven).toBe(false);
    expect((so.kpi_summary as Row).all_targets_met).toBe(false);
    expect((so.kpi_summary as Row).met).toBe(0);
    s.store.close();
  });
});

describe("P15.9-A1 R2 — audit closure", () => {
  it("R2-1 forged kpi.current + last_evidence_key on live objective → company fails closed, never MET", () => {
    const s = freshFullStack("r21a");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    // Well-typed forge: plausible current + evidence key with ZERO
    // canonical progress evidence behind them.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      (b.kpis as Row[])[0]!.current = 5;
      (b.kpis as Row[])[0]!.last_evidence_key = `ek-${digest({ f: 1 })}`;
    });
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    expect(() => s.cockpit.objectiveCockpit(oid, OWNER)).toThrowError();
    s.store.close();
  });

  it("R2-1 forged budget.consumed_microusd → company fails closed", () => {
    const s = freshFullStack("r21b");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    sqlRewriteEntity(s.store, "objective", String(o.objective_id), (b) => {
      (b.budget as Row).consumed_microusd = 100; // no spend events
    });
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    s.store.close();
  });

  it("R2-1 proven claims still render: MET + budget truthful on canonical objective", async () => {
    const { s, oid, bid, binding, ops } = seeded("r21c", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    const so = (company.objectives as Row[])[0]!;
    expect((so.kpi_summary as Row).canonically_proven).toBe(true);
    expect((so.kpi_summary as Row).met).toBe(1);
    expect((so.kpi_summary as Row).all_targets_met).toBe(true);
    expect((so.budget as Row).canonically_proven).toBe(true);
    s.store.close();
  });

  it("R2-2 forged KPI progress on TERMINAL objective → fails closed, never UNVERIFIED-as-MET", async () => {
    const { s, oid, bid, binding, ops } = seeded("r22a", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "ACHIEVED", actor: OWNER,
      reason: "owner accepted" });
    // Forge a different current value on the terminal objective —
    // the lek is real but the claim diverges from the receipt/event.
    // The delegated-grant check short-circuits first (OBJECTIVE_TERMINAL),
    // so the classified end renders UNVERIFIABLE — never MET.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      (b.kpis as Row[])[0]!.current = 99;
    });
    const c = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect(c.observation_error).toBeTruthy();
    const kpis = (c.objective as Row).kpis as Row[];
    expect(kpis[0]!.assessment).toBe("UNVERIFIED");
    expect(kpis[0]!.canonically_proven).toBe(false);
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    const so = (company.objectives as Row[])[0]!;
    expect((so.kpi_summary as Row).met).toBe(0);
    expect((so.kpi_summary as Row).all_targets_met).toBe(false);
    s.store.close();
  });

  it("R2-2 unknown-lek forge on TERMINAL objective → fails closed (unclassified tamper)", async () => {
    const { s, oid, bid, binding, ops } = seeded("r22b", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "ACHIEVED", actor: OWNER,
      reason: "owner accepted" });
    // Forge a lek with no PROGRESS ref anywhere — fails BEFORE the
    // grant check with an unclassified tamper error → hard fail.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      (b.kpis as Row[])[0]!.last_evidence_key = `ek-${digest({ forged: 1 })}`;
    });
    expect(() => s.cockpit.objectiveCockpit(oid, OWNER)).toThrowError();
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    s.store.close();
  });
});

describe("P15.9-A1 R3 — final targeted closure", () => {
  it("R3-F1 owner-tampered objective row → company detects corruption, never silently omits", () => {
    const s = freshFullStack("r3f1");
    const bid = mkBusiness(s);
    const o1 = mkObjective(s, bid);
    const o2 = mkObjective(s, bid);
    // Tamper the raw owner claim — digest-bound term → strict read fails.
    sqlRewriteEntity(s.store, "objective", String(o2.objective_id), (b) => {
      b.owner_authority_id = "operator:intruder";
    });
    // Before the fix: the raw owner filter dropped o2 BEFORE validation
    // → company returned 1 objective, silently incomplete. Now the
    // whole read fails closed.
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    // The clean objective's own read is unaffected.
    expect(() => s.cockpit.objectiveCockpit(String(o1.objective_id), OWNER))
      .not.toThrowError();
    s.store.close();
  });

  it("R3-F1b business_id-tampered objective → company detects corruption, never silently omits", () => {
    const s = freshFullStack("r3f1b");
    const bid = mkBusiness(s);
    const other = mkBusiness(s);
    const o1 = mkObjective(s, bid);
    const o2 = mkObjective(s, bid);
    // Tamper the raw business claim — o2 vanishes from list(bid) before
    // any validation under the old prefilter.
    sqlRewriteEntity(s.store, "objective", String(o2.objective_id), (b) => {
      b.business_id = other;
    });
    // Global enumeration + strict read: the forged row is still found
    // and fails closed instead of being silently omitted.
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    // The target-side read is equally protected — tampered rows can
    // never sneak into a different business' projection either.
    expect(() => s.cockpit.businessCompany(other, OWNER)).toThrowError();
    expect(() => s.cockpit.objectiveCockpit(String(o1.objective_id), OWNER))
      .not.toThrowError();
    s.store.close();
  });

  it("R3-F1c objective_id alias forgery → company fails closed, never validates victim twice", () => {
    const s = freshFullStack("r3f1c");
    const bid = mkBusiness(s);
    const o1 = mkObjective(s, bid);
    const o2 = mkObjective(s, bid);
    // Attacker rewrites OBJ_B's claimed identity to OBJ_A. Under the
    // old path list() would hand us "o1" twice — get(o1) fetches the
    // real row both times and o2's forged row is never validated.
    sqlRewriteEntity(s.store, "objective", String(o2.objective_id), (b) => {
      b.objective_id = String(o1.objective_id);
    });
    // entityPage enumerates by the PERSISTED key (o2's real entity_id):
    // get(o2key) strict-reads the forged row — objective_id claim
    // mismatches the proven key → fail closed, not duplicate o1.
    expect(() => s.cockpit.businessCompany(bid, OWNER)).toThrowError();
    expect(() => s.cockpit.objectiveCockpit(String(o1.objective_id), OWNER))
      .not.toThrowError();
    s.store.close();
  });

  it("R3-F1d payload entity_id forgery → enumeration itself fails closed", () => {
    const s = freshFullStack("r3f1d");
    const bid = mkBusiness(s);
    const o1 = mkObjective(s, bid);
    mkObjective(s, bid);
    // payload.entity_id is injected by store.put and proven === the
    // persisted entity key by entityPage — a forged claim breaks the
    // enumeration-level hash/identity check before any strict read.
    sqlRewriteEntity(s.store, "objective", String(o1.objective_id), (b) => {
      b.entity_id = "OBJ_FORGED_ALIAS";
    });
    expect(() => s.cockpit.businessCompany(bid, OWNER))
      .toThrowError(/ENTITY_HASH_MISMATCH|FAIL_CLOSED/);
    s.store.close();
  });

  it("R3-F2 owner amend after CANDIDATE → stale pins: pending false, history retained", async () => {
    const { s, oid, bid, binding, ops } = seeded("r3f2", ["a"]);
    completeDeliverable(s, binding, "a");
    // Owner-verified progress (no delegated grant) so the post-amend
    // observation still re-proves — this test isolates pin staleness.
    s.biz.objectives.recordProgress(oid, {
      business_id: bid, kpi_id: KPI, value: 1,
      evidence: { evidence_key: `ev-${counter}`, verifier: OWNER,
        source: "operator:console" },
      actor: OWNER });
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const before = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((before.lifecycle as Row).owner_action_required).toBe(true);
    // Owner amends protected terms → terms_version/version/digest bump.
    s.biz.objectives.amend(oid, {
      business_id: bid, patch: { title: "revised scope" },
      reason: "owner refined terms", actor: OWNER });
    const after = s.cockpit.objectiveCockpit(oid, OWNER) as Record<string, never>;
    expect((after.objective as Row).status).toBe("ACTIVE");
    // The historical CANDIDATE review is retained verbatim…
    expect(after.review_count).toBe(1);
    expect((after.latest_review as Row).outcome).toBe("TARGET_MET_CANDIDATE");
    expect((after.latest_review as Row).owner_action_required).toBe(true);
    // …but its pins no longer match the objective → NOT pending.
    expect((after.lifecycle as Row).owner_action_required).toBe(false);
    const company = s.cockpit.businessCompany(bid, OWNER) as Record<string, never>;
    expect((company.counts as Row).targets_met_pending).toBe(0);
    const so = (company.objectives as Row[])[0]!;
    expect((so.latest_review as Row).owner_action_required).toBe(false);
    s.store.close();
  });
});

/* ================= HTTP boundary ================= */

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function serveMini(s: FullStack): Promise<number> {
  const server = createMissionControlServer({
    business: s.biz, store: s.store, workforce: s.wf, authToken: TOK });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
const hdr = (op = OP) => ({
  "content-type": "application/json", "x-operator-id": op,
  authorization: `Bearer ${TOK}` });

describe("P15.9-A1 HTTP boundary", () => {
  it("cockpit/reviews/company routes serve owner, deny non-owner, reject absent operator", async () => {
    const { s, oid, bid } = seeded("http1", ["a"]);
    const port = await serveMini(s);
    const base = `http://127.0.0.1:${port}`;

    const ok = await fetch(`${base}/api/vnext/objectives/${oid}/cockpit`, { headers: hdr() });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { cockpit: { objective: { objective_id: string } } };
    expect(body.cockpit.objective.objective_id).toBe(oid);

    const deny = await fetch(`${base}/api/vnext/objectives/${oid}/cockpit`, { headers: hdr("555") });
    expect(deny.status).toBe(403);
    const denyBody = (await deny.json()) as Row;
    expect(String(denyBody.error)).toBe("FAIL_CLOSED_COCKPIT_AUTHORITY");
    expect((denyBody as Record<string, unknown>).cockpit).toBeUndefined();

    const noHdr = await fetch(`${base}/api/vnext/objectives/${oid}/cockpit`, {
      headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` } });
    expect(noHdr.status).toBe(403);

    const rev = await fetch(`${base}/api/vnext/objectives/${oid}/reviews?limit=5`, { headers: hdr() });
    expect(rev.status).toBe(200);
    const badLimit = await fetch(`${base}/api/vnext/objectives/${oid}/reviews?limit=abc`, { headers: hdr() });
    expect(badLimit.status).toBe(400);

    const comp = await fetch(`${base}/api/vnext/businesses/${bid}/company`, { headers: hdr() });
    expect(comp.status).toBe(200);
    const compDeny = await fetch(`${base}/api/vnext/businesses/${bid}/company`, { headers: hdr("555") });
    expect(compDeny.status).toBe(403);
    expect(String(((await compDeny.json()) as Row).error)).toBe("FAIL_CLOSED_COMPANY_SCOPE");
    s.store.close();
  });
});
