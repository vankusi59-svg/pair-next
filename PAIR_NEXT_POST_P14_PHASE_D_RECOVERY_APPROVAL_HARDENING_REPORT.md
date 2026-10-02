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
