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
import { modelRoleOf, sameCanonicalModel, MODEL_ROLE, listModelRoleAssignments } from "./model-role.js";
import { providerModelEligibility } from "./model-routable.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import {
  objectiveWorkstreamBindingDigest,
  objectiveWorkstreamBindingId,
} from "./objective-workstream.js";
import type { PairEvidenceStore } from "./store.js";
import {
  CEO_DECISION_KIND,
  CEO_OBSERVATION_SCHEMA,
  buildCeoUserPrompt,
  ceoDecisionSystemPrompt,
  ceoProposalDigest,
  parseCeoDecisionText,
  resolveCeoModelTransport,
  type CeoDecisionInvoker,
  type CeoProposal,
} from "./ceo-decision.js";

type Row = Record<string, unknown> & { version: number };

export const CEO_DECISION_ENTITY = "ceo_decision";
export const CEO_DECISION_ATTEMPT_ENTITY = "ceo_decision_attempt";
export const CEO_DECISION_SCHEMA_VERSION = "pair.os.vnext.ceo-decision.v1";
export const CEO_ATTEMPT_SCHEMA_VERSION = "pair.os.vnext.ceo-decision-attempt.v1";

export const CEO_CYCLE_MAX_PER_OBJECTIVE = 64;
export const CEO_MAX_ATTEMPTS_PER_OBSERVATION = 2;
/** Grace before a crashed STARTED attempt may be reconciled to UNKNOWN —
 *  one invocation timeout plus margin; never assume the provider was
 *  not called. */
export const CEO_ATTEMPT_STALE_GRACE_MS = 5 * 60_000;
export const CEO_INVOKE_TIMEOUT_MS = 20_000;

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
      workstreams.push({
        workstream_key: String(w.workstream_key),
        work_item_id: String(w.work_item_id),
        status: String(wi.status ?? ""),
        version: Number(wi.version),
        assignee_agent_id: wi.assignee_agent_id ?? null,
        blocked_code: wi.blocked_code ?? null,
        // Canonical completion = the work item's own canonical status;
        // mutable mission_ids alone are never proof.
        completion_proven: String(wi.status) === "COMPLETED",
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

export function assertCanonicalCeoAttempt(store: PairEvidenceStore, row: Row): void {
  if (String(row.schema_version ?? "") !== CEO_ATTEMPT_SCHEMA_VERSION) fail("attempt schema_version");
  for (const f of ["attempt_id", "cycle_id", "objective_id", "observation_digest",
    "state", "model_entry_id", "provider_id", "model_id", "started_at"] as const) {
    if (typeof row[f] !== "string" || !(row[f] as string)) fail(`attempt ${f} malformed`);
  }
  if (!Number.isInteger(row.attempt_number) || Number(row.attempt_number) < 1) {
    fail("attempt_number malformed");
  }
  if (!["STARTED", "ACCEPTED", "REJECTED", "STALE", "UNKNOWN"].includes(String(row.state))) {
    fail(`attempt state ${String(row.state)}`);
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
  if (!row.proposal || typeof row.proposal !== "object" || Array.isArray(row.proposal)) {
    fail("proposal malformed");
  }
  if (String(row.decision_digest ?? "") !== ceoDecisionDigest(row)) {
    fail("decision_digest mismatch");
  }
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
  if (String(attempt.state) !== "ACCEPTED" ||
      String(attempt.cycle_id) !== String(row.cycle_id) ||
      String(attempt.objective_id) !== String(row.objective_id) ||
      String(attempt.observation_digest) !== String(row.observation_digest) ||
      String(attempt.model_entry_id) !== String(row.model_entry_id) ||
      String(attempt.provider_id) !== String(row.provider_id) ||
      String(attempt.model_id) !== String(row.model_id) ||
      String(attempt.canonical_proposal_digest ?? "") !== String(row.canonical_proposal_digest)) {
    fail("attempt identity/provenance mismatch");
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

  private settleAttempt(attempt: Row, state: string, extra: Record<string, unknown> = {}): void {
    this.store.immediate(() => {
      const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, String(attempt.attempt_id)) as Row;
      if (String(cur.state) !== "STARTED") return; // already settled — converged
      this.store.put(CEO_DECISION_ATTEMPT_ENTITY, String(attempt.attempt_id), {
        ...cur, ...extra, state, settled_at: this.now(),
      }, Number(cur.version));
    });
  }

  /** CEO model eligibility (§"CRITICAL MODEL-ROLE COMPATIBILITY"):
   *  canonical model_entry exists, is usable through the shared
   *  providerModelEligibility projection, and is NOT canonically
   *  DSH_EXECUTION (directly or by proven alias). PLANNER_COORDINATOR is
   *  NOT required — a model may serve CEO without holding any exclusive
   *  role. Authority violations throw; availability degradations reject
   *  the attempt before any invocation. */
  private assertCeoModelUsable(modelEntryId: string): Record<string, unknown> {
    const model = this.store.tryGet("model_entry", modelEntryId);
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
    if (modelRoleOf(this.store, modelEntryId) === MODEL_ROLE.DSH_EXECUTION) {
      throw new IntegrityError("FAIL_CLOSED_CEO_DSH_OVERLAP", `model ${modelEntryId} is DSH_EXECUTION`);
    }
    for (const asn of listModelRoleAssignments(this.store)) {
      if (asn.role !== MODEL_ROLE.DSH_EXECUTION) continue;
      const other = this.store.tryGet("model_entry", String(asn.model_entry_id));
      if (other && sameCanonicalModel(model, other)) {
        throw new IntegrityError(
          "FAIL_CLOSED_CEO_DSH_OVERLAP",
          `model ${modelEntryId} is canonically a DSH_EXECUTION model`,
        );
      }
    }
    const elig = providerModelEligibility(
      this.store, String(model.provider_id ?? model.provider_family ?? ""), modelEntryId);
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

  /**
   * ONE bounded observation/decision cycle. Replay-safe: the same
   * canonical state returns the existing committed decision with ZERO
   * model calls.
   */
  async runCycle(input: { objective_id: string; actor: string }): Promise<{
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
    const cycleId = ceoCycleId(objectiveId, first.observation_digest);
    const decisionId = ceoDecisionId(objectiveId, cycleId);
    // 5. Replay — same canonical state already has an ACCEPTED decision.
    const existing = this.store.tryGet(CEO_DECISION_ENTITY, decisionId) as Row | null;
    if (existing) {
      assertCanonicalCeoDecision(this.deps, existing);
      const binding = this.deps.workstreams.getBinding(objectiveId);
      return { decision: existing, binding, attempt_id: String(existing.attempt_id), replayed: true };
    }
    // 6. Hard cycle bound — canonical decisions only.
    const cycles = (this.store.list(CEO_DECISION_ENTITY) as Row[])
      .filter((d) => String(d.objective_id) === objectiveId).length;
    if (cycles >= CEO_CYCLE_MAX_PER_OBJECTIVE) {
      throw new IntegrityError("FAIL_CLOSED_CEO_CYCLE_LIMIT", objectiveId);
    }
    // 7. Model eligibility — before claiming any attempt.
    const model = this.assertCeoModelUsable(this.deps.model_entry_id);
    const transport = resolveCeoModelTransport(this.store, this.deps.model_entry_id);
    // 8. Claim the attempt inside a serializing transaction — at most
    //    ONE live invocation per observation; ≤2 attempts ever.
    const attemptNumber = this.store.immediate(() => {
      const attempts = this.attemptsFor(cycleId);
      for (const a of attempts) assertCanonicalCeoAttempt(this.store, a);
      if (attempts.some((a) => String(a.state) === "STARTED")) {
        throw new IntegrityError("FAIL_CLOSED_CEO_DECISION_INFLIGHT", cycleId);
      }
      if (attempts.length >= CEO_MAX_ATTEMPTS_PER_OBSERVATION) {
        throw new IntegrityError("FAIL_CLOSED_CEO_ATTEMPT_LIMIT", cycleId);
      }
      const n = attempts.length + 1;
      const attemptId = ceoAttemptId(objectiveId, cycleId, n);
      this.store.put(CEO_DECISION_ATTEMPT_ENTITY, attemptId, {
        schema_version: CEO_ATTEMPT_SCHEMA_VERSION,
        attempt_id: attemptId,
        cycle_id: cycleId,
        objective_id: objectiveId,
        business_id: String((first.observation.objective as Record<string, unknown>).business_id),
        observation_digest: first.observation_digest,
        attempt_number: n,
        state: "STARTED",
        model_entry_id: transport.model_entry_id,
        provider_id: transport.provider_id,
        model_id: transport.model_id,
        started_at: this.now(),
        settled_at: null,
        response_digest: null,
        canonical_proposal_digest: null,
        failure_code: null,
        version: 0,
      } as Row, 0);
      return n;
    });
    const attemptId = ceoAttemptId(objectiveId, cycleId, attemptNumber);
    const attempt = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, attemptId) as Row;

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
        timeout_ms: this.deps.timeout_ms ?? CEO_INVOKE_TIMEOUT_MS,
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
      });
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
      const fresh = buildCeoObservation(this.deps, objectiveId);
      if (fresh.observation_digest !== first.observation_digest) {
        // TOCTOU — the model decided against stale state. Settle STALE
        // (committed) and let the caller run a fresh cycle.
        const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, attemptId) as Row;
        this.store.put(CEO_DECISION_ATTEMPT_ENTITY, attemptId, {
          ...cur, state: "STALE", settled_at: this.now(),
          response_digest: responseDigest,
          canonical_proposal_digest: proposalDigest,
          failure_code: "CEO_OBSERVATION_STALE",
        }, Number(cur.version));
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
      const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, attemptId) as Row;
      this.store.put(CEO_DECISION_ATTEMPT_ENTITY, attemptId, {
        ...cur, state: "ACCEPTED", settled_at: this.now(),
        response_digest: responseDigest,
        canonical_proposal_digest: proposalDigest,
      }, Number(cur.version));
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
      });
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

  /** Bounded stale-attempt reconciliation: a STARTED attempt older than
   *  the explicit grace may become UNKNOWN (never assumed un-invoked);
   *  only then may one bounded retry be admitted under the attempt
   *  ceiling. Returns the number reconciled. */
  reconcileStaleAttempts(objectiveId?: string): number {
    const grace = this.deps.stale_grace_ms ?? CEO_ATTEMPT_STALE_GRACE_MS;
    const now = Date.parse(this.now());
    let count = 0;
    for (const a of this.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[]) {
      if (objectiveId && String(a.objective_id) !== objectiveId) continue;
      if (String(a.state) !== "STARTED") continue;
      const started = Date.parse(String(a.started_at));
      if (!Number.isFinite(started) || now - started <= grace) continue;
      this.store.immediate(() => {
        const cur = this.store.get(CEO_DECISION_ATTEMPT_ENTITY, String(a.attempt_id)) as Row;
        if (String(cur.state) !== "STARTED") return;
        this.store.put(CEO_DECISION_ATTEMPT_ENTITY, String(a.attempt_id), {
          ...cur, state: "UNKNOWN", settled_at: this.now(),
          failure_code: "CEO_ATTEMPT_RECONCILED",
        }, Number(cur.version));
      });
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
