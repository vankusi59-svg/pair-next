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
  outcome: "STARTED" | "SUCCESS" | "FAILED";
  failure_class?: PlannerFailureClass;
  /** Sanitized warning codes only — never raw LLM output. */
  warnings: string[];
  /** digest of the winning task list when this attempt won. */
  plan_digest?: string;
  /** Canonical grouping identity — every attempt belongs to a planner_run. */
  planner_run_id?: string;
  /** Linked once a preview is created from this run (nullable). */
  preview_id?: string | null;
}

export interface PlannerFailoverResult {
  /** Exact winning task list (already sanitized by the plan function). */
  tasks: Array<Record<string, unknown>>;
  winner: PlannerAttemptRecord;
  attempts: PlannerAttemptRecord[];
  warnings: string[];
}

/**
 * Run the planner failover chain. `planFn(candidate)` returns the raw
 * sanitized task list; `canonicalize` (when provided) then applies the ONE
 * canonical task-preparation seam — deterministic enrichment + the same
 * validator the preview/confirm path uses — so a candidate can only become
 * the winner by producing a FULLY VALID whole plan (§6). A canonicalize
 * rejection is a model-output failure → FAILED / PLAN_INVALID → next
 * candidate; it is never an authority signal.
 *
 * `assertEligible(candidate)` re-proves canonical eligibility per attempt
 * (role still held, model usable, provider still eligible, not a DSH
 * model/alias). Two verdict channels (R2 §4):
 *  - returns void → candidate is eligible, invoke the model.
 *  - returns {reject:true, failure_class, reason} → TEMPORARY availability
 *    rejection (model not QUALIFIED / STALE / UNAVAILABLE, provider
 *    DOWN/UNAVAILABLE) → durable FAILED attempt → next candidate.
 *  - throws → AUTHORITY failure (role, DSH overlap, provider
 *    qualification/auth/blocked, model REMOVED/DEPRECATED/BLOCKED) →
 *    propagates, never failover-eligible.
 *
 * Durable-evidence hooks (§3–§5): `onAttemptStart` fires BEFORE the model
 * is invoked and returns an opaque token the caller uses to persist the
 * STARTED row; `onAttemptEnd` fires after settlement with the final record;
 * `onExhausted` fires when every candidate failed, before the throw. A
 * crash between start and settle leaves the durable STARTED row — the
 * invocation can never be silently absent.
 *
 * Zero candidates → FAIL_CLOSED_PLANNER_NO_ELIGIBLE: a configured planner
 * pool resolving to no eligible candidate must never silently degrade to
 * the deterministic/template path (§1 R1).
 */
export async function runPlannerFailover(opts: {
  candidates: PlannerCandidate[];
  planFn: (c: PlannerCandidate) => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }>;
  /** Canonical per-invocation eligibility proof (role + lifecycle).
   *  Throw = authority failure (propagates); return {reject:true,...} =
   *  failover-eligible availability rejection. */
  assertEligible: (
    c: PlannerCandidate,
  ) => void | { reject: true; failure_class: PlannerFailureClass; reason: string };
  /** The one canonical task-preparation seam — returns the exact canonical
   *  task list the preview will pin; any throw → PLAN_INVALID failover. */
  canonicalize?: (tasks: Array<Record<string, unknown>>, c: PlannerCandidate) => Array<Record<string, unknown>>;
  onAttemptStart?: (base: Omit<PlannerAttemptRecord, "outcome">) => unknown;
  onAttemptEnd?: (token: unknown, record: PlannerAttemptRecord) => void;
  onExhausted?: (attempts: PlannerAttemptRecord[]) => void;
  now?: () => string;
}): Promise<PlannerFailoverResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  if (!opts.candidates.length) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLANNER_NO_ELIGIBLE",
      "configured planner pool resolved to zero eligible candidates — refusing template fallback",
    );
  }
  const attempts: PlannerAttemptRecord[] = [];
  let n = 0;
  for (const c of opts.candidates) {
    n++;
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
    // §4 — durable STARTED evidence before ANY gate runs: even an
    // eligibility-rejected or authority-aborted invocation is auditable.
    const token = opts.onAttemptStart?.(base);
    const settle = (rec: PlannerAttemptRecord) => {
      attempts.push(rec);
      opts.onAttemptEnd?.(token, rec);
    };
    // Runtime eligibility re-proof per invocation (§9/R2). Authority
    // failures throw and propagate — NOT failover-eligible; availability
    // rejections settle FAILED and move to the next candidate.
    const elig = opts.assertEligible(c);
    if (elig && elig.reject) {
      settle({
        ...base,
        completed_at: now(),
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        failure_class: elig.failure_class,
        warnings: [`ELIGIBILITY_REJECTED:${elig.reason}`],
      });
      continue;
    }
    try {
      const res = await opts.planFn(c);
      const completed = now();
      if (!Array.isArray(res.tasks) || !res.tasks.length) {
        settle({
          ...base,
          completed_at: completed,
          latency_ms: Date.now() - t0,
          outcome: "FAILED",
          failure_class: classifyPlannerFailure(res.warnings),
          warnings: res.warnings.slice(0, 10),
        });
        continue;
      }
      // §6/§7 — the canonical seam decides the winner: the exact prepared
      // task list must pass the same validation the preview will pin.
      let canonical = res.tasks;
      if (opts.canonicalize) {
        try {
          canonical = opts.canonicalize(res.tasks, c);
        } catch {
          settle({
            ...base,
            completed_at: now(),
            latency_ms: Date.now() - t0,
            outcome: "FAILED",
            failure_class: PLANNER_FAILURE_CLASS.PLAN_INVALID,
            warnings: [...res.warnings.slice(0, 9), "CANONICAL_VALIDATION_FAILED"],
          });
          continue;
        }
        if (!canonical.length) {
          settle({
            ...base,
            completed_at: now(),
            latency_ms: Date.now() - t0,
            outcome: "FAILED",
            failure_class: PLANNER_FAILURE_CLASS.PLAN_INVALID,
            warnings: [...res.warnings.slice(0, 9), "CANONICAL_VALIDATION_EMPTY"],
          });
          continue;
        }
      }
      settle({ ...base, completed_at: completed, latency_ms: Date.now() - t0, outcome: "SUCCESS", warnings: res.warnings.slice(0, 10) });
      return { tasks: canonical, winner: attempts[attempts.length - 1], attempts, warnings: res.warnings };
    } catch (e) {
      // Integrity/authority failures are not failover-eligible.
      if (e instanceof IntegrityError) throw e;
      settle({
        ...base,
        completed_at: now(),
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        failure_class: PLANNER_FAILURE_CLASS.NETWORK_ERROR,
        warnings: [String(e instanceof Error ? e.name : e).slice(0, 80)],
      });
    }
  }
  // §5 — durable exhausted provenance: every failed attempt already settled
  // via the hooks; the caller closes the planner_run before we throw.
  opts.onExhausted?.(attempts);
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
