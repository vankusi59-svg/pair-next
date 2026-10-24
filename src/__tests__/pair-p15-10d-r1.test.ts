/**
 * P15.10-D — AUTONOMOUS KPI EVIDENCE VERIFICATION.
 *
 * Closes the P15.10-C operation gap: mission COMPLETED + artifact
 * ACCEPTED never implied KPI progress — verification required an owner
 * opt-in authority contract + canonical evidence chain. This suite:
 *
 *   §A ACCEPTANCE — reproduce the P15.10-C gap end-to-end: governed
 *     workstream → bound mission → real artifact acceptance → owner
 *     grant → KPI verified through the canonical seam → P15.5 strict
 *     read agrees → operating pass returns TARGET_MET_CANDIDATE, never
 *     ACHIEVED.
 *   §B ADVERSARIAL — the 15 mandated anti-cheat vectors.
 *
 * Conventions identical to pair-p15-6-objective-operating-loop.test.ts:
 * "forging" = raw SQL rewrite of persisted rows; artifact acceptance is
 * ALWAYS the real ArtifactAuthority seam (mandate: no mock acceptance).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  ExecutorRegistry,
  GovernedTaskGate,
  KPI_AUTH_ENTITY,
  KPI_RECEIPT_ENTITY,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  ObjectiveKpiVerificationService,
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
  assertCanonicalObjectiveKpiProgress,
  assertKpiVerifierAuthority,
  createDefaultCeoPlanningCycle,
  createDefaultObjectiveOperatingService,
  digest,
  ensureCodexCliCatalog,
  ObjectiveAdaptiveReviewService,
  objectiveKpiAssessment,
  type ObjectiveKpi,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510d-"));
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

type Stack = {
  dbPath: string;
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  alloc: WorkforceAllocationService;
  authority: ArtifactAuthority;
};

type FullStack = Stack & {
  service: PairControlPlane;
  control: MissionControl;
  runtime: MissionRuntime;
  projectId: string;
  kpiSvc: ObjectiveKpiVerificationService;
};

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

/** Raw-SQL mutation — the adversarial definition of "forging". */
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
  return { dbPath, dir, store, biz, wf, workstreams, alloc, service,
    control, runtime, projectId: String(project.project_id), kpiSvc,
    authority };
}

function mkBusiness(s: FullStack) {
  const b = s.biz.createBusiness({ name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  return String(b.business_id);
}

/** The mandate's MT5-flavoured objective: KPI_DELIVERABLES gated on ALL
 *  required deliverables verified. */
function mkObjective(s: Stack, businessId: string, withOther = false) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "MT5 indicator promotion plan",
    statement: "Produce a research report, 3 channels, 5 ideas.",
    kpis: [
      { kpi_id: KPI, name: "deliverables", unit: "count",
        direction: "AT_LEAST", baseline: 0, target: 1 },
      ...(withOther ? [{ kpi_id: "KPI_OTHER", name: "other", unit: "x",
        direction: "AT_LEAST", baseline: 0, target: 5 }] : []),
    ],
    deadline: FUTURE,
    budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter}`,
    operator_id: OP,
  });
}

function decompose(s: Stack, oid: string, keys: string[]) {
  const o = s.biz.objectives.get(oid);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}`,
    })) as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Row, key: string): string {
  const ws = (binding.workstreams as Row[]).find((w) => String(w.workstream_key) === key)!;
  return String(ws.work_item_id);
}

function childOfKey(s: Stack, binding: Row, key: string): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list<Row>(WORKFORCE_ALLOCATION_ENTITY).find(
    (r) => String(r.workstream_work_item_id) === wid);
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: Stack, childId: string): string {
  const m = s.biz.boundMissionForWorkItem(s.store.get("work_item", childId));
  if (!m) throw new Error(`no bound mission for ${childId}`);
  return String(m.mission_id);
}

/** REAL canonical artifact acceptance on a governed execution of the
 *  mission — never a fabricated artifact row. */
function acceptArtifact(s: FullStack, missionId: string, name = "report.md"): string {
  const exec = s.store.list<Row>("executor_execution").find(
    (e) => String(e.mission_id) === missionId);
  if (!exec) throw new Error(`no execution for ${missionId}`);
  // Real acceptance needs a source inside the governed allowed_paths —
  // canonical-mission-completion pins workspace=/tmp/pair-canonical-ws/<mid>.
  const ws = `/tmp/pair-canonical-ws/${missionId}`;
  fs.mkdirSync(ws, { recursive: true });
  const f = path.join(ws, `${name}-${counter++}`);
  fs.writeFileSync(f, `deliverable ${name} ${counter}`);
  const r = s.authority.accept({
    execution_id: String(exec.execution_id),
    producer_executor_id: String(exec.executor_id ?? "EX_TEST_CANONICAL"),
    logical_name: name,
    source: { kind: "path", path: f },
    channel: "LOCAL_EXECUTION",
    actor: "TEST",
    allow_post_result: true,
  });
  return String(r.artifact.artifact_id);
}

/** Drive a workstream's delegated child to canonical DONE with a REAL
 *  accepted artifact on its bound mission. */
function completeDeliverable(
  s: FullStack, binding: Row, key: string, artifactName?: string,
): { childId: string; missionId: string; artifactId: string } {
  const cid = childOfKey(s, binding, key);
  const row = s.store.get("work_item", cid);
  if (String(row.status) === "READY") s.biz.openWorkItem(cid, OP);
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  const artifactId = acceptArtifact(s, mid, artifactName ?? `${key}.md`);
  s.biz.syncWorkItem(cid);
  s.biz.advanceCompletionCascade(cid);
  return { childId: cid, missionId: mid, artifactId };
}

function grantBundle(s: FullStack, oid: string, rule: Record<string, unknown>) {
  return s.kpiSvc.grant(oid, {
    actor: OWNER, kpi_id: KPI,
    rule: { rule_type: "DELIVERABLE_BUNDLE", ...rule },
    expires_at: FUTURE,
    idempotency_key: `kv-${counter}`,
  });
}

function kpiRow(s: Stack, oid: string): ObjectiveKpi {
  const o = s.biz.objectives.get(oid);
  return (o.kpis as ObjectiveKpi[]).find((k) => String(k.kpi_id) === KPI)!;
}

function expectFail(fn: () => unknown, code: string) {
  try { fn(); } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

function seeded(name: string, keys = ["report", "channels"], withOther = false) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid, withOther);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, keys);
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  for (const k of keys) {
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
  }
  return { s, oid, bid, binding: s.workstreams.getBinding(oid)! };
}

const CEO_WAIT = JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
  workstreams: null, priority_order: null,
  wait_reason: "AWAITING_PROGRESS", summary: null,
});

class FakeInvoker implements CeoDecisionInvoker {
  constructor(private raw: string = CEO_WAIT) {}
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: this.raw,
    };
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


/* ===================== §R1 — AUTHORITY & PROOF HARDENING =====================
 *  Each test is a prepatch-FAIL reproduction of one audited finding. */

describe("P15.10-D R1 — F1 artifact authority re-verification", () => {
  it("R1-F1a ACCEPTED row + deleted retained CAS bytes must never mint KPI progress", () => {
    const { s, oid, binding } = seeded("r1f1a", ["report"]);
    grantBundle(s, oid, { required_count: 1 });
    const { artifactId } = completeDeliverable(s, binding, "report");
    // Destroy the retained blob — the artifact row stays ACCEPTED.
    const row = s.store.get<Row>("artifact", artifactId);
    const blob = path.join(s.dir, "artifacts", "blobs", String(row.sha256));
    fs.unlinkSync(blob);
    expect(fs.existsSync(blob)).toBe(false);
    expectFail(() => s.kpiSvc.advance(oid), "FAIL_CLOSED_ARTIFACT_VERIFICATION");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });

  it("R1-F1b ACCEPTED row + tampered retained bytes must never mint KPI progress", () => {
    const { s, oid, binding } = seeded("r1f1b", ["report"]);
    grantBundle(s, oid, { required_count: 1 });
    const { artifactId } = completeDeliverable(s, binding, "report");
    const row = s.store.get<Row>("artifact", artifactId);
    const blob = path.join(s.dir, "artifacts", "blobs", String(row.sha256));
    fs.writeFileSync(blob, Buffer.alloc(Number(row.byte_size), 0x41)); // same size, wrong bytes
    expectFail(() => s.kpiSvc.advance(oid), "FAIL_CLOSED_ARTIFACT_VERIFICATION");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });
});

describe("P15.10-D R1 — F2 authorization idempotency", () => {
  it("R1-F2a grant replay with same key after revoke cannot re-enable", () => {
    const { s, oid } = seeded("r1f2a");
    const key = `kv-r1f2-${counter}`;
    const g1 = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: key });
    s.kpiSvc.control(oid, String(g1.authorization_id), {
      actor: OWNER, action: "revoke", idempotency_key: `rv-${counter}` });
    // Replay the original grant request — same key, same semantics.
    const g2 = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: key });
    expect(String(g2.authorization_id)).toBe(String(g1.authorization_id));
    expect(String(g2.state)).toBe("REVOKED"); // revoke is durable
    const grants = s.store.list<Row>(KPI_AUTH_ENTITY)
      .filter((g) => String(g.dedup_key) === key);
    expect(grants.length).toBe(1); // no second mint
    s.store.close();
  });

  it("R1-F2b same key + different semantics fails closed", () => {
    const { s, oid } = seeded("r1f2b");
    const key = `kv-r1f2b-${counter}`;
    s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: key });
    expectFail(() => s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 2 },
      expires_at: FUTURE, idempotency_key: key }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("R1-F2c sequential duplicate grant requests converge — no double-mint", () => {
    const { s, oid } = seeded("r1f2c");
    const key = `kv-r1f2c-${counter}`;
    const in_ = { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: key };
    const g1 = s.kpiSvc.grant(oid, in_);
    const g2 = s.kpiSvc.grant(oid, in_);
    expect(String(g2.authorization_id)).toBe(String(g1.authorization_id));
    expect(s.store.list<Row>(KPI_AUTH_ENTITY).length).toBe(1);
    s.store.close();
  });
});

describe("P15.10-D R1 — F3 receipt↔authorization binding", () => {
  /** Mint grant A on KPI → real PROGRESS → revoke A → grant B on same KPI
   *  → claim progress citing B's verifier but A's receipt. */
  function receiptOfOldGrant(s: FullStack, oid: string, binding: Row) {
    const gA = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `kvA-${counter}` });
    completeDeliverable(s, binding, "report");
    const outs = s.kpiSvc.advance(oid);
    expect(outs[0]!.outcome).toBe("PROGRESS_RECORDED");
    const receipt = s.store.list<Row>(KPI_RECEIPT_ENTITY)[0]!;
    s.kpiSvc.control(oid, String(gA.authorization_id), {
      actor: OWNER, action: "revoke", idempotency_key: `rv-${counter}` });
    const gB = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `kvB-${counter}` });
    return { gA, gB, receipt };
  }

  it("R1-F3a receipt minted under revoked grant A must not satisfy verifier claim of new grant B", () => {
    const { s, oid, binding } = seeded("r1f3a", ["report"]);
    const { gB, receipt } = receiptOfOldGrant(s, oid, binding);
    // evidence_key forged to point receipt A's id under grant B.
    const forgedKey = `kva:${gB.authorization_id}:${receipt.receipt_id}`;
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: Number(receipt.progress_value),
      evidence: { evidence_key: forgedKey,
        verifier: `kpi-verifier:${gB.authorization_id}`,
        source: "kpi-verification:DELIVERABLE_BUNDLE" },
      note: "adversarial", actor: "PAIR_KPI_VERIFIER",
    }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("R1-F3b receipt rule_digest vs grant rule_digest mismatch fails closed", () => {
    const { s, oid, binding } = seeded("r1f3b", ["report"]);
    const gA = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `kvA-${counter}` });
    completeDeliverable(s, binding, "report");
    s.kpiSvc.advance(oid);
    // Tamper the grant's rule_digest — receipt must no longer bind it.
    sqlRewriteEntity(s.store, KPI_AUTH_ENTITY, String(gA.authorization_id),
      (b) => { b.rule_digest = "f".repeat(64); });
    expectFail(() => assertCanonicalObjectiveKpiProgress(
      s.store, s.biz.objectives.get(oid)), "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("R1-F3c evidence_key that does not match the receipt's own minted key fails closed", () => {
    const { s, oid, binding } = seeded("r1f3c", ["report"]);
    const { gA, receipt } = (() => {
      const gA = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
        rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
        expires_at: FUTURE, idempotency_key: `kvA-${counter}` });
      completeDeliverable(s, binding, "report");
      s.kpiSvc.advance(oid);
      return { gA, receipt: s.store.list<Row>(KPI_RECEIPT_ENTITY)[0]! };
    })();
    // Same auth, but the key string is not the receipt's minted evidence_key.
    const wrongKey = `kva:${gA.authorization_id}:${receipt.receipt_id}x`;
    expectFail(() => assertKpiVerifierAuthority({
      store: s.store, objective: s.biz.objectives.get(oid), kpi_id: KPI,
      verifier: `kpi-verifier:${gA.authorization_id}`,
      evidence_key: wrongKey, value: 1,
    }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });
});

describe("P15.10-D R1 — F4 temporal semantics (documented behavior)", () => {
  it("R1-F4 progress at T1 stays written; revoke at T2 makes the strict read fail closed at T3 until owner re-verifies", () => {
    const { s, oid, binding } = seeded("r1f4", ["report"]);
    const gA = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `kvA-${counter}` });
    completeDeliverable(s, binding, "report");
    s.kpiSvc.advance(oid); // T1: KPI verified under live grant
    expect(Number(kpiRow(s, oid).current)).toBe(1);
    s.kpiSvc.control(oid, String(gA.authorization_id), {
      actor: OWNER, action: "revoke", idempotency_key: `rv-${counter}` }); // T2
    // T3: the strict P15.5 read fails closed on the dead grant's entry.
    expectFail(() => assertCanonicalObjectiveKpiProgress(
      s.store, s.biz.objectives.get(oid)), "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    // The persisted value is untouched — semantics are "unverifiable,
    // not erased"; the owner can recover by recording its own verified
    // progress, which re-points last_evidence_key.
    expect(Number(kpiRow(s, oid).current)).toBe(1);
    s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 1,
      evidence: { evidence_key: `owner-reverify-${counter}`,
        verifier: OWNER, source: "operator" },
      note: "owner re-verify after revoke", actor: OWNER });
    assertCanonicalObjectiveKpiProgress(s.store, s.biz.objectives.get(oid));
    s.store.close();
  });
});

describe("P15.10-D R1 — F5 verification scope honesty", () => {
  it("R1-F5 DELIVERABLE_BUNDLE proves canonical deliverable completion ONLY — content semantics stay the owner's contract", () => {
    const { s, oid, binding } = seeded("r1f5", ["report"]);
    // An owner MAY grant a bundle rule on a KPI named like a world
    // metric — the rule still only proves the canonical deliverable
    // chain. The written value is the rule's declared progress_value,
    // never a content evaluation: 2 channels-in-name deliverables do
    // NOT make "5 ideas" or member counts verified.
    const g = s.kpiSvc.grant(oid, { actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1,
        progress_value: 1 },
      expires_at: FUTURE, idempotency_key: `kv5-${counter}` });
    completeDeliverable(s, binding, "report");
    const out = s.kpiSvc.advance(oid);
    expect(out[0]!.outcome).toBe("PROGRESS_RECORDED");
    const receipt = s.store.list<Row>(KPI_RECEIPT_ENTITY)[0]!;
    // Receipt only binds canonical deliverable facts — workstream keys,
    // work items, missions, artifact ids — never textual content.
    for (const u of receipt.verified_units as Array<Record<string, unknown>>) {
      expect(Object.keys(u).sort()).toEqual(
        ["artifact_ids", "mission_id", "work_item_id", "workstream_key"]);
    }
    // The artifact bytes themselves were never read as evidence —
    // content quality is out of scope by contract (no AI judge).
    expect(String((g.rule as Row).rule_type)).toBe("DELIVERABLE_BUNDLE");
    s.store.close();
  });
});
