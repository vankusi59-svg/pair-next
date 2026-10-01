# PAIR NEXT — POST-P14 PHASE B: PLANNER RELIABILITY + DURABLE PINNED PLAN

Classification: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`

## 1. Scope

Phase B hardens the planning path end-to-end:

- **A** — Canonical planner model pool with deterministic multi-route failover and structured failure classification.
- **B** — Canonical `planner_attempt` provenance records persisted per invocation.
- **C** — Durable `mission_plan_preview` authority: the exact plan approved by the operator is the exact plan committed and executed, atomically, restart-safe, idempotent.
- **D** — Long-planner latency evidence gathered live; sync path retained (no async job) because measured latency is well under request budgets.

Non-goals (explicitly deferred): DSH execution failover / RE_ROUTE redesign, approval/recovery/scheduler remediation, `.imported` discovery fix, Brain Layer, P15/P16, any UI redesign beyond the minimal preview_id plumbing.

## 2. Lineage

- Canonical base: `54cb8952b9c0e5bcc33b852090b73a113b3d134c` — post-P14 main HEAD including merged Phase A (`R2` remediation complete).
- Working branch: `devin/post-p14-phase-b-planner-reliability`, created from `origin/main` after Phase A merged.
- No commits, file contents, or workarounds were merged, cherry-picked, or rebased from PR #17 or PR #18.
- `git merge-base --is-ancestor 54cb895 HEAD` verified.

## 3. Invariants implemented

1. `THE EXACT PLAN APPROVED BY THE OPERATOR MUST BE THE EXACT PLAN COMMITTED AND EXECUTED` — `confirmPlanPreview` reloads the persisted `mission_plan_preview`, verifies digest + expiry + operator, revalidates `canonical_tasks` through the same deterministic validator used at preview time, and commits those exact rows verbatim via `pinned_plan_tasks`.
2. `PlannerModelPool ∩ DshExecutionModelPool = ∅` — enforced statically at startup (any route appearing in both pools aborts before listen) and canonically via `assertCanonicalModelRoleStateDisjoint` over stored `model_role_assignment` rows (including proven aliases).
3. Failover NEVER uses a `DSH_EXECUTION` model — candidates are constructed only from the configured planner route lists; `assertPlannerModelRole` (IntegrityError on any non-PLANNER_COORDINATOR active assignment) is re-run per invocation inside the failover loop.
4. No eligible planner → FAIL CLOSED — `runPlannerFailover` throws `FAIL_CLOSED_PLANNER_EXHAUSTED` carrying structured per-route evidence; no fake/template T1 is generated after a failover attempt starts.

## 4. Part A — planner pool + failover

New module `src/pair/planner-pool.ts`:

- `PLANNER_FAILURE_CLASS` — warning-code → failure-class map:
  `REQUEST_TIMEOUT→TIMEOUT`, `HTTP_401/403→AUTH_REJECTED`, `HTTP_402/429→QUOTA_RATE_LIMITED`, `HTTP_404/410→MODEL_UNAVAILABLE`, `HTTP_5xx/other→PROVIDER_UNAVAILABLE`, `NO_JSON/UNBALANCED_JSON→MALFORMED_RESPONSE`, `NO_TASKS→EMPTY_RESPONSE`, `ALL_TASKS_INVALID→PLAN_INVALID`, `DEGENERATE_PLAN→PLAN_DEGENERATE`, `NO_CREDENTIAL→CREDENTIAL_MISSING`, `REQUEST_ERROR→NETWORK_ERROR`.
- `classifyPlannerFailure(warnings)` — deterministic first-match classification from `llmPlan` warnings.
- `PlannerCandidate` — resolved route identity: `{model_entry_id, route, provider, model, endpoint, credentialEnv}`.
- `runPlannerFailover({candidates, planFn, assertRole, now?})` — iterates candidates in configured order (primary → fallback → extras). Per candidate: `assertRole(candidate)` (IntegrityError → propagate, never failover past a role/authority problem), then `planFn(candidate)`. First **fully valid** whole plan wins; partial task composition is never attempted. Each attempt produces a `PlannerAttemptRecord` (outcome SUCCESS/FAILED, failure_class, warnings, latency, plan_digest for the winner). Throw on unexpected planFn error → `NETWORK_ERROR` attempt then continue. Exhaustion → `IntegrityError("FAIL_CLOSED_PLANNER_EXHAUSTED", JSON.stringify({attempts, routes:[{route,provider,model_entry_id,model,failure_class,completed_at}]}))`.
- `dedupePlannerCandidates(candidates)` — dedupe AFTER resolution by canonical `model_entry_id` (two routes pointing at the same entry collapse; alias resolution happens upstream in `resolveConfiguredModelRoleRoute`).

Failover-eligible classes: `TIMEOUT`, `QUOTA_RATE_LIMITED`, `MODEL_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, `MALFORMED_RESPONSE`, `EMPTY_RESPONSE`, `PLAN_INVALID`, `PLAN_DEGENERATE`, `CREDENTIAL_MISSING`, `NETWORK_ERROR`, `AUTH_REJECTED` (per-route — a different route may hold valid credentials).
Fail-closed-non-failover: `IntegrityError`/`PolicyError` (role violation, authority conflict, tamper) propagate immediately — they are authority failures, not planner quality issues.

`scripts/serve-mission-control.mjs` wiring:

- `PAIR_PLANNER_MODEL_ROUTE` (required-by-default `gemini:gemini-3.1-flash-lite`), `PAIR_PLANNER_FALLBACK_ROUTE`, `PAIR_PLANNER_EXTRA_ROUTES` (comma-separated).
- Every configured route is resolved through `resolveConfiguredModelRoleRoute` (Phase A R2 strictness — unresolved/malformed → `FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED` before any mutation).
- Static overlap guard: any route string in both planner and DSH lists aborts startup (`FAIL_CLOSED_MODEL_ROLE_OVERLAP`) before role reconciliation.
- `plannerCandidates` = all qualified planner routes; `planExpander` returns `{input, planner:{attempts, winner, warnings, allowed_capabilities, capability_sets}}` so Mission Control can persist canonical attempt rows.

## 5. Part B — planner_attempt provenance

Entity `planner_attempt` (`PA_<ulid>`), one row per invocation inside the same `store.immediate()` as the preview:

```
{ planner_attempt_id, role: "PLANNER_COORDINATOR", route, provider,
  model_entry_id, model, attempt_no, started_at, completed_at,
  latency_ms, outcome: "SUCCESS"|"FAILED", failure_class?,
  plan_digest? (winner only), winner: bool, project_id, preview_id }
```

- Events `PLANNER_ATTEMPT_SUCCEEDED` / `PLANNER_ATTEMPT_FAILED` per row; `winner` true only on the selected attempt.
- No credentials, request/response bodies, or raw LLM output are stored — only classified warnings + digests (asserted by test: serialized row contains no credential env value).
- Provenance chain: `preview.planner_attempt_id` → `PA_*` row → `model_entry` via `model_entry_id`; mission metadata stores `pinned_plan.{preview_id, plan_digest, planner_attempt_id, planner}`.

## 6. Part C — durable pinned plan

New module `src/pair/plan-preview.ts`; entity `mission_plan_preview` (`MPP_<ulid>`):

```
{ preview_id, project_id, operator_id, effective_input_digest, plan_digest,
  canonical_tasks[], mission_input, planner_attempt_id, planner,
  plan_source, plan_model, warnings, created_at, expires_at,
  state: READY|CONSUMED, consumed_mission_id?, version }
```

Digests (canonical.ts `digest()` — sorted-key sha256):

- `effective_input_digest = digest({effective_planning_input:1, project_id, goal, granted_permissions, authorized_workspaces, risk_ceiling, operator_id, allowed_capabilities, capability_sets})` — covers every authority field including capability caps.
- `plan_digest = digest({plan:2, project_id, effective_input_digest, tasks, granted_permissions, authorized_workspaces, risk_ceiling})`.

`createPlanPreview` (inside `store.immediate()`):

1. Reject `input.mission_id` up front (`FAIL_CLOSED_MISSION_ID_PUBLIC` — keeps the FOUND-V2 409-before-any-rows contract at the preview layer too).
2. Re-run deterministic `validatePlanProposal` over the expanded tasks (planner output never bypasses proposal validation).
3. Persist all `planner_attempt` rows + events + the `READY` preview row atomically.
4. Response fields are read back from the persisted row — the operator approves exactly what is stored, not an ephemeral render.

`confirmPlanPreview({preview_id, plan_digest, operator_id})` (inside `store.immediate()`):

1. `verifyPlanPreviewForConfirm` ordered checks: NOT_FOUND → 404; **plan_digest mismatch → `FAIL_CLOSED_PLAN_DIGEST_MISMATCH` BEFORE the CONSUMED check** (a tamper attempt must reject even against a consumed preview — caught during live E2E and fixed); CONSUMED → `{mode:"ALREADY_CONSUMED", mission_id}` (idempotent retry returns the already-created mission); EXPIRED (`now > expires_at`) → `FAIL_CLOSED_PLAN_PREVIEW_EXPIRED`, no auto-regeneration; operator mismatch → `FAIL_CLOSED_PLAN_PREVIEW_OPERATOR`.
2. Revalidate `canonical_tasks` through `validatePlanProposal` again at confirm time — a tampered stored task list fails validation, cannot commit.
3. `createMissionFromPreview` — reuse the exact Phase-P12/P13 agent/business/secret pinning seam; `metadata` carries `pinned_plan` + `pinned_plan_tasks` (verbatim) + `plan_source`/`plan_model` provenance; `planner()` returns `pinned_plan_tasks` untouched so committed plan ≡ persisted canonical plan.
4. `consumePlanPreview` — CAS `READY→CONSUMED`, `PLAN_PREVIEW_CONSUMED` event, `consumed_mission_id` recorded. ONE preview → AT MOST ONE mission.

TTL: `PAIR_PLAN_PREVIEW_TTL_S` env (default 1800, bounds 30–86400 via Phase A validated env helper).

## 7. Failover with no eligible planner

All candidates fail → `FAIL_CLOSED_PLANNER_EXHAUSTED`. The detail string is a JSON diagnostics object (per-route model_entry_id, failure_class, completed_at) — no credentials. No synthetic/TEMPLATE task is produced on the failover path. Verified live (§12) and by tests 5–6.

## 8. Empty plan lists

`planFn` returning zero tasks (or all-invalid) is a classified `FAILED` attempt (`EMPTY_RESPONSE`/`PLAN_INVALID`) and the next candidate is tried — an empty "success" is never committed.

## 9. Scheduled missions (§20 of spec)

`tickSchedules` calls `createPlanPreview` → `confirmPlanPreview` in the same invocation: the expander runs the planner once, the resulting canonical plan is persisted, verified, and consumed through the identical seam — no second planner run, no bypass of the preview authority.

## 10. API + UI integration (minimal)

`mission-control-server.ts`:

- `POST /api/missions/preview` → expander `{input,planner}` → `createPlanPreview` → response from persisted row.
- `GET /api/plan-previews/:id` → `{preview, planner_attempts}` (sorted by attempt_no).
- `POST /api/missions/confirm` → `confirmPlanPreview` (requires `preview_id` + `plan_digest` + operator).
- `POST /api/missions` → if `confirm_plan.preview_id` present → `confirmPlanPreview`; else legacy path now goes preview→confirm internally (planner runs once at preview).

`apps/mission-control-ui`: `previewMission` returns `preview_id`; `MissionNew.tsx` sends `confirm_plan:{digest, preview_id}` and no longer echoes `metadata.llm_plan` (the preview row is the authority, not a client-echoed plan copy). Telegram bridge path unchanged — it issues `/api/missions` which now routes through preview+confirm internally; deliverable forwarding (`outbox/*`) semantics unchanged (planner outbox emission is a separate deferred gap).

## 11. Part D — long-planner latency evidence

Measured on the live isolated instance (`PAIR_MC_DIR=~/pair-mc-b1`, :8797), real Gemini calls:

- Full LLM plan call (gemini-3.1-flash-lite, ~2–4 task plans): **1623–3226 ms** observed across runs.
- Preview round-trip (expand + validate + persist + respond): well under 5 s end-to-end.
- vs `PAIR_LLM_PLANNER_TIMEOUT_MS` default 20000 ms and UI fetch budget: comfortably synchronous.

Decision: **synchronous preview retained; no async planning job implemented**. An async job would add a second authority surface (job state + result materialization) for no measured need. If a future planner consistently exceeds ~10 s, the preview seam already isolates where async materialization would attach (preview row stays `READY`, confirm polls) — recorded as a deferred option, not built.

## 12. Live E2E evidence (isolated instance `~/pair-mc-b1`, port 8797, token `test-b`)

Boots with disjoint pools (planner = [deadplan|gemini|cloudflare], DSH = groq):

| Check | Result |
|---|---|
| Preview persist + provenance | `MPP_01M3TX0HP365KSGACD7VP7MHZW` created READY; attempt `PA_01M3TX0HP32SDHEFTSFTJGNSTS` gemini SUCCESS 3226 ms winner |
| Confirm → mission exact pinned tasks | `MSN_01M3TX4R6C28E4Q86XTNB0J91G` committed tasks T1–T4 identical (key+title) to preview `MPP_01M3TX2P553DY3G9ZG6S8XY5MC` canonical_tasks; digest `e94760…` matches |
| Idempotent retry | second confirm → `ALREADY_CONSUMED` returns same mission, no duplicate |
| Unknown preview | 404 |
| Tampered digest on CONSUMED preview | 409 `FAIL_CLOSED_PLAN_DIGEST_MISMATCH` (reorder fix verified live) |
| Wrong operator | 409 `FAIL_CLOSED_PLAN_PREVIEW_OPERATOR` |
| Correct operator | mission `MSN_01M3TX28QE7GM61VHR51255EK6` created |
| Restart-safe | preview created on prior process confirmed after server restart → `MSN_01M3TX4R6C28E4Q86XTNB0J91G` |
| Expiry | `PAIR_PLAN_PREVIEW_TTL_S=30`; preview `MPP_01M3TX50AHZSQDAT94SR478GKT` expired → `FAIL_CLOSED_PLAN_PREVIEW_EXPIRED`, no auto-regen |
| Failover SUCCESS | planner=[deadplan, gemini, cf]: attempt1 deadplan FAILED `MALFORMED_RESPONSE` 5 ms → attempt2 gemini SUCCESS 1623 ms winner; preview planner = gemini (the fallback, not the primary) |
| Failover EXHAUSTED | `PAIR_LLM_PLANNER_TIMEOUT_MS=2000`: gemini TIMEOUT + cloudflare TIMEOUT → `FAIL_CLOSED_PLANNER_EXHAUSTED` with structured per-route evidence; no fake plan |
| Role isolation | attempts only ever hit planner-pool routes; DSH pool untouched by planning |

Fake-provider harness note: `deadplan` was a temporary `settings.yaml` provider pointing at a local 200-garbage endpoint (qualified at probe, malformed at plan) used solely to make failover deterministic; removed from settings after evidence capture.

## 13. Focused tests — `src/__tests__/pair-phase-b.test.ts` (37 tests)

Failover (1–16): ordered winner; fallback win; extras tried in order; EXHAUSTED carries per-route diagnostics; dedupe after resolution (same entry via two routes → one candidate); full failure-class matrix; IntegrityError (role tamper) propagates without failover; first FULLY VALID plan wins (no partial composition); attempt evidence fields complete; unexpected throw → NETWORK_ERROR then failover; warnings sanitized (no credential material); `assertRole` re-invoked per candidate per call.

Pinned plan (17–36): READY row + attempt persisted atomically; response fields = persisted row; effective_input_digest covers all authority fields incl. caps (same input → same digest; changed cap/permission/workspace/risk/operator/goal → different); plan_digest deterministic & order-sensitive; confirm consumes + creates mission; committed tasks = canonical verbatim; idempotent retry returns same mission; digest/unknown/expired/operator rejections; partial-failure atomicity (no orphan rows); restart-safe (new store instance over same DB confirms); winner flag + winner-only plan_digest; no credentials in serialized rows/events; provenance chain preview→attempt→model_entry; tampered canonical_tasks rejected at confirm revalidation; `preview_id` required on confirm; TTL env bounds (30–86400); planner invoked exactly once per mission.

Role isolation (37): planner route whose model is revoked/reassigned to DSH → `assertRole` throws → fail closed, never borrowed into planning.

## 14. Regression

- Typecheck (`npx tsc --noEmit`): clean.
- Build (`pnpm build`): clean.
- Focused Phase B: **37/37 pass**. Phase A suite: 60/60 pass.
- Full suite (Node 22): **2330 pass / 2 fail / 15 skip** — the 2 failures are the pre-existing environment artifact (codex/dsh executables installed under `~/.nvm` while the test masks only `~/.local`), reproduced identically on base `2277319` during Phase A; unchanged by this work.
- P9/P11/P12/P13/P14 suites: pass (schedule/pinning tests updated only where the preview seam legitimately changed provenance metadata shape — `plan_source` semantics preserved via `miMeta` passthrough).

## 15. Known limitations / waivers

- `.imported` discovery gap remains deferred (per mandate) — but with R2 strict resolution, a missing DSH catalog now fails closed at boot instead of silently shrinking pools.
- Deliverables landing outside `outbox/` are not forwarded to Telegram — planner does not emit outbox-write ops; separate planner-quality gap, not a pinned-plan authority issue.
- Async planning job intentionally not built (§11 evidence).
- `previewMission` legacy digest field retained for compatibility alongside the canonical `plan_digest`.

## 16. Commit list

- `B-phase`: planner pool + failover (`src/pair/planner-pool.ts`), plan preview authority (`src/pair/plan-preview.ts`), mission-control + server wiring, serve-mission-control routes/candidates, env-config TTL, UI preview_id plumbing, 37 focused tests, this report.

(Exact SHAs recorded at push time — see git log of `devin/post-p14-phase-b-planner-reliability`.)

## 17. STOP

PR opened against `main`. **DO NOT MERGE** — awaiting independent audit.

Classification: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`
