/**
 * Repro: top-level junction escape in sweepStaleTestDirs().
 *
 * Plants:
 *   VICTIM  = D:\PAIR_TMP\escape-victim — REAL dir outside %TEMP%,
 *             carrying a VALID .pair-tmp-owner (dead pid, ancient ts)
 *             and a precious file.
 *   JUNC    = %TEMP%\pair-escape-<rand> — junction pointing at VICTIM
 *             (allowlisted prefix, top-level entry of the temp root).
 *
 * Vulnerable sweep: statSync(JUNC) follows the link → isDirectory ok,
 * marker read THROUGH the link validates, dead pid + old ts qualify,
 * then unlinkReparsePoints(JUNC) readdirSync's THROUGH the link and
 * rmSync(JUNC) on Node >=24 descends → VICTIM contents deleted.
 *
 * Expected: PRE-FIX  keep.txt is deleted (escape reproduced).
 *           POST-FIX keep.txt survives, JUNC may be unlinked or
 *           skipped, VICTIM dir itself must survive.
 */
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTestDirs } from "../../src/test-utils/tmpdir.js";

const VICTIM = "D:\\PAIR_TMP\\escape-victim";
const NEST_TGT = "D:\\PAIR_TMP\\escape-nest-target";
const JUNC = join(tmpdir(), `pair-escape-${process.pid}-`);

rmSync(VICTIM, { recursive: true, force: true });
rmSync(NEST_TGT, { recursive: true, force: true });
rmSync(JUNC, { recursive: true, force: true });
mkdirSync(VICTIM, { recursive: true });
mkdirSync(NEST_TGT, { recursive: true });
writeFileSync(join(VICTIM, "keep.txt"), "precious");
writeFileSync(join(NEST_TGT, "deep.txt"), "deep-precious");
writeFileSync(
  join(VICTIM, ".pair-tmp-owner"),
  JSON.stringify({ pid: 999999999, ts: Date.now() - 48 * 3600 * 1000 }),
);
// VICTIM contains its own nested junction — the vulnerable pre-pass
// walks INTO the victim through the top-level link and deletes this.
symlinkSync(NEST_TGT, join(VICTIM, "nest"), "junction");
const old = new Date(Date.now() - 48 * 3600 * 1000);
utimesSync(VICTIM, old, old);
symlinkSync(VICTIM, JUNC, "junction");

console.log(`victim=${VICTIM}\njunc=${JUNC}`);
const res = sweepStaleTestDirs({ minAgeMs: 60 * 1000 });
console.log(`sweep: removed=${res.removed} skipped=${res.skipped}`);
console.log(`keep.txt exists:   ${existsSync(join(VICTIM, "keep.txt"))}`);
console.log(`victim dir exists: ${existsSync(VICTIM)}`);
console.log(`nested junction in victim exists: ${existsSync(join(VICTIM, "nest"))}`);
console.log(`nest target file exists: ${existsSync(join(NEST_TGT, "deep.txt"))}`);
console.log(`top junction exists: ${existsSync(JUNC)}`);

rmSync(JUNC, { recursive: true, force: true });
rmSync(VICTIM, { recursive: true, force: true });
rmSync(NEST_TGT, { recursive: true, force: true });
