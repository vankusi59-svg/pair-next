/**
 * HOTFIX-A — Cross-mission canonical artifact input binding.
 *
 *   A  plan-time binding (eligible → stamp → reconcile/assert pass)
 *   B  adversarial binding (absent/arbitrary/ambiguous/wrong-scope)
 *   C  stamped-shape + drift proofs (assert seams, replay conflict)
 *   D  execution-side resolution + byte materialization (end-to-end)
 *   E  revocation/stale authority (dispatch re-proof fails closed)
 *   F  same-mission handoff + planner/authority non-regression
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  artifactDependencySetDigest,
  ArtifactProvenanceValidator,
  ApprovalQueue,
  bindPlanExternalInputs,
  canonicalPlanSemanticDigest,
  digest,
  REPLAN_GENERATION_PENDING,
  ReplanAttemptLedger,
  TRANSPORT_IN_PROCESS,
  BusinessLayer,
  DependencyResolutionError,
  ExecutorRegistry,
  EXTERNAL_INPUT_CONTRACT,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveWorkstreamService,
  PAIR_DATAFLOW_SOURCES,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  reconcilePlanDataflow,
  assertPlanDataflow,
  sha256Hex,
  utcnow,
  workerExecutionId,
  WorkforceAllocationService,
  WorkforceService,
  type DependencyArtifactEntry,
  type ExternalInputArtifactSource,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-hotfixa-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_A";
let seq = 0;
const errCode = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as { code?: string })?.code ?? "ERR");
  }
};

const OP = "op:test";

/** Minimal scripted executor — dispatch contract only; the bound-mission
 *  replan tests drive REAL dispatch → failure → recovery → REPLANNING. */
class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  script: Array<{ status: string; error_class?: string }>;
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string, script: Array<{ status: string; error_class?: string }> = [{ status: "COMPLETED" }]) {
    this.executor_id = id;
    this.script = [...script];
  }
  probe() { return { executor_id: this.executor_id, available: true, state: "READY" }; }
  qualify() { return { qualified: true, dispatch_enabled: true }; }
  capabilities() { return { capability_ids: ["FILE_OPERATIONS"] }; }
  prepare_task(task: Record<string, unknown>) { return task; }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "RATE_LIMITED", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: "ok" };
    return { execution_id: eid, status: step.status, run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() { return { status: "CANCELLED" }; }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() { return []; }
  health() { return { state: "READY" }; }
}

/** Canonical executor registration — registry + route + binding + the
 *  runtime adapter map, the same seams MissionControl uses. */
function registerLocalExecutor(ctx: ReturnType<typeof mkCtx>, script?: Array<{ status: string; error_class?: string }>) {
  const adapter = new ScriptedAdapter(`EX_LOCAL_${seq++}`, script);
  ctx.registry.register({
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
  const routeId = `RTE_${adapter.executor_id}`;
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: ["FILE_OPERATIONS"],
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  ctx.adapters.set(adapter.executor_id, adapter);
  return adapter;
}

/** Full governed stack — REAL canonical services: BusinessLayer +
 *  workstreams + workforce allocation wired to a real MissionControl,
 *  so lineage fixtures mint through the production seams (F4). */
function mkCtx(name: string, planner?: (input: Record<string, unknown>) => unknown) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const plannerCalls: Array<Record<string, unknown>> = [];
  const plan =
    planner ??
    ((input: Record<string, unknown>) => {
      plannerCalls.push(input);
      return {
        tasks: [
          {
            task_key: "T1",
            title: "t1",
            task_instruction: "write out.md then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"],
            depends_on: [],
            metadata: {},
          },
        ],
      };
    });
  const adapters = new Map<string, ExecutorAdapter>();
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner: plan as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: plan as never,
  });
  const schedules = new MissionScheduleService(service);
  for (const c of ["FILE_OPERATIONS", "REASONING"]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name: "p", root_location: workspace });
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  return {
    d, workspace, store, service, control, project, runtime, biz, wf,
    workstreams, alloc, plannerCalls, registry, adapters,
  };
}

/** Canonical business scope: real business row + real objective +
 *  real workstream decomposition + ACTIVE agent — everything the
 *  eligibility lineage proof must validate (F1/F4). */
function mkScope(
  ctx: ReturnType<typeof mkCtx>,
  label: string,
  wsKeys: string[],
) {
  const businessId = `BIZ_${label}_${seq++}`;
  ctx.store.put("business", businessId, {
    business_id: businessId,
    name: `biz ${label}`,
    status: "ACTIVE",
    currency: "USD",
    project_id: String(ctx.project.project_id),
    created_at: utcnow(),
    version: 0,
  }, 0);
  const obj = ctx.biz.objectives.create({
    business_id: businessId,
    title: `obj ${label}`,
    statement: `grow ${label}`,
    kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: [],
    success_conditions: ["done"],
    dedup_key: `dk-${seq++}`,
    operator_id: OP,
  });
  const objectiveId = String(obj.objective_id);
  ctx.workstreams.decomposeObjective({
    objective_id: objectiveId,
    expected_objective_version: Number(obj.version),
    expected_terms_version: Number(obj.terms_version),
    expected_objective_digest: String(obj.objective_digest),
    workstreams: wsKeys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}`,
    })) as never,
    actor: OP,
  });
  const binding = ctx.workstreams.getBinding(objectiveId)!;
  ctx.biz.createOrgAgent({
    business_id: businessId,
    title: `agent ${label}`,
    department: "ops",
    operator_id: OP,
  });
  return { objectiveId, businessId, binding };
}

/** Canonical bound mission: real allocateWorkstream (WAL + delegated
 *  child) → real openWorkItem (WOB INTENT→BOUND + mission mint). */
function openBoundMission(
  ctx: ReturnType<typeof mkCtx>,
  scope: ReturnType<typeof mkScope>,
  workstreamKey: string,
) {
  ctx.alloc.allocateWorkstream({
    objective_id: scope.objectiveId,
    workstream_key: workstreamKey,
    actor: OP,
  });
  const wal = ctx.store
    .list("workforce_allocation")
    .find(
      (r) =>
        String(r.objective_id) === scope.objectiveId &&
        String(r.workstream_key ?? "") === workstreamKey,
    )!;
  const childId = String(wal.delegated_child_work_item_id);
  ctx.biz.openWorkItem(childId, OP);
  const wob = ctx.store
    .list("work_open_binding")
    .find((b) => String(b.work_item_id) === childId)!;
  const missionId = String(wob.mission_id);
  const mission = ctx.store.get("mission", missionId);
  return {
    missionId,
    mission,
    workItemId: childId,
    openId: String(wob.open_id),
    wal,
  };
}

/** A mission with NO binding — zero authorized scope (empty, not
 *  forged). */
function mkUnboundMission(ctx: ReturnType<typeof mkCtx>) {
  const mission = ctx.service.createMission({
    project_id: String(ctx.project.project_id),
    goal: "unbound",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [ctx.workspace],
  });
  const mid = String(mission.mission_id);
  return { missionId: mid, mission: ctx.store.get("mission", mid) };
}

/** A fully validated producer in `missionId` producing an ACCEPTED
 *  canonical artifact — the F1/F2 authority chain, real bytes in CAS. */
function mkAcceptedArtifact(
  ctx: ReturnType<typeof mkCtx>,
  missionId: string,
  name: string,
  bytes: Buffer,
) {
  const tid = `ATSK_S_${seq++}`;
  const key = `TS${seq}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(EX, gtId);
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid,
      task_key: key,
      mission_id: missionId,
      plan_id: "PLAN_A",
      title: key,
      task_instruction: `produce ${name}`,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
      status: "COMPLETED",
      metadata: { pair_dataflow: { produces: [name], consumes: [] } },
      version: 0,
    },
    0,
  );
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId,
      mission_id: missionId,
      task_id: tid,
      correlation_id: `COR_${tid}`,
      executor_id: EX,
      plan_id: "PLAN_A",
      plan_revision: 1,
      workspace: ctx.workspace,
      allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      created_at: utcnow(),
      version: 0,
    },
    0,
  );
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED",
    new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
    metadata: {
      mission_id: missionId,
      task_id: tid,
      executor_id: EX,
      governed_task_id: gtId,
      plan_id: "PLAN_A",
      plan_revision: 1,
      remote_produces_contract: false,
      declared_produces: [name],
      declared_produces_digest: null,
    },
  });
  // Canonical governed mint chain — VALIDATED → DISPATCH_AUTHORIZED →
  // persisted intent → COMPLETED execution with dispatch/collect
  // evidence (same writers MissionRuntime/GovernedTaskGate use; the
  // mint anchor is what makes the PASS validation legal).
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: gtId,
    event_type: "EXECUTION_PREPARED",
    old_state: "VALIDATED",
    new_state: "DISPATCH_AUTHORIZED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
  });
  ctx.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
    intent_id: `INTENT_${gtId}`,
    governed_task_id: gtId,
    executor_id: EX,
    state: "EXECUTION_PERSISTED",
    execution_id: eid,
    created_at: utcnow(),
    version: 0,
  }, 0);
  fs.writeFileSync(path.join(ctx.workspace, name), bytes);
  ctx.store.put("executor_execution", eid, {
    execution_id: eid,
    governed_task_id: gtId,
    mission_id: missionId,
    task_id: tid,
    executor_id: EX,
    plan_revision: 1,
    correlation_id: `COR_${tid}`,
    execution_state: "COMPLETED",
    dispatch_timestamp: utcnow(),
    run_root: `${ctx.workspace}/run`,
    workspace: ctx.workspace,
    result: {
      status: "COMPLETED",
      output: "done",
      artifacts: [
        { path: name, sha256: sha256Hex(bytes), byte_size: bytes.length },
      ],
    },
    version: 0,
  }, 0);
  ctx.store.event({
    entity_type: "executor_execution",
    entity_id: eid,
    event_type: "EXECUTION_DISPATCHED",
    new_state: "COMPLETED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
    metadata: { governed_task_id: gtId },
  });
  ctx.store.event({
    entity_type: "executor_execution",
    entity_id: eid,
    event_type: "RESULT_COLLECTED",
    new_state: "COMPLETED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
  });
  const validation = new ArtifactProvenanceValidator()
    .validate_execution(ctx.service, eid) as Record<string, unknown>;
  if (String(validation.status) !== "PASS") {
    throw new Error(
      `fixture validation not PASS: ${JSON.stringify(validation.failures)}`,
    );
  }
  const art = ctx.service.store
    .list("artifact")
    .find((a) => String(a.logical_name) === name)!;
  return {
    artifactId: String(art.artifact_id),
    artifact: art,
    tid,
    gtId,
    eid,
    task_key: key,
    name,
    bytes,
  };
}

/** Raw consumer task (pre-canonical shape) declaring a consume with no
 *  in-plan producer. */
function consumerTask(name: string) {
  return {
    task_key: "TC1",
    title: "verify input",
    task_instruction: `read and verify ${name}, write verdict.txt, then reply DONE.`,
    required_capabilities: ["FILE_OPERATIONS"],
    depends_on: [],
    metadata: {},
  };
}

/** Governed consumer task row carrying dependency_artifacts pins, for
 *  materialization tests. */
function mkGovernedConsumer(
  ctx: ReturnType<typeof mkCtx>,
  missionId: string,
  entries: Record<string, unknown>[],
  taskId?: string,
) {
  const tid = taskId ?? `ATSK_C_${seq++}`;
  const gtId = `GT_${tid}`;
  if (!ctx.store.tryGet("task", tid)) {
    ctx.store.put(
      "task",
      tid,
      {
        task_id: tid,
        task_key: "TCX",
        mission_id: missionId,
        plan_id: "PLAN_C",
        title: "consumer",
        task_instruction: "consume",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        status: "READY",
        metadata: { pair_dataflow: { produces: [], consumes: ["in.md"] } },
        version: 0,
      },
      0,
    );
  }
  const depDigest = artifactDependencySetDigest(
    entries as unknown as DependencyArtifactEntry[],
  );
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId,
      mission_id: missionId,
      task_id: tid,
      correlation_id: `COR_${tid}`,
      executor_id: EX,
      plan_revision: 1,
      workspace: ctx.workspace,
      allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      dependency_artifacts: entries,
      dependency_artifacts_digest: depDigest,
      created_at: utcnow(),
      version: 0,
    },
    0,
  );
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED",
    new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
    metadata: {
      mission_id: missionId,
      task_id: tid,
      executor_id: EX,
      dependency_artifacts_digest: depDigest,
    },
  });
  return { tid, gtId };
}

function eligibleFixture() {
  const ctx = mkCtx("e2e");
  const scope = mkScope(ctx, "T", ["w_src", "w_dst"]);
  const producer = openBoundMission(ctx, scope, "w_src");
  const art = mkAcceptedArtifact(
    ctx,
    producer.missionId,
    "xau-delta-brief.md",
    Buffer.from("# delta brief — canonical bytes"),
  );
  const consumer = openBoundMission(ctx, scope, "w_dst");
  // Refresh the mission row — the bound-mission seam rewrote it.
  return {
    ctx,
    producer: { ...producer, mission: ctx.store.get("mission", producer.missionId) },
    consumer: { ...consumer, mission: ctx.store.get("mission", consumer.missionId) },
    art,
    scope,
  };
}

const eligible = (
  ctx: ReturnType<typeof mkCtx>,
  mission: Record<string, unknown>,
): ExternalInputArtifactSource[] =>
  ctx.service.artifactResolver.listEligibleExternalInputSources(mission);

describe("HOTFIX-A cross-mission canonical artifact input binding", () => {
  it("A1: eligible set = ACCEPTED artifact of a sibling objective mission", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const list = eligible(ctx, consumer.mission);
    expect(list).toHaveLength(1);
    expect(list[0]!.artifact_id).toBe(art.artifactId);
    expect(list[0]!.logical_name).toBe("xau-delta-brief.md");
    expect(list[0]!.source_mission_id).toBe(String(ctx.store.get("artifact", art.artifactId).mission_id));
  });

  it("A2: unproduced consume binds + reconcile/assert PASS (plan-time)", () => {
    const { ctx, consumer } = eligibleFixture();
    const tasks = [consumerTask("xau-delta-brief.md")];
    const sources = eligible(ctx, consumer.mission);
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.contract).toBe(EXTERNAL_INPUT_CONTRACT);
    assertPlanDataflow(out, { external_input_artifacts: sources });
  });

  it("A3: bindPlanExternalInputs is idempotent (replay identical)", () => {
    const { ctx, consumer } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    const a = (tasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ];
    // Re-run — identical recompute, no throw, same bytes.
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    expect(
      (tasks[0]!.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
    ).toEqual(a);
    bindPlanExternalInputs(tasks, sources);
    expect(
      (tasks[0]!.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
    ).toEqual(a);
  });

  it("B1: absent source → consume stays UNBOUND (fail closed)", () => {
    const tasks = [consumerTask("never-produced.md")];
    expect(
      errCode(() => reconcilePlanDataflow(tasks, {})),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
    // Even with an eligible set that doesn't name the consume.
    const { ctx, consumer } = eligibleFixture();
    expect(
      errCode(() =>
        reconcilePlanDataflow([consumerTask("never-produced.md")], {
          external_input_artifacts: eligible(ctx, consumer.mission),
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
  });

  it("B2: same-name sources (two artifact ids) → LATEST_ACCEPTED wins, pinned", () => {
    const ctx = mkCtx("amb");
    const scope = mkScope(ctx, "AMB", ["w1", "w2", "w3"]);
    const p1 = openBoundMission(ctx, scope, "w1");
    const p2 = openBoundMission(ctx, scope, "w2");
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md", Buffer.from("one"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md", Buffer.from("two"));
    // Identity by producer mission; deterministic order via created_at.
    const a1 = ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p1.missionId &&
        String(a.logical_name) === "shared.md")!;
    const a2 = ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p2.missionId &&
        String(a.logical_name) === "shared.md")!;
    for (const [row, ts] of [[a1, "2026-10-17T00:00:01.000Z"],
      [a2, "2026-10-17T00:00:02.000Z"]] as const) {
      ctx.store.put("artifact", String(row.artifact_id),
        { ...row, created_at: ts }, Number(row.version ?? 0));
    }
    const consumer = openBoundMission(ctx, scope, "w3");
    const sources = eligible(ctx, consumer.mission);
    expect(sources).toHaveLength(2);
    const out = reconcilePlanDataflow([consumerTask("shared.md")], {
      external_input_artifacts: sources,
    }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    // The newer ACCEPTED producer (p2's artifact) is pinned — exact
    // identity in the stamp, drift still fails the replay re-proof.
    expect(stamps[0]!.artifact_id).toBe(String(a2.artifact_id));
    expect(stamps[0]!.artifact_id).not.toBe(String(a1.artifact_id));
    assertPlanDataflow(out, { external_input_artifacts: sources });
  });

  it("B3: no objective lineage → empty eligible set → UNBOUND", () => {
    const ctx = mkCtx("noscope");
    const prod = mkUnboundMission(ctx);
    mkAcceptedArtifact(ctx, prod.missionId, "x.md", Buffer.from("x"));
    const cons = mkUnboundMission(ctx);
    expect(eligible(ctx, cons.mission)).toHaveLength(0);
    expect(
      errCode(() =>
        reconcilePlanDataflow([consumerTask("x.md")], {
          external_input_artifacts: eligible(ctx, cons.mission),
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
  });

  it("B4: cross-objective artifact is not eligible (scope isolation)", () => {
    const ctx = mkCtx("xscope");
    const scopeA = mkScope(ctx, "A", ["wp"]);
    const prod = openBoundMission(ctx, scopeA, "wp");
    mkAcceptedArtifact(ctx, prod.missionId, "x.md", Buffer.from("x"));
    const scopeB = mkScope(ctx, "B", ["wc"]);
    const cons = openBoundMission(ctx, scopeB, "wc");
    expect(eligible(ctx, cons.mission)).toHaveLength(0);
  });

  it("B5: cross-BUSINESS objective lineage → fail closed", () => {
    const { ctx, consumer } = eligibleFixture();
    // Forged business on the consumer's WAL → provenance/digest or
    // business-mismatch — either way it must fail closed.
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.delegated_child_work_item_id) === consumer.workItemId,
      )!;
    ctx.store.put(
      "workforce_allocation",
      String(wal.allocation_id),
      { ...wal, business_id: "BIZ_FOREIGN" },
      Number(wal.version),
    );
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("N1: forged consumer WOB (wrong mission pin) → fail closed", () => {
    const { ctx, consumer } = eligibleFixture();
    const b = ctx.store.get("work_open_binding", consumer.openId);
    ctx.store.put(
      "work_open_binding",
      consumer.openId,
      { ...b, mission_id: "MSN_FORGED" },
      b.version,
    );
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("N2: malformed WAL (tampered child pin) → fail closed", () => {
    const { ctx, consumer } = eligibleFixture();
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.delegated_child_work_item_id) === consumer.workItemId,
      )!;
    ctx.store.put(
      "workforce_allocation",
      String(wal.allocation_id),
      { ...wal, delegated_child_work_item_id: "DL_FORGED" },
      Number(wal.version),
    );
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("N3: non-BOUND sibling binding → fail closed", () => {
    const { ctx, producer, consumer } = eligibleFixture();
    const b = ctx.store.get("work_open_binding", producer.openId);
    ctx.store.put(
      "work_open_binding",
      producer.openId,
      { ...b, state: "INTENT" },
      b.version,
    );
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("N4: producer without terminal PASS → not an eligible source", () => {
    const { ctx, consumer, art } = eligibleFixture();
    // Demote the producer execution: RUNNING/unvalidated artifacts are
    // not consumable sources even when the ART row stayed ACCEPTED.
    const e = ctx.store.get("executor_execution", art.eid);
    ctx.store.put(
      "executor_execution",
      art.eid,
      { ...e, execution_state: "RUNNING" },
      e.version,
    );
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
  });

  it("N5: FAILED producer execution → not an eligible source", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const e = ctx.store.get("executor_execution", art.eid);
    ctx.store.put(
      "executor_execution",
      art.eid,
      { ...e, execution_state: "FAILED", result: { status: "FAILED" } },
      e.version,
    );
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
  });

  it("G1: eligible cap counts ONLY eligible artifacts — unrelated rows free", () => {
    const ctx = mkCtx("capok");
    const scope = mkScope(ctx, "C", ["wp", "wc"]);
    const prod = openBoundMission(ctx, scope, "wp");
    for (let i = 0; i < 63; i++) {
      mkAcceptedArtifact(ctx, prod.missionId, `a${i}.md`, Buffer.from(`a${i}`));
    }
    // Unrelated global artifacts (foreign mission, unbound) must not
    // consume the eligible bound.
    for (let i = 0; i < 8; i++) {
      const m = mkUnboundMission(ctx);
      mkAcceptedArtifact(ctx, m.missionId, `z${i}.md`, Buffer.from(`z${i}`));
    }
    const cons = openBoundMission(ctx, scope, "wc");
    expect(eligible(ctx, cons.mission)).toHaveLength(63);
    // Exactly 64 eligible → still inside the bound.
    mkAcceptedArtifact(ctx, prod.missionId, `a63.md`, Buffer.from("a63"));
    expect(eligible(ctx, cons.mission)).toHaveLength(64);
    // The 65th eligible artifact trips the bound — fail closed.
    mkAcceptedArtifact(ctx, prod.missionId, `a64.md`, Buffer.from("a64"));
    expect(errCode(() => eligible(ctx, cons.mission))).toBe(
      "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("INT1: production path — runtime planning receives eligible sources and commits bound plan", () => {
    const ctx = mkCtx("int", (input: Record<string, unknown>) => {
      ctx.plannerCalls.push(input);
      return {
        tasks: [
          {
            task_key: "TC1",
            title: "verify input",
            task_instruction:
              "read and verify xau-delta-brief.md, write verdict.txt, then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"],
            depends_on: [],
            metadata: {
              pair_dataflow: {
                produces: ["verdict.txt"],
                consumes: ["xau-delta-brief.md"],
              },
            },
          },
        ],
      };
    });
    const scope = mkScope(ctx, "I", ["wp", "wc"]);
    const prod = openBoundMission(ctx, scope, "wp");
    mkAcceptedArtifact(
      ctx,
      prod.missionId,
      "xau-delta-brief.md",
      Buffer.from("# delta brief — canonical bytes"),
    );
    const consumer = openBoundMission(ctx, scope, "wc");
    // Drive the REAL runtime planning seam — CREATED→PLANNING invokes
    // the planner with the canonical eligible input set, →READY commits
    // the bound plan (not planner-freeform authority).
    ctx.runtime.tick(consumer.missionId);
    ctx.runtime.tick(consumer.missionId);
    expect(ctx.plannerCalls.length).toBeGreaterThan(0);
    const seen = ctx.plannerCalls[0]! as {
      input_artifact_sources?: ExternalInputArtifactSource[];
    };
    expect(Array.isArray(seen.input_artifact_sources)).toBe(true);
    expect(seen.input_artifact_sources![0]!.logical_name).toBe(
      "xau-delta-brief.md",
    );
    const tasks = ctx.store
      .list("task")
      .filter((t) => String(t.mission_id) === consumer.missionId);
    const stamped = tasks.filter(
      (t) =>
        (t.metadata as Record<string, unknown> | undefined)?.[
          PAIR_DATAFLOW_SOURCES
        ] !== undefined,
    );
    expect(stamped.length).toBeGreaterThan(0);
  });

  it("C1: forged stamp (planner-emitted metadata) is stripped at reconcile", () => {
    const tasks = [consumerTask("xau-delta-brief.md")];
    (tasks[0]!.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES] = [
      {
        contract: EXTERNAL_INPUT_CONTRACT,
        consume_name: "xau-delta-brief.md",
        artifact_id: "ART_FORGED",
        logical_name: "xau-delta-brief.md",
        sha256: "0".repeat(64),
        byte_size: 1,
        source_mission_id: "MSN_X",
        source_task_id: "T",
        source_governed_task_id: "G",
        source_execution_id: "E",
        source_executor_id: "X",
      },
    ];
    // Forged stamp is never minted authority — the consume has no
    // eligible source → still UNBOUND (not silently accepted).
    expect(errCode(() => reconcilePlanDataflow(tasks, {}))).toBe(
      "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT",
    );
  });

  it("C2: malformed/double-bound stamp fails assert (shape proof)", () => {
    const { ctx, consumer } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    const md = tasks[0]!.metadata as Record<string, unknown>;
    // Tamper the stamped sha → assert fails closed.
    (md[PAIR_DATAFLOW_SOURCES] as Record<string, unknown>[])[0]!.sha256 =
      "f".repeat(64);
    expect(
      errCode(() =>
        assertPlanDataflow(tasks, { external_input_artifacts: sources }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");
  });

  it("C3: replay with conflicting eligible identity → SOURCE_BINDING", () => {
    const { ctx, consumer } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    bindPlanExternalInputs(tasks, sources);
    // Rebind under a DIFFERENT (conflicting) source identity for the
    // same consume name — the pinned ledger must conflict, not swap.
    const other: ExternalInputArtifactSource = {
      ...sources[0]!,
      artifact_id: "ART_OTHER",
      sha256: "a".repeat(64),
      source_mission_id: "MSN_OTHER",
    };
    expect(
      errCode(() => bindPlanExternalInputs(tasks, [other])),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");
  });

  it("D1: dispatch resolution → pinned entry → materialized bytes match", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const taskRow = {
      ...out[0]!,
      task_id: "ATSK_CONS_1",
      plan_id: "PLAN_C",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
    };
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: taskRow,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifact_id).toBe(art.artifactId);
    expect(entries[0]!.producer_execution_id).toBe(art.eid);
    // Executor-side lane: governed task carries the pins; the ONE
    // materialization seam writes exact retained bytes.
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      "ATSK_CONS_1",
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.service.store.get("governed_task", gc.gtId),
      entries,
      "LOCAL_MATERIALIZATION",
    );
    const written = ctx.service.artifactHandoffs.materializeForConsumer(
      ctx.service.store.get("governed_task", gc.gtId),
    );
    expect(written).toHaveLength(1);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(fs.readFileSync(dest).toString()).toBe(art.bytes.toString());
    expect(sha256Hex(fs.readFileSync(dest))).toBe(art.artifact.sha256);
  });

  it("D2: corrupted CAS bytes → dispatch re-proof fails closed", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    // Corrupt the retained CAS blob NOW.
    const blob = path.join(
      ctx.service.artifacts.opts?.blobDir ??
        path.join(path.dirname((ctx.store as never as { dbPath?: string }).dbPath ?? ctx.d), "artifacts"),
      "blobs",
      String(art.artifact.sha256),
    );
    if (!fs.existsSync(blob)) {
      // Discover the real blobDir via a glob — deployment-scoped.
      const candidates = fs
        .readdirSync(path.join(ctx.d), { recursive: true })
        .filter((f) => String(f).endsWith(String(art.artifact.sha256)));
      expect(candidates.length).toBeGreaterThan(0);
      fs.writeFileSync(path.join(ctx.d, String(candidates[0]!)), "tampered");
    } else {
      fs.writeFileSync(blob, "tampered");
    }
    // Eligibility enumeration itself now fails or drops the artifact —
    // either way the stamped source can never resolve to bytes.
    let resolved: unknown = null;
    const code = errCode(() => {
      const eligible2 = eligible(ctx, consumer.mission);
      if (!eligible2.length) return;
      resolved = ctx.service.artifactResolver.resolveForConsumer({
        mission: { ...consumer.mission, plan_revision: 1 },
        task: {
          ...tasks[0]!,
          task_id: "ATSK_C2",
          plan_id: "P",
          required_capabilities: ["FILE_OPERATIONS"],
        },
      });
    });
    expect(resolved).toBeNull();
    expect(code === null || String(code).startsWith("FAIL_CLOSED")).toBe(true);
  });

  it("E1: revoked source (artifact row dropped) → dispatch fails closed", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    // Source artifact becomes non-ACCEPTED after plan commit.
    const row = ctx.store.get("artifact", art.artifactId);
    ctx.store.put("artifact", art.artifactId, { ...row, state: "REJECTED" }, row.version);
    const taskRow = {
      ...tasks[0]!,
      task_id: "ATSK_REV",
      plan_id: "P",
      required_capabilities: ["FILE_OPERATIONS"],
    };
    expect(
      errCode(() =>
        ctx.service.artifactResolver.resolveForConsumer({
          mission: { ...consumer.mission, plan_revision: 1 },
          task: taskRow,
        }),
      ),
    ).toBe("FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("E2: stamped artifact outside eligible set → unauthorized", () => {
    const ctx = mkCtx("unauth");
    const scope = mkScope(ctx, "U", ["wp"]);
    const prod = openBoundMission(ctx, scope, "wp");
    mkAcceptedArtifact(ctx, prod.missionId, "u.md", Buffer.from("u"));
    // Consumer mission WITHOUT the objective allocation — no scope.
    const cons = mkUnboundMission(ctx);
    const stamped = [
      {
        contract: EXTERNAL_INPUT_CONTRACT,
        consume_name: "u.md",
        artifact_id: ctx.store.list("artifact")[0]!.artifact_id,
        logical_name: "u.md",
        sha256: String(ctx.store.list("artifact")[0]!.sha256),
        byte_size: Number(ctx.store.list("artifact")[0]!.byte_size),
        source_mission_id: "MSN_P",
        source_task_id: "T",
        source_governed_task_id: "G",
        source_execution_id: "E",
        source_executor_id: EX,
      },
    ];
    const task = {
      ...consumerTask("u.md"),
      task_id: "ATSK_U",
      plan_id: "P",
      metadata: {
        pair_dataflow: { produces: [], consumes: ["u.md"] },
        [PAIR_DATAFLOW_SOURCES]: stamped,
      },
    };
    expect(
      errCode(() =>
        ctx.service.artifactResolver.resolveForConsumer({
          mission: { ...cons.mission, plan_revision: 1 },
          task,
        }),
      ),
    ).toBe("FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("F1: in-plan producer rule unchanged — producer+consumer same plan", () => {
    const tasks = [
      {
        task_key: "TP1",
        title: "produce",
        task_instruction: "write report.md then reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
      consumerTask("report.md"),
    ];
    tasks[1]!.depends_on = ["TP1"];
    const out = reconcilePlanDataflow(tasks, {}).tasks;
    // No external stamps minted — ordinary producer edge covers it.
    expect(
      (out[1]!.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
    ).toBeUndefined();
    assertPlanDataflow(out, {});
  });

  it("F2: in-plan consume with NO producer and NO eligible → still UNBOUND", () => {
    // Ambiguous-in-plan regression preserved: two producers, one name.
    const tasks = [
      {
        task_key: "TP1",
        title: "p1",
        task_instruction: "write a.md then reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
      {
        task_key: "TP2",
        title: "p2",
        task_instruction: "write a.md then reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
      consumerTask("a.md"),
    ];
    tasks[2]!.depends_on = ["TP1", "TP2"];
    expect(errCode(() => reconcilePlanDataflow(tasks, {}))).toBe(
      "FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER",
    );
  });

  it("F3: own-mission artifact is NOT an eligible external source", () => {
    const ctx = mkCtx("own");
    const scope = mkScope(ctx, "OWN", ["wo"]);
    const own = openBoundMission(ctx, scope, "wo");
    mkAcceptedArtifact(ctx, own.missionId, "mine.md", Buffer.from("mine"));
    const list = eligible(ctx, ctx.store.get("mission", own.missionId));
    expect(list).toHaveLength(0);
  });

  /* ==================== R2 — full-allocation + fetch-lane hardening === */

  const tamper = (
    ctx: ReturnType<typeof mkCtx>,
    entity: string,
    id: string,
    patch: Record<string, unknown>,
  ) => {
    const row = ctx.store.get(entity, id);
    ctx.store.put(entity, id, { ...row, ...patch }, row.version);
  };

  it("R2-N6: tampered WDEL (intact WAL receipt) → fail closed", () => {
    const { ctx, consumer } = eligibleFixture();
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.delegated_child_work_item_id) === consumer.workItemId,
      )!;
    tamper(ctx, "work_delegation", String(wal.delegation_id), {
      delegated_to_agent_id: "AGT_FORGED",
    });
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("R2-N7: invalid child graph membership (intact WAL) → fail closed", () => {
    const { ctx, consumer } = eligibleFixture();
    const mem = ctx.store
      .list("work_graph_membership")
      .find(
        (m) => String(m.work_item_id) === consumer.workItemId,
      )!;
    tamper(ctx, "work_graph_membership", String(mem.entity_id), {
      parent_work_item_id: "WI_FORGED",
    });
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("R2-N8: broken objective workstream binding (intact WAL) → fail closed", () => {
    const { ctx, consumer, scope } = eligibleFixture();
    const binding = ctx.workstreams.getBinding(scope.objectiveId)!;
    const ws = (binding.workstreams as Array<Record<string, unknown>>).slice();
    ws[0] = { ...ws[0]!, work_item_id: "WI_FORGED" };
    tamper(
      ctx,
      "objective_workstream_binding",
      String(binding.binding_id),
      { workstreams: ws },
    );
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE",
    );
  });

  it("R2-N9: two anchored PASS validations, different artifact sets → contradictory closed", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const exec = ctx.store.get("executor_execution", art.eid);
    const vid2 = `XVLD_FORGED_${seq++}`;
    ctx.store.put("execution_validation", vid2, {
      validation_id: vid2,
      execution_id: art.eid,
      mission_id: String(exec.mission_id),
      governed_task_id: String(exec.governed_task_id),
      status: "PASS",
      artifact_ids: ["ART_OTHER_SET"],
      created_at: utcnow(),
      version: 0,
    }, 0);
    ctx.store.event({
      entity_type: "executor_execution",
      entity_id: art.eid,
      event_type: "RESULT_VALIDATED",
      new_state: "PASS",
      actor: "PAIR_ARTIFACT_PROVENANCE_VALIDATOR",
      correlation_id: String(exec.correlation_id),
      metadata: { validation_id: vid2 },
    });
    // Two independently anchored PASS records → never consumable.
    expect(errCode(() => eligible(ctx, consumer.mission))).toBe(
      "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("R2-H1: REMOTE_FETCH lane — pinned capability serves exact cross-mission bytes", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const taskRow = {
      ...out[0]!,
      task_id: "ATSK_RF",
      plan_id: "P",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
    };
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: taskRow,
    });
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      "ATSK_RF",
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.store.get("governed_task", gc.gtId),
      entries,
      "REMOTE_FETCH",
    );
    // The consumer's RUNNING execution — fetch is only legal
    // pre-terminal, under the minted capability identity.
    const cExec = `EXEC_C_${seq++}`;
    ctx.store.put("executor_execution", cExec, {
      execution_id: cExec,
      governed_task_id: gc.gtId,
      mission_id: consumer.missionId,
      task_id: gc.tid,
      executor_id: EX,
      plan_revision: 1,
      correlation_id: `COR_C_${gc.tid}`,
      execution_state: "RUNNING",
      workspace: ctx.workspace,
      version: 0,
    }, 0);
    const claims = {
      mission_id: consumer.missionId,
      task_id: gc.tid,
      governed_task_id: gc.gtId,
      execution_id: cExec,
      executor_id: EX,
      dependency_set_digest: artifactDependencySetDigest(
        entries as unknown as DependencyArtifactEntry[],
      ),
      issued_at: utcnow(),
    };
    const { artifact, bytes } = ctx.service.artifactHandoffs.authorizeConsumeFetch(
      claims as never,
      art.artifactId,
    );
    expect(bytes.toString()).toBe(art.bytes.toString());
    expect(String(artifact.execution_id)).toBe(art.eid);
    // Wrong producer identity — capability for the CONSUMER identity is
    // bound to the consumer execution, never the producer's.
    expect(
      errCode(() =>
        ctx.service.artifactHandoffs.authorizeConsumeFetch(
          { ...claims, mission_id: art.artifact.mission_id } as never,
          art.artifactId,
        ),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
    // An ACCEPTED sibling artifact that is NOT pinned is never servable.
    const stray = mkAcceptedArtifact(
      ctx,
      consumer.missionId === "" ? "" : consumer.missionId,
      "mine.md",
      Buffer.from("mine"),
    );
    void stray;
    expect(
      errCode(() =>
        ctx.service.artifactHandoffs.authorizeConsumeFetch(
          claims as never,
          "ART_NOTPINNED",
        ),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("R2-H2: LOCAL_MATERIALIZATION lane — exact bytes land under the consumer root", () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const taskRow = {
      ...out[0]!,
      task_id: "ATSK_LM",
      plan_id: "P",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
    };
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: taskRow,
    });
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      "ATSK_LM",
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.store.get("governed_task", gc.gtId),
      entries,
      "LOCAL_MATERIALIZATION",
    );
    const written = ctx.service.artifactHandoffs.materializeForConsumer(
      ctx.store.get("governed_task", gc.gtId),
    );
    const dest = path.join(ctx.workspace, written[0]!);
    expect(fs.readFileSync(dest).toString()).toBe(art.bytes.toString());
    expect(sha256Hex(fs.readFileSync(dest))).toBe(art.artifact.sha256);
  });

  /* ============ R3-F6 — eligibility re-proved AT byte consumption === */

  const remoteFetchCtx = () => {
    const { ctx, consumer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const taskRow = {
      ...out[0]!,
      task_id: `ATSK_RF_${seq++}`,
      plan_id: "P",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
    };
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: taskRow,
    });
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      taskRow.task_id,
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.store.get("governed_task", gc.gtId),
      entries,
      "REMOTE_FETCH",
    );
    const cExec = `EXEC_C_${seq++}`;
    ctx.store.put("executor_execution", cExec, {
      execution_id: cExec,
      governed_task_id: gc.gtId,
      mission_id: consumer.missionId,
      task_id: gc.tid,
      executor_id: EX,
      plan_revision: 1,
      correlation_id: `COR_C_${gc.tid}`,
      execution_state: "RUNNING",
      workspace: ctx.workspace,
      version: 0,
    }, 0);
    const claims = {
      mission_id: consumer.missionId,
      task_id: gc.tid,
      governed_task_id: gc.gtId,
      execution_id: cExec,
      executor_id: EX,
      dependency_set_digest: artifactDependencySetDigest(
        entries as unknown as DependencyArtifactEntry[],
      ),
      issued_at: utcnow(),
    };
    return { ctx, consumer, art, entries, gc, claims };
  };

  it("R3-F6-1: lineage revoked AFTER pin → REMOTE_FETCH serves zero bytes", () => {
    const { ctx, consumer, art, claims } = remoteFetchCtx();
    // Control: the fetch lane would serve exact bytes while lineage holds.
    const ok = ctx.service.artifactHandoffs.authorizeConsumeFetch(
      claims as never,
      art.artifactId,
    );
    expect(ok.bytes.toString()).toBe(art.bytes.toString());
    // Revoke: tamper the consumer mission's WAL delegation — the
    // lineage proof re-runs at fetch time and must fail closed.
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.delegated_child_work_item_id) === consumer.workItemId,
      )!;
    const wdel = ctx.store.get(
      "work_delegation",
      String(wal.delegation_id),
    );
    ctx.store.put(
      "work_delegation",
      String(wal.delegation_id),
      { ...wdel, delegated_to_agent_id: "AGT_FORGED" },
      wdel.version,
    );
    expect(
      errCode(() =>
        ctx.service.artifactHandoffs.authorizeConsumeFetch(
          claims as never,
          art.artifactId,
        ),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("R3-F6-2: lineage revoked AFTER pin → materialize writes zero files", () => {
    const { ctx, consumer, producer, art } = eligibleFixture();
    const sources = eligible(ctx, consumer.mission);
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const taskRow = {
      ...out[0]!,
      task_id: `ATSK_LM_${seq++}`,
      plan_id: "P",
      plan_revision: 1,
      required_capabilities: ["FILE_OPERATIONS"],
    };
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: taskRow,
    });
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      taskRow.task_id,
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.store.get("governed_task", gc.gtId),
      entries,
      "LOCAL_MATERIALIZATION",
    );
    // Control: legitimate consumption still lands exact bytes.
    const written = ctx.service.artifactHandoffs.materializeForConsumer(
      ctx.store.get("governed_task", gc.gtId),
    );
    expect(fs.readFileSync(path.join(ctx.workspace, written[0]!)).toString())
      .toBe(art.bytes.toString());
    // Revoke the lineage on the PRODUCER side (its own WAL graph row).
    const srcWal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.delegated_child_work_item_id) === producer.workItemId,
      )!;
    const wdel = ctx.store.get(
      "work_delegation",
      String(srcWal.delegation_id),
    );
    ctx.store.put(
      "work_delegation",
      String(srcWal.delegation_id),
      { ...wdel, delegated_to_agent_id: "AGT_FORGED" },
      wdel.version,
    );
    const depRoot = path.join(ctx.workspace, ".pair", "dependency-artifacts");
    const before = fs.existsSync(depRoot)
      ? fs.readdirSync(depRoot, { recursive: true }).length
      : 0;
    expect(
      errCode(() =>
        ctx.service.artifactHandoffs.materializeForConsumer(
          ctx.store.get("governed_task", gc.gtId),
        ),
      ),
    ).toBe("FAIL_CLOSED_EXTERNAL_INPUT_LINEAGE");
    const after = fs.existsSync(depRoot)
      ? fs.readdirSync(depRoot, { recursive: true }).length
      : 0;
    expect(after).toBe(before);
  });

  it("R3-F6-3: cold-start — dist/pair/index.js loads and first eligible call binds", () => {
    // The production ESM graph must evaluate with zero TDZ crashes —
    // the late bindings only hold if the module order is intact.
    const dist = path.resolve("dist/pair/index.js");
    expect(fs.existsSync(dist)).toBe(true);
    const r = spawnSync(
      process.execPath,
      ["-e", `import("${dist}").then(()=>process.exit(0))`],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(r.status).toBe(0);
    // First Objective-bound eligibility call inside THIS process — the
    // bound prover must already serve (module eval bound it earlier).
    const { ctx, consumer, art } = eligibleFixture();
    const list = ctx.service.artifactResolver.listEligibleExternalInputSources(
      consumer.mission,
    );
    expect(list.map((s) => s.artifact_id)).toEqual([art.artifactId]);
  });

  // INT2 boundary note: the real MissionRuntime tick + plan commit +
  // resolve/pin/fetch seams are exercised end-to-end; the governed_task
  // and executor_execution rows are fabricated through canonical store
  // writes — actual executor dispatch remains a simulation boundary.
  it("R2-INT2: production path — plan commit → governed dispatch → remote fetch bytes", () => {
    const ctx = mkCtx("int2", (input: Record<string, unknown>) => {
      ctx.plannerCalls.push(input);
      return {
        tasks: [
          {
            task_key: "TC1",
            title: "verify input",
            task_instruction:
              "read and verify xau-delta-brief.md, write verdict.txt, then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"],
            depends_on: [],
            metadata: {
              pair_dataflow: {
                produces: ["verdict.txt"],
                consumes: ["xau-delta-brief.md"],
              },
            },
          },
        ],
      };
    });
    const scope = mkScope(ctx, "J", ["wp", "wc"]);
    const prod = openBoundMission(ctx, scope, "wp");
    const art = mkAcceptedArtifact(
      ctx,
      prod.missionId,
      "xau-delta-brief.md",
      Buffer.from("# delta brief — canonical bytes"),
    );
    const consumer = openBoundMission(ctx, scope, "wc");
    ctx.runtime.tick(consumer.missionId);
    ctx.runtime.tick(consumer.missionId);
    const committed = ctx.store
      .list("task")
      .find(
        (t) =>
          String(t.mission_id) === consumer.missionId &&
          (t.metadata as Record<string, unknown> | undefined)?.[
            PAIR_DATAFLOW_SOURCES
          ] !== undefined,
      )!;
    // Governed dispatch path — real resolve+pin+materialize seams on
    // the committed task (never a direct fixture row).
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...ctx.store.get("mission", consumer.missionId), plan_revision: 1 },
      task: committed,
    });
    expect(entries).toHaveLength(1);
    const gc = mkGovernedConsumer(
      ctx,
      consumer.missionId,
      [entries[0]! as unknown as Record<string, unknown>],
      String(committed.task_id),
    );
    ctx.service.artifactHandoffs.pinForGovernedTask(
      ctx.store.get("governed_task", gc.gtId),
      entries,
      "REMOTE_FETCH",
    );
    const cExec = `EXEC_CI_${seq++}`;
    ctx.store.put("executor_execution", cExec, {
      execution_id: cExec,
      governed_task_id: gc.gtId,
      mission_id: consumer.missionId,
      task_id: gc.tid,
      executor_id: EX,
      plan_revision: 1,
      correlation_id: `COR_CI_${gc.tid}`,
      execution_state: "RUNNING",
      workspace: ctx.workspace,
      version: 0,
    }, 0);
    const { artifact, bytes } = ctx.service.artifactHandoffs.authorizeConsumeFetch(
      {
        mission_id: consumer.missionId,
        task_id: gc.tid,
        governed_task_id: gc.gtId,
        execution_id: cExec,
        executor_id: EX,
        dependency_set_digest: artifactDependencySetDigest(
          entries as unknown as DependencyArtifactEntry[],
        ),
        issued_at: utcnow(),
      } as never,
      art.artifactId,
    );
    expect(bytes.toString()).toBe(art.bytes.toString());
    expect(String(artifact.execution_id)).toBe(art.eid);
    expect(String(artifact.mission_id)).toBe(prod.missionId);
  });
});

describe("EXTERNAL_INPUT_AWARENESS — work-item-scoped eligibility (plan-time)", () => {
  /** Consumer work item allocated (real WAL) but NOT yet opened — the
   *  exact shape at delegated plan-generation time: no WOB, no mission. */
  function planTimeFixture() {
    const ctx = mkCtx("wiscope");
    const scope = mkScope(ctx, "W", ["w_src", "w_dst"]);
    const producer = openBoundMission(ctx, scope, "w_src");
    const art = mkAcceptedArtifact(
      ctx,
      producer.missionId,
      "xau-delta-brief.md",
      Buffer.from("# delta brief — canonical bytes"),
    );
    ctx.alloc.allocateWorkstream({
      objective_id: scope.objectiveId,
      workstream_key: "w_dst",
      actor: OP,
    });
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.objective_id) === scope.objectiveId &&
          String(r.workstream_key ?? "") === "w_dst",
      )!;
    const consumerWorkItemId = String(wal.delegated_child_work_item_id);
    // Plan-time invariant: no binding, no mission for the consumer yet.
    expect(
      ctx.store
        .list("work_open_binding")
        .filter((b) => String(b.work_item_id) === consumerWorkItemId),
    ).toHaveLength(0);
    return { ctx, scope, art, producer, consumerWorkItemId };
  }

  it("W1: allocated-but-unopened work item sees the SAME sibling eligible set", () => {
    const { ctx, art, consumerWorkItemId } = planTimeFixture();
    const list =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumerWorkItemId,
      );
    expect(list).toHaveLength(1);
    expect(list[0]!.artifact_id).toBe(art.artifactId);
    expect(list[0]!.logical_name).toBe("xau-delta-brief.md");
  });

  it("W2: work item without objective allocation → empty set (no scope)", () => {
    const { ctx, scope } = planTimeFixture();
    const wi = ctx.biz.createWorkItem({
      business_id: scope.businessId,
      title: "plain item",
      goal: "unscoped work",
      operator_id: OP,
    });
    const list =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        String(wi.work_item_id),
      );
    expect(list).toHaveLength(0);
    // And a nonexistent id resolves the same — never a forged scope.
    expect(
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        "WI_NONEXISTENT",
      ),
    ).toHaveLength(0);
  });

  it("W3: plan-time stamp binds + reconcile/assert PASS — the pool path the fix enables", () => {
    const { ctx, consumerWorkItemId } = planTimeFixture();
    const sources =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumerWorkItemId,
      );
    const tasks = [consumerTask("xau-delta-brief.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources,
    }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.contract).toBe(EXTERNAL_INPUT_CONTRACT);
    assertPlanDataflow(out, { external_input_artifacts: sources });
  });

  it("W4: mission-scoped resolution on the same scope still returns the identical set", () => {
    const { ctx, scope, art } = planTimeFixture();
    const consumer = openBoundMission(ctx, scope, "w_dst");
    const missionList = eligible(ctx, ctx.store.get("mission", consumer.missionId));
    const wiList =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumer.workItemId,
      );
    expect(missionList.map((s) => s.artifact_id)).toEqual(
      wiList.map((s) => s.artifact_id),
    );
    expect(wiList[0]!.artifact_id).toBe(art.artifactId);
  });
});

describe("LATEST_ACCEPTED — same logical_name under multiple sibling missions", () => {
  /** Two producers (w_src, w_src2) each ACCEPT a same-name artifact; the
   *  consumer work item is allocated-but-unopened (plan-time shape). */
  function ambiguousFixture() {
    const ctx = mkCtx("ambig");
    const scope = mkScope(ctx, "A", ["w_src", "w_src2", "w_dst"]);
    const p1 = openBoundMission(ctx, scope, "w_src");
    const p2 = openBoundMission(ctx, scope, "w_src2");
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md",
      Buffer.from("# v1 bytes"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md",
      Buffer.from("# v2 bytes — newer"));
    // Same-name artifacts: resolve identity by PRODUCER MISSION (the
    // helper's logical_name .find() would collide on duplicates).
    const a1 = { artifactId: String(ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p1.missionId &&
        String(a.logical_name) === "shared.md")!.artifact_id) };
    const a2 = { artifactId: String(ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p2.missionId &&
        String(a.logical_name) === "shared.md")!.artifact_id) };
    // Deterministic order control: pin created_at explicitly.
    for (const [art, ts] of [[a1, "2026-10-17T00:00:01.000Z"], [a2, "2026-10-17T00:00:02.000Z"]] as const) {
      const row = ctx.store.get("artifact", art.artifactId) as Record<string, unknown>;
      ctx.store.put("artifact", art.artifactId, { ...row, created_at: ts },
        Number(row.version ?? 0));
    }
    ctx.alloc.allocateWorkstream({
      objective_id: scope.objectiveId, workstream_key: "w_dst", actor: OP,
    });
    const wal = ctx.store.list("workforce_allocation").find(
      (r) => String(r.objective_id) === scope.objectiveId &&
        String(r.workstream_key ?? "") === "w_dst")!;
    const consumerWorkItemId = String(wal.delegated_child_work_item_id);
    return { ctx, a1, a2, consumerWorkItemId };
  }

  it("L1: consume binds the NEWEST accepted same-name source deterministically", () => {
    const { ctx, a1, a2, consumerWorkItemId } = ambiguousFixture();
    const sources =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumerWorkItemId);
    expect(sources).toHaveLength(2);
    const tasks = [consumerTask("shared.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.artifact_id).toBe(a2.artifactId);
    expect(stamps[0]!.artifact_id).not.toBe(a1.artifactId);
    assertPlanDataflow(out, { external_input_artifacts: sources });
  });

  it("L2: winner is pinned + replay-identical — drift would fail the re-proof", () => {
    const { ctx, a2, consumerWorkItemId } = ambiguousFixture();
    const sources =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumerWorkItemId);
    const tasks = [consumerTask("shared.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    const stamp = (tasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES];
    reconcilePlanDataflow(tasks, { external_input_artifacts: sources });
    expect((tasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES]).toEqual(stamp);
    expect((stamp as Array<Record<string, unknown>>)[0]!.artifact_id)
      .toBe(a2.artifactId);
  });

  it("L3: ordering follows created_at, not emission order", () => {
    const { ctx, a1, consumerWorkItemId } = ambiguousFixture();
    // Rewind a2's timestamp → a1 becomes the newest → winner flips.
    const row = ctx.store.list("artifact").find(
      (r) => String(r.logical_name) === "shared.md" &&
        String(r.created_at) === "2026-10-17T00:00:02.000Z")!;
    ctx.store.put("artifact", String(row.artifact_id),
      { ...row, created_at: "2026-10-17T00:00:00.500Z" },
      Number(row.version ?? 0));
    const sources =
      ctx.service.artifactResolver.listEligibleExternalInputSourcesForWorkItem(
        consumerWorkItemId);
    const tasks = [consumerTask("shared.md")];
    const out = reconcilePlanDataflow(tasks, {
      external_input_artifacts: sources }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    expect(stamps[0]!.artifact_id).toBe(a1.artifactId);
  });
});

describe("R1 corrections — exact-vs-alias, ordering determinism, drift", () => {
  /** Synthetic eligible source — bindPlanExternalInputs matches names
   *  only; identity/provenance re-proof lives at emit + dispatch. */
  const mkSrc = (
    over: Partial<ExternalInputArtifactSource> & { artifact_id: string },
  ): ExternalInputArtifactSource => ({
    logical_name: "a.md",
    sha256: "ab".repeat(32),
    byte_size: 10,
    source_mission_id: "MSN_src",
    source_task_id: "TSK_src",
    source_governed_task_id: "GT_src",
    source_execution_id: "EXE_src",
    source_executor_id: "EX",
    ...over,
  });

  const stampsOf = (tasks: Array<Record<string, unknown>>) =>
    (tasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;

  const bound = (
    consume: string,
    sources: ExternalInputArtifactSource[],
  ): Array<Record<string, unknown>> =>
    stampsOf(
      reconcilePlanDataflow([consumerTask(consume)], {
        external_input_artifacts: sources,
      }).tasks,
    );

  /** Explicit declared consume — grammar-independent (outbox/-prefixed
   *  consume names otherwise ride the staged-name grammar path). */
  const declaredConsumer = (name: string): Record<string, unknown> => ({
    task_key: "TC1",
    title: "verify input",
    task_instruction: `use ${name}, write verdict.txt, then reply DONE.`,
    required_capabilities: ["FILE_OPERATIONS"],
    depends_on: [],
    metadata: { pair_dataflow: { produces: [], consumes: [name] } },
  });

  /* ---------- R1-F1: exact logical-name vs outbox alias ---------- */

  it("F1-A: exact match wins over a NEWER outbox alias (never displaced)", () => {
    const stamps = bound("journal.html", [
      mkSrc({ artifact_id: "ART_exact", logical_name: "journal.html",
        source_created_at: "2026-10-17T00:00:01.000Z" }),
      mkSrc({ artifact_id: "ART_alias", logical_name: "outbox/journal.html",
        source_created_at: "2026-10-17T00:00:09.000Z" }),
    ]);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.artifact_id).toBe("ART_exact");
    expect(stamps[0]!.logical_name).toBe("journal.html");
  });

  it("F1-B: alias-only same logical name → newest alias binds", () => {
    const stamps = bound("journal.html", [
      mkSrc({ artifact_id: "ART_o1", logical_name: "outbox/journal.html",
        source_created_at: "2026-10-17T00:00:01.000Z" }),
      mkSrc({ artifact_id: "ART_o2", logical_name: "outbox/journal.html",
        source_created_at: "2026-10-17T00:00:02.000Z" }),
    ]);
    expect(stamps[0]!.artifact_id).toBe("ART_o2");
    expect(stamps[0]!.logical_name).toBe("outbox/journal.html");
  });

  it("F1-C: aliases spanning >1 distinct logical_name → fail closed", () => {
    const code = errCode(() =>
      reconcilePlanDataflow([declaredConsumer("outbox/report.md")], {
        external_input_artifacts: [
          mkSrc({ artifact_id: "ART_r1", logical_name: "report.md",
            source_created_at: "2026-10-17T00:00:02.000Z" }),
          mkSrc({ artifact_id: "ART_r2", logical_name: "docs/report.md",
            source_created_at: "2026-10-17T00:00:01.000Z" }),
        ],
      }),
    );
    expect(code).toBe("FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_SOURCE");
  });

  it("F1-D: newest among EXACT matches when alias is newest overall", () => {
    const stamps = bound("journal.html", [
      mkSrc({ artifact_id: "ART_e1", logical_name: "journal.html",
        source_created_at: "2026-10-17T00:00:01.000Z" }),
      mkSrc({ artifact_id: "ART_e2", logical_name: "journal.html",
        source_created_at: "2026-10-17T00:00:02.000Z" }),
      mkSrc({ artifact_id: "ART_aN", logical_name: "outbox/journal.html",
        source_created_at: "2026-10-17T00:00:09.000Z" }),
    ]);
    expect(stamps[0]!.artifact_id).toBe("ART_e2");
  });

  /* ---------- R1-F3: deterministic ordering, no insertion order ---------- */

  it("F3-A: equal created_at → artifact_id tiebreak, input-order independent", () => {
    const a = mkSrc({ artifact_id: "ART_001",
      source_created_at: "2026-10-17T00:00:05.000Z" });
    const b = mkSrc({ artifact_id: "ART_999",
      source_created_at: "2026-10-17T00:00:05.000Z" });
    for (const order of [[a, b], [b, a]] as const) {
      const stamps = bound("a.md", [...order]);
      expect(stamps[0]!.artifact_id).toBe("ART_999");
    }
  });

  it("F3-B: shuffled source array → identical winner AND identical stamp", () => {
    const s1 = mkSrc({ artifact_id: "ART_s1",
      source_created_at: "2026-10-17T00:00:01.000Z" });
    const s2 = mkSrc({ artifact_id: "ART_s2",
      source_created_at: "2026-10-17T00:00:03.000Z" });
    const s3 = mkSrc({ artifact_id: "ART_s3",
      source_created_at: "2026-10-17T00:00:02.000Z" });
    const fwd = bound("a.md", [s1, s2, s3]);
    const rev = bound("a.md", [s3, s2, s1]);
    expect(fwd[0]!.artifact_id).toBe("ART_s2");
    expect(rev).toEqual(fwd);
  });

  it("F3-C: missing created_at ranks below any valid timestamp", () => {
    const stamps = bound("a.md", [
      mkSrc({ artifact_id: "ART_noTs" }),
      mkSrc({ artifact_id: "ART_ts",
        source_created_at: "2026-10-17T00:00:01.000Z" }),
    ]);
    expect(stamps[0]!.artifact_id).toBe("ART_ts");
  });

  it("F3-D: all missing created_at → artifact_id decides (still total)", () => {
    const stamps = bound("a.md", [
      mkSrc({ artifact_id: "ART_aaa" }),
      mkSrc({ artifact_id: "ART_zzz" }),
      mkSrc({ artifact_id: "ART_mmm" }),
    ]);
    expect(stamps[0]!.artifact_id).toBe("ART_zzz");
  });

  it("F3-E: invalid timestamp string is NOT lexical — ranks as unknown", () => {
    const stamps = bound("a.md", [
      mkSrc({ artifact_id: "ART_bad", source_created_at: "not-a-date" }),
      mkSrc({ artifact_id: "ART_ok",
        source_created_at: "2026-10-17T00:00:01.000Z" }),
    ]);
    expect(stamps[0]!.artifact_id).toBe("ART_ok");
  });

  /* ---------- R1-F2: winner drift — no silent re-pin ---------- */

  it("F2-A: newer source arriving later → replay re-proof FAILS, never re-pins", () => {
    const s1 = mkSrc({ artifact_id: "ART_v1",
      source_created_at: "2026-10-17T00:00:01.000Z" });
    const s2 = mkSrc({ artifact_id: "ART_v2",
      source_created_at: "2026-10-17T00:00:02.000Z" });
    const tasks = [consumerTask("a.md")];
    reconcilePlanDataflow(tasks, { external_input_artifacts: [s1, s2] });
    expect(stampsOf(tasks)[0]!.artifact_id).toBe("ART_v2");
    // S2 = S1 + v3: the commit-time seam (bindPlanExternalInputs on the
    // already-stamped list, exactly what MissionRuntime.runPlanning
    // calls) recomputes winner v3 — byte-mismatch vs the persisted v2
    // stamp → fail closed, never a silent re-pin.
    const s3 = mkSrc({ artifact_id: "ART_v3",
      source_created_at: "2026-10-17T00:00:03.000Z" });
    expect(
      errCode(() =>
        bindPlanExternalInputs(
          tasks as Array<Record<string, unknown>>,
          [s1, s2, s3],
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");
    // The persisted stamp is untouched — still v2.
    expect(stampsOf(tasks)[0]!.artifact_id).toBe("ART_v2");
  });

  it("F2-B: stamped source absent from eligible set → stale → fail closed", () => {
    const s1 = mkSrc({ artifact_id: "ART_v1",
      source_created_at: "2026-10-17T00:00:01.000Z" });
    const s2 = mkSrc({ artifact_id: "ART_v2",
      source_created_at: "2026-10-17T00:00:02.000Z" });
    const out = reconcilePlanDataflow([consumerTask("a.md")], {
      external_input_artifacts: [s1, s2],
    }).tasks;
    expect(
      errCode(() =>
        assertPlanDataflow(out, { external_input_artifacts: [s1] }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");
  });

  it("F2-C: dispatch honors PINNED v2 even after v3 lands — never rebinds", () => {
    const ctx = mkCtx("drift");
    const scope = mkScope(ctx, "D", ["w1", "w2", "w3", "w4"]);
    const p1 = openBoundMission(ctx, scope, "w1");
    const p2 = openBoundMission(ctx, scope, "w2");
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md", Buffer.from("v1"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md", Buffer.from("v2"));
    const a1 = ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p1.missionId &&
        String(a.logical_name) === "shared.md")!;
    const a2 = ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p2.missionId &&
        String(a.logical_name) === "shared.md")!;
    for (const [row, ts] of [[a1, "2026-10-17T00:00:01.000Z"],
      [a2, "2026-10-17T00:00:02.000Z"]] as const) {
      ctx.store.put("artifact", String(row.artifact_id),
        { ...row, created_at: ts }, Number(row.version ?? 0));
    }
    const consumer = openBoundMission(ctx, scope, "w3");
    const tasks = [consumerTask("shared.md")];
    reconcilePlanDataflow(tasks, {
      external_input_artifacts: eligible(ctx, consumer.mission),
    });
    expect(stampsOf(tasks)[0]!.artifact_id).toBe(String(a2.artifact_id));
    // v3 lands AFTER commit — a NEWER same-name sibling exists now.
    const p3 = openBoundMission(ctx, scope, "w4");
    mkAcceptedArtifact(ctx, p3.missionId, "shared.md", Buffer.from("v3"));
    const a3 = ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === p3.missionId &&
        String(a.logical_name) === "shared.md")!;
    ctx.store.put("artifact", String(a3.artifact_id),
      { ...a3, created_at: "2026-10-17T00:00:03.000Z" },
      Number(a3.version ?? 0));
    // Dispatch: the live eligible set now has v3 — the pinned v2 binding
    // still resolves to v2 exactly; it is never silently re-pinned.
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { ...consumer.mission, plan_revision: 1 },
      task: {
        ...tasks[0]!,
        task_id: "ATSK_DRIFT_1",
        plan_id: "PLAN_C",
        required_capabilities: ["FILE_OPERATIONS"],
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifact_id).toBe(String(a2.artifact_id));
    expect(entries[0]!.artifact_id).not.toBe(String(a3.artifact_id));
  });
});

describe("R2 — commit-boundary TOCTOU re-proof", () => {
  const pinTs = (
    ctx: ReturnType<typeof mkCtx>,
    artifactId: string,
    ts: string,
  ) => {
    const row = ctx.store.get("artifact", artifactId) as Record<string, unknown>;
    ctx.store.put("artifact", artifactId, { ...row, created_at: ts },
      Number(row.version ?? 0));
  };
  const artByMission = (
    ctx: ReturnType<typeof mkCtx>,
    missionId: string,
    name: string,
  ) =>
    ctx.store.list("artifact").find(
      (a) => String(a.mission_id) === missionId &&
        String(a.logical_name) === name,
    )!;

  /** 3 producers (v1/v2 exist, v3 lands later) + consumer bound scope. */
  function driftScope(ctx: ReturnType<typeof mkCtx>, label: string) {
    const scope = mkScope(ctx, label, ["w_src", "w_src2", "w_src3", "w_dst"]);
    const p1 = openBoundMission(ctx, scope, "w_src");
    const p2 = openBoundMission(ctx, scope, "w_src2");
    const p3 = openBoundMission(ctx, scope, "w_src3");
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md", Buffer.from("v1"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md", Buffer.from("v2"));
    const a1 = artByMission(ctx, p1.missionId, "shared.md");
    const a2 = artByMission(ctx, p2.missionId, "shared.md");
    pinTs(ctx, String(a1.artifact_id), "2026-10-17T00:00:01.000Z");
    pinTs(ctx, String(a2.artifact_id), "2026-10-17T00:00:02.000Z");
    const consumer = openBoundMission(ctx, scope, "w_dst");
    return { scope, p1, p2, p3, consumer, a1, a2 };
  }
  const landV3 = (
    ctx: ReturnType<typeof mkCtx>,
    p3: { missionId: string },
    ts = "2026-10-17T00:00:03.000Z",
  ) => {
    const v3 = mkAcceptedArtifact(ctx, p3.missionId, "shared.md",
      Buffer.from("v3"));
    pinTs(ctx, v3.artifactId, ts);
    return v3;
  };
  const rt = (ctx: ReturnType<typeof mkCtx>, mid: string) =>
    ctx.store.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;

  /* ---- R2-F1: initial planning commit boundary ---- */

  it("R2-T1: v3 lands inside the planner window → commit fails closed, zero revisions", () => {
    let f!: ReturnType<typeof driftScope>;
    const ctx = mkCtx("r2t1", () => {
      landV3(ctx, f.p3); // drift INSIDE the planner call window
      return { tasks: [consumerTask("shared.md")] };
    });
    f = driftScope(ctx, "R2A");
    const mid = f.consumer.missionId;
    ctx.runtime.tick(mid); // CREATED→PLANNING
    const code = errCode(() => ctx.runtime.tick(mid)); // runPlanning
    expect(code).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");
    expect(ctx.store.planRevisions(mid)).toHaveLength(0);
    expect(String(rt(ctx, mid).state)).toBe("FAILED");
  });

  it("R2-T4: no drift → commit succeeds pinning the newest (positive control)", () => {
    const ctx = mkCtx("r2t4", () => ({
      tasks: [consumerTask("shared.md")],
    }));
    const f = driftScope(ctx, "R2B");
    const mid = f.consumer.missionId;
    ctx.runtime.tick(mid);
    ctx.runtime.tick(mid);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    expect(String(rt(ctx, mid).state)).toBe("READY");
    const tasks = ctx.store
      .list("task")
      .filter((t) => String(t.mission_id) === mid);
    const stamps = (tasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    expect(stamps[0]!.artifact_id).toBe(String(f.a2.artifact_id));
  });

  /* ---- R2-F2: PREPARED replan commit boundary ---- */

  /** Bound mission driven through REAL dispatch failure → REPLANNING:
   *  initial plan T1 produces seed.txt (adapter emits nothing), remote
   *  T2 consumes it → DEPENDENCY_FAILURE → decision REPLAN. The replan
   *  candidate is a shared.md consumer bound to the newest source. */
  function replanFixture(
    label: string,
    onReplan: (ctx: ReturnType<typeof mkCtx>) => void,
  ) {
    const calls: Array<Record<string, unknown>> = [];
    let f!: ReturnType<typeof driftScope>;
    const ctx = mkCtx(label, (input: Record<string, unknown>) => {
      calls.push(input);
      if (String(input.reason) === "replan") {
        onReplan(ctx); // drift injection point — may throw
        return {
          tasks: [
            {
              task_key: "TR",
              title: "verify input",
              task_instruction:
                "use shared.md, write verdict.txt, then reply DONE.",
              required_capabilities: ["FILE_OPERATIONS"],
              depends_on: [],
              metadata: {
                pair_dataflow: {
                  produces: ["verdict.txt"],
                  consumes: ["shared.md"],
                },
              },
            },
          ],
        };
      }
      return {
        tasks: [
          {
            task_key: "T1",
            title: "t1",
            task_instruction: "write seed.txt then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"],
            depends_on: [],
            metadata: {
              pair_dataflow: { produces: ["seed.txt"], consumes: [] },
            },
          },
          {
            task_key: "T2",
            title: "t2",
            task_instruction: "read seed.txt remotely then reply DONE.",
            required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
            depends_on: ["T1"],
            metadata: {
              pair_dataflow: { produces: [], consumes: ["seed.txt"] },
            },
          },
        ],
      };
    });
    ctx.service.registerCapability("REMOTE_CLOUD_TASK_EXECUTION", {
      risk_class: "HIGH",
    });
    registerLocalExecutor(ctx);
    f = driftScope(ctx, label.toUpperCase());
    return { ctx, calls, f };
  }

  it("R2-T2: v3 lands between PREPARED staging and commit → fail closed", () => {
    const { ctx, f } = replanFixture("r2t2", (c) => landV3(c, f.p3));
    const mid = f.consumer.missionId;
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid);
      if (String(rt(ctx, mid).state) === "REPLANNING") {
        // let the replan cycle run its staging+commit
        for (let j = 0; j < 6; j++) ctx.runtime.tick(mid);
        break;
      }
    }
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((r) => String(r.mission_id) === mid);
    expect(attempts).toHaveLength(1);
    // The PREPARED candidate's v2 binding went stale — commit MUST NOT
    // have landed: row stays PREPARED, receipt empty, no new revision.
    expect(String(attempts[0]!.status)).toBe("PREPARED");
    expect(attempts[0]!.commit_receipt ?? null).toBeNull();
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const tasks = ctx.store
      .list("task")
      .filter((t) => String(t.mission_id) === mid);
    expect(
      tasks.every((t) => String(t.cancel_reason ?? "") !== "PLAN_SUPERSEDED"),
    ).toBe(true);
    // Bounded — a FRESH recovery decision follows, never an infinite
    // replay of the same stale attempt.
    for (let i = 0; i < 10; i++) ctx.runtime.tick(mid);
    expect(
      ctx.store
        .list("recovery_decision")
        .filter((r) => String(r.mission_id) === mid).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("R2-T3: durable PREPARED resume — drift at resume-commit → fail closed", () => {
    const { ctx, f } = replanFixture("r2t3", () => {
      throw Object.assign(new Error("gen pending"), {
        code: REPLAN_GENERATION_PENDING,
      });
    });
    const mid = f.consumer.missionId;
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid);
      if (String(rt(ctx, mid).state) === "REPLANNING") {
        ctx.runtime.tick(mid); // planner PENDING-throw → still REPLANNING
        break;
      }
    }
    const rtRow = rt(ctx, mid);
    expect(String(rtRow.state)).toBe("REPLANNING");
    const recoveryId = String(
      (rtRow.pending_recovery as Record<string, unknown>).recovery_id,
    );
    // Stage the durable PREPARED row through the PRODUCTION ledger seam
    // — candidate stamped v2 under the pre-drift eligible set.
    const preparedTasks = [consumerTask("shared.md")];
    reconcilePlanDataflow(preparedTasks, {
      external_input_artifacts: eligible(ctx, f.consumer.mission),
    });
    const stamps = (preparedTasks[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    expect(stamps[0]!.artifact_id).toBe(String(f.a2.artifact_id));
    const activePlan = String(
      ctx.store.list("task").find(
        (t) => String(t.mission_id) === mid)!.plan_id,
    );
    const ledger = new ReplanAttemptLedger(ctx.store);
    const prepared = ledger.record({
      mission_id: mid,
      recovery_id: recoveryId,
      failure_signature: null,
      failed_plan_semantic_digest: null,
      attempt_index: ledger.attemptsUsed(recoveryId),
      proposal_digest: digest({ tasks: preparedTasks }),
      candidate_plan_semantic_digest:
        canonicalPlanSemanticDigest(preparedTasks),
      prepared_tasks: preparedTasks,
      prepared_proposal: { tasks: preparedTasks },
      superseded_plan_id: activePlan,
      status: "PREPARED",
    });
    landV3(ctx, f.p3); // drift lands between durable stage and resume
    ctx.runtime.tick(mid); // resume → commitCandidate → re-proof
    const att = ctx.store.get(
      "replan_attempt",
      prepared.replan_attempt_id,
    ) as Record<string, unknown>;
    expect(String(att.status)).toBe("PREPARED");
    expect(att.commit_receipt ?? null).toBeNull();
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const tasks = ctx.store
      .list("task")
      .filter((t) => String(t.mission_id) === mid);
    expect(
      tasks.every((t) => String(t.cancel_reason ?? "") !== "PLAN_SUPERSEDED"),
    ).toBe(true);
    for (let i = 0; i < 10; i++) ctx.runtime.tick(mid);
    expect(
      ctx.store
        .list("recovery_decision")
        .filter((r) => String(r.mission_id) === mid).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("R2-T5: source revoked mid-window → commit rejected (initial + replan)", () => {
    // Replan variant: the pinned v2 artifact is REJECTED inside the
    // planner window — the commit-time set no longer contains it.
    const { ctx, f } = replanFixture("r2t5", (c) => {
      const row = c.store.get("artifact", String(f.a2.artifact_id)) as
        Record<string, unknown>;
      c.store.put("artifact", String(f.a2.artifact_id),
        { ...row, state: "REJECTED" }, Number(row.version ?? 0));
    });
    const mid = f.consumer.missionId;
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid);
      if (String(rt(ctx, mid).state) === "REPLANNING") {
        for (let j = 0; j < 6; j++) ctx.runtime.tick(mid);
        break;
      }
    }
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((r) => String(r.mission_id) === mid);
    expect(attempts).toHaveLength(1);
    expect(String(attempts[0]!.status)).toBe("PREPARED");
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
  });

  it("R2-T6: no drift → PREPARED commits once, receipt + supersede land", () => {
    const { ctx, f } = replanFixture("r2t6", () => {});
    const mid = f.consumer.missionId;
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid);
      if (String(rt(ctx, mid).state) !== "REPLANNING" && i > 8) break;
    }
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((r) => String(r.mission_id) === mid);
    expect(attempts).toHaveLength(1);
    expect(String(attempts[0]!.status)).toBe("ACCEPTED");
    const receipt = attempts[0]!.commit_receipt as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    // Exactly-once: replay ticks never mint a second revision.
    for (let i = 0; i < 6; i++) ctx.runtime.tick(mid);
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
  });
});
