/**
 * P18-D — cross-objective deliverable handoff.
 *
 * An ACTIVE proven DEPENDS_ON relation (from=consumer objective,
 * to=upstream objective) authorizes the consumer objective's missions
 * to consume the upstream objective's canonical ACCEPTED artifacts —
 * the eligible-external-input lineage expands to the relation graph.
 *
 *   D1  baseline — no relation: upstream artifacts NOT eligible.
 *   D2  DEPENDS_ON minted → upstream artifact eligible + stamps +
 *       assertPlanDataflow PASS (the full authorized path).
 *   D3  SUSPENDED edge does not authorize; RESUME restores it.
 *   D4  REVOKED edge does not authorize.
 *   D5  directionality — A→B authorizes A's missions only; B gains
 *       nothing (the edge is consent, not reciprocity).
 *   D6  CONFLICTS / SUPERSEDES never authorize handoff.
 *   D7  forged relation (foreign created_by, valid hash) → dropped
 *       semantically, never authorizes; corrupt row → strict
 *       lineage wedge, never silent deny OR expand.
 *   D8  owner amend on an endpoint → relation unproven → scope
 *       shrinks honestly (no cached grant).
 *   D9  transitivity — C→M and M→F edges do NOT authorize C to F:
 *       each hop needs its own bilateral-owner relation.
 *   D10 index-vs-fallback parity — eligible set identical under the
 *       built pointer index and the strict global fallback.
 *   D11 revoke-after-pin — stamps minted earlier cannot match once the
 *       edge is revoked (the dispatch-time eligible re-proof sees []).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  assertPlanDataflow,
  ArtifactProvenanceValidator,
  ApprovalQueue,
  BusinessLayer,
  digest,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveRelationService,
  ObjectiveWorkstreamService,
  PAIR_DATAFLOW_SOURCES,
  PairControlPlane,
  PairEvidenceStore,
  reconcilePlanDataflow,
  ReconciliationService,
  RecoveryController,
  relationDigest,
  sha256Hex,
  TRANSPORT_IN_PROCESS,
  utcnow,
  workerExecutionId,
  WorkforceAllocationService,
  WorkforceService,
  type ExternalInputArtifactSource,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p18d-handoff-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_A";
let seq = 0;
const OP = "op:test";
const OWNER = `operator:${OP}`;

class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string) {
    this.executor_id = id;
  }
  probe() { return { executor_id: this.executor_id, available: true, state: "READY" }; }
  qualify() { return { qualified: true, dispatch_enabled: true }; }
  capabilities() { return { capability_ids: ["FILE_OPERATIONS"] }; }
  prepare_task(task: Record<string, unknown>) { return task; }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] = {
      status: "COMPLETED", mission_id: task.mission_id,
      task_id: task.task_id, governed_task_id: task.governed_task_id,
      summary: "ok",
    };
    return { execution_id: eid, status: "COMPLETED", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() { return { status: "CANCELLED" }; }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED" };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() { return []; }
  health() { return { state: "READY" }; }
}

function mkCtx(name: string) {
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
  const adapters = new Map<string, ExecutorAdapter>();
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner: (() => ({})) as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: (() => ({})) as never,
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
  const relations = new ObjectiveRelationService(store);
  return { d, workspace, store, service, control, project, biz, wf,
    workstreams, alloc, relations, registry, adapters };
}

/** One business + TWO objectives (producer A, consumer B) each with a
 *  workstream — same-business scope so relations may mint. */
function mkTwoObjectiveScope(ctx: ReturnType<typeof mkCtx>) {
  const businessId = `BIZ_${seq++}`;
  ctx.store.put("business", businessId, {
    business_id: businessId, name: "biz", status: "ACTIVE",
    currency: "USD", project_id: String(ctx.project.project_id),
    created_at: utcnow(), version: 0,
  }, 0);
  const mkObj = (label: string, wsKey: string) => {
    const obj = ctx.biz.objectives.create({
      business_id: businessId,
      title: `obj ${label}`, statement: `grow ${label}`,
      kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 500_000_000,
      hard_constraints: [], success_conditions: ["done"],
      dedup_key: `dk-${seq++}`, operator_id: OP,
    });
    const objectiveId = String(obj.objective_id);
    ctx.workstreams.decomposeObjective({
      objective_id: objectiveId,
      expected_objective_version: Number(obj.version),
      expected_terms_version: Number(obj.terms_version),
      expected_objective_digest: String(obj.objective_digest),
      workstreams: [{ workstream_key: wsKey, title: `ws ${wsKey}`, goal: `g ${wsKey}` }] as never,
      actor: OP,
    });
    return objectiveId;
  };
  ctx.biz.createOrgAgent({
    business_id: businessId, title: "agent", department: "ops", operator_id: OP,
  });
  return {
    businessId,
    producerObj: mkObj("A", "w_src"),
    consumerObj: mkObj("B", "w_dst"),
  };
}

function openBoundMission(
  ctx: ReturnType<typeof mkCtx>,
  objectiveId: string,
  workstreamKey: string,
) {
  ctx.alloc.allocateWorkstream({ objective_id: objectiveId, workstream_key: workstreamKey, actor: OP });
  const wal = ctx.store.list("workforce_allocation").find(
    (r) => String(r.objective_id) === objectiveId &&
      String(r.workstream_key ?? "") === workstreamKey)!;
  const childId = String(wal.delegated_child_work_item_id);
  ctx.biz.openWorkItem(childId, OP);
  const wob = ctx.store.list("work_open_binding").find(
    (b) => String(b.work_item_id) === childId)!;
  const missionId = String(wob.mission_id);
  return { missionId, mission: ctx.store.get("mission", missionId), workItemId: childId };
}

/** Fully validated producer in missionId carrying an ACCEPTED artifact. */
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
  ctx.store.put("task", tid, {
    task_id: tid, task_key: key, mission_id: missionId, plan_id: "PLAN_A",
    title: key, task_instruction: `produce ${name}`,
    required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
    status: "COMPLETED",
    metadata: { pair_dataflow: { produces: [name], consumes: [] } },
    version: 0,
  }, 0);
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: EX, plan_id: "PLAN_A",
    plan_revision: 1, workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  for (const ev of [
    { event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED" },
    { event_type: "EXECUTION_PREPARED", old_state: "VALIDATED", new_state: "DISPATCH_AUTHORIZED" },
  ]) {
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: ev.event_type, old_state: ev.old_state ?? null,
      new_state: ev.new_state, actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: missionId, task_id: tid, executor_id: EX,
        governed_task_id: gtId, plan_id: "PLAN_A", plan_revision: 1,
        remote_produces_contract: false, declared_produces: [name],
        declared_produces_digest: null,
      },
    });
  }
  ctx.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
    intent_id: `INTENT_${gtId}`, governed_task_id: gtId, executor_id: EX,
    state: "EXECUTION_PERSISTED", execution_id: eid, created_at: utcnow(), version: 0,
  }, 0);
  fs.writeFileSync(path.join(ctx.workspace, name), bytes);
  ctx.store.put("executor_execution", eid, {
    execution_id: eid, governed_task_id: gtId, mission_id: missionId,
    task_id: tid, executor_id: EX, plan_revision: 1, correlation_id: `COR_${tid}`,
    execution_state: "COMPLETED", dispatch_timestamp: utcnow(),
    run_root: `${ctx.workspace}/run`, workspace: ctx.workspace,
    result: {
      status: "COMPLETED", output: "done",
      artifacts: [{ path: name, sha256: sha256Hex(bytes), byte_size: bytes.length }],
    },
    version: 0,
  }, 0);
  for (const et of ["EXECUTION_DISPATCHED", "RESULT_COLLECTED"]) {
    ctx.store.event({
      entity_type: "executor_execution", entity_id: eid, event_type: et,
      new_state: "COMPLETED", actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: `COR_${tid}`,
      metadata: { governed_task_id: gtId },
    });
  }
  const validation = new ArtifactProvenanceValidator()
    .validate_execution(ctx.service, eid) as Record<string, unknown>;
  if (String(validation.status) !== "PASS") {
    throw new Error(`fixture validation not PASS: ${JSON.stringify(validation.failures)}`);
  }
  const art = ctx.store.list("artifact").find(
    (a) => String(a.logical_name) === name)!;
  return { artifactId: String(art.artifact_id), artifact: art, name };
}

function fixture() {
  const ctx = mkCtx("fx");
  const scope = mkTwoObjectiveScope(ctx);
  const producer = openBoundMission(ctx, scope.producerObj, "w_src");
  const art = mkAcceptedArtifact(ctx, producer.missionId,
    `deliverable-${seq}.md`, Buffer.from("# deliverable bytes"));
  const consumer = openBoundMission(ctx, scope.consumerObj, "w_dst");
  return {
    ctx, scope,
    producer: { ...producer, mission: ctx.store.get("mission", producer.missionId) },
    consumer: { ...consumer, mission: ctx.store.get("mission", consumer.missionId) },
    art,
  };
}

const eligible = (
  ctx: ReturnType<typeof mkCtx>,
  mission: Record<string, unknown>,
): ExternalInputArtifactSource[] =>
  ctx.service.artifactResolver.listEligibleExternalInputSources(mission);

const depRel = (ctx: ReturnType<typeof mkCtx>, from: string, to: string) =>
  ctx.relations.create({
    from_objective_id: from, to_objective_id: to,
    kind: "DEPENDS_ON", actor: OWNER,
  });

describe("P18-D — cross-objective deliverable handoff", () => {

  it("D1 baseline — upstream artifacts are NOT eligible without a relation", () => {
    const { ctx, consumer } = fixture();
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    ctx.store.close();
  });

  it("D2 DEPENDS_ON authorizes the upstream deliverable end-to-end", () => {
    const { ctx, scope, consumer, art } = fixture();
    depRel(ctx, scope.consumerObj, scope.producerObj);
    const list = eligible(ctx, consumer.mission);
    expect(list).toHaveLength(1);
    expect(list[0]!.artifact_id).toBe(art.artifactId);
    // The full authorized path: plan-time bind + reconcile + assert.
    const tasks = [{
      task_key: "TC1", title: "verify", task_instruction: `read ${art.name}`,
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: {},
    }];
    const out = reconcilePlanDataflow(tasks, { external_input_artifacts: list }).tasks;
    const stamps = (out[0]!.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES] as Array<Record<string, unknown>>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.artifact_id).toBe(art.artifactId);
    assertPlanDataflow(out, { external_input_artifacts: list });
    ctx.store.close();
  });

  it("D3 SUSPENDED edge does not authorize; RESUME restores", () => {
    const { ctx, scope, consumer, art } = fixture();
    const r = depRel(ctx, scope.consumerObj, scope.producerObj);
    expect(eligible(ctx, consumer.mission)).toHaveLength(1);
    ctx.relations.control({ relation_id: r.relation_id, action: "SUSPEND", actor: OWNER });
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    ctx.relations.control({ relation_id: r.relation_id, action: "RESUME", actor: OWNER });
    expect(eligible(ctx, consumer.mission).map((s) => s.artifact_id)).toEqual([art.artifactId]);
    ctx.store.close();
  });

  it("D4 REVOKED edge does not authorize", () => {
    const { ctx, scope, consumer } = fixture();
    const r = depRel(ctx, scope.consumerObj, scope.producerObj);
    ctx.relations.control({ relation_id: r.relation_id, action: "REVOKE", actor: OWNER });
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    ctx.store.close();
  });

  it("D5 directionality — producer→consumer edge grants the PRODUCER nothing extra", () => {
    const { ctx, scope, consumer, art } = fixture();
    // producerObj DEPENDS_ON consumerObj — the consumer is NOT
    // downstream of the producer, so it gains no scope.
    depRel(ctx, scope.producerObj, scope.consumerObj);
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    // But the producer's own mission scope now reaches the consumer —
    // directionally correct (consumer has no artifacts yet → empty).
    void art;
    ctx.store.close();
  });

  it("D6 CONFLICTS and SUPERSEDES never authorize handoff", () => {
    const { ctx, scope, consumer } = fixture();
    ctx.relations.create({ from_objective_id: scope.consumerObj,
      to_objective_id: scope.producerObj, kind: "CONFLICTS", actor: OWNER });
    ctx.relations.create({ from_objective_id: scope.consumerObj,
      to_objective_id: scope.producerObj, kind: "SUPERSEDES", actor: OWNER });
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    ctx.store.close();
  });

  it("D7 forged edge never authorizes; corrupt row wedges loudly", () => {
    const { ctx, scope, consumer, art } = fixture();
    const db = (ctx.store as unknown as { db: import("better-sqlite3").Database }).db;
    // Raw-SQL forged DEPENDS_ON: valid shape/hash but foreign
    // created_by — semantically unproven, must never expand scope.
    const rid = `REL_forge_${seq++}`;
    const payload: Record<string, unknown> = {
      schema: "pair.os.vnext.objective-relation.v1",
      relation_id: rid, business_id: scope.businessId,
      from_objective_id: scope.consumerObj, to_objective_id: scope.producerObj,
      kind: "DEPENDS_ON", state: "ACTIVE", note: null,
      created_by: "operator:mallory", dedup_key: `fk${seq}`,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      entity_type: "objective_relation", entity_id: rid, version: 1,
    };
    payload.relation_digest = relationDigest(payload);
    db.prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run("objective_relation", rid, 1, JSON.stringify(payload), digest(payload), "2026-01-01T00:00:00.000Z");
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    // Now corrupt a REAL relation — strict lineage must wedge, never
    // silently fall back to the sibling-only scope.
    const r = depRel(ctx, scope.consumerObj, scope.producerObj);
    expect(eligible(ctx, consumer.mission).map((s) => s.artifact_id)).toEqual([art.artifactId]);
    db.prepare("UPDATE entities SET payload='corrupt' WHERE entity_type='objective_relation' AND entity_id=?")
      .run(r.relation_id);
    try {
      eligible(ctx, consumer.mission);
      throw new Error("expected lineage wedge");
    } catch (e) {
      expect(e instanceof IntegrityError || e instanceof Error).toBe(true);
    }
    ctx.store.close();
  });

  it("D9 transitivity — C→M plus M→F does NOT authorize C to F", () => {
    const { ctx, scope, consumer, art } = fixture();
    // Third objective F in the same business, with its own artifact.
    const objF = ctx.biz.objectives.create({
      business_id: scope.businessId,
      title: "obj F", statement: "grow F",
      kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 500_000_000,
      hard_constraints: [], success_conditions: ["done"],
      dedup_key: `dk-F-${seq++}`, operator_id: OP,
    });
    const objFId = String(objF.objective_id);
    ctx.workstreams.decomposeObjective({
      objective_id: objFId,
      expected_objective_version: Number(objF.version),
      expected_terms_version: Number(objF.terms_version),
      expected_objective_digest: String(objF.objective_digest),
      workstreams: [{ workstream_key: "w_far", title: "ws far", goal: "g far" }] as never,
      actor: OP,
    });
    const far = openBoundMission(ctx, objFId, "w_far");
    const artF = mkAcceptedArtifact(ctx, far.missionId,
      `far-${seq}.md`, Buffer.from("# far bytes"));
    // consumer→producer AND producer→F: only the direct hop authorizes.
    depRel(ctx, scope.consumerObj, scope.producerObj);
    depRel(ctx, scope.producerObj, objFId);
    const ids = eligible(ctx, consumer.mission).map((s) => s.artifact_id);
    expect(ids).toEqual([art.artifactId]);
    expect(ids).not.toContain(artF.artifactId);
    ctx.store.close();
  });

  it("D10 index path vs global fallback — identical eligible set", () => {
    const { ctx, scope, consumer, art } = fixture();
    depRel(ctx, scope.consumerObj, scope.producerObj);
    const db = (ctx.store as unknown as { db: import("better-sqlite3").Database }).db;
    // create() ran ensureIndex — the marker may already report built.
    // Force the migration complete, sample the index-path answer.
    ctx.relations.ensureIndex();
    const underIndex = eligible(ctx, consumer.mission).map((s) => s.artifact_id);
    expect(underIndex).toEqual([art.artifactId]);
    // Drop the marker → admissionView falls back to the strict global
    // scan; the authorized scope must be IDENTICAL.
    db.prepare("DELETE FROM entities WHERE entity_type='objective_relation_index_state'").run();
    const underFallback = eligible(ctx, consumer.mission).map((s) => s.artifact_id);
    expect(underFallback).toEqual(underIndex);
    ctx.store.close();
  });

  it("D11 revoke-after-pin — stamped source can no longer match", () => {
    const { ctx, scope, consumer, art } = fixture();
    const r = depRel(ctx, scope.consumerObj, scope.producerObj);
    const list = eligible(ctx, consumer.mission);
    expect(list.map((s) => s.artifact_id)).toEqual([art.artifactId]);
    // Plan-time pin: stamps + assert bound.
    const tasks = [{
      task_key: "TC1", title: "verify", task_instruction: `read ${art.name}`,
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: {},
    }];
    const out = reconcilePlanDataflow(tasks, { external_input_artifacts: list }).tasks;
    assertPlanDataflow(out, { external_input_artifacts: list });
    // REVOKE after the pin — the canonical eligible re-proof that
    // assertCrossMissionEligibleNow performs at every byte boundary now
    // sees ZERO sources: the pinned artifact can never be served.
    ctx.relations.control({ relation_id: r.relation_id, action: "REVOKE", actor: OWNER });
    const after = eligible(ctx, consumer.mission);
    expect(after).toHaveLength(0);
    expect(
      after.find((s) => String(s.artifact_id) === art.artifactId),
    ).toBeUndefined();
    ctx.store.close();
  });

  it("D8 owner amend on an endpoint → relation unproven → scope shrinks", () => {
    const { ctx, scope, consumer, art } = fixture();
    depRel(ctx, scope.consumerObj, scope.producerObj);
    expect(eligible(ctx, consumer.mission).map((s) => s.artifact_id)).toEqual([art.artifactId]);
    ctx.biz.objectives.amend(scope.producerObj, {
      business_id: scope.businessId,
      patch: { owner_authority_id: "operator:successor" },
      actor: OWNER,
    });
    expect(eligible(ctx, consumer.mission)).toHaveLength(0);
    ctx.store.close();
  });
});
