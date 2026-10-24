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
 *
 * Resolve semantics: `resolveGap` fires on ANY canonically-settled pass —
 * `admit()` re-proves the entire capability chain (policy effective, cost
 * halt, caps, provable non-metered billing, subscription session) before
 * `runPass`, and `settle` re-proves the lease, so a settle IS the chain
 * re-proven end-to-end regardless of what the CEO decided. The weakest
 * case — an EXECUTION gap closed by a pass settling WAITING — self-
 * corrects on the next durable denial.
 */

import { digest } from "./canonical.js";
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

/** Digest projection — pins every lifecycle-sensitive field INCLUDING the
 *  storage identity: entity_id/objective_id are pinned so a row copied
 *  under another objective's key cannot pass re-proof. updated_at is
 *  deliberately excluded (wall-clock noise would make identical
 *  semantic states digest-divergent, same convention as the read-grant
 *  and reasoning-brief digests). */
function capGapDigest(r: Record<string, unknown>): string {
  return digest({
    schema: CAP_GAP_SCHEMA,
    entity_id: r.entity_id,
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

function validRow(row: Record<string, unknown>, objectiveId: string): boolean {
  return row.entity_type === CAP_GAP_ENTITY
    && row.entity_id === `cap-gap:${objectiveId}`
    && row.schema_version === CAP_GAP_SCHEMA
    && row.objective_id === objectiveId
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

  /** R1 — event-chain re-proof, mirroring conversation-read-grant
   *  validRows(): the digest is pinned, but a store-level rewrite could
   *  recompute BOTH hashes over a state flip. The append-only event
   *  chain still exposes it: every OPENED/RESOLVED transition emits a
   *  lifecycle event, so the LAST lifecycle event must agree with
   *  row.state. (Same-label recurrence bumps carry no event by design —
   *  versions between lifecycle transitions are unjournaled to bound
   *  event volume; the check therefore keys on lifecycle events only.) */
  private eventConsistent(objectiveId: string, row: Record<string, unknown>): boolean {
    const evs = this.store.listEvents(
      CAP_GAP_ENTITY, this.rowId(objectiveId)) as Array<Record<string, unknown>>;
    const last = [...evs].reverse().find((e) =>
      e.event_type === CAP_GAP_OPENED_EVENT || e.event_type === CAP_GAP_RESOLVED_EVENT);
    if (!last) return false; // every canonical row is born with an OPENED anchor
    return row.state === "OPEN"
      ? last.event_type === CAP_GAP_OPENED_EVENT
      : last.event_type === CAP_GAP_RESOLVED_EVENT;
  }

  /** The WRITE-side re-proof: a row only extends the projection when it
   *  is digest-valid, identity-bound AND event-consistent. Anything
   *  else is treated as absent — the fresh mint overwrites it at the
   *  same version (the forged row is discarded, never laundered into
   *  canonical) while the OPENED event keeps prior_digest for
   *  forensics. */
  private provenRow(objectiveId: string): Row | null {
    const prev = this.readRow(objectiveId);
    if (!prev) return null;
    return validRow(prev, objectiveId) && this.eventConsistent(objectiveId, prev)
      ? prev : null;
  }

  private stamp(): string {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0) invalidClock();
    return new Date(n).toISOString();
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
    const at = this.stamp();
    return this.store.immediate(() => {
      // prev = storage truth (OCC version + forensic digest); proven =
      // canonical truth (digest-valid + identity-bound + event-consistent).
      // A forged prev NEVER extends the projection — it is overwritten
      // by a fresh mint, and the OPENED event keeps its digest on record.
      const prev = this.readRow(objective_id);
      const proven = this.provenRow(objective_id);
      const prevVersion = Number(prev?.version ?? 0);
      // Idempotent replay: identical tail evidence (same label at the
      // same fence) rewrites the same version — never double-counts.
      // Fence is the driver's per-lease identity: fence-less records or
      // replays past a RESOLVE are counted as new occurrences by design
      // (a later lease is a new observation of the capability state).
      const evTail = (proven?.evidence as CapGapEvidence[] | undefined)?.slice(-1)[0];
      if (proven && proven.state === "OPEN" && proven.label === label &&
          evTail && evTail.label === label && evTail.fence === fence &&
          Number.isSafeInteger(fence)) {
        return proven as unknown as Record<string, unknown>;
      }
      const clsChanged = !!proven && (proven.label !== label || proven.gap_kind !== cls.kind);
      const reopening = !!proven && proven.state === "RESOLVED";
      const evidence = [
        ...((proven?.evidence as CapGapEvidence[] | undefined) ?? []),
        { at, label, ...(Number.isSafeInteger(fence) ? { fence } : {}) },
      ].slice(-EVIDENCE_LIMIT);
      const row = {
        entity_type: CAP_GAP_ENTITY,
        entity_id: this.rowId(objective_id),
        schema_version: CAP_GAP_SCHEMA,
        objective_id,
        state: "OPEN",
        label,
        gap_kind: cls.kind,
        permanence: transient ? "transient" : "permanent",
        owner_action: cls.action,
        evidence,
        occurrences: Number(proven?.occurrences ?? 0) + 1,
        opened_at: (proven && !reopening && !clsChanged ? proven.opened_at : at) ?? at,
        resolved_at: null,
        updated_at: at,
        version: prevVersion,
      } as Record<string, unknown>;
      row.digest = capGapDigest(row);
      const stored = this.store.put(CAP_GAP_ENTITY, this.rowId(objective_id), row, prevVersion);
      if (!proven || clsChanged || reopening) {
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
    const at = this.stamp();
    return this.store.immediate(() => {
      // Only a canonically-proven row may resolve — a forged row is left
      // untouched (never laundered into RESOLVED history); gapFor hides
      // it behind the UNVERIFIED marker regardless.
      const prev = this.provenRow(objectiveId);
      if (!prev || prev.state === "RESOLVED") {
        return (prev ?? this.readRow(objectiveId)) as Record<string, unknown> | null;
      }
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
    // The advisory never throws into the status read it rides inside:
    // ANY unverifiable state — semantic tamper, digest-recomputed state
    // flip, cross-objective substitution, raw payload corruption — the
    // deterministic UNVERIFIED marker. Never fabricated data.
    try {
      const row = this.readRow(objectiveId);
      if (!row) return null;
      if (!validRow(row, objectiveId) || !this.eventConsistent(objectiveId, row)) {
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
    } catch {
      return {
        state: "UNVERIFIED",
        reason: "FAIL_CLOSED_CAPABILITY_GAP_TAMPERED",
        objective_id: objectiveId,
      };
    }
  }
}

function invalidClock(): never {
  throw new IntegrityError("FAIL_CLOSED_CAPABILITY_GAP_CLOCK", "trusted clock unavailable");
}
