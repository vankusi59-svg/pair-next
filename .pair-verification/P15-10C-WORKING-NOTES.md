# P15.10-C Working Notes (session state — read this first after context reset)

## Pins
- BASE SHA: `0e27bc6ee236d82633d4aee321ba9cd264adc0c3` (staging/pr59-safe = PR #86 merge, verified == mandate checkpoint)
- Branch: `devin/1791550000-p15-10c-driver` in worktree /home/ubuntu/repos/pair-next-pr86
- Mandate: /home/ubuntu/attachments/60fad8e3-f4e8-41ce-afd3-7610c4969ab6/pasted-1791548764115.txt (974 lines, fully read)
- Delivery: ONE PR → staging/pr59-safe, DO NOT MERGE. Driver default OFF.
- Verify: `npm run verify:change -- --base 0e27bc6ee236d82633d4aee321ba9cd264adc0c3 --full` → must reach READY_FOR_INDEPENDENT_AUDIT before reporting.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH` (node22 only — better-sqlite3 breaks on 24)
- AGENTS.md: patch-claim.json must be rewritten for THIS change and be part of BASE..HEAD diff; required_tests must have executable proof.

## Environment (live E2E Layer-2 capable)
- codex logged in ChatGPT (~/.codex/auth.json) → codex-cli:gpt-6.1-sol QUALIFIED
- Running prod-like stack: serve-mission-control PID :8788, PAIR_MC_DIR=/home/ubuntu/pair-mc-live, token ~/pair-mc-token (value "12"), tunnel https://nature-boxed-pamela-none.trycloudflare.com, telegram bridge @pairnext_bot PID 7407, allowlist [1882810918]
- For live E2E: ISOLATED test deployment = separate PAIR_MC_DIR + port, NEVER prod DB. No real business objectives, no telegram delivery, no irreversible effects.
- dsh settings.yaml may rename→.imported after spawn; restore before restarts.
- Kill/restart MC: kill exact PID only; env-preserving restart via /proc/<pid>/environ → ~/mc-env.json.

## Implementation map (DECIDED)

### Chain
Auto Policy (ENABLED+effective) → Wake (WAKE_STATE via wakeup tick) → Fair Scheduler (nextFairCandidate → claim → LeaseHandle fence) → **NEW Driver** (admission: policy+halt+CAPS CAS) → runObjectivePass (authority_gate hooks) → OperatingOutcome → scheduler.settle → outcomeContinuation

### Key facts confirmed in code
- scheduler.claim(objectiveId, workerId, bootId, opportunity) → LeaseHandle {objective_id,worker_id,boot_id,token,fence,claimed_generation,checkpoint_digest}; internally re-proves policy effective (requireCurrent), lease fence, global roster MAX_ACTIVE=4, rate window 120/min, retry bound min(3, limits.max_retries).
- scheduler.settle(handle,outcome,opId) — durable receipt dedup `settle:<obj>:<fence>:<opId>`; outcomeContinuation maps 12 outcomes → WAITING_EVIDENCE(wait_kind,next_due) or BLOCKED_AUTHORITY; TARGET_MET_CANDIDATE→OWNER_SIGN_OFF_REQUIRED (no auto-approve ✓).
- scheduler.release(handle,opId) — RELEASED + backoff next_due [30s,120s,600s][retry_count].
- scheduler.nextFairCandidate() — deterministic rank round-robin, persisted last_visited_rank/cohort/round in FAIRNESS_STATE GLOBAL row.
- scheduler.reconcileLeases(limit) — expires stale ACTIVE leases (fence+1), keeps claimed_generation unsettled for reclaim.
- scheduler.status(objectiveId,actor) — currently hardcodes consumer_ready:false, driver_ready:false → extend with injected driver state (backward-compat default off).
- Queue states: WAITING_CONSUMER (eligible), WAITING_EVIDENCE (waiting w/ next_due), BLOCKED_AUTHORITY, BLOCKED_RETRY_EXHAUSTED, QUARANTINED, UNREGISTERED.
- claim() requires queue_state==WAITING_CONSUMER && pending>claimed or claimed>settled && next_due passed && 30s attempt cooldown.
- requireRebind invalidates ACTIVE lease (state INVALIDATED, fence+1) on policy_version/terms/objective_version/owner drift or !effective.
- policy.evaluate(objectiveId) → AutoPolicyStatus {effective, reasons, limits{expires_at,max_ceo_calls,max_missions,max_retries,budget_microusd_cap}, terms_current, state}. limits ≥1 cap required (besides expires_at). Lazy EXPIRED write.
- runObjectivePass({objective_id, actor, hooks?}) — actor = provenance only (created_by/started_by mint `operator:${actor}`); NO owner==actor requirement found in downstream seams (runCycle, allocateWorkstream, openWorkItem need only non-empty actor ≤256).
- Per pass bounds: ≤1 runCycle (bootstrap only), ≤1 openWorkItem (returns after first), reviews deterministic zero-model.
- CEO call = CodexCliCeoDecisionInvoker → codex exec ChatGPT subscription, API keys stripped → microusd cost provably 0 (subscription, not money).
- Mission dispatch cost → P13 cost.ts assertAndReserve (CRSV_<gtid>, HELD/COMMITTED/RELEASED/SETTLED, reserved_microusd bound, settleFromResult, reconcileForTask crash semantics, unbounded flag). billingFor(executorId,routeId)→{mode,profile,unbounded}; modes METERED_API/SUBSCRIPTION/FREE/UNMETERED/UNKNOWN. haltActive()=PAIR_COST_HALT=1||COST_HALT_FILE — blocks METERED_API+UNKNOWN only.
- Mission attribution: mission.bound_open_id → work_open_binding.created_by == driver actor && work_item_id ∈ allocation's {workstream_work_item_id, delegated_child_work_item_id}.
- CEO attempt attribution: ceo_decision_attempt rows have objective_id + started_by (raw actor before operator: prefix).
- serve-mission-control.mjs: governed Map<executorId,adapter> (CODEX/DEVIN/DSH/PAIR_NATIVE), service.cost public (billingFor public), COST_HALT_FILE+haltActive same formula at line ~250, objectiveAutoReconcile wired L431 interval PAIR_OBJECTIVE_RECONCILE_MS default 60s, server deps.autoScheduler = .scheduler.
- faultCode/sanitizeFaultReason allowlists SAFE_FAULT_CODES + FAULT_LABELS (R2-hardened): persist only allowlisted codes else UNSPECIFIED_FAULT. Driver must add its labels to FAULT_LABELS (classification labels, not error codes) — watch R2 regression tests.
- isSqliteContentionError, IntegrityError(FAIL_CLOSED_*), NotFoundError from store/errors.
- store API: tryGet, put(type,id,row,expectVersion)→CAS, event(), listEvents(type,id), eventPage({after_seq,limit,topics,entity_type,entity_id,descending}), entityPage({entity_type,after_id,limit}), list(type), immediate(fn), withReadBudget({entities,events},fn), getEvent(id), schedulerRevisionSummary.
- readSchedulerRow/writeSchedulerRow — protected row machinery (commit anchors pins_digest+predecessor_hash) reused for driver rows.
- OperatingPassHooks {afterReview,beforeOpen} are TEST-ONLY — do NOT reuse for prod gate.

### Design decisions
- DRIVER_ACTOR = "objective-auto-driver" (provenance → operator:objective-auto-driver). Never owner string.
- Delegation = ENABLED+effective policy revalidated: at claim (inside claim()), before pass, via authority_gate before model call/mission open/commits mid-pass, after restart (bootId+fence).
- Usage attribution DERIVED canonically each admission (no trusting stored counters): ceo_calls = count(ceo_decision_attempt started_by==driver ∧ objective_id); missions = count(WOB created_by==driver ∧ work_item ∈ objective allocations); microusd = Σ reservations over attributed missions (HELD+COMMITTED@reserved, SETTLED@settled); unverified = any attributed reservation unbounded||UNKNOWN billing.
- budget_microusd_cap admission: attributed + next_dispatch_bound ≤ cap; bound = max reserveAmount over billingFor of eligible executor ids; executor w/o bounded profile → INF → deny (COST_BINDING_UNVERIFIED). If cap unset → no microusd gate.
- Admission receipt row (scheduler-protected): `auto-driver-admit:<objective>:<fence>` deterministic id — CAS create ⇒ idempotent replay-safe.
- Denials: CAP_EXHAUSTED/COST_UNVERIFIED → scheduler.quarantine(typed label) + release? NO — quarantine alone suffices (writes QUARANTINED+blocked_reason). PAIR_COST_HALT → release (temporary backoff; retry budget bounds it).
- Driver usage row `objective_auto_driver_state:<objective>` — protected scheduler row: admission receipts, last outcome, denial history (bounded arrays), for observability/status.
- authority_gate added to runObjectivePass input (optional, default noop → manual CEO route unchanged C21). Call sites in pass(): before runCycle, before each runReview, before allocateWorkstream, before openWorkItem, before each reconcileDelegatedChildren write.
- Driver file: src/pair/objective-auto-driver.ts — ObjectiveAutoDriverService{tickOnce(),status()} + ObjectiveAutoDriverRuntime (interval, inTick guard, markDegraded-style) + createObjectiveAutoDriver().
- Enable: PAIR_OBJECTIVE_AUTO_DRIVER=1 env in serve-mission-control.mjs → wire deps {store,business,workforce,objectives,policy,scheduler,cost:service.cost,governed executor ids,COST_HALT check,invoker?,interval PAIR_OBJECTIVE_DRIVER_MS default 5000}; else status reports disabled + driver_missing.
- scheduler.status(objectiveId,actor,driverState?) — optional 3rd arg {enabled,consumer_ready,driver_missing[]} → server endpoint passes deps.autoDriver status; tests unchanged (default off).
- Server: deps.autoDriver?: {status(objectiveId),global status()} → extend auto-scheduler GET + new GET /api/vnext/objectives/:id/auto-driver status; no mutating driver routes.
- costHaltActive check: reuse formula (env PAIR_COST_HALT=1 || existsSync(COST_HALT_FILE)) via injected fn (tests inject false).

### Acceptance notes
- C01 default OFF zero auto calls: no driver unless env; pass runner only invoked by driver.
- C04/C29 mid-pass revoke → authority_gate throws FAIL_CLOSED_DRIVER_AUTHORITY_LOST → release/fail.
- C14 two-process claim → CAS lease + roster.
- C05 fairness → nextFairCandidate persisted rank.
- C20 double-charge: settle receipts deterministic; attribution counts canonical rows once.
- C26 live E2E: isolated deployment possible (codex qualified); telegram delivery must NOT fire — test objectives avoid TELEGRAM_DELIVERY tasks; PAIR_TG bot token unset in test env.
- Live E2E caveat: driver must not touch running :8788 prod stack/DB.

### OPEN questions being resolved while coding
- Whether settle() also revalidates policy effective — yes via currentLease→requireCurrent (driver handles: settle failure → try release → else markDegraded; lease expiry + requireRebind INVALIDATED covers revoked mid-flight).
- Driver BLOCKED cost states write to driver_state row + quarantine label; add labels DRIVER_* to FAULT_LABELS if tests allow, else UNSPECIFIED_FAULT + detail in driver_state row.

## LIVE E2E STATE (Layer 2, in progress)
- Verify: READY_FOR_INDEPENDENT_AUDIT @ HEAD 58863030cb92 (full suite PASS +3 known baseline). 19/19 p15-10c tests + 381/381 regression pass.
- Isolated test stack: PID via `pgrep -f "PAIR_MC_PORT=8799"` (log shows worker=objective-auto-driver:37393), PAIR_MC_DIR=/home/ubuntu/pair-mc-p15c-test, port 8799, token=e2e-p15c-test, driver ON (PAIR_OBJECTIVE_AUTO_DRIVER=1, DRIVER_MS=2000, RECONCILE_MS=10000), CODEX_HOME=~/.codex QUALIFIED, DSH=groq+cloudflare, NO telegram.
- Test entities: BIZ_01M4GBR2DTBJA1SAMZ75KXPTN2, AGT_01M4GBR60DDFWEVYZSDZZYD6KX (executor_binding=CODEX, caps=["*"]), OBJ_A=OBJ_1c21dc9e6ebdd61d20da0fb1, OBJ_B=OBJ_e73fd0aca52c17212bd0e69b (both ACTIVE, owner=operator:e2e-owner).
- NEXT: enable auto-policy on both (configure limits expires_at+max_ceo_calls:4+max_missions:4+max_retries:2+budget_microusd_cap:5000000 then enable policy_version:1) via POST /api/vnext/objectives/:id/auto-policy x-operator-id:e2e-owner → watch driver claim→pass→CEO codex→mission → check 9 proofs incl B-continues-when-A-paused + restart no-dup.
- Commit on branch so far: b1ec731 impl + claim-fix commit 58863030 (verify HEAD). Lazy-ceoOps fix in serve-mission-control.mjs is UNCOMMITTED — must commit.

## LIVE E2E RESULTS (Layer 2 — all 9 proofs PASS)
- Policy enabled on both objectives (v2→4). Cost profiles seeded: DSH=METERED_API reserve 100000, CODEX=SUBSCRIPTION, DEVIN=SUBSCRIPTION.
- Driver ran full chain live: claim→admit→pass→CEO(codex-cli:gpt-6.1-sol ACCEPTED, state=ACCEPTED)→work_open_binding(by=objective-auto-driver)→mission COMPLETED x2 (MSN_01M4GBWS3Q03D3HP9P10ZYT46M for A, MSN_01M4GBZAQW6F5D2ZMSBYS6ZWZ9 for B)→settle→INSUFFICIENT_VERIFIED_PROGRESS.
- #1 driver start: boot log "OBJECTIVE AUTO DRIVER: ENABLED" both boots. #2 wake intake: STARTUP_RECONCILE+POLICY_* wakes registered. #4 CEO via qualified transport: attempts model_id=gpt-6.1-sol provider=codex-cli. #5 governed mission seam: OPI binding by driver. #6 cost: CRSV COMMITTED reserved=100000 executor=DEEPSEEK_HARNESS mission_id=MSN...46M + admit receipts auto-driver-admit:<obj>:<fence 3..6>. #7 B-continues-A-paused: A PAUSED→BLOCKED_AUTHORITY while B claimed/passed/dispatched independently. #8 restart no-dup: kill→restart (worker 37393→41530→42479); fences monotonic per obj, no dup receipts, no replayed missions. #9 pause persists across restart (A still BLOCKED_AUTHORITY post-restart).
- Known env quirk (pre-existing repo, not driver): DSH settings.yaml renamed to .imported after first boot → restart marks DSH providers STALE→boot crash. Fix: cp .imported back to settings.yaml before restart.
- Truthfulness patch: auto-policy route now overrides driver_ready=true/driver_missing minus AUTO_DRIVER_NOT_INTEGRATED when autoDriver wired; COST_BINDING_UNVERIFIED correctly remains (separate claim).

## R1 (F1 remediation) — implementation map
- BUG: lease expires_at=claim+60s; renew() caps lifetime at started_at+300_000 (hardcoded); no commit guard inside runCycle step-10 txn → revoke/expire during model await (≤900s) still commits decision/workstream. authorityGate only fires BEFORE runCycle.
- F1-B lease: claim(..., opts{max_lifetime_ms}) → lease row field (default 300_000 = P15.10-B compat); renew uses it; cap 960_000 (CEO max 900s + finalization 60s).
- F1-A driver: heartbeat setInterval(DRIVER_HEARTBEAT_MS=20_000, unref) after admit → scheduler.renew(handle) (self-validates token/fence/identity/authority via currentLease); contention → retry next tick (lease TTL self-bounds); other error → stop + fault DRIVER_AUTHORITY_LOST (permanent). finally hb.stop(). Post-pass: hb.fault() → quarantine+release, never settle.
- F1-C: runCycle input += autonomous_commit_guard?:()=>void → fired FIRST inside step-10 store.immediate txn (throw→rollback→attempt settles REJECTED via existing catch). runReview input same → forwards to its internal runCycle. pass() wires authorityGate into both. Manual callers unchanged (noop).
- F1-D: settle/release already currentLease-guarded; claim→INFLIGHT blocks 2nd invocation; driver calls deps.reconcileStaleAttempts(objectiveId) pre-pass (grace-bounded STARTED→UNKNOWN); heartbeat A-vs-B covered by token/fence checks in currentLease.
- Driver deps += ceoTimeoutMs (validated ≤900k), reconcileStaleAttempts?, heartbeatMs? (test injection). claim max_lifetime_ms=min(ceoTimeoutMs+60_000, 960_000).
- serve wiring: ceoTimeoutMs=ceoCliTimeoutMs(); reconcileStaleAttempts via lazy ceoOps (createDefaultObjectiveOperatingService return += ceoCycle).
- Tests: new pair-p15-10c-r1.test.ts (F1a..g). Repro first (fails pre-fix), then implement.

## R1 STATE CHECKPOINT (context refresh)
- Working dir: /home/ubuntu/repos/pair-next-pr86 branch devin/1791550000-p15-10c-driver, HEAD 7ea35b2 pushed to PR #87.
- R1 mandate file: /home/ubuntu/attachments/b3429274-c36f-44db-b579-410d0cea0fe9/pasted-1791552353399.txt — F1 only (heartbeat + bounded lifetime + fenced commit guard). Completion code PAIR_NEXT_P15_10_C_R1_HEARTBEAT_PENDING_FINAL_AUDIT. Push to same PR #87, DO NOT MERGE.
- Repro DONE: src/__tests__/pair-p15-10c-r1.test.ts — 10 tests, 6 FAILED / 4 PASS prepatch (proves: no heartbeat→lease dies @60s during 90s call; autonomous_commit_guard param ignored→commit lands despite revoke). NOTE: F1f test needs renew stepped under 60s TTL.
- Impl plan (committed above as "R1 implementation map"): scheduler.claim opts.max_lifetime_ms (default 300_000 backcompat, cap 960_000, ≥60_000) + lease.max_lifetime_ms + renew uses it; runCycle/runReview input += autonomous_commit_guard fired FIRST inside commit store.immediate txn; pass() wires authorityGate into both; driver heartbeat setInterval(20s default, dep heartbeatMs) after admit→renew→finally stop, contention(isSqliteContentionError)→next tick, else fault=DRIVER_AUTHORITY_LOST permanent; post-pass hb.fault()→quarantine+release no settle; deps += ceoTimeoutMs(≤900_000)+reconcileStaleAttempts?(called pre-pass)+heartbeatMs?; claim bound=min(ceoTimeoutMs+60_000,960_000); createDefaultObjectiveOperatingService return += ceoCycle; serve wires ceoCliTimeoutMs()+lazy reconcile.
- Constants live: PAIR_CEO_CLI_TIMEOUT_MS def 300_000 bounds 5000-900_000 (env-config.ts); CEO_ATTEMPT_STALE_MARGIN_MS=60_000; renew writes RENEW receipt + expires_at=now+60_000; currentLease validates fence+worker+boot+token+generation+digest+expiry+policy/owner/terms/objective pins; claim cooldown 30s + rate 120/min; settle dedup by receipt id.
- Test file imports: all from ../pair/index.js (star exports); ObjectiveAdaptiveReviewService+ObjectiveOperatingService need direct module import or index export check.
- Node: export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH. Isolated E2E stack :8799 still running (PID 42479).
- After impl: tsc+build+new tests+existing 19 p15-10c tests+regressions+verify:change --base 0e27bc6 --full → commit→push→report code PAIR_NEXT_P15_10_C_R1_HEARTBEAT_PENDING_FINAL_AUDIT.

## R2 STATE CHECKPOINT
- HEAD pushed f3abd00 (R1 complete, verify READY). R2 mandate: /home/ubuntu/attachments/f7fadbae-29ca-4da2-a26a-fb10632f3b52/pasted-1791554321046.txt — claim P15_10_C_R2_FENCED_AUTHORITY_CLOSURE, completion code PAIR_NEXT_P15_10_C_R2_PENDING_FINAL_AUDIT.
- Classified: F1.1 CONFIRMED (authorityGate lacks policy_version/terms/objective_version pin check — pause→resume mid-call effective=true passes), F1.2 CONFIRMED (commitReview txn line ~1402 has no guard), F1.3 CONFIRMED (renew stamps expires_at=now+60s past deadline; currentLease never checks lifetime).
- R2 test file written: src/__tests__/pair-p15-10c-r2.test.ts (10 tests F1a..j). Currently failing on seedCeoModel — provider auth_state UNVALIDATED; fix = use p15-5 qualifyCodexProvider shape (lines 330-352 of p15-5 test).
- Fixes to implement: (1) scheduler.assertLeaseAuthority(handle) public narrow wrapper → proof(()=>currentLease(handle)); currentLease += lifetime check started_at+max_lifetime<=now; renew clamps expires_at=min(now+60s, started_at+lifetime). (2) driver authorityGate → try{assertLeaseAuthority}catch→DriverDenial AUTHORITY_LOST permanent, keep evaluate+halt. (3) commitReview gains guard param fired first inside txn; runReview forwards.
