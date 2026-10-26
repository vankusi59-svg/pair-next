/**
 * P11 REMEDIATION R6 tests — CONCURRENT SCHEDULE ROW MERGE CLOSURE.
 * A scheduler that loses the occurrence claim (or the schedule-row CAS)
 * must never merge stale snapshot fields over the canonical outcome.
 *
 *  §3   claim loser: no mission, no accounting mutation, reconcile only
 *  §5   last_error derivable: FIRED anchor clears stale errors,
 *       RELEASED anchor preserves the owner's recorded failure
 *  §6/§7 true worker_threads races live in pair-p11-r2.test.ts
 *        (extended F assertions + new G previous-occurrence race).
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

const ROOT = mkTmpDir("pair-p11r6-");
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
const T1 = "2026-01-01T10:05:00.000Z";

function occId(scheduleId: string, dueAt: string): string {
  return `OCC_${digest(`schedule-occurrence:${scheduleId}:${dueAt}`).slice(0, 24)}`;
}

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
  extra: Record<string, unknown> = {},
) {
  const oid = occId(scheduleId, dueAt);
  store.put(
    "schedule_occurrence",
    oid,
    {
      occurrence_id: oid, schedule_id: scheduleId, due_at: dueAt,
      business_id: null, status, mission_id: missionId,
      fired_at: null, created_at: dueAt, version: 0, ...extra,
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

const okSubmit =
  (ctx: ReturnType<typeof makeCtxOn>) =>
  (input: Record<string, unknown>) =>
    ctx.control.startMission({ ...input, project_id: ctx.projectId, operator_id: "op" });

describe("R6 §3 claim loser never mutates the schedule row", () => {
  it("due schedule + pre-existing fresh CLAIMED occurrence → no mission, no row write", async () => {
    const { ctx, schedules } = makeBizCtx("r6loser");
    const id = scheduleDueAt(schedules, T0);
    // Another process holds this occurrence in-flight (fresh, inside TTL).
    craftOccurrence(ctx.store, id, T0, "CLAIMED", null, { created_at: utcnow() });
    const before = schedules.get(id);
    const v0 = Number(before.version);

    const r = await schedules.fireDue(okSubmit(ctx), utcnow());

    expect(r.fired.length).toBe(0); // this process owns no outcome
    expect(ctx.store.list("mission").length).toBe(0);
    const after = schedules.get(id);
    // Loser must not merge/fabricate: row entirely untouched.
    expect(Number(after.version)).toBe(v0);
    expect(Number(after.run_count)).toBe(0);
    expect(after.last_mission_id ?? null).toBeNull();
    expect(after.last_fired_at ?? null).toBeNull();
    expect(after.last_error ?? null).toBeNull();
  });
});

describe("R6 §5 last_error derives deterministically from the anchor", () => {
  it("FIRED anchor clears a stale last_error", () => {
    const { ctx, schedules } = makeBizCtx("r6clear");
    const id = scheduleDueAt(schedules, T0);
    const oid = occId(id, T0);
    const m = craftMission(ctx, id, oid, T0);
    craftOccurrence(ctx.store, id, T0, "FIRED", String(m.mission_id), { fired_at: T0 });
    const row = schedules.get(id);
    row.last_error = "stale boom";
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const after = schedules.get(id);
    expect(after.last_error ?? null).toBeNull();
    expect(Number(after.run_count)).toBe(1);
    expect(String(after.next_due_at)).toBe(T1);
  });

  it("RELEASED anchor preserves the recorded failure, never fabricates", () => {
    const { ctx, schedules } = makeBizCtx("r6keep");
    const id = scheduleDueAt(schedules, T0);
    craftOccurrence(ctx.store, id, T0, "RELEASED", null, {
      release_cause: "submit_failed",
      released_at: T0,
    });
    const row = schedules.get(id);
    row.last_error = "provider timeout after 30s";
    ctx.store.put("mission_schedule", id, row, Number(row.version));

    new MissionScheduleService(ctx.service).reconcileScheduleAccounting();

    const after = schedules.get(id);
    expect(String(after.last_error)).toBe("provider timeout after 30s");
    expect(Number(after.run_count)).toBe(0); // released does not count
    expect(String(after.next_due_at)).toBe(T1);
  });
});
