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
  assertCodexPlannerCandidateEligibleWithRefresh,
  refreshCodexPlannerQualification,
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
import { ProviderValidator } from "../pair/provider-validation.js";
import { providerModelEligibility } from "../pair/model-routable.js";
import { probeModel, qualifyModel } from "../pair/model-probing.js";
import {
  modelProbeTimeoutMs,
  codexPlannerTimeoutMs,
  MODEL_PROBE_TIMEOUT,
  CODEX_PLANNER_TIMEOUT,
} from "../pair/env-config.js";
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
const ROOT_DIR = path.resolve(import.meta.dirname, "..", "..");
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
const LOCAL_REQ = { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED" };
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  // R1 — invocation ledger: PLAN (real planner prompt) vs PROBE (ping
  // schema prompt) so tests can assert ZERO invocation / bounded refresh.
  const invokeLog = process.env.FAKE_CODEX_INVOKELOG;
  if (invokeLog) {
    fs.appendFileSync(invokeLog, (prompt.includes('"ok": true') ? "PROBE" : "PLAN") + "\\n");
  }
  // R1 §6 — dump the auth-relevant env the child actually received.
  const envFile = process.env.FAKE_CODEX_ENVFILE;
  if (envFile) {
    fs.writeFileSync(envFile, JSON.stringify({
      CODEX_HOME: process.env.CODEX_HOME != null,
      CODEX_API_KEY: process.env.CODEX_API_KEY != null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY != null,
    }));
  }
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
      { task_key: "T2", title: "consume", task_instruction: "read missing_input.json and analyze it then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"], network_requirement: LOCAL_REQ },
    ] }));
    process.exit(0);
  }
  // ok — valid two-task plan
  fs.writeFileSync(out, JSON.stringify({ tasks: [
    { task_key: "T1", title: "record goal", task_instruction: "write the goal to mission_goal.txt then reply DONE.", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
    { task_key: "T2", title: "analyze", task_instruction: "analyze BTC data and write note.txt then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"], network_requirement: LOCAL_REQ },
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

/** Canonical seed (R1.A): the provider/model are qualified through the
 *  REAL seams (validateAccess probe → qualify receipt → probeModel
 *  receipt → qualifyModel receipt + lifecycle) so the FULL Phase E gate
 *  set — including PROVIDER_RECEIPT_CURRENT / MODEL_RECEIPT_CURRENT —
 *  passes legitimately. Row-poking is reserved for the adversarial cases. */
async function seedCodexCandidate(store: PairEvidenceStore, opts: { cliMissing?: boolean; timeoutProbe?: boolean } = {}): Promise<PlannerCandidate> {
  const mid = "gpt-6.1-sol";
  const meId = ensureCodexCliPlannerCatalog(store, mid, "TEST");
  const pc = new ProviderCatalog(store);
  if (opts.cliMissing) {
    pc.recordProbeObservation(CODEX_CLI_PROVIDER_ID, "CLI_MISSING", { detail: "codex executable not resolvable", actor: "TEST" });
    pc.recordAccessObservation(CODEX_CLI_PROVIDER_ID, "UNREACHABLE", { actor: "TEST" });
  } else {
    const pv = new ProviderValidator(store);
    await pv.validateAccess(CODEX_CLI_PROVIDER_ID, {
      probe: async () => ({
        outcome: opts.timeoutProbe ? "TIMEOUT" : "AUTH_OK",
        latency_ms: 1,
        detail: "seed",
      }),
      actor: "TEST",
    });
    pv.qualify(CODEX_CLI_PROVIDER_ID, { actor: "TEST" });
    pc.setLifecycle(CODEX_CLI_PROVIDER_ID, "QUALIFIED", { actor: "TEST" });
    await probeModel(store, meId, 1, {
      probeFn: async () => ({
        result: "PASS",
        latency_ms: 1,
        capability_evidence: { text_inference: "PASS" },
        requests_used: 1,
        tokens_used: 1,
      }),
      capability: "text_inference",
      executorId: "CODEX",
      actor: "TEST",
    });
    qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "TEST" });
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

/** Mutate the durable provider row directly (adversarial fixtures only). */
function pokeProvider(store: PairEvidenceStore, fn: (p: Record<string, unknown>) => void): void {
  const pc = new ProviderCatalog(store);
  const p = pc.getProvider(CODEX_CLI_PROVIDER_ID)!;
  fn(p);
  store.put("provider", String(p.entry_id), p, Number(p.version));
}
function pokeModel(store: PairEvidenceStore, meId: string, fn: (m: Record<string, unknown>) => void): void {
  const mcat = new ModelEvidenceCatalog(store);
  const m = mcat.getModel(meId)!;
  fn(m);
  store.put("model_entry", String(m.model_entry_id), m, Number(m.version));
}
function pokeModelReceipt(store: PairEvidenceStore, meId: string, fn: (r: Record<string, unknown>) => void): void {
  const mcat = new ModelEvidenceCatalog(store);
  const m = mcat.getModel(meId)!;
  const rid = String(m.current_qualification_receipt_id);
  const r = store.get("model_qualification", rid);
  fn(r);
  store.put("model_qualification", rid, r, Number(r.version));
}
/** Read the fake-codex invocation ledger: ["PROBE"|"PLAN"] per spawn. */
const invokeLedger = (dir: string) =>
  fs.existsSync(path.join(dir, "invokes.log"))
    ? fs.readFileSync(path.join(dir, "invokes.log"), "utf8").trim().split("\n").filter(Boolean)
    : [];

const geminiCandidate = (id = "ME_GEM"): PlannerCandidate => ({
  model_entry_id: id, ref: "gemini:gemini-3.1-flash-lite", provider: "gemini",
  model: "gemini-3.1-flash-lite", endpoint: "https://gem.test", credentialEnv: "ENV_X",
});

async function runPool(opts: {
  store: PairEvidenceStore;
  codex: PlannerCandidate;
  exeEnv: Record<string, string>;
  exe?: string;
  dir?: string;
  /** When false, codex eligibility runs WITHOUT the R1 refresh seam
   *  (mirrors pre-R1 behavior / proves refresh is what repairs). */
  refresh?: boolean;
  geminiPlan?: () => Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }>;
  scratch: string;
}) {
  const canonicalize = makeServeCanonicalizer({ executorCapSets: () => CAP_SETS });
  const run = beginPlannerRun(opts.store, { routes: [opts.codex.ref, "gemini:gemini-3.1-flash-lite"], actor: "TEST" });
  const geminiCalls: number[] = [];
  const exeEnv = {
    ...process.env,
    ...(opts.exe ? { PAIR_CODEX_PLANNER_EXECUTABLE: opts.exe } : {}),
    ...(opts.dir ? { FAKE_CODEX_INVOKELOG: path.join(opts.dir, "invokes.log") } : {}),
    ...opts.exeEnv,
  };
  try {
    const res = await runPlannerFailover({
      candidates: [opts.codex, geminiCandidate()],
      // Production wiring (R1): codex candidates run canonical eligibility
      // + ONE bounded canonical refresh on availability rejections.
      assertEligible: (c) =>
        c.transport === "codex_cli"
          ? opts.refresh === false
            ? assertCodexPlannerCandidateEligible(opts.store, c)
            : assertCodexPlannerCandidateEligibleWithRefresh(opts.store, c, {
                refresh: () =>
                  refreshCodexPlannerQualification(opts.store, {
                    provider_id: c.provider,
                    model_entry_id: c.model_entry_id,
                    model: c.model,
                    scratchDir: opts.scratch,
                    timeoutMs: 2_000,
                    env: exeEnv,
                    actor: "TEST",
                  }),
              })
          : undefined,
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
              env: exeEnv,
              allowedCapabilities: CAPS,
              capabilitySets: CAP_SETS,
            })
          : (geminiCalls.push(1), (opts.geminiPlan ?? (async () => ({
              tasks: [
                { task_key: "T1", title: "g", task_instruction: "write goal to mission_goal.txt then reply DONE.", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
                { task_key: "T2", title: "g2", task_instruction: "write note.txt then reply DONE.", required_capabilities: ["REASONING"], depends_on: ["T1"], metadata: { network_requirement: { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED" } } },
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
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "ok");
    const { res, geminiCalls, run } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
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

  it("B. boot CLI missing → codex FAILED/CLI_MISSING, ZERO plan, gemini wins #2 (R5)", async () => {
    const dir = freshDir("b");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    // Boot-shaped durable evidence: the qualification probe already
    // recorded CLI_MISSING — the codex planner is operationally dead,
    // NOT structurally corrupt. R5: the candidate settles a typed FAILED
    // attempt and failover proceeds to gemini.
    const codex = await seedCodexCandidate(store, { cliMissing: true });
    const { res, geminiCalls } = await runPool({
      store, codex, dir,
      exeEnv: { PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex") },
      scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.winner.attempt_no).toBe(2);
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.CLI_MISSING);
    expect(geminiCalls.length).toBe(1);
    // ZERO codex plan invocation (bounded refresh probes may run — the
    // invoke ledger must show no PLAN spawn).
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
  });

  it("B2. stale probe evidence on a QUALIFIED provider → refresh repairs → codex keeps #1", async () => {
    const dir = freshDir("b2");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    // Availability-channel drift (§4A): provider stays QUALIFIED + valid
    // receipt, but probe_state drifted to PROBE_TIMEOUT →
    // PROVIDER_PROBE_CURRENT fails (availability, not authority) → ONE
    // bounded canonical refresh re-probes through the REAL codex
    // transport seams → fresh evidence PASS → full eligibility PASS →
    // codex invoked and wins #1.
    pokeProvider(store, (p) => { p.probe_state = "PROBE_TIMEOUT"; });
    const { exe } = makeFakeCodex(dir, "ok");
    const { res, geminiCalls } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.attempt_no).toBe(1);
    expect(res.winner.provider).toBe("codex-cli");
    expect(res.winner.outcome).toBe("SUCCESS");
    expect(geminiCalls.length).toBe(0);
    const ledger = invokeLedger(dir);
    // Bounded refresh: exactly ONE validateAccess probe + ONE model probe
    // (2 PROBE invocations), then the real plan invocation.
    expect(ledger.filter((k) => k === "PROBE").length).toBe(2);
    expect(ledger.filter((k) => k === "PLAN").length).toBe(1);
  });

  it("B3. refresh probe still dead → refresh-committed UNQUALIFIED is availability evidence → typed FAILED → gemini (§4A fail)", async () => {
    const dir = freshDir("b3");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.probe_state = "PROBE_TIMEOUT"; });
    // Probe binary dead: refresh's canonical requalification FAILS and
    // legitimately stamps UNQUALIFIED — that is availability evidence
    // committed through canonical seams, so the attempt settles FAILED
    // (Gemini proceeds), not an authority abort. ZERO plan spawn.
    const { res, geminiCalls } = await runPool({
      store, codex, dir,
      exeEnv: { PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex") },
      scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.CLI_MISSING);
    expect(res.attempts[0].warnings.join(",")).toContain("refresh_failed");
    expect(geminiCalls.length).toBe(1);
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
    // Durable mark committed by the failed requalification stays for the
    // operator — a SECOND eligibility evaluation now fails upfront.
    const prov = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((prov.conditions as string[]).includes("UNQUALIFIED")).toBe(true);
  });

  it("C. auth failure at invoke → FAILED/AUTH_REJECTED → gemini wins #2", async () => {
    const dir = freshDir("c");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "authfail");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "authfail" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.attempt_no).toBe(2);
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.AUTH_REJECTED);
    expect(res.attempts[0].warnings.join(",")).toContain("CODEX_AUTH_FAILED");
  });

  it("D. model unavailable → FAILED/MODEL_UNAVAILABLE → gemini wins", async () => {
    const dir = freshDir("d");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "modelunavail");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "modelunavail" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE);
  });

  it("E. timeout → FAILED/TIMEOUT + child killed (no orphan process)", async () => {
    const dir = freshDir("e");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
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
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "garbage");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "garbage" }, scratch: path.join(dir, "scr"),
    });
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE);
    expect(res.attempts[0].warnings.join(",")).toContain("CODEX_OUTPUT_INVALID");
    expect(res.winner.provider).toBe("gemini");
  });

  it("G. canonically-invalid plan (undeclared remote dep) → PLAN_INVALID → gemini wins", async () => {
    const dir = freshDir("g");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "remote_no_edge");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "remote_no_edge" }, scratch: path.join(dir, "scr"),
    });
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.PLAN_INVALID);
    expect(res.winner.provider).toBe("gemini");
  });

  it("H. authority separation — planner argv is read-only/no-net/isolated; zero governed side effects", async () => {
    const dir = freshDir("h");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
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
    await runPool({ store, codex, exe, dir, exeEnv: {}, scratch: path.join(dir, "scr") });
    const after = store.list("governed_task").length + store.list("execution").length;
    expect(after).toBe(before); // planning produced zero executor/dispatch entities
    expect(store.list("planner_attempt").length).toBe(1); // only planner evidence
  });

  it("I. planner↔DSH disjointness: aliased DSH model + missing role both fail closed", async () => {
    const dir = freshDir("i");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
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

/**
 * CPL-1 R1 §4 — adversarial canonical-eligibility matrix. Every case
 * proves the codex planner passes the FULL Phase E authority (identical
 * to HTTP candidates): structural/operator violations → authority throw,
 * ZERO codex invocation, no auto-revive; refreshable currentness → ONE
 * bounded canonical refresh → only fresh PASS evidence may invoke.
 */
describe("CPL-1 R1 adversarial eligibility (§4)", () => {
  it("B. provider DISABLED/BLOCKED → authority throw, ZERO invocation, no auto-revive", async () => {
    const dir = freshDir("r1b");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.conditions = ["DISABLED"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0); // ZERO codex invocation — no probe, no plan
    const a = store.list("planner_attempt");
    expect(a.length).toBe(1);
    expect(String(a[0].warnings)).toContain("AUTHORITY_REJECTED:FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE");
  });

  it("C. provider receipt fingerprint mismatch → authority throw, ZERO invocation", async () => {
    const dir = freshDir("r1c");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    // Drift a material identity facet AFTER qualification → the minted
    // provider receipt no longer binds → PROVIDER_RECEIPT_CURRENT fails
    // (authority channel — a stale receipt is never refreshed silently).
    pokeProvider(store, (p) => { p.configured_endpoint_identity = "codex-cli://mutated-endpoint"; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("D. provider/model ownership mismatch → MODEL_PROVIDER_MATCH FAIL → throw, ZERO invocation", async () => {
    const dir = freshDir("r1d");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.provider_id = "foreign-provider"; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("E. unresolved provider_id contradiction → authority throw, ZERO invocation", async () => {
    const dir = freshDir("r1e");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => {
      m.contradictions = [{ field: "provider_id", prior: "codex-cli", candidate: "foreign-provider" }];
    });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("F1. model STALE → refreshable → canonical requalification repairs → codex wins #1", async () => {
    const dir = freshDir("r1f1");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["STALE"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    // MODEL_NOT_STALE is availability-channel: ONE bounded canonical
    // refresh re-probes + requalifies (issueQualificationReceipt
    // canonically supersedes STALE) → full eligibility PASS → invoke.
    expect(res.winner.attempt_no).toBe(1);
    expect(res.winner.provider).toBe("codex-cli");
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(1);
  });

  it("F2. model UNAVAILABLE → refresh cannot legitimately repair → ZERO plan, gemini wins", async () => {
    const dir = freshDir("r1f2");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["UNAVAILABLE"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].warnings.join(",")).toContain("refresh_failed");
    // The bounded refresh ran its probes but the canonical seams keep
    // UNAVAILABLE — no plan invocation, no auto-revive.
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
  });

  it("F3. model BLOCKED → authority throw, ZERO invocation", async () => {
    const dir = freshDir("r1f3");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["BLOCKED"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("G. model receipt fingerprint invalid → AUTHORITY throw, ZERO invocation (§4C)", async () => {
    const dir = freshDir("r1g");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModelReceipt(store, codex.model_entry_id, (r) => { r.material_fingerprint = "deadbeef".repeat(8); });
    const { exe } = makeFakeCodex(dir, "ok");
    // MODEL_RECEIPT_CURRENT is an AUTHORITY gate — an invalid/stale
    // receipt is a structural violation: ZERO invocation, no planner
    // refresh (remediation is operator canonical requalification only).
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
    const a = store.list("planner_attempt");
    expect(String(a[0].warnings)).toContain("AUTHORITY_REJECTED");
  });

  it("G2. provider receipt fingerprint invalid → AUTHORITY throw, ZERO invocation (§4C)", async () => {
    const dir = freshDir("r1g2");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    const pc = new ProviderCatalog(store);
    const p = pc.getProvider(CODEX_CLI_PROVIDER_ID)!;
    const rid = String(p.current_qualification_receipt_id);
    const r = store.get("provider_qualification", rid);
    r.material_fingerprint = "deadbeef".repeat(8);
    store.put("provider_qualification", rid, r, Number(r.version));
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("H. malformed capability scope on current receipt → refresh mints valid scope → codex wins #1", async () => {
    const dir = freshDir("r1h");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModelReceipt(store, codex.model_entry_id, (r) => { r.capability_scope = []; });
    const { exe } = makeFakeCodex(dir, "ok");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    // MODEL_QUALIFICATION_SCOPE_VALID is availability-channel — a fresh
    // canonical qualification mints a receipt with a valid scope → invoke.
    expect(res.winner.attempt_no).toBe(1);
    expect(res.winner.provider).toBe("codex-cli");
  });

  it("I. capability probe no longer current → ONE bounded refresh → new PASS authorizes codex #1", async () => {
    const dir = freshDir("r1i");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    // A newer FAIL probe receipt supersedes the qualified window →
    // MODEL_CAPABILITY_PROBE_CURRENT fails (availability).
    await probeModel(store, codex.model_entry_id, 1, {
      probeFn: async () => ({ result: "FAIL", latency_ms: 1, capability_evidence: { text_inference: "FAIL" }, requests_used: 1, tokens_used: 1 }),
      capability: "text_inference",
      executorId: "CODEX",
      actor: "TEST",
    });
    const { exe } = makeFakeCodex(dir, "ok");
    const { res } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.attempt_no).toBe(1);
    expect(res.winner.provider).toBe("codex-cli");
    // Refresh produced exactly one new PASS probe cycle (2 probe
    // invocations: provider + model) before the plan invocation.
    expect(invokeLedger(dir).filter((k) => k === "PROBE").length).toBe(2);
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(1);
  });
});

describe("CPL-1 R1 auth isolation + timeout authority", () => {
  it("§6/B. planner child never inherits CODEX_API_KEY/OPENAI_API_KEY; CODEX_HOME present", async () => {
    const dir = freshDir("auth-iso");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    const { exe } = makeFakeCodex(dir, "ok");
    const envFile = path.join(dir, "child-env.json");
    const codexHome = path.join(dir, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    // Parent carries ambient API keys + a valid CODEX_HOME — the planner
    // child must see CODEX_HOME but NOT either API key.
    const { res } = await runPool({
      store, codex, exe, dir,
      exeEnv: {
        FAKE_CODEX_BEHAVIOR: "ok",
        FAKE_CODEX_ENVFILE: envFile,
        CODEX_HOME: codexHome,
        CODEX_API_KEY: "fake-nonprod-dummy-value",
        OPENAI_API_KEY: "fake-nonprod-dummy-value",
      },
      scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("codex-cli");
    const seen = JSON.parse(fs.readFileSync(envFile, "utf8"));
    expect(seen.CODEX_HOME).toBe(true);
    expect(seen.CODEX_API_KEY).toBe(false);
    expect(seen.OPENAI_API_KEY).toBe(false);
  });

  it("§10. defaults: probe=60000, planner=900000; independent overrides; no cross-coupling", () => {
    expect(MODEL_PROBE_TIMEOUT.defaultValue).toBe(60_000);
    expect(CODEX_PLANNER_TIMEOUT.defaultValue).toBe(900_000);
    expect(modelProbeTimeoutMs({})).toBe(60_000);
    expect(codexPlannerTimeoutMs({})).toBe(900_000);
    // Independent overrides — each knob reads only its own env name.
    expect(modelProbeTimeoutMs({ PAIR_MODEL_PROBE_TIMEOUT_MS: "20000" })).toBe(20_000);
    expect(codexPlannerTimeoutMs({ PAIR_CODEX_PLANNER_TIMEOUT_MS: "600000" })).toBe(600_000);
    expect(modelProbeTimeoutMs({ PAIR_CODEX_PLANNER_TIMEOUT_MS: "600000" })).toBe(60_000);
    expect(codexPlannerTimeoutMs({ PAIR_MODEL_PROBE_TIMEOUT_MS: "20000" })).toBe(900_000);
    // Bounds still fail closed on malformed input.
    expect(() => modelProbeTimeoutMs({ PAIR_MODEL_PROBE_TIMEOUT_MS: "abc" })).toThrow();
    expect(() => codexPlannerTimeoutMs({ PAIR_CODEX_PLANNER_TIMEOUT_MS: "abc" })).toThrow();
  });

  it("§10. sleeping codex probe is killed at the configured budget — no hidden 60s floor/ceiling", async () => {
    const dir = freshDir("probe-budget");
    const { exe } = makeFakeCodex(dir, "sleep");
    // R3.B — codexPlannerProbe resolves the executable from opts.env
    // (PAIR_CODEX_PLANNER_EXECUTABLE); there is no `executable` option.
    // Proving the FAKE binary is what ran: invoke ledger + pidfile.
    const invokeLog = path.join(dir, "invoke.log");
    const pidFile = path.join(dir, "child.pid");
    const t0 = Date.now();
    const r = await codexPlannerProbe({
      model: "gpt-6.1-sol",
      timeoutMs: 2_500,
      scratchDir: path.join(dir, "scr"),
      env: {
        ...process.env,
        PAIR_CODEX_PLANNER_EXECUTABLE: exe,
        FAKE_CODEX_BEHAVIOR: "sleep",
        FAKE_CODEX_INVOKELOG: invokeLog,
        FAKE_CODEX_PIDFILE: pidFile,
      },
    });
    expect(r.outcome).toBe("TIMEOUT");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2_400);
    expect(elapsed).toBeLessThan(15_000); // honored the 2.5s config, not a 60s substitute
    // The fake sleeping executable was the child actually spawned — ledger
    // recorded the probe invocation and the pidfile carries its pid.
    expect(fs.existsSync(invokeLog)).toBe(true);
    expect(fs.readFileSync(invokeLog, "utf8").trim()).toBe("PROBE");
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    // Timed-out child was killed — no orphan sleeping process survives.
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

/**
 * CPL-1 R2 — production probe-timeout default + ACTUAL provider-STALE
 * canonical recovery. STALE is availability-channel (PROVIDER_CURRENT) —
 * it earns ONE bounded canonical refresh whose first step is a canonical
 * re-observation of the SAME configured codex-cli identity through
 * ProviderCatalog.upsertCandidate (STALE → REAPPEARED, stale authority
 * demoted), then the normal validateAccess → qualify → probe/qualify
 * chain re-mints authority. REMOVED/DISABLED/receipt/identity violations
 * never reach the refresh seam — upfront authority throw, ZERO refresh,
 * ZERO codex invocation.
 */
describe("CPL-1 R2 — startup default + provider STALE canonical recovery", () => {
  it("R2.A. production start script default probe timeout is 60000, no hidden floor", () => {
    const script = fs.readFileSync(path.join(ROOT_DIR, "scripts", "start-pair-live.sh"), "utf8");
    expect(script).toContain('PAIR_MODEL_PROBE_TIMEOUT_MS="${PAIR_MODEL_PROBE_TIMEOUT_MS:-60000}"');
    expect(script).not.toMatch(/PAIR_MODEL_PROBE_TIMEOUT_MS="\$\{PAIR_MODEL_PROBE_TIMEOUT_MS:-30000\}"/);
  });

  it("R2.B1. provider STALE → canonical re-observation → fresh authority → codex wins #1", async () => {
    const dir = freshDir("r2-stale");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.conditions = ["STALE"]; });
    // Prove the canonical gate really fails BEFORE the pool runs:
    // PROVIDER_CURRENT = FAIL (availability channel → refreshable).
    const pre = providerModelEligibility(store, CODEX_CLI_PROVIDER_ID, codex.model_entry_id);
    expect(pre.gates.PROVIDER_CURRENT).toBe("FAIL");
    const { exe } = makeFakeCodex(dir, "ok");
    const { res, geminiCalls } = await runPool({
      store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("codex-cli");
    expect(res.winner.attempt_no).toBe(1);
    expect(geminiCalls.length).toBe(0);
    const ledger = invokeLedger(dir);
    // Exactly ONE bounded recovery cycle: 1 validateAccess probe +
    // 1 model probe, then exactly ONE codex PLAN invocation.
    expect(ledger.filter((k) => k === "PROBE").length).toBe(2);
    expect(ledger.filter((k) => k === "PLAN").length).toBe(1);
    // Canonical seams cleared STALE legitimately and re-minted authority.
    const p = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((p.conditions as string[]).includes("STALE")).toBe(false);
    expect(p.probe_state).toBe("PROBED");
    expect(p.auth_state).toBe("AUTH_OK");
    expect(p.lifecycle_state).toBe("QUALIFIED");
    expect(p.current_qualification_receipt_id).not.toBeNull();
  });

  it("R2.B2. provider STALE + probe still fails → ZERO plan, typed FAILED, gemini wins", async () => {
    const dir = freshDir("r2-stale-fail");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.conditions = ["STALE"]; });
    const { res, geminiCalls } = await runPool({
      store, codex, dir,
      exeEnv: { PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex") },
      scratch: path.join(dir, "scr"),
    });
    // Re-observation cleared STALE legitimately, but the dead probe makes
    // requalification fail → typed FAILED attempt, ZERO plan spawn, gemini.
    expect(res.winner.provider).toBe("gemini");
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(geminiCalls.length).toBe(1);
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
  });

  it("R2.B3. provider REMOVED → authority throw, ZERO refresh, ZERO codex invocation", async () => {
    const dir = freshDir("r2-removed");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.conditions = ["REMOVED"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    // REMOVED must NOT flow through upsertCandidate re-observation: the
    // mark stays and no probe/plan ever spawned.
    expect(invokeLedger(dir).length).toBe(0);
    const p = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((p.conditions as string[]).includes("REMOVED")).toBe(true);
    const a = store.list("planner_attempt");
    expect(String(a[0].warnings)).toContain("AUTHORITY_REJECTED");
  });
});

/**
 * CPL-1 R3.A — structural pre-probe guard: refreshCodexPlannerQualification
 * is the shared path both the pool refresh and boot qualification use, so
 * explicit operator/authority marks must fail closed BEFORE any
 * codexPlannerProbe — even when the caller never ran eligibility first
 * (boot) or a mark lands after the availability verdict (TOCTOU).
 * Legitimate bootstrap (discovery/unprobed) is untouched: STALE +
 * PROBE_TIMEOUT recovery paths (R2.B1/R1 §15) still reach the probe.
 */
describe("CPL-1 R3.A — structural pre-probe guard (ZERO codex probe)", () => {
  /** Boot-shaped direct refresh: the caller performs NO eligibility check
   *  before invoking the shared qualification/refresh seam. */
  async function directRefreshRejects(
    store: PairEvidenceStore,
    modelEntryId: string,
    dir: string,
    expected: RegExp,
  ): Promise<void> {
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      refreshCodexPlannerQualification(store, {
        provider_id: CODEX_CLI_PROVIDER_ID,
        model_entry_id: modelEntryId,
        model: "gpt-6.1-sol",
        scratchDir: path.join(dir, "scr"),
        timeoutMs: 2_000,
        env: {
          ...process.env,
          PAIR_CODEX_PLANNER_EXECUTABLE: exe,
          FAKE_CODEX_BEHAVIOR: "ok",
          FAKE_CODEX_INVOKELOG: path.join(dir, "invokes.log"),
        },
        actor: "TEST",
      }),
    ).rejects.toThrow(expected);
    // ZERO codex probe — the fake executable ledger is empty.
    expect(invokeLedger(dir).length).toBe(0);
  }

  it("R3.A1. provider DISABLED → fail closed BEFORE probe", async () => {
    const dir = freshDir("r3-disabled");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.conditions = ["DISABLED"]; });
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
  });

  it("R3.A2. model BLOCKED → fail closed BEFORE probe", async () => {
    const dir = freshDir("r3-model-blocked");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["BLOCKED"]; });
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE/);
  });

  it("R3.A3. model DEPRECATED → fail closed BEFORE probe", async () => {
    const dir = freshDir("r3-model-deprecated");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["DEPRECATED"]; });
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE/);
  });

  it("R3.A4. model REMOVED → fail closed BEFORE probe", async () => {
    const dir = freshDir("r3-model-removed");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.conditions = ["REMOVED"]; });
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE/);
  });

  it("R3.A5. TOCTOU — refreshable verdict, DISABLED installed before refresh → aborts, ZERO probe", async () => {
    const dir = freshDir("r3-toctou");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    // Initial eligibility verdict is refreshable: probe_state drift is an
    // availability-channel failure (probe-currentness gate FAIL, authority
    // gates PASS) → the pool would award ONE bounded refresh.
    pokeProvider(store, (p) => { p.probe_state = "PROBE_TIMEOUT"; });
    const verdict = providerModelEligibility(store, CODEX_CLI_PROVIDER_ID, codex.model_entry_id);
    expect(verdict.eligible).toBe(false);
    expect(verdict.gates.PROVIDER_NOT_BLOCKED).toBe("PASS");
    // TOCTOU: an operator DISABLED lands between the verdict and refresh.
    pokeProvider(store, (p) => { p.conditions = ["DISABLED"]; });
    // The guard re-reads canonical state at refresh start → ZERO probe.
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    const p = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((p.conditions as string[]).includes("DISABLED")).toBe(true);
  });

  it("R3.A6. planner role violated (DSH_EXECUTION on the model) → fail closed BEFORE probe", async () => {
    const dir = freshDir("r3-role");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    assignModelRole(store, codex.model_entry_id, MODEL_ROLE.DSH_EXECUTION, { actor: "TEST" });
    await directRefreshRejects(store, codex.model_entry_id, dir, /FAIL_CLOSED_MODEL_ROLE|FAIL_CLOSED_PLANNER_DSH_OVERLAP/);
  });

  it("R3.A7. bootstrap still probes — discovery/unprobed provider is NOT blocked by the guard", async () => {
    const dir = freshDir("r3-bootstrap");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    // Seeded catalog rows but NO qualification/probe evidence — the
    // legitimate first-boot shape the guard must let through.
    const meId = ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST");
    assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
    const { exe } = makeFakeCodex(dir, "ok");
    await refreshCodexPlannerQualification(store, {
      provider_id: CODEX_CLI_PROVIDER_ID,
      model_entry_id: meId,
      model: "gpt-6.1-sol",
      scratchDir: path.join(dir, "scr"),
      timeoutMs: 5_000,
      env: {
        ...process.env,
        PAIR_CODEX_PLANNER_EXECUTABLE: exe,
        FAKE_CODEX_BEHAVIOR: "ok",
        FAKE_CODEX_INVOKELOG: path.join(dir, "invokes.log"),
      },
      actor: "TEST",
    });
    // Boot qualification ran the bounded probes legitimately.
    expect(invokeLedger(dir).filter((k) => k === "PROBE").length).toBe(2);
    const p = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect(p.lifecycle_state).toBe("QUALIFIED");
  });
});

/**
 * CPL-1 R4 — UNQUALIFIED is transient residue, not an operator denial; and
 * the pre-probe guard must also prove canonical provider↔model identity
 * linkage (MODEL_PROVIDER_MATCH / MODEL_PROVIDER_IDENTITY_CONSISTENT)
 * before any codexPlannerProbe — including the boot path that never ran
 * eligibility first and the plan-time TOCTOU where linkage breaks after
 * the availability verdict.
 */
describe("CPL-1 R4 — transient UNQUALIFIED recovery + pre-probe identity authority", () => {
  /** Boot-shaped direct refresh; returns the refresh result (callers get
   *  outcomes, structural violations throw IntegrityError). */
  async function bootRefresh(
    store: PairEvidenceStore,
    modelEntryId: string,
    dir: string,
    env: Record<string, string>,
  ): Promise<{ access_outcome: string; provider_qualified: boolean; model_probe_result: string | null; model_qualified: boolean }> {
    return refreshCodexPlannerQualification(store, {
      provider_id: CODEX_CLI_PROVIDER_ID,
      model_entry_id: modelEntryId,
      model: "gpt-6.1-sol",
      scratchDir: path.join(dir, "scr"),
      timeoutMs: 4_000,
      env: {
        ...process.env,
        FAKE_CODEX_INVOKELOG: path.join(dir, "invokes.log"),
        ...env,
      },
      actor: "TEST",
    });
  }

  it("R4.A1. UNQUALIFIED is transient: failed boot stamps it, second boot canonically recovers", async () => {
    const dir = freshDir("r4-unqualified");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meId = ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST");
    assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
    // First boot-shaped qualification — dead executable → probe fails →
    // canonical qualify stamps UNQUALIFIED residue.
    const r1 = await bootRefresh(store, meId, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex"),
    });
    expect(r1.provider_qualified).toBe(false);
    const p1 = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((p1.conditions as string[]).includes("UNQUALIFIED")).toBe(true);
    // Second boot-shaped call with a working fake — the guard must NOT
    // deadlock on UNQUALIFIED: bounded probes run, canonical qualify
    // succeeds and legitimately removes the residue.
    const { exe } = makeFakeCodex(dir, "ok");
    const r2 = await bootRefresh(store, meId, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe,
      FAKE_CODEX_BEHAVIOR: "ok",
    });
    expect(r2.provider_qualified).toBe(true);
    const ledger = invokeLedger(dir);
    expect(ledger.filter((k) => k === "PROBE").length).toBe(2);
    const p2 = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect((p2.conditions as string[]).includes("UNQUALIFIED")).toBe(false);
    expect(p2.lifecycle_state).toBe("QUALIFIED");
    expect(p2.auth_state).toBe("AUTH_OK");
    expect(p2.probe_state).toBe("PROBED");
    expect(p2.current_qualification_receipt_id).not.toBeNull();
  });

  it("R4.B1. model.provider_id ≠ provider → MODEL_PROVIDER_MATCH FAIL → ZERO probe", async () => {
    const dir = freshDir("r4-provider-mismatch");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => { m.provider_id = "foreign-provider"; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(bootRefresh(store, codex.model_entry_id, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok",
    })).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("R4.B2. unresolved provider_id contradiction → MODEL_PROVIDER_IDENTITY_CONSISTENT FAIL → ZERO probe", async () => {
    const dir = freshDir("r4-contradiction");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeModel(store, codex.model_entry_id, (m) => {
      m.contradictions = [{ field: "provider_id", claimed: "other-provider", canonical: CODEX_CLI_PROVIDER_ID }];
    });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(bootRefresh(store, codex.model_entry_id, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok",
    })).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("R4.B3. TOCTOU — refreshable verdict, provider_id mutated before refresh → ZERO probe", async () => {
    const dir = freshDir("r4-toctou-match");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.probe_state = "PROBE_TIMEOUT"; });
    const verdict = providerModelEligibility(store, CODEX_CLI_PROVIDER_ID, codex.model_entry_id);
    expect(verdict.gates.MODEL_PROVIDER_MATCH).toBe("PASS");
    // TOCTOU: linkage broken after the verdict, before refresh.
    pokeModel(store, codex.model_entry_id, (m) => { m.provider_id = "foreign-provider"; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(bootRefresh(store, codex.model_entry_id, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok",
    })).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });

  it("R4.B4. TOCTOU — refreshable verdict, provider_id contradiction installed before refresh → ZERO probe", async () => {
    const dir = freshDir("r4-toctou-contradiction");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    pokeProvider(store, (p) => { p.probe_state = "PROBE_TIMEOUT"; });
    const verdict = providerModelEligibility(store, CODEX_CLI_PROVIDER_ID, codex.model_entry_id);
    expect(verdict.gates.MODEL_PROVIDER_IDENTITY_CONSISTENT).toBe("PASS");
    pokeModel(store, codex.model_entry_id, (m) => {
      m.contradictions = [{ field: "provider_id", claimed: "other-provider", canonical: CODEX_CLI_PROVIDER_ID }];
    });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(bootRefresh(store, codex.model_entry_id, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok",
    })).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).length).toBe(0);
  });
});

/**
 * CPL-1 R5 — operational codex unavailability is a typed FAILED attempt,
 * not a whole-pool abort. A boot-shaped qualification run (the SAME
 * refreshCodexPlannerQualification seam production boot uses) commits
 * durable probe/auth evidence; the plan-time codex-specific eligibility
 * then classifies it as failover-eligible while every structural
 * violation keeps throwing.
 */
describe("CPL-1 R5 — operational codex failure → typed attempt → gemini #2", () => {
  async function bootQualify(
    store: PairEvidenceStore,
    modelEntryId: string,
    dir: string,
    env: Record<string, string>,
    timeoutMs = 4_000,
  ): Promise<void> {
    await refreshCodexPlannerQualification(store, {
      provider_id: CODEX_CLI_PROVIDER_ID,
      model_entry_id: modelEntryId,
      model: "gpt-6.1-sol",
      scratchDir: path.join(dir, "scr"),
      timeoutMs,
      env: { ...process.env, FAKE_CODEX_INVOKELOG: path.join(dir, "boot-invokes.log"), ...env },
      actor: "TEST",
    });
  }

  /** Seed the catalog like a boot that found a dead codex: run the real
   *  qualification seam against the given fake behavior, then pool. */
  async function runAfterBootFailure(
    dir: string,
    behavior: string,
    expectedClass: string,
    extra: { timeoutMs?: number } = {},
  ): Promise<void> {
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meId = ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST");
    assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
    const { exe } = makeFakeCodex(dir, behavior);
    await bootQualify(store, meId, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe,
      FAKE_CODEX_BEHAVIOR: behavior,
    }, extra.timeoutMs ?? 4_000);
    // Boot committed durable operational evidence; plan time now.
    const codex: PlannerCandidate = {
      provider: CODEX_CLI_PROVIDER_ID, model: "gpt-6.1-sol", transport: "codex_cli",
      plan: async () => ({ tasks: [] }),
      model_entry_id: meId,
    } as PlannerCandidate;
    const { res, geminiCalls } = await runPool({
      store, codex, dir, exe,
      exeEnv: { PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: behavior },
      scratch: path.join(dir, "scr"),
    });
    expect(res.winner.provider).toBe("gemini");
    expect(res.winner.attempt_no).toBe(2);
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe(expectedClass);
    expect(geminiCalls.length).toBe(1);
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
  }

  it("R5.A2. boot AUTH_FAILED → codex FAILED/AUTH_REJECTED → gemini #2", async () => {
    await runAfterBootFailure(freshDir("r5-authfail"), "authfail", PLANNER_FAILURE_CLASS.AUTH_REJECTED);
  });

  it("R5.A3. boot MODEL_UNAVAILABLE → codex FAILED/MODEL_UNAVAILABLE → gemini #2", async () => {
    await runAfterBootFailure(freshDir("r5-modelunavail"), "modelunavail", PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE);
  });

  it("R5.A4. boot TIMEOUT → codex FAILED/TIMEOUT → gemini #2", async () => {
    await runAfterBootFailure(freshDir("r5-timeout"), "sleep", PLANNER_FAILURE_CLASS.TIMEOUT, { timeoutMs: 1_200 });
  });

  it("R5.A5. boot RATE_LIMITED → codex FAILED/QUOTA_RATE_LIMITED → gemini #2", async () => {
    await runAfterBootFailure(freshDir("r5-ratelimit"), "ratelimit", PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED);
  });

  it("R5.A6. recovery regression — boot fails (gemini) → canonical requalification PASS → codex wins #1 next run", async () => {
    const dir = freshDir("r5-recovery");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meId = ensureCodexCliPlannerCatalog(store, "gpt-6.1-sol", "TEST");
    assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
    // Boot 1: dead CLI → operational failure stamped → gemini fallback.
    await bootQualify(store, meId, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex"),
    });
    const codex = {
      provider: CODEX_CLI_PROVIDER_ID, model: "gpt-6.1-sol", transport: "codex_cli",
      model_entry_id: meId,
    } as PlannerCandidate;
    const dead = { PAIR_CODEX_PLANNER_EXECUTABLE: path.join(dir, "nonexistent-codex") };
    const r1 = await runPool({ store, codex, dir, exeEnv: dead, scratch: path.join(dir, "scr") });
    expect(r1.res.winner.provider).toBe("gemini");
    expect(r1.res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.CLI_MISSING);
    // Boot 2 / canonical requalification: CLI back → full qualification PASS.
    const { exe } = makeFakeCodex(dir, "ok");
    await bootQualify(store, meId, dir, {
      PAIR_CODEX_PLANNER_EXECUTABLE: exe, FAKE_CODEX_BEHAVIOR: "ok",
    });
    const p = new ProviderCatalog(store).getProvider(CODEX_CLI_PROVIDER_ID)!;
    expect(p.lifecycle_state).toBe("QUALIFIED");
    expect((p.conditions as string[]).includes("UNQUALIFIED")).toBe(false);
    // Next planner run: codex invoked and wins #1 — transient failure did
    // not permanently demote it.
    const r2 = await runPool({
      store, codex, dir, exe, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr"),
    });
    expect(r2.res.winner.provider).toBe("codex-cli");
    expect(r2.res.winner.attempt_no).toBe(1);
    expect(r2.geminiCalls.length).toBe(0);
  });

  it("R5.A7. UNQUALIFIED alone (no operational probe evidence) → still authority throw, no failover", async () => {
    const dir = freshDir("r5-unqualified-structural");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const codex = await seedCodexCandidate(store);
    // Manual UNQUALIFIED stamp with a HEALTHY probe history (PROBED) —
    // no operational evidence → NOT failover-eligible.
    pokeProvider(store, (p) => { p.conditions = ["UNQUALIFIED"]; });
    const { exe } = makeFakeCodex(dir, "ok");
    await expect(
      runPool({ store, codex, exe, dir, exeEnv: { FAKE_CODEX_BEHAVIOR: "ok" }, scratch: path.join(dir, "scr") }),
    ).rejects.toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    expect(invokeLedger(dir).filter((k) => k === "PLAN").length).toBe(0);
  });
});
