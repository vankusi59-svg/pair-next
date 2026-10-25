# P18.4 — Recovery State Machine (Canonical Reference)

Scope: the durable recovery states a task/execution can occupy, the
transitions between them, and the atomicity guarantees P18.4 adds.
Authority: `src/pair/mission-runtime.ts`, `src/pair/recovery-controller.ts`,
`src/pair/reconciliation.ts`. All state lives on canonical rows —
`mission_runtime.pending_recovery`, `mission_runtime.deferred_recovery`,
`executor_execution`, `recovery_decision`, `recovery_attempt`,
`reconciliation_receipt` — in the single `PairEvidenceStore`.

## States

| State | Durable witness | Meaning |
|---|---|---|
| IN_FLIGHT | exec row, `result==null`, `settle_complete!=true`, no `collect_excluded`/`terminal_outcome` | Sweep-eligible: observe → collect → settle |
| TERMINAL_OBSERVED | `execution_state` terminal / `first_terminal_observed_at` | Adapter reported terminal; result not yet committed |
| RESULT_COMMITTED | `result!=null`, `settle_complete!=true` | Collected but unsettled — **P18.4: re-enters sweep** |
| SETTLED | `settle_complete==true` | Disposition committed exactly once (PASS or REJECT path) |
| EXCLUDED | `collect_excluded!=null` | Permanently out of sweep; recovery owns the outcome |
| NEUTRALIZED | `terminal_outcome!=null` | Operator/governed outcome already assigned (e.g. no-replay accept) |
| PENDING | `rt.pending_recovery` | Single-slot armed recovery; `applyPendingRecovery` dispatches it |
| DEFERRED | `rt.deferred_recovery[]` | Durable queue — a failure found while pending is occupied |
| BARRIERED | `rt.barriers[exec].settled!=true` | Reconciliation owns the outcome; sweep skips |
| BACKOFF | `scheduled_action` pending | Retry scheduled; fires when due |
| WAITING_APPROVAL | `approval_request` PENDING | Owner decision required |

## Transitions and their atomicity (P18.4)

```
IN_FLIGHT ──observe──> TERMINAL_OBSERVED ──collect──> RESULT_COMMITTED
RESULT_COMMITTED ──settleCommitted txn──> SETTLED        [ATOMIC: F2/F3 closed]
   └─ fault pre-commit → IN_FLIGHT (retry, bounded collection_attempts)
   └─ fault post-commit → RESULT_COMMITTED (retry, bounded settle_faults)
IN_FLIGHT ──observe faults ≥24──> EXCLUDED + signal      [ATOMIC: F13 closed]
RESULT_COMMITTED ──settle_faults ≥24 / deterministic──> EXCLUDED + signal [ATOMIC]
any failure signal ──pending free──> PENDING (arm: decide+writes)         [ATOMIC arm chain]
any failure signal ──pending occupied, different task──> DEFERRED (dedup by task_id)
DEFERRED ──pending frees, drain──> PENDING               [ATOMIC: F1 closed]
DEFERRED ──drain_attempts ≥5──> dropped + DEFERRED_RECOVERY_DROPPED evidence
PENDING ──apply──> dispatch (RETRY/RE_ROUTE) | barrier (RECONCILE) |
                   approval (HUMAN) | mission ABORT
BARRIERED ──reconcile──> NEUTRALIZED | re-settle
```

Atomicity invariants:

- **F1 (deferred→pending)**: pop + full arm chain in one
  `immediate()` txn. Rollback ⇒ entry still queued. Commit ⇒ armed.
- **F2/F3 (settle)**: `settleExecution` = collect (outside txn, IO off
  the write lock) then `settleCommitted` (one txn: validation, task
  transition, `settled_at`, recovery arm, events, mint dedup).
  `settle_complete` stamps inside the same commit — the ONLY
  re-eligibility marker.
- **F13 (exclusion→signal)**: `markCollectExcluded` +
  `queueOrStartRecovery` in one `immediate()` txn at both call sites.
- **F14 (upgrade)**: pre-`settle_complete` rows are witnessed by
  `result.settled_at` (PASS) or an existing `recovery_decision` for
  `(task, execution)` (REJECT) → marker stamped, never re-settled.

Dedup authorities:

- Same-task signal while pending armed: dropped (no new authority).
- Same-task deferred entry: one per `task_id`.
- `executor_dispatch_intent`: apply-path replay adopts the persisted
  execution — never a duplicate external dispatch.
- Telegram/outbox mint: deterministic id — exactly-once on re-settle.

Bounds: `collection_attempts`/`settle_faults` ≥ `COLLECT_FAULT_BOUND`(24)
→ governed EXCLUDED handoff; `drain_attempts` ≥ `DRAIN_ATTEMPT_BOUND`(5)
→ dropped with evidence. No path loops unbounded.
