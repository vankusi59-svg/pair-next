/**
 * P9 MissionRuntime — the restart-safe long-running mission execution loop.
 *
 * The runtime ORCHESTRATES existing authorities; it never becomes one:
 *   - Automaton planner proposes plans (injected `planner` fn)
 *   - MissionRouter is the sole task→executor router (all 12 gates re-run)
 *   - GovernedTaskGate is the sole dispatch authorization path
 *   - RecoveryController is the sole recovery decision authority (bounded)
 *   - ReconciliationService is the sole side-effect settlement authority
 *   - ApprovalQueue binds every human escalation to an exact scope digest
 *
 * Canonical loop (one `tick` = one persisted step):
 *   mission → plan (PLANNING) → READY → RUNNING
 *     → schedule runnable DAG tasks → route → gate → dispatch
 *     → observe → collect → artifact/result verify → task terminal
 *     → failure: classify → decide → apply action
 *       RETRY_SAME_ROUTE / RE_ROUTE → durable backoff → re-route via router
 *       REPLAN → planner → validatePlanProposal → NEW plan revision
 *       APPLY_VERIFIED_REMEDIATION → governed remediation task
 *       RECONCILIATION_REQUIRED → barrier + reconcile before any redrive
 *       HUMAN_APPROVAL_REQUIRED → approval_request → WAITING_APPROVAL
 *       ABORT → ABORTED
 *   → all tasks terminal → mission COMPLETED
 *
 * All state lives in pair.db entities (`mission_runtime`, `scheduled_action`,
 * `approval_request`, barriers on the runtime row). A process restart resumes
 * exactly: in-flight executions are re-observed, timers replayed from due_at,
 * no task is silently reset and nothing is re-dispatched twice.
 */

import { IntegrityError, PolicyError } from "./errors.js";
import { newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import type { GovernedTaskGate } from "./gate.js";
import type { MissionRouter } from "./mission-router.js";
import type { ExecutorAdapter } from "./adapter.js";
import type { MissionScheduler } from "./mission-scheduler.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { RecoveryController } from "./recovery-controller.js";
import { classifyFailure } from "./recovery-controller.js";
import type { RecoveryAction } from "./recovery-controller.js";
import { projectRoutableExecutors } from "./routing-projection.js";
import { validatePlanProposal } from "./proposal.js";

export const MISSION_RUNTIME_STATES = [
  "CREATED",
  "PLANNING",
  "READY",
  "RUNNING",
  "WAITING",
  "WAITING_BACKOFF",
  "WAITING_APPROVAL",
  "RECONCILING",
  "REPLANNING",
  "RECOVERING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
] as const;
export type MissionRuntimeState = (typeof MISSION_RUNTIME_STATES)[number];

const TERMINAL_RUNTIME = new Set<MissionRuntimeState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
]);
export const TERMINAL_EXECUTION = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
const SETTLED_TASK = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED", "SUPERSEDED"]);

export const RUNTIME_TRANSITIONS: Record<MissionRuntimeState, MissionRuntimeState[]> = {
  CREATED: ["PLANNING", "READY", "CANCELLED", "ABORTED"],
  PLANNING: ["READY", "FAILED", "WAITING_APPROVAL", "CANCELLED", "ABORTED"],
  READY: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED"],
  RUNNING: [
    "WAITING",
    "WAITING_BACKOFF",
    "WAITING_APPROVAL",
    "RECONCILING",
    "REPLANNING",
    "RECOVERING",
    "PAUSED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "ABORTED",
  ],
  WAITING: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED", "FAILED"],
  WAITING_BACKOFF: ["RUNNING", "RECOVERING", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  WAITING_APPROVAL: ["RUNNING", "RECOVERING", "REPLANNING", "RECONCILING", "CANCELLED", "ABORTED", "FAILED"],
  RECONCILING: ["RUNNING", "RECOVERING", "WAITING_APPROVAL", "FAILED", "CANCELLED", "ABORTED"],
  REPLANNING: ["READY", "RUNNING", "FAILED", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  RECOVERING: [
    "RUNNING",
    "WAITING_BACKOFF",
    "WAITING_APPROVAL",
    "RECONCILING",
    "REPLANNING",
    "FAILED",
    "CANCELLED",
    "ABORTED",
  ],
  PAUSED: ["READY", "RUNNING", "CANCELLED", "ABORTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  ABORTED: [],
};

export interface RuntimePlannerInput {
  mission: Record<string, unknown>;
  advice?: Record<string, unknown> | null;
  /** Tasks of the superseded revision, for replans (informational). */
  superseded_tasks?: Array<Record<string, unknown>>;
  reason: string;
}
export type RuntimePlanner = (
  input: RuntimePlannerInput,
) => { tasks: Array<Record<string, unknown>> };

export interface MissionRuntimeDeps {
  service: PairControlPlane;
  gate: GovernedTaskGate;
  router: MissionRouter;
  adapters: Map<string, ExecutorAdapter>;
  scheduler: MissionScheduler;
  approvals: ApprovalQueue;
  reconciliation: ReconciliationService;
  recovery: RecoveryController;
  /** Automaton planning authority — injected; runtime never plans itself. */
  planner?: RuntimePlanner;
  /** P7 advisor — advisory retrieval only, never authoritative. */
  plannerAdvisor?: { advise(opts: Record<string, unknown>): Record<string, unknown> };
  environment?: Record<string, unknown>;
  actor?: string;
  /**
   * Governed task execution budget (seconds) applied when a task carries no
   * explicit metadata.timeout. Phase A: validated at startup via
   * taskTimeoutSeconds() — this field must already be a positive int.
   */
  taskTimeoutSeconds?: number;
}

const DEFAULT_TASK_TIMEOUT = 120;

export class MissionRuntime {
  private readonly actor: string;

  constructor(private readonly deps: MissionRuntimeDeps) {
    this.actor = deps.actor ?? "PAIR_MISSION_RUNTIME";
  }

  private get store() {
    return this.deps.service.store;
  }

  /* ---------------- runtime state entity + transitions ------------------ */

  runtimeEntity(missionId: string): Record<string, unknown> {
    const id = `MRT_${missionId}`;
    const existing = this.store.tryGet("mission_runtime", id);
    if (existing) return existing;
    const record = {
      mission_runtime_id: id,
      mission_id: missionId,
      state: "CREATED" as MissionRuntimeState,
      entered_at: utcnow(),
      reason: "mission_runtime_created",
      barriers: {} as Record<string, Record<string, unknown>>,
      pending_recovery: null as Record<string, unknown> | null,
      pending_approval_id: null as string | null,
      pending_remediation: null as Record<string, unknown> | null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0,
    };
    const saved = this.store.put("mission_runtime", id, record, 0);
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: id,
      event_type: "MISSION_RUNTIME_CREATED",
      new_state: "CREATED",
      actor: this.actor,
      metadata: { mission_id: missionId },
    });
    return saved;
  }

  transitionRuntime(
    missionId: string,
    to: MissionRuntimeState,
    reason: string,
  ): Record<string, unknown> {
    const rt = this.runtimeEntity(missionId);
    const from = String(rt.state) as MissionRuntimeState;
    if (from === to) return rt;
    if (!(RUNTIME_TRANSITIONS[from] ?? []).includes(to)) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_RUNTIME_TRANSITION",
        `${from}->${to}`,
      );
    }
    rt.state = to;
    rt.entered_at = utcnow();
    rt.reason = reason;
    const saved = this.store.put(
      "mission_runtime",
      String(rt.mission_runtime_id),
      rt,
      Number(rt.version),
    );
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: String(rt.mission_runtime_id),
      event_type: "MISSION_RUNTIME_TRANSITION",
      old_state: from,
      new_state: to,
      actor: this.actor,
      metadata: { mission_id: missionId, reason },
    });
    return saved;
  }

  /* ---------------- operator controls ----------------------------------- */

  pause(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "pause");
    const rt = this.runtimeEntity(missionId);
    const mission = this.deps.service.getMission(missionId);
    if (mission.status === "RUNNING" || mission.status === "READY") {
      this.deps.service.transitionMission(missionId, "PAUSED", `OPERATOR:${operatorId}`);
    }
    if (rt.state === "RUNNING" || rt.state === "READY") {
      this.transitionRuntime(missionId, "PAUSED", `operator_pause:${operatorId}`);
    }
    return rt;
  }

  resume(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "resume");
    const mission = this.deps.service.getMission(missionId);
    const rt = this.runtimeEntity(missionId);
    if (mission.status === "PAUSED") {
      this.deps.service.transitionMission(missionId, "RUNNING", `OPERATOR:${operatorId}`);
    }
    if (rt.state === "PAUSED") {
      this.transitionRuntime(missionId, "RUNNING", `operator_resume:${operatorId}`);
    }
    return rt;
  }

  /** Cancel: stop scheduling, request executor cancels, settle evidence. */
  cancel(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "cancel");
    const mission = this.deps.service.getMission(missionId);
    if (!TERMINAL_RUNTIME.has(String(mission.status) as MissionRuntimeState)) {
      const allowed = ["READY", "RUNNING", "PAUSED", "CREATED"];
      if (allowed.includes(String(mission.status))) {
        this.deps.service.transitionMission(missionId, "CANCELLED", `OPERATOR:${operatorId}`);
      }
    }
    // Request cancel on live executions; preserve evidence; unresolved
    // side-effect state is marked explicitly, never erased.
    for (const e of this.store.list("executor_execution")) {
      if (e.mission_id !== missionId) continue;
      if (TERMINAL_EXECUTION.has(String(e.execution_state))) continue;
      const adapter = this.deps.adapters.get(String(e.executor_id));
      try {
        adapter?.cancel(String(e.execution_id));
        e.execution_state = "CANCELLED";
        e.cancelled_by = `OPERATOR:${operatorId}`;
        this.store.put(
          "executor_execution",
          String(e.execution_id),
          e,
          Number(e.version),
        );
      } catch {
        e.execution_state = "UNKNOWN";
        e.cancel_requested = true;
        this.store.put(
          "executor_execution",
          String(e.execution_id),
          e,
          Number(e.version),
        );
      }
    }
    for (const t of this.deps.service.listTasks(missionId)) {
      if (!SETTLED_TASK.has(String(t.status))) {
        this.deps.service.updateTask(String(t.task_id), {
          status: "CANCELLED",
          cancelled_at: utcnow(),
        });
      }
    }
    const rt = this.runtimeEntity(missionId);
    if (!TERMINAL_RUNTIME.has(String(rt.state) as MissionRuntimeState)) {
      const legal = RUNTIME_TRANSITIONS[String(rt.state) as MissionRuntimeState] ?? [];
      if (legal.includes("CANCELLED")) {
        this.transitionRuntime(missionId, "CANCELLED", `operator_cancel:${operatorId}`);
      } else {
        rt.state = "CANCELLED";
        rt.reason = `operator_cancel:${operatorId}`;
        this.store.put(
          "mission_runtime",
          String(rt.mission_runtime_id),
          rt,
          Number(rt.version),
        );
      }
    }
    this.deps.scheduler.supersedePending(missionId, "MISSION_CANCELLED");
    return rt;
  }

  /* ---------------- governed request builder ----------------------------- */

  private requestFor(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
  ): Record<string, unknown> {
    const md = (mission.metadata as Record<string, unknown>) ?? {};
    const tmd = (task.metadata as Record<string, unknown>) ?? {};
    const workspace = String(
      tmd.workspace ?? (md.authorized_workspaces as string[])?.[0],
    );
    return {
      mission_id: mission.mission_id,
      task_id: task.task_id,
      plan_revision: mission.plan_revision,
      task_instruction: task.task_instruction,
      workspace,
      allowed_paths: (tmd.allowed_paths as string[]) ?? [workspace],
      permissions: (mission.granted_permissions as string[]) ?? [],
      constraints: (md.constraints as string[]) ?? [],
      timeout: Number(tmd.timeout ?? this.deps.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT),
      expected_output_contract:
        tmd.expected_output_contract ?? { type: "TASK_RESULT" },
      requested_tools:
        (tmd.requested_tools as string[]) ??
        (task.required_capabilities as string[]) ??
        [],
      dependency_outputs: this.dependencyOutputs(String(mission.mission_id), task),
      correlation_id: `${mission.mission_id}:${task.task_id}`,
    };
  }

  /** Governed dependency handoff: completed dep executions' canonical results. */
  private dependencyOutputs(
    missionId: string,
    task: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const deps = (task.depends_on as string[]) ?? [];
    if (!deps.length) return [];
    const tasks = this.deps.service.listTasks(missionId);
    const byKeyOrId = new Map<string, Record<string, unknown>>();
    for (const t of tasks) {
      byKeyOrId.set(String(t.task_id), t);
      if (t.task_key) byKeyOrId.set(String(t.task_key), t);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const dep of deps) {
      const depTask = byKeyOrId.get(String(dep));
      if (!depTask) continue;
      const exec = this.store
        .list("executor_execution")
        .find(
          (e) =>
            e.mission_id === missionId &&
            e.task_id === depTask.task_id &&
            e.execution_state === "COMPLETED",
        );
      if (exec?.result) {
        out.push({
          from_task_id: String(depTask.task_id),
          from_task_key: depTask.task_key ?? null,
          execution_id: String(exec.execution_id),
          result: exec.result,
        });
      }
    }
    return out;
  }

  /* ---------------- the tick -------------------------------------------- */

  /** One persisted step. Returns the runtime entity after the step. */
  tick(missionId: string, now?: string): Record<string, unknown> {
    const rt = this.runtimeEntity(missionId);
    const state = String(rt.state) as MissionRuntimeState;
    if (TERMINAL_RUNTIME.has(state) || state === "PAUSED") return rt;

    switch (state) {
      case "CREATED": {
        const mission = this.deps.service.getMission(missionId);
        const hasPlan = mission.plan_id != null;
        this.transitionRuntime(missionId, hasPlan ? "READY" : "PLANNING", "runtime_start");
        break;
      }
      case "PLANNING": {
        this.runPlanning(missionId);
        break;
      }
      case "READY": {
        const status = String(this.deps.service.getMission(missionId).status);
        if (status === "CREATED") {
          this.deps.service.transitionMission(missionId, "READY", this.actor);
        }
        if (status === "CREATED" || status === "READY") {
          this.deps.service.transitionMission(missionId, "RUNNING", this.actor);
        }
        this.transitionRuntime(missionId, "RUNNING", "mission_executable");
        break;
      }
      case "RUNNING":
      case "WAITING": {
        this.runRunning(missionId, now);
        break;
      }
      case "WAITING_BACKOFF": {
        this.recoveryGuard(missionId, () => {
          const due = this.deps.scheduler.dueActions(now).filter(
            (a) => a.mission_id === missionId,
          );
          if (due.length === 0) {
            const pending = this.store
              .list("scheduled_action")
              .filter(
                (a) => a.mission_id === missionId && a.status === "SCHEDULED",
              );
            if (pending.length === 0) {
              this.transitionRuntime(missionId, "RUNNING", "no_pending_backoff");
            }
            return;
          }
          this.transitionRuntime(missionId, "RECOVERING", "backoff_due");
          for (const a of due) {
            this.deps.scheduler.markScheduledAction(
              String(a.scheduled_action_id),
              "RUNNING",
            );
          }
        }, now);
        break;
      }
      case "RECOVERING": {
        this.applyPendingRecovery(missionId, now);
        break;
      }
      case "RECONCILING": {
        this.recoveryGuard(missionId, () => this.runReconciliation(missionId), now);
        break;
      }
      case "REPLANNING": {
        this.recoveryGuard(missionId, () => this.runReplan(missionId), now);
        break;
      }
      case "WAITING_APPROVAL": {
        this.recoveryGuard(missionId, () => this.checkPendingApproval(missionId), now);
        break;
      }
      default:
        break;
    }
    return this.runtimeEntity(missionId);
  }

  /** Drive the mission until it settles or stalls. Returns final runtime. */
  run(missionId: string, opts: { maxTicks?: number; now?: () => string } = {}) {
    const maxTicks = opts.maxTicks ?? 200;
    let last = this.runtimeEntity(missionId);
    for (let i = 0; i < maxTicks; i++) {
      const before = JSON.stringify([last.state, this.progressSnapshot(missionId)]);
      last = this.tick(missionId, opts.now?.());
      const snap = JSON.stringify([last.state, this.progressSnapshot(missionId)]);
      if (snap === before && TERMINAL_RUNTIME.has(String(last.state) as MissionRuntimeState)) break;
      if (TERMINAL_RUNTIME.has(String(last.state) as MissionRuntimeState)) break;
      if (snap === before && ["WAITING", "WAITING_BACKOFF", "WAITING_APPROVAL", "PAUSED"].includes(String(last.state))) break;
    }
    return last;
  }

  private progressSnapshot(missionId: string) {
    return {
      tasks: this.deps.service
        .listTasks(missionId)
        .map((t) => `${t.task_id}:${t.status}`),
      executions: this.store
        .list("executor_execution")
        .filter((e) => e.mission_id === missionId)
        .map((e) => `${e.execution_id}:${e.execution_state}`),
      scheduled: this.store
        .list("scheduled_action")
        .filter((a) => a.mission_id === missionId)
        .map((a) => `${a.scheduled_action_id}:${a.status}`),
    };
  }

  /* ---------------- PLANNING -------------------------------------------- */

  private runPlanning(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    const advice = this.adviseSafely(mission);
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", missionId);
    }
    const proposal = this.deps.planner({ mission, advice, reason: "initial" });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    this.deps.service.commitPlan({
      mission_id: missionId,
      tasks: tasks as unknown as Array<Record<string, unknown>>,
      source: "AUTOMATON_PLANNER",
      reason: "initial_plan",
      proposal,
    });
    this.transitionRuntime(missionId, "READY", "plan_committed");
  }

  /* ---------------- RUNNING ---------------------------------------------- */

  private runRunning(missionId: string, now?: string): void {
    const rt = this.runtimeEntity(missionId);

    // 1. Process due scheduled recovery actions first (durable timers).
    let hasDue = false;
    this.recoveryGuard(missionId, () => {
      const due = this.deps.scheduler
        .dueActions(now)
        .filter((a) => a.mission_id === missionId);
      if (due.length > 0) {
        hasDue = true;
        for (const a of due) {
          this.deps.scheduler.markScheduledAction(String(a.scheduled_action_id), "RUNNING");
        }
        this.transitionRuntime(missionId, "RECOVERING", "due_recovery_actions");
      }
    }, now);
    if (hasDue) return;

    // R4 §11 — compatibility repair: a runtime left RUNNING with a
    // pending_recovery (the pre-fix "unhandled" fallthrough) resumes the
    // governed recovery path on ordinary ticks — no store surgery needed.
    // An action already proven unhandled is not re-driven (no transition
    // spam); RECONCILIATION_REQUIRED is always re-driven — it is handled
    // now and progresses to a bounded outcome.
    const pendingRecovery = rt.pending_recovery as Record<string, unknown> | null;
    if (pendingRecovery) {
      const pendingAction = String(pendingRecovery.action);
      if (
        pendingAction === "RECONCILIATION_REQUIRED" ||
        String(rt.reason ?? "") !== `unhandled:${pendingAction}`
      ) {
        this.applyPendingRecovery(missionId, now);
        return;
      }
    }

    // 2. Observe in-flight executions → collect terminals.
    const inFlight = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.mission_id === missionId &&
          !TERMINAL_EXECUTION.has(String(e.execution_state)),
      );
    for (const e of inFlight) {
      const adapter = this.deps.adapters.get(String(e.executor_id));
      if (!adapter) continue;
      const observed = this.deps.gate.observe_execution(adapter, String(e.execution_id));
      if (!TERMINAL_EXECUTION.has(String(observed.execution_state))) continue;
      this.settleExecution(missionId, String(observed.execution_id));
      const rtNow = String(this.runtimeEntity(missionId).state);
      if (rtNow !== "RUNNING") return; // recovery/approval/reconcile took over
    }

    // 3. Dispatch runnable DAG tasks.
    const mission = this.deps.service.getMission(missionId);
    const barriers = (rt.barriers as Record<string, Record<string, unknown>>) ?? {};
    const runnable = this.deps.scheduler.pickRunnable(missionId, {
      isBlocked: (t) => {
        const barrier = barriers[String(t.task_id)];
        // R4 §9 — only an ACTIVE/unsettled barrier retains scheduling
        // authority; a settled one is historical evidence, not a block.
        if (barrier != null && barrier.settled !== true) {
          return `RECONCILIATION_BARRIER:${String(barrier.kind)}`;
        }
        return this.deps.approvals.hasPendingBlock(missionId, String(t.task_id))
          ? "PENDING_APPROVAL"
          : this.futureScheduledBlock(missionId, String(t.task_id), now);
      },
    });
    for (const task of runnable) {
      const request = this.requestFor(mission, task);
      try {
        const routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        this.deps.service.updateTask(String(task.task_id), { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown>;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("CAPACITY_EXHAUSTED")) {
          continue; // executor saturated — task stays READY for the next tick
        }
        const failureClass = classifyFailure({
          error_code: msg,
          error_class: "DISPATCH",
        });
        this.startRecovery(missionId, String(task.task_id), null, failureClass, now);
        return;
      }
      const rtNow = String(this.runtimeEntity(missionId).state);
      if (rtNow !== "RUNNING") return;
    }

    // 4. Terminal check.
    this.maybeComplete(missionId);
  }

  private futureScheduledBlock(
    missionId: string,
    taskId: string,
    now?: string,
  ): string | null {
    const t = now ?? utcnow();
    const pending = this.store.list("scheduled_action").find(
      (a) =>
        a.mission_id === missionId &&
        a.task_id === taskId &&
        (a.status === "SCHEDULED" || a.status === "READY") &&
        String(a.due_at) > t,
    );
    return pending ? `SCHEDULED_UNTIL:${String(pending.due_at)}` : null;
  }

  /* ---------------- settle + recovery entry ------------------------------- */

  private settleExecution(missionId: string, executionId: string): void {
    const execution = this.store.get("executor_execution", executionId);
    const adapter = this.deps.adapters.get(String(execution.executor_id));
    if (!adapter) {
      throw new PolicyError("FAIL_CLOSED_ADAPTER_NOT_BOUND", String(execution.executor_id));
    }
    const taskId = String(execution.task_id);
    if (!execution.result) {
      this.deps.gate.collect_execution_result(adapter, executionId);
    }
    const collected = this.store.get("executor_execution", executionId);
    const state = String(collected.execution_state);
    if (state === "COMPLETED") {
      const validation = this.deps.gate.validate_execution_result(executionId);
      if (String(validation.status) === "PASS") {
        this.deps.service.updateTask(taskId, {
          status: "COMPLETED",
          completed_at: utcnow(),
        });
        this.store.event({
          entity_type: "task",
          entity_id: taskId,
          event_type: "TASK_COMPLETED",
          new_state: "COMPLETED",
          actor: this.actor,
          correlation_id: String(collected.correlation_id ?? ""),
        });
        return;
      }
      // Validation failed — artifact failure, never mark success.
      this.deps.service.updateTask(taskId, { status: "FAILED" });
      this.startRecovery(
        missionId,
        taskId,
        executionId,
        "ARTIFACT_VALIDATION_FAILURE",
      );
      return;
    }
    // Terminal non-success → recovery decision.
    this.deps.service.updateTask(taskId, { status: "FAILED" });
    const errorObj =
      (collected.result as Record<string, unknown> | undefined)?.error as
        | Record<string, unknown>
        | undefined;
    const failureClass = classifyFailure({
      execution_state: state,
      error_code: String(errorObj?.message ?? errorObj?.code ?? state),
      error_class: String(errorObj?.class ?? ""),
      result: (collected.result as Record<string, unknown>) ?? null,
    });
    this.startRecovery(missionId, taskId, executionId, failureClass);
  }

  /**
   * The recovery decision is recorded, then the runtime moves to the state
   * that will execute it — retries/reroutes go through durable backoff;
   * approval blocks the task until decided; reconciliation sets a barrier.
   */
  private startRecovery(
    missionId: string,
    taskId: string,
    executionId: string | null,
    failureClass: ReturnType<typeof classifyFailure>,
    now?: string,
    /** R4 §8 — supplied when this failure chain already settled a
     *  reconciliation for the same instance; forwarded to the decision
     *  so the settled candidate is not re-selected forever. */
    settledReconciliation?: { outcome: string; reconciliation_id?: string },
    /** Live-ops Bug C — actions proven infeasible by an apply-path routing
     *  throw in THIS failure chain; forwarded to decide() so the identical
     *  attempt is rejected instead of replayed forever. */
    infeasibleActions?: Array<{ action: RecoveryAction; reason: string }>,
  ): void {
    const rt = this.runtimeEntity(missionId);
    const execution = executionId
      ? this.store.tryGet("executor_execution", executionId)
      : null;
    const ext = (rt.budget_extension as Record<string, number>) ?? {};
    const eligible = projectRoutableExecutors(this.deps.service).map((r) =>
      String(r.executor_id),
    );
    const verifiedRemediation = this.store
      .list("experience")
      .filter((e) => e.type === "REMEDIATION_PAIR" && e.status === "ACTIVE")
      .map((e) => String(e.experience_id ?? e.id));
    const decision = this.deps.recovery.decide({
      verified_remediation_ids: verifiedRemediation,
      mission_id: missionId,
      task_id: taskId,
      execution_id: executionId ?? undefined,
      governed_task_id: execution ? String(execution.governed_task_id) : undefined,
      executor_id: execution ? String(execution.executor_id) : undefined,
      failure_class: failureClass,
      eligible_executors: eligible,
      risk_class: String(
        ((this.deps.service.getMission(missionId).metadata as Record<string, unknown>)
          ?.risk_ceiling as string) ?? "HIGH",
      ),
      correlation_id: `${missionId}:${taskId}`,
      budget_extension: {
        attempts_per_task: Number(ext.attempts_per_task ?? 0),
        attempts_per_mission: Number(ext.attempts_per_mission ?? 0),
      },
      settled_reconciliation: settledReconciliation ?? null,
      infeasible_actions: infeasibleActions ?? [],
      now,
    });
    rt.pending_recovery = {
      recovery_id: decision.recovery_id,
      action: decision.selected_action,
      task_id: taskId,
      execution_id: executionId,
      governed_task_id: execution ? execution.governed_task_id : null,
      executor_id: execution ? execution.executor_id : null,
      failure_class: failureClass,
      backoff_ms: decision.backoff_ms,
      infeasible_actions: infeasibleActions ?? [],
    };
    this.store.put(
      "mission_runtime",
      String(rt.mission_runtime_id),
      rt,
      Number(rt.version),
    );

    const action = String(decision.selected_action);
    switch (action) {
      case "RETRY_SAME_ROUTE":
      case "RE_ROUTE": {
        const backoff = Number(decision.backoff_ms);
        if (backoff > 0) {
          const dueAt = new Date(Date.parse(now ?? utcnow()) + backoff).toISOString();
          const pendingNow = rt.pending_recovery as Record<string, unknown>;
          this.deps.scheduler.schedule({
            mission_id: missionId,
            task_id: taskId,
            recovery_id: String(decision.recovery_id),
            action,
            due_at: dueAt,
            payload: { governed_task_id: pendingNow.governed_task_id, executor_id: pendingNow.executor_id },
          });
          this.transitionRuntime(missionId, "WAITING_BACKOFF", `${action}:${backoff}ms`);
        } else {
          this.transitionRuntime(missionId, "RECOVERING", action);
        }
        break;
      }
      case "APPLY_VERIFIED_REMEDIATION":
        this.transitionRuntime(missionId, "RECOVERING", action);
        break;
      case "REPLAN":
        this.transitionRuntime(missionId, "REPLANNING", action);
        break;
      case "RECONCILIATION_REQUIRED": {
        const rt2 = this.runtimeEntity(missionId);
        rt2.barriers = {
          ...((rt2.barriers as Record<string, unknown>) ?? {}),
          [taskId]: {
            kind: "RECONCILIATION",
            execution_id: executionId,
            recovery_id: decision.recovery_id,
            since: utcnow(),
          },
        };
        this.store.put("mission_runtime", String(rt2.mission_runtime_id), rt2, Number(rt2.version));
        this.transitionRuntime(missionId, "RECONCILING", action);
        break;
      }
      case "HUMAN_APPROVAL_REQUIRED": {
        const scope = {
          requested_action: "RECOVERY_BUDGET_OVERRIDE",
          mission_id: missionId,
          task_id: taskId,
          failure_class: failureClass,
          recovery_decision_id: String(decision.recovery_id),
        };
        const approval = this.deps.approvals.request({
          approval_type: "RECOVERY_APPROVAL",
          requested_action: "RECOVERY_BUDGET_OVERRIDE",
          scope,
          mission_id: missionId,
          task_id: taskId,
          reason: `recovery escalation: ${failureClass}`,
          risk_class: String(decision.risk_class ?? "MEDIUM"),
          correlation_id: String(decision.correlation_id ?? ""),
        });
        const rt2 = this.runtimeEntity(missionId);
        rt2.pending_approval_id = String(approval.approval_id);
        this.store.put("mission_runtime", String(rt2.mission_runtime_id), rt2, Number(rt2.version));
        this.transitionRuntime(missionId, "WAITING_APPROVAL", action);
        break;
      }
      case "ABORT":
      default: {
        this.abortMission(missionId, `recovery_abort:${failureClass}`);
        break;
      }
    }
  }

  /* ---------------- RECOVERING — execute the selected action ------------- */

  private applyPendingRecovery(missionId: string, now?: string): void {
    const rt = this.runtimeEntity(missionId);
    const pending = rt.pending_recovery as Record<string, unknown> | null;
    if (!pending) {
      this.transitionRuntime(missionId, "RUNNING", "no_pending_recovery");
      return;
    }
    const action = String(pending.action);
    const taskId = String(pending.task_id);

    // Audit R: the WHOLE apply arm runs inside one boundary. Only the router
    // calls keep their own catch (they convert an expected PolicyError into
    // infeasible evidence for the attempted action). Every other statement
    // in the arm — supersede, task fetch/update, remediation internals —
    // that throws would otherwise escape to the supervisor's silent catch
    // and replay the unchanged pending_recovery every tick: the same
    // permanent-RECOVERING limbo this closure exists to remove.
    try {
      this.applyRecoveryAction(missionId, pending, action, taskId, now);
    } catch (err) {
      this.recoveryFailureBoundary(missionId, pending, action, err, now);
    }
  }

  /**
   * Runs a recovery-driven tick body under the apply-failure boundary. Any
   * throw while an actionable pending_recovery exists is converted into a
   * bounded recovery outcome instead of escaping to the supervisor's silent
   * catch — covering the non-RECOVERING legs of a recovery chain
   * (WAITING_BACKOFF, RECONCILING, REPLANNING, WAITING_APPROVAL) where the
   * same pending_recovery would otherwise replay forever.
   */
  private recoveryGuard(missionId: string, fn: () => void, now?: string): void {
    try {
      fn();
    } catch (err) {
      const pending = this.runtimeEntity(missionId).pending_recovery as
        | Record<string, unknown>
        | null;
      if (!pending) throw err;
      this.recoveryFailureBoundary(
        missionId,
        pending,
        String(pending.action),
        err,
        now,
      );
    }
  }

  /**
   * Last boundary for recovery-apply failures. A normal throw becomes an
   * infeasible/defect re-decide via handleRecoveryApplyFailure; if THAT
   * fails too (illegal decided transition, decide() defect, store fault),
   * the only state reachable from every live recovery state is ABORTED —
   * abortMission force-writes it, so an unhandleable failure still ends in
   * an operator-visible terminal state rather than another silent replay.
   */
  private recoveryFailureBoundary(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    err: unknown,
    now?: string,
  ): void {
    try {
      this.handleRecoveryApplyFailure(missionId, pending, action, err, now);
    } catch (inner) {
      this.abortMission(
        missionId,
        `recovery_boundary_defect:${(inner as { message?: string })?.message ?? String(inner)}`,
      );
    }
  }

  private applyRecoveryAction(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    taskId: string,
    now?: string,
  ): void {
    const mission = this.deps.service.getMission(missionId);

    switch (action) {
      case "RETRY_SAME_ROUTE": {
        this.supersedeGovernedTaskOnce(pending);
        const task = this.deps.service.getTask(taskId);
        this.deps.service.updateTask(taskId, { status: "READY" });
        const request = this.requestFor(mission, task);
        request.executor_constraint = pending.executor_id;
        let routed: Record<string, unknown>;
        try {
          routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        } catch (err) {
          this.handleRecoveryApplyFailure(missionId, pending, "RETRY_SAME_ROUTE", err, now);
          return;
        }
        this.deps.service.updateTask(taskId, { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown> | undefined;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
        if (String(this.runtimeEntity(missionId).state) === "RECOVERING") {
          this.clearPendingRecovery(missionId, "COMPLETED", "retry_dispatched");
          this.transitionRuntime(missionId, "RUNNING", "retry_dispatched");
        }
        break;
      }
      case "RE_ROUTE": {
        this.supersedeGovernedTaskOnce(pending);
        const task = this.deps.service.getTask(taskId);
        this.deps.service.updateTask(taskId, { status: "READY" });
        const request = this.requestFor(mission, task);
        if (pending.executor_id) {
          request.exclude_executors = [pending.executor_id];
        }
        let routed: Record<string, unknown>;
        try {
          routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        } catch (err) {
          this.handleRecoveryApplyFailure(missionId, pending, "RE_ROUTE", err, now);
          return;
        }
        this.deps.service.updateTask(taskId, { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown> | undefined;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
        if (String(this.runtimeEntity(missionId).state) === "RECOVERING") {
          this.clearPendingRecovery(missionId, "COMPLETED", "reroute_dispatched");
          this.transitionRuntime(missionId, "RUNNING", "reroute_dispatched");
        }
        break;
      }
      case "APPLY_VERIFIED_REMEDIATION": {
        this.runRemediation(missionId, pending, now);
        break;
      }
      case "RECONCILIATION_REQUIRED": {
        // R4 §7 — the reconcile already ran and returned a verdict. When
        // it proved CONFIRMED_NOT_EXECUTED, replay is safe from the
        // side-effect perspective: the stale pending action is superseded
        // and a FRESH governed recovery decision re-evaluates the next
        // action (the settled candidate can never re-select itself).
        const rt3 = this.runtimeEntity(missionId);
        const barrier = (
          (rt3.barriers as Record<string, Record<string, unknown>>) ?? {}
        )[taskId];
        const barrierOutcome = String(barrier?.last_outcome ?? "");
        const pendingNow = rt3.pending_recovery as Record<string, unknown>;
        if (
          barrier &&
          barrier.settled === true &&
          barrierOutcome === "CONFIRMED_NOT_EXECUTED"
        ) {
          this.clearPendingRecovery(missionId, "COMPLETED", "reconcile_confirmed_not_executed");
          this.startRecovery(
            missionId,
            taskId,
            pendingNow.execution_id ? String(pendingNow.execution_id) : null,
            pendingNow.failure_class as ReturnType<typeof classifyFailure>,
            now,
            {
              outcome: barrierOutcome,
              reconciliation_id: String(barrier.last_receipt_id ?? ""),
            },
          );
        } else if (barrier && barrier.settled === true) {
          // Settled with any other verdict — the reconcile outcome was
          // already applied (settle/escalate); the stale pending action
          // is complete and must not keep re-driving.
          this.clearPendingRecovery(missionId, "COMPLETED", `reconcile_outcome:${barrierOutcome}`);
          this.transitionRuntime(missionId, "RUNNING", `reconcile_outcome:${barrierOutcome}`);
        } else if (!barrier) {
          // Pending reconciliation with no barrier evidence — a fresh
          // governed decision re-drives; it may legitimately select
          // RECONCILIATION_REQUIRED again and rebuild the barrier.
          this.clearPendingRecovery(missionId, "COMPLETED", "reconcile_barrier_absent");
          this.startRecovery(
            missionId,
            taskId,
            pendingNow.execution_id ? String(pendingNow.execution_id) : null,
            pendingNow.failure_class as ReturnType<typeof classifyFailure>,
            now,
          );
        } else {
          // Barrier still unsettled — let the RECONCILING path settle it.
          this.transitionRuntime(missionId, "RECONCILING", "reconcile_pending");
        }
        break;
      }
      default:
        this.transitionRuntime(missionId, "RUNNING", `unhandled:${action}`);
    }
  }

  /**
   * Supersede the failed governed task once per failure chain. Within one
   * chain the same governed_task_id is carried across re-decisions
   * (RE_ROUTE → RETRY_SAME_ROUTE), so the second apply sees it already
   * SUPERSEDED — that is idempotent no-op territory, not corruption, and
   * re-superseding must not throw the chain into limbo. A genuinely
   * non-supersedeable state (e.g. mid-execution) still throws through
   * supersedeGovernedTask and flows into handleRecoveryApplyFailure's
   * INTERNAL_RUNTIME_DEFECT path.
   */
  private supersedeGovernedTaskOnce(pending: Record<string, unknown>): void {
    if (!pending.governed_task_id) return;
    const gtId = String(pending.governed_task_id);
    const gt = this.store.tryGet("governed_task", gtId);
    if (gt && String(gt.governance_state).startsWith("SUPERSEDED")) return;
    this.deps.recovery.supersedeGovernedTask(gtId, String(pending.recovery_id));
  }

  /**
   * Live-ops Bug C — a governed routing call inside a recovery apply-path
   * threw before the recovery state was advanced. Feeding the failure back
   * as `infeasible_actions` marks the attempted action infeasible for this
   * failure chain, so the fresh canonical decide() evaluates the NEXT
   * matrix action (typically HUMAN_APPROVAL_REQUIRED or ABORT) instead of
   * replaying the identical throw every supervisor tick — the observed
   * permanent-RECOVERING limbo on MSN_01M3VHGS6HPA62V6K9JR57MNEK.
   *
   * Expected governed routing/policy failures (PolicyError thrown by the
   * router) become recovery evidence in the original failure class.
   * Anything else (IntegrityError, invariant corruption, programmer bugs)
   * is NOT normalized into routing infeasibility — it re-decides under
   * INTERNAL_RUNTIME_DEFECT, the existing canonical defect class, keeping
   * the outcome bounded and operator-visible via the recovery_decision row.
   */
  private handleRecoveryApplyFailure(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    err: unknown,
    now?: string,
  ): void {
    const taskId = String(pending.task_id);
    const prior =
      (pending.infeasible_actions as Array<{ action: RecoveryAction; reason: string }>) ?? [];
    const code =
      err instanceof PolicyError
        ? String(err.code)
        : String((err as { code?: string })?.code ?? "INTERNAL_ERROR");
    const infeasible: Array<{ action: RecoveryAction; reason: string }> = [
      ...prior.filter((e) => e.action !== action),
      { action: action as RecoveryAction, reason: code },
    ];
    const isExpectedGovernedRouting = err instanceof PolicyError;
    this.startRecovery(
      missionId,
      taskId,
      pending.execution_id ? String(pending.execution_id) : null,
      isExpectedGovernedRouting
        ? (pending.failure_class as ReturnType<typeof classifyFailure>)
        : "INTERNAL_RUNTIME_DEFECT",
      now,
      undefined,
      infeasible,
    );
  }

  private runRemediation(
    missionId: string,
    pending: Record<string, unknown>,
    now?: string,
  ): void {
    const recovery = this.deps.recovery;
    const decision = this.store.get("recovery_decision", String(pending.recovery_id));
    const expId = decision.remediation_experience_id as string | null;
    if (!expId) {
      this.startRecovery(missionId, String(pending.task_id), String(pending.execution_id ?? "") || null, "INTERNAL_RUNTIME_DEFECT", now);
      return;
    }
    const mission = this.deps.service.getMission(missionId);
    const md = (mission.metadata as Record<string, unknown>) ?? {};
    if (!rt_pendingRemediation(this.runtimeEntity(missionId))) {
      try {
        recovery.verifyRemediationAdmissible(expId, {
          executor_id: String(pending.executor_id ?? ""),
          environment: this.deps.environment ?? {},
          risk_ceiling: String(md.risk_ceiling ?? "HIGH"),
        });
      } catch {
        this.startRecovery(missionId, String(pending.task_id), String(pending.execution_id ?? "") || null, "ENVIRONMENT_INCOMPATIBLE", now);
        return;
      }
      const proposal = recovery.proposeRemediationTask({
        mission_id: missionId,
        parent_task_id: String(pending.task_id),
        recovery_id: String(pending.recovery_id),
        experience_id: expId,
        task_instruction: `remediation for ${String(pending.task_id)}`,
        workspace: String((md.authorized_workspaces as string[])?.[0] ?? ""),
        permissions: (mission.granted_permissions as string[]) ?? [],
        required_capabilities: ["FILE_OPERATIONS"],
        plan_revision: Number(mission.plan_revision ?? 1),
        correlation_id: `${missionId}:remediation:${expId}`,
      });
      // The remediation request flows through MissionRouter like any task —
      // it needs a real task row in the active plan revision.
      const active = this.deps.service.activeRevision(missionId);
      const remTaskId = newId("TSK");
      const exp = this.store.get("experience", expId);
      this.store.put(
        "task",
        remTaskId,
        {
          task_id: remTaskId,
          task_key: `REM_${String(pending.recovery_id)}`,
          mission_id: missionId,
          plan_id: active.plan_id,
          order: 10_000 + this.deps.service.listTasks(missionId).length,
          title: `remediation:${expId}`,
          description: String((exp.payload as Record<string, unknown>)?.remediation ?? ""),
          task_instruction: `remediation for ${String(pending.task_id)}`,
          required_capabilities: ["FILE_OPERATIONS"],
          selected_executor: null,
          status: "DISPATCHED", // routed via recovery path, not pickRunnable
          metadata: { remediation_of: pending.task_id, recovery_id: pending.recovery_id },
          depends_on: [],
          created_at: utcnow(),
          version: 0,
        },
        0,
      );
      const rt = this.runtimeEntity(missionId);
      rt.pending_remediation = {
        remediation_execution_id: proposal.remediation_execution_id,
        remediation_task_id: remTaskId,
        request: proposal.request,
        task_id: pending.task_id,
      };
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
    }
    const rt2 = this.runtimeEntity(missionId);
    const pr = rt2.pending_remediation as Record<string, unknown>;
    const remExec = this.store.get(
      "remediation_execution",
      String(pr.remediation_execution_id),
    );
    if (String(remExec.state) === "PROPOSED") {
      const request: Record<string, unknown> = {
        ...(pr.request as Record<string, unknown>),
        task_id: String(pr.remediation_task_id),
      };
      if (pending.executor_id) {
        request.executor_constraint = pending.executor_id;
      }
      let routed: Record<string, unknown>;
      try {
        routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
      } catch (err) {
        this.handleRecoveryApplyFailure(missionId, pending, "APPLY_VERIFIED_REMEDIATION", err, now);
        return;
      }
      this.deps.recovery.bindRemediationExecution(
        String(pr.remediation_execution_id),
        String((routed.governed_task as Record<string, unknown>).governed_task_id),
        String((routed.execution as Record<string, unknown>).execution_id),
      );
      return; // next tick observes the remediation execution
    }
    if (String(remExec.state) === "DISPATCHED") {
      const execId = String(remExec.execution_id);
      const execution = this.store.get("executor_execution", execId);
      const adapter = this.deps.adapters.get(String(execution.executor_id));
      if (adapter) {
        const observed = this.deps.gate.observe_execution(adapter, execId);
        if (TERMINAL_EXECUTION.has(String(observed.execution_state))) {
          this.deps.gate.collect_execution_result(adapter, execId);
          const collected = this.store.get("executor_execution", execId);
          const outcome = this.deps.recovery.evaluateRemediationOutcome(
            String(pr.remediation_execution_id),
            String(collected.execution_state),
          );
          const remTaskId = String(pr.remediation_task_id);
          if (remTaskId && this.store.tryGet("task", remTaskId)) {
            this.deps.service.updateTask(remTaskId, {
              status:
                String(outcome.state) === "REMEDIATION_SUCCEEDED"
                  ? "COMPLETED"
                  : "FAILED",
              completed_at: utcnow(),
            });
          }
          if (String(outcome.state) === "REMEDIATION_SUCCEEDED") {
            // Original task gets a fresh bounded recovery decision.
            const task = this.deps.service.getTask(String(pr.task_id));
            this.deps.service.updateTask(String(task.task_id), { status: "READY" });
            this.clearPendingRecovery(missionId, "COMPLETED", "remediation_succeeded");
            this.transitionRuntime(missionId, "RECOVERING", "remediation_succeeded_retry");
          } else if (String(outcome.state) === "RECONCILIATION_REQUIRED") {
            const r = this.runtimeEntity(missionId);
            r.barriers = {
              ...((r.barriers as Record<string, unknown>) ?? {}),
              [String(pr.task_id)]: {
                kind: "RECONCILIATION",
                execution_id: execId,
                since: utcnow(),
              },
            };
            this.store.put("mission_runtime", String(r.mission_runtime_id), r, Number(r.version));
            this.transitionRuntime(missionId, "RECONCILING", "remediation_unknown");
          } else {
            this.clearPendingRecovery(missionId, "COMPLETED", "remediation_failed");
            this.startRecovery(missionId, String(pr.task_id), String(pending.execution_id ?? "") || null, "INTERNAL_RUNTIME_DEFECT", now);
          }
        }
      }
      return;
    }
  }

  private clearPendingRecovery(
    missionId: string,
    scheduledStatus: "COMPLETED" | "CANCELLED",
    reason: string,
  ): void {
    const rt = this.runtimeEntity(missionId);
    const pending = rt.pending_recovery as Record<string, unknown> | null;
    if (pending) {
      for (const a of this.store.list("scheduled_action")) {
        if (
          a.recovery_id === pending.recovery_id &&
          (a.status === "RUNNING" || a.status === "READY" || a.status === "SCHEDULED")
        ) {
          this.deps.scheduler.markScheduledAction(String(a.scheduled_action_id), scheduledStatus);
        }
      }
    }
    rt.pending_recovery = null;
    rt.pending_remediation = null;
    rt.reason = reason;
    this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
  }

  /* ---------------- RECONCILING ------------------------------------------- */

  private runReconciliation(missionId: string): void {
    const rt = this.runtimeEntity(missionId);
    const barriers = (rt.barriers as Record<string, Record<string, unknown>>) ?? {};
    const entries = Object.entries(barriers).filter(([, b]) => b.kind === "RECONCILIATION" && !b.settled);
    if (entries.length === 0) {
      this.transitionRuntime(missionId, "RUNNING", "reconciliation_settled");
      return;
    }
    for (const [taskId, barrier] of entries) {
      const receipt = this.deps.reconciliation.reconcile({
        execution_id: barrier.execution_id ? String(barrier.execution_id) : undefined,
        governed_task_id: barrier.governed_task_id
          ? String(barrier.governed_task_id)
          : undefined,
        mission_id: missionId,
        correlation_id: `${missionId}:${taskId}`,
      });
      const outcome = String(receipt.outcome);
      barrier.last_receipt_id = receipt.reconciliation_id ?? receipt.receipt_id;
      barrier.last_outcome = outcome;
      switch (outcome) {
        case "CONFIRMED_NOT_EXECUTED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          // Safe redrive permitted — recovery re-decides.
          const pending = rt.pending_recovery;
          if (pending) {
            this.transitionRuntime(missionId, "RECOVERING", "reconcile_not_executed");
          } else {
            this.transitionRuntime(missionId, "RUNNING", "reconcile_not_executed");
          }
          return;
        }
        case "CONFIRMED_RUNNING": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          this.transitionRuntime(missionId, "RUNNING", "reconcile_running");
          return;
        }
        case "CONFIRMED_COMPLETED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          const execId = String(barrier.execution_id ?? "");
          if (execId) this.settleExecution(missionId, execId);
          this.transitionRuntime(missionId, "RUNNING", "reconcile_completed");
          return;
        }
        case "CONFIRMED_FAILED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          const execId = String(barrier.execution_id ?? "");
          if (execId) this.settleExecution(missionId, execId);
          this.transitionRuntime(missionId, "RECOVERING", "reconcile_failed");
          return;
        }
        case "UNKNOWN_SIDE_EFFECT_STATE":
        default: {
          // Never auto-replay: escalate to operator or abort.
          const scope = {
            requested_action: "RECONCILE_UNKNOWN_SIDE_EFFECT",
            mission_id: missionId,
            task_id: taskId,
            execution_id: barrier.execution_id ?? null,
          };
          const approval = this.deps.approvals.request({
            approval_type: "RECOVERY_APPROVAL",
            requested_action: "RECONCILE_UNKNOWN_SIDE_EFFECT",
            scope,
            mission_id: missionId,
            task_id: taskId,
            reason: "unknown side-effect state — blind replay forbidden",
            risk_class: "HIGH",
          });
          const rt2 = this.runtimeEntity(missionId);
          rt2.pending_approval_id = String(approval.approval_id);
          this.store.put("mission_runtime", String(rt2.mission_runtime_id), rt2, Number(rt2.version));
          this.transitionRuntime(missionId, "WAITING_APPROVAL", "UNKNOWN_SIDE_EFFECT_STATE");
          return;
        }
      }
    }
  }

  /* ---------------- REPLANNING -------------------------------------------- */

  private runReplan(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", missionId);
    }
    const advice = this.adviseSafely(mission);
    const oldPlanId = String(mission.plan_id ?? "");
    const oldTasks = this.deps.service.listTasks(missionId).filter((t) => t.plan_id === oldPlanId);
    const proposal = this.deps.planner({
      mission,
      advice: advice ?? null,
      superseded_tasks: oldTasks,
      reason: "replan",
    });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    // Old revision stays immutable; unfinished old tasks are settled as
    // CANCELLED (never silently reset), pending approvals/timers superseded.
    for (const t of oldTasks) {
      if (!SETTLED_TASK.has(String(t.status))) {
        this.deps.service.updateTask(String(t.task_id), {
          status: "CANCELLED",
          cancel_reason: "PLAN_SUPERSEDED",
        });
      }
    }
    this.deps.approvals.supersede(missionId, undefined, "PLAN_SUPERSEDED");
    this.deps.scheduler.supersedePending(missionId, "PLAN_SUPERSEDED");
    this.deps.service.commitPlan({
      mission_id: missionId,
      tasks: tasks as unknown as Array<Record<string, unknown>>,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal,
    });
    this.clearPendingRecovery(missionId, "CANCELLED", "replan_committed");
    this.transitionRuntime(missionId, "READY", "replan_committed");
  }

  /* ---------------- WAITING_APPROVAL -------------------------------------- */

  private checkPendingApproval(missionId: string): void {
    const rt = this.runtimeEntity(missionId);
    const approvalId = rt.pending_approval_id as string | null;
    if (!approvalId) {
      this.transitionRuntime(missionId, "RUNNING", "no_pending_approval");
      return;
    }
    const approval = this.deps.approvals.get(approvalId);
    const status = String(approval.status);
    if (status === "PENDING") return; // still waiting
    if (status === "DENIED" || status === "EXPIRED") {
      rt.pending_approval_id = null;
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
      this.abortMission(missionId, `approval_${status.toLowerCase()}`);
      return;
    }
    if (status === "APPROVED") {
      rt.pending_approval_id = null;
      const requested = String(approval.requested_action);
      if (requested === "RECOVERY_BUDGET_OVERRIDE") {
        const ext = (rt.budget_extension as Record<string, number>) ?? {};
        rt.budget_extension = {
          attempts_per_task: Number(ext.attempts_per_task ?? 0) + 1,
          attempts_per_mission: Number(ext.attempts_per_mission ?? 0) + 1,
        };
        this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
        this.transitionRuntime(missionId, "RECOVERING", "approval_granted_budget_extension");
      } else {
        // RECONCILE_UNKNOWN_SIDE_EFFECT approval → operator accepts abort of
        // the barriered task's redrive; barrier stays, task marked FAILED.
        this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
        this.transitionRuntime(missionId, "RUNNING", "approval_granted_resume");
      }
      return;
    }
  }

  /** Advisory retrieval — a broken advisor can never break orchestration. */
  private adviseSafely(mission: Record<string, unknown>) {
    try {
      return this.deps.plannerAdvisor?.advise({
        goal: String(mission.goal),
        mission_id: String(mission.mission_id),
        environment: this.deps.environment,
      }) ?? null;
    } catch {
      return null;
    }
  }

  /* ---------------- terminal ---------------------------------------------- */

  private maybeComplete(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    if (mission.plan_id == null) return;
    const { plan_id } = this.deps.service.activeRevision(missionId);
    const tasks = this.deps.service
      .listTasks(missionId)
      .filter((t) => t.plan_id === plan_id);
    if (tasks.length === 0) return;
    const allTerminal = tasks.every((t) => SETTLED_TASK.has(String(t.status)));
    if (!allTerminal) return;
    const inFlight = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.mission_id === missionId &&
          !TERMINAL_EXECUTION.has(String(e.execution_state)),
      );
    if (inFlight.length > 0) return;

    const failed = tasks.filter((t) => String(t.status) !== "COMPLETED");
    if (failed.length === 0) {
      this.deps.service.transitionMission(missionId, "COMPLETED", this.actor);
      this.transitionRuntime(missionId, "COMPLETED", "all_tasks_completed");
    } else {
      this.deps.service.transitionMission(missionId, "FAILED", this.actor);
      this.transitionRuntime(missionId, "FAILED", `tasks_incomplete:${failed.map((t) => t.task_id).join(",")}`);
    }
  }

  private abortMission(missionId: string, reason: string): void {
    const mission = this.deps.service.getMission(missionId);
    const allowed = ["READY", "RUNNING", "PAUSED"];
    if (allowed.includes(String(mission.status))) {
      this.deps.service.transitionMission(missionId, "FAILED", this.actor);
    }
    const rt = this.runtimeEntity(missionId);
    const legal = RUNTIME_TRANSITIONS[String(rt.state) as MissionRuntimeState] ?? [];
    if (legal.includes("ABORTED")) {
      this.transitionRuntime(missionId, "ABORTED", reason);
    } else if (String(rt.state) !== "ABORTED") {
      rt.state = "ABORTED";
      rt.reason = reason;
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
    }
  }
}

function rt_pendingRemediation(rt: Record<string, unknown>): boolean {
  return rt.pending_remediation != null;
}
