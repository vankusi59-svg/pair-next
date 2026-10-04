# CPL-1 — Codex GPT-6.1 Sol Planner Primary (PENDING AUDIT)

- **Base**: `e6744ca` (post-CNI-1 main) · **Branch**: `devin/1791091651-cpl1-codex-sol-planner`
- **codex-cli**: `codex-cli 0.159.3` · auth `auth_mode=chatgpt` · model `gpt-6.1-sol` reachable, `--output-schema`/`--output-last-message`/`--json` supported (§0 preflight PASS). R1.E — no credential values or account identifiers persisted in this report.

## Architecture

`codex-cli:gpt-6.1-sol` is planner route **#1** via a **dedicated CodexPlannerProvider transport** (`src/pair/codex-planner.ts`, `transport:"codex_cli"`) — NOT `CodexCliExecutorAdapter`. No dispatch, no governed lane, no executor artifacts, no gate/authority borrow: the planner child runs `codex exec` with a read-only, network-disabled `pair_planner` permission profile (`--ephemeral --ignore-user-config --ignore-rules --strict-config --color never approval_policy=never web_search=disabled`), prompt on stdin, output via `--output-schema` + `--output-last-message` (OpenAI strict structured output: `additionalProperties:false`, full `required`). Exit-0 alone is never authoritative — the final message must exist and parse.

Flow stays the mandate's single authority: `beginPlannerRun → candidate → assertEligible → invoke → canonicalizeLlmTasks → validatePlanProposal → SUCCESS/FAILED → next`. Codex output enters the SAME `sanitizePlan`-family canonicalization (`extractPlanJson` → `sanitizePlan` → canonicalizer → `validatePlanProposal`); malformed/empty/degenerate → typed FAILED → failover continues. No template fallback, no silent repair.

## Catalog authority (real evidence, not config presence)

`ensureCodexCliPlannerCatalog` seeds a real provider (`codex-cli`, `LOCAL_CLI`, `codex-cli://local`, credential null) + model claim (`provider_family=codex-cli`, capability `text_inference`) so strict route resolution, `PLANNER_COORDINATOR` role, planner∩DSH disjointness, and `model_entry_id` binding all hold. Boot-time `qualifyCodexPlannerRoute` runs a REAL probe (`codexPlannerProbe` — a schema-constrained ping invocation) through `validateAccess`/`probeModel`/`qualifyModel`; the candidate is retained **unconditionally** so a failed probe still yields typed per-attempt eligibility evidence (§7-B semantics: attempt row FAILED + failover continues) instead of a silently absent route.

Per-attempt `assertCodexPlannerCandidateEligible`: role + DSH-overlap violations and REMOVED/DEPRECATED/BLOCKED model conditions **throw** (authority, `AUTHORITY_REJECTED` → propagate); availability verdicts (`auth_state`, `probe_state` PROBE_CLI_MISSING/PROBE_MODEL_UNAVAILABLE/PROBE_TIMEOUT/PROBE_RATE_LIMITED/other, provider+model lifecycle) **reject** with typed `failure_class` — CLI_MISSING/AUTH_REJECTED/MODEL_UNAVAILABLE/TIMEOUT/QUOTA_RATE_LIMITED/PROVIDER_UNAVAILABLE.

## Default order + operator override

`PAIR_PLANNER_MODEL_ROUTE` default `codex-cli:gpt-6.1-sol` → `PAIR_PLANNER_FALLBACK_ROUTE` default `gemini:gemini-3.1-flash-lite` → `PAIR_PLANNER_EXTRA_ROUTES` extras — in `scripts/serve-mission-control.mjs` and `scripts/start-pair-live.sh`. Env-config compat fully preserved: an explicit env always wins; empty fallback disables it; api-only route lists keep codex out entirely (test J). `PAIR_CODEX_PLANNER_TIMEOUT_MS` (env-config, 5s–900s, default 120s) bounds planner invocations; `PAIR_CODEX_PLANNER_EXECUTABLE`/`PAIR_CODEX_EXECUTABLE` override binary resolution (`which codex` fallback).

## Warning → failure_class map (codex transport)

`CODEX_CLI_MISSING→CLI_MISSING`, `CODEX_AUTH_FAILED→AUTH_REJECTED`, `CODEX_MODEL_UNAVAILABLE→MODEL_UNAVAILABLE`, `CODEX_TIMEOUT→TIMEOUT`, `CODEX_RATE_LIMITED→QUOTA_RATE_LIMITED`, `CODEX_OUTPUT_INVALID→MALFORMED_RESPONSE`, `CODEX_PLAN_DEGENERATE→PLAN_DEGENERATE`, `CODEX_SPAWN_ERROR[:code]→PROVIDER_UNAVAILABLE`. stderr classifiers: auth (401/403/unauthorized/login), model (not found/not available/unavailable/unknown/404), rate (429/quota).

## Tests (focused suite — `pair-cpl1-codex-planner.test.ts`, 11/11 PASS)

A sol wins attempt_no=1, gemini count=0 · B cli-missing → typed FAILED → gemini #2 · C auth-fail → AUTH_REJECTED · D model-unavailable → MODEL_UNAVAILABLE · E timeout → TIMEOUT + SIGKILL + no orphan pid · F malformed → MALFORMED_RESPONSE · G canonically-invalid (unbound consume) → PLAN_INVALID · H planner argv read-only/no-net/isolated, zero governed side-effects · I planner↔DSH disjointness (aliased DSH model + missing role both fail closed) · J api-only config regression (codex absent) + strict seeding · probe test (AUTH_OK/CLI_MISSING/AUTH_FAILED + warning→class map).

## Validation (all real runs)

- Focused CPL-1: **11/11 PASS** · related batch (CNI-1, llm-planner, phase-b, planner-dataflow-incident): **278 PASS** · planner/model batch (phase-e, phase-c): **402 PASS**
- `npx tsc --noEmit`: clean · `rm -rf dist && pnpm build`: PASS · `pnpm audit --audit-level=high`: 0 high (1 low, 8 moderate — unchanged)
- Full suite: **3348 pass, 2 fail = the two known env-only P5 registration failures** (DSH/CODEX executor homes absent in test env), 15 skipped — no other regression.

## Live smoke (scratch PAIR_MC_DIR, real codex auth)

- Boot: `MODEL_ROUTE: codex-cli:gpt-6.1-sol QUALIFIED (codex planner, probe PASS)` — real schema-constrained ping invocation, 4.8s.
- `POST /api/missions/preview` (goal: BTC+gold → json files → vi note → Telegram): `planner_attempt PA_01M42QXVGBYHT5Z9E66PWPY3QY` — route `codex-cli:gpt-6.1-sol`, provider `codex-cli`, model `gpt-6.1-sol`, outcome **SUCCESS**, latency 18546ms; `planner_run PRN_01M42QXVGA508D2GVGB250BNRN` → `WINNER_SELECTED`, **winner_attempt_no=1**. Preview `MPP_01M42QYDM1E0J7QT6CHQGVS5S3` READY, plan_digest `4173079…`, `plan_model: gpt-6.1-sol`.
- Gemini route absent from this run's pool (its independent HTTP probe FAILed at boot — pre-existing google-side flake, same as observed pre-CPL-1); failover order evidence intact via `routes:["codex-cli:gpt-6.1-sol"]` + test A/B.

## Limitations / residual

- Planner invocation latency ~5–20s (vs 2–5s HTTP routes) — bounded by `PAIR_CODEX_PLANNER_TIMEOUT_MS`; failover order unaffected.
- Replan path untouched (production `replanProvider:null` already fails closed under the sync contract — CPL-1 is initial-plan edge only).
- codex planner child env whitelists PATH/HOME/LANG/LC_ALL/CODEX_HOME/NODE_PATH (+ test-only FAKE_CODEX_*) — API keys removed in R1.B; schema-constrained output required — `--output-schema` support verified on 0.159.3.

Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_PENDING_AUDIT`

---

# CPL-1 R1 — Canonical Eligibility + Auth Isolation + Timeout Authority (PENDING AUDIT)

- **R1 base**: `7c4755b` (audited CPL-1 HEAD) · **branch**: same `devin/1791091651-cpl1-codex-sol-planner` (PR #40, in-place remediation — no new PR, no merge)
- **Scope**: Codex planner authority/auth/timeout/evidence hardening only. No dispatch/governed/artifact/Work-Graph/Gate authority; no CNI-1 executor changes; no F1–F5 semantics changes; no Telegram delivery changes; no CEO/P15, Brain/P16.

## R1.A — Canonical eligibility (no hand-written duplicate)

`assertCodexPlannerCandidateEligible` no longer evaluates its own gate list. It is a thin wrapper over the **same canonical seam every candidate uses** — `assertPlannerCandidateEligible(store, model_entry_id)` (role + disjointness + `providerModelEligibility` — the full Phase E gate set). All 16 mandated gates remain authoritative verbatim: PROVIDER_QUALIFIED, PROVIDER_AUTH_OK, PROVIDER_PROBE_CURRENT, PROVIDER_HEALTH_OK, PROVIDER_NOT_BLOCKED, PROVIDER_CURRENT, PROVIDER_RECEIPT_CURRENT, MODEL_PROVIDER_MATCH, MODEL_PROVIDER_IDENTITY_CONSISTENT, MODEL_QUALIFIED, MODEL_NOT_STALE, MODEL_NOT_REVOKED, MODEL_AVAILABLE, MODEL_RECEIPT_CURRENT, MODEL_QUALIFICATION_SCOPE_VALID, MODEL_CAPABILITY_PROBE_CURRENT. The wrapper only enriches the availability/reject channel with the codex-typed `failure_class` (probe_state PROBE_CLI_MISSING→CLI_MISSING, PROBE_TIMEOUT→TIMEOUT, PROBE_RATE_LIMITED→QUOTA_RATE_LIMITED, PROBE_MODEL_UNAVAILABLE→MODEL_UNAVAILABLE); authority throws propagate untouched as `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE` / role codes.

## §3 — Codex-first bounded canonical refresh

Classification uses the canonical two-channel split itself — no hand-rolled categories:
- **Availability/reject channel** (PROBE_CURRENT, HEALTH_OK, PROVIDER_CURRENT/STALE, MODEL_QUALIFIED, MODEL_NOT_STALE, MODEL_AVAILABLE, MODEL_QUALIFICATION_SCOPE_VALID, MODEL_CAPABILITY_PROBE_CURRENT + planner unavailable reasons): earns exactly **ONE** bounded canonical refresh — `refreshCodexPlannerQualification` re-runs the *same seams as boot* (`validateAccess(probe=codexPlannerProbe)` → `qualify` → `setLifecycle(QUALIFIED)` → `probeModel(text_inference)` → `qualifyModel`), then **full eligibility is re-proved**. PASS → codex still invoked at #1. Still-fail → the attempt settles typed FAILED with `…|refresh_failed:<gates>` in reason and failover proceeds to Gemini.
- **Authority channel** (`assertPlannerCandidateEligible` throw — AUTHORITY_GATES: PROVIDER_QUALIFIED, PROVIDER_AUTH_OK, PROVIDER_NOT_BLOCKED (DISABLED/UNQUALIFIED/REMOVED conditions), PROVIDER_RECEIPT_CURRENT, MODEL_RECEIPT_CURRENT, MODEL_PROVIDER_MATCH, MODEL_PROVIDER_IDENTITY_CONSISTENT + role/DSH-overlap codes): **never refreshed** — throw propagates, attempt settles `AUTHORITY_REJECTED:<code>`, ZERO codex invocation (§4B/C/D/E/G semantics: operator revocation, ownership mismatch, identity contradiction, invalid/stale receipt — remediation is operator canonical requalification, not planner auto-revive). `IntegrityError` inside the refresh itself also propagates.
- **Post-refresh authority re-check** (§3 boundary): after refresh, eligibility is re-proved; if it now throws, the throw is triaged — newly-appeared DISABLED/REMOVED operator marks (concurrent revocation during the refresh) or receipt/identity-gate failures (PROVIDER_RECEIPT_CURRENT, MODEL_RECEIPT_CURRENT, MODEL_PROVIDER_MATCH, MODEL_PROVIDER_IDENTITY_CONSISTENT) still propagate as authority. A **refresh-derived** mark — the failed canonical requalification stamping UNQUALIFIED — is availability evidence legitimately committed: the attempt settles typed FAILED (`refresh_failed:<gates>`) and failover proceeds; the durable mark stays for the operator and the NEXT evaluation fails upfront.

**Changed files (R1)**: `src/pair/codex-planner.ts`, `src/pair/planner-pool.ts`, `src/pair/env-config.ts`, `scripts/serve-mission-control.mjs`, `src/__tests__/pair-cpl1-codex-planner.test.ts`, `src/__tests__/pair-phase-a.test.ts`, this report, `CURRENT_STATE.md`.

## R1.B — Planner child auth isolation

`CODEX_API_KEY` and `OPENAI_API_KEY` removed from the planner child env whitelist (now PATH, HOME, LANG, LC_ALL, CODEX_HOME, NODE_PATH + test-only FAKE_CODEX_*). §6 regression test: parent env carrying fake keys + CODEX_HOME → child observes `CODEX_HOME` PRESENT, both keys ABSENT, invocation still succeeds. `CodexCliExecutorAdapter` env behavior untouched; CNI-1 executor networking untouched.

## R1.C + §9/§10 — Timeout authority

- `PAIR_MODEL_PROBE_TIMEOUT_MS` default `8000→60000` — authoritative verbatim; the `Math.max(cfg,60000)` floor inside `serve-mission-control` codex probe wiring removed (boot route and the R1 refresh share `cfgProbeTimeoutMs` unchanged).
- `PAIR_CODEX_PLANNER_TIMEOUT_MS` default `120000→900000` (15min) — bounds only the planner `codex exec` invocation; independent budget from the probe/liveness knob (no cross-coupling, proven by override tests).
- Bounds/fail-closed parsing unchanged (probe 500..120000, planner 5000..900000; malformed values still throw at startup). Fake sleeping probe test: killed at the configured 2.5s budget (~2.5s elapsed) — no hidden 60s substitute.

## R1.E — Evidence hygiene

Codex account email removed from this report; `auth_mode=chatgpt` only. No credential values or account identifiers persisted in report/evidence.

## §4 Adversarial matrix (all in `pair-cpl1-codex-planner.test.ts`, 27/27 PASS)

- A-success (B2): QUALIFIED provider + probe_state drift → ONE bounded canonical refresh → codex wins #1 (ledger: 2 PROBE + 1 PLAN).
- A-fail + F2 (model UNAVAILABLE): refresh runs, canonical seams keep failure → ZERO plan spawn, typed FAILED + `refresh_failed` → gemini.
- B: never-qualified provider → AUTHORITY throw (QUALIFIED/AUTH_OK gates), ZERO invocation, AUTHORITY_REJECTED evidence, no gemini.
- B-structural: provider DISABLED → throw, ZERO invocation. C: provider receipt fingerprint mismatch → throw, ZERO. D: MODEL_PROVIDER_MATCH FAIL → throw, ZERO. E: provider_id contradiction → throw, ZERO. F1: model STALE → canonical requalification repairs → codex #1. F3: model BLOCKED → role throw, ZERO. G: model receipt invalid → throw, ZERO. G2: provider receipt invalid → throw, ZERO. H: malformed scope on current receipt → fresh mint → codex #1. I: capability probe non-current → bounded refresh → codex #1.
- Plus §6 env-isolation and §10 timeout-authority tests (above).

## §13–§15 Live smokes — see "Live smoke (R1)" below.

## Validation (R1, all real runs)

- Focused CPL-1 suite **27/27 PASS** · planner failover (phase-b), durable-attempt, Phase A, Phase C DSH, Phase E, CNI-1, codex adapter, env-config/timeout, planner-dataflow-incident batches all PASS.
- `npx tsc --noEmit`: clean · `rm -rf dist && pnpm build`: PASS · `pnpm audit --audit-level=high`: 0 high (1 low, 8 moderate — unchanged vs base).
- Full suite: **3363 pass / 2 fail** — only the two known env-only P5 registration failures remain (unchanged vs base `7c4755b`; DSH/CODEX executables exist in this env so stock probes report available).

## Live smoke (R1)

Scratch stack `PAIR_MC_DIR=/home/ubuntu/.pair-cpl1-scratch/mc` on :8789, real `CODEX_HOME` ChatGPT auth, new R1 dist. Boot: `MODEL_ROUTE: codex-cli:gpt-6.1-sol QUALIFIED (codex planner, probe PASS)`.

- **§13 codex-primary** — POST `/api/missions/preview` (real non-trivial goal: fetch BTC/ETH/gold → chart → Vietnamese report → Telegram) → preview `MPP_01M42VN3Z6GRD73EWNCT12TFQ8` READY, `plan_model=gpt-6.1-sol`; durable `planner_attempt PA_01M42VMDCWFXWC8TH29B8ZT908` `attempt_no=1` **SUCCESS**, `planner_run PRN_01M42VMDCW967MA7AASH4VGD6W` **WINNER_SELECTED winner_attempt_no=1**.
- **§14 auth isolation** — server parent env exported `CODEX_API_KEY=dummy_not_real` + `OPENAI_API_KEY=dummy_not_real` (dummy values, no real secrets); the planner executable ran via a `PAIR_CODEX_PLANNER_EXECUTABLE` wrapper that dumps the child's actual env. Dump (`planner-child-env.txt`, overwritten by the real plan spawn): `grep -c 'API_KEY'` → **0**, `CODEX_HOME`/`PATH`/`HOME` present — and the §13 attempt still SUCCEEDED on the ChatGPT session.
- **§15 codex-first refresh** — provider `PRV_a7b49220f00b358aae4b76fe` (codex-cli) `probe_state` deliberately set `PROBE_TIMEOUT` (refreshable availability drift) on the live db → POST preview → canonical eligibility rejected → ONE bounded `refreshCodexPlannerQualification` (live `codexPlannerProbe`, 30s configured budget) → `probe_state=PROBED`, `auth_state=AUTH_OK` → full eligibility re-proof PASS → codex invoked → attempt `PA_01M42VQ4ZC2C8J6B92V9JAZ8S5` **SUCCESS attempt_no=1**, run `PRN_01M42VQ4ZBE2NDD3CN03N7E21M` **WINNER_SELECTED winner_attempt_no=1**, preview `MPP_01M42VR118WY6D0Q1Y048C0N96` READY.

## Residual limitations (R1)

- A **never-qualified** codex provider (e.g. CLI missing at boot) is canonical-authority-fail-closed: the plan call aborts `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE` rather than silently falling to gemini — deliberate: an authority violation in the pool is an operator problem, not an availability flake (§3/§4B). Refreshable availability drift still fails over to gemini normally.
- Provider conditions `STALE`/`DISABLED` are never cleared by the refresh seam — only derived evidence (probe receipts, access observations, qualification receipts, model lifecycle) is re-minted through canonical seams.

Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R1_PENDING_AUDIT`
