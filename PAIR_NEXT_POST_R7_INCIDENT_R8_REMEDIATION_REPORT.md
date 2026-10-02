# PAIR NEXT — POST-R7 INCIDENT R8 REMEDIATION REPORT

**Mandate:** DELIVERY PLAN-SHAPE AUTHORITY + TASK SEMANTIC HYGIENE + DETERMINISTIC INCAPACITY RECOVERY CLOSURE
**Base:** `main @ 8e1d35b834021cc105bf7c1d5de3200fcf5460b0` (post-PR#27, R1–R7 merged)
**Branch:** `devin/1790927004-incident-r8`
**Status:** NOT MERGED — pending independent audit

---

## 1. Root cause (production incident `MSN_01M3XP0ME1GKFHD00H4Z3GWC1H`)

Goal: `đào sâu dữ liệu mql5.com, … rồi gui bao cao này đến telegram` (unaccented "gui").
The planner folded the delivery request into a CODEX task's instruction
(`… write it to outbox/report.txt, and send the content to Telegram`) instead of
emitting a `TELEGRAM_DELIVERY` task. CODEX wrote the report but could not perform
external delivery → reported failure → `CODEX_AGENT_REPORTED_FAILURE` classified
as `PROCESS_EXIT` (retryable) → 4 same-route attempts → WAITING_APPROVAL, **zero
TDRs minted**. The canonical delivery layer (R2–R7) was never engaged.

Three authority gaps: (a) nothing required a delivery task to exist when the
operator requested one; (b) nothing forbade a send directive inside a
non-delivery task; (c) deterministic "I can't do this" executor evidence was
treated as a transient crash.

## 2. Invariant design + enforcement points

### §1 intent ↔ presence — `assertDeliveryTaskPresence(tasks, intent)`
- `requested=true` & 0 delivery tasks → `FAIL_CLOSED_DELIVERY_TASK_MISSING`
- `requested=true` & >1 → `FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS`
- `requested=false` & any delivery task → `FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT` (existing)
- Enforced in `reconcilePlanDataflow` (before stamping/edges — runs before the
  failover winner is chosen) AND re-proven at immutable boundaries via
  `assertPlanDataflow(tasks, { telegramIntent: detectTelegramDeliveryIntent(goal) })`:
  **preview** (`mission-control.ts`), **confirm**, **runPlanning**,
  **runReplan** (`mission-runtime.ts`). One canonical helper, no diverging
  validators. Intent derives only from the operator goal — never from files,
  outbox contents, or task prose.

### §2 instruction hygiene — `assertTaskDeliveryHygiene(tasks)`
Non-`TELEGRAM_DELIVERY` task whose instruction parses as an affirmative
delivery clause → `FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK`. Reuses
`detectTelegramDeliveryIntent` (the existing clause-scoped Unicode/VN grammar
with negation and clause-boundary rules) — no second regex grammar. Negated
clauses ("do not send…", "không gửi…") do not trip it.

### §3 PAIR-owned canonical instructions
- Every canonical `TELEGRAM_DELIVERY` task gets
  `canonicalDeliveryTaskInstruction(intent)` — a deterministic
  preparation-only contract: read `dependency_outputs`, compose the report to
  `outbox/report.txt` (and stage manifested artifacts for FILES), **"Do NOT
  call Telegram…"**, reply DONE. The text itself contains no affirmative
  delivery clause (verified by the test parsing it back through the intent
  detector).
- Pure bookkeeping tasks (`caps ⊆ {AUTOMATON_TASK_EXECUTION}` + mission_goal
  worker_spec) get `CANONICAL_BOOKKEEPING_INSTRUCTION` — the goal may contain
  a send request as payload, so the goal text is never echoed as a directive.
- `pair_telegram_delivery` manifest is PAIR-owned: planner-supplied manifest is
  stripped and restamped from operator intent only (never widened).
- External send stays downstream: COMPLETED → `mintTelegramDeliveryRequest` →
  bridge → governed transport → Telegram API. The bridge is not an executor;
  no executor holds Telegram credentials.

### §4 pre-dispatch semantic check — `assertTaskDeliverySemantic(task)`
At the dispatch arm (inside the governed try/catch before `routeGovernedTask`):
a task whose instruction contains affirmative delivery semantics but lacks
`TELEGRAM_DELIVERY` in `required_capabilities` →
`FAIL_CLOSED_TASK_DELIVERY_SEMANTIC_MISMATCH` → classified `PLAN_INVALIDATED`
(bounded REPLAN, zero retry, **zero dispatch**). The invariant is on the task's
role/capability, not the selected executor's capability set.

### §5 `TASK_INFEASIBLE` — deterministic executor incapacity
- New stable failure class (FAILURE_CLASSES 28th, after DEPENDENCY_FAILURE).
- `RECOVERY_MATRIX.TASK_INFEASIBLE = { actions: ["REPLAN","ABORT"], retry_allowed:false }` — no `RETRY_SAME_ROUTE`.
- `classifyFailure` maps only when BOTH hold: an executor-reported-failure
  marker (`AGENT_REPORTED_FAILURE` across errClass/errCode/error.class/
  error.message) AND a bounded explicit incapacity signal
  (`AGENT_INCAPACITY_SIGNAL`: "no … tool is/are unavailable|not available|missing",
  "required tool … unavailable/not available/missing", "cannot perform the
  requested capability", "no telegram delivery tool"). Arbitrary FAILED
  responses without the marker+signal stay their base class — normal crashes
  remain `PROCESS_EXIT`. No fuzzy prose matching.

### §6 incident repro
The exact prod goal + plan shape is rejected deterministically
(`FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK` on T3; presence would throw
`MISSING` for a detected-request goal). On the valid shape ([T1 bookkeeping,
T2 produce, T3 TELEGRAM_DELIVERY leaf]) the delivery task's instruction is
canonicalized and exactly one TDR is minted.

## 3. Test matrix A–N (all in `src/__tests__/pair-planner-dataflow-incident.test.ts`)

A missing→MISSING · B two→AMBIGUOUS · C no-intent+delivery→INTENT ·
D/E EN+VN send-verb on non-delivery task→VERB · F negated clauses pass ·
G canonical instruction has no affirmative directive + manifest kept ·
H planner manifest stripped/restamped, never widened · I domain + persisted
bypass at dispatch →PLAN_INVALIDATED zero dispatch then bounded REPLAN→COMPLETED ·
J incapacity→TASK_INFEASIBLE (unit + runtime, no RETRY_SAME_ROUTE, ≤1 exec/task) ·
K normal crash→PROCESS_EXIT retryable · L R2–R7 tests unchanged ·
M exact prod E2E rejected · N correct E2E→1 TDR, no duplicate, R7 semantics.

## 4. Evidence

- Focused incident file: **90/90 PASS** (74 → 90; +16 R8 tests).
- Related suites: `pair-ops-telegram-delivery` 3/3, `pair-llm-planner` 16/16,
  `pair-p8` 49/49 (matrix count updated 27→28 for TASK_INFEASIBLE),
  phase B/C/D + live-ops + route-capability 267/267.
- Full suite: **2655 pass / 2 fail / 15 skipped** — the 2 fails are the known
  env-only P5 probe tests (DSH/CODEX executables present on this machine;
  identical on baseline `8e1d35b`).
- `npx tsc --noEmit` clean; `pnpm build` clean.

## 5. Compat / migrations

- `assertPlanDataflow` gained an optional `{telegramIntent}` param; existing
  callers unchanged (hygiene always applies; presence applies when intent is
  supplied — supplied at all four runtime boundaries).
- `PAIR`-owned instruction rewrite affects only canonical bookkeeping tasks
  and TELEGRAM_DELIVERY tasks; the serve-side fallback T1 literal now uses
  `CANONICAL_BOOKKEEPING_INSTRUCTION` (identical semantics, deterministic text).
- `FAILURE_CLASSES` +1 (TASK_INFEASIBLE); p8 matrix-count test updated
  accordingly. No schema changes; persisted rows unaffected.
- Grammar intentionally does NOT include unaccented "gui" — bounded,
  deliberate; the incident is still caught by hygiene/presence.

## 6. Residual risks / debt

- Unaccented-Vietnamese delivery intents ("gui", "ban") are rejected as
  non-requests (fail-closed) rather than normalized — planner must emit the
  delivery task; operator wording with accents/"send" works today.
- `start-pair-live.sh` 30s health check still races a slow boot (bridge
  needs a manual start) — ops debt noted previously, unchanged.
- Legacy persisted plans (pre-R8) that contain send-verb instructions will
  now fail closed at confirm/replan — intended hardening, fail-closed.

**Classification:** `PAIR_NEXT_POST_R7_INCIDENT_R8_PENDING_INDEPENDENT_AUDIT`
STOP. DO NOT MERGE. DO NOT START PHASE E.
