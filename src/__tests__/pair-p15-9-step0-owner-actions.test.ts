/**
 * Step 0 (P15.9 closure) — owner-action HTTP seam tests.
 *
 * The library-level authority tests live in pair-p15-1 and the read
 * boundary in pair-p15-9a; this file covers ONLY the actual HTTP edge
 * the UI calls — the place where header-vs-body identity, schema
 * coercion and status-code mapping are decided:
 *
 *   H1 — happy path: progress/evidence/amend under the owner header
 *        write canonically; exact-key replay is an idempotent no-op.
 *   H2 — authority: missing header fails closed (403) with NO event
 *        minted; a foreign operator header fails closed.
 *   H3 — body-can-never-be-authority: operator_id/verifier in the
 *        payload cannot substitute for the header (no header → deny;
 *        header present → body identity fields are inert).
 *   H4 — schema: NaN/string/null progress values, missing evidence_key,
 *        non-object patch, wrong-enum amendment field all fail typed.
 *   H5 — garbage-owner objective cannot be claimed by a garbage
 *        header: an objective minted (service-level) with
 *        owner "operator:undefined" is unreachable because the edge
 *        rejects coercion-artifact identities before owner compare.
 *   H6 — create route refuses an absent/empty/garbage operator identity
 *        instead of minting the literal owner "operator:undefined".
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApprovalQueue,
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
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  createMissionControlServer,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-step0-http-"));
let counter = 0;
const OP = "step0-owner";
const OWNER = `operator:${OP}`;
const TOK = "step0-tok";
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}
function eventCount(store: PairEvidenceStore): number {
  return (dbOf(store).prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n;
}

function freshStack(name: string) {
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
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
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
    planExpander: async (input) => ({ input }) });
  const wf = new WorkforceService({ store, business: biz });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { dir, store, biz, wf, projectId: String(project.project_id) };
}

function mkObjective(s: ReturnType<typeof freshStack>, operator = OP) {
  const bid = String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
  const o = s.biz.objectives.create({
    business_id: bid, title: "obj", statement: "s",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: operator,
  });
  return { bid, oid: String(o.objective_id) };
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function serve(s: ReturnType<typeof freshStack>): Promise<string> {
  const server = createMissionControlServer({
    business: s.biz, store: s.store, workforce: s.wf, authToken: TOK });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const hdr = (op?: string) => {
  const h: Record<string, string> = {
    "content-type": "application/json", authorization: `Bearer ${TOK}` };
  if (op !== undefined) h["x-operator-id"] = op;
  return h;
};
const post = (base: string, path: string, body: unknown, op?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: hdr(op), body: JSON.stringify(body) });

describe("Step0 owner-action HTTP seams", () => {
  it("H1 happy path: progress + evidence + amend write canonically; replay is honest", async () => {
    const s = freshStack("h1");
    const { bid, oid } = mkObjective(s);
    const base = await serve(s);

    const ek1 = `ek-h1-${counter}`;
    const p = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 0.5, evidence_key: ek1 }, OP);
    expect(p.status).toBe(200);
    const row = s.biz.objectives.get(oid) as Row;
    const kpi = (row.kpis as Row[])[0]!;
    expect(kpi.current).toBe(0.5);
    // The recorded verifier is the HEADER actor — body never supplies it.
    const ref = (row.evidence_refs as Row[]).at(-1)!;
    expect(String(ref.verifier)).toBe(OWNER);
    expect(String(ref.source)).toBe("owner-console");
    expect(String(ref.kind)).toBe("PROGRESS");

    // Exact-key replay is an idempotent no-op — same row back, no new
    // canonical event minted.
    const before = eventCount(s.store);
    const pReplay = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 0.5, evidence_key: ek1 }, OP);
    expect(pReplay.status).toBe(200);
    expect(eventCount(s.store)).toBe(before);
    // Same key + different semantics → typed conflict, never double-count.
    const conflict = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 0.9, evidence_key: ek1 }, OP);
    expect(conflict.status).toBe(409);

    const e = await post(base, `/api/vnext/objectives/${oid}/evidence`,
      { business_id: bid, kpi_id: KPI, evidence_key: `ek-ev-${counter}`,
        uri: "mem://m1", note: "supporting" }, OP);
    expect(e.status).toBe(200);

    const termsBefore = Number((s.biz.objectives.get(oid) as Row).terms_version);
    const a = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: { title: "amended" } }, OP);
    expect(a.status).toBe(200);
    const after = s.biz.objectives.get(oid) as Row;
    expect(Number(after.terms_version)).toBe(termsBefore + 1);
    expect(String(after.title)).toBe("amended");
    s.store.close();
  });

  it("H2 missing header → 403 fail-closed, zero events minted; foreign operator → 403", async () => {
    const s = freshStack("h2");
    const { bid, oid } = mkObjective(s);
    const base = await serve(s);
    const before = eventCount(s.store);

    const noHdr = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 1, evidence_key: "ek-x" });
    expect(noHdr.status).toBe(403);
    expect(String(((await noHdr.json()) as Row).error)).toBe("FAIL_CLOSED_OPERATOR_ID_REQUIRED");

    const foreign = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 1, evidence_key: "ek-f" }, "555");
    expect(foreign.status).toBe(403);

    const noHdrEv = await post(base, `/api/vnext/objectives/${oid}/evidence`,
      { business_id: bid, kpi_id: KPI, evidence_key: "ek-x" });
    expect(noHdrEv.status).toBe(403);
    const noHdrAm = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: { title: "x" } });
    expect(noHdrAm.status).toBe(403);
    const foreignAm = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: { title: "x" } }, "555");
    expect(foreignAm.status).toBe(403);

    expect(eventCount(s.store)).toBe(before); // denied writes mint nothing
    s.store.close();
  });

  it("H3 body identity fields can never substitute for the header", async () => {
    const s = freshStack("h3");
    const { bid, oid } = mkObjective(s);
    const base = await serve(s);

    // No header + a fully-formed body identity claim → still denied.
    const spoof = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 1, evidence_key: "ek-x",
        operator_id: OP, verifier: OWNER, actor: OWNER });
    expect(spoof.status).toBe(403);

    // Header present + a body verifier spoof → the HEADER actor wins;
    // the recorded verifier is never the body's claim.
    const r = await post(base, `/api/vnext/objectives/${oid}/progress`,
      { business_id: bid, kpi_id: KPI, value: 0.25, evidence_key: `ek-h3-${counter}`,
        operator_id: "intruder", verifier: "operator:intruder" }, OP);
    expect(r.status).toBe(200);
    const row = s.biz.objectives.get(oid) as Row;
    expect(String((row.evidence_refs as Row[]).at(-1)!.verifier)).toBe(OWNER);
    s.store.close();
  });

  it("H4 schema coercion traps all fail typed (never silent zero/null)", async () => {
    const s = freshStack("h4");
    const { bid, oid } = mkObjective(s);
    const base = await serve(s);
    const before = eventCount(s.store);

    for (const [label, extra] of [
      ["nan-string", { value: "abc", evidence_key: "e" }],
      ["numeric-string", { value: "0.5", evidence_key: "e" }],
      ["null-value", { value: null, evidence_key: "e" }],
      ["absent-value", { evidence_key: "e" }],
      ["absent-evidence-key", { value: 0.5 }],
    ] as const) {
      const res = await post(base, `/api/vnext/objectives/${oid}/progress`,
        { business_id: bid, kpi_id: KPI, ...extra }, OP);
      expect(res.status, label).toBe(409);
      expect(String(((await res.json()) as Row).error), label)
        .toBe("FAIL_CLOSED_OBJECTIVE_FIELD");
    }
    const evNoKey = await post(base, `/api/vnext/objectives/${oid}/evidence`,
      { business_id: bid, kpi_id: KPI }, OP);
    expect(evNoKey.status).toBe(409);
    const amBad = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: "title" }, OP);
    expect(amBad.status).toBe(409);
    const amEmpty = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: {} }, OP);
    expect(amEmpty.status).toBe(409);
    const amBadField = await post(base, `/api/vnext/objectives/${oid}/amend`,
      { business_id: bid, patch: { status: "ACHIEVED" } }, OP);
    expect(amBadField.status).toBe(409);
    expect(eventCount(s.store)).toBe(before);
    s.store.close();
  });

  it("H5 objective with garbage owner ref is unreachable via garbage header", async () => {
    const s = freshStack("h5");
    // Service-level create CAN mint a garbage owner ("operator:undefined")
    // — the edge must refuse the matching coercion-artifact identity so
    // no caller can ever satisfy assertOwner for it.
    const { bid, oid } = mkObjective(s, "undefined");
    expect(String((s.biz.objectives.get(oid) as Row).owner_authority_id))
      .toBe("operator:undefined");
    const base = await serve(s);
    for (const bad of ["undefined", "null", "[object Object]"]) {
      const res = await post(base, `/api/vnext/objectives/${oid}/progress`,
        { business_id: bid, kpi_id: KPI, value: 1, evidence_key: `e-${bad}` }, bad);
      expect(res.status, bad).toBe(403);
    }
    s.store.close();
  });

  it("H6 create route refuses absent/empty/garbage operator identity", async () => {
    const s = freshStack("h6");
    const { bid } = mkObjective(s);
    const base = await serve(s);
    const body = {
      business_id: bid, title: "x", statement: "y",
      kpis: [], deadline: FUTURE, budget_ceiling_microusd: 1,
    };
    const noOp = await post(base, "/api/vnext/objectives", body);
    expect(noOp.status).toBe(403);
    const emptyOp = await post(base, "/api/vnext/objectives", body, "");
    expect(emptyOp.status).toBe(403);
    const garbage = await post(base, "/api/vnext/objectives", body, "undefined");
    expect(garbage.status).toBe(403);
    // A real operator still creates — the gate rejects garbage, not
    // operators.
    const ok = await post(base, "/api/vnext/objectives",
      { ...body, dedup_key: `dk-h6-${counter}` }, OP);
    expect(ok.status).toBe(200);
    const created = (await ok.json()) as Row;
    expect(String(created.owner_authority_id)).toBe(OWNER);
    s.store.close();
  });
});
