# PLANNER CONTRACT SIMPLIFY — Report

Mandate: remove `network_requirement` + `pair_coverage` from the mandatory
model-facing contract. PAIR owns canonical metadata derivation, validation and
normalization; the planner is responsible for the semantic core only —
`task_key`, `title`, `task_instruction`, `depends_on`, `required_capabilities`
(`title` is still required by the Codex schema; when a capability has a real
semantic role). Fail-closed stays for real
authority/security. Minimal fix using existing seams.

- Branch: `devin/1791261163-planner-contract-simplify`
- BASE: `e750d86` (main HEAD post-PR#52 merge)
- HEAD: (see commit below)

## Planner-facing contract — BEFORE → AFTER

| field | BEFORE | AFTER |
|---|---|---|
| `task_key` | required | required |
| `title` | required | required |
| `task_instruction` | required | required |
| `required_capabilities` | required (model had to name NETWORK_ACCESS itself) | required — PAIR owns the NETWORK_ACCESS bind; a claim is advisory routing metadata only |
| `depends_on` | required | required |
| `pair_coverage` | **required** — missing/misplaced map killed the plan (`FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED`) | optional **hint/evidence** — never authority |
| `network_requirement` | **required** structured field; missing/malformed/bad-locator/`UNKNOWN`+REQUIRED/`LOCAL`+filename-locator all killed the plan (`FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID`) | optional advisory annotation — never validated, never authority |

## REMOVED (dead model-facing burden)

- `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` gate in `plan-coverage.ts` — a plan
  can no longer die because a requirement was *performed* but not *declared*.
  Replaced by a hint-explanation comment; `extractReaskDetail`'s
  UNDECLARED case in `planner-pool.ts` deleted.
- Fresh-emission `network_requirement` validation classes in
  `serve-planner.ts` — `REQUIREMENT_MISSING`, `REQUIREMENT_MALFORMED`,
  `BAD_LOCATOR`-style locator shapes, `UNKNOWN`+REQUIRED and
  `LOCAL`+filename-locator annotation errors can no longer kill a fresh plan.
  The planner's structured field is consumed as a hint only.
- Codex `PLAN_SCHEMA` `required` list entries for `pair_coverage` +
  `network_requirement` (`codex-planner.ts`); both fields remain permitted
  properties so older emissions still parse.
- Prompt burden (`llm-planner.ts`): `network_requirement` demoted to
  "OPTIONAL advisory hint only — PAIR derives each task's network requirement
  itself"; `pair_coverage` demoted to optional hint (a claimed-but-unperformed
  row is fabricated evidence and still fails); the NETWORK_ACCESS bullet now
  states PAIR binds it from instruction wording.

## STILL CANONICAL (unchanged authorities)

- `Goal Contract` extraction (`extractGoalContract`) — OBL/DEL/prohibition/
  constraint/delivery-intent still mined from the goal, untouched.
- `assertPlanCoverage` existential check — every obligation must be performed
  by some task (`taskCoversObligation`), every deliverable must be produced
  by some task (`taskProducesDeliverable`); missing work =
  `FAIL_CLOSED_PLAN_INCOMPLETE`. Fake coverage cannot mask missing work.
- `validateProposedCoverage` — a declared `pair_coverage` claim must still be
  OBL/DEL + genuinely `covers()` — fabricated claims still rejected; a
  bookkeeping claim on a non-producing task still rejected.
- Network authority: `resolveFreshTaskNetworkAuthority` (fresh) +
  `resolveTaskNetworkAuthority` (persisted, verbatim legacy-read path).
  Fresh failures that remain are *authority* failures, not annotation
  failures: instruction-named host ∉ goal-authorized hosts
  (`UNAUTHORIZED_SOURCE` under `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID`)
  and `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED` when PAIR derives
  REQUIRED but no servable `NETWORK_ACCESS` binding exists.
- `repairNetworkCapabilityBinding` — PAIR-owned: binds `NETWORK_ACCESS` iff
  derived REQUIRED + allowed + jointly servable vs executor capability sets;
  emits `REPAIRED_NETWORK_CAPABILITY:<key>`; planner claim on a
  NOT_REQUIRED task stays advisory and never creates authority.
- Telegram delivery intent authority, artifact identity/provenance (F4),
  secret governance, filesystem containment, dangerous capability grants,
  executor qualification, canonical DAG validity
  (`reconcilePlanDataflow`/`assertPlanDataflow` — order + acyclicity),
  delivery manifest integrity — all byte-unchanged.

## Incidental defects fixed (found by the new adversarial proofs)

1. `extractGoalHosts` URL regex `[^\s"'<>)\]]+` swallowed trailing
   punctuation — instruction `"...https://mql5.com, thu thập..."` produced
   host `mql5.com,` → subset check failed → `UNAUTHORIZED_SOURCE` on a
   legitimately authorized host. Now `raw.replace(/[.,;:!?]+$/, "")` before
   `new URL`/`requirementLocatorHost` (`network-requirement.ts`).
2. `contentTokens`/`sharesContentToken` tokenized on ASCII `[a-z0-9]+` —
   Vietnamese obligations (`tóm tắt mục đích dự án bằng tiếng Việt`) shattered
   into sub-3 fragments → zero content tokens → an obligation with no
   identity anchor could NEVER be covered → `FAIL_CLOSED_PLAN_INCOMPLETE`
   even on a correct plan (the real aquascope death class). Tokenizers are
   now `/[\p{L}\p{N}]+/gu` on both sides (`plan-coverage.ts`).

## Proofs (new adversarial suite `pair-planner-contract-simplify.test.ts`, 11/11)

- **E1 aquascope goal verbatim** — metadata-free 3-task plan (zero
  `pair_coverage`, zero `network_requirement`): PAIR repair binds
  `NETWORK_ACCESS` onto the fetch task (`REPAIRED_NETWORK_CAPABILITY:T1`),
  existential coverage passes, plan pins with PAIR bookkeeping; identical
  outcome through the real HTTP sanitize path (`llmPlan` stub).
- **E2 legacy emission shapes** — `EXTERNAL`+null locator (production
  gold-mission death shape), `LOCAL`+`gold_inputs.json`, `LOCAL`+`outbox/`,
  `UNKNOWN`+REQUIRED: all degrade to "no evidence", never kill; instruction
  wording decides; declaration cannot self-elevate.
- **E3 authority adversarial** — no-network executor policy: zero bind +
  `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`; TELEGRAM_DELIVERY claim
  under a goal that never asked: fail closed; fabricated `pair_coverage`
  cannot mask an unproduced deliverable (`FAIL_CLOSED_PLAN_INCOMPLETE`); a
  task's `depends_on` on a delivery task still dies
  `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`; instruction-named host outside the
  goal's hosts still dies `UNAUTHORIZED_SOURCE`. Cycle-shaped `depends_on`
  normalizes deterministically (unjustified edges pruned at canon) and
  `assertPlanDataflow` confirms acyclic.

## Validation

- Focused (8 files): `pair-planner-contract-simplify` 11/11,
  `pair-network-requirement` 15/15, `pair-network-binding-repair` 10/10,
  `pair-network-requirement-r3` 11/11, `pair-covmap-coverage-map` 15/15,
  `pair-prv2b-goal-coverage` 52/52, `pair-prv2a-planner-modernization` 59/59,
  `pair-prv2b-prohibition-narrowing` 52/52 → **225/225**.
- Full suite: **3728 pass / 3 fail** — byte-identical baseline
  (`F4 R5.1-crash` + 2× P5 env: stock dsh/codex executables present on this
  host); 15 skipped. No baseline touched.
- `npx tsc --noEmit` clean; `npm run build` clean (`rm -rf dist` first).

## Explicit answers required by the mandate

1. **Can a correct semantic plan still die ONLY from a forgotten/wrong
   `network_requirement`?** — NO. On the fresh path the field is advisory
   and is never the rejection input. The only network failures remaining are
   semantic authority failures evaluated from instruction+goal, not from the
   field: `UNAUTHORIZED_SOURCE` (task's instruction names a host the goal
   never authorized) and `TASK_NETWORK_CAPABILITY_REQUIRED` (PAIR itself
   derived REQUIRED and no executor set can serve it — an executor-policy
   denial, not an annotation error).
2. **Can a correct semantic plan still die ONLY from `pair_coverage`
   bookkeeping?** — NO. The `UNDECLARED` gate is deleted; missing, misplaced
   or empty maps never reject. Remaining coverage failures are existential
   (`FAIL_CLOSED_PLAN_INCOMPLETE` — no task performs the obligation /
   produces the deliverable) or fabricated-evidence rejection of a declared
   claim — both semantic, not bookkeeping.

## Residual risks / limitations

- Planner `NETWORK_ACCESS` claims persist as advisory routing metadata —
  the executor-policy gate (`repair` + `TASK_NETWORK_CAPABILITY_REQUIRED`
  + dispatch re-proof) is what makes them non-authoritative; the claim is
  not stripped from the task record.
- Persisted-mission path keeps the legacy resolver verbatim
  (`provenance:"persisted"`) — intentionally isolated legacy-read; new
  semantics only govern fresh emissions.
- `subjectAnchors`/`externalSubjectKeys` remain ASCII-lean for anchoring
  (unchanged) — the unicode fix covers content-token fallback only.
- A plan whose tasks *require* network under an executor policy that serves
  none still fails closed by design (`TASK_NETWORK_CAPABILITY_REQUIRED`) —
  unchanged semantics, now PAIR-derived rather than planner-declared.

---

# R1 AUDIT ROUND — two logic defects + wording correction

- R1 BASE HEAD: `70a031965f9ff1abdee7b248b73fcc23cf518c26`
- R1 NEW HEAD: (see latest commit below)
- Scope: minimal remediation on the same PR — no redesign, no new seams.

## R1.A — fresh `network_requirement` is now *truly* advisory

**Root cause (audited defect):** `resolveFreshTaskNetworkAuthority` still
consumed the planner annotation (`req.source_locator`) — a wrong/malformed
locator produced `INVALID/UNAUTHORIZED_SOURCE` even when the task's own
instruction named no unauthorized host: the annotation could create
*negative* authority (a wrong fresh annotation alone could kill a valid
plan). The same read also let a REQUIRED declaration elevate a quiet
instruction (positive authority from text).

**Fix:** `resolveFreshTaskNetworkAuthority` no longer reads `args.req` or
`args.state` for the verdict. The verdict is a pure function of the canonical
goal + the task's `task_instruction`:

1. hosts the *instruction text itself* names (`extractGoalHosts` on the
   instruction, same grammar) must be ⊆ goal-authorized hosts — an
   instruction-named host the goal never authorized still fails
   `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID {UNAUTHORIZED_SOURCE}`;
   note: this check is **unconditional** — a hostless goal authorizes no
   instruction-named host (R3.B regression restored: under
   "Research MQL5" a task fetching `mql5.com`/`mql5.attacker.example`
   still fails — the earlier draft gated the subset check on
   `goalHosts.size>0` which would have opened that hole; the audit tests
   caught it);
2. `requires = instructionRequiresNetwork || instrHosts.size>0` — the
   annotation cannot create the requirement either;
3. authorization surfaces are goal-text only: instruction-named host ⊆
   goal hosts, `goalRequiresExternalData`, or
   `instructionSatisfiesGoalSubject`.

Annotation verdicts therefore collapse to evidence-free noise: no case in
which annotation text can either grant or deny authority on fresh emissions.
The persisted path (`resolveTaskNetworkAuthority`, `provenance:"persisted"`)
is byte-unchanged — legacy stored plans still judge their stored annotations.

**Proofs (new tests, `pair-planner-contract-simplify.test.ts` R1.A):**
A1 semantic fetch task + NO annotation → REQUIRED, PAIR binds, plan pins;
A2 identical task + wrong `source_locator` in annotation → byte-identical
canonical outcome (annotation cannot deny); A3 malformed/conflicting
annotation → identical outcome; A4 instruction names `attacker.example`
under the github goal → `UNAUTHORIZED_SOURCE`; A5 derived-required task under
a no-network executor policy → `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`;
plus a direct resolver proof that a REQUIRED annotation on a silent
instruction → `NOT_REQUIRED` (cannot grant). Affected pre-existing tests
(`pair-network-requirement` A/B/D, `pair-network-binding-repair` T3/T4/T5/T10)
were rewritten to the new invariant — every one asserted annotation-derived
authority (grant or deny) on the fresh path; the persisted-path assertions
are kept via `fresh:false` checks.

## R1.B — VI action/verb tokens are no longer subject evidence

**Root cause (audited defect):** after the unicode tokenizer fix, coverage
subject overlap could be satisfied by shared *action* tokens —
`tóm tắt thời tiết Hà Nội` covered `tóm tắt mục đích dự án` purely because
`tóm`/`tắt` overlapped; `phân tích giá vàng` vs `phân tích giá bitcoin`
similarly.

**Fix:** `contentTokens` skips the new `CONTENT_TOKEN_VI_ACTION_STOP` set — a
bounded list of Vietnamese action/verb lexemes drawn from the existing
`VERB_CLASSES` vocabulary (tóm tắt/phân tích/nghiên cứu/thu thập/tìm/tra/
lấy/tải/xem/đánh/sánh/xuất/xác định/tạo/viết/soạn/lưu/xây dựng/phát triển/
thiết/ước/vẽ/biểu/kiểm/theo dõi/giám/dịch/liệt/xếp/chọn/đọc/ghi/gửi/xóa/sửa
…). Noun-shaped identity tokens (`giá`, `báo`, `bản`, `hạng`, `đồ`) are
deliberately NOT stopped — they carry subject identity. No NLP, no
mission-specific tokens, no one-off `"tóm"`.

**Proofs:** B1 `tóm tắt mục đích dự án` covered by a matching task → COVER;
B2 `tóm tắt thời tiết Hà Nội` → `FAIL_CLOSED_PLAN_INCOMPLETE`; B3
`phân tích giá vàng` vs `phân tích giá bitcoin` → `FAIL_CLOSED_PLAN_INCOMPLETE`;
B4 `phân tích giá vàng hiện tại` → COVER; B5 aquascope obligation still
covered; EN control unchanged.

## R1.C — contract wording

Report + CURRENT_STATE now list the model-facing contract correctly as
`task_key`, `title`, `task_instruction`, `depends_on`,
`required_capabilities` — `title` remains a required field of the Codex
`PLAN_SCHEMA` (its simplification is a separate future PR, not this one).

## R1 validation

- Focused: `pair-planner-contract-simplify` 23/23 (11→23: +A1–A5 + grant-side
  + B1–B5 + EN control), `pair-network-requirement` 15/15,
  `pair-network-requirement-r3` 11/11, `pair-network-binding-repair` 10/10,
  `pair-covmap-coverage-map` 15/15, `pair-prv2b-goal-coverage` 52/52,
  `pair-prv2a-planner-modernization` 59/59,
  `pair-prv2b-prohibition-narrowing` 52/52 → **237/237** (+2 extra planner
  suites `pgrammar2` 26/26, `preask` 39/39 also green).
- Full suite: **3740 pass / 3 fail** — byte-identical baseline
  (F4 `R5.1-crash` + 2× P5 env probes; 15 skipped). Zero new failures.
- `npx tsc --noEmit` clean; `npm run build` clean.
- Aquascope canonical proof re-run: E1 (metadata-free plan →
  `REPAIRED_NETWORK_CAPABILITY:T1` + pin) still green under the
  annotation-free resolver.

## R1 explicit answers

1. **Can a wrong/malformed/conflicting fresh annotation alone kill a valid
   plan?** — NO. The annotation is never read for the verdict; wrong-locator,
   malformed, conflicting and self-elevating shapes all degrade to "no
   evidence". Proven byte-identical outcomes in A2/A3.
2. **Can a shared VI action token alone prove subject coverage?** — NO.
   `tóm`/`tắt`/`phân tích` no longer enter subject evidence (B2, B3).
3. **Can an instruction-named unauthorized host still be rejected?** — YES.
   The ⊆ check on instruction-named hosts is unconditional and now also
   covers hostless goals (A4, R3.B restored).
4. **Can a genuinely uncovered obligation still fail closed?** — YES.
   `FAIL_CLOSED_PLAN_INCOMPLETE` still fires (B2, B3, E3 fabricated-claim).

## R1 residual risks

- `goalRequiresExternalData` / `instructionMatchesGoalSubject` remain
  heuristic lexical surfaces — a goal demanding external data authorizes
  ANY fetch-shaped instruction with no named host (the instruction contains
  no host to police; executor policy + coverage gates handle subject
  mismatch). Bounded and documented; tightening belongs to a separate work
  item.
- `CONTENT_TOKEN_VI_ACTION_STOP` is a closed vocabulary — a VI action verb
  outside the set can still contribute a subject token; the noun-identity
  trade-off is deliberate (not an NLP fix).
- All other prior residuals unchanged.
