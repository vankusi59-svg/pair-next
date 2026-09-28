/**
 * P5.1 REAL EXECUTOR LIVE QUALIFICATION — real vendor binaries only:
 *   DSH:   `dsh --profile acp` (model route via PAIR_DSH_MODEL_ROUTE, credential via provider env)
 *   CODEX: `codex exec --json` (ChatGPT auth via CODEX_HOME/auth.json)
 * No fixture executors, no mocks. Fails loudly if the environment is absent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  acpRunRoot,
  ArtifactProvenanceValidator,
  CodexCliExecutorAdapter,
  codexRunRoot,
  CODEX_EXECUTOR_ID,
  DshExecutorAdapter,
  DSH_EXECUTOR_ID,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  registerGovernedExecutors,
  ROUTE_IDS,
  validatePlanProposal,
} from "../pair/index.js";

const LIVE_TIMEOUT = 240_000;

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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p51-live-"));
let counter = 0;

// Live suite requires real vendor runtimes + credentials; skip (not fail) on CI.
const liveRoute = process.env.PAIR_DSH_MODEL_ROUTE ?? "gemini:gemini-3.1-flash-lite";
const liveCredEnv = `${liveRoute.split(":")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
const liveEnv =
  Boolean(process.env.PAIR_DSH_HOME) &&
  fs.existsSync(path.join(process.env.PAIR_DSH_HOME, "settings.yaml")) &&
  Boolean(process.env[liveCredEnv]) &&
  Boolean(process.env.CODEX_HOME);
const describeLive = liveEnv ? describe : describe.skip;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

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
  reg: ReturnType<typeof registerGovernedExecutors>;
}

function makeLiveCtx(
  name: string,
  opts: { dsh?: boolean; codex?: boolean; priorities?: Record<string, number>; corruptDsh?: boolean; corruptCodex?: boolean } = {},
): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const automaton = createDatabase(path.join(dir, "state.db"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const journalRoot = path.join(dir, "journal");
  const runner = new PairNativeWorkerRunner({
    db: automaton.raw,
    config: { name: "p51-live", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p51-live" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot,
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const dsh =
    opts.dsh === false
      ? null
      : new DshExecutorAdapter({
          journalRoot,
          ...(opts.corruptDsh
            ? { launchOverride: { command: "/nonexistent/dsh", args: ["--profile", "acp"] } }
            : {}),
        });
  const codex =
    opts.codex === false
      ? null
      : new CodexCliExecutorAdapter({
          journalRoot,
          ...(opts.corruptCodex ? { executable: "/nonexistent/codex" } : {}),
        });
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const adapters = new Map<string, ExecutorAdapter>();
  if (dsh) adapters.set(DSH_EXECUTOR_ID, dsh);
  if (codex) adapters.set(CODEX_EXECUTOR_ID, codex);
  const reg = registerGovernedExecutors(service, adapters, "p51-live", { priorities: opts.priorities });
  return { db: automaton.raw, capsRegistered: new Set(), store, service, runner, adapter, dsh, codex, gate, registry, router, workspace, dir, reg };
}

function registerPairNative(ctx: Ctx) {
  ctx.registry.register({
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
    },
  });
  ctx.service.routes.seedPairNativeRoute();
}

function adaptersOf(ctx: Ctx): Map<string, ExecutorAdapter> {
  const m = new Map<string, ExecutorAdapter>([[PAIR_NATIVE_EXECUTOR_ID, ctx.adapter]]);
  if (ctx.dsh) m.set(DSH_EXECUTOR_ID, ctx.dsh);
  if (ctx.codex) m.set(CODEX_EXECUTOR_ID, ctx.codex);
  return m;
}

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

function seedMission(ctx: Ctx, taskSpecs: Array<Record<string, unknown>>) {
  const project = ctx.service.createProject({ name: "p51", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p51 live multi-executor",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  ctx.service.transitionMission(String(mission.mission_id), "RUNNING");
  const allCaps = [
    "FILE_OPERATIONS",
    "AUTOMATON_TASK_EXECUTION",
    "CODE_GENERATION",
    "CODE_EDITING",
    "SHELL_EXECUTION",
    "REASONING",
    "PYTHON_EXECUTION",
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
  m: { missionId: string; taskIds: string[]; revision: number },
  idx: number,
  opts: { instruction?: string; permissions?: string[]; requestedTools?: string[]; dependencyOutputs?: unknown[]; workerSpec?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    mission_id: m.missionId,
    task_id: m.taskIds[idx],
    plan_revision: m.revision,
    task_instruction: opts.instruction ?? "do governed work",
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: opts.permissions ?? ["FILE_WRITE"],
    requested_tools: opts.requestedTools ?? ["SHELL_EXECUTION", "FILE_OPERATIONS"],
    constraints: [],
    timeout: Number(opts.timeout ?? 900),
    correlation_id: `corr-p51-${idx}-${Date.now()}`,
    dependency_outputs: opts.dependencyOutputs ?? [],
    expected_output_contract: opts.workerSpec
      ? { type: "TASK_RESULT", worker_spec: opts.workerSpec }
      : { type: "TASK_RESULT" },
  };
}

async function waitTerminal(adapter: ExecutorAdapter, executionId: string, timeoutMs = 200_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) {
      return o;
    }
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never reached terminal (last=${o.status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface GovRun {
  route: Record<string, unknown>;
  obs: Record<string, unknown>;
  result: Record<string, unknown>;
  validation: { status: string };
  executionId: string;
  governedTaskId: string;
  executorId: string;
}

async function runGoverned(
  ctx: Ctx,
  req: Record<string, unknown>,
): Promise<GovRun> {
  const route = ctx.router.routeGovernedTask(req, adaptersOf(ctx)) as Record<string, unknown>;
  const executorId = String((route.routing_decision as Record<string, unknown>).selected_executor);
  const execution = route.execution as Record<string, unknown>;
  const executionId = String(execution.execution_id);
  const governedTaskId = String(execution.governed_task_id);
  const adapter = adaptersOf(ctx).get(executorId)!;
  const obs = await waitTerminal(adapter, executionId);
  const collected = ctx.gate.collect_execution_result(adapter, executionId) as Record<string, unknown>;
  const validation = new ArtifactProvenanceValidator().validate_execution(ctx.service, executionId) as { status: string };
  return {
    route,
    obs: obs as Record<string, unknown>,
    result: collected.result as Record<string, unknown>,
    validation,
    executionId,
    governedTaskId,
    executorId,
  };
}

function evidenceWalk(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describeLive("P5.1 live qualification — real vendor runtimes", () => {
  beforeAll(() => {
    expect(process.env.PATH ?? "").toContain(".local/bin");
    expect(Boolean(process.env[liveCredEnv])).toBe(true);
    expect(Boolean(process.env.CODEX_HOME)).toBe(true);
    expect(process.env.PAIR_DSH_HOME).toBe("/home/ubuntu/.pair-dsh-home");
  });

  it("L1: DEEPSEEK_HARNESS probe+qualify+auth+capabilities+route/binding QUALIFIED+routable", () => {
    const ctx = makeLiveCtx("l1", { codex: false });
    const probe = ctx.dsh!.probe() as Record<string, unknown>;
    expect(probe.available).toBe(true);
    expect(probe.state).toBe("READY");
    expect(probe.authenticated).toBe(true); // GROQ_API_KEY resolvable via provider env
    expect(probe.runtime_type).toBe("DEEPSEEK_HARNESS_ACP");
    const q = ctx.dsh!.qualify() as Record<string, unknown>;
    expect(q.qualified).toBe(true);
    expect(ctx.reg.routable).toContain(DSH_EXECUTOR_ID);
    const desc = ctx.service.getExecutor(DSH_EXECUTOR_ID) as Record<string, unknown>;
    expect(String((desc.metadata as Record<string, unknown>)?.qualification_state)).toBe("QUALIFIED");
    expect((desc.capabilities as string[]).length).toBeGreaterThan(0);
    expect(ctx.service.routes.getRoute(ROUTE_IDS[DSH_EXECUTOR_ID])).toBeTruthy();
    expect(ctx.service.routes.bindingFor(DSH_EXECUTOR_ID, ROUTE_IDS[DSH_EXECUTOR_ID])).toBeTruthy();
    expect(String((ctx.dsh!.health() as Record<string, unknown>).state)).toBe('READY');
  });

  it("L2: CODEX probe+qualify+auth+capabilities+route/binding QUALIFIED+routable", () => {
    const ctx = makeLiveCtx("l2", { dsh: false });
    const probe = ctx.codex!.probe() as Record<string, unknown>;
    expect(probe.available).toBe(true);
    expect(probe.authenticated).toBe(true); // CODEX_HOME/auth.json present
    const q = ctx.codex!.qualify() as Record<string, unknown>;
    expect(q.qualified).toBe(true);
    expect(ctx.reg.routable).toContain(CODEX_EXECUTOR_ID);
    const desc = ctx.service.getExecutor(CODEX_EXECUTOR_ID) as Record<string, unknown>;
    expect(String((desc.metadata as Record<string, unknown>)?.qualification_state)).toBe("QUALIFIED");
    expect((desc.capabilities as string[]).includes("PYTHON_EXECUTION")).toBe(true);
    expect(ctx.service.routes.getRoute(ROUTE_IDS[CODEX_EXECUTOR_ID])).toBeTruthy();
  });

  it("L3: PAIR_NATIVE remains routable", () => {
    const ctx = makeLiveCtx("l3", { dsh: false, codex: false });
    registerPairNative(ctx);
    const desc = ctx.service.getExecutor(PAIR_NATIVE_EXECUTOR_ID) as Record<string, unknown>;
    expect(String((desc.metadata as Record<string, unknown>)?.qualification_state)).toBe("QUALIFIED");
    expect(String((ctx.adapter.health() as Record<string, unknown>).state)).toBe('READY');
  });

  it("L4: real governed task through full chain → DEEPSEEK_HARNESS", async () => {
    const ctx = makeLiveCtx("l4", { codex: false, priorities: { [DSH_EXECUTOR_ID]: 10 } });
    registerPairNative(ctx);
    const m = seedMission(ctx, [
      taskSpec("T1", ["SHELL_EXECUTION"], "Create a file named dsh_live_1.txt in the workspace containing exactly DSH_GOVERNED_WRITE, then reply DONE."),
    ]);
    const out = await runGoverned(ctx, requestFor(ctx, m, 0, { instruction: "Create a file named dsh_live_1.txt in the workspace containing exactly DSH_GOVERNED_WRITE, then reply DONE." }));
    expect(out.executorId).toBe(DSH_EXECUTOR_ID);
    expect(String(out.obs.status)).toBe("COMPLETED");
    const runRoot = acpRunRoot(path.join(ctx.dir, "journal"), out.executionId);
    expect(fs.readdirSync(runRoot)).toContain("result.json");
    expect(fs.existsSync(path.join(ctx.workspace, "dsh_live_1.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(ctx.workspace, "dsh_live_1.txt"), "utf8")).toContain("DSH_GOVERNED_WRITE");
    expect(out.validation.status).toBe("PASS");
    expect(String(out.result.status)).toBe("COMPLETED");
  }, LIVE_TIMEOUT);

  it("L5: real governed task through full chain → CODEX", async () => {
    const ctx = makeLiveCtx("l5", { dsh: false });
    registerPairNative(ctx);
    const m = seedMission(ctx, [
      taskSpec("T1", ["PYTHON_EXECUTION"], "Create a file named codex_live_1.txt in the workspace containing exactly CODEX_GOVERNED_WRITE, then reply DONE."),
    ]);
    const out = await runGoverned(ctx, requestFor(ctx, m, 0, { instruction: "Create a file named codex_live_1.txt in the workspace containing exactly CODEX_GOVERNED_WRITE, then reply DONE.", requestedTools: ["SHELL_EXECUTION", "FILE_OPERATIONS", "PYTHON_EXECUTION"] }));
    expect(out.executorId).toBe(CODEX_EXECUTOR_ID);
    expect(String(out.obs.status)).toBe("COMPLETED");
    const runRoot = codexRunRoot(path.join(ctx.dir, "journal"), out.executionId);
    expect(fs.readdirSync(runRoot)).toContain("result.json");
    expect(fs.existsSync(path.join(ctx.workspace, "codex_live_1.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(ctx.workspace, "codex_live_1.txt"), "utf8")).toContain("CODEX_GOVERNED_WRITE");
    expect(out.validation.status).toBe("PASS");
  }, LIVE_TIMEOUT);

  it("L6: real governed task → PAIR_NATIVE (baseline regression)", async () => {
    const ctx = makeLiveCtx("l6", { dsh: false, codex: false });
    registerPairNative(ctx);
    const m = seedMission(ctx, [
      taskSpec("T1", ["AUTOMATON_TASK_EXECUTION"], "native governed work"),
    ]);
    const out = await runGoverned(ctx, requestFor(ctx, m, 0, {
      instruction: "write native_live_1.txt with NATIVE_LIVE then finish",
      workerSpec: {
        ops: [
          { op: "write_text_file", path: "native_live_1.txt", content: "NATIVE_LIVE", idempotency_class: "WRITE", risk_class: "MEDIUM" },
          { op: "finish", result: { summary: "native done" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
        ],
        limits: { max_ops: 4, timeout_seconds: 30 },
        allowed_ops: ["write_text_file", "finish"],
      },
    }));
    expect(out.executorId).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(String(out.obs.status)).toBe("COMPLETED");
    expect(out.validation.status).toBe("PASS");
  }, LIVE_TIMEOUT);

  it("L7: one real mission exercises PAIR_NATIVE→CODEX→DSH via capability routing", async () => {
    const ctx = makeLiveCtx("l7", { priorities: { [DSH_EXECUTOR_ID]: 10 } });
    registerPairNative(ctx);
    const m = seedMission(ctx, [
      taskSpec("T1", ["AUTOMATON_TASK_EXECUTION"], "write handoff_t1.txt with content H1"),
      taskSpec("T2", ["PYTHON_EXECUTION"], "Create a file named handoff_t2.txt containing H2_DONE then reply DONE.", ["T1"]),
      taskSpec("T3", ["CODE_GENERATION", "SHELL_EXECUTION"], "Create a file named handoff_t3.txt containing H3_DONE then reply DONE.", ["T2"]),
    ]);
    const r1 = await runGoverned(ctx, requestFor(ctx, m, 0, {
      instruction: "write handoff_t1.txt with content H1 then finish",
      workerSpec: {
        ops: [
          { op: "write_text_file", path: "handoff_t1.txt", content: "H1", idempotency_class: "WRITE", risk_class: "MEDIUM" },
          { op: "finish", result: { summary: "t1-out" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
        ],
        limits: { max_ops: 4, timeout_seconds: 30 },
        allowed_ops: ["write_text_file", "finish"],
      },
    }));
    expect(r1.executorId).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(String(r1.obs.status)).toBe("COMPLETED");
    const r2 = await runGoverned(ctx, requestFor(ctx, m, 1, {
      instruction: "Create a file named handoff_t2.txt in the workspace containing exactly H2_DONE, then reply DONE.",
      requestedTools: ["SHELL_EXECUTION", "FILE_OPERATIONS", "PYTHON_EXECUTION"],
      dependencyOutputs: [{ from: "T1", summary: r1.result.summary }],
    }));
    expect(r2.executorId).toBe(CODEX_EXECUTOR_ID);
    expect(String(r2.obs.status)).toBe("COMPLETED");
    const r3 = await runGoverned(ctx, requestFor(ctx, m, 2, {
      instruction: "Create a file named handoff_t3.txt in the workspace containing exactly H3_DONE, then reply DONE.",
      dependencyOutputs: [{ from: "T2", summary: r2.result.summary }],
    }));
    expect(r3.executorId).toBe(DSH_EXECUTOR_ID);
    expect(String(r3.obs.status)).toBe("COMPLETED");
    for (const r of [r1, r2, r3]) {
      expect(r.executionId).toMatch(/^EXE_/);
      expect(r.validation.status).toBe("PASS");
    }
    const spec3 = JSON.parse(
      fs.readFileSync(path.join(acpRunRoot(path.join(ctx.dir, "journal"), r3.executionId), "spec.json"), "utf8"),
    );
    expect(JSON.stringify(spec3.dependency_outputs)).toContain("T2");
    const spec2 = JSON.parse(
      fs.readFileSync(path.join(codexRunRoot(path.join(ctx.dir, "journal"), r2.executionId), "spec.json"), "utf8"),
    );
    expect(JSON.stringify(spec2.dependency_outputs)).toContain("T1");
    const execs = ctx.store.list("executor_execution").filter((e) => e.mission_id === m.missionId);
    expect(new Set(execs.map((e) => String(e.executor_id)))).toEqual(
      new Set([PAIR_NATIVE_EXECUTOR_ID, CODEX_EXECUTOR_ID, DSH_EXECUTOR_ID]),
    );
    ctx.service.transitionMission(m.missionId, "COMPLETED");
    expect(String(ctx.service.getMission(m.missionId).status)).toBe("COMPLETED");
  }, LIVE_TIMEOUT * 3);

  it("L8: DSH unavailable pre-dispatch → rejected, fail closed for DSH-only work", () => {
    const ctx = makeLiveCtx("l8", { corruptDsh: true, codex: false });
    registerPairNative(ctx);
    expect((ctx.reg.unavailable as Array<{executor_id:string}>).map(u=>u.executor_id)).toContain(DSH_EXECUTOR_ID);
    const desc = ctx.service.getExecutor(DSH_EXECUTOR_ID) as Record<string, unknown>;
    expect((desc.capabilities as string[]).length).toBe(0);
    const m = seedMission(ctx, [taskSpec("T1", ["CODE_EDITING"], "x")]);
    expect(() => ctx.router.routeGovernedTask(requestFor(ctx, m, 0), adaptersOf(ctx))).toThrowError(/FAIL_CLOSED/);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("L9: CODEX unavailable pre-dispatch → rejected", () => {
    const ctx = makeLiveCtx("l9", { corruptCodex: true, dsh: false });
    registerPairNative(ctx);
    expect((ctx.reg.unavailable as Array<{executor_id:string}>).map(u=>u.executor_id)).toContain(CODEX_EXECUTOR_ID);
    const m = seedMission(ctx, [taskSpec("T1", ["PYTHON_EXECUTION"], "x")]);
    expect(() => ctx.router.routeGovernedTask(requestFor(ctx, m, 0, { requestedTools: ["PYTHON_EXECUTION"] }), adaptersOf(ctx))).toThrowError(/FAIL_CLOSED/);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("L10: policy denial → no fallback dispatch", () => {
    const ctx = makeLiveCtx("l10");
    registerPairNative(ctx);
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "x")]);
    expect(() =>
      ctx.router.routeGovernedTask(
        requestFor(ctx, m, 0, { permissions: ["ESCALATION"] }),
        adaptersOf(ctx),
      ),
    ).toThrowError(/FAIL_CLOSED/);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("L11: restart rehydrates real execution evidence — no duplicate side effects", async () => {
    const ctx = makeLiveCtx("l11", { codex: false, priorities: { [DSH_EXECUTOR_ID]: 10 } });
    registerPairNative(ctx);
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "Create restart_probe.txt with content RESTART_OK then reply DONE.")]);
    const out = await runGoverned(ctx, requestFor(ctx, m, 0, { instruction: "Create restart_probe.txt in the workspace with content RESTART_OK then reply DONE." }));
    expect(String(out.obs.status)).toBe("COMPLETED");
    const dsh2 = new DshExecutorAdapter({ journalRoot: path.join(ctx.dir, "journal") });
    const ev = dsh2.dispatch_evidence(out.governedTaskId) as Record<string, unknown>;
    expect(ev.dispatched).toBe(true);
    expect(ev.execution_id).toBe(out.executionId);
    const obs2 = dsh2.observe(out.executionId);
    expect(String(obs2.status)).toBe("COMPLETED");
    const res2 = dsh2.collect_result(out.executionId) as Record<string, unknown>;
    expect(res2.execution_id).toBe(out.executionId);
    // Re-dispatch the same governed task via a fresh adapter → adopt, never duplicate.
    const re = dsh2.dispatch(
      (ctx.service as unknown as { store: PairEvidenceStore }).store.get("governed_task", out.governedTaskId),
    ) as Record<string, unknown>;
    expect(re.execution_id).toBe(out.executionId);
  }, LIVE_TIMEOUT);

  it("L12: no secret values anywhere in journals/specs/results/db projections", async () => {
    const ctx = makeLiveCtx("l12", { codex: false, priorities: { [DSH_EXECUTOR_ID]: 10 } });
    registerPairNative(ctx);
    const m = seedMission(ctx, [taskSpec("T1", ["SHELL_EXECUTION"], "reply DONE")]);
    const out = await runGoverned(ctx, requestFor(ctx, m, 0, { instruction: "Write a file secret_probe.txt containing SAFE then reply DONE." }));
    expect(String(out.obs.status)).toBe("COMPLETED");
    const secrets = [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter(Boolean) as string[];
    const files = evidenceWalk(path.join(ctx.dir, "journal"));
    let scanned = 0;
    for (const f of files) {
      let content = "";
      try {
        content = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const s of secrets) {
        expect(content.includes(s), `secret leaked into ${f}`).toBe(false);
      }
      scanned++;
    }
    expect(scanned).toBeGreaterThan(0);
    for (const et of ["executor_execution", "governed_task", "routing_decision", "route_decision", "artifact", "event"]) {
      for (const e of ctx.store.list(et)) {
        const blob = JSON.stringify(e);
        for (const s of secrets) expect(blob.includes(s), `secret in ${et}`).toBe(false);
      }
    }
  }, LIVE_TIMEOUT);
});
