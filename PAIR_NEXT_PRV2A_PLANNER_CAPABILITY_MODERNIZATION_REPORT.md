# PRV2-A — Planner Capability Modernization Report

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_PENDING_AUDIT`

| Field | Value |
|---|---|
| Base SHA (expected) | `2fd4a91a68e4bef144f7759cbc6e80a95c764351` (`main` post-PR #40 merge) |
| Base SHA (verified) | `2fd4a91a68e4bef144f7759cbc6e80a95c764351` |
| Branch | `devin/1791105961-prv2a-planner-modernization` |
| Files changed | `src/pair/llm-planner.ts`, `src/pair/serve-planner.ts`, `src/pair/codex-planner.ts`, `src/__tests__/pair-f3-r1-remediation.test.ts` |
| New file | `src/__tests__/pair-prv2a-planner-modernization.test.ts` (17 tests) |

Scope is verbatim mandate §A–G. Planner remains proposal-only; no
Router/Gate/executor/Telegram/artifact/CEO/Brain changes.

---

## §A+B+C — planner prompt wording (llm-planner.ts SYSTEM_PROMPT)

Removed executor-forcing wording; replaced with capability-sufficiency +
router-decides language. Exact changes:

- **"local executors have no internet → MUST use REMOTE"** →
  `CURRENT/EXTERNAL DATA` rule: the planner requests *capabilities
  sufficient* for current-data/network research; **"the Mission Router
  chooses WHICH executor satisfies the set"**. No executor name may be
  requested.
- **"real software MUST be remote"** → `SOFTWARE WORK` rule: planner picks
  the minimum capability set (CODE_GENERATION / CODE_EDITING /
  SHELL_EXECUTION / PYTHON_EXECUTION / FILE_OPERATIONS); the router picks
  the executor.
- **visual rule split** → `VISUAL DELIVERABLES` rule: chart from local
  data → normal compute (`PYTHON_EXECUTION`); web screenshot → a
  network-capable task; generated image → only when a governed capability
  exists — no forced remote, no invented executors.
- `REMOTE DATAFLOW CONTRACT` wording kept verbatim — declared-edge truth
  (produces/consumes) is unchanged.

## §D — PAIR-owned bookkeeping injection (`serve-planner.ts`)

- New exported `canonicalBookkeepingTask(goal)` — single canonical T1
  literal: `CANONICAL_BOOKKEEPING_INSTRUCTION`, caps
  `["AUTOMATON_TASK_EXECUTION"]`, `depends_on: []`, and the same existing
  `expected_output_contract` worker_spec (write_text_file
  `mission_goal.txt` with `content = goal` + finish; limits
  `max_ops:4 / timeout_seconds:30`; `allowed_ops [write_text_file,
  finish]`). The goal is payload inside the worker_spec, never inside the
  instruction — Telegram intent cannot leak into the bookkeeping
  instruction.
- `makeServeCanonicalizer` now accepts optional `maxWorkTasks` and runs:
  1. partition `rawTasks` via `isBookkeepingShapedTask` (filtered caps ⊆
     `{AUTOMATON_TASK_EXECUTION}` + `isPureBookkeepingTask`) — model-emitted
     bookkeeping is dropped and its keys remembered (`bookkeepingKeys`);
     a bookkeeping-only plan resolves to `[]` (no work remains);
  2. `sanitizePlan(workRaw, SERVE_LLM_PLANNER_CAPS,
     resolveWorkTaskBudget(goal, deps.maxWorkTasks), capSets)` — the
     budget counts WORK tasks only;
  3. deterministic key remap: kept work tasks become `T2..T(n+1)` in
     emitted order;
  4. dependency remap: a dep on a dropped bookkeeping-shaped task resolves
     to `T1` (dedup); sanitized deps map through the keyMap; unknown deps
     were already rejected by sanitize;
  5. prepend `[canonicalBookkeepingTask(goal)]` → existing
     AUTOMATON worker_spec injection (mixed-cap AUTOMATON tasks still get
     a spec → `AMBIGUOUS_PRODUCER`/contract rules still reject them
     deterministically) → `reconcilePlanDataflow` (all artifact/dataflow
     authority unchanged).
- Mixed-capability AUTOMATON tasks (e.g. `[AUTOMATON, FILE_OPERATIONS]`)
  are NOT bookkeeping-shaped — they are work tasks that keep running under
  the unchanged spec-injection + dataflow rules.
- Idempotent: a post-injection canonical plan re-canonicalizes to itself,
  so `canonicalPlanSemanticDigest` equality still binds replays (regression
  proved in `pair-f3-r1-remediation` A7c: pinned canonical plan + replayed
  work graph → `REJECTED_DUPLICATE` ×2, one revision).
- The template planner's inline T1 literal was replaced by the shared
  `canonicalBookkeepingTask(goal)` (deduplicated identical contract).
- `llmPlan` + `codexPlannerPlan` degenerate check now counts *usable* work
  tasks (`usable.length >= LLM_PLANNER_MIN_TASKS = 1`): a
  bookkeeping-shaped emission contributes zero usable tasks and stays a
  degenerate PLAN_INVALID — the model cannot satisfy the "plan must do
  work" rule by emitting bookkeeping.

## §E — adaptive work-task budget (`llm-planner.ts`)

Exact deterministic rule (documented in code):

```
score = wordCount + 4*min(numberedListMarkers,10) + 2*connectiveHits
score ≤ 40   → simple  → budget 4
score ≤ 120  → medium  → budget 6
score  > 120 → complex → budget 10
absolute hard ceiling: 12 work tasks (config can only tighten, never raise)
```

- `resolveWorkTaskBudget(goal, configuredMax?)` =
  `min(deriveWorkTaskBudget(goal), min(configuredMax ?? 12, 12))`, floor 1.
- Bookkeeping task NOT counted (it is injected after sanitize).
- `buildPlannerUserPrompt` now emits `WORK_TASKS: <resolved budget>` and
  the prompt carries 5 anti-over-planning reasons to split (distinct
  deliverable / capability boundary / parallelizable work / verification
  boundary / side-effect boundary) — no microtasks.
- `LLM_PLANNER_DEFAULT_MAX_TASKS=5` is now unused by new code paths
  (env-override `cfg.maxTasks` still feeds `resolveWorkTaskBudget` as the
  configured ceiling, preserving env-override semantics).

## §F — preserved governance (explicitly unchanged)

`validatePlanProposal`, DAG validity, capability allowlist
(`SERVE_LLM_PLANNER_CAPS` / codex `PLANNER_CAPS`), joint-servability,
artifact authority (`reconcilePlanDataflow`, declared-edge remote rules,
`isPureBookkeepingTask`, delivery-manifest/provenance, DSN-1 spelling
equivalence, F1/F2 ingest/handoff), telegram intent
(`detectTelegramDeliveryIntent`, `assertDeliveryTaskPresence`, R8
intent↔presence invariant, delivery-verb scan), output-language
authority, reserved metadata, handoff pin, eligibility (16-gate),
CPL-1 failover order + typed attempts, role separation, codex
network-disabled planner profile, Router/Gate/artifact/credential
authority — all untouched. Remote-task DAG-leaf restriction unchanged.
Planner still returns proposals; acceptance still runs the same seam.

## §G — no Brain/CEO additions

None. No new entities, tables, env vars, or capabilities introduced.

---

## Validation

| Suite | Result |
|---|---|
| Focused PRV2-A (`pair-prv2a-planner-modernization.test.ts`) | **17/17 PASS** |
| `pair-f3-r1-remediation.test.ts` | **20/20 PASS** (3 fixtures updated for new canonical shape: A6 expects T1-injected plan; A7b/A7c pin canonicalized committed plans + real PAIR_NATIVE harness + async drive) |
| `pair-llm-planner`, `pair-cpl1-codex-planner` | PASS |
| `pair-f3-*`, `pair-f4-*`, `pair-f5-*`, `pair-f2-*`, `pair-f1-*`, `pair-dsn1-*`, `pair-acr1-*`, `pair-output-*`, `pair-phase-a/b/c/d/e`, `pair-p23/24`, CNI-1, planner failover | PASS (full suite) |
| Full suite | **3403 pass / 2 failed** — the same 2 env-only P5 failures as `main` baseline (DSH/CODEX stock adapter probe expects executable-absent; executables are installed on this machine) |
| `npx tsc --noEmit` | PASS (0 errors) |
| `rm -rf dist && pnpm build` | PASS (clean build) |
| `pnpm audit --audit-level=high` | 0 high (1 low, 8 moderate — unchanged vs baseline) |

Baseline comparison: `main` @ `2fd4a91` also reports 3403 pass / same 2
env-only P5 fails — zero non-environmental regressions.

## Required tests coverage (mandate §tests)

17 focused tests covering: prompt assertions for §A (no "MUST use
remote"/internet forcing), §B (software minimum-set wording), §C (visual
split), §D (work-only emission + NEVER AUTOMATON + PAIR injects), §E
(budget + anti-over-planning); injection tests — T1 injected,
deterministic keys, dep→bookkeeping remap to T1, dedup guard,
bookkeeping-only → `[]`, Telegram-goal non-leak (instruction clean,
worker_spec carries goal), mixed-cap AUTOMATON not dropped;
budget tests — simple/medium/complex boundaries + hard ceiling +
determinism + configured-cap tightening; `canonicalBookkeepingTask`
byte-determinism. Mandate asked for ≥16 — delivered 17.

## Residual limitations (explicitly documented, out of scope)

- **`PLAN_SCHEMA` still lacks edge fields** (`additionalProperties:false`,
  no `produces`/`consumes`/`metadata`): codex cannot emit declared edges
  — remote-producer → consumer plans stay unplannable via codex until a
  future mandate adds the fields. Recorded per mandate (not silently
  widened).
- `PAIR_PLANNER_MODEL_ROUTE` env override semantics unchanged.
- `isBookkeepingShapedTask` judgement is by capability-shape only (by
  design — the model cannot invent a second bookkeeping contract since
  PAIR owns the only legal one).

STOP — pending independent audit. DO NOT MERGE.

---

# PRV2-A R1 — Independent-audit remediation (reserved AUTOMATON + real NETWORK_ACCESS)

Base: PR #41 branch `devin/1791105961-prv2a-planner-modernization`, audited
HEAD `932ced7`. Two audit blockers, both closed on the same branch. DO NOT
MERGE — pending audit.

## R1.A — AUTOMATON_TASK_EXECUTION is PAIR-owned, not prompt-forbidden

**Invariants (verbatim from mandate):**

- RAW MODEL WORK TASKS → MUST NEVER retain `AUTOMATON_TASK_EXECUTION`.
- FINAL CANONICAL PLAN → exactly one `AUTOMATON_TASK_EXECUTION` task →
  `task_key` T1 → exact `canonicalBookkeepingTask(goal)`.

**Design:**

- `SERVE_LLM_WORK_CAPS` (`serve-planner.ts`) = `SERVE_LLM_PLANNER_CAPS`
  minus `AUTOMATON_TASK_EXECUTION` — the model-visible work vocabulary.
  `SERVE_LLM_PLANNER_CAPS` stays the final canonical vocabulary for
  `validatePlanProposal`. `serve-mission-control.mjs` now feeds planners
  `SERVE_LLM_WORK_CAPS` (`LLM_PLANNER_CAPS`), so `buildPlannerUserPrompt`'s
  `ALLOWED_CAPABILITIES:` line can never show AUTOMATON to a model.
- `reservedAutomatonMisuseKey(rawTasks)` (`llm-planner.ts`) inspects the
  RAW emission before any sanitization: a task is a violation iff its raw
  `required_capabilities` contains AUTOMATON AND it is not
  `isPureBookkeepingTask` — i.e. a MIXED task (`[AUTOMATON, X]`) or a pure
  task carrying a foreign worker_spec. Returns the offending `task_key`.
- Enforced at two barriers with the correct failover semantics each:
  - `llmPlan` / `codexPlannerPlan` (planner layer): returns
    `{ tasks: [], warnings: ["LLM_PLAN_RESERVED_CAPABILITY_AUTOMATON:<key>"] }`
    — a deterministic typed candidate rejection, failover-eligible
    (`classifyPlannerFailure` default → PLAN_INVALID). Deliberately NOT an
    IntegrityError here: thrown planFn errors abort the whole run without
    failover (planner-pool.ts), which would be a worse outcome.
  - `makeServeCanonicalizer` (canonical layer): throws `IntegrityError`
    `FAIL_CLOSED_PLAN_RESERVED_CAPABILITY_AUTOMATON_TASK_EXECUTION` — the
    canonicalize throw becomes a FAILED/`CANONICAL_VALIDATION_FAILED`
    attempt → next candidate (failover-eligible). Covers any raw task
    stream that bypasses the planner layer.
- A mixed task is NEVER stripped-and-pretended: the whole candidate dies —
  no surviving FILE_OPERATIONS variant, no second bookkeeping worker_spec,
  no false-completion path.
- Pure bookkeeping-shaped emissions still normalize exactly as before
  (dropped, deps remapped to T1). To preserve the end-to-end
  bookkeeping-dep→T1 remap, both planners sanitize the model's work
  against `sanitizeCaps = allowedCapabilities ∪ {AUTOMATON}` — a
  shape-passthrough only, never model-visible: AUTOMATON is still absent
  from `allowedCapabilities` in the prompt, the raw reserved-misuse check
  runs first, and `isBookkeepingShapedTask` is evaluated against
  `sanitizeCaps` so bookkeeping emissions don't count as usable work.
- Final-plan invariant tests prove exactly one AUTOMATON task = T1 =
  `canonicalBookkeepingTask(goal)` (modulo `pair_dataflow` annotations
  stamped by `reconcilePlanDataflow`).

## R1.B — NETWORK_ACCESS is a real routing fact

**Design:**

- `NETWORK_ACCESS` added to `SERVE_LLM_PLANNER_CAPS` and to the
  `service.registerCapability` list in `serve-mission-control.mjs` — it is
  a real, registered capability (`validatePlanProposal` accepts it;
  known-capability test B6).
- Planner prompt: current/external-data tasks MUST include
  `NETWORK_ACCESS` in `required_capabilities`; a live-website screenshot
  needs it. Explicitly framed as a routing fact — the router picks WHICH
  executor is currently authorized; the model never assumes one.
- Devin: static `NETWORK_ACCESS` added to `DEVIN_CAPABILITIES` (governed
  cloud environment has ambient network).
- Codex: `capabilities()` claims `NETWORK_ACCESS` LIVE — appended only
  when `codexNetworkAllowed()` (CNI-1: `PAIR_CODEX_NETWORK` resolved per
  call via `envReader`) is truthy. A static registration can therefore be
  stale; the claim must be re-proven at dispatch.
- CapabilityRouter DISPATCH step 5b: when the task requires
  `NETWORK_ACCESS` and the executor passed all prior gates (incl. live
  `qualify()`), the adapter's CURRENT `capabilities()` output must declare
  `NETWORK_ACCESS` — else `MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS`.
  `PAIR_CODEX_NETWORK=off` after a boot-time ON registration → the static
  claim passes step 3 but the live check fails closed. CNI-1 per-dispatch
  resolution is untouched (argv still binds `network.enabled`/`web_search`
  per dispatch).
- DSH: `DSH_CAPABILITY_IDS` unchanged — no NETWORK_ACCESS; it can never
  be network-eligible merely via REASONING/SHELL_EXECUTION.
- Asymmetry (fail-closed, documented): boot-OFF→flip-ON Codex stays
  un-servable until re-registration, because step 3's static check fails
  first; boot-ON→flip-OFF is caught by the live check. Recorded as
  residual, consistent with fail-closed bias.
- No REASONING/SHELL/PYTHON proxy accepted anywhere: network tasks route
  only on the explicit `NETWORK_ACCESS` fact.

## Validation

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (0 errors) |
| Focused PRV2-A suite | **33/33 PASS** (17 base + 16 new: vocab/prompt, reserved-adversarial 7-case matrix, network-routing B1–B6) |
| `pair-llm-planner` | 16/16 PASS |
| `pair-cpl1-codex-planner` | 49/49 PASS |
| `pair-cni1-codex-network` | 22/22 PASS |
| `pair-planner-dataflow-incident` | 106/106 PASS |
| `pair-ops-telegram-delivery` | 3/3 PASS |
| `pair-f3-*` (4 suites) | 72/72 PASS |
| `pair-p4`/`p7`/`p8` (router/governance) | 81/81 PASS |
| Full suite | **3419 pass / 2 failed** — the same 2 env-only P5 fails as `main` `2fd4a91` baseline (stock-adapter probes expect missing executables; both present on this VM) |
| `rm -rf dist && pnpm build` | PASS (clean build) |
| `pnpm audit` | 0 high (1 low, 8 moderate — unchanged, no new deps) |

## Required adversarial + routing tests delivered

R1.A: `SERVE_LLM_WORK_CAPS`/prompt vocabulary (2), reserved mixed-task
adversarial `canon()` throws (3: single mixed, mixed-among-others,
pure-with-foreign-worker_spec), exact-one-AUTOMATON=T1 invariant (2),
`llmPlan` typed-warning rejection + bookkeeping passthrough (2).
R1.B: DSH-not-selected (B1), codex live-OFF reject
`MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS` (B2), live-ON eligible (B3),
offline reasoning task unaffected (B4), real `CodexCliExecutorAdapter`
live claim toggling on `PAIR_CODEX_NETWORK` with a qualified fake-CLI
fixture (B5), `NETWORK_ACCESS` registered known capability (B6).

## Residual limitations

- Boot-OFF→flip-ON Codex needs a re-registration to serve network tasks
  (static step-3 check fails closed first). The unsafe direction (ON→OFF)
  is closed live. Stale-claim alternative — recording a static claim that
  cannot represent per-dispatch state — was rejected per the mandate's
  live-proof guidance.
- `PLAN_SCHEMA` still cannot emit declared edge fields (unchanged from
  base PRV2-A residual — not silently widened).

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R1_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.
