# P18.1 — Remaining Gaps

Product-level gaps that remain after P18.1. None weakens a canonical-authority, security, or fail-closed invariant; each is documented with the honest boundary it sits on.

## Product gaps

1. **Repair workflows** — the integrity probe is read-only by design. A `WEDGED`/`UNPROVEN:<code>` state is displayed to the owner with no offered repair: no canonical, independently-verifiable repair mechanism exists today, and the mission spec forbids inventing one (no SQL deletion, no silent reindex). Owner remediation today = revoke/cancel the affected edge/objective or contact support with the typed code. If a canonical repair authority is ever defined, it can be exposed behind the same preview-and-confirm pattern.
2. **Scheduler/driver fields not rendered everywhere** — `ObjectiveOpsMonitor` covers queue/lease/reasons/driver-outcome/capability-gap; the business overview table is a snapshot subset (queue_state, pending/claimed, blocked_reason, lease, owner_action flag, driver last outcome, gap). Deep fields (checkpoint digests, source_refs, wait_streak internals) exist in the API payload but are not yet surfaced in UI — they are canonical data, available to a future detail drawer.
3. **`autoDriver.statusReadOnly` vs `readiness` naming asymmetry** — the operations payload keeps `statusReadOnly` for display (attempt history/last outcome) and `readiness` for the scheduler block. Two truthful views with overlapping names; a future pass could present one merged, clearly-labeled driver section.
4. **Policy edit UX is thin** — configure/enable/disable are reachable (existing Auto-run controls + ops controls), but there is no dedicated guided form for limits windows; the owner edits numeric fields directly. Functional, not polished.
5. **No mission-level drill-down from the objective page** — dispatched missions appear in company views and the Missions page, but there is no dedicated "missions for this objective" section linking `mission_ids` from ops data. Navigation exists; a deep-link would be a small addition.
6. **Polling cadence is fixed (~8s)** — abortable + newest-wins + visibility-gated as specified, but no adaptive backoff or SSE. Adequate for a single owner.
7. **Test-harness coverage of scheduler/driver reads** — vitest `serve()` wires no `autoScheduler`/`autoDriver`, so those JSON paths are verified by the live E2E (39/39) rather than unit tests. If a mock driver seam is added later, port the live assertions into the suite.

## Deliberate restrictions (not gaps)

- `POST /transition` accepts only `PAUSED|ACTIVE|CANCELLED` — `ACHIEVED`/`INFEASIBLE` require the review-signoff gate (restored after audit HIGH-1).
- Advisory preview returns `implications={}` for foreign/cross-business targets — no status disclosure.
- Unknown agent reads fold into the same `403 FAIL_CLOSED_BUSINESS_SCOPE` as foreign agents — no existence oracle.
- `UNPROVEN:<code>` is shown for IntegrityError on business operations; `NOT_OBSERVED` only for genuinely absent components.
- Foreign-objective pickers filter already-linked targets visually; the service re-validates everything at commit — UI state is never authority.

## Explicit non-goals this mission

- No P19 work, no Planner redesign, no production deployment.
- No direct SQL anywhere in routes; no hidden transitions; no paid API fallback (DSH stayed liveness-registered only, zero invocations).
