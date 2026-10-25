# P18.4 — Independent Audit Summary

Two independent (non-implementer) audits ran against the P18.4 diff,
workstream-scoped, followed by remediation and re-verification.

## P18.4-A — Recovery Integrity & Atomicity

**Verdict: FIX-THEN-SHIP → resolved → SHIP**

Core invariants verified as correctly implemented and honestly tested:
atomic deferred→pending handoff (txn covers pop-put AND the full arm
chain — decision, attempt, pending, barrier, transition, approval,
schedule); atomic settlement with `settle_complete` stamped inside the
txn on every disposition path; exactly-once re-settlement (deduped
mints, convergent acceptBatch); rollback semantics exploited correctly
in the drain catch (bounded in-place `drain_attempts`, durable drop
evidence); `faultInjector` unreachable from production config;
authority boundaries intact (`decide()` sole authority, single-slot
pending, sameChainContinuation preserved).

Findings and resolution:

| Sev | Finding | Resolution |
|---|---|---|
| HIGH | Exclusion→signal boundary (`markCollectExcluded` → `queueOrStartRecovery`) still non-atomic — crash leaves excluded row with no signal (F1-class permanent stall) | Both call sites wrapped in one `immediate()` txn; exclusion propagates faults. RA-11 added (XOR + retry). |
| MEDIUM | No `settle_complete` backfill — pre-upgrade settled rows re-enter sweep (duplicate TASK_COMPLETED / duplicate chain) | Lazy witness backfill in sweep: `result.settled_at` (PASS) or existing `recovery_decision` for (task,exec) (REJECT) → stamp + skip. RA-12 added. |
| LOW | Write lock spans bounded local file IO in settle txn | Documented accepted tradeoff (single-writer object graph, busy_timeout). |
| LOW | RA-1 sweeps only one arm shape | Noted; auxiliary arm writes share the txn — semantics identical; targeted coverage RA-2/3/11. |
| LOW | Exclusion `reason` taxonomy regressed | Restored: `deterministic`/`post_commit`/`attempt_bound`. |
| NIT | Magic bound literal | `DRAIN_ATTEMPT_BOUND` named. |
| NIT | ARMED_THEN_THROW branch never dequeues | Defensive splice+put added. |

## P18.4-B — Observability & UI

**Verdict: FIX-THEN-SHIP → resolved → SHIP**

Verified: auth/tenancy airtight (MC-token gate, admin boundary distinct,
no new mutation route); derived-stage ordering is canonical-strength
(SETTLED never without `settle_complete===true`); latency math
null-safe; provenance discipline (sanitized fields only, no raw adapter
blob, no secret surface); scope filters on every per-mission list;
read-only UI; fail-closed validation in spirit.

Findings and resolution:

| Sev | Finding | Resolution |
|---|---|---|
| MED | `executions_awaiting_collection` counted healthy in-flight work (inflated pressure metric) | Tightened to terminal-evidenced debt only (TERMINAL_EXEC or first_terminal_observed_at). |
| MED | `executions_never_observed` meant two things in the two projections | Aligned on `observe_count===0` canonical basis. |
| LOW | `missions_running` collided with metrics() semantic | Renamed `missions_active` (backend + UI + tests). |
| LOW | `latency_ms` unvalidated then dereferenced | Validator requires `derived.latency_ms` object → MALFORMED not TypeError. |
| LOW | `mission_id` echo couldn't fail scope-pin | Added evidenced `mission_exists` from canonical lookup. |
| NIT | `terminal_outcome` typed Record but stores strings | Typed `unknown`. |
| NIT | receipts relied on rowid order | Sorted by `created_at` before cap-20. |
| NIT | `decide_approval` always true | Gated on `approvals_pending.length>0`. |
| NIT | observed-bucket docstring overclaimed | Reworded: "facts about observation". |
| NIT | unsorted executions array | Sorted by `dispatch_timestamp`. |

## P18.4-A second-pass audit (post-remediation)

A second independent pass audited the remediated spine — **FIX-THEN-SHIP
→ all HIGH/MEDIUM closed** (`bd6443c`):

| Sev | Finding | Resolution |
|---|---|---|
| HIGH | Upgrade witness read `result.settled_at` — adapter-controllable (dead + forgeable skip-settlement) | Corrected to canonical row-level `e.settled_at`; doc corrected |
| HIGH | `settleExecution` no `settle_complete` early-return — apply-path replay could re-run a full disposition (duplicate events, clobbered successor arm) | In-txn re-read + early return on `settle_complete===true` |
| HIGH | `clearPendingRecovery`→re-decide two commits on RECONCIL apply path | Both branches wrapped in `immediate()` |
| MED | Drop evidence not exactly-once (prune: evidence-before-removal → duplicates; bound/armed: removal-before-evidence+swallow → silent drop) | All drops commit removal+evidence in one txn; missing `reason` field added |
| MED | Committed-unsettled rows on terminal missions unreachable by every sweep | `settleTerminalMissionOrphans` neutralizes via `terminal_outcome=MISSION_TERMINAL_BEFORE_SETTLE` (atomic, idempotent) |
| MED | Drain txn no in-txn pending check — racing arm could be clobbered | Early return on `rtTxn.pending_recovery` inside BEGIN IMMEDIATE |
| NIT | Backfill stamp emitted no evidence | `EXECUTION_SETTLE_BACKFILLED` in the same txn |
| LOW | faultInjector prod-assignable (convention only); settle-txn file IO; CAS-race determinism; dead-writer counter floor | Accepted + documented |

E2E-3/E2E-5 "flakiness" was root-caused to test-assertion order, not a
product defect: the sweep legitimately early-returns mid-pass when a
settle arms recovery (sibling collect lands next tick — collection runs
in every live state via `COLLECT_LIVE_STATES`), so the tests now drive
until all canonical witnesses hold. E2E-5 additionally accepts the
legitimate mission-terminal outcome (dead missions never drain; the
deferred row remains durably queued — which IS the crash-safe signal
preservation being proven).

## Integrated assessment

The A and B fixes are disjoint (atomicity spine vs. read projections);
the B remediations touch only observability/UI files, the A remediations
only `mission-runtime.ts`/`reconciliation.ts` + tests. No interaction
risk identified.

**Remaining documented limitations:** settle-txn file IO under the write
lock; RA-1 arm-shape coverage; reconciliation_receipt unbounded scan
(same class as existing metrics()); per-row flag/rollup phrasing
inherently approximate for faulted-observe rows; faultInjector
convention-gated.

Final gate: `verify:change --base 9a1e363` on post-remediation HEAD —
see `.pair-verification/report.md`.
