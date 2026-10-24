/**
 * Layer C — VERIFIED EXPERIENCE.
 *
 * Minimal trusted-experience pipeline for PAIR vNext. Experience is
 * ADVISORY ONLY: it may rank already-eligible options, it may never grant
 * permissions, bypass qualification, or self-promote. The firewall is
 * deterministic:
 *
 *  - `permission_effect` must be exactly "NONE" at every transition
 *  - QUALIFIED / ACTIVE require resolvable Layer-B evidence refs + a
 *    verifier identity + verifier result
 *  - only ACTIVE/QUALIFIED rows are retrievable, after hard filters
 *  - nothing here is consulted by MissionRouter eligibility — wiring
 *    experience into routing is a later phase and remains advisory
 *
 * Lifecycle: CANDIDATE → QUARANTINED → QUALIFIED → ACTIVE
 *            (REVOKE / SUPERSEDE available from any non-terminal state)
 *
 * Entities live in the canonical store as entity_type "experience" so they
 * inherit canonical serialization, payload hashing, and verify-on-read.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";

export const EXPERIENCE_SCHEMA_V2 = "pair.os.vnext.experience.v2";

export const EXPERIENCE_TYPES = new Set([
  "PLAN_TEMPLATE",
  "SUBPLAN_PATTERN",
  "FAILURE_SIGNATURE",
  "REMEDIATION_PAIR",
  "EXECUTOR_OBSERVATION",
  "PROVIDER_MODEL_OBSERVATION",
  "TOOL_COMPATIBILITY",
  "ENVIRONMENT_CONSTRAINT",
  "NEGATIVE_EXPERIENCE",
  "ROUTING_PRIOR",
]);

export const EXPERIENCE_STATUSES = new Set([
  "CANDIDATE",
  "QUARANTINED",
  "QUALIFIED",
  "ACTIVE",
  "REVOKED",
  "SUPERSEDED",
]);

export const EVIDENCE_ORIGINS = new Set([
  "REAL_EXECUTION",
  "DETERMINISTIC_TEST",
  "LIVE_PROBE",
  "SIMULATED_FIXTURE",
  "OPERATOR_ASSERTION",
  "MODEL_GENERATED",
]);

const TRANSITIONS: Record<string, string[]> = {
  CANDIDATE: ["QUARANTINED", "QUALIFIED", "REVOKED", "SUPERSEDED"],
  QUARANTINED: ["QUALIFIED", "REVOKED", "SUPERSEDED"],
  QUALIFIED: ["ACTIVE", "REVOKED", "SUPERSEDED"],
  ACTIVE: ["REVOKED", "SUPERSEDED", "QUARANTINED"],
  REVOKED: [],
  SUPERSEDED: [],
};

/** Stable content digest — tamper check + semantic identity, excludes volatile fields. */
export function experienceDigest(exp: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(exp)) {
    // Content digest: semantic fields only — lifecycle bookkeeping (status,
    // verifier identity/result, transition timestamps, transition reasons)
    // changes on every promotion and must not invalidate the digest.
    if (
      [
        "experience_digest",
        "version",
        "entity_type",
        "entity_id",
        "status",
        "created_at",
        "qualified_at",
        "activated_at",
        "last_observed_at",
        "verifier_id",
        "verifier_identity",
        "verifier_result",
        "quarantine_reason",
        "revoke_reason",
        "superseded_by",
      ].includes(k)
    ) {
      continue;
    }
    body[k] = v;
  }
  return digest(body);
}

export class ExperienceService {
  constructor(private readonly service: PairControlPlane) {}

  private get store() {
    return this.service.store;
  }

  private load(id: string): Record<string, unknown> {
    return this.store.get("experience", id);
  }

  private transition(
    exp: Record<string, unknown>,
    to: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const from = String(exp.status);
    if (!TRANSITIONS[from]?.includes(to)) {
      throw new PolicyError(
        "FAIL_CLOSED_EXPERIENCE_TRANSITION",
        `${from} -> ${to}`,
      );
    }
    const updated = { ...exp, ...extra, status: to };
    this.store.put("experience", String(exp.experience_id), updated, Number(exp.version ?? 0));
    this.store.event({
      entity_type: "experience",
      entity_id: String(exp.experience_id),
      event_type: `EXPERIENCE_${to}`,
      old_state: from,
      new_state: to,
      actor: String(extra.verifier_id ?? "EXPERIENCE_SERVICE"),
    });
    return this.load(String(exp.experience_id));
  }

  private assertFields(exp: Record<string, unknown>): void {
    if (!EXPERIENCE_TYPES.has(String(exp.type))) {
      throw new PolicyError("FAIL_CLOSED_EXPERIENCE_TYPE", String(exp.type));
    }
    // The learning firewall is absolute: experience may never carry a
    // permission effect.
    if (String(exp.permission_effect ?? "NONE") !== "NONE") {
      throw new PolicyError(
        "FAIL_CLOSED_EXPERIENCE_PERMISSION_EFFECT",
        String(exp.permission_effect),
      );
    }
  }

  /** P17 — a tenancy scope is a CANONICAL claim, validated against the
   *  store at write time: an objective scope must resolve to a real
   *  objective and carries the objective's own business (a caller may
   *  not pair it with a different business); a business-only scope must
   *  resolve to a real business. Both null = UNSCOPED — retrievable by
   *  unscoped queries only, never by a scoped/Brain read. */
  private assertScope(exp: Record<string, unknown>): void {
    const oid = exp.scope_objective_id != null ? String(exp.scope_objective_id) : null;
    const bid = exp.scope_business_id != null ? String(exp.scope_business_id) : null;
    if (oid !== null) {
      const obj = this.store.tryGet("objective", oid) as Record<string, unknown> | null;
      if (!obj) {
        throw new IntegrityError("FAIL_CLOSED_EXPERIENCE_SCOPE", `objective ${oid} does not resolve`);
      }
      const canonicalBid = String(obj.business_id ?? "");
      if (bid !== null && bid !== canonicalBid) {
        throw new IntegrityError(
          "FAIL_CLOSED_EXPERIENCE_SCOPE",
          `business ${bid} != objective business ${canonicalBid}`,
        );
      }
      exp.scope_business_id = canonicalBid;
      return;
    }
    if (bid !== null) {
      const biz = this.store.tryGet("business", bid) as Record<string, unknown> | null;
      if (!biz) {
        throw new IntegrityError("FAIL_CLOSED_EXPERIENCE_SCOPE", `business ${bid} does not resolve`);
      }
    }
  }

  createCandidate(fields: {
    type: string;
    source_evidence_refs: string[];
    provenance: string;
    compatibility_scope?: Record<string, unknown>;
    confidence?: number;
    trust_metadata?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    permission_effect?: string;
    series_key?: string;
    evidence_origin?: string;
    extracted_by?: string;
    min_support?: number;
    stale_after?: string;
    outcome?: string;
    observed_environments?: string[];
    observed_executors?: string[];
    observed_providers?: string[];
    observed_models?: string[];
    scope_business_id?: string | null;
    scope_objective_id?: string | null;
  }): Record<string, unknown> {
    const origin = fields.evidence_origin ?? "OPERATOR_ASSERTION";
    if (!EVIDENCE_ORIGINS.has(origin)) {
      throw new PolicyError("FAIL_CLOSED_EXPERIENCE_ORIGIN", origin);
    }
    const exp: Record<string, unknown> = {
      schema: EXPERIENCE_SCHEMA_V2,
      experience_id: newId("EXP"),
      type: fields.type,
      status: "CANDIDATE",
      source_evidence_refs: fields.source_evidence_refs,
      provenance: fields.provenance,
      compatibility_scope: fields.compatibility_scope ?? {},
      confidence: fields.confidence ?? null,
      trust_metadata: fields.trust_metadata ?? {},
      payload: fields.payload ?? {},
      permission_effect: fields.permission_effect ?? "NONE",
      verifier_identity: null,
      verifier_result: null,
      qualified_at: null,
      supersedes: null,
      series_key: fields.series_key ?? null,
      evidence_origin: origin,
      extracted_by: fields.extracted_by ?? "EXPERIENCE_EXTRACTION",
      min_support: fields.min_support ?? null,
      stale_after: fields.stale_after ?? null,
      stale: false,
      outcome: fields.outcome ?? null,
      observation_count: 1,
      success_count: fields.outcome === "SUCCESS" ? 1 : 0,
      failure_count: fields.outcome === "FAILURE" ? 1 : 0,
      last_observed_at: utcnow(),
      observed_environments: [...new Set(fields.observed_environments ?? [])].sort(),
      observed_executors: [...new Set(fields.observed_executors ?? [])].sort(),
      observed_providers: [...new Set(fields.observed_providers ?? [])].sort(),
      observed_models: [...new Set(fields.observed_models ?? [])].sort(),
      contradictions: [],
      created_at: utcnow(),
      scope_business_id: fields.scope_business_id ?? null,
      scope_objective_id: fields.scope_objective_id ?? null,
    };
    this.assertFields(exp);
    this.assertScope(exp);
    // A candidate must be grounded in at least one resolvable Layer-B ref.
    this.assertEvidenceRefs(exp.source_evidence_refs as string[]);
    exp.experience_digest = experienceDigest(exp);
    this.store.put("experience", String(exp.experience_id), exp, 0);
    this.store.event({
      entity_type: "experience",
      entity_id: String(exp.experience_id),
      event_type: "EXPERIENCE_CANDIDATE",
      new_state: "CANDIDATE",
      actor: String(exp.extracted_by),
      metadata: { type: exp.type, evidence_origin: origin, series_key: fields.series_key ?? null },
    });
    // Poisoning defense: model output may never seed trusted experience
    // directly — the claim is preserved for audit but quarantined.
    if (origin === "MODEL_GENERATED") {
      return this.quarantine(
        String(exp.experience_id),
        "UNVERIFIED_MODEL_OUTPUT",
      );
    }
    return this.load(String(exp.experience_id));
  }

  /** Locate the open (non-terminal) series member for aggregation.
   *  P17: when a scope is supplied the match is tenancy-strict — a
   *  same-signature member in another scope is a DIFFERENT series
   *  (cross-scope evidence never aggregates into one row). */
  findBySeriesKey(
    seriesKey: string,
    scope?: { scope_business_id: string | null; scope_objective_id: string | null },
  ): Record<string, unknown> | null {
    const sameScope = (e: Record<string, unknown>): boolean => {
      if (!scope) return true;
      const rowObj = e.scope_objective_id != null ? String(e.scope_objective_id) : null;
      const rowBiz = e.scope_business_id != null ? String(e.scope_business_id) : null;
      return rowObj === scope.scope_objective_id && rowBiz === scope.scope_business_id;
    };
    return (
      this.store
        .list("experience")
        .find(
          (e) =>
            e.series_key === seriesKey &&
            !["REVOKED", "SUPERSEDED"].includes(String(e.status)) &&
            sameScope(e),
        ) ?? null
    );
  }

  /**
   * Fold a repeated observation into an existing series member. Dedup is by
   * canonical evidence identity: a ref already recorded is a semantic no-op —
   * replayed/re-read evidence never double-counts.
   */
  foldObservation(
    expId: string,
    obs: {
      evidence_ref: string;
      outcome?: string;
      environments?: string[];
      executors?: string[];
      providers?: string[];
      models?: string[];
    },
  ): Record<string, unknown> {
    const exp = this.load(expId);
    const refs = new Set(exp.source_evidence_refs as string[]);
    if (refs.has(obs.evidence_ref)) {
      return exp; // already counted — canonical dedup
    }
    const merge = (key: string, vals?: string[]) =>
      [...new Set([...((exp[key] as string[]) ?? []), ...(vals ?? [])])].sort();
    const updated: Record<string, unknown> = {
      ...exp,
      source_evidence_refs: [...refs, obs.evidence_ref].sort(),
      observation_count: Number(exp.observation_count ?? 1) + 1,
      success_count:
        Number(exp.success_count ?? 0) + (obs.outcome === "SUCCESS" ? 1 : 0),
      failure_count:
        Number(exp.failure_count ?? 0) + (obs.outcome === "FAILURE" ? 1 : 0),
      last_observed_at: utcnow(),
      observed_environments: merge("observed_environments", obs.environments),
      observed_executors: merge("observed_executors", obs.executors),
      observed_providers: merge("observed_providers", obs.providers),
      observed_models: merge("observed_models", obs.models),
    };
    updated.experience_digest = experienceDigest(updated);
    return this.store.put(
      "experience",
      expId,
      updated,
      Number(exp.version),
    );
  }

  /**
   * Record conflicting verified evidence. `resolution` is a deterministic
   * policy outcome: RETAIN (history only), QUARANTINE, or SUPERSEDE.
   */
  recordContradiction(
    expId: string,
    contradiction: {
      conflicting_evidence_ref: string;
      summary: string;
      compatibility_delta?: Record<string, unknown>;
      resolution?: "RETAIN" | "QUARANTINE" | "SUPERSEDE";
      superseded_by?: string;
    },
  ): Record<string, unknown> {
    const exp = this.load(expId);
    const contradictions = [
      ...((exp.contradictions as Array<Record<string, unknown>>) ?? []),
      {
        conflicting_evidence_ref: contradiction.conflicting_evidence_ref,
        summary: contradiction.summary,
        compatibility_delta: contradiction.compatibility_delta ?? {},
        recorded_at: utcnow(),
      },
    ];
    const body: Record<string, unknown> = { ...exp, contradictions };
    body.experience_digest = experienceDigest(body);
    this.store.put("experience", expId, body, Number(exp.version));
    this.store.event({
      entity_type: "experience",
      entity_id: expId,
      event_type: "EXPERIENCE_CONTRADICTION",
      new_state: String(exp.status),
      actor: "EXPERIENCE_SERVICE",
      metadata: {
        conflicting_evidence_ref: contradiction.conflicting_evidence_ref,
        resolution: contradiction.resolution ?? "RETAIN",
      },
    });
    const resolution = contradiction.resolution ?? "RETAIN";
    if (resolution === "QUARANTINE") {
      return this.transition(this.load(expId), "QUARANTINED", {
        quarantine_reason: `CONTRADICTION:${contradiction.summary}`,
      });
    }
    if (resolution === "SUPERSEDE") {
      return this.transition(this.load(expId), "SUPERSEDED", {
        superseded_by: contradiction.superseded_by ?? null,
      });
    }
    return this.load(expId);
  }

  /** Mark an experience stale — filtered from retrieval, history preserved. */
  markStale(expId: string, reason: string): Record<string, unknown> {
    const exp = this.load(expId);
    const body: Record<string, unknown> = { ...exp, stale: true, stale_reason: reason };
    body.experience_digest = experienceDigest(body);
    this.store.put("experience", expId, body, Number(exp.version));
    this.store.event({
      entity_type: "experience",
      entity_id: expId,
      event_type: "EXPERIENCE_STALE",
      new_state: String(exp.status),
      actor: "EXPERIENCE_SERVICE",
      metadata: { reason },
    });
    return this.load(expId);
  }

  /** All evidence refs must resolve against canonical state — no dangling claims. */
  private assertEvidenceRefs(refs: string[]): void {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new PolicyError("FAIL_CLOSED_EXPERIENCE_NO_EVIDENCE", "empty refs");
    }
    for (const ref of refs) {
      const [entityType, entityId] = String(ref).split(":", 2);
      if (!entityType || !entityId) {
        throw new PolicyError("FAIL_CLOSED_EXPERIENCE_BAD_REF", String(ref));
      }
      try {
        this.store.get(entityType, entityId);
      } catch {
        throw new PolicyError("FAIL_CLOSED_EXPERIENCE_UNRESOLVED_REF", String(ref));
      }
    }
  }

  quarantine(id: string, reason: string): Record<string, unknown> {
    return this.transition(this.load(id), "QUARANTINED", { quarantine_reason: reason });
  }

  qualify(
    id: string,
    opts: { verifier_id: string; verifier_result: Record<string, unknown>; evidence_refs?: string[] },
  ): Record<string, unknown> {
    const exp = this.load(id);
    const refs = (opts.evidence_refs ?? exp.source_evidence_refs) as string[];
    this.assertEvidenceRefs(refs);
    if (!opts.verifier_id || opts.verifier_result == null) {
      throw new PolicyError("FAIL_CLOSED_EXPERIENCE_NO_VERIFIER", id);
    }
    return this.transition(exp, "QUALIFIED", {
      verifier_id: opts.verifier_id,
      verifier_result: opts.verifier_result,
      qualified_at: utcnow(),
      source_evidence_refs: refs,
    });
  }

  activate(
    id: string,
    opts: { verifier_id: string; verifier_result: Record<string, unknown> },
  ): Record<string, unknown> {
    const exp = this.load(id);
    if (!opts.verifier_id || opts.verifier_result == null) {
      throw new PolicyError("FAIL_CLOSED_EXPERIENCE_NO_VERIFIER", id);
    }
    return this.transition(exp, "ACTIVE", {
      verifier_id: opts.verifier_id,
      verifier_result: opts.verifier_result,
      activated_at: utcnow(),
    });
  }

  revoke(id: string, reason: string): Record<string, unknown> {
    return this.transition(this.load(id), "REVOKED", { revoke_reason: reason });
  }

  supersede(oldId: string, newId: string): Record<string, unknown> {
    return this.transition(this.load(oldId), "SUPERSEDED", { superseded_by: newId });
  }

  get(id: string): Record<string, unknown> {
    return this.load(id);
  }

  /**
   * Trusted retrieval — deterministic hard filters BEFORE relevance:
   *  1. ACTIVE/QUALIFIED status
   *  2. trust/origin allowlist
   *  3. mission/task scope
   *  4. executor/provider/model/tool compatibility
   *  5. environment/schema compatibility
   *  6. staleness / revocation / supersession
   *  7. permission_effect == NONE
   *  8. relevance ranking (deterministic token overlap)
   */
  /** P17 — tenancy admission, symmetric:
   *  - objective query: the objective's own rows + business-shared rows
   *    of its canonical business (a query omitting business_id derives
   *    it from the objective — an objective that does not resolve
   *    admits NOTHING, never the world).
   *  - business query: business-shared rows only — an objective-private
   *    row (scope_objective_id set) stays private to its objective.
   *  - unscoped query: UNSCOPED rows only. "No scope asserted" means
   *    exactly that — a scope-bound row is never visible outside its
   *    scope, on ANY read path (raw-forged malformed pairs included). */
  private scopeAdmits(
    exp: Record<string, unknown>,
    query: { objective_id?: string; business_id?: string },
  ): boolean {
    const rowObj = exp.scope_objective_id != null ? String(exp.scope_objective_id) : null;
    const rowBiz = exp.scope_business_id != null ? String(exp.scope_business_id) : null;
    if (query.objective_id) {
      let bid = query.business_id ?? null;
      if (bid === null) {
        const obj = this.store.tryGet("objective", query.objective_id) as
          Record<string, unknown> | null;
        bid = obj ? String(obj.business_id ?? "") || null : null;
        if (bid === null) return false; // objective unproven — fail closed
      }
      if (rowObj === query.objective_id) {
        // An objective-scoped row whose business disagrees is a
        // malformed binding — never admitted (write-side assertScope
        // forbids it; a raw-forged row could still carry it).
        return rowBiz === null || rowBiz === bid;
      }
      return rowObj === null && rowBiz === bid;
    }
    if (query.business_id) {
      return rowObj === null && rowBiz === query.business_id;
    }
    return rowObj === null && rowBiz === null;
  }

  retrieve(query: {
    text?: string;
    mission_id?: string;
    task_id?: string;
    executor_id?: string;
    provider?: string;
    model?: string;
    tool?: string;
    environment?: Record<string, unknown>;
    types?: string[];
    statuses?: string[];
    trusted_origins?: string[];
    now?: string;
    objective_id?: string;
    business_id?: string;
  }): Array<Record<string, unknown>> {
    const statuses = new Set(query.statuses ?? ["ACTIVE", "QUALIFIED"]);
    const now = query.now ?? utcnow();
    const rows = this.store.list("experience");

    const compatible = (exp: Record<string, unknown>): boolean => {
      const scope = (exp.compatibility_scope as Record<string, unknown>) ?? {};
      if (query.mission_id && scope.mission_id && scope.mission_id !== query.mission_id) return false;
      if (query.task_id && scope.task_id && scope.task_id !== query.task_id) return false;
      if (
        query.executor_id &&
        Array.isArray(scope.executors) &&
        !(scope.executors as string[]).includes(query.executor_id)
      )
        return false;
      if (
        query.provider &&
        scope.provider &&
        scope.provider !== query.provider
      )
        return false;
      if (query.model && scope.model && scope.model !== query.model) return false;
      if (query.tool && Array.isArray(scope.tools) && !(scope.tools as string[]).includes(query.tool))
        return false;
      if (query.environment && scope.environment) {
        const envScope = scope.environment as Record<string, unknown>;
        for (const [k, v] of Object.entries(envScope)) {
          if (query.environment[k] !== undefined && query.environment[k] !== v) return false;
        }
      }
      return true;
    };

    const filtered = rows.filter((e) => {
      if (!statuses.has(String(e.status))) return false; // 1+6 (revoked/superseded excluded)
      if (query.types && !query.types.includes(String(e.type))) return false;
      if (
        query.trusted_origins &&
        !query.trusted_origins.includes(String((e.trust_metadata as Record<string, unknown>)?.origin ?? e.provenance))
      )
        return false; // 2
      if (!compatible(e)) return false; // 3+4+5
      if (!this.scopeAdmits(e, query)) return false; // 3b — P17 tenancy
      if (e.stale === true) return false; // 6
      const stale =
        e.stale_after ?? (e.trust_metadata as Record<string, unknown>)?.stale_after;
      if (stale && String(stale) < now) return false; // 6
      if (String(e.permission_effect ?? "NONE") !== "NONE") return false; // 7
      return true;
    });

    // 8. deterministic relevance: shared-token count, ACTIVE before QUALIFIED,
    //    then confidence desc, then id asc — fully deterministic.
    const tokens = new Set((query.text ?? "").toLowerCase().split(/\W+/).filter(Boolean));
    const score = (e: Record<string, unknown>) => {
      const hay = `${e.type} ${JSON.stringify(e.payload)} ${e.provenance}`.toLowerCase();
      let s = 0;
      for (const t of tokens) if (hay.includes(t)) s += 1;
      return s;
    };
    return filtered.sort(
      (a, b) =>
        score(b) - score(a) ||
        String(b.status).localeCompare(String(a.status)) ||
        (Number(b.confidence) || 0) - (Number(a.confidence) || 0) ||
        String(a.experience_id).localeCompare(String(b.experience_id)),
    );
  }

  /**
   * P17 — the Brain-facing scoped read: retrieve() for the objective's
   * tenancy PLUS the honest exclusion counts (unscoped legacy rows and
   * foreign-scope rows are real, but the scoped read must never see
   * them — reporting the counts keeps the projection truthful).
   * Counts cover every row the scope does not admit — a pile of
   * unscoped legacy candidates stays visible as excluded, not hidden.
   */
  scopedFor(scope: { objective_id: string; business_id: string }): {
    rows: Array<Record<string, unknown>>;
    excluded_unscoped: number;
    excluded_out_of_scope: number;
    excluded_ineligible: number;
  } {
    const all = this.store.list("experience");
    let excluded_unscoped = 0;
    let excluded_out_of_scope = 0;
    const inScopeIds = new Set<string>();
    for (const e of all) {
      const rowObj = e.scope_objective_id != null ? String(e.scope_objective_id) : null;
      const rowBiz = e.scope_business_id != null ? String(e.scope_business_id) : null;
      if (rowObj === null && rowBiz === null) {
        excluded_unscoped += 1;
      } else if (!this.scopeAdmits(e, scope)) {
        excluded_out_of_scope += 1;
      } else {
        inScopeIds.add(String(e.experience_id));
      }
    }
    const rows = this.retrieve({
      objective_id: scope.objective_id,
      business_id: scope.business_id,
    });
    // In-scope rows that did not surface — below the status/trust/
    // staleness floor (CANDIDATE, QUARANTINED, revoked, stale).
    // admitted + ineligible = the complete in-scope population; the
    // projection never hides them.
    const excluded_ineligible = Math.max(0, inScopeIds.size - rows.length);
    return {
      rows,
      excluded_unscoped,
      excluded_out_of_scope,
      excluded_ineligible,
    };
  }
}
