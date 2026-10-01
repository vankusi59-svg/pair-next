/**
 * P3 routing-authority tests: CapabilityRouter → ExecutorRegistry →
 * RouteSelector/RouteRegistry/RouteLedger → GovernedTaskGate → PAIR_NATIVE.
 * One canonical routing authority; fail-closed eligibility; routing evidence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, getTaskById } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ArtifactProvenanceValidator,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_BINDING_ID,
  PAIR_NATIVE_EXECUTOR_ID,
  PAIR_NATIVE_ROUTE_ID,
  PolicyError,
  RouteLedger,
  RouteSelector,
  validatePlanProposal,
  workerExecutionId,
  workerFilePaths,
} from "../pair/index.js";
import { projectRoutableExecutors } from "../pair/routing-projection.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p3-"));
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

interface Ctx {
  db: ReturnType<typeof createDatabase>["raw"];
  store: PairEvidenceStore;
  service: PairControlPlane;
  runner: PairNativeWorkerRunner;
  adapter: PairNativeExecutorAdapter;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  workspace: string;
}

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const automaton = createDatabase(path.join(dir, "state.db"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const runner = new PairNativeWorkerRunner({
    db: automaton.raw,
    config: { name: "p3-test", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p3-test" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot: path.join(dir, "journal"),
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  return { db: automaton.raw, store, service, runner, adapter, gate, registry, router, workspace };
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

interface MissionCtx extends Ctx {
  missionId: string;
  taskId: string;
  request: Record<string, unknown>;
}

function seedMission(
  ctx: Ctx,
  opts: { capabilities?: string[]; permissions?: string[]; metadata?: Record<string, unknown> } = {},
): MissionCtx {
  const project = ctx.service.createProject({ name: "p3", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p3 routing slice",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  ctx.service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  ctx.service.registerCapability("AUTOMATON_TASK_EXECUTION", { risk_class: "LOW" });
  ctx.service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 3 });

  const proposal = {
    tasks: [
      {
        task_key: "T1",
        title: "routed governed task",
        task_instruction: "read fixture.txt then write out/result.txt",
        required_capabilities: opts.capabilities ?? ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: opts.metadata ?? { risk_class: "LOW" },
      },
    ],
  };
  const tasks = validatePlanProposal(
    proposal,
    new Set(["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", ...(opts.capabilities ?? [])]),
  );
  const committed = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: tasks.map((t) => ({ ...t })),
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const taskId = committed.task_ids[0];
  const active = ctx.service.activeRevision(String(mission.mission_id));
  const request = {
    mission_id: mission.mission_id,
    task_id: taskId,
    plan_revision: active.revision,
    task_instruction: "read fixture.txt then write out/result.txt",
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: opts.permissions ?? ["FILE_WRITE"],
    constraints: [],
    timeout: 30,
    correlation_id: "corr-p3",
    expected_output_contract: {
      type: "TASK_RESULT",
      worker_spec: {
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
            content: "routed-output",
            idempotency_class: "WRITE",
            risk_class: "MEDIUM",
          },
          {
            op: "finish",
            result: { summary: "routed" },
            idempotency_class: "READ_ONLY",
            risk_class: "LOW",
          },
        ],
        limits: { max_ops: 8, timeout_seconds: 30 },
        allowed_ops: ["read_text_file", "write_text_file", "finish"],
      },
    },
  };
  return { ...ctx, missionId: String(mission.mission_id), taskId, request };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const adaptersOf = (ctx: Ctx) => new Map([[PAIR_NATIVE_EXECUTOR_ID, ctx.adapter]]);

async function waitTerminal(ctx: Ctx, executionId: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = ctx.adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) {
      return o;
    }
    if (Date.now() > deadline) throw new Error("execution never reached terminal");
    await new Promise((r) => setTimeout(r, 80));
  }
}

describe("P3 routing authority — positive slice", () => {
  it("routes via CapabilityRouter→RouteSelector→Gate→LocalWorkerPool end-to-end", async () => {
    const ctx = makeCtx("e2e");
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    fs.writeFileSync(path.join(ctx.workspace, "fixture.txt"), "fixture-content", "utf8");
    const m = seedMission(ctx);

    const out = ctx.router.routeGovernedTask(m.request, adaptersOf(ctx));
    const routing = out.routing_decision as Record<string, unknown>;
    const routeDec = out.route_decision as Record<string, unknown>;
    const governed = out.governed_task as Record<string, unknown>;
    const execution = out.execution as Record<string, unknown>;

    // Executor was selected BY routing — not hard-coded.
    expect(routing.selected_executor).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(routing.evaluation_mode).toBe("DISPATCH");
    expect(routing.eligible_executors).toEqual([PAIR_NATIVE_EXECUTOR_ID]);
    expect(String(routing.decision_digest)).toHaveLength(64);

    // Route selection persisted with binding.
    expect(routeDec.selected_route_id).toBe(PAIR_NATIVE_ROUTE_ID);
    expect(routeDec.selected_binding_id).toBe(PAIR_NATIVE_BINDING_ID);
    expect(routeDec.binding_mechanism).toBe("IN_PROCESS");

    // Task carries the routing binding.
    const taskRow = ctx.service.getTask(m.taskId);
    expect(taskRow.selected_executor).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(taskRow.routing_decision_id).toBe(routing.routing_decision_id);
    expect(taskRow.route_decision_id).toBe(routeDec.decision_id);
    expect(taskRow.status).toBe("ROUTED");

    // Dispatch through the only path — gate → adapter → LocalWorkerPool.
    expect(String(execution.execution_id)).toBe(
      workerExecutionId(PAIR_NATIVE_EXECUTOR_ID, String(governed.governed_task_id)),
    );
    await waitTerminal(ctx, String(execution.execution_id));
    const collected = ctx.gate.collect_execution_result(ctx.adapter, String(execution.execution_id));
    expect(collected.result_state).toBe("COMPLETED");

    // Routing + execution evidence landed on the canonical PAIR store.
    const kinds = ctx.store.listEvidence(m.missionId).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "ROUTING_DECISION",
        "ROUTE_BOUND",
        "GOVERNED_TASK_VALIDATED",
        "DISPATCH_AUTHORIZED",
        "EXECUTION_DISPATCHED",
        "RESULT_COLLECTED",
      ]),
    );
    // Decision receipts are durable entities.
    expect(
      ctx.store.get("routing_decision", String(routing.routing_decision_id)).decision_digest,
    ).toBe(routing.decision_digest);
    expect(ctx.store.get("route_decision", String(routeDec.decision_id)).selected_route_id).toBe(
      PAIR_NATIVE_ROUTE_ID,
    );

    // Terminal outcome recorded in route telemetry.
    ctx.router.recordTerminalOutcome(
      String(routeDec.selected_route_id),
      { ...execution, execution_state: "COMPLETED" },
      12,
    );
    const invocations = new RouteLedger(ctx.service).listInvocations(PAIR_NATIVE_ROUTE_ID);
    expect(invocations.map((i) => i.event_kind)).toEqual(
      expect.arrayContaining(["INVOCATION_DISPATCHED", "INVOCATION_SUCCESS"]),
    );

    // Derived projection: PAIR_NATIVE is routable.
    const rows = projectRoutableExecutors(ctx.service);
    expect(rows.find((r) => r.executor_id === PAIR_NATIVE_EXECUTOR_ID)?.routable).toBe(true);

    // Artifact provenance + task graph terminal.
    const validation = new ArtifactProvenanceValidator().validate_execution(
      ctx.service,
      String(execution.execution_id),
    );
    expect(validation.status).toBe("PASS");
    const child = JSON.parse(
      fs.readFileSync(workerFilePaths(String(execution.run_root)).workerChild, "utf8"),
    );
    expect(getTaskById(ctx.db, String(child.automaton_task_id))!.status).toBe("completed");
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  }, 30_000);

  it("PLAN mode selects without a bound adapter; DISPATCH requires it", async () => {
    const ctx = makeCtx("modes");
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    const task = ctx.service.getTask(m.taskId);

    const plan = ctx.router.capabilityRouter.route(task, { mode: "PLAN" });
    expect(plan.selected_executor).toBe(PAIR_NATIVE_EXECUTOR_ID);

    const noAdapters = ctx.router.capabilityRouter.route(task, {
      mode: "DISPATCH",
      adapters: new Map(),
    });
    expect(noAdapters.selected_executor).toBeNull();
    const reasons = (noAdapters.rejected_executors as Array<Record<string, unknown>>)[0]
      .reasons as string[];
    expect(reasons).toContain("ADAPTER_NOT_BOUND");
  });
});

describe("P3 negative tests — fail-closed eligibility", () => {
  it("A: missing capability → executor rejected, no dispatch", () => {
    const ctx = makeCtx("neg-cap");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, { capabilities: ["QUANTUM_COMPUTE"] });
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    const decisions = ctx.store.list("routing_decision");
    const rejected = decisions[0].rejected_executors as Array<Record<string, unknown>>;
    expect(String(rejected[0].reasons)).toContain("MISSING_CAPABILITIES:QUANTUM_COMPUTE");
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("B: executor disabled → no dispatch", () => {
    const ctx = makeCtx("neg-disabled");
    registerPairNative(ctx);
    // Disable after registration.
    ctx.service.registerExecutor(
      { ...ctx.service.getExecutor(PAIR_NATIVE_EXECUTOR_ID), status: "DISABLED" },
      "test",
    );
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(rejected[0].reasons).toContain("EXECUTOR_DISABLED");
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
  });

  it("C: executor unqualified (live requalification fails) → no dispatch", () => {
    const ctx = makeCtx("neg-unqual");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    const unqualified: ExecutorAdapter = Object.create(ctx.adapter, {
      qualify: {
        value: () => ({ qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNQUALIFIED"] }),
      },
    });
    expect(() =>
      ctx.router.routeGovernedTask(m.request, new Map([[PAIR_NATIVE_EXECUTOR_ID, unqualified]])),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/);
    const rejected = (ctx.store.list("routing_decision")[0] as Record<string, unknown>)
      .rejected_executors as Array<Record<string, unknown>>;
    expect(rejected[0].reasons).toContain("EXECUTOR_UNQUALIFIED");
  });

  it("D: unhealthy executor → no dispatch", () => {
    const ctx = makeCtx("neg-health");
    registerPairNative(ctx, { health_override: undefined });
    ctx.service.registerExecutor(
      { ...ctx.service.getExecutor(PAIR_NATIVE_EXECUTOR_ID), health_state: "DEGRADED" },
      "test",
    );
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    const reasons = ((
      ctx.store.list("routing_decision")[0].rejected_executors as Array<Record<string, unknown>>
    )[0].reasons) as string[];
    expect(reasons.some((r) => r.startsWith("HEALTH_"))).toBe(true);
  });

  it("E: workspace incompatibility → no dispatch", () => {
    const ctx = makeCtx("neg-ws");
    registerPairNative(ctx, { workspace_modes: ["SANDBOXED_ONLY"] });
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    const reasons = ((
      ctx.store.list("routing_decision")[0].rejected_executors as Array<Record<string, unknown>>
    )[0].reasons) as string[];
    expect(reasons.some((r) => r.startsWith("WORKSPACE_INCOMPATIBLE"))).toBe(true);
  });

  it("F: permission mismatch → no dispatch", () => {
    const ctx = makeCtx("neg-perm");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx, { permissions: ["FILE_WRITE", "SECRETS_ACCESS"] });
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    const reasons = ((
      ctx.store.list("routing_decision")[0].rejected_executors as Array<Record<string, unknown>>
    )[0].reasons) as string[];
    expect(reasons.some((r) => r.startsWith("PERMISSION_INCOMPATIBLE"))).toBe(true);
  });

  it("G: no eligible executor → explicit routing failure, no fallback", () => {
    const ctx = makeCtx("neg-none");
    // No executor registered at all.
    const m = seedMission(ctx);
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/,
    );
    // And no route either — the pipeline never reaches dispatch.
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
    const evidence = ctx.store.listEvidence(m.missionId).map((e) => e.kind);
    expect(evidence).toContain("ROUTING_FAILED");
  });

  it("H: forged direct adapter dispatch cannot bypass GovernedTaskGate", () => {
    const ctx = makeCtx("neg-forge");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    const before = fs.readdirSync(ctx.workspace).sort();
    const forged = {
      governed_task_id: "GTSK_forge",
      mission_id: m.missionId,
      task_id: m.taskId,
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      workspace: ctx.workspace,
      correlation_id: "corr",
      governance_state: "VALIDATED",
      dispatch_enabled: false,
      governance_digest: "x",
      expected_output_contract: m.request.expected_output_contract,
      task_instruction: "forge",
    };
    expect(() => ctx.adapter.dispatch(forged)).toThrowError(
      /FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/,
    );
    expect(fs.readdirSync(ctx.workspace).sort()).toEqual(before);
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
    void ctx.runner.shutdown();
  });

  it("I: route decision tampering is detected (verify-on-read + digest)", () => {
    const ctx = makeCtx("neg-tamper");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    const m = seedMission(ctx);
    const task = ctx.service.getTask(m.taskId);
    const decision = ctx.router.capabilityRouter.route(task, {
      mode: "PLAN",
      correlationId: "c",
    });
    const id = String(decision.routing_decision_id);
    expect(ctx.router.verifyRoutingDecision(id)).toBe(true);
    // Digest-level: mutating an in-memory copy is caught.
    const copy = { ...decision, selected_executor: "EVIL_EXECUTOR" };
    expect(ctx.router.capabilityRouter.verifyDecisionDigest(copy)).toBe(false);
    // Store-level: mutating the durable payload trips verify-on-read.
    ctx.store.db
      .prepare("UPDATE entities SET payload = ? WHERE entity_type='routing_decision'")
      .run('{"selected_executor":"EVIL_EXECUTOR"}');
    expect(() => ctx.store.get("routing_decision", id)).toThrowError(IntegrityError);
  });

  it("J: idempotent routing/dispatch produces exactly one execution", async () => {
    const ctx = makeCtx("idem");
    cleanups.push(() => ctx.runner.shutdown());
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    fs.writeFileSync(path.join(ctx.workspace, "fixture.txt"), "x", "utf8");
    const m = seedMission(ctx);

    const first = ctx.router.routeGovernedTask(m.request, adaptersOf(ctx));
    const executionId = String((first.execution as Record<string, unknown>).execution_id);
    await waitTerminal(ctx, executionId);

    const second = ctx.router.routeGovernedTask(m.request, adaptersOf(ctx));
    expect(second.adopted).toBe(true);
    expect(String((second.execution as Record<string, unknown>).execution_id)).toBe(executionId);
    expect(
      ctx.store.list("executor_execution").filter((e) => e.mission_id === m.missionId),
    ).toHaveLength(1);
    expect(ctx.store.list("governed_task")).toHaveLength(1);
  }, 30_000);

  it("binding not qualified → route selection fails closed", () => {
    const ctx = makeCtx("neg-binding");
    registerPairNative(ctx);
    // Route enabled but binding left DECLARED (not QUALIFIED).
    ctx.service.routes.registerRoute({
      route_id: PAIR_NATIVE_ROUTE_ID,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      qualification_state: "QUALIFIED",
      eligibility_state: "QUALIFIED",
      capabilities: ["FILE_OPERATIONS"],
      executor_hint: PAIR_NATIVE_EXECUTOR_ID,
    });
    ctx.service.routes.registerBinding({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      route_id: PAIR_NATIVE_ROUTE_ID,
      mechanism: "IN_PROCESS",
      qualification_state: "DECLARED",
    });
    const m = seedMission(ctx);
    // Route-local infeasibility (unqualified binding) is FAIL_CLOSED_ROUTE_INFEASIBLE;
    // FAIL_CLOSED_NO_ELIGIBLE_ROUTE is reserved for genuine policy denials.
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_ROUTE_INFEASIBLE/,
    );
    const decisions = ctx.store.list("route_decision");
    const rejections = decisions[0].hard_rejections as Array<Record<string, unknown>>;
    expect(rejections[0].reason_codes).toContain("BINDING_NOT_QUALIFIED");
  });

  it("route disabled → no eligible route", () => {
    const ctx = makeCtx("neg-route");
    registerPairNative(ctx);
    ctx.service.routes.seedPairNativeRoute();
    ctx.service.routes.setRouteEnabled(PAIR_NATIVE_ROUTE_ID, false);
    const m = seedMission(ctx);
    expect(() => ctx.router.routeGovernedTask(m.request, adaptersOf(ctx))).toThrowError(
      /FAIL_CLOSED_ROUTE_INFEASIBLE/,
    );
  });

  it("executor identity conflict fails closed", () => {
    const ctx = makeCtx("neg-identity");
    registerPairNative(ctx);
    expect(() =>
      ctx.registry.register({
        executor_id: PAIR_NATIVE_EXECUTOR_ID,
        executor_type: "AUTOMATON_WORKER",
        capabilities: ["FILE_OPERATIONS"],
        health_state: "READY",
        status: "ENABLED",
        metadata: { transport_type: "NATIVE_CLI" },
      }),
    ).toThrowError(/FAIL_CLOSED_EXECUTOR_IDENTITY_CONFLICT/);
  });
});
