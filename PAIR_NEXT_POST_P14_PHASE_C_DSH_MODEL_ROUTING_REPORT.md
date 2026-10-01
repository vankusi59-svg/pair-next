# PAIR NEXT — POST-P14 PHASE C
## GOVERNED DSH MULTI-MODEL ROUTING + SAFE FAILOVER + DURABLE PROVENANCE — REPORT

Classification: `PAIR_NEXT_PHASE_C_DSH_MODEL_ROUTING_V2_PENDING_INDEPENDENT_AUDIT`

---

## 1. Scope

Governed multi-model routing INSIDE the DSH executor: a canonical ordered
model pool, per-invocation eligibility re-proof, safe pre-dispatch failover
only, one shared deadline, credential-follows-model, and durable
`dsh_model_attempt` (`DMA_*`) provenance per candidate attempt. Zero changes
to the generic MissionRouter / RouteSelector / recovery semantics.

## 2. Lineage

- Base commit: `152d8d35459814d23f13653a6f94d030a64df878` (main after PR #24 merge).
- Branch: `devin/post-p14-phase-c-dsh-model-routing-v2`.
- Verified: `git merge-base` == `152d8d3`; PR #23 + PR #24 closures present
  verbatim (recovery boundary, binding capability authority untouched).

## 3. Architecture layering (§4–§6, §13, §30)

MissionRouter → executor (unchanged).
RouteSelector → executor route `RTE_DSH_ACP` via `executor_supply_binding`
(unchanged — binding caps still minted at registration, never per model).
DshModelRouter → model (new, invoked ONLY after generic gates pass, inside
`DshExecutorAdapter.runAttempts`).

- No generic `route` or `executor_supply_binding` row is minted per model —
  model layer writes `model_binding` (`MBD_*`) rows only (test B1/B2).
- `executor_supply_binding` is never reused as `model_binding`; the attempt
  row links both separately (A3, J1).
- Executor identity is fixed: every attempt on a DSH governed task carries
  `executor_id=DEEPSEEK_HARNESS`; no drift (A4).

## 4. Canonical `model_binding` authority (§5)

`resolveDshModelBinding(service, executorId, modelEntryId)` returns the
binding where `executor_id == DEEPSEEK_HARNESS` and `model_entry_id` matches —
preferring a `QUALIFIED` row, else the first stored row (so a non-qualified
binding is *evidence* for the authority throw, not silently skipped).
No parallel binding store; `model_binding` is the single authority.

## 5. Candidate pool semantics (§7–§8)

Configured order is authoritative: `PAIR_DSH_MODEL_ROUTE` →
`PAIR_DSH_FALLBACK_ROUTE` → `PAIR_DSH_EXTRA_ROUTES` (C1). Resolution happens
at serve boot: each configured ref resolves to a canonical `model_entry_id`;
dedupe is applied AFTER canonical resolution (C3 — two refs to the same
entry collapse to one candidate); any configured ref that cannot resolve
fails closed at boot (`FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED` via
`resolveConfiguredModelRoleRoute`, C4). `router.candidates()` returns a copy
— callers cannot reorder authority (C2).

## 6. Removal of hidden adapter model authority (§9, §21)

`DSH_DEFAULT_MODEL_ROUTE` / `modelRoute(env)` no longer grant runtime model
authority. The adapter injects an explicit selected model per attempt:
`selectedModel(attemptCtx)` returns `{provider, model, model_entry_id,
model_binding_id, governed:true}` from the router candidate, falling back to
the env route only with `governed:false` (legacy/probe path when no router is
bound — e.g. `probe()` before `bindModelRouter`). `postSessionSetup` pins the
model via `session/set_config_option` with config_id `"model"`; the value
MUST equal the attempt evidence verbatim (F5); role assertion runs on the
exact pinned model.

## 7. Eligibility re-proof before every invocation (§10–§11, §28)

`assertDshCandidateEligible(service, candidate, executorId)` runs INSIDE the
attempt loop, per candidate, per invocation (E7 — provider recovering
mid-pool wins its turn). Gates:

Authority (throw `IntegrityError`, NEVER failover):
- `assertDshExecutionModelRole` — DSH_EXECUTION role held, not
  REMOVED/DEPRECATED/BLOCKED (D1, D3); role revoked at runtime fails the
  next invocation (D2).
- Planner-overlap: `sameCanonicalModel` vs live PLANNER_COORDINATOR
  assignments → `FAIL_CLOSED_DSH_PLANNER_OVERLAP` (D4).
- Provider gates `PROVIDER_QUALIFIED` / `PROVIDER_AUTH_OK` /
  `PROVIDER_NOT_BLOCKED` or `MODEL_NOT_REVOKED` fail →
  `FAIL_CLOSED_DSH_PROVIDER_INELIGIBLE` (E3).
- Executor gates REGISTERED/ENABLED/QUALIFIED/HEALTHY →
  `FAIL_CLOSED_DSH_EXECUTOR_INELIGIBLE` (E6).
- Binding absent or non-QUALIFIED → `FAIL_CLOSED_DSH_MODEL_BINDING`
  (E4, E5).

Availability (return `{reject:true, failure_class}` → next model):
- `PROVIDER_HEALTH_OK` fail → `PROVIDER_UNAVAILABLE` (E1).
- Model STALE/UNAVAILABLE → `MODEL_UNAVAILABLE` (E2).
- Adapter credential check → `CREDENTIAL_MISSING` (I1).

## 8. Authority vs availability split (§12)

Deterministic: role/revocation/overlap/provider-unqualified/executor-invalid/
binding-absent = FAIL CLOSED, never failover (G4 — an authority throw
mid-pool aborts the entire dispatch; later candidates never run).
Provider-down/model-unavailable/quota/rate-limit/safe pre-execution failures
= may select next model (C5, F1, F2).

## 9. Side-effect boundary (§15–§16)

The boundary is `AcpExecutorAdapterBase.attemptExecution` —
`attemptCtx.markDispatch()` is invoked immediately before
`proc.prompt(sessionId, prompt, timeout)`. Everything before (spawn,
`initialize`, `session/new`, `postSessionSetup` incl. `set_config_option`)
is pre-dispatch = safe failover zone (F1, F2, F6 — eligibility rejections
stay `PRE_DISPATCH`).

Post-dispatch = NEVER failover: `fail_prompt` marks the task dispatched then
errors → `dispatched=true` → `safe_to_failover:false` → pool stops, error
propagates into existing recovery (F3). Post-dispatch hang after a side
effect → `TIMEOUT`, marker written exactly once, no fallback (F4/F8).
`UNKNOWN_SIDE_EFFECT_STATE` is never a failover signal.

## 10. Shared deadline (§17–§18)

`deadlineMs = now + task.timeout*1000` computed once per dispatch; each
candidate gets `remainingSeconds = ceil(remainingMs/1000)` injected via
`attemptCtx`. Budget exhausted before a candidate starts → a `TIMEOUT`
attempt row is persisted and `PairError("ACP_REQUEST_TIMEOUT")` is thrown
→ status `TIMEOUT` (H1). A second candidate inherits only the remainder
(H2). Devin/Codex timeouts untouched.

## 11. Credential follows the selected model (§19)

`providerEnv(attemptCtx)` builds env from the CANDIDATE's provider —
`credentialEnvNamesFor(provider)` reads
`$PAIR_DSH_HOME/settings.yaml` `[llm-pi-ai].providers.<pid>.apiKeyEnv`.
The primary provider's credential is never presented to a fallback (I2 —
marker/env inspection proves only the candidate's own credential env name
appears). Missing credential → `CREDENTIAL_MISSING`, pre-dispatch, failover
(I1). No secret value is written to any attempt row, event, or journal
(I3 — scanned rows + events + journal for token patterns).

## 12. New component — `src/pair/dsh-model-router.ts` (§20)

Exports: `DSH_FAILURE_CLASS` (PROVIDER_UNAVAILABLE / MODEL_UNAVAILABLE /
CREDENTIAL_MISSING / RATE_LIMITED / TRANSIENT_TRANSPORT / TIMEOUT),
`DshModelCandidate`, `DshEligibilityRejection`, `resolveDshModelBinding`,
`assertDshCandidateEligible`, `DSH_ATTEMPT_ENTITY`, `dshAttemptId`,
`DshAttemptToken`, `createDshModelRouter({service, executorId, candidates})`
→ `{candidates, assertEligible, attemptStart, markDispatched, attemptEnd,
classifyError}`, `dshModelExhaustedError(attempts)` → `IntegrityError`
`FAIL_CLOSED_DSH_MODEL_EXHAUSTED` carrying safe evidence.

## 13. Adapter refactor — explicit selected model (§21)

`DshExecutorAdapter` gains `bindModelRouter(router, service)` (late-bound at
serve boot), `selectedModel`, `credentialEnvNamesFor`,
`providerEnv(attemptCtx)`, `credentialAvailable(provider)`,
`postSessionSetup(..., attemptCtx)` and a `runAttempts` override = the
deadline loop over `router.candidates()`:

persistAttempt → assertEligible (authority throw settles FAILED + rethrow)
→ `{reject}` settles FAILED + continue → credentialAvailable check →
attemptCtx `{candidate, remainingSeconds, markDispatch}` →
`attemptExecution` → SUCCESS + `winner=true` + return. Catch: `PairError
FAIL_CLOSED*` → settle unsafe + rethrow; else `classifyError(err,
token.dispatched)` → settle; unsafe → throw; else continue. Loop end →
`dshModelExhaustedError`.

`AcpExecutorAdapterBase` (shared base, minimal-touch): new
`AcpAttemptContext`, `runAttempts` seam (default = single attempt,
identical to before), `markDispatch` hook before `proc.prompt`,
`remainingSeconds` timeout override. Codex adapter inherits the single-
attempt path unchanged.

## 14. ACP model pinning (§22)

`session/set_config_option` `config_id:"model"`, value
`JSON.stringify([provider, model])`. Pinned value == attempt evidence
verbatim (F5 + live marker).

## 15. `dsh_model_attempt` entity (§23–§24)

`DMA_<digest24>` per (governed_task_id, attempt_no). Fields:
`dsh_model_attempt_id, mission_id, task_id, governed_task_id, executor_id,
generic_route_id, executor_supply_binding_id, model_binding_id, provider_id,
model_entry_id, model_id, configured_ref, attempt_no, started_at,
completed_at, latency_ms, outcome, failure_class, error_code,
dispatch_state, safe_to_failover, winner, execution_id, correlation_id`.
`generic_route_id`/`executor_supply_binding_id` resolve from the parent
task row (`selected_route_id`/`binding_id`) — best-effort, null when the
task row is unreachable.

## 16. Lifecycle events + crash semantics (§24–§25)

`DSH_MODEL_ATTEMPT_STARTED` on mint, `DSH_MODEL_ATTEMPT_SUCCEEDED` /
`DSH_MODEL_ATTEMPT_FAILED` on settle (J2). A crash between mint and settle
leaves the row `STARTED` forever — K2 verifies reopen durability shows the
in-flight attempt as STARTED. At most ONE `winner=true` per governed task
(J3). Evidence survives store reopen (K1).

## 17. Zero-eligible / exhaustion (§32)

Every candidate rejected/failed → `dshModelExhaustedError` →
`FAIL_CLOSED_DSH_MODEL_EXHAUSTED` with per-candidate safe evidence in
`meta.attempts` (G1, G2). Empty pool → same path (G3). No planner borrow,
no hidden default, no silent executor change.

## 18. `classifyFailure` discipline (§33)

Router-internal `classifyError`: `dispatched=true` →
`{TRANSIENT_TRANSPORT, safe_to_failover:false}` always; pre-dispatch regexes
map TIMEOUT / RATE_LIMITED (429/quota) / CREDENTIAL_MISSING /
MODEL_UNAVAILABLE / PROVIDER_UNAVAILABLE; else TRANSIENT_TRANSPORT
safe_to_failover:true. No broad regex added to the generic failure
classifier; `ROUTE_INFEASIBLE` stays `ROUTE_INFEASIBLE`;
`UNKNOWN_SIDE_EFFECT_STATE` never a failover signal.

## 19. Zero semantic changes elsewhere (§49)

`route-registry.ts`, `route-selector.ts`, `multi-executor.ts`,
`mission-router.ts`, `mission-runtime.ts`, `recovery-controller.ts`:
unmodified (verify: `git diff 152d8d3..HEAD -- src/pair/` lists only
`acp-executor.ts`, `dsh-adapter.ts`, `index.ts`, `dsh-model-router.ts`).

## 20. Focused tests — `src/__tests__/pair-phase-c-dsh-model-routing.test.ts` (42 tests, A–K all pass)

A1–A4 layering; B1–B2 PR #24 preservation; C1–C5 pool; D1–D4 role
authority; E1–E7 re-proof; F1–F6 side-effect boundary; G1–G4 exhaustion;
H1–H2 shared deadline; I1–I3 credentials; J1–J3 provenance; K1–K2
durability. Fixture `fake-acp-agent-phc.mjs`: JSON-RPC fake agent learning
the pinned model, behavior table (fail_setconfig / fail_prompt /
hang_prompt / hang_after_effect / PAIR_TEST_FAIL_INIT_ONCE), marker file
proves dispatch + side-effect counts; `pair-test-config.json` under
`$DSH_HOME` for live runs (childEnv is minimal — only DSH_HOME pin reaches
the child).

## 21. Live E2E — isolated instance (§45)

`PAIR_MC_DIR=/tmp/pair-mc-phc-live`, `PAIR_DSH_HOME=/tmp/pair-dsh-home-phc`
(settings.yaml imported copy + `pair-test-config.json`),
`PAIR_DSH_ACP_PATH=<fixture>`, port 8899, real provider creds for boot
qualification. Prod `~/pair-mc-live` untouched.

- LIVE1 — primary success: mission `MSN_01M3WVM0TMYGT2XAA3EZ232KAZ`
  COMPLETED; `DMA_*` row `cloudflare:@cf/zai-org/glm-4.7-flash` attempt 1
  SUCCESS winner, `generic_route_id=RTE_DSH_ACP`,
  `executor_supply_binding_id=BIND_DEEPSEEK_HARNESS__RTE_DSH_ACP`,
  `model_binding_id=MBD_*`, `execution_id=EXE_*`; marker proves pin+dispatch.
- LIVE2 — safe fallback: `fail_setconfig` on primary → attempt 1
  `FAILED/PRE_DISPATCH/safe_to_failover=true/TRANSIENT_TRANSPORT`,
  attempt 2 `groq:openai/gpt-oss-20b` SUCCESS winner under the SAME
  `execution_id`; marker contains groq only (side-effect exactly once).
- LIVE3 — post-dispatch: `fail_prompt` on primary → repeated
  `FAILED/DISPATCHED/safe_to_failover=false` rows on cloudflare only —
  model failover never fired; recovery bounded to `HUMAN_APPROVAL_REQUIRED`
  → `WAITING_APPROVAL` (`APR_*`), 4 execution-level retries, marker only
  primary.
- LIVE4 — generic gate first: task requires `PYTHON_EXECUTION` (catalogued,
  bound to no executor) → `ROUTING_FAILED` `MISSING_CAPABILITIES` on every
  executor → mission `FAILED`; zero new `dsh_model_attempt` rows —
  DshModelRouter never invoked.

## 22. Regression vs measured baseline (§46–§47)

- Baseline @ `152d8d3`: **2466 pass / 2 fail (pre-existing env P5 probes:
  real `dsh`/`codex` binaries on PATH make stock probes report
  `available:true`) / 24 skipped**.
- Post-change HEAD: **2517 pass / 2 fail — same two P5 env probes / 15
  skipped**. Focused suite 42/42. `tsc --noEmit` clean. `pnpm build` clean.
- Zero regression; delta = +42 phase-C tests +9 prior-count drift in
  unrelated files (same base suite identity).

## 23. Known limitations / commits

- `generic_route_id`/`executor_supply_binding_id` are null when the parent
  task row is unreachable at persist time (adapter-direct harness calls);
  live missions always resolve them.
- The `governed:false` env-route fallback exists only for unbound
  legacy/probe contexts (`probe()` pre-binding); a bound adapter never
  uses it.
- Commits: see branch `devin/post-p14-phase-c-dsh-model-routing-v2`.
- Prod stack was briefly interrupted during E2E cleanup (over-broad pkill
  matched the live process); restored immediately from a clean `152d8d3`
  worktree — see session notes. Prod itself never ran phase-C code.

`DO NOT MERGE`

## Phase C R1 — Deadline + Binding Identity + Authority Provenance + Restart Closure

Independent-audit remediation on the same branch (audited HEAD `745c4ba`, R1 HEAD below). Four findings closed; scope strictly narrow.

### 1. Shared deadline covers the FULL ACP attempt
- `AcpAttemptContext.deadlineAtMs` (absolute ms epoch) set once in `runAttempts` from the shared task deadline.
- `attemptStageTimeout(ctx, fallback)` (acp-executor.ts): clamps `initialize`(30s), `newSession`(60s), `setConfigOption`(30s, dsh-adapter pin) to remaining budget; expired budget → `PairError ACP_REQUEST_TIMEOUT` BEFORE the stage runs.
- RECHECK before dispatch: after `postSessionSetup`, `attemptRemainingMs <= 0` → throw `ACP_REQUEST_TIMEOUT` — `markDispatched` and `proc.prompt` are never reached; DMA row stays `PRE_DISPATCH`, classified `TIMEOUT`, `safe_to_failover` per normal pre-dispatch rule.
- `prompt` timeout = remaining ms (not a fresh task.timeout).
- Evidence L1: `hang_setconfig` on both candidates, timeout=3s → status TIMEOUT in ~3s (not 30s), marker file absent, `agent_out.txt` absent, row1 `TIMEOUT`/`PRE_DISPATCH`/`safe_to_failover:true`, row2 `TIMEOUT`.

### 2. Exact model_binding identity
- `resolveDshModelBinding(service, executorId, modelEntryId, providerId)` now requires `binding.executor_id == DEEPSEEK_HARNESS` AND `binding.model_entry_id == candidate.model_entry_id` AND `binding.provider_id == candidate.pid` AND `qualification_state == QUALIFIED` AND `transport_compat ∈ DSH_VALID_TRANSPORT_COMPAT` (`{"OPENAI_COMPLETIONS"}`). A QUALIFIED binding for the same entry under a different provider is rejected (`FAIL_CLOSED_DSH_MODEL_BINDING` with binding_provider_id detail).
- Pre-pin drift proof (dsh-adapter `postSessionSetup`): `ModelEvidenceCatalog.getModelByIds(candidate.pid, candidate.mid)` must resolve to `candidate.model_entry_id`, else `FAIL_CLOSED_DSH_MODEL_IDENTITY_DRIFT` (authority → aborts pool).
- Evidence M1–M4: provider mismatch throws; wrong transport throws; tuple drift → AUTHORITY_REJECTED row; persisted `model_binding_id` matches candidate provider/entry/executor exactly.

### 3. Truthful authority failure provenance
- New `DSH_FAILURE_CLASS.AUTHORITY_REJECTED`; both authority settle sites in `runAttempts` (eligibility throw + in-attempt `FAIL_CLOSED*`) persist `failure_class=AUTHORITY_REJECTED`, `safe_to_failover=false`, real `error_code` — was `TRANSIENT_TRANSPORT`.
- DMA rows now distinguish: `AUTHORITY_REJECTED` (governance) vs availability classes (`PROVIDER_UNAVAILABLE` etc.) vs `TRANSIENT_TRANSPORT`. RecoveryController taxonomy untouched.
- Evidence N1: non-QUALIFIED binding → AUTHORITY_REJECTED, pool aborted. N2: [down-provider, weak-binding, clean] → rows `PROVIDER_UNAVAILABLE`+AUTHORITY_REJECTED, third candidate never ran.

### 4. Restart safety tests
- O1: `crash_prompt` (mark → process.exit) leaves row `DISPATCHED`/`FAILED`/`safe:false`; store reopen + fresh adapter dispatch of the same governed task → journal rehydrate (recovered record), ZERO new attempts, marker still `["palpha:m0"]` — no auto-resume on another model.
- O2: after a COMPLETED winner, restart + re-dispatch → rehydrated record, still exactly 1 row, `winner` count stays 1. No fabricated success, no mutated evidence.

### Validation
- Focused: `pair-phase-c-dsh-model-routing.test.ts` 51/51 (42 + L1 + M1–M4 + N1–N2 + O1–O2).
- PR #23 regression: `pair-live-ops-recovery-closure.test.ts` pass (in 179-test batch).
- PR #24 regression: `pair-route-capability-authority.test.ts` pass (same batch).
- Phase B regression: `pair-phase-b.test.ts` pass (same batch).
- Full Node 22 suite: **2526 pass / 2 fail / 15 skipped** — the 2 failures are the pre-existing P5 environment probes (real `dsh`/`codex` on PATH); baseline 2517/2 → +9 new tests, zero regressions.
- `tsc --noEmit`: clean. `pnpm build`: clean.

### Files changed
`src/pair/acp-executor.ts`, `src/pair/dsh-adapter.ts`, `src/pair/dsh-model-router.ts`, `src/__tests__/pair-phase-c-dsh-model-routing.test.ts`, `src/__tests__/fixtures/fake-acp-agent-phc.mjs`, this report.

### Limitations
- `attemptStageTimeout` granularity is whole seconds (ceiling) — sub-second expiry lands on the next stage boundary, never past `markDispatched`.
- `rehydrate` is trusted to prove no-resume (O1/O2); a journal left `RUNNING` maps to UNKNOWN, not a re-run.
