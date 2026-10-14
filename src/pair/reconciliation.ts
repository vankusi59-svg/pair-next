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
   *   CONFIRMED_COMPLETED / CONFIRMED_FAILED / CONFIRMED_NOT_EXECUTED —
   *     authoritative: the row is durably settled via `terminal_outcome`
   *     (the same marker operator acknowledgment uses) and the capacity
   *     slot is released. `execution_state` itself is never rewritten —
   *     it records what the process last reported, not a claimed result.
   *   CONFIRMED_RUNNING / UNKNOWN_SIDE_EFFECT_STATE — the remote may
   *     still be live or unknowable: the slot stays RESERVED. Re-probe on
   *     a bounded cadence (`orphan_recheck_after`) so a later terminal
   *     adapter observation still settles it; UNKNOWN additionally keeps
   *     its only other release — explicit operator acknowledgment.
   * Idempotent: settled rows are excluded by `terminal_outcome`, so a
   * repeated sweep or restart writes no duplicate receipts/events.
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
        TERMINAL_MISSION.has(statusByMission.get(String(e.mission_id)) ?? "") &&
        (!e.orphan_recheck_after ||
          Date.parse(String(e.orphan_recheck_after)) <= nowMs),
    );
    const settled: string[] = [];
    for (const e of orphans) {
      const receipt = this.reconcile({ execution_id: String(e.execution_id) });
      const outcome = String(receipt.outcome);
      if (outcome === "CONFIRMED_RUNNING" || outcome === "UNKNOWN_SIDE_EFFECT_STATE") {
        e.orphan_recheck_after = new Date(
          nowMs + ReconciliationService.ORPHAN_RECHECK_MS,
        ).toISOString();
        this.store.put(
          "executor_execution", String(e.execution_id), e, Number(e.version),
        );
        continue;
      }
      e.terminal_outcome = `RECONCILED_${outcome}`;
      e.settled_receipt_id = String(receipt.reconciliation_id);
      e.orphan_recheck_after = null;
      this.store.put(
        "executor_execution", String(e.execution_id), e, Number(e.version),
      );
      this.store.event({
        entity_type: "executor_execution",
        entity_id: String(e.execution_id),
        event_type: "EXECUTION_ORPHAN_SETTLED",
        new_state: String(e.terminal_outcome),
        actor: "PAIR_RECONCILIATION_SERVICE",
        metadata: {
          mission_id: e.mission_id,
          receipt_id: receipt.reconciliation_id,
          outcome,
        },
      });
      settled.push(String(e.execution_id));
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
