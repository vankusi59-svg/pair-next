# P18.1 — Operator Control Center Report

Branch `feat/p18-1-operator-control`, base `85e2244` (main after PR #148 merge).
Commits: `ad4c271` (owner HTTP seams) → `10a947f` (UI API client + types) → `816589e` (UI components + integration) → `f5c329b` (independent-audit remediation + real-browser E2E). +4,661 lines, zero edits to canonical services.

## What the operator can now do without a terminal

Owner defines a business objective → configures relationships, agent duties and execution policies → PairNext executes through governed autonomy → owner monitors evidence, blockers and progress → owner approves decisions in the Inbox. Every step is reachable through Mission Control UI over owner-scoped HTTP.

## Capability matrix (Phase A → shipped)

| Area | Before P18.1 | After |
|---|---|---|
| Objective relations (DEPENDS_ON/CONFLICTS/SUPERSEDES) | Canonical service only — no HTTP, no UI | Owner-scoped HTTP read/create/advisory-preview/lifecycle + UI section with admission strip, edge list, preview, confirm dialogs |
| `org_agent_duty` | Canonical service only | HTTP reads (objective/agent/business) + create + suspend/resume/revoke + UI assign form + coverage views |
| Objective pause/resume/cancel | `transitionStatus()` library only | POST `/transition` narrowed to the operator set — ACHIEVED/INFEASIBLE/EXPIRED stay behind review sign-off |
| Scheduler/driver observability | `/auto-scheduler`, `/auto-driver` existed | Aggregated `/operations` per-objective + business overview (queue, pending/claimed, lease, blocked_reason, driver outcome, capability gap, owner-action flags) |
| Integrity | typed wedges in services, no read surface | `/integrity` probe (relations+admission+duties+objective row) → CLEAN/WEDGED:<code> |
| Review/sign-off | `ObjectiveReviewSignoffService` + Inbox page existed | Unchanged — proven live in E2E (S12/S13) |

## HTTP surface added (`src/pair/mission-control-server.ts` only)

```
GET  /api/vnext/objectives/:id/relations          owner-scoped read (owned endpoints only)
POST /api/vnext/objectives/:id/relations          create via ObjectiveRelationService.create
POST /api/vnext/objectives/:id/relations/preview  advisory only — implications + errors, zero writes
POST /api/vnext/relations/:id/:action             suspend|resume|revoke via control()
GET  /api/vnext/businesses/:id/relations          business-wide canonical edges (owned scope)
GET  /api/vnext/objectives/:id/duties             covering-duty view
GET  /api/vnext/org-agents/:id/duties             agent duties, owned-coverage filter
POST /api/vnext/org-agents/:id/duties             create via OrgAgentDutyService.assign
POST /api/vnext/duties/:id/:action                suspend|resume|revoke
GET  /api/vnext/businesses/:id/duties             business duties, owned-scope
POST /api/vnext/objectives/:id/transition         PAUSED|ACTIVE|CANCELLED only (audit-narrowed)
GET  /api/vnext/objectives/:id/operations         objective+policy+scheduler(driver-ready)+driver+admission+relations+duties
GET  /api/vnext/businesses/:id/operations         per-objective queue snapshot for cockpit table
GET  /api/vnext/objectives/:id/integrity          canonical probe → CLEAN | WEDGED:<typed code>
```

Authority contract: `canonicalOperatorActor(req.headers["x-operator-id"])` on every route — body-declared identity is never consulted. All mutations go through the canonical services (CAS, idempotency, bilateral/N-lateral owner proofs, business isolation). Error mapping: 403 authority, 404 not-found, 409 FAIL_CLOSED_*, 400 typed schema.

## UI components (`apps/mission-control-ui`)

- `ObjectiveRelations.tsx` — admission strip (must-wait-on/conflicts/superseded-by), edge list with lifecycle buttons, target+kind picker with advisory preview before create, explicit revoke dialog. Dedup keys minted per operation signature and replayed verbatim on ambiguous failure; `_STATE` failures re-tick the poll.
- `AgentDuties.tsx` — duties covering the objective (or business-wide), exact-set picker, assign + suspend/resume/revoke.
- `CompanyRelations.tsx` — SVG node-link graph from returned relation rows only (never fabricated), topological layering with cyclic fallback, edge inspector + revoke toggle, duties summary.
- `ObjectiveOpsMonitor.tsx` — queue state, pending/claimed generation, blocked reasons, lease fence/expiry, driver outcome, capability gaps, owner-action flags; `NOT_OBSERVED` where no canonical read exists.
- `ObjectiveOpsControls.tsx` — pause/resume/cancel with confirm, policy state.
- `BusinessOperations.tsx` — company overview table.
- `IntegrityPanel.tsx` — CLEAN/WEDGED display; read-only, no repair offered.
- Wired into `ObjectiveDetail.tsx` (relations, duties, ops, integrity) and `Company.tsx` (graph, duties, operations overview).

## Preserved guarantees

- Relations: kind validation, self-relation reject, same-business, bilateral owner, acyclic DEPENDS_ON, idempotent create, CAS lifecycle, REVOKED tombstone.
- Duties: exact-set coverage (narrow duties never combine), N-lateral owner, same-business agent, replay convergence.
- Transitions: legal-table, terminal guards, owner proof — and the operator seam is deliberately narrower than the service table.
- Scheduler/driver: read-only seams; `UPSTREAM_UNMET`/`CONFLICT_LEASE_HELD` are the canonical gate verdicts, not UI-computed.
- Advisory previews are labeled advisory and never treated as authorization; foreign-owned targets leak nothing (post-audit).
- Integrity corruption propagates as typed wedges (`UNPROVEN:<code>` / 409) — never masked, never silently repaired.
