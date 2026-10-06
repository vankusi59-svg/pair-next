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
