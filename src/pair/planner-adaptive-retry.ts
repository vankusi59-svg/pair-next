/** P18.2 — Planner Adaptive Retry: cross-run rejection feedback.
 *
 *  A delegated plan rejected by canonical validation previously parked
 *  the work item with zero learning — the next planner run retried the
 *  same shape and re-faulted. This module derives, from durable
 *  canonical evidence only, the newest terminal validation rejection
 *  for a work item and hands it (sanitized, bounded) to the NEXT
 *  planner run's INITIAL invocation via the existing
 *  `PlannerInvocation.rejectionContext` seam (origin "PRIOR_RUN").
 *
 *  Retry accounting: one repair allowance = one terminal planner run
 *  containing ≥1 validation-rejected attempt within the current
 *  episode (a WINNER_SELECTED run ends the episode). At most
 *  PLANNER_VALIDATION_REPAIR_MAX repair runs are authorized — the
 *  caller (BusinessLayer.prepareDelegatedPlan) fails closed BEFORE
 *  minting a new run once exhausted, so no provider call, run, or
 *  reservation is created past the cap.
 *
 *  Read-only derivation — no writes, no caching, deterministic from
 *  durable rows. Infrastructure failures (transport, timeout,
 *  eligibility, malformed-response) never count as validation
 *  rejections. A settled FAILED attempt counts when it carries a
 *  canonical validation marker (VALIDATION_CODE:/REASK:) OR the
 *  PLAN_INVALID failure class — the same predicate the CEO evidence
 *  projection uses (brain-context); class-only failures still cost a
 *  repair allowance but yield no feedback code (run proceeds plain).
 *  Non-objective work items (no cost_reservation lineage) derive an
 *  empty episode → unchanged behavior. */
import type { PairEvidenceStore } from "./store.js";
import type { PlannerRejectionContext } from "./llm-planner.js";

/** Repair runs authorized after the first rejected run (v1 closed
 *  constant — a policy field would need canonical re-proof per open). */
export const PLANNER_VALIDATION_REPAIR_MAX = 2;
/** Durable attempt-row marker proving an attempt ran feedback-informed
 *  (mirrors the REASK: provenance discipline — crash mid-call still
 *  leaves the marker). Value = the fed-back validation code. */
export const PLANNER_PRIOR_REJECTION_PREFIX = "PRIOR_REJECTION:";

const SAFE_CODE_RE = /^[A-Z0-9_:.\-]+$/;
const MAX_CODE_LEN = 80;
const MAX_WARN_LEN = 160;
const MAX_WARN_COUNT = 10;

export interface PlannerAdaptiveRetry {
  /** Terminal rejected runs in the current episode (0 = fresh). */
  rejected_run_count: number;
  /** This run's feedback sequence number (== rejected_run_count). */
  retry_seq: number;
  /** True when rejected_run_count > PLANNER_VALIDATION_REPAIR_MAX —
   *  the caller must fail closed before minting a new run. */
  exhausted: boolean;
  /** Sanitized feedback for the next INITIAL invocation, or null. */
  context: PlannerRejectionContext | null;
  /** Canonical evidence identity of the fed-back rejection. */
  source: {
    planner_run_id: string;
    planner_attempt_id: string;
    attempt_no: number;
  } | null;
}

/** The ONE validation-rejection predicate — shared with the CEO
 *  evidence projection (brain-context) so cap accounting and
 *  ReasoningBrief facts can never drift apart. */
export function isValidationRejectedAttempt(a: Record<string, unknown>): boolean {
  if (String(a.outcome ?? "") !== "FAILED") return false;
  const warns = Array.isArray(a.warnings) ? (a.warnings as string[]) : [];
  return (
    String(a.failure_class ?? "") === "PLAN_INVALID" ||
    warns.some((w) => w.startsWith("VALIDATION_CODE:") || w.startsWith("REASK:"))
  );
}

/** Bounded task-warning projection identical to the REASK lane's
 *  sanitize contract — PAIR marker families only, charset+length bound. */
function boundedTaskWarnings(warns: string[]): string[] {
  return warns
    .filter(
      (w) =>
        /^(DROP_|DEP_|REPAIRED_)/.test(w) &&
        w.length <= MAX_WARN_LEN &&
        SAFE_CODE_RE.test(w),
    )
    .slice(0, MAX_WARN_COUNT);
}

/** Extract the terminal validation defect code from an attempt's
 *  warnings: last VALIDATION_CODE: marker (the reproof verdict), else
 *  the REASK: code (first rejection). Sanitized: SAFE_CODE_RE + ≤80 —
 *  malformed → null (feedback dropped, run proceeds plain). */
function extractValidationCode(warns: string[]): string | null {
  const codes = warns
    .filter((w) => w.startsWith("VALIDATION_CODE:") || w.startsWith("REASK:"))
    .map((w) => w.slice(w.indexOf(":") + 1))
    .filter((c) => c.length <= MAX_CODE_LEN && SAFE_CODE_RE.test(c));
  if (!codes.length) return null;
  const vc = warns
    .filter((w) => w.startsWith("VALIDATION_CODE:"))
    .map((w) => w.slice("VALIDATION_CODE:".length))
    .filter((c) => c.length <= MAX_CODE_LEN && SAFE_CODE_RE.test(c));
  return vc.length ? vc[vc.length - 1]! : codes[0]!;
}

export function plannerAdaptiveRetryForWorkItem(
  store: PairEvidenceStore,
  workItemId: string,
): PlannerAdaptiveRetry {
  const wid = String(workItemId);
  // Lineage: objective-scoped planner reservations attribute runs to
  // this work item (admitPlannerInvocation — canonical, never caller-
  // asserted). No lineage → no episode → unchanged behavior.
  const runIds = new Set<string>();
  for (const r of store.list("cost_reservation") as Array<Record<string, unknown>>) {
    if (String(r.attribution ?? "") !== "planner") continue;
    const rid = String(r.planner_run_id ?? "");
    if (!rid || String(r.work_item_id ?? "") !== wid) continue;
    runIds.add(rid);
  }
  if (!runIds.size) {
    return { rejected_run_count: 0, retry_seq: 0, exhausted: false, context: null, source: null };
  }
  const attempts = (store.list("planner_attempt") as Array<Record<string, unknown>>).filter(
    (a) => String(a.planner_run_id ?? "") !== "" && runIds.has(String(a.planner_run_id)),
  );
  const attemptsByRun = new Map<string, Array<Record<string, unknown>>>();
  for (const a of attempts) {
    const rid = String(a.planner_run_id);
    (attemptsByRun.get(rid) ?? attemptsByRun.set(rid, []).get(rid)!).push(a);
  }
  // Order runs newest-first — ULIDs are time-ordered; started_at is a
  // persisted tiebreak for non-ULID ids. The walk is NOT windowed:
  // every run in the episode counts toward the repair budget (audit —
  // a windowed count would let an old rejection fall out of scope and
  // silently re-authorize repair runs). Run rows are O(1) lookups and
  // the set itself is bounded by cost-admitted reservations.
  const runs = [...runIds]
    .map((rid) => ({
      rid,
      run: store.tryGet("planner_run", rid) as Record<string, unknown> | null,
    }))
    .sort((x, y) =>
      String(y.run?.started_at ?? "").localeCompare(String(x.run?.started_at ?? "")) ||
      y.rid.localeCompare(x.rid),
    );

  let rejectedRunCount = 0;
  let source: PlannerAdaptiveRetry["source"] = null;
  let sourceWarns: string[] = [];
  for (const { rid, run } of runs) {
    const state = String(run?.state ?? "");
    const runAttempts = attemptsByRun.get(rid) ?? [];
    if (state === "WINNER_SELECTED" || runAttempts.some((a) => String(a.outcome) === "SUCCESS")) {
      break; // episode closed by a winner — older rejections are history.
    }
    if (state === "RUNNING" || !runAttempts.length) continue; // crash residue.
    const rejected = runAttempts.filter(isValidationRejectedAttempt);
    if (!rejected.length) continue; // transport/eligibility-only failures.
    rejectedRunCount += 1;
    if (source === null) {
      // newest rejected attempt inside the newest rejected run.
      rejected.sort((x, y) =>
        String(y.completed_at ?? "").localeCompare(String(x.completed_at ?? "")) ||
        String(y.entity_id ?? "").localeCompare(String(x.entity_id ?? "")),
      );
      const a = rejected[0]!;
      source = {
        planner_run_id: rid,
        planner_attempt_id: String(a.entity_id ?? ""),
        attempt_no: Number(a.attempt_no ?? 0),
      };
      sourceWarns = Array.isArray(a.warnings) ? (a.warnings as string[]) : [];
    }
  }

  const exhausted = rejectedRunCount > PLANNER_VALIDATION_REPAIR_MAX;
  let context: PlannerRejectionContext | null = null;
  if (rejectedRunCount >= 1 && source !== null) {
    const code = extractValidationCode(sourceWarns);
    if (code !== null) {
      context = {
        validation_code: code,
        task_warnings: boundedTaskWarnings(sourceWarns),
        origin: "PRIOR_RUN",
      };
    }
  }
  return {
    rejected_run_count: rejectedRunCount,
    retry_seq: rejectedRunCount,
    exhausted,
    context,
    source,
  };
}
