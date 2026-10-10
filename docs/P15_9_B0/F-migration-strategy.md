# F — Migration Strategy

## F.1 Hard rules (from mandate + audit history)

- Do NOT replace `/` immediately. Old UI keeps working during development.
- New UI ships behind a separate route prefix `/app/*` inside the SAME SPA
  bundle — one build, two route trees sharing one Layout-agnostic shell.
- Cutover happens only after acceptance (H) — and is a deployment config
  choice (which route the root serves), not a code rewrite.
- No business logic duplicated in frontend: the new pages call the same
  canonical endpoints; components are new, logic isn't reimplemented.
- Legacy `UI_HTML` is reachable ONLY on a server run **without** `staticDir`
  (bare-server mode) — verified: with `staticDir` active, `/ui` falls back to
  `index.html` and serves the SPA. Simultaneous access to legacy HTML is NOT
  possible in the SPA deployment; until admin is ported, a second
  no-`staticDir` instance is the only way to reach it, and porting those
  capabilities is a hard cutover precondition (H), not a nicety.
- Rollback = revert to serving the old route tree / old staticDir. The old
  code paths are never deleted inside a feature PR.

## F.2 Route coexistence plan

```ts
createBrowserRouter([
  { element: <LegacyLayout/>, children: [ /* today's routes verbatim */ ] },
  { element: <AppShell/>,    children: [ path: "/app/*" → new tree    ] },
]);
```

- `AppShell` = new sidebar shell (C.4). `LegacyLayout` = current `Layout.tsx`.
- Zero redirects added during B-phase; `/` keeps serving Dashboard.
- Cutover = make `/` render `<Navigate to="/app/company">` OR point
  `staticDir` at a build where the trees are swapped — decision deferred to
  the cutover PR after H acceptance (Owner decision recorded at A1: no `/`
  → `/company` redirect at A1; the same caution applies at cutover).

## F.3 Static-serving / build facts (verified)

- Server serves `deps.staticDir` if present; falls back to `UI_HTML` at
  `/` & `/ui` ONLY when `staticDir` is unset. With `staticDir` set, `/ui`
  resolves no file → SPA `index.html` fallback. Non-API GETs get SPA
  fallback — deep links work.
- New `/app/*` deep links work through the SAME fallback — no server change.
- The UI bundle lives in `apps/mission-control-ui` (pnpm workspace); no new
  dependency allowed at B0; router version already supports nested routes.

## F.4 Session/auth continuity

- `pair.mc_token` + `pair.operator_id` in localStorage — the new shell reads
  the SAME keys, so a logged-in operator doesn't re-auth between old/new.
- Settings page edits the same keys; logout clears both.

## F.5 Functional-parity tracking

The preservation matrix (A.5) becomes a checkbox list in the acceptance PR:
every old-route capability is listed with "ported verbatim / moved /
intentionally dropped (needs Owner sign-off)". Nothing is silently dropped —
`UI_HTML` business-admin functions are the main porting debt (org-agents,
work-items create/actions).

## F.6 Incremental PR strategy

Each roadmap PR (G) ships real value behind `/app/*`: reviewers can open
`/app/company` beside `/` in production during review — the safest possible
comparison. e2e covers old routes in every PR (no-regression) plus the new
route added.

## F.7 Risks specific to migration

| Risk | Mitigation |
|---|---|
| Two shells diverge (old edited, new forgotten) | Old pages are frozen — no new features land there; fixes go to new shell only except critical bugs |
| `UI_HTML` still sole admin UI at cutover (unreachable in SPA deployment — needs second bare-server run) | Workforce/System admin pages are an acceptance gate (H); if parity isn't met, keep a documented second no-`staticDir` instance — never silently lose the admin surface |
| Deep-link 404s on old bookmarks | `/missions/:id` etc. keep working during coexistence; cutover adds redirects |
| localStorage key conflict | Same keys by design (F.4); new shell never writes new session semantics |
| SSE global stream temptation for company feed | Explicitly forbidden (E.6); feed waits for scoped endpoint |
