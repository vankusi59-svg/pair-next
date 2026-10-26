# P18.5 — Post-Merge Governance & Test Infrastructure Hardening

Branch: `feat/p185-governance-test-hardening`
Baseline (Phase A): `2174e91` (main @ PR #154 merge)
HEAD: `c99ae8a` (two commits — see below)

| Commit | Workstream | Scope |
|---|---|---|
| `a687f3d` | F10 | `src/pair/goal-contract.ts`, `plan-coverage.ts`, `llm-planner.ts`, semantic test files, patch claim |
| `c99ae8a` | Test infra | `src/test-utils/tmpdir.ts`, `vitest-tmp-cleanup.ts`, `vitest.global-setup.ts`, `vitest.config.ts`, ~150 codemodded test files, lifecycle test, codemod scripts |

## Workstream 1 — F10 deterministic numeric-ceiling enforcement

### Problem audited
Operator ceilings ("không quá 50 USD", "tối đa 3 tác vụ", "at most 5
outputs", "budget max $500", "no more than 100 requests") were recorded
inconsistently:

- `quantity.max` was minted by bare-number scans but **never enforced**
  anywhere in `assertPlanCoverage` — a declared bound was documentation.
- `maxAmount` existed only via `BUDGET_RE` and was enforced only against
  loose `instructionAmounts` ($-prefixed numbers); non-monetary ceilings
  had no path at all.
- Ceiling-shaped backstop clauses could mint `quantity.min` (ceiling →
  floor inversion) — e.g. "budget max $500" → `min:500`.
- Exact-form bounds ("exactly 3 reports") were uncoverable because
  `exactly`/bound words became identity anchors.
- `no more than`/`không hơn`/`nhiều nhất`/`không vượt quá` were missing
  from `CONSTRAINT_RE` → no constraint row minted at all.

### Design
- `GoalRequirement.ceiling?: { amount:number; kind:"money"|"task-count"|"object-count"; unit:string }`
  preserves dimension + unit + provenance. Money ceilings also populate
  legacy `maxAmount` for compatibility.
- `extractCeiling` classifies the bound: currency symbols/codes → money;
  task-count nouns → task-count; object nouns → object-count;
  duration/frequency/percent units → **never mint** (rejected as
  unrelated numbers). Prefix currency (`max $500`) types the bound before
  unit classification; function-word units (`for`, `per`, `của`…) never
  mint object nouns.
- `CONSTRAINT_RE` extended: at most/no more than/not more than/up to/
  maximum/max/tối đa/không quá/không vượt quá/nhiều nhất/không hơn/<=/≤.
- Coverage enforcement in `covers()`:
  - money → `instructionAmounts` extended with unit-aware matching
    ($/usd/vnd/đồng/dollar/euro, grouped numbers `1,000`/`1.000` aligned
    with `quantityNums` digit-width rules);
  - task-count → plan task count vs ceiling;
  - object-count → numbers bound to the same unit noun in task
    instructions (+ declared produced artifacts for file-like units);
  - `quantity.max` on obligations → contradiction check via
    subject-bound numbers.
- Semantics: over-bound evidence → `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`;
  at/under-bound → PROVEN; no bound evidence → row stays PRESERVED
  (never fabricated PROVEN); max-only obligations unverifiable → strict
  (INCOMPLETE), exact-form obligations → contradiction-only.
- Ceiling clauses can never mint `min`: the backstop skips clauses
  already represented as constraints, and `min` is stripped whenever a
  ceiling/maxAmount exists on the same requirement.
- `ANCHOR_STOP` extended with bound markers (`exactly`, VI
  ceiling/negation words) so bound words never become identity anchors.
- Subject matching permits singular/plural in both directions
  (`report`/`reports`) — bounded by the existing word-boundary matching.

### What is NOT enforced (explicit, documented)
Plan-time text inspection proves **declared plan evidence** only.
Runtime spending/API-rate/resource limits are an execution-policy
concern: `SpendTracker`/TreasuryPolicy govern *provider inference spend*,
not arbitrary per-mission operator ceilings. No adequate governed
mechanism exists for mission-scoped money caps; the mission requirement
is satisfied by failing closed at plan time when the plan itself declares
over-bound evidence, and preserving (never PROVEN) when evidence is
absent. No runtime guarantee is fabricated.

### Tests (all in `pair-semantic-adversarial.test.ts` H43+, plus
`semantic-planning-context`/`semantic-coverage` updates)
Under-limit plans, over-limit plans, money vs non-money, EN/VI
equivalence, grouped numbers (`1,000`/`1.000`), dates/durations ignored
as quantity evidence, missing evidence stays PRESERVED, ceiling-vs-floor,
forged advisory `pair_coverage` hints still fail closed, max-only
obligation strictness, exact-quantity binding, wrong-currency rejection.

## Workstream 2 — test temp-dir lifecycle

### Root cause
~270 `mkdtempSync(join(os.tmpdir(), "<prefix>-"))` callsites across ~153
test files created dirs with **zero ownership**: no shared factory, no
afterEach/afterAll, no recovery path. Interrupted/crashed vitest runs
leaked everything; ~2,000 `pair-*` dirs (~20 GB) accumulated → ENOSPC →
mass worker crash (observed during V1 verification).

### Implementation
- `src/test-utils/tmpdir.ts` — single owned path:
  - `mkTmpDir(prefix)`: `mkdtempSync` + per-worker registry + `.pair-tmp-owner`
    marker + process-exit best-effort cleanup. Returns the raw created
    path (verbatim path semantics preserved for workspace/digest
    assertions); realpath spelling registered for cleanup only.
  - `cleanupTmpDirs()`: idempotent, `rmSync{recursive,force,maxRetries:6}`
    — tolerates Windows locks, removes only dirs this worker created.
  - `sweepStaleTestDirs()`: recovery net — allowlisted repo prefixes,
    age-gated `PAIR_TMP_SWEEP_MIN_AGE_MS` (default 60 min), strictly under
    `os.tmpdir()`, skips anything the live registry owns, `PAIR_TMP_SWEEP=0`
    disables. Emits `[tmp-sweep] scanned/removed/skipped/bytesFreed`.
- `src/test-utils/vitest-tmp-cleanup.ts` — `afterAll` cleanup, wired via
  `setupFiles` → runs in every worker on success AND failure paths;
  workers own disjoint registries (no cross-worker deletion).
- `vitest.global-setup.ts` — stale sweep once per suite invocation before
  workers spawn.
- Codemod (`scripts/dev-verification/tmpdir-codemod*.cjs`): all
  literal-prefix callsites migrated; nested `mkdtempSync` under owned
  roots intentionally left (parent removal covers); imports normalized
  into header blocks (template-literal misplacements repaired and
  regression-proven).

### Safety invariants
Never deletes outside `os.tmpdir()`; never deletes non-allowlisted paths;
never deletes dirs owned by a live registry; age gate far above run
residency so parallel invocations are undisturbed; every delete is
per-path try/catch — locked/foreign dirs are skipped, never fatal.

### Measured (two focused cycles, Windows 11 host, sanitized env)
- Before: **244** allowlisted residual dirs / **2,747.6 MB** under `%TEMP%`.
- Sweep on a fresh suite start: `scanned=244 removed=0 skipped=244` —
  all sub-60-minute (created by this session's runs) → correctly skipped.
- After 2 cycles (6 files, incl. store-heavy suites): **253** dirs /
  **2,801.6 MB** → net **+9 dirs / +54 MB** from the measured runs
  (≈1.5 dirs per file, mostly module-scope `PairEvidenceStore` SQLite
  files locked until process exit — skipped, never force-deleted).
- Regression equivalence: all 23 failing files produce **identical
  failure counts at base `2174e91`** (verified on clean worktree):
  Windows path-canon (`D:\a` vs `/a`), EPERM symlinks, fsync count,
  `.cjs`/`cmd` spawn, `.local` PATH-mask, ambient-env classes.
- Honest residual: dirs holding live-locked SQLite DBs survive until
  process exit; the age-gated sweep reclaims them on later runs. Not
  zero-leakage — bounded by ~dirs-per-file and self-healing.
