# P18.6 — GoalIntentAnalysis Schema & Provenance Contract

Schema id: `pair.goal-intent-analysis.v1` (`GOAL_INTENT_SCHEMA`).

## GoalIntentAnalysis

Produced by ONE governed provider request per planning invocation
(`analyzeGoal` in `src/pair/semantic-goal-understanding.ts`), cached on
`digest({schema, operator_goal_sha256, context_digest, model, scope})`.

| Field | Meaning |
|---|---|
| `schema_version` | `pair.goal-intent-analysis.v1` |
| `analysis_digest` | Identity AND cache key — goal × context snapshot × model × scope |
| `operator_goal_sha256` | digest reference to the interpreted text (never the text's authority) |
| `context_digest` | Planning-context snapshot the interpretation saw |
| `scope` | `{business_id, objective_id, work_item_id, project_id}` — tenancy binding |
| `items[]` | ≤24 bounded `IntentItem`s |
| `reconciliation` | Deterministic contract adjudication — never model-computed |
| `ambiguity` | `{class, reasons}` — HARMLESS / MATERIAL / AUTHORITY_CRITICAL |
| `provider` | `{model, requests, latency_ms, unavailable[]}` — accounting evidence |
| `created_at` | UTC timestamp |

## IntentItem

| Field | Bound | Meaning |
|---|---|---|
| `id` | `i1..i24` | Stable interpretation id |
| `category` | enum | primary/secondary outcome, entity, audience, resource, requirement, deliverable, hard_constraint, prohibition, soft_preference, priority, temporal, quantity, dependency, conditional, context_reference, ambiguity, missing_information, conflict |
| `source_span` | ≤200 chars | Verbatim goal substring — evidence |
| `statement` | ≤200 chars | One bounded normalized sentence |
| `authority` | enum — assigned by `reconcileIntent` only | EXPLICIT_OPERATOR / VERIFIED_CONTEXT / MODEL_INFERRED / PROPOSED_AMENDMENT / OWNER_APPROVED / UNRESOLVED |
| `confidence` | low/medium/high | Review evidence — NEVER authorization |
| `alternatives` | ≤4×120 | Alternate readings for ambiguity/conflict items |

## Provenance rules

1. Provider output passes strict validation (`validateIntentItems`) —
   every model-claimed `authority` is discarded; `reconcileIntent`
   assigns the class deterministically. A model can never self-mint.
2. `source_span` is bounded verbatim evidence — an interpretation
   without a supporting span is still only advisory.
3. Malformed/unavailable provider output → typed `unavailable`,
   never a fabricated analysis (`analyzeGoal` returns
   `{unavailable: string[]}`).
4. Cache key binds goal sha × context_digest × model × scope — any
   drift produces a different key; interpretations cannot leak across
   tenants/projects.
5. The rendered advisory block (`renderGoalIntentBlock`) is ≤4096
   chars, carries `analysis_digest`, and states ADVISORY/NOT authority
   in the header.

## Persistence

- `planner_run.goal_intent` — pinned snapshot `{analysis_digest,
  block, ambiguity_class, status, unavailable_reason, model,
  provider_id, provider_requests, analysis_ms, from_cache,
  source_goal_sha, context_digest, mode, analysis}` via
  `pinPlannerRunGoalIntent`; `provider_requests` folds into the run's
  canonical counter so cost settlement accounts the call.
- `replan_generation.goal_intent` — `{analysis_digest, block,
  ambiguity_class, source_goal_sha}` pinned at request time from the
  newest analyzed run for the same goal sha.
- `goal_intent_approval` — the append-only owner-amendment entity
  `{approval_id, preview_id, planner_run_id, analysis_digest,
  item_ids, item_statements, base_goal_sha256, amended_goal,
  amended_goal_sha256, revision_digest, operator_id, scope,
  created_at}`.
- Preview response projects `goal_interpretation` as an advisory read
  model (same discipline as `coverage_report`) — confirm binds
  digests, never this field.
