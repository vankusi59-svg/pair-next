# PAIR NEXT — PHASE F4 REPORT

## DELIVERY ARTIFACT PROVENANCE CLOSURE

**Canonical base:** `3e17525c11489ee32a21010e46cecf051573cd79` (main after #33 merge)
**Branch:** `devin/1791021130-phase-f4-delivery-provenance`
**PR:** one new PR — **DO NOT MERGE**

Classification: `PAIR_NEXT_PHASE_F4_DELIVERY_ARTIFACT_PROVENANCE_PENDING_SOURCE_REVIEW`

---

## 1. Root cause (in code)

Production incidents `MSN_01M409…` (replan-loop, pre-F3) and
`MSN_01M40GJ89R6F` (abort, post-F3) shared one defect: the shared
`outbox/` directory is cross-mission storage, but three seams treated an
exact-filename file there as the *deliverable*:

1. `pinDeliveryArtifactDigests` (mission-runtime) pinned sha256 of whatever
   file currently sat at `outbox/<name>` — including a stale file written
   by an older mission — as the delivery baseline.
2. `assertDeliveryDeliverable` settle path re-read the workspace file at
   `outbox/` and compared it against the pin — proving only *integrity*,
   never *provenance* (who produced it, in which mission, under which
   execution).
3. `plan-dataflow requiredEdges` carried an inference: *a manifest
   artifact with no declared producer + an earlier remote task ⇒ that
   remote task produced it* (PAIR_OUTBOX_UPLOAD implicit binding) — so
   plans passed feasibility while nothing ever wrote the file.
4. TEXT mode: `outbox/report.txt` existing with valid language/size was
   accepted as the canonical payload without binding to the current
   delivery execution.

Net effect (prod): `outbox/report.txt` from an Oct-2 mission (English)
was pinned as baseline, the Oct-3 delivery task found "the file already
there", returned DONE with `artifacts:[]`, and only the output-language
gate caught it — leading to REPLAN→abort. SHA alone could never have
caught it: the stale file's own digest is perfectly valid.

## 2. F4 architecture — authority chain

Canonical delivery authority is now a single chain, reused end-to-end:

```
declared produce edge (pair_dataflow.produces, bounded grammar /
explicit contract — never precedence inference)
  → producer governed task + executor execution, same mission_id
  → ARTIFACT_ACCEPTED immutable event facts (logical_name, sha, size,
    producer_executor_id, execution_id)
  → execution_validation PASS anchored by RESULT_VALIDATED event
    (R2.2 mission_id + governed_task_id + artifact_ids binding)
  → pair-artifact.v1 row re-verified through ArtifactAuthority
    (verifyAcceptedArtifact — the F1/R1.1 shared seam)
  → CAS bytes (content-addressed, immutable)
  → pin {sha256, artifact_id, producer_execution_id, logical_name}
  → settle-time re-verify + staged request-owned snapshot
  → send-time digest check
```

No second/weaker verifier was added — every check runs through the
existing `ArtifactAuthority` / `verifyAcceptedArtifact` /
`readForConsumption` seams from F1/F2.

## 3. Findings → implementation

### F4.1 — FILES manifest binds canonical in-mission artifact

`pinDeliveryArtifactDigests` (mission-runtime.ts:437-502): for every
manifested artifact the pin now REQUIRES a resolved canonical binding —
`{path:null, sha256, state:"PINNED", artifact_id, producer_execution_id,
logical_name}` — via `resolveDeliveryArtifact` (artifact-handoff.ts:489):
producer must be a `depends_on` predecessor whose `pair_dataflow.produces`
declares the artifact (the `name` or `outbox/<basename>` staged form),
with execution COMPLETED + anchored PASS + ARTIFACT_ACCEPTED +
governed-task linkage + same mission_id + same plan_revision.
Zero producers → `FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE`
(`no_in_mission_producer`); >1 → `DELIVERY_ARTIFACT_PROVENANCE`
ambiguous. **Same filename + same SHA from a foreign mission fails**
(artifact_id is execution-bound: `canonicalArtifactId(exec, name)`).

`assertDeliveryDeliverable` settle FILES path (mission-runtime.ts:664-784):
pin must carry valid sha + artifact_id + producer_execution_id → else
PROVENANCE (`pin_without_canonical_binding`); the canonical row is
re-read and `readForConsumption(artifactId, {execution_id, mission_id,
logical_name, sha256})` re-verifies retained CAS bytes bound to the
delivery execution → catch → PROVENANCE (`canonical_reverify_failed`);
bytes mutated → `FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED`;
`sources[name] = artifacts.casBlobPath(sha)` — delivery sources are CAS
paths, never workspace paths.

### F4.2 — remote-predecessor inference deleted

`plan-dataflow.ts requiredEdges` (~755-830): the
*no-declared-producer + earlier remote task ⇒ PAIR_OUTBOX_UPLOAD*
inference is removed. Every manifested artifact without a declared
producer → `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT`; producer-only-
later → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`; multiple →
`FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER`. Remote tasks are
producers only through an explicit declared produce edge (instruction
grammar / canonical artifact contract). `dependency_reason:
PLAN_DATAFLOW_UNBOUND` feeds the F3 typed recovery context so replan
emits a producer-bound alternative.

### F4.3 — outbox is transport/staging, never authority

`telegram-delivery.ts`: `mintTelegramDeliveryRequest` now stamps
`slot.source_path` on each artifact slot from the runtime's
`artifactSources` (CAS blob paths). The bridge projection reads
`p = a.source_path` — it never resolves anything in the outbox.
`resolveDeliveryArtifactPath` remains exported as dead production code
(kept only for the f1-r2 sanitization tests) — it creates no provenance
and no longer participates in the authority chain. A stale exact-name
file in outbox cannot shadow the canonical artifact: pin binds
artifact_id; settle reads CAS; projection reads the stamped CAS path.

### F4.4 — TEXT payload provenance

`plan-dataflow.ts extractTaskDataflow`: a TEXT-mode delivery task now
declares `produces += DELIVERY_TEXT_ARTIFACT` (outbox/report.txt) — the
delivery execution's own artifact ingest binds the payload file to THIS
execution (the payload genuinely writes it). Settle TEXT path
(mission-runtime.ts:574-662): canonical artifact under the delivery
execution's id (`canonicalArtifactId(exec_id, DELIVERY_TEXT_ARTIFACT)`)
→ `tryGet` → `readForConsumption` bound to the delivery execution;
fallback `resolveDeliveryArtifact` for an earlier declared producer;
none → PROVENANCE (`no_current_execution_or_in_mission_producer`).
"report.txt exists" is never proof — an old file with valid
language/size/bytes/digest still fails without current provenance, and
is left physically untouched (no authority deletes storage).

### F4.5 — preserved invariants

SHA/TOCTOU safety intact: stat-first bounded reads
(`boundedFileSha256`), `MAX_TELEGRAM_FILE_BYTES`/`MAX_ARTIFACT_BYTES`,
TOO_LARGE pins, snapshot retry semantics, no re-baselining after
mutation/restart, `UNKNOWN_SIDE_EFFECT`, message_id evidence, bounded
retry, F3 ledger/receipt authority, all F1/F2 seams. Zero Telegram send
authority on any provenance failure (fail happens before TDR mint or at
settle with zero beginDeliveryAttempt calls).

## 4. Changed files

- `src/pair/artifact-handoff.ts` (+88): `resolveDeliveryArtifact` for
  delivery-manifest resolution against canonical producers.
- `src/pair/artifact-authority.ts` (+8): readForConsumption binding
  seam used by the settle re-verify.
- `src/pair/mission-runtime.ts` (+286/-…): `pinDeliveryArtifactDigests`
  canonical-binding pins; `assertDeliveryDeliverable` FILES + TEXT
  authority chains; `artifactSources` CAS stamping.
- `src/pair/plan-dataflow.ts` (+62): F4.2 inference removal;
  F4.4 TEXT-mode delivery produce declaration.
- `src/pair/telegram-delivery.ts` (+31): `slot.source_path` stamping;
  projection sources from the stamped path.
- `src/__tests__/pair-f4-delivery-provenance.test.ts` (new, 990 lines):
  full runtime harness + adversarial A1–A11.
- `src/__tests__/pair-output-delivery-contract.test.ts` (+302):
  ScriptedAdapter artifact declaration (`wrote` tracking —
  production `finish()` workspace-diff contract); `mkCanonicalProducer`
  governed/exec/upload seam; artifactSources stamped at mint callsites;
  C3 rewritten (clobber is impotent — canonical bytes still deliver);
  F3 control + `noBinding` case; Z3/Z4 canonical tamper cases.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` (+95): same
  adapter declaration contract; remote tasks never write workspace
  files; G+H remote upload exercises the REAL canonical lane
  (`mintArtifactCapability` → `acceptArtifactUpload` → compat
  materialization), remote producer declared via instruction grammar.

## 5. Adversarial coverage (A1–A11, all PASS)

- **A1** stale same-name file + NO in-mission producer → fail at
  dispatch pin, zero TDR, zero network.
- **A2** same-SHA artifact produced by a FOREIGN mission → provenance
  fail (SHA is integrity, not provenance).
- **A3** stale exact-name file vs current canonical produce → canonical
  binding wins; wire bytes are CAS bytes.
- **A4** FILES manifest consumed with remote predecessors but NO
  declared produce → plan-level `UNBOUND_INPUT` fail-closed.
- **A5** declared remote producer but NO canonical artifact → runtime
  provenance fail, zero send authority.
- **A6** valid canonical in-mission producer → delivery mints once,
  sends canonical bytes exactly once.
- **A7** TEXT: stale valid-vi `report.txt` on disk + DONE-without-write
  → provenance fail; stale file physically remains.
- **A8** TEXT: valid payload produced by the CURRENT delivery execution
  → exactly one request, text bound to that artifact.
- **A9** restart/re-resume: pin + canonical evidence durable — second
  pin converges, settle re-proves, no re-baseline.
- **A10** workspace mutation after pin → digest protection holds: CAS
  bytes deliver, mutated file never reaches the wire.
- **A11** producerless manifest plan → plan-level UNBOUND rejection;
  producer-bound alternative is the repair path.

## 6. Validation (all on final HEAD)

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11) | 11/11 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-f1-artifact-authority` | 20/20 |
| `pair-f2-*` (handoff + R1–R4) | 152/152 |
| `pair-f3-*` (feasibility + replan + R1–R2) | 77/77 |
| `pair-ops-telegram-delivery` | 3/3 |
| `pair-p14-foundation` after `rm -rf dist` | 35/35 |
| **Full repository regression** | **3191 pass / 2 fail** |

The only 2 failures are the known env-only `pair-p5` executable probes
(DSH/CODEX binaries present in this environment — reproduced on the
canonical base `3e17525`, unchanged by this phase).

- `npx tsc --noEmit` — clean (0 errors)
- `pnpm build` — PASS
- `pnpm audit --audit-level=high` — 0 high (1 low, 8 moderate — same as
  base)

## 7. Remaining limitations

- `resolveDeliveryArtifactPath` is retained as dead code for f1-r2
  sanitization tests; no production callsite remains. Removing it is a
  follow-up cleanup, not a correctness issue.
- A delivery task whose executor fabricates an upload through a leaked
  MASTER capability remains bound by capability scoping
  (execution-scoped HMAC) — unchanged from F1/F2.
- TEXT payload language/size contract unchanged; F4 binds provenance,
  not content quality.
