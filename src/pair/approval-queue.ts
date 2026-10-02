/**
 * P9 ApprovalQueue — the canonical operator-approval ledger.
 *
 * Every request that needs a human decision (execution escalation, recovery
 * escalation, verified-remediation application, self-mod promotion, any
 * SECURITY_SENSITIVE/AUTHORITY_CHANGING scope) becomes an `approval_request`
 * entity bound to a deterministic `scope_digest`. An approval may only be
 * exercised against the exact scope it was granted for — a changed scope
 * (new digest) is never covered by an old approval.
 *
 * Statuses: PENDING → APPROVED | DENIED | EXPIRED | SUPERSEDED.
 * The queue never executes anything itself; it only adjudicates.
 */

import { IntegrityError, PolicyError } from "./errors.js";
import { digest, newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";

export const APPROVAL_TYPES = [
  "EXECUTION_APPROVAL",
  "RECOVERY_APPROVAL",
  "REMEDIATION_APPROVAL",
  "SELFMOD_PROMOTION_APPROVAL",
  "SECURITY_SENSITIVE_CHANGE",
  "AUTHORITY_CHANGING_CHANGE",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "SUPERSEDED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Phase D — explicit governed recovery-approval intents. A recovery
 * approval is never a generic "budget override": the intent declares the
 * ONE effect an APPROVED decision may produce, bound to the exact
 * mission/task/recovery chain it was granted for.
 */
export const RECOVERY_APPROVAL_INTENTS = [
  /** Task-attempt ceiling reached — grant ONE bounded attempt extension
   *  for that task only (never a mission-wide or unrelated-task grant). */
  "RECOVERY_TASK_ATTEMPT_EXTENSION",
  /** UNKNOWN_SIDE_EFFECT_STATE — operator accepts that the work cannot be
   *  safely replayed. NEVER authorizes a retry/re-route of the same work. */
  "ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY",
  /** Other operator-required recovery (auth/authz/permission/workspace/
   *  remote-input/cost/defect…) — approval = operator revalidated; effect
   *  is a fresh bounded recovery re-decision, not a budget extension. */
  "RECOVERY_OPERATOR_REVALIDATION",
] as const;
export type RecoveryApprovalIntent = (typeof RECOVERY_APPROVAL_INTENTS)[number];

/** Legacy action kept readable for pre-Phase-D rows: treated as a
 *  task-attempt extension when encountered. */
export const LEGACY_RECOVERY_BUDGET_OVERRIDE = "RECOVERY_BUDGET_OVERRIDE";

/** Entity type for durable approval consumption evidence (exactly-once). */
export const APPROVAL_EXERCISE_ENTITY = "approval_exercise";

export interface ApprovalRequestInput {
  approval_type: ApprovalType;
  requested_action: string;
  /** The exact scope the approval binds to — digested canonically. */
  scope: Record<string, unknown>;
  /** Explicit governed intent — stored verbatim so the exercise path can
   *  apply exactly the declared effect (mission/task/decision/signature/
   *  grant bindings). Never widens workspace/permissions/credentials. */
  intent?: Record<string, unknown>;
  mission_id?: string;
  task_id?: string;
  change_id?: string;
  reason: string;
  risk_class?: string;
  /** Seconds until the request expires; null = never expires. */
  ttl_seconds?: number | null;
  correlation_id?: string;
}

export class ApprovalQueue {
  constructor(private readonly service: PairControlPlane) {}

  private get store() {
    return this.service.store;
  }

  request(input: ApprovalRequestInput): Record<string, unknown> {
    if (!APPROVAL_TYPES.includes(input.approval_type)) {
      throw new IntegrityError(
        "FAIL_CLOSED_APPROVAL_TYPE_UNKNOWN",
        String(input.approval_type),
      );
    }
    this.expireSweep();
    // Request-once dedupe: an identical already-PENDING request (same
    // scope digest) is returned instead of minting a duplicate row —
    // covers crash-after-request-before-runtime-linkage replays.
    const scopeDigest = digest(input.scope);
    const existing = this.list({ status: "PENDING" }).find(
      (a) =>
        a.scope_digest === scopeDigest &&
        a.approval_type === input.approval_type &&
        a.requested_action === input.requested_action,
    );
    if (existing) return existing;
    const approvalId = newId("APR");
    const now = utcnow();
    const expiresAt =
      input.ttl_seconds == null
        ? null
        : new Date(Date.parse(now) + input.ttl_seconds * 1000).toISOString();
    const record = {
      approval_id: approvalId,
      approval_type: input.approval_type,
      requested_action: input.requested_action,
      intent: input.intent ?? null,
      mission_id: input.mission_id ?? null,
      task_id: input.task_id ?? null,
      change_id: input.change_id ?? null,
      scope_digest: scopeDigest,
      scope_snapshot: input.scope,
      reason: input.reason,
      risk_class: input.risk_class ?? "MEDIUM",
      created_at: now,
      expires_at: expiresAt,
      status: "PENDING" as ApprovalStatus,
      operator_id: null as string | null,
      decision_at: null as string | null,
      decision_reason: null as string | null,
      correlation_id: input.correlation_id ?? null,
      version: 0,
    };
    const saved = this.store.put("approval_request", approvalId, record, 0);
    this.store.event({
      entity_type: "approval_request",
      entity_id: approvalId,
      event_type: "APPROVAL_REQUESTED",
      new_state: "PENDING",
      actor: "PAIR_APPROVAL_QUEUE",
      correlation_id: input.correlation_id ?? null,
      metadata: {
        approval_type: input.approval_type,
        requested_action: input.requested_action,
        mission_id: input.mission_id ?? null,
        task_id: input.task_id ?? null,
      },
    });
    return saved;
  }

  get(approvalId: string): Record<string, unknown> {
    return this.store.get("approval_request", approvalId);
  }

  list(filter: { mission_id?: string; status?: ApprovalStatus } = {}) {
    return this.store
      .list("approval_request")
      .filter(
        (a) =>
          (filter.mission_id === undefined || a.mission_id === filter.mission_id) &&
          (filter.status === undefined || a.status === filter.status),
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  listPending(missionId?: string) {
    this.expireSweep();
    return this.list({ mission_id: missionId, status: "PENDING" });
  }

  /** Is there a PENDING approval gating this mission/task? */
  hasPendingBlock(missionId: string, taskId?: string): boolean {
    this.expireSweep();
    return this.list({ status: "PENDING" }).some(
      (a) =>
        a.mission_id === missionId &&
        (a.task_id == null || taskId == null || a.task_id === taskId),
    );
  }

  /**
   * Phase D §3 — find an equivalent already-PENDING request to RELINK to
   * (same semantic request: type + action + mission + task + optional
   * failure signature). Used when a restart re-derived the need for an
   * approval before the runtime link was durable — the existing request
   * is adopted, never duplicated.
   */
  findPendingEquivalent(input: {
    approval_type: ApprovalType;
    requested_action: string;
    mission_id: string;
    task_id?: string | null;
    failure_signature?: string | null;
  }): Record<string, unknown> | null {
    this.expireSweep();
    return (
      this.list({ status: "PENDING" }).find(
        (a) =>
          a.approval_type === input.approval_type &&
          a.requested_action === input.requested_action &&
          a.mission_id === input.mission_id &&
          (input.task_id == null || a.task_id === input.task_id) &&
          (input.failure_signature == null ||
            (a.intent as Record<string, unknown> | null)?.failure_signature ===
              input.failure_signature ||
            (a.scope_snapshot as Record<string, unknown> | null)?.failure_signature ===
              input.failure_signature),
      ) ?? null
    );
  }

  /**
   * Phase D §2 — durable exactly-once exercise evidence with an explicit
   * lifecycle: APPLYING (winner persisted, effect maybe incomplete) →
   * APPLIED (effect fully durable). The exercise id is deterministic from
   * the approval id, so racing writers mint the same id — the version-0
   * insert makes exactly one winner; the loser's create races into a
   * FAIL_CLOSED_VERSION_CONFLICT which is re-read as the canonical
   * winner, never surfaced as a defect.
   *
   * Returns { row, created } — `created:true` only for the writer that
   * persisted the row. A caller that sees `created:false` MUST inspect
   * `row.state`: APPLYING means the effect may not be durable yet and
   * must be (re)applied idempotently; APPLIED means the effect already
   * landed. `effect` is the deterministic effect plan the caller
   * persists once — a resumer reuses the winner's plan verbatim instead
   * of recomputing drift-prone values.
   */
  exercise(
    approvalId: string,
    effect?: Record<string, unknown>,
  ): { row: Record<string, unknown>; created: boolean } {
    const approval = this.get(approvalId);
    if (String(approval.status) !== "APPROVED") {
      throw new PolicyError(
        "FAIL_CLOSED_APPROVAL_NOT_EXERCISABLE",
        `${approvalId}:${String(approval.status)}`,
      );
    }
    const exerciseId = `APRE_${String(approvalId).replace(/^APR_/, "")}`;
    const existing = this.store.tryGet(APPROVAL_EXERCISE_ENTITY, exerciseId);
    if (existing) return { row: existing, created: false };
    const row = {
      approval_exercise_id: exerciseId,
      approval_id: approvalId,
      approval_type: approval.approval_type,
      requested_action: approval.requested_action,
      intent: approval.intent ?? null,
      mission_id: approval.mission_id ?? null,
      task_id: approval.task_id ?? null,
      scope_digest: approval.scope_digest,
      operator_id: approval.operator_id ?? null,
      effect: effect ?? null,
      state: "APPLYING",
      // R2 — durable effect ownership: an APPLYING row carries an
      // explicit owner + bounded lease so exactly ONE writer applies the
      // effect and a crashed owner's row is discoverable + takable.
      owner_id: null as string | null,
      claim_epoch: 0,
      claimed_at: null as string | null,
      lease_expires_at: null as string | null,
      exercised_at: utcnow(),
      applied_at: null as string | null,
      version: 0,
    };
    let saved: Record<string, unknown>;
    try {
      saved = this.store.put(APPROVAL_EXERCISE_ENTITY, exerciseId, row, 0);
    } catch (error) {
      // A concurrent writer won the deterministic id — adopt its row.
      const winner = this.store.tryGet(APPROVAL_EXERCISE_ENTITY, exerciseId);
      if (winner) return { row: winner, created: false };
      throw error;
    }
    this.store.event({
      entity_type: APPROVAL_EXERCISE_ENTITY,
      entity_id: exerciseId,
      event_type: "APPROVAL_EXERCISED",
      new_state: "EXERCISED",
      actor: "PAIR_APPROVAL_QUEUE",
      correlation_id: String(approval.correlation_id ?? ""),
      metadata: {
        approval_id: approvalId,
        requested_action: approval.requested_action,
        mission_id: approval.mission_id ?? null,
        task_id: approval.task_id ?? null,
      },
    });
    return { row: saved, created: true };
  }

  /**
   * R2 — CAS-safe single-owner claim on an APPLYING exercise. Exactly
   * one writer may actively apply the effect at a time; the claim is a
   * durable lease, not an in-memory mutex.
   *
   * Rules (first row read wins the interpretation, CAS decides ties):
   * - state APPLIED        → nobody owns; caller converges (applied:true)
   * - owner == ownerId     → same owner renewing (owned:true, lease bumped)
   * - owner set + active   → a live writer owns it (owned:false — the
   *   loser re-reads the canonical row and converges, never surfaces a
   *   version conflict as a defect)
   * - owner null/expired   → takeover: CAS put with the row's version;
   *   a lost race re-reads and re-evaluates instead of throwing
   *
   * `claim_epoch` increments per successful (re)claim — durable evidence
   * of ownership handoffs. A crashed owner's APPLYING row is claimed by
   * the next writer whose tick discovers it once `lease_expires_at` has
   * passed — bounded takeover, no permanent APPLYING.
   */
  claimExercise(
    approvalId: string,
    ownerId: string,
    now?: string,
    leaseMs = 60_000,
  ): {
    row: Record<string, unknown>;
    owned: boolean;
    applied: boolean;
    claim: { owner_id: string; claim_epoch: number } | null;
  } {
    const exerciseId = `APRE_${String(approvalId).replace(/^APR_/, "")}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.store.tryGet(APPROVAL_EXERCISE_ENTITY, exerciseId);
      if (!row) {
        throw new IntegrityError(
          "FAIL_CLOSED_APPROVAL_EXERCISE_MISSING",
          approvalId,
        );
      }
      if (String(row.state ?? "APPLIED") === "APPLIED") {
        return { row, owned: false, applied: true, claim: null };
      }
      const at = now ?? utcnow();
      const lease = String(row.lease_expires_at ?? "");
      const active = lease !== "" && lease > at;
      const owner = String(row.owner_id ?? "");
      if (owner === ownerId && active) {
        // Same owner renewing its lease — CAS only to extend the window.
        // Only reachable while this claimant still owns the CURRENT
        // epoch: once another owner advanced claim_epoch, owner_id
        // differs and this path is permanently closed (R3 fencing).
        const renewed = {
          ...row,
          claimed_at: at,
          lease_expires_at: new Date(Date.parse(at) + leaseMs).toISOString(),
        };
        try {
          const saved = this.store.put(
            APPROVAL_EXERCISE_ENTITY,
            exerciseId,
            renewed,
            Number(row.version),
          );
          return {
            row: saved,
            owned: true,
            applied: false,
            claim: {
              owner_id: ownerId,
              claim_epoch: Number(row.claim_epoch ?? 0),
            },
          };
        } catch (error) {
          if (error instanceof IntegrityError) continue;
          throw error;
        }
      }
      if (active && owner !== "") {
        return { row, owned: false, applied: false, claim: null }; // live other owner
      }
      // Unowned or stale owner — CAS takeover.
      const next = {
        ...row,
        owner_id: ownerId,
        claim_epoch: Number(row.claim_epoch ?? 0) + 1,
        claimed_at: at,
        lease_expires_at: new Date(Date.parse(at) + leaseMs).toISOString(),
      };
      try {
        const saved = this.store.put(
          APPROVAL_EXERCISE_ENTITY,
          exerciseId,
          next,
          Number(row.version),
        );
        return {
          row: saved,
          owned: true,
          applied: false,
          claim: {
            owner_id: ownerId,
            claim_epoch: Number(saved.claim_epoch ?? 0),
          },
        };
      } catch (error) {
        if (error instanceof IntegrityError) continue; // raced — re-read
        throw error;
      }
    }
    // Contention resolved elsewhere — converge on the canonical row.
    const row = this.store.get(APPROVAL_EXERCISE_ENTITY, exerciseId);
    return { row, owned: false, applied: false, claim: null };
  }

  /** R5 — atomic fenced stage: the claim re-verification AND the
   *  mutation run inside ONE `BEGIN IMMEDIATE` transaction on the
   *  canonical store. A competing `claimExercise` on a separate
   *  connection cannot advance `claim_epoch` between the check and the
   *  write — takeover may only land between committed stages, and the
   *  stale owner's NEXT stage is then fenced atomically. A fenced stage
   *  performs ZERO mutation and converges — never a runtime defect.
   *  Keep each stage bounded: fence + one logical mutation per call,
   *  preserving crash-resumability (never one giant transaction). */
  runFencedExerciseStage<T>(
    approvalId: string,
    claim: { owner_id: string; claim_epoch: number } | null | undefined,
    mutation: (row: Record<string, unknown>) => T,
  ): { fenced: boolean; row: Record<string, unknown> | null; result?: T } {
    const exerciseId = `APRE_${String(approvalId).replace(/^APR_/, "")}`;
    return this.store.immediate(() => {
      const row = this.store.tryGet(APPROVAL_EXERCISE_ENTITY, exerciseId);
      const current =
        row != null &&
        claim != null &&
        String(row.state) === "APPLYING" &&
        String(row.owner_id ?? "") === claim.owner_id &&
        Number(row.claim_epoch ?? 0) === claim.claim_epoch;
      if (!current) {
        return { fenced: true, row: row ?? null, result: undefined };
      }
      const result = mutation(row);
      return {
        fenced: false,
        row: this.store.get(APPROVAL_EXERCISE_ENTITY, exerciseId),
        result,
      };
    });
  }

  /** R3 fencing check — prove the caller's claim token still owns the
   *  canonical APRE right now: owner_id match AND claim_epoch match AND
   *  state APPLYING. Returns the canonical row when current, `null`
   *  when the holder is stale (taken over, superseded, or finalized).
   *  Effect stages call this before every critical mutation; a null
   *  result is bounded convergence, never a defect. */
  verifyExerciseClaim(
    approvalId: string,
    claim: { owner_id: string; claim_epoch: number } | null | undefined,
  ): Record<string, unknown> | null {
    if (!claim) return null;
    const exerciseId = `APRE_${String(approvalId).replace(/^APR_/, "")}`;
    const row = this.store.tryGet(APPROVAL_EXERCISE_ENTITY, exerciseId);
    if (!row) return null;
    if (String(row.state) !== "APPLYING") return null;
    if (String(row.owner_id ?? "") !== claim.owner_id) return null;
    if (Number(row.claim_epoch ?? 0) !== claim.claim_epoch) return null;
    return row;
  }

  /** Lifecycle close: the caller's effect writes are durable. Fenced by
   *  the claim token (R3): `APPLIED` is written only while the canonical
   *  row still belongs to this exact (owner_id, claim_epoch) — a token
   *  taken over by another owner can NEVER land the close, so APPLIED
   *  proves the fenced owner finished. Idempotent for a re-entering
   *  legitimate owner; CAS-loss safe. Returns {row, applied, fenced}:
   *  `applied` when APPLIED is durable (by this call or already),
   *  `fenced` when the caller's token is stale — bounded convergence,
   *  never a defect. */
  markExercisedApplied(
    approvalId: string,
    ownerId: string,
    claimEpoch: number,
  ): { row: Record<string, unknown>; applied: boolean; fenced: boolean } {
    const exerciseId = `APRE_${String(approvalId).replace(/^APR_/, "")}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.store.get(APPROVAL_EXERCISE_ENTITY, exerciseId);
      if (String(row.state) === "APPLIED") {
        return { row, applied: true, fenced: false };
      }
      if (
        String(row.owner_id ?? "") !== ownerId ||
        Number(row.claim_epoch ?? 0) !== Number(claimEpoch)
      ) {
        // Stale token — a different epoch owns the canonical row.
        return { row, applied: false, fenced: true };
      }
      row.state = "APPLIED";
      row.applied_at = utcnow();
      try {
        const saved = this.store.put(
          APPROVAL_EXERCISE_ENTITY,
          exerciseId,
          row,
          Number(row.version),
        );
        return { row: saved, applied: true, fenced: false };
      } catch (error) {
        if (error instanceof IntegrityError) continue;
        throw error;
      }
    }
    return {
      row: this.store.get(APPROVAL_EXERCISE_ENTITY, exerciseId),
      applied: false,
      fenced: false,
    };
  }

  /** Exercised approval evidence for a mission/task — the §7 bound that
   *  stops identical human escalations from minting unlimited approvals. */
  listExercised(filter: { mission_id?: string; task_id?: string } = {}) {
    return this.store
      .list(APPROVAL_EXERCISE_ENTITY)
      .filter(
        (x) =>
          (filter.mission_id === undefined || x.mission_id === filter.mission_id) &&
          (filter.task_id === undefined || x.task_id === filter.task_id),
      );
  }

  /** Find an APPROVED approval whose stored scope_digest equals `scopeDigest`. */
  approvedFor(scopeDigest: string, approvalType?: ApprovalType) {
    this.expireSweep();
    return this.list({ status: "APPROVED" }).find(
      (a) =>
        a.scope_digest === scopeDigest &&
        (approvalType === undefined || a.approval_type === approvalType),
    );
  }

  /** Decide on a pending approval. `scope` is REQUIRED and must re-digest
   *  to the bound scope_digest — the stored scope_snapshot is persisted
   *  evidence + API projection only; it is never substituted into the
   *  authority check. Operator clients fetch and echo the canonical scope
   *  the API exposes. */
  decide(
    approvalId: string,
    operatorId: string,
    decision: "APPROVED" | "DENIED",
    scope: Record<string, unknown> | undefined,
    reason?: string,
    now?: string,
  ): Record<string, unknown> {
    if (!operatorId) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", approvalId);
    }
    const record = this.get(approvalId);
    this.expireRecord(record, now);
    if (record.status !== "PENDING") {
      throw new PolicyError(
        "FAIL_CLOSED_APPROVAL_NOT_PENDING",
        `${approvalId}:${String(record.status)}`,
      );
    }
    // R1 — scope authority: the caller MUST present the scope itself.
    // The stored scope_snapshot is evidence + API projection only; it is
    // never substituted here — a caller that cannot produce the canonical
    // scope fails closed.
    if (scope == null) {
      throw new IntegrityError(
        "FAIL_CLOSED_APPROVAL_SCOPE_REQUIRED",
        approvalId,
      );
    }
    const presented = digest(scope);
    if (presented !== record.scope_digest) {
      throw new IntegrityError(
        "FAIL_CLOSED_APPROVAL_SCOPE_MISMATCH",
        `${approvalId}:${presented}!=${String(record.scope_digest)}`,
      );
    }
    record.status = decision;
    record.operator_id = operatorId;
    record.decision_at = now ?? utcnow();
    record.decision_reason = reason ?? null;
    const saved = this.store.put(
      "approval_request",
      approvalId,
      record,
      Number(record.version),
    );
    this.store.event({
      entity_type: "approval_request",
      entity_id: approvalId,
      event_type: decision === "APPROVED" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
      new_state: decision,
      actor: `OPERATOR:${operatorId}`,
      correlation_id: String(record.correlation_id ?? ""),
      metadata: {
        approval_type: record.approval_type,
        requested_action: record.requested_action,
        mission_id: record.mission_id,
        task_id: record.task_id,
      },
    });
    return saved;
  }

  /** Supersede pending approvals (e.g. a new plan revision invalidates them). */
  supersede(missionId: string, taskId: string | undefined, reason: string): number {
    let count = 0;
    for (const record of this.list({ mission_id: missionId, status: "PENDING" })) {
      if (taskId !== undefined && record.task_id !== taskId) continue;
      record.status = "SUPERSEDED" as ApprovalStatus;
      record.decision_reason = reason;
      record.decision_at = utcnow();
      this.store.put(
        "approval_request",
        String(record.approval_id),
        record,
        Number(record.version),
      );
      this.store.event({
        entity_type: "approval_request",
        entity_id: String(record.approval_id),
        event_type: "APPROVAL_SUPERSEDED",
        new_state: "SUPERSEDED",
        actor: "PAIR_APPROVAL_QUEUE",
        metadata: { reason },
      });
      count++;
    }
    return count;
  }

  /** Mark expired PENDING approvals EXPIRED. Returns the expired ids. */
  expireSweep(now?: string): string[] {
    const t = now ?? utcnow();
    const expired: string[] = [];
    for (const record of this.list({ status: "PENDING" })) {
      if (record.expires_at == null) continue;
      if (String(record.expires_at) <= t) {
        this.expireRecord(record, t);
        expired.push(String(record.approval_id));
      }
    }
    return expired;
  }

  private expireRecord(record: Record<string, unknown>, now?: string): void {
    if (record.status !== "PENDING" || record.expires_at == null) return;
    const t = now ?? utcnow();
    if (String(record.expires_at) <= t) {
      record.status = "EXPIRED";
      this.store.put(
        "approval_request",
        String(record.approval_id),
        record,
        Number(record.version),
      );
      this.store.event({
        entity_type: "approval_request",
        entity_id: String(record.approval_id),
        event_type: "APPROVAL_EXPIRED",
        new_state: "EXPIRED",
        actor: "PAIR_APPROVAL_QUEUE",
      });
    }
  }
}
