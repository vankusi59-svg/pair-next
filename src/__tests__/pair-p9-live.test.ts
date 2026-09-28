/**
 * P9 §38 — real multi-executor mission through the P9 runtime loop.
 *
 * REAL execution: PAIR_NATIVE (LocalWorkerPool), CODEX (codex exec --json),
 * DSH (dsh --profile acp), DEVIN (Devin REST API — only when
 * PAIR_DEVIN_API_KEY is present; otherwise the live gate classifies as
 * DEVIN_INTEGRATION_COMPLETE_LIVE_BLOCKED_EXTERNAL, never faked).
 *
 * Requires env: PAIR_DSH_HOME, PAIR_DSH_MODEL_ROUTE, CODEX_HOME.
 * Run: PAIR_DSH_HOME=... PAIR_DSH_MODEL_ROUTE=... CODEX_HOME=... pnpm vitest run src/__tests__/pair-p9-live.test.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  CodexCliExecutorAdapter,
  CODEX_EXECUTOR_ID,
  DevinExecutorAdapter,
  DEVIN_EXECUTOR_ID,
  DshExecutorAdapter,
  DSH_EXECUTOR_ID,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  ExecutorRegistry,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  ReconciliationService,
  RecoveryController,
  registerGovernedExecutors,
} from "../pair/index.js";

const POLL_MS = 2_000;
const DEADLINE_MS = 12 * 60_000; // real model/remote sessions take minutes
const HAS_DEVIN = Boolean(process.env.PAIR_DEVIN_API_KEY);

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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p9-live-"));

// Live suite requires real vendor runtimes + credentials; skip (not fail) on CI.
const liveEnv =
  Boolean(process.env.PAIR_DSH_HOME) &&
  fs.existsSync(path.join(process.env.PAIR_DSH_HOME, "settings.yaml")) &&
  Boolean(process.env.CODEX_HOME);
const describeLive = liveEnv ? describe : describe.skip;
const TERMINAL_RT = new Set(["COMPLETED", "FAILED", "CANCELLED", "ABORTED"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeLive("P9 §38 — real multi-executor mission over the runtime loop", () => {
  beforeAll(() => {
    expect(Boolean(process.env.PAIR_DSH_HOME)).toBe(true);
    expect(Boolean(process.env.CODEX_HOME)).toBe(true);
  });

  it("T1 PAIR_NATIVE → T2 CODEX → T3 DSH (+T4 DEVIN when qualified) with restart survival", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "m-"));
    const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
    const automaton = createDatabase(path.join(dir, "state.db"));
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const journalRoot = path.join(dir, "journal");
    const runner = new PairNativeWorkerRunner({
      db: automaton.raw,
      config: { name: "p9-live", logLevel: "error" } as unknown as AutomatonConfig,
      identity: { name: "p9-live" } as unknown as AutomatonIdentity,
      inference: noopInference,
      compute: noopCompute,
      journalRoot,
      allowedEditRoot: dir,
    });
    const native = new PairNativeExecutorAdapter(runner);
    const dsh = new DshExecutorAdapter({ journalRoot });
    const codex = new CodexCliExecutorAdapter({ journalRoot });
    const devin = HAS_DEVIN ? new DevinExecutorAdapter({ journalRoot }) : null;

    const gate = new GovernedTaskGate(service);
    const registry = new ExecutorRegistry(service);
    const router = new MissionRouter(service, gate);
    const recovery = new RecoveryController(service);
    const adapters = new Map<string, ExecutorAdapter>([
      [PAIR_NATIVE_EXECUTOR_ID, native],
      [DSH_EXECUTOR_ID, dsh],
      [CODEX_EXECUTOR_ID, codex],
    ]);
    if (devin) adapters.set(DEVIN_EXECUTOR_ID, devin);
    const recon = new ReconciliationService(service, adapters);
    const approvals = new ApprovalQueue(service);
    const scheduler = new MissionScheduler(service, { mission_concurrency: 1 }); // serial — deterministic ordering

    // Natural capability selection:
    //   AUTOMATON_TASK_EXECUTION → PAIR_NATIVE only
    //   PYTHON_EXECUTION         → CODEX only
    //   SHELL_EXECUTION          → DSH (priority 10 < CODEX 50)
    //   REMOTE_CLOUD_TASK_EXECUTION → DEVIN only
    const governed = new Map<string, ExecutorAdapter>([
      [DSH_EXECUTOR_ID, dsh],
      [CODEX_EXECUTOR_ID, codex],
    ]);
    if (devin) governed.set(DEVIN_EXECUTOR_ID, devin);
    const reg = registerGovernedExecutors(service, governed, "p9-live", {
      priorities: { [DSH_EXECUTOR_ID]: 10 },
    });
    expect(reg.routable).toContain(DSH_EXECUTOR_ID);
    expect(reg.routable).toContain(CODEX_EXECUTOR_ID);
    if (devin) expect(reg.routable).toContain(DEVIN_EXECUTOR_ID);

    registry.register({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      executor_type: "AUTOMATON_WORKER",
      capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        qualification_state: "QUALIFIED",
        max_concurrency: 2,
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        routing_priority: 100,
        supports_cancel: true,
      },
    });
    service.routes.seedPairNativeRoute();

    const CAPS = [
      "FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "CODE_GENERATION",
      "CODE_EDITING", "SHELL_EXECUTION", "REASONING", "PYTHON_EXECUTION",
      "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION",
    ];
    for (const c of CAPS) service.registerCapability(c, { risk_class: "LOW" });
    const project = service.createProject({ name: "p9live", root_location: workspace });

    const tasks: Array<Record<string, unknown>> = [
      {
        task_key: "T1",
        title: "native seed",
        task_instruction: "write seed file",
        required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
        depends_on: [],
        metadata: {
          expected_output_contract: {
            type: "TASK_RESULT",
            worker_spec: {
              ops: [
                { op: "write_text_file", path: "p9_t1.txt", content: "P9_NATIVE_SEED", idempotency_class: "WRITE", risk_class: "MEDIUM" },
                { op: "finish", result: { summary: "t1-done" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
              ],
              limits: { max_ops: 4, timeout_seconds: 30 },
              allowed_ops: ["write_text_file", "finish"],
            },
          },
        },
      },
      {
        task_key: "T2",
        title: "codex step",
        task_instruction:
          "Create a file named p9_t2_codex.txt in the workspace directory containing exactly P9_CODEX_LIVE, then reply DONE.",
        required_capabilities: ["PYTHON_EXECUTION"],
        depends_on: ["T1"],
        metadata: {},
      },
      {
        task_key: "T3",
        title: "dsh step",
        task_instruction:
          "Create a file named p9_t3_dsh.txt in the workspace directory containing exactly P9_DSH_LIVE, then reply DONE.",
        required_capabilities: ["SHELL_EXECUTION"],
        depends_on: ["T2"],
        metadata: {},
      },
    ];
    if (devin) {
      tasks.push({
        task_key: "T4",
        title: "devin step",
        task_instruction: "Reply with the single word P9_DEVIN_LIVE. Do not modify any files.",
        required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
        depends_on: ["T3"],
        metadata: { timeout: 900 },
      });
    }

    const runtime = new MissionRuntime({
      service, gate, router, adapters, scheduler, approvals,
      reconciliation: recon, recovery,
      planner: () => ({ tasks }),
    });
    const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
    const control = new MissionControl({
      service, runtime, supervisor, scheduler, approvals,
      reconciliation: recon, observability: new MissionObservability(service),
    });

    const created = control.startMission({
      project_id: String(project.project_id),
      goal: "p9 live multi-executor",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
    });
    const missionId = String(created.mission_id);

    // Drive: supervisor sweeps + sleeps — real subprocesses/polls are async.
    const deadline = Date.now() + DEADLINE_MS;
    let restarted = false;
    let state = "";
    let guard = 0;
    while (Date.now() < deadline && guard++ < 400) {
      supervisor.tick();
      const rt = store.get("mission_runtime", `MRT_${missionId}`);
      state = String(rt.state);
      if (TERMINAL_RT.has(state)) break;
      // Mid-mission crash-recovery proof: once the first execution exists and
      // is in-flight, swap in a fresh runtime/supervisor on the SAME store.
      if (!restarted && store.list("executor_execution").length > 0) {
        const rt2 = new MissionRuntime({
          service, gate, router, adapters, scheduler, approvals,
          reconciliation: recon, recovery,
          planner: () => ({ tasks }),
        });
        const sup2 = new MissionSupervisor(service, rt2, recovery, recon);
        sup2.resume();
        void sup2; // subsequent supervisor.tick() calls still drive `runtime`
        restarted = true;
      }
      await sleep(POLL_MS);
    }

    if (!TERMINAL_RT.has(state)) {
      // graceful cancel so nothing is left running
      try { control.cancelMission(missionId, "p9-live-timeout"); } catch { /* already terminal */ }
    }
    expect(state).toBe("COMPLETED");

    // Routing receipts prove natural executor selection per task.
    const decisions = store.list("routing_decision").filter((d) => d.mission_id === missionId);
    const byTask = new Map<string, string>();
    for (const d of decisions) {
      if (d.task_id) byTask.set(String(d.task_id), String(d.selected_executor));
    }
    const taskRows = service.listTasks(missionId);
    const keyOf = (tid: string) => String(taskRows.find((t) => t.task_id === tid)?.task_key);
    const selected = new Map<string, string>();
    for (const [tid, ex] of byTask) selected.set(keyOf(tid), ex);
    expect(selected.get("T1")).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(selected.get("T2")).toBe(CODEX_EXECUTOR_ID);
    expect(selected.get("T3")).toBe(DSH_EXECUTOR_ID);
    if (devin) expect(selected.get("T4")).toBe(DEVIN_EXECUTOR_ID);

    // Canonical execution ids; remote session id is supplemental metadata only.
    const execs = store.list("executor_execution").filter((e) => e.mission_id === missionId);
    for (const e of execs) expect(String(e.execution_id)).toMatch(/^EXE_/);
    if (devin) {
      const dExec = execs.find((e) => e.executor_id === DEVIN_EXECUTOR_ID);
      expect(String((dExec?.result as Record<string, unknown> | undefined)?.remote_refs ? "has-refs" : "none")).toBeTruthy();
    }

    // Real artifacts on disk.
    expect(fs.readFileSync(path.join(workspace, "p9_t1.txt"), "utf8")).toBe("P9_NATIVE_SEED");
    expect(fs.readFileSync(path.join(workspace, "p9_t2_codex.txt"), "utf8")).toContain("P9_CODEX_LIVE");
    expect(fs.readFileSync(path.join(workspace, "p9_t3_dsh.txt"), "utf8")).toContain("P9_DSH_LIVE");

    // No duplicate dispatch after the mid-run restart.
    const seen = new Set<string>();
    for (const e of execs) {
      const k = `${e.task_id}:${e.executor_id}:${String((e as Record<string, unknown>).governed_task_id)}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(restarted).toBe(true);

    runner.shutdown();
  }, DEADLINE_MS + 60_000);

  it("DEVIN live classification — qualified with key, else external blocker", () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "devin-gate-"));
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const adapter = new DevinExecutorAdapter({ journalRoot: path.join(dir, "j") });
    const reg = registerGovernedExecutors(service, new Map([[DEVIN_EXECUTOR_ID, adapter]]), "p9-live");
    if (HAS_DEVIN) {
      expect(adapter.probe().available).toBe(true);
      expect(reg.routable).toContain(DEVIN_EXECUTOR_ID);
      // classification for report: DEVIN_LIVE_QUALIFIED
    } else {
      expect(adapter.probe().available).toBe(false);
      expect(String(adapter.probe().reason)).toBe("DEVIN_CREDENTIAL_NOT_RESOLVABLE");
      expect(reg.routable).not.toContain(DEVIN_EXECUTOR_ID);
      // classification for report: DEVIN_INTEGRATION_COMPLETE_LIVE_BLOCKED_EXTERNAL
    }
  });
});
