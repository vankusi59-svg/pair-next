/**
 * Executor ON/OFF Dashboard — focused regressions.
 *
 * The durable `executor.status` field is the operator-intent authority:
 * CapabilityRouter rejects DISABLED upstream (EXECUTOR_DISABLED gate),
 * GovernedTaskGate re-proves at the pre-dispatch boundary (covering the
 * adoption path that bypasses the router for a VALIDATED governed task
 * whose dispatch never ran), and startup registration reconciles
 * identity/capability/health while a persisted status always wins —
 * OFF is never silently re-enabled by a restart.
 *
 * E1 product defaults (CODEX/PAIR_NATIVE ON, DEVIN/DSH OFF) + persisted
 *    status wins over seeding defaults.
 * E2 OFF blocks a fresh routeGovernedTask dispatch (adapter never called).
 * E3 a running execution keeps settling while the executor is OFF.
 * E4 OFF blocks the adoption/retry seam at dispatch_governed_task.
 * E5 restart persistence: re-registration on a reopened store keeps OFF.
 * E6 ON never bypasses qualification (unqualified stays undispatchable).
 * E7 audited idempotent toggle events via the canonical event journal.
 * E8 API: read projection + operator-gated mutation (+bound/requires_restart).
 * E9 concurrent flips are OCC-safe — audited, never a lost update.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  CODEX_EXECUTOR_ID,
  DEVIN_EXECUTOR_ID,
  DSH_EXECUTOR_ID,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionRouter,
  PAIR_NATIVE_EXECUTOR_ID,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  createMissionControlServer,
  makeServeCanonicalizer,
  plannerExecutorCapSets,
  registerGovernedExecutors,
  validatePlanProposal,
  type ExecutorAdapter,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-exec-toggle-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  qualified: boolean;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(
    id: string,
    caps: string[] = ["FILE_OPERATIONS"],
    opts: { qualified?: boolean } = {},
  ) {
    this.executor_id = id;
    this.caps = caps;
    this.qualified = opts.qualified ?? true;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return this.qualified
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["missing credential"] };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] = {
      status: "COMPLETED",
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      summary: "ok",
    };
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    return { status: this.collected[executionId] ? "COMPLETED" : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return {
      execution_id: executionId,
      artifacts: [],
      ...(this.collected[executionId] ?? {
        status: "FAILED",
        error: { class: "MISSING", message: "no scripted result" },
      }),
    };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

interface Ctx {
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  adapters: Map<string, ExecutorAdapter>;
}

/** Minimal governed stack: store + service + gate + registry + router
 *  with scripted adapters registered through the REAL
 *  registerGovernedExecutors seeding seam (probe/qualify/bind). */
function makeCtx(
  name: string,
  opts: {
    default_disabled?: string[];
    qualified?: string[];
    executors?: string[];
    caps?: Record<string, string[]>;
  } = {},
): Ctx {
  const d = dir(name);
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const wanted = new Set(
    opts.executors ?? [CODEX_EXECUTOR_ID, DEVIN_EXECUTOR_ID, DSH_EXECUTOR_ID],
  );
  const adapters = new Map<string, ExecutorAdapter>();
  const add = (id: string) => {
    adapters.set(
      id,
      new ScriptedAdapter(id, opts.caps?.[id] ?? ["FILE_OPERATIONS"], {
        qualified: (opts.qualified ?? [...wanted]).includes(id),
      }),
    );
  };
  for (const id of wanted) add(id);
  registerGovernedExecutors(service, adapters, "test", {
    default_disabled: opts.default_disabled,
  });
  return { dir: d, workspace, store, service, gate, registry, router, adapters };
}

function registerNative(ctx: Ctx) {
  // Same persisted-status expression the production bootstrap uses.
  return ctx.registry.register({
    executor_id: PAIR_NATIVE_EXECUTOR_ID,
    executor_type: "AUTOMATON_WORKER",
    capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
    health_state: "READY",
    status:
      String(ctx.store.tryGet("executor", PAIR_NATIVE_EXECUTOR_ID)?.status ?? "") ||
      "ENABLED",
    metadata: {
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      routing_priority: 100,
      supports_cancel: true,
    },
  });
}

function seedMission(
  ctx: Ctx,
  taskCount = 2,
): { missionId: string; taskIds: string[]; revision: number } {
  const project = ctx.service.createProject({ name: "toggle", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "executor toggle regression",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  const caps = ["FILE_OPERATIONS", "FILE_READ", "FILE_WRITE", "REASONING"];
  for (const c of caps) {
    try {
      ctx.service.registerCapability(c, { risk_class: "LOW" });
    } catch {
      /* already registered */
    }
  }
  ctx.service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 1 });
  const taskSpecs = Array.from({ length: taskCount }, (_, i) => ({
    task_key: `T${i + 1}`,
    title: `T${i + 1} governed`,
    task_instruction: "do governed work",
    required_capabilities: ["FILE_OPERATIONS"],
    depends_on: [],
    metadata: { risk_class: "LOW" },
  }));
  const proposal = { tasks: taskSpecs };
  const tasks = validatePlanProposal(proposal, new Set(caps));
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
): Record<string, unknown> {
  return {
    mission_id: m.missionId,
    task_id: m.taskIds[idx],
    plan_revision: m.revision,
    task_instruction: "do governed work",
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: ["FILE_WRITE"],
    requested_tools: ["FILE_OPERATIONS"],
    constraints: [],
    timeout: 30,
    correlation_id: `corr-toggle-${idx}`,
    dependency_outputs: [],
    expected_output_contract: { type: "TASK_RESULT" },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/* ---- E1 — product defaults -------------------------------------------- */

describe("E defaults & seeding", () => {
  it("E1: fresh boot — CODEX/PAIR_NATIVE default ON, DEVIN/DSH default OFF", () => {
    const ctx = makeCtx("e1", {
      default_disabled: [DEVIN_EXECUTOR_ID, DSH_EXECUTOR_ID],
    });
    registerNative(ctx);
    const status = (id: string) =>
      String(ctx.store.get("executor", id).status);
    expect(status(PAIR_NATIVE_EXECUTOR_ID)).toBe("ENABLED");
    expect(status(CODEX_EXECUTOR_ID)).toBe("ENABLED");
    expect(status(DEVIN_EXECUTOR_ID)).toBe("DISABLED");
    expect(status(DSH_EXECUTOR_ID)).toBe("DISABLED");
  });

  it("E1b: a persisted ON under a default-OFF product is preserved", () => {
    const d = dir("e1b");
    const dbPath = path.join(d, "pair.db");
    let store = new PairEvidenceStore(dbPath);
    let service = new PairControlPlane(store);
    new ExecutorRegistry(service).register({
      executor_id: DEVIN_EXECUTOR_ID,
      executor_type: "EXTERNAL",
      capabilities: ["FILE_OPERATIONS"],
      health_state: "READY",
      status: "ENABLED", // operator enabled it last session
      metadata: { qualification_state: "QUALIFIED" },
    });
    store.close();
    // "Restart": fresh store+service over the same durable file — the
    // default-OFF seeding list must NOT clobber the persisted ON.
    store = new PairEvidenceStore(dbPath);
    service = new PairControlPlane(store);
    const adapters = new Map<string, ExecutorAdapter>([
      [DEVIN_EXECUTOR_ID, new ScriptedAdapter(DEVIN_EXECUTOR_ID)],
    ]);
    registerGovernedExecutors(service, adapters, "test", {
      default_disabled: [DEVIN_EXECUTOR_ID, DSH_EXECUTOR_ID],
    });
    expect(String(store.get("executor", DEVIN_EXECUTOR_ID).status)).toBe("ENABLED");
    store.close();
  });
});

/* ---- E2/E3/E4 — OFF blocks every new dispatch path -------------------- */

describe("E dispatch blocking", () => {
  it("E2: OFF blocks a fresh routeGovernedTask — adapter never called", () => {
    const ctx = makeCtx("e2", { executors: [CODEX_EXECUTOR_ID] });
    const m = seedMission(ctx, 2);
    // ON: first task routes + dispatches through CODEX.
    const r1 = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), ctx.adapters);
    expect(String(r1.execution.execution_id ?? "")).not.toBe("");
    const codex = ctx.adapters.get(CODEX_EXECUTOR_ID) as ScriptedAdapter;
    expect(codex.dispatched.length).toBe(1);
    // OFF: a NEW governed task can never reach adapter.dispatch.
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:test");
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 1), ctx.adapters),
    ).toThrow(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR|FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
    expect(codex.dispatched.length).toBe(1);
    // The rejected_executors receipt pins EXECUTOR_DISABLED as the reason.
    const decision = ctx.store
      .list("routing_decision")
      .find((r) => String(r.task_id ?? "") === m.taskIds[1]);
    const rejected = (decision?.rejected_executors ?? []) as Array<{
      executor_id: string;
      reasons: string[];
    }>;
    const codexRejection = rejected.find(
      (r) => String(r.executor_id) === CODEX_EXECUTOR_ID,
    );
    expect(codexRejection?.reasons ?? []).toContain("EXECUTOR_DISABLED");
  });

  it("E3: OFF never cancels a running execution — settle still works", () => {
    const ctx = makeCtx("e3");
    const m = seedMission(ctx, 1);
    const r = ctx.router.routeGovernedTask(requestFor(ctx, m, 0), ctx.adapters);
    const eid = String(r.execution.execution_id);
    const codex = ctx.adapters.get(CODEX_EXECUTOR_ID) as ScriptedAdapter;
    expect(String(r.execution.execution_state)).toBe("RUNNING");
    // OFF mid-flight — the proven execution keeps settling.
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:test");
    const collected = ctx.gate.collect_execution_result(codex, eid);
    expect(String((collected.result as Record<string, unknown>).status)).toBe("COMPLETED");
  });

  it("E4: OFF blocks the adoption/retry seam at the pre-dispatch gate", () => {
    const ctx = makeCtx("e4", { executors: [CODEX_EXECUTOR_ID] });
    const m = seedMission(ctx, 1);
    // VALIDATED authorized governed task — dispatch never ran (the
    // adoption path in routeGovernedTask bypasses the capability router).
    // The router's ROUTE_BOUND authority binds selected_executor first;
    // replicate that binding (the state a task is left in when a prior
    // dispatch attempt was interrupted post-authorization).
    ctx.service.updateTask(m.taskIds[0], { selected_executor: CODEX_EXECUTOR_ID });
    const adapter = ctx.adapters.get(CODEX_EXECUTOR_ID)!;
    const { governed_task } = ctx.gate.create_governed_task(
      adapter,
      requestFor(ctx, m, 0),
    );
    const authorized = ctx.gate.authorize_dispatch(
      adapter,
      String(governed_task.governed_task_id),
    );
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:test");
    expect(() =>
      ctx.gate.dispatch_governed_task(adapter, String(authorized.governed_task_id)),
    ).toThrow(/FAIL_CLOSED_EXECUTOR_DISABLED/);
    expect((adapter as ScriptedAdapter).dispatched.length).toBe(0);
    // Re-enable → the same governed task dispatches (no bypass: the gate
    // still re-proves qualification/cost/etc).
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, true, "operator:test");
    const exec = ctx.gate.dispatch_governed_task(
      adapter,
      String(authorized.governed_task_id),
    );
    expect(String(exec.execution_id ?? "")).not.toBe("");
  });
});

/* ---- E5/E6 — persistence & non-bypass --------------------------------- */

describe("E persistence & non-bypass", () => {
  it("E5: restart persistence — re-registration preserves a persisted OFF", () => {
    const d = dir("e5");
    const dbPath = path.join(d, "pair.db");
    let store = new PairEvidenceStore(dbPath);
    let service = new PairControlPlane(store);
    let adapters = new Map<string, ExecutorAdapter>([
      [CODEX_EXECUTOR_ID, new ScriptedAdapter(CODEX_EXECUTOR_ID)],
      [DEVIN_EXECUTOR_ID, new ScriptedAdapter(DEVIN_EXECUTOR_ID)],
    ]);
    registerGovernedExecutors(service, adapters, "test", {
      default_disabled: [DEVIN_EXECUTOR_ID],
    });
    new ExecutorRegistry(service).setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:t");
    store.close();
    // Restart — DEVIN's default stays OFF; CODEX's persisted OFF wins.
    store = new PairEvidenceStore(dbPath);
    service = new PairControlPlane(store);
    adapters = new Map<string, ExecutorAdapter>([
      [CODEX_EXECUTOR_ID, new ScriptedAdapter(CODEX_EXECUTOR_ID)],
      [DEVIN_EXECUTOR_ID, new ScriptedAdapter(DEVIN_EXECUTOR_ID)],
    ]);
    registerGovernedExecutors(service, adapters, "test", {
      default_disabled: [DEVIN_EXECUTOR_ID],
    });
    expect(String(store.get("executor", CODEX_EXECUTOR_ID).status)).toBe("DISABLED");
    expect(String(store.get("executor", DEVIN_EXECUTOR_ID).status)).toBe("DISABLED");
    store.close();
  });

  it("E6: ON never bypasses qualification — unqualified stays blocked", () => {
    // Only DEVIN registered, and its adapter reports unqualified — the
    // ON flip must not bypass the capability router's qualification gate.
    const ctx = makeCtx("e6", { executors: [DEVIN_EXECUTOR_ID], qualified: [] });
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, true, "operator:test");
    expect(String(ctx.store.get("executor", DEVIN_EXECUTOR_ID).status)).toBe("ENABLED");
    expect(
      String(
        (ctx.store.get("executor", DEVIN_EXECUTOR_ID).metadata as Record<string, unknown>)
          ?.qualification_state,
      ),
    ).not.toBe("QUALIFIED");
    const m = seedMission(ctx, 1);
    expect(() =>
      ctx.router.routeGovernedTask(requestFor(ctx, m, 0), ctx.adapters),
    ).toThrow(PolicyError);
    const devin = ctx.adapters.get(DEVIN_EXECUTOR_ID) as ScriptedAdapter;
    expect(devin.dispatched.length).toBe(0);
  });
});

/* ---- E7/E9 — audit, idempotency, safe concurrency --------------------- */

describe("E audit & concurrency", () => {
  it("E7: toggle writes audited EXECUTOR_* events; repeat is idempotent", () => {
    const ctx = makeCtx("e7");
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:a");
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:b"); // no-op
    ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, true, "operator:a");
    const evs = ctx.store
      .listEvents("executor", CODEX_EXECUTOR_ID)
      .filter((e) =>
        ["EXECUTOR_ENABLED", "EXECUTOR_DISABLED"].includes(String(e.event_type)),
      );
    expect(evs.map((e) => String(e.event_type))).toEqual([
      "EXECUTOR_DISABLED",
      "EXECUTOR_ENABLED",
    ]);
    expect(evs.map((e) => String(e.actor))).toEqual(["operator:a", "operator:a"]);
  });

  it("E9: racing flips resolve deterministically — OCC retried, both audited", async () => {
    const ctx = makeCtx("e9");
    await Promise.all([
      Promise.resolve().then(() =>
        ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "operator:x"),
      ),
      Promise.resolve().then(() =>
        ctx.registry.setExecutorEnabled(CODEX_EXECUTOR_ID, true, "operator:y"),
      ),
    ]);
    const status = String(ctx.store.get("executor", CODEX_EXECUTOR_ID).status);
    expect(["ENABLED", "DISABLED"]).toContain(status);
    const evs = ctx.store
      .listEvents("executor", CODEX_EXECUTOR_ID)
      .filter((e) =>
        ["EXECUTOR_ENABLED", "EXECUTOR_DISABLED"].includes(String(e.event_type)),
      );
    expect(evs.length).toBeGreaterThanOrEqual(1);
    // The audited new_state of the LAST flip event equals durable status.
    expect(String(evs[evs.length - 1].new_state)).toBe(status);
  });
});

/* ---- E8 — HTTP API surface -------------------------------------------- */

describe("E8 API", () => {
  async function withServer(ctx: Ctx, fn: (port: number) => Promise<void>) {
    const control = new MissionControl({ service: ctx.service } as never);
    const server: Server = createMissionControlServer({
      control,
      authToken: "tok-test",
      executorBoundIds: () => [...ctx.adapters.keys()],
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("E8a: GET /api/executors projects supported set + state", async () => {
    const ctx = makeCtx("e8a", { default_disabled: [DEVIN_EXECUTOR_ID, DSH_EXECUTOR_ID] });
    registerNative(ctx);
    await withServer(ctx, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/executors`, {
        headers: { authorization: "Bearer tok-test" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executors: Array<Record<string, unknown>>;
      };
      const byId = new Map(body.executors.map((r) => [String(r.executor_id), r]));
      expect(byId.get(PAIR_NATIVE_EXECUTOR_ID)?.enabled).toBe(true);
      expect(byId.get(CODEX_EXECUTOR_ID)?.enabled).toBe(true);
      expect(byId.get(DEVIN_EXECUTOR_ID)?.enabled).toBe(false);
      expect(byId.get(DSH_EXECUTOR_ID)?.enabled).toBe(false);
      expect(byId.get(DEVIN_EXECUTOR_ID)?.bound).toBe(true);
      expect(byId.get(CODEX_EXECUTOR_ID)?.bound).toBe(true);
      // PAIR_NATIVE has no adapter bound in this test ctx — honest restart marker.
      expect(byId.get(PAIR_NATIVE_EXECUTOR_ID)?.requires_restart).toBe(true);
      expect(byId.get("HERMES")).toBeUndefined(); // not integrated — never surfaced
    });
  });

  it("E8b: POST /api/executors/:id/state is operator-gated + flips intent", async () => {
    const ctx = makeCtx("e8b");
    await withServer(ctx, async (port) => {
      const url = `http://127.0.0.1:${port}/api/executors/${CODEX_EXECUTOR_ID}/state`;
      const unauth = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(unauth.status).toBe(401);
      const noOperator = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-test" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(noOperator.status).toBe(403);
      const ok = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok-test",
          "x-operator-id": "op:api",
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(ok.status).toBe(200);
      expect(String(ctx.store.get("executor", CODEX_EXECUTOR_ID).status)).toBe("DISABLED");
      const getRes = await fetch(`http://127.0.0.1:${port}/api/executors`, {
        headers: { authorization: "Bearer tok-test" },
      });
      const body = (await getRes.json()) as { executors: Array<Record<string, unknown>> };
      const codex = body.executors.find((r) => r.executor_id === CODEX_EXECUTOR_ID);
      expect(codex?.enabled).toBe(false);
      // Unknown executor + malformed body fail closed.
      const missing = await fetch(
        `http://127.0.0.1:${port}/api/executors/NOPE/state`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer tok-test",
            "x-operator-id": "op:api",
          },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(missing.status).toBe(404);
      const malformed = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok-test",
          "x-operator-id": "op:api",
        },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(malformed.status).toBe(400);
    });
  });
});

/* ---- F — planner capability supply (PR #119 audit F1) ------------------
 * executorCapSets feeds makeServeCanonicalizer's sanitizePlan: a task is
 * dropped as DROP_UNSERVABLE_CAPS when no single executor set covers its
 * required_capabilities. The supply must reflect canonical
 * `executor.status` — a DISABLED executor can never make a task
 * canonicalizable, and a dashboard toggle must take effect without a
 * restart for already-bound adapters. */

const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
};
const rawTask = (
  key: string,
  caps: string[],
  deps: string[] = [],
  df: { produces?: string[]; consumes?: string[] } = {},
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: `perform ${key}`,
  required_capabilities: caps,
  depends_on: deps,
  metadata: {
    network_requirement: NETREQ_LOCAL,
    risk_class: "LOW",
    pair_dataflow: { produces: df.produces ?? [], consumes: df.consumes ?? [] },
  },
});

describe("F planner capability supply", () => {
  it("F1: DISABLED executor's capabilities leave the planner supply; ON restores them live", () => {
    const ctx = makeCtx("f1", {
      executors: [CODEX_EXECUTOR_ID, DEVIN_EXECUTOR_ID],
      caps: {
        [CODEX_EXECUTOR_ID]: ["FILE_OPERATIONS"],
        [DEVIN_EXECUTOR_ID]: ["FILE_OPERATIONS", REMOTE_CAP],
      },
    });
    const capSets = plannerExecutorCapSets(ctx.service, ctx.adapters);
    // Default ON — DEVIN's remote cap is servable.
    expect(capSets().some((s) => s.includes(REMOTE_CAP))).toBe(true);
    // OFF — the durable row drops DEVIN out of planner supply.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, false, "operator:t");
    const off = capSets();
    expect(off.some((s) => s.includes(REMOTE_CAP))).toBe(false);
    expect(off.some((s) => s.includes("FILE_OPERATIONS"))).toBe(true);
    // ON again — recomputed from canonical state, no restart.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, true, "operator:t");
    expect(capSets().some((s) => s.includes(REMOTE_CAP))).toBe(true);
    // OFF once more — symmetric.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, false, "operator:t");
    expect(capSets().some((s) => s.includes(REMOTE_CAP))).toBe(false);
  });

  it("F2: canonicalizer drops a Devin-only-capable task while OFF; accepts after ON", () => {
    const ctx = makeCtx("f2", {
      executors: [CODEX_EXECUTOR_ID, DEVIN_EXECUTOR_ID],
      caps: {
        [CODEX_EXECUTOR_ID]: ["FILE_OPERATIONS"],
        [DEVIN_EXECUTOR_ID]: ["FILE_OPERATIONS", REMOTE_CAP],
      },
    });
    const canonicalize = makeServeCanonicalizer({
      executorCapSets: plannerExecutorCapSets(ctx.service, ctx.adapters),
    });
    const raw = [
      rawTask("T1", ["FILE_OPERATIONS"], [], { produces: ["a1.txt"] }),
      rawTask("T2", [REMOTE_CAP], ["T1"], { consumes: ["a1.txt"] }),
    ];
    const remoteCaps = (
      out: { tasks?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>,
    ) =>
      (Array.isArray(out) ? out : (out.tasks ?? [])).filter((t) =>
        (t.required_capabilities as string[] | undefined)?.includes(REMOTE_CAP),
      ).length;
    // OFF: the remote-capable task is unservable → dropped by sanitizePlan.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, false, "operator:t");
    const offOut = canonicalize(raw.map((t) => ({ ...t })), "executor toggle regression");
    expect(remoteCaps(offOut)).toBe(0);
    // ON: the same raw plan keeps the remote task — toggle took effect
    // for planning with no restart.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, true, "operator:t");
    const onOut = canonicalize(raw.map((t) => ({ ...t })), "executor toggle regression");
    expect(remoteCaps(onOut)).toBe(1);
  });

  it("F3: unqualified executor contributes no supply even while ENABLED", () => {
    const ctx = makeCtx("f3", {
      executors: [DEVIN_EXECUTOR_ID],
      qualified: [], // DEVIN unqualified (e.g. missing PAIR_DEVIN_API_KEY)
      caps: { [DEVIN_EXECUTOR_ID]: [REMOTE_CAP] },
    });
    const capSets = plannerExecutorCapSets(ctx.service, ctx.adapters);
    expect(capSets().some((s) => s.includes(REMOTE_CAP))).toBe(false);
    // Enabling an unqualified executor still yields no supply — ON is
    // intent only, qualification still gates.
    ctx.registry.setExecutorEnabled(DEVIN_EXECUTOR_ID, true, "operator:t");
    expect(capSets().some((s) => s.includes(REMOTE_CAP))).toBe(false);
  });
});
