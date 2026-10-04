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

---

## R2 — deterministic network-requirement authority at the canonical seam

Audited base: `ee3ebdda4709c94eb0f1e3b046b16d99ede0e029` (PR #41, R1).
Audit finding closed: the current/external-data → `NETWORK_ACCESS`
requirement existed only in the Planner prompt — a model could emit
`["REASONING"]` for `analyze today's gold price` and route to a
non-network executor (DSH). Prompt compliance is not authority.

### Invariants

- Goal explicitly requires current/external data AND the canonical work
  plan has no legitimate `NETWORK_ACCESS` data-gathering task →
  `IntegrityError("FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED")` —
  thrown inside `makeServeCanonicalizer` after sanitize, i.e. BEFORE the
  plan can become the winning/pinned canonical plan (attempt settles
  FAILED/CANONICAL_VALIDATION_FAILED → planner failover proceeds).
- A task whose instruction explicitly requests live/web fetching but
  lacks `NETWORK_ACCESS` →
  `IntegrityError("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED")`
  (checked for every work task regardless of goal intent).
- The proposal is never rewritten: NETWORK_ACCESS is not auto-added and
  requested caps are never rewritten — the candidate fails typed.
- A `NETWORK_ACCESS` task counts toward the goal requirement ONLY when
  its instruction is itself data-gathering (fetch verb + retrievable
  object/recency/online marker) — the anti-dummy rule.

### Design — one canonical detector (llm-planner.ts)

Conservative keyword detector — four bounded regexes (EN + VI), no
unrelated semantic system reused:

- `CURRENCY_RE` — recency markers: today/tonight/current/latest/newest/
  live/real-time/up-to-date/breaking/right now; hôm nay/hiện tại/hiện
  giờ/mới nhất/mới đây/gần đây/trực tiếp/bây giờ/lúc này/hiện nay.
- `ONLINE_RE` — explicit online markers: the web/internet/online/web
  search/google/bing/wikipedia; trên mạng/trên internet. Bare `web` and
  `website` deliberately absent (a "web app" is not a network request).
- `FETCH_VERB_RE` — retrieval verbs, word-bounded (`fetched`,
  `scraper`, `research` do NOT match): fetch/get/retrieve/search/
  look up/find/browse/scrape/check/gather/collect/query/pull/download;
  tìm/tra/lấy/tìm kiếm/tra cứu/kiểm tra/thu thập/xem tin.
- `DATA_OBJECT_RE` — retrievables: price/rate/news/weather/stock/
  market/headline/trend/update/information/data/report/score/result/
  quote/article/forex/exchange/forecast/outlook; giá/tin tức/thời
  tiết/thị trường/tỷ giá/dữ liệu/thông tin/báo cáo/tin/báo.

Three exported predicates:

- `goalRequiresCurrentExternalData(goal)` =
  `(currency AND (verb OR object OR online)) OR (online AND verb AND
  object)` — a recency marker alone does not fire, nor does "price"
  alone. `"analyze gold price"` → false; `"analyze today's gold
  price"` → true; `"build a web scraper"`/`"build a website
  dashboard"`/`"review the search results in results.txt"` → false.
- `taskRequiresNetworkAccess(instruction)` =
  `verb AND (currency OR online)` — "analyze the fetched data" → false.
- `instructionIsDataGathering(instruction)` =
  `verb AND (object OR online OR currency)` — "create report.txt" /
  "think about the market" → false.

### Enforcement point

`serve-planner.ts` `makeServeCanonicalizer`, after `sanitizePlan` and
before key-remap/prepend — the same canonical seam where the R1.A
reserved-capability throw lives. IntegrityError propagates exactly like
every other canonicalize rejection: failover-eligible, never pin-able.

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **41/41 PASS** (33 R1 + 8 R2) |
| Regression battery (llm-planner, CPL-1, CNI-1, dataflow-incident, ops-telegram, F3×4, p4/p7/p8/p13, F4, F5) | **554/554 PASS** (15 files) |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| Full suite | **3427 pass / 2 failed** — same 2 env-only P5 fails as baseline (stock probes expect missing DSH/CODEX executables) |
| `pnpm audit` | 0 high (6 moderate — unchanged baseline, no new deps) |

### Required adversarial proofs delivered

R2-det detector matrix (currency/online gate, `price`-alone negative,
VI phrases, task-level + legitimacy shapes) · R2-N1
`"analyze today's gold price"` + REASONING-only →
`FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED` · R2-N2 same goal +
`["NETWORK_ACCESS","REASONING"]` fetch task → canonicalize PASS ·
R2-N3 historical/offline goal unaffected · R2-N4 NETWORK on an
unrelated dummy task (`create report.txt`) does NOT satisfy the
requirement → typed reject · R2-N5 task instruction requesting live
fetch without NETWORK → `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`
· R2-N6 NETWORK task with non-gathering instruction also illegitimate ·
R2-N7 routing over the valid canonical plan: DSH
`MISSING_CAPABILITIES:NETWORK_ACCESS`, codex-like OFF
`MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS`, codex-like ON eligible and
selected over devin (higher priority → devin also wins when codex OFF
proves both lanes serve it).

### Residual limitations (unchanged)

- Boot-OFF→flip-ON Codex needs re-registration (fail-closed asymmetry).
- `PLAN_SCHEMA` still cannot emit declared edge fields.
- The detector is keyword-bounded by design: a goal needing current
  data phrased without any recency/online/retrieval marker (e.g.
  `"what is the gold price"`) is not flagged — mandate prescribes
  conservative over noisy.

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R2_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.

---

## R3 — detector precision: LOCAL_CURRENT_STATE vs CURRENT_EXTERNAL_INFORMATION

Audited base: `52b9b74561d1046877c85253b6d198a3ef6e36db` (PR #41, R2).
Two HIGH findings closed; scope kept to exactly those findings.

### R3.A — false-positive local-current goals (fixed)

Root cause: `current` sat in one flat recency list and broad output
nouns (`report`/`data`/`information`) sat in one flat object list — so
"Review the current code and write a report" classified as external-data.

Fix (same single detector, restructured into signal classes):

- Recency split: `STRONG_CURRENCY_RE` (today/latest/newest/live/
  real-time/up-to-date/breaking/right now; hôm nay/mới nhất/mới đây/
  gần đây/trực tiếp/bây giờ/lúc này) vs `GENERIC_CURRENT_RE`
  (current/currently; hiện tại/hiện giờ/hiện nay) — generic current is
  ambiguous local-or-external and weaker.
- New `LOCAL_SOURCE_RE` (repo/repository/branch/workspace/file/CSV/
  source code/codebase/code/project/commit/diff/module/directory/
  folder/log/local/disk/filesystem/monorepo; mã nguồn/thư mục/tệp/
  dự án/nhánh/cục bộ): an explicit local source WITHOUT an online
  marker suppresses the requirement entirely — local current state is
  never external-data authority.
- Generic current fires only with an explicit retrieval verb +
  retrievable/external object ("get the current gold price", "check
  current weather", "find current USD/VND rate") or research intent
  against an EXTERNAL subject ("analyze the current market") — never
  against a broad output noun.

### R3.B — false-negative research phrasing (fixed)

New `RESEARCH_RE` intent class (research/analyze/study/investigate/
survey/compare/review; nghiên cứu/phân tích/đánh giá/so sánh/khảo sát/
tổng hợp) joins `FETCH_VERB_RE` as retrieval intent, and new
`EXTERNAL_SUBJECT_RE` (models/versions/releases/APIs/products/prices/
news/weather/rates/exchange/forex/stocks/markets/crypto/bitcoin/eth/
gold/xau/ea/mql4/mql5/packages/listings/frameworks/tools/providers/
offerings/announcements/feeds/articles/headlines/trends/quotes/
forecasts/outlook/scores/libraries/sdks/plugins/services/competitors/
events; giá/tin tức/thời tiết/thị trường/tỷ giá/mô hình/phiên bản/tin/
báo) joins `DATA_OBJECT_RE` as the retrievable-subject class. Goal rule
is now: online-or-strong-recency requires (fetch OR research) AND
(external subject OR broad object); generic current requires fetch AND
subject, or research AND external subject. Task-level rule mirrors the
same semantic class; `instructionIsDataGathering` accepts research
intent too, so a recency-qualified research task is a legitimate
NETWORK gatherer.

### Adversarial proofs (all mandated cases)

NO-network: "Review the current code and write a report" · "Analyze the
current project data from local CSV" · "Summarize the current
repository state" · "Review the current branch and produce a report" ·
"Analyze the current data" (research + broad noun, no external subject)
· task-level "Analyze the current data" / "Review the current code".
NETWORK-required: "get the current gold price" · "check current
weather" · "find current USD/VND rate" · "analyze the current market" ·
"Research the latest GPT models" · "Research the latest OpenAI API
versions" · "Analyze the latest AI model releases" · "Nghiên cứu các
EA MQL5 mới nhất" · "Phân tích các model AI mới nhất" · "Nghiên cứu
API miễn phí mới nhất". Canonical: R3-N8 goal "Research the latest GPT
models" + REASONING-only → `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`,
same goal + legit research NETWORK task → PASS; R3-N9 task "Research
the latest GPT models and return findings." with REASONING →
`FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`. All R2 tests retained
unchanged and passing.

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **45/45 PASS** (41 + 4 R3) |
| Regression battery (16 files: llm-planner, CPL-1, CNI-1, dataflow-incident, ops-telegram, F3×4, p4/p7/p8/p13, F4, F5, F2-handoff) | **607/607 PASS** |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| Full suite | **3431 pass / 2 failed** — same 2 env-only P5 fails as baseline |
| `pnpm audit` | 0 high (unchanged, no new deps) |

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R3_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.

---

## R4 — goal↔task subject binding for the network requirement

Audited base: `4155af5f83958ab854ae61a15e103033968da84a` (PR #41, R3).
Finding closed: the goal-level gate accepted ANY legitimate
NETWORK_ACCESS gatherer — an unrelated real gatherer ("fetch the latest
gold price") could satisfy "Research the latest GPT models".

### Design — bounded lexical subject proof (no semantic classifier)

- `externalSubjectKeys(text)` — canonical subject lexemes present in a
  text: the detector's subject vocabulary singular-normalized
  ("models"→"model") plus a small alias map (btc→bitcoin, eth→ethereum,
  xau/xauusd→gold) and a VI→EN phrase map (mô hình→model, tin tức/tin/
  báo→news, giá→price, vàng→gold, thị trường→market, tỷ giá→rate,
  phiên bản→version, dữ liệu/thông tin/báo cáo→data/information/
  report) — a Vietnamese goal binds a Vietnamese task by SUBJECT, not
  literal wording.
- `instructionSatisfiesGoalSubject(instr, goal)` — true iff the task's
  subject keys overlap the goal's (one shared canonical lexeme is
  sufficient, same conservative family); vacuous when the goal yields
  no lexemes (plain data-gathering rule then applies).
- `makeServeCanonicalizer` legitimacy now requires all three:
  `NETWORK_ACCESS` cap AND `instructionIsDataGathering(instr)` AND
  `instructionSatisfiesGoalSubject(instr, goal)`. The task-level gate
  `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED` is unchanged.

### Adversarial proofs

- Goal "Research the latest GPT models" + T1 NETWORK "fetch the latest
  gold price" + T2 REASONING "analyze GPT models" →
  `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED` (T1 gathers but binds
  no goal subject).
- Same goal + T1 NETWORK "research the latest GPT models and return
  current findings" → PASS.
- VI: goal "Nghiên cứu các EA MQL5 mới nhất" + "lấy giá vàng hôm nay"
  → REJECT; + "nghiên cứu các EA MQL5 mới nhất" → PASS.
- Alias bindings proven: "latest BTC quote" binds "current bitcoin
  price"; "latest XAUUSD quote" binds "current gold price".

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **49/49 PASS** (45 + 4 R4) |
| Regression battery (16 files) | **607/607 PASS** |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| Full suite | **3435 pass / 2 failed** — same 2 env-only P5 fails as baseline |

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R4_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.

---

## R5 — subject identity anchors: class overlap is not identity binding

Audited base: `f6fb6d4cbeab3de8dd464330dacb82668f3c1019` (PR #41, R4).
Finding closed: generic class lexemes (model/api/version/price...) let
unrelated same-class subjects satisfy the obligation — "latest Claude
models" passed for a "latest GPT models" goal.

### Design — SUBJECT CLASS vs SUBJECT IDENTITY

- `subjectAnchors(text)` — two bounded sources, deterministic, no
  entity database:
  - canonical anchor lexemes lowercase-mentionable: gold, bitcoin,
    ethereum, silver, oil, eurusd, usdjpy, ea, mql4, mql5 (VI phrase
    map feeds these too: vàng→gold, EA/MQL5);
  - capitalized tokens (proper nouns / acronyms: GPT, OpenAI, Stripe,
    Claude, USD, VND, BTC, XAUUSD) minus `ANCHOR_STOP` = all detector
    vocabulary (class lexemes, verbs, recency words) + function words —
    so "The"/"Research"/"Latest" never anchor; pure-ASCII requirement
    keeps diacritic fragments ("Nghi" < "Nghiên") out.
  - SUBJECT_ALIAS applied (btc→bitcoin, xauusd→gold).
- `instructionSatisfiesGoalSubject`: goal has ≥1 anchor → the NETWORK
  task must share ≥1 anchor (generic class overlap insufficient);
  goal has no anchor → R4 class-overlap rule preserved (goals like
  "check current weather" unaffected).
- No other seam touched: task-level gate, Router, CNI-1, bookkeeping,
  budget, Telegram/dataflow, failover unchanged.

### Adversarial proofs

- "Research the latest GPT models" + NETWORK "Research the latest
  Claude models" → `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`;
  + "Research the latest GPT models" → PASS.
- "Research the latest OpenAI API versions" + NETWORK "Research the
  latest Stripe API versions" → REJECT; + "Research current OpenAI
  API versions" → PASS.
- Retained: BTC↔bitcoin, XAUUSD↔gold, VI EA/MQL5 binding, gold-vs-GPT
  rejection, all R1–R4 tests.

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **52/52 PASS** (49 + 3 R5) |
| Regression battery (16 files) | **607/607 PASS** |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| `pnpm audit` | 0 high (9 moderate/low, same as baseline) |
| Full suite | **3438 pass / 2 failed** — same 2 env-only P5 fails as baseline |

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R5_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.

---

## R6 — case-insensitive subject identity (casing is not a governance signal)

Audited base: `34b3731606fe2203da51f113d8f6c06eaa0bd7f1` (PR #41, R5).
Finding closed: R5 anchors came mostly from capitalized tokens, so
`gpt`/`openai`/`stripe`/`claude` lowercase didn't anchor — both
directions broken: wrong-subject bypass ("latest claude models" for a
lowercase "gpt" goal) and false fail-closed ("Research the latest GPT
models" vs lowercase "research the latest gpt models").

### Design — bounded context-anchor extraction

`subjectAnchors` now draws identity from THREE deterministic sources:
1. canonical anchor lexemes (unchanged);
2. capitalized proper/acronym tokens (unchanged);
3. **context anchors**: a non-vocabulary token within ±2 positions of
   a subject-class term names the external subject regardless of case
   ("gpt models", "openai api"). Still excluded: verbs, recency words,
   class lexemes, function words, output words, local-source
   vocabulary (added to ANCHOR_STOP), pure digits, tokens following
   "." (file-extension fragments like `md` in `report.md`), and
   non-ASCII fragments.

Casing now never creates/removes authority: `gpt ≡ GPT`,
`openai ≡ OpenAI`, aliases unchanged (BTC≡btc≡bitcoin, XAU≡XAUUSD≡gold).

### Adversarial proofs

- `research the latest gpt models` + NETWORK `research the latest
  claude models` → `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`;
  + `research the latest gpt models` → PASS.
- `Research the latest GPT models` + lowercase `research the latest
  gpt models` → PASS.
- `research the latest openai api versions` + `research latest stripe
  api versions` → REJECT; + `research current OpenAI API versions` →
  PASS.
- All R1–R5 tests retained unchanged (task-level gate, Router, CNI-1,
  bookkeeping, budget, Telegram/dataflow, failover untouched).

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **56/56 PASS** (52 + 4 R6) |
| Regression battery (16 files) | **607/607 PASS** |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| `pnpm audit` | 0 high (9 moderate/low, same as baseline) |
| Full suite | **3442 pass / 2 failed** — same 2 env-only P5 fails as baseline |

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R6_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.

---

## R7 — generic modifiers are not identity anchors

Audited base: `94980cdf5dd6aa04e9a8b0bceabe950839712e33` (PR #41, R6).
Finding closed: the ±2 context window treated every nearby non-stop
token as an anchor, so a shared modifier ("commercial", "public")
could falsely bind ("commercial claude models" ≈ "commercial gpt
models").

### Design — adjacent-modifier extraction

Context scan now takes only the SINGLE NEAREST candidate adjacent to
each subject-class term: scan outward (both directions, ≤2); stop
words, class terms, extension fragments and non-ASCII tokens
terminate the scan (noun-phrase boundary); pure digits are skipped so
a version tail still reaches the identity ("gpt 4 models" → gpt).
Generic descriptors two positions away are never extracted — no
adjective list needed. Binding rule, anchors lexemes, capitalized
extraction and case-insensitive behavior unchanged.

### Adversarial proofs

- `research the latest commercial gpt models` + NETWORK `research the
  latest commercial claude models` →
  `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`; + `research the
  latest commercial gpt models` → PASS.
- `research the latest public openai api versions` + `research the
  latest public stripe api versions` → REJECT; + `research current
  openai api versions` → PASS.
- Extraction: `commercial gpt models` → {gpt}; `public openai api
  versions` → {openai}; `gpt 4 models` → {gpt}.
- All R1–R6 tests retained (lowercase distinction, case-insensitive
  binding, OpenAI/Stripe, BTC/bitcoin, XAUUSD/gold, EA/MQL5,
  local-current suppression).

### Validation

| Check | Result |
|---|---|
| Focused `pair-prv2a-planner-modernization` | **59/59 PASS** (56 + 3 R7) |
| Regression battery (16 files) | **607/607 PASS** |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | PASS |
| `pnpm audit` | 0 high (9 moderate/low, same as baseline) |
| Full suite | **3445 pass / 2 failed** — same 2 env-only P5 fails as baseline |

Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R7_PENDING_AUDIT`

STOP — pending independent audit. DO NOT MERGE.
