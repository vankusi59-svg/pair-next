/**
 * Governed async replan provider — durable candidate staging that
 * bridges the async Planner Pool to the synchronous RuntimePlanner
 * (src/pair/replan-generation.ts + the PENDING seam in runReplan +
 * the canonical:true staged-candidate lane in serve-planner).
 *
 *   A — durable generation identity + binding (mission, recovery,
 *       failed revision, failure-context snapshot, attempt index)
 *   B — PENDING semantics: not a failure, consumes no candidate slot,
 *       stays REPLANNING, deterministic single-flight mint
 *   C — async driver: claim/settle/reconcile, stale-result drop,
 *       cancellation, lease reclaim + restart recovery, deadline
 *   D — end-to-end governed outcomes: staged candidate re-enters the
 *       EXISTING replan gates (validate → dedup → PREPARED → atomic
 *       commit), sequential candidates carry rejection feedback,
 *       generation failures map to REPLAN-infeasible, cost admission
 *       through canonical Objective lineage
 *   E — transport parity: structured replan_context reaches the SAME
 *       canonical prompt builder for the codex-cli planner transport
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import type { RuntimePlanner, RuntimePlannerInput } from "../pair/mission-runtime.js";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import {
  ApprovalQueue,
  assertPlannerCandidateEligible,
  beginPlannerRun,
  buildCodexPlannerPrompt,
  dedupePlannerCandidates,
  ExecutorRegistry,
  finishPlannerRun,
  GovernedTaskGate,
  IntegrityError,
  makeReplanGenerationDriver,
  makeServeCanonicalizer,
  makeServePlanner,
  markPlannerAttemptReask,
  MissionControl,
  missionOperatorGoalOf,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  MODEL_ROLE,
  assignModelRole,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  persistPlannerAttemptStart,
  plannerCandidateRequestBound,
  PolicyError,
  ProviderCatalog,
  ProviderValidator,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  REPLAN_GENERATION_PENDING,
  ReplanAttemptLedger,
  ReplanGenerationService,
  replanGenerationId,
  replanWorkItemId,
  runPlannerFailover,
  settlePlannerAttempt,
  spendSemantics,
  TRANSPORT_IN_PROCESS,
  validatePlanProposal,
  type PlannerCandidate,
  type PlannerInvocation,
  type ReplanGenerationRecord,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-async-replan-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const REMOTE = "REMOTE_CLOUD_TASK_EXECUTION";
function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  script: Array<{ status: string; error_class?: string }>;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string, script: Array<{ status: string; error_class?: string }> = [], caps: string[] = ["FILE_OPERATIONS"]) {
    this.executor_id = id;
    this.script = [...script];
    this.caps = caps;
  }
  probe() { return { executor_id: this.executor_id, available: true, state: "READY" }; }
  qualify() { return { qualified: true, dispatch_enabled: true }; }
  capabilities() { return { capability_ids: this.caps }; }
  prepare_task(task: Record<string, unknown>) { return task; }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "RATE_LIMITED", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: "ok" };
    return { execution_id: eid, status: step.status, run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() { return { status: "CANCELLED" }; }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() { return []; }
  health() { return { state: "READY" }; }
}

const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("spec-bound harness must not call inference");
  },
};
const noopCompute = {
  exec: async () => {
    throw new Error("no remote compute");
  },
  writeFile: async () => {
    throw new Error("no remote compute");
  },
  readFile: async () => {
    throw new Error("no remote compute");
  },
} as unknown as ComputeClient;

const df = (produces: string[] = [], consumes: string[] = []) => ({
  pair_dataflow: { produces, consumes },
});
const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
};
const task = (
  key: string,
  caps: string[],
  deps: string[],
  instruction: string,
  metadata: Record<string, unknown> = {},
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on: deps,
  metadata: { network_requirement: NETREQ_LOCAL, ...metadata },
});
const incidentPlan = () => ({
  tasks: [
    task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"])),
    task("T2", [REMOTE], ["T1"], "read x.txt remotely", df([], ["x.txt"])),
  ],
});
const altPlan = () => ({
  tasks: [task("T1", ["FILE_OPERATIONS"], [], "write summary.txt standalone", df(["summary.txt"]))],
});
const canonPlan = (raw: Array<Record<string, unknown>>) =>
  makeServeCanonicalizer({
    executorCapSets: () => [
      ["FILE_OPERATIONS", "REASONING", REMOTE, "AUTOMATON_TASK_EXECUTION"],
    ],
  })(raw, "governed async replan test mission");

type GenerateFn = (
  gen: ReplanGenerationRecord,
) => Promise<{ tasks: Array<Record<string, unknown>>; planner_run_id?: string | null }>;

interface PlannerCall {
  reason: string;
  replan_context?: RuntimePlannerInput["replan_context"];
}

/** Full governed stack with the PRODUCTION serve-planner seam — the
 *  replanProvider is the real ReplanGenerationService.requestCandidate,
 *  so every replan call flows through the durable generation bridge the
 *  way `PAIR_ASYNC_REPLAN_PROVIDER=1` wiring does. `generate` is the
 *  injected async seam standing in for the Planner Pool invocation. */
function makeAsyncCtx(
  name: string,
  opts: {
    generate: GenerateFn;
    deadlineMs?: number;
    leaseMs?: number;
    nowMs?: () => number;
  },
) {
  const d = dir(name);
  const dbPath = path.join(d, "pair.db");
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
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
  const calls: PlannerCall[] = [];
  const gen = new ReplanGenerationService(store, {
    deadlineMs: opts.deadlineMs ?? 1_800_000,
  });
  const { planner, canonicalizeLlmTasks } = makeServePlanner({
    executorCapSets: () => [
      ["FILE_OPERATIONS", "REASONING", REMOTE, "AUTOMATON_TASK_EXECUTION"],
    ],
    replanProvider: (input) => gen.requestCandidate(input),
  });
  const wrapped: RuntimePlanner = (input) => {
    calls.push({ reason: input.reason, replan_context: input.replan_context });
    return planner(input);
  };
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner: wrapped,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service), planner: wrapped,
  });
  for (const c of ["FILE_OPERATIONS", "REASONING", REMOTE, "AUTOMATON_TASK_EXECUTION"]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: workspace });
  const registerAdapter = (adapter: ExecutorAdapter, caps: string[]) => {
    registry.register({
      executor_id: adapter.executor_id,
      executor_type: "EXTERNAL",
      capabilities: caps,
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        routing_priority: 50,
        transport_type: TRANSPORT_IN_PROCESS,
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        supports_cancel: true,
        max_concurrency: 4,
      },
    });
    const routeId = `RTE_${adapter.executor_id}`;
    service.routes.registerRoute({
      route_id: routeId,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      direct_callable: true,
      capabilities: caps,
      priority: 50,
      executor_hint: adapter.executor_id,
    });
    service.routes.registerBinding({
      executor_id: adapter.executor_id,
      route_id: routeId,
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
      capabilities: caps,
    });
    adapters.set(adapter.executor_id, adapter);
  };
  const sweep = makeReplanGenerationDriver({
    service: gen,
    generate: opts.generate,
    owner_id: `test-driver:${name}`,
    lease_ms: opts.leaseMs ?? 60_000,
    ...(opts.nowMs ? { now_ms: opts.nowMs } : {}),
  });
  const startMission = (metadata?: Record<string, unknown>) => {
    const m = control.startMission({
      project_id: String(project.project_id),
      goal: "governed async replan test mission",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
      ...(metadata ? { metadata } : {}),
    });
    return String(m.mission_id);
  };
  const rt = (mid: string) => store.get("mission_runtime", `MRT_${mid}`);
  const toReplanning = (mid: string) => {
    const clock = fakeClock();
    for (let i = 0; i < 60; i++) {
      runtime.tick(mid, clock());
      if (String(rt(mid).state) === "REPLANNING") return;
    }
    throw new Error(`never reached REPLANNING: ${String(rt(mid).state)}`);
  };
  /** The production 1s interval analogue: one tick + one driver sweep.
   *  PAIR's injected T1 bookkeeping needs real event-loop yields. */
  const driveGen = async (mid: string, max = 200) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      await sweep();
      await new Promise((r) => setTimeout(r, 15));
      const s = String(rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s)) return s;
    }
    return String(rt(mid).state);
  };
  const registerNativeExecutor = () => {
    const automatonDb = createDatabase(path.join(d, "automaton.db"));
    const runner = new PairNativeWorkerRunner({
      db: automatonDb.raw,
      config: { name: `p16-${name}`, logLevel: "error" } as unknown as AutomatonConfig,
      identity: { name: `p16-${name}` } as unknown as AutomatonIdentity,
      inference: noopInference,
      compute: noopCompute,
      journalRoot: path.join(d, "journal"),
      allowedEditRoot: d,
    });
    const adapter = new PairNativeExecutorAdapter(runner);
    registry.register({
      executor_id: adapter.executor_id,
      executor_type: "AUTOMATON_WORKER",
      capabilities: ["AUTOMATON_TASK_EXECUTION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        qualification_state: "QUALIFIED",
        max_concurrency: 4,
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        routing_priority: 100,
        supports_cancel: true,
      },
    });
    service.routes.seedPairNativeRoute();
    adapters.set(adapter.executor_id, adapter);
  };
  const generations = () =>
    (store.list("replan_generation") as unknown as ReplanGenerationRecord[])
      .sort((a, b) => a.attempt_index - b.attempt_index);
  const attempts = (mid: string) =>
    store
      .list("replan_attempt")
      .filter((a) => a.mission_id === mid)
      .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));
  const decisions = (mid: string) =>
    store.list("recovery_decision").filter((x) => x.mission_id === mid);
  return {
    d, dbPath, workspace, store, service, gate, registry, router, recovery,
    recon, approvals, scheduler, runtime, control, adapters, calls, gen,
    sweep, registerAdapter, registerNativeExecutor, startMission, rt,
    toReplanning, driveGen, generations, attempts, decisions,
    canonicalizeLlmTasks,
    projectId: String(project.project_id),
  };
}

/* ============ A — durable generation identity ======================= */

describe("async replan A — durable generation identity + binding", () => {
  const ctxWithPending = async (name: string) => {
    const seen: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx(name, {
      generate: async (gen) => {
        seen.push(gen);
        return { tasks: altPlan().tasks };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    // The first REPLANNING-state tick invokes runReplan → the provider
    // mints the durable generation row and reports PENDING.
    ctx.runtime.tick(mid, fakeClock()());
    expect(ctx.generations()).toHaveLength(1);
    return { ctx, mid, seen };
  };

  it("A1. REPLAN tick mints a deterministic generation row binding mission + recovery + failed revision + context + slot", async () => {
    const { ctx, mid, seen } = await ctxWithPending("a1");
    const rows = ctx.generations();
    expect(rows).toHaveLength(1);
    const g = rows[0];
    const mission = ctx.service.getMission(mid);
    const pending = (ctx.rt(mid) as Record<string, unknown>).pending_recovery as Record<string, unknown>;
    const recoveryId = String(pending.recovery_id);
    expect(g.contract).toBe("pair-replan-generation.v1");
    expect(g.replan_generation_id).toBe(replanGenerationId(recoveryId, 0));
    expect(g.mission_id).toBe(mid);
    expect(g.recovery_id).toBe(recoveryId);
    expect(g.attempt_index).toBe(0);
    expect(g.replan_attempt_id).toMatch(/^RPA_[0-9a-f]{24}$/);
    expect(g.superseded_plan_id).toBe(String(mission.plan_id));
    expect(g.status).toBe("PENDING");
    // failure-context snapshot — the exact replan_context minted by runReplan.
    expect(g.replan_context.recovery_id).toBe(recoveryId);
    expect(g.replan_context.failure_class).toBe("DEPENDENCY_FAILURE");
    expect(g.replan_context.failed_plan_semantic_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(g.replan_context.rejected_semantic_digests).toEqual([]);
    expect(g.context_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(g.deadline_at > g.created_at).toBe(true);
    await ctx.sweep();
    expect(seen).toHaveLength(1);
    expect(seen[0].replan_generation_id).toBe(g.replan_generation_id);
    // The structured failure context reached the async generation seam.
    expect(seen[0].replan_context.failure_class).toBe("DEPENDENCY_FAILURE");
    expect(seen[0].replan_context.failed_task_key).toBeTruthy();
  });

  it("A2. a re-request under a DIFFERENT request signature is a binding violation, never a new generation", async () => {
    const { ctx, mid } = await ctxWithPending("a2");
    const g = ctx.generations()[0];
    const input = {
      mission: {
        ...ctx.service.getMission(mid),
        operator_goal: "governed async replan test mission",
        // advance the superseded revision — a stale staged candidate
        // could never legally serve under this identity.
        plan_id: "PLN_other",
      },
      reason: "replan",
      replan_context: g.replan_context,
    } as unknown as RuntimePlannerInput;
    expect(() => ctx.gen.requestCandidate(input)).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_REPLAN_GENERATION_BINDING" }) as never,
    );
  });
});

/* ============ B — PENDING semantics ================================ */

describe("async replan B — PENDING is a wait state, never a failure", () => {
  it("B1. PENDING consumes no candidate slot and writes no ledger row; ticks are idempotent (single-flight)", async () => {
    const ctx = makeAsyncCtx("b1", {
      generate: async () => ({ tasks: altPlan().tasks }),
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    const clock = fakeClock();
    // Repeated ticks while generation is in flight: state stays
    // REPLANNING, zero replan_attempt rows, ONE durable generation row.
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid, clock());
    expect(String(ctx.rt(mid).state)).toBe("REPLANNING");
    expect(ctx.attempts(mid)).toHaveLength(0);
    expect(ctx.generations()).toHaveLength(1);
    // The recovery chain still owns exactly one decision — no
    // infeasible re-decide, no defect terminalization.
    expect(ctx.decisions(mid)).toHaveLength(1);
    const replanCalls = ctx.calls.filter((c) => c.reason === "replan");
    expect(replanCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("B2. REPLAN_GENERATION_PENDING is a distinct non-FAIL_CLOSED code the planner call throws while in flight", async () => {
    const ctx = makeAsyncCtx("b2", {
      generate: async () => ({ tasks: altPlan().tasks }),
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    // Mint the durable row on the first REPLANNING-state tick.
    ctx.runtime.tick(mid, fakeClock()());
    const g = ctx.generations()[0];
    const mission = ctx.service.getMission(mid);
    const err = (() => {
      try {
        ctx.gen.requestCandidate({
          mission: { ...mission, operator_goal: "governed async replan test mission" },
          reason: "replan",
          replan_context: g.replan_context,
        } as RuntimePlannerInput);
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(String(err?.code)).toBe(REPLAN_GENERATION_PENDING);
    expect(String(err?.code)).not.toMatch(/^FAIL_CLOSED/);
  });
});

/* ============ C — driver: claim / settle / reconcile ================ */

describe("async replan C — driver lease, stale results, cancellation, restart, deadline", () => {
  const pendingCtx = async (name: string, over: { deadlineMs?: number; leaseMs?: number } = {}) => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx(name, {
      ...over,
      generate: async (gen) => {
        gens.push(gen);
        return { tasks: altPlan().tasks, planner_run_id: `PRN_${gen.replan_generation_id}` };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    ctx.runtime.tick(mid, fakeClock()()); // mint the durable generation row
    expect(ctx.generations()).toHaveLength(1);
    return { ctx, mid, gens };
  };

  it("C1. claim is single-flight: a live lease blocks a second claim; a stale-epoch settle is dropped", async () => {
    const { ctx, mid, gens } = await pendingCtx("c1");
    const row = ctx.generations()[0];
    const claimed = ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(claimed?.replan_generation_id).toBe(row.replan_generation_id);
    expect(claimed?.lease_epoch).toBe(1);
    // A second claim while the lease is live → nothing (single-flight).
    expect(ctx.gen.claimNext({ owner_id: "w2", lease_ms: 60_000, now_ms: Date.now() })).toBeNull();
    // A settle under a stale/wrong epoch is dropped, never applied.
    expect(
      ctx.gen.settle(row.replan_generation_id, "w2", 0, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(false);
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("LEASED");
    // The owning epoch settles.
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
        planner_run_id: "PRN_direct",
      }),
    ).toBe(true);
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("STAGED");
    void gens;
  });

  it("C2. expired lease is reclaimable under a NEW epoch; the superseded owner's result is dropped", async () => {
    const t0 = Date.now();
    const { ctx } = await pendingCtx("c2");
    const row = ctx.generations()[0];
    const c1 = ctx.gen.claimNext({ owner_id: "w1", lease_ms: 100, now_ms: t0 });
    expect(c1?.lease_epoch).toBe(1);
    // Lease expired → a different owner re-claims under epoch 2.
    const c2 = ctx.gen.claimNext({ owner_id: "w2", lease_ms: 100, now_ms: t0 + 200 });
    expect(c2?.lease_epoch).toBe(2);
    expect(String(c2?.lease_owner_id)).toBe("w2");
    // Stale (w1, epoch 1) result — dropped.
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(false);
    // Current owner settles.
    expect(
      ctx.gen.settle(row.replan_generation_id, "w2", 2, {
        status: "FAILED",
        outcome: { kind: "PROVIDER_UNAVAILABLE", code: "FAIL_CLOSED_PLANNER_NO_ELIGIBLE" },
      }),
    ).toBe(true);
    expect(ctx.gen.get(row.replan_generation_id)!.outcome?.kind).toBe("PROVIDER_UNAVAILABLE");
  });

  it("C3. cancellation — a generation whose recovery chain moved on is CANCELLED; a late settle drops", async () => {
    const { ctx, mid } = await pendingCtx("c3");
    const row = ctx.generations()[0];
    const claimed = ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(claimed).toBeTruthy();
    // Mission cancelled while generation is in flight.
    ctx.runtime.cancel(mid, "OP");
    ctx.gen.reconcile({ nowMs: Date.now() });
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CANCELLED");
    // The in-flight settle lands after cancellation → dropped, never applied.
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(false);
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CANCELLED");
    expect(ctx.attempts(mid)).toHaveLength(0);
  });

  it("C4. restart — generation rows survive a store reopen; claims/settles resume on the durable record", async () => {
    const { ctx } = await pendingCtx("c4");
    const row = ctx.generations()[0];
    const claimed = ctx.gen.claimNext({ owner_id: "w1", lease_ms: 1, now_ms: Date.now() });
    expect(claimed).toBeTruthy();
    ctx.store.close();
    // Process restart: NEW store + service over the SAME db file.
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const gen2 = new ReplanGenerationService(store2, { deadlineMs: 1_800_000 });
    const persisted = gen2.get(row.replan_generation_id);
    expect(persisted?.status).toBe("LEASED");
    // Expired lease → the restarted driver re-claims under epoch 2.
    const reclaimed = gen2.claimNext({ owner_id: "w1-restart", lease_ms: 60_000, now_ms: Date.now() + 100 });
    expect(reclaimed?.replan_generation_id).toBe(row.replan_generation_id);
    expect(reclaimed?.lease_epoch).toBe(2);
    expect(
      gen2.settle(row.replan_generation_id, "w1-restart", 2, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(true);
    expect(gen2.get(row.replan_generation_id)!.status).toBe("STAGED");
    store2.close();
  });

  it("C5. deadline — a generation past its durable deadline settles FAILED/TIMEOUT, never hangs forever", async () => {
    let now = Date.now();
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("c5", {
      deadlineMs: 500,
      nowMs: () => now,
      generate: async (gen) => {
        gens.push(gen);
        return { tasks: canonPlan(altPlan().tasks) };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    ctx.runtime.tick(mid, fakeClock()()); // mint the durable generation row
    const row = ctx.generations()[0];
    // Advance injected time past the durable deadline.
    now = Date.parse(row.deadline_at) + 1_000;
    const out = await ctx.sweep();
    expect(out.claimed).toHaveLength(0);
    expect(gens).toHaveLength(0); // never invoked — deadline won first
    const settled = ctx.gen.get(row.replan_generation_id)!;
    expect(settled.status).toBe("FAILED");
    expect(settled.outcome?.kind).toBe("TIMEOUT");
    // The next tick maps it onto the REPLAN-infeasible path.
    ctx.runtime.tick(mid, fakeClock()());
    ctx.driveGen(mid);
    expect(ctx.attempts(mid)).toHaveLength(0);
  });

  it("C6. bounded leases — reclaim count is capped; exhaustion settles FAILED", async () => {
    const t0 = Date.now();
    const { ctx } = await pendingCtx("c6");
    const row = ctx.generations()[0];
    let owner = 0;
    // REPLAN_GENERATION_MAX_LEASES = 2 claims, then a reclaim attempt
    // exhausts the row to FAILED.
    for (let i = 0; i < 3; i++) {
      const c = ctx.gen.claimNext({ owner_id: `w${++owner}`, lease_ms: 10, now_ms: t0 + i * 100 });
      if (!c) break;
      if (i === 2) expect.unreachable("a third lease must not be granted");
    }
    const settled = ctx.gen.get(row.replan_generation_id)!;
    expect(settled.status).toBe("FAILED");
    expect(settled.outcome?.code).toBe("REPLAN_GENERATION_LEASE_EXHAUSTED");
  });
});

/* ============ D — end-to-end governed outcomes ===================== */

describe("async replan D — staged candidates re-enter the existing gates", () => {
  it("D1. real REPLAN → staged alternative → atomic commit → mission resumes and completes", async () => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("d1", {
      generate: async (gen) => {
        gens.push(gen);
        return { tasks: altPlan().tasks, planner_run_id: "PRN_d1" };
      },
    });
    // NOTE: the canonical PAIR_NATIVE bookkeeping path cannot complete
    // on this host — pair-f3-r1-remediation A7b fails identically on
    // the untouched BASE SHA (ARTIFACT_VALIDATION_FAILURE on the
    // injected T1 spec task). This test therefore proves the SAME
    // governed outcome — REPLAN → validated staged alternative →
    // atomic PREPARED→ACCEPTED commit → resume → COMPLETED — through
    // the executor-scripted lane, which is host-deterministic.
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const state = await ctx.driveGen(mid);
    expect(state).toBe("COMPLETED");
    const atts = ctx.attempts(mid);
    expect(atts.map((a) => a.status)).toEqual(["ACCEPTED"]);
    // Exactly one new revision committed through the SAME atomic
    // PREPARED → ACCEPTED protocol.
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    expect(String(ctx.service.getMission(mid).plan_revision)).toBe("2");
    // The generation row converges CONSUMED once its slot resolved.
    await ctx.sweep();
    expect(String(ctx.gen.get(gens[0].replan_generation_id)!.status)).toBe("CONSUMED");
    expect(gens[0].replan_context.failure_class).toBe("DEPENDENCY_FAILURE");
  });

  it("D2. first candidate invalid → second generation permitted within the existing 2-slot bound", async () => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("d2", {
      generate: async (gen) => {
        gens.push(gen);
        // Slot 0 emits an invalid candidate (no capabilities) — the
        // staged bytes re-enter runReplan's committed gates verbatim.
        return gen.attempt_index === 0
          ? { tasks: [{ task_key: "T1", title: "x", task_instruction: "x", required_capabilities: [], depends_on: [] }] }
          : { tasks: altPlan().tasks };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const state = await ctx.driveGen(mid);
    expect(state).not.toBe("REPLANNING");
    const atts = ctx.attempts(mid);
    expect(atts.map((a) => a.status)).toEqual(["REJECTED_INVALID", "ACCEPTED"]);
    // Two durable generation rows — one per slot, sequential.
    expect(ctx.generations().map((g) => g.attempt_index)).toEqual([0, 1]);
    // The second generation's snapshot carries the first rejection —
    // sequential rejection feedback reaches the async provider.
    expect(gens[1].replan_context.rejected_semantic_digests.length).toBe(1);
  });

  it("D3. semantic duplicate staged → REJECTED_DUPLICATE; next generation carries the rejected digest", async () => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("d3", {
      generate: async (gen) => {
        gens.push(gen);
        // Slot 0 re-emits the failed plan's exact shape — a semantic
        // duplicate; slot 1 emits the genuine alternative.
        return gen.attempt_index === 0
          ? { tasks: incidentPlan().tasks }
          : { tasks: altPlan().tasks };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    await ctx.driveGen(mid);
    const atts = ctx.attempts(mid);
    expect(atts.map((a) => a.status)).toEqual(["REJECTED_DUPLICATE", "ACCEPTED"]);
    expect(String(atts[0].rejection_reason)).toBe("PLAN_SEMANTIC_DUPLICATE");
    // The rejected digest reached the NEXT generation's context.
    const failedDigest = String(gens[0].replan_context.failed_plan_semantic_digest);
    expect(gens[1].replan_context.rejected_semantic_digests).toEqual([failedDigest]);
  });

  it("D4. provider unavailable → FAILED(PROVIDER_UNAVAILABLE) → REPLAN infeasible → fresh decision aborts — NO slot consumed", async () => {
    const ctx = makeAsyncCtx("d4", {
      generate: async () => {
        throw new IntegrityError("FAIL_CLOSED_PLANNER_NO_ELIGIBLE", "{}");
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const state = await ctx.driveGen(mid);
    expect(state).toBe("ABORTED");
    const g = ctx.generations()[0];
    expect(g.status).toBe("FAILED");
    expect(g.outcome?.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(g.outcome?.code).toBe("FAIL_CLOSED_PLANNER_NO_ELIGIBLE");
    // Provider unavailability is NOT a candidate rejection — the
    // bounded candidate ledger is untouched.
    expect(ctx.attempts(mid)).toHaveLength(0);
    const [d1, d2] = ctx.decisions(mid);
    expect(d1.selected_action).toBe("REPLAN");
    expect(d2.selected_action).toBe("ABORT");
    const rej = (d2.rejected_actions as Array<{ action: string; reason: string }>).find(
      (r) => r.action === "REPLAN",
    );
    expect(rej?.reason).toContain("REPLAN");
    // Old plan intact — no second revision, no supersede.
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
  });

  it("D5. pool exhaustion → FAILED(EXHAUSTED) → REPLAN infeasible path", async () => {
    const ctx = makeAsyncCtx("d5", {
      generate: async () => {
        throw new IntegrityError("FAIL_CLOSED_PLANNER_EXHAUSTED", "pool");
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const state = await ctx.driveGen(mid);
    expect(state).toBe("ABORTED");
    const g = ctx.generations()[0];
    expect(g.outcome?.kind).toBe("EXHAUSTED");
    expect(ctx.attempts(mid)).toHaveLength(0);
  });

  it("D6. objective budget zero → admission fails closed BEFORE any model call → FAILED(ADMISSION_REJECTED)", async () => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("d6", {
      generate: async (gen) => {
        gens.push(gen);
        const mission = ctx.service.getMission(String(gen.mission_id));
        // The SAME canonical admission seam production wiring calls —
        // real lineage walk, real objective cap, real PolicyError.
        ctx.service.cost.admitPlannerInvocation({
          planner_run_id: "PRN_d6",
          work_item_id: replanWorkItemId(ctx.store, mission),
          est_microusd: 1_000_000,
          unbounded_unknown: false,
          candidates: 1,
          actor: "PAIR_REPLAN_GENERATION",
        });
        return { tasks: altPlan().tasks };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    ctx.runtime.tick(mid, fakeClock()()); // mint the durable generation row
    // Canonical Objective lineage, fabricated post-mint (startMission
    // cannot mint a bound open): binding → work_item(objective claim)
    // → allocation → zero-cap policy.
    ctx.store.put("work_item", "WI_d6", {
      work_item_id: "WI_d6", business_id: "B1", department: "ops",
      goal: "governed async replan test mission", objective_id: "OBJ_d6",
      status: "OPEN", version: 0,
    });
    ctx.store.put("workforce_allocation", "WAL_d6", {
      workforce_allocation_id: "WAL_d6", objective_id: "OBJ_d6",
      workstream_work_item_id: "WI_d6", delegated_child_work_item_id: null,
      status: "ACTIVE", version: 0,
    });
    ctx.store.put("objective_auto_policy", "oap:OBJ_d6", {
      objective_auto_policy_id: "oap:OBJ_d6", objective_id: "OBJ_d6",
      limits: { budget_microusd_cap: 0 }, version: 0,
    });
    ctx.store.put("work_open_binding", "OPEN_d6", {
      open_id: "OPEN_d6", work_item_id: "WI_d6", mission_id: mid,
      state: "BOUND", version: 0,
    });
    const mission = ctx.service.getMission(mid);
    ctx.store.put("mission", mid, { ...mission, bound_open_id: "OPEN_d6" }, Number(mission.version));
    const out = await ctx.sweep();
    expect(out.failed).toHaveLength(1);
    const g = ctx.gen.get(gens[0].replan_generation_id)!;
    expect(g.status).toBe("FAILED");
    expect(g.outcome?.kind).toBe("ADMISSION_REJECTED");
    expect(String(g.outcome?.code)).toBe("FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED");
    expect(ctx.attempts(mid)).toHaveLength(0);
  });

  it("D7. broken objective lineage → admission fails closed (UNVERIFIED) — never silently scoped NONE", async () => {
    const gens: ReplanGenerationRecord[] = [];
    const ctx = makeAsyncCtx("d7", {
      generate: async (gen) => {
        gens.push(gen);
        const mission = ctx.service.getMission(String(gen.mission_id));
        ctx.service.cost.admitPlannerInvocation({
          planner_run_id: "PRN_d7",
          work_item_id: replanWorkItemId(ctx.store, mission),
          est_microusd: 1_000_000,
          candidates: 1,
        });
        return { tasks: altPlan().tasks };
      },
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    ctx.runtime.tick(mid, fakeClock()()); // mint the durable generation row
    // Work item CLAIMS an objective but no allocation/policy resolves it.
    ctx.store.put("work_item", "WI_d7", {
      work_item_id: "WI_d7", business_id: "B1", department: "ops",
      goal: "governed async replan test mission", objective_id: "OBJ_missing",
      status: "OPEN", version: 0,
    });
    ctx.store.put("work_open_binding", "OPEN_d7", {
      open_id: "OPEN_d7", work_item_id: "WI_d7", mission_id: mid,
      state: "BOUND", version: 0,
    });
    const mission = ctx.service.getMission(mid);
    ctx.store.put("mission", mid, { ...mission, bound_open_id: "OPEN_d7" }, Number(mission.version));
    await ctx.sweep();
    const g = ctx.gen.get(gens[0].replan_generation_id)!;
    expect(g.status).toBe("FAILED");
    expect(g.outcome?.kind).toBe("ADMISSION_REJECTED");
    expect(String(g.outcome?.code)).toBe("FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED");
  });
});

/* ============ E — transport parity ================================== */

describe("async replan E — structured replan_context reaches both transports", () => {
  it("E1. codex-cli planner transport renders the canonical REPLAN CONTEXT block identically to HTTP", () => {
    const ctx = {
      recovery_id: "RCV_x",
      failure_signature: "DEPENDENCY_FAILURE::EX::CAP",
      failure_class: "DEPENDENCY_FAILURE",
      dependency_reason: "REMOTE_CONSUMER_ARTIFACT_MISSING",
      failed_task_key: "T2",
      failed_plan_semantic_digest: "deadbeef",
      rejected_semantic_digests: ["abc123"],
    };
    const prompt = buildCodexPlannerPrompt("ship the report", {
      allowedCapabilities: ["FILE_OPERATIONS", REMOTE],
      capabilitySets: [["FILE_OPERATIONS"], [REMOTE]],
      replanContext: ctx,
    });
    expect(prompt).toContain("REPLAN CONTEXT");
    expect(prompt).toContain("failure_class: DEPENDENCY_FAILURE");
    expect(prompt).toContain("dependency_reason: REMOTE_CONSUMER_ARTIFACT_MISSING");
    expect(prompt).toContain("failed_task: T2");
    expect(prompt).toContain("deadbeef");
    expect(prompt).toContain("abc123");
    // No replan context → no block (initial planning unchanged).
    const initial = buildCodexPlannerPrompt("ship the report", {
      allowedCapabilities: ["FILE_OPERATIONS"],
    });
    expect(initial).not.toContain("REPLAN CONTEXT");
  });
});

/* ============ F — audit R1: bounded concurrency + stale settlement ===
 * R1-F1: the driver must run bounded CONCURRENT generations — a stalled
 *        Mission A can never serialize/starve independent Mission B
 *        (claim CAS = single-flight authority; per-sweep claim bound =
 *        concurrency bound; oldest-first = fairness).
 * R1-F2: settle() and candidate delivery must revalidate deadline,
 *        active recovery identity and the unresolved candidate slot —
 *        a cancelled/expired/superseded generation can never become
 *        consumable even when reconcile() has not yet run. */
describe("async replan F — audit R1: bounded concurrency + stale-settlement revalidation", () => {
  const pendingCtxF = async (name: string) => {
    const ctx = makeAsyncCtx(name, {
      generate: async () => ({ tasks: altPlan().tasks }),
    });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]),
      ["FILE_OPERATIONS"],
    );
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.toReplanning(mid);
    ctx.runtime.tick(mid, fakeClock()()); // mint the durable row
    expect(ctx.generations()).toHaveLength(1);
    return { ctx, mid, row: ctx.generations()[0] };
  };
  const plannerInputFor = (ctx: ReturnType<typeof makeAsyncCtx>, mid: string, row: ReplanGenerationRecord) =>
    ({
      mission: {
        ...ctx.service.getMission(mid),
        operator_goal: "governed async replan test mission",
      },
      reason: "replan",
      replan_context: row.replan_context,
    }) as unknown as RuntimePlannerInput;

  it("F1. bounded concurrency — a stalled Mission A generation cannot starve independent Mission B", async () => {
    const holder = { a: "", b: "" };
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const ctx = makeAsyncCtx("f1", {
      generate: async (gen) => {
        if (String(gen.mission_id) === holder.a) await gateA;
        return {
          tasks: altPlan().tasks,
          planner_run_id: `PRN_${String(gen.mission_id)}`,
        };
      },
    });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", Array.from({ length: 8 }, () => ({ status: "COMPLETED" }))),
      ["FILE_OPERATIONS"],
    );
    const midA = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const midB = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    holder.a = midA;
    holder.b = midB;
    ctx.toReplanning(midA);
    ctx.toReplanning(midB);
    // A mints FIRST (older created_at → claimed first under the
    // oldest-first claim order); B mints second.
    ctx.runtime.tick(midA, fakeClock()());
    ctx.runtime.tick(midB, fakeClock()());
    const gens = ctx.generations();
    const gA = gens.find((g) => g.mission_id === midA)!;
    const gB = gens.find((g) => g.mission_id === midB)!;
    const done = ctx.sweep(); // claims + generates concurrently — do not await yet
    // Let claims + B's immediate generate settle while A is still gated.
    await new Promise((r) => setTimeout(r, 30));
    // B's row is claimed in the SAME sweep and settles STAGED while A's
    // generation is still in flight — sequential awaiting would leave B
    // unclaimed/PENDING behind A's stalled provider call.
    expect(String(ctx.gen.get(gB.replan_generation_id)!.status)).toBe("STAGED");
    expect(String(ctx.gen.get(gA.replan_generation_id)!.status)).toBe("LEASED");
    releaseA();
    const out = await done;
    expect(out.claimed).toEqual(
      expect.arrayContaining([gA.replan_generation_id, gB.replan_generation_id]),
    );
    expect(out.staged).toEqual(
      expect.arrayContaining([gA.replan_generation_id, gB.replan_generation_id]),
    );
    expect(String(ctx.gen.get(gA.replan_generation_id)!.status)).toBe("STAGED");
  });

  it("F2. settle() revalidates the live recovery chain — a cancelled in-flight generation is CANCELLED at settle, never staged", async () => {
    const { ctx, mid, row } = await pendingCtxF("f2");
    const claimed = ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(claimed).toBeTruthy();
    ctx.runtime.cancel(mid, "OP"); // recovery chain moved on — NO reconcile runs
    const applied = ctx.gen.settle(row.replan_generation_id, "w1", 1, {
      status: "STAGED",
      candidate: { tasks: canonPlan(altPlan().tasks) },
    });
    expect(applied).toBe(false);
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CANCELLED");
  });

  it("F3. settle() revalidates the durable deadline — an expired in-flight generation settles FAILED/TIMEOUT, never STAGED", async () => {
    const { ctx, row } = await pendingCtxF("f3");
    ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    // The deadline passed while the provider call was in flight
    // (reconcile has not run — settle itself must refuse the result).
    const cur = ctx.gen.get(row.replan_generation_id)!;
    ctx.store.put(
      "replan_generation",
      row.replan_generation_id,
      { ...cur, deadline_at: new Date(Date.now() - 1).toISOString() },
      Number(cur.version),
    );
    const applied = ctx.gen.settle(row.replan_generation_id, "w1", 1, {
      status: "STAGED",
      candidate: { tasks: canonPlan(altPlan().tasks) },
    });
    expect(applied).toBe(false);
    const after = ctx.gen.get(row.replan_generation_id)!;
    expect(after.status).toBe("FAILED");
    expect(after.outcome?.kind).toBe("TIMEOUT");
    expect(after.outcome?.code).toBe("REPLAN_GENERATION_DEADLINE");
  });

  it("F4. settle() revalidates the unresolved candidate slot — a resolved slot CANCELS the row, never stages", async () => {
    const { ctx, mid, row } = await pendingCtxF("f4");
    ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    // The candidate slot resolved through another authority path while
    // generation was in flight (durable ledger row for this slot).
    new ReplanAttemptLedger(ctx.store).record({
      mission_id: mid,
      recovery_id: row.recovery_id,
      attempt_index: row.attempt_index,
      proposal_digest: "sim",
      status: "REJECTED_INVALID",
      rejection_reason: "SIMULATED_EXTERNAL_RESOLUTION",
    });
    const applied = ctx.gen.settle(row.replan_generation_id, "w1", 1, {
      status: "STAGED",
      candidate: { tasks: canonPlan(altPlan().tasks) },
    });
    expect(applied).toBe(false);
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CANCELLED");
  });

  it("F5. requestCandidate revalidates the deadline at delivery — an expired STAGED row is never served", async () => {
    const { ctx, mid, row } = await pendingCtxF("f5");
    ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(true);
    // Deadline elapsed between staging and serving; no reconcile ran.
    const cur = ctx.gen.get(row.replan_generation_id)!;
    ctx.store.put(
      "replan_generation",
      row.replan_generation_id,
      { ...cur, deadline_at: new Date(Date.now() - 1).toISOString() },
      Number(cur.version),
    );
    const err = (() => {
      try {
        ctx.gen.requestCandidate(plannerInputFor(ctx, mid, row));
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(String(err?.code)).toBe("FAIL_CLOSED_REPLAN_PROVIDER_TIMEOUT");
    const after = ctx.gen.get(row.replan_generation_id)!;
    expect(after.status).toBe("FAILED");
    expect(after.outcome?.kind).toBe("TIMEOUT");
  });

  it("F6. requestCandidate revalidates recovery identity at delivery — a superseded/cancelled chain is never served", async () => {
    const { ctx, mid, row } = await pendingCtxF("f6");
    ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(true);
    // The recovery chain moved on: a different recovery now owns
    // pending_recovery (supersession) — the staged row is orphaned.
    const rt = ctx.rt(mid);
    const pending = rt.pending_recovery as Record<string, unknown>;
    rt.pending_recovery = { ...pending, recovery_id: "RCV_superseded" };
    ctx.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
    const err = (() => {
      try {
        ctx.gen.requestCandidate(plannerInputFor(ctx, mid, row));
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(String(err?.code)).toBe("FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE");
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CANCELLED");
  });

  it("F7. requestCandidate revalidates the unresolved slot at delivery — a resolved STAGED row converges CONSUMED, never served twice", async () => {
    const { ctx, mid, row } = await pendingCtxF("f7");
    ctx.gen.claimNext({ owner_id: "w1", lease_ms: 60_000, now_ms: Date.now() });
    expect(
      ctx.gen.settle(row.replan_generation_id, "w1", 1, {
        status: "STAGED",
        candidate: { tasks: canonPlan(altPlan().tasks) },
      }),
    ).toBe(true);
    // The slot was durably resolved by another authority path while the
    // staged candidate sat unread. attemptsUsed now addresses the NEXT
    // slot — the stale STAGED row is unreachable as a serve target, and
    // the delivery seam itself converges it terminal (reconcile has NOT
    // run): the staged bytes can never be consumed.
    new ReplanAttemptLedger(ctx.store).record({
      mission_id: mid,
      recovery_id: row.recovery_id,
      attempt_index: row.attempt_index,
      proposal_digest: "sim",
      status: "REJECTED_INVALID",
      rejection_reason: "SIMULATED_EXTERNAL_RESOLUTION",
    });
    const err = (() => {
      try {
        ctx.gen.requestCandidate(plannerInputFor(ctx, mid, row));
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    // The request resolves to the NEXT unresolved slot — a fresh
    // generation row was minted and is PENDING (no failure).
    expect(String(err?.code)).toBe("REPLAN_GENERATION_PENDING");
    // The stale staged row converged CONSUMED at the delivery seam —
    // reconcile() never ran — and it can never be served again.
    expect(String(ctx.gen.get(row.replan_generation_id)!.status)).toBe("CONSUMED");
    const fresh = ctx.generations().find(
      (g) => g.recovery_id === row.recovery_id && g.attempt_index === 1,
    );
    expect(fresh).toBeTruthy();
    expect(String(fresh!.status)).toBe("PENDING");
  });
});

/* ============ G — audit R1: zero-budget authority =====================
 * R1-F3: independent verification of canonical Objective ZERO_BUDGET
 * and auto-policy cap behavior at the planner admission seam —
 * cap=0 hard-blocks any positive envelope AND any unprovable charge,
 * admits a provable $0 envelope as a bounded CAPPED reservation, and an
 * absent policy cap resolves UNCAPPED (no monetary authority exists).
 * PR #117 hard-block semantics are preserved verbatim — these tests
 * pin behavior, they do not relax it. */
describe("async replan G — audit R1: zero-budget authority at the admission seam", () => {
  /** Canonical objective lineage without a mission: work_item(objective
   *  claim) → workforce_allocation → objective_auto_policy (optional).
   *  `cap === undefined` leaves the policy row absent. */
  const lineageCtx = (name: string, cap?: number) => {
    const ctx = makeAsyncCtx(name, {
      generate: async () => ({ tasks: altPlan().tasks }),
    });
    ctx.store.put("work_item", `WI_${name}`, {
      work_item_id: `WI_${name}`, business_id: "B1", department: "ops",
      goal: "governed async replan test mission", objective_id: `OBJ_${name}`,
      status: "OPEN", version: 0,
    });
    ctx.store.put("workforce_allocation", `WAL_${name}`, {
      workforce_allocation_id: `WAL_${name}`, objective_id: `OBJ_${name}`,
      workstream_work_item_id: `WI_${name}`, delegated_child_work_item_id: null,
      status: "ACTIVE", version: 0,
    });
    if (cap !== undefined) {
      ctx.store.put("objective_auto_policy", `oap:OBJ_${name}`, {
        objective_auto_policy_id: `oap:OBJ_${name}`, objective_id: `OBJ_${name}`,
        limits: { budget_microusd_cap: cap }, version: 0,
      });
    }
    return { ctx, wi: `WI_${name}`, obj: `OBJ_${name}` };
  };

  it("G1. ZERO_BUDGET: cap=0 + positive envelope → FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED", () => {
    const { ctx, wi } = lineageCtx("g1", 0);
    expect(
      ctx.service.cost.objectiveScopeForWorkItem(wi),
    ).toEqual({ objective_id: "OBJ_g1", cap: 0 });
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_g1", work_item_id: wi,
        est_microusd: 1, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
    expect(ctx.store.list("cost_reservation")).toHaveLength(0);
  });

  it("G2. ZERO_BUDGET + provable zero-cost candidate: est=0 admits under CAPPED scope with a 0µUSD reservation — never silently free", () => {
    const { ctx, wi } = lineageCtx("g2", 0);
    const out = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_g2", work_item_id: wi,
      est_microusd: 0, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(out.scope).toBe("CAPPED");
    expect(out.objective_id).toBe("OBJ_g2");
    const r = ctx.store.get("cost_reservation", String(out.reservation_id));
    expect(Number(r.reserved_microusd)).toBe(0);
    expect(String(r.billing_mode)).toBe("UNMETERED");
    expect(String(r.status)).toBe("HELD");
  });

  it("G3. ZERO_BUDGET + unprovable cost: unbounded_unknown under cap=0 fails closed UNVERIFIED — an unprovable charge is never $0", () => {
    const { ctx, wi } = lineageCtx("g3", 0);
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_g3", work_item_id: wi,
        est_microusd: 0, unbounded_unknown: true, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED" }) as never,
    );
    expect(ctx.store.list("cost_reservation")).toHaveLength(0);
  });

  it("G4. absent auto-policy cap: lineage resolves UNCAPPED — no monetary authority exists; the bounded envelope is still reserved", () => {
    const { ctx, wi } = lineageCtx("g4"); // no objective_auto_policy row
    expect(ctx.service.cost.objectiveScopeForWorkItem(wi)).toEqual({
      objective_id: "OBJ_g4", cap: null,
    });
    const out = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_g4", work_item_id: wi,
      est_microusd: 100, unbounded_unknown: true, candidates: 1,
      actor: "TEST",
    });
    expect(out.scope).toBe("UNCAPPED");
    const r = ctx.store.get("cost_reservation", String(out.reservation_id));
    expect(Number(r.reserved_microusd)).toBe(100);
    expect(r.unbounded).toBe(true);
  });

  it("G5. no lineage claim at all → scope NONE, zero reservation rows", () => {
    const { ctx } = lineageCtx("g5", 0);
    const noWi = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_g5a", work_item_id: null,
      est_microusd: 5, candidates: 1, actor: "TEST",
    });
    expect(noWi).toEqual({ reservation_id: null, scope: "NONE", objective_id: null });
    // A work item carrying NO objective claim and no allocation →
    // genuinely unscoped, not broken.
    ctx.store.put("work_item", "WI_free", {
      work_item_id: "WI_free", business_id: "B1", department: "ops",
      goal: "x", objective_id: null, status: "OPEN", version: 0,
    });
    const free = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_g5b", work_item_id: "WI_free",
      est_microusd: 5, candidates: 1, actor: "TEST",
    });
    expect(free.scope).toBe("NONE");
    expect(free.reservation_id).toBeNull();
    expect(ctx.store.list("cost_reservation")).toHaveLength(0);
  });

  it("G6. integrated: a zero-cost replan candidate under ZERO_BUDGET stages + commits through the governed path (bounded, not silent)", async () => {
    let admissionScope: string | null = null;
    const ctx = makeAsyncCtx("g6", {
      generate: async (gen) => {
        const mission = ctx.service.getMission(String(gen.mission_id));
        // The REAL admission seam — work_item_id is what production's
        // runReplanPoolGeneration obtains from replanWorkItemId(); the
        // mission→binding→work_item hop itself is pinned by D6/D7.
        // Passing the resolved id keeps this test on the REAL
        // objective-lineage walk (WI→allocation→auto-policy cap)
        // without fabricating a bound mission whose external-input
        // lineage (assertWorkforceAllocation) cannot be hand-minted.
        const a = ctx.service.cost.admitPlannerInvocation({
          planner_run_id: "PRN_g6",
          work_item_id: mission.bound_open_id != null
            ? replanWorkItemId(ctx.store, mission)
            : "WI_g6",
          est_microusd: 0, unbounded_unknown: false, candidates: 1,
          actor: "PAIR_REPLAN_GENERATION",
        });
        admissionScope = a.scope;
        return { tasks: altPlan().tasks, planner_run_id: "PRN_g6" };
      },
    });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]),
      ["FILE_OPERATIONS"],
    );
    // Canonical Objective lineage with a ZERO_BUDGET auto-policy —
    // real rows, real objectiveScopeForWorkItem walk.
    ctx.store.put("work_item", "WI_g6", {
      work_item_id: "WI_g6", business_id: "B1", department: "ops",
      goal: "governed async replan test mission", objective_id: "OBJ_g6",
      status: "OPEN", version: 0,
    });
    ctx.store.put("workforce_allocation", "WAL_g6", {
      workforce_allocation_id: "WAL_g6", objective_id: "OBJ_g6",
      workstream_work_item_id: "WI_g6", delegated_child_work_item_id: null,
      status: "ACTIVE", version: 0,
    });
    ctx.store.put("objective_auto_policy", "oap:OBJ_g6", {
      objective_auto_policy_id: "oap:OBJ_g6", objective_id: "OBJ_g6",
      limits: { budget_microusd_cap: 0 }, version: 0,
    });
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const state = await ctx.driveGen(mid);
    expect(state).toBe("COMPLETED");
    expect(admissionScope).toBe("CAPPED");
    const r = ctx.store.get("cost_reservation", "CRSV_PLN_PRN_g6");
    expect(Number(r.reserved_microusd)).toBe(0);
    expect(String(r.billing_mode)).toBe("UNMETERED");
    // The replan committed through the same atomic gates.
    expect(ctx.attempts(mid).map((a) => a.status)).toEqual(["ACCEPTED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
  });
});

/* ============ H — production composition integration (audit R1-F4) ===
 * Coverage boundary: sections A–G drive the driver with an INJECTED
 * `generate` seam (synthetic E2E). This section composes the REAL
 * production stack — beginPlannerRun → cost admission (canonical
 * objective lineage) → runPlannerFailover with the real
 * assertPlannerCandidateEligible + canonicalize + validatePlanProposal
 * winner gate + durable planner_run/planner_attempt evidence →
 * finishPlannerRun → settlePlannerInvocation — with ONLY the model
 * transport stubbed (planFn), mirroring serve-mission-control.mjs's
 * runReplanPoolGeneration + planExpander seam-for-seam. */

/** Canonical catalog seed for an HTTP planner candidate — the SAME real
 *  seams production discovery/qualification use (provider candidate →
 *  validateAccess probe → qualify → model claim → probe receipt →
 *  qualifyModel → PLANNER_COORDINATOR role). Only the wire is faked. */
async function seedHttpPlannerCandidate(store: PairEvidenceStore): Promise<PlannerCandidate> {
  const pid = "planner-http";
  const mid = "gpt-x";
  new ProviderCatalog(store).upsertCandidate(
    {
      provider_native_id: pid, canonical_hint: pid, source_id: "OPERATOR_MANIFEST",
      display_name: pid, provider_type: "OPENAI_COMPATIBLE",
      protocol_family: "OPENAI_COMPATIBLE", provider_family: pid,
      endpoint_reference: `https://api.${pid}.test/v1`,
      credential_reference_name: "PLANNER_HTTP_KEY",
    },
    "TEST",
  );
  const pv = new ProviderValidator(store);
  await pv.validateAccess(pid, {
    env: { PLANNER_HTTP_KEY: "cred" },
    probe: async () => ({ outcome: "AUTH_OK", latency_ms: 1 }),
  });
  pv.qualify(pid, { env: { PLANNER_HTTP_KEY: "cred" }, actor: "TEST" });
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid, provider_family: pid, model_id: mid,
    display_name: mid, capability_hints: ["text_inference"],
    status_hint: "LISTED", observed_at: "2026-01-01T00:00:00Z",
  });
  const meId = String(entry.model_entry_id);
  mcat.recordProbeReceipt({
    probe_id: `PRB_${pid}_${mid}`, model_entry_id: meId, provider_id: pid,
    result: "PASS", probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" },
    latency_ms: 1, detail: "fixture",
  });
  qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "TEST" });
  assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
  return {
    model_entry_id: meId, ref: `${pid}:${mid}`, provider: pid, model: mid,
    endpoint: "https://api.planner-http.test/v1",
    credentialEnv: "PLANNER_HTTP_KEY", transport: "openai_http",
  };
}

/** Seam-for-seam mirror of serve-mission-control.mjs's
 *  runReplanPoolGeneration — every governance seam is REAL; only the
 *  model transport (`planFn`) is stubbed. */
function makeProdCompositionGenerate(
  ctx: ReturnType<typeof makeAsyncCtx>,
  plannerCandidates: PlannerCandidate[],
  stubPlanFn: (
    c: PlannerCandidate,
    invocation: PlannerInvocation,
  ) => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }>,
  /** Test hook — each REAL admitPlannerInvocation result, for assertions
   *  on scope/reservation without touching the seam itself. */
  seenAdmissions?: Array<{ reservation_id: string | null; scope: string; objective_id: string | null }>,
): GenerateFn {
  return async (gen) => {
    const mission = ctx.service.getMission(String(gen.mission_id));
    const goal = String(mission.goal ?? "");
    const authorityGoal = missionOperatorGoalOf(ctx.store, mission);
    const externalInputs =
      ctx.service.artifactResolver.listEligibleExternalInputSources(mission);
    const candidates = dedupePlannerCandidates(plannerCandidates);
    const run = beginPlannerRun(ctx.store, {
      project_id: mission.project_id != null ? String(mission.project_id) : undefined,
      operator_id: mission.operator_id,
      routes: candidates.map((c) => c.ref),
      actor: "PAIR_REPLAN_GENERATION",
    });
    const deadlineAt = Math.min(
      Date.now() + 60_000,
      Date.parse(String(gen.deadline_at)),
    );
    let admission: {
      reservation_id: string | null;
      scope: string;
      objective_id: string | null;
    } | null = null;
    try {
      admission = ctx.service.cost.admitPlannerInvocation({
        planner_run_id: String(run.planner_run_id),
        work_item_id: replanWorkItemId(ctx.store, mission),
        est_microusd: candidates.reduce((sum, c) => {
          const b = ctx.service.cost.plannerRequestBoundMicrousd(c);
          return sum + b.per_request_microusd * plannerCandidateRequestBound(c);
        }, 0),
        unbounded_unknown: candidates.some(
          (c) => ctx.service.cost.plannerRequestBoundMicrousd(c).billing.unbounded,
        ),
        candidates: candidates.length,
        actor: "PAIR_REPLAN_GENERATION",
      });
      if (admission) seenAdmissions?.push(admission);
      const knownCaps = () =>
        new Set(ctx.store.list("capability").map((c) => String(c.capability_id)));
      const res = await runPlannerFailover({
        candidates,
        // Real canonical eligibility: role + lifecycle + provider gates.
        assertEligible: (c) =>
          assertPlannerCandidateEligible(ctx.store, c.model_entry_id),
        // Real ONE canonicalize seam + validatePlanProposal winner gate.
        canonicalize: (tasks, _c, evidence) => {
          const canon = ctx.canonicalizeLlmTasks(tasks, goal, {
            provenance: "fresh",
            authorityGoal,
            raw_delivery_emission_count: evidence?.raw_delivery_emission_count,
            raw_delivery_emission_state: evidence?.raw_delivery_emission_state,
            external_input_artifacts: externalInputs,
          });
          validatePlanProposal({ tasks: canon }, knownCaps());
          return canon;
        },
        planFn: stubPlanFn, // ← the ONLY stub: the model transport
        latencyBudget: () => ({ ceilingMs: 10_000, requestTimeoutMs: 5_000 }),
        onAttemptStart: (base) =>
          persistPlannerAttemptStart(ctx.store, {
            planner_run_id: String(run.planner_run_id),
            record: base, actor: "PAIR_REPLAN_GENERATION",
          }).planner_attempt_id,
        onAttemptReask: (paid, code) =>
          markPlannerAttemptReask(ctx.store, {
            planner_attempt_id: String(paid),
            validation_code: String(code), actor: "PAIR_REPLAN_GENERATION",
          }),
        onAttemptEnd: (paid, rec) =>
          settlePlannerAttempt(ctx.store, {
            planner_attempt_id: String(paid), record: rec,
            winner: rec.outcome === "SUCCESS", actor: "PAIR_REPLAN_GENERATION",
          }),
        onExhausted: () =>
          finishPlannerRun(ctx.store, {
            planner_run_id: String(run.planner_run_id),
            outcome: "EXHAUSTED", actor: "PAIR_REPLAN_GENERATION",
          }),
        deadlineMs: deadlineAt,
      });
      finishPlannerRun(ctx.store, {
        planner_run_id: String(run.planner_run_id),
        outcome: "WINNER_SELECTED",
        winner_attempt_no: res.winner.attempt_no,
        actor: "PAIR_REPLAN_GENERATION",
      });
      if (admission.reservation_id) {
        ctx.service.cost.settlePlannerInvocation(admission.reservation_id, "CALLS_MADE", null);
      }
      return { tasks: res.tasks, planner_run_id: String(run.planner_run_id) };
    } catch (e) {
      if (!(e instanceof IntegrityError && e.code === "FAIL_CLOSED_PLANNER_EXHAUSTED")) {
        finishPlannerRun(ctx.store, {
          planner_run_id: String(run.planner_run_id),
          outcome: "FAILED",
          error_code:
            e instanceof IntegrityError || e instanceof PolicyError
              ? e.code : "REQUEST_ERROR",
          actor: "PAIR_REPLAN_GENERATION",
        });
      }
      if (admission?.reservation_id) {
        const settled = ctx.store.tryGet("planner_run", String(run.planner_run_id));
        ctx.service.cost.settlePlannerInvocation(
          admission.reservation_id,
          Number(settled?.provider_requests ?? settled?.attempts ?? 0) > 0
            ? "CALLS_MADE" : "NO_CALLS",
        );
      }
      (e as { planner_run_id?: string }).planner_run_id = String(run.planner_run_id);
      throw e;
    }
  };
}

describe("async replan H — production composition integration (stub transport only)", () => {
  it("H1. real pool + real cost admission + real driver + real runtime: REPLAN → staged pool winner → atomic commit", async () => {
    const ctx = makeAsyncCtx("h1", {
      // Rebound below — generate needs ctx + the seeded candidate first.
      generate: async () => ({ tasks: [] }),
    });
    const candidate = await seedHttpPlannerCandidate(ctx.store);
    // A provable-bounded planner cost profile so the reservation is
    // METERED_API (per-request bound × request-count bound envelope).
    ctx.service.cost.createCostProfile(
      { ref_type: "executor", ref_id: "PAIR_PLANNER", billing_mode: "METERED_API", reserve_microusd: 250 },
      "TEST",
    );
    const transportCalls: Array<{ model: string; kind: string | undefined }> = [];
    const seenAdmissions: Array<{ scope: string; reservation_id: string | null }> = [];
    const gen = makeProdCompositionGenerate(ctx, [candidate], async (c, invocation) => {
      // Stubbed model transport — reports ONE provable provider request
      // through the pool-owned counter, then returns raw model output.
      if (invocation.providerCounter) invocation.providerCounter.requests += 1;
      transportCalls.push({ model: c.model, kind: invocation.kind });
      return { tasks: altPlan().tasks, warnings: [] };
    }, seenAdmissions);
    const sweep = makeReplanGenerationDriver({
      service: ctx.gen, generate: gen, owner_id: "prod-it",
      lease_ms: 60_000,
    });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]),
      ["FILE_OPERATIONS"],
    );
    // Unbound mission — the production manual-mission path: the REAL
    // admission seam runs the real lineage resolver and correctly
    // scopes NONE (reservation coverage lives in G-series at the same
    // seam; bound-mission lineage cannot be hand-fabricated — see G6).
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const clock = fakeClock();
    let state = "";
    for (let i = 0; i < 200; i++) {
      ctx.runtime.tick(mid, clock());
      await sweep();
      await new Promise((r) => setTimeout(r, 15));
      state = String(ctx.rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(state)) break;
    }
    // The REAL composition proof ends at the governed commit boundary:
    // generation → real pool winner → staged → atomic PREPARED→ACCEPTED
    // commit → plan_revision 2. Post-commit dispatch of the real
    // canonicalized plan's injected T1 AUTOMATON_TASK_EXECUTION
    // bookkeeping task cannot complete in THIS fixture — no AUTOMATON
    // executor is registered (the PAIR_NATIVE path is the registered
    // win32 artifact-ingest baseline A7b exercises) — so the mission
    // deterministically aborts DOWNSTREAM of the commit, on the
    // executor-routing path the composition under test does not own.
    // Resume→COMPLETED of a committed replan is separately proven by D1.
    expect(state).toBe("ABORTED");
    const rt = ctx.rt(mid);
    expect(String(rt.state)).toBe("ABORTED");
    // The governed outcome that matters: REPLAN selected → committed.
    expect(ctx.attempts(mid).map((a) => a.status)).toEqual(["ACCEPTED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    expect(String(ctx.service.getMission(mid).plan_revision)).toBe("2");
    // Durable production evidence: run WINNER_SELECTED, one SUCCESS
    // attempt with exactly 1 provable provider request.
    const runs = ctx.store.list("planner_run");
    expect(runs.map((r) => r.state)).toEqual(["WINNER_SELECTED"]);
    const atts = ctx.store.list("planner_attempt");
    expect(atts).toHaveLength(1);
    expect(String(atts[0].outcome)).toBe("SUCCESS");
    expect(Number(atts[0].provider_requests)).toBe(1);
    expect(transportCalls.length).toBeGreaterThanOrEqual(1);
    // Real cost admission ran the canonical lineage resolver: unbound
    // mission → scope NONE, no reservation (the manual-mission path
    // unchanged; capped/uncapped reservation flows are pinned by
    // G1–G6 at the same admitPlannerInvocation seam).
    expect(seenAdmissions.map((a) => a.scope)).toEqual(["NONE"]);
    expect(seenAdmissions[0].reservation_id).toBeNull();
    // Scope NONE creates NO reservation row for this planner run.
    expect(
      ctx.store.list("cost_reservation").filter(
        (r) =>
          String(r.cost_reservation_id) ===
          `CRSV_PLN_${String(runs[0].planner_run_id)}`,
      ),
    ).toHaveLength(0);
    // The generation converged CONSUMED via reconcile.
    await sweep();
    const g = ctx.generations()[0];
    expect(String(g.status)).toBe("CONSUMED");
    expect(String(g.planner_run_id)).toBe(String(runs[0].planner_run_id));
  });

  it("H2. real pool: stub transport emits an invalid plan → PLAN_INVALID failover → EXHAUSTED → REPLAN infeasible (no slot consumed)", async () => {
    const ctx = makeAsyncCtx("h2", { generate: async () => ({ tasks: [] }) });
    const candidate = await seedHttpPlannerCandidate(ctx.store);
    const gen = makeProdCompositionGenerate(ctx, [candidate], async (_c, invocation) => {
      if (invocation.providerCounter) invocation.providerCounter.requests += 1;
      // Invalid output: required_capabilities empty → canonicalize /
      // validatePlanProposal rejects → failover → pool exhausted.
      return {
        tasks: [{ task_key: "T1", title: "x", task_instruction: "x", required_capabilities: [], depends_on: [] }],
        warnings: [],
      };
    });
    const sweep = makeReplanGenerationDriver({
      service: ctx.gen, generate: gen, owner_id: "prod-it",
      lease_ms: 60_000,
    });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]),
      ["FILE_OPERATIONS"],
    );
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    const clock = fakeClock();
    let state = "";
    for (let i = 0; i < 200; i++) {
      ctx.runtime.tick(mid, clock());
      await sweep();
      await new Promise((r) => setTimeout(r, 15));
      state = String(ctx.rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(state)) break;
    }
    expect(state).toBe("ABORTED");
    const g = ctx.generations()[0];
    expect(g.status).toBe("FAILED");
    expect(g.outcome?.kind).toBe("EXHAUSTED");
    expect(ctx.attempts(mid)).toHaveLength(0);
    const runs = ctx.store.list("planner_run");
    expect(String(runs[0].state)).toBe("EXHAUSTED");
  });
});

/* ============ I — audit R2-F1: shared bounded in-flight capacity ======
 * R1's per-sweep claim bound alone cannot bound CONCURRENCY once sweeps
 * overlap (production fires a sweep every 1s): each sweep could claim
 * bound more rows while earlier generations are still in flight. The
 * driver must hold a SHARED in-flight capacity across sweep
 * invocations — per-generation CAS lease+epoch stays the single-flight
 * authority; oldest-first stays the fairness order. */
describe("async replan I — audit R2-F1: shared bounded in-flight capacity across sweeps", () => {
  it("I1. overlapping sweeps never exceed the configured in-flight bound; a freed slot admits the next pending mission", async () => {
    const gates = new Map<string, () => void>();
    const inflight = new Set<string>();
    let maxConcurrent = 0;
    const gatedGenerate = async (gen: ReplanGenerationRecord) => {
      const id = String(gen.replan_generation_id);
      inflight.add(id);
      maxConcurrent = Math.max(maxConcurrent, inflight.size);
      await new Promise<void>((r) => gates.set(id, r));
      inflight.delete(id);
      return { tasks: altPlan().tasks };
    };
    const ctx = makeAsyncCtx("i1", { generate: gatedGenerate });
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", Array.from({ length: 16 }, () => ({ status: "COMPLETED" }))),
      ["FILE_OPERATIONS"],
    );
    // Five independent missions, each minting one pending generation.
    const mids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
      ctx.toReplanning(mid);
      ctx.runtime.tick(mid, fakeClock()());
      mids.push(mid);
    }
    expect(ctx.generations()).toHaveLength(5);
    // The production-style driver: per-sweep claim bound 4 AND a shared
    // in-flight capacity of 4 across EVERY overlapping invocation.
    const driver = makeReplanGenerationDriver({
      service: ctx.gen, generate: gatedGenerate,
      owner_id: "i1-driver", lease_ms: 60_000,
      max_claims_per_sweep: 4, max_in_flight: 4,
    });
    const s1 = driver(); // claims the bound, generations stay gated
    await new Promise((r) => setTimeout(r, 30));
    expect(inflight.size).toBe(4);
    // Two more overlapping sweeps — capacity is saturated, so each
    // claims ZERO further rows (CAS lease still single-flights each row).
    const s2 = await driver();
    const s3 = await driver();
    expect(s2.claimed).toHaveLength(0);
    expect(s3.claimed).toHaveLength(0);
    expect(maxConcurrent).toBe(4);
    expect(ctx.generations().filter((g) => String(g.status) === "LEASED")).toHaveLength(4);
    // Release ONE in-flight generation → exactly one capacity slot frees
    // → the next sweep claims the fifth mission's still-PENDING row.
    const pending5 = ctx.generations().find((g) => String(g.status) === "PENDING")!;
    const firstHeld = [...inflight][0];
    gates.get(firstHeld)!();
    await new Promise((r) => setTimeout(r, 20));
    const s4 = driver();
    await new Promise((r) => setTimeout(r, 30));
    // The fifth mission's generation was claimed (LEASED) and is in
    // flight — the freed slot admitted exactly one new generation.
    expect(String(ctx.store.get(
      "replan_generation", String(pending5.replan_generation_id),
    ).status)).toBe("LEASED");
    // Drain every gate; both sweeps finish.
    for (const r of gates.values()) r();
    const out4 = await s4;
    await s1;
    expect(out4.claimed).toEqual([String(pending5.replan_generation_id)]);
    for (const g of ctx.generations()) {
      expect(["STAGED", "CONSUMED"]).toContain(String(g.status));
    }
    expect(maxConcurrent).toBe(4);
  });
});

/* ============ J — audit R2-F2: canonical objective budget authority ====
 * The replan admission seam resolved objective scope ONLY through
 * objective_auto_policy.limits.budget_microusd_cap. PR #117's canonical
 * authority — objective.budget{ceiling,consumed} with the strict
 * spend-ledger proof — is a HARD bound: ceiling=0 is OBJECTIVE_ZERO_
 * BUDGET (never "uncapped", never "exhausted"), consumed>=ceiling is
 * EXHAUSTED, and est must fit the remaining headroom. A provable $0
 * envelope is the explicitly-authorized continuation (it can never
 * spend) — everything spend-bearing under zero budget fails closed. */
describe("async replan J — audit R2-F2: canonical objective budget at replan admission", () => {
  /** Canonical lineage with a REAL objective row: work_item(objective
   *  claim) → workforce_allocation → objective{budget} → optional
   *  objective_auto_policy cap. consumed>0 is minted with the canonical
   *  spend evidence (OBJECTIVE_BUDGET_ACCOUNTED event + applied_spend_
   *  keys digest) so assertCanonicalObjectiveBudget strict-passes. */
  const lineageWithObjective = (
    name: string,
    budget: { ceiling_microusd: number; consumed_microusd?: number },
    policyCap?: number,
  ) => {
    const ctx = makeAsyncCtx(name, {
      generate: async () => ({ tasks: altPlan().tasks }),
    });
    const oid = `OBJ_${name}`;
    const wi = `WI_${name}`;
    const consumed = budget.consumed_microusd ?? 0;
    ctx.store.put("objective", oid, {
      objective_id: oid, business_id: "B1", status: "ACTIVE",
      kpis: [],
      budget: {
        ceiling_microusd: budget.ceiling_microusd,
        consumed_microusd: consumed,
      },
      applied_spend_keys: consumed > 0
        ? [{ key: "sk1", digest: spendSemantics(oid, { spend_key: "sk1", amount_microusd: consumed }) }]
        : [],
      version: 0,
    }, 0);
    if (consumed > 0) {
      ctx.store.event({
        entity_type: "objective", entity_id: oid,
        event_type: "OBJECTIVE_BUDGET_ACCOUNTED", actor: "TEST",
        metadata: { spend_key: "sk1", amount_microusd: consumed, consumed_microusd: consumed },
      });
    }
    ctx.store.put("work_item", wi, {
      work_item_id: wi, business_id: "B1", department: "ops",
      goal: "governed async replan test mission", objective_id: oid,
      status: "OPEN", version: 0,
    });
    ctx.store.put("workforce_allocation", `WAL_${name}`, {
      workforce_allocation_id: `WAL_${name}`, objective_id: oid,
      workstream_work_item_id: wi, delegated_child_work_item_id: null,
      status: "ACTIVE", version: 0,
    });
    if (policyCap !== undefined) {
      ctx.store.put("objective_auto_policy", `oap:${oid}`, {
        objective_auto_policy_id: `oap:${oid}`, objective_id: oid,
        limits: { budget_microusd_cap: policyCap }, version: 0,
      });
    }
    return { ctx, wi, oid };
  };

  it("J1. canonical ceiling=0 + absent auto-policy: spend-bearing replan admission hard-blocks ZERO_BUDGET", () => {
    const { ctx, wi } = lineageWithObjective("j1", { ceiling_microusd: 0 });
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j1", work_item_id: wi,
        est_microusd: 1, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_ZERO_BUDGET" }) as never,
    );
    expect(ctx.store.list("cost_reservation")).toHaveLength(0);
  });

  it("J2. canonical ceiling=0 + POSITIVE auto-policy cap: the objective hard-block wins — the cap cannot loosen it", () => {
    const { ctx, wi } = lineageWithObjective("j2", { ceiling_microusd: 0 }, 500_000);
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j2", work_item_id: wi,
        est_microusd: 100, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_ZERO_BUDGET" }) as never,
    );
    expect(ctx.store.list("cost_reservation")).toHaveLength(0);
  });

  it("J3. canonical ceiling=0 + provable $0 envelope: explicitly-authorized continuation admits a 0µUSD reservation", () => {
    const { ctx, wi } = lineageWithObjective("j3", { ceiling_microusd: 0 });
    const out = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j3", work_item_id: wi,
      est_microusd: 0, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(out.reservation_id).toBe("CRSV_PLN_PRN_j3");
    const r = ctx.store.get("cost_reservation", "CRSV_PLN_PRN_j3");
    expect(Number(r.reserved_microusd)).toBe(0);
    expect(String(r.status)).toBe("HELD");
  });

  it("J4. canonical ceiling=0 + unbounded envelope: an unprovable charge is spend-bearing → ZERO_BUDGET blocks", () => {
    const { ctx, wi } = lineageWithObjective("j4", { ceiling_microusd: 0 });
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j4", work_item_id: wi,
        est_microusd: 0, unbounded_unknown: true, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_ZERO_BUDGET" }) as never,
    );
  });

  it("J5. positive ceiling — exhausted / insufficient remaining: consumed+est>ceiling → BUDGET_EXCEEDED", () => {
    const { ctx, wi } = lineageWithObjective("j5", {
      ceiling_microusd: 1_000, consumed_microusd: 900,
    });
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j5a", work_item_id: wi,
        est_microusd: 200, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
    // Remaining headroom (100) exactly fits a 100µ envelope.
    const ok = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j5b", work_item_id: wi,
      est_microusd: 100, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(ok.scope).toBe("UNCAPPED");
  });

  it("J6. unbounded envelope under a positive canonical ceiling cannot be proven within remaining → UNVERIFIED", () => {
    const { ctx, wi } = lineageWithObjective("j6", { ceiling_microusd: 1_000_000 });
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j6", work_item_id: wi,
        est_microusd: 10, unbounded_unknown: true, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED" }) as never,
    );
  });

  it("J7. budget changed mid-generation: admission re-reads the canonical budget at reserve time", () => {
    const { ctx, wi, oid } = lineageWithObjective("j7", { ceiling_microusd: 1_000_000 });
    const first = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j7a", work_item_id: wi,
      est_microusd: 100, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(first.scope).toBe("UNCAPPED");
    // The canonical budget authority moves to zero while a SECOND
    // generation is still in flight — the next admission re-proves.
    const obj = ctx.store.get("objective", oid);
    ctx.store.put("objective", oid, {
      ...obj,
      budget: { ceiling_microusd: 0, consumed_microusd: 0 },
    }, Number(obj.version));
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j7b", work_item_id: wi,
        est_microusd: 50, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_ZERO_BUDGET" }) as never,
    );
  });

  /* AUDIT R3 — outstanding planner reservations encumber the canonical
   * ceiling: consumed alone is NOT the used budget. Two 80µ admissions
   * under ceiling=100 must not both pass (160 combined). */
  it("J8. R3 — canonical ceiling=100, no auto-policy cap: A reserves 80, B's 80 rejected before any model invocation", () => {
    const { ctx, wi } = lineageWithObjective("j8", { ceiling_microusd: 100 });
    const a = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j8a", work_item_id: wi,
      est_microusd: 80, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(a.reservation_id).toBe("CRSV_PLN_PRN_j8a");
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j8b", work_item_id: wi,
        est_microusd: 80, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
    // B never reserved — rejection happened at admission, before any
    // model invocation could run.
    expect(ctx.store.list("cost_reservation")).toHaveLength(1);
  });

  it("J9. R3 — settled spend already inside canonical consumed is not double-counted; RELEASED frees its encumbrance", () => {
    const { ctx, wi, oid } = lineageWithObjective("j9", { ceiling_microusd: 100 });
    const a = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j9a", work_item_id: wi,
      est_microusd: 80, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    ctx.service.cost.settlePlannerInvocation(String(a.reservation_id), "CALLS_MADE", 80);
    // The settled 80 becomes canonical consumed spend (event + ledger
    // digest + row) — the only spend authority. The canonical
    // correlation is spend_key === reservation_id: accountBudget is
    // key-idempotent, so the reservation id IS the idempotent key.
    const obj = ctx.store.get("objective", oid);
    ctx.store.put("objective", oid, {
      ...obj,
      budget: { ceiling_microusd: 100, consumed_microusd: 80 },
      applied_spend_keys: [
        { key: "CRSV_PLN_PRN_j9a", digest: spendSemantics(oid, { spend_key: "CRSV_PLN_PRN_j9a", amount_microusd: 80 }) },
      ],
    }, Number(obj.version));
    ctx.store.event({
      entity_type: "objective", entity_id: oid,
      event_type: "OBJECTIVE_BUDGET_ACCOUNTED", actor: "TEST",
      metadata: { spend_key: "CRSV_PLN_PRN_j9a", amount_microusd: 80, consumed_microusd: 80 },
    });
    // Only 20µ remains. The settled reservation must NOT be counted a
    // second time — 80+80+20 would wrongly exceed the ceiling.
    const b = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j9b", work_item_id: wi,
      est_microusd: 20, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(b.reservation_id).toBe("CRSV_PLN_PRN_j9b");
    // A RELEASED reservation frees its encumbrance — C fits the last 20.
    ctx.service.cost.settlePlannerInvocation("CRSV_PLN_PRN_j9b", "NO_CALLS");
    const c = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j9c", work_item_id: wi,
      est_microusd: 20, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(c.reservation_id).toBe("CRSV_PLN_PRN_j9c");
    // But a fourth 1µ pushes consumed+outstanding over the ceiling.
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j9d", work_item_id: wi,
        est_microusd: 1, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
  });

  it("J10. R3 — a COMMITTED (usage unknown) reservation still encumbers at its reserved bound", () => {
    const { ctx, wi } = lineageWithObjective("j10", { ceiling_microusd: 100 });
    const a = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j10a", work_item_id: wi,
      est_microusd: 80, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    // CALLS_MADE without proven actuals → COMMITTED at reserved bound.
    ctx.service.cost.settlePlannerInvocation(String(a.reservation_id), "CALLS_MADE");
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j10b", work_item_id: wi,
        est_microusd: 30, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
  });

  /* AUDIT R3-final — SETTLED accounting gap: settlePlannerInvocation can
   * mark a reservation SETTLED without ANY canonical spend evidence
   * landing in consumed_microusd. The liability is real: it must still
   * encumber the ceiling until proven accounted (spend_key =
   * reservation_id in the canonical OBJECTIVE_BUDGET_ACCOUNTED chain). */
  it("J11. R3-final — SETTLED but not canonically accounted: A settles 80 with consumed still 0 → B's 80 rejected", () => {
    const { ctx, wi } = lineageWithObjective("j11", { ceiling_microusd: 100 });
    const a = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j11a", work_item_id: wi,
      est_microusd: 80, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    // Actual cost 80µ settles — but no OBJECTIVE_BUDGET_ACCOUNTED event
    // ever lands: canonical consumed stays 0 while the liability is real.
    ctx.service.cost.settlePlannerInvocation(String(a.reservation_id), "CALLS_MADE", 80);
    expect(String(ctx.store.get("cost_reservation", "CRSV_PLN_PRN_j11a").status)).toBe("SETTLED");
    const obj = ctx.store.get("objective", `OBJ_j11`);
    expect(Number((obj.budget as Record<string, unknown>).consumed_microusd)).toBe(0);
    // B must NOT be admitted — 80 settled-but-unaccounted + 80 est = 160.
    expect(() =>
      ctx.service.cost.admitPlannerInvocation({
        planner_run_id: "PRN_j11b", work_item_id: wi,
        est_microusd: 80, unbounded_unknown: false, candidates: 1,
        actor: "TEST",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED" }) as never,
    );
    expect(ctx.store.list("cost_reservation")).toHaveLength(1);
    // A 20µ envelope still fits the remaining proven headroom — the
    // liability retains exactly its settled amount, no more.
    const c = ctx.service.cost.admitPlannerInvocation({
      planner_run_id: "PRN_j11c", work_item_id: wi,
      est_microusd: 20, unbounded_unknown: false, candidates: 1,
      actor: "TEST",
    });
    expect(c.reservation_id).toBe("CRSV_PLN_PRN_j11c");
  });
});
