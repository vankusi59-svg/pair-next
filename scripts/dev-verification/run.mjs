#!/usr/bin/env node
// PAIR Development Verification Harness V1 — deterministic runner.
// `npm run verify:change -- --base <sha> [--full] [--claim <path>]`
// Exit 0 = READY_FOR_INDEPENDENT_AUDIT; non-zero = NOT_READY.
// Development tooling only — never consulted by production PAIR.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HarnessError, TOLERATED_FAILURES, planVerification, validateClaim,
} from "./lib.mjs";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
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

// Every invocation gets its OWN deterministic result path, deleted before
// the run and required to exist afterwards — a stale JSON left over from a
// previous selector can never be reused as fresh evidence.
const resultName = (tag) => `.vitest-result-${tag}.json`;

const readFreshResults = (path) => {
  try {
    return { results: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { results: null, error: "unparseable vitest result JSON" };
  }
};

/**
 * Non-vacuous verdict rules for one vitest invocation. PASS requires ALL:
 * fresh result JSON from THIS invocation (path deleted before the run),
 * ≥1 executed assertion, zero unaccounted failures, and any non-zero exit
 * explained only by registered known-baseline failures.
 *
 * Exact accounting (R2): each tolerated failure is consumed against a
 * per-entry `max` budget (default 1) — a registered baseline occurring
 * more times than expected becomes ordinary FAIL. Reporter counters
 * (numFailedTests/numFailedTestSuites) must reconcile with the failed
 * evidence actually parsed; counters beyond accounted evidence are
 * unaccounted suite/process failures → FAIL. UNACCOUNTED == 0 always.
 */
function evaluateRun({ proc, resultPath, file }) {
  const noResult = !existsSync(resultPath);
  const { results, error } = noResult
    ? { results: null, error: null }
    : readFreshResults(resultPath);
  if (noResult) {
    return { status: "FAIL", executed: 0, failed: 1, knownBaseline: 0,
      failures: [`vitest produced no result JSON (exit ${proc.status}) — ` +
        "crash or startup failure"] };
  }
  if (!results) {
    return { status: "FAIL", executed: 0, failed: 1, knownBaseline: 0,
      failures: [error] };
  }
  // Per-entry budget: a baseline signature may be consumed at most `max`
  // times per invocation; beyond that it is ordinary failure (R2.G).
  const budget = TOLERATED_FAILURES.map((t) => ({ t, left: t.max ?? 1 }));
  const matchTol = (trName, name) =>
    budget.find((b) => b.left > 0 &&
      (b.t.file === file || b.t.file === trName ||
        String(trName).endsWith(`/${b.t.file}`)) &&
      b.t.pattern.test(name));
  const failedNames = [];
  let knownBaseline = 0;
  let executed = 0;
  let zeroAssertFailedSuites = 0;
  for (const tr of results.testResults ?? []) {
    let suiteFailed = 0;
    for (const a of tr.assertionResults ?? []) {
      executed += 1;
      if (a.status !== "failed") continue;
      suiteFailed += 1;
      const name = `${a.title ?? a.fullName ?? "?"}`;
      const ent = matchTol(tr.name, name);
      if (ent) {
        ent.left -= 1;
        knownBaseline += 1;
      } else {
        failedNames.push(
          file ? name : `${tr.name}: ${name}`.slice(0, 160));
      }
    }
    // A suite marked failed with zero failed assertions is a crash/
    // collect/hook failure — real failure evidence with no assertion
    // record, so it must count as unaccounted, never hide behind a
    // tolerated baseline.
    if (tr.status === "failed" && suiteFailed === 0) {
      zeroAssertFailedSuites += 1;
    }
  }
  if (executed === 0) {
    return { status: "FAIL", executed, failed: 1, knownBaseline,
      failures: ["selector matched zero executed tests — a selector or " +
        "pattern with no coverage is never a PASS"] };
  }
  // Exact accounting (R3): when the reporter exposes numFailedTests it
  // must EQUAL the parsed failed evidence in BOTH directions — never
  // silently prefer either source when they disagree. Suite-level errors
  // are proven locally: tr.status==="failed" with zero failed assertions.
  const assertionFailed = failedNames.length + knownBaseline;
  const counterFailed = typeof results.numFailedTests === "number"
    ? results.numFailedTests : assertionFailed;
  const counterMismatch = counterFailed !== assertionFailed;
  const unaccounted = failedNames.length +
    Math.max(0, counterFailed - assertionFailed) +
    zeroAssertFailedSuites;
  if (unaccounted > 0 || counterMismatch) {
    return { status: "FAIL", executed,
      failed: Math.max(unaccounted, 1), knownBaseline,
      failures: [
        ...failedNames.slice(0, 8),
        ...(counterMismatch
          ? [`reporter numFailedTests=${counterFailed} ≠ parsed ` +
            `failures=${assertionFailed} — counter evidence does not ` +
            "reconcile in both directions"]
          : []),
        ...(unaccounted > failedNames.length
          ? [`${unaccounted - failedNames.length} failure(s) reported by ` +
            "vitest with no matching failed assertion — " +
            "unaccounted suite/process failure"]
          : []),
      ] };
  }
  // Process-exit reconciliation (R3): PASS requires status 0.
  // PASS_WITH_KNOWN_BASELINE requires the ORDINARY vitest failed-test
  // exit (1) with every failed assertion exactly tolerated — a baseline
  // never authorizes abnormal termination (status 2/null/signal/spawn
  // error → FAIL).
  const VITEST_FAILURE_EXIT = 1;
  if (proc.status === 0 && knownBaseline === 0) {
    return { status: "PASS", executed, failed: 0, knownBaseline,
      failures: [] };
  }
  if (proc.status === VITEST_FAILURE_EXIT && knownBaseline > 0) {
    return { status: "PASS_WITH_KNOWN_BASELINE", executed, failed: 0,
      knownBaseline, failures: [] };
  }
  return {
    status: "FAIL", executed, failed: 1, knownBaseline,
    failures: [`vitest process status ${proc.status} is not the ordinary ` +
      "failed-test exit — abnormal termination is never tolerated"],
  };
}

function runSelector(sel, exec, root = ROOT, tag = "x") {
  const file = sel.file.startsWith("src/") || sel.file.startsWith("apps/")
    ? sel.file : `src/__tests__/${sel.file}`;
  // Test files always live in the real repo; `root` only controls where
  // the injected exec drops the vitest JSON result (self-tests).
  if (!existsSync(join(ROOT, file))) {
    return { selector: sel, file, status: "MISSING", tests: 0, failed: 1,
      failures: [`selector file not found: ${file}`] };
  }
  const resultPath = join(root, resultName(tag));
  rmSync(resultPath, { force: true });
  const argv = ["vitest", "run", file, "--reporter=json",
    `--outputFile=${resultName(tag)}`];
  if (sel.pattern) argv.push("-t", sel.pattern);
  const r = exec("npx", argv);
  const ev = evaluateRun({ proc: r, resultPath, file });
  return {
    selector: sel, file, status: ev.status,
    tests: ev.executed, failed: ev.failed,
    knownBaseline: ev.knownBaseline,
    failures: ev.failures.slice(0, 8), // bounded summary — never raw stderr
  };
}

export const defaultExec = (bin, argv) => {
  // win32: npx/pnpm resolve to .cmd shims that cannot spawn without a
  // shell. Wrap in cmd.exe with metachar-aware quoting so selector
  // patterns (e.g. -t "a|b") stay literal — identical semantics on
  // unix, which keeps the direct execFile path.
  if (process.platform === "win32") {
    const q = (s) =>
      /[\s"&|<>^()%!]/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s;
    return spawnSync("cmd.exe",
      ["/d", "/s", "/c", [bin, ...argv.map(q)].join(" ")],
      { cwd: ROOT, encoding: "utf8" });
  }
  return spawnSync(bin, argv, { cwd: ROOT, encoding: "utf8", shell: false });
};

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
  const resultPath = join(root, resultName("full"));
  rmSync(resultPath, { force: true }); // fresh proof — no stale reuse
  const r = exec("npx", ["vitest", "run", "--reporter=json",
    `--outputFile=${resultName("full")}`]);
  const ev = evaluateRun({ proc: r, resultPath, file: null });
  return {
    status: ev.status,
    knownBaseline: ev.knownBaseline,
    failures: ev.failures,
    total: ev.executed,
    pass: ev.executed - ev.failed - ev.knownBaseline >= 0
      ? ev.executed - ev.failed - ev.knownBaseline
      : ev.executed,
    ok: ev.status === "PASS" || ev.status === "PASS_WITH_KNOWN_BASELINE",
  };
}

/**
 * Execute a computed plan. `exec` is injectable for harness self-tests —
 * the verdict is computed ONLY from recorded process results, never from
 * caller-supplied expectations.
 */
export function executePlan({ plan, exec = defaultExec, root = ROOT }) {
  const groups = {
    claim: summarize(plan.claimTests.map((s, i) =>
      runSelector(s, exec, root, `c${i}`))),
    invariants: summarize(plan.invariantTests.map((s, i) =>
      runSelector(s, exec, root, `i${i}`))),
    modules: summarize(plan.moduleTests.map((s, i) =>
      runSelector(s, exec, root, `m${i}`))),
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
  // Explicit empty-diff policy: the harness never certifies a patch that
  // does not exist — zero changed files is a typed fail-closed verdict.
  if (!files.length) {
    throw new HarnessError("VERIFY_EMPTY_DIFF",
      `no changed files between ${base} and ${head} — nothing to verify`);
  }
  // The claim path must be repo-local — no traversal, no absolute path
  // outside the repository (R2.B).
  const claimArg = opts.claimPath ?? DEFAULT_CLAIM;
  const claimAbs = resolve(root, claimArg);
  const claimRel = relative(root, claimAbs);
  if (claimRel === "" || claimRel.startsWith("..") || isAbsolute(claimRel)) {
    throw new HarnessError("VERIFY_CLAIM_PATH",
      `claim path must resolve inside the repository: ${claimArg}`);
  }
  // git diff --name-only emits forward slashes — normalize the repo-
  // relative claim path so the freshness check compares like separators.
  const claimRelGit = claimRel.replaceAll("\\", "/");
  let claimRaw = null;
  if (existsSync(claimAbs)) {
    try {
      claimRaw = JSON.parse(readFileSync(claimAbs, "utf8"));
    } catch (e) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA",
        `unparseable claim file: ${e.message}`);
    }
  }
  const claim = opts.claim !== undefined ? opts.claim : validateClaim(claimRaw);
  // Patch Claim is mandatory for a real change: without it the harness
  // does not know what the patch claims to prove, so no READY verdict can
  // ever be produced. Fails closed before any test execution.
  if (!claim) {
    throw new HarnessError("VERIFY_PATCH_CLAIM_REQUIRED",
      `non-empty diff requires ${claimRel} ` +
      "declaring what the patch claims to prove");
  }
  // The claim must belong to the CURRENT change: the claim file itself
  // must be added/modified inside the resolved BASE..HEAD diff. A claim
  // committed by an earlier PR is stale and can never certify this one —
  // freshness authority is the diff, never mtime/claim_id/title (R2.A/E).
  if (!files.includes(claimRelGit)) {
    throw new HarnessError("VERIFY_PATCH_CLAIM_STALE",
      `${claimRelGit} is not added/modified in ${base}..${head} — ` +
      "a stale claim cannot certify the current change");
  }
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

if (process.argv[1] != null &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
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
