# PAIR NEXT — PHASE F1 CLEAN-ROOM ADVERSARIAL AUDIT

**Classification:** `F1_CLEAN_ROOM_ADVERSARIAL_AUDIT` (same-session audit — NOT claimed independent)
**Verdict:** `P31_F1_CLEAN_ROOM_AUDIT_BLOCKED_R1_REQUIRED`

- **PR:** https://github.com/vankusi59-svg/pair-next/pull/31
- **Audited base SHA:** `6ff9d35b33820653c1f0b10cfcb341199ddb3bb0`
- **Audited HEAD:** `e0dae9f2df746c58be13bdf7939f9f0be0a79179` — verified identical at audit start
- **Clean-worktree proof:** `git status --porcelain` empty at freeze; branch `devin/1790985872-phase-f1-artifact-authority`; merge-base = base SHA
- **Audit artifacts:** `src/__tests__/pair-f1-cleanroom-audit.test.ts` — audit-only, UNCOMMITTED, 18 tests (not part of shipped suite; remove before any commit)

---

## A. Scope verification (§3)

PASS — one `artifact` entity evolved; `git diff origin/main` shows zero change to `plan-dataflow.ts`, `mission-router.ts`, `recovery.ts` (remote DAG-leaf restriction byte-identical); no F2 consumption/materialization code; no F3 digest closure; no P15 files; PR #30 modules unchanged in semantics (`boundedFileSha256` moved verbatim to `canonical.ts`, same call order; telegram-delivery re-exports it).

Changed files: 17 — all inside the F1 boundary (canonical.ts, artifact-authority.ts, artifact-capability.ts, artifact-validation.ts, mission-control.ts, mission-control-server.ts, devin-executor.ts, serve-mission-control.mjs, service.ts, store.ts, telegram-delivery.ts, telegram-transport.ts, mission-runtime.ts, index.ts, test file, report, CURRENT_STATE.md).

## B. What holds (proven PASS, not assumed)

| Invariant | Adversarial proof |
|---|---|
| §4 single mint seam | `put("artifact"|ARTIFACT_ENTITY` exists ONLY in `artifact-authority.ts` (repo-wide grep); validator routes through `service.artifacts.accept`; no other writer |
| §5 durable linkage | A5a: `execution.mission_id` mutated post-create → `FAIL_CLOSED_ARTIFACT_LINKAGE`; executor mismatch → `PRODUCER_MISMATCH`; unknown execution → `EXECUTION_UNKNOWN`; task/mission cross-check vs governed_task enforced |
| §10 source TOCTOU | A10: stat says 5B while file is 9B → `bytes.length !== stat.size` → `FAIL_CLOSED_ARTIFACT_UNRESOLVED`, zero row. Hash always covers exactly the retained buffer (same Buffer object → CAS) |
| §11 CAS crash classes | tmp→fsync→rename→post-rename bounded re-verify; torn write → unlink + `BLOB_WRITE`; corrupt existing blob under expected name → hash mismatch → rewritten; blob-without-row is not authority (only ART rows count); two writers same digest → identical content, last rename wins benign |
| §12b closed-exec NEW upload | rejected `EXECUTION_CLOSED` |
| §13 capability security | separate HMAC domain `pair.artifact-capability.v1`; `timingSafeEqual`; malformed → null; `bcap1` cannot verify as `acap1` and vice versa (A13); token+master registered sensitive; claims bound to execution; master never in prompt (only minted cap); `issued_at` is provenance only — **NO TTL exists** (documented, not claimed) |
| §16 legacy non-promotion | A16: pre-F1 row + real file at old path + fresh store → still `LEGACY_PATH_ONLY`, `canonical:false`, no "file exists" upgrade |
| §17 result contract | A17: remote upload while live → `artifacts:[]` result persisted → validator reconstructs `ART_*` in `artifact_ids`, PASS, no dup |
| §14 tmp collision | `*.tmp-<pid>` sync open/write/fsync/rename is a sync critical section in one process — cannot interleave (informational only) |
| §18 PR #30 non-regression | contract 69/69 · ops 3/3 · helper move verified byte-for-byte identical behavior |

## C. FINDINGS

### F1-1 — ARTIFACT COUNT RACE — **HIGH**

- **Invariant:** ≤32 canonical artifacts per execution under concurrency.
- **Source:** `src/pair/artifact-authority.ts` `accept()` — the `existing` count (`store.list`) and the prior-row `tryGet` run **before** `store.immediate()`; the insert CAS only keys on `artifact_id`, so two DISTINCT-name uploads both observe count=31 and both commit.
- **Reproduction:** audit test A7 — second `PairEvidenceStore` connection with a frozen 31-row view accepts BOTH `n31` and `n32` → `forExecution` returns **33**.
- **Observed:** count exceeds cap under concurrent ingest. (Sequential calls re-read and enforce correctly — the window is real only across interleaved writers.)
- **Expected:** count check inside the same atomic transaction as the insert (or a serialized counter row).
- **Consequence:** bound bypass under concurrency; F2 consumers may see >cap artifact sets.
- **Why missed:** F1 D3 tested duplicate same-id replay (which the version CAS catches), never distinct-name races.
- **Required:** per-execution count enforced atomically — e.g. recount inside `immediate()` and roll back on exceed, or a per-execution counter entity CAS-bumped in the same txn.

### F1-2 — PARENT-DIRECTORY SYMLINK ESCAPE — **HIGH**

- **Invariant:** no bytes outside `allowed_paths` become canonical authority.
- **Source:** `assertNotSymlink` lstats only the FINAL component (`artifact-authority.ts`); validator's `pathWithin` is a pure string-prefix check (`canonical.ts` line 200) — intermediate symlinks are invisible to both.
- **Reproduction:** A8a — `workspace/linkdir -> /tmp/outside`; artifact `linkdir/secret.bin` → validator PASS, canonical `ACCEPTED` row, CAS blob = outside bytes.
- **Observed:** `PASS` validation + canonical `ART_*` authority over `/tmp/outside/secret.bin` bytes.
- **Expected:** `realpathSync` the resolved path AND each parent chain back to the workspace root (or the governed `allowed_paths`); reject when any component resolves outside.
- **Consequence:** a local executor can smuggle ANY host-readable file (`.env`, keys) into canonical artifact authority.
- **Why missed:** symlink check covered the final component only.
- **Required:** realpath containment — `realpath(abs)` must stay within `realpath(allowed_path)`; apply at BOTH validator path check and `assertNotSymlink` in the seam (defense in depth).

### F1-3 — UNBOUNDED HTTP BODY MATERIALIZATION — **HIGH**

- **Invariant:** request body bounded before arbitrary accumulation.
- **Source:** `mission-control-server.ts` `readBody()` (lines 241–249) — `for await` pushes ALL chunks, `Buffer.concat`, `JSON.parse` — before ANY bound. The artifact caps (b64 length, decoded size) run post-parse. Same `readBody` serves BOTH lanes (capability + legacy) and every POST/PUT endpoint.
- **Reproduction:** A9a — 40MB `junk` JSON field + tiny artifact → 200 OK (fully materialized). A9b — >64MB artifact → 413 only AFTER the whole body was buffered and parsed.
- **Observed:** arbitrary-size request bodies fully materialize in RAM.
- **Expected:** hard cap during `readBody` accumulation (e.g. reject at `> ceil(MAX_ARTIFACT_BYTES*4/3) + overhead` bytes total, before concat/parse) — at minimum on `/api/outbox`; ideally global.
- **Consequence:** memory-exhaustion DoS on the public tunnel endpoint.
- **Why missed:** per-field bounds looked sufficient; the transport bound was never instrumented.
- **Required:** streaming byte bound in `readBody` — destroy the request when the running total exceeds the bound.

### F1-4 — CLOSED-EXECUTION REPLAY ORDER — **HIGH**

- **Invariant (mandate §12):** lost-response retry of an EXACT previously-accepted artifact must converge idempotently even after the execution closes; a NEW artifact after close must fail.
- **Source:** `accept()` calls `verifyProducer` (closed-state/result gates) BEFORE the prior-row idempotency check — `artifact-authority.ts` lines ~127–137 vs ~170.
- **Reproduction:** A12a — accept upload while RUNNING → persist `result` (COMPLETED) → retry identical capability+name+bytes → `FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED`, never reaches the prior-row check.
- **Observed:** exact replay after close is rejected — lost-response convergence impossible.
- **Expected:** resolve the deterministic `artifact_id` and, when an identical ACCEPTED row exists, return it idempotently BEFORE lifecycle gates; still verify the SAME producer identity (execution exists, linkage, executor match); new/conflicting uploads still fail at the lifecycle/conflict gates.
- **Consequence:** a retried remote upload after settle fails forever — the client may retry indefinitely or drop a real artifact.
- **Why missed:** F1 E2 tested restart-replay on a still-open execution; nobody replayed post-close.
- **Required:** reorder — identity resolution + prior-row check first; prior-row hit with identical sha converges regardless of lifecycle; lifecycle gates apply to new identities/conflicts only.

### F1-5 — CAPABILITY CLAIMS NOT CROSS-CHECKED VS DURABLE EXECUTION — **MEDIUM**

- **Source:** `acceptArtifactUpload` (`mission-control.ts` ~150–176) verifies HMAC + compares body `mission_id`/`task_id` to claims — but never compares `claims.mission_id` / `claims.task_id` / `claims.governed_task_id` against the durable execution row. `accept()` silently derives mission/task/gt from the execution; a contradictory claim is ignored.
- **Reproduction:** A5b — mint with `mission_id: MSN_DIFFERENT` on an execution of mission M → upload ACCEPTED, row minted under M. A5c — same for `governed_task_id`.
- **Observed:** inconsistent claims are tolerated (row is still correct — durable state wins).
- **Expected:** every claim must equal the durable identity; contradiction → fail closed.
- **Consequence:** defense-in-depth gap — claims are HMAC'd so only a master-holder could mint them, but the mandate requires contradiction rejection, not silent correction.
- **Why missed:** derive-from-state masked the inconsistency.
- **Required:** compare all claim fields to `verifyProducer`'s derived identity → `FAIL_CLOSED_ARTIFACT_CAPABILITY_MISMATCH`.

### F1-6 — BATCH PARTIAL AUTHORITY — **MEDIUM**

- **Invariant question (mandate §6):** must a failed batch leave a prefix of authoritative artifacts?
- **Observed (A6a):** 33 artifacts → 32 `ACCEPTED` rows + validation `FAIL`. A6b: late replay-conflict on b.txt → a.txt `ACCEPTED` + `FAIL`. A6c: injected blob-write failure on the second artifact → first row survives + `FAIL`.
- **Analysis:** each ACCEPTED row is individually truthful (correct identity+bytes+provenance) and **no consumer exists in F1** (read-model only; F2 deferred), so residual authority is currently inert. It is, however, not the batch-atomic shape the validator historically implies.
- **Required (before F2):** either document that per-artifact acceptance is independent authority (safe under any consumer that binds to `execution_validation.status = PASS` first), or roll the ingest batch into one transaction that rolls back rows on later failure. Recommendation: bind F2 consumption to PASS validation, making partial rows unreachable — then document.

### F1-7 — OUTBOX COMPAT FILENAME COLLISION — **MEDIUM**

- **Source:** `mission-control-server.ts` ~370 — `basename(...).replace(/[^\w.\-]/g,"_")` sanitization maps distinct logical names (`a b.txt`, `a?b.txt`) to the SAME compat filename; `${taskPrefix}-${filename}` dest collides.
- **Reproduction:** A14 — two capability uploads → same dest; later bytes overwrite earlier. Both canonical rows correct (distinct ART ids); only the compat outbox file aliases.
- **Observed:** `dests[0] === dests[1]`; file content = second upload's bytes.
- **Consequence:** the delivery-compat outbox can hold bytes belonging to a different artifact than the filename implies — the FILES dispatch pin re-hash catches it at settle (fail-closed), but silently misdelivering-pending-settle is possible in the compat lane.
- **Required:** include a stable discriminator in the compat name (e.g. `sha256[:12]` or the `artifact_id`) so distinct artifacts never share a dest.

### F1-8 — HOST PATH IN UPLOAD RESPONSE — **LOW**

- **Source:** `/api/outbox` capability lane returns `path: outboxPath` — an absolute host path (`/home/.../outbox/T-x.txt`) to the remote executor.
- **Classification:** information disclosure (server filesystem layout to a remote agent), not an authority flaw — the canonical `storage_ref` correctly uses `pair-artifact://`.
- **Required:** drop `path` from the response (or return the `pair-artifact://` ref only).

### F1-9 — NO PARENT-DIR FSYNC AFTER CAS RENAME — **LOW**

- **Source:** `persistBlob` fsyncs the file but not `blobs/` after `renameSync` — a power-loss crash can lose the directory entry while data is durable (Linux ext4 default).
- **Observed:** documented durability gap; blob-verify-on-read partially mitigates (next ingest rewrites).
- **Classification:** durability limitation, not correctness.
- **Required:** `fsyncSync(dirFd)` on the blob dir after each rename (or document the accepted window).

## D. Return-data summary (§24)

| Item | Result |
|---|---|
| PR | https://github.com/vankusi59-svg/pair-next/pull/31 |
| Base SHA | `6ff9d35b33820653c1f0b10cfcb341199ddb3bb0` |
| Audited HEAD | `e0dae9f2df746c58be13bdf7939f9f0be0a79179` |
| Worktree | clean at freeze (porcelain empty); audit test file added untracked during audit only |
| Scope | PASS — no expansion |
| Batch atomicity | **partial authority** — findings F1-6 (FAIL + prefix ACCEPTED observed) |
| Count race | **FAIL** — 33 > cap under concurrent distinct names (F1-1) |
| Symlink escape | **FAIL** — parent-dir symlink canonicalizes outside bytes (F1-2) |
| HTTP body bound | **FAIL** — unbounded accumulation before any cap (F1-3) |
| Replay/lifecycle | **FAIL** — identical replay post-close rejected (F1-4); closed-new-upload correct |
| CAS/crash | PASS with noted limitation F1-9 (no dir fsync) |
| Capability security | PASS except F1-5 (claims not cross-checked); no TTL — documented |
| Outbox concurrency | sync critical section OK; alias collision F1-7 |
| Telegram regression | PASS — contract 69/69, ops 3/3 (unchanged) |
| DAG-leaf | CONFIRMED UNCHANGED (zero diff in plan-dataflow/router/recovery) |
| Focused tests | F1 suite 20/20 + audit suite 18/18 |
| Full regression | 2831 pass / 2 env-only P5 fails / 15 skip — the 2 fails **reproduced on base `6ff9d35`** (VM has dsh/codex binaries; pair-p5 2/22 fail on base identically) |
| tsc | PASS (0 errors) |
| build | PASS |
| pnpm audit --audit-level=high | 0 high/critical (9 low/moderate baseline) |

## E. Verdict

**`P31_F1_CLEAN_ROOM_AUDIT_BLOCKED_R1_REQUIRED`**

STOP. No remediation performed. The 4 HIGH findings (count race, parent-symlink escape, unbounded HTTP body, closed-execution replay order) must be remediated under a separate R1 instruction on this same PR #31 before re-audit.
