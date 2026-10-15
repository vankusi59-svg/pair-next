import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  PairEvidenceStore,
  MissionControl,
} from "../pair/index.js";
import type { MissionControlDeps } from "../pair/index.js";

/**
 * Hotfix suite — live-ops regressions found in the deployed stack:
 *  H1  eventsSince must page `seq > cursor` in SQL instead of
 *      materializing + hash-verifying the entire events table per call
 *      (the SSE flush path calls it every 400ms per connected client).
 *  H2  nextFairCandidate must not journal a commit per visited
 *      candidate on no-op sweeps — an idle scheduler wrote ~10
 *      hash-chained commits per tick, growing the journal without bound.
 *  H3  repeated no-progress timed waits (WAITING settle with no pending
 *      generation left) must back off instead of re-arming every 300s
 *      forever — the caps-exhausted pass loop spun indefinitely.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-sched-hotfix-"));
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

function mkBiz(store: PairEvidenceStore): string {
  const id = "BIZ_" + counter;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(s: Stack, businessId: string) {
  return s.objectives.create({
    business_id: businessId, title: "Hotfix", statement: "g",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
    operator_id: OP, dedup_key: "dk-" + counter + "-" + Math.random(),
  });
}

const oid = (r: unknown) => String((r as { objective_id: string }).objective_id);

function configure(s: Stack, objectiveId: string) {
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "configure", limits: { expires_at: FUTURE, max_ceo_calls: 4 },
    idempotency_key: "cfg-" + counter + "-" + Math.random() });
}

function enable(s: Stack, objectiveId: string) {
  configure(s, objectiveId);
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "enable", policy_version: 1,
    idempotency_key: "en-" + counter + "-" + Math.random() });
}

function commitCount(store: PairEvidenceStore): number {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  return Number(db.prepare(
    "SELECT COUNT(*) c FROM events WHERE event_type='OBJECTIVE_AUTO_SCHEDULER_COMMIT'",
  ).get().c);
}

describe("H1 — eventsSince bounded read (SSE flush path)", () => {
  function mkControl() {
    const dir = path.join(ROOT, "mc-" + counter++);
    fs.mkdirSync(dir, { recursive: true });
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    // eventsSince only touches deps.service.store — the rest of the
    // control plane is irrelevant to the read path under test.
    const control = new MissionControl(
      { service: { store } } as unknown as MissionControlDeps,
    );
    return { store, control };
  }

  it("pages seq > cursor inside SQL: bounded rows, cursor = last delivered, no regression", () => {
    const { store, control } = mkControl();
    for (let i = 0; i < 30; i++) {
      store.event({ entity_type: "e", entity_id: "x", event_type: "T",
        actor: "t", metadata: { i } });
    }
    const page1 = control.eventsSince(0, 10);
    expect(page1.events).toHaveLength(10);
    expect(Number(page1.events[9]!.seq)).toBe(page1.latest_seq);
    for (const e of page1.events) expect(e).toHaveProperty("event_hash");
    const page2 = control.eventsSince(page1.latest_seq, 10);
    expect(page2.events).toHaveLength(10);
    const page3 = control.eventsSince(page2.latest_seq, 10);
    expect(page3.events).toHaveLength(10);
    const tail = control.eventsSince(page3.latest_seq, 10);
    expect(tail.events).toHaveLength(0);
    expect(tail.latest_seq).toBe(page3.latest_seq);
  });

  it("default call still returns the full delta when under the page bound", () => {
    const { store, control } = mkControl();
    for (let i = 0; i < 5; i++) {
      store.event({ entity_type: "e", entity_id: "y", event_type: "T",
        actor: "t", metadata: null });
    }
    const all = control.eventsSince(0);
    expect(all.events.length).toBe(5);
    expect(all.latest_seq).toBe(Number(all.events[4]!.seq));
  });

  it("hash verification is preserved on the paged read path", () => {
    const { store, control } = mkControl();
    for (let i = 0; i < 4; i++) {
      store.event({ entity_type: "e", entity_id: "z", event_type: "T",
        actor: "t", metadata: { i } });
    }
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE events SET metadata_json='{}' WHERE seq=2").run();
    expect(() => control.eventsSince(0, 10)).toThrow();
  });
});

describe("H2 — idle nextFairCandidate writes no journal commits", () => {
  it("a parked cursor produces zero commits; usable finds keep their receipt", () => {
    const s = fresh("h2");
    const bid = mkBiz(s.store);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    // registered but never usable: configured, not enabled
    configure(s, oid(a));
    configure(s, oid(b));
    s.scheduler.observe(oid(a));
    s.scheduler.observe(oid(b));
    const base = commitCount(s.store);
    s.scheduler.nextFairCandidate();
    s.scheduler.nextFairCandidate();
    s.scheduler.nextFairCandidate();
    // at most ONE commit for the initial cohort-bound refresh; a parked
    // cursor on an unchanged cohort journals nothing
    expect(commitCount(s.store) - base).toBeLessThanOrEqual(1);
    // a candidate that becomes usable still earns its FAIR_VISIT receipt
    const c = mkObjective(s, bid);
    enable(s, oid(c));
    s.scheduler.observe(oid(c));
    const before = commitCount(s.store);
    const first = s.scheduler.nextFairCandidate();
    const second = s.scheduler.nextFairCandidate();
    expect(first === null ? second : first).toBe(oid(c));
    expect(commitCount(s.store) - before).toBeGreaterThanOrEqual(1);
  });
});

describe("H3 — no-progress timed waits back off instead of spinning", () => {
  it("consecutive WAITING settles with no pending work decay via wait_streak", () => {
    const s = fresh("h3");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    const t0 = s.now();
    const h1 = s.scheduler.claim(oid(o), "w1", "b1", "op1");
    s.scheduler.settle(h1, "WAITING", "p1");
    let q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    // first no-progress settle keeps the baseline 300s cadence
    expect(Number(q.next_due)).toBe(t0 + 300_000);
    expect(Number(q.wait_streak ?? 0)).toBe(1);
    // re-arm + reclaim → second consecutive no-progress wait doubles
    s.setNow(t0 + 300_001);
    s.scheduler.markDue(oid(o));
    const h2 = s.scheduler.claim(oid(o), "w2", "b2", "op2");
    const t1 = s.now();
    s.scheduler.settle(h2, "WAITING", "p2");
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(Number(q.next_due)).toBe(t1 + 600_000);
    expect(Number(q.wait_streak)).toBe(2);
    // third consecutive → ×4
    s.setNow(t1 + 600_001);
    s.scheduler.markDue(oid(o));
    const h3 = s.scheduler.claim(oid(o), "w3", "b3", "op3");
    const t2 = s.now();
    s.scheduler.settle(h3, "WAITING", "p3");
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(Number(q.next_due)).toBe(t2 + 1_200_000);
    expect(Number(q.wait_streak)).toBe(3);
    // streak keeps decaying while nothing progresses (×8)
    s.setNow(t2 + 1_200_001);
    s.scheduler.markDue(oid(o));
    const h4 = s.scheduler.claim(oid(o), "w4", "b4", "op4");
    const t3 = s.now();
    s.scheduler.settle(h4, "WAITING", "p4");
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(Number(q.next_due)).toBe(t3 + 2_400_000);
    expect(Number(q.wait_streak)).toBe(4);
    // a non-timed outcome resets the streak and parks (no re-arm)
    s.setNow(t3 + 2_400_001);
    s.scheduler.markDue(oid(o));
    const h5 = s.scheduler.claim(oid(o), "w5", "b5", "op5");
    s.scheduler.settle(h5, "OBJECTIVE_BUDGET_EXHAUSTED", "p5");
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(q.queue_state).toBe("BLOCKED_AUTHORITY");
    expect(q.next_due).toBeNull();
    expect(Number(q.wait_streak)).toBe(0);
  });
});

describe("H4 — fresh canonical wake clears stale backoff (R1-F1)", () => {
  it("a genuinely new observation resets next_due/wait_streak so fresh work is claimable now", () => {
    const s = fresh("h4");
    const bid = mkBiz(s.store);
    const o = mkObjective(s, bid);
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    // park the objective in WAITING_EVIDENCE carrying a stale streak
    const t0 = s.now();
    const h1 = s.scheduler.claim(oid(o), "w1", "b1", "h4-p1");
    s.scheduler.settle(h1, "WAITING", "h4-p1");
    s.setNow(t0 + 300_001);
    s.scheduler.markDue(oid(o));
    const h2 = s.scheduler.claim(oid(o), "w2", "b2", "h4-p2");
    const t1 = s.now();
    s.scheduler.settle(h2, "WAITING", "h4-p2");
    let q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(Number(q.wait_streak)).toBe(2);
    expect(Number(q.next_due)).toBe(t1 + 600_000);
    // a no-op observation must NOT touch the parked wait state
    s.scheduler.observe(oid(o));
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(Number(q.wait_streak)).toBe(2);
    expect(Number(q.next_due)).toBe(t1 + 600_000);
    expect(s.scheduler.nextFairCandidate()).toBeNull(); // NOT_DUE_YET while parked
    // owner-attached runtime evidence bumps objective_version without
    // touching protected terms → policy stays effective, but observe()
    // sees a genuinely new observation → new pending work must not
    // inherit the stale deadline/streak
    s.objectives.attachEvidence(oid(o), { business_id: bid,
      evidence: { evidence_key: "r1f1-ev", verifier: OWNER,
        source: "ops-note" },
      note: "fresh evidence", actor: OWNER });
    const pendingBefore = Number(q.pending_generation);
    s.scheduler.observe(oid(o));
    q = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    expect(q.queue_state).toBe("WAITING_CONSUMER");
    expect(Number(q.pending_generation)).toBe(pendingBefore + 1);
    expect(q.next_due).toBeNull();
    expect(Number(q.wait_streak)).toBe(0);
    // immediately discoverable — not held back by the stale checkpoint
    expect(s.scheduler.nextFairCandidate()).toBe(oid(o));
  });
});

describe("H5 — full-page idle cohorts converge to silence (R1-F2)", () => {
  for (const n of [64, 65, 128]) {
    it(`cohort ${n}: repeated unchanged sweeps stop journaling once fully scanned`, () => {
      const s = fresh("h5-" + n);
      const bid = mkBiz(s.store);
      for (let i = 0; i < n; i++) {
        const o = mkObjective(s, bid);
        configure(s, oid(o)); // registered, never usable
        s.scheduler.observe(oid(o));
      }
      // warm-up: bound refresh + first full sweep may commit at most once
      s.scheduler.nextFairCandidate();
      s.scheduler.nextFairCandidate();
      const base = commitCount(s.store);
      for (let i = 0; i < 4; i++) {
        expect(s.scheduler.nextFairCandidate()).toBeNull();
      }
      expect(commitCount(s.store) - base).toBe(0);
      // newly usable work must still be discovered (bound refresh, then hit)
      const o = mkObjective(s, bid);
      enable(s, oid(o));
      s.scheduler.observe(oid(o));
      let found: string | null = null;
      for (let i = 0; i < 3 && !found; i++) {
        found = s.scheduler.nextFairCandidate();
      }
      expect(found).toBe(oid(o));
    });
  }
});

describe("H6 — large unchanged cohorts converge regardless of size (R2-F1)", () => {
  for (const n of [192, 193, 256, 384]) {
    it(`cohort ${n}: completed no-op sweeps reach durable idle silence`, () => {
      const s = fresh("h6-" + n);
      const bid = mkBiz(s.store);
      for (let i = 0; i < n; i++) {
        const o = mkObjective(s, bid);
        configure(s, oid(o)); // registered, never usable
        s.scheduler.observe(oid(o));
      }
      // warm-up: bound refresh + wrap may commit; then unchanged sweeps
      // must produce zero commits at any cohort size
      s.scheduler.nextFairCandidate();
      s.scheduler.nextFairCandidate();
      const base = commitCount(s.store);
      for (let i = 0; i < 4; i++) {
        expect(s.scheduler.nextFairCandidate()).toBeNull();
      }
      expect(commitCount(s.store) - base).toBe(0);
      // a newly usable candidate deep inside the cohort is still found
      const o = mkObjective(s, bid);
      enable(s, oid(o));
      s.scheduler.observe(oid(o));
      let found: string | null = null;
      for (let i = 0; i < 3 && !found; i++) {
        found = s.scheduler.nextFairCandidate();
      }
      expect(found).toBe(oid(o));
    }, 30000);
  }
});

describe("H7 — tampered protected rows are detected, never silently hidden (R3-F1)", () => {
  // durable fault evidence is a hash-chained scheduler receipt keyed by
  // the corrupted protected row
  function faultReceipt(store: PairEvidenceStore, entityType: string, entityId: string) {
    return store.tryGet("objective_auto_receipt",
      `integrity_fault:${entityType}:${entityId}`) as
      Record<string, unknown> | null;
  }

  it("a queue row tampered (valid hash, no commit) into a filtered-out state is faulted, not hidden", () => {
    const s = fresh("h7a");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    // canonical put recomputes the entity hash but never writes the
    // protected scheduler commit — the SQL filter now excludes the row
    const row = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    s.store.put("objective_auto_state", oid(o),
      { ...row, queue_state: "WAITING_EVIDENCE" }, Number(row.version));
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    const r = faultReceipt(s.store, "objective_auto_state", oid(o));
    expect(r).toBeTruthy();
    expect(String(r!.operation)).toBe("INTEGRITY_FAULT");
  });

  it("a forged ACTIVE lease suppressing an actionable objective is faulted, not hidden", () => {
    const s = fresh("h7b");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    // forged lease via canonical put: ACTIVE + future expiry — the SQL
    // NOT EXISTS exclusion hides the objective behind it
    s.store.put("objective_auto_lease", oid(o), {
      objective_id: oid(o), state: "ACTIVE", fence: 1,
      worker_id: "forged", boot_id: "forged", token_hash: "f".repeat(64),
      expires_at: s.now() + 600_000, claimed_generation: 1,
      checkpoint_digest: "x", started_at: s.now(), renewed_at: s.now(),
      policy_version: 1, terms_digest: "x", owner_authority_id: OWNER,
      objective_version: 1, max_lifetime_ms: 300_000,
    }, 0);
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    expect(faultReceipt(s.store, "objective_auto_lease", oid(o))).toBeTruthy();
  });

  it("a usable-looking row with a divergent commit ledger is faulted and skipped, not claimed", () => {
    const s = fresh("h7c");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    s.scheduler.observe(oid(o));
    // bump pending_generation via canonical put — stays SQL-actionable,
    // but commits < version: the shortlist re-proof must catch it
    const row = s.store.tryGet("objective_auto_state", oid(o)) as Record<string, unknown>;
    s.store.put("objective_auto_state", oid(o),
      { ...row, pending_generation: Number(row.pending_generation) + 1 },
      Number(row.version));
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    expect(faultReceipt(s.store, "objective_auto_state", oid(o))).toBeTruthy();
    // and the corrupted row must never become claimable
    expect(() => s.scheduler.claim(oid(o), "w", "b", "h7c")).toThrow();
  });

  it("a clean large cohort stays silent — the sweep journals nothing when nothing is wrong", () => {
    const s = fresh("h7d");
    const bid = mkBiz(s.store);
    for (let i = 0; i < 64; i++) {
      const o = mkObjective(s, bid);
      configure(s, oid(o));
      s.scheduler.observe(oid(o));
    }
    s.scheduler.nextFairCandidate();
    s.scheduler.nextFairCandidate();
    const base = commitCount(s.store);
    for (let i = 0; i < 4; i++) expect(s.scheduler.nextFairCandidate()).toBeNull();
    expect(commitCount(s.store) - base).toBe(0);
  });
});

describe("H8 — sweep quota separation + corrupt-page traversal (R4-F1/F2)", () => {
  const STATE = "objective_auto_state";
  function faultReceipt(store: PairEvidenceStore, entityType: string, entityId: string) {
    return store.tryGet("objective_auto_receipt",
      `integrity_fault:${entityType}:${entityId}`) as
      Record<string, unknown> | null;
  }
  /** raw payload drift: valid row shape, stale payload_hash, ledger clean —
   *  only the charged deep-verify tier can see it */
  function hashDrift(s: Stack, objectiveId: string) {
    const row = s.store.tryGet(STATE, objectiveId) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...row, wait_streak: 97 });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE entities SET payload=? WHERE entity_type=? AND entity_id=?")
      .run(tampered, STATE, objectiveId);
  }
  /** canonical-put corruption: valid hash, missing scheduler commit */
  function putCorrupt(s: Stack, objectiveId: string) {
    const row = s.store.tryGet(STATE, objectiveId) as Record<string, unknown>;
    s.store.put(STATE, objectiveId,
      { ...row, queue_state: "WAITING_EVIDENCE" }, Number(row.version));
  }

  it("clean rows at ledger versions 1,2,3 never earn fault receipts and journal nothing", () => {
    const s = fresh("h8-clean");
    const bid = mkBiz(s.store);
    // v2 queue row (register+observe), a v1 ACTIVE lease via claim, a v1
    // claim receipt — a mixed-version clean protected set
    const a = mkObjective(s, bid); configure(s, oid(a)); s.scheduler.observe(oid(a));
    const b = mkObjective(s, bid); enable(s, oid(b)); s.scheduler.observe(oid(b));
    const h = s.scheduler.claim(oid(b), "w", "b", "h8-clean");
    s.scheduler.settle(h, "WAITING", "h8-clean-p1"); // fully parked
    s.scheduler.nextFairCandidate(); // absorb the one-time cohort-bound refresh
    const base = commitCount(s.store);
    for (let i = 0; i < 3; i++) s.scheduler.nextFairCandidate();
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const faults = db.prepare(
      `SELECT COUNT(*) c FROM events WHERE event_type='OBJECTIVE_AUTO_SCHEDULER_COMMIT'
        AND json_extract(metadata_json,'$.operation')='INTEGRITY_FAULT'`).get() as { c: number };
    expect(faults.c).toBe(0);
    expect(commitCount(s.store) - base).toBe(0);
  });

  for (const n of [16, 17, 32, 64]) {
    it(`cohort ${n}: rotating deep-verify reaches drift despite persistent suspects`, () => {
      const s = fresh("h8-" + n);
      const bid = mkBiz(s.store);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const o = mkObjective(s, bid);
        configure(s, oid(o));
        s.scheduler.observe(oid(o));
        ids.push(oid(o)); // entity insertion order == creation order
      }
      // persistent tier-1 suspects occupy the EARLIEST positions (valid
      // hash, missing commit — the screen must confirm them once, then
      // never let them re-consume the quota)
      const suspects = ids.slice(0, Math.min(16, n - 1));
      for (const id of suspects) putCorrupt(s, id);
      // hash-drift the LAST-created row — ledger stays clean, only the
      // rotating deep-verify tier can see the payload-hash mismatch
      const driftId = ids[ids.length - 1]!;
      hashDrift(s, driftId);
      let calls = 0;
      while (calls < 10 && !faultReceipt(s.store, STATE, driftId)) {
        s.scheduler.nextFairCandidate();
        calls++;
      }
      expect(faultReceipt(s.store, STATE, driftId)).toBeTruthy();
      // bound: suspects confirm in ~1 call; tier-2 reaches any keyset
      // position within ceil(protected_rows/16) idle calls
      expect(calls).toBeLessThanOrEqual(Math.ceil(n / 16) + 2);
      // suspects already receipted: later calls journal nothing for them
      s.scheduler.nextFairCandidate();
      const mid = commitCount(s.store);
      s.scheduler.nextFairCandidate();
      s.scheduler.nextFairCandidate();
      expect(commitCount(s.store) - mid).toBe(0);
    }, 30000);
  }

  it("64 corrupt shortlisted queues cannot starve the healthy objective at rank 65", () => {
    const s = fresh("h8-page");
    const bid = mkBiz(s.store);
    const ids: string[] = [];
    for (let i = 0; i < 65; i++) {
      const o = mkObjective(s, bid);
      enable(s, oid(o));
      s.scheduler.observe(oid(o));
      ids.push(oid(o));
    }
    // corrupt ranks 1..64 (creation order == registration order), keeping
    // the payload still SQL-actionable so all 64 stay shortlisted
    for (const id of ids.slice(0, 64)) {
      const row = s.store.tryGet(STATE, id) as Record<string, unknown>;
      s.store.put(STATE, id, { ...row }, Number(row.version)); // v+1, no commit
    }
    const healthy = ids[64]!;
    // call 1 refreshes the cohort bound (registrations past it enter on a
    // FAIR_ROUND) — call 2 must traverse the corrupt page and reach rank 65
    s.scheduler.nextFairCandidate();
    expect(s.scheduler.nextFairCandidate()).toBe(healthy);
  });
});

describe("H9 — corruption bursts stay inside the proof budget (R5-F1)", () => {
  const STATE = "objective_auto_state";
  const RECEIPT = "objective_auto_receipt";
  function faultRow(store: PairEvidenceStore, entityId: string) {
    return store.tryGet(RECEIPT, `integrity_fault:${STATE}:${entityId}`) as
      Record<string, unknown> | null;
  }

  for (const n of [80, 96, 128]) {
    it(`burst ${n}: exclusions commit in bounded chunks; healthy candidate reached`, () => {
      const s = fresh("h9-" + n);
      const bid = mkBiz(s.store);
      const ids: string[] = [];
      for (let i = 0; i < n + 1; i++) {
        const o = mkObjective(s, bid); enable(s, oid(o)); s.scheduler.observe(oid(o));
        ids.push(oid(o));
      }
      // divergent ledger (valid hash, missing commit) but payload still
      // SQL-actionable — all n stay shortlisted and must be faulted
      for (const id of ids.slice(0, n)) {
        const row = s.store.tryGet(STATE, id) as Record<string, unknown>;
        s.store.put(STATE, id, { ...row }, Number(row.version));
      }
      const healthy = ids[n]!;
      s.scheduler.nextFairCandidate(); // cohort-bound refresh commits once
      let picked: string | null = null;
      let calls = 0;
      while (picked !== healthy && calls < 24) {
        picked = s.scheduler.nextFairCandidate(); // must never throw budget errors
        calls++;
      }
      expect(picked).toBe(healthy);
      // every corrupt row earned exactly one durable receipt (dedup'd)
      for (const id of ids.slice(0, n)) {
        expect(faultRow(s.store, id)?.version).toBe(1);
      }
      // durable exclusion — exactly n entity keys quarantined, nothing extra
      const f = s.store.tryGet("objective_auto_fairness", "LOCAL_PAIR_DB") as
        Record<string, unknown>;
      expect((f.faulted_ids as string[]).length).toBe(n);
    }, 30000);
  }
});
