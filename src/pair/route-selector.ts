/**
 * RouteSelector — deterministic hard-eligibility + lexicographic scoring
 * over routes, producing append-only route_decision receipts.
 *
 * Port of donor route_selector.py (a557df2), scoped to P3: executor-bound
 * route selection (binding must exist + be qualified, route enabled and
 * eligible, health acceptable). Provider/model supply gates (account pools,
 * catalog lifecycle, pricing) are deferred — P3 forbids provider/model
 * discovery and registers only PAIR_NATIVE's in-process route.
 */

import { digest, newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import {
  CAPABILITY_SOURCES,
  REJECTED_ROUTE_HEALTH,
  RouteRegistry,
} from "./route-registry.js";

export const ROUTE_DECISION_SCHEMA = "pair.os.vnext.route-decision.v1";

const DECISION_EVENT = "ROUTE_DECISION_RECORDED";

function isoFuture(ts: unknown): boolean {
  return typeof ts === "string" && ts !== "" && ts > utcnow();
}

export interface RouteSelectRequest {
  capability?: string;
  executor_id?: string;
  visited_route_ids?: string[];
  operator_pin?: string;
  require_qualified?: boolean;
  preferred_route_id?: string;
  /** P12 agent-contract route policy: ordered preferences (supersedes
   *  preferred_route_id), hard denies, and an allow-restrict set used when
   *  the contract forbids fallback off its preferred routes. */
  preferred_route_ids?: string[];
  denied_route_ids?: string[];
  restricted_route_ids?: string[] | null;
  mission_id?: string;
  task_id?: string;
  governed_task_id?: string;
  parent_decision_id?: string;
  correlation_id?: string;
  shadow?: boolean;
  persist?: boolean;
  actor?: string;
}

export class RouteSelector {
  constructor(private readonly service: PairControlPlane) {}

  private get registry(): RouteRegistry {
    return (this.service as { routes?: RouteRegistry }).routes ?? new RouteRegistry(this.service);
  }

  /** Hard rejections — deterministic, ordered, fail-closed. */
  private hardRejections(route: Record<string, unknown>, request: Record<string, unknown>): string[] {
    const reasons: string[] = [];
    const rid = String(route.route_id);

    if (route.enabled === false) reasons.push("ROUTE_DISABLED");
    if (["DISABLED", "RETIRED"].includes(String(route.eligibility_state))) {
      reasons.push(`ROUTE_${route.eligibility_state}`);
    }
    if ((request.visited_route_ids as string[] | undefined)?.includes(rid)) {
      reasons.push("ROUTE_VISITED");
    }

    const executorId = request.executor_id as string | undefined;
    let binding: Record<string, unknown> | null = null;
    if (executorId) {
      binding = this.registry.bindingFor(executorId, rid);
      if (!binding) reasons.push("BINDING_ABSENT");
      else if (binding.mechanism === "UNSUPPORTED") reasons.push("BINDING_UNSUPPORTED");
      else if (binding.qualification_state !== "QUALIFIED") reasons.push("BINDING_NOT_QUALIFIED");
    } else if (!route.direct_callable) {
      reasons.push("NOT_DIRECT_CALLABLE");
    }

    const pin = request.operator_pin as string | undefined;
    if (pin && rid !== pin) reasons.push("OPERATOR_PIN_EXCLUDED");

    // P12: contract-level route denies and no-fallback restriction are hard
    // rejections — they narrow, never widen, the canonical eligible set.
    if ((request.denied_route_ids as string[] | undefined)?.includes(rid)) {
      reasons.push("AGENT_CONTRACT_ROUTE_DENIED");
    }
    // R1 §3: a non-null restricted set is a hard allow-set — an EMPTY one
    // (pinned ∩ current collapsed) rejects every route, never falls back.
    const restricted = request.restricted_route_ids as string[] | null | undefined;
    if (restricted && !restricted.includes(rid)) {
      reasons.push("AGENT_CONTRACT_ROUTE_RESTRICTED");
    }

    const capability = request.capability as string | undefined;
    if (executorId) {
      // Effective capability lives on the executor↔route BINDING — a
      // shared route has no single per-executor snapshot. A binding whose
      // reconciled surface excludes the capability fails closed.
      if (binding && capability) {
        const bcaps = ((binding.capabilities as string[] | undefined) ?? []).map(String);
        if (!bcaps.includes(capability)) reasons.push("CAPABILITY_MISMATCH");
      }
    } else if (capability) {
      // Unbound direct-callable request: route-level constraint keyed by
      // capability_source, never by array length alone —
      //   ROUTE_EXPLICIT    → capabilities IS the ceiling ([] permits NOTHING)
      //   EXECUTOR_DECLARED → unrestricted-by-route (also the canonical
      //                       interpretation of a legacy missing source).
      const source = CAPABILITY_SOURCES.has(String(route.capability_source))
        ? String(route.capability_source)
        : "EXECUTOR_DECLARED";
      if (source === "ROUTE_EXPLICIT") {
        const caps = ((route.capabilities as string[] | undefined) ?? []).map(String);
        if (!caps.includes(capability)) reasons.push("CAPABILITY_MISMATCH");
      }
    }

    if (reasons.length) return reasons;

    if (request.require_qualified !== false && route.qualification_state !== "QUALIFIED") {
      reasons.push("ROUTE_NOT_QUALIFIED");
    }
    const health = (route.health as Record<string, unknown>) ?? {};
    const hstate = String(health.state ?? "READY");
    if (REJECTED_ROUTE_HEALTH.has(hstate)) reasons.push(`HEALTH_${hstate}`);
    if (isoFuture(health.cooldown_until)) reasons.push("COOLDOWN_ACTIVE");

    return reasons;
  }

  /** Fixed lexicographic score: identical registry state ⇒ identical pick. */
  private scoreKey(route: Record<string, unknown>): [number, number, string] {
    const failures = Number(
      (route.health as Record<string, unknown>)?.consecutive_failures ?? 0,
    );
    return [failures, Number(route.priority ?? 100) || 100, String(route.route_id)];
  }

  /**
   * Evaluate all routes; persist an append-only route_decision receipt
   * (candidates, hard rejections, scoring inputs, selection, snapshot digest).
   */
  select(request: RouteSelectRequest): Record<string, unknown> {
    const registry = this.registry;
    const persist = request.persist !== false;
    const req = {
      capability: request.capability ?? null,
      executor_id: request.executor_id ?? null,
      visited_route_ids: request.visited_route_ids ?? [],
      operator_pin: request.operator_pin ?? null,
      require_qualified: request.require_qualified !== false,
      preferred_route_id: request.preferred_route_id ?? null,
      preferred_route_ids: request.preferred_route_ids ?? [],
      denied_route_ids: request.denied_route_ids ?? [],
      restricted_route_ids: request.restricted_route_ids ?? null,
    };
    const requestFingerprint = digest({ request: req, schema: ROUTE_DECISION_SCHEMA });

    const eligible: Array<{ route: Record<string, unknown>; key: [number, number, string] }> = [];
    const rejected: Array<Record<string, unknown>> = [];
    const allRoutes = registry.listRoutes();

    for (const route of allRoutes) {
      const reasons = this.hardRejections(route, req as unknown as Record<string, unknown>);
      if (reasons.length) {
        rejected.push({ route_id: route.route_id, reason_codes: reasons });
      } else {
        eligible.push({ route, key: this.scoreKey(route) });
      }
    }

    eligible.sort((a, b) =>
      a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2].localeCompare(b.key[2]),
    );

    let selected: { route: Record<string, unknown>; key: [number, number, string] } | null = null;
    let tieBreak: Record<string, unknown> | null = null;
    if (eligible.length) {
      if (req.preferred_route_id) {
        const idx = eligible.findIndex((e) => e.route.route_id === req.preferred_route_id);
        if (idx >= 0) eligible.unshift(...eligible.splice(idx, 1));
      }
      // P12: ordered contract preferences promote the first eligible
      // preferred route — advisory reordering inside the eligible set only.
      for (const rid of [...req.preferred_route_ids].reverse()) {
        const idx = eligible.findIndex((e) => e.route.route_id === rid);
        if (idx >= 0) eligible.unshift(...eligible.splice(idx, 1));
      }
      selected = eligible[0];
      tieBreak = {
        score_key: selected.key,
        runner_up_route_id: eligible[1]?.route.route_id ?? null,
      };
    }
    const selectedBinding =
      selected && req.executor_id
        ? registry.bindingFor(String(req.executor_id), String(selected.route.route_id))
        : null;

    const decision: Record<string, unknown> = {
      schema: ROUTE_DECISION_SCHEMA,
      decision_id: newId("RDEC"),
      request_fingerprint: requestFingerprint,
      registry_snapshot_digest: registry.snapshotDigest(),
      capability: request.capability ?? null,
      executor_id: req.executor_id,
      candidates_evaluated: allRoutes.map((r) => String(r.route_id)).sort(),
      hard_rejections: rejected,
      selected_route_id: selected ? selected.route.route_id : null,
      selected_route_kind: selected ? selected.route.route_kind : null,
      selected_binding_id: selectedBinding ? selectedBinding.binding_id : null,
      binding_mechanism: selectedBinding ? selectedBinding.mechanism : null,
      reason_codes: selected ? [] : ["NO_ELIGIBLE_ROUTE"],
      score_inputs: { policy: "FAILURES_THEN_PRIORITY_THEN_ROUTE_ID" },
      tie_break: tieBreak,
      fallback_depth: (req.visited_route_ids ?? []).length,
      visited_route_ids: req.visited_route_ids,
      mission_id: request.mission_id ?? null,
      task_id: request.task_id ?? null,
      governed_task_id: request.governed_task_id ?? null,
      parent_decision_id: request.parent_decision_id ?? null,
      correlation_id: request.correlation_id ?? null,
      // P12: contract route policy applied to this decision (null = none).
      agent_route_policy:
        req.preferred_route_ids.length || req.denied_route_ids.length || req.restricted_route_ids
          ? {
              preferred: req.preferred_route_ids,
              denied: req.denied_route_ids,
              restricted: req.restricted_route_ids !== null,
            }
          : null,
      shadow: Boolean(request.shadow),
      created_at: utcnow(),
      actor: request.actor ?? "PAIR_ROUTE_SELECTOR",
    };
    if (persist) {
      this.service.store.put("route_decision", String(decision.decision_id), decision, 0);
      this.service.store.event({
        entity_type: "route_decision",
        entity_id: String(decision.decision_id),
        event_type: DECISION_EVENT,
        new_state: String(decision.selected_route_id ?? "NO_ELIGIBLE_ROUTE"),
        actor: String(decision.actor),
        correlation_id: request.correlation_id,
        metadata: { executor_id: req.executor_id, shadow: Boolean(request.shadow) },
      });
    }
    return decision;
  }
}
