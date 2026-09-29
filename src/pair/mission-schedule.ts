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
      const mission = missions.find(
        (m) => String((m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "") === id,
      );
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
    this.reconcileOccurrences();
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
          row.last_fired_at = now;
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
          const bound = this.store
            .list("mission")
            .find(
              (m) =>
                String(
                  (m.metadata as Record<string, unknown> | undefined)?.schedule_occurrence_id ?? "",
                ) === occurrenceId,
            );
          if (bound) {
            token?.settle(true);
            this.bindOccurrenceMission(occurrenceId, String(bound.mission_id));
            row.last_fired_at = now;
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
