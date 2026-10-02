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
