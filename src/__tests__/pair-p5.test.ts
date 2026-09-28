/**
 * P5 REAL MULTI-EXECUTOR tests: PAIR_NATIVE + DEEPSEEK_HARNESS (ACP_STDIO)
 * + CODEX (NATIVE_CLI/CODEX_CLI_JSONL). Real subprocesses speak the real
 * protocols — the only substitution is the vendor binary (fixture agents),
 * because no dsh/codex runtime is installed in this environment.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ArtifactProvenanceValidator,
  CodexCliExecutorAdapter,
  DshExecutorAdapter,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  PAIR_NATIVE_ROUTE_ID,
  registerGovernedExecutors,
  validatePlanProposal,
  workerExecutionId,
  acpRunRoot,
  codexRunRoot,
  CODEX_EXECUTOR_ID,
  DSH_EXECUTOR_ID,
  ROUTE_IDS,
} from "../pair/index.js";

const FAKE_ACP = path.resolve(__dirname, "fixtures", "fake-acp-agent.mjs");
const FAKE_CODEX = path.resolve(__dirname, "fixtures", "fake-codex.mjs");
const FAKE_SECRET = "P5_TEST_SECRET_VALUE_XYZ";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p5-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("spec-bound harness must not call inference");
  },
};
const noopCompute = {
  exec: async () => {
    throw new Error("no remote compute");
  },
  writeFile: async () => {
    throw new Error("no remote compute");
  },
  readFile: async () => {
    throw new Error("no remote compute");
  },
} as unknown as ComputeClient;

const secretEnv = (n: string) =>
  ["DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].includes(n)
    ? FAKE_SECRET
    : process.env[n];

interface Ctx {
  db: ReturnType<typeof createDatabase>["raw"];
  capsRegistered: Set<string>;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runner: PairNativeWorkerRunner;
  adapter: PairNativeExecutorAdapter;
  dsh: DshExecutorAdapter | null;
  codex: CodexCliExecutorAdapter | null;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  workspace: string;
  dir: string;
}

function makeCtx(
  name: string,
  opts: { dsh?: boolean; codex?: boolean; priorities?: Record<string, number> } = {},
): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const automaton = createDatabase(path.join(dir, "state.db"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const runner = new PairNativeWorkerRunner({
    db: automaton.raw,
    config: { name: "p5-test", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p5-test" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot: path.join(dir, "journal"),
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const journalRoot = path.join(dir, "journal");
  const dsh =
    opts.dsh === false
      ? null
      : new DshExecutorAdapter({
          journalRoot,
          launchOverride: { command: "node", args: [FAKE_ACP, "--profile", "acp"] },
          envReader: secretEnv,
        });
  const codex =
    opts.codex === false
      ? null
      : new CodexCliExecutorAdapter({
          journalRoot,
          executable: "node",
          executableArgs: [FAKE_CODEX],
          envReader: secretEnv,
        });
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const ctx = { db: automaton.raw, capsRegistered: new Set<string>(), store, service, runner, adapter, dsh, codex, gate, registry, router, workspace, dir };
  // Register governed executors: probe → qualify → canonical identity → route.
  const adapters = new Map<string, ExecutorAdapter>();
  if (dsh) adapters.set(DSH_EXECUTOR_ID, dsh);
  if (codex) adapters.set(CODEX_EXECUTOR_ID, codex);
  registerGovernedExecutors(service, adapters, "test", { priorities: opts.priorities });
  return ctx;
}

function registerPairNative(ctx: Ctx, metadataOverrides: Record<string, unknown> = {}) {
  return ctx.registry.register({
    executor_id: PAIR_NATIVE_EXECUTOR_ID,
    executor_type: "AUTOMATON_WORKER",
    capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      qualification_state: "QUALIFIED",
      max_concurrency: 4,
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      routing_priority: 100,
      supports_cancel: true,
      ...metadataOverrides,
    },
  });
}

function adaptersOf(ctx: Ctx): Map<string, ExecutorAdapter> {
  const m = new Map<string, ExecutorAdapter>([[PAIR_NATIVE_EXECUTOR_ID, ctx.adapter]]);
  if (ctx.dsh) m.set(DSH_EXECUTOR_ID, ctx.dsh);
  if (ctx.codex) m.set(CODEX_EXECUTOR_ID, ctx.codex);
  return m;
}

interface MissionSeed {
  missionId: string;
  taskIds: string[];
  revision: number;
}

function seedMission(
  ctx: Ctx,
  taskSpecs: Array<Record<string, unknown>>,
  extraCaps: string[] = [],
): MissionSeed {
  const project = ctx.service.createProject({ name: "p5", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p5 multi-executor",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  const allCaps = [
    "FILE_OPERATIONS",
    "AUTOMATON_TASK_EXECUTION",
    "CODE_GENERATION",
    "CODE_EDITING",
    "SHELL_EXECUTION",
    "REASONING",
    "PYTHON_EXECUTION",
    ...extraCaps,
  ];
  for (const c of allCaps) {
    if (!ctx.capsRegistered.has(c)) {
      ctx.service.registerCapability(c, { risk_class: "LOW" });
      ctx.capsRegistered.add(c);
    }
  }
  ctx.service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 3 });
  const proposal = { tasks: taskSpecs };
  const tasks = validatePlanProposal(proposal, new Set(allCaps));
  const committed = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: tasks.map((t) => ({ ...t })),
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const active = ctx.service.activeRevision(String(mission.mission_id));
  return {
    missionId: String(mission.mission_id),
    taskIds: committed.task_ids.map(String),
    revision: Number(active.revision),
  };
}

function requestFor(
  ctx: Ctx,
  m: MissionSeed,
  idx: number,
  opts: {
    capabilities?: string[];
    permissions?: string[];
    instruction?: string;
    dependencyOutputs?: unknown[];
    requestedTools?: string[];
  } = {},
): Record<string, unknown> {
  return {
    mission_id: m.missionId,
    task_id: m.taskIds[idx],
    plan_revision: m.revision,
    task_instruction: opts.instruction ?? "do governed work",
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: opts.permissions ?? ["FILE_WRITE"],
    requested_tools: opts.requestedTools ?? ["SHELL_EXECUTION"],
    constraints: [],
    timeout: 30,
    correlation_id: `corr-p5-${idx}`,
    dependency_outputs: opts.dependencyOutputs ?? [],
    expected_output_contract: { type: "TASK_RESULT" },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function waitTerminal(adapter: ExecutorAdapter, executionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) {
      return o;
    }
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never reached terminal`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// Some tests need required_capabilities on the committed task: patch commitPlan
// task spec via required_capabilities on the proposal task.
function taskSpec(
  task_key: string,
  required: string[],
  instruction: string,
  depends_on: string[] = [],
): Record<string, unknown> {
  return {
    task_key,
    title: `${task_key} governed`,
    task_instruction: instruction,
    required_capabilities: required,
    depends_on,
    metadata: { risk_class: "LOW" },
  };
}

describe("P5 registration & routing", () => {
  it("1: PAIR_NATIVE routing works alongside registered executors", async () => {
    const ctx = makeCtx("t1");
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [
      taskSpec("T1", ["AUTOMATON_TASK_EXECUTION"], "native work"),
    ]);
    // PAIR_NATIVE needs a worker_spec — supply through request contract.
    fs.writeFileSync(path.join(ctx.workspace, "fixture.txt"), "hello");
    const req = {
      ...requestFor(ctx, m, 0, { capabilities: ["AUTOMATON_TASK_EXECUTION"] }),
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            { op: "read_text_file", path: "fixture.txt", idempotency_class: "READ_ONLY", risk_class: "LOW" },
            { op: "finish", result: { summary: "done" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["read_text_file", "finish"],
        },
      },
    };
    const r = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
    expect(String(r.routing_decision.selected_executor)).toBe(PAIR_NATIVE_EXECUTOR_ID);
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.adapter, execId);
    const collected = ctx.gate.collect_execution_result(ctx.adapter, execId);
    expect(String((collected.result as Record<string, unknown>).status)).toBe("COMPLETED");
  }, 40_000);

  it("2: DSH registration + qualification + route seeding", () => {
    const ctx = makeCtx("t2");
    cleanups.push(() => ctx.runner.shutdown());
    const probe = ctx.dsh!.probe();
    expect(probe.available).toBe(true);
    expect(probe.state).toBe("READY");
    expect(probe.runtime_type).toBe("DEEPSEEK_HARNESS_ACP");
    expect(probe.authenticated).toBe(true); // env credential resolvable
    const q = ctx.dsh!.qualify();
    expect(q.qualified).toBe(true);
    const record = ctx.service.getExecutor(DSH_EXECUTOR_ID);
    expect(record).toBeTruthy();
    expect(ctx.service.routes.getRoute(ROUTE_IDS[DSH_EXECUTOR_ID])).toBeTruthy();
    expect(ctx.service.routes.bindingFor(DSH_EXECUTOR_ID, ROUTE_IDS[DSH_EXECUTOR_ID])).toBeTruthy();
    // Absent-runtime truth: mask vendor bin dirs from PATH → stock adapter reports blocked.
    const realPath = process.env.PATH ?? "";
    process.env.PATH = realPath
      .split(path.delimiter)
      .filter((p) => !p.includes(".local"))
      .join(path.delimiter);
    try {
      const stock = new DshExecutorAdapter({ journalRoot: path.join(ctx.dir, "journal") });
      const stockProbe = stock.probe();
      expect(stockProbe.available).toBe(false);
      expect(String(stockProbe.limitations)).toContain("EXECUTABLE_NOT_FOUND");
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("3: CODEX registration + qualification + route seeding", () => {
    const ctx = makeCtx("t3");
    cleanups.push(() => ctx.runner.shutdown());
    const probe = ctx.codex!.probe();
    expect(probe.available).toBe(true);
    expect(probe.runtime_type).toBe("OPENAI_CODEX_CLI");
    const q = ctx.codex!.qualify();
    expect(q.qualified).toBe(true);
    expect(ctx.service.routes.getRoute(ROUTE_IDS[CODEX_EXECUTOR_ID])).toBeTruthy();
    const realPath = process.env.PATH ?? "";
    process.env.PATH = realPath
      .split(path.delimiter)
      .filter((p) => !p.includes(".local"))
      .join(path.delimiter);
    try {
      const stock = new CodexCliExecutorAdapter({ journalRoot: path.join(ctx.dir, "journal") });
      const stockProbe = stock.probe();
      expect(stockProbe.available).toBe(false);
      expect(String(stockProbe.limitations)).toContain("CODEX_EXECUTABLE_NOT_FOUND");
    } finally {
      process.env.PATH = realPath;
    }
  });
});

describe("P5 selection", () => {
  it("4: PAIR_NATIVE selected for AUTOMATON_TASK_EXECUTION", async () => {
    const ctx = makeCtx("t4");
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["AUTOMATON_TASK_EXECUTION"], "native")]);
    const req = {
      ...requestFor(ctx, m, 0),
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [{ op: "finish", result: { summary: "ok" }, idempotency_class: "READ_ONLY", risk_class: "LOW" }],
          limits: { max_ops: 2, timeout_seconds: 30 },
          allowed_ops: ["finish"],
        },
      },
    };
    const r = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
    expect(String(r.routing_decision.selected_executor)).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(String(r.route_decision.selected_route_id)).toBe(PAIR_NATIVE_ROUTE_ID);
  });

  it("5: DSH selected when sole capable executor; real ACP dispatch completes", async () => {
    const ctx = makeCtx("t5", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [
      taskSpec("T1", ["SHELL_EXECUTION"], "REQPERM write agent_out.txt"),
    ]);
    const req = requestFor(ctx, m, 0, {
      instruction: "REQPERM write agent_out.txt",
      requestedTools: ["SHELL_EXECUTION"],
    });
    const r = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
    expect(String(r.routing_decision.selected_executor)).toBe(DSH_EXECUTOR_ID);
    expect(String(r.route_decision.selected_route_id)).toBe(ROUTE_IDS[DSH_EXECUTOR_ID]);
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.dsh!, execId);
    const collected = ctx.gate.collect_execution_result(ctx.dsh!, execId);
    expect(String((collected.result as Record<string, unknown>).status)).toBe("COMPLETED");
    expect(fs.existsSync(path.join(ctx.workspace, "agent_out.txt"))).toBe(true);
    // Permission broker logged an ALLOW decision for the in-scope edit.
    const decisionsLog = path.join(
      acpRunRoot(path.join(ctx.dir, "journal"), execId),
      "permission_decisions.jsonl",
    );
    expect(fs.existsSync(decisionsLog)).toBe(true);
    const decisions = fs.readFileSync(decisionsLog, "utf8").trim().split("\n").map(JSON.parse);
    expect(decisions.some((d) => d.action === "ALLOW" && d.request_class === "WRITE")).toBe(true);
    // Execution journal records negotiated session features + supplemental session id.
    const journal = JSON.parse(
      fs.readFileSync(path.join(acpRunRoot(path.join(ctx.dir, "journal"), execId), "execution_journal.json"), "utf8"),
    );
    expect(journal.acp_session_id).toMatch(/^sess-/);
    expect(journal.resume_mechanism).toBe("resume"); // fixture advertises resume
    expect(journal.post_session_setup.model_route).toEqual(["gemini", "gemini-3.1-flash-lite"]);
  }, 40_000);

  it("6: CODEX selected for PYTHON_EXECUTION; real CLI dispatch completes", async () => {
    const ctx = makeCtx("t6", { dsh: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["PYTHON_EXECUTION"], "codex work")]);
    const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx));
    expect(String(r.routing_decision.selected_executor)).toBe(CODEX_EXECUTOR_ID);
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.codex!, execId);
    const collected = ctx.gate.collect_execution_result(ctx.codex!, execId);
    expect(String((collected.result as Record<string, unknown>).status)).toBe("COMPLETED");
    expect(fs.existsSync(path.join(ctx.workspace, "codex_out.txt"))).toBe(true);
    // Transcript recorded NDJSON event stream.
    const transcript = fs.readFileSync(
      path.join(codexRunRoot(path.join(ctx.dir, "journal"), execId), "stdout.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("thread.started");
  }, 40_000);

  it("7: deterministic selection among multiple eligible executors", async () => {
    const ctx = makeCtx("t7", { priorities: { [DSH_EXECUTOR_ID]: 10, [CODEX_EXECUTOR_ID]: 50 } });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const picks: string[] = [];
    let lastDecisionId = "";
    for (let i = 0; i < 2; i++) {
      const m = seedMission(ctx, [taskSpec(`T1`, ["FILE_OPERATIONS"], `work ${i}`)]);
      const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx));
      picks.push(String(r.routing_decision.selected_executor));
      lastDecisionId = String(r.routing_decision.routing_decision_id);
    }
    // FILE_OPERATIONS eligible: PAIR_NATIVE(100), DSH(10), CODEX(50) → DSH wins both times.
    expect(picks[0]).toBe(picks[1]);
    expect(picks[0]).toBe(DSH_EXECUTOR_ID);
    expect(ctx.router.verifyRoutingDecision(lastDecisionId)).toBe(true);
  });
});

describe("P5 fail-closed eligibility (8–13)", () => {
  function onlyDshCtx(name: string) {
    const ctx = makeCtx(name, { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    return ctx;
  }

  it("8: disabled executor rejected; compatible executor still selected", () => {
    const ctx = onlyDshCtx("t8");
    ctx.service.registerExecutor(
      { ...ctx.service.getExecutor(DSH_EXECUTOR_ID), status: "DISABLED" },
      "test",
    );
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx)),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR|FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(rejected[0].reasons).toContain("EXECUTOR_DISABLED");
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("9: unhealthy executor rejected", () => {
    const ctx = onlyDshCtx("t9");
    ctx.service.registerExecutor(
      { ...ctx.service.getExecutor(DSH_EXECUTOR_ID), health_state: "DEGRADED" },
      "test",
    );
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx)),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE/);
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(String(rejected[0].reasons)).toContain("HEALTH_DEGRADED");
  });

  it("10: unqualified executor rejected (live requalification fails)", () => {
    const ctx = onlyDshCtx("t10");
    // Swap in an adapter that always reports unqualified at dispatch time.
    const unqualified = Object.create(ctx.dsh!, {
      qualify: { value: () => ({ qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNQUALIFIED"] }) },
    }) as ExecutorAdapter;
    const adapters = adaptersOf(ctx);
    adapters.set(DSH_EXECUTOR_ID, unqualified);
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    expect(() => ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adapters)).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE/,
    );
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("11: permission mismatch rejected", () => {
    const ctx = onlyDshCtx("t11");
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    const req = requestFor(ctx, m, 0, { permissions: ["FILE_WRITE", "NETWORK"] });
    // Mission does not grant NETWORK; router-level descriptor also lacks it.
    expect(() => ctx.router.routeGovernedTask(req, adaptersOf(ctx))).toThrowError();
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(String(rejected.map((r) => r.reasons).flat().join(","))).toContain("PERMISSION_INCOMPATIBLE");
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("12: workspace incompatibility rejected", () => {
    const ctx = onlyDshCtx("t12");
    const exec = ctx.service.getExecutor(DSH_EXECUTOR_ID) as Record<string, unknown>;
    ctx.service.registerExecutor(
      { ...exec, metadata: { ...(exec.metadata as object), workspace_modes: ["DIFFERENT_MODE"] } },
      "test",
    );
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx)),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE/);
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(String(rejected[0].reasons)).toContain("WORKSPACE_INCOMPATIBLE");
  });

  it("13: no eligible executor → fail closed, no silent fallback", () => {
    const ctx = onlyDshCtx("t13");
    const m = seedMission(ctx, [taskSpec("T1", ["QUANTUM_COMPUTE"], "x")], ["QUANTUM_COMPUTE"]);
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx)),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });
});

describe("P5 governance invariants (14–17)", () => {
  it("14: forged direct adapter dispatch cannot bypass the gate", () => {
    const ctx = makeCtx("t14", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    // Forged task: never created by gate, never authorized.
    const forged = {
      ...requestFor(ctx, m, 0),
      governed_task_id: "GTSK_FORGED",
      governance_state: "READY",
      dispatch_enabled: false,
      governance_digest: "forged",
      executor_id: DSH_EXECUTOR_ID,
    };
    expect(() => ctx.dsh!.dispatch(forged)).toThrowError(/FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
    // And a task that was never authorized at all:
    const forged2 = { ...forged, governed_task_id: "GTSK_F2", governance_state: "VALIDATED" };
    expect(() => ctx.dsh!.dispatch(forged2)).toThrowError(/FAIL_CLOSED/);
  });

  it("15: policy denial produces no fallback dispatch to another executor", () => {
    const ctx = makeCtx("t15", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    // Workspace outside authorized_workspaces → gate denies, zero dispatch.
    const outside = fs.mkdtempSync(path.join(ctx.dir, "outside-"));
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    const req = { ...requestFor(ctx, m, 0), workspace: outside, allowed_paths: [outside] };
    expect(() => ctx.router.routeGovernedTask(req, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED/,
    );
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
    expect(fs.existsSync(acpRunRoot(path.join(ctx.dir, "journal"), "anything"))).toBe(false);
  });

  it("16: ambiguous dispatch state → no blind re-drive", () => {
    const ctx = makeCtx("t16", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    const gtid = `GTSK_AMBIG`;
    const execId = workerExecutionId(DSH_EXECUTOR_ID, gtid);
    const runRoot = acpRunRoot(path.join(ctx.dir, "journal"), execId);
    fs.mkdirSync(runRoot, { recursive: true });
    // Crash artifact: journal says RUNNING but no result and no live process.
    fs.writeFileSync(
      path.join(runRoot, "execution_journal.json"),
      JSON.stringify({
        schema: "pair.os.vnext.acp-execution-journal.v1",
        execution_id: execId,
        governed_task_id: gtid,
        mission_id: m.missionId,
        task_id: m.taskIds[0],
        correlation_id: "corr",
        status: "RUNNING",
        created_at: new Date().toISOString(),
      }),
    );
    // Rehydrate: ambiguous — must NOT claim success and must NOT re-spawn.
    const fresh = new DshExecutorAdapter({
      journalRoot: path.join(ctx.dir, "journal"),
      launchOverride: { command: "node", args: [FAKE_ACP, "--profile", "acp"] },
      envReader: secretEnv,
    });
    const obs = fresh.observe(execId);
    expect(obs.status).toBe("UNKNOWN");
    // Re-dispatch of same governed task returns recovered record, not a new process.
    const forged = {
      governed_task_id: gtid,
      mission_id: m.missionId,
      task_id: m.taskIds[0],
      workspace: ctx.workspace,
      correlation_id: "corr",
      governance_digest: "x",
      executor_id: DSH_EXECUTOR_ID,
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
    };
    const again = fresh.dispatch(forged);
    expect(again.recovered).toBe(true);
    expect(again.status).toBe("UNKNOWN");
    // collect_result on ambiguous execution does not invent success.
    expect(() => fresh.collect_result(execId)).toThrowError(/FAIL_CLOSED_EXECUTION_NOT_TERMINAL/);
  });

  it("17: idempotent re-dispatch — same task+intent yields one execution", async () => {
    const ctx = makeCtx("t17", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "idem")]);
    const req = requestFor(ctx, m, 0);
    const first = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
    const execId = String(first.execution.execution_id);
    await waitTerminal(ctx.dsh!, execId);
    const second = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
    expect(second.adopted).toBe(true);
    expect(String(second.execution.execution_id)).toBe(execId);
    expect(
      ctx.store.list("executor_execution").filter((e) => e.mission_id === m.missionId),
    ).toHaveLength(1);
    // Only one real side effect: one run_root, one result.
    const root = path.dirname(acpRunRoot(path.join(ctx.dir, "journal"), execId));
    expect(fs.readdirSync(root)).toHaveLength(1);
  }, 40_000);
});

describe("P5 handoff, normalization, evidence (18–22)", () => {
  it("18: T1→PAIR_NATIVE, T2→CODEX, T3→DSH — one mission, canonical IDs preserved", async () => {
    const ctx = makeCtx("t18", { priorities: { [DSH_EXECUTOR_ID]: 10 } });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    fs.writeFileSync(path.join(ctx.workspace, "in.txt"), "seed");
    const m = seedMission(ctx, [
      taskSpec("T1", ["AUTOMATON_TASK_EXECUTION"], "native step"),
      taskSpec("T2", ["PYTHON_EXECUTION"], "codex step", ["T1"]),
      taskSpec("T3", ["SHELL_EXECUTION"], "dsh step", ["T2"]),
    ]);
    // T1 — PAIR_NATIVE via worker spec.
    const req1 = {
      ...requestFor(ctx, m, 0, { instruction: "native step" }),
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [{ op: "finish", result: { summary: "t1-out" }, idempotency_class: "READ_ONLY", risk_class: "LOW" }],
          limits: { max_ops: 2, timeout_seconds: 30 },
          allowed_ops: ["finish"],
        },
      },
    };
    const r1 = ctx.router.routeGovernedTask(req1, adaptersOf(ctx));
    expect(String(r1.routing_decision.selected_executor)).toBe(PAIR_NATIVE_EXECUTOR_ID);
    await waitTerminal(ctx.adapter, String(r1.execution.execution_id));
    const c1 = ctx.gate.collect_execution_result(ctx.adapter, String(r1.execution.execution_id));

    // T2 — CODEX (PYTHON_EXECUTION only on Codex).
    const r2 = ctx.router.routeGovernedTask(
      requestFor(ctx, m, 1, {
        instruction: "codex step",
        dependencyOutputs: [{ from: "T1", summary: (c1.result as Record<string, unknown>).summary }],
      }),
      adaptersOf(ctx),
    );
    expect(String(r2.routing_decision.selected_executor)).toBe(CODEX_EXECUTOR_ID);
    await waitTerminal(ctx.codex!, String(r2.execution.execution_id));
    const c2 = ctx.gate.collect_execution_result(ctx.codex!, String(r2.execution.execution_id));

    // T3 — DSH (priority 10 beats CODEX 50 on SHELL_EXECUTION overlap).
    const r3 = ctx.router.routeGovernedTask(
      requestFor(ctx, m, 2, {
        instruction: "dsh step",
        dependencyOutputs: [{ from: "T2", summary: (c2.result as Record<string, unknown>).summary }],
      }),
      adaptersOf(ctx),
    );
    expect(String(r3.routing_decision.selected_executor)).toBe(DSH_EXECUTOR_ID);
    await waitTerminal(ctx.dsh!, String(r3.execution.execution_id));
    const c3 = ctx.gate.collect_execution_result(ctx.dsh!, String(r3.execution.execution_id));

    // Canonical PAIR execution IDs across all three; distinct executors.
    const ids = [r1, r2, r3].map((r) => String(r.execution.execution_id));
    for (const id of ids) expect(id).toMatch(/^EXE_/);
    const execs = ctx.store
      .list("executor_execution")
      .filter((e) => e.mission_id === m.missionId);
    expect(new Set(execs.map((e) => String(e.executor_id)))).toEqual(
      new Set([PAIR_NATIVE_EXECUTOR_ID, CODEX_EXECUTOR_ID, DSH_EXECUTOR_ID]),
    );
    // Dependency outputs were threaded into the governed prompt (canonical spec).
    const spec3 = JSON.parse(
      fs.readFileSync(
        path.join(acpRunRoot(path.join(ctx.dir, "journal"), ids[2]), "spec.json"),
        "utf8"),
    );
    expect(JSON.stringify(spec3.dependency_outputs)).toContain("T2");
    void c3;
  }, 60_000);

  it("19: result normalization — same canonical shape across all three executors", async () => {
    const ctx = makeCtx("t19", { priorities: { [DSH_EXECUTOR_ID]: 10 } });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    fs.writeFileSync(path.join(ctx.workspace, "f.txt"), "x");
    const collectStatus = async (
      adapter: ExecutorAdapter,
      caps: string[],
      workerSpec?: Record<string, unknown>,
    ) => {
      const m = seedMission(ctx, [taskSpec("T1", caps, "norm")]);
      const req = {
        ...requestFor(ctx, m, 0, { instruction: "norm" }),
        ...(workerSpec ? { expected_output_contract: workerSpec } : {}),
      };
      const r = ctx.router.routeGovernedTask(req, adaptersOf(ctx));
      const execId = String(r.execution.execution_id);
      await waitTerminal(adapter, execId);
      return ctx.gate.collect_execution_result(adapter, execId);
    };
    const rNative = await collectStatus(ctx.adapter, ["AUTOMATON_TASK_EXECUTION"], {
      type: "TASK_RESULT",
      worker_spec: {
        ops: [{ op: "finish", result: { summary: "ok" }, idempotency_class: "READ_ONLY", risk_class: "LOW" }],
        limits: { max_ops: 2, timeout_seconds: 30 },
        allowed_ops: ["finish"],
      },
    });
    const rDsh = await collectStatus(ctx.dsh!, ["SHELL_EXECUTION"]);
    const rCodex = await collectStatus(ctx.codex!, ["PYTHON_EXECUTION"]);
    for (const c of [rNative, rDsh, rCodex]) {
      const res = c.result as Record<string, unknown>;
      expect(res).toBeTruthy();
      for (const f of ["status", "execution_id", "governed_task_id", "mission_id", "task_id", "artifacts"]) {
        expect(res).toHaveProperty(f);
      }
      expect(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]).toContain(String(res.status));
    }
    expect(String((rNative.result as Record<string, unknown>).status)).toBe("COMPLETED");
    expect(String((rDsh.result as Record<string, unknown>).status)).toBe("COMPLETED");
    expect(String((rCodex.result as Record<string, unknown>).status)).toBe("COMPLETED");
  }, 60_000);

  it("20: artifact tamper detected by provenance validation", async () => {
    const ctx = makeCtx("t20", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "work")]);
    const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx));
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.dsh!, execId);
    ctx.gate.collect_execution_result(ctx.dsh!, execId);
    // Pre-tamper validation passes (artifact written by fixture).
    const v1 = new ArtifactProvenanceValidator().validate_execution(ctx.service, execId);
    expect(v1.status).toBe("PASS");
    // Tamper the artifact → re-validation must fail.
    fs.appendFileSync(path.join(ctx.workspace, "agent_out.txt"), "tampered");
    const v2 = new ArtifactProvenanceValidator().validate_execution(ctx.service, execId);
    expect(v2.status).toBe("FAIL");
    expect(String(v2.failures)).toContain("sha256 mismatch");
  }, 40_000);

  it("21: restart preserves routing/execution evidence; rehydrated adapter collects result", async () => {
    const ctx = makeCtx("t21", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "restart")]);
    const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx));
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.dsh!, execId);
    ctx.gate.collect_execution_result(ctx.dsh!, execId);
    // Restart: fresh adapter over the same journal root, same store.
    const fresh = new DshExecutorAdapter({
      journalRoot: path.join(ctx.dir, "journal"),
      launchOverride: { command: "node", args: [FAKE_ACP, "--profile", "acp"] },
      envReader: secretEnv,
    });
    expect(fresh.dispatch_evidence(String(r.governed_task.governed_task_id))).toEqual({
      dispatched: true,
      execution_id: execId,
    });
    const obs = fresh.observe(execId);
    expect(obs.status).toBe("COMPLETED");
    const collected = ctx.gate.collect_execution_result(fresh, execId);
    expect(String((collected.result as Record<string, unknown>).status)).toBe("COMPLETED");
    // Canonical evidence survives restart: routing decision + route decision verify.
    expect(ctx.router.verifyRoutingDecision(String(r.routing_decision.routing_decision_id))).toBe(true);
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  }, 40_000);

  it("22: secrets never appear in probe/qualification/journal/evidence", async () => {
    const ctx = makeCtx("t22", { codex: false });
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "secrets")]);
    const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx));
    const execId = String(r.execution.execution_id);
    await waitTerminal(ctx.dsh!, execId);
    ctx.gate.collect_execution_result(ctx.dsh!, execId);
    // Scan every file under the journal tree + all canonical entities.
    const hay: string[] = [JSON.stringify(ctx.dsh!.probe()), JSON.stringify(ctx.dsh!.qualify())];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else hay.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(path.join(ctx.dir, "journal"));
    for (const t of ["routing_decision", "route_decision", "executor_execution", "governed_task", "executor", "route", "executor_supply_binding"]) {
      for (const e of ctx.store.list(t)) hay.push(JSON.stringify(e));
    }
    for (const ev of ctx.store.list("event")) hay.push(JSON.stringify(ev));
    const blob = hay.join("\n");
    expect(blob).not.toContain(FAKE_SECRET);
    expect(blob).not.toContain("P5_TEST_SECRET_VALUE");
    // env var NAMES may appear (credential_env), values may not.
    expect(blob).toContain("GEMINI_API_KEY");
  }, 40_000);
});
