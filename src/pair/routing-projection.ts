/**
 * routing_projection — READ-ONLY derived "routable" view.
 *
 * Port of donor routing_projection.py semantics (a557df2) at the executor
 * level: for each registered executor descriptor the projection derives
 * routable(bool) + per-gate PASS/FAIL from durable state — never stored,
 * never asserted by executors. A newly registered executor must NOT appear
 * routable until every gate passes; reason_not_routable reports the first
 * failing gate.
 *
 * The donor's model-catalog gates (provider access, model qualification,
 * availability conditions) map to P3's executor-level equivalents; the
 * provider/model catalog itself is deferred to the discovery phase.
 */

import type { PairControlPlane } from "./service.js";
import { ExecutorRegistry } from "./executor-registry.js";
import type { RouteRegistry } from "./route-registry.js";

export interface RoutableRow {
  executor_id: string;
  routable: boolean;
  stage: string;
  gates: Record<string, "PASS" | "FAIL">;
  reason_not_routable: string | null;
}

export function projectRoutableExecutors(service: PairControlPlane): RoutableRow[] {
  const registry = new ExecutorRegistry(service);
  const routes: RouteRegistry = service.routes;
  const bindings = routes.listBindings();
  const rows: RoutableRow[] = [];

  for (const record of service.listExecutors()) {
    const descriptor = registry.normalizeDescriptor(record);
    const executorId = String(descriptor.executor_id);
    const gates: Record<string, "PASS" | "FAIL"> = {};

    gates.REGISTERED = record.status !== "DISABLED" ? "PASS" : "FAIL";
    gates.HEALTH_READY = descriptor.health_state === "READY" ? "PASS" : "FAIL";
    gates.QUALIFIED = descriptor.qualification_state === "QUALIFIED" ? "PASS" : "FAIL";
    gates.EXISTING_ROUTE_BINDING = bindings.some(
      (b) => b.executor_id === executorId && b.qualification_state === "QUALIFIED",
    )
      ? "PASS"
      : "FAIL";
    gates.BOUND_ROUTE_ENABLED = bindings.some((b) => {
      if (b.executor_id !== executorId || b.qualification_state !== "QUALIFIED") return false;
      const route = routes.getRoute(String(b.route_id));
      return (
        !!route &&
        route.enabled !== false &&
        route.qualification_state === "QUALIFIED" &&
        !["DISABLED", "RETIRED"].includes(String(route.eligibility_state))
      );
    })
      ? "PASS"
      : "FAIL";

    const reason = Object.keys(gates).find((g) => gates[g] === "FAIL") ?? null;
    rows.push({
      executor_id: executorId,
      routable: reason === null,
      stage: reason === null ? "ROUTABLE" : String(descriptor.qualification_state ?? "REGISTERED"),
      gates,
      reason_not_routable: reason,
    });
  }
  return rows;
}
