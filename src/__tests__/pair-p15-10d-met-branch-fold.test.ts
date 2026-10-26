/**
 * P15.10 — MET-BRANCH LIFECYCLE FOLD REGRESSION.
 *
 * Defect (forensic audit, PAIR_NEXT_P15_10_LIFECYCLE_FOLD_AUDIT_REPORT):
 * `ObjectiveOperatingLoop.pass()` returns TARGET_MET_CANDIDATE at the
 * allTargetsMet gate BEFORE §9 `reconcileDelegatedChildren`, so a
 * delegated Work Item stays IN_PROGRESS forever once its bound Mission
 * reaches a terminal state while KPI is already MET — the fold seam
 * becomes unreachable at runtime (only a server restart's global
 * reconcileWorkLifecycle heals it).
 *
 * Fix under test: inside the allTargetsMet+binding branch, re-derive the
 * canonical observation and run the EXISTING reconcile seam BEFORE the
 * deterministic P15.5 review commits. No new work: no allocation, no
 * CEO call, no auto-ACHIEVED — syncWorkItem remains the only fold
 * authority and fails closed on unprovable claims.
 *
 *   T1 — KPI MET while a bound Mission is still RUNNING: no premature
 *        fold, no new Mission; after the Mission goes terminal the next
 *        pass folds canonically (DONE + WCP + parent cascade).
 *   T2 — terminal Mission never folded + KPI MET: one pass performs the
 *        canonical fold and materializes the WCP.
 *   T3 — replay/idempotency: further passes mint no duplicate WCP,
 *        no duplicate completion events, no extra Missions/KPI writes.
 *   T4 — forged terminal claim (status-only COMPLETED rewrite): the
 *        pass fails closed, no fake WCP, no DONE.
 *   T5 — canonical FAILED terminal: fold lands BLOCKED through the
 *        existing completion policy — never forced DONE.
 *   T6 — no-regression: non-MET objectives still fold via §9; MET still
 *        blocks new allocation and all CEO calls; bounded steps hold
 *        when many children need folding.
 *
 * Harness identical to pair-p15-10d.test.ts: real MissionControl stack,
 * canonical mission completion via the shared canonical seam; "forging"
 * = raw SQL rewrite of persisted rows.
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
  canonicallyTerminateMission,
} from "./canonical-mission-completion.js";

const ROOT = mkTmpDir("pair-p1510-metfold-");
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

type FullStack = {
  dbPath: string;
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  alloc: WorkforceAllocationService;
  authority: ArtifactAuthority;
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

function mkObjective(s: FullStack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "MT5 indicator promotion plan",
    statement: "Produce deliverables.",
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

/** REAL canonical artifact acceptance on a governed execution. */
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

/** Drive a workstream's delegated child to canonical DONE (folded). */
function completeDeliverable(s: FullStack, binding: Row, key: string): string {
  const cid = childOfKey(s, binding, key);
  const row = s.store.get("work_item", cid);
  if (String(row.status) === "READY") s.biz.openWorkItem(cid, OP);
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  acceptArtifact(s, mid, `${key}.md`);
  s.biz.syncWorkItem(cid);
  s.biz.advanceCompletionCascade(cid);
  return cid;
}

/** Drive a bound mission to canonically-RUNNING: legal mission
 *  transitions + the mission_runtime row/transitions — the same rows
 *  the governed runtime emits (mirrors canonical-mission-completion's
 *  own writer shape; it is reused by canonicallyCompleteMission below). */
function canonicallyStartMission(s: FullStack, missionId: string): void {
  const mid = missionId;
  const rtId = `MRT_${mid}`;
  if (!s.store.tryGet("mission_runtime", rtId)) {
    s.store.put("mission_runtime", rtId, {
      mission_runtime_id: rtId,
      mission_id: mid,
      state: "CREATED",
      entered_at: utcnow(),
      reason: "mission_runtime_created",
      barriers: {},
      pending_recovery: null,
      pending_approval_id: null,
      pending_remediation: null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0,
    }, 0);
    s.store.event({
      entity_type: "mission_runtime", entity_id: rtId,
      event_type: "MISSION_RUNTIME_CREATED",
      new_state: "CREATED", actor: "PAIR_MISSION_RUNTIME",
      metadata: { mission_id: mid },
    });
  }
  const transitionRt = (to: string, reason: string) => {
    const cur = s.store.get("mission_runtime", rtId);
    const from = String(cur.state);
    if (from === to) return;
    cur.state = to;
    cur.entered_at = utcnow();
    cur.reason = reason;
    s.store.put("mission_runtime", rtId, cur, Number(cur.version));
    s.store.event({
      entity_type: "mission_runtime", entity_id: rtId,
      event_type: "MISSION_RUNTIME_TRANSITION",
      old_state: from, new_state: to, actor: "PAIR_MISSION_RUNTIME",
      metadata: { mission_id: mid, reason },
    });
  };
  const status = () => String(s.store.get("mission", mid).status);
  if (status() === "CREATED") s.service.transitionMission(mid, "READY", "PAIR_MISSION_RUNTIME");
  if (String(s.store.get("mission_runtime", rtId).state) === "CREATED") {
    transitionRt("READY", "plan_committed");
  }
  if (status() === "READY") s.service.transitionMission(mid, "RUNNING", "PAIR_MISSION_RUNTIME");
  if (String(s.store.get("mission_runtime", rtId).state) === "READY") {
    transitionRt("RUNNING", "tasks_dispatched");
  }
}

/** The mission's canonical lifecycle status derived from its immutable
 *  MISSION_CREATED/MISSION_TRANSITION spine — mirrors the observer's
 *  canonicalDerivedMissionStatus, proving row claims equal evidence. */
function derivedMissionStatus(s: FullStack, missionId: string): string {
  const evs = dbOf(s.store)
    .prepare("SELECT new_state FROM events WHERE entity_id=? AND event_type IN ('MISSION_CREATED','MISSION_TRANSITION') ORDER BY seq")
    .all(missionId) as Array<{ new_state: string | null }>;
  let derived = "CREATED";
  for (const e of evs) if (e.new_state != null) derived = String(e.new_state);
  return derived;
}

/** Open a child + complete its bound mission WITHOUT folding — the exact
 *  stuck shape the audit observed (IN_PROGRESS + terminal mission). */
function terminalUnfoldedChild(s: FullStack, binding: Row, key: string): { cid: string; mid: string } {
  const cid = childOfKey(s, binding, key);
  const row = s.store.get("work_item", cid);
  if (String(row.status) === "READY") s.biz.openWorkItem(cid, OP);
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  return { cid, mid };
}

function grantBundle(s: FullStack, oid: string, rule: Record<string, unknown>) {
  return s.kpiSvc.grant(oid, {
    actor: OWNER, kpi_id: KPI,
    rule: { rule_type: "DELIVERABLE_BUNDLE", ...rule },
    expires_at: FUTURE,
    idempotency_key: `kv-${counter}`,
  });
}

function kpiRow(s: FullStack, oid: string): ObjectiveKpi {
  const o = s.biz.objectives.get(oid);
  return (o.kpis as ObjectiveKpi[]).find((k) => String(k.kpi_id) === KPI)!;
}

function wcpCountFor(s: FullStack, workItemId: string): number {
  return s.store.list<Row>("work_completion")
    .filter((w) => String(w.work_item_id) === workItemId).length;
}

function eventsFor(s: FullStack, entityId: string, eventType: string): Row[] {
  return dbOf(s.store)
    .prepare("SELECT * FROM events WHERE entity_id=? AND event_type=?")
    .all(entityId, eventType) as Row[];
}

const CEO_WAIT = JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
  workstreams: null, priority_order: null,
  wait_reason: "AWAITING_PROGRESS", summary: null,
});

class CountingInvoker implements CeoDecisionInvoker {
  calls = 0;
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.calls++;
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: CEO_WAIT,
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

function seeded(
  name: string,
  keys: string[],
  opts: { allocate?: string[] } = {},
) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, keys);
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  for (const k of opts.allocate ?? keys) {
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
  }
  return { s, oid, bid, binding: s.workstreams.getBinding(oid)! };
}

function mkOps(s: FullStack, invoker?: CountingInvoker) {
  qualifyCeo(s.store);
  const inv = invoker ?? new CountingInvoker();
  const ops = createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams,
    invoker: inv,
  });
  return { ops, inv };
}

/* ============================ T1–T6 ============================ */

describe("P15.10 MET-branch delegated-child fold (audit hotfix)", () => {
  it("T1 KPI MET while bound Mission still RUNNING: no premature fold, no new Mission; folds canonically after terminal", async () => {
    const { s, oid, binding } = seeded("t1", ["a", "b", "c"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    expect(s.kpiSvc.advance(oid)[0]!.outcome).toBe("PROGRESS_RECORDED");
    expect(objectiveKpiAssessment(kpiRow(s, oid))).toBe("MET");

    // Third delegated child: open → canonically RUNNING bound mission
    // (legal MISSION_TRANSITION spine + mission_runtime evidence), the
    // exact shape the audit observed in the live run.
    const cidC = childOfKey(s, binding, "c");
    s.biz.openWorkItem(cidC, OP);
    const midC = boundMissionId(s, cidC);
    canonicallyStartMission(s, midC);
    // Canonical proof the mission is RUNNING: row claim equals the
    // immutable transition spine's derived state, and the runtime row
    // agrees — the same read the observer performs.
    expect(String(s.store.get("mission", midC).status)).toBe("RUNNING");
    expect(derivedMissionStatus(s, midC)).toBe("RUNNING");
    expect(String(s.store.get("mission_runtime", `MRT_${midC}`).state)).toBe("RUNNING");
    const missionsBefore = s.store.list<Row>("mission").length;

    const inv = new CountingInvoker();
    const { ops } = mkOps(s, inv);
    const r1 = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(r1.owner_action_required).toBe(true);
    // Live (non-terminal) bound mission → the fold seam must NOT touch
    // the child; nothing may invent completion.
    expect(String(s.store.get("work_item", cidC).status)).toBe("IN_PROGRESS");
    expect(wcpCountFor(s, cidC)).toBe(0);
    expect(s.store.list<Row>("mission").length).toBe(missionsBefore);

    // Mission now canonically completes → next pass folds through the
    // existing authority: DONE + exactly one WCP + parent cascade.
    canonicallyCompleteMission(s.store, s.service, midC);
    const r2 = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r2.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(String(s.store.get("work_item", cidC).status)).toBe("DONE");
    expect(wcpCountFor(s, cidC)).toBe(1);
    expect(String(s.store.get("work_item", wsWorkItemId(binding, "c")).status)).toBe("DONE");
    // Still zero new Missions — the fold consumed the already-bound one.
    expect(s.store.list<Row>("mission").length).toBe(missionsBefore);
    // And zero CEO model calls across every pass — MET never re-plans.
    expect(inv.calls).toBe(0);
    s.store.close();
  });

  it("T2 terminal Mission never folded + KPI MET: single pass performs canonical fold + WCP + cascade", async () => {
    const { s, oid, binding } = seeded("t2", ["a", "b", "c"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const { cid } = terminalUnfoldedChild(s, binding, "c");
    expect(String(s.store.get("work_item", cid).status)).toBe("IN_PROGRESS");
    expect(wcpCountFor(s, cid)).toBe(0);

    const { ops } = mkOps(s);
    // advance() inside the pass commits the KVR → allTargetsMet → the
    // MET branch itself must fold BEFORE the review observes state.
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(r.owner_action_required).toBe(true);
    expect(String(s.store.get("work_item", cid).status)).toBe("DONE");
    expect(wcpCountFor(s, cid)).toBe(1);
    // Parent cascade ran: workstream container folded too.
    expect(String(s.store.get("work_item", wsWorkItemId(binding, "c")).status)).toBe("DONE");
    // KPI receipt committed by the pass's own advance — same as before.
    expect(s.store.list<Row>(KPI_RECEIPT_ENTITY).length).toBe(1);
    s.store.close();
  });

  it("T3 replay/idempotency: repeated passes mint no duplicate WCP/events/missions", async () => {
    const { s, oid, binding } = seeded("t3", ["a", "b", "c"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const { cid } = terminalUnfoldedChild(s, binding, "c");
    const missionsBefore = s.store.list<Row>("mission").length;

    const { ops } = mkOps(s);
    const r1 = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("TARGET_MET_CANDIDATE");
    expect(String(s.store.get("work_item", cid).status)).toBe("DONE");

    const syncedBefore = eventsFor(s, cid, "WORK_ITEM_SYNCED").length;
    const kpiBefore = Number(kpiRow(s, oid).current);
    for (let i = 0; i < 3; i++) {
      const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
      expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    }
    expect(wcpCountFor(s, cid)).toBe(1);
    expect(eventsFor(s, cid, "WORK_ITEM_SYNCED").length).toBe(syncedBefore);
    expect(s.store.list<Row>("mission").length).toBe(missionsBefore);
    expect(Number(kpiRow(s, oid).current)).toBe(kpiBefore);
    s.store.close();
  });

  it("T4 forged terminal claim (status-only COMPLETED rewrite): fail-closed, no fake WCP/DONE", async () => {
    const { s, oid, binding } = seeded("t4", ["a", "b", "c"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const cidC = childOfKey(s, binding, "c");
    s.biz.openWorkItem(cidC, OP);
    const midC = boundMissionId(s, cidC);
    // Adversary: mutable status claims COMPLETED with zero canonical
    // transition/runtime evidence.
    sqlRewriteEntity(s.store, "mission", midC, (b) => { b.status = "COMPLETED"; });

    const { ops } = mkOps(s);
    // The strict observation must not even let the fold run on a claim
    // that contradicts canonical lifecycle derivation — fail closed,
    // and the child mints no completion evidence.
    await expect(ops.service.runObjectivePass({ objective_id: oid, actor: OP }))
      .rejects.toMatchObject({ code: expect.stringContaining("FAIL_CLOSED") });
    expect(String(s.store.get("work_item", cidC).status)).toBe("IN_PROGRESS");
    expect(wcpCountFor(s, cidC)).toBe(0);
    s.store.close();
  });

  it("T5 canonical FAILED terminal: fold lands BLOCKED via existing completion policy — never DONE", async () => {
    const { s, oid, binding } = seeded("t5", ["a", "b", "c"]);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const cidC = childOfKey(s, binding, "c");
    s.biz.openWorkItem(cidC, OP);
    const midC = boundMissionId(s, cidC);
    canonicallyTerminateMission(s.store, s.service, midC, "FAILED");

    const { ops } = mkOps(s);
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    // FAILED folds through syncWorkItem → BLOCKED, no WCP, no DONE.
    expect(String(s.store.get("work_item", cidC).status)).toBe("BLOCKED");
    expect(wcpCountFor(s, cidC)).toBe(0);
    s.store.close();
  });

  it("T6a non-MET objectives still fold via the §9 path (old flow unchanged)", async () => {
    const { s, oid, binding } = seeded("t6a", ["a", "b"]);
    // No grant → KPI stays UNVERIFIED → the §9 seam, not the MET branch.
    const { cid } = terminalUnfoldedChild(s, binding, "a");
    const { ops } = mkOps(s);
    await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(String(s.store.get("work_item", cid).status)).toBe("DONE");
    expect(wcpCountFor(s, cid)).toBe(1);
    s.store.close();
  });

  it("T6b MET still blocks new allocation and all CEO calls", async () => {
    const { s, oid, binding } = seeded("t6b", ["a", "b", "c"], { allocate: ["a", "b"] });
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const missionsBefore = s.store.list<Row>("mission").length;

    const inv = new CountingInvoker();
    const { ops } = mkOps(s, inv);
    const r = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("TARGET_MET_CANDIDATE");
    // Workstream "c" was never allocated — MET must still authorize
    // zero new workforce work: no WAL, no Mission, no CEO invocation.
    const walC = s.store.list<Row>(WORKFORCE_ALLOCATION_ENTITY).find(
      (w) => String(w.workstream_work_item_id) === wsWorkItemId(binding, "c"));
    expect(walC).toBeUndefined();
    expect(s.store.list<Row>("mission").length).toBe(missionsBefore);
    expect(inv.calls).toBe(0);
    s.store.close();
  });

  it("T6c bounded steps: 8 unfolded children fold within the step bound — no crash, converges next pass", async () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const { s, oid, binding } = seeded("t6c", keys);
    grantBundle(s, oid, { required_count: 2 });
    completeDeliverable(s, binding, "a");
    completeDeliverable(s, binding, "b");
    const unfolded = keys.slice(2).map((k) => terminalUnfoldedChild(s, binding, k).cid);
    expect(unfolded.length).toBe(8);

    const { ops } = mkOps(s);
    // 8 folds consume the pass bound (OBJECTIVE_OPERATING_MAX_INTERNAL_
    // STEPS = 8): the review tick exceeds → graceful WAITING, with the
    // committed folds durable — never a crash, never a partial write.
    const r1 = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("WAITING");
    for (const cid of unfolded) {
      expect(String(s.store.get("work_item", cid).status)).toBe("DONE");
      expect(wcpCountFor(s, cid)).toBe(1);
    }
    // Next pass: nothing left to fold → the MET review commits.
    const r2 = await ops.service.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r2.outcome).toBe("TARGET_MET_CANDIDATE");
    s.store.close();
  });
});
