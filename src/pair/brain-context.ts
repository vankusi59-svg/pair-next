/**
 * P16-A — Brain Context Aggregator.
 *
 * The Strategic Brain's ONLY canonical read surface. Produces a
 * bounded, deterministic, provenance-bound context snapshot for one
 * owner-scoped objective — the input a later ReasoningBrief (P16-B)
 * may consume. This service is deliberately ADVISORY-ONLY:
 *
 *  - READ-ONLY by construction: it holds the same read-only deps
 *    shape as the cockpit and delegates ALL strict reads to the ONE
 *    existing ObjectiveCockpitService composition (strict objective
 *    get + KPI/budget re-proof + buildReviewObservation + verified
 *    artifact re-validation). No store.put, no store.event, no model
 *    call, no execution authority is reachable from this class.
 *  - OWNER-GATED: actor must equal the objective's
 *    owner_authority_id — foreign business/objective access fails
 *    closed (FAIL_CLOSED_BRAIN_AUTHORITY), never a filtered view.
 *  - FAIL-CLOSED on integrity: any tampered canonical row, forged
 *    payload hash, or unverifiable claim propagates the strict-read
 *    error — the aggregator never silently drops or "best-effort"
 *    renders corrupt canonical state.
 *  - BOUNDED: the whole read runs inside store.withReadBudget; budget
 *    exhaustion surfaces as the typed FAIL_CLOSED_*_PROOF_LIMIT
 *    IntegrityError — never silent truncation. Section lists inherit
 *    the cockpit's MAX_LIST caps.
 *  - DETERMINISTIC: context_digest pins {schema, objective, business,
 *    per-section digests}; identical canonical state → identical
 *    digest. The wall-clock `asof` is freshness metadata and is
 *    EXCLUDED from the digest (two reads of unchanged state share the
 *    digest even across time). P16-B may pin context_digest for
 *    stale-check.
 *
 *  - UNSCOPED DATA EXCLUDED BY DESIGN: Semantic/Procedural Memory and
 *    Verified Experience have NO business/objective tenancy binding in
 *    P16-A (experience entries are unscoped). Rather than open a
 *    cross-scope poisoning window, both sections are reported as
 *    typed `unavailable` — P17's tenancy scope must land before the
 *    Brain may consume them.
 */
import { IntegrityError } from "./errors.js";
import { digest, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import type { Row } from "./routine-mirror.js";
import {
  ObjectiveCockpitService,
  type ObjectiveCockpitDeps,
} from "./objective-cockpit.js";

export const BRAIN_CONTEXT_SCHEMA = "pair.os.vnext.brain-context.v1";

/** Default read budget for one snapshot. Generous enough for the
 *  largest realistic objective projection, hard enough that a runaway
 *  enumeration fails typed rather than unbounded. Callers may tighten
 *  per-context via opts.read_budget. */
export const BRAIN_CONTEXT_READ_BUDGET = {
  entities: 8192,
  events: 8192,
} as const;

export interface BrainContextOpts {
  /** Optional caller-asserted business scope: when supplied, an
   *  objective outside it fails closed (belt on top of owner scope). */
  business_id?: string;
  read_budget?: { entities: number; events: number };
}

export interface BrainContextSection {
  /** Canonical seams this section was composed from. */
  sources: string[];
  /** Typed gaps — something a consumer might expect that is absent
   *  by design or by wiring (never silently empty). */
  unavailable: string[];
  /** Integrity observations surfaced during the read (e.g. artifacts
   *  dropped because canonical re-verification failed). */
  integrity: string[];
  /** digest({sources, unavailable, integrity, value}) — stable across
   *  identical canonical state. */
  digest: string;
  value: unknown;
}

export interface BrainContext {
  schema_version: string;
  kind: "BRAIN_CONTEXT";
  objective_id: string;
  business_id: string;
  actor: string;
  /** Wall-clock snapshot instant — freshness metadata, EXCLUDED from
   *  context_digest. */
  asof: string;
  sections: Record<string, BrainContextSection>;
  /** Flat union of every section's unavailable[] (sorted, deduped). */
  unavailable: string[];
  /** Flat union of every section's integrity[] (sorted, deduped). */
  integrity: string[];
  /** The read budget the snapshot ran under (what was actually
   *  charged is not persisted; limits are the bound). */
  read_budget: { entities: number; events: number };
  /** digest over {schema_version, kind, objective_id, business_id,
   *  per-section digests} — changes iff canonical state changes.
   *  asof/actor/read_budget excluded. */
  context_digest: string;
}

export interface BrainContextDeps extends ObjectiveCockpitDeps {}

function section(
  sources: string[],
  value: unknown,
  unavailable: string[] = [],
  integrity: string[] = [],
): BrainContextSection {
  return {
    sources,
    unavailable,
    integrity,
    digest: digest({ sources, unavailable, integrity, value }),
    value,
  };
}

export class BrainContextService {
  /** The ONE strict-read composition — cockpit internals are not
   *  duplicated here; sections are projections OF the cockpit payload. */
  private readonly cockpit: ObjectiveCockpitService;

  constructor(private readonly deps: BrainContextDeps) {
    this.cockpit = new ObjectiveCockpitService(deps);
  }

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }

  /** contextFor(objectiveId, actor, opts?) — the full P16-A snapshot.
   *  Owner-gated, strict, bounded, read-only. Throws IntegrityError on
   *  any scope/integrity/budget violation — never a partial truth. */
  contextFor(
    objectiveId: string,
    actor: string,
    opts?: BrainContextOpts,
  ): BrainContext {
    const budget = opts?.read_budget ?? BRAIN_CONTEXT_READ_BUDGET;
    return this.store.withReadBudget(budget, () =>
      this.contextForBounded(objectiveId, actor, opts, budget),
    );
  }

  private contextForBounded(
    objectiveId: string,
    actor: string,
    opts: BrainContextOpts | undefined,
    budget: { entities: number; events: number },
  ): BrainContext {
    // Owner gate FIRST — the strict get also proves the row's
    // payload_hash/objective_digest before the owner field is trusted.
    const obj = this.deps.objectives.get(objectiveId) as Row;
    if (String(obj.owner_authority_id) !== actor) {
      throw new IntegrityError(
        "FAIL_CLOSED_BRAIN_AUTHORITY",
        `actor ${actor} is not owner of ${objectiveId}`,
      );
    }
    const businessId = String(obj.business_id);
    if (opts?.business_id !== undefined && opts.business_id !== businessId) {
      throw new IntegrityError(
        "FAIL_CLOSED_BRAIN_SCOPE",
        `objective ${objectiveId} is outside business ${opts.business_id}`,
      );
    }

    // ONE strict composition — same re-proofs as the owner cockpit.
    const c = this.cockpit.objectiveCockpit(objectiveId, actor);
    const o = c.objective as Record<string, unknown>;
    const kpis = (o.kpis as Array<Record<string, unknown>> | undefined) ?? [];
    const obsError = c.observation_error as string | null;

    const objectiveIntegrity: string[] = [];
    if ((o.budget as Row | undefined)?.canonically_proven !== true) {
      objectiveIntegrity.push("BUDGET_LEDGER_UNPROVEN");
    }
    for (const k of kpis) {
      if (k.canonically_proven !== true) {
        objectiveIntegrity.push(`KPI_PROGRESS_UNPROVEN:${String(k.kpi_id)}`);
      }
    }
    const sections: Record<string, BrainContextSection> = {};

    sections.objective = section(
      [
        "objective_authority.strict_get",
        "assertCanonicalObjectiveKpiProgress",
        "assertCanonicalObjectiveBudget",
      ],
      o,
      [],
      objectiveIntegrity,
    );

    sections.lifecycle = section(
      ["objective_authority.strict_get", "canonicalAdaptiveReviewsFor"],
      c.lifecycle,
      [],
      [],
    );

    const obsUnavailable: string[] = [];
    if (c.binding === null) obsUnavailable.push("BINDING_ABSENT:pre-INITIALIZE");
    if (obsError !== null) obsUnavailable.push(`OBSERVATION_ERROR:${obsError}`);
    sections.observation = section(
      ["buildReviewObservation", "objective_workstream.getBinding"],
      {
        binding: c.binding,
        observation_error: c.observation_error,
        kpi_summary: c.kpi_summary,
        workstreams: c.workstreams,
        observer: c.observer,
      },
      obsUnavailable,
      [],
    );

    sections.missions = section(
      ["business.boundMissionForWorkItem", "mission_runtime.strict_get"],
      c.missions,
      [],
      [],
    );

    const artIntegrity: string[] = [];
    const artUnavailable: string[] = [];
    if (!this.deps.artifacts) artUnavailable.push("ARTIFACT_AUTHORITY_NOT_WIRED");
    const dropped = Number(c.artifacts_dropped_unverified ?? 0);
    if (dropped > 0) artIntegrity.push(`ARTIFACTS_DROPPED_UNVERIFIED:${dropped}`);
    if (c.artifacts_truncated === true) artIntegrity.push("ARTIFACTS_TRUNCATED");
    sections.artifacts = section(
      ["artifact_authority.verifyArtifactForConsumption"],
      {
        artifacts: c.artifacts,
        artifacts_truncated: c.artifacts_truncated,
        artifacts_dropped_unverified: c.artifacts_dropped_unverified,
      },
      artUnavailable,
      artIntegrity,
    );

    sections.reviews = section(
      ["canonicalAdaptiveReviewsFor"],
      {
        latest_review: c.latest_review,
        review_count: c.review_count,
      },
      [],
      [],
    );

    const autoUnavailable: string[] = [];
    if (!this.deps.autoPolicy) autoUnavailable.push("AUTO_POLICY_NOT_WIRED");
    if (!this.deps.autoDriver) autoUnavailable.push("AUTO_DRIVER_NOT_WIRED");
    sections.autonomy = section(
      ["auto_policy.statusReadOnly", "auto_driver.statusReadOnly"],
      { auto_policy: c.auto_policy, auto_driver: c.auto_driver },
      autoUnavailable,
      [],
    );

    /* Unscoped-memory exclusion — Semantic/Procedural Memory and
       Verified Experience carry NO business/objective tenancy binding
       today. Consuming them here would open a cross-scope poisoning
       window, so both sections report the typed gap instead of data.
       P17's tenancy scope is the prerequisite for wiring them. */
    sections.memory = section(
      [],
      null,
      ["SCOPE_BINDING_ABSENT:semantic/procedural memory has no business/objective tenancy binding — excluded pending P17 scope"],
      [],
    );
    sections.experience = section(
      [],
      null,
      ["SCOPE_BINDING_ABSENT:verified experience has no business/objective tenancy scope — excluded pending P17 scope"],
      [],
    );

    const unavailable = [...new Set(Object.values(sections).flatMap((s) => s.unavailable))].sort();
    const integrity = [...new Set(Object.values(sections).flatMap((s) => s.integrity))].sort();

    const contextDigest = digest({
      schema_version: BRAIN_CONTEXT_SCHEMA,
      kind: "BRAIN_CONTEXT",
      objective_id: objectiveId,
      business_id: businessId,
      sections: Object.fromEntries(
        Object.entries(sections).map(([k, s]) => [k, s.digest]),
      ),
    });

    return {
      schema_version: BRAIN_CONTEXT_SCHEMA,
      kind: "BRAIN_CONTEXT",
      objective_id: objectiveId,
      business_id: businessId,
      actor,
      asof: utcnow(),
      sections,
      unavailable,
      integrity,
      read_budget: { entities: budget.entities, events: budget.events },
      context_digest: contextDigest,
    };
  }
}
