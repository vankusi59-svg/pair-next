/**
 * P11 REMEDIATION R4 tests — FINAL RESTART ACCOUNTING CLOSURE.
 * Canonical truth priority: mission existence → occurrence binding →
 * mission_schedule accounting → budget reservation projection.
 *
 *  §10.A CLAIMED + mission + HELD budget + stale schedule → all repaired
 *  §10.B FIRED + mission + stale schedule → schedule row repaired only
 *  §10.C HELD reservation + fired mission → CONSUMED exactly once
 *  §10.D RELEASED occurrence + no mission + HELD → RELEASED, not counted
 *  §10.E repeated reconciliation is idempotent
 *  §10.F two historical FIRED occurrences derive full accounting
 *  §10.G conflicting canonical evidence fails closed (integrity events)
 *  §11   genuine restart: close the store, reopen a fresh stack, repair
 *  §13   audit events: SCHEDULE_ACCOUNTING_RECONCILED /
 *        BUDGET_RESERVATION_RECONCILED / integrity events — no secrets
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
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  digest,
  nextRunAfter,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p11r4-"));
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

const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T10:05:00.000Z"; // next */5 tick after T0
const T2 = "2026-01-01T10:10:00.000Z";

function occId(scheduleId: string, dueAt: string): string {
  return `OCC_${digest(`schedule-occurrence:${scheduleId}:${dueAt}`).slice(0, 24)}`;
}

/** Schedule row rewound to a stale crash state: next_due_at=X, nothing fired. */
function staleSchedule(schedules: MissionScheduleService, dueAt: string) {
  const s = schedules.create({ goal: "tick", cron: "*/5 * * * *", operator_id: "op" });
  const id = String(s.schedule_id);
  const row = schedules.get(id);
  row.next_due_at = dueAt;
  row.run_count = 0;
  row.last_mission_id = null;
  row.last_fired_at = null;
  schedules["store"].put("mission_schedule", id, row, Number(row.version));
  return id;
}

function craftOccurrence(
  store: PairEvidenceStore,
  scheduleId: string,
  dueAt: string,
  status: string,
  missionId: string | null = null,
  firedAt: string | null = null,
) {
  const oid = occId(scheduleId, dueAt);
  store.put(
    "schedule_occurrence",
    oid,
    {
      occurrence_id: oid, schedule_id: scheduleId, due_at: dueAt,
      business_id: null, status, mission_id: missionId,
      fired_at: firedAt, created_at: dueAt, version: 0,
    },
    0,
  );
  return oid;
}

function craftMission(
  ctx: ReturnType<typeof makeCtxOn>,
  scheduleId: string,
  occurrenceId: string,
  dueAt: string,
) {
  return ctx.control.startMission({
    goal: "x",
    project_id: ctx.projectId,
    operator_id: "op",
    metadata: {
      plan_source: "schedule",
      schedule_id: scheduleId,
      schedule_occurrence_id: occurrenceId,
      scheduled_for: dueAt,
    },
  });
}

function craftHeldReservation(store: PairEvidenceStore, refId: string, tag: string) {
  const rid = `BRS_R4_${tag}`;
  store.put(
    "budget_reservation",
    rid,
    {
      reservation_id: rid, business_id: "BIZ_X", department: null, agent_id: null,
      status: "HELD", ref_id: refId, created_at: T0,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), version: 0,
    },
    0,
  );
  return rid;
}

const events = (ctx: ReturnType<typeof makeCtxOn>, type: string, et = "schedule_occurrence") =>
  ctx.store.listEvents().filter(
    (e) => String(e.event_type) === type && String(e.entity_type) === et,
  );

/* ------------------------------- §10.A ----------------------------------- */

describe("R4 §10 crash-boundary repairs", () => {
  it("A. CLAIMED occurrence + mission + HELD budget + stale schedule → all repaired", () => {
    const { ctx, schedules } = makeBizCtx("r4a");
    const id = staleSchedule(schedules, T0);
    const oid = craftOccurrence(ctx.store, id, T0, "CLAIMED");
    const m = craftMission(ctx, id, oid, T0);
    const rid = craftHeldReservation(ctx.store, `schedule-occurrence:${oid}`, "a");

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(m.mission_id));
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.last_mission_id)).toBe(String(m.mission_id));
    expect(String(sch.last_fired_at)).toBe(String(occ.fired_at));
    expect(String(sch.next_due_at)).toBe(T1); // first cron tick after X
    const rsv = ctx.store.get("budget_reservation", rid);
    expect(String(rsv.status)).toBe("CONSUMED");
    expect(ctx.store.list("mission").length).toBe(1); // no new mission
    expect(events(ctx, "SCHEDULE_ACCOUNTING_RECONCILED", "mission_schedule").length).toBe(1);
    expect(events(ctx, "BUDGET_RESERVATION_RECONCILED", "budget_reservation").length).toBe(1);
  });

  it("B. FIRED occurrence + stale schedule → repairs schedule only, no new mission", () => {
    const { ctx, schedules } = makeBizCtx("r4b");
    const id = staleSchedule(schedules, T0);
    const m = craftMission(ctx, id, occId(id, T0), T0);
    const oid = craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), "2026-01-01T10:00:03.000Z");

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.last_mission_id)).toBe(String(m.mission_id));
    expect(String(sch.last_fired_at)).toBe("2026-01-01T10:00:03.000Z");
    expect(String(sch.next_due_at)).toBe(T1);
    expect(ctx.store.list("mission").length).toBe(1);
  });

  it("C. HELD reservation + fired mission → CONSUMED exactly once", () => {
    const { ctx, schedules } = makeBizCtx("r4c");
    const id = staleSchedule(schedules, T0);
    const m = craftMission(ctx, id, occId(id, T0), T0);
    const oid = craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    const rid = craftHeldReservation(ctx.store, `schedule-occurrence:${oid}`, "c");

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    expect(String(ctx.store.get("budget_reservation", rid).status)).toBe("CONSUMED");
    // Idempotent: second reconcile doesn't emit a second settle event.
    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    expect(events(ctx, "BUDGET_RESERVATION_RECONCILED", "budget_reservation").length).toBe(1);
  });

  it("D. RELEASED occurrence + no mission + HELD → RELEASED, never counted", () => {
    const { ctx, schedules } = makeBizCtx("r4d");
    const id = staleSchedule(schedules, T0);
    const oid = craftOccurrence(ctx.store, id, T0, "RELEASED");
    const rid = craftHeldReservation(ctx.store, `schedule-occurrence:${oid}`, "d");

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    expect(String(ctx.store.get("budget_reservation", rid).status)).toBe("RELEASED");
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(0); // failed occurrence doesn't count
    expect(sch.last_mission_id).toBeNull();
    expect(ctx.store.list("mission").length).toBe(0);
  });

  it("E. repeated reconciliation is idempotent", () => {
    const { ctx, schedules } = makeBizCtx("r4e");
    const id = staleSchedule(schedules, T0);
    const m = craftMission(ctx, id, occId(id, T0), T0);
    const oid = craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), "2026-01-01T10:00:02.000Z");
    const rid = craftHeldReservation(ctx.store, `schedule-occurrence:${oid}`, "e");
    const sch = new MissionScheduleService(ctx.service);

    sch.reconcileScheduleAccounting();
    const snap = schedules.get(id);
    sch.reconcileScheduleAccounting();
    sch.reconcileScheduleAccounting();
    const snap2 = schedules.get(id);

    expect(ctx.store.list("mission").length).toBe(1);
    expect(
      ctx.store.list("schedule_occurrence").filter((o) => String(o.status) === "FIRED").length,
    ).toBe(1);
    expect(Number(snap2.run_count)).toBe(1);
    expect(Number(snap2.version)).toBe(Number(snap.version)); // no further writes
    expect(String(snap2.last_mission_id)).toBe(String(m.mission_id));
    expect(String(snap2.next_due_at)).toBe(T1);
    expect(
      ctx.store.list("budget_reservation").filter((r) => String(r.status) === "CONSUMED").length,
    ).toBe(1);
    expect(String(ctx.store.get("budget_reservation", rid).status)).toBe("CONSUMED");
    expect(events(ctx, "SCHEDULE_ACCOUNTING_RECONCILED", "mission_schedule").length).toBe(1);
  });

  it("F. two historical FIRED occurrences → run_count=2, latest wins", () => {
    const { ctx, schedules } = makeBizCtx("r4f");
    const id = staleSchedule(schedules, T0); // schedule stuck at X
    const mX = craftMission(ctx, id, occId(id, T0), T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(mX.mission_id), "2026-01-01T10:00:01.000Z");
    const mY = craftMission(ctx, id, occId(id, T1), T1);
    craftOccurrence(ctx.store, id, T1, "FIRED", String(mY.mission_id), "2026-01-01T10:05:02.000Z");

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(2);
    expect(String(sch.last_mission_id)).toBe(String(mY.mission_id));
    expect(String(sch.last_fired_at)).toBe("2026-01-01T10:05:02.000Z");
    expect(String(sch.next_due_at)).toBe(T2); // first cron tick strictly after Y
    expect(ctx.store.list("mission").length).toBe(2); // no new missions
  });

  /* ------------------------------- §10.G ---------------------------------- */

  it("G1. FIRED bound to a mission claiming a different schedule → integrity, no repair", () => {
    const { ctx, schedules } = makeBizCtx("r4g1");
    const id = staleSchedule(schedules, T0);
    const other = schedules.create({ goal: "o", cron: "*/5 * * * *", operator_id: "op" });
    // Mission claims the occurrence but tags the WRONG schedule id.
    const m = ctx.control.startMission({
      goal: "x", project_id: ctx.projectId, operator_id: "op",
      metadata: {
        plan_source: "schedule",
        schedule_id: String(other.schedule_id),
        schedule_occurrence_id: occId(id, T0),
        scheduled_for: T0,
      },
    });
    const oid = craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(0); // NOT repaired
    expect(sch.last_mission_id).toBeNull();
    const ev = events(ctx, "SCHEDULE_ACCOUNTING_INTEGRITY", "schedule_occurrence");
    expect(ev.length).toBe(1);
    expect(String((ev[0].metadata as Record<string, unknown>).repair_reason)).toBe(
      "mission_claims_wrong_schedule",
    );
  });

  it("G2. two missions claim the same occurrence → fail closed, integrity", () => {
    const { ctx, schedules } = makeBizCtx("r4g2");
    const id = staleSchedule(schedules, T0);
    const oid = craftOccurrence(ctx.store, id, T0, "CLAIMED");
    craftMission(ctx, id, oid, T0);
    craftMission(ctx, id, oid, T0); // second claimant
    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("CLAIMED"); // never silently picked one
    expect(occ.mission_id).toBeNull();
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(0);
    expect(
      events(ctx, "SCHEDULE_OCCURRENCE_INTEGRITY").some(
        (e) =>
          String((e.metadata as Record<string, unknown>).repair_reason) ===
          "multiple_missions_claim_occurrence",
      ),
    ).toBe(true);
  });

  it("G3. FIRED occurrence bound to a mission that does not claim it → integrity", () => {
    const { ctx, schedules } = makeBizCtx("r4g3");
    const id = staleSchedule(schedules, T0);
    const m = ctx.control.startMission({
      goal: "x", project_id: ctx.projectId, operator_id: "op", metadata: {},
    });
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    expect(Number(schedules.get(id).run_count)).toBe(0);
    const ev = events(ctx, "SCHEDULE_ACCOUNTING_INTEGRITY", "schedule_occurrence");
    expect(ev.length).toBe(1);
    expect(String((ev[0].metadata as Record<string, unknown>).repair_reason)).toBe(
      "bound_mission_does_not_claim",
    );
  });

  it("G4. FIRED occurrence bound to a missing mission → integrity", () => {
    const { ctx, schedules } = makeBizCtx("r4g4");
    const id = staleSchedule(schedules, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", "MSN_ghost", T0);
    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();
    expect(Number(schedules.get(id).run_count)).toBe(0);
    expect(
      events(ctx, "SCHEDULE_ACCOUNTING_INTEGRITY", "schedule_occurrence").some(
        (e) =>
          String((e.metadata as Record<string, unknown>).repair_reason) ===
          "fired_occurrence_missing_mission",
      ),
    ).toBe(true);
  });

  it("G5. reservation ref identity is per-occurrence — SCHED A:X never settles SCHED A:Y", async () => {
    const { ctx, biz, schedules } = makeBizCtx("r4g5");
    const b = biz.createBusiness({ name: "B", project_id: ctx.projectId, operator_id: "op" });
    biz.createBudgetPolicy({
      business_id: String(b.business_id), scope_type: "business", period: "DAY",
      max_missions: 10, operator_id: "op",
    });
    const s = schedules.create({
      goal: "tick", cron: "*/5 * * * *", operator_id: "op",
      metadata: { business_id: String(b.business_id) },
    });
    const id = String(s.schedule_id);
    const row = schedules.get(id);
    row.next_due_at = new Date(Date.now() - 60_000).toISOString();
    schedules["store"].put("mission_schedule", id, row, Number(row.version));
    await schedules.fireDue(
      (input) => ctx.control.startMission({ ...input, project_id: ctx.projectId, operator_id: "op" }),
      utcnow(),
    );
    const occ = ctx.store.list("schedule_occurrence")[0];
    const rsv = ctx.store.list("budget_reservation")[0];
    expect(String(rsv.ref_id)).toBe(`schedule-occurrence:${String(occ.occurrence_id)}`);
    expect(String(rsv.status)).toBe("CONSUMED");
  });
});

/* ------------------------------- §11 ------------------------------------- */

describe("R4 §11 genuine restart", () => {
  it("partial crash state repaired by a brand-new store/stack on the same db", () => {
    const { ctx, schedules } = makeBizCtx("r4restart");
    const dbPath = path.join(ctx.dir, "pair.db");
    const id = staleSchedule(schedules, T0);
    const m = craftMission(ctx, id, occId(id, T0), T0);
    const oid = craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), "2026-01-01T10:00:04.000Z");
    const rid = craftHeldReservation(ctx.store, `schedule-occurrence:${oid}`, "restart");

    // Simulate a real restart: close the store entirely, build a fresh
    // PairEvidenceStore + full service stack on the same db file.
    ctx.store.close();
    const ctx2 = makeCtxOn(dbPath, ctx.dir);
    const sch2 = new MissionScheduleService(ctx2.service);
    new BusinessLayer({ store: ctx2.store, control: ctx2.control, schedules: sch2 });
    sch2.reconcileScheduleAccounting();

    const sch = sch2.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.last_mission_id)).toBe(String(m.mission_id));
    expect(String(sch.last_fired_at)).toBe("2026-01-01T10:00:04.000Z");
    expect(String(sch.next_due_at)).toBe(T1);
    expect(String(ctx2.store.get("budget_reservation", rid).status)).toBe("CONSUMED");
    expect(ctx2.store.list("mission").length).toBe(1);
    // Evidence chain stays clean after repair.
    const integrity = ctx2.store.verifyIntegrity();
    expect(Number(integrity.chain_breaks ?? 0)).toBe(0);
  });
});
