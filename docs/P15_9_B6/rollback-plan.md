# P15.9-B6 — Rollback Procedure (documented only — not executed in B6)

The cutover mechanism is a browser-local opt-in flag; rollback is correspondingly simple. Three levels, cheapest first:

## Level 1 — per-browser instant rollback (seconds)

```
localStorage.removeItem("pair.legacy_redirect")   // or set to any value ≠ "app"
```

Reload. Every legacy route renders its legacy page again (proven by e2e `flag removal restores legacy behavior`). No data loss: `pair.mc_token`, `pair.operator_id`, `pair.theme`, `pair.business_id` are untouched — sessions, operator identity, theme and business selection persist across the toggle in both directions.

## Level 2 — code rollback of the redirect seam (minutes)

Revert the `OptInRedirect` wrappers in `apps/mission-control-ui/src/main.tsx` (single commit, self-contained — `legacyRedirectOn` + `OptInRedirect` + the 9 route wrappers). The legacy `Layout` tree and the `/app` tree are independent; removing the wrapper restores unconditional legacy rendering while leaving `/app` fully functional at its own URLs. Suggested revert commit: `git revert <b6-merge-sha>` for the main.tsx hunk only.

## Level 3 — full UI rollback to a pre-B1 build (hours, worst case)

Checkout the last pre-`B1` tag/commit of `apps/mission-control-ui`, `npm run build`, redeploy `dist/` through the existing static-serving seam (`deps.staticDir` unchanged — the backend always served whatever `dist/` contained, so no server config changes are needed). Credential keys are stable across all versions (`pair.mc_token`/`pair.operator_id` since the legacy UI), so nobody is logged out.

## Continuity checks after any rollback

- Deep links: legacy `/missions/:id` etc. resolve normally (nothing in rollback breaks legacy routing).
- localStorage keys: `pair.mc_token`, `pair.operator_id`, `pair.theme`, `pair.business_id`, `pair.legacy_redirect` — all browser-local; clearing `pair.legacy_redirect` is the only required action and is safe to leave stale (an unknown flag value is ignored by design).
- Static serving: `serve-mission-control.mjs` + `deps.staticDir` path unchanged by B6 — no server-side rollback exists because no server-side cutover exists.
- Verification after rollback: run `e2e/app.spec.ts` legacy-route tests + the B6 OFF-default test — they must pass identically with the flag removed.
