/**
 * P11 REMEDIATION R2 tests — three closure blockers:
 *  §1 resolve pending open intent BEFORE any business state mutation
 *     (orphan mission + block/cancel/reopen/unblock/assign/claim, in-flight
 *     intents fail closed, stale intents roll back deterministically);
 *  §2 genuine multi-process contention via worker_threads — every worker
 *     owns its own PairEvidenceStore + full stack on the SAME db file and
 *     releases on a shared SharedArrayBuffer barrier;
 *  §3 exactly-once schedule occurrence claim (schedule_id + due_at) with
 *     crash/restart reconcile and budget-ordering properties.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
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
  digest,
  newId,
  nextRunAfter,
  utcnow,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p11r2-");
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

function setupBusiness(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

function makeWorkItem(biz: BusinessLayer, businessId: string, title = "w") {
  return biz.createWorkItem({
    business_id: businessId, title, goal: "do " + title, operator_id: "op",
  });
}

/**
 * Simulate the canonical crash window WITHOUT the catch-path reconcile:
 * work_item IN_PROGRESS + pending_open_id committed, mission created
 * (metadata.work_item_open_id), but the link write never ran.
 */
function makeOrphanPending(
  store: PairEvidenceStore,
  control: MissionControl,
  projectId: string,
  workItemId: string,
  openId = "OPI_orphan",
) {
  const cur = store.get("work_item", workItemId);
  cur.status = "IN_PROGRESS";
  cur.pending_open_id = openId;
  cur.pending_open_at = utcnow();
  cur.updated_at = utcnow();
  store.put("work_item", workItemId, cur, Number(cur.version));
  // V2: a real crash orphan always carries its canonical binding INTENT
  // with the mission_id pinned before the mission was created.
  const orphanMissionId = newId("MSN");
  store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId,
    business_id: String(cur.business_id), project_id: projectId,
    org_agent_id: cur.assignee_agent_id ?? null, created_by: "op",
    mission_id: orphanMissionId, state: "INTENT",
    created_at: utcnow(), bound_at: null, rolled_back_at: null,
    updated_at: utcnow(), version: 0,
  } as never, 0);
  const mission = control.startBoundMission({
    goal: "orphan",
    project_id: projectId,
    operator_id: "op",
    binding_open_id: openId,
    metadata: {
      business_id: String(cur.business_id),
      work_item_id: workItemId,
      work_item_open_id: openId,
      org_agent_id: cur.assignee_agent_id ?? null,
      source: "business_layer",
    },
  });
  return { openId, mission };
}

/* ---------------- §1 pending open resolves before any mutation ------------ */

describe("R2 §1 pending open resolved before business state mutation", () => {
  it("A) orphan RUNNING mission + block: links first, pauses via MissionControl, then BLOCKED", () => {
    const { ctx, biz } = makeBizCtx("po1");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);
    // make it a RUNNING orphan — pause() legitimately no-ops on CREATED
    const mrow = ctx.store.get("mission", String(mission.mission_id));
    mrow.status = "RUNNING";
    ctx.store.put("mission", String(mission.mission_id), mrow, Number(mrow.version));

    const blocked = biz.blockWorkItem(wid, "paused for audit", "op");
    expect(String(blocked.status)).toBe("BLOCKED");
    expect(blocked.pending_open_id).toBeNull();
    expect((blocked.mission_ids as string[])).toContain(String(mission.mission_id));
    const m = ctx.store.get("mission", String(mission.mission_id));
    expect(String(m.status)).toBe("PAUSED");
    const rec = ctx.store
      .listEvents("work_item", wid)
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_RECONCILED");
    expect(rec.length).toBe(1);
  });

  it("B) orphan RUNNING mission + cancel: links, cancels via MissionControl, item CANCELLED", () => {
    const { ctx, biz } = makeBizCtx("po2");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);

    const cancelled = biz.cancelWorkItem(wid, "op");
    expect(String(cancelled.status)).toBe("CANCELLED");
    expect(cancelled.pending_open_id).toBeNull();
    expect((cancelled.mission_ids as string[])).toContain(String(mission.mission_id));
    expect(String(ctx.store.get("mission", String(mission.mission_id)).status)).toBe("CANCELLED");
  });

  it("C) orphan RUNNING mission + reopen: links, FAIL_CLOSED_MISSION_ACTIVE, no second mission", () => {
    const { ctx, biz } = makeBizCtx("po3");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);

    expect(() => biz.openWorkItem(wid, "op")).toThrowError(/FAIL_CLOSED_MISSION_ACTIVE/);
    const after = ctx.store.get("work_item", wid);
    expect(after.pending_open_id).toBeNull();
    expect(after.mission_ids).toEqual([String(mission.mission_id)]);
    expect(ctx.store.list("mission").length).toBe(1);
  });

  it("D) pending intent with provably no mission beyond grace: rolls back then mutation proceeds", () => {
    const { ctx, biz } = makeBizCtx("po4");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const cur = ctx.store.get("work_item", wid);
    cur.status = "IN_PROGRESS";
    cur.pending_open_id = "OPI_dead";
    cur.pending_open_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    cur.updated_at = utcnow();
    ctx.store.put("work_item", wid, cur, Number(cur.version));

    const cancelled = biz.cancelWorkItem(wid, "op");
    expect(String(cancelled.status)).toBe("CANCELLED");
    const rb = ctx.store
      .listEvents("work_item", wid)
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK");
    expect(rb.length).toBe(1);
  });

  it("in-flight pending intent with no mission: mutation fails closed OPEN_INTENT_ACTIVE", () => {
    const { ctx, biz } = makeBizCtx("po5");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const cur = ctx.store.get("work_item", wid);
    cur.status = "IN_PROGRESS";
    cur.pending_open_id = "OPI_flight";
    cur.pending_open_at = utcnow();
    cur.updated_at = utcnow();
    ctx.store.put("work_item", wid, cur, Number(cur.version));

    expect(() => biz.blockWorkItem(wid, "stuck", "op")).toThrowError(/FAIL_CLOSED_OPEN_INTENT_ACTIVE/);
    const still = ctx.store.get("work_item", wid);
    expect(String(still.status)).toBe("IN_PROGRESS");
    expect(String(still.pending_open_id)).toBe("OPI_flight");
  });

  it("E) terminal orphan mission + mutation: linked then state folded via sync", () => {
    const { ctx, biz } = makeBizCtx("po6");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);
    ctx.control.cancelMission(String(mission.mission_id), "op");

    // The mutation gate links the terminal mission and folds its outcome
    // (CANCELLED) into the item before the mutation runs — so the subsequent
    // action sees true state and correctly refuses from a terminal status.
    const folded = biz.syncWorkItem(wid);
    expect(String(folded.status)).toBe("CANCELLED");
    expect(folded.pending_open_id).toBeNull();
    expect((folded.mission_ids as string[])).toContain(String(mission.mission_id));
    expect(() => biz.blockWorkItem(wid, "stuck", "op")).toThrowError(/FAIL_CLOSED_WORK_ITEM_TRANSITION/);
  });

  it("restart: fresh stack on same db resolves orphan pending before mutation", () => {
    const { dir, ctx, biz } = makeBizCtx("po7");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);

    // "Restart": a completely fresh stack on the same DB file.
    const ctx2 = makeCtxOn(path.join(dir, "pair.db"), dir);
    const schedules2 = new MissionScheduleService(ctx2.service);
    const biz2 = new BusinessLayer({ store: ctx2.store, control: ctx2.control, schedules: schedules2 });

    const blocked = biz2.blockWorkItem(wid, "paused for audit", "op");
    expect((blocked.mission_ids as string[])).toContain(String(mission.mission_id));
    expect(blocked.pending_open_id).toBeNull();
  });

  it("board() reconciles pending on any status, not just IN_PROGRESS", () => {
    const { ctx, biz } = makeBizCtx("po8");
    const b = setupBusiness(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id), "wi");
    const wid = String(w.work_item_id);
    const { mission } = makeOrphanPending(ctx.store, ctx.control, ctx.projectId, wid);
    const cur = ctx.store.get("work_item", wid);
    cur.status = "BLOCKED"; // pending marker survives a status write
    ctx.store.put("work_item", wid, cur, Number(cur.version));

    biz.board(String(b.business_id));
    const after = ctx.store.get("work_item", wid);
    expect(after.pending_open_id).toBeNull();
    expect((after.mission_ids as string[])).toContain(String(mission.mission_id));
  });
});

/* ---------------- §3 exactly-once schedule occurrence claim --------------- */

describe("R2 §3 schedule occurrence exactly-once", () => {
  function makeDueSchedule(schedules: MissionScheduleService, metadata?: Record<string, unknown>) {
    const s = schedules.create({
      goal: "tick",
      cron: "*/5 * * * *",
      operator_id: "op",
      metadata,
    });
    const id = String(s.schedule_id);
    const row = schedules.get(id);
    row.next_due_at = new Date(Date.now() - 60_000).toISOString(); // force due
    return schedules["store"].put("mission_schedule", id, row, Number(row.version));
  }

  it("two fireDue runs on the same occurrence create exactly one mission", async () => {
    const { dir, ctx } = makeBizCtx("occ1");
    const ctx2 = makeCtxOn(path.join(dir, "pair.db"), dir);
    const sch1 = new MissionScheduleService(ctx.service);
    const sch2 = new MissionScheduleService(ctx2.service);
    const s = makeDueSchedule(sch1);
    const dueAt = String(s.next_due_at);
    // `now` pinned to dueAt: the reconciled next_due_at (nextRunAfter
    // strictly after dueAt) can then never itself be due in this test —
    // keeping the assertion deterministic. (R4 folds a missed tick
    // between X and a later `now` into a legitimate extra fire.)
    const now = dueAt;

    let submits = 0;
    const submit = (input: Record<string, unknown>) => {
      submits++;
      return ctx.control.startMission({ ...input, project_id: ctx.projectId, operator_id: "op" });
    };
    const r1 = await sch1.fireDue(submit, now);
    expect(r1.fired.length).toBe(1);
    expect(submits).toBe(1);

    // Force the SAME occurrence due again (restart replay / second process
    // reading the pre-advance row) — the claim must block it.
    const row = sch2.get(String(s.schedule_id));
    row.next_due_at = dueAt;
    ctx2.store.put("mission_schedule", String(s.schedule_id), row, Number(row.version));
    const r2 = await sch2.fireDue(submit, now);
    expect(r2.fired.length).toBe(0);
    expect(submits).toBe(1);
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(1);
    const occ = ctx.store.get(
      "schedule_occurrence",
      String((missions[0].metadata as Record<string, unknown>).schedule_occurrence_id),
    );
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(missions[0].mission_id));
    expect(String((missions[0].metadata as Record<string, unknown>).scheduled_for)).toBe(dueAt);
  });

  it("crash after mission creation before occurrence backlink → reconcile binds it", async () => {
    const { ctx, schedules } = makeBizCtx("occ2");
    const s = makeDueSchedule(schedules);
    const dueAt = String(s.next_due_at);
    const occId = `OCC_${(await import("../pair/canonical.js")).digest(`schedule-occurrence:${String(s.schedule_id)}:${dueAt}`).slice(0, 24)}`;
    // Claim + create mission carrying the occurrence metadata, then "crash"
    // before bindOccurrenceMission runs: simulate by creating both rows
    // directly.
    ctx.store.put(
      "schedule_occurrence",
      occId,
      {
        occurrence_id: occId,
        schedule_id: String(s.schedule_id),
        due_at: dueAt,
        business_id: null,
        status: "CLAIMED",
        mission_id: null,
        created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // past TTL
        version: 0,
      },
      0,
    );
    const mission = ctx.control.startMission({
      goal: "tick",
      project_id: ctx.projectId,
      operator_id: "op",
      metadata: { schedule_occurrence_id: occId, schedule_id: String(s.schedule_id) },
    });
    schedules.reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", occId);
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(mission.mission_id));
  });

  it("stale claim with provably no mission → RELEASED + audited", () => {
    const { ctx, schedules } = makeBizCtx("occ3");
    ctx.store.put(
      "schedule_occurrence",
      "OCC_dead",
      {
        occurrence_id: "OCC_dead",
        schedule_id: "SCHED_x",
        due_at: utcnow(),
        status: "CLAIMED",
        mission_id: null,
        created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        version: 0,
      },
      0,
    );
    schedules.reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", "OCC_dead");
    expect(String(occ.status)).toBe("RELEASED");
    const ev = ctx.store
      .listEvents("schedule_occurrence", "OCC_dead")
      .filter((e) => e.event_type === "SCHEDULE_OCCURRENCE_RELEASED");
    expect(ev.length).toBe(1);
  });

  it("preflight veto releases the occurrence and creates no mission", async () => {
    const { ctx, schedules } = makeBizCtx("occ4");
    const s = makeDueSchedule(schedules, { business_id: "b1" });
    const dueAt = String(s.next_due_at);
    let calls = 0;
    schedules.preflight = () => {
      calls++;
      throw new PolicyError("FAIL_CLOSED_BUDGET_EXCEEDED", "b1");
    };
    const r = await schedules.fireDue(() => {
      throw new Error("submit must not run");
    }, utcnow());
    expect(r.fired.length).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(calls).toBe(1);
    const occs = ctx.store.list("schedule_occurrence");
    expect(occs.length).toBe(1);
    expect(String(occs[0].status)).toBe("RELEASED");
    expect(ctx.store.list("mission").length).toBe(0);
    // schedule still advanced — no hot loop
    expect(String(schedules.get(String(s.schedule_id)).next_due_at)).not.toBe(dueAt);
  });

  it("routine fire carries occurrence + schedule + business metadata through to the mission", async () => {
    const { ctx, biz, schedules } = makeBizCtx("occ5");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    biz.createRoutine({
      business_id: bid,
      name: "rt",
      goal_template: "do rt",
      cron: "*/5 * * * *",
      operator_id: "op",
    });
    const sch = ctx.store.list("mission_schedule")[0];
    sch.next_due_at = new Date(Date.now() - 60_000).toISOString();
    ctx.store.put("mission_schedule", String(sch.schedule_id), sch, Number(sch.version));
    await schedules.fireDue(
      (input) => ctx.control.startMission({ ...input, project_id: ctx.projectId }),
      utcnow(),
    );
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(1);
    const md = missions[0].metadata as Record<string, unknown>;
    expect(String(md.business_id)).toBe(bid);
    expect(String(md.schedule_id)).toBe(String(sch.schedule_id));
    expect(String(md.schedule_occurrence_id)).toMatch(/^OCC_/);
    expect(String(md.scheduled_for)).toBe(String(sch.next_due_at));
  });
});

/* ---------------- §2 genuine multi-process contention --------------------- */

const CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-r2");
const BUNDLE = path.join(CACHE, "pair-bundle.mjs");
const WORKER_FILE = path.join(CACHE, "r2-worker.mjs");

const WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, dir, barrier, args } = workerData;

function makeCtx() {
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PAIR.PairEvidenceStore(dbPath);
  const service = new PAIR.PairControlPlane(store);
  const gate = new PAIR.GovernedTaskGate(service);
  const registry = new PAIR.ExecutorRegistry(service);
  const router = new PAIR.MissionRouter(service, gate);
  const recovery = new PAIR.RecoveryController(service);
  const recon = new PAIR.ReconciliationService(service, new Map());
  const approvals = new PAIR.ApprovalQueue(service);
  const scheduler = new PAIR.MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map();
  const planner = () => ({ tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] });
  const runtime = new PAIR.MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new PAIR.MissionSupervisor(service, runtime, recovery, recon);
  const observability = new PAIR.MissionObservability(service);
  const control = new PAIR.MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  // NOTE: no registerCapability / createProject here — the fixture owner
  // created those rows already; re-creating them under a second connection
  // deterministically CAS-conflicts (that IS the dedup working as intended).
  const schedules = new PAIR.MissionScheduleService(service);
  const biz = new PAIR.BusinessLayer({ store, control, schedules });
  return { store, service, control, schedules, biz };
}

async function run() {
  if (op === "cas") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    const row = store.get(args.entity, args.id);
    row.marker = args.marker;
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    store.put(args.entity, args.id, row, Number(row.version));
    return { winner: args.marker };
  }
  if (op === "create") {
    const store = new PAIR.PairEvidenceStore(dbPath);
    parentPort.postMessage({ ready: true });
    Atomics.wait(barrier, 0, 0);
    store.put(args.entity, args.id, { version: 0, marker: args.marker }, 0);
    return { winner: args.marker };
  }
  const ctx = makeCtx();
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  if (op === "claim") { ctx.biz.claimWorkItem(args.wid, args.agent, "op"); return { claimed: args.agent, wi: args.wid }; }
  if (op === "open") { ctx.biz.openWorkItem(args.wid, "op"); return { opened: args.wid }; }
  if (op === "budget") { ctx.biz.openWorkItem(args.wid, "op"); return { opened: args.wid }; }
  if (op === "fire") {
    return await ctx.schedules.fireDue(
      (input) => ctx.control.startMission({ ...input, project_id: args.projectId }),
      args.now,
    );
  }
  throw new Error("unknown op " + op);
}

try {
  const out = await run();
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e && e.code ? e.code : String(e), message: e && e.message });
}
`;

function ensureWorkerBundle() {
  fs.mkdirSync(CACHE, { recursive: true });
  // fs.globSync is Node 22+ — CI runs this on Node 20 too, so scan .pnpm
  // by hand for the newest esbuild binary.
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found under node_modules/.pnpm");
  execFileSync(process.execPath, [
    esbuild,
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(WORKER_FILE, WORKER_SOURCE);
}

type RaceOutcome =
  | { ok: true; out: unknown }
  | { ok: false; code: string; message: string };

/** Run N workers against the same db, all released on one barrier. */
async function runRace(
  ops: Array<{ op: string; dir: string; dbPath: string; args: Record<string, unknown> }>,
): Promise<RaceOutcome[]> {
  ensureWorkerBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    ops.map(
      (o) =>
        new Promise<RaceOutcome>((resolve, reject) => {
          const w = new Worker(WORKER_FILE, {
            workerData: { op: o.op, dbPath: o.dbPath, dir: o.dir, barrier: gate, args: o.args },
          });
          let settled = false;
          w.on("message", (msg: Record<string, unknown>) => {
            if (msg.ready === true) {
              readyCount += 1;
              if (readyCount === ops.length) {
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
              return;
            }
            settled = true;
            resolve(msg as unknown as RaceOutcome);
          });
          w.on("error", reject);
          w.on("exit", (code) => {
            if (!settled) reject(new Error(`worker exited without result code=${code}`));
          });
        }),
    ),
  );
}

describe("R2 §2 genuine worker_threads contention", () => {
  it("A. CAS update race: two workers, one winner + one FAIL_CLOSED_VERSION_CONFLICT", async () => {
    const { dir } = makeBizCtx("ra-cas");
    const dbPath = path.join(dir, "pair.db");
    const s0 = new PairEvidenceStore(dbPath);
    s0.put("probe", "e1", { version: 0, marker: "init" }, 0);
    s0.close();
    const [a, b] = await runRace([
      { op: "cas", dir, dbPath, args: { entity: "probe", id: "e1", marker: "A" } },
      { op: "cas", dir, dbPath, args: { entity: "probe", id: "e1", marker: "B" } },
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    const s = new PairEvidenceStore(dbPath);
    const final = s.get("probe", "e1");
    expect(["A", "B"]).toContain(String(final.marker));
    const integrity = s.verifyIntegrity() as Record<string, number>;
    expect(integrity.errors ?? 0).toBe(0);
    s.close();
  }, 60_000);

  it("B. create race: two workers creating the same entity id — exactly one exists", async () => {
    const { dir } = makeBizCtx("ra-cre");
    const dbPath = path.join(dir, "pair.db");
    const [a, b] = await runRace([
      { op: "create", dir, dbPath, args: { entity: "probe", id: "dup", marker: "A" } },
      { op: "create", dir, dbPath, args: { entity: "probe", id: "dup", marker: "B" } },
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    const s = new PairEvidenceStore(dbPath);
    expect(s.list("probe").length).toBe(1);
    s.close();
  }, 60_000);

  it("C. claim race: two connections claim the same work item — one lease only", async () => {
    const { dir, ctx, biz } = makeBizCtx("ra-claim");
    const dbPath = path.join(dir, "pair.db");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    const a1 = biz.createOrgAgent({ business_id: bid, title: "a1", department: "ops", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: bid, title: "claimme", goal: "g",
      assignee_agent_id: String(a1.agent_id), operator_id: "op" });
    const wid = String(w.work_item_id);
    const [r1, r2] = await runRace([
      { op: "claim", dir, dbPath, args: { wid, agent: String(a1.agent_id) } },
      { op: "claim", dir, dbPath, args: { wid, agent: String(a1.agent_id) } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toMatch(/FAIL_CLOSED/);
    const final = ctx.store.get("work_item", wid);
    expect(String(final.claimed_by)).toBe(String(a1.agent_id));
    // exactly one canonical lease row exists — no duplicate mint
    const leases = ctx.store.list("work_claim_lease").filter((l) =>
      String(l.work_item_id) === wid);
    expect(leases.length).toBe(1);
  }, 60_000);

  it("D. open race: two workers openWorkItem the same item — exactly one canonical mission", async () => {
    const { dir, ctx, biz } = makeBizCtx("ra-open");
    const dbPath = path.join(dir, "pair.db");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    const w = makeWorkItem(biz, bid, "openme");
    const wid = String(w.work_item_id);
    const [r1, r2] = await runRace([
      { op: "open", dir, dbPath, args: { wid } },
      { op: "open", dir, dbPath, args: { wid } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toMatch(/FAIL_CLOSED/);
    const missions = ctx.store.list("mission").filter(
      (m) => String((m.metadata as Record<string, unknown>)?.work_item_id ?? "") === wid,
    );
    expect(missions.length).toBe(1);
    // reconcile on the main stack: exactly one linked mission, marker cleared
    biz.board(bid);
    const final = ctx.store.get("work_item", wid);
    expect((final.mission_ids as string[]).length).toBe(1);
    expect(final.pending_open_id).toBeNull();
  }, 60_000);

  it("E. budget race: limit 1, two different items opened simultaneously — no overshoot", async () => {
    const { dir, ctx, biz } = makeBizCtx("ra-bud");
    const dbPath = path.join(dir, "pair.db");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    biz.createBudgetPolicy({
      business_id: bid, scope_type: "business", period: "DAY",
      max_missions: 1, operator_id: "op",
    });
    const w1 = makeWorkItem(biz, bid, "i1");
    const w2 = makeWorkItem(biz, bid, "i2");
    const [r1, r2] = await runRace([
      { op: "budget", dir, dbPath, args: { wid: String(w1.work_item_id) } },
      { op: "budget", dir, dbPath, args: { wid: String(w2.work_item_id) } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as { code: string }).code).toMatch(/FAIL_CLOSED_BUDGET_EXCEEDED|FAIL_CLOSED/);
    expect(ctx.store.list("mission").length).toBe(1);
    const consumed = ctx.store
      .list("budget_reservation")
      .filter((r) => String(r.status) === "CONSUMED");
    expect(consumed.length).toBe(1);
  }, 60_000);

  it("F. two scheduler processes fire the same occurrence simultaneously — exactly one mission", async () => {
    const { dir, ctx } = makeBizCtx("ra-fire");
    const dbPath = path.join(dir, "pair.db");
    const sch = new MissionScheduleService(ctx.service);
    const s = sch.create({ goal: "tick", cron: "*/5 * * * *", operator_id: "op" });
    const id = String(s.schedule_id);
    const row = sch.get(id);
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    row.next_due_at = dueAt;
    ctx.store.put("mission_schedule", id, row, Number(row.version));
    // `now` pinned to dueAt: nextRunAfter(dueAt) > now, so the loser can
    // never legitimately catch up a second (missed) occurrence — the
    // exactly-one-mission assertion stays deterministic under R5.
    const now = dueAt;
    const [r1, r2] = await runRace([
      { op: "fire", dir, dbPath, args: { projectId: ctx.projectId, now } },
      { op: "fire", dir, dbPath, args: { projectId: ctx.projectId, now } },
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks.length).toBe(2); // both complete; only winner submits
    const firedCount = [r1, r2]
      .map((r) => (r as { out: { fired: string[] } }).out.fired.length)
      .reduce((a, b) => a + b, 0);
    expect(firedCount).toBe(1);
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(1);
    const occs = ctx.store.list("schedule_occurrence");
    expect(occs.length).toBe(1);
    expect(String(occs[0].status)).toBe("FIRED");
    expect(String(occs[0].mission_id)).toBe(String(missions[0].mission_id));
    const after = sch.get(id);
    expect(Number(after.run_count)).toBe(1);
    // R6 §6: state must be canonical IMMEDIATELY after both fireDue calls —
    // no second reconcile pass may be needed. The loser only ever
    // reconciles; it never merges stale outcome fields.
    expect(String(after.last_mission_id)).toBe(String(missions[0].mission_id));
    expect(String(after.last_fired_at)).toBe(String(occs[0].fired_at));
    expect(String(after.next_due_at)).toBe(
      nextRunAfter("*/5 * * * *", String(occs[0].due_at)),
    );
    expect(after.last_error ?? null).toBeNull();
  }, 90_000);

  it("G. R6 §7 previous-occurrence race: winner's outcome must not be clobbered by the loser's stale row", async () => {
    const { dir, ctx } = makeBizCtx("ra-fire-prev");
    const dbPath = path.join(dir, "pair.db");
    const sch = new MissionScheduleService(ctx.service);
    const s = sch.create({ goal: "tick", cron: "*/5 * * * *", operator_id: "op" });
    const id = String(s.schedule_id);
    // Canonical previous state: one FIRED occurrence + its mission, and the
    // schedule row already advanced by it.
    const prevDue = "2026-01-01T10:00:00.000Z";
    const prevOccId = `OCC_${digest(`schedule-occurrence:${id}:${prevDue}`).slice(0, 24)}`;
    const prevMission = ctx.control.startMission({
      goal: "prev",
      project_id: ctx.projectId,
      operator_id: "op",
      metadata: {
        plan_source: "schedule",
        schedule_id: id,
        schedule_occurrence_id: prevOccId,
        scheduled_for: prevDue,
      },
    });
    ctx.store.put(
      "schedule_occurrence",
      prevOccId,
      {
        occurrence_id: prevOccId, schedule_id: id, due_at: prevDue,
        business_id: null, status: "FIRED",
        mission_id: String(prevMission.mission_id),
        fired_at: prevDue, created_at: prevDue, version: 0,
      },
      0,
    );
    const dueAt = "2026-01-01T10:05:00.000Z";
    const row = sch.get(id);
    row.next_due_at = dueAt;
    row.run_count = 1;
    row.last_mission_id = String(prevMission.mission_id);
    row.last_fired_at = prevDue;
    ctx.store.put("mission_schedule", id, row, Number(row.version));
    const [r1, r2] = await runRace([
      { op: "fire", dir, dbPath, args: { projectId: ctx.projectId, now: dueAt } },
      { op: "fire", dir, dbPath, args: { projectId: ctx.projectId, now: dueAt } },
    ]);
    expect([r1, r2].filter((r) => r.ok).length).toBe(2);
    // Exactly one new mission — never a replay of MSN_PREVIOUS's slot.
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(2);
    const xOccs = ctx.store
      .list("schedule_occurrence")
      .filter((o) => String(o.due_at) === dueAt);
    expect(xOccs.length).toBe(1);
    expect(String(xOccs[0].status)).toBe("FIRED");
    const xMissionId = String(xOccs[0].mission_id);
    expect(xMissionId).not.toBe(String(prevMission.mission_id));
    const after = sch.get(id);
    // The loser's stale snapshot (run_count=1, last=MSN_PREVIOUS) must NOT
    // survive: canonical evidence wins immediately.
    expect(Number(after.run_count)).toBe(2);
    expect(String(after.last_mission_id)).toBe(xMissionId);
    expect(String(after.last_fired_at)).toBe(String(xOccs[0].fired_at));
    expect(String(after.next_due_at)).toBe(
      nextRunAfter("*/5 * * * *", dueAt),
    );
    expect(after.last_error ?? null).toBeNull();
    expect(ctx.store.verifyIntegrity().entities).toBeGreaterThan(0);
  }, 90_000);
});
