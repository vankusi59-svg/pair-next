/**
 * P18.5 — temp-dir lifecycle contract: mkTmpDir registry cleanup,
 * idempotence, Windows-lock tolerance, and the age/prefix-gated stale
 * sweep. Proves the remediation owns only its own artifacts and never
 * touches foreign or fresh temp entries.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkTmpDir,
  cleanupTmpDirs,
  sweepStaleTestDirs,
  TEST_TMP_PREFIXES,
} from "../test-utils/tmpdir.js";

/** Owns every scratch dir this suite creates outside the factory. */
const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

const foreign = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

const ageDir = (dir: string, ageMs: number) => {
  const old = new Date(Date.now() - ageMs);
  utimesSync(dir, old, old);
};

describe("TMP-LC — mkTmpDir lifecycle", () => {
  it("L1 — mkTmpDir creates a marked dir under the OS temp root", () => {
    const d = mkTmpDir("pair-tmplc-");
    expect(d).toContain("pair-tmplc-");
    expect(existsSync(join(d, ".pair-tmp-owner"))).toBe(true);
    cleanupTmpDirs();
    expect(existsSync(d)).toBe(false);
  });

  it("L2 — cleanupTmpDirs is idempotent and survives prior deletion", () => {
    const a = mkTmpDir("pair-tmplc-");
    const b = mkTmpDir("pair-tmplc-");
    rmSync(a, { recursive: true, force: true });
    const first = cleanupTmpDirs();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    const second = cleanupTmpDirs();
    expect(second.removed).toBe(0);
    expect(first.removed + first.skipped).toBeGreaterThan(0);
  });

  it("L3 — nested children under an owned root are covered by root cleanup", () => {
    const root = mkTmpDir("pair-tmplc-");
    const nested = mkdtempSync(join(root, "ws-"));
    writeFileSync(join(nested, "f.txt"), "x");
    cleanupTmpDirs();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(nested)).toBe(false);
  });

  it("L4 — cleanup survives a locked/held entry (retry-tolerant)", () => {
    const d = mkTmpDir("pair-tmplc-");
    const f = join(d, "held.txt");
    writeFileSync(f, "x");
    // Read-only-ish content is still removable on Windows; a busy file
    // would exercise the rmSync retry path — either way cleanup must
    // not throw.
    const res = cleanupTmpDirs();
    expect(res.removed + res.skipped).toBeGreaterThan(0);
  });
});

describe("TMP-LC — stale sweep safety", () => {
  it("S1 — an aged allowlisted dir with NO owner marker is never swept", () => {
    const old = foreign("pair-tmplc-");
    ageDir(old, 2 * 60 * 60 * 1000);
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    // Prefix + age are NOT proof of ownership — no marker → skip.
    expect(existsSync(old)).toBe(true);
  });

  it("S1b — reclaim still works: valid marker + confirmed-dead pid + aged", () => {
    const orphan = foreign("pair-tmplc-");
    writeFileSync(
      join(orphan, ".pair-tmp-owner"),
      JSON.stringify({ pid: 999999999, ts: Date.now() - 2 * 60 * 60 * 1000 }),
    );
    ageDir(orphan, 2 * 60 * 60 * 1000);
    const res = sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    expect(existsSync(orphan)).toBe(false);
    expect(res.removed).toBeGreaterThanOrEqual(1);
    scratch.splice(scratch.indexOf(orphan), 1);
  });

  it("A1 — aged foreign dirs on every allowlisted prefix shape survive unmarked", () => {
    for (const prefix of ["ws-", "live-", "pair-"]) {
      const d = foreign(prefix);
      ageDir(d, 48 * 60 * 60 * 1000);
    }
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    for (const d of scratch) expect(existsSync(d)).toBe(true);
  });

  it("A2 — malformed owner markers are never proof of ownership", () => {
    const cases: Array<[string, string]> = [
      ["garbage", "not-json{{{"],
      ["no-pid", JSON.stringify({ ts: Date.now() - 86400000 })],
      ["no-ts", JSON.stringify({ pid: 999999999 })],
      ["pid-string", JSON.stringify({ pid: "999999999", ts: 1 })],
      ["pid-zero", JSON.stringify({ pid: 0, ts: 1 })],
      ["ts-negative", JSON.stringify({ pid: 999999999, ts: -5 })],
      ["ts-string", JSON.stringify({ pid: 999999999, ts: "old" })],
      ["pid-float", JSON.stringify({ pid: 1.5, ts: 1 })],
      ["ts-future", JSON.stringify({ pid: 999999999, ts: Date.now() + 86400000 })],
      ["empty-file", ""],
    ];
    const dirs = cases.map(([label, content]) => {
      const d = foreign(`pair-tmplc-${label}-`.replace(/-+$/, "-"));
      writeFileSync(join(d, ".pair-tmp-owner"), content);
      ageDir(d, 48 * 60 * 60 * 1000);
      return d;
    });
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });

  it("A3 — uncertain owner liveness (non-ESRCH) is treated as ALIVE", () => {
    const uncertain = foreign("pair-tmplc-");
    writeFileSync(
      join(uncertain, ".pair-tmp-owner"),
      JSON.stringify({ pid: 424242, ts: Date.now() - 48 * 60 * 60 * 1000 }),
    );
    ageDir(uncertain, 48 * 60 * 60 * 1000);
    // EPERM-style outcome → treated alive → skip even though ancient.
    sweepStaleTestDirs({
      minAgeMs: 60 * 60 * 1000,
      isAlive: () => true,
    });
    expect(existsSync(uncertain)).toBe(true);
  });

  it("A4 — removal unlinks junctions instead of descending into targets", () => {
    // Node ≥24 rmSync classifies mount-point junctions as directories
    // and would delete the TARGET's contents — the pre-pass must
    // unlink the reparse point first. Junctions need no privilege on
    // Windows, so this runs unprivileged.
    const target = foreign("pair-tmplc-target-");
    writeFileSync(join(target, "keep.txt"), "precious");
    const mine = mkTmpDir("pair-tmplc-");
    symlinkSync(target, join(mine, "esc"), "junction");
    cleanupTmpDirs();
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("A5 — mkTmpDir rejects prefixes that could escape the temp root", () => {
    for (const bad of ["../x-", "a\\b-", "a/b-", "C:x-", ".."]) {
      expect(() => mkTmpDir(bad)).toThrow();
    }
  });

  it("A6 — top-level junction with a marker-bearing external target is rejected before inspection", () => {
    // The independently-reproduced escape: %TEMP%\pair-* junction →
    // dir OUTSIDE the temp root carrying a valid dead-pid marker.
    // Vulnerable code statSync'd through the link, qualified the
    // target's marker, then walked/mutated the foreign tree.
    // Stage the victim beneath a non-allowlisted parent: never a
    // direct child of the temp root, so the sweep cannot reach it
    // except THROUGH the planted junction.
    const staging = foreign("escape-staging-");
    const victim = join(staging, "victim");
    const deep = join(staging, "deep");
    mkdirSync(victim);
    mkdirSync(deep);
    writeFileSync(join(victim, ".pair-tmp-owner"),
      JSON.stringify({ pid: 999999999, ts: Date.now() - 48 * 3600 * 1000 }));
    writeFileSync(join(victim, "keep.txt"), "precious");
    symlinkSync(deep, join(victim, "nest"), "junction");
    const junc = join(tmpdir(), `pair-tmplc-junc${process.pid}-`);
    symlinkSync(victim, junc, "junction");
    try {
      sweepStaleTestDirs({ minAgeMs: 60 * 1000 });
      // Junction entry rejected BEFORE marker read → victim untouched.
      expect(existsSync(junc)).toBe(true); // skipped, never unlinked
      expect(existsSync(join(victim, "keep.txt"))).toBe(true);
      expect(existsSync(join(victim, "nest"))).toBe(true); // foreign tree unmutated
      // res.removed may legitimately count real stale residue on the
      // host — the invariant is OUR junction never qualified (asserted
      // above: link, victim tree, and nested junction all survive).
    } finally {
      rmSync(junc, { recursive: true, force: true }); // unlink link only
    }
  });

  it("A7 — removal aborts on unverifiable depth instead of unsafe rmSync", () => {
    // A tree deeper than the recursion ceiling cannot be proven
    // link-free → safeRemoveDir must abort, never fall through.
    const mine = mkTmpDir("pair-tmplc-");
    let p = mine;
    for (let i = 0; i < 70; i++) {
      p = join(p, "d");
      mkdirSync(p);
    }
    writeFileSync(join(p, "leaf.txt"), "deep");
    const res = cleanupTmpDirs();
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(existsSync(mine)).toBe(true);
    scratch.push(mine); // scratch teardown removes the residue
  });

  it("A8 — safeRemoveDir unlinks a top-level link, never traverses it", async () => {
    const { safeRemoveDir } = await import("../test-utils/tmpdir.js");
    const target = foreign("pair-tmplc-srt-");
    writeFileSync(join(target, "keep.txt"), "precious");
    const link = join(foreign("pair-tmplc-srl-"), "l");
    symlinkSync(target, link, "junction");
    expect(safeRemoveDir(link)).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    // And a real dir with a nested junction: link unlinked, target kept.
    const t2 = foreign("pair-tmplc-srt2-");
    const mine = foreign("pair-tmplc-srm-");
    symlinkSync(t2, join(mine, "esc"), "junction");
    writeFileSync(join(t2, "keep2.txt"), "precious2");
    expect(safeRemoveDir(mine)).toBe(true);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(t2, "keep2.txt"))).toBe(true);
  });

  it("S2 — sweep never touches fresh dirs or non-allowlisted prefixes", () => {
    const fresh = foreign("pair-tmplc-");
    const alien = foreign("not-a-test-prefix-");
    ageDir(alien, 3 * 60 * 60 * 1000);
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(alien)).toBe(true);
  });

  it("S3 — sweep never removes a dir owned by the live registry", () => {
    const mine = mkTmpDir("pair-tmplc-");
    ageDir(mine, 2 * 60 * 60 * 1000);
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    expect(existsSync(mine)).toBe(true);
    cleanupTmpDirs();
  });

  it("S4 — PAIR_TMP_SWEEP=0 disables the sweep entirely", () => {
    const old = foreign("pair-tmplc-");
    ageDir(old, 2 * 60 * 60 * 1000);
    process.env.PAIR_TMP_SWEEP = "0";
    try {
      const res = sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
      expect(res.scanned).toBe(0);
      expect(existsSync(old)).toBe(true);
    } finally {
      delete process.env.PAIR_TMP_SWEEP;
    }
  });

  it("S5 — allowlist covers the repo's known prefixes, nothing else", () => {
    expect(TEST_TMP_PREFIXES).toContain("pair-");
    expect(TEST_TMP_PREFIXES).toContain("dv-");
    expect(TEST_TMP_PREFIXES).toContain("ws-");
    for (const p of TEST_TMP_PREFIXES) {
      expect(p.endsWith("-")).toBe(true);
      expect(p.length).toBeGreaterThan(2);
    }
  });

  it("S6 — sweep stays strictly under the OS temp root", () => {
    const cwdScoped = join(process.cwd(), ".tmp-general-harness-test-");
    mkdirSync(cwdScoped, { recursive: true });
    try {
      // Default-gated sweep only — a zero-age global sweep inside a
      // worker could hit sibling runs' markerless dirs (audit fix).
      sweepStaleTestDirs();
      expect(existsSync(cwdScoped)).toBe(true);
    } finally {
      rmSync(cwdScoped, { recursive: true, force: true });
    }
  });

  it("S7 — live-pid owner marker shields a stale-aged dir; dead pid is an orphan", () => {
    const mine = mkTmpDir("pair-tmplc-");
    ageDir(mine, 3 * 60 * 60 * 1000);
    const orphan = foreign("pair-tmplc-");
    writeFileSync(
      join(orphan, ".pair-tmp-owner"),
      JSON.stringify({ pid: 999999999, ts: Date.now() - 3 * 60 * 60 * 1000 }),
    );
    ageDir(orphan, 3 * 60 * 60 * 1000);
    sweepStaleTestDirs({ minAgeMs: 60 * 60 * 1000 });
    // Live pid in MY marker → skip even though the dir is aged out.
    expect(existsSync(mine)).toBe(true);
    // Dead pid → orphaned residue → reclaimed by the age gate.
    expect(existsSync(orphan)).toBe(false);
    cleanupTmpDirs();
  });

  it("S8 — PAIR_TMP_SWEEP_MIN_AGE_MS is validated and floored", () => {
    const fresh = foreign("pair-tmplc-");
    process.env.PAIR_TMP_SWEEP_MIN_AGE_MS = "garbage";
    try {
      sweepStaleTestDirs();
      expect(existsSync(fresh)).toBe(true);
    } finally {
      process.env.PAIR_TMP_SWEEP_MIN_AGE_MS = "0";
      try {
        sweepStaleTestDirs();
        expect(existsSync(fresh)).toBe(true);
      } finally {
        delete process.env.PAIR_TMP_SWEEP_MIN_AGE_MS;
      }
    }
  });
});
