# A — Current UI Audit

Baseline: `staging/pr59-safe` @ `2232955` (post PR #91).

## A.1 Two UIs exist today

1. **React SPA** — `apps/mission-control-ui` (Vite + react-router-dom), served
   statically when `deps.staticDir` is set; deep-link fallback serves the SPA
   for any non-`/api` GET. This is the production operator UI.
2. **Legacy `UI_HTML`** — a ~250-line server-rendered single-page app embedded in
   `src/pair/mission-control-server.ts` (served at `/` and `/ui` **only when
   `deps.staticDir` is unset**). It implements Business/org-agent/work-item CRUD
   inline (`mkBiz`, `mkAg`, `mkWi`, `openWi`, `wiBlock`, …). It is the ONLY UI
   today that can create businesses, org agents, and work items — capabilities
   the React SPA never gained.

   **Verified serving behavior (design review R1):** when `staticDir` is set,
   `tryStatic("/ui")` finds no file and falls back to `index.html` — `/ui`
   serves the **SPA**, not `UI_HTML`. The legacy HTML UI is only reachable on a
   server run *without* `staticDir` (bare-server mode). Do not promise
   simultaneous access to legacy HTML in the SPA deployment: today that means
   running a second no-`staticDir` instance; long-term it means porting the
   admin capabilities (porting debt is a cutover precondition, not optional).

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

**Scope boundaries (verified R1 — no multi-tenant claims):**
- `GET /api/businesses` → `biz.listBusinesses()` **unfiltered** — NOT an
  owner-scoped list; never use it to enumerate "owner's businesses".
- `GET /api/approvals` → `c.approvals()` **global queue**, not business-scoped.
- `GET /api/org-agents` → `biz.listOrgAgents()` **unfiltered** — the route does
  NOT implement a `?business_id` query filter.
- Actor source split: legacy routes derive `operator` = `x-operator-id` header
  **with `body.operator_id` fallback**; the new `/api/vnext/*` cockpit routes
  require the **header only** and reject otherwise
  (`FAIL_CLOSED_OPERATOR_ID_REQUIRED`).
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
- Legacy `UI_HTML` — reachable ONLY on a no-`staticDir` server run; in the SPA
  deployment `/ui` already serves the SPA. Preservation = keep the code path +
  document the operating mode; porting admin features is required before
  declaring parity.

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
| Review history page | **API_READY** — `GET /api/vnext/objectives/:id/reviews` (per-row `owner_action_required` is a *historical* flag; fresh actionable pending = `company.objectives[].latest_review.owner_action_required` (pin-checked) + `cockpit.lifecycle.owner_action_required`; cockpit's own `latest_review.owner_action_required` is the raw historical flag — same name, different semantics per surface) |
| Workforce view (org agents, work items, inbox, effective policy) | **API_READY-partial** — `/api/org-agents` returns ALL agents (no business filter); `/api/work-items`, `/api/businesses/:id/work-graph` are business-scoped; filter client-side within the selected business's work-graph, not via org-agents query |
| Owner approve/transition objective (CANDIDATE→ACHIEVED), amend | **API_MISSING** — A2 routes approved-in-principle, separate PR |
| Scoped company activity feed | **API_MISSING** — global `/api/events` SSE is unscoped; needs scoped filter route |
| Owner-scoped business enumeration ("my companies") | **API_MISSING** — `/api/businesses` is unfiltered; switcher must seed business_id from remembered/manual entry then prove via `/company` |
| Business-scoped approvals queue | **API_MISSING** — approvals are global; inbox shows the global queue honestly labeled |
| Real session/login, multi-tenant isolation | **API_MISSING** — same MC-token contract as today; must not be claimed |
| CEO decision history browsing | **API_READY-partial** — reviews carry `source_ceo_decision_id` links; a dedicated decisions endpoint does not exist |
| Aggregate budget display per objective | **API_READY** — `consumed_microusd` + `canonically_proven` in cockpit |
| Budget ledger row drill-down | **API_MISSING** — `runtime.ledger()` exists internally but no route exposes ledger rows |
| Owner automation console (auto-policy across all owned objectives) | **API_READY-partial** — per-objective `auto-policy` endpoints exist; a cross-objective enumeration endpoint does not |
| P18 cross-objective coordination UI | **FUTURE** |
| Telegram conversation surface | **FUTURE** (explicitly out of scope) |
