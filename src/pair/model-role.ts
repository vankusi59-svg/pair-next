/**
 * model-role — canonical model role authority (Phase A / Objectives B+C).
 *
 * A model/route may serve the Planner only when canonically authorized as
 * PLANNER_COORDINATOR, and DSH task execution only as DSH_EXECUTION. Roles
 * live in a canonical `model_role_assignment` entity keyed by model_entry_id
 * — the strongest existing catalog identity (ME_<digest(provider_family,
 * model_id)>) — never inferred from env position alone: env config declares
 * which route fills which role, the assignment records that decision, and the
 * role asserts re-prove it at use time.
 *
 * HARD INVARIANT: PlannerModelPool ∩ DshExecutionModelPool = ∅. The same
 * canonical model must not hold both roles — two routes resolving to one
 * model_entry_id count as one model.
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { providerModelEligibility } from "./model-routable.js";
import { PLANNER_FAILURE_CLASS, type PlannerFailureClass } from "./planner-pool.js";
import type { PairEvidenceStore } from "./store.js";

export const MODEL_ROLE = {
  PLANNER_COORDINATOR: "PLANNER_COORDINATOR",
  DSH_EXECUTION: "DSH_EXECUTION",
} as const;
export type ModelRole = (typeof MODEL_ROLE)[keyof typeof MODEL_ROLE];
export const MODEL_ROLES = new Set<string>(Object.values(MODEL_ROLE));

export function modelRoleAssignmentId(modelEntryId: string): string {
  return `MRA_${digest({ model_entry_id: String(modelEntryId) }).slice(0, 24)}`;
}

/** Look up a model's canonical assigned role, or null when unassigned/revoked. */
export function modelRoleOf(store: PairEvidenceStore, modelEntryId: string): ModelRole | null {
  const row = store.tryGet("model_role_assignment", modelRoleAssignmentId(modelEntryId));
  const role = row?.role;
  return typeof role === "string" && MODEL_ROLES.has(role) ? (role as ModelRole) : null;
}

export function listModelRoleAssignments(store: PairEvidenceStore): Array<Record<string, unknown>> {
  return store
    .list("model_role_assignment")
    .sort((a, b) => String(a.assignment_id).localeCompare(String(b.assignment_id)));
}

/**
 * Assign (or explicitly re-assign) a canonical role to a model_entry.
 * Create-only on first assignment; a different later role is an explicit
 * audited reassignment (MODEL_ROLE_REASSIGNED event), never a silent flip.
 */
export function assignModelRole(
  store: PairEvidenceStore,
  modelEntryId: string,
  role: string,
  opts: { actor?: string } = {},
): Record<string, unknown> {
  const actor = opts.actor ?? "PAIR_MODEL_ROLE";
  const mid = String(modelEntryId);
  if (!MODEL_ROLES.has(role)) {
    throw new IntegrityError("FAIL_CLOSED_MODEL_ROLE_INVALID", JSON.stringify(role).slice(0, 120));
  }
  const model = store.tryGet("model_entry", mid);
  if (!model) {
    throw new NotFoundError(`model_entry:${mid}`);
  }
  const aid = modelRoleAssignmentId(mid);
  const existing = store.tryGet("model_role_assignment", aid);
  if (existing && existing.role !== null) {
    if (String(existing.role) === role) return existing;
    const body = {
      ...existing,
      role,
      reassigned_from: existing.role,
      reassigned_at: utcnow(),
      assigned_by: actor,
      version: Number(existing.version),
    };
    const saved = store.put("model_role_assignment", aid, body, Number(existing.version));
    store.event({
      entity_type: "model_role_assignment",
      entity_id: aid,
      event_type: "MODEL_ROLE_REASSIGNED",
      old_state: String(existing.role),
      new_state: role,
      actor,
      metadata: { model_entry_id: mid },
    });
    return saved;
  }
  const body = {
    assignment_id: aid,
    model_entry_id: mid,
    role,
    provider_id: model.provider_id ?? null,
    provider_family: model.provider_family ?? null,
    model_id: model.model_id ?? null,
    assigned_by: actor,
    assigned_at: utcnow(),
    version: existing ? Number(existing.version) : 0,
  };
  const saved = store.put("model_role_assignment", aid, body, existing ? Number(existing.version) : 0);
  store.event({
    entity_type: "model_role_assignment",
    entity_id: aid,
    event_type: "MODEL_ROLE_ASSIGNED",
    new_state: role,
    actor,
    metadata: { model_entry_id: mid },
  });
  return saved;
}

/** Revoke an assignment (operator reconfiguration). Audited — never silent. */
export function revokeModelRole(
  store: PairEvidenceStore,
  modelEntryId: string,
  opts: { actor?: string } = {},
): void {
  const mid = String(modelEntryId);
  const aid = modelRoleAssignmentId(mid);
  const existing = store.tryGet("model_role_assignment", aid);
  if (!existing || existing.role === null) return;
  const body = {
    ...existing,
    role: null,
    revoked_from: existing.role,
    revoked_at: utcnow(),
    revoked_by: opts.actor ?? "PAIR_MODEL_ROLE",
    version: Number(existing.version),
  };
  store.put("model_role_assignment", aid, body, Number(existing.version));
  store.event({
    entity_type: "model_role_assignment",
    entity_id: aid,
    event_type: "MODEL_ROLE_REVOKED",
    old_state: String(existing.role),
    actor: opts.actor ?? "PAIR_MODEL_ROLE",
    metadata: { model_entry_id: mid },
  });
}

/** Require a model to hold `role` — fail closed on missing/wrong role. */
export function assertModelRole(store: PairEvidenceStore, modelEntryId: string, role: ModelRole): void {
  const mid = String(modelEntryId);
  const model = store.tryGet("model_entry", mid);
  if (!model) throw new NotFoundError(`model_entry:${mid}`);
  const actual = modelRoleOf(store, mid);
  if (actual === null) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_ROLE_UNASSIGNED",
      JSON.stringify({ model_entry_id: mid, required_role: role }),
    );
  }
  if (actual !== role) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_ROLE_MISMATCH",
      JSON.stringify({ model_entry_id: mid, required_role: role, actual_role: actual }),
    );
  }
  const conditions = (model.conditions ?? []) as string[];
  if (conditions.some((c) => ["REMOVED", "DEPRECATED", "BLOCKED"].includes(c))) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE",
      JSON.stringify({ model_entry_id: mid, required_role: role, conditions }),
    );
  }
}

export function assertPlannerModelRole(store: PairEvidenceStore, modelEntryId: string): void {
  assertModelRole(store, modelEntryId, MODEL_ROLE.PLANNER_COORDINATOR);
}

export function assertDshExecutionModelRole(store: PairEvidenceStore, modelEntryId: string): void {
  assertModelRole(store, modelEntryId, MODEL_ROLE.DSH_EXECUTION);
}

/**
 * Full canonical eligibility proof for a Planner candidate (Phase B R1 §9).
 * Runs before EVERY planner model invocation — qualification captured at
 * startup is never trusted as still-current:
 *
 *  1. model_entry exists, still holds PLANNER_COORDINATOR, and is not
 *     REMOVED/DEPRECATED/BLOCKED (assertModelRole);
 *  2. its provider is still canonically eligible — lifecycle in
 *     PROVIDER_OK_STATES (the existing qualification authority; no
 *     duplicate qualification seam is created here);
 *  3. the candidate is not canonically a DSH_EXECUTION model/alias —
 *     sameCanonicalModel against every active DSH assignment.
 *
 * Two verdict channels (R2 §4 — documented classification):
 *
 * AUTHORITY / GOVERNANCE → IntegrityError thrown, propagates, NEVER
 * failover-eligible (do not silently borrow another authority):
 *   - role missing/revoked/mismatch, model REMOVED/DEPRECATED/BLOCKED
 *     (assertPlannerModelRole), model or its proven alias holds
 *     DSH_EXECUTION (FAIL_CLOSED_PLANNER_DSH_OVERLAP)
 *   - provider row absent or lifecycle not canonically eligible,
 *     provider auth failed, provider DISABLED/UNQUALIFIED
 *     (FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE)
 *
 * TEMPORARY AVAILABILITY → returns {reject:true, failure_class} — a
 * failover-eligible candidate rejection consistent with Planner failure
 * policy (the model is never invoked; the next candidate may win):
 *   - model lifecycle no longer QUALIFIED → MODEL_UNAVAILABLE
 *   - model condition STALE or UNAVAILABLE → MODEL_UNAVAILABLE
 *   - provider health DOWN/UNAVAILABLE → PROVIDER_UNAVAILABLE
 *
 * The provider/model gates are the shared canonical projection
 * `providerModelEligibility` (model-routable.ts) — planner and routing
 * eligibility can never disagree about usability.
 */
export interface PlannerEligibilityRejection {
  reject: true;
  failure_class: PlannerFailureClass;
  reason: string;
}
export function assertPlannerCandidateEligible(
  store: PairEvidenceStore,
  modelEntryId: string,
): PlannerEligibilityRejection | void {
  assertPlannerModelRole(store, modelEntryId);
  const mid = String(modelEntryId);
  const model = store.get("model_entry", mid);
  for (const asn of listModelRoleAssignments(store)) {
    if (asn.role !== MODEL_ROLE.DSH_EXECUTION) continue;
    const other = store.tryGet("model_entry", String(asn.model_entry_id));
    if (other && sameCanonicalModel(model, other)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLANNER_DSH_OVERLAP",
        JSON.stringify({ model_entry_id: mid, dsh_model_entry_id: String(asn.model_entry_id) }),
      );
    }
  }
  const elig = providerModelEligibility(
    store,
    String(model.provider_id ?? model.provider_family ?? ""),
    mid,
  );
  if (elig.eligible) return;
  const failed = Object.keys(elig.gates).filter((g) => elig.gates[g] === "FAIL");
  // Phase E §7 — receipt-validity failures are authority rejections (stale
  // material evidence), never failover-eligible. Probe-currentness failures
  // are availability (a retry/next-candidate may still succeed).
  const AUTHORITY_GATES = new Set([
    "PROVIDER_QUALIFIED",
    "PROVIDER_AUTH_OK",
    "PROVIDER_NOT_BLOCKED",
    "PROVIDER_RECEIPT_CURRENT",
    "MODEL_RECEIPT_CURRENT",
  ]);
  if (failed.some((g) => AUTHORITY_GATES.has(g))) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE",
      JSON.stringify({ model_entry_id: mid, failed_gates: failed }),
    );
  }
  return {
    reject: true,
    failure_class: failed.includes("PROVIDER_HEALTH_OK")
      ? PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE
      : PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE,
    reason: failed.join(","),
  };
}

/**
 * Two catalog entries are the same canonical model when they share a
 * model_entry_id, or when the same provider_family proves one entry lists the
 * other's model_id in model_alias_ids. Anything weaker is treated as
 * unproven — distinct — never collapsed without evidence.
 */
export function sameCanonicalModel(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (String(a.model_entry_id) === String(b.model_entry_id)) return true;
  if (String(a.provider_family ?? "") !== String(b.provider_family ?? "")) return false;
  const aAliases = (a.model_alias_ids ?? []) as string[];
  const bAliases = (b.model_alias_ids ?? []) as string[];
  return aAliases.includes(String(b.model_id)) || bAliases.includes(String(a.model_id));
}

export interface ModelPoolRef {
  model_entry_id: string;
  /** Operator-facing reference for diagnostics (e.g. "gemini:gemini-3.1-flash-lite"). */
  ref?: string;
}

export interface ConfiguredRouteResolution extends ModelPoolRef {
  pid: string;
  mid: string;
}

/**
 * Strict configured-route resolution (Phase A R2). Every configured role
 * route — planner, DSH primary/fallback/extra — must resolve to a canonical
 * catalog model_entry or the whole role topology is rejected BEFORE any
 * assignment mutation. Callers must NOT filter out unresolved configured
 * authority: shrinking a pool because a configured route did not resolve
 * bypasses default-deny and R1 §5F.
 *
 * Syntax: "provider:model" — provider is text before the FIRST colon, model
 * is the remainder (model ids may themselves contain colons). Empty route,
 * empty provider, or empty model all fail closed. Safe diagnostics only:
 * role, configured ref, provider id, model id — never credentials.
 */
export function resolveConfiguredModelRoleRoute(
  resolveEntry: (provider: string, model: string) => { model_entry_id?: unknown } | null | undefined,
  opts: { route: string; role: ModelRole },
): ConfiguredRouteResolution {
  const route = String(opts.route ?? "").trim();
  const sep = route.indexOf(":");
  const pid = sep < 0 ? "" : route.slice(0, sep).trim();
  const mid = sep < 0 ? "" : route.slice(sep + 1).trim();
  if (!route || !pid || !mid) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED",
      `role ${opts.role}: malformed configured route ${JSON.stringify({ ref: route, role: opts.role, provider: pid || null, model: mid || null })}`,
    );
  }
  const me = resolveEntry(pid, mid);
  if (!me || me.model_entry_id === undefined || me.model_entry_id === null) {
    throw new IntegrityError(
      "FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED",
      `role ${opts.role}: configured route did not resolve to a canonical model_entry ${JSON.stringify({ ref: route, role: opts.role, provider: pid, model: mid })}`,
    );
  }
  return { model_entry_id: String(me.model_entry_id), ref: route, pid, mid };
}

export interface RoleReconcileResult {
  created: string[];
  reassigned: string[];
  revoked: string[];
  noop: string[];
}

/**
 * Canonical role reconciliation (Phase A R1). One atomic seam that makes the
 * ACTIVE assignment set exactly equal the desired configured pools:
 *
 *   for each active row: desired role same → no-op; different → REASSIGNED;
 *                        absent → REVOKED (role=null, never deleted)
 *   for each desired ref without an active row → ASSIGNED
 *
 * Runs inside BEGIN IMMEDIATE — a crash or an invariant failure mid-way rolls
 * back the whole reconciliation rather than leaving a half-applied topology.
 * Every mutation emits its audited event (MODEL_ROLE_ASSIGNED /
 * MODEL_ROLE_REASSIGNED / MODEL_ROLE_REVOKED with reason ROLE_RECONCILE);
 * history is preserved, only active state converges.
 *
 * Desired refs must resolve to real catalog model_entry_ids — an unknown ref
 * fails closed (NotFound) BEFORE any mutation.
 */
export function reconcileModelRoleAssignments(
  store: PairEvidenceStore,
  opts: { planner: ModelPoolRef[]; dsh: ModelPoolRef[]; actor?: string },
): RoleReconcileResult {
  const actor = opts.actor ?? "PAIR_MODEL_ROLE_RECONCILE";
  return store.immediate(() => {
    // 1. desired-state validation — all refs must exist before any mutation.
    const desired = new Map<string, ModelRole>();
    for (const r of opts.planner) {
      if (!store.tryGet("model_entry", r.model_entry_id)) {
        throw new NotFoundError(`model_entry:${r.model_entry_id}`);
      }
      desired.set(r.model_entry_id, MODEL_ROLE.PLANNER_COORDINATOR);
    }
    for (const r of opts.dsh) {
      if (!store.tryGet("model_entry", r.model_entry_id)) {
        throw new NotFoundError(`model_entry:${r.model_entry_id}`);
      }
      desired.set(r.model_entry_id, MODEL_ROLE.DSH_EXECUTION);
    }
    // 2. desired pools must already be disjoint on canonical identity.
    assertNoModelRoleOverlap(store, opts);

    // 3. reconcile ACTIVE assignments against desired state.
    const res: RoleReconcileResult = { created: [], reassigned: [], revoked: [], noop: [] };
    const active = store
      .list("model_role_assignment")
      .filter((r) => typeof r.role === "string" && MODEL_ROLES.has(String(r.role)));
    const activeByModel = new Map(active.map((r) => [String(r.model_entry_id), r]));

    for (const row of active) {
      const mid = String(row.model_entry_id);
      const want = desired.get(mid);
      if (want === undefined) {
        revokeModelRole(store, mid, { actor });
        res.revoked.push(mid);
      } else if (want !== String(row.role)) {
        assignModelRole(store, mid, want, { actor });
        res.reassigned.push(mid);
      } else {
        res.noop.push(mid);
      }
    }
    for (const [mid, role] of desired) {
      if (!activeByModel.has(mid)) {
        assignModelRole(store, mid, role, { actor });
        res.created.push(mid);
      }
    }
    return res;
  });
}

/**
 * Final-state invariant (Phase A R1): over the ACTIVE stored assignments —
 * not the current env refs — every Planner assignment must be canonically
 * distinct from every DSH assignment. Reusable by startup and later Phase
 * B/C runtime audits. Safe diagnostics only.
 */
export function assertCanonicalModelRoleStateDisjoint(store: PairEvidenceStore): void {
  const active = store
    .list("model_role_assignment")
    .filter((r) => typeof r.role === "string" && MODEL_ROLES.has(String(r.role)));
  const planner = active
    .filter((r) => r.role === MODEL_ROLE.PLANNER_COORDINATOR)
    .map((r) => ({ model_entry_id: String(r.model_entry_id), ref: String(r.model_id ?? r.model_entry_id) }));
  const dsh = active
    .filter((r) => r.role === MODEL_ROLE.DSH_EXECUTION)
    .map((r) => ({ model_entry_id: String(r.model_entry_id), ref: String(r.model_id ?? r.model_entry_id) }));
  assertNoModelRoleOverlap(store, { planner, dsh });
}

/**
 * Startup invariant: no canonical model may sit in both pools. Safe
 * diagnostics only — model identity + provider + route refs, never secrets.
 */
export function assertNoModelRoleOverlap(
  store: PairEvidenceStore,
  opts: { planner: ModelPoolRef[]; dsh: ModelPoolRef[] },
): void {
  const catalog = new Map<string, Record<string, unknown>>();
  const entryOf = (mid: string) => {
    if (!catalog.has(mid)) catalog.set(mid, store.tryGet("model_entry", mid) ?? {});
    return catalog.get(mid)!;
  };
  for (const p of opts.planner) {
    const pa = entryOf(p.model_entry_id);
    for (const d of opts.dsh) {
      const da = entryOf(d.model_entry_id);
      const same =
        p.model_entry_id === d.model_entry_id ||
        (Object.keys(pa).length && Object.keys(da).length && sameCanonicalModel(pa, da));
      if (same) {
        throw new IntegrityError(
          "FAIL_CLOSED_MODEL_ROLE_OVERLAP",
          JSON.stringify({
            model_entry_id: p.model_entry_id,
            provider_id: pa.provider_id ?? null,
            provider_family: pa.provider_family ?? null,
            model_id: pa.model_id ?? null,
            planner_ref: p.ref ?? null,
            dsh_ref: d.ref ?? null,
            conflicting_model_entry_id: d.model_entry_id,
          }),
        );
      }
    }
  }
}
