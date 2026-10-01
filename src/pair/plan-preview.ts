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
export const RUN_ENTITY = "planner_run";
export const PREVIEW_STATE = {
  READY: "READY",
  CONSUMED: "CONSUMED",
} as const;

export const RUN_STATE = {
  RUNNING: "RUNNING",
  WINNER_SELECTED: "WINNER_SELECTED",
  EXHAUSTED: "EXHAUSTED",
  FAILED: "FAILED",
} as const;

/* ---------- planner_run + durable attempt lifecycle (R1 §3–§5) ----------
 * Every Planner INVOCATION has canonical evidence — even when no preview is
 * ever created (pool exhausted, eligibility failure). The run row is opened
 * before the failover loop; each attempt is persisted STARTED *before* the
 * model is invoked and settled afterwards; exhaustion settles the run as
 * EXHAUSTED. A crash between start and settle leaves durable STARTED
 * evidence instead of pretending the invocation never happened.
 */

export function beginPlannerRun(
  store: PairEvidenceStore,
  args: {
    project_id?: string;
    operator_id?: string;
    routes: string[];
    actor?: string;
    now?: () => string;
  },
): Record<string, unknown> {
  return store.immediate(() => {
    const now = (args.now ?? utcnow)();
    const row = {
      planner_run_id: newId("PRN"),
      state: RUN_STATE.RUNNING,
      project_id: args.project_id != null ? String(args.project_id) : null,
      operator_id: args.operator_id ?? null,
      routes: args.routes,
      attempts: 0,
      winner_attempt_no: null,
      preview_id: null,
      error_code: null,
      started_at: now,
      completed_at: null,
      created_at: now,
    };
    store.put(RUN_ENTITY, String(row.planner_run_id), row, 0);
    store.event({
      entity_type: RUN_ENTITY,
      entity_id: String(row.planner_run_id),
      event_type: "PLANNER_RUN_STARTED",
      new_state: RUN_STATE.RUNNING,
      actor: args.actor ?? "PAIR_PLANNER",
      metadata: { routes: args.routes, project_id: row.project_id },
    });
    return row;
  });
}

/** Persist a STARTED attempt row before the model is invoked — durable
 *  evidence survives a crash mid-call. Returns {planner_attempt_id}. */
export function persistPlannerAttemptStart(
  store: PairEvidenceStore,
  args: {
    planner_run_id: string;
    project_id?: string;
    record: Omit<PlannerAttemptRecord, "outcome">;
    actor?: string;
    now?: () => string;
  },
): { planner_attempt_id: string } {
  return store.immediate(() => {
    const now = (args.now ?? utcnow)();
    const a = args.record;
    const row = {
      planner_attempt_id: newId("PA"),
      planner_run_id: args.planner_run_id,
      preview_id: null,
      project_id: args.project_id ?? null,
      route: a.route,
      provider: a.provider,
      model_entry_id: a.model_entry_id,
      model: a.model,
      role: a.role,
      attempt_no: a.attempt_no,
      started_at: a.started_at,
      completed_at: null,
      latency_ms: null,
      outcome: "STARTED",
      failure_class: null,
      warnings: [],
      plan_digest: null,
      winner: false,
      created_at: now,
    };
    store.put(ATTEMPT_ENTITY, String(row.planner_attempt_id), row, 0);
    store.event({
      entity_type: ATTEMPT_ENTITY,
      entity_id: String(row.planner_attempt_id),
      event_type: "PLANNER_ATTEMPT_STARTED",
      new_state: "STARTED",
      actor: args.actor ?? "PAIR_PLANNER",
      metadata: {
        planner_run_id: args.planner_run_id,
        route: a.route,
        model_entry_id: a.model_entry_id,
        attempt_no: a.attempt_no,
      },
    });
    const run = store.tryGet(RUN_ENTITY, args.planner_run_id);
    if (run) {
      store.put(RUN_ENTITY, args.planner_run_id, { ...run, attempts: Number(run.attempts ?? 0) + 1 }, Number(run.version ?? 0));
    }
    return { planner_attempt_id: String(row.planner_attempt_id) };
  });
}

/** Settle a STARTED attempt row to its final outcome — same row updated,
 *  never a duplicate row per invocation. */
export function settlePlannerAttempt(
  store: PairEvidenceStore,
  args: {
    planner_attempt_id: string;
    record: PlannerAttemptRecord;
    winner?: boolean;
    plan_digest?: string | null;
    actor?: string;
  },
): void {
  const row = store.tryGet(ATTEMPT_ENTITY, args.planner_attempt_id);
  if (!row) return;
  const r = args.record;
  const body = {
    ...row,
    outcome: r.outcome,
    completed_at: r.completed_at,
    latency_ms: r.latency_ms,
    failure_class: r.failure_class ?? null,
    warnings: r.warnings ?? [],
    winner: args.winner ?? false,
    plan_digest: args.plan_digest ?? r.plan_digest ?? null,
  };
  store.put(ATTEMPT_ENTITY, args.planner_attempt_id, body, Number(row.version ?? 0));
  store.event({
    entity_type: ATTEMPT_ENTITY,
    entity_id: args.planner_attempt_id,
    event_type: r.outcome === "SUCCESS" ? "PLANNER_ATTEMPT_SUCCEEDED" : "PLANNER_ATTEMPT_FAILED",
    old_state: "STARTED",
    new_state: r.outcome,
    actor: args.actor ?? "PAIR_PLANNER",
    metadata: {
      planner_run_id: row.planner_run_id,
      route: r.route,
      model_entry_id: r.model_entry_id,
      attempt_no: r.attempt_no,
      latency_ms: r.latency_ms,
      failure_class: r.failure_class ?? null,
    },
  });
}

/** Close the run row: WINNER_SELECTED / EXHAUSTED / FAILED. */
export function finishPlannerRun(
  store: PairEvidenceStore,
  args: {
    planner_run_id: string;
    outcome: string;
    winner_attempt_no?: number;
    error_code?: string;
    actor?: string;
    now?: () => string;
  },
): void {
  const row = store.tryGet(RUN_ENTITY, args.planner_run_id);
  if (!row) return;
  const body = {
    ...row,
    state: args.outcome,
    outcome: args.outcome,
    winner_attempt_no: args.winner_attempt_no ?? row.winner_attempt_no ?? null,
    error_code: args.error_code ?? row.error_code ?? null,
    completed_at: (args.now ?? utcnow)(),
  };
  store.put(RUN_ENTITY, args.planner_run_id, body, Number(row.version ?? 0));
  store.event({
    entity_type: RUN_ENTITY,
    entity_id: args.planner_run_id,
    event_type:
      args.outcome === RUN_STATE.EXHAUSTED
        ? "PLANNER_RUN_EXHAUSTED"
        : args.outcome === RUN_STATE.WINNER_SELECTED
          ? "PLANNER_RUN_WINNER"
          : "PLANNER_RUN_FAILED",
    old_state: String(row.state),
    new_state: args.outcome,
    actor: args.actor ?? "PAIR_PLANNER",
    metadata: { winner_attempt_no: body.winner_attempt_no, error_code: body.error_code },
  });
}

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
    /** R1 — when the failover ran with durable-run hooks, the attempts
     *  already exist as PA_* rows under this run: link them to the preview
     *  here (atomically) instead of writing duplicate rows. */
    planner_run_id?: string;
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
    let linkedAttempts: Array<Record<string, unknown>> = [];
    if (args.planner_run_id) {
      // Durable-run path: attempts were persisted during failover — link the
      // run + its attempt rows to this preview inside the same transaction.
      const run = store.tryGet(RUN_ENTITY, String(args.planner_run_id));
      if (!run) throw new NotFoundError(`planner_run:${String(args.planner_run_id)}`);
      store.put(RUN_ENTITY, String(args.planner_run_id), { ...run, preview_id: previewId }, Number(run.version ?? 0));
      linkedAttempts = store
        .list(ATTEMPT_ENTITY)
        .filter((a) => String(a.planner_run_id) === String(args.planner_run_id))
        .sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no));
      for (const a of linkedAttempts) {
        const isWinner = args.winner != null && Number(a.attempt_no) === Number(args.winner.attempt_no);
        store.put(
          ATTEMPT_ENTITY,
          String(a.planner_attempt_id),
          { ...a, preview_id: previewId, winner: isWinner, plan_digest: isWinner ? args.plan_digest : a.plan_digest ?? null },
          Number(a.version ?? 0),
        );
      }
    }
    for (const a of linkedAttempts.length ? [] : args.attempts) {
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
          ((linkedAttempts.length ? linkedAttempts : store.list(ATTEMPT_ENTITY).filter((r) => String(r.preview_id) === previewId)).find(
            (r) => Number(r.attempt_no) === Number(args.winner!.attempt_no),
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
      planner_run_id: args.planner_run_id ?? null,
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
 * R5 — confirm-path authority guard. A READY preview must carry valid
 * canonical workspace authority persisted by the preview seam (normalization
 * runs BEFORE effective_input_digest/plan_digest at preview creation — never
 * at confirm). A legacy READY preview created before that seam can pin
 * `[]`/missing workspaces under otherwise matching digests; replaying it
 * verbatim would mint an unworkable mission, while defaulting at confirm
 * would widen authority the persisted digests never covered. Neither is
 * allowed: the preview is rejected and must be regenerated through the
 * normal preview flow. ALREADY_CONSUMED previews never reach this check.
 */
export function assertPreviewWorkspaceAuthority(
  missionInput: Record<string, unknown>,
): string[] {
  const ws = missionInput.authorized_workspaces;
  if (
    !Array.isArray(ws) ||
    ws.length === 0 ||
    ws.some((w) => typeof w !== "string" || w.trim() === "")
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_PREVIEW_AUTHORITY_STALE",
      "persisted preview lacks canonical workspace authority — regenerate a fresh plan preview",
    );
  }
  return ws.map((w) => String(w));
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
