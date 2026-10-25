# P18.4-A — Recovery Atomicity Forensic Audit

Baseline: `main@9a1e363` (post-P18.3). Scope: every durable-write boundary on the
recovery spine of `src/pair/mission-runtime.ts` — deferred→pending handoff,
canonical settlement, apply-path dispatch, reconciliation barriers, restart
rehydration.

## Persistence contract (verified)

- `PairStore.immediate(fn)` = `db.transaction(fn).immediate()` —
  real `BEGIN IMMEDIATE … COMMIT/ROLLBACK`. better-sqlite3 nests via savepoints,
  so inner writes join the ambient transaction (`src/pair/store.ts:85-89`).
- `PairStore.put` is a single CAS `UPDATE … WHERE version=?` statement
  (`store.ts:322-385`) — atomic per row, no partial payload possible.
- `event` / `appendEvidence` are single `INSERT`s on the same `db` — they join
  an ambient transaction (`store.ts:468,558`).
- All writes on the recovery spine route through the **same** `PairStore`
  instance (`MissionRuntime.store` → `service.store`,
  `mission-runtime.ts:302-303`; `GovernedTaskGate`, `MissionScheduler`,
  `ApprovalQueue`, `RecoveryController` ditto). A transaction around a spine
  section therefore covers every row it touches.

## Crash model

A crash (SIGKILL, power loss, process abort) at any point leaves the durable
state at the last **committed** write. An uncommitted transaction is discarded
by SQLite. Sequential `put`s without an enclosing transaction are therefore
distinct crash boundaries — each committed prefix is a possible restart state.

## Failure matrix

| # | Boundary | Write sequence | Crash window | Resulting durable state | Verdict |
|---|----------|----------------|--------------|-------------------------|---------|
| F1 | `drainDeferredRecovery` (`mission-runtime.ts:1927-1946`) | `put(rt)` pop → `startRecovery` arm `put(rt)` + `put(recovery_decision)` + barrier/approval/transition puts | after pop-put, before arm-put | deferred entry **gone**, `pending_recovery` **null**, task `FAILED`, mission `RUNNING` — the signal exists nowhere | **CONFIRMED DEFECT** — lost recovery signal, silent permanent stall |
| F2 | `settleExecution` FAILED path (`:2173-2193`) | `collect_execution_result` puts (attempt bump `:1133`, result commit) → `updateTask(FAILED)` → `stampSettled` → `queueOrStartRecovery` arm | between any two commits | committed `result` removes the row from the sweep (`result==null` filter `:1636`); task may sit `FAILED` or `RUNNING` with no pending/deferred signal | **CONFIRMED DEFECT** — orphaned settlement, lost signal |
| F3 | `settleExecution` COMPLETED path (`:2026-2132`) | same shape: result commit → `updateTask(COMPLETED)` → `stampSettled` → `TASK_COMPLETED` event → optional telegram mint | between result commit and task mark | task left `RUNNING`/`DISPATCHED` though the executor's canonical result is committed; mission can never settle | **CONFIRMED DEFECT** — same class as F2 |
| F4 | `handleRecoveryApplyFailure` → `startRecovery` (`:2904-2946`) | arm `put` (single statement) then auxiliary puts (barrier, transition, approval, schedule) | after arm-put | pending armed with missing aux state — apply replay re-derives (approval mint-or-relink, barrier rebuild) | SAFE — self-healing replay |
| F5 | `applyRecoveryAction` RETRY/RE_ROUTE dispatch (`:2713-2784`) | supersede → `READY` → `routeGovernedTask` (adopt-or-dispatch) → `RUNNING` → inline settle → `clearPendingRecovery` + transition | anywhere | `routeGovernedTask` adopts the prior governed task (`mission-router.ts:85-107`); `dispatch_governed_task` idempotent-returns the persisted execution via `executor_dispatch_intent` (`gate.ts:660-730`); a dispatched-but-unpersisted intent routes to evidence reconcile, never blind re-dispatch | SAFE — no duplicate side-effect dispatch |
| F6 | `queueOrStartRecovery` defer path (`:1836-1858`) | single `put(rt)` appending the entry | before the put | signal absent — but the caller's own context (settle txn, post-fix) rolls back identically, so the source is re-signaled | Covered by F2 fix |
| F7 | `clearPendingRecovery` + `transitionRuntime` (`:2747-2748` etc.) | two `put`s | between them | pending cleared, state `RECOVERING` → next tick `applyPendingRecovery` sees null pending → `RUNNING` (`:2517-2519`) | SAFE — self-healing |
| F8 | stale-prune `put` (`:1909-1918`) → splice `put` (`:1929`) | independent prune persists first | between them | queue consistent either way (latent quirk: stale `rt.version` on the second put wastes one tick via CAS conflict — fixed by re-reading inside the txn) | SAFE (minor defect corrected) |
| F9 | `runReconciliation` barrier settle (`:3839-3900`) | `put(rt)` `barrier.settled` → `settleExecution` → transition | between barrier-put and settle | settled barrier leaves the execution un-barriered → the extended sweep re-drives it to a canonical disposition | Covered by F2 fix |
| F10 | observe/stamp puts (`:1100-1117`, `:1656-1690`) | best-effort `put`s on the execution row | anywhere | stamps re-derived by the next observe; counters are liveness hints, not authority | SAFE |
| F11 | `markCollectExcluded` (`:1775-1793`) | marker `put` → `appendEvidence` | between them | exclusion durable without its evidence row — audit gap, not a liveness/signal loss | LOW — acceptable; evidence is best-effort by contract |
| F12 | UNKNOWN → `queueOrStartRecovery` (`:1699-1715`) | defer/arm `put` | before it | `result==null` keeps the row sweep-eligible → re-observed → re-signaled (deduped by task) | SAFE — self-healing |

## Root cause

F1–F3 share one mechanism: **acknowledged durable state is advanced by
sequential commits without an enclosing transaction**. The deferred pop and the
settle's result→task→recovery chain each commit a prefix that erases the only
remaining signal, while the successor authority (armed `pending_recovery`, task
disposition) has not yet been persisted. A crash in that gap produces durable
state no code path can reach — the same starvation class P18.3 eliminated for
observation, one boundary deeper.

## Repair strategy (Phase C)

1. **Atomic handoff** — `immediate()` wraps the deferred pop-put and the full
   `startRecovery` arm chain. Post-rollback the entry is still queued; retries
   bound via `drain_attempts` on the surviving entry.
2. **Atomic settlement** — the post-collect settle chain (validate → task →
   `settled_at` → recovery arm → events → send-request mint) runs in one
   `immediate()`; the row is stamped `settle_complete` inside the same commit.
   Collect itself stays outside the transaction (preserves honest attempt
   accounting and keeps adapter IO off the write lock).
3. **Crash-orphan re-eligibility** — sweep eligibility becomes
   `result==null || settle_complete!==true` (still excluding
   `terminal_outcome`/`collect_excluded`/barriered), so a committed-but-unsettled
   execution re-enters collection on the next tick — no restart required — and
   re-settlement is idempotent by transaction atomicity + signal dedup.
4. **Fault-injection seam** — `PairStore.faultInjector` fires before every
   durable write (`put`/`event`/`appendEvidence`), letting tests crash at any
   write boundary — inside a transaction it throws → rollback, which is exactly
   the power-loss semantics.

No second recovery authority, no new ledger: `pending_recovery` remains the
single-slot arm and `deferred_recovery` the durable queue; transactions only
make the transitions between them indivisible.

## Phase K remediation — independent-audit findings closed

The independent audit (FIX-THEN-SHIP) found two residual items; both are
fixed and covered by RA-11/RA-12:

**F13 — exclusion→signal boundary (HIGH, closed).** `markCollectExcluded`
committed `collect_excluded` and `queueOrStartRecovery` committed its
defer/arm chain as separate writes. A crash between them left a row
permanently out of the sweep with no recovery signal — the same
lost-signal class as F1, one boundary later. Both call sites (the
`OBSERVE_FAULT_BOUND` sweep path and `handleSettleFault`'s bound/
deterministic exit) now run `markCollectExcluded` +
`queueOrStartRecovery` inside one `immediate()` transaction, and
`markCollectExcluded` propagates faults so the exclusion can never
commit without its successor signal. RA-11 crash-injects inside that
transaction and asserts the XOR outcome, then drives the retry to the
committed pair.

**F14 — pre-upgrade settled rows re-entering the sweep (MEDIUM, closed).**
`settle_complete` did not exist before P18.4, so rows settled by the old
binary look identical to crash-orphaned unsettled rows. On a live
mission, a re-driven PASS row would emit a duplicate `TASK_COMPLETED`
event; a re-driven REJECT row could mint a second recovery chain. The
sweep now witnesses durable proof of a prior settle —
`result.settled_at` (PASS) or an existing `recovery_decision` for
`(task_id, execution_id)` (REJECT arm) — stamps `settle_complete` and
skips the row. RA-12 pins both witnesses plus the no-re-settle,
no-duplicate-chain assertions. Genuine crash orphans carry neither
witness and still self-heal through `settleExecution`.

**Residual LOWs (documented, accepted):**
- The settle transaction spans bounded local file IO (artifact CAS
  persist + verify). The write lock is held through fsyncs; acceptable
  under the single-writer object graph and `busy_timeout`, documented
  rather than re-architected.
- RA-1 sweeps the first 10 writes of one arm shape; auxiliary arm
  writes (barrier, approval, backoff schedule) share the same
  transaction and are covered by transaction semantics, with targeted
  coverage in RA-2/RA-3/RA-11.
- `EXECUTION_COLLECTION_EXCLUDED` reason taxonomy preserved:
  `deterministic` / `post_commit` / `attempt_bound`.
