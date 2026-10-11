# P15.9-B6 — Verification Report

BASE `7791800cc764974d659f335d1e0e569a97106411` · branch `devin/1791681135-p15-9b6-acceptance` · repo `vankusi59-svg/pair-next`.

## Changed scope

- `apps/mission-control-ui/src/main.tsx` — dormant opt-in legacy→/app redirect (`OptInRedirect`, `pair.legacy_redirect` flag, 9 route mappings, dynamic-id + query/hash preservation).
- `apps/mission-control-ui/src/app/routes.tsx` — `/app` index now `Navigate` → `/app/company` (stale "lands in B2" placeholder removed).
- `apps/mission-control-ui/e2e/b6-acceptance.spec.ts` — new, 7 tests.
- `apps/mission-control-ui/scripts/b6-shots.mjs` — screenshot generator (regenerated on isolated fixture env; provenance documented in-source).
- `docs/P15_9_B6/` — 8 deliverable documents (R1 revisions: per-pane read audit, SSE token-in-query correction, screenshot provenance/labels, vitest baseline evidence, updated gates).
- `.pair-verification/patch-claim.json` — B6 claim.

Zero backend/schema/dependency changes. No merge, no deploy, no cutover activation.

## Commands executed (real results)

| Command | Result |
|---|---|
| `npm run typecheck` (apps/mission-control-ui) | PASS |
| `npm run build` (apps/mission-control-ui) | PASS (dist rebuilt; no new warnings) |
| `npx playwright test e2e/b6-acceptance.spec.ts` | **7/7 PASS** |
| `npx playwright test` (full regression, 4 workers) | **200 pass / 1 skip / 0 fail** — the 1 skip is a pre-existing conditional (`objectives.spec.ts` policy HALT isolated run did not flake this time; documented baseline retained) |
| `npx vitest run src/__tests__/pair-*.test.ts` | **3371 pass / 3 fail / 24 skip** — all 3 failures proven environment-specific, NOT claimed green. Exact assertions: `pair-p5.test.ts:341` + `:365` `expect(stockProbe.available).toBe(false)` — `DshExecutorAdapter`/`CodexCliExecutorAdapter` probes find `dsh`/`codex` executables on this VM's PATH; `pair-f4-delivery-provenance.test.ts:2943` `expect(() => reconcileStaleDeliveryAttempts(...)).toThrow(/crash-after-append/)` — spy fault-injection did not throw. **Baseline evidence (R1-F4):** same 2 test files rerun on an untouched `git worktree` at BASE `7791800` in this same environment → **identical 3 failures** (`3 failed | 80 passed`), same assertions → pre-existing/environment failures, not diff-caused. Zero backend files changed in BASE..HEAD. |
| `npm run verify:change -- --base 7791800cc764974d659f335d1e0e569a97106411` | **READY_FOR_INDEPENDENT_AUDIT** |

## Real-vs-mock evidence statement

- `b6-acceptance.spec.ts` redirect/id-preservation/deep-link tests run against the **real backend** (Playwright webServer = `serve-mission-control.mjs` fixture dir), not intercepted mocks — URL assertions prove router behavior; API traffic is real.
- Mocked (labeled interception) tests remain the B5.x adversarial suites — unchanged and still green.
- No paid model execution anywhere.

## Baselines / flakes

- HALT race flake (`objectives.spec.ts:377`): intermittent under 4-worker `Promise.all` double-click; passes isolated (356ms) and did not reproduce in this full run (clean 200/201).
- `app.spec.ts` skip-link focus: one observed 4-worker flake earlier in the program; not reproduced this run.
- Vitest env failures above are standing environment findings, not regressions.

## Visual / a11y findings

See `visual-responsive-accessibility.md`. One demonstrable defect found and fixed (stale `/app` index placeholder). Contrast computed ≥4.5:1/≥3:1 from token values both themes; no automated scanner (limitation — new dependency out of scope).

## Limitations

- The no-staticDir UI_HTML serving mode was verified in code only (mandate: do not start another server).
- Redirect ON-state tested per-test in isolated browser storage only; no real deployment was switched (none exists).
- axe-core scan deferred to A2 by Owner decision.
- Screenshots: 16 deterministic captures committed under `docs/P15_9_B6/screenshots/` (light+dark × 1440/1024/768/390 over company, objectives, inbox, missions, system-cost, system-providers, mobile company, mobile chat) via `scripts/b6-shots.mjs`. **Provenance (R1-F3):** regenerated on an explicitly isolated synthetic fixture env — `PAIR_MC_DIR=/tmp/pair-b6-shotenv` (fresh dir), stub replies, template planner, fixture token from `~/pair-mc-token` (local dev credential, masked in UI); one synthetic business `BIZ_01M4M9A65MJ8RG6SX3N78J6Y67` created via canonical POST inside that env. No real operator/business/mission data. Shots prove a subset (8 views × 2 themes); unevidenced interactive states recorded INSUFFICIENT in the a11y/visual doc.
- CI: none configured for this repo — verification is the harness + local suites above.
