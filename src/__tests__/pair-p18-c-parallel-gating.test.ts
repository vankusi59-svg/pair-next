/**
 * P18-C — parallel admission gating over canonical objective_relation.
 *
 *   C1  DEPENDS_ON unmet → claimable UPSTREAM_UNMET + claim() refuses;
 *       upstream ACHIEVED → admissible.
 *   C2  terminally-failed upstream (CANCELLED) still gates — the block
 *       can never resolve without owner action.
 *   C3  SUSPENDED / REVOKED edges never gate.
 *   C4  CONFLICTS mutual exclusion — partner holds a live lease →
 *       CONFLICT_LEASE_HELD + claim() refuses; partner lease reaped →
 *       admissible.
 *   C5  nextFairCandidate skips a relation-gated candidate and serves
 *       a healthy one; a permanently blocked objective never wedges
 *       the rotation.
 *   C6  strict gate — a corrupt relation row wedges claim()/scan
 *       loudly; a corrupted-but-real edge can never silently clear
 *       admission.
 *   C7  fabricated/unproven edges never gate — a forged DEPENDS_ON
 *       (foreign created_by) cannot DoS admission.
 *   C8  admission-only — a CONFLICTS minted mid-execution does not
 *       retroactively kill a live lease; it gates the NEXT claim.
 *   C9  O(degree) index — a busy global relation table cannot wedge
 *       the per-candidate gate (the F1 availability fix).
 *   C10 index corruption wedges loudly — tampered pointer payloads
 *       and dangling pointers fail closed, never silently clear.
 *   C11 legacy fallback — while the index marker reports un-built,
 *       the gate proves the same verdict via strict global enum.
 *   C12 chunked rebuild — a >INDEX_CHUNK legacy table converges over
 *       calls; `built` must NEVER be marked on a page the chunk cap
 *       cut mid-way (R2-F1: partial index = dropped gates forever).
 *   C13 proof-agnostic pointers — a relation unproven AT REBUILD TIME
 *       (owner amended away) still gets its pointer; when it re-proves
 *       (owner amended back) the gate sees it again (R3-F1: proven-set
 *       drift must never permanently hide a real edge).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  ObjectiveRelationService,
  PairEvidenceStore,
  digest,
  relationDigest,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p18c-gating-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

type Row = Record<string, unknown>;

type Stack = {
  dir: string; store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService; policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler; wakeup: ObjectiveAutoWakeupService;
  relations: ObjectiveRelationService;
  now: () => number; setNow: (v: number) => void;
};

function fresh(name: string, initial = 1_000_000): Stack {
  let t = initial;
  const dir = path.join(ROOT, String(counter++) + "-" + name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  const relations = new ObjectiveRelationService(store);
  return { dir, store, objectives, policy, scheduler, wakeup, relations,
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

/** Enable + wake → a pending-generation claimable objective. */
function claimable(s: Stack, businessId: string) {
  const o = mkObjective(s, businessId);
  enable(s, oid(o));
  s.scheduler.observe(oid(o));
  return oid(o);
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

describe("P18-C — parallel admission gating", () => {

  it("C1 DEPENDS_ON unmet gates claimable+claim; ACHIEVED releases", () => {
    const s = fresh("c1");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    // claimable reports the gate honestly; claim() refuses under the lock.
    const cl = s.scheduler.claimable(a);
    expect(cl.eligible).toBe(false);
    expect(cl.reason).toBe("UPSTREAM_UNMET");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    // The independent upstream is unaffected.
    expect(s.scheduler.claimable(b).eligible).toBe(true);
    // ACHIEVE the upstream → the gate releases.
    s.objectives.transitionStatus(b, { business_id: bid, to: "ACHIEVED", actor: OWNER });
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w1", "b1", "op1").objective_id).toBe(a);
    s.store.close();
  });

  it("C2 terminally-failed upstream still gates", () => {
    const s = fresh("c2");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    s.objectives.transitionStatus(b, { business_id: bid, to: "CANCELLED", actor: OWNER });
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    s.store.close();
  });

  it("C3 SUSPENDED and REVOKED edges never gate", () => {
    const s = fresh("c3");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    const c = claimable(s, bid);
    const r1 = s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    const r2 = s.relations.create({ from_objective_id: a, to_objective_id: c,
      kind: "DEPENDS_ON", actor: OWNER });
    s.relations.control({ relation_id: r1.relation_id, action: "SUSPEND", actor: OWNER });
    s.relations.control({ relation_id: r2.relation_id, action: "REVOKE", actor: OWNER });
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w1", "b1", "op1").objective_id).toBe(a);
    s.store.close();
  });

  it("C4 CONFLICTS mutual exclusion on the live-lease roster", () => {
    const s = fresh("c4");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "CONFLICTS", actor: OWNER });
    // Both free while neither runs.
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    const hb = s.scheduler.claim(b, "w1", "b1", "op1");
    expect(s.scheduler.claimable(a).reason).toBe("CONFLICT_LEASE_HELD");
    expectFail(() => s.scheduler.claim(a, "w2", "b2", "op2"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    // Reverse direction equally — symmetric conflict.
    expect(s.scheduler.claimable(b).eligible).toBe(false); // own lease anyway
    // Partner lease reaped → the gate releases.
    s.setNow(s.now() + 61_000);
    s.scheduler.reconcileLeases();
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w2", "b2", "op2").objective_id).toBe(a);
    void hb;
    s.store.close();
  });

  it("C5 nextFairCandidate skips gated candidates; rotation never wedges", () => {
    const s = fresh("c5");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);  // registers first (lower rank)
    const b = claimable(s, bid);
    const c = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: c,
      kind: "DEPENDS_ON", actor: OWNER });
    // First call closes the cohort boundary (FAIR_ROUND commit) —
    // the registered ranks beyond the first only join the scan set
    // on the next call.
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    // a is upstream-blocked on c; the rotation must pass it to b.
    expect(s.scheduler.nextFairCandidate()).toBe(b);
    expect(s.scheduler.claim(b, "w1", "b1", "op1").objective_id).toBe(b);
    // c is free but a claims nothing — the scan still reaches c.
    expect(s.scheduler.nextFairCandidate()).toBe(c);
    // permanently-blocked a never wedges the loop: null after cohort.
    expect(s.scheduler.nextFairCandidate()).toBeNull();
    s.store.close();
  });

  it("C6 corrupt relation row wedges the strict admission gate loudly", () => {
    const s = fresh("c6");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    // Corrupt the relation's event tail — strict enumeration must
    // propagate (a corrupted-but-real edge can never silently clear
    // a for admission), never degrade to lenient-skip.
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE events SET event_hash=? WHERE entity_type='objective_relation'")
      .run("badhash");
    expectFail(() => s.scheduler.claimable(a), /FAIL_CLOSED_.*HASH_MISMATCH/);
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"), /FAIL_CLOSED_.*HASH_MISMATCH/);
    expectFail(() => s.scheduler.nextFairCandidate(), /FAIL_CLOSED_.*HASH_MISMATCH/);
    s.store.close();
  });

  it("C7 fabricated/unproven edges never gate admission", () => {
    const s = fresh("c7");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    // Plant a self-consistent-hash DEPENDS_ON row claiming a→b but
    // created_by a FOREIGN owner — semantically unproven (dropped on
    // every path, strict included), so it can never gate or DoS.
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const rid = "REL_forged" + counter;
    const payload: Row = {
      schema: "pair.os.vnext.objective-relation.v1",
      relation_id: rid, business_id: bid,
      from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null,
      created_by: "operator:mallory", dedup_key: "fk" + counter,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "objective_relation", entity_id: rid, version: 1,
    };
    payload.relation_digest = relationDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", rid, 1, JSON.stringify(payload),
        digest(payload), "2026-01-01T00:00:00.000Z");
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w1", "b1", "op1").objective_id).toBe(a);
    s.store.close();
  });

  it("C8 admission-only — a mid-execution CONFLICTS mint cannot kill the lease", () => {
    const s = fresh("c8");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    const h = s.scheduler.claim(a, "w1", "b1", "op1");
    // Minting the conflict AFTER a's claim must not retroactively
    // invalidate a's live lease — gating is an admission constraint,
    // not a kill switch. b's claim is gated instead.
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "CONFLICTS", actor: OWNER });
    const lease = s.scheduler.status(a, OWNER).lease as Row;
    expect(String(lease.state)).toBe("ACTIVE");
    expect(s.scheduler.claimable(b).reason).toBe("CONFLICT_LEASE_HELD");
    expectFail(() => s.scheduler.claim(b, "w2", "b2", "op2"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    void h;
    s.store.close();
  });

  it("C9 O(degree) edge index — global relation volume cannot wedge the gate", () => {
    const s = fresh("c9");
    const bid = mkBiz(s.store);
    // A busy relation table: a hub objective with 40 CONFLICTS edges
    // plus a cohort of relation-free claimables. Pre-fix the gate
    // enumerated the WHOLE table per usable candidate (~4 charged
    // reads each × cohort) and wedged the proof budget; the index
    // makes each gate O(degree) — relation-free objectives cost ~2.
    const hub = mkObjective(s, bid);
    for (let i = 0; i < 40; i++) {
      const p = mkObjective(s, bid);
      s.relations.create({ from_objective_id: oid(hub), to_objective_id: oid(p),
        kind: "CONFLICTS", actor: OWNER });
    }
    const candidates = Array.from({ length: 12 }, () => claimable(s, bid));
    // The first create built the index; pointers cover both endpoints.
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const marker = db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation_index_state' AND entity_id='progress'").get() as { payload: string };
    expect(JSON.parse(marker.payload).built).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM entities WHERE entity_type='objective_relation_index'").get() as { c: number }).c).toBe(80);
    // Every relation-free candidate is served — no PROOF_LIMIT wedge.
    s.scheduler.nextFairCandidate(); // cohort-boundary prime
    const served = new Set<string>();
    for (let i = 0; i < candidates.length * 2 && served.size < candidates.length; i++) {
      const c = s.scheduler.nextFairCandidate();
      if (c) served.add(c);
    }
    expect(served).toEqual(new Set(candidates));
    s.store.close();
  });

  it("C10 index corruption wedges loudly; dangling pointer fails closed", () => {
    const s = fresh("c10");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    // A tampered pointer payload is page-level corruption — the strict
    // gate wedges, it cannot silently clear a's admission.
    db.prepare("UPDATE entities SET payload='corrupt' WHERE entity_type='objective_relation_index' AND entity_id LIKE ?")
      .run(`${a}:%`);
    expectFail(() => s.scheduler.claimable(a), "FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"), "FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    // Dangling pointer — delete the relation while b's pointer to it
    // survives: the index naming an unresolvable edge is inconsistency,
    // not an absent edge.
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation'").run();
    expectFail(() => s.scheduler.claimable(b), "FAIL_CLOSED_RELATION_INDEX");
    s.store.close();
  });

  it("C11 un-built index marker → strict global fallback proves the same gate", () => {
    const s = fresh("c11");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = claimable(s, bid);
    s.relations.create({ from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    // Simulate a pre-index store: drop the marker AND the pointers —
    // admissionView falls back to the strict whole-table proof and
    // must reach the SAME verdict (a real edge never escapes).
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index_state'").run();
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index'").run();
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    s.store.close();
  });

  it("C12 chunked rebuild — built only after the COMPLETE set is indexed", () => {
    const s = fresh("c12");
    const bid = mkBiz(s.store);
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // 72 real relations > INDEX_CHUNK(64): the rebuild needs two calls
    // and the second lands on a short page — the exact boundary where
    // a mid-page chunk cut must not mark the index complete.
    const objs: string[] = [];
    for (let i = 0; i < 72; i++) objs.push(oid(mkObjective(s, bid)));
    const x = claimable(s, bid);
    for (let i = 0; i < 71; i++) {
      s.relations.create({ from_objective_id: objs[i]!, to_objective_id: objs[i + 1]!,
        kind: "CONFLICTS", actor: OWNER });
    }
    // A DEPENDS_ON edge — x must stay gated through every index state.
    s.relations.create({ from_objective_id: x, to_objective_id: objs[71]!,
      kind: "DEPENDS_ON", actor: OWNER });
    // Simulate a pre-index store: drop marker + pointers entirely.
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index_state'").run();
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index'").run();
    const markerBuilt = () => {
      const m = db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation_index_state' AND entity_id='progress'")
        .get() as { payload: string } | undefined;
      return m ? JSON.parse(m.payload).built === true : false;
    };
    const idxCount = () => (db.prepare(
      "SELECT COUNT(*) c FROM entities WHERE entity_type='objective_relation_index'").get() as { c: number }).c;
    // Chunk 1: 64 edges → marker NOT built (a short-page cut must not
    // claim completeness — the unprocessed tail would never gate).
    s.store.immediate(() => s.relations.ensureIndex());
    expect(markerBuilt()).toBe(false);
    expect(idxCount()).toBe(128);
    // Chunk 2: the remaining 8 edges on a short page → complete.
    s.store.immediate(() => s.relations.ensureIndex());
    expect(markerBuilt()).toBe(true);
    expect(idxCount()).toBe(144);
    // The indexed tail edge still gates — identical verdict to the
    // global fallback, now at O(degree).
    expect(s.scheduler.claimable(x).reason).toBe("UPSTREAM_UNMET");
    s.store.close();
  });

  it("C13 proof-agnostic pointers — owner flip-flop across rebuild re-gates", () => {
    const s = fresh("c13");
    const bid = mkBiz(s.store);
    const x = claimable(s, bid);
    const y = oid(mkObjective(s, bid));
    s.relations.create({ from_objective_id: x, to_objective_id: y,
      kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Simulate a pre-index store.
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index_state'").run();
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index'").run();
    // Amend x's owner AWAY — the relation drops out of the proven set
    // at rebuild time; the pointer must still be written (a pure
    // table projection, immune to proven-set drift).
    s.objectives.amend(x, { business_id: bid,
      patch: { owner_authority_id: "operator:successor" }, actor: OWNER });
    s.store.immediate(() => s.relations.ensureIndex());
    expect((db.prepare("SELECT COUNT(*) c FROM entities WHERE entity_type='objective_relation_index'")
      .get() as { c: number }).c).toBe(2);
    // While unproven the edge cannot gate — the pointer exists but the
    // relation fails its read-time re-proof.
    expect(s.relations.admissionView(x).upstream).toEqual([]);
    // Amend the owner BACK — the same row re-proves; the index path
    // must see the edge again (pre-fix: skipped at rebuild → hidden
    // from the gate forever).
    s.objectives.amend(x, { business_id: bid,
      patch: { owner_authority_id: OWNER }, actor: "operator:successor" });
    expect(s.relations.admissionView(x).upstream).toEqual([y]);
    s.store.close();
  });

  it("C14 colon-endpoint rows mint no poison pointers into sibling ranges", () => {
    const s = fresh("c14");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = oid(mkObjective(s, bid));
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Raw-SQL relation whose from endpoint is `{a}:evil` — unmintable
    // (provenRow drops colon endpoints), and ensureIndex must not
    // project it: pointer `{a}:evil:{rel}` would land inside `{a}:`'s
    // range and wedge that objective's admissionView permanently.
    const rid = "REL_pois" + counter;
    const payload: Row = {
      schema: "pair.os.vnext.objective-relation.v1",
      relation_id: rid, business_id: bid,
      from_objective_id: `${a}:evil`, to_objective_id: b,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null,
      created_by: OWNER, dedup_key: "pk" + counter,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "objective_relation", entity_id: rid, version: 1,
    };
    payload.relation_digest = relationDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", rid, 1, JSON.stringify(payload),
        digest(payload), "2026-01-01T00:00:00.000Z");
    s.store.immediate(() => s.relations.ensureIndex());
    const ptrs = db.prepare(
      "SELECT entity_id FROM entities WHERE entity_type='objective_relation_index'")
      .all() as Array<{ entity_id: string }>;
    expect(ptrs.some((p) => p.entity_id === `${a}:evil:${rid}`)).toBe(false);
    // The keyable to-endpoint still indexes (dead pointer — the row
    // can never re-prove, so it never gates).
    expect(ptrs.some((p) => p.entity_id === `${b}:${rid}`)).toBe(true);
    // The innocent objective is unaffected: no wedge, no phantom gate.
    expect(s.relations.admissionView(a)).toEqual(
      { upstream: [], conflicts: [], superseded_by: [] });
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    // And a colon endpoint arg fails typed, never silently under-gates.
    expectFail(() => s.relations.admissionView(`${a}:evil`),
      "FAIL_CLOSED_RELATION_FIELDS");
    s.store.close();
  });

  it("C15 astral-keyed edge — index and fallback see the same set", () => {
    const s = fresh("c15");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const b = oid(mkObjective(s, bid));
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // A relation row under an ASTRAL storage key — UTF-8 F0.. sorts
    // above the old \uffff sentinel, so a bounded index range would
    // silently miss it while the global fallback gates on it.
    const rid = "😀REL_" + counter;
    const payload: Row = {
      schema: "pair.os.vnext.objective-relation.v1",
      relation_id: rid, business_id: bid,
      from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null,
      created_by: OWNER, dedup_key: "ak" + counter,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "objective_relation", entity_id: rid, version: 1,
    };
    payload.relation_digest = relationDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", rid, 1, JSON.stringify(payload),
        digest(payload), "2026-01-01T00:00:00.000Z");
    const evBody: Row = {
      event_id: `EVT_${rid}`, entity_type: "objective_relation",
      entity_id: rid, event_type: "OBJECTIVE_RELATION_CREATED",
      old_state: null, new_state: "ACTIVE", actor: OWNER,
      correlation_id: null,
      metadata: { business_id: bid, from_objective_id: a,
        to_objective_id: b, kind: "DEPENDS_ON" },
      created_at: "2026-01-01T00:00:00.000Z",
    };
    db.prepare("INSERT INTO events (event_id, entity_type, entity_id, event_type, old_state, new_state, actor, correlation_id, metadata_json, created_at, event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(evBody.event_id, evBody.entity_type, evBody.entity_id,
        evBody.event_type, evBody.old_state, evBody.new_state,
        evBody.actor, evBody.correlation_id,
        JSON.stringify(evBody.metadata), evBody.created_at, digest(evBody));
    // Rebuild — the astral pointer must exist AND be scannable.
    s.store.immediate(() => s.relations.ensureIndex());
    const ptrs = db.prepare(
      "SELECT entity_id FROM entities WHERE entity_type='objective_relation_index'")
      .all() as Array<{ entity_id: string }>;
    expect(ptrs.some((p) => p.entity_id === `${a}:${rid}`)).toBe(true);
    // Index path sees the edge (pre-fix: upper_id=\uffff excluded it).
    expect(s.relations.admissionView(a).upstream).toEqual([b]);
    // Fallback path — identical verdict.
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index_state'").run();
    expect(s.relations.admissionView(a).upstream).toEqual([b]);
    s.store.close();
  });
});
