# P15.9-B6 — Functional Preservation Matrix (legacy UI ↔ /app tree)

BASE `7791800cc764974d659f335d1e0e569a97106411`. Two legacy surfaces exist:

- **Router pages** (`src/pages/*`, routes `/` `/missions/new` `/missions/:id` `/approvals` `/schedules` `/providers` `/observability` `/objectives` `/chat`, wrapped by `src/components/Layout.tsx`).
- **`UI_HTML`** (`src/pair/mission-control-server.ts` ~L163–420) — the bare `node serve-mission-control.mjs` server UI with inline JS admin functions; only reachable when `deps.staticDir` is unset. In the staticDir SPA deployment `/ui` falls back to the SPA.

Verdict classes: `PARITY_PROVEN` / `PARITY_PARTIAL` / `NOT_PORTED` / `INTENTIONALLY_DIFFERENT` / `API_MISSING` / `UNVERIFIED`. "Proven" = covered by an executable test (named in Evidence) or verified live against the real backend this session. Nothing untested is classified proven.

## A. Legacy router pages → /app

| Legacy route / file | Function | Canonical endpoint(s) | Modern route / file | Verdict | Evidence | Missing / notes | Cutover impact |
|---|---|---|---|---|---|---|---|
| `/` `pages/Dashboard.tsx` | Mission list + counters, routing/approval/cost chips | `/api/missions`, `/api/approvals`, `/api/routing`, `/api/cost*` | `/app/missions` `pages/Missions.tsx` (+ chips spread across `/app/system/*`, `/app/inbox`) | PARITY_PROVEN | `missions.spec.ts`, `system.spec.ts`, B6 deep-link | counters split across pages — no single "dashboard" page; documented, acceptable | Low — redirect maps to `/app/missions` |
| `/missions/new` `pages/MissionNew.tsx` | goal→preview→confirm task entry | `POST /api/missions/preview`, `POST /api/missions` | `/app/missions/new` `app/pages/MissionNew.tsx` | PARITY_PROVEN | `missions.spec.ts` (preview→pinned confirm, single-flight) | none found | None |
| `/missions/:id` `pages/MissionDetail.tsx` | timeline/DAG/evidence/files, actions | `/api/missions/:id*`, `/api/tasks*`, `/api/evidence*` | `/app/missions/:id` `app/pages/MissionDetail.tsx` | PARITY_PROVEN | `missions.spec.ts` (detail, evidence, files, actions, id preserved in redirect test) | none found | None — dynamic id preserved by redirect |
| `/approvals` `pages/Approvals.tsx` | global approvals list + decide | `/api/approvals*`, decide POST | `/app/inbox` `app/pages/Inbox.tsx` (approvals lane) | PARITY_PROVEN | `inbox-ceo.spec.ts` (approve/deny, pinned context, badge convergence) | legacy page was approvals-only; inbox adds reviews/halt lanes (broader, intentional) | None |
| `/schedules` `pages/Schedules.tsx` | schedule registry CRUD | `/api/schedules*` | `/app/system/schedules` `app/pages/SystemSchedules.tsx` | PARITY_PROVEN | `system.spec.ts` (create/enable/disable/delete, pinned id, single-flight, zero `/api/tick`) | none | None |
| `/providers` `pages/Providers.tsx` | provider/model/route catalogs + gates | `/api/providers`, `/api/models`, `/api/routes`, decisions | `/app/system/providers` `app/pages/SystemProviders.tsx` | PARITY_PROVEN | `system.spec.ts` (catalogs, gate labels, decisions slice) | none | None |
| `/observability` `pages/Observability.tsx` | SSE stream, routing/recovery/evidence | `/api/events` SSE, `/api/recovery*`, `/api/evidence*` | `/app/system/observability` `app/pages/SystemObservability.tsx` | PARITY_PROVEN | `system.spec.ts` (stream lifecycle, pinned-mission evidence, export) | global stream labeled non-scoped (improvement) | None |
| `/objectives` `pages/Objectives.tsx` | legacy objective CRUD + policy halt | `/api/objectives` (legacy compat) | `/app/objectives` `app/pages/ObjectiveList.tsx` (+ `/app/workforce/admin` legacy-create) | PARITY_PROVEN | `objectives.spec.ts` (list/detail/reviews; halt flake documented) | none | None |
| `/chat` `pages/Chat.tsx` | conversation turns + drafts | `/api/conversations*`, drafts confirm/reject | `/app/chat` `app/pages/Chat.tsx` | PARITY_PROVEN | `app-chat.spec.ts` 29/29 (per-session idempotency, proposal binding, malformed-200, draft mint) | legacy `/chat` kept identical | None |

## B. UI_HTML surface → /app (B6 R1-F1: admin mutations audited separately from technical read panes — see ui-html-admin-parity.md)

### B.1 Administrative mutations — all ported + proven

| UI_HTML fn | Mutation | Modern location | Verdict |
|---|---|---|---|
| `mkBiz` | POST /api/businesses | `/app/system/business-admin` | PARITY_PROVEN (`workforce-admin.spec.ts`) |
| `bizDetail` (inspect) | GET bundle | BusinessAdmin "Inspect a business" | PARITY_PROVEN |
| `mkAg` | POST /api/org-agents | `/app/workforce/admin` "Create org agent" | PARITY_PROVEN |
| `mkWi` | POST /api/work-items | WorkforceAdmin "Create work item" | PARITY_PROVEN |
| `openWi` | POST …/open (governed) | WorkforceAdmin open — confirmation kept | PARITY_PROVEN |
| `wiBlock`/`wiUnblock`/`wiCmt` | POST block/unblock/comment | WorkforceAdmin work-item row ops | PARITY_PROVEN |
| `mkRt`/`rtTog` | POST /api/routines, :id/enable\|disable | WorkforceAdmin "Routines (legacy parity)" | PARITY_PROVEN |
| `mkObj` (legacy) | POST /api/objectives | WorkforceAdmin "Legacy objectives (compat API)" — labeled distinct from vnext | PARITY_PROVEN |

### B.2 Technical read panes — audited individually (B6 R1-F1)

Each UI_HTML nav pane reads exactly one GET endpoint (mapping is verbatim in `mission-control-server.ts` L180–183). Grep over `apps/mission-control-ui/src/` proves which panes have any consumer: `/api/health`, `/api/metrics`, `/api/experience`, `/api/selfmod` have **zero callers in any React page** (legacy `src/pages/*` or modern `src/app/*`) — the `api.health()`/`api.metrics()` wrappers exist in `api.ts` but are unused. These four panes were never part of the React UI at all; they exist **only** inside the bare `UI_HTML` document served when `deps.staticDir` is unset.

| Pane | Canonical source | Modern destination | Data/function retained | Evidence | Verdict | Cutover consequence |
|---|---|---|---|---|---|---|
| Missions | `GET /api/missions` (+`/:id`, `/timeline`, action POSTs) | `/app/missions`, `/app/missions/:id` | full list + detail + governed actions | `missions.spec.ts` | PARITY_PROVEN | none |
| Health | `GET /api/health` | none | subsystem READY/DEGRADED states — not shown anywhere in the SPA | grep: zero `health(` callers in `src/app/`+`src/pages/` | **NOT_PORTED** | UI_HTML Health view lost under /app; endpoint still reachable directly; supported alternative = no-staticDir server mode (kept intact) |
| Metrics | `GET /api/metrics` | none | runtime counters/metrics — not shown anywhere in the SPA | grep: zero `metrics(` callers | **NOT_PORTED** | same as Health |
| Routing | `GET /api/routing` | `/app/system/observability` routing section | routing projection rows | `system.spec.ts` (observability routing tab) | PARITY_PROVEN | none |
| Recovery | `GET /api/recovery` | `/app/system/observability` recovery explorer | recovery rows | `system.spec.ts` | PARITY_PROVEN | none |
| Approvals | `GET /api/approvals` (+decide POSTs) | `/app/inbox` approvals lane | list + approve/deny | `inbox-ceo.spec.ts` | PARITY_PROVEN | none |
| Experience | `GET /api/experience` | none | experience/evidence aggregates — not shown anywhere in the SPA | grep: zero `experience` callers | **NOT_PORTED** | same as Health |
| Self-Improvement | `GET /api/selfmod` | none | selfmod proposals/status — not shown anywhere in the SPA | grep: zero `selfmod`/`selfImprove` callers | **NOT_PORTED** | same as Health |
| Business | `GET /api/businesses` (+detail bundle) | `/app/system/business-admin` (+ scoped `/app/company` cockpit — improvement) | registry, inspect, create | `workforce-admin.spec.ts` | PARITY_PROVEN | none |

**Cutover consequence of the 4 unported panes:** Health/Metrics/Experience/Self-Improvement are technical operator read panes that exist only in UI_HTML. Under a `/app` cutover they have no UI equivalent — the endpoints remain reachable (`curl`/API clients), and the **supported alternative is the documented no-staticDir operating mode** (`serve-mission-control.mjs` without `deps.staticDir` still serves the full UI_HTML document — verified in code at the `deps.staticDir ? serveStatic : UI_HTML` seam). Porting them was not done in B6 because the mandate forbids new technical pages merely to green the matrix; whether they are needed in `/app` at all is an **explicit Owner decision** (cutover-preparation §H3 C5).

## C. Remaining gaps summary

- **4 NOT_PORTED technical read panes** (Health, Metrics, Experience, Self-Improvement) — UI_HTML-only surfaces; endpoints and the no-staticDir mode remain intact; Owner decision required.
- `API_MISSING` entries in `docs/P15_9_B0/E.md §6` — absent from legacy too; no regression.

**Cutover statement of functional parity:** every *user-facing* capability of the legacy UI has a proven modern destination; the only unported capabilities are 4 technical operator read panes that were never part of the React UI and remain available via their endpoints and the no-staticDir mode. That is an Owner sign-off item, not a defect.
