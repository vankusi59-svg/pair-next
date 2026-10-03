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

---

# R1 REMEDIATION — independent source audit round 1

Audited HEAD: `ec4fbf4` · Remediation pushed on the same PR #35.

## R1.1 — provenance pin miss is a typed dependency failure

`resolveDeliveryArtifact` now returns a discriminated result —
`{kind:"bound"} | {kind:"no_producer"} | {kind:"no_canonical_artifact"}`
— instead of throwing a generic `IntegrityError`. `pinDeliveryArtifactDigests`
maps each miss to a typed `DependencyResolutionError`
(`FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE`): `no_producer` →
`PLAN_DATAFLOW_UNBOUND`, `no_canonical_artifact` →
`PRODUCER_CANONICAL_ARTIFACT_MISSING` with `artifact_name` +
`producer_task_id` + `consumer_task_id`. `runRunning`'s pre-dispatch catch
converts it into governed recovery (`startRecovery` /
`DEPENDENCY_FAILURE` + structured `failure_context` persisted on
`pending_recovery`) — no exception escapes the tick, no TDR is minted.

E2E over the REAL `MissionRuntime`: producer declares `report.txt`,
completes PASS, but has NO accepted canonical artifact → zero dispatches,
zero TDR, zero Telegram calls, recovery decision exists with
`failure_class=DEPENDENCY_FAILURE` and the persisted structured reason.

## R1.2 — TDR carries canonical provenance binding (receipt + live re-verify)

Hybrid mint-receipt + live-verification design:

- `DeliveryProvenanceBinding` — `{artifact_id, producer_execution_id,
  governed_task_id, logical_name, sha256, source_path}` carried on FILES
  slots (`artifact_id`, `producer_execution_id`,
  `producer_governed_task_id`, `logical_name`) and on the TEXT payload
  (`text_artifact_id`, `text_producer_execution_id`,
  `text_producer_governed_task_id`, `text_artifact_sha256`).
- `mintTelegramDeliveryRequest` requires a binding for every bound
  payload (missing/malformed → `FAIL_CLOSED_TELEGRAM_ARTIFACT_PROVENANCE`)
  and emits an immutable `TELEGRAM_DELIVERY_MINTED` evidence receipt —
  append-only, surviving any coherent mutable-row rewrite — BEFORE the
  row insert (a bound row can never exist without its receipt).
- `pendingTelegramDeliveries` fail-closes unless exactly ONE receipt
  exists for the delivery (`receipts.length !== 1` → invalid) AND
  `ArtifactAuthority.verifyArtifactForConsumption` re-proves the live
  canonical facts (mission/task/logical name/sha) before the first
  snapshot materialization. A coherent `store.put` rewrite of
  `source_path`/`sha256`/text fields leaves the receipt fields
  inconsistent → `FAILED_DELIVERY` + `FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE`,
  zero transport.
- `source_path` remains transport realization only — never authority.
- Legacy unbound rows (pre-F4 mints) keep the hash-only path.

Adversarial via canonical `store.put` seam (valid entity hash, no raw
corruption): FILES slot rewritten to foreign artifact B bytes+sha →
FAIL CLOSED; TEXT text+text_sha256(`digest()`)+text_length rewritten
coherently → FAIL CLOSED — both zero sends, durable last_error.

## R1.3 — manifest alias ambiguity fails closed

`resolveDeliveryArtifact` collects every canonical artifact identity hit
across all aliases (`report.txt` AND `outbox/report.txt`): 0 →
`no_canonical_artifact`, 1 → `bound`, >1 → typed
`DependencyResolutionError` `ambiguous_delivery_artifact` /
`DELIVERY_ARTIFACT_PROVENANCE` — no lexical-order selection. Producer
accepting BOTH aliases for one manifest name → pin fails closed, zero
TDR; single-alias still binds.

## R1.4 — real restart proof

Test closes the first `PairEvidenceStore`, reopens the SAME durable DB
with a fresh store/control/services, stages `slot.source_path` bytes
from CAS, transports over the reopened store — exactly-once send
(`SENT` + message_id), TDR terminal `SENT`. Stale same-name outbox bytes
introduced between instances are never re-baselined (authority = durable
receipt + CAS, never the filesystem).

## Validation (R1, all on final HEAD)

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11 + R1.1/R1.1b/R1.2-FILES/R1.2-TEXT/R1.3/R1.4) | 17/17 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-ops-telegram-delivery` | 3/3 |
| `pair-f1-*` + `pair-f2-*` + `pair-f3-*` | 369/369 |
| races after `rm -rf dist` (`f1-r2` + `f2-r2`) | 130/130 |
| **Full repository regression** | **3197 pass / 2 fail** |

Same 2 env-only `pair-p5` executable-probe failures (reproduced on base
`3e17525`). `npx tsc --noEmit` 0 errors · `pnpm build` PASS ·
`pnpm audit --audit-level=high` 0 high (1 low, 8 moderate — same as base).

Classification:
`PAIR_NEXT_PHASE_F4_DELIVERY_ARTIFACT_PROVENANCE_R1_PENDING_AUDIT`

================================================================================
R2 REMEDIATION — whole-request receipt binding, atomic mint, fresh-runtime proof
================================================================================

Audited head at R2 work start: `6268e7b0985570d5e48b64a3c254fed197e66c59`.
New head: see final commit on PR #35. All work on the same PR — no new PR, no merge.

## R2.1 — provenance is not downgradeable to legacy

Receipt existence now OWNS the authority path. In
`pendingTelegramDeliveries` the mint receipts are indexed by the
canonical entity identity and `bound = receipts.length > 0`. The FILES
slot gate is `bound || a.artifact_id !== undefined` and the TEXT gate is
`bound || req.text_artifact_id !== undefined`: once a
`TELEGRAM_DELIVERY_MINTED` receipt exists for the entity, deleting every
provenance field off the mutable row cannot reach the hash-only legacy
path — the slot/text fails closed instead. Legacy compatibility is now
identified ONLY by "no receipt AND no binding fields" (pre-F4 rows),
never by "the row happens to lack artifact_id".

Tests: FILES row with ALL provenance fields deleted + coherent
source_path/sha256 rewrite to adversary bytes → FAIL CLOSED, zero
transport (the immutable receipt still exists). TEXT same on text/
text_sha256/text_length.

## R2.2 — the receipt binds the request as a WHOLE contract

New `wholeContractValid(req, receipt)`:
- mode must match the receipt.
- TEXT: text_artifact_id, text_producer_execution_id,
  text_producer_governed_task_id, text_source_artifact (= receipt
  logical_name), text_artifact_sha256, text_sha256 AND text_length must
  ALL equal the receipt fields.
- FILES: receipt artifact entries must match the row slots
  BIJECTIVELY — exact count first, then each slot must match one
  remaining receipt entry on name + artifact_id + producer_execution_id
  + governed_task_id + logical_name + sha256; unmatched residue = invalid.
  Extra slot, missing slot, renamed slot, duplicated slot → all fail.
- Delivery identity is also bound: `req.delivery_id === req.entity_id`
  (R2.3) and receipts must be EXACTLY ONE for the entity.

Tests: A rename report.txt→forged.txt retaining valid canonical binding
→ FAIL. B duplicate one receipt-bound artifact into a second named slot
→ FAIL. C remove one slot of a 2-file request → FAIL. D untouched
receipt-bound 2-file request → PASS (control, 2 sends).

## R2.3 — delivery identity is the canonical entity identity

`req.delivery_id === req.entity_id` is now part of the accepted-request
invariant (`identityOk`), and receipts are resolved by `req.entity_id` —
the field `store.put` injects into the stored body, which a canonical
write cannot forge. A coherent `store.put` rewrite of
`payload.delivery_id` therefore can neither escape receipt authority nor
fabricate a second entity: `putReq` now writes back to
`entity_id ?? delivery_id` — the canonical entity key — so the row is
marked FAILED_DELIVERY on the real entity (previously it crashed with a
version conflict against the forged key). Test mutates delivery_id on
the same canonical key → FAIL CLOSED, zero network, receipt still
exactly one.

## R2.4 — mint receipt + TDR row are crash-atomic

`mintTelegramDeliveryRequest` mints inside ONE `store.immediate`
transaction: in-transaction `tryGet` re-check (not just the
pre-transaction read) → idempotent return of the existing row; the
TELEGRAM_DELIVERY_MINTED receipt append and the TDR `store.put` are
atomic — either both durable or neither. `appendEvidence` is a plain
INSERT, safe inside the transaction.

Test: an injected fault between receipt-write and row-write (the put
inside the transaction throws) rolls back BOTH — zero receipt AND zero
row durable. Retry mints exactly one receipt + one row. A second
(serialized-race-equivalent) mint converges to the same canonical row —
one receipt, one row, no mutation. After a real store close/reopen,
exactly one receipt remains.

## R2.5 — genuinely fresh-runtime restart proof

The harness's production wiring was extracted into `wireStack(name,
workspace, store, opts)` — same constructors for service/gate/registry/
router/recovery/reconciliation/approvals/scheduler/adapters/planner/
runtime/supervisor/control + capability registration. `makeCtx` delegates
to it. The R1.4 restart test was rewritten for R2.5: instance B is a
WHOLE new stack built by `wireStack` over a reopened `PairEvidenceStore`
on the same DB — fresh store + PairControlPlane + scheduler + approvals
+ recovery + MissionRuntime + MissionControl; zero objects referencing
the closed store. A tick on the fresh runtime converges the completed
mission without re-dispatch; the durable mint receipt survives; stale
same-name outbox bytes written BETWEEN the instances are never
re-baselined; wire bytes are the canonical CAS bytes; exactly-once.

## R2.6 — no regression of prior closures

All A1–A11 and R1 tests keep passing unchanged (the R1.4 test itself was
the one rewritten per R2.5 — its assertions only got stronger).

## Validation (R2, all on final HEAD)

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11 + 6 R1 + 8 R2) | 25/25 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-ops-telegram-delivery` | 3/3 |
| `pair-f1-*` + `pair-f2-*` + `pair-f3-*` + runtime/recovery suites | 369/369 + runtime-hardening 11 + live-ops 20 + phase-d 37 |
| focused batch total | 640/640 |
| races after `rm -rf dist` (`f1-r1` + `f1-r2`) | 120/120 |
| **Full repository regression** | **3205 pass / 2 fail** |

Same 2 env-only `pair-p5` executable-probe failures (reproduced on base
`3e17525`). `npx tsc --noEmit` 0 errors · `pnpm build` PASS ·
`pnpm audit --audit-level=high` 0 high (1 low, 8 moderate — same as base).

## Remaining limitations

- Pre-F4 legacy TDR rows (minted before provenance binding existed) keep
  the hash-only path by authoritative history (no receipt + no binding
  fields) — they can never gain a receipt retroactively.
- `wholeContractValid` treats the receipt artifact list as a SET — FILES
  manifest order is not semantically relevant in transport (one send per
  slot), so reordering is accepted; any slot multiset mismatch is not.
- The R2.4 race test models a serialized competitor through the canonical
  seam (BEGIN IMMEDIATE serializes writers) rather than spawning two OS
  writers — the durable-state assertions (1 row / 1 receipt) are what the
  mandate requires.

Classification:
`PAIR_NEXT_PHASE_F4_DELIVERY_ARTIFACT_PROVENANCE_R2_PENDING_AUDIT`

---

# F4 R3 — send-authority closure (audit round 3)

Prev audited HEAD `f9ce5f0` → new HEAD (this commit). Same PR #35.

## Findings closed

- **R3.1 — complete static send authority in the mint receipt.** The
  `TELEGRAM_DELIVERY_MINTED` receipt now binds every static field that
  determines what/where/how a request may send: `delivery_id` (canonical
  entity id), `mission_id`, `task_id`, `execution_id`, `mode`,
  `destination {provider, chat_id, provenance}` (or `null`), `sendable`,
  `max_attempts` ceiling, `outbox_dir`, `workspace`, and per-slot
  `source_path`/`max_attempts` for FILES. `wholeContractValid` proves
  exact equality of every bound static field before any projection or
  send — a coherent rewrite of mission/task/execution/destination/
  staging roots is a fail-closed violation. Mutable lifecycle fields
  (state, attempt_count, timestamps, message_id) are never bound.
- **R3.2 — filesystem staging root is not mutable authority (design B).**
  Snapshot storage moved to `deliverySnapshotRoot(store)` =
  `store.dbDir/.delivery-snapshots`, keyed by canonical `entity_id` —
  independent of mutable `outbox_dir`/`workspace`/`delivery_id`. All
  filesystem effects (prune, mkdir/write/rename/rm) happen only AFTER
  the bound row passes its whole static contract: a bound row failing
  validation gets ZERO filesystem operations. The receipt still binds
  `outbox_dir`/`workspace`, so forging either is fail-closed before any
  fs touch.
- **R3.3 — rollback-resistant append-only lifecycle.**
  `TELEGRAM_DELIVERY_ATTEMPT_STARTED` / `..._RESOLVED` evidence rows are
  the immutable high-water authority; the mutable row is a projection.
  `beginDeliveryAttempt`/`resolveDeliveryAttempt` each commit evidence +
  projection in ONE `store.immediate` transaction (crash in either rolls
  back both). Attempt authority binds delivery entity id, slot identity,
  `attempt_id`, `attempt_number`, outcome, `message_id` (SENT), and
  timestamps. `reconcileStaleDeliveryAttempts` appends RESOLVED UNKNOWN
  evidence inside the same transaction as the projection. At every
  projection pass the slot must equal the ledger: `attempt_count ===
  consumed`, last STARTED ⇒ SENDING with same attempt_id, RESOLVED
  SENT ⇒ SENT with same message_id, UNKNOWN ⇒ UNKNOWN_SIDE_EFFECT,
  FAILED ⇒ QUEUED-or-FAILED_DELIVERY. Any disagreement → durable
  `FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE` — a mutable rollback never
  mints a new send permission.
- **R3.4 — immutable retry budget.** `max_attempts` is stamped in the
  receipt and each FILES slot entry; consumption derives from
  `deliveryAttemptLedger` (`consumed` = RESOLVED FAILED count; next
  `attempt_number` = `max(started, attempt_count)+1`; begin refuses
  `consumed >= max_attempts`). Rewriting the ceiling or zeroing
  `attempt_count` mints no budget.
- **R3.5 — R1/R2 contracts preserved**: receipt existence owns the
  authority path, bijective slot set, TEXT payload binding, entity_id
  authority, live `verifyArtifactForConsumption`, atomic mint, fresh
  restart, DEPENDENCY_FAILURE, alias ambiguity, F1/F2/F3 invariants.

## Design answers

- **Static send-authority receipt**: one `TELEGRAM_DELIVERY_MINTED` row
  per entity carries the complete static contract; `wholeContractValid`
  is a total verifier — nothing static escapes binding.
- **Destination binding**: `{provider, chat_id, provenance}` triple
  compared exactly; `sendable:false` receipts require row status
  `UNSENDABLE` — a forged QUEUED + forged destination is both a contract
  violation and (absent history) has no send path.
- **Filesystem root**: design B — canonical `store.dbDir`-scoped root;
  mutable workspace/outbox remain staging inputs only.
- **Attempt lifecycle**: append-only evidence per slot; atomic
  BEGIN/RESOLVE; projection is a verifiable cache of the ledger.
- **Retry budget**: ceiling stamped at mint; consumption derived from
  immutable attempt history, not the mutable counter.

## Tests added (17 — total file 42/42)

R3.1a origin A→B retarget · R3.1b default A→B · R3.1c UNSENDABLE→QUEUED
forged activation · R3.1d-f mission_id/task_id/execution_id rewrite ·
R3.2a forged outbox_dir → zero fs ops (mkdir/write/rename/rm spies) ·
R3.2b forged terminal row → prune untouched · R3.3a FILES SENT→QUEUED
rollback · R3.3b TEXT same · R3.3c crash-in-begin atomicity · R3.3d
crash-in-resolve atomicity · R3.3e real restart with durable history ·
R3.4a ceiling rewrite · R3.4b ledger-derived numbering + count rollback
fail-closed · R3.4c exhausted resurrection · R3.5 clean control.

## Validation

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11 + R1 + R2 + R3) | 42/42 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-f1-*` + `pair-f2-*` + `pair-f3-*` + ops/runtime/phase-d | all pass |
| F1 race suites after `rm -rf dist` | 140/140 |
| **Full repository regression** | **3222 pass / 2 fail** |

Same 2 env-only `pair-p5` executable-probe failures (reproduced on base
`3e17525`). `npx tsc --noEmit` 0 errors · `pnpm build` PASS ·
`pnpm audit --audit-level=high` 0 high.

## Remaining limitations

- Pre-F4 legacy TDR rows keep the hash-only path (no receipt + no
  binding fields) — never retroactively receiptable.
- The lifecycle ledger is rebuilt per projection pass from
  `listEvidence` — O(mission evidence) per request; fine at current
  scale.
- Crash-in-transport between evidence append and store commit inside a
  single `store.immediate` is atomic by sqlite; a crash BETWEEN the
  immediate calls (e.g. between begin() returning and the send) leaves
  a durable STARTED row — stale reconciliation resolves it to
  UNKNOWN_SIDE_EFFECT as designed.

Classification:
`PAIR_NEXT_PHASE_F4_DELIVERY_SEND_AUTHORITY_R3_PENDING_AUDIT`

---

# R4 — FINAL SEND-GATE / LIFECYCLE LEDGER CLOSURE

Previous audited HEAD: `ebce53d` · New HEAD: (see git log) · Same PR #35.

## Findings closed (mandate R4.1–R4.6)

- **R4.1 — BEGIN is itself the final immutable gate.** `beginDeliveryAttempt`
  re-loads the durable row inside the SAME `store.immediate` and re-proves,
  before minting any STARTED: (A) canonical TDR by entity key, (B) exactly one
  `TELEGRAM_DELIVERY_MINTED` receipt when bound, (C) the complete immutable
  static contract (`deliveryWholeContractValid`), (D) the slot's live
  artifact/provenance contract via `verifyArtifactForConsumption`,
  (E) the rebuilt immutable lifecycle ledger, (F) the row is an exact legal
  projection of that ledger, (G) the immutable retry ceiling, and only then
  (H) mints STARTED + SENDING atomically. Terminal SENT/UNKNOWN ledgers NEVER
  acquire again; an unresolved STARTED yields `ALREADY_CLAIMED` (acquired:false)
  or fail-closed; FAILED history permits a next attempt only below the
  immutable ceiling with valid backoff.
- **R4.2 — receipt-bound ceiling.** `deliveryEffectiveCeiling` derives the
  effective `max_attempts` from the immutable mint receipt (per-slot entry for
  FILES, request-level for TEXT) — a mutable widened `max_attempts` is both a
  contract violation and never authorizes a send.
- **R4.3 — exact STARTED→RESOLVED pairing.** `resolveDeliveryAttempt` requires,
  inside its writer transaction, exactly one UNRESOLVED `STARTED` for the slot
  whose `attempt_id` + `attempt_number` exactly equal the mutable SENDING
  identity — else `FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE` and ZERO new
  lifecycle evidence (forged `ATT_FAKE`/replayed already-resolved ids denied).
  SENT keeps the real-`message_id` requirement.
- **R4.4 — stale reconcile exact-STARTED authority.**
  `reconcileStaleDeliveryAttempts` resolves stale SENDING to UNKNOWN only when
  the static contract holds AND the exact unresolved STARTED exists
  (id+number match, not already resolved). Forged SENDING without immutable
  STARTED → the slot is quarantined to `FAILED_DELIVERY` with ZERO RESOLVED
  evidence — mutable corruption can never be laundered into immutable history.
- **R4.5 — static contract before any lifecycle evidence.** Stale
  reconciliation uses the SAME canonical request verifier as pending/begin
  (`deliveryStaticAuthority` + the pass's receipts map): a statically forged
  TDR gets ZERO attempt-evidence mutations, and `pendingTelegramDeliveries`
  additionally quarantines any bound row whose contract fails — FAILED slot,
  zero evidence, zero filesystem, zero transport.
- **R4.6 — true sequence validation.** `deliveryAttemptLedger` returns
  `{slots, valid, error}` and PROVES the per-slot sequence (not just counts):
  `attempt_number` starts at 1 and increments by exactly 1; each STARTED's
  `attempt_id` equals the deterministic `ATT_<digest(entity:slot:n)>`; at most
  one unresolved STARTED; every RESOLVED pairs its preceding open STARTED
  (exact id+number); no duplicate/unpaired RESOLVED; after terminal
  SENT/UNKNOWN no later STARTED is legal (`activity_after_terminal`).
  Malformed immutable history → `ledger.valid === false` → every seam fails
  closed and no send authority is ever derived from it.

## Canonical reusable verifier (extracted, single semantics)

`deliveryMintReceiptsAll` · `deliveryStaticAuthority` (entity identity +
receipt resolution + whole-contract verdict) · `deliveryWholeContractValid` ·
`deliveryDestinationEqual` · `deliveryArtifactAuthority`/`deliveryLiveVerify` ·
`deliverySlotBinding` · `deliveryCarriesBinding` · `deliveryEffectiveCeiling` ·
`deliverySlotLifecycleViolation` · `deliveryOpenStarted`. PENDING, BEGIN,
RESOLVE and stale reconciliation call the same helpers — no incompatible
duplicated verification.

## Atomicity (mandate)

BEGIN: verification + STARTED + SENDING projection in ONE `store.immediate`.
RESOLVE: exact-STARTED verification + RESOLVED + row projection in ONE.
Stale reconcile: static-contract + exact-STARTED verification + UNKNOWN + row
projection in ONE `store.immediate`. No check-then-write outside the writer
transaction.

## Adversarial tests added (10 — total file 52/52)

R4.A stale projection + SENT-row rollback → real begin denied, zero network,
zero STARTED #2, projection converges FAILED · R4.B exhausted retry + mutable
ceiling widened → real begin denied, zero attempt #4 · R4.C forged SENDING
(`ATT_FAKE`, n=7) → resolve SENT denied, zero RESOLVED evidence, no immutable
SENT authority · R4.D replayed already-resolved STARTED identity → second
resolve denied · R4.E forged stale SENDING without STARTED → ZERO UNKNOWN
evidence, slot quarantined · R4.F static-contract tamper (mission_id) before
stale reconciliation → ZERO RESOLVED evidence, zero network, row quarantined ·
R4.G malformed immutable history (RESOLVED without STARTED via the append-only
seam) → fail closed, no send · R4.H terminal SENT + mutable QUEUED → direct
begin denied · R4.I terminal UNKNOWN + mutable QUEUED → direct begin denied ·
R4.J clean FAILED retry → next canonical attempt permitted (control).

## Validation

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11 + R1 + R2 + R3 + R4) | 52/52 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-ops-telegram-delivery` + `pair-live-ops-recovery-closure` | 23/23 |
| `pair-f1-*` + `pair-f2-*` + `pair-f3-*` + phase-d + runtime | 417/417 |
| `rm -rf dist` → `npx tsc --noEmit` | 0 errors |
| `pnpm build` | PASS |
| **Full repository regression** | **3232 pass / 2 fail** |
| `pnpm audit --audit-level=high` | 0 high (1 low / 8 moderate) |

Only the two known env-only `pair-p5` executable-probe failures remain —
reproduced on canonical base `3e17525` (DSH/CODEX executables present in this
environment make `probe().available === true`).

## F4 R5 — transactional reconcile + budget-aware ledger closure

Audit verdict on R4 (`9cdc03c`): R4.1/R4.2/R4.3 PASS; **R4.4 BLOCKED** —
stale reconcile verified outside its writer transaction (check-then-write
race); **R4.5** logically PASS but must run inside that transaction;
**R4.6 PARTIAL** — the sequence ledger did not know the immutable mint
`max_attempts`, so an over-budget append-only history (STARTED #4 under a
ceiling of 3) was "structurally valid".

### R5.1 — one writer transaction for stale reconcile

`reconcileStaleDeliveryAttempts` re-shaped: the outer `store.list` now
yields **candidate entity ids only — never authority**. For each candidate
id, ONE `store.immediate` performs, in order: (1) canonical reload by
`entity_id`, (2) current status/state check, (3) single mint-receipt
resolution via the shared `deliveryStaticAuthority`, (4) full static
send-contract re-proof, (5) immutable ledger rebuild, (6) ledger
validation, (7) exact SENDING slot identification, (8) exact unresolved
STARTED identity proof, (9) stale-threshold re-check against the CURRENT
durable `attempt_started_at`, (10) `RESOLVED UNKNOWN` evidence append,
(11) `UNKNOWN_SIDE_EFFECT` projection write — **all or nothing**. A
competing writer landing between candidate discovery and the transaction
cannot interleave (BEGIN IMMEDIATE serializes writers): a refreshed
`attempt_started_at` is re-read in-transaction and no incorrect UNKNOWN is
minted; a fault between evidence append and row write rolls back both
(proven by tests).

### R5.2 — budget-aware immutable ledger

`deliveryAttemptLedger` accepts a per-slot immutable ceiling
(`ceilingFor`) resolved from the mint receipt via
`deliveryCeilingFromReceipt` — receipt `max_attempts` (TEXT/request) or
the per-artifact ceiling (FILES); `null` for unbound/legacy rows, which
keep legacy semantics. A STARTED whose `attempt_number` exceeds the
ceiling yields `seqError: started_over_ceiling` → **ledger INVALID**, not
merely non-sendable: every authority seam (pending, begin, resolve, stale
reconcile) fails closed on `ledger_invalid`. Since each FAILED resolve
pairs a STARTED within the ceiling, consumed failures can never exceed
it; a STARTED after FAILED-at-ceiling is illegal by the same rule.
Mutable `max_attempts` is never authority for receipt-bound rows.

### R5.3 — terminal SENT requires canonical acceptance evidence

A `RESOLVED { outcome: SENT, message_id: invalid }` can no longer
establish terminal SENT authority: inside the ledger's sequence walk a
SENT outcome requires `isValidTelegramMessageId(message_id)` (positive
safe integer) or the slot history is `sent_invalid_message_id` → invalid.
UNKNOWN/FAILED outcome semantics unchanged.

### R5.4 — corrected R4.D replay test

`R4.D` now reads the ACTUAL immutable `attempt_id`/`attempt_number` from
`ev.payload.payload` (the `listEvidence` wrapper), asserts the
deterministic `ATT_<digest(entity:slot:1)>` form, rewrites the mutable
row to SENDING replaying that exact identity, and proves: real resolve →
`FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE`, exactly one RESOLVED remains,
no second SENT authority.

### R5.5 — adversarial proofs

| Test | Proof |
|---|---|
| R5.1-race | competing writer refreshes `attempt_started_at` between candidate list and txn → row untouched, ZERO RESOLVED UNKNOWN |
| R5.1-crash | throw after `appendEvidence` inside the txn → both evidence and row write rolled back |
| R5.5A | ceiling 3 + history 1F/2F/3F/STARTED4 → `started_over_ceiling`; stale reconcile → quarantine, ZERO new evidence; direct resolve denied; direct begin denied; pending empty |
| R5.5B | ceiling 3 + history 1F/2F/3F + forged QUEUED/count3 row → begin denied, no attempt #4 authority |
| R5.5C | RESOLVED SENT with message_id 0 / "7777" / -42 → `sent_invalid_message_id`, ledger invalid, begin denied |
| R5.5D | control — 1F/2F/3SENT(valid id) → valid canonical terminal history (started=3, consumed=2, terminal SENT) |
| R5.5E | control — append-only 1F + forged QUEUED/count1 → clean canonical retry attempt #2 SENT |

## Validation

| Suite | Result |
|---|---|
| `pair-f4-delivery-provenance` (A1–A11 + R1 + R2 + R3 + R4 + R5) | 61/61 |
| `pair-output-delivery-contract` | 69/69 |
| `pair-planner-dataflow-incident` | 106/106 |
| `pair-ops-telegram-delivery` + `pair-live-ops-recovery-closure` | 23/23 |
| `pair-f1-*` + `pair-f2-*` | 297/297 |
| `pair-f3-*` + phase-d + runtime | 120/120 |
| `rm -rf dist` → `pnpm build` | PASS |
| `npx tsc --noEmit` | 0 errors |
| **Full repository regression** | **3241 pass / 2 fail** |
| `pnpm audit --audit-level=high` | 0 high (1 low / 8 moderate) |

Only the two known env-only `pair-p5` executable-probe failures remain —
reproduced on canonical base `3e17525` (DSH/CODEX executables present in
this environment make `probe().available === true`).

## Remaining limitations

- Legacy (pre-F4, no receipt + no binding fields) rows keep the hash-only
  path and no immutable ceiling check until a begin creates their first
  STARTED — from then on the ledger rules apply to them too.
- `deliveryAttemptLedger` validates per-slot sequences; cross-slot shared
  attempt numbering is not modeled (slots are independent by design).
- `opts.receipts` on `reconcileStaleDeliveryAttempts` is an immutable
  append-only hint shared from the pending pass (mint receipts are
  write-once); per-candidate checks still re-run inside the writer
  transaction.

Classification:
`PAIR_NEXT_PHASE_F4_TRANSACTIONAL_LIFECYCLE_R5_PENDING_AUDIT`
