/**
 * P15.5 — KPI REVIEW + ADAPTIVE STRATEGY REVISION.
 *
 * Answers: "Given VERIFIED Objective progress and canonical workforce
 * results, what should the CEO do next with the EXISTING workstreams?"
 *
 * Deterministic review checkpoint → optional reuse of the EXISTING
 * P15.3 CEO planning cycle → one immutable review receipt → optional
 * adaptive strategy revision (priority re-ordering authority for P15.6,
 * NEVER a graph mutation).
 *
 * Authority rules this module enforces:
 *  - P15.2 binding stays immutable; P14 stays the ONLY work graph.
 *    No ADD/REMOVE/CANCEL workstream, no replacement WDEC, no second
 *    graph — when the topology is exhausted the outcome is the typed
 *    recommendation TOPOLOGY_CHANGE_REQUIRED.
 *  - KPI `current` is strategic authority only when strictly proven
 *    through the P15.1 progress evidence chain (ledger digest +
 *    PROGRESS evidence ref + OBJECTIVE_PROGRESS event ordering).
 *    A direct field write or a rollback to an older measurement fails
 *    closed.
 *  - The CEO remains proposal-only and consumed through the existing
 *    P15.3 runCycle — never a second model path. P15.5 accepts only
 *    PRIORITIZE_EXISTING / WAIT; anything else fails closed.
 *  - Zero execution: no allocation, no delegation, no mission, no
 *    router, no executor, no budget spend, no Telegram, no scheduler.
 *
 * Deterministic only — no LLM in the review layer; the only model
 * interaction is the reused P15.3 cycle.
 */

import { canonicalJson, digest, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { BusinessLayer } from "./business.js";
import { TERMINAL_MISSION_STATUSES } from "./business.js";
import {
  assertCanonicalMissionLifecycle,
  canonicalBoundAttemptsForWorkItem,
  WORK_REVIEW_ACCEPTED_EVENT,
} from "./work-completion.js";
import type { PairEvidenceStore } from "./store.js";
import type { ObjectiveAuthorityService, ObjectiveKpi } from "./objective-authority.js";
import {
  OBJECTIVE_ENTITY,
  progressSemantics,
  spendSemantics,
} from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import { objectiveWorkstreamBindingDigest } from "./objective-workstream.js";
import type { WorkforceService } from "./work-graph.js";
import type { CeoPlanningCycleService, CeoObservationDeps } from "./ceo-planning-cycle.js";
import {
  assertCanonicalCeoDecision,
  ceoDecisionDigest,
} from "./ceo-planning-cycle.js";
import {
  assertCanonicalWorkforceAllocation,
  workforceAllocationId,
  WORKFORCE_ALLOCATION_ENTITY,
  type WorkforceAllocationDeps,
} from "./workforce-allocation.js";
import { createDefaultCeoPlanningCycle } from "./ceo-runtime.js";
import type { CeoDecisionInvoker } from "./ceo-decision.js";

type Row = Record<string, unknown> & { version: number };

export const OBJECTIVE_ADAPTIVE_REVIEW_ENTITY = "objective_adaptive_review";
export const OBJECTIVE_ADAPTIVE_REVIEW_SCHEMA = "pair.os.vnext.adaptive-review.v1";
export const OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT =
  "OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED";
export const OBJECTIVE_STRATEGY_REVISION_ENTITY = "objective_strategy_revision";
export const OBJECTIVE_STRATEGY_REVISION_SCHEMA = "pair.os.vnext.strategy-revision.v1";
export const OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT =
  "OBJECTIVE_STRATEGY_REVISION_COMMITTED";
/** Bounded revision chain per Objective — never unbounded history. */
export const STRATEGY_REVISION_MAX_PER_OBJECTIVE = 32;
/** Serialized review-observation bound (UTF-8 bytes). Strategic state is
 *  never truncated to fit — oversized means fail closed. */
export const REVIEW_OBSERVATION_MAX_BYTES = 64 * 1024;

export const REVIEW_OUTCOMES = [
  "AWAITING_PROGRESS",
  "TARGET_MET_CANDIDATE",
  "TOPOLOGY_CHANGE_REQUIRED",
  "INSUFFICIENT_VERIFIED_PROGRESS",
  "PRIORITIZE_EXISTING",
  "WAIT",
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** KPI assessment vocabulary — deterministic, no fuzzy tolerance. */
export const KPI_ASSESSMENTS = ["MET", "GAP", "UNVERIFIED"] as const;
export type KpiAssessment = (typeof KPI_ASSESSMENTS)[number];

/** Shared read-only KPI assessment (P15.5/P15.6 §6): exact same
 *  deterministic semantics — UNVERIFIED when no canonically-proven
 *  current, else direction comparison against target. The caller must
 *  prove `current` canonical BEFORE calling (assertCanonicalObjectiveKpiProgress). */
export function objectiveKpiAssessment(k: ObjectiveKpi): KpiAssessment {
  const current = k.current === null || k.current === undefined ? null : Number(k.current);
  if (current === null) return "UNVERIFIED";
  switch (String(k.direction)) {
    case "AT_LEAST": return current >= Number(k.target) ? "MET" : "GAP";
    case "AT_MOST": return current <= Number(k.target) ? "MET" : "GAP";
    case "EXACT": return current === Number(k.target) ? "MET" : "GAP";
    default: reviewFail(`kpi ${k.kpi_id}: unknown direction ${String(k.direction)}`);
  }
}

function reviewFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW", detail);
}

export interface ObjectiveAdaptiveReviewDeps {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
  /** The ONE existing P15.3 CEO cycle — P15.5 never owns a model path. */
  ceoCycle: CeoPlanningCycleService;
}

// ---------------------------------------------------------------------
// §4 — STRICT KPI PROGRESS PROOF
// ---------------------------------------------------------------------

/** Re-prove that the CURRENT KPI projection on a strict-read Objective
 *  row is canonical authority, not a mutable mirror. For each KPI:
 *
 *  - current === null → canonical no-progress state: no
 *    last_evidence_key, no PROGRESS evidence ref, no
 *    OBJECTIVE_PROGRESS event for this kpi.
 *  - current !== null → last_evidence_key exists AND binds a
 *    PROGRESS evidence_refs entry AND a ledger entry whose digest is
 *    the exact P15.1 progress semantics (objective+kpi+value+key+
 *    verifier+source) AND an OBJECTIVE_PROGRESS event exists whose
 *    LATEST entry for this kpi pins the same key/value/verifier.
 *
 *  A direct `current = X` rewrite, a forged evidence ref, or a rollback
 *  to an older valid measurement while newer progress exists all fail
 *  closed. Owner-verifier semantics are preserved: the PROGRESS
 *  verifier must be the Objective's owner_authority_id. */
export function assertCanonicalObjectiveKpiProgress(
  store: PairEvidenceStore,
  objective: Row,
): void {
  const objectiveId = String(objective.objective_id);
  const kpis = objective.kpis as ObjectiveKpi[];
  const evidenceRefs = (objective.evidence_refs ?? []) as Array<Record<string, unknown>>;
  const ledger = (objective.applied_evidence_keys ?? []) as Array<Record<string, unknown>>;
  // listEvents recomputes every event_hash — a tampered event fails at
  // read before any of the checks below.
  const progressEvents = (store.listEvents(OBJECTIVE_ENTITY, objectiveId))
    .filter((e) => String(e.event_type) === "OBJECTIVE_PROGRESS");

  for (const kpi of kpis) {
    const kpiEvents = progressEvents.filter(
      (e) => String((e.metadata as Record<string, unknown> | null)?.kpi_id ?? "") ===
        String(kpi.kpi_id));
    if (kpi.current === null || kpi.current === undefined) {
      // Canonical no-progress state — anything else is corrupt
      // authority claiming progress that never happened.
      if (kpi.last_evidence_key !== null && kpi.last_evidence_key !== undefined &&
          String(kpi.last_evidence_key) !== "") {
        reviewFail(`kpi ${kpi.kpi_id}: null current but last_evidence_key set`);
      }
      if (evidenceRefs.some((e) =>
          String(e.kind) === "PROGRESS" && String(e.kpi_id) === String(kpi.kpi_id))) {
        reviewFail(`kpi ${kpi.kpi_id}: null current but PROGRESS evidence exists`);
      }
      if (kpiEvents.length > 0) {
        reviewFail(`kpi ${kpi.kpi_id}: null current but OBJECTIVE_PROGRESS events exist`);
      }
      continue;
    }
    const current = Number(kpi.current);
    if (!Number.isFinite(current)) {
      reviewFail(`kpi ${kpi.kpi_id}: current non-finite`);
    }
    const lek = String(kpi.last_evidence_key ?? "");
    if (!lek) {
      reviewFail(`kpi ${kpi.kpi_id}: current set without last_evidence_key`);
    }
    // The evidence ref must exist, be PROGRESS for THIS kpi, and carry
    // the verifier+source the ledger digest binds.
    const evRef = evidenceRefs.find((e) =>
      String(e.kind) === "PROGRESS" &&
      String(e.kpi_id) === String(kpi.kpi_id) &&
      String(e.evidence_key) === lek);
    if (!evRef) {
      reviewFail(`kpi ${kpi.kpi_id}: last_evidence_key ${lek} has no PROGRESS ref`);
    }
    // P15.1 owner-verifier semantics — the only canonical verifier is
    // the owner-authorized operator. Never weaken this.
    if (String(evRef.verifier) !== String(objective.owner_authority_id)) {
      reviewFail(`kpi ${kpi.kpi_id}: progress verifier is not the owner authority`);
    }
    const ledgerEntry = ledger.find((e) => String(e.key) === lek);
    if (!ledgerEntry) {
      reviewFail(`kpi ${kpi.kpi_id}: last_evidence_key ${lek} absent from ledger`);
    }
    const expectedSem = progressSemantics(objectiveId, {
      kpi_id: String(kpi.kpi_id),
      value: current,
      evidence: {
        evidence_key: lek,
        verifier: String(evRef.verifier),
        source: String(evRef.source),
      },
    });
    if (String(ledgerEntry.digest) !== expectedSem) {
      reviewFail(`kpi ${kpi.kpi_id}: ledger digest mismatch for ${lek}`);
    }
    // The CURRENT projection must correspond to the LATEST canonical
    // progress authority — the newest OBJECTIVE_PROGRESS event for this
    // kpi must agree with the claimed key/value/verifier. A rollback to
    // an older valid measurement fails this check.
    if (kpiEvents.length === 0) {
      reviewFail(`kpi ${kpi.kpi_id}: current set without OBJECTIVE_PROGRESS events`);
    }
    const latest = kpiEvents[kpiEvents.length - 1]!;
    const md = latest.metadata as Record<string, unknown> | null;
    if (!md || String(md.evidence_key ?? "") !== lek ||
        Number(md.value) !== current ||
        String(md.verifier ?? "") !== String(evRef.verifier)) {
      reviewFail(`kpi ${kpi.kpi_id}: current does not match latest canonical progress event`);
    }
  }
}

// ---------------------------------------------------------------------
// §B — STRICT BUDGET RUNTIME AUTHORITY
// ---------------------------------------------------------------------

/** Re-prove that `budget.consumed_microusd` on a strict-read Objective is
 *  canonical runtime authority, not a mutable field claim. The strict
 *  read already bounds the field; this binds it to the immutable spend
 *  evidence chain:
 *
 *  - every OBJECTIVE_BUDGET_ACCOUNTED event pins {spend_key, integer
 *    amount_microusd, consumed_microusd} where consumed equals the
 *    running cumulative sum in event order;
 *  - spend_key identity is unique across the event chain;
 *  - the applied_spend_keys ledger mirrors the event chain exactly
 *    (no missing spend, no extra key);
 *  - each ledger digest recomputes the exact P15.1 spend semantics
 *    (objective+key+amount+note). A spend recorded with a note is
 *    unprovable from persisted evidence — fail closed, never trust it;
 *  - the cumulative sum equals the current consumed_microusd.
 *
 *  Anything inconsistent fails closed — a payload-consistent rewrite of
 *  consumed_microusd cannot affect P15.5/CEO reasoning. */
export function assertCanonicalObjectiveBudget(
  store: PairEvidenceStore,
  objective: Row,
): void {
  const oid = String(objective.objective_id);
  const budget = objective.budget as Record<string, unknown> | undefined;
  if (!budget ||
      !Number.isInteger(budget.ceiling_microusd) ||
      !Number.isInteger(budget.consumed_microusd) ||
      Number(budget.ceiling_microusd) < 0 ||
      Number(budget.consumed_microusd) < 0 ||
      Number(budget.consumed_microusd) > Number(budget.ceiling_microusd)) {
    reviewFail(`objective ${oid}: budget shape/ceiling invalid`);
  }
  const rawLedger = objective.applied_spend_keys;
  const ledger: Array<{ key: string; digest: string }> = [];
  if (rawLedger !== undefined && rawLedger !== null) {
    if (!Array.isArray(rawLedger)) {
      reviewFail(`objective ${oid}: applied_spend_keys malformed`);
    }
    for (const e of rawLedger as Array<Record<string, unknown>>) {
      if (typeof e !== "object" || e === null ||
          typeof e.key !== "string" || e.key === "" ||
          typeof e.digest !== "string" || e.digest === "") {
        reviewFail(`objective ${oid}: applied_spend_keys entry malformed`);
      }
      ledger.push({ key: e.key, digest: e.digest });
    }
  }
  const events = deps_listAccounted(store, oid);
  // Every spend_key is unique and cumulative consumed is monotone
  // consistent through the immutable event chain.
  const byKey = new Map<string, { amount: number; consumed: number }>();
  let running = 0;
  for (const e of events) {
    const md = e.metadata as Record<string, unknown> | null;
    if (!md || typeof md.spend_key !== "string" || md.spend_key === "" ||
        !Number.isInteger(md.amount_microusd) ||
        Number(md.amount_microusd) < 0 ||
        !Number.isInteger(md.consumed_microusd)) {
      reviewFail(`objective ${oid}: malformed spend event authority`);
    }
    const key = String(md.spend_key);
    if (byKey.has(key)) {
      reviewFail(`objective ${oid}: duplicate spend_key authority ${key}`);
    }
    running += Number(md.amount_microusd);
    if (Number(md.consumed_microusd) !== running) {
      reviewFail(
        `objective ${oid}: spend event cumulative mismatch at ${key}`);
    }
    byKey.set(key, { amount: Number(md.amount_microusd), consumed: running });
  }
  if (running !== Number(budget.consumed_microusd)) {
    reviewFail(
      `objective ${oid}: consumed=${String(budget.consumed_microusd)} ` +
      `but canonical spend chain totals ${running}`);
  }
  // The ledger must mirror the event chain exactly — no missing spend
  // authority, no extra keys.
  if (ledger.length !== events.length) {
    reviewFail(`objective ${oid}: spend ledger/event count mismatch`);
  }
  for (const entry of ledger) {
    const e = byKey.get(entry.key);
    if (!e) {
      reviewFail(`objective ${oid}: ledger key ${entry.key} has no spend event`);
    }
    const expected = spendSemantics(oid, {
      spend_key: entry.key,
      amount_microusd: e!.amount,
      // A note is not part of persisted event evidence — a spend that
      // used one cannot be re-proven here and fails closed.
      note: undefined,
    });
    if (entry.digest !== expected) {
      reviewFail(`objective ${oid}: spend digest mismatch for ${entry.key}`);
    }
  }
}

function deps_listAccounted(store: PairEvidenceStore, oid: string) {
  // listEvents already orders by the immutable seq column.
  return store.listEvents(OBJECTIVE_ENTITY, oid)
    .filter((e) => String(e.event_type) === "OBJECTIVE_BUDGET_ACCOUNTED");
}

// ---------------------------------------------------------------------
// §12 — REVIEW OBSERVATION
// ---------------------------------------------------------------------

export interface ReviewWorkstreamProjection {
  workstream_key: string;
  work_item_id: string;
  workstream_status: string;
  completion_proven: boolean;
  allocation_state: "NONE" | "ALLOCATED";
  selected_agent_id: string | null;
  delegated_child_work_item_id: string | null;
  delegated_child_status: string | null;
  delegated_child_completion_proven: boolean;
  /** Canonical open/binding lineage exists for the delegated child
   *  (boundMissionForWorkItem non-null) — never status text. */
  delegated_child_bound_mission: boolean;
  /** R3.A — canonical lifecycle class of the delegated child: ACTIVE
   *  (genuine in-flight / review-pending), INTERVENTION (canonically
   *  BLOCKED, PAUSED-bound or terminal-mission fold pending),
   *  EXHAUSTED (DONE+WCP / CANCELLED). */
  delegated_child_class: LifecycleClass | null;
}

/** Work-item lifecycle classification used strategically by the
 *  review — ACTIVE = legitimate in-flight/review-pending work;
 *  INTERVENTION = canonical non-active state needing intervention
 *  (BLOCKED, PAUSED mission, terminal-mission fold pending);
 *  EXHAUSTED = canonically finished (DONE+WCP or CANCELLED). */
type LifecycleClass = "ACTIVE" | "INTERVENTION" | "EXHAUSTED";

/** Status-defining lifecycle events on a work_item — every canonical
 *  status writer emits one. Replaying them is the ONLY honest read of
 *  the projected status: a row whose claim diverges is a raw rewrite. */
const WORK_ITEM_STATUS_EVENTS = new Set([
  "WORK_ITEM_CREATED", "WORK_ITEM_ASSIGNED", "WORK_ITEM_OPENED",
  "WORK_ITEM_OPEN_RECONCILED", "WORK_ITEM_OPEN_ROLLED_BACK",
  "WORK_ITEM_SYNCED", "WORK_ITEM_STATUS_SYNCED",
  "WORK_ITEM_BLOCKED", "WORK_ITEM_UNBLOCKED", "WORK_ITEM_CANCELLED",
  WORK_REVIEW_ACCEPTED_EVENT, "WORK_REWORK_REQUESTED",
]);

/** The status the immutable lifecycle evidence chain proves — derived
 *  by replay, never by trusting `row.status`. */
function canonicalDerivedWorkStatus(
  store: PairEvidenceStore,
  workItem: Row,
): string {
  let derived: string | null = null;
  for (const e of store.listEvents("work_item", String(workItem.work_item_id))) {
    if (WORK_ITEM_STATUS_EVENTS.has(String(e.event_type)) &&
        e.new_state !== null && e.new_state !== undefined) {
      derived = String(e.new_state);
    }
  }
  // Zero lifecycle evidence: only the mint rule may stand —
  // assigned ⇒ READY, unassigned ⇒ BACKLOG (business.createWorkItem).
  return derived ??
    (workItem.assignee_agent_id ? "READY" : "BACKLOG");
}

/** The work-item's claimed status must equal the derived canonical
 *  state — any raw rewrite (BLOCKED→READY, CANCELLED→READY,
 *  text-only BLOCKED/IN_PROGRESS) fails closed here. */
export function assertCanonicalWorkStatus(
  store: PairEvidenceStore,
  workItem: Row,
): string {
  const derived = canonicalDerivedWorkStatus(store, workItem);
  const claimed = String(workItem.status);
  if (claimed !== derived) {
    reviewFail(
      `work item ${String(workItem.work_item_id)} claims ${claimed} ` +
      `but canonical lifecycle derives ${derived}`);
  }
  return derived;
}

/** The mission's claimed status derived from its own immutable
 *  MISSION_CREATED/MISSION_TRANSITION spine. */
function canonicalDerivedMissionStatus(
  store: PairEvidenceStore,
  mission: Row,
): string {
  let derived = "CREATED";
  for (const e of store.listEvents("mission", String(mission.mission_id))) {
    const t = String(e.event_type);
    if ((t === "MISSION_CREATED" || t === "MISSION_TRANSITION") &&
        e.new_state !== null && e.new_state !== undefined) {
      derived = String(e.new_state);
    }
  }
  return derived;
}

export interface KpiAssessmentProjection {
  kpi_id: string;
  name: string;
  direction: string;
  baseline: number;
  target: number;
  current: number | null;
  assessment: KpiAssessment;
  last_evidence_key: string | null;
}

export interface ReviewObservation {
  schema: string;
  objective_id: string;
  business_id: string;
  objective_version: number;
  objective_terms_version: number;
  objective_digest: string;
  objective_status: string;
  deadline: string | null;
  budget: { ceiling_microusd: number; consumed_microusd: number; currency: string };
  binding_id: string;
  binding_digest: string;
  kpis: KpiAssessmentProjection[];
  all_targets_met: boolean;
  verified_kpi_count: number;
  unverified_kpi_count: number;
  gap_kpi_count: number;
  workstreams: ReviewWorkstreamProjection[];
}
/** R2.B — candidate rows canonical history attributes to
 *  `objectiveId`: rows currently CLAIMING the objective UNION rows an
 *  immutable COMMITTED anchor pins to it. Mutable row attribution can
 *  never hide an anchored row from the strict read — a row whose
 *  objective_id was rewritten away still appears through its anchor
 *  and fails strict validation, never silently disappearing. An anchor
 *  without a row is corrupt authority: fail closed. */
function anchorAttributedCandidates(
  store: PairEvidenceStore,
  entity: string,
  committedEvent: string,
  objectiveId: string,
): Row[] {
  const byId = new Map<string, Row>();
  for (const r of store.list(entity) as Row[]) {
    if (String(r.objective_id ?? "") === objectiveId) {
      byId.set(String(r.entity_id), r);
    }
  }
  for (const e of store.listEvents(entity).filter((x) =>
      String(x.event_type ?? "") === committedEvent &&
      String(
        (x.metadata as Record<string, unknown> | undefined)?.objective_id ?? "",
      ) === objectiveId)) {
    const row = store.tryGet(entity, String(e.entity_id)) as Row | null;
    if (!row) {
      reviewFail(
        `${entity} ${String(e.entity_id)}: committed anchor pins a missing row`);
    }
    byId.set(String(row.entity_id), row);
  }
  return [...byId.values()];
}

/** Every canonical P15.5 review row attributed to `objectiveId`,
 *  strict-validated — the ONLY history a bootstrap decision may trust.
 *  Exported for P15.6 (§8). */
export function canonicalAdaptiveReviewsFor(
  deps: ObjectiveAdaptiveReviewDeps,
  objectiveId: string,
): Row[] {
  const rows = anchorAttributedCandidates(
    deps.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
    OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT, objectiveId);
  for (const r of rows) assertCanonicalAdaptiveReview(deps, r);
  return rows;
}

/** The latest canonical strategy revision for an objective — the chain
 *  head (a revision no other canonical revision names as its
 *  previous). Every attributed row is strict-validated; a malformed
 *  one is corrupt authority and fails closed, never skipped. */
function canonicalStrategyChain(
  deps: ObjectiveAdaptiveReviewDeps,
  objectiveId: string,
): { head: Row | null; all: Row[] } {
  const all = anchorAttributedCandidates(
    deps.store, OBJECTIVE_STRATEGY_REVISION_ENTITY,
    OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT, objectiveId);
  for (const r of all) assertCanonicalStrategyRevision(deps, r);
  if (all.length === 0) return { head: null, all };
  const referencedPrev = new Set(
    all.map((r) => String(r.previous_revision_id ?? "")).filter(Boolean));
  const heads = all.filter((r) => !referencedPrev.has(String(r.strategy_revision_id)));
  if (heads.length !== 1) {
    reviewFail(`objective ${objectiveId}: strategy revision chain has ${heads.length} heads`);
  }
  return { head: heads[0]!, all };
}

function walDeps(deps: ObjectiveAdaptiveReviewDeps): WorkforceAllocationDeps {
  return {
    store: deps.store,
    business: deps.business,
    workforce: deps.workforce,
    objectives: deps.objectives,
    workstreams: deps.workstreams,
  };
}

/** Build the bounded deterministic review observation. Every field is
 *  produced through canonical strict reads/proofs — nothing trusts a
 *  mutable mirror. Throws fail-closed on any corrupt authority. */
export function buildReviewObservation(
  deps: ObjectiveAdaptiveReviewDeps,
  objectiveId: string,
): { observation: ReviewObservation; digest: string } {
  const objective = deps.objectives.get(objectiveId); // strict P15.1 read
  // §4 — strategic KPI authority requires the strict progress proof.
  assertCanonicalObjectiveKpiProgress(deps.store, objective);
  // §R2.B — budget.consumed_microusd enters strategic reasoning only
  // after the canonical spend-accounting chain re-proves it.
  assertCanonicalObjectiveBudget(deps.store, objective);
  const binding = deps.workstreams.getBinding(objectiveId);
  if (!binding) {
    // P15.5 reviews existing workstreams; no binding means there is no
    // canonical plan to adapt — INITIALIZE belongs to plain P15.3.
    throw new IntegrityError(
      "FAIL_CLOSED_P15_5_BINDING_REQUIRED",
      `objective ${objectiveId} has no canonical workstream binding`,
    );
  }
  const bindingDigest = objectiveWorkstreamBindingDigest(binding);
  const wdeps = walDeps(deps);

  const workstreams: ReviewWorkstreamProjection[] = [];
  for (const w of binding.workstreams as Array<Record<string, unknown>>) {
    const wid = String(w.work_item_id);
    const row = deps.store.get("work_item", wid) as Row;
    if (String(row.business_id) !== String(objective.business_id)) {
      reviewFail(`workstream ${wid} foreign to objective business`);
    }
    // §R2.C — a P15.2 workstream container can never carry an open
    // binding of its own (openWorkItem fails closed on containers);
    // a bound attempt on the container is forged authority.
    if (canonicalBoundAttemptsForWorkItem(deps.store, wid).length > 0) {
      reviewFail(`workstream container ${wid} carries bound open attempts`);
    }
    // §R3.A — the claimed status must equal the canonical
    // event-derived lifecycle state BEFORE any strategic use. A raw
    // rewrite of ANY status (BLOCKED→READY, text-only BLOCKED/
    // CANCELLED/IN_PROGRESS) fails closed here.
    const wsStatus = assertCanonicalWorkStatus(deps.store, row);
    const completionProven = deps.business.proveWorkItemDone(row);
    // Status DONE without the canonical completion proof is a
    // contradictory canonical state — the only authority path that
    // mints DONE also mints the WCP. Fail closed rather than reason
    // over tampered state.
    if (wsStatus === "DONE" && !completionProven) {
      reviewFail(
        `workstream ${wid} claims DONE without canonical completion proof`);
    }
    // REVIEW_REQUIRED needs the canonical completion/review basis —
    // mere bound-mission existence is not sufficient grounding.
    if (wsStatus === "REVIEW_REQUIRED") {
      const basis = deps.business.completionBasisProof(row);
      if (!basis.ready || basis.rejected) {
        reviewFail(
          `workstream ${wid} claims REVIEW_REQUIRED without canonical review basis`);
      }
    }
    const walId = workforceAllocationId(objectiveId, wid);
    const wal = deps.store.tryGet(WORKFORCE_ALLOCATION_ENTITY, walId) as Row | null;
    if (!wal) {
      // An unallocated container can never legitimately progress —
      // statuses that imply delegated work fail closed.
      if (wsStatus === "IN_PROGRESS" || wsStatus === "REVIEW_REQUIRED") {
        reviewFail(
          `unallocated workstream ${wid} claims ${wsStatus}`);
      }
      workstreams.push({
        workstream_key: String(w.workstream_key),
        work_item_id: wid,
        workstream_status: wsStatus,
        completion_proven: completionProven,
        allocation_state: "NONE",
        selected_agent_id: null,
        delegated_child_work_item_id: null,
        delegated_child_status: null,
        delegated_child_completion_proven: false,
        delegated_child_bound_mission: false,
        delegated_child_class: null,
      });
      continue;
    }
    // §7 — a WAL that exists but fails strict validation FAILS CLOSED;
    // a corrupt allocation is never silently treated as "unallocated".
    assertCanonicalWorkforceAllocation(wdeps, wal);
    const childId = String(wal.delegated_child_work_item_id);
    const child = deps.store.get("work_item", childId) as Row;
    // §R3.A — child's claimed status must equal canonical
    // event-derived state before any strategic use.
    const childStatus = assertCanonicalWorkStatus(deps.store, child);
    const childProven = deps.business.proveWorkItemDone(child);
    if (childStatus === "DONE" && !childProven) {
      reviewFail(
        `delegated child ${childId} claims DONE without canonical completion proof`);
    }
    // Canonical open/binding lineage for the delegated child — the
    // ONLY proof a child was ever opened.
    const childBoundMission = deps.business.boundMissionForWorkItem(child);
    const childMissionStatus = childBoundMission === null ? null
      : canonicalDerivedMissionStatus(deps.store, childBoundMission);
    if (childBoundMission !== null &&
        String(childBoundMission.status) !== childMissionStatus) {
      reviewFail(
        `delegated child ${childId} bound mission claims ` +
        `${String(childBoundMission.status)} but canonical lifecycle derives ${childMissionStatus}`);
    }
    // Lifecycle classification from canonical evidence only.
    let childClass: LifecycleClass;
    switch (childStatus) {
      case "DONE":
      case "CANCELLED":
        // derived ⇒ canonical completion (WCP checked above) or
        // cancellation/fold evidence exists.
        childClass = "EXHAUSTED";
        break;
      case "BLOCKED":
        // derived ⇒ canonical WORK_ITEM_BLOCKED/fold evidence —
        // a non-active intervention state.
        childClass = "INTERVENTION";
        break;
      case "REVIEW_REQUIRED": {
        const basis = deps.business.completionBasisProof(child);
        if (!basis.ready || basis.rejected) {
          reviewFail(
            `delegated child ${childId} claims REVIEW_REQUIRED without canonical review basis`);
        }
        childClass = "ACTIVE";
        break;
      }
      case "READY": {
        if (childBoundMission === null) {
          childClass = "ACTIVE"; // fresh delegated allocation
        } else if (childMissionStatus !== null &&
                   !TERMINAL_MISSION_STATUSES.has(childMissionStatus) &&
                   childMissionStatus !== "PAUSED") {
          // Live bound mission while claiming READY is contradictory.
          reviewFail(
            `delegated child ${childId} claims READY while a live bound mission exists`);
        } else {
          // Bound mission terminal (or canonically PAUSED) — fold
          // pending: intervention, not fresh progress.
          if (childMissionStatus === "PAUSED" ||
              TERMINAL_MISSION_STATUSES.has(childMissionStatus!)) {
            assertCanonicalMissionLifecycle(
              deps.store, childBoundMission!, childMissionStatus!);
          }
          childClass = "INTERVENTION";
        }
        break;
      }
      case "IN_PROGRESS": {
        if (childBoundMission === null) {
          reviewFail(
            `delegated child ${childId} claims IN_PROGRESS without a bound mission`);
        }
        if (childMissionStatus === "PAUSED" ||
            TERMINAL_MISSION_STATUSES.has(childMissionStatus!)) {
          // PAUSED is not active progress; a terminal mission pending
          // its fold is intervention — both need canonical proof.
          assertCanonicalMissionLifecycle(
            deps.store, childBoundMission, childMissionStatus!);
          childClass = "INTERVENTION";
        } else {
          childClass = "ACTIVE"; // genuine in-flight bound work
        }
        break;
      }
      default:
        reviewFail(`delegated child ${childId} status ${childStatus} outside canonical vocabulary`);
    }
    // Container lifecycle consistency: a container in IN_PROGRESS /
    // REVIEW_REQUIRED is only canonical via cascade from the delegated
    // child — never from raw status text.
    if (wsStatus === "IN_PROGRESS" && childClass !== "ACTIVE") {
      reviewFail(
        `workstream ${wid} claims IN_PROGRESS without live delegated work`);
    }
    workstreams.push({
      workstream_key: String(w.workstream_key),
      work_item_id: wid,
      workstream_status: wsStatus,
      completion_proven: completionProven,
      allocation_state: "ALLOCATED",
      selected_agent_id: String(wal.selected_agent_id),
      delegated_child_work_item_id: childId,
      delegated_child_status: childStatus,
      delegated_child_completion_proven: childProven,
      delegated_child_bound_mission: childBoundMission !== null,
      delegated_child_class: childClass,
    });
  }

  const kpis: KpiAssessmentProjection[] = (objective.kpis as ObjectiveKpi[]).map((k) => {
    const current = k.current === null || k.current === undefined ? null : Number(k.current);
    const assessment = objectiveKpiAssessment(k);
    return {
      kpi_id: k.kpi_id,
      name: k.name,
      direction: String(k.direction),
      baseline: Number(k.baseline),
      target: Number(k.target),
      current,
      assessment,
      last_evidence_key: k.last_evidence_key ?? null,
    };
  });
  const verified = kpis.filter((k) => k.assessment !== "UNVERIFIED").length;
  const gap = kpis.filter((k) => k.assessment === "GAP").length;
  const unverified = kpis.length - verified;
  const allMet = kpis.length > 0 && kpis.every((k) => k.assessment === "MET");

  const budget = objective.budget as { ceiling_microusd: number; consumed_microusd: number; currency: string };

  const observation: ReviewObservation = {
    schema: "pair.os.vnext.review-observation.v1",
    objective_id: String(objective.objective_id),
    business_id: String(objective.business_id),
    objective_version: Number(objective.version),
    objective_terms_version: Number(objective.terms_version),
    objective_digest: String(objective.objective_digest),
    objective_status: String(objective.status),
    deadline: objective.deadline === null || objective.deadline === undefined
      ? null : String(objective.deadline),
    budget: {
      ceiling_microusd: Number(budget.ceiling_microusd),
      consumed_microusd: Number(budget.consumed_microusd),
      currency: String(budget.currency),
    },
    binding_id: String(binding.binding_id),
    binding_digest: bindingDigest,
    kpis,
    all_targets_met: allMet,
    verified_kpi_count: verified,
    unverified_kpi_count: unverified,
    gap_kpi_count: gap,
    workstreams,
  };
  const serialized = canonicalJson(observation);
  if (Buffer.byteLength(serialized, "utf8") > REVIEW_OBSERVATION_MAX_BYTES) {
    throw new IntegrityError(
      "FAIL_CLOSED_P15_5_OBSERVATION_TOO_LARGE",
      `review observation exceeds ${REVIEW_OBSERVATION_MAX_BYTES} bytes`,
    );
  }
  return { observation, digest: digest(observation) };
}

// ---------------------------------------------------------------------
// RECEIPT + STRATEGY REVISION — deterministic ids, self-digests
// ---------------------------------------------------------------------

/** One deterministic receipt per (objective, review observation). */
export function adaptiveReviewId(objectiveId: string, observationDigest: string): string {
  return `REV_${digest(`adaptive-review:${objectiveId}:${observationDigest}`).slice(0, 24)}`;
}

/** Replay-safe strategy identity: same CEO decision + same review →
 *  same revision. */
export function strategyRevisionId(
  objectiveId: string, reviewId: string, decisionId: string,
): string {
  return `STR_${digest(`strategy-revision:${objectiveId}:${reviewId}:${decisionId}`).slice(0, 24)}`;
}

export function adaptiveReviewDigest(r: Record<string, unknown>): string {
  return digest({
    schema_version: r.schema_version,
    review_id: r.review_id,
    objective_id: r.objective_id,
    business_id: r.business_id,
    objective_version: r.objective_version,
    objective_terms_version: r.objective_terms_version,
    objective_digest: r.objective_digest,
    binding_id: r.binding_id,
    binding_digest: r.binding_digest,
    review_observation_digest: r.review_observation_digest,
    kpi_assessments: r.kpi_assessments,
    all_targets_met: r.all_targets_met,
    verified_kpi_count: r.verified_kpi_count,
    unverified_kpi_count: r.unverified_kpi_count,
    gap_kpi_count: r.gap_kpi_count,
    workstream_state_digest: r.workstream_state_digest,
    outcome: r.outcome,
    source_ceo_decision_id: r.source_ceo_decision_id,
    source_ceo_decision_digest: r.source_ceo_decision_digest,
    source_ceo_observation_digest: r.source_ceo_observation_digest,
    wait_reason: r.wait_reason,
    strategy_revision_id: r.strategy_revision_id,
    owner_action_required: r.owner_action_required,
    recommended_status: r.recommended_status,
    created_by: r.created_by,
    created_at: r.created_at,
    state: r.state,
  });
}

export function strategyRevisionDigest(r: Record<string, unknown>): string {
  return digest({
    schema_version: r.schema_version,
    strategy_revision_id: r.strategy_revision_id,
    objective_id: r.objective_id,
    business_id: r.business_id,
    source_review_id: r.source_review_id,
    source_review_digest: r.source_review_digest,
    source_ceo_decision_id: r.source_ceo_decision_id,
    source_ceo_decision_digest: r.source_ceo_decision_digest,
    source_ceo_observation_digest: r.source_ceo_observation_digest,
    binding_id: r.binding_id,
    binding_digest: r.binding_digest,
    priority_order: r.priority_order,
    actionable_order: r.actionable_order,
    previous_revision_id: r.previous_revision_id,
    previous_revision_digest: r.previous_revision_digest,
    created_by: r.created_by,
    created_at: r.created_at,
    state: r.state,
  });
}

const REVIEW_ALLOWED_FIELDS = new Set([
  "schema_version", "review_id", "objective_id", "business_id",
  "objective_version", "objective_terms_version", "objective_digest",
  "binding_id", "binding_digest", "review_observation_digest",
  "kpi_assessments", "all_targets_met", "verified_kpi_count",
  "unverified_kpi_count", "gap_kpi_count", "workstream_state_digest",
  "outcome", "source_ceo_decision_id", "source_ceo_decision_digest",
  "source_ceo_observation_digest", "wait_reason", "strategy_revision_id",
  "owner_action_required", "recommended_status",
  "created_by", "created_at", "review_digest", "state",
  "entity_type", "entity_id", "version",
]);

const REVISION_ALLOWED_FIELDS = new Set([
  "schema_version", "strategy_revision_id", "objective_id", "business_id",
  "source_review_id", "source_review_digest",
  "source_ceo_decision_id", "source_ceo_decision_digest",
  "source_ceo_observation_digest",
  "binding_id", "binding_digest",
  "priority_order", "actionable_order",
  "previous_revision_id", "previous_revision_digest",
  "created_by", "created_at", "strategy_digest", "state",
  "entity_type", "entity_id", "version",
]);

// ---------------------------------------------------------------------
// STRICT VALIDATORS — re-prove every referenced canonical authority
// ---------------------------------------------------------------------

function proveSingleAnchor(
  store: PairEvidenceStore,
  entityType: string, entityId: string, eventType: string,
): { event: Row; metadata: Record<string, unknown> } {
  const anchors = store.listEvents(entityType, entityId)
    .filter((e) => String(e.event_type) === eventType);
  if (anchors.length !== 1) {
    reviewFail(`${eventType} anchor count ${anchors.length} for ${entityId}`);
  }
  const a = anchors[0]! as Row;
  if (String(a.new_state ?? "") !== "COMMITTED" || a.old_state !== null) {
    reviewFail(`${eventType} anchor header states invalid`);
  }
  const md = a.metadata as Record<string, unknown> | null;
  if (!md) reviewFail(`${eventType} anchor has no metadata`);
  return { event: a, metadata: md };
}

/** §R3.B — NON-RECURSIVE strict read of one review receipt: exact
 *  allowlist shape, schema/entity/identity, create-only version/state,
 *  self-digest, exactly-one immutable anchor, objective+business
 *  equality, binding identity/digest, CEO-decision provenance and
 *  outcome shape — but NEVER recursively validates the pinned strategy
 *  revision (review⇄strategy mutual proof stays acyclic: the
 *  strategy's local read calls THIS function). */
export function assertCanonicalAdaptiveReviewLocal(
  deps: ObjectiveAdaptiveReviewDeps,
  row: Row,
): void {
  for (const k of Object.keys(row)) {
    if (!REVIEW_ALLOWED_FIELDS.has(k)) reviewFail(`review unknown field ${k}`);
  }
  if (String(row.schema_version) !== OBJECTIVE_ADAPTIVE_REVIEW_SCHEMA) {
    reviewFail("review schema_version");
  }
  if (String(row.entity_type) !== OBJECTIVE_ADAPTIVE_REVIEW_ENTITY) {
    reviewFail("review entity_type");
  }
  if (String(row.state) !== "COMMITTED") reviewFail(`review state ${String(row.state)}`);
  if (Number(row.version) !== 1) reviewFail("review version"); // create-only
  if (!REVIEW_OUTCOMES.includes(row.outcome as ReviewOutcome)) {
    reviewFail(`review outcome ${String(row.outcome)}`);
  }
  if (String(row.entity_id ?? "") !== String(row.review_id)) {
    reviewFail("review entity_id does not equal review_id");
  }
  if (String(row.review_id) !==
      adaptiveReviewId(String(row.objective_id), String(row.review_observation_digest))) {
    reviewFail("review_id does not recompute");
  }
  if (adaptiveReviewDigest(row) !== String(row.review_digest)) {
    reviewFail("review_digest mismatch");
  }
  // Immutable anchor — pins the ORIGINAL digest + identities, so a
  // forged row + recomputed self-digest still fails.
  const { event, metadata: anchorMd } = proveSingleAnchor(
    deps.store, OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
    String(row.review_id), OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT);
  if (String(event.actor) !== `operator:${String(row.created_by)}`) {
    reviewFail("review anchor actor mismatch");
  }
  for (const [k, v] of Object.entries({
    review_id: String(row.review_id),
    review_digest: String(row.review_digest),
    objective_id: String(row.objective_id),
    business_id: String(row.business_id),
    outcome: String(row.outcome),
    review_observation_digest: String(row.review_observation_digest),
    source_ceo_decision_id: row.source_ceo_decision_id === null ||
        row.source_ceo_decision_id === undefined
      ? null : String(row.source_ceo_decision_id),
    strategy_revision_id: row.strategy_revision_id === null ||
        row.strategy_revision_id === undefined
      ? null : String(row.strategy_revision_id),
  })) {
    const actual = anchorMd[k] ?? null;
    if (actual !== v) reviewFail(`review anchor ${k} mismatch`);
  }
  // Referenced authority — strict objective read + identity/business.
  const objective = deps.objectives.get(String(row.objective_id));
  if (String(objective.business_id) !== String(row.business_id)) {
    reviewFail("review business_id foreign to objective");
  }
  const binding = deps.workstreams.getBinding(String(row.objective_id));
  if (!binding || String(binding.binding_id) !== String(row.binding_id) ||
      objectiveWorkstreamBindingDigest(binding) !== String(row.binding_digest)) {
    reviewFail("review binding identity/digest mismatch");
  }
  // Outcome-shaped authority links.
  const ceoDeps: CeoObservationDeps = {
    store: deps.store,
    objectives: deps.objectives,
    workstreams: deps.workstreams,
    proveWorkItemDone: (w: Row) => deps.business.proveWorkItemDone(w),
  };
  const decisionId = row.source_ceo_decision_id;
  const hasDecision = decisionId !== null && decisionId !== undefined;
  let decisionRow: Row | null = null;
  if (hasDecision) {
    decisionRow = deps.store.tryGet(
      "ceo_decision", String(decisionId)) as Row | null;
    if (!decisionRow) reviewFail("source CEO decision missing");
    assertCanonicalCeoDecision(ceoDeps, decisionRow);
    if (String(decisionRow.objective_id) !== String(row.objective_id) ||
        String(decisionRow.business_id) !== String(row.business_id)) {
      reviewFail("source CEO decision provenance mismatch");
    }
    if (ceoDecisionDigest(decisionRow) !== String(row.source_ceo_decision_digest)) {
      reviewFail("source CEO decision digest mismatch");
    }
    if (String(decisionRow.observation_digest) !== String(row.source_ceo_observation_digest)) {
      reviewFail("source CEO observation digest mismatch");
    }
    const kind = String(decisionRow.decision_kind);
    if (String(row.outcome) === "PRIORITIZE_EXISTING" &&
        kind !== "PRIORITIZE_EXISTING") {
      reviewFail("PRIORITIZE review linked to non-prioritize decision");
    }
    if (String(row.outcome) === "WAIT" && kind !== "WAIT") {
      reviewFail("WAIT review linked to non-WAIT decision");
    }
  } else if (String(row.outcome) === "PRIORITIZE_EXISTING" ||
             String(row.outcome) === "WAIT") {
    reviewFail(`${String(row.outcome)} outcome requires a source CEO decision`);
  }
  const waitReason = row.wait_reason;
  if (String(row.outcome) === "WAIT") {
    const proposal = decisionRow!.proposal as Record<string, unknown>;
    if (String(proposal.wait_reason ?? "") !== String(waitReason ?? "")) {
      reviewFail("wait_reason does not match source decision");
    }
  } else if (waitReason !== null && waitReason !== undefined) {
    reviewFail("wait_reason pinned on non-WAIT outcome");
  }
  const stratId = row.strategy_revision_id;
  if (String(row.outcome) === "PRIORITIZE_EXISTING") {
    if (stratId === null || stratId === undefined) {
      reviewFail("PRIORITIZE outcome missing strategy_revision_id");
    }
    // §R3.B — the pinned strategy is NOT re-validated inside the local
    // read: review⇄strategy mutual proof stays acyclic because the
    // strategy's own local read calls THIS local function, never the
    // recursive public one.
  } else if (stratId !== null && stratId !== undefined) {
    reviewFail("strategy_revision_id pinned on non-PRIORITIZE outcome");
  }
  if (String(row.outcome) === "TARGET_MET_CANDIDATE") {
    if (row.all_targets_met !== true || row.owner_action_required !== true ||
        String(row.recommended_status) !== "ACHIEVED") {
      reviewFail("TARGET_MET_CANDIDATE recommendation fields malformed");
    }
  } else {
    if (row.recommended_status !== null && row.recommended_status !== undefined) {
      reviewFail("recommended_status pinned on non-TARGET_MET outcome");
    }
    if (row.owner_action_required !== false) {
      reviewFail("owner_action_required pinned on non-TARGET_MET outcome");
    }
  }
}

/** Full strict read of a canonical review receipt: the non-recursive
 *  local read PLUS — for PRIORITIZE_EXISTING — resolution and strict
 *  validation of the pinned strategy revision. */
export function assertCanonicalAdaptiveReview(
  deps: ObjectiveAdaptiveReviewDeps,
  row: Row,
): void {
  assertCanonicalAdaptiveReviewLocal(deps, row);
  if (String(row.outcome) === "PRIORITIZE_EXISTING") {
    const strat = deps.store.tryGet(
      OBJECTIVE_STRATEGY_REVISION_ENTITY,
      String(row.strategy_revision_id)) as Row | null;
    if (!strat) reviewFail("pinned strategy revision missing");
    assertCanonicalStrategyRevision(deps, strat);
    if (String(strat.source_review_id) !== String(row.review_id)) {
      reviewFail("strategy revision does not name this review as source");
    }
  }
}

/** Strict read of a canonical strategy revision: every per-row check
 *  PLUS a bounded (≤32), acyclic walk re-proving the whole previous
 *  chain — a malformed predecessor fails the latest revision closed. */
export function assertCanonicalStrategyRevision(
  deps: ObjectiveAdaptiveReviewDeps,
  row: Row,
): void {
  assertCanonicalStrategyRevisionLocal(deps, row);
  // Previous-revision chain — bounded, acyclic, every ancestor held to
  // the same per-row strict standard.
  const seen = new Set<string>([String(row.strategy_revision_id)]);
  let cur: Row = row;
  while (cur.previous_revision_id !== null &&
         cur.previous_revision_id !== undefined) {
    if (seen.size > STRATEGY_REVISION_MAX_PER_OBJECTIVE) {
      reviewFail("previous revision chain exceeds bound");
    }
    const prevId = String(cur.previous_revision_id);
    if (seen.has(prevId)) {
      reviewFail("previous revision chain cycle");
    }
    const prevRow = deps.store.tryGet(
      OBJECTIVE_STRATEGY_REVISION_ENTITY, prevId) as Row | null;
    if (!prevRow) reviewFail("previous revision missing");
    if (String(prevRow.entity_id ?? "") !== prevId ||
        String(prevRow.strategy_revision_id) !== prevId ||
        String(prevRow.objective_id) !== String(row.objective_id) ||
        String(prevRow.business_id) !== String(row.business_id) ||
        strategyRevisionDigest(prevRow) !==
          String(cur.previous_revision_digest)) {
      reviewFail("previous revision provenance mismatch");
    }
    seen.add(prevId);
    assertCanonicalStrategyRevisionLocal(deps, prevRow);
    cur = prevRow;
  }
}

/** Per-row strict checks for one canonical strategy revision: exact
 *  shape, self-digest, immutable anchor, and full provenance re-proof
 *  against its source review + CEO decision + P15.2 binding. The
 *  previous-chain walk lives in the public validator. */
function assertCanonicalStrategyRevisionLocal(
  deps: ObjectiveAdaptiveReviewDeps,
  row: Row,
): void {
  for (const k of Object.keys(row)) {
    if (!REVISION_ALLOWED_FIELDS.has(k)) reviewFail(`revision unknown field ${k}`);
  }
  if (String(row.schema_version) !== OBJECTIVE_STRATEGY_REVISION_SCHEMA) {
    reviewFail("revision schema_version");
  }
  if (String(row.entity_type) !== OBJECTIVE_STRATEGY_REVISION_ENTITY) {
    reviewFail("revision entity_type");
  }
  if (String(row.state) !== "COMMITTED") reviewFail(`revision state ${String(row.state)}`);
  if (Number(row.version) !== 1) reviewFail("revision version"); // create-only
  if (String(row.entity_id ?? "") !== String(row.strategy_revision_id)) {
    reviewFail("revision entity_id does not equal strategy_revision_id");
  }
  if (String(row.strategy_revision_id) !== strategyRevisionId(
      String(row.objective_id), String(row.source_review_id),
      String(row.source_ceo_decision_id))) {
    reviewFail("strategy_revision_id does not recompute");
  }
  if (strategyRevisionDigest(row) !== String(row.strategy_digest)) {
    reviewFail("strategy_digest mismatch");
  }
  const { event, metadata: anchorMd } = proveSingleAnchor(
    deps.store, OBJECTIVE_STRATEGY_REVISION_ENTITY,
    String(row.strategy_revision_id), OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT);
  if (String(event.actor) !== `operator:${String(row.created_by)}`) {
    reviewFail("revision anchor actor mismatch");
  }
  for (const [k, v] of Object.entries({
    strategy_revision_id: String(row.strategy_revision_id),
    strategy_digest: String(row.strategy_digest),
    objective_id: String(row.objective_id),
    business_id: String(row.business_id),
    source_review_id: String(row.source_review_id),
    source_ceo_decision_id: String(row.source_ceo_decision_id),
  })) {
    const actual = anchorMd[k] ?? null;
    if (actual !== v) reviewFail(`revision anchor ${k} mismatch`);
  }
  // §R3.B — the source review is re-proven through the FULL
  // non-recursive strict validator: exact shape, self-digest, its own
  // immutable anchor, objective/binding/CEO-decision provenance and
  // outcome shape — then cross-pinned to THIS revision.
  const review = deps.store.tryGet(
    OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, String(row.source_review_id)) as Row | null;
  if (!review) reviewFail("source review missing");
  assertCanonicalAdaptiveReviewLocal(deps, review);
  if (String(review.review_id) !== String(row.source_review_id)) {
    reviewFail("source review identity mismatch");
  }
  if (adaptiveReviewDigest(review) !== String(row.source_review_digest)) {
    reviewFail("source review digest mismatch");
  }
  if (String(review.strategy_revision_id) !== String(row.strategy_revision_id)) {
    reviewFail("source review does not pin this revision");
  }
  if (String(review.outcome) !== "PRIORITIZE_EXISTING") {
    reviewFail("source review is not PRIORITIZE_EXISTING");
  }
  if (String(review.objective_id) !== String(row.objective_id) ||
      String(review.business_id) !== String(row.business_id) ||
      String(review.source_ceo_decision_id) !== String(row.source_ceo_decision_id)) {
    reviewFail("source review provenance mismatch");
  }
  const decision = deps.store.tryGet(
    "ceo_decision", String(row.source_ceo_decision_id)) as Row | null;
  if (!decision) reviewFail("source CEO decision missing");
  const ceoDeps: CeoObservationDeps = {
    store: deps.store,
    objectives: deps.objectives,
    workstreams: deps.workstreams,
    proveWorkItemDone: (w: Row) => deps.business.proveWorkItemDone(w),
  };
  assertCanonicalCeoDecision(ceoDeps, decision);
  if (ceoDecisionDigest(decision) !== String(row.source_ceo_decision_digest)) {
    reviewFail("revision source CEO decision digest mismatch");
  }
  if (String(decision.decision_kind) !== "PRIORITIZE_EXISTING") {
    reviewFail("revision source decision is not PRIORITIZE_EXISTING");
  }
  const proposal = decision.proposal as Record<string, unknown>;
  const proposalOrder = (proposal.priority_order as string[]).map(String);
  const pinnedOrder = (row.priority_order as string[]).map(String);
  if (JSON.stringify(proposalOrder) !== JSON.stringify(pinnedOrder)) {
    reviewFail("revision priority_order differs from source decision");
  }
  // priority_order must remain an exact permutation of canonical P15.2
  // workstream keys — the binding the revision pins.
  const binding = deps.workstreams.getBinding(String(row.objective_id));
  if (!binding || String(binding.binding_id) !== String(row.binding_id) ||
      objectiveWorkstreamBindingDigest(binding) !== String(row.binding_digest)) {
    reviewFail("revision binding identity/digest mismatch");
  }
  const canonicalKeys = (binding.workstreams as Array<Record<string, unknown>>)
    .map((w) => String(w.workstream_key));
  const keySet = new Set(canonicalKeys);
  if (pinnedOrder.length !== keySet.size || new Set(pinnedOrder).size !== keySet.size ||
      !pinnedOrder.every((k) => keySet.has(k))) {
    reviewFail("revision priority_order is not an exact permutation");
  }
  // actionable_order ⊆ priority_order, unique, and every excluded item
  // must be canonically complete NOW (completion is monotone — an item
  // not complete today could not have been excluded at commit).
  const actionable = (row.actionable_order as string[]).map(String);
  const actionableSet = new Set(actionable);
  if (actionableSet.size !== actionable.length) {
    reviewFail("actionable_order has duplicates");
  }
  for (const k of actionable) {
    if (!keySet.has(k)) reviewFail(`actionable key ${k} not canonical`);
  }
  const excluded = canonicalKeys.filter((k) => !actionableSet.has(k));
  for (const k of excluded) {
    const ws = (binding.workstreams as Array<Record<string, unknown>>)
      .find((w) => String(w.workstream_key) === k)!;
    const item = deps.store.get("work_item", String(ws.work_item_id)) as Row;
    if (!deps.business.proveWorkItemDone(item)) {
      reviewFail(`actionable_order excludes ${k} without canonical completion`);
    }
  }
}

// ---------------------------------------------------------------------
// SERVICE
// ---------------------------------------------------------------------

export interface ReviewResult {
  status: "reviewed" | "replayed";
  review: Row;
  strategy_revision: Row | null;
  outcome: ReviewOutcome;
}

export class ObjectiveAdaptiveReviewService {
  constructor(private readonly deps: ObjectiveAdaptiveReviewDeps) {}

  private get store(): PairEvidenceStore { return this.deps.store; }

  /** Strict read of one canonical review receipt. */
  getReview(reviewId: string): Row {
    const row = this.store.tryGet(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, reviewId) as Row | null;
    if (!row) throw new NotFoundError(`review ${reviewId}`);
    assertCanonicalAdaptiveReview(this.deps, row);
    return row;
  }

  /** Latest canonical strategy revision for an objective, or null. */
  getLatestStrategy(objectiveId: string): Row | null {
    return canonicalStrategyChain(this.deps, objectiveId).head;
  }

  /**
   * ONE bounded review: strict observation → deterministic checkpoint
   * (TARGET_MET / AWAITING / TOPOLOGY — zero model calls) or the
   * existing P15.3 CEO cycle → stale gate → ONE atomic commit
   * (receipt + optional strategy revision + anchors). Replay-safe.
   */
  async runReview(input: {
    objective_id: string;
    actor: string;
    /** P15.10-C R1: forwarded verbatim to ceoCycle.runCycle — the
     * fenced commit guard fires inside the CEO commit transaction,
     * so a review-driven cycle gets identical post-await protection. */
    autonomous_commit_guard?: () => void;
  }): Promise<ReviewResult> {
    if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "adaptive-review.runReview");
    }
    const actor = input.actor;
    const objectiveId = String(input.objective_id ?? "");
    if (!objectiveId || objectiveId.length > 256) {
      reviewFail("objective_id malformed");
    }
    // P15.1 deadline semantics — admission only; replay of a committed
    // review is checked below and is not re-admitted.
    this.deps.objectives.evaluateDeadline(objectiveId);
    const objective = this.deps.objectives.get(objectiveId);
    if (String(objective.status) !== "ACTIVE") {
      throw new IntegrityError(
        "FAIL_CLOSED_P15_5_OBJECTIVE_NOT_ACTIVE",
        `objective ${objectiveId} status ${String(objective.status)}`,
      );
    }
    const { observation, digest: obsDigest } = buildReviewObservation(this.deps, objectiveId);
    const reviewId = adaptiveReviewId(objectiveId, obsDigest);
    // Replay — the committed observation is historical authority; the
    // strict read re-proves every referenced authority first.
    const prior = this.store.tryGet(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, reviewId) as Row | null;
    if (prior) {
      assertCanonicalAdaptiveReview(this.deps, prior);
      const stratId = prior.strategy_revision_id;
      return {
        status: "replayed",
        review: prior,
        strategy_revision: stratId === null || stratId === undefined ? null :
          this.store.get(OBJECTIVE_STRATEGY_REVISION_ENTITY, String(stratId)) as Row,
        outcome: String(prior.outcome) as ReviewOutcome,
      };
    }

    // Deterministic checkpoint — before ANY model call (§8/§9/§10).
    // Activity/exhaustion are derived from canonical lifecycle evidence
    // re-proven inside buildReviewObservation (never raw status text).
    const anyActive = observation.workstreams.some((w) =>
      // §R4.A — activity is ONLY actual canonical executable progress:
      // the P15.4 delegated child's proven lifecycle class. A P15.2
      // container is non-executable — its READY status (even canonically
      // derived, e.g. after a block→unblock cycle) never proves work is
      // flowing. Container IN_PROGRESS is already proven to require an
      // ACTIVE child at observation build (else fail closed), so it
      // adds nothing the class doesn't carry. A canonically grounded
      // REVIEW_REQUIRED container genuinely awaits governed review.
      w.delegated_child_class === "ACTIVE" ||
      w.workstream_status === "REVIEW_REQUIRED");
    const allExhausted = observation.workstreams.length > 0 &&
      observation.workstreams.every((w) =>
        w.completion_proven ||
        // CANCELLED was re-proven against canonical cancellation
        // authority at observation build — it never counted on text.
        w.workstream_status === "CANCELLED" ||
        w.delegated_child_status === "CANCELLED");

    let outcome: ReviewOutcome;
    let decision: Row | null = null;
    if (observation.all_targets_met) {
      outcome = "TARGET_MET_CANDIDATE";
    } else if (anyActive) {
      outcome = "AWAITING_PROGRESS";
    } else if (allExhausted && observation.gap_kpi_count > 0) {
      outcome = "TOPOLOGY_CHANGE_REQUIRED";
    } else if (allExhausted) {
      // Work exhausted but NO verified gap — unverified progress is
      // not a gap and cannot claim the target missed (§R2.D).
      outcome = "INSUFFICIENT_VERIFIED_PROGRESS";
    } else {
      // CEO path — the EXISTING P15.3 cycle. Never a second model path.
      const res = await this.deps.ceoCycle.runCycle({
        objective_id: objectiveId, actor,
        autonomous_commit_guard: input.autonomous_commit_guard,
      });
      decision = res.decision;
      const kind = String(decision.decision_kind);
      // §11 — P15.5 consumes only PRIORITIZE_EXISTING / WAIT. P15.3's
      // own gate already rejects INITIALIZE once a binding exists;
      // anything else here is impossible/forbidden → fail closed.
      if (kind === "PRIORITIZE_EXISTING") outcome = "PRIORITIZE_EXISTING";
      else if (kind === "WAIT") outcome = "WAIT";
      else {
        throw new IntegrityError(
          "FAIL_CLOSED_P15_5_CEO_KIND",
          `P15.5 cannot consume CEO decision kind ${kind}`,
        );
      }
      if (String(decision.objective_id) !== String(observation.objective_id) ||
          String(decision.business_id) !== String(observation.business_id)) {
        reviewFail("CEO decision provenance mismatch");
      }
      if (String(decision.observed_binding_digest ?? "") !== observation.binding_digest) {
        reviewFail("CEO decision observed a different binding");
      }
    }

    return this.commitReview(
      objectiveId, actor, reviewId, obsDigest, observation, outcome, decision,
      input.autonomous_commit_guard);
  }

  /** ONE serializing transaction: replay check → stale gate → receipt
   *  → optional strategy revision → immutable anchors. Anything that
   *  throws rolls the whole authority chain back (§17). The optional
   *  autonomous commit guard fires FIRST inside the transaction so a
   *  revoke landing between the CEO decision commit and this review
   *  commit rolls back every review side effect (receipt + strategy
   *  revision + anchors) — P15.10-C R2 F1.2. */
  private commitReview(
    objectiveId: string,
    actor: string,
    reviewId: string,
    obsDigest: string,
    observation: ReviewObservation,
    outcome: ReviewOutcome,
    decision: Row | null,
    autonomousCommitGuard?: () => void,
  ): ReviewResult {
    return this.store.immediate(() => {
      autonomousCommitGuard?.();
      const cur = this.store.tryGet(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, reviewId) as Row | null;
      if (cur) {
        // Concurrent winner committed the same canonical observation —
        // converge to canonical replay.
        assertCanonicalAdaptiveReview(this.deps, cur);
        const stratId = cur.strategy_revision_id;
        return {
          status: "replayed" as const,
          review: cur,
          strategy_revision: stratId === null || stratId === undefined ? null :
            this.store.get(OBJECTIVE_STRATEGY_REVISION_ENTITY, String(stratId)) as Row,
          outcome: String(cur.outcome) as ReviewOutcome,
        };
      }
      // §13 — never apply a CEO decision to drifted state. The receipt
      // is pinned to THIS observation digest only.
      const fresh = buildReviewObservation(this.deps, objectiveId);
      if (fresh.digest !== obsDigest) {
        throw new IntegrityError(
          "FAIL_CLOSED_P15_5_STALE_REVIEW",
          `review observation drifted for ${objectiveId}`,
        );
      }
      const now = utcnow();
      const decisionDigest = decision ? ceoDecisionDigest(decision) : null;
      const decisionObsDigest = decision ? String(decision.observation_digest) : null;
      const waitReason = outcome === "WAIT" && decision
        ? String(((decision.proposal as Record<string, unknown>).wait_reason as string) ?? "")
        : null;

      const body: Record<string, unknown> = {
        schema_version: OBJECTIVE_ADAPTIVE_REVIEW_SCHEMA,
        review_id: reviewId,
        objective_id: objectiveId,
        business_id: observation.business_id,
        objective_version: observation.objective_version,
        objective_terms_version: observation.objective_terms_version,
        objective_digest: observation.objective_digest,
        binding_id: observation.binding_id,
        binding_digest: observation.binding_digest,
        review_observation_digest: obsDigest,
        kpi_assessments: observation.kpis,
        all_targets_met: observation.all_targets_met,
        verified_kpi_count: observation.verified_kpi_count,
        unverified_kpi_count: observation.unverified_kpi_count,
        gap_kpi_count: observation.gap_kpi_count,
        workstream_state_digest: digest(observation.workstreams),
        outcome,
        source_ceo_decision_id: decision ? String(decision.decision_id) : null,
        source_ceo_decision_digest: decisionDigest,
        source_ceo_observation_digest: decisionObsDigest,
        wait_reason: waitReason,
        strategy_revision_id: null, // pinned below for PRIORITIZE
        owner_action_required: outcome === "TARGET_MET_CANDIDATE",
        recommended_status: outcome === "TARGET_MET_CANDIDATE" ? "ACHIEVED" : null,
        created_by: actor,
        created_at: now,
        state: "COMMITTED",
        version: 0,
      };

      // Strategy revision — only for PRIORITIZE_EXISTING (§15).
      let strategy: Row | null = null;
      if (outcome === "PRIORITIZE_EXISTING" && decision) {
        const chain = canonicalStrategyChain(this.deps, objectiveId);
        if (chain.all.length >= STRATEGY_REVISION_MAX_PER_OBJECTIVE) {
          throw new IntegrityError(
            "FAIL_CLOSED_P15_5_REVISION_LIMIT", objectiveId);
        }
        const priorityOrder =
          ((decision.proposal as Record<string, unknown>).priority_order as string[])
            .map(String);
        // actionable = priority_order minus CANONICALLY completed
        // workstreams — status text alone never excludes an item.
        const byKey = new Map(
          observation.workstreams.map((w) => [w.workstream_key, w]));
        const actionable = priorityOrder.filter(
          (k) => !byKey.get(k)?.completion_proven);
        const stratId = strategyRevisionId(
          objectiveId, reviewId, String(decision.decision_id));
        // The strategy pins the digest of the FINAL receipt (which
        // names the strategy) — pin strategy_revision_id on the body
        // BEFORE computing the pinned digest.
        body.strategy_revision_id = stratId;
        const finalReviewDigest = adaptiveReviewDigest(body);
        const stratBody: Record<string, unknown> = {
          schema_version: OBJECTIVE_STRATEGY_REVISION_SCHEMA,
          strategy_revision_id: stratId,
          objective_id: objectiveId,
          business_id: observation.business_id,
          source_review_id: reviewId,
          source_review_digest: finalReviewDigest,
          source_ceo_decision_id: String(decision.decision_id),
          source_ceo_decision_digest: decisionDigest,
          source_ceo_observation_digest: decisionObsDigest,
          binding_id: observation.binding_id,
          binding_digest: observation.binding_digest,
          priority_order: priorityOrder,
          actionable_order: actionable,
          previous_revision_id: chain.head
            ? String(chain.head.strategy_revision_id) : null,
          previous_revision_digest: chain.head
            ? String(chain.head.strategy_digest) : null,
          created_by: actor,
          created_at: now,
          state: "COMMITTED",
          version: 0,
        };
        stratBody.strategy_digest = strategyRevisionDigest(stratBody);
        strategy = this.store.put(
          OBJECTIVE_STRATEGY_REVISION_ENTITY, stratId, stratBody as Row, 0);
        this.store.event({
          entity_type: OBJECTIVE_STRATEGY_REVISION_ENTITY,
          entity_id: stratId,
          event_type: OBJECTIVE_STRATEGY_REVISION_COMMITTED_EVENT,
          old_state: null,
          new_state: "COMMITTED",
          actor: `operator:${actor}`,
          metadata: {
            strategy_revision_id: stratId,
            strategy_digest: String(stratBody.strategy_digest),
            objective_id: objectiveId,
            business_id: observation.business_id,
            source_review_id: reviewId,
            source_ceo_decision_id: String(decision.decision_id),
          },
        });
      }

      body.review_digest = adaptiveReviewDigest(body);
      const review = this.store.put(
        OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, reviewId, body as Row, 0);
      this.store.event({
        entity_type: OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
        entity_id: reviewId,
        event_type: OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED_EVENT,
        old_state: null,
        new_state: "COMMITTED",
        actor: `operator:${actor}`,
        metadata: {
          review_id: reviewId,
          review_digest: String(body.review_digest),
          objective_id: objectiveId,
          business_id: observation.business_id,
          outcome,
          review_observation_digest: obsDigest,
          source_ceo_decision_id: decision ? String(decision.decision_id) : null,
          strategy_revision_id: body.strategy_revision_id,
        },
      });
      return {
        status: "reviewed" as const, review,
        strategy_revision: strategy, outcome,
      };
    });
  }
}

/**
 * Runtime composition seam (§21): builds the default CEO cycle through
 * the EXISTING P15.3W wiring (canonical model resolution, codex-cli
 * authority gates) and composes the review service on top. Callers
 * never construct a model_entry_id.
 */
export function createDefaultAdaptiveReview(deps: {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
  invoker?: CeoDecisionInvoker;
}): { service: ObjectiveAdaptiveReviewService; model_entry_id: string } {
  const { service: ceoCycle, model_entry_id } = createDefaultCeoPlanningCycle(deps);
  return {
    service: new ObjectiveAdaptiveReviewService({ ...deps, ceoCycle }),
    model_entry_id,
  };
}
