/**
 * Shared test seam — construct the canonical mission-completion
 * evidence chain exactly as the governed runtime produces it.
 *
 * P14-WFV2-P3-R1: `mission.status = "COMPLETED"` written directly is a
 * FORGERY — completion seams consume only the canonical evidence chain:
 *
 *   legal mission transitions → mission_runtime row driven
 *   CREATED→READY→RUNNING→COMPLETED (reason "all_tasks_completed") → a
 *   committed current-plan revision whose tasks each carry the FULL
 *   governed chain (R2): governed_task VALIDATED→DISPATCH_AUTHORIZED →
 *   persisted executor_dispatch_intent EXECUTION_PERSISTED →
 *   executor_execution COMPLETED + EXECUTION_DISPATCHED evidence →
 *   PASS execution_validation written by the REAL
 *   ArtifactProvenanceValidator (same writer the GovernedTaskGate
 *   uses) + its RESULT_VALIDATED anchor → correlated immutable
 *   TASK_COMPLETED event.
 *
 * Everything here goes through the app's own canonical writers
 * (service.transitionMission, service.commitPlan, service.updateTask,
 * store.put/store.event, ArtifactProvenanceValidator) — the same rows
 * and event shapes MissionRuntime/GovernedTaskGate produce, so the
 * completion seams accept it as genuine governed-runtime evidence.
 */

import type {
  MissionControl, MissionScheduleService, PairControlPlane, PairEvidenceStore,
} from "../pair/index.js";
import { ArtifactProvenanceValidator, utcnow } from "../pair/index.js";

const RUNTIME_ACTOR = "PAIR_MISSION_RUNTIME";
const GATE_ACTOR = "PAIR_GOVERNED_TASK_GATE";
const TEST_EXECUTOR = "EX_TEST_CANONICAL";

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
  // Per-task governed evidence — the exact shape Gate.settleExecution
  // leaves behind: governed_task (VALIDATED → DISPATCH_AUTHORIZED) →
  // intent EXECUTION_PERSISTED → executor_execution COMPLETED +
  // EXECUTION_DISPATCHED/RESULT_COLLECTED events → REAL
  // ArtifactProvenanceValidator PASS + RESULT_VALIDATED anchor →
  // TASK_COMPLETED on the execution's correlation.
  const taskRows = plan.task_ids.map((tid) =>
    store.get("task", tid) as Record<string, unknown>);
  for (const t of taskRows) {
    const tid = String(t.task_id);
    const gtId = `GT_${tid}`;
    const eid = `EXEC_${tid}`;
    const corr = `COR_${tid}`;
    const workspace = `/tmp/pair-canonical-ws/${mid}`;
    store.put("governed_task", gtId, {
      governed_task_id: gtId,
      mission_id: mid,
      task_id: tid,
      plan_id: plan.plan_id,
      plan_revision: plan.revision,
      correlation_id: corr,
      executor_id: TEST_EXECUTOR,
      task_instruction: String(t.task_instruction ?? t.title ?? tid),
      workspace,
      allowed_paths: [workspace],
      permissions: [],
      constraints: [],
      requested_tools: [],
      dependency_outputs: [],
      timeout: 60000,
      expected_output_contract: null,
      risk_class: "LOW",
      approval_required: false,
      approval_id: null,
      approval_scope_digest: null,
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      created_at: utcnow(),
      version: 0,
    }, 0);
    store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: GATE_ACTOR, correlation_id: corr,
      metadata: {
        mission_id: mid, task_id: tid, executor_id: TEST_EXECUTOR,
        risk_class: "LOW", approval_required: false,
      },
    });
    store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "EXECUTION_PREPARED", old_state: "VALIDATED",
      new_state: "DISPATCH_AUTHORIZED", actor: GATE_ACTOR,
      correlation_id: corr,
    });
    store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
      intent_id: `INTENT_${gtId}`,
      governed_task_id: gtId,
      executor_id: TEST_EXECUTOR,
      state: "EXECUTION_PERSISTED",
      execution_id: eid,
      created_at: utcnow(),
      version: 0,
    }, 0);
    store.put("executor_execution", eid, {
      execution_id: eid,
      governed_task_id: gtId,
      mission_id: mid,
      task_id: tid,
      executor_id: TEST_EXECUTOR,
      plan_revision: plan.revision,
      correlation_id: corr,
      execution_state: "COMPLETED",
      dispatch_timestamp: utcnow(),
      run_root: `${workspace}/run`,
      workspace,
      result: { status: "COMPLETED", output: "done" },
      version: 0,
    }, 0);
    store.event({
      entity_type: "executor_execution", entity_id: eid,
      event_type: "EXECUTION_DISPATCHED", new_state: "COMPLETED",
      actor: GATE_ACTOR, correlation_id: corr,
      metadata: { governed_task_id: gtId },
    });
    store.event({
      entity_type: "executor_execution", entity_id: eid,
      event_type: "RESULT_COLLECTED", new_state: "COMPLETED",
      actor: GATE_ACTOR, correlation_id: corr,
    });
    // The REAL validation authority — writes the PASS execution_validation
    // row + the immutable RESULT_VALIDATED event pinning its id.
    const validation = new ArtifactProvenanceValidator()
      .validate_execution(service, eid) as Record<string, unknown>;
    if (String(validation.status) !== "PASS") {
      throw new Error(`canonical helper validation failed: ${String(validation.status)}`);
    }
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

// =====================================================================
// P14 FC R1 — genuine canonical routine fire.
// A routine-run mission is canonical ONLY when minted by
// MissionScheduleService.fireDue: due-occurrence claim → governed
// startMission → occurrence FIRED→mission binding → SCHEDULE_FIRED
// anchor. Caller-supplied `metadata.schedule_id` alone is a label, never
// authority — tests must drive the real scheduler path.
// =====================================================================

export async function fireRoutineMission(
  ctx: {
    store: PairEvidenceStore;
    service: PairControlPlane;
    control: MissionControl;
    projectId: string;
  },
  schedules: MissionScheduleService,
  scheduleId: string,
  now?: string,
): Promise<Record<string, unknown>> {
  if (!now) {
    // Make the next occurrence due at wall-clock now; the due_at recorded
    // is that rewound value — the canonical claim/binding path is real.
    const schedRow = ctx.store.get("mission_schedule", scheduleId);
    schedRow.next_due_at = new Date(Date.now() - 1000).toISOString();
    ctx.store.put("mission_schedule", scheduleId, schedRow, Number(schedRow.version));
  }
  const res = await schedules.fireDue(async (input) =>
    ctx.control.startMission({
      project_id: ctx.projectId, goal: input.goal,
      metadata: input.metadata, operator_id: "op",
    }), now);
  if (!res.fired.includes(scheduleId)) {
    throw new Error(`routine fire failed for ${scheduleId}: ${JSON.stringify(res)}`);
  }
  // The latest bound occurrence for this schedule is this fire's.
  const occs = ctx.store.list("schedule_occurrence")
    .filter((o) => String(o.schedule_id) === scheduleId && o.mission_id != null)
    .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)));
  if (occs.length === 0) throw new Error(`no bound occurrence for ${scheduleId}`);
  return ctx.store.get("mission", String(occs[0]!.mission_id));
}
