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
