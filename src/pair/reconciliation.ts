/**
 * P8 ReconciliationService — settles ambiguous execution state before any
 * recovery decision may replay work. Inspects canonical entities (dispatch
 * intent, executor_execution, route decisions), adapter-side evidence
 * (journal / external session state), and artifacts.
 *
 * Hard rule: UNKNOWN_SIDE_EFFECT_STATE is never replayable.
 */

import { digest, newId, utcnow } from "./canonical.js";
import type { ExecutorAdapter } from "./adapter.js";
import type { PairControlPlane } from "./service.js";
import type { PairEvidenceStore } from "./store.js";

export const RECONCILIATION_OUTCOMES = [
  "CONFIRMED_NOT_EXECUTED",
  "CONFIRMED_RUNNING",
  "CONFIRMED_COMPLETED",
  "CONFIRMED_FAILED",
  "UNKNOWN_SIDE_EFFECT_STATE",
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

export function reconciliationDigest(r: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (["receipt_digest", "version", "entity_type", "entity_id"].includes(k)) continue;
    body[k] = v;
  }
  return digest(body);
}

export class ReconciliationService {
  /** Orphan executions that can never auto-settle (still running or
   *  unknown side effects) are re-observed at most this often — remote
   *  work may legitimately reach a terminal adapter state later, but
   *  per-sweep evidence growth stays bounded. */
  static readonly ORPHAN_RECHECK_MS = 30_000;
  /** P18.3 — an orphan whose executor is NOT bound in this process
   *  (adapter:null) can never produce an authoritative observation, so
   *  the 30 s re-probe is pure churn. Unobservable re-probes are bounded:
   *  after this many tries the row gets one durable
   *  EXECUTION_ORPHAN_UNOBSERVABLE event and stops being swept — the
   *  capacity slot stays RESERVED (fail-closed) and the
   *  `orphan_unobservable_final` flag is durable across restarts. The
   *  release paths are operator `requestReconciliation` (reconcile() is
   *  not flag-gated) or a live-mission barrier reconcile — a restart
   *  alone does NOT resume auto-sweeping a capped row.
   *  Observable orphans (adapter present, reporting RUNNING/UNKNOWN)
   *  are NOT capped — a live remote execution must keep being probed. */
  static readonly ORPHAN_UNOBSERVABLE_RECHECK_MAX = 40;

  constructor(
    private readonly service: PairControlPlane,
    private readonly adapters: Map<string, ExecutorAdapter>,
  ) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  /**
   * P0-F1 — orphan-execution settlement sweep. A mission that reaches a
   * terminal status no longer has a live runtime driving its execution
   * barriers, so any non-terminal `executor_execution` row it leaves
   * behind would otherwise consume CapabilityRouter capacity forever.
   * (planRestartRecovery scans only NON-terminal missions; abort is the
   * one writer that legitimately leaves in-flight executions unresolved.)
   *
   * For every unsettled execution whose mission is canonically terminal,
   * run the canonical reconcile() proof and apply the outcome:
   *   adapter-observed TERMINAL status (COMPLETED/FAILED/CANCELLED/
   *     TIMEOUT) — authoritative terminal evidence: the row is durably
   *     settled via `terminal_outcome` (the same marker operator
   *     acknowledgment uses) and the capacity slot is released.
   *     `execution_state` itself is never rewritten — it records what
   *     the process last reported, not a claimed result.
   *   everything else — the slot stays RESERVED. "No observation + no
   *     run_root" is NOT proof nothing ran (adapter may be unavailable,
   *     observe may throw, run_root persistence may have been lost):
   *     R1-F1 forbids releasing capacity on that weak evidence —
   *     the case stays fail-closed like UNKNOWN_SIDE_EFFECT_STATE.
   *     Reserved orphans re-probe on a bounded cadence
   *     (`orphan_recheck_after`) so a later terminal adapter observation
   *     still settles them; explicit operator acknowledgment remains the
   *     other release path.
   *
   * R1-F2 — one orphan's failure never blocks the sweep or the
   * supervisor: each orphan is isolated in its own try/catch, and the row
   * is re-read before mutating so a concurrent writer (operator
   * acknowledgment, in-flight barrier, another sweep) is absorbed — never
   * stomped — while an actual version conflict simply converges on a
   * later sweep. Idempotent: settled rows are excluded by
   * `terminal_outcome`, so repeated sweeps/restarts write no duplicate
   * receipts/events.
   */
  settleTerminalMissionOrphans(nowMs: number = Date.now()): { settled: string[] } {
    const TERMINAL_MISSION = new Set(["COMPLETED", "FAILED", "ABORTED", "CANCELLED"]);
    const statusByMission = new Map(
      this.store
        .list("mission")
        .map((m) => [String(m.mission_id), String(m.status)] as const),
    );
    const orphans = this.store.list("executor_execution").filter(
      (e) =>
        !TERMINAL.has(String(e.execution_state)) &&
        !e.terminal_outcome &&
        !e.orphan_unobservable_final && // P18.3 — capped unobservable rows stop being swept
        TERMINAL_MISSION.has(statusByMission.get(String(e.mission_id)) ?? "") &&
        (!e.orphan_recheck_after ||
          Date.parse(String(e.orphan_recheck_after)) <= nowMs),
    );
    const settled: string[] = [];
    for (const candidate of orphans) {
      const executionId = String(candidate.execution_id);
      try {
        const receipt = this.reconcile({ execution_id: executionId });
        const outcome = String(receipt.outcome);
        const facts = (receipt.facts as Record<string, unknown>) ?? {};
        // R1-F1 — release capacity ONLY on authoritative terminal
        // evidence: the adapter itself must have reported a terminal
        // status. reconcile()'s CONFIRMED_FAILED for "no observation +
        // no run_root" is a weak heuristic, not proof of death.
        const authoritative = TERMINAL.has(
          String(facts.observed_status ?? ""),
        );
        // R1-F2 — re-read before mutating: absorb benign concurrent
        // writes, re-validate candidacy (an operator acknowledgment or
        // barrier landing mid-sweep must never be overwritten).
        const e = this.store.tryGet("executor_execution", executionId);
        if (
          !e ||
          TERMINAL.has(String(e.execution_state)) ||
          e.terminal_outcome ||
          !TERMINAL_MISSION.has(
            statusByMission.get(String(e.mission_id)) ?? "",
          )
        ) {
          continue;
        }
        if (!authoritative) {
          // P18.3 — bound UNOBSERVABLE re-probes (adapter missing → the
          // probe can never turn authoritative). Observable states keep
          // the ordinary cadence uncapped: a live remote execution must
          // keep reporting until it settles.
          if (facts.adapter == null && facts.observed_status == null) {
            const tries = Number(e.orphan_unobservable_count ?? 0) + 1;
            e.orphan_unobservable_count = tries;
            if (tries >= ReconciliationService.ORPHAN_UNOBSERVABLE_RECHECK_MAX) {
              e.orphan_unobservable_final = true;
              e.orphan_recheck_after = null;
              this.store.put(
                "executor_execution", executionId, e, Number(e.version),
              );
              this.store.event({
                entity_type: "executor_execution",
                entity_id: executionId,
                event_type: "EXECUTION_ORPHAN_UNOBSERVABLE",
                new_state: String(e.execution_state),
                actor: "PAIR_RECONCILIATION_SERVICE",
                metadata: {
                  mission_id: e.mission_id,
                  executor_id: e.executor_id,
                  attempts: tries,
                  rationale:
                    "executor not bound in this process — observation impossible; slot stays RESERVED (fail-closed), operator acknowledgment required",
                },
              });
              continue;
            }
          }
          e.orphan_recheck_after = new Date(
            nowMs + ReconciliationService.ORPHAN_RECHECK_MS,
          ).toISOString();
          this.store.put(
            "executor_execution", executionId, e, Number(e.version),
          );
          continue;
        }
        e.terminal_outcome = `RECONCILED_${outcome}`;
        e.settled_receipt_id = String(receipt.reconciliation_id);
        e.orphan_recheck_after = null;
        this.store.put(
          "executor_execution", executionId, e, Number(e.version),
        );
        this.store.event({
          entity_type: "executor_execution",
          entity_id: executionId,
          event_type: "EXECUTION_ORPHAN_SETTLED",
          new_state: String(e.terminal_outcome),
          actor: "PAIR_RECONCILIATION_SERVICE",
          metadata: {
            mission_id: e.mission_id,
            receipt_id: receipt.reconciliation_id,
            outcome,
          },
        });
        settled.push(executionId);
      } catch {
        // Per-orphan failure (version race, adapter/store fault):
        // converge on a later sweep — never block siblings, the resume
        // path, or supervisor.tick().
        continue;
      }
    }
    // P18.4 audit R5-M2 — a committed-but-unsettled row on a TERMINAL
    // mission is unreachable by every live sweep (its execution_state is
    // already terminal, so the orphan class above skips it; the dead
    // mission never ticks). Close the consistency gap with the same
    // governed neutral-outcome pattern other unreachable rows use.
    const committedOrphans = this.store.list("executor_execution").filter(
      (e) =>
        e.result != null &&
        e.settle_complete !== true &&
        !e.terminal_outcome &&
        TERMINAL_MISSION.has(statusByMission.get(String(e.mission_id)) ?? ""),
    );
    for (const e of committedOrphans) {
      try {
        this.store.immediate(() => {
          const fresh = this.store.tryGet(
            "executor_execution",
            String(e.execution_id),
          ) as Record<string, unknown> | undefined;
          if (!fresh || fresh.settle_complete === true || fresh.terminal_outcome) return;
          fresh.terminal_outcome = "MISSION_TERMINAL_BEFORE_SETTLE";
          this.store.put(
            "executor_execution",
            String(fresh.execution_id),
            fresh,
            Number(fresh.version),
          );
          this.store.event({
            entity_type: "executor_execution",
            entity_id: String(fresh.execution_id),
            event_type: "EXECUTION_TERMINAL_ORPHAN_NEUTRALIZED",
            new_state: "MISSION_TERMINAL_BEFORE_SETTLE",
            actor: "PAIR_RECONCILIATION_SERVICE",
            metadata: { mission_id: fresh.mission_id },
          });
        });
        settled.push(String(e.execution_id));
      } catch {
        continue;
      }
    }
    return { settled };
  }

  /**
   * Inspect one execution (or a governed task with intent but no settled
   * execution) and persist a reconciliation_receipt. Never dispatches.
   */
  reconcile(params: {
    execution_id?: string;
    governed_task_id?: string;
    mission_id?: string;
    correlation_id?: string;
  }): Record<string, unknown> {
    const receiptId = newId("REC");
    const inputs: Record<string, unknown> = { ...params };
    const facts: Record<string, unknown> = {};

    const execution = params.execution_id
      ? this.store.tryGet("executor_execution", params.execution_id)
      : null;
    const governedTaskId =
      params.governed_task_id ?? (execution?.governed_task_id as string | undefined) ?? null;
    const intent = governedTaskId
      ? this.store.tryGet("executor_dispatch_intent", `INTENT_${governedTaskId}`)
      : null;

    facts.execution_entity_present = Boolean(execution);
    facts.execution_state = execution ? String(execution.execution_state) : null;
    facts.result_collected = Boolean(execution?.result);
    facts.intent_state = intent ? String(intent.state) : "ABSENT";
    facts.intent_execution_id = intent?.execution_id ?? null;

    let outcome: ReconciliationOutcome;
    let rationale: string;

    if (!execution && (!intent || String(intent.state) === "INTENT_RECORDED")) {
      // Intent recorded without persisted execution: check adapter-side evidence.
      const adapter = governedTaskId ? this.adapterFor(governedTaskId) : null;
      const ev = adapter?.dispatch_evidence?.(String(governedTaskId));
      facts.adapter_dispatch_evidence = ev ?? null;
      if (ev?.dispatched && ev.execution_id) {
        outcome = "UNKNOWN_SIDE_EFFECT_STATE";
        rationale = "dispatch intent exists and adapter reports a dispatch, but no canonical execution entity";
      } else {
        outcome = "CONFIRMED_NOT_EXECUTED";
        rationale = "no execution entity and no adapter-side dispatch evidence";
      }
    } else if (execution && TERMINAL.has(String(execution.execution_state))) {
      facts.terminal_state = String(execution.execution_state);
      if (execution.result) {
        outcome =
          String(execution.result_state ?? execution.execution_state) === "COMPLETED"
            ? "CONFIRMED_COMPLETED"
            : "CONFIRMED_FAILED";
        rationale = "canonical terminal result collected";
      } else {
        outcome = "CONFIRMED_FAILED";
        rationale = "terminal execution state without collected result — no success claim";
      }
    } else if (execution) {
      // Non-terminal execution: ask the adapter for live/external state.
      const adapter = this.adapterFor(String(execution.governed_task_id));
      facts.adapter = adapter?.executor_id ?? null;
      let observed: Record<string, unknown> | null = null;
      try {
        observed = adapter ? (adapter.observe(String(execution.execution_id)) as Record<string, unknown>) : null;
      } catch {
        observed = null;
      }
      facts.observed_status = observed ? String(observed.status) : null;
      facts.run_root_present = Boolean(execution.run_root);
      if (observed && TERMINAL.has(String(observed.status))) {
        outcome = String(observed.status) === "COMPLETED" ? "CONFIRMED_COMPLETED" : "CONFIRMED_FAILED";
        rationale = "adapter reports settled terminal state — result collectable without rerun";
      } else if (observed && String(observed.status) === "RUNNING") {
        outcome = "CONFIRMED_RUNNING";
        rationale = "adapter still reports RUNNING";
      } else if (execution.run_root) {
        outcome = "UNKNOWN_SIDE_EFFECT_STATE";
        rationale = "process/session gone but a run root exists — side effects may have landed; never blind replay";
      } else {
        outcome = "CONFIRMED_FAILED";
        rationale = "execution record unsettled and no external evidence of work";
      }
    } else {
      outcome = "CONFIRMED_NOT_EXECUTED";
      rationale = "no execution and no dispatch intent";
    }

    const receipt: Record<string, unknown> = {
      schema: "pair.os.vnext.reconciliation-receipt.v1",
      reconciliation_id: receiptId,
      inputs,
      facts,
      outcome,
      rationale,
      replay_allowed: outcome === "CONFIRMED_NOT_EXECUTED",
      created_at: utcnow(),
      version: 0,
    };
    receipt.receipt_digest = reconciliationDigest(receipt);
    const saved = this.store.put("reconciliation_receipt", receiptId, receipt, 0);
    this.store.event({
      entity_type: "reconciliation_receipt",
      entity_id: receiptId,
      event_type:
        outcome === "UNKNOWN_SIDE_EFFECT_STATE" ? "RECONCILIATION_UNKNOWN" : "RECONCILIATION_COMPLETED",
      new_state: outcome,
      actor: "PAIR_RECONCILIATION_SERVICE",
      correlation_id: params.correlation_id ?? null,
      metadata: { execution_id: params.execution_id ?? null, governed_task_id: governedTaskId },
    });
    return saved;
  }

  private adapterFor(governedTaskId: string): ExecutorAdapter | null {
    const gt = this.store.tryGet("governed_task", governedTaskId);
    if (!gt) return null;
    return this.adapters.get(String(gt.executor_id)) ?? null;
  }
}
