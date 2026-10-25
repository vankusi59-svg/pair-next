# P18.4 — Operator UI Design

Extends the existing Mission Control SPA (`apps/mission-control-ui`) —
no new application, no new design system. All data flows through the
canonical projections on `MissionObservability`; the UI never infers
health from model prose or raw adapter payloads.

## Surfaces

### 1. Mission Detail — Execution Health section

Source: `GET /api/missions/:id/operations` → `execution_health.executions[]`
(sorted by `dispatch_timestamp`).

Each row renders the three provenance buckets separately:

- **persisted** (canonical): `execution_state`, `result_committed`,
  `settle_complete`, `collection_attempts`, `settle_faults`,
  `collection_started_at`/`collection_committed_at`, `settled_at`,
  `collect_excluded`, `terminal_outcome`, `dispatch_timestamp`.
- **observed** (facts about observation): `last_observed_at`,
  `observe_count`, `observe_faults`, `first_terminal_observed_at`,
  `heartbeat_at`, `finished_at`, `blocking_reason`.
- **derived** (diagnostics): `stage` badge, `abnormal[]` warn-toned
  flags, `latency_ms{dispatch_to_terminal_observed,
  terminal_observed_to_collect, collect_to_settle}`.
- **unknowns[]**: listed explicitly — never rendered as empty/zero.

Derived `stage` renders *beside* the canonical `persisted.execution_state`
badge; abnormal flags render warn-tone only.

### 2. Mission Detail — Recovery Operations section

Source: same endpoint → `recovery_ops`.

- runtime `state`, `pending_recovery`, `deferred_recovery[]` (+`drain_attempts`),
  `backoff[]`, `barriers`, `approvals_pending[]` (link → Owner Inbox),
  `decisions`/`attempts`/`reconciliation_receipts` counts + recent rows,
  `allowed_actions{decide_approval, request_reconciliation, lifecycle}`
  (evidence-gated — `decide_approval` only when approvals exist),
  `mission_exists`, reconcile note only when a barrier/reconcile is live.

**Read-only by contract.** No mutation control is added; approvals route
to the existing Owner Inbox flow; there is no inline reconcile button —
a capability gap is documented instead of invented.

### 3. System Observability — Operations Overview tab

Source: `GET /api/operations` → `operations`.

Pressure counts: `missions_active` (runtime rows in any supervised live
state — deliberately NOT `missions_running`, which `metrics()` reports
on a different basis), `missions_paused`, `executions_in_flight`,
`executions_awaiting_collection` (**terminal-evidenced but unsettled** —
collection debt, not healthy work), `executions_never_observed`
(`observe_count===0` — same basis as the per-row flag),
`executions_blocked`, `recovery_pending`, `recovery_deferred`,
`approvals_pending`, `backoff_pending`, `objectives_blocked`.

Latency rollups (p50/p95/max over canonical stamps):
`observe_latency_ms`, `collect_latency_ms`, `settle_latency_ms`.

## Fail-closed validation

`MissionDetail` validates the projection before rendering ANY of it:
`mission_id` echo matches the URL id; `execution_health.executions` is
an array of objects each carrying `execution_id` + `persisted`/`observed`/
`derived` objects + `derived.stage` string + `derived.latency_ms` object
+ `abnormal[]`/`unknowns[]` arrays; `recovery_ops` carries all six
canonical lists + `barriers`/`allowed_actions` objects. Any violation →
`UNAVAILABLE` (MALFORMED), never a fabricated empty section.

`SystemObservability` requires `operations` to be an object; counts render
NaN-safe; the empty state shows only when every count is genuinely zero.

## Authorization

Both routes sit inside the blanket `/api/*` MC-token gate
(`PAIR_MC_TOKEN`, Bearer or `?token=` for GET). They are read models —
no operator-identity requirement (POSTs keep `x-operator-id`). The admin
credential does not reach them; token and admin boundaries stay distinct.
