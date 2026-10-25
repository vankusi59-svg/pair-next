# P18.1 — E2E Acceptance Report

Real live stack: `scripts/serve-mission-control.mjs` on `:8791`, built `dist/` server + `apps/mission-control-ui/dist` SPA, durable `PAIR_MC_DIR` (WAL sqlite), real Codex subscription lane `codex-cli:gpt-5.6-sol` (planner + CEO via `PAIR_CEO_MODEL`), DSH `agnes` liveness-registered only, auto-driver enabled (5s interval). Browser: Playwright Chromium (headless, real DOM interaction — no text-only assertions). Script: `docs/e2e-v181/p181-live.mjs` — self-seeds a fresh business + agent + 3 objectives per run.

## Final result: **39/39 PASS** (post-audit build `f5c329b`)

| Scenario | Result | Evidence |
|---|---|---|
| S1 objective created THROUGH the UI form | PASS | `ui-probe` rendered in list |
| S2 advisory preview + DEPENDS_ON create via UI | PASS | preview `advisory:valid`; edge `REL_*` listed ACTIVE; admission strip shows "must wait on producer" |
| S3 scheduler blocks unsatisfied dependent | PASS | `driver_missing = ["UPSTREAM_UNMET"]` live; ops monitor renders the canonical gate |
| S4 SUPERSEDES recovery→producer via UI | PASS | edge ACTIVE; consumer admission `superseded_by=[]`; producer admission sees recovery |
| S5 canonical recovery releases the gate | PASS | FULL canonical path — real CEO bootstrap `DISPATCHED` (workstream bound + mission minted) → KPI progress → `TARGET_MET_CANDIDATE` `REV_*` → in-flight work items cancelled via governed seam → owner sign-off `200` → `ACHIEVED` → `UPSTREAM_UNMET` cleared |
| S6/S7 duty assign via UI + canonical coverage | PASS | company page duty form → `DUT_*` covering `[consumer, producer]` exact set; agent duties API confirms |
| S8/S9 relation lifecycle via UI | PASS | suspend → `SUSPENDED` canonically + admission upstream cleared; resume → `ACTIVE` + upstream back; revoke → confirm dialog → `REVOKED` terminal |
| S10 policy disable | PASS | `auto-policy` disable `200` → `effective=false` |
| S11 ops monitor + integrity | PASS | operations panel + `CLEAN` integrity live |
| S12 review pending in Inbox | PASS | real CEO pass minted `TARGET_MET_CANDIDATE` `REV_*`; Inbox shows it |
| S13 owner sign-off VIA UI | PASS | Inbox "Accept ACHIEVED" → confirm dialog → objective `ACHIEVED` (post work-item cancel — canonical active-work gate) |
| S14 reload persistence | PASS | canonical relations survive reload |
| S15 adversarial | PASS ×9 | forged owner `403`, absent header `403`, unknown kind `409`, bad schema `400`, foreign duty read `403`, foreign transition `403`, invalid endpoint `404`, cross-business relation `403`, cross-business duty `403`, idempotent replay converges |

## Automated regression

- `pair-p18-1-operator-seams.test.ts`: **11/11** — create/read/lifecycle/authority/scope/schema/idempotency/CAS/preview-advisory/integrity-wedge over real HTTP; post-audit additions assert ACHIEVED/INFEASIBLE/EXPIRED/BLOCKED → `400` on the operator transition seam and foreign-target preview suppression.
- P16 suites: **103/103** (brain context, reasoning brief, CEO brief, read grants, capability gap, scope tenancy).
- P18 suites: **106/106** (relation, portfolio, parallel gating, handoff, duty, recovery, operator seams).
- `tsc --noEmit`: clean (server + UI). UI build: pass (chunk-size warning only).

## Evidence

- Screenshots: `docs/e2e-v181/evidence/` — `s2-relations.png` (detail: relation form + duty picker), `s6-company.png` (cockpit: objectives, operations table, relations graph, duties), `s11-opsmonitor.png`, `s12-inbox.png`, `ui-final.png`.
- Live API evidence in run log: relation ids `REL_*`, review ids `REV_*`, mission `MSN_*` dispatched by real CEO bootstrap, work-item cancels `200`, sign-off `200`, gate transitions `UPSTREAM_UNMET → cleared`.
- Codex calls this mission: bootstrap + review passes ×2 objectives per run (real `gpt-5.6-sol` completions — subscription lane, no paid API fallback).

## Acceptance matrix

| Gate | Result |
|---|---|
| PR #148 closure | **MERGED** `85e2244` |
| Owner Relations API | PASS |
| Objective Relations UI | PASS |
| Agent Duty API/UI | PASS |
| Objective Operational Controls | PASS |
| Scheduler/Driver Observability | PASS |
| Real Browser E2E | PASS (39/39) |
| Security & Authority Regression | PASS (11/11 seams + adversarial live + suites) |
| Independent Audit | PASS — fix-then-ship, all HIGH/MED closed + re-audit notes below |

## Method notes (honest)

- The recovery gate-release is exercised through the complete canonical path (CEO pass → review → sign-off); no owner-declared ACHIEVED shortcut remains — the transition seam rejects it post-audit.
- Sign-off canonically requires all objective work items terminal; the E2E resolves in-flight delegated work via the existing `/work-items/:id/cancel` governed seam after a bounded real-mission window.
- Codex subscription rate limits bound repetition; each run costs ~4 real CEO passes. DSH execution path never invoked.
- Screenshots `s2/s6/s11/s12/ui-final` were captured on the pre-audit UI build; the post-audit UI is pixel-identical (audit fixes touched no rendered markup) and the 39/39 run re-verified every page functionally.
