/**
 * Development Verification Harness V1 — self-tests (mandate §15 A–O).
 * Pure-function classification/risk/claim/plan coverage plus exec-injected
 * verdict tests — no nested vitest runs needed; the injected exec records
 * deterministic process results and writes fake vitest JSON output.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HarnessError, INVARIANTS, PACKS,
  classifyFiles, parseSelector, planVerification,
  validateClaim,
} from "../../scripts/dev-verification/lib.mjs";
import { executePlan, verify } from "../../scripts/dev-verification/run.mjs";

const T = "src/__tests__/";
const packHas = (plan: { moduleTests: { file: string }[] }, name: string) =>
  plan.moduleTests.some((s) => s.file === `${T}${name}`);

/** Fake exec: returns the scripted exit status; when the command is a
 *  vitest run it writes a canned --outputFile JSON so runSelector can read
 *  per-test results. `fails` = basename of files whose vitest should fail. */
const fakeExec =
  (root: string, opts: {
    fails?: string[]; toolFails?: string[];
    vitest?: {
      assertions?: { title: string; status: string }[];
      status?: number; write?: boolean; name?: string; for?: string;
    };
  } = {}) =>
  (_bin: string, argv: string[]) => {
    const jsonIdx = argv.findIndex((a) =>
      String(a).startsWith("--outputFile="),
    );
    if (jsonIdx >= 0) {
      const v = opts.vitest ?? {};
      const file = String(argv[2] ?? "");
      const base = file.split("/").pop() ?? "";
      if (v.write === false && (v.for === undefined || v.for === base)) {
        return { status: v.status ?? 1 };
      }
      const fails = (opts.fails ?? []).includes(base);
      // `for` scopes scripted vitest output to one file; other selectors
      // get the default passing result.
      const scoped = v.for === undefined || v.for === base;
      const assertions = (scoped ? v.assertions : undefined) ?? (fails
        ? [
          { title: "good test", status: "passed" },
          { title: "claim-broken regression", status: "failed" },
        ]
        : [{ title: "ok", status: "passed" }]);
      const anyFailed = assertions.some((a) => a.status === "failed");
      writeFileSync(join(root, String(argv[jsonIdx]).slice(13)),
        JSON.stringify({
          numTotalTests: assertions.length,
          numPassedTests:
            assertions.filter((a) => a.status === "passed").length,
          numFailedTests:
            assertions.filter((a) => a.status === "failed").length,
          testResults: [{
            name: v.name ?? file,
            status: anyFailed ? "failed" : "passed",
            assertionResults: assertions,
          }],
        }));
      return { status: v.status ?? (anyFailed ? 1 : 0) };
    }
    const cmd = `${_bin} ${argv[0] ?? ""}`;
    return {
      status: (opts.toolFails ?? []).some((t) => cmd.includes(t)) ? 1 : 0,
    };
  };

const planFor = (files: string[], claim?: object | null, full = false) =>
  planVerification({ changedFiles: files, claim: claim ?? null, full });

describe("dev-verification harness V1", () => {
  it("A. planner file change selects PLANNER pack", () => {
    const p = planFor(["src/pair/llm-planner.ts"]);
    expect(p.surfaces).toContain("PLANNER");
    expect(packHas(p, "pair-llm-planner.test.ts")).toBe(true);
    expect(packHas(p, "pair-cpl1-codex-planner.test.ts")).toBe(true);
  });

  it("B. plan-dataflow change selects PLANNER + DELIVERY", () => {
    const p = planFor(["src/pair/plan-dataflow.ts"]);
    expect(p.surfaces).toContain("PLANNER");
    expect(p.surfaces).toContain("DELIVERY");
    expect(packHas(p, "pair-output-delivery-contract.test.ts")).toBe(true);
    expect(packHas(p, "pair-llm-planner.test.ts")).toBe(true);
    // delivery invariants are surface-selected automatically
    expect(p.invariants.map((i) => i.id)).toContain("INV_DELIVERY_001");
    expect(p.invariants.map((i) => i.id)).toContain("INV_DELIVERY_RAW_001");
  });

  it("C. conversation file selects CONVERSATION", () => {
    const p = planFor(["src/pair/conversation-reasoning.ts"]);
    expect(p.surfaces).toContain("CONVERSATION");
    expect(packHas(p, "pair-p15-8b-conversation-reasoning.test.ts"))
      .toBe(true);
    expect(p.invariants.map((i) => i.id)).toContain("INV_CONV_001");
  });

  it("D. artifact authority file selects ARTIFACT and HIGH risk", () => {
    const p = planFor(["src/pair/artifact-authority.ts"]);
    expect(p.surfaces).toContain("ARTIFACT");
    expect(p.risk).toBe("HIGH");
    expect(packHas(p, "pair-f1-artifact-authority.test.ts")).toBe(true);
    expect(p.invariants.map((i) => i.id)).toContain("INV_ARTIFACT_001");
    expect(p.fullSuite).toBe("RUN");
  });

  it("E. UI-only change does not select authority packs", () => {
    const p = planFor(["apps/mission-control-ui/src/App.tsx"]);
    expect(p.surfaces).toEqual(["UI"]);
    expect(p.risk).toBe("LOW");
    expect(p.moduleTests).toHaveLength(0);
    expect(p.fullSuite).toBe("NOT_RUN");
    expect(p.invariants).toHaveLength(0);
  });

  it("F. HIGH authority file cannot be downgraded by patch manifest", () => {
    // schema rejects any downgrade attempt outright
    expect(() =>
      validateClaim({
        claim_id: "X_1", title: "x",
        affected_surfaces: [], required_tests: [], risk_override: "LOW",
      }),
    ).toThrow(/VERIFY_CLAIM_SCHEMA/);
    // a MEDIUM override on a HIGH-risk change keeps HIGH
    const p = planFor(["src/pair/serve-planner.ts"], {
      claim_id: "X_1", title: "x", affected_surfaces: ["PLANNER"],
      required_tests: [], invariants: [], risk_override: "MEDIUM",
    });
    expect(p.risk).toBe("HIGH");
  });

  it("G. unknown production file → HIGH + broad verification, never LOW", () => {
    const p = planFor(["src/pair/totally-new-subsystem.ts"]);
    expect(p.unknownProduction).toEqual(["src/pair/totally-new-subsystem.ts"]);
    expect(p.risk).toBe("HIGH");
    for (const f of PACKS.UNKNOWN_BROAD) {
      expect(packHas(p, f)).toBe(true);
    }
  });

  it("H. missing declared patch test → NOT_READY", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/__tests__/dev-verification.test.ts"], {
        claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
        required_tests: ["src/__tests__/no-such-claim-test.test.ts"],
        invariants: [],
      });
      const { groups, verdict } = executePlan({
        plan, exec: fakeExec(root) as never, root,
      });
      expect(groups.claim.ok).toBe(false);
      expect(groups.claim.results[0].status).toBe("MISSING");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("I. failed patch-specific test → NOT_READY even when tsc/build pass", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/__tests__/dev-verification.test.ts"], {
        claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
        required_tests: ["src/__tests__/dev-verification.test.ts"],
        invariants: [],
      });
      const { groups, verdict } = executePlan({
        plan,
        exec: fakeExec(root, {
          fails: ["dev-verification.test.ts"],
        }) as never,
        root,
      });
      expect(groups.claim.ok).toBe(false);
      expect(groups.tsc.status).toBe("PASS");
      expect(groups.build.status).toBe("PASS");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("J. failed invariant test → NOT_READY", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/pair/serve-planner.ts"]);
      const invFiles = plan.invariantTests.map((s) =>
        s.file.split("/").pop() ?? "",
      );
      const { groups, verdict } = executePlan({
        plan,
        exec: fakeExec(root, { fails: invFiles.slice(0, 1) }) as never,
        root,
      });
      expect(groups.invariants.ok).toBe(false);
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("K. all-required green → READY_FOR_INDEPENDENT_AUDIT", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/__tests__/dev-verification.test.ts"], {
        claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
        required_tests: ["src/__tests__/dev-verification.test.ts"],
        invariants: [],
      });
      const { groups, verdict } = executePlan({
        plan, exec: fakeExec(root) as never, root,
      });
      expect(groups.claim.ok).toBe(true);
      expect(groups.tsc.status).toBe("PASS");
      expect(verdict).toBe("READY_FOR_INDEPENDENT_AUDIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("L. --full forces the full suite even for LOW changes", () => {
    const p = planFor(["docs/x.md"], null, true);
    expect(p.fullSuite).toBe("RUN");
  });

  it("M. report reflects executed results — claim status comes from exit data", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/__tests__/dev-verification.test.ts"], {
        claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
        required_tests: ["src/__tests__/dev-verification.test.ts"],
        invariants: [],
      });
      const pass = executePlan({
        plan, exec: fakeExec(root) as never, root,
      });
      expect(pass.groups.claim.results[0].status).toBe("PASS");
      const fail = executePlan({
        plan,
        exec: fakeExec(root, {
          fails: ["dev-verification.test.ts"],
        }) as never,
        root,
      });
      // same claim, different recorded exit data → different verdict
      expect(fail.verdict).toBe("NOT_READY");
      expect(fail.groups.claim.results[0].failures[0])
        .toContain("claim-broken regression");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("N. malformed patch-claim → typed harness failure", () => {
    for (const bad of [
      42, "x", [{ a: 1 }],
      { title: "x" }, // no claim_id
      { claim_id: "!!", title: "x" },
      { claim_id: "X_1", title: "x", affected_surfaces: ["NOPE"] },
      { claim_id: "X_1", title: "x", invariants: ["INV_FAKE"] },
      { claim_id: "X_1", title: "x", extra_field: 1 },
      { claim_id: "X_1", title: "x", required_tests: {} },
    ]) {
      expect(() => validateClaim(bad)).toThrow(HarnessError);
      expect(() => validateClaim(bad)).toThrow(/VERIFY_CLAIM_SCHEMA/);
    }
    // absent claim is legal (NOT_DECLARED), present-but-wrong is not
    expect(validateClaim(null)).toBeNull();
  });

  it("O. invalid --base → typed VERIFY_BASE_RESOLUTION, exit 2", () => {
    try {
      execFileSync(
        "node",
        ["scripts/dev-verification/run.mjs", "--base",
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect.unreachable("harness must fail on unresolvable base");
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      expect(err.status).toBe(2);
      expect(String(err.stderr)).toContain("VERIFY_BASE_RESOLUTION");
    }
  });

  it("selector + classification primitives stay deterministic", () => {
    expect(parseSelector("a/b.test.ts#My Pattern")).toEqual({
      file: "a/b.test.ts", pattern: "My Pattern",
    });
    expect(parseSelector("a/b.test.ts")).toEqual({
      file: "a/b.test.ts", pattern: null,
    });
    const c1 = classifyFiles(["src/pair/plan-dataflow.ts"]);
    const c2 = classifyFiles(["src/pair/plan-dataflow.ts"]);
    expect(c1).toEqual(c2);
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(10);
    expect(INVARIANTS.length).toBeLessThanOrEqual(15);
    // every registered invariant/pack test file must actually exist —
    // a registry pointing at a missing file is a harness defect.
    const repoRoot = join(process.cwd());
    for (const inv of INVARIANTS) {
      for (const t of inv.tests) {
        expect(existsSync(join(repoRoot, t.file)),
          `invariant ${inv.id} → ${t.file}`).toBe(true);
      }
    }
    for (const [surf, files] of Object.entries(PACKS)) {
      for (const f of files) {
        expect(existsSync(join(repoRoot, `${T}${f}`)),
          `pack ${surf} → ${f}`).toBe(true);
      }
    }
  });
});

/** R1 adversarial hardening tests — freshness, non-vacuous proof,
 *  mandatory patch claim, and conservative script classification. */
describe("dev-verification harness V1 R1", () => {
  const claimFor = (required_tests: string[], extra: object = {}) => ({
    claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
    required_tests, invariants: [], ...extra,
  });
  const runPlan = (plan: object, exec: unknown, root: string) =>
    executePlan({ plan: plan as never, exec: exec as never, root });

  it("R1-A1. zero-match -t pattern → FAIL (never vacuous PASS)", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor([`${T}dev-verification.test.ts`], claimFor(
        [`${T}dev-verification.test.ts#NO_SUCH_TEST_PATTERN`]));
      const { groups, verdict } = runPlan(plan,
        fakeExec(root, { vitest: { assertions: [] } }), root);
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(groups.claim.results[0].failures[0])
        .toContain("zero executed tests");
      expect(groups.tsc.status).toBe("PASS"); // green tsc/build cannot override
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1-A2. stale JSON from a previous selector can never be reused", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      let vitestCalls = 0;
      const exec = (_b: string, argv: string[]) => {
        const oi = argv.findIndex((a) =>
          String(a).startsWith("--outputFile="));
        if (oi < 0) return { status: 0 };
        vitestCalls += 1;
        if (vitestCalls === 1) {
          writeFileSync(join(root, String(argv[oi]).slice(13)),
            JSON.stringify({
              numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
              testResults: [{ name: "x", status: "passed",
                assertionResults: [{ title: "ok", status: "passed" }] }],
            }));
          return { status: 0 };
        }
        return { status: 1 }; // crashes before writing JSON
      };
      const plan = planFor([`${T}dev-verification.test.ts`], claimFor([
        `${T}dev-verification.test.ts`,
        `${T}pair-p15-8b-conversation-reasoning.test.ts`,
      ]));
      const { groups, verdict } = runPlan(plan, exec, root);
      expect(groups.claim.results[0].status).toBe("PASS");
      expect(groups.claim.results[1].status).toBe("FAIL");
      expect(groups.claim.results[1].failures[0])
        .toContain("no result JSON");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1-A3. result JSON with zero executed assertions → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor([`${T}dev-verification.test.ts`],
        claimFor([`${T}dev-verification.test.ts`]));
      const { groups, verdict } = runPlan(plan,
        fakeExec(root, { vitest: { assertions: [] } }), root);
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1-A4. non-zero exit with zero recorded failed assertions → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor([`${T}dev-verification.test.ts`],
        claimFor([`${T}dev-verification.test.ts`]));
      const { groups, verdict } = runPlan(plan,
        fakeExec(root, {
          vitest: { assertions: [{ title: "ok", status: "passed" }],
            status: 1 },
        }), root);
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(groups.claim.results[0].failures[0])
        .toContain("unaccounted process failure");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1-A5. malformed result JSON → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const exec = (_b: string, argv: string[]) => {
        const oi = argv.findIndex((a) =>
          String(a).startsWith("--outputFile="));
        if (oi < 0) return { status: 0 };
        writeFileSync(join(root, String(argv[oi]).slice(13)),
          "this is not json{");
        return { status: 1 };
      };
      const plan = planFor([`${T}dev-verification.test.ts`],
        claimFor([`${T}dev-verification.test.ts`]));
      const { groups, verdict } = runPlan(plan, exec, root);
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(groups.claim.results[0].failures[0])
        .toContain("unparseable");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const fakeGit = (diffOut: string) =>
    (...a: string[]) => {
      if (a[0] === "rev-parse") return "a".repeat(40);
      if (a[0] === "diff") return diffOut;
      return "";
    };
  const okExec = () => ({ status: 0 });

  it("R1-C1. non-empty diff without patch claim → VERIFY_PATCH_CLAIM_REQUIRED",
    () => {
      const root = mkdtempSync(join(tmpdir(), "dv-"));
      try {
        expect(() =>
          verify({
            baseArg: "a".repeat(40), git: fakeGit("src/pair/x.ts\n") as never,
            exec: okExec as never, root,
            claimPath: "does-not-exist.json",
          }),
        ).toThrow(/VERIFY_PATCH_CLAIM_REQUIRED/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

  it("R1-C2. zero diff → typed VERIFY_EMPTY_DIFF (never certifies nothing)",
    () => {
      const root = mkdtempSync(join(tmpdir(), "dv-"));
      try {
        expect(() =>
          verify({
            baseArg: "a".repeat(40), git: fakeGit("") as never,
            exec: okExec as never, root,
          }),
        ).toThrow(/VERIFY_EMPTY_DIFF/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

  it("R1-D1. unknown production script → conservative HIGH + broad pack", () => {
    const p = planFor(["scripts/new-runtime.mjs"]);
    expect(p.unknownProduction).toContain("scripts/new-runtime.mjs");
    expect(p.risk).toBe("HIGH");
    for (const f of PACKS.UNKNOWN_BROAD) expect(packHas(p, f)).toBe(true);
  });

  it("R1-D2. serve-mission-control + telegram-bridge → HIGH", () => {
    const mc = planFor(["scripts/serve-mission-control.mjs"]);
    expect(mc.risk).toBe("HIGH");
    expect(mc.surfaces).toContain("MISSION_CONTROL");
    const tg = planFor(["scripts/telegram-bridge.mjs"]);
    expect(tg.risk).toBe("HIGH");
    expect(tg.surfaces).toContain("TELEGRAM_INGRESS");
  });

  it("R1-D3. known dev-only script stays DEV_INFRA (may remain LOW)", () => {
    const p = planFor(["scripts/dev-verification/lib.mjs"]);
    expect(p.unknownProduction).toHaveLength(0);
    expect(p.surfaces).toEqual(["DEV_INFRA"]);
    expect(p.risk).toBe("LOW");
  });

  it("R1-D4. mission-control authority seams → HIGH", () => {
    for (const f of [
      "src/pair/mission-control.ts",
      "src/pair/mission-control-server.ts",
      "src/pair/service.ts",
      "src/pair/promotion-service.ts",
    ]) {
      expect(planFor([f]).risk, f).toBe("HIGH");
    }
  });

  it("R1-E. renamed/no-match invariant selector cannot pass vacuously", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const plan = planFor(["src/pair/plan-dataflow.ts"]); // selects -t patterns
      const { groups, verdict } = runPlan(plan,
        fakeExec(root, { vitest: { assertions: [] } }), root);
      expect(groups.invariants.ok).toBe(false);
      expect(groups.invariants.results.every((r) => r.status === "FAIL"))
        .toBe(true);
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1-B1. full suite requires fresh result — no JSON after run → FAIL",
    () => {
      const root = mkdtempSync(join(tmpdir(), "dv-"));
      try {
        // stale leftover from a previous full run must not be reused
        writeFileSync(join(root, ".vitest-result-full.json"),
          JSON.stringify({ numTotalTests: 1, testResults: [{ name: "old",
            assertionResults: [{ title: "x", status: "passed" }] }] }));
        const exec = (_b: string, argv: string[]) => {
          const oi = argv.findIndex((a) =>
            String(a).startsWith("--outputFile="));
          if (oi < 0) return { status: 0 };
          const isFull = String(argv[2]).startsWith("--");
          if (isFull) return { status: 0 }; // exits 0 but writes nothing
          writeFileSync(join(root, String(argv[oi]).slice(13)),
            JSON.stringify({ numTotalTests: 1, numPassedTests: 1,
              numFailedTests: 0, testResults: [{ name: "x",
                status: "passed",
                assertionResults: [{ title: "ok", status: "passed" }] }] }));
          return { status: 0 };
        };
        const plan = planFor(["docs/x.md"], claimFor([]), true);
        const { groups, verdict } = runPlan(plan, exec, root);
        expect(groups.full.status).toBe("FAIL");
        expect(groups.full.ok).toBe(false);
        expect(verdict).toBe("NOT_READY");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

  it("R1-B2. registered known-baseline failure → PASS_WITH_KNOWN_BASELINE",
    () => {
      const root = mkdtempSync(join(tmpdir(), "dv-"));
      try {
        const plan = planFor([`${T}dev-verification.test.ts`], claimFor(
          [`${T}pair-f4-delivery-provenance.test.ts`]));
        const { groups, verdict } = runPlan(plan,
          fakeExec(root, {
            vitest: {
              for: "pair-f4-delivery-provenance.test.ts",
              assertions: [
                { title: "R5.1-crash: a fault between evidence append " +
                    "and row write rolls back both", status: "failed" },
                { title: "ok", status: "passed" },
              ],
            },
          }), root);
        expect(groups.claim.results[0].status)
          .toBe("PASS_WITH_KNOWN_BASELINE");
        expect(groups.claim.results[0].knownBaseline).toBe(1);
        expect(verdict).toBe("READY_FOR_INDEPENDENT_AUDIT");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
});

/** R2 — current-diff claim binding, non-vacuous claims, exact
 *  known-baseline accounting. */
describe("dev-verification harness V1 R2", () => {
  const PASS_JSON = {
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
    numFailedTestSuites: 0, numTotalTestSuites: 1,
    testResults: [{ name: "x", status: "passed",
      assertionResults: [{ title: "ok", status: "passed" }] }],
  };
  const passExec = (root: string) => (_b: string, argv: string[]) => {
    const oi = argv.findIndex((a) => String(a).startsWith("--outputFile="));
    if (oi >= 0) {
      writeFileSync(join(root, String(argv[oi]).slice(13)),
        JSON.stringify(PASS_JSON));
    }
    return { status: 0 };
  };
  const writeClaim = (root: string, rel = ".pair-verification/patch-claim.json") => {
    mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")),
      { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify({
      claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
      required_tests: [`${T}dev-verification.test.ts`], invariants: [],
    }));
  };
  const gitDiff =
    (out: string) =>
    (...a: string[]) =>
      a[0] === "rev-parse" ? "a".repeat(40) : a[0] === "diff" ? out : "";

  it("R2-1. stale tracked claim from BASE → VERIFY_PATCH_CLAIM_STALE", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      writeClaim(root); // valid claim exists but NOT in the diff
      expect(() =>
        verify({
          baseArg: "a".repeat(40), git: gitDiff("src/pair/x.ts\n") as never,
          exec: passExec(root) as never, root,
        }),
      ).toThrow(/VERIFY_PATCH_CLAIM_STALE/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-2. claim modified inside BASE..HEAD → accepted as current", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      writeClaim(root);
      const res = verify({
        baseArg: "a".repeat(40),
        git: gitDiff(
          ".pair-verification/patch-claim.json\nsrc/pair/x.ts\n") as never,
        exec: passExec(root) as never, root,
      });
      expect(res.plan.claim?.claim_id).toBe("X_1");
      expect(res.verdict).toBe("READY_FOR_INDEPENDENT_AUDIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-3. custom --claim path not in diff → VERIFY_PATCH_CLAIM_STALE", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      writeClaim(root, "custom-claim.json");
      expect(() =>
        verify({
          baseArg: "a".repeat(40), git: gitDiff("src/pair/x.ts\n") as never,
          exec: passExec(root) as never, root,
          claimPath: "custom-claim.json",
        }),
      ).toThrow(/VERIFY_PATCH_CLAIM_STALE/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-4. custom repo-local claim in diff → accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      writeClaim(root, "custom-claim.json");
      const res = verify({
        baseArg: "a".repeat(40),
        git: gitDiff("custom-claim.json\nsrc/pair/x.ts\n") as never,
        exec: passExec(root) as never, root,
        claimPath: "custom-claim.json",
      });
      expect(res.plan.claim?.claim_id).toBe("X_1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-5. outside-repo / traversal claim path → typed failure", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      for (const p of ["../evil.json", "/tmp/evil.json", "sub/../../x.json"]) {
        expect(() =>
          verify({
            baseArg: "a".repeat(40), git: gitDiff("src/pair/x.ts\n") as never,
            exec: passExec(root) as never, root, claimPath: p,
          }),
        ).toThrow(/VERIFY_CLAIM_PATH/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-6/7/8. required_tests must exist and contain ≥1 selector", () => {
    expect(() =>
      validateClaim({ claim_id: "X_1", title: "x" }),
    ).toThrow(/VERIFY_CLAIM_SCHEMA/);
    expect(() =>
      validateClaim({ claim_id: "X_1", title: "x", required_tests: [] }),
    ).toThrow(/VERIFY_CLAIM_SCHEMA/);
    const ok = validateClaim({
      claim_id: "X_1", title: "x",
      required_tests: [`${T}dev-verification.test.ts`],
    });
    expect(ok?.required_tests).toHaveLength(1);
  });

  const execWithAssertions =
    (root: string, assertions: { title: string; status: string }[],
      counters: object = {}) =>
    (_b: string, argv: string[]) => {
      const oi = argv.findIndex((a) => String(a).startsWith("--outputFile="));
      if (oi < 0) return { status: 0 };
      writeFileSync(join(root, String(argv[oi]).slice(13)), JSON.stringify({
        numTotalTests: assertions.length,
        numPassedTests: assertions.filter((a) => a.status === "passed").length,
        numFailedTests: assertions.filter((a) => a.status === "failed").length,
        numFailedTestSuites:
          assertions.some((a) => a.status === "failed") ? 1 : 0,
        numTotalTestSuites: 1,
        testResults: [{
          name: "x",
          status: assertions.some((a) => a.status === "failed")
            ? "failed" : "passed",
          assertionResults: assertions }],
        ...counters,
      }));
      return { status: assertions.some((a) => a.status === "failed") ? 1 : 0 };
    };
  const planForF4 = () =>
    planFor([`${T}dev-verification.test.ts`], {
      claim_id: "X_1", title: "x", affected_surfaces: ["DEV_INFRA"],
      required_tests: [`${T}pair-f4-delivery-provenance.test.ts`],
      invariants: [],
    });
  const CRASH = "R5.1-crash: a fault between evidence append and row write";

  it("R2-11. known baseline + unrelated failed assertion → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const { groups, verdict } = executePlan({
        plan: planForF4(),
        exec: execWithAssertions(root, [
          { title: CRASH, status: "failed" },
          { title: "unrelated real regression", status: "failed" },
        ]) as never,
        root,
      });
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-12. baseline + unaccounted suite-level failure → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const { groups, verdict } = executePlan({
        plan: planForF4(),
        exec: execWithAssertions(root, [
          { title: CRASH, status: "failed" },
        ], { numFailedTests: 2 }) as never, // counter beyond evidence
        root,
      });
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(groups.claim.results[0].failures.join(" "))
        .toContain("unaccounted");
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-13. baseline multiplicity above registered max → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const { groups, verdict } = executePlan({
        plan: planForF4(),
        exec: execWithAssertions(root, [
          { title: CRASH, status: "failed" },
          { title: CRASH, status: "failed" }, // second occurrence exceeds max:1
        ], { numFailedTests: 2 }) as never,
        root,
      });
      expect(groups.claim.results[0].status).toBe("FAIL");
      expect(groups.claim.results[0].knownBaseline).toBe(1);
      expect(verdict).toBe("NOT_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R2-14. baseline disappears → normal PASS (no phantom tolerance)", () => {
    const root = mkdtempSync(join(tmpdir(), "dv-"));
    try {
      const { groups, verdict } = executePlan({
        plan: planForF4(),
        exec: execWithAssertions(root, [
          { title: "ok", status: "passed" },
        ]) as never,
        root,
      });
      expect(groups.claim.results[0].status).toBe("PASS");
      expect(groups.claim.results[0].knownBaseline).toBe(0);
      expect(verdict).toBe("READY_FOR_INDEPENDENT_AUDIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
