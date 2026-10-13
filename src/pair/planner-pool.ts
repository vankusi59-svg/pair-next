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
import type { PlannerRejectionContext } from "./llm-planner.js";
import type { RawDeliveryEmissionState } from "./plan-dataflow.js";

/** P-REASK — bounded invocation context passed to every planFn call so
 *  all transports share ONE contract. INITIAL carries kind only (the
 *  planFn's own configured defaults apply). REASK carries the rejection
 *  feedback, the effective remaining-budget timeout, and a hard
 *  provider-request limit (1 — exactly one model call per re-ask). */
export interface PlannerInvocation {
  kind: "INITIAL" | "REASK";
  /** Effective per-request timeout for this call (REASK = min(normal
   *  per-request timeout, remaining candidate budget)). */
  timeoutMs?: number;
  /** Hard provider-request bound for this call (REASK = 1). */
  maxProviderRequests?: number;
  /** Bounded deterministic rejection feedback — present iff kind=REASK. */
  rejectionContext?: PlannerRejectionContext;
}

/** P-REASK R3 — per-candidate latency authority. `ceilingMs` is the
 *  candidate's total worst-case envelope measured from attempt START
 *  (HTTP = 2×per-request timeout because an INITIAL call may perform up
 *  to two provider requests; Codex = its single-invocation timeout);
 *  `requestTimeoutMs` is the normal per-request timeout. */
export interface PlannerLatencyBudget {
  ceilingMs: number;
  requestTimeoutMs: number;
}

/** P-REASK R0 — canonical codes that make a canonicalize rejection
 *  eligible for the ONE bounded feedback re-ask: canonical plan-
 *  validation families only. Eligibility/authority/transport/timeout/
 *  credential/NO_JSON-degenerate failures never qualify. */
const REASK_CODE_PREFIX = /^FAIL_CLOSED_(?:PLAN|DELIVERY|TELEGRAM|TASK)_/;
const SAFE_CODE_RE = /^[A-Z0-9_:.\-]+$/;

/** Returns the exact typed code when `e` is an eligible canonical
 *  plan-validation IntegrityError, else null. Exact identity only — an
 *  over-length or malformed code is never truncated into a fake one. */
export function extractReaskEligibleCode(e: unknown): string | null {
  if (!(e instanceof IntegrityError)) return null;
  const code = e.code;
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    code.length > 80 ||
    !SAFE_CODE_RE.test(code) ||
    !REASK_CODE_PREFIX.test(code)
  ) {
    return null;
  }
  return code;
}

/** Bounded deterministic feedback built ONLY from PAIR-owned evidence:
 *  task-keyed sanitize markers of the DROP_*, DEP_*, REPAIRED_* families
 *  on the strict safe charset — deduped, order-preserved, ≤10. Never raw
 *  model output, task instruction bodies, exception text, or secrets. */
export function boundedReaskTaskWarnings(warnings: string[]): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    if (
      out.length < 10 &&
      SAFE_CODE_RE.test(w) &&
      (w.startsWith("DROP_") || w.startsWith("DEP_") || w.startsWith("REPAIRED_")) &&
      !out.includes(w)
    ) {
      out.push(w);
    }
  }
  return out;
}

/** P-REASK R4 — structured rejection detail for the ONE re-ask: built ONLY
 *  from allowlisted fields of the gate's own structured `IntegrityError.detail`
 *  (never `e.message`, never task instructions, plan JSON, requirement text,
 *  model output, or arbitrary operator text). Every emitted value must match
 *  the canonical-identifier grammar; anything malformed, unrecognized, or
 *  over-budget falls back to the exact validation_code — never a truncated
 *  unsafe string. */
const SAFE_REASK_FIELD_RE = /^[A-Za-z0-9_./-]{1,120}$/;
/** Upper bound enforced by REASK_DETAIL_LINE_RE — formatters budget against
 *  this exact number so the regex and the formatter can never drift apart. */
const REASK_DETAIL_MAX_LEN = 200;
const REASK_DETAIL_LINE_RE = new RegExp(`^[\\x20-\\x7E]{1,${REASK_DETAIL_MAX_LEN}}$`);

const tryJsonObject = (s: string): Record<string, unknown> | null => {
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

/** Field is only usable when it is a REAL string matching the identifier
 *  grammar — String(undefined)/String(null) would pass the regex and
 *  fabricate "task=undefined" detail lines. */
const safeField = (v: unknown): string | null =>
  typeof v === "string" && SAFE_REASK_FIELD_RE.test(v) ? v : null;

export function extractReaskDetail(e: unknown, validationCode: string): string {
  const detail =
    e instanceof IntegrityError && typeof e.detail === "string" ? e.detail : "";
  let out: string | null = null;
  switch (validationCode) {
    case "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT": {
      // gate detail: {"task": <key>, "artifact": <name>}
      const j = tryJsonObject(detail);
      const t = j ? safeField(j.task) : null;
      const a = j ? safeField(j.artifact) : null;
      if (typeof t === "string" && typeof a === "string") {
        out = `task=${t} artifact=${a}`;
      }
      break;
    }
    case "FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK": {
      // gate detail: {"task": <key>} — never the instruction text.
      const j = tryJsonObject(detail);
      const t = j && safeField(j.task);
      if (typeof t === "string") {
        out = `task=${t}`;
      }
      break;
    }
    case "FAIL_CLOSED_PLAN_INCOMPLETE": {
      // JSON form: {"requirement": <id>, "kind": <k>, "text": ...} — text is
      // operator-goal-derived and never rendered. Prose form:
      // "task <key> claims coverage of <id> it does not provide".
      const j = tryJsonObject(detail);
      const req = j && safeField(j.requirement);
      if (typeof req === "string") {
        const kind = j && safeField(j.kind);
        out = `requirement=${req}${typeof kind === "string" ? ` kind=${kind}` : ""}`;
      } else {
        const m = /^task (\S+) claims coverage of ([A-Z0-9_]+) it does not provide$/.exec(detail);
        if (m && SAFE_REASK_FIELD_RE.test(m[1]) && SAFE_REASK_FIELD_RE.test(m[2])) {
          out = `task=${m[1]} requirement=${m[2]}`;
        }
      }
      break;
    }
    // (FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED retired — the UNDECLARED gate
    // no longer exists under the simplified planner contract; the
    // PLAN_INCOMPLETE branch above still carries fabricated-claim detail.)
    case "FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED": {
      // gate detail: "task <key> requests live/web fetching without NETWORK_ACCESS"
      const m = /^task (\S+) requests live\/web fetching without NETWORK_ACCESS$/.exec(detail);
      if (m && SAFE_REASK_FIELD_RE.test(m[1])) {
        out = `task=${m[1]} reason=NETWORK_ACCESS_REQUIRED`;
      }
      break;
    }
    case "FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID": {
      // gate detail: {"task": <key>, "reason": <bounded reason token>}
      const j = tryJsonObject(detail);
      const t = j ? safeField(j.task) : null;
      const r = j ? safeField(j.reason) : null;
      if (typeof t === "string") {
        out = `task=${t}${typeof r === "string" ? ` reason=${r}` : ""}`;
      }
      break;
    }
    default:
      break;
  }
  return out !== null && REASK_DETAIL_LINE_RE.test(out) ? out : validationCode;
}

/** Failure classes carrying operator-safe diagnostics. */
export const PLANNER_FAILURE_CLASS = {
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  QUOTA_RATE_LIMITED: "QUOTA_RATE_LIMITED",
  AUTH_REJECTED: "AUTH_REJECTED",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  /** Codex CLI transport: the `codex` binary is not resolvable/executable. */
  CLI_MISSING: "CLI_MISSING",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  PLAN_INVALID: "PLAN_INVALID",
  PLAN_DEGENERATE: "PLAN_DEGENERATE",
} as const;
export type PlannerFailureClass =
  (typeof PLANNER_FAILURE_CLASS)[keyof typeof PLANNER_FAILURE_CLASS];

/**
 * R1.A — bounded durable attempt warnings that never evict PAIR-authored
 * provenance. The durable set stays ≤10 and in original order: every
 * protected marker is retained — REPAIRED_REMOTE_DEPENDENT_EDGE (proves
 * a PAIR-authored instruction rewrite) and P-REASK REASK:* /
 * REASK_SUCCEEDED:* (proves PAIR's one bounded feedback re-ask) — and
 * the earliest non-protected warnings fill the remaining budget.
 * Deterministic, no duplicates, never unbounded.
 */
export function boundedAttemptWarnings(warnings: string[]): string[] {
  const isProtected = (w: string) =>
    w.startsWith("REPAIRED_") ||
    w.startsWith("REASK:") ||
    w.startsWith("REASK_SUCCEEDED:");
  const nonProtectedBudget = Math.max(
    0,
    10 - warnings.filter(isProtected).length,
  );
  const out: string[] = [];
  let keptNonProtected = 0;
  for (const w of warnings) {
    if (out.includes(w)) continue;
    if (isProtected(w)) {
      if (out.length < 10) out.push(w);
    } else if (keptNonProtected < nonProtectedBudget) {
      out.push(w);
      keptNonProtected++;
    }
  }
  return out;
}

/** Map llmPlan()'s warning codes to deterministic failure classes. */
export function classifyPlannerFailure(warnings: string[]): PlannerFailureClass {
  const w = warnings[0] ?? "LLM_PLANNER_REQUEST_ERROR";
  // CPL-1 — Codex CLI transport warnings map onto the same classes; a
  // transport-specific code is evidence detail, not a parallel taxonomy.
  if (w === "CODEX_CLI_MISSING") return PLANNER_FAILURE_CLASS.CLI_MISSING;
  if (w === "CODEX_AUTH_FAILED") return PLANNER_FAILURE_CLASS.AUTH_REJECTED;
  if (w === "CODEX_MODEL_UNAVAILABLE") return PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE;
  if (w === "CODEX_TIMEOUT") return PLANNER_FAILURE_CLASS.TIMEOUT;
  if (w === "CODEX_RATE_LIMITED") return PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED;
  if (w === "CODEX_OUTPUT_INVALID") return PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE;
  if (w === "CODEX_PLAN_DEGENERATE") return PLANNER_FAILURE_CLASS.PLAN_DEGENERATE;
  if (w === "CODEX_SPAWN_ERROR" || w.startsWith("CODEX_SPAWN_ERROR:")) return PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE;
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
  /** Transport for the invocation (CPL-1): default OpenAI-compatible HTTP;
   *  "codex_cli" routes go through the dedicated CodexPlannerProvider
   *  spawn transport — never the governed CodexCliExecutorAdapter. */
  transport?: "openai_http" | "codex_cli";
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
  planFn: (
    c: PlannerCandidate,
    invocation: PlannerInvocation,
  ) => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[]; raw_delivery_emission_count?: number; raw_delivery_emission_state?: RawDeliveryEmissionState }>;
  /** Canonical per-invocation eligibility proof (role + lifecycle).
   *  Throw = authority failure (propagates); return {reject:true,...} =
   *  failover-eligible availability rejection. May be async (CPL-1 R1 —
   *  a transport's codex-first seam performs ONE bounded canonical
   *  refresh before settling an availability rejection). */
  assertEligible: (
    c: PlannerCandidate,
  ) =>
    | void
    | { reject: true; failure_class: PlannerFailureClass; reason: string }
    | Promise<void | { reject: true; failure_class: PlannerFailureClass; reason: string }>;
  /** The one canonical task-preparation seam — returns the exact canonical
   *  task list the preview will pin; any throw → PLAN_INVALID failover.
   *  `evidence` carries bounded provenance belonging to THIS exact planFn
   *  invocation (INITIAL vs REASK vs another candidate): the true raw
   *  TELEGRAM_DELIVERY emission count captured on the parsed provider JSON
   *  before the transport's own sanitize pass (HOTFIX 1 R1). Descriptive
   *  only — never authority. */
  canonicalize?: (
    tasks: Array<Record<string, unknown>>,
    c: PlannerCandidate,
    evidence?: {
      raw_delivery_emission_count?: number;
      /** R2 — tri-state verdict for the count: ABSENT = proven omission,
       *  PRESENT = proven emission, INDETERMINATE = uninspected content
       *  (never a proven R=0 — the canonicalizer must fail closed). */
      raw_delivery_emission_state?: RawDeliveryEmissionState;
    },
  ) => Array<Record<string, unknown>>;
  onAttemptStart?: (base: Omit<PlannerAttemptRecord, "outcome">) => unknown;
  onAttemptEnd?: (token: unknown, record: PlannerAttemptRecord) => void;
  /** P-REASK R4 — fires AFTER eligibility re-proof and BEFORE the second
   *  model invocation so the STARTED attempt row durably records
   *  `REASK:<code>`; a crash after this point leaves provable evidence
   *  that the re-ask began. Never a second attempt row. */
  onAttemptReask?: (token: unknown, validationCode: string) => void;
  /** P-REASK R3 — per-candidate latency authority. When absent the
   *  re-ask runs with no budget limit (test seams); production wires the
   *  transport-derived ceiling so worst-case latency never grows. */
  latencyBudget?: (c: PlannerCandidate) => PlannerLatencyBudget;
  /** Phase C — ONE run-level deadline spanning every candidate, every
   *  eligibility/qualification step, the INITIAL model call, transport
   *  retries and the bounded REASK. Absolute epoch ms. Each gate
   *  recomputes the remaining budget; every provider request timeout is
   *  min()'d against it; a result landing past the deadline is
   *  discarded — never a winner, never an unauthorized Mission. Expiry
   *  throws FAIL_CLOSED_PLANNER_DEADLINE (not failover-eligible): the
   *  caller settles the run FAILED — never EXHAUSTED, since untried
   *  candidates were denied by the deadline rather than by failure. */
  deadlineMs?: number;
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
  // Phase C — the single run-level deadline helpers: deadlineRemaining()
  // folds the run budget into every downstream check; settleDeadline()
  // persists honest TIMEOUT/RUN_DEADLINE evidence on an already-open
  // attempt before the typed throw propagates.
  const deadlineAt = opts.deadlineMs ?? null;
  const deadlineRemaining = () =>
    deadlineAt == null ? Number.MAX_SAFE_INTEGER : deadlineAt - Date.now();
  const deadlineError = () =>
    new IntegrityError(
      "FAIL_CLOSED_PLANNER_DEADLINE",
      JSON.stringify({ attempts: attempts.length, candidates_tried: n }),
    );
  const settleDeadline = (
    base: Omit<PlannerAttemptRecord, "outcome">,
    t0: number,
    settle: (rec: PlannerAttemptRecord) => void,
  ): never => {
    settle({
      ...base,
      completed_at: now(),
      latency_ms: Date.now() - t0,
      outcome: "FAILED",
      failure_class: PLANNER_FAILURE_CLASS.TIMEOUT,
      warnings: ["RUN_DEADLINE_EXCEEDED"],
    });
    throw deadlineError();
  };
  let n = 0;
  for (const c of opts.candidates) {
    // Phase C — run deadline BEFORE a new attempt opens: an untried
    // candidate leaves no STARTED row; the run dies DEADLINE, never
    // EXHAUSTED.
    if (deadlineRemaining() <= 0) throw deadlineError();
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
    // rejections settle FAILED and move to the next candidate. A handled
    // authority rejection settles the already-persisted STARTED row to
    // terminal FAILED before propagating (R3 §5): a governed rejection
    // must not look like a crashed in-flight invocation.
    let elig;
    try {
      elig = await opts.assertEligible(c);
    } catch (e) {
      settle({
        ...base,
        completed_at: now(),
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        warnings: [
          `AUTHORITY_REJECTED:${String((e as { code?: string }).code ?? (e instanceof Error ? e.name : e)).slice(0, 80)}`,
        ],
      });
      throw e;
    }
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
    // Phase C — deadline re-proved AFTER the (possibly async)
    // eligibility/qualification step; the INITIAL request timeout is
    // bounded by whatever the run deadline left over.
    if (deadlineRemaining() <= 0) settleDeadline(base, t0, settle);
    // P-REASK — set only after the re-ask marker is durably persisted
    // (onAttemptReask). When the SECOND invocation itself dies, the outer
    // catch keeps `REASK:<code>` in the settled warnings so the durable
    // row still proves the re-ask began.
    let reaskInitiated: string | null = null;
    try {
      const res = await opts.planFn(c, {
        kind: "INITIAL",
        ...(deadlineAt != null
          ? {
              timeoutMs: Math.min(
                opts.latencyBudget?.(c)?.requestTimeoutMs ?? Number.MAX_SAFE_INTEGER,
                Math.max(1, deadlineRemaining()),
              ),
            }
          : {}),
      });
      // Phase C — a result landing past the run deadline is discarded:
      // it can never become a winner or mint an unauthorized Mission.
      if (deadlineRemaining() <= 0) settleDeadline(base, t0, settle);
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
          canonical = opts.canonicalize(res.tasks, c, {
            raw_delivery_emission_count: res.raw_delivery_emission_count,
            raw_delivery_emission_state: res.raw_delivery_emission_state,
          });
        } catch (e) {
          // P-GRAMMAR2 §3 — bounded typed observability: surface the
          // thrown canonical-validation code on the attempt alongside
          // the class marker — never exception messages, stack traces,
          // or secret material. R1.B — exact identity only: the RAW
          // code must itself be non-empty, ≤80 chars, and strict-safe;
          // a longer or malformed code persists NO VALIDATION_CODE
          // rather than a truncated/fabricated identity.
          const rawCode =
            e &&
            typeof e === "object" &&
            typeof (e as { code?: unknown }).code === "string"
              ? (e as { code: string }).code
              : "";
          const coded =
            rawCode.length > 0 &&
            rawCode.length <= 80 &&
            /^[A-Z0-9_:.\-]+$/.test(rawCode)
              ? `VALIDATION_CODE:${rawCode}`
              : null;
          // P-REASK — ONE bounded feedback re-ask for an eligible
          // canonical plan-validation rejection: same candidate, typed
          // code + task-keyed markers as feedback, exactly one provider
          // request, inside the candidate latency ceiling. Everything
          // else keeps the historical FAILED → failover semantics.
          const reaskCode = extractReaskEligibleCode(e);
          if (reaskCode) {
            const budget = opts.latencyBudget?.(c);
            // Phase C — the re-ask may spend ONLY what the candidate
            // ceiling AND the run deadline both leave over.
            const preReproofRemaining = Math.min(
              budget == null
                ? Number.MAX_SAFE_INTEGER
                : budget.ceilingMs - (Date.now() - t0),
              deadlineRemaining(),
            );
            if (preReproofRemaining > 0) {
              // §9/R4 + R1.A — a second model invocation re-proves
              // canonical eligibility first. An authority throw falls
              // straight into the outer catch, which settles the attempt
              // EXACTLY ONCE (single FAILED record/event, original
              // attempt_no) — no inner settle may precede it. An
              // availability rejection prevents the re-ask; normal
              // failover proceeds.
              const elig2 = await opts.assertEligible(c);
              if (elig2 && elig2.reject) {
                settle({
                  ...base,
                  completed_at: now(),
                  latency_ms: Date.now() - t0,
                  outcome: "FAILED",
                  failure_class: elig2.failure_class,
                  warnings: [`ELIGIBILITY_REJECTED:${elig2.reason}`],
                });
                continue;
              }
              // R1.B — remaining budget is recomputed AFTER the
              // re-proof consumed real time; a non-positive remainder
              // means no marker, no event, no second invocation — the
              // candidate settles on the ORIGINAL canonical rejection.
              // Phase C — the remainder is min()'d against the run
              // deadline; an expired deadline is a run failure, not a
              // candidate rejection.
              const remaining = Math.min(
                budget == null
                  ? Number.MAX_SAFE_INTEGER
                  : budget.ceilingMs - (Date.now() - t0),
                deadlineRemaining(),
              );
              if (remaining <= 0 && deadlineRemaining() <= 0) {
                settleDeadline(base, t0, settle);
              }
              if (remaining > 0) {
              // Durable BEFORE the second invocation: the STARTED row
              // records PAIR's re-ask so a crash mid-call can never make
              // the second model request silently absent. R1.C — the
              // persistence seam itself fails closed (governance
              // IntegrityError) when provenance cannot be established;
              // the model is then never invoked.
              opts.onAttemptReask?.(token, reaskCode);
              reaskInitiated = reaskCode;
              const res2 = await opts.planFn(c, {
                kind: "REASK",
                timeoutMs: Math.min(
                  budget?.requestTimeoutMs ?? Number.MAX_SAFE_INTEGER,
                  remaining,
                ),
                maxProviderRequests: 1,
                rejectionContext: {
                  validation_code: reaskCode,
                  task_warnings: boundedReaskTaskWarnings(res.warnings),
                  detail: extractReaskDetail(e, reaskCode),
                },
              });
              // Phase C — a re-ask result landing past the run deadline
              // is discarded exactly like a late INITIAL result.
              if (deadlineRemaining() <= 0) settleDeadline(base, t0, settle);
              if (Array.isArray(res2.tasks) && res2.tasks.length) {
                try {
                  const canonical2 = opts.canonicalize
                    ? opts.canonicalize(res2.tasks, c, {
                        raw_delivery_emission_count: res2.raw_delivery_emission_count,
                        raw_delivery_emission_state: res2.raw_delivery_emission_state,
                      })
                    : res2.tasks;
                  if (!canonical2.length) {
                    settle({
                      ...base,
                      completed_at: now(),
                      latency_ms: Date.now() - t0,
                      outcome: "FAILED",
                      failure_class: PLANNER_FAILURE_CLASS.PLAN_INVALID,
                      warnings: boundedAttemptWarnings([
                        ...res.warnings,
                        ...res2.warnings,
                        `REASK:${reaskCode}`,
                        "CANONICAL_VALIDATION_EMPTY",
                      ]),
                    });
                    continue;
                  }
                  settle({
                    ...base,
                    completed_at: now(),
                    latency_ms: Date.now() - t0,
                    outcome: "SUCCESS",
                    warnings: boundedAttemptWarnings([
                      ...res.warnings,
                      ...res2.warnings,
                      `REASK:${reaskCode}`,
                      `REASK_SUCCEEDED:${reaskCode}`,
                    ]),
                  });
                  return { tasks: canonical2, winner: attempts[attempts.length - 1], attempts, warnings: res2.warnings };
                } catch (e2) {
                  // Second canonical rejection: deterministic FINAL
                  // validation identity — the second code is the
                  // terminal defect; REASK:<initial> stays durable.
                  const rawCode2 =
                    e2 &&
                    typeof e2 === "object" &&
                    typeof (e2 as { code?: unknown }).code === "string"
                      ? (e2 as { code: string }).code
                      : "";
                  const coded2 =
                    rawCode2.length > 0 &&
                    rawCode2.length <= 80 &&
                    SAFE_CODE_RE.test(rawCode2)
                      ? `VALIDATION_CODE:${rawCode2}`
                      : null;
                  settle({
                    ...base,
                    completed_at: now(),
                    latency_ms: Date.now() - t0,
                    outcome: "FAILED",
                    failure_class: PLANNER_FAILURE_CLASS.PLAN_INVALID,
                    warnings: boundedAttemptWarnings([
                      ...res.warnings,
                      ...res2.warnings,
                      ...(coded2 ? [coded2] : []),
                      `REASK:${reaskCode}`,
                      "CANONICAL_VALIDATION_FAILED",
                    ]),
                  });
                  continue;
                }
              }
              settle({
                ...base,
                completed_at: now(),
                latency_ms: Date.now() - t0,
                outcome: "FAILED",
                failure_class: classifyPlannerFailure(res2.warnings),
                warnings: boundedAttemptWarnings([
                  ...res.warnings,
                  ...res2.warnings,
                  `REASK:${reaskCode}`,
                ]),
              });
              continue;
              }
            }
          }
          // Phase C — expiry between the canonical rejection and the
          // settle is a run-deadline failure, not a plan defect.
          if (deadlineRemaining() <= 0) settleDeadline(base, t0, settle);
          settle({
            ...base,
            completed_at: now(),
            latency_ms: Date.now() - t0,
            outcome: "FAILED",
            failure_class: PLANNER_FAILURE_CLASS.PLAN_INVALID,
            warnings: [
              ...res.warnings.slice(0, coded ? 8 : 9),
              ...(coded ? [coded] : []),
              "CANONICAL_VALIDATION_FAILED",
            ],
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
      settle({ ...base, completed_at: completed, latency_ms: Date.now() - t0, outcome: "SUCCESS", warnings: boundedAttemptWarnings(res.warnings) });
      return { tasks: canonical, winner: attempts[attempts.length - 1], attempts, warnings: res.warnings };
    } catch (e) {
      // Integrity/authority failures are not failover-eligible — settle
      // the STARTED row to terminal FAILED, then propagate (R3 §5/§6).
      // A re-ask already durably initiated keeps its marker on the row.
      const reaskMarker = reaskInitiated ? [`REASK:${reaskInitiated}`] : [];
      if (e instanceof IntegrityError) {
        // Phase C — a run-deadline throw already settled this attempt
        // honestly (RUN_DEADLINE_EXCEEDED); never settle it twice.
        if (e.code === "FAIL_CLOSED_PLANNER_DEADLINE") {
          throw e;
        }
        settle({
          ...base,
          completed_at: now(),
          latency_ms: Date.now() - t0,
          outcome: "FAILED",
          warnings: boundedAttemptWarnings([
            `AUTHORITY_REJECTED:${String(e.code ?? "IntegrityError").slice(0, 80)}`,
            ...reaskMarker,
          ]),
        });
        throw e;
      }
      settle({
        ...base,
        completed_at: now(),
        latency_ms: Date.now() - t0,
        outcome: "FAILED",
        failure_class: PLANNER_FAILURE_CLASS.NETWORK_ERROR,
        warnings: boundedAttemptWarnings([
          String(e instanceof Error ? e.name : e).slice(0, 80),
          ...reaskMarker,
        ]),
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
