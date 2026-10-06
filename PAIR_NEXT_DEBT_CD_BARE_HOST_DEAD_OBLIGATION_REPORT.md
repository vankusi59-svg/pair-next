# PAIR NEXT — DEBT C + DEBT D: sentence-final bare host + dead verb-only obligation

Ngày: 2026-10-06 · Base/audited baseline: `1f473f4` (main post-PR#56) · Branch: `devin/1791283421-debt-cd` · Classification: `PAIR_NEXT_DEBT_CD_PENDING_AUDIT`

Scope mandate: vá tối thiểu 2 bug độc lập từ handoff `PAIR_NEXT_BARE_HOST_PERIOD_AND_DEAD_OBLIGATION_HANDOFF.md`. KHÔNG mở rộng kiến trúc, KHÔNG parser mới, KHÔNG đụng các seam ngoài scope.

## Incident (production, prod `1f473f4`)

Goal Telegram (hai lần submit, 17:25 + 17:27):
> "Nghiên cứu song song hai phần: một task phân tích xu hướng EA MT5 hiện tại trên mql5.com, một task nghiên cứu các repository EA/algorithmic trading liên quan trên github.com. Mỗi task phải tạo artifact riêng trong outbox/. Sau khi cả hai hoàn tất, một task thứ ba đọc cả hai artifact, so sánh và tạo outbox/opportunity_report.md. Không gửi Telegram." / (lần 2: `https://github.com` + "rồi gửi đến telegram")

Sol emit plan hợp lệ 3–4 task cả hai lần → mỗi lần 409 `FAIL_CLOSED_PLANNER_EXHAUSTED` ở gate khác nhau — DEBT C trước (`NETWORK_REQUIREMENT_INVALID`), DEBT D sau khi C được workaround (`PLAN_INCOMPLETE`).

planner_attempts: `PA_01M48BAW9NMRKPQKG4W931Y0RT`, `PA_01M48BQKRHT964430QQ1TA67GG`, `PA_01M48BXEG0HVZF9NK3DA633HXR`, `PA_01M48BYXQB0032PCJ1V9G00XHB`, `PA_01M48C2HQHG03Z91JHMA32Y2XV`.

---

## DEBT C — root cause & vá

### Root cause (repro trên dist `1f473f4`)

`src/pair/network-requirement.ts` — `BARE_DOTTED_RE = (?<![\w/.-])LABEL(?:\.LABEL)+(?![\w/.-])`:

- Lookahead `(?![\w/.-])` chứa `.` → `github.com.` (cuối câu) bị từ chối match vì `.` bị hiểu là token-continuing (`github.com.foo`). Sau `.` là whitespace nên regex cũng không extend → token match **không gì cả**.
- PR #53 đã vá trailing-punctuation cho nhánh `scheme://URL` (`raw.replace(/[.,;:!?]+$/,"")`) nhưng quên nhánh bare dotted.

| Input | Trước | Sau |
|---|---|---|
| `trên github.com.` | ∅ | `{github.com}` |
| `trên github.com. Mỗi task…` | ∅ | `{github.com}` |
| `trên github.com,/:!/?/;` | `{github.com}` | `{github.com}` (giữ) |
| `a@github.com.` | `{github.com}` (khi kèm period bug) / `{github.com}` sau khi chỉ vá lookahead | ∅ (**@ guard**) |
| `mql5.com.evil.org` | `{mql5.com.evil.org}` | giữ nguyên (token nguyên) |
| `outbox/report.md`, `math.txt`, `1.2.3` | ∅ | ∅ (giữ — `bareTokenHost` reject như cũ) |
| `github.com/path` bare | ∅ | ∅ (giữ — `/` vẫn chặn) |
| `https://github.com.` | `{github.com}` | `{github.com}` (URL branch nguyên vẹn) |

### Exact semantic fix

`BARE_DOTTED_RE` → `(?<![\w/.@-])LABEL(?:\.LABEL)+(?![\w/-]|\.(?=[\w-]))`:

- Right edge: `.` chỉ còn là token-continuing khi ngay sau nó là label char (`[\w-]`) — dấu chấm cuối câu đứng một mình không chặn match nữa. `[\w/.-]` → `[\w/-]` giữ chặn word char và `/` (path-boundary nguyên vẹn).
- Left edge: thêm `@` vào lookbehind → `user@host` / `a@github.com.` không mint authority (lỗ hổng phụ mở ra bởi vá period — đóng cùng đợt).

KHÔNG đụng: `goalAuthorizesHost`, `requirementLocatorHost`, `FILE_EXTENSION_LABELS`, `bareTokenHost`, URL-form branch, network authorization policy.

---

## DEBT D — root cause & vá

### Root cause (repro trên dist `1f473f4`)

`extractGoalContract` comma-splits "đọc cả hai artifact, so sánh và tạo outbox/opportunity_report.md" → mint `OBL_002 {text:"so sánh"}` — verb-only obligation.

`taskCoversObligation` nhánh `!reqAnchors.size` đòi `keyOverlap || sharesContentToken` — nhưng:

- `subjectAnchors("so sánh")` = ∅, `externalSubjectKeys("so sánh")` = ∅
- `contentTokens("so sánh")` = ∅ (`so` < 3 chars; `sánh` ∈ `CONTENT_TOKEN_VI_ACTION_STOP`)
- → `sharesContentToken` = false **với mọi task** → dead obligation → PLAN_INCOMPLETE bất kể plan thế nào.

Task T3 của sol có nguyên văn "So sánh xu hướng…" (verb class `compare` ✓) nhưng vẫn không cover được — bằng chứng dead obligation.

### Exact semantic fix

`taskCoversObligation` — trong nhánh `!reqAnchors.size`, subject evidence chỉ được đòi khi obligation **thực sự nêu subject** (`reqKeys.size > 0 || contentTokens(req.text).size > 0`) HOẶC obligation không có verb class nào (`!reqVerbs.size` — clause rỗng nghĩa vẫn fail-closed như cũ). Verb-only obligation (không anchor + không subject key + không content token) mà đã qua verb-class check → same-class verb trong task là evidence đủ — đúng intent rule (không nêu chủ thể thì không thể "sai chủ thể").

KHÔNG đụng: Goal Contract splitter, anchor logic, quantity preservation, `validateProposedCoverage`, bookkeeping exclusion, PAIR-COVMAP invariants.

### Fail-closed giữ nguyên (pinned bằng test)

- Verb-only + task KHÔNG cùng verb class → vẫn FAIL (`so sánh` vs task "Ghi vào…").
- Obligation CÓ subject/content + task đúng subject → PASS.
- Obligation CÓ subject/content + task subject khác → vẫn FAIL.
- Clause không-verb-không-subject hoàn toàn → vẫn dead/fail-closed (không fail-open).
- Bookkeeping claim coverage → throw. Fabricated `pair_coverage` claim → throw.

---

## Tests (file `pair-debt-c-bare-host-period.test.ts` + `pair-debt-d-verb-only-obligation.test.ts`, 18 tests)

DEBT C pins C1–C9: sentence-final `.` mint (đuôi + giữa text); `,:!?;` giữ; `a@github.com.`/`admin@github.com,` không mint; `mql5.com.evil.org` token nguyên; `outbox/report.md`/`math.txt`/`1.2.3` không đổi; bare-with-path không mint; URL-form cuối câu mint; incident goal mint đủ 2 hosts + `goalAuthorizesHost` cho github.com/api.github.com = true, evil.com = false.

DEBT D pins D1–D8: `so sánh`/`tóm tắt`/`phân tích` verb-only PASS với task cùng class; verb-only + sai class FAIL; obligation có subject đúng PASS / sai subject FAIL; bookkeeping claim throw; fabricated map throw.

E2E incident: goal nguyên văn → `extractGoalContract` mint `OBL "so sánh"` → plan sol-shaped 3 task → `assertPlanCoverage` PASS, `OBL_002` PROVEN bởi T3.

## Validation gates

| Gate | Kết quả |
|---|---|
| Focused (network-req ×2, covmap, prv2b-coverage, contract-simplify, binding-repair + 2 file mới) | 135 + 18 = **153/153** |
| Full suite | **3838 pass / 3 fail** — baseline `1f473f4` byte-identical (F4 R5.1-crash + 2× P5 env executables); +18 test mới vs 3820 |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && npm run build` | clean |
| Incident proof trên dist | `extractGoalHosts(goal)` = {mql5.com, github.com}; `assertPlanCoverage` PASS: OBL_001 PROVEN(T1,T3), OBL_002 PROVEN(T3), DEL_001 PROVEN(T3), PRO_001 PROVEN |

## Scope confirmation

Không đụng: `goalAuthorizesHost`, `requirementLocatorHost`, `FILE_EXTENSION_LABELS`, Goal Contract splitter/digest, anchor logic, quantity preservation, `validateProposedCoverage`, bookkeeping, network policy, planner contract/schema/prompt, artifact/delivery semantics, Debt B.

## Findings phụ (ngoài scope, đã ghi trong handoff — KHÔNG sửa ở PR này)

1. `repairNetworkCapabilityBinding` bind `NETWORK_ACCESS` dư cho task local chỉ vì instruction nhắc host (`REPAIRED_NETWORK_CAPABILITY:T3` trên plan thật — task so sánh local). Fail-open hướng an toàn nhưng nhiễu audit trail.
2. Planner đôi lúc copy "gửi đến telegram" vào non-delivery task → `FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK` (gate gạt đúng; là sol emission pattern, có thể siết prompt sau).
3. Một residual C mới: `github.com..foo` (double period) mint `github.com` — garbage input hướng fail-open nhẹ; operator literal vẫn viết github.com nên authority không mở rộng về thực chất.

---

## §R1 — malformed dotted suffix fail-closed (audit remediation, base `a09a492`)

### Finding

Vá C đầu tiên (`\.(?=[\w-])`) cho `.` cuối câu mint host đúng, nhưng còn fail-open: `github.com..foo` (`. `theo sau bởi `.` rồi label) được match prefix `github.com` — authority boundary không được truncate malformed token rồi mint valid prefix.

### Exact fix (regex-only, seam không đổi)

Right-edge lookahead `(?![\w/-]|\.(?=[\w-]))` → `(?![\w/-]|\.(?=\.|[\w-]))`: `.` ở right edge là token-continuing khi **theo sau bởi `.` HOẶC label char** — chỉ dấu chấm đứng một mình (punctuation) được phép mint. `github.com.`/`github.com.,`/`github.com. - x` vẫn mint; `github.com..foo`, `github.com...foo`, `github.com..` → ∅.

### R1 before/after (verify trên dist mới)

| Input | Trước R1 | Sau R1 |
|---|---|---|
| `github.com..foo` | `{github.com}` | ∅ |
| `github.com...foo` | `{github.com}` | ∅ |
| `github.com..` | `{github.com}` | ∅ |
| `github.com.` / `github.com,` | `{github.com}` | giữ |
| `mql5.com.evil.org` | `{mql5.com.evil.org}` | giữ |
| `a@github.com.` | ∅ | giữ ∅ |
| `github.com. - ghi chú` / `github.com.,` | `{github.com}` | giữ |

Tests: +C10 (3 malformed forms → ∅), +C11 (lone period trước punctuation/whitespace vẫn mint). Suite DEBT C: 9→11. Focused 88/88 (C+D + network-req ×2 + binding-repair + contract-simplify). Full: **3840 pass / 3 fail** = baseline byte-identical (+2). tsc + `rm -rf dist` build clean. DEBT D production code (`taskCoversObligation`) không đổi; scope phụ không đụng.
