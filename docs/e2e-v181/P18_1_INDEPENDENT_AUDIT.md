# P18.1 — Independent Audit

Auditor: sub-agent `120b1708` (codex-reviewer, **non-implementer**). Scope: full diff `85e2244..816589e` + untracked E2E script, cross-read against `ObjectiveRelationService`, `OrgAgentDutyService`, `ObjectiveAuthorityService.transitionStatus`, auto-policy/scheduler/driver public APIs. Verdict: **fix-then-ship** — 2 HIGH, 3 MEDIUM, 6 LOW. All HIGH and MEDIUM closed in `f5c329b` and re-verified; LOWs either fixed or consciously documented.

## Findings → disposition

### HIGH — `/objectives/:id/transition` exposed the full canonical transition table (CLOSED)
Route forwarded any `to` to `transitionStatus`, allowing owner-declared `ACHIEVED` while bypassing the P15.10-A2 review-signoff gate (TARGET_MET_CANDIDATE + all_targets_met + owner_action_required + freshness + no active work). **Fix**: operator seam whitelisted to `PAUSED|ACTIVE|CANCELLED`; everything else → `400 FAIL_CLOSED_OBJECTIVE_TRANSITION_REQUEST` with an explicit message pointing at sign-off. Test coverage added (`T1` asserts 400 for ACHIEVED/INFEASIBLE/EXPIRED/BLOCKED). E2E S5 rewritten to exercise the real canonical path end-to-end.

### HIGH — `/objectives/:id/operations` fabricated driver readiness (CLOSED)
`statusReadOnly()` never returns `objective_runnable` — the emitted `auto_scheduler` block claimed `objective_runnable:false, driver_missing:[]` unconditionally. **Fix**: uses `deps.autoDriver.readiness(objectiveId, actor)` — the driver's own canonical proof, same convention as `/auto-scheduler` (P15.10-C R3 F3). Comment corrected (readiness may commit the canonical lazy EXPIRED transition — not a pure read).

### MEDIUM — business `/operations` masked integrity corruption as `NOT_OBSERVED` (CLOSED)
Per-field `try/catch → "NOT_OBSERVED"` swallowed `IntegrityError`s, rendering tampered rows identical to absent components. **Fix**: `IntegrityError` surfaces `UNPROVEN:<typed code>`; only genuine absence stays `NOT_OBSERVED`.

### MEDIUM — test coverage below exposed surface (CLOSED)
Added: ACHIEVED/INFEASIBLE/EXPIRED/BLOCKED rejection on the transition seam; foreign-target preview suppression. (Scheduler/driver coverage stays thin by design — the test harness wires no autoScheduler/autoDriver; behavior verified on the live E2E instead.)

### LOW — advisory preview leaked foreign target status (CLOSED)
`implications.current_target_status`/`would_block_now` disclosed a foreign-owned objective's status. **Fix**: when different-owner/cross-business errors are present, `implications={}` and `current.admission` suppressed. Test added.

### LOW — `/org-agents/:id/duties` existence oracle (CLOSED)
404 `ORG_AGENT_NOT_FOUND` fired before scope check → "agent exists outside your scope" oracle. **Fix**: unknown agent returns the same `403 FAIL_CLOSED_BUSINESS_SCOPE` as a foreign-owned agent.

### LOW — observability comment over-claimed (CLOSED)
Comment claimed "no lazy-expiry write"; `status()`/`readiness()` may commit canonical lazy EXPIRED. Comment corrected.

### LOW — stale UI error-code hint tables (CLOSED)
`RELATION_CYCLE`/`RELATION_EXISTS`/`DUTY_EXISTS`/`FAIL_CLOSED_AGENT_MISSING` didn't exist server-side. Replaced with real codes (`FAIL_CLOSED_RELATION_CYCLE`, `FAIL_CLOSED_RELATION_OBJECTIVE`, `FAIL_CLOSED_DUTY_AGENT`, `FAIL_CLOSED_DUTY_OBJECTIVE`, `*_STATE`). Verbatim fallback still renders unknown codes.

### LOW — ambiguous-retry UX lag (CLOSED)
Committed-but-lost lifecycle retries surface `FAIL_CLOSED_*_STATE` 409; failure path now re-ticks the poll so the canonical row repaints immediately (all three lifecycle components).

### LOW — dedup signature included `note` (CLOSED)
Services dedup on the semantic triple/set only. Signatures now match the canonical dedup inputs.

## Per-rule status (post-remediation)

| Rule | Status |
|---|---|
| No duplicate canonical authority | **Clean** — all mutations through canonical services; zero store writes in handlers |
| Header-only owner proof | **Clean** — every route derives actor from `x-operator-id` via `canonicalOperatorActor` |
| Bilateral/N-lateral authorization | **Clean** — delegated to services; read-side owned-scope filters mirror portfolio convention |
| No hidden state transitions | **Clean post-fix** — operator transition seam narrower than the service table |
| No fabricated states | **Clean post-fix** — truthful readiness, wedges unmasked, advisory previews labeled |
| No unauthorized dispatch / paid fallback | **Clean** — no executor routes added; DSH never invoked in E2E |
| No weakened P18 gates | **Clean post-fix** — sign-off gate restored as the only ACHIEVED path |
| No readiness over-claims | **Clean** — `NOT_OBSERVED`/`UNPROVEN:<code>` semantics explicit |

## Post-remediation re-verification

- `pair-p18-1-operator-seams.test.ts`: **11/11** including new coverage.
- Live browser E2E re-run on the fixed build: **39/39 PASS** — recovery now proven through the full canonical chain (real CEO bootstrap → review → governed work-item cancel → sign-off → ACHIEVED → gate release).
- `tsc --noEmit` clean; UI build clean.

## Residual auditor notes (not defects)

- `serve()` test harness wires no `autoScheduler`/`autoDriver` — those reads are verified live, not in vitest.
- Audited the E2E script statically; the 39/39 live result is the implementer's run output (script assertions are real DOM/API reads — reproducible: `node docs/e2e-v181/p181-live.mjs`).
