# P18.6 — Planner / Replan Integration & Provider-Cost Report

## Single seam, no second authority

`scripts/serve-mission-control.mjs` — `semanticAnalyzeForRun` is
called inside `planExpander` AFTER `admitPlannerInvocation` (cost
reserved) and BEFORE `invokePlannerPool`, and inside
`runReplanPoolGeneration` as the fallback when the generation row
carries no pinned snapshot.

```
operator input → operatorGoalOf → planningEnvelope → beginPlannerRun
  → admission (est += 1 semantic request bound when mode != off)
  → semanticAnalyzeForRun (≤1 codex-cli request, deadline-bounded)
  → pinPlannerRunGoalIntent (evidence + provider_requests)
  → invokePlannerPool (semanticIntentBlock only when GUARDED)
  → canonicalize + validatePlanProposal + coverage → preview
```

## Provider accounting

- ONE bounded `codexSemanticAnalyze` spawn per planning invocation —
  same executable, model pin (`candidates[0].model`), scratch sandbox
  (`codexPlannerScratch`), permission profile and provider counter as
  `codexPlannerPlan`.
- `provider_requests` from the semantic call folds into
  `planner_run.provider_requests` via `pinPlannerRunGoalIntent` — the
  cost settlement seam (`CALLS_MADE`/`NO_CALLS`) accounts it exactly
  like a plan-transport request.
- Admission envelope adds `+1 × per_request_microusd` of the first
  candidate whenever `semanticMode() !== "off" && candidates.length`.
- The call is bounded by `min(codexPlannerTimeoutMs, deadlineAt - now)`
  — it can never outlive the run deadline.
- Cache hit (`analyzeGoal` LRU on `analysis_digest`) → ZERO provider
  requests; `from_cache: true` evidence.
- Incremental cost vs P18.5: **+0 requests in OFF** (default);
  ≤1 request per planning invocation in SHADOW/GUARDED (deduplicated
  across replans via snapshot pinning and across repeat previews via
  cache). No tokens recorded — codex-cli subscription lane, accounted
  by request count like every other planner call.

## Transport parity

`semanticIntentBlock` threads through the SAME
`buildPlannerUserPrompt` both transports use (llm-planner HTTP lane
+ `buildCodexPlannerPrompt` codex lane) — rendered immediately before
`MISSION GOAL`, after `planningContextBlock`. Prompt-drift between
transports is a contract violation by construction.

## Replan pinning

`ReplanGenerationService.requestCandidate` pins
`goal_intent {analysis_digest, block, ambiguity_class,
source_goal_sha}` from the newest analyzed `planner_run` for the
SAME goal sha (`latestGoalIntentSnapshot`) — a replan replays the
authorized goal revision's interpretation, never silently
reinterprets a failed mission. No pinned snapshot → ONE bounded
fresh analysis at generation time (same seam, same accounting).

## Failure semantics

- Provider unavailable/malformed → typed `unavailable` evidence pinned
  (`status:"unavailable"`, reason bounded) — planning continues
  context-free, GUARDED confirm of that evidence fails closed.
- `semanticAnalyzeForRun` throws → caught at both seams → `null`
  (advisory seam never blocks planning; the run row records whatever
  was pinned before the throw).
- OFF mode: `semanticAnalyzeForRun` returns before any provider
  interaction — no call, no evidence, prompt/digests byte-identical
  to P18.5.

## Data lifecycle

- `planner_run.goal_intent` — full bounded snapshot incl. `analysis`.
- `replan_generation.goal_intent` — 4-field snapshot (digest, block,
  class, goal sha).
- `goal_intent_approval` — append-only amendment rows + event.
- Preview read model — `goal_interpretation` advisory projection
  (≤24 bounded items).
- No secrets, no unbounded model output: schema-validated items
  (≤24×200 chars), bounded block (≤4096), bounded reasons.
