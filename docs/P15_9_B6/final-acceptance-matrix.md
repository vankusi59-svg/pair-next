# P15.9-B6 — Final Acceptance Matrix

BASE `7791800cc764974d659f335d1e0e569a97106411` → HEAD (see verification-report). Gate verdicts use H-acceptance-matrix semantics: PASS = evidence exists and proves the gate; FAIL = proven broken; INSUFFICIENT = claimed but not evidenced; N/A = out of scope with justification. No aggregate "percentage" verdict is used.

| Gate | Expected | Impl / evidence ref | Procedure | Verdict |
|---|---|---|---|---|
| G-parity | every legacy capability has a modern destination | `functional-preservation-matrix.md` | inventory legacy routes + UI_HTML fns vs /app pages; per-capability test ref | **PASS** — no NOT_PORTED/UNVERIFIED found |
| G-uihtml-admin | UI_HTML admin fns ported or justified | `ui-html-admin-parity.md` | fn-by-fn verdict vs `workforce-admin.spec.ts` | **PASS** — all 11 fns ported+proven |
| G-visual | consistent design system, no fabricated states | `visual-responsive-accessibility.md` §C | page-by-page pass on all 17 routes | **PASS** — 1 defect fixed (`/app` stale placeholder); none others demonstrable |
| G-responsive | desktop/tablet/mobile usable | same doc §D | Playwright viewport tests at 1440/1024/768/390 + deep-link pass | **PASS** |
| G-a11y | keyboard, semantics, contrast, targets | same doc §E | existing e2e a11y tests + computed contrast check | **PASS** with limitation — no axe-core scan (new dep disallowed); automated contrast is computed not instrumented |
| G-authority | scope/auth/truth/mutation review | `authority-security-review.md` | F1–F4 checklist vs code + mutation-count e2e | **PASS** — zero write-on-load proven by counters |
| G-e2e-regression | all shipped suites green | `verification-report.md` | `npx playwright test` full run | **PASS** — 200/201 (1 conditional skip pre-existing, 0 fail) |
| G-legacy-regression | legacy routes unchanged | `e2e/b6-acceptance.spec.ts` OFF test + `smoke.spec.ts`/`chat.spec.ts`/`system.spec.ts` legacy tests | default-flag OFF coverage | **PASS** — legacy tree untouched (OptInRedirect is additive) |
| G-negative-path | adversarial coverage | all `*.spec.ts` (401/403-foreign/malformed/ambiguous/dup-click/delayed/SSE-interrupt/API_MISSING) | counted in full run | **PASS** — covered across existing specs; no new gaps found in B6 review |
| G-redirect-prep | dormant opt-in redirect | `cutover-preparation.md` + `b6-acceptance.spec.ts` | OFF default, ON per-route, id/query preserved, unmapped safe, revert restores | **PASS** — 7/7 tests |
| G-rollback | documented procedure | `rollback-plan.md` | doc review; Level-1 proven by e2e | **PASS** (documentation deliverable; execution deferred to real cutover) |
| G-docs | 8 deliverables present, observed-behavior-only | `docs/P15_9_B6/*` | file inventory | **PASS** |
| G-verification | harness READY + real counts | `verification-report.md` | `verify:change --base 7791800` | **PASS** — READY_FOR_INDEPENDENT_AUDIT |
| G-owner-signoff | Owner approves intentional differences | — | Owner decision | **INSUFFICIENT** — by design awaiting Owner (C1 in cutover-preparation) |
| G-axe-scan | automated a11y scanner run | — | not run | **N/A** — new dependency out of B6 scope; flagged for A2 |

**Verdict definitions**: GO = all gates PASS, no conditions. CONDITIONAL = gates pass with documented Owner-decision conditions. NO-GO = any FAIL or unresolvable INSUFFICIENT.

**Verdict: CONDITIONAL** — the only non-PASS gates are G-owner-signoff (awaiting Owner by design) and G-axe-scan (N/A, deferred). No FAIL gate, no hidden gap: conditions C1–C4 enumerated in `cutover-preparation.md` §H3 are decisions, not defects.
