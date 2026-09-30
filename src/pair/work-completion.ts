/**
 * P14 WORKFORCE V2 PHASE 3 — canonical completion authority.
 *
 * The central invariant: NO work item is canonically complete merely
 * because a mutable status field says DONE. Completion authority derives
 * from a single canonical record:
 *
 *   `work_completion`  (WCP_<work_item_id>)
 *
 * written ONLY inside the same store.immediate() transaction that
 * projects the work item to DONE. The row pins the full completion
 * basis — the bound COMPLETED mission (mission_id + bound_open_id), the
 * canonical child set (sorted ids + digest), the accepting reviewer —
 * under one `completion_digest`, immutably anchored by exactly one
 * append-only `WORK_ITEM_COMPLETED` journal event keyed on the WCP id.
 *
 *   Leaf:     bound mission COMPLETED → DONE + WCP(mission pin)
 *   Review:   basis ready → REVIEW_REQUIRED → ACCEPT → DONE + WCP(+reviewer)
 *   Parent:   every canonical child (WDEC ∪ WDEL) proven complete
 *             (+ the parent's own bound mission when it executed)
 *             → DONE + WCP(child-set pin)
 *
 * A deleted WCP, a tampered digest, a forged ACCEPT/anchor event, a
 * foreign or missing child — all fail closed via
 * `assertCanonicalWorkCompletion`. Status alone proves nothing.
 *
 * Completion ≠ coordination: claim leases, heartbeats and workforce
 * messages carry ZERO completion authority (Phase 2 boundary preserved).
 */

import { digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { GraphAuthorityDeps } from "./graph-authority.js";
import type { PairEvidenceStore } from "./store.js";
import {
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  decompositionRowId,
} from "./graph-authority.js";
import { validateWorkOpenBinding } from "./work-open-binding.js";

type Row = Record<string, unknown> & { version: number };

export const WORK_COMPLETION_TABLE = "work_completion";
export const WORK_COMPLETED_EVENT = "WORK_ITEM_COMPLETED";
export const WORK_REVIEW_ACCEPTED_EVENT = "WORK_REVIEW_ACCEPTED";

/** Recursion bound for nested completion proofs — the graph is acyclic,
 *  so a deeper chain than this can only be corrupt provenance. */
const COMPLETION_DEPTH_CAP = 64;

export function completionRowId(workItemId: string): string {
  return `WCP_${workItemId}`;
}

/** Digest over every pinned field of a work_completion row. */
export function completionDigest(f: {
  completion_id: string;
  work_item_id: string;
  business_id: string;
  mission_id: string | null;
  bound_open_id: string | null;
  child_work_item_ids: string[];
  reviewer_agent_id: string | null;
}): string {
  return digest({
    completion_id: f.completion_id,
    work_item_id: f.work_item_id,
    business_id: f.business_id,
    mission_id: f.mission_id,
    bound_open_id: f.bound_open_id,
    child_work_item_ids: f.child_work_item_ids,
    reviewer_agent_id: f.reviewer_agent_id,
  });
}

export function childSetDigest(childIds: string[]): string {
  return digest({ work_completion_children: [...childIds].sort() });
}

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", detail);
}

/**
 * The canonical child set of a parent — derived ONLY from committed
 * `work_decomposition` / `work_delegation` rows, never from mutable
 * parent arrays or mirror fields. Every canonical row is fully
 * validated; a corrupt one throws (the caller quarantines).
 */
export function canonicalChildIdsOf(
  deps: GraphAuthorityDeps, parentId: string,
): string[] {
  const ids = new Set<string>();
  const dec = deps.store.tryGet(
    "work_decomposition", decompositionRowId(parentId)) as Row | null;
  if (dec && String(dec.state) === "COMMITTED") {
    assertCanonicalDecomposition(deps, dec);
    for (const cid of (dec.child_work_item_ids as string[] | undefined) ?? []) {
      ids.add(String(cid));
    }
  }
  for (const d of deps.store.list("work_delegation")) {
    if (String(d.parent_work_item_id) !== parentId) continue;
    if (String(d.state) !== "COMMITTED") continue;
    assertCanonicalDelegation(deps, d as Row);
    ids.add(String(d.child_work_item_id));
  }
  return [...ids].sort();
}

/** Canonical parents of a child — via WDEL_<child> and any COMMITTED
 *  WDEC listing it. Returns [] for standalone/leaf items. */
export function canonicalParentIdsOf(
  deps: GraphAuthorityDeps, childId: string,
): string[] {
  const ids = new Set<string>();
  const del = deps.store.tryGet("work_delegation", `WDEL_${childId}`) as Row | null;
  if (del && String(del.state) === "COMMITTED") {
    assertCanonicalDelegation(deps, del);
    ids.add(String(del.parent_work_item_id));
  }
  for (const dec of deps.store.list("work_decomposition")) {
    if (String(dec.state) !== "COMMITTED") continue;
    if (((dec.child_work_item_ids as string[] | undefined) ?? []).includes(childId)) {
      assertCanonicalDecomposition(deps, dec as Row);
      ids.add(String(dec.parent_work_item_id));
    }
  }
  return [...ids].sort();
}

/** Bound-mission completion proof for one pinned (item, mission,
 *  open_id) triple — replicates the canonical binding chain:
 *  mission_ids membership, mission.bound_open_id origin proof, BOUND
 *  binding, full validateWorkOpenBinding PROVENANCE chain. */
function proveBoundMissionCompleted(
  deps: GraphAuthorityDeps,
  item: Row, missionId: string, boundOpenId: string,
): boolean {
  const mids = (item.mission_ids as string[] | undefined) ?? [];
  if (mids[mids.length - 1] !== missionId) return false;
  const m = deps.store.tryGet("mission", missionId) as Row | null;
  if (!m || String(m.status) !== "COMPLETED") return false;
  if (String(m.bound_open_id ?? "") !== boundOpenId) return false;
  const binding = deps.store.tryGet("work_open_binding", boundOpenId) as Row | null;
  if (!binding) return false;
  return validateWorkOpenBinding(deps.store, binding, {
    forWorkItem: item,
    forMission: m,
    requireState: "BOUND",
    mode: "PROVENANCE",
  }).ok;
}

/**
 * The single canonical completion validator — consumed identically by
 * the dependency gate, parent aggregation, read seams and reconcile.
 * Throws FAIL_CLOSED_WORK_PROVENANCE_CORRUPT.
 */
export function assertCanonicalWorkCompletion(
  deps: GraphAuthorityDeps, wcp: Row, depth = 0,
): void {
  if (depth > COMPLETION_DEPTH_CAP) {
    fail(`work_completion ${String(wcp.completion_id)}: depth cap`);
  }
  const cid = String(wcp.completion_id ?? wcp.entity_id ?? "");
  const wid = String(wcp.work_item_id ?? "");
  if (!wid || cid !== completionRowId(wid)) {
    fail(`work_completion ${cid}: non-deterministic id`);
  }
  if (String(wcp.state) !== "COMMITTED") {
    fail(`work_completion ${cid}: state ${String(wcp.state)}`);
  }
  let item: Row;
  try {
    item = deps.store.get("work_item", wid) as Row;
  } catch {
    return fail(`work_completion ${cid}: work item ${wid} missing`);
  }
  if (String(item.status) !== "DONE") {
    fail(`work_completion ${cid}: item ${wid} status ${String(item.status)}`);
  }
  if (String(item.blocked_code ?? "") !== "" && item.blocked_code != null) {
    fail(`work_completion ${cid}: item ${wid} corrupt-marked`);
  }
  if (String(wcp.business_id) !== String(item.business_id)) {
    fail(`work_completion ${cid}: business mismatch`);
  }
  const biz = deps.getBusiness(String(item.business_id));
  if (String(wcp.project_id) !== String(biz.project_id)) {
    fail(`work_completion ${cid}: project mismatch`);
  }
  const missionId = wcp.mission_id ? String(wcp.mission_id) : null;
  const boundOpenId = wcp.bound_open_id ? String(wcp.bound_open_id) : null;
  const childIds = ((wcp.child_work_item_ids as string[] | undefined) ?? [])
    .map(String).sort();
  const reviewer = wcp.reviewer_agent_id ? String(wcp.reviewer_agent_id) : null;
  // Self-consistent digest is necessary but never sufficient — the
  // anchor event below is the immutable evidence.
  if (String(wcp.completion_digest) !== completionDigest({
    completion_id: cid, work_item_id: wid,
    business_id: String(wcp.business_id), mission_id: missionId,
    bound_open_id: boundOpenId, child_work_item_ids: childIds,
    reviewer_agent_id: reviewer,
  })) {
    fail(`work_completion ${cid}: digest mismatch`);
  }
  if (String(wcp.child_set_digest) !== childSetDigest(childIds)) {
    fail(`work_completion ${cid}: child-set digest mismatch`);
  }
  // Exactly one immutable anchor event pinned to this completion —
  // a forged/replayed/duplicated anchor fails closed.
  const anchors = deps.store.listEvents(WORK_COMPLETION_TABLE, cid)
    .filter((e) => String(e.event_type) === WORK_COMPLETED_EVENT);
  if (anchors.length !== 1) {
    fail(`work_completion ${cid}: ${anchors.length} anchor events`);
  }
  const amd = (anchors[0]!.metadata as Record<string, unknown> | undefined) ?? {};
  if (String(amd.work_item_id ?? "") !== wid ||
      String(amd.completion_digest ?? "") !== String(wcp.completion_digest) ||
      String(amd.mission_id ?? "") !== String(missionId ?? "") ||
      String(amd.bound_open_id ?? "") !== String(boundOpenId ?? "") ||
      String(amd.child_set_digest ?? "") !== String(wcp.child_set_digest) ||
      String(amd.reviewer_agent_id ?? "") !== String(reviewer ?? "")) {
    fail(`work_completion ${cid}: anchor metadata mismatch`);
  }
  // Mission pin: when present it must be the item's CURRENT canonical
  // bound attempt — a superseded/forged mission reference fails.
  if (missionId) {
    if (!boundOpenId) fail(`work_completion ${cid}: mission without open_id`);
    if (!proveBoundMissionCompleted(deps, item, missionId, boundOpenId)) {
      fail(`work_completion ${cid}: mission ${missionId} not canonically bound+completed`);
    }
  } else if (boundOpenId) {
    fail(`work_completion ${cid}: open_id without mission`);
  }
  // Child-set pin: every pinned child must itself be canonically
  // complete, and the pinned set must still equal the live canonical
  // child set — a missing or foreign child fails closed.
  if (childIds.length) {
    const live = canonicalChildIdsOf(deps, wid);
    if (live.length !== childIds.length ||
        live.some((c, i) => c !== childIds[i])) {
      fail(`work_completion ${cid}: pinned child set != live canonical set`);
    }
    for (const childId of childIds) {
      const child = deps.store.tryGet("work_item", childId) as Row | null;
      if (!child) fail(`work_completion ${cid}: child ${childId} missing`);
      const childWcp = deps.store.tryGet(
        WORK_COMPLETION_TABLE, completionRowId(childId)) as Row | null;
      if (!childWcp) fail(`work_completion ${cid}: child ${childId} has no WCP`);
      assertCanonicalWorkCompletion(deps, childWcp, depth + 1);
    }
  }
  // Review pin: a review-required item needs exactly one canonical
  // ACCEPT event pinning THIS completion's digest — a forged decision,
  // a decision for a different mission/basis, or a duplicate all fail.
  if (item.requires_review === true) {
    if (!reviewer) fail(`work_completion ${cid}: review item without reviewer`);
    const accepts = deps.store.listEvents("work_item", wid).filter((e) =>
      String(e.event_type) === WORK_REVIEW_ACCEPTED_EVENT &&
      String(e.old_state ?? "") === "REVIEW_REQUIRED" &&
      String(e.new_state ?? "") === "DONE");
    const matching = accepts.filter((e) => {
      const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
      return String(md.reviewer_agent_id ?? "") === reviewer &&
        String(md.completion_digest ?? "") === String(wcp.completion_digest) &&
        String(md.mission_id ?? "") === String(missionId ?? "") &&
        String(md.bound_open_id ?? "") === String(boundOpenId ?? "") &&
        String(md.child_set_digest ?? "") === String(wcp.child_set_digest);
    });
    if (matching.length !== 1) {
      fail(`work_completion ${cid}: ${matching.length} matching ACCEPT events`);
    }
    const rev = deps.store.tryGet("org_agent", reviewer) as Row | null;
    if (!rev || String(rev.business_id) !== String(item.business_id)) {
      fail(`work_completion ${cid}: reviewer ${reviewer} not in business`);
    }
    if (reviewer === String(item.assignee_agent_id ?? "")) {
      fail(`work_completion ${cid}: reviewer is assignee`);
    }
    if (item.reviewer_agent_id &&
        String(item.reviewer_agent_id) !== reviewer) {
      fail(`work_completion ${cid}: reviewer != named reviewer`);
    }
  } else if (reviewer) {
    fail(`work_completion ${cid}: reviewer on non-review item`);
  }
}

/**
 * Is `item` canonically complete? Requires status DONE plus a fully
 * validated `work_completion` record — status text alone, forged
 * bodies, missing receipts of evidence: none of it counts.
 */
export function proveWorkItemComplete(
  deps: GraphAuthorityDeps, item: Row, depth = 0,
): boolean {
  if (String(item.status) !== "DONE") return false;
  if (String(item.blocked_code ?? "") !== "" && item.blocked_code != null) {
    return false;
  }
  const wcp = deps.store.tryGet(
    WORK_COMPLETION_TABLE, completionRowId(String(item.work_item_id))) as Row | null;
  if (!wcp) return false;
  try {
    assertCanonicalWorkCompletion(deps, wcp, depth);
    return true;
  } catch {
    return false;
  }
}
