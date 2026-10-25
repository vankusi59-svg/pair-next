# P18.3 — Forensic Root-Cause Report: `result.json` exists while `executor_execution` stays `RUNNING`

Date: 2026-10-25. Environment: `C:\Users\Admin\.pair-e2e-v181\mc` live stack (serve-mission-control.mjs, better-sqlite3 `pair.db`), Windows host, codex-cli executor. Baseline: `905db0eb` (main, post PR #151).

## 1. Symptom

Executors write `result.json` + `execution_journal.json` (terminal status) while the canonical `executor_execution.execution_state` remains `RUNNING` for tens of minutes — and in two observed cases, permanently.

## 2. Durable evidence (mission `MSN_01M5RRB5DN4GYWCHV9GZDZZ958`)

Canonical event log + journal files + entity rows:

| Time (UTC) | Evidence |
|---|---|
| 05:25:44 | `mission_runtime` → RUNNING; T1 (PAIR_NATIVE) + T2 attempt-1 `EXE_1b96af28` (CODEX) dispatched |
| 05:26:06 | attempt-1 `execution_journal.json` finished FAILED (≈21 s of work) |
| 05:26:07 | runtime → `WAITING_BACKOFF` (recovery backoff for attempt-1, `PROCESS_EXIT`) |
| 05:26:09 | runtime → `RUNNING` (`no_pending_backoff`) — **`pending_recovery` (RE_ROUTE) survived the transition** |
| 05:26:10 | attempt-2 `EXE_31cfbe9c` dispatched by `applyPendingRecovery` invoked while `state === "RUNNING"` |
| 05:26:30 | attempt-2 `result.json` + journal written (FAILED, `CODEX_AGENT_REPORTED_FAILURE`, ≈20 s of work) |
| 05:26:30 → 06:29:15 | **63 min dead air.** Task row `TSK_01M5RRB6MVPQZQJ77VT2N2VDCN` reached `version = 7507` — thousands of `updateTask` writes with no task event — i.e. the RE_ROUTE apply-arm ran ~every 1 s tick without ever closing out. `EXE_31cfbe9c.last_observation = null` — `observe_execution` was **never called once**. |
| 06:29:15 | runtime → `RECOVERING` (after server restart) |
| 06:29:16 | runtime → `ABORTED`, mission → FAILED (`recovery_abort:PROCESS_EXIT`); `infeasible_actions: [FAIL_CLOSED_ADAPTER_NOT_BOUND × 2]` |
| since | `settleTerminalMissionOrphans` re-probes every 30 s; receipts show `facts.adapter: null`, `observed_status: null` → `UNKNOWN_SIDE_EFFECT_STATE` → `orphan_recheck_after` rolls forever; `terminal_outcome` never set. |

Identical pattern on `MSN_01M5RRJK5` / `EXE_ca095b1d` (result at 05:32:06, `last_observation: null`, still RUNNING).

## 3. Root causes (evidence → code)

### RC-A — `pending_recovery` applied while `state === "RUNNING"` never closes (the deadlock)

`runRunning()` treats a surviving `pending_recovery` as an early-return gate
(`mission-runtime.ts:1401-1411`): when `rt.reason !== "unhandled:<action>"`
it calls `applyPendingRecovery()` and **returns before the in-flight observe
section**. The recovery apply-arms (`applyRecoveryAction`,
`mission-runtime.ts:2296-2307` / `2330-2341`) only call
`clearPendingRecovery()` when `rtAfter.state === "RECOVERING"`. Invoked from
the RUNNING-path compat leg the state is `RUNNING`, so:

1. `RE_ROUTE` dispatches the retry (attempt-2, 05:26:10) — success.
2. Close-out skipped (state is `RUNNING`, not `RECOVERING`) → `pending_recovery` stays.
3. Every subsequent 1 s tick: `pendingRecovery` truthy → `applyPendingRecovery` → RE_ROUTE arm → `supersedeGovernedTaskOnce` no-op → `updateTask(READY)` → `routeGovernedTask` returns the already-persisted execution via dispatch-intent dedup → `updateTask(RUNNING)` → close-out skipped → `return`.
4. Result: **observe loop permanently starved** (attempt-2 never observed despite finishing at 05:26:30) **and** ~2 entity writes/sec of pure churn (task `version: 7507`).

Trigger sequence: backoff recovery (`WAITING_BACKOFF`) resolves via
`no_pending_backoff` → `RUNNING` while `pending_recovery` is still set — the
compat leg exists exactly for this, but the apply arms cannot close it.

### RC-B — Observation is state-gated (starvation window)

The in-flight observe+settle loop exists **only** inside `runRunning()` —
i.e. only when `rt.state ∈ {RUNNING, WAITING}` *and* sections 1–2 above did
not early-return. `WAITING_BACKOFF`, `RECOVERING`, `RECONCILING`,
`REPLANNING`, `WAITING_APPROVAL` never observe sibling executions at all.
Any recovery chain — especially `WAITING_APPROVAL` (unbounded human wait) —
freezes collection for every other in-flight execution of that mission.

### RC-C — Adapter registry is env-gated (permanent zombie)

`serve-mission-control.mjs:295` registers the Codex adapter only when
`process.env.CODEX_HOME` is set. After a restart without it,
`ReconciliationService.adapterFor` → `adapters.get("CODEX")` → `null` →
`facts.observed_status = null` → `UNKNOWN_SIDE_EFFECT_STATE` → orphan sweeps
re-arm `orphan_recheck_after` every 30 s forever. The journal + result on
disk prove FAILED, but the canonical path only trusts `adapter.observe()` —
which rehydrates from that very journal **when the adapter is registered**.
(Also the reason the 06:29 recovery found `FAIL_CLOSED_ADAPTER_NOT_BOUND`
for both retry routes and had to ABORT.)

### RC-D — No executor→supervisor completion signal

`WAKE_REASONS` includes `EXECUTOR_COMPLETION` / `EXTERNAL_EXECUTOR_EVENT`,
but nothing in the dispatch path emits them; `wake()` only persists a
durable record. Detection latency is therefore "time until the per-mission
observe section is reached" — unbounded under RC-A/RC-B.

## 4. What is NOT the cause

- **Supervisor polling frequency**: the MC loop calls `sup.tick()` every **1 s** (`serve-mission-control.mjs:1530`); polling cadence is not the bottleneck.
- **Executor-side artifact delay**: `finish()` writes journal + `result.json` ~20 s after dispatch — the executor did its job.
- **`collect_execution_result`/`validate_execution_result` cost**: never reached.
- **Result-file trust**: settlement correctly requires adapter-observed terminal state, not file presence — the failure is upstream in *detection reachability*.

## 5. Fix map (implemented in this branch)

| RC | Fix |
|---|---|
| A | `applyPendingRecovery` transitions `RUNNING/WAITING/WAITING_BACKOFF → RECOVERING` before applying, so apply-arm close-outs clear `pending_recovery`. Deadlock eliminated. |
| B | In-flight observe+collect+settle hoisted to `MissionRuntime.tick()` for **every** live runtime state (before the state switch). Failures detected while another recovery is in flight are queued in `rt.deferred_recovery` (dedup by task, barrier-aware drain) instead of overwriting `pending_recovery`. |
| C | `CodexCliExecutorAdapter` registered unconditionally (same pattern as DEVIN): dispatch stays fail-closed via `qualify()` without `CODEX_HOME`; observe/collect/rehydrate work env-free. Orphan sweeps get a bounded unobservable-recheck cap + single durable `EXECUTION_ORPHAN_UNOBSERVABLE` event instead of infinite 30 s churn. |
| D | Adapters emit an `onFinished` callback → `supervisor.wake(mission, "EXECUTOR_COMPLETION")` durable wake record; collection no longer depends on wake delivery (bounded sweep remains the authority). |
| obs | Canonical liveness stamps on `executor_execution`: `observe_count`, `last_observed_at`, `first_terminal_observed_at`, `collection_started_at`, `collection_committed_at`, `collection_attempts`, `settled_at`, `adapter_finished_at` — all persisted through the existing `gate` seam, surfaced via existing execution payloads. |

## 6. Audit R1 remediation (independent review, reproduced findings)

The first implementation re-created starvation *inside* the new sweep — two reproduced defects and their fixes:

- **Deferred-signal starvation** (`LV-9`): the collect loop `return`ed unconditionally after `queueOrStartRecovery`, including when the signal was merely *deferred/deduped* behind an occupied `pending_recovery`. A third sibling's completed result then waited out the entire pending window (up to unbounded `WAITING_APPROVAL`). **Fix:** `queueOrStartRecovery` returns whether a fresh recovery armed; the sweep bails only then, and `continue`s on defer/dedup.
- **Wedged-fault churn** (`LV-10`): a deterministic collect fault (malformed envelope / identity mismatch — exactly the evidence `gate.collect_execution_result` exists to reject) kept sweep eligibility forever, re-faulting every tick and re-minting a fresh `RESULT_SCHEMA` recovery every pending-free window — burning the task's retry budget while later siblings starved behind each `return`. **Fix:** deterministic (`IntegrityError`/`PolicyError`) faults now mark `collect_excluded` on the row (one durable `EXECUTION_COLLECTION_EXCLUDED` evidence entry) and route to `RESULT_SCHEMA` recovery once; the governed retry mints a **new** execution row, so the wedged row can never double-settle.
- **Deferred-queue staleness**: `drainDeferredRecovery` prunes entries whose task reached a terminal state or whose execution already carries a committed `result` before replaying, dedups against the armed pending's `task_id`, and requeues a thrown `startRecovery` with a bounded drain counter + `DEFERRED_RECOVERY_DROPPED` evidence instead of silently losing the signal.
- **Silent observe spins** (`LV-11`): a persistently throwing `observe` is counted on `last_observation.observe_faults` and excluded + escalated to `UNKNOWN_SIDE_EFFECT` at the same bound — no unbounded silent spin.
- **`settled_at` semantics**: the stamp is written only after the terminal disposition is decided (validation PASS → success, terminal non-success → failure mark). A validation-rejected result never carries `settled_at` — rejected evidence is not a settled outcome.
- **Blocking-reason write**: the `COLLECT_FAULT:<code>` hint now writes on the version-fresh row (the pre-fix write used the stale pre-observe snapshot and CAS-failed silently).

Liveness guarantee as corrected: on every live runtime state, each
unsettled, non-excluded, non-barriered execution is observed exactly
once per tick; completing executions settle at the next tick boundary
regardless of armed/deferred recovery, interposing failure signals, or
persistently faulting sibling rows.
