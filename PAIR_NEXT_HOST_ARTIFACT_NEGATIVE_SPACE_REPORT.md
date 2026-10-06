# PAIR NEXT — DEBT A: Host/Version Artifact Negative-Space (R1)

- **Audited base**: `5d0b3dff11566e6ce7a090717fd1e072d0abc981` (main, merge PR #55)
- **New HEAD**: see git log on PR branch
- **PR**: see below (KHÔNG merge)
- **Classification**: `PAIR_NEXT_HOST_ARTIFACT_NEGATIVE_SPACE_R1_PENDING_AUDIT`

## 1. Incident

Live prod (08:41): goal nghiên cứu `NousResearch/hermes-agent` → sol emit plan hợp lệ
(T1 fetch github.com + "Ghi ... vào hermes_findings.md", T2 đọc findings viết review)
→ gate gạt `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT {"task":"T1","artifact":"github.com"}`
→ REASK emit lại y hệt → `CANONICAL_VALIDATION_FAILED` → EXHAUSTED → 409.
planner_attempt `PA_01M48600AW051FJPQ3JT21FRTZ`.

## 2. Root cause

`PATH_TOKEN` catch-all `(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10}` tokenize mọi dotted
token giống filename. Free text chứa dotted identifiers không phải workspace
artifact: hostname (`github.com` trong "website github.com"), version (`v1.2`,
`gpt-6.1`), web-doc ref (`node.js docs`). Nearest-verb attribution (`sử dụng`
∈ CONSUME_VERB_VI) biến `github.com` thành consume edge → không producer → gate giết plan.

Thứ hai (phát hiện kèm, cùng seam): passive VI `"(đã) được ghi trong X"` — `ghi`
produce verb + `trong` destination → mint `produces:[X]` cho task chỉ đọc X.
Invented producer có thể che missing-producer thật.

## 3. Semantic rule sau vá (bounded, không parser mới)

Trong `instructionArtifacts()` — seam instruction free-text duy nhất, KHÔNG chạm
`normalizeArtifactPath()` (nó còn validate structured declarations; `notes.io`
khai báo cấu trúc vẫn hợp lệ):

**`isNonArtifactDottedToken(token, before, after)`** — áp dụng chỉ cho single-segment
(token không có `/`; `src/node.js`/`input/a.txt` không bao giờ bị reject):

1. `ext` (phần sau dấu chấm cuối) toàn số → version → reject (`v1.2`, `gpt-6.1`, `2.4`).
2. `ext` ∈ `TLD_LIKE_EXT` {com,org,net,io,ai,dev,app,xyz,info,co,gov,edu,me,us,site,online,cloud}
   → host → reject (`github.com`, `react.dev`, `notes.io` trong free text).
3. External marker trước (`website|web site|site|docs?|documentation|blog|forum|homepage|trên` + space)
   hoặc sau (`docs?|documentation|website|...` + boundary) → external identifier → reject
   (`website node.js`, `node.js docs`, `tài liệu trên node.js`).
4. Ngược lại giữ nguyên — `Đọc file node.js`/`read node.js` vẫn mint (file context,
   không marker, ext `js` không phải TLD).

**`PASSIVE_REF_VI`** — `(?:đã )?được <produce-verb> (trong|vào)` ngay trước path
mention → demote produce thành **consume** (tham chiếu nội dung trong X ⇒ phải đọc X).
Check trước destination-marker produce để `ghi`+`trong` không mint được qua passive.
Active `ghi vào x.md` / `viết ... vào x.md` / `lưu kết quả trong x.md` (không `được`)
giữ nguyên produce.

## 4. Before/after

| Case | Trước | Sau |
|---|---|---|
| Incident T1 | `produces:[hermes_findings.md] consumes:[github.com]` → UNBOUND → plan chết | `produces:[hermes_findings.md] consumes:[]` |
| Incident T2 | `produces:[hermes_findings.md,outbox/hermes_review.md] consumes:[]` | `produces:[outbox/hermes_review.md] consumes:[hermes_findings.md]` |
| Full incident plan | FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT | reconcile + assertPlanDataflow PASS (verified on dist) |
| `Dùng model gpt-6.1 và version v1.2...phân tích input/a.txt` | consumes `[gpt-6.1,input/a.txt,v1.2]` | consumes `[input/a.txt]` |
| `Đọc file node.js` | consume `node.js` | consume `node.js` (giữ) |
| `node.js docs` / `website node.js` / `trên node.js` | consume `node.js` | không mint |
| `đã được ghi trong X` | produce X | consume X |
| `Ghi vào x.md`, `lưu kết quả trong y.md` | produce | produce (giữ) |

`api.openai.com` (multi-label) không từng được PATH_TOKEN nhìn thấy — test pin
không-mint để chống regression nếu regex sau này nới.

## 5. Tests

- Mới: `src/__tests__/pair-host-artifact-negative-space.test.ts` — **25 tests**,
  nhóm A (incident, gồm end-to-end reconcile+assert), B (hosts + consume-verb
  proximity), C (versions), D (real-artifact controls + P-GRAMMAR3 list intact),
  E (`.js` truth table), F (passive + active controls).
- Focused regression: plan-dataflow incident (125) + P-GRAMMAR2 (26) +
  P-GRAMMAR3 (24) + PRV2B coverage (52) + covmap (15) + planner-contract-simplify (32)
  + suite mới (25) = **299/299 PASS**.
- Full suite: **3798 pass / 3 fail / 15 skipped** — 3 fail byte-equivalent baseline
  `5d0b3df` (F4 R5.1-crash + 2× P5 env executables), không regression.
- `npx tsc --noEmit`: clean. `rm -rf dist && npm run build`: clean.

## 6. Audit answers (12 câu mandate)

1. `github.com` còn mint free-text consumed artifact? **NO** — TLD rule reject.
2. `react.dev` còn mint? **NO** — TLD rule.
3. `v1.2` / `gpt-6.1` còn mint? **NO** — numeric-ext rule.
4. `input/a.txt` mint consume đúng? **YES** — D1.
5. `report.md` mint produce đúng? **YES** — D3/F3.
6. `src/index.ts` hoạt động? **YES** — D5 (multi-segment miễn reject).
7. `được ghi trong X` còn mint X thành producer? **NO** — demote consume (F1/F2).
8. `worker_spec` structured semantics đổi? **NO** — rejection chỉ trong
   `instructionArtifacts` free-text path; `contractArtifacts`/`declaredArtifacts`
   không đụng.
9. `normalizeArtifactPath()` thành TLD blacklist? **NO** — helper sống ở
   instruction seam; structured `notes.io` vẫn hợp lệ.
10. Network authority đổi? **NO**.
11. Telegram delivery authority đổi? **NO**.
12. P-GRAMMAR3 list behavior regression? **NO** — D6 + suite 24/24 xanh.

## 7. Residual ambiguities (ghi nhận, không vá trong scope này)

- `trên` là external marker: "ghi chú trên x.md" (file-surface write phrasing hiếm)
  sẽ mất produce — hướng fail-closed an toàn, sol re-ask sửa được.
- EN passive ("was written in X") không cover — mandate VI-scoped.
- File thật tên `notes.io`/`report.com` trong free text bị reject (TLD trade-off
  mandate đã chấp nhận); structured declaration vẫn được.
- Debt B (orphan RUNNING execution) — mandate loại khỏi scope, handoff riêng.

---

# §R2 — audit remediation (audited HEAD `6e9c8fb`, on same PR)

Two bounded fixes, same seams; no scope expansion.

## R2.A — bare `trên` removed from external-marker authority

`EXTERNAL_MARKER_BEFORE` dropped `trên`: "Đọc dữ liệu trên report.md" had a real
workspace artifact rejected as an external identifier. External rejection now
rests only on explicit web-surface markers (website|web site|site|docs?|
documentation|blog|forum|homepage before/after). "Đọc tài liệu trên node.js" is
ambiguous → not forced external (mandate: no heuristic expansion) → `đọc` mints
consume. TLD rule still rejects github.com/react.dev/example.org alone.

Before/after (dist-verified):

| Phrase | R1 | R2 |
|---|---|---|
| `Đọc dữ liệu trên report.md` | nothing minted (rejected) | `consumes:["report.md"]` |
| `Kiểm tra/So sánh dữ liệu trên baseline.csv` | nothing | consume |
| `Lưu kết quả trên report.md` | nothing | `produces:["report.md"]` (`lưu`) |
| `Đọc tài liệu trên node.js` | nothing | `consumes:["node.js"]` (ambiguous kept) |

## R2.B — passive reference split by preposition + negation guard

`PASSIVE_REF_VI` (unconditional `consumes.add`) replaced by `PASSIVE_VI` with
two capture groups — `(?:(không|đừng|chưa)\s+)?` negation and `(trong|vào)`:

- **Negated** (`không được ghi trong/vào X`) → mention ignored entirely —
  prohibition is neither read evidence nor produce authority.
- **`vào`** (`Kết quả được ghi vào report.md`) → keeps destination PRODUCE;
  never demotes to consume ("Báo cáo được lưu vào outbox/report.md" no longer
  an invented UNBOUND input).
- **`trong`** → never produce; consume ONLY when the remainder of `before`
  (text left of the passive phrase) independently shows a consume-role verb
  via `nearestVerbMatch` — "Đọc các phát hiện đã được ghi trong X" (`đọc`
  proves the read) → consume; "Kết quả được ghi trong X" (no evidence) →
  mention ignored, never guessed.

Before/after (dist-verified):

| Phrase | R1 | R2 |
|---|---|---|
| `Kết quả được ghi vào report.md` | `consumes:["report.md"]` (wrong) | `produces:["report.md"]` |
| `Báo cáo được lưu vào outbox/report.md` | consume (wrong) | produce |
| `Không được ghi trong report.md` | consume (wrong) | neither |
| `Không được ghi vào report.md` | consume (wrong) | neither |
| `Kết quả được ghi trong report.md` | consume (wrong) | neither (no evidence) |
| `Đọc ... đã được ghi trong hermes_findings.md` | consume | consume (independent `đọc` evidence) |

## R2.C — R1 proofs preserved

Incident plan verified on fresh dist: T1 `produces:[hermes_findings.md]`,
T2 `produces:[outbox/hermes_review.md] consumes:[hermes_findings.md]` —
`assertPlanDataflow` PASS, zero UNBOUND. hosts/versions still rejected,
`notes.io` structured path untouched, network/telegram/contract unchanged.

## R2 tests

11 new adversarial tests (R2A.1–4, R2B.1–7) + E4 updated to the new `trên`
semantics: suite **36/36 PASS**. Focused 310/310; full **3809 pass / 3 fail**
= byte-identical baseline (F4 R5.1-crash + 2× P5 env). tsc + clean build clean.

Residual: `không` only captured when adjacent to `được` (bounded negation, per
mandate — not a negation engine); "đã không được" order form uncovered; EN
passive uncovered.

---

# §R3 — audit remediation (audited HEAD `d5cd9ac`, on same PR)

One bounded gap: negated writes whose negation isn't adjacent to `được`
fell through to the ordinary nearest-verb + destination rules, so
`Không ghi vào report.md` / `Đừng lưu trong report.md` /
`Đã không được ghi vào report.md` / `Không được phép ghi vào report.md`
still minted `produces:["report.md"]` — fabricated producer authority.

## Rule added

`NEGATED_WRITE_VI` — anchored at the very end of the 48-char tail, checked
before the passive and destination rules inside `instructionArtifacts()`:

```
(?:đã\s+)?(?:không|chưa|đừng)\s+
(?:(?:có|được(?:\s+phép)?)\s+)?
(?:ghi|viết|soạn|lưu|xuất|tạo|sinh|xây\s+dựng|kết\s+xuất)
(?:\s+[\p{L}\p{N}-]+){0,5}\s+(?:trong|vào)\s*$
```

Match → the artifact mention is ignored entirely (prohibition is neither
read evidence nor write authority). The gap class is unicode
(`[\p{L}\p{N}-]+` — ASCII `[\w-]` silently broke on `báo cáo`), and a
sentence period cannot sit inside a gap word, so a negation can never
cross a clause boundary to poison a later affirmative write:
`Không truy cập Internet. Ghi kết quả vào report.md` still produces.

Covers: `không <verb>`, `chưa <verb>`, `đừng <verb>`, `đừng có <verb>`,
`không được <verb>`, `chưa được <verb>`, `đã không được <verb>`,
`không được phép <verb>` — each with optional ≤5-word modifier gap
before `trong|vào`.

## Before/after (dist-verified)

| Phrase | R2 | R3 |
|---|---|---|
| `Không ghi vào report.md` | produces (wrong) | neither |
| `Đừng có lưu trong report.md` | produces (wrong) | neither |
| `Đã không được ghi vào report.md` | produces (wrong) | neither |
| `Không được phép ghi vào report.md` | produces (wrong) | neither |
| `Không truy cập Internet. Ghi kết quả vào report.md` | produces | produces (invariant kept) |

## Tests

+11: 8 mandated negated forms + gap-with-diacritics + earlier-clause
invariant + affirmative/passive controls. Suite 47/47; focused 321/321;
full **3820 pass / 3 fail** = byte-identical baseline (F4 R5.1-crash +
2× P5 env). tsc + `rm -rf dist && npm run build` clean.

Residual: EN negation (`do not write into X`) uncovered — VI-scoped;
`không phải được` order form uncovered; gap words cannot contain digits+
dot (still bounded).
