# UI-V2 Owner-First Experience — Release Report

- **BASE SHA:** `ab0fccf79b2ac5ed045e948a0402ecbaa889c439`
- **HEAD SHA:** `e355fa3227df8d55e862cf98b375255384e70bcb`
- **Branch:** `ui-v2-owner-experience`
- **Verification verdict:** `READY_FOR_INDEPENDENT_AUDIT`
- **Independent audit:** subagent audit — verdict `FIX-REQUIRED` on first pass; all Major/Medium findings fixed and re-verified (see below). No authority breach found.

## Scope delivered

### Shell (Phase A)
- Owner-first Vietnamese primary nav: **Tổng quan** `/app/home`, **Mục tiêu** `/app/objectives`, **Công việc** `/app/missions`, **Phê duyệt** `/app/inbox`, **Nhân sự AI** `/app/workforce`, `+ Tạo mới` `/app/new`.
- **Nâng cao** collapsible group keeps every legacy `/app/*` route reachable at all widths (CSS-collapsed, force-open on rail/drawer).
- Dark-navy owner cockpit theme + light theme; mobile bottom-tabs + drawer; skip link and named landmarks.
- `/app` → `/app/home`; `/` defaults to `/app/home` with the rollback preference preserved.

### Natural-language intake (Phase B)
- `/app/new` unified intake: goal → advisory analysis → editable draft with per-field provenance (`từ văn bản của bạn` / `AI đề xuất` / `chưa có` / `bạn đã sửa`) → explicit owner confirm.
- **Backend seam:** `POST /api/v1/intake/draft` (`src/pair/objective-intake.ts` + `mission-control-server.ts`). Bounded advisory interpretation via the same semantic analyzer with `plannerRunId: null` — evidence is **never** pinned to a planner run. Deterministic VN draft derivation (budget w/ `triệu` magnitudes, `dd/mm/yyyy`, KPI/constraint extraction). Degrades to an honest manual draft when semantic mode is off/unavailable/malformed; `manual: true` skips the analyzer entirely (zero provider spend). Unknown business → 404 **before** provider spend; integrity errors propagate, never masquerade as not-found.
- **Commit boundaries:** objective → canonical `POST /api/vnext/objectives` (dedup_key); mission → `/app/missions/new?goal=` governed preview/confirm. Business drift between analyze→confirm blocks the commit with a re-analyze hint. Malformed numerics blocked inline.

### Owner cockpit (Phase C)
- `/app/home`: hero + canonical stat cards (operations rollup, ACTIVE objectives, pending approvals/reviews/blocked, recent completions) + sections linking to source lists. Honest `—`/`…`/`N+` states; no fabricated data.
- Business-scoped reads reset + abort-guard on every business switch — no cross-tenant stale render (audit major fix).

### Objective Detail tabs (Phase D)
- `Tổng quan` / `Kế hoạch` / `Thực thi` / `Kết quả` / `Nâng cao` tabs over the same canonical payload, `?tab=` deep links with param preservation. All advanced controls (auto-run policy, ops controls, relations, duties, integrity, KPI verifier grants) live under **Nâng cao**.

## Changed files
`.pair-verification/patch-claim.json` · `scripts/serve-mission-control.mjs` · `src/pair/mission-control-server.ts` · `src/pair/objective-intake.ts` · `src/__tests__/pair-intake-draft-endpoint.test.ts` · `src/__tests__/pair-objective-intake.test.ts` · `apps/mission-control-ui/src/{api.ts,main.tsx}` · `app/{AppShell.tsx,routes.tsx,types.ts}` · `app/pages/{Home,Intake,MissionNew,ObjectiveDetail}.tsx` · `styles/tokens.css` · `e2e/{app,b6-acceptance,chat,company,inbox-ceo,objectives,system,ui-v2}.spec.ts` · `docs/ui-v2/*`.

## Verification evidence

| Gate | Result |
|---|---|
| Patch-claim tests | **7/7 PASS** (+7 known baseline) |
| Invariant tests (INV_MISSION_001, INV_SECRETS_001, INV_CONV_001) | **3/3 PASS** (+3 known baseline) |
| Affected regression | **28/28 PASS** (+14 known baseline) |
| tsc (backend + UI) | **PASS** |
| build (backend + UI) | **PASS** |
| Full unit suite | **PASS_WITH_KNOWN_BASELINE** (+134 known baseline) |
| Playwright E2E | **218/240 pass; 22 fail — all `FAIL_CLOSED_PLANNER_NO_ELIGIBLE` env baseline** |
| Dedicated ui-v2.spec.ts | **9/9 PASS** |
| objectives + company + inbox-ceo | **68/68 PASS** |

### Known baselines (pre-existing, not regressions)
- **No qualified planner route on this box** → every `mkMission`/preview-dependent test fails with `preview -> 409` (`FAIL_CLOSED_PLANNER_NO_ELIGIBLE`). `PAIR_MC_TEMPLATE_PLANNER` bypass was removed before BASE; identical failure at BASE. All 22 remaining failures are this class.
- Canonical KPI-verification status check is intentionally a `POST action:"status"` (pre-P15.9 contract) — read, not mutation; spec updated to reflect it.
- `chat.spec.ts` `#project` selector and Inbox A2 assertions were stale pre-BASE; reconciled to the real seams.

## Independent audit — findings → fixes

| Severity | Finding | Fix |
|---|---|---|
| MAJOR | Home stale-scope race + no reset on business switch | Split global vs scoped effects; reset + abort-guard all scoped reads; AbortError ignored |
| MAJOR | Intake analyze→confirm business drift | `analyzedBiz` bound at analyze; drift disables confirm + re-analyze hint |
| MEDIUM | "Tạo thủ công" secretly ran AI | `manual:true` server flag — analyzer skipped, `mode/status: "manual"` |
| MEDIUM | `noAuthPrompt` regression (401 → prompt + reload destroyed drafts) | `createObjectiveApp` + opts on `missions`/`vnextObjectives` |
| LOW | Provider exception echoed to client | Typed reasons (`intake_analyze:error` / `:malformed_response` / PairError code) |
| LOW | Catch-all → `BUSINESS_NOT_FOUND` masked integrity errors | Only `NotFoundError` maps to 404 |
| LOW | `deriveIntakeDraft` on unvalidated shape | `Array.isArray(items)` guard → `unavailable` + manual draft |
| LOW | ConfirmDialog double-fire, stale success banner, param loss, doc drift | `busy={busy}`, `setCreated(null)`, `setParams` merge, blueprint corrected |
| LOW | Malformed budget/KPI silently dropped → server-side create failure | Inline validation blocks confirm with stated reason |

Nits accepted as bounded/noted: NUM_RE first-numeral KPI target (owner-reviewed `suggested`), tab arrow-key APG nicety, `intakeDraft` POST abort.

## Governance statement
No canonical authority seam was weakened: the intake route is read-only advisory, nothing is minted server-side, all commits flow through pre-existing governed seams (dedup/objective service or mission preview/confirm), tenant checks fail closed server-side before any provider spend, and the semantic layer remains advisory evidence — never authority.

## Screenshots
`docs/ui-v2/screenshots/` — home desktop dark, home mobile dark, intake desktop dark, intake desktop light.
