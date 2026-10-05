# PAIR Next — Structured Network Requirement (R1) — implementation report

Branch: `devin/1791196681-netreq-struct` — base `d635d62` (post-PR#50 merge).
Previous HEAD: `d635d62` → New HEAD: *(this commit)*.
Status: **PENDING INDEPENDENT AUDIT** — do not merge.

## 1. Root cause (incident recap)

The MQL5 research goal repeatedly died `TASK_NETWORK_CAPABILITY_REQUIRED` /
`PLANNER_EXHAUSTED` because NETWORK authority was derived by **legacy
vocabulary detectors** (`goalRequiresCurrentExternalData` /
`taskRequiresNetworkAccess`): Vietnamese goal phrasing ("gần nhất", "đang nổi
bật", "truy cập") did not match the English-weighted word lists, and the
NETWORK repair (PR #49) refused to elevate without a goal-side vocabulary
match. Each language/wording needed its own dictionary patch — the exact
failure mode this mandate bans.

## 2. Architecture

**Before:** goal text → planner emits free-text tasks → deterministic
*word-list* detectors decide "needs network" → gate.

**After:**

```
Natural-language goal
  → Planner (model, NLU incl. multilingual) emits
    task.network_requirement {source_kind, access_intent, freshness,
    source_locator?}  — REQUIRED field in Codex PLAN_SCHEMA
  → sanitizePlan normalizes top-level field → metadata.network_requirement
    (shape-validated, fail-closed; conflict/malformed → typed drop warnings)
  → canonicalPlanSemanticDigest binds metadata.network_requirement into
    plan identity (mandate blocker closed)
  → taskNetworkAuthority(): PURE ENUM DERIVATION
       EXTERNAL_SITE|EXTERNAL_API|REMOTE_REPOSITORY
         + READ|RESEARCH|FETCH  → NETWORK_ACCESS required
       LOCAL                    → not required
       UNKNOWN                  → never self-elevates
       internal contradictions (LOCAL+external locator,
         locator-without-source) → FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID
  → existing NETWORK gates (FAIL_CLOSED_PLAN/TASK_NETWORK_CAPABILITY_REQUIRED)
    UNCHANGED semantics
  → executor
```

Planner only understands and normalizes meaning; deterministic code decides
authority. Planner cannot self-grant: `required_capabilities` is still
independently checked — a forged consistent field cannot mint a capability
(test J3).

### Precedence (explicit, tested)

- **Structured present → structured verdict wins both directions.** Legacy
  detectors do not run for that task.
- **Structured absent → legacy fallback** (unchanged behavior, test H).
- Legacy may never downgrade a valid external declaration to LOCAL.

## 3. Fail-closed behavior

- Malformed shape (missing enum field, wrong type, bad locator class) →
  normalize drops field + `DROP_MALFORMED_NETWORK_REQ:<key>`; top-level vs
  metadata conflict → `DROP_NETWORK_REQ_CONFLICT:<key>`.
- `source_kind=LOCAL + source_locator=https://mql5.com` →
  `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID` (`LOCAL_WITH_EXTERNAL_LOCATOR`)
  — mandate's exact example, rejected on the canonical path (test F2).
- UNKNOWN / malformed → zero elevation, no silent picks.
- Gate codes unchanged; REASK auto-eligible via `FAIL_CLOSED_PLAN_` prefix,
  detail `{"task","reason"}` parsed into bounded `task=… reason=…` line.

## 4. Auditor deviations (live-evidence driven, documented honestly)

Two instruction-vs-declaration vocabulary cross-checks were implemented,
proven harmful on live sol emissions, and **removed**:

1. `REQUIRED_VS_INSTRUCTION` — rejected EXTERNAL+RESEARCH declarations whose
   instruction lacked fetch-vocabulary. Live sol plans died on every attempt:
   a consistent external declaration IS the semantic normalization; demanding
   corroborating word-lists rebuilt the brittleness this field replaces.
2. `NONREQUIRED_VS_INSTRUCTION` — rejected LOCAL declarations whose
   instruction was "fetch-shaped". Live finding: downstream tasks echo the
   goal's recency phrasing ("tổng hợp nghiên cứu 10 EA MT5 đang nổi bật")
   → detector over-fired on a *correct* LOCAL declaration, blocking every
   plan. A mis-declared LOCAL/UNKNOWN task simply lacks NETWORK_ACCESS — it
   fails visibly downstream, never gains unproven authority.

Remaining contradiction checks are **structural only** (internal to the
field), not vocabulary — consistent with "KHÔNG tiếp tục vá bằng vocabulary".

## 5. Files changed

| File | Change |
|------|--------|
| `src/pair/network-requirement.ts` | NEW — enums, `NetworkRequirement`, `parseNetworkRequirementShape`, `networkRequirementRequiresAccess`, `networkRequirementInternalContradiction`, `taskNetworkAuthority`, `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID` |
| `src/pair/llm-planner.ts` | `RawTask.network_requirement`; sanitize normalize block (conflict/malformed drops); SYSTEM_PROMPT field contract; `repairNetworkCapabilityBinding` rewired — structured-derived `anyDerivedRequired`, per-task `taskNetworkAuthority`, legacy path only when field absent |
| `src/pair/codex-planner.ts` | `PLAN_SCHEMA`: required `network_requirement` object (enum subfields, `source_locator` string\|null), added to task `required` |
| `src/pair/serve-planner.ts` | canonicalizer gate rewrite — contradiction check first (typed INVALID), `anyDerivedRequired` plan-level, `auth.present ? auth.required : legacy detector` per task; task gate unchanged |
| `src/pair/plan-feasibility.ts` | `canonicalPlanSemanticDigest` whitelists `metadata.network_requirement` → bound into plan identity |
| `src/pair/planner-pool.ts` | `extractReaskDetail` arm for INVALID → `task=… reason=…` bounded |
| `src/__tests__/pair-network-requirement.test.ts` | NEW — 16 tests A–J |

## 6. Validation

- Focused (network-requirement + llm-planner + network-binding + covmap +
  preask + pgrammar2 + dataflow + prv2b + route-cap + cni1 + cpl1):
  **410/410 PASS**.
- Full suite: **3650 pass / 3 fail** — identical 3 baseline failures
  (2× P5 env-only dsh/codex-on-PATH, F4 `R5.1-crash`), unchanged by R1.
- `tsc --noEmit` clean; `pnpm build` clean from `rm -rf dist`.

## 7. Live proof (scratch stack :8790, prod-routed env)

### Positive — exact MQL5 goal (verbatim, unchanged wording)

Submitted 3×. **Every sol emission (6 consecutive plans) carried a valid
structured requirement**: T1 `{EXTERNAL_SITE, FETCH|RESEARCH, REQUIRED,
locator:"https://www.mql5.com[/en/market/mt5/expert]"}`; T2 `{LOCAL, READ,
NOT_REQUIRED, locator:<file>}`; T3 `{LOCAL, READ, NOT_REQUIRED,
locator:"outbox/mql5_report.txt"}`. Post-fix the network gate is **fully
green** — no `FAIL_CLOSED_PLAN_*NETWORK*` code in any subsequent attempt
(durable `planner_attempt` rows + raw `planner-cli/*/final.txt`).

The mission still cannot mint: an **orthogonal, out-of-scope bug** in PRV2-B
`prohibitionTerms` (goal-contract.ts L196-204) bans every ≥3-char token of
the prohibition clause — the goal's own "Không được tự bịa dữ liệu nếu không
truy cập hoặc xác minh được trên MQL5" mints banned terms
`["truy","cập","hoặc","liệu","nếu","xác","minh","bịa"]`, so the instruction
"Truy cập MQL5.com" the goal REQUIRES is itself a violation
(`FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION` on every attempt). Patching its
stopwords would be the banned vocabulary-patch pattern — it needs its own
mandate (same structured-contract shape as this field). Also noted: sol REASK
landed `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT` once (artifact-name drift,
known class). badq stayed 429 quota-limited throughout (provider-side).

### Negative — LOCAL goal (control)

Goal: "Tóm tắt ghi chú sau … Lưu vào outbox/pair_note.txt." → mission
`MSN_01M45WGFESCE0CFSHPD6K1ZWYB` **CREATED**. Durable plan: sol emitted
`{LOCAL, NONE, NOT_REQUIRED}` → derived not-required → task caps
`[FILE_OPERATIONS, REASONING]` — **zero NETWORK_ACCESS anywhere, zero repair
markers** (attempt warnings `[]`). Structured authority granted exactly what
was proven, nothing more.

## 8. Remaining risks / tech debt

- The prohibition-term extractor (Bug A) makes THIS exact goal unplannable
  today — reported for its own mandate.
- Repair now elevates only on consistent structured declarations or the
  legacy goal-side gate; instruction-vocabulary corroboration removed
  (see §4) — a planner that mis-declares LOCAL on a genuinely remote task
  yields a visible downstream task failure, not a hidden elevation.
- `instruction`/`instructionIsNetworkShaped` remain in `taskNetworkAuthority`'s
  signature for caller uniformity (absent-field fallback path); unused in
  verdicts by design.
