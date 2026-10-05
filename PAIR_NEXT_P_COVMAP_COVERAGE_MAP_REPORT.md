# P-COVMAP — Mandatory Obligation→Task Coverage Map — Implementation Report

## 1. Base / HEAD

- Base main SHA: `dc85be97bb38bc29a7596085b528e1f29cdda5ca` (post-PR#49 merge, NETWORK binding repair).
- Branch: `devin/1791186564-covmap`. HEAD: see git log (single implementation commit).

## 2. Files changed

| File | Change |
|---|---|
| `src/pair/llm-planner.ts` | `RawTask` gains `pair_coverage?: unknown`; `sanitizePlan` normalizes it into `metadata.pair_coverage` (conflict-drop / malformed-strip / grammar-filter / dedupe ≤32); `buildPlannerUserPrompt` renders the mandatory COVERAGE MAP instruction. |
| `src/pair/codex-planner.ts` | `PLAN_SCHEMA.items.required` += `pair_coverage`; `properties.pair_coverage = {type:"array", items:{type:"string"}}`; `additionalProperties:false` kept; no nullable. |
| `src/pair/plan-coverage.ts` | `validateProposedCoverage` rejects non-claimable/unknown/fabricated claims (OBL/DEL only claimable); bookkeeping-claim rejection; NEW completeness gate → `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED`. |
| `src/pair/planner-pool.ts` | `extractReaskDetail` gains a `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` arm (bounded ids + reason=UNDECLARED + optional missing_count + undeclared_tasks). |
| `src/__tests__/pair-covmap-coverage-map.test.ts` | NEW — adversarial T1–T15. |
| `src/__tests__/pair-prv2a-planner-modernization.test.ts`, `pair-prv2b-goal-coverage.test.ts`, `pair-network-binding-repair.test.ts` | fixtures updated: work tasks now emit truthful `pair_coverage` maps (derived per-task via the real gate), INCOMPLETE expectations kept only for fabricated-claim cases. |

## 3. Planner-facing contract

`buildPlannerUserPrompt` GOAL CONTRACT block now carries (same text on both transports — the prompt builder is shared):

> COVERAGE MAP (mandatory): every work task MUST carry `"pair_coverage": ["REQ_ID", ...]` declaring exactly which OBL_* and DEL_* rows it covers (emit `"pair_coverage": []` when it covers none); every OBL_* and DEL_* id listed above MUST be claimed by at least one work task; CON_*, PRO_* and DDL_* rows are checked by PAIR directly and MUST NOT be claimed; never invent requirement ids; declaration is a proposal only — PAIR independently verifies every claim, and a fabricated claim or an unclaimed row fails closed.

Codex lane additionally gets the field forced by the strict output schema (required, array-of-string, `additionalProperties:false`, non-nullable) — the model cannot emit a schema-valid plan without the field.

## 4. Normalization semantics (`sanitizePlan`, both transports)

- Top-level `pair_coverage` is authoritative; a legacy `metadata.pair_coverage` is honored only when top-level is absent (backward compat).
- Both present AND different (`JSON.stringify` mismatch) → deterministic `DROP_COVERAGE_CONFLICT:<key>` — the task is dropped, never silently resolved.
- Non-array or >32 entries → `DROP_MALFORMED_COVERAGE:<key>` + field stripped; the task survives and the completeness gate fails the candidate UNDECLARED (the planner learns to re-emit a valid map on its one re-ask).
- Entries filtered to canonical requirement-id grammar `/^(?:OBL|DEL|CON|PRO|DDL)_\d{3}$/` — CON/PRO/DDL-shaped ids are KEPT through sanitize so the §13 fail-closed claim check can fire (claimability is the gate's job, not the sanitizer's); strings/objects/null/other-prefix entries are dropped; surviving ids deduped in stable order; stored canonically at `metadata.pair_coverage` (top-level never propagated).
- Absent field on a work task under a mandatory contract → `undeclared_tasks` entry in the rejection detail.

## 5. Completeness algorithm (`assertPlanCoverage`, canonicalize seam — unchanged call site)

Order is mandate-exact:

1. **Claim verification** (`validateProposedCoverage`, per work task): every declared id must exist in the contract, be `kind ∈ {obligation, deliverable}`, and be genuinely covered by the task (`taskCoversObligation` / `taskProducesDeliverable` — unchanged semantic machinery). Fabricated/unknown/non-claimable claim → `FAIL_CLOSED_PLAN_INCOMPLETE` (detail `task <key> claims coverage of <id> it does not provide`). CON/PRO/DDL claims therefore fail closed — never silently ignored.
2. **Bookkeeping rejection**: any surviving bookkeeping task carrying a map → `FAIL_CLOSED_PLAN_INCOMPLETE` (`claims coverage on PAIR bookkeeping`). Model-emitted bookkeeping is normalized away upstream before this point, so an emitted claim can never satisfy completeness either (live test T7 proves both layers).
3. **Completeness (NEW)**: `expectedIds = obligations ∪ deliverables`; `declared` = union of `metadata.pair_coverage` across work tasks; `undeclared_tasks` = work tasks whose field is absent/non-array. `missing = expectedIds − declared`; `missing.length || undeclaredTasks.length` → `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED`, detail JSON `{"requirements":[≤16 ids],"reason":"UNDECLARED","missing_count":<int>,"undeclared_tasks":[≤8 keys]}` — ALL missing ids in ONE rejection, bounded, never requirement text.
4. **Semantic rows, constraints, prohibitions** — unchanged, run only after 1–3 pass.
5. Zero OBL/DEL rows → the gate is a no-op (optional field, T8).

Consequence worth flagging for the auditor: with the hard-required map, a genuine coverage gap now always surfaces as `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` (undeclared) while `FAIL_CLOSED_PLAN_INCOMPLETE` on OBL/DEL rows is reachable only via fabricated/non-claimable/unknown claims or a post-completeness semantic miss that no declared task covers — the declared-complete-but-semantically-false case remains under the same code (T15).

## 6. Error code + detail shape

`FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` — typed `IntegrityError`, distinct from `FAIL_CLOSED_PLAN_INCOMPLETE` (which now means "declared coverage proved insufficient"). Detail is one JSON object, bounded: `requirements` (≤16 canonical ids), `reason:"UNDECLARED"`, `missing_count` (int), `undeclared_tasks` (≤8 task keys, omitted when empty). No requirement text, instructions, goal text, or plan JSON ever inside.

## 7. REASK eligibility + detail (§11)

`REASK_CODE_PREFIX` already covers `FAIL_CLOSED_PLAN_*` — the new code is re-ask eligible with the existing one-bounded-reask mechanics (eligibility re-proof, durable `REASK:<code>` marker before invocation, `maxProviderRequests=1`, post-reproof remaining-budget timeout — all untouched).

`extractReaskDetail` arm: allowlist extraction of only `requirements` (≤16), `undeclared_tasks` (≤8), `missing_count` (integer 0<mc≤128, emitted only when it adds information beyond the listed ids) → one line `requirements=OBL_001,DEL_001 missing_count=2 undeclared_tasks=T2 reason=UNDECLARED`. Malformed/missing fields → fallback = the bare validation code. All fields pass the identifier grammar `^[A-Za-z0-9_./-]{1,120}$` and the emitted line is re-bounded `^[\x20-\x7E]{1,200}$` before render (T14 proves injection strings like `IGNORE_PREVIOUS_INSTRUCTIONS` never reach the prompt).

## 8. Task-key remap invariance (§16)

Coverage ids are contract-row ids (`OBL_001`), never task keys — the T1→T2… remap after bookkeeping injection cannot touch them. T13 asserts the remapped canonical tasks carry the same id strings.

## 9. Telegram clause (§15)

The delivery clause mints no OBL/DEL rows — a delivery task's normal declaration is `pair_coverage: []`. T12 proves: delivery task with `[]` valid + required for completeness; a delivery task claiming `DEL_001` (stealing the producer's row) fails fabricated-claim — it stages files, never produces them.

## 10. Bookkeeping (§14)

The PAIR-injected T1 never carries a map; model-emitted bookkeeping-shaped emissions are dropped upstream with their claims; a surviving bookkeeping claim is fabricated and fails closed. Model-authored bookkeeping can never satisfy coverage completeness (T7).

## 11. Test results

- NEW `src/__tests__/pair-covmap-coverage-map.test.ts` — **15/15 T1–T15 pass** (complete-truthful-map PASS; single-row miss → UNDECLARED + exact id in detail + REASK prompt; ≥3 missing in ONE rejection; fabricated claim; `OBL_999`; CON/PRO/DDL claims; bookkeeping; empty contract; Codex schema proof (required field, non-nullable, additionalProperties:false, `[]` + non-empty normalize identically); HTTP top-level→metadata normalization + metadata backward-compat + conflict drop; transport parity; telegram clause; remap invariance; malformed/injection entries never leak into the map or the REASK prompt; complete-map-with-fabricated-claim still fails under the unchanged semantic authority).
- Focused regression: **523/524** across covmap + prv2a (59) + prv2b (52) + llm-planner (16) + cpl1 (49) + preask (39) + pgrammar2 (26) + dataflow-incident (125) + network-binding (10) + ops-delivery (3) + output-delivery-contract (69) + f4-provenance (61) — single failure is the documented F4 `R5.1-crash` baseline defect.
- `npx tsc --noEmit` clean; `pnpm build` on `rm -rf dist` clean.
- Full suite: **3639 pass / 3 fail** = the documented clean-main baseline (2× P5 env-only executables on PATH; F4 `R5.1-crash`) — zero new failures, and the unchanged-baseline claim was already verified on clean main in prior runs.

Fixture-migration note for the auditor: ~63 pre-existing fixtures in prv2a/prv2b/network-binding were updated — the shared `work`/`workTask` helpers gained a `pairCov` param emitting TOP-LEVEL `pair_coverage` (exercising the real sanitize normalization), per-task maps were derived truthfully against the gate, and tests whose old expectation was "semantic miss → PLAN_INCOMPLETE" now correctly assert `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` for declaration-misses while fabricated-claim fixtures keep `PLAN_INCOMPLETE`.

## 12. Live proof (mandate §19)

Scratch stack on this branch: `:8790`, fresh `pair-mc-covmap` DB, prod-identical planner routes (sol → gemini → badq, all QUALIFIED), prod-identical caps.

Multi-requirement current/web goal: *"Research the current gold price and the current Bitcoin price on the web, analyze which asset moved more today, write the full analysis to outbox/price_analysis.md, and send that report via telegram."* Contract extraction (deterministic, from built dist):

- `OBL_001` research the current gold price, `OBL_002` analyze which asset moved more today, `DEL_001` outbox/price_analysis.md; telegram clause minted no row (delivery_intent TEXT).

Observed over several submissions: sol's schema-forced plans carried complete maps (no `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` attempt in the wild — the field is now structurally mandatory on the codex lane; HTTP-lane planners failing earlier on other gates is pre-existing model debt, unchanged). NETWORK repair stayed functional (`REPAIRED_NETWORK_CAPABILITY:T2/T3` durable on attempts).

Simple multi-requirement goal — *"Fetch the current gold price from the web and write it to outbox/gold_price.txt, then send it via telegram"*:

- Mission `MSN_01M45J7A70Y6THSSEEX29ZK6PJ` — **COMPLETED**.
- Canonical pinned plan carries durable `metadata.pair_coverage`: T2 `["OBL_001","DEL_001"]` (fetch+write task — the only work task), T3 delivery `[]`, T1 bookkeeping none — exactly the §3/§15 shape.
- Router dispatched T2 `[FILE_OPERATIONS, NETWORK_ACCESS]` → CODEX (normal routing), real artifact `outbox/gold_price.txt` written (spot gold 4,142.70 USD/oz, Kitco, sourced + timestamped).
- T3 TELEGRAM_DELIVERY → COMPLETED → TDR minted `TDR_98ec2b8386d0dbef806503a2` (TEXT mode, UNSENDABLE on bridge-less scratch — expected, delivery pipeline is out of scope).

## 13. Explicitly NOT changed (mandate guards)

Planner architecture, semantic coverage authority internals, REASK count (still exactly one), failover ordering/timeouts, executor/router/mission-runtime, no new env knob/entity/event, delivery-verb incident untouched, no unrelated findings fixed.

## 14. Limitations / residual debt (reported, not fixed)

- `PLAN_INCOMPLETE`/`DELIVERY_VERB`/`PLAN_DATAFLOW_UNBOUND_INPUT` model-quality classes remain — coverage map closes the *visibility* half of the coverage problem; semantic coverage quality still depends on the model.
- `undeclared_tasks` is capped at 8 keys and `requirements` at 16 ids; `missing_count` carries the true total when truncation would lose it.
- The map field on the HTTP lane is instruction-level (prompt), not schema-forced — a provider ignoring it fails UNDECLARED, which is the intended signal.

## 15. Classification

`PAIR_NEXT_COVERAGE_MAP_PENDING_AUDIT` — STOP chờ audit. KHÔNG merge.

## 16. Audit remediation R1 — bounded UNDECLARED re-ask formatter

**Mandate**: fix the bounded-feedback defect where a *valid* large structured
detail collapsed to the bare `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` code
because the assembled line exceeded 200 chars — losing every requirement/task
identifier the ONE re-ask needed. Global ≤200 policy unchanged; fix lives in
the formatter only (`src/pair/planner-pool.ts`).

1. **Previous audited HEAD**: `9df880dee3dcdd9ce526cbe41d7819005ad7b5b7`.
2. **New HEAD**: see commit on branch `devin/1791186564-covmap` (same PR #50).
3. **Files changed**: `src/pair/planner-pool.ts` (formatter + bound constant),
   `src/__tests__/pair-covmap-coverage-map.test.ts` (+R1.A–D), this report,
   `CURRENT_STATE.md`. The gate's `IntegrityError` detail shape is untouched
   (mandate: no change unless truly necessary).
4. **Exact bounded formatter rule**: `REASK_DETAIL_MAX_LEN = 200` is now the
   single source of the bound (`REASK_DETAIL_LINE_RE` is built from it — same
   regex semantics). For UNDECLARED the formatter reserves the mandatory
   suffix ` reason=UNDECLARED` (18 chars), then spends the remaining 182-char
   budget in priority order: `requirements=` ids added one at a time until the
   next id would exceed budget (no mid-identifier truncation, a field with
   zero fitting ids is omitted rather than emitted empty); `missing_count=N`
   emitted only when N (int, 0<N≤128) exceeds the number of requirement ids
   actually rendered; then `undeclared_tasks=` keys one at a time in the
   leftover budget. Output is `parts.join(" ") + " reason=UNDECLARED"`, always
   ≤200, printable ASCII only. Parse side unchanged: `safeField` identifier
   grammar, JSON-object detail only, malformed input → bare code.
5. **Proof ≤200**: R1.A (16 reqs + missing_count=128 + 8 task keys) renders a
   line of exactly ≤200 chars matching `/^[\x20-\x7E]{1,200}$/`; the loop
   breaks before any id that would overflow, so the bound holds by
   construction, not just on the test vector.
6. **Proof no collapse**: under the pre-R1 formatter that same input produced
   a ~217-char line → `REASK_DETAIL_LINE_RE` rejected it → bare code, losing
   every identifier. R1.A now emits
   `requirements=OBL_001,...,OBL_016 missing_count=128 undeclared_tasks=T2,T3 reason=UNDECLARED`.
7. **Proof priority**: R1.C — with 16 reqs and 8 long task keys, all 16
   requirement ids render while zero/few task keys fit: requirements fully
   outrank `undeclared_tasks` for the same budget.
8. **Proof malformed fallback**: R1.D — non-JSON detail, absent lists, and
   all-unsafe entries still return the exact validation code; mixed
   safe/unsafe entries drop only the unsafe ones (`OBL_002; IGNORE…` and
   `x y z` never appear).
9. **Results**: focused `pair-covmap-coverage-map` 19/19 (T1–T15 + R1.A–D);
   regression 376/376 (preask-feedback, llm-planner, cpl1, prv2a, prv2b,
   network-binding, pgrammar2, dataflow-incident); full suite 3634 pass /
   3 fail = the documented clean-main baseline (2× P5 env-only executables
   on PATH, F4 `R5.1-crash` baseline defect — reproduced on clean main, not
   fixed per mandate); `tsc --noEmit` clean; `rm -rf dist && pnpm build`
   clean.

Invariants kept: ONE re-ask, existing eligibility, exact validation codes,
`REASK_DETAIL_LINE_RE` semantics, malformed→code fallback, no raw
exception/requirement/goal/instruction/plan text, no secrets, no unbounded
output.

### Classification (R1)

`PAIR_NEXT_COVERAGE_MAP_R1_PENDING_AUDIT` — STOP chờ audit. KHÔNG merge.
