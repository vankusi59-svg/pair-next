import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTO_POLICY_ENTITY,
  LEASE_STATE,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  PairEvidenceStore,
  SCHEDULER_COMMIT,
  SCHEDULER_CURSOR,
  SCHEDULER_RECEIPT,
  WAKE_STATE,
  digest,
} from "../pair/index.js";
import { IntegrityError, NotFoundError } from "../pair/errors.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510b-r1-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
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

function mkBiz(store: PairEvidenceStore): string {
  const id = "BIZ_" + counter;
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

function enable(s: Stack, objectiveId: string) {
  s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "configure", limits: { expires_at: FUTURE, max_ceo_calls: 4 },
    idempotency_key: "cfg-" + counter + "-" + Math.random() });
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

function commitEvents(store: PairEvidenceStore): number {
  return store.eventPage({ after_seq: 0, limit: 1024, topics: [SCHEDULER_COMMIT] }).length;
}

describe("P15.10-B R1 — audit remediation", () => {
  it("R1-F1a transient wake fault keeps the event replayable; next tick recovers", () => {
    const s = fresh("f1a");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.intakePage();
    const base = Number(s.scheduler.status(oid(o), OWNER).pending_generation);
    s.store.event({ entity_type: "objective", entity_id: oid(o),
      event_type: "OBJECTIVE_STATUS", actor: OWNER });
    const sched = s.scheduler as unknown as { accountWake: (i: unknown) => unknown };
    const orig = sched.accountWake.bind(s.scheduler);
    sched.accountWake = (input: unknown) => {
      sched.accountWake = orig;
      const e = new Error("database is locked") as Error & { code?: string };
      e.code = "SQLITE_BUSY";
      throw e;
    };
    const first = s.wakeup.intakePage();
    expect(first.processed).toBe(0);
    const second = s.wakeup.intakePage();
    expect(second.processed).toBe(1);
    expect(Number(s.scheduler.status(oid(o), OWNER).pending_generation)).toBe(base + 1);
  });

  it("R1-F1b permanent fault writes a durable blocked receipt; cursor advances once", () => {
    let s = fresh("f1b");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.intakePage();
    const ghost = "obj-ghost-" + counter;
    const evId = s.store.event({ entity_type: "objective", entity_id: ghost,
      event_type: "OBJECTIVE_STATUS", actor: OWNER });
    const res = s.wakeup.intakePage();
    expect(res.blocked).toBe(1);
    const receipt = s.store.tryGet(SCHEDULER_RECEIPT, `intake-blocked:${evId}:${ghost}`);
    expect(receipt).toBeTruthy();
    expect(String(receipt?.source_event_id)).toBe(evId);
    expect(String(receipt?.fault)).toMatch(/^[A-Z0-9_]+$/);
    const again = s.wakeup.intakePage();
    expect(again.blocked).toBe(0);
    s = reopen(s);
    expect(s.store.tryGet(SCHEDULER_RECEIPT, `intake-blocked:${evId}:${ghost}`)).toBeTruthy();
    expect(s.wakeup.intakePage().blocked).toBe(0);
  });

  it("R1-F2 forged cross-objective wake source is rejected at the write seam", () => {
    const s = fresh("f2");
    const bid = mkBiz(s.store);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    enable(s, oid(a));
    enable(s, oid(b));
    const evId = s.store.event({ entity_type: "objective", entity_id: oid(a),
      event_type: "OBJECTIVE_STATUS", actor: OWNER });
    // A's event must never wake B — regardless of claimed binding kind.
    expectFail(() => s.scheduler.accountWake({ objective_id: oid(b),
      source_event_id: evId, reason: "FORGED",
      binding: { kind: "objective" } } as never),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expectFail(() => s.scheduler.accountWake({ objective_id: oid(b),
      source_event_id: evId, reason: "FORGED" } as never),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    expectFail(() => s.scheduler.accountWake({ objective_id: oid(b),
      source_event_id: evId, reason: "FORGED",
      binding: { kind: "work_item", allocation_id: "wal-fake",
        work_item_id: "wi-fake" } } as never),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    // Legitimate direct binding still passes.
    const q = s.scheduler.accountWake({ objective_id: oid(a),
      source_event_id: evId, reason: "STATUS",
      binding: { kind: "objective" } } as never);
    expect(Number(q?.pending_generation ?? 0)).toBeGreaterThan(0);
    const bq = s.scheduler.status(oid(b), OWNER);
    expect(Number(bq.pending_generation)).toBe(0);
  });

  it("R1-F3 fully idle ticks append no scheduler commits", () => {
    const s = fresh("f3");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.tick();
    s.wakeup.tick();
    const before = commitEvents(s.store);
    s.wakeup.tick();
    s.wakeup.tick();
    s.wakeup.tick();
    expect(commitEvents(s.store)).toBe(before);
  });

  it("R1-F4 untrusted exception text never reaches durable state", () => {
    const s = fresh("f4");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.markDegraded(new Error("connect failed apikey=CANARY_F4_SECRET"));
    const cursor = s.store.tryGet(SCHEDULER_CURSOR, "LOCAL_PAIR_DB") as Record<string, unknown>;
    expect(String(cursor.last_error)).not.toContain("CANARY");
    expect(String(cursor.last_error)).toMatch(/^[A-Z0-9_]+$/);
    s.scheduler.quarantine(oid(o), "worker exploded password=CANARY_F4_SECRET");
    const q = s.store.tryGet(WAKE_STATE, oid(o)) as Record<string, unknown>;
    expect(String(q.blocked_reason)).not.toContain("CANARY");
  });

  it("R1-F5 two independent SQLite connections cannot co-hold one lease", () => {
    const s = fresh("race");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const store2 = new PairEvidenceStore(s.dbPath);
    const objectives2 = new ObjectiveAuthorityService(store2);
    const policy2 = new ObjectiveAutoPolicyService(store2, objectives2, s.now);
    const scheduler2 = new ObjectiveAutoScheduler(store2, objectives2, policy2, s.now);
    const h1 = s.scheduler.claim(oid(o), "w1", "boot1", "op1");
    expect(h1.fence).toBe(1);
    expectFail(() => scheduler2.claim(oid(o), "w2", "boot2", "op2"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    const lease = store2.tryGet(LEASE_STATE, oid(o)) as Record<string, unknown>;
    expect(String(lease.state)).toBe("ACTIVE");
    expect(String(lease.worker_id)).toBe("w1");
    store2.close();
  });
});

describe("P15.10-B R2 — F4 security closure", () => {
  it("R2-F4a forged error.code collapses to a fixed label in durable state", () => {
    const s = fresh("r2f4a");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.intakePage();
    // markDegraded cursor path — an attacker-controlled uppercase code that
    // passes the shape regex must never persist verbatim.
    s.wakeup.markDegraded(Object.assign(new Error("x"),
      { code: "FAIL_CLOSED_AKIAIOSFODNN7EXAMPLE" }));
    const cursor = s.store.tryGet(SCHEDULER_CURSOR, "LOCAL_PAIR_DB") as
      Record<string, unknown>;
    expect(String(cursor.last_error)).toBe("UNEXPECTED_FAULT");
    expect(JSON.stringify(cursor)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // intake blocked-receipt path — a permanent fault carrying the forged
    // code must persist a fixed label in the receipt and the queue row.
    const evId = s.store.event({ entity_type: "objective", entity_id: oid(o),
      event_type: "OBJECTIVE_STATUS", actor: OWNER });
    const sched = s.scheduler as unknown as
      { accountWake: (i: unknown) => unknown };
    sched.accountWake = () => {
      throw new IntegrityError("FAIL_CLOSED_AKIAIOSFODNN7EXAMPLE", "x");
    };
    const res = s.wakeup.intakePage();
    expect(res.blocked).toBe(1);
    const receipt = s.store.tryGet(SCHEDULER_RECEIPT,
      `intake-blocked:${evId}:${oid(o)}`) as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    expect(String(receipt.fault)).toBe("INTEGRITY_FAULT");
    expect(JSON.stringify(receipt)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const q = s.store.tryGet(WAKE_STATE, oid(o)) as Record<string, unknown>;
    expect(String(q.queue_state)).toBe("QUARANTINED");
    expect(String(q.blocked_reason)).toBe("INTEGRITY_FAULT");
    expect(JSON.stringify(q)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("R2-F4b uppercase reason cannot bypass sanitizeFaultReason", () => {
    const s = fresh("r2f4b");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.quarantine(oid(o), "SECRET_XYZ_CANARY");
    const q = s.store.tryGet(WAKE_STATE, oid(o)) as Record<string, unknown>;
    expect(String(q.queue_state)).toBe("QUARANTINED");
    expect(String(q.blocked_reason)).not.toContain("SECRET");
    expect(String(q.blocked_reason)).toBe("UNSPECIFIED_FAULT");
  });

  it("R2-F4c legitimate faults keep classification labels; unknown faults never persist raw payloads", () => {
    const s = fresh("r2f4c");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.wakeup.intakePage();
    const lastError = () => String((s.store.tryGet(SCHEDULER_CURSOR,
      "LOCAL_PAIR_DB") as Record<string, unknown>).last_error);
    // SQLite contention → fixed contention label (retry classification is
    // exercised end-to-end by R1-F1a replay, re-run in this same suite).
    s.wakeup.markDegraded(Object.assign(new Error("database is locked"),
      { code: "SQLITE_BUSY" }));
    expect(lastError()).toBe("SQLITE_CONTENTION");
    // Allowlisted canonical read-budget code survives verbatim.
    s.wakeup.markDegraded(
      new IntegrityError("FAIL_CLOSED_READ_BUDGET_SCHEMA", "x"));
    expect(lastError()).toBe("FAIL_CLOSED_READ_BUDGET_SCHEMA");
    // Genuine integrity faults collapse to the fixed integrity label.
    s.wakeup.markDegraded(
      new IntegrityError("FAIL_CLOSED_ENTITY_HASH_MISMATCH", "x"));
    expect(lastError()).toBe("INTEGRITY_FAULT");
    s.wakeup.markDegraded(new NotFoundError("secret=CANARY_F4C"));
    expect(lastError()).toBe("NOT_FOUND");
    // Unknown errors persist the generic label — never raw payloads.
    s.wakeup.markDegraded(new Error("boom apikey=CANARY_F4C"));
    expect(lastError()).toBe("UNEXPECTED_FAULT");
    expect(lastError()).not.toContain("CANARY");
  });
});
