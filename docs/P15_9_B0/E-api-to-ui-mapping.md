# E — API-to-UI Mapping

Source of truth rules: UI reads canonical projections only; every mutation
goes through an existing POST with the SAME authority contract
(`x-operator-id` → actor, Bearer MC token → transport); UI invents no
permissions; every API error code renders via the gloss convention (C.6).

## E.1 Company Cockpit

| Component | API | Authority / error states |
|---|---|---|
| Business switcher | `GET /api/businesses` | operator-scoped list; empty → EmptyState "create business" (links to System admin) |
| Stat chips + objective cards + pending count | `GET /api/vnext/businesses/:id/company` | owner-scoped (`owner_authority_id`); 403 `FAIL_CLOSED_COMPANY_SCOPE` → DeniedState; counts are exact (`objectives_owned`, `targets_met_pending`); KPI cards show `canonically_proven` chips verbatim |
| Needs-you lane (reviews lane) | same payload, `latest_review.owner_action_required` + `objectives[].status` | only API-pending rows count (stale pins already excluded server-side) |
| Approvals lane | `GET /api/approvals` | existing contract |
| HALT lane | per-objective `auto-policy` status — **API_MISSING for cross-objective enumeration** (see E.6) | render per-card from company payload where policy state isn't in the response → drill to detail; document gap |
| Activity feed | **API_MISSING** — global `/api/events` is unscoped; R1 audit forbids it as company feed | until a scoped route exists: "recent reviews" fallback list |

## E.2 Objective Detail

| Component | API | Authority / error states |
|---|---|---|
| Header (title/status/terms/deadline) | `GET /api/vnext/objectives/:id/cockpit` | owner-scoped; 403 `FAIL_CLOSED_COCKPIT_AUTHORITY` → DeniedState |
| KPI bars | `objective.kpis[]` | `assessment` + `canonically_proven` verbatim; UNVERIFIED → `--unknown` chip |
| Budget | `objective.budget` | `canonically_proven:false` → "claimed, not proven" gloss |
| Lifecycle band | `lifecycle` block | CANDIDATE vs ACHIEVED vs MET distinction normative |
| Workstreams → child → mission | `workstreams[]` + `missions[]` | `completion_proven` verbatim; mission link → `/app/missions/:id` |
| Artifacts | `artifacts[]` + `artifacts_dropped_unverified` | verified-only list + drop counter chip |
| Reviews list | `latest_review` + `GET /api/vnext/objectives/:id/reviews?limit=` | `owner_action_required` server-filtered (pin-fresh) |
| `observation_error` | same payload | UnverifiedPanel replaces verified-claim sections |
| `expiry_pending` | `auto_policy` block | warn chip, advisory only |
| Run CEO pass | `POST /api/vnext/objectives/:id/ceo-cycle` | existing contract; ConfirmDialog states it's a real CEO call |
| Auto policy controls | `GET/POST /api/vnext/objectives/:id/auto-policy` | existing; idempotency_key generated client-side |
| Accept ACHIEVED / Amend | **API_MISSING (A2)** — buttons render disabled with gloss "owner routes ship in A2" | never fake-disabled without explanation |

## E.3 CEO Workspace

| Component | API | Notes |
|---|---|---|
| Pass outcome + decisions/reviews | `GET …/cockpit` + `GET …/reviews` | review rows carry `ceo_decision_id`/`strategy_revision_id`; no dedicated decisions endpoint → decisions tab lists reviews only (**API_MISSING marker**) |
| Manual pass | `POST …/ceo-cycle` | same as detail page |

## E.4 AI Workforce

| Component | API | Notes |
|---|---|---|
| Agent list | `GET /api/org-agents` (+ `?business_id`) | EXISTS via legacy UI only — port |
| Agent detail: contract, effective policy | `GET /api/org-agents/:id/effective-policy`, `…/contract` | read modes exist |
| Agent inbox | `GET /api/org-agents/:id/inbox` | exists |
| Work items (per agent / per business) | `GET /api/work-items`, `GET /api/businesses/:id/work-graph` | exists |
| pause/resume/terminate, contract write | existing POSTs | ConfirmDialog; authority unchanged |

## E.5 Owner Inbox

| Lane | API | Notes |
|---|---|---|
| Reviews pending | `GET /api/vnext/businesses/:id/company` → `targets_met_pending` + per-objective `latest_review` | single call per business; drill → detail |
| Approvals | `GET /api/approvals` + approve/deny | ported verbatim |
| Halts | auto-policy GET per owned objective | bounded to owned list; **API_MISSING** aggregate endpoint (E.6) |

## E.6 API_MISSING register (backend gaps the design needs — not built in B)

| Capability | Needed by | Proposal class |
|---|---|---|
| A2 owner routes: `POST /vnext/objectives/:id/transition` (ACHIEVED/INFEASIBLE/CANCELLED), `POST …/amend` | Inbox accept/actions, Detail controls | Separate PR — approved in principle at A1 |
| Business-scoped activity feed (scoped SSE or paged events filtered by business/objective with auth) | Cockpit activity lane | New read route; must NOT reuse global `/api/events` |
| Aggregate policy-state enumeration (all owned objectives' auto_policy in one call) | Cockpit + Inbox HALT lane | New read route or fold into `/company` payload |
| CEO decision browse endpoint | CEO Workspace | Optional; reviews already carry decision ids |
| Real login/session, multi-tenant isolation | Global | Out of scope — contract stays MC-token + operator-id; **never claimed** |

## E.7 Global rules verified

- `x-operator-id` = ONLY actor source (never a body field); the UI seeds it
  once in Settings; every request carries it.
- 401 → Settings screen with token field (replaces `window.prompt`; the
  prompt fallback may stay for old app parity but new shell prefers the page).
- No raw rows: UI maps only documented payload fields; unknown fields ignored.
- Every mutation button = ConfirmDialog with the canonical verb + expected
  server outcome; optimistic UI forbidden — re-fetch canonical state after
  POST.
- Read paths may never trigger writes client-side either (no
  "auto-refresh that calls ceo-cycle" — R1 lesson applied to UI).
