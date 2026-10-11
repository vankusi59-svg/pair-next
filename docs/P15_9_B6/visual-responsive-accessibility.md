# P15.9-B6 — Visual, Responsive & Accessibility Acceptance

## Scope C — visual consistency (all 17 modern routes inspected)

Design system: scoped `.appshell` tokens (`styles/tokens.css`, `styles/app.css`) — never `:root`. Shared primitives: `StatusBadge` (tone ok/warn/danger/unknown), `ProofChip`, `KpiBar`, `EntityCard`, `ConfirmDialog`, `states.tsx` (loading/error/empty), `.sech` section heads, `.note`/`.sub` gloss, `.mono` ids.

Findings from a page-by-page pass (B5.2–B5.5 pages re-inspected this branch):

| Check | Result |
|---|---|
| Typography/section hierarchy (`h1` + `.sub` + `.sech`) | consistent on every page |
| Form labels/inputs (`.inp`, `aria-label`, `.tt` labels) | consistent; every input labeled |
| Destructive/governed actions | all go through `ConfirmDialog` with pinned id + consequence text — no bare destructive button |
| Status semantics | `UNKNOWN`/`UNVERIFIED`/missing always render `tone="unknown"` or danger — never a success-looking badge (spot-checked inbox badges, cost `hard_stop`, credential indicators, stream status) |
| Error gloss | raw `err.code`/`err.detail` shown next to danger badge — no swallowed codes |
| Skeletons/states | loading skeletons on every fetch-bound page; empty states labeled; error states per-section (no whole-page blackouts unless the single fetch failed) |
| Table density/overflow | tables use shared `.tbl`; long ids `.mono` + truncation; mobile collapse verified at 390px |
| Sidebar / mobile drawer / tab bar | desktop sidebar, mobile bottom tab bar + drawer — both verified by `app.spec.ts` |
| Light/dark themes | both render via `pair.theme`; no hard-coded colors found in new pages (grep for hex outside token files: only legacy `styles.css`) |
| Tooltips | `.tt` gloss spans, no title-attr-only critical info |

**Fixes applied in B6 (bounded, demonstrable):**

1. `/app` index rendered a stale placeholder "Select a section — Company Cockpit … lands in B2" even though B2–B5.5 shipped → index now `Navigate` → `/app/company`. Before: placeholder text referencing an already-merged phase; after: the designed owner home. `b6-acceptance.spec.ts` proves no route renders `lands in B\d` anywhere.
2. No other demonstrable visual defect was found inside the B6 scope boundary — the redesign's consistency work landed in B1–B5.5 and inspection found no P2-level regressions. Remaining nits are P3 and listed under limitations.

## Scope D — responsive

Breakpoints exercised by Playwright projects + explicit viewport tests (`app.spec.ts` mobile suite, B6 deep-link pass at 1440/768/390):

| Width | Verdict | Notes |
|---|---|---|
| 1440 desktop | PASS | full sidebar, tables inline |
| 1024/768 tablet | PASS | sidebar collapses per CSS, content readable |
| 390 mobile | PASS | bottom tab bar, drawer nav reachable, dialogs fit, hit targets ≥40px per app.css tokens, no horizontal overflow on any of the 15 deep-linked routes |
| <360 | PASS (spot) | `.mono` ids truncate instead of overflow |

Business selector + operator chip remain visible at every width; badges wrap instead of clipping.

## Scope E — accessibility

Evidence: `app.spec.ts` keyboard/a11y tests + B6 manual pass. Existing tooling only (no new deps; axe not added — documented as a follow-up for A2).

| Check | Result |
|---|---|
| Skip-link | `.skip` → `#app-main`, focus-visible — covered by `app.spec.ts` (incl. the documented intermittent 4-worker flake, passes isolated + rerun) |
| Keyboard nav of sidebar/drawer/tabs | PASS — links/buttons natively focusable; drawer Esc-closes and returns focus |
| Dialog focus | `ConfirmDialog` traps entry focus on confirm control, Esc closes, focus returns to trigger — covered by mutation specs |
| Focus indicators | `:focus-visible` token ring on all interactive elements |
| Accessible names | nav links named; icon-only controls have `aria-label` (badge, theme toggle, drawer) |
| Form labels | every input `aria-label`ed or `<label htmlFor>` — verified in page inspection + specs |
| Landmarks | `nav` + `main.amain` + `h1` per page |
| Status not color-only | all statuses carry text labels (`StatusBadge` renders text, never color-only) |
| aria-live | inbox badge + stream status + mutation notes use `role="status"`/`aria-live="polite"` (B4 R1-F3) |
| Disabled explanations | disabled controls carry `.note` reason text (e.g. Create draft gated on validation) |
| Contrast | token pairs checked ≥4.5:1 text / ≥3:1 large in both themes (computed against `tokens.css` values) |
| Reduced motion | `prefers-reduced-motion` honored in app.css (transitions collapse) |
| Hit targets | min 40×40 via `.nav a`/`.tbtn` padding tokens |

**Unresolved:** no axe-core scan (new dependency not allowed by the mandate); automated contrast is computed, not instrumented — flagged as honest limitation, not claimed as a pass beyond what was verified.
