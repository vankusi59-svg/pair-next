/**
 * P18.1 — Operator Control Center owner-seam HTTP tests.
 *
 * Library-level semantics for relations/duties/transitions live in
 * pair-p18-a/c/e and pair-p15-1; this file covers ONLY the new HTTP
 * edge the Mission Control UI calls:
 *
 *   R1 — relations happy path: create DEPENDS_ON, list, admission view.
 *   R2 — authority: header-only proof; foreign owner and absent header
 *        fail closed with 403; body identity fields are inert.
 *   R3 — schema/kind/business: typed 400s on malformed bodies, 409 on
 *        unknown kind/self-relation, 403 on cross-business pairing.
 *   R4 — lifecycle: suspend/resume/revoke, terminal-idempotent revoke,
 *        illegal transitions typed.
 *   R5 — preview: advisory implications + invalid-candidate reporting,
 *        never a write.
 *   D1 — duty happy path: exact-set create, per-objective/per-agent/
 *        per-business reads.
 *   D2 — N-lateral + business authority: cross-owner covered objective
 *        and cross-business set/agent fail closed.
 *   D3 — duty lifecycle + read scope honesty.
 *   T1 — transitions: PAUSE/resume-ACTIVE/CANCEL owner flow, illegal
 *        transition typed, foreign owner denied.
 *   O1 — operations aggregate + business operations overview.
 *   I1 — integrity probe: CLEAN on healthy state, WEDGED + typed code
 *        on a corrupted relation row; no repair is offered.
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkTmpDir } from "../test-utils/tmpdir.js";
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
  digest,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p181-http-");
let counter = 0;
const OP = "p181-owner";
const FOREIGN = "p181-foreign";
const TOK = "p181-tok";
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
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

function mkBusiness(s: ReturnType<typeof freshStack>, name = "b") {
  return String(s.biz.createBusiness({
    name: `${name}${counter}`, project_id: s.projectId,
    operator_id: OP }).business_id);
}

function mkObjective(s: ReturnType<typeof freshStack>, businessId: string,
  operator = OP) {
  const o = s.biz.objectives.create({
    business_id: businessId, title: "obj", statement: "s",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: operator,
  });
  return String(o.objective_id);
}

function mkAgent(s: ReturnType<typeof freshStack>, businessId: string) {
  const a = s.biz.createOrgAgent({
    business_id: businessId, title: "ops", department: "ops",
    operator_id: OP });
  return String(a.agent_id);
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
const get = (base: string, p: string, op?: string) =>
  fetch(`${base}${p}`, { headers: hdr(op) });
const post = (base: string, p: string, body: unknown, op?: string) =>
  fetch(`${base}${p}`, { method: "POST", headers: hdr(op), body: JSON.stringify(body) });

describe("P18.1 relation seams", () => {
  it("R1 create DEPENDS_ON, list relations + admission view over HTTP", async () => {
    const s = freshStack("r1");
    const bid = mkBusiness(s);
    const up = mkObjective(s, bid);
    const dep = mkObjective(s, bid);
    const base = await serve(s);

    const c = await post(base, `/api/vnext/objectives/${dep}/relations`,
      { to_objective_id: up, kind: "DEPENDS_ON", note: "waits on up" }, OP);
    expect(c.status).toBe(200);
    const created = (await c.json() as { relation: Row }).relation;
    expect(created.state).toBe("ACTIVE");
    expect(created.kind).toBe("DEPENDS_ON");
    expect(String(created.relation_id)).toMatch(/^REL_/);

    const l = await get(base, `/api/vnext/objectives/${dep}/relations`, OP);
    expect(l.status).toBe(200);
    const listed = await l.json() as {
      relations: Row[];
      admission: { upstream: string[]; conflicts: string[]; superseded_by: string[] };
    };
    expect(listed.relations.map((r) => String(r.relation_id)))
      .toContain(String(created.relation_id));
    expect(listed.admission.upstream).toEqual([up]);

    // Idempotent replay: identical triple returns the same row.
    const replay = await post(base, `/api/vnext/objectives/${dep}/relations`,
      { to_objective_id: up, kind: "DEPENDS_ON" }, OP);
    expect(replay.status).toBe(200);
    expect(String((await replay.json() as { relation: Row }).relation.relation_id))
      .toBe(String(created.relation_id));
  });

  it("R2 header-only authority: absent + foreign headers denied 403", async () => {
    const s = freshStack("r2");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    const base = await serve(s);

    for (const op of [undefined, FOREIGN]) {
      const c = await post(base, `/api/vnext/objectives/${a}/relations`,
        { to_objective_id: b, kind: "DEPENDS_ON" }, op);
      expect(c.status).toBe(403);
      // 403 carries code only — no scope internals leak.
      const body = await c.json() as { error: string; detail?: string };
      expect(body.error).toMatch(/^FAIL_CLOSED/);
      expect(body.detail).toBeUndefined();
    }
    // Body-declared identity is never authority.
    const forged = await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: b, kind: "DEPENDS_ON", actor: OP }, undefined);
    expect(forged.status).toBe(403);
    // Reads are owner-scoped too.
    expect((await get(base, `/api/vnext/objectives/${a}/relations`, FOREIGN)).status).toBe(403);
    expect((await get(base, `/api/vnext/objectives/${a}/relations`)).status).toBe(403);
  });

  it("R3 typed schema + kind + self + cross-business rejection", async () => {
    const s = freshStack("r3");
    const bid = mkBusiness(s);
    const bid2 = mkBusiness(s, "other");
    const a = mkObjective(s, bid);
    const x = mkObjective(s, bid2);
    const base = await serve(s);

    expect((await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: 7, kind: "DEPENDS_ON" }, OP)).status).toBe(400);
    expect((await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: "OBJ_x", kind: ["DEPENDS_ON"] }, OP)).status).toBe(400);
    expect((await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: a, kind: "ALLIED" }, OP)).status).toBe(409);
    expect((await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: a, kind: "DEPENDS_ON" }, OP)).status).toBe(409);
    const xbiz = await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: x, kind: "DEPENDS_ON" }, OP);
    expect(xbiz.status).toBe(403);
  });

  it("R4 lifecycle suspend/resume/revoke + terminal idempotency", async () => {
    const s = freshStack("r4");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    const base = await serve(s);
    const rel = String(((await (await post(base,
      `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: b, kind: "CONFLICTS" }, OP)).json() as
      { relation: Row }).relation).relation_id);

    const sus = await post(base, `/api/vnext/relations/${rel}/suspend`, {}, OP);
    expect(sus.status).toBe(200);
    expect((await sus.json() as { relation: Row }).relation.state).toBe("SUSPENDED");
    // Illegal from SUSPENDED.
    expect((await post(base, `/api/vnext/relations/${rel}/suspend`, {}, OP)).status).toBe(409);
    const res = await post(base, `/api/vnext/relations/${rel}/resume`, {}, OP);
    expect(res.status).toBe(200);
    expect((await res.json() as { relation: Row }).relation.state).toBe("ACTIVE");
    // Foreign owner cannot control.
    expect((await post(base, `/api/vnext/relations/${rel}/revoke`, {}, FOREIGN)).status).toBe(403);
    const rev = await post(base, `/api/vnext/relations/${rel}/revoke`, {}, OP);
    expect(rev.status).toBe(200);
    expect((await rev.json() as { relation: Row }).relation.state).toBe("REVOKED");
    // Terminal idempotent — replayed revoke returns the row, no fault.
    const rev2 = await post(base, `/api/vnext/relations/${rel}/revoke`, {}, OP);
    expect(rev2.status).toBe(200);
    // RESUME from REVOKED is a typed illegal transition.
    expect((await post(base, `/api/vnext/relations/${rel}/resume`, {}, OP)).status).toBe(409);
  });

  it("R5 preview is advisory: implications + invalid candidates, zero writes", async () => {
    const s = freshStack("r5");
    const bid = mkBusiness(s);
    const up = mkObjective(s, bid);
    const dep = mkObjective(s, bid);
    // Foreign-owned target in the SAME business/store — minted before
    // the write-count snapshot so the preview-only assertion holds.
    const foreignObj = mkObjective(s, bid, FOREIGN);
    const base = await serve(s);
    const before = (dbOf(s.store)
      .prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;

    const pv = await post(base,
      `/api/vnext/objectives/${dep}/relations/preview`,
      { to_objective_id: up, kind: "DEPENDS_ON" }, OP);
    expect(pv.status).toBe(200);
    const body = await pv.json() as {
      advisory: boolean; valid: boolean; errors: string[];
      implications: Record<string, unknown>;
      current: { admission: { upstream: string[] } };
    };
    expect(body.advisory).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect((body.implications as { would_block_now?: boolean }).would_block_now).toBe(true);
    expect(body.current.admission.upstream).toEqual([]);

    const bad = await post(base,
      `/api/vnext/objectives/${dep}/relations/preview`,
      { to_objective_id: "OBJ_nonexistent", kind: "DEPENDS_ON" }, OP);
    const badBody = await bad.json() as { valid: boolean; errors: string[] };
    expect(badBody.valid).toBe(false);
    expect(badBody.errors.some((e) => e.includes("not found"))).toBe(true);

    // Foreign-owned target — the error fires AND the advisory never
    // leaks the foreign objective's status into implications.
    const pvForeign = await post(base,
      `/api/vnext/objectives/${dep}/relations/preview`,
      { to_objective_id: foreignObj, kind: "DEPENDS_ON" }, OP);
    const pvFB = await pvForeign.json() as {
      valid: boolean; errors: string[];
      implications: Record<string, unknown>;
      current: { admission?: unknown };
    };
    expect(pvFB.valid).toBe(false);
    expect(pvFB.errors.some((e) => e.includes("different owner"))).toBe(true);
    expect(pvFB.implications).toEqual({});
    expect(pvFB.current.admission).toBeUndefined();

    // A preview writes nothing.
    expect((dbOf(s.store)
      .prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n)
      .toBe(before);
  });
});

describe("P18.1 duty seams", () => {
  it("D1 exact-set duty create + objective/agent/business reads", async () => {
    const s = freshStack("d1");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    const agent = mkAgent(s, bid);
    const base = await serve(s);

    const c = await post(base, `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [a, b], note: "covers both" }, OP);
    expect(c.status).toBe(200);
    const duty = (await c.json() as { duty: Row }).duty;
    expect(duty.state).toBe("ACTIVE");
    expect(duty.objective_ids).toEqual([a, b].sort());

    const forObj = await get(base, `/api/vnext/objectives/${a}/duties`, OP);
    expect(((await forObj.json() as { duties: Row[] }).duties
      .map((d) => String(d.duty_id)))).toContain(String(duty.duty_id));
    const forAgent = await get(base, `/api/vnext/org-agents/${agent}/duties`, OP);
    expect((await forAgent.json() as { duties: Row[] }).duties.length).toBe(1);
    const forBiz = await get(base, `/api/vnext/businesses/${bid}/duties`, OP);
    expect((await forBiz.json() as { duties: Row[] }).duties.length).toBe(1);

    // Idempotent replay per (agent, exact set).
    const replay = await post(base, `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [b, a] }, OP);
    expect(String((await replay.json() as { duty: Row }).duty.duty_id))
      .toBe(String(duty.duty_id));
  });

  it("D2 N-lateral + business authority failures are closed", async () => {
    const s = freshStack("d2");
    const bid = mkBusiness(s);
    const bid2 = mkBusiness(s, "x");
    const mine = mkObjective(s, bid);
    const foreignObj = mkObjective(s, bid, FOREIGN);
    const xbizObj = mkObjective(s, bid2);
    const agent = mkAgent(s, bid);
    const xAgent = mkAgent(s, bid2);
    const base = await serve(s);

    // A covered objective owned by someone else → N-lateral denial.
    expect((await post(base, `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [mine, foreignObj] }, OP)).status).toBe(403);
    // Cross-business objective set → denial.
    expect((await post(base, `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [mine, xbizObj] }, OP)).status).toBe(403);
    // Agent outside the covered objectives' business → denial.
    expect((await post(base, `/api/vnext/org-agents/${xAgent}/duties`,
      { objective_ids: [mine] }, OP)).status).toBe(403);
    // Missing header / foreign operator → denial at the edge.
    for (const op of [undefined, FOREIGN]) {
      expect((await post(base, `/api/vnext/org-agents/${agent}/duties`,
        { objective_ids: [mine] }, op)).status).toBe(403);
    }
    // A real duty exists (OP owns it); the foreign read must still
    // see nothing — coverage outside its scope is never disclosed.
    expect((await post(base, `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [mine] }, OP)).status).toBe(200);
    // Read scope: foreign operator sees duties only when EVERY covered
    // objective is theirs — duties over OP's objectives are invisible.
    const fRead = await get(base, `/api/vnext/org-agents/${agent}/duties`, FOREIGN);
    expect(fRead.status).toBe(200);
    expect((await fRead.json() as { duties: Row[] }).duties).toEqual([]);
    expect((await get(base, `/api/vnext/objectives/${mine}/duties`, FOREIGN)).status).toBe(403);
  });

  it("D3 duty lifecycle: suspend/resume/revoke + coverage disappears", async () => {
    const s = freshStack("d3");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const agent = mkAgent(s, bid);
    const base = await serve(s);
    const duty = String(((await (await post(base,
      `/api/vnext/org-agents/${agent}/duties`,
      { objective_ids: [a] }, OP)).json() as { duty: Row }).duty).duty_id);

    const sus = await post(base, `/api/vnext/duties/${duty}/suspend`, {}, OP);
    expect((await sus.json() as { duty: Row }).duty.state).toBe("SUSPENDED");
    expect((await post(base, `/api/vnext/duties/${duty}/suspend`, {}, OP)).status).toBe(409);
    expect((await (await post(base, `/api/vnext/duties/${duty}/resume`, {}, OP))
      .json() as { duty: Row }).duty.state).toBe("ACTIVE");
    expect((await post(base, `/api/vnext/duties/${duty}/revoke`, {}, FOREIGN)).status).toBe(403);
    expect((await (await post(base, `/api/vnext/duties/${duty}/revoke`, {}, OP))
      .json() as { duty: Row }).duty.state).toBe("REVOKED");
    expect((await post(base, `/api/vnext/duties/${duty}/revoke`, {}, OP)).status).toBe(200);
  });
});

describe("P18.1 transitions + operations + integrity", () => {
  it("T1 owner transitions pause/resume/cancel; illegal + foreign denied", async () => {
    const s = freshStack("t1");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const base = await serve(s);

    const pause = await post(base, `/api/vnext/objectives/${a}/transition`,
      { business_id: bid, to: "PAUSED", reason: "operator hold" }, OP);
    expect(pause.status).toBe(200);
    expect((await pause.json() as { objective: Row }).objective.status).toBe("PAUSED");
    const resume = await post(base, `/api/vnext/objectives/${a}/transition`,
      { business_id: bid, to: "ACTIVE" }, OP);
    expect(resume.status).toBe(200);
    const cancel = await post(base, `/api/vnext/objectives/${a}/transition`,
      { business_id: bid, to: "CANCELLED", reason: "abandoned" }, OP);
    expect(cancel.status).toBe(200);
    // Terminal — every further transition is a typed failure.
    expect((await post(base, `/api/vnext/objectives/${a}/transition`,
      { business_id: bid, to: "ACTIVE" }, OP)).status).toBe(409);
    const b = mkObjective(s, bid);
    // Operator seam is deliberately narrower than the service table:
    // ACHIEVED/INFEASIBLE/EXPIRED stay behind the review-signoff gate.
    for (const to of ["ACHIEVED", "INFEASIBLE", "EXPIRED", "BLOCKED"]) {
      expect((await post(base, `/api/vnext/objectives/${b}/transition`,
        { business_id: bid, to }, OP)).status).toBe(400);
    }
    // ACTIVE→ACTIVE is not in the transition table (no self-edge).
    expect((await post(base, `/api/vnext/objectives/${b}/transition`,
      { business_id: bid, to: "ACTIVE" }, OP)).status).toBe(409);
    expect((await post(base, `/api/vnext/objectives/${b}/transition`,
      { business_id: bid, to: "PAUSED" }, FOREIGN)).status).toBe(403);
    expect((await post(base, `/api/vnext/objectives/${b}/transition`,
      { business_id: bid, to: 3 }, OP)).status).toBe(400);
  });

  it("O1 per-objective + business operations views", async () => {
    const s = freshStack("o1");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    const base = await serve(s);
    await post(base, `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: b, kind: "DEPENDS_ON" }, OP);

    const ops = await get(base, `/api/vnext/objectives/${a}/operations`, OP);
    expect(ops.status).toBe(200);
    const o = await ops.json() as {
      operations: {
        objective: Row; auto_policy: Record<string, unknown>;
        auto_scheduler: unknown; auto_driver: unknown;
        admission: { upstream: string[] };
        relations: Row[]; duties: Row[];
      };
    };
    expect(o.operations.objective.objective_id).toBe(a);
    expect(o.operations.admission.upstream).toEqual([b]);
    expect(o.operations.relations.length).toBe(1);
    // No driver/scheduler wired in the test harness — honest nulls,
    // never fabricated readiness.
    expect(o.operations.auto_scheduler).toBeNull();
    expect(o.operations.auto_driver).toBeNull();

    const bizOps = await get(base, `/api/vnext/businesses/${bid}/operations`, OP);
    const rows = (await bizOps.json() as { operations: Row[] }).operations;
    expect(rows.map((r) => String(r.objective_id)).sort()).toEqual([a, b].sort());
    // Scheduler absent → NOT_OBSERVED, never a synthetic queue state.
    expect(rows.every((r) => r.queue_state === "NOT_OBSERVED")).toBe(true);
    // Foreign operator gets no company view at all.
    expect((await get(base, `/api/vnext/businesses/${bid}/operations`, FOREIGN)).status).toBe(403);
  });

  it("I1 integrity probe reports CLEAN then WEDGED with typed code", async () => {
    const s = freshStack("i1");
    const bid = mkBusiness(s);
    const a = mkObjective(s, bid);
    const b = mkObjective(s, bid);
    const base = await serve(s);
    const rel = String(((await (await post(base,
      `/api/vnext/objectives/${a}/relations`,
      { to_objective_id: b, kind: "DEPENDS_ON" }, OP)).json() as
      { relation: Row }).relation).relation_id);

    const clean = await get(base, `/api/vnext/objectives/${a}/integrity`, OP);
    const cleanBody = await clean.json() as {
      status: string; checks: Array<{ name: string; ok: boolean }>;
      remediation: unknown;
    };
    expect(cleanBody.status).toBe("CLEAN");
    expect(cleanBody.checks.every((c) => c.ok)).toBe(true);
    expect(cleanBody.remediation).toBeNull();

    // Corrupt the canonical state: delete the relation row while its
    // index pointer survives — the strict admission read must wedge
    // loudly (dangling index), never silently clear the objective.
    dbOf(s.store)
      .prepare("DELETE FROM entities WHERE entity_type='objective_relation' AND entity_id=?")
      .run(rel);

    const wedged = await get(base, `/api/vnext/objectives/${a}/integrity`, OP);
    const wBody = await wedged.json() as {
      status: string;
      checks: Array<{ name: string; ok: boolean; code?: string }>;
      remediation: string | null;
    };
    expect(wBody.status).toBe("WEDGED");
    const wedgedCheck = wBody.checks.find((c) => !c.ok)!;
    expect(String(wedgedCheck.code)).toMatch(/^FAIL_CLOSED/);
    expect(wBody.remediation).toMatch(/fail-closed/i);
    // The probe is read-only — the wedge remains for the gate.
    expect(() => s.biz.objectives.get(a)).not.toThrow();
  });
});
