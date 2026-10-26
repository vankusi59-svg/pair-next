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

import { digest, isCanonicalRiskCeiling, isCanonicalWorkspacePath, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { PAIR_PLAN_CONTRACT_VERSION } from "./plan-dataflow.js";
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

/** P18.6 — the single bounded shape every goal-intent pin conforms to.
 *  Both write paths (beginPlannerRun creation arg and the post-analysis
 *  pinPlannerRunGoalIntent) pass through this clamp — unbounded or
 *  unnormalized evidence never reaches the store. */
function clampGoalIntentEvidence(g: {
  analysis_digest: string;
  block: string;
  ambiguity_class: string;
  status: "analyzed" | "unavailable";
  unavailable_reason: string | null;
  model: string;
  provider_id: string;
  provider_requests: number;
  analysis_ms: number;
  from_cache: boolean;
  source_goal_sha: string;
  context_digest: string | null;
  mode: string;
  source_mode?: string | null;
  analysis?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    analysis_digest: String(g.analysis_digest),
    block: typeof g.block === "string" ? g.block.slice(0, 4096) : "",
    ambiguity_class: String(g.ambiguity_class),
    status: g.status === "analyzed" ? "analyzed" : "unavailable",
    unavailable_reason:
      g.unavailable_reason != null ? String(g.unavailable_reason).slice(0, 200) : null,
    model: String(g.model).slice(0, 120),
    provider_id: String(g.provider_id).slice(0, 120),
    provider_requests: Math.max(0, Math.floor(Number(g.provider_requests) || 0)),
    analysis_ms: Math.max(0, Math.floor(Number(g.analysis_ms) || 0)),
    from_cache: g.from_cache === true,
    source_goal_sha: String(g.source_goal_sha),
    context_digest: g.context_digest != null ? String(g.context_digest) : null,
    mode: String(g.mode),
    source_mode: g.source_mode != null ? String(g.source_mode).slice(0, 40) : null,
    analysis: g.analysis ?? null,
  };
}

export function beginPlannerRun(
  store: PairEvidenceStore,
  args: {
    project_id?: string;
    operator_id?: string;
    routes: string[];
    actor?: string;
    now?: () => string;
    /** Semantic Planning V1 — digest of the PlanningContextEnvelope the
     *  run's prompts were rendered against (evidence-class: advisory,
     *  never bound into plan/effective-input digests). */
    planning_context_digest?: string | null;
    /** The bounded advisory context block actually rendered into the
     *  prompts (≤4096 chars — evidence of what the planner saw). */
    planning_context_block?: string | null;
    /** P18.6 — pinned semantic goal-interpretation evidence for this
     *  run: the bounded GoalIntentAnalysis snapshot + rendered advisory
     *  block + ambiguity classification. Advisory-only — never bound
     *  into effective_input/plan digests. */
    goal_intent?: {
      analysis_digest: string;
      block: string;
      ambiguity_class: string;
      status: "analyzed" | "unavailable";
      unavailable_reason: string | null;
      model: string;
      provider_id: string;
      provider_requests: number;
      analysis_ms: number;
      from_cache: boolean;
      source_goal_sha: string;
      context_digest: string | null;
      mode: string;
      /** Provenance only — the mode the snapshot was produced under
       *  (replan pins stamp live `mode` for gating, this records the
       *  originating run's mode). */
      source_mode?: string | null;
      analysis?: Record<string, unknown> | null;
    } | null;
    /** P18.6 closure — the effective semantic mode durably bound at
     *  run creation. Trustworthy provenance the swallowed-exception
     *  path cannot lose: a "guarded"-stamped run with no pinned
     *  goal_intent evidence fails closed at confirm. */
    semantic_mode?: string | null;
  },
): Record<string, unknown> {
  return store.immediate(() => {
    const now = (args.now ?? utcnow)();
    const row = {
      planner_run_id: newId("PRN"),
      state: RUN_STATE.RUNNING,
      project_id: args.project_id != null ? String(args.project_id) : null,
      semantic_mode:
        args.semantic_mode != null ? String(args.semantic_mode).slice(0, 24) : null,
      operator_id: args.operator_id ?? null,
      routes: args.routes,
      planning_context_digest: args.planning_context_digest ?? null,
      planning_context_block:
        typeof args.planning_context_block === "string"
          ? args.planning_context_block.slice(0, 4096)
          : null,
      // P18.6 — pinned advisory interpretation snapshot (evidence only;
      // authority-binding digests deliberately exclude it). Same clamp
      // contract as pinPlannerRunGoalIntent.
      goal_intent: args.goal_intent != null ? clampGoalIntentEvidence(args.goal_intent) : null,
      attempts: 0,
      // AUDIT R1 F4 — provider requests PROVABLY initiated across all
      // attempts (transport-reported, never inferred from attempt rows).
      // Settlement reads THIS field — never `attempts`. P18.6 — the
      // bounded semantic-analysis request counts against the run's
      // provider request total from row creation.
      provider_requests: Number(args.goal_intent?.provider_requests ?? 0),
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
      metadata: {
        routes: args.routes,
        project_id: row.project_id,
        planning_context_digest: row.planning_context_digest,
      },
    });
    return row;
  });
}

/** P18.6 — pin the bounded semantic goal-interpretation snapshot onto an
 *  open run row AFTER the (already-admitted) analysis step, and fold its
 *  proven provider requests into the run's canonical count so cost
 *  settlement accounts the call exactly like a plan-transport request.
 *  Evidence-only: digests that bind authority deliberately exclude it. */
export function pinPlannerRunGoalIntent(
  store: PairEvidenceStore,
  args: {
    planner_run_id: string;
    goal_intent: {
      analysis_digest: string;
      block: string;
      ambiguity_class: string;
      status: "analyzed" | "unavailable";
      unavailable_reason: string | null;
      model: string;
      provider_id: string;
      provider_requests: number;
      analysis_ms: number;
      from_cache: boolean;
      source_goal_sha: string;
      context_digest: string | null;
      mode: string;
      source_mode?: string | null;
      /** The bounded GoalIntentAnalysis itself — persisted so preview
       *  projection and governed amendment can resolve exact items
       *  against pinned evidence (never a client-supplied analysis). */
      analysis: Record<string, unknown> | null;
    };
    actor?: string;
    now?: () => string;
  },
): void {
  return store.immediate(() => {
    const run = store.tryGet(RUN_ENTITY, String(args.planner_run_id)) as
      | Record<string, unknown>
      | undefined;
    if (!run) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLANNER_RUN_MISSING",
        `planner_run ${args.planner_run_id} not found`,
      );
    }
    const g = args.goal_intent;
    run.goal_intent = clampGoalIntentEvidence(g);
    run.provider_requests =
      Number(run.provider_requests ?? 0) +
      Math.max(0, Math.floor(Number(g.provider_requests) || 0));
    store.put(RUN_ENTITY, String(run.planner_run_id), run, Number(run.version ?? 0));
    store.event({
      entity_type: RUN_ENTITY,
      entity_id: String(run.planner_run_id),
      event_type: "PLANNER_RUN_GOAL_INTENT_PINNED",
      new_state: String(run.state),
      actor: args.actor ?? "PAIR_PLANNER",
      metadata: {
        analysis_digest: g.analysis_digest,
        ambiguity_class: g.ambiguity_class,
        status: g.status,
        from_cache: g.from_cache === true,
        provider_requests: g.provider_requests,
      },
    });
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
      /* P18.2 — bounded record warnings persist on the STARTED row so
         a feedback-informed attempt (PRIOR_REJECTION:<code>) leaves
         durable provenance even when it crashes mid-call — same
         discipline as the REASK: marker. Charset-bound, PAIR markers
         only. */
      warnings: (a.warnings ?? [])
        .filter((w) => /^[A-Z0-9_:.\-]+$/.test(String(w)))
        .slice(0, 10),
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

/** P-REASK R4 — durable PAIR-initiated re-ask provenance: the STARTED
 *  attempt row records `REASK:<code>` BEFORE the second model invocation
 *  so a crash mid-re-ask can never make the second request silently
 *  absent. Same row, never a second planner_attempt; a STARTED→STARTED
 *  event preserves the initiation order. The marker survives inside the
 *  bounded ≤10 warning set (REASK:* is a protected family). */
export function markPlannerAttemptReask(
  store: PairEvidenceStore,
  args: {
    planner_attempt_id: string;
    validation_code: string;
    actor?: string;
  },
): void {
  // P-REASK R1.C — fail closed: a second model invocation must never
  // proceed when durable REASK provenance cannot be established. The
  // thrown codes are governance-class `FAIL_CLOSED_PLANNER_*`, which the
  // P-REASK prefix allowlist does NOT cover — a persistence failure can
  // never recurse into another re-ask.
  const code = String(args.validation_code ?? "");
  if (!code.length || code.length > 80 || !/^[A-Z0-9_:.\-]+$/.test(code)) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLANNER_REASK_PROVENANCE:CODE",
      `reask validation identity rejected for attempt ${String(args.planner_attempt_id)}`,
    );
  }
  store.immediate(() => {
    const row = store.tryGet(ATTEMPT_ENTITY, args.planner_attempt_id);
    if (!row) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLANNER_REASK_PROVENANCE:MISSING",
        `no durable planner_attempt row for ${String(args.planner_attempt_id)}`,
      );
    }
    if (row.outcome !== "STARTED") {
      throw new IntegrityError(
        "FAIL_CLOSED_PLANNER_REASK_PROVENANCE:OUTCOME",
        `planner_attempt ${String(args.planner_attempt_id)} outcome=${String(row.outcome)} — re-ask only on STARTED`,
      );
    }
    const marker = `REASK:${code}`;
    const warnings = Array.isArray(row.warnings)
      ? [...(row.warnings as string[])]
      : [];
    if (!warnings.includes(marker)) {
      warnings.push(marker);
    }
    store.put(
      ATTEMPT_ENTITY,
      args.planner_attempt_id,
      { ...row, warnings: warnings.slice(0, 10) },
      Number(row.version ?? 0),
    );
    store.event({
      entity_type: ATTEMPT_ENTITY,
      entity_id: args.planner_attempt_id,
      event_type: "PLANNER_ATTEMPT_REASK_STARTED",
      old_state: "STARTED",
      new_state: "STARTED",
      actor: args.actor ?? "PAIR_PLANNER",
      metadata: {
        planner_run_id: row.planner_run_id,
        route: row.route,
        model_entry_id: row.model_entry_id,
        attempt_no: row.attempt_no,
        validation_code: code,
      },
    });
  });
}

/** G′ — bounded persistence form of the deterministic PlanCoverageReport
 *  the canonical authority proved. Descriptive evidence only: nothing
 *  reads this back as authority — coverage remains a canonicalize-time
 *  verdict (a plan that failed coverage throws before the sink fires). */
function boundCoverageReport(report: unknown): Record<string, unknown> | null {
  if (typeof report !== "object" || report === null) return null;
  const r = report as { contractDigest?: unknown; verdict?: unknown; rows?: unknown };
  if (r.verdict !== "PASS") return null; // only a proven report is evidence
  const rows = Array.isArray(r.rows) ? r.rows : [];
  return {
    contractDigest: typeof r.contractDigest === "string" ? r.contractDigest.slice(0, 128) : null,
    verdict: "PASS",
    rows: rows.slice(0, 128).map((x) => {
      const row = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
      return {
        requirement_id: String(row.requirement_id ?? "").slice(0, 80),
        kind: String(row.kind ?? "").slice(0, 32),
        state: String(row.state ?? "").slice(0, 32),
        task_keys: (Array.isArray(row.task_keys) ? row.task_keys : [])
          .slice(0, 64)
          .map((k) => String(k).slice(0, 80)),
      };
    }),
  };
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
    /** G′ — the coverage report this attempt's canonical plan proved
     *  (captured via canonicalize coverageSink; null when the attempt
     *  never reached canonicalize or coverage was not proven). */
    coverage_report?: unknown;
    actor?: string;
  },
): void {
  store.immediate(() => {
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
      // AUDIT R1 F4 — transport-reported provider-request count for THIS
      // attempt; settled terminal rows always carry it (0 = provably no
      // provider invocation, e.g. eligibility-rejected before planFn).
      provider_requests: Number(r.provider_requests ?? 0),
      // G′ — coverage evidence the canonical authority proved for THIS
      // attempt's plan; absent → null (never inferred, never refetched).
      coverage_report:
        args.coverage_report !== undefined
          ? boundCoverageReport(args.coverage_report)
          : (row.coverage_report ?? null),
    };
    store.put(ATTEMPT_ENTITY, args.planner_attempt_id, body, Number(row.version ?? 0));
    // AUDIT R1 F4 — aggregate the attempt's proven provider spend onto
    // the run row atomically with the attempt settle: cost settlement
    // keys on run.provider_requests, never the STARTED-row count.
    const run = store.tryGet(RUN_ENTITY, String(row.planner_run_id));
    if (run) {
      store.put(
        RUN_ENTITY,
        String(row.planner_run_id),
        {
          ...run,
          provider_requests:
            Number(run.provider_requests ?? 0) + Number(r.provider_requests ?? 0),
        },
        Number(run.version ?? 0),
      );
    }
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
  /** R1 — the provenance-bound operator request resolved at preview
   *  time. Digest-bound so a drifted operator authority between preview
   *  and confirm is unrepresentable (confirm replays mission_input). */
  operator_goal?: string | null;
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
    operator_goal: input.operator_goal ?? null,
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
    const winnerAttemptRow = args.winner
      ? ((linkedAttempts.length ? linkedAttempts : store.list(ATTEMPT_ENTITY).filter((r) => String(r.preview_id) === previewId)).find(
          (r) => Number(r.attempt_no) === Number(args.winner!.attempt_no),
        ) as Record<string, unknown> | undefined)
      : undefined;
    const winnerAttemptId = winnerAttemptRow
      ? String(winnerAttemptRow.planner_attempt_id ?? "")
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
      // G′ — the deterministic coverage report the WINNING attempt's
      // canonical plan proved (durable attempt evidence, projected
      // verbatim onto the preview; null when the path has no report).
      coverage_report: boundCoverageReport(winnerAttemptRow?.coverage_report),
      planner: args.winner
        ? {
            provider: args.winner.provider,
            model_entry_id: args.winner.model_entry_id,
            model: args.winner.model,
            route: args.winner.route,
            role: args.winner.role,
          }
        : null,
      // R2.2 — authoritative persisted provenance: which plan-contract
      // era minted this preview. Kept outside task metadata so the
      // contract era is container evidence, not a task-local optional
      // marker whose absence could be misread as "legacy".
      plan_contract_version: PAIR_PLAN_CONTRACT_VERSION,
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
  // R6 — the persisted authority must already be canonical (absolute,
  // resolved, byte-for-byte). Validation only — never resolve/mutate here:
  // a relative or otherwise non-canonical entry is stale evidence.
  if (
    !Array.isArray(ws) ||
    ws.length === 0 ||
    ws.some((w) => !isCanonicalWorkspacePath(w))
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_PREVIEW_AUTHORITY_STALE",
      "persisted preview lacks canonical workspace authority — regenerate a fresh plan preview",
    );
  }
  // R7 — risk authority must already be canonical too: a legacy preview
  // pinning `risk_ceiling: null` (digested as null but committed as "HIGH")
  // is stale evidence — reject, never reinterpret.
  if (!isCanonicalRiskCeiling(missionInput.risk_ceiling)) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_PREVIEW_AUTHORITY_STALE",
      "persisted preview lacks canonical risk authority — regenerate a fresh plan preview",
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
