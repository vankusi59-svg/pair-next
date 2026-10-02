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
- (Historical, pre-remediation — superseded by R1/R2 below) the grammar
  originally did NOT include unaccented "gui"; since R1 `gui` is a
  high-confidence alias of `gửi`, and since R2 an all-caps `GUI` token is
  explicitly NOT a delivery verb. Other unaccented forms remain
  non-verbs unless individually justified and regression-tested.

## 6. Residual risks / debt

- (Historical, pre-remediation — superseded by R1) unaccented "gui" was
  originally rejected as a non-request; it is now supported. "ban", "day",
  "dang" etc. remain non-requests — accent stripping is not used globally.
- `start-pair-live.sh` 30s health check still races a slow boot (bridge
  needs a manual start) — ops debt noted previously, unchanged.
- Legacy persisted plans (pre-R8) that contain send-verb instructions will
  now fail closed at confirm/replan — intended hardening, fail-closed.

---

## Independent Audit Remediation R1 — unaccented `gui` delivery-intent closure

**Audit blocker:** the exact production goal used unaccented `gui` (gửi) —
`detectTelegramDeliveryIntent` returned `requested=false`, so §1 presence
could neither require a delivery task nor accept a correct one for the real
operator wording.

**Root cause:** `DELIVERY_VERB_RE` carried accented `gửi` but deliberately
excluded the bare `gui` alias, chosen earlier to keep the grammar bounded.

**Chosen fix (one canonical grammar, no second parser):** `gui` added as an
explicit bare-word alternative in `DELIVERY_VERB_RE`. All existing bounds stay
authoritative — letter-boundary lookarounds, Telegram mention required within
`CLAUSE_SPAN`, `clauseNegated` lookback, artifact clauses unchanged. `gửi`
never matched at ASCII word boundaries before the Unicode lookaround work;
`gui` is admitted the same way.

**Why no global diacritic strip:** stripping Vietnamese accents would turn
`bao cao` (= báo cáo, "report") into the delivery verb `báo` — e.g.
`"tao bao cao ve telegram"` must stay `requested=false`. Only
high-confidence bare aliases are admitted; `gui` is unambiguous in this
grammar (letter-bounded; `guide`/`beguile`/embedded `gui` never match).

**New/changed tests** (`pair-planner-dataflow-incident.test.ts`):
- M rewritten — the exact prod goal now proves `intent.requested===true`
  AND zero-delivery plan → `FAIL_CLOSED_DELIVERY_TASK_MISSING` AND the
  send-verb CODEX task → `FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK`
  (invariants proven independently, not masked).
- R1 block (A–O): accented `gửi` `requested=true`; `gui` `requested=true`;
  exact prod goal `requested=true`; prod goal + clean zero-delivery plan →
  MISSING; prod goal + one delivery task → PASS + PAIR-owned instruction +
  stamped manifest; negation wins in both accented and unaccented forms
  (`khong/dung/không/đừng gui…`, `do not gui…`); bare "telegram"→false;
  "gui bao cao cho toi" (no mention)→false; `tao bao cao ve telegram`→false.

**Exact production-goal result:** `detectTelegramDeliveryIntent(prodGoal)`
→ `requested=true` at every boundary (canonicalize/preview/confirm/
runPlanning/runReplan — same detector, one canonical semantic authority).

**Regression:** focused incident file **99/99** (90 → 99; +9 R1 tests);
related suites unchanged (ops-telegram-delivery 3/3, llm-planner 16/16,
p8 49/49, live-ops 20/20); **full suite 2662 pass / 2 fail / 15 skipped** —
the 2 fails are the known env-only P5 probe tests, identical on base
`8e1d35b` (DSH/CODEX executables present on this machine). `tsc` clean,
`pnpm build` clean.

**Residual parser limitations:** other unaccented forms (`ban`/`dang`/`day`/
`chuyen`/`bao`) remain non-verbs — admitted only as future high-confidence
aliases with test-backed justification; analysis-vs-request phrasing
("nghiên cứu cách gui tin nhắn telegram hoạt động") is treated as a delivery
request when it parses affirmative in the bounded clause — bounded behavior,
no heuristic NLP added per mandate.

**Classification (superseded by R2 below):**
`PAIR_NEXT_POST_R7_INCIDENT_R8_R1_PENDING_INDEPENDENT_REAUDIT`

---

## Independent Audit Remediation R2 — all-caps `GUI` false-positive closure + report consistency

**Audit blocker:** `DELIVERY_VERB_RE` runs with the `i` flag, so the new
unaccented alias `gui` also matched `GUI` — the common technical acronym
(Graphical User Interface). `"phân tích GUI telegram"` could parse as
`requested=true` and mint/require governed external-delivery authority.
The safe direction for ambiguous language is NO SEND.

**False-positive mechanism:** the regex alternative `gui` matches `gui`,
`Gui`, and `GUI` case-insensitively; only the first two can reasonably be
unaccented `gửi`.

**Chosen implementation (narrowest deterministic rule, one canonical
parser):** inside `detectTelegramDeliveryIntent`'s verb loop, a match is
skipped when the matched source token is exactly all-caps `"GUI"`. The
`i` flag and all other verbs keep their existing case-insensitive
behavior; no global case or diacritic normalization — the original token
is inspected at match level. `guide`/`beguile`/`mygui`/`gui_component`
still cannot match (letter-boundary lookarounds include `_`).

**Why `gui` stays / `GUI` rejected:** lowercase and sentence-initial
capitalized forms are plausible unaccented Vietnamese; all-caps is
conventionally the acronym, not the verb — rejecting exactly that token
is the conservative fail-closed reading.

**New tests** (`pair-planner-dataflow-incident.test.ts`, block A–U):
`gui`/`Gui`→true; `GUI telegram`, `phân tích GUI telegram`, `thiết kế GUI
cho telegram bot`, `review GUI telegram`, `GUI của telegram`→false; exact
prod `gui` goal→true, zero-delivery→MISSING, one-delivery→PASS +
PAIR-owned instruction; negation (`khong`/`dung`/`do not`/`never gui`);
boundary/collision negatives (`guide`, `beguile`, `mygui`,
`gui_component`, `tao bao cao ve telegram`, bare `telegram`); hygiene:
send-verb trips, `review GUI telegram` instruction does NOT; canonical
delivery instruction parses non-affirmative for FILES and TEXT intents.

**Exact results:** `gui`→requested=true, `Gui`→true, `GUI`→false; prod
goal→true at every boundary (one detector, one authority).

**Regression:** focused incident file **106/106** (99 → 106; +7 R2
tests); **full suite 2669 pass / 2 fail / 15 skipped** — the 2 fails are
the known env-only P5 probe tests, identical on base `8e1d35b`. `tsc`
clean, `pnpm build` clean.

**CI status:** this repository has no GitHub Actions checks attached to
this HEAD — all counts above are locally executed Devin tests, not CI
evidence.

**Report consistency:** stale pre-R1 statements ("grammar does not include
unaccented gui", "unaccented intents are rejected as non-requests") are
now marked historical/pre-remediation above. Final consistent statement:
`gui` IS a high-confidence alias of `gửi`; all-caps `GUI` is NOT a
delivery verb; no global accent stripping; other unaccented aliases
remain unsupported unless individually justified and regression-tested.

**Residual parser limitations:** same bounded behavior as R1 — other
unaccented verb forms remain non-verbs; affirmative analysis-style
phrasing inside a clause still parses as a request (bounded, no NLP).

**Classification:** `PAIR_NEXT_POST_R7_INCIDENT_R8_R2_PENDING_INDEPENDENT_REAUDIT`
STOP. DO NOT MERGE. DO NOT START PHASE E.
