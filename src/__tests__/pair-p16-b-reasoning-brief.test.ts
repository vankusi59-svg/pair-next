/**
 * P16-B — Strategic ReasoningBrief acceptance suite.
 *
 * Proves the deterministic, evidence-linked advisory contract:
 *
 *   RB1 — deterministic: identical canonical state yields an identical
 *         brief_digest; the digest tracks canonical mutation; the
 *         context_digest pin binds the exact BrainContext snapshot.
 *   RB2 — every fact is evidence-linked: non-empty sections[] +
 *         provenance tier; KPI budget claims are PROVEN only when the
 *         canonical re-proof ran (never rendered as truth otherwise).
 *   RB3 — options derive from canonical state: pre-binding →
 *         CEO_INITIALIZE_WORKSTREAMS; bound → CEO_PRIORITIZE_EXISTING;
 *         WAIT is always a candidate; a terminal objective emits none.
 *   RB4 — missing_information maps unavailable/integrity gaps; expected
 *         absences (BINDING_ABSENT, SCOPE_BINDING_ABSENT, *_NOT_WIRED)
 *         do not degrade confidence.
 *   RB5 — owner gate + scope check inherit fail-closed verbatim.
 *   RB6 — no-write invariant: briefFor leaves the canonical log
 *         byte-identical (hash footprint, not counts).
 *   RB7 — reasoner projection: NOT_CONFIGURED when no model entry,
 *         UNRESOLVED for a bogus id, QUALIFIED + transport identity for
 *         a canonically qualified codex-cli model. NEVER invokes.
 *   RB8 — hypotheses fire only on real signals (MEASUREMENT_LEADS_
 *         EXECUTION requires all-met + unproven workstreams).
 *
 * Harness mirrors pair-p16-a-brain-context.test.ts — real canonical
 * seams; the reasoner fixture mirrors p15-3's mkModel/mkProvider.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BrainContextService,
  BusinessLayer,
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
  ObjectiveAutoPolicyService,
  ObjectiveKpiVerificationService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  CEO_CODEX_DEFAULT_MODEL,
  CODEX_CLI_PROVIDER_ID,
  createDefaultObjectiveOperatingService,
  ensureCodexCliCatalog,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  ReconciliationService,
  RecoveryController,
  ReasoningBriefService,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  digest,
  providerEntryId,
  qualifyModel,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p16b-brief-"));
let counter = 0;
const OP = "p16b-owner";
const OTHER = "operator:999999";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

/** Raw event/entity footprint — the read-only proof: briefFor must
 *  leave the canonical log byte-identical. */
function logFootprint(store: PairEvidenceStore) {
  const db = dbOf(store);
  const ev = db.prepare("SELECT COUNT(*) n FROM events").get() as Row;
  const en = db.prepare("SELECT COUNT(*) n FROM entities").get() as Row;
  const eventHashes = digest(
    (db.prepare("SELECT event_hash h FROM events").all() as { h: string }[])
      .map((r) => r.h));
  const payloadHashes = digest(
    (db.prepare("SELECT payload_hash h FROM entities").all() as { h: string }[])
      .map((r) => r.h));
  return { events: Number(ev.n), entities: Number(en.n), eventHashes, payloadHashes };
}

type FullStack = {
  dir: string;
  store: PairEvidenceStore; biz: BusinessLayer; wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService; alloc: WorkforceAllocationService;
  authority: ArtifactAuthority; service: PairControlPlane;
  control: MissionControl; projectId: string;
  brain: BrainContextService;
  kpiSvc: ObjectiveKpiVerificationService;
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
  const project = service.createProject({ name: "p", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
  });
  const kpiSvc = new ObjectiveKpiVerificationService({
    store, objectives: biz.objectives, workstreams, business: biz,
    artifacts: authority });
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    control, projectId: String(project.project_id), brain, kpiSvc };
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

function seeded(name: string, keys: string[] = ["a"]) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = keys.length ? decompose(s, oid, keys) : null;
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  if (binding) {
    for (const k of keys) {
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
    }
  }
  return { s, oid, bid, binding };
}

function brief(s: FullStack, modelEntryId?: string) {
  return new ReasoningBriefService(s.store, {
    brain: s.brain, model_entry_id: modelEntryId });
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

/** Canonically QUALIFIED codex-cli model — mirrors p15-3's fixture. */
function mkQualifiedModel(s: FullStack): string {
  const mcat = new ModelEvidenceCatalog(s.store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: "codex-cli", provider_family: "codex-cli",
    model_id: "codex-test", capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  mcat.recordProbeReceipt({
    probe_id: `PRB_p16b_${counter++}`,
    model_entry_id: eid, provider_id: "codex-cli", result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" },
    latency_ms: 1,
  });
  const q = qualifyModel(s.store, eid, {
    capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`mkQualifiedModel failed: ${JSON.stringify(q.gates)}`);
  // Provider row in the canonical codex-cli subscription shape +
  // a REAL qualification receipt (PROVIDER_RECEIPT_CURRENT binds the
  // receipt's material fingerprint to the row — a bare put fails it).
  const pid = providerEntryId("codex-cli");
  const existing = s.store.tryGet("provider", pid);
  s.store.put("provider", pid, {
    ...(existing ?? { provider_id: "codex-cli", entry_id: pid }),
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
  new ProviderCatalog(s.store).issueQualificationReceipt(
    "codex-cli", { policy_version: "test-policy", actor: "test" });
  return eid;
}

/* ----------------------------- tests ----------------------------- */

describe("P16-B ReasoningBriefService.briefFor", () => {
  it("RB1 deterministic; brief_digest tracks canonical state; pins context_digest", () => {
    const { s, oid } = seeded("rb1", []);
    const svc = brief(s);
    const b1 = svc.briefFor(oid, OWNER);
    const b2 = svc.briefFor(oid, OWNER);
    expect(b2.brief_digest).toBe(b1.brief_digest);
    // The pin is the exact context snapshot — re-read and compare.
    expect(b1.context_digest).toBe(s.brain.contextFor(oid, OWNER).context_digest);
    expect(b1.schema_version).toMatch(/reasoning-brief/);
    expect(b1.authority).toBe("ADVISORY_ONLY");
    // Canonical mutation → new brief digest (bound to state, not cache).
    s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 0.5,
      evidence: { evidence_key: `ek-${counter++}`, verifier: OWNER,
        source: "owner-console" },
      actor: OWNER,
    });
    const b3 = svc.briefFor(oid, OWNER);
    expect(b3.brief_digest).not.toBe(b1.brief_digest);
    expect(b3.context_digest).not.toBe(b1.context_digest);
    s.store.close();
  });

  it("RB2 every fact is evidence-linked with an honest provenance tier", () => {
    const { s, oid } = seeded("rb2", []);
    const b = brief(s).briefFor(oid, OWNER);
    expect(b.facts.length).toBeGreaterThan(0);
    const TIERS = new Set(["CANONICAL", "PROVEN", "PROJECTED", "UNVERIFIED"]);
    for (const f of b.facts) {
      expect(f.sections.length, f.predicate).toBeGreaterThan(0);
      expect(TIERS.has(f.provenance), f.predicate).toBe(true);
      expect(f.sections.every((n) => n in s.brain.contextFor(oid, OWNER).sections))
        .toBe(true);
    }
    // Pre-binding: proveClaims re-proved the (vacuous) claim chain —
    // PROVEN. The assessment field inside the value stays UNVERIFIED:
    // met-ness was never observationally verified. Two honest axes.
    const kpi = b.facts.find((f) => f.predicate === "KPI_MEASUREMENT")!;
    expect(kpi.subject).toBe(KPI);
    expect(kpi.provenance).toBe("PROVEN");
    expect((kpi.value as Row).assessment).toBe("UNVERIFIED");
    const status = b.facts.find((f) => f.predicate === "OBJECTIVE_STATUS")!;
    expect(status.provenance).toBe("CANONICAL");
    s.store.close();
  });

  it("RB2b proven claims upgrade after a real owner measurement + binding", () => {
    const { s, oid } = seeded("rb2b", ["a"]);
    s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 0.5,
      evidence: { evidence_key: `ek-${counter++}`, verifier: OWNER,
        source: "owner-console" },
      actor: OWNER,
    });
    const b = brief(s).briefFor(oid, OWNER);
    const kpi = b.facts.find((f) => f.predicate === "KPI_MEASUREMENT")!;
    expect(kpi.provenance).toBe("PROVEN");
    const budget = b.facts.find((f) => f.predicate === "OBJECTIVE_BUDGET")!;
    expect(budget.provenance).toBe("PROVEN");
    s.store.close();
  });

  it("RB3 options follow canonical state — initialize, prioritize, wait, terminal", () => {
    // Pre-binding: INITIALIZE + WAIT only (no prioritize — nothing exists).
    const { s, oid } = seeded("rb3", []);
    const b1 = brief(s).briefFor(oid, OWNER);
    const ids1 = b1.options.map((o) => o.id);
    expect(ids1).toContain("CEO_INITIALIZE_WORKSTREAMS");
    expect(ids1).toContain("WAIT");
    expect(ids1).not.toContain("CEO_PRIORITIZE_EXISTING");
    // Bound with a live workstream: PRIORITIZE + WAIT, no INITIALIZE.
    const { s: s2, oid: oid2 } = seeded("rb3b", ["a"]);
    const b2 = brief(s2).briefFor(oid2, OWNER);
    const ids2 = b2.options.map((o) => o.id);
    expect(ids2).toContain("CEO_PRIORITIZE_EXISTING");
    expect(ids2).toContain("WAIT");
    expect(ids2).not.toContain("CEO_INITIALIZE_WORKSTREAMS");
    // Terminal: zero options — no advisory move exists for a closed
    // objective; anything else would invite post-terminal authority.
    s2.biz.objectives.transitionStatus(oid2, {
      business_id: String(s2.biz.objectives.get(oid2).business_id),
      to: "CANCELLED", reason: "owner", actor: OWNER });
    const b3 = brief(s2).briefFor(oid2, OWNER);
    expect(b3.options).toEqual([]);
    s.store.close();
    s2.store.close();
  });

  it("RB4 expected gaps do not degrade; integrity notes do", () => {
    const { s, oid, binding } = seeded("rb4", ["a"]);
    const b = brief(s).briefFor(oid, OWNER);
    // Unscoped memory/experience gaps are EXPECTED — reported as
    // missing_information but the envelope stays confident.
    expect(b.missing_information.some((g) => g.code === "SCOPE_BINDING_ABSENT")).toBe(true);
    expect(b.confidence).toBe("HIGH");
    // Forge an artifact CAS link → integrity note → LOW confidence.
    const art = s.store.list<Row>("artifact");
    if (art.length === 0) completeDeliverable(s, binding!, "a");
    const row = s.store.list<Row>("artifact")[0]!;
    const db = dbOf(s.store);
    const p = db.prepare("SELECT payload FROM entities WHERE entity_type='artifact' AND entity_id=?")
      .get(String(row.artifact_id)) as { payload: string };
    const body = JSON.parse(p.payload) as Record<string, unknown>;
    body.sha256 = "f".repeat(64);
    db.prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type='artifact' AND entity_id=?")
      .run(JSON.stringify(body), digest(body), String(row.artifact_id));
    const b2 = brief(s).briefFor(oid, OWNER);
    expect(b2.confidence).toBe("LOW");
    expect(b2.missing_information.some((g) => g.code === "INTEGRITY")).toBe(true);
    expect(b2.hypotheses.some((h) => h.id === "INTEGRITY_GAPS_PRESENT")).toBe(true);
    s.store.close();
  });

  it("RB5 owner gate + business scope inherit fail-closed", () => {
    const { s, oid } = seeded("rb5", []);
    const svc = brief(s);
    expect(() => svc.briefFor(oid, OTHER)).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_AUTHORITY" }));
    expect(() => svc.briefFor(oid, OWNER, { business_id: "biz_foreign" }))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_SCOPE" }));
    // Budget exhaustion propagates the typed proof-limit error too.
    expect(() => svc.briefFor(oid, OWNER, { read_budget: { entities: 1, events: 1 } }))
      .toThrowError(expect.objectContaining({ code: expect.stringMatching(/PROOF_LIMIT/) }));
    s.store.close();
  });

  it("RB6 no-write invariant — canonical log byte-identical across briefFor", () => {
    const { s, oid } = seeded("rb6", ["a"]);
    const svc = brief(s, mkQualifiedModel(s)); // reasoner read also writes nothing
    const before = logFootprint(s.store);
    svc.briefFor(oid, OWNER);
    svc.briefFor(oid, OWNER);
    expect(logFootprint(s.store)).toEqual(before);
    s.store.close();
  });

  it("RB7 reasoner projection — not configured, unresolved, qualified", () => {
    const { s, oid } = seeded("rb7", []);
    // NOT_CONFIGURED — no fabricated availability.
    const b0 = brief(s).briefFor(oid, OWNER);
    expect(b0.reasoner.eligibility).toBe("NOT_CONFIGURED");
    expect(b0.reasoner.transport).toBeNull();
    // UNRESOLVED — a missing entry reports the code, never throws.
    const b1 = brief(s, "ME_BOGUS").briefFor(oid, OWNER);
    expect(b1.reasoner.eligibility).toBe("UNRESOLVED");
    expect(b1.reasoner.failure_code).toMatch(/UNRESOLVED/);
    // QUALIFIED — a canonically qualified codex-cli model reports the
    // transport identity; brief_digest ignores gate volatility and
    // pins only the configured binding.
    const me = mkQualifiedModel(s);
    const svc = brief(s, me);
    const b2 = svc.briefFor(oid, OWNER);
    expect(b2.reasoner.eligibility).toBe("QUALIFIED");
    expect(b2.reasoner.transport!.provider_id).toBe("codex-cli");
    expect(b2.reasoner.transport!.protocol_family).toBe("CODEX_CLI");
    expect(b2.brief_digest).not.toBe(b0.brief_digest); // configured binding IS content
    // UNQUALIFIED — an existing entry that fails a usability gate
    // reports the failure_code; transport still resolves.
    const mcat = new ModelEvidenceCatalog(s.store);
    const { entry: unq } = mcat.upsertModelClaim({
      provider_id: "codex-cli", provider_family: "codex-cli",
      model_id: "codex-unqualified", capability_hints: ["text_inference"] });
    const b3 = brief(s, String(unq.model_entry_id)).briefFor(oid, OWNER);
    expect(b3.reasoner.eligibility).toBe("UNQUALIFIED");
    expect(b3.reasoner.failure_code).toMatch(/FAIL_CLOSED_CEO_/);
    expect(b3.reasoner.transport).not.toBeNull();
    s.store.close();
  });

  it("RB8 hypotheses fire only on real signals", () => {
    const { s, oid, binding } = seeded("rb8", ["a"]);
    // All targets met while the workstream's completion is unproven →
    // MEASUREMENT_LEADS_EXECUTION. Without that conjunction the
    // hypothesis must not fire.
    let b = brief(s).briefFor(oid, OWNER);
    expect(b.hypotheses.some((h) => h.id === "MEASUREMENT_LEADS_EXECUTION")).toBe(false);
    s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 1,
      evidence: { evidence_key: `ek-${counter++}`, verifier: OWNER,
        source: "owner-console" },
      actor: OWNER,
    });
    b = brief(s).briefFor(oid, OWNER);
    const h = b.hypotheses.find((x) => x.id === "MEASUREMENT_LEADS_EXECUTION")!;
    expect(h.rests_on).toContain("WORKSTREAM_STATE");
    // Completing the deliverable proves the workstream — the
    // hypothesis resolves (deterministic from state, not sticky).
    completeDeliverable(s, binding!, "a");
    b = brief(s).briefFor(oid, OWNER);
    expect(b.hypotheses.some((x) => x.id === "MEASUREMENT_LEADS_EXECUTION")).toBe(false);
    s.store.close();
  });

  it("RB9 nested read budget fails closed — brief never lies about its bound", () => {
    const { s, oid } = seeded("rb9", ["a"]);
    // briefFor inherits contextFor's nested-budget refusal verbatim:
    // an outer budget would silently discard the inner bound while
    // the envelope still reports it — refused, not hidden.
    expect(() =>
      s.store.withReadBudget({ entities: 500, events: 500 }, () =>
        brief(s).briefFor(oid, OWNER)),
    ).toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_BUDGET" }));
    expect(() => brief(s).briefFor(oid, OWNER)).not.toThrow();
    s.store.close();
  });

  it("RB10 volatile policy fields never move brief_digest across a real expiry instant", () => {
    const { s, oid } = seeded("rb10", []);
    /* M1 regression — a REAL ObjectiveAutoPolicyService whose
       expires_at passes between reads flips effective/expiry_pending
       (visible in the AUTO_POLICY fact VALUE) but must NOT move
       brief_digest: the digest pins canonical state only. */
    const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives);
    policy.control({
      objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: new Date(Date.now() + 60_000).toISOString(),
        max_ceo_calls: 4 },
      idempotency_key: `cfg-rb10-${counter}`,
    });
    policy.control({
      objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: `en-rb10-${counter}`,
    });
    const liveBrain = new BrainContextService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      artifacts: s.authority, autoPolicy: policy });
    const b1 = new ReasoningBriefService(s.store, { brain: liveBrain })
      .briefFor(oid, OWNER);
    const ap1 = (b1.facts.find((f) => f.predicate === "AUTO_POLICY")!
      .value as Row);
    expect(ap1.expiry_pending).toBe(false);
    // Clock jumps past expiry — same canonical rows.
    const stalePolicy = new ObjectiveAutoPolicyService(
      s.store, s.biz.objectives, () => Date.now() + 120_000);
    const staleBrain = new BrainContextService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      artifacts: s.authority, autoPolicy: stalePolicy });
    const b2 = new ReasoningBriefService(s.store, { brain: staleBrain })
      .briefFor(oid, OWNER);
    const ap2 = (b2.facts.find((f) => f.predicate === "AUTO_POLICY")!
      .value as Row);
    expect(ap2.expiry_pending).toBe(true); // live status IS visible…
    expect(b2.brief_digest).toBe(b1.brief_digest); // …never digested
    // A canonically DISABLED policy DOES change the digest — row state
    // is real content, not clock noise.
    policy.control({
      objective_id: oid, actor: OWNER, action: "disable",
      policy_version: 2, idempotency_key: `dis-rb10-${counter}`,
    });
    const b3 = new ReasoningBriefService(s.store, { brain: liveBrain })
      .briefFor(oid, OWNER);
    expect(b3.brief_digest).not.toBe(b1.brief_digest);
    expect(b3.hypotheses.some((h) => h.id === "POLICY_NOT_ENABLED")).toBe(true);
    s.store.close();
  });

  it("RB11 legitimate grant end → obsError: BINDING unobservable, claims UNVERIFIED, no decomposition options", () => {
    const { s, oid, bid, binding } = seeded("rb11", ["a"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding!, "a");
    s.kpiSvc.advance(oid); // delegated verified progress via the grant
    // Objective goes terminal → the verifier grant legitimately ends;
    // the strict observation degrades to a labeled error.
    s.biz.objectives.transitionStatus(oid, {
      business_id: bid, to: "ACHIEVED", actor: OWNER,
      reason: "owner accepted targets" });
    const b = brief(s).briefFor(oid, OWNER);
    // The binding is UNOBSERVABLE — never "absent". No decomposition
    // hypothesis may claim it missing.
    const bindingFact = b.facts.find((f) => f.predicate === "BINDING")!;
    expect(bindingFact.value).toBeNull();
    expect(bindingFact.provenance).toBe("UNVERIFIED");
    expect(b.hypotheses.some((h) => h.id === "PRE_DECOMPOSITION")).toBe(false);
    expect(b.facts.some((f) => f.predicate === "OBSERVATION_FAILED")).toBe(true);
    // Claims that can no longer be re-proven degrade honestly.
    expect(b.facts.find((f) => f.predicate === "KPI_MEASUREMENT")!.provenance)
      .toBe("UNVERIFIED");
    expect(b.facts.find((f) => f.predicate === "OBJECTIVE_BUDGET")!.provenance)
      .toBe("UNVERIFIED");
    expect(b.confidence).toBe("LOW");
    expect(b.missing_information.some((g) => g.code === "BINDING_UNOBSERVABLE")).toBe(true);
    expect(b.missing_information.some((g) => g.code === "WORKSTREAMS_UNOBSERVABLE")).toBe(true);
    // Terminal → zero options regardless of observation state.
    expect(b.options).toEqual([]);
    s.store.close();
  });

  it("RB12 bound overflow is reported by marker, never silently truncated", () => {
    const s = freshFullStack("rb12");
    const bid = mkBusiness(s);
    const o = s.biz.objectives.create({
      business_id: bid, title: "many-kpis", statement: "x",
      // 40 KPIs > BRIEF_MAX_FACTS — the cap must leave a marker.
      kpis: Array.from({ length: 40 }, (_, i) => ({
        kpi_id: `KPI_${i}`, name: `k${i}`, unit: "count",
        direction: "AT_LEAST", baseline: 0, target: 1 })),
      deadline: FUTURE, budget_ceiling_microusd: 500_000,
      dedup_key: `dk-${counter++}`, operator_id: OP });
    const oid = String(o.objective_id);
    const b = brief(s).briefFor(oid, OWNER);
    expect(b.facts.length).toBeLessThanOrEqual(32);
    const marker = b.missing_information.find((g) => g.code === "BRIEF_TRUNCATED");
    expect(marker).toBeTruthy();
    expect(marker!.detail).toContain("facts:");
    s.store.close();
  });

  it("RB13 policy-state options cover every legal owner recovery move", async () => {
    const { s, oid, binding } = seeded("rb13", ["a"]);
    const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives);
    const policyVersion = () =>
      Number(policy.statusReadOnly(oid, OWNER).policy_version);
    const briefWithPolicy = () => {
      const brain = new BrainContextService({
        store: s.store, business: s.biz, workforce: s.wf,
        objectives: s.biz.objectives, workstreams: s.workstreams,
        artifacts: s.authority, autoPolicy: policy });
      return new ReasoningBriefService(s.store, { brain }).briefFor(oid, OWNER);
    };
    const optIds = () => briefWithPolicy().options.map((o) => o.id);

    // configured:false (no row yet) → the only live POLICY_CONTROL id.
    expect(optIds()).toContain("OWNER_CONFIGURE_POLICY");

    policy.control({
      objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: new Date(Date.now() + 60_000).toISOString(),
        max_ceo_calls: 8 },
      idempotency_key: `cfg-rb13-${counter}`,
    });
    // DISABLED row now exists → enable is the named move.
    expect(optIds()).toContain("OWNER_ENABLE_POLICY");

    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: policyVersion(), idempotency_key: `en-rb13-${counter}` });
    expect(optIds()).toContain("WAIT");
    expect(optIds()).not.toContain("OWNER_ENABLE_POLICY");

    // Drive a REAL adaptive review to TARGET_MET_CANDIDATE while the
    // policy is ENABLED — needed for OWNER_REVIEW_SIGNOFF +
    // OWNER_GATE_BLOCKS_AUTONOMY coverage.
    qualifyCeo(s.store);
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      invoker: new CountingInvoker() });
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding!, "a");
    s.kpiSvc.advance(oid);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    const pending = briefWithPolicy();
    expect(pending.facts.find((f) => f.predicate === "LATEST_REVIEW")).toBeTruthy();
    expect(pending.options.some((o) => o.id === "OWNER_REVIEW_SIGNOFF")).toBe(true);
    // Driver unwired → OWNER_GATE_BLOCKS_AUTONOMY must NOT claim a
    // blocked driver exists.
    expect(pending.hypotheses.some((h) => h.id === "OWNER_GATE_BLOCKS_AUTONOMY"))
      .toBe(false);
    // With a driver wired + ENABLED policy + pending review → fires.
    const driverBrain = new BrainContextService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      artifacts: s.authority, autoPolicy: policy,
      autoDriver: { statusReadOnly: () => ({ enabled: true }) } as never });
    const withDriver = new ReasoningBriefService(s.store, { brain: driverBrain })
      .briefFor(oid, OWNER);
    expect(withDriver.hypotheses.some((h) => h.id === "OWNER_GATE_BLOCKS_AUTONOMY"))
      .toBe(true);

    policy.control({ objective_id: oid, actor: OWNER, action: "pause",
      policy_version: policyVersion(), idempotency_key: `pa-rb13-${counter}` });
    expect(optIds()).toContain("OWNER_RESUME_POLICY");

    policy.control({ objective_id: oid, actor: OWNER, action: "resume",
      policy_version: policyVersion(), idempotency_key: `re-rb13-${counter}` });
    // Lazy EXPIRED commit via a mutating read on a stale clock.
    const stale = new ObjectiveAutoPolicyService(
      s.store, s.biz.objectives, () => Date.now() + 120_000);
    stale.status(oid, OWNER);
    expect(String(policy.statusReadOnly(oid, OWNER).state)).toBe("EXPIRED");
    expect(optIds()).toContain("OWNER_RECONFIGURE_POLICY");

    policy.control({ objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: new Date(Date.now() + 300_000).toISOString(),
        max_ceo_calls: 8 },
      policy_version: policyVersion(), idempotency_key: `cfg2-rb13-${counter}` });
    expect(optIds()).toContain("OWNER_ENABLE_POLICY");

    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: policyVersion(), idempotency_key: `en2-rb13-${counter}` });
    policy.control({ objective_id: oid, actor: OWNER, action: "halt",
      policy_version: policyVersion(), halt_reason: "test halt",
      idempotency_key: `ht-rb13-${counter}` });
    expect(optIds()).toContain("OWNER_RESET_HALT");

    policy.control({ objective_id: oid, actor: OWNER, action: "reset_halt",
      policy_version: policyVersion(), idempotency_key: `rh-rb13-${counter}` });
    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: policyVersion(), idempotency_key: `en3-rb13-${counter}` });
    policy.control({ objective_id: oid, actor: OWNER, action: "revoke",
      policy_version: policyVersion(),
      idempotency_key: `rv-rb13-${counter}` });
    // REVOKED has no legal path back — no POLICY_CONTROL option.
    expect(briefWithPolicy().options.filter((o) => o.kind === "POLICY_CONTROL"))
      .toEqual([]);
    s.store.close();
  });
});
