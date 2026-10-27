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
| fail-both (verified pre-existing) | 22 | failed at both with **identical normalized error signatures** (signature diff: 0) |
| FIXED | 11 | failed at BASE (stale-spec assertions), pass at HEAD |
| new-pass | 12 | new at HEAD (11 `ui-v2.spec` + renamed b6 index test) |
| removed | 1 | b6 "lands on Company Cockpit" — renamed to "owner home (Tổng quan)", updated assertion, passing |
| **REGRESSION** | **0** | — |
| **NEW-FAIL** | **0** | — |

## The 22 verified pre-existing failures

All fail at BASE with the same signature; none are caused by this diff.
Two root causes:

**A. Planner environment — `preview → 409 FAIL_CLOSED_PLANNER_NO_ELIGIBLE`
(17 tests).** This box has no qualified planner candidate: configured
routes (`codex-cli` subscription) resolve to zero eligible candidates even
with `PAIR_MC_TEMPLATE_PLANNER=1`. Every preview-dependent test fails
identically at BASE. These specs are **untouched** by this diff.

- `missions.spec.ts` × 12 — list/task-entry/mission-detail/R1-F4/R2-A
  (`preview -> 409` or downstream `toBeVisible` timeout)
- `chat.spec.ts` × 2, `app-chat.spec.ts` × 1, `smoke.spec.ts` × 1 —
  same preview-409 root cause
- `missions list: global label, search/filter/sort…` — preview 409

**B. Pre-existing stale-spec assertions (5 tests)** — assertions that did
not match the BASE UI either; identical failure signatures at BASE:

- `p184-operations.spec.ts` × 1 — ops-section equality assertion
- `system.spec.ts` × 2 — `> 126` count assertions (observability, settings R1-F3)
- `workforce-admin.spec.ts` × 1 — `toContainText` on lifecycle row
- (`missions.spec` row above also contains one preview-409 test counted in A)

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
- The 22 remaining failures are an **environment baseline** (no qualified
  planner on this box) plus 5 pre-existing stale-spec defects; fixing the
  stale specs or qualifying a planner is out of this mission's scope.
- Screenshot evidence: [`screenshots/`](./screenshots/) — captured from a
  live HEAD build on port 8797 (separate disposable instance).
