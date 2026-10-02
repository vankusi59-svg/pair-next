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

---

# INDEPENDENT RE-AUDIT R2 REMEDIATION

- **Previous audited HEAD:** `ade9e3020f55977da6267232a77e421aa59e9614`
- **New HEAD:** see git log (this section committed on the same PR #30)
- **Scope:** R2.1 legacy TEXT quarantine, R2.2 authoritative plan-contract
  provenance, R2.3 FILES network identity + TOCTOU closure. All R1
  invariants preserved.

## R2.1 — RCA and legacy TEXT quarantine semantics

**RCA.** New-era TEXT mints stamp `text_sha256`/`text_length`/
`text_source_artifact`, but `pendingTelegramDeliveries()` projected any
eligible TEXT request *without validating that evidence*. A persisted
pre-R1 TDR (`text:"DONE"`, `text_state:QUEUED`, no evidence) survived an
upgrade and was sent by the new bridge — re-enabling the exact
historical defect after restart.

**Fix.** In `pendingTelegramDeliveries()` (src/pair/telegram-delivery.ts),
before a TEXT slot is projected, the persisted request must prove
complete, internally consistent canonical payload evidence:

- `text` is a non-empty string, AND
- `text_sha256` matches `SHA256_HEX_RE` AND equals `digest(text)` of the
  EXACT persisted text, AND
- `text_length === text.length`, AND
- `text_source_artifact === DELIVERY_TEXT_ARTIFACT`.

**Missing/malformed/mismatched → deterministic quarantine:**
`text_state=FAILED_DELIVERY` + `last_error=FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE`
+ request `FAILED_DELIVERY` via `recomputeStatus` → terminal (never
eligible again) → **zero network calls**. No migration, no
re-baselining, no workspace inference: the persisted payload is never
rewritten — a legacy `"DONE"` stays `"DONE"` and simply never ships.

## R2.2 — authoritative plan-version provenance

**RCA.** R1's `pair_plan_contract {version:2}` marker made the language
stamp mandatory *when present*, but `marker absent ⇒ legacy` — absence
was treated as proof of a pre-contract plan. A fresh plan bypassing
`reconcilePlanDataflow()` could reach `assertPlanDataflow()` without the
marker and receive the exemption forever.

**Architecture chosen (mandate option C + container provenance).**
The exemption is **removed entirely**: every TELEGRAM_DELIVERY task that
reaches a validation boundary must carry `pair_plan_contract v2` +
matching `pair_output_language` stamp. Marker absence is now
`missing_plan_contract` — FAIL CLOSED at every boundary
(createPlanPreview, confirmPlanPreview, runPlanning, runReplan). There
is no `absent ⇒ legacy` inference anywhere.

- Unknown/malformed version → `unknown_plan_contract` FAIL CLOSED.
- Marker v2 present but stamp absent → `missing_stamp` FAIL.
- Stamp ≠ goal-derived authority → mismatch FAIL.
- Reserved keys on a non-delivery task → `forged` FAIL.

**Persisted provenance (evidence, not just task-local markers):**
`mission_plan_preview` rows now carry `plan_contract_version` outside
task metadata (`plan-preview.ts`), and `confirmPlanPreview` copies it
into mission `pinned_plan.plan_contract_version` — an operator can audit
which contract era any plan was minted under. Compatibility for
pre-v2 persisted rows is **forced-replan**: validation is unconditional,
so a legacy-shaped preview fails at confirm and the operator
re-previews under v2 (self-healing inside the preview TTL).

## R2.3 — FILES network identity design + TOCTOU closure

**RCA.** FILES SHA-256 was verified at projection, but
`transportTelegramDelivery()` then **re-read the file** and — for
`.txt`/`.md` — `.trim()`ed, truncated to 3600 chars, and sent it as
message *text*. Two defects: (a) TOCTOU window between verification and
transport; (b) the wire payload was a transformed derivative, not the
pinned artifact — a `send report.txt` request shipped transformed text.

**Design — snapshot-pinned artifact transport:**

1. **Projection pins the bytes.** `pendingTelegramDeliveries()` copies
   each eligible FILES artifact into `<outbox>/.delivery-snapshots/
   <delivery_id>-<name>` (tmp-write → fsync-rename → re-hash); a
   snapshot whose digest ≠ slot `sha256` fails the slot closed
   (`FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST`). The projected `path` points
   at the snapshot — the immutable bytes whose digest was authorized.
2. **Transport re-proves before every network call.** For each FILES
   artifact the transport reads `sha256File(path)` and requires it to
   equal the slot `sha256` — malformed/mismatched → `continue` (no
   `begin`, no claim, **zero network calls**); the slot stays QUEUED and
   the next projection re-verifies + re-pins.
3. **FILES means file transport.** Every manifested artifact — `.txt`,
   `.md`, binaries — goes out via `send({filePath})` (document/photo
   upload on the governed bridge, `sendPhoto`/`sendDocument`). The
   text-conversion branch and `TEXT_FILE_EXT`/`extname` are deleted;
   `readText` is deprecated dead argument. No `.trim()`, no truncation,
   no message-text derivative.
4. **TEXT keeps its own contract.** `sendText` now also requires the
   mint evidence (`text_sha256`/`text_length` match the exact body)
   before `begin` — a persisted body that drifts from its mint digest
   can never ride the wire.

`sha256(network artifact bytes) === TDR slot sha256` holds at the exact
point of transmission — mutation after projection cannot alter sent
bytes; a tampered snapshot fails the transport's own check.

## R2 changed files

- `src/pair/telegram-delivery.ts` — TEXT evidence gate at projection
  (R2.1); FILES snapshot pin under `.delivery-snapshots/` (R2.3).
- `src/pair/telegram-transport.ts` — per-artifact sha re-verify +
  filePath-only transport; TEXT evidence check pre-`begin`; text
  conversion removed.
- `src/pair/plan-dataflow.ts` — `assertOutputLanguageAuthority`:
  marker-absent → `missing_plan_contract` FAIL (exemption removed).
- `src/pair/plan-preview.ts` — `plan_contract_version` container column.
- `src/pair/mission-control.ts` — `pinned_plan.plan_contract_version`.
- `src/__tests__/pair-output-delivery-contract.test.ts` — +12 R2 tests
  (Q1–Q6, V1–V4, W1–W5); C1 `.txt` assert updated to file transport;
  P5 rewritten to the fail-closed no-marker contract.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` — 6 reconcile
  sites now pass `outputLanguage: detectOutputLanguage(<mission goal>)`
  mirroring the serve seam (marker mandatory under R2.2).

## R2 test results

- New R2 focused tests: **12/12** (Q1–Q6 quarantine, V1–V4 provenance,
  W1–W5 network identity).
- `pair-output-delivery-contract`: **54 passed**
- `pair-planner-dataflow-incident`: **106 passed**
- `pair-ops-telegram-delivery`: **3 passed**
- Full suite: **2796 passed / 2 failed / 15 skipped** (94 files) — the 2
  failures are the unchanged env-only `pair-p5` tests 2+3
  (`stockProbe.available===false` expected; this VM has the binaries).
- `tsc --noEmit`: clean. `pnpm build`: clean.

## R2 zero-network proofs

- Q1–Q5: legacy/malformed TEXT TDRs → `FAILED_DELIVERY`, recording
  transport **0 calls**, never re-projected, payload never rewritten.
- F-series (R1) unchanged: hashless/malformed FILES → 0 calls.
- W4: tampered snapshot → transport skips (`0` calls), next projection
  re-pins and sends exactly the authorized bytes once.
- V4: bypassed plan → `missing_plan_contract` at the planning tick —
  commit never reached, **0 TDR rows**.

Classification:
`PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_CONTENT_AUTHORITY_R2_PENDING_REAUDIT`

STOP. DO NOT MERGE. Await independent re-audit.

---

# INDEPENDENT RE-AUDIT R3 REMEDIATION

- **Previous audited HEAD:** `cd100c4468bfc8126b421b6121d759e99304ce3c`
- **New HEAD:** see git log (this section committed on the same PR #30)
- **Scope:** one final TOCTOU — bind the authorized digest to the actual
  network-upload bytes; snapshot durability claim + retention policy.
  All R2/R1 invariants preserved.

## R3 — RCA and exact byte-materialization design

**RCA.** R2.3 verified `sha256File(snapshot)` before the attempt claim,
but the governed uploader (`sendFile`) then performed a SECOND
`fs.readFileSync(filePath)` to build the FormData payload. A mutation
landing between verification and that read could alter the bytes
Telegram actually received — the claim
`sha256(network bytes) === TDR slot sha256` was not yet guaranteed.

**Design — HASHED BYTES === CLAIMED BYTES === NETWORK BYTES:**

1. `transportTelegramDelivery()` reads the projected snapshot ONCE into
   a bounded buffer (`MAX_TELEGRAM_FILE_BYTES = 48MB`, under the
   Telegram Bot ~50MB upload cap — an oversized pin can never send, so
   it is skipped before any claim).
2. `sha256Hex(buffer) === art.sha256` is required BEFORE
   `backend.begin()` — mismatch/malformed → `continue`, no claim, zero
   network calls.
3. Only after the buffer verifies may the attempt be claimed
   (exclusive `begin()` semantics unchanged).
4. The SAME verified buffer is passed to the sender as `fileBytes`
   (`GovernedTelegramTransport.send` signature extended);
   `filePath`/`name` remain filename/path evidence only.
5. Bridge `governedSend` → `sendFile(chatId, filePath, fileBytes, name)`
   builds `new Blob([fileBytes])` — the uploader NEVER re-reads
   `filePath`. A file send arriving without `fileBytes` fails closed
   (`FAIL_CLOSED_TELEGRAM_FILE_BYTES_MISSING`, definite failure — no
   bytes touched the network).
6. `name` (the manifested artifact's canonical filename) now supplies
   the upload filename — the snapshot's internal staging name no
   longer leaks to Telegram.

There is no filesystem read between final digest verification and
network payload construction. No base64 re-encoding; one byte
representation is hashed and transmitted.

## Adversarial post-verification proof (X1)

- Snapshot holds authorized bytes A → transport reads+hashes A
- inside `backend.begin()` the adversary overwrites the snapshot
  path with bytes B
- sender invoked → captured `fileBytes` are still A and
  `sha256Hex(fileBytes) === slot sha256`
- (the same test under the pre-R3 read-at-upload design would have
  shipped B — the regression catches exactly the removed window)

## Snapshot durability + retention semantics

- **Durability:** staged snapshot writes are
  `openSync → writeSync → fsyncSync → closeSync → renameSync` — the
  report's `tmp → fsync → rename` claim now matches the code. A crash
  cannot leave a half-written snapshot masquerading as authorized
  bytes (any partial `.tmp` is ignored; re-hash post-rename).
- **Retention:** snapshots are transport staging, NOT permanent
  evidence — the durable identity evidence is the slot's `sha256`
  itself. `pruneDeliverySnapshots()` runs inside every
  `pendingTelegramDeliveries()` pass: snapshots of SENT/FAILED_DELIVERY
  slots — and every snapshot of a terminal request
  (SENT/FAILED_DELIVERY/UNSENDABLE) — are removed deterministically;
  the `.delivery-snapshots` dir is dropped when empty. QUEUED /
  in-flight SENDING / UNKNOWN_SIDE_EFFECT slots KEEP their snapshot
  (the pinned bytes are the evidence of what may/must still ship;
  UNKNOWN semantics and retry behavior are untouched). Bound: at most
  the artifacts of non-terminal deliveries occupy the namespace —
  no unbounded hidden-file accumulation.

## R3 changed files

- `src/pair/telegram-transport.ts` — one-read bounded materialization +
  `sha256Hex(buffer)` verify + `fileBytes` passthrough + 48MB bound;
  `filePath` demoted to evidence.
- `scripts/telegram-bridge.mjs` — `sendFile` builds FormData from
  verified `fileBytes` (no `readFileSync`); missing bytes →
  `FAIL_CLOSED_TELEGRAM_FILE_BYTES_MISSING`; upload filename = manifest
  name.
- `src/pair/telegram-delivery.ts` — fsynced snapshot writes,
  `DELIVERY_SNAPSHOT_DIR`/`deliverySnapshotPath` helper,
  `pruneDeliverySnapshots` retention in the projection pass.
- `src/__tests__/pair-output-delivery-contract.test.ts` — `SendCall`
  gains `fileBytes`; W1–W5/C1 assert on wire bytes; +3 R3 tests
  (X1 adversarial post-verify mutation, X2 `.md` file transport,
  X3 SENT-slot snapshot pruning).

## R3 test results

- New R3 focused tests: **3/3** (X1–X3).
- `pair-output-delivery-contract`: **57 passed**
- `pair-planner-dataflow-incident`: **106 passed**
- `pair-ops-telegram-delivery`: **3 passed**
- Full suite: **2799 passed / 2 failed / 15 skipped** (94 files) — the 2
  failures are the unchanged env-only `pair-p5` tests 2+3
  (`stockProbe.available===false` expected; this VM has the binaries).
- `tsc --noEmit`: clean. `pnpm build`: clean.

## R3 zero-network proofs

- X1: post-verification mutation still ships authorized bytes A —
  `fileBytes` hash == slot sha256.
- W4 (preserved): pre-materialization tamper → 0 calls, heal path
  re-pins and sends exactly once.
- Missing/malformed digest → `continue` before `begin` — 0 calls
  (R1.2/R2.1 matrices preserved).
- `begin` exclusivity, definite-failure retry, timeout →
  UNKNOWN_SIDE_EFFECT, and duplicate-poll dedup unchanged.

Classification:
`PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_CONTENT_AUTHORITY_R3_PENDING_REAUDIT`

STOP. DO NOT MERGE. Await independent re-audit.

# INDEPENDENT RE-AUDIT R4 REMEDIATION

- **Previous audited HEAD:** `2ba03aa024ddac67024834c07f60b9a5e2782619`
- **New HEAD:** see git log (this section committed on the same PR #30)
- **Changed files:**
  - `src/pair/telegram-delivery.ts` — snapshot-first FILES projection authority; stat-first size bound converging oversized artifacts to durable `FAILED_DELIVERY`; orphan `<snap>.tmp` cleanup in `pruneDeliverySnapshots`; `MAX_TELEGRAM_FILE_BYTES` moved here as the owning constant.
  - `src/pair/telegram-transport.ts` — stat → bounded read → actual-length verification → sha256 → `begin` → send-same-buffer ordering; re-exports the bound for consumers.
  - `src/__tests__/pair-output-delivery-contract.test.ts` — 7 new R4 adversarial regressions (Y1–Y7).
  - `PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_AUTHORITY_REPORT.md` — this section.

## RCA (re-audit verdicts)

- **R4.1 — retry authority inverted.** Even with R3 byte-materialization, every FILES projection still resolved + re-verified the MUTABLE source first and rewrote the snapshot from it. After a definite send failure (`QUEUED` + backoff), any later source mutation/deletion killed the retry even though the already-authorized retained snapshot was intact — defeating the entire purpose of snapshot retention for retries and restart durability.
- **R4.2 — the size bound was not a bound.** Transport did `readFileSync` BEFORE checking `length <= MAX_TELEGRAM_FILE_BYTES`, so a huge file was fully allocated before rejection; worse, the oversized slot only hit `continue`, staying QUEUED forever — an infinite poll.
- **R4.3 — orphan temp files.** `pruneDeliverySnapshots` removed only the final snapshot path; a crash between tmp write/fsync and `rename` left `<snap>.tmp` hidden in `.delivery-snapshots/` indefinitely.

## R4.1 — Snapshot-first authority order

New FILES projection order per QUEUED slot:

1. Compute the deterministic snapshot path (`deliverySnapshotPath(outbox, delivery_id, name)`).
2. **Reuse check:** `sha256File(snapPath) === slot.sha256` → the retained snapshot is ALREADY the canonical transport authority — project it directly. The mutable source is never required and never re-read while a valid snapshot stands.
3. **Reconstruction fallback (only when no valid snapshot):** drop this delivery's own stale `.tmp` → resolve the canonical source → `sha256File(source) === slot.sha256` → stat-bound check → tmp-write → fsync → atomic rename → re-hash.
4. A mismatched snapshot is never trusted: reconstruction runs against the source digest, and a missing/mismatched source converges to the same durable `FAILED_DELIVERY` (`..._UNRESOLVED` / `..._ARTIFACT_DIGEST`) as before — never a re-baseline to current bytes.

The immutable identity remains the TDR slot sha256; the snapshot is its retained byte realization; the producer file is only a snapshot creation source.

**Proofs (Y1–Y5):**
- Y1: definite send failure → source deleted → retry after backoff sends the retained snapshot (fileBytes decode to the original text; sha256(fileBytes) === slot digest).
- Y2: same failure → source mutated to bytes B → retry still ships bytes A.
- Y3: restart shape — persisted QUEUED TDR + valid snapshot + missing source → snapshot reused, authorized bytes sent.
- Y4: corrupted snapshot → never sent; reconstruction allowed only because the source still matches canonical sha256 (snapshot re-pinned with the authorized digest).
- Y5: corrupted snapshot + mutated source → durable `FAILED_DELIVERY`, 0 network calls.

## R4.2 — Bounded size enforcement

- Projection-side: `fs.statSync` BEFORE any full read — source stat > `MAX_TELEGRAM_FILE_BYTES` → slot `FAILED_DELIVERY` + `FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE` (durable, zero `begin()`, zero network, never repolled). A retained oversized snapshot hits the same stat gate.
- Transport-side: `statSync` → skip when over bound (defense) → `readFileSync` → actual read length MUST equal the stat size (`b.length === st.size`, no mid-read growth) → `sha256Hex(buffer) === slot.sha256` → `begin` → `send({fileBytes})`.
- Y6 proof: a file of exactly `MAX_TELEGRAM_FILE_BYTES` sends (48MB fileBytes delivered); `MAX + 1` bytes → `FAILED_DELIVERY`/`TOO_LARGE`, 0 calls, `attempt_started_at` absent (never claimed), second poll still 0 calls.

## R4.3 — Orphan temp lifecycle

- `pruneDeliverySnapshots` removes `<snap>` AND `<snap>.tmp` for every terminal slot (and all slots of a terminal request); `.delivery-snapshots/` is `rmdir`'d when empty. Pruning is best-effort and scoped to this request's deterministic paths — another active delivery's staging object can never be removed.
- A new staging attempt first removes its own stale `<snap>.tmp` (`rmSync` force) before rewriting.
- Y7 proof: hand-created orphan `.tmp` beside a SENT delivery → next projection pass removes snapshot + tmp + empty dir.

## Validation counts

| Suite | Result |
|---|---|
| `pair-output-delivery-contract` (focused) | **64/64** (57 prior + 7 new R4 Y1–Y7) |
| `pair-planner-dataflow-incident` | **106/106** |
| `pair-ops-telegram-delivery` | **3/3** |
| `pair-p9` (telegram lifecycle/transport) | **79/79** |
| **Full suite** | **2806 pass / 2 failed / 15 skipped** — the 2 failures are the pre-existing `pair-p5` env-only tests 2+3 (expect `stockProbe.available===false`/EXECUTABLE_NOT_FOUND; this VM ships the binaries → `available===true`). Identical to the R3 baseline; unrelated. |
| `tsc --noEmit` | clean |
| `pnpm build` | clean |

Zero-network proofs: Y5 (no call when both snapshots and source can't satisfy the digest), Y6 oversized (0 calls, 0 claims), plus all R2/R3 gates unchanged — a snapshot that fails digest verification never reaches `begin()`; `sendFile` fail-closes on missing `fileBytes`.

## Classification

`PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_CONTENT_AUTHORITY_R4_PENDING_REAUDIT`

STOP. DO NOT MERGE. Await independent re-audit.
