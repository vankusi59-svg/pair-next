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
 *    carries a VALID `.pair-tmp-owner` marker (well-formed JSON with a
 *    positive integer pid and a positive timestamp) — prefix and age
 *    alone are never sufficient proof of ownership;
 *  - a marker whose pid is live, inaccessible, or uncertain (EPERM and
 *    any non-ESRCH liveness-check outcome) is treated as ALIVE — only
 *    confirmed process absence (ESRCH) may qualify a dir for
 *    reclamation, and even then the age gate still applies;
 *  - missing, malformed, or unreadable markers are never deleted —
 *    such residue is handled by the opt-in recovery tool
 *    `scripts/dev-verification/tmp-recover.mts` (dry-run by default,
 *    explicit path selection, `--confirm` approval);
 *  - never recursively sweeps the whole TEMP root;
 *  - every delete is per-path `rmSync` inside try/catch — a locked or
 *    foreign dir is skipped, never fatal.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
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

/** Unlink every reparse point (symlink/junction) inside `dir` without
 *  following it. Mandatory pre-pass before `rmSync`: Node ≥24's native
 *  rmSync classifies mount-point junctions as directories and would
 *  descend into the junction TARGET — deleting real files outside the
 *  link. lstat().isSymbolicLink() flags junctions on every supported
 *  Node version, so unlinking them first bounds deletion to the dir's
 *  own contents on all engines.
 *
 *  Returns false — aborting the caller's rmSync — whenever certainty
 *  is lost: a link that cannot be unlinked, a subdirectory that cannot
 *  be listed (it may hide links), or the recursion ceiling. Never
 *  falls through into an unverified recursive delete. */
export function unlinkReparsePoints(dir: string, depth = 0): boolean {
  if (depth > 64) return false;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // cannot inspect → cannot prove link-free → abort
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      const lst = lstatSync(p);
      if (lst.isSymbolicLink()) {
        try {
          unlinkSync(p); // unlink the link itself, never its target
        } catch {
          return false; // link survived → recursive delete unsafe
        }
      } else if (lst.isDirectory() && !unlinkReparsePoints(p, depth + 1)) {
        return false;
      }
    } catch {
      /* A dir OR link whose lstat fails is unverifiable — it might be
       * (or hide) a reparse point. Abort rather than let rmSync reach
       * it. Plain files carry no traversal risk. */
      if (e.isDirectory() || e.isSymbolicLink()) return false;
    }
  }
  return true;
}

/** Safe recursive removal: refuses to delete through a reparse point.
 *  A top-level link is UNLINKED (never traversed); a real dir is only
 *  rmSync'd after the pre-pass proves no link survives inside. */
export function safeRemoveDir(dir: string): boolean {
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      unlinkSync(dir); // remove the link entry itself — target intact
      return true;
    }
    if (!unlinkReparsePoints(dir)) return false; // abort, no rmSync
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    return true;
  } catch {
    return false;
  }
}

/** rm a single dir, tolerating Windows file locks via rmSync retries
 *  and swallowing terminal failures (ENOENT, EPERM, EBUSY residue). */
function removeDir(dir: string): boolean {
  return safeRemoveDir(dir);
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
  // The prefix becomes a path component under tmpdir() — reject any
  // form that could escape the root (traversal, separators, drives).
  if (!prefix || /[\\/]|:|\.\./.test(prefix)) {
    throw new Error(`mkTmpDir: unsafe prefix "${prefix}"`);
  }
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

/** Liveness probe — default for the sweep, injectable for tests.
 *  Only a CONFIRMED absence (ESRCH) reports dead. EPERM ("the pid
 *  exists but we may not signal it") and every other error are
 *  uncertain → treated as alive. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export type OwnerStatus = "live" | "orphan" | "invalid";

/** Read and validate a dir's ownership marker. A marker is only valid
 *  if it parses as JSON carrying a positive integer pid and a positive
 *  timestamp — anything else is "invalid" (never deletable by the
 *  sweep). */
export function ownerStatusOf(
  dir: string,
  isAlive: (pid: number) => boolean = pidIsAlive,
): { status: OwnerStatus; ts?: number } {
  const markerPath = join(dir, OWNER_MARKER);
  let owner: { pid?: unknown; ts?: unknown };
  try {
    // Bound the read: a planted multi-GB marker must not stall/OOM the
    // sweep. Real markers are <100 bytes; anything oversized is
    // treated as invalid → the dir is skipped, never auto-deleted.
    if (statSync(markerPath).size > 65536) return { status: "invalid" };
    owner = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { status: "invalid" };
  }
  const { pid, ts } = owner ?? {};
  if (!Number.isInteger(pid) || (pid as number) <= 0) return { status: "invalid" };
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return { status: "invalid" };
  return { status: isAlive(pid as number) ? "live" : "orphan", ts: ts as number };
}

function dirSize(dir: string, depth = 0): number {
  let bytes = 0;
  if (depth > 64) return 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      try {
        const lst = lstatSync(p); // lstat only — never follow links
        if (lst.isSymbolicLink()) bytes += lst.size;
        else if (lst.isDirectory()) bytes += dirSize(p, depth + 1);
        else bytes += lst.size;
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
  /** Test seam — override liveness probing. Production callers must
   *  leave this unset so the real `pidIsAlive` is used. */
  isAlive?: (pid: number) => boolean;
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
    // Reparse-point gate — BEFORE any marker inspection or deletion:
    // statSync follows links, so a top-level junction could otherwise
    // qualify on its TARGET's marker and let the pre-pass/rmSync
    // mutate outside the authorized root. lstat sees the entry itself.
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        res.skipped++;
        continue;
      }
    } catch {
      res.skipped++;
      continue;
    }
    // Canonical containment: the realpath must remain a direct child
    // of the real temp root — no mid-path traversal may escape it.
    try {
      const real = realpathSync(dir);
      if (real !== join(root, name) && real !== dir) {
        res.skipped++;
        continue;
      }
    } catch {
      res.skipped++;
      continue;
    }
    // Ownership gate: a VALID marker is mandatory — prefix + age are
    // not proof. Missing/malformed/unreadable markers and any pid that
    // is live, inaccessible, or uncertain all SKIP; only a confirmed-
    // dead (ESRCH) owner proceeds to the age gate.
    const owner = ownerStatusOf(dir, opts?.isAlive);
    if (owner.status !== "orphan") {
      res.skipped++;
      continue;
    }
    // The marker's `ts` is the staleness proxy (dir mtime ignores
    // content writes; a long-lived suite's dir is not stale).
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || (owner.ts as number) > cutoff) {
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
    let bytes = 0;
    try {
      bytes = dirSize(dir);
    } catch {
      /* pathological depth — measure what we could, still removable */
    }
    if (removeDir(dir)) {
      res.removed++;
      res.bytesFreed += bytes;
    } else {
      res.skipped++;
    }
  }
  return res;
}
