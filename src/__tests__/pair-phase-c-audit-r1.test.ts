/**
 * PHASE C — INDEPENDENT AUDIT R1 REGRESSIONS (PR #112 findings).
 *
 * Every test pins the contract one audit finding broke. BASE for the
 * fix branch is staging/pr59-safe @ 69d1c9b; the pre-fix code fails
 * each of these, the fixed code passes.
 *
 *   F1 — win32 TOLERATED_FAILURES entries are platform-scoped: on a
 *        non-Windows host the broad baselines are INERT and can never
 *        mask a real Linux failure (the dev-verification self-tests
 *        prove the runtime contract end-to-end on Linux).
 *   F2 — prepareDelegatedPlan runs the IDENTICAL open-eligibility
 *        gate sequence openWorkItem enforces BEFORE any paid planner
 *        invocation; a race loser that materializes a bound in-flight
 *        mission mid-prepare converges AWAITING_EXECUTION through the
 *        canonical proof from EITHER the preflight throw or the open
 *        dedup.
 *   F3 — llmPlan's internal retry loop can never START a provider
 *        request at/after the run deadline (invocation.deadlineMs).
 *   F4 — planner cost settlement keys on transport-reported
 *        provider_requests — requests that PROVABLY initiated — never
 *        the STARTED attempt-row count.
 *   F5 — the objective auto-driver pins delegated planning to the
 *        lease's canonical lifetime bound (started_at + max_lifetime −
 *        finalization): paid planning can never outlive the authority
 *        that invoked it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TOLERATED_FAILURES } from "../../scripts/dev-verification/lib.mjs";
import {
  ApprovalQueue,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  createDefaultObjectiveOperatingService,
  ensureCodexCliCatalog,
  ExecutorRegistry,
  GovernedTaskGate,
  LEASE_STATE,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  ObjectiveAuthorityService,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  runPlannerFailover,
  utcnow,
  beginPlannerRun,
  finishPlannerRun,
  persistPlannerAttemptStart,
  readSchedulerRow,
  settlePlannerAttempt,
  WorkforceAllocationService,
  WorkforceService,
  type DelegatedPlanExpander,
  type PlannerAttemptRecord,
  type PlannerCandidate,
} from "../pair/index.js";
import { llmPlan } from "../pair/llm-planner.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phasec-r1-"));
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";

const errCode = async (fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String((e as { code?: string })?.code ?? "ERR");
  }
};

/* ============================== F1 ============================== */

describe("F1 — platform-scoped tolerated failures can never mask foreign failures", () => {
  const NODE_PLATFORMS = new Set([
    "aix", "android", "cygwin", "darwin", "freebsd", "haiku",
    "linux", "netbsd", "openbsd", "sunos", "win32",
  ]);
  const isCatchAll = (p: RegExp) => p.source === ".+" || p.source === ".*";

  it("every tagged entry names a real platform; every win32-noted entry is win32-scoped", () => {
    for (const t of TOLERATED_FAILURES) {
      if (t.platform != null) {
        expect(NODE_PLATFORMS.has(t.platform)).toBe(true);
      }
      if (String(t.note).includes("win32")) {
        expect(t.platform).toBe("win32");
      }
    }
    // The win32 baseline block actually exists and is scoped.
    const win32 = TOLERATED_FAILURES.filter((t) => t.platform === "win32");
    expect(win32.length).toBeGreaterThan(0);
  });

  it("no catch-all tolerance is platform-unscoped — an unscoped /.+/ can mask ANY platform's real regression", () => {
    const unscopedCatchAlls = TOLERATED_FAILURES.filter(
      (t) => isCatchAll(t.pattern) && t.platform == null);
    expect(unscopedCatchAlls).toEqual([]);
  });

  it("a non-Windows filter drops every win32 baseline — the audit's masking scenario", () => {
    // The exact production predicate (run.mjs budget filter).
    const forPlatform = (platform: string) =>
      TOLERATED_FAILURES.filter(
        (t) => t.platform == null || t.platform === platform);
    const linux = forPlatform("linux");
    expect(linux.filter((t) => t.platform === "win32")).toHaveLength(0);
    // Linux effective set = ONLY the narrow pre-existing entries —
    // none of which may be a catch-all that swallows unrelated tests.
    expect(linux.filter((t) => isCatchAll(t.pattern))).toEqual([]);
    expect(forPlatform("win32").length).toBe(TOLERATED_FAILURES.length);
  });

  it("replicated matchTol: a Linux dev-verification self-test failure is NOT tolerated (regression-proof)", () => {
    // Before the fix, the untagged
    //   { file: dev-verification.test.ts, pattern: /.+/, max: 20 }
    // entry absorbed fixture failures INSIDE the harness's own
    // self-tests on Linux and flipped their expected verdicts — this
    // is precisely the failure the independent audit observed.
    const file = "src/__tests__/dev-verification.test.ts";
    const name = "R2-11 — an unrelated real regression escapes tolerances";
    const effective = (platform: string) =>
      TOLERATED_FAILURES
        .filter((t) => t.platform == null || t.platform === platform)
        .map((t) => ({ t, left: t.max ?? 1 }));
    const match = (platform: string) =>
      effective(platform).find(
        (b) => b.left > 0 &&
          (b.t.file === file || file.endsWith(`/${b.t.file}`)) &&
          b.t.pattern.test(name));
    expect(match("linux")).toBeUndefined();
    expect(match("darwin")).toBeUndefined();
    // …while remaining a registered baseline on Windows itself.
    expect(match("win32")).toBeTruthy();
  });
});

/* ============================== F2 ============================== */

type BizStack = ReturnType<typeof bizStack>;
function bizStack(name: string, expander?: DelegatedPlanExpander | null) {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: [] as Array<Record<string, unknown>> });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map() as never, scheduler,
    approvals, reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    schedules: new MissionScheduleService(service), planner: planner as never,
  });
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({
    store, control, schedules,
    ...(expander ? { planExpander: expander } : {}),
  });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { d, workspace, store, service, control, biz, schedules,
    projectId: String(project.project_id) };
}

/** A counting expander whose result satisfies prepareDelegatedPlan's
 *  llm_plan contract — every invocation is one pretend provider call. */
function countingExpander(calls: { n: number; ctxs: Array<Record<string, unknown>> }) {
  return (async (input: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    calls.n += 1;
    calls.ctxs.push(ctx ?? {});
    return {
      input: {
        ...input,
        metadata: {
          ...(input.metadata as Record<string, unknown> | undefined),
          llm_plan: [{
            task_key: "T2", title: "delegated", task_instruction: "work",
            required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
          }],
          plan_source: "LLM", plan_model: "test-planner",
        },
      },
      planner: { planner_run_id: `PRN_${calls.n}`, attempts: [], winner: { attempt_no: 1 } },
    };
  }) as DelegatedPlanExpander;
}

function mkItem(s: BizStack, goal = "local delegated work") {
  const b = s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP,
  });
  const wi = s.biz.createWorkItem({
    business_id: String(b.business_id),
    title: "w", goal, operator_id: OP,
  });
  return String(wi.work_item_id);
}

describe("F2 — paid planning never precedes full open eligibility", () => {
  it("a non-executable namespace item fails BEFORE the expander — zero provider calls", async () => {
    const calls = { n: 0, ctxs: [] as Array<Record<string, unknown>> };
    const s = bizStack("f2a", countingExpander(calls));
    expect(await errCode(() =>
      s.biz.prepareDelegatedPlan("OWI_root_x", OP),
    )).toBe("FAIL_CLOSED_OBJECTIVE_ROOT_NON_EXECUTABLE");
    expect(calls.n).toBe(0);
  });

  it("an item with a live bound mission throws the SAME typed error openWorkItem raises — zero new provider calls", async () => {
    const calls = { n: 0, ctxs: [] as Array<Record<string, unknown>> };
    const s = bizStack("f2b", countingExpander(calls));
    const wi = mkItem(s);
    const prepared = await s.biz.prepareDelegatedPlan(wi, OP);
    expect(calls.n).toBe(1); // the first open's legitimate plan
    s.biz.openWorkItem(wi, OP, undefined, { prepared_plan: prepared });
    // The item now carries a live bound mission. Before the fix the
    // second prepare invoked the planner FIRST and only failed inside
    // the open dedup — a paid provider call with no possible commit.
    expect(await errCode(() =>
      s.biz.openWorkItem(wi, OP),
    )).toBe("FAIL_CLOSED_MISSION_ACTIVE");
    expect(await errCode(() =>
      s.biz.prepareDelegatedPlan(wi, OP),
    )).toBe("FAIL_CLOSED_MISSION_ACTIVE");
    expect(calls.n).toBe(1);
  });

  it("a terminal item fails the transition gate pre-planner — identical code to the open seam", async () => {
    const calls = { n: 0, ctxs: [] as Array<Record<string, unknown>> };
    const s = bizStack("f2c", countingExpander(calls));
    const wi = mkItem(s);
    const row = s.store.get("work_item", wi) as Record<string, unknown> & { version: number };
    s.store.put("work_item", wi, { ...row, status: "CANCELLED" }, Number(row.version));
    const direct = await errCode(() => s.biz.openWorkItem(wi, OP));
    expect(direct).toBe("FAIL_CLOSED_WORK_ITEM_TRANSITION");
    expect(await errCode(() =>
      s.biz.prepareDelegatedPlan(wi, OP),
    )).toBe(direct);
    expect(calls.n).toBe(0);
  });
});

/* ============================== F3 ============================== */

describe("F3 — the transport-internal retry loop honors the run deadline", () => {
  const baseCfg = () => ({
    endpoint: "http://planner.invalid/chat/completions",
    credentialEnv: "PAIR_R1_TEST_KEY",
    model: "m1",
    allowedCapabilities: ["REASONING"],
    env: { PAIR_R1_TEST_KEY: "k" } as NodeJS.ProcessEnv,
    timeoutMs: 60_000,
  });
  const http500 = { ok: false, status: 500 } as unknown as Response;

  it("a retry may never START at/after the deadline — one request, typed warning, no second call", async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    try {
      const res = await llmPlan("local goal", {
        ...baseCfg(),
        deadlineMs: now + 5_000,
        fetchFn: (async () => { calls += 1; now += 10_000; return http500; }) as typeof fetch,
      });
      expect(calls).toBe(1); // first attempt ran; the retry was gated
      expect(res.tasks).toHaveLength(0);
      expect(res.warnings).toContain("LLM_PLANNER_RUN_DEADLINE_EXCEEDED");
    } finally {
      spy.mockRestore();
    }
  });

  it("a lapsed deadline at loop start = zero provider requests", async () => {
    let calls = 0;
    const res = await llmPlan("local goal", {
      ...baseCfg(),
      deadlineMs: Date.now() - 1,
      fetchFn: (async () => { calls += 1; return http500; }) as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(res.warnings).toContain("LLM_PLANNER_RUN_DEADLINE_EXCEEDED");
  });

  it("no deadline configured → the legacy ≤2-request retry contract is unchanged", async () => {
    let calls = 0;
    const res = await llmPlan("local goal", {
      ...baseCfg(),
      fetchFn: (async () => { calls += 1; return http500; }) as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(res.tasks).toHaveLength(0);
  });
});

/* ============================== F4 ============================== */

const ATTEMPT_BASE: Omit<PlannerAttemptRecord, "outcome"> = {
  route: "test:m1", provider: "test", model_entry_id: "ME_T",
  model: "m1", role: "PLANNER_COORDINATOR", attempt_no: 1,
  started_at: "", completed_at: "", latency_ms: 0, warnings: [],
};

function costStack(name: string) {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  return { d, store, service };
}

function heldPlannerReservation(store: PairEvidenceStore, runId: string) {
  const resId = `CRSV_PLN_${runId}`;
  store.put("cost_reservation", resId, {
    reservation_id: resId, planner_run_id: runId,
    status: "HELD", reserved_microusd: 1_000,
    billing_mode: "METERED_API", created_at: utcnow(),
  }, 0);
  return resId;
}

describe("F4 — cost settlement keys on proven provider invocations, never attempt-row count", () => {
  it("the pool stamps transport-reported provider_requests on every settled attempt", async () => {
    const ended: PlannerAttemptRecord[] = [];
    const CAND: PlannerCandidate = {
      model_entry_id: "ME_1", ref: "test:m1", provider: "test",
      model: "m1", endpoint: "http://none", credentialEnv: "K",
    };
    // Eligibility-rejected WITHOUT any provider contact → proven zero.
    await expect(runPlannerFailover({
      candidates: [CAND],
      assertEligible: () => ({ reject: true as const, failure_class: "MODEL_UNAVAILABLE" as never, reason: "down" }),
      planFn: async () => { throw new Error("must not run"); },
      onAttemptEnd: (_t, rec) => { ended.push(rec); },
    })).rejects.toThrow();
    expect(ended[0]!.provider_requests).toBe(0);
    // Eligibility probe (codex refresh shape) bumped the counter even
    // though planFn never ran → honestly counted as spend-possible.
    ended.length = 0;
    await expect(runPlannerFailover({
      candidates: [CAND],
      assertEligible: (_c, counter) => {
        if (counter) counter.requests += 1;
        return { reject: true as const, failure_class: "MODEL_UNAVAILABLE" as never, reason: "down" };
      },
      planFn: async () => { throw new Error("must not run"); },
      onAttemptEnd: (_t, rec) => { ended.push(rec); },
    })).rejects.toThrow();
    expect(ended[0]!.provider_requests).toBe(1);
  });

  it("settlePlannerAttempt persists provider_requests and aggregates it on the run row — attempts=1, requests=0", () => {
    const s = costStack("f4a");
    const run = beginPlannerRun(s.store, { routes: ["t"], actor: "T" });
    const runId = String(run.planner_run_id);
    expect(Number(run.provider_requests)).toBe(0);
    const paid = persistPlannerAttemptStart(s.store, {
      planner_run_id: runId, record: ATTEMPT_BASE, actor: "T",
    }).planner_attempt_id;
    settlePlannerAttempt(s.store, {
      planner_attempt_id: String(paid),
      record: { ...ATTEMPT_BASE, outcome: "FAILED", provider_requests: 0,
        completed_at: utcnow() },
      actor: "T",
    });
    const attempt = s.store.get("planner_attempt", String(paid)) as Record<string, unknown>;
    expect(Number(attempt.provider_requests)).toBe(0);
    const runRow = s.store.get("planner_run", runId) as Record<string, unknown>;
    // THE discriminator: one persisted STARTED attempt, PROVEN zero
    // provider requests. Pre-fix the reservation settled from attempts>0.
    expect(Number(runRow.attempts)).toBe(1);
    expect(Number(runRow.provider_requests)).toBe(0);
  });

  it("reconcilePlannerInvocations: terminal run + zero proven requests → RELEASED (pre-fix: COMMITTED via attempts>0)", () => {
    const s = costStack("f4b");
    const run = beginPlannerRun(s.store, { routes: ["t"], actor: "T" });
    const runId = String(run.planner_run_id);
    const paid = persistPlannerAttemptStart(s.store, {
      planner_run_id: runId, record: ATTEMPT_BASE, actor: "T",
    }).planner_attempt_id;
    settlePlannerAttempt(s.store, {
      planner_attempt_id: String(paid),
      record: { ...ATTEMPT_BASE, outcome: "FAILED", provider_requests: 0,
        completed_at: utcnow() },
      actor: "T",
    });
    finishPlannerRun(s.store, { planner_run_id: runId, outcome: "EXHAUSTED", actor: "T" });
    const resId = heldPlannerReservation(s.store, runId);
    s.service.cost.reconcilePlannerInvocations();
    const res = s.store.get("cost_reservation", resId) as Record<string, unknown>;
    expect(String(res.status)).toBe("RELEASED");
  });

  it("reconcilePlannerInvocations: terminal run + proven requests → COMMITTED at reserved", () => {
    const s = costStack("f4c");
    const run = beginPlannerRun(s.store, { routes: ["t"], actor: "T" });
    const runId = String(run.planner_run_id);
    const paid = persistPlannerAttemptStart(s.store, {
      planner_run_id: runId, record: ATTEMPT_BASE, actor: "T",
    }).planner_attempt_id;
    settlePlannerAttempt(s.store, {
      planner_attempt_id: String(paid),
      record: { ...ATTEMPT_BASE, outcome: "FAILED", provider_requests: 2,
        completed_at: utcnow() },
      actor: "T",
    });
    finishPlannerRun(s.store, { planner_run_id: runId, outcome: "EXHAUSTED", actor: "T" });
    const resId = heldPlannerReservation(s.store, runId);
    s.service.cost.reconcilePlannerInvocations();
    const res = s.store.get("cost_reservation", resId) as Record<string, unknown>;
    expect(String(res.status)).toBe("COMMITTED");
  });
});

/* ============================== F5 ============================== */

describe("F5 — the driver pins delegated planning to its lease lifetime", () => {
  type SchedStack = {
    store: PairEvidenceStore;
    objectives: ObjectiveAuthorityService;
    policy: ObjectiveAutoPolicyService;
    scheduler: ObjectiveAutoScheduler;
    wakeup: ObjectiveAutoWakeupService;
    now: () => number;
  };
  function schedStack(name: string, initial = 1_000_000): SchedStack {
    const t = { v: initial };
    const d = path.join(ROOT, `${counter++}-${name}`);
    fs.mkdirSync(d, { recursive: true });
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const objectives = new ObjectiveAuthorityService(store);
    const policy = new ObjectiveAutoPolicyService(store, objectives, () => t.v);
    const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t.v);
    const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t.v);
    return { store, objectives, policy, scheduler, wakeup, now: () => t.v };
  }
  function mkObjective(s: SchedStack) {
    const bid = `BIZ_${counter}`;
    s.store.put("business", bid, {
      business_id: bid, name: "b", status: "ACTIVE", created_at: "x",
    }, 0);
    return s.objectives.create({
      business_id: bid, title: "Grow", statement: "g",
      kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
      deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
      operator_id: OP, dedup_key: `dk-${counter}`,
    });
  }

  it("runPass receives planning_deadline_epoch_ms = lease.started_at + max_lifetime − finalization", async () => {
    const s = schedStack("f5a");
    const o = mkObjective(s);
    const oid = String(o.objective_id);
    s.policy.control({ objective_id: oid, actor: OWNER, action: "configure",
      limits: { expires_at: FUTURE, max_ceo_calls: 10 },
      idempotency_key: `cfg-${counter}` });
    s.policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: `en-${counter}` });
    s.wakeup.tick();
    let seen: number | undefined;
    const driver = new ObjectiveAutoDriverService({
      store: s.store, objectives: s.objectives, policy: s.policy,
      scheduler: s.scheduler,
      runPass: async (input) => {
        seen = input.planning_deadline_epoch_ms;
        return { outcome: "WAITING", objective_id: oid };
      },
      executors: ["CODEX"],
      billingFor: () => ({ mode: "UNMETERED", profile: null, unbounded: false }),
      costHaltActive: () => false,
      workerId: "w1", bootId: "b1",
      now: s.now,
      heartbeatMs: 0,
    });
    await driver.tick();
    const lease = readSchedulerRow<Record<string, unknown>>(
      s.store, LEASE_STATE, oid)!;
    // Canonical bound the scheduler itself enforces: started_at +
    // max_lifetime_ms; the driver reserves its 60s finalization
    // allowance so planning can never outlive the lease.
    expect(seen).toBe(
      Number(lease.started_at) + Number(lease.max_lifetime_ms) - 60_000);
  });
});

/* ---------- F2 convergence + F5 loop forwarding: full objective stack ---------- */

type FullStack = {
  store: PairEvidenceStore; service: PairControlPlane;
  biz: BusinessLayer; wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService; alloc: WorkforceAllocationService;
  projectId: string; expandCtxs: Array<Record<string, unknown>>;
};

function fullStack(name: string): FullStack {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: [] as Array<Record<string, unknown>> });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map() as never, scheduler,
    approvals, reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    schedules: new MissionScheduleService(service), planner: planner as never,
  });
  const schedules = new MissionScheduleService(service);
  const expandCtxs: Array<Record<string, unknown>> = [];
  const biz = new BusinessLayer({
    store, control, schedules,
    planExpander: (async (input: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      expandCtxs.push(ctx ?? {});
      return {
        input: {
          ...input,
          metadata: {
            ...(input.metadata as Record<string, unknown> | undefined),
            llm_plan: [{
              task_key: "T2", title: "delegated", task_instruction: "work",
              required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
            }],
            plan_source: "LLM", plan_model: "test-planner",
          },
        },
        planner: { planner_run_id: "PRN_T", attempts: [], winner: { attempt_no: 1 } },
      };
    }) as DelegatedPlanExpander,
  });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { store, service, biz, wf, workstreams, alloc,
    projectId: String(project.project_id), expandCtxs };
}

function qualifyCodexProvider(store: PairEvidenceStore) {
  const id = providerEntryId(CODEX_CLI_PROVIDER_ID);
  const existing = store.tryGet("provider", id) as Record<string, unknown> | null;
  store.put("provider", id, {
    ...(existing ?? { provider_id: CODEX_CLI_PROVIDER_ID, entry_id: id }),
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK", health_state: "READY",
    conditions: [], probe_state: "PROBED", provider_type: "LOCAL_CLI",
    protocol_family: "CODEX_CLI", endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [], credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(
    CODEX_CLI_PROVIDER_ID, { policy_version: "test-policy", actor: "test" });
}

function seedCeoModel(store: PairEvidenceStore) {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  qualifyCodexProvider(store);
  const mcat = new ModelEvidenceCatalog(store);
  mcat.recordProbeReceipt({
    probe_id: `PRB_ceo_${counter++}`, model_entry_id: meId,
    provider_id: CODEX_CLI_PROVIDER_ID, result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
  });
  const q = qualifyModel(store, meId, {
    capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error("model qualification failed");
  return meId;
}

class FakeInvoker implements CeoDecisionInvoker {
  inputs: CeoInvokeInput[] = [];
  private queue: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>;
  constructor(...raw: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>) {
    this.queue = raw;
  }
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.inputs.push(input);
    const item = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    return typeof item === "function" ? await item(input) : {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: item,
    };
  }
}

const WAIT_JSON = JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
  workstreams: null, priority_order: null,
  wait_reason: "AWAITING_PROGRESS", summary: null,
});

/** Objective + workstream binding + a READY launchable child — the
 *  canonical precondition for openDelegatedChild's planning path. */
function objectiveStack(name: string) {
  const s = fullStack(name);
  const b = s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  const bid = String(b.business_id);
  const o = s.biz.objectives.create({
    business_id: bid, title: "Grow EA orders",
    statement: "Grow EA orders on MQL5",
    kpis: [{ name: "ea_orders", unit: "orders", baseline: 2, target: 10 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000_000,
    dedup_key: `dk-${counter}`, operator_id: OP,
  });
  const oid = String(o.objective_id);
  const oc = s.biz.objectives.get(oid);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(oc.version),
    expected_terms_version: Number(oc.terms_version),
    expected_objective_digest: String(oc.objective_digest),
    workstreams: [
      { workstream_key: "w1", title: "ws w1", goal: "g w1" },
      { workstream_key: "w2", title: "ws w2", goal: "g w2",
        depends_on_keys: ["w1"] },
    ] as never,
    actor: OP,
  });
  s.biz.createOrgAgent({
    business_id: bid, title: "a", department: "ops", operator_id: OP });
  seedCeoModel(s.store);
  const inv = new FakeInvoker(WAIT_JSON);
  const ops = createDefaultObjectiveOperatingService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams, invoker: inv,
  }).service;
  return { s, oid, ops, inv };
}

describe("F2 convergence + F5 loop forwarding — the pass-level seams", () => {
  it("F2: a race loser whose bound mission materializes mid-prepare converges AWAITING_EXECUTION", async () => {
    const { s, oid, ops } = objectiveStack("f2d");
    const a = s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP });
    const childId = String(a.delegated_child_work_item_id);
    // Arm the race: the real prepare runs, then a competing actor
    // commits the bound mission and the preflight/open throws — the
    // pass must converge through the canonical in-flight proof, never
    // propagate the eligibility error as a planner fault.
    const realPrepare = s.biz.prepareDelegatedPlan.bind(s.biz);
    (s.biz as unknown as { prepareDelegatedPlan: unknown }).prepareDelegatedPlan =
      async (wiId: string, op: string, opts?: { planningDeadlineEpochMs?: number }) => {
        if (wiId === childId) {
          const prepared = await realPrepare(wiId, op, opts);
          s.biz.openWorkItem(wiId, op, undefined, { prepared_plan: prepared });
          const mid = String((s.store.get("work_item", wiId) as Record<string, unknown>)
            .mission_ids && ((s.store.get("work_item", wiId) as Record<string, unknown>)
              .mission_ids as string[])[0]);
          s.service.transitionMission(mid, "READY", `OPERATOR:${OP}`);
          s.service.transitionMission(mid, "RUNNING", `OPERATOR:${OP}`);
          throw new PolicyError("FAIL_CLOSED_WORK_ITEM_TRANSITION", "race loss");
        }
        return realPrepare(wiId, op, opts);
      };
    const r = await ops.runObjectivePass({ objective_id: oid, actor: OP });
    expect(r.outcome).toBe("AWAITING_EXECUTION");
    expect(r.delegated_child_work_item_id).toBe(childId);
    expect(s.store.list("mission")).toHaveLength(1);
  });

  it("F5: runObjectivePass forwards planning_deadline_epoch_ms as the expandCtx.deadlineMs pin", async () => {
    const { s, oid, ops } = objectiveStack("f5b");
    s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP });
    const epoch = Date.now() + 300_000;
    const r = await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      planning_deadline_epoch_ms: epoch,
    });
    expect(r.outcome).toBe("DISPATCHED");
    expect(s.expandCtxs).toHaveLength(1);
    const pin = Number(s.expandCtxs[0]!.deadlineMs);
    // epoch − Date.now() measured at the prepare seam: positive, ≤300s,
    // and never exceeding the pinned bound (tighten-only).
    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThanOrEqual(300_000);
    expect(pin).toBeLessThanOrEqual(epoch - (Date.now() - 5_000));
  });

  it("F5: a lapsed lease epoch pins a zero window → the real pool fails DEADLINE before any provider call", async () => {
    const { s, oid, ops } = objectiveStack("f5c");
    s.alloc.allocateWorkstream({
      objective_id: oid, workstream_key: "w1", actor: OP });
    await ops.runObjectivePass({
      objective_id: oid, actor: OP,
      planning_deadline_epoch_ms: Date.now() - 1,
    });
    expect(s.expandCtxs).toHaveLength(1);
    const pin = Number(s.expandCtxs[0]!.deadlineMs);
    expect(pin).toBe(0);
    // The production expander computes deadlineAt = Date.now() +
    // min(cfgDeadline, pin) = now → the pool's first gate throws
    // FAIL_CLOSED_PLANNER_DEADLINE before any candidate/provider call.
    let calls = 0;
    const CAND: PlannerCandidate = {
      model_entry_id: "ME_1", ref: "test:m1", provider: "test",
      model: "m1", endpoint: "http://none", credentialEnv: "K",
    };
    const code = await errCode(() => runPlannerFailover({
      candidates: [CAND],
      assertEligible: () => undefined,
      planFn: async () => { calls += 1; return { tasks: [], warnings: [] }; },
      deadlineMs: Date.now() + pin,
    }));
    expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
    expect(calls).toBe(0);
  });
});
