# G — Implementation Roadmap

All PRs target `staging/pr59-safe`, one PR each, no merges by the implementer;
each carries `verify:change` + focused tests + e2e where UI changes. B0 (this
doc) is the only design-only PR.

## PR B1 — New shell + design tokens (foundation)

- **Scope**: `AppShell` (sidebar, business switcher per seed contract B.5.3,
  inbox badge stub, operator chip, theme toggle), CSS token file, `/app/*`
  route tree with placeholder pages, gloss map `lib/gloss.ts`, responsive
  grid. Switcher persists a manual/last-used `business_id` — no
  `/api/businesses` enumeration (unfiltered).
- **Files**: `apps/mission-control-ui/src/{app/AppShell.tsx, app/routes.tsx,
  styles/tokens.css, lib/gloss.ts}`; `main.tsx` mounts both trees.
- **Deps**: none. **Risks**: route-tree regression → e2e smoke covers old
  routes.
- **Verify**: tsc, build, existing e2e (must still pass verbatim), new e2e
  `/app` renders sidebar + theme toggle.
- **Acceptance**: `/app/*` reachable, `/` unchanged, keyboard nav works,
  light/dark both pass contrast.
- **Rollback**: delete `/app` children.

## PR B2 — Company Cockpit page

- **Scope**: `/app/company` (stats, needs-you lanes, objective cards,
  activity fallback), `EntityCard`, `KpiBar`, `ProofChip`, state components.
- **Files**: `src/app/pages/Company.tsx`, `src/app/components/*`, `api.ts`
  (+`businessCompany`).
- **Deps**: B1. **Risks**: 403 contract UX — DeniedState tested; truncation
  metadata honest.
- **Verify**: tsc/build + e2e seeds objective-bearing business → cards show
  proven chips; foreign operator → DeniedState.
- **Acceptance**: counts equal API payload exactly; unproven KPI never MET.
- **Rollback**: drop route.

## PR B3 — Objective Detail + Reviews page

- **Scope**: `/app/objectives/:id` (KPI/budget/lifecycle/workstreams/
  missions/artifacts/reviews/policy bands + edge renders),
  `/app/objectives` list, `/app/objectives/:id/reviews`.
- **Files**: `src/app/pages/{ObjectiveDetail,ObjectiveList,Reviews}.tsx`,
  api additions (`objectiveCockpit`, `objectiveReviews`).
- **Deps**: B2. **Risks**: `observation_error`/UNVERIFIED rendering honesty —
  negative e2e with seeded terminal objective.
- **Verify**: e2e covers CANDIDATE≠ACHIEVED badge, MET+BACKLOG banner,
  dropped-artifact counter, stale-pin review = history.
- **Acceptance**: every edge render in D.3 exercised.
- **Rollback**: drop routes.

## PR B4 — Owner Inbox + CEO Workspace

- **Scope**: `/app/inbox` (3 lanes), `/app/ceo`; A2 action buttons rendered
  disabled-with-gloss until A2 lands.
- **Deps**: B3. **Risks**: inbox must only show API-fresh pending —
  no client-side staleness guessing.
- **Verify**: e2e seeds CANDIDATE → inbox shows it; amend → it leaves inbox.
- **Acceptance**: approve/deny approvals still work (ported).

## PR A2 — Owner mutation routes (backend, approved in principle)

- **Scope**: `POST /vnext/objectives/:id/transition` + `POST …/amend`
  (owner-scoped, canonical `transitionStatus`/`amend` only — no new authority).
- **Note**: independent of B-PRs; Inbox/Detail enable buttons when it merges.

## Backend gaps named by B0 (NOT built in B — separate backend PRs)

Owner-scoped business enumeration, business-scoped approvals queue, server-side
`business_id` filter on `/api/org-agents`, HALT/policy-state aggregation across
owned objectives, business-scoped activity feed, ledger-row drill-down,
CEO-decision browse. Until each ships, the UI renders the verified
partial-scoped behavior in E — labeled, never faked.

## PR B5 — Workforce + Mission Ops port + System pages

- **Scope**: `/app/workforce` (agents — client-side `business_id` filter,
  contracts, inbox, work-items), `/app/missions*` port, `/app/system/*`
  ports (providers, observability, schedules, cost read, settings incl.
  token editor) **+ legacy `UI_HTML` admin port** (business/org-agent/
  work-item creation — the parity precondition that lets a staticDir
  deployment live without a second bare-server instance).
- **Deps**: B4. **Risks**: porting parity — matrix checklist; `UI_HTML` is
  unreachable in the SPA deployment today, so parity failure = a documented
  second no-`staticDir` instance, not silent loss.
- **Verify**: existing e2e moved to `/app/*` equivalents + old-route smoke.

## PR B6 — Cutover preparation + polish

- **Scope**: preservation-matrix sign-off page(s) — INCLUDING the `UI_HTML`
  admin parity verdict (ported / second bare-server documented), redirects
  from old routes → new (opt-in behind flag), visual/accessibility pass,
  final E2E matrix.
- **Deps**: B5. Cutover itself = separate Owner decision post-acceptance.

## Cross-cutting verification

Every UI PR: `pnpm build`, `tsc`, existing vitest suites (no backend change),
playwright e2e for the new route + old-route smoke; `verify:change` with
patch-claim listing `UI` surface. Accessibility checklist run per screen
(C.7) as PR checklist item.
