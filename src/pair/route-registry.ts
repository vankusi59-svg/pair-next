/**
 * RouteRegistry — canonical route + executor_supply_binding store.
 *
 * Ports the executor-facing slice of donor route_registry.py (a557df2):
 * route entities, executor→route supply bindings, qualification states,
 * enable/disable, health updates, and a deterministic registry snapshot
 * digest. The donor's provider/model supply-side sync (accounts, pools,
 * model catalog, DSH/Codex subscription sync) is out of P3 scope —
 * provider/model discovery is a later phase by spec.
 */

import { canonicalJson, digest, newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairControlPlane } from "./service.js";

export const ROUTE_SCHEMA = "pair.os.vnext.route.v1";
export const BINDING_SCHEMA = "pair.os.vnext.executor-supply-binding.v1";

/** Route kinds = transport/supply classes; never imply a fixed executor. */
export const ROUTE_KINDS = new Set([
  "DIRECT_API",
  "REMOTE_GATEWAY_API",
  "SUBSCRIPTION_EXECUTOR",
  /** vNext: in-process execution inside Automaton LocalWorkerPool. */
  "IN_PROCESS_RUNTIME",
]);

export const BINDING_MECHANISMS = new Set([
  "SET_CONFIG_OPTION",
  "SPAWN_ENV",
  "AMBIENT_FIXED",
  "CONFIG_INJECTION",
  /** vNext: executor invoked in-process (LocalWorkerPool/harness). */
  "IN_PROCESS",
  "UNSUPPORTED",
]);

export const QUALIFICATION_STATES = new Set(["DECLARED", "QUALIFIED", "FAIL_CLOSED"]);
/**
 * Capability authority is per-binding, never per-route (Direction A):
 *
 *   binding.capabilities = executor declaration ∩ route ceiling
 *
 *  - Route = transport/supply constraint, independent of any executor.
 *    `capability_source` records what `route.capabilities` means:
 *      EXECUTOR_DECLARED — unrestricted-by-route: `capabilities: []` means
 *        the route imposes NO ceiling; each bound executor inherits its own
 *        declaration. All executor-minted routes use this.
 *      ROUTE_EXPLICIT  — operator-declared ceiling: `capabilities` is the
 *        normalized `capabilities_declared` set; bound executors are
 *        clamped to it. `[]` here means the route supports nothing.
 *    Disambiguation is by `capability_source`, never by empty-array alone.
 *  - Binding = the executor↔route effective capability surface; reconciliation
 *    recomputes it from the live executor declaration every registration —
 *    order-independent, fail-closed on removals, never auto-widening an
 *    explicit route's ceiling.
 * A persisted route predating `capability_source` is executor-minted by
 * construction (only executor registration mints routes; /api/routes is
 * read-only), so reconcile treats it as EXECUTOR_DECLARED.
 */
export const CAPABILITY_SOURCES = new Set(["EXECUTOR_DECLARED", "ROUTE_EXPLICIT"]);
export const ELIGIBILITY_STATES = new Set([
  "REGISTERED",
  "QUALIFIED",
  "DISABLED",
  "QUOTA_EXHAUSTED",
  "COOLDOWN",
  "RETIRED",
]);

/** Route/account health states that must never serve governed traffic. */
export const REJECTED_ROUTE_HEALTH = new Set([
  "AUTH_REQUIRED",
  "CONFIG_REQUIRED",
  "DISABLED",
  "OFFLINE",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "COOLDOWN",
]);

/** Canonical vNext route for the PAIR_NATIVE executor. */
export const PAIR_NATIVE_ROUTE_ID = "RTE_PAIR_NATIVE_LOCAL";
export const PAIR_NATIVE_BINDING_ID = "BIND_PAIR_NATIVE__RTE_PAIR_NATIVE_LOCAL";

export class RouteRegistry {
  constructor(private readonly service: PairControlPlane) {}

  private get store() {
    return this.service.store;
  }

  private write(
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
    actor: string,
    event: string,
  ): Record<string, unknown> {
    let existing: Record<string, unknown> | null = null;
    try {
      existing = this.store.get(entityType, entityId);
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
    const body = { ...payload, updated_at: utcnow() };
    const saved = this.store.put(
      entityType,
      entityId,
      existing ? body : { ...body, created_at: utcnow() },
      existing ? Number(existing.version) : 0,
    );
    this.store.event({
      entity_type: entityType,
      entity_id: entityId,
      event_type: existing ? `${event}_UPDATED` : event,
      new_state: String(
        (body as Record<string, unknown>).qualification_state ??
          (body as Record<string, unknown>).eligibility_state ??
          "REGISTERED",
      ),
      actor,
    });
    return saved;
  }

  // ── routes ──────────────────────────────────────────────────────────

  registerRoute(payload: Record<string, unknown>, actor = "PAIR_ROUTE_REGISTRY"): Record<string, unknown> {
    const routeId = String(payload.route_id ?? "");
    if (!routeId) throw new IntegrityError("FAIL_CLOSED_ROUTE_FIELD", "route_id");
    const kind = String(payload.route_kind ?? "");
    if (!ROUTE_KINDS.has(kind)) {
      throw new IntegrityError("FAIL_CLOSED_ROUTE_KIND", kind);
    }
    const body = {
      schema: ROUTE_SCHEMA,
      route_id: routeId,
      route_kind: kind,
      enabled: payload.enabled !== false,
      eligibility_state: String(payload.eligibility_state ?? "REGISTERED"),
      qualification_state: String(payload.qualification_state ?? "DECLARED"),
      direct_callable: Boolean(payload.direct_callable),
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
      // Default ROUTE_EXPLICIT: an explicitly registered capability list is an
      // operator-declared contract — reconciliation never silently widens it.
      // Executor-minted routes pass EXECUTOR_DECLARED explicitly.
      capability_source: CAPABILITY_SOURCES.has(String(payload.capability_source))
        ? String(payload.capability_source)
        : "ROUTE_EXPLICIT",
      // Declared intent is preserved verbatim; effective = declared ⊆ executor
      // is derived at reconciliation. Default declared = the supplied list.
      capabilities_declared: Array.isArray(payload.capabilities_declared)
        ? payload.capabilities_declared
        : Array.isArray(payload.capabilities)
          ? payload.capabilities
          : [],
      priority: Number(payload.priority ?? 100) || 100,
      // Model routes: pin the bound model identity at top level so cost
      // governance resolves per-model pricing (modelRefForRoute).
      model_entry_id: payload.model_entry_id ?? null,
      model_id: payload.model_id ?? null,
      health: {
        state: String((payload.health as Record<string, unknown>)?.state ?? "READY"),
        cooldown_until: (payload.health as Record<string, unknown>)?.cooldown_until ?? null,
        consecutive_failures: Number((payload.health as Record<string, unknown>)?.consecutive_failures ?? 0),
        ...(payload.health as Record<string, unknown> | undefined),
      },
      executor_hint: payload.executor_hint ?? null,
      metadata: payload.metadata ?? {},
    };
    return this.write("route", routeId, body, actor, "ROUTE_REGISTERED");
  }

  getRoute(routeId: string): Record<string, unknown> | null {
    try {
      return this.store.get("route", routeId);
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_FOUND") return null;
      throw error;
    }
  }

  listRoutes(): Array<Record<string, unknown>> {
    return this.store.list("route");
  }

  qualifyRoute(routeId: string, evidence: Record<string, unknown>, actor = "LOCAL_OPERATOR"): Record<string, unknown> {
    const route = this.getRoute(routeId);
    if (!route) throw new IntegrityError("FAIL_CLOSED_ROUTE_MISSING", routeId);
    return this.write(
      "route",
      routeId,
      { ...route, qualification_state: "QUALIFIED", qualification_evidence: evidence },
      actor,
      "ROUTE_QUALIFIED",
    );
  }

  setRouteEnabled(routeId: string, enabled: boolean, actor = "LOCAL_OPERATOR"): Record<string, unknown> {
    const route = this.getRoute(routeId);
    if (!route) throw new IntegrityError("FAIL_CLOSED_ROUTE_MISSING", routeId);
    return this.write(
      "route",
      routeId,
      { ...route, enabled, eligibility_state: enabled ? "QUALIFIED" : "DISABLED" },
      actor,
      enabled ? "ROUTE_ENABLED" : "ROUTE_DISABLED",
    );
  }

  /**
   * Normalize a persisted route's capability CONSTRAINT (route-level, not
   * per-executor). Deterministic representation, disambiguated by
   * `capability_source`:
   *  - EXECUTOR_DECLARED (incl. pre-field legacy rows) → `capabilities: []`
   *    meaning unrestricted-by-route; effective caps live on each binding.
   *  - ROUTE_EXPLICIT → `capabilities` = the sorted, de-duplicated
   *    `capabilities_declared` ceiling — the max any binding may serve.
   * Idempotent: no semantic change → no write, no version churn, no event.
   */
  reconcileRouteConstraint(
    routeId: string,
    actor = "PAIR_ROUTE_REGISTRY",
  ): { route: Record<string, unknown>; changed: boolean } | null {
    const route = this.getRoute(routeId);
    if (!route) return null;
    const source = CAPABILITY_SOURCES.has(String(route.capability_source))
      ? String(route.capability_source)
      : "EXECUTOR_DECLARED"; // legacy executor-minted row
    const declared = [
      ...new Set(
        (((route.capabilities_declared as string[] | undefined) ??
          (route.capabilities as string[] | undefined) ??
          []) as string[])
          .map(String)
          .filter(Boolean),
      ),
    ].sort();
    const ceiling = source === "ROUTE_EXPLICIT" ? declared : [];
    const prior = ((route.capabilities as string[] | undefined) ?? []).map(String).sort();
    if (
      JSON.stringify(prior) === JSON.stringify(ceiling) &&
      String(route.capability_source ?? "EXECUTOR_DECLARED") === source
    ) {
      return { route, changed: false };
    }
    const body: Record<string, unknown> = {
      ...route,
      capabilities: ceiling,
      capability_source: source,
      capabilities_declared: source === "ROUTE_EXPLICIT" ? declared : [],
    };
    const saved = this.store.put("route", routeId, { ...body, updated_at: utcnow() }, Number(route.version));
    this.store.event({
      entity_type: "route",
      entity_id: routeId,
      event_type: "ROUTE_CAPABILITIES_RECONCILED",
      new_state: String(route.eligibility_state ?? route.qualification_state ?? "REGISTERED"),
      actor,
      metadata: { capability_source: source, constraint: ceiling },
    });
    return { route: saved, changed: true };
  }

  /** Route capability ceiling: null = unrestricted-by-route. */
  private routeCeiling(route: Record<string, unknown>): Set<string> | null {
    const source = CAPABILITY_SOURCES.has(String(route.capability_source))
      ? String(route.capability_source)
      : "EXECUTOR_DECLARED";
    if (source !== "ROUTE_EXPLICIT") return null;
    return new Set(
      (((route.capabilities_declared as string[] | undefined) ??
        (route.capabilities as string[] | undefined) ??
        []) as string[])
        .map(String)
        .filter(Boolean),
    );
  }

  /**
   * Reconcile one binding's effective capabilities:
   *   binding.capabilities = executor declaration ∩ route ceiling
   * (unrestricted route → the full executor declaration).
   * CAS write + BINDING_CAPABILITIES_RECONCILED event only on semantic change.
   */
  reconcileBindingCapabilities(
    executorId: string,
    routeId: string,
    executorCapabilities: string[],
    actor = "PAIR_ROUTE_REGISTRY",
  ): { binding: Record<string, unknown>; changed: boolean } | null {
    const binding = this.bindingFor(executorId, routeId);
    if (!binding) return null;
    const route = this.getRoute(String(binding.route_id ?? routeId));
    if (!route) return null;
    this.reconcileRouteConstraint(String(route.route_id), actor);
    const ceiling = this.routeCeiling(this.getRoute(String(route.route_id)) ?? route);
    const executorSet = new Set(executorCapabilities.map(String).filter(Boolean));
    const effective = (ceiling === null
      ? [...executorSet]
      : [...executorSet].filter((c) => ceiling.has(c))
    ).sort();
    const prior = ((binding.capabilities as string[] | undefined) ?? []).map(String).sort();
    if (JSON.stringify(prior) === JSON.stringify(effective)) {
      return { binding, changed: false };
    }
    const saved = this.store.put(
      "executor_supply_binding",
      String(binding.binding_id),
      { ...binding, capabilities: effective, updated_at: utcnow() },
      Number(binding.version),
    );
    this.store.event({
      entity_type: "executor_supply_binding",
      entity_id: String(binding.binding_id),
      event_type: "BINDING_CAPABILITIES_RECONCILED",
      new_state: String(binding.qualification_state ?? "REGISTERED"),
      actor,
      metadata: {
        executor_id: executorId,
        route_id: String(binding.route_id),
        added: effective.filter((c) => !prior.includes(c)),
        removed: prior.filter((c) => !effective.includes(c)),
      },
    });
    return { binding: saved, changed: true };
  }

  /**
   * Reconcile EVERY binding of an executor against its fresh declaration —
   * the canonical seam called at each (re)registration, qualified or not.
   * Order-independent: each binding is recomputed from (executor ∩ its own
   * route's ceiling), so shared routes never flip between executors.
   */
  reconcileExecutorBindings(
    executorId: string,
    executorCapabilities: string[],
    actor = "PAIR_ROUTE_REGISTRY",
  ): number {
    let changed = 0;
    for (const binding of this.bindingsForExecutor(executorId)) {
      const res = this.reconcileBindingCapabilities(
        executorId,
        String(binding.route_id),
        executorCapabilities,
        actor,
      );
      if (res?.changed) changed++;
    }
    return changed;
  }

  updateRouteHealth(routeId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    const route = this.getRoute(routeId);
    if (!route) return null;
    return this.write(
      "route",
      routeId,
      { ...route, health: { ...(route.health as Record<string, unknown>), ...patch } },
      "PAIR_ROUTE_LEDGER",
      "ROUTE_HEALTH_UPDATED",
    );
  }

  // ── executor supply bindings ────────────────────────────────────────

  registerBinding(
    payload: {
      executor_id: string;
      route_id: string;
      mechanism: string;
      qualification_state?: string;
      capabilities?: string[];
      metadata?: Record<string, unknown>;
    },
    actor = "PAIR_ROUTE_REGISTRY",
  ): Record<string, unknown> {
    const executorId = String(payload.executor_id);
    const routeId = String(payload.route_id);
    const mechanism = String(payload.mechanism);
    if (!BINDING_MECHANISMS.has(mechanism)) {
      throw new IntegrityError("FAIL_CLOSED_BINDING_MECHANISM", mechanism);
    }
    if (!this.getRoute(routeId)) {
      throw new IntegrityError("FAIL_CLOSED_ROUTE_MISSING", routeId);
    }
    const bindingId = `BIND_${executorId}__${routeId}`.replace(/[^A-Za-z0-9_]+/g, "_");
    const body = {
      schema: BINDING_SCHEMA,
      binding_id: bindingId,
      executor_id: executorId,
      route_id: routeId,
      mechanism,
      qualification_state: String(payload.qualification_state ?? "DECLARED"),
      capabilities: payload.capabilities ?? [],
      metadata: payload.metadata ?? {},
    };
    return this.write("executor_supply_binding", bindingId, body, actor, "BINDING_REGISTERED");
  }

  qualifyBinding(bindingId: string, evidence: Record<string, unknown>, actor = "LOCAL_OPERATOR"): Record<string, unknown> {
    const binding = this.getBinding(bindingId);
    if (!binding) throw new IntegrityError("FAIL_CLOSED_BINDING_MISSING", bindingId);
    return this.write(
      "executor_supply_binding",
      bindingId,
      { ...binding, qualification_state: "QUALIFIED", qualification_evidence: evidence },
      actor,
      "BINDING_QUALIFIED",
    );
  }

  getBinding(bindingId: string): Record<string, unknown> | null {
    try {
      return this.store.get("executor_supply_binding", bindingId);
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_FOUND") return null;
      throw error;
    }
  }

  bindingFor(executorId: string, routeId: string): Record<string, unknown> | null {
    const byId = `BIND_${executorId}__${routeId}`.replace(/[^A-Za-z0-9_]+/g, "_");
    const direct = executorId && routeId ? this.getBinding(byId) : null;
    if (direct) return direct;
    return (
      this.listBindings().find(
        (b) =>
          (executorId === "" || b.executor_id === executorId) &&
          (routeId === "" || b.route_id === routeId),
      ) ?? null
    );
  }

  bindingsForExecutor(executorId: string): Array<Record<string, unknown>> {
    return this.listBindings().filter((b) => b.executor_id === executorId);
  }

  listBindings(): Array<Record<string, unknown>> {
    return this.store.list("executor_supply_binding");
  }

  /** Deterministic digest over route+binding identities for decision receipts. */
  snapshotDigest(): string {
    const identity = {
      routes: this.listRoutes().map((r) => ({
        route_id: r.route_id,
        enabled: r.enabled,
        eligibility_state: r.eligibility_state,
        qualification_state: r.qualification_state,
        priority: r.priority,
        // Capability authority is part of live routing — the digest must
        // bind it or two registries with different routability hash equal.
        capabilities: [...((r.capabilities as string[]) ?? [])].sort(),
        capability_source: r.capability_source ?? null,
        capabilities_declared: [...((r.capabilities_declared as string[]) ?? [])].sort(),
      })),
      bindings: this.listBindings().map((b) => ({
        binding_id: b.binding_id,
        executor_id: b.executor_id,
        route_id: b.route_id,
        qualification_state: b.qualification_state,
        // Effective executor↔route capability surface is part of live
        // routing — the digest must bind it or two registries with
        // different routability hash equal.
        capabilities: [...((b.capabilities as string[]) ?? [])].sort(),
      })),
    };
    return digest(JSON.parse(canonicalJson(identity)) as Record<string, unknown>);
  }

  /**
   * Seed the canonical PAIR_NATIVE route + binding. Idempotent: re-running
   * returns the existing entities without rewriting qualification state.
   * Capability authority = the registered PAIR_NATIVE executor declaration
   * (falls back to the canonical seed set when no executor row exists yet);
   * an existing route is reconciled to it like every executor-minted route.
   */
  seedPairNativeRoute(
    actor = "PAIR_ROUTE_REGISTRY",
    capabilities?: string[],
  ): { route: Record<string, unknown>; binding: Record<string, unknown> } {
    const authority =
      capabilities ??
      (() => {
        try {
          const exec = this.store.get("executor", "PAIR_NATIVE");
          const caps = (exec.capabilities as string[] | undefined) ?? [];
          return caps.length ? caps : ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"];
        } catch {
          return ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"];
        }
      })();
    let route = this.getRoute(PAIR_NATIVE_ROUTE_ID);
    if (!route) {
      route = this.registerRoute(
        {
          route_id: PAIR_NATIVE_ROUTE_ID,
          route_kind: "IN_PROCESS_RUNTIME",
          enabled: true,
          eligibility_state: "QUALIFIED",
          qualification_state: "QUALIFIED",
          capabilities: [],
          capability_source: "EXECUTOR_DECLARED", // unrestricted-by-route
          priority: 100,
          executor_hint: "PAIR_NATIVE",
          metadata: { executor_kind: "AUTOMATON_LOCAL_WORKER_POOL" },
        },
        actor,
      );
    } else {
      this.reconcileRouteConstraint(PAIR_NATIVE_ROUTE_ID, actor);
      route = this.getRoute(PAIR_NATIVE_ROUTE_ID) ?? route;
    }
    let binding = this.bindingFor("PAIR_NATIVE", PAIR_NATIVE_ROUTE_ID);
    if (!binding) {
      binding = this.registerBinding(
        {
          executor_id: "PAIR_NATIVE",
          route_id: PAIR_NATIVE_ROUTE_ID,
          mechanism: "IN_PROCESS",
          qualification_state: "QUALIFIED",
        },
        actor,
      );
    }
    // Binding-level effective caps = executor declaration ∩ route ceiling.
    this.reconcileExecutorBindings("PAIR_NATIVE", authority, actor);
    binding = this.bindingFor("PAIR_NATIVE", PAIR_NATIVE_ROUTE_ID) ?? binding;
    return { route, binding };
  }
}
