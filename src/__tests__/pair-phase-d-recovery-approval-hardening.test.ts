/**
 * POST-P14 PHASE D — recovery + approval hardening.
 *
 * A. task-scoped attempt extension grant (never widens unrelated tasks)
 * B. one APPROVED exercised exactly once (durable approval_exercise)
 * C. restart cannot re-apply the same grant
 * D. concurrent exercise → single durable winner
 * E. crash after approval request but before runtime linkage → no duplicate
 * F. TTL expiry inside WAITING_APPROVAL converges (get() alone never swept)
 * G. SUPERSEDED approval cannot wedge WAITING_APPROVAL
 * H. UNKNOWN_SIDE_EFFECT approve → barrier settled + task FAILED + no replay
 * I. UNKNOWN_SIDE_EFFECT denied → bounded terminal
 * J. Phase C DSH authority failures classify POLICY_DENIAL (not availability)
 * K. ROUTE_INFEASIBLE preserved
 * L. identical re-escalation bounded — no unlimited equivalent approvals
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ApprovalQueue,
  APPROVAL_EXERCISE_ENTITY,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  classifyFailure,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";
import type { ExecutorAdapter } from "../pair/adapter.js";

function freshDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pair-phd-${prefix}-`));
}

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  private script: Array<{ status: string; error_class?: string }>;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};

  constructor(
    id: string,
    script: Array<{ status: string; error_class?: string }> = [],
    caps: string[] = ["FILE_OPERATIONS"],
    private readonly runRoot: string | null = null,
    /** Restart-unique execution-id seed — a restarted real adapter mints
     *  fresh ids (UUID); the harness counter would collide with durable
     *  executor_execution rows from the pre-restart process. */
    private readonly idSeed = "",
  ) {
    this.executor_id = id;
    this.script = [...script];
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length
      ? this.script.shift()!
      : { status: "FAILED", error_class: "RATE_LIMITED" };
    const eid = `EXEC_${this.executor_id}_${this.idSeed}${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? {
            status: "FAILED",
            mission_id: task.mission_id,
            task_id: task.task_id,
            governed_task_id: task.governed_task_id,
            error: {
              class: step.error_class ?? "RATE_LIMITED",
              code: step.error_class ?? "RATE_LIMITED",
              message: step.error_class ?? "failed",
            },
          }
        : {
            status: step.status,
            mission_id: task.mission_id,
            task_id: task.task_id,
            governed_task_id: task.governed_task_id,
            summary: "ok",
          };
    return {
      execution_id: eid,
      status: step.status,
      run_root: this.runRoot,
      workspace: task.workspace,
    };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return (
      this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } }
    );
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

const SINGLE_TASK = [
  {
    task_key: "T1",
    title: "t1",
    required_capabilities: ["ONLY_EX_A"],
    depends_on: [] as string[],
  },
];

function makeCtx(name: string, taskList?: Array<Record<string, unknown>>) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  // Default two tasks: T1 fails/escalates; T2 depends on T1 and stays
  // READY (non-terminal) so the mission cannot complete while T1's
  // recovery chain escalates — the real WAITING_APPROVAL shape.
  const planner = () => ({
    tasks: taskList ?? [
      {
        task_key: "T1",
        title: "t1",
        required_capabilities: ["ONLY_EX_A"],
        depends_on: [],
      },
      {
        task_key: "T2",
        title: "t2",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: ["T1"],
      },
    ],
  });
  const runtime = new MissionRuntime({
    service,
    gate,
    router,
    adapters,
    scheduler,
    approvals,
    reconciliation: recon,
    recovery,
    planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service,
    runtime,
    supervisor,
    scheduler,
    approvals,
    reconciliation: recon,
    observability: new MissionObservability(service),
    planner,
  });
  service.registerCapability("ONLY_EX_A", { risk_class: "LOW" });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir,
    workspace,
    store,
    service,
    gate,
    registry,
    router,
    recovery,
    recon,
    approvals,
    scheduler,
    runtime,
    supervisor,
    control,
    adapters,
    projectId: String(project.project_id),
  };
}

function registerAdapter(
  ctx: ReturnType<typeof makeCtx>,
  adapter: ExecutorAdapter,
  caps: string[],
) {
  ctx.registry.register({
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
  ctx.service.routes.registerRoute({
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
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: caps,
  });
  ctx.adapters.set(adapter.executor_id, adapter);
}

function startMission(ctx: ReturnType<typeof makeCtx>): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "phd",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
}



function rt(ctx: ReturnType<typeof makeCtx>, missionId: string) {
  return ctx.store.get("mission_runtime", `MRT_${missionId}`);
}

const FAR = "2999-01-01T00:00:00Z";
function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

function tickUntil(
  ctx: ReturnType<typeof makeCtx>,
  mid: string,
  states: string[],
  max = 120,
) {
  const clock = fakeClock();
  for (let i = 0; i < max; i++) {
    ctx.runtime.tick(mid, clock());
    if (states.includes(String(rt(ctx, mid).state))) break;
  }
  return String(rt(ctx, mid).state);
}

/** Drive a RATE_LIMITED-failing task past the per-task attempt ceiling →
 *  WAITING_APPROVAL carrying a RECOVERY_TASK_ATTEMPT_EXTENSION intent. */
function driveToCeilingApproval(ctx: ReturnType<typeof makeCtx>) {
  const exA = new ScriptedAdapter(
    "EX_A",
    Array.from({ length: 10 }, () => ({
      status: "FAILED",
      error_class: "RATE_LIMITED",
    })),
    ["ONLY_EX_A", "FILE_OPERATIONS"],
  );
  registerAdapter(ctx, exA, exA.caps);
  // Second routable executor lacks the capability — RE_ROUTE is infeasible,
  // retries burn until the task ceiling → explicit extension approval.
  registerAdapter(ctx, new ScriptedAdapter("EX_B", []), ["FILE_OPERATIONS"]);
  const mid = startMission(ctx);
  const state = tickUntil(ctx, mid, ["WAITING_APPROVAL", "ABORTED", "FAILED"]);
  return { mid, state, exA };
}

function pendingApproval(ctx: ReturnType<typeof makeCtx>, mid: string) {
  const rows = ctx.approvals
    .listPending(mid)
    .filter((a) => a.approval_type === "RECOVERY_APPROVAL");
  expect(rows.length).toBe(1);
  return rows[0];
}

function approvePending(ctx: ReturnType<typeof makeCtx>, mid: string) {
  const a = pendingApproval(ctx, mid);
  ctx.approvals.decide(
    String(a.approval_id),
    "op",
    "APPROVED",
    a.scope_snapshot as Record<string, unknown>,
  );
  return String(a.approval_id);
}

describe("PHD A — task-scoped attempt extension", () => {
  it("A. extension grant binds to the failed task only — no unrelated widening", () => {
    const ctx = makeCtx("a");
    const { mid, state, exA } = driveToCeilingApproval(ctx);
    expect(state).toBe("WAITING_APPROVAL");
    const approval = pendingApproval(ctx, mid);
    expect(String(approval.requested_action)).toBe(
      "RECOVERY_TASK_ATTEMPT_EXTENSION",
    );
    const intent = approval.intent as Record<string, unknown>;
    const taskId = String(approval.task_id);
    expect(intent.mission_id).toBe(mid);
    expect(intent.task_id).toBe(taskId);
    expect(intent.recovery_decision_id).toBeTruthy();
    expect(intent.failure_signature).toBeTruthy();
    expect((intent.grant as Record<string, unknown>).attempts_per_task).toBe(1);

    ctx.approvals.decide(
      String(approval.approval_id),
      "op",
      "APPROVED",
      approval.scope_snapshot as Record<string, unknown>,
    );
    const dispatchesBefore = exA.dispatched.length;
    ctx.runtime.tick(mid, FAR);

    const ext = rt(ctx, mid).budget_extension as Record<string, unknown>;
    const tasks = ext.tasks as Record<string, Record<string, unknown>>;
    expect(Object.keys(tasks)).toEqual([taskId]);
    expect(tasks[taskId].attempts_per_task).toBe(1);
    // The grant anchors to attempts consumed at exercise time — the
    // escalation decision itself is a recovery_attempt, so a relative
    // ceiling would be consumed instantly and never dispatch.
    expect(tasks[taskId].baseline_attempts).toBeGreaterThan(0);
    // Mission-wide ceiling untouched by a task-scoped grant.
    expect(ext.attempts_per_mission ?? 0).toBe(0);

    // The exercised grant yields exactly one more dispatch attempt, then
    // the chain is bounded — no second approval, no runaway. The exercise
    // tick anchors the fresh chain's dueAt at `now`; ticks must keep
    // advancing past it (a stale or rewound clock stalls the retry).
    let final = String(rt(ctx, mid).state);
    for (
      let t = Date.parse(FAR), i = 0;
      i < 200 && !["ABORTED", "FAILED"].includes(final);
      i++, t += 120_000
    ) {
      ctx.runtime.tick(mid, new Date(t).toISOString());
      final = String(rt(ctx, mid).state);
    }
    expect(exA.dispatched.length).toBe(dispatchesBefore + 1);
    expect(final).toBe("ABORTED");
    expect(
      ctx.approvals
        .list()
        .filter((a) => a.approval_type === "RECOVERY_APPROVAL").length,
    ).toBe(1);
  });
});

describe("PHD B/C/D — exactly-once exercise", () => {
  it("B. one APPROVED produces exactly one durable exercise + one grant", () => {
    const ctx = makeCtx("b");
    const { mid } = driveToCeilingApproval(ctx);
    const approvalId = approvePending(ctx, mid);
    ctx.runtime.tick(mid, FAR);
    ctx.runtime.tick(mid, FAR);
    const exercised = ctx.approvals.listExercised({ mission_id: mid });
    expect(exercised.length).toBe(1);
    expect(String(exercised[0].approval_id)).toBe(approvalId);
    const taskId = String(exercised[0].task_id);
    const tasks = (rt(ctx, mid).budget_extension as Record<string, unknown>)
      .tasks as Record<string, { attempts_per_task: number }>;
    expect(tasks[taskId].attempts_per_task).toBe(1);
  });

  it("C. restart re-tick cannot re-apply the grant", () => {
    const ctx = makeCtx("c");
    const { mid } = driveToCeilingApproval(ctx);
    const approvalId = approvePending(ctx, mid);
    ctx.runtime.tick(mid, FAR);
    // Simulate restart: reopen the SAME db under a fresh runtime.
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const router2 = new MissionRouter(service2, gate2);
    const recovery2 = new RecoveryController(service2);
    const recon2 = new ReconciliationService(service2, new Map());
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const exA2 = new ScriptedAdapter(
      "EX_A",
      [{ status: "COMPLETED" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
      null,
      "r2_",
    );
    const adapters2 = new Map<string, ExecutorAdapter>([
      ["EX_A", exA2],
      ["EX_B", new ScriptedAdapter("EX_B", [], ["FILE_OPERATIONS"])],
    ]);
    const runtime2 = new MissionRuntime({
      service: service2,
      gate: gate2,
      router: router2,
      adapters: adapters2,
      scheduler: scheduler2,
      approvals: approvals2,
      reconciliation: recon2,
      recovery: recovery2,
    });
    for (let i = 0; i < 4; i++) runtime2.tick(mid, fakeClock()());
    const exercises = store2
      .list(APPROVAL_EXERCISE_ENTITY)
      .filter((x) => x.approval_id === approvalId);
    expect(exercises.length).toBe(1);
    const rt2 = store2.get("mission_runtime", `MRT_${mid}`);
    const tasks = (rt2.budget_extension as Record<string, unknown>)
      .tasks as Record<string, { attempts_per_task: number }>;
    const taskId = String(exercises[0].task_id);
    // assignment is idempotent — still exactly +1, never +2
    expect(tasks[taskId].attempts_per_task).toBe(1);
  });

  it("D. repeated exercise of the same approval yields one durable winner", () => {
    const ctx = makeCtx("d");
    const { mid } = driveToCeilingApproval(ctx);
    const approvalId = approvePending(ctx, mid);
    const first = ctx.approvals.exercise(approvalId);
    const second = ctx.approvals.exercise(approvalId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(String(first.row.approval_exercise_id)).toBe(
      String(second.row.approval_exercise_id),
    );
    expect(ctx.approvals.listExercised({ mission_id: mid }).length).toBe(1);
  });
});

describe("PHD E — crash after request, before linkage", () => {
  it("E. restart rediscovers + relinks the existing PENDING — no duplicate", () => {
    const ctx = makeCtx("e");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const approvalId = String(approval.approval_id);
    // Simulate crash between request() and pending_approval_id linkage:
    // the request row is durable, the runtime link is not, pending_recovery
    // still carries the HUMAN_APPROVAL_REQUIRED action.
    const rtEnt = rt(ctx, mid);
    rtEnt.state = "RECOVERING";
    rtEnt.pending_approval_id = null;
    ctx.store.put("mission_runtime", `MRT_${mid}`, rtEnt, Number(rtEnt.version));
    ctx.runtime.tick(mid, FAR);
    const after = rt(ctx, mid);
    expect(String(after.state)).toBe("WAITING_APPROVAL");
    expect(String(after.pending_approval_id)).toBe(approvalId);
    const all = ctx.approvals
      .listPending(mid)
      .concat(
        ctx.store
          .list("approval_request")
          .filter((a) => a.mission_id === mid),
      )
      .filter(
        (a, i, arr) =>
          arr.findIndex((x) => x.approval_id === a.approval_id) === i,
      );
    expect(all.length).toBe(1);
  });
});

describe("PHD F/G — expiry + superseded converge", () => {
  it("F. TTL-expired PENDING inside WAITING_APPROVAL → bounded terminal", () => {
    const ctx = makeCtx("f");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const row = ctx.approvals.get(String(approval.approval_id));
    row.expires_at = "2000-01-01T00:00:00.000Z";
    ctx.store.put(
      "approval_request",
      String(approval.approval_id),
      row,
      Number(row.version),
    );
    ctx.runtime.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
    expect(
      String(ctx.approvals.get(String(approval.approval_id)).status),
    ).toBe("EXPIRED");
  });

  it("G. SUPERSEDED approval cannot wedge WAITING_APPROVAL", () => {
    const ctx = makeCtx("g");
    const { mid } = driveToCeilingApproval(ctx);
    const task = ctx.service.listTasks(mid)[0];
    ctx.approvals.supersede(mid, String(task.task_id), "test_supersede");
    ctx.runtime.tick(mid, FAR);
    expect(["ABORTED", "FAILED"]).toContain(String(rt(ctx, mid).state));
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
  });
});

describe("PHD H/I — UNKNOWN_SIDE_EFFECT_STATE closure", () => {
  function driveUnknown(ctx: ReturnType<typeof makeCtx>) {
    const exA = new ScriptedAdapter(
      "EX_A",
      [{ status: "UNKNOWN" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
      `${ctx.dir}/run-root`,
    );
    registerAdapter(ctx, exA, exA.caps);
    const mid = startMission(ctx);
    const state = tickUntil(ctx, mid, ["WAITING_APPROVAL", "ABORTED", "FAILED"]);
    return { mid, state, exA };
  }

  it("H. approve no-replay → barrier settled + task FAILED + zero replay + converged", () => {
    const ctx = makeCtx("h", SINGLE_TASK);
    const { mid, state, exA } = driveUnknown(ctx);
    expect(state).toBe("WAITING_APPROVAL");
    const approval = pendingApproval(ctx, mid);
    expect(String(approval.requested_action)).toBe(
      "ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY",
    );
    const intent = approval.intent as Record<string, unknown>;
    expect(intent.kind).toBe("ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY");

    const dispatchedBefore = exA.dispatched.length;
    ctx.approvals.decide(
      String(approval.approval_id),
      "op",
      "APPROVED",
      approval.scope_snapshot as Record<string, unknown>,
    );
    for (let i = 0; i < 6; i++) ctx.runtime.tick(mid, fakeClock()());

    const task = ctx.service.listTasks(mid)[0];
    expect(String(task.status)).toBe("FAILED");
    expect(exA.dispatched.length).toBe(dispatchedBefore); // NEVER replayed
    const rtEnt = rt(ctx, mid);
    const barriers = rtEnt.barriers as Record<
      string,
      Record<string, unknown>
    >;
    const barrier = barriers[String(task.task_id)];
    expect(barrier.settled).toBe(true);
    expect(String(barrier.operator_outcome)).toBe(
      "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY",
    );
    expect(rtEnt.pending_recovery ?? null).toBeNull();
    expect(rtEnt.pending_approval_id ?? null).toBeNull();
    // Task terminal → mission converges FAILED (not stuck RUNNING).
    expect(String(rtEnt.state)).toBe("FAILED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
    // Durable neutralization on the execution row — restart cannot resurrect.
    const execs = ctx.store
      .list("executor_execution")
      .filter((e) => e.mission_id === mid);
    expect(String(execs[0].terminal_outcome)).toBe(
      "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY",
    );
    // Exactly-once exercise evidence exists.
    const exercised = ctx.approvals.listExercised({ mission_id: mid });
    expect(exercised.length).toBe(1);
    // Restart-safe: a fresh runtime sees a terminal mission, nothing resumes.
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const rt2 = service2.store.get("mission_runtime", `MRT_${mid}`);
    expect(String(rt2.state)).toBe("FAILED");
  });

  it("I. denied no-replay approval → bounded terminal", () => {
    const ctx = makeCtx("i", SINGLE_TASK);
    const { mid, state } = driveUnknown(ctx);
    expect(state).toBe("WAITING_APPROVAL");
    const approval = pendingApproval(ctx, mid);
    ctx.approvals.decide(
      String(approval.approval_id),
      "op",
      "DENIED",
      approval.scope_snapshot as Record<string, unknown>,
      "operator denies",
    );
    ctx.runtime.tick(mid, FAR);
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
  });
});

describe("PHD J/K — failure taxonomy", () => {
  it("J1. Phase C DSH authority failures → POLICY_DENIAL, never availability", () => {
    for (const code of [
      "AUTHORITY_REJECTED",
      "FAIL_CLOSED_DSH_MODEL_BINDING",
      "FAIL_CLOSED_DSH_MODEL_IDENTITY_DRIFT",
      "FAIL_CLOSED_DSH_PROVIDER_INELIGIBLE",
      "FAIL_CLOSED_DSH_EXECUTOR_INELIGIBLE",
      "FAIL_CLOSED_DSH_PLANNER_OVERLAP",
      "FAIL_CLOSED_DSH_MODEL_ROLE_VIOLATION",
    ]) {
      expect(classifyFailure({ error_code: code })).toBe("POLICY_DENIAL");
      expect(
        classifyFailure({
          result: { error: { code, class: "X", message: "dsh authority" } },
        }),
      ).toBe("POLICY_DENIAL");
    }
  });

  it("J2. DSH model-pool exhaustion is availability — NOT a policy abort", () => {
    // FAIL_CLOSED_DSH_MODEL_EXHAUSTED aggregates safe PRE-DISPATCH
    // availability failures across the configured pool. It must keep
    // availability/recovery semantics — the FAIL_CLOSED_DSH_ prefix
    // alone cannot drag it into POLICY_DENIAL.
    expect(
      classifyFailure({ error_code: "FAIL_CLOSED_DSH_MODEL_EXHAUSTED" }),
    ).toBe("TRANSIENT_TRANSPORT");
    expect(
      classifyFailure({
        result: {
          error: {
            code: "FAIL_CLOSED_DSH_MODEL_EXHAUSTED",
            class: "X",
            message: "pool exhausted",
          },
        },
      }),
    ).toBe("TRANSIENT_TRANSPORT");
  });

  it("K. ROUTE_INFEASIBLE classification preserved", () => {
    expect(
      classifyFailure({ error_code: "FAIL_CLOSED_ROUTE_INFEASIBLE" }),
    ).toBe("ROUTE_INFEASIBLE");
  });
});

describe("PHD M — scope authority (caller-presented scope required)", () => {
  it("M1. correct presented scope → PASS; missing scope → FAIL CLOSED; mutated → FAIL CLOSED", () => {
    const ctx = makeCtx("m");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const id = String(approval.approval_id);
    const scope = approval.scope_snapshot as Record<string, unknown>;

    // Missing scope — the stored scope_snapshot may NOT be substituted.
    expect(() =>
      ctx.approvals.decide(id, "op", "APPROVED", undefined),
    ).toThrow(/FAIL_CLOSED_APPROVAL_SCOPE_REQUIRED/);
    expect(String(ctx.approvals.get(id).status)).toBe("PENDING");

    // Mutated scope — digest mismatch fails closed.
    expect(() =>
      ctx.approvals.decide(id, "op", "APPROVED", {
        ...(scope as object),
        injected: true,
      }),
    ).toThrow(/FAIL_CLOSED_APPROVAL_SCOPE_MISMATCH/);
    expect(String(ctx.approvals.get(id).status)).toBe("PENDING");

    // Correct canonical scope echoes exactly what request() bound.
    ctx.approvals.decide(id, "op", "APPROVED", scope);
    expect(String(ctx.approvals.get(id).status)).toBe("APPROVED");
  });
});

describe("PHD N — canonical-time approval expiry", () => {
  it("N. supplied runtime `now` expires the approval — wall clock irrelevant", () => {
    const ctx = makeCtx("n");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const id = String(approval.approval_id);
    // expires_at in the FUTURE relative to wall time (real clock ~2026),
    // but in the PAST relative to the tick's canonical time — only
    // expireSweep(now) honoring the supplied `now` can expire it.
    const row = ctx.approvals.get(id);
    row.expires_at = "2999-06-01T00:00:00.000Z";
    ctx.store.put("approval_request", id, row, Number(row.version));
    ctx.runtime.tick(mid, "2999-07-01T00:00:00Z");
    expect(String(ctx.approvals.get(id).status)).toBe("EXPIRED");
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
  });
});

describe("PHD O — concurrent exercise, separate writers", () => {
  it("O. two store connections race exercise() → one canonical winner, loser adopts", () => {
    const ctx = makeCtx("o");
    const { mid } = driveToCeilingApproval(ctx);
    const approvalId = approvePending(ctx, mid);

    // A second physical connection to the SAME database — a genuine
    // process-equivalent writer, not a sequential double call.
    const storeB = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const serviceB = new PairControlPlane(storeB);
    const approvalsB = new ApprovalQueue(serviceB);

    const first = ctx.approvals.exercise(approvalId, { plan: "winner" });
    expect(first.created).toBe(true);
    expect(String(first.row.state)).toBe("APPLYING");

    // Force B's stale pre-read to miss the APRE row → B's version-0 INSERT
    // hits ON CONFLICT DO NOTHING → IntegrityError → B must re-read and
    // adopt the canonical winner instead of surfacing a version defect.
    const origTryGet = storeB.tryGet.bind(storeB);
    let missedOnce = false;
    (storeB as unknown as { tryGet: typeof storeB.tryGet }).tryGet = (
      t: string,
      id: string,
    ) => {
      if (!missedOnce && t === APPROVAL_EXERCISE_ENTITY) {
        missedOnce = true;
        return null;
      }
      return origTryGet(t, id);
    };
    const second = approvalsB.exercise(approvalId, { plan: "loser" });
    expect(second.created).toBe(false);
    expect(String(second.row.approval_exercise_id)).toBe(
      String(first.row.approval_exercise_id),
    );
    expect(
      (second.row.effect as Record<string, unknown>).plan,
    ).toBe("winner"); // winner's persisted plan adopted, never recomputed
    expect(ctx.approvals.listExercised({ mission_id: mid }).length).toBe(1);
  });
});

describe("PHD P — crash after APRE persist, before effect", () => {
  it("P1. APPLYING row at restart → SAME exercise resumed+converged, then APPLIED", () => {
    const ctx = makeCtx("p");
    const exA = new ScriptedAdapter(
      "EX_A",
      [{ status: "FAILED", error_class: "AUTHENTICATION_REQUIRED" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
    );
    registerAdapter(ctx, exA, exA.caps);
    const mid = startMission(ctx);
    const state = tickUntil(ctx, mid, ["WAITING_APPROVAL", "ABORTED", "FAILED"]);
    expect(state).toBe("WAITING_APPROVAL");
    const approval = pendingApproval(ctx, mid);
    const approvalId = String(approval.approval_id);
    expect(String(approval.requested_action)).toBe(
      "RECOVERY_OPERATOR_REVALIDATION",
    );
    ctx.approvals.decide(
      approvalId,
      "op",
      "APPROVED",
      approval.scope_snapshot as Record<string, unknown>,
    );

    // Crash window: the APRE row is durable (APPLYING) but NO runtime
    // effect was applied — simulate by writing it directly.
    const pre = ctx.approvals.exercise(approvalId, {});
    expect(pre.created).toBe(true);
    expect(String(pre.row.state)).toBe("APPLYING");

    // Restart-equivalent re-entry: fresh store connection + runtime must
    // resume the SAME exercise — never skip the effect, never mint a
    // second fresh recovery decision after re-entry.
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const router2 = new MissionRouter(service2, gate2);
    const recovery2 = new RecoveryController(service2);
    const recon2 = new ReconciliationService(service2, new Map());
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const exA2 = new ScriptedAdapter(
      "EX_A",
      [],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
      null,
      "r1_",
    );
    const runtime2 = new MissionRuntime({
      service: service2,
      gate: gate2,
      router: router2,
      adapters: new Map<string, ExecutorAdapter>([["EX_A", exA2]]),
      scheduler: scheduler2,
      approvals: approvals2,
      reconciliation: recon2,
      recovery: recovery2,
    });
    for (let i = 0; i < 8; i++) runtime2.tick(mid, fakeClock()());
    const apre = store2
      .list(APPROVAL_EXERCISE_ENTITY)
      .filter((x) => x.approval_id === approvalId);
    expect(apre.length).toBe(1);
    expect(String(apre[0].state)).toBe("APPLIED");
    expect(apre[0].applied_at).toBeTruthy();
    // Effect converged: identical re-escalation hit the exercised-equivalent
    // bound → bounded terminal, exactly ONE approval total.
    expect(String(store2.get("mission_runtime", `MRT_${mid}`).state)).toBe(
      "ABORTED",
    );
    expect(
      store2
        .list("approval_request")
        .filter((a) => a.mission_id === mid).length,
    ).toBe(1);
    const decisionsBefore = store2
      .list("recovery_decision")
      .filter((d) => d.mission_id === mid).length;
    // Re-entry on an APPLIED exercise mints nothing.
    for (let i = 0; i < 4; i++) runtime2.tick(mid, fakeClock()());
    expect(
      store2
        .list("recovery_decision")
        .filter((d) => d.mission_id === mid).length,
    ).toBe(decisionsBefore);
  });

  it("P2. exercised EXTENSION restart → stamped chain is reused, never re-minted", () => {
    const ctx = makeCtx("p2");
    const { mid, exA } = driveToCeilingApproval(ctx);
    approvePending(ctx, mid);
    ctx.runtime.tick(mid, FAR);
    const exercised = ctx.approvals.listExercised({ mission_id: mid });
    expect(exercised.length).toBe(1);
    const exerciseId = String(exercised[0].approval_exercise_id);
    const decisionsAfterExercise = ctx.store
      .list("recovery_decision")
      .filter((d) => d.mission_id === mid).length;

    // Fresh runtime (restart) — the fresh chain is stamped with the
    // exercise id, so re-entry can never mint a second chain.
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const exA2 = new ScriptedAdapter(
      "EX_A",
      Array.from({ length: 8 }, () => ({
        status: "FAILED",
        error_class: "RATE_LIMITED",
      })),
      ["ONLY_EX_A", "FILE_OPERATIONS"],
      null,
      "r2_",
    );
    const runtime2 = new MissionRuntime({
      service: service2,
      gate: gate2,
      router: new MissionRouter(service2, gate2),
      adapters: new Map<string, ExecutorAdapter>([
        ["EX_A", exA2],
        ["EX_B", new ScriptedAdapter("EX_B", [], ["FILE_OPERATIONS"])],
      ]),
      scheduler: scheduler2,
      approvals: approvals2,
      reconciliation: new ReconciliationService(service2, new Map()),
      recovery: new RecoveryController(service2),
    });
    for (let t = Date.parse(FAR), i = 0; i < 12; i++, t += 120_000) {
      runtime2.tick(mid, new Date(t).toISOString());
    }
    // Grant yields at most its one dispatch — the exercised approval was
    // never re-applied and no second fresh chain was minted.
    expect(exA2.dispatched.length).toBeLessThanOrEqual(1);
    const settledDecisions = store2
      .list("recovery_decision")
      .filter((d) => d.mission_id === mid).length;
    // Fresh chain post-exercise (1) + one post-retry escalation bound — a
    // restart/re-entry multiplying chains would blow past this bound.
    expect(settledDecisions).toBeLessThanOrEqual(decisionsAfterExercise + 2);
    for (let t = Date.parse(FAR) + 12 * 120_000, i = 0; i < 6; i++, t += 120_000) {
      runtime2.tick(mid, new Date(t).toISOString());
    }
    expect(
      store2
        .list("recovery_decision")
        .filter((d) => d.mission_id === mid).length,
    ).toBe(settledDecisions); // stable — no re-mint on repeated re-entry
    expect(
      store2
        .list(APPROVAL_EXERCISE_ENTITY)
        .filter((x) => x.approval_exercise_id === exerciseId).length,
    ).toBe(1);
    expect(String(store2.get("mission_runtime", `MRT_${mid}`).state)).toBe(
      "ABORTED",
    );
  });
});

describe("PHD Q — SUPERSEDED relink only to an exact equivalent", () => {
  function mintManual(
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    taskId: string,
    sig: string,
    action = "RECOVERY_OPERATOR_REVALIDATION",
  ) {
    return ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: action,
      mission_id: mid,
      task_id: taskId,
      intent: {
        kind: action,
        mission_id: mid,
        task_id: taskId,
        failure_signature: sig,
      },
      scope: { mission_id: mid, task_id: taskId, failure_signature: sig },
      reason: "adversarial",
    });
  }

  it("Q1. task A's superseded approval never relinks to task B's", () => {
    const ctx = makeCtx("q");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const taskA = String(approval.task_id);
    const taskB = ctx.service
      .listTasks(mid)
      .map((t) => String(t.task_id))
      .find((t) => t !== taskA)!;
    // A foreign pending approval for the OTHER task must not be adopted.
    mintManual(ctx, mid, taskB, "SIG::other::task");
    ctx.approvals.supersede(mid, taskA, "test_supersede");
    ctx.runtime.tick(mid, FAR);
    const rtEnt = rt(ctx, mid);
    expect(rtEnt.pending_approval_id ?? null).toBeNull();
    expect(String(rtEnt.state)).toBe("ABORTED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
    // Task B's approval is untouched — still PENDING.
    const bStill = ctx.approvals
      .listPending(mid)
      .filter((a) => String(a.task_id) === taskB);
    expect(bStill.length).toBe(1);
  });

  it("Q2. equivalent same-task approval IS adopted on relink", () => {
    const ctx = makeCtx("q2");
    const { mid } = driveToCeilingApproval(ctx);
    const approval = pendingApproval(ctx, mid);
    const taskA = String(approval.task_id);
    const sig = String(
      (approval.intent as Record<string, unknown>).failure_signature,
    );
    const action = String(approval.requested_action);
    ctx.approvals.supersede(mid, taskA, "test_supersede");
    // A NEW equivalent pending minted AFTER the supersede (e.g. a
    // crash-before-linkage re-request) is the legitimate relink target.
    const twin = ctx.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: action,
      mission_id: mid,
      task_id: taskA,
      intent: {
        kind: action,
        mission_id: mid,
        task_id: taskA,
        failure_signature: sig,
      },
      scope: { mission_id: mid, task_id: taskA, failure_signature: sig },
      reason: "equivalent",
    });
    ctx.runtime.tick(mid, FAR);
    const rtEnt = rt(ctx, mid);
    expect(String(rtEnt.pending_approval_id)).toBe(String(twin.approval_id));
    expect(String(rtEnt.state)).toBe("WAITING_APPROVAL");
  });
});

describe("PHD L — bounded identical escalation", () => {
  it("L. identical re-escalation after an exercised grant → bounded abort, not another approval", () => {
    const ctx = makeCtx("l");
    // AUTHENTICATION_FAILURE → HUMAN_APPROVAL_REQUIRED immediately
    // (operator revalidation intent).
    const exA = new ScriptedAdapter(
      "EX_A",
      [{ status: "FAILED", error_class: "AUTHENTICATION_REQUIRED" }],
      ["ONLY_EX_A", "FILE_OPERATIONS"],
    );
    registerAdapter(ctx, exA, exA.caps);
    const mid = startMission(ctx);
    const state = tickUntil(ctx, mid, ["WAITING_APPROVAL", "ABORTED", "FAILED"]);
    expect(state).toBe("WAITING_APPROVAL");
    const approval = pendingApproval(ctx, mid);
    expect(String(approval.requested_action)).toBe(
      "RECOVERY_OPERATOR_REVALIDATION",
    );
    ctx.approvals.decide(
      String(approval.approval_id),
      "op",
      "APPROVED",
      approval.scope_snapshot as Record<string, unknown>,
    );
    // Exercise → fresh bounded re-decide → identical failure signature →
    // the SAME escalation is required again → §7 bound aborts instead of
    // minting a second equivalent approval.
    for (let i = 0; i < 8; i++) ctx.runtime.tick(mid, fakeClock()());
    expect(String(rt(ctx, mid).state)).toBe("ABORTED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
    const allApprovals = ctx.store
      .list("approval_request")
      .filter((a) => a.mission_id === mid);
    expect(allApprovals.length).toBe(1);
    expect(ctx.approvals.listExercised({ mission_id: mid }).length).toBe(1);
  });
});
