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

---

# INDEPENDENT RE-AUDIT R1 REMEDIATION

**Classification:** `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_R1_PENDING_REAUDIT` — STOP. DO NOT MERGE.

- **Previous audited HEAD:** `e0dae9f2df746c58be13bdf7939f9f0be0a79179`
- **Audit verdict addressed:** `P31_F1_CLEAN_ROOM_AUDIT_BLOCKED_R1_REQUIRED`
- All 9 findings closed on the same PR #31.

## R1 — RCA + implementation per finding

| # | Finding | Root cause | Closure |
|---|---------|-----------|---------|
| F1-1 | ARTIFACT-COUNT-RACE (HIGH) | count check ran BEFORE `store.immediate` — two distinct-name writers both saw 31 and committed 33 | `acceptBatch` mint path now re-reads priors + recounts + enforces cap INSIDE `store.immediate()` — writers serialize on the SQLite write lock; loser sees winner's commit → `FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED`. No process-local mutex. |
| F1-2 | PARENT-SYMLINK-ESCAPE (HIGH) | `assertNotSymlink` lstat'd only the final component; validator's `pathWithin` was lexical | Seam now `realpathSync`s the source AND every allowed root; `pathWithin(real, realpath(root))` required — parent/nested symlink escapes → `FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE`. Final-component symlink still rejected. |
| F1-3 | UNBOUNDED-HTTP-BODY (HIGH) | `readBody` accumulated all chunks + `Buffer.concat` + `JSON.parse` before any bound | `readBody(req, bound)` counts cumulative stream bytes AND early-rejects oversized `Content-Length`; bound is per-route — `/api/outbox` capability lane = `ceil(64MiB*4/3)+64KB`, legacy outbox lane = `ceil(8MiB*4/3)+64KB`, all other routes = 8MB default → deterministic 413, no `Buffer.concat` on over-limit bodies. |
| F1-4 | CLOSED-LIFECYCLE-IDEMPOTENCY (HIGH) | `verifyProducer` lifecycle gate ran BEFORE prior-row check → exact replay after close failed | New order: identity/linkage → name → bounded bytes → hash → deterministic ART id → exact prior ACCEPTED+sha match converges idempotently even post-close; sha mismatch → `REPLAY_CONFLICT`; only NEW mints hit the lifecycle gate. Forged execution_id still dies at identity proof first. |
| F1-5 | capability claims unchecked (MEDIUM) | claims.mission_id/task_id/governed_task_id were never compared to durable rows | `acceptArtifactUpload` now verifies ALL FIVE claims vs `executor_execution`↔`governed_task` durable state before ingest → `FAIL_CLOSED_ARTIFACT_CAPABILITY_MISMATCH`. |
| F1-6 | batch partial authority (MEDIUM) | per-artifact accept loop — failed validation left ACCEPTED prefix rows | `ArtifactAuthority.acceptBatch` — ONE canonical batch seam in the same authority: stage all blobs → single `immediate` txn mints all new rows or none. FAIL → zero new local ART rows + `execution_validation.artifact_ids: []` (prior remote refs moved to `referenced_artifact_ids` diagnostic field). |
| F1-7 | outbox compat collision (MEDIUM) | sanitize mapped `a b.txt`/`a?b.txt` to the same `${taskPrefix}-${filename}` dest | dest = `${taskPrefix}-${ART_<id16>}-${basename}` — injective per canonical identity, still `endsWith('-'+basename)` so the delivery resolver matches unchanged (ambiguous suffixes fail closed in the resolver); tmp name = `${dest}.tmp-${pid}-${ulid}`. |
| F1-8 | host path disclosure (LOW) | upload response returned absolute `path` | Response = `{ok, artifact_id, sha256, byte_size, replayed, storage_ref: pair-artifact://sha256/<sha>, materialized}` — no host path anywhere. |
| F1-9 | CAS dir fsync missing (LOW) | file fsync only; rename entry could be lost on power failure | After `renameSync`: `openSync(dir, O_DIRECTORY)` + `fsyncSync` + close. Platforms without dir-fsync (EINVAL) degrade deliberately — post-rename bounded re-verify still applies. |

## R1 adversarial proofs (permanent suite `pair-f1-r1-remediation.test.ts`, 25 tests)

- **A1** 31+2 writers → 32 cap holds, loser `COUNT_EXCEEDED` · **A2** 30+3 → ≤32 · **A3** same id+bytes → one authority · **A4** conflicting bytes → original preserved.
- **B1** `ws/linkdir→outside` → `PATH_OUTSIDE` + validator FAIL + 0 rows · **B2** nested escape rejected · **B3** genuine inside path passes.
- **C1** oversized Content-Length → 413 pre-read (raw socket) · **C2** ~100MB chunked → bounded abort mid-stream · **C3** 13MB junk JSON → 413 legacy bound · **C4** in-bound still 200.
- **D1** accept→lost response→close→identical retry → 200 `replayed:true` same ART id (endpoint-level) · **D2** closed+new → `EXECUTION_CLOSED` · **D3** closed+conflict → `REPLAY_CONFLICT`.
- **E** all five claims mutated independently → `CAPABILITY_MISMATCH`; correct claims pass · **E2** acap/bcap domain separation holds.
- **F1** 33-artifact batch → FAIL + zero rows + `artifact_ids:[]` · **F2** late conflict → FAIL + prefix not minted · **F2b** injected blob-write failure → FAIL + zero partial rows · **F3** valid batch atomic PASS · **F4** replay-only batch → PASS, no dup.
- **G1** `a b.txt`+`a?b.txt` → two distinct compat files, bytes intact · **G2** concurrent same-artifact replay → one dest, zero tmp residue.
- **H** response JSON contains no host path · **I** ≥2 fsyncSync calls per ingest (file + dir).

## Validation counts

- F1 original suite: 20/20 · R1 permanent suite: 25/25
- Focused: output-delivery-contract 69/69 · planner-dataflow-incident 106/106 · ops-telegram 3/3 · live-ops-recovery 20/20 · route-capability 36/36 · runtime-hardening 11/11 · phase-d 37/37 · p9 79/79
- **Full suite: 2856 pass / 2 fail / 15 skip** — the 2 are the same env-only P5 stockProbe failures, reproduced identically on base `6ff9d35` (VM has dsh/codex binaries installed).
- `npx tsc --noEmit`: 0 errors · `pnpm build`: PASS · `pnpm audit --audit-level=high`: 0 high/critical (9 low/moderate baseline)

## Files changed in R1

```
src/pair/artifact-authority.ts        rewritten — verifyIdentity/assertOpen split, realpath
                                     containment, acceptBatch atomic mint, dir fsync
src/pair/mission-control.ts          +claims↔durable cross-check (all 5 claims)
src/pair/mission-control-server.ts   bounded readBody + route bounds + collision-safe
                                     compat dest + tmp-unique + no-path response
src/pair/artifact-validation.ts      batch ingest via acceptBatch; FAIL → artifact_ids:[],
                                     referenced_artifact_ids diagnostics
src/__tests__/pair-f1-artifact-authority.test.ts  B4/B6 expectations updated to R1 semantics
src/__tests__/pair-f1-r1-remediation.test.ts      NEW — 25 permanent adversarial proofs
PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_REPORT.md  this section
CURRENT_STATE.md
```

**Preserved untouched:** PR #30 delivery-contract invariants; remote DAG-leaf; F2/F3/P15; single `artifact` entity/`pair-artifact.v1` contract/`ArtifactAuthority` implementation (batch seam lives inside it).

---

# INDEPENDENT SOURCE-REVIEW R2 REMEDIATION

**Mandate:** `pasted-1790991806129.txt` — source-review of R1 HEAD `bb7b24fe2d250ba456aa198da7aed2062314dd07` found 4 HIGH + 2 MEDIUM + 1 TEST-GOVERNANCE finding. Same PR #31, no merge.

- **Previous R1 HEAD:** `bb7b24f`
- **New HEAD:** `bdebdde06f4c33f7267f26b3d9b3b89dc908ae6a`
- **Fix classification:** `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_R2_PENDING_SOURCE_REVIEW`

## Per-finding RCA + closure

| Finding | Root cause | Fix |
|---|---|---|
| R2.1 `F1-PATH-CONTAINMENT-READ-TOCTOU` (HIGH) | `assertContained()` proved realpath on one resolution, then `boundedFileSha256(source.path)` **reopened the original pathname** — a parent-symlink/dir-entry swap between them could mint outside bytes | New `secureReadContained()` in `canonical.ts`: `openSync(O_RDONLY|O_NOFOLLOW)` once → `/proc/self/fd/<fd>` realpath proves the **opened object** is under a real allowed root → `fstat(fd)` → bound → `readSync(fd)` → `bytes.length === fstat.size` → hash. Containment + bytes bound to ONE fd; post-open symlink/dir swaps cannot redirect it. Non-Linux (no /proc/self/fd) fails closed. `assertContained` deleted |
| R2.2 `F1-VALIDATED-BYTES-CANONICAL-BYTES-TOCTOU` (HIGH) | Validator read+hashed bytes, then `acceptBatch` re-read the path — declared sha/size verified against read #1, canonical bytes taken from read #2 | Validator no longer reads content: declared `sha256`/`byte_size` forwarded as `expected_sha256`/`expected_byte_size` into `acceptBatch`; the ONE authoritative materialization reads once and compares → `FAIL_CLOSED_ARTIFACT_DECLARED_MISMATCH`. VALIDATED BYTES == CANONICAL RETAINED BYTES |
| R2.3 `F1-REPLAY-CANONICAL-AUTHORITY-INCOMPLETE` (HIGH) | Replay accepted any same-id/same-sha `ACCEPTED` row — a legacy/malformed row at the deterministic ART id could be elevated by replay | `isCanonicalPrior()` requires: `contract==pair-artifact.v1` + artifact_id==deterministic id + execution/governed/mission/task/producer/logical_name all equal canonical identity + `ACCEPTED` + `byte_size` match + `storage.kind==PAIR_ARTIFACT_CAS` + `storage.sha256==row sha` + retained CAS blob exists and verifies to the incoming digest. Any failure → `FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT`. Applies in both the pre-txn convergence scan and the in-transaction raced check |
| R2.4 `F1-PRODUCER-EXECUTOR-DURABLE-LINKAGE-GAP` (HIGH) | Authority checked `execution.executor_id == producer` but not `governed_task.executor_id == execution.executor_id` — durable governance rows could contradict and still pass | `verifyIdentity` now requires `governed.executor_id === execution.executor_id` (`FAIL_CLOSED_ARTIFACT_LINKAGE`); MC capability cross-check additionally requires `governed.executor_id === claims.executor_id === execution.executor_id` |
| R2.5 `F1-OUTBOX-COMPAT-NAME-RESOLUTION-MISMATCH` (MEDIUM) | Writer sanitized `a b.txt`→`a_b.txt` but resolver matched `endsWith('-a b.txt')` — legitimate names needing sanitize could never resolve | One canonical `compatOutboxBasename()` in `canonical.ts` used by BOTH the compat writer and `resolveDeliveryArtifactPath`; resolver additionally tolerates non-manifest-charset plain basenames (no separators/traversal). Two names sanitizing alike → multiple matches → resolver fails closed, never picks wrong |
| R2.6 `F1-CAS-DIR-FSYNC-OVERBROAD-FALLBACK` (MEDIUM) | dir-fsync catch swallowed ALL errors — real durability failures (EIO/EPERM) masqueraded as durable commit | Only `EINVAL`/`ENOTSUP`/`EOPNOTSUPP` fall back (documented unsupported platform/fs); anything else → `FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY` |
| R2.7 count-race test governance | R1 "concurrent" tests ran sequentially in one JS thread | TRUE multi-process races: `src/__tests__/fixtures/f1-worker-accept.cjs` — separate Node processes + separate `PairEvidenceStore` connections to the SAME db, barrier file. 31+2→32 (1 ok/1 COUNT), 30+3→32 (2 ok/1 COUNT), same identity+same bytes→2 ok/1 row, same identity+different bytes→1 ok/1 REPLAY_CONFLICT. The `store.immediate` authority model holds under real concurrency |

## Adversarial proofs (new R2 suite — 29 tests)

- R2-A1: link→inside at open, swapped→outside inside the `/proc/self/fd` resolution hook — minted bytes = inside bytes (fd binds the opened object)
- R2-A2: swapped before open → `PATH_OUTSIDE` · R2-A3: file replaced after open → retained original object or fail closed (never REPL bytes) · R2-A4: static cases
- R2-B1/B2: declared sha(A)+file B same-size → FAIL + 0 rows; declared size drift → FAIL + 0 rows · R2-B3: valid → PASS, CAS retains exactly validated bytes
- R2-C1–C9: prior row missing/wrong contract, wrong producer/governed/mission/logical_name, storage-sha mismatch, missing or corrupt CAS blob — every replay fails `REPLAY_CONFLICT`, zero promotion · R2-C10: valid prior post-close → `replayed:true`
- R2-D1/D2: governed.executor `DEVIN` vs execution `CODEX` → direct accept `FAIL_CLOSED_ARTIFACT_LINKAGE`; capability upload `CAPABILITY_MISMATCH`
- R2-E1–E3: `a b.txt`, `a?b.txt` resolve through the shared rule; colliding names → fail closed
- R2-F1–F3: EINVAL fallback ok; EIO + arbitrary error → `FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY`, 0 rows
- R2-G1–G4: real multi-process races as above

## Validation counts

- New R2 suite: **29/29** · F1 suite: **20/20** · R1 suite: **25/25** · delivery contract: **69/69** · incident: **106/106** · ops: **3/3** · live-ops: **20/20** · route-capability: **36/36** · runtime-hardening: **11/11** · p9: **79/79**
- **Full suite: 2883 pass / 4 fail / 15 skip** — 2 are the same env-only P5 stockProbe fails (reproduced on base `6ff9d35`); 2 were expectation-string updates in P2/P5 (tamper still fails closed — code renamed to `DECLARED_MISMATCH`, updated)
- `npx tsc --noEmit`: 0 errors · `pnpm build`: PASS · `pnpm audit --audit-level=high`: 0 high/critical

## Files changed in R2

```
src/pair/canonical.ts               +secureReadContained (opened-object containment+bounded read)
                                    +compatOutboxBasename (shared compat naming rule)
src/pair/artifact-authority.ts      materialize → secureReadContained; expected sha/size;
                                    isCanonicalPrior; governed-executor linkage; fsync classification
src/pair/artifact-validation.ts     no independent read; passes expected sha/size into batch
src/pair/mission-control.ts         +governed.executor_id durable cross-check
src/pair/mission-control-server.ts  compat writer uses compatOutboxBasename
src/pair/telegram-delivery.ts       resolver uses compatOutboxBasename + plain-basename tolerance
src/__tests__/pair-f1-r2-remediation.test.ts      NEW — 29 permanent adversarial proofs
src/__tests__/fixtures/f1-worker-accept.cjs       NEW — multi-process race worker
src/__tests__/pair-f1-artifact-authority.test.ts  D3/E2 fresh-connection auth uses same blobDir
src/__tests__/pair-p2.test.ts / pair-p5.test.ts   failure-code expectation → DECLARED_MISMATCH
```

**Preserved:** PR #30 delivery authority; remote DAG-leaf (0 diff); F2/F3/P15 untouched; ONE `artifact` entity + `pair-artifact.v1` + `ArtifactAuthority` (no parallel authority systems).

**Remaining limitations:** `secureReadContained` requires Linux `/proc/self/fd` for opened-object identity — non-Linux deployments fail closed (deliberate); P5 env-only fails unchanged.

---

## INDEPENDENT SOURCE-REVIEW R3 REMEDIATION

- **Previous reviewed HEAD:** `e590b71323c5278dd6fbd0d1484ecd2d77d682bb`
- **New HEAD:** `17d90f2242b5947f2dc7bef0a90923fecc9e8df9`
- **Changed files:** `src/pair/canonical.ts`, `src/pair/artifact-authority.ts`, `src/__tests__/pair-f1-r2-remediation.test.ts`, `src/__tests__/fixtures/f1-worker-accept.mts` (replaces `.cjs`), `CURRENT_STATE.md`, this report.

### RCA — R3.1 F1-CAS-DURABILITY-RETRY-BYPASS (HIGH)

- **Root cause:** `persistBlob` early-returned on an existing correct-SHA blob — a retry after a dir-fsync failure reused the renamed bytes WITHOUT re-proving the directory durability barrier, then minted authority.
- **Fix:** one canonical barrier `ensureBlobDirectoryDurable(dir)` now runs (a) after every fresh `rename` and (b) before trusting ANY existing matching blob for a new authority mint. Codes tolerated: `EINVAL|ENOTSUP|EOPNOTSUPP` only; `EIO`/`EPERM`/unexpected → `FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY`. Reuse never unlinks (a shared blob may back another canonical artifact).
- **Adversarial proof:** R3-A1 rename+EIO→FAIL,0 rows; A2 retry-still-EIO→FAIL again,0 rows (no bypass); A3 barrier healed→mint; A4 ENOTSUP→deterministic fallback.

### RCA — R3.2 F1-CANONICAL-PRIOR-STORAGE-INTEGRITY-GAP (MEDIUM)

- **Root cause:** `isCanonicalPrior` verified `storage.kind`/`storage.sha256` but NOT `storage.ref`; a prior with a malformed/wrong ref still classified canonical. The CAS destination was also not required to be a regular file (a symlink to matching external bytes could pose as retained authority).
- **Fix:** prior is canonical only if `storage.ref === "blobs/<sha256>"` (no absolute/traversal/alternate) AND `lstat(blobDir/<sha>).isFile()` (non-symlink regular file) AND bounded digest re-verify. Same regular-file requirement applied when `persistBlob` decides an existing blob is reusable.
- **Adversarial proof:** R3-B1 wrong ref, B2 missing ref, B3 traversal ref → `FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT`; B4 CAS-dest symlink→external matching bytes → conflict; B5 normal canonical → replay converges.

### RCA — R3.3 F1-SECURE-READ-MIDREAD-GROWTH-GAP (HIGH)

- **Root cause:** `secureReadContained` fstat'd once, allocated pre-read size, read exactly that — a file growing (or same-size mutating) between fstat and read could silently pass with an unstable realization.
- **Fix:** after the length-verified read, `fstatSync(fd, {bigint})` runs AGAIN on the SAME fd and `dev|ino|size|mtimeNs|ctimeNs` must be unchanged — any growth/mutation lands `unresolved` → `FAIL_CLOSED_ARTIFACT_UNRESOLVED`. Containment stays bound to the same opened object; the path is never reopened. Same-size mutation inside one kernel timestamp tick is unobservable to any filesystem observer — the observable case (distinct mtime) fails closed.
- **Adversarial proof:** R3-C1 append-during-read→fail closed,0 rows; C2 same-size mutation w/ distinct mtime→fail closed; C3 rename-replacement→original-or-fail-closed (never REPL); C4 stable→PASS; C5 oversized still pre-read rejected.

### RCA — R3.4 F1-CONCURRENCY-PROOF-DEPENDS-ON-UNTRACKED-DIST (TEST-GOVERNANCE)

- **Root cause:** the multi-process race fixture `require`d `dist/pair/index.js` — untracked build output: missing on clean checkout, or stale vs the HEAD under test.
- **Fix:** worker is now `fixtures/f1-worker-accept.mts` spawned via the repo's own `node_modules/.bin/tsx`, importing `src/pair/index.ts` — genuine separate OS processes + separate PairEvidenceStore connections + same DB + start barrier, executed against CURRENT SOURCE. Verified: `rm -rf dist` → all 4 races pass.
- **Proof:** R2-G1..G4 pass under `rm -rf dist` (31+2→32, 30+3→32, same-id converge/conflict).

### Validation (final HEAD)

- R2+R3 file: **43/43** (29 R2 + 14 R3) — clean-checkout proof ran under `rm -rf dist`
- Focused F1+R1+contract+ops+incident+runtime+p9: **302/302**
- Full suite on final HEAD: **2899 pass / 2 fail / 15 skipped** — only the known P5 env-only `stockProbe.available` fails (reproduce on base `6ff9d35`)
- `npx tsc --noEmit` 0 errors · `pnpm build` PASS · `pnpm audit --audit-level=high` → 0 high/critical (1 low, 8 moderate baseline)
- Remote DAG-leaf restriction diff = 0; F2/F3/P15 untouched; ONE artifact entity/contract seam unchanged

### Remaining limitations

- `/proc/self/fd` containment is Linux-semantics; non-Linux fails closed by design.
- Same-size mutations within a single kernel timestamp tick are filesystem-unobservable (documented); every observable mutation fails closed.
- `dependency_artifacts` / downstream consumer materialization remain deferred to F2 (non-ACCEPTED rows stay non-authoritative).

Classification: `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_R3_PENDING_SOURCE_REVIEW`

---

## INDEPENDENT SOURCE-REVIEW R4 REMEDIATION

- **Previous reviewed HEAD:** `db4932f4852a286f28a709761314fc59297f46ab`
- **New HEAD:** `<pending>`
- **Changed files:** `src/pair/artifact-authority.ts`, `src/__tests__/pair-f1-r2-remediation.test.ts`, `src/__tests__/fixtures/f1-worker-accept.mts`, `CURRENT_STATE.md`, this report.

### RCA — R4.1 CAS REGULAR-FILE READ MUST BE OPEN-OBJECT BOUND

- **Root cause:** `isCanonicalPrior` and `persistBlob` existing-blob reuse proved "regular file" via `lstat(path)` then hashed via `boundedFileSha256(path)` — which REOPENS the pathname. The object proven regular was not guaranteed to be the object actually read/hashed (path-swap TOCTOU).
- **Fix:** ONE canonical CAS read primitive `readCasBlob(dest)` wraps `secureReadContained` — open once `O_RDONLY|O_NOFOLLOW` → fstat SAME fd (regular) → bound → read SAME fd → post-read fstat stability → `sha256Hex` of those exact bytes. The object proven regular IS the object hashed; a final-component symlink is rejected at open. Used for: (1) retained-CAS prior proof, (2) existing-blob reuse decision, (3) post-rename verification.
- **Adversarial proof:** R4-D1 CAS dest swapped to symlink→external matching bytes → `REPLAY_CONFLICT`; D2 static symlink at dest → never reused (seam rewrites a REAL blob, mint proceeds correctly); D3 regular blob → converges; D4 corrupt regular blob → conflict; D5 fresh write → mint.

### RCA — R4.2 TRUE CONCURRENCY TEST NEEDS A REAL READY BARRIER

- **Root cause:** children waited on `goFile` BEFORE constructing the store, while the parent merely slept 800ms — no proof every child actually reached the barrier; sleep was correctness authority.
- **Fix:** READY+GO at the exact pre-BEGIN-IMMEDIATE seam, test-only: each worker creates its own `PairEvidenceStore`, wraps ITS OWN `store.immediate()` — first invocation writes a unique READY file, busy-waits for GO, then delegates to the ORIGINAL immediate (production semantics untouched). Parent polls until EVERY READY exists, then writes GO. No sleep establishes readiness.
- **Proof under `rm -rf dist`:** all 4 races pass on CURRENT SOURCE via tsx — 31+2→32 (1 success+1 COUNT), 30+3→32, same-id same-bytes→converge, same-id diff-bytes→1 authority+1 REPLAY_CONFLICT.

### Validation (final HEAD)

- R2/R3/R4 file: **48/48** — clean-checkout proof ran under `rm -rf dist`
- Focused F1+R1+contract+ops+incident+runtime+p9: **302/302**
- Full suite on final HEAD: **2904 pass / 2 fail / 15 skipped** — only the known P5 env-only `stockProbe.available` fails (reproduce on base `6ff9d35`)
- `npx tsc --noEmit` 0 errors · `pnpm build` PASS · `pnpm audit --audit-level=high` → 0 high/critical (1 low, 8 moderate baseline)
- Remote DAG-leaf restriction diff = 0; F2/F3/P15 untouched; ONE artifact entity/contract seam unchanged

### Remaining limitations

- `/proc/self/fd` containment is Linux-semantics; non-Linux fails closed by design.
- Same-size mutations within one kernel timestamp tick are filesystem-unobservable; every observable mutation fails closed.
- `dependency_artifacts` / downstream consumer materialization remain deferred to F2.

Classification: `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_R4_PENDING_SOURCE_REVIEW`
