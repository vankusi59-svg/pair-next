/**
 * objective-capability-gap.ts — P16-E: canonical CAPABILITY GAP advisory
 * projection for the objective auto-driver.
 *
 * The problem this closes: DRIVER_* denials are durable evidence (the
 * driver's `denials` ring inside objective_auto_driver_state), but they are
 * RAW labels — an owner scanning an objective cannot tell WHICH capability
 * is missing (authority? budget? billing proof? the ChatGPT session?) or
 * what owner-controlled channel resolves it. Worse, the ring is bounded:
 * the gap that quarantined an objective can roll off the tail.
 *
 * This service projects every durable denial into ONE canonical
 * `objective_capability_gap` row per objective: the closed DRIVER_*
 * vocabulary classified into a bounded gap_kind + owner_action advisory,
 * pinned by digest, anchored by events, resolvable when a later pass
 * proves the capability chain again.
 *
 * What a gap row is NOT:
 *   - it is not authority — it never unblocks a drive; the scheduler/
 *     policy/admission gates remain the enforcement surface;
 *   - it is not a write path on reads — `gapFor` never mutates;
 *   - it is not raw error text — the projection only ever carries the
 *     closed DRIVER_* label vocabulary, never a thrown message.
 *
 * Recording is observability-only: the driver wraps every record/resolve
 * in try{} exactly like `recordDenial` — a gap-projection fault can never
 * mask or fail the denial/settle it annotates.
 */

import { utcnow, digest } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import { IntegrityError } from "./errors.js";
import { DRIVER_FAULT_LABELS, type DriverFaultLabel } from "./objective-driver-fault.js";

export const CAP_GAP_ENTITY = "objective_capability_gap";
export const CAP_GAP_SCHEMA = "pair.os.vnext.objective-capability-gap.v1";

export const CAP_GAP_OPENED_EVENT = "OBJECTIVE_CAPABILITY_GAP_OPENED";
export const CAP_GAP_RESOLVED_EVENT = "OBJECTIVE_CAPABILITY_GAP_RESOLVED";

export type CapGapState = "OPEN" | "RESOLVED";

/** Bounded capability taxonomy — the actionable classification a DRIVER_*
 *  label maps to. Closed vocabulary: the advisory surface is rendered
 *  from gap_kind/owner_action, never raw text. */
export type CapGapKind =
  | "AUTHORITY"
  | "COST_CONTROL"
  | "CAPACITY"
  | "BILLING_PROOF"
  | "SUBSCRIPTION"
  | "ADMISSION"
  | "EXECUTION";

/** Closed owner-action vocabulary — each hints the owner-controlled
 *  channel that can clear the gap. It names a channel, never a command. */
export type CapGapOwnerAction =
  | "OWNER_RECHECK_OBJECTIVE_POLICY"
  | "OWNER_RESUME_COST_SPEND"
  | "OWNER_AMEND_POLICY_LIMITS"
  | "OWNER_REPROVE_DISPATCH_BILLING"
  | "OWNER_REMOVE_METERED_SUPPLY"
  | "OWNER_RESTORE_CODEX_SUBSCRIPTION"
  | "OWNER_REVIEW_SCHEDULER_DENIAL"
  | "OWNER_INSPECT_PASS_FAULT";

const CLASSIFY: Record<DriverFaultLabel, { kind: CapGapKind; action: CapGapOwnerAction }> = {
  DRIVER_AUTHORITY_LOST:           { kind: "AUTHORITY",      action: "OWNER_RECHECK_OBJECTIVE_POLICY" },
  DRIVER_COST_HALTED:              { kind: "COST_CONTROL",   action: "OWNER_RESUME_COST_SPEND" },
  DRIVER_CAP_EXHAUSTED:            { kind: "CAPACITY",       action: "OWNER_AMEND_POLICY_LIMITS" },
  DRIVER_COST_UNVERIFIED:          { kind: "BILLING_PROOF",  action: "OWNER_REPROVE_DISPATCH_BILLING" },
  DRIVER_METERED_FORBIDDEN:        { kind: "BILLING_PROOF",  action: "OWNER_REMOVE_METERED_SUPPLY" },
  DRIVER_SUBSCRIPTION_UNVERIFIED:  { kind: "SUBSCRIPTION",   action: "OWNER_RESTORE_CODEX_SUBSCRIPTION" },
  DRIVER_ADMISSION_DENIED:         { kind: "ADMISSION",      action: "OWNER_REVIEW_SCHEDULER_DENIAL" },
  DRIVER_PASS_FAULT:               { kind: "EXECUTION",      action: "OWNER_INSPECT_PASS_FAULT" },
};

const EVIDENCE_LIMIT = 8;

interface Row extends Record<string, unknown> { version: number }

/** Digest projection — pins every lifecycle-sensitive field. updated_at
 *  is deliberately excluded (wall-clock noise would make identical
 *  semantic states digest-divergent, same convention as the read-grant
 *  and reasoning-brief digests). */
function capGapDigest(r: Record<string, unknown>): string {
  return digest({
    schema: CAP_GAP_SCHEMA,
    objective_id: r.objective_id,
    state: r.state,
    label: r.label,
    gap_kind: r.gap_kind,
    permanence: r.permanence,
    owner_action: r.owner_action,
    evidence: r.evidence,
    occurrences: r.occurrences,
    opened_at: r.opened_at,
    resolved_at: r.resolved_at,
  });
}

function validRow(row: Record<string, unknown>): boolean {
  return row.entity_type === CAP_GAP_ENTITY
    && row.schema_version === CAP_GAP_SCHEMA
    && typeof row.objective_id === "string"
    && typeof row.label === "string"
    && (DRIVER_FAULT_LABELS as readonly string[]).includes(row.label)
    && typeof row.state === "string"
    && (row.state === "OPEN" || row.state === "RESOLVED")
    && Array.isArray(row.evidence)
    && Number.isSafeInteger(row.version) && (row.version as number) >= 1
    && row.digest === capGapDigest(row);
}

export interface CapGapEvidence {
  at: string;
  label: DriverFaultLabel;
  fence?: number;
}

export class ObjectiveCapabilityGapService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(this.now())) invalidClock();
  }

  private rowId(objectiveId: string): string {
    return `cap-gap:${objectiveId}`;
  }

  private readRow(objectiveId: string): Row | null {
    const r = this.store.tryGet(CAP_GAP_ENTITY, this.rowId(objectiveId));
    return (r as Row | null) ?? null;
  }

  /**
   * Persist the classified gap for a durable DRIVER_* denial. Idempotent
   * per (objective,label,fence) triple: the same denial replayed writes
   * the same version. A label CHANGE on an OPEN row reclassifies in place
   * (the newest durable fault is the gap that matters); a RESOLVED row
   * re-OPENs on any new denial (the capability broke again).
   * Only the closed DriverFaultLabel vocabulary is accepted — anything
   * else is a programming error and fails closed.
   */
  recordGap(input: {
    objective_id: string;
    label: DriverFaultLabel;
    transient: boolean;
    fence?: number;
  }): Record<string, unknown> {
    const { objective_id, label, transient } = input;
    const cls = CLASSIFY[label];
    if (!cls) {
      throw new IntegrityError("FAIL_CLOSED_CAPABILITY_GAP_LABEL",
        `label ${String(label)} is not in the DRIVER_* vocabulary`);
    }
    const fence = input.fence;
    const at = utcnow();
    return this.store.immediate(() => {
      const prev = this.readRow(objective_id);
      const prevVersion = Number(prev?.version ?? 0);
      // Idempotent replay: identical tail evidence (same label at the
      // same fence) rewrites the same version — never double-counts.
      const evTail = (prev?.evidence as CapGapEvidence[] | undefined)?.slice(-1)[0];
      if (prev && prev.state === "OPEN" && prev.label === label &&
          evTail && evTail.label === label && evTail.fence === fence &&
          Number.isSafeInteger(fence)) {
        return prev as unknown as Record<string, unknown>;
      }
      const clsChanged = !!prev && (prev.label !== label || prev.gap_kind !== cls.kind);
      const reopening = !!prev && prev.state === "RESOLVED";
      const evidence = [
        ...((prev?.evidence as CapGapEvidence[] | undefined) ?? []),
        { at, label, ...(Number.isSafeInteger(fence) ? { fence } : {}) },
      ].slice(-EVIDENCE_LIMIT);
      const row = {
        entity_type: CAP_GAP_ENTITY,
        schema_version: CAP_GAP_SCHEMA,
        objective_id,
        state: "OPEN",
        label,
        gap_kind: cls.kind,
        permanence: transient ? "transient" : "permanent",
        owner_action: cls.action,
        evidence,
        occurrences: Number(prev?.occurrences ?? 0) + 1,
        opened_at: (prev && !reopening && !clsChanged ? prev.opened_at : at) ?? at,
        resolved_at: null,
        updated_at: at,
        version: prevVersion,
      } as Record<string, unknown>;
      row.digest = capGapDigest(row);
      const stored = this.store.put(CAP_GAP_ENTITY, this.rowId(objective_id), row, prevVersion);
      if (!prev || clsChanged || reopening) {
        this.store.event({
          entity_type: CAP_GAP_ENTITY, entity_id: this.rowId(objective_id),
          event_type: CAP_GAP_OPENED_EVENT,
          actor: "objective-capability-gap",
          metadata: {
            schema_version: CAP_GAP_SCHEMA,
            revision: (stored as Row).version,
            pins_digest: digest(stored),
            label, gap_kind: cls.kind,
            permanence: row.permanence,
            owner_action: cls.action,
            reopened: reopening === true,
            reclassified: clsChanged === true,
            prior_digest: prev?.digest ?? null,
          },
        });
      }
      return stored as unknown as Record<string, unknown>;
    });
  }

  /**
   * Close the gap: a pass reached canonical settle, proving the driver
   * capability chain end-to-end. State-idempotent — resolving an absent
   * or already-RESOLVED row is a no-op returning the current projection.
   */
  resolveGap(objectiveId: string): Record<string, unknown> | null {
    const at = utcnow();
    return this.store.immediate(() => {
      const prev = this.readRow(objectiveId);
      if (!prev || prev.state === "RESOLVED") return (prev as Record<string, unknown> | null) ?? null;
      const row = {
        ...prev,
        state: "RESOLVED",
        resolved_at: at,
        updated_at: at,
        version: prev.version,
      } as Record<string, unknown>;
      row.digest = capGapDigest(row);
      const stored = this.store.put(CAP_GAP_ENTITY, this.rowId(objectiveId), row, prev.version);
      this.store.event({
        entity_type: CAP_GAP_ENTITY, entity_id: this.rowId(objectiveId),
        event_type: CAP_GAP_RESOLVED_EVENT,
        actor: "objective-capability-gap",
        metadata: {
          schema_version: CAP_GAP_SCHEMA,
          revision: (stored as Row).version,
          pins_digest: digest(stored),
          label: prev.label,
          prior_digest: prev.digest ?? null,
        },
      });
      return stored as unknown as Record<string, unknown>;
    });
  }

  /**
   * Read-only advisory projection. ZERO writes — the read path cannot
   * mint, mutate, expire or close anything. A tampered row never renders
   * as canonical: it surfaces the deterministic UNVERIFIED marker
   * instead of failing the status read it rides inside (same degrade
   * contract as the conversation read-grant skip rule).
   */
  gapFor(objectiveId: string): Record<string, unknown> | null {
    const row = this.readRow(objectiveId);
    if (!row) return null;
    if (!validRow(row)) {
      return {
        state: "UNVERIFIED",
        reason: "FAIL_CLOSED_CAPABILITY_GAP_TAMPERED",
        objective_id: objectiveId,
      };
    }
    return {
      state: row.state,
      objective_id: row.objective_id,
      label: row.label,
      gap_kind: row.gap_kind,
      permanence: row.permanence,
      owner_action: row.owner_action,
      occurrences: row.occurrences,
      opened_at: row.opened_at,
      resolved_at: row.resolved_at,
      updated_at: row.updated_at,
      evidence: (row.evidence as unknown[]).slice(-EVIDENCE_LIMIT),
    };
  }
}

function invalidClock(): never {
  throw new IntegrityError("FAIL_CLOSED_CAPABILITY_GAP_CLOCK", "trusted clock unavailable");
}
