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
