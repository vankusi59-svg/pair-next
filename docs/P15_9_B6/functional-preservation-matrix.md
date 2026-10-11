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

## B. UI_HTML admin surface → /app (see ui-html-admin-parity.md for the full verdict)

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
| Read panes (Missions/Health/Metrics/Routing/Recovery/Approvals/Experience/Self-Improvement/Business) | GET mix | covered by corresponding /app pages | INTENTIONALLY_DIFFERENT — UI_HTML panes are unscoped/global; /app adds scope labels |

## C. Items with no modern equivalent (none found)

No `NOT_PORTED`, `UNVERIFIED`, or silently dropped capability was found in the legacy router tree or the UI_HTML admin surface. Remaining `API_MISSING` entries live in `docs/P15_9_B0/E.md §6` (owner-scoped business enum, scoped feed, ledger drill-down, etc.) — they were absent from the legacy UI too, so nothing regressed.

**Cutover statement of functional parity:** every user-facing capability of the legacy UI has a proven modern destination. The only intentionally-removed surface is UI_HTML's unlabeled global panes, replaced by labeled scoped/global distinctions — Owner sign-off on that intentional difference is the open item, not missing functionality.
