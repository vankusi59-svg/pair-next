# A — Current UI Audit

Baseline: `staging/pr59-safe` @ `2232955` (post PR #91).

## A.1 Two UIs exist today

1. **React SPA** — `apps/mission-control-ui` (Vite + react-router-dom), served
   statically when `deps.staticDir` is set; deep-link fallback serves the SPA
   for any non-`/api` GET. This is the production operator UI.
2. **Legacy `UI_HTML`** — a ~250-line server-rendered single-page app embedded in
   `src/pair/mission-control-server.ts` (served at `/` and `/ui` when no
   `staticDir`). It implements Business/org-agent/work-item CRUD inline
   (`mkBiz`, `mkAg`, `mkWi`, `openWi`, `wiBlock`, …). It is the ONLY UI today
   that can create businesses, org agents, and work items — capabilities the
   React SPA never gained.

> Audit consequence: the migration plan must port the business-admin capabilities
> out of `UI_HTML` into the new UI (or declare them intentionally dropped), and
> the SPA must keep deep-link serving behavior.

## A.2 Route/page inventory (React SPA)

| Route | Page | Data calls used | Notes |
|---|---|---|---|
| `/` | `Dashboard.tsx` | `missions`, `routing`, `approvals`, `cost` | Mission table + counters; company-blind. |
| `/missions/new` | `MissionNew.tsx` | `projects`, `previewMission`, `startMission` | Golden path: preview→confirm→run. |
| `/missions/:id` | `MissionDetail.tsx` | `missionDetail`, `missionDag`, `timeline`, `evidence`, `missionFiles`, `missionFile`, `missionAction` | Deepest page; pause/resume/cancel/acknowledge. |
| `/approvals` | `Approvals.tsx` | `approvals`, `approve`, `deny` | Flat table of pending approvals. |
| `/schedules` | `Schedules.tsx` | `schedules`, `projects`, `createSchedule`, `scheduleAction` | CRUD-lite for mission schedules. |
| `/providers` | `Providers.tsx` | `providers`, `models`, `routes` | Provider/model/route cards. |
| `/observability` | `Observability.tsx` | `recovery`, `routes`, `missions`, `evidence` | Recovery + route decisions + evidence tail. |
| `/objectives` | `Objectives.tsx` | `businesses`, `vnextObjectives`, `vnextObjective`, `createVnextObjective`, `runCeoCycle`, `autoPolicyStatus`, `autoPolicyControl` | Only business-facing page: objective list/create per business, inline detail, manual CEO pass, auto-policy controls. No route — a single page does everything. |
| `/chat` | `Chat.tsx` | conversations + drafts + turns + `projects` | Conversation layer with mission-draft proposal/confirm flow. |

**Components**: `Layout.tsx` (top-bar nav + theme toggle + operator-id input),
`Badge.tsx`, `Dag.tsx`, `Timeline.tsx`, `Toast.tsx`.
**Hooks/lib**: `useApi`, `eventBus` (SSE `/api/events` subscriber),
`objective-display`.
**Styles**: single `app.css` (~157 lines), `data-theme` light/dark on `<html>`.
**e2e**: Playwright `smoke.spec.ts` (dashboard nav, preview→confirm, stream),
`chat.spec.ts`; `helpers.ts` seeds `pair.mc_token` + `pair.operator_id` via
`addInitScript` against a real server on :8790.

## A.3 Backend contract inventory (what exists to build on)

Full API surface verified in `mission-control-server.ts`:

- **Mission ops**: missions CRUD-ish reads, preview, confirm, pause/resume/
  cancel/acknowledge/reconcile, dag, timeline, evidence, files.
- **Approvals/promotions**: list + approve/deny, promotion approve/reject.
- **Business plane**: businesses, org-agents (+contract, enable/disable,
  effective-policy, inbox), work-items (full lifecycle verbs), work-graph,
  routines, legacy objectives.
- **vNext objectives**: list/get/create, `ceo-cycle`, `kpi-verification`,
  `auto-scheduler`, `auto-driver`, `auto-policy` (GET status + POST control).
- **P15.9-A1 cockpit (merged PR #91, owner-scoped read-only)**:
  `GET /api/vnext/objectives/:id/cockpit`, `/reviews?limit=`,
  `GET /api/vnext/businesses/:id/company`.
- **Workforce messages**, **schedules**, **cost** (+policies/profiles),
  **secret-policies**, **credentials**, **budgets**, **conversations**
  (+messages/turns/drafts/confirm/reject/close), **events SSE**, **artifacts**,
  **telegram-deliveries**, **tick**, **health/metrics**, **experience/selfmod**.

## A.4 UX problems found

1. **Navigation is technical**: top-bar lists internal concepts
   (Providers/Observability/Task Entry) — nothing reflects the business the
   owner is running.
2. **No company home**: `/` shows missions, not businesses/objectives/KPIs.
3. **Objectives page overload**: list + create + detail + policy controls all
   inline on one route; no deep-linkable Objective Detail; no workstream /
   mission / artifact / review visibility (the very data the cockpit API now
   proves).
4. **No owner inbox**: `TARGET_MET_CANDIDATE` + `owner_action_required` reviews
   are invisible; the operator must know to look. Approvals page covers
   permission approvals only, not objective reviews.
5. **No workforce view**: org agents / work items / allocations exist via API
   but have zero SPA presence (only legacy `UI_HTML` covers them).
6. **State language gap**: no badge distinguishes *proven* vs *claimed* vs
   *unverifiable* data — a hard requirement after the R1–R3c audit contract
   (`canonically_proven` flags exist but nothing renders them).
7. **Auth UX is a `window.prompt`** on 401 with a 5s throttle; operator id is a
   free-text input in the top bar — functional but primitive.
8. **Legacy `UI_HTML` divergence**: business admin lives only there; two UIs
   answering different questions creates confusion about which is real.
9. **Mobile**: top-bar wraps poorly; tables overflow; no responsive breakpoint
   design in `app.css` (single file, no grid/breakpoint system).
10. **No empty/unauthorized/unverified state vocabulary** — each page improvises.

## A.5 Functional preservation matrix

Everything the React SPA does today must keep working after redesign (full list
in H-acceptance-matrix). Highlights that constrain the new shell:

- Golden path: `/missions/new` preview→confirm→run must keep working verbatim.
- Mission actions (pause/resume/cancel/acknowledge) — keep.
- Chat turn → mission-draft proposal → confirm/reject — keep.
- Operator-id + MC-token session model — keep the SAME contract
  (`x-operator-id` header, Bearer token); the new UI may improve the login UX
  but must not invent new auth semantics.
- SSE `/api/events` subscription via `eventBus` — keep; a company-scoped feed
  must NOT reuse the global stream (see E).
- Legacy `UI_HTML` route `/ui` — keep reachable until cutover acceptance.

## A.6 Feature classification

| Capability | Class |
|---|---|
| Mission submit/preview/detail/actions/files/evidence | **EXISTS** (SPA) |
| Approvals + promotions decide | **EXISTS** (SPA) |
| Providers/models/routes/routing/recovery views | **EXISTS** (SPA) |
| Schedules CRUD | **EXISTS** (SPA) |
| Conversations + mission drafts | **EXISTS** (SPA) |
| vnext objective list/create + CEO pass + auto-policy controls | **EXISTS** (SPA, crude) |
| Business/org-agent/work-item admin | **EXISTS** (legacy `UI_HTML` only — must port) |
| Company dashboard (business + objective summaries + pending inbox) | **API_READY** — `GET /api/vnext/businesses/:id/company` |
| Objective detail (KPI proof, budget, workstreams, missions, artifacts, reviews) | **API_READY** — `GET /api/vnext/objectives/:id/cockpit` |
| Review history page | **API_READY** — `GET /api/vnext/objectives/:id/reviews` |
| Workforce view (org agents, work items, inbox, effective policy) | **API_READY** — existing `/api/org-agents`, `/api/work-items`, `/api/businesses/:id/work-graph` |
| Owner approve/transition objective (CANDIDATE→ACHIEVED), amend | **API_MISSING** — A2 routes approved-in-principle, separate PR |
| Scoped company activity feed | **API_MISSING** — global `/api/events` SSE is unscoped; needs scoped filter route |
| Real session/login, multi-tenant isolation | **API_MISSING** — same MC-token contract as today; must not be claimed |
| CEO decision history browsing | **API_READY-partial** — reviews carry `ceo_decision_id` links; a dedicated decisions endpoint does not exist |
| Budget ledger drill-down per objective | **API_READY** — `consumed_microusd` + `canonically_proven` in cockpit |
| Owner automation console (auto-policy across all owned objectives) | **API_READY-partial** — per-objective `auto-policy` endpoints exist; a cross-objective enumeration endpoint does not |
| P18 cross-objective coordination UI | **FUTURE** |
| Telegram conversation surface | **FUTURE** (explicitly out of scope) |
