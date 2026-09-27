/**
 * P2 control-plane seam tests: PAIR_NATIVE executor + PAIR_WORKER_FILE bridge
 * + GovernedTaskGate + governed evidence store, over the real
 * LocalWorkerPool + spec-bound harness.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { getTaskById } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import {
  AUTOMATON_HARNESS_DENIED_OPS,
  AUTOMATON_HARNESS_WORKER_KIND,
  GovernedTaskGate,
  IntegrityError,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  PolicyError,
  readExecutionJournal,
  readWorkerJournal,
  readWorkerResult,
  SpecBoundHarness,
  validatePlanProposal,
  validateWorkerSpec,
  workerExecutionId,
  workerFilePaths,
  WORKER_SPEC_SCHEMA,
} from "../pair/index.js";
import type { WorkerSpec } from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p2-"));

let tmpCounter = 0;
function freshDir(name: string): string {
  const p = path.join(ROOT, `${tmpCounter++}-${name}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

interface Harness {
  db: ReturnType<typeof createDatabase>["raw"];
  store: PairEvidenceStore;
  service: PairControlPlane;
  runner: PairNativeWorkerRunner;
  adapter: PairNativeExecutorAdapter;
  gate: GovernedTaskGate;
  workspace: string;
}

const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("spec-bound harness must not call inference");
  },
};

const noopCompute = {
  exec: async () => {
    throw new Error("no remote compute in P2 harness tests");
  },
  writeFile: async () => {
    throw new Error("no remote compute");
  },
  readFile: async () => {
    throw new Error("no remote compute");
  },
} as unknown as ComputeClient;

function makeHarness(name: string): Harness {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const automaton = createDatabase(path.join(dir, "state.db"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const runner = new PairNativeWorkerRunner({
    db: automaton.raw,
    config: { name: "p2-test", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p2-test" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot: path.join(dir, "journal"),
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const gate = new GovernedTaskGate(service);
  return { db: automaton.raw, store, service, runner, adapter, gate, workspace };
}

/** Standard governed fixture: read fixture.txt, write out/result.txt, finish. */
function writeFixture(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "fixture.txt"), "fixture-content", "utf8");
}

function workerSpec(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    ops: [
      {
        op: "read_text_file",
        path: "fixture.txt",
        idempotency_class: "READ_ONLY",
        risk_class: "LOW",
      },
      {
        op: "write_text_file",
        path: "out/result.txt",
        content: "governed-output",
        idempotency_class: "WRITE",
        risk_class: "MEDIUM",
      },
      { op: "finish", result: { summary: "done" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
    ],
    limits: { max_ops: 8, timeout_seconds: 30 },
    allowed_ops: ["read_text_file", "write_text_file", "finish", "sleep_ms"],
    ...overrides,
  };
}

interface E2ECtx extends Harness {
  missionId: string;
  taskId: string;
  request: Record<string, unknown>;
}

async function seedGovernedTask(
  h: Harness,
  opts: { risk?: string; approve?: boolean } = {},
): Promise<E2ECtx> {
  const project = h.service.createProject({ name: "p2", root_location: h.workspace });
  const mission = h.service.createMission({
    project_id: String(project.project_id),
    goal: "p2 vertical slice",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [h.workspace],
  });
  h.service.transitionMission(String(mission.mission_id), "READY");
  h.service.registerCapability("FILE_OPERATIONS", { risk_class: opts.risk ?? "MEDIUM" });
  h.service.registerCapability("AUTOMATON_TASK_EXECUTION", { risk_class: "LOW" });
  h.service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 3 });

  const proposal = {
    tasks: [
      {
        task_key: "T1",
        title: "read fixture + write result",
        task_instruction: "read fixture.txt then write out/result.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        selected_executor: PAIR_NATIVE_EXECUTOR_ID,
        metadata: { risk_class: opts.risk ?? "LOW" },
      },
    ],
  };
  const tasks = validatePlanProposal(
    proposal,
    new Set(["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"]),
  );
  const committed = h.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: tasks.map((t) => ({ ...t })),
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const taskId = committed.task_ids[0];
  const active = h.service.activeRevision(String(mission.mission_id));
  const request = {
    mission_id: mission.mission_id,
    task_id: taskId,
    plan_revision: active.revision,
    task_instruction: "read fixture.txt then write out/result.txt",
    workspace: h.workspace,
    allowed_paths: [h.workspace],
    permissions: ["FILE_WRITE"],
    constraints: [],
    timeout: 30,
    correlation_id: "corr-p2",
    expected_output_contract: {
      type: "TASK_RESULT",
      worker_spec: workerSpec(h.workspace),
    },
  };
  if (opts.approve) {
    h.gate.recordApproval({
      mission_id: String(mission.mission_id),
      task_id: taskId,
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      approved_by: "operator@test",
      request,
    });
  }
  return { ...h, missionId: String(mission.mission_id), taskId, request };
}

async function waitForTerminal(
  h: Harness,
  executionId: string,
  timeoutMs = 25_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = h.adapter.observe(executionId);
    const status = String(observed.status);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(status)) {
      return observed;
    }
    if (Date.now() > deadline) {
      throw new Error(`execution ${executionId} never reached terminal`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

describe("P2 PAIR_NATIVE adapter contract", () => {
  it("probe/qualify/capabilities/health expose a qualified executor", async () => {
    const h = makeHarness("contract");
    cleanups.push(() => h.runner.shutdown());
    expect(h.adapter.probe()).toMatchObject({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      available: true,
      worker_kind: AUTOMATON_HARNESS_WORKER_KIND,
    });
    expect(h.adapter.qualify()).toMatchObject({ qualified: true, dispatch_enabled: true });
    const caps = h.adapter.capabilities();
    expect(caps.capability_ids).toContain("FILE_OPERATIONS");
    expect(caps.op_contracts).toContain("write_text_file");
    expect(caps.denied_by_default_ops).toContain("delete_file");
    expect(h.adapter.health()).toMatchObject({ state: "READY" });
  });

  it("worker_execution_id is deterministic per (executor, governed_task)", () => {
    const a = workerExecutionId("PAIR_NATIVE", "GTSK_x");
    const b = workerExecutionId("PAIR_NATIVE", "GTSK_x");
    const c = workerExecutionId("PAIR_NATIVE", "GTSK_y");
    expect(a).toBe(b);
    expect(a).toMatch(/^EXE_[0-9a-f]{32}$/);
    expect(a).not.toBe(c);
  });
});

describe("P2 PAIR_WORKER_FILE protocol", () => {
  function baseSpec(workspace: string): WorkerSpec {
    return {
      schema: WORKER_SPEC_SCHEMA,
      worker_kind: AUTOMATON_HARNESS_WORKER_KIND,
      worker_execution_id: "EXE_test",
      execution_id: "EXE_test",
      governed_task_id: "GTSK_t",
      mission_id: "MSN_t",
      task_id: "TSK_t",
      correlation_id: "corr",
      workspace_root: workspace,
      run_root: `${workspace}/run`,
      allowed_paths: [workspace],
      limits: { max_ops: 8, timeout_seconds: 30 },
      policy: {
        workspace_root: workspace,
        allowed_paths: [workspace],
        allowed_ops: ["read_text_file", "write_text_file", "finish"],
        denied_ops: AUTOMATON_HARNESS_DENIED_OPS,
      },
      ops: [
        {
          op: "write_text_file",
          path: "a.txt",
          content: "x",
          idempotency_class: "WRITE",
          risk_class: "MEDIUM",
        },
        { op: "finish", result: {}, idempotency_class: "READ_ONLY", risk_class: "LOW" },
      ],
    };
  }

  it("accepts a valid spec", () => {
    const ws = freshDir("spec-ok");
    expect(() => validateWorkerSpec(baseSpec(ws))).not.toThrow();
  });

  it("rejects malformed/unsafe specs", () => {
    const ws = freshDir("spec-bad");
    const spec = baseSpec(ws);
    const bads: Array<[string, (s: WorkerSpec) => void]> = [
      ["schema", (s) => void (s.schema = "bogus")],
      ["worker_kind", (s) => void (s.worker_kind = "nope")],
      ["missing id", (s) => void (s.worker_execution_id = "")],
      ["empty ops", (s) => void (s.ops = [])],
      ["undeclared op", (s) => void (s.ops[0] = { ...s.ops[0], op: "exec_shell" })],
      ["denied op", (s) => void (s.ops[0] = { ...s.ops[0], op: "delete_file" })],
      [
        "placeholder",
        (s) => void (s.ops[0] = { ...s.ops[0], content: "${{{TOK}}}" }),
      ],
      [
        "path outside allowed",
        (s) => void (s.ops[0] = { ...s.ops[0], path: "../escape.txt" }),
      ],
      [
        "missing finish",
        (s) => void (s.ops = [s.ops[0]]),
      ],
      [
        "low idempotency",
        (s) =>
          void (s.ops[0] = { ...s.ops[0], idempotency_class: "READ_ONLY" }),
      ],
      [
        "timeout out of range",
        (s) => void (s.limits = { max_ops: 8, timeout_seconds: 0 }),
      ],
    ];
    for (const [label, mutate] of bads) {
      const s = baseSpec(ws);
      mutate(s);
      expect(() => validateWorkerSpec(s), label).toThrowError(IntegrityError);
    }
  });
});

describe("P2 GovernedTaskGate", () => {
  it("PASS: governed authorization then dispatch", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-pass"), { risk: "LOW" });
    cleanups.push(() => ctx.runner.shutdown());
    writeFixture(ctx.workspace);
    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    expect(governed_task.governance_state).toBe("VALIDATED");
    expect(governed_task.constraints).toEqual(
      expect.arrayContaining(["DENY_OUTSIDE_WORKSPACE", "NO_SECRET_DUMPING"]),
    );
    const authorized = ctx.gate.authorize_dispatch(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    expect(authorized.governance_state).toBe("DISPATCH_AUTHORIZED");
    const execution = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    expect(String(execution.executor_id)).toBe(PAIR_NATIVE_EXECUTOR_ID);
    await waitForTerminal(ctx, String(execution.execution_id));
  });

  it("DENY: missing approval when risk is HIGH", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-deny-approval"), {
      risk: "HIGH",
      approve: false,
    });
    expect(() => ctx.gate.create_governed_task(ctx.adapter, ctx.request)).toThrowError(
      /FAIL_CLOSED_OPERATOR_APPROVAL_REQUIRED/,
    );
  });

  it("DENY: approval with mismatched scope digest", async () => {
    const h = makeHarness("gate-deny-digest");
    const ctx = await seedGovernedTask(h, { risk: "HIGH" });
    // Approve a DIFFERENT scope (different permissions) → digest won't match.
    h.gate.recordApproval({
      mission_id: ctx.missionId,
      task_id: ctx.taskId,
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      approved_by: "operator@test",
      request: { ...ctx.request, permissions: ["FILE_READ"] },
    });
    expect(() => ctx.gate.create_governed_task(ctx.adapter, ctx.request)).toThrowError(
      /FAIL_CLOSED_OPERATOR_APPROVAL_REQUIRED/,
    );
  });

  it("PASS: valid approval recorded then authorization succeeds", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-pass-approval"), {
      risk: "HIGH",
      approve: true,
    });
    cleanups.push(() => ctx.runner.shutdown());
    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    expect(governed_task.approval_id).toBeTruthy();
    expect(governed_task.governance_state).toBe("VALIDATED");
  });

  it("DENY: unauthorized workspace", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-deny-ws"), { risk: "LOW" });
    const evil = { ...ctx.request, workspace: "/etc", allowed_paths: ["/etc"] };
    expect(() => ctx.gate.create_governed_task(ctx.adapter, evil)).toThrowError(
      /FAIL_CLOSED_WORKSPACE_UNAUTHORIZED/,
    );
  });

  it("DENY: dispatch before authorize", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-deny-lifecycle"), { risk: "LOW" });
    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    expect(() =>
      ctx.gate.dispatch_governed_task(ctx.adapter, String(governed_task.governed_task_id)),
    ).toThrowError(/FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/);
  });

  it("DENY: malformed request fails closed", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-deny-malformed"), { risk: "LOW" });
    for (const field of ["workspace", "allowed_paths", "correlation_id", "timeout"]) {
      const bad = { ...ctx.request, [field]: undefined };
      expect(
        () => ctx.gate.create_governed_task(ctx.adapter, bad),
        field,
      ).toThrowError(IntegrityError);
    }
  });

  it("DENY: permission expansion rejected", async () => {
    const ctx = await seedGovernedTask(makeHarness("gate-deny-perm"), { risk: "LOW" });
    const bad = { ...ctx.request, permissions: ["FILE_WRITE", "SECRETS_ACCESS"] };
    expect(() => ctx.gate.create_governed_task(ctx.adapter, bad)).toThrowError(
      /FAIL_CLOSED_PERMISSION_EXPANSION/,
    );
  });
});

describe("P2 vertical slice + worker execution", () => {
  it("end-to-end governed task COMPLETED with evidence at every boundary", async () => {
    const ctx = await seedGovernedTask(makeHarness("e2e"), { risk: "LOW" });
    cleanups.push(() => ctx.runner.shutdown());
    writeFixture(ctx.workspace);

    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    ctx.gate.authorize_dispatch(ctx.adapter, String(governed_task.governed_task_id));
    const execution = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    const executionId = String(execution.execution_id);
    expect(executionId).toBe(
      workerExecutionId(PAIR_NATIVE_EXECUTOR_ID, String(governed_task.governed_task_id)),
    );

    await waitForTerminal(ctx, executionId);

    // PAIR_WORKER_FILE evidence files exist.
    const runRoot = String(execution.run_root);
    const paths = workerFilePaths(runRoot);
    for (const p of [paths.spec, paths.executionJournal, paths.workerChild, paths.result]) {
      expect(fs.existsSync(p), p).toBe(true);
    }
    const spec = JSON.parse(fs.readFileSync(paths.spec, "utf8")) as WorkerSpec;
    expect(spec.mission_id).toBe(ctx.missionId);
    expect(spec.task_id).toBe(ctx.taskId);
    expect(spec.policy.allowed_ops).toContain("write_text_file");
    const child = JSON.parse(fs.readFileSync(paths.workerChild, "utf8"));
    expect(child.supplemental).toBe(true);
    expect(child.automaton_task_id).toBeTruthy();

    const journal = readExecutionJournal(runRoot)!;
    expect(journal.status).toBe("RUNNING");

    const workerJournal = readWorkerJournal(runRoot);
    const events = workerJournal.map((e) => e.event);
    expect(events).toContain("worker_started");
    expect(events.filter((e) => e === "op_completed")).toHaveLength(3);
    expect(events).toContain("worker_finished");

    const result = ctx.gate.collect_execution_result(ctx.adapter, executionId);
    expect(result.result_state).toBe("COMPLETED");
    const artifacts = ctx.adapter.collect_artifacts(executionId);
    expect(artifacts.map((a) => a.path)).toContain("out/result.txt");
    expect(fs.readFileSync(path.join(ctx.workspace, "out/result.txt"), "utf8")).toBe(
      "governed-output",
    );

    const validation = ctx.gate.validate_execution_result(executionId);
    expect(validation.status).toBe("PASS");

    // Governed evidence, separate store, verify-on-read.
    const evidence = ctx.store.listEvidence(ctx.missionId).map((e) => e.kind);
    expect(evidence).toEqual(
      expect.arrayContaining([
        "GOVERNED_TASK_VALIDATED",
        "DISPATCH_AUTHORIZED",
        "EXECUTION_DISPATCHED",
        "RESULT_COLLECTED",
        "RESULT_VALIDATION",
      ]),
    );
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();

    // Automaton task-graph reached terminal state.
    const workerTaskId = String(child.automaton_task_id);
    const row = getTaskById(ctx.db, workerTaskId)!;
    expect(row.status).toBe("completed");
  }, 30_000);

  it("mandatory negative: unauthorized task never executes or mutates workspace", async () => {
    const ctx = await seedGovernedTask(makeHarness("neg"), { risk: "LOW" });
    writeFixture(ctx.workspace);
    const before = fs.readdirSync(ctx.workspace).sort();

    // Attempt dispatch straight at the adapter — no gate authorization.
    const forged = {
      governed_task_id: "GTSK_forge",
      mission_id: ctx.missionId,
      task_id: ctx.taskId,
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      workspace: ctx.workspace,
      correlation_id: "corr",
      governance_state: "VALIDATED", // not DISPATCH_AUTHORIZED
      dispatch_enabled: false,
      governance_digest: "x",
      expected_output_contract: ctx.request.expected_output_contract,
      task_instruction: "forge",
    };
    expect(() => ctx.adapter.dispatch(forged)).toThrowError(
      /FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/,
    );
    expect(fs.readdirSync(ctx.workspace).sort()).toEqual(before);
    const runRoot = ctx.runner.runRootFor(
      workerExecutionId(PAIR_NATIVE_EXECUTOR_ID, "GTSK_forge"),
    );
    expect(fs.existsSync(runRoot)).toBe(false);
    // Gate never saw it → zero execution evidence.
    expect(
      ctx.store.list("executor_execution").filter((e) => e.mission_id === ctx.missionId),
    ).toHaveLength(0);
    await ctx.runner.shutdown();
  });

  it("worker failure is normalized: FAILED, observable, no false COMPLETED", async () => {
    const h = makeHarness("fail");
    const ctx = await seedGovernedTask(h, { risk: "LOW" });
    cleanups.push(() => ctx.runner.shutdown());
    // NO fixture written → read_text_file fails.
    const badSpec = workerSpec(ctx.workspace);
    ctx.request.expected_output_contract = { type: "TASK_RESULT", worker_spec: badSpec };

    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    ctx.gate.authorize_dispatch(ctx.adapter, String(governed_task.governed_task_id));
    const execution = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    const executionId = String(execution.execution_id);
    await waitForTerminal(ctx, executionId);
    const result = ctx.gate.collect_execution_result(ctx.adapter, executionId);
    expect(result.result_state).toBe("FAILED");
    const adapterResult = result.result as Record<string, unknown>;
    expect((adapterResult.error as Record<string, unknown>)?.class).toBeTruthy();
    const workerJournal = readWorkerJournal(String(execution.run_root));
    expect(workerJournal.some((e) => e.event === "op_failed")).toBe(true);
    // No uncontrolled replay: a second dispatch returns the same execution.
    const again = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    expect(again.execution_id).toBe(executionId);
    const row = getTaskById(
      ctx.db,
      String(
        (JSON.parse(
          fs.readFileSync(workerFilePaths(String(execution.run_root)).workerChild, "utf8"),
        ) as Record<string, unknown>).automaton_task_id,
      ),
    );
    expect(row!.status).toBe("failed");
  }, 30_000);

  it("artifact validation fails closed on tampered/missing artifact", async () => {
    const ctx = await seedGovernedTask(makeHarness("artifact"), { risk: "LOW" });
    cleanups.push(() => ctx.runner.shutdown());
    writeFixture(ctx.workspace);
    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    ctx.gate.authorize_dispatch(ctx.adapter, String(governed_task.governed_task_id));
    const execution = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    const executionId = String(execution.execution_id);
    await waitForTerminal(ctx, executionId);
    ctx.gate.collect_execution_result(ctx.adapter, executionId);
    // Tamper with the artifact after collection.
    fs.writeFileSync(path.join(ctx.workspace, "out/result.txt"), "tampered", "utf8");
    const validation = ctx.gate.validate_execution_result(executionId);
    expect(validation.status).toBe("FAIL");
    expect(validation.failures).toEqual(
      expect.arrayContaining([expect.stringContaining("sha256 mismatch")]),
    );
    // No artifact entities persisted for a failed batch.
    expect(ctx.store.list("artifact")).toHaveLength(0);
  }, 30_000);

  it("bounded cancellation: CANCELLED execution, evidence preserved", async () => {
    const ctx = await seedGovernedTask(makeHarness("cancel"), { risk: "LOW" });
    cleanups.push(() => ctx.runner.shutdown());
    writeFixture(ctx.workspace);
    const slowSpec = workerSpec(ctx.workspace, {
      ops: [
        { op: "sleep_ms", ms: 3000, idempotency_class: "READ_ONLY", risk_class: "LOW" },
        {
          op: "write_text_file",
          path: "out/late.txt",
          content: "too late",
          idempotency_class: "WRITE",
          risk_class: "MEDIUM",
        },
        { op: "finish", result: { summary: "late" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
      ],
    });
    ctx.request.expected_output_contract = {
      type: "TASK_RESULT",
      worker_spec: slowSpec,
    };
    const { governed_task } = ctx.gate.create_governed_task(ctx.adapter, ctx.request);
    ctx.gate.authorize_dispatch(ctx.adapter, String(governed_task.governed_task_id));
    const execution = ctx.gate.dispatch_governed_task(
      ctx.adapter,
      String(governed_task.governed_task_id),
    );
    const executionId = String(execution.execution_id);
    const cancelled = ctx.adapter.cancel(executionId);
    expect(cancelled.status).toBe("CANCELLED");
    const journal = readExecutionJournal(String(execution.run_root));
    expect(journal!.status).toBe("CANCELLED");
    await waitForTerminal(ctx, executionId).catch(() => cancelled);
    const result = ctx.adapter.collect_result(executionId);
    expect(["CANCELLED", "FAILED"]).toContain(String(result.status));
    expect(fs.existsSync(path.join(ctx.workspace, "out/late.txt"))).toBe(false);
  }, 30_000);

  it("evidence store is append-only, verify-on-read, secret-free", async () => {
    const h = makeHarness("evidence");
    cleanups.push(() => h.runner.shutdown());
    h.store.appendEvidence("MSN_x", "TEST_KIND", { a: 1 });
    expect(h.store.listEvidence("MSN_x")).toHaveLength(1);
    // Tamper a stored payload → verify-on-read must fail closed.
    h.store.db
      .prepare("UPDATE governed_evidence SET payload = ? WHERE 1=1")
      .run('{"tampered":true}');
    expect(() => h.store.listEvidence("MSN_x")).toThrowError(IntegrityError);
    // Secret keys are rejected.
    expect(() =>
      h.store.appendEvidence("MSN_x", "TEST_KIND", { api_key: "sk-1" }),
    ).toThrowError(/FAIL_CLOSED_SECRET_FIELD_REJECTED/);
    // Plan revisions verify on read too.
    h.service.createProject({ name: "p", root_location: h.workspace });
  });
});
