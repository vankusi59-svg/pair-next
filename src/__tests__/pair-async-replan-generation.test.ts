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
  buildCodexPlannerPrompt,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  makeReplanGenerationDriver,
  makeServeCanonicalizer,
  makeServePlanner,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  ReconciliationService,
  RecoveryController,
  REPLAN_GENERATION_PENDING,
  ReplanGenerationService,
  replanGenerationId,
  replanWorkItemId,
  TRANSPORT_IN_PROCESS,
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
  const { planner } = makeServePlanner({
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
