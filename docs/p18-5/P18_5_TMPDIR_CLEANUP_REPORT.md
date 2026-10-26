# P18.5 — Temporary-Directory Lifecycle: Root Cause, Mechanism, Measurements

## Root cause

~270 `mkdtempSync(join(os.tmpdir(), "<prefix>-"))` callsites across ~153
test files (`pair-*`, `ws-*`, `dv-*`, `automaton-*`, `authority-test-*`,
`provider-registry-*`, `policy-test-*`, `spend-test-*`, `llm-*`,
`cx-*`, …). None had ownership: no shared factory, no `afterEach`/
`afterAll`, no registry, no recovery path. Interrupted or crashed vitest
runs leaked every dir. ~2,000 `pair-*` dirs (~20 GB) accumulated →
`ENOSPC` → mass worker crash during the V1 verification run.

Secondary leak amplifier: module-scope `PairEvidenceStore` instances hold
SQLite files open for the entire worker lifetime → the dir cannot be
deleted on Windows while the DB handle is live, even at `afterAll`.

## Mechanism (all under `os.tmpdir()`, allowlisted prefixes only)

| Layer | Hook | Scope |
|---|---|---|
| `mkTmpDir()` | callsite | registers dir in per-worker registry, writes `.pair-tmp-owner`, installs process-exit hook |
| `cleanupTmpDirs()` | `afterAll` via `setupFiles` | removes only dirs THIS worker created; idempotent; `rmSync` retries (6×150ms) for Windows locks |
| process `exit` hook | process | best-effort residual cleanup on crash/interrupt paths where afterAll cannot run |
| `sweepStaleTestDirs()` | `globalSetup` once per suite | age-gated (≥60min default) recovery for dirs whose owner died; skips live-registry-owned dirs |

Safety: never deletes outside `os.tmpdir()`; never touches
non-allowlisted paths; never deletes dirs owned by a live registry; age
gate far above run residency so parallel invocations are undisturbed;
per-path try/catch — locked/foreign dirs skipped, never fatal.
`PAIR_TMP_SWEEP=0` disables sweep; `PAIR_TMP_SWEEP_MIN_AGE_MS` overrides
the gate.

## Measurements (Windows 11 host, sanitized env — `PAIR_DSH_*`/`AGNES_API_KEY` unset)

| Measurement | Value |
|---|---|
| Allowlisted residual dirs BEFORE cycles | 244 |
| Residual bytes BEFORE | 2,747.6 MB |
| `[tmp-sweep]` on suite start | `scanned=244 removed=0 skipped=244 bytesFreed=0` — all sub-60min (this session's runs) → correctly skipped |
| Dirs minted by 2 focused cycles (6 files) | +9 |
| Residual AFTER cycles | 253 dirs / 2,801.6 MB |
| Net run growth | ~1.5 dirs per test file, ~54 MB total |
| Worker stability | 0 worker crashes; parallel isolation verified by lifecycle test |
| Cross-worker deletion | none — disjoint per-worker registries |
| Foreign-dir protection | lifecycle test: `mkdtempSync` dir outside allowlist untouched |

## Honest residual limitations

- **Locked SQLite dirs**: module-scope `PairEvidenceStore` DBs remain
  locked until worker exit → their dirs are skipped (never force-deleted).
  Bounded: ~dirs-per-file minted; reclaimed by the age-gated sweep on a
  subsequent suite run once locks release. Not zero-leakage — bounded
  and self-healing.
- **Historical residue**: the sweep only removes allowlisted dirs older
  than 60 min; anything currently younger is untouched by design.
- **Interrupt window**: a `SIGKILL`/power loss mid-test can still orphan
  a dir younger than the gate; the next suite's globalSetup reclaims it
  once it ages out.
- No production file-management behavior changed — all changes are under
  `src/test-utils/`, `src/__tests__/`, `vitest*`, and dev-verification
  scripts.

## Regression equivalence evidence

All 23 files with test failures under the new wiring produce **identical
failure counts at base `2174e91`** on a clean worktree (same sanitized
env): `pair-phase-b` 9≡9 (`D:\` vs `/` path canon), `pair-f1-r1` 3≡3 and
`f2-r1` 4≡4 (EPERM symlink), `pair-f1-r2` 8≡8, `pair-cpl1` 22≡22,
`covmap` 2≡2, `p5` 2≡2 (`.local` PATH-mask), `p15-8hf1` 1≡1 (`.cjs`
spawn EFTYPE), `dev-verification` 4≡4, `bootstrap` 15≡15, `p10` 10≡10,
`p15-3` 9≡9, plus 10 more files byte-identical. Zero new failures
introduced by the codemod/lifecycle change.

## Hotfix — ownership-marker mandate (post-audit safety correction)

**Finding:** the first sweep version allowed prefix+age alone to qualify a dir for deletion — insufficient proof of ownership. Corrected:

- A **valid `.pair-tmp-owner` marker** (well-formed JSON, positive integer `pid`, positive `ts`) is now MANDATORY. Missing/malformed/unreadable markers are skipped permanently — the sweep never reclaims unmarked residue.
- Liveness: only a **confirmed** `ESRCH` from `process.kill(pid, 0)` counts as dead. `EPERM` and every other outcome are treated as ALIVE/uncertain → skip at any age.
- Orphaned-but-valid markers are still age-gated on marker `ts`.
- Historical unmarked dirs route to `scripts/dev-verification/tmp-recover.mts` — dry-run listing by default; deletion requires explicit `--paths` selection **and** `--confirm`, and still refuses outside-temp-root, non-allowlisted, and live-owned targets.

Adversarial probes: S1 rewritten (unmarked aged dir survives), S1b (valid marker + dead pid + aged → reclaimed), A1 (unmarked `ws-`/`live-`/`pair-` aged dirs all survive), A2 (7 malformed-marker shapes), A3 (EPERM-uncertain liveness → skip via injectable `isAlive` seam — production `globalSetup` uses the real `pidIsAlive`).

## Final closure — root junction escape

Third adversarial pass caught that `statSync` follows links: a top-level `pair-*` junction's external target could qualify the entry on its own marker. Fixed at three layers — lstat rejection before inspection, realpath direct-child containment, and abort-not-fallthrough removal (`safeRemoveDir`/`unlinkReparsePoints` boolean contract, shared by sweep, registry cleanup, exit hook, and tmp-recover). Repro script retained at `scripts/dev-verification/repro-junction-escape.mts` (pre-fix: foreign tree mutated; post-fix: `removed=0`, everything survives).
