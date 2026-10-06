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

---

## R1.1 ADDENDUM — E2E-found `đừng` dead trigger (fixed in-place)

Post-R1 end-to-end testing on a scratch stack (port 8790, real codex-sol planner, fresh DB, prod untouched) proved the gate works on BOTH `1033019` and `6c952da`, and surfaced one surviving hole in the same regex this PR owns:

- **`đừng` was dead code** — JS `\b` is ASCII-only; leading `đ` is non-word so `\b(?:…|đừng|…)` never matched a `đừng`-initial trigger (e.g. `Đừng gửi telegram` → zero prohibitions minted). Fix: `PROHIBITION_RE` leading `\b` → `(?<![\p{L}\p{N}])` — the same unicode-boundary move R1 applied to the action classes. Now `đừng gửi/xóa` mint `[send|delete]` and enforce (F1.d test, 30/30 focused).

### E2E evidence (testing agent, scratch stack)
| Case | `1033019` | `6c952da` |
|---|---|---|
| VI conditional-prohibition mql5 goal (the production incident shape) | ✅ plan minted via real planner → mission **COMPLETED**, real `outbox/mql5_ea5.txt` + TELEGRAM_DELIVERY_MINTED | ✅ identical — COMPLETED |
| `do not delete report.md` + check/write plan | ✅ minted + committed (runtime later aborts on `DEPENDENCY_RESOLUTION` — planner declared the file consumed; separate upstream quirk, gate unaffected) | ✅ identical |
| NEGATIVE: ban + request telegram | ✅ 409 `FAIL_CLOSED_PLANNER_EXHAUSTED`, no mission | ✅ identical |
| Canonicalize seam, 8 adversarial cases | ✅ 8/8 | ✅ 8/8 |

### Residual advisories (documented, not fixed — out of mandate)
- **Existence-check runtime abort**: planner declares `report.md` a consumed input of "check whether it exists" → `DEPENDENCY_FAILURE`/`PLAN_DATAFLOW_UNBOUND` abort post-commit. Gate minted correctly; upstream planner-emission quirk.
---

## AUDIT R2 REMEDIATION (audited HEAD `dd5253d`)

Five findings closed on the same PR/scope. Audited base `dd5253d`; new HEAD recorded below.

### F1 (HIGH) — bounded local association action↔object

**Before**: one non-negated action-class hit + one term hit anywhere in the task instruction → violation — whole-task co-occurrence. `check report.md, then delete temp.txt` failed the same as the real act.

**After** (`plan-coverage.ts`): `instructionSegments()` splits each instruction on punctuation `[ ,;.!?;:—–… ]` and on clause-shifting connectives ` then | but | however | nevertheless | sau đó | sau khi | rồi | nhưng ` (whitespace-gated). `and | và | or | hoặc` are deliberately NOT breakers — "use grid and martingale" is a single object list and splitting there would fail open. `termMatchSpans()` finds every boundary-match span of each prohibited term; `taskShowsProhibitedAct` requires a non-negated action hit AND a term hit inside the SAME segment (no terms → the class is banned outright anywhere). Result: `check report.md, then delete temp.txt` PASSes, `check temp.txt, then delete report.md` FAILs; `review martingale, then use fixed sizing` PASSes, `use martingale` anywhere still FAILs.

### F2 (HIGH) — bare `không` requires a forbidden-action lead

**Before**: bare `không` carried a bounded suppress-word lookahead; `phân tích EA không martingale` still minted a prohibition (descriptive shorthand swallowed the obligation).

**After** (`goal-contract.ts`): the suppress-word list is DELETED. Bare `không` is a trigger only when immediately followed by a known forbidden-action form — `không(?=\s+(?:ALL_ACTION_FORMS)(?![\p{L}\p{N}]))`, the same 12-class vocabulary enforcement uses (`ALL_ACTION_FORMS` is now exported from a single `ACTION_FORMS` table — one alternation source for both sides). `không gửi/xóa/dùng` mint as before; `không có martingale`, `không martingale`, `không quá $50` mint nothing (constraint/obligation survive). NEW mid-clause expansion: when a `PROHIBITION_RE` match starts inside a clause with text before it, the clause is split at the match — `phân tích EA không dùng martingale` mints obligation `phân tích EA` PLUS prohibition `[use]+{martingale}`.

### F3 (HIGH) — multi-action `and/và` survived clause splitting

**Before**: `splitClauses` cut on ` và | and ` anywhere → `do not delete and modify report.md` split at `and`, leaving `modify report.md` a separate non-prohibition clause — `modify` silently unbanned.

**After**: `và|and` removed from the clause separator; they now split ONLY inside `splitConnectiveGuarded` — a guarded split that requires ALL THREE: `PROHIBITION_RE` matches the text before the connective, that text ENDS in an action form (`ACTION_TAIL_RE`), and the text after LEADS with an action form (`ACTION_LEAD_RE`). `delete and modify` survives intact (both classes minted); `analyze the market and write report.md` still splits (before-side ends in `market`, not an action). Deterministic, no parser. VI `hoặc`/`và` connectors already joined action classes inside `prohibitionPayload`'s connector-walk — now `and`/`và` reach it.

### F4 (MEDIUM) — unicode-safe conditional markers

`CONDITIONAL_MARKER_RE` replaced both `\b` edges with `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])` — `miễn là backup tồn tại, đừng gửi file` now mints `[send]+{file}` (đ-initial `miễn`/`đừng` boundary works); `minếu`/`khinh` never match a marker mid-token. Marker set: `trừ khi | miễn là | trong trường hợp | in case | as long as | so long as | provided that | provided | unless | if | when | nếu | khi(?! nào) | lúc(?! nào)`. No other VI trigger/marker regex retains `\b` (PROHIBITION_RE lead was fixed in R1.1; all class boundaries already unicode).

### F5 (MEDIUM) — `order/ordering` ≠ trade

`trade` class dropped `orders?|ordered|ordering` and gained the contextual `plac(?:e|es|ed|ing)\s+(?:(?:an?|the|some|few|\d+)\s+)?orders?`. `order results by score` / `sort and order the candidates` PASS under `do not trade`; `place an order`, `trade/buy/sell XAUUSD` still FAIL.

### Validation
- Focused suite: **43/43 PASS** (30 prior + 13 R2 tests covering every mandated case table)
- Regression (PRV2-B + P-COVMAP + dataflow-incident + preask + network-req): **254/254**
- Full suite: **3703 pass / 3 fail / 24 skipped** — byte-identical baseline (F4 R5.1-crash, P5 DSH env, P5 CODEX env); skip drift is env probes
- `tsc --noEmit` clean; `rm -rf dist && npm run build` clean

### Residual limitations (updated)
- Segment splitting is punctuation + a bounded connective list — an action→object pair spanning an UNLISTED breaker (e.g. `however that may be,` vs. exotic adverbs) reads as one segment; direction is fail-closed on the ban side and PASS-open on the legit side only when punctuation separates them.
- `and/or` between an action and its objects stays one segment BY DESIGN (object-list scope) — `use grid and martingale` still bans.
- Negation suppression still ≤2 whitespace tokens before the action hit.
- Bare `không` + unknown verb (outside the 12 classes) mints NO prohibition — e.g. `không đuổi` — documented bounded miss vs. the over-extraction it replaced.
- Condition evaluation (`if/unless/nếu`) is STILL only a cutoff — a true conditional ban always bans; full conditional semantics remain a separate work item.
