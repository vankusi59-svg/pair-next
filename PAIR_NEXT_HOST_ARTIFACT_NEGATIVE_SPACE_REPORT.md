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
