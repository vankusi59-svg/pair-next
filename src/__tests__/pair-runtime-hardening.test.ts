/**
 * PRE-P14-WORKFORCE RUNTIME HARDENING tests — two inherited runtime defects:
 *
 * A. FAIL_CLOSED_MODEL_REMOVED boot crash-loop: a persisted REMOVED model
 *    entry must be NOT ROUTABLE (route qualification skips it), boot must
 *    continue, and unrelated integrity failures still propagate fail-closed.
 * B. Orphaned non-terminal mission: mission row persisted before its
 *    mission_runtime row (crash window in startMissionInternal). Restart
 *    must detect + reconstruct the canonical runtime idempotently through
 *    the existing MissionRuntime/MissionSupervisor — no second dispatcher,
 *    no direct dispatch, terminal missions never resurrected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
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
  probeModel,
  qualifyModel,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-rh-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
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
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] = {
      status: "COMPLETED",
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      summary: "done",
    };
    return { execution_id: eid, status: "COMPLETED", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, ...r };
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
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  projectId: string;
}

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
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
  const adapter = new ScriptedAdapter("EX_A");
  registry.register({
    executor_id: adapter.executor_id,
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
      max_concurrency: 4,
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
    executor_hint: adapter.executor_id,
  });
  service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: "RTE_EX_A",
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  adapters.set(adapter.executor_id, adapter);
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
  const control = new MissionControl({
    service,
    runtime,
    supervisor,
    scheduler,
    approvals,
    reconciliation: recon,
    observability,
    planner: () => ({
      tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
    }),
  });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: dir });
  return { dir, store, service, runtime, supervisor, control, adapters, projectId: String(project.project_id) };
}

/** Persist a bare mission row with NO mission_runtime — exactly the
 * handleMissionCreated→runtimeEntity crash window in startMissionInternal. */
function orphanMission(ctx: Ctx, goal = "orphan"): string {
  const m = ctx.service.createMission({
    project_id: ctx.projectId,
    goal,
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  return String(m.mission_id);
}

function seedRemovedModel(store: PairEvidenceStore, id = "ME_REMOVED_1"): string {
  store.put(
    "model_entry",
    id,
    {
      model_entry_id: id,
      provider_id: "PROV_X",
      provider_family: "FAM_X",
      model_id: "removed-model",
      display_name: "removed-model",
      lifecycle_state: "QUALIFIED",
      capability_claims: { text_inference: "PASS" },
      conditions: ["REMOVED"],
      status_hint: "REMOVED",
      absence_streak: 3,
      probe_receipt_ids: [],
      first_seen_at: utcnow(),
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    },
    0,
  );
  return id;
}

/** Mirrors the route-qualification guard added to
 * serve-mission-control.mjs: REMOVED entries are skipped before the
 * probe path (which fail-closes on REMOVED); anything else flows into
 * probeModel unchanged. */
async function routeProbeAttemptAsync(
  store: PairEvidenceStore,
  me: Record<string, unknown>,
): Promise<string> {
  if (((me.conditions as string[] | undefined) ?? []).includes("REMOVED")) {
    return "SKIPPED_NOT_ROUTABLE";
  }
  await probeModel(store, String(me.model_entry_id), 1, {});
  return "PROBED";
}

describe("PRE-P14 RUNTIME HARDENING — REMOVED model / missing mission_runtime", () => {
  it("RH-R1-MODEL-REMOVED-REGRESSION: persisted REMOVED model is skipped, not routable", async () => {
    const ctx = makeCtx("mrb");
    const mid = seedRemovedModel(ctx.store);
    // Boot path guard: REMOVED → skipped before probeModel (the throw site).
    const me = ctx.store.get("model_entry", mid);
    await expect(routeProbeAttemptAsync(ctx.store, me)).resolves.toBe("SKIPPED_NOT_ROUTABLE");
    // Not routable anywhere: qualifyModel gate fails closed on REMOVED.
    const q = qualifyModel(ctx.store, mid, { capability_scope: ["text_inference"] });
    expect(q.qualified).toBe(false);
    expect(q.gates.MODEL_NOT_REMOVED).toBe("FAIL");
    // And a direct probeModel call still fail-closes (unchanged contract).
    await expect(probeModel(ctx.store, mid, 1, {})).rejects.toThrow(/FAIL_CLOSED_MODEL_REMOVED/);
  });

  it("RH-R1-MODEL-REMOVED-INTEGRITY: unrelated IntegrityError still propagates", async () => {
    const ctx = makeCtx("mri");
    // Non-REMOVED model with no probeFn configured — probeModel throws a
    // different IntegrityError; the guard does NOT swallow it.
    store_nonremoved(ctx.store);
    const me = ctx.store.get("model_entry", "ME_OK_1");
    await expect(routeProbeAttemptAsync(ctx.store, me)).rejects.toThrow(IntegrityError);
    await expect(routeProbeAttemptAsync(ctx.store, me)).rejects.toThrow(/FAIL_CLOSED_PROBE_NOT_CONFIGURED/);
  });

  it("RH-R1-CREATED-RECONSTRUCT: CREATED orphan mission gets canonical CREATED runtime + restart evidence", () => {
    const ctx = makeCtx("mr");
    const mid = orphanMission(ctx);
    expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(1);
    expect(r.missions).toContain(mid);
    const rt = ctx.store.get("mission_runtime", `MRT_${mid}`);
    expect(rt.state).toBe("CREATED");
    const wakes = ctx.store.list("supervisor_wake").filter((w) => w.mission_id === mid);
    expect(wakes.some((w) => w.reason === "RESTART_REHYDRATE")).toBe(true);
    expect(
      ctx.store
        .listEvents("mission_runtime", `MRT_${mid}`)
        .some((e) => e.event_type === "MISSION_RUNTIME_CREATED"),
    ).toBe(true);
  });

  it("RH-R1-IDEMPOTENT: second restart reconstructs nothing, no duplicate runtime", () => {
    const ctx = makeCtx("idm");
    const mid = orphanMission(ctx);
    const r1 = ctx.supervisor.resume();
    expect(r1.reconstructed).toBe(1);
    const created1 = ctx.store
      .listEvents("mission_runtime", `MRT_${mid}`)
      .filter((e) => e.event_type === "MISSION_RUNTIME_CREATED").length;
    const r2 = ctx.supervisor.resume();
    expect(r2.reconstructed).toBe(0);
    expect(ctx.store.list("mission_runtime").filter((x) => x.mission_id === mid)).toHaveLength(1);
    const created2 = ctx.store
      .listEvents("mission_runtime", `MRT_${mid}`)
      .filter((e) => e.event_type === "MISSION_RUNTIME_CREATED").length;
    expect(created2).toBe(created1);
  });

  it("RH-R1-TERMINAL: COMPLETED/FAILED/CANCELLED missions without runtime are never resurrected", () => {
    const ctx = makeCtx("term");
    const cancelled = orphanMission(ctx, "cancelled");
    ctx.service.transitionMission(cancelled, "CANCELLED", "test");
    const failed = orphanMission(ctx, "failed");
    ctx.service.transitionMission(failed, "READY", "test");
    ctx.service.transitionMission(failed, "RUNNING", "test");
    ctx.service.transitionMission(failed, "FAILED", "test");
    const completed = orphanMission(ctx, "completed");
    ctx.service.transitionMission(completed, "READY", "test");
    ctx.service.transitionMission(completed, "RUNNING", "test");
    ctx.service.transitionMission(completed, "COMPLETED", "test");
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    for (const mid of [cancelled, failed, completed]) {
      expect(r.missions).not.toContain(mid);
      expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
      expect(
        ctx.store
          .listEvents("mission", mid)
          .some((e) => e.event_type === "MISSION_RUNTIME_AMBIGUOUS"),
      ).toBe(false);
    }
  });

  it("RH-R1-PAUSED-NO-AUTORUN: PAUSED mission + missing runtime fails closed — no runtime, no dispatch", () => {
    const ctx = makeCtx("paus");
    const mid = orphanMission(ctx, "paused");
    ctx.service.transitionMission(mid, "READY", "test");
    ctx.service.transitionMission(mid, "RUNNING", "test");
    ctx.service.transitionMission(mid, "PAUSED", "test");
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    expect(r.missions).not.toContain(mid);
    expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
    // Explicit fail-closed recovery evidence on the canonical checkpoint.
    const mrcp = ctx.store.get("mission_recovery_checkpoint", `MRCP_${mid}`);
    const blocker = mrcp.restart_blocker as Record<string, unknown>;
    expect(blocker.code).toBe("FAIL_CLOSED_RUNTIME_AMBIGUOUS");
    expect(blocker.observed_mission_status).toBe("PAUSED");
    expect(
      ctx.store
        .listEvents("mission", mid)
        .some((e) => e.event_type === "MISSION_RUNTIME_AMBIGUOUS"),
    ).toBe(true);
    // Supervisor sweeps can never tick it → no dispatch, PAUSE authority
    // stays in effect (mission status unchanged).
    const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
    ctx.supervisor.runUntilSettled();
    expect(ex.dispatched).toHaveLength(0);
    expect(ctx.service.getMission(mid).status).toBe("PAUSED");
  });

  it("RH-R1-RUNNING-NO-GUESS: RUNNING mission + missing runtime → safe recovery, no guess, no dup dispatch", () => {
    const ctx = makeCtx("run");
    const mid = orphanMission(ctx, "running");
    ctx.service.transitionMission(mid, "READY", "test");
    ctx.service.transitionMission(mid, "RUNNING", "test");
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    expect(r.missions).not.toContain(mid);
    expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
    const blocker = (ctx.store.get("mission_recovery_checkpoint", `MRCP_${mid}`).restart_blocker ?? {}) as Record<
      string,
      unknown
    >;
    expect(blocker.code).toBe("FAIL_CLOSED_RUNTIME_AMBIGUOUS");
    expect(blocker.observed_mission_status).toBe("RUNNING");
    const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
    ctx.supervisor.runUntilSettled();
    expect(ex.dispatched).toHaveLength(0);
    expect(ctx.service.getMission(mid).status).toBe("RUNNING");
  });

  it("RH-R1-READY-NO-GUESS: READY mission + missing runtime fails closed", () => {
    const ctx = makeCtx("rdy");
    const mid = orphanMission(ctx, "ready");
    ctx.service.transitionMission(mid, "READY", "test");
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    expect(r.missions).not.toContain(mid);
    expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
    const blocker = (ctx.store.get("mission_recovery_checkpoint", `MRCP_${mid}`).restart_blocker ?? {}) as Record<
      string,
      unknown
    >;
    expect(blocker.code).toBe("FAIL_CLOSED_RUNTIME_AMBIGUOUS");
    expect(blocker.observed_mission_status).toBe("READY");
  });

  it("RH-R1-UNKNOWN-STATUS: malformed mission status + missing runtime fails closed", () => {
    const ctx = makeCtx("unk");
    const mid = orphanMission(ctx, "unknown");
    // Corrupt the mission status directly (bypass transition map) to
    // simulate a malformed canonical row — must NOT be reconstructed.
    const row = ctx.store.get("mission", mid);
    row.status = "WIBBLE";
    ctx.store.put("mission", mid, row, Number(row.version));
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    expect(r.missions).not.toContain(mid);
    expect(ctx.store.tryGet("mission_runtime", `MRT_${mid}`)).toBeNull();
    const blocker = (ctx.store.get("mission_recovery_checkpoint", `MRCP_${mid}`).restart_blocker ?? {}) as Record<
      string,
      unknown
    >;
    expect(blocker.code).toBe("FAIL_CLOSED_RUNTIME_AMBIGUOUS");
    expect(String(blocker.observed_mission_status)).toContain("UNKNOWN");
  });

  it("RH-R1-EXISTING-RUNTIME: valid runtime preserved, no duplicate", () => {
    const ctx = makeCtx("exr");
    // Start a mission normally → canonical runtime already exists.
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "normal",
      granted_permissions: ["FILE_WRITE"],
      authorized_workspaces: [],
    });
    const mid = String(m.mission_id);
    const before = ctx.store.get("mission_runtime", `MRT_${mid}`);
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(0);
    const after = ctx.store.get("mission_runtime", `MRT_${mid}`);
    expect(after.version).toBe(before.version);
    expect(ctx.store.list("mission_runtime").filter((x) => x.mission_id === mid)).toHaveLength(1);
  });

  it("RH-R1-GOVERNED-CONTINUATION: reconstructed mission proceeds via runtime/supervisor path", () => {
    const ctx = makeCtx("gc");
    const mid = orphanMission(ctx);
    const r = ctx.supervisor.resume();
    expect(r.reconstructed).toBe(1);
    // Subsequent execution goes through the existing MissionRuntime —
    // supervisor ticks drive it; nothing dispatches directly.
    const ex = ctx.adapters.get("EX_A") as ScriptedAdapter;
    ctx.supervisor.runUntilSettled();
    expect(ex.dispatched.length).toBe(1);
    expect(ctx.service.getMission(mid).status).toBe("COMPLETED");
    expect(ctx.store.get("mission_runtime", `MRT_${mid}`).state).toBe("COMPLETED");
  });
});

function store_nonremoved(store: PairEvidenceStore) {
  store.put(
    "model_entry",
    "ME_OK_1",
    {
      model_entry_id: "ME_OK_1",
      provider_id: "PROV_X",
      provider_family: "FAM_X",
      model_id: "ok-model",
      display_name: "ok-model",
      lifecycle_state: "DISCOVERED",
      capability_claims: {},
      conditions: [],
      status_hint: "LISTED",
      absence_streak: 0,
      probe_receipt_ids: [],
      first_seen_at: utcnow(),
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    },
    0,
  );
}
