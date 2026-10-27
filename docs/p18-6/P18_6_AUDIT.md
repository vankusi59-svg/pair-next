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

## FINAL governance closure (second audit round, HEAD `773da14`)

Three findings were reported against the post-remediation HEAD and
closed with executable adversarial probes at the REAL
`MissionControl.confirmPlanPreview` seam
(`pair-semantic-goal-understanding.test.ts`, `P18.6-FINAL F1/F2/F3`).

### F1 — GUARDED missing-evidence bypass (HIGH) — CLOSED

Original hole: an analysis or `pinPlannerRunGoalIntent` exception was
swallowed to `goalIntentPinned = null`, leaving `planner_run.goal_intent
= null`; the gate early-returned on absent evidence → confirm passed.
Fix: `planner_run.semantic_mode` is bound durably at `beginPlannerRun`
(mjs stamps `semanticMode()` at BOTH the initial-plan and replan
edges). `assertGuardedIntentConfirmed(run, resolution)` now requires a
`guarded`-stamped run to carry non-null, mode-matching pinned
evidence — missing/mismatched → `FAIL_CLOSED_GOAL_INTENT_EVIDENCE`;
unavailable → `FAIL_CLOSED_GOAL_INTENT_UNAVAILABLE`; MATERIAL-class
evidence without enumerable material items → malformed → fail closed.
Legacy runs (no stamp — genuinely pre-stamp provenance) keep
evidence-driven gating, so OFF/SHADOW/historical previews confirm
unchanged; a non-guarded run carrying guarded-stamped evidence still
gates (fail-safe direction).

### F2 — approval resolved ambiguity it never reviewed (HIGH) — CLOSED

Original hole: any verified approval flipped a boolean satisfying the
gate wholesale — ambiguity introduced in the amended revision but
never reviewed passed. Fix: the gate requires the verified approval's
`item_statements` as `resolution.approved_statements`; every
material-driving `UNRESOLVED` item in the confirmed revision's pinned
analysis (same discriminator as `classifyAmbiguity`) must be covered by
an approved statement via the deterministic ≥60% content-token overlap
used by `reconcileIntent`. Uncovered items →
`FAIL_CLOSED_GOAL_INTENT_AMBIGUITY` listing item ids. Item ids are
positional per-analysis, so statements are the only stable
cross-revision binding; `verifyGoalIntentApproval` continues to bind
goal-sha + scope + operator + revision digest, so an unrelated
approval cannot even reach the coverage check.

### F3 — cross-scope replan snapshot reuse (HIGH/MEDIUM) — CLOSED

Original hole: `latestGoalIntentSnapshot` filtered only on
`project_id` when provided — a snapshot scoped {B1,OBJ1,WI1,P1}
matched a request for {…,WI2,P1} or a bare {P1}. Fix: strict
dimension-for-dimension equality across ALL FOUR lineage dims
(business/objective/work_item/project; `""`-normalized), so an
unknown/missing snapshot dimension can never silently satisfy a
more-specific request and scoped evidence never leaks into unscoped
reuse. mjs resolves the mission's canonical lineage
(`bound_open_id → work_open_binding → work_item.{objective,business}`)
once — `replanIntentScope` — used at the request-time lookup AND
re-verified at generation time (`genIntentScopeOk`); mismatch forces
an authorized fresh analysis, never a silent replay. Fresh replan
analyses stamp the same resolved lineage so future replans can bind.

### Closure verification

- 36/36 `pair-semantic-goal-understanding.test.ts` green incl. all
  F1/F2/F3 adversarial probes (missing-evidence guarded run,
  unavailable-status injection, covered-vs-uncovered approval E2E,
  full-lineage/foreign/under-specified snapshot cases).
- 123/123 replan-generation + adversarial + f3-closure; benchmark
  61/61 seeded lane unchanged (real-model lane: 6/8, honest
  UNAVAILABLE on 2 provider timeouts — reported separately from the
  seeded pipeline-integrity result per the benchmark doc's caveat).

### Closure audit verdict: SHIP (independent reviewer)

All three findings CLOSED at the real seam; probes verified as genuine
reproductions of the original bypasses. Three LOW residuals were
folded in the same commit:

- L-1 (`verifyGoalIntentApproval`): `item_statements` are now
  RE-DERIVED from the pinned analysis items — a tampered approval-row
  statement field fails closed instead of smuggling coverage.
- L-2 (gate class consistency): a HARMLESS stamp carrying
  material-driving items, a stamp disagreeing with the analysis's own
  class, or an unrecognized class → `FAIL_CLOSED_GOAL_INTENT_EVIDENCE`.
- L-3 (run-less preview): a preview with no `planner_run` provenance
  under a live guarded process fails closed — provenance-less
  confirmations are impossible under GUARDED; OFF/SHADOW/historical
  unaffected.

INFO notes documented, not defects: `source_goal_sha` binding is
implicit via the server-side run→preview linkage; pre-upgrade guarded
runs lacking the stamp keep evidence-driven gating (bounded upgrade
window); approval re-proof binds `project_id` (goal-sha binding makes
cross-dim replay impossible); `genIntentScopeOk` in the mjs script is
untested-by-construction (mirrors the tested
`latestGoalIntentSnapshot` normalization verbatim).

---

## Round 3 — F2 identity-binding hardening (final semantic approval identity closure)

### Finding

`statementCoveredBy()` accepted >=60% token overlap as proof a MATERIAL
ambiguity was reviewed. Insufficient when the affected entity, scope,
quantity, currency, audience or requirement changed: an approval for
"telegram subscriber target" covered "email subscriber target";
Telegram-budget covered YouTube-budget; differing quantities and
cross-project generic wording passed confirm unreviewed.

### Reproduction (red probes, pre-remediation)

- `approved=telegram` + revision carrying `email subscriber target
  unclear` -> confirm PASSED (false equivalence).
- Telegram-budget approval covered YouTube-budget ambiguity.
- Same wording, different quantity (5000 vs 50000) -> PASSED.
- Same generic wording, different project scope -> PASSED.

### Remediation

1. `issueKeyFor(item)`: structured identity = category +
   discriminating-token set; generic issue-shape vocabulary filtered
   (EN+VI). Coverage = identical category + identical issue_key — no
   threshold. Swaps of entity/channel/quantity/project are never the
   reviewed issue.
2. `resolutions[]` on `goal_intent_approval`: per-item decision
   `accepted_assumption` vs `supplied_value` (bounded operator text);
   `supplied` for a non-approved item id or empty text fails closed.
   Decisions fold into `revision_digest` — changed decision text is a
   different amendment.
3. `approveGoalIntentItems` authority: preview must be READY
   (`FAIL_CLOSED_PREVIEW_STATE`), operator non-null
   (`FAIL_CLOSED_OPERATOR_ID_REQUIRED`), and must own the preview's
   operator binding (`FAIL_CLOSED_GOAL_INTENT_OPERATOR`).
4. `verifyGoalIntentApproval` re-derives `item_statements` AND
   `approved_issues` from the pinned analysis — tampered row fields
   fail closed.
5. Gate signature: `assertGuardedIntentConfirmed(run, { approved_issues })`.

### Closure verification

- 42/42 `pair-semantic-goal-understanding.test.ts` green incl. the new
  identity probes (entity/channel/quantity/project swaps, decision-kind
  distinction) and an HTTP-level endpoint probe (READY-lifecycle +
  operator-bound approval over the real server seam).
- Genuine approve->amend->re-preview->confirm E2E preserved — generic
  rephrasing of the same issue still covers.
- `npx tsc --noEmit` clean.

### Round-3 audit residuals — all RE-FIXED (independent re-audit: SHIP)

- **MEDIUM — sub-3-char token blindness:** `issueKeyFor` now uses a
  dedicated `issueTokens()` (len>=2 + single-char numerics) instead of
  the reconciliation-tuned `tokens()` — `v2`/`v3`, `us`/`eu`, `50`/`90`,
  `phase ii`/`iv`, `5`/`9` swaps all produce distinct keys.
- **LOW — wh-dimension filter:** what/which/who/how/when/where/why +
  VN equivalents stay discriminating — "when to deploy" != "where to
  deploy".
- **LOW — empty discriminating set:** falls back to the normalized
  statement — content-free statements never cross-cover; identical
  statements still cover.
- **LOW — resolutions[] asymmetry:** verify re-derives statement +
  issue_key AND requires bijective item_ids plus the exact amended-goal
  line per decision (`Operator-approved:`/`Operator-supplied: <text>`);
  flips and forgeries fail closed.
- **LOW — READY ordering:** lifecycle is a mint precondition AFTER the
  idempotent lookup — response-lost retry returns the minted row; new
  mint on a consumed preview fails closed. Operator-ownership still
  precedes the lookup (no authz regression).

Upgrade note: approvals minted between the tokenizer change and this
fix hold stale issue_keys and fail closed at verify — re-approval
required (pre-merge only; no production exposure).

---

## Round 4 — exact approval identity (canonical statement)

### Finding

The discriminating-token-SET identity still lost provable identity
information: sorting discarded word ORDER and direction, generic-vocab
filtering discarded NEGATION markers, and length floors discarded
single-letter identifiers. Opposite or permuted statements produced
identical issue keys and reused approval without owner review.

### Reproduction (red probes, pre-remediation @48ceba6)

- `"no send to alice allowed unclear"` ≡ `"send to alice allowed
  unclear"` — 'no' generic-filtered → SAME KEY (negation flip).
- `"alice notifies bob unclear"` ≡ `"bob notifies alice unclear"` —
  sorted set → SAME KEY (direction flip).
- `"tier a limit unclear"` ≡ `"tier b limit unclear"` — len-1 letter
  dropped → SAME KEY.
- `"migrate mysql to postgres"` ≡ `"migrate postgres to mysql"` —
  permutation → SAME KEY.

### Remediation

`issueKeyFor = category + "|" + canonicalIssueStatement(statement)` —
a deterministic, order-preserving normalization: NFC → lowercase →
đ→d → NFD strip combining marks (accented/unaccented VN collapse) →
punctuation→space → whitespace collapse → ≤640. Negation, direction,
entity, quantity, unit, relationship and scope words preserved
verbatim; no generic-vocab filter, no set/dedup, no length floor.
Coverage requires byte-identical canonical statements — paraphrase
similarity is never approval evidence; unprovable identity → explicit
owner review. Canonical surface variants (case, punctuation, spacing,
diacritic spelling) of the SAME statement still reuse approval;
idempotent retries unchanged.

### Closure verification

- 51/51 `pair-semantic-goal-understanding.test.ts` green incl. the
  `P18.6-IDENTITY-R4` block (negation/order/single-letter/direction
  collisions now distinct; canonical-surface controls still collapse;
  paraphrase control asserts NON-collapse).
- Real approve→amend→re-preview→confirm E2E green — the confirm seam
  passes only on canonical-identical coverage.
- `npx tsc --noEmit` clean; adjacent suites 130/130.

Upgrade note: rows minted before this change carry token-set
issue_keys; verify re-derives with the current function, so pre-R4
approvals fail closed and need re-approval (pre-merge only).
