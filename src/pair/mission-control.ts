/**
 * P9 MissionControl — operator-facing read models + actions.
 *
 * Every action delegates to the canonical authority (MissionRuntime,
 * ApprovalQueue, ReconciliationService, SelfImprovementController,
 * MissionSupervisor). This layer never mutates a DB row directly and never
 * exposes credentials or env dumps — only entity projections.
 */

import { PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { MissionSupervisor, WakeReason } from "./mission-supervisor.js";
import type { MissionScheduler } from "./mission-scheduler.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { MissionObservability } from "./mission-observability.js";
import type { SelfImprovementController } from "./self-improvement.js";
import { projectRoutableExecutors } from "./routing-projection.js";

export interface MissionControlDeps {
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  scheduler: MissionScheduler;
  approvals: ApprovalQueue;
  reconciliation: ReconciliationService;
  observability: MissionObservability;
  selfmod?: SelfImprovementController;
}

function requireOperator(operatorId: string | undefined): string {
  if (!operatorId || !operatorId.trim()) {
    throw new PolicyError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "mission_control");
  }
  return operatorId;
}

export class MissionControl {
  constructor(private readonly deps: MissionControlDeps) {}

  private get store() {
    return this.deps.service.store;
  }

  /* ---------------- read models ------------------------------------------ */

  projects(): Array<Record<string, unknown>> {
    return this.store.list("project");
  }

  missions(): Array<Record<string, unknown>> {
    return this.store.list("mission").map((m) => {
      const rt = this.store.tryGet("mission_runtime", `MRT_${String(m.mission_id)}`);
      return { ...m, runtime_state: rt ? rt.state : null };
    });
  }

  missionDetail(missionId: string) {
    return this.deps.observability.missionSummary(missionId);
  }

  missionDag(missionId: string) {
    const tasks = this.deps.service.listTasks(missionId);
    return {
      nodes: tasks.map((t) => ({
        task_id: t.task_id,
        task_key: t.task_key,
        title: t.title,
        status: t.status,
        selected_executor: t.selected_executor,
        plan_id: t.plan_id,
        order: t.order,
      })),
      edges: tasks.flatMap((t) =>
        ((t.depends_on as string[]) ?? []).map((dep) => {
          const depTask = tasks.find((d) => d.task_key === dep);
          return { from: depTask?.task_id ?? dep, to: t.task_id };
        }),
      ),
    };
  }

  timeline(missionId: string) {
    return this.deps.observability.missionTimeline(missionId);
  }

  routing() {
    return {
      routable: projectRoutableExecutors(this.deps.service),
      executors: this.store.list("executor"),
      routes: this.store.list("route"),
      bindings: this.store.list("executor_binding"),
    };
  }

  recovery() {
    return {
      decisions: this.store.list("recovery_decision"),
      attempts: this.store.list("recovery_attempt"),
      scheduled: this.store.list("scheduled_action"),
    };
  }

  approvals() {
    return this.store.list("approval_request");
  }

  evidence(missionId: string) {
    return this.store
      .list("evidence")
      .filter((e) => e.mission_id === missionId);
  }

  experience() {
    return {
      experiences: this.store.list("experience"),
      advisor_decisions: this.store.list("advisor_decision"),
    };
  }

  selfImprovement() {
    return {
      candidates: this.store.list("selfmod_candidate"),
      validations: this.store.list("selfmod_validation_receipt"),
      promotions: this.store.list("promotion_candidate"),
    };
  }

  health() {
    return this.deps.observability.health();
  }

  metrics() {
    return this.deps.observability.metrics();
  }

  /* ---------------- operator actions -------------------------------------- */

  /** Create + queue a mission for orchestration. */
  startMission(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    operator_id?: string;
  }): Record<string, unknown> {
    const mission = this.deps.service.createMission({
      project_id: input.project_id,
      goal: input.goal,
      metadata: input.metadata ?? {},
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: input.authorized_workspaces,
      risk_ceiling: input.risk_ceiling,
    });
    this.deps.runtime.runtimeEntity(String(mission.mission_id));
    this.deps.supervisor.wake(String(mission.mission_id), "MISSION_CREATED");
    return mission;
  }

  pauseMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.pause(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { detail: "pause" });
    return rt;
  }

  resumeMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.resume(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { operator: op });
    return rt;
  }

  cancelMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    return this.deps.runtime.cancel(missionId, op);
  }

  approve(approvalId: string, operatorId: string | undefined, scope: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    const decision = this.deps.approvals.decide(approvalId, op, "APPROVED", scope, reason);
    const a = this.deps.approvals.get(approvalId);
    if (a.mission_id) {
      this.deps.supervisor.wake(String(a.mission_id), "APPROVAL_GRANTED", {
        approval_id: approvalId,
      });
    }
    return decision;
  }

  deny(approvalId: string, operatorId: string | undefined, scope: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    return this.deps.approvals.decide(approvalId, op, "DENIED", scope, reason);
  }

  requestReconciliation(missionId: string, operatorId?: string, executionId?: string) {
    const op = requireOperator(operatorId);
    const receipt = this.deps.reconciliation.reconcile({
      mission_id: missionId,
      execution_id: executionId,
      correlation_id: `operator:${op}`,
    });
    this.deps.supervisor.wake(missionId, "RECONCILIATION_RESULT", {
      operator: op,
      outcome: receipt.outcome,
    });
    return receipt;
  }

  acknowledgeTerminal(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.store.tryGet("mission_runtime", `MRT_${missionId}`);
    if (!rt) throw new PolicyError("FAIL_CLOSED_MISSION_RUNTIME_NOT_FOUND", missionId);
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: `MRT_${missionId}`,
      event_type: "TERMINAL_ACKNOWLEDGED",
      actor: `OPERATOR:${op}`,
      metadata: { mission_id: missionId },
    });
    return rt;
  }

  /** Wake a mission for a scheduler-visible reason. */
  wake(missionId: string, reason: WakeReason, detail: Record<string, unknown> = {}) {
    return this.deps.supervisor.wake(missionId, reason, detail);
  }

  /** Tick all live missions once. */
  tick(now?: string) {
    return this.deps.supervisor.tick(now);
  }

  /* ---------------- promotion actions -------------------------------------- */

  approvePromotion(promotionId: string, operatorId: string | undefined) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.approvePromotion(promotionId, op);
  }

  rejectPromotion(promotionId: string, operatorId: string | undefined, reason: string) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.rejectPromotion(promotionId, reason);
  }
}
