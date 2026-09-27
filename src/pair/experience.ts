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

import { newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";

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

const TRANSITIONS: Record<string, string[]> = {
  CANDIDATE: ["QUARANTINED", "QUALIFIED", "REVOKED", "SUPERSEDED"],
  QUARANTINED: ["QUALIFIED", "REVOKED", "SUPERSEDED"],
  QUALIFIED: ["ACTIVE", "REVOKED", "SUPERSEDED"],
  ACTIVE: ["REVOKED", "SUPERSEDED"],
  REVOKED: [],
  SUPERSEDED: [],
};

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

  createCandidate(fields: {
    type: string;
    source_evidence_refs: string[];
    provenance: string;
    compatibility_scope?: Record<string, unknown>;
    confidence?: number;
    trust_metadata?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    permission_effect?: string;
  }): Record<string, unknown> {
    const exp: Record<string, unknown> = {
      schema: "pair.os.vnext.experience.v1",
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
      created_at: utcnow(),
    };
    this.assertFields(exp);
    // A candidate must be grounded in at least one resolvable Layer-B ref.
    this.assertEvidenceRefs(exp.source_evidence_refs as string[]);
    this.store.put("experience", String(exp.experience_id), exp, 0);
    this.store.event({
      entity_type: "experience",
      entity_id: String(exp.experience_id),
      event_type: "EXPERIENCE_CANDIDATE",
      new_state: "CANDIDATE",
      actor: "EXPERIENCE_SERVICE",
    });
    return exp;
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
      const stale = (e.trust_metadata as Record<string, unknown>)?.stale_after;
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
}
