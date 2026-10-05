# P-REASK — Planner Canonical-Rejection Feedback Re-ask

**Base**: `main` @ `66d2062` (post-PR #45 P-GRAMMAR2 merge)
**Branch**: `devin/1791162903-preask-feedback`
**Status**: `PAIR_NEXT_PREASK_PLANNER_REJECTION_FEEDBACK_PENDING_AUDIT`

## 1. What changed

When a planner candidate emits a non-empty plan that reaches the
canonicalize seam and is rejected by an eligible typed canonical
plan-validation `IntegrityError`, PAIR now gives the SAME candidate
exactly ONE PAIR-authored bounded rejection-feedback re-ask before
failing over to the next candidate.

| Mandate | Implementation |
|---|---|
| **R0** eligibility | `extractReaskEligibleCode(e)` in `planner-pool.ts`: re-ask only when the initial emission was non-empty, canonicalize threw `IntegrityError`, the raw code is non-empty, ≤80 chars, charset `^[A-Z0-9_:.\-]+$`, prefix `FAIL_CLOSED_(PLAN|DELIVERY|TELEGRAM|TASK)_*`, re-ask not yet consumed for this candidate, and the per-candidate latency budget has remaining time. NEVER for eligibility/authority/transport/spawn/timeout/credential/NO_JSON-degenerate/rejected-reask. Feedback = exact code + `DROP_*`/`DEP_*`/`REPAIRED_*` task-keyed markers from the rejected emission (safe-charset, deduped, ≤10) — no raw output, instructions, exception text, or secrets. |
| **R1** shared contract | `PlannerInvocation {kind: "INITIAL"|"REASK", timeoutMs?, maxProviderRequests?, rejectionContext?}` passed to `planFn`. Optional `rejectionContext` on `buildPlannerUserPrompt` renders a `PLAN REJECTION` block next to (not replacing) F3 `replanContext`, with the verbatim MINIMAL-REPAIR wording: *"Your previous plan from this same planner candidate was rejected by PAIR for the following canonical validation defect. Do not re-emit it unchanged. Make the minimum change necessary to fix the named defect. Preserve unrelated task structure, capabilities, dependencies, constraints and delivery intent. Request no wider authority."* Wired identically through `llmPlan` and `codexPlannerPlan`. `replanContext` untouched. |
| **R2** one provider request | `LlmPlannerConfig.maxProviderRequests` (default 2 preserves the historical contract; re-ask passes 1 → the internal ≤2 retry loop is bounded to a single fetch on REASK). Codex transport performs exactly one `codex exec` per `planFn` call by construction — `maxProviderRequests: 1` is the shared contract marker. A prior internal INITIAL retry does not consume the re-ask. No recursive re-ask. |
| **R3** latency ceiling | `latencyBudget(c)` opt-in wiring: HTTP candidates ceiling `2*cfgPlannerTimeoutMs`, codex ceiling `cfgCodexPlannerTimeoutMs`, measured from attempt START. REASK effective `timeoutMs = min(requestTimeoutMs, remaining)`; `remaining ≤ 0` → no re-ask. No new env knob. |
| **R4** durable single-row provenance | `markPlannerAttemptReask(store, {planner_attempt_id, validation_code, actor})` — inside one `store.immediate` txn, only when the row is `STARTED`: appends `REASK:<code>` to row warnings (dedupe, ≤10) + emits `PLANNER_ATTEMPT_REASK_STARTED` event (old_state=STARTED → new_state=STARTED, metadata binds planner_run_id/route/model_entry_id/attempt_no/validation_code) — persisted BEFORE the second invocation. SUCCESS settles with `REASK:<code>` + `REASK_SUCCEEDED:<code>` on the same row/attempt_no. A failed re-ask settles once, then failover proceeds; a second rejection with a different code keeps `VALIDATION_CODE:<final>` as the final identity while `REASK:<first>` records what triggered the re-ask. Eligibility is re-proved before the second invocation: authority throws propagate, availability reject prevents the re-ask. `reaskInitiated` merges the marker into AUTHORITY_REJECTED/NETWORK_ERROR settles so a crash-after-mark keeps durable provenance. |
| **Warnings** | `boundedAttemptWarnings` protects `REPAIRED_REMOTE_DEPENDENT_EDGE:*`, `REASK:*`, `REASK_SUCCEEDED:*` — protected entries take precedence, non-protected earliest-fill remaining slots, ordered, deduped, ≤10, deterministic. Winning-plan metadata returns the corrected emission's own warnings (`res.warnings` is attempt evidence only) — rejected-plan noise never contaminates the winner. |

## 2. Trigger predicate (exact)

```
initial emission non-empty
∧ canonicalize(tasks) threw IntegrityError e
∧ e.code ∈ /^FAIL_CLOSED_(PLAN|DELIVERY|TELEGRAM|TASK)_/   (raw, untruncated)
∧ e.code matches /^[A-Z0-9_:.\-]+$/ ∧ |e.code| ≤ 80
∧ this candidate's re-ask not consumed
∧ per-candidate latency remaining > 0
∧ assertEligible(c) re-proved (throw → propagate; {reject} → no re-ask)
→ planFn(c, {kind:"REASK", timeoutMs:min(reqTimeout,remaining),
             maxProviderRequests:1,
             rejectionContext:{validation_code:<raw code>,
                               task_warnings:bounded(DROP_/DEP_/REPAIRED_*,≤10)}})
```

## 3. Call accounting

- One candidate = one attempt row = at most one REASK (consumed flag per
  candidate loop iteration; second canonical rejection is terminal).
- INITIAL invocation keeps its existing internal contract (llmPlan ≤2
  provider requests; codex = 1 spawn). REASK is hard-bounded to 1 provider
  request regardless of transport.
- Failover order unchanged: candidates tried in configured order; a
  re-ask never reorders the pool.

## 4. Evidence shape (durable, single row)

`planner_attempt` row for a re-asked candidate carries on SUCCESS:

```
REASK:<first_code>  REASK_SUCCEEDED:<first_code>  [+ emission warnings, bounded ≤10]
```

on FAILED:

```
VALIDATION_CODE:<final_code>  REASK:<trigger_code>  CANONICAL_VALIDATION_FAILED
```

plus one `PLANNER_ATTEMPT_REASK_STARTED` event written before the second
invocation (transactionally with the row marker update).

## 5. Tests

`src/__tests__/pair-preask-feedback.test.ts` — **25/25 pass**, covering
the mandate's 23 numbered cases plus adversarial >10-warnings-before-
marker and deterministic replay:

1–4 eligibility predicate (happy path; wrong prefix; IntegrityError-type
gate; empty plan); 5–8 no-re-ask classes (authority propagate,
availability reject, eligibility-not-reproved defect, exhausted
latency); 9 re-ask consumed-once semantics; 10–11 transport/timeout/
NO_JSON never re-asked; 12–12b llmPlan `maxProviderRequests=1` → exactly
one fetch, default → ≤2 preserved; 13 codex one invocation marker;
14 INITIAL-internal-timeout → emission → rejection → REASK = ≤3 fetches
total; 15–17 latency budget (remaining ≤0, min-timeout clamp,
codex-vs-http ceilings); 18–20 durable markers on AUTHORITY_REJECTED /
NETWORK_ERROR after markReask; 21 + adversarial bounded warnings with
real store (ordering `attemptStart → INITIAL → markReask → REASK →
settle`); 21b winner warnings describe corrected emission only; 22
replanContext untouched; 23 candidate ordering unchanged; helper-level
charset tests.

**Regression**: `pair-prv2b-goal-coverage` test J updated + J2 added —
candidate#1's incomplete plan now gets its ONE re-ask (still rejected →
failover to c2 wins) and a self-corrected re-ask wins on c1 (attempt row
carries `REASK:FAIL_CLOSED_PLAN_INCOMPLETE` /
`REASK_SUCCEEDED:FAIL_CLOSED_PLAN_INCOMPLETE`). This is the mandated
semantic change, not a weakened check: the typed rejection still fires
first.

## 6. Live proof (scratch stack, `pair-mc-preask`, prod-identical routes)

Scratch `PAIR_MC_DIR`, fresh boot, planner pool probed QUALIFIED:
`codex-cli:gpt-6.1-sol` primary + `gemini:gemini-3.1-flash-lite` +
`badq:openai/gpt-oss-20b` fallbacks — the prod configuration. Preview
endpoint only (`POST /api/missions/preview`); **zero missions minted,
zero remote dispatches, zero deliveries** — no side effects.

**Incident goal A — verbatim durable goal text** (prod `mission.goal`,
`MSN_01M44NRYXKCV4Z20G48YEZ778Q`, the goal that produced the
UNGOVERNED_REMOTE_EDGE incident on prod):

Attempt #1 `codex-cli:gpt-6.1-sol` (PA_01M44TXS2…, latency 37,288ms —
well under the 900s codex ceiling):
- INITIAL emission → canonicalize threw `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`
- `PLANNER_ATTEMPT_REASK_STARTED` event persisted with
  `validation_code: FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED` —
  **BEFORE** the second invocation (durable ordering proven by
  events+row)
- REASK emission → second canonical rejection with a **different**
  typed code → settle FAILED, row warnings:
  `REPAIRED_REMOTE_DEPENDENT_EDGE:T2 |
   VALIDATION_CODE:FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK |
   REASK:FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED |
   CANONICAL_VALIDATION_FAILED`
  — final identity (DELIVERY_VERB) preserved, trigger code (NETWORK_CAP)
  recorded — exactly R4.
- Attempt #2 gemini → SUCCESS after its own internal HTTP-503 retry
  (independent of re-ask) → **READY preview `MPP_01M44TZDY…`**,
  planner_run WINNER_SELECTED attempt#2. One attempt row per candidate.

**Incident goal B** — the 8-task DATAFLOW_ORDER incident. Honest note:
the EXHAUSTED planner previews on prod persist **no** goal text (no
`mission_plan_preview` row is written on exhaustion — an observability
gap worth a future mandate). The verbatim goal text was recovered from
the operator-chat suggestion record (the text the operator sent to the
bot); no goal was invented. Result: EXHAUSTED — but now every eligible
rejection produced a durable re-ask:

- #1 sol: first reject `FAIL_CLOSED_PLAN_INCOMPLETE` → REASK event+marker
  → second reject `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED` (final
  identity) → FAILED.
- #2 gemini: first `FAIL_CLOSED_PLAN_INCOMPLETE` → REASK → second
  `FAIL_CLOSED_PLAN_DATAFLOW_ORDER` → FAILED.
- #3 badq: first `FAIL_CLOSED_PLAN_DATAFLOW_ORDER` → REASK → re-asked
  invocation hit `LLM_PLANNER_HTTP_429` → FAILED `QUOTA_RATE_LIMITED`
  (transport failure on re-ask settles once — `REASK:` marker durable).
- Run row: `EXHAUSTED`, `attempts: 3` — one attempt row per candidate.

On both goals the strongest candidate (sol) demonstrably received
PAIR-authored rejection feedback on the same attempt row instead of
being discarded after one narrow typed defect.

## 7. Validation summary

| Check | Result |
|---|---|
| Focused P-REASK | **25/25 PASS** |
| Regression (12 files: preask, phase-b, cpl1, llm-planner, pgrammar2, prv2a, prv2b, f3×4, dataflow-incident) | **547/547 PASS** (post-J/J2 update) |
| Full suite | **3584 pass / 2 fail** — the 2 P5 env-only failures (`CODEX_EXECUTABLE` absent), identical to baseline `66d2062`; not converted |
| `tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | clean |
| `pnpm audit` | 9 (1 low, 8 moderate, 0 high) — baseline unchanged |

## 8. Changed files

```
 src/pair/planner-pool.ts                       | +252
 src/pair/llm-planner.ts                        | +37
 src/pair/plan-preview.ts                       | +52
 src/pair/codex-planner.ts                      | +6
 scripts/serve-mission-control.mjs              | +28
 src/__tests__/pair-prv2b-goal-coverage.test.ts | +42 (J updated, J2 added)
 src/__tests__/pair-preask-feedback.test.ts     | +674 (new)
```

## 9. Remaining findings / non-goals

- **Observability gap (pre-existing)**: an EXHAUSTED planner preview
  persists no goal text — the durable store records planner_run/attempt
  rows only. Goal text for failed previews must be recovered externally.
  Worth a separate mandate (persist goal hash+text on planner_run).
- Re-ask corrects a *correctable* candidate; goals with multiple
  simultaneous defects (goal B) still exhaust — by design: every defect
  remains typed and durable, and no gate was weakened.
- No change to failover order, validator strictness, delivery authority,
  F1–F5/RPN-1/DSN-1 invariants, or any env knob.

**DO NOT MERGE** — pending independent audit.

---

## 10. R1 remediation (audit on HEAD `59357d82e4d8a4a5beae12c15d2fbc251be5fd64`)

### R1.A — double-settlement on re-proof authority throw: CLOSED

**Defect**: the second `assertEligible(c)` call sat inside an inner
try/catch that settled the candidate `AUTHORITY_REJECTED` and then
rethrew — the propagated `IntegrityError` landed in the outer catch,
which settled the SAME candidate a second time: two `onAttemptEnd`
calls, two `PLANNER_ATTEMPT_FAILED` events, two `attempts` entries.

**Fix (smallest control-flow correction, no failover refactor)**: the
inner try/catch was removed entirely; `const elig2 = await
opts.assertEligible(c)` now falls straight into the outer catch, which
settles the attempt EXACTLY ONCE with `AUTHORITY_REJECTED:<code>` and
rethrows the ORIGINAL error unmodified. `reaskInitiated` is still null
at that point so no REASK marker is merged; the attempt keeps its
original `attempt_no`.

**Proof** (test `R1.A`): INITIAL eligibility passes → non-empty plan →
canonicalize throws `FAIL_CLOSED_PLAN_INCOMPLETE` (eligible) → second
eligibility throws `FAIL_CLOSED_MODEL_AUTHORITY_DENIED` → asserted:
exact propagated code, `planner_attempt` count == 1, `onAttemptEnd`
calls == 1, `PLANNER_ATTEMPT_FAILED` events == 1, planFn invocations ==
1 (zero REASK), zero `REASK:` markers/events, `attempt_no` == 1.

### R1.B — remaining budget recomputed AFTER eligibility re-proof: CLOSED

**Defect**: `remaining` was snapshotted BEFORE `assertEligible(c)` — the
re-proof's own latency was never deducted from the REASK timeout, so a
re-ask could exceed the candidate ceiling by exactly the proof's cost.

**Fix**: keep the pre-check (`preReproofRemaining > 0` — skips the proof
entirely when already out of budget), then after the proof PASSES
recompute `remaining = ceilingMs - (Date.now() - t0)`. Only when that
post-reproof remainder is positive is the durable REASK marker written
and the model invoked, with `timeoutMs = min(requestTimeoutMs,
remaining)`. Non-positive remainder → the candidate settles on the
ORIGINAL canonical rejection (`VALIDATION_CODE:<code>` +
`CANONICAL_VALIDATION_FAILED`, `PLAN_INVALID`) and failover proceeds.
No new env knob.

**Proof**:
- `R1.B-1`: eligibility call counter — call #1 (INITIAL for A) returns
  immediately and does NOT consume the ceiling; call #2 (the REASK
  re-proof) sleeps 150ms > the 60ms ceiling; call #3 (B's INITIAL) is
  immediate. Asserted: the re-proof call actually occurred
  (`eligCalls == [1,2,3]`), zero REASK planFn invocations, zero `REASK:`
  marker, zero `PLANNER_ATTEMPT_REASK_STARTED` events, candidate A
  settles original `PLAN_INVALID` with exact
  `VALIDATION_CODE:FAIL_CLOSED_PLAN_INCOMPLETE`, candidate B wins
  normally.
- `R1.B-2`: `requestTimeoutMs = 30000` sits ABOVE `ceilingMs = 2000` so
  the provider-request bound can never mask the remaining-budget value.
  The re-proof burns a measurable ~400ms. Asserted: REASK `timeoutMs`
  is bounded by the POST-reproof remainder (`≤ postBound + 50ms jitter`),
  is materially lower than the PRE-reproof remainder (`≤ preBound - 200`),
  and is > 0.
- **Counterfactual proven**: both tests were executed against the
  pre-R1.B implementation (HEAD `59357d8` in a scratch worktree) — both
  FAIL (`timeoutMs == 2000 vs bound 1648`; REASK invoked despite the
  exhausted budget), demonstrating the tests detect the stale-remaining
  defect rather than passing vacuously.

### R1.C — REASK evidence persistence fails closed: CLOSED

**Defect**: `markPlannerAttemptReask` silently returned when the
`planner_attempt` row was missing, when `outcome !== "STARTED"`, or when
the validation identity was invalid — the second model invocation would
proceed with no durable provenance.

**Fix**: the canonical seam now throws a governance-specific
`IntegrityError` on each of those conditions:
`FAIL_CLOSED_PLANNER_REASK_PROVENANCE:CODE` / `:MISSING` / `:OUTCOME`.
`FAIL_CLOSED_PLANNER_*` is NOT in the P-REASK eligible prefix family
(`FAIL_CLOSED_(PLAN|DELIVERY|TELEGRAM|TASK)_*`) — a persistence failure
can never recurse into another re-ask. Thrown inside the outer try, it
settles once as `AUTHORITY_REJECTED` (R1.A semantics) and propagates.
Store CAS/event semantics unchanged. Production ordering is now:
re-proof PASS → positive post-reproof remaining → durable marker +
`PLANNER_ATTEMPT_REASK_STARTED` → only then model invocation #2.

**Proof**: `R1.C` — `onAttemptReask` pointing at a nonexistent row →
propagated `FAIL_CLOSED_PLANNER_REASK_PROVENANCE:MISSING`, planFn
invocations == 1 (model #2 never invoked). `R1.C-2` — settled
(non-STARTED) row → `:OUTCOME` throw; invalid identity → `:CODE` throw;
a STARTED row still accepts the marker (happy path preserved).

### R1 validation

| Check | Result |
|---|---|
| Focused P-REASK (5 new adversarial) | **30/30 PASS** |
| Regression (11 files: preask, phase-b, cpl1, llm-planner, pgrammar2, prv2a, prv2b, f3×3, dataflow-incident) | **522/522 PASS** |
| Full suite | **3589 pass / 2 fail** — same 2 P5 env-only failures as baseline `66d2062`; not converted |
| `tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | clean |
| `pnpm audit` | 6 moderate, 0 high — baseline unchanged |

### R1 changed files (HEAD `59357d8` → R1 HEAD)

```
 src/pair/planner-pool.ts                       | inner catch removed; post-reproof recompute
 src/pair/plan-preview.ts                       | markPlannerAttemptReask fail-closed
 src/__tests__/pair-preask-feedback.test.ts     | +5 adversarial tests (25 → 30)
```

Scope held: no change to trigger prefixes, the one-request bound,
prompt wording, F3 `replanContext`, canonicalize/coverage/dataflow/
delivery gates, pool ordering, executor/model routing, or grammar.

**DO NOT MERGE** — pending independent audit.
