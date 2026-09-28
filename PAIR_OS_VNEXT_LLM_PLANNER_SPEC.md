# PAIR OS vNext — LLM Planner Specification (P-UI-6)

Status: PROPOSED → implemented incrementally in this change.

## 0. Problem

The Mission Control serve script ships a minimal template planner
(T1 record goal → optional T2 DSH analysis). The runtime core
(`src/pair/*`) accepts arbitrary plans, but nothing generates them
from natural-language goals. This spec adds an LLM planner that turns
a goal into a governed task DAG, while keeping every existing safety
invariant (proposal-only planner, `validatePlanProposal`, plan digest
confirm, capability-driven routing).

## 1. Authority boundaries (non-negotiable)

- The LLM planner is a **proposal generator only**. It may not mutate
  canonical state, choose executors, or bypass `validatePlanProposal`.
- Executor selection stays with `CapabilityRouter` — the LLM only picks
  `required_capabilities` from a whitelist; the router maps capability
  → executor as today.
- The §4.3 two-step confirm is preserved: operator sees the plan,
  confirms the digest; `FAIL_CLOSED_PLAN_DIGEST_MISMATCH` still guards
  TOCTOU. Any tampering with tasks between preview and submit mismatches
  the digest and is rejected.
- LLM output is untrusted input: parsed, schema-validated, capability-
  whitelisted, size-capped. Malformed/violating output → deterministic
  fallback plan (never a crash, never partial execution).

## 2. Design

### 2.1 New module `src/pair/llm-planner.ts`

Pure async function — no canonical state access:

```ts
llmPlan(goal, cfg: {
  endpoint,          // provider chat/completions URL
  credentialEnv,     // env var NAME (never the value)
  model,
  maxTasks = 5,
  allowedCapabilities,
  timeoutMs = 20000,
  fetchFn = fetch,   // injectable for tests
}) → { tasks, source: "LLM" | "FALLBACK", model?, warnings? }
```

- Calls the provider's OpenAI-compatible `chat/completions` endpoint
  (same endpoint/credential reference used by P6 qualification — the
  secret value is only read from `env[credentialEnv]` inside the call).
- Prompt asks for JSON: `{tasks:[{task_key,title,task_instruction,
  required_capabilities,depends_on}]}` with rules: acyclic T-keys,
  self-contained instructions, first task records the goal via
  PAIR-native contract when file output is needed.
- Validation & clamping:
  - `task_key` matches `T\d+`, unique;
  - `required_capabilities` ⊆ whitelist, non-empty;
  - `depends_on` only references earlier keys (acyclic by construction);
  - `task_instruction` string ≤ 2000 chars;
  - task count ≤ `maxTasks`; invalid tasks dropped; zero valid → fallback.
- Fallback plan = minimal T1 (write `mission_goal.txt` + finish), the
  same safe contract the template planner uses today.

### 2.2 Server seam (canonical, optional)

`mission-control-server.ts` gains one optional dep:

```ts
planExpander?: (input: MissionInput) => Promise<MissionInput>
```

Applied inside `POST /api/missions/preview` and `POST /api/missions`
before calling `mc.previewMission` / `mc.startMission`. Default absent →
canonical server stays pure and offline. The serve script provides the
LLM implementation; other deployments can inject any expander.

### 2.3 Plan transport — no server-side cache

`planExpander` returns input with `metadata.llm_plan` = validated task
list. The sync `RuntimePlanner` reads `input.mission.metadata.llm_plan`;
absent → template fallback. Because `previewMission` feeds
`input.metadata` into the planner both at preview and at submit-confirm,
the same `llm_plan` yields the same digest — so the client echoes the
previewed `plan.tasks` back in `metadata.llm_plan` on submit and the
digest check proves it is exactly what was previewed. Expiry/replay
concerns are nil: a stale or foreign plan simply mismatches or is
accepted *as the confirmed plan* by definition of the digest check.

### 2.4 Serve script wiring

`planExpander` resolves the primary route (`PAIR_DSH_MODEL_ROUTE`,
default `gemini:gemini-3.1-flash-lite`) against the P6 provider catalog
entry: `endpoint_reference` + `credential_reference_name` → `llmPlan`.
Planner priority order inside the sync planner:

1. `metadata.llm_plan` (validated task list) → returned verbatim;
2. template planner (T1 + T2 DSH + optional T3 Codex) when absent.

`metadata.plan_source`/`plan_model` recorded on the mission for audit.

## 3. UI changes

- MissionNew preview panel shows `plan_source` badge: **LLM plan**
  (model name) or **template fallback**.
- Submit echoes `metadata.llm_plan = plan.tasks` with
  `confirm_plan.digest` — no other API changes.

## 4. Limits & non-goals

- `maxTasks` default 5; `timeoutMs` default 20s — LLM latency never
  blocks the runtime (expand runs at API edge, before mission exists).
- No streaming, no multi-turn refinement, no planner replanning from
  the LLM mid-mission (replan seam keeps the template path for now).
- Whitelist capabilities registered in the serve script:
  `AUTOMATON_TASK_EXECUTION, FILE_OPERATIONS, REASONING, CODE_GENERATION,
  CODE_EDITING, SHELL_EXECUTION, PYTHON_EXECUTION` (+ `REMOTE_CLOUD_…`
  only when a DEVIN executor is governed — the LLM cannot conjure
  executors).

## 5. Acceptance

- `pnpm test` green incl. new unit tests for `llmPlan` (fake fetch:
  happy path, malformed JSON, over-cap task drop, cycle drop,
  capability filtering, timeout → fallback).
- Live: `POST /api/missions/preview` produces an LLM-generated DAG
  (`plan_source: LLM`); confirm runs it end-to-end with real DSH task;
  tampered `llm_plan` → `FAIL_CLOSED_PLAN_DIGEST_MISMATCH`.
- No LLM call on the critical path when `planExpander` is absent.
