# P15.9-B6 — UI_HTML Administrative Parity Verdict

Source: `src/pair/mission-control-server.ts` `UI_HTML` (~L163–420). Reachability: served at `/` and `/ui` **only** when `deps.staticDir` is unset. In the shipped staticDir SPA deployment, `/ui` serves `index.html` and the UI_HTML document is not reachable — this is stated as a verified code-path fact, not an assumption (static-serving seam inspected; B6 e2e asserts `/ui` does not redirect into `/app`).

## B1 — Business administration

| UI_HTML capability | Backend seam | Modern equivalent | Verdict | Evidence |
|---|---|---|---|---|
| Create business (`mkBiz`: name, goal, metadata) | `POST /api/businesses` | `BusinessAdmin` "Create business" | ported + proven | `workforce-admin.spec.ts`; backend validation errors surface verbatim |
| Select business for scoped work | stored business id | AppShell `business_id` selector + BusinessAdmin list | ported + proven | `workforce-admin.spec.ts`, `app.spec.ts` |
| Inspect business (agents/objectives/routines/work-items bundle) | GET bundle | `BusinessAdmin` "Inspect a business" | ported + proven | `workforce-admin.spec.ts` |
| Global business registry | `GET /api/businesses` | `BusinessAdmin` "Global business list" — **labeled** global/unfiltered | ported + proven | `workforce-admin.spec.ts`; label verified in-page |
| Canonical error surfacing | error envelopes | `StatusBadge danger` + `.note` raw code/detail | ported + proven | across suites |

## B2 — Org-agent administration

| UI_HTML capability | Backend seam | Modern equivalent | Verdict | Evidence |
|---|---|---|---|---|
| Create agent (`mkAg`: business_id, title, department) | `POST /api/org-agents` | `WorkforceAdmin` "Create org agent" | ported + proven | `workforce-admin.spec.ts` |
| Business association | field on create + per-business list | create binds `business_id`; scoped selection via business selector | ported + proven | same |
| Dept/reporting constraints | backend-validated | fields passed verbatim; backend rejects shown | ported + proven | same (negative-path tests) |
| Lifecycle/contract view | GET rows | `WorkforceAdmin` agent table (status/contract cols) | ported + proven | same |
| Scoped selection (hide other businesses) | `GET /api/org-agents` is global | client-side filter + `filteredOut` count + explicit "NOT server-side authorization" note | ported + proven — labeling improved over UI_HTML (which showed the global list unlabeled) | page srcnote + tests |

## B3 — Work-item administration

| UI_HTML capability | Backend seam | Modern equivalent | Verdict | Evidence |
|---|---|---|---|---|
| Create work item (`mkWi`: business_id, title, goal) | `POST /api/work-items` | `WorkforceAdmin` "Create work item" | ported + proven | `workforce-admin.spec.ts` |
| Open (`openWi`) — **may trigger governed Mission execution** | `POST /api/work-items/:id/open` | WorkforceAdmin open — confirmation dialog kept; governed-execution warning text retained | ported + proven — runtime authority unweakened | `workforce-admin.spec.ts` (confirm + pinned id) |
| Block (`wiBlock` + reason) | `POST …/block` | row op + confirm | ported + proven | same |
| Unblock (`wiUnblock`) | `POST …/unblock` | row op + confirm | ported + proven | same |
| Comment (`wiCmt` + body) | `POST …/comment` | row op | ported + proven | same |
| Mission links | work item → mission | linked in work-item rows | ported + proven | same |
| Identity pinning | id shown on row | pinned `work_item_id` in confirm dialogs | ported + proven | same |

## B4 — Routines + legacy objectives

| UI_HTML capability | Backend seam | Modern equivalent | Verdict | Evidence |
|---|---|---|---|---|
| Routine create (`mkRt`: name, goal_template, cron) | `POST /api/routines` | `WorkforceAdmin` "Routines (legacy parity)" — labeled legacy | ported + proven | `workforce-admin.spec.ts` |
| Routine toggle (`rtTog`) | `POST /api/routines/:id/enable|disable` | enable/disable per row, labeled legacy-parity surface | ported + proven | same |
| Legacy objective create (`mkObj`) | `POST /api/objectives` | `WorkforceAdmin` "Legacy objectives (compat API)" — **labeled distinct from vnext objectives** | ported + proven | same |

## B5 — Technical read panes (B6 R1-F1, audited individually — distinct from admin parity)

The UI_HTML nav exposes 9 read panes, each a thin viewer over one GET (`mission-control-server.ts` L180–183). Admin mutations above are fully ported; the read panes split differently — **4 panes have no consumer in the entire React SPA** (verified by grep: `health(`, `metrics(`, `experience`, `selfmod`/`selfImprove` have zero callers under `src/app/` and `src/pages/`):

| Pane | Endpoint | Modern destination | Verdict |
|---|---|---|---|
| Missions | `/api/missions` | `/app/missions` + detail | ported + proven |
| Routing | `/api/routing` | `/app/system/observability` routing section | ported + proven |
| Recovery | `/api/recovery` | `/app/system/observability` recovery explorer | ported + proven |
| Approvals | `/api/approvals` | `/app/inbox` approvals lane | ported + proven |
| Business | `/api/businesses` | `/app/system/business-admin` + scoped `/app/company` | ported + proven |
| **Health** | `/api/health` | **none** | **NOT_PORTED** |
| **Metrics** | `/api/metrics` | **none** | **NOT_PORTED** |
| **Experience** | `/api/experience` | **none** | **NOT_PORTED** |
| **Self-Improvement** | `/api/selfmod` | **none** | **NOT_PORTED** |

These are technical operator views (subsystem health, runtime metrics, experience aggregates, selfmod status). They were never part of the React UI — only of UI_HTML. Porting them was deliberately not done in B6 (mandate: no new technical pages merely to green the matrix). **Supported alternative:** the endpoints remain live, and the no-staticDir operating mode below still serves the full UI_HTML document. Whether these panes are required in `/app` is an explicit Owner decision (C5 in cutover-preparation §H3).

## B6 — Verdict

Every UI_HTML **administrative** capability is **ported and proven** (`workforce-admin.spec.ts`, green in this branch's full regression). Of the **read panes**, 5/9 are ported and proven; **4 technical panes (Health, Metrics, Experience, Self-Improvement) are NOT_PORTED** — endpoints and the no-staticDir mode remain intact; porting them is an Owner decision, not implemented here.

**No-staticDir operating mode:** when `serve-mission-control.mjs` runs without `deps.staticDir`, the same UI_HTML document still serves at `/` and `/ui` — that operating mode is **untouched and continues to exist** outside the SPA deployment. Verified in code (`deps.staticDir ? serveStatic : UI_HTML` seam); running a second live server to re-prove it was out of scope per the mandate ("do not start, deploy or expose another server").
