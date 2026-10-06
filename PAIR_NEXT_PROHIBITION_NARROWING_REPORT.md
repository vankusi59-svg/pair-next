# PAIR_NEXT_PROHIBITION_NARROWING — Report

**Mandate**: MINIMAL PROHIBITION NARROWING — vá hẹp cơ chế prohibition của Planner để giảm false-positive, giữ nguyên Goal Contract + pair_coverage + assertPlanCoverage. Không redesign, không classifier/NLU.

- **Base SHA**: `9838789c6fdde5d2979aba65b9c12994a3534bc0` (main HEAD at branch cut)
- **Branch**: `devin/prohibition-narrowing`
- **New HEAD**: see `git rev-parse HEAD` on the branch (single commit over base)

## Files changed

| File | Change |
|---|---|
| `src/pair/goal-contract.ts` | `GoalRequirement.actionClass?: string[]`; `PROHIBITED_VERB_STRIP` (dead code) → `PROHIBITION_ACTION_CLASSES` (exported, bounded vocabulary, real role); new `CONDITIONAL_MARKER_RE` + `TAIL_CONNECTOR_RE` + `prohibitionHead()`; `prohibitionTerms()` → `prohibitionPayload()`; `PROHIBITION_RE` gains bare `không`; `PROHIBITION_STOPWORDS` widened (conditional/connective vocabulary + file extensions + `phải/cần/có`) |
| `src/pair/plan-coverage.ts` | prohibition loop rewritten: `instr.includes(term)` → `termHit()` (word-boundary regex) + `taskShowsAction()` (action-class verb present AND not inside a bounded negation window `NEGATION_WINDOW_RE`); violation iff actionClass shown AND (term hit OR terms empty); term-only fallback boundary-matched; `TELEGRAM_DELIVERY` capability check unchanged |
| `src/__tests__/pair-prv2b-prohibition-narrowing.test.ts` | NEW — 15 adversarial tests (4 extraction A1–A4, 11 enforcement B1–B11) |

## Exact semantic change

**Before**: `PROHIBITION_RE` marks a clause → `prohibitionTerms()` mints every ≥3-char word minus ~50 stopwords (cap 8) → enforcement = `instr.includes(term)` substring → violation.

**After**: the clause is first cut at a conditional opener (`if|unless|when|nếu|khi(?! nào)|trừ khi|in case|as long as|provided|miễn là|trong trường hợp`) — the head carries the ban; a marker-opening clause looks for the prohibition after the condition ("nếu X thì đừng Y"); an embedded marker never splits. From the head, `prohibitionPayload()` returns `{terms, actionClass?}`: bounded action classes (delete/use/send/access/execute/modify/fabricate/trade/copy/install/download/write + VI equivalents) matched against the head AND stripped from the term stream. Enforcement:

- `classes.size > 0` → violation iff `taskShowsAction(instr, classes)` (non-negated class match; `avoid|without|không|đừng|tránh|instead of|...` + ≤3 tokens before the verb suppresses) AND (`terms` boundary-hit OR `terms` empty → whole-action ban).
- `classes` empty → term-only enforcement: same boundary match (fail-closed for unparseable shapes).
- `TELEGRAM_DELIVERY` capability check byte-identical (banned telegram term + capability claim → violation regardless of wording).

Digest: `actionClass` rides `canonicalizeForDigest` → contractDigest changes vs prior goals that mint prohibitions (new evidence format — intended).

## Adversarial tests (15)

- **A1** `không gửi Telegram nếu report chưa hoàn thành` → terms `[telegram]`, actionClass `[send]` — tail (`nếu report chưa hoàn thành`) never becomes terms.
- **A2** six conditional forms EN/VI (`if/unless/when/nếu/khi/trừ khi`) → all cut the tail, terms `[file]`.
- **A3** `do not delete report.md` → actionClass `[delete]`, terms `[report]` (extension never a term).
- **A4** `cấm martingale` → terms-only ban (no action class).
- **B1** check-exists of `report.md` (with proper producer binding) → PASS.
- **B2** real `delete`/`xóa` of `report.md` → `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`.
- **B3** `use`/`including` martingale → VIOLATION (existing test-G semantics preserved).
- **B4** research/analyze/review martingale (`không sử dụng`, `without using`, `review whether`) → PASS ×3.
- **B5** `capacity`/`concatenate` never match `cap`/`cat`; genuine `access cap.json` still VIOLATION.
- **B6** `martingale or grid` → both objects caught; clean plan still PASS.
- **B7** `cấm giao dịch` (no object) → `trade` alone violates.
- **B8** production incident goal `không được tự bịa dữ liệu nếu không truy cập hoặc xác minh được trên MQL5` → actionClass `[fabricate]`; the legitimate MQL5-access plan PASSes; a task actually `bịa dữ liệu` FAILs.
- **B9** `avoid using martingale` (task declares compliance) → PASS — negation suppression is for TASK text only; prohibition head still mints the ban.
- **B10** banned telegram term + `TELEGRAM_DELIVERY` capability → VIOLATION unchanged.
- **B11** term-only prohibition (`cấm martingale`) still fails on whole-token mention.

## Validation results

- Focused: `pair-prv2b-prohibition-narrowing` **15/15 PASS**
- PRV2-B + coverage/dataflow/reask/grammar/network regression: **276/276 PASS** (67 + 209)
- Full suite: **3684 pass / 3 fail / 15 skipped** — the 3 fails are byte-identical to the pre-change baseline (`F4 R5.1-crash` spy-then-finally bug, `P5 DSH`/`P5 CODEX` probe env) — untouched, per mandate.
- `tsc --noEmit` clean; `npm run build` from clean `dist/` succeeds.

## Residual limitations

- Bare `không` (new trigger) makes descriptive Vietnamese negatives (`kết quả không đúng`) mint term-only prohibitions — same crude class as `cấm X`; bounded, documented.
- Negation suppression is bounded-window (≤3 tokens) — a task like `delete X without warning` still shows DELETE (correct); `don't forget to delete` is suppressed (acceptable edge).
- Term-only prohibitions (no identifiable action verb) keep the old gating on object mention — the mandate's narrowing applies where an action is identifiable.
- `actionClass` vocabulary is bounded (12 classes EN/VI) — an exotic banned verb (`do not extrapolate`) falls back to term-only; additive extension point, not semantic NLP.
- Multi-word prohibited objects (`bịa dữ liệu`) rely on per-token `liệu` boundary match — a task `tạo dữ liệu` shows FABRICATE? No — `tạo` is not fabricate → passes; `bịa dữ liệu` violates via `bịa`+`liệu` (verified B8).
