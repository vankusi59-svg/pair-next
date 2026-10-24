/**
 * Phase F3 — canonical plan artifact/dataflow feasibility, plan semantic
 * digest, structured dependency failure context, and the durable
 * replan-attempt ledger.
 *
 * One seam, three authorities:
 *
 *   analyzePlanFeasibility   — structural-only proof that a plan's
 *                              artifact/dataflow graph CAN execute (no
 *                              executor health, no future artifacts).
 *   canonicalPlanSemanticDigest — execution-meaning digest of a task
 *                              list: same topology/instructions/contracts
 *                              → same digest regardless of ids, key
 *                              ordering, timestamps, planner provenance.
 *   Recovery failure context — bounded structured root-cause carried
 *                              from the failing seam into recovery
 *                              decisions, pending_recovery, and the
 *                              replan candidate ledger.
 *
 * Feasibility never replaces F1/F2 runtime authority: a structurally
 * feasible plan may still fail at execution (missing canonical artifact,
 * health, rate limits) — those are recovery concerns, not plan rejects.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import {
  assertPlanArtifactStructure,
  extractTaskDataflow,
} from "./plan-dataflow.js";
import type { PairEvidenceStore } from "./store.js";

/* ==================== 1. DEPENDENCY FAILURE REASON TAXONOMY =========== */

export const PLAN_SEMANTIC_CONTRACT = "pair-plan-semantic.v1";
export const RECOVERY_FAILURE_CONTEXT_CONTRACT =
  "pair-recovery-failure-context.v1";
export const REPLAN_ATTEMPT_CONTRACT = "pair-replan-attempt.v1";

/** Typed structural/root-cause reasons for dependency-class failures.
 *  Recovery authority reads THESE — never free-form error prose. */
export type DependencyReason =
  | "PLAN_DATAFLOW_UNBOUND"
  | "PLAN_DATAFLOW_AMBIGUOUS"
  | "PLAN_DATAFLOW_ORDER_INVALID"
  | "REMOTE_EDGE_UNGOVERNED"
  | "REMOTE_CONSUMER_ARTIFACT_MISSING"
  | "PRODUCER_CANONICAL_ARTIFACT_MISSING"
  | "PRODUCER_VALIDATION_UNAVAILABLE"
  | "ARTIFACT_AUTHORITY_INVALID"
  | "LOCAL_PREREQUISITE_MISSING"
  | "HANDOFF_CONTRACT_INVALID"
  | "HANDOFF_MATERIALIZATION_FAILED";

/**
 * Maps a thrown seam's (code, detail) onto the typed taxonomy. The
 * detail strings are emitted by the F2 resolver/materialization seams;
 * plan-dataflow emits FAIL_CLOSED_PLAN_DATAFLOW_* codes whose detail is
 * a small JSON object ({task, artifact, missing_edge, ...}).
 */
export function dependencyReasonFromError(args: {
  code: string;
  detail?: string;
}): { reason: DependencyReason; artifact_name?: string } | null {
  const code = String(args.code ?? "");
  const detail = String(args.detail ?? "");
  // Structural plan-dataflow codes carry JSON detail.
  let dj: Record<string, unknown> = {};
  if (detail.startsWith("{")) {
    try {
      dj = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      dj = {};
    }
  }
  const artifact = typeof dj.artifact === "string" ? dj.artifact : undefined;
  switch (code) {
    case "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT":
      return { reason: "PLAN_DATAFLOW_UNBOUND", artifact_name: artifact };
    case "FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER":
      return { reason: "PLAN_DATAFLOW_AMBIGUOUS", artifact_name: artifact };
    case "FAIL_CLOSED_PLAN_DATAFLOW_ORDER":
      return { reason: "PLAN_DATAFLOW_ORDER_INVALID", artifact_name: artifact };
    case "FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE":
      return { reason: "REMOTE_EDGE_UNGOVERNED" };
    case "FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND":
      return { reason: "PLAN_DATAFLOW_UNBOUND", artifact_name: artifact };
    case "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE":
      return { reason: "HANDOFF_MATERIALIZATION_FAILED" };
    case "FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT":
      return { reason: "HANDOFF_CONTRACT_INVALID" };
    case "FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT":
      return { reason: "HANDOFF_CONTRACT_INVALID" };
    case "FAIL_CLOSED_ARTIFACT_VERIFICATION":
      return { reason: "ARTIFACT_AUTHORITY_INVALID" };
    case "FAIL_CLOSED_DEPENDENCY_RESOLUTION": {
      const m = detail.match(/^([a-z_]+)(?::(.*))?$/);
      const tag = m?.[1] ?? "";
      const name = m?.[2];
      switch (tag) {
        case "unbound_consume":
          return { reason: "PLAN_DATAFLOW_UNBOUND", artifact_name: name };
        case "ambiguous_producer":
          return { reason: "PLAN_DATAFLOW_AMBIGUOUS", artifact_name: name };
        case "remote_edge_artifact_missing":
          return { reason: "REMOTE_CONSUMER_ARTIFACT_MISSING", artifact_name: name };
        case "ambiguous_artifact":
          return { reason: "PLAN_DATAFLOW_AMBIGUOUS", artifact_name: name };
        case "contradictory_validations":
          return { reason: "PRODUCER_VALIDATION_UNAVAILABLE" };
        case "consume_name_invalid":
          return { reason: "HANDOFF_CONTRACT_INVALID", artifact_name: name };
        case "dependency_count":
        case "dependency_bytes":
          return { reason: "HANDOFF_CONTRACT_INVALID" };
        default:
          return { reason: "ARTIFACT_AUTHORITY_INVALID", artifact_name: name };
      }
    }
    default:
      return null;
  }
}

/* ==================== 2. PLAN FEASIBILITY ============================ */

/**
 * ONE canonical structural feasibility seam (F3 §5): proves the plan's
 * executable artifact/dataflow graph CAN run — every consumed artifact
 * has exactly one earlier producer, remote edges are governed, the DAG
 * is acyclic, delivery stays a leaf. Reuses the same structural core as
 * assertPlanDataflow (assertPlanArtifactStructure) so initial planning,
 * preview, commit, and replan all enforce identical semantics.
 *
 * Throws IntegrityError FAIL_CLOSED_PLAN_FEASIBILITY carrying typed
 * `dependency_reason` + bounded detail; the original seam error code is
 * preserved in `source_code`.
 */
export function analyzePlanFeasibility(
  tasks: Array<Record<string, unknown>>,
): void {
  try {
    assertPlanArtifactStructure(tasks);
  } catch (err) {
    const code = String((err as { code?: string })?.code ?? "FAIL_CLOSED_PLAN_DATAFLOW");
    const detail = String((err as IntegrityError)?.detail ?? "");
    const mapped = dependencyReasonFromError({ code, detail });
    const e = new IntegrityError(
      "FAIL_CLOSED_PLAN_FEASIBILITY",
      detail || code,
    ) as IntegrityError & {
      dependency_reason?: DependencyReason;
      source_code?: string;
    };
    e.dependency_reason = mapped?.reason ?? "ARTIFACT_AUTHORITY_INVALID";
    e.source_code = code;
    throw e;
  }
}

/* ==================== 3. PLAN SEMANTIC DIGEST ======================== */

function sortedStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x)))].sort();
}

/**
 * Execution-meaning digest of a canonical task list (pair-plan-semantic.v1).
 * Two proposals whose executable contracts are identical produce the SAME
 * digest even when titles/provenance/ids/key order differ; any change to
 * instruction, capabilities, topology, dataflow, worker contract, or
 * delivery behavior changes it.
 *
 * Works on both proposal task lists (task_key refs) and committed task
 * rows (same field names), so a candidate's pre-commit digest equals the
 * committed plan's digest by construction.
 */
export function canonicalPlanSemanticDigest(
  tasks: Array<Record<string, unknown>>,
): string {
  const orderByKey = new Map(
    tasks.map((t, i) => [String(t.task_key ?? `T${i + 1}`), i] as const),
  );
  const semantic = tasks.map((t, index) => {
    const md = (t.metadata ?? {}) as Record<string, unknown>;
    const df = extractTaskDataflow(t);
    const deps = Array.isArray(t.depends_on)
      ? [...new Set((t.depends_on as unknown[]).map(String))]
      : [];
    deps.sort(
      (a, b) =>
        (orderByKey.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (orderByKey.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
    );
    const body: Record<string, unknown> = {
      order: index,
      task_key: String(t.task_key ?? `T${index + 1}`),
      // Effective instruction — the executor-visible contract. Title and
      // description alone carry no execution semantics when an explicit
      // instruction exists.
      instruction: String(
        t.task_instruction ?? t.description ?? t.title ?? "",
      ),
      required_capabilities: sortedStrings(t.required_capabilities),
      depends_on: deps,
      produces: df.produces,
      consumes: df.consumes,
    };
    if (md.expected_output_contract !== undefined) {
      body.expected_output_contract = md.expected_output_contract;
    }
    if (md.pair_telegram_delivery !== undefined) {
      body.telegram_delivery = md.pair_telegram_delivery;
    }
    if (md.pair_output_language !== undefined) {
      body.output_language = md.pair_output_language;
    }
    // R1/R2 — the structured network requirement feeds NETWORK authority
    // (capability elevation), so it MUST be bound into plan identity:
    // mutable metadata can never act as un-bound authority. The sanitize
    // error marker flips INVALID verdicts — bound identically.
    if (md.network_requirement !== undefined) {
      body.network_requirement = md.network_requirement;
    }
    if (md.network_requirement_error !== undefined) {
      body.network_requirement_error = md.network_requirement_error;
    }
    // R1.2 — selected_executor is NOT plan semantics: the planner never
    // chooses executors (MissionRouter resolves the binding post-commit
    // and overwrites task.selected_executor as routing evidence), so the
    // field carries no execution-authoritative constraint. Including it
    // would let an identical plan pass as "different" by mutating an
    // ignored field — and would make the digest depend on post-commit
    // routing state for legacy rows. Excluded entirely.
    return body;
  });
  return digest({ contract: PLAN_SEMANTIC_CONTRACT, tasks: semantic });
}

/** Semantic digest of the mission's ACTIVE committed plan — computed
 *  from committed task rows (works for pre-F3 revisions that carry no
 *  persisted digest). Returns null when no plan is committed. */
export function activePlanSemanticDigest(args: {
  mission: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
}): string | null {
  const planId = String(args.mission.plan_id ?? "");
  if (!planId) return null;
  const planTasks = args.tasks.filter(
    (t) => String(t.plan_id) === planId,
  );
  if (!planTasks.length) return null;
  planTasks.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  return canonicalPlanSemanticDigest(planTasks);
}

/** The semantic authority of the mission's ACTIVE committed plan: prefer
 *  the plan_semantic_digest persisted ON the latest plan revision row —
 *  it was computed over the committed task rows at commit time, before
 *  any later mutation (dispatch pins selected_executor, status flips).
 *  Falls back to recomputing from committed rows for pre-F3 revisions
 *  that carry no persisted digest. */
export function persistedPlanSemanticDigest(args: {
  store: { planRevisions: (missionId: string) => Array<Record<string, unknown>> };
  mission: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
}): string | null {
  const missionId = String(args.mission.mission_id ?? "");
  if (!missionId) return null;
  const revisions = args.store
    .planRevisions(missionId)
    .slice()
    .sort((a, b) => Number(a.revision ?? 0) - Number(b.revision ?? 0));
  for (let i = revisions.length - 1; i >= 0; i--) {
    const d = revisions[i].plan_semantic_digest;
    if (typeof d === "string" && d) return d;
  }
  return args.tasks
    ? activePlanSemanticDigest({ mission: args.mission, tasks: args.tasks })
    : null;
}

/* ==================== 4. STRUCTURED FAILURE CONTEXT ================ */

export interface RecoveryFailureContext {
  contract: string;
  failure_class: string;
  dependency_reason: DependencyReason | null;
  mission_id: string;
  task_id: string;
  task_key: string | null;
  plan_id: string | null;
  plan_revision: number;
  plan_semantic_digest: string | null;
  artifact_name?: string;
  artifact_id?: string;
  producer_task_id?: string;
  producer_task_key?: string;
  consumer_task_id?: string;
  /** The bounded thrown seam code (FAIL_CLOSED_...) — never message text. */
  source_code: string | null;
}

/**
 * Builds the bounded structured root-cause object persisted on
 * pending_recovery + recovery_decision. Only safe fields — no paths,
 * secrets, stack traces, or free-form prose.
 */
export function buildRecoveryFailureContext(args: {
  mission: Record<string, unknown>;
  task_id: string;
  task?: Record<string, unknown> | null;
  tasks?: Array<Record<string, unknown>>;
  failure_class: string;
  dependency_reason?: DependencyReason | null;
  artifact_name?: string | null;
  artifact_id?: string | null;
  producer_task_id?: string | null;
  producer_task_key?: string | null;
  consumer_task_id?: string | null;
  source_code?: string | null;
  /** Pre-resolved committed-plan semantic authority (persisted revision
   *  digest). Recomputed from task rows only when absent. */
  plan_semantic_digest?: string | null;
}): RecoveryFailureContext {
  const ctx: RecoveryFailureContext = {
    contract: RECOVERY_FAILURE_CONTEXT_CONTRACT,
    failure_class: args.failure_class,
    dependency_reason: args.dependency_reason ?? null,
    mission_id: String(args.mission.mission_id),
    task_id: args.task_id,
    task_key: args.task?.task_key != null ? String(args.task.task_key) : null,
    plan_id:
      args.mission.plan_id != null ? String(args.mission.plan_id) : null,
    plan_revision: Number(args.mission.plan_revision ?? 0),
    plan_semantic_digest:
      args.plan_semantic_digest ??
      (args.tasks
        ? activePlanSemanticDigest({ mission: args.mission, tasks: args.tasks })
        : null),
    source_code: args.source_code ?? null,
  };
  if (args.artifact_name) ctx.artifact_name = String(args.artifact_name);
  if (args.artifact_id) ctx.artifact_id = String(args.artifact_id);
  if (args.producer_task_id) ctx.producer_task_id = String(args.producer_task_id);
  if (args.producer_task_key) ctx.producer_task_key = String(args.producer_task_key);
  if (ctx.producer_task_id && !ctx.consumer_task_id && args.consumer_task_id) {
    ctx.consumer_task_id = String(args.consumer_task_id);
  } else if (args.consumer_task_id) {
    ctx.consumer_task_id = String(args.consumer_task_id);
  }
  return ctx;
}

export function failureContextDigest(ctx: RecoveryFailureContext): string {
  const { contract, ...rest } = ctx;
  void contract;
  return digest({ contract: RECOVERY_FAILURE_CONTEXT_CONTRACT, ...rest });
}

/**
 * Recovery-signature extension for structured dependency failures (F3
 * §18): binds the signature to the deterministic ROOT CAUSE — reason,
 * failed task, failed plan semantic digest, artifact/producer identity —
 * so the same deterministic plan + same root failure yields the same
 * signature across restart. Non-structured failures keep the legacy
 * `<class>::<executor>::<capability>` signature.
 */
export function structuredFailureSignatureSuffix(
  ctx: RecoveryFailureContext | null | undefined,
): string {
  if (!ctx?.dependency_reason) return "";
  const rc = digest({
    r: ctx.dependency_reason,
    t: ctx.task_id,
    p: ctx.plan_semantic_digest ?? null,
    a: ctx.artifact_name ?? null,
    pr: ctx.producer_task_id ?? ctx.producer_task_key ?? null,
  }).slice(0, 16);
  return `::rc_${rc}`;
}

/* ==================== 5. REPLAN ATTEMPT LEDGER ======================= */

export const MAX_REPLAN_CANDIDATES_PER_DECISION = 2;

/** Governed async replan provider wait signal — deliberately NOT a
 *  FAIL_CLOSED_* code. Thrown by the durable replan_generation bridge
 *  (replan-generation.ts) while an async candidate is minted / in
 *  flight; MissionRuntime.runReplan treats it as "still waiting" —
 *  no candidate slot consumed, no failure classification, the runtime
 *  stays REPLANNING until staging resolves the row. */
export const REPLAN_GENERATION_PENDING = "REPLAN_GENERATION_PENDING";

export type ReplanAttemptStatus =
  | "CANDIDATE"
  | "PREPARED"
  | "REJECTED_DUPLICATE"
  | "REJECTED_FEASIBILITY"
  | "REJECTED_INVALID"
  | "ACCEPTED";

export interface ReplanAttemptRecord {
  entity_type: "replan_attempt";
  contract: string;
  replan_attempt_id: string;
  mission_id: string;
  recovery_id: string;
  failure_signature: string | null;
  failed_plan_semantic_digest: string | null;
  attempt_index: number;
  proposal_digest: string | null;
  candidate_plan_semantic_digest: string | null;
  /** R1.3 — PREPARED durability: the exact canonical validated task
   *  contract that passed every pre-commit gate. Bounded by the plan
   *  task-count limit; canonical task contracts are governance
   *  evidence, never model chain-of-thought or secrets. */
  prepared_tasks?: Array<Record<string, unknown>> | null;
  /** The raw proposal that produced prepared_tasks — persisted so the
   *  resumed commit records identical revision provenance without
   *  another planner call. */
  prepared_proposal?: unknown;
  /** plan_id active at prepare time — the plan this candidate
   *  supersedes; lets a resumed commit supersede exactly the right
   *  tasks even after a restart. */
  superseded_plan_id?: string | null;
  /** Durable commit receipt — set only when the candidate's plan
   *  revision provably exists. ACCEPTED never names a pre-commit
   *  candidate. */
  commit_receipt?: {
    plan_id: string;
    revision: number;
    plan_semantic_digest: string | null;
  } | null;
  status: ReplanAttemptStatus;
  rejection_reason: string | null;
  created_at: string;
  version: number;
}

export function replanAttemptId(
  recoveryId: string,
  attemptIndex: number,
): string {
  return `RPA_${digest(`pair-replan-attempt.v1|${recoveryId}|${attemptIndex}`).slice(0, 24)}`;
}

/** F3 R2 — exact attempt-bound commit identity persisted on a replan
 *  plan revision. A semantic digest proves plan MEANING, never which
 *  recovery/attempt committed a revision or whether it superseded the
 *  failed plan — so receipt lookup is exact binding, never a digest
 *  scan over history. */
export const REPLAN_COMMIT_CONTRACT = "pair-replan-commit.v1";

/** TRUE only when the revision's attempt-bound commit identity matches
 *  the attempt EXACTLY: same mission, recovery, attempt, superseded
 *  plan, and semantic digest. Anything short of exact binding is not
 *  evidence this attempt committed the revision. */
export function revisionBoundToAttempt(
  revision: Record<string, unknown>,
  attempt: ReplanAttemptRecord,
): boolean {
  const rc = revision.replan_commit as
    | {
        contract?: unknown;
        recovery_id?: unknown;
        replan_attempt_id?: unknown;
        superseded_plan_id?: unknown;
      }
    | null
    | undefined;
  return (
    rc != null &&
    rc.contract === REPLAN_COMMIT_CONTRACT &&
    String(rc.replan_attempt_id) === attempt.replan_attempt_id &&
    String(rc.recovery_id) === attempt.recovery_id &&
    String(rc.superseded_plan_id) === String(attempt.superseded_plan_id ?? "") &&
    String(revision.mission_id) === attempt.mission_id &&
    String(revision.plan_semantic_digest) ===
      String(attempt.candidate_plan_semantic_digest ?? "")
  );
}

/** F3 R3 §5 — exact commit-receipt validation: an ACCEPTED attempt's
 *  receipt must independently prove EVERY field — resume consumes the
 *  durable row and cannot lean on markCommitted having checked it at
 *  write time (a coherently store-rewritten receipt keeps a valid
 *  entity hash). The semantic digest is a THREE-WAY identity:
 *    attempt.candidate_plan_semantic_digest
 *      == receipt.plan_semantic_digest
 *      == revision.plan_semantic_digest
 *  plus the revision exists, is named by plan_id+revision, and binds
 *  THIS attempt exactly. No field is diagnostic-only. */
export function assertReplanCommitReceipt(
  revisions: Array<Record<string, unknown>>,
  attempt: ReplanAttemptRecord,
): Record<string, unknown> {
  const receipt = attempt.commit_receipt;
  const rev =
    receipt != null
      ? revisions.find(
          (r) =>
            String(r.plan_id) === String(receipt.plan_id) &&
            Number(r.revision) === Number(receipt.revision),
        )
      : undefined;
  if (
    !receipt ||
    !rev ||
    String(receipt.plan_semantic_digest) !==
      String(attempt.candidate_plan_semantic_digest ?? "") ||
    String(receipt.plan_semantic_digest) !==
      String(rev.plan_semantic_digest) ||
    !revisionBoundToAttempt(rev, attempt)
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_REPLAN_COMMIT_RECEIPT",
      `${attempt.replan_attempt_id}:${receipt?.plan_id ?? "none"}@${receipt?.revision ?? "none"}`,
    );
  }
  return rev;
}

/**
 * Durable bounded ledger of replan candidates for ONE recovery decision
 * (rejection evidence is governance evidence, not plan revisions).
 * Identity is deterministic (recovery_id, attempt_index): a restart
 * re-drives the same slot idempotently instead of minting unbounded
 * equivalent rows.
 */
export class ReplanAttemptLedger {
  constructor(private readonly store: PairEvidenceStore) {}

  listForRecovery(recoveryId: string): ReplanAttemptRecord[] {
    return (this.store.list("replan_attempt") as unknown as ReplanAttemptRecord[])
      .filter((r) => r.recovery_id === recoveryId)
      .sort((a, b) => a.attempt_index - b.attempt_index);
  }

  attemptsUsed(recoveryId: string): number {
    return this.listForRecovery(recoveryId).length;
  }

  /** Candidate semantic digests already rejected under this recovery —
   *  persisted, so a restart preserves the forbidden set. */
  rejectedCandidateDigests(recoveryId: string): string[] {
    return this.listForRecovery(recoveryId)
      .filter((r) => r.status.startsWith("REJECTED"))
      .map((r) => r.candidate_plan_semantic_digest)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
  }

  /** Persist one resolved attempt row + append-only event. Idempotent on
   *  the deterministic slot id — a crash-restarted slot with the same
   *  index converges instead of duplicating. R1.3 §18 — replay binds
   *  EVERY immutable authority fact: mission/recovery/signature/failed
   *  digest/index/proposal+candidate digests/status/rejection_reason/
   *  prepared content/superseded plan. Any conflicting replay fails
   *  closed; the deterministic slot never silently converges when
   *  immutable authority differs. */
  record(args: {
    mission_id: string;
    recovery_id: string;
    failure_signature?: string | null;
    failed_plan_semantic_digest?: string | null;
    attempt_index: number;
    proposal_digest?: string | null;
    candidate_plan_semantic_digest?: string | null;
    prepared_tasks?: Array<Record<string, unknown>> | null;
    prepared_proposal?: unknown;
    superseded_plan_id?: string | null;
    status: ReplanAttemptStatus;
    rejection_reason?: string | null;
  }): ReplanAttemptRecord {
    const id = replanAttemptId(args.recovery_id, args.attempt_index);
    const existing = this.store.tryGet("replan_attempt", id) as
      | ReplanAttemptRecord
      | null;
    if (existing) {
      const immutableMismatch =
        String(existing.mission_id) !== String(args.mission_id) ||
        String(existing.recovery_id) !== String(args.recovery_id) ||
        (existing.failure_signature ?? null) !==
          (args.failure_signature ?? null) ||
        (existing.failed_plan_semantic_digest ?? null) !==
          (args.failed_plan_semantic_digest ?? null) ||
        (existing.proposal_digest ?? null) !==
          (args.proposal_digest ?? null) ||
        (existing.candidate_plan_semantic_digest ?? null) !==
          (args.candidate_plan_semantic_digest ?? null) ||
        (existing.rejection_reason ?? null) !==
          (args.rejection_reason ?? null) ||
        (existing.superseded_plan_id ?? null) !==
          (args.superseded_plan_id ?? null) ||
        digest(existing.prepared_tasks ?? null) !==
          digest(args.prepared_tasks ?? null);
      if (
        !immutableMismatch &&
        existing.status === args.status
      ) {
        return existing;
      }
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT",
        `${id}:${existing.status}->${args.status}`,
      );
    }
    const row: ReplanAttemptRecord = {
      entity_type: "replan_attempt",
      contract: REPLAN_ATTEMPT_CONTRACT,
      replan_attempt_id: id,
      mission_id: args.mission_id,
      recovery_id: args.recovery_id,
      failure_signature: args.failure_signature ?? null,
      failed_plan_semantic_digest: args.failed_plan_semantic_digest ?? null,
      attempt_index: args.attempt_index,
      proposal_digest: args.proposal_digest ?? null,
      candidate_plan_semantic_digest:
        args.candidate_plan_semantic_digest ?? null,
      prepared_tasks: args.prepared_tasks ?? null,
      prepared_proposal: args.prepared_proposal ?? null,
      superseded_plan_id: args.superseded_plan_id ?? null,
      commit_receipt: null,
      status: args.status,
      rejection_reason: args.rejection_reason ?? null,
      created_at: utcnow(),
      version: 0,
    };
    this.store.put("replan_attempt", id, row as unknown as Record<string, unknown>, 0);
    this.store.event({
      entity_type: "replan_attempt",
      entity_id: id,
      event_type: "REPLAN_ATTEMPT_RESOLVED",
      new_state: args.status,
      actor: "PAIR_REPLAN_LEDGER",
      metadata: {
        mission_id: args.mission_id,
        recovery_id: args.recovery_id,
        attempt_index: args.attempt_index,
        candidate_plan_semantic_digest: row.candidate_plan_semantic_digest,
      },
    });
    return row;
  }

  /** Durably-prepared candidates still awaiting their commit — the
   *  crash-resume set. At most ONE can legitimately exist per recovery
   *  (a PREPARED row blocks new planner calls until committed). */
  pendingPrepared(recoveryId: string): ReplanAttemptRecord[] {
    return this.listForRecovery(recoveryId).filter(
      (r) => r.status === "PREPARED",
    );
  }

  /** PREPARED → ACCEPTED transition bound to the durable commit receipt
   *  (the candidate's plan revision provably exists). Only PREPARED may
   *  transition; anything else is a slot conflict. */
  markCommitted(
    replanAttemptIdValue: string,
    receipt: {
      plan_id: string;
      revision: number;
      plan_semantic_digest: string | null;
    },
  ): ReplanAttemptRecord {
    const existing = this.store.tryGet("replan_attempt", replanAttemptIdValue) as
      | ReplanAttemptRecord
      | null;
    if (!existing) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_MISSING",
        replanAttemptIdValue,
      );
    }
    if (existing.status === "ACCEPTED") {
      const r = existing.commit_receipt;
      if (
        r &&
        String(r.plan_id) === String(receipt.plan_id) &&
        Number(r.revision) === Number(receipt.revision) &&
        String(r.plan_semantic_digest) ===
          String(receipt.plan_semantic_digest) &&
        String(receipt.plan_semantic_digest) ===
          String(existing.candidate_plan_semantic_digest)
      ) {
        return existing; // idempotent finalize replay
      }
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT",
        `${replanAttemptIdValue}:conflicting_receipt`,
      );
    }
    if (existing.status !== "PREPARED") {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT",
        `${replanAttemptIdValue}:${existing.status}->ACCEPTED`,
      );
    }
    // F3 R2 §6 — the receipt's semantic digest MUST equal the prepared
    // candidate's: same plan_id/revision with a different digest is a
    // deterministic integrity violation, never a converge.
    if (
      String(receipt.plan_semantic_digest) !==
      String(existing.candidate_plan_semantic_digest)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT",
        `${replanAttemptIdValue}:receipt_digest_mismatch`,
      );
    }
    const updated: ReplanAttemptRecord = {
      ...existing,
      status: "ACCEPTED",
      commit_receipt: {
        plan_id: receipt.plan_id,
        revision: receipt.revision,
        plan_semantic_digest: receipt.plan_semantic_digest,
      },
    };
    this.store.put(
      "replan_attempt",
      replanAttemptIdValue,
      updated as unknown as Record<string, unknown>,
      Number(existing.version ?? 0),
    );
    this.store.event({
      entity_type: "replan_attempt",
      entity_id: replanAttemptIdValue,
      event_type: "REPLAN_ATTEMPT_RESOLVED",
      old_state: "PREPARED",
      new_state: "ACCEPTED",
      actor: "PAIR_REPLAN_LEDGER",
      metadata: {
        mission_id: existing.mission_id,
        recovery_id: existing.recovery_id,
        attempt_index: existing.attempt_index,
        candidate_plan_semantic_digest: existing.candidate_plan_semantic_digest,
        plan_id: receipt.plan_id,
        plan_revision: receipt.revision,
      },
    });
    return updated;
  }
}
