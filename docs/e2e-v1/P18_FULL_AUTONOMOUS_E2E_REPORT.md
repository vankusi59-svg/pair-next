# P16–P18 Full Autonomous E2E Report — V1

- **Baseline**: `main @ 8317c65` (merged PR #146 P16–P18 stack + #147 checkpoint) + bounded repair `9347193` (`fix/p18-e2e-ceo-model-env`, not merged).
- **Environment**: disposable scratch `PAIR_MC_DIR=C:\Users\Admin\.pair-e2e-v1\mc` (own pair.db + state.db, WAL mode). No production data, no paid API keys, no Devin key, no AGNES_API_KEY.
- **Server**: `node scripts/serve-mission-control.mjs`, port 8790, `PAIR_OBJECTIVE_AUTO_DRIVER=1`, `PAIR_CEO_MODEL=gpt-5.6-sol`, `PAIR_PLANNER_MODEL_ROUTE=codex-cli:gpt-5.6-sol`, `PAIR_DSH_HOME=C:\Users\Admin\.pair-dsh-home`, `PAIR_DSH_MODEL_ROUTE=agnes:agnes-2.5-flash` (resolvable catalog entry; DSH execution path UNQUALIFIED — agnes provider/model show QUALIFIED on liveness probes only, no AGNES_API_KEY, zero invocations).
- **Codex**: CLI 0.154.0, auth mode `chatgpt` (subscription). Bounded live invocation: `codex exec -m gpt-5.6-sol "Reply with exactly: PAIR_AUTH_PROBE_OK"` → `PAIR_AUTH_PROBE_OK`, 7,083 tokens.
- **Stack tip under test**: `9347193 fix(ceo): PAIR_CEO_MODEL operator seam`.

## Gate A — Runtime readiness: PASS

| Check | Result | Evidence |
|---|---|---|
| Build/typecheck | PASS | `pnpm build` clean |
| Repo baseline | PASS | main `8317c65` contains P16–P18 |
| Codex CLI install | PASS | 0.154.0 |
| Codex auth (real invocation) | PASS | `PAIR_AUTH_PROBE_OK`, 7,083 tokens, `gpt-5.6-sol` |
| Planner route qualification | PASS | `MODEL_ROUTE: codex-cli:gpt-5.6-sol QUALIFIED (probe PASS)` boot log |
| CEO model entry | PASS | `ME_e20dea58ee778e66e434bfc0` seeded via `PAIR_CEO_MODEL` |
| PAIR_NATIVE executor | PASS | `QUALIFIED`, routable 2/2 |
| DSH/DEVIN | fail-closed off | `UNQUALIFIED` — no credentials, never invocable |
| Metered API fallback | none | subscription-only policy enforced (`assertCodexOnlyPlannerRoute`); agnes provider/model qualified on liveness probes only — DSH execution path UNQUALIFIED, no credential, zero invocations |
| Scratch isolation | PASS | all state under `.pair-e2e-v1` |

## Gate B — Full autonomous execution: PASS

Objective `OBJ_1050b1f751ab60ba540c4593` ("autonomous-hello"), business `BIZ_01M5R1CKY94M7Q9G6X1PEGK8Q6`, owner `operator:e2e`:

| Step | Canonical evidence |
|---|---|
| Owner configure+enable auto-policy | `auto_policy` effective:true v1 (HTTP `POST .../auto-policy`) |
| Durable wake → scheduler claim | `objective_auto_lease` rows; `OBJECTIVE_AUTO_SCHEDULER_COMMIT` events CLAIM/ADMIT/SETTLE ×357 total |
| CEO reasoning (real Codex) | `ceo_decision_attempt CCA_cfd361…` ACCEPTED, `provider_id:codex-cli`, `model_id:gpt-5.6-sol`, `started_by:objective-auto-driver`, observation/proposal/response digests |
| Decision | `ceo_decision CCD_…` `INITIALIZE_WORKSTREAMS` |
| Planner | `PLANNER_ATTEMPT_SUCCEEDED`, `PLANNER_RUN_WINNER PRN_01M5R1DC…`, `COST_RESERVATION_COMMITTED` |
| Workstream allocation | `OWB_283f…` binding, `WAL_…`, work item `DL_520e…` (assigned to org agent) |
| Mission | `MSN_01M5R1DGCPZ9JJRR5TAMQSXDB6` RUNNING→COMPLETED, tasks T1 (PAIR_NATIVE) + T2 (CODEX) COMPLETED |
| Artifact | `ART_6E4D3CDFD0722E32B8E087E96E55BC61` `hello_pairnext.txt` ACCEPTED, `producer_executor_id:CODEX`, `ingested_via:LOCAL_EXECUTION`, CAS sha256 `979ff1e8…`, blob bytes = `HELLO_FROM_AUTONOMOUS_COMPANY` |
| Owner KPI evidence | `ev-hello-1` applied (verifier `operator:e2e`, source `owner-console`) → KPI current 1/1 |
| Review | `REV_e888483250f3647cec9371e0` `TARGET_MET_CANDIDATE`, `all_targets_met:true`, `recommended_status:ACHIEVED` |
| Owner sign-off | `RSO_01M5R1NBAFN2SFS260T8J1S9BZ` accept → objective `ACHIEVED` |
| Authority boundary | queue `BLOCKED_AUTHORITY`/`OWNER_SIGN_OFF_REQUIRED` between TARGET_MET and sign-off — system never self-declared ACHIEVED |

Second objective pass (`OBJ_429d051062c379183d7c35fa`): attempt `CCA_846f152e…` ACCEPTED → `DISPATCHED` → `MSN_01M5R1ZXKBT7CCE6FYB45CJ8A3` COMPLETED, produced `verdict.txt` (ACCEPTED, CODEX).

## Gate C — P16 Strategic Brain: PASS

- CEO cycle composes `BrainContextService → ReasoningBriefService.briefFor → briefObservationView` (wired in `createDefaultObjectiveOperatingService`, live `observation_digest` on every attempt binds the brief content).
- Determinism: repeat `POST /ceo-cycle` on unchanged state → same `ceo_decision_id` `CCD_7047…`, **no new attempt minted** (canonical replay; no duplicate LLM charge).
- Model decisions were content-sensitive: `WAIT` on no-op probe statement, `INITIALIZE_WORKSTREAMS`/`DISPATCHED` after statement amend — real model output driving canonical decisions.
- Advisory boundary: read-grant mint by owner OK (`cgr_01M5R1SFHKYK6DWPR0DAM93W1F`, ENABLED, scope-bound); foreign mint `FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY`; unauthenticated operational read `FAIL_CLOSED_OPERATOR_ID_REQUIRED`.
- Capability-gap projection: `objective_capability_gap` rows (`DRIVER_PASS_FAULT`) minted on failed passes (also seen ×4 in prior run).

## Gate D — P17 Scoped memory & experience: PASS

- `state.db` semantic/procedural rows seeded per scope; `ScopedMemoryReader.scopedFor`: scope A sees only A rows (`a-proc`, a-fact), scope B only B rows; `excluded_unscoped:1`, `excluded_out_of_scope:3` each — honest counts, no leakage.
- `pair.db` experience: `scopedFor(A)` returned 4 **system-extracted** rows (`PAIR_EXPERIENCE_EXTRACTION`: 2×ROUTING_PRIOR QUALIFIED + 2×EXECUTOR_OBSERVATION ACTIVE, bound `BIZ/OBJ_A`); `scopedFor(B)` → `[]` + exclusions {unscoped:1, out_of_scope:5, ineligible:1}.
- CANDIDATE-tier seeds stay below trust floor (`excluded_ineligible`) — model-writable rows never reach canonical reads unqualified.
- Write-time scope validation: `assertScope` resolves objective→business canonical binding (mismatched business rejected).

## Gate E — P18 company coordination: PASS (E1–E7)

| Item | Live evidence |
|---|---|
| E1 dependency gate | C `UPSTREAM_UNMET` over HTTP while B unachieved |
| E2 supersession recovery | B→CANCELLED still gated; `SUPERSEDES A→B` (A ACHIEVED) minted → C claimed (`ATTEMPT_COOLDOWN`) — owner-authorized replacement released gate |
| E3 artifact handoff | consumer mission task `pair_dataflow_sources` pinned `ART_6E4D3CDF…` with producer execution/mission/task + sha256; `verdict.txt` ACCEPTED after consumption |
| E4 revocation | `listEligibleExternalInputSources(B-mission)`: 3 artifacts → SUSPEND → `[]` → RESUME → 3 → REVOKE → `[]` |
| E5 parallel gating | D holds ACTIVE lease → C `CONFLICT_LEASE_HELD` over HTTP (mutual exclusion) |
| E6 duties | `DUT_01M5R28PH6…` covers {C,D} exact-set; {C,D,A}→false (no union); foreign mint `FAIL_CLOSED_DUTY_OBJECTIVE`; SUSPEND→false→RESUME→true |
| E7 projections | `/api/vnext/businesses/:id/portfolio`: dependency counts (`upstream_failed:1`, `blocked:true` on C advisory), active_conflicts both directions, honest statuses (ACHIEVED/CANCELLED/ACTIVE) |

## Gate F — Mission Control UI E2E: PASS (23/25 live assertions)

Real Chromium against live server (seeded `pair.mc_token`, `pair.operator_id=e2e`, `pair.business_id`). Assertions grounded in live API rows: business name, ACHIEVED/CANCELLED/ACTIVE statuses, KPI id, evidence key `ev-hello-1`, review sign-off surface, mission list/detail (verdict.txt refs), observability (CODEX/PAIR_NATIVE QUALIFIED), wrong-token → HTTP 401, refresh stability, honest CANCELLED rendering. Scripts: `docs/e2e-v1/ui-live*.mjs`; screenshots in `docs/e2e-v1/*.png`.

## Gate G — Recovery & safety: PASS

| Scenario | Result |
|---|---|
| Idempotent replay | terminal objective write → `FAIL_CLOSED_OBJECTIVE_TERMINAL`; signoff idempotency-key replay with different semantics → `FAIL_CLOSED_REVIEW_SIGNOFF …replays with different semantics` |
| Server restart mid-pending | kill PID → relaunch same `PAIR_MC_DIR` → full boot, all state intact, integrity_check `ok`, driver re-armed, leases settle |
| Policy invalidation | owner amend → `POLICY_NOT_EFFECTIVE` + `BLOCKED_AUTHORITY` (no claims until re-authorize) |
| Disabled authorization | `auto-policy disable` → `effective:false`/`STATE_DISABLED` → pending gen 12 unclaimed |
| Corrupt relation row | `FAIL_CLOSED_ENTITY_HASH_MISMATCH` typed wedge; dangling index → `FAIL_CLOSED_RELATION_INDEX` |
| Executor failure | `objective_capability_gap` DRIVER_PASS_FAULT projection minted on failed passes |
| Reasoner unavailable | prior run: `SUBSCRIPTION_AUTH_UNVERIFIED` fail-closed until qualified (env gate, correct) |
| WAL/integrity | `PRAGMA integrity_check → ok`; 607 entities / 1,119 events; WAL multi-process (server+sidecar) stable |
| No paid fallback | DSH executor UNQUALIFIED/dispatch-disabled (agnes model QUALIFIED on liveness probe only — uninvocable without AGNES_API_KEY), DEVIN UNQUALIFIED, planner codex-only enforced at route level |

## Bounded remediation delivered

`9347193` on `fix/p18-e2e-ceo-model-env`: `PAIR_CEO_MODEL` operator seam — CEO model was the only hardcoded reasoning model (`gpt-6.1-sol` unsupported by this subscription). Mirrors `PAIR_CONVERSATION_MODEL`; malformed → `FAIL_CLOSED_CEO_MODEL_CONFIG`; 16/16 regression tests. Required for Gate A on this machine's catalog (`gpt-5.6-sol`).
