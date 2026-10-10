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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p159-cockpit-"));
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
  const biz = new BusinessLayer({ store, control, schedules: new MissionScheduleService(service) });
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
  });
  return { store, biz, wf, workstreams, alloc, authority, service,
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
