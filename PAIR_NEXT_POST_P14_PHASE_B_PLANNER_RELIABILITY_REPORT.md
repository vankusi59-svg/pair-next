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

- `331f62f` — Phase B: planner pool + failover (`src/pair/planner-pool.ts`), plan preview authority (`src/pair/plan-preview.ts`), mission-control + server wiring, serve-mission-control routes/candidates, env-config TTL, UI preview_id plumbing, 37 focused tests, this report.

Branch HEAD at submission: `331f62f` on `devin/post-p14-phase-b-planner-reliability`.

## 17. STOP

PR opened against `main`. **DO NOT MERGE** — awaiting independent audit.

Classification: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`

---

# INDEPENDENT AUDIT — R1 REMEDIATION (audited HEAD `9216510ed665f3926d2312847ee5eb20a30a2606`)

Audit result: `PHASE B = BLOCKED, R1 REMEDIATION REQUIRED`. All three blockers remediated below; no new PR, no merge, no Phase C work.

## R1-§1–2 — Zero-eligible pool now fails closed (was: silent template fallback)

Before R1, `planExpander` computed an empty `candidates` list and fell through to `return { input }` → the mission silently degraded to the deterministic TEMPLATE-T1 path. Now:

- `runPlannerFailover` throws `IntegrityError("FAIL_CLOSED_PLANNER_NO_ELIGIBLE")` when `candidates.length === 0` — the function itself can never produce a zero-candidate result.
- `planExpander` additionally checks BEFORE invoking failover (`PLANNER_ROUTES.length && !candidates.length` → `FAIL_CLOSED_PLANNER_NO_ELIGIBLE` carrying `configured_routes` diagnostics) so a configured-but-empty pool fails closed even before failover is entered.
- The `planner_run` row is opened BEFORE the check, so a zero-eligible request still leaves durable canonical evidence: `planner_run {state:FAILED, error_code:FAIL_CLOSED_PLANNER_NO_ELIGIBLE, attempts:0}`.
- Server error map already maps `FAIL_CLOSED_*` → **409**; both `/api/missions/preview` and `/api/missions` return the same code (live-verified identical). No `mission_plan_preview`, no `mission`, no `canonical_tasks`, no TEMPLATE-T1 is ever written on this path. The scheduled-mission path routes through the same `planExpander` seam and therefore fails identically.

## R1-§3–5 — Every planner invocation has durable canonical attempt evidence

New canonical entity `planner_run` (`PRN_*`): `{planner_run_id, project_id, operator_id, routes[], attempts, state RUNNING→WINNER_SELECTED|EXHAUSTED|FAILED, winner_attempt_no, preview_id, error_code, started_at, completed_at}`.

Lifecycle persistence lives in `src/pair/plan-preview.ts`, each step its own `store.immediate()` transaction:

- `beginPlannerRun` → run row RUNNING + `PLANNER_RUN_STARTED` event.
- `persistPlannerAttemptStart` → `planner_attempt` (`PA_*`) row with `outcome:"STARTED"` BEFORE the model is invoked + `PLANNER_ATTEMPT_STARTED` + `run.attempts++`. A crash after STARTED still leaves the auditable invocation.
- `settlePlannerAttempt` → same row updated to `SUCCESS|FAILED` (completed_at, latency_ms, failure_class, sanitized warnings, winner, plan_digest) + `PLANNER_ATTEMPT_SUCCEEDED|FAILED`.
- `finishPlannerRun` → run `WINNER_SELECTED|EXHAUSTED|FAILED` + matching event. `onExhausted` fires before the `FAIL_CLOSED_PLANNER_EXHAUSTED` throw, so exhaustion persists every failed attempt + the EXHAUSTED event — nothing depends on preview creation anymore.
- `createPlanPreview` accepts `planner_run_id` and atomically (single immediate): validates the run exists → links `run.preview_id` → attaches `preview_id` to every attempt of that run → stamps `winner:true` + `plan_digest` on the winner. Legacy `attempts[]` arg path retained for in-process callers with no run.
- `planPreview()` read returns `{preview, planner_attempts, planner_run}` so the audit can reconstruct attempted routes from canonical state alone (verified live + across store reopen in test 40).

## R1-§6–8 — Canonical validation INSIDE failover — first FULLY VALID whole plan wins

`runPlannerFailover` accepts `canonicalize(tasks, candidate)`: candidate raw output → sanitize/deterministic prep → `validatePlanProposal` → only a fully-valid whole list can win. A canonicalize rejection is a model-output failure → `FAILED/PLAN_INVALID` + warning `CANONICAL_VALIDATION_FAILED` (or `_EMPTY` for an all-dropped list) → next candidate. This is NOT an authority signal and never propagates.

ONE canonical task-preparation seam is shared end-to-end: the serve seam `canonicalizeLlmTasks` (sanitize + expected_output_contract injection for AUTOMATON_TASK_EXECUTION tasks) is run inside failover via `canonicalize:` and then `validatePlanProposal` against `knownCapabilityIds()`; the winner returns that exact canonical list; `createPlanPreview` persists it as `canonical_tasks`; confirm revalidates the same list; the mission executes it verbatim. No model re-invocation, no second transformation — `mission.metadata.llm_plan`/`pinned_plan_tasks` ≡ `preview.canonical_tasks` ≡ failover winner tasks (live-verified).

## R1-§9–10 — Per-invocation canonical eligibility revalidation

New `assertPlannerCandidateEligible(store, model_entry_id)` in `model-role.ts` — reuses existing authorities, no duplicate qualification logic:

1. `assertPlannerModelRole` — entry exists, holds active PLANNER_COORDINATOR, not REMOVED/DEPRECATED/BLOCKED.
2. Provider row `providerEntryId(provider_id)` must exist with `lifecycle_state ∈ PROVIDER_OK_STATES` (QUALIFIED / MODEL_DISCOVERY_ELIGIBLE) else `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`.
3. Candidate must not be canonically a DSH_EXECUTION model: every active DSH assignment is compared via `sameCanonicalModel` (entry_id OR provider_family+alias match) → `FAIL_CLOSED_PLANNER_DSH_OVERLAP`.

All failures are IntegrityError → propagate, never failover-eligible. Runs before EVERY invocation (revoked role pre-invocation → fail closed; model REMOVED between boot and call → not invoked; provider no longer eligible → not invoked; DSH model/alias can never be borrowed).

## R1-§11 — Pinned-plan invariants preserved

All Phase B §11 semantics unchanged and re-verified live post-R1: READY→CONSUMED, TTL env, digest-before-consumed ordering, restart-safe durable consume, atomic consume+mission transaction, one-preview-one-mission, idempotent retry returns same mission, wrong digest rejected even on CONSUMED previews, no second LLM invocation at confirm.

## R1-§12 — Provenance chain (live-verified)

operator → `planner_run` (PRN_01M3TZ8PBWZ6ET3N00HAKT5611) → attempts (PA_…PBXW deadplan FAILED MALFORMED 6 ms, PA_…PC4P cf SUCCESS 38 984 ms winner) → preview (MPP_01M3TZ9WEEZQJR3AC81QW0C3V6, linked atomically) → plan_digest `ca7e6b11…` → confirm → mission (MSN_01M3TZAJJB62BBXJN718SPDZJW, `metadata.pinned_plan` carries preview_id + planner_attempt_id + digest) → exact committed tasks.
Exhausted path: `planner_run{EXHAUSTED}` → durable FAILED attempts → `FAIL_CLOSED_PLANNER_EXHAUSTED` 409 → no preview/mission.

## R1-§13 — New focused tests (11 added, 48 total in `pair-phase-b.test.ts`)

- 38: zero candidates → `FAIL_CLOSED_PLANNER_NO_ELIGIBLE`, planFn never invoked.
- 39: zero-candidate request → no preview/mission/attempt rows; run persisted FAILED + NO_ELIGIBLE.
- 40: exhaustion → run EXHAUSTED + 2 durable FAILED attempts (TIMEOUT, PROVIDER_UNAVAILABLE) readable after store REOPEN; events reconstructable (RUN_EXHAUSTED + 2×ATTEMPT_FAILED); zero preview/mission.
- 41: failover success → STARTED→settled durable attempts; preview links run atomically; winner carries digest; detail endpoint returns run+attempts.
- 42: A non-empty plan failing `validatePlanProposal` (unknown capability) → PLAN_INVALID → B wins; `CANONICAL_VALIDATION_FAILED` warning.
- 43: all candidates canonical-invalid → EXHAUSTED + every attempt durable.
- 44: role revoked pre-invocation → IntegrityError propagates (no invocation).
- 45: model REMOVED pre-invocation → fail closed, zero invocations.
- 46: provider not in PROVIDER_OK_STATES → `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`; restored → eligible.
- 47: DSH_EXECUTION model / proven DSH alias → `FAIL_CLOSED_PLANNER_DSH_OVERLAP`; unrelated planner clean.
- 48: one seam — failover canonical tasks ≡ stored `canonical_tasks` ≡ response plan.

(Existing 37 R0 tests updated only for the `assertRole:`→`assertEligible:` param rename — semantics unchanged.)

## R1-§14 — Regression

- Typecheck clean; `pnpm build` clean.
- Focused: **48/48** Phase B; Phase A 60/60.
- Full Node 22 suite: **2341 pass / 2 fail / 15 skip** — the 2 failures remain the pre-existing environment artifact reproduced on base `2277319` (executables under `~/.nvm` invisible to the test's `~/.local` mask).

## R1-§15 — Live validation (isolated `PAIR_MC_DIR=~/pair-mc-b1`, port 8797, `PAIR_LLM_PLANNER_TIMEOUT_MS=90000`)

| Case | Result |
|---|---|
| A valid primary/fallback win | `PRN_01M3TZ8PBWZ6ET3N00HAKT5611` WINNER_SELECTED: attempt1 deadplan FAILED `MALFORMED_RESPONSE` 6 ms → attempt2 cf SUCCESS 38 984 ms winner; preview `MPP_01M3TZ9WEEZ…` linked atomically (run.preview_id + attempts.preview_id + winner plan_digest); confirm → `MSN_01M3TZAJJB62BBXJN718SPDZJW`, committed tasks ≡ pinned canonical_tasks |
| B all fail → EXHAUSTED | `planner_run{EXHAUSTED,attempts:1}` + durable `PA_* FAILED MALFORMED_RESPONSE` (preview_id null); earlier boots also produced 2 TIMEOUT-exhausted runs with durable attempts; 409; no preview/mission rows |
| C zero-eligible | planner=[deadplan] with endpoint down (probe FAIL at boot) → `/api/missions/preview` **and** `/api/missions` both 409 `FAIL_CLOSED_PLANNER_NO_ELIGIBLE`; run row `{FAILED, error_code:NO_ELIGIBLE, attempts:0}` durable; zero preview/mission/T1 |
| D canonical-invalid primary | fake provider returns valid-JSON plan that sanitizes to degenerate/dup keys → attempt FAILED `PLAN_INVALID` → cf SUCCESS winner (run `PRN_01M3TZD600…`) |
| E restart persistence | preview `MPP_01M3TZE8H48TG9VAYS9QAE6KJE` created pre-restart; new process confirmed it post-restart → `MSN_01M3TZMD76BQPGCEAR2VVVQYYE` tasks ≡ canonical_tasks; preview CONSUMED |
| F duplicate confirm | same `preview_id`+digest retried → 200 same mission_id (idempotent) |
| G wrong digest after consume | `plan_digest:"deadbeef"` on CONSUMED preview → 409 `FAIL_CLOSED_PLAN_DIGEST_MISMATCH` |

`deadplan` is a deterministic harness provider (local 127.0.0.1:8799 returning either 200-garbage or an invalid plan body) — removed from `settings.yaml` after evidence capture.

## R1 — files changed

- `src/pair/planner-pool.ts` — NO_ELIGIBLE throw; `canonicalize` seam; STARTED→settled lifecycle via `onAttemptStart/onAttemptEnd/onExhausted` hooks; attempt record gains `outcome/planner_run_id/preview_id`.
- `src/pair/model-role.ts` — `assertPlannerCandidateEligible` (role + provider lifecycle + DSH-alias overlap).
- `src/pair/plan-preview.ts` — `planner_run` entity + `beginPlannerRun/persistPlannerAttemptStart/settlePlannerAttempt/finishPlannerRun`; `createPlanPreview` run-linking.
- `src/pair/mission-control.ts` — `planner_run_id` plumbing + `planPreview()` returns run.
- `scripts/serve-mission-control.mjs` — `canonicalizeLlmTasks` seam; durable-run failover wiring (run before zero-eligible check); NO_ELIGIBLE.
- `src/__tests__/pair-phase-b.test.ts` — +11 R1 tests (48 total).

Classification remains: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`

---

# INDEPENDENT AUDIT — R2 REMEDIATION (audited HEAD `b831dece55b817b0178cfcefde20c8d7056c58b8`)

Audit result: `PHASE B = STILL BLOCKED, R2 REQUIRED` — runtime eligibility did not prove canonical model qualification or provider auth/health gates. Remediated below.

## R2-§2–3 — Shared canonical eligibility authority (no second system)

New shared projection `providerModelEligibility(store, provider_id, model_entry_id)` extracted in `src/pair/model-routable.ts` — the exact provider+model gate subset of `projectRoutableModels` (which now delegates to it), so planner eligibility and routing eligibility evaluate the SAME canonical gates and cannot disagree:

- PROVIDER_QUALIFIED — row exists + lifecycle ∈ PROVIDER_OK_STATES
- PROVIDER_AUTH_OK — auth_state ∈ {AUTH_OK, AUTH_REQUIRED}
- PROVIDER_HEALTH_OK — health_state ∉ {UNAVAILABLE, DOWN}
- PROVIDER_NOT_BLOCKED — conditions lack DISABLED/UNQUALIFIED
- MODEL_QUALIFIED — `lifecycle_state === "QUALIFIED"` (the `issueQualificationReceipt` authority)
- MODEL_NOT_STALE — no STALE/REMOVED condition
- MODEL_NOT_REVOKED — no REMOVED/DEPRECATED/BLOCKED condition
- MODEL_AVAILABLE — no UNAVAILABLE condition

`assertPlannerCandidateEligible` (unchanged name/signature intent) now: `assertPlannerModelRole` → DSH-overlap (proven aliases included) → `providerModelEligibility` → two verdict channels. Executor/binding-specific gates (EXECUTOR_*, BINDING_QUALIFIED) are NOT applied — planner routes are not DSH bindings.

## R2-§4 — Documented failure classification

**AUTHORITY / GOVERNANCE → IntegrityError, propagates, NEVER failover-eligible:**
- role missing/revoked/mismatch; model REMOVED/DEPRECATED/BLOCKED (`assertPlannerModelRole`)
- candidate is or proven-aliases a DSH_EXECUTION model (`FAIL_CLOSED_PLANNER_DSH_OVERLAP`)
- provider absent / lifecycle not canonically eligible / auth not OK / DISABLED|UNQUALIFIED condition (`FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`)

**TEMPORARY AVAILABILITY → failover-eligible rejection `{reject:true, failure_class, reason}` — model never invoked, next candidate may win:**
- model lifecycle no longer QUALIFIED → `MODEL_UNAVAILABLE`
- model condition STALE or UNAVAILABLE → `MODEL_UNAVAILABLE`
- provider health DOWN/UNAVAILABLE → `PROVIDER_UNAVAILABLE`

`runPlannerFailover` contract widened: `assertEligible` may return void (eligible), `{reject:true,...}` (availability → durable FAILED attempt + `ELIGIBILITY_REJECTED:<gate>` warning → next candidate), or throw (authority → propagate). The STARTED attempt row is now persisted BEFORE eligibility runs, so even eligibility-rejected and authority-aborted invocations are auditable.

## R2-§5 — Tests added (11; 59 total)

49A DISCOVERED→MODEL_UNAVAILABLE reject→fallback wins · 50B PROBED→reject · 51C QUALIFIED all-gates→eligible · 52D post-boot downgrade→not invoked · 53E STALE→reject · 54F UNAVAILABLE→reject+fallback wins · 55G AUTH_FAILED→authority 409 no failover · 56H health DOWN→PROVIDER_UNAVAILABLE+fallback · 57I DISABLED/UNQUALIFIED→authority throw · 58J healthy→invoked · 59 §7 single-candidate qualification-loss→EXHAUSTED+durable FAILED attempt+no preview/mission.

## R2-§6 — Fixtures corrected

`mkModel` now models intended state explicitly: `lifecycle` param — `"QUALIFIED"` goes through the real `issueQualificationReceipt` seam (receipt + MODEL_QUALIFIED event), `"DISCOVERED"`/`"PROBED"` set lifecycle directly. `mkProvider` models `lifecycle/auth_state/health_state/conditions`. Prior tests accidentally accepted DISCOVERED; fixed.

## R2-§8 — R1 invariants preserved

Re-verified: NO_ELIGIBLE zero-candidate fail-closed; durable planner_run; STARTED-before-invocation (now also before eligibility); durable EXHAUSTED; canonical validation inside failover; first-fully-valid-whole-plan; one canonical seam; pinned preview identity/digest/TTL; restart-safe + idempotent confirm; one preview → ≤1 mission.

## R2-§9 — Regression

- Focused **59/59** Phase B; Phase A 60/60.
- Full Node 22 suite: **2352 pass / 2 fail / 15 skip** — same pre-existing `~/.nvm` environment artifact reproduced on base `2277319`.
- Typecheck + build clean.

## R2-§10 — Live evidence (isolated `~/pair-mc-b1` :8797; state flipped via canonical-rehash sqlite writes)

| Case | Result |
|---|---|
| healthy QUALIFIED pool | `PRN_01M3V15XC5…`: cf `MALFORMED_RESPONSE` → gemini SUCCESS — failover intact |
| cf QUALIFIED→PROBED pre-invocation | cf `FAILED MODEL_UNAVAILABLE` → gemini SUCCESS (`PRN_01M3V18VP…`) |
| cf STALE | cf `FAILED MODEL_UNAVAILABLE` → gemini SUCCESS (`PRN_01M3V18XT…`) |
| cf provider AUTH_FAILED | **409 `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`** — authority fail-closed, no failover |
| cf provider health DOWN | cf `FAILED PROVIDER_UNAVAILABLE` → gemini SUCCESS (`PRN_01M3V190E…`) |
| ALL planner models DISCOVERED | **409 `FAIL_CLOSED_PLANNER_EXHAUSTED`**: run EXHAUSTED + 2 durable `FAILED MODEL_UNAVAILABLE` attempts (`ELIGIBILITY_REJECTED:MODEL_QUALIFIED`); no preview/mission/T1 |
| pinned preview | still confirmable post-changes → `MSN_01M3V1973MS17YZ4KCZCDC1PT2` |

Note: live catalog carried a stale `UNQUALIFIED` provider condition (set by an earlier failed `qualify()`, not cleared by later re-qualification) — the new `PROVIDER_NOT_BLOCKED` gate correctly flagged it as authority-ineligible; residue cleared for the matrix above. Persisted-condition vs. current-qualification semantics is a pre-existing catalog characteristic, documented here as informational, not changed by R2.

## R2 — files changed

- `src/pair/model-routable.ts` — `providerModelEligibility` shared projection; `projectRoutableModels` delegates to it.
- `src/pair/model-role.ts` — `assertPlannerCandidateEligible` → shared gates + two verdict channels + `PlannerEligibilityRejection` type.
- `src/pair/planner-pool.ts` — `assertEligible` widened contract; STARTED row before eligibility; availability rejection → durable FAILED attempt.
- `src/__tests__/pair-phase-b.test.ts` — R2 fixtures (real qualification seam) + tests 49–59.

Classification remains: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`

---

# R3 — FINAL CLOSURE (independent audit remediation)

Audited R2 HEAD: `1d6718851ab2030aa16f00a7bdd8371e1969e7b6`

## R3-§1–§3 — Provider UNQUALIFIED recovery at the canonical seam

**Blocker:** a failed `ProviderValidator.qualify()` persisted `conditions += "UNQUALIFIED"`, and a later SUCCESSFUL requalification promoted lifecycle + issued a receipt but never removed the historical marker. The R2 `PROVIDER_NOT_BLOCKED` gate then kept a canonically re-qualified provider permanently runtime-ineligible — R2 live testing required manual sqlite residue cleanup, which is unacceptable.

**Fix location:** `ProviderCatalog.issueQualificationReceipt()` (`src/pair/provider-catalog.ts`) — the canonical qualification transition every successful qualification flows through (`ProviderValidator.qualify`, direct seam users, test/live boot qualification). On a successful receipt the provider body is reconciled:

- `UNQUALIFIED` — **removed** (semantics superseded by a current valid receipt).
- `DISABLED` — **preserved** (explicit operator/policy authority, never silently cleared by requalification).
- Every other condition — **preserved**.

No planner-specific "ignore UNQUALIFIED when qualified" logic was added: the authority state itself is now consistent, so the shared `providerModelEligibility` projection (and therefore `projectRoutableModels` and `assertPlannerCandidateEligible`) reads clean authority — planner and routable eligibility cannot disagree.

## R3-§4 — Condition semantics after successful requalification

| Condition | On successful qualification | Reason |
|---|---|---|
| `UNQUALIFIED` | cleared | transient residue of a previous failed attempt; superseded by the current receipt |
| `DISABLED` | kept | operator/policy authority — qualification must not override it |
| other (`STALE`, custom, …) | kept | not superseded by this transition |

## R3-§5–§6 — Planner attempt authority settlement

R2 persisted the `planner_attempt` STARTED row before eligibility for auditability, but a handled authority rejection propagated before the row settled — leaving `run=FAILED` + `attempt=STARTED`, indistinguishable from a process crash mid-invocation.

`runPlannerFailover` now settles the already-durable attempt to terminal `FAILED` with `warnings=["AUTHORITY_REJECTED:<error.code>"]` BEFORE rethrowing, at both propagation points:

1. `assertEligible` throwing an `IntegrityError` (role / DSH-overlap / provider-authority gates).
2. `planFn` throwing an `IntegrityError` mid-invocation.

The original error propagates unchanged — never converted to failover-eligible behavior, never retried on another candidate. Crash semantics preserved: a real crash after STARTED without settlement still leaves a durable STARTED row, so `STARTED` = crashed/interrupted, `FAILED + AUTHORITY_REJECTED` = known governance rejection.

## R3-§7 — Focused tests added (59→67, all pass)

- **60 A–E** — provider DOWN → availability reject; `qualify()` fails → `UNQUALIFIED` persisted → candidate authority-blocked; health restored → requalify succeeds → receipt + `MODEL_DISCOVERY_ELIGIBLE` + `UNQUALIFIED` cleared → `providerModelEligibility` all-PASS → planner eligible → `projectRoutableModels` `routable=true` (all gates) — no manual cleanup.
- **61 F** — `DISABLED` (with `UNQUALIFIED`) survives a successful requalification: `UNQUALIFIED` cleared, `DISABLED` kept, `PROVIDER_NOT_BLOCKED` still FAIL.
- **62 G** — post-recovery AUTH_FAILED → authority throw; health DOWN → `PROVIDER_UNAVAILABLE` availability reject.
- **63** — role revoked → attempt STARTED→FAILED (`AUTHORITY_REJECTED:FAIL_CLOSED_MODEL_ROLE_UNASSIGNED`), `IntegrityError` propagates, run FAILED, **no** candidate invoked, no fallback.
- **64** — provider `AUTH_FAILED` → same terminal-FAILED attempt, `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`, no fallback.
- **65** — provider `DISABLED`/`UNQUALIFIED` → terminal FAILED, no fallback.
- **66** — proven DSH alias overlap → `FAIL_CLOSED_PLANNER_DSH_OVERLAP` propagates, terminal FAILED, no fallback.
- **67** — no authority-rejected attempt remains STARTED; a raw `persistPlannerAttemptStart` row without settlement (simulated crash) stays `STARTED`.

## R3-§8 — R1/R2 invariants re-verified

Shared `providerModelEligibility` projection + `projectRoutableModels` delegation; all 8 provider/model gates; AUTHORITY vs AVAILABILITY channels; durable `planner_run`; STARTED-before-invocation; durable EXHAUSTED; canonical validation inside failover; first-fully-valid-whole-plan; one canonical seam; pinned preview identity/digest/TTL; restart-safe + idempotent confirm; ≤1 mission per preview; Planner/DSH role separation — all unchanged and re-run green.

## R3-§9 — Regression

- Focused **67/67** Phase B tests.
- Full Node 22 suite: **2360 pass / 2 fail / 15 skip** — same pre-existing `~/.nvm` environment artifact (P5 executor registration), reproduced identically on base `2277319`.
- `pnpm exec tsc --noEmit` clean; `pnpm build` clean.

## R3-§10 — Live evidence (isolated `~/pair-mc-b1` :8797)

Settings-level fault injection via `~/.pair-dsh-home/settings.yaml` (new `badq` provider — authority stays in config, not db edits); runtime state flips via canonical-rehash sqlite writes (`payload` + `payload_hash` + `version` kept consistent).

| Step | Evidence |
|---|---|
| Boot B — `badq` endpoint dead; gemini flaky probe fails | `badq` + `gemini` providers: `probe=PROBE_UNREACHABLE`, `cond=['UNQUALIFIED']`, qualify gates `PROTOCOL_PROBED:FAIL` |
| Boot C — `badq` `baseURL` fixed to real groq endpoint (config fix only) | `badq` + `gemini` qualify `PASS` → receipts `PQR_01M3V2NWNC`/`PQR_01M3V2NV6M` → `lifecycle=QUALIFIED` → **`conditions` no longer contain `UNQUALIFIED` — auto-cleared by the canonical seam, zero manual cleanup** |
| Planner uses recovered provider | cf+gemini models flipped `STALE` → `PRN_01M3V2VBF…`: att1 cf `FAILED MODEL_UNAVAILABLE` (`MODEL_NOT_STALE`), att2 gemini `FAILED MODEL_UNAVAILABLE`, att3 **badq `SUCCESS` 910ms** — `MPP_01M3V2VCBSTK6GSYBXXTRJP2H9` |
| `badq` auth → `AUTH_FAILED` at runtime | `PRN_01M3V2VRD…`: att3 badq **`FAILED` `AUTHORITY_REJECTED:FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`** (terminal, not STARTED) → run `FAILED` → 409 → no fallback, no preview |
| `cloudflare` health → `DOWN` | `PRN_01M3V2Z19…` att1 cf `FAILED PROVIDER_UNAVAILABLE` (`PROVIDER_HEALTH_OK`) → att2 gemini `SUCCESS` — availability failover per policy |
| routable projection agrees | `/api/routes` `routable_models`: groq `routable=true`; cf/gemini rows fail **only** `BINDING_QUALIFIED` (planner-only, no DSH binding); **zero** `PROVIDER_*` gate failures — stale `UNQUALIFIED` gone everywhere |
| pre-restart pinned preview | `MPP_01M3V2TZBK…` created before final reboot → confirm after restart → `MSN_01M3V31CHYXP46MV8T29J1RPTA`; repeat confirm replays same mission idempotently |

## R3 — files changed

- `src/pair/provider-catalog.ts` — `issueQualificationReceipt` strips superseded `UNQUALIFIED`, preserves `DISABLED`/others.
- `src/pair/planner-pool.ts` — handled authority rejections settle the durable STARTED attempt to terminal `FAILED` (`AUTHORITY_REJECTED:*`) before propagating.
- `src/__tests__/pair-phase-b.test.ts` — tests 60–67 (recovery matrix + attempt settlement) + shared-projection/routable agreement assertions.

Known limitation carried unchanged: `.imported` discovery deferred; pre-existing stale data repaired once in the test db. `badq` remains configured in the test instance's `settings.yaml` (pointed at the real groq endpoint) as repro state.

Classification remains: `PAIR_NEXT_POST_P14_PHASE_B_PLANNER_RELIABILITY_PENDING_INDEPENDENT_AUDIT`

## R3 ADDENDUM — LIVE-FOUND SIBLING: model STALE residue (post-push, same class)

After R3 push, the live prod stack hit `FAIL_CLOSED_PLANNER_EXHAUSTED` on a real UI
mission: the gemini planner model was `QUALIFIED` but still carried the historical
`STALE` condition left by absence reconciliation → `MODEL_NOT_STALE` gate →
MODEL_UNAVAILABLE → pool exhausted. Identical invariant violation as §1–§3, on the
MODEL side of the same authority.

Fix (same canonical-seam pattern):
`ModelEvidenceCatalog.issueQualificationReceipt` now reconciles conditions on
successful qualification — `STALE` (transient residue) is removed; `REAPPEARED`
(informational history) is preserved; REMOVED/DEPRECATED/BLOCKED can never reach
the receipt path because the qualification gates fail first.
`src/pair/model-catalog.ts` — single canonical seam, shared by planner +
routable eligibility. No planner-side "ignore if qualified" logic.

Test 68 (`pair-phase-b.test.ts`): QUALIFIED model + `STALE` → eligibility FAIL →
`issueQualificationReceipt` → `STALE` cleared, `REAPPEARED` kept, all 8 gates PASS,
`assertPlannerCandidateEligible` passes.

Live verification on prod :8788 (post-restart):
- boot: cf/groq/gemini re-QUALIFIED → `STALE` auto-cleared on all three (now
  `[REAPPEARED]` only); DISCOVERED z-ai models correctly retain `STALE`
- `POST /api/missions/preview` → gemini planner SUCCESS, preview
  `MPP_01M3V4GZZETY1KGY06ZX688HRJ`, plan_digest `6b361ade…`, 2 tasks — no manual
  sqlite cleanup.

## PRE-MERGE EXECUTOR TIMEOUT GOVERNANCE HOTFIX

Audited pre-hotfix HEAD: `57d47830eae6e6d01ec1d9134c535124124a79b8`.

### Previous behavior
- DSH (`acp-executor.ts`) and Codex (`codex-adapter.ts`) consumed `task.timeout`
  → canonical `PAIR_TASK_TIMEOUT_S` budget respected.
- Devin IGNORED `task.timeout`: `observe()` compared elapsed against
  `this.taskTimeoutMs` — an adapter-construction value from
  `PAIR_DEVIN_TASK_TIMEOUT_MS` (default 15min) via `Number(env)||default`
  (unvalidated). Not persisted per execution; env changes after dispatch and
  restart could silently move the deadline.
- `PAIR_DEVIN_BLOCKED_GRACE_MS` also parsed via `Number(env)||120_000`.

### New canonical semantics
- `MissionRuntime.requestFor` injects `timeout = metadata.timeout ??
  PAIR_TASK_TIMEOUT_S` (explicit governed task metadata > canonical env) into
  every governed request — unchanged.
- `DevinExecutorAdapter.effectiveTimeoutMs(task)`: governed `task.timeout`
  (seconds) wins; falls back to adapter `taskTimeoutMs` only when the task
  carries no positive timeout. `task_timeout_ms` persisted in
  `devin-dispatch.json` at dispatch. `observe()` reads `rec.task_timeout_ms`
  (constructor fallback only for pre-hotfix legacy journals) — restart-safe,
  immune to later env drift.
- `PAIR_DEVIN_TASK_TIMEOUT_MS` retained ONLY as validated compatibility
  override (env-config `DEVIN_TASK_TIMEOUT`, ms, 5000–7200000, default
  900000): used solely when no task timeout exists — never overrides
  `task.timeout`.
- `PAIR_DEVIN_BLOCKED_GRACE_MS` → env-config `DEVIN_BLOCKED_GRACE`
  (ms, 5000–1800000, default 120000), fail-closed like the other knobs.
  `serve-mission-control.mjs` injects `blockedGraceMs: devinBlockedGraceMs()`
  + `taskTimeoutMs: cfgTaskTimeoutS*1000` (canonical fallback, not the
  task authority). Separate clock: `blocked` status → grace →
  REMOTE_INPUT_REQUIRED; unrelated to the execution budget.
- Boot prints `EXEC_TIMEOUT: PAIR_TASK_TIMEOUT_S=Ns → task.timeout (all
  executors) | Devin blockedGraceMs=M (separate blocked clock)`.

### Tests (pair-phase-b.test.ts — hotfix describe, A–N)
A/B: spy-router — `taskTimeoutSeconds:1800` → request.timeout=1800; plan task
`metadata.timeout=999` → request.timeout=999 (precedence).
C: DSH fake-ACP `HANG_FOREVER` + `task.timeout=2` → TIMEOUT ≈2s (≠300s default).
D: Codex hang fixture + `task.timeout=2` → TIMEOUT (process-level kill).
E: dispatch timeout=1800 → record + journal `task_timeout_ms=1_800_000`.
F/M: remote `working` at +121s → RUNNING (grace never = budget); past 1800s →
TIMEOUT with `remote_timeout_ms=1_800_000`.
G/H: fresh adapter with env changed to 600s → persisted 1800s still governs
(RUNNING at +700s, TIMEOUT at +1900s).
I/J: `devinBlockedGraceMs` valid/bounds/fail-closed matrix; compat env.
K: blocked > grace → FAILED + REMOTE_INPUT_REQUIRED, no `remote_timeout_ms`
(neither status nor evidence masquerades as task timeout).
L: blocked + DONE sentinel → COMPLETED (unchanged).
N: constructor reads `PAIR_DEVIN_BLOCKED_GRACE_MS=15000` env → FAILED at 16s.

### Regression
Phase B focused 78/78 (+10). Full suite 2362 pass / 2 fail — same pre-existing
P5 executor-registration env failures as base `2277319` (documented). tsc clean,
pnpm build clean.

### Live evidence (:8799, PAIR_MC_DIR copy of pair-mc-b1)
- `PAIR_TASK_TIMEOUT_S=600 PAIR_DEVIN_BLOCKED_GRACE_MS=300000` → boot prints
  `EXEC_TIMEOUT: ... =600s ... blockedGraceMs=300000` → server UP, all routes
  QUALIFIED.
- `PAIR_DEVIN_BLOCKED_GRACE_MS=300` → `FAIL_CLOSED_CONFIG_INVALID ... outside
  bounds 5000..1800000ms` (abort before listen); `=abc` → non-integer fail.
- Real Devin dispatch (task.timeout=600, one session then cancelled):
  journal `task_timeout_ms=600000`; fresh adapter rehydrate → RUNNING with
  persisted budget intact. DSH/Codex consumption proven deterministically by
  tests C/D (real subprocess fixtures).

### Limitations
- `blocked_since` is not journaled across restart (pre-existing: observe()
  never rewrites the dispatch record); the task budget clock itself is
  restart-exact since started_at + task_timeout_ms persist.
- `PAIR_DEVIN_BLOCKED_GRACE_MS=300` in the spec's example is below the
  documented 5s min — flagged, used 300000 for the valid-path smoke.

## R4 — LIVE MISSION INPUT + RECOVERY LIMBO CLOSURE

Audited pre-R4 HEAD: `1fe0f1337e1982c2aede5c22b5bacb3821e61d0c`

### Root causes (reproduced on prod pair.db — 5 missions RUNNING-forever)
- **A — workspace-less mission input**: telegram-style callers submit
  `{goal, project_id}` without `authorized_workspaces` → mission persisted
  `ws: []` → the governed task materialized `workspace = "undefined"` →
  `FAIL_CLOSED_WORKSPACE_UNAUTHORIZED` at dispatch.
- **B — recovery limbo**: that dispatch failure classified UNKNOWN →
  `RECONCILIATION_REQUIRED` → reconcile `CONFIRMED_NOT_EXECUTED` →
  `applyPendingRecovery` had no case → `unhandled:RECONCILIATION_REQUIRED` →
  runtime returned RUNNING while the already-`settled` barrier kept blocking
  `pickRunnable` → permanent limbo, never re-decided.

### Changes
- **`normalizeMissionWorkspaces(input)`** (`mission-control.ts`): supplied
  non-empty `authorized_workspaces` are kept verbatim; otherwise the canonical
  `project.root_location` is resolved and used as `[root_location]`; missing
  project/empty root throws `FAIL_CLOSED_NO_AUTHORIZED_WORKSPACE`. Called
  BEFORE plan/digest in `previewMission`, `createPlanPreview`
  (effective_input_digest + mission_plan_preview + confirm replay) and
  `startMissionInternal` — one shared seam covers /api/missions,
  /api/missions/preview, preview→confirm, telegram, schedules.
- **`classifyFailure` shadowing fix** (`recovery-controller.ts`): the ordered
  CLASS_RULES test now runs on `errCode + "\n" + errClass` so specific error
  codes win over generic transport classes:
  `FAIL_CLOSED_WORKSPACE_UNAUTHORIZED`/`FAIL_CLOSED_ALLOWED_PATH_UNAUTHORIZED`
  → WORKSPACE_DENIAL; `FAIL_CLOSED_CAPABILITY_MISMATCH` + policy/governance
  codes → POLICY_DENIAL. Deterministic pre-dispatch policy rejections now
  take bounded non-retriable actions (HUMAN_APPROVAL/ABORT per matrix)
  instead of UNKNOWN→RECONCILE loops.
- **RECONCILIATION_REQUIRED lifecycle closure** (`mission-runtime.ts`):
  `applyPendingRecovery` handles it — settled barrier with
  `CONFIRMED_NOT_EXECUTED` → `clearPendingRecovery("reconcile_confirmed_not_executed")`
  + fresh `startRecovery` carrying `settled_reconciliation:{outcome,
  reconciliation_id}`; other settled outcomes → clear + bounded transition;
  absent barrier → clear + re-decide (rebuild allowed); unsettled →
  RECONCILING. `startRecovery` threads the ctx into `recovery.decide`.
- **Re-selection guard** (`recovery-controller.ts`): `decide` accepts
  `settled_reconciliation`; when present a `RECONCILIATION_REQUIRED` candidate
  is pushed to rejected_actions with reason
  `RECONCILIATION_ALREADY_SETTLED:<outcome>` instead of re-selecting — the
  fresh decision is recorded and never loops.
- **Settled-barrier semantics**: `pickRunnable` ignores barriers with
  `settled === true` (kept as evidence, no scheduling authority).
- **Legacy self-heal seam**: `runRunning` detects the legacy shape
  (`pending_recovery` with `reason === "unhandled:"+action` or pending
  RECONCILE) and re-enters `applyPendingRecovery` on a normal tick — no DB
  surgery, deterministic compatibility repair inside the state machine.

### Tests (A–R, +11 focused)
A/B normalization defaults + explicit passthrough; C fail-closed no-project;
D/E digest/preview/confirm replay carries ws end-to-end; F classification
matrix (workspace→WORKSPACE_DENIAL, allowed-path→WORKSPACE_DENIAL,
capability→POLICY_DENIAL, transport-only→UNKNOWN unchanged); G/J workspace
denial → WAITING_APPROVAL bounded; G2 explicit caller ws honored verbatim;
H/I UNKNOWN→RECONCILE→CONFIRMED_NOT_EXECUTED→settled barrier unblocks→fresh
decision→bounded terminal, no `unhandled:`; K/L/M/N retry-path redrive
through MissionRouter+GovernedTaskGate again (callCount 2, one successful
dispatch, cost HELD released via proven `{dispatched:false}` evidence — no
executor bypass, no blind replay); O UNKNOWN_SIDE_EFFECT_STATE → approval
required, no replay; Q restart before redrive preserves pending recovery;
R late materialization of barrier reconciles and settles.

### Regression
Phase B focused 89/89 (+11). Full suite 2373 pass / 2 fail — the same
pre-existing P5 DSH+CODEX env failures as base `2277319` (documented).
tsc --noEmit clean, pnpm build clean.

### Live evidence
Isolated instance :8801 (`~/pair-mc-r4`, copy of pair-mc-b1, project root
re-pointed inside the dir — test-fixture env setup only):
- Telegram-style `POST /api/missions {goal, project_id}` without
  authorized_workspaces → `MSN_01M3VAMF9WZYM9N1HZWRZHE5SG` persisted
  `authorized_workspaces=["/home/ubuntu/pair-mc-r4/ws-r4"]`; both governed
  tasks dispatched with the same ws; T1 wrote `mission_goal.txt` there via
  the PAIR_NATIVE worker — no `undefined` anywhere.
- T2 dispatch error → UNKNOWN → RECONCILIATION_REQUIRED →
  CONFIRMED_NOT_EXECUTED → fresh decision rejected
  `RECONCILIATION_ALREADY_SETTLED:CONFIRMED_NOT_EXECUTED` → **ABORT**
  (bounded terminal `recovery_abort:UNKNOWN`, no limbo).
- **Prod restart on this build**: all 5 legacy stuck missions
  (`MSN_01M3V728EV…`, `…7MGY9`, `…7N4BJ`, `…7RT5R`, `…86TC`) self-healed on
  normal ticks within ~60s — each recorded the identical lifecycle
  `UNKNOWN→RECONCILIATION_REQUIRED` then `UNKNOWN→ABORT` with the settled-
  reconcile rejection, rt → ABORTED, mission → FAILED. Zero manual row
  edits on any mission entity.

### Limitations / notes
- A manual `payload_hash`-invalid edit to a *project* row in the test copy
  is still integrity-rejected by `tickSchedules` — the hash gate works;
  unrelated to mission repair (no mission rows were touched).
- Missions whose tasks cannot proceed abort via recovery — the abort path
  is bounded and audited rather than silently retried forever.

## R5 — PINNED PREVIEW AUTHORITY CLOSURE

Audited pre-R5 HEAD: `5af27da9c2879520fcbfde04b887e4dea7b911aa`

### Audit blocker
R4 normalized workspace authority only at preview creation. Its confirm
path then RE-RAN `normalizeMissionWorkspaces()` over the persisted
`mission_input`, which for a legacy READY preview created before R4
(`authorized_workspaces = []`, digests covering `[]`) silently widened the
authority to `[project.root_location]` before minting the mission —
violating `previewed authority == confirmed authority == committed
authority`. Confirm must never rewrite authority already covered by the
persisted digests.

### Confirm semantics after fix
`confirmPlanPreview` no longer calls `normalizeMissionWorkspaces`. New
helper `assertPreviewWorkspaceAuthority(mission_input)` (plan-preview.ts)
validates the persisted `authorized_workspaces`: must be a non-empty array
of non-empty strings, then is replayed VERBATIM into mission creation.
Invalid → `FAIL_CLOSED_PLAN_PREVIEW_AUTHORITY_STALE` (IntegrityError,
consistent with the other preview errors): no mission, preview stays READY,
mission_input and both digests untouched — inside the same store.immediate
transaction, so the rejection is atomic.

Ordering preserved (verify → validate → authority check → create → CAS
consume): `FAIL_CLOSED_PLAN_DIGEST_MISMATCH` still wins first, then
consumed-idempotent return, `FAIL_CLOSED_PLAN_PREVIEW_EXPIRED`,
`FAIL_CLOSED_PLAN_PREVIEW_OPERATOR`, and only then the new authority check.
`effective_input_digest` / `plan_digest` remain immutable approval evidence
— never recomputed against modified authority, never migrated in place.

### New previews unchanged
`createPlanPreview` still runs `normalizeMissionWorkspaces` BEFORE
effective_input_digest/plan_digest/persisted mission_input: missing or `[]`
→ `[project.root_location]`; explicit non-empty lists pass through
verbatim; unusable project root → `FAIL_CLOSED_NO_AUTHORIZED_WORKSPACE`.

### Deferred architectural note (§9)
The serve-side edge still calls `planExpander(body)` before
`MissionControl.createPlanPreview()` normalizes workspaces. The planner
plans from goal/capability context only, so correctness is preserved; the
cleanup (normalizing once at the edge) is deferred per the mandate.

### Focused tests (+8)
F: legacy ws=[] → AUTHORITY_STALE, zero missions, READY/inputs/digests
unchanged. G: missing ws → same. H/E: explicit persisted list replayed
verbatim even after project root changed post-preview. I: already-CONSUMED
legacy preview → idempotent return, no retroactive rejection. J: wrong
digest wins first. K: expiry wins. L: operator binding wins. M: one
preview → at most one mission.

### Regression
Phase B focused 97/97 (+8). Full suite 2381 pass / 2 fail — same
pre-existing P5 DSH+CODEX env failures as base `2277319`. tsc --noEmit
clean, pnpm build clean.

### Smoke (deterministic, per §13 allowance)
CASE 1 (new preview): covered by R4 test D/E + R4 live run — no-ws POST →
persisted `[project.root_location]` → confirm → mission identical.
CASE 2 (legacy READY ws=[] → AUTHORITY_STALE, READY preserved, zero
missions): covered deterministically by tests F/G above; no production
preview was mutated to generate evidence.
