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
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
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
  qualified = true;

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
    return { executor_id: this.executor_id, available: this.qualified, state: this.qualified ? "READY" : "DEGRADED" };
  }
  qualify() {
    return this.qualified
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["UNQUALIFIED"] };
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

  it("R3. BOOT LIFECYCLE — every bound route reconciles at registration, never manually", () => {
    const ctx = makeCtx("r3");
    // Boot N: executor declares [A,B,C]; an operator-declared subset route
    // RTE_CODEX_SUBSET declares [A,B] and binds CODEX.
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B", "CAP_C"]);
    const adapters = new Map<string, ExecutorAdapter>([["CODEX", codex]]);
    registerGovernedExecutors(ctx.service, adapters, "BOOT_N");
    ctx.service.routes.registerRoute({
      route_id: "RTE_CODEX_SUBSET",
      route_kind: "REMOTE_GATEWAY_API",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["CAP_A", "CAP_B"],
      executor_hint: "CODEX",
    });
    ctx.service.routes.registerBinding({
      executor_id: "CODEX",
      route_id: "RTE_CODEX_SUBSET",
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
    });

    // Boot N+1: executor drops CAP_B (now [A,C]). Registration alone must
    // reconcile every route bound to CODEX — no manual syncRouteCapabilities.
    codex.caps = ["CAP_A", "CAP_C"];
    registerGovernedExecutors(ctx.service, adapters, "BOOT_N1");
    const sub = ctx.service.routes.getRoute("RTE_CODEX_SUBSET")!;
    expect(sub.capabilities_declared).toEqual(["CAP_A", "CAP_B"]);
    expect(sub.capabilities).toEqual(["CAP_A"]); // B removed fail-closed, C NOT added
    const versionAfterHeal = Number(sub.version);
    const eventsAfterHeal = ctx.store
      .listEvents("route")
      .filter((e) => String(e.entity_id) === "RTE_CODEX_SUBSET").length;

    // Boot N+2 same declaration — idempotent: no version churn, no new event.
    registerGovernedExecutors(ctx.service, adapters, "BOOT_N2");
    const sub2 = ctx.service.routes.getRoute("RTE_CODEX_SUBSET")!;
    expect(Number(sub2.version)).toBe(versionAfterHeal);
    expect(
      ctx.store.listEvents("route").filter((e) => String(e.entity_id) === "RTE_CODEX_SUBSET").length,
    ).toBe(eventsAfterHeal);

    // A route bound to a DIFFERENT executor is untouched by CODEX's sync.
    const exOther = new ScriptedAdapter("EX_OTHER", [], ["CAP_A"]);
    registerAdapter(ctx, exOther, exOther.caps);
    const otherBefore = ctx.service.routes.getRoute("RTE_EX_OTHER")!;
    codex.caps = ["CAP_A", "CAP_B", "CAP_C", "CAP_X"];
    registerGovernedExecutors(ctx.service, adapters, "BOOT_N3");
    const otherAfter = ctx.service.routes.getRoute("RTE_EX_OTHER")!;
    expect(otherAfter.capabilities).toEqual(otherBefore.capabilities);
    expect(Number(otherAfter.version)).toBe(Number(otherBefore.version));
  });

  it("R3b. ROUTE_EXPLICIT over-declare clamps ⊆ executor; declared intent preserved verbatim", () => {
    const ctx = makeCtx("r3b");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B", "CAP_C"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
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
    ctx.service.routes.registerBinding({
      executor_id: "CODEX",
      route_id: "RTE_CODEX_OVER",
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
    });
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_2");
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

/* ===== U — unqualified boot still reconciles existing bound routes =====
 *
 * Capability authority is independent of qualification: a persisted route
 * snapshot must converge to the fresh DECLARED set even when qualify()
 * fails this boot. Qualification gates routability, never the snapshot. */

describe("RCA.U — unqualified executor capability reconciliation", () => {
  it("U1. canonical route — unqualified boot reconciles, no resurrected cap, executor non-routable", () => {
    const ctx = makeCtx("u1");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B"]);

    // Boot 1: qualified — canonical route minted with [A, B].
    let res = registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
    expect(res.routable).toEqual(["CODEX"]);
    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.capabilities)
      .toEqual(["CAP_A", "CAP_B"]);

    // Boot 2: declaration shrinks to [A] AND qualification fails.
    codex.caps = ["CAP_A"];
    codex.qualified = false;
    res = registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_2");

    const route = ctx.service.routes.getRoute("RTE_CODEX_CLI")!;
    expect(route.capabilities).toEqual(["CAP_A"]);          // B cannot stay effective
    expect(res.unavailable.map((u) => u.executor_id)).toEqual(["CODEX"]);
    expect(res.routable).toEqual([]);
    const executor = ctx.store.get("executor", "CODEX")!;
    expect((executor.metadata as { qualification_state?: string }).qualification_state)
      .toBe("UNQUALIFIED");
    expect(executor.capabilities).toEqual([]);              // non-routable descriptor
  });

  it("U2. ROUTE_EXPLICIT subset on unqualified boot — declared preserved, effective clamps, C never auto-added", () => {
    const ctx = makeCtx("u2");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
    mintBoundExplicitRoute(ctx, "RTE_CODEX_SUB", "CODEX", ["CAP_A", "CAP_B"]);

    // Boot 2: declaration [A, C] and qualification fails.
    codex.caps = ["CAP_A", "CAP_C"];
    codex.qualified = false;
    const res = registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_2");

    const sub = ctx.service.routes.getRoute("RTE_CODEX_SUB")!;
    expect(sub.capability_source).toBe("ROUTE_EXPLICIT");
    expect(sub.capabilities_declared).toEqual(["CAP_A", "CAP_B"]); // intent verbatim
    expect(sub.capabilities).toEqual(["CAP_A"]);                   // B removed, C not added
    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.capabilities)
      .toEqual(["CAP_A", "CAP_C"]);
    expect(res.routable).toEqual([]);
  });

  it("U3. requalification — stale cap never resurrects; executor routable again", () => {
    const ctx = makeCtx("u3");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
    mintBoundExplicitRoute(ctx, "RTE_CODEX_SUB", "CODEX", ["CAP_A", "CAP_B"]);

    codex.caps = ["CAP_A"];
    codex.qualified = false;
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_2");

    // Boot 3: re-qualified, declaration still [A].
    codex.qualified = true;
    const res = registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_3");
    expect(res.routable).toEqual(["CODEX"]);
    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.capabilities).toEqual(["CAP_A"]);
    const sub = ctx.service.routes.getRoute("RTE_CODEX_SUB")!;
    expect(sub.capabilities_declared).toEqual(["CAP_A", "CAP_B"]);
    expect(sub.capabilities).toEqual(["CAP_A"]); // B stays dead
  });

  it("U4. never-qualified — no route minted, no binding minted, not routable", () => {
    const ctx = makeCtx("u4");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A"]);
    codex.qualified = false;

    const res = registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
    expect(res.registered).toEqual(["CODEX"]);
    expect(res.unavailable.map((u) => u.executor_id)).toEqual(["CODEX"]);
    expect(res.routable).toEqual([]);
    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")).toBeNull();
    expect(ctx.service.routes.bindingFor("CODEX", "RTE_CODEX_CLI")).toBeNull();
    // Registry executor record exists but is non-routable.
    const executor = ctx.store.get("executor", "CODEX")!;
    expect(executor.capabilities).toEqual([]);
  });

  it("U5. repeat unqualified boots — converged once, then zero churn", () => {
    const ctx = makeCtx("u5");
    const codex = new ScriptedAdapter("CODEX", [], ["CAP_A", "CAP_B"]);
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_1");
    mintBoundExplicitRoute(ctx, "RTE_CODEX_SUB", "CODEX", ["CAP_A", "CAP_B"]);

    codex.caps = ["CAP_A"];
    codex.qualified = false;
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_2");
    const v1 = ctx.service.routes.getRoute("RTE_CODEX_CLI")!.version;
    const sv1 = ctx.service.routes.getRoute("RTE_CODEX_SUB")!.version;
    const events1 = ctx.store.listEvents()
      .filter((e) => e.event_type === "ROUTE_CAPABILITIES_RECONCILED").length;
    const routes1 = ctx.store.list("route").length;
    const bindings1 = ctx.store.list("route_binding").length;

    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_3");
    registerGovernedExecutors(ctx.service, new Map([["CODEX", codex]]), "BOOT_4");

    expect(ctx.service.routes.getRoute("RTE_CODEX_CLI")!.version).toBe(v1);
    expect(ctx.service.routes.getRoute("RTE_CODEX_SUB")!.version).toBe(sv1);
    expect(ctx.store.listEvents()
      .filter((e) => e.event_type === "ROUTE_CAPABILITIES_RECONCILED").length)
      .toBe(events1);
    expect(ctx.store.list("route").length).toBe(routes1);
    expect(ctx.store.list("route_binding").length).toBe(bindings1);
  });
});

/** A second route bound to the same executor, declared as an intentional
 *  operator subset — same shape the R tests mint inline. */
function mintBoundExplicitRoute(
  ctx: ReturnType<typeof makeCtx>,
  routeId: string,
  executorId: string,
  declared: string[],
) {
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "REMOTE_GATEWAY_API",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    capability_source: "ROUTE_EXPLICIT",
    capabilities_declared: [...declared],
    capabilities: [...declared],
    executor_hint: executorId,
  });
  ctx.service.routes.registerBinding({
    executor_id: executorId,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
  });
}

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

  it("S6. FIRST decision knows the failed executor — RE_ROUTE rejected NO_ALTERNATE_ELIGIBLE_EXECUTOR, not falsely selected", () => {
    const ctx = makeCtx("s6");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...route, eligibility_state: "DISABLED", enabled: false }, Number(route.version));

    const mid = startMission(ctx);
    const clock = fakeClock();
    // Tick until the first recovery_decision exists.
    for (let i = 0; i < 12 && decisions(ctx, mid).length === 0; i++) {
      ctx.runtime.tick(mid, clock());
    }
    const first = decisions(ctx, mid)[0];
    expect(String(first.failure_class)).toBe("ROUTE_INFEASIBLE");
    // The decision receipt carries the executor that failed — dispatch-time
    // routing failure has no execution row, so meta.executor_id must feed it.
    expect(String(first.executor_id)).toBe("EX_A");
    // With EX_A the only executor, RE_ROUTE must be rejected up front — the
    // controller must not pick a useless re-route onto the same executor.
    const rejected = (first.rejected_actions as Array<{ action: string; reason: string }>) ?? [];
    expect(
      rejected.some((r) => r.action === "RE_ROUTE" && r.reason === "NO_ALTERNATE_ELIGIBLE_EXECUTOR"),
    ).toBe(true);
    expect(String(first.selected_action)).not.toBe("RE_ROUTE");
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

/* ===== T — policy-denial taxonomy scoped to the selected executor ======== */

function makeBizCtx(name: string) {
  const ctx = makeCtx(name);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  const bz = biz.createBusiness({ name: "Biz", project_id: ctx.projectId, operator_id: "op" });
  const ag = biz.createOrgAgent({
    business_id: String(bz.business_id),
    title: "eng",
    department: "eng",
    operator_id: "op",
  });
  return { ctx, biz, agentId: String(ag.agent_id), businessId: String(bz.business_id) };
}

function boundMission(ctx: ReturnType<typeof makeCtx>, agentId: string, businessId: string) {
  const mission = ctx.control.startMission({
    goal: "g",
    project_id: ctx.projectId,
    operator_id: "op",
    metadata: { business_id: businessId, org_agent_id: agentId },
  });
  const missionId = String(mission.mission_id);
  ctx.service.transitionMission(missionId, "READY");
  ctx.service.commitPlan({
    mission_id: missionId,
    source: "test",
    tasks: [
      {
        task_key: "T1",
        title: "t1",
        task_instruction: "do it",
        required_capabilities: ["ONLY_EX_A"],
        depends_on: [],
      },
    ],
    proposal: { tasks: [] },
  });
  return ctx.service.getMission(missionId);
}

function govRequest(ctx: ReturnType<typeof makeCtx>, mission: Record<string, unknown>) {
  const task = ctx.service.listTasks(String(mission.mission_id))[0];
  return {
    mission_id: String(mission.mission_id),
    task_id: String(task.task_id),
    plan_revision: Number(mission.plan_revision),
    task_instruction: String(task.task_instruction),
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: (mission.granted_permissions as string[]) ?? [],
    constraints: [],
    timeout: 60,
    expected_output_contract: { type: "TASK_RESULT" },
    correlation_id: `${String(mission.mission_id)}:${String(task.task_id)}`,
  } as never;
}

describe("RCA.T — scoped policy-denial taxonomy", () => {
  it("T1. selected executor's route policy-denied while another executor's routes BINDING_ABSENT → POLICY_DENIAL, not ROUTE_INFEASIBLE", () => {
    const { ctx, biz, agentId, businessId } = makeBizCtx("t1");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    const exB = new ScriptedAdapter("EX_B", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    registerAdapter(ctx, exB, exB.caps);
    biz.upsertAgentContract(agentId, "op", { denied_route_ids: ["RTE_EX_A"] });
    const mission = boundMission(ctx, agentId, businessId);
    // EX_A is selected (alphabetical); RTE_EX_A is contract-denied (in-scope
    // policy), RTE_EX_B shows BINDING_ABSENT for EX_A — out of scope.
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission), ctx.adapters),
    ).toThrowError(/^FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
  });

  it("T2. selected executor's route locally infeasible → ROUTE_INFEASIBLE", () => {
    const { ctx, agentId, businessId } = makeBizCtx("t2");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    const exB = new ScriptedAdapter("EX_B", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    registerAdapter(ctx, exB, exB.caps);
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put("route", "RTE_EX_A", { ...route, eligibility_state: "DISABLED", enabled: false }, Number(route.version));
    const mission = boundMission(ctx, agentId, businessId);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission), ctx.adapters),
    ).toThrowError(/^FAIL_CLOSED_ROUTE_INFEASIBLE/);
  });

  it("T3. mixed — one bound route policy-denied, one bound route capability-infeasible → ROUTE_INFEASIBLE (governance did not forbid every choice)", () => {
    const { ctx, biz, agentId, businessId } = makeBizCtx("t3");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    // Second bound route for EX_A lacking ONLY_EX_A — local infeasibility.
    ctx.service.routes.registerRoute({
      route_id: "RTE_EX_A_2",
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["FILE_OPERATIONS"],
      executor_hint: "EX_A",
    });
    ctx.service.routes.registerBinding({
      executor_id: "EX_A",
      route_id: "RTE_EX_A_2",
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
    });
    // Contract denies the first route; the second is locally infeasible.
    // Deterministic rule: every in-scope route must carry a policy code for
    // POLICY_DENIAL — one route rejected only locally → ROUTE_INFEASIBLE.
    biz.upsertAgentContract(agentId, "op", { denied_route_ids: ["RTE_EX_A"] });
    const mission = boundMission(ctx, agentId, businessId);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission), ctx.adapters),
    ).toThrowError(/^FAIL_CLOSED_ROUTE_INFEASIBLE/);
  });

  it("T4. contract restriction (no-fallback pin to an unrelated route) excludes every in-scope route → POLICY_DENIAL", () => {
    const { ctx, biz, agentId, businessId } = makeBizCtx("t4");
    const exA = new ScriptedAdapter("EX_A", [], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    biz.upsertAgentContract(agentId, "op", {
      preferred_route_ids: ["RTE_GHOST"],
      route_fallback_allowed: false,
    });
    const mission = boundMission(ctx, agentId, businessId);
    expect(() =>
      ctx.router.routeGovernedTask(govRequest(ctx, mission), ctx.adapters),
    ).toThrowError(/^FAIL_CLOSED_NO_ELIGIBLE_ROUTE/);
  });

  it("T5. genuine POLICY_DENIAL never triggers a governed reroute to evade the policy — bounded ABORT", () => {
    const { ctx, biz, agentId, businessId } = makeBizCtx("t5");
    const exA = new ScriptedAdapter("EX_A", [{ status: "COMPLETED" }], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    const exB = new ScriptedAdapter("EX_B", [{ status: "COMPLETED" }], ["ONLY_EX_A", "FILE_OPERATIONS"]);
    registerAdapter(ctx, exA, exA.caps);
    registerAdapter(ctx, exB, exB.caps);
    // Contract denies every route in the registry → genuine policy denial.
    biz.upsertAgentContract(agentId, "op", {
      denied_route_ids: ["RTE_EX_A", "RTE_EX_B"],
    });
    const mid = String(
      ctx.control.startMission({
        goal: "g",
        project_id: ctx.projectId,
        operator_id: "op",
        metadata: { business_id: businessId, org_agent_id: agentId },
      }).mission_id,
    );
    const clock = fakeClock();
    for (let i = 0; i < 30; i++) {
      ctx.runtime.tick(mid, clock());
      const st = String(rt(ctx, mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(st)) break;
    }
    const first = decisions(ctx, mid)[0];
    expect(String(first.failure_class)).toBe("POLICY_DENIAL");
    expect(String(first.selected_action)).toBe("ABORT");
    // No re-route ever dispatched — policy was not evaded.
    expect(exA.dispatched.length + exB.dispatched.length).toBe(0);
    expect(["ABORTED", "FAILED"]).toContain(String(rt(ctx, mid).state));
  });
});

/* ============ D — capability-aware registry snapshot digest ============== */

describe("RCA.D — snapshot digest binds capability semantics", () => {
  it("D1. capability mutation changes the digest; reorder does not", () => {
    const ctx = makeCtx("d1");
    const exA = new ScriptedAdapter("EX_A", [], ["CAP_A", "CAP_B"]);
    registerAdapter(ctx, exA, exA.caps);
    const d1 = ctx.service.routes.snapshotDigest();

    // Mutate capabilities on the same route → digest must change.
    const route = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put(
      "route",
      "RTE_EX_A",
      { ...route, capabilities: ["CAP_A", "CAP_B", "CAP_C"] },
      Number(route.version),
    );
    const d2 = ctx.service.routes.snapshotDigest();
    expect(d2).not.toBe(d1);

    // Reorder the same set → canonical sorted form → identical digest.
    const route2 = ctx.service.routes.getRoute("RTE_EX_A")!;
    ctx.store.put(
      "route",
      "RTE_EX_A",
      { ...route2, capabilities: ["CAP_C", "CAP_B", "CAP_A"] },
      Number(route2.version),
    );
    expect(ctx.service.routes.snapshotDigest()).toBe(d2);
  });

  it("D2. capabilities_declared participates in the digest", () => {
    const ctx = makeCtx("d2");
    const exA = new ScriptedAdapter("EX_A", [], ["CAP_A", "CAP_B"]);
    registerAdapter(ctx, exA, exA.caps);
    ctx.service.routes.registerRoute({
      route_id: "RTE_X",
      route_kind: "REMOTE_GATEWAY_API",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      capability_source: "ROUTE_EXPLICIT",
      capabilities: ["CAP_A"],
      capabilities_declared: ["CAP_A", "CAP_B"],
      executor_hint: "EX_A",
    });
    const d1 = ctx.service.routes.snapshotDigest();
    const route = ctx.service.routes.getRoute("RTE_X")!;
    ctx.store.put(
      "route",
      "RTE_X",
      { ...route, capabilities_declared: ["CAP_A", "CAP_B", "CAP_C"] },
      Number(route.version),
    );
    const changedDigest = ctx.service.routes.snapshotDigest();
    expect(changedDigest).not.toBe(d1);
    // Same declared set, different order → canonical sorted form → IDENTICAL
    // digest. [A,B,C] == [C,B,A] while [A,B] != [A,B,C].
    const route2 = ctx.service.routes.getRoute("RTE_X")!;
    ctx.store.put(
      "route",
      "RTE_X",
      { ...route2, capabilities_declared: ["CAP_C", "CAP_B", "CAP_A"] },
      Number(route2.version),
    );
    expect(ctx.service.routes.snapshotDigest()).toBe(changedDigest);
  });
});
