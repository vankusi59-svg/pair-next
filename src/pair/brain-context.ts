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
import { isValidationRejectedAttempt } from "./planner-adaptive-retry.js";
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
 *  per-context via opts.read_budget.
 *
 *  NOTE on charge factor: contextFor re-proves the KPI/budget claims
 *  directly (proveClaims) AND the cockpit observation runs the same
 *  validators again inside buildReviewObservation — the canonical
 *  claim scan is charged ~2× against this bound. That is deliberate:
 *  the direct proof is what lets a missing workstream binding report
 *  BINDING_ABSENT without falsely reporting claims UNPROVEN. The
 *  bound sizes for the doubled charge; tighten only with measured
 *  headroom (R2 M3′). */
export const BRAIN_CONTEXT_READ_BUDGET = {
  entities: 8192,
  events: 8192,
} as const;

/* Planner-feedback bounds: the newest validation rejections surfaced to
   the CEO brief — recency-bounded (never wall-clock filtered, so the
   section value stays clock-independent and digest-stable). */
export const BRAIN_PLANNER_RECENT_REJECTIONS = 3;
export const BRAIN_PLANNER_MAX_CODES = 4;
export const BRAIN_PLANNER_MAX_HINTS = 8;

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

/** P17 — the scoped-experience read the Brain consumes. Implemented
 *  by ExperienceService.scopedFor; declared structurally so the dep
 *  stays a seam (an unwired composition reports EXPERIENCE_NOT_WIRED
 *  rather than fabricating an empty section). */
export interface ScopedExperienceReader {
  scopedFor(scope: { objective_id: string; business_id: string }): {
    rows: Array<Record<string, unknown>>;
    excluded_unscoped: number;
    excluded_out_of_scope: number;
    excluded_ineligible?: number;
  };
}

/** P17 — the scoped Layer-A memory read (semantic/procedural, trust
 *  fields surfaced, exclusion counts honest). Implemented by
 *  ScopedMemoryReader; declared structurally for the same seam reason. */
export interface ScopedMemoryDep {
  scopedFor(scope: { objective_id: string; business_id: string }): {
    semantic: unknown[];
    procedural: unknown[];
    excluded_unscoped: number;
    excluded_out_of_scope: number;
  };
}

export interface BrainContextDeps extends ObjectiveCockpitDeps {
  experience?: ScopedExperienceReader;
  scopedMemory?: ScopedMemoryDep;
}

/** Bounded canonical projection of plan-validation rejections for one
 *  objective: planner runs are attributed to the objective through the
 *  `cost_reservation` lineage seam (admitPlannerInvocation); settled
 *  attempt rows carry `outcome`/`failure_class`/`warnings` — the
 *  VALIDATION_CODE:/REASK:/DROP_/DEP_/REPAIRED_ markers are
 *  PAIR-sanitized strings, never raw model output. Pure reads only. */
export interface PlannerRejectionEntry {
  planner_attempt_id: string;
  planner_run_id: string;
  work_item_id: string | null;
  attempt_no: number;
  run_state: string | null;
  run_attempt_count: number;
  failure_class: string | null;
  validation_codes: string[];
  reask_attempted: boolean;
  task_hints: string[];
  /** P18.2 — this attempt's run consumed PRIOR-run rejection feedback
   *  (PRIOR_REJECTION: marker durable on the settled row). Lets ops
   *  compare fed-back code vs resulting validation_codes — adaptation
   *  tracking without a new table. */
  feedback_informed: boolean;
  completed_at: string | null;
}

export interface PlannerEvidenceValue {
  recent_rejections: PlannerRejectionEntry[];
  rejected_attempt_count: number;
  planner_run_count: number;
}

export function plannerEvidenceForObjective(
  store: PairEvidenceStore,
  objectiveId: string,
): PlannerEvidenceValue {
  const lineage = new Map<string, string | null>();
  for (const r of store.list("cost_reservation") as Array<Record<string, unknown>>) {
    if (String(r.attribution ?? "") !== "planner") continue;
    const rid = String(r.planner_run_id ?? "");
    if (!rid || String(r.objective_id ?? "") !== objectiveId) continue;
    lineage.set(rid, r.work_item_id != null ? String(r.work_item_id) : null);
  }
  const attempts = (store.list("planner_attempt") as Array<Record<string, unknown>>).filter(
    (a) => String(a.planner_run_id ?? "") !== "" && lineage.has(String(a.planner_run_id)),
  );
  const attemptCountByRun = new Map<string, number>();
  for (const a of attempts) {
    const run = String(a.planner_run_id);
    attemptCountByRun.set(run, (attemptCountByRun.get(run) ?? 0) + 1);
  }
  /* Shared canonical predicate (planner-adaptive-retry) — CEO evidence
     and adaptive-retry cap accounting can never drift apart. */
  const rejectedRows = attempts.filter(isValidationRejectedAttempt);
  /* Sort + bound on cheap persisted fields BEFORE enrichment — one
     tryGet per survivor only (run lookups cached per planner_run_id). */
  rejectedRows.sort((x, y) =>
    String(y.completed_at ?? "").localeCompare(String(x.completed_at ?? "")) ||
    String(y.entity_id ?? "").localeCompare(String(x.entity_id ?? "")),
  );
  const runCache = new Map<string, Record<string, unknown> | null>();
  const runOf = (rid: string) => {
    if (!runCache.has(rid)) {
      runCache.set(rid, store.tryGet("planner_run", rid) as Record<string, unknown> | null);
    }
    return runCache.get(rid)!;
  };
  const toEntry = (a: Record<string, unknown>): PlannerRejectionEntry => {
    const warns = Array.isArray(a.warnings) ? (a.warnings as string[]) : [];
    const codes = [...new Set(
      warns
        .filter((w) => w.startsWith("VALIDATION_CODE:") || w.startsWith("REASK:"))
        .map((w) => w.slice(w.indexOf(":") + 1)),
    )].slice(0, BRAIN_PLANNER_MAX_CODES);
    /* AUDIT F1 — task-keyed markers can embed a model-supplied
       task_key verbatim (DROP_INVALID_TASK_KEY:<key> interpolates the
       unvalidated key). This content flows into the CEO user prompt via
       facts → observation.brain_brief — apply the same charset+length
       bound the reask lane uses (planner-pool SAFE_CODE_RE) so no raw
       model text can ride this channel. */
    const taskHints = [...new Set(
      warns.filter((w) =>
        /^(DROP_|DEP_|REPAIRED_)/.test(w) &&
        w.length <= 160 && /^[A-Z0-9_:.\-]+$/.test(w)),
    )].slice(0, BRAIN_PLANNER_MAX_HINTS);
    const runId = String(a.planner_run_id);
    const run = runOf(runId);
    return {
      planner_attempt_id: String(a.entity_id ?? ""),
      planner_run_id: runId,
      work_item_id: lineage.get(runId) ?? null,
      attempt_no: Number(a.attempt_no ?? 0),
      run_state: run?.state != null ? String(run.state) : null,
      run_attempt_count: attemptCountByRun.get(runId) ?? 1,
      failure_class: a.failure_class != null ? String(a.failure_class) : null,
      validation_codes: codes,
      reask_attempted: warns.some((w) => w.startsWith("REASK:")),
      task_hints: taskHints,
      feedback_informed: warns.some((w) => w.startsWith("PRIOR_REJECTION:")),
      completed_at: a.completed_at != null ? String(a.completed_at) : null,
    };
  };
  return {
    recent_rejections: rejectedRows
      .slice(0, BRAIN_PLANNER_RECENT_REJECTIONS)
      .map(toEntry),
    rejected_attempt_count: rejectedRows.length,
    planner_run_count: lineage.size,
  };
}

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
    if (c.binding === null) {
      // null is "absent" only when the strict observation COMPOSED —
      // under observation_error the binding is unobservable, and
      // claiming pre-INITIALIZE would misreport a bound objective.
      obsUnavailable.push(
        obsError === null
          ? "BINDING_ABSENT:pre-INITIALIZE"
          : `BINDING_UNOBSERVABLE:${obsError}`);
    }
    if (obsError !== null) {
      obsUnavailable.push(`OBSERVATION_ERROR:${obsError}`);
      // Workstream/kpi-summary projections vanish with the
      // observation — name the loss precisely, not just its cause.
      obsUnavailable.push(`WORKSTREAMS_UNOBSERVABLE:${obsError}`);
    }
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

    sections.planner = section(
      ["cost_reservation.list", "planner_attempt.list", "planner_run.tryGet"],
      plannerEvidenceForObjective(this.store, objectiveId),
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
    // Sources name only the seams actually consulted — an unwired dep
    // is reported via unavailable[], never claimed as provenance (M7′).
    const autoSources = [
      ...(this.deps.autoPolicy ? ["auto_policy.statusReadOnly"] : []),
      ...(this.deps.autoDriver ? ["auto_driver.statusReadOnly"] : []),
    ];
    sections.autonomy = {
      sources: autoSources,
      unavailable: autoUnavailable,
      integrity: [],
      digest: digest({
        sources: autoSources,
        unavailable: autoUnavailable,
        integrity: [],
        value: stripVolatile(autoValue),
      }),
      value: autoValue,
    };

    /* P17 — scoped consumption replaces the SCOPE_BINDING_ABSENT stub.
       Memory (Layer A, model-writable) and Experience (Layer C,
       advisory) are admitted ONLY through their tenancy binding:
       objective-scoped rows for THIS objective, business-scoped rows
       for THIS business. Unscoped and foreign rows never render — the
       counts stay honest in the section value. An unwired seam reports
       *_NOT_WIRED (same contract as the autonomy deps), never a fake
       empty section. Advisory projections omit use-counters/timestamps
       that churn on read-side bookkeeping — same stripVolatile reason. */
    const tenancyScope = { objective_id: objectiveId, business_id: businessId };
    if (this.deps.scopedMemory) {
      const m = this.deps.scopedMemory.scopedFor(tenancyScope);
      sections.memory = section(
        ["scoped_memory.scopedFor"],
        {
          semantic: m.semantic,
          procedural: m.procedural,
          excluded: {
            unscoped: m.excluded_unscoped,
            out_of_scope: m.excluded_out_of_scope,
          },
        },
        [],
        [],
      );
    } else {
      sections.memory = section(
        [],
        null,
        ["MEMORY_NOT_WIRED:scoped Layer-A memory reader absent — section reported empty rather than fabricated"],
        [],
      );
    }
    if (this.deps.experience) {
      const e = this.deps.experience.scopedFor(tenancyScope);
      sections.experience = section(
        ["experience.scopedFor"],
        {
          experiences: e.rows.slice(0, 16).map((row) => ({
            experience_id: String(row.experience_id),
            type: String(row.type),
            status: String(row.status),
            outcome: row.outcome ?? null,
            confidence: row.confidence ?? null,
            observation_count: Number(row.observation_count ?? 1),
            scope_business_id: row.scope_business_id ?? null,
            scope_objective_id: row.scope_objective_id ?? null,
            evidence_origin: row.evidence_origin ?? null,
          })),
          admitted: e.rows.length,
          truncated: e.rows.length > 16,
          excluded: {
            unscoped: e.excluded_unscoped,
            out_of_scope: e.excluded_out_of_scope,
            ineligible: e.excluded_ineligible ?? 0,
          },
        },
        [],
        [],
      );
    } else {
      sections.experience = section(
        [],
        null,
        ["EXPERIENCE_NOT_WIRED:scoped experience reader absent — section reported empty rather than fabricated"],
        [],
      );
    }

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
