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
      evidence_records: this.store.listEvidence().length,
      experiences_total: count("experience"),
      selfmod_candidates: count("selfmod_candidate"),
    };
  }
}
