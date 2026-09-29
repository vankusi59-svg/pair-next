# PAIR OS vNext — P11 SOLO BUSINESS HARDENING V1 REPORT (REMEDIATION R2)

## §10.0 Classification history

| Round | PR head | Result |
|---|---|---|
| P11 initial | `ce57e9c7cf54f7af3bc8a87004ff92029a14ce25` | Classified `P11_OFFICIAL_FINAL_PASS` by the implementing session — **overturned by independent audit → `P11_BLOCKED`**. That classification was wrong: the audit's concurrency/crash-path findings were real. This report replaces it. |
| P11 REMEDIATION R1 | `fd470fa690fabce6c0977875bb5a897ea0d326e5` (+report `8907b32`) | Fixed the original 10 blockers — **independent audit then found 3 remaining closure blockers → still `P11_BLOCKED`**. See §10.8. |
| P11 REMEDIATION R2 | *(this commit)* | See §10.8 findings + §13 completion contract. |

Starting baseline for the phase: `73c44b7865e5041f7a127dc24ac38f113138abc9`
(post-PR#3 main). The R1 work landed on the existing PR #4 — no merge, no
new PR, no P12+ work.

## §10.1 Independent audit findings and root causes

1. **Crash window in work-item→mission linkage.** Root cause: the
   IN_PROGRESS write and the mission creation were two independent writes
   with no durable intent between them. A crash after `startMission` but
   before the backlink left a canonical mission with no board reference;
   the catch-all rollback could also return an item to an openable state
   while its mission was alive — and nothing tied a retry to the original
   intent, so re-opens could mint duplicates. (R1 §1)
2. **`store.put` was not a real CAS.** Root cause: SELECT version →
   compare → UPSERT across two round-trips; two connections could both
   pass the check and both write. (R1 §2)
3. **Budget gate was count-then-create.** Root cause: `enforceBudgets`
   counted missions, then `openWorkItem` created one — no atomicity, and
   nothing reserved capacity between check and create. Concurrent opens at
   max-1 could both pass. (R1 §3)
4. **Block/reopen semantics allowed overlapping missions.** Root cause:
   `blockWorkItem` was a pure status flag — it never paused or cancelled
   the linked mission — and `openWorkItem` on a reopened item simply
   appended another mission while the first was still live. (R1 §4)
5. **`/api/work-items/:id/cancel` returned 200 without cancelling
   anything** — it called `syncWorkItem`, which is read-only when the
   item is IN_PROGRESS with no terminal mission. (R1 §5)
6. **Routine projection lacked business isolation.** Root cause: the
   dedup/projection matched missions on `metadata.schedule_id` only — and
   `fireDue` never propagated schedule metadata (incl. `business_id`)
   into the mission at all, so a foreign-business or corrupted mission
   referencing the schedule could project. (R1 §6)
7. **Routine projection dedup was not atomic.** Root cause: random
   work-item ids + a covered-set scan — two projectors on two connections
   could both project the same mission. (R1 §7)
8. **Routines bypassed business budgets.** Root cause: schedule fires went
   straight through `startMission` with no business-context metadata and
   no budget gate. (R1 §8)
9. **CI gaps**: no `pnpm run build` step, no focused P11 step. (R1 §9)
10. **The previous report's classification was premature** — documented
    here rather than deleted. (R1 §10)

## §10.2 Remediation — files changed in this round

| File | Change |
|---|---|
| `src/pair/store.ts` | `put()` rewritten as **atomic CAS**: one conditional `UPDATE … WHERE version=?` (predicate evaluated under the SQLite writer lock against the latest committed row), and create via `INSERT … ON CONFLICT DO NOTHING` — a lost create-race deterministically becomes `FAIL_CLOSED_VERSION_CONFLICT`. `busy_timeout=5000` so a racing writer waits for the winner's commit instead of erroring. New `store.immediate(fn)` = `BEGIN IMMEDIATE … COMMIT/ROLLBACK` for cross-statement atomicity. Hash verification, append-only events and canonical-payload semantics preserved. |
| `src/pair/business.ts` | (a) `openWorkItem` commits a **durable open intent** (`pending_open_id`/`pending_open_at`) before `startMission`; missions carry `metadata.work_item_open_id` + `work_item_id`. Catch path **reconciles**: finds the intent's mission and links it (`WORK_ITEM_OPEN_RECONCILED`) instead of rolling back over a live mission; rollback to the pre-open state happens only when provably no mission exists (`WORK_ITEM_OPEN_ROLLED_BACK`, audited). Rejects reopen while the last linked mission is non-terminal (`FAIL_CLOSED_MISSION_ACTIVE`). (b) New `reconcileOpenIntent`/`reconcileOpenIntents` — board() sweeps stale pending intents (>60 s grace) and either links the orphan mission or rolls the item back to READY. (c) **`reserveBudget`** — `BEGIN IMMEDIATE` txn: expire stale HELD reservations, count missions + HELD per scope/period, insert one HELD `budget_reservation` in the same commit; `consume`/`release` settle on outcome; `BUDGET_EXCEEDED` is emitted *outside* the txn so refused opens stay audited (in-txn events rolled back — caught by tests). (d) `blockWorkItem` pauses the live linked mission via `MissionControl.pauseMission` first. (e) New `cancelWorkItem` — real governed cancel via `MissionControl.cancelMission` + CANCELLED sync. (f) Routine schedule metadata now carries `business_id`/`department`/`org_agent_id`; `BusinessLayer` installs `schedules.preflight` so business-originated fires pass the same atomic budget gate. (g) Routine projection requires `schedule_id` **and** `business_id` match, and uses deterministic ids `WI_RT_<sha256(...)[:24]>` — concurrent projectors compute the same id and the loser's create conflicts atomically. |
| `src/pair/mission-schedule.ts` | `fireDue` now merges `s.metadata` into the fired mission's metadata (was dropped entirely) and exposes `preflight` — a veto hook returning a settle token consumed on mission creation / released on error. |
| `src/pair/mission-control-server.ts` | `/api/work-items/:id/cancel` → `biz.cancelWorkItem` (was `syncWorkItem` — a no-op that returned 200). |
| `src/__tests__/pair-p11-r1.test.ts` | **New** — 25 tests, below. |
| `src/__tests__/pair-p9.test.ts` | Two fixtures aligned to the now-required invariants (crafted routine-fired mission must carry `business_id`; nothing weakened — the invariant the fixtures now satisfy is the audit's demand). |
| `.github/workflows/ci.yml` | `pnpm run build` step added; focused step `vitest run src/__tests__/pair-p11*.test.ts` added on both Node 20 and 22; all timeouts remain real failures. |
| `src/pair/credential-broker.ts` | (unchanged from initial round — `deny()` audit already in place) |

Earlier-round hardening retained: transition map, claim-token release,
budget scope validation, routine-assignee ACTIVE check, broker deny audit,
honest CI timeout/audit gates, dependency remediation to 0 high/critical,
README/ARCHITECTURE/CURRENT_STATE rewrite.

## §10.3 Test evidence (local, Node 22, `pnpm test`)

- `src/__tests__/pair-p11-r1.test.ts` — **25/25 PASS**:
  - §2 atomic CAS ×5 — same-entity concurrent update (two connections:
    exactly one wins, loser gets `FAIL_CLOSED_VERSION_CONFLICT`);
    concurrent create of same id; stale writer after first wins;
    simultaneous claims across connections; integrity verification clean.
  - §1 crash-safe linkage ×7 — fault injection **before** mission creation
    (rolls back, no mission, audited); **immediately after** mission
    creation (reconciles + links, `WORK_ITEM_OPEN_RECONCILED`, no
    duplicate, no rollback-over-live); **at the backlink write** (repair
    links mission); **after** the backlink write (no rollback over linked
    mission); **restart sweep** links an orphaned mission by
    `work_item_open_id`; **restart sweep** rolls back a pending intent
    when provably no mission exists; double-open on two connections mints
    exactly one mission.
  - §3 budget reservation ×4 — two opens at business max=1 (one mission;
    loser `FAIL_CLOSED_BUDGET_EXCEEDED` + item rolled back + event
    audited); HELD reservation on one connection blocks an open on the
    other; failed open releases capacity (exactly one unit consumed);
    stale HELD reservation expires and frees the slot.
  - §4–§5 block/reopen/cancel ×5 — IN_PROGRESS block then reopen cannot
    create a second mission while the first is live; terminal last mission
    → legitimate reopen appends exactly one new mission; `cancelWorkItem`
    cancels the live mission through MissionControl and drops the item to
    CANCELLED; READY-item cancel without a mission; **E2E** `POST
    /api/work-items/:id/cancel` over a real server — 200 only when the
    mission + item are actually CANCELLED.
  - §6–§8 routines ×4 — foreign `business_id` mission referencing the
    routine's schedule does not project; one fired mission → exactly one
    projected item across repeated + cross-connection `board()` calls
    (deterministic `WI_RT_*` id); routine fire vetoed when business budget
    consumed; routine fire under budget creates a business-scoped mission
    carrying schedule metadata with the reservation consumed exactly once.
- `src/__tests__/pair-p11.test.ts` — **22/22 PASS**.
- `src/__tests__/pair-p9.test.ts` — **79/79 PASS**.
- Full suite: **1729 passed, 24 skipped, 2 failed** — the 2 failures are
  `pair-p5.test.ts` DSH/CODEX "stock probe must be unavailable" tests;
  they fail only on this dev box (dsh/codex binaries present in
  `~/.nvm/bin`; the test strips only `.local` from PATH). Pre-existing and
  environment-dependent — they pass on CI runners.
- `pnpm run typecheck` — clean. `pnpm run build` — clean.

## §10.4 Security audit

`pnpm audit --audit-level=high` → **9 vulnerabilities: 1 low, 8 moderate,
0 high, 0 critical** (exit 0, real gate). Same count as the
pre-remediation report — the R1 work touched no dependencies. Not claimed
as zero — 9 moderate/low advisories remain (dev/build toolchain paths).

## §10.5 Authority preservation (R1 §12)

MissionControl remains the canonical mission-action authority
(`startMission`/`pauseMission`/`cancelMission`); MissionRouter,
GovernedTaskGate, ApprovalQueue, RecoveryController, ReconciliationService
and Verified-Experience-advisory-only are unchanged. BusinessLayer still
never dispatches DSH/Codex/Devin directly — it only calls
`control.startMission`. No P12–P15 scope touched (no token/USD accounting,
no exchange connectors, no autopilot executor, no public intake).

## §10.6 Limitations

- Reservation expiry uses a 10-minute TTL (`PAIR_BUDGET_RESERVATION_MS`);
  a crash between reserve and create frees the slot on the next reserve —
  bounded, audited, never permanent.
- Open-intent reconcile uses a 60 s grace (`PAIR_OPEN_RECONCILE_GRACE_MS`)
  before the sweep repairs a pending marker; in-flight opens complete far
  faster, and the in-process catch path reconciles immediately without the
  grace wait.
- `openWorkItem`'s success path is fully sequential per item — the pending
  intent + version lock makes concurrent opens of the *same* item
  impossible across connections (the second opener loses the CAS on the
  transition write).
- The reconcile sweep keys on `metadata.work_item_open_id` first, then
  `metadata.work_item_id` not already owned — sufficient because every
  mission this layer creates carries both fields.

## §10.7 Operator action required (unchanged)

Branch protection on `main` is still **NOT enabled** — the GitHub
integration token returns `403 Resource not accessible by integration` on
both read and write of branch protection. Operator must enable it:
Settings → Branches → add rule for `main` → require pull request +
require status checks `build-and-test (20)`, `build-and-test (22)`,
`security-audit`. Not claimed as done.

## §13 Completion contract — self-assessment

| # | Requirement | Evidence |
|---|---|---|
| 1 | Real atomic CAS | `store.put` conditional UPDATE/INSERT; tests `cas1–cas3` |
| 2 | Multi-connection concurrency tests | `cas1–cas5`, `bud1–bud2`, `fi7`, `rt2` — two stores on one DB |
| 3 | Crash/fault injection cannot duplicate missions | `fi1–fi4` at every boundary |
| 4 | Restart reconciliation repairs partially-linked opens | `fi5–fi6` sweep tests |
| 5 | Concurrent claims: one winner | `cas4` |
| 6 | Concurrent budget opens cannot overshoot | `bud1–bud2` |
| 7 | Block/reopen cannot overlap active missions | `blk1–blk2` + `FAIL_CLOSED_MISSION_ACTIVE` |
| 8 | Cancel API no false success | `blk3–blk5` incl. real-server E2E |
| 9 | Routine projection business-scoped | `rt1` (foreign business rejected) |
| 10 | Routine projection atomically deduplicated | `rt2` deterministic id + CAS |
| 11 | Routine missions obey business budget | `rt3–rt4` preflight veto + consume |
| 12 | Build runs in PR CI | `pnpm run build` step added |
| 13 | Full Node 20 + Node 22 regression in CI | matrix unchanged + focused step |
| 14 | `pnpm audit` 0 high/critical | 9 advisories: 1 low, 8 moderate |
| 15 | Evidence integrity clean | `verifyIntegrity` exercised in `cas5`; all tests hash-verify on read |
| 16 | No authority bypassed | §10.5 |
| 17 | No P12–P15 scope creep | §10.5 |

**Classification submitted for independent audit: `P11_REMEDIATED_PENDING_AUDIT`.**
Final `P11_OFFICIAL_FINAL_PASS` requires the independent re-audit to agree —
this report does not self-certify.

---

## §10.8 P11 REMEDIATION R2 — independent audit findings and closure

Independent audit of `8907b327db8c4e2d1b503e3cb43e4f5cc4ef7d17` (R1 head)
re-classified P11 as **P11_BLOCKED** with three remaining closure blockers.
All three were real.

### §10.8.1 Findings and root causes

1. **Pending open intent could be hidden by business state mutation.**
   Root cause: `blockWorkItem`/`cancelWorkItem`/reopen/`unblock`/assign/claim
   inspected `mission_ids` only. A crash after `startMission` but before the
   mission-ids backlink left `status=IN_PROGRESS, pending_open_id=OPI_x,
   mission_ids=[]` with a live canonical mission —
   `block`/`cancel` could then flag the item while the orphan kept running,
   reopen could mint a second mission, and the R1 sweep only looked at
   IN_PROGRESS items so a status change hid the marker forever.
2. **No genuine multi-process contention in R1 tests.** Root cause: the
   two-connection tests still executed operations sequentially (conn A writes,
   then conn B writes) — verifying stale-writer protection but not true
   simultaneous contention as the completion contract requires.
3. **`MissionScheduleService.fireDue` could double-fire one occurrence.**
   Root cause: routine-projection dedup protects the work-item side, but two
   scheduler processes could both pass `due()` and both submit — the
   schedule-row CAS conflict only happens *after* `startMission`, so
   MSN_A→WI_RT_A and MSN_B→WI_RT_B are two different canonical missions.

### §10.8.2 Remediation — files changed in this round

| File | Change |
|---|---|
| `src/pair/business.ts` | New canonical gate **`resolvePendingOpenBeforeMutation(workItemId, actor)`** — invoked at the top of `openWorkItem`, `blockWorkItem`, `cancelWorkItem`, `unblockWorkItem`, `assignWorkItem`, `claimWorkItem`, `releaseClaim`, `syncWorkItem` and the `board()`/`reconcileOpenIntents` sweeps. Semantics: `pending_open_id` set → find the intent's mission by `metadata.work_item_open_id` → **link atomically** (`WORK_ITEM_OPEN_RECONCILED`); if that mission is terminal, fold its outcome via `syncWorkItem` before the mutation proceeds. No mission **and** inside the in-flight grace window → `FAIL_CLOSED_OPEN_INTENT_ACTIVE` (mutation must retry — ambiguity fails closed). No mission **and** provably beyond the window → deterministic audited rollback to READY (`WORK_ITEM_OPEN_ROLLED_BACK`, `cause=mutation_gate`), then the mutation runs. `pending_open_id` is never silently erased. `reconcileOpenIntents` now sweeps pending markers on **any** status, so block/cancel/reopen can no longer hide an orphan. `board()` skips only in-flight-intent sync errors (`FAIL_CLOSED_OPEN_INTENT_ACTIVE`). |
| `src/pair/mission-schedule.ts` | **Exactly-once occurrence claim.** `claimOccurrence(scheduleId, dueAt)` creates `schedule_occurrence` `OCC_<sha256("schedule-occurrence:<schedule_id>:<due_at>")[:24]>` via CAS **before** preflight/submit — losers return null and must not reserve budget or create a mission. Ordering: due → claim → preflight (budget) → `startMission` → `settle(true)` → `bindOccurrenceMission` (status FIRED + `mission_id`) → advance schedule. Pre-submit failure → `releaseOccurrence` → status RELEASED, audited, bounded (never auto-retried). `reconcileOccurrences()` runs at the top of every `fireDue`: CLAIMED claims older than `OCCURRENCE_CLAIM_TTL_MS` (10 min, env `PAIR_OCCURRENCE_CLAIM_MS`) are either bound to the durable mission carrying `metadata.schedule_occurrence_id` or RELEASED (`stale_claim_no_mission`). Fired missions carry `schedule_id`, `schedule_occurrence_id`, `scheduled_for`, `business_id`. Schedule-row advance now retries once on CAS conflict so a losing process's fire outcome is not lost. |
| `src/__tests__/pair-p11-r2.test.ts` | **New — 19 tests.** §1: orphan RUNNING mission + block/cancel/reopen/unblock/board, terminal-orphan fold, stale-intent rollback, in-flight fail-closed, fresh-stack restart. §3: same-occurrence double-fire, crash-before-backlink reconcile, stale-claim release, preflight veto ordering, routine metadata propagation. §2: **genuine `worker_threads` contention** — each worker runs its own `PairEvidenceStore` + full stack on the same db file, synchronized on a `SharedArrayBuffer` barrier (`Atomics.wait`/`notify`): CAS update race, create race, claim race, open race (same work item → exactly one canonical mission), budget race (limit 1, two different items → no overshoot), two schedulers firing the same occurrence simultaneously → exactly one mission. The worker bundle is built at test time by esbuild into `node_modules/.cache/pair-r2/`; workers deliberately do NOT re-register capabilities/projects (fixture-owned rows — re-creating them CAS-conflicts by design). |
| `src/__tests__/pair-p11.test.ts` | Two expectations updated to the more precise `FAIL_CLOSED_MISSION_ACTIVE` (the prior-mission guard now fires before the transition check — mandated R2 §1 case C). Still fail-closed; not weakened. |
| `.github/workflows/ci.yml` | Focused P11 step now runs `pair-p11.test.ts` + `pair-p11-r1.test.ts` + `pair-p11-r2.test.ts` (timeout 300 s, still a real failure). |

### §10.8.3 Evidence (local)

- `npx vitest run src/__tests__/pair-p11*.test.ts` — **66/66** (22 + 25 + 19).
- Worker-race outcomes: CAS race 1 win/1 `FAIL_CLOSED_VERSION_CONFLICT`,
  integrity clean; create race 1 entity; claim race one owner; open race
  exactly one canonical mission linked; budget race exactly one consumed
  reservation, loser `FAIL_CLOSED_*`; schedule race `run_count=1`, one
  FIRED occurrence bound to one mission.
- Full suite: 1748 pass / **2 pre-existing env-dependent p5 failures**
  (dsh/codex binaries exist on this dev box — same as R1; green on CI) /
  24 skipped.
- `pnpm run typecheck`, `pnpm run build` — clean.
- `pnpm audit --audit-level=high` — **0 high / 0 critical** (1 low + 8
  moderate advisories — unchanged from R1).
- CI: build-and-test (Node 20 + 22), security-audit — pending push.

### §10.8.4 Remaining limitations (honest)

- `resolvePendingOpenBeforeMutation` relies on the same durable-intent
  scan (`work_item_open_id`) as R1 — a mission created WITHOUT the open
  metadata (bypassing openWorkItem entirely) is out of scope; direct
  `startMission` remains operator-path, not business-path.
- Occurrence retry policy is deliberately bounded: a pre-submit failure
  RELEASEs the occurrence permanently (the schedule advanced); the next
  cron occurrence fires fresh. Dropped occurrences are audited, not lost.
- `OCCURRENCE_CLAIM_TTL_MS`/`OPEN_RECONCILE_GRACE_MS` tune how quickly a
  crashed claimant's slot is recoverable — within the window, mutations
  fail closed rather than guess.
- Worker_threads races verify same-host SQLite contention; they do not
  emulate two networked machines — by design (SQLite is single-file).

### §10.8.5 Authorities, scope, branch protection

Unchanged from R1 (§10.5): MissionControl remains the only dispatch path;
no BusinessLayer→executor calls; no P12–P15 functionality. Branch
protection on `main` is still **OPERATOR ACTION REQUIRED** (integration
token 403) — to be enabled after R2 independent audit, before final merge.

**Classification submitted for independent audit:
`P11_REMEDIATED_R2_PENDING_AUDIT`.** Final `P11_OFFICIAL_FINAL_PASS`
requires the independent re-audit to agree — this report does not
self-certify.

---

## §10.9 P11 REMEDIATION R3 — SCHEDULE FINAL CLOSURE

Independent audit of head `e3de4c25a0f37649b6bdfde30b60466feb6e3b28`
(§10.8) found three scheduler-closure defects; this round closes them on
the same PR (#4), branch `devin/1790648747-p11-business-hardening`.

### §10.9.1 Audit findings → root cause → fix

| # | Finding | Root cause | Fix |
|---|---------|------------|-----|
| 1 | Stale due snapshot could fire the NEXT occurrence early | `_fireDue` re-read `row.next_due_at` from the FRESH row and claimed whatever it now contained — if a concurrent scheduler had already advanced X→Y, the stale snapshot fired Y early | Snapshot pin: `snapshotDueAt` is captured from the `due()` snapshot; the fresh row must still satisfy `next_due_at === snapshotDueAt && next_due_at <= now && enabled && !deleted`, else `continue` — no claim, no budget, no mission, no mutation (§5 loser-side guarantee) |
| 2 | Post-create exception could release an occurrence whose mission exists | `startMission` is multi-step (`createMission` → `runtimeEntity` → `supervisor.wake`): `createMission` can succeed while `wake` throws; the catch path unconditionally `releaseOccurrence` + `settle(false)` — mission detached from its occurrence, budget refunded for a mission that exists | On ANY exception after submit was attempted, canonical mission existence is decisive: search `mission` rows for `metadata.schedule_occurrence_id === occurrenceId` — found → `settle(true)`, `bindOccurrenceMission`, record `last_mission_id`/`last_error`/`run_count`, `SCHEDULE_FIRED` event with `reconciled: "post_create_exception"`; not found → `settle(false)` + `releaseOccurrence` as before |
| 3 | `bindOccurrenceMission` could return silently after retry exhaustion | 3-attempt CAS loop that simply returned when retries ran out — binding unproven | Fail-closed loop: each attempt proves or detects — same-mission+FIRED → return (idempotent); different-mission bound → `FAIL_CLOSED_OCCURRENCE_BINDING_CONFLICT`; CAS conflict → retry. After the loop a final read decides: proven → return, different bound → CONFLICT, else `FAIL_CLOSED_OCCURRENCE_BIND_UNPROVEN` — it never returns on an unproven binding |

### §10.9.2 `reconcileOccurrences` hardening (§4)

Rewritten to consult the canonical mission index for EVERY occurrence:

- `FIRED` + bound mission exists → no-op;
- `FIRED` + a *different* canonical mission claims the occurrence →
  `SCHEDULE_OCCURRENCE_INTEGRITY` audit event (binding NOT rewritten —
  bound value wins, conflict is loud);
- `CLAIMED` or `RELEASED` + canonical mission exists →
  `bindOccurrenceMission` + `SCHEDULE_OCCURRENCE_REPAIRED` event
  (pre-R3 RELEASED+mission partial states are deterministically repaired);
- `CLAIMED` + no mission + fresh (inside TTL) → untouched (in-flight);
- `CLAIMED` + no mission + stale → `releaseOccurrence("stale_claim_no_mission")`;
- `RELEASED` + no mission → terminal, untouched.

All repair actions emit an audit event. CLAIMED+mission now binds
immediately on reconcile — no TTL wait is needed since mission existence
is proof the fire completed.

### §10.9.3 Ordering (§6)

`due snapshot → validate snapshot still current/due → claim occurrence →
budget preflight/reservation → MissionControl.startMission → reconcile
mission existence on success/error → settle budget → bind occurrence →
advance schedule`. `last_fired_at` moved to success paths only (a failed
fire no longer records a fire).

### §10.9.4 Files changed / tests

- `src/pair/mission-schedule.ts` — `_fireDue` snapshot pin +
  post-create reconcile + success-only `last_fired_at`;
  `bindOccurrenceMission` fail-closed; `reconcileOccurrences` rewrite.
- `src/__tests__/pair-p11-r3.test.ts` — **12 new tests**: stale snapshot
  cannot fire Y (two schedulers, deterministic snapshot inject);
  disabled-meanwhile skip; pre-create failure releases occurrence+budget;
  post-create failure binds FIRED + one mission + budget consumed once +
  `reconciled` audit; restart CLAIMED+mission binds immediately;
  RELEASED+mission repairs to FIRED; FIRED+other-mission integrity event;
  fresh CLAIMED untouched; idempotent same-mission bind;
  different-mission bind fails closed on both same-process and
  second-connection writers; stale scheduler reserves nothing and mutates
  nothing (run_count/next_due_at/version unchanged).
- `.github/workflows/ci.yml` — focused P11 step now includes
  `pair-p11-r3.test.ts`.
- All P11 R0/R1/R2 tests kept and unweakened: **78/78 P11 tests pass**
  (22+25+19+12). Full suite: **1760 pass / 24 skipped / 2 fail** — the 2
  are pre-existing env-dependent `pair-p5.test.ts` DSH/CODEX probe tests
  (pass on CI where the binaries are absent; unchanged since R1).

### §10.9.5 Final closure conditions (§9) — self-assessment

| Condition | Evidence |
|---|---|
| At most one mission per occurrence | CAS occurrence claim (R2) + canonical-existence reconcile (R3) |
| Stale snapshot cannot fire early | snapshot pin `===` + `<= now`; tests pin1/pin2 |
| Post-create exception cannot release | catch path binds by canonical mission before release is considered |
| Canonical mission existence wins | both success-catch and reconcile paths consult `metadata.schedule_occurrence_id` |
| Binding cannot silently fail | `FAIL_CLOSED_OCCURRENCE_BIND_UNPROVEN` / `_BINDING_CONFLICT` |
| No two-mission binding | same-mission idempotent; different-mission throws conflict |
| Restart reconcile closes partial states | CLAIMED+mission→FIRED, RELEASED+mission→FIRED, stale CLAIMED→RELEASED |
| run_count advanced once | winner-only write + `Math.max` merge (R2) + pin prevents stale write |
| next_due_at advanced once | winner-only advance; loser `continue`s before any mutation |
| last_mission_id correct | written from the bound/returned mission only |
| Budget exactly-once | loser/stale reserve nothing; pre-create failure releases; post-create consumes one |
| Multi-process contention green | R2 worker_threads suite (19 tests) + R3 deterministic interleave |
| R1/R2 invariants green | 66/66 prior P11 tests unchanged and passing |
| Integrity clean | `SCHEDULE_OCCURRENCE_INTEGRITY` audits the FIRED/different-mission anomaly instead of mutating |
| Node 20 + 22 + build + security pass | CI matrix; `pnpm audit --audit-level=high` clean (0 high/critical) |
| No authority bypass | dispatch still only via `MissionControl.startMission` |
| No P12–P15 scope creep | diff touches scheduler/tests/CI/report only |

### §10.9.6 Branch protection

Unchanged: **OPERATOR ACTION REQUIRED** — GitHub token returns 403 on
branch-protection APIs; it is NOT enabled. Enable after this R3 audit
passes, before final merge (Settings → Branches → `main`: require PR +
checks `build-and-test` + `security-audit`).

**Classification submitted for independent audit:
`P11_REMEDIATED_R3_PENDING_AUDIT`.** This report does not self-certify;
`P11_OFFICIAL_FINAL_PASS` requires the independent re-audit to agree.

---

## §10.10 P11 REMEDIATION R4 — FINAL RESTART ACCOUNTING CLOSURE

Independent audit of head `a011d553640379e1874c2cdbe230be2742524067`
(§10.9) found one remaining crash window: after a schedule occurrence +
mission become canonical but BEFORE the `mission_schedule` accounting
row is durably updated, a restart left `run_count`/`last_mission_id`/
`last_fired_at`/`next_due_at` stale and could leave a HELD budget
reservation double-counting the mission. This round closes it on the
same PR (#4).

### §10.10.1 Root cause → fix

`reconcileOccurrences()` repaired occurrence state but never projected
canonical evidence back into `mission_schedule` accounting or the
budget ledger. Canonical truth order now enforced: **(1) mission
existence → (2) occurrence binding → (3) schedule accounting →
(4) budget reservation** — the latter two are derived/reconcilable only.

New `MissionScheduleService.reconcileScheduleAccounting()` runs at the
top of every `fireDue` (before any `due()` snapshot — §9 restart order):

1. **`reconcileOccurrences()`** — binds CLAIMED/RELEASED→FIRED by
   canonical mission; now fail-closed on multi-claim (was `.find` —
   silently picked the first claimant; two missions claiming one
   occurrence is now an audited `SCHEDULE_OCCURRENCE_INTEGRITY`, no
   binding chosen). Same fix applied to the `_fireDue` post-create
   catch path.
2. **`reconcileScheduleReservations()`** — settles HELD schedule
   reservations by canonical evidence:
   `mission exists → CONSUMED` (exactly once — a fired occurrence can no
   longer count as mission + HELD); `occurrence RELEASED + no mission →
   RELEASED`; `CLAIMED + no mission → untouched` (claimant inside TTL);
   `FIRED + no mission / missing occurrence / multi-claim →
   BUDGET_RESERVATION_INTEGRITY`, left HELD (fail closed, TTL bounds it).
   Legacy pre-R4 `schedule:<id>` refs repair only when the schedule has
   exactly one occurrence to attribute — otherwise audited ambiguous.
3. **`reconcileScheduleRows()`** — projects `mission_schedule`
   accounting from valid FIRED occurrences. **run_count is DERIVED, not
   incremented**: = #valid FIRED occurrences + legacy schedule missions
   (`metadata.schedule_id` set, no `schedule_occurrence_id` — the
   pre-occurrence-era format). With zero derivable evidence the stored
   count is untouched. `last_mission_id`/`last_fired_at` come from the
   latest FIRED occurrence (canonical `fired_at`; documented fallback —
   mission `created_at`, never restart wall-clock). `next_due_at`
   advances only when it still names an already-fired occurrence →
   `nextRunAfter(cron, latestFired.due_at)` — a *missed tick* between
   X and now is then fired legitimately by fireDue (catch-up), never
   skipped; anything already past is fireDue's normal advance.

   Occurrence validity is strict: bound mission exists AND claims the
   occurrence (`schedule_occurrence_id` match) AND `schedule_id` matches
   AND `scheduled_for === due_at`, exactly one claimant. Any conflict
   taints the schedule — `SCHEDULE_ACCOUNTING_INTEGRITY` event, row
   untouched (§14 fail-closed: missing bound mission, wrong-schedule
   claim, multi-claim, bound≠canonical, missing occurrence row, missing
   schedule row). Successful repair emits `SCHEDULE_ACCOUNTING_RECONCILED`
   with old/new field values.

   Idempotent: a healthy row derives zero diff → no write, no event.
   CAS-conflict retry ×3, then audited `accounting_write_unproven`.

### §10.10.2 Reservation identity (§8)

`BusinessLayer` schedule preflight now reserves with
`ref_id = schedule-occurrence:<occurrence_id>` (was `schedule:<id>`) —
a reservation for occurrence X can never settle Y's accounting.

### §10.10.3 Consistency fix discovered by tests

`_fireDue` wrote `last_fired_at = now` (tick param) while the occurrence
carries `fired_at` (bind time) — every restart reconcile would rewrite
the row once. `_fireDue` now mirrors the occurrence's canonical
`fired_at`, so a healthy row is a zero-diff no-op.

### §10.10.4 Files changed / tests

- `src/pair/mission-schedule.ts` — `reconcileScheduleAccounting()` +
  `reconcileScheduleReservations()` + `reconcileScheduleRows()`;
  `_fireDue` calls it before `due()`; multi-claim fail-closed in
  `reconcileOccurrences` and the `_fireDue` catch; `last_fired_at` ←
  canonical `occ.fired_at`.
- `src/pair/business.ts` — preflight ref → `schedule-occurrence:<id>`.
- `src/__tests__/pair-p11-r2.test.ts` — occurrence replay test pinned
  `now = dueAt` for determinism (comment documents that a missed tick
  between X and a later `now` legitimately fires — mandated catch-up,
  not a regression).
- `src/__tests__/pair-p11-r4.test.ts` — **12 tests**: A–G crash
  boundaries (CLAIMED+mission+HELD repair; FIRED+stale schedule; HELD→
  CONSUMED once; RELEASED→reservation released + not counted; idempotent
  ×3 reconcile; two-occurrence derivation; four conflicting-evidence
  fail-closed cases incl. multi-claim and missing mission); §11 genuine
  restart (close store, fresh PairEvidenceStore+stack on same db,
  reconcile, `verifyIntegrity` clean); ref-identity test.
- `.github/workflows/ci.yml` — focused P11 step includes r4 file.

### §10.10.5 Verification

- P11 suites: **90/90** (22+25+19+12+12) on **Node 22 and Node 20**
  (better-sqlite3 rebuilt per ABI for each run).
- Full suite: 1772 pass / 24 skipped / 2 pre-existing env-dependent
  `pair-p5.test.ts` probe fails (green on CI — unchanged since R1).
- `pnpm run typecheck` clean; `pnpm run build` clean.
- `pnpm audit --audit-level=high`: **0 high, 0 critical** (9 moderate/low
  as expected posture).
- `PairEvidenceStore.verifyIntegrity` clean after restart repair.
- All worker_threads contention races (R2 §2 A–F) unweakened and green.

### §10.10.6 Remaining limitations

- Legacy `schedule:<id>` HELD rows on schedules with >1 occurrence stay
  HELD (audited ambiguous) until TTL expiry — deliberate fail-closed.
- A mission claiming a *missing* occurrence row taints its schedule
  (integrity event) — repair requires operator action.
- Reconcile runs per fireDue tick — fine at current scale.

### §10.10.7 Branch protection

Unchanged: **OPERATOR ACTION REQUIRED** — integration token 403; NOT
enabled. Enable after R4 audit passes, before merge.

**Classification submitted for independent audit:
`P11_REMEDIATED_R4_PENDING_AUDIT`.** Final `P11_OFFICIAL_FINAL_PASS`
requires the independent re-audit — this report does not self-certify.

---

## §10.11 P11 REMEDIATION R5 — NEXT_DUE FINAL SEMANTICS

- **Previous head audited:** `0bdf66ab7c86e65917d2380177fc00221ef0151c`
- **Audit classification:** `P11_BLOCKED` — R4 closed restart accounting,
  but `_fireDue` still advanced `next_due_at` from the wall clock.

### §10.11.1 Root cause → fix

`_fireDue` computed `next_due_at = nextRunAfter(cron, now)` after each
accounted occurrence. When `now` was minutes/hours past the occurrence's
`dueAt`, every missed cron tick between them was silently skipped —
they never existed as occurrences and were never attempted.

R5 anchors advancement to the occurrence that was actually accounted:

- `_fireDue`: `next_due_at = nextRunAfter(cron, dueAt)` where `dueAt` is
  the pinned snapshot occurrence — applied uniformly to the success path,
  the post-create-exception reconciliation success path, the released-
  failure path, and the claim-lost path. Missed ticks remain due and are
  caught up one occurrence per pass by normal `due()` processing.
- `reconcileScheduleRows`: `next_due_at` now derives from the latest
  **contiguous accounted** occurrence. Rows for a schedule are walked in
  `due_at` order while each is terminal (FIRED or RELEASED — both are
  accounted) AND each `due_at` is exactly the next cron tick. The chain
  stops at a non-terminal row or a missing tick. `next_due_at` is repaired
  to `nextRunAfter(cron, anchor)` in BOTH directions: a stale value
  pointing at accounted work advances; a pre-R5 skipped value rewinds so
  un-attempted ticks fire. `anchor === null` → no terminal evidence →
  left alone (never guessed).

`dueAt` is canonical because it is the occurrence's identity: occurrence
rows, claim ids, `mission.metadata.scheduled_for`, and binding all key
off it. `now` is only the processing instant — deriving durable schedule
state from it made advancement depend on when the scheduler happened to
run, which is exactly the defect the audit caught.

### §10.11.2 Migration / restart repair

A persisted pre-R5 state (FIRED 10:00, stored `next_due_at` 10:25, no
occurrence rows for 10:05–10:20) is proven wrong at restart: the
contiguous chain ends at 10:00, so `next_due_at` rewinds to 10:05 and the
missed ticks fire on subsequent passes — audited via
`SCHEDULE_ACCOUNTING_RECONCILED` with `anchor_due_at`. Later FIRED
occurrences still dominate `last_*`/run_count derivation; released
occurrences extend the anchor but never count toward `run_count`.

### §10.11.3 Files changed / tests

- `src/pair/mission-schedule.ts` — `nextRunAfter(cron, dueAt)` in
  `_fireDue`; contiguous-anchor `next_due_at` derivation in
  `reconcileScheduleRows` (loop now covers every schedule carrying any
  occurrence row, not only valid-FIRED).
- `src/__tests__/pair-p11-r5.test.ts` — **9 tests**: §6.A missed-tick
  fire, §6.B post-create exception, §6.C legacy skip repair, §6.D
  multiple historical, §6.E idempotency + genuine restart (closed store,
  fresh stack), contiguity proofs (gap / RELEASED extends / in-flight
  CLAIMED ends chain).
- `src/__tests__/pair-p11-r2.test.ts` — worker `fire` race `now` pinned
  to `dueAt` so a missed tick can't legitimately fire under the loser
  (deterministic, no assertion weakened).
- `src/__tests__/pair-p9.test.ts` — one assertion updated: it encoded
  the pre-R5 skip (`next_due_at > "2099-01-01"` after firing with
  `now=2099`); now asserts the exact canonical value
  `nextRunAfter(cron, dueAt)`. Strengthened, not weakened.
- `.github/workflows/ci.yml` — focused P11 step includes r5 file.

### §10.11.4 Verification

- P11 suites: **99/99** (22+25+19+12+12+9) on Node 22 and Node 20.
- Full suite Node 22: **1781 pass** / 24 skipped / 2 pre-existing
  env-dependent `pair-p5.test.ts` probe fails (dsh/codex binaries on the
  dev box — green on CI, unchanged). Node 20: **1783 pass, 0 fail**.
- `pnpm run typecheck` clean; `pnpm run build` clean.
- `pnpm audit --audit-level=high`: **0 high, 0 critical** (1 low,
  8 moderate — expected posture).
- `PairEvidenceStore.verifyIntegrity` clean after restart repair
  (hash check would throw).
- R2 worker_threads contention races unweakened and green.

### §10.11.5 Remaining limitations

- Catch-up is one occurrence per `fireDue` pass — a schedule days behind
  converges over multiple ticks (deliberate: firing all missed
  occurrences at once could flood a restarted system).
- A fresh in-flight CLAIMED row ends the contiguous chain; if its owner
  died inside the TTL window the schedule waits out the TTL before the
  tick becomes re-firable (existing grace semantics, unchanged).

### §10.11.6 Branch protection

Unchanged: **OPERATOR ACTION REQUIRED** — integration token 403; NOT
enabled. Enable after R5 audit passes, before merge.

**Classification submitted for independent audit:
`P11_REMEDIATED_R5_PENDING_AUDIT`.** Final `P11_OFFICIAL_FINAL_PASS`
requires the independent re-audit — this report does not self-certify.
