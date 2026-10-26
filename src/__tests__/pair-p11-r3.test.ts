/**
 * P11 REMEDIATION R3 tests — scheduler final closure:
 *  §1 stale due snapshot must never fire the next occurrence early
 *     (snapshot pins to the occurrence it saw; a fresh row naming a
 *     different next_due_at is skipped entirely — no claim, no budget,
 *     no mission, no mutation);
 *  §2 post-create exceptions reconcile via canonical mission existence —
 *     a mission carrying metadata.schedule_occurrence_id always wins over
 *     local exception semantics (bind FIRED, never release, never retry);
 *  §3 bindOccurrenceMission fails closed — returns only on a proven
 *     same-mission FIRED binding; different-mission / unproven → errors;
 *  §4 reconcileOccurrences covers CLAIMED+mission (immediate bind),
 *     RELEASED+mission (deterministic repair), FIRED+other (integrity);
 *  §5 a losing/stale scheduler never mutates run_count/last_mission_id
 *     or advances a future occurrence;
 *  §6 budget: stale snapshot / claim loser reserve nothing, pre-create
 *     failure releases, post-create consumes exactly once.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
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
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  digest,
  utcnow,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p11r3-");
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
  const stored = schedules["store"].put("mission_schedule", id, row, Number(row.version));
  return { schedule: stored, id, dueAt: String(stored.next_due_at) };
}

function occId(scheduleId: string, dueAt: string): string {
  return `OCC_${digest(`schedule-occurrence:${scheduleId}:${dueAt}`).slice(0, 24)}`;
}

const okSubmit =
  (ctx: ReturnType<typeof makeCtxOn>) =>
  (input: Record<string, unknown>) =>
    ctx.control.startMission({ ...input, project_id: ctx.projectId, operator_id: "op" });

/* ---------------- §1 stale due snapshot cannot fire the next occurrence --- */

describe("R3 §1 stale due snapshot pinning", () => {
  it("A fires X and advances to Y — B resuming with the X snapshot must NOT fire Y", async () => {
    const { ctx, schedules: schA } = makeBizCtx("pin1");
    const schB = new MissionScheduleService(ctx.service); // second scheduler, same store
    const { id } = makeDueSchedule(schA);
    const now = utcnow();

    // Both schedulers snapshot occurrence X while it is due.
    const snapA = schA.due(now);
    const snapB = schB.due(now);
    expect(snapA.length).toBe(1);
    expect(snapB.length).toBe(1);
    expect(String(snapB[0].next_due_at)).toBe(String(snapA[0].next_due_at));

    // A fires X completely and advances the schedule to Y.
    const rA = await schA.fireDue(okSubmit(ctx), now);
    expect(rA.fired.length).toBe(1);
    const afterA = schA.get(id);
    const dueY = String(afterA.next_due_at);
    expect(dueY).not.toBe(String(snapA[0].next_due_at));
    expect(Number(afterA.run_count)).toBe(1);

    // B resumes with its stale snapshot of X — it must not claim or fire Y.
    schB.due = () => snapB;
    let submits = 0;
    const rB = await schB.fireDue(
      () => {
        submits++;
        return okSubmit(ctx)({});
      },
      now,
    );
    expect(rB.fired.length).toBe(0);
    expect(rB.errors.length).toBe(0);
    expect(submits).toBe(0);
    expect(ctx.store.list("mission").length).toBe(1);
    expect(ctx.store.list("schedule_occurrence").length).toBe(1); // only X's
    const final = schA.get(id);
    expect(String(final.next_due_at)).toBe(dueY); // B mutated nothing
    expect(Number(final.run_count)).toBe(1);
    expect(Number(final.version)).toBe(Number(afterA.version));
  });

  it("a snapshot whose row was disabled meanwhile is skipped entirely", async () => {
    const { ctx, schedules } = makeBizCtx("pin2");
    const schB = new MissionScheduleService(ctx.service);
    const { id } = makeDueSchedule(schedules);
    const now = utcnow();
    const snapB = schB.due(now);
    schedules.setEnabled(id, false, "op"); // disabled after B's snapshot
    schB.due = () => snapB;
    let submits = 0;
    const r = await schB.fireDue(() => (submits++, okSubmit(ctx)({})), now);
    expect(r.fired.length).toBe(0);
    expect(submits).toBe(0);
    expect(ctx.store.list("mission").length).toBe(0);
    expect(ctx.store.list("schedule_occurrence").length).toBe(0);
  });
});

/* --------------- §2 post-create exception reconciles via canonical fact --- */

describe("R3 §2 post-create exception reconciliation", () => {
  it("submit throws BEFORE mission creation → RELEASED, no mission, budget released", async () => {
    const { ctx, biz, schedules } = makeBizCtx("ex1");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    biz.createBudgetPolicy({
      business_id: bid, scope_type: "business", period: "DAY",
      max_missions: 1, operator_id: "op",
    });
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: bid });
    const r = await schedules.fireDue(() => {
      throw new Error("boom before createMission");
    }, utcnow());
    expect(r.fired.length).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(ctx.store.list("mission").length).toBe(0);
    const occ = ctx.store.get("schedule_occurrence", occId(id, dueAt));
    expect(String(occ.status)).toBe("RELEASED");
    expect(occ.mission_id).toBeNull();
    // reservation released — no capacity permanently consumed
    const live = ctx.store
      .list("budget_reservation")
      .filter((x) => ["HELD", "CONSUMED"].includes(String(x.status)));
    expect(live.length).toBe(0);
  });

  it("mission created then submit throws → occurrence FIRED+bound, one mission, budget consumed once", async () => {
    const { ctx, biz, schedules } = makeBizCtx("ex2");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    biz.createBudgetPolicy({
      business_id: bid, scope_type: "business", period: "DAY",
      max_missions: 5, operator_id: "op",
    });
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: bid });
    let createdMission: string | null = null;
    const r = await schedules.fireDue((input) => {
      // The mission lands in the canonical store, then the submit path
      // throws — exactly the runtimeEntity/wake crash window.
      const m = ctx.control.startMission({
        ...input,
        project_id: ctx.projectId,
        operator_id: "op",
      });
      createdMission = String(m.mission_id);
      throw new Error("boom after createMission");
    }, utcnow());
    // Canonical mission existence wins: fire counted, occurrence bound.
    expect(r.fired.length).toBe(1);
    expect(r.errors.length).toBe(0);
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(1);
    expect(String(missions[0].mission_id)).toBe(String(createdMission));
    const occ = ctx.store.get("schedule_occurrence", occId(id, dueAt));
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(createdMission));
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.last_mission_id)).toBe(String(createdMission));
    const consumed = ctx.store
      .list("budget_reservation")
      .filter((x) => String(x.status) === "CONSUMED");
    expect(consumed.length).toBe(1); // exactly once — no double charge
    const ev = ctx.store
      .listEvents("mission_schedule", id)
      .filter((e) => e.event_type === "SCHEDULE_FIRED");
    expect(ev.length).toBe(1);
    expect(String((ev[0].metadata as Record<string, unknown>).reconciled)).toBe(
      "post_create_exception",
    );
  });

  it("restart: fresh CLAIMED claim + canonical mission → reconcile binds FIRED immediately", () => {
    const { ctx, biz, schedules } = makeBizCtx("ex3");
    const b = setupBusiness(biz, ctx.projectId);
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: String(b.business_id) });
    const oid = occId(id, dueAt);
    // Simulate the crash window WITHOUT reconciliation yet: CLAIMED claim
    // (fresh — inside the grace TTL) and a mission that exists but was
    // never bound back.
    ctx.store.put(
      "schedule_occurrence",
      oid,
      {
        occurrence_id: oid, schedule_id: id, due_at: dueAt,
        business_id: String(b.business_id), status: "CLAIMED", mission_id: null,
        created_at: utcnow(), version: 0,
      },
      0,
    );
    const m = ctx.control.startMission({
      goal: "x", project_id: ctx.projectId, operator_id: "op",
      metadata: { schedule_occurrence_id: oid },
    });
    // Fresh stack on the same db — reconcile binds it with no TTL wait.
    const ctx2 = makeCtxOn(path.join(ctx.dir, "pair.db"), ctx.dir);
    const sch2 = new MissionScheduleService(ctx2.service);
    sch2.reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(m.mission_id));
    const ev = ctx.store
      .listEvents("schedule_occurrence", oid)
      .filter((e) => e.event_type === "SCHEDULE_OCCURRENCE_REPAIRED");
    expect(ev.length).toBe(1);
  });

  it("restart: legacy RELEASED + canonical mission → deterministic repair to FIRED", () => {
    const { ctx, biz, schedules } = makeBizCtx("ex4");
    const b = setupBusiness(biz, ctx.projectId);
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: String(b.business_id) });
    const oid = occId(id, dueAt);
    ctx.store.put(
      "schedule_occurrence",
      oid,
      {
        occurrence_id: oid, schedule_id: id, due_at: dueAt,
        business_id: String(b.business_id), status: "RELEASED", mission_id: null,
        released_at: utcnow(), release_cause: "submit_failed",
        created_at: utcnow(), version: 0,
      },
      0,
    );
    const m = ctx.control.startMission({
      goal: "x", project_id: ctx.projectId, operator_id: "op",
      metadata: { schedule_occurrence_id: oid },
    });
    const ctx2 = makeCtxOn(path.join(ctx.dir, "pair.db"), ctx.dir);
    new MissionScheduleService(ctx2.service).reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(m.mission_id));
    expect(
      ctx.store
        .listEvents("schedule_occurrence", oid)
        .some((e) => e.event_type === "SCHEDULE_OCCURRENCE_REPAIRED"),
    ).toBe(true);
  });

  it("FIRED bound to a different mission than the canonical claimant → audited integrity", () => {
    const { ctx, biz, schedules } = makeBizCtx("ex5");
    const b = setupBusiness(biz, ctx.projectId);
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: String(b.business_id) });
    const oid = occId(id, dueAt);
    const mOther = ctx.control.startMission({
      goal: "other", project_id: ctx.projectId, operator_id: "op", metadata: {},
    });
    ctx.store.put(
      "schedule_occurrence",
      oid,
      {
        occurrence_id: oid, schedule_id: id, due_at: dueAt,
        status: "FIRED", mission_id: String(mOther.mission_id),
        fired_at: utcnow(), created_at: utcnow(), version: 0,
      },
      0,
    );
    const mCanonical = ctx.control.startMission({
      goal: "x", project_id: ctx.projectId, operator_id: "op",
      metadata: { schedule_occurrence_id: oid },
    });
    new MissionScheduleService(makeCtxOn(path.join(ctx.dir, "pair.db"), ctx.dir).service).reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("FIRED"); // bound value NOT rewritten
    expect(String(occ.mission_id)).toBe(String(mOther.mission_id));
    const ev = ctx.store
      .listEvents("schedule_occurrence", oid)
      .filter((e) => e.event_type === "SCHEDULE_OCCURRENCE_INTEGRITY");
    expect(ev.length).toBe(1);
    expect(String((ev[0].metadata as Record<string, unknown>).canonical_mission_id)).toBe(
      String(mCanonical.mission_id),
    );
  });

  it("fresh CLAIMED claim with no mission is left untouched (in flight)", () => {
    const { ctx, biz, schedules } = makeBizCtx("ex6");
    const b = setupBusiness(biz, ctx.projectId);
    const { id, dueAt } = makeDueSchedule(schedules, { business_id: String(b.business_id) });
    const oid = occId(id, dueAt);
    ctx.store.put(
      "schedule_occurrence",
      oid,
      {
        occurrence_id: oid, schedule_id: id, due_at: dueAt,
        status: "CLAIMED", mission_id: null, created_at: utcnow(), version: 0,
      },
      0,
    );
    schedules.reconcileOccurrences();
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("CLAIMED"); // inside TTL — not released
  });
});

/* --------------- §3 bindOccurrenceMission fails closed -------------------- */

describe("R3 §3 occurrence binding fail-closed", () => {
  const bind = (schedules: MissionScheduleService, oid: string, mid: string) =>
    (schedules as unknown as { bindOccurrenceMission(o: string, m: string): void })
      .bindOccurrenceMission(oid, mid);

  function claimOnly(ctx: ReturnType<typeof makeCtxOn>, id: string, dueAt: string) {
    const oid = occId(id, dueAt);
    ctx.store.put(
      "schedule_occurrence", oid,
      { occurrence_id: oid, schedule_id: id, due_at: dueAt, status: "CLAIMED", mission_id: null, created_at: utcnow(), version: 0 },
      0,
    );
    return oid;
  }

  it("same-mission bind is idempotent", () => {
    const { ctx, schedules } = makeBizCtx("bind1");
    const { id, dueAt } = makeDueSchedule(schedules);
    const oid = claimOnly(ctx, id, dueAt);
    bind(schedules, oid, "MSN_one");
    bind(schedules, oid, "MSN_one"); // repeat — no-op, still proven
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe("MSN_one");
  });

  it("binding a different mission fails closed and preserves the first binding", () => {
    const { ctx, schedules } = makeBizCtx("bind2");
    const { id, dueAt } = makeDueSchedule(schedules);
    const oid = claimOnly(ctx, id, dueAt);
    bind(schedules, oid, "MSN_one");
    expect(() => bind(schedules, oid, "MSN_two")).toThrowError(
      /FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT/,
    );
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.mission_id)).toBe("MSN_one");
    expect(String(occ.status)).toBe("FIRED");
  });

  it("a second process binding a different mission fails closed; winner binding survives", () => {
    const { dir, ctx, schedules: schA } = makeBizCtx("bind3");
    const ctx2 = makeCtxOn(path.join(dir, "pair.db"), dir);
    const schB = new MissionScheduleService(ctx2.service);
    const { id, dueAt } = makeDueSchedule(schA);
    const oid = claimOnly(ctx, id, dueAt);
    bind(schA, oid, "MSN_winner");
    expect(() => bind(schB, oid, "MSN_loser")).toThrowError(
      /FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT/,
    );
    const occ = ctx.store.get("schedule_occurrence", oid);
    expect(String(occ.mission_id)).toBe("MSN_winner");
    expect(String(occ.status)).toBe("FIRED");
  });
});

/* ------------- §5/§6 row semantics + budget under two schedulers ---------- */

describe("R3 §5/§6 schedule row + budget semantics", () => {
  it("stale scheduler reserves no budget and mutates nothing", async () => {
    const { ctx, biz, schedules: schA } = makeBizCtx("sem1");
    const b = setupBusiness(biz, ctx.projectId);
    const bid = String(b.business_id);
    biz.createBudgetPolicy({
      business_id: bid, scope_type: "business", period: "DAY",
      max_missions: 10, operator_id: "op",
    });
    const schB = new MissionScheduleService(ctx.service);
    const { id } = makeDueSchedule(schA, { business_id: bid });
    const now = utcnow();
    const snapB = schB.due(now);
    const rA = await schA.fireDue(okSubmit(ctx), now);
    expect(rA.fired.length).toBe(1);
    const consumedAfterA = ctx.store
      .list("budget_reservation")
      .filter((x) => String(x.status) === "CONSUMED").length;
    expect(consumedAfterA).toBe(1);
    schB.due = () => snapB; // stale X snapshot
    const rB = await schB.fireDue(() => {
      throw new Error("must not run");
    }, now);
    expect(rB.fired.length).toBe(0);
    // no second reservation of any kind was created by the stale run
    expect(ctx.store.list("budget_reservation").length).toBe(
      ctx.store.list("budget_reservation").length,
    );
    expect(
      ctx.store.list("budget_reservation").filter((x) => String(x.status) === "CONSUMED").length,
    ).toBe(1);
    const final = schA.get(id);
    expect(Number(final.run_count)).toBe(1);
    expect(final.last_mission_id).not.toBeNull();
  });
});
