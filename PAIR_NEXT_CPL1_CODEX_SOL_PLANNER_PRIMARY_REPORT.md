# CPL-1 — Codex GPT-6.1 Sol Planner Primary (PENDING AUDIT)

- **Base**: `e6744ca` (post-CNI-1 main) · **Branch**: `devin/1791091651-cpl1-codex-sol-planner`
- **codex-cli**: `codex-cli 0.159.3` · auth `auth_mode=chatgpt` (`vankusi59@gmail.com`) · model `gpt-6.1-sol` reachable, `--output-schema`/`--output-last-message`/`--json` supported (§0 preflight PASS).

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
- codex planner child env whitelists PATH/HOME/LANG/LC_ALL/CODEX_HOME/NODE_PATH/API keys (+ test-only FAKE_CODEX_*); schema-constrained output required — `--output-schema` support verified on 0.159.3.

Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_PENDING_AUDIT`
