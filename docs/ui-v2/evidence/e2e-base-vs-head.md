# UI-V2 — BASE-vs-HEAD Playwright Comparison

Evidence for PR #157 review. Per-test machine-readable data:
[`e2e-comparison.json`](./e2e-comparison.json). Raw reporters:
[`e2e-base-raw.json`](./e2e-base-raw.json) ·
[`e2e-head-raw.json`](./e2e-head-raw.json).

## Run metadata

| | BASE | HEAD |
|---|---|---|
| Commit | `ab0fccf79b2ac5ed045e948a0402ecbaa889c439` | `5f1870c` (branch `ui-v2-owner-experience`) |
| Worktree | `D:\pair-base-ab0fccf` (clean checkout) | `D:\PAIR_NEXT_2410` |
| Command | `npx playwright test --reporter=json` from `apps/mission-control-ui` | identical |
| Config | `playwright.config.ts` — **identical** (zero diff BASE..HEAD) | identical |
| webServer | auto-spawn `serve-mission-control.mjs` on :8790, `PAIR_MC_TEMPLATE_PLANNER=1`, `PAIR_CONVERSATION_STUB_REPLY`, `PAIR_MC_DIR=/tmp/pair-mc-e2e` | identical |
| Browser | Microsoft Edge via `CHROME_BIN` (config's default Linux path absent on this box — same override both runs) | identical |
| OS / runtime | Windows 11, git-bash, Node v24.19.0 | identical |
| Dependencies | junctioned `node_modules` from main worktree — `package.json`/`package-lock.json` have **zero diff** BASE..HEAD, so the dependency set is identical. (`npm ci` at BASE is impossible: BASE's own committed lockfile is stale vs its `package.json` — pre-existing repo state, unrelated to this diff.) | normal install |
| Start / duration | 2026-10-27T10:50:50Z · 145s · 6 workers | 2026-10-27T10:47:58Z · 102s · 6 workers |

## Totals

| | BASE | HEAD |
|---|---|---|
| Tests | 231 | 242 |
| Passed | 198 | 220 |
| Failed | 33 | 22 |

HEAD adds 11 tests (new `ui-v2.spec.ts`, 9+2 blocker-A tests) and nets **−11 failures** vs BASE.

## Classification (all 243 distinct test identities)

| Class | Count | Meaning |
|---|---|---|
| pass | 197 | passed at both |
| fail-both (verified pre-existing) | 22 | failed at both — same-substance signature audit below |
| FIXED | 11 | failed at BASE (stale-spec assertions), pass at HEAD |
| new-pass | 12 | new at HEAD (11 `ui-v2.spec` + renamed b6 index test) |
| removed | 1 | b6 "lands on Company Cockpit" — renamed to "owner home (Tổng quan)", updated assertion, passing |
| **REGRESSION** | **0** | — |
| **NEW-FAIL** | **0** | — |

## Signature audit of the 22 fail-both

Per-test evidence: [`e2e-signature-audit.json`](./e2e-signature-audit.json)
(full error heads, cause, and normalization notes per test — raw
reporters above are unchanged).

Method: for each test failing at both commits, the full error text was
compared after normalizing only provably-dynamic tokens — generated IDs
(`MSN_/BIZ_/OBJ_/AGT_/WI_/…`), hex digests, UUIDs, absolute filesystem
paths — and dropping `at …` stack frames (whose paths necessarily differ
between the two worktrees). Locator strings, expected/received values,
status codes, and error codes were **not** normalized.

Result: **20/22 error heads identical**; the 2 differing heads differ
only in dynamic/self-referential tokens, never in substance:

- `workforce-admin` — accumulated fixture row-count `181` vs `136`
  ("other businesses hidden"); the failing assertion (expected substring
  `"Open committed"`) is identical.
- `chat task entry` — the code-frame snippet shows the spec's own line
  that this diff intentionally fixed (`#project` → `getByLabel`);
  same `element(s) not found` failure.

→ **0 genuinely-different signatures; 22/22 verified same-substance
fail-both.** Dynamic-only diffs were not mistaken for regressions, and
no genuinely-different pair was flattened by normalization.

## Root-cause classification of the 22

Counted per-test by failure mechanism (not by file) — avoiding the
earlier 17+5 mis-attribution, which lumped `system.spec` and
`workforce-admin` planner failures into "stale spec" and double-counted
`missions list`:

**A. Planner environment — `FAIL_CLOSED_PLANNER_NO_ELIGIBLE` (21 tests).**
This box has no qualified planner candidate: configured routes resolve
to zero eligible candidates even with `PAIR_MC_TEMPLATE_PLANNER=1`.
Every preview/planner-dependent test fails identically at BASE. These
specs are **untouched** by this diff:

- 9× explicit `preview -> 409` (`missions list`, `mission detail` ×6,
  `read-only pages`, `R1-F4` — all `missions.spec.ts`)
- 9× downstream `toBeVisible`/`element not found` on the element that
  only appears after a successful preview/confirm (`app-chat` ×1,
  `chat` ×2, `missions task entry` ×4, `R2-A`, `smoke` ×1)
- 3× same gate on other seams — `system.spec` ×2 (`mkMission` asserts
  `pv.ok` at spec:126 → 409) and `workforce-admin` ×1 (work-item
  `open` → `FAIL_CLOSED_PLANNER_NO_ELIGIBLE` shown verbatim in the
  received page text)

**B. Pre-existing spec/data defect (1 test).**

- `p184-operations.spec.ts` — `expect(e.mission_id).toBe(mid)`: an
  `execution_health.executions` row carries `mission_id: undefined`.
  Same failure at BASE; unrelated to the planner gate and untouched by
  this diff.

## FIXED (failed at BASE → pass at HEAD)

BASE-failing stale-spec assertions that were reconciled to the V2
navigation/tab layout and now pass:

- `objectives.spec.ts` × 8 — policy/auto-run/KPI rows that asserted
  ambiguous `.actions` scoping or sections relocated behind `?tab=`
- `company.spec.ts` × 1 — business-scoped request-count expectation
- `inbox-ceo.spec.ts` × 1 — wrong A2 button assertion
- `workforce-admin.spec.ts` × 1 — stale-detail ordering

## Caveats

- The comparison is **conclusive** for this environment: identical OS,
  Node, browser binary, harness config, dependency set, and command on
  both sides. The only deviation from a clean checkout is the junctioned
  `node_modules` at BASE, justified by the zero-diff dependency manifests.
- The 22 remaining failures: **21 planner-environment** (no qualified
  planner on this box — `FAIL_CLOSED_PLANNER_NO_ELIGIBLE`) + **1
  pre-existing spec/data defect** (`p184-operations` execution
  `mission_id` shape). Fixing either is out of this mission's scope.
- Post-audit addendum (HEAD `6e51f22`+): intake now also blocks negative
  budgets before confirm (finite-but-uncommittable values were silently
  dropped); covered by new `ui-v2.spec` regression test — focused re-run
  **12/12 pass**. No other e2e scope affected; the full-suite comparison
  above stands.
- Screenshot evidence: [`screenshots/`](./screenshots/) — captured from a
  live HEAD build on port 8797 (separate disposable instance).
