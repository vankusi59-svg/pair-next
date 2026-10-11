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

## Screenshot evidence — provenance & labels (B6 R3)

All 16 PNGs under `screenshots/` were **regenerated** at R3 by `scripts/b6-shots.mjs`, which spawns its **own** `serve-mission-control.mjs` inside the run: fresh `PAIR_MC_DIR` per run (`mkdtemp /tmp/pair-b6-shots-*`), synthetic token `b6-fixture-token` via `PAIR_MC_TOKEN` (the real dev credential is never read — nothing in shots, console, or committed files is a real secret), stub conversation replies, template planner. Isolation is **affirmatively verified at runtime**: `GET /api/businesses` must return EMPTY before seeding; one synthetic business (`b6-fixture-demo`) via canonical `POST /api/businesses`; **one synthetic objective** (`B6 fixture objective`) via canonical `POST /api/vnext/objectives` — backend derives `owner_authority_id = operator:op:e2e` from `x-operator-id` (never forged); the script asserts the derived owner, `business_id`, and that `GET /api/vnext/businesses/:id/company` returns **HTTP 200** containing the seeded objective **before** launching the browser. Per-capture assertions: `localStorage["pair.business_id"]===BIZ`; populated shots wait for their marker text (`b6-fixture-demo` / `B6 fixture objective`) inside `main.amain` — real data render, not just shell presence; **every** shot fails on `/access denied|fail_closed_…|no business selected/i` in page text; navigation non-OK aborts.

Runtime log (R3 run): `PAIR_MC_DIR=/tmp/pair-b6-shots-lc0mas PORT=8792` → `fixture business: BIZ_01M4MA4X32BZ97B3PCZF3HKZ9M` → `fixture objective: OBJ_191d8c187e215e8100dd55e7 owner=operator:op:e2e company=200 verified` → `shot … OK (verified "…")` → `done — all captures verified`.

**R2 → R3 correction:** the R2 run's populated shots rendered `Access denied — FAIL_CLOSED_COMPANY_SCOPE` (actor owned zero objectives — correct fail-closed backend behavior) and the R2 assertion falsely passed because the error detail contained the business id. R3 seeds one owner-scoped objective and asserts marker text + rejects error strings, so populated-state claims now reflect real canonical evidence.

| Shot (×light/dark) | Viewport | What it proves | State |
|---|---|---|---|
| `company-*`, `company-mobile-*` | 1440 + 390 | cockpit ready state: business header, KPI cards (OBJECTIVES OWNED 1), objective row, sidebar/tab bar, theme tokens | **populated, asserted** — `b6-fixture-demo` marker verified; canonical company read 200 pre-checked |
| `objectives-*` | 1440 | objective list with one owned objective card (status, KPI progress, budget, deadline) | **populated, asserted** — `B6 fixture objective` marker verified |
| `inbox-*` | 768 | tablet layout, lanes, badge | empty inbox lanes |
| `missions-*` | 1440 | mission list + global-unfiltered label | empty mission table |
| `system-cost-*` | 1024 | tablet cost page, policy/profile tables | empty canonical tables |
| `system-providers-*` | 1440 | catalogs + gate labels | provider catalog from fixture env |
| `chat-mobile-*` | 390 | mobile chat layout, composer reachability | empty conversation list |

**Scope of proof:** these 8 views × 2 themes are a **subset**, not all routes and not all interactive states — deep-link coverage of all 15 routes is proven by `b6-acceptance.spec.ts` (executable), and interactive states by the B5.x suites. Visual states NOT evidenced by screenshots (dialogs, confirmations, error panels, populated-with-data tables, hover/focus rings) remain covered only by tests — recorded as **INSUFFICIENT** static-visual evidence rather than claimed.
