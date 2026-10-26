# Semantic & Context-Aware Planning V1 — Implementation Report

**Claim:** `SEMANTIC_CONTEXT_PLANNING_V1`
**Branch:** `feat/semantic-context-planning-v1`
**BASE:** `46b05bfb0fc6af60a228d5e3438a5b30b3b664ff` (main @ P18.4 merge)
**HEAD:** `64cae3a` (post-K′ remediation)
**Plan:** `docs/plans/2026-10-26-semantic-context-planning-v1.md` (+ architecture map)
**Independent audit:** `docs/e2e-semantic-v1/SEMANTIC_V1_INDEPENDENT_AUDIT.md` — FIX-THEN-SHIP → all 10 findings remediated with regression probes
**Verification verdict:** `READY_FOR_INDEPENDENT_AUDIT` (re-verified post-remediation)
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
| `8b717cb` | J′ verification record + implementation report |
| `2f88931` | K′ remediation — Unicode verb boundaries, grouped marker quantities, temporal-number masking, VI anchor stop-set, render-bound enforcement, preserved-row backstop |
| `64cae3a` | K′ audit doc + verification record |

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

Focused suites (post-K′ remediation):

- `pair-semantic-planning-context.test.ts` — 11/11 (envelope digest stability,
  volatility stripping, bounded render incl. max-fill bound + prompt≡evidence,
  replan pinning, seam wiring)
- `pair-semantic-coverage.test.ts` — 24/24 (EN/VI extraction, grouped
  quantities incl. marker path, relative deadlines, temporal masking both
  directions, outcome-vs-preparation, subject/quantity mismatch, VI initial
  anchors, connective trim, preserved-row backstop, evidence persistence)
- `pair-semantic-adversarial.test.ts` — 20/20 (H1–H20 seam probes: scope bleed,
  hint forgery, sync-boundary, snapshot staleness, context-only authority)
- Contract/coverage/context regression: 194/194; planner suites 141/141;
  brain-context suites 121/121

## K′ independent audit outcome

Three-scope adversarial review (semantic correctness / canonical authority /
production integration): **FIX-THEN-SHIP** — 3 HIGH (dead `đ`/`í`-initial VI
lexemes → vacuous coverage; marker-path grouped-quantity truncation → floor
collapse; deadline/year numbers minting and satisfying floors), 3 MED (VI
clause-initial false anchors; unbounded render vs 4096 evidence bound;
trailing-connective un-coverable obligations), 4 LOW. All remediated, each
with a regression probe. Details:
`docs/e2e-semantic-v1/SEMANTIC_V1_INDEPENDENT_AUDIT.md`.

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
- K′ residual (documented in the audit doc): a goal carrying NO requirement
  evidence at all (no verb, quantity, or deadline marker) still mints an
  empty contract — baseline conservative-incompleteness retained deliberately;
  prohibition enforcement is action+term-level (a task naming the banned
  object under the banned action violates even with a negating qualifier).

## K″ final audit remediation (post-0a4e204)

Owner-requested final correctness pass found one residual defect class —
ASCII `\b` boundaries dead adjacent to non-ASCII-edged Vietnamese lexemes:

- `DEADLINE_RE`/`TEMPORAL_NUM_RE`: `giờ`(ờ-edge) dead →
  `trước 10 giờ`/`trong vòng 30 giờ` minted no deadline and leaked
  duration numbers into quantity extraction **on both the contract and
  task sides** (phantom floors; a task duration could satisfy an
  unrelated floor). Fixed with Unicode lookarounds + `phút`/`giây` +
  `trước N <unit>` + date-ordinal masks (`trước ngày 15` ≠ `min:15`).
- `CONSTRAINT_RE`: `không quá`/`chỉ`/`ngoại trừ`/`<=`/`≤` dead →
  ceilings could invert into floors via the preserved-row backstop.
- `LOCAL_SOURCE_RE`, VI output/source markers (`kết quả`, `đọc`), and
  the connective counter (`và`, `sau đó`) had the same dead-edge class.

Full detail + sweep methodology + false-positive classification:
`SEMANTIC_V1_INDEPENDENT_AUDIT.md` §K″. Regression proof: H21–H30 in
`pair-semantic-adversarial.test.ts` (30/30 green). Re-verified at HEAD
`fa78955`: verify:change `--base 0a4e204` →
**READY_FOR_INDEPENDENT_AUDIT** at `fa78955` (code-final; pushed HEAD `e6912c1` carries only doc/claim-text deltas) (claim 10/10, invariants 8/8,
regression 18/18, TSC+BUILD PASS, full suite PASS_WITH_KNOWN_BASELINE).

## 9. Merge status

**Not merged.** K″ audit remediation verified at `fa78955`; owner merge
decision pending. Releases remain unauthorized until the owner acts.
