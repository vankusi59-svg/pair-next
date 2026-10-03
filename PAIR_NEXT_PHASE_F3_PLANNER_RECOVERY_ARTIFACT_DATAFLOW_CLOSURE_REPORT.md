# PAIR NEXT — PHASE F3 REPORT

## PLANNER + RECOVERY ARTIFACT/DATAFLOW CLOSURE

**Base:** `350d48de061b57642f8e1e8db2a5aa3b3970b524` (main after #32 merge)
**Branch:** `devin/1791012206-phase-f3-replan-closure`
**PR:** pending — DO NOT MERGE

---

## 1. What shipped

### 1.1 `src/pair/plan-feasibility.ts` (new, 510 lines)

F3 authority module, four contracts:

- `pair-plan-semantic.v1` — `canonicalPlanSemanticDigest(tasks)` covers only
  execution-meaning fields per task: `order`, `task_key`, effective
  instruction (`task_instruction ?? description ?? title`), sorted
  `required_capabilities`, `depends_on` ordered by plan position then
  locale, `produces`/`consumes` from `extractTaskDataflow`, and
  conditional `expected_output_contract` / `pair_telegram_delivery` /
  `pair_output_language` / executor pin. Excludes task_id, plan_id,
  governed_task_id, execution_id, timestamps, model/provider, planner
  provenance, evidence ids.
- `analyzePlanFeasibility(tasks)` — structural-only plan feasibility:
  wraps `assertPlanArtifactStructure` (shared seam with
  `assertPlanDataflow`) and rethrows `IntegrityError`
  `FAIL_CLOSED_PLAN_FEASIBILITY` carrying `.dependency_reason` +
  `.source_code`.
- `pair-recovery-failure-context.v1` — `buildRecoveryFailureContext`
  bounded fields: contract, failure_class, dependency_reason (11-value
  taxonomy: PLAN_DATAFLOW_UNBOUND/AMBIGUOUS/ORDER_INVALID,
  REMOTE_EDGE_UNGOVERNED, REMOTE_CONSUMER_ARTIFACT_MISSING,
  PRODUCER_CANONICAL_ARTIFACT_MISSING, PRODUCER_VALIDATION_UNAVAILABLE,
  ARTIFACT_AUTHORITY_INVALID, LOCAL_PREREQUISITE_MISSING,
  HANDOFF_CONTRACT_INVALID, HANDOFF_MATERIALIZATION_FAILED),
  mission/task ids+keys, plan_id/revision, plan_semantic_digest,
  artifact/producer fields, source_code. No secrets, paths, stacks, or
  prose.
- `pair-replan-attempt.v1` — `ReplanAttemptLedger`: deterministic
  `RPA_<digest24>` ids on `(recovery_id, attempt_index)` bounded slots;
  statuses CANDIDATE/REJECTED_DUPLICATE/REJECTED_FEASIBILITY/
  REJECTED_INVALID/ACCEPTED; idempotent-converge replay, slot conflict →
  `FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT`; `REPLAN_ATTEMPT_RESOLVED`
  event per record. Distinct from `recovery_attempt` (RATT_).
- `MAX_REPLAN_CANDIDATES_PER_DECISION = 2`; `persistedPlanSemanticDigest`
  (revision-row authority with row-recompute fallback);
  `dependencyReasonFromError` code/detail → reason mapping.

### 1.2 Executor-pin fix (`planner_selected_executor`)

Routing pins `task.selected_executor` post-commit (`routeGovernedTask`).
Digest covers `planner_selected_executor` — the commit-frozen PLAN pin —
falling back to `selected_executor` for proposals and pre-F3 rows.
Result: a semantic re-emission of the failed plan still matches
(routing pins are dispatch state, not plan semantics), while a
post-commit row mutation (stale/bypassed instruction) changes the
failed-plan digest so restoring the pinned plan is not a false
duplicate.

### 1.3 `plan-dataflow.ts` — `assertPlanArtifactStructure` export

The pure structural seam (models + requiredEdges + declared-edge
UNSOUND + acyclic + delivery-leaf), consumed by BOTH
`assertPlanDataflow` (goal-aware: intent, language, hygiene) and
`analyzePlanFeasibility` (structural-only). One rule set, two gates.

### 1.4 `service.commitPlan` — commit-boundary re-proof + dual digest

First line: `analyzePlanFeasibility(params.tasks)` — every caller
(initial planning, preview confirm, replan accept) re-proves structure.
Computes `plan_semantic_digest` over COMMITTED rows; persists it on the
`plan` row, `mission_plan_revisions` (alongside raw `proposal_digest`),
and `MISSION_PLAN_COMMITTED` metadata. Committed rows gain
`planner_selected_executor`.

### 1.5 `recovery-controller.ts` — structured context on decisions

`decide()` accepts `failure_context`, persists it on the decision row,
and binds the signature: structured failures get
`<legacy>::rc_<digest16>` suffix (digest of reason+task+plan_digest+
artifact+producer — restart-stable); non-structured failures keep the
legacy `class::executor::capability` signature. DEPENDENCY_FAILURE
matrix → `[REPLAN, ABORT]`.

### 1.6 `mission-runtime.ts` — typed propagation + bounded replan

- DependencyResolutionError / prerequisiteMissing / settle-gate throws
  carry typed context into `startRecovery` → `buildRecoveryFailureContext`
  → pending_recovery + decision.
- `runReplan` rewritten as a bounded candidate loop
  (`ledger.attemptsUsed(recoveryId) < 2`): planner gets
  `replan_context` {recovery_id, failure_signature, failure_class,
  dependency_reason, failed_task_key, failed_plan_semantic_digest,
  rejected_semantic_digests}; candidate evaluated as
  `validatePlanProposal → assertPlanDataflow → semanticDigest →
  forbidden?`; ledger row persisted BEFORE advancing; only ACCEPTED
  mutates old plan (cancel → supersede → scheduler.supersedePending →
  commitPlan → READY); exhaustion → fresh `RecoveryController` decision
  with `FAIL_CLOSED_REPLAN_CANDIDATES_EXHAUSTED` recorded infeasible →
  ABORT for DEPENDENCY_FAILURE.
- `RuntimePlannerInput.replan_context` — structured contract to every
  planner implementation.

### 1.7 `artifact-handoff.ts` — typed DependencyResolutionError

New ctor arg: `{dependency_reason, artifact_name, producer_task_id,
consumer_task_id}` on all ~19 throw sites; `remote_edge_artifact_missing`
splits REMOTE_CONSUMER_ARTIFACT_MISSING (consumer remote) vs
PRODUCER_CANONICAL_ARTIFACT_MISSING (producer remote).

### 1.8 `llm-planner.ts` — explicit byte-dependency prompt

SYSTEM_PROMPT "BYTE DEPENDENCIES" rule (every consumes must bind a
declared produces; remote reads need acread edges) + REPLAN CONTEXT
section carrying failure_signature/reason/failed digest/rejected
digests with do-not-reproduce instruction.

---

## 2. Test evidence

### New files

- `src/__tests__/pair-f3-plan-feasibility.test.ts` — **20 tests**
  (B1–B10 feasibility + A1–A10 semantic digest)
- `src/__tests__/pair-f3-replan-closure.test.ts` — **17 tests**
  (C-typed reasons + pending/decision context, D1–D8 bounded
  duplicates + ordering + invalid, E restart durability, §42 raw-vs-
  semantic, §43 planner context, §44 recovery authority, §45 zero
  remote spend, §47/48 evidence binding)

### Coverage mapping (mandate)

| ID | Proof |
|----|-------|
| C1 unbound | resolver seam → PLAN_DATAFLOW_UNBOUND |
| C2 ambiguous | resolver seam → PLAN_DATAFLOW_AMBIGUOUS |
| C3 remote missing | incident plan → REMOTE_CONSUMER_ARTIFACT_MISSING on decision + pending |
| C4 local prereq | missing workspace artifact → LOCAL_PREREQUISITE_MISSING |
| C5/C6 persist | pending_recovery + post-restart survival |
| C7 evidence | decision signature = planner replan_context signature; attempt binds recovery/digests |
| C8 bounded | no /home/, workspace, stack prose in context values |
| C9 stable sig | same failure+plan → identical signature across restart |
| D1–D5 | same-plan ×2 → REJECTED_DUPLICATE×2, revision stays 1, zero consumer execs, reject BEFORE cancel/supersede, exhaustion → fresh ABORT decision |
| D6/§36 | duplicate then Plan B → ACCEPTED, commits exactly once (2 revisions) |
| D7 | schema-invalid → REJECTED_INVALID, budget still bounded |
| D8/§44 | exhaustion records `FAIL_CLOSED_REPLAN_CANDIDATES_EXHAUSTED` → decide() → ABORT decision row proves it |
| E1–E5 | ledger/context/budget durable across store reopen; slot replay converges, conflicts fail closed; post-accept restart no re-commit; old remote never redispatched |
| §42 | raw proposal_digest differs, semantic equal → still REJECTED_DUPLICATE |
| §43 | replan_context fields + rejected digest progression + superseded_tasks |
| §45 | zero executor_execution for consumer; dispatch count unchanged through rejections |
| §46 | accepted Plan B passes gate/router/approvals (completes via governed dispatch) |
| §47 | revision rows persist proposal_digest AND plan_semantic_digest |
| §48 | attempt rows bind mission/recovery/failed+candidate digests/reason/index/signature |

### Validation on FINAL HEAD

- F3 files: 20 + 17 = **37/37**
- F1: 20 + 25 + 95 (race proof after `rm -rf dist`) ✅
- F2: 53 + 43 + 35 + 18 + 8 ✅ (incl. real-HTTP E2E + real-shell recipes)
- Focused: planner-dataflow-incident 106 · phase-d 37 · live-ops 20 ·
  runtime-hardening 11 · llm-planner 16 · output-delivery-contract 69 ·
  ops-telegram 3 ✅
- `npx tsc --noEmit` → 0 errors
- `pnpm build` → PASS
- `pnpm audit --audit-level=high` → 0 high (1 low, 8 moderate — unchanged)
- **Full regression: 3145 pass / 2 fail** — only the known env-only
  pair-p5 tests 2,3 (missing `dsh`/`codex` binaries; reproduce on base
  `350d48d`)
- Test-harness repairs required by F3 semantics (no production code
  touched): p2/p3/p4 seed fixtures dropped an unbound instruction-
  derived consume that could never pass the governed planning gate;
  p9 tests 19–21 planner stub now returns a semantically distinct
  replan (same-plan replans are correctly REJECTED_DUPLICATE under F3).

## 3. Preserve confirmations

- F1/F2 authority untouched: artifact CAS, acceptance-history binding,
  pin/digest contract, fd-bound materialization, no-clobber
  publication, remote acread lifecycle — all suites green.
- Telegram delivery authority, output-language gates, approvals,
  scheduler, reconciliation — green.
- Rejected candidates are NOT plan revisions; no in-memory-only
  rejection state; duplicate/feasibility checks run BEFORE any
  old-plan mutation; rejection evidence persisted BEFORE advancing.
- No CEO Agent, Brain Layer, Adaptive Strategic Learning, P15 work.

## 4. Production loop incident → governed outcome

The prod loop (T5 DONE on stale outbox/report.txt → language mismatch →
same-plan replan → loop) is now closed: an identical semantic
re-emission is REJECTED_DUPLICATE pre-commit (zero remote spend, zero
revision), the second candidate gets the rejected digest, and after the
bounded budget a fresh RecoveryController decision selects the next
matrix action (ABORT for DEPENDENCY_FAILURE) instead of looping.

**Classification:**
`PAIR_NEXT_PHASE_F3_PLANNER_RECOVERY_ARTIFACT_DATAFLOW_CLOSURE_PENDING_SOURCE_REVIEW`

# R1 SOURCE-REVIEW REMEDIATION (post-audit)

Mandate: production replanner wiring + true semantic digest authority +
crash-safe replan commit. Three blockers; all closed on the same PR.

## R1.1 — production runtime planner honors replan_context

The serve script's planner ignored `input.replan_context`: on REPLAN it
re-emitted pinned_plan_tasks / metadata.llm_plan / the deterministic
template as a "fresh" candidate, guaranteeing REJECTED_DUPLICATE every
time regardless of actual provider availability.

- New module `src/pair/serve-planner.ts` owns the serve composition:
  `makeServeCanonicalizer` (sanitize + PAIR_NATIVE contract enrichment +
  reconcilePlanDataflow — verbatim the prior inline steps) and
  `makeServePlanner` (REPLAN branch: call the configured synchronous
  `replanProvider` with the full `replan_context` — failed digest,
  rejection digests, failure signature; canonicalize its candidate
  through the SAME path as initial plans; `validatePlanProposal` +
  F3 feasibility + semantic duplicate gate all run downstream in
  runReplan).
- No provider configured → `FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE`
  (deducts no attempt slot — provider-absence is not candidate noise).
  Provider candidate exists but fails canonicalization →
  `FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE`. Both bubble to
  recoveryGuard → recovery boundary → next decision — never a replay.
- RuntimePlanner stays synchronous; the mandate's Plan-B acceptance
  ("live replanner unsupported under the synchronous contract" is
  allowed provided REPLAN fails CLOSED) holds when
  `replanProvider: null` — prod currently wires null, so a REPLAN
  decision deterministically lands on the matrix's next action instead
  of looping. Tests A4–A7 prove both branches on the ACTUAL
  serve-composition seam.
- The old planner is deleted from the script entirely (no private
  second path); `canonicalizeLlmTasks` continues to serve the
  planner-failover winner-check.

## R1.2 — selected_executor removed from plan semantics

- `semanticTaskBody` no longer emits `planner_selected_executor`; the
  commitPlan freeze writing `planner_selected_executor` onto committed
  rows is deleted. Router post-commit binding stays (routing evidence
  on task rows) but can never make two identical plans look different,
  and a pre-F3 legacy plan now computes the SAME semantic digest before
  routing, after routing, and after restart (B3+B5 committed-row digest
  equals revision digest across those windows).

## R1.3 — crash-safe replan commit (PREPARED → ACCEPTED)

- `replan_attempt` gains `PREPARED` status + `prepared_tasks`,
  `prepared_proposal`, `superseded_plan_id`, and `commit_receipt
  {plan_id, revision, plan_semantic_digest}`.
- `ledger.record({status:"PREPARED", ...})` durably persists the exact
  validated candidate BEFORE any mutation; a validated proposal is
  never called ACCEPTED pre-commit.
- The commit is ONE atomic `store.immediate` region:
  {find already-committed revision by digest EXCLUDING the superseded
  plan_id → bind receipt | commitPlan} + markCommitted + old-task
  cancel/PLAN_SUPERSEDED + approvals.supersede +
  scheduler.supersedePending + clearPendingRecovery +
  transition READY. Crash inside → rollback, old plan intact, PREPARED
  survives; crash after → fully durable.
- Restart resume: runReplan checks `pendingPrepared(recovery_id)` FIRST —
  >1 → `FAIL_CLOSED_REPLAN_ATTEMPT_STATE`; ==1 → re-commit the SAME
  durable candidate with ZERO planner calls. Committed-revision
  digest search excludes the superseded plan_id (a legitimate replan
  restoring committed semantics shares the failed plan's digest —
  receipt binding must never match the superseded row).
- `markCommitted` is a closed state machine: PREPARED→ACCEPTED+receipt
  + RESOLVED event; same receipt idempotent; conflicting receipt or
  non-PREPARED slot → `FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT`;
  missing id → `FAIL_CLOSED_REPLAN_ATTEMPT_MISSING`.
- `record()` replay check now compares ALL immutable facts
  (mission_id, recovery_id, attempt-index slot fields excluded from
  conflict but slot-keyed, failure_signature, failed/candidate/proposal
  digests, rejection_reason, superseded_plan_id, prepared-tasks digest)
  — conflicting replay FAIL CLOSED, identical replay converges.

## R1 tests (pair-f3-r1-remediation.test.ts — 20/20)

- A1–A3 initial-plan branches preserved (pinned → llm_plan → template).
- A4 no provider → UNAVAILABLE fail-closed on the real composition.
- A5 uncanonicalizable provider candidate → INFEASIBLE.
- A6 provider candidate canonicalized; replan_context reaches provider.
- A7a/b/c E2E on MissionRuntime: provider null → REPLAN infeasible →
  ABORTED, 1 revision, 0 attempts consumed; Plan-B provider →
  COMPLETED, ACCEPTED + receipt; provider replays failed plan →
  2× REJECTED_DUPLICATE, 1 revision, ABORTED.
- B1+B6 executor-pin-insensitive duplicate detection; B2+B4 no freeze,
  router still binds evidence; B3+B5 committed digest == revision
  digest across routing + restart.
- C1 crash between PREPARED and commit → restart commits SAME prepared
  candidate, ZERO planner calls; C2 legacy committed revision w/o
  receipt → receipt binds, no second commit; C3 post-commit crash →
  fully converged; C4 crash mid-transaction → rollback, PREPARED +
  old plan intact, resume converges; C5 two PREPARED →
  FAIL_CLOSED_REPLAN_ATTEMPT_STATE; C6 markCommitted contract matrix.
- D1 immutable-facts replay conflict → SLOT_CONFLICT.
- E1 incident loop dead: 2 bounded duplicates → infeasible → ABORTED.

## R1 validation

- R1 20/20; F3 20+17; incident 106; F2 R1–R4 + contract 152;
  F1 140 (incl. rm -rf dist race proofs); phase-d recovery 37.
- Full regression 3165 pass / 2 fail — only the previously reproduced
  environment-only P5 probe tests (DSH/CODEX binaries present on this
  VM; identical failure on base 350d48d).
- `rm -rf dist` + `pnpm build` PASS; `npx tsc --noEmit` 0 errors;
  `pnpm audit --audit-level=high` clean.
- I2 regression found and fixed during validation: receipt-binding
  digest search could match the superseded plan's own revision
  (legitimate semantic-restore shares the failed digest) — excluded
  superseded plan_id; incident suite green.

**Classification:**
`PAIR_NEXT_PHASE_F3_PLANNER_RECOVERY_ARTIFACT_DATAFLOW_CLOSURE_R1_PENDING_SOURCE_REVIEW`
