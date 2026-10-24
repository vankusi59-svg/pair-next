import { randomBytes } from "node:crypto";
import { digest } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { DriverDenial, DRIVER_FAULT_LABELS } from "./objective-driver-fault.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import { ObjectiveRelationService } from "./objective-relation.js";
import { AUTO_POLICY_ENTITY } from "./objective-auto-policy.js";
import { KPI_AUTH_ENTITY, KPI_VERIFIER_SCHEMA, kpiAuthEffectiveReason } from "./objective-kpi-verifier-authority.js";
import type { ObjectiveAutoPolicyService, AutoPolicyStatus } from "./objective-auto-policy.js";
import type { OperatingOutcome } from "./objective-operating-loop.js";
import { isSqliteContentionError } from "./store.js";
import type { PairEvidenceStore } from "./store.js";
import {
  WORKFORCE_ALLOCATION_ENTITY,
  assertCanonicalWorkforceAllocationProvenance,
} from "./workforce-allocation-evidence.js";
import { validateWorkOpenBindingById } from "./work-open-binding.js";

export const OBJECTIVE_SCHEDULER_MODE = "RECONCILE_ONLY" as const;
export const SCHEDULER_COMMIT = "OBJECTIVE_AUTO_SCHEDULER_COMMIT";
export const SCHEDULER_SCHEMA = "pair.os.vnext.objective-auto-scheduler.v1";
export const WAKE_STATE = "objective_auto_state";
export const WAKE_SEGMENT = "objective_auto_wake_segment";
export const LEASE_STATE = "objective_auto_lease";
export const SCHEDULER_RECEIPT = "objective_auto_receipt";
export const SCHEDULER_CURSOR = "objective_auto_cursor";
export const SCHEDULER_PROGRESS = "objective_auto_reconcile";
export const FAIRNESS_STATE = "objective_auto_fairness";
const GLOBAL = "LOCAL_PAIR_DB";
const MAX_ACTIVE = 4;
const PAGE = 64;
/** R2-F1 — per-call bound on shortlist pages in nextFairCandidate. The
 *  SQL filter already excludes non-actionable and actively-leased rows,
 *  so a second page is only needed if a full PAGE of shortlisted rows
 *  fails the queue()/lease() re-proof — pathology, not throughput. The
 *  bound keeps per-call charged reads inside the proof budget
 *  (entities 1024 / events 512) while converged idle cohorts cost one
 *  uncharged query per call. */
const SCAN_PAGES = 3;
/** R3-F1 — per-call bound on charged integrity work: tier-1 suspect
 *  confirmations + tier-2 rotating deep-verify rows, so the sweep cannot
 *  exceed the proof budget even under a corruption burst. */
const INTEGRITY_QUOTA = 16;
/** R4-F2 — cap on durably excluded faulted candidates. A burst beyond this
 *  means catastrophic protected-state tampering; the scheduler halts
 *  fail-closed rather than run an unbounded exclusion list. */
const FAULTED_CAP = 1024;
/** R5-F1 — charged-read headroom: a fault() confirmation costs at most ~10
 *  charged reads (receipt dedup probe + receipt commit + fairness
 *  exclusion), so stop processing candidates while ~10x that remains.
 *  Stopping early lets the transaction COMMIT the exclusions already made —
 *  durable forward progress — instead of rolling back on budget trip. */
const FAULT_HEADROOM = 96;
/** R5-F1 — the idle-path sweep costs ~200 charged reads worst case
 *  (16-row deep slice + up to 16 suspect confirmations); it is coverage
 *  work, not correctness — defer it rather than risk the budget. */
const SWEEP_HEADROOM = 288;
/** R5-F1 — temporary charged-read exhaustion is work pressure, never
 *  evidence of row corruption. */
const PROOF_LIMIT = "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT";

type Row = Record<string, unknown> & { version: number };

/** Versioned input-topic whitelist. Scheduler-owned commit/checkpoint events
 * are deliberately absent so intake cannot chase its own tail forever. The
 * write seam re-enforces this list inside accountWake: a wake may only ever
 * be sourced from one of these canonical topics. */
export const OBJECTIVE_WAKE_INPUT_TOPICS = [
  "OBJECTIVE_CREATED", "OBJECTIVE_STATUS", "OBJECTIVE_AMENDED",
  "OBJECTIVE_PROGRESS", "OBJECTIVE_EVIDENCE_ATTACHED", "OBJECTIVE_BUDGET_ACCOUNTED",
  "OBJECTIVE_AUTO_POLICY_CONFIGURE", "OBJECTIVE_AUTO_POLICY_ENABLE",
  "OBJECTIVE_AUTO_POLICY_PAUSE", "OBJECTIVE_AUTO_POLICY_RESUME",
  "OBJECTIVE_AUTO_POLICY_DISABLE", "OBJECTIVE_AUTO_POLICY_REVOKE",
  "OBJECTIVE_AUTO_POLICY_HALT", "OBJECTIVE_AUTO_POLICY_RESET_HALT",
  "OBJECTIVE_AUTO_POLICY_EXPIRE",
  "MISSION_TRANSITION", "WORK_ITEM_STATUS_SYNCED", "WORK_ITEM_OPEN_RECONCILED",
  "WORK_ITEM_CANCELLED", "WORK_ITEM_UNBLOCKED", "WORK_REVIEW_ACCEPTED",
  "WORK_REWORK_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_DENIED",
  "APPROVAL_SUPERSEDED", "APPROVAL_EXPIRED", "APPROVAL_EXERCISED",
  "OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED", "OBJECTIVE_STRATEGY_REVISION_COMMITTED",
  "ORG_AGENT_STATUS", "AGENT_EXECUTION_CONTRACT_ENABLED",
  "AGENT_EXECUTION_CONTRACT_DISABLED", "AGENT_EXECUTION_CONTRACT_UPDATED",
  "WORK_CLAIM_RELEASED",
] as const;

/** Canonical provenance a caller must supply for a source-event wake. The
 * scheduler does not trust the claim: every hop is re-verified against the
 * canonical store inside the write transaction. */
export type WakeBinding =
  | { kind: "objective" }
  | { kind: "auto_policy" }
  | { kind: "objective_ref" }
  | { kind: "work_item"; allocation_id: string; work_item_id: string }
  | { kind: "agent"; allocation_id: string; agent_id: string }
  | { kind: "mission"; allocation_id: string; mission_id: string;
      open_id: string; work_item_id: string }
  | { kind: "approval"; allocation_id: string; mission_id: string;
      open_id: string; work_item_id: string };

/** Exact allowlist of internal fault codes that may persist verbatim.
 * error.code is attacker-controlled: a shape check (regex, prefix or
 * namespace) is not proof of trust, so only codes this module actually
 * produces or classifies on are admitted; everything else collapses to a
 * fixed classification label below. */
const SAFE_FAULT_CODES = new Set<string>([
  "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF",
  "FAIL_CLOSED_OBJECTIVE_WAKEUP",
  "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT",
  "FAIL_CLOSED_READ_BUDGET_SCHEMA",
  "FAIL_CLOSED_ASYNC_READ_BUDGET",
]);

/** Fixed classification labels — the complete durable fault vocabulary.
 *  P15.10-C adds the DRIVER_* labels the production driver's typed
 *  denials produce (still a closed set — raw error text and arbitrary
 *  error.code values can never persist). */
const DRIVER_LABELS = new Set<string>(DRIVER_FAULT_LABELS);
const FAULT_LABELS = new Set<string>([
  "SQLITE_CONTENTION", "NOT_FOUND", "INTEGRITY_FAULT", "UNEXPECTED_FAULT",
  ...DRIVER_FAULT_LABELS,
]);

/** Typed, bounded fault label for durable state. Raw exception text and
 * arbitrary error.code values are untrusted and may carry
 * secrets/canaries — never persist them. */
export function faultCode(e: unknown): string {
  /* Only a genuine DriverDenial instance with a closed, matching
   * label/code pair receives the precise typed classification.
   * Raw text, arbitrary error.code and object-shaped mocks are untrusted. */
  if (e instanceof DriverDenial) {
    const label: unknown = e.label;
    if (typeof label === "string" && DRIVER_LABELS.has(label) &&
        e.code === `FAIL_CLOSED_${label}`) return label;
    return "INTEGRITY_FAULT";
  }
  const code = String((e as { code?: unknown } | null | undefined)?.code ?? "");
  if (SAFE_FAULT_CODES.has(code)) return code;
  if (isSqliteContentionError(e)) return "SQLITE_CONTENTION";
  if (e instanceof NotFoundError) return "NOT_FOUND";
  if (e instanceof IntegrityError) return "INTEGRITY_FAULT";
  return "UNEXPECTED_FAULT";
}

/** Durable reason fields only carry allowlisted codes. Anything else —
 * including raw error strings or forged uppercase tokens — collapses to a
 * fixed label. */
export function sanitizeFaultReason(reason: unknown): string {
  const text = String(reason ?? "");
  if (SAFE_FAULT_CODES.has(text) || FAULT_LABELS.has(text)) return text;
  return "UNSPECIFIED_FAULT";
}

type Queue = Row & {
  objective_id: string; business_id: string; owner_authority_id: string;
  policy_version: number; terms_digest: string; objective_version: number;
  registration_rank: number; pending_generation: number; claimed_generation: number;
  settled_generation: number; checkpoint_digest: string; source_refs: string[];
  reasons: string[]; next_due: number | null; wait_kind: string | null;
  retry_count: number; queue_state: string; blocked_reason: string | null;
  wait_streak: number;
  last_observation_digest: string; last_source_seq: number;
};
type Lease = Row & {
  objective_id: string; state: string; fence: number; token_hash: string | null;
  worker_id: string | null; boot_id: string | null; expires_at: number | null;
  renewed_at: number | null; claimed_generation: number; checkpoint_digest: string;
  policy_version: number; terms_digest: string; objective_version: number;
  owner_authority_id: string; max_lifetime_ms?: number;
};

/** P15.10-C R1: claim-time lease lifetime bounds. The default preserves
 * P15.10-B behavior (300s); consumers bound it to their awaited work
 * (e.g. driver CEO timeout + finalization allowance) at claim, never
 * beyond an absolute cap. TTL stays 60s regardless — only lifetime moves. */
export const LEASE_MAX_LIFETIME_CAP_MS = 960_000;
export const LEASE_MAX_LIFETIME_DEFAULT_MS = 300_000;
export const LEASE_MAX_LIFETIME_MIN_MS = 60_000;
export type LeaseHandle = {
  objective_id: string; worker_id: string; boot_id: string; token: string;
  fence: number; claimed_generation: number; checkpoint_digest: string;
};

function invalid(reason: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF", reason);
}

function fields(row: Row): Row {
  const { version, entity_type: _type, entity_id: _id, ...rest } = row;
  return { ...rest, version };
}

/** The current protected row MUST have a matching, hash-verified immutable
 * commit. A structural count/unique index prevents missing/duplicate
 * revisions; it is never a substitute for the pinned current-row digest.
 * Historical operation receipts are verified independently on replay. */
export function readSchedulerRow<T extends Row>(store: PairEvidenceStore, type: string, id: string): T | null {
  const row = store.tryGet(type, id) as T | null;
  const structure = store.schedulerRevisionSummary(type, id);
  if (!row) {
    if (structure.count) invalid(`orphaned commits ${type}:${id}`);
    return null;
  }
  if (row.entity_type !== type || row.entity_id !== id || row.schema_version !== SCHEDULER_SCHEMA ||
      !Number.isSafeInteger(row.version) || row.version < 1 ||
      structure.count !== row.version || structure.first !== 1 ||
      structure.last !== row.version || structure.invalid !== 0) {
    invalid(`missing or invalid commit revisions ${type}:${id}`);
  }
  const commits = store.eventPage({
    after_seq: 0, limit: 2, topics: [SCHEDULER_COMMIT], entity_type: type,
    entity_id: id, descending: true,
  });
  const latest = commits[0];
  const m = latest?.metadata as Record<string, unknown> | null;
  const prior = commits[1];
  if (!latest || !m || m.schema_version !== SCHEDULER_SCHEMA ||
      m.revision !== row.version || m.pins_digest !== digest(row) ||
      m.predecessor_hash !== (prior?.event_hash ?? null) ||
      (row.version === 1 ? !!prior : !prior ||
        (prior.metadata as Record<string, unknown> | null)?.revision !== row.version - 1)) {
    invalid(`protected row/commit mismatch ${type}:${id}`);
  }
  return row;
}

export function writeSchedulerRow<T extends Row>(
  store: PairEvidenceStore, type: string, id: string, value: Record<string, unknown>,
  operation: string, receiptKey: string,
): T {
  const previous = readSchedulerRow<Row>(store, type, id);
  const oldVersion = previous?.version ?? 0;
  const priorCommit = oldVersion ? store.eventPage({ after_seq: 0, limit: 1,
    topics: [SCHEDULER_COMMIT], entity_type: type, entity_id: id, descending: true })[0] : null;
  const stored = store.put(type, id, { ...value, schema_version: SCHEDULER_SCHEMA,
    version: oldVersion } as Record<string, unknown>, oldVersion) as T;
  store.event({ entity_type: type, entity_id: id, event_type: SCHEDULER_COMMIT,
    actor: "objective-auto-scheduler:reconcile-only", metadata: {
      schema_version: SCHEDULER_SCHEMA, revision: stored.version,
      pins_digest: digest(stored), predecessor_hash: priorCommit?.event_hash ?? null,
      operation, receipt_key: receiptKey,
    } });
  return stored;
}

/** No production consumer is constructed here. Lease methods are a pure,
 * isolated preparation contract; runtime never invokes claim/settle. */
export class ObjectiveAutoScheduler {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly objectives: ObjectiveAuthorityService,
    private readonly policy: ObjectiveAutoPolicyService,
    private readonly now: () => number = Date.now,
  ) {}

  /** R3-F1 — rotating deep-verify position. Process-local by design: it
   *  only chooses WHICH slice receives the charged re-proof on this call
   *  and never decides authority — a restart simply re-covers the
   *  keyspace, so detection stays bounded per process lifetime. */
  private integrityAfter: { t: string; id: string } | null = null;

  /** P18-C — canonical relation substrate, lazily composed (same
   *  pattern ObjectiveRelationService uses for objectives). The
   *  scheduler is the ONLY consumer of the strict admission view —
   *  portfolio/status reads use the lenient helpers. */
  private _relations?: ObjectiveRelationService;
  private get relations(): ObjectiveRelationService {
    this._relations ??= new ObjectiveRelationService(this.store);
    return this._relations;
  }

  private instant(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) invalid("invalid trusted clock");
    return now;
  }

  /** P18-C — the canonical relation admission gate shared by
   *  claimable() (read-only readiness predicate), nextFairCandidate()
   *  (scan skip), and claim() (atomic re-proof under the writer lock).
   *  UPSTREAM_UNMET: any ACTIVE DEPENDS_ON upstream not ACHIEVED —
   *  pending AND terminally-failed upstreams both block (owner action:
   *  wait / revoke / supersede). CONFLICT_LEASE_HELD: an ACTIVE
   *  CONFLICTS partner holds a live lease — mutual exclusion on the
   *  parallel lane. The relation set is STRICT-enumerated
   *  (admissionView): a corrupt relation row propagates and wedges
   *  admission rather than silently clearing it; an unproven/forged
   *  edge never gates. Upstream status re-reads strict here because
   *  the relation proof pins endpoints, not their mutable status. */
  private relationGate(objectiveId: string, activeLeases: string[]): string | null {
    const { upstream, conflicts } = this.relations.admissionView(objectiveId);
    for (const up of upstream) {
      const u = this.objectives.get(up) as Row;
      if (String(u.status) !== "ACHIEVED") return "UPSTREAM_UNMET";
    }
    const active = new Set(activeLeases);
    if (conflicts.some((c) => active.has(c))) return "CONFLICT_LEASE_HELD";
    return null;
  }

  /** Read-only roster view for claimable()'s conflict gate — mirrors
   *  activeRoster()'s liveness predicate WITHOUT its reaping writes
   *  (claimable never mutates). Malformed roster state fails closed
   *  like the write path. */
  private activeLeaseIdsReadOnly(): string[] {
    const f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
    if (!f) return [];
    if (!Array.isArray(f.active_leases) || f.active_leases.length > MAX_ACTIVE ||
        f.active_leases.some(id => typeof id !== "string") ||
        new Set(f.active_leases).size !== f.active_leases.length) {
      invalid("global lease roster corrupt");
    }
    return (f.active_leases as string[]).filter((id) => {
      const lease = this.lease(id);
      // A roster id that resolves to nothing is corrupt — mirror
      // activeRoster()'s invalid() so claimable()'s readiness can
      // never drift from what claim() actually enforces.
      if (!lease) invalid("roster lease missing");
      return lease.state === "ACTIVE" && Number(lease.expires_at) > this.instant();
    });
  }

  private proof<T>(fn: () => T): T {
    return this.store.withReadBudget({ entities: 1024, events: 512 }, () => this.store.immediate(fn));
  }

  private authority(objectiveId: string): { row: Row; status: AutoPolicyStatus } {
    const row = this.objectives.get(objectiveId) as Row;
    const status = this.policy.evaluate(objectiveId);
    if (String(row.objective_id) !== objectiveId ||
        String(row.business_id) !== status.business_id ||
        String(row.owner_authority_id) !== status.owner_authority_id) {
      invalid("objective/policy identity mismatch");
    }
    return { row, status };
  }

  /** P15.10-C R4 F3 — the canonical per-objective claim predicate.
   *  claim() and the readiness projection share THIS evaluation so a
   *  status read can never drift from what a real claim enforces.
   *  Returns the typed ineligibility reason, or null when the queue
   *  alone would permit a claim attempt right now. */
  private queueEligibility(q: Queue | null): string | null {
    if (!q) return "NO_QUEUE";
    if (q.queue_state !== "WAITING_CONSUMER") return `QUEUE_${q.queue_state}`;
    if (q.pending_generation <= q.claimed_generation &&
        q.claimed_generation <= q.settled_generation) {
      return "NO_PENDING_GENERATION";
    }
    if (q.next_due !== null && q.next_due > this.instant()) return "NOT_DUE_YET";
    if (Number(q.last_attempt_at ?? -30_000) + 30_000 > this.instant()) {
      return "ATTEMPT_COOLDOWN";
    }
    return null;
  }

  /** Read-only canonical claim-eligibility proof: the same queue
   *  predicate claim() enforces, plus the objective-level authority,
   *  lease and P18-C relation conditions a real claim requires. Global
   *  contention checks (roster cap, rate window) stay in claim() —
   *  they are transient, never an objective-readiness fact — while the
   *  objective-scoped relation gates (UPSTREAM_UNMET,
   *  CONFLICT_LEASE_HELD) ARE readiness facts the owner should see.
   *  Never mutates: no wake, no lease, no invalidation (the roster
   *  view is the read-only mirror — activeRoster reaps). */
  claimable(objectiveId: string): { eligible: boolean; reason: string | null } {
    return this.proof(() => {
      const q = this.queue(objectiveId);
      const qr = this.queueEligibility(q);
      if (qr !== null) return { eligible: false, reason: qr };
      const a = this.authority(objectiveId);
      if (!a.status.configured || !a.status.effective) {
        return { eligible: false, reason: "POLICY_NOT_EFFECTIVE" };
      }
      // Authority identity = the objective_digest domain (terms_version +
      // protected terms): terms_current re-proves binding==current digest
      // live — NOT row.version. Runtime writes (KPI progress, spend,
      // evidence) bump version without mutating authority; the verifier
      // advance inside a pass must never count as external drift.
      if (!a.status.terms_current ||
          a.status.policy_version !== q!.policy_version ||
          a.status.terms_digest_binding !== q!.terms_digest ||
          a.status.owner_authority_id !== q!.owner_authority_id ||
          a.status.business_id !== q!.business_id) {
        return { eligible: false, reason: "STALE_BINDING" };
      }
      const prior = this.lease(objectiveId);
      if (prior?.state === "ACTIVE" && Number(prior.expires_at) > this.instant()) {
        return { eligible: false, reason: "LEASE_HELD" };
      }
      // P18-C — relation admission gate LAST: strict enumeration is
      // the most expensive check and corruption wedges loudly.
      const gate = this.relationGate(objectiveId, this.activeLeaseIdsReadOnly());
      if (gate !== null) return { eligible: false, reason: gate };
      return { eligible: true, reason: null };
    });
  }

  private queue(objectiveId: string): Queue | null {
    return readSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId);
  }

  private lease(objectiveId: string): Lease | null {
    return readSchedulerRow<Lease>(this.store, LEASE_STATE, objectiveId);
  }

  private requireCurrent(q: Queue, a: { row: Row; status: AutoPolicyStatus }): void {
    if (!a.status.configured || !a.status.effective || !a.status.terms_current ||
        a.status.policy_version !== q.policy_version ||
        a.status.terms_digest_binding !== q.terms_digest ||
        a.status.owner_authority_id !== q.owner_authority_id ||
        a.status.business_id !== q.business_id) {
      invalid(`stale policy/objective binding ${q.objective_id}`);
    }
  }

  status(objectiveId: string, actor: string,
    driver?: {
      enabled: boolean; driver_missing: string[];
      /** P15.10-C R3 F3 — optional truthful per-objective runnable
       *  proof from the wired driver's readiness(). When absent the
       *  projection stays deployment-level honest: integrated but
       *  runnable unproven. */
      runnable?: boolean; reasons?: string[];
    },
  ): Record<string, unknown> {
    return this.proof(() => {
      const status = this.policy.status(objectiveId, actor);
      const q = this.queue(objectiveId);
      const lease = this.lease(objectiveId);
      const cursor = readSchedulerRow<Row>(this.store, SCHEDULER_CURSOR, GLOBAL);
      const integrated = driver?.enabled === true;
      const runnable = integrated && driver?.runnable === true;
      return {
        objective_id: objectiveId, scheduler_mode: OBJECTIVE_SCHEDULER_MODE,
        scheduler_ready: cursor ? cursor.health === "READY" : false,
        // Deployment integration vs objective-level runnable truth —
        // READY is only claimed when canonical evidence proves both.
        driver_integrated: integrated,
        consumer_ready: runnable, driver_ready: runnable,
        objective_runnable: runnable,
        driver_missing: integrated
          ? (driver?.reasons ?? [])
          : (driver?.driver_missing ?? status.driver_missing),
        policy_effective: status.effective, policy_version: status.policy_version,
        terms_current: status.terms_current,
        queue_state: q?.queue_state ?? "UNREGISTERED",
        pending_generation: q?.pending_generation ?? 0,
        claimed_generation: q?.claimed_generation ?? 0,
        checkpoint_digest: q?.checkpoint_digest ?? null,
        pending_reasons: q?.reasons.slice(0, 32) ?? [],
        coalesced_count: Number(q?.coalesced_count ?? 0),
        source_refs: q?.source_refs.slice(0, 32) ?? [],
        next_due: q?.next_due ?? null, wait_kind: q?.wait_kind ?? null,
        retry_count: q?.retry_count ?? 0, blocked_reason: q?.blocked_reason ?? null,
        owner_action_required: q?.queue_state === "BLOCKED_AUTHORITY" || q?.queue_state === "QUARANTINED",
        lease: lease ? { state: lease.state, fence: lease.fence, expires_at: lease.expires_at } : null,
        catchup_state: cursor?.health ?? "NOT_STARTED",
      };
    });
  }

  private register(objectiveId: string, a: { row: Row; status: AutoPolicyStatus }): Queue | null {
    let q = this.queue(objectiveId);
    if (q || !a.status.configured) return q;
    const f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
    const rank = Number(f?.registration_counter ?? 0) + 1;
    if (rank > 10_000) invalid("configured Objective cap reached");
    writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
      ...(f ? fields(f) : {}),
      registration_counter: rank, round: Number(f?.round ?? 1),
      cohort_high_rank: Number(f?.cohort_high_rank ?? rank),
      last_visited_rank: Number(f?.last_visited_rank ?? 0),
      active_leases: f?.active_leases ?? [],
    }, "REGISTER", objectiveId);
    q = writeSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId, {
      objective_id: objectiveId, business_id: a.status.business_id,
      owner_authority_id: a.status.owner_authority_id,
      policy_version: a.status.policy_version, terms_digest: a.status.terms_digest_binding,
      objective_version: a.row.version, registration_rank: rank,
      pending_generation: 0, claimed_generation: 0, settled_generation: 0,
      checkpoint_digest: digest({ objectiveId, rank }), source_refs: [], reasons: [],
      coalesced_count: 0, next_due: null, wait_kind: null, retry_count: 0,
      wait_streak: 0,
      queue_state: "WAITING_CONSUMER", blocked_reason: null,
      last_observation_digest: "", last_source_seq: 0,
    }, "REGISTER", objectiveId);
    return q;
  }

  private allocFor(objectiveId: string, allocationId: string): Row {
    if (typeof allocationId !== "string" || !allocationId) {
      invalid("wake binding: allocation reference missing");
    }
    const row = this.store.tryGet(WORKFORCE_ALLOCATION_ENTITY, allocationId) as Row | null;
    if (!row) invalid("wake binding: allocation does not resolve");
    assertCanonicalWorkforceAllocationProvenance(this.store, row);
    if (String(row.objective_id) !== objectiveId) {
      invalid("wake binding: allocation/objective mismatch");
    }
    return row;
  }

  private static allocItems(row: Row): Set<string> {
    return new Set([String(row.workstream_work_item_id),
      String(row.delegated_child_work_item_id)]);
  }

  /** R1-F2 — canonical provenance re-proof. accountWake can only write a
   * wake whose source event is provably bound to the Objective by the
   * caller-supplied binding chain, re-verified hop by hop against the
   * canonical store. A forged cross-objective source fails closed. */
  private verifyWakeBinding(ev: Row, objectiveId: string, b: WakeBinding): void {
    if (!b || typeof b !== "object") invalid("wake binding missing");
    if (!OBJECTIVE_WAKE_INPUT_TOPICS.includes(
      String(ev.event_type) as typeof OBJECTIVE_WAKE_INPUT_TOPICS[number])) {
      invalid("wake source topic is not wake-eligible");
    }
    const et = String(ev.entity_type);
    const verifyMissionChain = (missionId: string, openId: string, workItemId: string,
        alloc: Row): void => {
      const mission = this.store.tryGet("mission", missionId) as Row | null;
      if (!mission || String(mission.bound_open_id ?? "") !== openId) {
        invalid("wake binding: mission/open origin proof missing");
      }
      const bound = validateWorkOpenBindingById(this.store, openId, {
        forMission: mission, requireState: "BOUND", mode: "PROVENANCE",
      });
      if (!bound.ok || !bound.binding ||
          String(bound.binding.work_item_id ?? "") !== workItemId) {
        invalid("wake binding: open/work-item chain broken");
      }
      if (!ObjectiveAutoScheduler.allocItems(alloc).has(workItemId)) {
        invalid("wake binding: work item outside allocation");
      }
    };
    switch (b.kind) {
      case "objective":
        if (et !== "objective" || String(ev.entity_id) !== objectiveId) {
          invalid("wake binding: event is not on this objective");
        }
        return;
      case "auto_policy":
        if (et !== AUTO_POLICY_ENTITY ||
            String(ev.entity_id) !== `oap:${objectiveId}` ||
            String(ev.correlation_id ?? "") !== objectiveId) {
          invalid("wake binding: policy/objective mismatch");
        }
        return;
      case "objective_ref": {
        if (et !== "objective_adaptive_review" && et !== "objective_strategy_revision") {
          invalid("wake binding: not an objective-ref entity");
        }
        const row = this.store.tryGet(et, String(ev.entity_id)) as Row | null;
        if (!row || String(row.objective_id) !== objectiveId) {
          invalid("wake binding: entity/objective mismatch");
        }
        return;
      }
      case "work_item": {
        const alloc = this.allocFor(objectiveId, b.allocation_id);
        if (et !== "work_item" || String(ev.entity_id) !== b.work_item_id ||
            !ObjectiveAutoScheduler.allocItems(alloc).has(b.work_item_id)) {
          invalid("wake binding: work item link broken");
        }
        return;
      }
      case "agent": {
        const alloc = this.allocFor(objectiveId, b.allocation_id);
        if (String(alloc.selected_agent_id) !== b.agent_id) {
          invalid("wake binding: agent outside allocation");
        }
        const agentId = et === "org_agent" ? String(ev.entity_id)
          : String((this.store.tryGet(et, String(ev.entity_id)) as Row | null)
              ?.org_agent_id ?? "");
        if (agentId !== b.agent_id) invalid("wake binding: agent link broken");
        return;
      }
      case "mission": {
        const alloc = this.allocFor(objectiveId, b.allocation_id);
        if (et !== "mission" || String(ev.entity_id) !== b.mission_id) {
          invalid("wake binding: mission link broken");
        }
        verifyMissionChain(b.mission_id, b.open_id, b.work_item_id, alloc);
        return;
      }
      case "approval": {
        const alloc = this.allocFor(objectiveId, b.allocation_id);
        if (et !== "approval_request" && et !== "approval_exercise") {
          invalid("wake binding: not an approval source");
        }
        const row = this.store.tryGet("approval_request",
          String(ev.entity_id)) as Row | null;
        const meta = ev.metadata as Record<string, unknown> | null;
        const derivedMission = String(row?.mission_id ?? meta?.mission_id ?? "");
        if (derivedMission !== b.mission_id) {
          invalid("wake binding: approval/mission mismatch");
        }
        verifyMissionChain(b.mission_id, b.open_id, b.work_item_id, alloc);
        return;
      }
      default:
        invalid("wake binding: unknown kind");
    }
  }

  /** Persist one canonical-source wake hint. The source MUST be an existing
   * hash-verified store event whose binding chain to the Objective is
   * re-proven canonically at write time; this seam also re-proves the
   * CURRENT authority binding before it writes. */
  accountWake(input: { objective_id: string; source_event_id: string;
    reason: string; checkpoint?: string; source_scope?: string;
    binding: WakeBinding }): Queue | null {
    return this.proof(() => {
      const a = this.authority(input.objective_id);
      const q = this.register(input.objective_id, a);
      if (!q) return null;
      const ev = this.store.getEvent(input.source_event_id);
      if (String(ev.event_id) !== input.source_event_id ||
          !/^[a-f0-9]{64}$/.test(String(ev.event_hash)) ||
          !input.reason || input.reason.length > 128 ||
          (input.source_scope !== undefined &&
            (!input.source_scope || input.source_scope.length > 256))) {
        invalid("unverified wake source schema");
      }
      this.verifyWakeBinding(ev as Row, input.objective_id, input.binding);
      const sourceDigest = String(ev.event_hash);
      const sourceKey = `event:${input.source_event_id}`;
      const key = digest({ id: input.objective_id, source: sourceKey,
        generation: a.status.policy_version, terms: a.status.terms_digest_binding });
      const receiptId = `wake:${key}`;
      const receipt = readSchedulerRow<Row>(this.store, WAKE_SEGMENT, receiptId);
      const semantic = digest({ source_digest: sourceDigest, reason: input.reason,
        seq: Number(ev.seq), checkpoint: input.checkpoint ?? null,
        source_scope: input.source_scope ?? null });
      if (receipt) {
        if (receipt.semantic_digest !== semantic || receipt.objective_id !== input.objective_id) {
          invalid("conflicting source replay");
        }
        return q;
      }
      if (!Number.isSafeInteger(Number(ev.seq)) || Number(ev.seq) < 1) {
        invalid("invalid source sequence");
      }
      writeSchedulerRow(this.store, WAKE_SEGMENT, receiptId, {
        objective_id: input.objective_id, source_key: sourceKey,
        source_event_id: input.source_event_id, source_scope: input.source_scope ?? null,
        source_digest: sourceDigest, semantic_digest: semantic,
        source_seq: Number(ev.seq), checkpoint: input.checkpoint ?? null,
        generation: q.pending_generation + 1,
      }, "WAKE_SOURCE", key);
      const current = this.requireRebind(q, a);
      return writeSchedulerRow<Queue>(this.store, WAKE_STATE, input.objective_id, {
        ...fields(current), policy_version: a.status.policy_version,
        terms_digest: a.status.terms_digest_binding,
        objective_version: a.row.version,
        owner_authority_id: a.status.owner_authority_id, business_id: a.status.business_id,
        pending_generation: current.pending_generation + 1,
        checkpoint_digest: digest({ previous: current.checkpoint_digest, key, semantic }),
        reasons: [...new Set([...current.reasons, input.reason])].slice(0, 32),
        source_refs: [...current.source_refs, receiptId].slice(-256),
        coalesced_count: Number(current.coalesced_count ?? 0) + (current.source_refs.length >= 256 ? 1 : 0),
        last_source_seq: Math.max(current.last_source_seq, Number(ev.seq)),
        // R1-F1: a genuinely new verified wake creates new pending work —
        // it must not inherit a stale no-progress checkpoint or streak
        next_due: null, wait_streak: 0,
        queue_state: a.status.effective ? "WAITING_CONSUMER" : "BLOCKED_AUTHORITY",
        blocked_reason: a.status.effective ? null : a.status.reasons.join(",").slice(0, 512),
      }, "WAKE", key);
    });
  }

  /** A canonical, owner-granted KVA can re-arm exactly one settled
   * VERIFIED_KPI_EVIDENCE wait. This is a wake ONLY, not KPI progress.
   * Caller atomically composes this with the owner-scoped grant, so a
   * committed grant cannot lose its wake on a process crash. No change
   * to the global wake topic filter or its persisted cursor digest.
   */
  notifyKpiVerifierGrant(objectiveId: string, authorizationId: string): Queue | null {
    return this.proof(() => {
      const q = this.queue(objectiveId);
      // Blocked/quarantined, healthy, in-flight and scheduled waits never
      // get new generations from KVA notifications.
      if (!q || q.queue_state !== "WAITING_EVIDENCE" ||
          q.wait_kind !== "VERIFIED_KPI_EVIDENCE" || q.next_due !== null ||
          q.pending_generation !== q.claimed_generation ||
          q.claimed_generation !== q.settled_generation) return q;
      const a = this.authority(objectiveId);
      if (!a.status.configured || !a.status.effective || !a.status.terms_current) return q;
      this.requireCurrent(q, a);
      const active = this.lease(objectiveId);
      if (active?.state === "ACTIVE" && Number(active.expires_at) > this.instant()) return q;
      if (!/^KVA_[A-Za-z0-9]+$/.test(authorizationId)) {
        invalid("KPI verifier grant identifier invalid");
      }
      const grant = this.store.get(KPI_AUTH_ENTITY, authorizationId) as Row;
      if (String(grant.authorization_id) !== authorizationId ||
          String(grant.objective_id) !== objectiveId ||
          String(grant.schema_version) !== KPI_VERIFIER_SCHEMA) {
        invalid("KPI verifier grant binding mismatch");
      }
      // A replay of an expired/revoked grant is a no-op, never a wake.
      if (kpiAuthEffectiveReason(grant, a.row, String(grant.kpi_id), this.instant()) !== null)
        return q;
      const authDigest = digest({
        schema: KPI_VERIFIER_SCHEMA, authorization_id: authorizationId,
        objective_id: objectiveId, kpi_id: String(grant.kpi_id),
        rule_digest: String(grant.rule_digest),
        terms: Number(grant.objective_terms_version),
      });
      if (String(grant.authorization_digest) !== authDigest) {
        invalid("KPI verifier grant digest mismatch");
      }
      const receiptId = `kpi-verifier-grant:${authorizationId}`;
      const prior = readSchedulerRow<Row>(this.store, WAKE_SEGMENT, receiptId);
      if (prior) {
        if (String(prior.objective_id) !== objectiveId ||
            String(prior.authorization_digest) !== authDigest)
          invalid("KPI verifier grant wake replay mismatch");
        return q;
      }
      writeSchedulerRow(this.store, WAKE_SEGMENT, receiptId, {
        objective_id: objectiveId, authorization_id: authorizationId,
        authorization_digest: authDigest, source_key: receiptId,
        source_digest: authDigest,
        semantic_digest: digest({ objectiveId, authorizationId, authDigest }),
        generation: q.pending_generation + 1,
      }, "KPI_VERIFIER_GRANT_SOURCE", receiptId);
      return writeSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId, {
        ...fields(q), pending_generation: q.pending_generation + 1,
        checkpoint_digest: digest({
          previous: q.checkpoint_digest, authorization_id: authorizationId,
          authorization_digest: authDigest,
        }),
        reasons: [...new Set([...q.reasons, "KPI_VERIFIER_GRANT"])].slice(0, 32),
        source_refs: [...q.source_refs, receiptId].slice(-256),
        coalesced_count: Number(q.coalesced_count ?? 0) +
          (q.source_refs.length >= 256 ? 1 : 0),
        queue_state: "WAITING_CONSUMER", wait_kind: null,
        next_due: null, wait_streak: 0, blocked_reason: null,
      }, "KPI_VERIFIER_GRANT", receiptId);
    });
  }

  /** Persisted scheduler next_due is a scheduler checkpoint, not a
   * canonical external event. This only re-hints already-due durable state;
   * it never resets retry budget or makes an owner blocker runnable. */
  markDue(objectiveId: string): Queue | null {
    return this.proof(() => {
      const a = this.authority(objectiveId);
      const q = this.queue(objectiveId);
      if (!q || q.next_due === null || q.next_due > this.instant() ||
          q.queue_state !== "WAITING_EVIDENCE") return q;
      const sourceKey = `due:${objectiveId}:${q.next_due}:${q.policy_version}`;
      const sourceDigest = digest({ objective_id: objectiveId,
        checkpoint_digest: q.checkpoint_digest, next_due: q.next_due,
        policy_version: q.policy_version, terms_digest: q.terms_digest });
      const key = digest({ id: objectiveId, source: sourceKey,
        generation: a.status.policy_version, terms: a.status.terms_digest_binding });
      const receiptId = `wake:${key}`;
      if (readSchedulerRow<Row>(this.store, WAKE_SEGMENT, receiptId)) return q;
      writeSchedulerRow(this.store, WAKE_SEGMENT, receiptId, {
        objective_id: objectiveId, source_key: sourceKey,
        source_digest: sourceDigest, semantic_digest: sourceDigest,
        generation: q.pending_generation + 1,
      }, "DUE_SOURCE", key);
      const current = this.requireRebind(q, a);
      return writeSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId, {
        ...fields(current), pending_generation: current.pending_generation + 1,
        checkpoint_digest: digest({ previous: current.checkpoint_digest, key, sourceDigest }),
        reasons: [...new Set([...current.reasons, "NEXT_DUE"])].slice(0, 32),
        source_refs: [...current.source_refs, receiptId].slice(-256),
        queue_state: a.status.effective ? "WAITING_CONSUMER" : "BLOCKED_AUTHORITY",
        blocked_reason: a.status.effective ? null : a.status.reasons.join(",").slice(0, 512),
      }, "DUE", key);
    });
  }

  quarantine(objectiveId: string, reason: string): Queue | null {
    return this.proof(() => {
      const a = this.authority(objectiveId);
      const q = this.register(objectiveId, a);
      if (!q) return null;
      return writeSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId, {
        ...fields(q), queue_state: "QUARANTINED",
        blocked_reason: sanitizeFaultReason(reason),
      }, "QUARANTINE", `${objectiveId}:${digest(reason)}`);
    });
  }

  private requireRebind(q: Queue, a: { row: Row; status: AutoPolicyStatus }): Queue {
    const lease = this.lease(q.objective_id);
    // Same precision contract as requireCurrent — runtime objective
    // writes (the pass's own verifier/spend effects) are not drift.
    if (lease?.state === "ACTIVE" &&
        (lease.policy_version !== a.status.policy_version ||
         lease.owner_authority_id !== a.status.owner_authority_id ||
         lease.terms_digest !== a.status.terms_digest_binding ||
         !a.status.terms_current || !a.status.effective)) {
      writeSchedulerRow(this.store, LEASE_STATE, q.objective_id, {
        ...fields(lease), state: "INVALIDATED", fence: lease.fence + 1,
        token_hash: null, expires_at: null,
      }, "INVALIDATE", `authority:${a.status.policy_version}:${a.row.version}`);
    }
    return q;
  }

  private activeRoster(): { f: Row; active: string[]; reaped: number } {
    const f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
    if (!f || !Array.isArray(f.active_leases) || f.active_leases.length > MAX_ACTIVE ||
        f.active_leases.some(id => typeof id !== "string") ||
        new Set(f.active_leases).size !== f.active_leases.length) invalid("global lease roster corrupt");
    const active: string[] = [];
    let reaped = 0;
    for (const id of f.active_leases as string[]) {
      const lease = this.lease(id);
      if (!lease) invalid("roster lease missing");
      if (lease.state === "ACTIVE" && Number(lease.expires_at) > this.instant()) {
        active.push(id);
      } else if (lease.state === "ACTIVE") {
        writeSchedulerRow(this.store, LEASE_STATE, id, {
          ...fields(lease), state: "EXPIRED", fence: lease.fence + 1,
          token_hash: null, expires_at: null,
        }, "LEASE_EXPIRED", `expire:${lease.fence}`);
        reaped++;
      }
    }
    const current = active.length === f.active_leases.length ? f :
      writeSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL, {
        ...fields(f), active_leases: active,
      }, "REAP_LEASES", digest(active));
    return { f: current, active, reaped };
  }

  observe(objectiveId: string, reason = "CANONICAL_OBSERVATION"): Queue | null {
    return this.proof(() => {
      const a = this.authority(objectiveId);
      const q = this.register(objectiveId, a);
      if (!q) return null;
      const observation = digest({ objective_digest: a.row.objective_digest,
        objective_version: a.row.version, status: a.row.status,
        policy_version: a.status.policy_version, effective: a.status.effective,
        reasons: a.status.reasons, terms_digest: a.status.terms_digest_binding });
      if (q.last_observation_digest === observation) return this.requireRebind(q, a);
      const current = this.requireRebind(q, a);
      const key = `observation:${observation}`;
      const r = readSchedulerRow<Row>(this.store, WAKE_SEGMENT, `observation:${objectiveId}:${observation}`);
      if (r) invalid("observation checkpoint rolled back");
      writeSchedulerRow(this.store, WAKE_SEGMENT, `observation:${objectiveId}:${observation}`, {
        objective_id: objectiveId, source_key: key, source_digest: observation,
        semantic_digest: digest({ reason, observation }), generation: current.pending_generation + 1,
      }, "OBSERVATION", key);
      return writeSchedulerRow<Queue>(this.store, WAKE_STATE, objectiveId, {
        ...fields(current), policy_version: a.status.policy_version,
        terms_digest: a.status.terms_digest_binding, objective_version: a.row.version,
        owner_authority_id: a.status.owner_authority_id, business_id: a.status.business_id,
        pending_generation: current.pending_generation + 1,
        checkpoint_digest: digest({ previous: current.checkpoint_digest, observation }),
        last_observation_digest: observation,
        source_refs: [...current.source_refs, `observation:${objectiveId}:${observation}`].slice(-256),
        reasons: [...new Set([...current.reasons, reason])].slice(0, 32),
        // R1-F1: same reset as accountWake — a new observation digest means
        // new pending work; the stale wait checkpoint must not suppress it
        next_due: null, wait_streak: 0,
        queue_state: a.status.effective ? "WAITING_CONSUMER" : "BLOCKED_AUTHORITY",
        blocked_reason: a.status.effective ? null : a.status.reasons.join(",").slice(0, 512),
      }, "OBSERVE", key);
    });
  }

  /** Durable stale-lease reconciliation. It only expires/re-fences lease
   * metadata; the already-claimed generation stays unsettled so a later
   * fenced attempt can reclaim it without erasing newer pending wakes. */
  reconcileLeases(limit = PAGE): { scanned: number; expired: number } {
    return this.proof(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE) invalid("invalid lease scan bound");
      let f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
      const keep = new Set<string>();
      let expired = 0;
      if (f) {
        const roster = this.activeRoster();
        f = roster.f;
        expired = roster.reaped;
        for (const id of roster.active) keep.add(id);
      }
      let scanned = 0, after = "";
      while (scanned < limit) {
        const page = this.store.entityPage<Lease>({ entity_type: LEASE_STATE,
          after_id: after, limit: Math.min(PAGE, limit - scanned) });
        if (!page.length) break;
        for (const candidate of page) {
          const lease = this.lease(String(candidate.entity_id));
          if (!lease) invalid("lease index/entity mismatch");
          scanned++;
          if (lease.state === "ACTIVE" && Number(lease.expires_at) <= this.instant()) {
            writeSchedulerRow(this.store, LEASE_STATE, String(lease.entity_id), {
              ...fields(lease), state: "EXPIRED", fence: lease.fence + 1,
              token_hash: null, expires_at: null,
            }, "LEASE_EXPIRED", `expire:${lease.fence}`);
            keep.delete(String(lease.entity_id));
            expired++;
          }
          after = String(lease.entity_id);
        }
        if (page.length < Math.min(PAGE, limit - scanned + page.length)) break;
      }
      if (expired && f) {
        writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
          ...fields(f), active_leases: [...keep],
        }, "RECONCILE_LEASES", digest([...keep]));
      }
      return { scanned, expired };
    });
  }

  /** Test-only preparation contract. This does not call the operating loop. */
  claim(objectiveId: string, workerId: string, bootId: string, opportunity: string,
      opts?: { max_lifetime_ms?: number }): LeaseHandle {
    // P18-C F1 — advance the relation edge index in its OWN committed
    // transaction: chunks persist even when the gate below later
    // wedges on budget/corruption, so the O(degree) index converges
    // over write calls instead of rolling back forever.
    this.store.immediate(() => this.relations.ensureIndex());
    const result = this.proof(() => {
      if (!workerId || workerId.length > 128 || !bootId || bootId.length > 128 ||
          !opportunity || opportunity.length > 128) invalid("invalid worker/opportunity");
      const maxLifetime = opts?.max_lifetime_ms ?? LEASE_MAX_LIFETIME_DEFAULT_MS;
      if (!Number.isFinite(maxLifetime) || maxLifetime < LEASE_MAX_LIFETIME_MIN_MS ||
          maxLifetime > LEASE_MAX_LIFETIME_CAP_MS) invalid("invalid max lease lifetime bound");
      const qRaw = this.queue(objectiveId);
      if (this.queueEligibility(qRaw) !== null) {
        invalid("no pending eligible wake or attempt cooling down");
      }
      const q = qRaw!;
      const a = this.authority(objectiveId);
      this.requireCurrent(q!, a);
      const { f, active } = this.activeRoster();
      if (active.length >= MAX_ACTIVE || active.includes(objectiveId)) invalid("global/Objective lease cap");
      const rateWindowStart = Number(f.rate_window_start ?? 0);
      const rateWindowCount = rateWindowStart + 60_000 > this.instant()
        ? Number(f.rate_window_count ?? 0) : 0;
      if (rateWindowCount >= 120) invalid("global claim rate limit");
      const prior = this.lease(objectiveId);
      if (prior?.state === "ACTIVE" && Number(prior.expires_at) > this.instant()) {
        invalid("already claimed");
      }
      const retryCount = prior?.state === "EXPIRED" || prior?.state === "RELEASED"
        ? q.retry_count + 1 : q.retry_count;
      if (retryCount > Math.min(3, a.status.limits?.max_retries ?? 3)) {
        writeSchedulerRow(this.store, WAKE_STATE, objectiveId, {
          ...fields(q), retry_count: retryCount, queue_state: "BLOCKED_RETRY_EXHAUSTED",
          blocked_reason: "RETRY_LIMIT_REACHED",
        }, "RETRY_EXHAUSTED", opportunity);
        return null;
      }
      // P18-C — relation admission gate: the most expensive check runs
      // LAST, re-proven atomically with the roster the lease mint
      // joins (a DEPENDS_ON edge minted or a CONFLICTS partner claimed
      // between candidate selection and this check cannot be raced —
      // the whole gate+mint is one immediate transaction). Retried-
      // exhausted objectives still hit the durable marker above first
      // — pre-gating ordering is preserved.
      const gate = this.relationGate(objectiveId, active);
      if (gate !== null) invalid(`relation admission gate: ${gate}`);
      const token = randomBytes(32).toString("hex");
      const fence = (prior?.fence ?? 0) + 1;
      const lease = writeSchedulerRow<Lease>(this.store, LEASE_STATE, objectiveId, {
        objective_id: objectiveId, state: "ACTIVE", fence,
        token_hash: digest(token), worker_id: workerId, boot_id: bootId,
        expires_at: this.instant() + 60_000, renewed_at: this.instant(),
        started_at: this.instant(), max_lifetime_ms: maxLifetime,
        claimed_generation: q.pending_generation, checkpoint_digest: q.checkpoint_digest,
        policy_version: q.policy_version, terms_digest: q.terms_digest,
        owner_authority_id: q.owner_authority_id, objective_version: q.objective_version,
      }, "CLAIM", opportunity);
      writeSchedulerRow(this.store, WAKE_STATE, objectiveId, {
        ...fields(q), claimed_generation: lease.claimed_generation,
        retry_count: retryCount, last_attempt_at: this.instant(),
      }, "CLAIMED_GENERATION", opportunity);
      writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
        ...fields(f), active_leases: [...active, objectiveId],
        rate_window_start: rateWindowCount ? rateWindowStart : this.instant(),
        rate_window_count: rateWindowCount + 1,
      }, "CLAIM_CAPACITY", opportunity);
      writeSchedulerRow(this.store, SCHEDULER_RECEIPT,
        `claim:${objectiveId}:${fence}`, { objective_id: objectiveId,
          operation: "CLAIM", opportunity, claimed_generation: q.pending_generation,
          checkpoint_digest: q.checkpoint_digest, fence, worker_id: workerId,
          boot_id: bootId, lease_digest: digest(lease) }, "CLAIM_RECEIPT", opportunity);
      return { objective_id: objectiveId, worker_id: workerId, boot_id: bootId,
        token, fence, claimed_generation: q.pending_generation,
        checkpoint_digest: q.checkpoint_digest };
    });
    if (!result) invalid("retry limit exhausted");
    return result;
  }

  private currentLease(handle: LeaseHandle): { q: Queue; lease: Lease } {
    const q = this.queue(handle.objective_id);
    const lease = this.lease(handle.objective_id);
    if (!q || !lease || lease.state !== "ACTIVE" ||
        lease.fence !== handle.fence || lease.worker_id !== handle.worker_id ||
        lease.boot_id !== handle.boot_id || lease.token_hash !== digest(handle.token) ||
        lease.claimed_generation !== handle.claimed_generation ||
        lease.checkpoint_digest !== handle.checkpoint_digest ||
        Number(lease.expires_at) <= this.instant()) invalid("stale lease fence/expiry");
    // P15.10-C R2 F1.3: absolute lifetime is a canonical validation
    // boundary, not just a renew-time hint — past the claim-time bound
    // the lease cannot authorize ANY mutation (renew/settle/assert).
    const maxLifetime = Number(lease.max_lifetime_ms ?? LEASE_MAX_LIFETIME_DEFAULT_MS);
    if (Number(lease.started_at) + maxLifetime <= this.instant()) {
      invalid("stale lease lifetime");
    }
    const a = this.authority(handle.objective_id);
    this.requireCurrent(q, a);
    // Terms drift is re-proven by requireCurrent via terms_current —
    // lease pins add the policy/owner identity layer. The monotonic
    // row version is deliberately NOT a pin: a pass's own canonical
    // progress writes must not invalidate its own lease.
    if (lease.policy_version !== a.status.policy_version ||
        lease.terms_digest !== a.status.terms_digest_binding ||
        lease.owner_authority_id !== a.status.owner_authority_id ||
        !a.status.terms_current || !a.status.effective) {
      invalid("stale lease authority");
    }
    return { q, lease };
  }

  /** P15.10-C R2: narrow read-only authority assertion — the SINGLE
   *  lease/fence/binding proof other components (driver commit guard)
   *  may invoke. Re-validates state, fence, worker/boot identity,
   *  token digest, claimed generation, checkpoint, expiry, absolute
   *  lifetime, policy version, terms digest, owner and objective
   *  version through the existing currentLease path — never a second
   *  validator. */
  assertLeaseAuthority(handle: LeaseHandle): void {
    this.proof(() => { this.currentLease(handle); });
  }

  renew(handle: LeaseHandle): void {
    this.proof(() => {
      const { lease } = this.currentLease(handle);
      const maxLifetime = Number(lease.max_lifetime_ms ?? LEASE_MAX_LIFETIME_DEFAULT_MS);
      // F1.3: the lifetime check already ran inside currentLease; the
      // renewed expiry is additionally CLAMPED at the absolute deadline
      // so a lease can never outlive its bound between validations.
      if (Number(lease.renewed_at) + 15_000 > this.instant()) return;
      writeSchedulerRow(this.store, LEASE_STATE, handle.objective_id, {
        ...fields(lease), renewed_at: this.instant(),
        expires_at: Math.min(
          this.instant() + 60_000,
          Number(lease.started_at) + maxLifetime),
      }, "RENEW", `renew:${handle.fence}:${this.instant()}`);
      writeSchedulerRow(this.store, SCHEDULER_RECEIPT,
        `renew:${handle.objective_id}:${handle.fence}:${this.instant()}`, {
          objective_id: handle.objective_id, operation: "RENEW", fence: handle.fence,
          claimed_generation: handle.claimed_generation, checkpoint_digest: handle.checkpoint_digest,
          renewal_at: this.instant(), lease_digest: digest(this.lease(handle.objective_id)),
        }, "RENEW_RECEIPT", `renew:${handle.fence}:${this.instant()}`);
    });
  }

  settle(handle: LeaseHandle, outcome: OperatingOutcome, operationId: string): void {
    this.proof(() => {
      if (!operationId || operationId.length > 128) invalid("invalid settlement id");
      const a = this.authority(handle.objective_id);
      const priorReceiptId = `settle:${handle.objective_id}:${handle.fence}:${operationId}`;
      const priorReceipt = readSchedulerRow<Row>(this.store, SCHEDULER_RECEIPT, priorReceiptId);
      const requestDigest = digest({ handle, outcome, operationId });
      if (priorReceipt) {
        if (priorReceipt.request_digest !== requestDigest ||
            priorReceipt.owner_authority_id !== a.status.owner_authority_id ||
            priorReceipt.policy_version !== a.status.policy_version ||
            priorReceipt.terms_digest !== a.status.terms_digest_binding ||
            !a.status.effective) invalid("stale/conflicting settlement replay");
        return;
      }
      const { q, lease } = this.currentLease(handle);
      const { f, active } = this.activeRoster();
      if (!active.includes(handle.objective_id)) invalid("settled lease absent from roster");
      const continuation = outcomeContinuation(outcome);
      const receiptId = `settle:${handle.objective_id}:${lease.fence}:${operationId}`;
      writeSchedulerRow(this.store, SCHEDULER_RECEIPT, receiptId, {
        objective_id: handle.objective_id, operation: "SETTLE", operation_id: operationId,
        outcome, fence: lease.fence, claimed_generation: lease.claimed_generation,
        checkpoint_digest: lease.checkpoint_digest, next_due: continuation.next_due,
        owner_authority_id: lease.owner_authority_id, policy_version: lease.policy_version,
        terms_digest: lease.terms_digest, request_digest: requestDigest,
      }, "SETTLE_RECEIPT", operationId);
      writeSchedulerRow(this.store, LEASE_STATE, handle.objective_id, {
        ...fields(lease), state: "SETTLED", token_hash: null, expires_at: null,
      }, "SETTLE", operationId);
      // no-progress decay: a timed re-arm that leaves nothing new pending
      // is a poll that proved empty — consecutive ones back off (bounded),
      // so a permanently-unactionable Objective cannot spin the journal at
      // its base cadence forever. Real pending work resets the streak.
      const timedWait = continuation.state === "WAITING_EVIDENCE" && continuation.next_due !== null;
      const leavesPending = q.pending_generation > lease.claimed_generation;
      const streak = timedWait && !leavesPending ? Number(q.wait_streak ?? 0) : 0;
      const backoff = Math.min(2 ** streak, 12);
      writeSchedulerRow(this.store, WAKE_STATE, handle.objective_id, {
        ...fields(q), settled_generation: Math.max(q.settled_generation, lease.claimed_generation),
        queue_state: leavesPending ? "WAITING_CONSUMER" : continuation.state,
        wait_kind: continuation.wait_kind,
        // R1-F1: pending work left behind is already actionable — a stale
        // wait deadline must not hold it back
        next_due: leavesPending ? null : (continuation.next_due === null
          ? null : this.instant() + continuation.next_due * backoff),
        wait_streak: timedWait && !leavesPending ? streak + 1 : 0,
        blocked_reason: continuation.blocked_reason,
      }, "SETTLED_GENERATION", operationId);
      writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
        ...fields(f), active_leases: active.filter(id => id !== handle.objective_id),
      }, "RELEASE_CAPACITY", operationId);
    });
  }

  release(handle: LeaseHandle, operationId: string): void {
    this.proof(() => {
      if (!operationId || operationId.length > 128) invalid("invalid release id");
      const { q, lease } = this.currentLease(handle);
      const { f, active } = this.activeRoster();
      if (!active.includes(handle.objective_id)) invalid("released lease absent from roster");
      writeSchedulerRow(this.store, SCHEDULER_RECEIPT,
        `release:${handle.objective_id}:${handle.fence}:${operationId}`, {
          objective_id: handle.objective_id, operation: "RELEASE", operation_id: operationId,
          request_digest: digest({ handle, operationId }), fence: lease.fence,
          claimed_generation: lease.claimed_generation, checkpoint_digest: lease.checkpoint_digest,
        }, "RELEASE_RECEIPT", operationId);
      writeSchedulerRow(this.store, LEASE_STATE, handle.objective_id, {
        ...fields(lease), state: "RELEASED", fence: lease.fence + 1,
        token_hash: null, expires_at: null,
      }, "RELEASE", operationId);
      writeSchedulerRow(this.store, WAKE_STATE, handle.objective_id, {
        ...fields(q), next_due: this.instant() + [30_000, 120_000, 600_000][Math.min(q.retry_count, 2)]!,
      }, "BACKOFF", operationId);
      writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
        ...fields(f), active_leases: active.filter(id => id !== handle.objective_id),
      }, "RELEASE_CAPACITY", operationId);
    });
  }

  /** Deterministic rank order is chosen before claim; claim itself always
   * re-proves under the writer lock. No process-local queue decides order. */
  nextFairCandidate(): string | null {
    // P18-C F1 — same own-transaction index advance as claim(): the
    // per-candidate gate below then costs O(degree) per usable row
    // instead of O(global table) per scan.
    this.store.immediate(() => this.relations.ensureIndex());
    return this.proof(() => {
      const f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
      if (!f) return null;
      const last = Number(f.last_visited_rank);
      const upper = Number(f.cohort_high_rank);
      const now = this.instant();
      // P18-C — one roster snapshot for the whole scan: CONFLICTS
      // gates judge against the leases live at selection time (the
      // winning candidate's own claim() still re-proves under the
      // writer lock, so a race can't mint two conflicting leases).
      // activeRoster also reaps stale entries here — an expired
      // partner lease must not hold a conflict closed forever.
      const { active: activeLeases } = this.activeRoster();
      // R2-F1: push the field-level usability predicate (and the active-
      // lease exclusion) into the uncharged SQL filter, so the WHOLE
      // remaining cohort is proven empty in a bounded query instead of
      // one charged queue()/lease() pair per row — an unchanged cohort of
      // ANY size then converges to durable idle silence instead of
      // alternating cursor-progress/FAIR_ROUND commits past the proof
      // budget. The per-row re-proof below still runs on every shortlisted
      // row, and claim() re-proves under the writer lock.
      // R4-F2: durably faulted candidates are excluded by entity key — a
      // corrupted row's unverified payload can never move the cursor, and
      // the same corrupted page is never rescanned, so a healthy candidate
      // ranked after a full page of corrupt rows still gets reached
      const excluded = this.faultedSet(f);
      // R5-F1 — charged-read headroom gate: fault() confirmation is the
      // most expensive per-row work (~10 charged reads), so stop when the
      // budget can no longer cover another one plus the call's tail writes.
      // Already-recorded exclusions commit with the transaction — the next
      // call resumes past them instead of losing everything to a rollback.
      const budgetLow = () => {
        const r = this.store.readBudgetRemaining();
        return !!r && (r.events <= FAULT_HEADROOM || r.entities <= FAULT_HEADROOM);
      };
      let stoppedOnBudget = false;
      let furthest = last;
      let exhausted = false;
      for (let pages = 0; pages < SCAN_PAGES && !exhausted && !stoppedOnBudget; pages++) {
        const skip = [...excluded];
        const candidates = this.store.db.prepare(`SELECT entity_id,
            CAST(json_extract(payload,'$.registration_rank') AS INTEGER) AS rank
          FROM entities e
          WHERE e.entity_type=?
            AND CAST(json_extract(e.payload,'$.registration_rank') AS INTEGER)>?
            AND CAST(json_extract(e.payload,'$.registration_rank') AS INTEGER)<=?
            AND json_extract(e.payload,'$.queue_state')='WAITING_CONSUMER'
            AND (CAST(json_extract(e.payload,'$.pending_generation') AS INTEGER)
                 > CAST(json_extract(e.payload,'$.claimed_generation') AS INTEGER)
              OR CAST(json_extract(e.payload,'$.claimed_generation') AS INTEGER)
                 > CAST(json_extract(e.payload,'$.settled_generation') AS INTEGER))
            AND (json_extract(e.payload,'$.next_due') IS NULL
                 OR CAST(json_extract(e.payload,'$.next_due') AS INTEGER)<=?)
            AND NOT EXISTS (SELECT 1 FROM entities l
              WHERE l.entity_type=? AND l.entity_id=e.entity_id
                AND json_extract(l.payload,'$.state')='ACTIVE'
                AND CAST(json_extract(l.payload,'$.expires_at') AS INTEGER)>?)
            ${skip.length ? `AND e.entity_id NOT IN (${skip.map(() => "?").join(",")})` : ""}
          ORDER BY rank, e.entity_id LIMIT ?`)
          .all(WAKE_STATE, furthest, upper, now, LEASE_STATE, now,
            ...skip, PAGE) as Array<{ entity_id: string; rank: number }>;
        if (!candidates.length) { exhausted = true; break; }
        for (const item of candidates) {
          // R3-F1: a shortlisted row whose re-proof throws is corrupted
          // protected state — record durable fault evidence and skip it
          // instead of aborting the scan or silently hiding it
          let q: Queue | null;
          try {
            q = this.queue(item.entity_id);
          } catch (err) {
            if (err instanceof IntegrityError) {
              // R5-F1: proof-budget exhaustion is transient work pressure —
              // never recorded as corruption
              if (err.code === PROOF_LIMIT || budgetLow()) {
                stoppedOnBudget = true; break;
              }
              this.fault(WAKE_STATE, item.entity_id, err);
              excluded.add(item.entity_id);
              continue;
            }
            throw err;
          }
          if (!q) invalid("candidate disappeared");
          furthest = q.registration_rank;
          let lease: Lease | null;
          try {
            lease = this.lease(item.entity_id);
          } catch (err) {
            if (err instanceof IntegrityError) {
              if (err.code === PROOF_LIMIT || budgetLow()) {
                stoppedOnBudget = true; break;
              }
              this.fault(LEASE_STATE, item.entity_id, err);
              excluded.add(item.entity_id);
              continue;
            }
            throw err;
          }
          const activeLease = lease?.state === "ACTIVE" && Number(lease.expires_at) > now;
          const usable = q.queue_state === "WAITING_CONSUMER" && !activeLease &&
            (q.pending_generation > q.claimed_generation ||
             q.claimed_generation > q.settled_generation) &&
            (q.next_due === null || q.next_due <= now);
          if (usable) {
            // P18-C — a relation-gated candidate is skipped transiently
            // (furthest already advanced past it; it re-enters next
            // rotation when its upstream completes or the edge is
            // revoked). Corrupt relations propagate — an admission
            // authority never scans on an unprovable graph.
            if (this.relationGate(item.entity_id, activeLeases) !== null) {
              continue;
            }
            // the claim decision is the visit that must be journaled — it
            // records where the deterministic rotation stopped. The row is
            // re-read because fault() may have updated faulted_ids mid-scan
            const fr = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL) ?? f;
            writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
              ...fields(fr), last_visited_rank: furthest,
            }, "FAIR_VISIT", item.entity_id);
            return item.entity_id;
          }
        }
        exhausted = candidates.length < PAGE;
      }
      if (!exhausted) {
        // scan bound reached mid-cohort: one durable cursor move per call
        // so the next call continues instead of rescanning
        if (furthest > last) {
          const fr = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL) ?? f;
          writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
            ...fields(fr), last_visited_rank: furthest,
          }, "FAIR_VISIT", String(furthest));
        }
        return null;
      }
      // R3-F1: before an idle sweep goes silent, prove the quiet is real —
      // rows the SQL filter excluded must still face ledger+hash
      // verification on a bounded cadence, with durable fault evidence.
      // R5-F1: the sweep is coverage work — if the candidate scan already
      // consumed most of the budget, defer it to a later idle call rather
      // than trip the proof limit inside the same transaction.
      const remaining = this.store.readBudgetRemaining();
      if (!remaining || (remaining.events > SWEEP_HEADROOM &&
          remaining.entities > SWEEP_HEADROOM)) {
        this.integritySweep();
      }
      const counter = Number(f.registration_counter);
      if (last > 0 || upper < counter) {
        // cohort wrap/bound refresh commits; a no-change sweep over a
        // parked cursor journals nothing — rescanning an unchanged
        // cohort is deterministic, so the receipt carried no decision
        const fr = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL) ?? f;
        writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
          ...fields(fr), round: Number(fr.round) + 1,
          cohort_high_rank: counter, last_visited_rank: 0,
        }, "FAIR_ROUND", String(fr.round));
      }
      return null;
    });
  }

  /** R3-F1 — durable fault evidence, dedup'd per protected row. The
   *  receipt itself is a hash-chained scheduler row, so a detected
   *  corruption leaves canonical evidence even though the corrupted row
   *  can never be written again (its own commit ledger already diverged).
   */
  private fault(entityType: string, entityId: string, err: unknown): void {
    const rid = `integrity_fault:${entityType}:${entityId}`;
    if (!readSchedulerRow<Row>(this.store, SCHEDULER_RECEIPT, rid)) {
      writeSchedulerRow(this.store, SCHEDULER_RECEIPT, rid, {
        objective_id: entityId, operation: "INTEGRITY_FAULT",
        entity_type: entityType, fault: sanitizeFaultReason(err),
        detected_at_ms: this.instant(),
      }, "INTEGRITY_FAULT", `${entityType}:${entityId}`);
    }
    // R4-F2 — durable exclusion by entity key (never the unverified
    // payload). A corrupted protected row can never be repaired through
    // writeSchedulerRow — its commit ledger already diverged — so the
    // candidate drops out of the shortlist permanently: traversal keeps
    // advancing and the same corrupted page is never rescanned.
    const f = readSchedulerRow<Row>(this.store, FAIRNESS_STATE, GLOBAL);
    if (!f) return;
    const ids = this.faultedSet(f);
    if (ids.has(entityId)) return;
    if (ids.size >= FAULTED_CAP) invalid("faulted candidate cap reached");
    writeSchedulerRow(this.store, FAIRNESS_STATE, GLOBAL, {
      ...fields(f), faulted_ids: [...ids, entityId],
    }, "FAULT_EXCLUDE", `faulted:${entityId}`);
  }

  /** Durable exclusion list carried on the fairness row — entity keys of
   *  candidates proven unverifiable. Validated like active_leases: any
   *  malformed shape is itself corruption and halts fail-closed. */
  private faultedSet(f: Row): Set<string> {
    const ids = f.faulted_ids;
    if (ids === undefined) return new Set();
    if (!Array.isArray(ids) || ids.length > FAULTED_CAP ||
        ids.some(x => typeof x !== "string" || !x.length) ||
        new Set(ids).size !== ids.length) invalid("faulted candidate roster corrupt");
    return new Set(ids as string[]);
  }

  /** R3-F1 — run the full protected-row verification on one row and
   *  convert a proven failure into a durable fault receipt. */
  private faultIfUnverifiable(entityType: string, entityId: string): void {
    try {
      if (!readSchedulerRow<Row>(this.store, entityType, entityId)) {
        this.fault(entityType, entityId, "protected row unreadable");
      }
    } catch (err) {
      if (err instanceof IntegrityError) {
        this.fault(entityType, entityId, err);
        return;
      }
      throw err;
    }
  }

  /** R3-F1 — bounded amortized integrity verification for rows the SQL
   *  candidate filter never touches. Two tiers, both journal-free when
   *  clean so idle convergence (R1-F2/R2-F1) is preserved:
   *   tier 1: one uncharged aggregate compares each protected row's entity
   *           version with its scheduler-commit ledger (count/revision) —
   *           a canonical write that bypassed writeSchedulerRow keeps a
   *           valid entity hash but provably diverges here, whole-cohort
   *           every idle call.
   *   tier 2: a rotating slice gets the charged readSchedulerRow re-proof
   *           (payload hash + commit chain), catching raw payload drift
   *           the ledger alone cannot see — coverage bound is
   *           ceil(protected_rows / INTEGRITY_QUOTA) idle calls.
   *  Suspects are confirmed via the charged path and journaled once per
   *  row; nothing is written while the cohort verifies clean. */
  private integritySweep(): void {
    const COMMIT = "OBJECTIVE_AUTO_SCHEDULER_COMMIT";
    // R4-F1 — the canonical commit contract is revisions 1..version with
    // count == version and last == version (writeSchedulerRow stamps
    // revision = stored entity version; readSchedulerRow re-proves the
    // same shape). The screen mirrors that exactly, and rows already
    // carrying a fault receipt are excluded so persistent suspects can
    // never re-consume the per-call confirmation quota.
    const screen = this.store.db.prepare(`SELECT e.entity_type AS t,
        e.entity_id AS id, e.version AS v,
        (SELECT COUNT(*) FROM events ev WHERE ev.entity_type=e.entity_type
          AND ev.entity_id=e.entity_id AND ev.event_type=?) AS commits,
        (SELECT MIN(CAST(json_extract(ev2.metadata_json,'$.revision') AS INTEGER))
          FROM events ev2 WHERE ev2.entity_type=e.entity_type
          AND ev2.entity_id=e.entity_id AND ev2.event_type=?) AS first_rev,
        (SELECT MAX(CAST(json_extract(ev3.metadata_json,'$.revision') AS INTEGER))
          FROM events ev3 WHERE ev3.entity_type=e.entity_type
          AND ev3.entity_id=e.entity_id AND ev3.event_type=?) AS last_rev,
        (SELECT COALESCE(SUM(CASE WHEN
              json_type(ev4.metadata_json,'$.revision')='integer'
              AND CAST(json_extract(ev4.metadata_json,'$.revision') AS INTEGER)>0
              THEN 0 ELSE 1 END),0)
          FROM events ev4 WHERE ev4.entity_type=e.entity_type
          AND ev4.entity_id=e.entity_id AND ev4.event_type=?) AS bad_rev
      FROM entities e WHERE e.entity_type IN (?, ?)
        AND NOT EXISTS (SELECT 1 FROM entities r WHERE r.entity_type=?
          AND r.entity_id=('integrity_fault:'||e.entity_type||':'||e.entity_id))`)
      .all(COMMIT, COMMIT, COMMIT, COMMIT, WAKE_STATE, LEASE_STATE,
        SCHEDULER_RECEIPT) as Array<{ t: string; id: string; v: number;
        commits: number; first_rev: number | null; last_rev: number | null;
        bad_rev: number }>;
    let confirmed = 0;
    for (const s of screen) {
      if (s.v >= 1 && s.commits === s.v && s.first_rev === 1 &&
          s.last_rev === s.v && s.bad_rev === 0) continue; // valid ledger
      if (confirmed >= INTEGRITY_QUOTA) break;
      confirmed++;
      this.faultIfUnverifiable(s.t, s.id);
    }
    // tier 2 keeps its own full quota — persistent tier-1 suspects can
    // never starve the rotating deep verification of later rows
    const at = this.integrityAfter;
    let slice = this.store.db.prepare(`SELECT entity_type AS t, entity_id AS id
        FROM entities WHERE entity_type IN (?, ?)
          AND (entity_type>? OR (entity_type=? AND entity_id>?))
        ORDER BY entity_type, entity_id LIMIT ?`)
      .all(WAKE_STATE, LEASE_STATE, at?.t ?? "", at?.t ?? "", at?.id ?? "",
        INTEGRITY_QUOTA) as Array<{ t: string; id: string }>;
    if (!slice.length) {
      slice = this.store.db.prepare(`SELECT entity_type AS t, entity_id AS id
          FROM entities WHERE entity_type IN (?, ?)
          ORDER BY entity_type, entity_id LIMIT ?`)
        .all(WAKE_STATE, LEASE_STATE, INTEGRITY_QUOTA) as
        Array<{ t: string; id: string }>;
      this.integrityAfter = null;
    } else {
      this.integrityAfter = slice[slice.length - 1]!;
    }
    for (const r of slice) this.faultIfUnverifiable(r.t, r.id);
  }
}

type Continuation = { state: string; wait_kind: string | null;
  next_due: number | null; blocked_reason: string | null };

export function outcomeContinuation(outcome: OperatingOutcome): Continuation {
  const wait = (kind: string, due: number | null = null): Continuation =>
    ({ state: "WAITING_EVIDENCE", wait_kind: kind, next_due: due, blocked_reason: null });
  const block = (reason: string): Continuation =>
    ({ state: "BLOCKED_AUTHORITY", wait_kind: null, next_due: null, blocked_reason: reason });
  switch (outcome) {
    case "DISPATCHED": return wait("MISSION_LIFECYCLE");
    case "AWAITING_EXECUTION": return wait("EXECUTION_EVIDENCE");
    case "REVIEW_REQUIRED": return wait("HUMAN_REVIEW");
    case "WAITING_FOR_CEO": return wait("CEO_INPUT", 300_000);
    case "WAITING": return wait("NEXT_DUE", 300_000);
    case "TARGET_MET_CANDIDATE": return block("OWNER_SIGN_OFF_REQUIRED");
    case "TOPOLOGY_CHANGE_REQUIRED": return block("OWNER_TOPOLOGY_REVISION_REQUIRED");
    case "INSUFFICIENT_VERIFIED_PROGRESS": return wait("VERIFIED_KPI_EVIDENCE");
    case "OBJECTIVE_BUDGET_EXHAUSTED": return block("BUDGET_OWNER_ACTION_REQUIRED");
    // P0-F3 — zero ceiling is a hard bound: same owner-action block as
    // exhaustion (owner must provision budget), never silently continues.
    case "OBJECTIVE_ZERO_BUDGET": return block("BUDGET_OWNER_ACTION_REQUIRED");
    case "NO_ELIGIBLE_AGENT": return wait("CANONICAL_WORKFORCE_CAPACITY", 60_000);
    case "DEPENDENCY_BLOCKED": return wait("CANONICAL_DEPENDENCY");
    case "OBJECTIVE_NOT_ACTIVE": return block("OBJECTIVE_LIFECYCLE_INACTIVE");
    default: return invalid(`unknown operating outcome: ${String(outcome)}`);
  }
}
