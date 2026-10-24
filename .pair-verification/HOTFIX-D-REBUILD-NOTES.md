# HOTFIX-D clean rebuild — reproduction + minimal-fix design

BASE: `cf2674c67a6b3bf6fa8eac1de4cd90203f36b9c6` (`staging/pr59-safe`).
Incident: delegated work item `DL_4d48de10` — mission died at PLANNING with
`FAIL_CLOSED_DELIVERY_TASK_MISSING` (DETERMINISTIC).

## Reproduction (E1, run on exact BASE)

`src/__tests__/repro-e1.test.ts` drove the REAL production composition:

```
makeServePlanner({hasExecutor, executorCapSets, replanProvider:null})
  .planner({mission:{goal, metadata:{source:"business_layer"}}, reason:"initial"})
→ {tasks:[T1 AUTOMATON_TASK_EXECUTION, T2 REASONING]}   // no TELEGRAM_DELIVERY
validatePlanProposal → bindPlanExternalInputs →
assertPlanDataflow({telegramIntent: detect(goal)})
→ IntegrityError FAIL_CLOSED_DELIVERY_TASK_MISSING
```

Same call chain `MissionRuntime.runPlanning` executes (mission-runtime.ts
1304–1334). Non-retryable code → `planningFailureBoundary` → PLANNING→FAILED.

## Root cause (minimal)

`serve-planner.ts` `makeServePlanner.planner` — the deterministic template
fallback (T1 bookkeeping + optional T2 DSH + optional T3 codex, taken whenever
`pinned_plan_tasks` and `metadata.llm_plan` are absent — i.e. every delegated
WOB-bound mission) returns the raw template list WITHOUT the governed
Telegram delivery-injection authority that `canonicalizeLlmTasks` applies to
every LLM/persisted candidate (true-omission injection → `DELIVERY_TASK_INJECTED`
stamp → `reconcilePlanDataflow` manifest/plan-contract/language/edge stamping).

So for a TRUE operator Telegram intent the template emits zero delivery tasks
and the downstream `assertDeliveryTaskPresence` re-proof at the plan-commit
boundary throws `FAIL_CLOSED_DELIVERY_TASK_MISSING` — correctly (the plan IS
missing the task); the defect is upstream: the fallback never gave the
canonical authority a chance to repair the proven omission.

Secondary defect on the same path: template T2 embeds the operator goal
VERBATIM in `task_instruction`. Once a delivery task exists, the goal's
affirmative delivery clause trips `assertTaskDeliveryHygiene` (inside
reconcile) and `assertTaskDeliverySemantic` (pre-dispatch) — so the embed
must go (goal stays durable in `mission_goal.txt` via T1's worker_spec).

## Minimal fix (bounded, single authority)

`src/pair/serve-planner.ts` only:

1. Extract the canonicalizer's true-omission injection block (strip forged
   `PAIR_DELIVERY_INJECTION_KEY` → requested+zero-raw+zero-canonical →
   servable check → push injected `TELEGRAM_DELIVERY` task with the
   `DELIVERY_TASK_INJECTED` record) into ONE module-level helper used by BOTH
   the canonicalize seam AND the template fallback tail. No second authority.
2. Template tail: `detectTelegramDeliveryIntent(goal)` → when `requested`,
   inspect the template list itself as the unsanitized PAIR emission
   (proven ABSENT by construction), require the same servable proof
   (`executorCapSets` carrying TELEGRAM_DELIVERY) else
   `FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE`, require ≥1 content-bearing
   task else `FAIL_CLOSED_DELIVERY_INJECTION_NO_PRODUCER` (never fabricate
   an empty deliverable), inject, then run `reconcilePlanDataflow` with
   `{telegramIntent, outputLanguage, input.input_artifact_sources}` so the
   injected task receives the identical canonical stamp a planner-emitted
   one gets. Non-requested goals keep byte-identical BASE output.
3. T2 instruction: reference `mission_goal.txt` without embedding goal text.

Not changed (out of scope per mandate §3.D): declared_external_inputs
generalization, alias pinning, source-stamp inheritance, CAS namespaces,
planner provenance architecture, `assertPlanCoverage` on the template path
(coverage contract is LLM-candidate-shaped; template stays a fixed fallback),
no fail-closed weakening.
