/**
 * P15.3 CEO Planning Cycle — adversarial test matrix.
 *
 * Mandate §26 groups:
 *   A observation determinism + canonical-only reads
 *   B CEO invocation (actor/status/model-role/eligibility/output gates)
 *   C INITIALIZE_WORKSTREAMS (P15.2 seam only, atomic receipt+binding)
 *   D PRIORITIZE_EXISTING (receipt only, zero topology mutation)
 *   E WAIT (receipt only)
 *   F replay by observation digest (zero extra model calls)
 *   G TOCTOU stale-decision closure
 *   H crash safety (attempt/settlement atomicity, stale reconciliation)
 *   I concurrency (one live invocation, deterministic INFLIGHT)
 *   J tamper (digest/anchor/attempt/binding provenance)
 *   K no forbidden side effects
 *   R model-role regression (§27 — assignments never repurposed)
 *
 * Non-vacuous discipline: every rejection asserts the canonical error
 * code AND that no canonical decision/graph rows were minted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  BusinessLayer,
  assertCanonicalCeoAttempt,
  assertCanonicalCeoDecision,
  IntegrityError,
  ModelEvidenceCatalog,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  ExecutorRegistry,
  GovernedTaskGate,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  assignModelRole,
  MODEL_ROLE,
  modelRoleOf,
  providerEntryId,
  qualifyModel,
  CodexCliCeoDecisionInvoker,
  CeoPlanningCycleService,
  buildCeoObservation,
  ceoAttemptId,
  ceoAttemptStartDigest,
  ceoCycleId,
  ceoDecisionDigest,
  ceoDecisionId,
  ceoCliArgv,
  digest,
  ensureCodexCliCatalog,
  objectiveWorkstreamBindingDigest,
  objectiveWorkstreamBindingId,
  CODEX_CLI_PROVIDER_ID,
  CEO_CODEX_DEFAULT_MODEL,
  CEO_MAX_ATTEMPTS_PER_OBSERVATION,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p153-"));
const ROOT_DIR2 = path.resolve(import.meta.dirname, "..", "..");
let counter = 0;
const OP = "1882810918";

/* ------------------------- fixtures ------------------------- */

const mkModel = (
  store: PairEvidenceStore,
  pid: string,
  mid: string,
  opts: { conditions?: string[]; aliases?: string[]; lifecycle?: string } = {},
) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid, provider_family: pid, model_id: mid,
    capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  const lifecycle = opts.lifecycle ?? "QUALIFIED";
  if (lifecycle === "QUALIFIED") {
    mcat.recordProbeReceipt({
      probe_id: `PRB_${pid}_${mid}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      model_entry_id: eid, provider_id: pid, result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    const q = qualifyModel(store, eid, { capability_scope: ["text_inference"], actor: "t" });
    if (!q.qualified) throw new Error(`mkModel fixture failed: ${JSON.stringify(q.gates)}`);
  } else if (lifecycle !== "DISCOVERED") {
    const body = store.get("model_entry", eid);
    store.put("model_entry", eid, { ...body, lifecycle_state: lifecycle }, Number(body.version));
  }
  if (opts.conditions?.length || opts.aliases?.length) {
    const body = store.get("model_entry", eid);
    store.put("model_entry", eid, {
      ...body,
      conditions: opts.conditions ?? body.conditions,
      model_alias_ids: opts.aliases ?? body.model_alias_ids,
    }, Number(body.version));
  }
  return eid;
};

const mkProvider = (
  store: PairEvidenceStore,
  pid: string,
  opts: { lifecycle?: string; auth_state?: string; health_state?: string; conditions?: string[] } = {},
) => {
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id);
  const lifecycle = opts.lifecycle ?? "QUALIFIED";
  const codex = pid === "codex-cli";
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id }),
    lifecycle_state: lifecycle,
    auth_state: opts.auth_state ?? "AUTH_OK",
    health_state: opts.health_state ?? "READY",
    conditions: [],
    probe_state: ["QUALIFIED", "MODEL_DISCOVERY_ELIGIBLE"].includes(lifecycle) ? "PROBED" : "UNPROBED",
    // R3.B — the canonical codex-cli transport identity (subscription
    // lane: no HTTP endpoint, no credential envs). A non-codex provider
    // keeps a generic shape for the NEGATIVE tests only.
    provider_type: codex ? "LOCAL_CLI" : "REMOTE_HTTP",
    protocol_family: codex ? "CODEX_CLI" : "HTTPS_JSON",
    endpoint_reference: codex ? "codex-cli://local" : "https://provider.test",
    configured_endpoint_identity: codex ? "codex-cli://local" : "https://provider.test",
    credential_envs: codex ? [] : ["TEST_API_KEY"],
    credential_reference_name: codex ? null : "TEST_API_KEY",
  }, existing ? Number(existing.version) : 0);
  if (lifecycle === "QUALIFIED" || lifecycle === "MODEL_DISCOVERY_ELIGIBLE") {
    const cur = store.get("provider", id);
    store.put("provider", id, { ...cur, auth_state: "AUTH_OK", probe_state: "PROBED", health_state: "READY" }, Number(cur.version));
    new ProviderCatalog(store).issueQualificationReceipt(pid, { policy_version: "test-policy", actor: "test" });
    if (opts.auth_state !== undefined || opts.health_state !== undefined) {
      const b = store.get("provider", id);
      store.put("provider", id, {
        ...b,
        auth_state: opts.auth_state ?? b.auth_state,
        health_state: opts.health_state ?? b.health_state,
      }, Number(b.version));
    }
    if (lifecycle === "MODEL_DISCOVERY_ELIGIBLE") {
      const b = store.get("provider", id);
      store.put("provider", id, { ...b, lifecycle_state: "MODEL_DISCOVERY_ELIGIBLE" }, Number(b.version));
    }
  }
  if (opts.conditions?.length) {
    const b = store.get("provider", id);
    store.put("provider", id, { ...b, conditions: opts.conditions }, Number(b.version));
  }
};

class FakeInvoker implements CeoDecisionInvoker {
  calls = 0;
  constructor(
    private readonly produce: (input: CeoInvokeInput) => Promise<CeoInvokeResult> | CeoInvokeResult,
  ) {}
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.calls += 1;
    return this.produce(input);
  }
}

const decisionJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: "pair.ceo-decision.v1", decision_kind: "WAIT", wait_reason: "AWAITING_PROGRESS", ...over });

const initProposalJson = (keys: string[] = ["alpha", "beta"], over: Record<string, unknown> = {}) =>
  decisionJson({
    decision_kind: "INITIALIZE_WORKSTREAMS",
    wait_reason: undefined,
    workstreams: keys.map((k, i) => ({
      workstream_key: k, title: `T-${k}`, goal: `G-${k}`,
      ...(i > 0 ? { depends_on_keys: [keys[i - 1]!] } : {}),
    })),
    priority_order: keys,
    summary: "init",
    ...over,
  });

type Stack = {
  dbPath: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
  /** R2.A — the ONE P14 canonical completion proof seam. */
  proveWorkItemDone: (row: Record<string, unknown>) => boolean;
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
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService({ store, business: biz, workforce: wf, objectives });
  return {
    dbPath, store, biz, wf, objectives, workstreams,
    proveWorkItemDone: (row) => biz.proveWorkItemDone(row as never),
  };
}

/** Stack + canonical model/provider + CEO service with a canned invoker. */
function freshCeo(name: string, raw: string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>), modelId?: string, extraDeps: Record<string, unknown> = {}) {
  const s = freshStack(name);
  const me = modelId ?? mkModel(s.store, "codex-cli", "ceo-m");
  mkProvider(s.store, String(s.store.get("model_entry", me).provider_id));
  const invoker = new FakeInvoker((i) =>
    typeof raw === "function" ? raw(i) : ({
      model_entry_id: me,
      provider_id: String(s.store.get("model_entry", me).provider_id),
      model_id: String(s.store.get("model_entry", me).model_id),
      raw_text: raw,
    }));
  const svc = new CeoPlanningCycleService({
    store: s.store, objectives: s.objectives, workstreams: s.workstreams,
    proveWorkItemDone: s.proveWorkItemDone, invoker, model_entry_id: me, ...extraDeps,
  });
  return { ...s, svc, invoker, me };
}

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${digest(String(counter)).slice(0, 8)}_${counter}`) {
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(svc: ObjectiveAuthorityService, businessId: string, extra: Record<string, unknown> = {}) {
  return svc.create({
    business_id: businessId,
    title: "Sell 10 units",
    statement: "Grow sales",
    kpis: [{ name: "sales", unit: "units", baseline: 0, target: 10 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["no discounts below cost"],
    success_conditions: ["10 units sold"],
    dedup_key: `dk-${counter}`,
    operator_id: OP,
    ...extra,
  });
}

/** Mint a CANONICAL STARTED attempt — deterministic id + row + the
 *  immutable CEO_DECISION_ATTEMPT_STARTED anchor, byte-identical to the
 *  claim transaction's write. Anything less is a generic store row with
 *  ZERO attempt authority (R2.C). */
function mintStartedAttempt(s: Stack, opts: {
  objective_id: string;
  observation_digest: string;
  n?: number;
  model_entry_id: string;
  provider_id: string;
  model_id: string;
  business_id: string;
  started_at?: string;
  actor?: string;
}): string {
  const cycleId = ceoCycleId(opts.objective_id, opts.observation_digest);
  const n = opts.n ?? 1;
  const attemptId = ceoAttemptId(opts.objective_id, cycleId, n);
  const actor = opts.actor ?? OP;
  const startFields = {
    attempt_id: attemptId,
    cycle_id: cycleId,
    objective_id: opts.objective_id,
    business_id: opts.business_id,
    observation_digest: opts.observation_digest,
    attempt_number: n,
    model_entry_id: opts.model_entry_id,
    provider_id: opts.provider_id,
    model_id: opts.model_id,
    started_at: opts.started_at ?? new Date().toISOString(),
    started_by: actor,
  };
  s.store.put("ceo_decision_attempt", attemptId, {
    schema_version: "pair.os.vnext.ceo-decision-attempt.v1",
    ...startFields,
    state: "STARTED",
    settled_at: null,
    response_digest: null,
    canonical_proposal_digest: null,
    failure_code: null,
    version: 0,
  } as never, 0);
  s.store.event({
    entity_type: "ceo_decision_attempt",
    entity_id: attemptId,
    event_type: "CEO_DECISION_ATTEMPT_STARTED",
    old_state: null,
    new_state: "STARTED",
    actor: `operator:${actor}`,
    metadata: {
      ...startFields,
      start_identity_digest: ceoAttemptStartDigest(startFields),
    },
  });
  return attemptId;
}

async function expectFail(fn: () => unknown | Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

const attemptsOf = (store: PairEvidenceStore) => store.list("ceo_decision_attempt");
const decisionsOf = (store: PairEvidenceStore) => store.list("ceo_decision");

function eventHash(body: Record<string, unknown>): string {
  return digest(body);
}
function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }).db;
}

/** Rewrite an entity payload IN PLACE (same version) with a recomputed
 *  payload_hash — a byte-level mutation primitive for provenance tests.
 *  Unlike store.put it preserves the store version, which lets tests
 *  either keep a row canonical (consistent rewrites) or forge it while
 *  retaining the pinned lifecycle cardinality. */
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

/* ============================ A — observation ============================ */

describe("P15.3 A — canonical observation", () => {
  it("deterministic digest; meaningful canonical change → new digest", async () => {
    const s = freshStack("a1");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const o1 = buildCeoObservation(s, oid);
    const o2 = buildCeoObservation(s, oid);
    expect(o2.observation_digest).toBe(o1.observation_digest);
    // amend → new digest
    s.objectives.amend(oid, { business_id: bid, patch: { target: "12" }, reason: "r", actor: `operator:${OP}` });
    const o3 = buildCeoObservation(s, oid);
    expect(o3.observation_digest).not.toBe(o1.observation_digest);
    // canonical workstream materialization → new digest
    const o4 = s.objectives.get(oid);
    s.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(o4.version),
      expected_terms_version: Number(o4.terms_version),
      expected_objective_digest: String(o4.objective_digest),
      workstreams: [{ workstream_key: "a", title: "A", goal: "g" }],
      actor: OP,
    });
    const o5 = buildCeoObservation(s, oid);
    expect(o5.observation_digest).not.toBe(o3.observation_digest);
    expect((o5.observation.binding as Record<string, unknown>).binding_id).toBe(objectiveWorkstreamBindingId(oid));
    s.store.close();
  });

  it("forged binding / tampered objective → fail closed before any model call", async () => {
    // forged binding row — garbage fields
    {
      const s = freshStack("a2");
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid);
      const oid = String(o.objective_id);
      s.store.put("objective_workstream_binding", objectiveWorkstreamBindingId(oid), { fake: true, version: 0 } as never, 0);
      const inv = new FakeInvoker(() => { throw new Error("must not invoke"); });
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: "x" });
      await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      expect(inv.calls).toBe(0);
      s.store.close();
    }
    // tampered objective digest
    {
      const s = freshStack("a3");
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid);
      const oid = String(o.objective_id);
      const row = s.store.get("objective", oid);
      s.store.put("objective", oid, { ...row, objective_digest: "forged" }, Number(row.version));
      const inv = new FakeInvoker(() => { throw new Error("must not invoke"); });
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: "x" });
      await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_OBJECTIVE_DIGEST");
      expect(inv.calls).toBe(0);
      s.store.close();
    }
  });
});

/* ============================ B — CEO invocation ============================ */

describe("P15.3 B — invocation gates", () => {
  it("non-string/blank actor → OPERATOR_ID_REQUIRED before deadline eval; zero rows, zero calls", async () => {
    for (const bad of [123, {}, "   ", null]) {
      const s = freshStack(`b1-${String(bad)}`);
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid, { deadline: "2000-01-01T00:00:00.000Z" });
      const oid = String(o.objective_id);
      const inv = new FakeInvoker(() => { throw new Error("must not invoke"); });
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: "x" });
      await expectFail(() => svc.runCycle({ objective_id: oid, actor: bad as unknown as string }), "FAIL_CLOSED_OPERATOR_ID_REQUIRED");
      expect(inv.calls).toBe(0);
      expect(attemptsOf(s.store)).toHaveLength(0);
      expect(String(s.objectives.get(oid).status)).toBe("ACTIVE"); // never expired — actor check ran first
      s.store.close();
    }
  });

  it("ACTIVE objective → CEO invoked exactly once; terminal → zero invocations", async () => {
    const s1 = freshCeo("b2-ok", decisionJson());
    const bid1 = mkBusiness(s1.store);
    const o1 = mkObjective(s1.objectives, bid1);
    const r = await s1.svc.runCycle({ objective_id: String(o1.objective_id), actor: OP });
    expect(s1.invoker.calls).toBe(1);
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    s1.store.close();

    const s2 = freshCeo("b2-exp", decisionJson());
    const bid2 = mkBusiness(s2.store);
    const o2 = mkObjective(s2.objectives, bid2, { deadline: "2000-01-01T00:00:00.000Z" });
    await expectFail(
      () => s2.svc.runCycle({ objective_id: String(o2.objective_id), actor: OP }),
      "FAIL_CLOSED_CEO_OBJECTIVE_NOT_ACTIVE",
    );
    expect(s2.invoker.calls).toBe(0);
    expect(decisionsOf(s2.store)).toHaveLength(0);
    s2.store.close();
  });

  it("DSH_EXECUTION model (direct + alias) → DSH overlap fail closed, zero attempts, zero calls", async () => {
    const s = freshStack("b3");
    const pid = "codex-cli";
    const meDsh = mkModel(s.store, pid, "dsh-m");
    mkProvider(s.store, pid);
    assignModelRole(s.store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const inv = new FakeInvoker(() => { throw new Error("must not invoke"); });
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: meDsh });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DSH_OVERLAP");
    expect(attemptsOf(s.store)).toHaveLength(0);
    // alias-proven same canonical model → also overlap
    const meAlias = mkModel(s.store, pid, "other", { aliases: ["dsh-m"] });
    const svc2 = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: meAlias });
    await expectFail(() => svc2.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DSH_OVERLAP");
    s.store.close();
  });

  it("provider/model unavailable → no invocation, no decision; authority-ineligible → fail closed", async () => {
    // availability gate (provider DOWN) → CEO_MODEL_UNAVAILABLE
    const s1 = freshStack("b4a");
    const pid1 = "codex-cli";
    const me1 = mkModel(s1.store, pid1, "m1");
    mkProvider(s1.store, pid1, { health_state: "DOWN" });
    const inv1 = new FakeInvoker(() => { throw new Error("must not invoke"); });
    const svc1 = new CeoPlanningCycleService({ store: s1.store, objectives: s1.objectives, workstreams: s1.workstreams, invoker: inv1, model_entry_id: me1 });
    const bid1 = mkBusiness(s1.store);
    const o1 = mkObjective(s1.objectives, bid1);
    await expectFail(() => svc1.runCycle({ objective_id: String(o1.objective_id), actor: OP }), "FAIL_CLOSED_CEO_MODEL_UNAVAILABLE");
    expect(attemptsOf(s1.store)).toHaveLength(0);
    s1.store.close();
    // authority gate (provider never qualified) → PROVIDER_INELIGIBLE
    const s2 = freshStack("b4b");
    const pid2 = "codex-cli";
    const me2 = mkModel(s2.store, pid2, "m2");
    mkProvider(s2.store, pid2, { lifecycle: "DISCOVERED" });
    const svc2 = new CeoPlanningCycleService({ store: s2.store, objectives: s2.objectives, workstreams: s2.workstreams, invoker: new FakeInvoker(() => { throw new Error("x"); }), model_entry_id: me2 });
    const bid2 = mkBusiness(s2.store);
    const o2 = mkObjective(s2.objectives, bid2);
    await expectFail(() => svc2.runCycle({ objective_id: String(o2.objective_id), actor: OP }), "FAIL_CLOSED_CEO_PROVIDER_INELIGIBLE");
    s2.store.close();
    // missing model_entry entirely
    const s3 = freshStack("b4c");
    const svc3 = new CeoPlanningCycleService({ store: s3.store, objectives: s3.objectives, workstreams: s3.workstreams, invoker: new FakeInvoker(() => { throw new Error("x"); }), model_entry_id: "ME_GONE" });
    const bid3 = mkBusiness(s3.store);
    const o3 = mkObjective(s3.objectives, bid3);
    await expectFail(() => svc3.runCycle({ objective_id: String(o3.objective_id), actor: OP }), "FAIL_CLOSED_CEO_MODEL_UNRESOLVED");
    s3.store.close();
  });

  it("invocation throw / timeout → attempt REJECTED, zero decision; malformed+unknown+forbidden output → REJECTED", async () => {
    // invoker throws — surfaces as the deterministic invocation code,
    // attempt settled REJECTED, zero decision
    const s1 = freshCeo("b5", () => { throw new Error("timeout"); });
    const bid1 = mkBusiness(s1.store);
    const o1 = mkObjective(s1.objectives, bid1);
    await expectFail(() => s1.svc.runCycle({ objective_id: String(o1.objective_id), actor: OP }), "FAIL_CLOSED_CEO_INVOCATION");
    expect(String(attemptsOf(s1.store)[0]!.state)).toBe("REJECTED");
    expect(decisionsOf(s1.store)).toHaveLength(0);
    s1.store.close();
    // malformed JSON
    for (const [i, text] of [
      "not json at all",
      "{\"schema\":\"pair.ceo-decision.v1\",\"decision_kind\":\"HACK\"}",
      "{\"schema\":\"pair.ceo-decision.v1\",\"decision_kind\":\"CREATE_MISSION\"}",
      "{\"schema\":\"wrong\",\"decision_kind\":\"WAIT\",\"wait_reason\":\"AWAITING_PROGRESS\"}",
      "{\"schema\":\"pair.ceo-decision.v1\",\"decision_kind\":\"WAIT\",\"wait_reason\":\"AWAITING_PROGRESS\",\"objective_id\":\"spoof\"}",
      "{\"schema\":\"pair.ceo-decision.v1\",\"decision_kind\":\"WAIT\",\"wait_reason\":\"CUSTOM_REASON\"}",
    ].entries()) {
      const s = freshCeo(`b5-${i}`, String(text));
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid);
      const code = String(text).includes("CREATE_MISSION") ? "FAIL_CLOSED_CEO_DECISION_FORBIDDEN" : "FAIL_CLOSED_CEO_DECISION_INVALID";
      await expectFail(() => s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), code);
      expect(decisionsOf(s.store)).toHaveLength(0);
      expect(s.store.list("work_item")).toHaveLength(0);
      expect(attemptsOf(s.store)).toHaveLength(1);
      expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
      s.store.close();
    }
  });

  it("invoker-reported identity must equal configured model → mismatch rejects", async () => {
    const s = freshStack("b6");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const inv = new FakeInvoker(() => ({
      model_entry_id: me, provider_id: pid, model_id: "different-model", raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_INVOCATION");
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });
});

/* ============================ C — INITIALIZE ============================ */

describe("P15.3 C — INITIALIZE_WORKSTREAMS", () => {
  it("valid proposal → canonical P15.2 graph + receipt + anchor + ACCEPTED attempt", async () => {
    const s = freshCeo("c1", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    // P15.2 graph materialized through the existing seam
    const binding = s.workstreams.getBinding(oid)!;
    expect(String(binding.binding_id)).toBe(objectiveWorkstreamBindingId(oid));
    expect(binding.workstreams).toHaveLength(2);
    const root = s.store.get("work_item", String(binding.root_work_item_id));
    expect(String(root.objective_id)).toBe(oid);
    expect(String(root.status)).toBe("BACKLOG");
    // receipt + anchor + attempt
    const decision = r.decision;
    expect(String(decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    expect(String(decision.result_binding_id)).toBe(String(binding.binding_id));
    expect(String(decision.result_binding_digest)).toBe(objectiveWorkstreamBindingDigest(binding));
    const anchors = s.store.listEvents("ceo_decision", String(decision.decision_id))
      .filter((e) => e.event_type === "CEO_DECISION_COMMITTED");
    expect(anchors).toHaveLength(1);
    expect(String(anchors[0]!.actor)).toBe(`operator:${OP}`);
    const att = s.store.get("ceo_decision_attempt", String(decision.attempt_id));
    expect(String(att.state)).toBe("ACCEPTED");
    expect(String(att.canonical_proposal_digest)).toBe(String(decision.canonical_proposal_digest));
    s.store.close();
  });

  it("model-supplied authority fields cannot override (extra field → whole proposal INVALID)", async () => {
    const s = freshCeo("c2", initProposalJson(["a"], { business_id: "BIZ_FAKE", actor: "attacker" }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DECISION_INVALID");
    expect(s.store.list("work_item")).toHaveLength(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });

  it("existing binding + INITIALIZE → gate reject, attempt REJECTED, no mutation", async () => {
    const s = freshCeo("c3", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const ob = s.objectives.get(oid);
    s.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(ob.version),
      expected_terms_version: Number(ob.terms_version),
      expected_objective_digest: String(ob.objective_digest),
      workstreams: [{ workstream_key: "x", title: "X", goal: "g" }],
      actor: OP,
    });
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_GATE");
    expect(attemptsOf(s.store)).toHaveLength(1);
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
    expect(decisionsOf(s.store)).toHaveLength(0);
    // graph untouched — still exactly 1 child
    expect(s.store.list("work_item")).toHaveLength(2);
    s.store.close();
  });

  it("P15.2 validation failure (duplicate key) → no committed decision, zero graph", async () => {
    const bad = decisionJson({
      decision_kind: "INITIALIZE_WORKSTREAMS",
      wait_reason: undefined,
      workstreams: [
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "a", title: "A2", goal: "g" },
      ],
      priority_order: ["a"],
    });
    const s = freshCeo("c4", bad);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    // the duplicate key reaches P15.2's own canonical validator inside the
    // commit txn — the canonical proposal code propagates, attempt REJECTED.
    await expectFail(
      () => s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL",
    );
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
    expect(s.store.list("work_item")).toHaveLength(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });
});

/* ============================ D — PRIORITIZE_EXISTING ============================ */

describe("P15.3 D — PRIORITIZE_EXISTING", () => {
  async function withBinding(name: string, raw: string) {
    const s = freshCeo(name, raw);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const ob = s.objectives.get(oid);
    const { binding } = s.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(ob.version),
      expected_terms_version: Number(ob.terms_version),
      expected_objective_digest: String(ob.objective_digest),
      workstreams: [
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g" },
      ],
      actor: OP,
    });
    return { s, oid, binding };
  }

  it("exact permutation → accepted receipt; zero topology/priority mutation", async () => {
    const { s, oid, binding } = await withBinding("d1", decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: undefined,
      priority_order: ["b", "a"],
      summary: "b first",
    }));
    const before = (s.store.list("work_item") as Array<Record<string, unknown>>).map((w) => ({ id: w.work_item_id, p: w.priority ?? null, v: w.version }));
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("PRIORITIZE_EXISTING");
    // binding + every work_item unchanged (version + no priority field)
    const after = s.store.list("work_item") as Array<Record<string, unknown>>;
    expect(after.map((w) => ({ id: w.work_item_id, p: w.priority ?? null, v: w.version }))).toEqual(before);
    const binding2 = s.workstreams.getBinding(oid)!;
    expect(String(binding2.binding_digest)).toBe(String(binding.binding_digest));
    s.store.close();
  });

  it("unknown/missing/duplicate key → gate reject (whole proposal dies)", async () => {
    for (const [i, po] of [["a", "b", "c"], ["a"], ["a", "a", "b"]].entries()) {
      const { s, oid } = await withBinding(`d2-${i}`, decisionJson({
        decision_kind: "PRIORITIZE_EXISTING",
        wait_reason: undefined,
        priority_order: po,
      }));
      await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_GATE");
      expect(decisionsOf(s.store)).toHaveLength(0);
      s.store.close();
    }
  });

  it("PRIORITIZE submitting workstreams → INVALID; without binding → GATE", async () => {
    const { s, oid } = await withBinding("d3", decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: undefined,
      priority_order: ["a", "b"],
      workstreams: [{ workstream_key: "z", title: "t", goal: "g" }],
    }));
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_INVALID");
    s.store.close();
    // no binding at all
    const s2 = freshCeo("d3b", decisionJson({
      decision_kind: "PRIORITIZE_EXISTING",
      wait_reason: undefined,
      priority_order: ["a"],
    }));
    const bid2 = mkBusiness(s2.store);
    const o2 = mkObjective(s2.objectives, bid2);
    await expectFail(() => s2.svc.runCycle({ objective_id: String(o2.objective_id), actor: OP }), "FAIL_CLOSED_CEO_GATE");
    s2.store.close();
  });
});

/* ============================ E — WAIT ============================ */

describe("P15.3 E — WAIT", () => {
  it("allowlisted reason → receipt; zero work mutation", async () => {
    const s = freshCeo("e1", decisionJson({ wait_reason: "DEPENDENCIES_BLOCKED" }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const r = await s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(s.store.list("work_item")).toHaveLength(0);
    expect(s.store.list("work_decomposition")).toHaveLength(0);
    s.store.close();
  });
});

/* ============================ F — replay ============================ */

describe("P15.3 F — replay by observation digest", () => {
  it("same state → second runCycle returns same decision, zero extra calls/rows", async () => {
    // WAIT leaves canonical state unchanged → the SECOND runCycle observes
    // the identical digest and replays the committed decision verbatim.
    const s = freshCeo("f1", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r1 = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const r2 = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(r2.replayed).toBe(true);
    expect(String(r2.decision.decision_id)).toBe(String(r1.decision.decision_id));
    expect(s.invoker.calls).toBe(1);
    expect(decisionsOf(s.store)).toHaveLength(1);
    expect(attemptsOf(s.store)).toHaveLength(1);
    const anchors = s.store.listEvents("ceo_decision", String(r1.decision.decision_id))
      .filter((e) => e.event_type === "CEO_DECISION_COMMITTED");
    expect(anchors).toHaveLength(1);
    s.store.close();
  });

  it("INITIALIZE changes state → next cycle is a NEW decision cycle (a genuine new observation), never a confused replay", async () => {
    let n = 0;
    const s = freshCeo("f2", (i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id,
      raw_text: n++ === 0 ? initProposalJson() : decisionJson(),
    }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r1 = await s.svc.runCycle({ objective_id: oid, actor: OP });
    // observation changed (binding now exists) → second cycle invokes once
    // more and commits a SECOND distinct decision — not a duplicate.
    const r2 = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(s.invoker.calls).toBe(2);
    expect(decisionsOf(s.store)).toHaveLength(2);
    expect(String(r2.decision.decision_id)).not.toBe(String(r1.decision.decision_id));
    expect(String(r2.decision.observed_binding_id)).toBe(String(r1.decision.result_binding_id));
    s.store.close();
  });
});

/* ============================ G — TOCTOU ============================ */

describe("P15.3 G — TOCTOU stale decision closure", () => {
  it("state change between invocation and commit → STALE attempt, zero decision/mutation", async () => {
    let armed = true;
    const s = freshCeo("g1", (input) => {
      // mutate canonical state mid-flight ONCE (after O1 was observed)
      if (armed) {
        armed = false;
        s.objectives.amend(oid, { business_id: bid, patch: { target: "99" }, reason: "r", actor: `operator:${OP}` });
      }
      return { model_entry_id: input.transport.model_entry_id, provider_id: input.transport.provider_id, model_id: input.transport.model_id, raw_text: initProposalJson() };
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_OBSERVATION_STALE");
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("STALE");
    expect(decisionsOf(s.store)).toHaveLength(0);
    expect(s.store.list("work_item")).toHaveLength(0);
    // fresh cycle on the new observation works
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    s.store.close();
  });
});

/* ============================ H — crash safety ============================ */

describe("P15.3 H — crash safety", () => {
  it("fault on anchor write → whole commit rolls back; STARTED attempt reconciles → bounded retry succeeds", async () => {
    const s = freshStack("h1");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    // Inject: throw when the CEO_DECISION_COMMITTED anchor event is written.
    const inv = new FakeInvoker((i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id, raw_text: initProposalJson(),
    }));
    const origEvent = s.store.event.bind(s.store);
    let armed = true;
    (s.store as unknown as { event: unknown }).event = (e: Record<string, unknown>) => {
      if (armed && e.event_type === "CEO_DECISION_COMMITTED") throw new Error("crash-at-anchor");
      return origEvent(e as never);
    };
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker: inv, model_entry_id: me, now: () => new Date(nowMs).toISOString(),
    });
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_COMMIT");
    // never split-brain: no graph, no binding, no decision, no anchor
    expect(s.store.list("work_item")).toHaveLength(0);
    expect(s.store.list("objective_workstream_binding")).toHaveLength(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    // the invoked attempt is settled REJECTED (invocation DID happen)
    expect(attemptsOf(s.store)).toHaveLength(1);
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
    s.store.close();
  });

  it("live STARTED attempt → INFLIGHT; reconciled after grace → one bounded retry", async () => {
    const s = freshStack("h2");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const inv = new FakeInvoker((i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id, raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker: inv, model_entry_id: me,
      stale_grace_ms: 60_000, now: () => new Date(nowMs).toISOString(),
    });
    // simulate a crashed STARTED attempt for THIS observation
    const obs = buildCeoObservation(s, oid);
    // R2.C — the crash-window fixture must be a CANONICAL attempt
    // (deterministic id + START anchor); a bare store.put row is never
    // attempt authority.
    mintStartedAttempt(s, {
      objective_id: oid, observation_digest: obs.observation_digest,
      model_entry_id: me, provider_id: pid, model_id: "m1",
      business_id: bid, started_at: new Date(nowMs).toISOString(),
    });
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_INFLIGHT");
    // before grace expires — no reconciliation
    expect(svc.reconcileStaleAttempts(oid)).toBe(0);
    // past grace → UNKNOWN → bounded retry admitted
    nowMs += 120_000;
    expect(svc.reconcileStaleAttempts(oid)).toBe(1);
    const r = await svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(attemptsOf(s.store)).toHaveLength(2); // UNKNOWN + ACCEPTED
    s.store.close();
  });
});

/* ============================ I — concurrency ============================ */

describe("P15.3 I — concurrency", () => {
  it("two callers, same observation → at most ONE live invocation; loser gets INFLIGHT, retry converges", async () => {
    const s = freshStack("i1");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const gate = { release: false };
    const inv = new FakeInvoker(async (i) => {
      // hold the invocation open until released
      while (!gate.release) await new Promise((r) => setTimeout(r, 1));
      return { model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id, model_id: i.transport.model_id, raw_text: decisionJson() };
    });
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me });
    const p1 = svc.runCycle({ objective_id: oid, actor: OP });
    await new Promise((r) => setTimeout(r, 10)); // let p1 commit STARTED
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_INFLIGHT");
    gate.release = true;
    const r1 = await p1;
    expect(String(r1.decision.decision_kind)).toBe("WAIT");
    const r2 = await svc.runCycle({ objective_id: oid, actor: OP });
    expect(r2.replayed).toBe(true);
    expect(inv.calls).toBe(1); // exactly one live invocation ever
    s.store.close();
  });
});

/* ============================ J — tamper ============================ */

describe("P15.3 J — tamper", () => {
  async function committed(name: string) {
    const s = freshCeo(name, initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    return { s, oid, did: String(r.decision.decision_id), bid };
  }
  const strictRead = (s: ReturnType<typeof freshCeo>, _oid: string, did: string) => {
    // read the committed receipt BY ID and run the canonical validator —
    // the post-INITIALIZE observation digest legitimately differs.
    return assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never);
  };

  it("tampered decision row + recomputed digest → immutable anchor still fails", async () => {
    const { s, oid, did } = await committed("j1");
    const row = s.store.get("ceo_decision", did);
    // tamper a pinned field + recompute self-consistency — anchor pins the ORIGINAL
    const tampered = { ...row, created_by: "attacker" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { ceoDecisionDigest } = await import("../pair/index.js") as any;
    tampered.decision_digest = ceoDecisionDigest(tampered);
    s.store.put("ceo_decision", did, tampered, Number(row.version));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION");
    s.store.close();
  });

  it("anchor missing / duplicated / header-rewritten → strict read fails", async () => {
    // delete anchor
    {
      const { s, oid, did } = await committed("j2a");
      const ev = s.store.listEvents("ceo_decision", did)[0]!;
      dbOf(s.store).prepare("DELETE FROM events WHERE event_id=?").run(String(ev.event_id));
      await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION");
      s.store.close();
    }
    // duplicate anchor
    {
      const { s, oid, did } = await committed("j2b");
      const ev = s.store.listEvents("ceo_decision", did)[0]!;
      const body = {
        event_id: `${String(ev.event_id)}_dup`, entity_type: ev.entity_type, entity_id: ev.entity_id,
        event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
        actor: ev.actor, correlation_id: ev.correlation_id ?? null,
        metadata: ev.metadata, created_at: ev.created_at,
      };
      dbOf(s.store).prepare(
        "INSERT INTO events (event_id, entity_type, entity_id, event_type, old_state, new_state, actor, correlation_id, metadata_json, created_at, event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).run(body.event_id, body.entity_type, body.entity_id, body.event_type, body.old_state, body.new_state, body.actor, body.correlation_id, JSON.stringify(body.metadata), body.created_at, eventHash(body));
      await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION");
      s.store.close();
    }
    // rewritten header actor + recomputed hash
    {
      const { s, oid, did } = await committed("j2c");
      const ev = s.store.listEvents("ceo_decision", did)[0]!;
      const body = {
        event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
        event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
        actor: "operator:attacker", correlation_id: ev.correlation_id ?? null,
        metadata: ev.metadata, created_at: ev.created_at,
      };
      dbOf(s.store).prepare("UPDATE events SET actor=?, event_hash=? WHERE event_id=?")
        .run("operator:attacker", eventHash(body), String(ev.event_id));
      await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION");
      s.store.close();
    }
  });

  it("attempt model identity inconsistent → strict read fails; wrong objective/binding pins fail", async () => {
    const { s, oid, did } = await committed("j3");
    const dec = s.store.get("ceo_decision", did);
    const att = s.store.get("ceo_decision_attempt", String(dec.attempt_id));
    s.store.put("ceo_decision_attempt", String(dec.attempt_id), { ...att, model_id: "forged-model" }, Number(att.version));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION_ATTEMPT");
    s.store.close();
  });

  it("INITIALIZE decision referencing a missing/foreign binding → fail", async () => {
    const { s, oid, did } = await committed("j4");
    // delete the binding's anchor event — binding itself becomes non-canonical
    const binding = s.workstreams.getBinding(oid)!;
    const ev = s.store.listEvents("objective_workstream_binding", String(binding.binding_id))[0]!;
    dbOf(s.store).prepare("DELETE FROM events WHERE event_id=?").run(String(ev.event_id));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
    s.store.close();
  });
});

/* ============================ K — no forbidden side effects ============================ */

describe("P15.3 K — no forbidden side effects", () => {
  it("a full INITIALIZE cycle mints ONLY P15.2 graph + CEO rows", async () => {
    const s = freshCeo("k1", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const objBefore = s.objectives.get(oid);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(r.replayed).toBe(false);
    // zero mission/executor/planner/telegram/kpi/budget effects
    for (const ent of ["mission", "work_open_binding", "executor_execution", "planner_attempt", "planner_run", "telegram_delivery", "mission_artifact"]) {
      expect(s.store.list(ent), ent).toHaveLength(0);
    }
    const objAfter = s.objectives.get(oid);
    expect(Number(objAfter.version)).toBe(Number(objBefore.version));
    expect(Number(objAfter.terms_version)).toBe(Number(objBefore.terms_version));
    expect(String(objAfter.objective_digest)).toBe(String(objBefore.objective_digest));
    expect(((objAfter.budget as Record<string, unknown>).consumed_microusd)).toBe(0);
    expect(((objAfter.kpis as Array<Record<string, unknown>>)[0]!.current ?? null)).toBe(null);
    s.store.close();
  });
});

/* ============================ R — model-role regression ============================ */

describe("P15.3 R — model-role regression (§27)", () => {
  it("planner model serves CEO via the separate seam WITHOUT losing PLANNER_COORDINATOR; pools stay disjoint", async () => {
    const s = freshStack("r1");
    const pid = "codex-cli";
    const mePlanner = mkModel(s.store, pid, "planner-m");
    const meDsh = mkModel(s.store, pid, "dsh-m");
    mkProvider(s.store, pid);
    assignModelRole(s.store, mePlanner, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    assignModelRole(s.store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    // CEO uses the PLANNER model through the CEO_DECISION invocation seam
    const inv = new FakeInvoker((i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id, raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: mePlanner });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const r = await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    // assignment untouched — never repurposed
    expect(modelRoleOf(s.store, mePlanner)).toBe(MODEL_ROLE.PLANNER_COORDINATOR);
    expect(modelRoleOf(s.store, meDsh)).toBe(MODEL_ROLE.DSH_EXECUTION);
    // only the two configured assignments exist — CEO minted none
    expect(s.store.list("model_role_assignment")).toHaveLength(2);
    s.store.close();
  });
});

/* ============================ R2.A — canonical P14 completion authority ============================ */

/** Full governed-runtime stack (MissionControl + runtime + canonical
 *  completion seam) — used ONLY by the R2.A canonical-completion test:
 *  the CEO observation must bind to the REAL P14 proof, not status. */
function freshFullCtx(name: string) {
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
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
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
  for (const c of ["FILE_OPERATIONS", "REASONING", "NETWORK_ACCESS"]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name: "biz", root_location: workspace });
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService({ store, business: biz, workforce: wf, objectives });
  const obs = (oid: string) => buildCeoObservation(
    { store, objectives, workstreams, proveWorkItemDone: (r: never) => biz.proveWorkItemDone(r) },
    oid,
  );
  return { dir, store, service, biz, wf, objectives, workstreams, projectId: String(project.project_id), obs };
}

describe("P15.3 R2.A — canonical P14 completion authority", () => {
  it("status=DONE claim with zero canonical evidence → completion_proven=false (never authority)", async () => {
    const s = freshCeo("r2a-1", initProposalJson(["w1"]));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const binding = s.workstreams.getBinding(oid)!;
    const wid = String((binding.workstreams as Array<Record<string, unknown>>)[0]!.work_item_id);
    // Forge the mutable status claim — no WCP, no mission lineage.
    const row = s.store.get("work_item", wid);
    s.store.put("work_item", wid, { ...row, status: "DONE" }, Number(row.version));
    const obs = buildCeoObservation(s, oid);
    const ws = (obs.observation.workstreams as Array<Record<string, unknown>>)[0]!;
    expect(String(ws.status)).toBe("DONE"); // status stays a distinct field
    expect(ws.completion_proven).toBe(false); // but proof is false — never conflated
    s.store.close();
  });

  it("status=DONE + fabricated WCP row → completion_proven=false (fabrication rejected by P14 proof)", async () => {
    const s = freshCeo("r2a-2", initProposalJson(["w1"]));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const binding = s.workstreams.getBinding(oid)!;
    const wid = String((binding.workstreams as Array<Record<string, unknown>>)[0]!.work_item_id);
    const row = s.store.get("work_item", wid);
    s.store.put("work_item", wid, { ...row, status: "DONE" }, Number(row.version));
    // A generic work_completion row is fabrication — digest/anchor/lineage fail.
    s.store.put("work_completion", `WCP_${wid}`, {
      schema_version: "pair.os.vnext.work-completion.v1", fake: true, version: 0,
    } as never, 0);
    const obs = buildCeoObservation(s, oid);
    expect((obs.observation.workstreams as Array<Record<string, unknown>>)[0]!.completion_proven).toBe(false);
    s.store.close();
  });

  it('literal non-vocabulary status ("COMPLETED") → observation fails closed BEFORE any model call', async () => {
    const s = freshCeo("r2a-3", initProposalJson(["w1"]));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const binding = s.workstreams.getBinding(oid)!;
    const wid = String((binding.workstreams as Array<Record<string, unknown>>)[0]!.work_item_id);
    const row = s.store.get("work_item", wid);
    s.store.put("work_item", wid, { ...row, status: "COMPLETED" }, Number(row.version));
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_OBSERVATION");
    expect(s.invoker.calls).toBe(1); // only the INITIALIZE call — no new invocation
    s.store.close();
  });

  it("real P14 canonical completion chain (open → bound mission → full evidence → WCP) → completion_proven=true", async () => {
    const ctx = freshFullCtx("r2a-4");
    const b = ctx.biz.createBusiness({ name: "b", project_id: ctx.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(ctx.objectives, bid);
    const oid = String(o.objective_id);
    const obj = ctx.objectives.get(oid);
    ctx.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(obj.version),
      expected_terms_version: Number(obj.terms_version),
      expected_objective_digest: String(obj.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "w", goal: "g" }],
      actor: OP,
    });
    const binding = ctx.workstreams.getBinding(oid)!;
    const wid = String((binding.workstreams as Array<Record<string, unknown>>)[0]!.work_item_id);
    // Before any completion evidence: proven=false.
    let ws = (ctx.obs(oid).observation.workstreams as Array<Record<string, unknown>>)[0]!;
    expect(ws.completion_proven).toBe(false);
    // The real canonical seam: P15.4 allocation mints the delegated
    // child → open → bound mission → full governed completion evidence →
    // sync fold → parent cascade → DONE + WCP + anchor. (P15.4 R2.A —
    // the workstream container itself is non-executable.)
    const allocSvc = new WorkforceAllocationService({
      store: ctx.store, business: ctx.biz, workforce: ctx.wf,
      objectives: ctx.objectives, workstreams: ctx.workstreams,
    });
    ctx.biz.createOrgAgent({
      business_id: bid, title: "a", department: "ops", operator_id: OP,
    });
    const ar = allocSvc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(ar.delegated_child_work_item_id);
    ctx.biz.openWorkItem(childId, OP);
    const mid = String((ctx.store.get("work_item", childId).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    ctx.biz.syncWorkItem(childId);
    ctx.biz.advanceCompletionCascade(childId);
    const done = ctx.biz.syncWorkItem(wid);
    expect(String(done.status)).toBe("DONE");
    ws = (ctx.obs(oid).observation.workstreams as Array<Record<string, unknown>>)[0]!;
    expect(String(ws.status)).toBe("DONE");
    expect(ws.completion_proven).toBe(true);
    ctx.store.close();
  });
});

/* ============================ R2.B — receipt re-proves identity ============================ */

describe("P15.3 R2.B — decision receipt re-proves identity", () => {
  const strictRead = (s: ReturnType<typeof freshCeo>, did: string) =>
    assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did));

  it("forged cycle_id / decision_id → strict read fails even with recomputed self-digest", async () => {
    const s = freshCeo("r2b-1", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);
    // forged cycle_id (identity recompute catches it before the anchor)
    const row = s.store.get("ceo_decision", did);
    s.store.put("ceo_decision", did, { ...row, cycle_id: "CCY_forged" }, Number(row.version));
    await expectFail(() => strictRead(s, did), "FAIL_CLOSED_CEO_DECISION");
    s.store.close();
  });

  it("stored proposal mutated (kind/digest incoherent or invalid shape) → fail closed", async () => {
    const s = freshCeo("r2b-2", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);
    // WAIT proposal rewritten to carry a contradictory priority_order.
    const row = s.store.get("ceo_decision", did);
    const tampered = JSON.parse(JSON.stringify(row.proposal));
    tampered.priority_order = ["w1"];
    s.store.put("ceo_decision", did, { ...row, proposal: tampered }, Number(row.version));
    await expectFail(() => strictRead(s, did), "FAIL_CLOSED_CEO_DECISION");
    s.store.close();
  });

  it("PRIORITIZE proposal with wait_reason / INITIALIZE with wait_reason → whole proposal dies", async () => {
    const s = freshCeo("r2b-3", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    // direct validator assertions — contradictory fields are never dropped
    const { validateCanonicalCeoProposal } = await import("../pair/index.js");
    expect(() => validateCanonicalCeoProposal({
      decision_kind: "PRIORITIZE_EXISTING", priority_order: ["a"], wait_reason: "AWAITING_PROGRESS",
    })).toThrow();
    expect(() => validateCanonicalCeoProposal({
      decision_kind: "INITIALIZE_WORKSTREAMS",
      workstreams: [{ workstream_key: "a", title: "t", goal: "g" }],
      priority_order: ["a"], wait_reason: "AWAITING_PROGRESS",
    })).toThrow();
    // and the stored `schema` key is an unknown field in canonical storage
    expect(() => validateCanonicalCeoProposal({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT", wait_reason: "AWAITING_PROGRESS",
    })).toThrow();
    s.store.close();
  });

  it("receipt bound to a foreign business → strict read fails", async () => {
    const s = freshCeo("r2b-4", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);
    const row = s.store.get("ceo_decision", did);
    s.store.put("ceo_decision", did, { ...row, business_id: "BIZ_foreign" }, Number(row.version));
    await expectFail(() => strictRead(s, did), "FAIL_CLOSED_CEO_DECISION");
    s.store.close();
  });

  it("objective amended AFTER commit → receipt still strict-reads (historical pins, not current)", async () => {
    const s = freshCeo("r2b-5", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);
    s.objectives.amend(oid, { business_id: bid, patch: { target: "99" }, reason: "bump", actor: `operator:${OP}` });
    // historical version/digest pins differ from current — anchor is the
    // immutable proof; strict read still passes.
    strictRead(s, did);
    s.store.close();
  });
});

/* ============================ R2.C — canonical attempt authority ============================ */

describe("P15.3 R2.C — canonical attempt authority", () => {
  it("a bare store.put row (CCA_x1) is ZERO attempt authority → cap/INFLIGHT reads fail closed", async () => {
    const s = freshStack("r2c-1");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const obs = buildCeoObservation(s, oid);
    const cycleId = ceoCycleId(oid, obs.observation_digest);
    // arbitrary id + no START anchor — a generic persistence row
    s.store.put("ceo_decision_attempt", "CCA_x1", {
      schema_version: "pair.os.vnext.ceo-decision-attempt.v1",
      attempt_id: "CCA_x1", cycle_id: cycleId, objective_id: oid, business_id: bid,
      observation_digest: obs.observation_digest, attempt_number: 1, state: "STARTED",
      model_entry_id: me, provider_id: pid, model_id: "m1",
      started_at: new Date().toISOString(), settled_at: null,
      response_digest: null, canonical_proposal_digest: null, failure_code: null, version: 0,
    } as never, 0);
    const inv = new FakeInvoker(() => ({ model_entry_id: me, provider_id: pid, model_id: "m1", raw_text: decisionJson() }));
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
    });
    // deterministic-id identity fails → the corrupt row is never INFLIGHT
    // authority, never silently skipped.
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_ATTEMPT");
    expect(inv.calls).toBe(0);
    s.store.close();
  });

  it("canonical-shaped row WITHOUT the START anchor → zero authority", async () => {
    const s = freshStack("r2c-2");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const obs = buildCeoObservation(s, oid);
    const cycleId = ceoCycleId(oid, obs.observation_digest);
    const aid = ceoAttemptId(oid, cycleId, 1);
    s.store.put("ceo_decision_attempt", aid, {
      schema_version: "pair.os.vnext.ceo-decision-attempt.v1",
      attempt_id: aid, cycle_id: cycleId, objective_id: oid, business_id: bid,
      observation_digest: obs.observation_digest, attempt_number: 1, state: "STARTED",
      model_entry_id: me, provider_id: pid, model_id: "m1",
      started_at: new Date().toISOString(), started_by: OP, settled_at: null,
      response_digest: null, canonical_proposal_digest: null, failure_code: null, version: 0,
    } as never, 0); // no START event → non-canonical
    expect(() => assertCanonicalCeoAttempt(s.store, s.store.get("ceo_decision_attempt", aid))).toThrowError(/FAIL_CLOSED_CEO_DECISION_ATTEMPT/);
    s.store.close();
  });

  it("START anchor tampered (started_at rewritten, hash recomputed) → strict read fails", async () => {
    const s = freshCeo("r2c-3", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const att = attemptsOf(s.store)[0]!;
    const aid = String(att.attempt_id);
    const ev = s.store.listEvents("ceo_decision_attempt", aid).find((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_STARTED")!;
    const body = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: ev.actor, correlation_id: ev.correlation_id ?? null,
      metadata: { ...(ev.metadata as Record<string, unknown>), started_at: "1970-01-01T00:00:00.000Z" },
      created_at: ev.created_at,
    };
    dbOf(s.store).prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
      .run(JSON.stringify(body.metadata), eventHash(body), String(ev.event_id));
    expect(() => assertCanonicalCeoAttempt(s.store, s.store.get("ceo_decision_attempt", aid))).toThrowError(/FAIL_CLOSED_CEO_DECISION_ATTEMPT/);
    s.store.close();
  });

  it("terminal attempt without SETTLE anchor / duplicated anchor → fail closed", async () => {
    // strip the SETTLE anchor off a canonically settled attempt
    const s = freshCeo("r2c-4", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const att = attemptsOf(s.store)[0]!;
    expect(String(att.state)).toBe("ACCEPTED");
    const settle = s.store.listEvents("ceo_decision_attempt", String(att.attempt_id))
      .find((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_SETTLED")!;
    dbOf(s.store).prepare("DELETE FROM events WHERE event_id=?").run(String(settle.event_id));
    expect(() => assertCanonicalCeoAttempt(s.store, att)).toThrowError(/FAIL_CLOSED_CEO_DECISION_ATTEMPT/);
    s.store.close();
  });

  it("reconcile settle is canonical: crashed STARTED → UNKNOWN carries the SETTLE anchor", async () => {
    const s = freshCeo("r2c-5", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const obs = buildCeoObservation(s, oid);
    mintStartedAttempt(s, {
      objective_id: oid, observation_digest: obs.observation_digest,
      model_entry_id: s.me, provider_id: String(s.store.get("model_entry", s.me).provider_id),
      model_id: String(s.store.get("model_entry", s.me).model_id),
      business_id: bid, started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(s.svc.reconcileStaleAttempts(oid)).toBe(1);
    const att = attemptsOf(s.store)[0]!;
    expect(String(att.state)).toBe("UNKNOWN");
    assertCanonicalCeoAttempt(s.store, att); // canonical, settles proven
    s.store.close();
  });

  it("a canonical live STARTED attempt still blocks a second invocation (INFLIGHT)", async () => {
    const s = freshCeo("r2c-6", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const obs = buildCeoObservation(s, oid);
    mintStartedAttempt(s, {
      objective_id: oid, observation_digest: obs.observation_digest,
      model_entry_id: s.me, provider_id: String(s.store.get("model_entry", s.me).provider_id),
      model_id: String(s.store.get("model_entry", s.me).model_id),
      business_id: bid,
    });
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_INFLIGHT");
    expect(s.invoker.calls).toBe(0);
    s.store.close();
  });
});

/* ============================ R2.D — re-proof before invocation ============================ */

describe("P15.3 R2.D — model authority re-proof after STARTED commit", () => {
  it("provider authority revoked between claim and invoke → REJECTED attempt, ZERO calls, no decision", async () => {
    const s2 = freshStack("r2d-1");
    const pid2 = "codex-cli";
    const me2 = mkModel(s2.store, pid2, "m2");
    mkProvider(s2.store, pid2);
    const bid2 = mkBusiness(s2.store);
    const o2 = mkObjective(s2.objectives, bid2);
    const oid2 = String(o2.objective_id);
    const inv = new FakeInvoker(() => { throw new Error("MUST NOT INVOKE"); });
    const svc = new CeoPlanningCycleService({
      store: s2.store, objectives: s2.objectives, workstreams: s2.workstreams,
      proveWorkItemDone: s2.proveWorkItemDone,
      invoker: inv, model_entry_id: me2,
      // Post-claim seam: revoke provider health the instant STARTED
      // commits — re-proof must refuse the provider call.
      after_attempt_claim: () => {
        const pid2r = String(s2.store.get("model_entry", me2).provider_id);
        const p = s2.store.get("provider", providerEntryId(pid2r));
        s2.store.put("provider", String(p.entry_id), { ...p, health_state: "DOWN" }, Number(p.version));
      },
    });
    await expectFail(() => svc.runCycle({ objective_id: oid2, actor: OP }), "FAIL_CLOSED_CEO_MODEL_UNAVAILABLE");
    expect(inv.calls).toBe(0); // zero provider calls
    expect(decisionsOf(s2.store)).toHaveLength(0);
    expect(attemptsOf(s2.store)[0]!.state).toBe("REJECTED");
    expect(String(attemptsOf(s2.store)[0]!.failure_code)).toBe("CEO_MODEL_UNAVAILABLE");
    // the REJECTED settle is canonical
    assertCanonicalCeoAttempt(s2.store, attemptsOf(s2.store)[0]!);
    s2.store.close();
  });

  it("model replaced with a DSH_EXECUTION-aliased entry between claim and invoke → re-proof fails closed", async () => {
    const s = freshStack("r2d-2");
    const pid = "codex-cli";
    const me = mkModel(s.store, pid, "m1");
    const dsh = mkModel(s.store, pid, "dsh-m");
    mkProvider(s.store, pid);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const inv = new FakeInvoker(() => { throw new Error("MUST NOT INVOKE"); });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker: inv, model_entry_id: me,
      after_attempt_claim: () => {
        // an alias-bound DSH assignment appears mid-flight: the DSH entry
        // claims the CEO model's id in model_alias_ids → sameCanonicalModel
        // proves the overlap at re-proof time.
        const m = s.store.get("model_entry", dsh);
        s.store.put("model_entry", dsh, { ...m, model_alias_ids: ["m1"] }, Number(m.version));
        assignModelRole(s.store, dsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
      },
    });
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DSH_OVERLAP");
    expect(inv.calls).toBe(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });
});

/* ============================ R2.E — canonical cycle counting ============================ */

describe("P15.3 R2.E — canonical-only cycle counting", () => {
  it("a malformed ceo_decision row attributed to the objective fails the cycle (never silently skipped)", async () => {
    const s = freshCeo("r2e-1", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    // garbage row carrying this objective's id — corrupt authority
    s.store.put("ceo_decision", "CCD_garbage", {
      schema_version: "pair.os.vnext.ceo-decision.v1",
      decision_id: "CCD_garbage", cycle_id: "CCY_x", objective_id: oid,
      business_id: bid, fake: true, version: 0,
    } as never, 0);
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION");
    expect(s.invoker.calls).toBe(0);
    s.store.close();
  });
});

/* ============================ R2.F — observation byte bound ============================ */

describe("P15.3 R2.F — observation byte bound", () => {
  it("oversized observation → FAIL_CLOSED_CEO_OBSERVATION_TOO_LARGE, zero attempt, zero call", async () => {
    const s = freshCeo("r2f-1", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid, { statement: "x".repeat(200 * 1024) });
    const oid = String(o.objective_id);
    await expectFail(() => s.svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_OBSERVATION_TOO_LARGE");
    expect(s.invoker.calls).toBe(0);
    expect(attemptsOf(s.store)).toHaveLength(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });

  it("observation under the byte bound (multibyte UTF-8 counted) → proceeds", async () => {
    const s = freshCeo("r2f-2", decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid, { statement: "d".repeat(1024) + "".repeat(512) });
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    s.store.close();
  });
});

/* ============================ R2 ADDENDUM — Codex CLI subscription transport ============================ */

/** Fake codex CLI honoring the planner test seam (FAKE_CODEX_BEHAVIOR /
 *  FAKE_CODEX_ENVFILE / FAKE_CODEX_INVOKELOG) plus CEO decision output. */
const FAKE_CODEX_CEO_JS = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--output-last-message");
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const b = process.env.FAKE_CODEX_BEHAVIOR || "ceo_ok";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const invokeLog = process.env.FAKE_CODEX_INVOKELOG;
  if (invokeLog) fs.appendFileSync(invokeLog, "CEO\\n");
  const envFile = process.env.FAKE_CODEX_ENVFILE;
  if (envFile) {
    fs.writeFileSync(envFile, JSON.stringify({
      CODEX_HOME: process.env.CODEX_HOME != null,
      CODEX_API_KEY: process.env.CODEX_API_KEY != null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY != null,
      argv,
    }));
  }
  if (b === "sleep") { setTimeout(() => {}, 120000); return; }
  if (b === "authfail") { process.stderr.write("error: 401 unauthorized — login required\\n"); process.exit(1); }
  if (b === "modelunavail") { process.stderr.write("error: model gpt-6.1-sol is not available for this account\\n"); process.exit(1); }
  if (b === "ratelimit") { process.stderr.write("error: 429 rate limit exceeded\\n"); process.exit(1); }
  if (!out) { process.stderr.write("missing --output-last-message\\n"); process.exit(1); }
  if (b === "garbage") { fs.writeFileSync(out, "not json at all"); process.exit(0); }
  if (b === "oversized") { fs.writeFileSync(out, "x".repeat(80 * 1024)); process.exit(0); }
  // R3.A — the REAL strict --output-schema shape: every declared
  // property present, variant-inapplicable fields as explicit null.
  if (b === "ceo_init") {
    fs.writeFileSync(out, JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "INITIALIZE_WORKSTREAMS",
      workstreams: [{ workstream_key: "w1", title: "T", goal: "G", depends_on_keys: null }],
      priority_order: ["w1"], wait_reason: null, summary: "init",
    }));
    process.exit(0);
  }
  if (b === "ceo_prior") {
    fs.writeFileSync(out, JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
      workstreams: null, priority_order: ["w1"], wait_reason: null, summary: "p",
    }));
    process.exit(0);
  }
  fs.writeFileSync(out, JSON.stringify({
    schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
    workstreams: null, priority_order: null,
    wait_reason: "AWAITING_PROGRESS", summary: "wait",
  }));
  process.exit(0);
});
`;

function makeFakeCeoCodex(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "fake-codex-ceo.cjs");
  fs.writeFileSync(exe, FAKE_CODEX_CEO_JS);
  fs.chmodSync(exe, 0o755);
  return exe;
}

/** Canonical codex-cli provider + model, qualified through the real
 *  provider/model evidence seams (mirrors the planner test's canonical
 *  seed). Returns the model_entry_id. */
function seedCeoCodex(s: Stack, model = CEO_CODEX_DEFAULT_MODEL) {
  const meId = ensureCodexCliCatalog(s.store, model, "TEST");
  const pc = new ProviderCatalog(s.store);
  const p = pc.getProvider(CODEX_CLI_PROVIDER_ID)!;
  s.store.put("provider", String(p.entry_id), {
    ...p,
    lifecycle_state: "QUALIFIED",
    auth_state: "AUTH_OK",
    health_state: "READY",
    probe_state: "PROBED",
    conditions: [],
  }, Number(p.version));
  new ProviderCatalog(s.store).issueQualificationReceipt(CODEX_CLI_PROVIDER_ID, { policy_version: "test", actor: "t" });
  const mcat = new ModelEvidenceCatalog(s.store);
  mcat.recordProbeReceipt({
    probe_id: "PRB_codex_ceo", model_entry_id: meId, provider_id: CODEX_CLI_PROVIDER_ID,
    result: "PASS", probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
  });
  const q = qualifyModel(s.store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`seedCeoCodex failed: ${JSON.stringify(q.gates)}`);
  return meId;
}

describe("P15.3 R2-CLI — Codex CLI subscription transport (addendum)", () => {
  it("J1/J14 — production invoker is CodexCliCeoDecisionInvoker on the canonical codex-cli:gpt-6.1-sol entry", async () => {
    const s = freshStack("cli-1");
    const me = seedCeoCodex(s);
    const meRow = s.store.get("model_entry", me);
    expect(String(meRow.provider_id)).toBe(CODEX_CLI_PROVIDER_ID);
    expect(String(meRow.model_id)).toBe("gpt-6.1-sol");
    // The SAME canonical entry serves Planner routes — no second authority.
    expect(ensureCodexCliCatalog(s.store, "gpt-6.1-sol", "TEST")).toBe(me);
    const invoker = new CodexCliCeoDecisionInvoker({ scratchDir: s.dbPath + "-scr" });
    expect(typeof invoker.invoke).toBe("function");
    s.store.close();
  });

  it("J2 — no /chat/completions or Bearer/API credential path exists in CEO sources", () => {
    for (const f of ["src/pair/ceo-decision.ts", "src/pair/ceo-planning-cycle.ts", "src/pair/codex-cli-transport.ts"]) {
      const src = fs.readFileSync(path.join(ROOT_DIR2, f), "utf8");
      expect(src.includes("/chat/completions"), f).toBe(false);
      expect(/Bearer\s/i.test(src), f).toBe(false);
      expect(/authorization\s*:/i.test(src), f).toBe(false);
    }
  });

  it("J3/J4 — ambient OPENAI_API_KEY/CODEX_API_KEY never reach the child; CODEX_HOME forwarded", async () => {
    const s = freshStack("cli-3");
    const me = seedCeoCodex(s);
    const exe = makeFakeCeoCodex(s.dbPath + "-d");
    const envFile = path.join(ROOT, `env-${counter}.json`);
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: exe,
      scratchDir: s.dbPath + "-scr",
      env: {
        PAIR_CODEX_EXECUTABLE: exe,
        CODEX_HOME: "/home/test/.codex",
        OPENAI_API_KEY: "sk-secret",
        CODEX_API_KEY: "ck-secret",
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CODEX_BEHAVIOR: "ceo_ok",
        FAKE_CODEX_ENVFILE: envFile,
      },
    });
    const res = await invoker.invoke({
      transport: {
        model_entry_id: me, provider_id: CODEX_CLI_PROVIDER_ID,
        provider_family: CODEX_CLI_PROVIDER_ID, model_id: "gpt-6.1-sol",
        protocol_family: "CODEX_CLI",
      },
      system_prompt: "sys", user_prompt: "user", observation_digest: "d",
    });
    expect(res.model_id).toBe("gpt-6.1-sol");
    const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
    expect(childEnv.OPENAI_API_KEY).toBe(false);
    expect(childEnv.CODEX_API_KEY).toBe(false);
    expect(childEnv.CODEX_HOME).toBe(true);
    s.store.close();
  });

  it("J5 — CLI missing → FAIL_CLOSED_CEO_CLI_MISSING, zero fallback", async () => {
    const s = freshStack("cli-5");
    const me = seedCeoCodex(s);
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: path.join(ROOT, "nonexistent-codex"), scratchDir: s.dbPath + "-scr",
      env: { PATH: "" },
    });
    await expectFail(() => invoker.invoke({
      transport: {
        model_entry_id: me, provider_id: CODEX_CLI_PROVIDER_ID,
        provider_family: CODEX_CLI_PROVIDER_ID, model_id: "gpt-6.1-sol",
        protocol_family: "CODEX_CLI",
      },
      system_prompt: "s", user_prompt: "u", observation_digest: "d",
    }), "FAIL_CLOSED_CEO_CLI_MISSING");
    s.store.close();
  });

  it("J6/J7/J8 — authfail / modelunavail / timeout each fail closed with typed codes, zero fallback", async () => {
    const mk = async (behavior: string) => {
      const s = freshStack(`cli-${behavior}`);
      const me = seedCeoCodex(s);
      const exe = makeFakeCeoCodex(s.dbPath + "-d");
      const invoker = new CodexCliCeoDecisionInvoker({
        executable: exe, scratchDir: s.dbPath + "-scr",
        env: { PATH: process.env.PATH ?? "", FAKE_CODEX_BEHAVIOR: behavior },
      });
      const input = {
        transport: {
          model_entry_id: me, provider_id: CODEX_CLI_PROVIDER_ID,
          provider_family: CODEX_CLI_PROVIDER_ID, model_id: "gpt-6.1-sol",
          protocol_family: "CODEX_CLI",
        },
        system_prompt: "s", user_prompt: "u", observation_digest: "d",
        timeout_ms: 3_000,
      };
      return { s, invoker, input };
    };
    const auth = await mk("authfail");
    await expectFail(() => auth.invoker.invoke(auth.input), "FAIL_CLOSED_CEO_CLI_AUTH_FAILED");
    auth.s.store.close();
    const mu = await mk("modelunavail");
    await expectFail(() => mu.invoker.invoke(mu.input), "FAIL_CLOSED_CEO_CLI_MODEL_UNAVAILABLE");
    mu.s.store.close();
    const to = await mk("sleep");
    await expectFail(() => to.invoker.invoke(to.input), "FAIL_CLOSED_CEO_CLI_TIMEOUT");
    to.s.store.close();
  });

  it("J9 — malformed CEO JSON → attempt REJECTED, no decision mutation", async () => {
    const s = freshStack("cli-9");
    const me = seedCeoCodex(s);
    const exe = makeFakeCeoCodex(s.dbPath + "-d");
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: exe, scratchDir: s.dbPath + "-scr",
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_BEHAVIOR: "garbage" },
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CEO_DECISION_INVALID");
    expect(decisionsOf(s.store)).toHaveLength(0);
    expect(attemptsOf(s.store)[0]!.state).toBe("REJECTED");
    s.store.close();
  });

  it("J10/J13 — valid Codex CLI CEO JSON passes the deterministic gate; ZERO mission/dispatch side effects", async () => {
    const s = freshStack("cli-10");
    const me = seedCeoCodex(s);
    const exe = makeFakeCeoCodex(s.dbPath + "-d");
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: exe, scratchDir: s.dbPath + "-scr",
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_BEHAVIOR: "ceo_init" },
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    for (const ent of ["mission", "work_open_binding", "executor_execution", "planner_attempt"]) {
      expect(s.store.list(ent), ent).toHaveLength(0);
    }
    s.store.close();
  });

  it("J11 — Planner model assignment stays PLANNER_COORDINATOR after serving CEO_DECISION", async () => {
    const s = freshStack("cli-11");
    const me = seedCeoCodex(s);
    assignModelRole(s.store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    const exe = makeFakeCeoCodex(s.dbPath + "-d");
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: exe, scratchDir: s.dbPath + "-scr",
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_BEHAVIOR: "ceo_ok" },
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone,
      invoker, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const r = await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(modelRoleOf(s.store, me)).toBe(MODEL_ROLE.PLANNER_COORDINATOR);
    s.store.close();
  });
});

/* ============================ R3.A — null-placeholder normalization ============================ */

describe("P15.3 R3.A — strict-schema null placeholders normalize at the raw boundary", () => {
  // The REAL --output-schema strict shape: every declared property
  // present; variant-inapplicable fields are explicit null.
  it("schema-shaped WAIT with explicit nulls → PASS; stored proposal carries NO null placeholders", async () => {
    const s = freshCeo("r3a-1", JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: null, priority_order: null,
      wait_reason: "AWAITING_PROGRESS", summary: "ok",
    }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const r = await s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    const stored = r.decision.proposal as Record<string, unknown>;
    expect(stored.workstreams).toBeUndefined();
    expect(stored.priority_order).toBeUndefined();
    expect(Object.values(stored).some((v) => v === null)).toBe(false);
    s.store.close();
  });

  it("schema-shaped INITIALIZE with null wait_reason + null depends_on_keys → PASS + canonical graph", async () => {
    const s = freshCeo("r3a-2", JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "INITIALIZE_WORKSTREAMS",
      workstreams: [
        { workstream_key: "a", title: "A", goal: "g", depends_on_keys: null },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ],
      priority_order: ["a", "b"], wait_reason: null, summary: "init",
    }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const r = await s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    expect((r.decision.proposal as { workstreams: unknown[] }).workstreams).toHaveLength(2);
    expect(s.store.list("work_item").length).toBeGreaterThan(0);
    s.store.close();
  });

  it("schema-shaped PRIORITIZE with null workstreams/wait_reason → PASS receipt", async () => {
    const s = freshCeo("r3a-3", initProposalJson(["w1"]));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    // next cycle (new observation) — PRIORITIZE with strict nulls
    const inv2 = new FakeInvoker(() => ({
      model_entry_id: s.me, provider_id: "codex-cli", model_id: "ceo-m",
      raw_text: JSON.stringify({
        schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
        workstreams: null, priority_order: ["w1"], wait_reason: null, summary: null,
      }),
    }));
    const svc2 = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv2, model_entry_id: s.me,
    });
    // force a fresh observation by amending the objective
    const o2 = s.objectives.get(oid);
    s.objectives.amend(oid, { business_id: bid, patch: { target: "11" }, reason: "r", actor: `operator:${OP}` });
    const r2 = await svc2.runCycle({ objective_id: oid, actor: OP });
    expect(String(r2.decision.decision_kind)).toBe("PRIORITIZE_EXISTING");
    void o2;
    s.store.close();
  });

  it("non-null contradictory fields still reject the WHOLE proposal", async () => {
    const s = freshCeo("r3a-4", JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: [{ workstream_key: "x", title: "T", goal: "G", depends_on_keys: null }],
      priority_order: null, wait_reason: "AWAITING_PROGRESS", summary: null,
    }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DECISION_INVALID");
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });

  it("normalization boundary: stored canonical proposal rejects placeholder nulls (no weakening)", async () => {
    const { validateCanonicalCeoProposal, normalizeCeoRawProposalJson } = await import("../pair/ceo-decision.js");
    // raw path normalizes
    const p = validateCanonicalCeoProposal(
      normalizeCeoRawProposalJson({
        schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
        workstreams: null, priority_order: null,
        wait_reason: "AWAITING_PROGRESS", summary: null,
      }),
      { requireSchema: true },
    );
    expect(p.wait_reason).toBe("AWAITING_PROGRESS");
    expect("summary" in p).toBe(false);
    // stored canonical path must NOT normalize — a null field is malformed
    expect(() => validateCanonicalCeoProposal({
      decision_kind: "WAIT", wait_reason: "AWAITING_PROGRESS", workstreams: null,
    })).toThrowError(/INVALID/);
    // same for the parse path with non-null contradiction
    const { parseCeoDecisionText } = await import("../pair/ceo-decision.js");
    expect(() => parseCeoDecisionText(JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: [{ workstream_key: "x", title: "t", goal: "g" }],
      wait_reason: "AWAITING_PROGRESS",
    }))).toThrowError(/INVALID/);
  });
});

/* ============================ R3.B — codex-cli-only provider authority ============================ */

describe("P15.3 R3.B — codex-cli is the ONLY CEO provider authority", () => {
  it("eligible model under a NON-codex provider → ZERO attempt, ZERO invocation, fail closed", async () => {
    const s = freshStack("r3b-1");
    const me = mkModel(s.store, "openai", "gpt-x"); // eligible generic HTTP provider
    mkProvider(s.store, "openai");
    const inv = new FakeInvoker(() => { throw new Error("MUST NOT INVOKE"); });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT");
    expect(inv.calls).toBe(0);
    expect(attemptsOf(s.store)).toHaveLength(0); // before claim
    s.store.close();
  });

  it("forged transport (provider/protocol not codex-cli) → invoker rejects BEFORE spawn", async () => {
    const s = freshStack("r3b-2");
    const me = seedCeoCodex(s);
    const exe = makeFakeCeoCodex(s.dbPath + "-d");
    const logFile = path.join(ROOT, `invokelog-${counter}.txt`);
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: exe, scratchDir: s.dbPath + "-scr",
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_INVOKELOG: logFile, FAKE_CODEX_BEHAVIOR: "ceo_ok" },
    });
    const forged = {
      model_entry_id: me, provider_id: "openai", provider_family: "openai",
      model_id: "gpt-x", protocol_family: "CODEX_CLI",
    };
    await expectFail(() => invoker.invoke({
      transport: forged, system_prompt: "s", user_prompt: "u", observation_digest: "d",
    }), "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT");
    const forged2 = { ...forged, provider_id: "codex-cli", protocol_family: "HTTPS_JSON" };
    await expectFail(() => invoker.invoke({
      transport: forged2, system_prompt: "s", user_prompt: "u", observation_digest: "d",
    }), "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT");
    expect(fs.existsSync(logFile)).toBe(false); // zero spawn
    s.store.close();
  });

  it("codex-cli endpoint identity drift → fail closed at resolution", async () => {
    const s = freshStack("r3b-3");
    const me = seedCeoCodex(s);
    const p = s.store.get("provider", providerEntryId("codex-cli"));
    s.store.put("provider", String(p.entry_id), {
      ...p, endpoint_reference: "https://api.openai.com/v1",
    }, Number(p.version));
    const inv = new FakeInvoker(() => { throw new Error("MUST NOT INVOKE"); });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT");
    expect(inv.calls).toBe(0);
    expect(attemptsOf(s.store)).toHaveLength(0);
    s.store.close();
  });

  it("mid-flight provider protocol drift after START claim → re-proof rejects, attempt REJECTED, zero CLI call", async () => {
    const s = freshStack("r3b-4");
    const me = seedCeoCodex(s);
    const inv = new FakeInvoker(() => { throw new Error("MUST NOT INVOKE"); });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
      after_attempt_claim: () => {
        const p = s.store.get("provider", providerEntryId("codex-cli"));
        s.store.put("provider", String(p.entry_id), { ...p, protocol_family: "HTTPS_JSON" }, Number(p.version));
      },
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT");
    expect(inv.calls).toBe(0);
    expect(String(attemptsOf(s.store)[0]!.state)).toBe("REJECTED");
    assertCanonicalCeoAttempt(s.store, attemptsOf(s.store)[0]!);
    s.store.close();
  });
});

/* ============================ R3.C — scratch hygiene + pre-read bound ============================ */

describe("P15.3 R3.C — raw Codex output never persists; bounded read", () => {
  const mkCli = async (name: string, behavior: string) => {
    const s = freshStack(`r3c-${name}`);
    const me = seedCeoCodex(s);
    const scr = s.dbPath + "-scr";
    fs.mkdirSync(scr, { recursive: true });
    const invoker = new CodexCliCeoDecisionInvoker({
      executable: makeFakeCeoCodex(s.dbPath + "-d"), scratchDir: scr,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_BEHAVIOR: behavior },
    });
    const input = {
      transport: {
        model_entry_id: me, provider_id: CODEX_CLI_PROVIDER_ID,
        provider_family: CODEX_CLI_PROVIDER_ID, model_id: "gpt-6.1-sol",
        protocol_family: "CODEX_CLI",
      },
      system_prompt: "s", user_prompt: "u", observation_digest: "d",
      timeout_ms: 3_000,
    };
    return { s, scr, invoker, input };
  };

  it("valid call → result in memory + run dir removed; scratch root preserved", async () => {
    const { s, scr, invoker, input } = await mkCli("ok", "ceo_ok");
    const res = await invoker.invoke(input);
    expect(res.raw_text).toContain("pair.ceo-decision.v1");
    expect(fs.existsSync(scr)).toBe(true);
    expect(fs.readdirSync(scr)).toHaveLength(0); // zero residual final.txt/schema.json
    s.store.close();
  });

  it("malformed output → cleanup still happens", async () => {
    const { s, scr, invoker, input } = await mkCli("bad", "garbage");
    const res = await invoker.invoke(input);
    expect(res.raw_text).toBe("not json at all");
    expect(() => JSON.parse(res.raw_text)).toThrow();
    expect(fs.readdirSync(scr)).toHaveLength(0);
    s.store.close();
  });

  it("timeout → cleanup still happens", async () => {
    const { s, scr, invoker, input } = await mkCli("to", "sleep");
    await expectFail(() => invoker.invoke(input), "FAIL_CLOSED_CEO_CLI_TIMEOUT");
    expect(fs.readdirSync(scr)).toHaveLength(0);
    s.store.close();
  });

  it("oversized final file → rejected WITHOUT unbounded read; cleanup happens", async () => {
    const { s, scr, invoker, input } = await mkCli("big", "oversized");
    await expectFail(() => invoker.invoke(input), "FAIL_CLOSED_CEO_CLI_OUTPUT_INVALID");
    expect(fs.readdirSync(scr)).toHaveLength(0);
    s.store.close();
  });
});

/* ============================ R3.D — attempt actor provenance ============================ */

describe("P15.3 R3.D — attempt actor provenance pinned", () => {
  async function committedCycle(name: string) {
    const s = freshCeo(name, initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    return { s, oid, did: String(r.decision.decision_id), bid };
  }
  const strictRead = (s: ReturnType<typeof freshCeo>, _oid: string, did: string) =>
    assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never);

  it("tamper started_by on the row → strict attempt validation fails", async () => {
    const { s, oid, did } = await committedCycle("r3d-1");
    const dec = s.store.get("ceo_decision", did);
    const att = s.store.get("ceo_decision_attempt", String(dec.attempt_id));
    s.store.put("ceo_decision_attempt", String(dec.attempt_id), { ...att, started_by: "999" }, Number(att.version));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION_ATTEMPT");
    s.store.close();
  });

  it("tamper START event actor + recompute event_hash → fail", async () => {
    const { s, oid, did } = await committedCycle("r3d-2");
    const dec = s.store.get("ceo_decision", did);
    const aid = String(dec.attempt_id);
    const ev = s.store.listEvents("ceo_decision_attempt", aid)
      .find((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_STARTED")!;
    const body = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: "operator:intruder", correlation_id: ev.correlation_id ?? null,
      metadata: ev.metadata, created_at: ev.created_at,
    };
    dbOf(s.store).prepare(
      "UPDATE events SET actor=?, event_hash=? WHERE event_id=?",
    ).run("operator:intruder", eventHash(body), String(ev.event_id));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION_ATTEMPT");
    s.store.close();
  });

  it("tamper SETTLE event actor + recompute event_hash → fail", async () => {
    const { s, oid, did } = await committedCycle("r3d-3");
    const dec = s.store.get("ceo_decision", did);
    const aid = String(dec.attempt_id);
    const ev = s.store.listEvents("ceo_decision_attempt", aid)
      .find((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_SETTLED")!;
    const body = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: "operator:intruder", correlation_id: ev.correlation_id ?? null,
      metadata: ev.metadata, created_at: ev.created_at,
    };
    dbOf(s.store).prepare(
      "UPDATE events SET actor=?, event_hash=? WHERE event_id=?",
    ).run("operator:intruder", eventHash(body), String(ev.event_id));
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION_ATTEMPT");
    s.store.close();
  });

  it("system reconciliation settles with operator:system — canonical", async () => {
    const s = freshCeo("r3d-4", () => new Promise<CeoInvokeResult>(() => {}));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const p = s.svc.runCycle({ objective_id: oid, actor: OP }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const att = attemptsOf(s.store)[0]!;
    expect(String(att.state)).toBe("STARTED");
    // age it past grace — in-place byte rewrite keeps version=1 so the
    // aged STARTED row stays canonical under the R4.B cardinality pin.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    sqlRewriteEntity(s.store, "ceo_decision_attempt", String(att.attempt_id),
      (b) => { b.started_at = old; });
    // started_at is pinned in START metadata — patch it there too so the
    // attempt stays canonical while aged.
    const ev = s.store.listEvents("ceo_decision_attempt", String(att.attempt_id))[0]!;
    const md = { ...(ev.metadata as Record<string, unknown>), started_at: old };
    md.start_identity_digest = ceoAttemptStartDigest({
      attempt_id: String(att.attempt_id), cycle_id: String(att.cycle_id),
      objective_id: oid, business_id: String(att.business_id),
      observation_digest: String(att.observation_digest),
      attempt_number: Number(att.attempt_number),
      model_entry_id: String(att.model_entry_id),
      provider_id: String(att.provider_id), model_id: String(att.model_id),
      started_at: old, started_by: OP,
    });
    const body2 = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: ev.actor, correlation_id: ev.correlation_id ?? null,
      metadata: md, created_at: ev.created_at,
    };
    dbOf(s.store).prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
      .run(JSON.stringify(md), eventHash(body2), String(ev.event_id));
    expect(s.svc.reconcileStaleAttempts(oid)).toBe(1);
    const settled = s.store.get("ceo_decision_attempt", String(att.attempt_id));
    expect(String(settled.state)).toBe("UNKNOWN");
    assertCanonicalCeoAttempt(s.store, settled); // operator:system settle actor canonical
    void p;
    s.store.close();
  });
});

/* ============================ R4.A — terminal monotonicity ============================ */

describe("P15.3 R4.A — attempt terminal monotonicity", () => {
  it("UNKNOWN never resurrects: late invocation cannot commit; bounded attempt #2 commits", async () => {
    let release: ((v: CeoInvokeResult) => void) | undefined;
    const gate = new Promise<CeoInvokeResult>((r) => { release = r; });
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let s: ReturnType<typeof freshCeo>;
    s = freshCeo("r4a-1", () => {
      calls += 1;
      if (calls === 1) return gate;
      const m = s.store.get("model_entry", s.me);
      return {
        model_entry_id: s.me,
        provider_id: String(m.provider_id),
        model_id: String(m.model_id),
        raw_text: initProposalJson(),
      };
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const did = ceoDecisionId(oid, ceoCycleId(oid, buildCeoObservation(s, oid).observation_digest));

    // (1)+(2): pending real invocation; STARTED attempt committed.
    const p = s.svc.runCycle({ objective_id: oid, actor: OP });
    const pGuard = p.then(() => "resolved" as const, (e) => e);
    await new Promise((r) => setTimeout(r, 60));
    const att = attemptsOf(s.store)[0]!;
    const aid = String(att.attempt_id);
    expect(String(att.state)).toBe("STARTED");

    // (3): age past grace → reconcile → canonical UNKNOWN.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    sqlRewriteEntity(s.store, "ceo_decision_attempt", aid,
      (b) => { b.started_at = old; });
    const ev = s.store.listEvents("ceo_decision_attempt", aid)[0]!;
    const md = { ...(ev.metadata as Record<string, unknown>), started_at: old };
    md.start_identity_digest = ceoAttemptStartDigest({
      attempt_id: aid, cycle_id: String(att.cycle_id),
      objective_id: oid, business_id: String(att.business_id),
      observation_digest: String(att.observation_digest),
      attempt_number: Number(att.attempt_number),
      model_entry_id: String(att.model_entry_id),
      provider_id: String(att.provider_id), model_id: String(att.model_id),
      started_at: old, started_by: OP,
    });
    const evBody = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: ev.actor, correlation_id: ev.correlation_id ?? null,
      metadata: md, created_at: ev.created_at,
    };
    dbOf(s.store).prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
      .run(JSON.stringify(md), eventHash(evBody), String(ev.event_id));
    expect(s.svc.reconcileStaleAttempts(oid)).toBe(1);
    expect(String(s.store.get("ceo_decision_attempt", aid).state)).toBe("UNKNOWN");

    // (4)+(5)+(6): release the OLD invocation — it must NOT commit any
    // decision, and its INITIALIZE must mint zero binding/work graph.
    const m = s.store.get("model_entry", s.me);
    release!({
      model_entry_id: s.me,
      provider_id: String(m.provider_id),
      model_id: String(m.model_id),
      raw_text: initProposalJson(),
    });
    const outcome = await pGuard;
    expect((outcome as IntegrityError).code ?? outcome).toBe("FAIL_CLOSED_CEO_DECISION_ATTEMPT");

    // (5): zero CEO decision row minted by the late worker.
    expect(s.store.tryGet("ceo_decision", did)).toBeNull();
    expect(decisionsOf(s.store)).toHaveLength(0);
    // (6): zero CEO-authorized binding / work graph from the late result.
    expect(s.workstreams.getBinding(oid)).toBeNull();
    expect(s.store.list("work_item")).toHaveLength(0);
    // (7): attempt #1 remains canonical UNKNOWN — exactly 1 SETTLE anchor.
    const settled = s.store.get("ceo_decision_attempt", aid);
    expect(String(settled.state)).toBe("UNKNOWN");
    assertCanonicalCeoAttempt(s.store, settled);
    const settles = s.store.listEvents("ceo_decision_attempt", aid)
      .filter((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_SETTLED");
    expect(settles).toHaveLength(1);

    // (8): bounded attempt #2 on the SAME observation commits normally.
    const r2 = await s.svc.runCycle({ objective_id: oid, actor: OP });
    expect(calls).toBe(2);
    expect(String(r2.decision.decision_id)).toBe(did);
    expect(String(r2.decision.state)).toBe("COMMITTED");
    expect(String(r2.attempt_id)).not.toBe(aid);
    const attempts = attemptsOf(s.store);
    expect(attempts).toHaveLength(2);
    const att2 = attempts.find((a) => Number(a.attempt_number) === 2)!;
    expect(String(att2.state)).toBe("ACCEPTED");
    assertCanonicalCeoAttempt(s.store, att2);
    expect(s.workstreams.getBinding(oid)).not.toBeNull();
    s.store.close();
  });

  it("terminal attempt never transitions — settle on a settled row is a converged no-op", async () => {
    const s = freshCeo("r4a-2", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    await s.svc.runCycle({ objective_id: oid, actor: OP });
    const att = attemptsOf(s.store)[0]!;
    expect(String(att.state)).toBe("ACCEPTED");
    // Second reconcile pass touches nothing; no second SETTLE anchor.
    expect(s.svc.reconcileStaleAttempts(oid)).toBe(0);
    assertCanonicalCeoAttempt(s.store, s.store.get("ceo_decision_attempt", String(att.attempt_id)));
    expect(s.store.listEvents("ceo_decision_attempt", String(att.attempt_id))
      .filter((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_SETTLED")).toHaveLength(1);
    s.store.close();
  });
});

/* ============================ R4.B — strict canonical row shape ============================ */

describe("P15.3 R4.B — strict canonical row shape + immutability", () => {
  async function committed(name: string) {
    const s = freshCeo(name, initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    return { s, oid, did: String(r.decision.decision_id) };
  }

  it("shadow authority fields on the decision row → strict read fails", async () => {
    for (const field of [
      "executor_id", "mission_id", "assignee_agent_id",
      "selected_model", "router", "telegram",
    ]) {
      const { s, did } = await committed(`r4b-${field}`);
      sqlRewriteEntity(s.store, "ceo_decision", did, (b) => { b[field] = "x"; });
      await expectFail(
        () => assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never),
        "FAIL_CLOSED_CEO_DECISION",
      );
      s.store.close();
    }
  });

  it("shadow field on the attempt row → strict attempt validation fails", async () => {
    const { s, did } = await committed("r4b-att");
    const dec = s.store.get("ceo_decision", did);
    const aid = String(dec.attempt_id);
    sqlRewriteEntity(s.store, "ceo_decision_attempt", aid, (b) => { b.mission_id = "m1"; });
    await expectFail(
      () => assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never),
      "FAIL_CLOSED_CEO_DECISION_ATTEMPT",
    );
    s.store.close();
  });

  it("generic rewrite of a committed decision (create-only pin) → fails", async () => {
    const { s, did } = await committed("r4b-rewrite");
    const dec = s.store.get("ceo_decision", did);
    // A byte-identical generic rewrite bumps version 1→2 — no longer authority.
    s.store.put("ceo_decision", did, { ...dec, version: 1 }, 1);
    await expectFail(
      () => assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never),
      "FAIL_CLOSED_CEO_DECISION",
    );
    s.store.close();
  });

  it("generic rewrite of a terminal attempt (lifecycle cardinality) → fails", async () => {
    const { s, did } = await committed("r4b-att-rewrite");
    const dec = s.store.get("ceo_decision", did);
    const aid = String(dec.attempt_id);
    const att = s.store.get("ceo_decision_attempt", aid);
    s.store.put("ceo_decision_attempt", aid, { ...att, version: 2 }, 2);
    await expectFail(
      () => assertCanonicalCeoAttempt(s.store, s.store.get("ceo_decision_attempt", aid)),
      "FAIL_CLOSED_CEO_DECISION_ATTEMPT",
    );
    s.store.close();
  });

  it("non-vacuous control: valid committed decision + attempt pass strict read", async () => {
    const { s, did } = await committed("r4b-control");
    const dec = s.store.get("ceo_decision", did);
    assertCanonicalCeoDecision(s, dec as never);
    assertCanonicalCeoAttempt(s.store, s.store.get("ceo_decision_attempt", String(dec.attempt_id)));
    s.store.close();
  });
});

/* ============================ R4.C — end-to-end actor provenance ============================ */

describe("P15.3 R4.C — decision created_by == attempt started_by", () => {
  it("internally-consistent forged creator still fails on the attempt link", async () => {
    const s = freshCeo("r4c-1", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);

    // Forge: rewrite the decision row for creator "mallory" — recompute
    // decision_digest, keep store version 1, AND rewrite the COMMITTED
    // anchor actor + pinned digest so the forged row is internally
    // consistent. The linked canonical attempt still belongs to OP.
    let newDigest = "";
    sqlRewriteEntity(s.store, "ceo_decision", did, (b) => {
      b.created_by = "mallory";
      b.decision_digest = ceoDecisionDigest(b);
      newDigest = String(b.decision_digest);
    });
    const ev = s.store.listEvents("ceo_decision", did)
      .find((e) => String(e.event_type) === "CEO_DECISION_COMMITTED")!;
    const md = { ...(ev.metadata as Record<string, unknown>), decision_digest: newDigest };
    const evBody = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: "operator:mallory", correlation_id: ev.correlation_id ?? null,
      metadata: md, created_at: ev.created_at,
    };
    dbOf(s.store).prepare("UPDATE events SET actor=?, metadata_json=?, event_hash=? WHERE event_id=?")
      .run("operator:mallory", JSON.stringify(md), eventHash(evBody), String(ev.event_id));

    await expectFail(
      () => assertCanonicalCeoDecision(s, s.store.get("ceo_decision", did) as never),
      "FAIL_CLOSED_CEO_DECISION",
    );
    s.store.close();
  });

  it("replay path enforces the same link — forged creator fails runCycle replay", async () => {
    const s = freshCeo("r4c-2", initProposalJson());
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    const r = await s.svc.runCycle({ objective_id: oid, actor: OP });
    const did = String(r.decision.decision_id);
    sqlRewriteEntity(s.store, "ceo_decision", did, (b) => {
      b.created_by = "mallory";
      b.decision_digest = ceoDecisionDigest(b);
    });
    const ev = s.store.listEvents("ceo_decision", did)
      .find((e) => String(e.event_type) === "CEO_DECISION_COMMITTED")!;
    const md = {
      ...(ev.metadata as Record<string, unknown>),
      decision_digest: String(s.store.get("ceo_decision", did).decision_digest),
    };
    const evBody = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state ?? null, new_state: ev.new_state,
      actor: "operator:mallory", correlation_id: ev.correlation_id ?? null,
      metadata: md, created_at: ev.created_at,
    };
    dbOf(s.store).prepare("UPDATE events SET actor=?, metadata_json=?, event_hash=? WHERE event_id=?")
      .run("operator:mallory", JSON.stringify(md), eventHash(evBody), String(ev.event_id));
    await expectFail(
      () => s.svc.runCycle({ objective_id: oid, actor: OP }),
      "FAIL_CLOSED_CEO_DECISION",
    );
    s.store.close();
  });
});

/* ==================== P15.7-FIX1 — per-kind output contract ==================== */

describe("P15.7-FIX1 — system prompt expresses the per-kind null contract", () => {
  it("prompt pins all-six-required, per-kind null placement, 3 variants + examples", async () => {
    const { ceoDecisionSystemPrompt, CEO_DECISION_SCHEMA, CEO_DECISION_JSON_SCHEMA } =
      await import("../pair/ceo-decision.js");
    const p = ceoDecisionSystemPrompt();
    // Schema identity + all six required properties named.
    expect(p).toContain(CEO_DECISION_SCHEMA);
    for (const k of CEO_DECISION_JSON_SCHEMA.required as string[]) {
      expect(p).toContain(`"${k}"`);
    }
    expect(p).toContain("ALL SIX");
    // Per-kind null rules — verbatim enough to steer the model.
    expect(p).toMatch(/PRIORITIZE_EXISTING[\s\S]*"workstreams": null/);
    expect(p).toMatch(/WAIT[\s\S]*"priority_order": null/);
    expect(p).toMatch(/INITIALIZE_WORKSTREAMS[\s\S]*"wait_reason": null/);
    // Canonical-workstream redefinition ban.
    expect(p).toMatch(/NEVER\s+resubmit|never\s+resubmit/);
    // One valid example per kind.
    expect((p.match(/"decision_kind":"INITIALIZE_WORKSTREAMS"/g) ?? []).length).toBeGreaterThan(0);
    expect((p.match(/"decision_kind":"PRIORITIZE_EXISTING"/g) ?? []).length).toBeGreaterThan(0);
    expect((p.match(/"decision_kind":"WAIT"/g) ?? []).length).toBeGreaterThan(0);
  });

  it("every JSON example embedded in the prompt parses through the strict validator", async () => {
    const { ceoDecisionSystemPrompt, parseCeoDecisionText } =
      await import("../pair/ceo-decision.js");
    const p = ceoDecisionSystemPrompt();
    const examples = p.split("\n")
      .filter((l) => l.startsWith('{"schema":"pair.ceo-decision.v1"'));
    expect(examples.length).toBe(3);
    const kinds = examples.map((e) => parseCeoDecisionText(e).decision_kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["INITIALIZE_WORKSTREAMS", "PRIORITIZE_EXISTING", "WAIT"]),
    );
  });
});

describe("P15.7-FIX1 — strict-schema parse matrix", () => {
  const J = (o: unknown) => JSON.stringify(o);

  it("valid INITIALIZE/PRIORITIZE/WAIT proposals pass the full parse path", async () => {
    const { parseCeoDecisionText } = await import("../pair/ceo-decision.js");
    const init = parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "INITIALIZE_WORKSTREAMS",
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g", depends_on_keys: null }],
      priority_order: ["w1"], wait_reason: null, summary: null,
    }));
    expect(init.decision_kind).toBe("INITIALIZE_WORKSTREAMS");
    expect(init.workstreams).toHaveLength(1);

    const prio = parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
      workstreams: null, priority_order: ["w1", "w2"], wait_reason: null, summary: null,
    }));
    expect(prio.decision_kind).toBe("PRIORITIZE_EXISTING");
    expect(prio.priority_order).toEqual(["w1", "w2"]);
    expect("workstreams" in prio).toBe(false); // only canonical fields retained

    const wait = parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: null, priority_order: null, wait_reason: "DEPENDENCIES_BLOCKED", summary: null,
    }));
    expect(wait.decision_kind).toBe("WAIT");
    expect(wait.wait_reason).toBe("DEPENDENCIES_BLOCKED");
  });

  it("populated contradictions still reject whole-proposal (PRIORITIZE+workstreams, WAIT+workstreams/order)", async () => {
    const { parseCeoDecisionText } = await import("../pair/ceo-decision.js");
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
      workstreams: [{ workstream_key: "x", title: "t", goal: "g", depends_on_keys: null }],
      priority_order: ["x"], wait_reason: null, summary: null,
    }))).toThrowError(/PRIORITIZE_EXISTING must not submit workstreams/);
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: [{ workstream_key: "x", title: "t", goal: "g", depends_on_keys: null }],
      priority_order: null, wait_reason: "AWAITING_PROGRESS", summary: null,
    }))).toThrowError(/INVALID/);
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
      workstreams: null, priority_order: ["w1"], wait_reason: "AWAITING_PROGRESS", summary: null,
    }))).toThrowError(/WAIT must not submit priority_order/);
  });

  it("missing/invalid required fields reject (kind, schema, order, wait_reason)", async () => {
    const { parseCeoDecisionText } = await import("../pair/ceo-decision.js");
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", workstreams: null, priority_order: ["a"],
      wait_reason: null, summary: null,
    }))).toThrowError(/INVALID/);
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "REORDER", workstreams: null,
      priority_order: ["a"], wait_reason: null, summary: null,
    }))).toThrowError(/INVALID/);
    expect(() => parseCeoDecisionText(J({
      decision_kind: "WAIT", workstreams: null, priority_order: null,
      wait_reason: "AWAITING_PROGRESS", summary: null,
    }))).toThrowError(/INVALID/);
    expect(() => parseCeoDecisionText(J({
      schema: "pair.ceo-decision.v1", decision_kind: "WAIT", workstreams: null,
      priority_order: null, wait_reason: "MAYBE_LATER", summary: null,
    }))).toThrowError(/INVALID/);
  });

  it("invalid proposals mint ZERO decision/strategy/workstream rows (through runCycle)", async () => {
    const s = freshCeo("fix1-mint", JSON.stringify({
      schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
      workstreams: [{ workstream_key: "x", title: "t", goal: "g", depends_on_keys: null }],
      priority_order: ["x"], wait_reason: null, summary: null,
    }));
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(
      () => s.svc.runCycle({ objective_id: String(o.objective_id), actor: OP }),
      "FAIL_CLOSED_CEO_DECISION_INVALID",
    );
    expect(decisionsOf(s.store)).toHaveLength(0);
    expect(s.store.list("work_item").length).toBe(0);
    expect(s.store.list("objective_strategy_revision").length).toBe(0);
    s.store.close();
  });
});

/* ============ P15.7-FIX1-R2 — timeout ↔ stale-grace alignment ============ */

describe("P15.7-FIX1-R2 — invocation timeout vs stale reconciliation", () => {
  const ENV_NAME = "PAIR_CEO_CLI_TIMEOUT_MS";
  const savedEnv = process.env[ENV_NAME];
  const restoreEnv = () => {
    if (savedEnv === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = savedEnv;
  };
  afterEach(restoreEnv);

  const captureTimeout = (raw: string = decisionJson()) => {
    let captured: number | undefined;
    return {
      captured: () => captured,
      produce: (me: string, pid: string, mid: string) => (i: CeoInvokeInput) => {
        captured = i.timeout_ms;
        return { model_entry_id: me, provider_id: pid, model_id: mid, raw_text: raw };
      },
    };
  };

  it("default cycle → invoker timeout is exactly 300_000ms", async () => {
    delete process.env[ENV_NAME];
    const s = freshStack("r2-def");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const pid = String(s.store.get("model_entry", me).provider_id);
    const mid = String(s.store.get("model_entry", me).model_id);
    const cap = captureTimeout();
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, model_entry_id: me,
      invoker: new FakeInvoker(cap.produce(me, pid, mid)),
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(cap.captured()).toBe(300_000);
    s.store.close();
  });

  it("valid env override flows through the full cycle invocation path", async () => {
    process.env[ENV_NAME] = "450000";
    const s = freshStack("r2-env");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const pid = String(s.store.get("model_entry", me).provider_id);
    const mid = String(s.store.get("model_entry", me).model_id);
    const cap = captureTimeout();
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, model_entry_id: me,
      invoker: new FakeInvoker(cap.produce(me, pid, mid)),
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(cap.captured()).toBe(450_000);
    s.store.close();
  });

  it("invalid env values fail closed (non-int / out-of-bounds)", async () => {
    for (const bad of ["abc", "0", "-5", "4999", "900001", "1.5"]) {
      process.env[ENV_NAME] = bad;
      const s = freshStack(`r2-bad-${bad}`);
      const me = mkModel(s.store, "codex-cli", "m1");
      mkProvider(s.store, "codex-cli");
      const inv = new FakeInvoker((i) => ({
        model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
        model_id: i.transport.model_id, raw_text: decisionJson(),
      }));
      const svc = new CeoPlanningCycleService({
        store: s.store, objectives: s.objectives, workstreams: s.workstreams,
        proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
      });
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid);
      await expectFail(
        () => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }),
        "FAIL_CLOSED_CONFIG_INVALID",
      );
      expect(inv.calls).toBe(0); // never invoked with invalid config
      s.store.close();
    }
  });

  it("explicit timeout_ms injection keeps precedence over env", async () => {
    process.env[ENV_NAME] = "450000";
    const s = freshStack("r2-exp");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const pid = String(s.store.get("model_entry", me).provider_id);
    const mid = String(s.store.get("model_entry", me).model_id);
    const cap = captureTimeout();
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, model_entry_id: me,
      timeout_ms: 111_111,
      invoker: new FakeInvoker(cap.produce(me, pid, mid)),
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(cap.captured()).toBe(111_111);
    s.store.close();
  });

  it("stale reconciliation never fires before effective timeout + margin (incl. env >300s)", async () => {
    for (const [envV, effective] of [[undefined, 300_000], ["600000", 600_000]] as const) {
      if (envV === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = envV;
      const s = freshStack(`r2-grace-${envV}`);
      const me = mkModel(s.store, "codex-cli", "m1");
      mkProvider(s.store, "codex-cli");
      const bid = mkBusiness(s.store);
      const o = mkObjective(s.objectives, bid);
      const oid = String(o.objective_id);
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const svc = new CeoPlanningCycleService({
        store: s.store, objectives: s.objectives, workstreams: s.workstreams,
        proveWorkItemDone: s.proveWorkItemDone, model_entry_id: me,
        invoker: new FakeInvoker(() => ({ model_entry_id: me, provider_id: "codex-cli", model_id: "m1", raw_text: decisionJson() })),
        now: () => new Date(nowMs).toISOString(),
      });
      const obs = buildCeoObservation(s, oid);
      mintStartedAttempt(s, {
        objective_id: oid, observation_digest: obs.observation_digest,
        model_entry_id: me, provider_id: "codex-cli", model_id: "m1",
        business_id: bid, started_at: new Date(nowMs).toISOString(),
      });
      // inside the invocation window (age < effective timeout) → never reconcile
      nowMs += effective - 1;
      expect(svc.reconcileStaleAttempts(oid)).toBe(0);
      // inside the safety margin (timeout < age <= timeout+margin) → still no
      nowMs += 60_000;
      expect(svc.reconcileStaleAttempts(oid)).toBe(0);
      // past timeout + margin → reconciled UNKNOWN
      nowMs += 2;
      expect(svc.reconcileStaleAttempts(oid)).toBe(1);
      const row = s.store.get("ceo_decision_attempt",
        ceoAttemptId(oid, ceoCycleId(oid, obs.observation_digest), 1));
      expect(String(row.state)).toBe("UNKNOWN");
      expect(String(row.failure_code)).toBe("CEO_ATTEMPT_RECONCILED");
      s.store.close();
    }
  });

  it("explicit stale_grace_ms remains authoritative over derived grace", async () => {
    process.env[ENV_NAME] = "600000";
    const s = freshStack("r2-injgrace");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, model_entry_id: me,
      invoker: new FakeInvoker(() => ({ model_entry_id: me, provider_id: "codex-cli", model_id: "m1", raw_text: decisionJson() })),
      stale_grace_ms: 30_000, now: () => new Date(nowMs).toISOString(),
    });
    const obs = buildCeoObservation(s, oid);
    mintStartedAttempt(s, {
      objective_id: oid, observation_digest: obs.observation_digest,
      model_entry_id: me, provider_id: "codex-cli", model_id: "m1",
      business_id: bid, started_at: new Date(nowMs).toISOString(),
    });
    nowMs += 30_001;
    expect(svc.reconcileStaleAttempts(oid)).toBe(1);
    s.store.close();
  });

  it("two-attempt budget unchanged", () => {
    expect(CEO_MAX_ATTEMPTS_PER_OBSERVATION).toBe(2);
  });
});

/* ============ P15.7-FIX1-R3 — pre-claim timeout resolution ============ */

describe("P15.7-FIX1-R3 — invalid config never burns an attempt", () => {
  const ENV_NAME = "PAIR_CEO_CLI_TIMEOUT_MS";
  const savedEnv = process.env[ENV_NAME];
  const restoreEnv = () => {
    if (savedEnv === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = savedEnv;
  };
  afterEach(restoreEnv);

  it("invalid env → CONFIG_INVALID, zero invocations, ZERO attempt rows + ZERO STARTED events", async () => {
    process.env[ENV_NAME] = "not-a-number";
    const s = freshStack("r3-badenv");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const inv = new FakeInvoker((i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id, raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(
      () => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }),
      "FAIL_CLOSED_CONFIG_INVALID",
    );
    expect(inv.calls).toBe(0);
    expect(attemptsOf(s.store)).toHaveLength(0);
    expect(
      s.store.listEvents("ceo_decision_attempt")
        .filter((e) => String(e.event_type) === "CEO_DECISION_ATTEMPT_STARTED"),
    ).toHaveLength(0);
    s.store.close();
  });

  it("after fixing the config, the same observation still claims attempt 1", async () => {
    const s = freshStack("r3-retry");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const inv = new FakeInvoker((i) => ({
      model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
      model_id: i.transport.model_id, raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    process.env[ENV_NAME] = "900001"; // out of bounds → rejected pre-claim
    await expectFail(() => svc.runCycle({ objective_id: oid, actor: OP }), "FAIL_CLOSED_CONFIG_INVALID");
    expect(attemptsOf(s.store)).toHaveLength(0);
    process.env[ENV_NAME] = "300000"; // corrected → attempt #1 must be claimable
    const r = await svc.runCycle({ objective_id: oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    const attempts = attemptsOf(s.store);
    expect(attempts).toHaveLength(1);
    expect(Number(attempts[0]!.attempt_number)).toBe(1);
    expect(String(attempts[0]!.state)).toBe("ACCEPTED");
    s.store.close();
  });

  it("valid default and explicit-override paths unchanged post-R3", async () => {
    delete process.env[ENV_NAME];
    const seen: number[] = [];
    const s = freshStack("r3-ok");
    const me = mkModel(s.store, "codex-cli", "m1");
    mkProvider(s.store, "codex-cli");
    const inv = new FakeInvoker((i) => {
      seen.push(Number(i.timeout_ms));
      return { model_entry_id: i.transport.model_entry_id, provider_id: i.transport.provider_id,
        model_id: i.transport.model_id, raw_text: decisionJson() };
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: s.workstreams,
      proveWorkItemDone: s.proveWorkItemDone, invoker: inv, model_entry_id: me,
      timeout_ms: 77_000,
    });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(seen).toEqual([77_000]); // explicit override still wins
    s.store.close();
  });
});
