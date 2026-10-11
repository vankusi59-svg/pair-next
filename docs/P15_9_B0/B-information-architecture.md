# B — Information Architecture

## B.1 Design principle

Owner-first: the sidebar answers "how is my company doing → what needs me →
what is the company working on → who works for me → what did I ask it to do →
is the system healthy". Technical surfaces move to a **System** section that is
always reachable but never the landing zone.

## B.2 Target sitemap (new app, parallel prefix `/app`)

```
/app
├── /company                        ← Company Cockpit (new HOME)
│   └── ?business=<id>              business switcher (single-business scope per A1 decision)
├── /objectives
│   └── /objectives/:id             Objective Detail
├── /ceo                            ← CEO Workspace
│   └── /ceo/decisions              decision/review history (read)
├── /workforce                      ← AI Workforce
│   └── /workforce/:agentId         agent detail (role, workload, contract)
├── /inbox                          ← Owner Control Center
│   └── /inbox?kind=approval|review|halt
├── /missions                       ← Mission Operations
│   ├── /missions/new               Task entry (golden path, ported verbatim)
│   └── /missions/:id               Mission detail (ported + deepened)
├── /chat                           Chat (ported verbatim)
├── /system                         System & Operations
│   ├── /system/providers           Providers & Models
│   ├── /system/observability       recovery, routes, events stream
│   ├── /system/schedules           schedules
│   ├── /system/cost                cost + policies (read now; controls = API_READY)
│   └── /system/settings            token/operator session, theme
└── legacy redirects (see B.4)
```

Why `/app/*` and not reusing `/`: the migration strategy (F) requires the new
UI to run **alongside** the old one with zero production-route change and a
clean rollback boundary. A distinct prefix keeps routing trivially separable in
the SPA and lets `/` keep serving today's app until acceptance.

## B.3 Sidebar hierarchy (desktop)

```
PAIR ▮ Company OS
├─ Overview
│   ├─ Company Cockpit        /app/company
│   └─ Owner Inbox  (badge)   /app/inbox          ← count = approvals + pending reviews (HALT unavailable — see B.5.2)
├─ Business
│   ├─ Objectives             /app/objectives
│   ├─ CEO Workspace          /app/ceo
│   └─ Workforce              /app/workforce
├─ Operations
│   ├─ Missions               /app/missions
│   └─ Chat                   /app/chat
├─ System
│   ├─ Providers & Models     /app/system/providers
│   ├─ Observability          /app/system/observability
│   ├─ Schedules              /app/system/schedules
│   ├─ Cost                   /app/system/cost
│   └─ Settings               /app/system/settings
└─ footer: business switcher, operator chip, theme toggle
```

Mobile: sidebar collapses to a bottom tab bar
(Cockpit / Inbox● / Objectives / Missions / More→drawer) — spec'd in D.

## B.4 Route migration map

| Old route | New route | Behavior |
|---|---|---|
| `/` (Dashboard) | `/app/company` | Company view replaces mission table as home; old dashboard content splits: missions → `/app/missions`, cost chip → `/app/company` + `/app/system/cost`. |
| `/missions/new` | `/app/missions/new` | Ported verbatim (golden path). |
| `/missions/:id` | `/app/missions/:id` | Ported + linked from Objective workstreams. |
| `/approvals` | `/app/inbox` | Approvals become one inbox lane next to review-required lane. |
| `/schedules` | `/app/system/schedules` | Moved under System. |
| `/providers` | `/app/system/providers` | Moved under System. |
| `/observability` | `/app/system/observability` | Moved under System. |
| `/objectives` | `/app/objectives` + `/app/objectives/:id` | List/detail split; create form retained. |
| `/chat` | `/app/chat` | Ported verbatim. |
| `/ui` (legacy UI_HTML) | `/app/system/…` + `/app/workforce` | Business/org-agent/work-item admin re-implemented in new shell. `/ui` is reachable ONLY on a no-`staticDir` server run — in the SPA deployment it already serves the SPA (verified). Preservation = second bare-server instance until admin parity; porting is a cutover precondition (H). |
| `/` old app | unchanged until cutover | Old app stays at `/`; cutover = staticDir switch, not code removal (F). |

## B.5 Owner-first navigation rules

1. Any page reachable in ≤2 clicks from Cockpit for its parent concept;
   System pages exempted.
2. `Owner Inbox` badge = `pending approvals` + `targets_met_pending` only.
   HALTED policies are NOT countable today: the company summary carries no
   `auto_policy` field and no enumeration route exists (API_MISSING). The
   badge therefore carries NO HALT component for B1–B4 — the HALT lane shows
   an unavailable/partial-information explanation instead of any count, and
   nothing claims policies were scanned.
3. Business switcher is global (top of sidebar) — every Business-section page
   re-queries with the selected `business_id`; no cross-business aggregation
   (single-business scope, locked in P15.9-A1 owner decision).
   **Seed contract (verified R1)**: no owner-scoped business enumeration exists
   (`/api/businesses` is unfiltered — never list it as "my companies"). The
   switcher offers the last-used / manually entered `business_id` (persisted in
   localStorage like the token) and proves access via
   `GET /api/vnext/businesses/:id/company` (403 → DeniedState). An
   owner-scoped enumeration route is API_MISSING — a named backend
   dependency, not a UI workaround.
4. Deep links everywhere: every card/row that shows an entity links to its
   canonical detail route (`/app/objectives/:id`, `/app/missions/:id`,
   `/app/workforce/:agentId`).
