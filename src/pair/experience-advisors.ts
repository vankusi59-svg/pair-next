/**
 * Verified-Experience advisors — the ONLY consumers of Layer C.
 *
 * Both advisors run AFTER hard gates and produce advisory receipts. They may
 * rank already-eligible options; they can never create eligibility, grant
 * permissions, or bypass GovernedTaskGate.
 *
 * Routing advisor score model (score version v1 — explicit, documented):
 *   final_score = base_score - adjustment
 *   base_score  = executor routing_priority (lower wins — the P3 baseline)
 *   adjustment  = Σ weight(type, outcome) × origin_weight × recency
 *                 clamped to ±MAX_ADJUSTMENT
 *   winner      = min(final_score), tie-break executor_id ascending
 *
 * With no compatible ACTIVE/QUALIFIED experience the adjustment is 0 and the
 * winner is exactly the P6 deterministic baseline.
 */

import { digest, newId, utcnow } from "./canonical.js";
import type { ExperienceService } from "./experience.js";
import { deriveMissionScope } from "./experience-extraction.js";
import { IntegrityError } from "./errors.js";
import type { ProposedTask } from "./proposal.js";
import type { PairControlPlane } from "./service.js";

export const EXPERIENCE_SCORE_VERSION = "pair.os.vnext.experience-score.v1";

/** Explicit, versioned advisory weights (units of routing-priority points). */
export const EXPERIENCE_SCORE_WEIGHTS = {
  // positive verified affinity (priority-points per observation, capped 3)
  EXECUTOR_OBSERVATION_SUCCESS: 15,
  PROVIDER_MODEL_OBSERVATION_SUCCESS: 10,
  ROUTING_PRIOR_SUCCESS: 14,
  REMEDIATION_PAIR: 6,
  // negative pressure — advisory only, never a hard ban
  EXECUTOR_OBSERVATION_FAILURE: -8,
  PROVIDER_MODEL_OBSERVATION_FAILURE: -6,
  ROUTING_PRIOR_FAILURE: -10,
  NEGATIVE_EXPERIENCE: -25,
  FAILURE_SIGNATURE: -4,
  // bounds
  MAX_ADJUSTMENT: 40,
  OBSERVATION_CAP: 3,
  // deterministic bounded recency: weight × 2^-(age_days / HALF_LIFE)
  RECENCY_HALF_LIFE_DAYS: 14,
} as const;

/** Production advisory treats evidence origins asymmetrically. */
export const ORIGIN_WEIGHT: Record<string, number> = {
  REAL_EXECUTION: 1.0,
  LIVE_PROBE: 0.8,
  DETERMINISTIC_TEST: 0.5,
  OPERATOR_ASSERTION: 0.3,
  SIMULATED_FIXTURE: 0.1,
  MODEL_GENERATED: 0.0,
};

const DAYS_MS = 86_400_000;

function recencyFactor(lastObserved: unknown, now: string): number {
  if (typeof lastObserved !== "string" || !lastObserved) return 1;
  const ageMs = Date.parse(now) - Date.parse(lastObserved);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const ageDays = ageMs / DAYS_MS;
  // quantized to 4 decimals — identical snapshots replay identically
  const f = Math.pow(2, -ageDays / EXPERIENCE_SCORE_WEIGHTS.RECENCY_HALF_LIFE_DAYS);
  return Math.round(f * 10000) / 10000;
}

function weightFor(exp: Record<string, unknown>): number {
  const w = EXPERIENCE_SCORE_WEIGHTS as Record<string, number>;
  const type = String(exp.type);
  const outcome = String(exp.outcome ?? "");
  const key = `${type}_${outcome}`;
  if (key in w) return w[key];
  return w[type] ?? 0;
}

function persistReceipt(
  service: PairControlPlane,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const stored = service.store.put(
    "advisor_decision",
    String(receipt.advisor_decision_id),
    receipt,
    0,
  );
  service.store.event({
    entity_type: "advisor_decision",
    entity_id: String(receipt.advisor_decision_id),
    event_type: String(receipt.event_type),
    new_state: String(receipt.selected ?? receipt.mode ?? ""),
    actor: "PAIR_EXPERIENCE_ADVISOR",
    correlation_id: receipt.correlation_id as string | undefined,
  });
  return stored;
}

// ──────────────────────────────────────────────────────────────────────
// Planner advisor
// ──────────────────────────────────────────────────────────────────────

export class VerifiedExperiencePlannerAdvisor {
  constructor(
    private readonly service: PairControlPlane,
    private readonly experience: ExperienceService,
  ) {}

  /**
   * Retrieve compatible ACTIVE/QUALIFIED experience for a mission goal and
   * emit an advisory context + persisted receipt. The planner (Automaton)
   * remains the proposer; this only feeds context. P17: the read is
   * tenancy-scoped to the mission's canonical binding — a foreign-scope
   * row can never advise this mission.
   */
  advise(opts: {
    goal: string;
    mission_id?: string;
    environment?: Record<string, unknown>;
    correlation_id?: string;
    now?: string;
  }): Record<string, unknown> {
    const scope = opts.mission_id
      ? deriveMissionScope(this.service.store, opts.mission_id)
      : { scope_business_id: null, scope_objective_id: null };
    const query = {
      text: opts.goal,
      mission_id: opts.mission_id,
      environment: opts.environment,
      now: opts.now,
      ...(scope.scope_objective_id
        ? { objective_id: scope.scope_objective_id, business_id: scope.scope_business_id ?? undefined }
        : scope.scope_business_id
          ? { business_id: scope.scope_business_id }
          : {}),
    };
    const all = this.experience.retrieve(query);
    const byType = (t: string) => all.filter((e) => e.type === t);
    const context = {
      plan_templates: byType("PLAN_TEMPLATE"),
      subplan_patterns: byType("SUBPLAN_PATTERN"),
      failure_signatures: byType("FAILURE_SIGNATURE"),
      remediation_pairs: byType("REMEDIATION_PAIR"),
      environment_constraints: byType("ENVIRONMENT_CONSTRAINT"),
      negative_experience: byType("NEGATIVE_EXPERIENCE"),
      tool_compatibility: byType("TOOL_COMPATIBILITY"),
      executor_observations: byType("EXECUTOR_OBSERVATION"),
      provider_model_observations: byType("PROVIDER_MODEL_OBSERVATION"),
    };
    const considered = all.map((e) => e.experience_id).sort();
    const receipt: Record<string, unknown> = {
      schema: "pair.os.vnext.advisor-decision.v1",
      advisor_decision_id: newId("ADR"),
      kind: "PLANNER",
      event_type: "PLANNER_ADVICE_GENERATED",
      mission_id: opts.mission_id ?? null,
      goal_digest: digest({ goal: opts.goal }),
      experience_ids_considered: considered,
      experience_ids_applied: considered, // advisory: all retrieved are applied as context
      experience_ids_rejected: [],
      score_version: EXPERIENCE_SCORE_VERSION,
      counts: Object.fromEntries(
        Object.entries(context).map(([k, v]) => [k, (v as unknown[]).length]),
      ),
      correlation_id: opts.correlation_id ?? null,
      created_at: utcnow(),
    };
    receipt.decision_digest = digest(receipt);
    return persistReceipt(this.service, receipt);
  }

  /**
   * Controlled plan-template reuse: produce a NEW proposal skeleton bound to
   * nothing — capabilities/deps only. Callers must still run
   * validatePlanProposal + commitPlan; no permissions/executors carry over.
   */
  /** By-id read — bypasses scopeAdmits by design (the caller already
   *  named the row). Pre-P17 this was the only surface; if a scoped
   *  consumer ever wires it, the tenancy check must be added here.
   *  Currently zero production callers. */
  reusePlanTemplate(
    experienceId: string,
  ): { proposal: { tasks: ProposedTask[] }; template_id: string } {
    const exp = this.experience.get(experienceId);
    if (exp.type !== "PLAN_TEMPLATE") {
      throw new IntegrityError("FAIL_CLOSED_EXPERIENCE_TYPE", String(exp.type));
    }
    if (!["ACTIVE", "QUALIFIED"].includes(String(exp.status)) || exp.stale === true) {
      throw new IntegrityError(
        "FAIL_CLOSED_EXPERIENCE_NOT_REUSABLE",
        String(exp.status),
      );
    }
    const tasks = ((exp.payload as Record<string, unknown>)?.tasks ?? []) as Array<
      Record<string, unknown>
    >;
    const proposal = {
      tasks: tasks.map((t) => ({
        task_key: String(t.task_key),
        title: String(t.title),
        description: `reused:${String(exp.experience_id)}`,
        required_capabilities: [...(t.required_capabilities as string[])],
        depends_on: [...(t.depends_on as string[])],
      })),
      metadata: { reused_experience_id: exp.experience_id },
    };
    this.service.store.event({
      entity_type: "experience",
      entity_id: String(exp.experience_id),
      event_type: "PLAN_TEMPLATE_APPLIED",
      new_state: String(exp.status),
      actor: "PAIR_EXPERIENCE_ADVISOR",
      metadata: { advisor: "planner" },
    });
    return { proposal, template_id: String(exp.experience_id) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Routing advisor
// ──────────────────────────────────────────────────────────────────────

export class VerifiedExperienceRoutingAdvisor {
  /** Global kill-switch + per-type disable — rollback needs no data deletion. */
  enabled: boolean;
  disabledTypes: Set<string>;

  constructor(
    private readonly service: PairControlPlane,
    private readonly experience: ExperienceService,
    opts: { enabled?: boolean; disabled_types?: string[] } = {},
  ) {
    this.enabled = opts.enabled !== false;
    this.disabledTypes = new Set(opts.disabled_types ?? []);
  }

  private get store() {
    return this.service.store;
  }

  /**
   * Score already-hard-eligible executors. `eligible` must come from
   * CapabilityRouter — this method never re-opens eligibility. Returns the
   * persisted advisor_decision receipt with the selected executor_id.
   */
  advise(opts: {
    eligible: Array<Record<string, unknown>>;
    task?: Record<string, unknown>;
    environment?: Record<string, unknown>;
    correlation_id?: string;
    now?: string;
    persist?: boolean;
  }): Record<string, unknown> {
    const now = opts.now ?? utcnow();
    const eligible = [...opts.eligible].sort(
      (a, b) =>
        (Number(a.routing_priority) || 100) - (Number(b.routing_priority) || 100) ||
        String(a.executor_id).localeCompare(String(b.executor_id)),
    );
    const baseline = eligible.length ? String(eligible[0].executor_id) : null;
    const eligibleIds = eligible.map((d) => String(d.executor_id));

    const receipt: Record<string, unknown> = {
      schema: "pair.os.vnext.advisor-decision.v1",
      advisor_decision_id: newId("ADR"),
      kind: "ROUTING",
      mission_id: (opts.task?.mission_id as string) ?? null,
      task_id: (opts.task?.task_id as string) ?? null,
      eligible_candidates: eligibleIds,
      score_version: EXPERIENCE_SCORE_VERSION,
      weights: { ...EXPERIENCE_SCORE_WEIGHTS, ORIGIN_WEIGHT },
      baseline_selected: baseline,
      correlation_id: opts.correlation_id ?? null,
      created_at: now,
    };

    if (!this.enabled || eligible.length === 0) {
      receipt.mode = "BASELINE";
      receipt.event_type = "ADAPTIVE_ROUTE_BASELINE_USED";
      receipt.mode_reason = this.enabled ? "NO_ELIGIBLE" : "ADVISOR_DISABLED";
      receipt.experience_ids_considered = [];
      receipt.experience_ids_applied = [];
      receipt.experience_ids_rejected = [];
      receipt.base_scores = Object.fromEntries(
        eligibleIds.map((id) => [id, Number(eligible.find((d) => d.executor_id === id)?.routing_priority) || 100]),
      );
      receipt.experience_adjustments = {};
      receipt.final_scores = receipt.base_scores;
      receipt.selected = baseline;
      receipt.decision_digest = digest(receipt);
      if (opts.persist !== false) persistReceipt(this.service, receipt);
      return receipt;
    }

    const taskCaps = new Set(
      ((opts.task?.required_capabilities as string[]) ?? []).map(String),
    );

    const considered: string[] = [];
    const applied: string[] = [];
    const rejected: Array<Record<string, unknown>> = [];
    const adjustments: Record<string, number> = Object.fromEntries(
      eligibleIds.map((id) => [id, 0]),
    );
    const perExpDelta: Record<string, Record<string, number>> = {};

    // P17 — tenancy-scoped advisory reads: the mission's canonical
    // binding decides which scope's experience may advise this route.
    // A foreign-scope row can never re-rank an executor here.
    const missionId = (opts.task?.mission_id as string) ?? null;
    const missionScope = missionId
      ? deriveMissionScope(this.service.store, missionId)
      : { scope_business_id: null, scope_objective_id: null };
    const scopeQuery = missionScope.scope_objective_id
      ? { objective_id: missionScope.scope_objective_id, business_id: missionScope.scope_business_id ?? undefined }
      : missionScope.scope_business_id
        ? { business_id: missionScope.scope_business_id }
        : {};

    for (const executorId of eligibleIds) {
      const rows = this.experience.retrieve({
        executor_id: executorId,
        environment: opts.environment,
        now,
        ...scopeQuery,
      });
      for (const exp of rows) {
        const expId = String(exp.experience_id);
        considered.push(expId);
        const scope = (exp.compatibility_scope as Record<string, unknown>) ?? {};
        // capability compatibility: if the claim is capability-scoped it must
        // cover this task's required capabilities (or have none declared)
        const expCaps = (scope.capabilities as string[]) ?? [];
        if (
          expCaps.length &&
          taskCaps.size &&
          !expCaps.some((c) => taskCaps.has(c))
        ) {
          rejected.push({ experience_id: expId, executor_id: executorId, reason: "CAPABILITY_SCOPE_MISMATCH" });
          continue;
        }
        if (this.disabledTypes.has(String(exp.type))) {
          rejected.push({ experience_id: expId, executor_id: executorId, reason: "TYPE_DISABLED" });
          continue;
        }
        const w = weightFor(exp);
        const ow = ORIGIN_WEIGHT[String(exp.evidence_origin ?? "OPERATOR_ASSERTION")] ?? 0;
        const rf = recencyFactor(exp.last_observed_at, now);
        const obsScale = Math.min(
          Number(exp.observation_count ?? 1),
          EXPERIENCE_SCORE_WEIGHTS.OBSERVATION_CAP,
        );
        const delta = w * obsScale * ow * rf;
        if (delta === 0) {
          rejected.push({ experience_id: expId, executor_id: executorId, reason: "ZERO_WEIGHT" });
          continue;
        }
        adjustments[executorId] += delta;
        perExpDelta[expId] = { ...(perExpDelta[expId] ?? {}), [executorId]: delta };
        if (!applied.includes(expId)) applied.push(expId);
        if (String(exp.type) === "ROUTING_PRIOR") {
          this.store.event({
            entity_type: "experience",
            entity_id: expId,
            event_type: "ROUTING_PRIOR_APPLIED",
            new_state: executorId,
            actor: "PAIR_EXPERIENCE_ADVISOR",
            correlation_id: opts.correlation_id,
            metadata: { delta },
          });
        }
      }
    }

    const baseScores = Object.fromEntries(
      eligibleIds.map((id) => [
        id,
        Number(eligible.find((d) => d.executor_id === id)?.routing_priority) || 100,
      ]),
    );
    const finalScores = Object.fromEntries(
      eligibleIds.map((id) => [
        id,
        Number(baseScores[id]) -
          Math.max(
            -EXPERIENCE_SCORE_WEIGHTS.MAX_ADJUSTMENT,
            Math.min(EXPERIENCE_SCORE_WEIGHTS.MAX_ADJUSTMENT, adjustments[id]),
          ),
      ]),
    );

    const ranked = [...eligible].sort(
      (a, b) =>
        finalScores[String(a.executor_id)] - finalScores[String(b.executor_id)] ||
        String(a.executor_id).localeCompare(String(b.executor_id)),
    );
    const selected = String(ranked[0].executor_id);
    const adaptive = selected !== baseline;

    Object.assign(receipt, {
      mode: adaptive ? "ADAPTIVE" : "BASELINE",
      event_type: adaptive ? "ADAPTIVE_ROUTE_SELECTED" : "ADAPTIVE_ROUTE_BASELINE_USED",
      experience_ids_considered: [...new Set(considered)].sort(),
      experience_ids_applied: applied.sort(),
      experience_ids_rejected: rejected,
      base_scores: baseScores,
      experience_adjustments: Object.fromEntries(
        Object.entries(adjustments).map(([k, v]) => [
          k,
          Math.max(
            -EXPERIENCE_SCORE_WEIGHTS.MAX_ADJUSTMENT,
            Math.min(EXPERIENCE_SCORE_WEIGHTS.MAX_ADJUSTMENT, v),
          ),
        ]),
      ),
      per_experience_delta: perExpDelta,
      final_scores: finalScores,
      selected,
    });
    receipt.decision_digest = digest(receipt);
    const stored =
      opts.persist !== false ? persistReceipt(this.service, receipt) : receipt;
    return stored;
  }

  /** Tamper-check a persisted advisor receipt (digest recompute). */
  verifyReceipt(receipt: Record<string, unknown>): boolean {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(receipt)) {
      if (!["decision_digest", "version", "entity_type", "entity_id"].includes(k)) {
        body[k] = v;
      }
    }
    return digest(body) === receipt.decision_digest;
  }
}
