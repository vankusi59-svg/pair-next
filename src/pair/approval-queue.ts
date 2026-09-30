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

export interface ApprovalRequestInput {
  approval_type: ApprovalType;
  requested_action: string;
  /** The exact scope the approval binds to — digested canonically. */
  scope: Record<string, unknown>;
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
      mission_id: input.mission_id ?? null,
      task_id: input.task_id ?? null,
      change_id: input.change_id ?? null,
      scope: input.scope ?? {},
      scope_digest: digest(input.scope),
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

  /** Find an APPROVED approval whose stored scope_digest equals `scopeDigest`. */
  approvedFor(scopeDigest: string, approvalType?: ApprovalType) {
    this.expireSweep();
    return this.list({ status: "APPROVED" }).find(
      (a) =>
        a.scope_digest === scopeDigest &&
        (approvalType === undefined || a.approval_type === approvalType),
    );
  }

  /** Decide on a pending approval. `scope` must re-digest to the bound digest. */
  decide(
    approvalId: string,
    operatorId: string,
    decision: "APPROVED" | "DENIED",
    scope: Record<string, unknown>,
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
