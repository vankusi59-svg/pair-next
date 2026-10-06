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

---

## AUDIT R1 REMEDIATION (audited HEAD `1033019` → new HEAD pending push)

Four findings closed, same files, minimal scope.

### F1 — bare `không` over-classification (HIGH, fixed)
`PROHIBITION_RE` bare `không` now carries a bounded lookahead suppression: `không(?!\s*(?:quá|hơn|phải|có|được|nên|cần|đủ|đúng|sai|thấy|biết|khác|giống|cùng|ít|nhiều|xa|gần|cao|thấp|tốt|xấu|rõ|dễ|khó|lớn|nhỏ|chắc|hết|xong|muốn|tồn tại|hiện có|liên quan)(?=\s|$))` — descriptive negatives never trigger; `không gửi/xóa/dùng/…` still do. Verified: `ngân sách không quá $50` mints constraint `maxAmount=50` + zero prohibitions; `phân tích EA không có martingale` mints the obligation; all three natural VI bans mint correctly.

**Incidental root-cause fix**: JS `\b` is ASCII-only — `quá\b` never matches (á is non-word). All boundaries moved to `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])`/`(?=\s|$)` lookarounds — affects every diacritic-ending VI lexeme in the touched regexes.

### F2 — negation window could suppress a real act (HIGH, fixed)
`NEGATION_WINDOW_RE` tightened: `\s+`-only separators (punctuation always breaks scope), ≤2 tokens (was ≤3), and clause connectives `then|but|however|nevertheless|sau|nhưng|rồi|và|and|or|hoặc` are per-token breakers. `do not analyze first, then use martingale` → VIOLATION (was suppressed); `avoid using` / `will not use` / `không sử dụng` still suppress. Ambiguity resolves to live match — suppression can never fail-open.

### F3 — prefix false-positives in action regexes (fixed)
Every class regex rewritten to explicit inflection lists + hard `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])` boundaries: `uses?|using|used|utili[sz]e[ds]?|…` — `user`/`useful`/`executive`/`orange`/`tradition`/`posture` never mint an action; `use/using/used/includes/including` still match. `đăng(?!\s+(?:nhập|ký))` keeps `đăng nhập/ký` out of the send class (access claims it via longest-match tie-break anyway).

### F4 — action classes from the ACTION PHRASE, not the object (HIGH, fixed)
`prohibitionPayload` now: masks filename-shaped tokens (`write.txt`) before the action scan → takes the FIRST class hit → extends only across connector words (`or|and|và|hoặc`) — `do not delete write.txt` → `[delete]` with terms `[write]`; `do not access download folder` → `[access]` (download stays object); `do not delete or modify report.md` → `[delete, modify]` deterministically. Terms strip only admitted action spans — object identity survives even when the object is an action-looking token.

### Tests added (14)
F1.a–c (budget/obligation survival + natural bans), F2.a–d (breaker fail-closed + genuine compliance suppressed), F3.a–c (prefix FP matrix + explicit inflections still firing), F4.a–d (object-identity + multi-action deterministic).

### Validation
- Focused suite: **29/29 PASS** (15 original + 14 R1)
- Regression (PRV2-B + covmap + dataflow + preask + grammar2 + netreq): **276/276**
- Full suite: **3689 pass / 3 fail / 24 skipped** — same 3 baseline fails (F4 R5.1-crash, P5 DSH env, P5 CODEX env); skip-count drift is env probes
- `tsc --noEmit` clean; `rm -rf dist && npm run build` clean

### Residual limitations (updated)
- `không` + suppress-word means "không thực hiện"-style bans through intervening adverbs aren't suppressed — they trigger (safe direction).
- Negation window ≤2 whitespace-separated tokens; a distant negation (`avoid, as noted, using`) still counts as live act — fail-closed direction.
- `ordering` still reads trade (`orders?|ordered|ordering`); bounded.
- Overlapping same-start hits resolve longest-first (`đăng nhập` → access, not send).
