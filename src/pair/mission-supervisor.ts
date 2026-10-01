/**
 * P9 MissionSupervisor — wake-driven mission orchestration across missions.
 *
 * The supervisor owns the wake surface: every reason a mission should be
 * re-examined is persisted (`supervisor_wake`) and the tick() loop drives each
 * non-terminal mission_runtime through one MissionRuntime step, in the
 * scheduler's deterministic fairness order.
 *
 * Restart safety: supervisor state is derived from pair.db only — a new
 * process calls `resume()` which rehydrates every non-terminal mission and
 * reconciles unsettled executions via planRestartRecovery before ticking.
 * No in-memory timer is authoritative.
 */

import { newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { RecoveryController } from "./recovery-controller.js";
import type { ReconciliationService } from "./reconciliation.js";

export const WAKE_REASONS = [
  "MISSION_CREATED",
  "TASK_RUNNABLE",
  "EXECUTOR_COMPLETION",
  "RECOVERY_TIMER_DUE",
  "PROVIDER_MODEL_HEALTH_CHANGE",
  "APPROVAL_GRANTED",
  "RECONCILIATION_RESULT",
  "DEPENDENCY_COMPLETED",
  "MISSION_RESUME",
  "EXTERNAL_EXECUTOR_EVENT",
  "RESTART_REHYDRATE",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

const NON_TERMINAL = new Set([
  "CREATED",
  "PLANNING",
  "READY",
  "RUNNING",
  "WAITING",
  "WAITING_BACKOFF",
  "WAITING_APPROVAL",
  "RECONCILING",
  "REPLANNING",
  "RECOVERING",
]);

/** Mission statuses beyond any further runtime activity — a terminal
 *  mission must never gain a runtime row during recovery. */
const TERMINAL_MISSION = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Canonical non-terminal mission statuses. Only CREATED is provably in
 *  the original creation crash window (mission row persisted before
 *  `runtimeEntity`) — every other status means the mission had already
 *  progressed, so a missing runtime's prior state cannot be inferred. */
const CANONICAL_NON_TERMINAL = new Set(["CREATED", "READY", "RUNNING", "PAUSED"]);

export class MissionSupervisor {
  private running = false;

  constructor(
    private readonly service: PairControlPlane,
    private readonly runtime: MissionRuntime,
    private readonly recovery: RecoveryController,
    private readonly reconciliation: ReconciliationService,
  ) {}

  private get store() {
    return this.service.store;
  }

  /** Persist a wake reason; returns the wake row. */
  wake(
    missionId: string,
    reason: WakeReason,
    detail: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const id = newId("WAKE");
    const row = {
      wake_id: id,
      mission_id: missionId,
      reason,
      detail,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("supervisor_wake", id, row, 0);
    this.store.event({
      entity_type: "supervisor_wake",
      entity_id: id,
      event_type: "MISSION_WAKE",
      new_state: reason,
      actor: "PAIR_MISSION_SUPERVISOR",
      metadata: { mission_id: missionId, ...detail },
    });
    return saved;
  }

  /**
   * Restart rehydration: reconstruct checkpoints for non-terminal missions
   * (reconcile unsettled executions, rebuild budgets) and wake each one.
   * Idempotent — safe to call on every boot.
   */
  resume(): { missions: string[]; checkpoints: number; reconstructed: number } {
    const checkpoints = this.recovery.planRestartRecovery((executionId) =>
      this.reconciliation.reconcile({ execution_id: executionId }),
    );
    // Orphaned-mission rehydration (runtime-hardening B, R1): a mission
    // row can persist before its mission_runtime row — a crash in that
    // window leaves a live mission invisible to every runtime-scoped
    // sweep. Scan the canonical mission list and apply the exact safe
    // reconstruction rule:
    //   * status CREATED + missing runtime → provably the original
    //     crash window → canonical `runtimeEntity` reconstruction
    //     (idempotent — existing runtimes are never replaced or
    //     duplicated).
    //   * READY/RUNNING/PAUSED + missing runtime → ambiguous: the prior
    //     runtime state cannot be inferred from mission status alone →
    //     fail closed via durable recovery evidence, no runtime, no
    //     wake, no auto-run — PAUSED authority stays in effect.
    //   * any non-canonical status → fail closed the same way.
    // The standard runtime/supervisor path then picks up only the
    // safely reconstructable missions; nothing dispatches directly.
    let reconstructed = 0;
    for (const m of this.store.list("mission")) {
      const status = String(m.status);
      if (TERMINAL_MISSION.has(status)) continue;
      const missionId = String(m.mission_id);
      const runtimeId = `MRT_${missionId}`;
      if (this.store.tryGet("mission_runtime", runtimeId)) continue;
      if (status === "CREATED") {
        this.runtime.runtimeEntity(missionId);
        reconstructed++;
        continue;
      }
      this.persistRuntimeAmbiguity(
        missionId,
        CANONICAL_NON_TERMINAL.has(status) ? status : `UNKNOWN:${status}`,
      );
    }
    const missions = this.store
      .list("mission_runtime")
      .filter((rt) => NON_TERMINAL.has(String(rt.state)))
      .map((rt) => String(rt.mission_id));
    for (const missionId of missions) {
      this.wake(missionId, "RESTART_REHYDRATE", { checkpoint: `MRCP_${missionId}` });
    }
    this.running = true;
    return { missions, checkpoints: checkpoints.length, reconstructed };
  }

  /**
   * Fail-closed evidence for an ambiguous missing-runtime mission: stamp
   * the durable restart checkpoint (`mission_recovery_checkpoint`, already
   * written by `planRestartRecovery` for every non-terminal mission) with
   * a `restart_blocker` and emit a `MISSION_RUNTIME_AMBIGUOUS` event.
   * Idempotent — repeated restarts rewrite the same marker. The mission
   * itself is never woken: no guessed runtime state, no auto-run, no
   * duplicate dispatch; operator recovery uses the existing governed
   * controls (cancel/block/review).
   */
  private persistRuntimeAmbiguity(missionId: string, observed: string): void {
    const checkpointId = `MRCP_${missionId}`;
    const existing = this.store.tryGet("mission_recovery_checkpoint", checkpointId) as
      | Record<string, unknown>
      | null;
    const body: Record<string, unknown> = existing ?? {
      checkpoint_id: checkpointId,
      mission_id: missionId,
      version: 0,
    };
    body.restart_blocker = {
      code: "FAIL_CLOSED_RUNTIME_AMBIGUOUS",
      observed_mission_status: observed,
      detail:
        "mission_runtime missing and prior runtime state cannot be inferred — operator recovery required; never auto-reconstructed, never auto-run",
    };
    this.store.put(
      "mission_recovery_checkpoint",
      checkpointId,
      body,
      Number(body.version ?? 0),
    );
    this.store.event({
      entity_type: "mission",
      entity_id: missionId,
      event_type: "MISSION_RUNTIME_AMBIGUOUS",
      new_state: observed,
      actor: "PAIR_MISSION_SUPERVISOR",
      metadata: { checkpoint_id: checkpointId, code: "FAIL_CLOSED_RUNTIME_AMBIGUOUS" },
    });
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * One supervisor sweep: fairness-ordered single tick per live mission.
   * Fairness: oldest-entered waiting missions first, stable mission_id order.
   */
  tick(now?: string): { ticked: string[]; skipped: string[] } {
    if (!this.running) this.start();
    const runtimes = this.store
      .list("mission_runtime")
      .filter((rt) => NON_TERMINAL.has(String(rt.state)))
      .sort((a, b) => {
        const c = String(a.entered_at).localeCompare(String(b.entered_at));
        return c !== 0 ? c : String(a.mission_id).localeCompare(String(b.mission_id));
      });
    const ticked: string[] = [];
    const skipped: string[] = [];
    for (const rt of runtimes) {
      const missionId = String(rt.mission_id);
      try {
        this.runtime.tick(missionId, now);
        ticked.push(missionId);
      } catch (e) {
        if (process.env.PAIR_DEBUG_TICK) console.log("TICK_SKIP", missionId, (e as Error).message, (e as Error).stack?.slice(0, 600));
        skipped.push(missionId); // a mission's failure never blocks siblings
      }
    }
    return { ticked, skipped };
  }

  /** Drive until all missions settle/stall or maxSweeps hit. */
  runUntilSettled(opts: { maxSweeps?: number; now?: () => string } = {}) {
    const maxSweeps = opts.maxSweeps ?? 200;
    for (let i = 0; i < maxSweeps; i++) {
      const { ticked } = this.tick(opts.now?.());
      const live = this.store
        .list("mission_runtime")
        .filter((rt) => NON_TERMINAL.has(String(rt.state)) && rt.state !== "PAUSED");
      const progressing = live.filter(
        (rt) => !["WAITING", "WAITING_BACKOFF", "WAITING_APPROVAL"].includes(String(rt.state)),
      );
      if (live.length === 0 || progressing.length === 0) break;
      if (ticked.length === 0) break;
    }
  }
}
