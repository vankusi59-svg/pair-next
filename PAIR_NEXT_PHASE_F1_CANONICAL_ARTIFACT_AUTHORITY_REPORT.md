# PAIR NEXT — PHASE F1 CANONICAL ARTIFACT AUTHORITY FOUNDATION — REPORT

**Classification:** `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_PENDING_INDEPENDENT_AUDIT`
**STOP. DO NOT MERGE.**

- **Base SHA (canonical):** `6ff9d35b33820653c1f0b10cfcb341199ddb3bb0` (main HEAD, verified before branch)
- **Branch:** `devin/1790985872-phase-f1-artifact-authority`
- **Final HEAD:** see `git log` of the branch
- **PR:** one PR from exactly this base

---

## 0. Incident context (why F1 exists)

A remote executor (Devin) completed a governed task and created output files in its *remote* workspace. PAIR's local canonical workspace never received the bytes. The artifact rows PAIR recorded were path claims — "a file at path X was declared" — not byte authority. Downstream dependency checks then failed ("input not found"), recovery replanned the same plan shape, and the loop repeated. The incident proved PAIR had **four partial artifact notions and zero canonical authority**:

| Existing mechanism | What it actually proved | Why it is not artifact authority |
|---|---|---|
| `ArtifactProvenanceValidator` rows | A path in the workspace had the declared sha256 *at validation time* | Row = "path existed once"; bytes not retained; no execution binding; path is mutable post-validation |
| `/api/outbox` uploads | Bytes transited through a generic bearer endpoint into a project dir | Filename-string binding only (`${task_id}-${name}`); no execution scoping; a generic transport token = write access for ANY mission/task; not deduped; no canonical identity |
| Telegram delivery snapshots | Exact bytes for *send authority* in `.delivery-snapshots/` | Transport staging scoped to delivery slots — not producer artifacts; exists post-execution only |
| Planner `dataflow` names | Declared output/input *names* | Name-level routing only; never bytes |

None could answer: **"these exact bytes are artifact ART_xxx, produced by THIS governed execution, under this mission/task identity, with this SHA-256 and byte size."**

---

## 1. Pre-modification seam map (§1)

| Seam | File | Before F1 | After F1 |
|---|---|---|---|
| Local artifact validation | `artifact-validation.ts` | declared path → `sha256File` compare → PASS/FAIL row | declared path → **canonical ingest via `service.artifacts.accept()`** → PASS requires accepted canonical rows |
| Bounded file read | `telegram-delivery.ts` (private helper) | `boundedFileSha256` local helper | **moved to `canonical.ts`** as THE shared stat-first authority; `maxBytes` now a required param |
| Remote upload ingress | `mission-control-server.ts` `/api/outbox` | `x-outbox-token` bearer → write file to project outbox | two lanes: **capability lane** (`x-artifact-capability` → canonical ingest + outbox materialization for delivery compat) and legacy lane (unchanged, response marks `canonical:false`) |
| Remote prompt | `devin-executor.ts` | prompt says upload with `x-outbox-token` | when artifact master configured → mints **execution-scoped capability**, prompt uses `x-artifact-capability` |
| Server config | `serve-mission-control.mjs` | — | `artifactUploadToken` dep = `PAIR_ARTIFACT_UPLOAD_TOKEN \|\| PAIR_BROKER_TOKEN` |
| Read model | `mission-control.ts` + server | none | `GET /api/artifacts`, `GET /api/artifacts/:id` — `pair-artifact://sha256/<sha>` refs only, no host paths |
| Store | `store.ts` | — | `dbDir` exposed (canonical blob root co-located with pair.db) |

## 2. Canonical artifact schema (§2)

Entity `artifact` (one row per `artifact_id`), contract `pair-artifact.v1`:

```
artifact_id   = ART_<digest({execution_id, logical_name})[:32]>   // deterministic identity
execution_id  = governed execution that produced the bytes (FK to canonical producer)
governed_task_id / mission_id / task_id   = resolved from durable state, never caller-supplied
producer_executor_id                     = execution.executor_id (verified equality)
logical_name  = canonicalized name (≤200B, no traversal/absolute/backslash)
artifact_class = image|text|binary (metadata only — never authority)
sha256        = PAIR-computed over the exact retained bytes
byte_size     = bytes.length at ingest
state         = ACCEPTED
ingested_via  = LOCAL_EXECUTION | REMOTE_UPLOAD
storage       = { kind: PAIR_ARTIFACT_CAS, ref: blobs/<sha256>, sha256 }
created_at    = utcnow
```

"Filename alone is never authority" — identity is execution+name digest. "Caller-provided sha256 is never accepted" — PAIR hashes independently; declared sha is advisory validation input only.

## 3. Content-addressed byte store (§3)

`artifacts/blobs/<sha256-hex>` under the pair.db deployment dir (`service.artifacts`; env override `PAIR_ARTIFACT_DIR`).

- **Immutable**: bytes are keyed by their own digest; a write to an existing sha whose content already verifies is a no-op dedup.
- **Durable write**: `<sha>.tmp-<pid>-<ulid>` → writeSync → fsyncSync → renameSync → bounded re-verify post-rename (`boundedFileSha256`); torn writes unlink + `FAIL_CLOSED_ARTIFACT_BLOB_WRITE`.
- **Workspace independence**: canonical bytes live outside project workspaces — post-acceptance mutation/deletion of the workspace source cannot alter them (proven in tests A3/E).
- **Orphan tmp**: `sweepTmp()` removes `<sha>.tmp-*` stragglers (crash-safe cleanup; test E1).
- **Bounds**: stat-first — `MAX_ARTIFACT_BYTES` = 64MB enforced before any full read (spy test F2 proves zero `readFileSync` on oversized path); empty rejected; ≤32 artifacts per execution; count cap never trips on replays.

## 4. The one ingest seam (§4)

`ArtifactAuthority.accept()` is the ONLY way an artifact row gains canonical authority:

1. resolve producer chain from durable state (`executor_execution` → `governed_task` → identity fields); `FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN` / `FAIL_CLOSED_ARTIFACT_LINKAGE` on contradiction
2. `producer_executor_id` must equal `execution.executor_id` → `FAIL_CLOSED_ARTIFACT_PRODUCER_MISMATCH`
3. closed-state gate: FAILED/CANCELLED/TIMEOUT always closed; `result` already persisted closes remote uploads (`allow_post_result:false`) but not local settle validation (`allow_post_result:true`)
4. logical-name canonicalization → `FAIL_CLOSED_ARTIFACT_NAME_INVALID`
5. count cap → `FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED`
6. path sources: symlink reject (`FAIL_CLOSED_ARTIFACT_SYMLINK`) → stat-first bounded read → `FAIL_CLOSED_ARTIFACT_TOO_LARGE` / `UNRESOLVED`
7. PAIR computes sha256 of the exact bytes → persist CAS → atomic row write in one `immediate()` transaction
8. prior row same sha → `ARTIFACT_INGEST_IDEMPOTENT` + `{artifact, replayed:true}`; different sha → `FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT` + rejection evidence

Callers supply only `(execution_id, producer_executor_id, logical_name, bytes|path, channel)` — **no caller can mint provenance by supplying identity fields**.

## 5. Local validator migration (§5)

`ArtifactProvenanceValidator` now: for each declared artifact → canonical ingest (symlink/bounds/unresolved produce deterministic failures) → declared sha/size, when supplied, must equal PAIR's computed values (otherwise `artifact sha256 mismatch` / `artifact size mismatch` → FAIL) → ingest IntegrityError folds into `failures[]` (no partial PASS). The `execution_validation` row gains `artifact_ids` — the accepted canonical ids — plus any canonical rows PAIR ingested for that execution (§7 remote uploads appear here on restart).

An `artifact` row now means: **"PAIR accepted and retained these exact bytes under this governed execution identity."**

## 6. Remote ingest authorization (§6)

New capability format `acap1.<base64url(claims)>.<hmac>` (`artifact-capability.ts`), mirroring `bcap1`:

- claims: `{mission_id, task_id, governed_task_id, execution_id, executor_id, issued_at}`
- MAC: HMAC-SHA256 of the claims payload under `pair.artifact-capability.v1:<master>` — separate key prefix/domain from broker caps
- verify: constant-time compare; every claim must equal durable execution state; capability dies automatically with the execution (closed-state + post-result gates — the execution lifecycle IS the expiry; no independent TTL needed)
- minted ONLY by `DevinExecutorAdapter.buildPrompt` for the execution it dispatches; the remote process sees only its minted token — never the master
- body `mission_id`/`task_id` must equal the claims → `FAIL_CLOSED_ARTIFACT_CAPABILITY_MISMATCH`
- master resolution identical on both sides: `PAIR_ARTIFACT_UPLOAD_TOKEN || PAIR_BROKER_TOKEN`. `PAIR_OUTBOX_TOKEN` deliberately NOT a valid master (remote can read it from its own prompt) — legacy lane stays transport-compat only and cannot mint canonical rows (B5 proves).
- no secrets in events/evidence/logs; `registerSensitiveMaterial` on token + master

## 7. Result contract (§7)

Successful governed remote uploads produce `ART_*` rows attributable to the execution via `forExecution(execution_id)`; the validation row's `artifact_ids` closes the loop for the dependency checker downstream (F2). PAIR-owned upload evidence — not remote prose — is authority. Restart reconstructs references purely from durable rows (test E2).

## 8. Replay / crash / concurrency semantics (§8)

| Scenario | Outcome |
|---|---|
| duplicate upload (identical identity+bytes) | idempotent accept, `replayed:true`, single row |
| same identity, different bytes | `FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT` + `ARTIFACT_REJECTED` event+evidence; original preserved — never silent replace |
| crash after blob, before row | blob deduped by sha on retry → row written → same artifact_id |
| crash after row, before response | retry hits prior-row path → idempotent |
| concurrent duplicate (two store connections) | version-conflict loser re-reads winner → same sha → idempotent converge |
| restart | all references reconstructed from `artifact` rows + CAS |

## 10. Read model (§10)

`GET /api/artifacts?mission_id=` / `GET /api/artifacts/:id` → `{artifact_id, mission_id, task_id, governed_task_id, execution_id, producer_executor_id, logical_name, artifact_class, sha256, byte_size, state, ingested_via, created_at, canonical, storage_ref}` where `storage_ref = pair-artifact://sha256/<sha256>` — no host filesystem paths exposed.

## 11. Evidence (§11)

Events on `executor_execution`: `ARTIFACT_INGEST_STARTED` (counts/names), `ARTIFACT_ACCEPTED`, `ARTIFACT_INGEST_IDEMPOTENT`, `ARTIFACT_REJECTED`, `ARTIFACT_INGEST_BATCH_REJECTED`; plus mission-scoped `governed_evidence` `ARTIFACT_ACCEPTED`/`ARTIFACT_REJECTED` rows. All identify `ART_*` + producer ids; zero secret material; durable across restart.

## 12. Legacy semantics (§12)

Pre-F1 `artifact` rows (no `contract` field) remain inspectable via `project()`/`list()`/`get()` with `state:"LEGACY_PATH_ONLY"`, `canonical:false`, `storage_ref:null`. They are NEVER auto-promoted and never adopted by checking current filesystem existence — no re-baselining (G1).

## 13. PR #30 non-regression (§13)

Delivery manifest authority, mandatory SHA-256, snapshot-first retry, stat-first bounded reads, snapshot immutability, FILES digest chain, output-language gates, zero-network-on-failure — **unchanged**: `boundedFileSha256` moved location-only (still the same helper, now canonical), telegram-delivery re-exports it; capability uploads still materialize verified bytes to `<task>-<name>` in the project outbox so existing FILES resolution is untouched. Artifact existence ≠ send authority (delivery still requires its own TDR chain).

## 14. Non-goals respected (§14)

- remote-task DAG-leaf restriction **unchanged** (verified: no diff in planner leaf rules)
- no cross-executor consumption/materialization (F2)
- no `dependency_artifacts` changes, no ART materialization into consumer workspaces
- no planner remote-edge change, no artifact routing, no plan-digest rejection change
- no P14/P15 work; no Telegram send-authority broadening

## 15. Test evidence (§15)

New suite `src/__tests__/pair-f1-artifact-authority.test.ts` — **20/20 PASS**:

- **A** local validated → canonical bytes + binding + hash; sha-mismatch FAIL; post-accept source mutation safe
- **B** capability accepted; wrong-mission body, forged signature, wrong executor, unknown execution, terminal execution, post-result all rejected; generic outbox token cannot mint (endpoint test); endpoint happy path + read model
- **C** source mutation after acceptance → canonical bytes unchanged
- **D** replay idempotent; different-bytes fail-closed; dual-connection concurrency converges
- **E** orphan tmp sweep; restart (fresh store+authority) reconstructs identical references + idempotent replay
- **F** oversized buffer/path rejected (spy proves ZERO full-file read on oversized path); empty; traversal/absolute/backslash; count cap (replay-exempt); symlink
- **G** legacy path-only row → LEGACY_PATH_ONLY, never canonical
- **H** PR #30 contract suites run unchanged (below)

## 16. Validation results (§16)

| Gate | Result |
|---|---|
| F1 focused | 20/20 PASS |
| `pair-output-delivery-contract` | 69/69 PASS |
| `pair-ops-telegram-delivery` | 3/3 PASS |
| Full suite | **2831 pass / 2 fail / 15 skip** — the 2 fails are the pre-existing env-only P5 stockProbe cases (VM has dsh/codex binaries; identical on base 6ff9d35, see R5 report) |
| `npx tsc --noEmit` | PASS (0 errors) |
| `pnpm build` | PASS |
| `pnpm audit --audit-level=high` | 0 high/critical (9 low/moderate, unchanged baseline) |
| Repo integrity | only intended files changed (diff stat below) |

## 17. Changed files

```
src/pair/canonical.ts               +36  boundedFileSha256 moved here; canonicalArtifactId
src/pair/artifact-authority.ts      NEW  ~490 LOC — the one ingest seam + CAS + read model
src/pair/artifact-capability.ts     NEW  acap1 mint/verify/master resolution
src/pair/artifact-validation.ts     ±85  validator → canonical ingest; artifact_ids on row
src/pair/mission-control.ts         +47  acceptArtifactUpload + artifacts()/artifact() read models
src/pair/mission-control-server.ts  +88  capability lane in /api/outbox + /api/artifacts routes
src/pair/devin-executor.ts          ±26  capability mint + new upload instruction line
scripts/serve-mission-control.mjs   +6   artifactUploadToken wiring
src/pair/service.ts                 +17  lazy artifacts getter (blobDir = <pair.db>/artifacts/blobs)
src/pair/store.ts                   +5   dbDir
src/pair/telegram-delivery.ts       -48/+~14  delegate to canonical helper (re-export for compat)
src/pair/telegram-transport.ts      ±2   explicit MAX_TELEGRAM_FILE_BYTES arg
src/pair/mission-runtime.ts         ±5   explicit MAX_TELEGRAM_FILE_BYTES arg
src/pair/index.ts                   +2   exports
src/__tests__/pair-f1-artifact-authority.test.ts  NEW  20 tests
```

## 18. Limitations / deferred

- Capability lifecycle = execution liveness (no independent TTL — replay of a live execution's capability is legitimate retry; expiry is enforced by the post-result + terminal-state gates).
- Remote executor prompt instructs upload via curl; remote adapters that never emit uploads simply produce no artifacts — no failure introduced.
- CAS blobs are unbounded in retention within F1 (no GC policy yet — artifacts are mission evidence; a retention mandate belongs to a lifecycle phase, not F1).
- `PAIR_ARTIFACT_UPLOAD_TOKEN` not yet provisioned in the live env — falls back to `PAIR_BROKER_TOKEN` automatically; remote uploads are disabled entirely when neither exists.
- F2 (cross-executor consumption/materialization) and F3 (planner/recovery digest closure) intentionally untouched.

**Explicit confirmations:** remote-task DAG-leaf restriction UNCHANGED; no self-merge; one branch; one PR.
