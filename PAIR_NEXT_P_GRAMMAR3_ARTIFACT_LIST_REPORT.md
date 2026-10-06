# P-GRAMMAR3 — Bounded artifact-list grammar for `extractTaskDataflow`

**BASE SHA:** `a5bee58` (main, post-PR#54 merge)
**HEAD SHA:** `555bca3`
**Branch:** `devin/1791272343-p-grammar3` — ONE new PR, **not merged**

## 1. Root cause

The live mission `MSN` planner-attempt died `FAIL_CLOSED_PLANNER_EXHAUSTED`
(goal: *"Tạo hai file input/a.txt và input/b.txt … Không truy cập
Internet"*). The plan sol emitted was correct in intent — T1 creates the
two inputs, T2 compares them and writes `outbox/comparison.md` — but
`extractTaskDataflow` minted **`produces: []`** for T1, so Goal
Contract's `DEL_001`/`DEL_002` rows had no producer →
`FAIL_CLOSED_PLAN_INCOMPLETE` → re-ask → identical plan → identical
rejection → EXHAUSTED → 409.

Evidence (reproduced on the exact rejected emission,
`pair-mc-live/planner-cli/pl-1791271543616-6c98f8bd/final.txt`):

| instruction | before | after |
|---|---|---|
| `Tạo hai file input/a.txt và input/b.txt …` | `produces: []` | `produces: [input/a.txt, input/b.txt]` |
| `Đọc input/a.txt và input/b.txt …` | `consumes: []` | `consumes: [input/a.txt, input/b.txt]` |
| `viết báo cáo phân tích vào outbox/x.txt` | `consumes: [outbox/x.txt]` (false) | `produces: [outbox/x.txt]` |

## 2. Exact grammar gap (two deterministic misses, both proven by repro)

**(a) `plan-dataflow.ts` — verb lists were English-only.** `CONSUME_VERB`
/`PRODUCE_VERB` knew `read|open|review|compare|use|…` and
`write|create|save|generate|…`, so a Vietnamese instruction got zero
verb attribution and every path token was ignored. Fixed with bounded VI
verb sets under the *same* nearest-verb seam (not a new parser):

- `CONSUME_VERB_VI` — `đọc|mở|xem xét|xem|so sánh|đối chiếu|phân tích|
  đánh giá|kiểm tra|kiểm|tham khảo|rà soát|sử dụng|dùng|lấy|tóm tắt`
- `PRODUCE_VERB_VI` — `tạo|viết|ghi|soạn|lưu|xuất|sinh|xây dựng|kết xuất`
- VI word boundaries use `(?:^|[^\p{L}\p{N}])` + `(?=[^\p{L}\p{N}]|$)`
  because `\b` does not treat diacritic vowels (`ở`, `á`…) as word
  characters; match index is `m.index + m[0].length - m[1].length`.
- `VI_NOUN_SUFFIX` (`báo cáo|bản|file|tài liệu|kết quả|nội dung|bảng|
  danh sách`) — a VI consume verb used as an adjectival noun suffix
  (`viết báo cáo phân tích vào …`) is skipped, so it can never steal
  the produce role and mint a false consume.
- Destination markers gain `vào|trong`; `TRANSFER_WORDS` gains `tóm tắt`
  (VI transfer/summarize → destination mints produce).

The mandated grammar form — production verb → optional
quantity/article (`hai|2|two|a|an|…`) → optional `file|files` token →
artifact list separated by `,`/`and`/`và` — now resolves end-to-end:
the quantity/article/file tokens already sat in the existing gap
allowlist; they failed only because the *verb* was never attributed.

**(b) `goal-contract.ts` — `FILE_RE` dropped path directories.**
`/\b(\w[\w.-]*\.ext)\b/` (one segment) extracted `a.txt` from
`input/a.txt`, so the `input/` directory vanished from Goal Contract
deliverables and a second listed file could be dropped. One focused
repro proved the miss; `FILE_RE` now accepts `(?:[\w-]+\/)*` leading
segments. Prohibitions, obligations and deliverables all share this
extractor, so `input/a.txt`-shaped goal text now yields identically
spelled artifacts everywhere.

## 3. Files changed

| file | change |
|---|---|
| `src/pair/plan-dataflow.ts` | +VI verb sets, `VI_NOUN_SUFFIX` suppression, `vào|trong` destinations, `tóm tắt` transfer word |
| `src/pair/goal-contract.ts` | `FILE_RE` accepts `(dir/)*name.ext` |
| `src/__tests__/pair-pgrammar3-artifact-list.test.ts` | NEW — 18 tests (truth table + e2e) |
| `src/__tests__/pair-planner-contract-simplify.test.ts` | fixture-only: 3 instructions renamed so they stop *claiming* file paths they never produce (correct new consume semantics exposed latent fixture bugs — no code reverted) |

## 4. Truth table (all asserted in the new suite)

| id | instruction | produces | consumes |
|---|---|---|---|
| G1 | Tạo hai file input/a.txt và input/b.txt | a,b | — |
| G2 | Tạo 2 file a.md và b.json | a.md,b.json | — |
| G3 | Tạo các file a.md, b.csv và c.txt | a,b,c | — |
| G4 | Ghi hai file x.txt và y.txt | x,y | — |
| G5 | Viết report.md và chart.csv | report,chart | — |
| G6 | Create two files a.txt and b.txt | a,b | — |
| G7 | Create files a.txt, b.txt and c.txt | a,b,c | — |
| G8 | Write x.md and y.json | x,y | — |
| G9 | Đọc input/a.txt và input/b.txt | — | a,b |

Controls (must NOT mint produces): `So sánh a.txt và b.txt`, `Kiểm tra
result.csv và summary.md`, `Gửi report.md và chart.png tới Telegram`
(delivery semantics byte-identical), `viết báo cáo phân tích vào
outbox/x.txt` (noun-suffix → produce, not consume).

## 5. E2E mission-shaped repro

The verbatim incident goal + the verbatim rejected plan shape (T1 creates
both inputs, T2 reads both + writes `outbox/comparison.md`) now
canonicalizes and passes `assertPlanDataflow` + `assertPlanCoverage` —
**zero `FAIL_CLOSED_PLAN_INCOMPLETE`** for this input. The test also
asserts the anti-regression: consumption of a path no task produced is
still `UNBOUND_INPUT`, and `input/a.txt` ≠ `a.txt` (no basename
equivalence introduced).

## 6. Validation

- focused (7 files — new suite, contract-simplify, prohibition-narrowing,
  dataflow-incident, covmap, prv2b goal-coverage, pgrammar2): **320/320**
- full suite: **3767 pass / 3 fail / 15 skipped** — the 3 failures are
  the byte-identical known baseline (F4 R5.1-crash + 2× P5 env
  executables on PATH); untouched by this change.
- `npx tsc --noEmit`: 0 errors; `rm -rf dist && npm run build`: clean.

## 7. Residual risks / out of scope

- `repairNetworkCapabilityBinding` is still negation-blind: a goal saying
  *"Không truy cập Internet"* still derives `REQUIRED` and binds
  `NETWORK_ACCESS` (safe direction — a capability grant is not a
  permission to call a forbidden host; mandate marks this OUT OF SCOPE).
- VI coverage is the bounded verb list above; a Vietnamese production
  verb outside it (`dựng`, `chế`…) still mints nothing — same fail-closed
  shape as before, no regression.
- Grammar is nearest-verb + lookback, unchanged in architecture; it is
  not and is not meant to be a general NLP parser.

## 8. Mandate answers

1. **"Tạo hai file A và B" produces both?** YES — `produces: [input/a.txt, input/b.txt]`, proven by truth table + e2e.
2. **"Đọc A và B" produces?** NO — it mints `consumes: [input/a.txt, input/b.txt]` only.
3. **The incident mission still dies `FAIL_CLOSED_PLAN_INCOMPLETE`?** NO — the exact goal + plan shape now passes canonicalize + coverage + dataflow.
4. **Network / `network_requirement` / `NETWORK_ACCESS` derivation changed?** NO — zero edits to network seams.
5. **Planner contract (schema/prompts/`pair_coverage`/MissionRouter) changed?** NO — only the instruction grammar and the goal-side `FILE_RE`; no prompt, schema, router, or executor change.

**Classification:** `PAIR_NEXT_P_GRAMMAR3_ARTIFACT_LIST_PENDING_AUDIT`

---

# R1 — Goal Contract artifact-list preservation (audit remediation)

**R1 BASE HEAD:** `591b509351789eec28611fafd4642adf9279b4a8`
**R1 NEW HEAD:** _filled at commit_

## Root cause

`splitConnectiveGuarded()` treated `và`/`and` as an ordinary clause
boundary, and the comma separator in `splitClauses` did the same, so an
artifact list was fragmented before extraction:

`Tạo hai file input/a.txt và input/b.txt với nội dung mẫu khác nhau`
→ `["Tạo hai file input/a.txt", "input/b.txt với nội dung mẫu khác nhau"]`
— clause 1 mints `input/a.txt`; clause 2 has no produce verb and mints
nothing. The P-GRAMMAR3 `FILE_RE` patch fixed dir-drop (`input/a.txt`
spelled whole) but not list preservation.

## Semantic fix

Bounded, evidence-driven guard shared by both splitters — a separator
joins members of ONE artifact list iff BOTH flanks are filename/path
tokens (`FILE_EDGE_TAIL_RE` / `FILE_EDGE_HEAD_RE`, built from the same
`FILE_EXT_GROUP` as `FILE_RE`, with `[.]?` tolerance for a trailing
sentence period):

- `splitConnectiveGuarded` skips `và|and` when `tail∈file ∧ head∈file`
  (the existing prohibition guard is unchanged and independent).
- new `splitSegGuarded` replaces the raw `h.split()` for the comma /
  `then|sau đó|rồi|and then` level: only `,` matches can be guarded;
  phrase separators always split (they separate work, not list members).

Controls hold because the guard needs file evidence on BOTH sides:
`Nghiên cứu thị trường và viết report.md` (tail `trường` not a file →
splits), `Đọc input/a.txt và tạo outbox/result.md` (head `tạo` not a
file → splits, `a.txt` never minted as produced).

## Tests

6 new R1 cases in `pair-pgrammar3-artifact-list.test.ts` (24 total):
R1.1 exact incident clause → `[input/a.txt, input/b.txt]`; R1.2
three-item VI list → `[a.md, b.csv, c.txt]`; R1.3 EN list →
`[a.txt, b.txt]`; R1.4 work connector keeps obligation + DEL semantics;
R1.5 mixed verbs do not fuse (result.md only); R1.6 verbatim incident
goal → contract mints all three targets and the semantic plan passes
`extractGoalContract` + `assertPlanCoverage` + `reconcilePlanDataflow` +
`assertPlanDataflow` (the previously-claimed assert call is now real).

Focused set (7 files): **326/326**. Full suite: **3773 pass / 3 fail /
15 skipped** — the 3 failures are the byte-identical baseline (F4
R5.1-crash, 2× P5 env executables). `npx tsc --noEmit` clean;
`rm -rf dist && npm run build` clean.

## Residual risks

Unchanged from P-GRAMMAR3: `repairNetworkCapabilityBinding` remains
negation-blind (OUT OF SCOPE per mandate); guard vocabulary is bounded
to `FILE_EXT_GROUP` extensions — a list member whose name has no known
extension still splits (same fail-closed shape as before).

## R1 answers

1. **Does Goal Contract now mint BOTH input/a.txt and input/b.txt?** YES.
2. **Does "Tạo các file A, B và C" preserve all three?** YES.
3. **Does "Nghiên cứu X và viết report.md" retain work-clause semantics?** YES — OBL + DEL unchanged.
4. **Does "Đọc A và tạo B" mark A as produced?** NO — only `outbox/result.md` mints.
5. **Does the exact incident pass coverage + reconcile + assertPlanDataflow?** YES.
6. **Were network or Planner contract semantics changed?** NO.

**Classification:** `PAIR_NEXT_P_GRAMMAR3_ARTIFACT_LIST_R1_PENDING_AUDIT`
