# P18.6 — Governance / Authority Boundary & Ambiguity Policy

## The one rule

**AI may interpret intent; AI interpretation is never authority.**

`extractGoalContract` + `assertPlanCoverage` (+P18.5 F10 numeric
ceilings) remain the sole requirement authority. `operatorGoalOf` is
the only text that mints requirements. A `GoalIntentAnalysis` can
inform decomposition, priorities and approach selection inside the
advisory prompt block — it can never add, remove, weaken, or satisfy
a canonical requirement, mint a capability/network/delivery/spend
permission, or substitute for coverage evidence.

## Authority classes

| Class | Meaning | Path to authority |
|---|---|---|
| EXPLICIT_OPERATOR | Item corroborated by an explicit contract row (≥60% bounded token overlap) | The contract row — the item merely reports it |
| VERIFIED_CONTEXT | Proven project fact | Context evidence only |
| MODEL_INFERRED | Model-inferred intent/preference | Advisory forever |
| PROPOSED_AMENDMENT | Authority-shaped requirement the contract lacks | Not authoritative; amendable only via owner approval |
| OWNER_APPROVED | Operator explicitly approved | Enters canonical input ONLY as a new governed goal revision |
| UNRESOLVED | Missing/ambiguous/contradictory | Can never become authority silently |

## Deterministic reconciliation

`reconcileIntent(items, goal)` runs `extractGoalContract` on the SAME
goal and classifies each item:

- ≥60% of an item's content tokens inside one contract row →
  EXPLICIT_OPERATOR (advisory corroboration), with a negation-scope
  inversion check — `conflicts[]` entries when the item wraps the row
  in negation the row lacks.
- Authority-shaped requirement (send/post/access/spend/network/
  telegram markers) with no corroborating row → PROPOSED_AMENDMENT.
- `conflict`-category items → UNRESOLVED + a conflicts entry
  (`contract_id: "self"` — model-flagged contradiction).
- Everything else → MODEL_INFERRED.

The contract always wins; reconciliation reports, never edits.

## Ambiguity classes

- **HARMLESS** — no unresolved/conflict items; conservative advisory
  assumption allowed.
- **MATERIAL** — genuinely-flagged ambiguity/conflict items or
  high-confidence missing information exist; recorded; in GUARDED mode
  confirm fails closed until an owner amendment resolves it.
- **AUTHORITY_CRITICAL** — a reconciliation conflict exists
  (inversion or model-flagged contradiction); always fail closed in
  GUARDED — an item approval cannot resolve a contradiction; the
  remedy is a revised goal revision.
- Low/medium-confidence `missing_information` alone is HARMLESS —
  a conservative advisory assumption is recorded, never a confirm
  block.

## Owner-approved amendments (the ONLY promotion path)

`POST /api/goal-intent/approve {preview_id, item_ids}` →
`approveGoalIntentItems`:

1. Resolves the preview's persisted `mission_input.operator_goal`
   (server-side — never client text) and the run's pinned analysis.
2. Proves `sha(base_goal) == analysis.operator_goal_sha256`.
3. Requires each item to exist in the pinned analysis with an
   approvable class (MODEL_INFERRED | PROPOSED_AMENDMENT | UNRESOLVED).
4. Mints `goal_intent_approval` (idempotent on
   `{preview_id, analysis_digest, item_ids}`) + `GOAL_INTENT_AMENDMENT_APPROVED` event.
5. `amended_goal = original + "\nOperator-approved: <statement>"` —
   the ORIGINAL text is preserved verbatim; a new revision is created,
   never a mutation.

`POST /api/missions/preview {goal_intent_approval_id}` →
`resolveGoalIntentApprovalBody` injects the persisted amended goal as
`operator_goal` (server-side — `rejectCallerOperatorGoal` still
blocks caller-supplied text), binds `{approval_id, revision_digest,
analysis_digest}` into `mission_input.metadata.goal_intent_approval`,
re-plans + re-digests (new `effective_input_digest`/`plan_digest`
naturally invalidate stale previews).

At CONFIRM: `verifyGoalIntentApproval` re-proves row existence,
persisted-goal sha, revision digest, scope binding
(`approval.scope.project_id === mi.project_id`, strict), operator
binding (non-null `approval.operator_id` must match), and that the
approval's recorded `planner_run_id` resolves to a run whose pinned
`analysis.analysis_digest === approval.analysis_digest` — forged or
replayed approval metadata fails closed at BOTH the preview seam and
the confirm seam.

`assertGuardedIntentConfirmed` then applies the GUARDED gate against
the confirmed preview's OWN pinned interpretation:

- `status ≠ analyzed` → fail closed (unavailable).
- `AUTHORITY_CRITICAL` → always fail closed (contradictions need a
  revised goal, not item approval).
- `MATERIAL` → a **verified amendment on this preview's revision is
  the review act the policy requires** (`approved`); absent one, fail
  closed.

## Replay/injection boundaries

- `analysis_digest` binds goal sha × context × model × scope — a
  modified proposal can't reuse old approval evidence.
- The `goal_intent_approval_id` path is the only way amended
  authority enters `operator_goal`; `rejectCallerOperatorGoal`
  unchanged for everything else.
- Scope binding: approval `scope.project_id` must match the new
  preview's project when both are known; `operator_id` recorded on
  the approval must match the caller when both are known.
- Advisory evidence is deliberately EXCLUDED from
  `effective_input_digest`/`plan_digest` (same axis as
  `planning_context`) — interpretation drift cannot invalidate or
  substitute authority.

## Modes

| Mode | Provider call | Prompt block | Evidence | Confirm gate |
|---|---|---|---|---|
| `off` (default) | none | none | none | none — byte-identical P18.5 |
| `shadow` | 1/invocation | none | pinned | none — evidence-only |
| `guarded` | 1/invocation | advisory block | pinned | MATERIAL/AUTHORITY_CRITICAL/unavailable → fail closed absent verified amendment |

Invalid `PAIR_SEMANTIC_MODE` → `FAIL_CLOSED_SEMANTIC_MODE` (env
validation, same discipline as every PAIR knob).
