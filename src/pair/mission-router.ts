/**
 * MissionRouter — the ONE canonical mission-level routing authority.
 *
 * Chains the P3 seam exactly as the spec's target flow:
 *
 *   task entity → CapabilityRouter (executor eligibility, DISPATCH mode)
 *               → RouteSelector (route eligibility + binding, persisted)
 *               → task.selected_executor binding (routing evidence)
 *               → GovernedTaskGate (authorization — cannot be bypassed)
 *               → selected ExecutorAdapter → PAIR_NATIVE → LocalWorkerPool
 *
 * No eligible executor or route fails CLOSED — no silent fallback to direct
 * LocalWorkerPool execution, and no path exists around GovernedTaskGate.
 * Automaton's inference routing remains executor-internal plumbing only and
 * participates in none of this selection.
 */

import type { ExecutorAdapter } from "./adapter.js";
import { CapabilityRouter } from "./capability-router.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { GovernedTaskGate } from "./gate.js";
import { RouteLedger } from "./route-ledger.js";
import { RouteSelector } from "./route-selector.js";
import type { PairControlPlane } from "./service.js";

export class MissionRouter {
  readonly capabilityRouter: CapabilityRouter;
  readonly routeSelector: RouteSelector;
  readonly ledger: RouteLedger;

  constructor(
    private readonly service: PairControlPlane,
    private readonly gate: GovernedTaskGate,
  ) {
    this.capabilityRouter = new CapabilityRouter(service);
    this.routeSelector = new RouteSelector(service);
    this.ledger = new RouteLedger(service);
  }

  /** Find an already-governed task for idempotent re-dispatch. */
  private existingGovernedTask(
    taskId: string,
    planRevision: number,
  ): Record<string, unknown> | null {
    return (
      this.service.store
        .list("governed_task")
        .find(
          (g) =>
            g.task_id === taskId && Number(g.plan_revision) === planRevision,
        ) ?? null
    );
  }

  /**
   * Canonical mission routing: select executor → select route → bind →
   * authorize → dispatch. Returns the persisted decision receipts plus the
   * governed task and execution entities.
   */
  routeGovernedTask(
    request: Record<string, unknown>,
    adapters: Map<string, ExecutorAdapter>,
  ): Record<string, unknown> {
    const taskId = String(request.task_id);
    const missionId = String(request.mission_id);
    const correlationId = String(request.correlation_id ?? "");
    const task = this.service.getTask(taskId);
    const active = this.service.activeRevision(missionId);

    // Idempotency: a governed task already bound for this plan revision is
    // adopted, not duplicated — dispatch dedup then yields the same execution.
    const existing = this.existingGovernedTask(taskId, active.revision);
    if (existing) {
      const executorId = String(existing.executor_id);
      const adapter = adapters.get(executorId);
      if (!adapter) {
        throw new PolicyError("FAIL_CLOSED_ADAPTER_NOT_BOUND", executorId);
      }
      const authorized =
        existing.governance_state === "DISPATCH_AUTHORIZED"
          ? existing
          : this.gate.authorize_dispatch(adapter, String(existing.governed_task_id));
      const execution = this.gate.dispatch_governed_task(
        adapter,
        String(authorized.governed_task_id),
      );
      return {
        adopted: true,
        routing_decision: null,
        route_decision: null,
        governed_task: authorized,
        execution,
      };
    }

    // 1. Executor eligibility — DISPATCH mode (all 12 gates, live qualify).
    const routingDecision = this.capabilityRouter.route(task, {
      adapters,
      mode: "DISPATCH",
      correlationId,
      requiredPermissions: new Set(
        ((request.permissions as string[]) ?? []).map((p) => String(p).toUpperCase()),
      ),
    });
    const selectedExecutor = routingDecision.selected_executor;
    if (!selectedExecutor) {
      this.service.store.appendEvidence(missionId, "ROUTING_FAILED", {
        routing_decision_id: routingDecision.routing_decision_id,
        rejected: routingDecision.rejected_executors,
      });
      throw new PolicyError(
        "FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR",
        JSON.stringify(routingDecision.rejected_executors),
      );
    }
    const adapter = adapters.get(String(selectedExecutor));
    if (!adapter) {
      throw new PolicyError("FAIL_CLOSED_ADAPTER_NOT_BOUND", String(selectedExecutor));
    }

    // 2. Route selection — executor-bound, persisted route_decision receipt.
    const firstCapability =
      ((task.required_capabilities as string[]) ?? [])[0] ?? undefined;
    const routeDecision = this.routeSelector.select({
      executor_id: String(selectedExecutor),
      capability: firstCapability,
      mission_id: missionId,
      task_id: taskId,
      correlation_id: correlationId,
    });
    if (!routeDecision.selected_route_id) {
      this.service.store.appendEvidence(missionId, "ROUTING_FAILED", {
        route_decision_id: routeDecision.decision_id,
        reason_codes: routeDecision.reason_codes,
      });
      throw new PolicyError(
        "FAIL_CLOSED_NO_ELIGIBLE_ROUTE",
        JSON.stringify(routeDecision.hard_rejections),
      );
    }

    // 3. Bind the routing outcome onto the task — the gate then proves the
    //    adapter that dispatches is the executor routing selected.
    this.service.updateTask(taskId, {
      selected_executor: selectedExecutor,
      status: "ROUTED",
      routing_decision_id: routingDecision.routing_decision_id,
      route_decision_id: routeDecision.decision_id,
      selected_route_id: routeDecision.selected_route_id,
      binding_id: routeDecision.selected_binding_id,
    });
    this.service.store.event({
      entity_type: "task",
      entity_id: taskId,
      event_type: "ROUTE_BOUND",
      new_state: String(selectedExecutor),
      actor: "PAIR_MISSION_ROUTER",
      correlation_id: correlationId,
      metadata: {
        routing_decision_id: routingDecision.routing_decision_id,
        route_decision_id: routeDecision.decision_id,
        binding_id: routeDecision.selected_binding_id,
      },
    });
    this.service.store.appendEvidence(missionId, "ROUTE_BOUND", {
      task_id: taskId,
      routing_decision_id: routingDecision.routing_decision_id,
      route_decision_id: routeDecision.decision_id,
      selected_executor: selectedExecutor,
      selected_route_id: routeDecision.selected_route_id,
      binding_id: routeDecision.selected_binding_id,
      binding_mechanism: routeDecision.binding_mechanism,
    });

    // 4–5. Authorization + dispatch through the gate — the only dispatch path.
    const { governed_task } = this.gate.create_governed_task(adapter, request);
    const authorized = this.gate.authorize_dispatch(
      adapter,
      String(governed_task.governed_task_id),
    );
    const execution = this.gate.dispatch_governed_task(
      adapter,
      String(authorized.governed_task_id),
    );

    this.ledger.recordInvocation({
      route_id: String(routeDecision.selected_route_id),
      decision_id: String(routeDecision.decision_id),
      event_kind: "INVOCATION_DISPATCHED",
      correlation_id: correlationId,
      mission_id: missionId,
    });

    return {
      adopted: false,
      routing_decision: routingDecision,
      route_decision: routeDecision,
      governed_task: authorized,
      execution,
    };
  }

  /** Record the terminal outcome of a routed execution in route telemetry. */
  recordTerminalOutcome(
    routeId: string,
    execution: Record<string, unknown>,
    latencyMs?: number,
  ): void {
    const terminal = String(execution.execution_state ?? execution.result_state ?? "");
    this.ledger.recordInvocation({
      route_id: routeId,
      event_kind:
        terminal === "COMPLETED" ? "INVOCATION_SUCCESS" : "INVOCATION_FAILURE",
      latency_ms: latencyMs ?? null,
      error_code:
        terminal === "COMPLETED"
          ? null
          : String(
              ((execution.result as Record<string, unknown>)?.error as Record<string, unknown>)
                ?.class ?? terminal ?? "UNKNOWN",
            ),
      correlation_id: String(execution.correlation_id ?? ""),
      mission_id: String(execution.mission_id ?? ""),
    });
  }

  /** Tamper-detect a stored routing decision receipt (verify-on-read+digest). */
  verifyRoutingDecision(decisionId: string): boolean {
    const decision = this.service.store.get("routing_decision", decisionId);
    return this.capabilityRouter.verifyDecisionDigest(decision);
  }
}
