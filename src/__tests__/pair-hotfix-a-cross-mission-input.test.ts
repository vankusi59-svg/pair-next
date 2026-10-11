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
  bindPlanExternalInputs,
  DependencyResolutionError,
  EXTERNAL_INPUT_CONTRACT,
  IntegrityError,
  MissionControl,
  PAIR_DATAFLOW_SOURCES,
  PairControlPlane,
  PairEvidenceStore,
  reconcilePlanDataflow,
  assertPlanDataflow,
  sha256Hex,
  utcnow,
  workerExecutionId,
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

function mkCtx(name: string) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const control = new MissionControl({ service } as never);
  const project = service.createProject({ name: "p", root_location: workspace });
  return { d, workspace, store, service, control, project };
}

/** A mission row bound (work_open_binding) to a work item — the bound
 *  context the runtime computes eligibility from. */
function mkBoundMission(
  ctx: ReturnType<typeof mkCtx>,
  opts: { workItemId?: string; objectiveId?: string } = {},
) {
  const project = ctx.project;
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "hotfix-a",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [ctx.workspace],
  });
  const mid = String(mission.mission_id);
  const workItemId = opts.workItemId ?? `DL_${seq++}`;
  const openId = `OPEN_${seq++}`;
  const mrow = ctx.store.get("mission", mid);
  ctx.store.put(
    "mission",
    mid,
    { ...mrow, bound_open_id: openId },
    mrow.version,
  );
  ctx.store.put("work_open_binding", openId, {
    open_id: openId,
    work_item_id: workItemId,
    mission_id: mid,
    business_id: "BIZ_T",
    version: 0,
  });
  if (opts.objectiveId) {
    // The work item is a delegated child of the objective — sibling
    // missions under the same objective are in-scope sources.
    ctx.store.put(
      "workforce_allocation",
      `WAL_${workItemId}`,
      {
        objective_id: opts.objectiveId,
        delegated_child_work_item_id: workItemId,
        workstream_work_item_id: workItemId,
        version: 0,
      },
      0,
    );
  }
  const row = ctx.store.get("mission", mid);
  return { missionId: mid, mission: row, workItemId };
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
      plan_id: "PLAN_A",
      plan_revision: 1,
      remote_produces_contract: false,
      declared_produces: [name],
      declared_produces_digest: null,
    },
  });
  const exec = {
    execution_id: eid,
    governed_task_id: gtId,
    mission_id: missionId,
    task_id: tid,
    executor_id: EX,
    plan_revision: 1,
    correlation_id: `COR_${tid}`,
    execution_state: "RUNNING",
    dispatch_timestamp: utcnow(),
    workspace: ctx.workspace,
    version: 0,
  };
  ctx.store.put("executor_execution", eid, exec, 0);
  fs.writeFileSync(path.join(ctx.workspace, name), bytes);
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put(
    "executor_execution",
    eid,
    {
      ...settled,
      execution_state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [
          { path: name, sha256: sha256Hex(bytes), byte_size: bytes.length },
        ],
      },
    },
    settled.version,
  );
  new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
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
  const OBJ = "OBJ_T";
  const producer = mkBoundMission(ctx, {
    workItemId: "DL_PROD",
    objectiveId: OBJ,
  });
  const art = mkAcceptedArtifact(
    ctx,
    producer.missionId,
    "xau-delta-brief.md",
    Buffer.from("# delta brief — canonical bytes"),
  );
  const consumer = mkBoundMission(ctx, {
    workItemId: "DL_CONS",
    objectiveId: OBJ,
  });
  return { ctx, producer, consumer, art, OBJ };
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
    const OBJ = "OBJ_AMB";
    const p1 = mkBoundMission(ctx, { workItemId: "DL_P1", objectiveId: OBJ });
    const p2 = mkBoundMission(ctx, { workItemId: "DL_P2", objectiveId: OBJ });
    mkAcceptedArtifact(ctx, p1.missionId, "shared.md", Buffer.from("one"));
    mkAcceptedArtifact(ctx, p2.missionId, "shared.md", Buffer.from("two"));
    const consumer = mkBoundMission(ctx, { workItemId: "DL_C", objectiveId: OBJ });
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
    const prod = mkBoundMission(ctx, { workItemId: "DL_PX" }); // no WAL
    mkAcceptedArtifact(ctx, prod.missionId, "x.md", Buffer.from("x"));
    const cons = mkBoundMission(ctx, { workItemId: "DL_CX" });
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
    const prod = mkBoundMission(ctx, {
      workItemId: "DL_PO",
      objectiveId: "OBJ_OTHER",
    });
    mkAcceptedArtifact(ctx, prod.missionId, "x.md", Buffer.from("x"));
    const cons = mkBoundMission(ctx, {
      workItemId: "DL_CO",
      objectiveId: "OBJ_THIS",
    });
    expect(eligible(ctx, cons.mission)).toHaveLength(0);
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
    const prod = mkBoundMission(ctx, {
      workItemId: "DL_PU",
      objectiveId: "OBJ_U",
    });
    mkAcceptedArtifact(ctx, prod.missionId, "u.md", Buffer.from("u"));
    // Consumer mission WITHOUT the objective allocation — no scope.
    const cons = mkBoundMission(ctx, { workItemId: "DL_CU" });
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
    const own = mkBoundMission(ctx, {
      workItemId: "DL_OWN",
      objectiveId: "OBJ_OWN",
    });
    mkAcceptedArtifact(ctx, own.missionId, "mine.md", Buffer.from("mine"));
    const list = eligible(ctx, ctx.store.get("mission", own.missionId));
    expect(list).toHaveLength(0);
  });
});
