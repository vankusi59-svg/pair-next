# P18.4 — Real Multi-Executor E2E Report

Suite: `src/__tests__/pair-p18-4-real-e2e.test.ts` — 9 scenarios, real
`child_process` workers via the production `CodexCliExecutorAdapter`,
durable `PairEvidenceStore`, journal/result files on disk. Fake CLI
fixtures are used ONLY as the model-facing worker process
(`fake-codex-{fail,flaky,slow,conditional}.mjs`); everything above the
spawn boundary is production code. No external model quota is spent.

## Results — 9/9 pass (standalone ~19.5–21.6s wall)

| Test | What it proves |
|---|---|
| E2E-1 normal multi-step | 3-task dependency chain dispatches real children, completes autonomously on ticks — planner→route→dispatch→observe→collect→settle→downstream |
| E2E-2 concurrent executors | Two distinct real executor adapters (A + explicitly routed B) run sibling tasks concurrently — isolation, complete evidence, no double-settle |
| E2E-3 sibling failure during collection | One execution COMPLETES while its sibling fails; the success still settles promptly (never starved) and the failure reaches a governed signal (pending/deferred/decision). The sibling's FAILED row is required only while the mission stays live — a fast REPLAN→ABORT chain may govern-terminate before the row is first observed, which is canonical, not a defect — bounded drive-until, load-hardened |
| E2E-4 supervisor restart | New runtime/supervisor object graph over the SAME pair.db recovers in-flight state — zero duplicate dispatch (dispatch-intent adoption) |
| E2E-5 deferred handoff crash | `faultInjector` throws inside the drain txn; deferred entry survives + arms on retry; competing sibling churn never loses T2's chain |
| E2E-6 immediate failure during apply | Born-FAILED retry mint continues the chain, bounded by retry budget — no infinite loop, no manual tick |
| E2E-7 UNKNOWN side effect | Missing result.json → UNKNOWN → governed reconcile/abort path; no fabricated success, no auto-replay of side effects |
| E2E-8 operator control center | MC API: `/api/missions/:id/operations` + `/api/operations` return canonical projections; 401 without token and with bad token |
| E2E-9 extended liveness | fail → governed retry → success → downstream completes with ticks only — no restart, no manual collection |

## Load-hardening note

Under full-suite parallel load the fixed tick budgets stretched
(collection phases interleave with sibling retries). The waits now drive
until the canonical witness appears with generous bounds (80–160 ticks /
60s waits) — the assertions themselves are unchanged canonical facts.
Standalone timing is unaffected (~20s).

## Witness-honesty refinement (E2E-3)

A harness run surfaced `failedN=0` on E2E-3 under load. The canonical
state dump showed the truth: the mission reached `FAILED`/`ABORTED` via
a governed `REPLAN→ABORT` decision chain *before* the failing exec row
was first observed — so no FAILED row existed to count, while the
successful sibling had settled COMPLETED promptly. The assertion was
corrected to check the actual contract (sibling settle + governed
signal + settle-witness on every COMPLETED row + no fabricated
outcome), not a timing artifact. Every COMPLETED row must carry
`settle_complete`; RUNNING rows honestly report unobserved.

Separately, a gate run collapsed with 201 "no matching assertion"
suite failures and 12 regression files reporting zero executed tests —
traced to `ENOSPC` on the C: temp drive (~4,700 leaked `mkdtemp` test
dirs consumed it). After cleanup the identical tree passed: patch
claim 6/6, regressions 13/13, invariants 4/4, full suite
PASS_WITH_KNOWN_BASELINE (+133), verdict `READY_FOR_INDEPENDENT_AUDIT`.

## Live-stack validation (separate, manual)

A live `serve-mission-control.mjs` instance (token auth) was driven with
a server-owned mission minted via persisted `metadata.llm_plan`
(legitimate plan authority — the deterministic template planner was NOT
reintroduced). Canonical state observed through the real API:

- T1: PAIR_NATIVE execution COMPLETED → committed → `settle_complete` →
  derived stage `SETTLED`; observed latency 986ms, collect 5ms, settle 29ms.
- T2: genuine UNKNOWN → `RECONCILIATION_REQUIRED` decision → ABORT;
  `pending_recovery` + decision history exposed by `recovery_ops`.
- `/api/operations` returned honest zero-state for pressure counts and
  null latencies where no evidence existed.

Planner correctly failed closed (`FAIL_CLOSED_PLANNER_NO_ELIGIBLE`) when
no qualified model route existed — documented expected behavior, not a
defect.
