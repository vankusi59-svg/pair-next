# PAIR_NEXT_EXECUTOR_SUITABILITY_V1_ACCOUNT_FIRST — Report

- **Classification**: `PAIR_NEXT_EXECUTOR_SUITABILITY_V1_PENDING_AUDIT`
- **Base HEAD (audited)**: `9341713b1d72bc384d0abef4177718fc426a7bc4` (post-PR #57 merge)
- **Branch**: `devin/1791289530-executor-suitability`
- **Scope**: economic routing layer — CODEX + DEVIN as default account/session workforce, DSH metered-API fallback, task→executor suitability, VE bounded inside tier.

## Root cause (why a global `DEVIN 80→30` renumber was rejected)

Routing order was `routing_priority asc → executor_id`, with prod priorities `DSH 40 / CODEX 60 / DEVIN 80`: the metered-API lane (DSH) won *every* task its capability set overlapped — including small code edits — because priority dominated and no economic or task-shape layer existed. A global priority renumber can't express "CODEX for small local work, DEVIN for repo-scale/remote work, DSH only when both are ineligible" — that needs three separate, ordered dimensions, not one number.

## Semantic change

Ordering inside the **hard-eligible set only** (all 12 gates unchanged — no executor is admitted, removed, or resurrected by this layer):

```
accountTier (ACCOUNT_SESSION < METERED_API < NATIVE-preserved ordering)
  → suitabilityRank (DEVIN_PREFERRED < NEUTRAL < CODEX_PREFERRED, per lane)
  → routing_priority
  → executor_id
```

- `taskSuitability(caps)` is capability-based and deterministic: remote-lane caps (`REMOTE_CLOUD_TASK_EXECUTION`/`AUTONOMOUS_CODE_EXECUTION`) or network-only (`NETWORK_ACCESS` present, no impl caps) → `DEVIN_PREFERRED`; any local implementation cap (`CODE_*`/`FILE_OPERATIONS`/`SHELL_EXECUTION`/`PYTHON_EXECUTION`/`REASONING`) → `CODEX_PREFERRED`; else `NEUTRAL`.
- **P12 `preferredExecutors`** is now bounded per tier: a preferred executor leads *within its own tier segment* — it can no longer vault a metered executor above a hard-eligible account executor.
- **VE advisor pool narrowed to the top tier**, and each pool member's effective base priority carries `suitabilityRank × 1000` (`SUITABILITY_BASE_GAP`, ≫ `MAX_ADJUSTMENT=40`) so Verified Experience may re-order only within equal suitability ranks — never across ranks or tiers.
- Decision receipt gains `task_suitability` + `economic_policy: "ACCOUNT_FIRST"` for audit evidence.

## Economic policy per executor

| Executor | Class | Role |
|---|---|---|
| CODEX | ACCOUNT_SESSION | default workforce — small/focused local work |
| DEVIN | ACCOUNT_SESSION | default workforce — remote/repo-scale/autonomous/long research |
| DEEPSEEK_HARNESS | METERED_API | fallback only — wins only when no account executor is eligible |
| PAIR_NATIVE | NATIVE | untouched — semantics preserved (still wins its exclusive caps) |

## Final routing order per task class

- impl-lane caps → `CODEX → DEVIN → DSH` (DSH only reachable if both account executors fail eligibility)
- remote-lane caps → `DEVIN` (sole server) → nothing else (no forced fallback)
- `NETWORK_ACCESS` alone → `DEVIN → CODEX` → DSH can't serve
- NEUTRAL (e.g. TELEGRAM_DELIVERY, empty caps) → `CODEX → DEVIN → DSH` (DEVIN only where caps allow)
- `AUTOMATON_TASK_EXECUTION` → `PAIR_NATIVE` (unchanged)

## Devin capability decision

`DEVIN_CAPABILITIES` kept **narrow** (`REMOTE_CLOUD_TASK_EXECUTION`, `AUTONOMOUS_CODE_EXECUTION`, `NETWORK_ACCESS`) — no extension. Instead the planner is steered to mint remote caps for repo-scale/autonomous/long-research work (new `LARGE-SCALE / AUTONOMOUS WORK` prompt bullet) and `sanitizePlan` now normalizes remote-lane tasks by stripping redundant local impl caps (`NORMALIZED_REMOTE_CAPS:<key>` warning) BEFORE the jointly-servable check — `{REMOTE_CLOUD_TASK_EXECUTION, FILE_OPERATIONS}` previously died as `DROP_UNSERVABLE_CAPS`; it now routes to DEVIN cleanly. `NETWORK_ACCESS` is never stripped (PAIR's network authority claim, not a redundant impl cap).

## Cost-guard decision

Quota/concurrency/kill-switch guards unchanged. `MAX_REMOTE_PER_DAY` default raised `10 → 50` (`PAIR_MAX_REMOTE_TASKS_PER_DAY` still overrides) and the comment re-framed: Devin runs on account/session economics, so the ceiling is a **resource ceiling on remote dispatches**, not a metered-spend budget. `PAIR_COST_HALT` semantics untouched.

## Recovery

No recovery-code change needed: the ordering itself yields Devin→Codex, Codex→Devin, both→DSH naturally inside the eligible set; `boundedAttemptWarnings`/reroute semantics untouched.

## Invariants held

- capability-router remains the single executor-selection authority; hard gates (capability/auth/qualification/workspace/network/quota/concurrency) evaluated before any economic ordering; suitability is select-only (never mutates `required_capabilities` — test A6 pins this).
- No second router, no LLM-at-runtime, no preferredExecutors-as-soft-hint, no F1–F5/delivery/Work Graph changes.

## Tests

- New `src/__tests__/pair-executor-suitability-v1.test.ts` — 27 tests: all 17 mandated truth-table scenarios (S1–S17) + adversarial (P12 tier-vault blocked, VE restricted to account tier, NEUTRAL ordering, metered-only pool, receipt fields, classifier map, PAIR_NATIVE preserved).
- Updated: `pair-p7.test.ts` test A (VE flip now between two account-tier executors — same guarantee, new tier semantics), `pair-p5.test.ts` tests 7/18/19 (DSH no longer wins shared caps; t19 exercises DSH canonical shape in a CODEX-free ctx), `pair-llm-planner.test.ts` (unservable-combo test moved to a genuinely unservable combo post-normalization + new normalization pin).
- Focused: suitability 27/27; p5 20/22 pass (2 env fails); p6/p7/phase-b/phase-c 210/210; llm-planner 17/17.
- **Full suite: 3866 pass / 3 fail** — the 3 fails are byte-identical baseline (F4 `R5.1-crash` spy + 2× P5 env executables); pass count rose exactly by the +27 new tests minus the 1 refactored suite count delta.

## tsc / build

`npx tsc --noEmit` clean; `rm -rf dist && npm run build` clean.

## Limitations / residual debt

- Remote-lane tasks have no non-DEVIN executor — with DEVIN down they fail-closed (eligible=∅) rather than degrading to local execution; that is the mandate's intent (remote lane is authoritative).
- DSH only carries out TELEGRAM_DELIVERY/file work when no account executor can serve it — if an operator *wants* DSH specifically, it must be the only eligible executor.
- Economic class map is executor_id-keyed; a future renamed/new executor id defaults to non-account tier (fail-safe toward metered ordering, never vaults).

## R1 — audit remediation (audited HEAD `b58bbd5`, pending audit)

Mandate R1.A–R1.H. Same-task bounded fallback, daily-limit removal, VE structural isolation, P12 consistency, planner nature-not-executor, ROUTING_POLICY_VERSION v2, DSH last, invariants kept.

### R1.A — task_profile hint (bounded, deterministic, canonical)

- New `TASK_PROFILES` enum {FOCUSED_LOCAL, LONG_RESEARCH, REPO_SCALE, LONG_AUTONOMOUS} + `PROFILE_SUITABILITY` + `profileSuitability()` in capability-router.ts; the planner describes the NATURE of work (`metadata.task_profile`), never an executor name. An unknown/forgeable value is stripped at sanitize (`DROP_INVALID_TASK_PROFILE:<key>`) — the task survives on caps-based suitability; the hint grants no authority and never bypasses hard eligibility.
- Suitability resolution order: `profileSuitability(metadata.task_profile) ?? taskSuitability(caps)` — declared nature wins; absent → caps inference (V1 rule).
- `metadata.task_profile` is bound into `canonicalPlanSemanticDigest` (plan-feasibility.ts) — a replan cannot silently rewrite the work's nature; sanitize + commitPlan carry it verbatim (`RawTask.task_profile` → `metadata.task_profile`).
- Codex PLAN_SCHEMA: `task_profile` added as a required property (strict-output API cannot express optional fields — same convention as every other schema property). Prompt: new `TASK PROFILE` bullet requires the declaration; `LARGE-SCALE / AUTONOMOUS WORK` bullet rewritten — remote caps only when remote semantics are genuinely required, never as an executor-preference proxy; minimum-capability principle kept.
- SAME-TASK fallback proof (R1.3/R1.4): identical caps+profile — DEVIN up → DEVIN, DEVIN down → CODEX; no capability-set delta. Genuine remote-cap tasks (REMOTE_CLOUD/AUTONOMOUS) still fail closed with DEVIN down — only that shape may legitimately produce eligible=∅ (R1.16).

### R1.B — Devin daily task limit REMOVED

- Deleted from scripts/serve-mission-control.mjs: `MAX_REMOTE_PER_DAY`, `PAIR_MAX_REMOTE_TASKS_PER_DAY`, `remoteDispatchesToday()`, the `n >= MAX_REMOTE_PER_DAY → BUDGET_EXCEEDED` branch, and defaults 10/50. No daily count remains anywhere — R1.13/R1.14 pin the mechanism's absence at source level.
- `PAIR_COST_HALT` / `COST_HALT_FILE` kept and re-framed as the OPERATOR REMOTE EXECUTION KILL SWITCH — the only remote-dispatch block, fail-closed (`REMOTE_EXECUTION_HALT`), never a soft quota.

### R1.C — VE structural isolation (no magic number)

- `SUITABILITY_BASE_GAP` (1000) deleted. Advisor pool is now computed structurally: `hard-eligible ∩ top economic tier ∩ top suitability rank` — VE may only re-order peers inside that pool using their ORIGINAL routing_priority bases; no injected scores. VE structurally cannot cross tier or rank (R1.8: priority delta >1000 still confined; R1.9: metered executor excluded whenever an account executor is eligible).

### R1.D — P12 consistency

- `preferredExecutors` reorders within its own (tier, rank) segment only — cannot vault DSH above account executors, cannot pull a lower suitability rank above the task's preferred rank, cannot resurrect a rejected executor (R1.10).

### R1.E / R1.F / R1.G / R1.H

- Planner writes nature+minimum caps only (R1.E); remote caps never used as proxy (R1.17 — CODEX fallback inherits nothing fake).
- `ROUTING_POLICY_VERSION` → `pair.os.vnext.capability-routing.v2` (receipts gain `task_suitability`, `task_profile`, `economic_policy`). Historical receipts are NOT rewritten — `verifyDecisionDigest` recomputes over stored fields, so a v1 receipt still verifies (R1.18).
- DSH last preserved: metered tier only wins when no account executor is eligible or DSH is the only hard-compatible executor (R1.6).
- Invariants kept: single routing authority, all 12 gates first, select-only semantics, no second router/LLM/NLP/global renumber.

### Tests (R1.1–R1.18 + boundary suite)

`src/__tests__/pair-executor-suitability-v1.test.ts` rewritten — 23 tests: R1.1–R1.18 pins (same-task profile fallback ×2, dispatch-time credential requalification fallback, >1000-delta VE isolation, P12 bounds, no-daily-limit source pin, kill-switch preserved, F2/F5 intact, historical v1 receipt verify) + classifier/profileSuitability boundary + NEUTRAL/metered/economic-class pins.

- Focused: suitability 23/23; p5 20/22 (2 baseline env fails); p6 36/36; p7; phase-b 123/123; phase-d 37/37; f2-handoff 53/53; f5 74/74; llm-planner 17/17 — all green.
- **Full suite: 3864 pass / 3 fail** — 3 fails byte-identical baseline (F4 R5.1-crash, 2× P5 env executables). Pass-count delta vs V1 count is exactly the test-file rewrite (27→23 tests).
- `npx tsc --noEmit` clean; `rm -rf dist && npm run build` clean.

## R2 — audit remediation round 2 (audited HEAD `efe6390`, pending audit)

Scope-reduction: the owner-locked policy drops the universal DEVIN→CODEX same-task fallback for remote-shaped work. task_profile is nature/audit metadata, never execution authority.

### R2.A/E — task_profile authority narrowed

- Suitability rule rewritten: `remoteContract (caps ∩ REMOTE_LANE_CAPS) → DEVIN_PREFERRED; declared FOCUSED_LOCAL → CODEX_PREFERRED; else caps-based`. A DEVIN_PREFERRED profile (LONG_RESEARCH/REPO_SCALE/LONG_AUTONOMOUS) is honored ONLY when the task's own capability contract is remote; on local/shared caps it degrades to caps-based inference — profile can never route a local task to DEVIN (R2.3/R2.8).
- `taskSuitability` no longer maps NETWORK_ACCESS-only → DEVIN_PREFERRED; ordinary network work is NEUTRAL → conservative intra-tier priority order (CODEX 60 before DEVIN 80). remote-vs-local classification remains purely capability-based — `isRemoteCapabilityTask` untouched, F2/F5 seams (remote_produces_contract, REMOTE_FETCH/LOCAL_MATERIALIZATION, dependency artifacts) unchanged (R2.9–11).

### R2.B — same-task repo fallback requirement withdrawn

- R1.3/R1.4 acceptance removed: `NETWORK_ACCESS + REPO_SCALE` is no longer a remote-routing claim. A remote task is `{REMOTE_CLOUD_TASK_EXECUTION|AUTONOMOUS_CODE_EXECUTION [+NETWORK_ACCESS]}` — DEVIN up → DEVIN; DEVIN down → eligible=∅ → existing recovery/replan, no forced local fallback (R2.4–R2.7).

### R2.C — planner contract

- `TASK PROFILE` bullet: profile = nature/audit metadata, never execution authority, required_capabilities is the contract. `REMOTE EXECUTION CONTRACT` bullet (replaces LARGE-SCALE wording): mint remote caps only for genuinely remote-sandbox work (autonomous remote session / remote workspace / long-running remote execution); ordinary network research = NETWORK_ACCESS + local caps, never remote-shaped; repo-scale/autonomous IS remote; no redundant local caps stacked onto remote tasks.

### R2.F/G — unchanged

- Daily Devin task count stays deleted; PAIR_COST_HALT/COST_HALT_FILE remain the operator kill switch (R2.15/16). DSH stays last: never vaults via priority/VE/P12, and remote-only tasks cannot degrade to DSH (it lacks remote caps — eligible=∅ is correct).

### Tests (R2.1–R2.16 + boundary)

`pair-executor-suitability-v1.test.ts` rewritten → 20 tests: full R2.1–R2.16 truth table + classifier (NETWORK_ACCESS→NEUTRAL), profileSuitability bounded map, receipt fields (task_suitability NEUTRAL + recorded profile), economic-class map, PAIR_NATIVE preserved, historical v1 receipt verify.

- Focused: suitability 20/20; llm-planner 17/17; f3 20/20; p6 36/36; p7 36/36; f2-handoff 53/53; f5 74/74; phase-d 37/37; p5 20/22 (2 baseline env fails).
- **Full suite: 3861 pass / 3 fail** — 3 fails byte-identical baseline (F4 R5.1-crash, 2× P5 env executables); pass delta vs R1 = test rewrite 23→20.
- `npx tsc --noEmit` clean; `rm -rf dist && npm run build` clean.
