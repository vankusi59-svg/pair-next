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
import { describe, expect, it } from "vitest";
import {
  artifactDependencySetDigest,
  ArtifactProvenanceValidator,
  ApprovalQueue,
  bindPlanExternalInputs,
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
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
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
    workstreams, alloc, plannerCalls, registry,
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

  it("B2: ambiguous source (same name, two artifact ids) → fail closed", () => {
    const ctx = mkCtx("amb");
    const scope = mkScope(ctx, "AMB", ["w1", "w2", "w3"]);
    const p1 = openBoundMission(ctx, scope, "w1");
    const p2 = openBoundMission(ctx, scope, "w2");
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md", Buffer.from("one"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md", Buffer.from("two"));
    const consumer = openBoundMission(ctx, scope, "w3");
    const sources = eligible(ctx, consumer.mission);
    expect(sources).toHaveLength(2);
    expect(
      errCode(() =>
        reconcilePlanDataflow([consumerTask("shared.md")], {
          external_input_artifacts: sources,
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_SOURCE");
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
});
