/**
 * HOTFIX-B — Governed redispatch after WORK_ITEM_UNBLOCKED.
 *
 * A work item legitimately unblocked to READY after prior bound
 * missions reached canonical terminal states must become eligible for
 * ONE new governed mission attempt through the existing
 * BusinessLayer.openWorkItem seam — never a reopen, never a bypass.
 *
 * Convention (as p15-6): "forging" = raw SQL rewrite of persisted
 * rows; every service call is REAL through the canonical seams.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  artifactDependencySetDigest,
  ArtifactProvenanceValidator,
  bindPlanExternalInputs,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
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
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  sha256Hex,
  utcnow,
  workerExecutionId,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = mkTmpDir("pair-hotfixb-");
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const EX = "EX_A";
let seq = 0;

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

function errCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return String((e as { code?: string }).code ?? e);
  }
  return null;
}

/* ---------------- stack wiring (same seams as p15-6) ---------------- */

type FullStack = {
  dbPath: string;
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  alloc: WorkforceAllocationService;
  service: PairControlPlane;
  control: MissionControl;
  runtime: MissionRuntime;
  projectId: string;
};

function wireStack(
  dir: string, workspace: string, dbPath: string, store: PairEvidenceStore,
): FullStack {
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
  const projects = store.list("project") as Array<Record<string, unknown>>;
  return { dbPath, dir, workspace, store, biz, wf, workstreams, alloc,
    service, control, runtime, projectId: String(projects[0]?.project_id ?? "") };
}

function freshFullStack(name: string): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const s = wireStack(dir, workspace, dbPath, store);
  const project = s.service.createProject({ name: "p", root_location: workspace });
  return { ...s, projectId: String(project.project_id) };
}

/** Crash/restart: close the store, rewire the ENTIRE service stack
 *  over the same durable state — nothing in memory may carry over. */
function reopenFullStack(s: FullStack): FullStack {
  s.store.close();
  const store = new PairEvidenceStore(s.dbPath);
  return wireStack(s.dir, s.workspace, s.dbPath, store);
}

function mkBusiness(s: FullStack) {
  const b = s.biz.createBusiness({ name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  return String(b.business_id);
}

function mkObjective(s: FullStack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "grow the channel",
    statement: "Grow the channel",
    kpis: [{ name: "d", unit: "u", baseline: 0, target: 3 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["x"],
    success_conditions: ["y"],
    dedup_key: `dk-${counter}`,
    operator_id: OP,
  });
}

function mkAgent(s: FullStack, businessId: string) {
  return s.biz.createOrgAgent({
    business_id: businessId, title: `agent ${counter}`,
    department: "ops", operator_id: OP,
  });
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
    return typeof item === "function" ? await item(input) : {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: item,
    };
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

const INIT_JSON = (keys: Array<string | [string, string[]]>) =>
  decisionJson({
    decision_kind: "INITIALIZE_WORKSTREAMS",
    wait_reason: null,
    workstreams: keys.map((k) => {
      const [key, deps] = Array.isArray(k) ? k : [k, [] as string[]];
      return { workstream_key: key, title: `ws ${key}`, goal: `g ${key}`, depends_on_keys: deps };
    }),
    priority_order: keys.map((k) => Array.isArray(k) ? k[0] : k),
    summary: "initialize workstreams",
  });

const WAIT_JSON = decisionJson();

function opStack(s: FullStack, invoker: CeoDecisionInvoker) {
  return createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams,
    invoker,
  }).service;
}

/* ---------------- canonical chain helpers ---------------- */

function wsWorkItemId(binding: Record<string, unknown>, key: string): string {
  const ws = (binding.workstreams as Array<Record<string, unknown>>)
    .find((w) => String(w.workstream_key) === key)!;
  return String(ws.work_item_id);
}

/** The delegated child pinned by a workstream's canonical WAL. */
function childOfKey(
  s: FullStack, binding: Record<string, unknown>, key: string,
): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
    .find((r) =>
      String((r as Record<string, unknown>).workstream_work_item_id) === wid) as
      Record<string, unknown> | undefined;
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: FullStack, childId: string): string {
  const row = s.store.get("work_item", childId);
  const mission = s.biz.boundMissionForWorkItem(row);
  if (!mission) throw new Error(`no bound mission for ${childId}`);
  return String(mission.mission_id);
}

/** Canonical live mission — BOTH the mission row and its runtime
 *  row transition through the real seams (assertCanonicalMissionLifecycle
 *  re-proves runtime evidence, never the mutable status alone). */
function missionRunning(s: FullStack, mid: string) {
  if (String(s.store.get("mission", mid).status) === "CREATED") {
    s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
    s.runtime.transitionRuntime(mid, "READY", "t");
  }
  s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
  s.runtime.transitionRuntime(mid, "RUNNING", "t");
}

/** Canonically terminal FAILED — mission + runtime transitions both. */
function missionFailed(s: FullStack, mid: string) {
  s.service.transitionMission(mid, "FAILED", `OPERATOR:${OP}`);
  s.runtime.transitionRuntime(mid, "FAILED", "t");
}

function missionCount(s: FullStack): number {
  return s.store.list("mission").length;
}

function decompose(s: FullStack, oid: string, keys: Array<string | [string, string[]]>) {
  const o = s.biz.objectives.get(oid);
  const workstreams = keys.map((k) => {
    const [key, deps] = Array.isArray(k) ? k : [k, [] as string[]];
    return { workstream_key: key, title: `ws ${key}`, goal: `g ${key}`, depends_on_keys: deps };
  });
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

/** seeded 2-workstream objective — w2 depends on w1 (as the production
 *  incident's shape: sequential decomposition). */
function seeded(
  name: string,
  invoker: CeoDecisionInvoker,
  keys: Array<string | [string, string[]]> = ["w1", ["w2", ["w1"]]],
) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, keys);
  mkAgent(s, bid);
  seedDefaultCeoModel(s.store);
  const ops = opStack(s, invoker);
  return { s, oid, bid, binding, ops, invoker };
}

/** Drive w-key child to READY-after-unblock with a canonically terminal
 *  predecessor, through the real governed seams only:
 *  bound mission → RUNNING → FAILED → syncWorkItem folds to BLOCKED →
 *  owner unblock → READY + WORK_ITEM_UNBLOCKED event. */
async function failThenUnblock(
  s: FullStack, cid: string, mid: string,
): Promise<void> {
  missionRunning(s, mid);
  missionFailed(s, mid);
  s.biz.syncWorkItem(cid);
  expect(String(s.store.get("work_item", cid).status)).toBe("BLOCKED");
  s.biz.unblockWorkItem(cid, OP);
  expect(String(s.store.get("work_item", cid).status)).toBe("READY");
}

/* ================ ACCEPTANCE + ADVERSARIAL TESTS ================ */

describe("HOTFIX-B governed redispatch after WORK_ITEM_UNBLOCKED", () => {

  it("HB1: READY + canonical terminal predecessor + explicit unblock → ONE new attempt", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb1", inv);
    // Allocate + dispatch w1 → complete it canonically → fold DONE.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const r1 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r1.outcome).toBe("DISPATCHED");
    const w1c = childOfKey(s, b, "w1");
    const w1m = boundMissionId(s, w1c);
    missionRunning(s, w1m);
    canonicallyCompleteMission(s.store, s.service, w1m);
    s.biz.syncWorkItem(w1c);
    s.biz.advanceCompletionCascade(w1c);
    // w2 attempt 1: allocate + dispatch → fail terminally → unblock.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w2", actor: OP });
    const r2 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r2.outcome).toBe("DISPATCHED");
    const w2c = childOfKey(s, b, "w2");
    const m1 = boundMissionId(s, w2c);
    await failThenUnblock(s, w2c, m1);
    // THE FIX: autonomous pass must now mint a NEW attempt through the
    // same openWorkItem seam — pre-fix this item was stuck at
    // INTERVENTION forever.
    const r3 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r3.outcome).toBe("DISPATCHED");
    const m2 = boundMissionId(s, w2c);
    expect(m2).not.toBe(m1);
    // Immutable evidence preserved — both WOB attempts + both missions.
    expect(missionCount(s)).toBe(3);
    const wobs = s.store.list("work_open_binding")
      .filter((w) => String((w as Record<string, unknown>).work_item_id) === w2c);
    expect(wobs.length).toBe(2);
    expect(String(s.store.get("mission", m1).status)).toBe("FAILED");
  });

  it("HB2: non-terminal predecessor — forged READY claim fails closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb2", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    missionRunning(s, boundMissionId(s, w1c));
    // Forged: row claims READY while the canonical event-derived
    // status is IN_PROGRESS with a live bound mission.
    sqlRewriteEntity(s.store, "work_item", w1c, (row) => { row.status = "READY"; });
    let code: string | null = null;
    try {
      await ops.runObjectivePass({ objective_id: oid, actor: OP });
    } catch (e) {
      code = String((e as { code?: string }).code ?? e);
    }
    // The pass fails closed (claim ≠ event-derived truth) — the forge
    // NEVER produces a second mission.
    expect(code).not.toBeNull();
    expect(missionCount(s)).toBe(1);
  });

  it("HB3: forged lifecycle — terminal claim without transition evidence never reopens", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb3", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    missionFailed(s, m1);
    s.biz.syncWorkItem(w1c);
    s.biz.unblockWorkItem(w1c, OP);
    // Forge: flip the terminal claim back to RUNNING — the immutable
    // MISSION_TRANSITION evidence still proves FAILED.
    sqlRewriteEntity(s.store, "mission", m1, (row) => { row.status = "RUNNING"; });
    let code: string | null = null;
    try {
      await ops.runObjectivePass({ objective_id: oid, actor: OP });
    } catch (e) {
      code = String((e as { code?: string }).code ?? e);
    }
    expect(code).not.toBeNull();
    expect(missionCount(s)).toBe(1);
  });

  it("HB4: stale/unbound wake — tampered WOB history never mints an attempt", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb4", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    // Tamper: rewrite the WOB's pinned mission id — lineage no longer
    // matches the immutable WOB digest/binding chain.
    const wob = s.store.list("work_open_binding")
      .find((w) => String((w as Record<string, unknown>).work_item_id) === w1c)!;
    sqlRewriteEntity(s.store, "work_open_binding",
      String((wob as Record<string, unknown>).open_id), (row) => {
        row.mission_id = "MSN_FORGED";
      });
    let code: string | null = null;
    try {
      await ops.runObjectivePass({ objective_id: oid, actor: OP });
    } catch (e) {
      code = String((e as { code?: string }).code ?? e);
    }
    expect(code).not.toBeNull();
    expect(missionCount(s)).toBe(1);
  });

  it("HB5: duplicate tick + restart — exactly ONE new attempt total", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb5", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    // Concurrent ticks race the SAME open seam — pending-open dedup +
    // bound-mission convergence allow at most one mint.
    const results = await Promise.allSettled([
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
      ops.runObjectivePass({ objective_id: oid, actor: OP }),
    ]);
    const dispatched = results.filter((r) =>
      r.status === "fulfilled" &&
      (r.value as { outcome?: string }).outcome === "DISPATCHED");
    expect(dispatched.length).toBeLessThanOrEqual(1);
    expect(missionCount(s)).toBe(2);
    const m2 = boundMissionId(s, w1c);
    expect(m2).not.toBe(m1);
    // Crash/restart: rewire the entire stack over durable state; the
    // next pass converges through the live bound mission — no dup.
    const s2 = reopenFullStack(s);
    const ops2 = opStack(s2, inv);
    const r3 = await ops2.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r3.outcome).toBe("AWAITING_EXECUTION");
    expect(missionCount(s2)).toBe(2);
  });

  it("HB6: mission-cap exhaustion — hard budget cap refuses the new attempt", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, bid, binding: b, ops } = seeded("hb6", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    // 1-mission daily cap at business scope — attempt #2 must fail.
    s.biz.createBudgetPolicy({
      business_id: bid, scope_type: "business", period: "DAY",
      max_missions: 1, operator_id: OP,
    });
    let reopened = false;
    try {
      const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
      reopened = (r as { outcome?: string }).outcome === "DISPATCHED";
    } catch { /* hard stop is a fail-closed throw */ }
    expect(reopened).toBe(false);
    expect(missionCount(s)).toBe(1);
  });

  it("HB7: actual scheduler admission — real unblock wake claims once, revoked policy + stale binding denied", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb7", inv);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    let t = Date.now();
    const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives, () => t);
    const scheduler = new ObjectiveAutoScheduler(s.store, s.biz.objectives, policy, () => t);
    const wakeup = new ObjectiveAutoWakeupService(s.store, scheduler, () => t);
    policy.control({ objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: "2999-01-01T00:00:00.000Z", max_ceo_calls: 4 },
      idempotency_key: `cfg-${oid}` });
    policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: `en-${oid}` });
    // REAL intake seam: the canonical WORK_ITEM_UNBLOCKED event is
    // paged in, resolved to the allocation-bound work_item witness,
    // re-proven hop-by-hop in accountWake, and lands as a pending
    // generation the admission predicate can actually claim.
    wakeup.tick();
    const eligible = scheduler.claimable(oid);
    expect(eligible.eligible).toBe(true);
    const handle = scheduler.claim(oid, "w1", "boot1", "hb7-claim");
    expect(handle.objective_id).toBe(oid);
    expect(handle.claimed_generation).toBeGreaterThan(0);
    // STALE/UNBOUND WAKE — a binding whose work item sits outside the
    // pinned allocation fails closed inside verifyWakeBinding before
    // any queue write.
    const unblockEv = s.store.listEvents("work_item", w1c)
      .find((e) => String(e.event_type) === "WORK_ITEM_UNBLOCKED")!;
    const wal = s.store.list(WORKFORCE_ALLOCATION_ENTITY)
      .find((r) =>
        String((r as Record<string, unknown>).delegated_child_work_item_id) === w1c)!;
    const bad = errCode(() => scheduler.accountWake({
      objective_id: oid,
      source_event_id: String((unblockEv as Record<string, unknown>).event_id),
      reason: "WORK_ITEM_UNBLOCKED",
      binding: { kind: "work_item",
        allocation_id: String((wal as Record<string, unknown>).allocation_id),
        work_item_id: "WI_FORGED_STALE" },
    }));
    expect(bad).not.toBeNull();
    // REVOKED auto-policy — the admission seam re-reads the CURRENT
    // effective authority: claimable flips to POLICY_NOT_EFFECTIVE and
    // claim() never mints a lease.
    policy.control({ objective_id: oid, actor: OWNER, action: "revoke",
      policy_version: 2, idempotency_key: `rv-${oid}` });
    t += 31_000; // past the 30s attempt cooldown — the denial below
    // reads CURRENT policy authority, never a timing artifact.
    const afterRevoke = scheduler.claimable(oid);
    expect(afterRevoke.eligible).toBe(false);
    expect(afterRevoke.reason).toBe("POLICY_NOT_EFFECTIVE");
    expect(errCode(() =>
      scheduler.claim(oid, "w2", "boot2", "hb7-claim2"))).not.toBeNull();
    expect(missionCount(s)).toBe(1);
  });

  it("HB8: A+B compat — reopened attempt consumes terminal sibling artifact", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb8", inv);
    // w1 completes canonically and ACCEPTS an artifact.
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const w1m = boundMissionId(s, w1c);
    missionRunning(s, w1m);
    canonicallyCompleteMission(s.store, s.service, w1m);
    s.biz.syncWorkItem(w1c);
    s.biz.advanceCompletionCascade(w1c);
    const art = mkAcceptedArtifact(s, w1m, "brief.md",
      Buffer.from("# brief — canonical bytes"));
    // w2 attempt 1 fails → unblock → redispatch (attempt 2).
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w2", actor: OP });
    const r0 = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r0.outcome).toBe("DISPATCHED");
    const w2c = childOfKey(s, b, "w2");
    const w2m1 = boundMissionId(s, w2c);
    await failThenUnblock(s, w2c, w2m1);
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    const w2m2 = boundMissionId(s, w2c);
    expect(w2m2).not.toBe(w2m1);
    // The REOPENED attempt sees the canonical eligible source set:
    // w1's ACCEPTED artifact across mission boundary (Hotfix-A seam).
    const m2row = s.store.get("mission", w2m2) as Record<string, unknown>;
    const sources = s.service.artifactResolver
      .listEligibleExternalInputSources(m2row);
    expect(sources.map((x) => String(x.artifact_id))).toContain(art.artifactId);
    // And bytes materialize through the F6 consume-time re-proof lane.
    // The consumer task declares the consume and carries the canonical
    // external-input stamp (planner-visible contract v1).
    const taskRow = {
      task_id: `ATSK_CONS_${seq++}`,
      plan_id: "PLAN_C",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
      metadata: { pair_dataflow: { produces: [], consumes: ["brief.md"] } },
    };
    const tasks = [taskRow];
    bindPlanExternalInputs(tasks as never, sources);
    const entries = s.service.artifactResolver.resolveForConsumer({
      mission: { ...m2row, plan_revision: 1 },
      task: taskRow as never,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifact_id).toBe(art.artifactId);
    const gtId = `GT_CONS_${seq++}`;
    const depDigest = artifactDependencySetDigest(entries);
    s.store.put("governed_task", gtId, {
      governed_task_id: gtId, mission_id: w2m2, task_id: taskRow.task_id,
      correlation_id: `COR_${gtId}`, executor_id: EX, plan_revision: 1,
      workspace: s.workspace, allowed_paths: [s.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      dependency_artifacts: entries,
      dependency_artifacts_digest: depDigest,
      created_at: utcnow(), version: 0,
    }, 0);
    s.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${gtId}`,
      metadata: {
        mission_id: w2m2, task_id: taskRow.task_id, executor_id: EX,
        dependency_artifacts_digest: depDigest,
      },
    });
    s.service.artifactHandoffs.pinForGovernedTask(
      s.store.get("governed_task", gtId), entries, "LOCAL_MATERIALIZATION");
    const written = s.service.artifactHandoffs.materializeForConsumer(
      s.store.get("governed_task", gtId));
    expect(written).toHaveLength(1);
    const dest = path.join(s.workspace, entries[0]!.consumer_relative_path);
    expect(fs.readFileSync(dest).toString()).toBe("# brief — canonical bytes");
    expect(sha256Hex(fs.readFileSync(dest))).toBe(String(art.artifact.sha256));
  });

  /* ---------- R1-F1: exact WORK_ITEM_UNBLOCKED provenance ---------- */

  /** READY derived from WORK_REWORK_REQUESTED — never an unblock —
   *  must NOT classify REOPENABLE even with a terminal bound mission. */
  it("HB9: READY from WORK_REWORK_REQUESTED without unblock → not REOPENABLE", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb9", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    missionFailed(s, m1);
    s.biz.syncWorkItem(w1c);
    expect(String(s.store.get("work_item", w1c).status)).toBe("BLOCKED");
    // A READY claim produced by a REVIEW-REWORK event — no unblock.
    s.store.event({
      entity_type: "work_item", entity_id: w1c,
      event_type: "WORK_REWORK_REQUESTED",
      old_state: "REVIEW_REQUIRED", new_state: "READY",
      actor: OWNER, metadata: { decision: "REWORK" },
    });
    sqlRewriteEntity(s.store, "work_item", w1c, (row) => { row.status = "READY"; });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /** READY derived from a rolled-back open — never an unblock —
   *  must NOT classify REOPENABLE. */
  it("HB10: READY from WORK_ITEM_OPEN_ROLLED_BACK without qualifying unblock → not REOPENABLE", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb10", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    missionFailed(s, m1);
    s.biz.syncWorkItem(w1c);
    // A READY claim produced by an open-rollback audit event.
    s.store.event({
      entity_type: "work_item", entity_id: w1c,
      event_type: "WORK_ITEM_OPEN_ROLLED_BACK",
      old_state: "IN_PROGRESS", new_state: "READY",
      actor: "PAIR_BUSINESS_LAYER", metadata: { open_id: "OPN_FORGED" },
    });
    sqlRewriteEntity(s.store, "work_item", w1c, (row) => { row.status = "READY"; });
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /** Malformed unblock (wrong old_state) and a superseded unblock
   *  (a later READY-producing event stole the provenance) — both
   *  fail closed. */
  it("HB11: malformed / incorrectly-ordered unblock events → fail closed", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    // (a) malformed shape: WORK_ITEM_UNBLOCKED claiming READY→READY.
    {
      const { s, oid, binding: b, ops } = seeded("hb11a", inv, ["w1"]);
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
      await ops.runObjectivePass({ objective_id: oid, actor: OP });
      const w1c = childOfKey(s, b, "w1");
      const m1 = boundMissionId(s, w1c);
      await failThenUnblock(s, w1c, m1);
      s.store.event({
        entity_type: "work_item", entity_id: w1c,
        event_type: "WORK_ITEM_UNBLOCKED",
        old_state: "READY", new_state: "READY", actor: OWNER,
      });
      const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
      expect(r.outcome).not.toBe("DISPATCHED");
      expect(boundMissionId(s, w1c)).toBe(m1);
      expect(missionCount(s)).toBe(1);
    }
    // (b) the authentic unblock exists but is NOT the current READY
    // provenance — a later READY-producing event supersedes it.
    {
      const { s, oid, binding: b, ops } = seeded("hb11b", inv, ["w1"]);
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
      await ops.runObjectivePass({ objective_id: oid, actor: OP });
      const w1c = childOfKey(s, b, "w1");
      const m1 = boundMissionId(s, w1c);
      await failThenUnblock(s, w1c, m1);
      s.store.event({
        entity_type: "work_item", entity_id: w1c,
        event_type: "WORK_ITEM_ASSIGNED",
        old_state: "READY", new_state: "READY", actor: "PAIR_BUSINESS_LAYER",
      });
      const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
      expect(r.outcome).not.toBe("DISPATCHED");
      expect(boundMissionId(s, w1c)).toBe(m1);
      expect(missionCount(s)).toBe(1);
    }
  });

  /* ---------- R1-F2: re-proof AT the final dispatch boundary ---------- */

  /** Provenance drift injected between review classification and the
   *  openWorkItem crossing — a REWORK event lands after REOPENABLE was
   *  observed, so READY no longer derives from the unblock. The
   *  boundary re-proof must fail closed with ZERO new attempts. */
  it("HB12: status-provenance drift between review and beforeOpen → zero new attempts", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb12", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    let code: string | null = null;
    try {
      await ops.runObjectivePass({
        objective_id: oid, actor: OP,
        hooks: { beforeOpen: () => {
          // Drift: READY's provenance becomes WORK_REWORK_REQUESTED
          // between the earlier observation and this exact crossing.
          s.store.event({
            entity_type: "work_item", entity_id: w1c,
            event_type: "WORK_REWORK_REQUESTED",
            old_state: "REVIEW_REQUIRED", new_state: "READY",
            actor: OWNER, metadata: { decision: "REWORK" },
          });
        } },
      });
    } catch (e) {
      code = String((e as { code?: string }).code ?? e);
    }
    expect(code).not.toBeNull();
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /* ---------- R2-F3: strict causal ordering of the BLOCKED episode ---------- */

  /** Audit A: an unblock issued while the bound mission was still
   *  PAUSED can never authorize redispatch after the mission later
   *  goes terminal — the episode preceding the unblock is the
   *  operator BLOCK (pre-terminal), not a canonical fold. */
  it("HB13: pre-terminal unblock — operator BLOCK pauses mission, unblock while PAUSED, mission later CANCELLED → never redispatches", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb13", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    // Operator blocks the in-flight item — canonically pauses m1.
    s.biz.blockWorkItem(w1c, "operator hold", OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("BLOCKED");
    expect(String(s.store.get("mission", m1).status)).toBe("PAUSED");
    // Unblock while m1 still PAUSED → READY (pre-terminal unblock).
    s.biz.unblockWorkItem(w1c, OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("READY");
    // The bound mission only reaches terminal AFTER that unblock.
    s.service.transitionMission(m1, "CANCELLED", `OPERATOR:${OP}`);
    s.runtime.transitionRuntime(m1, "CANCELLED", "t");
    expect(String(s.store.get("mission", m1).status)).toBe("CANCELLED");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /** Audit B: an OLDER mission-linked BLOCKED fold exists in history,
   *  but the BLOCKED episode immediately preceding the CURRENT unblock
   *  is an unrelated operator block — the old event cannot be reused. */
  it("HB14: older linked BLOCKED exists but latest episode is unrelated → not REOPENABLE", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb14", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    await failThenUnblock(s, w1c, m1);
    // READY + terminal-bound → operator blocks from READY (no mission
    // paused — the bound predecessor is already terminal), then
    // unblocks. The episode immediately before THIS unblock is the
    // operator block, not the m1 fold deeper in history.
    s.biz.blockWorkItem(w1c, "operator re-hold", OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("BLOCKED");
    s.biz.unblockWorkItem(w1c, OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("READY");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /** Audit R3-F4: a BLOCKED fold minted AFTER the mission's terminal
   *  transition but BEFORE the runtime's terminal event is a real
   *  canonical fold with a real shape — yet sits out of order vs the
   *  runtime spine. Ordering proof must reject redispatch even though
   *  mission and runtime rows both read terminal now. */
  it("HB15: fold between mission-terminal and runtime-terminal → not REOPENABLE despite terminal rows", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb15", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    // Mission reaches terminal while runtime still RUNNING — a real
    // fold cannot be minted here (syncWorkItem itself requires the
    // canonical lifecycle), so the episode is adversarially injected
    // in the exact fold shape.
    s.service.transitionMission(m1, "FAILED", `EXECUTOR:${m1}`);
    expect(String(s.store.get("mission", m1).status)).toBe("FAILED");
    expect(String(s.store.get("mission_runtime", `MRT_${m1}`).state))
      .toBe("RUNNING");
    // Injected fold-shaped event — correct type, producer and mission
    // binding, but sequenced BEFORE the runtime's terminal event.
    s.store.event({
      entity_type: "work_item", entity_id: w1c,
      event_type: "WORK_ITEM_SYNCED",
      old_state: "IN_PROGRESS", new_state: "BLOCKED",
      actor: "PAIR_BUSINESS_LAYER",
      metadata: { mission_id: m1, mission_status: "FAILED" },
    });
    sqlRewriteEntity(s.store, "work_item", w1c, (row) => { row.status = "BLOCKED"; });
    // Runtime only now reaches terminal — AFTER the injected fold.
    s.runtime.transitionRuntime(m1, "FAILED", "t");
    expect(String(s.store.get("mission_runtime", `MRT_${m1}`).state))
      .toBe("FAILED");
    s.biz.unblockWorkItem(w1c, OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("READY");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).not.toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).toBe(m1);
    expect(missionCount(s)).toBe(1);
  });

  /** R4 positive pairing: `assertCanonicalMissionLifecycle` permits
   *  mission FAILED ↔ runtime ABORTED (abortMission). The canonical
   *  fold + operator unblock must yield exactly one redispatch — the
   *  ordering check's runtime terminal vocabulary now includes it. */
  it("HB16: mission FAILED + runtime ABORTED → canonical fold + unblock → exactly one reopen", async () => {
    const inv = new FakeInvoker(WAIT_JSON);
    const { s, oid, binding: b, ops } = seeded("hb16", inv, ["w1"]);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({ objective_id: oid, actor: OP });
    const w1c = childOfKey(s, b, "w1");
    const m1 = boundMissionId(s, w1c);
    missionRunning(s, m1);
    s.service.transitionMission(m1, "FAILED", `EXECUTOR:${m1}`);
    s.runtime.transitionRuntime(m1, "ABORTED", "t");
    expect(String(s.store.get("mission", m1).status)).toBe("FAILED");
    expect(String(s.store.get("mission_runtime", `MRT_${m1}`).state))
      .toBe("ABORTED");
    s.biz.syncWorkItem(w1c);
    expect(String(s.store.get("work_item", w1c).status)).toBe("BLOCKED");
    s.biz.unblockWorkItem(w1c, OP);
    expect(String(s.store.get("work_item", w1c).status)).toBe("READY");
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("DISPATCHED");
    expect(boundMissionId(s, w1c)).not.toBe(m1);
    expect(missionCount(s)).toBe(2);
  });
});

/* ---------------- Hotfix-A artifact fixture (adapted ctx) -------------- */

/** Mint an ACCEPTED artifact with a canonically anchored producer PASS
 *  on missionId — same canonical write chain as pair-hotfix-a tests. */
function mkAcceptedArtifact(
  s: FullStack, missionId: string, name: string, bytes: Buffer,
) {
  const tid = `ATSK_S_${seq++}`;
  const key = `TS${seq}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(EX, gtId);
  s.store.put("task", tid, {
    task_id: tid, task_key: key, mission_id: missionId,
    plan_id: "PLAN_A", title: key,
    task_instruction: `produce ${name}`,
    required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
    status: "COMPLETED",
    metadata: { pair_dataflow: { produces: [name], consumes: [] } },
    version: 0,
  }, 0);
  s.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: EX,
    plan_id: "PLAN_A", plan_revision: 1,
    workspace: s.workspace, allowed_paths: [s.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  s.store.event({
    entity_type: "governed_task", entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
    metadata: {
      mission_id: missionId, task_id: tid, executor_id: EX,
      governed_task_id: gtId, plan_id: "PLAN_A", plan_revision: 1,
      remote_produces_contract: false,
      declared_produces: [name], declared_produces_digest: null,
    },
  });
  s.store.event({
    entity_type: "governed_task", entity_id: gtId,
    event_type: "EXECUTION_PREPARED", old_state: "VALIDATED",
    new_state: "DISPATCH_AUTHORIZED", actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
  });
  s.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
    intent_id: `INTENT_${gtId}`, governed_task_id: gtId,
    executor_id: EX, state: "EXECUTION_PERSISTED",
    execution_id: eid, created_at: utcnow(), version: 0,
  }, 0);
  fs.writeFileSync(path.join(s.workspace, name), bytes);
  s.store.put("executor_execution", eid, {
    execution_id: eid, governed_task_id: gtId, mission_id: missionId,
    task_id: tid, executor_id: EX, plan_revision: 1,
    correlation_id: `COR_${tid}`, execution_state: "COMPLETED",
    dispatch_timestamp: utcnow(), run_root: `${s.workspace}/run`,
    workspace: s.workspace,
    result: {
      status: "COMPLETED", output: "done",
      artifacts: [{ path: name, sha256: sha256Hex(bytes), byte_size: bytes.length }],
    },
    version: 0,
  }, 0);
  s.store.event({
    entity_type: "executor_execution", entity_id: eid,
    event_type: "EXECUTION_DISPATCHED", new_state: "COMPLETED",
    actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
    metadata: { governed_task_id: gtId },
  });
  s.store.event({
    entity_type: "executor_execution", entity_id: eid,
    event_type: "RESULT_COLLECTED", new_state: "COMPLETED",
    actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
  });
  const validation = new ArtifactProvenanceValidator()
    .validate_execution(s.service, eid) as Record<string, unknown>;
  if (String(validation.status) !== "PASS") {
    throw new Error(
      `fixture validation not PASS: ${JSON.stringify(validation.failures)}`);
  }
  const art = s.store.list("artifact")
    .find((a) => String((a as Record<string, unknown>).logical_name) === name)!;
  return { artifactId: String((art as Record<string, unknown>).artifact_id), artifact: art };
}

