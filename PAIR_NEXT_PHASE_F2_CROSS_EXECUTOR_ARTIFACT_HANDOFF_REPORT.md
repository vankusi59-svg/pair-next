# PAIR NEXT — PHASE F2 — CROSS-EXECUTOR CANONICAL ARTIFACT HANDOFF — REPORT

Classification: `PAIR_NEXT_PHASE_F2_CROSS_EXECUTOR_ARTIFACT_HANDOFF_PENDING_SOURCE_REVIEW`

| | |
|---|---|
| Canonical base SHA | `b903cb473b0ccff37cee93ad7062f274bf90dfb8` (PR #31 merge commit — F1 R1–R7 merged) |
| Branch | `devin/1790999231-phase-f2-artifact-handoff` |
| New HEAD | `21914ac4fafd4cf2ac6394a8e0968fe46a5f1b00` |
| PR | (single new PR — created with this report) |
| Scope | F2 ONLY. No F3. No P15. No merge. |

---

## 1. What F2 closes

F1 (merged via PR #31) made artifact authority canonical: one `ArtifactAuthority`,
immutable `pair-artifact.v1` rows, retained CAS bytes verified at terminal
validation. But a downstream task in another governed execution — and especially
on another executor — had no governed way to receive those canonical bytes.
Legacy semantics trusted producer workspace paths, which a remote executor can
never read.

F2 adds the handoff half of the contract:

- `dependency_artifacts` — the exact, immutable pin resolved BEFORE dispatch and
  stamped into the consumer's governed authority.
- ONE `ArtifactDependencyResolver` — resolves declared data-flow consume edges to
  canonical artifacts through producer terminal validation.
- ONE `ArtifactHandoffService` — durable `artifact_handoff` pins, governed local
  materialization, remote-fetch authorization.
- `acread1` — a separate consume capability (distinct HMAC domain from `acap1`)
  authorizing exactly the pinned set for exactly one live execution.
- `POST /api/artifacts/fetch` — remote byte fetch: capability + durable identity +
  lifecycle + pinned membership + F1 retained-byte verification NOW.
- Remote DAG-leaf narrowing: a remote producer may now have a downstream consumer
  ONLY through a resolved governed artifact edge (undeclared edges still fail
  closed — same restriction, narrowed, not deleted).

All F1 invariants stand: every byte that reaches a consumer was previously
accepted through `ArtifactAuthority.accept*`, is verified AGAIN at consumption
time, and is never recomputed from a file the producer claims.

## 2. The `dependency_artifacts` contract (`pair-artifact-dependency.v1`)

Each entry (exactly these fields, validated by `validateDependencyArtifactEntry`):

```
contract:                "pair-artifact-dependency.v1"
artifact_id              canonical ART id (ART_<digest> deterministic)
producer_task_id         durable task row that produced it
producer_governed_task_id
producer_execution_id    the exact execution whose PASS covers it
producer_executor_id
logical_name             normalized artifact name (never a path)
sha256                   64-hex, equals ART row sha256
byte_size                equals ART row byte_size
consumer_relative_path   deterministic: .pair/dependency-artifacts/<ART>/<logical_name>
```

The dependency SET has its own digest
(`artifactDependencySetDigest` → `pair-artifact-dependency-set.v1`) which is
bound into every `acread1` consume capability.

## 3. Resolution (single seam)

`ArtifactDependencyResolver.resolveForConsumer({mission, task})`:

1. Delivery tasks skip (`TELEGRAM_DELIVERY` channel is separate authority).
2. Consume names come from `metadata.pair_dataflow` — the SAME planner/dataflow
   semantics F1 uses (`extractTaskDataflow`, PAIR-stamped at reconcile). No
   second planner contract was invented.
3. Producer predecessors = tasks in the SAME committed plan
   (`task.plan_id`, governed by `mission.plan_revision` for execution filtering)
   whose task_key/task_id appears in `depends_on` and whose produces ∩ consumes
   is non-empty.
4. Zero producers for a declared consume → `FAIL_CLOSED_DEPENDENCY_RESOLUTION`
   (`unbound_consume`). More than one → ambiguous → fail closed.
5. Per producer: latest COMPLETED execution (deterministic ordering), latest
   `execution_validation` PASS; candidate ARTs = PASS `artifact_ids` ∩
   `logical_name`. Every candidate must have real `ARTIFACT_ACCEPTED` history for
   that execution (injected rows and forged PASS rows never qualify), then pass
   `ArtifactAuthority.verifyArtifactForConsumption` NOW (shape + storage +
   retained CAS bytes). Zero → skip; >1 → ambiguous → fail closed.
6. Remote producers are held to the same bar — a remote task with no canonical
   artifact produces `remote_producer_artifact_missing` → FAIL CLOSED (legacy
   path edges are never consumable). Local producers without canonical ART keep
   legacy semantics (path edge stays outside the contract).
7. Count cap: 32 dependency artifacts/task; aggregate byte cap: 256 MiB
   (documented bounds — §35).

Resolution failures throw `DependencyResolutionError`
(`FAIL_CLOSED_DEPENDENCY_RESOLUTION` / `FAIL_CLOSED_ARTIFACT_HANDOFF_*`) which
mission-runtime converts to `DEPENDENCY_FAILURE` recovery — zero dispatch, zero
executor spend (§18).

## 4. Governance pinning (§8)

- `Gate.create_governed_task` validates the request's `dependency_artifacts`
  array (≤32 entries, contract-shaped), stamps it on the governed row — inside
  the row literal the governance digest covers — and immediately pins a durable
  `artifact_handoff` row per entry via `pinForGovernedTask` (idempotent).
- `artifact_handoff` (`HOFF_<digest>`): deterministic id from
  `consumer_governed_task_id | artifact_id | consumer_relative_path`. Fields pin
  the full entry identity + mission/task/governed/executor triple and mode
  (`LOCAL_MATERIALIZATION` for local-executor tasks, `REMOTE_FETCH` for remote).
  Events: `ARTIFACT_HANDOFF_PINNED|MATERIALIZED|FETCHED|REJECTED`.
- Equivalent post-governance authority: `assertContractUnmutated(governed)` runs
  at the top of `dispatch_governed_task` — entries↔pins must match in both
  directions, field-by-field. Zero pins + non-empty contract →
  `unpinned_contract`; count mismatch → `pin_count`; any field mutated →
  `FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT`. A task whose pin was tampered after
  governance is simply not dispatch-authorized (§8, K-tests: 0 adapter calls).

## 5. Local materialization (§9–§10)

`ArtifactHandoffService.materializeForConsumer(governed)` — called inside
`dispatch_governed_task` BEFORE `cost.assertAndReserve` and before
`adapter.dispatch` (provable ordering: C3 test reads bytes inside the dispatch
spy — materialization precedes external spend by construction):

- Validates each entry, requires its PINNED/MATERIALIZED handoff.
- Destination: `<workspace>/.pair/dependency-artifacts/<ART>/<logical_name>` —
  must resolve inside workspace AND inside `allowed_paths`.
- Existing destination: symlink or non-regular → FAIL; identical bytes →
  converge (MATERIALIZED, no rewrite); different bytes → FAIL (§10).
- Write: mkdir + tmp in-dest + fsync file + atomic rename + dir fsync
  (documented-code fallbacks only) + post-write `secureReadContained`
  (O_NOFOLLOW → realpath containment → fstat both ends) + sha/size re-prove.
- F1 re-verification happens via `readForConsumption` — the authoritative CAS
  read — never from the producer's workspace path.

## 6. Remote fetch (§12–§16)

- `acread1` (`artifact-consume-capability.ts`): claims bind mission_id,
  task_id, governed_task_id, execution_id, executor_id,
  `dependency_set_digest`, issued_at. Same master env as `acap1`
  (`PAIR_ARTIFACT_UPLOAD_TOKEN || PAIR_BROKER_TOKEN`), different HMAC domain —
  an `acap1` token never verifies on this lane.
- Route `POST /api/artifacts/fetch` (header `x-artifact-consume-capability`,
  body `{artifact_id}`) sits on an auth-exempt lane — the capability IS the
  auth. Response is `application/octet-stream` with `x-artifact-id`,
  `x-artifact-sha256`, `x-artifact-byte-size`, `x-artifact-logical-name`
  headers. No paths, no listing, no host filesystem exposure (H8).
- `authorizeConsumeFetch` ordering: exec exists → durable identity (every claim
  vs exec + governed) → terminal/result → `consumer_closed` → dep-set digest →
  pinned membership → handoff PINNED/FETCHED + `REMOTE_FETCH` mode → F1
  retained-byte verification NOW → byte-identity check → first fetch marks
  FETCHED (idempotent re-fetch while live returns the same pinned bytes).
- Prompts: remote adapters receive a `DEPENDENCY ARTIFACTS` block (logical
  name, sha256, byte_size, remote-relative target, fetch command with acread1) —
  never the master, never CAS/local paths (devin-executor + acp-executor shared
  block; §16).

## 7. Remote DAG-leaf narrowing (§20) — the exact relaxation diff

Before F2: `extractTaskDataflow` early-returned empty dataflow for remote tasks,
and any `depends_on` on a remote task triggered `DROP_REMOTE_DEPENDENT`
(sanitize) — remote tasks could only be leaves.

Now (the complete diff):

- `extractTaskDataflow` no longer early-returns for remote tasks — they carry
  produces/consumes names like any other task.
- `requiredEdges` adds the narrowing rule: a non-delivery task whose
  `depends_on` names a remote task MUST bind that dep through a resolved
  consume edge (`out[i].some(r => r.producerIndex === j)`); otherwise
  `FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE`.
- `sanitizePlan` mirrors it: a dependent is dropped (`DROP_REMOTE_DEPENDENT`)
  only when SOME remote dep lacks a consume∩produces edge — a remote dep fully
  bound by declared artifact edges is kept.
- Control preserved: remote dep without a declared edge still fails closed
  (M2/M3 tests); undeclared consumption is unchanged.

## 8. Production files changed

| File | Change |
|---|---|
| `src/pair/artifact-handoff.ts` | NEW — contract + resolver + handoff service + entry validation (~940L) |
| `src/pair/artifact-consume-capability.ts` | NEW — `acread1` mint/verify + dep-set digest |
| `src/pair/artifact-authority.ts` | `verifyArtifactForConsumption`, `readForConsumption`, `verifyCanonicalRowShape` extraction |
| `src/pair/service.ts` | `artifactResolver` + `artifactHandoffs` lazy getters |
| `src/pair/gate.ts` | `dependency_artifacts` on governed row + pin at create; `assertContractUnmutated` + `materializeForConsumer` before reserve/dispatch |
| `src/pair/mission-runtime.ts` | `requestFor` resolves dependency_artifacts; `DependencyResolutionError` → `DEPENDENCY_FAILURE`; `prerequisiteMissing` honors resolved names + remote tasks |
| `src/pair/mission-control.ts` | `fetchArtifactForConsumption` |
| `src/pair/mission-control-server.ts` | `POST /api/artifacts/fetch` lane + octet-stream response + error map |
| `src/pair/devin-executor.ts` | acread1 fetch section in governed prompt |
| `src/pair/acp-executor.ts` | DEPENDENCY ARTIFACTS prompt block (shared ACP/codex/dsh) |
| `src/pair/plan-dataflow.ts` | remote-task dataflow + `UNGOVERNED_REMOTE_EDGE` rule |
| `src/pair/llm-planner.ts` | sanitizePlan narrows DROP_REMOTE_DEPENDENT via declared edges |
| `src/pair/index.ts` | exports |

Test file: `src/__tests__/pair-f2-artifact-handoff.test.ts` (53 tests, A–N).

## 9. What was NOT done

- F3 (replan digest-awareness), P15 — untouched.
- No merge; user merges after audit PASS.
- `dependency_outputs` (runtime task-output channel) is untouched —
  `dependency_artifacts` is a separate canonical contract (§17).
- No second planner contract; no re-baselining; no F1 weakening.

## 10. Evidence / gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (0 errors) |
| `rm -rf dist` → F2 suite + F1 remediation file incl. true READY+GO multi-process races | PASS — 53 + 95 (G1–G4 races pass on CURRENT SOURCE, no dist) |
| Focused: F1 authority (20) + dataflow incident (106) + llm-planner (16) + output-delivery (69) | PASS — 211 |
| `pnpm build` | PASS |
| `pnpm audit --audit-level=high` | PASS — 0 high |
| Full suite (`pnpm test`)  on FINAL HEAD 21914ac4fafd4cf2ac6394a8e0968fe46a5f1b00 | `21914ac4fafd4cf2ac6394a8e0968fe46a5f1b00` |
| Cross-executor matrix L→L / R→L / L→R / R→R | PASS — I1–I4 |
| DAG narrowing accept vs control-reject | PASS — M1–M3 |

Remaining technical debt (unchanged): the two env-only P5
`stockProbe.available` failures (reproduce on canonical base
`b903cb4`); remote fetch end-to-end is proven through the production control
seam (`fetchArtifactForConsumption`) — the HTTP route wrapper is a thin map
verified by route-level coverage elsewhere.

---

# R1 REMEDIATION ROUND (source-review re-audit)

HEAD after R1: appended commit on the same PR #32.

## R1.1 — consumption consumes F1 history authority

`verifyForExecution` and consumption now share ONE seam,
`verifyAcceptedArtifact(artifactId, execution)` — immutable
`ARTIFACT_ACCEPTED` facts ↔ current row ↔ producer durable identity ↔
storage contract ↔ retained CAS bytes re-verified NOW. A row coherently
rewritten to different (still CAS-valid) bytes fails on `sha256`/`byte_size`
history; a row without acceptance history fails `no_acceptance_history`.
`verifyArtifactForConsumption` + `readForConsumption` take an EXPECTED
producer binding (execution/task/governed/executor/sha256/byte_size/
logical_name) from the already-pinned contract — the mutable row is never
consulted for what to trust. Restart preserves the binding (durable events).

## R1.2 — RESULT_VALIDATED anchor required for PASS

`ArtifactDependencyResolver` no longer accepts merely a terminal-looking
validation row: PASS requires a durable `RESULT_VALIDATED` event on the
`executor_execution` entity whose `correlation_id` matches and whose
`metadata.validation_id` equals the durable validation row id. Missing
event / wrong validation_id / wrong correlation / foreign-scope event →
`not_consumable` → `FAIL_CLOSED_DEPENDENCY_RESOLUTION`.

## R1.3 — parent-component containment + verify-pin-before-write

`materializeForConsumer` resolves the pinned destination's parent via
realpath and requires containment inside the dependency root BEFORE any
byte lands (a swapped parent symlink redirects zero bytes), then
re-verifies the pin contract (sha256 + byte_size against the authority)
before the write — bytes that fail the pin write zero bytes. Converge /
different-bytes preservation unchanged; the materialized file is
re-hashed and byte-counted after rename.

## R1.4 — immutable handoff binding + approval scope

The governed task row now carries `dependency_artifacts_digest`
(sha256 over the canonical dep-set projection) and
`GOVERNED_TASK_VALIDATED` events record it; `recordApproval` binds the
approval scope to that digest — an approval granted for dep-set A does
NOT authorize dep-set B. Handoff entities use the canonical
`handoff_binding_digest` (artifact + pin + consumer identity) as their
deterministic id, so a tampered pin is a different binding, not the same
row mutated.

## R1.5 — one canonical consume-master resolution

`/api/artifacts/fetch` resolves the consume authority through ONE seam:
`x-artifact-capability` (artifact token) preferred, broker token
fallback, the legacy `x-artifact-upload-token`/outbox token NEVER
accepted as consume authority, neither → fetch lane disabled (404).
Covered by real HTTP route tests against the production server.

## R1.6 — remote fetch bootstrap recipe

The governed prompt's REMOTE DEPENDENCY FETCH recipe now: creates the
parent dir, retries the bounded `for i in 1 2 3 4 5` loop with backoff,
verifies the download with real `sha256sum` + `wc -c` against the pin,
quarantines on mismatch (`mv` to `.quarantine`), writes ASCII-safe curl
headers (no raw token interpolation beyond the ASCII env), and on
unrecoverable failure emits `DEPENDENCY_FETCH_FAILED` + STOP — never a
silent partial.

## R1.7 — production-path E2E

`R1.7 G` runs the REAL pipeline: `MissionRuntime` + `PairControlPlane` +
`createMissionControlServer` on real HTTP in a SEPARATE spawned worker
process sharing the same `pair.db` (WAL multi-process). Remote adapter
dispatches with the verbatim governed prompt, performs real
pre-execution fetches (403 `execution_unknown` — dispatch precedes exec
persistence, exactly production), real RUNNING fetch 200, uploads via
`acap1`; local consumer reads the exact pinned materialized bytes at
dispatch. Covered: remote producer→local consumer, remote consumer fetch
lifecycle incl. pre-exec rejection + bounded retry, restart between
producer PASS and consumer dispatch (new store/runtime/adapter instances
re-derive everything from durable state — no in-memory carry-over, no
duplicate dispatch), and a remote non-leaf DAG edge flowing over real
HTTP.

## R1 mandatory tests

`src/__tests__/pair-f2-r1-remediation.test.ts` — 43 tests:

| Describe | Coverage |
|---|---|
| A (R1.1) | A1–A7: expected-binding consume, row rewrite→reject, CAS tamper→reject, storage rewrite→reject, malformed/conflicting history→reject, restart binding |
| B (R1.2) | B1–B7: PASS requires RESULT_VALIDATED anchor — no validation / no event / wrong validation_id / wrong correlation / foreign scope / tampered event all reject; intact PASS consumable |
| C (R1.3) | C1–C8: parent-symlink swap → zero bytes outside workspace; converge/different-bytes; sha/size pin re-verify before write; nested containment; collision names |
| D (R1.4) | D1–D8: digest persisted on governed + VALIDATED event; tampered dep-set/digest → not dispatch-authorized; approval for set A does not authorize set B; handoff id binding-digest derived |
| E (R1.5) | E1–E5: token-preferred, broker-fallback, outbox-token-never-authority, neither→disabled, body bound — over the real HTTP route |
| F (R1.6) | F1–F4: prompt carries bounded retry loop, mkdir, sha256sum+wc -c verification, quarantine+STOP, ASCII-safe headers |
| G (R1.7) | G1–G4: real-runtime + real-HTTP E2E matrix incl. restart and remote non-leaf DAG |

## R1 gates

| Gate | Result |
|---|---|
| R1 suite | 43/43 |
| F2 contract suite | 53/53 |
| F1 authority + R1 + R2–R7 remediation files | 20 + 25 + 95 |
| Dataflow incident + output-delivery contract | 106 + 69 |
| `rm -rf dist` → READY+GO true multi-process races | PASS on current source |
| Full suite on FINAL R1 HEAD | 3047 pass / 2 fail — only the known env-only P5 `stockProbe.available` failures (reproduce on base `b903cb4`) |
| `npx tsc --noEmit` | PASS |
| `pnpm build` | PASS |
| `pnpm audit --audit-level=high` | PASS — 0 high |

Classification:

`PAIR_NEXT_PHASE_F2_CROSS_EXECUTOR_ARTIFACT_HANDOFF_R1_PENDING_SOURCE_REVIEW`
