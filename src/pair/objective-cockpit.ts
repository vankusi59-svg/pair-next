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
import {
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
  autoPolicy?: Pick<ObjectiveAutoPolicyService, "status">;
  autoDriver?: Pick<
    ObjectiveAutoDriverService,
    "status" | "readiness"
  >;
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

  private kpiProjection(obj: Row): Array<Record<string, unknown>> {
    return ((obj.kpis as Array<Record<string, unknown>>) ?? []).map((k) => ({
      kpi_id: String(k.kpi_id),
      name: String(k.name),
      unit: String(k.unit ?? ""),
      direction: String(k.direction),
      baseline: Number(k.baseline),
      current: k.current === null || k.current === undefined ? null : Number(k.current),
      target: Number(k.target),
      assessment: objectiveKpiAssessment(k as never),
      last_evidence_key: k.last_evidence_key ?? null,
      updated_at: k.updated_at ?? null,
    }));
  }

  /** The strict review observation — or `null` when the objective has
   *  no canonical binding yet (pre-INITIALIZE). Any other strict-read
   *  failure (tampered work item, forged mission status, corrupt WAL)
   *  propagates: the projection fails closed rather than serving
   *  unverifiable state as truth. */
  private observationOrNull(objectiveId: string): {
    observation: ReviewObservation;
    digest: string;
  } | null {
    try {
      return buildReviewObservation(this.deps, objectiveId);
    } catch (err) {
      if ((err as IntegrityError).code === "FAIL_CLOSED_P15_5_BINDING_REQUIRED") {
        return null;
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
    const reviews = bounded(this.canonicalReviews(objectiveId));
    const latest = reviews.length ? reviews[reviews.length - 1]! : null;
    const obs = this.observationOrNull(objectiveId);

    const workstreams = obs
      ? obs.observation.workstreams.map((w) => this.workstreamProjection(w))
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
    const artifacts = bounded(
      (this.store.list("artifact") as Row[])
        .filter((a) => missionIds.has(String(a.mission_id)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((a) => ({
          artifact_id: String(a.artifact_id),
          logical_name: String(a.logical_name),
          mission_id: String(a.mission_id),
          execution_id: String(a.execution_id),
          state: String(a.state),
          artifact_class: String(a.artifact_class),
          sha256: String(a.sha256),
          byte_size: Number(a.byte_size ?? 0),
          created_at: String(a.created_at),
        })),
    );

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
        },
        hard_constraints: obj.hard_constraints ?? [],
        success_conditions: obj.success_conditions ?? [],
        kpis: this.kpiProjection(obj),
      },
      // TARGET_MET_CANDIDATE lives on the review/pass outcome — never
      // the objective status. ACHIEVED can only be claimed by
      // objective.status after an owner transition; keep them distinct.
      lifecycle: {
        objective_status: String(obj.status),
        all_targets_met: obs ? obs.observation.all_targets_met : false,
        latest_review_outcome: latest ? String(latest.outcome) : null,
        owner_action_required: latest ? latest.owner_action_required === true : false,
        recommended_status: latest ? (latest.recommended_status ?? null) : null,
      },
      binding: obs
        ? {
            binding_id: String(obs.observation.binding_id),
            binding_digest: String(obs.observation.binding_digest),
          }
        : null,
      kpi_summary: {
        all_targets_met: obs ? obs.observation.all_targets_met : false,
        verified_kpi_count: obs ? obs.observation.verified_kpi_count : 0,
        unverified_kpi_count: obs ? obs.observation.unverified_kpi_count : 0,
        gap_kpi_count: obs ? obs.observation.gap_kpi_count : 0,
      },
      workstreams,
      observer: classes,
      missions: [...missionIds].sort().map((mid) =>
        missionSummary(this.store, this.store.get("mission", mid) as Row)),
      artifacts,
      latest_review: latest ? reviewSummary(latest) : null,
      review_count: reviews.length,
      auto_policy: this.deps.autoPolicy
        ? (this.deps.autoPolicy.status(objectiveId, actor) as unknown)
        : null,
      auto_driver: this.deps.autoDriver
        ? {
            status: this.deps.autoDriver.status(objectiveId, actor) as unknown,
            readiness: this.deps.autoDriver.readiness(objectiveId, actor) as unknown,
          }
        : null,
    };
  }

  /** GET /api/vnext/objectives/:id/reviews — bounded, deterministic. */
  objectiveReviews(
    objectiveId: string,
    actor: string,
    limit = 50,
  ): { reviews: Array<Record<string, unknown>> } {
    this.ownedObjective(objectiveId, actor);
    const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST);
    const rows = this.canonicalReviews(objectiveId);
    return {
      reviews: rows
        .slice(-cap)
        .map((r) => reviewSummary(r))
        .reverse(),
    };
  }

  /** GET /api/vnext/businesses/:id/company — the business header plus
   *  ONLY the objectives this actor owns in it. An actor owning none
   *  gets nothing: FAIL_CLOSED_COMPANY_SCOPE. */
  businessCompany(businessId: string, actor: string): Record<string, unknown> {
    const biz = this.store.get("business", businessId) as Row;
    const owned = bounded(
      (this.deps.objectives.list(businessId) as Row[]).filter(
        (o) => String(o.owner_authority_id) === actor,
      ),
    );
    if (owned.length === 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_COMPANY_SCOPE",
        `actor ${actor} owns no objectives in ${businessId}`,
      );
    }
    const summaries = owned.map((o) => {
      const kpis = this.kpiProjection(o);
      const reviews = this.canonicalReviews(String(o.objective_id));
      const latest = reviews.length ? reviews[reviews.length - 1]! : null;
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
        },
        kpi_summary: {
          total: kpis.length,
          met,
          gap: kpis.filter((k) => k.assessment === "GAP").length,
          unverified: kpis.filter((k) => k.assessment === "UNVERIFIED").length,
          all_targets_met: kpis.length > 0 && met === kpis.length,
        },
        latest_review: latest
          ? {
              review_id: String(latest.review_id),
              outcome: String(latest.outcome),
              owner_action_required: latest.owner_action_required === true,
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
      counts: {
        objectives_owned: summaries.length,
        targets_met_pending: summaries.filter(
          (s) => s.latest_review?.owner_action_required === true,
        ).length,
      },
    };
  }
}
