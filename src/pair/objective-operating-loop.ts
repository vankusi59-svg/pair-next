/**
 * P15.6 — OBJECTIVE OPERATING LOOP / OPERATIONAL CLOSURE.
 *
 * ONE bounded controller that composes the existing governed seams so
 * an operator no longer drives CEO → allocation → open → completion
 * sync → KPI review → strategy → next work by hand:
 *
 *   Objective → P15.3 CEO → P15.2/P14 graph → P15.4 allocation →
 *   delegated child → BusinessLayer.openWorkItem → Mission runtime →
 *   canonical completion → P15.5 review/strategy → next decision.
 *
 * P15.6 IS A CONTROLLER — NOT A NEW AUTHORITY:
 *  - zero new durable authority tables; every fact it consumes comes
 *    from strict canonical reads of the owning seam (P15.1 objective,
 *    P15.2 binding, P15.4 WAL, P14 lifecycle evidence, P15.5 review).
 *  - the ONLY execution crossing is BusinessLayer.openWorkItem() —
 *    never MissionControl/MissionRouter/CapabilityRouter/executor.
 *  - at most ONE CEO decision (binding absent) and at most ONE P15.5
 *    review per pass; at most ONE new Mission dispatch per pass.
 *  - no transaction is ever held across model/executor work — crash
 *    safety comes from deterministic replay/adoption of the seams.
 *  - no daemon, scheduler, polling, Telegram loop or mutable
 *    current_step row: the pass is restart-safe by construction —
 *    every committed authority is re-derived, never trusted.
 */

import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { BusinessLayer } from "./business.js";
import { TERMINAL_MISSION_STATUSES } from "./business.js";
import { assertCanonicalMissionLifecycle } from "./work-completion.js";
import type { ObjectiveAuthorityService, ObjectiveKpi } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import type { WorkforceService } from "./work-graph.js";
import type { CeoPlanningCycleService } from "./ceo-planning-cycle.js";
import type { CeoDecisionInvoker } from "./ceo-decision.js";
import { createDefaultCeoPlanningCycle } from "./ceo-runtime.js";
import { WorkforceAllocationService } from "./workforce-allocation.js";
import {
  assertCanonicalAdaptiveReview,
  assertCanonicalObjectiveBudget,
  assertCanonicalObjectiveKpiProgress,
  buildReviewObservation,
  OBJECTIVE_ADAPTIVE_REVIEW_ENTITY,
  objectiveKpiAssessment,
  ObjectiveAdaptiveReviewService,
  type ObjectiveAdaptiveReviewDeps,
  type ReviewObservation,
  type ReviewWorkstreamProjection,
} from "./objective-adaptive-review.js";

type Row = Record<string, unknown> & { version: number };

/** A pass may perform several immediately-convergent internal steps
 *  but always stops at an EXTERNAL wait boundary — never a while(true). */
export const OBJECTIVE_OPERATING_MAX_INTERNAL_STEPS = 8;
/** R1: at most ONE new Mission dispatch per pass — bounded cost,
 *  meaningful priority semantics, understandable retries, safe live use. */
export const OBJECTIVE_OPERATING_MAX_DISPATCHES_PER_PASS = 1;

export const OPERATING_OUTCOMES = [
  "DISPATCHED",
  "AWAITING_EXECUTION",
  "REVIEW_REQUIRED",
  "WAITING_FOR_CEO",
  "WAITING",
  "TARGET_MET_CANDIDATE",
  "TOPOLOGY_CHANGE_REQUIRED",
  "INSUFFICIENT_VERIFIED_PROGRESS",
  "OBJECTIVE_BUDGET_EXHAUSTED",
  "NO_ELIGIBLE_AGENT",
  "DEPENDENCY_BLOCKED",
  "OBJECTIVE_NOT_ACTIVE",
] as const;
export type OperatingOutcome = (typeof OPERATING_OUTCOMES)[number];

/** Observability/control-flow result — NOT a competing authority. */
export interface OperatingPassResult {
  outcome: OperatingOutcome;
  objective_id: string;
  owner_action_required?: boolean;
  binding_id?: string;
  workstream_key?: string;
  allocation_id?: string;
  delegated_child_work_item_id?: string;
  mission_id?: string;
  review_id?: string;
  strategy_revision_id?: string;
  ceo_decision_id?: string;
  blocked_workstream_keys?: string[];
  no_eligible_workstream_keys?: string[];
  detail?: string;
}

export interface ObjectiveOperatingDeps extends ObjectiveAdaptiveReviewDeps {
  /** ONE P15.3 cycle shared with the review service — never two paths. */
  ceoCycle: CeoPlanningCycleService;
  review: ObjectiveAdaptiveReviewService;
  allocation: WorkforceAllocationService;
}

function operatingFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_P15_6_OPERATING_LOOP", detail);
}

/** Internal bound trip — converted to a typed WAITING result. */
class PassBoundExceeded extends Error {}

export class ObjectiveOperatingService {
  private stepsUsed = 0;

  constructor(private readonly deps: ObjectiveOperatingDeps) {}

  private get store(): PairEvidenceStore { return this.deps.store; }

  private tick(): void {
    if (++this.stepsUsed > OBJECTIVE_OPERATING_MAX_INTERNAL_STEPS) {
      throw new PassBoundExceeded();
    }
  }

  /**
   * ONE bounded operating pass over the canonical Objective state.
   * Restart-safe: every decision is re-derived from committed
   * authority; a crash anywhere leaves the next pass convergent.
   */
  async runObjectivePass(input: {
    objective_id: string;
    actor: string;
  }): Promise<OperatingPassResult> {
    if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "operating.runObjectivePass");
    }
    const actor = input.actor;
    const objectiveId = String(input.objective_id ?? "");
    if (!objectiveId || objectiveId.length > 256) {
      operatingFail("objective_id malformed");
    }
    try {
      return await this.pass(objectiveId, actor);
    } catch (e) {
      if (e instanceof PassBoundExceeded) {
        // Deterministic external-wait boundary: the committed seams
        // already made progress; the next pass continues from them.
        return { outcome: "WAITING", objective_id: objectiveId, detail: "internal step bound reached" };
      }
      throw e;
    }
  }

  private async pass(objectiveId: string, actor: string): Promise<OperatingPassResult> {
    this.stepsUsed = 0;
    const result = (o: OperatingOutcome, extra?: Partial<OperatingPassResult>): OperatingPassResult => ({
      outcome: o, objective_id: objectiveId, ...extra,
    });

    // §5 — pre-flight objective authority. P15.1 deadline semantics
    // only; never auto-transition ACHIEVED/INFEASIBLE/CANCELLED.
    this.deps.objectives.evaluateDeadline(objectiveId);
    const objective = this.deps.objectives.get(objectiveId); // strict P15.1
    if (String(objective.status) !== "ACTIVE") {
      return result("OBJECTIVE_NOT_ACTIVE");
    }

    // §6 — strict KPI + budget pre-flight: the EXACT P15.5 proofs.
    assertCanonicalObjectiveKpiProgress(this.store, objective);
    assertCanonicalObjectiveBudget(this.store, objective);
    const kpis = objective.kpis as ObjectiveKpi[];
    const allTargetsMet = kpis.length > 0 &&
      kpis.every((k) => objectiveKpiAssessment(k) === "MET");
    const budget = objective.budget as Record<string, unknown>;
    const budgetExhausted =
      Number(budget.consumed_microusd) >= Number(budget.ceiling_microusd);

    let binding = this.deps.workstreams.getBinding(objectiveId); // strict

    // All targets canonically MET → ZERO new work. With a binding, the
    // canonical P15.5 review (deterministic, zero model call) commits
    // the recommendation; pre-binding the result is non-authoritative.
    if (allTargetsMet) {
      if (binding) {
        this.tick();
        const review = await this.deps.review.runReview({ objective_id: objectiveId, actor });
        return result("TARGET_MET_CANDIDATE", {
          owner_action_required: true,
          binding_id: String(binding.binding_id),
          review_id: String(review.review.review_id),
        });
      }
      return result("TARGET_MET_CANDIDATE", { owner_action_required: true });
    }

    // §7 — initial objective bootstrap through the EXISTING P15.3
    // cycle only (never another CEO path, never Planner/Brain/executor).
    if (!binding) {
      if (budgetExhausted) return result("OBJECTIVE_BUDGET_EXHAUSTED");
      this.tick();
      const cycle = await this.deps.ceoCycle.runCycle({ objective_id: objectiveId, actor });
      if (String(cycle.decision.decision_kind) === "WAIT") {
        return result("WAITING_FOR_CEO", { ceo_decision_id: String(cycle.decision.decision_id) });
      }
      // INITIALIZE materialized through P15.2 inside runCycle; any
      // impossible PRIORITIZE without binding fails closed inside P15.3.
      binding = cycle.binding ?? this.deps.workstreams.getBinding(objectiveId);
      if (!binding) operatingFail("INITIALIZE committed without a canonical binding");
    }

    // §9 — reconcile existing objective work BEFORE any new action.
    //    One strict projection re-derives every lifecycle fact.
    let obs = this.observe(objectiveId);
    const synced = this.reconcileDelegatedChildren(obs, actor);
    if (synced) obs = this.observe(objectiveId); // fresh canonical classes

    // §17 — classify from canonical lifecycle evidence only.
    const launchable = obs.workstreams.filter((w) =>
      w.delegated_child_class === "ACTIVE" &&
      w.delegated_child_status === "READY" &&
      !w.delegated_child_bound_mission);
    const activeExecution = obs.workstreams.find((w) =>
      w.delegated_child_class === "ACTIVE" &&
      w.delegated_child_status === "IN_PROGRESS");
    const reviewPending = obs.workstreams.find((w) =>
      w.workstream_status === "REVIEW_REQUIRED" ||
      w.delegated_child_status === "REVIEW_REQUIRED");
    if (reviewPending) {
      // Governed review is a human gate — no auto ACCEPT/REWORK.
      return result("REVIEW_REQUIRED", {
        binding_id: String(binding.binding_id),
        workstream_key: reviewPending.workstream_key,
        delegated_child_work_item_id: reviewPending.delegated_child_work_item_id ?? undefined,
      });
    }
    if (activeExecution) {
      return result("AWAITING_EXECUTION", {
        binding_id: String(binding.binding_id),
        workstream_key: activeExecution.workstream_key,
        delegated_child_work_item_id: activeExecution.delegated_child_work_item_id ?? undefined,
        mission_id: this.boundMissionId(activeExecution),
      });
    }

    // Latest canonical strategy drives the operating order (§11); a
    // forged revision fails closed inside the strict chain read.
    const strategy = this.deps.review.getLatestStrategy(objectiveId);
    const rankOf = this.orderRanker(obs, strategy);

    // §13 — an already-committed allocation (canonical READY child, no
    // bound Mission) is previously authorized work: open it directly,
    // never ask the CEO again for crash continuation.
    if (launchable.length > 0) {
      if (budgetExhausted) return result("OBJECTIVE_BUDGET_EXHAUSTED");
      launchable.sort((a, b) => rankOf(a.workstream_key) - rankOf(b.workstream_key));
      const opened = this.openDelegatedChild(
        launchable[0]!.delegated_child_work_item_id!, actor, result);
      return opened;
    }

    // §12 — binding + nothing launchable + no active execution → the
    //    canonical P15.5 review decides BEFORE any NEW allocation.
    //    §8 bootstrap exception: binding + zero WALs + zero reviews →
    //    execute the canonical P15.2 binding order directly.
    const bootstrap = obs.workstreams.every((w) => w.allocation_state === "NONE") &&
      this.canonicalReviewCount(objectiveId) === 0;
    let order: string[];
    if (bootstrap) {
      order = (binding.workstreams as Array<Record<string, unknown>>)
        .map((w) => String(w.workstream_key));
    } else {
      if (budgetExhausted) return result("OBJECTIVE_BUDGET_EXHAUSTED");
      this.tick();
      const reviewRes = await this.deps.review.runReview({ objective_id: objectiveId, actor });
      const reviewId = String(reviewRes.review.review_id);
      switch (reviewRes.outcome) {
        case "PRIORITIZE_EXISTING": {
          const head = reviewRes.strategy_revision ?? this.deps.review.getLatestStrategy(objectiveId);
          if (!head) operatingFail("PRIORITIZE_EXISTING without a canonical strategy revision");
          order = (head.actionable_order as string[]).map(String);
          break;
        }
        case "TARGET_MET_CANDIDATE":
          return result("TARGET_MET_CANDIDATE", { owner_action_required: true, review_id: reviewId });
        case "TOPOLOGY_CHANGE_REQUIRED":
          return result("TOPOLOGY_CHANGE_REQUIRED", { review_id: reviewId });
        case "INSUFFICIENT_VERIFIED_PROGRESS":
          return result("INSUFFICIENT_VERIFIED_PROGRESS", { review_id: reviewId });
        case "WAIT":
          return result("WAITING", { review_id: reviewId });
        case "AWAITING_PROGRESS":
          // Review re-proved canonical activity — respect it.
          return result("WAITING", { review_id: reviewId });
        default:
          operatingFail(`review outcome ${String(reviewRes.outcome)} outside operating vocabulary`);
      }
    }

    // §14/§18 — at most ONE new Mission: walk the operating order,
    //    skip exhausted/allocated/blocked, allocate the rest through
    //    the EXISTING P15.4 seam and open the exact delegated child.
    const blocked: string[] = [];
    const noEligible: string[] = [];
    const byKey = new Map(obs.workstreams.map((w) => [w.workstream_key, w]));
    // Canonical binding order appends any keys absent from the
    // strategy's actionable subset (actionable_order ⊆ binding keys).
    const fullOrder = [
      ...order,
      ...(binding.workstreams as Array<Record<string, unknown>>)
        .map((w) => String(w.workstream_key))
        .filter((k) => !order.includes(k)),
    ];
    for (const key of fullOrder) {
      const w = byKey.get(key);
      if (!w) continue;
      // Skip canonically exhausted or operator-intervened workstreams;
      // allocated children were already classified above.
      if (this.workstreamExhausted(w) || w.allocation_state !== "NONE" ||
          w.workstream_status === "BLOCKED") continue;
      this.tick();
      const alloc = this.deps.allocation.allocateWorkstream({
        objective_id: objectiveId, workstream_key: key, actor,
      });
      if (alloc.status === "dependency_blocked") { blocked.push(key); continue; }
      if (alloc.status === "no_eligible_agent") { noEligible.push(key); continue; }
      // allocated | replayed — use the EXACT delegated child. §27:
      // a dispatch still carries the blocked keys as observability.
      const childId = String(alloc.delegated_child_work_item_id);
      return this.openDelegatedChild(childId, actor, result, {
        workstream_key: key,
        allocation_id: String(alloc.allocation!.workforce_allocation_id ??
                              alloc.allocation!.allocation_id ?? ""),
        ...(blocked.length ? { blocked_workstream_keys: [...blocked] } : {}),
        ...(noEligible.length ? { no_eligible_workstream_keys: [...noEligible] } : {}),
      });
    }
    if (blocked.length > 0) {
      return result("DEPENDENCY_BLOCKED", { blocked_workstream_keys: blocked });
    }
    if (noEligible.length > 0) {
      return result("NO_ELIGIBLE_AGENT", { no_eligible_workstream_keys: noEligible });
    }
    return result("WAITING", { detail: "no actionable workstream this pass" });
  }

  /** §9 objective-scoped reconciliation ONLY (never the global
   *  reconcileWorkLifecycle): fold canonically-terminal bound Missions
   *  of IN_PROGRESS delegated children, then resume the interrupted
   *  parent cascade through the existing authority. */
  private reconcileDelegatedChildren(obs: ReviewObservation, actor: string): boolean {
    let synced = false;
    for (const w of obs.workstreams) {
      if (w.delegated_child_class !== "INTERVENTION" ||
          w.delegated_child_status !== "IN_PROGRESS" ||
          !w.delegated_child_work_item_id) continue;
      const child = this.store.get("work_item", w.delegated_child_work_item_id) as Row;
      const mission = this.deps.business.boundMissionForWorkItem(child);
      if (!mission || !TERMINAL_MISSION_STATUSES.has(String(mission.status))) continue;
      // syncWorkItem is the canonical fold authority; it re-validates
      // the WOB/mission lineage itself and materializes DONE/WCP or
      // REVIEW_REQUIRED — never a direct status write.
      this.tick();
      this.deps.business.syncWorkItem(w.delegated_child_work_item_id);
      this.deps.business.advanceCompletionCascade(w.delegated_child_work_item_id, actor);
      synced = true;
    }
    return synced;
  }

  /** §15/§16 — the SINGLE governed execution crossing. Every final
   *  execution gate is re-proven inside openWorkItem; the open race
   *  converges ONLY through a fully-proven canonical bound Mission
   *  (§20) — anything else propagates. */
  private openDelegatedChild(
    childId: string,
    actor: string,
    result: (o: OperatingOutcome, extra?: Partial<OperatingPassResult>) => OperatingPassResult,
    extra?: Partial<OperatingPassResult>,
  ): OperatingPassResult {
    this.tick();
    let saved: Row;
    try {
      saved = this.deps.business.openWorkItem(childId, actor) as Row;
    } catch (err) {
      // An open loser converges only when the canonical bound Mission
      // is fully proven (§20); every other failure propagates.
      const child = this.store.tryGet("work_item", childId) as Row | null;
      const mission = child ? this.deps.business.boundMissionForWorkItem(child) : null;
      if (mission && !TERMINAL_MISSION_STATUSES.has(String(mission.status))) {
        assertCanonicalMissionLifecycle(this.store, mission, String(mission.status));
        return result("AWAITING_EXECUTION", {
          delegated_child_work_item_id: childId,
          mission_id: String(mission.mission_id),
          ...extra,
        });
      }
      throw err;
    }
    const mission = this.deps.business.boundMissionForWorkItem(saved);
    return result("DISPATCHED", {
      delegated_child_work_item_id: childId,
      mission_id: mission ? String(mission.mission_id) : undefined,
      ...extra,
    });
  }

  private observe(objectiveId: string): ReviewObservation {
    return buildReviewObservation(this.deps, objectiveId).observation;
  }

  /** §8 bootstrap proof — every objective-attributed P15.5 row is
   *  strict-validated; a malformed review history is corrupt authority
   *  and fails closed, never silently counted absent. */
  private canonicalReviewCount(objectiveId: string): number {
    const rows = (this.store.list(OBJECTIVE_ADAPTIVE_REVIEW_ENTITY) as Row[])
      .filter((r) => String(r.objective_id) === objectiveId);
    for (const r of rows) assertCanonicalAdaptiveReview(this.deps, r);
    return rows.length;
  }

  private workstreamExhausted(w: ReviewWorkstreamProjection): boolean {
    return w.completion_proven ||
      w.workstream_status === "CANCELLED" ||
      w.delegated_child_status === "DONE" ||
      w.delegated_child_status === "CANCELLED";
  }

  private boundMissionId(w: ReviewWorkstreamProjection): string | undefined {
    if (!w.delegated_child_work_item_id) return undefined;
    const child = this.store.tryGet("work_item", w.delegated_child_work_item_id) as Row | null;
    const mission = child ? this.deps.business.boundMissionForWorkItem(child) : null;
    return mission ? String(mission.mission_id) : undefined;
  }

  /** Rank a workstream key by the latest canonical strategy's
   *  actionable_order; keys outside it fall back to canonical P15.2
   *  binding position. Never copies priority into mutable rows. */
  private orderRanker(
    obs: ReviewObservation, strategy: Row | null,
  ): (key: string) => number {
    const actionable = strategy
      ? (strategy.actionable_order as string[]).map(String)
      : [];
    const stratRank = new Map(actionable.map((k, i) => [k, i] as const));
    const bindingRank = new Map(
      obs.workstreams.map((w, i) => [w.workstream_key, i] as const));
    return (key: string) =>
      (stratRank.get(key) ?? 1_000_000) * 1_000_000 + (bindingRank.get(key) ?? 0);
  }
}

/**
 * §30 — default composition: ONE createDefaultCeoPlanningCycle instance
 * shared between the P15.6 bootstrap path and the P15.5 review
 * service. No caller-supplied model_entry_id — canonical resolution
 * stays inside P15.3W.
 */
export function createDefaultObjectiveOperatingService(deps: {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
  invoker?: CeoDecisionInvoker;
}): { service: ObjectiveOperatingService; model_entry_id: string } {
  const { service: ceoCycle, model_entry_id } = createDefaultCeoPlanningCycle(deps);
  const review = new ObjectiveAdaptiveReviewService({ ...deps, ceoCycle });
  const allocation = new WorkforceAllocationService(deps);
  return {
    service: new ObjectiveOperatingService({ ...deps, ceoCycle, review, allocation }),
    model_entry_id,
  };
}
