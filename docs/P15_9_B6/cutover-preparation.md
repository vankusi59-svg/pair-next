# P15.9-B6 — Cutover Preparation (dormant, opt-in; NOT a cutover)

## H1 — Route mapping table

| Legacy route | /app destination | Parity basis |
|---|---|---|
| `/` | `/app/missions` | mission list is `/`'s primary content; dashboard counters are covered by `/app/system/*` + `/app/inbox` (documented split) |
| `/missions/new` | `/app/missions/new` | PARITY_PROVEN |
| `/missions/:id` | `/app/missions/:id` | PARITY_PROVEN; dynamic id + `?query`/`#hash` preserved verbatim |
| `/approvals` | `/app/inbox` | PARITY_PROVEN (inbox approvals lane covers list+decide; broader surface is intentional) |
| `/schedules` | `/app/system/schedules` | PARITY_PROVEN |
| `/providers` | `/app/system/providers` | PARITY_PROVEN |
| `/observability` | `/app/system/observability` | PARITY_PROVEN |
| `/objectives` | `/app/objectives` | PARITY_PROVEN |
| `/chat` | `/app/chat` | PARITY_PROVEN |

Unmapped legacy-ish paths (`/ui`, arbitrary unknowns) **never redirect** — router falls through to its existing behavior.

## H2 — Opt-in mechanism (implemented, default OFF)

Implementation (`src/main.tsx`, `OptInRedirect` + `legacyRedirectOn`): browser-local flag `localStorage["pair.legacy_redirect"] === "app"`. Chosen because the repo already uses `pair.*` localStorage keys as its per-browser configuration pattern (`pair.mc_token`, `pair.operator_id`, `pair.theme`) — no new runtime configuration system was introduced.

Constraint check (all 11):

1. Default OFF — flag absent ⇒ legacy pages render (e2e `b6-acceptance.spec.ts` OFF test).
2. No auto-enable — nothing writes the key except a deliberate owner action in their own browser.
3. No deploy-config change — client-side only.
4. Targets are parity-proven destinations (table above).
5. No redirect loops — `/app/*` is outside the legacy route tree; a redirect target can never re-enter `OptInRedirect`.
6. Dynamic IDs preserved — `/missions/MSN_x?tab=files` → `/app/missions/MSN_x?tab=files` (e2e proven).
7. Query/hash preserved — `loc.search + loc.hash` appended.
8. Unmapped routes don't redirect — `/ui` stays non-`/app` (e2e proven).
9. Reverting the flag restores legacy — e2e removal test proves no sticky state.
10. ON-state tests isolated — `addInitScript` per-test; no real deployment settings touched.
11. `react-router` `Navigate replace` — no history pollution.

**Enable procedure (owner, per browser):** DevTools console → `localStorage.setItem("pair.legacy_redirect","app")` → reload. Disable: `localStorage.removeItem("pair.legacy_redirect")`.

Not implemented (by design): `/` → `/app/company` (chosen target is `/app/missions` for closest functional parity — Company Cockpit is the designed home but `/`'s content is mission-centric; Owner may retarget at A2 by editing the mapping constant).

## H3 — Cutover readiness verdict

**CONDITIONAL GO** — every gate in `final-acceptance-matrix.md` is PASS or INSUFFICIENT-with-justification; the conditions are Owner-decision items, not code gaps:

- C1 — Owner sign-off on the intentionally-different surfaces (UI_HTML unlabeled global panes → labeled scoped/global distinctions; `/` → `/app/missions` target choice).
- C2 — Owner decision on whether a real axe-core a11y scan (new dependency) is wanted before cutover, or accepted as an A2 follow-up.
- C3 — Owner chooses the cutover mechanism: per-browser opt-in flag (ready now) vs. a later server-side default flip at A2. B6 deliberately did not build a runtime config system for this.
- C4 — Remaining `API_MISSING` items (B0-E§6) are acknowledged; none regress vs. legacy.

No NO-GO item was found: no P0/P1 defect open; all shipped suites green on this branch.
