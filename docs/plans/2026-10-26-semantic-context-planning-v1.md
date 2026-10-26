# Semantic & Context-Aware Planning V1 — Adjusted Implementation Plan

- Date: 2026-10-26
- Repo: `vankusi59-svg/pair-next`
- Baseline: `46b05bfb0fc6af60a228d5e3438a5b30b3b664ff` (post-P18.4 merge, PR #153)
- Source: owner master mission (phases A–L), reviewed by codex-planner against codebase
- Verdict: **SOUND_WITH_ADJUSTMENTS** — executable after the must-fix items below are applied
- Status: PLAN ONLY — implementation not started

---

## 0. Verified architecture ground truth

Anchors confirmed by source inspection on `46b05bf`:

- **Operator-goal authority**: `operatorGoalOf` (`src/pair/goal-contract.ts:98–113`),
  `missionOperatorGoalOf` (`:134–160`), `rejectCallerOperatorGoal` at API edge
  (`mission-control-server.ts:1024,1037,1044`). Only `operator_goal` mints
  contract/network/delivery/language authority.
- **Requirement extraction**: `extractGoalContract` (`goal-contract.ts:752–887`) —
  deterministic, no LLM; VI alternation already in `OBLIGATION_VERB_RE` (`:860`);
  quantity preserved via `extractQuantity` (`:614`); prohibition-first classification.
- **Coverage validator**: `assertPlanCoverage` (`plan-coverage.ts:510`) invoked inside
  the synchronous canonicalizer (`serve-planner.ts:635`), after
  `reconcilePlanDataflow` (`:616`). Matching = verb-class + subject-identity +
  quantity floor. States: `PROVEN | PRESERVED | UNVERIFIABLE | VIOLATED`.
  `pair_coverage` model hints already exist and are advisory-only; fabricated hints
  fail closed (`:471–506`, `:527`). **The report return value is currently discarded
  at `serve-planner.ts:635` — no persistence seam exists.**
- **Sync canonicalizer boundary**: `makeServeCanonicalizer` (`serve-planner.ts:239–272`),
  `RuntimePlanner` (`mission-runtime.ts:257–259`), `createPlanPreview`
  (`mission-control.ts:842`), `runReplan` (`mission-runtime.ts:4242`), persisted-plan
  replay (`serve-planner.ts:803–820`) — all synchronous by contract.
  `serve-planner.ts:27–36` documents that async LLM cannot live inside this contract.
- **Two async model-touching seams (and only two)**:
  `planExpander` (`serve-mission-control.mjs:1183–1335`) and
  `runReplanPoolGeneration` (`:1344–1463`). Every other entry point replays pinned plans.
- **Cost envelope**: `plannerCandidateRequestBound` (`planner-pool.ts:399–405`,
  codex_cli bound = 6), consumed by `admitPlannerInvocation`
  (`serve-mission-control.mjs:1257,1410`), `providerCounter` incremented at the
  provider-touching point (`codex-planner.ts:336`).
- **Digest contract**: `effective_input_digest` binds
  goal+operator_goal+permissions+workspaces+risk+operator+caps
  (`mission-control.ts:858–868`); `plan_digest` binds tasks+authority (`:869–876`);
  `canonicalPlanSemanticDigest` (`plan-feasibility.ts:179–239`) for replan dedup;
  `assertPlanDataflow` re-proved at preview/commit/replan-commit.
- **`metadata.llm_plan`**: pinned at all entry points (`serve-mission-control.mjs:1292`),
  replayed through the full canonicalizer — preserved authority, never bypassed.
- **P18.2 adaptive retry**: `PLANNER_VALIDATION_REPAIR_MAX=2`
  (`planner-adaptive-retry.ts:34`); sanitized bounded feedback via `rejectionContext`;
  `PRIOR_REJECTION:` marker (`planner-pool.ts:498`).
- **Context sources (all advisory)**: `BrainContextService` (owner-gated, volatile-stripped
  `context_digest`), `ReasoningBriefService` (provenance classes
  `CANONICAL|PROVEN|PROJECTED|UNVERIFIED`), P17 `ScopedMemoryReader` (tenancy admission,
  bounded), verified experience, planner advisor `adviseSafely`.
- **Vietnamese support (existing)**: VI verbs in contract extraction + coverage verb
  classes, VI subject-phrase map (`llm-planner.ts:310–317`), VI negation scope,
  VI output-language detection, VI network/local-source detectors, VI prohibition vocab.
- **Real-model route**: subscription-only `assertCodexCliPlannerTransport`
  (`serve-planner.ts:196–206`); box has `.codex` home + `gpt-6.1-sol` config matching
  the default route — qualification unproven until live probe.

---

## 1. Must-fix adjustments to the drafted plan

| # | Adjustment | Rationale |
|---|---|---|
| M1 | **Model semantic judgment may only run inside the async pool path** (`planFn`/transports or a new async stage inside `invokePlannerPool`). Never inside `extractGoalContract`, `assertPlanCoverage`, `canonicalizeLlmTasks`, `validatePlanProposal`, `assertPlanDataflow`, `reconcilePlanDataflow`, `RuntimePlanner`, preview, confirm, or the commit transaction. | Those gates are synchronous and inside the RuntimePlanner/commit contract; awaiting a model there breaks the signature, the replan ledger loop, and persisted-plan replay. |
| M2 | **Semantic evidence credibility class: advisory only.** A model "task T covers OBL_n" verdict never mints `PROVEN`. Legal forms: (a) richer model hints that the deterministic verifier still confirms; (b) deterministic normalization extension; (c) semantic judgment as rejection-feedback content for REASK/P18.2. | `pair_coverage` already implements exactly this contract — hints never mint coverage, fabricated hints fail closed. A model verdict flipping `INCOMPLETE→PROVEN` is an authority grant by untrusted output. |
| M3 | **Semantic judgment rides inside the existing planner prompt/response** (structured `semantic_hints`/`pair_coverage`-class fields on the same transport). Zero new provider invocations. If a distinct per-candidate semantic call is ever added, it must bump `plannerCandidateRequestBound`, update both `admitPlannerInvocation` reservation sites, count via `providerCounter`, and carry attempt evidence. | Keeps the worst-case invocation envelope, run deadline, and G4 bounded-invocation clause intact. |
| M4 | **`PlanningContextEnvelope` = advisory evidence, never a gate.** Volatile-stripped `context_digest` (precedent: `brain-context.ts:32–39`); persisted as evidence on `planner_run`/`planner_attempt`/preview metadata/`metadata.planning_context_digest` — never bound into `effective_input_digest`/`plan_digest`. | Binding context into plan digest would make volatile drift (KPI/status changes between preview and confirm) fail-close confirmed plans — contradicts "context is advisory". |
| M5 | **Envelope assembly at the two async seams only**: `planExpander` and `runReplanPoolGeneration`. For replans, mint the envelope snapshot onto the durable `replan_generation` row alongside `replan_context` (bounded like `MAX_CONTEXT_FIELD`). | Re-fetching live context at generation time silently changes what the durable record claims. |
| M6 | **Envelope construction reuses existing gates verbatim**: `BrainContextService.contextFor` (owner-gated), `ScopedMemoryReader` (tenancy admission), experience `retrieve` (scope-strict), existing advisory channels. No new read path, no model call inside assembly. | Single-read-path precedent (`reasoning-brief.ts:28–30`); scope bleed is the realistic failure mode. |
| M7 | **Semantic equivalence stays deterministic or prompt-advisory**: lexeme/paraphrase maps, diacritic folding, subject-anchor extension. `canonicalPlanSemanticDigest`/`delegated_goal_digest` remain the deterministic equivalence authorities. `extractGoalContract` stays non-LLM (`goal-contract.ts:12`). | Equivalence on the envelope would violate provenance — `[AGENT CONTEXT]` notes could mint/deny requirements. |
| M8 | **Phase G needs a persistence seam**: attach `PlanCoverageReport` (bounded) to the winning `planner_attempt`/preview evidence before it's dropped, then project read-only to UI. | Report is currently discarded at `serve-planner.ts:635`. |

## 2. Recommended adjustments

| # | Adjustment |
|---|---|
| R1 | Vietnamese gap → extend deterministic normalization (VI lexemes, diacritic-folded token classes, paraphrase tables, compound-verb handling in `OBLIGATION_VERB_RE`/`VERB_CLASSES`/`VI_SUBJECT_PHRASES`). No model "NLP layer" — misses fail closed into bounded REASK→P18.2 repair, the intended backstop. |
| R2 | Phase A shrinks to a confirmation pass + architecture-map document (map above is already derived). |
| R3 | Phase E is prompt-surface work: render bounded envelope sections into the ONE canonical prompt builder shared by both transports. Drift between transports is a declared contract violation (`codex-planner.ts:107–110`). |
| R4 | Phase H adversarial set must add seam-specific probes: envelope scope bleed (foreign business/objective), envelope-digest instability, semantic-hint forgery (`pair_coverage`-class), sync-boundary attempts, replan snapshot staleness, context-only authority minting. |
| R5 | Phase I gate: codex CLI on PATH + `CODEX_HOME` + live `refreshCodexPlannerQualification` PASS, else typed `BLOCKED_REAL_MODEL` evidence — never faked. |

---

## 3. Revised phase plan

### Stream 1 — Context spine (serialize)

1. **A′ Confirmation audit** (S, low) — verify the architecture map; write architecture note. Blocks nothing technically; cheap.
2. **B′ `PlanningContextEnvelope`** (M, med) — new module `src/pair/planning-context.ts`:
   advisory provenance-bound snapshot; sections classified
   `CANONICAL|PROVEN|PROJECTED|UNVERIFIED`; authoritative-operator-input vs canonical
   business facts vs advisory vs missing/uncertain; volatile-stripped `context_digest`;
   bounded reads. Assembles via existing read paths only (M6).
3. **F′ Integration** (S–M) — wire envelope assembly into `planExpander` +
   `runReplanPoolGeneration`; persist digest on `planner_run`/preview evidence; mint
   replan snapshot on `replan_generation` rows. *Depends on B′.*
4. **E′ Context-aware planning** (M, med) — render bounded envelope sections into the
   canonical prompt builder (single builder, both transports); identical
   sanitize/bounds discipline to existing context fields. *Depends on B′, F′.*

### Stream 2 — Semantic/deterministic upgrade (parallel to Stream 1 after A′)

5. **C′ Typed interpretation + deterministic equivalence** (S–M) — fill real gaps only:
   VI morphology/normalization, paraphrase lexemes, subject-anchor extensions.
   Equivalence stays deterministic or prompt-advisory (M7). *Depends on A′ (confirms gaps).*
6. **D′ Coverage upgrade** (M, med-high — highest correctness sensitivity) —
   deterministic matcher extension + optional model *hints* inside planner output
   (`semantic_hints`/`pair_coverage`-class fields, same transport, zero new
   invocations, M3), still verified by `assertPlanCoverage`. Model verdicts never
   mint `PROVEN` (M2). Explainable rejection content feeds `rejectionContext` into
   P18.2. *Depends on C′.*
7. **G′ Explainability** (M, low) — persist `PlanCoverageReport` + envelope digest on
   attempt/preview evidence (M8); read-only projection + UI card. *Depends on B′, D′.
   Can parallel E′.*

### Stream 3 — Evidence & gate (after Streams 1+2 merge)

8. **H′ 20 adversarial scenarios** (M, med) — original H1–H20 + R4 seam probes.
   *Depends on B′, D′, E′, F′.*
9. **I′ Real-model E2E** (M, conditionally runnable) — 5 cases (Telegram EN goal, VI
   equivalent, EA dev, bilingual correspondence, governed retry). Gate per R5;
   failed probe → `BLOCKED_REAL_MODEL` typed evidence. *Depends on E′.*
10. **J′ Regressions + `npm run verify:change -- --base 46b05bf`** (S–M) —
    AGENTS.md contract: mandatory planning/contract/preview/P16–P18.4 suites,
    tsc, build, full suite vs true baseline. *Depends on all implementation streams.*
11. **K′ Three-scope independent audit** (S) — semantic correctness, canonical
    authority/security, production integration. Post-J′.
12. **L′ Docs + single PR, no auto-merge** (S) — deliverable docs per mission,
    owner-reviewable PR. Post-K′.

**Parallelism:** C′/D′ run while B′/F′ are built (disjoint files:
`goal-contract.ts`/`plan-coverage.ts`/`llm-planner.ts` vs new `planning-context.ts` +
wiring). G′ parallel to E′. Streams merge at H′.

**Minimum viable coherent PR slice** (if scope must shrink): B′ + F′ + E′ + D′
(deterministic-only, no model hints) + focused H′ subset (8–10 scenarios on new
seams) + J′. Deferrable without orphaning: model-semantic-hints (D′ full), UI (G′),
real-model E2E (I′).

---

## 4. Risks & unknowns

1. **Sync-boundary violation (M1)** — the single most important constraint; any model
   call inside the synchronous canonicalizer contract is unexecutable.
2. **Semantic evidence credibility (M2)** — treating a model verdict as authority
   converts a fail-closed gate into fail-open.
3. **Envelope digest instability (M4)** — volatile fields churning `context_digest`
   or accidental binding into plan/effective-input digests fails confirm closed on
   benign drift.
4. **Vietnamese normalization reach limit** — deterministic extension closes the
   bounded gap; productive morphology means misses still occur — the fail-closed
   REASK→P18.2≤2 path is the backstop; H′ must verify matcher blind spots don't burn
   the repair budget.
5. **Real-model qualification unproven on this box** — `.codex` home + matching
   default model exist; `codex` on PATH, `CODEX_HOME` env, live subscription, and
   `PAIR_ASYNC_REPLAN_PROVIDER=1` gating all need a boot probe before scheduling I′.

Secondary unknowns: C-phase "semantic equivalence" scope (goal-dedup vs coverage vs
plan-identity land differently — resolved by M7); whether the envelope feeds replans
only or all entry points (resolved: all, via the two async seams); envelope size
budget relative to existing prompt bounds.

## 5. Acceptance criteria (unchanged from mission)

- Planner consumes relevant, authorized business context via the envelope.
- Operator authority and advisory context strictly separated.
- EN/VI equivalent goal expressions handled within verified scope.
- Valid semantic task correspondence no longer rejected solely by lexical mismatch.
- Token overlap cannot fabricate requirement coverage.
- Quantities, subjects, deadlines, prohibitions, deliverables preserve intended meaning.
- Context-aware DAG compatible with canonical dataflow validation.
- All planning entry points share consistent contracts (two async seams; replays elsewhere).
- P18.2 adaptive retry bounded and correct; P18.4 recovery unaffected.
- Deterministic hard gates intact; `verify:change` returns READY_FOR_INDEPENDENT_AUDIT.
- Real-model E2E evidence present or `BLOCKED_REAL_MODEL` typed classification.
- Independent audit: zero unresolved CRITICAL/HIGH, zero release-blocking MEDIUM.
- One owner-reviewable PR; no auto-merge; no release.
