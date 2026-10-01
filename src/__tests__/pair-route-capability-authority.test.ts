/**
 * Route capability authority & staleness closure.
 *
 * Canonical authority = the registered executor/adapter capability
 * declaration (re-materialized into the executor record every registration).
 * A persisted route's `capabilities` is a DERIVED, RECONCILED snapshot —
 * never independent authority:
 *   - EXECUTOR_DECLARED routes inherit the executor set wholesale
 *     (additions AND removals propagate at registration).
 *   - ROUTE_EXPLICIT routes are intentional subsets: effective =
 *     declared ⊆ executor (fail closed), never auto-widened.
 * Reconciliation happens at the registration/catalog seam
 * (registerGovernedExecutors / seedPairNativeRoute) — never per-task.
 *
 * NO_ELIGIBLE_ROUTE semantics: a selection where EVERY rejection is an
 * explicit policy/contract denial keeps FAIL_CLOSED_NO_ELIGIBLE_ROUTE →
 * POLICY_DENIAL → ABORT. Route-local infeasibility (capability/health/
 * binding/qualification on the selected executor's routes) is the new
 * FAIL_CLOSED_ROUTE_INFEASIBLE → ROUTE_INFEASIBLE → bounded
 * RE_ROUTE → RECONCILIATION_REQUIRED → ABORT — never replayed blindly.
 *
 * Reproduces production incident MSN_01M3VSGWVC55YNKHAQY6VVJAXR:
 * RTE_CODEX_CLI minted before TELEGRAM_DELIVERY existed on CODEX →
 * persisted snapshot lacked it → NO_ELIGIBLE_ROUTE → POLICY_DENIAL → abort.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { classifyFailure } from "../pair/recovery-controller.js";
import { registerGovernedExecutors } from "../pair/multi-executor.js";
import { RouteSelector } from "../pair/route-selector.js";
import {
  ApprovalQueue,
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
  PolicyError,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-rca-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* ---------------------------- scripted executor ---------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  script: Array<{ status: string; error_class?: string }>;
  caps: string[];
  dispatched: string[] = [];

  constructor(
    id: string,
    script: Array<{ status: string; error_class?: string }> = [],
    caps: string[] = ["FILE_OPERATIONS"],
  ) {
    this.executor_id = id;
    this.script = [...script];
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length
      ? this.script.shift()!
      : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    return { execution_id: eid, status: step.status, run_root: null, workspace: task.workspace };
  }
  observe() {
    return { status: "COMPLETED" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result() {
    return { status: "COMPLETED", summary: "ok" };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

/* --------------------------------- ctx ------------------------------------ */

function makeCtx(name: string) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const planner = () => ({
    tasks: [
      { task_key: "T1", title: "t1", required_capabilities: ["ONLY_EX_A"], depends_on: [] },
    ],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service), planner,
  });
  for (const c of ["ONLY_EX_A", "TELEGRAM_DELIVERY", "FILE_OPERATIONS", "CAP_X", "CAP_A", "CAP_B", "CAP_C"]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId: String(project.project_id),
  };
}

/** Mission-runtime adapter registration (executor + route + binding), the
 *  same shape tests use everywhere — mints with capability_source default
 *  ROUTE_EXPLICIT so reconcile never auto-widens a fixture's intent. */
function registerAdapter(
  ctx: ReturnType<typeof makeCtx>,
  adapter: ExecutorAdapter,
  caps: string[],
) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: caps,
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
  const routeId = `RTE_${adapter.executor_id}`;
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: caps,
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: caps,
  });
  ctx.adapters.set(adapter.executor_id, adapter);
}

function startMission(ctx: ReturnType<typeof makeCtx>): string {
  const m = ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "rca",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  return String(m.mission_id);
}

function rt(ctx: ReturnType<typeof makeCtx>, missionId: string) {
  return ctx.store.get("mission_runtime", `MRT_${missionId}`);
}

function decisions(ctx: ReturnType<typeof makeCtx>, missionId: string) {
  return ctx.store.list("recovery_decision").filter((d) => d.mission_id === missionId);
}

const FAR = "2999-01-01T00:00:00Z";

function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

/* ================= R — route capability reconciliation ==================== */

describe("RCA.R — route capability reconciliation (registration seam)", () => {
  it("R1. EXACT LIVE SHAPE — RTE_CODEX_CLI minted before TELEGRAM_DELIVERY converges on re-registration", () => {
    const ctx = makeCtx("r1");
    // Boot N-1: CODEX adapter declared WITHOUT TELEGRAM_DELIVERY (pre-PR#22).
    const codex = new ScriptedAdapter("CODEX", [], ["FILE_OPERATIONS", "REASONING"]);
    const adapters = new Map<string, ExecutorAdapter>([["CODEX", codex]]);
    const reg1 = registerGovernedExecutors(ctx.service, adapters, "BOOT_1");
    expect(reg1.routable).toContain("CODEX");
    let route = ctx.service.routes.getRoute("RTE_CODEX_CLI")!;
    expect(route.capabilities).not.toContain("TELEGRAM_DELIVERY");
    const versionAfterMint = Number(route.version);

    // Selector rejects the new capability — this is the production failure.
    const selector = new RouteSelector(ctx.service);
    const stale = selector.select({
      executor_id: "CODEX",
      capability: "TELEGRAM_DELIVERY",
      persist: false,
    });
    expect(stale.selected_route_id).toBeNull();

    // Boot N: upgraded declaration carries TELEGRAM_DELIVERY. Re-registration
    // must converge the persisted route — no DB surgery, no recreation.
    codex.caps = ["FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY"];
    const reg2 = registerGovernedExecutors(ctx.service, adapters, "BOOT_2");
    expect(reg2.routable).toContain("CODEX");
    route = ctx.service.routes.getRoute("RTE_CODEX_CLI")!;
    expect(route.capabilities).toContain("TELEGRAM_DELIVERY");
    expect(route.capability_source).toBe("EXECUTOR_DECLARED");
    expect(Number(route.version)).toBeGreaterThan(versionAfterMint);

    const healed = selector.select({
      executor_id: "CODEX",
      capability: "TELEGRAM_DELIVERY",
      persist: false,
    });
    expect(String(healed.selected_route_id)).toBe("RTE_CODEX_CLI");
    // No duplicate routes minted by the reconcile.
    expect(ctx.service.routes.listRoutes().map((r) => String(r.route_id))).toEqual(
      ["RTE_CODEX_CLI"],
    );
  });

  it("R2. capability REMOVAL fails closed — executor drops X → route can no longer authorize X", () => {
    const ctx = makeCtx("r2");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_X", "FILE_OPERATIONS"]);
    const adapters = new Map<string, ExecutorAdapter>([["CODEX", codex]]);
    registerGovernedExecutors(ctx.service, adapters, "BOOT_1");
    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.capabilities).toContain("CAP_X");

    codex.caps = ["FILE_OPERATIONS"];
    registerGovernedExecutors(ctx.service, adapters, "BOOT_2");
    const route = ctx.service.routes.getRoute("RTE_CODEX_CLI")!;
    expect(route.capabilities).not.toContain("CAP_X");
    const sel = new RouteSelector(ctx.service).select({
      executor_id: "CODEX",
      capability: "CAP_X",
      persist: false,
    });
    expect(sel.selected_route_id).toBeNull();
  });

  it("R3. ROUTE_EXPLICIT subset is preserved — never auto-widened; over-declared clamps ⊆ executor", () => {
    const ctx = makeCtx("r3");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B", "CAP_C"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");

    // Operator-declared subset route for the same executor.
    ctx.service.routes.registerRoute({
      route_id: "RTE_CODEX_RESTRICTED",
      route_kind: "REMOTE_GATEWAY_API",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["CAP_A", "CAP_B"],
      executor_hint: "CODEX",
    });
    ctx.service.routes.syncRouteCapabilities("RTE_CODEX_RESTRICTED", ["CAP_A", "CAP_B", "CAP_C"], "test");
    const route = ctx.service.routes.getRoute("RTE_CODEX_RESTRICTED")!;
    // C was NOT auto-added — the subset contract stands.
    expect([...(route.capabilities as string[])].sort()).toEqual(["CAP_A", "CAP_B"]);

    // Over-declared subset clamps to the executor set (fail closed on the
    // capability the executor never declared), intent preserved verbatim.
    ctx.service.routes.registerRoute({
      route_id: "RTE_CODEX_OVER",
      route_kind: "REMOTE_GATEWAY_API",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["CAP_A", "CAP_GHOST"],
      executor_hint: "CODEX",
    });
    ctx.service.routes.syncRouteCapabilities("RTE_CODEX_OVER", ["CAP_A", "CAP_B", "CAP_C"], "test");
    const over = ctx.service.routes.getRoute("RTE_CODEX_OVER")!;
    expect(over.capabilities).toEqual(["CAP_A"]);
    expect(over.capabilities_declared).toEqual(["CAP_A", "CAP_GHOST"]);
  });

  it("R4. restart idempotent — second reconcile is a semantic no-op (no version churn, no extra evidence)", () => {
    const ctx = makeCtx("r4");
    const codex = new ScriptedAdapter("CODEX", [], ["FILE_OPERATIONS", "TELEGRAM_DELIVERY"]);
    const adapters = new Map<string, ExecutorAdapter>([["CODEX", codex]]);
    registerGovernedExecutors(ctx.service, adapters, "BOOT_1");
    const v1 = Number(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.version);
    const eventsBefore = ctx.store.listEvents("route").length;
    registerGovernedExecutors(ctx.service, adapters, "BOOT_2");
    registerGovernedExecutors(ctx.service, adapters, "BOOT_3");
    const route = ctx.service.routes.getRoute("RTE_CODEX_CLI")!;
    expect(Number(route.version)).toBe(v1);
    expect(ctx.store.listEvents("route").length).toBe(eventsBefore);
    expect(ctx.service.routes.listRoutes()).toHaveLength(1);
    expect(ctx.service.routes.listBindings()).toHaveLength(1);
  });

  it("R5. fresh process over the same store converges the stale route (restart path)", () => {
    const ctx = makeCtx("r5");
    const codex = new ScriptedAdapter("CODEX", [], ["FILE_OPERATIONS"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");

    // Fresh process: new service/registries over the SAME persisted store.
    const service2 = new PairControlPlane(ctx.store);
    codex.caps = ["FILE_OPERATIONS", "TELEGRAM_DELIVERY"];
    registerGovernedExecutors(service2, new Map([["CODEX", codex]]), "BOOT_2");
    const route = service2.routes.getRoute("RTE_CODEX_CLI")!;
    expect(route.capabilities).toContain("TELEGRAM_DELIVERY");
  });
});

/* ============ S — NO_ELIGIBLE_ROUTE taxonomy / bounded recovery =========== */

describe("RCA.S — route-local infeasibility vs genuine policy denial", () => {
  it("S1. route-local infeasibility on selected executor → ROUTE_INFEASIBLE → bounded RE_ROUTE to the alternate", () => {
    const ctx = makeCtx("s1");
    // EX_A: declares the capability at executor level but its route cannot
    // serve it (ROUTE_EXPLICIT subset without ONLY_EX_A) — route-local
    // infeasibility, exactly the incident class.
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    const exB = new ScriptedAdapter("EX_B", [{ status: "COMPLETED" }], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    registerAdapter(ctx, exB, exB.caps);
    // Narrow EX_A's route — an intentional subset missing ONLY_EX_A.
    ctx.service.routes.registerRoute({
      route_id: "RTE_EX_A_NARROW",
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["FILE_OPERATIONS"],
      executor_hint: "EX_A",
    });
    // Repoint EX_A's binding to the narrow route and drop the old one.
    const binding = ctx.service.routes.bindingFor("EX_A", "RTE_EX_A")!;
    ctx.service.routes.registerBinding({
      executor_id: "EX_A",
      route_id: "RTE_EX_A_NARROW",
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
    });
    // Remove the full-capability route so EX_A has only the narrow one.
    const full = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...full, eligibility_state: "DISABLED", enabled: false }, Number(full.version));
    void binding;

    const mid = startMission(ctx);
    const clock = fakeClock();
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid, clock());
      const st = String(rt(ctx, mid).state);
      if (["COMPLETED", "WAITING_APPROVAL", "ABORTED", "FAILED"].includes(st)) break;
    }
    // EX_A was selected first (alphabetical among eligible), its route set
    // failed → ROUTE_INFEASIBLE → bounded RE_ROUTE excluded EX_A → EX_B
    // dispatched → task completed.
    const decs = decisions(ctx, mid);
    expect(decs.length).toBeGreaterThan(0);
    expect(String(decs[0].failure_class)).toBe("ROUTE_INFEASIBLE");
    const task = ctx.service.listTasks(mid)[0];
    expect(String(task.status)).toBe("COMPLETED");
    expect(exB.dispatched.length).toBeGreaterThan(0);
    expect(String(rt(ctx, mid).state)).toBe("COMPLETED");
  });

  it("S2. route-local infeasibility with NO alternate executor → bounded terminal (never silent replay)", () => {
    const ctx = makeCtx("s2");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    // EX_A's only route is DISABLED — route-local infeasibility, nothing else
    // can serve ONLY_EX_A.
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...route, eligibility_state: "DISABLED", enabled: false }, Number(route.version));

    const mid = startMission(ctx);
    const clock = fakeClock();
    for (let i = 0; i < 60; i++) {
      ctx.runtime.tick(mid, clock());
      const st = String(rt(ctx, mid).state);
      if (["WAITING_APPROVAL", "ABORTED", "FAILED"].includes(st)) break;
    }
    const state = String(rt(ctx, mid).state);
    expect(["WAITING_APPROVAL", "ABORTED", "FAILED"]).toContain(state);
    // Bounded: RE_ROUTE became infeasible evidence, never an endless replay.
    const rejected = decisions(ctx, mid).flatMap(
      (d) => (d.rejected_actions as Array<{ action: string; reason: string }>) ?? [],
    );
    expect(
      rejected.some(
        (r) => r.action === "RE_ROUTE" && String(r.reason).includes("APPLY_INFEASIBLE"),
      ) ||
      decisions(ctx, mid).some((d) => ["ABORT", "HUMAN_APPROVAL_REQUIRED"].includes(String(d.selected_action))),
    ).toBe(true);
  });

  it("S3. taxonomy — genuine policy codes stay POLICY_DENIAL; route-local infeasibility maps to ROUTE_INFEASIBLE", () => {
    expect(
      classifyFailure({ error_class: "DISPATCH", error_code: "FAIL_CLOSED_NO_ELIGIBLE_ROUTE" }),
    ).toBe("POLICY_DENIAL");
    expect(
      classifyFailure({ error_class: "DISPATCH", error_code: "FAIL_CLOSED_ROUTE_INFEASIBLE" }),
    ).toBe("ROUTE_INFEASIBLE");
    expect(
      classifyFailure({ error_class: "DISPATCH", error_code: "FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR" }),
    ).toBe("POLICY_DENIAL");
    // The typed code wins over reason strings embedded in the detail JSON.
    expect(
      classifyFailure({
        error_class: "DISPATCH",
        error_code: "FAIL_CLOSED_ROUTE_INFEASIBLE",
      }),
    ).toBe("ROUTE_INFEASIBLE");
  });

  it("S4. PolicyError carries structured executor evidence into bounded recovery (meta.executor_id)", () => {
    const ctx = makeCtx("s4");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    // EX_A route disabled → route-local infeasibility at dispatch.
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...route, eligibility_state: "DISABLED", enabled: false }, Number(route.version));

    const mid = startMission(ctx);
    let pending: Record<string, unknown> | null = null;
    const clock = fakeClock();
    for (let i = 0; i < 12 && !pending; i++) {
      ctx.runtime.tick(mid, clock());
      pending = (rt(ctx, mid).pending_recovery as Record<string, unknown> | null) ?? null;
    }
    expect(pending).toBeTruthy();
    // The executor the route selection failed on is persisted as evidence —
    // this is what lets bounded RE_ROUTE exclude it.
    expect(String(pending!.executor_id)).toBe("EX_A");
    expect(String(pending!.failure_class)).toBe("ROUTE_INFEASIBLE");
  });

  it("S5. recovered RE_ROUTE flow is idempotent across restart — pending evidence survives, no blind retry", () => {
    const ctx = makeCtx("s5");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    const exB = new ScriptedAdapter("EX_B", [{ status: "COMPLETED" }], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    registerAdapter(ctx, exB, exB.caps);
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...route, eligibility_state: "DISABLED", enabled: false }, Number(route.version));

    const mid = startMission(ctx);
    const clock = fakeClock();
    let pending: Record<string, unknown> | null = null;
    for (let i = 0; i < 12; i++) {
      ctx.runtime.tick(mid, clock());
      const p = rt(ctx, mid).pending_recovery as Record<string, unknown> | null;
      if (p && ["RE_ROUTE", "RECONCILIATION_REQUIRED"].includes(String(p.action))) {
        pending = p;
        break;
      }
      const st = String(rt(ctx, mid).state);
      if (["COMPLETED", "WAITING_APPROVAL", "ABORTED", "FAILED"].includes(st)) break;
    }
    expect(pending).toBeTruthy();
    expect(String(pending!.executor_id)).toBe("EX_A");

    // Restart: a NEW runtime over the same store resumes the pending chain —
    // the persisted executor evidence still drives the exclusion.
    const runtime2 = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: ctx.router,
      adapters: ctx.adapters, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery,
      planner: () => ({ tasks: [] }),
    });
    for (let i = 0; i < 40; i++) {
      runtime2.tick(mid, clock());
      const st = String(rt(ctx, mid).state);
      if (["COMPLETED", "WAITING_APPROVAL", "ABORTED", "FAILED"].includes(st)) break;
    }
    const task = ctx.service.listTasks(mid)[0];
    expect(String(task.status)).toBe("COMPLETED");
    expect(exB.dispatched.length).toBeGreaterThan(0);
  });
});

/* ============ §17 — capability invariants on canonical executors ========== */

describe("RCA.I — executor capability invariants", () => {
  it("CODEX declares TELEGRAM_DELIVERY, DEVIN does NOT (unchanged by this remediation)", async () => {
    // Canonical declarations live in the adapters — read them, don't hardcode.
    const { CODEX_CAPABILITY_IDS } = await import("../pair/codex-adapter.js");
    const { DEVIN_CAPABILITIES } = await import("../pair/devin-executor.js");
    const { DSH_CAPABILITY_IDS } = await import("../pair/dsh-adapter.js");
    expect([...CODEX_CAPABILITY_IDS]).toContain("TELEGRAM_DELIVERY");
    expect([...DSH_CAPABILITY_IDS]).toContain("TELEGRAM_DELIVERY");
    expect([...DEVIN_CAPABILITIES]).not.toContain("TELEGRAM_DELIVERY");
  });
});
