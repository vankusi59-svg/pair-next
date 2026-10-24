/**
 * P16-A — Brain Context Aggregator.
 *
 * The Strategic Brain's ONLY canonical read surface. Produces a
 * bounded, deterministic, provenance-bound context snapshot for one
 * owner-scoped objective — the input a later ReasoningBrief (P16-B)
 * may consume. This service is deliberately ADVISORY-ONLY:
 *
 *  - READ-ONLY by discipline (tested, not type-claimed): the service
 *    holds no write method of its own and delegates ALL strict reads
 *    to the ONE existing ObjectiveCockpitService composition (strict
 *    objective get + KPI/budget re-proof + buildReviewObservation +
 *    verified-artifact CAS re-validation). No store.put, no
 *    store.event, no model call, no execution authority is invoked.
 *    The deps DO type wider seams (cockpit needs the full services),
 *    so the no-write guarantee is enforced by the canonical-log
 *    identity invariant — the event/payload log is byte-identical
 *    across any contextFor call.
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
 *    the cockpit's MAX_LIST caps. A nested outer read budget (a caller
 *    bug that would silently discard this bound while the envelope
 *    still reports it) fails closed: FAIL_CLOSED_BRAIN_BUDGET.
 *  - DETERMINISTIC: context_digest pins {schema, objective, business,
 *    per-section digests}; identical canonical state → identical
 *    digest. Wall-clock freshness (`asof`) and clock-DERIVED
 *    projection fields (auto-policy expiry_pending/effective/reasons
 *    and the driver equivalents) are excluded from digested values —
 *    they describe "now", not canonical state, and would otherwise
 *    flip the digest across a policy-expiry instant on unchanged
 *    rows. P16-B may pin context_digest for stale-check.
 *
 *  - UNSCOPED DATA EXCLUDED BY DESIGN: Semantic/Procedural Memory and
 *    Verified Experience have NO business/objective tenancy binding in
 *    P16-A (experience entries are unscoped). Rather than open a
 *    cross-scope poisoning window, both sections are reported as
 *    typed `unavailable` — P17's tenancy scope must land before the
 *    Brain may consume them.
 *
 *  - KNOWN INHERITED GAP (canonical contract, not this layer): an
 *    ACTIVE objective whose KPI progress was minted through an
 *    expired/revoked delegated grant fails the strict KPI re-proof
 *    permanently — only the OBJECTIVE_TERMINAL grant end is classified
 *    legitimate (objective-cockpit.ts isLegitimateTerminalGrantEnd).
 *    For those objectives contextFor fails closed rather than serving
 *    unproven claims; a later milestone must surface this as a typed
 *    capability-gap reason rather than a generic integrity error.
 */
import { IntegrityError } from "./errors.js";
import { digest, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import type { Row } from "./routine-mirror.js";
import {
  assertCanonicalObjectiveBudget,
  assertCanonicalObjectiveKpiProgress,
} from "./objective-adaptive-review.js";
import {
  ObjectiveCockpitService,
  isLegitimateTerminalGrantEnd,
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
   *  dropped because canonical re-verification failed, KPI/budget
   *  claims that could not be re-proven NOW). */
  integrity: string[];
  /** digest({sources, unavailable, integrity, value}) — stable across
   *  identical canonical state (volatile clock-derived fields are
   *  normalized out before digesting; see stripVolatile). */
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

/* Clock-derived projection fields — statusReadOnly embeds
   this.now()-derived claims (expiry_pending / effective / reasons)
   that change at a policy-expiry instant over byte-identical
   canonical rows. They stay VISIBLE in section.value (a consumer
   should see them) but are stripped from the digest input so
   context_digest only tracks canonical state. */
const VOLATILE_STATUS_KEYS = new Set(["expiry_pending", "effective", "reasons"]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_STATUS_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
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
    // Nested-budget refusal — store.withReadBudget silently inherits
    // an outer scope (store.ts: if readBudget set, fn runs under it),
    // which would discard OUR bound while the envelope still reports
    // it. Check BEFORE installing ours. A caller that wants a tighter
    // bound passes it via opts.read_budget.
    if (this.store.readBudgetRemaining() !== null) {
      throw new IntegrityError(
        "FAIL_CLOSED_BRAIN_BUDGET",
        "contextFor under an outer read budget would lie about its bound",
      );
    }
    const budget = opts?.read_budget ?? BRAIN_CONTEXT_READ_BUDGET;
    return this.store.withReadBudget(budget, () =>
      this.contextForBounded(objectiveId, actor, opts, budget),
    );
  }

  /** Re-prove the objective's KPI progress + budget ledger against
   *  the canonical evidence chains NOW — the same validators
   *  buildReviewObservation runs. Returns false ONLY for the
   *  classified legitimate terminal-grant end; every other failure
   *  propagates (fail closed). This is deliberately a direct
   *  re-proof: an observation failure elsewhere (workstream,
   *  mission) must not downgrade provable KPI/budget claims into
   *  false UNPROVEN notes. */
  private proveClaims(obj: Row): boolean {
    try {
      assertCanonicalObjectiveKpiProgress(this.store, obj);
      assertCanonicalObjectiveBudget(this.store, obj);
      return true;
    } catch (err) {
      if (isLegitimateTerminalGrantEnd(err, String(obj.status))) {
        return false;
      }
      throw err;
    }
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

    // Direct claim re-proof (see proveClaims) — decides whether the
    // KPI/budget integrity notes below are honest, independent of
    // whether the observation composition failed elsewhere.
    const claimsProven = this.proveClaims(obj);

    // ONE strict composition — same re-proofs as the owner cockpit.
    const c = this.cockpit.objectiveCockpit(objectiveId, actor);
    const o = c.objective as Record<string, unknown>;
    const kpis = (o.kpis as Array<Record<string, unknown>> | undefined) ?? [];
    const obsError = c.observation_error as string | null;

    const objectiveIntegrity: string[] = [];
    if (!claimsProven) {
      objectiveIntegrity.push("BUDGET_LEDGER_UNPROVEN");
      for (const k of kpis) {
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
    /* The section VALUE keeps the full status projection (consumers
       should see expiry/effective/reasons), but the DIGEST pins only
       its canonical subset — clock-derived fields are stripped so an
       expiry-instant flip cannot fake a state change. */
    const autoValue = { auto_policy: c.auto_policy, auto_driver: c.auto_driver };
    sections.autonomy = {
      sources: ["auto_policy.statusReadOnly", "auto_driver.statusReadOnly"],
      unavailable: autoUnavailable,
      integrity: [],
      digest: digest({
        sources: ["auto_policy.statusReadOnly", "auto_driver.statusReadOnly"],
        unavailable: autoUnavailable,
        integrity: [],
        value: stripVolatile(autoValue),
      }),
      value: autoValue,
    };

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
