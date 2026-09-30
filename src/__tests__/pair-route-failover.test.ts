/**
 * Route-level model failover tests.
 *
 * Canonical model routes (RTE_DSH_<provider>_<model>) bound to one executor
 * let RE_ROUTE hop between models on the same executor: quota/rate-limit,
 * provider, and model failures stay route-scoped while executor-scoped
 * failures still leave the executor. RETRY_SAME_ROUTE pins the failed
 * attempt's exact route via operator_pin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  classifyFailure,
  DshExecutorAdapter,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-rf-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

class ScriptedAdapter implements ExecutorAdapter {
  script: Array<{ status: string; error_class?: string }> = [];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  available = true;

  constructor(readonly executor_id: string, script: Array<{ status: string; error_class?: string }> = []) {
    this.script = [...script];
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return this.available
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNAVAILABLE"] };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING"] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "PROCESS_EXIT", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: `${this.executor_id} did work` };
    return { execution_id: eid, status: step.status, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

const ALL_CAPS = [
  "FILE_OPERATIONS",
  "AUTOMATON_TASK_EXECUTION",
  "SHELL_EXECUTION",
  "CODE_GENERATION",
  "REASONING",
];

interface Ctx {
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  projectId: string;
}

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 1 });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery,
    planner: () => ({
      tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
    }),
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return { workspace, store, service, runtime, supervisor, control, adapters, projectId: String(project.project_id) };
}

/** Register a scripted executor plus canonical model routes bound to it —
 * mirrors what serve-mission-control.mjs does per qualified model route. */
function registerWithModelRoutes(ctx: Ctx, adapter: ScriptedAdapter, modelRoutes: Array<{ routeId: string; priority: number }>) {
  const executorId = adapter.executor_id;
  ctx.service.registerExecutor({
    executor_id: executorId,
    executor_type: "EXTERNAL",
    capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: 4,
    },
  });
  const caps = ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING"];
  for (const { routeId, priority } of modelRoutes) {
    if (!ctx.service.routes.getRoute(routeId)) {
      ctx.service.routes.registerRoute({
        route_id: routeId,
        route_kind: "REMOTE_GATEWAY_API",
        enabled: true,
        eligibility_state: "QUALIFIED",
        qualification_state: "QUALIFIED",
        capabilities: caps,
        priority,
        executor_hint: executorId,
        model_entry_id: `ME_${routeId}`,
        model_id: `model-${routeId}`,
        metadata: { provider_id: "prov", model_id: `model-${routeId}`, credential_env: "PROV_API_KEY" },
      });
    }
    if (!ctx.service.routes.bindingFor(executorId, routeId)) {
      ctx.service.routes.registerBinding({
        executor_id: executorId,
        route_id: routeId,
        mechanism: "SPAWN_ENV",
        qualification_state: "QUALIFIED",
      });
    }
  }
  ctx.adapters.set(executorId, adapter);
}

const missionIdOf = (ctx: Ctx) => {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "rf",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
};
const rt = (ctx: Ctx, mid: string) => ctx.store.get("mission_runtime", `MRT_${mid}`);
const governedRoutes = (ctx: Ctx) =>
  ctx.store
    .list("governed_task")
    .map((g) => String(g.selected_route_id ?? ""))
    .filter(Boolean);

function settle(ctx: Ctx, mid: string, maxSweeps = 200) {
  ctx.supervisor.runUntilSettled({ maxSweeps });
}

/* ------------------------------- selector ------------------------------- */

describe("route-level failover — selector", () => {
  it("RF-SELECT-BOOT-ORDER: first dispatch binds the boot-priority-first model route", () => {
    const ctx = makeCtx("sel-order");
    const a = new ScriptedAdapter("EX_DSH");
    registerWithModelRoutes(ctx, a, [
      { routeId: "RTE_EX_DSH_NVIDIA", priority: 10 },
      { routeId: "RTE_EX_DSH_CLOUDFLARE", priority: 20 },
    ]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    expect(governedRoutes(ctx)).toEqual(["RTE_EX_DSH_NVIDIA"]);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
  });
});

/* ------------------------------- decide --------------------------------- */

describe("route-level failover — failure classification", () => {
  it("RF-CLASS-ACP-QUOTA: ACP-wrapped 429 message classifies RATE_LIMITED", () => {
    expect(
      classifyFailure({
        error_class: "ACP_REQUEST_ERROR",
        result: { status: "FAILED", error: { message: 'upstream 429: rate limit exceeded' } },
      }),
    ).toBe("RATE_LIMITED");
  });

  it("RF-CLASS-ACP-MODEL: ACP-wrapped unknown-model message classifies MODEL_UNAVAILABLE", () => {
    expect(
      classifyFailure({
        error_class: "ACP_REQUEST_ERROR",
        result: { status: "FAILED", error: { message: 'Invalid params: unknown model option: ["nvidia","z-ai/glm-MODEL_REMOVED-drill"]' } },
      }),
    ).toBe("MODEL_UNAVAILABLE");
  });

  it("RF-CLASS-PURE-TRANSPORT: generic transport failure stays TRANSIENT_TRANSPORT", () => {
    expect(
      classifyFailure({
        error_class: "ACP_REQUEST_ERROR",
        result: { status: "FAILED", error: { message: 'socket hang up mid-request' } },
      }),
    ).toBe("TRANSIENT_TRANSPORT");
  });

  it("RF-CLASS-CLASS-WINS: a specific errClass beats unrelated message keywords", () => {
    expect(
      classifyFailure({
        error_class: "AUTHENTICATION_FAILURE",
        result: { status: "FAILED", error: { message: 'credential rejected; 429 quota' } },
      }),
    ).toBe("AUTHENTICATION_FAILURE");
  });
});

describe("route-level failover — recovery decision", () => {
  it("RF-DECIDE-ROUTE-ALTERNATE-ALLOWED: RE_ROUTE allowed on route alternates alone", () => {
    const ctx = makeCtx("dec-allow");
    const recovery = new RecoveryController(ctx.service);
    const d = recovery.decide({
      mission_id: "M1",
      task_id: "T1",
      failure_class: "RATE_LIMITED",
      executor_id: "DEEPSEEK_HARNESS",
      eligible_executors: ["DEEPSEEK_HARNESS"],
      eligible_route_ids: ["RTE_B"],
      visited_route_ids: ["RTE_A"],
    });
    expect(d.selected_action).toBe("RE_ROUTE");
  });

  it("RF-DECIDE-NO-ALTERNATE: all routes visited → RE_ROUTE rejected, next action wins", () => {
    const ctx = makeCtx("dec-none");
    const recovery = new RecoveryController(ctx.service);
    const d = recovery.decide({
      mission_id: "M1",
      task_id: "T1",
      failure_class: "RATE_LIMITED",
      executor_id: "DEEPSEEK_HARNESS",
      eligible_executors: ["DEEPSEEK_HARNESS"],
      eligible_route_ids: ["RTE_A"],
      visited_route_ids: ["RTE_A"],
    });
    expect(d.selected_action).toBe("RETRY_SAME_ROUTE");
    const rejected = (d.rejected_actions as Array<{ action: string; reason: string }>) ?? [];
    expect(rejected.find((r) => r.action === "RE_ROUTE")?.reason).toBe("NO_ALTERNATE_ELIGIBLE_EXECUTOR");
  });
});

/* --------------------------- adapter resolution ------------------------- */

describe("route-level failover — DSH adapter model resolution", () => {
  it("RF-ADAPTER-BINDING-MODEL: bound model route drives provider + credential env", () => {
    const adapter = new DshExecutorAdapter({
      journalRoot: freshDir("adapter-route"),
      envReader: (n) => (n === "CLOUDFLARE_API_TOKEN" ? "cf-key" : undefined),
      routeResolver: (id) =>
        id === "RTE_DSH_CLOUDFLARE"
          ? { route_id: id, metadata: { provider_id: "cloudflare", model_id: "@cf/zai-org/glm-4.7-flash", credential_env: "CLOUDFLARE_API_TOKEN" } }
          : null,
    });
    const env = (adapter as unknown as { providerEnv(t?: Record<string, unknown>): Record<string, string> })
      .providerEnv({ selected_route_id: "RTE_DSH_CLOUDFLARE" });
    expect(env.CLOUDFLARE_API_TOKEN).toBe("cf-key");
    expect(env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("RF-ADAPTER-ENV-FALLBACK: unbound task falls back to PAIR_DSH_MODEL_ROUTE", () => {
    const adapter = new DshExecutorAdapter({
      journalRoot: freshDir("adapter-env"),
      envReader: (n) => (n === "PAIR_DSH_MODEL_ROUTE" ? "groq:openai/gpt-oss-20b" : n === "GROQ_API_KEY" ? "groq-key" : undefined),
      routeResolver: () => null,
    });
    const env = (adapter as unknown as { providerEnv(t?: Record<string, unknown>): Record<string, string> })
      .providerEnv({});
    expect(env.GROQ_API_KEY).toBe("groq-key");
  });
});

/* --------------------------- runtime integration ------------------------ */

describe("route-level failover — runtime path", () => {
  it("RF-REROUTE-MODEL-FAILOVER: RATE_LIMITED re-dispatches on the next model route", () => {
    const ctx = makeCtx("failover");
    const a = new ScriptedAdapter("EX_DSH", [
      { status: "FAILED", error_class: "RATE_LIMITED" },
      { status: "COMPLETED" },
    ]);
    registerWithModelRoutes(ctx, a, [
      { routeId: "RTE_EX_DSH_NVIDIA", priority: 10 },
      { routeId: "RTE_EX_DSH_CLOUDFLARE", priority: 20 },
    ]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    expect(governedRoutes(ctx)).toEqual(["RTE_EX_DSH_NVIDIA", "RTE_EX_DSH_CLOUDFLARE"]);
    expect(a.dispatched.length).toBe(2);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
  });

  it("RF-RETRY-PINS-SAME-ROUTE: PROCESS_EXIT retries on the identical route", async () => {
    const ctx = makeCtx("retry-same");
    const a = new ScriptedAdapter("EX_DSH", [
      { status: "FAILED", error_class: "PROCESS_EXIT" },
      { status: "COMPLETED" },
    ]);
    registerWithModelRoutes(ctx, a, [
      { routeId: "RTE_EX_DSH_NVIDIA", priority: 10 },
      { routeId: "RTE_EX_DSH_CLOUDFLARE", priority: 20 },
    ]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    // RETRY_SAME_ROUTE carries a real 1s backoff — wait it out, then drive again.
    await new Promise((r) => setTimeout(r, 1100));
    settle(ctx, mid);
    expect(governedRoutes(ctx)).toEqual(["RTE_EX_DSH_NVIDIA", "RTE_EX_DSH_NVIDIA"]);
    expect(a.dispatched.length).toBe(2);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
  });

  it("RF-READY-ACTION-CONSUMED: foreign sweep promotion cannot strand a pending retry", async () => {
    const ctx = makeCtx("ready-strand");
    const a = new ScriptedAdapter("EX_DSH", [
      { status: "FAILED", error_class: "PROCESS_EXIT" },
      { status: "COMPLETED" },
    ]);
    registerWithModelRoutes(ctx, a, [
      { routeId: "RTE_EX_DSH_NVIDIA", priority: 10 },
      { routeId: "RTE_EX_DSH_CLOUDFLARE", priority: 20 },
    ]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    // Another live runtime's dueActions sweep promotes SCHEDULED → READY
    // globally; the row stays consumable for its owning mission.
    for (const act of ctx.store.list("scheduled_action")) {
      if (act.mission_id !== mid) continue;
      act.status = "READY";
      ctx.store.put("scheduled_action", String(act.scheduled_action_id), act, Number(act.version));
    }
    await new Promise((r) => setTimeout(r, 1100));
    settle(ctx, mid);
    expect(governedRoutes(ctx)).toEqual(["RTE_EX_DSH_NVIDIA", "RTE_EX_DSH_NVIDIA"]);
    expect(a.dispatched.length).toBe(2);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
  });

  it("RF-EXECUTOR-SCOPED-LEAVES-EXECUTOR: executor-class failure routes to another executor", () => {
    const ctx = makeCtx("exec-scoped");
    const a = new ScriptedAdapter("EX_A", [{ status: "FAILED", error_class: "EXECUTOR_UNAVAILABLE" }]);
    const b = new ScriptedAdapter("EX_B", [{ status: "COMPLETED" }]);
    registerWithModelRoutes(ctx, a, [{ routeId: "RTE_EX_A_MODEL", priority: 10 }]);
    registerWithModelRoutes(ctx, b, [{ routeId: "RTE_EX_B_MODEL", priority: 20 }]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    expect(governedRoutes(ctx)).toEqual(["RTE_EX_A_MODEL", "RTE_EX_B_MODEL"]);
    expect(a.dispatched.length).toBe(1);
    expect(b.dispatched.length).toBe(1);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
  });

  it("RF-EXHAUSTED-ROUTES-FAIL-CLOSED: every route visited → bounded retry, no phantom route", () => {
    const ctx = makeCtx("exhausted");
    const a = new ScriptedAdapter("EX_DSH", [
      { status: "FAILED", error_class: "RATE_LIMITED" },
      { status: "FAILED", error_class: "RATE_LIMITED" },
      { status: "FAILED", error_class: "RATE_LIMITED" },
      { status: "FAILED", error_class: "RATE_LIMITED" },
    ]);
    registerWithModelRoutes(ctx, a, [{ routeId: "RTE_EX_DSH_NVIDIA", priority: 10 }]);
    const mid = missionIdOf(ctx);
    settle(ctx, mid);
    // No alternate route exists — RETRY_SAME_ROUTE is the only recoverable
    // path, bounded by the attempt budget; the task must never mint a
    // governed task on a route that was never bound to it.
    expect(a.dispatched.length).toBeLessThanOrEqual(3);
    for (const rid of governedRoutes(ctx)) expect(rid).toBe("RTE_EX_DSH_NVIDIA");
    expect(ctx.service.getMission(mid).status).not.toBe("COMPLETED");
  });
});
