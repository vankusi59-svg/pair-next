# PAIR OS vNext — P9 Operationalization: Long-Running Mission Loop + Mission Control + Devin Executor

## A. Exact starting authority

- Repository: `/home/ubuntu/repos/pair-os-vnext-lab` (fork `vankusi59-svg/kingpair`, branch `lab`)
- Starting HEAD: `87c978b` (P8)
- Lineage: `d8f8168 → 8ab970c → 4aef764 → c9fc646 → de46191 → bb9d0e8 → c6f59ac → e40bbdc → 2ab56d0 → 8ab1736 → 87c978b`
- Working tree clean at start; upstream Automaton `~/repos/automaton` @ `d8f8168` and PAIR donor `a557df2` untouched.
- Final HEAD: `P9 commit` (see §AI)

## B. Implementation commit

Single P9 commit on `lab` atop `87c978b`.

## C. Files added/modified

Added (10):
- `src/pair/mission-runtime.ts` — durable runtime state machine + step driver (~1270 LOC)
- `src/pair/mission-supervisor.ts` — wake surface + fairness-ordered sweep + restart rehydrate
- `src/pair/mission-scheduler.ts` — DAG scheduling + durable `scheduled_action` backoff
- `src/pair/mission-observability.ts` — audit timeline / health / metrics projections
- `src/pair/mission-control.ts` — read models + operator actions over canonical services
- `src/pair/mission-control-server.ts` — node:http JSON API + functional HTML UI
- `src/pair/approval-queue.ts` — scope-digest-bound approvals, TTL expiry, supersede
- `src/pair/devin-executor.ts` — DEVIN executor adapter (REMOTE_API transport, governed chain)
- `src/pair/selfmod-bootstrap.ts` — deterministic worktree bootstrap for self-mod candidates
- `src/pair/promotion-service.ts` — governed promotion receipts, operator boundary
- `src/__tests__/pair-p9.test.ts` — 47 deterministic tests (§36 items 1–50 mapped, §37 E2E, §40 Mission Control E2E)
- `src/__tests__/pair-p9-live.test.ts` — §38 real multi-executor E2E + Devin gate test

Modified (5):
- `src/pair/mission-router.ts` — `executor_constraint`/`exclude_executors` pre-filter; re-route seam through `routeGovernedTask`
- `src/pair/recovery-controller.ts` — `budget_extension` merge; reconciliation-required wiring
- `src/pair/multi-executor.ts` — `registerGovernedExecutors` gains DEVIN (RTE_DEVIN_API, REMOTE_GATEWAY_API, AMBIENT_FIXED)
- `src/pair/executor-registry.ts` — concurrency descriptor plumbing
- `src/pair/index.ts` — exports

## D. MissionRuntime architecture

`MissionRuntime.tick(missionId)` is a pure state-machine step driven by `supervisor.tick()` — every call reads the durable `mission_runtime` row, executes exactly one state handler, persists the transition, returns. States: `CREATED PLANNING READY RUNNING WAITING WAITING_BACKOFF WAITING_APPROVAL RECONCILING REPLANNING RECOVERING PAUSED COMPLETED FAILED CANCELLED ABORTED` (15+, PAUSED included). Illegal transitions throw `FAIL_CLOSED_MISSION_TRANSITION` before write. Handlers: PLANNING → `validatePlanProposal` + `commitPlan` (advisory `plannerAdvisor.advise` in `adviseSafely`, exceptions swallowed — advice can never break orchestration); READY → mission CREATED/READY → RUNNING then runtime RUNNING (double transition required because `READY→COMPLETED` is illegal); RUNNING → `pickRunnable` → `routeGovernedTask` → gate → dispatch → observe → `settleExecution`; WAITING_BACKOFF → due `scheduled_action` check → RECOVERING; RECOVERING → `applyPendingRecovery` (RETRY/RE_ROUTE re-route via router, terminal results settled inline); RECONCILING → `runReconciliation`; REPLANNING → `runReplan`; WAITING_APPROVAL → `checkPendingApproval`. `maybeComplete` marks mission FAILED only when all tasks terminal and no in-flight executions — fixed after the live failure below showed READY→COMPLETED path never reached RUNNING.

## E. MissionSupervisor architecture

Owns the wake surface only: `wake(missionId, reason, detail)` persists `supervisor_wake` rows (11 persisted reasons: MISSION_CREATED, TASK_RUNNABLE, EXECUTOR_COMPLETION, RECOVERY_TIMER_DUE, PROVIDER_MODEL_HEALTH_CHANGE, APPROVAL_GRANTED, RECONCILIATION_RESULT, DEPENDENCY_COMPLETED, MISSION_RESUME, EXTERNAL_EXECUTOR_EVENT, RESTART_REHYDRATE). `tick()` sweeps all non-terminal `mission_runtime` rows in deterministic fairness order (oldest `entered_at`, then `mission_id`), calls `runtime.tick` per mission inside try/catch so one mission's failure never blocks siblings. `resume()` → `recovery.planRestartRecovery(reconcileFn)` then wakes each non-terminal mission with RESTART_REHYDRATE — idempotent, safe on every boot. No in-memory timers are authoritative.

## F. Mission state machine

Mission transitions use canonical `MISSION_STATUS_TRANSITIONS` (CREATED→READY|CANCELLED; READY→RUNNING|PAUSED|CANCELLED; RUNNING→PAUSED|COMPLETED|FAILED|CANCELLED; PAUSED→RUNNING|CANCELLED|FAILED). Runtime transitions have their own table in `RUNTIME_TRANSITIONS`; both fail closed. Every transition emits a `MISSION_TRANSITION`/`MISSION_RUNTIME_TRANSITION` event with actor `PAIR_MISSION_RUNTIME`.

## G. Scheduler architecture

`MissionScheduler` persists `scheduled_action` rows (status SCHEDULED→READY→RUNNING→COMPLETED|CANCELLED). `pickRunnable(missionId)` returns runnable tasks under `mission_concurrency` limit with deterministic ordering. `markScheduledAction`/`supersedePending` give durable backoff: a retry is a DB row with `due_at`, so a process restart never loses a pending retry. The scheduler never chooses executors.

## H. DAG scheduling

`depends_on` edges are enforced structurally: `pickRunnable` filters to tasks whose deps are COMPLETED; `requestFor` builds `dependency_outputs` by resolving each dep's COMPLETED `executor_execution` to `{from_task_id, from_task_key, execution_id, result}` — downstream tasks receive governed outputs, never raw executor handles.

## I. Replan driving loop

REPLAN decisions transition runtime → REPLANNING; `runReplan` re-invokes the planner with `superseded_tasks` = unfinished tasks of the old revision, validates the proposal, supersedes pending approvals and scheduled actions with reason PLAN_SUPERSEDED, then `commitPlan` (new revision; old revision immutable). Runtime → READY → RUNNING resumes the loop. Bounded by `max_replans` (default 2) in RecoveryController.

## J. Reconciliation barrier

Structural, not advisory: `startRecovery` case RECONCILIATION_REQUIRED writes `rt.barriers[taskId] = {kind:"RECONCILIATION", execution_id, recovery_id}` and transitions RECONCILING. `runReconciliation` maps receipt outcomes: CONFIRMED_NOT_EXECUTED → RECOVERING/RUNNING (safe redrive); CONFIRMED_RUNNING → RUNNING (re-adopt); CONFIRMED_COMPLETED → settle + RUNNING; CONFIRMED_FAILED → settle + RECOVERING; UNKNOWN_SIDE_EFFECT_STATE → `approvals.request(RECONCILE_UNKNOWN_SIDE_EFFECT)` + WAITING_APPROVAL — blind replay is never possible. Defect found live: the barrier write raced the pending_recovery `store.put` with a stale version → VERSION_CONFLICT swallowed the barrier and the mission fast-failed to FAILED; fixed by re-reading the entity before the barrier put (same pattern as HUMAN_APPROVAL).

## K. Backoff scheduler

Recovery decisions carry `backoff_ms` (exponential, base 1000ms, cap 30000ms). Non-zero backoff → `scheduler.schedule({mission_id, task_id, recovery_id, action, due_at, payload})` + runtime WAITING_BACKOFF; the tick compares `due_at` against `now` and only then moves RECOVERING. Restart-safe because `due_at` is a row, not a timer.

## L. Restart/recovery

Restart survival proven twice: deterministic tests swap fresh `MissionRuntime`/`MissionScheduler`/`ApprovalQueue` instances onto the same store mid-mission; §38 live run swaps a fresh supervisor mid-flight (`sup2.resume()` → RESTART_REHYDRATE wake → rehydrates checkpoint, no duplicate dispatch — `executor_execution` idempotency keys and `dispatched` receipts prevent a second spawn).

## M. Approval queue

`ApprovalQueue` persists scope-digest-bound approvals: `request({approval_type, requested_action, scope, mission_id, task_id, reason, risk_class, ttl_seconds})` digests the scope; `decide(id, operatorId, APPROVED|DENIED, scope)` re-digests and rejects scope mismatch (409 path in §40 test); `approvedFor(scopeDigest, type)` is the only consumption; `hasPendingBlock`/`listPending` feed the runtime; `supersede` clears stale approvals on replan. Expiry via `ttl_seconds` → EXPIRED treated like DENIED → abort.

## N. Mission Control backend

`MissionControl` composes canonical services only — no parallel mutation path: `startMission`, `pauseMission`, `resumeMission`, `cancelMission`, `approve`/`deny` (routed to ApprovalQueue), `getMission`, `listTasks`, `timeline` (projection), `health`. Exposed over HTTP by `createMissionControlServer` (node:http): JSON endpoints require an operator authority header; unauthenticated POST → 403; scope-mismatched approve → 409 (proven in §40 E2E against a real listening server on port 0).

## O. Mission Control UI

Functional HTML/JS UI served by the same server: mission list + detail, runtime state, task DAG statuses, pending approvals with approve/deny buttons wired to the API, live health view. No framework dependency; operator authority token entered in UI is sent as the API header — credentials never stored server-side.

## P. Audit timeline

`MissionObservability.timeline(missionId)` is a pure projection over `store.listEvents` + evidence — interleaves mission/task/runtime transitions, routing decisions, gate verdicts, dispatch/collect/validate events, recovery decisions, wake rows, approval lifecycle ordered by `seq`. Nothing is written by the observability layer.

## Q. Operational health

`health()` projects per-mission health READY/DEGRADED/UNAVAILABLE/BLOCKED/UNKNOWN plus executor health from descriptors + route ledger — a projection, never a mutation. Provider/model health-change wakes are persisted (PROVIDER_MODEL_HEALTH_CHANGE) but never mutate qualification state — verified by test.

## R. Concurrency/fairness

`mission_concurrency` gates parallel dispatches per mission (§38 uses 1 for deterministic ordering); executor `max_concurrency` is enforced inside router gate 10 — `CAPACITY_EXHAUSTED:n/m` surfaces inside `FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR.rejected_executors` and the runtime treats it as skip-not-recovery (loop `continue`, no recovery decision). Fairness = oldest-entered-first across missions, stable `mission_id` tiebreak — proven by the ≥3-missions isolation test (each mission's store rows, wakes, and receipts are scoped by mission_id; no cross-talk).

## S. Devin environment audit

DEVIN is reachable from this environment only via the Devin REST API (`POST https://api.devin.ai/v3/organizations/{org_id}/sessions`, `GET /v1/sessions/{id}`, `POST /v1/sessions/{id}/messages`, Bearer `cog_` token, org `org-95faaf8c42dc4b2eb6d9e17a5fc5fe90`). The on-box `devin` binary is the Devin editor CLI, not a task API — audited and rejected as the transport. Credential mechanism: `PAIR_DEVIN_API_KEY` env (PAT `cog_...` or service-user key with `org.devins.use`). **Not provisioned in this session** — user was offered PAT creation (Settings → Devin API → PATs) and VM-browser login; PAT not yet created. No Devin credential appears anywhere in code, tests, journals, evidence, or this report.

## T. Devin adapter architecture

`DevinExecutorAdapter` (canonical id `DEVIN`, adapter_id `devin_api`, transport `REMOTE_API` added to `QUALIFIED_TRANSPORTS`, binding `AMBIENT_FIXED`, route `RTE_DEVIN_API` kind `REMOTE_GATEWAY_API`): dispatch = create governed session via v3 with deterministic idempotency key + tags carrying `execution_id`/`governed_task_id`/`mission_id`; observe = poll session status; collect = map status to canonical result; cancel = supported. PAIR `EXE_` ids stay canonical; the remote Devin session id is stored as `external_session_id` supplemental evidence — never used for routing or identity. All HTTP is behind an injectable `DevinFetch` seam; deterministic tests inject a scripted fetch, live tests use real `fetch`.

## U. Devin qualification

Deterministic contract proven in `pair-p9.test.ts`: probe/qualify/register/routable only after probe+qualification PASS (Configured ≠ routable); canonical `EXEC_`/`EXE_` identity binding; governed chain enforced (route → gate → dispatch → observe → collect → validate → evidence). Capability `REMOTE_CLOUD_TASK_EXECUTION` routes only to DEVIN.

## V. Devin live gate result

**`DEVIN_INTEGRATION_COMPLETE_LIVE_BLOCKED_EXTERNAL`** — integration is complete and contract-tested, but live qualification is externally blocked: no `PAIR_DEVIN_API_KEY` exists. The live gate test asserts the failure honestly: probe → `DEVIN_CREDENTIAL_NOT_RESOLVABLE`, executor not routable, no session created, no fake success. Setting the env var flips the gate live with zero code changes.

## W. Four-executor registry

Final portfolio: PAIR_NATIVE (AUTOMATON_WORKER/IN_PROCESS, caps FILE_OPERATIONS+AUTOMATON_TASK_EXECUTION, priority 100), DSH (ACP_STDIO, 5 caps, priority 10), CODEX (CLI JSONL, 6 caps incl. PYTHON_EXECUTION, priority 50), DEVIN (REMOTE_API, REMOTE_CLOUD_TASK_EXECUTION). `registerGovernedExecutors` registers executor + route + binding per executor in one canonical step.

## X. Long-running mission E2E (§37)

Deterministic `runUntilSettled` loop drives CREATED→PLANNING→READY→RUNNING→per-task route/gate/dispatch/observe/collect/validate→COMPLETED across a multi-task DAG, including a restart mid-mission and a REPLAN cycle — all transitions persisted and replayed identically after instance swap.

## Y. Real multi-executor E2E (§38)

**PASS (74.5s, then re-verified after fixes).** One real mission: T1 AUTOMATON_TASK_EXECUTION → PAIR_NATIVE writes `p9_t1.txt`; T2 PYTHON_EXECUTION → real `codex exec` writes `p9_t2_codex.txt` reading T1's `dependency_outputs`; T3 SHELL_EXECUTION → real `dsh --profile acp` (Groq `openai/gpt-oss-20b`) writes `p9_t3_dsh.txt`; mid-run supervisor restart (`sup2.resume()`); per-task executor selection proven via `routing_decision` receipts (natural capability routing, no forced executor); canonical `EXE_` ids; real artifacts on disk; no duplicate dispatch. T4 REMOTE_CLOUD_TASK_EXECUTION/DEVIN is included only when `PAIR_DEVIN_API_KEY` qualifies — absent here, honestly reported.

Notably this run exercised a **real failure path**: T3 hit `ACP_REQUEST_TIMEOUT` on `session/prompt` → TIMEOUT → RECONCILIATION_REQUIRED → (pre-fix) exposed the stale-put barrier bug → fixed → post-fix the barrier/reconcile path works as designed.

## Z. Mission Control E2E (§40)

Real `createMissionControlServer` on ephemeral port: unauthenticated POST → 403; approve with wrong scope → 409; correct operator authority → pause/resume via API endpoints actually drive runtime PAUSED→RUNNING; mission list/detail/health/timeline endpoints return canonical projections.

## AA. Selfmod worktree-validation operationalization

`selfmod-bootstrap.ts` gives SelfImprovementController a deterministic worktree bootstrap (git worktree at pinned parent commit outside the repo) so P8's patch→validate→verify→promotion pipeline runs end-to-end under the runtime; canonical repo is never touched.

## AB. Promotion operational boundary

`promotion-service.ts` issues promotion receipts only via `OPERATOR_AUTHORIZED_PROMOTION` — no auto-merge path exists; `reject()`/`MERGED` path fixed for the store's optimistic-version contract (`payload.version === expectedVersion === storedVersion`) after a real VERSION_CONFLICT cascade was reproduced.

## AC. Security tests

Operator-authority enforcement (403/409), scope-digest binding on approve/deny, fail-closed illegal transitions (READY→COMPLETED rejected), barrier-forbidden blind replay (UNKNOWN→approval, never redrive), no credential surfaces anywhere.

## AD. Secret leak scan

1,016 files across 15 `pair-p9-*` journal/evidence/db roots scanned for `cog_*`, `sk-*`, `gsk_*`, and the literal `GROQ_API_KEY` value → **0 hits**. `git diff` + new test/adapter sources scanned → clean. Env var *names* (e.g. `credential_env`) appear where required; values never.

## AE. Performance observations

Deterministic suite: 47 P9 tests in ~0.5s; full deterministic regression 62 files / 1,575 tests in ~12s of test time. Live §38 E2E ~75s dominated by real Codex (~10s) and DSH turns (~60s); p51-live full 12-test sweep ~509s. Observations only — no tuning performed.

## AF. P2–P8 regression results

- `pnpm typecheck` — clean. `pnpm build` — clean.
- Deterministic (P2–P9 + upstream suite): **62 files / 1,575 tests, 0 failures** — `context-hardening.test.ts` excluded (upstream hang, proven at P1, untouched).
- Live suites with real env: `pair-p51-live` **12/12**, `pair-p6-live` **9/9**, `pair-p7-live` **1/1**, `pair-p8-live` **1/1**, `pair-p9-live` **2/2**.
- Caveat preserved: deterministic P5 tests assert the default DSH route (`deepseek-official`) — run them without `PAIR_DSH_MODEL_ROUTE` exported (env-dependent probe records `GROQ_API_KEY` as `credential_env` name when the Groq route is set).

## AG. Defects repaired (minimal, reproduced, narrowly scoped)

1. `mission-runtime.ts` READY case — stale `mission` snapshot skipped CREATED→READY→RUNNING chain → illegal READY→COMPLETED (21 deterministic failures; fixed by re-reading status after each transition).
2. `mission-runtime.ts` RECONCILIATION_REQUIRED — barrier written to a stale entity after pending_recovery `put` → VERSION_CONFLICT swallowed → barrier lost → mission fast-failed (found by the live §38 run; fixed by fresh-entity put, same pattern as HUMAN_APPROVAL).
3. `mission-runtime.ts` recovery RETRY/RE_ROUTE — terminal re-dispatch results never settled → task stuck RUNNING (fixed via `settleExecution` in `applyPendingRecovery`).
4. `mission-runtime.ts` dispatch loop — `CAPACITY_EXHAUSTED` inside FAIL_CLOSED rejection incorrectly entered recovery (fixed: skip, not recover).
5. `mission-runtime.ts` pause() — READY missions ignored (fixed: READY|RUNNING→PAUSED).
6. `promotion-service.ts` — `store.put` optimistic-version contract violated on reject/merge paths → VERSION_CONFLICT (fixed: `payload.version === expectedVersion`).
7. `pair-p9-live.test.ts` — `ReconciliationService` constructed with empty adapters map → `facts.adapter:null` → false UNKNOWN (fixed: real adapters map).

No test was modified to make it pass; each fix has regression coverage and preserves the frozen authority split.

## AH. Remaining gaps for P10

- `PAIR_DEVIN_API_KEY` provisioning → flip DEVIN gate from `DEVIN_INTEGRATION_COMPLETE_LIVE_BLOCKED_EXTERNAL` to `DEVIN_LIVE_QUALIFIED`; then a real T4 can join §38.
- Mission Control UI is functional, not styled; multi-operator sessions/websockets deferred.
- `context-hardening.test.ts` upstream hang remains untouched.

## AI. Final HEAD / working-tree state

- Commit: P9 commit on `lab`, pushed to `origin` (`vankusi59-svg/kingpair`, branch `lab`).
- Tree: clean at commit; only intended sources/tests/report modified.
- Upstream `~/repos/automaton` and donor worktree untouched.

## Final classification

**P9_OPERATIONALIZATION_PASS_WITH_EXTERNAL_DEVIN_BLOCKER_READY_FOR_P10**
