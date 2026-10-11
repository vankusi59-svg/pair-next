# P15.9-B6 — Final Acceptance Matrix

BASE `7791800cc764974d659f335d1e0e569a97106411` → HEAD (see verification-report). Gate verdicts use H-acceptance-matrix semantics: PASS = evidence exists and proves the gate; FAIL = proven broken; INSUFFICIENT = claimed but not evidenced; N/A = out of scope with justification. No aggregate "percentage" verdict is used.

| Gate | Expected | Impl / evidence ref | Procedure | Verdict |
|---|---|---|---|---|
| G-parity | every legacy capability has a modern destination | `functional-preservation-matrix.md` | inventory legacy routes + UI_HTML fns + UI_HTML read panes vs /app; per-capability test ref | **CONDITIONAL** — legacy router pages + admin fns all proven; **4 technical read panes NOT_PORTED** (Health, Metrics, Experience, Self-Improvement) — endpoints + no-staticDir mode intact, porting = Owner decision |
| G-uihtml-admin | UI_HTML admin fns ported or justified | `ui-html-admin-parity.md` | fn-by-fn verdict vs `workforce-admin.spec.ts` | **PASS** — all 8 admin fns + reads-of-admin ported+proven |
| G-visual | consistent design system, no fabricated states | `visual-responsive-accessibility.md` §C | page-by-page pass on all 17 routes | **PASS** — 1 defect fixed (`/app` stale placeholder); none others demonstrable |
| G-responsive | desktop/tablet/mobile usable | same doc §D | Playwright viewport tests at 1440/1024/768/390 + deep-link pass | **PASS** |
| G-a11y | keyboard, semantics, contrast, targets | same doc §E | existing e2e a11y tests + computed contrast check | **PASS** with limitation — no axe-core scan (new dep disallowed); automated contrast is computed not instrumented |
| G-authority | scope/auth/truth/mutation review | `authority-security-review.md` | F1–F4 checklist vs code + mutation-count e2e | **PASS** — zero write-on-load proven by counters |
| G-e2e-regression | all shipped suites green | `verification-report.md` | `npx playwright test` full run | **PASS** — 200/201 (1 conditional skip pre-existing, 0 fail) |
| G-vitest | unit suites green or failures proven env-specific | `verification-report.md` | `npx vitest run src/__tests__/pair-*.test.ts` + identical repro on untouched BASE worktree | **CONDITIONAL** — 3371 pass / 3 fail; all 3 reproduced byte-identical on BASE `7791800` in same env (`pair-p5` ×2 executable probes find dsh/codex on this VM's PATH; `pair-f4` R5.1 spy fault-injection) → pre-existing/environment, not diff-caused. Owner may still want them fixed separately |
| G-legacy-regression | legacy routes unchanged | `e2e/b6-acceptance.spec.ts` OFF test + `smoke.spec.ts`/`chat.spec.ts`/`system.spec.ts` legacy tests | default-flag OFF coverage | **PASS** — legacy tree untouched (OptInRedirect is additive) |
| G-negative-path | adversarial coverage | all `*.spec.ts` (401/403-foreign/malformed/ambiguous/dup-click/delayed/SSE-interrupt/API_MISSING) | counted in full run | **PASS** — covered across existing specs; no new gaps found in B6 review |
| G-redirect-prep | dormant opt-in redirect | `cutover-preparation.md` + `b6-acceptance.spec.ts` | OFF default, ON per-route, id/query preserved, unmapped safe, revert restores | **PASS** — 7/7 tests |
| G-rollback | documented procedure | `rollback-plan.md` | doc review; Level-1 proven by e2e | **PASS** (documentation deliverable; execution deferred to real cutover) |
| G-docs | 8 deliverables present, observed-behavior-only | `docs/P15_9_B6/*` | file inventory | **PASS** |
| G-verification | harness READY + real counts | `verification-report.md` | `verify:change --base 7791800` | **PASS** — READY_FOR_INDEPENDENT_AUDIT |
| G-screenshot-evidence | deterministic sanitized captures with runtime-verified provenance AND valid populated states | `visual-responsive-accessibility.md` screenshot section + `verification-report.md` | R3: self-spawned fixture server (fresh mkdtemp, synthetic token); canonical objective seeded with backend-derived owner; company API 200 asserted; per-capture marker-text wait + canonical-error rejection | **PASS (subset)** — 8 views × 2 themes; populated shots show real owner-scoped data (R2's 403-state captures corrected); unevidenced interactive states INSUFFICIENT, not claimed |
| G-owner-signoff | Owner approves intentional differences | — | Owner decision | **INSUFFICIENT** — by design awaiting Owner (C1 in cutover-preparation) |
| G-axe-scan | automated a11y scanner run | — | not run | **N/A** — new dependency out of B6 scope; flagged for A2 |

**Verdict definitions**: GO = all gates PASS, no conditions. CONDITIONAL = gates pass with documented Owner-decision conditions. NO-GO = any FAIL or unresolvable INSUFFICIENT.

**Verdict: CONDITIONAL** — G-parity and G-vitest carry honest CONDITIONAL verdicts (4 unported technical panes needing Owner decision; 3 pre-existing environment test failures proven identical on BASE); G-owner-signoff awaits Owner by design; G-axe-scan N/A. No FAIL gate: conditions C1–C7 in `cutover-preparation.md` §H3 are decisions/evidence items, not code defects.
