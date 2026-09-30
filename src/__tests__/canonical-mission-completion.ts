/**
 * Shared test seam — construct the canonical mission-completion
 * evidence chain exactly as the governed runtime produces it.
 *
 * P14-WFV2-P3-R1: `mission.status = "COMPLETED"` written directly is a
 * FORGERY — completion seams consume only the canonical evidence chain:
 *
 *   legal mission transitions → mission_runtime row driven
 *   CREATED→READY→RUNNING→COMPLETED (reason "all_tasks_completed") → a
 *   committed current-plan revision whose tasks each carry a COMPLETED
 *   executor_execution (COMPLETED result) + a correlated immutable
 *   TASK_COMPLETED event.
 *
 * Everything here goes through the app's own canonical writers
 * (service.transitionMission, service.commitPlan, service.updateTask,
 * store.put/store.event) — the same rows and event shapes
 * MissionRuntime/MissionSupervisor produce, so the completion seams
 * accept it as genuine governed-runtime evidence.
 */

import type { PairControlPlane, PairEvidenceStore } from "../pair/index.js";
import { utcnow } from "../pair/index.js";

const RUNTIME_ACTOR = "PAIR_MISSION_RUNTIME";

function transitionRuntimeLike(
  store: PairEvidenceStore, missionId: string, to: string, reason: string,
): void {
  const rtId = `MRT_${missionId}`;
  const cur = store.get("mission_runtime", rtId);
  const from = String(cur.state);
  if (from === to) return;
  cur.state = to;
  cur.entered_at = utcnow();
  cur.reason = reason;
  store.put("mission_runtime", rtId, cur, Number(cur.version));
  store.event({
    entity_type: "mission_runtime", entity_id: rtId,
    event_type: "MISSION_RUNTIME_TRANSITION",
    old_state: from, new_state: to, actor: RUNTIME_ACTOR,
    metadata: { mission_id: missionId, reason },
  });
}

/**
 * Drive `missionId` to canonically-complete: bound/standalone mission
 * gets a committed plan revision with `tasks` tasks, each execution
 * proven under the result-validation authority, then the mission +
 * runtime finalization transitions the real runtime emits.
 */
export function canonicallyCompleteMission(
  store: PairEvidenceStore,
  service: PairControlPlane,
  missionId: string,
  opts: { tasks?: number } = {},
): void {
  const mid = missionId;
  // A committed plan revision — the governed path never completes a
  // mission whose active plan has no tasks.
  const n = opts.tasks ?? 1;
  const plan = service.commitPlan({
    mission_id: mid,
    tasks: Array.from({ length: n }, (_, i) => ({
      task_key: `T${i + 1}`,
      title: `task ${i + 1}`,
      task_instruction: `task ${i + 1}`,
      required_capabilities: [],
      depends_on: [],
    })),
    source: "TEST_CANONICAL",
    reason: "canonical-completion",
    proposal: { ok: true },
  });
  // Mission transition chain — each hop emits MISSION_TRANSITION.
  const status = () => String(store.get("mission", mid).status);
  if (status() === "CREATED") {
    service.transitionMission(mid, "READY", RUNTIME_ACTOR);
  }
  if (status() === "READY") {
    service.transitionMission(mid, "RUNNING", RUNTIME_ACTOR);
  }
  // Runtime row + transitions — identical shape to MissionRuntime.
  const rtId = `MRT_${mid}`;
  if (!store.tryGet("mission_runtime", rtId)) {
    store.put("mission_runtime", rtId, {
      mission_runtime_id: rtId,
      mission_id: mid,
      state: "CREATED",
      entered_at: utcnow(),
      reason: "mission_runtime_created",
      barriers: {},
      pending_recovery: null,
      pending_approval_id: null,
      pending_remediation: null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0,
    }, 0);
    store.event({
      entity_type: "mission_runtime", entity_id: rtId,
      event_type: "MISSION_RUNTIME_CREATED",
      new_state: "CREATED", actor: RUNTIME_ACTOR,
      metadata: { mission_id: mid },
    });
  }
  if (String(store.get("mission_runtime", rtId).state) === "CREATED") {
    transitionRuntimeLike(store, mid, "READY", "plan_committed");
  }
  if (String(store.get("mission_runtime", rtId).state) === "READY") {
    transitionRuntimeLike(store, mid, "RUNNING", "tasks_dispatched");
  }
  // Per-task execution evidence: a COMPLETED executor_execution whose
  // result says COMPLETED + a correlated TASK_COMPLETED event — the
  // same pair settleExecution writes after validate_execution_result.
  for (const tid of plan.task_ids) {
    const eid = `EXEC_${tid}`;
    const corr = `COR_${tid}`;
    store.put("executor_execution", eid, {
      execution_id: eid,
      governed_task_id: `GT_${tid}`,
      mission_id: mid,
      task_id: tid,
      executor_id: "EX_TEST_CANONICAL",
      plan_revision: plan.revision,
      correlation_id: corr,
      execution_state: "COMPLETED",
      dispatch_timestamp: utcnow(),
      result: { status: "COMPLETED", output: "done" },
      version: 0,
    }, 0);
    service.updateTask(tid, { status: "COMPLETED", completed_at: utcnow() });
    store.event({
      entity_type: "task", entity_id: tid,
      event_type: "TASK_COMPLETED", new_state: "COMPLETED",
      actor: RUNTIME_ACTOR, correlation_id: corr,
    });
  }
  // Governed finalization — same order as MissionRuntime's
  // maybeCompleteMission: mission transition first, runtime second.
  if (status() !== "COMPLETED") {
    service.transitionMission(mid, "COMPLETED", RUNTIME_ACTOR);
  }
  transitionRuntimeLike(store, mid, "COMPLETED", "all_tasks_completed");
}
