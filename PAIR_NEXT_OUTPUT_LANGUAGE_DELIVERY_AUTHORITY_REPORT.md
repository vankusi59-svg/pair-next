# PAIR NEXT — OUTPUT LANGUAGE + DELIVERY CONTENT AUTHORITY CLOSURE

Remediation report for the live-observed incident: an operator goal that
explicitly requested Vietnamese output (`…báo cáo tổng hợp bằng tiếng việt…`)
delivered an **English** `report.txt` to Telegram.

- **Previous base SHA:** `a01f1d79a2eb672cc54560018e581597e3755780` (main HEAD, Phase E R6 merge)
- **Branch:** `devin/1790953846-output-delivery-contract` (based exactly on the base SHA)
- **Scope:** output/delivery contract correctness only — no new roadmap phase, no scope broadening.

## Root causes (all three defects)

1. **Output language was never canonical.** The only language instruction was
   prose inside one prompt template (`"in the goal's language"`). There was no
   PAIR-owned field, no provenance, no verification — planner output decided
   language implicitly, and nothing checked the produced artifact.
2. **FILES-mode delivery could clobber the producer artifact.**
   `canonicalDeliveryTaskInstruction()` told TELEGRAM_DELIVERY to "compose a
   final report and write `outbox/report.txt`" even in FILES mode — i.e. the
   staging task was instructed to overwrite the exact manifested artifact it
   was supposed to deliver unchanged.
3. **TEXT-mode payload source was wrong/ambiguous.** The TDR derived its text
   from `result.summary`/`result.text`, so an executor that wrote the real
   report to `outbox/report.txt` and returned `DONE` sent **"DONE"** to
   Telegram — an execution acknowledgement silently became the deliverable.

## Canonical language schema and authority source

New module `src/pair/output-language.ts` exports the PAIR-owned contract:

```ts
interface OutputLanguage {
  code: string | null;            // "vi" | "en" | "ja" | null
  authority: "GOAL_DIRECTIVE"     // explicit operator directive wins
           | "GOAL_LANGUAGE"      // dominant language of the goal text
           | "UNDETERMINED";      // neither — never silently invented
  evidence: Record<string, unknown>; // directive text / detector provenance
}
```

`detectOutputLanguage(goal)` is the single deterministic seam (bounded NFC
input, ordered directive regexes for `bằng tiếng việt`/`in English`/`日本語`
etc., else a weighted `classifyTextLanguage` scorer). Absence of a directive
AND undetectable dominant language yields `UNDETERMINED` — documented
deterministic semantics, no invented authority.

Binding: `reconcilePlanDataflow(tasks, {outputLanguage})` stamps
`task.metadata.pair_output_language` (reserved key, digest-covered via the
canonical task JSON) on the delivery task only when the caller explicitly
provides the authority. `assertOutputLanguageAuthority` — wired into
`assertPlanDataflow` at both planning and replan seams, plus
`canonicalizeLlmTasks` in the server — fails closed
(`FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY`) on a forged/mismatched stamp or a
stamp on a non-delivery task. The producer of each manifested textual
deliverable gets an idempotent `PAIR OUTPUT LANGUAGE CONTRACT: … MUST be
written in Vietnamese (vi)` suffix injected into its instruction
(mandate E: RESULT_TEXT intermediates are untouched).

## FILES-mode ownership / provenance design

- `canonicalDeliveryTaskInstruction(intent)` for FILES is now **staging-only**:
  list the manifested artifacts, stage them byte-identically into `outbox/`,
  never compose/edit/translate/regenerate, reply DONE. `outbox/report.txt` is
  no longer an implicit scratch output.
- **Identity pinning:** `MissionRuntime.pinDeliveryArtifactDigests` runs at
  first dispatch (`requestFor`, covering initial + retry + re-route paths) and
  pins `{path, sha256}` per manifested artifact into
  `task.metadata.pair_delivery_artifact_digests` — pinned once, never
  re-baselined by a later prep.
- **Settle gate:** `assertDeliveryDeliverable` re-hashes each manifested
  artifact before the COMPLETED mark; a mismatch is
  `FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED` (with expected/actual sha256), an
  unresolvable artifact is `FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED`.
- **Post-mint guard:** minted TDR slots carry `sha256`;
  `pendingTelegramDeliveries` re-verifies the bytes at projection —
  `FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST`, `FAILED_DELIVERY`, zero network
  calls. The artifact presented to the bridge is provably the artifact the
  producer wrote.

## TEXT-mode canonical payload design

Exactly one canonical payload source: the content of the delivery task's own
contracted `outbox/report.txt` (`DELIVERY_TEXT_ARTIFACT`). The delivery
instruction composes the operator-facing report in the canonical language
into that file; `mintTelegramDeliveryRequest` reads **the file** — never
`result.summary`/`result.text`. A missing/unreadable file fails
`FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING`; an acknowledgement like `DONE`
can never become the deliverable.

## Fail-closed language validation seam

Deterministic gate inside `assertDeliveryDeliverable`, executed at the
settle boundary **before** the COMPLETED mark and before TDR mint:
re-derive `detectOutputLanguage(mission.goal)` (runtime authority comes from
the goal — the stamped metadata cannot move it), then
`verifyOutputLanguageContent(text, expected)` on each manifested textual
deliverable (FILES: textual artifacts only; TEXT: the canonical payload).
The classifier fails only on a *confidently different* language — ambiguous
short/binary content is not a violation. Any mismatch: task FAILED +
durable `DELIVERY_CONTRACT_VIOLATED` evidence
(`FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH` with expected/detected codes) +
governed recovery `ARTIFACT_VALIDATION_FAILURE` (no retry) — and **zero**
`telegram_delivery_request` is minted, so zero Telegram transport.

## Production-goal regression evidence

New suite `src/__tests__/pair-output-delivery-contract.test.ts` — **22 tests,
all passing** — including the exact mandate goal E2E:

- A1–A9: canonical derivation (vi directive, en directive, dominant-language
  fallback, UNDETERMINED, directive-beats-dominance, classifier, verifier)
- B1–B5: stamp on delivery task only, planner-forged stamp stripped +
  restamped, byte-identical reconcile replay, assert-side forge/tamper
  fail-closed, FILES instruction transport-only
- C1: mission COMPLETED — `pair_output_language={code:"vi",authority:
  "GOAL_DIRECTIVE"}`; producer instruction carries the language contract;
  delivery instruction is staging-only; dispatch-pinned sha256 == producer
  bytes == TDR slot sha256; manifest exactly `["report.txt"]`; bridge sends
  exactly once; second poll sends nothing
- C2: English `report.txt` under a vi goal → `FAIL_CLOSED_OUTPUT_LANGUAGE_
  MISMATCH` evidence, delivery task FAILED, **0 TDR minted, 0 transport calls**
- C3: delivery task rewriting the manifested file →
  `FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED`, **0 TDR, 0 calls**
- C4: mutation between mint and bridge → per-slot
  `FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST`, `FAILED_DELIVERY`, **0 calls**
- D1: TEXT TDR text == composed file content, not `DONE`/summary
- D2: wrong-language TEXT payload fails closed pre-mint
- D3: `DONE`-without-file → `FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING`
- D4: restart/replay round-trip preserves canonical language + idempotent mint

## Test counts

- **New focused suite:** 22/22 pass
- **Delivery/dataflow suites:** `pair-ops-telegram-delivery` 3/3,
  `pair-planner-dataflow-incident` 106/106
- **Full suite:** 2764 pass / 2 failed / 15 skipped — the 2 failures are
  `pair-p5` stock-probe environment tests expecting the DSH/CODEX binaries to
  be absent (`EXECUTABLE_NOT_FOUND`); they are installed on this VM for live
  ops, so `available=true`. Baseline-era equivalent: env-only, unrelated to
  this change.
- **tsc --noEmit:** clean. **pnpm build:** clean.

## Changed files

- `src/pair/output-language.ts` (new)
- `src/pair/plan-dataflow.ts` (stamp + assert + instruction rewrite)
- `src/pair/telegram-delivery.ts` (slot sha256, TEXT payload = file,
  projection digest guard)
- `src/pair/mission-runtime.ts` (pin at dispatch + settle gate + mint digests)
- `src/pair/mission-control.ts`, `scripts/serve-mission-control.mjs`,
  `src/pair/llm-planner.ts` (outputLanguage wiring)
- `src/pair/index.ts` (export)
- `src/__tests__/pair-output-delivery-contract.test.ts` (new, 22 tests)
- `src/__tests__/pair-planner-dataflow-incident.test.ts` (TEXT delivery tasks
  now produce the canonical payload file — fixture honors the new contract,
  assertions unchanged)

## Known limitations

- Language detection covers `vi`/`en`/`ja` + unaccented-Vietnamese bigrams;
  other languages classify as UNDETERMINED and skip enforcement (documented,
  deterministic — never invented).
- Classifier is heuristic (weighted n-gram/word scoring), bounded to 4096
  chars input / 256KB artifact reads; short or mixed-language artifacts may
  classify null and pass — the gate fails only on confident mismatches.
- Mandate-uncovered gap (replan digest-awareness, remote-deliverable
  infeasibility) remains out of scope.

## Proof: zero Telegram network on mismatch

C2/C3/D2/D3 assert `deliveries(ctx).length === 0` — no TDR is minted, so
`pendingTelegramDeliveries` projects nothing and the recording transport
receives 0 calls. C4 proves the last-resort guard: even with a minted TDR,
a mutated artifact is `FAILED_DELIVERY` at projection with 0 calls.

Classification:
`PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_CONTENT_AUTHORITY_CLOSURE_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. Await independent audit.

---

# INDEPENDENT AUDIT R1 REMEDIATION

Audit result on the section above: `BLOCKED — R1 REQUIRED` (4 findings).

- **Audited base:** `a01f1d79a2eb672cc54560018e581597e3755780`
- **Previous audited HEAD:** `2b552589bb1a702896a425e230496d66817a8841`
- **New HEAD:** see git log (this section committed on the same PR #30)

## RCA R1.1 — validated TEXT payload ≠ TDR payload (TOCTOU/normalization/truncation)

**Root cause.** The settle gate validated the WHOLE file content read from
`outbox/report.txt`; `mintTelegramDeliveryRequest()` then independently
re-read the file and applied `.trim().slice(0, MAX_TEXT_BYTES)`. Validation
target ≠ wire payload: a 3500-char English prefix + Vietnamese tail
classified the file `vi` (gate PASS) while the actual Telegram TEXT was the
first 3500 English chars — a concrete language bypass, plus a TOCTOU window
and trim/truncation drift.

**Fix — ONE materialization.** New `materializeDeliveryTextPayload(raw)`
in `src/pair/telegram-delivery.ts` is THE canonical wire derivation
(`trim` + `MAX_TEXT_BYTES`). `assertDeliveryDeliverable()` (mission-runtime)
reads the artifact once (bounded fd-read), materializes the payload, fails
closed on empty (`FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING`), validates
language against THAT string, and returns it as `textPayload`. Settle
passes it to mint; mint REQUIRES `args.textPayload` — an unbound/empty
TEXT mint throws `FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_UNBOUND` (IntegrityError)
instead of re-reading or transforming the file. Mint binds durable
evidence: `text_sha256` + `text_length` + `text_source_artifact`.
`VALIDATED TEXT PAYLOAD === TDR TEXT PAYLOAD` by construction.

**Proof.** R1.1-T1 E2E: file = `EN_REPORT×16 + VI_REPORT×6` — whole file
classifies `vi`, materialized payload classifies `en` → mission does NOT
complete, `DELIVERY_CONTRACT_VIOLATED`/`FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH`
with `detected_language:"en"`, zero TDR, 0 transport calls. T2: leading/
trailing whitespace — `TDR.text === materializeDeliveryTextPayload(raw)`
byte-exact + sha256/length/source evidence bound. T3: file content ≠ bound
payload → TDR carries the bound payload; post-mint file mutation cannot
alter it. T4: missing/empty `textPayload` → mint throws, zero TDR rows.

## RCA R1.2 — FILES digest authority was optional (no hash → no authority)

**Root cause.** `artifactSha256` was optional at mint; slots carried a
digest only when supplied; `pendingTelegramDeliveries` verified only
`if (a.sha256)`; the settle gate compared against the dispatch pin only
`if (pinned !== undefined)`. Three permissive seams let a hashless FILES
artifact reach the bridge unverified, and a pre-upgrade (no-pin)
execution reaching settle silently re-baselined against current bytes.

**Fix — mandatory chain.** `dispatch pin exists AND pin.sha256 valid AND
pre-mint hash == pin AND TDR slot sha256 == verified hash AND
pre-network hash == slot sha256`:

- `assertDeliveryDeliverable` FILES branch: `pinned === undefined` →
  `FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING`; per-artifact missing entry
  or missing/malformed `sha256` → PIN_MISSING; mismatch →
  `FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED` (kept). A no-pin pre-upgrade
  execution NEVER silently re-baselines — it fails closed into governed
  recovery (`DELIVERY_CONTRACT_VIOLATED` + `ARTIFACT_VALIDATION_FAILURE`,
  replan/abort per recovery semantics).
- `mintTelegramDeliveryRequest` FILES: absent/incomplete/malformed map →
  `FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST` before the row exists; every
  slot is minted with its canonical SHA-256.
- `pendingTelegramDeliveries` FILES projection: a hashless or malformed
  slot (e.g. a persisted pre-R1 TDR) converges to deterministic
  `FAILED_DELIVERY`/`FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST` — never
  silently skips verification, zero network calls.

**Proof.** F1: mint without map / incomplete map / malformed digest / null
digest all throw `FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST`, zero TDR rows;
complete map mints with valid per-slot SHA-256. F2: persisted hashless
TDR with the file present → `FAILED_DELIVERY`+DIGEST, request
`FAILED_DELIVERY`, 0 transport calls. F3: gate with no pin / empty pin /
null-sha entry → `FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING` (file bytes
are never adopted as baseline); correct pin passes.

## RCA R1.3 — new plans could carry no language authority at all

**Root cause.** `assertOutputLanguageAuthority()` tolerated a delivery
task with no `pair_output_language` stamp unconditionally — the canonical
binding stayed optional forever on every plan, new or legacy.

**Fix — version-gated contract.** New reserved key
`pair_plan_contract = {version: 2}` (PAIR-owned, planner-stripped) is
stamped on the delivery task at the SAME reconcile seam as the language
stamp (only when `opts.outputLanguage` is provided — the only seam where
language authority exists). `assertOutputLanguageAuthority`:

- marker present with `version === 2` → new-contract plan → stamp
  REQUIRED: absent → `FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY`; mismatched
  → FAIL (unchanged rule).
- marker absent → legacy pre-contract plan → absent stamp tolerated
  (runtime re-derives language from the mission goal at the delivery
  gate anyway); a PRESENT wrong stamp still fails — tolerance covers
  absence, never a lie.
- unknown/malformed version → FAIL CLOSED (no authority).
- marker or stamp on a non-delivery task → forged → FAIL.

The marker is digest-covered via canonical task JSON and preserved by the
canonical key-order block so replay produces byte-identical tasks.

**Proof.** P1: new plan marker{2}+stamp → PASS. P2: marker{2}+no stamp →
FAIL. P3: marker{2}+wrong stamp → FAIL. P4: marker on non-delivery → FAIL.
P5: legacy (no marker+no stamp) → PASS; legacy+wrong stamp → FAIL. P6:
version 999/"x"/null/-1 → FAIL. P7: planner-forged marker stripped at
reconcile + re-stamped canonically; JSON round-trip replay passes.

## RCA R1.4 — directives were not output-scoped (first-language-name-wins)

**Root cause.** `detectOutputLanguage` iterated language families in a
fixed regex order and returned the first match anywhere in the goal — a
language naming the SOURCE material could mint output authority
(`Read the sources in Vietnamese and write the final report in English`
→ `vi`, wrong).

**Fix — bounded deterministic grammar.** Every directive match is
collected with its position; in a 160-char lookback window before each
mention, the marker NEAREST the mention decides its scope: SOURCE
markers (read/sources/input/materials/documents/references/from/based on
+ đọc/nguồn/tài liệu/tham khảo) strictly closer → the mention describes
INPUT → skipped; OUTPUT markers (write/compose/summarize/respond/produce/
answer/translate/convert/reply/deliver/output/final/report + viết/soạn/
tóm tắt/trả lời/tạo/gửi/báo cáo/kết quả/xuất) closer, or NO markers at
all (bare directive) → output-scoped candidate. Exactly-one distinct
candidate code → `GOAL_DIRECTIVE`; ≥2 → explicit `UNDETERMINED`
(`detector: "conflicting_output_directives"`, evidence lists codes +
directive texts — never a regex-order pick); 0 → dominant-language
fallback as before. Overlapping mentions deduped by span (earliest/
longest wins) so "bằng tiếng việt" counts once.

**Proof.** L1 `Read the sources in Vietnamese and write the final report
in English.` → `en` GOAL_DIRECTIVE. L2 `Read English sources and write
the final report in Vietnamese.` → `vi` GOAL_DIRECTIVE. L3 `the sources
are in Vietnamese, summarize them` → GOAL_LANGUAGE `en` (source mention
mints nothing). L4 `đọc nguồn tiếng anh rồi viết báo cáo bằng tiếng việt`
→ `vi`. L5 `write the report in English and also write it in Vietnamese`
→ UNDETERMINED/conflict. L6: exact production goal → `vi` GOAL_DIRECTIVE
(regression anchor preserved).

## R1 changed files

- `src/pair/output-language.ts` — output-scoped directive grammar
  (collect+scope+conflict, dedupe, marker sets).
- `src/pair/plan-dataflow.ts` — `PAIR_PLAN_CONTRACT_KEY`/VERSION reserved
  + stamped at reconcile + canonical key-order + version-gated
  `assertOutputLanguageAuthority`.
- `src/pair/telegram-delivery.ts` — `materializeDeliveryTextPayload` +
  `SHA256_HEX_RE` exported; mint: FILES digest map mandatory + TEXT
  `textPayload` mandatory (+`text_sha256`/`text_length`/
  `text_source_artifact` evidence); projection: hashless slot →
  FAILED_DELIVERY DIGEST.
- `src/pair/mission-runtime.ts` — gate materializes+validates payload
  once → `textPayload` to mint; FILES pin mandatory
  (`FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING`), malformed pin digest →
  PIN_MISSING; settle threads `textPayload`.
- `src/__tests__/pair-output-delivery-contract.test.ts` — +20 R1 tests
  (T1–T4, F1–F3, P1–P7, L1–L6); D4 mint fixture passes `textPayload`.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` —
  `mintFilesRequest` fixture materializes artifacts + pins real SHA-256
  (mandatory under R1.2); `create:false` keeps the never-produced case
  converging `FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED`.

## R1 test results

- New R1 focused tests: **20/20** in the contract suite (42 total).
- `pair-output-delivery-contract`: **42 passed**
- `pair-planner-dataflow-incident`: **106 passed**
- `pair-ops-telegram-delivery`: **3 passed**
- Full suite: **2784 passed / 2 failed / 15 skipped** (94 files) — the 2
  failures are the pre-existing env-only `pair-p5` tests 2+3
  (`stockProbe.available===false` expected; this VM has the binaries
  installed so probes return `available:true` — unrelated to this change).
- `tsc --noEmit`: clean. `pnpm build`: clean.

## R1 zero-network proof

Every fail-closed case asserts zero Telegram calls on the recording
transport: T1 truncation-bypass (0 calls, 0 TDR), T4 unbound mint (0
rows), F1 rejected mints (0 rows), F2 hashless persisted TDR (0 calls,
deterministic FAILED_DELIVERY), F3 no-pin settle (gate violation →
`DELIVERY_CONTRACT_VIOLATED` → recovery, no mint). Pre-existing zero-net
guards unchanged (C2/C3/C4/D2/D3, incident §13).

Classification:
`PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_CONTENT_AUTHORITY_R1_PENDING_REAUDIT`

STOP. DO NOT MERGE. Await independent re-audit.
