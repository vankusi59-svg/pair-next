/**
 * PHASE C — UNIFIED LLM PLANNING & TEMPLATE REMOVAL.
 *
 * The deterministic task-template fallback is gone: every NEW Mission
 * carries a persisted authorized plan (metadata.llm_plan from the
 * shared async Planner Pool seam, or pinned_plan_tasks from a
 * confirmed preview), and every ingress — delegated WorkItem open,
 * Conversation draft confirm, schedule fire — crosses the SAME
 * planExpander seam before mission creation.
 *
 * Matrix (Design R3 acceptance, adapted to verified seams):
 *   PC1–PC3   prepareDelegatedPlan guards — missing planner dep,
 *             absent plan, missing operator all fail typed + closed
 *   PC4       prepare → open binds plan+goal digest+planner provenance
 *   PC5       prepared plan replayed against a DIFFERENT goal →
 *             FAIL_CLOSED_DELEGATED_PLAN_GOAL_DRIFT before any write
 *   PC6       legacy plan-less bound open → mission mints but
 *             terminalizes FAILED with FAIL_CLOSED_PLAN_REQUIRED
 *   PC7–PC8   scheduler — no expander → NO_PLANNER per fire; with
 *             expander → mission minted carrying the canonical plan
 *   PC9       draft confirm — no planner dep → typed failure, draft
 *             stays SUBMITTING; retry once planning exists succeeds
 *   PC10–PC11 run-level planner deadline — expiry denies untried
 *             candidates and discards late results (never a winner)
 *   PC12–PC13 planner cost governance — objective-scoped atomic
 *             admission / settle / reconcile of planner reservations
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  BusinessLayer,
  canonicalJson,
  ConversationSessionService,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  makeServePlanner,
  MissionControl,
  MissionDraftService,
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
  runPlannerFailover,
  SERVE_LLM_PLANNER_CAPS,
  utcnow,
  beginPlannerRun,
  finishPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  type DelegatedPlanExpander,
  type PlannerCandidate,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phasec-"));
let counter = 0;
const OP = "op:phasec";
const CAPS = SERVE_LLM_PLANNER_CAPS.slice();

/** A work-goal the plan-coverage contract accepts (local-file analysis,
 *  no external/current-data demand). */
const LOCAL_GOAL =
  "Phân tích dữ liệu trong file báo cáo local.";

/** A pool winner's RAW emission for LOCAL_GOAL — the canonicalizer
 *  injects T1 bookkeeping; llm_plan is always the CANONICAL form. */
const RAW_WORK = () => [
  {
    task_key: "T2",
    title: "local analysis",
    task_instruction:
      "Phân tích dữ liệu trong file báo cáo local và ghi tóm tắt vào " +
      "analysis.txt, rồi trả lời DONE.",
    required_capabilities: ["REASONING"],
    depends_on: [],
    metadata: {},
  },
];

type CanonFn = (tasks: Array<Record<string, unknown>>, goal: string,
  opts?: { provenance?: string }) => Array<Record<string, unknown>>;

/** The production-expander shape over the REAL canonicalize + durable
 *  run-evidence seams — a real planner_run row is opened and settled
 *  WINNER_SELECTED so preview/confirm provenance resolves. */
const canonExpanderFrom = (canon: CanonFn, store: PairEvidenceStore): DelegatedPlanExpander =>
  (async (input: Record<string, unknown>) => {
    const run = beginPlannerRun(store, {
      routes: ["test:m1"],
      project_id: input.project_id != null ? String(input.project_id) : undefined,
      operator_id: input.operator_id != null ? String(input.operator_id) : undefined,
      actor: "TEST",
    });
    const tasks = canon(RAW_WORK(), String(input.goal ?? ""), {
      provenance: "fresh",
    });
    const rec = {
      route: "test:m1", provider: "test", model_entry_id: "ME_T",
      model: "m1", role: "PLANNER_COORDINATOR", attempt_no: 1,
      started_at: utcnow(), completed_at: utcnow(), latency_ms: 1,
      outcome: "SUCCESS", warnings: [], plan_digest: null,
    };
    const paid = persistPlannerAttemptStart(store, {
      planner_run_id: String(run.planner_run_id),
      record: rec as never, actor: "TEST",
    }).planner_attempt_id;
    settlePlannerAttempt(store, {
      planner_attempt_id: String(paid),
      record: rec as never, winner: true, actor: "TEST",
    });
    finishPlannerRun(store, {
      planner_run_id: String(run.planner_run_id),
      outcome: "WINNER_SELECTED", winner_attempt_no: 1, actor: "TEST",
    });
    return {
      input: {
        ...input,
        metadata: {
          ...(input.metadata as Record<string, unknown> | undefined),
          llm_plan: tasks,
          plan_source: "LLM",
          plan_model: "test-planner",
        },
      },
      planner: {
        planner_run_id: String(run.planner_run_id),
        attempts: [rec], winner: rec,
      },
    };
  }) as DelegatedPlanExpander;

const canonExpander = (s: { canon: CanonFn; store: PairEvidenceStore }): DelegatedPlanExpander =>
  canonExpanderFrom(s.canon, s.store);

function stack(
  name: string,
  opts: {
    /** undefined → no planner dep (NO_PLANNER paths); "canon" → the
     *  canonical expander (raw emission → makeServeCanonicalizer →
     *  llm_plan); otherwise an explicit expander stub. */
    planExpander?: DelegatedPlanExpander | "canon" | null;
  } = {},
) {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  for (const c of CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  // THE production planner — template tail removed: initial requires a
  // persisted plan (pinned or llm_plan); replan requires a provider.
  const { planner, canonicalizeLlmTasks: canon } = makeServePlanner({
    executorCapSets: () => [CAPS],
    replanProvider: null,
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map() as never, scheduler,
    approvals, reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const schedules = new MissionScheduleService(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    schedules, planner: planner as never,
  });
  // The shared async Planner Pool seam — same call shape every ingress
  // makes. "canon" plays the production expander's role: a winner's raw
  // emission canonicalized FRESH → metadata.llm_plan + provenance.
  const expander =
    opts.planExpander === "canon"
      ? canonExpanderFrom(canon, store)
      : opts.planExpander ?? undefined;
  const biz = new BusinessLayer({
    store, control, schedules,
    ...(expander ? { planExpander: expander } : {}),
  });
  const conv = new ConversationSessionService(store);
  const drafts = new MissionDraftService({
    conversation: conv, control, store,
    ...(expander ? { planExpander: expander } : {}),
  });
  const project = service.createProject({ name: "p", root_location: workspace });
  return {
    d, workspace, store, service, control, runtime, schedules, biz, conv,
    drafts, canon, planner, projectId: String(project.project_id),
  };
}

const errCode = async (fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String((e as { code?: string })?.code ?? "ERR");
  }
};

function mkItem(s: ReturnType<typeof stack>, goal = LOCAL_GOAL) {
  const b = s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP,
  });
  const wi = s.biz.createWorkItem({
    business_id: String(b.business_id),
    title: "w", goal, operator_id: OP,
  });
  return String(wi.work_item_id);
}

/* ==================== PC1–PC3 prepareDelegatedPlan guards ==================== */

describe("PC1–PC3 — delegated planning guards fail typed + closed", () => {
  it("PC1 missing planner dependency → FAIL_CLOSED_NO_PLANNER, zero provider calls", async () => {
    const s = stack("pc1"); // no planExpander dep at all
    const wi = mkItem(s);
    expect(await errCode(() => s.biz.prepareDelegatedPlan(wi, OP)))
      .toBe("FAIL_CLOSED_NO_PLANNER");
  });

  it("PC2 expander returns without llm_plan → FAIL_CLOSED_DELEGATED_PLAN_ABSENT", async () => {
    const s = stack("pc2", {
      planExpander: (async (input: Record<string, unknown>) => ({
        input,
      })) as DelegatedPlanExpander,
    });
    const wi = mkItem(s);
    expect(await errCode(() => s.biz.prepareDelegatedPlan(wi, OP)))
      .toBe("FAIL_CLOSED_DELEGATED_PLAN_ABSENT");
  });

  it("PC2b empty llm_plan is absent — never fake authority", async () => {
    const s = stack("pc2b", {
      planExpander: (async (input: Record<string, unknown>) => ({
        input: {
          ...input,
          metadata: { llm_plan: [] },
        },
      })) as DelegatedPlanExpander,
    });
    const wi = mkItem(s);
    expect(await errCode(() => s.biz.prepareDelegatedPlan(wi, OP)))
      .toBe("FAIL_CLOSED_DELEGATED_PLAN_ABSENT");
  });

  it("PC3 missing operator → FAIL_CLOSED_OPERATOR_ID_REQUIRED", async () => {
    const s = stack("pc3", { planExpander: "canon" });
    const wi = mkItem(s);
    expect(await errCode(() => s.biz.prepareDelegatedPlan(wi, "")))
      .toBe("FAIL_CLOSED_OPERATOR_ID_REQUIRED");
  });
});

/* ==================== PC4–PC6 delegated open + plan authority ==================== */

describe("PC4–PC6 — delegated open carries persisted plan authority", () => {
  it("PC4 prepare → open mints the bound mission with llm_plan + digest + planner provenance", async () => {
    const s = stack("pc4", { planExpander: "canon" });
    const wi = mkItem(s);
    const prepared = await s.biz.prepareDelegatedPlan(wi, OP);
    expect(prepared.tasks).toHaveLength(2);
    expect(prepared.goal_digest).toBeTruthy();
    expect(prepared.planner_run_id).toBeTruthy();
    // durable run evidence exists for the planning invocation
    const run = s.store.get("planner_run", String(prepared.planner_run_id)) as Record<string, unknown>;
    expect(String(run.state)).toBe("WINNER_SELECTED");
    const row = s.biz.openWorkItem(wi, OP, undefined, { prepared_plan: prepared });
    expect(String(row.status)).toBe("IN_PROGRESS");
    const mid = String((row.mission_ids as string[])[0]);
    const mission = s.store.get("mission", mid) as Record<string, unknown>;
    const md = mission.metadata as Record<string, unknown>;
    expect(canonicalJson(md.llm_plan)).toBe(canonicalJson(prepared.tasks));
    expect(String(md.delegated_goal_digest)).toBe(prepared.goal_digest);
    expect(String(md.planner_run_id)).toBe(String(prepared.planner_run_id));
    expect(String(md.plan_source)).toBe("LLM");
    const binding = s.store.list("work_open_binding")
      .find((b) => String(b.mission_id) === mid) as Record<string, unknown>;
    expect(String(binding.state)).toBe("BOUND");
    // The persisted plan replays through the planner tail — never a
    // fresh template, never a re-invocation of the pool.
    const replay = s.planner({
      mission: { goal: String(mission.goal), metadata: md },
      advice: null, reason: "initial", input_artifact_sources: [],
    } as never) as { tasks: Array<Record<string, unknown>> };
    expect(canonicalJson(replay.tasks)).toBe(canonicalJson(prepared.tasks));
  });

  it("PC5 prepared plan authorized for a different goal → FAIL_CLOSED_DELEGATED_PLAN_GOAL_DRIFT before any write", async () => {
    const s = stack("pc5", { planExpander: "canon" });
    const wiA = mkItem(s, "first delegated goal");
    const wiB = mkItem(s, "second delegated goal — different");
    const preparedForA = await s.biz.prepareDelegatedPlan(wiA, OP);
    expect(await errCode(() =>
      s.biz.openWorkItem(wiB, OP, undefined, { prepared_plan: preparedForA }),
    )).toBe("FAIL_CLOSED_DELEGATED_PLAN_GOAL_DRIFT");
    // Zero missions minted; B never claimed an open intent or binding.
    expect(s.store.list("mission")).toHaveLength(0);
    expect(s.store.list("work_open_binding")
      .filter((b) => String(b.work_item_id) === wiB)).toHaveLength(0);
    const b = s.store.get("work_item", wiB) as Record<string, unknown>;
    expect(b.pending_open_id ?? null).toBeNull();
  });

  it("PC6 legacy plan-less mission → mints then terminalizes FAILED with FAIL_CLOSED_PLAN_REQUIRED", async () => {
    const s = stack("pc6");
    // A mission minted WITHOUT persisted plan authority (the legacy
    // plan-less shape) can still be created — but the deterministic
    // template tail is gone, so its FIRST planning tick terminalizes
    // FAILED with typed evidence. Never a synthesized T1-only plan.
    const mission = s.control.startMission({
      project_id: s.projectId,
      goal: LOCAL_GOAL,
      metadata: { source: "legacy" },
      operator_id: OP,
    });
    const mid = String(mission.mission_id);
    s.runtime.tick(mid); // CREATED → PLANNING
    expect(await errCode(() => s.runtime.tick(mid)))
      .toBe("FAIL_CLOSED_PLAN_REQUIRED");
    const m = s.store.get("mission", mid) as Record<string, unknown>;
    expect(String(m.status)).toBe("FAILED");
    const rt = s.store.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;
    expect(String((rt.planning_failure as Record<string, unknown>).code))
      .toBe("FAIL_CLOSED_PLAN_REQUIRED");
    const evs = s.store.listEvents("mission_runtime")
      .filter((e) => e.event_type === "MISSION_PLANNING_FAILED" &&
        String((e.metadata as Record<string, unknown>)?.code) === "FAIL_CLOSED_PLAN_REQUIRED");
    expect(evs).toHaveLength(1);
  });
});

/* ==================== PC7–PC8 scheduler ingress ==================== */

describe("PC7–PC8 — scheduler missions plan through the same expander", () => {
  it("PC7 no expander → each due schedule fails closed FAIL_CLOSED_NO_PLANNER, zero fired", async () => {
    const s = stack("pc7");
    s.schedules.create({
      goal: "expand me", cron: "* * * * *",
      project_id: s.projectId, operator_id: OP,
    });
    const res = await s.control.tickSchedules("2099-01-01T00:00:00.000Z");
    expect(res.fired).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
    const schedRow = s.store.list("mission_schedule")[0] as Record<string, unknown>;
    expect(String(schedRow.last_error)).toContain("FAIL_CLOSED_NO_PLANNER");
    expect(s.store.list("mission")).toHaveLength(0);
  });

  it("PC8 expander → due schedule fires through preview+confirm carrying the canonical plan", async () => {
    const s = stack("pc8");
    s.schedules.create({
      goal: LOCAL_GOAL, cron: "* * * * *",
      project_id: s.projectId, operator_id: OP,
    });
    const res = await s.control.tickSchedules(
      "2099-01-01T00:00:00.000Z", canonExpander(s));
    expect(res.fired).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
    const mission = s.store.list("mission").at(-1) as Record<string, unknown>;
    const md = mission.metadata as Record<string, unknown>;
    // the schedule minted mission carries pinned preview plan authority
    const pinned = md.pinned_plan_tasks ?? md.llm_plan;
    expect(Array.isArray(pinned)).toBe(true);
    expect((pinned as unknown[]).length).toBeGreaterThan(0);
    // replay through the tail — pinned/llm plan authority, never a template
    const replay = s.planner({
      mission: { goal: String(mission.goal), metadata: md },
      advice: null, reason: "initial", input_artifact_sources: [],
    } as never) as { tasks: Array<Record<string, unknown>> };
    expect(replay.tasks.length).toBeGreaterThan(0);
  });
});

/* ==================== PC9 conversation draft confirm ==================== */

describe("PC9 — draft confirm through the shared planner seam", () => {
  it("missing planner dep → FAIL_CLOSED_NO_PLANNER, draft stays SUBMITTING, zero missions; retry once planning exists succeeds", async () => {
    const s = stack("pc9"); // no expander
    const sid = String(s.conv.createSession({ owner_operator_id: OP, title: "t" }).session_id);
    const draft = s.drafts.createDraft({
      session_id: sid, operator_id: OP, project_id: s.projectId, goal: LOCAL_GOAL,
    });
    expect(await errCode(() => s.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: String(draft.draft_id), expected_digest: String(draft.draft_digest),
    }))).toBe("FAIL_CLOSED_NO_PLANNER");
    expect(s.store.list("mission")).toHaveLength(0);
    // SUBMITTING — the claim is durable, retry joins its replay path
    const after = s.store.get("conversation_mission_draft", String(draft.draft_id)) as Record<string, unknown>;
    expect(String(after.state)).toBe("SUBMITTING");
    // Retry on the SAME store with a live planner dep: the durable
    // claim resumes — no duplicate draft, exactly one mission.
    const drafts2 = new MissionDraftService({
      conversation: s.conv, control: s.control, store: s.store,
      planExpander: canonExpander(s),
    });
    const r = await drafts2.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: String(draft.draft_id), expected_digest: String(draft.draft_digest),
    });
    expect(r.mission_id).toBeTruthy();
    expect(s.store.list("mission")).toHaveLength(1);
    const md = (s.store.get("mission", r.mission_id) as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    expect(md.pinned_plan_tasks ?? md.llm_plan).toBeTruthy();
    // idempotent receipt — re-confirm returns the same mission, never a second
    const again = await drafts2.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: String(draft.draft_id), expected_digest: String(draft.draft_digest),
    });
    expect(String(again.mission_id)).toBe(String(r.mission_id));
    expect(s.store.list("mission")).toHaveLength(1);
  });
});

/* ==================== PC10–PC11 run-level planner deadline ==================== */

const CANDIDATE: PlannerCandidate = {
  model_entry_id: "ME_1", ref: "test:m1", provider: "test",
  model: "m1", endpoint: "http://none", credentialEnv: "PAIR_TEST_KEY",
};

describe("PC10–PC11 — ONE run-level planner deadline", () => {
  it("PC10 expired deadline denies every candidate — FAIL_CLOSED_PLANNER_DEADLINE, zero attempts, zero calls", async () => {
    let calls = 0;
    const attempts: unknown[] = [];
    const code = await errCode(() => runPlannerFailover({
      candidates: [CANDIDATE, { ...CANDIDATE, ref: "test:m2", model_entry_id: "ME_2" }],
      assertEligible: () => undefined,
      planFn: async () => { calls++; return { tasks: [], warnings: [] }; },
      deadlineMs: Date.now() - 1,
      onAttemptStart: (b) => { attempts.push(b); return b; },
    }));
    expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
    expect(calls).toBe(0);
    expect(attempts).toHaveLength(0);
  });

  it("PC11 a result landing past the deadline is discarded — never a winner, attempt settles TIMEOUT evidence", async () => {
    const s = stack("pc11");
    const run = beginPlannerRun(s.store, { routes: [CANDIDATE.ref], actor: "TEST" });
    const ended: Array<Record<string, unknown>> = [];
    const code = await errCode(() => runPlannerFailover({
      candidates: [CANDIDATE],
      assertEligible: () => undefined,
      planFn: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { tasks: RAW_WORK(), warnings: [] };
      },
      deadlineMs: Date.now() + 10,
      onAttemptStart: (b) => b,
      onAttemptEnd: (_t, rec) => { ended.push(rec as unknown as Record<string, unknown>); },
      onExhausted: () => finishPlannerRun(s.store, {
        planner_run_id: String(run.planner_run_id), outcome: "EXHAUSTED", actor: "TEST",
      }),
    }));
    expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
    expect(ended).toHaveLength(1);
    expect(String(ended[0].outcome)).toBe("FAILED");
    expect(String(ended[0].failure_class)).toBe("TIMEOUT");
    expect((ended[0].warnings as string[])).toContain("RUN_DEADLINE_EXCEEDED");
    finishPlannerRun(s.store, {
      planner_run_id: String(run.planner_run_id), outcome: "FAILED", actor: "TEST",
    });
    const runRow = s.store.get("planner_run", String(run.planner_run_id)) as Record<string, unknown>;
    expect(String(runRow.state)).toBe("FAILED");
  });
});

/* ==================== PC12–PC13 planner cost governance ==================== */

describe("PC12–PC13 — planner invocation cost governance", () => {
  function seedObjectiveLineage(s: ReturnType<typeof stack>, cap: number | null) {
    const wi = mkItem(s);
    const oid = `OBJ_${counter}`;
    // allocation row binds the work item to the objective (the same
    // lineage objectiveScopeForWorkItemId walks)
    s.store.put("workforce_allocation", `WAL_${counter}`, {
      allocation_id: `WAL_${counter}`,
      objective_id: oid,
      workstream_work_item_id: wi,
      delegated_child_work_item_id: wi,
      state: "COMMITTED",
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    } as never, 0);
    s.store.put("objective_auto_policy", `oap:${oid}`, {
      policy_id: `oap:${oid}`, objective_id: oid,
      limits: cap == null ? {} : { budget_microusd_cap: cap },
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    } as never, 0);
    return { wi, oid };
  }

  it("PC12 atomic admission — no lineage → NONE; over cap → BUDGET_EXCEEDED; under cap → HELD; idempotent replay; settle", async () => {
    const s = stack("pc12");
    const cost = s.service.cost;
    // no work_item → scope NONE, no reservation
    const none = cost.admitPlannerInvocation({ planner_run_id: "PRN_A", est_microusd: 100 });
    expect(none.scope).toBe("NONE");
    expect(none.reservation_id).toBeNull();
    // objective cap present, est > cap → typed fail closed
    const { wi, oid } = seedObjectiveLineage(s, 1_000);
    expect(await errCode(() => cost.admitPlannerInvocation({
      planner_run_id: "PRN_B", work_item_id: wi, est_microusd: 2_000,
    }))).toBe("FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED");
    // est ≤ cap → one HELD planner reservation attributed to the objective
    const admitted = cost.admitPlannerInvocation({
      planner_run_id: "PRN_C", work_item_id: wi, est_microusd: 500,
    });
    expect(admitted.scope).toBe("CAPPED");
    expect(admitted.objective_id).toBe(oid);
    const resId = String(admitted.reservation_id);
    const r = s.store.get("cost_reservation", resId) as Record<string, unknown>;
    expect(String(r.status)).toBe("HELD");
    expect(String(r.planner_run_id)).toBe("PRN_C");
    expect(String(r.attribution)).toBe("planner");
    expect(Number(r.reserved_microusd)).toBe(500);
    // replay → same row, no second reservation
    const again = cost.admitPlannerInvocation({
      planner_run_id: "PRN_C", work_item_id: wi, est_microusd: 500,
    });
    expect(String(again.reservation_id)).toBe(resId);
    expect(s.store.list("cost_reservation")).toHaveLength(1);
    // zero calls provable → RELEASED; no spend attributed
    cost.settlePlannerInvocation(resId, "NO_CALLS");
    expect(String((s.store.get("cost_reservation", resId) as Record<string, unknown>).status))
      .toBe("RELEASED");
    // a second run under the same cap now admits the full headroom again
    const second = cost.admitPlannerInvocation({
      planner_run_id: "PRN_D", work_item_id: wi, est_microusd: 900,
    });
    expect(second.scope).toBe("CAPPED");
    // calls made, usage unknown → COMMITTED at reserved max (never under-count)
    cost.settlePlannerInvocation(String(second.reservation_id), "CALLS_MADE");
    const d = s.store.get("cost_reservation", String(second.reservation_id)) as Record<string, unknown>;
    expect(String(d.status)).toBe("COMMITTED");
    expect(String(d.usage_state)).toBe("ACTUAL_USAGE_UNKNOWN");
    // concurrent planner spend now counts against the SAME objective cap
    expect(await errCode(() => cost.admitPlannerInvocation({
      planner_run_id: "PRN_E", work_item_id: wi, est_microusd: 200,
    }))).toBe("FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED");
  });

  it("PC13 reconcile sweeps HELD planner reservations from canonical run evidence — attempts → COMMITTED, zero → RELEASED, RUNNING → untouched", async () => {
    const s = stack("pc13");
    const cost = s.service.cost;
    const { wi } = seedObjectiveLineage(s, 10_000);
    const mkRun = (id: string, state: string, attempts: number) => {
      s.store.put("planner_run", id, {
        planner_run_id: id, state, project_id: s.projectId,
        operator_id: OP, routes: [], attempts,
        winner_attempt_no: null, preview_id: null, error_code: null,
        started_at: utcnow(), completed_at: utcnow(), created_at: utcnow(),
      } as never, 0);
    };
    const a = cost.admitPlannerInvocation({ planner_run_id: "PRN_R1", work_item_id: wi, est_microusd: 10 });
    const b = cost.admitPlannerInvocation({ planner_run_id: "PRN_R2", work_item_id: wi, est_microusd: 10 });
    const c = cost.admitPlannerInvocation({ planner_run_id: "PRN_R3", work_item_id: wi, est_microusd: 10 });
    mkRun("PRN_R1", "EXHAUSTED", 2);   // terminal, attempts prove calls
    mkRun("PRN_R2", "FAILED", 0);     // terminal, zero attempts = no spend
    mkRun("PRN_R3", "RUNNING", 0);    // still in flight — never guessed
    const touched = cost.reconcilePlannerInvocations();
    expect(touched).toBe(2);
    expect(String((s.store.get("cost_reservation", String(a.reservation_id)) as Record<string, unknown>).status)).toBe("COMMITTED");
    expect(String((s.store.get("cost_reservation", String(b.reservation_id)) as Record<string, unknown>).status)).toBe("RELEASED");
    expect(String((s.store.get("cost_reservation", String(c.reservation_id)) as Record<string, unknown>).status)).toBe("HELD");
  });
});

/* ==================== planner tail — template removal contract ==================== */

describe("planner tail — persisted-plan authority only", () => {
  it("initial with no persisted plan → FAIL_CLOSED_PLAN_REQUIRED; replan without provider → FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE", async () => {
    const s = stack("tail");
    const input = (reason: string, md: Record<string, unknown> = {}) => ({
      mission: { goal: LOCAL_GOAL, metadata: md },
      advice: null, reason, input_artifact_sources: [],
    }) as never;
    expect(await errCode(() => s.planner(input("initial"))))
      .toBe("FAIL_CLOSED_PLAN_REQUIRED");
    expect(await errCode(() => s.planner(input("replan"))))
      .toBe("FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE");
    // persisted llm_plan replays — the canonical plan returns
    // byte-identical (persisted provenance never re-plans)
    const canonical = s.canon(RAW_WORK(), LOCAL_GOAL, { provenance: "fresh" });
    const replay = s.planner(input("initial", { llm_plan: canonical })) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(canonicalJson(replay.tasks)).toBe(canonicalJson(canonical));
    // pinned_plan_tasks (confirmed preview) replays identically
    const pinned = s.planner(input("initial", { pinned_plan_tasks: canonical })) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(canonicalJson(pinned.tasks)).toBe(canonicalJson(canonical));
  });
});
