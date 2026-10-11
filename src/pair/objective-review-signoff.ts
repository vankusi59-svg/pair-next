/* P15.10-A2 — Owner review sign-off.
 *
 * The ONE seam by which an Objective owner accepts a canonical
 * TARGET_MET_CANDIDATE review and finalizes the Objective ACHIEVED.
 *
 * Authority contract:
 *  - owner-only: actor must equal objective.owner_authority_id (the
 *    same `operator:<id>` identity every owner mutation uses).
 *  - pinned review: the supplied review_id must be the LATEST
 *    canonical adaptive review, still fresh-pinned to the live
 *    objective row (objective_version, objective_terms_version,
 *    objective_digest) — the same freshness predicate the cockpit's
 *    ownerActionPending() projects.
 *  - candidate only: review outcome TARGET_MET_CANDIDATE with
 *    all_targets_met=true, owner_action_required=true,
 *    recommended_status=ACHIEVED.
 *  - no active work: every work_item carrying this objective_id must
 *    already be terminal (DONE/CANCELLED). Running or pending work
 *    blocks sign-off; nothing is cancelled here.
 *  - the transition itself delegates to the existing
 *    ObjectiveAuthorityService.transitionStatus() — no second status
 *    mutation mechanism, and the "never auto-transition" invariant is
 *    preserved because only this owner-invoked route calls it.
 *
 * Idempotency: a durable receipt row (OBJECTIVE_REVIEW_SIGNOFF_ENTITY)
 * carries dedup_key; the replay check resolves INSIDE the same
 * transaction as validation + transition + receipt write, so a retried
 * request returns the stored receipt without a second transition or
 * event, and a same-key/different-semantics replay fails closed.
 */

import { newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import {
  canonicalAdaptiveReviewsFor,
  type ObjectiveAdaptiveReviewDeps,
} from "./objective-adaptive-review.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "./business.js";

export const OBJECTIVE_REVIEW_SIGNOFF_ENTITY = "objective_review_signoff";
export const OBJECTIVE_REVIEW_SIGNOFF_SCHEMA =
  "pair.os.vnext.review-signoff.v1";
export const OBJECTIVE_REVIEW_SIGNED_OFF_EVENT = "OBJECTIVE_REVIEW_SIGNED_OFF";

type Row = Record<string, unknown>;

function signoffFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_REVIEW_SIGNOFF", detail);
}

export interface ObjectiveReviewSignoffDeps {
  store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService;
  /** Strict canonical review reader deps (same set the cockpit uses,
   *  minus the CEO cycle). */
  reviewDeps: Omit<ObjectiveAdaptiveReviewDeps, "ceoCycle">;
}

export class ObjectiveReviewSignoffService {
  constructor(private deps: ObjectiveReviewSignoffDeps) {}

  /** Owner-authorized accept of the latest TARGET_MET_CANDIDATE review.
   *  Returns { signoff, objective, replayed }. Fails closed on every
   *  authority/staleness/active-work violation. */
  signoff(
    objectiveId: string,
    input: {
      actor: string;
      action: string;
      review_id: string;
      idempotency_key: string;
      reason?: string;
    },
  ): { signoff: Row; objective: Row; replayed: boolean } {
    if (!input.actor) {
      throw new IntegrityError(
        "FAIL_CLOSED_OPERATOR_ID_REQUIRED",
        "objective.review-signoff",
      );
    }
    if (input.action !== "accept") {
      throw new IntegrityError(
        "FAIL_CLOSED_REVIEW_SIGNOFF_ACTION",
        `action ${String(input.action)} unsupported — only "accept" is implemented (A2)`,
      );
    }
    const reviewId = String(input.review_id ?? "").trim();
    if (!reviewId) signoffFail("review_id required");
    if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim()) {
      signoffFail("idempotency_key required");
    }
    // Strict canonical objective read (throws NOT_FOUND if absent or
    // non-canonical). Deadline/terminal rules are preserved inside
    // transitionStatus (expireIfDue runs there first).
    this.deps.objectives.get(objectiveId);
    return this.deps.store.immediate(() => {
      const objective = this.deps.objectives.get(objectiveId);
      // Owner proof — identical predicate to assertOwner, surfaced
      // before any other check so a non-owner learns nothing else.
      if (String(objective.owner_authority_id) !== input.actor) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
          `actor ${input.actor} is not owner ${String(objective.owner_authority_id)}`,
        );
      }
      // Durable idempotency — resolved inside the transaction.
      for (const prior of this.deps.store.list<Row>(
        OBJECTIVE_REVIEW_SIGNOFF_ENTITY,
      )) {
        if (
          String(prior.objective_id) === objectiveId &&
          String(prior.dedup_key) === input.idempotency_key
        ) {
          const sameSemantics =
            String(prior.review_id) === reviewId &&
            String(prior.decision) === "accept" &&
            String(prior.actor) === input.actor &&
            String(prior.business_id) === String(objective.business_id);
          if (!sameSemantics) {
            signoffFail(
              `idempotency_key ${input.idempotency_key} replays with different semantics`,
            );
          }
          return { signoff: prior, objective, replayed: true };
        }
      }
      if (String(objective.status) !== "ACTIVE") {
        signoffFail(
          `objective ${objectiveId} status ${String(objective.status)} is not ACTIVE`,
        );
      }
      // Latest canonical review — strict-validated chain, never a
      // mutable projection.
      const reviews = canonicalAdaptiveReviewsFor(
        this.deps.reviewDeps,
        objectiveId,
      )
        .slice()
        .sort(
          (a, b) =>
            String(a.created_at).localeCompare(String(b.created_at)) ||
            String(a.review_id).localeCompare(String(b.review_id)),
        );
      const latest = reviews.at(-1);
      if (!latest || String(latest.review_id) !== reviewId) {
        signoffFail(
          `review ${reviewId} is not the latest canonical review of ${objectiveId}`,
        );
      }
      if (String(latest.outcome) !== "TARGET_MET_CANDIDATE") {
        signoffFail(
          `latest review outcome ${String(latest.outcome)} is not TARGET_MET_CANDIDATE`,
        );
      }
      if (
        latest.all_targets_met !== true ||
        latest.owner_action_required !== true ||
        String(latest.recommended_status ?? "") !== "ACHIEVED"
      ) {
        signoffFail(
          `review ${reviewId} is not an eligible ACHIEVED candidate (all_targets_met/owner_action_required/recommended_status)`,
        );
      }
      // Freshness pins — identical predicate to cockpit
      // ownerActionPending(): the review must still pin the live row.
      if (
        Number(latest.objective_version) !== Number(objective.version) ||
        Number(latest.objective_terms_version) !==
          Number(objective.terms_version) ||
        String(latest.objective_digest) !== String(objective.objective_digest)
      ) {
        signoffFail(
          `review ${reviewId} pins are stale — objective drifted since review`,
        );
      }
      // No active work: every work_item bound to this objective must be
      // terminal. DONE already implies its bound mission completed
      // (work-completion contract), so the mission level is covered.
      for (const w of this.deps.store.list<Row>("work_item")) {
        if (String(w.objective_id) !== objectiveId) continue;
        if (!TERMINAL_WORK_ITEM_STATUSES.has(String(w.status))) {
          signoffFail(
            `work item ${String(w.work_item_id)} status ${String(w.status)} is still active`,
          );
        }
      }
      // The ONE canonical transition — owner-authorized, table-bounded,
      // terminal-safe, atomic, evented. Nested inside this immediate
      // transaction (savepoint): any failure above rolls back together.
      const saved = this.deps.objectives.transitionStatus(objectiveId, {
        business_id: String(objective.business_id),
        to: "ACHIEVED",
        reason: input.reason,
        actor: input.actor,
      });
      const id = newId("RSO");
      const receipt: Row = {
        entity_type: OBJECTIVE_REVIEW_SIGNOFF_ENTITY,
        entity_id: id,
        schema_version: OBJECTIVE_REVIEW_SIGNOFF_SCHEMA,
        signoff_id: id,
        objective_id: objectiveId,
        business_id: String(objective.business_id),
        owner_authority_id: String(objective.owner_authority_id),
        review_id: reviewId,
        decision: "accept",
        decision_status: "ACHIEVED",
        actor: input.actor,
        reason: input.reason ?? null,
        objective_version: Number(objective.version),
        objective_terms_version: Number(objective.terms_version),
        objective_digest: String(objective.objective_digest),
        dedup_key: input.idempotency_key,
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      };
      this.deps.store.put(OBJECTIVE_REVIEW_SIGNOFF_ENTITY, id, receipt, 0);
      this.deps.store.event({
        entity_type: OBJECTIVE_REVIEW_SIGNOFF_ENTITY,
        entity_id: id,
        event_type: OBJECTIVE_REVIEW_SIGNED_OFF_EVENT,
        actor: input.actor,
        metadata: {
          objective_id: objectiveId,
          review_id: reviewId,
          decision: "accept",
          resulting_status: "ACHIEVED",
        },
      });
      return { signoff: receipt, objective: saved, replayed: false };
    });
  }
}
