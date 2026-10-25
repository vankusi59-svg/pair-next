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

import { digest, planManifestDigest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { GraphAuthorityDeps } from "./graph-authority.js";
import type { PairEvidenceStore } from "./store.js";
import { MISSION_STATUS_TRANSITIONS } from "./service.js";
import { RUNTIME_TRANSITIONS, TERMINAL_EXECUTION } from "./mission-runtime.js";
import type { MissionRuntimeState } from "./mission-runtime.js";
import {
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  decompositionRowId,
} from "./graph-authority.js";
import { validateWorkOpenBinding, validateWorkOpenBindingById } from "./work-open-binding.js";

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

/** Identity of a completion basis — the authority a review decision was
 *  made against (bound attempt + canonical child set). A REWORK pins
 *  exactly this digest as rejected; only a DIFFERENT basis (a new bound
 *  open/binding/mission attempt, or an advanced canonical child set)
 *  can ever ground a later REVIEW_REQUIRED. */
export function completionBasisDigest(f: {
  mission_id: string | null;
  bound_open_id: string | null;
  child_basis_digest: string;
}): string {
  return digest({
    work_completion_basis: 1,
    mission_id: f.mission_id,
    bound_open_id: f.bound_open_id,
    child_basis_digest: f.child_basis_digest,
  });
}

/** Child-set completion-authority digest: binds each canonical child id
 *  to the digest of ITS current completion record (WCP). Same children
 *  with the same WCPs → same digest (a rejected parent basis stays
 *  rejected); a child that re-completes under a NEW bound attempt mints
 *  a new WCP → the parent basis advances past the rejection. */
export function childBasisDigest(
  store: PairEvidenceStore, childIds: string[],
): string {
  const items = [...childIds].sort().map((cid) => {
    const wcp = store.tryGet(WORK_COMPLETION_TABLE, completionRowId(cid));
    return `${cid}:${wcp ? String(wcp.completion_digest) : "none"}`;
  });
  return digest({ work_child_completion_set: 1, items });
}

export const WORK_REWORK_EVENT = "WORK_REWORK_REQUESTED";

/** The set of completion-basis identities REWORK has already rejected
 *  for this item — derived ONLY from the immutable REWORK evidence log.
 *  Each canonical rework event pins the rejected basis fields
 *  (mission_id / bound_open_id / rejected_child_basis_digest) plus
 *  rejected_basis_digest; an event whose fields do not recompute to its
 *  pinned digest — or whose child-id set does not match its pinned
 *  child_set_digest — is corrupt provenance and throws. */
export function rejectedCompletionBases(
  store: PairEvidenceStore, workItemId: string,
): Set<string> {
  const out = new Set<string>();
  for (const e of store.listEvents("work_item", workItemId)) {
    if (String(e.event_type) !== WORK_REWORK_EVENT ||
        String(e.old_state ?? "") !== "REVIEW_REQUIRED" ||
        String(e.new_state ?? "") !== "READY") continue;
    const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
    const rawIds = md.child_work_item_ids;
    if (!Array.isArray(rawIds)) {
      fail(`rework event for ${workItemId}: missing child-id pin`);
    }
    const childIds = rawIds.map(String);
    const sortedIds = [...childIds].sort();
    if (childIds.some((v, i) => v !== sortedIds[i])) {
      fail(`rework event for ${workItemId}: non-canonical child-id shape`);
    }
    if (String(md.child_set_digest ?? "") !== childSetDigest(childIds)) {
      fail(`rework event for ${workItemId}: child-set pin mismatch`);
    }
    const basis = {
      mission_id: md.mission_id ? String(md.mission_id) : null,
      bound_open_id: md.bound_open_id ? String(md.bound_open_id) : null,
      child_basis_digest: String(md.rejected_child_basis_digest ?? ""),
    };
    if (!basis.child_basis_digest) {
      fail(`rework event for ${workItemId}: missing child-basis pin`);
    }
    const d = completionBasisDigest(basis);
    if (String(md.rejected_basis_digest ?? "") !== d) {
      fail(`rework event for ${workItemId}: basis pin mismatch`);
    }
    out.add(d);
  }
  return out;
}

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", detail);
}

/* Legal predecessors for a transition into COMPLETED — taken from the
 * canonical state machines (service / mission-runtime), not redefined
 * here. Any COMPLETED transition event claiming another predecessor is
 * forged evidence. */
const MISSION_COMPLETION_PREDS = new Set(
  Object.entries(MISSION_STATUS_TRANSITIONS)
    .filter(([, tos]) => tos.includes("COMPLETED"))
    .map(([from]) => from),
);
const RUNTIME_COMPLETION_PREDS = new Set<string>(
  (Object.keys(RUNTIME_TRANSITIONS) as Array<keyof typeof RUNTIME_TRANSITIONS>)
    .filter((from) => RUNTIME_TRANSITIONS[from].includes("COMPLETED")),
);

/**
 * The ONE canonical mission-success proof consumed by every Phase-3
 * completion seam. A mutable `mission.status === "COMPLETED"` alone
 * proves NOTHING — the proof requires the full governed-runtime
 * evidence chain:
 *
 *   1. mission row status COMPLETED;
 *   2. exactly one immutable MISSION_TRANSITION event into COMPLETED
 *      from a legal predecessor state;
 *   3. the canonical mission_runtime row MRT_<mid> in state COMPLETED
 *      (no mission/runtime contradiction);
 *   4. exactly one immutable MISSION_RUNTIME_TRANSITION into COMPLETED
 *      from a legal predecessor, pinning mission_id and the governed
 *      finalization reason "all_tasks_completed";
 *   5. a committed current plan revision whose tasks ALL reached
 *      COMPLETED — each with an immutable TASK_COMPLETED event that
 *      correlates to a COMPLETED executor_execution carrying a
 *      COMPLETED result (the existing execution/result-validation
 *      authority). The governed runtime only completes a mission when
 *      every current-plan task is terminal-success — the validator
 *      enforces exactly that.
 *
 * A direct `mission.status` mutation emits no transition events, no
 * runtime row, no task evidence — it fails closed.
 */
export function assertCanonicalMissionCompletion(
  store: PairEvidenceStore, mission: Row,
): void {
  const mid = String(mission.mission_id ?? "");
  if (!mid) fail("mission: missing mission_id");
  if (String(mission.status) !== "COMPLETED") {
    fail(`mission ${mid}: status ${String(mission.status)}`);
  }
  // (2) mission-level transition evidence.
  const missionTransitions = store.listEvents("mission", mid).filter((e) =>
    String(e.event_type ?? "") === "MISSION_TRANSITION" &&
    String(e.new_state ?? "") === "COMPLETED");
  if (missionTransitions.length !== 1) {
    fail(`mission ${mid}: ${missionTransitions.length} COMPLETED transition events`);
  }
  if (!MISSION_COMPLETION_PREDS.has(String(missionTransitions[0]!.old_state ?? ""))) {
    fail(`mission ${mid}: COMPLETED from ${String(missionTransitions[0]!.old_state)}`);
  }
  // (3) canonical runtime row — no mission/runtime contradiction.
  const rtId = `MRT_${mid}`;
  const rt = store.tryGet("mission_runtime", rtId) as Row | null;
  if (!rt) fail(`mission ${mid}: mission_runtime row missing`);
  if (String(rt.state) !== "COMPLETED") {
    fail(`mission ${mid}: runtime state ${String(rt.state)}`);
  }
  // (4) runtime transition/finalization evidence.
  const rtTransitions = store.listEvents("mission_runtime", rtId).filter((e) =>
    String(e.event_type ?? "") === "MISSION_RUNTIME_TRANSITION" &&
    String(e.new_state ?? "") === "COMPLETED");
  if (rtTransitions.length !== 1) {
    fail(`mission ${mid}: ${rtTransitions.length} runtime COMPLETED events`);
  }
  const rtEv = rtTransitions[0]!;
  const rtMd = (rtEv.metadata as Record<string, unknown> | undefined) ?? {};
  if (!RUNTIME_COMPLETION_PREDS.has(String(rtEv.old_state ?? ""))) {
    fail(`mission ${mid}: runtime COMPLETED from ${String(rtEv.old_state)}`);
  }
  if (String(rtMd.mission_id ?? "") !== mid) {
    fail(`mission ${mid}: runtime event mission mismatch`);
  }
  if (String(rtMd.reason ?? "") !== "all_tasks_completed") {
    fail(`mission ${mid}: runtime completion reason ${String(rtMd.reason)}`);
  }
  // (5) every current-plan task terminal-success under the governed
  //    execution/result-validation authority (R2). The real runtime
  //    only completes a task after
  //    GovernedTaskGate.validate_execution_result →
  //    ArtifactProvenanceValidator writes a PASS execution_validation
  //    anchored by an immutable RESULT_VALIDATED event. For EACH task
  //    in the exact current canonical plan revision the proof binds:
  //      executor_execution → (mission, task, plan revision,
  //      correlation, COMPLETED execution + COMPLETED result)
  //      governed_task      → (mission, task, plan id+revision,
  //      executor, correlation, DISPATCH_AUTHORIZED)
  //      dispatch identity  → executor_dispatch_intent INTENT_<gt>
  //      EXECUTION_PERSISTED naming this execution + an
  //      EXECUTION_DISPATCHED event pinning the governed task + a
  //      GOVERNED_TASK_VALIDATED event pinning mission/task/executor;
  //      validation         → a PASS execution_validation bound to
  //      THIS execution + governed task + mission, anchored by a
  //      RESULT_VALIDATED event pinning that exact validation_id and
  //      the execution's correlation_id;
  //      TASK_COMPLETED     → an immutable event whose correlation_id
  //      is that validated execution's.
  //    A handcrafted executor_execution — or a FAIL/missing validation
  //    — can never establish mission success.
  //
  //  R3: the task authority is the canonical PLAN MANIFEST, never a
  //  task-table scan. The active plan revision resolves through the
  //  hash-verified mission_plan_revisions log, the exact `plan` entity
  //  (which must exist, claim this mission, and be PLANNED), the
  //  mission's own plan_id/plan_revision pins, and the immutable
  //  MISSION_PLAN_COMMITTED anchor event. `plan.task_ids` is the
  //  complete declared task set — the LIVE task set claiming this
  //  mission+plan must equal it exactly: a missing declared task is
  //  omission-corruption, a declared task whose mission_id/plan_id
  //  drifted is drift-corruption, and an extra task claiming the pair
  //  is injection — all fail closed.
  const revisions = store.planRevisions(mid);
  if (!revisions.length) fail(`mission ${mid}: no plan revisions`);
  // Revision-history omission safety: the hash-verified history must be
  // monotonic/contiguous (commitPlan semantics: revision = position) and
  // in exact bijection with the immutable MISSION_PLAN_COMMITTED anchors
  // — a deleted revision row cannot silently roll history backward
  // because the later commit event still exists, and a forged history
  // entry has no commit anchor.
  const commitEvents = store.listEvents("mission", mid).filter((e) =>
    String(e.event_type ?? "") === "MISSION_PLAN_COMMITTED");
  const pairsOf = (rs: Array<Record<string, unknown>>) =>
    rs.map((r) =>
      `${String(r.plan_id ?? "")}@${Number(r.revision ?? NaN)}`);
  const evPairs = commitEvents.map((e) =>
    `${String(e.new_state ?? "")}@${Number(
      (e.metadata as Record<string, unknown> | undefined)?.revision ?? NaN)}`);
  const histPairs = pairsOf(revisions);
  if (evPairs.length !== histPairs.length ||
      evPairs.some((p, i) => p !== histPairs[i])) {
    fail(`mission ${mid}: commit anchors != revision history`);
  }
  for (const [i, r] of revisions.entries()) {
    if (Number(r.revision ?? NaN) !== i + 1) {
      fail(`mission ${mid}: non-contiguous plan revision ${String(r.revision)}`);
    }
    if (String(r.mission_id ?? "") !== mid) {
      fail(`mission ${mid}: revision ${String(r.revision)} mission mismatch`);
    }
    // Every commit anchor must carry a self-consistent immutable
    // manifest pin — recompute it, never trust the entity payload.
    const eMd = (commitEvents[i]!.metadata ?? {}) as Record<string, unknown>;
    const pinnedIds = eMd.task_ids;
    if (!Array.isArray(pinnedIds) || pinnedIds.length === 0 ||
        pinnedIds.some((v) => typeof v !== "string")) {
      fail(`mission ${mid}: commit anchor ${String(r.revision)} missing task pin`);
    }
    const expected = planManifestDigest({
      mission_id: mid,
      plan_id: String(r.plan_id ?? ""),
      revision: Number(r.revision),
      task_ids: pinnedIds.map(String),
    });
    if (String(eMd.plan_manifest_digest ?? "") !== expected) {
      fail(`mission ${mid}: commit anchor ${String(r.revision)} manifest digest mismatch`);
    }
  }
  const active = revisions[revisions.length - 1]!;
  const planId = String(active.plan_id ?? "");
  const planRevision = Number(active.revision ?? 0);
  if (String(mission.plan_id ?? "") !== planId ||
      Number(mission.plan_revision ?? NaN) !== planRevision) {
    fail(`mission ${mid}: plan pin ${String(mission.plan_id)}/${String(mission.plan_revision)} != active ${planId}/${planRevision}`);
  }
  const plan = store.tryGet("plan", planId) as Row | null;
  if (!plan) fail(`mission ${mid}: active plan row ${planId} missing`);
  if (String(plan.plan_id ?? "") !== planId ||
      String(plan.mission_id ?? "") !== mid ||
      String(plan.state ?? "") !== "PLANNED") {
    fail(`mission ${mid}: plan ${planId} provenance mismatch`);
  }
  // The live plan manifest must equal the task set pinned immutably at
  // commit time — shrink/reorder/expand after commit all fail closed.
  const activeMd =
    (commitEvents[commitEvents.length - 1]!.metadata ?? {}) as
      Record<string, unknown>;
  const committedIds = (activeMd.task_ids as string[]).map(String);
  const declared = plan.task_ids;
  if (!Array.isArray(declared) || declared.length === 0) {
    fail(`mission ${mid}: plan ${planId} has no task manifest`);
  }
  const declaredIds = declared.map(String);
  if (declaredIds.length !== committedIds.length ||
      declaredIds.some((v, i) => v !== committedIds[i])) {
    fail(`mission ${mid}: plan ${planId} manifest diverged from commit anchor`);
  }
  const declaredSet = new Set(declaredIds);
  if (declaredSet.size !== declaredIds.length) {
    fail(`mission ${mid}: plan ${planId} manifest has duplicate ids`);
  }
  const live = new Set(
    store.list("task")
      .filter((t) =>
        String(t.mission_id ?? "") === mid &&
        String(t.plan_id ?? "") === planId)
      .map((t) => String(t.task_id ?? "")),
  );
  for (const tid of declaredIds) {
    if (!live.has(tid)) fail(`mission ${mid}: declared task ${tid} missing`);
  }
  for (const tid of live) {
    if (!declaredSet.has(tid)) {
      fail(`mission ${mid}: undeclared task ${tid} claims active plan`);
    }
  }
  const executions = store.list("executor_execution");
  const validations = store.list("execution_validation");
  for (const [index, tid] of declaredIds.entries()) {
    const t = store.tryGet("task", tid) as Row | null;
    if (!t) fail(`mission ${mid}: declared task ${tid} missing`);
    if (String(t.task_id ?? "") !== tid ||
        String(t.mission_id ?? "") !== mid ||
        String(t.plan_id ?? "") !== planId) {
      fail(`mission ${mid}: declared task ${tid} drifted from plan`);
    }
    if (Number(t.order ?? NaN) !== index) {
      fail(`mission ${mid}: declared task ${tid} order ${String(t.order)}`);
    }
    if (String(t.status ?? "") !== "COMPLETED") {
      fail(`mission ${mid}: task ${tid} status ${String(t.status)}`);
    }
    const taskEvidence = store.listEvents("task", tid).filter((e) =>
      String(e.event_type ?? "") === "TASK_COMPLETED" &&
      String(e.new_state ?? "") === "COMPLETED");
    const proven = executions.some((x) => {
      if (String(x.mission_id ?? "") !== mid ||
          String(x.task_id ?? "") !== tid ||
          Number(x.plan_revision ?? NaN) !== planRevision ||
          String(x.execution_state ?? "") !== "COMPLETED" ||
          String((x.result as Record<string, unknown> | undefined)?.status ?? "") !==
            "COMPLETED") return false;
      const corr = String(x.correlation_id ?? "");
      if (!corr ||
          !taskEvidence.some((e) => String(e.correlation_id ?? "") === corr)) {
        return false;
      }
      const gtId = String(x.governed_task_id ?? "");
      const g = store.tryGet("governed_task", gtId) as Row | null;
      if (!g) return false;
      if (String(g.mission_id ?? "") !== mid ||
          String(g.task_id ?? "") !== tid ||
          String(g.plan_id ?? "") !== planId ||
          Number(g.plan_revision ?? NaN) !== planRevision ||
          String(g.executor_id ?? "") !== String(x.executor_id ?? "") ||
          String(g.correlation_id ?? "") !== corr ||
          String(g.governance_state ?? "") !== "DISPATCH_AUTHORIZED") {
        return false;
      }
      // Governed dispatch identity — the persisted intent names THIS
      // execution for THIS governed task.
      const intent = store.tryGet(
        "executor_dispatch_intent", `INTENT_${gtId}`) as Row | null;
      if (!intent ||
          String(intent.governed_task_id ?? "") !== gtId ||
          String(intent.executor_id ?? "") !== String(x.executor_id ?? "") ||
          String(intent.execution_id ?? "") !== String(x.execution_id ?? "") ||
          String(intent.state ?? "") !== "EXECUTION_PERSISTED") return false;
      const execEvents = store.listEvents(
        "executor_execution", String(x.execution_id));
      if (!execEvents.some((e) =>
          String(e.event_type ?? "") === "EXECUTION_DISPATCHED" &&
          String(e.correlation_id ?? "") === corr &&
          String((e.metadata as Record<string, unknown> | undefined)
            ?.governed_task_id ?? "") === gtId)) return false;
      if (!store.listEvents("governed_task", gtId).some((e) => {
        const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
        return String(e.event_type ?? "") === "GOVERNED_TASK_VALIDATED" &&
          String(e.correlation_id ?? "") === corr &&
          String(md.mission_id ?? "") === mid &&
          String(md.task_id ?? "") === tid &&
          String(md.executor_id ?? "") === String(x.executor_id ?? "");
      })) return false;
      // Result-validation authority — the PASS row must bind to this
      // exact execution/governed-task/mission, and the immutable
      // RESULT_VALIDATED event must pin that exact validation_id.
      const pass = validations.find((v) =>
        String(v.execution_id ?? "") === String(x.execution_id ?? "") &&
        String(v.governed_task_id ?? "") === gtId &&
        String(v.mission_id ?? "") === mid &&
        String(v.status ?? "") === "PASS");
      if (!pass) return false;
      return execEvents.some((e) =>
        String(e.event_type ?? "") === "RESULT_VALIDATED" &&
        String(e.new_state ?? "") === "PASS" &&
        String(e.correlation_id ?? "") === corr &&
        String((e.metadata as Record<string, unknown> | undefined)
          ?.validation_id ?? "") === String(pass.validation_id ?? ""));
    });
    if (!proven) {
      fail(`mission ${mid}: task ${tid} lacks governed validated execution`);
    }
  }
}

/** Non-throwing form of the canonical mission-success proof. */
export function proveCanonicalMissionCompletion(
  store: PairEvidenceStore, mission: Row,
): boolean {
  try {
    assertCanonicalMissionCompletion(store, mission);
    return true;
  } catch {
    return false;
  }
}

/* ---------- R3 — canonical mission lifecycle proof ------------------
 *
 * A mutable `mission.status` field is a CLAIM, never authority: the
 * open-gate, sync folds and routine mirrors must prove the claimed
 * lifecycle state through the immutable evidence chain.
 *
 * Canonical terminal pairings (surveyed from the writers):
 *   COMPLETED ↔ runtime COMPLETED   (assertCanonicalMissionCompletion)
 *   FAILED    ↔ runtime FAILED      (maybeFinalize: tasks_incomplete)
 *   FAILED    ↔ runtime ABORTED     (abortMission — the one canonical
 *                                    path that may legitimately leave
 *                                    executor executions unresolved)
 *   CANCELLED ↔ runtime CANCELLED   (operator cancel)
 *   CANCELLED ↔ runtime ABORTED     (cancel then abort)
 *   PAUSED    ↔ runtime PAUSED      (non-terminal — NEVER replacement
 *                                    authority; proof only for the
 *                                   PAUSED→BLOCKED projection fold)
 *   PAUSED    ↔ runtime CREATED     (operator pause of a mission whose
 *                                    runtime never started — pause()
 *                                    mints the MRT row at CREATED and
 *                                    cannot transition it to PAUSED)
 */
const LIFECYCLE_PAIRINGS: Record<string, ReadonlySet<string>> = {
  FAILED: new Set(["FAILED", "ABORTED"]),
  CANCELLED: new Set(["CANCELLED", "ABORTED"]),
  PAUSED: new Set(["PAUSED", "CREATED"]),
};

/** States that may legally transition into `to` — derived from the
 *  canonical mission table, never redefined here. */
const missionPredsOf = (to: string) => new Set(
  Object.entries(MISSION_STATUS_TRANSITIONS)
    .filter(([, tos]) => tos.includes(to))
    .map(([from]) => from),
);
const runtimePredsOf = (to: string) => new Set<string>(
  (Object.keys(RUNTIME_TRANSITIONS) as Array<keyof typeof RUNTIME_TRANSITIONS>)
    .filter((from) => RUNTIME_TRANSITIONS[from]
      .includes(to as keyof typeof RUNTIME_TRANSITIONS)),
);

/**
 * Prove one mission reached lifecycle state `claimed` canonically:
 * mission row + exactly-one legal MISSION_TRANSITION into it + the
 * MRT_<id> row in a compatible terminal state + exactly-one legal
 * MISSION_RUNTIME_TRANSITION into it (mission_id-pinned) + no
 * contradictory later lifecycle evidence on either entity + (for
 * terminal claims) no live executor_execution except the explicitly
 * marked `cancel_requested` side-effect state, or the ABORTED pairing
 * where abortMission legitimately leaves executions in flight.
 * COMPLETED delegates to the existing completion proof unchanged.
 */
export function assertCanonicalMissionLifecycle(
  store: PairEvidenceStore, mission: Row, claimed: string,
): void {
  const mid = String(mission.mission_id ?? "");
  if (!mid) fail("mission: missing mission_id");
  if (claimed === "COMPLETED") {
    assertCanonicalMissionCompletion(store, mission);
    return;
  }
  const pairings = LIFECYCLE_PAIRINGS[claimed];
  if (!pairings) fail(`mission ${mid}: unproven lifecycle state ${claimed}`);
  if (String(mission.status) !== claimed) {
    fail(`mission ${mid}: status ${String(mission.status)} != ${claimed}`);
  }
  // Immutable mission transition evidence into the claimed state —
  // exactly one, from a legal predecessor, and no event ever LEAVES
  // the claimed state (a later transition would contradict the row).
  const mEvs = store.listEvents("mission", mid).filter((e) =>
    String(e.event_type ?? "") === "MISSION_TRANSITION");
  const into = mEvs.filter((e) => String(e.new_state ?? "") === claimed);
  if (into.length !== 1) {
    fail(`mission ${mid}: ${into.length} ${claimed} transition events`);
  }
  if (!missionPredsOf(claimed).has(String(into[0]!.old_state ?? ""))) {
    fail(`mission ${mid}: ${claimed} from ${String(into[0]!.old_state)}`);
  }
  if (mEvs.some((e) => String(e.old_state ?? "") === claimed)) {
    fail(`mission ${mid}: contradictory post-${claimed} transition`);
  }
  // Canonical runtime row — identity must match exactly.
  const rtId = `MRT_${mid}`;
  const rt = store.tryGet("mission_runtime", rtId) as Row | null;
  if (!rt) fail(`mission ${mid}: mission_runtime row missing`);
  if (String(rt.mission_id ?? "") !== mid) {
    fail(`mission ${mid}: runtime identity mismatch`);
  }
  const rtState = String(rt.state ?? "");
  if (!pairings.has(rtState)) {
    fail(`mission ${mid}: runtime state ${rtState} incompatible with ${claimed}`);
  }
  // Immutable runtime transition evidence — exactly one into the
  // terminal/paused runtime state, from a legal predecessor, pinned to
  // this mission, with nothing leaving it afterwards. The CREATED
  // pairing (mission paused before its runtime ever started) has no
  // transition INTO it — the MISSION_RUNTIME_CREATED anchor is the
  // evidence, and any transition event contradicts it.
  const rtEvs = store.listEvents("mission_runtime", rtId).filter((e) =>
    String(e.event_type ?? "") === "MISSION_RUNTIME_TRANSITION");
  if (rtState === "CREATED") {
    if (rtEvs.length !== 0) {
      fail(`mission ${mid}: runtime CREATED with ${rtEvs.length} transition events`);
    }
    const createdEvs = store.listEvents("mission_runtime", rtId).filter((e) =>
      String(e.event_type ?? "") === "MISSION_RUNTIME_CREATED" &&
      String((e.metadata as Record<string, unknown> | undefined)
        ?.mission_id ?? "") === mid);
    if (createdEvs.length !== 1) {
      fail(`mission ${mid}: runtime creation anchor missing`);
    }
  } else {
    const rtInto = rtEvs.filter((e) => String(e.new_state ?? "") === rtState);
    if (rtInto.length !== 1) {
      fail(`mission ${mid}: ${rtInto.length} runtime ${rtState} events`);
    }
    if (!runtimePredsOf(rtState).has(String(rtInto[0]!.old_state ?? ""))) {
      fail(`mission ${mid}: runtime ${rtState} from ${String(rtInto[0]!.old_state)}`);
    }
    const rtMd = (rtInto[0]!.metadata as Record<string, unknown> | undefined) ?? {};
    if (String(rtMd.mission_id ?? "") !== mid) {
      fail(`mission ${mid}: runtime event mission mismatch`);
    }
    if (rtEvs.some((e) => String(e.old_state ?? "") === rtState)) {
      fail(`mission ${mid}: contradictory post-${rtState} runtime transition`);
    }
  }
  // No live execution may remain for a claimed terminal state UNLESS
  // the canonical writer marked it (`cancel_requested`) or the pairing
  // is ABORTED — abortMission is the one writer that legitimately
  // leaves in-flight side effects unresolved. `terminal_outcome`
  // exclusions mirror MissionRuntime's in-flight sweep: an UNKNOWN
  // execution the operator acknowledged through the governed
  // reconcile→approve path is neutralized, not live.
  if (claimed !== "PAUSED" && rtState !== "ABORTED") {
    const live = store.list("executor_execution").filter((e) =>
      String(e.mission_id ?? "") === mid &&
      !TERMINAL_EXECUTION.has(String(e.execution_state ?? "")) &&
      e.cancel_requested !== true &&
      !e.terminal_outcome);
    if (live.length > 0) {
      fail(`mission ${mid}: ${live.length} live executions contradict ${claimed}`);
    }
  }
}

/** Mission states that mean "execution in flight" — PAUSED and every
 *  terminal state are explicitly NOT in-flight. */
const IN_FLIGHT_MISSION_STATES: ReadonlySet<string> =
  new Set(["CREATED", "READY", "RUNNING"]);

/** Runtime states compatible with an in-flight mission: live, never
 *  paused, never terminal. */
const IN_FLIGHT_RUNTIME_STATES: ReadonlySet<string> = new Set([
  "CREATED", "PLANNING", "READY", "RUNNING",
  "WAITING", "WAITING_BACKOFF", "WAITING_APPROVAL",
  "RECONCILING", "REPLANNING", "RECOVERING",
]);

/**
 * Prove one mission is canonically IN FLIGHT — the smallest canonical
 * ACTIVE-mission proof (P15.6 R2.A):
 *   - claimed status is a real in-flight state — PAUSED and every
 *     terminal state can NEVER converge as "awaiting execution";
 *   - the immutable mission spine replays legally: exactly one
 *     MISSION_CREATED anchor, every MISSION_TRANSITION legal per the
 *     canonical transition table and continuous from CREATED, with the
 *     replayed head equal to the claimed status;
 *   - when `forWorkItem` is given, the WOB identity: exactly one
 *     canonical BOUND `work_open_binding` pins this mission to that
 *     work item, and the mission's `bound_open_id` origin proof agrees;
 *   - compatible runtime state: `MRT_<id>` must be in a live
 *     (non-paused, non-terminal) runtime state; a missing runtime row
 *     is only acceptable while the mission is still CREATED (the
 *     runtime entity materializes lazily on first dispatch touch).
 * Anything else fails closed — a race loser may only converge through
 * this proof, never through a claimed status alone.
 */
export function assertCanonicalMissionInFlight(
  store: PairEvidenceStore, mission: Row, forWorkItem?: Row,
): void {
  const mid = String(mission.mission_id ?? "");
  if (!mid) fail("mission: missing mission_id");
  const claimed = String(mission.status);
  if (!IN_FLIGHT_MISSION_STATES.has(claimed)) {
    fail(`mission ${mid}: ${claimed} is not an in-flight state`);
  }
  // Immutable spine — exactly one creation anchor + legal continuous
  // transitions; a forged or missing transition evidence fails.
  const mEvs = store.listEvents("mission", mid);
  const created = mEvs.filter((e) =>
    String(e.event_type ?? "") === "MISSION_CREATED");
  if (created.length !== 1) {
    fail(`mission ${mid}: ${created.length} creation anchors`);
  }
  let derived = "CREATED";
  for (const e of mEvs.filter((e) =>
    String(e.event_type ?? "") === "MISSION_TRANSITION")) {
    const from = String(e.old_state ?? "");
    const to = String(e.new_state ?? "");
    if (from !== derived) {
      fail(`mission ${mid}: transition from ${from} but spine at ${derived}`);
    }
    if (!(MISSION_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
      fail(`mission ${mid}: illegal transition ${from}->${to}`);
    }
    derived = to;
  }
  if (derived !== claimed) {
    fail(`mission ${mid}: claims ${claimed} but spine derives ${derived}`);
  }
  // WOB identity — the mission must be the canonical bound attempt of
  // the claimed work item, with the non-forgeable origin pin agreeing.
  if (forWorkItem) {
    const wobs = canonicalBoundAttemptsForWorkItem(
      store, String(forWorkItem.work_item_id));
    const bound = wobs.filter((b) => String(b.mission_id ?? "") === mid);
    if (bound.length !== 1) {
      fail(`mission ${mid}: ${bound.length} canonical bound WOBs pin it to ${String(forWorkItem.work_item_id)}`);
    }
    const v = validateWorkOpenBindingById(store, String(bound[0]!.open_id), {
      forWorkItem, forMission: mission, requireState: "BOUND",
      mode: "PROVENANCE_HISTORICAL",
    });
    if (!v.ok) {
      fail(`mission ${mid}: bound WOB proof: ${v.reason}`);
    }
    if (String(mission.bound_open_id ?? "") !== String(bound[0]!.open_id)) {
      fail(`mission ${mid}: bound_open_id origin pin mismatch`);
    }
  }
  // Compatible runtime — the claimed row state is a mutable
  // projection: replay the immutable MISSION_RUNTIME_* evidence to
  // derive the canonical latest state first (R3.A), then apply the
  // in-flight compatibility gate.
  const rtId = `MRT_${mid}`;
  const rt = store.tryGet("mission_runtime", rtId) as Row | null;
  const rtEvs = store.listEvents("mission_runtime", rtId);
  const rtCreated = rtEvs.filter((e) =>
    String(e.event_type ?? "") === "MISSION_RUNTIME_CREATED");
  const rtTrans = rtEvs.filter((e) =>
    String(e.event_type ?? "") === "MISSION_RUNTIME_TRANSITION");
  const rtMissionId = (e: Record<string, unknown>): string =>
    String((e.metadata as Record<string, unknown> | undefined)?.mission_id ?? "");
  if (!rt) {
    // Legitimate case: a CREATED mission whose lazy runtime row was
    // never minted — but then there must be ZERO runtime evidence for
    // this mission (a deleted row over committed evidence is corrupt).
    if (claimed !== "CREATED") {
      fail(`mission ${mid}: ${claimed} without canonical runtime row`);
    }
    if (rtCreated.length > 0 || rtTrans.length > 0) {
      fail(`mission ${mid}: runtime evidence exists but the row is missing`);
    }
    return;
  }
  if (String(rt.mission_id ?? "") !== mid) {
    fail(`mission ${mid}: runtime identity mismatch`);
  }
  if (rtCreated.length !== 1) {
    fail(`mission ${mid}: ${rtCreated.length} runtime creation anchors`);
  }
  const rtAnchor = rtCreated[0]!;
  if (rtMissionId(rtAnchor) !== mid ||
      String(rtAnchor.new_state ?? "") !== "CREATED") {
    fail(`mission ${mid}: malformed runtime creation anchor`);
  }
  // Replayed state must equal the claimed row state — every transition
  // continuous, legal, and mission-bound.
  let rtDerived = "CREATED";
  for (const e of rtTrans) {
    if (rtMissionId(e) !== mid) {
      fail(`mission ${mid}: runtime transition carries foreign mission identity`);
    }
    const from = String(e.old_state ?? "");
    const to = String(e.new_state ?? "");
    if (from !== rtDerived) {
      fail(`mission ${mid}: runtime transition from ${from} but replay at ${rtDerived}`);
    }
    if (!(RUNTIME_TRANSITIONS[from as MissionRuntimeState] ?? [])
        .includes(to as MissionRuntimeState)) {
      fail(`mission ${mid}: illegal runtime transition ${from}->${to}`);
    }
    rtDerived = to;
  }
  if (rtDerived !== String(rt.state ?? "")) {
    fail(`mission ${mid}: claims runtime ${String(rt.state)} but replay derives ${rtDerived}`);
  }
  if (!IN_FLIGHT_RUNTIME_STATES.has(rtDerived)) {
    fail(`mission ${mid}: runtime state ${rtDerived} incompatible with in-flight`);
  }
}

/** Non-throwing lifecycle proof for one claimed state. */
export function proveCanonicalMissionLifecycle(
  store: PairEvidenceStore, mission: Row, claimed: string,
): boolean {
  try {
    assertCanonicalMissionLifecycle(store, mission, claimed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replacement authority: the ONLY proof that lets a prior linked
 * mission make room for a new bound attempt. PAUSED and every
 * non-terminal status return false — PAUSED is live, never terminal.
 */
export function proveCanonicalMissionTerminalForReplacement(
  store: PairEvidenceStore, mission: Row,
): boolean {
  const ms = String(mission.status ?? "");
  if (ms === "COMPLETED") return proveCanonicalMissionCompletion(store, mission);
  if (ms === "FAILED" || ms === "CANCELLED") {
    return proveCanonicalMissionLifecycle(store, mission, ms);
  }
  return false;
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
  // Status text alone is not authority — R1: the mission must carry the
  // full canonical runtime-completion evidence chain.
  if (!m || !proveCanonicalMissionCompletion(deps.store, m)) return false;
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

// =====================================================================
// P14 FC R4 — omission-safe canonical attempt history.
// `work_item.mission_ids` is a mutable projection: attempt authority is
// derived ONLY from durable `work_open_binding` evidence (BOUND state,
// ULID open_id order = canonical open-history order). A truncated,
// reordered, injected or duplicated projection must AGREE with the WOB
// history or the whole lineage is corrupt — missing evidence never
// creates permission to execute again.
// =====================================================================

/** Canonical bound attempts of a work item, in canonical open order
 *  (open_id is a ULID — lexicographic sort IS creation order; ties are
 *  impossible). INTENT/ROLLED_BACK bindings are opens-in-flight or
 *  rolled back, never attempts. */
export function canonicalBoundAttemptsForWorkItem(
  store: PairEvidenceStore, workItemId: string,
): Row[] {
  return store.list("work_open_binding")
    .filter((b) => String(b.work_item_id ?? "") === workItemId &&
      String(b.state ?? "") === "BOUND")
    .sort((a, b) => String(a.open_id).localeCompare(String(b.open_id)));
}

function lineageFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_MISSION_LIFECYCLE_CORRUPT", detail);
}

/**
 * Prove `row`'s mission attempt history canonically:
 *   - every BOUND `work_open_binding` for this item validates the full
 *     provenance chain (exact work item/business/project/assignee,
 *     reserved mission id, `mission.bound_open_id` origin pin);
 *   - every canonical attempt's mission ROW exists — a missing row is
 *     never "attempt never existed";
 *   - no two bindings claim the same mission;
 *   - `mission_ids` agrees exactly: for non-routine items it must equal
 *     the canonical attempt list (in canonical ULID order — a reorder
 *     that would make an older attempt look current is caught by the
 *     order comparison); for routine items `mids[0]` is the projected
 *     scheduler mission (proven by the routine-lineage validator) and
 *     `mids[1..]` must equal the WOB-ordered reopen attempts.
 * Omission of a canonical attempt, injection of a boundless id,
 * duplicates, reorders, foreign bound attempts and missing mission
 * rows all fail here.
 */
export function assertCanonicalWorkMissionLineage(
  store: PairEvidenceStore, row: Row,
): void {
  const wid = String(row.work_item_id ?? "");
  const mids = ((row.mission_ids as string[] | undefined) ?? []).map(String);
  if (new Set(mids).size !== mids.length) {
    lineageFail(`work item ${wid}: duplicate mission id in mission_ids`);
  }
  const wobs = canonicalBoundAttemptsForWorkItem(store, wid);
  const attemptIds: string[] = [];
  const seen = new Set<string>();
  for (const b of wobs) {
    const openId = String(b.open_id ?? "");
    const v = validateWorkOpenBindingById(store, openId, {
      forWorkItem: row, requireState: "BOUND",
      // HISTORICAL (FC R5): each WOB pins the assignee AT THAT attempt
      // — a later legal STANDALONE reassignment must not invalidate
      // it; the pinned agent still resolves in-business.
      mode: "PROVENANCE_HISTORICAL",
    });
    if (!v.ok) {
      lineageFail(`work item ${wid}: binding ${openId} invalid: ${v.reason}`);
    }
    const mid = String(b.mission_id ?? "");
    if (seen.has(mid)) {
      lineageFail(`work item ${wid}: duplicate binding for mission ${mid}`);
    }
    seen.add(mid);
    const m = store.tryGet("mission", mid) as Row | null;
    if (!m) {
      lineageFail(`work item ${wid}: bound mission ${mid} row missing`);
    }
    const mv = validateWorkOpenBindingById(store, openId, {
      forWorkItem: row, forMission: m, requireState: "BOUND",
      mode: "PROVENANCE_HISTORICAL",
    });
    if (!mv.ok) {
      lineageFail(`work item ${wid}: mission ${mid} binding proof: ${mv.reason}`);
    }
    attemptIds.push(mid);
  }
  if (row.routine_id != null) {
    // Routine model (R1–R3): mids[0] is the canonical scheduler-fire
    // mission (its own provenance validator); every tail id must equal
    // the WOB-ordered bound attempts — an omitted bound attempt must
    // not erase a live/terminal attempt from authority.
    if (mids.length === 0) {
      lineageFail(`routine mirror ${wid}: projected mission missing`);
    }
    const tails = mids.slice(1);
    if (tails.length !== attemptIds.length ||
        tails.some((t, i) => t !== attemptIds[i])) {
      lineageFail(`routine item ${wid}: mission_ids tails != canonical bound-attempt history`);
    }
  } else {
    if (mids.length !== attemptIds.length ||
        mids.some((t, i) => t !== attemptIds[i])) {
      lineageFail(`work item ${wid}: mission_ids != canonical bound-attempt history`);
    }
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
