# UI-V2 Owner-First Experience — Release Report

- **BASE SHA:** `ab0fccf79b2ac5ed045e948a0402ecbaa889c439`
- **HEAD SHA (last functional commit):** `eb58b96` — later commits on
  this branch are docs-only; the PR commits tab shows the exact tip.
- **PR:** https://github.com/vankusi59-svg/pair-next/pull/157 — **open,
  unmerged.** Owner retains merge authority; no merge/deploy/release
  action was performed.
- **Verification verdict:** `READY_FOR_INDEPENDENT_AUDIT`
- **Independent audit:** `FIX-REQUIRED` on first pass; all Major/Medium
  findings fixed and re-verified. No authority breach found.

## Scope delivered

### Shell (Phase A)
- Owner-first Vietnamese primary nav: **Tổng quan** `/app/home`,
  **Mục tiêu** `/app/objectives`, **Công việc** `/app/missions`,
  **Phê duyệt** `/app/inbox`, **Nhân sự AI** `/app/workforce`,
  `+ Tạo mới` `/app/new`.
- **Nâng cao** collapsible group keeps every legacy `/app/*` route
  reachable at all widths (CSS-collapsed, force-open on rail/drawer).
- Dark-navy owner cockpit theme + light theme; mobile bottom-tabs +
  drawer; skip link and named landmarks.
- `/app` → `/app/home`; `/` defaults to `/app/home` with the rollback
  preference preserved.

### Natural-language intake (Phase B)
- `/app/new` unified intake: goal → advisory analysis → editable draft
  with per-field provenance → explicit owner confirm.
- **Backend seam:** `POST /api/v1/intake/draft`
  (`src/pair/objective-intake.ts` + `mission-control-server.ts`).
  Bounded advisory interpretation via the same semantic analyzer with
  `plannerRunId: null` — evidence is **never** pinned to a planner run.
  Deterministic VN draft derivation. Degrades to an honest manual draft
  when semantic mode is off/unavailable/malformed; `manual: true` skips
  the analyzer entirely (zero provider spend). Unknown business → 404
  **before** provider spend.
- **Commit boundaries:** objective → canonical
  `POST /api/vnext/objectives` (dedup_key); mission →
  `/app/missions/new?goal=` governed preview/confirm. Business drift
  between analyze→confirm blocks the commit with a re-analyze hint.
  Malformed numerics blocked inline.

### Workstream behavior (review Blocker A — resolved)
- `draft.workstreams` is a **suggestion-only planning outline**. Nothing
  in it is persisted by analyzing, and confirming an Objective does
  **not** auto-create work items, missions, or tasks.
- UI copy states this explicitly at the workstream list, in the
  Objective confirm dialog (lists exactly which fields are persisted),
  and in the Mission handoff note.
- Governed work creation still exists only through the pre-existing
  canonical seams (mission preview/confirm, workforce work items) with
  their own owner confirmations — deliberately not wired to the draft,
  as wiring it would bypass the mission preview/confirm gate.
- E2E proof: `ui-v2.spec.ts` "analyzing a goal issues ZERO canonical
  creates" (network log: no POST to any canonical create seam) and
  "workstream suggestions are honest — nothing persisted without owner
  confirm".

### Owner cockpit (Phase C)
- `/app/home`: hero + canonical stat cards (operations rollup, ACTIVE
  objectives, pending approvals/reviews/blocked, recent completions) +
  sections linking to source lists. Honest `—`/`…`/`N+` states; no
  fabricated data.
- Business-scoped reads reset + abort-guard on every business switch —
  no cross-tenant stale render (audit major fix).

### Objective Detail tabs (Phase D)
- `Tổng quan` / `Kế hoạch` / `Thực thi` / `Kết quả` / `Nâng cao` tabs
  over the same canonical payload, `?tab=` deep links with param
  preservation. All advanced controls (auto-run policy, ops controls,
  relations, duties, integrity, KPI verifier grants) live under
  **Nâng cao**.

## Page scope matrix

| Page | Status | Notes |
|---|---|---|
| Overview `/app/home` | **Newly built** | Canonical read aggregates only; honest empty/unavailable states. |
| Intake `/app/new` | **Newly built** | New advisory endpoint + editable provenance draft; commit via existing governed seams. |
| Objective Detail `/app/objectives/:id` | **Substantially reorganized** | Same canonical payload and all functional components, now behind owner tabs. |
| Objectives `/app/objectives` | Legacy + nav/style | Existing list, unchanged behavior. |
| Work/Missions `/app/missions`, `/app/missions/new`, `/app/missions/:id` | Legacy + nav/style | Existing governed preview/confirm and detail views retained — execution/monitoring screens were not redesigned (mockup 3 direction approximated by existing mission detail; full redesign deferred). |
| Approvals `/app/inbox` | Legacy + nav/style | Existing A2 review seam, unchanged. |
| AI Workforce `/app/workforce` (+admin) | Legacy + nav/style | Existing roster/admin surfaces, unchanged. |
| Execution monitoring (mockup 3) | **Not built as a new screen** | Closest surfaces: mission detail ops sections + Objective autonomous-loop graph (advanced tab). Material gap vs mockup 3 recorded as a limitation. |
| Legacy advanced routes (Company Cockpit, CEO Workspace, Workforce Admin, Chat, Business Admin, Providers, Observability, Schedules, Chi phí, Settings) | Legacy + nav/style | All reachable under **Nâng cao**; intentionally not rebuilt — out of mission scope. |

## Verification evidence

| Gate | Result |
|---|---|
| Patch-claim tests | **PASS** (7/7 current claim; +7 known baseline) |
| Invariant tests (INV_MISSION_001, INV_SECRETS_001, INV_CONV_001) | **3/3 PASS** (+3 baseline) |
| Affected regression | **28/28 PASS** (+14 baseline) |
| tsc (backend + UI) | **PASS** |
| build (backend + UI) | **PASS** |
| Full unit suite | **PASS_WITH_KNOWN_BASELINE** (+134 baseline) |
| Focused: intake unit + endpoint | `pair-objective-intake.test.ts` + `pair-intake-draft-endpoint.test.ts` — **17/17 PASS** |
| Focused: `ui-v2.spec.ts` | **12/12 PASS** (re-run at post-audit HEAD incl. negative-budget regression — [`evidence/e2e-head-focused-uiv2.txt`](./evidence/e2e-head-focused-uiv2.txt)) |
| Reconciled legacy specs (objectives + company + inbox-ceo) | **68/68 PASS** |

### Playwright BASE-vs-HEAD (full suite, identical harness)

Full methodology + per-test table:
[`evidence/e2e-base-vs-head.md`](./evidence/e2e-base-vs-head.md) ·
[`evidence/e2e-comparison.json`](./evidence/e2e-comparison.json) ·
raw reporters [`e2e-base-raw.json`](./evidence/e2e-base-raw.json) /
[`e2e-head-raw.json`](./evidence/e2e-head-raw.json).

Command (both sides): `npx playwright test --reporter=json` from
`apps/mission-control-ui` — same OS, Node v24.19.0, Edge via
`CHROME_BIN`, identical `playwright.config.ts`, identical dependency
manifests (zero diff BASE..HEAD).

| | BASE `ab0fccf` | HEAD `5f1870c` |
|---|---|---|
| Tests | 231 | 242 |
| Passed | 198 | 220 |
| Failed | 33 | 22 |

| Classification | Count |
|---|---|
| pass (both) | 197 |
| fail-both — verified pre-existing, identical signatures | 22 |
| FIXED (BASE-fail → HEAD-pass) | 11 |
| new-pass | 12 |
| removed (renamed b6 test) | 1 |
| **REGRESSION** | **0** |
| **NEW-FAIL** | **0** |

Signature audit of the 22 fail-both — per-test:
[`evidence/e2e-signature-audit.json`](./evidence/e2e-signature-audit.json).
Full error heads compared after normalizing only provably-dynamic tokens
(generated IDs, digests, UUIDs, abs paths) and dropping stack frames:
**20/22 identical; 2 differ only in dynamic tokens** (fixture row-count
`181`→`136`; a code-frame of the spec line this diff fixed). Locators,
expected/received values, status/error codes are never normalized —
**0 genuinely-different signatures**.

Remaining 22 failures, counted per-test by failure mechanism:
- **21× planner-environment** (`FAIL_CLOSED_PLANNER_NO_ELIGIBLE`, no
  qualified planner on this box; specs untouched by this diff):
  9× explicit `preview -> 409`, 9× downstream `element not found` on
  post-preview elements, 3× the same gate on other seams
  (`system.spec` ×2 `mkMission pv.ok`, `workforce-admin` work-item open).
- **1× pre-existing spec/data defect:** `p184-operations` —
  `execution_health.executions[].mission_id` is `undefined`; identical
  at BASE.

## Independent audit — findings → fixes

| Severity | Finding | Fix |
|---|---|---|
| MAJOR | Home stale-scope race + no reset on business switch | Split global vs scoped effects; reset + abort-guard all scoped reads |
| MAJOR | Intake analyze→confirm business drift | `analyzedBiz` bound at analyze; drift disables confirm + re-analyze hint |
| MEDIUM | "Tạo thủ công" secretly ran AI | `manual:true` server flag — analyzer skipped, `mode/status: "manual"` |
| MEDIUM | `noAuthPrompt` regression (401 → prompt + reload destroyed drafts) | `createObjectiveApp` + opts on `missions`/`vnextObjectives` |
| LOW | Provider exception echoed to client | Typed reasons only |
| LOW | Catch-all → `BUSINESS_NOT_FOUND` masked integrity errors | Only `NotFoundError` maps to 404 |
| LOW | `deriveIntakeDraft` on unvalidated shape | `Array.isArray` guard → `unavailable` + manual draft |
| LOW | ConfirmDialog double-fire, stale banner, param loss, doc drift | `busy`, `setCreated(null)`, `setParams` merge, blueprint corrected |
| LOW | Malformed budget/KPI silently dropped | Inline validation blocks confirm |
| REVIEW | Workstream promise vs actual behavior (Blocker A) | Suggestion-only copy + zero-write E2E proof (`5f1870c`) |
| REVIEW | Negative budget finite-valid → silently dropped at confirm | `budgetInvalid` now covers `< 0`; hint states ≥ 0; e2e proves blocked confirm + positive value reaches canonical body |

## Screenshots

`docs/ui-v2/evidence/screenshots/` — real captures from the running PR
build (disposable instance :8797, seeded business/objective/agent).
Desktop 1440×900 + mobile 390×844; dark + light.

| File | View |
|---|---|
| `01-cockpit-desktop-dark` | Owner cockpit (seeded data, dark) |
| `02-intake-empty-desktop-dark` | Intake empty state |
| `03-intake-draft-desktop-dark` | Intake reviewed draft + provenance |
| `04-objective-overview-desktop-dark` | Objective Detail — Tổng quan |
| `05-objective-advanced-desktop-dark` | Objective Detail — Nâng cao (autonomous loop) |
| `06-missions-desktop-dark` | Missions list (legacy) |
| `07-task-entry-desktop-dark` | Task entry / mission new (legacy) |
| `08-nav-advanced-desktop-dark` | Nav with Nâng cao expanded |
| `09-inbox-desktop-dark` | Approvals inbox |
| `10-workforce-desktop-dark` | AI workforce |
| `11-cockpit-desktop-light` | Cockpit, light theme |
| `12-intake-draft-desktop-light` | Intake draft, light theme |
| `13-objective-overview-desktop-light` | Objective overview, light |
| `14-cockpit-mobile-dark` | Mobile cockpit 390×844 + bottom tabs |
| `15-intake-draft-mobile-dark` | Mobile intake draft |
| `16-objective-mobile-dark` | Mobile objective detail |

Not captured: mission **execution detail** with live data — this box has
no qualified planner (`FAIL_CLOSED_PLANNER_NO_ELIGIBLE`), so no mission
can be minted even via the governed preview. `06`/`07` cover the mission
surfaces; the gap is documented above.

## Known limitations

- Mockup-3-style dedicated execution-monitoring screen not built;
  existing mission detail + autonomous-loop graph are the current
  surfaces.
- Legacy advanced pages keep their design; only nav/style alignment.
- 22 e2e failures = 21 planner-environment (`FAIL_CLOSED_PLANNER_NO_ELIGIBLE`,
  no qualified planner on this box) + 1 pre-existing spec/data defect
  (`p184-operations` `mission_id` shape) — all identical-signature at BASE
  per `evidence/e2e-signature-audit.json`; fixing them or qualifying a
  planner is out of scope.
- Tab row uses buttons without full APG arrow-key semantics (keyboard
  reachable, `?tab=` deep-linkable).
- NUM_RE first-numeral KPI target is advisory-only (`suggested`
  provenance, owner-editable).

## Governance statement

No canonical authority seam was weakened: the intake route is read-only
advisory, nothing is minted server-side, all commits flow through
pre-existing governed seams (dedup/objective service or mission
preview/confirm), tenant checks fail closed server-side before any
provider spend, workstream suggestions are never persisted as work, and
the semantic layer remains advisory evidence — never authority.
