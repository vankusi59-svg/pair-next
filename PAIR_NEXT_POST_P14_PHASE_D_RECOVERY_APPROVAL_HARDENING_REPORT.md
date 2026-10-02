# PAIR NEXT — POST-P14 PHASE D: RECOVERY + APPROVAL HARDENING REPORT

- **Branch:** `devin/post-p14-phase-d-recovery-approval-hardening`
- **Base:** `0eb2495` (post-#25 merge, Phase C + R1)
- **Scope:** mandate §1–§13 — explicit approval intents, durable exactly-once exercise, duplicate-request closure, WAITING_APPROVAL convergence, UNKNOWN_SIDE_EFFECT_STATE closure, taxonomy, bounded provenance, boundary preservation
- **Status:** implementation + tests + 2 live E2E scenarios verified; **PENDING INDEPENDENT AUDIT — DO NOT MERGE**

---

## 1. Mandate → implementation map

| § | Requirement | Where | Evidence |
|---|---|---|---|
| §1 | Explicit approval intents (extension / ACK-no-replay / revalidation), never widens authority | `approval-queue.ts` `RECOVERY_APPROVAL_INTENTS`; `mission-runtime.ts` `approvalIntentFor` + `mintRecoveryApproval` | tests A, H; LIVE1, LIVE2 |
| §2 | Durable `approval_exercise` — one approval ⇒ at most ONE runtime effect | `approval-queue.ts` `exercise()` (deterministic `APRE_<id>` + `APPROVAL_EXERCISED` event); `exerciseApprovedRecovery` | tests B, C, D; LIVE1, LIVE2 |
| §3 | Duplicate-request closure: dedupe + restart relink, no orphans | `approval-queue.ts` `request()` expireSweep + PENDING dedupe, `findPendingEquivalent`; `mintRecoveryApproval` relink arm | test E |
| §4 | WAITING_APPROVAL convergence for all statuses | `mission-runtime.ts` `checkPendingApproval` (expireSweep → PENDING wait / APPROVED exercise / DENIED·EXPIRED abort / SUPERSEDED relink-or-abort) | tests F, G |
| §5 | UNKNOWN closure — approve ⇒ barrier settle + task FAILED + zero replay + converge | `runReconciliation` mint arm (intent `ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY`); `exerciseApprovedRecovery` no-replay arm (barrier settled w/ `operator_outcome`, `terminal_outcome` on execution row, pending recovery neutralized) | tests H, I; LIVE1 |
| §6 | AUTHORITY_REJECTED / FAIL_CLOSED_DSH_* → POLICY_DENIAL precedence | `recovery-controller.ts` CLASS_RULE before provider/model regexes | tests J, K |
| §7 | Bounded provenance — identical re-escalation ⇒ abort, no approval loop | `mintRecoveryApproval` exercised-equivalent check → `abortMission("approval_chain_bounded:<signature>")` | test L; LIVE2 |
| §8 | P23 apply boundary, P24 capability authority, routers, Phase C failover preserved; ApprovalQueue never dispatches | zero edits to gate/router/route-selector/dsh-model-router semantics | regression matrix |
| §9 | Tests A–L | `src/__tests__/pair-phase-d-recovery-approval-hardening.test.ts` | 12/12 |
| §10 | LIVE1 + LIVE2 on isolated dirs, durable IDs | `/tmp/pair-mc-phd-live{1,2}` + `/tmp/pair-dsh-home-phd{1,2}` | §4–§5 below |
| §11 | Regression vs `0eb2495` baseline + tsc + build | | §6 |

## 2. Additional REAL defects found and closed in this phase

1. **Apply-arm chain-stomp (production limbo mechanism)** — in RETRY_SAME_ROUTE / RE_ROUTE arms, a terminal settle inside the arm spawned a *successor* recovery chain; the arm's unconditional `clearPendingRecovery` then wiped the successor's `pending_recovery` → runtime stuck RUNNING forever (same mechanism that stranded live mission `MSN_01M3W4FW`). Fix: the apply is only closed when `pending_recovery.recovery_id === pending.recovery_id`.
2. **Extension grant could never yield a dispatch (this session's LIVE2 caught it)** — `recovery_attempt` rows are written per *decision*, so the HUMAN_APPROVAL_REQUIRED decision itself burns an attempt slot: a relative `+N` ceiling is consumed instantly by the next decide, and the `consecutive_identical` guard independently re-escalates identical-signature failures. Fix: the exercised grant records `baseline_attempts` + `baseline_identical` (attempt counts at grant time) and decide() receives absolute ceilings `task_attempt_ceiling` / `consecutive_identical_ceiling` = baseline + grant. Verified: grant +1 ⇒ exactly one dispatch then bounded abort.
3. **Operator decide unreachable (approval scope round-trip gap)** — `approval_request` persisted only `scope_digest`, never the scope; UI/telegram sent `{scope: a.scope ?? {}}` → digest mismatch → every operator decide failed closed. Fix: record now persists `scope_snapshot`; `approvals()` list aliases `scope`; `decide()` scope param optional — falls back to the stored snapshot (digest enforcement unchanged); server handlers pass `body.scope` verbatim instead of `?? {}` so an omitted scope triggers the fallback instead of overriding it.
4. **Exercise-path clock hole** — the fresh `startRecovery` after an exercised approval dropped `now`, anchoring the successor chain's dueAt to wall time; threaded `now` through `checkPendingApproval → exerciseApprovedRecovery → startRecovery` so tick-time semantics stay consistent.

## 3. Tests A–L (focused suite — 12/12 pass)

- **A** extension grant binds to the failed task only (scope, intent, exact grant, `baseline_attempts`, mission ceiling untouched) **and yields exactly one more dispatch, then bounded abort — no second approval**
- **B** one APPROVED ⇒ exactly one durable `APRE_*` row + one grant entry
- **C** restart (reopened db, fresh runtime) re-tick cannot re-apply the grant — `exercise.created:false`
- **D** repeated exercise of the same approval ⇒ one durable winner
- **E** crash after `request()` before linkage ⇒ restart rediscovers + relinks the existing PENDING; no duplicate request
- **F** TTL-expired PENDING inside WAITING_APPROVAL ⇒ bounded terminal (sweep on poll)
- **G** SUPERSEDED approval cannot wedge WAITING_APPROVAL (relink or bounded terminal)
- **H** UNKNOWN no-replay approve ⇒ barrier settled + `OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY` + task FAILED + zero replay + converged
- **I** denied no-replay ⇒ bounded terminal
- **J** `AUTHORITY_REJECTED`/`FAIL_CLOSED_DSH_*`/`FAIL_CLOSED_MODEL_*` classify ⇒ POLICY_DENIAL, never availability retry
- **K** `ROUTE_INFEASIBLE` classification preserved (P24)
- **L** identical re-escalation after an exercised grant ⇒ bounded abort (`approval_chain_bounded`), not another approval

## 4. LIVE1 — post-dispatch UNKNOWN → reconcile → approve NO-REPLAY

Isolated `PAIR_MC_DIR=/tmp/pair-mc-phd-live1`, `PAIR_DSH_HOME=/tmp/pair-dsh-home-phd1`, port 8899, fixture `fake-acp-agent-phc.mjs` with `hang_after_effect` on both pool models (writes marker + `agent_out.txt`, never replies).

```
mission MSN_01M3X38SW5FSENMCCZ67Q7FZ6E (pinned single task, REASONING → DSH)
kill -9 <serve pid> mid-flight → exec EXE_83976ddad7307098d3b358dd78107cb0 = UNKNOWN
restart → 2× reconciliation_receipt UNKNOWN_SIDE_EFFECT_STATE (REC_01M3X390V8..., REC_01M3X392S...)
        → APR_01M3X392T007W66W3FQBPDYT7W PENDING, intent=ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY, risk=HIGH
        → runtime WAITING_APPROVAL
POST /api/approvals/.../approve {scope:<snapshot>} → APPROVED
→ APRE_01M3X392T007W66W3FQBPDYT7W (deterministic)
→ barrier settled, operator_outcome=OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY
→ exec terminal_outcome=OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY
→ task TSK_01M3X38VJ18... FAILED, mission FAILED — converged
marker lines = 1 → ZERO replay
```

**PASS.**

## 5. LIVE2 — attempt ceiling → EXTENSION approve → exactly one more → restart → grant not reapplied

Isolated `PAIR_MC_DIR=/tmp/pair-mc-phd-live2`, both pool models `fail_prompt` (post-dispatch failure, TRANSIENT_TRANSPORT signature).

```
mission MSN_01M3X35PPR37N3J3886F3EJ48J → 3× RETRY_SAME_ROUTE (marker=4)
→ ceiling → RCV_01M3X362XPTK9FKVVJEPVQB7HH sel=HUMAN_APPROVAL_REQUIRED
→ APR_01M3X362XQESMEAVM7R9NGD8CW PENDING intent=RECOVERY_TASK_ATTEMPT_EXTENSION grant={"attempts_per_task":1}
approve → APRE_01M3X362XQESMEAVM7R9NGD8CW (exercise rows=1) → kill -9
restart → grant NOT re-applied (exercise still 1, no second approval row)
        → budget_extension.tasks[TSK]={attempts_per_task:1, baseline_attempts:4, baseline_identical:4}
        → fresh decide → RETRY_SAME_ROUTE → dispatch #5 (marker 4→5: exactly one more)
        → fails → ceiling again → mint → §7 exercised-equivalent → abort
        → runtime ABORTED reason=approval_chain_bounded:TRANSIENT_TRANSPORT::DEEPSEEK_HARNESS::any
        → task FAILED, mission bounded — no re-apply, no duplicate approval
```

**PASS.**

## 6. Regression matrix

| Check | Baseline `0eb2495` | This branch |
|---|---|---|
| Focused suite | — | **12/12** |
| Full suite | 2526 pass / 2 fail / 15 skipped | **2538 pass / 2 fail / 15 skipped** (+12 new, zero regression) |
| Failing tests | 2× env P5 probes (real dsh/codex binaries absent) | identical 2× env P5 — same tests |
| `tsc --noEmit` | clean | clean |
| `pnpm build` | clean | clean |

## 7. Boundary preservation (§8)

- No semantic change in `gate.ts`, `route-registry.ts`, `route-selector.ts`, `multi-executor.ts`, `mission-router.ts`, `dsh-model-router.ts`, `mission-supervisor.ts`.
- ApprovalQueue never dispatches: it only records intent/digest/exercise evidence; every runtime effect flows through `mission-runtime` chains with the same governed decide/apply boundary.
- Phase C failover untouched (pre-dispatch boundary + AUTHORITY_REJECTED provenance preserved; the new CLASS_RULE only maps those classes into POLICY_DENIAL for the recovery matrix).

## 8. Changed files

- `src/pair/approval-queue.ts` — intents, scope_snapshot, dedupe/relink, `exercise()`, `listExercised()`, optional-scope `decide()`
- `src/pair/mission-runtime.ts` — UNKNOWN→recovery on observe, `approvalIntentFor`/`mintRecoveryApproval`/`exerciseApprovedRecovery`, convergence, chain-stomp guard, baseline-anchored ceilings, `now` threading, inFlight filters
- `src/pair/recovery-controller.ts` — POLICY_DENIAL class rule, absolute-ceiling extension inputs, unsettled filter excludes `terminal_outcome`
- `src/pair/mission-control.ts` — `scope` alias on approval list; optional-scope approve/deny
- `src/pair/mission-control-server.ts` — pass `body.scope` verbatim (snapshot fallback)
- `src/__tests__/pair-phase-d-recovery-approval-hardening.test.ts` — new (12 tests)
- this report

## 9. Limitations

- `RECOVERY_OPERATOR_REVALIDATION` exercised effect is a bounded re-decision (no new facts ⇒ same signature re-escalates once ⇒ §7 abort) — tested via L; dedicated variant would be an easy add.
- Legacy flat `budget_extension.attempts_per_task` grants (pre-task-scoped shape) keep relative semantics — no baseline anchor; only new grants get anchored ceilings.
- LIVE1/LIVE2 drive a single pinned task per mission; multi-task mixed outcomes rely on unit coverage.

## Classification

`PAIR_NEXT_PHASE_D_RECOVERY_APPROVAL_HARDENING_PENDING_INDEPENDENT_AUDIT`

**STOP. DO NOT MERGE. DO NOT START PHASE E.**

---

# Phase D R1 — Taxonomy + Exact-Once Approval Exercise + Scope Authority Closure

Remediation of 6 findings on HEAD `fb17812c4ff88435a8216a979ae301cb8850e03c`. Same PR #26 / same branch. No redesign of MissionRouter/RouteSelector/DshModelRouter or the PR #23 recovery architecture.

## R1.1 Corrected DSH failure taxonomy

CLASS_RULES order (authority test = first match wins):

| Code | Class | Why |
|---|---|---|
| `FAIL_CLOSED_ROUTE_INFEASIBLE` | `ROUTE_INFEASIBLE` | unchanged (PR #24) |
| `FAIL_CLOSED_DSH_MODEL_EXHAUSTED` | **`TRANSIENT_TRANSPORT`** | NEW rule placed BEFORE the DSH authority blanket. Pool exhaustion aggregates *safe pre-dispatch availability* failures (provider down / model unavailable / credential missing) across every configured candidate — it is an availability outcome, not governance. It keeps recovery semantics (RETRY_SAME_ROUTE → RE_ROUTE → RECONCILIATION_REQUIRED), never an automatic ABORT merely because the code carries the `FAIL_CLOSED_DSH_` prefix. |
| `AUTHORITY_REJECTED`, `FAIL_CLOSED_DSH_*` (all others), `FAIL_CLOSED_MODEL_ROLE`, `FAIL_CLOSED_MODEL_IDENTITY` | `POLICY_DENIAL` | unchanged — role violations, planner overlap, model-identity drift, invalid model binding, executor/provider authority invalid stay fail-closed bounded ABORT |

Test J split: J1 asserts the authority set → POLICY_DENIAL; J2 asserts `FAIL_CLOSED_DSH_MODEL_EXHAUSTED` → TRANSIENT_TRANSPORT via both `error_code` and `result.error.code`.

## R1.2 APRE lifecycle — deterministic, atomic, resumable

`approval_exercise` row (entity `approval_exercise`, deterministic id `APRE_<approval suffix>`):

```
RESERVED  →  APPLYING            →  APPLIED
(exercise() version-0 INSERT)      (markExercisedApplied, last write)
fields: approval_exercise_id, approval_id, approval_type, requested_action,
        intent, mission_id, task_id, scope_digest, operator_id,
        effect (deterministic plan), state, exercised_at, applied_at, version
```

- **Concurrency**: two writers on *separate store connections* race the same version-0 INSERT → `ON CONFLICT DO NOTHING` → the loser catches `FAIL_CLOSED_VERSION_CONFLICT:created-elsewhere`, re-reads the winner's row, returns `{row: winner, created: false}` — a conflict is never surfaced as a runtime defect (test O: real second `PairEvidenceStore` + `ApprovalQueue` on the same db, loser's stale read forced via one-shot `tryGet` miss).
- **Effect plan persisted once**: `exerciseApprovedRecovery` computes a deterministic plan (extension grant + `baseline_attempts` + `baseline_identical`) and passes it to `exercise(approvalId, plan)`; a resumer reuses `row.effect` verbatim — baselines can never drift between crash and restart.
- **Crash window closed**: if the process dies with `state=APPLYING` (APRE durable, effect incomplete), the next `exercise()` call returns the same row and the runtime **re-applies the full idempotent effect** — it does NOT skip because APRE exists. `state=APPLIED` is written only after every effect write landed (`markExercisedApplied` is the final statement of `exerciseApprovedRecovery`).
- **REVALIDATION re-entry bound**: the fresh post-exercise chain is stamped `pending_recovery.approval_exercise_id = <APRE id>`; `resumeExercisedChain` returns early when the stamped chain already exists — a restart/re-entry can never mint a second fresh recovery decision for the same exercise (tests P1, P2).

## R1.3 Scope authority restored

`ApprovalQueue.decide()` REQUIRES caller-presented scope:

| Presented | Result |
|---|---|
| `scope == null` | throws `FAIL_CLOSED_APPROVAL_SCOPE_REQUIRED` — stored `scope_snapshot` is NEVER substituted into the authority check |
| mutated scope | throws `FAIL_CLOSED_APPROVAL_SCOPE_MISMATCH` (digest ≠ bound `scope_digest`) |
| canonical scope | PASS |

`scope_snapshot` stays persisted; the API/UI projection (`approvals()` → `scope` alias, `GET /api/approvals`, `POST /api/approvals/:id/{approve,deny}` body, telegram bridge `a.scope`) keeps echoing the exact canonical scope — operator clients fetch it and present it back; they can never silently decide without it. Test M covers all three arms.

## R1.4 Canonical-time expiry

`checkPendingApproval(missionId, now)` now calls `expireSweep(now)` — supplied runtime/test time governs expiry, wall clock is irrelevant. Test N: `expires_at=2999-06-01` (future vs wall clock ~2026) + `tick(mid, "2999-07-01")` → EXPIRED + ABORTED — impossible under the old bare `expireSweep()`.

## R1.5 SUPERSEDED relink — exact equivalent only

Replacement candidates must ALL match the superseded approval:

`mission_id` (listPending filter) ∧ `task_id` ∧ `approval_type` ∧ `requested_action` ∧ `failure_signature` (from `intent` or `scope_snapshot`)

When several match, the candidate carrying the same `recovery_decision_id` wins; a single unambiguous equivalent is adopted; zero → `abortMission("approval_superseded")` (bounded terminal). Task A's approval can never relink to task B's (test Q1 adversarial: foreign-task pending stays PENDING, mission aborts); an equivalent re-minted after the supersede IS adopted (Q2).

## R1.6 Regression — no mandate-scope regressions

| Check | Result |
|---|---|
| Focused suite (updated) | **20/20** — J1/J2 taxonomy, M scope, N canonical expiry, O real-concurrency exercise, P1 crash-after-APRE resume, P2 restart chain dedupe, Q1/Q2 superseded adversarial |
| PR #23 recovery closure (`pair-live-ops-recovery-closure`) | pass |
| PR #24 route capability (`pair-route-capability-authority`) | pass |
| Phase C model routing (`pair-phase-c-dsh-model-routing`) | 51/51 |
| Phase B (`pair-phase-b`) | pass |
| **Full suite** | **2546 pass / 2 fail / 15 skipped** — identical 2 env P5 probe failures (dsh/codex binaries absent); baseline `fb17812` 2538/2/15 → +8 tests, zero regression |
| `tsc --noEmit` | clean |
| `pnpm build` | clean |

### Harness note (not a product change)

`ScriptedAdapter` gained an `idSeed` — a restarted adapter process mints fresh execution ids (real adapters mint UUIDs). Without it, restart tests collided on durable `executor_execution` ids and the gate correctly failed closed (`FAIL_CLOSED_VERSION_CONFLICT` → INTERNAL_RUNTIME_DEFECT). C/P1/P2 restart adapters use seeds `r1_`/`r2_`.

### Preserved (verified by the suites above)

3 intents · task-scoped extension · chain-stomp fix · no-replay UNKNOWN closure · barrier settlement · terminal_outcome · exercised-equivalent bounded chain · PR #23 boundary · PR #24 authority · Phase C routing.

## Changed files (R1)

- `src/pair/approval-queue.ts` — `exercise(id, effect?)` APPLYING lifecycle + loser-adopts-winner, `markExercisedApplied`, scope-required `decide()`
- `src/pair/mission-runtime.ts` — `exerciseApprovedRecovery` rewrite (effect plan, APPLYING resume, `markExercisedApplied`), `exerciseEffectPlan`, `resumeExercisedChain` stamp, `expireSweep(now)`, SUPERSEDED exact-equivalent relink
- `src/pair/recovery-controller.ts` — `FAIL_CLOSED_DSH_MODEL_EXHAUSTED → TRANSIENT_TRANSPORT` rule before the DSH authority blanket
- `src/__tests__/pair-phase-d-recovery-approval-hardening.test.ts` — 20 tests (+8)

## Classification

`PAIR_NEXT_PHASE_D_R1_PENDING_INDEPENDENT_AUDIT`

**STOP. DO NOT MERGE. DO NOT START PHASE E.**

---

# Phase D R2 — APRE Effect Ownership + Crash Convergence Closure

Base: `7f38d86` (R1 audited HEAD). Scope: close the remaining exact-once gap — an APPLYING APRE now proves ONE durable effect owner via CAS claim, and the APRE lifecycle alone discovers unfinished work on any tick, in any mission state.

## APRE state/claim model

`RESERVED → APPLYING → APPLIED`. The APPLYING row is a real lease record:

```
approval_exercise_id (deterministic APRE_<id>), approval_id, approval_type,
requested_action, intent, mission_id, task_id, scope_digest, operator_id,
effect (deterministic plan, incl. stale_recovery snapshot),
state: APPLYING | APPLIED,
owner_id: MRI_* | null, claim_epoch: n, claimed_at, lease_expires_at,
exercised_at, applied_at
```

`exercise()` is unchanged in semantics (winner-creates/loser-adopts, deterministic id) — the row now carries the ownership fields. `markExercisedApplied` is CAS-loss safe: version drift between claim and close re-reads and converges instead of surfacing `FAIL_CLOSED_VERSION_CONFLICT`.

## Owner identity + lease/takeover

- Owner id = `MRI_<ulid>` per `MissionRuntime` instance (`private readonly instanceId`) — a restart is a new owner, never impersonates a dead one.
- `claimExercise(approvalId, ownerId, now, leaseMs=60000)`: pure CAS on the store.
  - APPLIED → `{applied:true}`; owned by self + live lease → CAS renew → `{owned:true}`.
  - Foreign live owner → `{owned:false}` (cannot steal — test G).
  - Unowned or stale lease → CAS takeover `claim_epoch+1`, `claimed_at=now`, `lease_expires_at=now+60s` (test F).
  - `IntegrityError` mid-CAS → bounded retry (≤3), then re-read + `{owned:false}` — contention never leaks as a runtime defect.

## Concurrent losers + orphan discovery

- Losers re-read the canonical row and converge normally — no apply, no decision, no transition, no defect (test A: separate `PairEvidenceStore` connection, foreign active owner).
- `convergeApplyingExercises` runs at the TOP of every tick — before the terminal check — iterating `listExercised({mission_id})`. The APRE lifecycle is self-sufficient to find unfinished work; `mission_runtime` state does not gate discovery.
- `convergeExercise` is the single owned-apply path shared by the WAITING_APPROVAL arm and the sweep: exercise (adopt winner) → claim → applied? bookkeeping only → not-owned? converge → owned? apply effect arms → markExercisedApplied.
- Transitions only fire when `rt.state === WAITING_APPROVAL` (`waiting` flag) — orphan convergence completes effect writes without stomping a mission that already moved past the approval wait; chain resume is skipped on terminal missions.

## Per-intent idempotency (all keyed by approval_exercise_id)

- **EXTENSION**: grant written as a keyed assignment `budget_extension.tasks[taskId] = {attempts_per_task, baseline_*, approval_exercise_id}` — deterministic values from the persisted plan; re-apply writes identical values (test C: entry count/value frozen).
- **REVALIDATION**: fresh chain stamped `pending_recovery.approval_exercise_id`; stamped → adopt, no second `recovery_decision` (test D). `stale_recovery` snapshot in the effect plan rebuilds the chain deterministically if the crash hit between clear and mint.
- **ACK_NO_REPLAY**: stamp-guards on barrier (`approval_exercise_id` equality), task FAILED, exec `terminal_outcome` — re-entry performs zero writes; task never re-dispatched (test E: `dispatched=0` on the peer).

## Crash-convergence evidence (tests A–G)

| # | Scenario | Result |
|---|----------|--------|
| A | Foreign live owner + lease-expiry takeover, EXTENSION | 1 APRE / 1 owner-at-a-time / 1 grant / decisions +1 only / no defect |
| B | Crash after claim, before effect (REVALIDATION) | takeover → single chain → APPLIED |
| C | Crash after extension persisted | grant never stacks; stamped chain resumed; APPLIED |
| D | Crash after fresh chain persisted | chain adopted (`recovery_id` unchanged), no 2nd decide; APPLIED |
| E | Crash after no-replay effect (terminal mission) | zero replay, single settlement/outcome; APPLIED |
| F | Stale owner after lease expiry | takeover, epoch 2 |
| G | Live owner cannot be stolen (separate connection) | `owned:false`, row untouched |

## Regression

| Suite | Result |
|-------|--------|
| Phase D focused (`pair-phase-d-recovery-approval-hardening`) | **27/27 pass** |
| PR #23 (`pair-live-ops-recovery-closure`) | pass |
| PR #24 (`pair-route-capability-authority`) | pass |
| Phase C (`pair-phase-c-dsh-model-routing`) | pass |
| Phase B (`pair-phase-b`) | pass |
| **Full suite** | **2553 pass / 2 fail / 15 skipped** — identical 2 env P5 probe failures; R1 `7f38d86` 2546/2/15 → +7 tests, zero regression |
| `tsc --noEmit` | clean |
| `pnpm build` | clean |

## Changed files (R2)

- `src/pair/approval-queue.ts` — APRE owner/lease fields on exercise(), new `claimExercise` CAS loop, CAS-safe `markExercisedApplied`
- `src/pair/mission-runtime.ts` — `instanceId`, pre-terminal `convergeApplyingExercises` sweep, unified `convergeExercise` (claim → owned-apply → close), `waiting`/`terminal` guards on transitions + chain resume, `stale_recovery` snapshot in `exerciseEffectPlan`, stamp-guarded ACK arm
- `src/__tests__/pair-phase-d-recovery-approval-hardening.test.ts` — +7 tests (A–G)

## Classification

`PAIR_NEXT_PHASE_D_R2_PENDING_INDEPENDENT_AUDIT`

**STOP. DO NOT MERGE. DO NOT START PHASE E.**
