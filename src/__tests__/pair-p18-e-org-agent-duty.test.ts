/**
 * P18-E — canonical org_agent_duty (agent's declared objective coverage).
 *
 *   E1  mint spanning duty → digest/event/index pointers; proven reads.
 *   E2  N-lateral authority — foreign owner refused; owner amend on ANY
 *       covered objective unproves the duty.
 *   E3  cross-business objective set refused at mint.
 *   E4  agent outside the derived business refused at mint.
 *   E5  lifecycle SUSPEND/RESUME/REVOKE — only ACTIVE covers.
 *   E6  idempotent mint (same agent+set), REVOKED frees remint.
 *   E7  forged duty (valid hash, foreign created_by) → unproven;
 *       corrupt row wedges strict writes, drops on lenient reads.
 *   E8  union-of-duties is NOT coverage — {A}+{B} never covers {A,B}.
 *   E9  index path vs strict global fallback — identical answers.
 *   E10 dangling/mis-bound index pointers wedge FAIL_CLOSED_DUTY_INDEX.
 *   E11 unsorted/duplicate objective_ids in a stored row → unproven.
 *   E12 REVOKED duty still enumerated but never covers.
 *   E13 colon endpoint ids are unkeyable — rejected at mint, reads
 *       and provenRow (a colon-agent row can never wedge a prefix
 *       sibling; R1-F1).
 *   E14 corrupt index marker → lenient reads fall back to the strict
 *       global enumeration and still serve; strict writes wedge on
 *       the marker CAS (R1-F2).
 *   E15 corrupt INDEX pointer row → lenient reads isolate+skip and
 *       serve siblings; strict writes propagate (R1-F3 parity).
 *   E16 non-array covers() input returns false — no raw TypeError
 *       (R1-F6); INDEX_CHUNK boundary — marker builds only after the
 *       complete bound set is indexed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  digest,
  dutyDigest,
  IntegrityError,
  OrgAgentDutyService,
  PairEvidenceStore,
  ObjectiveAuthorityService,
  utcnow,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p18e-duty-");
let n = 0;
const OP = "op:test";
const OWNER = `operator:${OP}`;

function mkCtx() {
  const d = path.join(ROOT, `${n++}`);
  fs.mkdirSync(d, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const duties = new OrgAgentDutyService(store);
  const objectives = new ObjectiveAuthorityService(store);
  return { d, store, duties, objectives };
}

function mkObjective(store: PairEvidenceStore, businessId: string, owner = OWNER) {
  const svc = new ObjectiveAuthorityService(store);
  const obj = svc.create({
    business_id: businessId,
    title: "obj", statement: "grow",
    kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: [], success_conditions: ["done"],
    dedup_key: `dk-${Math.random().toString(36).slice(2)}`,
    operator_id: owner.replace(/^operator:/, ""),
  });
  return String(obj.objective_id);
}

function mkBusiness(store: PairEvidenceStore) {
  const id = `BIZ_${n}_${Math.random().toString(36).slice(2, 8)}`;
  store.put("business", id, {
    business_id: id, name: "biz", status: "ACTIVE",
    currency: "USD", project_id: "PRJ_x",
    created_at: utcnow(), version: 0,
  }, 0);
  return id;
}

function mkAgent(store: PairEvidenceStore, businessId: string) {
  const id = `AGT_${n}_${Math.random().toString(36).slice(2, 8)}`;
  store.put("org_agent", id, {
    agent_id: id, business_id: businessId, title: "a",
    department: "ops", role: "", reports_to: null,
    executor_binding: null, capabilities: [],
    status: "ACTIVE", context_notes: [],
    created_at: utcnow(), version: 0,
  }, 0);
  return id;
}

function mkScope(store: PairEvidenceStore, opts?: { twoObjectives?: boolean }) {
  const businessId = mkBusiness(store);
  const agent = mkAgent(store, businessId);
  const objA = mkObjective(store, businessId);
  const objB = opts?.twoObjectives === false ? objA : mkObjective(store, businessId);
  return { businessId, agent, objA, objB };
}

const expectFail = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) {
    expect((e as IntegrityError).code ?? String(e)).toContain(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("P18-E — org-agent duties spanning objectives", () => {

  it("E1 mint spanning duty + proven reads + index pointers", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objB, objA], actor: OWNER,
    });
    expect(d.state).toBe("ACTIVE");
    expect(d.objective_ids).toEqual([objA, objB].sort());
    expect(d.business_id).toBeTruthy();
    expect(String(d.duty_digest)).toBe(dutyDigest(d));
    // proven reads
    expect(duties.dutiesForObjective(objA).map((x) => x.duty_id)).toEqual([d.duty_id]);
    expect(duties.dutiesForObjective(objB).map((x) => x.duty_id)).toEqual([d.duty_id]);
    expect(duties.dutiesForAgent(agent).map((x) => x.duty_id)).toEqual([d.duty_id]);
    expect(duties.covers(agent, [objA])).toBe(true);
    expect(duties.covers(agent, [objA, objB])).toBe(true);
    expect(duties.covers(agent, [])).toBe(false);
    store.close();
  });

  it("E2 N-lateral authority — foreign owner refused; amend unproves", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB, businessId } = mkScope(store);
    // objC owned by a different operator — actor cannot span it.
    const svc = new ObjectiveAuthorityService(store);
    const objC = String(svc.create({
      business_id: businessId, title: "o", statement: "s",
      kpis: [{ name: "k", unit: "count", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 1, hard_constraints: [],
      success_conditions: ["d"], dedup_key: `dk-c-${n}`,
      operator_id: "other",
    }).objective_id);
    expectFail(() => duties.create({
      org_agent_id: agent, objective_ids: [objA, objC], actor: OWNER,
    }), "FAIL_CLOSED_DUTY_AUTHORITY");
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER,
    });
    expect(duties.covers(agent, [objA, objB])).toBe(true);
    // Owner amend on ONE covered objective → whole duty unproven.
    svc.amend(objB, {
      business_id: businessId,
      patch: { owner_authority_id: "operator:successor" },
      actor: OWNER,
    });
    expect(duties.dutiesForAgent(agent)).toHaveLength(0);
    expect(duties.covers(agent, [objA])).toBe(false);
    void d;
    store.close();
  });

  it("E3 cross-business objective set refused at mint", () => {
    const { store, duties } = mkCtx();
    const { agent, objA } = mkScope(store);
    const biz2 = mkBusiness(store);
    const objX = mkObjective(store, biz2); // same owner ref, foreign business
    expectFail(() => duties.create({
      org_agent_id: agent, objective_ids: [objA, objX], actor: OWNER,
    }), "FAIL_CLOSED_DUTY_BUSINESS");
    store.close();
  });

  it("E4 agent outside the derived business refused at mint", () => {
    const { store, duties } = mkCtx();
    const { objA } = mkScope(store);
    const biz2 = mkBusiness(store);
    const foreign = mkAgent(store, biz2);
    expectFail(() => duties.create({
      org_agent_id: foreign, objective_ids: [objA], actor: OWNER,
    }), "FAIL_CLOSED_DUTY_BUSINESS");
    store.close();
  });

  it("E5 lifecycle — SUSPEND/RESUME/REVOKE; only ACTIVE covers", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER,
    });
    expect(duties.covers(agent, [objA, objB])).toBe(true);
    duties.control({ duty_id: d.duty_id, action: "SUSPEND", actor: OWNER });
    expect(duties.dutiesForAgent(agent)[0]!.state).toBe("SUSPENDED");
    expect(duties.covers(agent, [objA])).toBe(false);
    duties.control({ duty_id: d.duty_id, action: "RESUME", actor: OWNER });
    expect(duties.covers(agent, [objA, objB])).toBe(true);
    duties.control({ duty_id: d.duty_id, action: "REVOKE", actor: OWNER });
    expect(duties.covers(agent, [objA])).toBe(false);
    // REVOKE is terminal idempotent; illegal hops fail.
    duties.control({ duty_id: d.duty_id, action: "REVOKE", actor: OWNER });
    expectFail(() => duties.control({
      duty_id: d.duty_id, action: "RESUME", actor: OWNER,
    }), "FAIL_CLOSED_DUTY");
    // Foreign actor cannot control even a valid transition.
    expectFail(() => duties.control({
      duty_id: d.duty_id, action: "SUSPEND", actor: "operator:mallory",
    }), "FAIL_CLOSED_DUTY");
    store.close();
  });

  it("E6 idempotent mint; REVOKED frees remint", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const a = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    const b = duties.create({
      org_agent_id: agent, objective_ids: [objB, objA], actor: OWNER });
    expect(b.duty_id).toBe(a.duty_id);
    duties.control({ duty_id: a.duty_id, action: "REVOKE", actor: OWNER });
    const c = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    expect(c.duty_id).not.toBe(a.duty_id);
    store.close();
  });

  it("E7 forged duty unproven; corrupt row wedges strict, drops lenient", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB, businessId } = mkScope(store);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    // Raw-SQL forge: valid shape/hash but created_by is not the owner.
    const rid = `DUT_forge_${n}`;
    const payload: Record<string, unknown> = {
      schema: "pair.os.vnext.org-agent-duty.v1",
      duty_id: rid, business_id: businessId, org_agent_id: agent,
      objective_ids: [objA], state: "ACTIVE", note: null,
      created_by: "operator:mallory", dedup_key: `fk${n}`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "org_agent_duty", entity_id: rid, version: 1,
    };
    payload.duty_digest = dutyDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org_agent_duty", rid, 1, JSON.stringify(payload), digest(payload),
        "2026-01-01T00:00:00.000Z");
    expect(duties.dutiesForObjective(objA)).toHaveLength(0);
    // Legit duty, then corrupt its row bytes — lenient read drops it,
    // a strict write (mint) must wedge, never silently dedup-miss.
    const real = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    db.prepare("UPDATE entities SET payload='corrupt' WHERE entity_type='org_agent_duty' AND entity_id=?")
      .run(real.duty_id);
    expect(duties.dutiesForObjective(objA)).toHaveLength(0);
    expectFail(() => duties.create({
      org_agent_id: agent, objective_ids: [objA], actor: OWNER,
    }), "FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    store.close();
  });

  it("E8 union-of-duties is NOT coverage", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    duties.create({ org_agent_id: agent, objective_ids: [objA], actor: OWNER });
    duties.create({ org_agent_id: agent, objective_ids: [objB], actor: OWNER });
    expect(duties.covers(agent, [objA])).toBe(true);
    expect(duties.covers(agent, [objA, objB])).toBe(false); // no single mandate
    const span = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    expect(duties.coveringDuties(agent, [objA, objB])
      .map((d) => d.duty_id)).toEqual([span.duty_id]);
    store.close();
  });

  it("E9 index path vs strict global fallback — identical answers", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    duties.ensureIndex();
    const underIndex = duties.dutiesForObjective(objA).map((x) => x.duty_id);
    expect(underIndex).toEqual([d.duty_id]);
    db.prepare("DELETE FROM entities WHERE entity_type='org_agent_duty_index_state'").run();
    const underFallback = duties.dutiesForObjective(objA).map((x) => x.duty_id);
    expect(underFallback).toEqual(underIndex);
    const agentsIdx = duties.dutiesForAgent(agent).map((x) => x.duty_id);
    db.prepare("DELETE FROM entities WHERE entity_type='org_agent_duty_index_state'").run();
    expect(duties.dutiesForAgent(agent).map((x) => x.duty_id)).toEqual(agentsIdx);
    store.close();
  });

  it("E10 dangling and mis-bound index pointers wedge", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    duties.ensureIndex();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    // Planted pointer under the objective's prefix naming a duty that
    // does not exist — dangling.
    const pKey = `O:${objA}:DUT_ghost_${n}`;
    store.put("org_agent_duty_index", pKey, {
      pointer_kind: "O", objective_id: objA, agent_id: null,
      duty_id: `DUT_ghost_${n}`, created_at: utcnow(),
    }, 0);
    expectFail(() => duties.dutiesForObjective(objA), "FAIL_CLOSED_DUTY_INDEX");
    db.prepare("DELETE FROM entities WHERE entity_type='org_agent_duty_index' AND entity_id=?")
      .run(pKey);
    // Mis-bound pointer: names a real duty the objective isn't covered by.
    const { store: s2 } = { store };
    void s2;
    const other = duties.create({
      org_agent_id: agent, objective_ids: [objB], actor: OWNER });
    const misKey = `O:${objA}:${other.duty_id}`;
    store.put("org_agent_duty_index", misKey, {
      pointer_kind: "O", objective_id: objA, agent_id: null,
      duty_id: other.duty_id, created_at: utcnow(),
    }, 0);
    expectFail(() => duties.dutiesForObjective(objA), "FAIL_CLOSED_DUTY_INDEX");
    store.close();
  });

  it("E11 unsorted/duplicated objective_ids in a stored row → unproven", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB, businessId } = mkScope(store);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const rid = `DUT_unsort_${n}`;
    const payload: Record<string, unknown> = {
      schema: "pair.os.vnext.org-agent-duty.v1",
      duty_id: rid, business_id: businessId, org_agent_id: agent,
      objective_ids: [objB, objA], // unsorted — never a minted shape
      state: "ACTIVE", note: null,
      created_by: OWNER, dedup_key: `dk${n}`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "org_agent_duty", entity_id: rid, version: 1,
    };
    payload.duty_digest = dutyDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org_agent_duty", rid, 1, JSON.stringify(payload), digest(payload),
        "2026-01-01T00:00:00.000Z");
    expect(duties.dutiesForObjective(objA)).toHaveLength(0);
    store.close();
  });

  it("E12 REVOKED duty enumerated but never covers", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER });
    duties.control({ duty_id: d.duty_id, action: "REVOKE", actor: OWNER });
    const listed = duties.dutiesForAgent(agent);
    expect(listed.map((x) => x.duty_id)).toEqual([d.duty_id]);
    expect(listed[0]!.state).toBe("REVOKED");
    expect(duties.coveringDuties(agent, [objA])).toHaveLength(0);
    store.close();
  });

  it("E13 colon endpoint ids are unkeyable — boundary rejects", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, businessId } = mkScope(store);
    // A colon-id org_agent can exist as a raw row — the duty boundary
    // must refuse to key it (its pointers would land inside another
    // endpoint's prefix range and wedge that endpoint forever).
    const colonAgent = mkAgent(store, businessId).replace("AGT_", "a:b_");
    store.put("org_agent", colonAgent, {
      agent_id: colonAgent, business_id: businessId, title: "c",
      department: "ops", role: "", reports_to: null,
      executor_binding: null, capabilities: [],
      status: "ACTIVE", context_notes: [],
      created_at: utcnow(), version: 0,
    }, 0);
    expectFail(() => duties.create({
      org_agent_id: colonAgent, objective_ids: [objA], actor: OWNER,
    }), "FAIL_CLOSED_DUTY_FIELDS");
    expectFail(() => duties.dutiesForAgent(colonAgent),
      "FAIL_CLOSED_DUTY_FIELDS");
    // A normal agent is unaffected.
    duties.create({ org_agent_id: agent, objective_ids: [objA], actor: OWNER });
    expect(duties.dutiesForAgent(agent)).toHaveLength(1);
    // A stored row with a colon endpoint can never prove — forge one.
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const rid = `DUT_colon_${n}`;
    const payload: Record<string, unknown> = {
      schema: "pair.os.vnext.org-agent-duty.v1",
      duty_id: rid, business_id: businessId, org_agent_id: colonAgent,
      objective_ids: [objA], state: "ACTIVE", note: null,
      created_by: OWNER, dedup_key: `ck${n}`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "org_agent_duty", entity_id: rid, version: 1,
    };
    payload.duty_digest = dutyDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org_agent_duty", rid, 1, JSON.stringify(payload), digest(payload),
        "2026-01-01T00:00:00.000Z");
    expect(duties.dutiesForObjective(objA).map((x) => x.duty_id))
      .not.toContain(rid);
    store.close();
  });

  it("E14 corrupt marker → lenient reads fall back; writes wedge loudly", () => {
    const { store, duties } = mkCtx();
    const { agent, objA } = mkScope(store);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA], actor: OWNER });
    duties.ensureIndex();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE entities SET payload='corrupt' WHERE entity_type='org_agent_duty_index_state'").run();
    // Lenient reads treat the unreadable marker as unbuilt and fall
    // back to the complete strict global enumeration — still served.
    expect(duties.dutiesForObjective(objA).map((x) => x.duty_id))
      .toEqual([d.duty_id]);
    expect(duties.dutiesForAgent(agent)).toHaveLength(1);
    // Writes cannot silently proceed on inconsistent derived state —
    // the marker put CAS-conflicts loudly.
    expectFail(() => duties.create({
      org_agent_id: agent, objective_ids: [objA], actor: OWNER,
    }), "FAIL_CLOSED");
    store.close();
  });

  it("E15 corrupt index pointer — lenient skips, strict propagates", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, objB } = mkScope(store);
    const d1 = duties.create({
      org_agent_id: agent, objective_ids: [objA], actor: OWNER });
    const d2 = duties.create({
      org_agent_id: agent, objective_ids: [objB], actor: OWNER });
    duties.ensureIndex();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    // Corrupt ONE pointer row under the agent's prefix.
    db.prepare("UPDATE entities SET payload='corrupt' WHERE entity_type='org_agent_duty_index' AND entity_id=?")
      .run(`A:${agent}:${d1.duty_id}`);
    // Lenient read isolates the corrupt pointer — sibling duty serves.
    expect(duties.dutiesForAgent(agent).map((x) => x.duty_id))
      .toEqual([d2.duty_id]);
    // Strict dedup (create) propagates the corruption loudly.
    expectFail(() => duties.create({
      org_agent_id: agent, objective_ids: [objA, objB], actor: OWNER,
    }), "FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    store.close();
  });

  it("E16 non-array covers() returns false; chunk boundary builds late", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, businessId } = mkScope(store);
    expect(duties.covers(agent, "not-an-array" as never)).toBe(false);
    expect(duties.covers(agent, null as never)).toBe(false);
    expect(duties.covers(agent, undefined as never)).toBe(false);
    // INDEX_CHUNK=64 boundary: marker must report built only after the
    // COMPLETE bound set is indexed — mint 66 duties (same business)
    // to cross a chunk, then reads must serve every endpoint.
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const agents: string[] = [];
    for (let i = 0; i < 66; i++) {
      const a = mkAgent(store, businessId);
      agents.push(a);
      duties.create({ org_agent_id: a, objective_ids: [objA], actor: OWNER });
    }
    const marker = db.prepare(
      "SELECT payload FROM entities WHERE entity_type='org_agent_duty_index_state'")
      .get() as { payload: string };
    expect(JSON.parse(marker.payload).built).toBe(true);
    // Every minted duty is reachable — a chunk-cut early 'built' would
    // silently drop the tail.
    expect(duties.dutiesForObjective(objA)).toHaveLength(66);
    expect(duties.dutiesForAgent(agents[65]!)).toHaveLength(1);
    store.close();
  });

  it("E17 ensureIndex never mints poison pointers for unkeyable rows", () => {
    const { store, duties } = mkCtx();
    const { agent, objA, businessId } = mkScope(store);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    // Raw-SQL row with a colon agent id — unmintable (provenRow drops
    // it), and ensureIndex must not project its endpoints: a pointer
    // `A:{agent}:evil:{duty}` would wedge the innocent agent's range.
    const rid = `DUT_pois_${n}`;
    const payload: Record<string, unknown> = {
      schema: "pair.os.vnext.org-agent-duty.v1",
      duty_id: rid, business_id: businessId,
      org_agent_id: `${agent}:evil`,
      objective_ids: [objA], state: "ACTIVE", note: null,
      created_by: OWNER, dedup_key: `pk${n}`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "org_agent_duty", entity_id: rid, version: 1,
    };
    payload.duty_digest = dutyDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org_agent_duty", rid, 1, JSON.stringify(payload), digest(payload),
        "2026-01-01T00:00:00.000Z");
    // Rebuild must skip the unkeyable endpoint entirely.
    duties.ensureIndex();
    const ptrs = db.prepare(
      "SELECT entity_id FROM entities WHERE entity_type='org_agent_duty_index'")
      .all() as Array<{ entity_id: string }>;
    // The colon endpoint is skipped — no poison key inside `A:{agent}:`.
    // (The keyable O:objA endpoint still gets a pointer — it names the
    // real row, which provenRow drops at read: a dead pointer, never
    // a wedge.)
    expect(ptrs.some((p) => p.entity_id === `A:${agent}:evil:${rid}`))
      .toBe(false);
    expect(ptrs.some((p) => p.entity_id === `O:${objA}:${rid}`)).toBe(true);
    // The innocent agent reads, covers and mints normally.
    expect(duties.dutiesForAgent(agent)).toHaveLength(0);
    expect(duties.covers(agent, [objA])).toBe(false);
    const d = duties.create({
      org_agent_id: agent, objective_ids: [objA], actor: OWNER });
    expect(d.state).toBe("ACTIVE");
    store.close();
  });

  it("E18 non-string endpoints fail typed, never raw TypeError", () => {
    const { store, duties } = mkCtx();
    const { agent, objA } = mkScope(store);
    for (const bad of [123, {}, true, ["x"]] as unknown[]) {
      expectFail(() => duties.dutiesForAgent(bad as string),
        "FAIL_CLOSED_DUTY_FIELDS");
      expectFail(() => duties.dutiesForObjective(bad as string),
        "FAIL_CLOSED_DUTY_FIELDS");
      // covers() re-proves the agent endpoint — typed fail, never a
      // raw TypeError; a non-array objective set alone yields false.
      expectFail(() => duties.covers(bad as string, [objA]),
        "FAIL_CLOSED_DUTY_FIELDS");
    }
    expect(duties.covers(agent, "x" as never)).toBe(false);
    expect(duties.covers(agent, null as never)).toBe(false);
    store.close();
  });
});
