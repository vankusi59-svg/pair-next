/**
 * P18-F — supersession-aware recovery + company E2E.
 *
 * Recovery semantics: an unmet DEPENDS_ON upstream is resolved through
 * the proven supersession DAG (admissionView().superseded_by — proven
 * ACTIVE SUPERSEDES edges only). The requirement is satisfied iff ANY
 * objective reachable from the upstream — itself included — is
 * ACHIEVED. Every step uses the same STRICT seam: corrupt rows wedge,
 * forged/revoked/suspended edges never unlock. Cycles, ambiguous
 * branching and over-cap walks stay gated — owner-authored states fail
 * contained, never wedge the scheduler scan.
 *
 *   F1  baseline — failed upstream with no superseder still gates.
 *   F2  declared-but-undelivered replacement keeps the gate.
 *   F3  failed upstream + ACHIEVED superseder → admission released.
 *   F4  supersession chain u→s1→s2, end achieved → released.
 *   F5  multiple superseders — any one achieving satisfies.
 *   F6  supersession cycle with no achieved node — bounded, gated.
 *   F7  SUSPENDED / REVOKED supersede edges never unlock.
 *   F8  unproven supersede (owner amendment) never unlocks.
 *   F9  pending upstream with an achieved replacement releases too —
 *       supersession re-points the requirement uniformly.
 *   F10 walk cap — a supersession graph wider than SUPERSEDE_WALK_CAP
 *       stays gated rather than walking unbounded.
 *   F11 index path vs strict global fallback — identical recovery
 *       verdicts.
 *   F12 supersede is not conflict — CONFLICTS gating unaffected.
 *   F13 company E2E — business + objectives + org-agent duty +
 *       relations + gating + recovery, one scenario end-to-end.
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
  OrgAgentDutyService,
  PairEvidenceStore,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p18f-recovery-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

type Row = Record<string, unknown>;

type Stack = {
  dir: string; store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService; policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler; wakeup: ObjectiveAutoWakeupService;
  relations: ObjectiveRelationService; duties: OrgAgentDutyService;
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
  const duties = new OrgAgentDutyService(store);
  return { dir, store, objectives, policy, scheduler, wakeup, relations,
    duties, now: () => t, setNow: (v) => { t = v; } };
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

/** A plain objective (no auto policy) — used as upstream/replacement
 *  endpoints whose only role is their status. */
function plain(s: Stack, businessId: string) {
  return oid(mkObjective(s, businessId));
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

const cancel = (s: Stack, bid: string, id: string) =>
  s.objectives.transitionStatus(id, { business_id: bid, to: "CANCELLED", actor: OWNER });
const achieve = (s: Stack, bid: string, id: string) =>
  s.objectives.transitionStatus(id, { business_id: bid, to: "ACHIEVED", actor: OWNER });
const depend = (s: Stack, from: string, to: string) =>
  s.relations.create({ from_objective_id: from, to_objective_id: to,
    kind: "DEPENDS_ON", actor: OWNER });
const supersede = (s: Stack, from: string, to: string) =>
  s.relations.create({ from_objective_id: from, to_objective_id: to,
    kind: "SUPERSEDES", actor: OWNER });

describe("P18-F — recovery + company E2E", () => {

  it("F1 failed upstream with no superseder still gates", () => {
    const s = fresh("f1");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    depend(s, a, u);
    cancel(s, bid, u);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    s.store.close();
  });

  it("F2 declared-but-undelivered replacement keeps the gate", () => {
    const s = fresh("f2");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = plain(s, bid);
    depend(s, a, u);
    cancel(s, bid, u);
    supersede(s, r, u); // r is ACTIVE — declared but not delivered
    expect(s.relations.admissionView(u).superseded_by).toEqual([r]);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    s.store.close();
  });

  it("F3 failed upstream + ACHIEVED superseder releases admission", () => {
    const s = fresh("f3");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = plain(s, bid);
    depend(s, a, u);
    cancel(s, bid, u);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    supersede(s, r, u);
    achieve(s, bid, r);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w1", "b1", "op1").objective_id).toBe(a);
    s.store.close();
  });

  it("F4 supersession chain resolves to the achieved end", () => {
    const s = fresh("f4");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const s1 = plain(s, bid);
    const s2 = plain(s, bid);
    depend(s, a, u);
    supersede(s, s1, u);
    supersede(s, s2, s1);
    cancel(s, bid, u);
    cancel(s, bid, s1);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    achieve(s, bid, s2);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    s.store.close();
  });

  it("F5 multiple declared replacements — any achieved satisfies", () => {
    const s = fresh("f5");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const s1 = plain(s, bid);
    const s2 = plain(s, bid);
    depend(s, a, u);
    supersede(s, s1, u);
    supersede(s, s2, u);
    cancel(s, bid, u);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    achieve(s, bid, s2);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    s.store.close();
  });

  it("F6 supersession cycle with no achieved node stays gated", () => {
    const s = fresh("f6");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const s1 = plain(s, bid);
    const s2 = plain(s, bid);
    depend(s, a, u);
    supersede(s, s1, u);
    supersede(s, s2, s1);
    supersede(s, s1, s2); // s1⇄s2 cycle
    cancel(s, bid, u);
    // Bounded walk — returns UPSTREAM_UNMET, never hangs.
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    expectFail(() => s.scheduler.claim(a, "w1", "b1", "op1"),
      "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF");
    s.store.close();
  });

  it("F7 SUSPENDED and REVOKED supersede edges never unlock", () => {
    const s = fresh("f7");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const s1 = plain(s, bid);
    const s2 = plain(s, bid);
    depend(s, a, u);
    const r1 = supersede(s, s1, u);
    const r2 = supersede(s, s2, u);
    cancel(s, bid, u);
    achieve(s, bid, s1);
    achieve(s, bid, s2);
    s.relations.control({ relation_id: r1.relation_id,
      action: "SUSPEND", actor: OWNER });
    s.relations.control({ relation_id: r2.relation_id,
      action: "REVOKE", actor: OWNER });
    expect(s.relations.admissionView(u).superseded_by).toEqual([]);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    s.store.close();
  });

  it("F8 unproven supersede (owner amended) never unlocks", () => {
    const s = fresh("f8");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = plain(s, bid);
    depend(s, a, u);
    cancel(s, bid, u);
    supersede(s, r, u);
    // Amend the replacement's owner BEFORE it delivers — the bilateral
    // edge drops out of the proven set; even an achieved superseder
    // can never satisfy through an unproven edge.
    s.objectives.amend(r, { business_id: bid,
      patch: { owner_authority_id: "operator:other" }, actor: OWNER });
    expect(s.relations.admissionView(u).superseded_by).toEqual([]);
    // Even delivered under its new owner, the edge is unproven.
    s.objectives.transitionStatus(r, { business_id: bid,
      to: "ACHIEVED", actor: "operator:other" });
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    s.store.close();
  });

  it("F9 pending upstream with an achieved replacement releases", () => {
    const s = fresh("f9");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = plain(s, bid);
    depend(s, a, u);
    supersede(s, r, u);
    achieve(s, bid, r); // u still ACTIVE — supersession re-points
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    s.store.close();
  });

  it("F10 supersession graph wider than the walk cap stays gated", () => {
    const s = fresh("f10");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    depend(s, a, u);
    cancel(s, bid, u);
    // 130 superseders > SUPERSEDE_WALK_CAP(128) — even with the LAST
    // one achieved the walk cannot prove it and stays gated.
    const leaves: string[] = [];
    for (let i = 0; i < 130; i++) {
      const r = plain(s, bid);
      supersede(s, r, u);
      leaves.push(r);
    }
    achieve(s, bid, leaves[129]);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    s.store.close();
  });

  it("F11 index path and global fallback give identical verdicts", () => {
    const s = fresh("f11");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = plain(s, bid);
    depend(s, a, u);
    supersede(s, r, u);
    cancel(s, bid, u);
    achieve(s, bid, r);
    const db = (s.store as unknown as {
      db: import("better-sqlite3").Database }).db;
    // Index path (marker built by the relation writes).
    expect(s.relations.admissionView(u).superseded_by).toEqual([r]);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    // Fallback path — same proof set, same verdict.
    db.prepare(
      "DELETE FROM entities WHERE entity_type='objective_relation_index_state'")
      .run();
    expect(s.relations.admissionView(u).superseded_by).toEqual([r]);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    s.store.close();
  });

  it("F12 supersede is not a conflict — CONFLICTS gating unaffected", () => {
    const s = fresh("f12");
    const bid = mkBiz(s.store);
    const a = claimable(s, bid);
    const u = plain(s, bid);
    const r = claimable(s, bid);
    depend(s, a, u);
    supersede(s, r, u);
    // r running must NOT conflict-gate a — supersession is lineage,
    // not contention.
    s.scheduler.claim(r, "w1", "b1", "op1");
    cancel(s, bid, u);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    achieve(s, bid, r); // can't — r has a lease; transition anyway (status only)
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    s.store.close();
  });

  it("F13 company E2E — duty + relation + failure + recovery in one business", () => {
    const s = fresh("f13");
    const bid = mkBiz(s.store);
    // The company: one agent on duty for the dependent objective.
    const agentId = `AGT_${counter}`;
    s.store.put("org_agent", agentId, {
      agent_id: agentId, business_id: bid, title: "ops-lead",
      department: "ops", role: "lead", reports_to: null,
      executor_binding: null, capabilities: [], status: "ACTIVE",
      context_notes: [], created_at: utcnow(), version: 0,
    }, 0);
    const a = claimable(s, bid);        // dependent — runs the program
    const u = plain(s, bid);            // upstream supplier objective
    s.duties.create({ org_agent_id: agentId, objective_ids: [a], actor: OWNER });
    expect(s.duties.covers(agentId, [a])).toBe(true);
    depend(s, a, u);
    // The supplier fails terminally — the program wedges.
    cancel(s, bid, u);
    expect(s.scheduler.claimable(a).reason).toBe("UPSTREAM_UNMET");
    // Owner declares + delivers a replacement — canonical recovery.
    const r = plain(s, bid);
    supersede(s, r, u);
    achieve(s, bid, r);
    expect(s.scheduler.claimable(a).eligible).toBe(true);
    expect(s.scheduler.claim(a, "w1", "b1", "op1").objective_id).toBe(a);
    // Boundaries held throughout: the duty still covers exactly what
    // was declared (recovery never re-points coverage), and u stays
    // the honest upstream edge.
    expect(s.duties.covers(agentId, [a])).toBe(true);
    expect(s.relations.admissionView(a).upstream).toEqual([u]);
    expect(s.relations.admissionView(u).superseded_by).toEqual([r]);
    s.store.close();
  });
});
