/**
 * Mission scheduling — operator-defined recurring mission triggers.
 *
 * A `mission_schedule` entity stores {goal, cron, project_id, operator_id}.
 * `fireDue` submits a canonical mission (same path as the operator form —
 * planner, routing, approvals unchanged) whenever the schedule is due.
 * Persistence lives in pair.db, so schedules survive restarts.
 *
 * Cron grammar: 5 fields `min hour day-of-month month day-of-week`
 * (0=Sunday). Supports `*`, star-slash-n steps, `a`, `a-b`, `a-b/n`, comma lists.
 * Standard Vixie DOM/DOW rule: when both are restricted they OR.
 */

import { digest, newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import type { PairEvidenceStore } from "./store.js";
import { IntegrityError, PolicyError } from "./errors.js";

function md_businessId(s: Record<string, unknown>): string | null {
  const md = s.metadata as Record<string, unknown> | undefined;
  const b = md?.business_id;
  return typeof b === "string" && b ? b : null;
}

export const SCHEDULE_SCHEMA = "pair.os.vnext.mission-schedule.v1";

/**
 * How long a CLAIMED schedule occurrence may sit without a bound mission
 * before reconcileOccurrences treats the claimant as crashed. Within the
 * window the claim wins and no other process may fire that occurrence.
 */
export const OCCURRENCE_CLAIM_TTL_MS = Math.max(
  0,
  Number(process.env.PAIR_OCCURRENCE_CLAIM_MS ?? 10 * 60 * 1000) || 0,
);

/** Parse one cron field into the set of matching integers. */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", field);
    let lo = min;
    let hi = max;
    if (base === "*") {
      // full range
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b)
        throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", field);
      lo = a;
      hi = b;
    } else {
      const v = Number(base);
      if (!Number.isInteger(v) || v < min || v > max)
        throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", field);
      lo = stepMatch ? v : v;
      hi = stepMatch ? max : v;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", field);
  return out;
}

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", expr);
  return {
    minutes: parseField(f[0], 0, 59),
    hours: parseField(f[1], 0, 23),
    doms: parseField(f[2], 1, 31),
    months: parseField(f[3], 1, 12),
    dows: parseField(f[4], 0, 6),
    domRestricted: f[2] !== "*",
    dowRestricted: f[4] !== "*",
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const domHit = spec.doms.has(d.getUTCDate());
  const dowHit = spec.dows.has(d.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/** Next fire time strictly after `fromIso` (max 3 years out). */
export function nextRunAfter(expr: string, fromIso: string): string {
  const spec = parseCron(expr);
  const from = new Date(Date.parse(fromIso));
  if (!Number.isFinite(from.getTime())) throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", fromIso);
  const mins = [...spec.minutes].sort((a, b) => a - b);
  const hours = [...spec.hours].sort((a, b) => a - b);
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < 366 * 3; i++) {
    if (dayMatches(spec, day)) {
      for (const h of hours) {
        for (const m of mins) {
          const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
          if (t.getTime() > from.getTime()) return t.toISOString();
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  throw new PolicyError("FAIL_CLOSED_SCHEDULE_CRON", `no occurrence within 3y: ${expr}`);
}

export class MissionScheduleService {
  constructor(private readonly service: PairControlPlane) {}

  /**
   * Optional fail-closed gate evaluated before each due fire (inside
   * _fireDue, before submit). Returns a token whose settle(consumed)
   * resolves the gate's accounting — consumed=true once the mission exists.
   * Throwing vetoes the fire (recorded as the schedule's last_error).
   * BusinessLayer installs this so business routines respect business
   * mission-count budgets; schedules without metadata.business_id pass
   * through untouched.
   */
  preflight?: (input: {
    goal: string;
    project_id?: unknown;
    operator_id?: unknown;
    metadata?: Record<string, unknown>;
  }) => { settle: (consumed: boolean) => void } | null;

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  create(input: {
    goal: string;
    cron: string;
    project_id?: string;
    operator_id: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Record<string, unknown> {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "schedule.create");
    const next = nextRunAfter(input.cron, utcnow()); // validates cron
    const id = newId("SCHED");
    const row = {
      schedule_id: id,
      schema: SCHEDULE_SCHEMA,
      name: input.name ?? null,
      goal: input.goal,
      cron: input.cron,
      project_id: input.project_id ?? null,
      operator_id: input.operator_id,
      enabled: true,
      next_due_at: next,
      last_fired_at: null,
      last_mission_id: null,
      run_count: 0,
      last_error: null,
      metadata: input.metadata ?? {},
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("mission_schedule", id, row, 0);
    this.store.event({
      entity_type: "mission_schedule",
      entity_id: id,
      event_type: "SCHEDULE_CREATED",
      new_state: "ENABLED",
      actor: "PAIR_MISSION_SCHEDULE",
      metadata: { cron: input.cron, operator_id: input.operator_id },
    });
    return saved;
  }

  list(): Array<Record<string, unknown>> {
    return this.store
      .list("mission_schedule")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  get(id: string): Record<string, unknown> {
    return this.store.get("mission_schedule", id);
  }

  setEnabled(id: string, enabled: boolean, actor: string): Record<string, unknown> {
    const row = this.store.get("mission_schedule", id);
    row.enabled = enabled;
    if (enabled) row.next_due_at = nextRunAfter(String(row.cron), utcnow()); // never fire retroactively
    const saved = this.store.put("mission_schedule", id, row, Number(row.version));
    this.store.event({
      entity_type: "mission_schedule",
      entity_id: id,
      event_type: enabled ? "SCHEDULE_ENABLED" : "SCHEDULE_DISABLED",
      new_state: enabled ? "ENABLED" : "DISABLED",
      actor: `operator:${actor}`,
    });
    return saved;
  }

  remove(id: string, actor: string): Record<string, unknown> {
    const row = this.store.get("mission_schedule", id);
    row.enabled = false;
    row.deleted = true;
    const saved = this.store.put("mission_schedule", id, row, Number(row.version));
    this.store.event({
      entity_type: "mission_schedule",
      entity_id: id,
      event_type: "SCHEDULE_DELETED",
      new_state: "DELETED",
      actor: `operator:${actor}`,
    });
    return saved;
  }

  /** Enabled, not deleted, and due at or before `now`. */
  due(now: string): Array<Record<string, unknown>> {
    return this.list().filter(
      (s) => s.enabled === true && !s.deleted && String(s.next_due_at) <= now,
    );
  }

  /**
   * Exactly-once durable claim for one schedule occurrence. The claim entity
   * `OCC_<sha256(\"schedule-occurrence:<schedule_id>:<due_at>\")>` is created
   * via CAS BEFORE any preflight/submit — across processes, connections and
   * restarts at most one caller wins. Returns null when the occurrence is
   * already claimed/fired/released.
   */
  private claimOccurrence(
    scheduleId: string,
    dueAt: string,
    businessId: string | null,
  ): Record<string, unknown> | null {
    const occurrenceId = `OCC_${digest(`schedule-occurrence:${scheduleId}:${dueAt}`).slice(0, 24)}`;
    const row = {
      occurrence_id: occurrenceId,
      schedule_id: scheduleId,
      due_at: dueAt,
      business_id: businessId,
      status: "CLAIMED",
      mission_id: null,
      created_at: utcnow(),
      version: 0,
    };
    try {
      return this.store.put("schedule_occurrence", occurrenceId, row, 0);
    } catch (err) {
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") return null;
      throw err;
    }
  }

  /**
   * After the mission exists, bind it on the occurrence — FAIL CLOSED.
   * Returns only when the durable state is proven:
   *   A) this call persisted status=FIRED + mission_id, or
   *   B) another writer already persisted the SAME binding.
   * A binding to a DIFFERENT mission is an integrity violation; CAS
   * contention that cannot prove the binding is an explicit error —
   * never a silent return.
   */
  private bindOccurrenceMission(occurrenceId: string, missionId: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      const occ = this.store.get("schedule_occurrence", occurrenceId);
      if (occ.mission_id) {
        if (String(occ.mission_id) === missionId && occ.status === "FIRED") return;
        if (String(occ.mission_id) !== missionId) {
          throw new IntegrityError(
            "FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT",
            `${occurrenceId} already bound to ${String(occ.mission_id)} ≠ ${missionId}`,
          );
        }
        // same mission, status not yet FIRED — repair it below
      }
      occ.mission_id = missionId;
      occ.status = "FIRED";
      occ.fired_at = utcnow();
      try {
        this.store.put("schedule_occurrence", occurrenceId, occ, Number(occ.version));
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT") throw err;
      }
    }
    // Retries exhausted — the binding must be proven, not assumed.
    const final = this.store.get("schedule_occurrence", occurrenceId);
    if (String(final.mission_id ?? "") === missionId && final.status === "FIRED") return;
    if (final.mission_id && String(final.mission_id) !== missionId) {
      throw new IntegrityError(
        "FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT",
        `${occurrenceId} bound to ${String(final.mission_id)} ≠ ${missionId}`,
      );
    }
    throw new IntegrityError(
      "FAIL_CLOSED_OCCURRENCE_BIND_UNPROVEN",
      `${occurrenceId} binding to ${missionId} unproven after CAS retries`,
    );
  }

  /**
   * Bounded policy for a claim whose submit never completed: the occurrence
   * is RELEASED (dropped — the schedule row has already advanced, so this
   * slot is never retried automatically). Audited.
   */
  private releaseOccurrence(occurrenceId: string, cause: string): void {
    try {
      const occ = this.store.get("schedule_occurrence", occurrenceId);
      if (occ.mission_id || occ.status !== "CLAIMED") return;
      occ.status = "RELEASED";
      occ.released_at = utcnow();
      occ.release_cause = cause;
      this.store.put("schedule_occurrence", occurrenceId, occ, Number(occ.version));
      this.store.event({
        entity_type: "schedule_occurrence",
        entity_id: occurrenceId,
        event_type: "SCHEDULE_OCCURRENCE_RELEASED",
        new_state: "RELEASED",
        actor: "PAIR_MISSION_SCHEDULE",
        metadata: { cause },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT") throw err;
    }
  }

  /**
   * Restart-safe reconcile over all non-terminal occurrence states. A
   * durable mission carrying metadata.schedule_occurrence_id is canonical
   * evidence and wins over local state:
   *   CLAIMED + matching mission      → bind FIRED now (no TTL wait —
   *                                     the mission existence proves the
   *                                     claimant succeeded post-crash);
   *   CLAIMED + no mission + stale    → RELEASED (audited);
   *   CLAIMED + no mission + fresh    → skip (in flight);
   *   RELEASED + matching mission     → legacy/partial state — repair to
   *                                     FIRED + bound, audited;
   *   FIRED + same mission            → no-op;
   *   FIRED + different canonical one → audited integrity violation.
   * Called at the top of every fireDue (any process) so a crashed winner
   * never leaves a dangling claim or a detached canonical mission.
   */
  reconcileOccurrences(): void {
    const cutoff = Date.now() - OCCURRENCE_CLAIM_TTL_MS;
    const missions = this.store.list("mission");
    for (const occ of this.store.list("schedule_occurrence")) {
      const id = String(occ.occurrence_id);
      const status = String(occ.status);
      const claims = missions.filter(
        (m) => String((m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "") === id,
      );
      if (claims.length > 1) {
        // Multiple canonical missions claim one occurrence — never
        // silently pick one; audit and fail closed (no state change).
        this.store.event({
          entity_type: "schedule_occurrence",
          entity_id: id,
          event_type: "SCHEDULE_OCCURRENCE_INTEGRITY",
          new_state: status,
          actor: "PAIR_MISSION_SCHEDULE",
          metadata: {
            repair_reason: "multiple_missions_claim_occurrence",
            mission_ids: claims.map((m) => m.mission_id),
          },
        });
        continue;
      }
      const mission = claims[0];
      if (status === "FIRED") {
        if (mission && String(occ.mission_id ?? "") !== String(mission.mission_id)) {
          // The bound mission_id points at a different mission than the
          // canonical one claiming this occurrence — audited, not repaired.
          this.store.event({
            entity_type: "schedule_occurrence",
            entity_id: id,
            event_type: "SCHEDULE_OCCURRENCE_INTEGRITY",
            new_state: "FIRED",
            actor: "PAIR_MISSION_SCHEDULE",
            metadata: {
              bound_mission_id: occ.mission_id ?? null,
              canonical_mission_id: mission.mission_id,
            },
          });
        }
        continue;
      }
      if (mission) {
        // CLAIMED or legacy RELEASED with a canonical mission → repair to
        // FIRED + bound; the mission's existence is the decisive evidence.
        try {
          this.bindOccurrenceMission(id, String(mission.mission_id));
        } catch (err) {
          if ((err as { code?: string }).code !== "FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT") throw err;
          this.store.event({
            entity_type: "schedule_occurrence",
            entity_id: id,
            event_type: "SCHEDULE_OCCURRENCE_INTEGRITY",
            new_state: status,
            actor: "PAIR_MISSION_SCHEDULE",
            metadata: {
              bound_mission_id: occ.mission_id ?? null,
              canonical_mission_id: mission.mission_id,
              error: String((err as { message?: string })?.message ?? err),
            },
          });
          continue;
        }
        this.store.event({
          entity_type: "schedule_occurrence",
          entity_id: id,
          event_type: "SCHEDULE_OCCURRENCE_REPAIRED",
          old_state: status,
          new_state: "FIRED",
          actor: "PAIR_MISSION_SCHEDULE",
          metadata: { mission_id: mission.mission_id },
        });
        continue;
      }
      if (status !== "CLAIMED") continue; // RELEASED without mission — terminal
      const created = Date.parse(String(occ.created_at));
      if (!Number.isFinite(created) || created > cutoff) continue;
      this.releaseOccurrence(id, "stale_claim_no_mission");
    }
  }

  /**
   * Final restart-accounting closure: fold canonical evidence back into
   * the derived projections in one deterministic order —
   *   1. reconcileOccurrences()       (mission ↔ occurrence binding)
   *   2. reconcileScheduleReservations (budget HELD → CONSUMED/RELEASED)
   *   3. reconcileScheduleRows         (run_count / last_mission_id /
   *                                   last_fired_at / next_due_at)
   * Runs before any new fire is decided so no due() snapshot is computed
   * from stale accounting. Idempotent — N runs produce the same result.
   * Repairs accounting only; it never dispatches, never executes, and
   * never touches MissionControl.
   */
  reconcileScheduleAccounting(): void {
    this.reconcileOccurrences();
    this.reconcileScheduleReservations();
    this.reconcileScheduleRows();
  }

  /**
   * Settle schedule-related HELD budget reservations from canonical
   * evidence. Reservations created for a schedule fire carry
   * ref_id = `schedule-occurrence:<occurrence_id>` (R4 §8), so a
   * reservation for occurrence X can never settle Y's accounting:
   *   canonical mission exists for the occurrence → CONSUMED (exactly once);
   *   occurrence RELEASED + no mission                 → RELEASED;
   *   CLAIMED + no mission (in flight)                 → untouched (TTL);
   *   FIRED + no mission / missing occurrence / multi-claim → integrity,
   *   left HELD — fail closed, never guess.
   * Legacy pre-R4 `schedule:<id>` refs repair only when the schedule has
   * exactly one occurrence to attribute to; otherwise audited ambiguous.
   */
  private reconcileScheduleReservations(): void {
    const missions = this.store.list("mission");
    const claimsFor = (occurrenceId: string) =>
      missions.filter(
        (m) =>
          String(
            (m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "",
          ) === occurrenceId,
      );
    for (const r of this.store.list("budget_reservation")) {
      if (String(r.status) !== "HELD") continue;
      const ref = String(r.ref_id ?? "");
      if (!ref.startsWith("schedule")) continue; // open:* and other refs aren't ours
      const settle = (consumed: boolean, reason: string, extra: Record<string, unknown> = {}) => {
        r.status = consumed ? "CONSUMED" : "RELEASED";
        r.updated_at = utcnow();
        this.store.put("budget_reservation", String(r.reservation_id), r, Number(r.version));
        this.store.event({
          entity_type: "budget_reservation",
          entity_id: String(r.reservation_id),
          event_type: "BUDGET_RESERVATION_RECONCILED",
          new_state: String(r.status),
          actor: "PAIR_MISSION_SCHEDULE",
          metadata: {
            reservation_id: r.reservation_id,
            ref_id: ref,
            repair_reason: reason,
            ...extra,
          },
        });
      };
      const integrity = (reason: string, extra: Record<string, unknown> = {}) => {
        this.store.event({
          entity_type: "budget_reservation",
          entity_id: String(r.reservation_id),
          event_type: "BUDGET_RESERVATION_INTEGRITY",
          actor: "PAIR_MISSION_SCHEDULE",
          metadata: {
            reservation_id: r.reservation_id,
            ref_id: ref,
            repair_reason: reason,
            ...extra,
          },
        });
      };
      if (ref.startsWith("schedule-occurrence:")) {
        const occurrenceId = ref.slice("schedule-occurrence:".length);
        const claims = claimsFor(occurrenceId);
        if (claims.length > 1) {
          integrity("multiple_missions_claim_occurrence", { occurrence_id: occurrenceId });
          continue;
        }
        if (claims.length === 1) {
          settle(true, "mission_exists", {
            occurrence_id: occurrenceId,
            mission_id: claims[0].mission_id,
          });
          continue;
        }
        const occ = this.store.tryGet("schedule_occurrence", occurrenceId);
        if (!occ) {
          integrity("missing_occurrence", { occurrence_id: occurrenceId });
          continue;
        }
        if (String(occ.status) === "RELEASED") {
          settle(false, "occurrence_released", { occurrence_id: occurrenceId });
          continue;
        }
        if (String(occ.status) === "FIRED") {
          integrity("fired_occurrence_without_mission", { occurrence_id: occurrenceId });
          continue;
        }
        continue; // CLAIMED + no mission — claimant still inside its TTL
      }
      // Legacy `schedule:<id>` ref (pre-R4): attribute only when the
      // schedule has exactly one occurrence — anything else is ambiguous.
      const scheduleId = ref.slice("schedule:".length);
      const candidates = this.store
        .list("schedule_occurrence")
        .filter((o) => String(o.schedule_id) === scheduleId);
      if (candidates.length !== 1) {
        integrity("legacy_ref_ambiguous", {
          schedule_id: scheduleId,
          occurrences: candidates.length,
        });
        continue;
      }
      const occ = candidates[0];
      const occurrenceId = String(occ.occurrence_id);
      const claims = claimsFor(occurrenceId);
      if (claims.length === 1) {
        settle(true, "legacy_ref_mission_exists", {
          schedule_id: scheduleId,
          occurrence_id: occurrenceId,
          mission_id: claims[0].mission_id,
        });
      } else if (claims.length > 1) {
        integrity("legacy_ref_multi_claim", { schedule_id: scheduleId, occurrence_id: occurrenceId });
      } else if (String(occ.status) === "RELEASED") {
        settle(false, "legacy_ref_occurrence_released", {
          schedule_id: scheduleId,
          occurrence_id: occurrenceId,
        });
      } else {
        integrity("legacy_ref_unresolved", { schedule_id: scheduleId, occurrence_id: occurrenceId });
      }
    }
  }

  /**
   * Project canonical occurrence/mission evidence back into the
   * mission_schedule accounting row. Derived state only — the canonical
   * truth order is (1) mission existence, (2) occurrence binding,
   * (3) this schedule row, (4) budget reservation.
   *
   * For every valid FIRED occurrence the bound mission must exist AND
   * canonically claim this occurrence (metadata.schedule_occurrence_id
   * === occurrence_id, metadata.schedule_id === occurrence.schedule_id,
   * metadata.scheduled_for === occurrence.due_at), and exactly one
   * mission may claim it. Any conflict taints the whole schedule: an
   * audited SCHEDULE_ACCOUNTING_INTEGRITY event is emitted and the
   * schedule row is left untouched — no best-effort guessing.
   *
   * run_count is DERIVED, never incremented blindly: it becomes the
   * number of valid FIRED occurrences plus legacy schedule missions that
   * predate occurrence claims (metadata.schedule_id set, no
   * schedule_occurrence_id). With zero derivable evidence the stored
   * count is left alone (a pre-R2 run_count can't be proven wrong).
   * last_mission_id / last_fired_at come from the latest FIRED
   * occurrence (fired_at; falls back to the mission's created_at when no
   * canonical fire timestamp exists — documented fallback).
   * next_due_at only advances: when it still names an already-fired
   * occurrence it moves to nextRunAfter(cron, latestFired.due_at);
   * anything already past that belongs to fireDue's normal advance.
   */
  private reconcileScheduleRows(): void {
    const missions = this.store.list("mission");
    const occurrences = this.store.list("schedule_occurrence");
    const claimsByOccurrence = new Map<string, Array<Record<string, unknown>>>();
    for (const m of missions) {
      const oid = String(
        (m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "",
      );
      if (!oid) continue;
      const list = claimsByOccurrence.get(oid) ?? [];
      list.push(m);
      claimsByOccurrence.set(oid, list);
    }
    const tainted = new Set<string>();
    const validFired = new Map<string, Array<Record<string, unknown>>>();
    const integrity = (
      entityType: string,
      entityId: string,
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      this.store.event({
        entity_type: entityType,
        entity_id: entityId,
        event_type: "SCHEDULE_ACCOUNTING_INTEGRITY",
        actor: "PAIR_MISSION_SCHEDULE",
        metadata: { repair_reason: reason, ...extra },
      });
    };
    const taint = (scheduleId: string, entityId: string, reason: string, extra = {}) => {
      tainted.add(scheduleId);
      integrity("schedule_occurrence", entityId, reason, { schedule_id: scheduleId, ...extra });
    };
    for (const occ of occurrences) {
      const oid = String(occ.occurrence_id);
      const scheduleId = String(occ.schedule_id);
      const claims = claimsByOccurrence.get(oid) ?? [];
      if (claims.length > 1) {
        taint(scheduleId, oid, "multiple_missions_claim_occurrence", {
          mission_ids: claims.map((m) => m.mission_id),
        });
        continue;
      }
      if (String(occ.status) !== "FIRED") {
        if (claims.length === 1) {
          // A mission claims an occurrence that did not fire — after
          // reconcileOccurrences this only survives a binding conflict.
          taint(scheduleId, oid, "mission_claims_unfired_occurrence", {
            occurrence_status: occ.status,
            mission_id: claims[0].mission_id,
          });
        }
        continue;
      }
      const boundId = String(occ.mission_id ?? "");
      if (!boundId) {
        taint(scheduleId, oid, "fired_occurrence_unbound");
        continue;
      }
      const bound = this.store.tryGet("mission", boundId);
      if (!bound) {
        taint(scheduleId, oid, "fired_occurrence_missing_mission", {
          mission_id: boundId,
        });
        continue;
      }
      if (claims.length === 0) {
        taint(scheduleId, oid, "bound_mission_does_not_claim", { mission_id: boundId });
        continue;
      }
      const claimant = claims[0];
      if (String(claimant.mission_id) !== boundId) {
        taint(scheduleId, oid, "bound_mission_not_canonical", {
          mission_id: boundId,
          canonical_mission_id: claimant.mission_id,
        });
        continue;
      }
      const mmd = claimant.metadata as Record<string, unknown> | undefined;
      if (String(mmd?.schedule_id ?? "") !== scheduleId) {
        taint(scheduleId, oid, "mission_claims_wrong_schedule", {
          mission_id: boundId,
          mission_schedule_id: mmd?.schedule_id ?? null,
        });
        continue;
      }
      if (String(mmd?.scheduled_for ?? "") !== String(occ.due_at)) {
        taint(scheduleId, oid, "scheduled_for_mismatch", {
          mission_id: boundId,
          scheduled_for: mmd?.scheduled_for ?? null,
          due_at: occ.due_at,
        });
        continue;
      }
      const list = validFired.get(scheduleId) ?? [];
      list.push(occ);
      validFired.set(scheduleId, list);
    }
    // Reverse check: a mission claiming an occurrence row that does not
    // exist at all is conflicting evidence too.
    for (const [oid, claims] of claimsByOccurrence) {
      if (occurrences.some((o) => String(o.occurrence_id) === oid)) continue;
      for (const m of claims) {
        const mmd = m.metadata as Record<string, unknown> | undefined;
        const scheduleId = String(mmd?.schedule_id ?? "");
        if (scheduleId) tainted.add(scheduleId);
        integrity("mission", String(m.mission_id), "mission_claims_missing_occurrence", {
          schedule_id: scheduleId || null,
          occurrence_id: oid,
        });
      }
    }
    for (const scheduleId of new Set([...validFired.keys(), ...tainted])) {
      if (tainted.has(scheduleId)) continue; // conflicting evidence — no repair
      const fired = [...(validFired.get(scheduleId) ?? [])].sort((a, b) =>
        String(b.due_at).localeCompare(String(a.due_at)),
      );
      const row = this.store.tryGet("mission_schedule", scheduleId);
      if (!row) {
        integrity("mission_schedule", scheduleId, "fired_occurrence_missing_schedule", {
          occurrence_ids: fired.map((o) => o.occurrence_id),
        });
        continue;
      }
      if (fired.length === 0) continue;
      const latest = fired[0];
      const latestMissionId = String(latest.mission_id);
      const latestMission = this.store.tryGet("mission", latestMissionId);
      // Canonical fire timestamp: the occurrence's own fired_at; fall back
      // to the mission's created_at when no fire timestamp exists
      // (documented — never the restart's wall clock).
      const latestFiredAt = String(
        latest.fired_at ?? latestMission?.created_at ?? latest.due_at,
      );
      // Legacy fires (pre-occurrence era) have metadata.schedule_id but no
      // schedule_occurrence_id — they count once each alongside valid
      // FIRED occurrences.
      const legacyCount = missions.filter((m) => {
        const mmd = m.metadata as Record<string, unknown> | undefined;
        return (
          String(mmd?.schedule_id ?? "") === scheduleId &&
          !mmd?.schedule_occurrence_id
        );
      }).length;
      const derivedRunCount = fired.length + legacyCount;
      const desiredNextDue =
        String(row.next_due_at) <= String(latest.due_at)
          ? nextRunAfter(String(row.cron), String(latest.due_at))
          : String(row.next_due_at);
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      if (Number(row.run_count ?? 0) !== derivedRunCount) {
        changes.run_count = { old: row.run_count ?? 0, new: derivedRunCount };
      }
      if (String(row.last_mission_id ?? "") !== latestMissionId) {
        changes.last_mission_id = { old: row.last_mission_id ?? null, new: latestMissionId };
      }
      if (String(row.last_fired_at ?? "") !== latestFiredAt) {
        changes.last_fired_at = { old: row.last_fired_at ?? null, new: latestFiredAt };
      }
      if (String(row.next_due_at) !== desiredNextDue) {
        changes.next_due_at = { old: row.next_due_at, new: desiredNextDue };
      }
      if (Object.keys(changes).length === 0) continue; // idempotent no-op
      let applied = false;
      for (let attempt = 0; attempt < 3 && !applied; attempt++) {
        const fresh = this.store.get("mission_schedule", scheduleId);
        fresh.run_count = derivedRunCount;
        fresh.last_mission_id = latestMissionId;
        fresh.last_fired_at = latestFiredAt;
        fresh.next_due_at = desiredNextDue;
        try {
          this.store.put("mission_schedule", scheduleId, fresh, Number(fresh.version));
          applied = true;
        } catch (err) {
          if ((err as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT") throw err;
        }
      }
      if (!applied) {
        integrity("mission_schedule", scheduleId, "accounting_write_unproven", {
          occurrence_id: latest.occurrence_id,
        });
        continue;
      }
      this.store.event({
        entity_type: "mission_schedule",
        entity_id: scheduleId,
        event_type: "SCHEDULE_ACCOUNTING_RECONCILED",
        actor: "PAIR_MISSION_SCHEDULE",
        metadata: {
          schedule_id: scheduleId,
          occurrence_id: latest.occurrence_id,
          mission_id: latestMissionId,
          changes,
          repair_reason: "canonical_occurrence_mission_evidence",
        },
      });
    }
  }

  /**
   * Fire every due schedule through the injected canonical submit path.
   * Each schedule advances its own next_due_at regardless of submit outcome,
   * so a failing schedule cannot hot-loop every tick. Returns fired mission ids.
   */
  fireDue(
    submit: (input: {
      goal: string;
      project_id?: string;
      operator_id?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<Record<string, unknown>> | Record<string, unknown>,
    now = utcnow(),
  ): Promise<{ fired: string[]; errors: string[] }> {
    return this._fireDue(submit, now);
  }

  private async _fireDue(
    submit: (input: {
      goal: string;
      project_id?: string;
      operator_id?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<Record<string, unknown>> | Record<string, unknown>,
    now: string,
  ): Promise<{ fired: string[]; errors: string[] }> {
    const fired: string[] = [];
    const errors: string[] = [];
    // All canonical-evidence reconciliation completes before any due()
    // snapshot is taken — no new fire is ever decided from stale
    // accounting (R4 §9).
    this.reconcileScheduleAccounting();
    for (const s of this.due(now)) {
      const id = String(s.schedule_id);
      const snapshotDueAt = String(s.next_due_at);
      const row = this.store.get("mission_schedule", id);
      // Stale-snapshot pin: the snapshot must still name the SAME due
      // occurrence — if another process already advanced this schedule, the
      // fresh next_due_at is a different occurrence we were never due to
      // fire. Skip entirely: no claim, no budget, no mission, no mutation.
      if (
        String(row.next_due_at) !== snapshotDueAt ||
        String(row.next_due_at) > now ||
        row.enabled !== true ||
        row.deleted
      ) {
        continue;
      }
      // Exactly-once gate: claim this specific occurrence (schedule_id +
      // due_at) via CAS before any preflight/submit — a losing process must
      // never reserve budget or create a mission for it.
      const dueAt = snapshotDueAt;
      const occ = this.claimOccurrence(id, dueAt, md_businessId(s));
      let token: { settle: (consumed: boolean) => void } | null = null;
      if (occ) {
        const occurrenceId = String(occ.occurrence_id);
        try {
          // Schedule metadata (e.g. routine business_id/department/assignee)
          // propagates into the mission so projection, budgets and audit can
          // attribute the fire to its business scope.
          const metadata = {
            ...((s.metadata as Record<string, unknown> | undefined) ?? {}),
            plan_source: "schedule",
            schedule_id: id,
            schedule_occurrence_id: occurrenceId,
            scheduled_for: dueAt,
            schedule_digest: digest({ goal: s.goal, cron: s.cron, schedule_id: id }),
          };
          token = this.preflight?.({
            goal: String(s.goal),
            project_id: s.project_id,
            operator_id: s.operator_id,
            metadata,
          }) ?? null;
          const mission = await submit({
            goal: String(s.goal),
            project_id: s.project_id ? String(s.project_id) : undefined,
            operator_id: String(s.operator_id),
            metadata,
          });
          token?.settle(true);
          this.bindOccurrenceMission(occurrenceId, String(mission.mission_id));
          // last_fired_at mirrors the occurrence's canonical fired_at so
          // restart reconcile derives a zero-diff on a healthy row.
          row.last_fired_at = String(
            this.store.get("schedule_occurrence", occurrenceId).fired_at ?? now,
          );
          row.last_mission_id = String(mission.mission_id);
          row.last_error = null;
          row.run_count = Number(row.run_count ?? 0) + 1;
          fired.push(id);
          this.store.event({
            entity_type: "mission_schedule",
            entity_id: id,
            event_type: "SCHEDULE_FIRED",
            new_state: "FIRED",
            actor: "PAIR_MISSION_SCHEDULE",
            correlation_id: String(mission.mission_id),
            metadata: {
              mission_id: mission.mission_id,
              occurrence_id: occurrenceId,
              scheduled_for: dueAt,
            },
          });
        } catch (err) {
          // Canonical mission existence wins over local exception semantics:
          // the submit path can throw AFTER the mission row was created
          // (runtimeEntity/wake inside startMission) — never release an
          // occurrence whose mission exists, and never retry into a second.
          const claimsHere = this.store
            .list("mission")
            .filter(
              (m) =>
                String(
                  (m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "",
                ) === occurrenceId,
            );
          const bound = claimsHere.length === 1 ? claimsHere[0] : undefined;
          if (claimsHere.length > 1) {
            // Conflicting canonical evidence — audit and fail closed
            // (occurrence left CLAIMED; reconcile flags the schedule).
            this.store.event({
              entity_type: "schedule_occurrence",
              entity_id: occurrenceId,
              event_type: "SCHEDULE_OCCURRENCE_INTEGRITY",
              new_state: "CLAIMED",
              actor: "PAIR_MISSION_SCHEDULE",
              metadata: {
                repair_reason: "multiple_missions_claim_occurrence",
                mission_ids: claimsHere.map((m) => m.mission_id),
              },
            });
            token?.settle(false);
            row.last_error = String((err as { message?: string })?.message ?? err);
            errors.push(id);
          } else if (bound) {
            token?.settle(true);
            this.bindOccurrenceMission(occurrenceId, String(bound.mission_id));
            row.last_fired_at = String(
              this.store.get("schedule_occurrence", occurrenceId).fired_at ?? now,
            );
            row.last_mission_id = String(bound.mission_id);
            row.last_error = String((err as { message?: string })?.message ?? err);
            row.run_count = Number(row.run_count ?? 0) + 1;
            fired.push(id);
            this.store.event({
              entity_type: "mission_schedule",
              entity_id: id,
              event_type: "SCHEDULE_FIRED",
              new_state: "FIRED",
              actor: "PAIR_MISSION_SCHEDULE",
              correlation_id: String(bound.mission_id),
              metadata: {
                mission_id: bound.mission_id,
                occurrence_id: occurrenceId,
                scheduled_for: dueAt,
                reconciled: "post_create_exception",
                submit_error: String((err as { message?: string })?.message ?? err),
              },
            });
          } else {
            token?.settle(false);
            this.releaseOccurrence(occurrenceId, "submit_failed");
            row.last_error = String((err as { message?: string })?.message ?? err);
            errors.push(id);
          }
        }
      }
      row.next_due_at = nextRunAfter(String(s.cron), now);
      try {
        this.store.put("mission_schedule", id, row, Number(row.version));
      } catch (err) {
        // Another process advanced this schedule — refresh and record our
        // result under the new version so the fire outcome is not lost.
        if ((err as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT") throw err;
        const fresh = this.store.get("mission_schedule", id);
        fresh.last_fired_at = row.last_fired_at;
        if (row.last_mission_id) fresh.last_mission_id = row.last_mission_id;
        if (row.last_error) fresh.last_error = row.last_error;
        // run_count is monotonic — a losing writer must never roll it back
        // (a local 0 is not nullish, so ?? cannot merge here).
        fresh.run_count = Math.max(
          Number(row.run_count ?? 0),
          Number(fresh.run_count ?? 0),
        );
        this.store.put("mission_schedule", id, fresh, Number(fresh.version));
      }
    }
    return { fired, errors };
  }
}
