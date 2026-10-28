import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  AUTO_POLICY_ENTITY,
  LEASE_STATE,
  OBJECTIVE_SCHEDULER_MODE,
  OPERATING_OUTCOMES,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  PairEvidenceStore,
  WAKE_STATE,
  digest,
  outcomeContinuation,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p1510b-");
const OP = "1882810918";
const OWNER = "operator:" + OP;
const OTHER = "operator:intruder";
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

type Stack = {
  dir: string; dbPath: string; store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService; policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler; wakeup: ObjectiveAutoWakeupService;
  now: () => number; setNow: (v: number) => void;
};

function fresh(name: string, initial = 1_000_000): Stack {
  let t = initial;
  const dir = path.join(ROOT, String(counter++) + "-" + name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  return { dir, dbPath, store, objectives, policy, scheduler, wakeup,
    now: () => t, setNow: (v) => { t = v; } };
}

function reopen(s: Stack): Stack {
  s.store.close();
  const store = new PairEvidenceStore(s.dbPath);
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, s.now);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, s.now);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, s.now);
  return { ...s, store, objectives, policy, scheduler, wakeup };
}

function mkBiz(store: PairEvidenceStore, suffix = ""): string {
  const id = "BIZ_" + counter + suffix;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(s: Stack, businessId: string) {
  return s.objectives.create({
    business_id: businessId, title: "Grow", statement: "g",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
    operator_id: OP, dedup_key: "dk-" + counter + "-" + Math.random(),
  });
}

const oid = (r: unknown) => String((r as { objective_id: string }).objective_id);
const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 4, ...extra });

function configure(s: Stack, objectiveId: string, extra: Record<string, unknown> = {}) {
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "configure", limits: LIMITS(extra), idempotency_key: "cfg-" + counter + "-" + Math.random() });
}

function enable(s: Stack, objectiveId: string, extra: Record<string, unknown> = {}) {
  configure(s, objectiveId, extra);
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "enable", policy_version: 1,
    idempotency_key: "en-" + counter + "-" + Math.random() });
}

function expectFail(fn: () => unknown, code: string | RegExp) {
  try { fn(); } catch (e) {
    const actual = String((e as { code?: string }).code);
    if (code instanceof RegExp) expect(actual).toMatch(code);
    else expect(actual).toBe(code);
    return;
  }
  throw new Error("expected " + String(code) + " but call succeeded");
}

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function rewriteEntity(store: PairEvidenceStore, type: string, id: string) {
  const row = dbOf(store).prepare("SELECT payload FROM entities WHERE entity_type=? AND entity_id=?").get(type, id) as { payload: string };
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  body.tampered = true;
  dbOf(store).prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), type, id);
}

describe("P15.10-B — durable RECONCILE_ONLY scheduler", () => {
  it("B01 default OFF: no consent produces no runnable queue", () => {
    const s = fresh("b01");
    const o = mkObjective(s, mkBiz(s.store));
    const out = s.wakeup.tick();
    expect(out.intake.processed).toBeGreaterThanOrEqual(0);
    expect(s.store.tryGet(WAKE_STATE, oid(o))).toBeFalsy();
    const st = s.scheduler.status(oid(o), OWNER);
    expect(st.scheduler_mode).toBe(OBJECTIVE_SCHEDULER_MODE);
    expect(st.queue_state).toBe("UNREGISTERED");
    expect(st.driver_ready).toBe(false);
    expect(st.consumer_ready).toBe(false);
    expect(s.store.list("mission").length).toBe(0);
  });

  it("B02 canonical wake is durable, restart-visible and deduplicated", () => {
    let s = fresh("b02");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    const before = s.scheduler.status(oid(o), OWNER);
    s.wakeup.intakePage();
    const after = s.scheduler.status(oid(o), OWNER);
    expect(after.pending_generation).toBeGreaterThan(Number(before.pending_generation ?? 0));
    s = reopen(s);
    const reopened = s.scheduler.status(oid(o), OWNER);
    expect(reopened.pending_generation).toBe(after.pending_generation);
    s.wakeup.intakePage();
    expect(s.scheduler.status(oid(o), OWNER).pending_generation).toBe(after.pending_generation);
  });

  it("B03 independent instances cannot co-claim one generation", () => {
    const s = fresh("b03");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const second = new ObjectiveAutoScheduler(s.store, s.objectives, s.policy, s.now);
    const first = s.scheduler.claim(oid(o), "w1", "boot1", "op1");
    expect(first.claimed_generation).toBe(1);
    expectFail(() => second.claim(oid(o), "w2", "boot2", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
  });

  it("B04 expired lease is fenced; stale worker cannot settle", () => {
    const s = fresh("b04");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const old = s.scheduler.claim(oid(o), "w1", "boot1", "op1");
    s.setNow(s.now() + 61_000);
    expect(s.scheduler.reconcileLeases().expired).toBe(1);
    expectFail(() => s.scheduler.settle(old, "WAITING", "old-op"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    const next = s.scheduler.claim(oid(o), "w2", "boot2", "op2");
    expect(next.fence).toBeGreaterThan(old.fence);
  });

  it("B05 crash/restart preserves wake and fenced recovery", () => {
    let s = fresh("b05");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const old = s.scheduler.claim(oid(o), "w1", "boot1", "op1");
    s = reopen(s);
    s.setNow(s.now() + 61_000);
    expect(s.scheduler.status(oid(o), OWNER).claimed_generation).toBe(1);
    s.scheduler.reconcileLeases();
    expectFail(() => s.scheduler.renew(old), "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expect(s.scheduler.claim(oid(o), "w2", "boot2", "op2").claimed_generation).toBe(1);
  });

  it("B06 blocked A does not starve B; two slots claim distinct objectives", () => {
    const s = fresh("b06");
    const bid = mkBiz(s.store);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    configure(s, oid(a));
    enable(s, oid(b));
    s.scheduler.observe(oid(a));
    s.scheduler.observe(oid(b));
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    expect(s.scheduler.nextFairCandidate()).toBe(oid(b));
    const h1 = s.scheduler.claim(oid(b), "w1", "b1", "op1");
    expect(h1.objective_id).toBe(oid(b));
    const c = mkObjective(s, bid);
    enable(s, oid(c));
    s.scheduler.observe(oid(c));
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    expect(s.scheduler.nextFairCandidate()).toBe(oid(c));
    expect(s.scheduler.claim(oid(c), "w2", "b2", "op2").objective_id).toBe(oid(c));
  });

  it("B07 revoke after wake invalidates active lease boundary", () => {
    const s = fresh("b07");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const h = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "revoke",
      policy_version: 2, idempotency_key: "rv-" + counter });
    expectFail(() => s.scheduler.renew(h), "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expectFail(() => s.scheduler.settle(h, "WAITING", "x"), "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
  });

  it("B08 owner-scoped status rejects foreign operator", () => {
    const s = fresh("b08");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    expectFail(() => s.scheduler.status(oid(o), OTHER), /FAIL_CLOSED_POLICY_/);
  });

  it("B09 bounded retry persists across releases and then blocks", () => {
    const s = fresh("b09");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_retries: 1 });
    s.scheduler.observe(oid(o));
    const h1 = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.scheduler.release(h1, "r1");
    s.setNow(s.now() + 31_000);
    const h2 = s.scheduler.claim(oid(o), "w2", "b2", "op2");
    s.scheduler.release(h2, "r2");
    s.setNow(s.now() + 121_000);
    expectFail(() => s.scheduler.claim(oid(o), "w3", "b3", "op3"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expect(s.scheduler.status(oid(o), OWNER).queue_state).toBe("BLOCKED_RETRY_EXHAUSTED");
  });

  it("B10 all operating outcomes map to explicit continuations", () => {
    for (const outcome of OPERATING_OUTCOMES) {
      const c = outcomeContinuation(outcome);
      expect(["WAITING_EVIDENCE", "BLOCKED_AUTHORITY"]).toContain(c.state);
    }
    expectFail(() => outcomeContinuation("NOT_A_REAL_OUTCOME" as never),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
  });

  it("B11 enabled policy still reports no driver while cost is unbound", () => {
    const s = fresh("b11");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    const st = s.scheduler.status(oid(o), OWNER);
    expect(st.driver_ready).toBe(false);
    expect(st.driver_missing).toContain("COST_BINDING_UNVERIFIED");
    expect(st.consumer_ready).toBe(false);
  });

  it("B13 protected-row tamper fails on anchor re-proof", () => {
    const s = fresh("b13");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    rewriteEntity(s.store, WAKE_STATE, oid(o));
    expectFail(() => s.scheduler.status(oid(o), OWNER),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
  });

  it("B14 persisted next_due does not wake before its time", () => {
    const s = fresh("b14");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const h = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.scheduler.settle(h, "WAITING", "settle-wait");
    const before = s.scheduler.status(oid(o), OWNER).pending_generation;
    s.scheduler.markDue(oid(o));
    expect(s.scheduler.status(oid(o), OWNER).pending_generation).toBe(before);
    s.setNow(s.now() + 301_000);
    s.scheduler.markDue(oid(o));
    expect(s.scheduler.status(oid(o), OWNER).pending_generation).toBe(Number(before) + 1);
  });

  it("B15 production boundary is RECONCILE_ONLY with no consumer seam", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/pair/objective-auto-wakeup.ts"), "utf8");
    expect(OBJECTIVE_SCHEDULER_MODE).toBe("RECONCILE_ONLY");
    expect(src.includes("runObjectivePass")).toBe(false);
    expect(src.includes(".claim(")).toBe(false);
    expect(src.includes("MissionRouter")).toBe(false);
    expect(src.includes("Codex")).toBe(false);
    expect(src.includes("Telegram")).toBe(false);
  });

  it("B16 retry budget is scoped to the policy generation — owner re-bind un-wedges via observe()", () => {
    const s = fresh("b16");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_retries: 1 });
    s.scheduler.observe(oid(o));
    // B09 wedge: two released attempts exhaust the bounded retry budget.
    const h1 = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.scheduler.release(h1, "r1");
    s.setNow(s.now() + 31_000);
    const h2 = s.scheduler.claim(oid(o), "w2", "b2", "op2");
    s.scheduler.release(h2, "r2");
    s.setNow(s.now() + 121_000);
    expectFail(() => s.scheduler.claim(oid(o), "w3", "b3", "op3"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expect(s.scheduler.status(oid(o), OWNER).queue_state).toBe("BLOCKED_RETRY_EXHAUSTED");
    const wedgedRetries = Number(s.scheduler.status(oid(o), OWNER).retry_count);
    expect(wedgedRetries).toBeGreaterThan(1);
    // An unchanged binding NEVER resets — a plain observation must not
    // defeat max_retries (B09 semantics preserved).
    s.scheduler.observe(oid(o));
    expect(s.scheduler.status(oid(o), OWNER).queue_state).toBe("BLOCKED_RETRY_EXHAUSTED");
    expectFail(() => s.scheduler.claim(oid(o), "w4", "b4", "op4"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    // Owner-authorized policy transition mints a new policy_version —
    // the existing disable→configure→enable recovery restarts the
    // retry budget at the next rebind.
    const v1 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "disable",
      policy_version: v1, idempotency_key: "d-b16-" + counter });
    const v2 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "configure",
      limits: LIMITS({ max_retries: 1 }), policy_version: v2,
      idempotency_key: "cfg-b16-" + counter });
    const v3 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "enable",
      policy_version: v3, idempotency_key: "en-b16-" + counter });
    s.scheduler.observe(oid(o));
    const st = s.scheduler.status(oid(o), OWNER);
    expect(st.retry_count).toBe(0);
    expect(st.queue_state).toBe("WAITING_CONSUMER");
    // A fresh claim on the new policy generation succeeds.
    const h3 = s.scheduler.claim(oid(o), "w5", "b5", "op5");
    expect(h3).toBeTruthy();
  });

  it("B17 retry epoch reset also flows through the canonical wake intake", () => {
    const s = fresh("b17");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_retries: 1 });
    s.scheduler.observe(oid(o));
    const h1 = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.scheduler.release(h1, "r1");
    s.setNow(s.now() + 31_000);
    const h2 = s.scheduler.claim(oid(o), "w2", "b2", "op2");
    s.scheduler.release(h2, "r2");
    s.setNow(s.now() + 121_000);
    expectFail(() => s.scheduler.claim(oid(o), "w3", "b3", "op3"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expect(s.scheduler.status(oid(o), OWNER).queue_state).toBe("BLOCKED_RETRY_EXHAUSTED");
    // Same owner recovery, driven through wakeup.tick() — the intake
    // accounts the policy-transition wake and the rebind resets the
    // retry budget scoped to the new policy generation.
    const v1 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "disable",
      policy_version: v1, idempotency_key: "d-b17-" + counter });
    const v2 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "configure",
      limits: LIMITS({ max_retries: 1 }), policy_version: v2,
      idempotency_key: "cfg-b17-" + counter });
    const v3 = Number(s.policy.status(oid(o), OWNER).policy_version);
    s.policy.control({ objective_id: oid(o), actor: OWNER, action: "enable",
      policy_version: v3, idempotency_key: "en-b17-" + counter });
    s.wakeup.tick();
    const st = s.scheduler.status(oid(o), OWNER);
    expect(st.retry_count).toBe(0);
    expect(st.queue_state).toBe("WAITING_CONSUMER");
    expect(s.scheduler.claim(oid(o), "w4", "b4", "op4")).toBeTruthy();
  });
});
