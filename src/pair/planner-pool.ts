/**
 * planner-pool — canonical Planner multi-model failover (Phase B, §4–§7).
 *
 * The Planner pool is an ORDERED list of canonical candidates resolved
 * through Phase A's strict route seam and holding PLANNER_COORDINATOR.
 * Failover walks the pool deterministically — primary, fallback, extras in
 * configured order — and the first FULLY VALID whole plan wins. Partial
 * output from one model is never combined with another's (§6): every
 * attempt is either a valid whole plan or a rejected attempt, recorded as
 * canonical planner-attempt evidence.
 *
 * Failure classification is explicit:
 *  - FAILOVER_ELIGIBLE: transport/availability/contract failures of the
 *    MODEL (timeout, http, provider/model unavailable, quota, auth
 *    rejection, empty/malformed response, plan contract invalid,
 *    degenerate plan) → next candidate.
 *  - FAIL_CLOSED_NON_FAILOVER: role/authority/integrity/governance
 *    failures (IntegrityError FAIL_CLOSED_*, role mismatch/revoked) →
 *    propagate; never silently swap models on an integrity signal.
 *
 * Pool exhausted → IntegrityError FAIL_CLOSED_PLANNER_EXHAUSTED with safe
 * diagnostics (attempt count, routes, providers/models, failure classes,
 * timestamps). No fake minimal plan is ever synthesized (§7).
 */

import { IntegrityError } from "./errors.js";

/** Failure classes carrying operator-safe diagnostics. */
export const PLANNER_FAILURE_CLASS = {
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  QUOTA_RATE_LIMITED: "QUOTA_RATE_LIMITED",
  AUTH_REJECTED: "AUTH_REJECTED",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  PLAN_INVALID: "PLAN_INVALID",
  PLAN_DEGENERATE: "PLAN_DEGENERATE",
} as const;
export type PlannerFailureClass =
  (typeof PLANNER_FAILURE_CLASS)[keyof typeof PLANNER_FAILURE_CLASS];

/** Map llmPlan()'s warning codes to deterministic failure classes. */
export function classifyPlannerFailure(warnings: string[]): PlannerFailureClass {
  const w = warnings[0] ?? "LLM_PLANNER_REQUEST_ERROR";
  if (w === "LLM_PLANNER_NO_CREDENTIAL") return PLANNER_FAILURE_CLASS.CREDENTIAL_MISSING;
  if (w === "LLM_PLANNER_REQUEST_TIMEOUT") return PLANNER_FAILURE_CLASS.TIMEOUT;
  if (w === "LLM_PLANNER_REQUEST_ERROR") return PLANNER_FAILURE_CLASS.NETWORK_ERROR;
  if (w === "LLM_PLAN_NO_JSON" || w === "LLM_PLAN_UNBALANCED_JSON")
    return PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE;
  if (w === "LLM_PLAN_NO_TASKS") return PLANNER_FAILURE_CLASS.EMPTY_RESPONSE;
  if (w === "LLM_PLAN_ALL_INVALID") return PLANNER_FAILURE_CLASS.PLAN_INVALID;
  if (w === "LLM_PLAN_DEGENERATE") return PLANNER_FAILURE_CLASS.PLAN_DEGENERATE;
  const http = /^LLM_PLANNER_HTTP_(\d+)$/.exec(w);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return PLANNER_FAILURE_CLASS.AUTH_REJECTED;
    if (status === 404 || status === 410) return PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE;
    if (status === 402 || status === 429) return PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED;
    if (status >= 500) return PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE;
    return PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE;
  }
  return PLANNER_FAILURE_CLASS.PLAN_INVALID;
}

export interface PlannerCandidate {
  /** Canonical model_entry_id — the identity role authority binds to. */
  model_entry_id: string;
  /** Configured route ref, e.g. "gemini:gemini-3.1-flash-lite". */
  ref: string;
  /** Provider family + model id used for diagnostics/attempt evidence. */
  provider: string;
  model: string;
  /** Provider chat/completions base (no /chat/completions suffix). */
  endpoint: string;
  /** Env var NAME holding the credential — never the value. */
  credentialEnv: string;
}

export interface PlannerAttemptRecord {
  route: string;
  provider: string;
  model_entry_id: string;
  model: string;
  role: "PLANNER_COORDINATOR";
  attempt_no: number;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  outcome: "SUCCESS" | "FAILED";
  failure_class?: PlannerFailureClass;
  /** Sanitized warning codes only — never raw LLM output. */
  warnings: string[];
  /** digest of the winning task list when this attempt won. */
  plan_digest?: string;
}

export interface PlannerFailoverResult {
  /** Exact winning task list (already sanitized by the plan function). */
  tasks: Array<Record<string, unknown>>;
  winner: PlannerAttemptRecord;
  attempts: PlannerAttemptRecord[];
  warnings: string[];
}

/**
 * Run the planner failover chain. `planFn(candidate)` must return the
 * sanitized task list or throw/return-empty on failure — llmPlan already
 * maps transport/contract failures to warning codes; thrown values are
 * re-classified: IntegrityError FAIL_CLOSED_* propagates untouched
 * (non-failover), anything else becomes NETWORK_ERROR.
 *
 * `assertRole(candidate)` revalidates canonical role authority per attempt
 * (§4.3) — a revoked/reassigned role fails closed, never falls over.
 */
export async function runPlannerFailover(opts: {
  candidates: PlannerCandidate[];
  planFn: (c: PlannerCandidate) => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }>;
  assertRole: (c: PlannerCandidate) => void;
  now?: () => string;
}): Promise<PlannerFailoverResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const attempts: PlannerAttemptRecord[] = [];
  let n = 0;
  for (const c of opts.candidates) {
    n++;
    // Runtime eligibility: canonical role still held, model still usable.
    // Integrity/role failures propagate — NOT failover-eligible.
    opts.assertRole(c);
    const started = now();
    const t0 = Date.now();
    const base: Omit<PlannerAttemptRecord, "outcome"> = {
      route: c.ref,
      provider: c.provider,
      model_entry_id: c.model_entry_id,
      model: c.model,
      role: "PLANNER_COORDINATOR",
      attempt_no: n,
      started_at: started,
      completed_at: "",
      latency_ms: 0,
      warnings: [],
    };
    try {
      const res = await opts.planFn(c);
      const completed = now();
      if (Array.isArray(res.tasks) && res.tasks.length) {
        attempts.push({ ...base, completed_at: completed, latency_ms: Date.now() - t0, outcome: "SUCCESS", warnings: res.warnings.slice(0, 10) });
        return { tasks: res.tasks, winner: attempts[attempts.length - 1], attempts, warnings: res.warnings };
      }
      attempts.push({
        ...base,
        completed_at: completed,
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        failure_class: classifyPlannerFailure(res.warnings),
        warnings: res.warnings.slice(0, 10),
      });
    } catch (e) {
      // Integrity/authority failures are not failover-eligible.
      if (e instanceof IntegrityError) throw e;
      attempts.push({
        ...base,
        completed_at: now(),
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        failure_class: PLANNER_FAILURE_CLASS.NETWORK_ERROR,
        warnings: [String(e instanceof Error ? e.name : e).slice(0, 80)],
      });
    }
  }
  // §7: every eligible planner route failed — fail closed with operator-safe
  // evidence. Never fabricate a minimal/T1-only "success" plan.
  throw new IntegrityError(
    "FAIL_CLOSED_PLANNER_EXHAUSTED",
    JSON.stringify({
      attempts: attempts.length,
      routes: attempts.map((a) => ({
        route: a.route,
        provider: a.provider,
        model_entry_id: a.model_entry_id,
        model: a.model,
        failure_class: a.failure_class,
        completed_at: a.completed_at,
      })),
    }),
  );
}

/** Deterministic canonical ordering: primary → fallback → extras (config
 *  order), deduplicated by model_entry_id AFTER strict resolution (§4.2). */
export function dedupePlannerCandidates<T extends { model_entry_id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.model_entry_id) ? false : (seen.add(c.model_entry_id), true)));
}
