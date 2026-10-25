/**
 * P9 mission-observability — canonical read projections for Mission Control.
 *
 * The activity timeline is derived from canonical evidence + entity events —
 * it is a PROJECTION, never a second truth store. Health reports subsystem
 * state honestly (READY/DEGRADED/UNAVAILABLE/BLOCKED/UNKNOWN) and never
 * collapses auth/quota/policy distinctions into DOWN.
 */

import type { PairControlPlane } from "./service.js";
import { projectRoutableExecutors } from "./routing-projection.js";

export const HEALTH_STATES = [
  "READY",
  "DEGRADED",
  "UNAVAILABLE",
  "BLOCKED",
  "UNKNOWN",
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export class MissionObservability {
  constructor(private readonly service: PairControlPlane) {}

  private get store() {
    return this.service.store;
  }

  /** Canonical mission activity timeline, ordered by event sequence. */
  missionTimeline(missionId: string): Array<Record<string, unknown>> {
    const events = this.store
      .listEvents()
      .filter((e) => {
        const md = (e.metadata as Record<string, unknown>) ?? {};
        return (
          md.mission_id === missionId ||
          String(e.correlation_id ?? "").startsWith(missionId)
        );
      })
      .map((e) => ({
        kind: "EVENT",
        at: e.created_at,
        entity: `${e.entity_type}:${e.entity_id}`,
        event_type: e.event_type,
        actor: e.actor,
        new_state: e.new_state,
      }));
    const evidence = this.store
      .listEvidence(missionId)
      .map((e) => ({
        kind: "EVIDENCE",
        at: e.created_at,
        evidence_kind: e.kind,
        payload: e.payload,
      }));
    return [...events, ...evidence].sort((a, b) =>
      String(a.at).localeCompare(String(b.at)),
    );
  }

  missionSummary(missionId: string): Record<string, unknown> {
    const mission = this.service.getMission(missionId);
    const runtime = this.store.tryGet("mission_runtime", `MRT_${missionId}`);
    const tasks = this.service.listTasks(missionId);
    const executions = this.store
      .list("executor_execution")
      .filter((e) => e.mission_id === missionId);
    const approvals = this.store
      .list("approval_request")
      .filter((a) => a.mission_id === missionId);
    const recovery = this.store
      .list("recovery_decision")
      .filter((r) => r.mission_id === missionId);
    return {
      mission,
      runtime: runtime ?? null,
      task_count: tasks.length,
      tasks,
      executions,
      approvals_pending: approvals.filter((a) => a.status === "PENDING"),
      recovery_decisions: recovery,
    };
  }

  /* ---------------- P18.4-B — liveness & recovery operations ------------- */

  /**
   * Per-execution health projection for one mission. Every field is
   * classified by provenance — `persisted` (canonical row values),
   * `observed` (adapter-reported, sanitized), `derived` (computed from
   * persisted facts), or `unknown` — so an operator can never mistake a
   * guess for a fact. No timestamps or states are synthesized: a field
   * absent from durable state stays null and appears in `unknowns`.
   */
  executionHealth(missionId: string): { executions: Array<Record<string, unknown>> } {
    const rows = this.store
      .list("executor_execution")
      .filter((e) => e.mission_id === missionId)
      .sort((a, b) =>
        String(a.dispatch_timestamp ?? "").localeCompare(
          String(b.dispatch_timestamp ?? ""),
        ),
      );
    const executions = rows.map((e) => {
      const obs = (e.last_observation as Record<string, unknown> | undefined) ?? {};
      const persisted = {
        execution_state: String(e.execution_state ?? "UNKNOWN"),
        result_committed: e.result != null,
        settle_complete: e.settle_complete === true,
        settled_at: e.settled_at ?? null,
        collection_started_at: e.collection_started_at ?? null,
        collection_attempts: Number(e.collection_attempts ?? 0),
        collection_committed_at: e.collection_committed_at ?? null,
        collect_excluded: e.collect_excluded ?? null,
        terminal_outcome: e.terminal_outcome ?? null,
        dispatch_timestamp: e.dispatch_timestamp ?? null,
        run_root: e.run_root ?? null,
        orphan_unobservable: e.orphan_unobservable_final === true
          ? {
              final: true,
              count: Number(e.orphan_unobservable_count ?? 0),
            }
          : null,
      };
      const observed = {
        // Facts ABOUT observation — canonical row stamps describing the
        // observe lifecycle plus sanitized adapter-reported fields. The
        // bucket is "what the system saw", never a canonical verdict.
        last_status: obs.status ?? null,
        last_observed_at: e.last_observed_at ?? null,
        observe_count: Number(e.observe_count ?? 0),
        observe_faults: Number(obs.observe_faults ?? 0),
        first_terminal_observed_at: e.first_terminal_observed_at ?? null,
        heartbeat_at: obs.heartbeat_at ?? obs.heartbeat ?? null,
        finished_at:
          (e.result as Record<string, unknown> | undefined)?.completed_at ??
          obs.finished_at ??
          null,
        blocking_reason: obs.blocking_reason ?? null,
      };
      // Derived stage — ordered by canonical strength, never by guess.
      const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
        persisted.execution_state,
      );
      const stage = persisted.terminal_outcome
        ? "NEUTRALIZED"
        : persisted.settle_complete
          ? "SETTLED"
          : persisted.collect_excluded
            ? "EXCLUDED"
            : persisted.result_committed
              ? "RESULT_COMMITTED"
              : terminal || observed.first_terminal_observed_at
                ? "TERMINAL_OBSERVED"
                : observed.last_observed_at || observed.observe_count > 0
                  ? "OBSERVED"
                  : "DISPATCHED";
      // Abnormal flags — every rule keys on a durable fact, never a
      // threshold invented at read time.
      const abnormal: string[] = [];
      if (observed.blocking_reason) abnormal.push(`BLOCKED:${String(observed.blocking_reason)}`);
      if (persisted.collect_excluded) {
        abnormal.push(
          `COLLECTION_EXCLUDED:${String((persisted.collect_excluded as Record<string, unknown>).code ?? "")}`,
        );
      }
      if (persisted.orphan_unobservable) abnormal.push("ORPHAN_UNOBSERVABLE");
      if (observed.observe_faults > 0) abnormal.push(`OBSERVE_FAULTS:${observed.observe_faults}`);
      if (Number(e.settle_faults ?? 0) > 0) abnormal.push(`SETTLE_FAULTS:${Number(e.settle_faults)}`);
      if (persisted.result_committed && !persisted.settle_complete && !persisted.collect_excluded
        && !persisted.terminal_outcome) {
        abnormal.push("COMMITTED_UNSETTLED");
      }
      if (persisted.execution_state === "UNKNOWN") abnormal.push("UNKNOWN_OUTCOME");
      if (!terminal && !observed.last_observed_at && observed.observe_count === 0) {
        abnormal.push("NEVER_OBSERVED");
      }
      const ms = (a: unknown, b: unknown) => {
        const d = Date.parse(String(b ?? "")) - Date.parse(String(a ?? ""));
        return Number.isFinite(d) && d >= 0 ? d : null;
      };
      const unknowns: string[] = [];
      if (observed.last_observed_at == null) unknowns.push("no_observation_yet");
      if (persisted.result_committed === false && terminal) unknowns.push("result_not_collected");
      if (!persisted.settle_complete && persisted.result_committed) {
        unknowns.push("settlement_pending");
      }
      return {
        execution_id: String(e.execution_id),
        task_id: String(e.task_id ?? ""),
        governed_task_id: String(e.governed_task_id ?? ""),
        executor_id: String(e.executor_id ?? ""),
        persisted,
        observed,
        derived: {
          stage,
          abnormal,
          latency_ms: {
            dispatch_to_terminal_observed: ms(
              persisted.dispatch_timestamp,
              observed.first_terminal_observed_at,
            ),
            terminal_observed_to_collect: ms(
              observed.first_terminal_observed_at,
              persisted.collection_committed_at,
            ),
            terminal_observed_to_settled: ms(
              observed.first_terminal_observed_at,
              persisted.settled_at,
            ),
          },
        },
        unknowns,
      };
    });
    return { executions };
  }

  /**
   * Recovery operations projection for one mission — active arm,
   * deferred queue, barriers, backoff timers, pending approvals,
   * reconcile receipts and the recovery decision/attempt history.
   * Read-only; every action an operator can legitimately take is via
   * existing canonical endpoints (approvals, reconcile, lifecycle).
   */
  recoveryOps(missionId: string): Record<string, unknown> {
    const rt = this.store.tryGet("mission_runtime", `MRT_${missionId}`);
    const barriers =
      ((rt?.barriers as Record<string, Record<string, unknown>> | undefined) ?? {});
    const receipts = this.store
      .list("reconciliation_receipt")
      .filter((r) => String((r.inputs as Record<string, unknown> | undefined)?.mission_id ?? "") === missionId)
      .sort((a, b) =>
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
      );
    const pendingApprovals = this.store
      .list("approval_request")
      .filter((a) => a.mission_id === missionId && a.status === "PENDING");
    return {
      // Request-echo scope marker (the UI validates it against the URL)
      // — NOT a canonical fact; mission_exists is the evidenced claim.
      mission_id: missionId,
      mission_exists: this.store.tryGet("mission", missionId) != null,
      runtime_state: rt ? String(rt.state) : null,
      pending_recovery: rt?.pending_recovery ?? null,
      deferred_recovery:
        (rt?.deferred_recovery as Array<Record<string, unknown>> | undefined) ?? [],
      barriers,
      backoff: this.store
        .list("scheduled_action")
        .filter(
          (a) =>
            a.mission_id === missionId &&
            ["SCHEDULED", "READY", "RUNNING"].includes(String(a.status)),
        )
        .map((a) => ({
          scheduled_action_id: a.scheduled_action_id,
          task_id: a.task_id ?? null,
          recovery_id: a.recovery_id ?? null,
          action: a.action,
          status: a.status,
          due_at: a.due_at,
        })),
      approvals_pending: pendingApprovals,
      decisions: this.store
        .list("recovery_decision")
        .filter((d) => d.mission_id === missionId),
      attempts: this.store
        .list("recovery_attempt")
        .filter((a) => a.mission_id === missionId),
      reconciliation_receipts: receipts.slice(-20),
      // Legitimate next actions — derived from canonical state only;
      // the UI must not invent operations beyond these seams.
      allowed_actions: {
        decide_approval: pendingApprovals.length > 0, // existing approval endpoints
        request_reconciliation:
          Object.values(barriers).some((b) => b.settled !== true) ||
          this.store
            .list("executor_execution")
            .some(
              (e) =>
                e.mission_id === missionId &&
                String(e.execution_state) === "UNKNOWN" &&
                !e.terminal_outcome,
            ),
        lifecycle: true, // pause/resume/cancel/acknowledge contract
      },
    };
  }

  /**
   * Business-level operations rollup — bounded aggregate counts only,
   * all derived from canonical rows. Distinct from metrics(): these are
   * the operator's "what needs attention" signals.
   */
  operationsOverview(): Record<string, unknown> {
    const runtimes = this.store.list("mission_runtime");
    const execs = this.store.list("executor_execution");
    const TERMINAL_RT = new Set(["COMPLETED", "FAILED", "CANCELLED", "ABORTED"]);
    const TERMINAL_EXEC = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
    // "Awaiting collection" = terminal-evidenced but result not yet
    // committed — collection DEBT, not healthy in-flight work (audit
    // R1-B M1: the sweep-eligibility set is wider than the debt set).
    const awaitingCollection = execs.filter(
      (e) =>
        e.result == null &&
        !e.terminal_outcome &&
        e.collect_excluded == null &&
        (TERMINAL_EXEC.has(String(e.execution_state)) ||
          e.first_terminal_observed_at != null),
    );
    const committedUnsettled = execs.filter(
      (e) =>
        e.result != null &&
        e.settle_complete !== true &&
        e.collect_excluded == null &&
        !e.terminal_outcome,
    );
    const activeRecovery = runtimes.filter((r) => r.pending_recovery != null);
    const deferred = runtimes.reduce(
      (n, r) =>
        n +
        ((r.deferred_recovery as Array<Record<string, unknown>> | undefined) ?? []).length,
      0,
    );
    const barriersOpen = runtimes.reduce(
      (n, r) =>
        n +
        Object.values(
          (r.barriers as Record<string, Record<string, unknown>> | undefined) ?? {},
        ).filter((b) => b.settled !== true).length,
      0,
    );
    const exhaustion = runtimes.filter((r) => {
      const p = r.pending_recovery as Record<string, unknown> | null;
      const action = String(p?.action ?? "");
      return (
        ["HUMAN_APPROVAL_REQUIRED", "ABORT", "REPLAN"].includes(action) ||
        String(r.state) === "WAITING_APPROVAL"
      );
    });
    const workItems = this.store.list("work_item");
    return {
      // Runtime-row count in ANY supervised live state — deliberately
      // named differently from metrics().missions_running (which counts
      // mission.status) so the two surfaces can never be conflated.
      missions_active: runtimes.filter(
        (r) => !TERMINAL_RT.has(String(r.state)) && String(r.state) !== "PAUSED",
      ).length,
      missions_paused: runtimes.filter((r) => String(r.state) === "PAUSED").length,
      executions_awaiting_collection: awaitingCollection.length,
      executions_committed_unsettled: committedUnsettled.length,
      recoveries_active: activeRecovery.length,
      recoveries_deferred: deferred,
      reconciliation_barriers_open: barriersOpen,
      approvals_pending: this.store
        .list("approval_request")
        .filter((a) => a.status === "PENDING").length,
      executions_orphan_unobservable: execs.filter(
        (e) => e.orphan_unobservable_final === true,
      ).length,
      // "Never observed" = zero SUCCESSFUL observes — the canonical
      // observe_count, matching the per-row NEVER_OBSERVED flag. A row
      // whose only observations faulted counts here too (audit R1-B M2).
      executions_never_observed: execs.filter(
        (e) =>
          !TERMINAL_EXEC.has(String(e.execution_state)) &&
          !e.terminal_outcome &&
          Number(e.observe_count ?? 0) === 0,
      ).length,
      recovery_blocked_or_escalated: exhaustion.length,
      work_items_blocked: workItems.filter(
        (w) => String(w.status) === "BLOCKED",
      ).length,
      ...this.livenessLatencies(),
    };
  }

  /** Per-subsystem health — never collapses auth/quota/policy into DOWN. */
  health(): Record<string, { state: HealthState; detail: string }> {
    const h: Record<string, { state: HealthState; detail: string }> = {};
    try {
      this.store.list("mission").length;
      h.DB = { state: "READY", detail: "pair.db readable" };
    } catch {
      h.DB = { state: "UNAVAILABLE", detail: "store unreadable" };
    }
    const runtimes = this.store.list("mission_runtime");
    const blocked = runtimes.filter(
      (r) => r.state === "WAITING_APPROVAL" || r.state === "RECONCILING",
    ).length;
    h.MISSION_RUNTIME = {
      state: runtimes.length === 0 ? "READY" : blocked > 0 ? "DEGRADED" : "READY",
      detail: `${runtimes.length} runtime(s), ${blocked} blocked`,
    };
    const executors = this.store.list("executor");
    const routable = projectRoutableExecutors(this.service);
    h.EXECUTORS = {
      state:
        routable.length > 0
          ? routable.length < executors.length
            ? "DEGRADED"
            : "READY"
          : executors.length === 0
            ? "UNKNOWN"
            : "UNAVAILABLE",
      detail: `${routable.length}/${executors.length} routable`,
    };
    for (const ex of executors) {
      const md = (ex.metadata as Record<string, unknown>) ?? {};
      const health = String(ex.health_state ?? ex.health ?? "UNKNOWN");
      const q = String(md.qualification_state ?? ex.qualification_state ?? "UNKNOWN");
      const state: HealthState =
        q !== "QUALIFIED"
          ? "BLOCKED"
          : health === "READY"
            ? "READY"
            : health === "DEGRADED"
              ? "DEGRADED"
              : health === "UNAVAILABLE"
                ? "UNAVAILABLE"
                : "UNKNOWN";
      h[`EXECUTOR:${String(ex.executor_id)}`] = { state, detail: `health=${health} qualification=${q}` };
    }
    const pendingApprovals = this.store
      .list("approval_request")
      .filter((a) => a.status === "PENDING").length;
    h.APPROVAL_QUEUE = {
      state: "READY",
      detail: `${pendingApprovals} pending`,
    };
    const scheduled = this.store
      .list("scheduled_action")
      .filter((a) => a.status === "SCHEDULED" || a.status === "READY").length;
    h.SCHEDULER = { state: "READY", detail: `${scheduled} pending action(s)` };
    return h;
  }

  /** Aggregate metrics — counts only, derived at read time. */
  metrics(): Record<string, number> {
    const count = (t: string, pred?: (r: Record<string, unknown>) => boolean) =>
      this.store.list(t).filter(pred ?? (() => true)).length;
    return {
      missions_total: count("mission"),
      missions_running: count("mission", (m) => m.status === "RUNNING"),
      missions_terminal: count("mission", (m) =>
        ["COMPLETED", "FAILED", "CANCELLED"].includes(String(m.status)),
      ),
      tasks_total: count("task"),
      tasks_completed: count("task", (t) => t.status === "COMPLETED"),
      executions_total: count("executor_execution"),
      executions_completed: count("executor_execution", (e) => e.execution_state === "COMPLETED"),
      executions_failed: count("executor_execution", (e) =>
        ["FAILED", "TIMEOUT"].includes(String(e.execution_state)),
      ),
      recovery_decisions: count("recovery_decision"),
      approvals_pending: count("approval_request", (a) => a.status === "PENDING"),
      approvals_total: count("approval_request"),
      scheduled_pending: count("scheduled_action", (a) =>
        ["SCHEDULED", "READY"].includes(String(a.status)),
      ),
      // P18.3 — collection liveness gauges. `never_observed` is the
      // incident class P18.3 removes (terminal evidence on disk,
      // canonical row never observed); `in_flight` is the live sweep
      // workload; `orphan_unobservable` is the bounded-reprobe terminal
      // classification; `recovery_deferred` counts failures queued
      // behind an in-flight pending_recovery.
      executions_in_flight: count("executor_execution", (e) =>
        !["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
          String(e.execution_state),
        ) && !e.terminal_outcome,
      ),
      executions_never_observed: count("executor_execution", (e) =>
        !e.terminal_outcome &&
        !e.last_observation &&
        !["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
          String(e.execution_state),
        ),
      ),
      executions_orphan_unobservable: count(
        "executor_execution",
        (e) => e.orphan_unobservable_final === true,
      ),
      recovery_deferred_pending: this.store
        .list("mission_runtime")
        .reduce(
          (n, r) =>
            n +
            ((r.deferred_recovery as Array<Record<string, unknown>> | undefined) ?? [])
              .length,
          0,
        ),
      ...this.livenessLatencies(),
      evidence_records: this.store.listEvidence().length,
      experiences_total: count("experience"),
      selfmod_candidates: count("selfmod_candidate"),
    };
  }

  /** P18.3 — canonical latency chain, derived only from persisted
   *  timestamps (never inferred): dispatch → first_terminal_observed
   *  (detection), first_terminal_observed → collection_committed
   *  (collection), first_terminal_observed → settled (end-to-end). */
  private livenessLatencies(): Record<string, number> {
    const rows = this.store.list("executor_execution");
    const deltas = (a: keyof Record<string, unknown>, b: keyof Record<string, unknown>) =>
      rows
        .map((e) => {
          const d = Date.parse(String(e[b] ?? "")) - Date.parse(String(e[a] ?? ""));
          return Number.isFinite(d) && d >= 0 ? d : null;
        })
        .filter((x): x is number => x != null)
        .sort((x, y) => x - y);
    const pct = (xs: number[], q: number) =>
      xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : 0;
    const det = deltas("dispatch_timestamp", "first_terminal_observed_at");
    const col = deltas("first_terminal_observed_at", "collection_committed_at");
    const end = deltas("first_terminal_observed_at", "settled_at");
    return {
      liveness_detect_ms_p50: pct(det, 0.5),
      liveness_detect_ms_p95: pct(det, 0.95),
      liveness_detect_ms_max: det.length ? det[det.length - 1]! : 0,
      liveness_collect_ms_p50: pct(col, 0.5),
      liveness_collect_ms_p95: pct(col, 0.95),
      liveness_settle_ms_p50: pct(end, 0.5),
      liveness_settle_ms_p95: pct(end, 0.95),
      liveness_settle_ms_max: end.length ? end[end.length - 1]! : 0,
    };
  }
}
