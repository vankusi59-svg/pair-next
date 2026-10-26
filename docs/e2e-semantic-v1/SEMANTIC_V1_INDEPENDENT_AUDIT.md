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
