/**
 * Development Verification Harness V1 — self-tests (mandate §15 A–O).
 * Pure-function classification/risk/claim/plan coverage plus exec-injected
 * verdict tests — no nested vitest runs needed; the injected exec records
 * deterministic process results and writes fake vitest JSON output.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HarnessError, INVARIANTS, PACKS,
  classifyFiles, parseSelector, planVerification,
  validateClaim,
} from "../../scripts/dev-verification/lib.mjs";
import { executePlan } from "../../scripts/dev-verification/run.mjs";

const T = "src/__tests__/";
const packHas = (plan: { moduleTests: { file: string }[] }, name: string) =>
  plan.moduleTests.some((s) => s.file === `${T}${name}`);

/** Fake exec: returns the scripted exit status; when the command is a
 *  vitest run it writes a canned --outputFile JSON so runSelector can read
 *  per-test results. `fails` = basename of files whose vitest should fail. */
const fakeExec =
  (root: string, opts: { fails?: string[]; toolFails?: string[] } = {}) =>
  (_bin: string, argv: string[]) => {
    const jsonIdx = argv.findIndex((a) =>
      String(a).startsWith("--outputFile="),
    );
    if (jsonIdx >= 0) {
      const file = String(argv[2] ?? "");
      const base = file.split("/").pop() ?? "";
      const fails = (opts.fails ?? []).includes(base);
      writeFileSync(join(root, argv[jsonIdx].slice(13)), JSON.stringify({
        numTotalTests: 3,
        numPassedTests: fails ? 2 : 3,
        numFailedTests: fails ? 1 : 0,
        testResults: [{
          name: file,
          status: fails ? "failed" : "passed",
          assertionResults: fails
            ? [
              { title: "good test", status: "passed" },
              { title: "claim-broken regression", status: "failed" },
            ]
            : [{ title: "ok", status: "passed" }],
        }],
      }));
      return { status: fails ? 1 : 0 };
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
