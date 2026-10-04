# PAIR_NEXT PRV2-B — Goal Contract + Coverage Authority Report

Base: `main` @ `92aca1d` (post-PRV2-A merge). One new branch
`devin/…-prv2b-goal-coverage`, one new PR. **DO NOT MERGE — pending
independent audit.**

## Problem

PRV2-A made plan *shape* canonical; nothing proved a plan covers the
operator's stated work. A model could pin a plan that silently omitted a
requested obligation ("research competitors, compare pricing, propose 3
strategies" → plan covering only the first two), downgraded an explicit
quantity ("20" → "5"), or violated a stated constraint/prohibition — and
the mission would complete "successfully" against the wrong goal.

## Canonical rule

> A plan may become canonical only when every mandatory operator
> obligation / deliverable / constraint / prohibition represented by the
> Goal Contract is covered or preserved by a valid canonical task —
> verified by PAIR, never certified by the model.

- Missing mandatory coverage → `FAIL_CLOSED_PLAN_INCOMPLETE`
- Proven constraint/prohibition contradiction →
  `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`

Both are `IntegrityError`s thrown inside `makeServeCanonicalizer` → the
candidate attempt settles FAILED/PLAN_INVALID and the existing planner
failover advances to the next candidate (proven by a live
`runPlannerFailover` test).

## Changes

### `src/pair/goal-contract.ts` (new, 307 lines) — deterministic extractor

`extractGoalContract(rawGoal)` projects the raw goal into a bounded
contract. Deterministic, regex-only — no model, no NLU service, no
random IDs.

- `objective` — leading clause verbatim.
- `obligations` (`OBL_001…`) — clauses that **lead with a work verb**
  after filler strip (hãy/please/đầu tiên/list numbering/bullets).
  Nouns that merely mention work ("f3 r1 test mission") never mint
  obligations.
- `deliverables` (`DEL_001…`) — clauses naming a file target, plus a
  produce-verb + filename anywhere; `target` = the exact filename.
- `constraints` (`CON_001…`) — budget/limit/language clauses; explicit
  `maxAmount` extracted for budget ceilings so a violation is checkable.
- `prohibitions` (`PRO_001…`) — negated clauses (do not/must not/
  không được/đừng/cấm/tránh); `terms` distilled minus stopwords.
- `deadline` (`DL_001`) — temporal clauses preserved verbatim; PAIR has
  no scheduling engine and never invents dates.
- **References, never duplicates**: `delivery_intent` and
  `output_language` store the results of the existing canonical
  `detectTelegramDeliveryIntent` / `detectOutputLanguage` calls — one
  authority per concern preserved. Network requirements are enforced by
  the existing PRV2-A gate, untouched.
- **Quantity preservation**: `quantity.min`/`max` extracted per clause.
  A bare number is a floor ("20 products" → min 20); an explicit
  "at least/at most" sets the matching bound. The plan may *exceed* a
  floor but may never downgrade it.
- `contractDigest` = sha256 over canonical JSON (truncated 32) — the
  contract is content-addressed like every other canonical artifact.
- Stable deterministic IDs `OBL_001/DEL_001/CON_001/PRO_001/DL_001` —
  no UUIDs, replay-stable.

### `src/pair/plan-coverage.ts` (new, 360 lines) — the authority seam

`assertPlanCoverage(contract, canonicalTasks)` runs on the canonical
task list (after bookkeeping inject, dep remap, dataflow reconcile) so
coverage binds the task keys the plan will pin.

**Obligation coverage** — a work task covers an obligation iff:

1. it shares ≥1 **verb class** with the requirement (14 bounded classes:
   research, analyze, compare, propose, fetch, create, compute, plot,
   summarize, test, monitor, translate, deploy, list);
2. every **subject-identity anchor** of the requirement appears in the
   task (reuses `subjectAnchors` — PRV2-A R5–R7 semantics: generic
   modifiers are never anchors);
3. when the requirement has no anchors, ≥1 shared **subject-class key**
   (`externalSubjectKeys`) OR a shared **content token** — a shared verb
   alone ("propose based on the comparison") can never prove coverage;
4. any stated `quantity.min` appears in the task instruction at equal or
   larger magnitude — "20" can never become "5".

**Deliverable coverage** — `extractTaskDataflow(task).produces` must
contain the named file, with basename equivalence ("report.md" satisfied
by a governed `outbox/report.md`). Canonical artifact machinery, not
filename grep.

**Constraints** — bounded direct validation only where checkable:
a task asserting `$X` above an explicit `maxAmount` budget → VIOLATED.
Everything else → `PRESERVED` (recorded, never claimed PROVEN, never
dropped). Deadlines always `PRESERVED`.

**Prohibitions** — a task instruction invoking a distilled prohibited
term, or requesting `TELEGRAM_DELIVERY` against a telegram-related
prohibition term → `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`.

**Model proposals are evidence, never authority** — a task's
`metadata.pair_coverage` mapping is validated: every claimed id must
exist AND be genuinely covered; a fabricated claim is INCOMPLETE, not
a grant. Coverage is then computed independently by PAIR.

**Bookkeeping never counts** — `AUTOMATON_TASK_EXECUTION` tasks are
excluded from the work set (adversarial case K).

### `src/pair/serve-planner.ts` (+14 lines)

One seam, after `reconcilePlanDataflow` and before return/pin:
`assertPlanCoverage(extractGoalContract(goal), allTasks)`. The contract
is derived from the immutable goal — initial plan, preview, and **replan
all traverse the same canonicalizer**, so a replan is checked against the
original contract: replanning changes HOW, never WHAT (case I).

### `src/pair/llm-planner.ts` (+41 lines)

`buildPlannerUserPrompt` injects a `GOAL CONTRACT (canonical — you must
cover it, not change it)` block listing every requirement id + text,
with coverage-annotation guidance (`pair_coverage` is optional and
verified independently). Also `anchorLexeme()` plural/alias
normalization for the R5–R7 anchor path (fixes "EAs"≢"ea"), and
quantity-bound words (`least`, `most`, `min`, `max`, `minimum`,
`maximum`, `fewer`) added to `ANCHOR_STOP` so "at least 20" can't mint
a false anchor.

### `src/__tests__/pair-prv2b-goal-coverage.test.ts` (new, 303 lines, 20 tests)

## Adversarial matrix (mandate A–M) — all proven

| # | Case | Result |
|---|------|--------|
| A | Plan omits a requested obligation | `FAIL_CLOSED_PLAN_INCOMPLETE` on `OBL_002` |
| B | Every requirement covered | canon PASS, keys deterministic |
| C | Task lies in `pair_coverage` (claims OBL_002 it does not perform) | `FAIL_CLOSED_PLAN_INCOMPLETE` — mapping is proposal only |
| D | Named deliverable `report.md` has no producer | `FAIL_CLOSED_PLAN_INCOMPLETE` on `DEL_001` |
| E | `propose 20 products` covered by `propose 5` → reject; `at least 20` covered by `propose 20` → PASS | quantity floor preserved, never downgraded |
| F | `budget <= $50` + task asserting `$100` | `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION` |
| G | `do not use Telegram` + task carrying `TELEGRAM_DELIVERY` | `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION` |
| H | Explicit `gửi … telegram` clause | skipped as obligation (existing telegram intent flow referenced, not duplicated); delivery task covers nothing else |
| I | Replan path goes through the same canonicalizer → contract re-derived from original goal | same gate fires (structural guarantee + unit proof) |
| J | `runPlannerFailover`: candidate #1 incomplete → attempt FAILED → candidate #2 wins | real failover proven |
| K | AUTOMATON bookkeeping task as sole "cover" of an obligation | excluded from work set → `FAIL_CLOSED_PLAN_INCOMPLETE` |
| L | `create report.md` goal | no telegram/network inventions; DEL satisfied by `write report.md` |
| M | PRV2-A network authority | unchanged — coverage runs after the existing network gates; all PRV2-A tests still pass |

Extraction adversarial cases additionally proven: noun-mention goals mint
no obligations; prohibition terms ignore "telegram" in negated clauses;
`20 → some` downgrade rejected; VI verb-leading clauses (`nghiên cứu`,
`phân tích`, `đề xuất`, `viết`) mint obligations.

## Regression / blast radius

PRV2-B is the first seam to reject plans that shape-canonicalize but
don't cover the goal — legacy fixtures with placeholder instructions
("step N", "do x", "research x") failed as designed. Fixtures were made
coverage-consistent with **instruction-text edits only** (10 spots in
`pair-prv2a-planner-modernization.test.ts`); no assertions changed.

Extractor hardening found during this pass: list numbering
(`1. fetch … 2. fetch …`) is stripped before clause splitting so item
numbers never become a quantity bound; `gather`/`collect` added to the
fetch verb class; `comparison`/`chart`/`graph` removed from the content
stop-list (object nouns, verb-gate still protects against false
coverage).

## Validation

- Focused: PRV2-B **20/20**, PRV2-A **59/59**, F3-R1 **20/20**.
- Full suite: **3465 pass / 2 fail** — the 2 are the known
  environment-only P5 failures identical to baseline
  (baseline 3445 + 20 new = 3465).
- `tsc --noEmit` clean; `rm -rf dist && pnpm build` clean;
  `pnpm audit` — 0 high (1 low + 8 moderate, unchanged from baseline).

## Explicitly NOT (per mandate)

No CEO Agent, no Brain Model Router, no ReasoningBrief, no Memory/
Verified Experience, no second authority for Telegram/language/network,
no model-based classifier, no entity database, no heuristic NLU beyond
the bounded regexes above, no silent correction of planner output, no
quantity downgrade, no contract mutation after extraction.

## Residual debt (recorded, not widened)

- Obligation↔task correspondence is bounded lexical matching (verb class
  + anchors + content tokens), not semantic entailment — conservative
  false-negatives are possible for paraphrased instructions; they fail
  closed (INCOMPLETE → failover), never false-accept silently.
- Constraints beyond budget ceilings are PRESERVED, not validated — by
  design; validation authority for them is future work.
- `pair_coverage` proposals are validated but their (empty) rejection
  doesn't surface task-level diagnostics beyond the typed error.
- Codex `PLAN_SCHEMA` still cannot emit edge/coverage fields
  (PRV2-A residual, unchanged).

Classification: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_PENDING_AUDIT`

---

## R1 remediation (audited base `aa8a84b`, same PR #42)

Independent audit found 3 HIGH structural blockers; all closed below.

### R1.A — clause dimensions are no longer mutually exclusive

`extractGoalContract` previously `continue`d after the first matching
dimension, silently dropping mandatory work. Now each clause contributes
every orthogonal row it states: prohibition still outranks everything (a
forbidden clause never mints positive requirements) and the
telegram-delivery clause still defers to the existing intent authority;
then deadline, deliverables, `only`-constraints, and verb-led
obligations are minted independently.

- `research 20 MQL5 EAs by 31/10` → `OBL_001` (quantity.min=20) **and**
  `DDL_001` — proven: plan omitting the research task →
  `FAIL_CLOSED_PLAN_INCOMPLETE`; covering task → PASS.
- `research current EA market, use only MQL5` → `OBL_001` +
  `CON_001(onlyTerms:[mql5])`.
- `research MQL5 EAs only` → research obligation retained +
  `only`-constraint.
- Deliverable precision: a clause whose only work content is
  produce-verb + file target ("create report.md") stays DEL-only — no
  duplicate OBL — while an additional non-produce work verb in the same
  clause mints an obligation on its own.

### R1.B — `only X` bounds get deterministic contradiction detection

`only`-clauses now extract their bounded value (`onlyTerms`):
`only MQL5`, `MQL5 only`, `chỉ (dùng) X` — three word orders tried
independently so a leftmost match ("use only" capturing "use") never
wins; for the `X only` form the digit-bearing identity token nearest
`only` is the bound ("research MQL5 EAs only" → `mql5`).

A task provably contradicts the bound when it invokes a known sibling:
- **versioned family** — `mql5` admits the family `mql\d`; a task
  naming `mql4` → `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`;
- **bounded channel/platform set** — `only telegram` + a task naming
  `slack` → VIOLATED.

No sibling space enumerable → `PRESERVED`, never `PROVEN`
("use only candlesticks" + generic task → PRESERVED). A task naming the
permitted value is evidence → `PROVEN`. Budget ceilings unchanged.
Proven: `research EA market, use only MQL5` + `research MQL4 EAs` →
CONSTRAINT_VIOLATION; + `research MQL5 EAs` → PASS.

### R1.C — deliverable matching uses the canonical DSN-1 authority

`taskProducesDeliverable` no longer implements its own basename rule —
it delegates to `artifactNamesEquivalent()` in `artifact-authority.ts`,
the single pairwise equivalence used by F1/F2/F4 delivery/handoff:
`report.md ≡ report.md ≡ outbox/report.md`; `dirA/report.md ≢ dirB/report.md`
and `reports/internal/report.md ≢ report.md` (basename equivalence never
leaks across directories) — INCOMPLETE.

### R1 validation

- Focused: PRV2-B **36/36** (20 retained + 16 R1 adversarial).
- Regression battery **711/711** (PRV2-A 59, F3×4, F1×3, F2×4, F4, F5,
  DSN-1, telegram, dataflow-incident, CPL-1, CNI-1).
- Full suite: **3481 pass / 2 fail** — same 2 environment-only P5
  failures as baseline (3465 + 16 new).
- `tsc --noEmit` clean; `rm -rf dist && pnpm build` clean;
  `pnpm audit` — 0 high (1 low + 8 moderate, unchanged).

Classification: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_R1_PENDING_AUDIT`

---

## R2 remediation (audited base `9b71a35`, same PR #42)

Independent audit confirms R1.A/B/C closed; ONE issue remained and is
closed below.

### R2 — a recognized bounded constraint may not be silently dropped

R1 marked an `only`-constraint `PRESERVED` when no task carried the
permitted value — meaning the operator's explicit bound could vanish
from the executable plan. Now:

- **Sibling contradiction → VIOLATED** (unchanged R1.B semantics).
- **Carriage required**: for every `onlyTerm`, at least one canonical
  work task must carry the permitted value — else the constraint is
  uncovered → `FAIL_CLOSED_PLAN_INCOMPLETE` (never PRESERVED-as-success).
- **Relevance binding**: the carrying task must be the constrained work
  — for non-channel terms it must cover ≥1 obligation/deliverable, so an
  unrelated dummy mentioning `MQL5` never grants coverage and
  bookkeeping never satisfies a bound; channel `only` terms bind tasks
  engaging that channel. Proven:
  `research current EA market` under `use only MQL5` → INCOMPLETE;
  `research current MQL4 EAs` → VIOLATION; `research current MQL5 EAs` →
  PASS; `T1 research EA market + T2 note mentioning MQL5` → INCOMPLETE.
- **Budget currency forms**: checkable amounts now include `$100`,
  `100 USD`, `USD 100` — same-unit comparison only, no conversion.
  `100 USD` / `USD 100` under `budget <= $50` → VIOLATION; `$40` → PASS.
  A task carrying no checkable amount now leaves the budget row
  `PRESERVED`, never `PROVEN`.

### R2 validation

- Focused: PRV2-B **45/45** (36 retained/updated + 9 R2 adversarial).
- Regression battery **711/711** (PRV2-A 59, F1×3, F2×4, F3×4, F4, F5,
  DSN-1, telegram, dataflow-incident, CPL-1, CNI-1).
- Full suite: **3490 pass / 2 fail** — same 2 environment-only P5
  failures as baseline (3481 + 9 new).
- `tsc --noEmit` clean; `rm -rf dist && pnpm build` clean;
  `pnpm audit` — 0 high (1 low + 8 moderate, unchanged).

Classification: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_R2_PENDING_AUDIT`
