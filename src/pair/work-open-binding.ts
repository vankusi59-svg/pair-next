/**
 * Canonical `work_open_binding` validation — the ONE validator every
 * provenance-bearing seam must use (Foundation V2 R1 §5):
 *
 *   - BusinessLayer.openWorkItem / reconcileOpenIntent / rollback
 *   - MissionControl.startBoundMission (internal bound-mission seam)
 *   - missionBoundToWorkItem / boundMissionForWorkItem
 *   - review grounding, sync/control actions
 *
 * It validates the FULL canonical chain — open_id, lifecycle state,
 * reserved mission_id, work_item, business, business.project_id,
 * binding.project_id, mission.project_id, org_agent/assignee scope, and
 * the internal mission-origin proof (`mission.bound_open_id`). No weaker
 * per-seam variants may exist.
 */

import type { PairEvidenceStore } from "./store.js";

export type StoreRow = Record<string, unknown> & { version: number };

export interface OpenBindingCheck {
  ok: boolean;
  reason?: string;
}

const ok = (): OpenBindingCheck => ({ ok: true });
const fail = (reason: string): OpenBindingCheck => ({ ok: false, reason });

/**
 * Validate a `work_open_binding` against the canonical chain.
 *
 *   `forWorkItem`  — assert binding.work_item_id resolves to exactly this
 *                    row, business matches, and assignee/org-agent agrees.
 *   `forMission`   — assert the mission is THIS binding's reserved id,
 *                    shares the binding's project, and carries the
 *                    internal origin proof `bound_open_id === open_id`
 *                    (a generic /api/missions caller can never set that
 *                    top-level field).
 *   `expectedProjectId` — assert binding.project_id equals it.
 *   `requireState` — assert binding.state equals INTENT or BOUND.
 */
const BINDING_STATES = new Set(["INTENT", "BOUND", "ROLLED_BACK"]);

export function validateWorkOpenBinding(
  store: PairEvidenceStore,
  binding: StoreRow,
  opts: {
    forWorkItem?: StoreRow;
    forMission?: StoreRow;
    expectedProjectId?: string;
    requireState?: "INTENT" | "BOUND";
  } = {},
): OpenBindingCheck {
  // Canonical identity must be well-formed (R2 §4): non-empty open_id,
  // non-empty reserved mission_id, a known lifecycle state — an unknown
  // state must never be reconciled into BOUND.
  const openId = String(binding.open_id ?? "");
  if (!openId) return fail("binding missing open_id");
  if (!String(binding.mission_id ?? "")) return fail("binding missing mission_id");
  if (!BINDING_STATES.has(String(binding.state))) {
    return fail(`binding has unknown lifecycle state ${String(binding.state)}`);
  }
  if (opts.requireState && String(binding.state) !== opts.requireState) {
    return fail(`binding state ${String(binding.state)} != ${opts.requireState}`);
  }
  const workItemId = String(binding.work_item_id ?? "");
  const row = opts.forWorkItem ?? (store.tryGet("work_item", workItemId) as StoreRow | null);
  if (!row || String(row.work_item_id) !== workItemId) {
    return fail("binding work_item does not resolve");
  }
  if (String(row.business_id) !== String(binding.business_id)) {
    return fail("work item business != binding business_id");
  }
  const business = store.tryGet("business", String(binding.business_id)) as StoreRow | null;
  if (!business) return fail("canonical business does not resolve");
  if (String(business.project_id) !== String(binding.project_id)) {
    return fail("business project != binding project_id");
  }
  if (opts.expectedProjectId && String(binding.project_id) !== opts.expectedProjectId) {
    return fail("binding project != requested project");
  }
  // Assignee/org-agent linkage (R2 §4): the relationship is enforced in
  // BOTH directions — an assigned work item requires a binding agent
  // equal to its assignee; an unassigned item forbids a binding that
  // silently claims an agent.
  const boundAgent = binding.org_agent_id ? String(binding.org_agent_id) : null;
  const rowAgent = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
  if (boundAgent !== rowAgent) {
    return fail("work item assignee != binding org_agent_id");
  }
  if (boundAgent) {
    const agent = store.tryGet("org_agent", boundAgent) as StoreRow | null;
    if (!agent) return fail("binding org_agent does not resolve");
    if (String(agent.business_id) !== String(binding.business_id)) {
      return fail("org_agent outside binding business");
    }
    if (String(agent.status) !== "ACTIVE") return fail("org_agent not ACTIVE");
  }
  if (opts.forMission) {
    const m = opts.forMission;
    if (String(m.mission_id) !== String(binding.mission_id)) {
      return fail("mission is not the binding's reserved mission_id");
    }
    if (String(m.project_id) !== String(binding.project_id)) {
      return fail("mission project != binding project");
    }
    // Internal origin proof — the single authority that this mission was
    // created BY this binding. Written only by the bound-mission seam as
    // a top-level field; caller metadata can never forge it.
    if (String(m.bound_open_id ?? "") !== openId) {
      return fail("mission lacks canonical origin proof for this binding");
    }
  }
  return ok();
}

/** Load a binding by open_id and run the canonical validator. */
export function validateWorkOpenBindingById(
  store: PairEvidenceStore,
  openId: string,
  opts: Parameters<typeof validateWorkOpenBinding>[2] = {},
): { binding: StoreRow | null } & OpenBindingCheck {
  const binding = store.tryGet("work_open_binding", openId) as StoreRow | null;
  if (!binding) return { binding: null, ...fail(`binding ${openId} does not exist`) };
  // Payload identity must equal the entity key — a row stored under one
  // open_id claiming another is malformed canonical identity (R2 §4).
  if (String(binding.open_id ?? "") !== openId) {
    return { binding, ...fail(`binding open_id ${String(binding.open_id)} != key ${openId}`) };
  }
  const res = validateWorkOpenBinding(store, binding, opts);
  return { binding, ...res };
}
