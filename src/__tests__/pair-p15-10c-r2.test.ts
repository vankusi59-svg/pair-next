/**
 * P15.10-C R2 — fenced authority closure.
 *
 * Residual F1 findings on top of R1:
 *  F1.1 — authorityGate never re-proved the CLAIMED authorization
 *         version: PAUSE→RESUME during a model await produces an
 *         effective policy at version V+2 that is NOT the binding the
 *         lease was claimed under.
 *  F1.2 — commitReview's own store.immediate txn (receipt + strategy
 *         revision + anchors) had no guard — a revoke landing between
 *         the CEO decision commit and the review commit still wrote
 *         review authority.
 *  F1.3 — renew() checked lifetime only at renewal time but stamped
 *         expires_at = now+60s past the absolute deadline, and
 *         currentLease never checked lifetime — post-deadline settle
 *         / authority assertions still passed.
 *
 * Every proof reads canonical DB rows — never timers alone.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  BusinessLayer,
  DRIVER_ACTOR,
  IntegrityError,
  LEASE_STATE,
  ModelEvidenceCatalog,
  OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
  OBJECTIVE_STRATEGY_REVISION_ENTITY,
  ObjectiveAdaptiveReviewService,
  ObjectiveAuthorityService,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  ProviderCatalog,
  WorkforceAllocationService,
  WorkforceService,
  ensureCodexCliCatalog,
  providerEntryId,
  CODEX_CLI_PROVIDER_ID,
  CEO_CODEX_DEFAULT_MODEL,
  qualifyModel,
  createDefaultCeoPlanningCycle,
  readSchedulerRow,
  digest,
  CEO_DECISION_ENTITY,
  CEO_DECISION_ATTEMPT_ENTITY,
  SCHEDULER_RECEIPT,
  WAKE_STATE,
  WORKFORCE_ALLOCATION_ENTITY,
  DRIVER_STATE,
  createDefaultObjectiveOperatingService,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p1510cr2-");
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full stack: driver seams (policy/scheduler/wakeup) + governed CEO
 *  stack (business/workforce/workstreams/ceoCycle) on ONE store — the
 *  same composition serve-mission-control wires. */
function freshSvc(name: string, initial = 1_000_000) {
  let t = initial;
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // AUDIT R2-F1 — per-stack CODEX_HOME with a persisted ChatGPT session
  // file so the live auth-mode re-proof resolves CHATGPT.
  const codexHome = path.join(dir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: { sub: "u" }, access_token: "a", refresh_token: "r" },
  }));
  process.env.CODEX_HOME = codexHome;
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives, workstreams });
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  const bid = `BIZ_R2_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  const o = objectives.create({
    business_id: bid, title: "Sell", statement: "s",
    kpis: [{ name: "sales", unit: "u", baseline: 0, target: 10 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000_000,
    operator_id: OP, dedup_key: `r2-${counter}`,
  });
  const oid = String((o as { objective_id: string }).objective_id);
  const modelEntryId = seedCeoModel(store);
  return { dir, dbPath, store, biz, wf, objectives, workstreams, alloc,
    policy, scheduler, wakeup, oid, bid, modelEntryId,
    now: () => t, setNow: (v: number) => { t = v; } };
}

function seedCeoModel(store: PairEvidenceStore): string {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  const pid = CODEX_CLI_PROVIDER_ID;
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id) as Record<string, unknown> | null;
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id }),
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK", health_state: "READY",
    conditions: [], probe_state: "PROBED", provider_type: "LOCAL_CLI",
    protocol_family: "CODEX_CLI", endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [], credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(pid, { policy_version: "t", actor: "t" });
  new ModelEvidenceCatalog(store).recordProbeReceipt({
    probe_id: `PRB_r2_${counter++}`, model_entry_id: meId, provider_id: pid,
    result: "PASS", probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
  });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error("seedCeoModel failed");
  return meId;
}

class FakeInvoker implements CeoDecisionInvoker {
  calls = 0;
  constructor(private produce: (i: CeoInvokeInput) => Promise<CeoInvokeResult> | CeoInvokeResult) {}
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> { this.calls++; return this.produce(input); }
}

const decisionJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
    workstreams: null, priority_order: null,
    wait_reason: "AWAITING_PROGRESS", summary: null, ...over });

const waitResult = (i: CeoInvokeInput): CeoInvokeResult => ({
  model_entry_id: i.transport.model_entry_id,
  provider_id: i.transport.provider_id,
  model_id: i.transport.model_id,
  raw_text: decisionJson(),
});

type Svc = ReturnType<typeof freshSvc>;
const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, max_retries: 3, ...extra });

function enable(s: Svc, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "configure", limits: LIMITS(extra), idempotency_key: `cfg-${counter}-${Math.random()}` });
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "enable", policy_version: 1, idempotency_key: `en-${counter}-${Math.random()}` });
  s.wakeup.tick();
}

function pauseResume(s: Svc) {
  const v1 = s.policy.status(s.oid, OWNER).policy_version;
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "pause", policy_version: v1, idempotency_key: `p-${counter}-${Math.random()}` });
  const v2 = s.policy.status(s.oid, OWNER).policy_version;
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "resume", policy_version: v2, idempotency_key: `r-${counter}-${Math.random()}` });
}

const mkAgent = (s: Svc) => s.biz.createOrgAgent({
  business_id: s.bid, title: `agent ${counter}`,
  department: "ops", operator_id: OP,
});

const decisions = (s: Svc) => s.store.list(CEO_DECISION_ENTITY) as Array<Record<string, unknown>>;
const attempts = (s: Svc) => s.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Array<Record<string, unknown>>;
const reviews = (s: Svc) => s.store.list(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY) as Array<Record<string, unknown>>;
const strategies = (s: Svc) => s.store.list(OBJECTIVE_STRATEGY_REVISION_ENTITY) as Array<Record<string, unknown>>;
const settleReceipts = (s: Svc) =>
  (s.store.list(SCHEDULER_RECEIPT) as Array<Record<string, unknown>>)
    .filter((r) => r.operation === "SETTLE");

function mkDriver(s: Svc, runPassImpl: (input: {
  objective_id: string; actor: string; authority_gate: () => void;
}) => Promise<{ outcome: string; objective_id: string }>, heartbeatMs = 60_000) {
  // PR #121 — the configured autonomous id must exist as a canonical
  // ENABLED+QUALIFIED executor row to enter the supply envelope.
  if (!s.store.tryGet("executor", "CODEX")) {
    s.store.put("executor", "CODEX", {
      executor_id: "CODEX", executor_type: "EXTERNAL", status: "ENABLED",
      health_state: "READY", capabilities: [],
      metadata: { qualification_state: "QUALIFIED" },
    }, 0);
  }
  return new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async (input) => runPassImpl(input) as never,
    executors: ["CODEX"],
    // AUDIT R1 F4 — CEO subscription lane: CODEX resolves SUBSCRIPTION
    // billing (AUTH_OK provider session is seeded by seedCeoModel).
    billingFor: (e: string) =>
      e === "CODEX"
        ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
        : { mode: "UNMETERED", profile: null, unbounded: false },
    costHaltActive: () => false,
    workerId: "r2-w", bootId: "r2-b",
    now: s.now, heartbeatMs,
  });
}

function ceoSvc(s: Svc, produce: (i: CeoInvokeInput) => Promise<CeoInvokeResult> | CeoInvokeResult) {
  const { service } = createDefaultCeoPlanningCycle({
    store: s.store, business: s.biz, workforce: s.wf,
    invoker: new FakeInvoker(produce), model_entry_id: s.modelEntryId,
  } as never);
  return service;
}

describe("P15.10-C R2 — fenced authority closure", () => {

  it("R2-F1a PAUSE→RESUME mid-await: policy_version drift blocks the commit guard", async () => {
    const s = freshSvc("f1a");
    enable(s);
    const ceo = ceoSvc(s, async (i) => {
      pauseResume(s); // owner revokes then re-enables V+2 mid-invocation
      return waitResult(i);
    });
    const driver = mkDriver(s, async (input) => {
      // Mirrors pass(): the SAME authorityGate the driver wires is what
      // lands inside runCycle's commit transaction.
      await ceo.runCycle({
        objective_id: input.objective_id, actor: input.actor,
        autonomous_commit_guard: input.authority_gate,
      });
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    // Zero new CEO decision after the authorization version changed.
    expect(decisions(s)).toHaveLength(0);
    // Attempt accounting preserved — the invoked attempt settles REJECTED.
    expect(attempts(s)).toHaveLength(1);
    expect(["REJECTED", "STALE", "UNKNOWN"]).toContain(attempts(s)[0]!.state);
    expect(settleReceipts(s)).toHaveLength(0); // old worker never settles
  });

  it("R2-F1b terms/limits drift mid-await blocks commit (R3-corrected: legit disable→configure→enable)", async () => {
    const s = freshSvc("f1b");
    enable(s);
    const ceo = ceoSvc(s, async (i) => {
      // R3 correction: `configure` while ENABLED is an INVALID transition
      // (throws) — it never produced a real drift and the old test only
      // passed via the invoker's own error. The legitimate re-bind path
      // is disable→configure→enable: real policy_version bump + fresh
      // terms_digest pin while the policy becomes effective again.
      const v1 = s.policy.status(s.oid, OWNER).policy_version;
      s.policy.control({ objective_id: s.oid, actor: OWNER, action: "disable",
        policy_version: v1, idempotency_key: `d-${counter}` });
      const v2 = s.policy.status(s.oid, OWNER).policy_version;
      s.policy.control({ objective_id: s.oid, actor: OWNER, action: "configure",
        limits: LIMITS({ max_ceo_calls: 5 }), policy_version: v2,
        idempotency_key: `cfg2-${counter}` });
      const v3 = s.policy.status(s.oid, OWNER).policy_version;
      s.policy.control({ objective_id: s.oid, actor: OWNER, action: "enable",
        policy_version: v3, idempotency_key: `en2-${counter}` });
      return waitResult(i);
    });
    const driver = mkDriver(s, async (input) => {
      await ceo.runCycle({
        objective_id: input.objective_id, actor: input.actor,
        autonomous_commit_guard: input.authority_gate,
      });
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    expect(decisions(s)).toHaveLength(0);
    expect(settleReceipts(s)).toHaveLength(0);
  });

  it("R2-F1c genuine captured handle at stale fence cannot assert/renew/settle", async () => {
    const s = freshSvc("f1c");
    enable(s);
    const handleA = s.scheduler.claim(s.oid, "w-a", "b-a", "m", { max_lifetime_ms: 360_000 });
    s.setNow(s.now() + 90_000); // expiry without renewal
    s.scheduler.reconcileLeases();
    const handleB = s.scheduler.claim(s.oid, "w-b", "b-b", "m", { max_lifetime_ms: 360_000 });
    expect(Number(handleB.fence)).toBeGreaterThan(Number(handleA.fence));
    // The OLD genuine handle — real token, real fence — is fenced out.
    expect(() => s.scheduler.assertLeaseAuthority(handleA)).toThrow();
    expect(() => s.scheduler.renew(handleA)).toThrow();
    expect(() => s.scheduler.settle(handleA, "WAITING", "op-x")).toThrow();
    s.scheduler.settle(handleB, "WAITING", "op-b");
    expect(settleReceipts(s)).toHaveLength(1);
  });

  it("R2-F1d review commit after revoke rolls back (CEO path, decision legit)", async () => {
    const s = freshSvc("f1d");
    enable(s);
    const o = s.objectives.get(s.oid);
    s.workstreams.decomposeObjective({
      objective_id: s.oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    mkAgent(s);
    const ceo = ceoSvc(s, async (i) => waitResult(i)); // commits before revoke
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams, ceoCycle: ceo,
    });
    let revoked = false;
    let guardCalls = 0;
    const guard = () => {
      guardCalls++;
      if (guardCalls === 1) { revoked = true; return; } // revoke lands between txns
      if (revoked) throw new IntegrityError("FAIL_CLOSED_AUTONOMOUS_AUTHORITY_LOST", "x");
    };
    await expect(review.runReview({
      objective_id: s.oid, actor: DRIVER_ACTOR, autonomous_commit_guard: guard,
    })).rejects.toThrow();
    expect(guardCalls).toBe(2); // ceo commit txn + review commit txn
    expect(reviews(s)).toHaveLength(0); // review rolled back
    expect(strategies(s)).toHaveLength(0);
    expect(decisions(s)).toHaveLength(1); // decision committed legitimately before revoke
  });

  it("R2-F1e strategy revision never commits after authority loss", async () => {
    const s = freshSvc("f1e");
    enable(s);
    // Binding exists so CEO path returns PRIORITIZE_EXISTING.
    const o = s.objectives.get(s.oid);
    s.workstreams.decomposeObjective({
      objective_id: s.oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    const ceo = ceoSvc(s, async (i) => ({
      model_entry_id: i.transport.model_entry_id,
      provider_id: i.transport.provider_id, model_id: i.transport.model_id,
      raw_text: decisionJson({ decision_kind: "PRIORITIZE_EXISTING",
        wait_reason: null, priority_order: ["w1"], summary: "p" }),
    }));
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams, ceoCycle: ceo,
    });
    let guardCalls = 0;
    const guard = () => {
      guardCalls++;
      if (guardCalls === 2) {
        throw new IntegrityError("FAIL_CLOSED_AUTONOMOUS_AUTHORITY_LOST", "x");
      }
    };
    await expect(review.runReview({
      objective_id: s.oid, actor: DRIVER_ACTOR, autonomous_commit_guard: guard,
    })).rejects.toThrow();
    expect(reviews(s)).toHaveLength(0);
    expect(strategies(s)).toHaveLength(0); // the strategy is inside the rolled-back txn
  });

  it("R2-F1f deterministic review checkpoint (zero model calls) also guarded", async () => {
    const s = freshSvc("f1f");
    enable(s);
    const o = s.objectives.get(s.oid);
    s.workstreams.decomposeObjective({
      objective_id: s.oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    mkAgent(s);
    s.alloc.allocateWorkstream({ objective_id: s.oid, workstream_key: "w1", actor: OP });
    const ceo = ceoSvc(s, async (i) => waitResult(i));
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams, ceoCycle: ceo,
    });
    let guardCalls = 0;
    await expect(review.runReview({
      objective_id: s.oid, actor: DRIVER_ACTOR,
      autonomous_commit_guard: () => {
        guardCalls++;
        throw new IntegrityError("FAIL_CLOSED_AUTONOMOUS_AUTHORITY_LOST", "x");
      },
    })).rejects.toThrow();
    // AWAITING_PROGRESS is a deterministic checkpoint — zero invocations.
    expect(guardCalls).toBe(1);
    expect(reviews(s)).toHaveLength(0);
  });

  it("R2-F1g renew sát absolute deadline cannot extend lease past lifetime", async () => {
    const s = freshSvc("f1g");
    enable(s);
    const handle = s.scheduler.claim(s.oid, "w", "b", "m", { max_lifetime_ms: 60_000 });
    const deadline = s.now() + 60_000;
    s.setNow(s.now() + 50_000); // 10s before absolute deadline
    s.scheduler.renew(handle);
    const l = readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, s.oid)!;
    // Post-fix: expiry is clamped at the absolute deadline, never past it.
    expect(Number(l.expires_at)).toBeLessThanOrEqual(deadline);
  });

  it("R2-F1h settle/assert/commit after absolute deadline blocked even if expiry pending", async () => {
    const s = freshSvc("f1h");
    enable(s);
    const handle = s.scheduler.claim(s.oid, "w", "b", "m", { max_lifetime_ms: 60_000 });
    s.setNow(s.now() + 50_000);
    s.scheduler.renew(handle); // prepatch stamps expires_at = +110s > deadline
    s.setNow(s.now() + 25_000); // +75s — past deadline, prepatch still "ACTIVE" until +110s
    expect(() => s.scheduler.assertLeaseAuthority(handle)).toThrow();
    expect(() => s.scheduler.renew(handle)).toThrow();
    expect(() => s.scheduler.settle(handle, "WAITING", "op-h")).toThrow();
  });

  it("R2-F1i two independent SQLite connections: genuine fencing post-expiry", async () => {
    const s = freshSvc("f1i");
    enable(s);
    const handleA = s.scheduler.claim(s.oid, "w-a", "b-a", "m", { max_lifetime_ms: 360_000 });
    s.setNow(s.now() + 90_000);
    s.scheduler.reconcileLeases();
    const store2 = new PairEvidenceStore(s.dbPath);
    const objectives2 = new ObjectiveAuthorityService(store2);
    const policy2 = new ObjectiveAutoPolicyService(store2, objectives2, s.now);
    const sched2 = new ObjectiveAutoScheduler(store2, objectives2, policy2, s.now);
    const handleB = sched2.claim(s.oid, "w-b", "b-b", "m", { max_lifetime_ms: 360_000 });
    expect(Number(handleB.fence)).toBeGreaterThan(Number(handleA.fence));
    // Genuine A handle on its own connection still cannot assert.
    const objectivesA2 = new ObjectiveAuthorityService(store2);
    const policyA2 = new ObjectiveAutoPolicyService(store2, objectivesA2, s.now);
    const schedA = new ObjectiveAutoScheduler(store2, objectivesA2, policyA2, s.now);
    expect(() => schedA.assertLeaseAuthority(handleA)).toThrow();
    expect(() => schedA.settle(handleA, "WAITING", "op-i")).toThrow();
    sched2.settle(handleB, "WAITING", "op-b");
    expect(settleReceipts(s)).toHaveLength(1);
    store2.close();
  });

  it("R2-F1j manual CEO/review callers unchanged — no guard = no fencing", async () => {
    const s = freshSvc("f1j");
    const ceo = ceoSvc(s, async (i) => waitResult(i));
    const r = await ceo.runCycle({ objective_id: s.oid, actor: OP });
    expect(r.replayed).toBe(false);
    expect(decisions(s)).toHaveLength(1);
    // Manual review without guard commits normally (deterministic path).
    const o = s.objectives.get(s.oid);
    s.workstreams.decomposeObjective({
      objective_id: s.oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    mkAgent(s);
    s.alloc.allocateWorkstream({ objective_id: s.oid, workstream_key: "w1", actor: OP });
    const review = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams, ceoCycle: ceo,
    });
    const res = await review.runReview({ objective_id: s.oid, actor: OP });
    expect(res.outcome).toBe("AWAITING_PROGRESS");
    expect(reviews(s)).toHaveLength(1);
  });
});

/* ==================== R1 closure — stale-observation boundaries ====================
 *
 * AUDIT R1 (PR #133): the raw `objective_version` equality pin was
 * removed from the lease/authority staleness predicates because
 * runtime writes — `recordProgress()` KPI evidence and
 * `accountBudget()` spend — legitimately bump `row.version` while
 * leaving protected authority identity (objective_digest, terms,
 * policy binding, owner, business, lifecycle) untouched. Pinning the
 * raw version made a pass's OWN verifier writes self-invalidate the
 * lease (observed live as DRIVER_AUTHORITY_LOST mid-pass).
 *
 * These regressions prove the remaining pin + re-proof surface still
 * fails closed on REAL stale state — every write below goes through
 * the canonical authority service, and every commit path runs the
 * actual production guard:
 *
 *   R1-KPI / R1-BUD — an external canonical writer drifts KPI
 *     progress or budget consumption while a CEO model call is
 *     awaited → the serialized commit re-observes, settles the
 *     attempt STALE, and NEVER commits the decision computed from
 *     the pre-drift observation.
 *   R1-SELF — the pass's own runtime progress write is NOT drift:
 *     the mid-pass authorityGate still holds and settle commits.
 *   R1-AMEND — owner protected-terms amendment mid-pass stays
 *     fail-closed: authorityGate throws DRIVER_AUTHORITY_LOST and
 *     the pass never settles under lost authority.
 *   R1-DISP — drift between review commit and NEW allocation → the
 *     pre-allocation observation re-proof returns bounded WAITING;
 *     no workforce allocation is minted from a stale strategy.
 */
describe("P15.10-C R3 — stale-observation commit boundaries (audit R1)", () => {

  const kpiIdOf = (s: Svc) =>
    String((s.objectives.get(s.oid).kpis as Array<Record<string, unknown>>)[0]!.kpi_id);

  const writeExternalKpi = (s: Svc, tag: string) =>
    s.objectives.recordProgress(s.oid, {
      business_id: s.bid, kpi_id: kpiIdOf(s), value: 4,
      evidence: { evidence_key: `ext-${tag}-${counter++}`, verifier: OWNER, source: "test" },
      actor: OWNER,
    });

  const writeExternalSpend = (s: Svc, tag: string) =>
    s.objectives.accountBudget(s.oid, {
      business_id: s.bid, spend_key: `sp-${tag}-${counter++}`,
      amount_microusd: 100, actor: OWNER,
    });

  it("R1-KPI external KPI write mid-await → attempt settles STALE, decision never commits", async () => {
    const s = freshSvc("r1kpi");
    enable(s);
    const ceo = ceoSvc(s, async (i) => {
      writeExternalKpi(s, "kpi"); // another canonical writer lands mid-await
      return waitResult(i);
    });
    const driver = mkDriver(s, async (input) => {
      await ceo.runCycle({
        objective_id: input.objective_id, actor: input.actor,
        autonomous_commit_guard: input.authority_gate,
      });
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    // The stale decision computed from the pre-drift observation
    // never reached the store; the attempt is durably STALE.
    expect(decisions(s)).toHaveLength(0);
    expect(attempts(s).map((a) => String(a.state))).toEqual(["STALE"]);
  });

  it("R1-BUD external budget write mid-await → attempt settles STALE, decision never commits", async () => {
    const s = freshSvc("r1bud");
    enable(s);
    const ceo = ceoSvc(s, async (i) => {
      writeExternalSpend(s, "b"); // canonical spend lands mid-await
      return waitResult(i);
    });
    const driver = mkDriver(s, async (input) => {
      await ceo.runCycle({
        objective_id: input.objective_id, actor: input.actor,
        autonomous_commit_guard: input.authority_gate,
      });
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    expect(decisions(s)).toHaveLength(0);
    expect(attempts(s).map((a) => String(a.state))).toEqual(["STALE"]);
  });

  it("R1-SELF the pass's own runtime progress write is not drift — gate holds, settle commits", async () => {
    const s = freshSvc("r1self");
    enable(s);
    let gated = false;
    const driver = mkDriver(s, async (input) => {
      // The pass's own verifier-style runtime write: recordProgress
      // bumps objective.version but NOT any protected-terms field.
      writeExternalKpi(s, "self");
      input.authority_gate(); // must NOT throw — authority identity unchanged
      gated = true;
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(gated).toBe(true);
    expect(out.driven[0]).toMatchObject({ outcome: "WAITING", settled: true });
    expect(settleReceipts(s)).toHaveLength(1);
  });

  it("R1-AMEND owner protected-terms amend mid-pass → gate throws DRIVER_AUTHORITY_LOST", async () => {
    const s = freshSvc("r1amend");
    enable(s);
    let gateThrew = false;
    const driver = mkDriver(s, async (input) => {
      s.objectives.amend(s.oid, {
        business_id: s.bid, patch: { title: "drifted title" }, actor: OWNER,
      });
      try {
        input.authority_gate();
      } catch {
        gateThrew = true;
        throw new IntegrityError("FAIL_CLOSED_AMEND", "gate rejected after amend");
      }
      return { outcome: "WAITING", objective_id: input.objective_id };
    });
    const out = await driver.tick();
    expect(gateThrew).toBe(true);
    expect(out.driven[0]!.outcome).toBe("FAULT");
    // Queue never settles under lost authority — claimed generation
    // stays unsettled for a later reclaim.
    expect(settleReceipts(s)).toHaveLength(0);
  });

  it("R1-DISP drift between review commit and allocation → bounded WAITING, no WAL minted", async () => {
    const s = freshSvc("r1disp");
    enable(s);
    const o = s.objectives.get(s.oid);
    s.workstreams.decomposeObjective({
      objective_id: s.oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    // Break the §8 bootstrap path: with zero canonical reviews the
    // pass executes the binding order directly and never consults the
    // review/strategy checkpoint. One committed (WAIT) review forces
    // the §12 review branch on the driven pass below.
    const seedCeo = ceoSvc(s, async (i) => waitResult(i));
    const seedReview = new ObjectiveAdaptiveReviewService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams, ceoCycle: seedCeo,
    });
    await seedReview.runReview({ objective_id: s.oid, actor: OP });
    // The review receipt id is deterministic per (objective,
    // observation digest) — drift the KPI so the driven pass's review
    // commits under a FRESH digest instead of replaying the seed row
    // (a replay would exit early on the strategy re-read, before the
    // observation re-proof this test targets).
    writeExternalKpi(s, "seed-drift");
    const ops = createDefaultObjectiveOperatingService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.objectives, workstreams: s.workstreams,
      invoker: new FakeInvoker(async (i) => ({
        model_entry_id: i.transport.model_entry_id,
        provider_id: i.transport.provider_id,
        model_id: i.transport.model_id,
        raw_text: decisionJson({ decision_kind: "PRIORITIZE_EXISTING",
          wait_reason: null, priority_order: ["w1"], summary: "p" }),
      })),
    });
    const driver = mkDriver(s, async (input) =>
      ops.service.runObjectivePass({
        objective_id: input.objective_id,
        actor: input.actor,
        authority_gate: input.authority_gate,
        hooks: { afterReview: () => writeExternalKpi(s, "disp") },
      }) as never);
    const out = await driver.tick();
    // The committed PRIORITIZE review went stale before the first
    // allocation: bounded WAITING, zero dispatch authority minted.
    // The `detail` proves it is the R3.B observation re-proof (line:
    // "canonical state drifted since review"), not an earlier guard.
    expect(out.driven[0]).toMatchObject({ outcome: "WAITING", settled: true });
    // The durable last_result.detail proves it is the R3.B
    // observation re-proof, not an earlier guard exit.
    const row = readSchedulerRow(s.store, DRIVER_STATE,
      `auto-driver-state:${s.oid}`) as Record<string, unknown>;
    const last = row.last_result as Record<string, unknown>;
    expect(String(last.detail ?? "")).toContain("drifted since review");
    expect(s.store.list(WORKFORCE_ALLOCATION_ENTITY)).toHaveLength(0);
    // Reviews + the PRIORITIZE strategy legitimately committed — it
    // is the dispatch, not the review, that the re-proof blocks:
    // seeded WAIT review + this pass's PRIORITIZE review (fresh
    // observation digest after the seed drift) + one strategy row.
    expect(reviews(s)).toHaveLength(2);
    expect(strategies(s)).toHaveLength(1);
  });
});
