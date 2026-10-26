/**
 * P18.1 — planner validation-rejection feedback into the ReasoningBrief.
 *
 * When a planner attempt fails canonical plan validation, the NEXT CEO
 * cycle must see WHY instead of blindly re-dispatching the same shape:
 *
 *   PF1 — the `planner` BrainContext section exists, is digest-stable on
 *         unchanged state, and reports zero rejections for a fresh
 *         objective.
 *   PF2 — a failed (PLAN_INVALID) attempt attributed to the objective
 *         surfaces in recent_rejections with its validation codes,
 *         task hints, run state and lineage work_item_id.
 *   PF3 — briefFor emits PLANNER_RUN_SUMMARY + PLAN_VALIDATION_REJECTION
 *         facts, provenance CANONICAL, sections ["planner"].
 *   PF4 — bounds: >3 rejections → recent_rejections ≤ 3 newest-first,
 *         rejected_attempt_count counts ALL; codes ≤ 4, hints ≤ 8.
 *   PF5 — exclusion: SUCCESS / non-validation failures (TIMEOUT, no
 *         markers) / STARTED crash residue never appear.
 *   PF6 — cross-objective isolation: B's rejections never leak into A.
 *   PF7 — PLANNER_VALIDATION_REPEATING hypothesis only at ≥2 rejections
 *         (dominant code named when ≥2 share it).
 *   PF8 — digest chain: brief_digest tracks the rejection landing.
 *
 * Evidence rows are built through the REAL canonical seams:
 * beginPlannerRun → admitPlannerInvocation (objective lineage via the
 * delegated child) → persistPlannerAttemptStart → markPlannerAttemptReask
 * → settlePlannerAttempt → finishPlannerRun.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BrainContextService,
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
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ReasoningBriefService,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  assertCanonicalMissionLifecycle,
  beginPlannerRun,
  markPlannerAttemptReask,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  finishPlannerRun,
} from "../pair/index.js";
import { canonicallyTerminateMission } from "./canonical-mission-completion.js";

const ROOT = mkTmpDir("pair-pf-");
const OP = "pf-owner";
const OWNER = `operator:${OP}`;
const KPI = "KPI_DELIVERABLES";
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;
type Row = Record<string, unknown>;

function freshFullStack(name: string) {
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
    schedules: new MissionScheduleService(service) });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(dir, "artifacts", "blobs") });
  const project = service.createProject({ name: "p", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
  });
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    control, projectId: String(project.project_id), brain };
}
type FullStack = ReturnType<typeof freshFullStack>;

function mkBusiness(s: FullStack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: FullStack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "obj", statement: "Produce deliverables.",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: OP,
  });
}

function decompose(s: FullStack, oid: string, keys: string[]) {
  const o = s.biz.objectives.get(oid);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}` })) as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Row, key: string): string {
  return String((binding.workstreams as Row[])
    .find((w) => String(w.workstream_key) === key)!.work_item_id);
}

function childOfKey(s: FullStack, binding: Row, key: string): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list("workforce_allocation").find(
    (r) => String((r as Row).workstream_work_item_id) === wid);
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String((wal as Row).delegated_child_work_item_id);
}

function seeded(name: string, keys: string[] = ["a"]) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = keys.length ? decompose(s, oid, keys) : null;
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  if (binding) {
    for (const k of keys) {
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
    }
  }
  return { s, oid, bid, binding };
}

const CODE = "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT";

/** Full canonical evidence path for one rejected planner attempt. */
function plantRejection(
  s: FullStack,
  childWorkItemId: string,
  opts: {
    outcome?: "SUCCESS" | "FAILED";
    failure_class?: string;
    warnings?: string[];
    runOutcome?: string;
  } = {},
): { planner_run_id: string; planner_attempt_id: string } {
  const run = beginPlannerRun(s.store, { routes: ["p:A"], actor: "PAIR_PLANNER" });
  const runId = String(run.planner_run_id);
  s.service.cost.admitPlannerInvocation({
    planner_run_id: runId, work_item_id: childWorkItemId,
    est_microusd: 0, actor: "PAIR_PLANNER" });
  const { planner_attempt_id } = persistPlannerAttemptStart(s.store, {
    planner_run_id: runId,
    record: {
      route: "p:A", provider: "p", model_entry_id: "ME_T", model: "m",
      role: "PLANNER_COORDINATOR", attempt_no: 1,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      latency_ms: 1, provider_requests: 2, warnings: [],
    },
    actor: "PAIR_PLANNER",
  });
  markPlannerAttemptReask(s.store, {
    planner_attempt_id, validation_code: CODE, actor: "PAIR_PLANNER" });
  settlePlannerAttempt(s.store, {
    planner_attempt_id,
    record: {
      route: "p:A", provider: "p", model_entry_id: "ME_T", model: "m",
      role: "PLANNER_COORDINATOR", attempt_no: 1,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      latency_ms: 1, provider_requests: 2,
      outcome: opts.outcome ?? "FAILED",
      failure_class: opts.failure_class ?? "PLAN_INVALID",
      warnings: opts.warnings ?? [
        `VALIDATION_CODE:${CODE}`, `REASK:${CODE}`,
        "DROP_UNSERVABLE_CAPS:T3", "CANONICAL_VALIDATION_FAILED",
      ],
    },
    actor: "PAIR_PLANNER",
  });
  finishPlannerRun(s.store, {
    planner_run_id: runId, outcome: opts.runOutcome ?? "EXHAUSTED",
    actor: "PAIR_PLANNER" });
  return { planner_run_id: runId, planner_attempt_id };
}

function plannerSection(s: FullStack, oid: string) {
  const ctx = s.brain.contextFor(oid, OWNER);
  return ctx.sections.planner;
}

function briefFacts(s: FullStack, oid: string) {
  const b = new ReasoningBriefService(s.store, { brain: s.brain })
    .briefFor(oid, OWNER);
  return b;
}

describe("P18.1 planner validation-rejection → ReasoningBrief", () => {
  it("PF1 section present, empty, digest-stable on unchanged state", () => {
    const { s, oid } = seeded("pf1");
    const p = plannerSection(s, oid);
    expect(p).toBeDefined();
    const v = p.value as Row;
    expect(v.recent_rejections).toEqual([]);
    expect(v.rejected_attempt_count).toBe(0);
    const c1 = s.brain.contextFor(oid, OWNER).context_digest;
    const c2 = s.brain.contextFor(oid, OWNER).context_digest;
    expect(c1).toBe(c2);
  });

  it("PF2 failed PLAN_INVALID attempt surfaces with codes + lineage", () => {
    const { s, oid, binding } = seeded("pf2");
    const child = childOfKey(s, binding!, "a");
    const { planner_attempt_id, planner_run_id } = plantRejection(s, child);
    const v = plannerSection(s, oid).value as Row;
    expect(v.rejected_attempt_count).toBe(1);
    const r = (v.recent_rejections as Row[])[0];
    expect(r.planner_attempt_id).toBe(planner_attempt_id);
    expect(r.planner_run_id).toBe(planner_run_id);
    expect(r.work_item_id).toBe(child);
    expect(r.run_state).toBe("EXHAUSTED");
    expect(r.run_attempt_count).toBe(1);
    expect(r.failure_class).toBe("PLAN_INVALID");
    expect(r.validation_codes).toContain(CODE);
    expect(r.reask_attempted).toBe(true);
    expect(r.task_hints).toContain("DROP_UNSERVABLE_CAPS:T3");
  });

  it("PF3 brief emits CANONICAL PLAN_VALIDATION_REJECTION + summary facts", () => {
    const { s, oid, binding } = seeded("pf3");
    plantRejection(s, childOfKey(s, binding!, "a"));
    const b = briefFacts(s, oid);
    const rej = b.facts.filter((f) => f.predicate === "PLAN_VALIDATION_REJECTION");
    expect(rej).toHaveLength(1);
    expect(rej[0].provenance).toBe("CANONICAL");
    expect(rej[0].sections).toEqual(["planner"]);
    const sum = b.facts.find((f) => f.predicate === "PLANNER_RUN_SUMMARY");
    expect(sum).toBeDefined();
    expect((sum!.value as Row).rejected_attempt_count).toBe(1);
  });

  it("PF4 bounds — 5 rejections → newest-3 shown, all counted", () => {
    const { s, oid, binding } = seeded("pf4");
    const child = childOfKey(s, binding!, "a");
    const hints = Array.from({ length: 12 }, (_, i) => `DROP_X:T${i}`);
    for (let i = 0; i < 5; i++) {
      plantRejection(s, child, {
        warnings: [
          `VALIDATION_CODE:${CODE}`, `VALIDATION_CODE:C2`, `VALIDATION_CODE:C3`,
          `VALIDATION_CODE:C4`, `VALIDATION_CODE:C5`,
          ...hints.map((h) => `${h}`),
        ],
      });
    }
    const v = plannerSection(s, oid).value as Row;
    expect(v.rejected_attempt_count).toBe(5);
    const shown = v.recent_rejections as Row[];
    expect(shown.length).toBe(3);
    // newest-first ordering proven, not just bounded.
    const stamps = shown.map((r) => String(r.completed_at));
    expect([...stamps].sort((a, b) => b.localeCompare(a))).toEqual(stamps);
    const r0 = shown[0];
    expect((r0.validation_codes as string[]).length).toBeLessThanOrEqual(4);
    expect((r0.task_hints as string[]).length).toBeLessThanOrEqual(8);
  });

  it("PF5 exclusion — SUCCESS / TIMEOUT-without-markers / STARTED are invisible", () => {
    const { s, oid, binding } = seeded("pf5");
    const child = childOfKey(s, binding!, "a");
    plantRejection(s, child, {
      outcome: "SUCCESS", failure_class: undefined, warnings: [], runOutcome: "WINNER_SELECTED" });
    plantRejection(s, child, {
      failure_class: "TRANSPORT", warnings: ["TRANSPORT_DEATH"] });
    // STARTED residue: start an attempt, never settle.
    const run = beginPlannerRun(s.store, { routes: ["p:A"], actor: "PAIR_PLANNER" });
    s.service.cost.admitPlannerInvocation({
      planner_run_id: String(run.planner_run_id), work_item_id: child,
      est_microusd: 0, actor: "PAIR_PLANNER" });
    persistPlannerAttemptStart(s.store, {
      planner_run_id: String(run.planner_run_id),
      record: {
        route: "p:A", provider: "p", model_entry_id: "ME_T", model: "m",
        role: "PLANNER_COORDINATOR", attempt_no: 1,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        latency_ms: 1, provider_requests: 1, warnings: [],
      },
      actor: "PAIR_PLANNER",
    });
    const v = plannerSection(s, oid).value as Row;
    expect(v.rejected_attempt_count).toBe(0);
    expect(v.recent_rejections).toEqual([]);
  });

  it("PF6 cross-objective isolation — B's rejection never leaks into A", () => {
    const { s, oid, binding } = seeded("pf6a");
    plantRejection(s, childOfKey(s, binding!, "a"));
    const other = mkObjective(s, seeded_biz(s));
    const oidB = String(other.objective_id);
    const vB = plannerSection(s, oidB).value as Row;
    expect(vB.rejected_attempt_count).toBe(0);
    const bA = briefFacts(s, oid);
    const bB = briefFacts(s, oidB);
    expect(bA.facts.some((f) => f.predicate === "PLAN_VALIDATION_REJECTION")).toBe(true);
    expect(bB.facts.some((f) => f.predicate === "PLAN_VALIDATION_REJECTION")).toBe(false);
  });

  it("PF7 repeating hypothesis only at ≥2 rejections, dominant code named", () => {
    const { s, oid, binding } = seeded("pf7");
    const child = childOfKey(s, binding!, "a");
    plantRejection(s, child);
    let b = briefFacts(s, oid);
    expect(b.hypotheses.some((h) => h.id === "PLANNER_VALIDATION_REPEATING")).toBe(false);
    plantRejection(s, child);
    plantRejection(s, child, {
      warnings: ["VALIDATION_CODE:OTHER_CODE"] });
    b = briefFacts(s, oid);
    const h = b.hypotheses.find((x) => x.id === "PLANNER_VALIDATION_REPEATING");
    expect(h).toBeDefined();
    expect(h!.detail).toContain(CODE);
    expect(h!.rests_on).toContain("PLAN_VALIDATION_REJECTION");
  });

  it("PF9 terminal_outcome neutralization — owner-acknowledged UNKNOWN exec is not live", () => {
    const { s, oid, binding } = seeded("pf9");
    const child = childOfKey(s, binding!, "a");
    if (String(s.store.get("work_item", child).status) === "READY") {
      s.biz.openWorkItem(child, OP);
    }
    const mid = String(s.biz.boundMissionForWorkItem(
      s.store.get("work_item", child))!.mission_id);
    canonicallyTerminateMission(s.store, s.service, mid, "FAILED");
    // The wedge scenario: worker died mid-flight → UNKNOWN, operator
    // reconciled through governed approve → terminal_outcome set.
    s.store.put("executor_execution", `EX_${counter}`, {
      mission_id: mid, governed_task_id: `GT_${counter}`,
      execution_state: "UNKNOWN",
      terminal_outcome: "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY",
      cancel_requested: false, version: 0,
    }, 0);
    const mission = s.store.get("mission", mid) as Row;
    // Before the fix this threw WORK_PROVENANCE_CORRUPT forever.
    expect(() =>
      assertCanonicalMissionLifecycle(s.store, mission, "FAILED"),
    ).not.toThrow();
  });

  it("PF10 marker-free UNKNOWN exec still wedges — exclusion is not a blanket bypass", () => {
    const { s, oid, binding } = seeded("pf10");
    const child = childOfKey(s, binding!, "a");
    if (String(s.store.get("work_item", child).status) === "READY") {
      s.biz.openWorkItem(child, OP);
    }
    const mid = String(s.biz.boundMissionForWorkItem(
      s.store.get("work_item", child))!.mission_id);
    canonicallyTerminateMission(s.store, s.service, mid, "FAILED");
    s.store.put("executor_execution", `EX_${counter}`, {
      mission_id: mid, governed_task_id: `GT_${counter}`,
      execution_state: "UNKNOWN",
      cancel_requested: false, version: 0,
    }, 0);
    const mission = s.store.get("mission", mid) as Row;
    expect(() =>
      assertCanonicalMissionLifecycle(s.store, mission, "FAILED"),
    ).toThrowError(/live executions contradict/);
  });

  it("PF8 digest chain — brief_digest tracks a landing rejection", () => {
    const { s, oid, binding } = seeded("pf8");
    const svc = new ReasoningBriefService(s.store, { brain: s.brain });
    const d1 = svc.briefFor(oid, OWNER).brief_digest;
    plantRejection(s, childOfKey(s, binding!, "a"));
    const d2 = svc.briefFor(oid, OWNER).brief_digest;
    expect(d2).not.toBe(d1);
  });
});

function seeded_biz(s: FullStack) {
  return mkBusiness(s);
}
