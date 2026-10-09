# P15.10-C — Governed Autonomous Objective Driver

**Risk:** HIGH | **Base:** `0e27bc6` (PR #86 merge) | **Do not merge — independent audit first.**

## A. Implementation summary

Closes the P15.10-B `RECONCILE_ONLY` gap with the missing production consumer: a single opt-in driver that walks the canonical wake chain — `nextFairCandidate → claim(lease+fence) → admit(cost+authority) → runPass(authority_gate) → settle(outcome)` — with zero new authority, planner, router, or cost engine.

**New file** `src/pair/objective-auto-driver.ts` (~620 lines):
- `ObjectiveAutoDriverService` + `ObjectiveAutoDriverRuntime` — bounded tick (`DRIVER_MAX_PASSES_PER_TICK=1`), `inTick` reentrancy guard, `unref()` timer.
- `claim()` refusal = **skip**, not fault (durable reason already in queue rows). Only proven permanent `DriverDenial` → `quarantine()`; unexpected faults → bounded release/retry. Unproven failure is never quarantined.
- `admit()` — atomic pre-spend admission per fence: policy effective → CAS admit receipt `auto-driver-admit:<obj>:<fence>` (idempotent across retry/restart) → `PAIR_COST_HALT` → canonical usage vs all caps → `objective_auto_driver_state` ledger row.
- `usage()` — derived from canonical evidence only: `ceo_decision_attempt.started_by==driver`, `work_open_binding.created_by==driver` ∩ allocation lineage (incl. `delegated_child`), Σ `cost_reservation` (HELD/COMMITTED@reserved, SETTLED@settled, RELEASED skipped). `UNKNOWN`/unbounded billing under a money cap → `DRIVER_COST_UNVERIFIED`, never counted as zero.
- `dispatchCostBound()` — max `reserve_microusd`/`fixed_microusd` over every eligible governed executor (`billingFor(executorId,null)`); any unprovable bound → fail closed.
- `authorityGate(handle)` — injected into `runObjectivePass`; fires **immediately before every side-effect boundary** (runCycle, each runReview, allocateWorkstream, pre-openWorkItem, pre-syncWorkItem, pre-cascade): lease ACTIVE @ same fence + expiry + `policy.evaluate` effective + !costHalt.
- Actor = `objective-auto-driver` literal (`operator:objective-auto-driver` provenance) — never an owner string. Owner-scoped `status()` via `policy.status` (FAIL_CLOSED_POLICY_FORBIDDEN for non-owners). Typed denial vocabulary only: `DRIVER_CAP_EXHAUSTED / COST_UNVERIFIED / COST_HALTED / AUTHORITY_LOST / PASS_FAULT / ADMISSION_DENIED` — raw reasons sanitized before persistence.

**Minimal edits to existing seams:**
- `objective-operating-loop.ts` — optional `authority_gate?: () => void` on `runObjectivePass`; non-function input → `operatingFail`; default noop → **manual ceo-cycle route unchanged**.
- `objective-auto-scheduler.ts` — `status(objectiveId, actor, driver?)` projects truthful `consumer_ready`/`driver_ready`/`driver_missing`; FAULT_LABELS += 6 `DRIVER_*` labels.
- `mission-control-server.ts` — `deps.autoDriver` optional; `GET /api/vnext/objectives/:id/auto-driver` (owner-scoped, 404 when driver absent); auto-scheduler + auto-policy readiness overrides reflect the wired driver (`COST_BINDING_UNVERIFIED` retained — separate claim).
- `serve-mission-control.mjs` — `PAIR_OBJECTIVE_AUTO_DRIVER=1` opt-in gate (**default OFF**); lazy `objectivePassRunner` composes `createDefaultObjectiveOperatingService` (CEO catalog seeded later in boot); `PAIR_OBJECTIVE_DRIVER_MS` interval clamp 1000–300000.
- `index.ts` — export driver module.

**Explicit non-goals honored:** no parallel sibling workstreams, no auto-approve/sign-off/cancel, no second CEO engine, no new planner, no direct Codex/Devin calls from the driver, no cross-objective allocation.

## B. Acceptance matrix

| ID | Implementation | Test | Result | Evidence | Verdict |
|----|----------------|------|--------|----------|---------|
| C01 | Driver absent unless `PAIR_OBJECTIVE_AUTO_DRIVER=1`; runtime OFF | `C01 default OFF` | zero passes without driver | test; live prod :8788 → `/auto-driver` 404 | PASS |
| C02 | `admit()` requires `policy.evaluate` effective + active lease | `C30 no policy` | no claim/act without ENABLED policy | test; live pre-enable fences absent | PASS |
| C03 | claim→admit→pass→settle chain | `C02/C03 full chain` | WAITING_EVIDENCE + admit receipt + driver_state | test + live fences 3–6 both objs | PASS |
| C04 | authorityGate before each boundary; non-effective → throw → release | `C04/C29`, `C05` | lease RELEASED/INVALIDATED; no settle receipt | test + live PAUSED→BLOCKED_AUTHORITY | PASS |
| C05 | `requireRebind` pins (policy_version, owner, terms, objective_version) | `C04/C29` mid-pass drift | stale-fence gate throw | test; scheduler rebind suite | PASS |
| C06 | usage.ceo_calls vs `limits.max_ceo_calls` at admit | `C06/C07 cap` | `DRIVER_CAP_EXHAUSTED` → QUARANTINE | test | PASS |
| C07 | usage.missions vs `limits.max_missions` (+1 pending) | same admit path | cap denial before pass | test + cap code path | PASS |
| C08 | usage.microusd + dispatch bound ≤ `budget_microusd_cap` | `C08 budget cap` | denial incl. in-flight HELD/COMMITTED | test | PASS |
| C09 | UNKNOWN/unbounded bound → `DRIVER_COST_UNVERIFIED` | `C09/C28` | never zero-cost under money cap | test + live quarantine pre-profiles | PASS |
| C10 | `costHaltActive()` at admit + every gate call | `C10 PAIR_COST_HALT` | transient denial → RELEASED retry | test | PASS |
| C11 | pass fault → bounded release; CEO attempt attributed | `C16/C17` | `BLOCKED_RETRY_EXHAUSTED` at max; no replay | test | PASS |
| C12 | work-open receipts + WOB dedup (P15.6) — settle dedup | `C20 settle dedup` | same opId never double-commits | test | PASS |
| C13 | fence baked into handle; stale fence → gate throws | `C14`, `C18/C19` | INVALIDATED lease blocks stale worker | test | PASS |
| C14 | `claim()` CAS on generation; roster single-entry | `C14 two drivers` | loser throws → skip, no double-hold | test | PASS |
| C15 | `nextFairCandidate` persisted round-robin; ≤1 active lease/objective | `C15 fairness` | alternating passes, no starvation | test + live both objs progressed | PASS |
| C16 | settle→durable wait (next_due/wait_kind) → not re-claimable | `C02/C03` post-settle | parked queue, no busy loop | test + live WAITING_EVIDENCE | PASS |
| C17 | `outcomeContinuation` REVIEW_* → owner-attention states | outcome mapping (P15.6) | driver never approves | test + code review | PASS |
| C18 | TARGET_MET_CANDIDATE → BLOCKED_AUTHORITY + OWNER_SIGN_OFF_REQUIRED | `C11 outcome mapping` | owner sign-off preserved | test | PASS |
| C19 | retry_count/backoff [30s,120s,600s] in durable queue row | `C16/C17` + crash tests | survives restart (queue is DB) | test + live restart | PASS |
| C20 | usage() per-objective attribution only; admit receipt per fence | `C20`, usage() | no double-charge, no cross-objective | test + live per-obj receipts | PASS |
| C21 | `authority_gate` optional; manual pass never gated | `C21 manual noop` | manual ceo-cycle unchanged | test + P15.6 regression | PASS |
| C22 | no behavior change to A/B scheduler/policy | full regression | p15-10a/10b/10b-r1 green | verify | PASS |
| C23 | conversation/telegram/mission untouched | full regression | suite green | verify (files unmodified) | PASS |
| C24 | `driver_ready` only when deps.autoDriver wired | `C24 readiness` | false OFF, true when wired | test + live statuses | PASS |
| C25 | deterministic controller E2E on temp SQLite | whole file | 19/19 pass | `pair-p15-10c.test.ts` | PASS |
| C26 | live sandbox E2E, 9 proofs | see §D | all observed | isolated stack :8799 | PASS |
| C27 | denial vocabulary typed; `sanitizeFaultReason` on persistence | `C26 typed labels` | no free-text/secret material stored | test | PASS |
| C28 | model/provider fault → transient release; caps pre-checked | `C16/C17`, `C09` | zero unauthorized spend/dispatch | test + release path | PASS |
| C29 | authorityGate fires pre-side-effect (not just at claim) | `C04/C29`, `C05` | mid-pass revoke aborts safely | test | PASS |
| C30 | driver acts only via policy-effective + leased objective | `C30`, `C22/C23` | actor never owner; no out-of-scope action | test | PASS |

## C. Accounting proof (driver → canonical cost)

- **CEO calls**: `ceo_decision_attempt` rows `started_by=objective-auto-driver` — counted; ChatGPT-subscription codex-cli transport ⇒ provable microusd cost = 0 (no API key path). Cap binds **count**, not money.
- **Missions**: `work_open_binding.created_by=objective-auto-driver` intersected with objective allocation work_items incl. `delegated_child` — counted.
- **Dispatch spend**: `cost_reservation` rows attributed via `mission_id → bound_open → WOB → allocation → objective`. HELD/COMMITTED count at `reserved_microusd`; SETTLED at `settled_microusd`; RELEASED skipped. In-flight liability included in the cap check.
- **Admission is atomic**: receipt `auto-driver-admit:<obj>:<fence>` written through scheduler-protected CAS *before* any pass; same fence → dedup; usage snapshot pinned in the receipt — no check-then-act window.
- **Unprovable cost is never zero**: `UNKNOWN` mode or unbounded METERED_API on any eligible executor under `budget_microusd_cap` → `DRIVER_COST_UNVERIFIED` (permanent, quarantines).
- **Global halt**: `PAIR_COST_HALT=1` or halt file → `DRIVER_COST_HALTED` transient denial — blocks new spend, lease released for later retry.

## D. Live sandbox E2E — Layer 2 (isolated deployment)

Isolated stack on `:8799` (`PAIR_MC_DIR=/home/ubuntu/pair-mc-p15c-test`, token `e2e-p15c-test`); driver ON (`PAIR_OBJECTIVE_AUTO_DRIVER=1`, 2000ms). No production DB, no real objectives, no external posts/Telegram/financial effects. 2 objectives (`OBJ_1c21…fb1`, `OBJ_e73f…e69b`) on `BIZ_01M4GBR2…` with org agent `AGT_01M4GBR60…` (executor_binding=CODEX) and ENABLED auto-policies (max_ceo_calls=4, max_missions=4, max_retries=2, budget cap 5,000,000µ). Executor cost profiles seeded (DSH METERED_API reserve=100,000µ; CODEX/DEVIN SUBSCRIPTION).

| # | Required proof | Evidence | Result |
|---|----------------|----------|--------|
| 1 | Driver starts | boot log `OBJECTIVE AUTO DRIVER: ENABLED (worker=objective-auto-driver:37393)`; post-restart `:42479` | PASS |
| 2 | Canonical wake intake | `STARTUP_RECONCILE`+`POLICY_*` wakes → queue registered (`claimed_generation` 3→10) | PASS |
| 3 | Auto objective pass | `auto-driver-admit:*:3..6` receipts + `auto-driver-state` + outcomes | PASS |
| 4 | CEO via qualified transport | `CCA_…` attempts `model_id=gpt-6.1-sol, provider_id=codex-cli, state=ACCEPTED` (real subscription call) | PASS |
| 5 | Governed mission seam | `OPI_…` work_open_binding `created_by=objective-auto-driver` → `MSN_01M4GBWS3Q…46M`, `MSN_01M4GBZAQW…Z9` both `COMPLETED` | PASS |
| 6 | Cost admission/settlement | `CRSV_GTSK_…` `mission_id=MSN…46M`, `executor=DEEPSEEK_HARNESS`, `COMMITTED`, `reserved=100000`; admit receipts per fence | PASS |
| 7 | B continues when A blocked | A `PAUSED→BLOCKED_AUTHORITY`; B kept claiming → own mission COMPLETED (independent leases) | PASS |
| 8 | Restart no-duplicate | kill→restart (worker 37393→42479); fences monotonic per objective, zero duplicate admit receipts, no replayed missions, states resumed | PASS |
| 9 | Pause/revoke blocks | `pause` → `BLOCKED_AUTHORITY/STATE_PAUSED` at next boundary; persisted across restart | PASS |

Outcome progression observed live: claim → pass → `EXECUTION_EVIDENCE`/`AWAITING_EXECUTION` → mission COMPLETED → KPI review → `INSUFFICIENT_VERIFIED_PROGRESS` → `VERIFIED_KPI_EVIDENCE` wait. The loop ran end-to-end under real governance — no fakes, no bypassed gates.

*Environment note (pre-existing, not driver):* DSH `settings.yaml` is renamed to `.imported` after first boot → restart reports DSH source ABSENT → providers STALE → boot fail-closed. Restore `cp settings.yaml.imported settings.yaml` before restarting a DSH-enabled stack.

## E. Verification

- `npm run verify:change -- --base 0e27bc6… --full` → **READY_FOR_INDEPENDENT_AUDIT** (see `.pair-verification/report.md`)
- Focused: `pair-p15-10c.test.ts` **19/19**; patch-claim required_tests all green
- Regression: P15.10-A/B (+R1/R2), P15.6, P15.5, P15.3, P15.1, P14, cost/recovery/gate, conversation boundary — all green; known-baseline failures unchanged (+3 pre-existing)
- tsc: PASS | build: PASS

## F. Operator instructions

1. **Production stays OFF.** Nothing below is required for normal operation; the driver only exists when explicitly enabled.
2. Enable on a deployment: `PAIR_OBJECTIVE_AUTO_DRIVER=1` (+ optional `PAIR_OBJECTIVE_DRIVER_MS`, default 5000, clamp 1000–300000).
3. Per objective, owner must opt in: configure limits (`expires_at`, `max_ceo_calls`, `max_missions`, `max_retries`, `budget_microusd_cap`) then `enable` — the driver will not act on DISABLED/PAUSED/REVOKED/HALTED/expired/drifted authority.
4. **Every eligible governed executor must have a provable cost profile** before enabling a `budget_microusd_cap` — otherwise admission fails closed `DRIVER_COST_UNVERIFIED` and the objective quarantines (recover: fix profiles, then pause→resume policy to re-bind).
5. Observe: `GET /api/vnext/objectives/:id/auto-driver` (owner only) — admissions/usage/last outcome; `GET …/auto-scheduler` — queue/lease/fence; `GET …/auto-policy` — authority + truthful `driver_ready`.
6. Global kill-switch: `PAIR_COST_HALT=1` (or halt file) → new autonomous spend blocked (transient release).
7. De-quarantine after fixing the root cause: `pause` → `resume` (bumps policy_version → new observation → `WAITING_CONSUMER`).

Completion code: `PAIR_NEXT_P15_10_C_READY_FOR_INDEPENDENT_AUDIT`
