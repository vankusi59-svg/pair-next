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
