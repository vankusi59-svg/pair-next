/**
 * Canonical routine-mirror provenance (P14 FINAL CLOSURE R1).
 *
 * A routine work item is a *projection* of a scheduler-fired mission —
 * minted by `syncRoutineWorkItems`, never by `openWorkItem`. Its
 * identity therefore derives from canonical schedule authority, not
 * from any caller-supplied mission metadata:
 *
 *   mission_schedule (routine.schedule_id)
 *     → schedule_occurrence (status FIRED, mission_id bound)
 *     → mission metadata {schedule_occurrence_id, schedule_id,
 *        scheduled_for, schedule_digest, business_id}
 *     → SCHEDULE_FIRED event anchor on the mission_schedule
 *     → deterministic WI_RT_<digest(mission)> work_item mirror
 *     → WORK_ITEM_CREATED projection event
 *
 * A caller doing `startMission({metadata: {schedule_id: ...}})` can
 * never satisfy this chain: the occurrence's `mission_id` pins the
 * real scheduler mission, and only `MissionScheduleService.fireDue`
 * writes the FIRED binding + SCHEDULE_FIRED anchor.
 */

import { digest, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import { IntegrityError } from "./errors.js";

export type Row = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export function routineMirrorRowId(missionId: string): string {
  return `WI_RT_${digest("routine-work-item:" + missionId).slice(0, 24)}`;
}

export interface RoutineMirrorProof {
  routine: Row;
  schedule: Row;
  occurrence: Row;
  mission: Row;
}

/**
 * Prove that `mission` is a canonical scheduler fire of `routine`'s
 * schedule — the occurrence↔mission↔event chain minted only by
 * `MissionScheduleService.fireDue`. Throws on any gap.
 */
export function assertCanonicalRoutineFire(
  store: PairEvidenceStore,
  routine: Row,
  mission: Row,
): RoutineMirrorProof {
  const fail = (r: string): never => {
    throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", r);
  };
  const routineId = str(routine.routine_id);
  const scheduleId = str(routine.schedule_id);
  if (!routineId || !scheduleId) fail("routine row missing identity");
  const schedule = store.tryGet("mission_schedule", scheduleId!) as Row | null;
  if (schedule === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `routine ${routineId} missing mission_schedule ${scheduleId}`); }
  const business = store.tryGet("business", str(routine.business_id) ?? "") as Row | null;
  if (business === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `routine ${routineId} missing business`); }
  const schedMd = (schedule.metadata as Record<string, unknown> | undefined) ?? {};
  if (String(schedMd.business_id ?? "") !== String(routine.business_id)) {
    fail(`schedule ${scheduleId} business mismatch`);
  }
  if (String(schedule.project_id ?? "") !== String(business.project_id)) {
    fail(`schedule ${scheduleId} project mismatch`);
  }
  const md = (mission.metadata as Record<string, unknown> | undefined) ?? {};
  const occurrenceId = str(md.schedule_occurrence_id);
  if (!occurrenceId) fail(`mission ${str(mission.mission_id)} has no schedule_occurrence_id`);
  const occ = store.tryGet("schedule_occurrence", occurrenceId!) as Row | null;
  if (occ === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `occurrence ${occurrenceId} missing`); }
  if (String(occ.schedule_id) !== scheduleId) {
    fail(`occurrence ${occurrenceId} schedule mismatch`);
  }
  if (String(occ.status) !== "FIRED") {
    fail(`occurrence ${occurrenceId} not FIRED (${String(occ.status)})`);
  }
  const missionId = str(mission.mission_id);
  if (String(occ.mission_id ?? "") !== missionId) {
    fail(`occurrence ${occurrenceId} bound to ${String(occ.mission_id ?? "null")} ≠ ${missionId}`);
  }
  if (String(md.schedule_id ?? "") !== scheduleId) {
    fail(`mission ${missionId} schedule_id claim mismatch`);
  }
  if (String(md.scheduled_for ?? "") !== String(occ.due_at)) {
    fail(`mission ${missionId} scheduled_for ≠ occurrence due_at`);
  }
  if (String(md.business_id ?? "") !== String(routine.business_id)) {
    fail(`mission ${missionId} business scope mismatch`);
  }
  const expectDigest = digest({
    goal: schedule.goal, cron: schedule.cron, schedule_id: scheduleId,
  });
  if (String(md.schedule_digest ?? "") !== expectDigest) {
    fail(`mission ${missionId} schedule_digest mismatch`);
  }
  // Immutable scheduler anchor: exactly one SCHEDULE_FIRED on the
  // mission_schedule pinning this exact mission+occurrence+due_at.
  const anchors = store.listEvents("mission_schedule", scheduleId!).filter((e) => {
    if (String(e.event_type) !== "SCHEDULE_FIRED") return false;
    const emd = (e.metadata as Record<string, unknown> | undefined) ?? {};
    return String(e.correlation_id ?? "") === missionId &&
      String(emd.mission_id ?? "") === missionId &&
      String(emd.occurrence_id ?? "") === occurrenceId &&
      String(emd.scheduled_for ?? "") === String(occ.due_at);
  });
  if (anchors.length !== 1) {
    fail(`SCHEDULE_FIRED anchors for ${missionId}/${occurrenceId}: ${anchors.length}`);
  }
  return { routine, schedule, occurrence: occ, mission };
}

/**
 * Prove that `item` is the canonical routine projection: exact routine
 * row, same business, deterministic WI_RT id derived from the projected
 * mission (mission_ids[0] — the scheduler fire; a promoted mirror may
 * append bound missions later), the full canonical fire chain, and a
 * matching WORK_ITEM_CREATED projection event.
 */
export function assertCanonicalRoutineMirror(
  store: PairEvidenceStore,
  item: Row,
): RoutineMirrorProof {
  const fail = (r: string): never => {
    throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", r);
  };
  if (String(item.source ?? "") !== "routine") {
    fail(`item ${str(item.work_item_id)} source ≠ routine`);
  }
  const routineId = str(item.routine_id);
  if (!routineId) fail(`item ${str(item.work_item_id)} missing routine_id`);
  const routine = store.tryGet("routine", routineId!) as Row | null;
  if (routine === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `routine ${routineId} missing`); }
  if (String(routine.business_id) !== String(item.business_id)) {
    fail(`item ${str(item.work_item_id)} business ≠ routine business`);
  }
  const mids = (item.mission_ids as string[] | undefined) ?? [];
  const projectedId = mids.length ? String(mids[0]) : null;
  if (projectedId === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `item ${str(item.work_item_id)} has no projected mission`); }
  if (String(item.work_item_id) !== routineMirrorRowId(projectedId)) {
    fail(`item ${str(item.work_item_id)} is not the deterministic mirror of ${projectedId}`);
  }
  const mission = store.tryGet("mission", projectedId) as Row | null;
  if (mission === null) { throw new IntegrityError("FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT", `projected mission ${projectedId} missing`); }
  const proof = assertCanonicalRoutineFire(store, routine, mission);
  // Projection event must agree: routine + mission + source pinned.
  const created = store.listEvents("work_item", String(item.work_item_id)).filter((e) => {
    if (String(e.event_type) !== "WORK_ITEM_CREATED") return false;
    const emd = (e.metadata as Record<string, unknown> | undefined) ?? {};
    return String(emd.routine_id ?? "") === routineId &&
      String(emd.mission_id ?? "") === projectedId &&
      String(emd.source ?? "") === "routine";
  });
  if (created.length !== 1) {
    fail(`WORK_ITEM_CREATED projections for ${String(item.work_item_id)}: ${created.length}`);
  }
  return proof;
}

/** Boolean form — false on any provenance gap. */
export function proveCanonicalRoutineMirror(
  store: PairEvidenceStore,
  item: Row,
): boolean {
  try {
    assertCanonicalRoutineMirror(store, item);
    return true;
  } catch {
    return false;
  }
}
