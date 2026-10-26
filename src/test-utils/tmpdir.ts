/**
 * Test temporary-directory lifecycle — P18.5 hardening.
 *
 * Incident: ~2,000 `pair-*` mkdtemp dirs (~20 GB) accumulated under
 * %TEMP% across historical runs because tests created dirs with raw
 * `mkdtempSync(join(tmpdir(), "..."))` and nothing owned the cleanup —
 * no afterEach/afterAll, no global sweep. Under disk pressure the
 * workers then crashed en-masse with ENOSPC.
 *
 * This module is the single owned path:
 *  - `mkTmpDir(prefix)` — drop-in for `mkdtempSync(join(tmpdir(), p))`;
 *    registers the dir in a per-worker registry and installs a
 *    best-effort `process.on("exit")` cleanup.
 *  - `cleanupTmpDirs()` — idempotent, retry-tolerant recursive delete
 *    of registered dirs only (wired via vitest `setupFiles` afterAll).
 *  - `sweepStaleTestDirs()` — recovery net for dirs whose owner died
 *    (SIGKILL, crash, interrupted run): allowlist-prefix + age-gated,
 *    under `os.tmpdir()` only. Wired via vitest `globalSetup` so it
 *    runs once per suite invocation, before workers spawn.
 *
 * Safety invariants:
 *  - never deletes outside `os.tmpdir()`;
 *  - never deletes a path this process did not create unless it
 *    matches the explicit stale-prefix allowlist AND is older than
 *    `PAIR_TMP_SWEEP_MIN_AGE_MS` (default 60 min — longer than any
 *    expected single test-run residency);
 *  - never recursively sweeps the whole TEMP root;
 *  - every delete is per-path `rmSync` inside try/catch — a locked or
 *    foreign dir is skipped, never fatal.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Directory prefixes this repository's test suite is known to mint
 *  (enumerated from the callsite sweep — keep in sync when adding a
 *  new literal prefix). Anything not listed here is never touched by
 *  the stale sweep, even if it looks test-shaped. */
export const TEST_TMP_PREFIXES: readonly string[] = [
  "pair-",
  "dv-",
  "ws-",
  "ws2-",
  "w2-",
  "ht-",
  "devin-gate-",
  "outside-",
  "other-ws-",
  "automaton-",
  "authority-test-",
  "policy-test-",
  "spend-test-",
  "provider-registry-",
  "hb-yaml-test-",
  "hb-zero-test-",
  "workspace-test-",
  "workspace-home-",
  "base-harness-",
  "coding-harness-",
  "harness-wisdom-",
  "orchestrator-harness-",
  "local-worker-harness-",
  "llm-",
  "live-",
  "cx-",
  "src-repo-",
];

/** Marker written inside each factory-created dir: proves the dir is a
 *  test artifact and records which process made it. */
const OWNER_MARKER = ".pair-tmp-owner";

/** Default stale age for the recovery sweep — a live parallel worker's
 *  dir must never qualify, so the floor is far above any expected run
 *  duration. Override via PAIR_TMP_SWEEP_MIN_AGE_MS. */
const DEFAULT_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/** Hard floor on the env-configured age — a mistyped
 *  PAIR_TMP_SWEEP_MIN_AGE_MS can never shrink the gate below a value a
 *  live parallel run could trip. Opts-passed ages (tests) stay
 *  unclamped; the marker-pid liveness guard protects live dirs at any
 *  gate. */
const ENV_SWEEP_FLOOR_MS = 5 * 60 * 1000;

const registry = new Set<string>();
let exitHookInstalled = false;

function safeReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** rm a single dir, tolerating Windows file locks via rmSync retries
 *  and swallowing terminal failures (ENOENT, EPERM, EBUSY residue). */
function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    return true;
  } catch {
    return false;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous best-effort on exit — covers Ctrl+C/SIGINT paths where
  // afterAll still runs, and shrinks the window where a kill can leak.
  process.once("exit", () => {
    for (const dir of registry) removeDir(dir);
    registry.clear();
  });
}

/** Drop-in replacement for `mkdtempSync(join(tmpdir(), prefix))` that
 *  also registers the dir for lifecycle cleanup. Nested mkdtemp calls
 *  inside an owned root do not need this — the root's removal covers
 *  them. */
export function mkTmpDir(prefix: string): string {
  installExitHook();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // Register both spellings — cleanup must find the dir whichever form
  // a test hands back — but RETURN the raw mkdtempSync path exactly as
  // the original API did (workspace/digest assertions compare verbatim
  // path strings; a realpath-normalized return changed semantics).
  registry.add(dir);
  registry.add(safeReal(dir));
  try {
    writeFileSync(
      join(dir, OWNER_MARKER),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
  } catch {
    /* marker is advisory only */
  }
  return dir;
}

/** Idempotent cleanup of every dir this worker created through
 *  `mkTmpDir`. Safe to call repeatedly and on failure paths. Returns
 *  the number of dirs still missing/removed vs. skipped. */
export function cleanupTmpDirs(): { removed: number; skipped: number } {
  let removed = 0;
  let skipped = 0;
  for (const dir of [...registry]) {
    if (removeDir(dir)) {
      registry.delete(dir);
      removed++;
    } else {
      skipped++;
    }
  }
  return { removed, skipped };
}

export interface SweepResult {
  scanned: number;
  removed: number;
  skipped: number;
  bytesFreed: number;
}

function dirSize(dir: string): number {
  let bytes = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) bytes += dirSize(p);
        else bytes += statSync(p).size;
      } catch {
        /* locked entry — ignore */
      }
    }
  } catch {
    /* unreadable dir — ignore */
  }
  return bytes;
}

/** Recovery sweep for leaked test dirs whose owner died before
 *  cleanup. Prefix-allowlisted + age-gated, strictly under os.tmpdir().
 *  Returns measured results — never claims zero leakage silently. */
export function sweepStaleTestDirs(opts?: {
  minAgeMs?: number;
  extraPrefixes?: readonly string[];
}): SweepResult {
  if (process.env.PAIR_TMP_SWEEP === "0") {
    return { scanned: 0, removed: 0, skipped: 0, bytesFreed: 0 };
  }
  const envAge = Number(process.env.PAIR_TMP_SWEEP_MIN_AGE_MS ?? NaN);
  const minAge =
    opts?.minAgeMs ??
    (Number.isFinite(envAge) && envAge >= 0
      ? Math.max(envAge, ENV_SWEEP_FLOOR_MS)
      : DEFAULT_SWEEP_MIN_AGE_MS);
  const prefixes = [...TEST_TMP_PREFIXES, ...(opts?.extraPrefixes ?? [])];
  const root = safeReal(tmpdir());
  const cutoff = Date.now() - minAge;
  const res: SweepResult = { scanned: 0, removed: 0, skipped: 0, bytesFreed: 0 };
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return res;
  }
  for (const name of entries) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(root, name);
    res.scanned++;
    // Live-owner guard: a `.pair-tmp-owner` marker with a LIVE pid means
    // the dir belongs to a running worker — untouchable at any age gate.
    // The marker's `ts` is also the better staleness proxy (dir mtime
    // ignores content writes; a long-lived suite's dir is not stale).
    let markerTs: number | undefined;
    try {
      const raw = readFileSync(join(dir, OWNER_MARKER), "utf8");
      const owner = JSON.parse(raw) as { pid?: number; ts?: number };
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          res.skipped++;
          continue; // live owner — never sweep
        } catch {
          /* dead pid — orphaned dir, age gate applies */
        }
      }
      if (typeof owner.ts === "number") markerTs = owner.ts;
    } catch {
      /* no marker — pre-factory residue; mtime fallback */
    }
    try {
      const st = statSync(dir);
      const ageBasis = markerTs ?? st.mtimeMs;
      if (!st.isDirectory() || ageBasis > cutoff) {
        res.skipped++;
        continue;
      }
    } catch {
      res.skipped++;
      continue;
    }
    // Never delete a dir this live process still owns.
    if (registry.has(dir) || registry.has(safeReal(dir))) {
      res.skipped++;
      continue;
    }
    const bytes = dirSize(dir);
    if (removeDir(dir)) {
      res.removed++;
      res.bytesFreed += bytes;
    } else {
      res.skipped++;
    }
  }
  return res;
}
