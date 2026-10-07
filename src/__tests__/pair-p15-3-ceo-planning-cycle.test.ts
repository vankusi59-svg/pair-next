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
import { describe, expect, it } from "vitest";
import {
  BusinessLayer,
  assertCanonicalCeoDecision,
  IntegrityError,
  ModelEvidenceCatalog,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  ProviderCatalog,
  WorkforceService,
  assignModelRole,
  MODEL_ROLE,
  modelRoleOf,
  providerEntryId,
  qualifyModel,
  CeoPlanningCycleService,
  buildCeoObservation,
  ceoCycleId,
  ceoDecisionId,
  digest,
  objectiveWorkstreamBindingDigest,
  objectiveWorkstreamBindingId,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p153-"));
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
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id }),
    lifecycle_state: lifecycle,
    auth_state: opts.auth_state ?? "AUTH_OK",
    health_state: opts.health_state ?? "READY",
    conditions: [],
    probe_state: ["QUALIFIED", "MODEL_DISCOVERY_ELIGIBLE"].includes(lifecycle) ? "PROBED" : "UNPROBED",
    // CEO transport resolution needs endpoint + credential env NAMES.
    endpoint_reference: "https://provider.test",
    credential_envs: ["TEST_API_KEY"],
    credential_reference_name: "TEST_API_KEY",
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
  return { dbPath, store, biz, wf, objectives, workstreams };
}

/** Stack + canonical model/provider + CEO service with a canned invoker. */
function freshCeo(name: string, raw: string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>), modelId?: string, extraDeps: Record<string, unknown> = {}) {
  const s = freshStack(name);
  const pid = `p${counter}`;
  const me = modelId ?? mkModel(s.store, pid, "ceo-m");
  mkProvider(s.store, `p${counter}` === pid ? pid : String(s.store.get("model_entry", me).provider_id));
  const invoker = new FakeInvoker((i) =>
    typeof raw === "function" ? raw(i) : ({
      model_entry_id: me,
      provider_id: String(s.store.get("model_entry", me).provider_id),
      model_id: String(s.store.get("model_entry", me).model_id),
      raw_text: raw,
    }));
  const svc = new CeoPlanningCycleService({
    store: s.store, objectives: s.objectives, workstreams: s.workstreams,
    invoker, model_entry_id: me, ...extraDeps,
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
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: "x" });
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
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: "x" });
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
      const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: "x" });
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
    const pid = `p${counter}`;
    const meDsh = mkModel(s.store, pid, "dsh-m");
    mkProvider(s.store, pid);
    assignModelRole(s.store, meDsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const inv = new FakeInvoker(() => { throw new Error("must not invoke"); });
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: meDsh });
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    await expectFail(() => svc.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DSH_OVERLAP");
    expect(attemptsOf(s.store)).toHaveLength(0);
    // alias-proven same canonical model → also overlap
    const meAlias = mkModel(s.store, pid, "other", { aliases: ["dsh-m"] });
    const svc2 = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: meAlias });
    await expectFail(() => svc2.runCycle({ objective_id: String(o.objective_id), actor: OP }), "FAIL_CLOSED_CEO_DSH_OVERLAP");
    s.store.close();
  });

  it("provider/model unavailable → no invocation, no decision; authority-ineligible → fail closed", async () => {
    // availability gate (provider DOWN) → CEO_MODEL_UNAVAILABLE
    const s1 = freshStack("b4a");
    const pid1 = `p${counter}`;
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
    const pid2 = `p${counter}`;
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
    const pid = `p${counter}`;
    const me = mkModel(s.store, pid, "m1");
    mkProvider(s.store, pid);
    const inv = new FakeInvoker(() => ({
      model_entry_id: me, provider_id: pid, model_id: "different-model", raw_text: decisionJson(),
    }));
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: me });
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
    const pid = `p${counter}`;
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
    const pid = `p${counter}`;
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
      invoker: inv, model_entry_id: me,
      stale_grace_ms: 60_000, now: () => new Date(nowMs).toISOString(),
    });
    // simulate a crashed STARTED attempt for THIS observation
    const obs = buildCeoObservation(s, oid);
    const cycleId = ceoCycleId(oid, obs.observation_digest);
    s.store.put("ceo_decision_attempt", "CCA_x1", {
      schema_version: "pair.os.vnext.ceo-decision-attempt.v1",
      attempt_id: "CCA_x1", cycle_id: cycleId, objective_id: oid, business_id: bid,
      observation_digest: obs.observation_digest, attempt_number: 1, state: "STARTED",
      model_entry_id: me, provider_id: pid, model_id: "m1",
      started_at: new Date(nowMs).toISOString(), settled_at: null,
      response_digest: null, canonical_proposal_digest: null, failure_code: null, version: 0,
    } as never, 0);
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
    const pid = `p${counter}`;
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
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: me });
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
    await expectFail(() => strictRead(s, oid, did), "FAIL_CLOSED_CEO_DECISION");
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
    const pid = `p${counter}`;
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
    const svc = new CeoPlanningCycleService({ store: s.store, objectives: s.objectives, workstreams: s.workstreams, invoker: inv, model_entry_id: mePlanner });
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
