/**
 * Real multi-executor registration + routing seeding (P5).
 *
 * Discovery/configuration NEVER implies routability. An executor becomes
 * routable only after: probe available → live qualification pass → canonical
 * identity match (registry check) → route + supply binding seeded with
 * binding_state=QUALIFIED. Any earlier state produces only the executor
 * record with capability:[] — no route, no binding, no dispatch path.
 */

import type { PairControlPlane } from "./service.js";
import { ExecutorRegistry } from "./executor-registry.js";
import type { ExecutorAdapter } from "./adapter.js";

export const ROUTE_IDS: Record<string, string> = {
  DEEPSEEK_HARNESS: "RTE_DSH_ACP",
  CODEX: "RTE_CODEX_CLI",
  CODEX_ACP: "RTE_CODEX_ACP",
  DEVIN: "RTE_DEVIN_API",
};

const ROUTE_KINDS_BY_EXECUTOR: Record<string, string> = {
  DEEPSEEK_HARNESS: "REMOTE_GATEWAY_API",
  CODEX: "REMOTE_GATEWAY_API",
  CODEX_ACP: "REMOTE_GATEWAY_API",
  DEVIN: "REMOTE_GATEWAY_API",
};

const BINDING_MECHANISM_BY_EXECUTOR: Record<string, string> = {
  DEEPSEEK_HARNESS: "SPAWN_ENV",
  CODEX: "SPAWN_ENV",
  CODEX_ACP: "SPAWN_ENV",
  DEVIN: "AMBIENT_FIXED",
};

export interface RegisteredExecutors {
  registered: string[];
  routable: string[];
  unavailable: Array<{ executor_id: string; reasons: string[] }>;
}

export function registerGovernedExecutors(
  service: PairControlPlane,
  adapters: Map<string, ExecutorAdapter>,
  actor = "PAIR_P5_MULTI_EXECUTOR",
  options: { priorities?: Record<string, number> } = {},
): RegisteredExecutors {
  const registry = new ExecutorRegistry(service);
  const registered: string[] = [];
  const routable: string[] = [];
  const unavailable: Array<{ executor_id: string; reasons: string[] }> = [];

  for (const [executorId, adapter] of adapters) {
    if (executorId === "PAIR_NATIVE") continue; // PAIR_NATIVE seeds via seedPairNativeRoute
    const probe = adapter.probe();
    const qualification = adapter.qualify();
    const qualified = qualification.qualified === true;
    const capOut = adapter.capabilities();
    const capabilities =
      (capOut.capability_ids as string[]) ?? (capOut.capabilities as string[]) ?? [];

    registry.register(
      {
        executor_id: executorId,
        executor_type: (adapter as { runtime_type?: string }).runtime_type ?? "EXTERNAL",
        capabilities: qualified ? capabilities : [],
        health_state: qualified ? "READY" : "DEGRADED",
        availability_state: probe.available === true ? "AVAILABLE" : "UNAVAILABLE",
        status: "ENABLED",
        metadata: {
          qualification_state: qualified ? "QUALIFIED" : "UNQUALIFIED",
          permission_modes: qualified
            ? (probe.permission_modes ?? ["READ", "WRITE", "FILE_READ", "FILE_WRITE"])
            : [],
          workspace_modes: qualified ? ["EXPLICIT_WORKSPACE"] : [],
          supports_cancel: true,
          max_concurrency: 4,
          routing_priority: options.priorities?.[executorId] ?? 50,
          probe,
          qualification,
        },
      },
      actor,
    );
    registered.push(executorId);
    // Capability authority is per-BINDING and independent of qualification:
    // binding.capabilities = executor declaration ∩ route ceiling. Every
    // existing binding is recomputed BEFORE the qualification early-exit so
    // an unqualified boot can never leave a stale effective set (and a
    // never-qualified executor has no bindings, so nothing is minted).
    // Order-independent: each binding reconciles against its own route's
    // ceiling, so shared routes never flip between executors.
    service.routes.reconcileExecutorBindings(executorId, capabilities, actor);
    if (!qualified) {
      unavailable.push({
        executor_id: executorId,
        reasons: (qualification.reasons as string[]) ?? ["UNQUALIFIED"],
      });
      continue;
    }

    const routeId = ROUTE_IDS[executorId];
    if (!routeId) continue; // no canonical mint; bound routes already synced above
    let route = service.routes.getRoute(routeId);
    if (!route) {
      route = service.routes.registerRoute(
        {
          route_id: routeId,
          route_kind: ROUTE_KINDS_BY_EXECUTOR[executorId] ?? "REMOTE_GATEWAY_API",
          enabled: true,
          eligibility_state: "QUALIFIED",
          qualification_state: "QUALIFIED",
          capabilities: [],
          capability_source: "EXECUTOR_DECLARED", // unrestricted-by-route
          priority: 50,
          executor_hint: executorId,
          metadata: {
            executor_kind: String((adapter as { runtime_type?: string }).runtime_type ?? "EXTERNAL"),
            transport: executorId === "DEVIN"
              ? "REMOTE_API"
              : String((probe as { runtime_type?: string }).runtime_type ?? "").includes("ACP")
                ? "ACP_STDIO"
                : "NATIVE_CLI",
          },
        },
        actor,
      );
    } else {
      // Registration/catalog seam: normalize the persisted route's
      // constraint (executor-minted ⇒ unrestricted EXECUTOR_DECLARED) so an
      // entity minted under an older model can never stay silently stale
      // across upgrades (live incident MSN_01M3VSGWVC55YNKHAQY6VVJAXR).
      service.routes.reconcileRouteConstraint(routeId, actor);
    }
    if (!service.routes.bindingFor(executorId, routeId)) {
      service.routes.registerBinding(
        {
          executor_id: executorId,
          route_id: routeId,
          mechanism: BINDING_MECHANISM_BY_EXECUTOR[executorId] ?? "SPAWN_ENV",
          qualification_state: "QUALIFIED",
        },
        actor,
      );
    }
    // Reconcile once more: a binding minted this cycle wasn't covered by
    // the pre-exit pass above. Idempotent — no-op when already converged.
    service.routes.reconcileExecutorBindings(executorId, capabilities, actor);
    routable.push(executorId);
  }
  return { registered, routable, unavailable };
}
