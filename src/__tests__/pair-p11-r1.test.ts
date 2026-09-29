/**
 * P11 REMEDIATION R1 tests — crash-safe open↔mission linkage, atomic CAS,
 * atomic budget reservations, block/cancel semantics, routine isolation and
 * atomic projection dedup. Uses two independent PairEvidenceStore
 * connections on the same DB file for genuine cross-connection races, plus
 * fault injection at each open boundary and restart reconciliation sweeps.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ReconciliationService,
  RecoveryController,
  createMissionControlServer,
  newId,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p11r1-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const ALL_CAPS = [
  "FILE_OPERATIONS", "NETWORK_ACCESS", "SHELL_EXECUTION", "LLM_INFERENCE",
  "DEVIN_DELEGATION", "CREDENTIAL_ACCESS", "EVIDENCE_WRITE", "PLAN_GOVERNANCE",
  "SELF_MODIFY_CODE", "TELEGRAM_SEND", "BROWSER_USE", "DATA_STORE_WRITE",
];

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

function makeCtxOn(dbPath: string, dir: string, opts: { planner?: PlannerFn } = {}) {
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const planner: PlannerFn =
    opts.planner ??
    (() => ({ tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }));
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name: "biz", root_location: workspace });
  return { dir, store, service, control, projectId: String(project.project_id) };
}

function makeBizCtx(name: string) {
  const dir = freshDir(name);
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { dir, ctx, biz, schedules };
}

/** A second independent stack on the SAME db file — separate connection. */
function makeSecondBiz(dir: string) {
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz, schedules };
}

function setupBusiness(biz: BusinessLayer, projectId: string, name = "Biz") {
  const b = biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
  return b;
}

function makeWorkItem(biz: BusinessLayer, businessId: string, title = "w") {
  return biz.createWorkItem({
    business_id: businessId, title, goal: "do " + title, operator_id: "op",
  });
}

/* --------------------------- R1 §2 atomic CAS ----------------------------- */

describe("R1 §2 atomic CAS — two connections, same DB", () => {
  it("same-entity concurrent update: exactly one winner, loser gets FAIL_CLOSED_VERSION_CONFLICT", () => {
    const { dir } = makeBizCtx("cas1");
    const db = path.join(dir, "pair.db");
    const s1 = new PairEvidenceStore(db);
    const s2 = new PairEvidenceStore(db);
    s1.put("probe", "e1", { version: 0, x: 1 }, 0);
    const a = s1.get("probe", "e1");
    const b = s2.get("probe", "e1");
    a.x = 100;
    b.x = 200;
    s1.put("probe", "e1", a, Number(a.version));
    expect(() => s2.put("probe", "e1", b, Number(b.version)))
      .toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
    expect(Number(s1.get("probe", "e1").x)).toBe(100);
    s1.close();
    s2.close();
  });

  it("concurrent create of same entity id: exactly one creates, loser conflicts", () => {
    const { dir } = makeBizCtx("cas2");
    const db = path.join(dir, "pair.db");
    const s1 = new PairEvidenceStore(db);
    const s2 = new PairEvidenceStore(db);
    s1.put("probe", "dup", { version: 0, x: 1 }, 0);
    expect(() => s2.put("probe", "dup", { version: 0, x: 2 }, 0))
      .toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
    s1.close();
    s2.close();
  });

  it("stale writer on second connection conflicts after first connection wins", () => {
    const { dir } = makeBizCtx("cas3");
    const db = path.join(dir, "pair.db");
    const s1 = new PairEvidenceStore(db);
    const s2 = new PairEvidenceStore(db);
    s1.put("probe", "stale", { version: 0 }, 0);
    const stale = s2.get("probe", "stale"); // reads v1
    s1.put("probe", "stale", { ...s1.get("probe", "stale"), x: 9 }, 1); // → v2
    expect(() => s2.put("probe", "stale", stale, Number(stale.version)))
      .toThrowError(/FAIL_CLOSED_VERSION_CONFLICT/);
    s1.close();
    s2.close();
  });

  it("simultaneous work-item claims on two connections: one winner only", () => {
    const { dir, ctx, biz } = makeBizCtx("cas4");
    const b = setupBusiness(biz, ctx.projectId);
    const a = biz.createOrgAgent({ business_id: String(b.business_id), title: "T", department: "d", operator_id: "op" });
    const a2 = biz.createOrgAgent({ business_id: String(b.business_id), title: "T2", department: "d", operator_id: "op" });
    const w = makeWorkItem(biz, String(b.business_id));
    const biz2 = makeSecondBiz(dir).biz;
    const c1 = biz.claimWorkItem(String(w.work_item_id), String(a.agent_id), "op");
    expect(c1.claim_token).toBeTruthy();
    expect(() => biz2.claimWorkItem(String(w.work_item_id), String(a2.agent_id), "op"))
      .toThrowError(/FAIL_CLOSED_WORK_ITEM_CLAIMED|FAIL_CLOSED_VERSION_CONFLICT/);
  });

  it("integrity verification stays clean after contended writes", () => {
    const { dir } = makeBizCtx("cas5");
    const db = path.join(dir, "pair.db");
    const s1 = new PairEvidenceStore(db);
    const s2 = new PairEvidenceStore(db);
    s1.put("probe", "v", { version: 0 }, 0);
    const r = s1.get("probe", "v");
    s2.put("probe", "v", r, Number(r.version));
    const counts = s1.verifyIntegrity();
    expect(counts.entities).toBeGreaterThan(0);
    s1.close();
    s2.close();
  });
});

/* ------------------ R1 §1 crash-safe work-item↔mission linkage ------------- */

function faultingControl(control: MissionControl, mode: "pre" | "post"): MissionControl {
  const stub = Object.create(control) as MissionControl;
  // V2: openWorkItem dispatches through the internal bound-mission seam —
  // faults land on startBoundMission, not the public startMission path.
  if (mode === "pre") {
    stub.startBoundMission = () => {
      throw new PolicyError("INJECT_FAIL", "before mission creation");
    };
  } else {
    const real = control.startBoundMission.bind(control);
    stub.startBoundMission = (input) => {
      real(input);
      throw new PolicyError("INJECT_FAIL", "after mission creation");
    };
  }
  return stub;
}

describe("R1 §1 crash-safe linkage — fault injection at each boundary", () => {
  it("failure BEFORE mission creation rolls back to openable state with no mission", () => {
    const { ctx, biz, schedules } = makeBizCtx("fi1");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const badBiz = new BusinessLayer({ store: ctx.store, control: faultingControl(ctx.control, "pre"), schedules });
    expect(() => badBiz.openWorkItem(String(w.work_item_id), "op")).toThrowError(/INJECT_FAIL/);
    const cur = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(cur.status)).toBe("BACKLOG");
    expect(cur.pending_open_id ?? null).toBeNull();
    expect(ctx.store.list("mission")).toHaveLength(0);
    const evs = ctx.store.listEvents("work_item", String(w.work_item_id));
    expect(evs.some((e) => String(e.event_type) === "WORK_ITEM_OPEN_ROLLED_BACK")).toBe(true);
  });

  it("failure AFTER mission creation reconciles instead of duplicating or rolling back over a live mission", () => {
    const { ctx, biz, schedules } = makeBizCtx("fi2");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const badBiz = new BusinessLayer({ store: ctx.store, control: faultingControl(ctx.control, "post"), schedules });
    const out = badBiz.openWorkItem(String(w.work_item_id), "op");
    expect(String(out.status)).toBe("IN_PROGRESS");
    const mids = out.mission_ids as string[];
    expect(mids).toHaveLength(1);
    const mission = ctx.store.get("mission", mids[0]);
    const md = mission.metadata as Record<string, unknown>;
    expect(String(md.work_item_open_id)).toBeTruthy();
    const evs = ctx.store.listEvents("work_item", String(w.work_item_id));
    expect(evs.some((e) => String(e.event_type) === "WORK_ITEM_OPEN_RECONCILED")).toBe(true);
  });

  it("failure at the backlink write is repaired by reconcile (mission linked, item stays IN_PROGRESS)", () => {
    const { ctx, biz, schedules } = makeBizCtx("fi3");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    // Throw exactly once on the linked write (pending cleared + mission appended).
    const realPut = ctx.store.put.bind(ctx.store);
    let fired = false;
    ctx.store.put = ((t: string, id: string, p: Record<string, unknown>, v?: number) => {
      if (
        !fired && t === "work_item" && id === String(w.work_item_id) &&
        p.pending_open_id === null && (p.mission_ids as string[]).length === 1
      ) {
        fired = true;
        throw new PolicyError("INJECT_FAIL", "backlink put");
      }
      return realPut(t, id, p, v);
    }) as typeof ctx.store.put;
    const out = biz.openWorkItem(String(w.work_item_id), "op");
    expect(String(out.status)).toBe("IN_PROGRESS");
    expect((out.mission_ids as string[]).length).toBe(1);
    ctx.store.put = realPut;
  });

  it("failure AFTER backlink write does not roll back over a linked mission", () => {
    const { ctx, biz, schedules } = makeBizCtx("fi4");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const realEvent = ctx.store.event.bind(ctx.store);
    let fired = false;
    ctx.store.event = ((params: { event_type: string }) => {
      if (!fired && params.event_type === "WORK_ITEM_OPENED") {
        fired = true;
        throw new PolicyError("INJECT_FAIL", "event write");
      }
      return realEvent(params as Parameters<typeof realEvent>[0]);
    }) as typeof ctx.store.event;
    expect(() => biz.openWorkItem(String(w.work_item_id), "op")).toThrowError(/INJECT_FAIL/);
    const cur = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(cur.status)).toBe("IN_PROGRESS");
    expect((cur.mission_ids as string[]).length).toBe(1);
    ctx.store.event = realEvent;
  });

  it("restart sweep links an orphaned mission by open_id (durable intent survives)", () => {
    const { ctx, biz, schedules } = makeBizCtx("fi5");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    // Simulate a crashed open: marker persisted, mission exists, no
    // backlink. V2: a real crash orphan always carries its canonical
    // binding INTENT with the mission_id pinned up front.
    const openId = "OPI_crash_test";
    const orphanMissionId = newId("MSN");
    const row = ctx.store.get("work_item", String(w.work_item_id));
    row.status = "IN_PROGRESS";
    row.pending_open_id = openId;
    row.pending_open_at = new Date(Date.now() - 120_000).toISOString(); // past grace
    ctx.store.put("work_item", String(w.work_item_id), row, Number(row.version));
    ctx.store.put("work_open_binding", openId, {
      open_id: openId, work_item_id: String(w.work_item_id),
      business_id: String(b.business_id), project_id: ctx.projectId,
      org_agent_id: row.assignee_agent_id ?? null, created_by: "op",
      mission_id: orphanMissionId, state: "INTENT",
      created_at: new Date().toISOString(), bound_at: null, rolled_back_at: null,
      updated_at: new Date().toISOString(), version: 0,
    } as never, 0);
    const mission = ctx.control.startBoundMission({
      project_id: ctx.projectId,
      goal: "crashed open",
      mission_id: orphanMissionId,
      metadata: { business_id: String(b.business_id), work_item_id: String(w.work_item_id), work_item_open_id: openId },
      operator_id: "op",
    });
    const board = biz.board(String(b.business_id));
    const found = board.IN_PROGRESS.find((x) => String(x.work_item_id) === String(w.work_item_id));
    expect(found).toBeTruthy();
    expect((found!.mission_ids as string[])).toContain(String(mission.mission_id));
    expect(found!.pending_open_id ?? null).toBeNull();
    const evs = ctx.store.listEvents("work_item", String(w.work_item_id));
    expect(evs.some((e) => String(e.event_type) === "WORK_ITEM_OPEN_RECONCILED")).toBe(true);
  });

  it("restart sweep rolls back a pending intent when provably no mission exists", () => {
    const { ctx, biz } = makeBizCtx("fi6");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const row = ctx.store.get("work_item", String(w.work_item_id));
    row.status = "IN_PROGRESS";
    row.pending_open_id = "OPI_dead";
    row.pending_open_at = new Date(Date.now() - 120_000).toISOString();
    ctx.store.put("work_item", String(w.work_item_id), row, Number(row.version));
    const board = biz.board(String(b.business_id));
    const found = board.READY.find((x) => String(x.work_item_id) === String(w.work_item_id));
    expect(found).toBeTruthy();
    expect(found!.pending_open_id ?? null).toBeNull();
    const evs = ctx.store.listEvents("work_item", String(w.work_item_id));
    expect(evs.some((e) => String(e.event_type) === "WORK_ITEM_OPEN_ROLLED_BACK")).toBe(true);
  });

  it("double open across two connections cannot mint two missions", () => {
    const { dir, ctx, biz } = makeBizCtx("fi7");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    biz.openWorkItem(String(w.work_item_id), "op");
    const biz2 = makeSecondBiz(dir).biz;
    expect(() => biz2.openWorkItem(String(w.work_item_id), "op")).toThrowError(/FAIL_CLOSED/);
    expect(ctx.store.list("mission")).toHaveLength(1);
  });
});

/* --------------------- R1 §3 atomic budget reservation -------------------- */

describe("R1 §3 budget reservations — durable, atomic, restart-safe", () => {
  it("two opens at business max=1: exactly one mission; loser fails closed and rolls back", () => {
    const { dir, ctx, biz } = makeBizCtx("bud1");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 1, operator_id: "op",
    });
    const w1 = makeWorkItem(biz, String(b.business_id), "w1");
    const w2 = makeWorkItem(biz, String(b.business_id), "w2");
    biz.openWorkItem(String(w1.work_item_id), "op");
    const second = makeSecondBiz(dir);
    expect(() => second.biz.openWorkItem(String(w2.work_item_id), "op"))
      .toThrowError(/FAIL_CLOSED_BUDGET_EXCEEDED/);
    const w2row = second.ctx.store.get("work_item", String(w2.work_item_id));
    expect(String(w2row.status)).toBe("BACKLOG"); // rolled back to its pre-open state
    expect(ctx.store.list("mission")).toHaveLength(1);
    const evs = second.ctx.store.listEvents("budget_policy");
    expect(evs.some((e) => String(e.event_type) === "BUDGET_EXCEEDED")).toBe(true);
  });

  it("a HELD reservation on one connection blocks an open on the other", () => {
    const { dir, ctx, biz } = makeBizCtx("bud2");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 1, operator_id: "op",
    });
    const s2 = makeSecondBiz(dir);
    s2.ctx.store.put("budget_reservation", "BRS_held", {
      reservation_id: "BRS_held", business_id: String(b.business_id),
      department: null, agent_id: null, status: "HELD", ref_id: "other-open",
      created_at: utcnow(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      version: 0,
    }, 0);
    const w = makeWorkItem(biz, String(b.business_id));
    expect(() => biz.openWorkItem(String(w.work_item_id), "op"))
      .toThrowError(/FAIL_CLOSED_BUDGET_EXCEEDED/);
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("failed open releases capacity: failed-then-allowed consumes exactly one unit", () => {
    const { ctx, biz, schedules } = makeBizCtx("bud3");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 1, operator_id: "op",
    });
    const w1 = makeWorkItem(biz, String(b.business_id), "fail-open");
    const badBiz = new BusinessLayer({ store: ctx.store, control: faultingControl(ctx.control, "pre"), schedules });
    expect(() => badBiz.openWorkItem(String(w1.work_item_id), "op")).toThrowError(/INJECT_FAIL/);
    // The failed attempt must not consume the only budget unit.
    const w2 = makeWorkItem(biz, String(b.business_id), "ok-open");
    biz.openWorkItem(String(w2.work_item_id), "op");
    expect(ctx.store.list("mission")).toHaveLength(1);
  });

  it("stale HELD reservation expires and frees the slot", () => {
    const { ctx, biz } = makeBizCtx("bud4");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 1, operator_id: "op",
    });
    ctx.store.put("budget_reservation", "BRS_stale", {
      reservation_id: "BRS_stale", business_id: String(b.business_id),
      department: null, agent_id: null, status: "HELD", ref_id: "crashed",
      created_at: utcnow(),
      expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
      version: 0,
    }, 0);
    const w = makeWorkItem(biz, String(b.business_id));
    biz.openWorkItem(String(w.work_item_id), "op");
    expect(ctx.store.list("mission")).toHaveLength(1);
    expect(String(ctx.store.get("budget_reservation", "BRS_stale").status)).toBe("RELEASED");
  });
});

/* ----------------- R1 §4+§5 block/reopen/cancel semantics ----------------- */

describe("R1 §4-§5 block, reopen guard, real cancel", () => {
  it("IN_PROGRESS block → reopen cannot create a second mission while first is live", () => {
    const { ctx, biz } = makeBizCtx("blk1");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    biz.openWorkItem(String(w.work_item_id), "op");
    biz.blockWorkItem(String(w.work_item_id), "pause it", "op");
    expect(() => biz.openWorkItem(String(w.work_item_id), "op"))
      .toThrowError(/FAIL_CLOSED_MISSION_ACTIVE|FAIL_CLOSED_WORK_ITEM_TRANSITION/);
    expect(ctx.store.list("mission")).toHaveLength(1);
  });

  it("terminal last mission → legitimate reopen appends exactly one new mission", () => {
    const { ctx, biz } = makeBizCtx("blk2");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    biz.openWorkItem(String(w.work_item_id), "op");
    const wid = String(w.work_item_id);
    const first = (ctx.store.get("work_item", wid).mission_ids as string[])[0];
    biz.blockWorkItem(wid, "hold", "op"); // item BLOCKED; mission still live
    ctx.control.cancelMission(first, "op"); // governed: last mission → CANCELLED
    const out = biz.openWorkItem(wid, "op");
    expect((out.mission_ids as string[]).length).toBe(2);
    expect(ctx.store.list("mission")).toHaveLength(2);
  });

  it("cancelWorkItem on IN_PROGRESS cancels the live mission via MissionControl and drops item to CANCELLED", () => {
    const { ctx, biz } = makeBizCtx("blk3");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mid = (opened.mission_ids as string[])[0];
    const out = biz.cancelWorkItem(String(w.work_item_id), "op");
    expect(String(out.status)).toBe("CANCELLED");
    expect(String(ctx.store.get("mission", mid).status)).toBe("CANCELLED");
  });

  it("cancelWorkItem on READY (no mission) cancels the item without a mission write", () => {
    const { ctx, biz } = makeBizCtx("blk4");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const out = biz.cancelWorkItem(String(w.work_item_id), "op");
    expect(String(out.status)).toBe("CANCELLED");
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("E2E: POST /api/work-items/:id/cancel really cancels the live mission + item", async () => {
    const { ctx, biz } = makeBizCtx("blk5");
    const server = createMissionControlServer({ control: ctx.control, business: biz });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", "x-operator-id": "op" };
    try {
      const rb = await fetch(`${base}/api/businesses`, {
        method: "POST", headers,
        body: JSON.stringify({ name: "C", project_id: ctx.projectId }),
      });
      const bizRow = (await rb.json()) as Record<string, unknown>;
      const rw = await fetch(`${base}/api/work-items`, {
        method: "POST", headers,
        body: JSON.stringify({ business_id: bizRow.business_id, title: "t", goal: "g" }),
      });
      const wi = (await rw.json()) as Record<string, unknown>;
      await fetch(`${base}/api/work-items/${wi.work_item_id}/open`, { method: "POST", headers, body: "{}" });
      const mid = String((ctx.store.get("work_item", String(wi.work_item_id)).mission_ids as string[])[0]);
      const rc = await fetch(`${base}/api/work-items/${wi.work_item_id}/cancel`, { method: "POST", headers, body: "{}" });
      expect(rc.status).toBe(200);
      const out = (await rc.json()) as Record<string, unknown>;
      expect(String(out.status)).toBe("CANCELLED");
      // 200 means something real was cancelled — mission + item both terminal.
      expect(String(ctx.store.get("mission", mid).status)).toBe("CANCELLED");
      expect(String(ctx.store.get("work_item", String(wi.work_item_id)).status)).toBe("CANCELLED");
    } finally {
      server.close();
    }
  });
});

/* ------------- R1 §6+§7+§8 routine isolation / dedup / budgets ------------- */

describe("R1 §6-§8 routines: isolation, atomic dedup, budgets", () => {
  function makeRoutine(biz: BusinessLayer, businessId: string) {
    return biz.createRoutine({
      business_id: businessId, name: "daily", goal_template: "do daily",
      cron: "0 9 * * *", operator_id: "op",
    });
  }

  function firedMission(ctx: ReturnType<typeof makeBizCtx>["ctx"], businessId: string, schedId: string, goal = "r") {
    return ctx.control.startMission({
      project_id: ctx.projectId, goal,
      metadata: { business_id: businessId, schedule_id: schedId, plan_source: "schedule" },
      operator_id: "op",
    });
  }

  it("a mission carrying this routine's schedule_id but a foreign business_id does NOT project", () => {
    const { ctx, biz } = makeBizCtx("rt1");
    const bA = setupBusiness(biz, ctx.projectId, "A");
    setupBusiness(biz, ctx.projectId, "B");
    const rA = makeRoutine(biz, String(bA.business_id));
    // P13-R1 §5: a forged/unknown business_id now fails closed at mission
    // start — isolation is enforced even earlier than the board check.
    expect(() => firedMission(ctx, "BIZ_other", String(rA.schedule_id))).toThrowError(
      /FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN/,
    );
    const board = biz.board(String(bA.business_id));
    const projected = Object.values(board).flat().filter((w) => String(w.source) === "routine");
    expect(projected).toHaveLength(0);
  });

  it("one routine-fired mission → exactly one projected work item, across repeated and cross-connection board() calls", () => {
    const { dir, ctx, biz } = makeBizCtx("rt2");
    const b = setupBusiness(biz, ctx.projectId);
    const r = makeRoutine(biz, String(b.business_id));
    const m = firedMission(ctx, String(b.business_id), String(r.schedule_id));
    biz.board(String(b.business_id));
    biz.board(String(b.business_id));
    const biz2 = makeSecondBiz(dir).biz;
    biz2.board(String(b.business_id));
    const items = ctx.store.list("work_item").filter((w) => String(w.routine_id) === String(r.routine_id));
    expect(items).toHaveLength(1);
    expect(String(items[0].work_item_id)).toMatch(/^WI_RT_[0-9a-f]{24}$/);
    expect((items[0].mission_ids as string[])).toContain(String(m.mission_id));
  });

  it("routine fire respecting business budget: max=1 consumed by a manual open → routine fire vetoed", async () => {
    const { ctx, biz, schedules } = makeBizCtx("rt3");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 1, operator_id: "op",
    });
    const w = makeWorkItem(biz, String(b.business_id));
    biz.openWorkItem(String(w.work_item_id), "op"); // consumes the unit
    const r = makeRoutine(biz, String(b.business_id));
    const schedRow = ctx.store.get("mission_schedule", String(r.schedule_id));
    schedRow.next_due_at = new Date(Date.now() - 1000).toISOString();
    ctx.store.put("mission_schedule", String(r.schedule_id), schedRow, Number(schedRow.version));
    const res = await schedules.fireDue(async (input) =>
      ctx.control.startMission({
        project_id: ctx.projectId, goal: input.goal,
        metadata: input.metadata, operator_id: "op",
      }));
    expect(res.errors).toContain(String(r.schedule_id));
    expect(res.fired).toHaveLength(0);
    expect(ctx.store.list("mission")).toHaveLength(1); // only the manual one
  });

  it("routine fire under budget creates a business-scoped mission carrying schedule metadata", async () => {
    const { ctx, biz, schedules } = makeBizCtx("rt4");
    const b = setupBusiness(biz, ctx.projectId);
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business",
      period: "DAY", max_missions: 2, operator_id: "op",
    });
    const r = makeRoutine(biz, String(b.business_id));
    const schedRow = ctx.store.get("mission_schedule", String(r.schedule_id));
    schedRow.next_due_at = new Date(Date.now() - 1000).toISOString();
    ctx.store.put("mission_schedule", String(r.schedule_id), schedRow, Number(schedRow.version));
    const res = await schedules.fireDue(async (input) =>
      ctx.control.startMission({
        project_id: ctx.projectId, goal: input.goal,
        metadata: input.metadata, operator_id: "op",
      }));
    expect(res.fired).toContain(String(r.schedule_id));
    const missions = ctx.store.list("mission");
    expect(missions).toHaveLength(1);
    const md = missions[0].metadata as Record<string, unknown>;
    expect(String(md.business_id)).toBe(String(b.business_id));
    expect(String(md.schedule_id)).toBe(String(r.schedule_id));
    expect(String(md.plan_source)).toBe("schedule");
    // HELD reservation consumed (not double-counted alongside the mission).
    const resv = ctx.store.list("budget_reservation");
    expect(resv).toHaveLength(1);
    expect(String(resv[0].status)).toBe("CONSUMED");
  });
});
