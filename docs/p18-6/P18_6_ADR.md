# P18.6 ADR — Semantic-First Goal Understanding

- **Base:** `cabd25d` (post-#155 main, includes P18.5)
- **Branch:** `feat/p186-semantic-first-goal-understanding`
- **Status:** accepted-for-implementation

## Decision

Extend the **existing advisory context pattern** (Semantic V1's
`PlanningContextEnvelope` → bounded render block → both planner
transports → evidence persistence) with a **model-produced
`GoalIntentAnalysis`** — a versioned, provenance-classified
interpretation of the operator goal — produced by **one bounded,
policy-admitted provider call per planning invocation**, cached on
(goal digest × context digest × schema × model), rendered as a
strictly-labeled ADVISORY prompt block, and persisted as evidence.

## Why this shape

The repository already proves the pattern end-to-end:

- `buildPlannerUserPrompt` (one seam, both transports) takes a
  pre-rendered `planningContextBlock` — interpretation rides the same
  seam, no transport fork.
- `ReplanGenerationService.requestCandidate` pins the advisory
  snapshot on the durable `replan_generation` row — interpretation
  pins identically (digest + bounded block) → async generations are
  resumable and drift-resistant.
- Envelope provenance classes (CANONICAL/PROVEN/PROJECTED/UNVERIFIED)
  extend to intent authority classes (EXPLICIT_OPERATOR /
  VERIFIED_CONTEXT / MODEL_INFERRED / PROPOSED_AMENDMENT /
  OWNER_APPROVED / UNRESOLVED) — same reader model.

## Authority boundary (non-negotiable)

| Layer | Role |
|---|---|
| `extractGoalContract` + `assertPlanCoverage` (+P18.5 F10 ceilings) | Canonical requirement authority — UNCHANGED |
| `operatorGoalOf` provenance binding | Sole authority source for requirements |
| `GoalIntentAnalysis` | Advisory interpretation ONLY — never mints requirements, capabilities, budgets, deadlines, permissions |
| `reconcileIntent` | Deterministic classifier: contradictions with explicit rows → typed conflicts; never mutates the contract |
| Owner-approved amendment | New canonical goal REVISION (append-only) minted only by an authenticated approval event bound to proposal digest + revision |

## Mode contract

`PAIR_SEMANTIC_MODE` ∈ `off` (default — zero provider calls, P18.5
behavior identical), `shadow` (interpret + persist + compare, never
changes plan validity), `guarded` (interpret informs planning;
material unresolved ambiguity blocks confirm fail-closed).

## Hard bounds

- ≤1 semantic provider request per planning invocation (pool-owned
  accounting, same as planner attempts; a governed REASK does not
  re-interpret — the interpretation is pinned per goal revision).
- Interpretation unavailable/malformed → typed `unavailable`, never
  fabricated; SHADOW/GUARDED degrade to no-semantic-block, never a
  fake analysis.
- Response strictly schema-validated; rendered block hard-bounded
  (same 4096 class as planning context); no secrets persisted.
- Tenancy: interpretation is scoped to (business, objective, work
  item) exactly like `PlanningContextEnvelope.scope`; cache keys carry
  the scope digest — no cross-tenant reuse.
