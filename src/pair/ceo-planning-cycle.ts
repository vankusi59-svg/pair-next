/**
 * ceo-planning-cycle — P15.3 deterministic CEO planning cycle.
 *
 *   Canonical Objective + P15.2/P14 work state
 *     → deterministic Observation Snapshot (+ digest)
 *     → CEO_DECISION invocation (proposal-only, ONE attempt per cycle)
 *     → strict parse + deterministic CEO gate
 *     → re-observe + TOCTOU stale check inside the commit transaction
 *     → canonical CEO decision receipt + immutable commit anchor
 *     → INITIALIZE materializes ONLY through P15.2 decomposeObjective()
 *
 * The LLM NEVER owns state. The deterministic controller owns all
 * authority: actor shape, Objective status gate, cycle/attempt bounds,
 * model eligibility, stale-decision rejection, atomic commit.
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { CEO_CLI_TIMEOUT, ceoCliTimeoutMs } from "./env-config.js";
import { modelRoleOf, sameCanonicalModel, MODEL_ROLE, listModelRoleAssignments } from "./model-role.js";
import { providerModelEligibility } from "./model-routable.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import {
  objectiveWorkstreamBindingDigest,
  objectiveWorkstreamBindingId,
} from "./objective-workstream.js";
import type { PairEvidenceStore } from "./store.js";
import { WORK_ITEM_STATUSES } from "./business.js";
import {
  CEO_DECISION_KIND,
  CEO_MAX_OBSERVATION_BYTES,
  CEO_OBSERVATION_SCHEMA,
  buildCeoUserPrompt,
  ceoDecisionSystemPrompt,
  ceoProposalDigest,
  parseCeoDecisionText,
  resolveCeoModelTransport,
  validateCanonicalCeoProposal,
  type CeoDecisionInvoker,
  type CeoProposal,
} from "./ceo-decision.js";

type Row = Record<string, unknown> & { version: number };

/** CEO model eligibility (§"CRITICAL MODEL-ROLE COMPATIBILITY"):
 *  canonical model_entry exists, is usable through the shared
 *  providerModelEligibility projection, and is NOT canonically
 *  DSH_EXECUTION (directly or by proven alias). PLANNER_COORDINATOR is
 *  NOT required — a model may serve CEO without holding any exclusive
 *  role. Authority violations throw; availability degradations reject
 *  the attempt before any invocation. Exported as the single gate the
 *  runtime wiring seam (ceo-runtime.ts) must reuse verbatim — no
 *  second eligibility authority. */
export function assertCeoModelUsable(
  store: PairEvidenceStore,
  modelEntryId: string,
): Record<string, unknown> {
  const model = store.tryGet("model_entry", modelEntryId);
  if (!model) {
    throw new IntegrityError("FAIL_CLOSED_CEO_MODEL_UNRESOLVED", `model_entry ${modelEntryId}`);
  }
  const conditions = (model.conditions ?? []) as string[];
  if (conditions.some((c) => ["REMOVED", "DEPRECATED", "BLOCKED"].includes(c))) {
    throw new IntegrityError("FAIL_CLOSED_CEO_MODEL_UNRESOLVED", `model ${modelEntryId} revoked`);
  }
  // Direct role check + alias-aware disjointness — a canonically
  // DSH_EXECUTION model (or an entry that is canonically the SAME
  // model as a DSH assignment) may never serve CEO_DECISION.
  if (modelRoleOf(store, modelEntryId) === MODEL_ROLE.DSH_EXECUTION) {
    throw new IntegrityError("FAIL_CLOSED_CEO_DSH_OVERLAP", `model ${modelEntryId} is DSH_EXECUTION`);
  }
  for (const asn of listModelRoleAssignments(store)) {
    if (asn.role !== MODEL_ROLE.DSH_EXECUTION) continue;
    const other = store.tryGet("model_entry", String(asn.model_entry_id));
    if (other && sameCanonicalModel(model, other)) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_DSH_OVERLAP",
        `model ${modelEntryId} is canonically a DSH_EXECUTION model`,
      );
    }
  }
  const elig = providerModelEligibility(
    store, String(model.provider_id ?? model.provider_family ?? ""), modelEntryId);
  if (!elig.eligible) {
    const failed = Object.keys(elig.gates).filter((g) => elig.gates[g] === "FAIL");
    const AUTHORITY = new Set([
      "PROVIDER_QUALIFIED", "PROVIDER_AUTH_OK", "PROVIDER_NOT_BLOCKED",
      "PROVIDER_RECEIPT_CURRENT", "MODEL_RECEIPT_CURRENT",
      "MODEL_PROVIDER_MATCH", "MODEL_PROVIDER_IDENTITY_CONSISTENT",
    ]);
    if (failed.some((g) => AUTHORITY.has(g))) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_PROVIDER_INELIGIBLE",
        JSON.stringify({ model_entry_id: modelEntryId, failed_gates: failed }),
      );
    }
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_UNAVAILABLE",
      JSON.stringify({ model_entry_id: modelEntryId, failed_gates: failed }),
    );
  }
  return model;
}

export const CEO_DECISION_ENTITY = "ceo_decision";
export const CEO_DECISION_ATTEMPT_ENTITY = "ceo_decision_attempt";
export const CEO_DECISION_SCHEMA_VERSION = "pair.os.vnext.ceo-decision.v1";
export const CEO_ATTEMPT_SCHEMA_VERSION = "pair.os.vnext.ceo-decision-attempt.v1";

export const CEO_CYCLE_MAX_PER_OBJECTIVE = 64;
export const CEO_MAX_ATTEMPTS_PER_OBSERVATION = 2;
/** Immutable attempt-lifecycle anchors (R2.C): a generic persistence
 *  row is never attempt authority — every canonical attempt carries
 *  exactly one START anchor, and exactly one SETTLE anchor per
 *  terminal state. */
export const CEO_ATTEMPT_STARTED_EVENT = "CEO_DECISION_ATTEMPT_STARTED";
export const CEO_ATTEMPT_SETTLED_EVENT = "CEO_DECISION_ATTEMPT_SETTLED";
/** Bounded safety margin added to the effective CEO invocation timeout
 *  when computing the stale-attempt reconciliation grace — the grace
 *  must be STRICTLY greater than the longest permitted invocation
 *  window so a STARTED attempt is never reconciled UNKNOWN while its
 *  invocation may still be in flight. */
export const CEO_ATTEMPT_STALE_MARGIN_MS = 60_000;
/** Default stale grace = default invocation timeout + margin. An env or
 *  injected timeout above the default derives a larger effective grace
 *  at runtime — see {@link CeoPlanningCycleService.effectiveGraceMs}.
 *  Never assume the provider was not called. */
export const CEO_ATTEMPT_STALE_GRACE_MS =
  CEO_CLI_TIMEOUT.defaultValue + CEO_ATTEMPT_STALE_MARGIN_MS;
export const CEO_INVOKE_TIMEOUT_MS = CEO_CLI_TIMEOUT.defaultValue;

export function ceoCycleId(objectiveId: string, observationDigest: string): string {
  return `CCY_${digest(`ceo-cycle:${objectiveId}:${observationDigest}`).slice(0, 24)}`;
}
export function ceoDecisionId(objectiveId: string, cycleId: string): string {
  return `CCD_${digest(`ceo-decision:${objectiveId}:${cycleId}`).slice(0, 24)}`;
}
export function ceoAttemptId(objectiveId: string, cycleId: string, n: number): string {
  return `CCA_${digest(`ceo-attempt:${objectiveId}:${cycleId}:${n}`).slice(0, 24)}`;
}

// ---------------------------------------------------------------------
// Canonical observation snapshot (§2/§3)
// ---------------------------------------------------------------------

export interface CeoObservationDeps {
  store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
  /** The ONE P14 canonical completion proof (R2.A) — bound to
   *  BusinessLayer.proveWorkItemDone. A mutable status claim is NEVER
   *  completion authority; the observation only exposes the proof bit. */
  proveWorkItemDone: (row: Row) => boolean;
}

/**
 * Deterministic canonical snapshot — objective terms + canonical P15.2
 * binding identity + canonical per-workstream state projection. Built
 * ONLY through the strict authority reads (objectives.get /
 * workstreams.getBinding run their full canonical validators), so a
 * forged objective or binding fails closed BEFORE any model call.
 */
export function buildCeoObservation(
  deps: CeoObservationDeps,
  objectiveId: string,
): { observation: Record<string, unknown>; observation_digest: string } {
  const obj = deps.objectives.get(objectiveId); // strict canonical read
  const binding = deps.workstreams.getBinding(objectiveId); // strict validator
  const workstreams: Array<Record<string, unknown>> = [];
  if (binding) {
    for (const w of binding.workstreams as Array<Record<string, unknown>>) {
      const wi = deps.store.get("work_item", String(w.work_item_id)) as Row;
      // The observed status must be a member of the canonical P14
      // vocabulary — arbitrary strings are never strategic state.
      if (!(WORK_ITEM_STATUSES as readonly string[]).includes(String(wi.status ?? ""))) {
        throw new IntegrityError(
          "FAIL_CLOSED_CEO_OBSERVATION",
          `work_item ${String(w.work_item_id)} status ${String(wi.status)} is not canonical`,
        );
      }
      workstreams.push({
        workstream_key: String(w.workstream_key),
        work_item_id: String(w.work_item_id),
        status: String(wi.status),
        version: Number(wi.version),
        assignee_agent_id: wi.assignee_agent_id ?? null,
        blocked_code: wi.blocked_code ?? null,
        // R2.A — completion authority is P14's canonical proof
        // (status DONE + work_completion WCP_<id> + anchor + full
        // provenance chain), never the mutable status claim. Status
        // and proof remain distinct fields.
        completion_proven: deps.proveWorkItemDone(wi) === true,
      });
    }
  }
  const kpis = ((obj.kpis as Array<Record<string, unknown>>) ?? []).map((k) => ({
    kpi_id: String(k.kpi_id ?? ""),
    name: String(k.name ?? ""),
    unit: k.unit ?? null,
    direction: String(k.direction ?? ""),
    baseline: k.baseline ?? 0,
    target: k.target,
    current: k.current ?? null,
  }));
  const budget = (obj.budget ?? {}) as Record<string, unknown>;
  const observation = {
    schema: CEO_OBSERVATION_SCHEMA,
    objective: {
      objective_id: String(obj.objective_id),
      business_id: String(obj.business_id),
      title: String(obj.title ?? ""),
      statement: String(obj.statement ?? ""),
      status: String(obj.status),
      deadline: obj.deadline ?? null,
      objective_version: Number(obj.version),
      terms_version: Number(obj.terms_version),
      objective_digest: String(obj.objective_digest),
      budget_ceiling_microusd: Number(budget.ceiling_microusd ?? 0),
      budget_consumed_microusd: Number(budget.consumed_microusd ?? 0),
      currency: String(budget.currency ?? "USD"),
      kpis,
    },
    binding: binding
      ? {
          binding_id: String(binding.binding_id),
          binding_digest: String(binding.binding_digest),
          objective_version_at_commit: Number(binding.objective_version_at_commit),
          objective_terms_version: Number(binding.objective_terms_version),
          objective_digest: String(binding.objective_digest),
          normalized_proposal_digest: String(binding.normalized_proposal_digest),
          decomposition_id: String(binding.decomposition_id),
          root_work_item_id: String(binding.root_work_item_id),
        }
      : null,
    workstreams,
  };
  return { observation, observation_digest: digest(observation) };
}

// ---------------------------------------------------------------------
// Canonical validators — decision receipt + attempt lifecycle
// ---------------------------------------------------------------------

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_CEO_DECISION", detail);
}

export function ceoDecisionDigest(r: Record<string, unknown>): string {
  return digest({
    schema_version: CEO_DECISION_SCHEMA_VERSION,
    decision_id: r.decision_id,
    cycle_id: r.cycle_id,
    objective_id: r.objective_id,
    business_id: r.business_id,
    observation_digest: r.observation_digest,
    objective_version: r.objective_version,
    objective_terms_version: r.objective_terms_version,
    objective_digest: r.objective_digest,
    decision_kind: r.decision_kind,
    proposal: r.proposal,
    canonical_proposal_digest: r.canonical_proposal_digest,
    model_entry_id: r.model_entry_id,
    provider_id: r.provider_id,
    model_id: r.model_id,
    attempt_id: r.attempt_id,
    observed_binding_id: r.observed_binding_id ?? null,
    observed_binding_digest: r.observed_binding_digest ?? null,
    result_binding_id: r.result_binding_id ?? null,
    result_binding_digest: r.result_binding_digest ?? null,
    state: r.state,
    created_by: r.created_by,
    created_at: r.created_at,
  });
}

/** Immutable START-identity digest — pins every field that fixes the
 *  attempt's identity at claim time (R2.C + R3.D `started_by`). */
export function ceoAttemptStartDigest(f: {
  attempt_id: string; cycle_id: string; objective_id: string;
  business_id: string; observation_digest: string; attempt_number: number;
  model_entry_id: string; provider_id: string; model_id: string;
  started_at: string; started_by: string;
}): string {
  return digest({ ceo_attempt_start: 1, ...f });
}

/** Immutable SETTLE transition digest — pins the narrow STARTED→*
 *  transition fields (R2.C + R3.D `settled_by` actor provenance). */
export function ceoAttemptSettleDigest(f: {
  attempt_id: string; to: string; settled_at: string;
  response_digest: string | null; canonical_proposal_digest: string | null;
  failure_code: string | null; settled_by: string;
}): string {
  return digest({ ceo_attempt_settle: 1, from: "STARTED", ...f });
}

function attemptFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_CEO_DECISION_ATTEMPT", detail);
}

/** R4.B — the EXACT field allowlist of a canonical ceo_decision_attempt
 *  row: canonical fields + the store envelope (entity_type, entity_id,
 *  version). ANY other key is shadow authority — fail closed. */
const CEO_ATTEMPT_ALLOWED_FIELDS = new Set([
  "schema_version", "attempt_id", "cycle_id", "objective_id", "business_id",
  "observation_digest", "attempt_number", "model_entry_id", "provider_id",
  "model_id", "started_at", "started_by", "state", "settled_at",
  "response_digest", "canonical_proposal_digest", "failure_code",
  "entity_type", "entity_id", "version",
]);

/** R4.B — the EXACT field allowlist of a canonical ceo_decision row. */
const CEO_DECISION_ALLOWED_FIELDS = new Set([
  "schema_version", "decision_id", "cycle_id", "objective_id", "business_id",
  "observation_digest", "objective_version", "objective_terms_version",
  "objective_digest", "decision_kind", "proposal", "canonical_proposal_digest",
  "model_entry_id", "provider_id", "model_id", "attempt_id",
  "observed_binding_id", "observed_binding_digest",
  "result_binding_id", "result_binding_digest",
  "state", "created_by", "created_at", "decision_digest",
  "entity_type", "entity_id", "version",
]);

/**
 * Canonical attempt authority (R2.C). A generic store.put row is NOT an
 *  attempt: identity is deterministic, and every attempt must carry
 *  exactly one immutable START anchor (pinning all start fields +
 *  `start_identity_digest`) plus — for terminal states — exactly one
 *  SETTLE anchor (pinning from=STARTED, to, settled_at, response_digest,
 *  canonical_proposal_digest, failure_code + `settle_digest`). Row
 *  fields must equal the anchored transition fields.
 */
export function assertCanonicalCeoAttempt(store: PairEvidenceStore, row: Row): void {
  // R4.B — exact shape: every unknown/shadow field is authority forgery.
  for (const k of Object.keys(row)) {
    if (!CEO_ATTEMPT_ALLOWED_FIELDS.has(k)) {
      attemptFail(`attempt unknown field ${k}`);
    }
  }
  if (String(row.schema_version ?? "") !== CEO_ATTEMPT_SCHEMA_VERSION) attemptFail("attempt schema_version");
  if (String(row.entity_type ?? "") !== CEO_DECISION_ATTEMPT_ENTITY) {
    attemptFail("attempt entity_type mismatch");
  }
  for (const f of ["attempt_id", "cycle_id", "objective_id", "business_id",
    "observation_digest", "state", "model_entry_id", "provider_id",
    "model_id", "started_at"] as const) {
    if (typeof row[f] !== "string" || !(row[f] as string)) attemptFail(`attempt ${f} malformed`);
  }
  if (!Number.isInteger(row.attempt_number) || Number(row.attempt_number) < 1) {
    attemptFail("attempt_number malformed");
  }
  const state = String(row.state);
  if (!["STARTED", "ACCEPTED", "REJECTED", "STALE", "UNKNOWN"].includes(state)) {
    attemptFail(`attempt state ${state}`);
  }
  // R4.B — lifecycle cardinality: the row is written exactly twice —
  // once at claim (version 1, STARTED) and once at settle (version 2,
  // terminal). Any other version is a generic rewrite, never authority.
  if (String(row.entity_id ?? "") !== String(row.attempt_id ?? "")) {
    attemptFail("attempt entity_id != attempt_id");
  }
  if (Number(row.version) !== (state === "STARTED" ? 1 : 2)) {
    attemptFail(`attempt version ${String(row.version)} != ${state === "STARTED" ? 1 : 2}`);
  }
  // Deterministic identity — the row must name the id/cycle its own
  // pinned fields recompute to.
  if (String(row.cycle_id) !==
      ceoCycleId(String(row.objective_id), String(row.observation_digest))) {
    attemptFail("attempt cycle_id identity mismatch");
  }
  if (String(row.attempt_id) !== ceoAttemptId(
    String(row.objective_id), String(row.cycle_id), Number(row.attempt_number))) {
    attemptFail("attempt_id identity mismatch");
  }
  const events = store.listEvents(CEO_DECISION_ATTEMPT_ENTITY, String(row.attempt_id));
  const starts = events.filter((e) => String(e.event_type) === CEO_ATTEMPT_STARTED_EVENT);
  const settles = events.filter((e) => String(e.event_type) === CEO_ATTEMPT_SETTLED_EVENT);
  if (starts.length !== 1) attemptFail(`attempt ${String(row.attempt_id)}: ${starts.length} START anchors`);
  const s = starts[0]!;
  if (String(s.new_state ?? "") !== "STARTED" || (s.old_state ?? null) !== null) {
    attemptFail("START anchor header mismatch");
  }
  // R3.D — the START event actor IS the claimer: `operator:${started_by}`.
  // `started_by` lives inside the immutable start identity — tampering
  // the row, the anchor metadata, or the event actor all fail closed.
  if (typeof row.started_by !== "string" || !String(row.started_by).trim() ||
      String(row.started_by).length > 256) {
    attemptFail("attempt started_by malformed");
  }
  if (String(s.actor ?? "") !== `operator:${String(row.started_by)}`) {
    attemptFail("START anchor actor != operator:started_by");
  }
  const smd = (s.metadata ?? {}) as Record<string, unknown>;
  const startFields = {
    attempt_id: String(row.attempt_id),
    cycle_id: String(row.cycle_id),
    objective_id: String(row.objective_id),
    business_id: String(row.business_id),
    observation_digest: String(row.observation_digest),
    attempt_number: Number(row.attempt_number),
    model_entry_id: String(row.model_entry_id),
    provider_id: String(row.provider_id),
    model_id: String(row.model_id),
    started_at: String(row.started_at),
    started_by: String(row.started_by),
  };
  for (const [k, v] of Object.entries(startFields)) {
    if (smd[k] !== v) attemptFail(`START anchor ${k} mismatch`);
  }
  if (String(smd.start_identity_digest ?? "") !== ceoAttemptStartDigest(startFields)) {
    attemptFail("START anchor identity digest mismatch");
  }
  // Transition evidence per state — one narrow seam, immutable anchor.
  const settleField = (r: Row, f: string): string | null =>
    r[f] === null || r[f] === undefined ? null : String(r[f]);
  if (state === "STARTED") {
    if (settles.length !== 0) attemptFail("STARTED attempt carries a settle anchor");
    if (row.settled_at !== null && row.settled_at !== undefined) {
      attemptFail("STARTED attempt has settled_at");
    }
    return;
  }
  if (settles.length !== 1) attemptFail(`attempt ${String(row.attempt_id)}: ${settles.length} SETTLE anchors`);
  const st = settles[0]!;
  if (String(st.old_state ?? "") !== "STARTED" || String(st.new_state ?? "") !== state) {
    attemptFail("SETTLE anchor header mismatch");
  }
  const tmd = (st.metadata ?? {}) as Record<string, unknown>;
  // R3.D — the settlement actor is deterministic: in-cycle settles are
  // the claimer; system stale reconciliation is `operator:system`.
  const expectedSettler =
    state === "UNKNOWN" ? "operator:system" : `operator:${String(row.started_by)}`;
  if (String(st.actor ?? "") !== expectedSettler) {
    attemptFail(`SETTLE anchor actor ${String(st.actor)} != ${expectedSettler}`);
  }
  if (String(tmd.settled_by ?? "") !== expectedSettler) {
    attemptFail("SETTLE settled_by pin mismatch");
  }
  if (String(tmd.attempt_id ?? "") !== String(row.attempt_id) ||
      String(tmd.from ?? "") !== "STARTED" || String(tmd.to ?? "") !== state) {
    attemptFail("SETTLE anchor transition mismatch");
  }
  if (row.settled_at === null || row.settled_at === undefined ||
      String(tmd.settled_at ?? "") !== String(row.settled_at)) {
    attemptFail("SETTLE settled_at mismatch");
  }
  for (const f of ["response_digest", "canonical_proposal_digest", "failure_code"] as const) {
    if ((tmd[f] ?? null) !== settleField(row, f)) attemptFail(`SETTLE anchor ${f} mismatch`);
  }
  if (String(tmd.settle_digest ?? "") !== ceoAttemptSettleDigest({
    attempt_id: String(row.attempt_id),
    to: state,
    settled_at: String(row.settled_at),
    response_digest: settleField(row, "response_digest"),
    canonical_proposal_digest: settleField(row, "canonical_proposal_digest"),
    failure_code: settleField(row, "failure_code"),
    settled_by: expectedSettler,
  })) {
    attemptFail("SETTLE anchor digest mismatch");
  }
  // Per-state required evidence.
  if (state === "ACCEPTED") {
    if (settleField(row, "response_digest") === null ||
        settleField(row, "canonical_proposal_digest") === null ||
        settleField(row, "failure_code") !== null) {
      attemptFail("ACCEPTED attempt missing response/proposal digest or carries failure_code");
    }
  } else if (state === "REJECTED") {
    if (settleField(row, "failure_code") === null) attemptFail("REJECTED attempt missing failure_code");
  } else if (state === "STALE") {
    if (settleField(row, "failure_code") !== "CEO_OBSERVATION_STALE" ||
        settleField(row, "canonical_proposal_digest") === null) {
      attemptFail("STALE attempt evidence mismatch");
    }
  } else if (state === "UNKNOWN") {
    if (settleField(row, "failure_code") !== "CEO_ATTEMPT_RECONCILED") {
      attemptFail("UNKNOWN attempt must carry CEO_ATTEMPT_RECONCILED");
    }
  }
}

/**
 * Strict canonical read of a ceo_decision receipt: full self-consistency
 * digest + EXACTLY ONE immutable CEO_DECISION_COMMITTED anchor whose
 * header AND pinned fields match, + the linked attempt must exist,
 * match the receipt's identity fields, and be ACCEPTED.
 */
export function assertCanonicalCeoDecision(deps: CeoObservationDeps, row: Row): void {
  const { store } = deps;
  // R4.B — exact shape: every unknown/shadow field is authority forgery
  // (executor_id / mission_id / assignee_agent_id / selected_model /
  // router / telegram / arbitrary authority-looking metadata).
  for (const k of Object.keys(row)) {
    if (!CEO_DECISION_ALLOWED_FIELDS.has(k)) fail(`decision unknown field ${k}`);
  }
  if (String(row.entity_type ?? "") !== CEO_DECISION_ENTITY) fail("entity_type mismatch");
  if (String(row.entity_id ?? "") !== String(row.decision_id ?? "")) {
    fail("entity_id != decision_id");
  }
  if (String(row.schema_version ?? "") !== CEO_DECISION_SCHEMA_VERSION) fail("schema_version");
  for (const f of ["decision_id", "cycle_id", "objective_id", "business_id",
    "observation_digest", "decision_kind", "canonical_proposal_digest",
    "model_entry_id", "provider_id", "model_id", "attempt_id",
    "state", "created_by", "created_at"] as const) {
    if (typeof row[f] !== "string" || !(row[f] as string)) fail(`${f} malformed`);
  }
  if (!Number.isInteger(row.objective_version) || !Number.isInteger(row.objective_terms_version)) {
    fail("objective pins malformed");
  }
  if (!Object.values(CEO_DECISION_KIND).includes(String(row.decision_kind) as never)) {
    fail(`decision_kind ${String(row.decision_kind)}`);
  }
  if (String(row.state) !== "COMMITTED") fail("state != COMMITTED");
  // R2.B — the receipt must re-prove its own identity: cycle/decision
  // ids are deterministic functions of the pinned fields, and the
  // stored proposal must pass the ONE canonical proposal validator
  // (exact discriminated-variant fields — no contradictory leftovers).
  if (String(row.cycle_id) !==
      ceoCycleId(String(row.objective_id), String(row.observation_digest))) {
    fail("cycle_id identity mismatch");
  }
  if (String(row.decision_id) !==
      ceoDecisionId(String(row.objective_id), String(row.cycle_id))) {
    fail("decision_id identity mismatch");
  }
  let canonicalProposal: CeoProposal;
  try {
    canonicalProposal = validateCanonicalCeoProposal(row.proposal);
  } catch (err) {
    fail(`proposal invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (String(row.decision_kind) !== canonicalProposal.decision_kind) {
    fail("decision_kind != proposal decision_kind");
  }
  if (String(row.canonical_proposal_digest) !== ceoProposalDigest(canonicalProposal)) {
    fail("canonical_proposal_digest mismatch");
  }
  // Strict-read the canonical Objective — it must exist and the
  // receipt's business binding must agree with it (a foreign business
  // never counts). Historical version/digest pins are NOT required to
  // equal current state after a legitimate amendment — the immutable
  // anchor preserves the historical snapshot identity.
  const obj = deps.objectives.get(String(row.objective_id));
  if (String(obj.business_id) !== String(row.business_id)) {
    fail("receipt business_id foreign to canonical Objective");
  }
  if (String(row.decision_digest ?? "") !== ceoDecisionDigest(row)) {
    fail("decision_digest mismatch");
  }
  // R4.B — create-only cardinality: the committed decision is written
  // exactly once (store version 1). A later generic rewrite — even one
  // preserving every canonical field — is no longer authority.
  if (Number(row.version) !== 1) fail(`decision version ${String(row.version)} != 1`);
  // Anchor — exactly one immutable commit event; header AND pins.
  const anchors = store
    .listEvents(CEO_DECISION_ENTITY, String(row.decision_id))
    .filter((e) => String(e.event_type) === "CEO_DECISION_COMMITTED");
  if (anchors.length !== 1) fail(`expected 1 anchor, got ${anchors.length}`);
  const a = anchors[0]!;
  if (String(a.actor) !== `operator:${String(row.created_by)}` ||
      String(a.new_state) !== "COMMITTED" ||
      (a.old_state ?? null) !== null) {
    fail("anchor header mismatch");
  }
  const md = (a.metadata ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries({
    decision_id: String(row.decision_id),
    decision_digest: String(row.decision_digest),
    cycle_id: String(row.cycle_id),
    objective_id: String(row.objective_id),
    business_id: String(row.business_id),
    observation_digest: String(row.observation_digest),
    canonical_proposal_digest: String(row.canonical_proposal_digest),
    decision_kind: String(row.decision_kind),
    attempt_id: String(row.attempt_id),
    result_binding_id: row.result_binding_id ?? null,
    result_binding_digest: row.result_binding_digest ?? null,
  })) {
    if (md[k] !== v) fail(`anchor ${k} mismatch`);
  }
  // Linked attempt — must exist, be canonical, and carry the same
  // authority provenance the receipt claims.
  const attempt = store.tryGet(CEO_DECISION_ATTEMPT_ENTITY, String(row.attempt_id)) as Row | null;
  if (!attempt) fail("attempt missing");
  assertCanonicalCeoAttempt(store, attempt);
  if (String(attempt.attempt_id) !== String(row.attempt_id) ||
      String(attempt.state) !== "ACCEPTED" ||
      String(attempt.cycle_id) !== String(row.cycle_id) ||
      String(attempt.objective_id) !== String(row.objective_id) ||
      String(attempt.business_id) !== String(row.business_id) ||
      String(attempt.observation_digest) !== String(row.observation_digest) ||
      String(attempt.model_entry_id) !== String(row.model_entry_id) ||
      String(attempt.provider_id) !== String(row.provider_id) ||
      String(attempt.model_id) !== String(row.model_id) ||
      String(attempt.canonical_proposal_digest ?? "") !== String(row.canonical_proposal_digest)) {
    fail("attempt identity/provenance mismatch");
  }
  // R4.C — end-to-end actor provenance: the operator who committed the
  // decision IS the operator who started the ACCEPTED attempt. A
  // receipt forged for a different creator — however internally
  // consistent — can never pass this link.
  if (String(row.created_by) !== String(attempt.started_by)) {
    fail("decision created_by != attempt started_by");
  }
  // Binding semantics — a pinned P15.2 binding identity must resolve to
  // a canonically valid binding for THIS objective.
  const bindingId = objectiveWorkstreamBindingId(String(row.objective_id));
  if (row.observed_binding_id !== null && row.observed_binding_id !== undefined &&
      String(row.observed_binding_id) !== bindingId) {
    fail("observed_binding_id foreign");
  }
  if (row.result_binding_id !== null && row.result_binding_id !== undefined) {
    if (String(row.result_binding_id) !== bindingId) fail("result_binding_id foreign");
    const binding = deps.workstreams.getBinding(String(row.objective_id));
    if (!binding) fail("result binding missing");
    if (String(row.result_binding_digest) !== objectiveWorkstreamBindingDigest(binding)) {
      fail("result_binding_digest mismatch");
    }
    if (String(row.decision_kind) !== "INITIALIZE_WORKSTREAMS") {
      fail("result binding on non-INITIALIZE decision");
    }
  } else if (String(row.decision_kind) === "INITIALIZE_WORKSTREAMS") {
    fail("INITIALIZE missing result binding pin");
  }
  if (row.observed_binding_id !== null && row.observed_binding_id !== undefined) {
    const binding = deps.workstreams.getBinding(String(row.objective_id));
    if (!binding) fail("observed binding missing");
    if (String(row.observed_binding_digest) !== objectiveWorkstreamBindingDigest(binding)) {
      fail("observed_binding_digest mismatch");
    }
  }
}

// ---------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------

export interface CeoPlanningCycleDeps extends CeoObservationDeps {
  invoker: CeoDecisionInvoker;
  /** Configured CEO model — invocation identity, NOT a role assignment. */
  model_entry_id: string;
  timeout_ms?: number;
  stale_grace_ms?: number;
  now?: () => string;
  /** Post-claim seam (tests / instrumentation): fires after the
   *  STARTED attempt commits and BEFORE the canonical model-authority
   *  re-proof + provider call. */
  after_attempt_claim?: () => void;
}

export class CeoPlanningCycleService {
  constructor(private readonly deps: CeoPlanningCycleDeps) {}

  private get store(): PairEvidenceStore { return this.deps.store; }
  private now(): string { return (this.deps.now ?? utcnow)(); }

  private attemptsFor(cycleId: string): Row[] {
    return (this.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[])
      .filter((a) => String(a.cycle_id) === cycleId)
      .sort((a, b) => Number(a.attempt_number) - Number(b.attempt_number));
  }

  /** The ONE narrow transition seam (R2.C + R4.A): strict-read the
   *  CURRENT canonical attempt inside this transaction, require it is
   *  still STARTED, then apply the terminal state + emit the immutable
   *  CEO_DECISION_ATTEMPT_SETTLED anchor. A terminal attempt is
   *  immutable — no terminal→terminal transition, an UNKNOWN attempt
   *  can never resurrect to ACCEPTED, and the strict read already
   *  proves zero SETTLE anchors exist for a STARTED row. Must run
   *  inside an open transaction. */
  private applyAttemptSettle(
    attemptId: string,
    to: "ACCEPTED" | "REJECTED" | "STALE" | "UNKNOWN",
    fields: {
      response_digest?: string | null;
      canonical_proposal_digest?: string | null;
      failure_code?: string | null;
    },
    actor: string,
  ): void {
    const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, attemptId) as Row;
    // R4.A — canonical transition gate: the row must be a canonical
    // attempt AND still in the only non-terminal state.
    assertCanonicalCeoAttempt(this.store, cur);
    if (String(cur.state) !== "STARTED") {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_DECISION_ATTEMPT",
        `attempt ${attemptId} is terminal (${String(cur.state)}) — transitions are append-only`,
      );
    }
    const settled_at = this.now();
    const next: Row = {
      ...cur,
      state: to,
      settled_at,
      response_digest: fields.response_digest !== undefined ? fields.response_digest : cur.response_digest,
      canonical_proposal_digest: fields.canonical_proposal_digest !== undefined
        ? fields.canonical_proposal_digest : cur.canonical_proposal_digest,
      failure_code: fields.failure_code !== undefined ? fields.failure_code : cur.failure_code,
    };
    this.store.put(CEO_DECISION_ATTEMPT_ENTITY, attemptId, next, Number(cur.version));
    const pins = {
      attempt_id: attemptId,
      from: "STARTED",
      to,
      settled_at,
      settled_by: `operator:${actor}`,
      response_digest: (next.response_digest as string | null) ?? null,
      canonical_proposal_digest: (next.canonical_proposal_digest as string | null) ?? null,
      failure_code: (next.failure_code as string | null) ?? null,
    };
    this.store.event({
      entity_type: CEO_DECISION_ATTEMPT_ENTITY,
      entity_id: attemptId,
      event_type: CEO_ATTEMPT_SETTLED_EVENT,
      old_state: "STARTED",
      new_state: to,
      actor: `operator:${actor}`,
      metadata: {
        ...pins,
        settle_digest: ceoAttemptSettleDigest({
          attempt_id: pins.attempt_id,
          to: pins.to,
          settled_at: pins.settled_at,
          settled_by: pins.settled_by,
          response_digest: pins.response_digest,
          canonical_proposal_digest: pins.canonical_proposal_digest,
          failure_code: pins.failure_code,
        }),
      },
    });
  }

  private settleAttempt(
    attempt: Row,
    state: "ACCEPTED" | "REJECTED" | "STALE" | "UNKNOWN",
    extra: {
      response_digest?: string | null;
      canonical_proposal_digest?: string | null;
      failure_code?: string | null;
    },
    actor: string,
  ): void {
    this.store.immediate(() => {
      const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, String(attempt.attempt_id)) as Row;
      if (String(cur.state) !== "STARTED") return; // already settled — converged
      this.applyAttemptSettle(String(attempt.attempt_id), state, extra, actor);
    });
  }

  /** R2.D — fresh canonical CEO-model proof run AFTER the STARTED
   *  attempt commits and immediately before the provider call. Zero
   *  write-transaction is held during the network call. */
  private reproveModelAuthority(attempt: Row): void {
    // R3.B — transport identity re-proof FIRST: a mid-flight provider
    // drift is a provenance violation (NON_CODEX_TRANSPORT), reported
    // before the broader eligibility degradation codes.
    const transport = resolveCeoModelTransport(this.store, this.deps.model_entry_id);
    this.assertCeoModelUsable(this.deps.model_entry_id);
    if (transport.model_entry_id !== String(attempt.model_entry_id) ||
        transport.provider_id !== String(attempt.provider_id) ||
        transport.model_id !== String(attempt.model_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_MODEL_UNRESOLVED",
        "configured CEO model identity drifted since attempt claim",
      );
    }
  }

  private assertCeoModelUsable(modelEntryId: string): Record<string, unknown> {
    return assertCeoModelUsable(this.store, modelEntryId);
  }

  /**
   * ONE bounded observation/decision cycle. Replay-safe: the same
   * canonical state returns the existing committed decision with ZERO
   * model calls.
   */
  async runCycle(input: {
    objective_id: string;
    actor: string;
    /** P15.10-C R1: optional fenced commit guard for autonomous callers.
     * When provided it is invoked inside the serialized write transaction
     * that performs the final post-await commit — before any decision row,
     * workstream decomposition, or attempt settlement. A thrown error
     * rolls the whole commit back; the invoked attempt is then settled
     * REJECTED by the existing terminal settle path. Manual callers that
     * omit it behave exactly as before. */
    autonomous_commit_guard?: () => void;
  }): Promise<{
    decision: Row;
    binding: Row | null;
    attempt_id: string;
    replayed: boolean;
  }> {
    // 1. Actor runtime shape FIRST — before evaluateDeadline and any
    //    transaction, matching the P15.2/P15.1 admission contract.
    if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "ceo.runCycle");
    }
    const actor = input.actor;
    const objectiveId = String(input.objective_id ?? "");
    if (!objectiveId || objectiveId.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_CEO_DECISION", "objective_id malformed");
    }
    // 2. P15.1 deadline semantics (may commit EXPIRED in its own txn).
    this.deps.objectives.evaluateDeadline(objectiveId);
    // 3. Status gate — NEW CEO invocations only for canonical ACTIVE.
    const obj = this.deps.objectives.get(objectiveId);
    if (String(obj.status) !== "ACTIVE") {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_OBJECTIVE_NOT_ACTIVE",
        `objective ${objectiveId} status ${String(obj.status)}`,
      );
    }
    // 4. Canonical observation.
    const first = buildCeoObservation(this.deps, objectiveId);
    // R2.F — serialized model-input bound (UTF-8 bytes): oversized
    // observation fails closed BEFORE any attempt/invocation; the
    // canonical state is never truncated to fit.
    const userPrompt = buildCeoUserPrompt(first.observation);
    if (Buffer.byteLength(userPrompt, "utf8") > CEO_MAX_OBSERVATION_BYTES) {
      throw new IntegrityError(
        "FAIL_CLOSED_CEO_OBSERVATION_TOO_LARGE",
        `observation exceeds ${CEO_MAX_OBSERVATION_BYTES} bytes`,
      );
    }
    const cycleId = ceoCycleId(objectiveId, first.observation_digest);
    const decisionId = ceoDecisionId(objectiveId, cycleId);
    // 5. Replay — same canonical state already has an ACCEPTED decision.
    const existing = this.store.tryGet(CEO_DECISION_ENTITY, decisionId) as Row | null;
    if (existing) {
      assertCanonicalCeoDecision(this.deps, existing);
      const binding = this.deps.workstreams.getBinding(objectiveId);
      return { decision: existing, binding, attempt_id: String(existing.attempt_id), replayed: true };
    }
    // 6. Hard cycle bound (R2.E) — counts CANONICAL decision cycles
    //    only; a malformed row attributed to this objective is corrupt
    //    authority and fails closed, never silently skipped.
    let cycles = 0;
    for (const d of this.store.list(CEO_DECISION_ENTITY) as Row[]) {
      if (String(d.objective_id) !== objectiveId) continue;
      assertCanonicalCeoDecision(this.deps, d);
      cycles++;
    }
    if (cycles >= CEO_CYCLE_MAX_PER_OBJECTIVE) {
      throw new IntegrityError("FAIL_CLOSED_CEO_CYCLE_LIMIT", objectiveId);
    }
    // 7. Model eligibility — before claiming any attempt.
    const model = this.assertCeoModelUsable(this.deps.model_entry_id);
    const transport = resolveCeoModelTransport(this.store, this.deps.model_entry_id);
    // R3 — resolve AND validate the effective invocation timeout BEFORE
    //    any durable attempt is claimed: an invalid PAIR_CEO_CLI_TIMEOUT_MS
    //    must fail closed with ZERO attempt rows, never burn an attempt
    //    slot inside the 2-attempt budget.
    const effectiveTimeoutMs = this.deps.timeout_ms ?? ceoCliTimeoutMs();
    // 8. Claim the attempt inside a serializing transaction — at most
    //    ONE live invocation per observation; ≤2 attempts ever. Only
    //    canonical attempts count; a malformed attempt row is corrupt
    //    authority and fails closed. The immutable START anchor pins
    //    the claim-time identity in the same transaction.
    const businessId0 = String(
      (first.observation.objective as Record<string, unknown>).business_id);
    const attemptNumber = this.store.immediate(() => {
      const attempts = this.attemptsFor(cycleId);
      for (const a of attempts) {
        assertCanonicalCeoAttempt(this.store, a);
        if (String(a.business_id) !== businessId0) {
          fail("attempt business_id foreign to objective");
        }
      }
      if (attempts.some((a) => String(a.state) === "STARTED")) {
        throw new IntegrityError("FAIL_CLOSED_CEO_DECISION_INFLIGHT", cycleId);
      }
      if (attempts.length >= CEO_MAX_ATTEMPTS_PER_OBSERVATION) {
        throw new IntegrityError("FAIL_CLOSED_CEO_ATTEMPT_LIMIT", cycleId);
      }
      const n = attempts.length + 1;
      const attemptId = ceoAttemptId(objectiveId, cycleId, n);
      const startedAt = this.now();
      const startFields = {
        attempt_id: attemptId,
        cycle_id: cycleId,
        objective_id: objectiveId,
        business_id: businessId0,
        observation_digest: first.observation_digest,
        attempt_number: n,
        model_entry_id: transport.model_entry_id,
        provider_id: transport.provider_id,
        model_id: transport.model_id,
        started_at: startedAt,
        started_by: actor,
      };
      this.store.put(CEO_DECISION_ATTEMPT_ENTITY, attemptId, {
        schema_version: CEO_ATTEMPT_SCHEMA_VERSION,
        ...startFields,
        state: "STARTED",
        settled_at: null,
        response_digest: null,
        canonical_proposal_digest: null,
        failure_code: null,
        version: 0,
      } as Row, 0);
      this.store.event({
        entity_type: CEO_DECISION_ATTEMPT_ENTITY,
        entity_id: attemptId,
        event_type: CEO_ATTEMPT_STARTED_EVENT,
        old_state: null,
        new_state: "STARTED",
        actor: `operator:${actor}`,
        metadata: {
          ...startFields,
          start_identity_digest: ceoAttemptStartDigest(startFields),
        },
      });
      return n;
    });
    const attemptId = ceoAttemptId(objectiveId, cycleId, attemptNumber);
    const attempt = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, attemptId) as Row;

    // Post-claim seam (R2.D ordering): any authority mutation between
    // observation and invocation lands here — the re-proof below then
    // refuses the provider call.
    this.deps.after_attempt_claim?.();

    // R2.D — fresh canonical eligibility proof immediately BEFORE the
    // provider call; failure settles the attempt REJECTED with zero
    // invocations.
    try {
      this.reproveModelAuthority(attempt);
    } catch (err) {
      this.settleAttempt(attempt, "REJECTED", {
        failure_code: err instanceof IntegrityError
          ? String(err.code).replace(/^FAIL_CLOSED_/, "")
          : "CEO_MODEL_REPROOF_FAILED",
      }, actor);
      throw err;
    }

    // 9. Invoke — exactly ONE provider call per attempt, no retries,
    //    no synthetic fallback.
    let proposal: CeoProposal;
    let responseDigest: string | null = null;
    try {
      const res = await this.deps.invoker.invoke({
        transport,
        system_prompt: ceoDecisionSystemPrompt(),
        user_prompt: buildCeoUserPrompt(first.observation),
        observation_digest: first.observation_digest,
        timeout_ms: effectiveTimeoutMs,
      });
      responseDigest = digest(res.raw_text);
      // The configured/injected model_entry must equal the identity the
      // invoker reports.
      if (String(res.model_entry_id) !== transport.model_entry_id ||
          String(res.model_id) !== String(model.model_id) ||
          (res.provider_id && String(res.provider_id) !== transport.provider_id)) {
        throw new IntegrityError("FAIL_CLOSED_CEO_INVOCATION", "CEO_MODEL_IDENTITY_MISMATCH");
      }
      proposal = parseCeoDecisionText(res.raw_text);
    } catch (err) {
      // Idempotent settle — the invoked attempt can never stay STARTED.
      this.settleAttempt(attempt, "REJECTED", {
        failure_code: err instanceof IntegrityError
          ? String(err.code).replace(/^FAIL_CLOSED_/, "")
          : "CEO_INVOCATION_FAILED",
        ...(responseDigest !== null ? { response_digest: responseDigest } : {}),
      }, actor);
      // Invocation-layer failures surface as ONE deterministic typed code —
      // never raw exception text or provider details (§28).
      if (err instanceof IntegrityError) throw err;
      throw new IntegrityError("FAIL_CLOSED_CEO_INVOCATION", "invocation failed");
    }
    const proposalDigest = ceoProposalDigest(proposal);

    // 10. Final commit — re-observe + stale check + gate + receipt +
    //     anchor + attempt settlement in ONE serializing transaction.
    //     Anything that throws inside rolls the whole commit back; the
    //     invoked attempt then settles REJECTED outside the txn so it
    //     can never stay STARTED (a real invocation DID happen).
    let outcome: { stale: true } | { stale: false; decision: Row; binding: Row | null };
    try {
      outcome = this.store.immediate(() => {
      // P15.10-C R1 F1-C: fenced commit guard runs inside the same
      // serialized write transaction as the side effects it protects —
      // a revoked/expired autonomous authority can never commit a new
      // decision, workstream, or downstream mission post-await.
      input.autonomous_commit_guard?.();
      const fresh = buildCeoObservation(this.deps, objectiveId);
      if (fresh.observation_digest !== first.observation_digest) {
        // TOCTOU — the model decided against stale state. Settle STALE
        // (committed, with its immutable settle anchor) and let the
        // caller run a fresh cycle.
        this.applyAttemptSettle(attemptId, "STALE", {
          response_digest: responseDigest,
          canonical_proposal_digest: proposalDigest,
          failure_code: "CEO_OBSERVATION_STALE",
        }, actor);
        return { stale: true as const };
      }
      const freshObj = this.deps.objectives.get(objectiveId);
      const businessId = String(freshObj.business_id);
      let resultBindingId: string | null = null;
      let resultBindingDigest: string | null = null;
      const observedBinding = this.deps.workstreams.getBinding(objectiveId);

      switch (proposal.decision_kind) {
        case "INITIALIZE_WORKSTREAMS": {
          if (observedBinding) {
            throw new IntegrityError(
              "FAIL_CLOSED_CEO_GATE",
              "INITIALIZE_WORKSTREAMS invalid when a binding already exists",
            );
          }
          // Deterministic gate — the SAME P15.2 normalization/validation
          // semantics; the controller derives every authority field.
          const applied = this.deps.workstreams.decomposeObjective({
            objective_id: objectiveId,
            expected_objective_version: Number(freshObj.version),
            expected_terms_version: Number(freshObj.terms_version),
            expected_objective_digest: String(freshObj.objective_digest),
            workstreams: proposal.workstreams!.map((w) => ({
              workstream_key: w.workstream_key,
              title: w.title,
              goal: w.goal,
              depends_on_keys: w.depends_on_keys ?? [],
            })),
            actor,
          });
          resultBindingId = String(applied.binding.binding_id);
          resultBindingDigest = objectiveWorkstreamBindingDigest(applied.binding);
          break;
        }
        case "PRIORITIZE_EXISTING": {
          if (!observedBinding) {
            throw new IntegrityError(
              "FAIL_CLOSED_CEO_GATE",
              "PRIORITIZE_EXISTING requires a canonical binding",
            );
          }
          const keys = new Set(
            (observedBinding.workstreams as Array<Record<string, unknown>>)
              .map((w) => String(w.workstream_key)),
          );
          const po = proposal.priority_order!;
          if (po.length !== keys.size || new Set(po).size !== keys.size ||
              !po.every((k) => keys.has(k))) {
            throw new IntegrityError(
              "FAIL_CLOSED_CEO_GATE",
              "priority_order is not an exact permutation of canonical workstreams",
            );
          }
          break;
        }
        case "WAIT": break; // receipt only — zero work mutation
      }

      const decisionBody: Record<string, unknown> = {
        schema_version: CEO_DECISION_SCHEMA_VERSION,
        decision_id: decisionId,
        cycle_id: cycleId,
        objective_id: objectiveId,
        business_id: businessId,
        observation_digest: first.observation_digest,
        objective_version: Number(freshObj.version),
        objective_terms_version: Number(freshObj.terms_version),
        objective_digest: String(freshObj.objective_digest),
        decision_kind: proposal.decision_kind,
        proposal,
        canonical_proposal_digest: proposalDigest,
        model_entry_id: transport.model_entry_id,
        provider_id: transport.provider_id,
        model_id: transport.model_id,
        attempt_id: attemptId,
        observed_binding_id: observedBinding ? String(observedBinding.binding_id) : null,
        observed_binding_digest: observedBinding
          ? objectiveWorkstreamBindingDigest(observedBinding) : null,
        result_binding_id: resultBindingId,
        result_binding_digest: resultBindingDigest,
        state: "COMMITTED",
        created_by: actor,
        created_at: this.now(),
        version: 0,
      };
      decisionBody.decision_digest = ceoDecisionDigest(decisionBody);
      const decision = this.store.put(CEO_DECISION_ENTITY, decisionId, decisionBody as Row, 0);
      this.store.event({
        entity_type: CEO_DECISION_ENTITY,
        entity_id: decisionId,
        event_type: "CEO_DECISION_COMMITTED",
        new_state: "COMMITTED",
        actor: `operator:${actor}`,
        metadata: {
          decision_id: decisionId,
          decision_digest: String(decisionBody.decision_digest),
          cycle_id: cycleId,
          objective_id: objectiveId,
          business_id: businessId,
          observation_digest: first.observation_digest,
          canonical_proposal_digest: proposalDigest,
          decision_kind: proposal.decision_kind,
          attempt_id: attemptId,
          result_binding_id: resultBindingId,
          result_binding_digest: resultBindingDigest,
        },
      });
      this.applyAttemptSettle(attemptId, "ACCEPTED", {
        response_digest: responseDigest,
        canonical_proposal_digest: proposalDigest,
        failure_code: null,
      }, actor);
      const binding = this.deps.workstreams.getBinding(objectiveId);
      return { stale: false as const, decision, binding };
      });
    } catch (err) {
      this.settleAttempt(attempt, "REJECTED", {
        failure_code: err instanceof IntegrityError
          ? String(err.code).replace(/^FAIL_CLOSED_/, "")
          : "CEO_COMMIT_FAILED",
        ...(responseDigest !== null ? { response_digest: responseDigest } : {}),
        canonical_proposal_digest: proposalDigest,
      }, actor);
      if (err instanceof IntegrityError) throw err;
      throw new IntegrityError("FAIL_CLOSED_CEO_COMMIT", "commit failed");
    }
    if (outcome.stale) {
      throw new IntegrityError("FAIL_CLOSED_CEO_OBSERVATION_STALE", cycleId);
    }
    return {
      decision: outcome.decision,
      binding: outcome.binding,
      attempt_id: attemptId,
      replayed: false,
    };
  }

  /** Effective stale-attempt reconciliation grace. An explicit
   *  `stale_grace_ms` injection (tests/tooling) is authoritative and is
   *  NOT widened — callers opting into a custom grace own the margin.
   *  Otherwise the grace derives from the effective invocation timeout
   *  (`deps.timeout_ms` ?? `PAIR_CEO_CLI_TIMEOUT_MS` ?? default) plus
   *  {@link CEO_ATTEMPT_STALE_MARGIN_MS}, so a timeout configured above
   *  300s can never be reconciled UNKNOWN mid-invocation. */
  private effectiveGraceMs(): number {
    if (this.deps.stale_grace_ms !== undefined) return this.deps.stale_grace_ms;
    return (this.deps.timeout_ms ?? ceoCliTimeoutMs()) + CEO_ATTEMPT_STALE_MARGIN_MS;
  }

  /** Bounded stale-attempt reconciliation: a STARTED attempt older than
   *  the explicit grace may become UNKNOWN (never assumed un-invoked);
   *  only then may one bounded retry be admitted under the attempt
   *  ceiling. Returns the number reconciled. */
  reconcileStaleAttempts(objectiveId?: string): number {
    const grace = this.effectiveGraceMs();
    const now = Date.parse(this.now());

    let count = 0;
    for (const a of this.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[]) {
      if (objectiveId && String(a.objective_id) !== objectiveId) continue;
      if (String(a.state) !== "STARTED") continue;
      const started = Date.parse(String(a.started_at));
      if (!Number.isFinite(started) || now - started <= grace) continue;
      // The same narrow transition seam emits the canonical SETTLE
      // anchor — a direct row mutation is never canonical authority.
      this.settleAttempt(a, "UNKNOWN", {
        failure_code: "CEO_ATTEMPT_RECONCILED",
      }, "system");
      count++;
    }
    return count;
  }

  /** Strict read of the canonical decision for an objective+cycle. */
  getDecision(objectiveId: string, observationDigest: string): Row | null {
    const row = this.store.tryGet(
      CEO_DECISION_ENTITY,
      ceoDecisionId(objectiveId, ceoCycleId(objectiveId, observationDigest)),
    ) as Row | null;
    if (!row) return null;
    assertCanonicalCeoDecision(this.deps, row);
    return row;
  }
}
