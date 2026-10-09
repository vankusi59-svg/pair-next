#!/usr/bin/env node
// PAIR Development Verification Harness V1 — deterministic runner.
// `npm run verify:change -- --base <sha> [--full] [--claim <path>]`
// Exit 0 = READY_FOR_INDEPENDENT_AUDIT; non-zero = NOT_READY.
// Development tooling only — never consulted by production PAIR.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HarnessError, TOLERATED_FAILURES, planVerification, validateClaim,
} from "./lib.mjs";

export const ROOT = new URL("../..", import.meta.url).pathname;
const DEFAULT_CLAIM = ".pair-verification/patch-claim.json";
const OUT_DIR = ".pair-verification";

export function createGit(root = ROOT) {
  return (...a) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
}

export function resolveBase(git, { baseArg, baseBranch = "staging/pr59-safe" } = {}) {
  if (baseArg) {
    try {
      return git("rev-parse", "--verify", `${baseArg}^{commit}`);
    } catch {
      throw new HarnessError("VERIFY_BASE_RESOLUTION",
        `cannot resolve --base ${baseArg}`);
    }
  }
  try {
    const ref = git("rev-parse", "--verify", `origin/${baseBranch}`);
    const mb = git("merge-base", "HEAD", ref);
    if (!/^[0-9a-f]{40}$/.test(mb)) throw new Error("bad merge-base");
    return mb;
  } catch {
    throw new HarnessError("VERIFY_BASE_RESOLUTION",
      `no --base given and merge-base with origin/${baseBranch} failed`);
  }
}

export function changedFiles(git, base, head) {
  const out = git("diff", "--name-only", `${base}..${head}`);
  return out ? out.split("\n").filter(Boolean).sort() : [];
}

/* ---------------- executing a group of test selectors ---------------- */

const RESULT_JSON = ".vitest-result.json";

function runSelector(sel, exec, root = ROOT) {
  const file = sel.file.startsWith("src/") || sel.file.startsWith("apps/")
    ? sel.file : `src/__tests__/${sel.file}`;
  // Test files always live in the real repo; `root` only controls where
  // the injected exec drops the vitest JSON result (self-tests).
  if (!existsSync(join(ROOT, file))) {
    return { selector: sel, file, status: "MISSING", tests: 0, failed: 1,
      failures: [`selector file not found: ${file}`] };
  }
  const argv = ["vitest", "run", file, "--reporter=json",
    `--outputFile=${RESULT_JSON}`];
  if (sel.pattern) argv.push("-t", sel.pattern);
  const r = exec("npx", argv);
  let results = null;
  try {
    results = JSON.parse(readFileSync(join(root, RESULT_JSON), "utf8"));
  } catch { /* runner itself failed → exit code is the truth */ }
  if (!results) {
    return { selector: sel, file,
      status: r.status === 0 ? "PASS" : "FAIL",
      tests: 0, failed: r.status === 0 ? 0 : 1,
      failures: r.status === 0 ? [] : [`vitest exit ${r.status}`] };
  }
  const tolerated = TOLERATED_FAILURES.filter((t) => t.file === file);
  const failedNames = [];
  let knownBaseline = 0;
  for (const tr of results.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      const name = `${a.title ?? a.fullName ?? "?"}`;
      if (tolerated.some((t) => t.pattern.test(name))) knownBaseline += 1;
      else failedNames.push(name);
    }
  }
  return {
    selector: sel, file,
    status: failedNames.length === 0
      ? (knownBaseline > 0 ? "PASS_WITH_KNOWN_BASELINE" : "PASS")
      : "FAIL",
    tests: results.numTotalTests ?? 0,
    failed: failedNames.length,
    knownBaseline,
    failures: failedNames.slice(0, 8), // bounded summary — never raw stderr
  };
}

export const defaultExec = (bin, argv) =>
  spawnSync(bin, argv, { cwd: ROOT, encoding: "utf8", shell: false });

function runTool(name, argv, exec) {
  const r = exec(argv[0], argv.slice(1));
  return { name, command: `${argv[0]} ${argv.slice(1).join(" ")}`,
    status: r.status === 0 ? "PASS" : "FAIL" };
}

const summarize = (results) => ({
  results,
  total: results.length,
  pass: results.filter((r) => r.status === "PASS" ||
    r.status === "PASS_WITH_KNOWN_BASELINE").length,
  knownBaseline: results.reduce((n, r) => n + (r.knownBaseline ?? 0), 0),
  ok: results.every((r) => r.status === "PASS" ||
    r.status === "PASS_WITH_KNOWN_BASELINE"),
  failures: results.flatMap((r) => r.failures),
});

/* ---------------- report ---------------- */

function buildReport(ctx, verdict) {
  const L = [];
  L.push("# PAIR DEVELOPMENT VERIFICATION");
  L.push("");
  L.push(`generated_at: ${ctx.generatedAt}`); // informational only
  L.push(`BASE: ${ctx.base}`);
  L.push(`HEAD: ${ctx.head}`);
  L.push("");
  L.push("## CHANGED FILES");
  for (const f of ctx.files) L.push(`- ${f}`);
  if (!ctx.files.length) L.push("- (none)");
  L.push("");
  L.push(`## RISK: ${ctx.plan.risk}`);
  L.push(`reason: ${ctx.plan.reason}`);
  L.push("");
  L.push("## AFFECTED SURFACES");
  for (const s of ctx.plan.surfaces) L.push(`- ${s}`);
  if (ctx.plan.unknownProduction.length) {
    L.push(`- UNKNOWN_PRODUCTION: ${ctx.plan.unknownProduction.join(", ")}`);
  }
  L.push("");
  L.push("## PATCH CLAIM");
  if (ctx.plan.claim) {
    L.push(`- claim_id: ${ctx.plan.claim.claim_id}`);
    L.push(`- title: ${ctx.plan.claim.title}`);
    L.push(`- status: ${ctx.groups.claim.ok ? "PASS" : "FAIL"}`);
  } else {
    L.push("- NOT_DECLARED (patch-claim manifest absent)");
  }
  L.push("");
  L.push("## INVARIANTS");
  for (const i of ctx.plan.invariants) L.push(`- ${i.id}: ${i.desc}`);
  if (!ctx.plan.invariants.length) L.push("- (none selected)");
  L.push("");
  L.push("## RESULTS");
  const g = (label, grp) => {
    L.push(`### ${label}: ${grp.pass}/${grp.total} PASS` +
      (grp.knownBaseline ? ` (+${grp.knownBaseline} KNOWN_BASELINE)` : ""));
    for (const r of grp.results.filter((x) => x.status !== "PASS" &&
        x.status !== "PASS_WITH_KNOWN_BASELINE")) {
      L.push(`- ${r.status}: ${r.file}` +
        (r.selector?.pattern ? ` (-t ${r.selector.pattern})` : ""));
      for (const f of r.failures) L.push(`    - ${f}`);
    }
  };
  g("PATCH CLAIM TESTS", ctx.groups.claim);
  g("INVARIANT TESTS", ctx.groups.invariants);
  g("AFFECTED REGRESSION", ctx.groups.modules);
  L.push("");
  L.push(`## TSC: ${ctx.groups.tsc.status}`);
  L.push(`## BUILD: ${ctx.groups.build.status}`);
  L.push(`## FULL SUITE: ${ctx.groups.full.status}` +
    (ctx.groups.full.knownBaseline
      ? ` (+${ctx.groups.full.knownBaseline} KNOWN_BASELINE)` : ""));
  for (const f of (ctx.groups.full.failures ?? []).slice(0, 10)) {
    L.push(`- ${f}`);
  }
  L.push("");
  L.push(`## FINAL VERDICT: ${verdict}`);
  L.push("");
  return L.join("\n");
}

/* ---------------- orchestration ---------------- */

function runFullSuite(exec, root = ROOT) {
  const r = exec("npx", ["vitest", "run", "--reporter=json",
    `--outputFile=${RESULT_JSON}`]);
  let results = null;
  try {
    results = JSON.parse(readFileSync(join(root, RESULT_JSON), "utf8"));
  } catch { /* noop */ }
  const failedNames = [];
  let knownBaseline = 0;
  for (const tr of results?.testResults ?? []) {
    const tol = TOLERATED_FAILURES.filter((t) => tr.name === t.file);
    for (const a of tr.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      const nm = `${a.title ?? a.fullName ?? "?"}`;
      if (tol.some((t) => t.pattern.test(nm))) knownBaseline += 1;
      else failedNames.push(`${tr.name}: ${nm}`.slice(0, 160));
    }
  }
  return {
    status: results && failedNames.length === 0 && r.status !== null
      ? "PASS" : results ? (failedNames.length ? "FAIL" : "FAIL") : "FAIL",
    knownBaseline,
    failures: failedNames,
    total: results?.numTotalTests ?? 0,
    pass: results?.numPassedTests ?? 0,
    ok: !!results && failedNames.length === 0,
  };
}

/**
 * Execute a computed plan. `exec` is injectable for harness self-tests —
 * the verdict is computed ONLY from recorded process results, never from
 * caller-supplied expectations.
 */
export function executePlan({ plan, exec = defaultExec, root = ROOT }) {
  const groups = {
    claim: summarize(plan.claimTests.map((s) => runSelector(s, exec, root))),
    invariants: summarize(plan.invariantTests.map((s) =>
      runSelector(s, exec, root))),
    modules: summarize(plan.moduleTests.map((s) =>
      runSelector(s, exec, root))),
    tsc: runTool("tsc", ["npx", "tsc", "-b"], exec),
    build: runTool("build", ["pnpm", "build"], exec),
    full: plan.fullSuite === "RUN"
      ? runFullSuite(exec, root)
      : { status: "NOT_RUN", failures: [], ok: true },
  };
  const verdict =
    groups.claim.ok && groups.invariants.ok && groups.modules.ok &&
    groups.tsc.status === "PASS" && groups.build.status === "PASS" &&
    groups.full.ok
      ? "READY_FOR_INDEPENDENT_AUDIT"
      : "NOT_READY";
  return { groups, verdict };
}

export function verify(opts = {}) {
  const root = opts.root ?? ROOT;
  const git = opts.git ?? createGit(root);
  const exec = opts.exec ?? defaultExec;
  const base = resolveBase(git, opts);
  const head = git("rev-parse", "HEAD");
  const files = changedFiles(git, base, head);
  let claimRaw = null;
  const claimFile = join(root, opts.claimPath ?? DEFAULT_CLAIM);
  if (existsSync(claimFile)) {
    try {
      claimRaw = JSON.parse(readFileSync(claimFile, "utf8"));
    } catch (e) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA",
        `unparseable claim file: ${e.message}`);
    }
  }
  const claim = opts.claim !== undefined ? opts.claim : validateClaim(claimRaw);
  const plan = planVerification({
    changedFiles: files, claim, full: opts.full ?? false,
  });
  const { groups, verdict } = executePlan({ plan, exec, root });
  const reportMd = buildReport(
    { generatedAt: new Date().toISOString(), base, head, files, plan, groups },
    verdict);
  const outDir = join(root, OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.md"), reportMd);
  writeFileSync(join(outDir, "report.json"), JSON.stringify({
    base, head, files, risk: plan.risk, surfaces: plan.surfaces,
    claim: plan.claim?.claim_id ?? null,
    invariants: plan.invariants.map((i) => i.id),
    results: {
      claim: groups.claim.ok ? "PASS" : "FAIL",
      invariants: groups.invariants.ok ? "PASS" : "FAIL",
      modules: groups.modules.ok ? "PASS" : "FAIL",
      tsc: groups.tsc.status, build: groups.build.status,
      full: groups.full.status,
    },
    verdict,
  }, null, 2));
  return { verdict, reportMd, base, head, plan, groups };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = process.argv.slice(2);
  const a = (f) => cli.indexOf(f) >= 0 ? cli[cli.indexOf(f) + 1] : undefined;
  try {
    const { verdict } = verify({
      baseArg: a("--base"),
      full: cli.includes("--full"),
      claimPath: a("--claim"),
      baseBranch: a("--base-branch"),
    });
    console.log(`\n=== PAIR DEVELOPMENT VERIFICATION: ${verdict} ===`);
    console.log(`report: ${OUT_DIR}/report.md`);
    process.exit(verdict === "READY_FOR_INDEPENDENT_AUDIT" ? 0 : 1);
  } catch (e) {
    console.error(`VERIFY HARNESS ERROR: ` +
      (e instanceof HarnessError ? e.message : e.stack ?? e.message));
    process.exit(2);
  }
}
