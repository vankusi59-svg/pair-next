/**
 * F2 R4 — source-review remediation suite (permanent).
 *
 *   A   multi-dependency composed preparation — the EXACT production
 *       composition (buildDependencyFetchPreparation = buildPrompt's
 *       embedded block) must prepare EVERY pinned artifact: a
 *       successful recipe falls through instead of `exit 0`-terminating
 *       the shell; failure exits non-zero and stops preparation before
 *       task work (R4 §1-4)
 *   B   Devin prompt proof — a governed remote task carrying ≥2
 *       dependency_artifacts emits a prompt whose actual recipe block,
 *       executed in a real shell, prepares both artifacts (R4 §5)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  buildDependencyFetchPreparation,
  dependencyConsumerPath,
  DevinExecutorAdapter,
  DEPENDENCY_ARTIFACT_CONTRACT,
  sha256Hex,
  type DependencyArtifactEntry,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-f2-r4-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const BYTES = "canonical-dependency-bytes";

const entry = (
  consumerTaskId: string,
  artifactId: string,
  name: string,
): DependencyArtifactEntry => ({
  artifact_id: artifactId,
  producer_task_id: "tp",
  producer_governed_task_id: "gtp",
  producer_execution_id: "exe_p",
  producer_executor_id: "EX",
  logical_name: name,
  sha256: sha256Hex(Buffer.from(BYTES)),
  byte_size: Buffer.byteLength(BYTES),
  consumer_relative_path: dependencyConsumerPath(
    consumerTaskId,
    artifactId,
    name,
  ),
  contract: DEPENDENCY_ARTIFACT_CONTRACT,
});

/**
 * Stub curl on PATH. `failFor` = artifact ids whose HTTP fetch always
 * fails (exit 22). Records every served artifact id into fetched.log —
 * proof of exactly which artifacts the composed shell actually fetched.
 */
const stubEnv = (dirp: string, failFor: string[] = []) => {
  const bin = path.join(dirp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const failList = failFor.join(" ");
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
out=""
body=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "-d" ]; then body="$a"; fi
  prev="$a"
done
art=$(printf %s "$body" | sed -n 's/.*"artifact_id":"\\([^"]*\\)".*/\\1/p')
printf %s "$art" >> "${dirp}/fetched.log"; printf '\\n' >> "${dirp}/fetched.log"
for f in ${failList}; do
  if [ "$art" = "$f" ]; then exit 22; fi
done
printf %s "${BYTES}" > "$out"
exit 0
`,
  );
  fs.chmodSync(path.join(bin, "curl"), 0o755);
  return bin;
};

/** Run ONE composed preparation script (all recipes) in a real shell. */
const runPreparation = (
  dirp: string,
  preparation: string,
  failFor: string[] = [],
) => {
  const bin = stubEnv(dirp, failFor);
  fs.writeFileSync(path.join(dirp, "prep.sh"), preparation);
  try {
    execFileSync("bash", [path.join(dirp, "prep.sh")], {
      cwd: dirp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAIR_FETCH_BACKOFF: "0",
      },
      stdio: "pipe",
      timeout: 60_000,
    });
    return { code: 0, out: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer };
    return { code: err.status ?? -1, out: String(err.stdout ?? "") };
  }
};

const prep = (entries: DependencyArtifactEntry[]) =>
  buildDependencyFetchPreparation(entries, {
    fetchBase: "http://pair.test",
    consumeCapability: "acread1.testcap.sig",
  });

const tmpLeftovers = (dirp: string): string[] => {
  const found: string[] = [];
  const walk = (p: string) => {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name);
      if (f.isDirectory()) walk(fp);
      else if (/\.tmp\./.test(f.name)) found.push(fp);
    }
  };
  walk(dirp);
  return found;
};
const fetchedLog = (dirp: string): string[] =>
  fs.existsSync(path.join(dirp, "fetched.log"))
    ? fs.readFileSync(path.join(dirp, "fetched.log"), "utf8")
        .split("\n")
        .filter(Boolean)
    : [];

/* ===== A — multi-dependency composed preparation ===== */
describe("R4 A — composed multi-dependency preparation", () => {
  it("A1. two fresh valid dependencies → exit 0, BOTH prepared, zero .tmp", () => {
    const d = dir("a1");
    const e1 = entry("ATSK_C", "ART_1", "a.txt");
    const e2 = entry("ATSK_C", "ART_2", "b.txt");
    const r = runPreparation(d, prep([e1, e2]));
    expect(r.code).toBe(0);
    for (const e of [e1, e2]) {
      const t = path.join(d, e.consumer_relative_path);
      expect(fs.readFileSync(t)).toEqual(Buffer.from(BYTES));
    }
    expect(fetchedLog(d).sort()).toEqual(["ART_1", "ART_2"]);
    expect(tmpLeftovers(d)).toEqual([]);
  });

  it("A2. first target already exact → converges, preparation CONTINUES to second", () => {
    const d = dir("a2");
    const e1 = entry("ATSK_C", "ART_1", "a.txt");
    const e2 = entry("ATSK_C", "ART_2", "b.txt");
    const t1 = path.join(d, e1.consumer_relative_path);
    fs.mkdirSync(path.dirname(t1), { recursive: true });
    fs.writeFileSync(t1, BYTES);
    const ino1 = fs.statSync(t1).ino;
    const r = runPreparation(d, prep([e1, e2]));
    expect(r.code).toBe(0);
    // the exit-0-after-first-recipe bug would leave e2 absent forever
    expect(fs.statSync(t1).ino).toBe(ino1); // converged, never rewritten
    expect(fs.readFileSync(path.join(d, e2.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    expect(tmpLeftovers(d)).toEqual([]);
  });

  it("A3. three fresh dependencies → all three prepared", () => {
    const d = dir("a3");
    const es = [
      entry("ATSK_C", "ART_1", "a.txt"),
      entry("ATSK_C", "ART_2", "b.txt"),
      entry("ATSK_C", "ART_3", "c.txt"),
    ];
    const r = runPreparation(d, prep(es));
    expect(r.code).toBe(0);
    for (const e of es) {
      expect(fs.readFileSync(path.join(d, e.consumer_relative_path)))
        .toEqual(Buffer.from(BYTES));
    }
    expect(fetchedLog(d).sort()).toEqual(["ART_1", "ART_2", "ART_3"]);
    expect(tmpLeftovers(d)).toEqual([]);
  });

  it("A4. second fetch fails → overall non-zero, first valid, THIRD never fetched", () => {
    const d = dir("a4");
    const e1 = entry("ATSK_C", "ART_1", "a.txt");
    const e2 = entry("ATSK_C", "ART_2", "b.txt");
    const e3 = entry("ATSK_C", "ART_3", "c.txt");
    const r = runPreparation(d, prep([e1, e2, e3]), ["ART_2"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("DEPENDENCY_FETCH_FAILED");
    // first stays valid
    expect(fs.readFileSync(path.join(d, e1.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    // second absent, never published
    expect(fs.existsSync(path.join(d, e2.consumer_relative_path)))
      .toBe(false);
    // ART_2's fetch is attempted exactly the bounded 5 times (retry
    // budget), then preparation exits — THIRD is never even attempted
    expect(fetchedLog(d)).toEqual(
      ["ART_1", "ART_2", "ART_2", "ART_2", "ART_2", "ART_2"],
    );
    expect(fs.existsSync(path.join(d, e3.consumer_relative_path)))
      .toBe(false);
  });

  it("A5. first existing exact + second existing DIFFERENT → failure, neither overwritten", () => {
    const d = dir("a5");
    const e1 = entry("ATSK_C", "ART_1", "a.txt");
    const e2 = entry("ATSK_C", "ART_2", "b.txt");
    const t1 = path.join(d, e1.consumer_relative_path);
    const t2 = path.join(d, e2.consumer_relative_path);
    fs.mkdirSync(path.dirname(t1), { recursive: true });
    fs.writeFileSync(t1, BYTES);
    const ino1 = fs.statSync(t1).ino;
    fs.mkdirSync(path.dirname(t2), { recursive: true });
    fs.writeFileSync(t2, "foreign-bytes");
    const ino2 = fs.statSync(t2).ino;
    const r = runPreparation(d, prep([e1, e2]));
    expect(r.code).toBe(3);
    expect(fs.statSync(t1).ino).toBe(ino1);
    expect(fs.readFileSync(t1)).toEqual(Buffer.from(BYTES));
    expect(fs.statSync(t2).ino).toBe(ino2);
    expect(fs.readFileSync(t2)).toEqual(Buffer.from("foreign-bytes"));
    // the failing recipe never fetched anything for either target
    expect(fetchedLog(d)).toEqual([]);
  });

  it("A6. spaces/unicode/apostrophes in both names → shell-safe, both prepared", () => {
    const d = dir("a6");
    const e1 = entry("ATSK_C", "ART_1", "báo cáo q4.txt");
    const e2 = entry("ATSK_C", "ART_2", "it's final.txt");
    const r = runPreparation(d, prep([e1, e2]));
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(d, e1.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    expect(fs.readFileSync(path.join(d, e2.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    expect(tmpLeftovers(d)).toEqual([]);
  });

  it("A7. same ART under two distinct consumer scopes → both prepared independently", () => {
    const d = dir("a7");
    const ea = entry("ATSK_RA", "ART_S", "report.txt");
    const eb = entry("ATSK_RB", "ART_S", "report.txt");
    expect(ea.consumer_relative_path).not.toBe(eb.consumer_relative_path);
    const r = runPreparation(d, prep([ea, eb]));
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(d, ea.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    expect(fs.readFileSync(path.join(d, eb.consumer_relative_path)))
      .toEqual(Buffer.from(BYTES));
    expect(tmpLeftovers(d)).toEqual([]);
  });
});

/* ===== B — Devin prompt proof ===== */
describe("R4 B — Devin prompt embeds a working multi-dependency preparation", () => {
  it("B1. governed remote task with 2 dependency_artifacts → prompt recipe prepares BOTH", () => {
    const d = dir("b1");
    process.env.PAIR_OUTBOX_URL = "http://pair.test";
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = "r4-master";
    try {
      const adapter = new DevinExecutorAdapter({
        journalRoot: path.join(d, "journal"),
      });
      const e1 = entry("ATSK_PROMPT", "ART_1", "a.txt");
      const e2 = entry("ATSK_PROMPT", "ART_2", "b.txt");
      const prompt = (
        adapter as never as {
          buildPrompt(t: Record<string, unknown>): string;
        }
      ).buildPrompt({
        governed_task_id: "GT_PROMPT",
        mission_id: "M1",
        task_id: "ATSK_PROMPT",
        task_instruction: "use the inputs",
        workspace: "/tmp/ws",
        allowed_paths: ["/tmp/ws"],
        correlation_id: "COR_PROMPT",
        dependency_artifacts: [e1, e2],
      });
      // Extract the ACTUAL recipe block the prompt tells the worker to run
      // — between the recipe header and the trailing guidance sentence.
      const head = "must not continue:\n";
      const hi = prompt.indexOf(head);
      const ti = prompt.indexOf("\nIf the digest");
      expect(hi).toBeGreaterThan(-1);
      expect(ti).toBeGreaterThan(hi);
      const block = prompt.slice(hi + head.length, ti + 1).trim();
      // prompt contains ONE composed preparation covering both artifacts
      expect(block).toContain(e1.consumer_relative_path);
      expect(block).toContain(e2.consumer_relative_path);
      // execute the real extracted block — both files must land
      const r = runPreparation(d, block);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(d, e1.consumer_relative_path)))
        .toEqual(Buffer.from(BYTES));
      expect(fs.readFileSync(path.join(d, e2.consumer_relative_path)))
        .toEqual(Buffer.from(BYTES));
      expect(fetchedLog(d).sort()).toEqual(["ART_1", "ART_2"]);
      expect(tmpLeftovers(d)).toEqual([]);
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });
});
