/**
 * P11 REMEDIATION R5 tests — NEXT_DUE FINAL SEMANTICS.
 * A successful occurrence advances the schedule to
 * nextRunAfter(cron, occurrence.due_at) — never nextRunAfter(cron, now) —
 * so missed occurrences between the fired occurrence and the wall clock
 * are due work in their own right and are caught up, not skipped.
 *
 *  §6.A missed-tick fire: dueAt=10:00, now=10:20 → next_due_at=10:05
 *  §6.B post-create-exception success path uses the same anchor
 *  §6.C legacy repair: stored next_due_at=10:25 with a gap of
 *       un-attempted ticks rewinds to the first un-accounted tick 10:05
 *  §6.D multiple contiguous FIRED occurrences → latest is the anchor
 *  §6.E repeated reconciliation is idempotent
 *  §6.F R2 worker_threads schedule race stays green (suite-level)
 *  extra: contiguous-accounted semantics — gaps and non-terminal rows
 *         end the chain (fail-closed proof, no blind rewind)
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

const ROOT = mkTmpDir("pair-p11r5-");
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

// */5 cron ticks — every constant is a real occurrence boundary.
const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T10:05:00.000Z";
const T2 = "2026-01-01T10:10:00.000Z";
const T3 = "2026-01-01T10:15:00.000Z";
const T4 = "2026-01-01T10:20:00.000Z"; // the "now" of the crash
const T5 = "2026-01-01T10:25:00.000Z"; // the pre-R5 skip value nextRunAfter(cron, T4)

function occId(scheduleId: string, dueAt: string): string {
  return `OCC_${digest(`schedule-occurrence:${scheduleId}:${dueAt}`).slice(0, 24)}`;
}

/** Schedule with a pinned next_due_at (no occurrences implied). */
function scheduleDueAt(schedules: MissionScheduleService, dueAt: string) {
  const s = schedules.create({ goal: "tick", cron: "*/5 * * * *", operator_id: "op" });
  const id = String(s.schedule_id);
  const row = schedules.get(id);
  row.next_due_at = dueAt;
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
  createdAt: string | null = null,
) {
  const oid = occId(scheduleId, dueAt);
  store.put(
    "schedule_occurrence",
    oid,
    {
      occurrence_id: oid, schedule_id: scheduleId, due_at: dueAt,
      business_id: null, status, mission_id: missionId,
      fired_at: firedAt, created_at: createdAt ?? dueAt, version: 0,
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

const events = (ctx: ReturnType<typeof makeCtxOn>, type: string) =>
  ctx.store.listEvents().filter((e) => String(e.event_type) === type);

const okSubmit =
  (ctx: ReturnType<typeof makeCtxOn>) =>
  (input: Record<string, unknown>) =>
    ctx.control.startMission({ ...input, project_id: ctx.projectId, operator_id: "op" });

/* ------------------------------- §6.A / §6.B ------------------------------ */

describe("R5 §6 fireDue advances by canonical occurrence time, not wall clock", () => {
  it("A. missed-tick fire: dueAt=10:00 fired at now=10:20 → next_due_at=10:05, run_count=1", async () => {
    const { ctx, schedules } = makeBizCtx("r5a");
    const id = scheduleDueAt(schedules, T0);
    const r = await schedules.fireDue(okSubmit(ctx), T4);
    expect(r.fired.length).toBe(1);
    expect(r.errors.length).toBe(0);
    const missions = ctx.store.list("mission");
    expect(missions.length).toBe(1);
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    // nextRunAfter(cron, dueAt) — NOT nextRunAfter(cron, now)=10:25.
    // The missed occurrences 10:05–10:20 remain due for the next pass.
    expect(String(sch.next_due_at)).toBe(T1);
    const occ = ctx.store.get("schedule_occurrence", occId(id, T0));
    expect(String(occ.status)).toBe("FIRED");
  });

  it("B. post-create exception (mission exists, submit throws) → same canonical advance", async () => {
    const { ctx, schedules } = makeBizCtx("r5b");
    const id = scheduleDueAt(schedules, T0);
    let createdMission: string | null = null;
    const r = await schedules.fireDue((input) => {
      const m = ctx.control.startMission({
        ...input,
        project_id: ctx.projectId,
        operator_id: "op",
      });
      createdMission = String(m.mission_id);
      throw new Error("boom after createMission");
    }, T4);
    expect(r.fired.length).toBe(1); // reconciled as a canonical success
    const occ = ctx.store.get("schedule_occurrence", occId(id, T0));
    expect(String(occ.status)).toBe("FIRED");
    expect(String(occ.mission_id)).toBe(String(createdMission));
    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.next_due_at)).toBe(T1); // 10:05, not 10:25
    expect(String(sch.last_mission_id)).toBe(String(createdMission));
  });
});

/* ------------------------- §6.C / §6.D / §6.E ----------------------------- */

describe("R5 §6 restart reconciliation repairs skipped next_due_at", () => {
  it("C. legacy skip state: FIRED 10:00 + stored next_due_at=10:25 → rewinds to 10:05", () => {
    const { ctx, schedules } = makeBizCtx("r5c");
    const id = scheduleDueAt(schedules, T0);
    const oid = occId(id, T0);
    const m = craftMission(ctx, id, oid, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    const row = schedules.get(id);
    row.next_due_at = T5; // legacy pre-R5 skip: nextRunAfter(cron, now)
    row.run_count = 0;
    row.last_mission_id = null;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1);
    expect(String(sch.next_due_at)).toBe(T1); // gap 10:05–10:20 un-attempted → 10:05
    expect(String(sch.last_mission_id)).toBe(String(m.mission_id));
    expect(
      events(ctx, "SCHEDULE_ACCOUNTING_RECONCILED").length,
    ).toBeGreaterThan(0);
  });

  it("D. contiguous FIRED 10:00/10:05/10:10 → run_count=3, next_due_at=10:15, last=10:10 mission", () => {
    const { ctx, schedules } = makeBizCtx("r5d");
    const id = scheduleDueAt(schedules, T0);
    let latestMission: string | null = null;
    for (const t of [T0, T1, T2]) {
      const oid = occId(id, t);
      const m = craftMission(ctx, id, oid, t);
      craftOccurrence(ctx.store, id, t, "FIRED", String(m.mission_id), t);
      latestMission = String(m.mission_id);
    }
    const row = schedules.get(id);
    row.next_due_at = T0; // fully stale
    row.run_count = 0;
    row.last_mission_id = null;
    row.last_fired_at = null;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(3);
    expect(String(sch.last_mission_id)).toBe(String(latestMission));
    expect(String(sch.next_due_at)).toBe(T3); // 10:15
  });

  it("E. repeated reconcile is idempotent after the first correct repair", () => {
    const { ctx, schedules } = makeBizCtx("r5e");
    const id = scheduleDueAt(schedules, T0);
    const oid = occId(id, T0);
    const m = craftMission(ctx, id, oid, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    const row = schedules.get(id);
    row.next_due_at = T5;
    row.run_count = 0;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    const svc = new MissionScheduleService(ctx.service);
    svc.reconcileScheduleAccounting();
    const after1 = schedules.get(id);
    expect(String(after1.next_due_at)).toBe(T1);
    const v1 = Number(after1.version);
    svc.reconcileScheduleAccounting();
    svc.reconcileScheduleAccounting();
    const after2 = schedules.get(id);
    expect(Number(after2.version)).toBe(v1); // no further mutation
  });
});

/* --------------------------- contiguity proofs --------------------------- */

describe("R5 contiguous-accounted anchor (no blind rewind, no blind skip)", () => {
  it("gap: FIRED 10:00 + FIRED 10:15 but 10:05/10:10 never attempted → next_due_at=10:05", () => {
    const { ctx, schedules } = makeBizCtx("r5gap");
    const id = scheduleDueAt(schedules, T0);
    const oid0 = occId(id, T0);
    const m0 = craftMission(ctx, id, oid0, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m0.mission_id), T0);
    const oid3 = occId(id, T3);
    const m3 = craftMission(ctx, id, oid3, T3);
    craftOccurrence(ctx.store, id, T3, "FIRED", String(m3.mission_id), T3);
    const row = schedules.get(id);
    row.next_due_at = T4;
    row.run_count = 0;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(2); // both FIRED count
    expect(String(sch.last_mission_id)).toBe(String(m3.mission_id)); // latest fired
    // Contiguous chain ends at 10:00 — the un-attempted 10:05 tick is next.
    expect(String(sch.next_due_at)).toBe(T1);
  });

  it("RELEASED occurrence extends the anchor: FIRED 10:00 + RELEASED 10:05 → next_due_at=10:10", () => {
    const { ctx, schedules } = makeBizCtx("r5rel");
    const id = scheduleDueAt(schedules, T0);
    const oid0 = occId(id, T0);
    const m0 = craftMission(ctx, id, oid0, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m0.mission_id), T0);
    craftOccurrence(ctx.store, id, T1, "RELEASED"); // attempted, dropped
    const row = schedules.get(id);
    row.next_due_at = T3; // skip state
    row.run_count = 0;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(Number(sch.run_count)).toBe(1); // released does not count
    expect(String(sch.next_due_at)).toBe(T2); // 10:05 accounted → next is 10:10
  });

  it("fresh in-flight CLAIMED ends the chain: FIRED 10:00 + CLAIMED 10:05 → next_due_at=10:05", () => {
    const { ctx, schedules } = makeBizCtx("r5claim");
    const id = scheduleDueAt(schedules, T0);
    const oid0 = occId(id, T0);
    const m0 = craftMission(ctx, id, oid0, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m0.mission_id), T0);
    // Fresh CLAIMED (within TTL — reconcileOccurrences leaves it alone).
    craftOccurrence(ctx.store, id, T1, "CLAIMED", null, null, utcnow());
    const row = schedules.get(id);
    row.next_due_at = T3;
    row.run_count = 0;
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const sch = schedules.get(id);
    expect(String(sch.next_due_at)).toBe(T1); // not skipped past in-flight work
  });
});

/* -------------------------------- §6.E rest ------------------------------ */

describe("R5 §6 idempotent + genuine restart", () => {
  it("genuine restart: close store, fresh stack on same db → accounting repaired", () => {
    const first = makeBizCtx("r5rst");
    const id = scheduleDueAt(first.schedules, T0);
    const oid = occId(id, T0);
    const m = craftMission(first.ctx, id, oid, T0);
    craftOccurrence(first.ctx.store, id, T0, "FIRED", String(m.mission_id), T0);
    const row = first.schedules.get(id);
    row.next_due_at = T5;
    row.run_count = 0;
    row.last_mission_id = null;
    first.ctx.store.put("mission_schedule", id, row, Number(row.version));
    const dbPath = path.join(first.dir, "pair.db");
    first.ctx.store.close();

    const second = makeCtxOn(dbPath, first.dir);
    const sch = new MissionScheduleService(second.service);
    sch.reconcileScheduleAccounting();

    const row2 = sch.get(id);
    expect(Number(row2.run_count)).toBe(1);
    expect(String(row2.next_due_at)).toBe(T1);
    expect(String(row2.last_mission_id)).toBe(String(m.mission_id));
    // verifyIntegrity throws on any entity hash mismatch — surviving it
    // is the integrity proof.
    const integrity = second.store.verifyIntegrity();
    expect(Number(integrity.entities)).toBeGreaterThan(0);
    second.store.close();
  });
});
