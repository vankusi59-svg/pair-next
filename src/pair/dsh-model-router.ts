/**
 * dsh-model-router — governed DSH multi-model routing + safe failover +
 * durable attempt provenance (Post-P14 Phase C).
 *
 * Layering (mandate §3–§6): MissionRouter chooses the EXECUTOR, RouteSelector
 * chooses the generic executor route (RTE_DSH_ACP binding.capabilities proves
 * task capability), and ONLY THEN this router chooses WHICH DSH_EXECUTION
 * model runs inside the DSH executor. Model candidates are never generic
 * PAIR routes and never mutate executor_supply_binding capability authority
 * (PR #24 invariants preserved).
 *
 * Candidate authority is the canonical `model_binding` layer (MBD_*):
 * executor ↔ provider ↔ model routability — distinct from
 * executor_supply_binding (executor ↔ route capability). Both must pass.
 *
 * Ordering is deterministic configured order (primary → fallback → extras),
 * resolved to canonical model_entry_id through the Phase A strict seam and
 * deduplicated AFTER resolution — never adaptive ranking.
 *
 * Eligibility is re-proved before EVERY invocation (role still held, not a
 * Planner alias, provider/model gates current, model_binding QUALIFIED,
 * executor authority current) — startup qualification is never trusted as
 * still-current.
 *
 * Authority vs availability (mandate §12): governance failures throw
 * IntegrityError and propagate — NEVER failover-eligible; temporary
 * availability rejections return {reject:true,failure_class} and may move to
 * the next candidate. Classification is deterministic.
 *
 * Side-effect safety (mandate §15): automatic next-model selection is
 * permitted ONLY before the task could have produced side effects — i.e.
 * before session/prompt dispatch. Once dispatched (or the dispatch state is
 * uncertain) no next model is invoked; the failure flows into the existing
 * runtime/recovery taxonomy.
 *
 * Provenance (mandate §23–§25): every candidate attempt persists a
 * `dsh_model_attempt` (DMA_*) row + DSH_MODEL_ATTEMPT_* lifecycle events.
 * A crash after STARTED stays STARTED — distinguishable from FAILED. At most
 * ONE attempt wins a governed task execution.
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { ExecutorRegistry } from "./executor-registry.js";
import {
  assertDshExecutionModelRole,
  listModelRoleAssignments,
  MODEL_ROLE,
  sameCanonicalModel,
} from "./model-role.js";
import {
  listBindings,
  providerModelEligibility,
  type ModelBindingRow,
} from "./model-routable.js";
import type { PairEvidenceStore } from "./store.js";
import type { PairControlPlane } from "./service.js";

/* ------------------------------------------------------- failure class -- */

/** DSH failure classes mapped onto the existing runtime taxonomy (§33). */
export const DSH_FAILURE_CLASS = {
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  RATE_LIMITED: "RATE_LIMITED",
  TRANSIENT_TRANSPORT: "TRANSIENT_TRANSPORT",
  TIMEOUT: "TIMEOUT",
  /** Governance/authority rejection — truthful durable classification for
   *  throws that are never a failover signal (role, binding, eligibility
   *  authority, identity drift). Distinct from availability and transport. */
  AUTHORITY_REJECTED: "AUTHORITY_REJECTED",
} as const;
export type DshFailureClass = (typeof DSH_FAILURE_CLASS)[keyof typeof DSH_FAILURE_CLASS];

/* ---------------------------------------------------------- candidates -- */

/**
 * One canonical DSH model candidate. `model_entry_id` is the identity role
 * authority binds to; `pid`/`mid` are the provider/model pair pinned on the
 * ACP session via session/set_config_option("model"); `ref` is the exact
 * configured route string for provenance.
 */
export interface DshModelCandidate {
  ref: string;
  pid: string;
  mid: string;
  model_entry_id: string;
}

export interface DshEligibilityRejection {
  reject: true;
  failure_class: DshFailureClass;
  reason: string;
}

/** Transport compatibility DSH accepts on a model_binding (ACP ↔
 *  OpenAI-completions providers only — anything else fails closed). */
export const DSH_VALID_TRANSPORT_COMPAT = new Set(["OPENAI_COMPLETIONS"]);

/**
 * The canonical model_binding governing one candidate — EXACT identity:
 * executor_id AND model_entry_id AND (when given) provider_id must all
 * match. Returns null when no binding row exists — eligibility then fails
 * closed. A QUALIFIED binding for the same model_entry_id but a different
 * provider is NOT accepted (R1).
 */
export function resolveDshModelBinding(
  service: PairControlPlane,
  executorId: string,
  modelEntryId: string,
  providerId?: string,
): ModelBindingRow | null {
  const matches = listBindings(service).filter(
    (b) =>
      b.executor_id === executorId &&
      String(b.model_entry_id) === String(modelEntryId) &&
      (providerId === undefined || String(b.provider_id) === String(providerId)),
  );
  return matches.find((b) => b.qualification_state === "QUALIFIED") ?? matches[0] ?? null;
}

/* ----------------------------------------------------- eligibility ------ */

/** Gates whose failure is AUTHORITY (fail closed, never a failover signal). */
const DSH_AUTHORITY_GATES = new Set([
  "PROVIDER_QUALIFIED",
  "PROVIDER_AUTH_OK",
  "PROVIDER_NOT_BLOCKED",
  "MODEL_NOT_REVOKED",
]);

/**
 * Full canonical eligibility proof for a DSH model candidate — the mirror
 * of `assertPlannerCandidateEligible` (Phase B), reusing the same canonical
 * seams so the two can never disagree:
 *
 *  1. `assertDshExecutionModelRole` — entry exists, still holds
 *     DSH_EXECUTION, not REMOVED/DEPRECATED/BLOCKED (throws = authority);
 *  2. not canonically equivalent/alias to any active PLANNER_COORDINATOR
 *     model — `sameCanonicalModel` (throws = authority);
 *  3. `providerModelEligibility` — the shared provider/model truth:
 *     authority gates (provider qualification/auth/blocked, model
 *     REMOVED/DEPRECATED/BLOCKED) throw; availability gates
 *     (provider DOWN/UNAVAILABLE, model not QUALIFIED/STALE/UNAVAILABLE)
 *     return {reject:true};
 *  4. executor authority — EXECUTOR_REGISTERED/ENABLED/QUALIFIED/HEALTHY
 *     from the durable descriptor (throws = authority);
 *  5. canonical `model_binding` — exists AND qualification_state QUALIFIED
 *     (throws = authority: binding absent/not qualified is a governance
 *     failure, not availability).
 *
 * Role mutation after boot takes effect on the very next invocation —
 * every gate reads current durable state.
 */
export function assertDshCandidateEligible(
  service: PairControlPlane,
  candidate: DshModelCandidate,
  executorId: string,
): DshEligibilityRejection | void {
  const store = service.store;
  const mid = String(candidate.model_entry_id);
  assertDshExecutionModelRole(store, mid);
  const model = store.get("model_entry", mid);
  // Reverse of the Planner check: a DSH candidate canonically equal to a
  // live Planner authority is an overlap violation — pools stay disjoint.
  for (const asn of listModelRoleAssignments(store)) {
    if (asn.role !== MODEL_ROLE.PLANNER_COORDINATOR) continue;
    const other = store.tryGet("model_entry", String(asn.model_entry_id));
    if (other && sameCanonicalModel(model, other)) {
      throw new IntegrityError(
        "FAIL_CLOSED_DSH_PLANNER_OVERLAP",
        JSON.stringify({ model_entry_id: mid, planner_model_entry_id: String(asn.model_entry_id) }),
      );
    }
  }
  const elig = providerModelEligibility(
    store,
    String(model.provider_family ?? candidate.pid),
    mid,
  );
  if (!elig.eligible) {
    const failed = Object.keys(elig.gates).filter((g) => elig.gates[g] === "FAIL");
    if (failed.some((g) => DSH_AUTHORITY_GATES.has(g))) {
      throw new IntegrityError(
        "FAIL_CLOSED_DSH_PROVIDER_INELIGIBLE",
        JSON.stringify({ model_entry_id: mid, provider_id: candidate.pid, failed_gates: failed }),
      );
    }
    return {
      reject: true,
      failure_class: failed.includes("PROVIDER_HEALTH_OK")
        ? DSH_FAILURE_CLASS.PROVIDER_UNAVAILABLE
        : DSH_FAILURE_CLASS.MODEL_UNAVAILABLE,
      reason: failed.join(","),
    };
  }
  // Executor authority — current durable descriptor, not boot memory.
  const registry = new ExecutorRegistry(service);
  const exec = service
    .listExecutors()
    .find((e) => String(e.executor_id) === executorId);
  if (!exec) {
    throw new IntegrityError(
      "FAIL_CLOSED_DSH_EXECUTOR_INELIGIBLE",
      JSON.stringify({ executor_id: executorId, gate: "EXECUTOR_REGISTERED" }),
    );
  }
  const desc = registry.normalizeDescriptor(exec);
  const executorGate =
    desc.availability_state !== "AVAILABLE"
      ? "EXECUTOR_ENABLED"
      : desc.qualification_state !== "QUALIFIED"
        ? "EXECUTOR_QUALIFIED"
        : desc.health_state !== "READY"
          ? "EXECUTOR_HEALTHY"
          : null;
  if (executorGate) {
    throw new IntegrityError(
      "FAIL_CLOSED_DSH_EXECUTOR_INELIGIBLE",
      JSON.stringify({ executor_id: executorId, gate: executorGate }),
    );
  }
  // Canonical model binding — EXACT identity: the binding must name THIS
  // candidate's provider AND model_entry for THIS executor, be QUALIFIED,
  // and carry a DSH-valid transport. Absent, mismatched-provider,
  // non-qualified, or wrong-transport bindings are governance failures —
  // never silently skipped to the next candidate.
  const binding = resolveDshModelBinding(service, executorId, mid, candidate.pid);
  if (
    !binding ||
    binding.qualification_state !== "QUALIFIED" ||
    !DSH_VALID_TRANSPORT_COMPAT.has(String(binding.transport_compat))
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_DSH_MODEL_BINDING",
      JSON.stringify({
        model_entry_id: mid,
        provider_id: candidate.pid,
        executor_id: executorId,
        binding_id: binding?.binding_id ?? null,
        binding_provider_id: binding?.provider_id ?? null,
        qualification_state: binding?.qualification_state ?? null,
        transport_compat: binding?.transport_compat ?? null,
      }),
    );
  }
}

/* ------------------------------------------------------- attempt rows --- */

export const DSH_ATTEMPT_ENTITY = "dsh_model_attempt";

export function dshAttemptId(governedTaskId: string, attemptNo: number): string {
  return `DMA_${digest({ governed_task_id: String(governedTaskId), attempt_no: attemptNo }).slice(0, 24)}`;
}

export interface DshAttemptToken {
  attempt_id: string;
  attempt_no: number;
  candidate: DshModelCandidate;
  /** flipped exactly once, immediately before session/prompt dispatch. */
  dispatched: boolean;
}

function putAttempt(
  store: PairEvidenceStore,
  body: Record<string, unknown>,
  version: number,
): Record<string, unknown> {
  return store.put(DSH_ATTEMPT_ENTITY, String(body.dsh_model_attempt_id), body, version);
}

/* ------------------------------------------------------------ router ---- */

export interface DshModelRouter {
  candidates(): DshModelCandidate[];
  assertEligible(c: DshModelCandidate): DshEligibilityRejection | void;
  attemptStart(opts: {
    candidate: DshModelCandidate;
    governed_task_id: string;
    mission_id: string;
    task_id: string;
    correlation_id: string;
    route_id?: string | null;
    executor_supply_binding_id?: string | null;
    execution_id?: string | null;
    attempt_no: number;
  }): DshAttemptToken;
  /** Persist dispatch_state=DISPATCHED — survives a crash as proof the task may have run. */
  markDispatched(token: DshAttemptToken): void;
  attemptEnd(
    token: DshAttemptToken,
    result: {
      outcome: "SUCCESS" | "FAILED";
      failure_class?: DshFailureClass;
      error_code?: string | null;
      safe_to_failover: boolean;
      winner?: boolean;
    },
  ): void;
  /** classify a thrown error: dispatched=true ⇒ never failover-eligible. */
  classifyError(err: unknown, dispatched: boolean): {
    failure_class: DshFailureClass;
    safe_to_failover: boolean;
  };
}

/**
 * Create the canonical DSH model router bound to durable state. `candidates`
 * is the boot-resolved canonical pool in configured order (primary →
 * fallback → extras, deduped by model_entry_id).
 */
export function createDshModelRouter(opts: {
  service: PairControlPlane;
  executorId: string;
  candidates: DshModelCandidate[];
}): DshModelRouter {
  const { service, executorId } = opts;
  const store = service.store;
  const candidates = opts.candidates.map((c) => ({ ...c }));

  const attemptBody = (token: DshAttemptToken): Record<string, unknown> =>
    store.get(DSH_ATTEMPT_ENTITY, token.attempt_id);

  return {
    candidates: () => candidates.map((c) => ({ ...c })),

    assertEligible: (c) => assertDshCandidateEligible(service, c, executorId),

    attemptStart(o) {
      const attemptId = dshAttemptId(o.governed_task_id, o.attempt_no);
      const binding = resolveDshModelBinding(
        service,
        executorId,
        o.candidate.model_entry_id,
        o.candidate.pid,
      );
      const body: Record<string, unknown> = {
        dsh_model_attempt_id: attemptId,
        mission_id: o.mission_id,
        task_id: o.task_id,
        governed_task_id: o.governed_task_id,
        executor_id: executorId,
        generic_route_id: o.route_id ?? null,
        executor_supply_binding_id: o.executor_supply_binding_id ?? null,
        model_binding_id: binding?.binding_id ?? null,
        provider_id: o.candidate.pid,
        model_entry_id: o.candidate.model_entry_id,
        model_id: o.candidate.mid,
        configured_ref: o.candidate.ref,
        attempt_no: o.attempt_no,
        started_at: utcnow(),
        completed_at: null,
        latency_ms: null,
        outcome: "STARTED",
        failure_class: null,
        error_code: null,
        dispatch_state: "PRE_DISPATCH",
        safe_to_failover: null,
        winner: false,
        execution_id: o.execution_id ?? null,
        correlation_id: o.correlation_id,
      };
      putAttempt(store, body, 0);
      store.event({
        entity_type: DSH_ATTEMPT_ENTITY,
        entity_id: attemptId,
        event_type: "DSH_MODEL_ATTEMPT_STARTED",
        new_state: "STARTED",
        actor: "PAIR_DSH_MODEL_ROUTER",
        correlation_id: o.correlation_id ?? null,
        metadata: {
          governed_task_id: o.governed_task_id,
          attempt_no: o.attempt_no,
          configured_ref: o.candidate.ref,
          provider_id: o.candidate.pid,
          model_entry_id: o.candidate.model_entry_id,
        },
      });
      return { attempt_id: attemptId, attempt_no: o.attempt_no, candidate: o.candidate, dispatched: false };
    },

    markDispatched(token) {
      token.dispatched = true;
      const body = attemptBody(token);
      body.dispatch_state = "DISPATCHED";
      putAttempt(store, body, Number(body.version));
    },

    attemptEnd(token, result) {
      const body = attemptBody(token);
      const started = Date.parse(String(body.started_at));
      body.outcome = result.outcome;
      body.completed_at = utcnow();
      body.latency_ms = Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
      body.failure_class = result.failure_class ?? null;
      body.error_code = result.error_code ?? null;
      body.safe_to_failover = result.safe_to_failover;
      body.winner = result.winner === true;
      putAttempt(store, body, Number(body.version));
      store.event({
        entity_type: DSH_ATTEMPT_ENTITY,
        entity_id: token.attempt_id,
        event_type:
          result.outcome === "SUCCESS" ? "DSH_MODEL_ATTEMPT_SUCCEEDED" : "DSH_MODEL_ATTEMPT_FAILED",
        old_state: "STARTED",
        new_state: result.outcome,
        actor: "PAIR_DSH_MODEL_ROUTER",
        metadata: {
          attempt_no: token.attempt_no,
          configured_ref: token.candidate.ref,
          model_entry_id: token.candidate.model_entry_id,
          failure_class: result.failure_class ?? null,
          safe_to_failover: result.safe_to_failover,
          winner: result.winner === true,
        },
      });
    },

    classifyError(err, dispatched) {
      if (dispatched) {
        return { failure_class: DSH_FAILURE_CLASS.TRANSIENT_TRANSPORT, safe_to_failover: false };
      }
      const code = String((err as { code?: string })?.code ?? (err instanceof Error ? err.name : err));
      if (/TIMEOUT/i.test(code)) return { failure_class: DSH_FAILURE_CLASS.TIMEOUT, safe_to_failover: true };
      if (/429|RATE_LIMIT|QUOTA|TPM|TPD/i.test(code))
        return { failure_class: DSH_FAILURE_CLASS.RATE_LIMITED, safe_to_failover: true };
      if (/CREDENTIAL|AUTH_|401|403/i.test(code))
        return { failure_class: DSH_FAILURE_CLASS.CREDENTIAL_MISSING, safe_to_failover: true };
      if (/MODEL_UNAVAILABLE|MODEL_NOT|MODEL_REMOVED/i.test(code))
        return { failure_class: DSH_FAILURE_CLASS.MODEL_UNAVAILABLE, safe_to_failover: true };
      if (/PROVIDER/i.test(code))
        return { failure_class: DSH_FAILURE_CLASS.PROVIDER_UNAVAILABLE, safe_to_failover: true };
      // Any other pre-dispatch failure (spawn, transport, handshake,
      // set_config_option) — the task prompt provably never reached the
      // model, so no side effect could exist: safe to try the next model.
      return { failure_class: DSH_FAILURE_CLASS.TRANSIENT_TRANSPORT, safe_to_failover: true };
    },
  };
}

/**
 * Deterministic exhaustion: every configured candidate failed before
 * dispatch (or none was eligible). Fail closed with safe structured
 * evidence — never borrow a Planner model, an adapter default, or an
 * unconfigured discovered model.
 */
export function dshModelExhaustedError(
  attempts: Array<Record<string, unknown>>,
): IntegrityError {
  return new IntegrityError(
    "FAIL_CLOSED_DSH_MODEL_EXHAUSTED",
    JSON.stringify({
      attempts: attempts.length,
      candidates: attempts.map((a) => ({
        attempt_no: a.attempt_no,
        configured_ref: a.configured_ref,
        provider_id: a.provider_id,
        model_entry_id: a.model_entry_id,
        outcome: a.outcome,
        failure_class: a.failure_class,
        safe_to_failover: a.safe_to_failover,
      })),
    }),
  );
}
