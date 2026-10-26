# Semantic & Context-Aware Planning V1 — Implementation Report

**Claim:** `SEMANTIC_CONTEXT_PLANNING_V1`
**Branch:** `feat/semantic-context-planning-v1`
**BASE:** `46b05bfb0fc6af60a228d5e3438a5b30b3b664ff` (main @ P18.4 merge)
**HEAD:** `b2e85b54ce80fdf6b1b8cbfd3a95512b8ce5c44b`
**Plan:** `docs/plans/2026-10-26-semantic-context-planning-v1.md` (+ architecture map)
**Verification verdict:** `READY_FOR_INDEPENDENT_AUDIT`
**Risk class:** HIGH (authority-adjacent surfaces touched; every authority claim re-proven by deterministic seams)

---

## 1. What this change is

The Planner gains semantic and context awareness **without gaining authority**:

- A **PlanningContextEnvelope** — advisory, provenance-bound, bounded — is rendered
  into the canonical planner prompt at the two async planner seams only.
- **Deterministic EN/VI interpretation** was extended: outcome verbs, grouped
  quantities, relative deadlines, `without`-prohibitions.
- **Coverage matching** distinguishes preparation from outcome fulfillment and
  enforces quantity floors with grouped numbers.
- **Coverage + context evidence is persisted** (planner_run digest/block,
  per-attempt PlanCoverageReport, preview projection, read-only UI).

Nothing in this diff lets model prose mint authority. `assertPlanCoverage`,
`extractGoalContract`, `makeServeCanonicalizer`, dataflow reconciliation,
capability checks, and `validatePlanProposal` remain the sole deterministic
authority path; preview/confirm still pins and replays the canonical plan.

## 2. Commits (BASE..HEAD)

| Commit | Content |
|---|---|
| `cee5b23` | Plan + architecture map + patch claim |
| `3f5ac2d` | B′+F′+E′ — `PlanningContextEnvelope`, two-seam wiring, prompt block |
| `100969d` | C′+D′ — EN/VI outcome extraction, grouped quantities, `without`, relative deadlines, outcome-vs-preparation coverage |
| `48d433a` | G′ — PlanCoverageReport persistence → preview projection → read-only UI |
| `43a8b49` | H′ — 20 adversarial seam probes |
| `aaa42b2` | I′ — real-model E2E (codex `AUTH_OK`, 5-case governed loop) |
| `b2e85b5` | Patch-claim surface names per harness vocabulary |

## 3. Architecture (as built)

- `src/pair/planning-context.ts` — `PlanningContextEnvelope`: bounded sections
  `CANONICAL | PROVEN | PROJECTED | UNVERIFIED`, volatile-stripped digest,
  rendered block ≤ 4096 chars. Assembly reuses `BrainContextService.contextFor`
  (owner-gated), `ScopedMemoryReader` (tenancy admission), experience `retrieve`
  — no new read path, no model call inside assembly.
- `src/pair/serve-planner.ts` — `makeServeCanonicalizer` accepts an optional
  `coverageSink`; emits a bounded sanitized `PlanCoverageReport` per candidate.
  Canonicalizer stays synchronous; authority still binds to the operator goal.
- `src/pair/replan-generation.ts` — replan mint pins `planning_context_block` +
  `planning_context_digest` on the durable `replan_generation` row.
- `src/pair/llm-planner.ts` / `src/pair/codex-planner.ts` — both transports take
  `planningContextBlock` + `rejectionContext` through the **same canonical prompt
  builder**. Codex strict schema contains no advisory `pair_coverage` /
  `network_requirement` properties; advisory fields are normalized post-transport.
- `src/pair/goal-contract.ts` — outcome/growth verb class (EN: grow, increase,
  attract, gain…; VI: tăng, đạt, thu hút…), grouped quantities (`1,000` / `1.000`),
  relative deadlines (`within N days`, `in N days`, `trong vòng N ngày`),
  `without` prohibition trigger, guarded comma split (digit-grouped commas are
  not clause separators).
- `src/pair/plan-coverage.ts` — outcome obligations require outcome/fulfillment
  task verbs; preparation verbs (research/write/plan/draft/analyze…) cannot
  satisfy an outcome requirement; quantity floors compare magnitudes with
  grouped-number parsing; subject anchors + external subject keys unchanged.
- `src/pair/plan-preview.ts` — `beginPlannerRun` persists
  `planning_context_digest` + bounded `planning_context_block`; attempt
  settlement persists coverage evidence; preview rows copy the winning attempt's
  report; `GET /api/plan-previews/:id` + mission preview response project it.
- `scripts/serve-mission-control.mjs` — `planExpander` and
  `runReplanPoolGeneration` both flow through `invokePlannerPool`; advisory
  context resolution is lazy (post-boot dep graph) and failure-isolated —
  planning proceeds context-free with `null` evidence if assembly throws.
  `coverageSink` is per-attempt scoped.
- `apps/mission-control-ui` — read-only coverage/context evidence on the
  preview surface.

## 4. Verification record

Command (run with a clean ambient env — see §7 note):

```text
npm run verify:change -- --base 46b05bf
```

| Gate | Result |
|---|---|
| Patch claim | PASS |
| Patch claim tests | **14/14 PASS** (+22 KNOWN_BASELINE) |
| Invariant tests | **9/9 PASS** (+3 KNOWN_BASELINE) |
| Affected regression | **48/48 PASS** (+40 KNOWN_BASELINE) |
| TypeScript | **PASS** |
| Build | **PASS** |
| Full suite | **PASS_WITH_KNOWN_BASELINE** (+133) |
| **Verdict** | **READY_FOR_INDEPENDENT_AUDIT** |

Focused suites:

- `pair-semantic-planning-context.test.ts` — 9/9 (envelope digest stability,
  volatility stripping, bounded render, replan pinning, seam wiring)
- `pair-semantic-coverage.test.ts` — 13/13 (EN/VI extraction, grouped
  quantities, relative deadlines, outcome-vs-preparation, subject/quantity
  mismatch, evidence persistence, preview projection)
- `pair-semantic-adversarial.test.ts` — 20/20 (H1–H20 seam probes: scope bleed,
  hint forgery, sync-boundary, snapshot staleness, context-only authority)
- Planner/contract/coverage regression sweep: 244/244 green

## 5. Real-model E2E (`docs/e2e-semantic-v1/REAL_PLANNER_E2E_REPORT.*`)

Codex CLI live qualification probe: **AUTH_OK** (real invocation). Five cases
through the real codex transport → real canonicalizer → real authority path:

| Case | Result |
|---|---|
| E2E-1 EN Telegram growth | FAIL_CLOSED — `PLAN_DATAFLOW_UNBOUND_INPUT` (×2 attempts) |
| E2E-2 VI equivalent | `INITIAL:FAIL_CLOSED → REASK:CANONICAL_PASS` — governed retry demonstrated |
| E2E-3 research + deliverable | `CANONICAL_PASS` first attempt |
| E2E-4 mixed EN/VI + network | FAIL_CLOSED — `PLAN_NETWORK_REQUIREMENT_INVALID:UNAUTHORIZED_SOURCE` |
| E2E-5 prohibition goal | FAIL_CLOSED — dataflow → `PLAN_CONSTRAINT_VIOLATION` (prohibited term) |

Final: `2_PASS_3_FAIL_CLOSED_0_OTHER`. All fail-closed outcomes are **correct
conservative governance** (unbound dataflow, unauthorized network source,
prohibited-term enforcement) — not semantic-matcher failures. Provider request
counts stayed inside the existing envelope: 1 request for first-pass cases,
2 for the re-ask case — zero new invocations added by this diff.

## 6. Boundary record — what did NOT change

- No model call inside `extractGoalContract`, `assertPlanCoverage`,
  `makeServeCanonicalizer`, preview mint, confirm, replay, or commit paths.
- `pair_coverage` hints remain advisory; fabricated/non-claimable declarations
  fail closed; missing hints do not fail a genuinely covering plan.
- Envelope digest is volatile-stripped evidence — never bound into
  `plan_digest` / `effective_input_digest`; confirm cannot fail on context drift.
- Canonical authority still derives from the operator goal; canonicalization
  binds the goal text, not enriched context.
- No new provider invocation class; cost admission + counters unchanged.
- Merge/release remain owner decisions; nothing here deploys or publishes.

## 7. Known baselines & environmental notes

- Full suite reports `+133 KNOWN_BASELINE`. Verified environmental on this
  Windows host: `.cjs` fake-shim spawn → `EFTYPE` (covmap T9/T11); `pair-p5`
  PATH-mask pattern expects lowercase `.local` (Windows paths use
  `AppData\Local`); win32 artifact materialization lacks `/proc/self/fd`.
- **Env-sensitivity note for auditors:** two `pair-p5` tests resolve the ambient
  DSH/AGNES planner env (`PAIR_DSH_MODEL_ROUTE`, `AGNES_API_KEY`, …). With those
  host vars set, p5 shows 2 extra failures that exceed the baseline budget and
  flip the verdict to NOT_READY. The harness was run with those ambient
  `PAIR_*`/`AGNES_*` vars unset — matching the baseline measurement conditions.
  This is a test-harness/host-env interaction, not production behavior.
- E2E-5 residual: term-only prohibition enforcement means a task that names the
  prohibited term even to disclaim it fails closed — conservative by design;
  model-side phrasing avoids the term entirely.

## 8. Residual risks

- VI normalization remains lexeme/table-driven; unseen paraphrases degrade to
  fail-closed REASK (bounded by P18.2 retry budget) rather than wrong coverage.
- Context quality depends on underlying scope services; a thin context degrades
  plan quality but never coverage authority.
- Outcome-vs-preparation classification is verb-class based; a task whose verb
  set mixes both is judged by its fulfillment verbs (preparation verbs alone
  never satisfy an outcome).

## 9. Merge status

**Not merged.** Independent audit (K′) precedes any owner merge decision.
Releases remain unauthorized until the owner acts.
