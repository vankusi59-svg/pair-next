/**
 * tmp-recover — opt-in recovery tool for historical test temp dirs.
 *
 * The automatic `sweepStaleTestDirs()` only reclaims dirs carrying a
 * VALID `.pair-tmp-owner` marker with a confirmed-dead pid. Residue
 * that predates the marker (or has a damaged one) is NEVER deleted
 * automatically — this tool is the manual path.
 *
 * Defaults to DRY-RUN listing. Deletion requires BOTH:
 *   --paths <dir>[,<dir>...]   explicit path selection (no globs)
 *   --confirm                  owner approval for real deletion
 *
 * Even with --confirm it refuses:
 *   - paths outside the real OS temp root
 *   - prefixes not on the repo test allowlist
 *   - dirs with a live/inaccessible owner pid
 *
 * Usage:
 *   npx tsx scripts/dev-verification/tmp-recover.mts                 # dry-run list
 *   npx tsx scripts/dev-verification/tmp-recover.mts --min-age 3600  # older than N s
 *   npx tsx scripts/dev-verification/tmp-recover.mts \
 *     --paths "C:\\Users\\x\\AppData\\Local\\Temp\\pair-abc" --confirm
 */
import { readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  TEST_TMP_PREFIXES,
  ownerStatusOf,
  safeRemoveDir,
} from "../../src/test-utils/tmpdir.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const root = (() => {
  try {
    return realpathSync(tmpdir()); // real, not lexical — junction-safe
  } catch {
    return resolve(tmpdir());
  }
})();

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
      } catch { /* locked entry */ }
    }
  } catch { /* unreadable */ }
  return bytes;
}

function fmtMb(b: number): string {
  return `${(b / 1048576).toFixed(1)}MB`;
}

function allowedPrefix(name: string): boolean {
  return TEST_TMP_PREFIXES.some((p) => name.startsWith(p));
}

/** Validate an explicit deletion candidate. Returns a refusal reason
 *  or null when deletion is permitted.
 *
 *  Containment is checked on REALPATHS and restricted to DIRECT
 *  children of the temp root: a `--paths` argument routed through an
 *  intermediate junction would otherwise pass the lexical prefix test
 *  while rmSync resolves it outside the root. Direct-children-only
 *  also closes the ancestor-ownership gap — a subdir of a live-owned
 *  test dir can never be targeted because only the marked root itself
 *  is addressable. */
function refusal(dir: string): string | null {
  const abs = resolve(dir);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return "unreadable";
  }
  if (!real.startsWith(root + sep)) return "outside-temp-root";
  const rel = real.slice(root.length + sep.length);
  if (rel.includes(sep)) return "not-a-direct-child-of-temp-root";
  if (!allowedPrefix(rel)) return "prefix-not-allowlisted";
  let st;
  try {
    st = statSync(abs);
  } catch {
    return "unreadable";
  }
  if (!st.isDirectory()) return "not-a-directory";
  if (lstatSync(abs).isSymbolicLink()) return "reparse-point";
  const owner = ownerStatusOf(abs);
  if (owner.status === "live") return "live-owner-pid";
  return null;
}

const pathsArg = opt("paths");
const confirm = flag("confirm");
const minAgeSec = Number(opt("min-age") ?? "0");

if (confirm && !pathsArg) {
  console.error("REFUSED: --confirm requires explicit --paths selection.");
  process.exit(2);
}

if (pathsArg) {
  const targets = pathsArg.split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of targets) {
    const reason = refusal(t);
    if (reason) {
      console.log(`SKIP  ${t}  (${reason})`);
      continue;
    }
    const bytes = dirSize(t);
    if (!confirm) {
      console.log(`DRY   ${t}  ${fmtMb(bytes)} — pass --confirm to delete`);
      continue;
    }
    if (safeRemoveDir(t)) {
      console.log(`DEL   ${t}  ${fmtMb(bytes)}`);
    } else {
      console.log(`FAIL  ${t}  removal aborted (lock or unsafe link)`);
      process.exitCode = 1;
    }
  }
  if (!confirm) console.log("\nDry-run. Re-run with --confirm to delete the listed paths.");
  process.exit(0);
}

// Listing mode — never deletes.
console.log(`Scanning ${root} (allowlisted prefixes, min-age ${minAgeSec}s)…\n`);
const cutoff = Date.now() - minAgeSec * 1000;
let count = 0;
let bytes = 0;
let entries: string[];
try {
  entries = readdirSync(root);
} catch (e) {
  console.error(`Cannot read temp root: ${(e as Error).message}`);
  process.exit(2);
}
for (const name of entries) {
  if (!allowedPrefix(name)) continue;
  const dir = join(root, name);
  let st;
  try {
    st = statSync(dir);
  } catch {
    continue;
  }
  if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
  const owner = ownerStatusOf(dir);
  const sz = dirSize(dir);
  count++;
  bytes += sz;
  const ageH = ((Date.now() - st.mtimeMs) / 3600000).toFixed(1);
  console.log(
    `${owner.status.padEnd(7)} ${ageH.padStart(6)}h ${fmtMb(sz).padStart(9)}  ${dir}`,
  );
}
console.log(`\n${count} dirs, ${fmtMb(bytes)} total.`);
console.log("Deletion is opt-in: --paths <dir>[,<dir>...] --confirm");
