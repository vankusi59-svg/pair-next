/**
 * P15.9-A1 — Company Cockpit canonical read projections.
 *
 * READ-ONLY by construction: every method composes existing strict
 * canonical reads (`objectives.get`, `buildReviewObservation`,
 * `canonicalAdaptiveReviewsFor`, `business.boundMissionForWorkItem`)
 * and returns SELECTIVE fields — never raw rows. No `store.put`, no
 * `store.event`, no service mutation is reachable from this service.
 *
 * Authority contract (identical to the existing owner-scoped routes —
 * auto-policy, kpi-verification, auto-driver):
 *  - the caller's actor is `operator:<x-operator-id>` derived at the
 *    HTTP edge (never trusted from a body field);
 *  - a principal may read an objective's cockpit projection ONLY when
 *    actor === objective.owner_authority_id; anything else fails
 *    closed (FAIL_CLOSED_COCKPIT_AUTHORITY);
 *  - a company projection lists ONLY objectives the actor owns inside
 *    that business — an actor owning none gets
 *    FAIL_CLOSED_COMPANY_SCOPE (a business row itself carries no
 *    owner field, so objective ownership is the only honest
 *    authorization proof the system can make today).
 *
 * This projection does NOT claim multi-tenant isolation beyond that
 * contract: MC token is the transport credential, owner_authority_id
 * is the scope check — same as the rest of P15.
 */
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { Row } from "./routine-mirror.js";
import type { BusinessLayer } from "./business.js";
import type { WorkforceService } from "./work-graph.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import type { ObjectiveAutoPolicyService } from "./objective-auto-policy.js";
import type { ObjectiveAutoDriverService } from "./objective-auto-driver.js";
import type { ArtifactAuthority } from "./artifact-authority.js";
import {
  OBJECTIVE_ENTITY,
  TERMINAL_OBJECTIVE_STATUSES,
  type ObjectiveStatus,
} from "./objective-authority.js";
import {
  assertCanonicalObjectiveBudget,
  assertCanonicalObjectiveKpiProgress,
  buildReviewObservation,
  canonicalAdaptiveReviewsFor,
  objectiveKpiAssessment,
  type ObjectiveAdaptiveReviewDeps,
  type ReviewObservation,
  type ReviewWorkstreamProjection,
} from "./objective-adaptive-review.js";

const MAX_LIST = 200;

/** Read deps shape — buildReviewObservation/validators accept deps
 *  without ceoCycle (never invoked on a read path). */
type CockpitReadDeps = Omit<ObjectiveAdaptiveReviewDeps, "ceoCycle">;

export interface ObjectiveCockpitDeps extends CockpitReadDeps {
  /** F1 — MUST be the read-only seams: status()/readiness() commit the
   *  lazy EXPIRED transition on read (and readiness goes through
   *  scheduler.claimable → policy.evaluate, also expiry-committing).
   *  This projection may not write at all, so it uses statusReadOnly
   *  (expiry surfaced as expiry_pending:true) and does NOT expose
   *  driver readiness — that claim predicate is only reachable through
   *  the expiry-committing path. */
  autoPolicy?: Pick<ObjectiveAutoPolicyService, "statusReadOnly">;
  autoDriver?: Pick<ObjectiveAutoDriverService, "statusReadOnly">;
  /** F3 — canonical artifact verification authority: re-proves the
   *  producer/execution/mission binding AND retained CAS bytes NOW;
   *  an unverifiable artifact is dropped from the projection, never
   *  shown as canonical evidence. */
  artifacts?: Pick<ArtifactAuthority, "verifyArtifactForConsumption">;
}

function bounded<T>(xs: T[], cap = MAX_LIST): T[] {
  return xs.slice(0, cap);
}

function reviewSummary(r: Row): Record<string, unknown> {
  return {
    review_id: String(r.review_id),
    outcome: String(r.outcome),
    owner_action_required: r.owner_action_required === true,
    recommended_status:
      r.recommended_status === null || r.recommended_status === undefined
        ? null
        : String(r.recommended_status),
    wait_reason: r.wait_reason ?? null,
    binding_id: String(r.binding_id),
    review_observation_digest: String(r.review_observation_digest),
    source_ceo_decision_id: r.source_ceo_decision_id ?? null,
    strategy_revision_id: r.strategy_revision_id ?? null,
    all_targets_met: r.all_targets_met === true,
    verified_kpi_count: Number(r.verified_kpi_count ?? 0),
    unverified_kpi_count: Number(r.unverified_kpi_count ?? 0),
    gap_kpi_count: Number(r.gap_kpi_count ?? 0),
    created_by: String(r.created_by),
    created_at: String(r.created_at),
  };
}

function missionSummary(store: PairEvidenceStore, mission: Row): Record<string, unknown> {
  const mid = String(mission.mission_id);
  const rt = store.tryGet("mission_runtime", `MRT_${mid}`) as Row | null;
  return {
    mission_id: mid,
    status: String(mission.status),
    runtime_state: rt ? String(rt.state) : null,
    bound_open_id: mission.bound_open_id ?? null,
    executor_binding: mission.executor_binding ?? null,
    created_at: mission.created_at ?? null,
  };
}

export class ObjectiveCockpitService {
  constructor(private readonly deps: ObjectiveCockpitDeps) {}

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }

  /** The objective must exist (strict canonical read) AND the actor
   *  must be its owner_authority_id — foreign objectives are
   *  indistinguishable from non-owned ones and fail closed either way. */
  private ownedObjective(objectiveId: string, actor: string): Row {
    const obj = this.deps.objectives.get(objectiveId) as Row;
    if (String(obj.owner_authority_id) !== actor) {
      throw new IntegrityError(
        "FAIL_CLOSED_COCKPIT_AUTHORITY",
        `actor ${actor} is not owner of ${objectiveId}`,
      );
    }
    return obj;
  }

  /** The committed adaptive reviews for an objective — each row
   *  strict-validated (anchor + digest + provenance); a tampered row
   *  fails the whole read closed. Deterministic order, bounded. */
  private canonicalReviews(objectiveId: string): Row[] {
    const rows = canonicalAdaptiveReviewsFor(this.deps, objectiveId) as Row[];
    return rows
      .slice()
      .sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.review_id).localeCompare(String(b.review_id)));
  }

  /** F4 + R3-F2 — owner action is pending only while the objective can
   *  still take a transition AND the latest review still pins the
   *  CURRENT objective authority. A terminal objective's historical
   *  CANDIDATE review is not actionable; a review minted before an
   *  owner amendment (terms_version bump / digest rebind / version
   *  bump) is historical evidence, not a live approval request — its
   *  pins provably diverge from the strict-read objective. */
  private static ownerActionPending(
    obj: Row,
    latest: Row | null,
  ): boolean {
    if (latest === null || latest.owner_action_required !== true) return false;
    if (TERMINAL_OBJECTIVE_STATUSES.has(String(obj.status) as ObjectiveStatus)) {
      return false;
    }
    return (
      Number(latest.objective_version) === Number(obj.version) &&
      Number(latest.objective_terms_version) === Number(obj.terms_version) &&
      String(latest.objective_digest) === String(obj.objective_digest)
    );
  }

  /** F3 — verify a candidate artifact against the proven bound
   *  mission NOW (canonical id, execution/governed/executor linkage,
   *  storage contract, retained CAS bytes). Returns the safe
   *  projection, or null when verification fails — the artifact is
   *  dropped, never rendered as canonical evidence. */
  private verifiedArtifact(a: Row, missionId: string): Record<string, unknown> | null {
    if (!this.deps.artifacts) return null;
    try {
      const row = this.deps.artifacts.verifyArtifactForConsumption(
        String(a.artifact_id),
        { execution_id: String(a.execution_id), mission_id: missionId },
      );
      return {
        artifact_id: String(row.artifact_id),
        logical_name: String(row.logical_name),
        mission_id: String(row.mission_id),
        execution_id: String(row.execution_id),
        state: String(row.state),
        artifact_class: String(row.artifact_class),
        sha256: String(row.sha256),
        byte_size: Number(row.byte_size ?? 0),
        created_at: String(row.created_at),
      };
    } catch {
      return null;
    }
  }

  /** R2 — the ONE classification of "re-validation ended legitimately":
   *  the objective is terminal AND the only failure is the delegated
   *  KPI verifier grant reporting OBJECTIVE_TERMINAL (a grant pinned to
   *  a live objective canonically ends when the objective achieves /
   *  cancels / expires — historical progress is real but no longer
   *  re-provable NOW). Every other error — forged progress, digest
   *  mismatch, expired-but-not-terminal grant, unclassified — is
   *  corruption or an honest gap and must fail closed. */
  private static isLegitimateTerminalGrantEnd(
    err: unknown,
    objStatus: string,
  ): boolean {
    return (
      TERMINAL_OBJECTIVE_STATUSES.has(objStatus as ObjectiveStatus) &&
      err instanceof IntegrityError &&
      String(err.code) === "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW" &&
      /authorization not effective \(OBJECTIVE_TERMINAL\)/.test(String(err.message))
    );
  }

  /** KPI entries — `canonically_proven` marks whether `current` was
   *  re-proven against the progress evidence chain in THIS read. When
   *  not proven the claim is still shown (it is data the owner may
   *  want) but the assessment is UNVERIFIED: the projection never
   *  asserts MET/GAP from an unproven `current`. */
  private kpiProjection(obj: Row, proven: boolean): Array<Record<string, unknown>> {
    return ((obj.kpis as Array<Record<string, unknown>>) ?? []).map((k) => ({
      kpi_id: String(k.kpi_id),
      name: String(k.name),
      unit: String(k.unit ?? ""),
      direction: String(k.direction),
      baseline: Number(k.baseline),
      current: k.current === null || k.current === undefined ? null : Number(k.current),
      target: Number(k.target),
      assessment: proven ? objectiveKpiAssessment(k as never) : "UNVERIFIED",
      canonically_proven: proven,
      last_evidence_key: k.last_evidence_key ?? null,
      updated_at: k.updated_at ?? null,
    }));
  }

  /** R2 — prove the objective's KPI progress + budget ledger against
   *  the canonical evidence chains NOW (the same validators the
   *  operating loop and buildReviewObservation run). Returns true when
   *  proven; false only for the classified legitimate terminal-grant
   *  end; anything else propagates (fail closed). */
  private proveObjectiveClaims(obj: Row): boolean {
    try {
      assertCanonicalObjectiveKpiProgress(this.store, obj);
      assertCanonicalObjectiveBudget(this.store, obj);
      return true;
    } catch (err) {
      if (ObjectiveCockpitService.isLegitimateTerminalGrantEnd(
        err, String(obj.status))) {
        return false;
      }
      throw err;
    }
  }

  /** The strict review observation — or `null` when the objective has
   *  no canonical binding yet (pre-INITIALIZE). Any other strict-read
   *  failure (tampered work item, forged mission status, corrupt WAL)
   *  propagates: the projection fails closed rather than serving
   *  unverifiable state as truth. */
  private observationOrNull(objectiveId: string, objStatus: string): {
    observation: ReviewObservation;
    digest: string;
  } | { observation_error: string } | null {
    try {
      return buildReviewObservation(this.deps, objectiveId);
    } catch (err) {
      if ((err as IntegrityError).code === "FAIL_CLOSED_P15_5_BINDING_REQUIRED") {
        return null;
      }
      // R2 — degrade ONLY for the classified legitimate terminal
      // grant end (delegated verifier grant ended because the
      // objective went terminal). Tampered evidence, forged
      // progress or any unclassified failure still fails closed —
      // the projection never renders an unproven claim as verified.
      if (ObjectiveCockpitService.isLegitimateTerminalGrantEnd(err, objStatus)) {
        return { observation_error: String((err as IntegrityError).code ?? "ERROR") };
      }
      throw err;
    }
  }

  private missionForChild(childId: string): Row | null {
    const child = this.store.get("work_item", childId) as Row;
    return this.deps.business.boundMissionForWorkItem(child) as Row | null;
  }

  private workstreamProjection(ws: ReviewWorkstreamProjection): Record<string, unknown> {
    let mission: Record<string, unknown> | null = null;
    if (ws.delegated_child_work_item_id !== null) {
      const m = this.missionForChild(ws.delegated_child_work_item_id);
      if (m !== null) mission = missionSummary(this.store, m);
    }
    return {
      workstream_key: ws.workstream_key,
      work_item_id: ws.work_item_id,
      workstream_status: ws.workstream_status,
      completion_proven: ws.completion_proven === true,
      allocation_state: ws.allocation_state,
      selected_agent_id: ws.selected_agent_id,
      delegated_child:
        ws.delegated_child_work_item_id === null
          ? null
          : {
              work_item_id: ws.delegated_child_work_item_id,
              status: ws.delegated_child_status,
              completion_proven: ws.delegated_child_completion_proven === true,
              bound_mission: ws.delegated_child_bound_mission === true,
              lifecycle_class: ws.delegated_child_class,
              mission,
            },
    };
  }

  /** GET /api/vnext/objectives/:id/cockpit — the full single-objective
   *  projection behind the Objective Detail design. */
  objectiveCockpit(objectiveId: string, actor: string): Record<string, unknown> {
    const obj = this.ownedObjective(objectiveId, actor);
    // F4 — never cap before picking: latest/count must come from the
    // FULL canonical history, sorted, not from a prefix slice.
    const reviews = this.canonicalReviews(objectiveId);
    const latest = reviews.length ? reviews[reviews.length - 1]! : null;
    const objStatus = String(obj.status);
    const obs = this.observationOrNull(objectiveId, objStatus);

    const obsOk = obs !== null && !("observation_error" in obs) ? obs : null;
    const obsError =
      obs !== null && "observation_error" in obs ? obs.observation_error : null;
    const workstreams = obsOk
      ? obsOk.observation.workstreams.map((w) => this.workstreamProjection(w))
      : [];
    const missionIds = new Set<string>();
    const classes = { active: 0, intervention: 0, exhausted: 0 };
    for (const w of workstreams) {
      const child = w.delegated_child as Record<string, unknown> | null;
      if (child?.mission) {
        missionIds.add(String((child.mission as Record<string, unknown>).mission_id));
      }
      const cls = String(child?.lifecycle_class ?? "");
      if (cls === "ACTIVE") classes.active++;
      else if (cls === "INTERVENTION") classes.intervention++;
      else if (cls === "EXHAUSTED") classes.exhausted++;
    }
    // F3 — artifact candidates are only CLAIMS until the canonical
    // authority re-proves producer/execution/mission binding + retained
    // CAS bytes NOW. Unverifiable rows are dropped (counted), never
    // rendered as canonical evidence.
    let droppedUnverified = 0;
    const verifiedArtifacts: Array<Record<string, unknown>> = [];
    for (const a of (this.store.list("artifact") as Row[])
      .filter((x) => missionIds.has(String(x.mission_id)))
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
      const v = this.verifiedArtifact(a, String(a.mission_id));
      if (v === null) droppedUnverified++;
      else verifiedArtifacts.push(v);
    }
    const artifactsTruncated = verifiedArtifacts.length > MAX_LIST;
    const artifacts = bounded(verifiedArtifacts);

    return {
      objective: {
        objective_id: String(obj.objective_id),
        business_id: String(obj.business_id),
        status: String(obj.status),
        title: obj.title ?? null,
        statement: obj.statement ?? null,
        description: obj.description ?? null,
        owner_authority_id: String(obj.owner_authority_id),
        deadline: obj.deadline ?? null,
        currency: String(obj.currency ?? "USD"),
        terms_version: Number(obj.terms_version ?? 0),
        version: Number(obj.version ?? 0),
        created_at: String(obj.created_at ?? ""),
        budget: {
          ceiling_microusd:
            Number((obj.budget as Row | undefined)?.ceiling_microusd ?? 0),
          consumed_microusd:
            Number((obj.budget as Row | undefined)?.consumed_microusd ?? 0),
          // R2 — the spend claim is only canonical when the
          // observation's ledger re-proof succeeded this read.
          canonically_proven: obsOk !== null,
        },
        hard_constraints: obj.hard_constraints ?? [],
        success_conditions: obj.success_conditions ?? [],
        // R2 — obsOk proves kpi.current inside buildReviewObservation;
        // without it the entries are claims, never MET.
        kpis: this.kpiProjection(obj, obsOk !== null),
      },
      // TARGET_MET_CANDIDATE lives on the review/pass outcome — never
      // the objective status. ACHIEVED can only be claimed by
      // objective.status after an owner transition; keep them distinct.
      lifecycle: {
        objective_status: objStatus,
        all_targets_met: obsOk ? obsOk.observation.all_targets_met : false,
        latest_review_outcome: latest ? String(latest.outcome) : null,
        // F4 — a terminal objective's historical CANDIDATE review is not
        // an actionable inbox item.
        owner_action_required:
          ObjectiveCockpitService.ownerActionPending(obj, latest),
        recommended_status: latest ? (latest.recommended_status ?? null) : null,
      },
      binding: obsOk
        ? {
            binding_id: String(obsOk.observation.binding_id),
            binding_digest: String(obsOk.observation.binding_digest),
          }
        : null,
      observation_error: obsError,
      kpi_summary: {
        all_targets_met: obsOk ? obsOk.observation.all_targets_met : false,
        verified_kpi_count: obsOk ? obsOk.observation.verified_kpi_count : 0,
        unverified_kpi_count: obsOk ? obsOk.observation.unverified_kpi_count : 0,
        gap_kpi_count: obsOk ? obsOk.observation.gap_kpi_count : 0,
      },
      workstreams,
      observer: classes,
      missions: [...missionIds].sort().map((mid) =>
        missionSummary(this.store, this.store.get("mission", mid) as Row)),
      artifacts,
      artifacts_truncated: artifactsTruncated,
      artifacts_dropped_unverified: droppedUnverified,
      latest_review: latest ? reviewSummary(latest) : null,
      review_count: reviews.length,
      auto_policy: this.deps.autoPolicy
        ? (this.deps.autoPolicy.statusReadOnly(objectiveId, actor) as unknown)
        : null,
      auto_driver: this.deps.autoDriver
        ? {
            status: this.deps.autoDriver.statusReadOnly(objectiveId, actor) as unknown,
            // readiness intentionally absent: the canonical claim
            // predicate (scheduler.claimable) commits lazy policy
            // expiry — unreachable without a write; see F1 note on deps.
          }
        : null,
    };
  }

  /** GET /api/vnext/objectives/:id/reviews — bounded, deterministic. */
  objectiveReviews(
    objectiveId: string,
    actor: string,
    limit = 50,
  ): {
    reviews: Array<Record<string, unknown>>;
    total: number;
    returned: number;
    truncated: boolean;
  } {
    this.ownedObjective(objectiveId, actor);
    const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST);
    const rows = this.canonicalReviews(objectiveId);
    return {
      // F4 — newest-first page + truthful totals.
      reviews: rows
        .slice(-cap)
        .map((r) => reviewSummary(r))
        .reverse(),
      total: rows.length,
      returned: Math.min(cap, rows.length),
      truncated: rows.length > cap,
    };
  }

  /** GET /api/vnext/businesses/:id/company — the business header plus
   *  ONLY the objectives this actor owns in it. An actor owning none
   *  gets nothing: FAIL_CLOSED_COMPANY_SCOPE. */
  businessCompany(businessId: string, actor: string): Record<string, unknown> {
    const biz = this.store.get("business", businessId) as Row;
    // F2 — objectives.list() is an explicitly TOLERANT display-path
    // read ("never used for authority decisions"). Re-validate every
    // candidate through the strict read before projecting: a tampered
    // or legacy row fails the whole company read closed rather than
    // silently entering the response.
    // F2/R3 — raw-claim filtering would silently omit a tampered
    // objective (owner rewritten → filtered before validation;
    // business_id rewritten → never enumerated under this business at
    // all; objective_id rewritten → get() fetches the VICTIM row
    // twice and the forged row is never validated). Enumerate by
    // PERSISTED entity key instead: entityPage proves the stored
    // entity_id column ↔ payload.entity_id ↔ payload_hash ↔ version
    // are consistent, so a forged entity_id claim fails closed at
    // enumeration. Then strict-read EVERY actual stored row by its
    // proven key (never by the payload-claimed objective_id) and
    // require objective_id === key — a payload identity alias fails
    // closed even if its digest was recomputed to self-verify.
    // Scope consequence: org-wide fail-closed — one corrupt objective
    // anywhere fails every company read; that is the price of an
    // honest scope proof and there is no smaller honest alternative.
    const allStrict: Row[] = [];
    let after = "";
    for (;;) {
      const page = this.store.entityPage<Row>({
        entity_type: OBJECTIVE_ENTITY,
        after_id: after,
        limit: 1024,
      });
      if (page.length === 0) break;
      for (const p of page) {
        const key = String(p.entity_id); // proven === persisted key
        const strict = this.deps.objectives.get(key) as Row;
        if (String(strict.objective_id) !== key) {
          throw new IntegrityError(
            "FAIL_CLOSED_COCKPIT_IDENTITY",
            `${key}: payload objective_id=${String(strict.objective_id)}`,
          );
        }
        allStrict.push(strict);
      }
      after = String(page[page.length - 1]!.entity_id);
    }
    const ownedStrict = allStrict
      .filter(
        (o) => String(o.business_id) === businessId &&
          String(o.owner_authority_id) === actor,
      )
      // Preserve the previous created_at ordering (entityPage yields
      // entity_id order) so the display page is deterministic.
      .sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.objective_id).localeCompare(String(b.objective_id)),
      );
    if (ownedStrict.length === 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_COMPANY_SCOPE",
        `actor ${actor} owns no objectives in ${businessId}`,
      );
    }
    // Review history + latest per objective — computed for ALL owned
    // objectives so the pending count is exact even when the display
    // list truncates (R2-3).
    const enriched = ownedStrict.map((o) => {
      const reviews = this.canonicalReviews(String(o.objective_id));
      const latest = reviews.length ? reviews[reviews.length - 1]! : null;
      return { o, reviews, latest };
    });
    const summaries = bounded(enriched).map(({ o, reviews, latest }) => {
      // R2-1 — re-prove kpi.current + budget ledger against the
      // canonical evidence chains before they may render as MET /
      // accounted. The classified legitimate terminal-grant end
      // renders as unverifiable, never as verified.
      const proven = this.proveObjectiveClaims(o);
      const kpis = this.kpiProjection(o, proven);
      const met = kpis.filter((k) => k.assessment === "MET").length;
      return {
        objective_id: String(o.objective_id),
        title: o.title ?? null,
        status: String(o.status),
        deadline: o.deadline ?? null,
        created_at: String(o.created_at ?? ""),
        budget: {
          ceiling_microusd:
            Number((o.budget as Row | undefined)?.ceiling_microusd ?? 0),
          consumed_microusd:
            Number((o.budget as Row | undefined)?.consumed_microusd ?? 0),
          canonically_proven: proven,
        },
        kpi_summary: {
          total: kpis.length,
          met,
          gap: kpis.filter((k) => k.assessment === "GAP").length,
          unverified: kpis.filter((k) => k.assessment === "UNVERIFIED").length,
          all_targets_met: kpis.length > 0 && met === kpis.length,
          canonically_proven: proven,
        },
        latest_review: latest
          ? {
              review_id: String(latest.review_id),
              outcome: String(latest.outcome),
              // F4 — no pending inbox on terminal objectives.
              owner_action_required:
                ObjectiveCockpitService.ownerActionPending(o, latest),
              recommended_status: latest.recommended_status ?? null,
              created_at: String(latest.created_at),
            }
          : null,
        review_count: reviews.length,
      };
    });
    return {
      business: {
        business_id: String(biz.business_id),
        name: String(biz.name),
        description: biz.description ?? null,
        currency: String(biz.currency ?? "USD"),
        status: String(biz.status),
        project_id: String(biz.project_id),
        created_at: String(biz.created_at ?? ""),
      },
      objectives: summaries,
      // F4 — truncation is reported, never silently treated as the
      // true total.
      objectives_total_owned: ownedStrict.length,
      objectives_truncated: ownedStrict.length > summaries.length,
      counts: {
        // R2-3 — totals are exact over ALL owned objectives, not the
        // truncated display page.
        objectives_owned: ownedStrict.length,
        objectives_returned: summaries.length,
        targets_met_pending: enriched.filter(
          (e) =>
            ObjectiveCockpitService.ownerActionPending(e.o, e.latest),
        ).length,
      },
    };
  }
}
