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
import { TERMINAL_WORK_ITEM_STATUSES } from "./business.js";
import type { PairEvidenceStore } from "./store.js";
import type { ObjectiveAuthorityService, ObjectiveKpi } from "./objective-authority.js";
import { OBJECTIVE_ENTITY, progressSemantics } from "./objective-authority.js";
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
  "PRIORITIZE_EXISTING",
  "WAIT",
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** KPI assessment vocabulary — deterministic, no fuzzy tolerance. */
export const KPI_ASSESSMENTS = ["MET", "GAP", "UNVERIFIED"] as const;
export type KpiAssessment = (typeof KPI_ASSESSMENTS)[number];

/** Work statuses that count as "legitimate work still actively
 *  progressing" (§8). BLOCKED is deliberately NOT active: it is a
 *  canonical blocking condition requiring intervention. BACKLOG is not
 *  active either — an allocated child is READY on creation. */
const ACTIVE_PROGRESS_STATUSES = new Set([
  "READY", "IN_PROGRESS", "REVIEW_REQUIRED",
]);

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
// §12 — REVIEW OBSERVATION
// ---------------------------------------------------------------------

interface ReviewWorkstreamProjection {
  workstream_key: string;
  work_item_id: string;
  workstream_status: string;
  completion_proven: boolean;
  allocation_state: "NONE" | "ALLOCATED";
  selected_agent_id: string | null;
  delegated_child_work_item_id: string | null;
  delegated_child_status: string | null;
  delegated_child_completion_proven: boolean;
}

interface KpiAssessmentProjection {
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
  latest_strategy_revision_id: string | null;
  latest_strategy_revision_digest: string | null;
  strategy_revision_count: number;
}

/** The latest canonical strategy revision for an objective — the chain
 *  head (a revision no other canonical revision names as its
 *  previous). Every attributed row is strict-validated; a malformed
 *  one is corrupt authority and fails closed, never skipped. */
function canonicalStrategyChain(
  deps: ObjectiveAdaptiveReviewDeps,
  objectiveId: string,
): { head: Row | null; all: Row[] } {
  const all = (deps.store.list(OBJECTIVE_STRATEGY_REVISION_ENTITY) as Row[])
    .filter((r) => String(r.objective_id) === objectiveId);
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
    const completionProven = deps.business.proveWorkItemDone(row);
    // Status DONE without the canonical completion proof is a
    // contradictory canonical state — the only authority path that
    // mints DONE also mints the WCP. Fail closed rather than reason
    // over tampered state.
    if (String(row.status) === "DONE" && !completionProven) {
      reviewFail(
        `workstream ${wid} claims DONE without canonical completion proof`);
    }
    const walId = workforceAllocationId(objectiveId, wid);
    const wal = deps.store.tryGet(WORKFORCE_ALLOCATION_ENTITY, walId) as Row | null;
    if (!wal) {
      workstreams.push({
        workstream_key: String(w.workstream_key),
        work_item_id: wid,
        workstream_status: String(row.status),
        completion_proven: completionProven,
        allocation_state: "NONE",
        selected_agent_id: null,
        delegated_child_work_item_id: null,
        delegated_child_status: null,
        delegated_child_completion_proven: false,
      });
      continue;
    }
    // §7 — a WAL that exists but fails strict validation FAILS CLOSED;
    // a corrupt allocation is never silently treated as "unallocated".
    assertCanonicalWorkforceAllocation(wdeps, wal);
    const childId = String(wal.delegated_child_work_item_id);
    const child = deps.store.get("work_item", childId) as Row;
    const childProven = deps.business.proveWorkItemDone(child);
    if (String(child.status) === "DONE" && !childProven) {
      reviewFail(
        `delegated child ${childId} claims DONE without canonical completion proof`);
    }
    workstreams.push({
      workstream_key: String(w.workstream_key),
      work_item_id: wid,
      workstream_status: String(row.status),
      completion_proven: completionProven,
      allocation_state: "ALLOCATED",
      selected_agent_id: String(wal.selected_agent_id),
      delegated_child_work_item_id: childId,
      delegated_child_status: String(child.status),
      delegated_child_completion_proven: childProven,
    });
  }

  const kpis: KpiAssessmentProjection[] = (objective.kpis as ObjectiveKpi[]).map((k) => {
    const current = k.current === null || k.current === undefined ? null : Number(k.current);
    let assessment: KpiAssessment = "UNVERIFIED";
    if (current !== null) {
      switch (String(k.direction)) {
        case "AT_LEAST": assessment = current >= Number(k.target) ? "MET" : "GAP"; break;
        case "AT_MOST": assessment = current <= Number(k.target) ? "MET" : "GAP"; break;
        case "EXACT": assessment = current === Number(k.target) ? "MET" : "GAP"; break;
        default: reviewFail(`kpi ${k.kpi_id}: unknown direction ${String(k.direction)}`);
      }
    }
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

  const chain = canonicalStrategyChain(deps, objectiveId);
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
    latest_strategy_revision_id: chain.head
      ? String(chain.head.strategy_revision_id) : null,
    latest_strategy_revision_digest: chain.head
      ? String(chain.head.strategy_digest) : null,
    strategy_revision_count: chain.all.length,
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

/** Strict read of a canonical review receipt: exact shape, self-digest,
 *  immutable anchor pinning, and re-proof of every referenced authority
 *  (objective, binding, CEO decision, strategy revision). */
export function assertCanonicalAdaptiveReview(
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
    const strat = deps.store.tryGet(
      OBJECTIVE_STRATEGY_REVISION_ENTITY, String(stratId)) as Row | null;
    if (!strat) reviewFail("pinned strategy revision missing");
    assertCanonicalStrategyRevision(deps, strat);
    if (String(strat.source_review_id) !== String(row.review_id)) {
      reviewFail("strategy revision does not name this review as source");
    }
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

/** Strict read of a canonical strategy revision: exact shape,
 *  self-digest, immutable anchor, and full provenance re-proof against
 *  its source review + CEO decision + P15.2 binding. */
export function assertCanonicalStrategyRevision(
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
  // Source review + CEO decision must exist canonically.
  const review = deps.store.tryGet(
    OBJECTIVE_ADAPTIVE_REVIEW_ENTITY, String(row.source_review_id)) as Row | null;
  if (!review) reviewFail("source review missing");
  // Recursion guard: the review's own strict read re-proves THIS row
  // only through strategy_revision_id; recompute digests directly here
  // to keep the proof acyclic.
  if (adaptiveReviewDigest(review) !== String(row.source_review_digest)) {
    reviewFail("source review digest mismatch");
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
  // Previous-revision chain, when pinned.
  const prev = row.previous_revision_id;
  if (prev !== null && prev !== undefined) {
    const prevRow = deps.store.tryGet(
      OBJECTIVE_STRATEGY_REVISION_ENTITY, String(prev)) as Row | null;
    if (!prevRow) reviewFail("previous revision missing");
    if (String(prevRow.objective_id) !== String(row.objective_id) ||
        strategyRevisionDigest(prevRow) !== String(row.previous_revision_digest)) {
      reviewFail("previous revision provenance mismatch");
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
  async runReview(input: { objective_id: string; actor: string }): Promise<ReviewResult> {
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
    const anyActive = observation.workstreams.some((w) =>
      w.allocation_state === "ALLOCATED" &&
      w.delegated_child_status !== null &&
      ACTIVE_PROGRESS_STATUSES.has(w.delegated_child_status));
    const allExhausted = observation.workstreams.length > 0 &&
      observation.workstreams.every((w) =>
        w.completion_proven ||
        TERMINAL_WORK_ITEM_STATUSES.has(w.workstream_status));

    let outcome: ReviewOutcome;
    let decision: Row | null = null;
    if (observation.all_targets_met) {
      outcome = "TARGET_MET_CANDIDATE";
    } else if (anyActive) {
      outcome = "AWAITING_PROGRESS";
    } else if (allExhausted) {
      outcome = "TOPOLOGY_CHANGE_REQUIRED";
    } else {
      // CEO path — the EXISTING P15.3 cycle. Never a second model path.
      const res = await this.deps.ceoCycle.runCycle({
        objective_id: objectiveId, actor,
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
      objectiveId, actor, reviewId, obsDigest, observation, outcome, decision);
  }

  /** ONE serializing transaction: replay check → stale gate → receipt
   *  → optional strategy revision → immutable anchors. Anything that
   *  throws rolls the whole authority chain back (§17). */
  private commitReview(
    objectiveId: string,
    actor: string,
    reviewId: string,
    obsDigest: string,
    observation: ReviewObservation,
    outcome: ReviewOutcome,
    decision: Row | null,
  ): ReviewResult {
    return this.store.immediate(() => {
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
