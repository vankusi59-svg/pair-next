/**
 * RouteLedger — invocation telemetry + route health, executor-level.
 *
 * Ports the executor-relevant slice of donor route_ledger.py (a557df2):
 * append-only invocation events and route health updates, strictly separate
 * from executor health. The donor's budget reservations / account pools /
 * subscription scheduler are supply-side and deferred — P3 has no accounts
 * or quotas (provider/model discovery is a later phase).
 */

import { newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import type { RouteRegistry } from "./route-registry.js";

const EWMA_ALPHA = 0.35;
const DEFAULT_COOLDOWN_SECONDS = 60;

export class RouteLedger {
  constructor(private readonly service: PairControlPlane) {}

  private get registry(): RouteRegistry {
    return this.service.routes;
  }

  /**
   * Append one append-only invocation event (route_invocation entity +
   * store event) and fold it into route health (EWMA latency, consecutive
   * failures, cooldown on rate-limit). Distinct from executor health.
   */
  recordInvocation(params: {
    route_id: string;
    decision_id?: string | null;
    event_kind: string; // INVOCATION_SUCCESS | INVOCATION_FAILURE | ...
    latency_ms?: number | null;
    error_code?: string | null;
    correlation_id?: string | null;
    mission_id?: string | null;
  }): Record<string, unknown> {
    const route = this.registry.getRoute(params.route_id);
    const invocation = {
      schema: "pair.os.vnext.route-invocation.v1",
      invocation_id: newId("RINV"),
      route_id: params.route_id,
      decision_id: params.decision_id ?? null,
      event_kind: params.event_kind,
      latency_ms: params.latency_ms ?? null,
      error_code: params.error_code ?? null,
      correlation_id: params.correlation_id ?? null,
      mission_id: params.mission_id ?? null,
      created_at: utcnow(),
    };
    this.service.store.put("route_invocation", String(invocation.invocation_id), invocation, 0);
    this.service.store.event({
      entity_type: "route_invocation",
      entity_id: String(invocation.invocation_id),
      event_type: params.event_kind,
      new_state: params.route_id,
      actor: "PAIR_ROUTE_LEDGER",
      correlation_id: params.correlation_id ?? undefined,
    });

    if (route) {
      const health = { ...((route.health as Record<string, unknown>) ?? {}) };
      const patch: Record<string, unknown> = {
        last_event_kind: params.event_kind,
        last_error_code: params.error_code ?? null,
      };
      if (params.event_kind === "INVOCATION_SUCCESS") {
        patch.state = "READY";
        patch.consecutive_failures = 0;
        patch.cooldown_until = null;
        patch.last_success_at = utcnow();
        const prev = health.latency_ewma_ms;
        if (params.latency_ms != null) {
          patch.latency_ewma_ms =
            prev == null
              ? Number(params.latency_ms)
              : Math.round(
                  (EWMA_ALPHA * params.latency_ms + (1 - EWMA_ALPHA) * Number(prev)) * 100,
                ) / 100;
        }
      } else {
        patch.consecutive_failures = Number(health.consecutive_failures ?? 0) + 1;
        if (params.error_code === "AI_PROVIDER_RATE_LIMIT") {
          patch.state = "COOLDOWN";
          patch.cooldown_until = new Date(
            Date.now() + DEFAULT_COOLDOWN_SECONDS * 1000,
          ).toISOString();
        } else if (
          params.error_code === "AI_PROVIDER_AUTH_FAILED" ||
          params.error_code === "AI_PROVIDER_AUTH_REQUIRED"
        ) {
          patch.state = "AUTH_REQUIRED";
        } else {
          patch.state = "DEGRADED";
        }
      }
      this.registry.updateRouteHealth(params.route_id, patch);
    }
    return invocation;
  }

  listInvocations(routeId?: string): Array<Record<string, unknown>> {
    const all = this.service.store.list("route_invocation");
    return routeId ? all.filter((i) => i.route_id === routeId) : all;
  }
}
