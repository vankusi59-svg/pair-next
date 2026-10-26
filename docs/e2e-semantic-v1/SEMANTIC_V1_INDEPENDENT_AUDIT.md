# Semantic & Context-Aware Planning V1 — Independent Audit (K′)

**Range audited:** `46b05bf…b2e85b5` (first pass), remediated HEAD `2f88931`.
**Method:** independent adversarial review of the full diff — three scopes:
semantic correctness, canonical authority/security, production integration.
**Outcome:** first pass **FIX-THEN-SHIP** (3 HIGH + 3 MED + 4 LOW findings,
each with a verified reproduction). All findings remediated; regression probes
added per finding. Re-verified under `npm run verify:change -- --base 46b05bf`
→ `READY_FOR_INDEPENDENT_AUDIT`.

---

## Findings & dispositions

### HIGH — all remediated

**K1 — `đ`/`í`-initial Vietnamese lexemes were dead code; coverage went vacuous.**
`\b` in `OBLIGATION_VERB_RE`, the `outcome`/`fulfill` coverage classes, the
quantity marker regexes (`ít nhất`, `đúng`, `<=`, `≥` were equally dead), and
`SCHEDULE_ROLE_RE`/`LOCAL_SOURCE_RE`/`onlyConstraintEvidence`/`versionFamilyRe`
is ASCII-boundary in JS — `đạt`, `đánh giá`, `đối chiếu`, `đề xuất`, `đăng`,
`ít nhất`, `đúng` could never match. Verified: `"Đạt 1.000 người đăng ký trong
vòng 30 ngày"` minted **zero obligations** and `assertPlanCoverage` vacuously
passed an unrelated plan.
*Fix:* boundaries converted to `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])` — the
convention `PROHIBITION_RE` already used — plus a preserved-row backstop: when
a goal mints no coverable requirement but an unclassified clause carries
requirement evidence (quantity floor or deadline phrase), the operator's own
clause is preserved verbatim as `OBL_*` and coverage can never be vacuous
about it.
*Probes:* SC-10, SC-12b, SC-19, H8-adjacent.

**K2 — explicit quantity markers truncated grouped numbers → floor collapse.**
`QUANTITY_MIN_RE`/`MAX_RE`/`EXACT_RE` captured `(\d+)` which stops at the
group separator: `"at least 1,000"` → `min: 1`; `"tối thiểu 1.000"` → `min: 1`.
A task stating 5 subscribers was PROVEN against a 1,000 floor.
*Fix:* marker captures are `(\d{1,3}(?:[.,]\d{3})+|\d+)` routed through
`parseNum` — verified `at least 1,000` → 1000, `tối thiểu 1.000` → 1000.
*Probes:* SC-11 (incl. "5 subscribers" rejection), SC-12.

**K3 — scheduling numbers minted/satisfied floors in both directions.**
`extractQuantity`'s bare fallback took the first clause number including the
deadline phrase: `"within 30 days"` → `min: 30`; `"in 2026"` → `min: 2026`.
Symmetrically, `quantityNums` collected every task number — `"…campaign in
2025"` satisfied a 1,000-subscriber floor.
*Fix:* `TEMPORAL_NUM_RE` (exported from goal-contract.ts) masks
`within/in/trong vòng/khoảng/trong + N + unit`, `N-unit` durations, `N-day`
forms, and bare `(19|20)\d{2}` years before the bare scan — applied on BOTH
the contract side and the task side.
*Probes:* SC-13, SC-14, SC-15 (2025 fails, 1,200 passes through the mask).

### MED — all remediated

**K4 — clause-initial ASCII-pure VI verbs minted false subject anchors.**
`"Thu hút khách hàng mới…"` produced required anchor `thu`; a covering task
`"Thực hiện chiến dịch thu hút…"` anchored `thực` and failed INCOMPLETE.
*Fix:* `ANCHOR_STOP` gains the ASCII-pure VI action syllables
(`thu, tra, xem, ghi, gia, khai`), clause-initial connectives
(`but, however, nevertheless, nonetheless, whereas, while, yet, though,
although, nor`), and fulfill verbs (`carry, roll`) — mirroring
`CONTENT_TOKEN_VI_ACTION_STOP`.
*Probe:* SC-16.

**K5 — rendered context block exceeded the 4096 contract bound; evidence ≠
prompt.** `renderPlanningContextBlock` had no total cap (verified 8,229-char
worst case) while `plan-preview`/`replan-generation` stored a 4,096-char
slice — the model consumed text the durable record called truncated.
*Fix:* `PLANNING_CONTEXT_BLOCK_MAX = 4096` enforced inside the single render
seam — whole-line tail packing + `- … (context truncated to bound)` marker —
so persisted evidence is byte-identical to prompt bytes.
*Probes:* H8 (now asserts ≤4096), PC-10 (max-fill fixture), PC-11 (stored row
=== rendered block).

**K6 — `"X but do not Y"` minted un-coverable obligations.**
`"Research crypto but"` kept the trailing connective; the ±2 context-anchor
scan promoted `but` to a required anchor no plan could satisfy.
*Fix:* `trimTrailingConnective` strips dangling connectives at clause
expansion (bounded list EN+VI); connectives also joined `ANCHOR_STOP` as
residual defense.
*Probe:* SC-17 (`OBL_001.text === "Research crypto markets"`, PROVEN by a
normal task).

### LOW — all remediated

**K7 — `without` leaked into prohibited terms** (`"do not use leverage without
approval"` → terms included `without`). *Fix:* `without` added to
`PROHIBITION_STOPWORDS`. *Probe:* SC-18.

**K8 — stale `coverage_report` could persist on a FAILED attempt.** A first
emission's canonicalize report survived a re-ask that died pre-canonicalize.
*Fix:* `onAttemptReask` clears the per-attempt slot before marking the
re-ask — a settled row never carries a report for a superseded emission.
*(Lives in `serve-mission-control.mjs` — covered by construction + H19
settle-side revalidation; no unit seam exists there.)*

**K9 — `MissionNew` guard weaker than renderer.** A PASS-but-malformed
`coverage_report` would have crashed `rows.map`. *Fix:* guard now also
requires `Array.isArray(rows)`.

**K10 — stale comment:** the OBLIGATION_VERB_RE header still claimed delivery
verbs were absent. *Fix:* comment corrected — `deliver` mints obligations;
telegram-delivery clauses are consumed by the intent check upstream.

## What verified clean (first pass, reconfirmed)

- Envelope provenance classes, advisory-only semantics, digest-only goal
  reference, volatile-stripped digest, no `plan_digest`/`effective_input_digest`
  contamination.
- Two-seam assembly only (`planExpander`, `runReplanPoolGeneration` via
  `invokePlannerPool`); canonicalizer/coverage/extraction remain synchronous
  and context-free.
- Replan pinning: `{context_digest, block}` minted on the durable row at
  request time; generation consumes the pin; drift cannot rewrite it.
- `assertPlanCoverage` remains sole coverage authority; `pair_coverage`
  forgery/non-claimable claims fail closed; coverageSink is post-verdict,
  fault-swallowed, bounded (`boundCoverageReport`), PASS-only.
- Prompt parity: one shared builder, advisory block positioned before the
  goal with an explicit NOT-authority header; codex strict schema excludes
  advisory props; zero new provider invocations (cost envelope untouched).
- Read-only UI projection end-to-end (attempt row → preview →
  `/api/plan-previews` → `MissionNew`).

## Deliberate residual (documented, reviewed)

- A goal carrying **no requirement evidence of any kind** (no recognized
  verb, no quantity, no deadline) still mints an empty contract —
  baseline conservative-incompleteness, retained deliberately so machinery
  goals (`"governed async replan test mission"`) and declarative context do
  not invent requirements. The vacuous-PASS hole is closed for every
  requirement-*shaped* clause.
- Prohibition enforcement is action+term gated (term-level): a task naming
  the banned object under the banned action violates even with a
  contradicting qualifier — conservative-by-design, unchanged.
- `ghi`/`khai`/`gia` in ANCHOR_STOP trade an edge case (a proper noun that
  is also an action syllable) for eliminating the false-anchor class —
  consistent with the existing stop-list doctrine.

---

## K″ final correctness audit (owner-requested, HEAD 0a4e204)

Scope: remaining Unicode-boundary defects in deadline/temporal/constraint
extraction, plus a repository-wide `\b`-adjacent-to-non-ASCII sweep.

### Root cause (single class)

JavaScript `\b` is ASCII-only: it can never fire adjacent to a character
outside `[A-Za-z0-9_]`. Every regex boundary placed next to a
Vietnamese lexeme ending/starting on a diacritic vowel (`ờ`, `á`, `ỉ`,
`ừ`, `ộ`, `ệ`, `ả`, `đ…`) was dead code — invisible to both the author
of the original patterns and the K′ remediation pass, because the
dead edge is silent (the regex simply never matches).

### Findings — all correctness-critical, all remediated at fa78955

| # | Finding | Severity | Fix |
|---|---|---|---|
| K″-1 | `DEADLINE_RE` — `giờ` (ends `ờ`) dead in four alternations: `"trước 10 giờ"` and `"trong vòng 30 giờ"` minted **no deadline row**, and `10`/`30` leaked into the bare-quantity scan → **phantom floor `min:10`** on a deadline-only clause | HIGH | All `\b` → `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])`; `phút`/`giây` units added |
| K″-2 | `TEMPORAL_NUM_RE` — same `ờ` edge dead on both branches: `"30 giờ"` masked **neither on the contract side** (phantom floor) **nor the task side** (a task `"trong 30 giờ"` could satisfy an unrelated floor) | HIGH | Lookarounds; added `trước N <unit>` and `(ngày\|tháng\|day\|month) N` date-ordinal masks (`"trước ngày 15"` had minted `min:15`) |
| K″-3 | `CONSTRAINT_RE` — `không quá`(`á`), bare `chỉ`(`ỉ`), `ngoại trừ`(`ừ`), and left-edge `<=`/`≤` all dead: `"không quá 50 USD"` minted **no constraint row** and fell into the preserved-obligation backstop — a ceiling surfaced as a *coverable obligation* (`max:50` on an OBL row that coverage ignores) with **no constraint record at all**; reviving `chỉ` also armed `ONLY_VI_RE`, which bound auxiliaries (`chỉ cần/muốn/được` → `onlyTerms:["cần"/"muốn"/"được"]`) → unsatisfiable constraint → guaranteed `FAIL_CLOSED_PLAN_INCOMPLETE` on common VI hedging | HIGH | Full lookaround conversion (+ `u` flag); `ONLY_VI_RE` auxiliary skip-chain (`được`/`dùng`/`dụng`) + `ONLY_TERM_STOP` extended with VI function words → `chỉ <aux>` degrades to harmless PRESERVED |
| K″-4 | `LOCAL_SOURCE_RE` (`llm-planner`) — right-edge group `cục bộ`(`ộ`)/`dữ liệu`(`ệ`) dead: `"files cục bộ"`/`"files dữ liệu"` never classified as local source | MED | Trailing `\b` → `(?![\p{L}\p{N}])` |
| K″-5 | `output-language` VI markers — `kết quả`(`ả`) right-edge and `đọc` left-edge dead: VI source/output directives misclassified (`"Đọc tài liệu tiếng anh … kết quả bằng tiếng việt"` resolved `UNDETERMINED` instead of `vi`) | MED | Lookarounds on both marker sets |
| K″-6 | `llm-planner` connective counter — `và`(`à`)/`sau đó`(`ó`) dead: VI connectives never counted toward task-budget derivation | LOW | Lookarounds |

### Sweep methodology & false-positive classification

`scripts/dev-verification/b-boundary-sweep.cjs` enumerates every `\b`
adjacent to an alternation containing a non-ASCII edge char across
`src/pair/*.ts`. Remaining flags after fixes were verified **false
positives** by hand:

- `goal-contract` `BARE_NUM_VI_DOT_RE` — the `\b` sits after a
  zero-width lookahead `(?=\s*(units))` and binds the digit position,
  not the unit text (units intentionally prefix-match);
- `llm-planner` `:219/:224` — `giá`/`tỷ giá` are bare alternations with
  no adjacent `\b` (prefix-match by design);
- `llm-planner` `:203` bare `cục bộ` alternative — same, by design;
- `plan-coverage` `:514` dynamic `\b${ch}\b` — `ONLY_CHANNELS` is
  all-ASCII;
- `plan-dataflow`, `recovery-controller`, `experience-extraction`,
  `objective-source-terms`, `codex-cli-transport` — ASCII-edged only.

### Adversarial regression probes (H21–H30, all green)

- H21/H22: `trong vòng 30 giờ` and `trước 10 giờ` mint `DDL_001`; the
  duration numbers never mint `quantity.min`.
- H23: duration-only clauses (`30 phút`, `2 giờ`, `within 30 days`)
  mint no obligation quantity at all.
- H24: `trước ngày 15` is a date ordinal — no `min:15`.
- H25/H26: a task text containing `trong 30 giờ`/`in 30 days` can never
  satisfy an unrelated `min:500` floor — `FAIL_CLOSED_PLAN_INCOMPLETE`.
- H27: `không quá 50 USD` mints a constraint and `quantity.max` —
  never `min`.
- H28: `chỉ`/`ngoại trừ` constraint alternatives are live.
- H29: `đọc`/`kết quả` markers — VI source/output directive resolves
  `code:"vi"`, authority `GOAL_DIRECTIVE`.
- H30: `files cục bộ`/`files dữ liệu` suppress current-external
  requirement; a genuine `trên mạng` request still requires it.

### K″ verification record (clean environment)

`env -u PAIR_DSH_MODEL_ROUTE -u AGNES_API_KEY -u PAIR_DSH_* npm run
verify:change -- --base 0a4e204` at HEAD `fa78955`:

- patch-claim tests **10/10 PASS** (includes 30/30 adversarial)
- invariants **8/8 PASS** (+3 known baseline)
- affected regression **18/18 PASS** (+27 known baseline)
- TSC **PASS**, build **PASS**
- full suite **PASS_WITH_KNOWN_BASELINE** (+133 — Windows spawn/
  artifact baselines, verified `BASE==HEAD`)
- final verdict **READY_FOR_INDEPENDENT_AUDIT**

Focused suites: 206/206 across planning-context, coverage, adversarial,
prv2b goal-coverage, goal-context-authority, async-replan-generation;
410/412 on the planner/coverage regression sweep (2 fails = covmap
T9/T11 `.cjs`-spawn Windows baseline).

### K″ independent review (codex-reviewer) — FIX-THEN-SHIP → remediated

The K″ fix diff (`0a4e204..fa78955`) was independently reviewed. Verdict
FIX-THEN-SHIP with one correctness-critical finding — now resolved:

- **MAJOR** — `chỉ` revival armed `ONLY_VI_RE`: `chỉ cần/muốn/được/là/
  số/trong …` bound VI auxiliaries as `onlyTerms` → unsatisfiable
  constraint → guaranteed fail-closed on common VI hedging phrasing.
  Fixed: `ONLY_VI_RE` skip-chain strips licensed auxiliaries
  (`được`/`dùng`/`dụng`, iterated) and `ONLY_TERM_STOP` gained the VI
  function-word set — `chỉ được dùng CSV` still binds `csv` correctly.
- **MINOR** — ordinal mask coverage gaps: `thứ 6` (VI weekday), `tuần
  15`, `quý 3`, `week 15`, `day 365`, and `ngày 15/10` (the canonical
  VI dd/mm form — the `/10` tail leaked `min:10`). Fixed with per-unit
  bounded branches (`ngày|day` ≤3 digits + optional date tail;
  `tháng|month` ≤2 digits + optional year tail; `thứ|tuần|quý|week`
  ≤2 digits; `năm` ≤4) — `tháng 500 đơn` still keeps its real 500.
- **MINOR** — `giây` unit inconsistency between `trong vòng`/`trong
  khoảng`/`trong` deadline alternations. Fixed.
- **MINOR** — H-probes asserted revival but not bound semantics. Added
  H31–H37: auxiliary-onlyTerms probes (incl. coverage-level
  `chỉ cần` plannability), `csv` positive binding, all new ordinals,
  `giây` deadline consistency, `tháng 500` non-masking, ceiling max-type.
- **NIT** — K″-3 mechanism wording corrected (backstop carried
  `max:50`, not `min:50`; the harm was a coverable obligation with no
  constraint record).

Reviewer-verified-clean (no action): DEADLINE_RE lookaround equivalence
(`trước khi/mắt/đây/hết/tiên` do not false-positive; `10giờ` glued does
not match), TEMPORAL mask never hides a real floor (`trước 5 đơn hàng`
keeps 5; `Tăng 500` survives), prohibition still outranks `không quá`,
remaining `\b` sites all ASCII-edged or deliberately bare, `x<=5`→` <= 5`
left-edge change is the intended token-boundary semantics, and the `_`
boundary delta (`due_date` mints deadline) is acceptable.

Post-remediation probes: **37/37 adversarial green**.

---

## Final full-scope verification (merge-readiness run)

Owner-requested final gate — run against the **original** pre-V1 baseline,
not the K″ baseline:

`env -u PAIR_DSH_* -u AGNES_API_KEY TMP/TEMP→D: npm run verify:change --
--base 46b05bf` at HEAD `613a715` (code state ≡ `f3da8ac` + claim text):

- patch-claim tests **16/16 PASS** (+22 known baseline)
- invariants **9/9 PASS** (+3)
- affected regression **48/48 PASS** (+40)
- TSC **PASS**, production build **PASS**
- full suite **PASS_WITH_KNOWN_BASELINE** (+133 — all verified
  `BASE≡HEAD` Windows spawn/artifact baselines; C1 live-codex flake
  observed mid-run passed isolated in 17s, not a baseline entry)
- **FINAL VERDICT: READY_FOR_INDEPENDENT_AUDIT**

Environment hardening note: two earlier runs failed on `ENOSPC` — C: had
0 bytes free from ~2,000 leaked `pair-*` mkdtemp dirs (~20 GB) under
`%TEMP%` accumulated across historical test runs. Freed; TMP redirected
to D: for the record run. The leak is a test-fixture cleanup gap —
recorded as a post-merge hardening item, out of this PR's scope.

### Merge-readiness classification (final)

| Scope | Result |
|---|---|
| Semantic correctness | PASS — all K′/K″ findings remediated + probed (37/37 adversarial); revived edges mint satisfiable semantics |
| Canonical authority/security | PASS — advisory envelope never touches digests/gates; coverage sink per-attempt; confirm binds plan_digest only |
| Production integration | PASS — both transports identical prompt threading; replan pin durable; UI read-only |

Unresolved correctness-critical findings: **none**.

### Merge-readiness audit (codex-reviewer, 46b05bf..HEAD) — FIX_THEN_VERIFY → remediated

Third independent review pass over the complete diff. No fail-open /
authority-leaking issue found (every residual fails **closed**). Findings:

- **F1 HIGH** — `không cần` ("no need to") minted term-bans on relief
  phrasing (`không cần thiết` → banned `thiết/trong/báo/cáo`) → idiomatic
  VI goals near-unplannable. Fixed: `không cần` now requires a following
  action form (`không cần dùng martingale` still bans); `trong` added to
  `PROHIBITION_STOPWORDS`.
- **F2 MED** — `by/due/hạn DD/MM` and bare `DD/MM` minted floors
  (`by 15/10` → `min:15`). Fixed: bare `\d{1,2}[/-]\d{1,2}` date-shape
  mask.
- **F3 MED** — duration ranges half-masked (`trong 30-45 ngày` →
  `min:30`, no DDL). Fixed: `\d+(?:[-–]\d+)?` range numbers in both the
  mask and `DEADLINE_RE` — ranges mask fully AND mint the deadline row.
- **F4 MED** — constraint-shaped backstop promoted bare numbers to
  floors (`budget max $500` → `min:500`). Fixed: `min` is stripped when
  the preserved clause matches `CONSTRAINT_RE` — ceilings can never
  become floors.
- **F6 LOW** — render could emit 4097 chars vs ≤4096 persisted evidence.
  Fixed: hard slice at the return seam — prompt bytes ≡ evidence bytes.
- **Ridden (documented, fail-closed-or-benign)**: F5 `without X` term
  granularity (consistent with baseline `do not use X`), F7 `và không`
  dead mid-clause alternative (harmless dead code), F8 `chỉ <verb>`
  loose binding (satisfiable), F9 year-mask trade-off (documented),
  F10 non-budget ceilings mint CON but unenforced `maxAmount`
  (pre-existing), legacy MissionNew route lacks the coverage card
  (additive field, no break), `in N hours` deadline parity added (F42).

Post-remediation: **42/42 adversarial green**, 422/422 focused sweep.
