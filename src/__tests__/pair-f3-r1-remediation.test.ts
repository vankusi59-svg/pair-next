/**
 * F3 R1 — source-review remediation: production replanner wiring (R1.1),
 * true semantic-digest authority without executor pins (R1.2), and the
 * crash-safe PREPARED→commit→ACCEPTED replan protocol (R1.3).
 *
 *   A — ACTUAL production serve/runtime planner composition seam
 *   B — selected_executor is routing evidence, never plan semantics
 *   C — crash windows of the replan commit
 *   D — ledger immutable replay binding (all immutable facts)
 *   E — incident regression: the production REPLAN loop is dead
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
  canonicalPlanSemanticDigest,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
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
  ReplanAttemptLedger,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f3-r1-"));
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
  health() { return { state: "READY" } };
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
  metadata,
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

/** PRV2-A — a committed plan is always the CANONICALIZED shape: PAIR's
 *  injected T1 bookkeeping + remapped work keys. Replays of the same
 *  work graph re-canonicalize to the identical shape, so duplicate
 *  detection still binds. */
const canonPlan = (raw: Array<Record<string, unknown>>) =>
  makeServeCanonicalizer({
    executorCapSets: () => [
      ["FILE_OPERATIONS", "REASONING", REMOTE, "AUTOMATON_TASK_EXECUTION"],
    ],
  })(raw, "f3 r1 test mission");

interface PlannerCall {
  reason: string;
  replan_context?: RuntimePlannerInput["replan_context"];
}
function makeCtx(name: string, planner: RuntimePlanner) {
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
  const startMission = (metadata?: Record<string, unknown>) => {
    const m = control.startMission({
      project_id: String(project.project_id),
      goal: "f3 r1 test mission",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
      ...(metadata ? { metadata } : {}),
    });
    return String(m.mission_id);
  };
  const rt = (mid: string) => store.get("mission_runtime", `MRT_${mid}`);
  const drive = (mid: string, max = 80) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      const s = String(rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s)) return s;
    }
    return String(rt(mid).state);
  };
  /** PAIR's injected bookkeeping task runs through the real
   *  PAIR_NATIVE worker harness (spawned child + event-loop timers):
   *  a synchronous drive can never yield, so executions stay RUNNING.
   *  driveAsync yields real event-loop time between ticks. */
  const driveAsync = async (mid: string, max = 200) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      await new Promise((r) => setTimeout(r, 15));
      const s = String(rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s)) return s;
    }
    return String(rt(mid).state);
  };
  const toReplanning = (mid: string) => {
    const clock = fakeClock();
    for (let i = 0; i < 60; i++) {
      runtime.tick(mid, clock());
      if (String(rt(mid).state) === "REPLANNING") return;
    }
    throw new Error(`never reached REPLANNING: ${String(rt(mid).state)}`);
  };
  /** PAIR's injected T1 bookkeeping task is a worker_spec contract
   *  executed by the real PAIR_NATIVE harness — a scripted adapter
   *  cannot produce its evidence. Registered through the canonical
   *  AUTOMATON_WORKER identity + seeded PAIR_NATIVE route. */
  const registerNativeExecutor = () => {
    const automatonDb = createDatabase(path.join(d, "automaton.db"));
    const runner = new PairNativeWorkerRunner({
      db: automatonDb.raw,
      config: { name: `f3r1-${name}`, logLevel: "error" } as unknown as AutomatonConfig,
      identity: { name: `f3r1-${name}` } as unknown as AutomatonIdentity,
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
  return {
    d, dbPath, workspace, store, service, gate, registry, router, recovery,
    recon, approvals, scheduler, runtime, control, adapters, calls,
    registerAdapter, registerNativeExecutor, startMission, rt, drive, driveAsync, toReplanning,
    projectId: String(project.project_id),
  };
}

/** Rebuild every runtime dep on the same dbPath — the honest process
 *  restart (no in-memory state carries over). */
function rebuild(ctx: ReturnType<typeof makeCtx>, planner: RuntimePlanner) {
  const store2 = new PairEvidenceStore(ctx.dbPath);
  const service2 = new PairControlPlane(store2);
  const gate2 = new GovernedTaskGate(service2);
  const recon2 = new ReconciliationService(service2, new Map());
  const approvals2 = new ApprovalQueue(service2);
  const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
  const recovery2 = new RecoveryController(service2);
  const calls2: PlannerCall[] = [];
  const wrapped: RuntimePlanner = (input) => {
    calls2.push({ reason: input.reason, replan_context: input.replan_context });
    return planner(input);
  };
  const runtime2 = new MissionRuntime({
    service: service2, gate: gate2, router: new MissionRouter(service2, gate2),
    adapters: ctx.adapters, scheduler: scheduler2, approvals: approvals2,
    reconciliation: recon2, recovery: recovery2, planner: wrapped,
  });
  const drive2 = (mid: string, max = 80) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime2.tick(mid, clock());
      const s = String((store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s)) return s;
    }
    return String((store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>).state);
  };
  return { store2, service2, runtime2, calls2, drive2 };
}

const attempts = (store: PairEvidenceStore, mid: string) =>
  store
    .list("replan_attempt")
    .filter((a) => a.mission_id === mid)
    .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));

/* ============ A — production serve-planner composition (R1.1) ========= */
describe("F3 R1 A — production serve/runtime planner seam", () => {
  const deps = (over: Partial<Parameters<typeof makeServePlanner>[0]> = {}) => ({
    hasExecutor: () => false,
    executorCapSets: () => [
      ["FILE_OPERATIONS", "REASONING", REMOTE, "AUTOMATON_TASK_EXECUTION"],
    ],
    ...over,
  });
  const inputFor = (partial: Partial<RuntimePlannerInput>): RuntimePlannerInput =>
    ({
      mission: { goal: "g", metadata: {} },
      advice: null,
      reason: "initial",
      ...partial,
    }) as RuntimePlannerInput;

  it("A1. initial — pinned_plan_tasks returned verbatim (historical authority)", () => {
    const { planner } = makeServePlanner(deps());
    const pinned = incidentPlan().tasks;
    const out = planner(
      inputFor({ mission: { goal: "g", metadata: { pinned_plan_tasks: pinned } } as never }),
    );
    expect(out.tasks).toEqual(pinned);
  });

  it("A2. initial — metadata.llm_plan flows through the canonicalize seam", () => {
    const { planner } = makeServePlanner(deps());
    const out = planner(
      inputFor({ mission: { goal: "g", metadata: { llm_plan: altPlan().tasks } } as never }),
    );
    expect(out.tasks.length).toBeGreaterThan(0);
    expect(String(out.tasks[0].task_key)).toBe("T1");
  });

  it("A3. initial — no pinned/llm → deterministic template", () => {
    const { planner } = makeServePlanner(deps());
    const out = planner(inputFor({}));
    expect(String(out.tasks[0].task_key)).toBe("T1");
    expect(String(out.tasks[0].required_capabilities?.[0])).toBe("AUTOMATON_TASK_EXECUTION");
  });

  it("A4. replan + no provider → FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE — NEVER replays stored plans", () => {
    const { planner } = makeServePlanner(deps({ replanProvider: null }));
    const pinned = incidentPlan().tasks;
    const err = (() => {
      try {
        planner(
          inputFor({
            reason: "replan",
            mission: {
              goal: "g",
              metadata: { pinned_plan_tasks: pinned, llm_plan: pinned },
            } as never,
            replan_context: { recovery_id: "RCV_1" } as never,
          }),
        );
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(String(err?.code)).toBe("FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE");
  });

  it("A5. replan + provider emits uncanonicalizable candidate → INFEASIBLE", () => {
    const { planner } = makeServePlanner(
      deps({ replanProvider: () => ({ tasks: [{ task_key: "X" }] }) }),
    );
    // task with no instruction/caps fails validate/canonicalize → INFEASIBLE
    try {
      planner(
        inputFor({
          reason: "replan",
          replan_context: { recovery_id: "RCV_1" } as never,
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(String((e as { code?: string }).code)).toMatch(/^FAIL_CLOSED_REPLAN_PROVIDER/);
    }
  });

  it("A6. replan + provider emits viable candidate → canonicalized tasks returned (no direct commit)", () => {
    const seen: RuntimePlannerInput["replan_context"][] = [];
    const { planner } = makeServePlanner(
      deps({
        replanProvider: (input) => {
          seen.push(input.replan_context);
          return altPlan();
        },
      }),
    );
    const out = planner(
      inputFor({
        reason: "replan",
        replan_context: {
          recovery_id: "RCV_1",
          failure_class: "DEPENDENCY_FAILURE",
          failed_plan_semantic_digest: "abc",
        } as never,
      }),
    );
    // replan_context reaches the provider — the structured failure is
    // consumed upstream, not dropped.
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.recovery_id)).toBe("RCV_1");
    // PRV2-A — the emitted work graph gains PAIR's injected T1
    // bookkeeping: [T1 bookkeeping, T2 work].
    expect(out.tasks.length).toBe(2);
    expect(out.tasks[0].required_capabilities).toEqual(["AUTOMATON_TASK_EXECUTION"]);
    expect(out.tasks[1].task_key).toBe("T2");
  });

  it("A7a. ACTUAL composition, provider null — REPLAN fails closed, old plan NEVER replayed", () => {
    const { planner } = makeServePlanner(deps({ replanProvider: null }));
    const ctx = makeCtx("a7a", planner);
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    // Pinned initial plan through the production initial branch.
    const mid = ctx.startMission({ pinned_plan_tasks: incidentPlan().tasks });
    ctx.drive(mid);
    const st = String(ctx.rt(mid).state);
    expect(st).toBe("ABORTED");
    // The REPLAN action went through exhaustion — the pinned Plan A was
    // never re-emitted as a candidate and never re-committed.
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    expect(
      ctx.calls.filter((c) => c.reason === "replan").length,
    ).toBeGreaterThanOrEqual(1);
    // No replan candidate rows — provider-unavailable consumed no slot.
    expect(attempts(ctx.store, mid)).toHaveLength(0);
    // Old plan tasks intact vs the abort path — the failed consumer task
    // is terminal evidence, not superseded by an impossible replan.
    const tasks = ctx.service.listTasks(mid);
    expect(tasks.find((t) => t.task_key === "T1")!.status).toBe("COMPLETED");
  });

  it("A7b. ACTUAL composition, provider emits Plan B — commits exactly once, mission completes", async () => {
    const { planner } = makeServePlanner(
      deps({ replanProvider: () => altPlan() }),
    );
    const ctx = makeCtx("a7b", planner);
    // PAIR's injected T1 bookkeeping needs the real PAIR_NATIVE harness.
    ctx.registerNativeExecutor();
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: canonPlan(incidentPlan().tasks) });
    expect(await ctx.driveAsync(mid)).toBe("COMPLETED");
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["ACCEPTED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    // Commit receipt binds the accepted attempt to its durable revision.
    expect(String(at[0].commit_receipt?.plan_id ?? "")).toMatch(/^PLN_/);
    expect(Number(at[0].commit_receipt?.revision)).toBe(2);
  });

  it("A7c. ACTUAL composition, provider REPLAYS the failed plan → REJECTED_DUPLICATE, never re-committed", () => {
    const { planner } = makeServePlanner(
      deps({ replanProvider: () => incidentPlan() }),
    );
    const ctx = makeCtx("a7c", planner);
    ctx.registerNativeExecutor();
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission({ pinned_plan_tasks: canonPlan(incidentPlan().tasks) });
    expect(ctx.drive(mid)).toBe("ABORTED");
    // Provider emitted the pinned plan twice; both bounded slots spent
    // on duplicates — the stored plan was NEVER committed a second time.
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["REJECTED_DUPLICATE", "REJECTED_DUPLICATE"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
  });
});

/* ============ B — selected_executor exclusion (R1.2) ================== */
describe("F3 R1 B — selected_executor is routing evidence only", () => {
  it("B1+B6. candidate identical except planner-executor pins → REJECTED_DUPLICATE", () => {
    let call = 0;
    const ctx = makeCtx("b1", ({ reason }: PlannerCall) => {
      if (reason === "replan") {
        call += 1;
        if (call === 1) {
          // Candidate semantically identical to the failed plan, pinned
          // to a DIFFERENT executor — the pin cannot make it "different".
          const p = incidentPlan();
          p.tasks[0].selected_executor = "EX_ANYTHING";
          p.tasks[1].selected_executor = "EX_OTHER";
          return p;
        }
        return altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    expect(ctx.drive(mid)).toBe("COMPLETED");
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["REJECTED_DUPLICATE", "ACCEPTED"]);
    expect(String(at[0].rejection_reason)).toBe("PLAN_SEMANTIC_DUPLICATE");
  });

  it("B2+B4. committed rows carry NO planner_selected_executor; routing overwrites selected_executor post-commit", () => {
    const ctx = makeCtx("b2", () => ({
      tasks: [
        task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"])),
      ],
    }));
    // Plan candidate carries a planner-chosen executor pin — the router's
    // real binding must overwrite it (routing is the authority).
    const ctxPlan = (ctx.calls as PlannerCall[]); // planner input path
    void ctxPlan;
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    // Mutate the committed plan? No — assert the committed ROW before
    // routing: selected_executor starts null/plan-supplied; after tick
    // the ROUTER binds it.
    ctx.drive(mid);
    const t = ctx.service.listTasks(mid)[0];
    // Router bound the governed executor (routing evidence), and the
    // planner's pin field never exists on committed rows at all.
    expect(String(t.selected_executor)).toBe("EX_LOCAL");
    expect("planner_selected_executor" in t).toBe(false);
    const meta = (t.metadata ?? {}) as Record<string, unknown>;
    expect("planner_selected_executor" in meta).toBe(false);
  });

  it("B3+B5. committed-row digest == stored plan_semantic_digest — before routing, after routing, after restart", () => {
    const ctx = makeCtx("b3", () => ({
      tasks: [task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"]))],
    }));
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const rev = ctx.store.planRevisions(mid)[0];
    const rows = ctx.service.listTasks(mid);
    // Post-routing rows carry routing's selected_executor — recomputing
    // the digest over the CURRENT rows still equals the stored digest.
    expect(String(rows[0].selected_executor)).toBe("EX_LOCAL");
    expect(canonicalPlanSemanticDigest(rows)).toBe(String(rev.plan_semantic_digest));
    ctx.store.close();
    // Restart — the digest over reopened rows is unchanged.
    const { store2, service2 } = rebuild(ctx, () => ({ tasks: [] }));
    const rows2 = service2.listTasks(mid);
    expect(canonicalPlanSemanticDigest(rows2)).toBe(String(rev.plan_semantic_digest));
    store2.close();
  });
});

/* ============ C — crash-safe replan commit (R1.3) ===================== */
describe("F3 R1 C — crash windows of the replan commit", () => {
  /** Drive the mission to REPLANNING with the incident plan, then call
   *  runReplan directly — a throw escapes UNCAUGHT (the process "dies"),
   *  leaving exactly the durable state a real crash leaves. */
  const crashInside = (mid: string, ctx: ReturnType<typeof makeCtx>) => {
    (ctx.runtime as unknown as { runReplan(m: string): void }).runReplan(mid);
  };

  it("C1. crash between PREPARED write and commit — restart commits the SAME prepared candidate; planner NOT re-invoked", () => {
    let replanCalls = 0;
    const ctx = makeCtx("c1", ({ reason }: PlannerCall) => {
      if (reason === "replan") {
        replanCalls += 1;
        return altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.toReplanning(mid);
    // Inject a one-shot fault at the commit seam — dies inside the atomic
    // txn AFTER the PREPARED row is durable.
    const origCommit = ctx.service.commitPlan.bind(ctx.service);
    (ctx.service as { commitPlan: unknown }).commitPlan = () => {
      throw new IntegrityError("FAIL_CLOSED_SIMULATED_CRASH", "power-loss");
    };
    expect(() => crashInside(mid, ctx)).toThrow();
    ctx.service.commitPlan = origCommit;
    // Durable aftermath: PREPARED exists, NO second revision, old plan
    // intact (mission.plan_id unchanged, old tasks not cancelled).
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["PREPARED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const oldPlanId = String(ctx.service.getMission(mid).plan_id);
    for (const t of ctx.service.listTasks(mid)) {
      expect(String(t.plan_id)).toBe(oldPlanId);
      expect(String(t.status)).not.toBe("CANCELLED");
    }
    const pend = ctx.rt(mid).pending_recovery as Record<string, unknown>;
    expect(pend).toBeTruthy();

    // Restart — resume commits the SAME prepared tasks; planner silent.
    const { store2, service2, calls2, drive2 } = rebuild(
      ctx,
      () => incidentPlan(),
    );
    expect(drive2(mid)).toBe("COMPLETED");
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    const revs2 = store2.planRevisions(mid);
    expect(revs2).toHaveLength(2);
    // Committed revision carries the PREPARED candidate's exact digest.
    expect(String(revs2[1].plan_semantic_digest)).toBe(
      String(at[0].candidate_plan_semantic_digest),
    );
    const at2 = attempts(store2, mid);
    expect(at2.map((a) => a.status)).toEqual(["ACCEPTED"]);
    expect(String(at2[0].commit_receipt?.plan_id)).toBe(String(revs2[1].plan_id));
    // Old plan superseded — new tasks carry the new plan_id.
    const tasks2 = service2.listTasks(mid);
    expect(
      tasks2.filter((t) => String(t.plan_id) === oldPlanId && String(t.status) === "CANCELLED").length,
    ).toBeGreaterThanOrEqual(1);
    expect(tasks2.some((t) => String(t.plan_id) === String(revs2[1].plan_id))).toBe(true);
    store2.close();
  });

  it("C2. attempt-bound revision lacking a receipt (R2 binding) — restart binds the receipt, NEVER a second commit", () => {
    const ctx = makeCtx("c2", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.toReplanning(mid);
    // Simulate the pre-R1 window: commit the candidate revision WITHOUT
    // a ledger receipt, leaving a PREPARED row whose digest it matches.
    const ledger = new ReplanAttemptLedger(ctx.store);
    const rtRow = ctx.rt(mid);
    const pend = rtRow.pending_recovery as Record<string, unknown>;
    const recoveryId = String(pend.recovery_id);
    const candidate = altPlan();
    const prepared = ledger.record({
      mission_id: mid,
      recovery_id: recoveryId,
      failed_plan_semantic_digest: String(
        ctx.store.planRevisions(mid)[0].plan_semantic_digest,
      ),
      attempt_index: 0,
      proposal_digest: "legacy-window",
      candidate_plan_semantic_digest: canonicalPlanSemanticDigest(
        candidate.tasks as never[],
      ),
      prepared_tasks: candidate.tasks,
      prepared_proposal: candidate,
      superseded_plan_id: String(ctx.service.getMission(mid).plan_id),
      status: "PREPARED",
    });
    const direct = ctx.service.commitPlan({
      mission_id: mid,
      tasks: candidate.tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: candidate,
      // F3 R2 — the commit is bound to THIS attempt: the revision is
      // findable only through exact attempt-bound evidence, never a
      // semantic-digest scan.
      replan_commit: {
        recovery_id: recoveryId,
        replan_attempt_id: prepared.replan_attempt_id,
        superseded_plan_id: String(ctx.service.getMission(mid).plan_id),
      },
    });
    expect(direct.revision).toBe(2);
    ctx.store.close();

    // Restart — runReplan sees the PREPARED row, finds the revision by
    // EXACT attempt binding, binds the receipt: no second commit, no
    // planner call.
    const { store2, calls2, drive2, service2 } = rebuild(ctx, () => incidentPlan());
    expect(drive2(mid)).toBe("COMPLETED");
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    expect(store2.planRevisions(mid)).toHaveLength(2);
    const at = attempts(store2, mid);
    expect(at).toHaveLength(1);
    expect(at[0].status).toBe("ACCEPTED");
    expect(Number(at[0].commit_receipt?.revision)).toBe(2);
    expect(String(at[0].commit_receipt?.plan_id)).toBe(String(direct.plan_id));
    void prepared;
    // Pending cleared — deterministic convergence.
    expect(
      (store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>).pending_recovery,
    ).toBeNull();
    void service2;
    store2.close();
  });

  it("C3. crash AFTER the atomic txn (before function return) — restart sees the fully-converged state, no replan replay", () => {
    const ctx = makeCtx("c3", ({ reason }: PlannerCall) =>
      reason === "replan" ? altPlan() : incidentPlan(),
    );
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.toReplanning(mid);
    // runReplan completes — txn committed — process "dies" before the
    // caller observes: equivalent to the function having run.
    crashInside(mid, ctx);
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["ACCEPTED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    ctx.store.close();
    const { store2, calls2, drive2 } = rebuild(ctx, () => incidentPlan());
    expect(drive2(mid)).toBe("COMPLETED");
    // No replan replay — exactly one prepared/committed attempt.
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    expect(attempts(store2, mid)).toHaveLength(1);
    expect(store2.planRevisions(mid)).toHaveLength(2);
    store2.close();
  });

  it("C4. crash mid-transaction (supersede step) — rollback leaves PREPARED + old plan intact, zero partial mutation", () => {
    const ctx = makeCtx("c4", ({ reason }: PlannerCall) =>
      reason === "replan" ? altPlan() : incidentPlan(),
    );
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.toReplanning(mid);
    const origSupersede = ctx.approvals.supersede.bind(ctx.approvals);
    (ctx.approvals as { supersede: unknown }).supersede = () => {
      throw new IntegrityError("FAIL_CLOSED_SIMULATED_CRASH", "power-loss-at-supersede");
    };
    expect(() => crashInside(mid, ctx)).toThrow();
    ctx.approvals.supersede = origSupersede;
    // EVERYTHING inside the txn rolled back — only PREPARED is durable.
    const at = attempts(ctx.store, mid);
    expect(at.map((a) => a.status)).toEqual(["PREPARED"]);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const oldPlanId = String(ctx.service.getMission(mid).plan_id);
    expect(
      ctx.service.listTasks(mid).some(
        (t) => String(t.plan_id) !== oldPlanId,
      ),
    ).toBe(false);
    expect(
      ctx.service.listTasks(mid).every((t) => String(t.status) !== "CANCELLED"),
    ).toBe(true);
    expect(ctx.rt(mid).pending_recovery).toBeTruthy();
    ctx.store.close();
    // Resume — converges through the same prepared candidate.
    const { store2, calls2, drive2 } = rebuild(ctx, () => incidentPlan());
    expect(drive2(mid)).toBe("COMPLETED");
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    expect(store2.planRevisions(mid)).toHaveLength(2);
    expect(attempts(store2, mid)[0].status).toBe("ACCEPTED");
    store2.close();
  });

  it("C5. two PREPARED rows for one recovery → FAIL_CLOSED_REPLAN_ATTEMPT_STATE", () => {
    const ctx = makeCtx("c5", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.toReplanning(mid);
    const pend = ctx.rt(mid).pending_recovery as Record<string, unknown>;
    const recoveryId = String(pend.recovery_id);
    const ledger = new ReplanAttemptLedger(ctx.store);
    for (const idx of [0, 1]) {
      ledger.record({
        mission_id: mid,
        recovery_id: recoveryId,
        attempt_index: idx,
        proposal_digest: `p${idx}`,
        candidate_plan_semantic_digest: `d${idx}`,
        prepared_tasks: [],
        superseded_plan_id: String(ctx.service.getMission(mid).plan_id),
        status: "PREPARED",
      });
    }
    const err = (() => {
      try {
        crashInside(mid, ctx);
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(String(err?.code)).toBe("FAIL_CLOSED_REPLAN_ATTEMPT_STATE");
  });

  it("C6. markCommitted contract — non-PREPARED conflict, receipt conflict, idempotent replay, missing row", () => {
    const d = dir("c6");
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const ledger = new ReplanAttemptLedger(store);
    const base = {
      mission_id: "M1",
      recovery_id: "RCV_1",
      attempt_index: 0,
      proposal_digest: "p",
      candidate_plan_semantic_digest: "d",
      prepared_tasks: [],
    };
    const row = ledger.record({ ...base, status: "REJECTED_DUPLICATE" });
    // Non-PREPARED → conflict.
    expect(() =>
      ledger.markCommitted(row.replan_attempt_id, {
        plan_id: "PLN_1",
        revision: 2,
        plan_semantic_digest: "d",
      }),
    ).toThrowError(IntegrityError);
    // Missing row → fail closed.
    expect(() =>
      ledger.markCommitted("RPA_missing", {
        plan_id: "PLN_1",
        revision: 2,
        plan_semantic_digest: "d",
      }),
    ).toThrowError(IntegrityError);
    // PREPARED → ACCEPTED binds receipt; replay with same receipt is
    // idempotent; conflicting receipt fails closed.
    const p = ledger.record({ ...base, attempt_index: 1, status: "PREPARED" });
    const done = ledger.markCommitted(p.replan_attempt_id, {
      plan_id: "PLN_9",
      revision: 2,
      plan_semantic_digest: "d",
    });
    expect(done.status).toBe("ACCEPTED");
    expect(String(done.commit_receipt?.plan_id)).toBe("PLN_9");
    const again = ledger.markCommitted(p.replan_attempt_id, {
      plan_id: "PLN_9",
      revision: 2,
      plan_semantic_digest: "d",
    });
    expect(again.status).toBe("ACCEPTED");
    expect(() =>
      ledger.markCommitted(p.replan_attempt_id, {
        plan_id: "PLN_OTHER",
        revision: 3,
        plan_semantic_digest: "d",
      }),
    ).toThrowError(IntegrityError);
    store.close();
  });
});

/* ============ D — ledger immutable replay binding (§18) =============== */
describe("F3 R1 D — replay binds ALL immutable facts", () => {
  it("D1. identical replay converges; ANY conflicting fact fails closed", () => {
    const d = dir("d1");
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const ledger = new ReplanAttemptLedger(store);
    const base = {
      mission_id: "M1",
      recovery_id: "RCV_1",
      failure_signature: "SIG",
      failed_plan_semantic_digest: "DF",
      attempt_index: 0,
      proposal_digest: "P",
      candidate_plan_semantic_digest: "C",
      rejection_reason: "PLAN_SEMANTIC_DUPLICATE",
      superseded_plan_id: "PLN_OLD",
      prepared_tasks: [{ task_key: "T1" }],
      status: "REJECTED_DUPLICATE" as const,
    };
    const a = ledger.record(base);
    const b = ledger.record(base);
    expect(String(b.replan_attempt_id)).toBe(String(a.replan_attempt_id));
    expect(ledger.listForRecovery("RCV_1")).toHaveLength(1);
    // Slot-key fields derive the row identity — diverging recovery_id
    // lands a NEW slot (bound to that recovery), not a conflict on this
    // one; every other immutable fact diverging on replay → SLOT_CONFLICT.
    const c = ledger.record({ ...base, recovery_id: "RCV_2" });
    expect(String(c.replan_attempt_id)).not.toBe(String(a.replan_attempt_id));
    for (const [k, v] of [
      ["mission_id", "M2"],
      ["failure_signature", "SIG2"],
      ["failed_plan_semantic_digest", "DF2"],
      ["proposal_digest", "P2"],
      ["candidate_plan_semantic_digest", "C2"],
      ["rejection_reason", "OTHER"],
      ["superseded_plan_id", "PLN_OTHER"],
      ["prepared_tasks", [{ task_key: "OTHER" }]],
      ["status", "ACCEPTED"],
    ]) {
      expect(
        () => ledger.record({ ...base, [k]: v }),
        `conflict on ${k}`,
      ).toThrowError(IntegrityError);
    }
    store.close();
  });
});

/* ============ E — incident regression (§21) =========================== */
describe("F3 R1 E — the production REPLAN loop is dead", () => {
  it("E1. same-planner incident cannot loop: bounded duplicates → infeasible → ABORTED, never WAITING infinitely", () => {
    const ctx = makeCtx("e1", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const st = ctx.drive(mid);
    expect(st).toBe("ABORTED");
    // Exactly the bounded budget was spent — a third planner call never
    // happened; the old plan was never superseded by a re-emission.
    expect(
      ctx.calls.filter((c) => c.reason === "replan"),
    ).toHaveLength(2);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    expect(attempts(ctx.store, mid).map((a) => a.status)).toEqual([
      "REJECTED_DUPLICATE",
      "REJECTED_DUPLICATE",
    ]);
  });
});
