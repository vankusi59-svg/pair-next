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

export const SCHEDULE_SCHEMA = "pair.os.vnext.mission-schedule.v1";

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
    for (const s of this.due(now)) {
      const id = String(s.schedule_id);
      const row = this.store.get("mission_schedule", id);
      row.last_fired_at = now;
      let token: { settle: (consumed: boolean) => void } | null = null;
      try {
        // Schedule metadata (e.g. routine business_id/department/assignee)
        // propagates into the mission so projection, budgets and audit can
        // attribute the fire to its business scope.
        const metadata = {
          ...((s.metadata as Record<string, unknown> | undefined) ?? {}),
          plan_source: "schedule",
          schedule_id: id,
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
          metadata: { mission_id: mission.mission_id },
        });
      } catch (err) {
        token?.settle(false);
        row.last_error = String((err as { message?: string })?.message ?? err);
        errors.push(id);
      }
      row.next_due_at = nextRunAfter(String(s.cron), now);
      this.store.put("mission_schedule", id, row, Number(row.version));
    }
    return { fired, errors };
  }
}
