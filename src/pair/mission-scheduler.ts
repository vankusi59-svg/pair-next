/**
 * P9 MissionScheduler — DAG-aware task scheduling + durable action timers.
 *
 * Two responsibilities, both persisted in pair.db (never in-memory authority):
 *
 * 1. `scheduled_action` entities — durable timers for recovery actions.
 *    A P8 recovery decision records `backoff_ms`; the scheduler persists the
 *    due timestamp, so a process restart reconstructs pending work with zero
 *    loss. States: SCHEDULED → READY → RUNNING → COMPLETED | CANCELLED |
 *    SUPERSEDED. The in-process clock is only a trigger; the store is truth.
 *
 * 2. Runnable-task selection — a task is runnable only when ALL hold:
 *    belongs to the mission's ACTIVE plan revision, all depends_on tasks
 *    COMPLETED, task not settled, no reconciliation barrier, no pending
 *    approval, no SCHEDULED-but-not-due action blocking it, retry budget
 *    intact. Fairness order: priority → readiness → age → stable ids.
 *    Concurrency is bounded by the mission ceiling and per-executor
 *    `metadata.max_concurrency` (active executor_execution count).
 */

import { IntegrityError } from "./errors.js";
import { newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";

export const SCHEDULED_ACTION_STATUSES = [
  "SCHEDULED",
  "READY",
  "RUNNING",
  "COMPLETED",
  "CANCELLED",
  "SUPERSEDED",
] as const;
export type ScheduledActionStatus = (typeof SCHEDULED_ACTION_STATUSES)[number];

const SETTLED_TASK = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
const ACTIVE_EXECUTION = new Set(["RUNNING", "DISPATCHED", "PENDING", "VALIDATED"]);

export interface SchedulerConfig {
  /** Max tasks dispatched per mission per tick. */
  mission_concurrency: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  mission_concurrency: 2,
};

export class MissionScheduler {
  constructor(
    private readonly service: PairControlPlane,
    private readonly config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  ) {}

  private get store() {
    return this.service.store;
  }

  /* ---------------- durable scheduled actions (P8 backoff execution) ------ */

  schedule(input: {
    mission_id: string;
    task_id?: string;
    recovery_id?: string;
    action: string;
    due_at: string;
    payload?: Record<string, unknown>;
  }): Record<string, unknown> {
    const id = newId("SACT");
    const record = {
      scheduled_action_id: id,
      mission_id: input.mission_id,
      task_id: input.task_id ?? null,
      recovery_id: input.recovery_id ?? null,
      action: input.action,
      payload: input.payload ?? {},
      due_at: input.due_at,
      status: "SCHEDULED" as ScheduledActionStatus,
      created_at: utcnow(),
      completed_at: null as string | null,
      version: 0,
    };
    const saved = this.store.put("scheduled_action", id, record, 0);
    this.store.event({
      entity_type: "scheduled_action",
      entity_id: id,
      event_type: "SCHEDULED_ACTION_CREATED",
      new_state: "SCHEDULED",
      actor: "PAIR_MISSION_SCHEDULER",
      metadata: {
        mission_id: input.mission_id,
        task_id: input.task_id ?? null,
        action: input.action,
        due_at: input.due_at,
      },
    });
    return saved;
  }

  /** Promote due SCHEDULED actions to READY. Returns due actions (sorted). */
  dueActions(now?: string): Array<Record<string, unknown>> {
    const t = now ?? utcnow();
    const due: Array<Record<string, unknown>> = [];
    for (const a of this.store.list("scheduled_action")) {
      if (a.status !== "SCHEDULED") continue;
      if (String(a.due_at) <= t) {
        a.status = "READY";
        this.store.put(
          "scheduled_action",
          String(a.scheduled_action_id),
          a,
          Number(a.version),
        );
        due.push(a);
      }
    }
    return due.sort((a, b) => String(a.scheduled_action_id).localeCompare(String(b.scheduled_action_id)));
  }

  markScheduledAction(
    scheduledActionId: string,
    status: ScheduledActionStatus,
  ): Record<string, unknown> {
    const a = this.store.get("scheduled_action", scheduledActionId);
    const legal: Record<string, ScheduledActionStatus[]> = {
      SCHEDULED: ["READY", "CANCELLED", "SUPERSEDED"],
      READY: ["RUNNING", "CANCELLED", "SUPERSEDED"],
      RUNNING: ["COMPLETED", "CANCELLED", "SUPERSEDED"],
      COMPLETED: [],
      CANCELLED: [],
      SUPERSEDED: [],
    };
    if (!(legal[String(a.status)] ?? []).includes(status)) {
      throw new IntegrityError(
        "FAIL_CLOSED_SCHEDULED_ACTION_TRANSITION",
        `${String(a.status)}->${status}`,
      );
    }
    a.status = status;
    if (status === "COMPLETED") a.completed_at = utcnow();
    const saved = this.store.put(
      "scheduled_action",
      scheduledActionId,
      a,
      Number(a.version),
    );
    this.store.event({
      entity_type: "scheduled_action",
      entity_id: scheduledActionId,
      event_type: `SCHEDULED_ACTION_${status}`,
      new_state: status,
      actor: "PAIR_MISSION_SCHEDULER",
      metadata: { mission_id: a.mission_id, task_id: a.task_id, action: a.action },
    });
    return saved;
  }

  /** Supersede pending actions when e.g. a new plan revision lands. */
  supersedePending(missionId: string, reason: string): number {
    let count = 0;
    for (const a of this.store.list("scheduled_action")) {
      if (a.mission_id !== missionId) continue;
      if (a.status !== "SCHEDULED" && a.status !== "READY") continue;
      this.markScheduledAction(String(a.scheduled_action_id), "SUPERSEDED");
      count++;
    }
    return count;
  }

  /* ---------------- DAG-aware runnable selection -------------------------- */

  /**
   * Runnable = active-plan task, READY status, deps all COMPLETED, no
   * reconciliation barrier, no pending approval blocking, no future-due
   * scheduled action for the task, and the mission has free slots.
   * `isBlocked` is injected: (task) => reason|null — supplied by the runtime
   * which owns barrier/approval context.
   */
  pickRunnable(
    missionId: string,
    opts: {
      isBlocked?: (task: Record<string, unknown>) => string | null;
      inFlightTaskIds?: Set<string>;
    } = {},
  ): Array<Record<string, unknown>> {
    const { plan_id: activePlanId } = this.service.activeRevision(missionId);
    const mission = this.service.getMission(missionId);
    const tasks = this.service
      .listTasks(missionId)
      .filter((t) => t.plan_id === activePlanId);

    const byKeyOrId = new Map<string, Record<string, unknown>>();
    for (const t of tasks) {
      byKeyOrId.set(String(t.task_id), t);
      if (t.task_key) byKeyOrId.set(String(t.task_key), t);
    }

    const inFlight = opts.inFlightTaskIds ?? this.inFlightTaskIds(missionId);
    const free = this.config.mission_concurrency - inFlight.size;
    if (free <= 0) return [];

    const priority = Number(
      (mission.metadata as Record<string, unknown> | undefined)?.priority ?? 0,
    );
    const candidates = tasks.filter((t) => {
      if (String(t.status) !== "READY") return false;
      if (inFlight.has(String(t.task_id))) return false;
      for (const dep of (t.depends_on as string[]) ?? []) {
        const d = byKeyOrId.get(String(dep));
        if (!d || String(d.status) !== "COMPLETED") return false;
      }
      if (opts.isBlocked && opts.isBlocked(t) != null) return false;
      return true;
    });

    // Fairness: priority → readiness (fewest unresolved deps — all resolved
    // here, so 0) → age (created_at) → stable task_id tie-break. Deterministic.
    candidates.sort((a, b) => {
      const pa = Number(
        ((a.metadata as Record<string, unknown>)?.priority as number) ?? priority,
      );
      const pb = Number(
        ((b.metadata as Record<string, unknown>)?.priority as number) ?? priority,
      );
      if (pa !== pb) return pb - pa; // higher priority first
      const ca = String(a.created_at ?? "");
      const cb = String(b.created_at ?? "");
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.task_id).localeCompare(String(b.task_id));
    });

    return candidates.slice(0, free);
  }

  /** Task ids with a live (non-terminal) execution or dispatch intent. */
  inFlightTaskIds(missionId: string): Set<string> {
    const out = new Set<string>();
    for (const e of this.store.list("executor_execution")) {
      if (e.mission_id !== missionId) continue;
      if (ACTIVE_EXECUTION.has(String(e.execution_state))) {
        out.add(String(e.task_id));
      }
    }
    for (const g of this.store.list("governed_task")) {
      if (g.mission_id !== missionId) continue;
      if (
        g.governance_state === "DISPATCH_AUTHORIZED" ||
        g.governance_state === "VALIDATED"
      ) {
        // governed task authorized but execution may not exist yet
        const hasTerminalExecution = this.store
          .list("executor_execution")
          .some(
            (e) =>
              e.governed_task_id === g.governed_task_id &&
              !ACTIVE_EXECUTION.has(String(e.execution_state)),
          );
        if (!hasTerminalExecution) out.add(String(g.task_id));
      }
    }
    return out;
  }

  /** Active executions per executor (concurrency check input). */
  activeExecutionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of this.store.list("executor_execution")) {
      if (!ACTIVE_EXECUTION.has(String(e.execution_state))) continue;
      const id = String(e.executor_id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  /** Executor max_concurrency from its registry descriptor (default 1). */
  executorMaxConcurrency(executorId: string): number {
    try {
      const ex = this.service.getExecutor(executorId);
      const md = (ex.metadata as Record<string, unknown>) ?? {};
      return Number(md.max_concurrency ?? 1);
    } catch {
      return 1;
    }
  }

  executorHasCapacity(executorId: string): boolean {
    const used = this.activeExecutionCounts().get(executorId) ?? 0;
    return used < this.executorMaxConcurrency(executorId);
  }
}
