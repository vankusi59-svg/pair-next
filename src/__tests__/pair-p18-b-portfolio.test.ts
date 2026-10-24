/**
 * P18-B — business portfolio projection over canonical
 * objective_relation.
 *
 *   B1  scope/authority — only actor-owned objectives in the business;
 *       owner of none → FAIL_CLOSED_PORTFOLIO_SCOPE; foreign business
 *       → not found.
 *   B2  graph — DEPENDS_ON projected on both endpoints; PENDING
 *       upstream derives blocked.
 *   B3  satisfaction — ACHIEVED → SATISFIED/unblocked; terminal
 *       non-ACHIEVED → FAILED (still blocked); SUSPENDED/REVOKED
 *       render with state, never block.
 *   B4  CONFLICTS symmetric on both endpoints; SUPERSEDES direction.
 *   B5  proven-only — a corrupt relation row is isolate-skipped while
 *       legit edges still serve; a corrupt objective wedges the whole
 *       read; a foreign-business forged pairing never enters.
 *   B6  multi-owner isolation — another owner's objective pair and
 *       their edges never leak into the actor's projection.
 *   B7  counts — by-kind/by-state over scoped edges incl. REVOKED;
 *       blocked counted over all owned; truncation honest.
 *   B8  determinism — edges sorted by relation_id code-unit order;
 *       objectives by (created_at, id).
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BusinessLayer,
  createMissionControlServer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectivePortfolioService,
  ObjectiveRelationService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
} from "../pair/index.js";
import { IntegrityError } from "../pair/errors.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p18b-portfolio-"));
let counter = 0;
const OP = "p18b-owner";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_D";

type Row = Record<string, unknown>;

type Stack = {
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  projectId: string;
  relations: ObjectiveRelationService;
  portfolio: ObjectivePortfolioService;
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
  const relations = new ObjectiveRelationService(store);
  return { dir, store, biz, wf: new WorkforceService({ store, business: biz }),
    projectId: String(project.project_id), relations,
    portfolio: new ObjectivePortfolioService({
      store, objectives: biz.objectives, relations }) };
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
function rawDb(s: Stack) {
  return (s.store as unknown as { db: import("better-sqlite3").Database }).db;
}
function view(s: Stack, bid: string, actor = OWNER) {
  return s.portfolio.businessPortfolio(bid, actor) as {
    objectives: Array<Row & {
      depends_on: Array<Row>; dependents: Array<Row>;
      conflicts: Array<Row>; supersedes: Array<Row>; superseded_by: Array<Row>;
      dependency: Row;
    }>;
    edges: Array<Row>;
    counts: Row & { relations_by_kind: Row; relations_by_state: Row };
  };
}
function byOid(v: { objectives: Array<Row> }, oid: string) {
  return v.objectives.find((o) => String(o.objective_id) === oid)!;
}

/* ----------------------------- tests ----------------------------- */

describe("P18-B — business portfolio projection", () => {

  it("B1 serves only actor-owned objectives; no-ownership fails closed", () => {
    const s = fresh("b1");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    mkObjective(s, bid, "someone-else"); // foreign-owned, same business
    const v = view(s, bid);
    expect(v.objectives.map((o) => String(o.objective_id)).sort())
      .toEqual([a, b].sort());
    // An actor owning nothing in the business fails closed.
    expect(() => s.portfolio.businessPortfolio(bid, "operator:intruder"))
      .toThrowError(/FAIL_CLOSED_PORTFOLIO_SCOPE/);
    // A foreign business does not resolve.
    expect(() => s.portfolio.businessPortfolio("BUS_NONE", OWNER))
      .toThrowError();
    s.store.close();
  });

  it("B2 DEPENDS_ON projects on both endpoints; PENDING derives blocked", () => {
    const s = fresh("b2");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const v = view(s, bid);
    const pa = byOid(v, a), pb = byOid(v, b);
    expect(pa.depends_on).toHaveLength(1);
    expect(pa.depends_on[0]!.relation_id).toBe(r.relation_id);
    expect(pa.depends_on[0]!.counterparty_objective_id).toBe(b);
    expect(pa.depends_on[0]!.satisfaction).toBe("PENDING");
    expect(pa.dependency.blocked).toBe(true);
    expect(pa.dependency.upstream_pending).toBe(1);
    // The upstream side sees its dependents.
    expect(pb.dependents).toHaveLength(1);
    expect(pb.dependents[0]!.counterparty_objective_id).toBe(a);
    expect(pb.dependency.blocked).toBe(false);
    expect(v.edges.map((e) => String(e.relation_id))).toEqual([r.relation_id]);
    expect(v.counts.objectives_dependency_blocked).toBe(1);
    s.store.close();
  });

  it("B3 satisfaction semantics — SATISFIED / FAILED / SUSPENDED / REVOKED", () => {
    const s = fresh("b3");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const d = objId(mkObjective(s, bid));
    const rAB = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const rAC = s.relations.create({
      from_objective_id: a, to_objective_id: c, kind: "DEPENDS_ON", actor: OWNER });
    const rAD = s.relations.create({
      from_objective_id: a, to_objective_id: d, kind: "DEPENDS_ON", actor: OWNER });
    // B achieved → SATISFIED; C cancelled → FAILED (unsatisfiable);
    // D suspended → not gating.
    s.biz.objectives.transitionStatus(b, {
      business_id: bid, to: "ACHIEVED", actor: OWNER });
    s.biz.objectives.transitionStatus(c, {
      business_id: bid, to: "CANCELLED", actor: OWNER });
    s.relations.control({ relation_id: rAD.relation_id, action: "SUSPEND", actor: OWNER });
    const v = view(s, bid);
    const pa = byOid(v, a);
    const sat = new Map(pa.depends_on.map((x) => [String(x.counterparty_objective_id), String(x.satisfaction)]));
    expect(sat.get(b)).toBe("SATISFIED");
    expect(sat.get(c)).toBe("FAILED");
    expect(sat.get(d)).toBe("SUSPENDED");
    expect(pa.dependency.upstream_satisfied).toBe(1);
    expect(pa.dependency.upstream_failed).toBe(1);
    expect(pa.dependency.blocked).toBe(true); // FAILED still blocks
    // Revoke the failed edge → only the satisfied active edge remains.
    s.relations.control({ relation_id: rAC.relation_id, action: "REVOKE", actor: OWNER });
    const v2 = view(s, bid);
    const pa2 = byOid(v2, a);
    const sat2 = new Map(pa2.depends_on.map((x) => [String(x.counterparty_objective_id), String(x.satisfaction)]));
    expect(sat2.get(c)).toBe("REVOKED");
    expect(pa2.dependency.blocked).toBe(false);
    expect(pa2.dependency.upstream_active).toBe(1);
    expect(v2.counts.relations_by_state.REVOKED).toBe(1);
    void rAB;
    s.store.close();
  });

  it("B4 CONFLICTS symmetric on both endpoints; SUPERSEDES direction", () => {
    const s = fresh("b4");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const rc = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "CONFLICTS", actor: OWNER });
    const rs = s.relations.create({
      from_objective_id: c, to_objective_id: a, kind: "SUPERSEDES", actor: OWNER });
    const v = view(s, bid);
    const pa = byOid(v, a), pb = byOid(v, b), pc = byOid(v, c);
    // CONFLICTS visible and counted symmetrically.
    expect(pa.conflicts.map((x) => String(x.counterparty_objective_id))).toEqual([b]);
    expect(pb.conflicts.map((x) => String(x.counterparty_objective_id))).toEqual([a]);
    expect(pa.active_conflicts).toBe(1);
    expect(pb.active_conflicts).toBe(1);
    expect(pa.conflicts[0]!.relation_id).toBe(rc.relation_id);
    // SUPERSEDES: c supersedes a.
    expect(pc.supersedes.map((x) => String(x.counterparty_objective_id))).toEqual([a]);
    expect(pa.superseded_by.map((x) => String(x.counterparty_objective_id))).toEqual([c]);
    expect(pb.supersedes).toHaveLength(0);
    expect(v.counts.relations_by_kind.CONFLICTS).toBe(1);
    expect(v.counts.relations_by_kind.SUPERSEDES).toBe(1);
    void rs;
    s.store.close();
  });

  it("B5 proven-only — corrupt relation skipped, corrupt objective wedges", () => {
    const s = fresh("b5");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const r = s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const db = rawDb(s);
    // Plant a corrupt relation row (payload tampered, hash NOT fixed)
    // with a key that sorts before the legit relation — lenient reads
    // must isolate-and-skip it, not wedge.
    db.prepare(
      "INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("objective_relation", "REL_000corrupt", 1,
      JSON.stringify({ entity_id: "REL_000corrupt", kind: "DEPENDS_ON", state: "ACTIVE" }),
      "badhash", "2026-01-01T00:00:00.000Z");
    const v = view(s, bid);
    expect(v.edges).toHaveLength(1);
    expect(v.edges[0]!.relation_id).toBe(r.relation_id);
    expect(byOid(v, a).dependency.blocked).toBe(true);
    // A corrupt OBJECTIVE anywhere wedges the whole scope proof.
    const objPayload = db.prepare(
      "SELECT payload FROM entities WHERE entity_type='objective' AND entity_id=?",
    ).get(a) as { payload: string };
    db.prepare(
      "UPDATE entities SET payload=? WHERE entity_type='objective' AND entity_id=?",
    ).run(objPayload.payload.replace(bid, bid + "X"), a);
    expect(() => view(s, bid)).toThrowError(IntegrityError);
    s.store.close();
  });

  it("B6 multi-owner isolation — foreign pairs and edges never leak", () => {
    const s = fresh("b6");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid, "owner-two"));
    const d = objId(mkObjective(s, bid, "owner-two"));
    s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const rCD = s.relations.create({
      from_objective_id: c, to_objective_id: d, kind: "DEPENDS_ON", actor: "operator:owner-two" });
    const mine = view(s, bid);
    expect(mine.objectives).toHaveLength(2);
    expect(mine.edges).toHaveLength(1);
    expect(mine.edges[0]!.relation_id).not.toBe(rCD.relation_id);
    // owner-two sees only their own pair + edge.
    const theirs = s.portfolio.businessPortfolio(bid, "operator:owner-two") as {
      objectives: Array<Row>; edges: Array<Row>;
    };
    expect(theirs.objectives.map((o) => String(o.objective_id)).sort())
      .toEqual([c, d].sort());
    expect(theirs.edges.map((e) => String(e.relation_id))).toEqual([rCD.relation_id]);
    s.store.close();
  });

  it("B7 counts honest over the full scoped set", () => {
    const s = fresh("b7");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const r2 = s.relations.create({
      from_objective_id: b, to_objective_id: c, kind: "CONFLICTS", actor: OWNER });
    s.relations.control({ relation_id: r2.relation_id, action: "REVOKE", actor: OWNER });
    const v = view(s, bid);
    expect(v.counts.objectives_owned).toBe(3);
    expect(v.counts.objectives_returned).toBe(3);
    expect(v.counts.objectives_dependency_blocked).toBe(1); // a's upstream pending
    expect(v.counts.relations_total).toBe(2);
    expect(v.counts.relations_by_kind.DEPENDS_ON).toBe(1);
    expect(v.counts.relations_by_kind.CONFLICTS).toBe(1);
    expect(v.counts.relations_by_state.ACTIVE).toBe(1);
    expect(v.counts.relations_by_state.REVOKED).toBe(1);
    expect(v.objectives_truncated ?? false).toBe(false);
    s.store.close();
  });

  it("B8 deterministic ordering — code-unit relation_id, created_at objectives", () => {
    const s = fresh("b8");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    const c = objId(mkObjective(s, bid));
    const d = objId(mkObjective(s, bid));
    s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    s.relations.create({
      from_objective_id: c, to_objective_id: d, kind: "CONFLICTS", actor: OWNER });
    s.relations.create({
      from_objective_id: a, to_objective_id: c, kind: "SUPERSEDES", actor: OWNER });
    const v = view(s, bid);
    const ids = v.edges.map((e) => String(e.relation_id));
    expect(ids).toEqual([...ids].sort());
    // Two identical reads produce byte-identical projections.
    expect(JSON.stringify(view(s, bid))).toBe(JSON.stringify(v));
    s.store.close();
  });

  it("B9 route — owner 200 envelope, non-owner 403 code-only, operator-less 403", async () => {
    const s = fresh("b9");
    const bid = mkBusiness(s);
    const a = objId(mkObjective(s, bid));
    const b = objId(mkObjective(s, bid));
    s.relations.create({
      from_objective_id: a, to_objective_id: b, kind: "DEPENDS_ON", actor: OWNER });
    const server: Server = createMissionControlServer({
      business: s.biz, store: s.store, workforce: s.wf, authToken: "tok-b9" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const hdr = (op?: string) => ({
      authorization: "Bearer tok-b9",
      ...(op ? { "x-operator-id": op } : {}),
    });
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/api/vnext/businesses/${bid}/portfolio`,
        { headers: hdr(OP) });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { portfolio: { objectives: Row[]; edges: Row[] } };
      expect(body.portfolio.objectives).toHaveLength(2);
      expect(body.portfolio.edges).toHaveLength(1);
      // Non-owner: code-only 403 — no scope internals in the response.
      const deny = await fetch(`http://127.0.0.1:${port}/api/vnext/businesses/${bid}/portfolio`,
        { headers: hdr("intruder") });
      expect(deny.status).toBe(403);
      const denyBody = (await deny.json()) as Row;
      expect(denyBody.error).toBe("FAIL_CLOSED_PORTFOLIO_SCOPE");
      expect(denyBody.detail).toBeUndefined();
      // Operator-less: the header is the only authority source.
      const noOp = await fetch(`http://127.0.0.1:${port}/api/vnext/businesses/${bid}/portfolio`,
        { headers: hdr() });
      expect(noOp.status).toBe(403);
      expect(String(((await noOp.json()) as Row).error))
        .toBe("FAIL_CLOSED_OPERATOR_ID_REQUIRED");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.store.close();
    }
  });

  it("B10 truncation — 205 owned: page 200, counts over the full set", () => {
    const s = fresh("b10");
    const bid = mkBusiness(s);
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) ids.push(objId(mkObjective(s, bid)));
    // Block the LAST-created objective — almost certainly beyond the
    // 200-objective display page; its block must still count.
    const last = ids[ids.length - 1]!;
    const up = ids[ids.length - 2]!;
    s.relations.create({
      from_objective_id: last, to_objective_id: up, kind: "DEPENDS_ON", actor: OWNER });
    const v = view(s, bid);
    expect(v.counts.objectives_owned).toBe(205);
    expect(v.counts.objectives_returned).toBe(200);
    expect(v.objectives_truncated).toBe(true);
    expect(v.counts.objectives_dependency_blocked).toBe(1);
    expect(v.counts.relations_total).toBe(1);
    s.store.close();
  });
});
