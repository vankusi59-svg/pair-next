# Planning Architecture Map — Semantic & Context-Aware Planning V1

Confirmation audit (phase A′) on baseline `46b05bf`. Anchors verified by source
inspection; companion to `docs/plans/2026-10-26-semantic-context-planning-v1.md`.

## Authority

- `operatorGoalOf(source)` — `src/pair/goal-contract.ts:98–113`. `operator_goal`
  wins; `goal` is fallback authority-of-record only when no pin exists.
- `missionOperatorGoalOf(store, mission)` — `src/pair/goal-contract.ts:134–160`.
  Bound missions re-derive through `bound_open_id → work_open_binding →
  work_item.goal`; divergence → `FAIL_CLOSED_BOUND_GOAL_PROVENANCE`.
- `rejectCallerOperatorGoal` — `mission-control-server.ts:1024,1037,1044`.
- Delegated missions carry enriched `goal` (`[BUSINESS…|DEPT…|AGENT…]` +
  `[AGENT CONTEXT]` — `business.ts:1576–1604`) plus raw `operator_goal`
  (`business.ts:1629`). Only `operator_goal` mints authority.

## Requirement extraction (deterministic, no LLM)

- `extractGoalContract` — `goal-contract.ts:752–887`.
  - `splitClauses` `:195`; prohibition-first `PROHIBITION_RE` `:347` (outranks
    all, `:794`); produce-verb→filename `FILE_RE` `:396` +
    `isProduceGovernedFile` `:523`; deadline/budget/`only` regexes `:382–391`;
    `OBLIGATION_VERB_RE` `:579` with VI alternation `:860`; filler strip
    `LEADING_FILLER_RE` `:576`; `extractQuantity` `:614`; unclassifiable →
    objective text (never fabricated) `:868–869`; `contractDigest` sha256
    `:882–886`.

## Coverage validation (deterministic — sole PROVEN authority)

- `assertPlanCoverage(contract, tasks)` — `plan-coverage.ts:510`, invoked inside
  canonicalizer `serve-planner.ts:635` after `reconcilePlanDataflow` `:616`.
- Obligation match: `taskCoversObligation` `:188–232`; `VERB_CLASSES` EN+VI
  `:61–76`; subject anchors via `subjectAnchors`/`externalSubjectKeys`
  (`llm-planner.ts`); quantity floor `:227–229`; content-token fallback with VI
  stop-sets `:112–171`.
- Deliverables via `extractTaskDataflow` + `artifactNamesEquivalent` `:241–248`.
- Budget ceilings `:589–607`; `only`-families `:613–642`; uncheckable →
  `PRESERVED` `:647`; prohibitions action-class↔object scoped, negation-windowed
  EN+VI `:263–298`, `:649–687`; deadline → `PRESERVED` `:689–697`.
- Model `pair_coverage` = advisory hint; fabricated → fail closed `:471–506`,
  `:527`; bookkeeping never claims coverage `:533–540`.
- States: `PROVEN | PRESERVED | UNVERIFIABLE | VIOLATED`. Failures:
  `FAIL_CLOSED_PLAN_INCOMPLETE`, `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`.
- **`PlanCoverageReport` currently discarded at `serve-planner.ts:635`** — G′ adds
  a persistence seam.

## Synchronous canonicalizer — hard boundary (no model calls inside)

- `makeServeCanonicalizer` — `serve-planner.ts:239–272` (sync closure).
  Pipeline: sanitize → misuse checks → network authority `:415–526` → key remap
  + bookkeeping inject `:527–590` → delivery omission repair `:591–731` →
  `reconcilePlanDataflow` `:616` → `assertPlanCoverage` `:635`.
- `RuntimePlanner` `(input) => { tasks }` — `mission-runtime.ts:257–259` (sync).
- Callers (all sync): `createPlanPreview` `mission-control.ts:842`; `runReplan`
  `mission-runtime.ts:4242`; persisted `llm_plan` replay `serve-planner.ts:803–820`.
- Rationale documented `serve-planner.ts:27–36`.

## Async model seams (the only two)

- `planExpander` — `serve-mission-control.mjs:1183–1335`: `beginPlannerRun` →
  `admitPlannerInvocation` (worst-case envelope `:1243–1264`) →
  `invokePlannerPool`/`runPlannerFailover` → `metadata.llm_plan` + durable
  `planner_run`/`planner_attempt` evidence.
- `runReplanPoolGeneration` — `serve-mission-control.mjs:1344–1463`, enabled under
  `PAIR_ASYNC_REPLAN_PROVIDER=1` (`:445–449`); `replan_context` snapshot minted on
  durable row (`mission-runtime.ts:4248–4259`; `MAX_CONTEXT_FIELD=512`,
  `MAX_REJECTED_DIGESTS=16` — `replan-generation.ts:66–67`).
- `PlannerInvocation` — `planner-pool.ts:35–60` (`kind: INITIAL|REASK`,
  `deadlineMs`, `maxProviderRequests`, shared `providerCounter`,
  `rejectionContext`).
- `plannerCandidateRequestBound` — `planner-pool.ts:399–405` (codex_cli=6, HTTP=3)
  consumed by cost envelope `serve-mission-control.mjs:1257,1410`;
  `providerCounter++` at `codex-planner.ts:336`.
- `codexPlannerPlan` — `codex-planner.ts:320–407` (async); shared canonical prompt
  builder; `authorityGoal` threading.
- Entry points feeding the seams: `/api/missions/preview`, bare `/api/missions`,
  `MissionDraftService.confirm` (`mission-draft.ts:705–744`), `tickSchedules`
  (`serve-mission-control.mjs:1569`), `prepareDelegatedPlan`/`openWorkItem`
  (`business.ts:1719`). `/api/missions/confirm` is replay-only.

## Digest / pinning contract

- `preview == confirm == commit == execute` — `plan-preview.ts:1–21`.
- `effective_input_digest` — `mission-control.ts:858–868`
  (goal+operator_goal+permissions+workspaces+risk+operator+caps).
- `plan_digest` — `:869–876` (tasks+authority).
- `canonicalPlanSemanticDigest` — `plan-feasibility.ts:179–239`; replan dedup
  `mission-runtime.ts:4304–4308`; `MAX_REPLAN_CANDIDATES_PER_DECISION=2`
  (`plan-feasibility.ts:386`).
- `assertPlanDataflow` re-proved at preview, commit, replan-commit
  (`mission-control.ts:854–857,963–969`; `mission-runtime.ts:1386–1404,4295–4302`).
- `metadata.llm_plan` → `pinned_plan_tasks` (`mission-control.ts:990`) → verbatim
  replay + revalidation (`mission-runtime.ts:1368–1404`).

## P18.2 adaptive retry (existing)

- `planner-adaptive-retry.ts:1–80`; `PLANNER_VALIDATION_REPAIR_MAX=2` `:34`;
  `isValidationRejectedAttempt` `:66–73`; `PRIOR_REJECTION:` marker
  `planner-pool.ts:498`; consumed `business.ts:1699–1717`,
  `serve-mission-control.mjs:1356–1378`.

## Context sources (all advisory)

- `BrainContextService` — `brain-context.ts` (owner-gated, volatile-stripped
  `context_digest`, `:32–39`).
- `ReasoningBriefService` — `reasoning-brief.ts` (provenance
  `CANONICAL|PROVEN|PROJECTED|UNVERIFIED` `:53`).
- P17 `ScopedMemoryReader` (SQL-bounded, tenancy admission) + experience
  `retrieve`; advisor `adviseSafely` (`mission-runtime.ts:1341,4654–4665`).
- Delegated context: `allowed_context_scopes` (`business.ts:1582–1603`),
  `delegated_goal_digest` re-proof.

## Vietnamese (existing deterministic coverage)

- VI verbs `goal-contract.ts:860`; `VERB_CLASSES` `plan-coverage.ts:62–76`;
  VI subject-phrase map `llm-planner.ts:310–317`; VI negation scope
  `plan-coverage.ts:285`; VI output-language `output-language.ts:85–91,167–221`;
  VI network/local detectors `llm-planner.ts:203–224`; VI prohibition vocab.

## Real-model route

- `assertCodexPlannerTransport`/`assertCodexCliPlannerTransport` —
  `serve-planner.ts:196–206`; subscription-only; no HTTP planner.
- Qualification: `refreshCodexPlannerQualification` (wired
  `serve-mission-control.mjs:934,1075`); discovery gate `PAIR_DSH_HOME ||
  CODEX_HOME` at `:777`. This box: `codex` on PATH, `~/.codex` present,
  `CODEX_HOME` env unset → conditionally runnable pending live probe.
