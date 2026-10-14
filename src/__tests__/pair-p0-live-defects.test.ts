/**
 * P0 LIVE-OPERATIONS DEFECTS — three remaining defects from the
 * live-operations handoff:
 *
 * F1 — Orphan executor_execution rows under terminal missions are never
 *     reconciled: planRestartRecovery scans only NON-terminal missions,
 *     abort leaves in-flight executions unresolved (documented), and no
 *     other sweep exists. Non-terminal rows consume CapabilityRouter
 *     capacity forever (CAPACITY_EXHAUSTED). Canonical fix: the recovery
 *     sweep also settles orphans — authoritative outcomes (CONFIRMED_*)
 *     mark the row durably settled via terminal_outcome; still-RUNNING /
 *     UNKNOWN_SIDE_EFFECT_STATE keep the slot reserved (never blind).
 *     Capacity counters honor terminal_outcome + canonical TIMEOUT.
 *
 * F2 — Explicit empty PAIR_DSH_FALLBACK_ROUTE inserted "" into
 *     DSH_ROUTES; strict configured-route resolution then threw
 *     FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED at boot. Canonical fix:
 *     composeConfiguredRoleRoutes() drops empty/whitespace candidates
 *     and dedupes without reordering; malformed non-empty routes still
 *     fail closed at resolution.
 *
 * F3 — Objective budget 0/0 (unset ceiling) was classified
 *     OBJECTIVE_BUDGET_EXHAUSTED. Canonical semantics (P15.7 budgetView
 *     contract): ceiling=0 is ZERO_BUDGET — a hard bound, NOT
 *     exhaustion, NEVER uncapped. The operating loop now returns the
 *     truthful OBJECTIVE_ZERO_BUDGET outcome and keeps blocking new
 *     work; positive caps still exhaust at consumed>=ceiling; the
 *     ledger's FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED is untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  CapabilityRouter,
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
  composeConfiguredRoleRoutes,
  resolveConfiguredModelRoleRoute,
  IntegrityError,
  utcnow,
} from "../pair/index.js";
import { canonicallyTerminateMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p0ld-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** Scripted adapter with a controllable observe() outcome per
 *  execution — the live-state seam reconcile() consults. */
class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  observeState: Record<string, string> = {};
  cancelled: string[] = [];
  constructor(id: string) {
    this.executor_id = id;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS"] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    return {
      execution_id: `EXEC_${this.executor_id}_d`,
      status: "RUNNING",
      run_root: null,
      workspace: task.workspace,
    };
  }
  observe(executionId: string) {
    const s = this.observeState[executionId];
    return s ? { status: s } : { status: "NOT_FOUND" };
  }
  cancel(executionId: string) {
    this.cancelled.push(executionId);
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return {
      execution_id: executionId,
      status: this.observeState[executionId] ?? "FAILED",
      artifacts: [],
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
  store: PairEvidenceStore;
  service: PairControlPlane;
  supervisor: MissionSupervisor;
  recovery: RecoveryController;
  recon: ReconciliationService;
  capabilityRouter: CapabilityRouter;
  adapters: Map<string, ExecutorAdapter>;
  adapter: ScriptedAdapter;
  projectId: string;
}

const EXEC_ID = "EX_A";

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const adapter = new ScriptedAdapter(EXEC_ID);
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  // max_concurrency 1 — a single orphan exhausts the capacity gate.
  registry.register({
    executor_id: EXEC_ID,
    executor_type: "EXTERNAL",
    capabilities: ["FILE_OPERATIONS"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: 1,
    },
  });
  service.routes.registerRoute({
    route_id: "RTE_EX_A",
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: ["FILE_OPERATIONS"],
    priority: 50,
    executor_hint: EXEC_ID,
  });
  service.routes.registerBinding({
    executor_id: EXEC_ID,
    route_id: "RTE_EX_A",
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  adapters.set(EXEC_ID, adapter);
  const runtime = new MissionRuntime({
    service,
    gate,
    router,
    adapters,
    scheduler,
    approvals,
    reconciliation: recon,
    recovery,
    planner: () => ({
      tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
    }),
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability,
    planner: () => ({ tasks: [] }),
  });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: dir });
  const capabilityRouter = new CapabilityRouter(service, registry);
  return {
    dir, store, service, supervisor, recovery, recon,
    capabilityRouter, adapters, adapter, projectId: String(project.project_id),
  };
}

/** Persist a terminal mission (canonical transitions) plus a non-terminal
 *  executor_execution row — the exact orphan shape abort/crash leaves:
 *  runtime ABORTED, mission FAILED, execution still RUNNING. */
function seedOrphan(
  ctx: Ctx,
  opts: { execState?: string; runRoot?: string | null; observe?: string } = {},
): { missionId: string; execId: string } {
  const m = ctx.service.createMission({
    project_id: ctx.projectId,
    goal: "orphan carrier",
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  const missionId = String(m.mission_id);
  const n = counter++;
  const gtId = `GT_${n}`;
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId,
    mission_id: missionId,
    executor_id: EXEC_ID,
    governance_state: "DISPATCH_AUTHORIZED",
    version: 0,
  }, 0);
  const execId = `EXE_orphan_${n}`;
  ctx.store.put("executor_execution", execId, {
    execution_id: execId,
    governed_task_id: gtId,
    mission_id: missionId,
    task_id: `TSK_${counter}`,
    executor_id: EXEC_ID,
    execution_state: opts.execState ?? "RUNNING",
    dispatch_timestamp: utcnow(),
    run_root: opts.runRoot ?? null,
    version: 0,
  }, 0);
  if (opts.observe) ctx.adapter.observeState[execId] = opts.observe;
  canonicallyTerminateMission(ctx.store, ctx.service, missionId, "FAILED", {
    runtimeState: "ABORTED",
  });
  return { missionId, execId };
}

/** DISPATCH-mode capacity decision for EX_A — the router's step-10
 *  concurrency gate is the authority the leak corrupts. */
function dispatchCapacityReasons(ctx: Ctx): string[] {
  const d = ctx.capabilityRouter.route(
    {
      task_id: "TSK_probe",
      required_capabilities: ["FILE_OPERATIONS"],
      metadata: { permissions: ["READ"] },
    },
    { mode: "DISPATCH", adapters: ctx.adapters, persist: false },
  );
  const rejected = (d.rejected_executors as Array<Record<string, unknown>>) ?? [];
  const ex = rejected.find((r) => String(r.executor_id) === EXEC_ID);
  return ex ? (ex.reasons as string[]).map(String) : [];
}

/* ============================ F1 — orphan capacity ============================ */

describe("F1 — orphan executions under terminal missions", () => {
  it("F1.a repro: non-terminal execution under FAILED mission consumes capacity; restart sweep settles confirmed-terminal orphan", () => {
    const ctx = makeCtx("f1a");
    const { execId } = seedOrphan(ctx, { observe: "COMPLETED" });
    // Leak visible at the canonical capacity gate: the orphan holds the
    // executor's only slot.
    expect(dispatchCapacityReasons(ctx)).toContain("CAPACITY_EXHAUSTED:1/1");
    ctx.supervisor.resume();
    const e = ctx.store.get("executor_execution", execId);
    expect(String(e.terminal_outcome)).toBe("RECONCILED_CONFIRMED_COMPLETED");
    expect(String(e.settled_receipt_id)).toMatch(/^REC_/);
    expect(dispatchCapacityReasons(ctx)).not.toContain("CAPACITY_EXHAUSTED:1/1");
  });

  it("F1.b still-running remote execution keeps its slot — no premature reuse", () => {
    const ctx = makeCtx("f1b");
    const { execId } = seedOrphan(ctx, { observe: "RUNNING" });
    ctx.supervisor.resume();
    const e = ctx.store.get("executor_execution", execId);
    expect(e.terminal_outcome ?? null).toBeNull();
    expect(dispatchCapacityReasons(ctx)).toContain("CAPACITY_EXHAUSTED:1/1");
  });

  it("F1.c unknown side-effect state never auto-settles — slot stays reserved, durable receipt exists", () => {
    const ctx = makeCtx("f1c");
    const { execId } = seedOrphan(ctx, {
      observe: "NOT_FOUND", // dead process, no terminal proof
      runRoot: "run/exe_orphan", // side effects may have landed
    });
    ctx.supervisor.resume();
    const e = ctx.store.get("executor_execution", execId);
    expect(e.terminal_outcome ?? null).toBeNull();
    expect(dispatchCapacityReasons(ctx)).toContain("CAPACITY_EXHAUSTED:1/1");
    const receipts = ctx.store.list("reconciliation_receipt");
    expect(receipts.some((r) => String(r.outcome) === "UNKNOWN_SIDE_EFFECT_STATE")).toBe(true);
  });

  it("F1.d repeated sweep + restart is idempotent — settled once, receipts stable", () => {
    const ctx = makeCtx("f1d");
    const { execId } = seedOrphan(ctx, { observe: "FAILED" });
    ctx.supervisor.resume();
    ctx.supervisor.resume();
    ctx.supervisor.tick();
    const e = ctx.store.get("executor_execution", execId);
    expect(String(e.terminal_outcome)).toBe("RECONCILED_CONFIRMED_FAILED");
    const settleEvents = ctx.store
      .listEvents("executor_execution", execId)
      .filter((ev) => String(ev.event_type) === "EXECUTION_ORPHAN_SETTLED");
    expect(settleEvents.length).toBe(1);
    expect(dispatchCapacityReasons(ctx)).not.toContain("CAPACITY_EXHAUSTED:1/1");
  });

  it("F1.e runtime tick (not only restart) discovers and settles orphans", () => {
    const ctx = makeCtx("f1e");
    const { execId } = seedOrphan(ctx, { observe: "COMPLETED" });
    ctx.supervisor.start();
    ctx.supervisor.tick();
    const e = ctx.store.get("executor_execution", execId);
    expect(String(e.terminal_outcome)).toBe("RECONCILED_CONFIRMED_COMPLETED");
    expect(dispatchCapacityReasons(ctx)).not.toContain("CAPACITY_EXHAUSTED:1/1");
  });

  it("F1.f operator-acknowledged terminal_outcome frees capacity; TIMEOUT is canonical-terminal", () => {
    const ctx = makeCtx("f1f");
    const { execId } = seedOrphan(ctx);
    // Operator no-replay acknowledgment: durably settled, state stays UNKNOWN.
    const e = ctx.store.get("executor_execution", execId);
    e.execution_state = "UNKNOWN";
    e.terminal_outcome = "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY";
    ctx.store.put("executor_execution", execId, e, Number(e.version));
    const { execId: timeoutId } = seedOrphan(ctx, { execState: "TIMEOUT" });
    const t = ctx.store.get("executor_execution", timeoutId);
    expect(String(t.execution_state)).toBe("TIMEOUT");
    expect(dispatchCapacityReasons(ctx).some((r) => r.startsWith("CAPACITY_EXHAUSTED"))).toBe(false);
  });
});

/* ================= F2 — empty DSH fallback route composition ================= */

describe("F2 — configured DSH route composition", () => {
  it("F2.a empty/whitespace fallback is disabled, primary preserved", () => {
    expect(
      composeConfiguredRoleRoutes({ primary: "cloudflare:@cf/x", fallback: "" }),
    ).toEqual(["cloudflare:@cf/x"]);
    expect(
      composeConfiguredRoleRoutes({ primary: "cloudflare:@cf/x", fallback: "   " }),
    ).toEqual(["cloudflare:@cf/x"]);
  });

  it("F2.b absent fallback keeps the caller's documented default", () => {
    // The script applies ?? "<default>" before composition — the helper
    // sees the resolved default and keeps it.
    const routes = composeConfiguredRoleRoutes({
      primary: "cloudflare:@cf/x",
      fallback: "groq:openai/gpt-oss-20b",
    });
    expect(routes).toEqual(["cloudflare:@cf/x", "groq:openai/gpt-oss-20b"]);
  });

  it("F2.c duplicate fallback dedupes without reordering; extras dedupe", () => {
    expect(
      composeConfiguredRoleRoutes({
        primary: "p:m1", fallback: "p:m1", extras: "p:m2, ,p:m1,p:m3",
      }),
    ).toEqual(["p:m1", "p:m2", "p:m3"]);
  });

  it("F2.d malformed non-empty candidates still reach strict resolution and fail closed", () => {
    const routes = composeConfiguredRoleRoutes({
      primary: "p:m1", fallback: "no-colon",
    });
    expect(routes).toEqual(["p:m1", "no-colon"]);
    expect(() =>
      resolveConfiguredModelRoleRoute(() => null, {
        route: "no-colon", role: "DSH_EXECUTION",
      }),
    ).toThrowError(IntegrityError);
    expect(() =>
      resolveConfiguredModelRoleRoute(() => null, {
        route: "", role: "DSH_EXECUTION",
      }),
    ).toThrowError(/FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED/);
  });
});
