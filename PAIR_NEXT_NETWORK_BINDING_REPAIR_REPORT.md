# PAIR Next — NETWORK_ACCESS Binding Repair Report

Classification: `PAIR_NEXT_NETWORK_BINDING_REPAIR_PENDING_AUDIT`
Base: main `020f1c003c94f6fe722aef26593eb059b1112335` (post-PR#48 merge)
Branch: `devin/1791181348-network-repair` — NEW PR, **KHÔNG merge** (pending ChatGPT audit)

## 1. Scope delivered (mandate Option B)

A planner-emitted task that is **unambiguously live/web data-gathering work but
forgot to declare `NETWORK_ACCESS`** now gets the capability added by a
deterministic, bounded PAIR repair — BEFORE the canonical network gates —
instead of the plan dying solely on the model's annotation omission.

Pipeline (unchanged except the one new seam):

```
planner transport output → sanitizePlan(...) → repairNetworkCapabilityBinding(...)  [NEW]
→ tasks + warnings → makeServeCanonicalizer(...) → EXISTING network gates → PASS / FAIL_CLOSED
```

## 2. Changed files

| File | Change |
|---|---|
| `src/pair/llm-planner.ts` | New exported helper `repairNetworkCapabilityBinding` (+47 lines); wired post-`sanitizePlan` in `llmPlan` before its `{tasks, warnings}` return |
| `src/pair/codex-planner.ts` | Same helper imported and wired at the equivalent post-`sanitizePlan` seam (before the degenerate/usable filter and return) |
| `src/pair/planner-pool.ts` | `boundedAttemptWarnings` `isProtected` widened from the single `REPAIRED_REMOTE_DEPENDENT_EDGE:` prefix to the whole `REPAIRED_*:` family (so `REPAIRED_NETWORK_CAPABILITY:*` is never evicted — matches the existing `REPAIRED_*` protection already in `boundedReaskTaskWarnings`) |
| `src/__tests__/pair-network-binding-repair.test.ts` | New — adversarial T1–T10 |
| `CURRENT_STATE.md` | New entry |
| `PAIR_NEXT_NETWORK_BINDING_REPAIR_REPORT.md` | This file |

## 3. Helper contract (verbatim)

```ts
export function repairNetworkCapabilityBinding(
  tasks: Array<Record<string, unknown>>,          // post-sanitize plan tasks
  opts: {
    goal: string;                                 // operator goal — authority check
    allowedCapabilities: string[];                // planner vocabulary
    capabilitySets?: string[][];                  // executor capability universes
  },
): { tasks: Array<Record<string, unknown>>; warnings: string[] }
```

- Input tasks are never mutated in place — a repaired task is a shallow clone
  with `required_capabilities` replaced; ineligible tasks are returned by
  identity (`===`), so tests can prove zero-touch.
- Emitted capability order is canonical: `[...new Set([...caps, "NETWORK_ACCESS"])].sort()`.
- Emitted warnings: `REPAIRED_NETWORK_CAPABILITY:<task_key>` — merged
  deterministically (appended) into the transports' existing warning lists,
  reaching `planner_attempt.warnings` via the standard bounded seam.
- No task dropped, added, re-ordered, re-instructed, re-depended, or
  re-metadated. No new event/entity/env knob.

## 4. Eligibility predicate — ALL six required

| # | Condition | Enforcement |
|---|---|---|
| A | `goalRequiresCurrentExternalData(goal)` — the operator goal authorizes current/external data | early exit, zero task touched |
| B | `taskRequiresNetworkAccess(task_instruction)` — the task's OWN instruction is fetch/live-shaped | per-task check, no title/metadata inference |
| C | `instructionIsDataGathering(task_instruction)` — real gathering work, not a wrapper | per-task check |
| D | `instructionSatisfiesGoalSubject(task_instruction, goal)` — the task gathers the subject the goal is about | per-task check (R5 anchor rules reuse) |
| E | `"NETWORK_ACCESS" ∈ allowedCapabilities` | early exit |
| F | repaired set ⊆ ≥1 `capabilitySets` entry — servable by some executor | early exit when `capabilitySets` absent/empty (nothing to prove servability against) |

Any single failure → the task passes through untouched and the canonical gates
decide exactly as before. Detector semantics untouched — the helper consumes
the existing exported predicates verbatim.

## 5. Shared-helper proof (both transports)

- `llmPlan` (HTTP/Gemini lane): `const repair = repairNetworkCapabilityBinding(tasks, {goal, allowedCapabilities: cfg.allowedCapabilities, capabilitySets: cfg.capabilitySets})` immediately after `sanitizePlan` + the `LLM_PLAN_ALL_INVALID` guard, before `return {tasks, warnings}` — warnings merged `[...warnings, ...repair.warnings]`.
- `codexPlannerPlan` (codex transport): identical call + shape at the same semantic seam (`netRepair`), feeding the unchanged degenerate/`usable` filter and return — warnings merged identically.
- ONE implementation in `llm-planner.ts`; `codex-planner.ts` imports it. No per-transport logic.

## 6. Gates unchanged / ordering proof

`makeServeCanonicalizer` (serve-planner.ts) is **not modified** — zero diff in
the file. Plan-level gate still runs first (goal needs current data + no
legitimate NETWORK gatherer → `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`),
task-level gate second (fetch-shaped instruction without the capability →
`FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`). Because repair lives inside
each planFn (before canonicalize is ever invoked), the gates evaluate the
already-repaired plan — repairing only at the TASK throw site would leave the
PLAN gate blind. T10 proves both gates still fire post-repair.

## 7. No-elevation / fail-closed proof

- Local-only goal (A fails) → zero repair even with fetch-shaped instructions (T3).
- Subject mismatch (D fails) → zero repair; plan-level gate then rejects for no legitimate gatherer (T5).
- Already-correct binding → identity return, zero warnings (T8).
- `NETWORK_ACCESS` not in vocabulary (E fails) → zero repair (T7).
- Unservable repaired set (F fails) → zero repair — no runnable task is fabricated; the canonical gate fails closed (T6).
- Task-level gate still rejects a non-eligible fetch task even when a
  legitimate gatherer satisfies the plan-level gate (T10b).

## 8. Servability proof (condition F)

`repaired.every(c => set.includes(c))` must hold for at least one entry of the
`capabilitySets` actually supplied to the transport at plan time — the same
serving model `sanitizePlan` uses for `DROP_UNSERVABLE_CAPS`. When no sets are
supplied the helper returns the plan untouched (cannot prove a runnable
result → conservative no-repair).

## 9. Marker durability proof

`REPAIRED_NETWORK_CAPABILITY:<key>` is emitted through the transports' warning
lists → persisted on `planner_attempt.warnings` via `boundedAttemptWarnings`,
whose protected set now covers every `REPAIRED_*:` marker (T9: marker survives
>10 earlier unprotected warnings). `boundedReaskTaskWarnings` already protected
the `REPAIRED_*` family — no change needed there.

## 10. Tests

`src/__tests__/pair-network-binding-repair.test.ts` — **10/10 PASS**:

- **T1** llm lane end-to-end: `[REASONING]` fetch task → `[NETWORK_ACCESS, REASONING]` sorted, marker emitted, canonicalizer PASSES with the repaired plan.
- **T2** codex lane parity via a fake `codex` executable emitting the same plan → identical repair + marker + canonicalizer PASS.
- **T3** local goal → zero repair (task returned by identity).
- **T4** non-fetch instruction → no capability added.
- **T5** wrong-subject fetch → no repair; `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED` still throws.
- **T6** unservable repaired set → no fabricated repair → task-level gate fails closed.
- **T7** capability absent from vocabulary → no repair.
- **T8** already-correct → untouched, no warning.
- **T9** marker survives the bounded-warning budget.
- **T10** both network gates still authoritative post-repair (task-level on suppressed repair; plan-level satisfied by a legitimate gatherer while task-level still fires on a second non-eligible fetch task).

Regression: focused planner suites **366/366** (llm-planner 16, cpl1 49,
preask-feedback 39, prv2a 59, prv2b 52, pgrammar2 26, dataflow-incident 125);
`tsc --noEmit` clean; `pnpm build` (rm -rf dist path) clean; full suite
**3624 pass / 3 fail = the documented clean-main baseline** (2× P5 env-only —
real dsh/codex present on PATH; F4 `R5.1-crash` baseline defect). Zero new
failures.

## 11. Live repro (mandate §12)

Scratch stack on this branch (`:8790`, `pair-mc-netrep` DB, prod-identical
planner routes — sol → gemini → badq, all QUALIFIED):

**MQL5 current/web-research goal class, submitted twice:**

- Attempt 1 (sol) on BOTH submissions: durable `planner_attempt.warnings` =
  `["REPAIRED_NETWORK_CAPABILITY:T4","VALIDATION_CODE:FAIL_CLOSED_PLAN_INCOMPLETE","REASK:FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK","CANONICAL_VALIDATION_FAILED"]` — the repair fired and is durable; **no attempt across either submission died on any NETWORK capability code** (pre-fix this class reliably exhausted on `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`). The run still exhausted on the separately-known model defects (sol PLAN_INCOMPLETE→DELIVERY_VERB, gemini HTTP_503 / `PLAN_DATAFLOW_AMBIGUOUS_PRODUCER`, badq `LLM_PLAN_NO_JSON`) — reported as different failures per mandate.
- **Repaired candidate carries the capability**: the marker's durable presence on the attempt row proves the post-sanitize write reached canonicalize — which then evaluated and passed the NETWORK gates (its surviving rejections name DATAFLOW/DELIVERY/INCOMPLETE codes, never NETWORK).

**Simple current-data goal** (`fetch latest gold + BTC prices → outbox/prices_today.json`):

- Mission `MSN_01M45CCF3T9FY95JKS780PGF70` — **COMPLETED**.
- T2 fetch task executed with `required_capabilities=[FILE_OPERATIONS, NETWORK_ACCESS]`, **router-selected CODEX normally** (no direct executor selection); T1 bookkeeping → PAIR_NATIVE.
- Real artifact `outbox/prices_today.json` written (XAUUSD 4153.62 — GoldPrice.com; BTC 85718.8).

## 12. Limitations / explicitly out of scope

- Repair is annotation-only: it never infers network need from title,
  metadata, or goal alone — only the task's own instruction triggers.
- When no `capabilitySets` are supplied, no repair occurs (conservative).
- Gemini 503 flakiness, badq JSON degeneration, sol's PLAN_INCOMPLETE /
  DELIVERY_VERB classes are unchanged, pre-existing model-quality debts —
  reported separately, not this PR's scope.
- No prompt text changes (mandate: deterministic repair, not prompt tuning).
