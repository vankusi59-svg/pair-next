# P18.6 — Independent Audit Report

Reviewer: independent audit agent (not the implementation agent).
Scope: `cabd25d..HEAD` diff + P18.6 working tree — semantic engine,
planner/replan integration, governance gates, server/UI seams.
Method: static review + live reproduction probes + focused tests.

## Verdict history

| Pass | Verdict | Result |
|---|---|---|
| Audit 1 | FIX-THEN-SHIP | 2 HIGH, 4 MEDIUM, 4 LOW, 5 INFORMATIONAL |
| Remediation | — | all HIGH/MEDIUM resolved; LOW folded; tests added |

## Findings and dispositions

### HIGH-1 — `approved` flag structurally unreachable (dead remedy) — FIXED
The confirm gate compared `approval.analysis_digest` (bound to the
*base* goal's analysis) against the confirmed run's `analysis_digest`
(computed on the *amended* goal) — never equal → the owner-approved
amendment path was dead code. Live probe reproduced: valid approval +
MATERIAL run-2 → confirm still threw.

**Fix:** `assertGuardedIntentConfirmed(run, approved)` now takes
`approved = verified != null` — a `verifyGoalIntentApproval`-proven
amendment IS the review act MATERIAL ambiguity requires.
AUTHORITY_CRITICAL (a live contradiction in the confirmed revision)
still always fails closed — item approval cannot resolve a
contradiction; the remedy is a revised goal.
**Regression test:** "approve → amended preview → confirm" E2E in
`pair-semantic-goal-understanding.test.ts` (the exact probe that
would have caught this).

### HIGH-2 — `classifyAmbiguity` dead material filter — FIXED
`material.length ? MATERIAL : unresolved.length ? MATERIAL` collapsed
every UNRESOLVED item to MATERIAL — GUARDED would have blocked nearly
every real-world goal. **Fix:** ambiguity/conflict categories and
high-confidence missing_information → MATERIAL; low/medium
missing_information → HARMLESS (conservative advisory assumption,
recorded). Benchmark scenarios unaffected (all MATERIAL expectations
use high-confidence items); 61/61 still green.

### MED-3 — approval scope/operator binding decorative — FIXED
`verifyGoalIntentApproval` now re-proves `approval.scope.project_id ===
mi.project_id` (strict, null binds null only) and
`approval.operator_id === mi.operator_id` (non-null binding must match).
`resolveGoalIntentApprovalBody` tightened identically (strict project
equality; non-null operator binding must match). A manual-replay probe
(reconstructed amended goal + stolen approval id under another
project/operator) now fails closed at BOTH seams.

### MED-4 — replan admission est omitted the semantic request — FIXED
`admitPlannerInvocation` in the replan path now adds the same
`+ per_request_microusd` term, gated on `genGoalIntent == null &&
mode !== "off"` — symmetric with the initial-plan edge.

### MED-5 — replan snapshot cross-scope reuse + falsified context — FIXED
`latestGoalIntentSnapshot(store, goal, scope)` skips snapshots whose
pinned analysis carries a different non-null `project_id` — identical
goal text under another project never replays. The pinned run now
records the snapshot's OWN `context_digest` (copied from the source
run's pin — never the replan request's context, which the analysis
never saw) plus `source_mode` provenance. Generation re-proves
`gen.goal_intent.source_goal_sha === sha(authorityGoal)` — a stale-goal
snapshot is treated as absent → fresh bounded analysis.

### MED-6 — pinned snapshot lost items (`analysis: null`) — FIXED
`replan_generation.goal_intent` now carries the full bounded
`analysis` — replan-path previews keep item-level projection and the
`approveGoalIntentItems` amendment surface.

### LOW-7 — mode stamped from live env onto pinned evidence — FIXED
Snapshot carries `source_mode` (provenance); gating continues to
follow live policy-at-action (`mode`), both recorded.

### LOW-8 — doc claimed startup validation — FIXED
Comment corrected: fail-closed at first governed use.

### LOW-9 — `beginPlannerRun` bypassed the pin clamps — FIXED
Shared `clampGoalIntentEvidence` now bounds both write paths.

### LOW-10 — OFF-mode replan pinned evidence — FIXED
`genGoalIntent` is null when `semanticMode() === "off"` — OFF emits no
interpretation evidence anywhere (strict spec parity with P18.5).

### INFORMATIONAL-11..15
- Item sort now numeric-aware (`i2 < i10`).
- `ref.analysis_digest` verified when present (was dead field).
- Approve/amend flow now surfaced in `MissionNew.tsx`: approvable
  items are selectable → `POST /goal-intent/approve` → re-preview via
  `goal_intent_approval_id` (the governed amended-revision seam).
- NEGATION regex covers EN+VI; advisory-only by design.
- Reservation-leak probe: verified safe (throws settle the run).

### NEW BUG FOUND BY REMEDIATION TEST — `pinPlannerRunGoalIntent` version conflict — FIXED
`store.put(..., 0)` hardcoded expected version 0 against a row at
version ≥1 → the pin would **always** throw `FAIL_CLOSED_VERSION_CONFLICT`
(silently swallowed by the serve seam → evidence never pinned, semantic
provider requests uncounted). Fixed to `Number(run.version ?? 0)` CAS —
the audit's recommended pin-clamp test caught it. Under default OFF
mode this path was never exercised — latent since the pin seam landed.

## What held under audit

- Every model item forced `MODEL_INFERRED` at validation — the model
  can never self-mint authority.
- Contract remains sole authority: EXPLICIT_OPERATOR is corroboration
  only; `conflict`-category → deterministic `contract_id:"self"`
  conflicts → AUTHORITY_CRITICAL.
- Approval minting forged-proof at sha level: server-resolved base
  goal, digest-bound items/revision/analysis, idempotent, store-minted.
- Bounds discipline: ≤24 items, ≤200-char spans, 4096-char block cap,
  LRU-128 scoped cache, deadline-bounded provider call.
- OFF mode: zero provider call, zero evidence, byte-identical prompts.
- Transport parity via the single `buildPlannerUserPrompt` seam.
- `provider_requests` folds into run accounting; admission est bounds
  the semantic request on both plan and replan edges.

## Post-remediation test state

`pair-semantic-goal-understanding.test.ts`: 30/30 (incl. the
approve→amend→confirm E2E and AUTHORITY_CRITICAL-still-closed
negative). Required suites: 303/303 green (benchmark 61/61, adversarial
60, coverage, contract, context, replan). `tsc --noEmit` clean.

## Environment-drift findings (not diff-caused, proven at BASE)

- `pair-p5#22` (`GEMINI_API_KEY` literal): failed identically at BASE
  `cabd25d` (BASE worktree run) — host DSH provider config drifted
  gemini→agnes, so `credential_env` resolves `AGNES_API_KEY`.
  **Remediated in-diff**: the assertion now derives the expected name
  from the adapter's own `probe().credential_env` — the invariant
  (env NAMES may appear, VALUES never) is unchanged and
  provider-agnostic.
- `pair-p0 C3` (real codex-cli red control): flaky under full-suite
  load — passes standalone on BOTH BASE and branch (13.2 s / 11.8 s);
  different real-CLI tests failed across runs (C1, C3). Host CLI
  timing variance, not a diff regression.
