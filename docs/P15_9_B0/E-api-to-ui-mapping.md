# E — API-to-UI Mapping

Source of truth rules: UI reads canonical projections only; every mutation
goes through an existing POST with the SAME authority contract
(`x-operator-id` → actor, Bearer MC token → transport); UI invents no
permissions; every API error code renders via the gloss convention (C.6).

## E.1 Company Cockpit

| Component | API | Authority / error states |
|---|---|---|
| Business switcher | NO owner-scoped list exists — `/api/businesses` is **unfiltered** (never enumerate as "my companies") | seed = last-used/manual `business_id` (localStorage), then prove via `/company`; empty/denied → DeniedState. Owner-scoped enumeration = API_MISSING (E.6) |
| Stat chips + objective cards + pending count | `GET /api/vnext/businesses/:id/company` | owner-scoped (`owner_authority_id`); 403 `FAIL_CLOSED_COMPANY_SCOPE` → DeniedState; counts are exact (`objectives_owned`, `targets_met_pending`); KPI cards show `canonically_proven` chips verbatim |
| Needs-you lane (reviews lane) | `objectives[].latest_review.owner_action_required` + `objectives[].status` | company-side flag is FRESH (pin-checked); only API-pending rows count (stale pins already excluded server-side) |
| Approvals lane | `GET /api/approvals` | **global queue**, not business-scoped — displayed labeled "all pending approvals" |
| HALT lane | **unavailable** — company summaries carry NO `auto_policy` field and no enumeration route exists — **API_MISSING** (see E.6) | lane renders an unavailable/partial-information explanation; NEVER a count, a badge component, or any claim that policies were scanned |
| Activity feed | **API_MISSING** — global `/api/events` is unscoped; R1 audit forbids it as company feed | until a scoped route exists: "recent reviews" fallback list |

## E.2 Objective Detail

| Component | API | Authority / error states |
|---|---|---|
| Header (title/status/terms/deadline) | `GET /api/vnext/objectives/:id/cockpit` | owner-scoped; 403 `FAIL_CLOSED_COCKPIT_AUTHORITY` → DeniedState |
| KPI bars | `objective.kpis[]` | `assessment` + `canonically_proven` verbatim; UNVERIFIED → `--unknown` chip |
| Budget | `objective.budget` | `canonically_proven:false` → "claimed, not proven" gloss; aggregate display only — ledger-row drill-down is API_MISSING (E.6) |
| Lifecycle band | `lifecycle` block | CANDIDATE vs ACHIEVED vs MET distinction normative |
| Workstreams → child → mission | `workstreams[]` + `missions[]` | `completion_proven` verbatim; mission link → `/app/missions/:id` |
| Artifacts | `artifacts[]` + `artifacts_dropped_unverified` | verified-only list + drop counter chip |
| Reviews list | `latest_review` + `GET /api/vnext/objectives/:id/reviews?limit=` | `lifecycle.owner_action_required` = FRESH (pin-checked vs current terms/digest); `latest_review.owner_action_required` (cockpit) and `owner_action_required` per `/reviews` history row = historical flags — history tab shows them, pending counts never use them (same field name, different semantics) |
| `observation_error` | same payload | UnverifiedPanel replaces verified-claim sections |
| `expiry_pending` | `auto_policy` block | warn chip, advisory only |
| Run CEO pass | `POST /api/vnext/objectives/:id/ceo-cycle` | existing contract; ConfirmDialog states it's a real CEO call |
| Auto policy controls | `GET/POST /api/vnext/objectives/:id/auto-policy` | existing; idempotency_key generated client-side |
| Accept ACHIEVED / Amend | **API_MISSING (A2)** — buttons render disabled with gloss "owner routes ship in A2" | never fake-disabled without explanation |

## E.3 CEO Workspace

| Component | API | Notes |
|---|---|---|
| Pass outcome | `POST …/ceo-cycle` response (latest) | CEO pass outcome is a separate source from review outcomes — never conflate |
| Decisions/reviews | `GET …/reviews` | review rows carry `source_ceo_decision_id`/`strategy_revision_id` (there is no `ceo_decision_id` field); no dedicated decisions endpoint → decisions tab lists reviews only (**API_MISSING marker**) |
| Manual pass | `POST …/ceo-cycle` | same as detail page |

## E.4 AI Workforce

| Component | API | Notes |
|---|---|---|
| Agent list | `GET /api/org-agents` — **UNFILTERED** (verified: no `?business_id` handling) | rows filtered client-side by `business_id` inside the selected business; never claim server-enforced scope; server-side filter = API_MISSING (E.6) |
| Agent detail: contract, effective policy | `GET /api/org-agents/:id/effective-policy`, `…/contract` | read modes exist |
| Agent inbox | `GET /api/org-agents/:id/inbox` | exists |
| Work items (per agent / per business) | `GET /api/work-items`, `GET /api/businesses/:id/work-graph` | exists |
| pause/resume/terminate, contract write | existing POSTs | ConfirmDialog; authority unchanged |

## E.5 Owner Inbox

| Lane | API | Notes |
|---|---|---|
| Reviews pending | `GET /api/vnext/businesses/:id/company` → `targets_met_pending` (exact count across ALL owned) + `objectives[].latest_review.owner_action_required` rows (fresh pins — different semantics than cockpit `latest_review`) | count truthful; item list bounded to ≤200 summaries → label when `objectives_truncated` |
| Approvals | `GET /api/approvals` + approve/deny | global queue, not business-scoped — labeled |
| Halts | **unavailable** — no `auto_policy` in summaries, no enumeration route | **API_MISSING** (E.6); lane shows explanation only — no count, no scan claim |

## E.6 API_MISSING register (backend gaps the design needs — not built in B)

| Capability | Needed by | Proposal class |
|---|---|---|
| A2 owner routes: `POST /vnext/objectives/:id/transition` (ACHIEVED/INFEASIBLE/CANCELLED), `POST …/amend` | Inbox accept/actions, Detail controls | Separate PR — approved in principle at A1 |
| Business-scoped activity feed (scoped SSE or paged events filtered by business/objective with auth) | Cockpit activity lane | New read route; must NOT reuse global `/api/events` |
| Aggregate policy-state enumeration (all owned objectives' auto_policy in one call) | Cockpit + Inbox HALT lane | New read route or fold into `/company` payload |
| CEO decision browse endpoint | CEO Workspace | Optional; reviews already carry decision ids |
| Real login/session, multi-tenant isolation | Global | Out of scope — contract stays MC-token + operator-id; **never claimed** |
| Owner-scoped business enumeration | Business switcher | New read route; until then switcher seeds business_id from remembered/manual input |
| Business-scoped approvals queue | Inbox | New read route; until then global queue shown labeled |
| Server-side `business_id` filter on `/api/org-agents` | Workforce | New query handling; until then client-side filter, labeled |
| Budget ledger row drill-down (`runtime.ledger()` exposure) | Objective Detail budget band | New read route; aggregate only until then |
| HALT enumeration across owned objectives | Inbox badge + HALT lane | Fold into `/company` or dedicated route; until then partial-scoped, labeled |

## E.7 Global rules verified

- `x-operator-id` = ONLY actor source **for the new vnext routes** — verified:
  cockpit routes require the header and reject with
  `FAIL_CLOSED_OPERATOR_ID_REQUIRED` otherwise. Legacy routes also accept a
  `body.operator_id` fallback; the new UI never uses body-field actors and
  seeds the header once in Settings; every request carries it. No
  multi-tenant security claim beyond this verified contract.
- 401 → Settings screen with token field (replaces `window.prompt`; the
  prompt fallback may stay for old app parity but new shell prefers the page).
- No raw rows: UI maps only documented payload fields; unknown fields ignored.
- Every mutation button = ConfirmDialog with the canonical verb + expected
  server outcome; optimistic UI forbidden — re-fetch canonical state after
  POST.
- Read paths may never trigger writes client-side either (no
  "auto-refresh that calls ceo-cycle" — R1 lesson applied to UI).
