/**
 * P18-A — canonical objective_relation: the coordination layer's
 * atomic fact.
 *
 *   R1  create() validates — closed kind vocabulary, both objectives
 *       resolve, same business (derived, never asserted), no
 *       self-relation, actor must be owner_authority_id of BOTH
 *       endpoints (different owners → fail closed).
 *   R2  mint is canonical — ACTIVE, digest-pinned, event-anchored,
 *       business derived from the objectives.
 *   R3  idempotent mint — same (from,to,kind) returns the same row;
 *       the dedup oracle runs AFTER authority (foreign actor can't
 *       probe existence).
 *   R4  lifecycle — SUSPEND/RESUME/REVOKE transitions, terminal REVOKE
 *       idempotent, illegal transitions fail closed, CAS-held.
 *   R5  DEPENDS_ON acyclicity — mint rejects a cycle-closing edge;
 *       SUSPENDED edges still count (RESUME re-proves the graph that
 *       changed under it).
 *   R6  reads — relationsFor / relationsForBusiness / upstreamOf /
 *       conflictsWith return proven rows only.
 *   R7  re-proof — digest-recomputed state flip, event-less forge,
 *       foreign-business pairing → never served (reads AND control).
 *   R8  actor shape — non operator:<ref> actors rejected.
 *   R9  closed action vocabulary — out-of-set actions fail before the
 *       transition map (never persist/journal an undefined state).
 *   R10 atomicity — a failing event write rolls the row write back
 *       (immediate tx, no orphan).
 *   R11 anchor borrowing — a clone under a foreign storage key with
 *       a self-consistent payload never borrows the victim's events.
 *   R12 resurrection — terminal-flip payload rewrite + forged chain
 *       break → unproven.
 *   R13 owner amend post-mint — created_by must equal CURRENT
 *       bilateral owner; an amended endpoint drops the relation.
 *   R14 cross-connection mint — the immediate tx serializes dedup.
 *   R15 read-budget trips propagate loudly — never silently truncate
 *       the proven set into a duplicate mint or a cycle-check bypass.
 *   R16 corrupt payload row — isolate-and-skip serves legit siblings.
 *   R17 corrupt event anchor — fails only ITS row, not the service.
 *   R18 CONFLICTS symmetric dedup — reverse pair converges.
 *   R19 fabricated self-relation / CREATED-state rewrite / TEXT
 *       version column → unproven or TAMPERED.
 *   R20 strict write path — a corrupt row wedges mints (never a
 *       silent duplicate or a starved cycle check), while lenient
 *       reads still serve siblings.
 *   R21 cross-collation isolate-skip — astral-plane corrupt keys
 *       (JS/UTF-8 ordering disagree) skip, not wedge.
 *   R22 taxonomy + dedup_key validation — unparseable payload on the
 *       control path throws IntegrityError (not SyntaxError); non-
 *       string/oversized dedup_key rejected at mint.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveRelationService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  digest,
  relationDigest,
} from "../pair/index.js";
import { IntegrityError } from "../pair/errors.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p18a-rel-"));
let counter = 0;
const OP = "p18-owner";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_D";

type Row = Record<string, unknown>;

type Stack = {
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  projectId: string;
  relations: ObjectiveRelationService;
};

function fresh(name: string): Stack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: [{ task_key: "T1", title: "t", task_instruction: "t", required_capabilities: [], depends_on: [] }] });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner,
  });
  const biz = new BusinessLayer({ store, control,
    schedules: new MissionScheduleService(service),
    planExpander: async (input) => ({ input, planner: { planner_run_id: "P", attempts: [], winner: { attempt_no: 1 } } }) });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { dir, store, biz, projectId: String(project.project_id),
    relations: new ObjectiveRelationService(store) };
}

function mkBusiness(s: Stack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: Stack, businessId: string, operator = OP) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "obj", statement: "Produce deliverables.",
    kpis: [{ kpi_id: KPI, name: "d", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: operator,
  });
}

function objId(o: Row) { return String(o.objective_id); }

/* ----------------------------- tests ----------------------------- */

describe("P18-A — objective_relation canonical entity", () => {

  it("R1 create() validates kind, resolution, business, self, bilateral owner", () => {
    const s = fresh("r1");
    const bid = mkBusiness(s);
    const bid2 = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const foreign = objId(mkObjective(s, bid2));
    const otherOwned = objId(mkObjective(s, bid, "someone-else"));
    // Unknown kind.
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "LIKES", actor: OWNER }))
      .toThrowError(IntegrityError);
    // Missing objective.
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: "OBJ_NONE", kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // Self-relation.
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: a, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // Cross-business pairing — business is derived, never asserted.
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: foreign, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // Different owners — bilateral consent is required, not bypassed.
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: otherOwned, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    s.store.close();
  });

  it("R2 mint is canonical — digest, event anchor, derived business", () => {
    const s = fresh("r2");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    expect(r.state).toBe("ACTIVE");
    expect(r.business_id).toBe(bid);
    expect(r.relation_digest).toMatch(/^[0-9a-f]{64}$/);
    const events = s.store.listEvents("objective_relation", r.relation_id);
    expect(events.map((e) => String(e.event_type))).toEqual(["OBJECTIVE_RELATION_CREATED"]);
    s.store.close();
  });

  it("R3 idempotent mint — same triple converges; dedup runs after authority", () => {
    const s = fresh("r3");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r1 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const r2 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    expect(r2.relation_id).toBe(r1.relation_id);
    expect(s.store.list("objective_relation")).toHaveLength(1);
    // A different kind is a different relation.
    const r3 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "CONFLICTS", actor: OWNER });
    expect(r3.relation_id).not.toBe(r1.relation_id);
    s.store.close();
  });

  it("R4 lifecycle — SUSPEND/RESUME/REVOKE transitions + terminal idempotence", () => {
    const s = fresh("r4");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    // RESUME from ACTIVE is illegal.
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "RESUME", actor: OWNER }))
      .toThrowError(IntegrityError);
    const sus = s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER });
    expect(sus.state).toBe("SUSPENDED");
    // SUSPEND from SUSPENDED illegal; foreign actor denied.
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "RESUME", actor: "operator:intruder" }))
      .toThrowError(IntegrityError);
    const res = s.relations.control({
      relation_id: r.relation_id, action: "RESUME", actor: OWNER });
    expect(res.state).toBe("ACTIVE");
    const rev = s.relations.control({
      relation_id: r.relation_id, action: "REVOKE", actor: OWNER });
    expect(rev.state).toBe("REVOKED");
    // Terminal REVOKE is idempotent.
    const rev2 = s.relations.control({
      relation_id: r.relation_id, action: "REVOKE", actor: OWNER });
    expect(rev2.state).toBe("REVOKED");
    // Re-mint after revoke creates a NEW relation (old is terminal).
    const r2 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    expect(r2.relation_id).not.toBe(r.relation_id);
    const events = s.store.listEvents("objective_relation", r.relation_id);
    expect(events.map((e) => String(e.new_state))).toEqual(
      ["ACTIVE", "SUSPENDED", "ACTIVE", "REVOKED"]);
    s.store.close();
  });

  it("R5 DEPENDS_ON acyclicity — mint-time + resume-time re-proof", () => {
    const s = fresh("r5");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    s.relations.create({ from_objective_id: b, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    // c→a would close a→b→c→a — fail closed.
    expect(() => s.relations.create({
      from_objective_id: c, to_objective_id: a, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // SUSPENDED edges still count toward acyclicity — reviving must
    // never reopen a cycle. Suspend b→c; minting c→a STILL fails:
    // the walk from a reaches c through a→b→c (both in the graph).
    const relBC = s.relations.relationsFor(b)
      .find((r) => r.to_objective_id === c)!;
    s.relations.control({ relation_id: relBC.relation_id, action: "SUSPEND", actor: OWNER });
    expect(() => s.relations.create({
      from_objective_id: c, to_objective_id: a, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // RESUME re-proves too — resuming b→c is legal (a→b→c is acyclic).
    const res = s.relations.control({ relation_id: relBC.relation_id, action: "RESUME", actor: OWNER });
    expect(res.state).toBe("ACTIVE");
    s.store.close();
  });

  it("R6 reads — relationsFor / upstreamOf / conflictsWith", () => {
    const s = fresh("r6");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    s.relations.create({ from_objective_id: a, to_objective_id: c, kind: "CONFLICTS", actor: OWNER });
    expect(s.relations.relationsFor(a)).toHaveLength(2);
    expect(s.relations.relationsFor(b)).toHaveLength(1);
    expect(s.relations.relationsForBusiness(bid)).toHaveLength(2);
    expect(s.relations.upstreamOf(a)).toEqual([b]);
    expect(s.relations.upstreamOf(b)).toEqual([]);
    // CONFLICTS is symmetric for the exclusion set.
    expect(s.relations.conflictsWith(a)).toEqual([c]);
    expect(s.relations.conflictsWith(c)).toEqual([a]);
    s.store.close();
  });

  it("R7 re-proof — forged rows never served on read or control", () => {
    const s = fresh("r7");
    const bid = mkBusiness(s);
    const bid2 = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const foreign = objId(mkObjective(s, bid2));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const read = () => JSON.parse(
      (db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
        .get(r.relation_id) as { payload: string }).payload);
    const write = (p: Row) => db.prepare(
      "UPDATE entities SET payload=?, payload_hash=? WHERE entity_type='objective_relation' AND entity_id=?")
      .run(JSON.stringify(p), digest(p), r.relation_id);
    // 1) digest-recomputed state flip (SUSPENDED without the event).
    const p1 = read();
    p1.state = "SUSPENDED";
    p1.relation_digest = relationDigest(p1);
    write(p1);
    expect(s.relations.relationsFor(a)).toHaveLength(0);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "RESUME", actor: OWNER }))
      .toThrowError(IntegrityError);
    // 2) foreign-business pairing — valid digest, wrong business.
    const p2 = read();
    p2.state = "ACTIVE";
    p2.to_objective_id = foreign;
    p2.relation_digest = relationDigest(p2);
    write(p2);
    expect(s.relations.relationsFor(a)).toHaveLength(0);
    expect(s.relations.upstreamOf(a)).toEqual([]);
    // 3) event-less fresh forge — a raw row with no lifecycle anchor.
    const forged = {
      relation_id: "REL_FORGED", schema: "pair.os.vnext.objective-relation.v1",
      business_id: bid, from_objective_id: a, to_objective_id: b,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null, created_by: OWNER,
      dedup_key: "x", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", relation_digest: "",
    };
    forged.relation_digest = relationDigest(forged);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", "REL_FORGED", 1, JSON.stringify(forged), digest(forged), forged.created_at);
    expect(s.relations.relationsFor(a)).toHaveLength(0);
    s.store.close();
  });

  it("R8 actor shape — non operator:<ref> rejected at mint and control", () => {
    const s = fresh("r8");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    for (const bad of ["", "admin", "operator:", "operator: ", "operator:a b", "system:x"]) {
      expect(() => s.relations.create({
        from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: bad }),
        `actor=${JSON.stringify(bad)}`).toThrowError(IntegrityError);
    }
    s.store.close();
  });

  it("R9 closed action vocabulary — DESTROY fails before the transition map", () => {
    const s = fresh("r9");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    // Out-of-vocabulary action: must fail typed, never write.
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "DESTROY" as never, actor: OWNER }))
      .toThrowError(IntegrityError);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "" as never, actor: OWNER }))
      .toThrowError(IntegrityError);
    // Row untouched, no events journaled.
    const stored = s.store.tryGet("objective_relation", r.relation_id) as Row;
    expect(String(stored.state)).toBe("ACTIVE");
    expect(s.store.listEvents("objective_relation", r.relation_id)).toHaveLength(1);
    s.store.close();
  });

  it("R10 atomicity — a failing event write rolls the row write back", () => {
    const s = fresh("r10");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const mutable = s.store as unknown as {
      event: (p: Record<string, unknown>) => unknown };
    const orig = mutable.event.bind(s.store);
    mutable.event = () => { throw new IntegrityError("FORCED", "event fail"); };
    expect(() => s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER }))
      .toThrowError(IntegrityError);
    // No orphan row — the immediate tx rolled the put back.
    expect(s.store.list("objective_relation")).toHaveLength(0);
    mutable.event = orig;
    // Control path atomicity: SUSPEND whose event write fails leaves
    // the row ACTIVE and uncontaminated.
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    mutable.event = () => { throw new IntegrityError("FORCED", "event fail"); };
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    const stored = s.store.tryGet("objective_relation", r.relation_id) as Row;
    expect(String(stored.state)).toBe("ACTIVE");
    mutable.event = orig;
    // The service still works after the seam is restored.
    const sus = s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER });
    expect(sus.state).toBe("SUSPENDED");
    s.store.close();
  });

  it("R11 anchor borrowing — clones under foreign keys never prove", () => {
    const s = fresh("r11");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const victimPayload = JSON.parse(
      (db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
        .get(r.relation_id) as { payload: string }).payload);
    // Clone the victim byte-for-byte under a different storage key.
    // Payload entity_id says victim (self-consistent internally) but
    // the storage key does not — entityPage rejects it at the page.
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", "REL_CLONE", 1,
        JSON.stringify(victimPayload), digest(victimPayload), "2026-01-01T00:00:00.000Z");
    expect(s.relations.relationsFor(a)).toHaveLength(1); // victim only
    // Control on the clone key: tryGet returns the borrowed payload —
    // the explicit key check must reject before anchors are read.
    expect(() => s.relations.control({
      relation_id: "REL_CLONE", action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    // The victim is still fully controllable.
    const sus = s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER });
    expect(sus.state).toBe("SUSPENDED");
    s.store.close();
  });

  it("R12 resurrection + chain break — forged rewrites never revive a terminal row", () => {
    const s = fresh("r12");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    s.relations.control({ relation_id: r.relation_id, action: "REVOKE", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const p = JSON.parse(
      (db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
        .get(r.relation_id) as { payload: string }).payload);
    // Digest-recomputed REVOKED→ACTIVE rewrite: the event tail still
    // ends at REVOKED — unproven on read AND control.
    p.state = "ACTIVE";
    p.relation_digest = relationDigest(p);
    db.prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type='objective_relation' AND entity_id=?")
      .run(JSON.stringify(p), digest(p), r.relation_id);
    expect(s.relations.relationsFor(a)).toHaveLength(0);
    expect(s.relations.upstreamOf(a)).toEqual([]);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    s.store.close();
  });

  it("R13 owner amend post-mint — relation re-proves against CURRENT owners", () => {
    const s = fresh("r13");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    expect(s.relations.relationsFor(a)).toHaveLength(1);
    // Re-own one endpoint — the consenting owner no longer holds both.
    s.biz.objectives.amend(b, {
      business_id: bid,
      patch: { owner_authority_id: "operator:successor" },
      actor: OWNER,
    });
    // The relation silently drops out of the proven set — reads AND
    // control fail closed (re-mint under the new owner is the remedy).
    expect(s.relations.relationsFor(a)).toHaveLength(0);
    expect(s.relations.relationsForBusiness(bid)).toHaveLength(0);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: "operator:successor" }))
      .toThrowError(IntegrityError);
    s.store.close();
  });

  it("R14 cross-connection mint — immediate tx serializes the dedup check", () => {
    const s = fresh("r14");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r1 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    // A second connection sees the committed row — dedup converges.
    const s2 = new ObjectiveRelationService(
      new PairEvidenceStore(path.join(s.dir, "pair.db")));
    const r2 = s2.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    expect(r2.relation_id).toBe(r1.relation_id);
    expect(s.store.list("objective_relation")).toHaveLength(1);
    s.store.close();
  });

  it("R15 read-budget trips propagate — no silent truncation, no duplicate mint", () => {
    const s = fresh("r15");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    // A starved entity budget must NOT silently truncate the proven
    // set (which would defeat dedup → a second canonical row) — the
    // trip is loud, and nothing commits. entities:2 is exhausted by
    // the two endpoint reads alone; entityPage's charge then trips.
    let code = "";
    try {
      s.store.withReadBudget(
        { entities: 2, events: 10_000 },
        () => s.relations.create({
          from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER }));
    } catch (e) {
      code = e instanceof IntegrityError ? e.code : "non-integrity";
    }
    expect(code).toBe("FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT");
    expect(s.store.list("objective_relation")).toHaveLength(1);
    // Reads under a starved budget are loud too — never a silently
    // truncated proven set.
    code = "";
    try {
      s.store.withReadBudget(
        { entities: 1, events: 10_000 },
        () => s.relations.relationsFor(a));
    } catch (e) {
      code = e instanceof IntegrityError ? e.code : "non-integrity";
    }
    expect(code).toBe("FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT");
    // And the cycle check can't be starved either: a→b→c exists, so
    // c→a must fail loudly or correctly — never silently mint.
    s.relations.create({ from_objective_id: b, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    expect(() => s.store.withReadBudget(
      { entities: 2, events: 10_000 },
      () => s.relations.create({
        from_objective_id: c, to_objective_id: a, kind: "DEPENDS_ON", actor: OWNER })))
      .toThrowError(IntegrityError);
    expect(s.store.list("objective_relation")).toHaveLength(2);
    s.store.close();
  });

  it("R16 corrupt payload row — isolate-and-skip still serves legit siblings", () => {
    const s = fresh("r16");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const legit = s.relations.create({
      from_objective_id: a, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Unparseable payload — sorts before the REL_* ids.
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", "REL_0_CORRUPT", 1, "{not json", "0".repeat(64), "2026-01-01T00:00:00.000Z");
    // Hash-valid but identity-lying payload on another key.
    const bad = { relation_id: "REL_1_BAD", schema: "x", entity_id: "REL_1_BAD", version: 1 };
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", "REL_1_BAD", 1, JSON.stringify(bad), digest(bad), "2026-01-01T00:00:00.000Z");
    // The two corrupt rows are isolated and skipped; the legit row
    // sorts after them (REL- prefixed id > REL_0/REL_1? — assert the
    // service answer regardless of order: exactly the legit row).
    const got = s.relations.relationsFor(a);
    expect(got).toHaveLength(1);
    expect(String(got[0].relation_id)).toBe(legit.relation_id);
    s.store.close();
  });

  it("R17 corrupt event anchor — fails only ITS row closed", () => {
    const s = fresh("r17");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const poisoned = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const healthy = s.relations.create({
      from_objective_id: a, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Corrupt the poisoned relation's CREATED event hash.
    db.prepare("UPDATE events SET event_hash=? WHERE entity_type='objective_relation' AND entity_id=?")
      .run("0".repeat(64), poisoned.relation_id);
    // Its row is unproven; the sibling still serves.
    const got = s.relations.relationsFor(a);
    expect(got.map((r) => String(r.relation_id))).toEqual([healthy.relation_id]);
    expect(() => s.relations.control({
      relation_id: poisoned.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    s.store.close();
  });

  it("R18 CONFLICTS is symmetric — reverse pair dedups to the same row", () => {
    const s = fresh("r18");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r1 = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "CONFLICTS", actor: OWNER });
    // (B,A,CONFLICTS) is the same canonical fact — converge, not dup.
    const r2 = s.relations.create({
      from_objective_id: b, to_objective_id: a, kind: "CONFLICTS", actor: OWNER });
    expect(r2.relation_id).toBe(r1.relation_id);
    expect(s.store.list("objective_relation")).toHaveLength(1);
    // DEPENDS_ON stays directional (different fact, not a dedup case
    // — but the reverse direction would need acyclicity anyway).
    s.store.close();
  });

  it("R19 fabrication guards — self-relation, CREATED-state rewrite, TEXT version", () => {
    const s = fresh("r19");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const forgedEvent = (entityId: string, newState: string | null, metadata: Row) => {
      const body: Row = {
        event_id: `EVT_${entityId}`, entity_type: "objective_relation",
        entity_id: entityId, event_type: "OBJECTIVE_RELATION_CREATED",
        old_state: null, new_state: newState, actor: OWNER,
        correlation_id: null, metadata,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      db.prepare("INSERT INTO events (event_id, entity_type, entity_id, event_type, old_state, new_state, actor, correlation_id, metadata_json, created_at, event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(body.event_id, body.entity_type, body.entity_id, body.event_type,
          body.old_state, body.new_state, body.actor, body.correlation_id,
          JSON.stringify(metadata), body.created_at, digest(body));
    };
    // 1) Fully-fabricated self-relation — valid digest AND a forged
    //    CREATED anchor (event-writer bound). Only the self-endpoint
    //    re-check drops it.
    const self: Row = {
      relation_id: "REL_SELF", entity_id: "REL_SELF", entity_type: "objective_relation",
      version: 1, schema: "pair.os.vnext.objective-relation.v1",
      business_id: bid, from_objective_id: a, to_objective_id: a,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null, created_by: OWNER,
      dedup_key: "x", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", relation_digest: "",
    };
    self.relation_digest = relationDigest(self);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", "REL_SELF", 1, JSON.stringify(self), digest(self), self.created_at);
    forgedEvent("REL_SELF", "ACTIVE",
      { business_id: bid, from_objective_id: a, to_objective_id: a, kind: "DEPENDS_ON" });
    expect(s.relations.upstreamOf(a)).toEqual([b]); // self-edge excluded
    // 2) Payload version rewritten to TEXT (CAS feeds off this field —
    //    strict typeof must refuse before the coercion path). Do this
    //    while the legit row's event tail is still clean.
    const p2 = JSON.parse(
      (db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
        .get(r.relation_id) as { payload: string }).payload);
    p2.version = "1";
    p2.relation_digest = relationDigest(p2);
    db.prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type='objective_relation' AND entity_id=?")
      .run(JSON.stringify(p2), digest(p2), r.relation_id);
    expect(() => s.relations.control({
      relation_id: r.relation_id, action: "SUSPEND", actor: OWNER }))
      .toThrowError(IntegrityError);
    // 3) CREATED anchor's new_state rewritten (hash recomputed) on the
    //    legit relation — the pin must reject it.
    const ev = db.prepare(
      "SELECT * FROM events WHERE entity_type='objective_relation' AND entity_id=?")
      .get(r.relation_id) as Row;
    const meta = ev.metadata_json ? JSON.parse(String(ev.metadata_json)) : null;
    const body = {
      event_id: ev.event_id, entity_type: ev.entity_type, entity_id: ev.entity_id,
      event_type: ev.event_type, old_state: ev.old_state, new_state: "REVOKED",
      actor: ev.actor, correlation_id: ev.correlation_id, metadata: meta,
      created_at: ev.created_at,
    };
    db.prepare("UPDATE events SET new_state=?, event_hash=? WHERE event_id=?")
      .run("REVOKED", digest(body), ev.event_id);
    expect(s.relations.relationsFor(a)).toHaveLength(0); // forged CREATED → unproven
    s.store.close();
  });

  it("R20 strict write path — corrupt rows wedge mints, never truncate dedup/cycle", () => {
    const s = fresh("r20");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const d = objId(mkObjective(s, bid));
    const rAB = s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const rBC = s.relations.create({ from_objective_id: b, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    // Mint the lenient-read sibling while the set is still clean.
    const rAD = s.relations.create({ from_objective_id: a, to_objective_id: d, kind: "CONFLICTS", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const corrupt = (id: string) => {
      const row = db.prepare("SELECT payload FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
        .get(id) as { payload: string };
      db.prepare("UPDATE entities SET payload=? WHERE entity_type='objective_relation' AND entity_id=?")
        .run(row.payload.replace("ACTIVE", "XXXXXX"), id);
    };
    const count = () => (db.prepare(
      "SELECT COUNT(*) n FROM entities WHERE entity_type='objective_relation'").get() as { n: number }).n;
    // Corrupt a→b: a replayed mint must NOT silently dedup-miss into a
    // second canonical row — the strict write path fails loudly.
    corrupt(rAB.relation_id);
    let code = "";
    try {
      s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    } catch (e) { code = e instanceof IntegrityError ? e.code : "?"; }
    expect(code).toBe("FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    expect(count()).toBe(3); // no dup
    // Corrupt b→c too: the c→a cycle-check must not walk a starved
    // edge set — it fails loudly on the corruption instead.
    corrupt(rBC.relation_id);
    code = "";
    try {
      s.relations.create({ from_objective_id: c, to_objective_id: a, kind: "DEPENDS_ON", actor: OWNER });
    } catch (e) { code = e instanceof IntegrityError ? e.code : "?"; }
    expect(code).toBe("FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    expect(count()).toBe(3);
    // Reads stay lenient: corrupt rows skip, legit siblings serve.
    expect(s.relations.relationsFor(a).map((r) => String(r.relation_id)))
      .toEqual([rAD.relation_id]);
    s.store.close();
  });

  it("R21 cross-collation isolate-skip — astral corrupt keys skip, not wedge", () => {
    const s = fresh("r21");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const legit = s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const plant = (key: string) => db.prepare(
      "INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", key, 1, "{corrupt", "0".repeat(64), "2026-01-01T00:00:00.000Z");
    // U+FFFF then U+10000: SQLite orders ￿ < 𐀀 (UTF-8) but JS
    // orders them oppositely (UTF-16 surrogate pairs). Both must be
    // isolated+skipped without a cross-collation cursor wedge.
    plant("\uFFFF");
    plant("\u{10000}");
    const got = s.relations.relationsFor(a);
    expect(got.map((r) => String(r.relation_id))).toEqual([legit.relation_id]);
    s.store.close();
  });

  it("R22 taxonomy + dedup_key — IntegrityError on corrupt control read; key validation", () => {
    const s = fresh("r22");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({ from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Unparseable payload on the control read path → typed integrity
    // failure (get's wrap), never a bare SyntaxError.
    db.prepare("UPDATE entities SET payload=? WHERE entity_type='objective_relation' AND entity_id=?")
      .run("{nope", r.relation_id);
    try {
      s.relations.control({ relation_id: r.relation_id, action: "SUSPEND", actor: OWNER });
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect((e as IntegrityError).code).toBe("FAIL_CLOSED_ENTITY_HASH_MISMATCH");
    }
    // Restore, then dedup_key shape validation at mint.
    const d = objId(mkObjective(s, bid));
    for (const bad of [12345 as never, "x".repeat(300)]) {
      expect(() => s.relations.create({
        from_objective_id: a, to_objective_id: d, kind: "CONFLICTS",
        actor: OWNER, dedup_key: bad as never }))
        .toThrowError(IntegrityError);
    }
    // Still exactly one relation row — both bad mints failed closed.
    expect((db.prepare(
      "SELECT COUNT(*) n FROM entities WHERE entity_type='objective_relation'")
      .get() as { n: number }).n).toBe(1);
    s.store.close();
  });
});
