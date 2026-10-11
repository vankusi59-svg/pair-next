# P15.9-B6 — Authority / Security / Data-Truthfulness Review

## F1 — Business scope honesty

- Selected `business_id` is a **view selection, never ownership proof**. Server-side scoping is absent where the API is global — the UI says so.
- `BusinessAdmin` "Global business list" and `WorkforceAdmin` agent table carry explicit labels: `GET /api/org-agents — a global, unfiltered read filtered client-side … This is NOT server-side authorization.` (verified in page text + tests).
- `SystemObservability` stream labeled global; no page fabricates an owner-scoped feed (`API_MISSING` entries in B0-E§6 stay labeled, never faked).
- `SystemSchedules` labeled "no per-owner authorization" + UTC cron.

## F2 — Operator/auth continuity

- HTTP API transport unchanged: `pair.mc_token` → `Authorization: Bearer` header, `pair.operator_id` → `x-operator-id` header. No new auth surface was added in B6.
- Token never rendered after save (masked input; only `configured/unconfigured` indicator); never written to logs or DOM attributes.
- **Inherited limitation — SSE token-in-query (B6 R1-F2 correction):** `EventSource` cannot send custom headers, so `eventBus.ts` passes `withTokenQuery("/api/events")` → the token travels as `?token=…` in the SSE request URL. This pattern predates B6 (shared SSE transport; the legacy code path uses the same `withTokenQuery` helper). Exposure: the token may appear in HTTP request logs / proxy logs / browser history-like URL records wherever request URLs are recorded. The UI does **not** guarantee token secrecy for the SSE leg — an honest limitation, recorded here rather than claimed away. Changing SSE authentication architecture (e.g. cookie session, backend header bridge, short-lived stream token) is out of B6 scope and requires a separate authorized security decision.
- `pair.theme` key preserved; theme toggle goes through `localStorage` source-of-truth + `pair.theme-changed` (B5.5 R1-F2) — same-tab consumers converge, no loop.
- Credential change (`pair.operator-changed`, `pair.credentials-changed`) invalidates stale reads: `InboxCountsProvider` epoch guard drops old-credential resolutions at the render boundary; `reconnectStream()` clears the SSE buffer of old-token-authenticated events before re-creating the single shared EventSource (B5.5 R1-F3, e2e proven).

## F3 — Canonical truthfulness

- No optimistic state anywhere: every mutation ends in canonical refetch; counters derive only from GET responses.
- `UNKNOWN`/unverified/malformed never renders as success: cost `hard_stop` strict-boolean → `unknown` for missing/malformed; `usd()` returns `unknown` for null/non-integer micro-USD (never fabricated `$0`); observation/`observation_error` surfaces as danger, not pass; stream `unavailable`/`reconnecting` labeled, never faked `live`.
- Cross-identity/stale paint blocked by pinned-session/operator gates (Chat, Inbox counts, mission evidence explorer — AbortController + generation guards).
- Malformed API payloads → labeled error state, never empty-fallback masquerading as real data.

## F4 — Mutation boundaries (full inventory, all pre-existing seams)

| UI action | POST seam | Confirm | Single-flight | Verified by |
|---|---|---|---|---|
| approve/deny (no-prompt) | `/api/approvals/:id/approve|deny` | pinned `approval_id` + lane context | yes | inbox-ceo.spec |
| policy halt commit | `/api/objectives/:id/policy` | yes | yes | objectives.spec |
| CEO manual pass | `/api/ceo/cycle` | yes | yes | inbox-ceo.spec |
| auto-policy toggle | `/api/objectives/:id/auto-policy` | yes | yes | objectives.spec |
| work-item open/block/unblock/comment | `/api/work-items/:id/*` | open keeps governed-execution confirm | yes | workforce-admin.spec |
| routines create/enable/disable | `/api/routines*` | yes | yes | workforce-admin.spec |
| mission preview/confirm, actions | `/api/missions*` | pinned preview digest → confirm | yes | missions.spec |
| schedules create/toggle/delete | `/api/schedules*` | pinned `schedule_id` + consequence | yes | system.spec |
| chat turn/draft confirm/reject, close | `/api/conversations*`, `/drafts/:id/*` | digest-pinned confirm | yes | app-chat.spec |
| business/agent create | `/api/businesses`, `/api/org-agents` | yes | yes | workforce-admin.spec |

- **Zero writes on load/SSE/refresh** — mutation-counting catch-all routes in `system.spec.ts` and `workforce-admin.spec.ts` prove GET-only traffic outside deliberate clicks.
- No A2 mutation was implemented; no disabled Owner action was enabled.

## Secrets/credential hygiene

- Demo token `12` and operator `op:e2e` are e2e-seeded localStorage values only — never committed, never logged. No real secrets appear in docs, tests, or fixtures.
