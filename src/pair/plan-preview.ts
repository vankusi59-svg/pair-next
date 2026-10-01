/**
 * plan-preview — durable pinned-plan authority (Phase B, §9–§19, §28–§29).
 *
 * THE PHASE B INVARIANT:
 *   previewed plan == confirmed plan == committed plan == executed plan.
 *
 * Flow: canonical effective input → Planner failover → ONE winning plan →
 * durable `mission_plan_preview` (READY) → operator confirms
 * {preview_id, plan_digest} → server reloads the PERSISTED preview, verifies
 * authority/digest/expiry, consumes it atomically (READY→CONSUMED CAS), and
 * commits EXACTLY the persisted canonical_tasks — the Planner is never
 * invoked a second time.
 *
 * Provenance chain (§29):
 *   operator request → effective_input_digest → planner_attempt rows
 *   (PA_<ulid>) → winning attempt → mission_plan_preview (MPP_<ulid>)
 *   → plan_digest → confirmation → mission_id → exact committed tasks.
 *
 * No raw credentials or unrestricted LLM output are persisted — attempts
 * carry sanitized classes/digests only.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { PlannerAttemptRecord } from "./planner-pool.js";

export const PREVIEW_ENTITY = "mission_plan_preview";
export const ATTEMPT_ENTITY = "planner_attempt";
export const PREVIEW_STATE = {
  READY: "READY",
  CONSUMED: "CONSUMED",
} as const;

export const DEFAULT_PREVIEW_TTL_S = 1800;

/** Canonical effective planning input — every mission-authority field that
 *  can affect the resulting plan, never caller-substituted values (§10). */
export function effectiveInputDigest(input: {
  project_id: string;
  goal: string;
  granted_permissions?: unknown[];
  authorized_workspaces?: unknown[];
  risk_ceiling?: unknown;
  operator_id?: string;
  /** Capability whitelist + per-executor servable sets the planner used. */
  allowed_capabilities?: unknown[];
  capability_sets?: unknown[][];
}): string {
  return digest({
    effective_planning_input: 1,
    project_id: String(input.project_id),
    goal: String(input.goal),
    granted_permissions: input.granted_permissions ?? [],
    authorized_workspaces: input.authorized_workspaces ?? [],
    risk_ceiling: input.risk_ceiling ?? null,
    operator_id: input.operator_id ?? null,
    allowed_capabilities: input.allowed_capabilities ?? [],
    capability_sets: input.capability_sets ?? [],
  });
}

/** plan_digest — exact authoritative plan + authority (§12). Canonical
 *  serialization only (sorted keys via digest()). */
export function planDigest(p: {
  project_id: string;
  effective_input_digest: string;
  tasks: unknown[];
  granted_permissions?: unknown[];
  authorized_workspaces?: unknown[];
  risk_ceiling?: unknown;
}): string {
  return digest({
    plan: 2,
    project_id: p.project_id,
    effective_input_digest: p.effective_input_digest,
    tasks: p.tasks,
    granted_permissions: p.granted_permissions ?? [],
    authorized_workspaces: p.authorized_workspaces ?? [],
    risk_ceiling: p.risk_ceiling ?? null,
  });
}

/**
 * Persist the winning plan + every attempt in ONE transaction: attempts are
 * durable evidence (winner flagged + plan_digest), preview is READY with a
 * bounded expiry. Returns the persisted preview row.
 */
export function createPlanPreview(
  store: PairEvidenceStore,
  args: {
    /** Canonical mission input — persisted verbatim; this is what the
     *  confirm path replays (never the client's resubmission). */
    missionInput: Record<string, unknown>;
    effective_input_digest: string;
    plan_digest: string;
    canonical_tasks: Array<Record<string, unknown>>;
    attempts: PlannerAttemptRecord[];
    winner: PlannerAttemptRecord | null; // null for deterministic template plans
    operator_id?: string;
    ttlSeconds?: number;
    now?: () => string;
  },
): Record<string, unknown> {
  const now = args.now ?? utcnow;
  const ttl = args.ttlSeconds ?? DEFAULT_PREVIEW_TTL_S;
  return store.immediate(() => {
    const created = now();
    const expires = new Date(Date.parse(created) + ttl * 1000).toISOString();
    const previewId = newId("MPP");
    for (const a of args.attempts) {
      const isWinner =
        args.winner != null &&
        Number(a.attempt_no) === Number(args.winner.attempt_no) &&
        String(a.route) === String(args.winner.route);
      const row = {
        planner_attempt_id: newId("PA"),
        preview_id: previewId,
        route: a.route,
        provider: a.provider,
        model_entry_id: a.model_entry_id,
        model: a.model,
        role: a.role,
        attempt_no: a.attempt_no,
        started_at: a.started_at,
        completed_at: a.completed_at,
        latency_ms: a.latency_ms,
        outcome: a.outcome,
        failure_class: a.failure_class ?? null,
        warnings: a.warnings,
        // The winner's digest IS the preview's plan_digest (§29 chain).
        plan_digest: isWinner ? args.plan_digest : (a.plan_digest ?? null),
        winner: isWinner,
        created_at: created,
      };
      store.put(ATTEMPT_ENTITY, String(row.planner_attempt_id), row, 0);
      store.event({
        entity_type: ATTEMPT_ENTITY,
        entity_id: String(row.planner_attempt_id),
        event_type: a.outcome === "SUCCESS" ? "PLANNER_ATTEMPT_SUCCEEDED" : "PLANNER_ATTEMPT_FAILED",
        actor: "PAIR_PLANNER",
        new_state: a.outcome,
        metadata: {
          preview_id: previewId,
          route: a.route,
          provider: a.provider,
          model_entry_id: a.model_entry_id,
          attempt_no: a.attempt_no,
          latency_ms: a.latency_ms,
          failure_class: a.failure_class ?? null,
        },
      });
    }
    const winnerAttemptId = args.winner
      ? String(
          (store.list(ATTEMPT_ENTITY).find(
            (r) => String(r.preview_id) === previewId && Number(r.attempt_no) === Number(args.winner!.attempt_no),
          ) as Record<string, unknown> | undefined)?.planner_attempt_id ?? "",
        )
      : null;
    const preview = {
      preview_id: previewId,
      state: PREVIEW_STATE.READY,
      project_id: String(args.missionInput.project_id),
      operator_id: args.operator_id ?? (args.missionInput.operator_id != null ? String(args.missionInput.operator_id) : null),
      mission_input: args.missionInput,
      effective_input_digest: args.effective_input_digest,
      plan_digest: args.plan_digest,
      canonical_tasks: args.canonical_tasks,
      planner_attempt_id: winnerAttemptId || null,
      planner: args.winner
        ? {
            provider: args.winner.provider,
            model_entry_id: args.winner.model_entry_id,
            model: args.winner.model,
            route: args.winner.route,
            role: args.winner.role,
          }
        : null,
      consumed_mission_id: null,
      created_at: created,
      expires_at: expires,
      version: 0,
    };
    const saved = store.put(PREVIEW_ENTITY, previewId, preview, 0);
    store.event({
      entity_type: PREVIEW_ENTITY,
      entity_id: previewId,
      event_type: "PLAN_PREVIEW_CREATED",
      new_state: PREVIEW_STATE.READY,
      actor: "PAIR_PLANNER",
      metadata: {
        project_id: preview.project_id,
        plan_digest: args.plan_digest,
        effective_input_digest: args.effective_input_digest,
        planner_attempt_id: preview.planner_attempt_id,
        expires_at: expires,
      },
    });
    return saved;
  });
}

/**
 * Verify a confirmation request against the persisted preview. Returns the
 * row on success; throws fail-closed otherwise. Idempotency: a CONSUMED
 * preview returns {consumed:true, mission} instead of throwing — the caller
 * returns the same mission (one preview → at most one mission).
 */
export function verifyPlanPreviewForConfirm(
  store: PairEvidenceStore,
  args: {
    preview_id: string;
    plan_digest: string;
    operator_id?: string;
    now?: () => string;
  },
): { mode: "CONSUME"; preview: Record<string, unknown> } | { mode: "ALREADY_CONSUMED"; mission_id: string } {
  const row = store.tryGet(PREVIEW_ENTITY, String(args.preview_id));
  if (!row) {
    throw new NotFoundError(`mission_plan_preview:${String(args.preview_id)}`);
  }
  // Digest authority first — a wrong digest is a tamper signal even on an
  // already-consumed preview.
  if (String(row.plan_digest) !== String(args.plan_digest)) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_DIGEST_MISMATCH",
      String(args.plan_digest).slice(0, 16),
    );
  }
  if (String(row.state) === PREVIEW_STATE.CONSUMED) {
    return { mode: "ALREADY_CONSUMED", mission_id: String(row.consumed_mission_id) };
  }
  const now = args.now ?? utcnow;
  if (now() > String(row.expires_at)) {
    throw new IntegrityError("FAIL_CLOSED_PLAN_PREVIEW_EXPIRED", String(row.preview_id));
  }
  // Operator binding: a preview minted for operator O can only be consumed
  // by O (when the preview carries an operator at all).
  if (row.operator_id != null && args.operator_id != null && String(row.operator_id) !== String(args.operator_id)) {
    throw new IntegrityError("FAIL_CLOSED_PLAN_PREVIEW_OPERATOR", String(args.operator_id));
  }
  return { mode: "CONSUME", preview: row };
}

/**
 * Atomically mark the preview consumed by mission_id — CAS on version so a
 * concurrent confirm can never double-mint a mission. Must run inside the
 * same transaction as the mission creation.
 */
export function consumePlanPreview(
  store: PairEvidenceStore,
  preview: Record<string, unknown>,
  missionId: string,
): void {
  const row = {
    ...preview,
    state: PREVIEW_STATE.CONSUMED,
    consumed_mission_id: missionId,
  };
  store.put(PREVIEW_ENTITY, String(preview.preview_id), row, Number(preview.version ?? 0));
  store.event({
    entity_type: PREVIEW_ENTITY,
    entity_id: String(preview.preview_id),
    event_type: "PLAN_PREVIEW_CONSUMED",
    old_state: PREVIEW_STATE.READY,
    new_state: PREVIEW_STATE.CONSUMED,
    actor: "PAIR_PLANNER",
    metadata: { consumed_mission_id: missionId, plan_digest: preview.plan_digest },
  });
}
