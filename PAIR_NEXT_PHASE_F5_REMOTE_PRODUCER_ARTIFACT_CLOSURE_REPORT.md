# PAIR NEXT — PHASE F5 REPORT

## REMOTE PRODUCER CANONICAL ARTIFACT CLOSURE

**Canonical base:** `c7a6575c87e63258894c7555348d75d5f7faa8a6` (main after #35 merge)
**Branch:** `devin/17591791034026-phase-f5-remote-producer-closure`
**PR:** one new PR — **DO NOT MERGE**

Classification: `PAIR_NEXT_PHASE_F5_REMOTE_PRODUCER_ARTIFACT_CLOSURE_PENDING_AUDIT`

---

## 1. Root cause (in code)

Live incident `MSN_01M40Y86RN9G` (Oct-3, post-F4): plan T2
(REMOTE_CLOUD_TASK_EXECUTION → DEVIN) declared
`metadata.pair_dataflow.produces = ["data.json"]`; the DEVIN execution
COMPLETED with `artifacts: []`, **no canonical ART row existed**, and the
execution validation still PASSed. Downstream T3 declared
`consumes:["data.json"]` → `ArtifactDependencyResolver` correctly threw
`PRODUCER_CANONICAL_ARTIFACT_MISSING` → bounded DEPENDENCY_FAILURE → one
REPLAN (identical shape) → ABORT. F2/F3/F4 behaved exactly as designed —
the defect was upstream: **declared remote produces were never closed
against the canonical F1 remote-ingest lane**.

Three missing closures:

1. **Contract** — `requestFor` built `expected_output_contract` from the
   task's own copy of `expected_output_contract` (worker_spec etc.) and
   never pinned the declared produces set. Nothing digest-bound "what
   this remote execution owes" into governed authority.
2. **Instruction** — `DevinExecutorAdapter.buildPrompt` only emitted the
   `/api/outbox` + `x-artifact-capability` upload recipe for
   operator-facing file *deliverables*. Plan-level `produces` artifacts
   (intermediate data files) were never enumerated, so a compliant remote
   worker returned `artifacts:[]` and settled cleanly.
3. **Terminal gate** — `ArtifactProvenanceValidator.validate_execution`
   verified submitted artifacts for integrity but never required the
   declared set to exist. A remote execution could reach PASS with zero
   declared produce uploaded.

Net effect: remote producer → consumer edges were structurally
declarable but operationally impossible for DEVIN — the only executor
that can actually produce remote bytes had no obligation, no
instruction, and no verification to put those bytes on the canonical
lane.

## 2. Design — where each authority lives

`pair_dataflow.produces` remains the sole plan authority (F3). F5 adds a
**pinned dispatch-time projection** of it into governed execution
authority — never a second dataflow source.

### F5.1 — `expected_output_contract.declared_produces` (pin at request build)

`MissionRuntime.requestFor` → `expectedOutputContractFor(task, tmd)`:

- Non-remote tasks: contract unchanged (byte-identical to pre-F5).
- Remote-capability tasks (`isRemoteCapabilityTask`):
  `normalizeDeclaredProduces(df.produces, task)` — trim, dedupe, sort,
  bound `≤ MAX_ARTIFACTS_PER_EXECUTION` (32). Malformed values throw
  `FAIL_CLOSED_DECLARED_PRODUCES_INVALID`; over-bound throws
  `FAIL_CLOSED_DECLARED_PRODUCES_BOUNDS`. Both are
  `DependencyResolutionError`s → bounded DEPENDENCY_FAILURE, producer
  identified.
- The result is always present on the remote contract — including
  `declared_produces: []` — so "no produces declared" is itself pinned,
  not implied.
- Digest coverage is inherited: `expected_output_contract` is already a
  field of the governed-request scope object (`gate.ts:383`) hashed into
  `approval_scope_digest`. Pinning happens inside `requestFor`, before
  the scope digest is computed → any post-dispatch mutation of
  `pair_dataflow.produces`, `expected_output_contract.declared_produces`,
  or the governed row diverges the recomputed scope digest and fails
  closed (test J/J2).

### F5.5 — structural ingest-lane feasibility (before remote spend)

Same seam (`expectedOutputContractFor`): a remote task with non-empty
`declared_produces` requires `remoteIngestLaneAvailable()` —
`PAIR_OUTBOX_URL` configured AND an artifact-upload master resolvable
(`artifactConsumeCapabilityMasterFromEnv`: `PAIR_ARTIFACT_UPLOAD_TOKEN ||
PAIR_BROKER_TOKEN`). Missing → `DependencyResolutionError`
`FAIL_CLOSED_REMOTE_INGEST_LANE_UNAVAILABLE` with
`dependency_reason=REMOTE_PRODUCER_ARTIFACT_MISSING` → zero dispatch,
zero remote spend.

Placement rationale (documenting where the authority belongs, per
mandate): executor selection is post-commit in this runtime — the plan
cannot know the actual executor at commitPlan without breaking the
governance/routing separation F3 established. The sound pre-spend
equivalent is therefore at **governed request construction**, the last
PAⅠR-owned boundary before an executor is dispatched. The check is
structural only: it does not probe remote health and does not require
the artifact to exist — it proves the lane *capability* exists in this
deployment (a remote producer whose declared outputs can never become
canonical is infeasible by construction). A task declaring no produces
dispatches unaffected (test L2).

### F5.2 — Devin prompt mandatory-upload enumeration

`DevinExecutorAdapter.buildPrompt`: when the governed task's
`expected_output_contract.declared_produces` is non-empty, the prompt
emits, immediately after the existing artifact-lane recipe:

```
Required canonical produced artifacts (MANDATORY — this governed task
declared each of them; upload EVERY one through the artifact lane above
using the EXACT declared name as "filename", BEFORE emitting
PAIR_EXECUTION_COMPLETE):
- data.json
- report.md
A file existing only in your remote workspace does NOT satisfy a
declared artifact; failing to upload every declared artifact means the
task is NOT complete.
```

- Uses only the existing F1 lane: `POST /api/outbox` +
  `x-artifact-capability: acap1.<scoped>` minted per-execution. No
  second upload mechanism; no master secret in the prompt.
- Defense-in-depth dispatch guard: if the lane is unavailable at
  prompt-build time the adapter throws
  `FAIL_CLOSED_REMOTE_INGEST_LANE_UNAVAILABLE` (IntegrityError) rather
  than spend a remote session on a task that can never settle.
- Remote task with empty `declared_produces` → prompt byte-identical to
  pre-F5 (test Q3).

### F5.3 — terminal produces-closure gate (before PASS)

`ArtifactProvenanceValidator.validate_execution`, inside the existing
PASS computation — after artifact verification, before the row is
written:

- Only when the governed row's
  `expected_output_contract.declared_produces` is an **Array** (rows
  without the field — pre-F5 historical executions — are untouched).
- Recompute the full gate scope object `{mission_id, task_id,
  executor_id, workspace, allowed_paths, permissions,
  expected_output_contract, dependency_artifacts_digest}` and compare to
  the stored `approval_scope_digest`. Mismatch →
  `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract` → FAIL.
  This is the F5.6 pin-enforcement: a `produces:["data.json"]→[]`
  mutation after dispatch can never silently PASS.
- Otherwise, exact declared-produce closure: for each declared logical
  name, exactly one accepted artifact row for **this execution**
  (`execution_id`-bound) that independently re-verifies via the existing
  ArtifactAuthority integrity path. Missing or ambiguous →
  `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:<name>` per missing name →
  FAIL. Subset closure — extra accepted artifacts do not fail the gate.
- On failure the validation row carries `remote_produces_missing`
  (missing logical names) + `declared_produces_digest`, and the
  RESULT_VALIDATION evidence adds `mission_id, task_id,
  governed_task_id, execution_id, remote_produces_missing,
  declared_produces_digest`. No paths, no secrets, no remote prose —
  bounded evidence only.

### F5.4 — producer failure classification

`settleExecution` FAIL branch: when the validation row carries
`remote_produces_missing`, recovery starts as **DEPENDENCY_FAILURE** on
the **producer** task itself:
`dependency_reason=REMOTE_PRODUCER_ARTIFACT_MISSING`,
`producer_task_id=task_id`, `consumer_task_id=task_id`,
`artifact_name=<missing names>`,
`source_code=FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE` — the same typed,
bounded recovery path a missing prerequisite artifact already takes
(F3), never an unclassified exception, no retry loops (test R1: consumer
never dispatched, producer identified).

### F5.6 — digest authority

`canonicalPlanSemanticDigest` already covers `pair_dataflow.produces`
(F3 — covered fields include produces/consumes per task). F5 adds the
execution-side pin: the produces contract lives inside
`approval_scope_digest` from dispatch onward; test J2 mutates
`metadata.pair_dataflow.produces` post-dispatch and the scope recompute
catches it.

## 3. Files changed

- `src/pair/mission-runtime.ts` — `expectedOutputContractFor` (pin +
  lane gate), `normalizeDeclaredProduces` + `remoteIngestLaneAvailable`
  (module helpers), settleExecution F5.4 classification, imports.
- `src/pair/artifact-validation.ts` — produces-closure gate + scope-
  mutation guard + bounded evidence fields.
- `src/pair/devin-executor.ts` — mandatory-upload enumeration + dispatch
  lane guard.
- `src/__tests__/pair-f5-remote-producer-closure.test.ts` — **new**,
  28 tests.
- `src/__tests__/pair-f2-r1-remediation.test.ts` — G-section
  `startServer` declares the lane env (`PAIR_OUTBOX_URL` +
  `PAIR_ARTIFACT_UPLOAD_TOKEN`) for the spawned test server —
  deployment-faithful; restored on close.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` — R2 §16 remote-
  upload test declares the same lane env (it drives
  `acceptArtifactUpload` directly; restored in `finally`).

## 4. Failure codes introduced

| code | seam | class |
|---|---|---|
| `FAIL_CLOSED_DECLARED_PRODUCES_INVALID` | requestFor normalize | DependencyResolutionError → DEPENDENCY_FAILURE |
| `FAIL_CLOSED_DECLARED_PRODUCES_BOUNDS` | requestFor normalize (>32) | same |
| `FAIL_CLOSED_REMOTE_INGEST_LANE_UNAVAILABLE` | requestFor lane gate; buildPrompt dispatch guard | DEPENDENCY_FAILURE / IntegrityError |
| `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract` | terminal validation | validation FAIL |
| `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:<name>` | terminal validation | validation FAIL → DEPENDENCY_FAILURE `REMOTE_PRODUCER_ARTIFACT_MISSING` on producer |

## 5. Tests — `pair-f5-remote-producer-closure.test.ts` (28/28)

Mandate letters → tests:

- **P1** pin: remote governed contract carries normalized
  `declared_produces`, scope digest covers it. **P2** empty set still
  pinned; local contracts untouched.
- **U1** normalize matrix (sort/dedupe/trim/invalid/bounds). **U2** lane
  env matrix (both URL+master required).
- **L1** lane-missing remote producer → DEPENDENCY_FAILURE, zero
  dispatch, zero spend. **L2** remote task with no produces dispatches
  normally.
- **Q1** prompt enumerates exact declared names + mandatory framing.
  **Q2** adapter throws when lane absent. **Q3** no-produces prompt
  unchanged.
- **A** empty produces + no artifacts → PASS. **B** declared + uploaded →
  PASS, validation row binds artifact_id.
- **C** declared, nothing uploaded → FAIL
  `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE`, evidence carries
  missing+digest+ids. **D** two declared, one uploaded → FAIL names only
  the missing one.
- **E** same filename uploaded by a *different* execution → does not
  satisfy. **F** shared-outbox file only → does not satisfy. **G** remote
  workspace existence only → does not satisfy. **H** foreign-task /
  foreign-execution artifact in same mission → does not satisfy.
- **I** accepted row failing F1 integrity re-verify → does not satisfy.
- **J** post-dispatch `declared_produces` mutation → scope-digest
  mismatch → FAIL closed. **J2** post-dispatch `pair_dataflow.produces`
  mutation → same.
- **M** duplicate identical upload → F1 idempotent replay, same
  artifact_id, PASS. **N** same name different bytes →
  `FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT`, first identity still PASSes.
- **K** restart after upload, pre-settlement → fresh runtime converges
  PASS, no duplicate ART. **L (restart)** completion persisted but
  produce never uploaded → no fabricated PASS on re-validation.
- **O** remote producer → local consumer pins exact artifact_id + bytes.
  **Q** remote → remote consume handoff (acread1) intact.
- **R1** settleExecution → DEPENDENCY_FAILURE typed on the **producer**
  task; consumer never dispatched.
- **E2E** full lane: remote uploads → PASS binds artifact_id → consumer
  `dependency_artifacts` pins the exact artifact identity.

## 6. Validation results

| gate | result |
|---|---|
| F5 focused | **28/28** |
| F1 suite | 20/20 |
| F2 suites (all) | 183 + 43 green |
| F3 suites | green |
| F4 suite | 61/61 |
| incident (dataflow) | 106/106 |
| runtime-hardening | 11/11 |
| ops + live-ops | 23/23 |
| `rm -rf dist` + `npx tsc --noEmit` | 0 errors |
| `pnpm build` | PASS |
| **full suite** | **3268 pass / 3 fail** — 2 = known env-only P5 (tests 2&3, executables present in this env; unchanged from `c7a6575`); 1 = `pair-p11-r2` §G worker_threads contention flake — passes standalone (20/20), unrelated to F5 (scheduler occurrence rows) |
| `pnpm audit --audit-level=high` | 0 high (1 low + 8 moderate — unchanged) |

## 7. Live reproduction (scratch stack, `PAIR_MC_DIR=/home/ubuntu/pair-f5-scratch`)

Mission `MSN_01M410PK2CPSHNNDB7PM85TTRR` — planner (badq) emitted the
exact incident shape:

```
T1 PAIR_NATIVE  produces:[mission_goal.txt]
T2 REMOTE_DEVIN produces:[data.json]                     ← incident task
T3 local        consumes:[data.json] produces:[gold_report.md]
T4 TELEGRAM     consumes:[gold_report.md]
```

- T2 governed contract: `expected_output_contract.declared_produces =
  ["data.json"]` — pinned, digest-covered. **F5.1 ✓**
- Devin session `devin-d4d5f8b97ab246158bfe9b0713d41824` prompt contains
  the mandatory enumeration block naming `data.json`, instructing upload
  via the execution-scoped `acap1` capability **before**
  `PAIR_EXECUTION_COMPLETE`. **F5.2 ✓** (verified against the actual
  session messages, not a mock)
- Devin uploaded `data.json` through `/api/outbox` → canonical
  `ART_4FF8194CD2F7D5D0B07B4ED453EA3F20` (sha256
  `57eea59b0ea6…`, 1241 bytes, execution-scoped). **ARTIFACT_ACCEPTED ✓**
- T2 execution_validation **PASS** binds
  `artifact_ids:["ART_4FF8194CD2F7D5D0B07B4ED453EA3F20"]` +
  `declared_produces_digest:d34a337a…`. **F5.3 ✓ — PASS contains
  artifact_id**
- T3 `dependency_artifacts` pins
  `{artifact_id:ART_4FF8…, logical_name:"data.json",
  producer_execution_id:EXE_e46183e9…}` — resolver pinned the exact
  artifact of the exact execution. **O ✓ live**
- T4 `TDR_6bacdac15e8dfa89ce665db3` **SENT** to chat `1882810918`
  (CONFIGURED_DEFAULT) — F4 provenance chain intact end-to-end.
  **R ✓ live**
- Mission terminal state: **COMPLETED** — the incident shape that
  aborted pre-F5 now closes.

## 8. Remaining risks / limitations

- **Prompt compliance is advisory, the gate is authoritative.** A remote
  worker that ignores the mandatory block simply fails F5.3 — no false
  PASS, but the remote spend happened. F5.5 only proves the lane exists,
  not that the worker will use it.
- **Remote→remote produces chains** work (Q tested via acread1 handoff),
  but multi-hop remote fan-out on a single execution is bounded by
  MAX_ARTIFACTS_PER_EXECUTION (32).
- **Legacy governed rows** without `declared_produces` skip the gate
  entirely (array-check) — intended backward compat; new remote
  executions always pin the field, including the empty set.
- **The lane availability check is structural**: `PAIR_OUTBOX_URL` +
  master resolvable at request time. A tunnel that dies *after* dispatch
  fails at upload time inside the remote session → F5.3 gate catches the
  incomplete closure.
- Planner quality unchanged: the scratch repro needed retries because
  badq (weak planner route) intermittently emits unsound plans —
  F3 feasibility drops them; orthogonal to F5.

## 9. Stop state

PR pushed, **NOT merged**. Awaiting audit.
`PAIR_NEXT_PHASE_F5_REMOTE_PRODUCER_ARTIFACT_CLOSURE_PENDING_AUDIT`

---

# Phase F5 R1 — IMMUTABLE MINT-TIME ANCHOR AUTHORITY

Prev audited HEAD: `885b7e0b185dea6d9758a4825874bed444319ade` (PR #36, same branch — DO NOT MERGE)

## R1.A — defect closed

The F5.3 gate decided whether the remote-produces contract applied from
the CURRENT presence/type of the mutable
`governed.expected_output_contract.declared_produces` field, and
compared a recomputed scope against the mutable row's own
`approval_scope_digest`. A post-dispatch delete/null/narrow of that
field — with the row digest recomputed self-consistently — silently
downgraded an F5-minted remote execution back to legacy semantics. The
decision of "is this execution F5-bound" now comes only from immutable
mint-time provenance.

## R1.B — the immutable anchor chosen

The EXISTING `GOVERNED_TASK_VALIDATED` mint anchor is extended (no
second competing authority) — both the `store.event` metadata and the
`appendEvidence` body at governed-task mint (gate.ts) now immutably
bind:

| field | source |
|---|---|
| `governed_task_id` / `mission_id` / `task_id` / `executor_id` | identity correspondence |
| `plan_id` / `plan_revision` | active plan at mint |
| `approval_scope_digest` | the complete scope digest minted BEFORE the row is mutable |
| `remote_produces_contract` | `isRemoteCapabilityTask(task)` at mint — the F5 applicability bit |
| `declared_produces` | the exact normalized pinned set (null for non-remote) |
| `declared_produces_digest` | `digest(declared_produces)` — explicit set binding |

The anchor's `approval_scope_digest` is the high-water authority — the
scope it covers includes `expected_output_contract` (and therefore
`declared_produces`), so ANY coherent rewrite of the mutable row's own
digest still mismatches the immutable mint value.

## Terminal validation order (artifact-validation.ts)

For a remote-capable execution, before artifact closure:

1. `store.listEvents("governed_task", gtid)` filtered to
   `GOVERNED_TASK_VALIDATED` must yield **exactly one** anchor →
   `FAIL_CLOSED_GOVERNED_MINT_ANCHOR:MISSING` / `:AMBIGUOUS`.
2. Identity correspondence: anchor `task_id` / `executor_id` /
   `mission_id` must equal the governed row →
   `FAIL_CLOSED_GOVERNED_MINT_ANCHOR:IDENTITY` (the `entity_id`
   binding is already proven by the query).
3. `remote_produces_contract === true` binds the F5 contract forever:
   - current `declared_produces` must be an Array →
     `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces`;
   - recomputed current scope must digest-equal the ANCHOR's
     `approval_scope_digest` →
     `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract`;
   - current set must digest-equal `declared_produces_digest` →
     `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces_digest`;
   - only then the existing exact-one-identity-per-name closure runs.
4. An anchor minted pre-F5 (the marker field absent) preserves the
   documented legacy semantics — **legacy classification derives only
   from immutable provenance**, never from field absence on the
   mutable row (R1.C).

Non-remote executions keep prior semantics entirely; a planner-supplied
`declared_produces` on a LOCAL task cannot mint F5 authority
(`remote_produces_contract` is false in its anchor — the marker is
decided at mint, not by field content).

## R1.D — adversarial tests (14 new, suite now 42)

| # | attack | result |
|---|---|---|
| R1-1 | `declared_produces` deleted post-dispatch | FAIL `declared_produces` |
| R1-2 | set to `null` | FAIL `declared_produces` |
| R1-3 | reshaped to string/object | FAIL (both) |
| R1-4 | narrowed `→[]` + row digest recomputed self-consistently | FAIL vs anchor |
| R1-5 | `[a,b]→[a]` + recompute | FAIL |
| R1-6 | widened + recompute | FAIL |
| R1-7 | BOTH `approval_scope_digest` + `governance_digest` rewritten coherently | FAIL |
| R1-8 | anchor row deleted | FAIL `MINT_ANCHOR:MISSING` — never legacy |
| R1-9 | second conflicting anchor minted | FAIL `MINT_ANCHOR:AMBIGUOUS` |
| R1-10 | forged single anchor with foreign task/executor ids | FAIL `MINT_ANCHOR:IDENTITY` |
| R1-11 | fresh-reopen: intact anchor + artifact | PASS once |
| R1-12 | fresh-reopen: mutated row + intact anchor | same FAIL |
| R1-13 | genuine remote `declared_produces:[]` from mint | PASS |
| R1-14 | local task + planner-supplied `declared_produces` | PASS — legacy semantics, no F5 authority minted |

Harness change: hand-built remote producers in the F5/F2 test files now
emit the mint anchor exactly as the gate does (event + evidence +
pinned contract + scope digest) — the same shape production mints
today.

## Validation

- F5 suite: **42/42**
- F2 chain (r1/r2/r3 + handoff): all green after harness anchor mirror
- F1 20 · F3 20+closures · F4 61 · incident 106 · p9/p10/p12/p13 +
  llm-planner + output-delivery 351
- `tsc --noEmit` 0 · `pnpm build` PASS · `pnpm audit --audit-level=high` 0
- Full suite + `rm -rf dist` race: see §final counts below

## Residual risks (R1)

- A remote execution minted WITHOUT any anchor (pre-anchor-history or a
  bypassed gate) can never validate — intended fail-closed; anchor
  emission lives inside the same mint transaction path as the governed
  row.
- Anchor metadata is secret-free by `PairEvidenceStore.assertSecretFree`
  (enforced at event write).
- `remote_produces_contract` decided by task capabilities at mint — a
  task whose capabilities were rewritten post-mint does not re-classify;
  the anchor is authoritative by design.

## Stop state (R1)

PR #36 pushed, **NOT merged**. Awaiting audit.
`PAIR_NEXT_PHASE_F5_R1_MINT_ANCHOR_AUTHORITY_PENDING_AUDIT`
