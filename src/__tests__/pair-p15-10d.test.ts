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
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveKpiVerificationService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  readSchedulerRow,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  WAKE_SEGMENT,
  WAKE_STATE,
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

const ROOT = mkTmpDir("pair-p1510d-");
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

/* ============================ §A — ACCEPTANCE ============================ */

describe("P15.10-D §A — P15.10-C gap reproduction (end-to-end)", () => {
  it("A1 pre-evidence UNVERIFIED → accepted-but-insufficient UNVERIFIED → all verified → MET → TARGET_MET_CANDIDATE, never ACHIEVED", async () => {
    const { s, oid, binding } = seeded("a1", ["report", "channels"]);
    grantBundle(s, oid, { required_count: 2 });

    // 1. pre-evidence: UNVERIFIED, strict P15.5 proof holds on the
    //    empty projection.
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    assertCanonicalObjectiveKpiProgress(s.store, s.biz.objectives.get(oid));
    let outcomes = s.kpiSvc.advance(oid);
    expect(outcomes[0]!.outcome).toBe("UNVERIFIED");

    // 2. one deliverable verified — bundle incomplete → still UNVERIFIED.
    completeDeliverable(s, binding, "report");
    outcomes = s.kpiSvc.advance(oid);
    expect(outcomes[0]!.outcome).toBe("UNVERIFIED");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");

    // 3. all deliverables verified → receipt + canonical progress.
    completeDeliverable(s, binding, "channels");
    outcomes = s.kpiSvc.advance(oid);
    expect(outcomes[0]!.outcome).toBe("PROGRESS_RECORDED");
    const k = kpiRow(s, oid);
    expect(Number(k.current)).toBe(1);
    expect(String(k.last_evidence_key)).toContain("kva:KVA_");
    // 4-tier honesty: receipt proves deliverable-level facts only —
    // target=1 met because the owner bound the KPI to exactly this.
    expect(objectiveKpiAssessment(k)).toBe("MET");
    // P15.5 strict read accepts the delegated proof.
    assertCanonicalObjectiveKpiProgress(s.store, s.biz.objectives.get(oid));
    // replay is a no-op.
    outcomes = s.kpiSvc.advance(oid);
    expect(outcomes[0]!.outcome).toBe("REPLAYED");

    // 4. operating pass: TARGET_MET_CANDIDATE + owner gate, never
    //    auto-ACHIEVED.
    qualifyCeo(s.store);
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      invoker: new FakeInvoker(),
    });
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(r.owner_action_required).toBe(true);
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    s.store.close();
  });

  it("A2 no KVA → quiet VERIFIED_KPI_EVIDENCE wait → owner grant rearms → next driver tick mints KVR → TARGET_MET_CANDIDATE — no manual ceo-cycle", async () => {
    const { s, oid, binding } = seeded("a2", ["report"]);
    let t = 1_000_000;
    // The autonomous driver admission proof reads CODEX_HOME/auth.json.
    const codexHome = path.join(s.dir, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: { sub: "u" }, access_token: "a", refresh_token: "r" },
    }));
    process.env.CODEX_HOME = codexHome;
    const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives, () => t);
    const scheduler = new ObjectiveAutoScheduler(s.store, s.biz.objectives, policy, () => t);
    const wakeup = new ObjectiveAutoWakeupService(s.store, scheduler, () => t);
    qualifyCeo(s.store);
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      invoker: new FakeInvoker(),
    });
    policy.control({ objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: FUTURE, max_ceo_calls: 10 }, idempotency_key: "cfg" });
    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: "en" });
    if (!s.store.tryGet("executor", "CODEX")) {
      s.store.put("executor", "CODEX", {
        executor_id: "CODEX", executor_type: "EXTERNAL", status: "ENABLED",
        health_state: "READY", capabilities: [],
        metadata: { qualification_state: "QUALIFIED" },
      }, 0);
    }
    const driver = new ObjectiveAutoDriverService({
      store: s.store, objectives: s.biz.objectives, policy, scheduler,
      // The REAL operating pass — production wires exactly this.
      runPass: (input) => ops.service.runObjectivePass(input),
      executors: ["CODEX"],
      billingFor: (e) => e === "CODEX"
        ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
        : { mode: "UNMETERED", profile: null, unbounded: false },
      costHaltActive: () => false,
      workerId: "e2e-driver", bootId: "b1", now: () => t,
    });
    wakeup.tick();
    // Canonical work completes — but NO grant exists yet, so the pass
    // settles into the quiet verified-evidence wait.
    completeDeliverable(s, binding, "report");
    const first = await driver.tick();
    expect(first.driven[0]).toMatchObject({
      outcome: "INSUFFICIENT_VERIFIED_PROGRESS", settled: true });
    const q0 = readSchedulerRow<Row>(s.store, WAKE_STATE, oid)!;
    expect(q0).toMatchObject({ queue_state: "WAITING_EVIDENCE",
      wait_kind: "VERIFIED_KPI_EVIDENCE", next_due: null });
    expect(q0.pending_generation).toBe(q0.claimed_generation);
    expect(q0.claimed_generation).toBe(q0.settled_generation);
    // The endpoint's atomic composition: one immediate() for grant+wake.
    let aid = "";
    s.store.immediate(() => {
      const g = s.kpiSvc.grant(oid, {
        actor: OWNER, kpi_id: KPI,
        rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
        expires_at: FUTURE, idempotency_key: "e2e-grant",
      });
      aid = String(g.authorization_id);
      scheduler.notifyKpiVerifierGrant(oid, aid);
    });
    const q1 = readSchedulerRow<Row>(s.store, WAKE_STATE, oid)!;
    expect(q1.queue_state).toBe("WAITING_CONSUMER");
    expect(q1.pending_generation).toBe(Number(q0.pending_generation) + 1);
    expect(readSchedulerRow(s.store, WAKE_SEGMENT,
      `kpi-verifier-grant:${aid}`)).not.toBeNull();
    // The parked fairness cursor needs one FAIR_ROUND wrap before the
    // rearmed rank is rescanned — the claim may take a second tick.
    t += 30_001;
    let second = await driver.tick();
    if (!second.driven.length) second = await driver.tick();
    expect(second.driven[0]).toMatchObject({
      outcome: "TARGET_MET_CANDIDATE", settled: true });
    // The KVR was minted by the pass through the canonical verifier —
    // not by the grant; and the objective still awaits owner sign-off.
    const receipts = s.store.list<Row>(KPI_RECEIPT_ENTITY)
      .filter((r) => String(r.objective_id) === oid);
    expect(receipts).toHaveLength(1);
    expect(String(receipts[0]!.authorization_id)).toBe(aid);
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    // Third grant-path notify is receipt-dedup'd — armed queue untouched.
    const q2 = readSchedulerRow<Row>(s.store, WAKE_STATE, oid)!;
    scheduler.notifyKpiVerifierGrant(oid, aid);
    expect(readSchedulerRow<Row>(s.store, WAKE_STATE, oid)!.pending_generation)
      .toBe(q2.pending_generation);
    s.store.close();
  });
});

/* ============================ §B — 15 ADVERSARIAL ============================ */

describe("P15.10-D §B — adversarial authority matrix", () => {
  it("B1 forged artifact row (raw SQL ACCEPTED claim, wrong mission binding) → UNVERIFIED", () => {
    const { s, oid, binding } = seeded("b1");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    completeDeliverable(s, binding, "report");
    // Forge an artifact claiming ACCEPTED for the OTHER workstream's
    // mission — the row's mission_id is the adversary's chosen lie.
    const cid = childOfKey(s, binding, "channels");
    s.biz.openWorkItem(cid, OP);
    const mid2 = boundMissionId(s, cid);
    s.store.put("artifact", `ART_FORGED_${counter}`, {
      entity_type: "artifact", entity_id: `ART_FORGED_${counter}`,
      artifact_id: `ART_FORGED_${counter}`, mission_id: mid2,
      governed_task_id: "GTSK_FORGED", state: "ACCEPTED",
      logical_name: "fake.md", sha256: "0".repeat(64), version: 0,
    }, 0);
    const out = s.kpiSvc.advance(oid);
    expect(out[0]!.outcome).toBe("UNVERIFIED"); // channels unit unproven
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B2 artifact never accepted (state CREATED only) → UNVERIFIED", () => {
    const { s, oid, binding } = seeded("b2");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    const cid = childOfKey(s, binding, "report");
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(cid); s.biz.advanceCompletionCascade(cid);
    // artifact row exists but never went through authority accept.
    s.store.put("artifact", `ART_RAW_${counter}`, {
      entity_type: "artifact", entity_id: `ART_RAW_${counter}`,
      artifact_id: `ART_RAW_${counter}`, mission_id: mid,
      governed_task_id: "GTSK_X", state: "CREATED",
      logical_name: "raw.md", sha256: "a".repeat(64), version: 0,
    }, 0);
    expect(s.kpiSvc.advance(oid)[0]!.outcome).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B3 accepted artifact whose mission binding is rewritten (tampered content identity) → excluded", () => {
    const { s, oid, binding } = seeded("b3");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    const { artifactId } = completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    // Adversary rewrites the artifact's mission binding post-acceptance.
    sqlRewriteEntity(s.store, "artifact", artifactId, (b) => {
      b.mission_id = "MSN_FOREIGN";
    });
    expect(s.kpiSvc.advance(oid)[0]!.outcome).toBe("UNVERIFIED");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B4 artifact from ANOTHER objective's mission → not attributed", () => {
    const { s, oid, binding } = seeded("b4");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    completeDeliverable(s, binding, "report");
    // A second objective+business completes its own deliverable — its
    // artifacts must never cross-attribute.
    const bid2 = mkBusiness(s);
    const o2 = mkObjective(s, bid2);
    const oid2 = String(o2.objective_id);
    const b2 = decompose(s, oid2, ["x"]);
    s.biz.createOrgAgent({ business_id: bid2, title: `a2${counter}`,
      department: "g", operator_id: OP });
    s.alloc.allocateWorkstream({ objective_id: oid2, workstream_key: "x", actor: OP });
    completeDeliverable(s, b2, "x");
    expect(s.kpiSvc.advance(oid)[0]!.outcome).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B5 work item whose business binding is forged → excluded", () => {
    const { s, oid, binding } = seeded("b5");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    const cid = childOfKey(s, binding, "channels");
    sqlRewriteEntity(s.store, "work_item", cid, (b) => {
      b.business_id = "BIZ_FOREIGN";
    });
    // Cross-scope forgery inside the lineage throws at the canonical
    // mission-resolution seam — fail closed, never silent attribution.
    expectFail(() => s.kpiSvc.advance(oid), "FAIL_CLOSED_WORK_GRAPH_ROW");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B6 mission COMPLETED but child never folded → unit NOT verified", () => {
    const { s, oid, binding } = seeded("b6");
    grantBundle(s, oid, { required_keys: ["report", "channels"] });
    const cid = childOfKey(s, binding, "report");
    s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    canonicallyCompleteMission(s.store, s.service, mid);
    acceptArtifact(s, mid);
    // No syncWorkItem/cascade — status stays IN_PROGRESS.
    expect(String(s.store.get("work_item", cid).status)).toBe("IN_PROGRESS");
    expect(s.kpiSvc.advance(oid)[0]!.outcome).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B7 executor self-declared KPI → FAIL_CLOSED_OBJECTIVE_UNVERIFIED", () => {
    const { s, oid } = seeded("b7");
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 1,
      evidence: { evidence_key: "exec-self", verifier: "mission:EX_TEST",
        source: "executor:self-report" },
      actor: "EX_TEST_EXECUTOR",
    }), "FAIL_CLOSED_OBJECTIVE_UNVERIFIED");
    s.store.close();
  });

  it("B8 replay of identical measurement → REPLAYED, no double ledger entry", () => {
    const { s, oid, binding } = seeded("b8");
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.kpiSvc.advance(oid);
    const before = (s.biz.objectives.get(oid).applied_evidence_keys as unknown[]).length;
    const out = s.kpiSvc.advance(oid);
    expect(out[0]!.outcome).toBe("REPLAYED");
    const after = s.biz.objectives.get(oid);
    expect((after.applied_evidence_keys as unknown[]).length).toBe(before);
    expect(Number(kpiRow(s, oid).current)).toBe(1);
    expect(s.store.list(KPI_RECEIPT_ENTITY).length).toBe(1);
    s.store.close();
  });

  it("B9 same evidence_key different measurement → FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT", () => {
    const { s, oid, binding } = seeded("b9");
    const g = grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.kpiSvc.advance(oid);
    const key = String(kpiRow(s, oid).last_evidence_key);
    // Same key re-claimed with a different value — ledger conflict.
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 42,
      evidence: { evidence_key: key, verifier: `kpi-verifier:${g.authorization_id}`,
        source: "kpi-verification:DELIVERABLE_BUNDLE" },
      actor: "PAIR_KPI_VERIFIER",
    }), "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT");
    s.store.close();
  });

  it("B10 two verifier calls serialize — one measurement, one receipt", () => {
    const { s, oid, binding } = seeded("b10");
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    // A second service instance over the same store — racing callers.
    const svc2 = new ObjectiveKpiVerificationService({
      store: s.store, objectives: s.biz.objectives,
      workstreams: s.workstreams, business: s.biz, artifacts: s.authority });
    const r1 = s.kpiSvc.advance(oid)[0]!;
    const r2 = svc2.advance(oid)[0]!;
    expect([r1.outcome, r2.outcome].sort()).toEqual(["PROGRESS_RECORDED", "REPLAYED"]);
    expect(s.store.list(KPI_RECEIPT_ENTITY).length).toBe(1);
    expect((s.biz.objectives.get(oid).applied_evidence_keys as unknown[]).length).toBe(1);
    s.store.close();
  });

  it("B11 grant revoked mid-flight → advance denies; stale verifier write fails closed", () => {
    const { s, oid, binding } = seeded("b11");
    const g = grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.kpiSvc.control(oid, String(g.authorization_id), {
      actor: OWNER, action: "revoke", idempotency_key: `rv-${counter}` });
    const out = s.kpiSvc.advance(oid)[0]!;
    expect(out.outcome).toBe("AUTH_INEFFECTIVE");
    expect(out.reason).toBe("AUTH_REVOKED");
    // A stale verifier claim — receipt would never have been written,
    // and even a direct attempt dies at the owner-verifier seam.
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 1,
      evidence: { evidence_key: `kva:${g.authorization_id}:KVR_x`,
        verifier: `kpi-verifier:${g.authorization_id}`,
        source: "kpi-verification:DELIVERABLE_BUNDLE" },
      actor: "PAIR_KPI_VERIFIER",
    }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("B12 objective terms amended after grant → TERMS_DRIFT denies verification", () => {
    const { s, oid, binding } = seeded("b12");
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.biz.objectives.amend(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      patch: { statement: "revised statement" }, actor: OWNER,
    });
    const out = s.kpiSvc.advance(oid)[0]!;
    expect(out.outcome).toBe("AUTH_INEFFECTIVE");
    expect(out.reason).toBe("TERMS_DRIFT");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("UNVERIFIED");
    s.store.close();
  });

  it("B13 terminal objective → OBJECTIVE_TERMINAL, no resurrection", () => {
    const { s, oid, binding } = seeded("b13");
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.biz.objectives.transitionStatus(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      to: "CANCELLED", actor: OWNER, reason: "test" });
    const out = s.kpiSvc.advance(oid)[0]!;
    expect(out.outcome).toBe("AUTH_INEFFECTIVE");
    expect(out.reason).toBe("OBJECTIVE_TERMINAL");
    expect(String(s.biz.objectives.get(oid).status)).toBe("CANCELLED");
    s.store.close();
  });

  it("B14 kpi-verifier claim on a DIFFERENT kpi → KPI_MISMATCH fails closed", () => {
    const { s, oid, binding } = seeded("b14", ["report", "channels"], true);
    const g = grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    // Write a receipt-free direct claim against a foreign kpi id —
    // grant pins kpi_id so the claim can never reach another metric.
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: "KPI_OTHER", value: 1,
      evidence: { evidence_key: `kva:${g.authorization_id}:KVR_y`,
        verifier: `kpi-verifier:${g.authorization_id}`,
        source: "kpi-verification:DELIVERABLE_BUNDLE" },
      actor: "PAIR_KPI_VERIFIER",
    }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("B15 out-of-scope KPI type (e.g. telegram members) — grant rejected at create", () => {
    const { s, oid } = seeded("b15");
    for (const rt of ["TELEGRAM_MEMBERS", "MEMBER_COUNT", "EXTERNAL_METRIC", "LLM_REVIEWED"]) {
      expectFail(() => s.kpiSvc.grant(oid, {
        actor: OWNER, kpi_id: KPI,
        rule: { rule_type: rt, required_count: 1 },
        expires_at: FUTURE, idempotency_key: `kvr-${counter}-${rt}`,
      }), "FAIL_CLOSED_KPI_VERIFY");
    }
    s.store.close();
  });
});

/* ============================ §C — AUTHORITY CONTRACT ============================ */

describe("P15.10-D §C — grant contract edge cases", () => {
  it("C1 non-owner grant attempt → FAIL_CLOSED_KPI_VERIFY", () => {
    const { s, oid } = seeded("c1");
    expectFail(() => s.kpiSvc.grant(oid, {
      actor: "operator:intruder", kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `ki-${counter}` }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("C2 second grant on same (objective,kpi) → fail closed", () => {
    const { s, oid } = seeded("c2");
    grantBundle(s, oid, { required_count: 2 });
    expectFail(() => grantBundle(s, oid, { required_count: 1 }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("C3 expired grant at create → FAIL_CLOSED_KPI_VERIFY", () => {
    const { s, oid } = seeded("c3");
    expectFail(() => s.kpiSvc.grant(oid, {
      actor: OWNER, kpi_id: KPI,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: "2000-01-01T00:00:00.000Z", idempotency_key: `ke-${counter}`,
    }), "FAIL_CLOSED_KPI_VERIFY");
    s.store.close();
  });

  it("C4 forged receipt (digest mismatch) → assertKpiVerifierAuthority fails", () => {
    const { s, oid, binding } = seeded("c4");
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.kpiSvc.advance(oid);
    const receipt = s.store.list<Row>(KPI_RECEIPT_ENTITY)[0]!;
    sqlRewriteEntity(s.store, KPI_RECEIPT_ENTITY, String(receipt.receipt_id), (b) => {
      b.progress_value = 999; // forged value — digest no longer binds
    });
    expectFail(() => assertKpiVerifierAuthority({
      store: s.store, objective: s.biz.objectives.get(oid),
      kpi_id: KPI,
      verifier: String((receipt as Row).authorization_id ? `kpi-verifier:${receipt.authorization_id}` : ""),
      evidence_key: String(receipt.evidence_key),
      value: 999,
    }), "FAIL_CLOSED_KPI_VERIFY");
    // And the strict P15.5 read now refuses the mutated authority too.
    expectFail(() => assertCanonicalObjectiveKpiProgress(
      s.store, s.biz.objectives.get(oid)),
      "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW");
    s.store.close();
  });

  it("C5 wrong actor name on the delegated write → FAIL_CLOSED_OBJECTIVE_UNVERIFIED", () => {
    const { s, oid, binding } = seeded("c5");
    const g = grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "report");
    completeDeliverable(s, binding, "channels");
    s.kpiSvc.advance(oid);
    const key = String(kpiRow(s, oid).last_evidence_key);
    // Right verifier string, wrong writer identity.
    expectFail(() => s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 1,
      evidence: { evidence_key: `kva:${g.authorization_id}:KVR_z`,
        verifier: `kpi-verifier:${g.authorization_id}`,
        source: "kpi-verification:DELIVERABLE_BUNDLE" },
      actor: OWNER, // owner attempting to self-name under delegated kind
    }), "FAIL_CLOSED_OBJECTIVE_UNVERIFIED");
    void key;
    s.store.close();
  });

  it("C6 grant requires existing kpi + ACTIVE objective", () => {
    const { s, oid } = seeded("c6");
    expectFail(() => s.kpiSvc.grant(oid, {
      actor: OWNER, kpi_id: "KPI_MISSING",
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: `km-${counter}`,
    }), "NOT_FOUND");
    s.store.close();
  });
});
