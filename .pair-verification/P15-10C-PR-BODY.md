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

---

---

## R1 remediation — F1: lease heartbeat + fenced post-await commit (HEAD f3abd00)

**Root cause (verified by failing tests before patching — commit dee91f9):** the autonomous lease expired 60s after claim while a CEO model invocation may run up to the configured 900s timeout; nothing renewed it, and nothing revalidated autonomous authority inside the serialized commit transaction after the model await — a PAUSE/REVOKE/expiry landing mid-call still committed the decision, workstream decomposition, and downstream mission authority.

### F1-A — bounded lease heartbeat
- Driver starts an unref'd `setInterval` at **20_000ms** ONLY after a valid claim, calling the existing `scheduler.renew(handle)` — every renewal re-proves token hash, fence, worker/boot identity, claimed generation, expiry, and policy/owner/terms/objective pins inside `currentLease`. No heartbeat before claim, no lease creation, no DB write inside the existing 15s no-op window.
- Retryable SQLite contention (`isSqliteContentionError`) defers to the next tick; any other renewal fault marks the worker unauthorized and aborts settlement — the pass is never settled under a lost lease, and the external model call is never assumed stopped.
- The timer is stopped in `finally` on every exit path — no leak past settle/release/exception, no renew after stop or fence loss.

### F1-B — bounded claim-time lease lifetime (not a TTL raise)
- `claim(..., { max_lifetime_ms })` — optional bound persisted on the lease row; **default 300_000** (exact P15.10-B behavior), min 60_000, absolute cap **960_000**; invalid values fail closed at claim.
- Driver binds `ceoTimeoutMs + 60_000 finalization allowance` (validated 5_000–900_000, mirrors `PAIR_CEO_CLI_TIMEOUT_MS` bounds) → default bound **360_000**, max **960_000** — covers the configured CEO timeout + bounded finalization, never infinite renewal, never a global 300s TTL for all leases.
- `renew()` enforces the per-lease bound; expiry/TTL still 60s.

### F1-C — fenced commit guard inside the commit transaction (mandatory)
- `ceoCycle.runCycle` accepts optional `autonomous_commit_guard` invoked **FIRST inside the same serialized `store.immediate` transaction** that performs the final post-await commit — before re-observe, decision `put`, workstream decomposition, and attempt settle. A throw rolls the whole commit back; the invoked attempt then settles **REJECTED** through the existing canonical path — canonical attempt accounting + terminal/UNKNOWN semantics preserved, no blind replay, zero new decision/binding/mission.
- `runReview` forwards the guard verbatim (identical protection on the review-driven CEO path); `pass()` wires `authorityGate` into both CEO boundaries; manual CEO callers omitting the param are unchanged.

### F1-D — await-boundary audit
- New driver deps: `ceoTimeoutMs` (env-validated at boot via `ceoCliTimeoutMs()`) and `reconcileStaleAttempts(objectiveId)` — invoked pre-admission so a restart never re-invokes while an attempt is STARTED/UNKNOWN (recovery only through canonical settle anchors). `createDefaultObjectiveOperatingService` now also returns `ceoCycle`; serve wires both lazily.
- Two-connection fencing proof: after worker A's lease expires and worker B (separate SQLite connection, separate service stack) claims fence+1, A's handle cannot renew or settle. Heartbeat of worker A cannot renew B's lease (token/fence/identity re-proof). Settle dedup stays per-fence — no double settle.

### R1 test evidence — `src/__tests__/pair-p15-10c-r1.test.ts` (10 tests, all PASS)
| Test | Proof |
|---|---|
| R1-F1a | >60s model call keeps lease alive via heartbeat; exactly-once settle; ≥2 RENEW receipts on canonical rows |
| R1-F1b (driver) | owner pause mid-await → pass aborts, objective QUARANTINED, zero SETTLE receipts |
| R1-F1b (service) | guard fires inside commit txn → post-revoke commit blocked; attempt REJECTED; zero decision/binding rows |
| R1-F1c | missed heartbeat → lease expires → late worker cannot settle; owner de-quarantine → new worker reclaims; exactly one SETTLE |
| R1-F1d | two independent SQLite connections: A loses lease → B claims fence+1 → A cannot renew/settle |
| R1-F1e | heartbeat lifecycle: contention retryable, zero renews after settle, no timer leak |
| R1-F1e2 | heartbeat stops after pass fault; stale-authority renew → permanent loss path |
| R1-F1f | bounded lifetime: default 300s enforced; driver bound 960s enforced; bad bounds fail at claim; invalid ceoTimeout rejected |
| R1-F1d2 | worker A's heartbeat cannot renew B's lease |
| R1-F1d3 | restart re-run while invocation in flight → `CEO_DECISION_INFLIGHT`, zero second model call |

Deterministic clock + fault injection; every proof reads canonical DB rows (lease/wake/receipt/decision/attempt), not timers alone.

### Verification (R1)
`npm run verify:change -- --base 0e27bc6ee236d82633d4aee321ba9cd264adc0c3 --full`
→ **READY_FOR_INDEPENDENT_AUDIT** — claim PASS, invariants 4/4, claim tests 8/8, regression 21/21, tsc+build PASS, full suite PASS_WITH_KNOWN_BASELINE (+3 pre-existing).
Regression: p15-10c 19/19, p15-10b 14/14 + r1, p15-10a 44/44, p15-3 102/102, p15-5 58/58, p15-6 69/69.

**Baseline:** audited HEAD `7ea35b2` → R1 HEAD `f3abd00`. BASE `0e27bc6`.
**Remaining risks:** F2 (route-level cost bound) and F3 (readiness projection) — explicitly out of scope per mandate, still pending independent audit findings.

**Completion code:** `PAIR_NEXT_P15_10_C_R1_HEARTBEAT_PENDING_FINAL_AUDIT`
**DO NOT MERGE. DO NOT DEPLOY. DO NOT ENABLE AUTONOMOUS DRIVER IN PRODUCTION.**

---

## P15.10-C R2 — FENCED AUTHORITY CLOSURE (HEAD `7f4c4aa`)

Independent-audit remediation for residual F1 findings. All three classified **CONFIRMED** by pre-patch reproduction (6 R2 tests failing on `f3abd00`), then fixed minimally and re-proven.

### Per-finding verdict

| Finding | Verdict | Pre-patch evidence | Fix |
|---|---|---|---|
| F1.1 — commit guard lacks claimed-version binding | **CONFIRMED** | R2-F1a: PAUSE→RESUME mid-await → effective policy at V+2 → decision committed under stale authority | `scheduler.assertLeaseAuthority(handle)` — narrow read-only assertion reusing the single `currentLease` proof (state/fence/worker/boot/token/generation/checkpoint/expiry/lifetime + policy_version/terms_digest/owner/objective_version pins); `authorityGate` calls it first |
| F1.2 — review commit txn unguarded | **CONFIRMED** | R2-F1d/e/f: revoke between CEO decision commit and `commitReview` → review receipt + strategy revision still landed | `commitReview` accepts the same `autonomous_commit_guard`, fired FIRST inside its `store.immediate`; forwarded from `runReview` input; deterministic zero-model checkpoints equally covered |
| F1.3 — lease outlives absolute lifetime | **CONFIRMED** | R2-F1g/h: renew at T−10s stamped `expires_at` = T+50s past the 60s bound; post-deadline settle passed | absolute lifetime enforced inside `currentLease` (covers renew/settle/assert); `expires_at` clamped at `started_at + max_lifetime_ms` |

### R2 tests (`src/__tests__/pair-p15-10c-r2.test.ts` — 10/10 PASS, canonical DB evidence)

- **F1a** pause→resume mid-await → FAULT, zero decisions, attempt REJECTED, zero settles
- **F1b** terms/limits drift mid-await → FAULT, zero decisions (pre-existing stale-observation catch, regression proof)
- **F1c** genuine stale-fence handle → assert/renew/settle all throw
- **F1d** review rolls back after mid-commit revoke; earlier decision remains legitimately committed; guard invoked in BOTH txns
- **F1e** strategy revision never lands on authority loss
- **F1f** deterministic checkpoint (AWAITING_PROGRESS, zero model calls) guarded
- **F1g** renew cannot stamp expiry past absolute deadline
- **F1h** post-deadline assert/renew/settle all blocked even with pending expiry
- **F1i** two independent SQLite connections — genuine fencing
- **F1j** manual CEO/review callers without guard unchanged

### Invariants

- Old fence / old policy_version / old terms_digest cannot commit — pinned at claim, re-proven inside every commit txn.
- Revoke or pause blocks new side effects at BOTH commit boundaries (decision + review).
- Absolute lifetime bound enforced at the canonical lease validation boundary — no unbounded lifetime; TTL stays 60s, heartbeat 20s.
- Manual (non-guard) callers byte-identical semantics.
- No parallel validator — `assertLeaseAuthority` wraps `currentLease` only.

### Verification

`verify:change --base 0e27bc6 --full` → **READY_FOR_INDEPENDENT_AUDIT** (HIGH). tsc + build PASS. Full suite +3 known baseline. Regression: p15-10c 19/19, R1 10/10, p15-3 102/102, p15-5 58/58, p15-6 69/69, p15-10a/10b PASS.

Remaining: F2 (route-level cost bound), F3 (readiness projection) — out of R2 scope, pending audit.

---

## P15.10-C R3 — COST AUTHORITY & READINESS CLOSURE (HEAD `d6b7c52`)

Mandate: verify + minimal-patch F2 (route/task-level cost liability), F3 (truthful readiness), correct one F1b coverage gap. Prepatch repro: **12/14 R3 tests FAILED** before any fix — both defects CONFIRMED, not suspected.

### Finding verdicts

| Finding | Verdict | Root cause | Fix |
|---|---|---|---|
| F2 route/task liability | **CONFIRMED → FIXED** | `assertAndReserve` knew the governed task's real route/executor identity but summed only business/department/agent/mission scopes — the objective cap never bound at the real pre-spend boundary. Driver bound was executor-only (`billingFor(executorId, null)`), missing pricier route/model profiles. | Objective cap enforced **inside the same atomic check-and-reserve transaction**: lineage resolved fresh in-txn (`mission.bound_open_id → work_open_binding → workforce_allocation → oap:<oid>.limits.budget_microusd_cap`); attributed liability (HELD/COMMITTED @reserved, SETTLED @settled, RELEASED skipped) + new reservation > cap → `FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED`; UNKNOWN/unbounded under cap → `FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED` (never $0). Driver `dispatchCostBound` now route-aware over every reachable executor→route/model profile; remains a **preliminary** admission check. No second cost engine; P13 hard-stops untouched. |
| F3 truthful readiness | **CONFIRMED → FIXED** | `driver_ready` was `driver?.enabled === true` — wiring, not evidence. | New `driver.readiness(objectiveId, actor)` derives runnable truth **only from canonical evidence**: scheduler cursor READY + policy effective + queue not QUARANTINED/BLOCKED_AUTHORITY + provable cost binding + budget room, with typed reasons. `scheduler.status` and both MC routes consume it. `driver_integrated` added (deployment fact); `driver_ready`/`objective_runnable` = runnable; `driver_missing` carries real reason codes. Backward compatible. |
| F1b coverage | **CONFIRMED → CORRECTED** | R2 drift test called `configure` on ENABLED policy — invalid transition, vacuous. | Test now uses the only legitimate re-bind path (`disable→configure→enable` mid-await) — real policy_version bump + fresh terms pin while the old worker is in-flight; commit guard still fences it. F1 impl untouched. |

### F2 test evidence (prepatch FAIL → postpatch PASS)

- **F2a** route profile (300k) pricier than executor (50k) under 200k cap → denied at reserve; executor-bound alone would have admitted.
- **F2b** two tasks on one mission: 300k + 300k > 600k cap → second denied; first stays HELD.
- **F2c** two **separate SQLite connections** race the same budget → exactly one HELD reservation, loser denied atomically.
- **F2d** UNKNOWN/unbounded billing under cap → `FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED`, never $0.
- **F2e** HELD retry → `FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS` (no new authority); COMMITTED → idempotent adopt same row; SETTLED 300k still counts → next 300k denied over 500k cap.
- **F2f** objective A's 300k never charges B — B reserves under its own cap; A's second task denied.

### F3 readiness truth table (all PASS)

| driver | scheduler | policy | cost binding | runnable |
|---|---|---|---|---|
| OFF | — | — | — | false, `AUTO_DRIVER_NOT_INTEGRATED` |
| ON | not READY | — | — | false, `SCHEDULER_NOT_READY` |
| ON | READY | DISABLED/PAUSED/EXPIRED | — | false, `POLICY_NOT_EFFECTIVE` |
| ON | READY | effective | unprovable | false, `COST_BINDING_UNVERIFIED` |
| ON | READY | effective | provable + room | **true** |
| ON | READY | effective | quarantined / cap exhausted | false, `OBJECTIVE_QUARANTINED` / `BUDGET_EXHAUSTED` |

Owner-scoped read proven; non-owner denied `FAIL_CLOSED_POLICY_FORBIDDEN` before any driver state is read.

### Diff (R3 delta on `60ae17e`)

`+250/−49`, 8 files: `cost.ts` (+122: in-txn objective scope check + 2 lineage helpers + objective violation path), `objective-auto-driver.ts` (route-aware bound + `readiness()`), `objective-auto-scheduler.ts` (status runnable semantics), `mission-control-server.ts` (both routes consume real readiness), `pair-p15-10c-r3.test.ts` (+450 new repro suite), R2-F1b + C24 test corrections, patch-claim/notes.

### Verification

- `verify:change --base 0e27bc6 --full` → **READY_FOR_INDEPENDENT_AUDIT** (claim `P15_10_C_R3_COST_READINESS_CLOSURE`)
- Focused: r3 **14/14**, 10c+r1+r2+p13 **106/106**, p15-3/5/6/10* **360/360**
- tsc PASS, build PASS, full suite PASS_WITH_KNOWN_BASELINE (+3 pre-existing)
- R1/R2 audited patches kept verbatim; driver remains opt-in OFF.

**No merge. No deploy. `PAIR_OBJECTIVE_AUTO_DRIVER` not enabled in production.**

---

## R4 — Final readiness & cost proof (`b67f108`)

Targeted audit remediation; every fix proven by **prepatch FAIL → postpatch PASS** (12/17 R4 tests failed pre-patch against R3 code).

| Finding | Verdict | Evidence |
|---|---|---|
| F3 readiness vs claim() | **CONFIRMED → FIXED** | readiness() checked only quarantine/blocked queue state; claim() also requires WAITING_CONSUMER + pending generation + next_due + cooldown + authority pins + no active lease. Prepatch: 8 cases reported READY while claim() would deny. |
| F2-A broken lineage fail-open | **CONFIRMED → FIXED** | wob row gone / work_item gone / item-claim vs allocation mismatch → treated as manual → objective cap skipped. 3 prepatch FAILs. |
| F2-B pricing outside txn | **CONFIRMED → FIXED** | billingFor() resolved before the atomic txn — a profile edit committed in the gap could slip a stale price. Prepatch: reservation pinned stale 100k instead of in-txn 500k. |
| F2-C concurrent over-cap | **SAFE_BY_EXISTING_PROOF** | R3's in-txn objective-cap sum already sees siblings; NEW real cross-connection race test (conn2 commits HELD at conn1's txn entry → conn1 denied, exactly 1 reservation) + in-txn resId re-check added. |

**Fixes (minimal):**
- `scheduler.queueEligibility(q)` — claim()'s own queue predicate (WAITING_CONSUMER, pending>claimed>settled, next_due, 30s attempt cooldown); `claim()` now consumes it verbatim.
- `scheduler.claimable(objectiveId)` — public read-only eligibility proof: queue predicate + policy-effective + binding pins + active lease. Intentionally excludes global roster/rate (transient, never an objective-readiness fact).
- `driver.readiness()` consumes `claimable()` — `driver_integrated` (deployment) vs `objective_runnable`/`driver_ready` (claimable now + cost binding); `driver_missing` carries typed reasons: `NO_QUEUE, QUEUE_<state>, NO_PENDING_GENERATION, NOT_DUE_YET, ATTEMPT_COOLDOWN, POLICY_NOT_EFFECTIVE, STALE_BINDING, LEASE_HELD` + `SCHEDULER_NOT_READY, COST_UNVERIFIED, COST_BINDING_UNVERIFIED, BUDGET_EXHAUSTED`.
- `cost.ts` F2-A: `objectiveScopeFor` returns `{oid,cap} | "BROKEN" | null` — binding-claim via `work_item.objective_id` or bounded parent-chain walk (≤8 hops; cycle/mid-chain-missing → BROKEN) + allocation linkage; BROKEN → `FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED` inside txn; truly manual (no claim anywhere) → `null` unaffected.
- `cost.ts` F2-B: `billingFor` + `requested` re-resolved **inside** `store.immediate` — in-txn UNKNOWN/unbounded deny mirrors outer fast-path; in-txn resId re-check (COMMITTED/SETTLED adopt, unexpected HELD → AMBIGUOUS).

**Test hygiene per mandate:** F3f split into `F3f-quarantined` / `F3f-exhausted` (name matches assertions); EXPIRED proof uses a real `expires_at` deadline that passes (never a 2999 fixture + nudge); every denial path leaves canonical DB evidence.

**Readiness truth table (driver ON):** SCHEDULER_NOT_READY → cursor not READY; POLICY_NOT_EFFECTIVE → DISABLED/PAUSED/real-EXPIRED; NO_QUEUE / QUEUE_BLOCKED_RETRY_EXHAUSTED / QUEUE_WAITING_EVIDENCE / QUEUE_BLOCKED_AUTHORITY / QUEUE_QUARANTINED / NOT_DUE_YET / NO_PENDING_GENERATION / ATTEMPT_COOLDOWN / STALE_BINDING / LEASE_HELD → per claim() predicate; COST_UNVERIFIED → UNKNOWN/unbounded attributed usage; COST_BINDING_UNVERIFIED → no provable dispatch bound; BUDGET_EXHAUSTED → usage + bound > cap; runnable=true only when all checks clear.

**Verify:** `verify:change --base 0e27bc6 --full` → **READY_FOR_INDEPENDENT_AUDIT** — claim `P15_10_C_R4_FINAL_READINESS_COST_PROOF` PASS, invariants 5/5, claim tests 11/11, regression 23/23, tsc+build PASS, full suite +3 known baseline. R4 17/17, R3 15/15, R2 10/10, R1 10/10, 10c 19/19. Diff R4: +739/−70, 8 files. R1/R2 audited code kept verbatim.
