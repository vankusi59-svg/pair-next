/**
 * CPL-1 — Codex GPT-6.1-sol planner-primary focused suite.
 *
 * Fake `codex` executable (node script) emulates `codex exec` end-to-end:
 * reads the prompt on stdin, writes the response to --output-last-message,
 * exits per FAKE_CODEX_BEHAVIOR. The real failover authority
 * (runPlannerFailover), the real per-attempt eligibility seam, the real
 * canonicalize seam (makeServeCanonicalizer + validatePlanProposal), and
 * the real durable planner_attempt/planner_run evidence all run — only
 * the binary and the HTTP fallback model are replaced.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PairEvidenceStore } from "../pair/store.js";
import {
  runPlannerFailover,
  PLANNER_FAILURE_CLASS,
  classifyPlannerFailure,
  type PlannerCandidate,
} from "../pair/planner-pool.js";
import {
  codexPlannerPlan,
  codexPlannerProbe,
  assertCodexPlannerCandidateEligible,
  ensureCodexCliPlannerCatalog,
  codexPlannerArgvForTest,
  CODEX_CLI_PROVIDER_ID,
  CODEX_PLANNER_WARNING,
} from "../pair/codex-planner.js";
import {
  assignModelRole,
  MODEL_ROLE,
  resolveConfiguredModelRoleRoute,
} from "../pair/model-role.js";
import { ModelEvidenceCatalog, canonicalModelId } from "../pair/model-catalog.js";
import { ProviderCatalog } from "../pair/provider-catalog.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import {
  beginPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  finishPlannerRun,
} from "../pair/plan-preview.js";
import { validatePlanProposal } from "../pair/proposal.js";
import { IntegrityError } from "../pair/errors.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-cpl1-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** Fake codex CLI — stdin prompt → behavior-per-env → final message file. */
const FAKE_CODEX_JS = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2); // argv[0]="exec" then flags
const outIdx = argv.indexOf("--output-last-message");
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const pidFile = process.env.FAKE_CODEX_PIDFILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const b = process.env.FAKE_CODEX_BEHAVIOR || "ok";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (b === "sleep") { setTimeout(() => {}, 120000); return; }
  if (b === "authfail") { process.stderr.write("error: 401 unauthorized — login required\\n"); process.exit(1); }
  if (b === "modelunavail") { process.stderr.write("error: model gpt-6.1-sol is not available for this account\\n"); process.exit(1); }
  if (b === "ratelimit") { process.stderr.write("error: 429 rate limit exceeded\\n"); process.exit(1); }
  if (b === "crash") { process.stderr.write("error: internal failure\\n"); process.exit(2); }
  if (!out) { process.stderr.write("missing --output-last-message\\n"); process.exit(1); }
  if (b === "empty") { process.exit(0); }
  if (b === "garbage") { fs.writeFileSync(out, "this is not json at all"); process.exit(0); }
  if (b === "invalid_caps") {
    fs.writeFileSync(out, JSON.stringify({ tasks: [
      { task_key: "T1", title: "x", task_instruction: "do x", required_capabilities: ["NOT_A_CAPABILITY"], depends_on: [] },
    ] }));
    process.exit(0);
  }
  if (b === "remote_no_edge") {
    // consumer reads an artifact nobody produces → canonicalize FAIL_CLOSED
    fs.writeFileSync(out, JSON.stringify({ tasks: [
      { task_key: "T1", title: "record", task_instruction: "write goal to mission_goal.txt then reply DONE.", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
      { task_key: "T2", title: "consume", task_instruction: "read missing_input.json and analyze it then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"] },
    ] }));
    process.exit(0);
  }
  // ok — valid two-task plan
  fs.writeFileSync(out, JSON.stringify({ tasks: [
    { task_key: "T1", title: "record goal", task_instruction: "write the goal to mission_goal.txt then reply DONE.", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
    { task_key: "T2", title: "analyze", task_instruction: "analyze BTC data and write note.txt then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"] },
  ] }));
  process.exit(0);
});
`;

function makeFakeCodex(dir: string, behavior: string): { exe: string } {
  const exe = path.join(dir, "fake-codex.cjs");
  fs.writeFileSync(exe, FAKE_CODEX_JS);
  fs.chmodSync(exe, 0o755);
  return { exe };
}

/** Full failover wiring identical to production serve-mission-control. */
const CAP_SETS = [["AUTOMATON_TASK_EXECUTION", "FILE_OPERATIONS", "REASONING", "REMOTE_CLOUD_TASK_EXECUTION", "TELEGRAM_DELIVERY"]];
const CAPS = ["AUTOMATON_TASK_EXECUTION", "FILE_OPERATIONS", "REASONING", "CODE_GENERATION", "CODE_EDITING", "SHELL_EXECUTION", "PYTHON_EXECUTION", "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "TELEGRAM_DELIVERY"];

function seedCodexCandidate(store: PairEvidenceStore, opts: { qualified?: boolean; authFailed?: boolean; cliMissing?: boolean } = {}): PlannerCandidate {
  const mid = "gpt-6.1-sol";
  const meId = ensureCodexCliPlannerCatalog(store, mid, "TEST");
  const pc = new ProviderCatalog(store);
  if (opts.cliMissing) {
    pc.recordProbeObservation(CODEX_CLI_PROVIDER_ID, "CLI_MISSING", { detail: "codex executable not resolvable", actor: "TEST" });
    pc.recordAccessObservation(CODEX_CLI_PROVIDER_ID, "UNREACHABLE", { actor: "TEST" });
  } else if (opts.authFailed) {
    pc.recordProbeObservation(CODEX_CLI_PROVIDER_ID, "AUTH_FAILED", { actor: "TEST" });
    pc.recordAccessObservation(CODEX_CLI_PROVIDER_ID, "AUTH_FAILED", { actor: "TEST" });
  } else if (opts.qualified !== false) {
    pc.recordProbeObservation(CODEX_CLI_PROVIDER_ID, "PASS", { actor: "TEST" });
    pc.recordAccessObservation(CODEX_CLI_PROVIDER_ID, "AUTH_OK", { actor: "TEST" });
    pc.setLifecycle(CODEX_CLI_PROVIDER_ID, "QUALIFIED", { actor: "TEST" });
  }
  if (opts.qualified !== false && !opts.cliMissing && !opts.authFailed) {
    const mcat = new ModelEvidenceCatalog(store);
    const me = mcat.getModel(meId)!;
    me.lifecycle_state = "QUALIFIED";
    me.probe_state = "PROBED";
    store.put("model_entry", String(me.model_entry_id), me, Number(me.version));
  }
  assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
  return {
    model_entry_id: meId,
    ref: `codex-cli:${mid}`,
    provider: CODEX_CLI_PROVIDER_ID,
    model: mid,
    endpoint: "codex-cli://local",
    credentialEnv: "",
    transport: "codex_cli",
  };
}

const geminiCandidate = (id = "ME_GEM"): PlannerCandidate => ({
  model_entry_id: id, ref: "gemini:gemini-3.1-flash-lite", provider: "gemini",
  model: "gemini-3.1-flash-lite", endpoint: "https://gem.test", credentialEnv: "ENV_X",
});

async function runPool(opts: {
  store: PairEvidenceStore;
  codex: PlannerCandidate;
  exeEnv: Record<string, string>;
  exe?: string;
  geminiPlan?: () => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }>;
  scratch: string;
}) {
  const canonicalize = makeServeCanonicalizer({ executorCapSets: () => CAP_SETS });
  const run = beginPlannerRun(opts.store, { routes: [opts.codex.ref, "gemini:gemini-3.1-flash-lite"], actor: "TEST" });
  const geminiCalls: number[] = [];
  try {
    const res = await runPlannerFailover({
      candidates: [opts.codex, geminiCandidate()],
      assertEligible: (c) =>
        c.transport === "codex_cli" ? assertCodexPlannerCandidateEligible(opts.store, c) : undefined,
      canonicalize: (tasks) => {
        const canon = canonicalize(tasks, "goal");
        validatePlanProposal({ tasks: canon }, new Set(CAPS));
        return canon;
      },
      planFn: (c) =>
        c.transport === "codex_cli"
          ? codexPlannerPlan("goal", {
              model: c.model,
              executable: opts.exe,
              timeoutMs: 8_000,
              scratchDir: opts.scratch,
              env: { ...process.env, ...opts.exeEnv },
              allowedCapabilities: CAPS,
              capabilitySets: CAP_SETS,
            })
          : (geminiCalls.push(1), (opts.geminiPlan ?? (async () => ({
              tasks: [
                { task_key: "T1", title: "g", task_instruction: "write goal to mission_goal.txt then reply DONE.", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
                { task_key: "T2", title: "g2", task_instruction: "write note.txt then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"] },
              ],
              warnings: [],
            })))()),
      onAttemptStart: (base) =>
        persistPlannerAttemptStart(opts.store, { planner_run_id: String(run.planner_run_id), record: base, actor: "TEST" }).planner_attempt_id,
      onAttemptEnd: (paid, rec) =>
        settlePlannerAttempt(opts.store, { planner_attempt_id: String(paid), record: rec, winner: rec.outcome === "SUCCESS", actor: "TEST" }),
      onExhausted: () =>
        finishPlannerRun(opts.store, { planner_run_id: String(run.planner_run_id), outcome: "EXHAUSTED", actor: "TEST" }),
    });
    finishPlannerRun(opts.store, { planner_run_id: String(run.planner_run_id), outcome: "WINNER_SELECTED", winner_attempt_no: res.winner.attempt_no, actor: "TEST" });
    return { res, geminiCalls, run };
  } catch (e) {
    finishPlannerRun(opts.store, { planner_run_id: String(run.planner_run_id), outcome: "FAILED", actor: "TEST" });
    throw e;
  }
}

describe("CPL-1 codex planner primary", () => {
  it("A. sol wins primary → winner_attempt_no=1, gemini never invoked", async () => {
    const dir = freshDir("a");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "ok");
    const { res, geminiCalls, run } = await runPool({
      store, codex, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.attempt_no).toBe(1);
    expect(res.winner.route).toBe("codex-cli:gpt-6.1-sol");
    expect(res.winner.provider).toBe("codex-cli");
    expect(res.winner.model).toBe("gpt-6.1-sol");
    expect(res.winner.outcome).toBe("SUCCESS");
    expect(geminiCalls.length).toBe(0);
    expect(res.tasks.length).toBeGreaterThanOrEqual(2);
    // durable evidence: one planner_attempt row bound to the run
    const attempts = store.list("planner_attempt");
    expect(attempts.length).toBe(1);
    expect(String(attempts[0].outcome)).toBe("SUCCESS");
    expect(String(attempts[0].planner_run_id)).toBe(String(run.planner_run_id));
    const runRow = store.get("planner_run", String(run.planner_run_id));
    expect(String(runRow.outcome ?? runRow.state)).toBeTruthy();
  });

  it("B. CLI missing at eligibility → typed FAILED attempt → gemini wins #2", async () => {
    const dir = freshDir("b");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store, { cliMissing: true });
    const { res, geminiCalls } = await runPool({ store, codex, exeEnv: {}, scratch: path.join(dir, "scr") });
    expect(res.winner.attempt_no).toBe(2);
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.CLI_MISSING);
    expect(res.attempts[0].warnings.join(",")).toContain("cli_missing");
    expect(geminiCalls.length).toBe(1);
    const attempts = store.list("planner_attempt");
    expect(attempts.length).toBe(2);
    expect(String(attempts[0].outcome)).toBe("FAILED");
    expect(String(attempts[0].failure_class)).toBe("CLI_MISSING");
  });

  it("C. auth failure at invoke → FAILED/AUTH_REJECTED → gemini wins #2", async () => {
    const dir = freshDir("c");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "authfail");
    const { res } = await runPool({
      store, codex, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "authfail" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.attempt_no).toBe(2);
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.AUTH_REJECTED);
    expect(res.attempts[0].warnings.join(",")).toContain("CODEX_AUTH_FAILED");
  });

  it("D. model unavailable → FAILED/MODEL_UNAVAILABLE → gemini wins", async () => {
    const dir = freshDir("d");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "modelunavail");
    const { res } = await runPool({
      store, codex, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "modelunavail" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE);
  });

  it("E. timeout → FAILED/TIMEOUT + child killed (no orphan process)", async () => {
    const dir = freshDir("e");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "sleep");
    const pidFile = path.join(dir, "codex.pid");
    const t0 = Date.now();
    const { res } = await runPool({
      store, codex, exe,
      exeEnv: { FAKE_CODEX_BEHAVIOR: "sleep", FAKE_CODEX_PIDFILE: pidFile },
      scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.TIMEOUT);
    expect(res.attempts[0].warnings.join(",")).toContain("CODEX_TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(15_000);
    // orphan check: fake pid must be dead after SIGKILL (retry past reap)
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive).toBe(false);
  });

  it("F. malformed output → FAILED/MALFORMED_RESPONSE → gemini wins", async () => {
    const dir = freshDir("f");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "garbage");
    const { res } = await runPool({
      store, codex, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "garbage" }, scratch: path.join(dir, "scr"),
    });
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE);
    expect(res.attempts[0].warnings.join(",")).toContain("CODEX_OUTPUT_INVALID");
    expect(res.winner.provider).toBe("gemini");
  });

  it("G. canonically-invalid plan (undeclared remote dep) → PLAN_INVALID → gemini wins", async () => {
    const dir = freshDir("g");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "remote_no_edge");
    const { res } = await runPool({
      store, codex, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "remote_no_edge" }, scratch: path.join(dir, "scr"),
    });
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.PLAN_INVALID);
    expect(res.winner.provider).toBe("gemini");
  });

  it("H. authority separation — planner argv is read-only/no-net/isolated; zero governed side effects", async () => {
    const dir = freshDir("h");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "ok");
    const argv = codexPlannerArgvForTest("gpt-6.1-sol", "/tmp/scr");
    const joined = argv.join(" ");
    expect(joined).toContain("--ephemeral");
    expect(joined).toContain("--ignore-user-config");
    expect(joined).toContain("--ignore-rules");
    expect(joined).toContain("--strict-config");
    expect(joined).toContain("approval_policy=never");
    expect(joined).toContain("web_search=disabled");
    expect(joined).toContain("permissions.pair_planner.network.enabled=false");
    expect(joined).toContain("':minimal'='read'");
    expect(joined).toContain("-m gpt-6.1-sol");
    // planner argv carries NONE of the governed dispatch artifacts
    expect(joined).not.toContain("execution_journal");
    expect(joined).not.toContain("pair_workspace");
    const before = store.list("governed_task").length + store.list("execution").length;
    await runPool({ store, codex, exe, exeEnv: {}, scratch: path.join(dir, "scr") });
    const after = store.list("governed_task").length + store.list("execution").length;
    expect(after).toBe(before); // planning produced zero executor/dispatch entities
    expect(store.list("planner_attempt").length).toBe(1); // only planner evidence
  });

  it("I. planner↔DSH disjointness: aliased DSH model + missing role both fail closed", () => {
    const dir = freshDir("i");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = seedCodexCandidate(store);
    // aliased DSH entry — same canonical identity → overlap → authority throw
    const mcat = new ModelEvidenceCatalog(store);
    mcat.upsertModelClaim({
      provider_id: "dsh-x", provider_family: CODEX_CLI_PROVIDER_ID,
      model_id: "alias-x", model_native_id: "gpt-6.1-sol",
    }, "TEST");
    const dshEntry = mcat.getModelByIds(CODEX_CLI_PROVIDER_ID, "alias-x")!;
    assignModelRole(store, String(dshEntry.model_entry_id), MODEL_ROLE.DSH_EXECUTION, { actor: "TEST" });
    let threw = false;
    try { assertCodexPlannerCandidateEligible(store, codex); } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(IntegrityError);
      expect(String((e as Error).message)).toContain("FAIL_CLOSED_PLANNER_DSH_OVERLAP");
    }
    expect(threw).toBe(true);
    // role revoked → planner eligibility throws, never a failover verdict
    const store2 = new PairEvidenceStore(path.join(freshDir("i2"), "pair.db"));
    const c2 = ensureCodexCliPlannerCatalog(store2, "gpt-6.1-sol", "TEST");
    const c2cand = { ...codex, model_entry_id: c2 };
    let threw2 = false;
    try { assertCodexPlannerCandidateEligible(store2, c2cand); } catch (e) {
      threw2 = true;
      expect(String((e as Error).message)).toContain("FAIL_CLOSED_MODEL_ROLE");
    }
    expect(threw2).toBe(true);
  });

  it("J. config regression — api-only route list keeps codex out; seeding resolves codex-cli:<model> strictly", () => {
    const dir = freshDir("j");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meId = ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST");
    expect(meId).toBe(canonicalModelId(CODEX_CLI_PROVIDER_ID, "gpt-6.1-sol"));
    // strict configured-route resolution resolves the seeded row
    const mcat = new ModelEvidenceCatalog(store);
    const r = resolveConfiguredModelRoleRoute(
      (p, m) => mcat.getModelByIds(p, m),
      { route: "codex-cli:gpt-6.1-sol", role: MODEL_ROLE.PLANNER_COORDINATOR },
    );
    expect(r.model_entry_id).toBe(meId);
    expect(r.pid).toBe(CODEX_CLI_PROVIDER_ID);
    // unresolved route still throws
    let threw = false;
    try {
      resolveConfiguredModelRoleRoute((p, m) => mcat.getModelByIds(p, m), { route: "codex-cli:nope", role: MODEL_ROLE.PLANNER_COORDINATOR });
    } catch (e) { threw = true; expect(String((e as Error).message)).toContain("UNRESOLVED"); }
    expect(threw).toBe(true);
    // idempotent re-seed → same entry, no duplicate
    expect(ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST")).toBe(meId);
    expect(store.list("model_entry").length).toBe(1);
    expect(store.list("provider").length).toBe(1);
  });

  it("probe — fake codex ok → AUTH_OK; missing binary → CLI_MISSING; authfail → AUTH_FAILED", async () => {
    const dir = freshDir("probe");
    const { exe } = makeFakeCodex(dir, "ok");
    const okRes = await codexPlannerProbe({
      model: "gpt-6.1-sol", scratchDir: path.join(dir, "s1"), timeoutMs: 10_000,
      env: { PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok", PATH: process.env.PATH },
    });
    expect(okRes.outcome).toBe("AUTH_OK");
    const missing = await codexPlannerProbe({
      model: "gpt-6.1-sol", scratchDir: path.join(dir, "s2"), timeoutMs: 10_000,
      env: { PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "no-such-binary"), PATH: "" },
    });
    expect(missing.outcome).toBe("CLI_MISSING");
    const auth = await codexPlannerProbe({
      model: "gpt-6.1-sol", scratchDir: path.join(dir, "s3"), timeoutMs: 10_000,
      env: { PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "authfail", PATH: process.env.PATH },
    });
    expect(auth.outcome).toBe("AUTH_FAILED");
    const classify = (w: string) => classifyPlannerFailure([w]);
    expect(classify("CODEX_CLI_MISSING")).toBe(PLANNER_FAILURE_CLASS.CLI_MISSING);
    expect(classify("CODEX_AUTH_FAILED")).toBe(PLANNER_FAILURE_CLASS.AUTH_REJECTED);
    expect(classify("CODEX_TIMEOUT")).toBe(PLANNER_FAILURE_CLASS.TIMEOUT);
    expect(classify("CODEX_OUTPUT_INVALID")).toBe(PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE);
    expect(classify("CODEX_RATE_LIMITED")).toBe(PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED);
    expect(classify(CODEX_PLANNER_WARNING.MODEL_UNAVAILABLE)).toBe(PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE);
  });
});
