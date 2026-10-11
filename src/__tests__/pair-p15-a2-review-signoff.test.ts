/**
 * P15.10-A2 — OWNER REVIEW SIGN-OFF (accept ACHIEVED).
 *
 * The missing seam the live incident exposed: KPI verified + review
 * TARGET_MET_CANDIDATE existed, but no owner route could finalize the
 * objective. ObjectiveReviewSignoffService is the ONE authority:
 * owner-only, latest-review pinned, ACTIVE-only, no-active-work-only,
 * durable idempotency, delegating the transition to the existing
 * ObjectiveAuthorityService.transitionStatus().
 *
 * Fixtures reuse the P15.10-D recipe: real workstream → delegated
 * child → bound mission → canonical completion + real artifact
 * acceptance → owner KPI grant → verified progress → operating pass →
 * committed TARGET_MET_CANDIDATE review.
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
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
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
  ObjectiveKpiVerificationService,
  ObjectiveReviewSignoffService,
  OBJECTIVE_REVIEW_SIGNOFF_ENTITY,
  OBJECTIVE_REVIEW_SIGNED_OFF_EVENT,
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
  createDefaultObjectiveOperatingService,
  canonicalAdaptiveReviewsFor,
  ensureCodexCliCatalog,
  type ObjectiveKpi,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p15a2-"));
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const INTRUDER = "operator:not-the-owner";
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

type FullStack = {
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  alloc: WorkforceAllocationService;
  authority: ArtifactAuthority;
  service: PairControlPlane;
  kpiSvc: ObjectiveKpiVerificationService;
  projectId: string;
};

function freshFullStack(name: string): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
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
    schedules: new MissionScheduleService(service) });
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
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    kpiSvc, projectId: String(project.project_id) };
}

function mkBusiness(s: FullStack) {
  const b = s.biz.createBusiness({ name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  return String(b.business_id);
}

function mkObjective(s: FullStack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "sign-off objective",
    statement: "Produce a research report.",
    kpis: [
      { kpi_id: KPI, name: "deliverables", unit: "count",
        direction: "AT_LEAST", baseline: 0, target: 1 },
    ],
    deadline: FUTURE,
    budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter}`,
    operator_id: OP,
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

function childOfKey(s: FullStack, binding: Row, key: string): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list<Row>(WORKFORCE_ALLOCATION_ENTITY).find(
    (r) => String(r.workstream_work_item_id) === wid);
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: FullStack, childId: string): string {
  const m = s.biz.boundMissionForWorkItem(s.store.get("work_item", childId));
  if (!m) throw new Error(`no bound mission for ${childId}`);
  return String(m.mission_id);
}

function acceptArtifact(s: FullStack, missionId: string, name = "report.md"): string {
  const exec = s.store.list<Row>("executor_execution").find(
    (e) => String(e.mission_id) === missionId);
  if (!exec) throw new Error(`no execution for ${missionId}`);
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

function expectFail(fn: () => unknown, code: string) {
  try { fn(); } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

function seeded(name: string, keys = ["report"]) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
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

const FAKE_INVOKER = {
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: CEO_WAIT,
    };
  },
};

function signoffSvc(s: FullStack) {
  return new ObjectiveReviewSignoffService({
    store: s.store,
    objectives: s.biz.objectives,
    reviewDeps: {
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
    },
  });
}

/** Drive the seeded objective to a committed TARGET_MET_CANDIDATE
 *  review — the real-world pattern the mandate names. Returns the
 *  latest canonical review row. */
async function candidateReview(s: FullStack, oid: string, binding: Row, keys = ["report"]) {
  grantBundle(s, oid, { required_count: keys.length });
  for (const k of keys) completeDeliverable(s, binding, k);
  s.kpiSvc.advance(oid);
  qualifyCeo(s.store);
  const ops = createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams,
    invoker: FAKE_INVOKER,
  });
  const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
  expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
  const reviews = canonicalAdaptiveReviewsFor(
    { store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams }, oid);
  const latest = reviews.at(-1)!;
  expect(String(latest.outcome)).toBe("TARGET_MET_CANDIDATE");
  expect(latest.owner_action_required).toBe(true);
  expect(String(latest.recommended_status)).toBe("ACHIEVED");
  return latest;
}

function signoffEvents(s: FullStack, oid: string) {
  return s.store.listEvents("objective", oid).filter(
    (e) => String(e.event_type) === "OBJECTIVE_STATUS");
}

/* ============================ TESTS ============================ */

describe("P15.10-A2 — owner review sign-off", () => {
  it("A1 happy path — owner accepts TARGET_MET_CANDIDATE → ACHIEVED, receipt + events, replay idempotent", async () => {
    const { s, oid, binding } = seeded("a1");
    const review = await candidateReview(s, oid, binding);
    const svc = signoffSvc(s);
    const r1 = svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id),
      idempotency_key: "so-a1",
      reason: "looks good",
    });
    expect(r1.replayed).toBe(false);
    expect(String(r1.objective.status)).toBe("ACHIEVED");
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACHIEVED");
    // canonical events: status transition + sign-off receipt commit.
    const stEvents = signoffEvents(s, oid);
    expect(stEvents.length).toBe(1);
    expect(String(stEvents[0]!.new_state)).toBe("ACHIEVED");
    const receipts = s.store.list<Row>(OBJECTIVE_REVIEW_SIGNOFF_ENTITY);
    expect(receipts.length).toBe(1);
    const soEvents = s.store.listEvents(
      OBJECTIVE_REVIEW_SIGNOFF_ENTITY, String(receipts[0]!.entity_id));
    expect(soEvents.some((e) => String(e.event_type) === OBJECTIVE_REVIEW_SIGNED_OFF_EVENT)).toBe(true);
    // Replay — same key, same semantics: stored receipt, no new
    // transition/event.
    const r2 = svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id),
      idempotency_key: "so-a1",
    });
    expect(r2.replayed).toBe(true);
    expect(String(r2.signoff.entity_id)).toBe(String(r1.signoff.entity_id));
    expect(signoffEvents(s, oid).length).toBe(1);
    expect(s.store.list<Row>(OBJECTIVE_REVIEW_SIGNOFF_ENTITY).length).toBe(1);
    s.store.close();
  });

  it("A2 non-owner → FAIL_CLOSED_OBJECTIVE_AUTHORITY", async () => {
    const { s, oid, binding } = seeded("a2");
    const review = await candidateReview(s, oid, binding);
    expectFail(() => signoffSvc(s).signoff(oid, {
      actor: INTRUDER, action: "accept",
      review_id: String(review.review_id), idempotency_key: "so-a2",
    }), "FAIL_CLOSED_OBJECTIVE_AUTHORITY");
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    s.store.close();
  });

  it("A3 wrong review_id → FAIL_CLOSED_REVIEW_SIGNOFF; stale pins after amend → FAIL_CLOSED_REVIEW_SIGNOFF", async () => {
    const { s, oid, binding } = seeded("a3");
    const review = await candidateReview(s, oid, binding);
    const svc = signoffSvc(s);
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: "REV_nonexistent", idempotency_key: "so-a3a",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    // Owner amendment bumps terms_version → the pinned review is stale.
    s.biz.objectives.amend(oid, {
      business_id: s.biz.objectives.get(oid).business_id as string,
      patch: { title: "retitled" },
      actor: OWNER,
    });
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id), idempotency_key: "so-a3b",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    s.store.close();
  });

  it("A4 no candidate review (INSUFFICIENT_VERIFIED_PROGRESS) → FAIL_CLOSED_REVIEW_SIGNOFF", async () => {
    const { s, oid, binding } = seeded("a4");
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "report");
    s.kpiSvc.advance(oid); // verified but NO pass → no review at all
    expectFail(() => signoffSvc(s).signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: "REV_whatever", idempotency_key: "so-a4",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    s.store.close();
  });

  it("A5 active work item → FAIL_CLOSED_REVIEW_SIGNOFF, nothing cancels", async () => {
    // Two workstreams; only "report" completes — KPI grant requires
    // just 1 bundle so the review is a real TARGET_MET_CANDIDATE, but
    // "channels" work item stays non-terminal → sign-off must refuse.
    const { s, oid, binding } = seeded("a5", ["report", "channels"]);
    grantBundle(s, oid, { required_count: 1 });
    completeDeliverable(s, binding, "report");
    s.kpiSvc.advance(oid);
    qualifyCeo(s.store);
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      invoker: FAKE_INVOKER,
    });
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    const reviews = canonicalAdaptiveReviewsFor(
      { store: s.store, business: s.biz, workforce: s.wf,
        objectives: s.biz.objectives, workstreams: s.workstreams }, oid);
    const latest = reviews.at(-1)!;
    expect(String(latest.outcome)).toBe("TARGET_MET_CANDIDATE");
    expectFail(() => signoffSvc(s).signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(latest.review_id), idempotency_key: "so-a5",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACTIVE");
    s.store.close();
  });

  it("A6 same idempotency key with different semantics → FAIL_CLOSED_REVIEW_SIGNOFF", async () => {
    const { s, oid, binding } = seeded("a6");
    const review = await candidateReview(s, oid, binding);
    const svc = signoffSvc(s);
    svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id), idempotency_key: "so-a6",
    });
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: "REV_other", idempotency_key: "so-a6",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    s.store.close();
  });

  it("A7 racing accepts — at most one transition commits", async () => {
    const { s, oid, binding } = seeded("a7");
    const review = await candidateReview(s, oid, binding);
    const svc = signoffSvc(s);
    const results = [
      () => svc.signoff(oid, { actor: OWNER, action: "accept",
        review_id: String(review.review_id), idempotency_key: "so-a7x" }),
      () => svc.signoff(oid, { actor: OWNER, action: "accept",
        review_id: String(review.review_id), idempotency_key: "so-a7y" }),
    ].map((fn) => { try { return { ok: true, v: fn() }; } catch { return { ok: false }; } });
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(String(s.biz.objectives.get(oid).status)).toBe("ACHIEVED");
    expect(signoffEvents(s, oid).length).toBe(1);
    s.store.close();
  });

  it("A8 after ACHIEVED the operating pass refuses new work (OBJECTIVE_NOT_ACTIVE)", async () => {
    const { s, oid, binding } = seeded("a8");
    const review = await candidateReview(s, oid, binding);
    signoffSvc(s).signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id), idempotency_key: "so-a8",
    });
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      invoker: FAKE_INVOKER,
    });
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("OBJECTIVE_NOT_ACTIVE");
    s.store.close();
  });

  it("A9 malformed input fails closed (action, review_id, idempotency_key)", async () => {
    const { s, oid, binding } = seeded("a9");
    const review = await candidateReview(s, oid, binding);
    const svc = signoffSvc(s);
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "request_changes",
      review_id: String(review.review_id), idempotency_key: "so-a9",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF_ACTION");
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: "", idempotency_key: "so-a9",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    expectFail(() => svc.signoff(oid, {
      actor: OWNER, action: "accept",
      review_id: String(review.review_id), idempotency_key: "",
    }), "FAIL_CLOSED_REVIEW_SIGNOFF");
    expectFail(() => svc.signoff(oid, {
      actor: "", action: "accept",
      review_id: String(review.review_id), idempotency_key: "so-a9",
    }), "FAIL_CLOSED_OPERATOR_ID_REQUIRED");
    s.store.close();
  });
});
