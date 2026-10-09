import { digest, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import {
  ObjectiveAutoScheduler,
  SCHEDULER_CURSOR,
  SCHEDULER_PROGRESS,
  WAKE_STATE,
  readSchedulerRow,
  writeSchedulerRow,
} from "./objective-auto-scheduler.js";
import { AUTO_POLICY_ENTITY } from "./objective-auto-policy.js";
import {
  WORKFORCE_ALLOCATION_ENTITY,
  assertCanonicalWorkforceAllocationProvenance,
} from "./workforce-allocation-evidence.js";
import { validateWorkOpenBindingById } from "./work-open-binding.js";

const GLOBAL = "LOCAL_PAIR_DB";
const EVENT_PAGE = 128;
const ENTITY_PAGE = 64;
const FANOUT_LIMIT = 64;

type Row = Record<string, unknown> & { version: number };
type WakeTarget = { objective_id: string; reason: string; source_scope: string };
type TickResult = { processed: number; skipped: number; blocked: number };

/** Versioned input-topic whitelist. Scheduler-owned commit/checkpoint events
 * are deliberately absent so intake cannot chase its own tail forever. */
export const OBJECTIVE_WAKE_INPUT_TOPICS = [
  "OBJECTIVE_CREATED", "OBJECTIVE_STATUS", "OBJECTIVE_AMENDED",
  "OBJECTIVE_PROGRESS", "OBJECTIVE_EVIDENCE_ATTACHED", "OBJECTIVE_BUDGET_ACCOUNTED",
  "OBJECTIVE_AUTO_POLICY_CONFIGURE", "OBJECTIVE_AUTO_POLICY_ENABLE",
  "OBJECTIVE_AUTO_POLICY_PAUSE", "OBJECTIVE_AUTO_POLICY_RESUME",
  "OBJECTIVE_AUTO_POLICY_DISABLE", "OBJECTIVE_AUTO_POLICY_REVOKE",
  "OBJECTIVE_AUTO_POLICY_HALT", "OBJECTIVE_AUTO_POLICY_RESET_HALT",
  "OBJECTIVE_AUTO_POLICY_EXPIRE",
  "MISSION_TRANSITION", "WORK_ITEM_STATUS_SYNCED", "WORK_ITEM_OPEN_RECONCILED",
  "WORK_ITEM_CANCELLED", "WORK_ITEM_UNBLOCKED", "WORK_REVIEW_ACCEPTED",
  "WORK_REWORK_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_DENIED",
  "APPROVAL_SUPERSEDED", "APPROVAL_EXPIRED", "APPROVAL_EXERCISED",
  "OBJECTIVE_ADAPTIVE_REVIEW_COMMITTED", "OBJECTIVE_STRATEGY_REVISION_COMMITTED",
  "ORG_AGENT_STATUS", "AGENT_EXECUTION_CONTRACT_ENABLED",
  "AGENT_EXECUTION_CONTRACT_DISABLED", "AGENT_EXECUTION_CONTRACT_UPDATED",
  "WORK_CLAIM_RELEASED",
] as const;

function invalid(reason: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_WAKEUP", reason);
}

function fields(row: Row): Row {
  const { version, entity_type: _type, entity_id: _id, ...rest } = row;
  return { ...rest, version };
}

/** Durable canonical wake intake plus bounded fallback reconciliation.
 * Production behavior is only discover/checkpoint/reconcile; this class
 * deliberately has no consumer/runner seam and never claims a wake. */
export class ObjectiveAutoWakeupService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly scheduler: ObjectiveAutoScheduler,
    private readonly now: () => number = Date.now,
  ) {}

  private proof<T>(fn: () => T): T {
    return this.store.withReadBudget({ entities: 1024, events: 512 },
      () => this.store.immediate(fn));
  }

  private ensureCursor(): Row {
    const existing = readSchedulerRow<Row>(this.store, SCHEDULER_CURSOR, GLOBAL);
    if (existing) {
      if (existing.input_filter_digest !== digest(OBJECTIVE_WAKE_INPUT_TOPICS)) {
        invalid("input stream/version changed without migration");
      }
      return existing;
    }
    return writeSchedulerRow<Row>(this.store, SCHEDULER_CURSOR, GLOBAL, {
      health: "READY", input_filter_digest: digest(OBJECTIVE_WAKE_INPUT_TOPICS),
      last_seq: 0, last_event_id: null, last_event_hash: null,
      processed_total: 0, skipped_total: 0, blocked_total: 0,
      updated_at: utcnow(), last_error: null,
    }, "CURSOR_GENESIS", "genesis");
  }

  private ensureProgress(): Row {
    const existing = readSchedulerRow<Row>(this.store, SCHEDULER_PROGRESS, GLOBAL);
    if (existing) return existing;
    return writeSchedulerRow<Row>(this.store, SCHEDULER_PROGRESS, GLOBAL, {
      health: "READY", sweep: 1, sweep_after_id: "", due_after_id: "",
      processed_total: 0, skipped_total: 0,
      last_completed_sweep_at: null, last_tick_at: null, last_error: null,
    }, "RECONCILE_GENESIS", "genesis");
  }

  markDegraded(error: unknown): void {
    try {
      this.store.immediate(() => {
        const cursor = this.ensureCursor();
        writeSchedulerRow(this.store, SCHEDULER_CURSOR, GLOBAL, {
          ...fields(cursor), health: "DEGRADED",
          last_error: String(error instanceof Error ? error.message : error).slice(0, 512),
          updated_at: utcnow(),
        }, "DEGRADED", String(this.now()));
      });
    } catch {
      // A corrupted cursor/store is already fail-closed; never mask it.
    }
  }

  private objectiveFromPolicyEvent(ev: Row): WakeTarget[] {
    const entityId = String(ev.entity_id ?? "");
    const objectiveId = entityId.startsWith("oap:") ? entityId.slice(4) : "";
    const correlation = String(ev.correlation_id ?? "");
    if (!objectiveId || correlation !== objectiveId) return [];
    const action = String((ev.metadata as Record<string, unknown> | null)?.action ?? "TRANSITION");
    return [{ objective_id: objectiveId, reason: "POLICY_" + action.toUpperCase(),
      source_scope: "auto_policy:" + entityId }];
  }

  private allocationTargets(workItemId: string, reason: string, scope: string): WakeTarget[] {
    const targets: WakeTarget[] = [];
    let after = "";
    for (;;) {
      const page = this.store.entityPage<Row>({
        entity_type: WORKFORCE_ALLOCATION_ENTITY, after_id: after, limit: ENTITY_PAGE,
      });
      for (const row of page) {
        if (String(row.delegated_child_work_item_id) !== workItemId &&
            String(row.workstream_work_item_id) !== workItemId) continue;
        assertCanonicalWorkforceAllocationProvenance(this.store, row);
        targets.push({ objective_id: String(row.objective_id), reason,
          source_scope: scope + "->allocation:" + String(row.allocation_id) });
        if (targets.length > FANOUT_LIMIT) invalid("wake fanout limit");
      }
      if (page.length < ENTITY_PAGE) return targets;
      after = String(page[page.length - 1]!.entity_id);
    }
  }

  private missionTargets(missionId: string, reason: string): WakeTarget[] {
    const mission = this.store.tryGet("mission", missionId) as Row | null;
    const openId = String(mission?.bound_open_id ?? "");
    if (!mission || !openId) return [];
    const bound = validateWorkOpenBindingById(this.store, openId, {
      forMission: mission, requireState: "BOUND", mode: "PROVENANCE",
    });
    if (!bound.ok || !bound.binding) return [];
    return this.allocationTargets(String(bound.binding.work_item_id), reason,
      "mission:" + missionId + "->open:" + openId);
  }

  private approvalTargets(ev: Row): WakeTarget[] {
    const row = this.store.tryGet("approval_request", String(ev.entity_id)) as Row | null;
    const meta = ev.metadata as Record<string, unknown> | null;
    const missionId = String(row?.mission_id ?? meta?.mission_id ?? "");
    return missionId
      ? this.missionTargets(missionId, "APPROVAL_" + String(ev.event_type).replace(/^APPROVAL_/, ""))
      : [];
  }

  private agentTargets(ev: Row): WakeTarget[] {
    let agentId = String(ev.entity_id);
    if (String(ev.entity_type) !== "org_agent") {
      const contract = this.store.tryGet(String(ev.entity_type), agentId) as Row | null;
      agentId = String(contract?.org_agent_id ?? "");
    }
    if (!agentId) return [];
    const targets: WakeTarget[] = [];
    let after = "";
    for (;;) {
      const page = this.store.entityPage<Row>({
        entity_type: WORKFORCE_ALLOCATION_ENTITY, after_id: after, limit: ENTITY_PAGE,
      });
      for (const row of page) {
        if (String(row.selected_agent_id) !== agentId) continue;
        assertCanonicalWorkforceAllocationProvenance(this.store, row);
        targets.push({ objective_id: String(row.objective_id), reason: "AGENT_" + String(ev.event_type),
          source_scope: "agent:" + agentId + "->allocation:" + String(row.allocation_id) });
        if (targets.length > FANOUT_LIMIT) invalid("wake fanout limit");
      }
      if (page.length < ENTITY_PAGE) return targets;
      after = String(page[page.length - 1]!.entity_id);
    }
  }

  private resolve(ev: Row): WakeTarget[] {
    const type = String(ev.event_type ?? "");
    if (String(ev.entity_type) === AUTO_POLICY_ENTITY) return this.objectiveFromPolicyEvent(ev);
    if (String(ev.entity_type) === "objective") {
      return [{ objective_id: String(ev.entity_id), reason: "OBJECTIVE_" + type.replace(/^OBJECTIVE_/, ""),
        source_scope: "objective:" + String(ev.entity_id) }];
    }
    if (String(ev.entity_type) === "mission" && type === "MISSION_TRANSITION") {
      return this.missionTargets(String(ev.entity_id), "MISSION_" + String(ev.new_state ?? "CHANGED"));
    }
    if (String(ev.entity_type) === "work_item") {
      return this.allocationTargets(String(ev.entity_id), "WORK_" + type, "work_item:" + String(ev.entity_id));
    }
    if (String(ev.entity_type) === "approval_request" || String(ev.entity_type) === "approval_exercise") {
      return this.approvalTargets(ev);
    }
    if (String(ev.entity_type) === "objective_adaptive_review") {
      const row = this.store.tryGet(String(ev.entity_type), String(ev.entity_id)) as Row | null;
      const objectiveId = String(row?.objective_id ?? "");
      return objectiveId ? [{ objective_id: objectiveId, reason: "REVIEW_" + type,
        source_scope: "adaptive_review:" + String(ev.entity_id) }] : [];
    }
    if (String(ev.entity_type) === "org_agent" || String(ev.entity_type).includes("contract")) {
      return this.agentTargets(ev);
    }
    return [];
  }

  private writeCursor(cursor: Row, last: Row | null, result: TickResult): Row {
    return writeSchedulerRow<Row>(this.store, SCHEDULER_CURSOR, GLOBAL, {
      ...fields(cursor), health: "READY",
      last_seq: last ? Number(last.seq) : Number(cursor.last_seq),
      last_event_id: last ? String(last.event_id) : cursor.last_event_id,
      last_event_hash: last ? String(last.event_hash) : cursor.last_event_hash,
      processed_total: Number(cursor.processed_total) + result.processed,
      skipped_total: Number(cursor.skipped_total) + result.skipped,
      blocked_total: Number(cursor.blocked_total) + result.blocked,
      updated_at: utcnow(), last_error: null,
    }, "INTAKE", last ? String(last.event_id) : "idle");
  }

  /** One bounded canonical event page. Cursor and all wake/skip effects in
   * the page commit together; a failure before COMMIT leaves the page replayable. */
  intakePage(): TickResult {
    return this.proof(() => {
      let cursor = this.ensureCursor();
      const events = this.store.eventPage({
        after_seq: Number(cursor.last_seq), limit: EVENT_PAGE,
        topics: OBJECTIVE_WAKE_INPUT_TOPICS,
      }) as Row[];
      const result: TickResult = { processed: 0, skipped: 0, blocked: 0 };
      let last: Row | null = null;
      for (const ev of events) {
        let targets: WakeTarget[];
        try {
          targets = this.resolve(ev);
        } catch (e) {
          if (e instanceof NotFoundError || e instanceof IntegrityError) {
            result.blocked++;
            last = ev;
            continue;
          }
          throw e;
        }
        if (!targets.length) {
          result.skipped++;
          last = ev;
          continue;
        }
        for (const target of targets) {
          try {
            this.scheduler.accountWake({
              objective_id: target.objective_id,
              source_event_id: String(ev.event_id),
              reason: target.reason,
              source_scope: target.source_scope,
            });
            result.processed++;
          } catch (e) {
            result.blocked++;
            try { this.scheduler.quarantine(target.objective_id, String(e)); } catch { /* keep blocked */ }
          }
        }
        last = ev;
      }
      if (last) cursor = this.writeCursor(cursor, last, result);
      return result;
    });
  }

  /** Bounded canonical fallback for missed hooks: one page of configured
   * policies per call. Progress is durable, so restart resumes rather than
   * restarting at the first policy every time. */
  reconcilePage(): { scanned: number; skipped: number; complete: boolean } {
    return this.proof(() => {
      const progress = this.ensureProgress();
      const page = this.store.entityPage<Row>({
        entity_type: AUTO_POLICY_ENTITY,
        after_id: String(progress.sweep_after_id ?? ""), limit: ENTITY_PAGE,
      });
      let skipped = 0;
      for (const row of page) {
        const objectiveId = String(row.objective_id ?? "");
        try { this.scheduler.observe(objectiveId, "STARTUP_RECONCILE"); }
        catch { skipped++; }
      }
      const complete = page.length < ENTITY_PAGE;
      writeSchedulerRow(this.store, SCHEDULER_PROGRESS, GLOBAL, {
        ...fields(progress), health: "READY",
        sweep_after_id: complete ? "" : String(page[page.length - 1]!.entity_id),
        sweep: complete ? Number(progress.sweep) + 1 : Number(progress.sweep),
        processed_total: Number(progress.processed_total) + page.length - skipped,
        skipped_total: Number(progress.skipped_total) + skipped,
        last_completed_sweep_at: complete ? utcnow() : progress.last_completed_sweep_at,
        last_tick_at: utcnow(), last_error: null,
      }, complete ? "SWEEP_COMPLETE" : "SWEEP_PAGE", String(progress.sweep));
      return { scanned: page.length, skipped, complete };
    });
  }

  /** One due-state page plus bounded stale lease reap. No claims and no
   * drain-as-executed: due hints only become durable WAITING_CONSUMER hints. */
  duePage(): { scanned: number; expired_leases: number } {
    return this.proof(() => {
      const progress = this.ensureProgress();
      const page = this.store.entityPage<Row>({
        entity_type: WAKE_STATE, after_id: String(progress.due_after_id ?? ""),
        limit: ENTITY_PAGE,
      });
      for (const row of page) this.scheduler.markDue(String(row.entity_id));
      const leases = this.scheduler.reconcileLeases(ENTITY_PAGE);
      const complete = page.length < ENTITY_PAGE;
      writeSchedulerRow(this.store, SCHEDULER_PROGRESS, GLOBAL, {
        ...fields(progress), due_after_id: complete ? "" : String(page[page.length - 1]!.entity_id),
        last_tick_at: utcnow(),
      }, "DUE_PAGE", String(this.now()));
      return { scanned: page.length, expired_leases: leases.expired };
    });
  }

  tick(): { intake: TickResult; reconcile: { scanned: number; skipped: number; complete: boolean };
    due: { scanned: number; expired_leases: number } } {
    const intake = this.intakePage();
    const reconcile = this.reconcilePage();
    const due = this.duePage();
    return { intake, reconcile, due };
  }
}

/** Minimal existing-runtime lifecycle wrapper. The interval only calls the
 * bounded reconcile path; no consumer, no claim loop, no overlap inside one
 * process. Cross-process correctness remains CAS/canonical receipts. */
export class ObjectiveAutoReconcileRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inTick = false;
  lastError: string | null = null;

  constructor(
    private readonly wakeup: ObjectiveAutoWakeupService,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private safeTick(): void {
    if (this.inTick) return;
    this.inTick = true;
    try {
      this.wakeup.tick();
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e).slice(0, 512);
      this.wakeup.markDegraded(e);
    } finally {
      this.inTick = false;
    }
  }
}

export function createObjectiveAutoReconcile(deps: {
  store: PairEvidenceStore;
  objectives: ConstructorParameters<typeof ObjectiveAutoScheduler>[1];
  policy: ConstructorParameters<typeof ObjectiveAutoScheduler>[2];
  now?: () => number;
  intervalMs?: number;
}): {
  scheduler: ObjectiveAutoScheduler;
  wakeup: ObjectiveAutoWakeupService;
  runtime: ObjectiveAutoReconcileRuntime;
} {
  const scheduler = new ObjectiveAutoScheduler(
    deps.store, deps.objectives, deps.policy, deps.now);
  const wakeup = new ObjectiveAutoWakeupService(deps.store, scheduler, deps.now);
  const runtime = new ObjectiveAutoReconcileRuntime(wakeup, deps.intervalMs);
  return { scheduler, wakeup, runtime };
}
