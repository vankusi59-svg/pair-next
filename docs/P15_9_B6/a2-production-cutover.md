# P15.9-A2 — Production Company Cockpit cutover

## Scope and operator decision

Owner authorized switching PAIR Next to the modern /app UI. This code change
sets **production UI builds** to redirect legacy routes into /app, landing
at /app/company. It does **not** enable the Objective Auto Driver, alter
business data, change auth, or deploy a new build to a host.

## Semantics

- On `vite build` (import.meta.env.PROD === true), missing/unknown
  `localStorage["pair.legacy_redirect"]` redirects mapped legacy routes.
  `/` lands on `/app/company`.
- On Vite development server (PROD === false), absent/unknown preference
  stays legacy-first. Existing legacy E2E tests continue as before.
- Explicit `"app"` forces modern UI, including dev; explicit `"legacy"`
  disables redirects even in production. Other values use the build default.
- Mapped legacy deep links continue to preserve id, search and hash.
  Unmapped `/ui` stays untouched.
- `/app` already redirects to `/app/company`.

## Rollback

In browser DevTools Console on PAIR Next:

```js
localStorage.setItem("pair.legacy_redirect", "legacy");
location.assign("/");
```

To return to the production default:

```js
localStorage.removeItem("pair.legacy_redirect");
location.assign("/");
```

This preference does not remove operator/token/business/theme keys. To
roll back **for all users**, revert the route cutover commit and redeploy
the previous UI bundle. Source rollback cannot undo a deployed binary
without redeployment.

## Acceptance and deployment gates

- Execute `pnpm --dir apps/mission-control-ui typecheck` and
  `pnpm --dir apps/mission-control-ui build`.
- Playwright runs against `scripts/serve-mission-control.mjs` serving the
  **built `dist` bundle** (`webServer` in `playwright.config.ts`) — every
  spec therefore exercises production-build semantics, never the Vite dev
  server. An absent preference redirects mapped legacy routes to `/app/*`
  and `/` to `/app/company`; tests that exercise the classic tree seed
  `pair.legacy_redirect="legacy"` explicitly, which is also the real
  production rollback path. Vite dev stays legacy-first as a local
  workflow property and is not what this harness measures.
- Executed on this branch (production `dist`, bundled Chromium):
  `b6-acceptance.spec.ts` 8/8 — default redirect, every mapped route,
  dynamic mission id + query + hash preserved in one hop with no
  redirect loop, `/ui` untouched, flag removal restores the default, and
  the `"legacy"` override keeps classic routes. Full suite: 193/217 pass;
  the remaining failures are pre-existing baseline (see below).
- **Known baseline (reproduces identically on BASE `bdeae5a`):** 22
  failures need a mission minted via `/api/missions/preview`, which fails
  closed `FAIL_CLOSED_PLANNER_NO_ELIGIBLE` — the Planner Pool is
  mandatory since Phase C (`c7c280f` removed the `PAIR_MC_TEMPLATE_PLANNER`
  bypass) and the e2e environment configures no eligible `codex-cli`
  planner. 1 further failure (`system.spec.ts` "Route decisions" heading)
  transitively needs minted-mission routing data. Fixing this means a
  test-only planner seam in production code — deliberately out of scope.
- Run `npm run verify:change -- --base bdeae5aa651cbfb586ed23a1dd09ff448dda0730`
  and obtain READY_FOR_INDEPENDENT_AUDIT.
- Independent audit before merge under AGENTS.md; deploy the new UI
  dist bundle to the PAIR host only after merge, and verify the server
  serves the updated bundle.

## Known P15.9-B6 CONDITIONAL items

Four technical read panes (Health, Metrics, Experience, Self-Improvement)
are still available as API endpoints/no-staticDir compatibility, not ported
to the React UI. Inherited SSE token-in-query and the deferred axe-core
automated audit remain follow-up decisions. No claim that these have been
closed by the cutover.
