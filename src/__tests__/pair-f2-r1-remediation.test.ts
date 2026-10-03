/**
 * F2 R1 — source-review remediation suite (permanent).
 *
 *   A   consumption consumes F1 history authority (shared seam;
 *       rewritten row/storage/CAS → reject; malformed + conflicting
 *       history → reject; untouched → pass; restart → preserved)
 *   B   producer PASS must be RESULT_VALIDATED-anchored (no validation /
 *       no event / wrong validation_id / wrong correlation / foreign
 *       scope → not consumable)
 *   C   local materialization containment (parent-component symlinks,
 *       final-dest symlink, normal chain, converge, different-bytes
 *       preservation, bytes-fail-pin → zero write)
 *   D   immutable handoff binding (row/dep-set/dual rewrite/mode/
 *       contract/producer+artifact coherent changes → reject;
 *       approval scope binds dep-set digest; unchanged → PASS)
 *   E   ONE consume-master resolution seam (real HTTP route tests:
 *       artifact token preferred, broker fallback, neither → disabled,
 *       outbox token never authority)
 *   F   remote fetch prompt protocol (mkdir, real sha256sum + size
 *       verification, bounded retries, quarantine+STOP) + ASCII-safe
 *       headers (Unicode logical names never crash the response)
 *   G   production-path E2E — real MissionRuntime + real HTTP server:
 *       remote producer → local consumer, remote consumer HTTP fetch
 *       incl. pre-exec rejection + bounded retry semantics, restart
 *       between producer PASS and consumer dispatch, remote non-leaf
 *       DAG (declared edge progresses / undeclared fails closed)
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalQueue,
  ArtifactDependencyResolver,
  artifactDependencySetDigest,
  canonicalArtifactId,
  canonicalHandoffId,
  createMissionControlServer,
  DependencyResolutionError,
  DEPENDENCY_ARTIFACT_CONTRACT,
  DEPENDENCY_ARTIFACT_ROOT,
  dependencyConsumerPath,
  DevinExecutorAdapter,
  digest,
  ExecutorRegistry,
  GovernedTaskGate,
  handoffBindingDigest,
  HANDOFF_ENTITY,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  mintArtifactCapability,
  mintArtifactConsumeCapability,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  sha256Hex,
  TRANSPORT_IN_PROCESS,
  utcnow,
  workerExecutionId,
  ArtifactProvenanceValidator,
  reconcilePlanDataflow,
  type DependencyArtifactEntry,
} from "../pair/index.js";
import type { ExecutorAdapter } from "../pair/adapter.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f2-r1-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_F2R1";
const EX_REMOTE = "EX_REMOTE_F2R1";
const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const MASTER = "f2r1-consume-master";

function mkCtx(name: string) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const control = new MissionControl({ service } as never);
  const project = service.createProject({ name: "p", root_location: workspace });
  const mission = service.createMission({
    project_id: String(project.project_id),
    goal: "f2r1",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [workspace],
  });
  service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: [],
    source: "TEST",
    proposal: null,
  });
  return { d, workspace, store, service, control, missionId: String(mission.mission_id) };
}

const freshMission = (ctx: ReturnType<typeof mkCtx>) =>
  ctx.service.getMission(ctx.missionId);

let seq = 0;
function mkProducer(
  ctx: ReturnType<typeof mkCtx>,
  opts: {
    taskKey?: string;
    produces?: string;
    artifactBytes?: Buffer | null;
    remote?: boolean;
    pass?: boolean;
    validate?: boolean;
  } = {},
) {
  const tid = `ATSK_F2R1_${seq++}`;
  const key = opts.taskKey ?? `TP${seq}`;
  const executor = opts.remote ? EX_REMOTE : EX;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(executor, gtId);
  const name = opts.produces ?? "report.txt";
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid,
      task_key: key,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2R1",
      title: key,
      task_instruction: `produce ${name}`,
      required_capabilities: opts.remote ? [REMOTE_CAP] : ["FILE_OPERATIONS"],
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
      mission_id: ctx.missionId,
      task_id: tid,
      correlation_id: `COR_${tid}`,
      executor_id: executor,
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
  if (opts.remote) {
    // F5 R1.B — mirror the production mint for remote tasks: pin the
    // declared-produces contract and emit the immutable
    // GOVERNED_TASK_VALIDATED anchor binding it.
    const governed = ctx.store.get("governed_task", gtId);
    governed.expected_output_contract = {
      type: "TASK_RESULT",
      declared_produces: [name],
    };
    governed.permissions = governed.permissions ?? [];
    governed.dependency_artifacts_digest =
      governed.dependency_artifacts_digest ?? null;
    governed.approval_scope_digest = digest({
      mission_id: governed.mission_id,
      task_id: governed.task_id,
      executor_id: governed.executor_id,
      workspace: String(governed.workspace),
      allowed_paths: governed.allowed_paths,
      permissions: governed.permissions,
      expected_output_contract: governed.expected_output_contract,
      dependency_artifacts_digest: governed.dependency_artifacts_digest,
    });
    ctx.store.put("governed_task", gtId, governed, Number(governed.version));
    ctx.store.event({
      entity_type: "governed_task",
      entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED",
      new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: ctx.missionId, task_id: tid, executor_id: executor,
        governed_task_id: gtId,
        plan_id: "PLAN_F2R1", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: true,
        declared_produces: [name],
        declared_produces_digest: digest([name]),
      },
    });
    ctx.store.appendEvidence(ctx.missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: executor,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2R1", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: true,
      declared_produces: [name],
      declared_produces_digest: digest([name]),
    });
  }
  const bytes =
    opts.artifactBytes === undefined
      ? Buffer.from(`artifact-of-${tid}`)
      : opts.artifactBytes;
  const exec: Record<string, unknown> = {
    execution_id: eid,
    governed_task_id: gtId,
    mission_id: ctx.missionId,
    task_id: tid,
    executor_id: executor,
    plan_revision: 1,
    correlation_id: `COR_${tid}`,
    execution_state: "RUNNING",
    dispatch_timestamp: utcnow(),
    workspace: ctx.workspace,
    version: 0,
  };
  ctx.store.put("executor_execution", eid, exec, 0);
  let declared: Record<string, unknown>[] = [];
  if (bytes !== null) {
    if (opts.remote) {
      const cap = mintArtifactCapability(MASTER, {
        mission_id: ctx.missionId,
        task_id: tid,
        governed_task_id: gtId,
        execution_id: eid,
        executor_id: executor,
      });
      ctx.control.acceptArtifactUpload(MASTER, cap, {
        filename: name,
        mission_id: ctx.missionId,
        task_id: tid,
        bytes,
      });
    } else {
      fs.writeFileSync(path.join(ctx.workspace, name), bytes);
      declared = [
        { path: name, sha256: sha256Hex(bytes), byte_size: bytes.length },
      ];
    }
  }
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put(
    "executor_execution",
    eid,
    {
      ...settled,
      execution_state: opts.pass === false ? "FAILED" : "COMPLETED",
      result: {
        status: opts.pass === false ? "FAILED" : "COMPLETED",
        artifacts: declared,
      },
    },
    settled.version,
  );
  if (opts.validate !== false) {
    new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
  }
  return {
    tid,
    gtId,
    eid,
    executor,
    name,
    bytes: bytes ?? Buffer.alloc(0),
    task_key: key,
  };
}

function mkConsumer(
  ctx: ReturnType<typeof mkCtx>,
  producers: ReturnType<typeof mkProducer>[],
  opts: { consume?: string; remote?: boolean; depends_on?: string[] } = {},
) {
  const tid = `ATSK_CR1_${seq++}`;
  const key = `TC${seq}`;
  const consume = opts.consume ?? producers[0]?.name ?? "report.txt";
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid,
      task_key: key,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2R1",
      title: key,
      task_instruction: `read ${consume} then reply DONE.`,
      required_capabilities: opts.remote ? [REMOTE_CAP] : ["FILE_OPERATIONS"],
      depends_on: opts.depends_on ?? producers.map((p) => p.task_key),
      status: "READY",
      metadata: { pair_dataflow: { produces: [], consumes: [consume] } },
      version: 0,
    },
    0,
  );
  return { tid, task: ctx.store.get("task", tid), task_key: key, consume };
}

function mkGovernedConsumer(
  ctx: ReturnType<typeof mkCtx>,
  consumer: ReturnType<typeof mkConsumer>,
  entries: DependencyArtifactEntry[],
  opts: { execState?: string | null; remote?: boolean } = {},
) {
  const gtId = `GT_${consumer.tid}`;
  const executor = opts.remote ? EX_REMOTE : EX;
  const depDigest = artifactDependencySetDigest(entries);
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId,
      mission_id: ctx.missionId,
      task_id: consumer.tid,
      correlation_id: `COR_${consumer.tid}`,
      executor_id: executor,
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
  // Mirrors createGovernedTaskContinuation: VALIDATED event anchors the
  // dep-set digest.
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED",
    new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${consumer.tid}`,
    metadata: {
      mission_id: ctx.missionId,
      task_id: consumer.tid,
      executor_id: executor,
      dependency_artifacts_digest: depDigest,
    },
  });
  let eid: string | null = null;
  if (opts.execState !== undefined && opts.execState !== null) {
    eid = workerExecutionId(executor, gtId);
    ctx.store.put(
      "executor_execution",
      eid,
      {
        execution_id: eid,
        governed_task_id: gtId,
        mission_id: ctx.missionId,
        task_id: consumer.tid,
        executor_id: executor,
        plan_revision: 1,
        correlation_id: `COR_${consumer.tid}`,
        execution_state: opts.execState,
        dispatch_timestamp: utcnow(),
        workspace: ctx.workspace,
        version: 0,
      },
      0,
    );
  }
  return {
    gtId,
    eid,
    governed: ctx.store.get("governed_task", gtId),
    executor,
  };
}

const resolver = (ctx: ReturnType<typeof mkCtx>) =>
  new ArtifactDependencyResolver(ctx.service);
const handoffs = (ctx: ReturnType<typeof mkCtx>) => ctx.service.artifactHandoffs;

const errCode = (f: () => unknown): string => {
  try {
    f();
    return "NO_THROW";
  } catch (e) {
    if (e instanceof DependencyResolutionError) return `DEP:${e.code}`;
    if (e instanceof IntegrityError) return e.code;
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string") return code;
    return `OTHER:${String(e)}`;
  }
};

const depSetup = (
  ctx: ReturnType<typeof mkCtx>,
  opts: { remote?: boolean; producerRemote?: boolean } = {},
) => {
  const prod = mkProducer(ctx, {
    produces: "report.txt",
    remote: opts.producerRemote,
  });
  const cons = mkConsumer(ctx, [prod], { remote: opts.remote });
  const entries = resolver(ctx).resolveForConsumer({
    mission: freshMission(ctx),
    task: cons.task,
  });
  return { prod, cons, entries };
};

const remoteSetup = (
  ctx: ReturnType<typeof mkCtx>,
  opts: { execState?: string | null; result?: boolean } = {},
) => {
  const { prod, cons, entries } = depSetup(ctx, {
    remote: true,
    producerRemote: true,
  });
  const gc = mkGovernedConsumer(ctx, cons, entries, {
    remote: true,
    execState: opts.execState ?? "RUNNING",
  });
  if (opts.result && gc.eid) {
    const exec = ctx.store.get("executor_execution", gc.eid);
    ctx.store.put(
      "executor_execution",
      gc.eid,
      { ...exec, result: { status: "COMPLETED", artifacts: [] } },
      exec.version,
    );
  }
  handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
  const cap = mintArtifactConsumeCapability(MASTER, {
    mission_id: ctx.missionId,
    task_id: cons.tid,
    governed_task_id: gc.gtId,
    execution_id: gc.eid!,
    executor_id: gc.executor,
    dependency_set_digest: artifactDependencySetDigest(entries),
    issued_at: utcnow(),
  } as never);
  return { prod, cons, gc, entries, cap };
};

/** Rewrite the accepted artifact row + CAS to coherent bytes B — the
 *  row looks self-consistent but contradicts the acceptance history. */
const rewriteToBytesB = (
  ctx: ReturnType<typeof mkCtx>,
  artifactId: string,
) => {
  const b = Buffer.from("coherent-B-bytes");
  const shaB = sha256Hex(b);
  fs.mkdirSync(ctx.d, {
    recursive: true,
  });
  const art = ctx.store.get("artifact", artifactId);
  ctx.store.put(
    "artifact",
    artifactId,
    {
      ...art,
      sha256: shaB,
      byte_size: b.length,
      storage: {
        kind: "PAIR_ARTIFACT_CAS",
        sha256: shaB,
        ref: `blobs/${shaB}`,
      },
    },
    art.version,
  );
  fs.writeFileSync(path.join(ctx.d, "artifacts", "blobs", shaB), b);
  return { bytesB: b, shaB };
};

const mkPassRow = (
  ctx: ReturnType<typeof mkCtx>,
  eid: string,
  gtId: string,
  artifactIds: string[],
  validationId = `XVLD_${eid}`,
) =>
  ctx.store.put(
    "execution_validation",
    validationId,
    {
      validation_id: validationId,
      execution_id: eid,
      governed_task_id: gtId,
      mission_id: ctx.missionId,
      status: "PASS",
      failures: [],
      artifact_count: artifactIds.length,
      artifact_ids: artifactIds,
      referenced_artifact_ids: artifactIds,
      created_at: utcnow(),
      version: 0,
    },
    0,
  );

/* ============ A — R1.1 history-bound consumption authority ============ */
describe("R1.1 A — consumption re-binds F1 acceptance history", () => {
  it("A1. row+storage+CAS rewritten to valid B → resolver rejects (history says A)", () => {
    const ctx = mkCtx("a1");
    const { prod, cons, entries } = depSetup(ctx);
    rewriteToBytesB(ctx, entries[0]!.artifact_id);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
    expect(prod.bytes).not.toEqual(Buffer.from("coherent-B-bytes"));
  });

  it("A2. rewrite after pin → materialization rejects BEFORE any write", () => {
    const ctx = mkCtx("a2");
    const { cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    rewriteToBytesB(ctx, entries[0]!.artifact_id);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
    expect(fs.existsSync(dest)).toBe(false); // zero write
  });

  it("A3. rewrite after pin → remote fetch rejects", () => {
    const ctx = mkCtx("a3");
    const { entries, cap } = remoteSetup(ctx);
    rewriteToBytesB(ctx, entries[0]!.artifact_id);
    expect(
      errCode(() =>
        ctx.control.fetchArtifactForConsumption(MASTER, cap, {
          artifact_id: entries[0]!.artifact_id,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("A4. malformed acceptance history → no consumption", () => {
    const ctx = mkCtx("a4");
    const { prod, cons, entries } = depSetup(ctx);
    // A second ARTIFACT_ACCEPTED for the SAME artifact + SAME execution
    // but malformed metadata — history must fail closed, not skip it.
    ctx.store.event({
      entity_type: "artifact",
      entity_id: entries[0]!.artifact_id,
      event_type: "ARTIFACT_ACCEPTED",
      new_state: "report.txt",
      actor: "X",
      metadata: { execution_id: prod.eid, sha256: "nothex" },
    });
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("A5. conflicting duplicate acceptance history → no consumption", () => {
    const ctx = mkCtx("a5");
    const { prod, cons, entries } = depSetup(ctx);
    const art = ctx.store.get("artifact", entries[0]!.artifact_id);
    ctx.store.event({
      entity_type: "artifact",
      entity_id: entries[0]!.artifact_id,
      event_type: "ARTIFACT_ACCEPTED",
      new_state: String(art.logical_name),
      actor: "X",
      metadata: {
        execution_id: prod.eid,
        producer_executor_id: EX,
        sha256: "0".repeat(64),
        byte_size: 1,
        channel: "LOCAL_EXECUTION",
      },
    });
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("A6. untouched ART → materialization succeeds", () => {
    const ctx = mkCtx("a6");
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(
      fs.readFileSync(path.join(ctx.workspace, written[0]!)),
    ).toEqual(prod.bytes);
  });

  it("A7. restart → binding preserved across new store/control", () => {
    const ctx = mkCtx("a7");
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const governed2 = store2.get("governed_task", gc.gtId);
    const written = service2.artifactHandoffs.materializeForConsumer(governed2);
    expect(
      fs.readFileSync(path.join(ctx.workspace, written[0]!)),
    ).toEqual(prod.bytes);
    store2.close();
  });
});

/* ======= B — R1.2 producer PASS anchored by RESULT_VALIDATED ======= */
describe("R1.2 B — PASS must be RESULT_VALIDATED-anchored", () => {
  it("B1. COMPLETED exec + artifact, no validation row → not consumable", () => {
    const ctx = mkCtx("b1");
    const prod = mkProducer(ctx, { remote: true, validate: false });
    const cons = mkConsumer(ctx, [prod]);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("B2. PASS row without RESULT_VALIDATED event → reject", () => {
    const ctx = mkCtx("b2");
    const prod = mkProducer(ctx, { remote: true, validate: false });
    const artId = canonicalArtifactId(prod.eid, "report.txt");
    mkPassRow(ctx, prod.eid, prod.gtId, [artId]);
    const cons = mkConsumer(ctx, [prod]);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("B3. RESULT_VALIDATED with wrong validation_id → reject", () => {
    const ctx = mkCtx("b3");
    const prod = mkProducer(ctx, { remote: true, validate: false });
    const artId = canonicalArtifactId(prod.eid, "report.txt");
    mkPassRow(ctx, prod.eid, prod.gtId, [artId]);
    ctx.store.event({
      entity_type: "executor_execution",
      entity_id: prod.eid,
      event_type: "RESULT_VALIDATED",
      new_state: "PASS",
      actor: "PAIR_ARTIFACT_VALIDATOR",
      correlation_id: `COR_${prod.tid}`,
      metadata: { validation_id: "XVLD_other" },
    });
    const cons = mkConsumer(ctx, [prod]);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("B4. RESULT_VALIDATED under wrong correlation → reject", () => {
    const ctx = mkCtx("b4");
    const prod = mkProducer(ctx, { remote: true, validate: false });
    const artId = canonicalArtifactId(prod.eid, "report.txt");
    mkPassRow(ctx, prod.eid, prod.gtId, [artId]);
    ctx.store.event({
      entity_type: "executor_execution",
      entity_id: prod.eid,
      event_type: "RESULT_VALIDATED",
      new_state: "PASS",
      actor: "PAIR_ARTIFACT_VALIDATOR",
      correlation_id: "COR_FOREIGN",
      metadata: { validation_id: `XVLD_${prod.eid}` },
    });
    const cons = mkConsumer(ctx, [prod]);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("B5. anchored PASS on a foreign-mission execution → not consumable", () => {
    const ctx = mkCtx("b5");
    const prod = mkProducer(ctx, { remote: true, validate: false });
    const artId = canonicalArtifactId(prod.eid, "report.txt");
    // Exec claims a foreign mission — out of the resolver's scope anyway.
    const exec = ctx.store.get("executor_execution", prod.eid);
    ctx.store.put(
      "executor_execution",
      prod.eid,
      { ...exec, mission_id: "MIS_FOREIGN" },
      exec.version,
    );
    mkPassRow(ctx, prod.eid, prod.gtId, [artId]);
    ctx.store.event({
      entity_type: "executor_execution",
      entity_id: prod.eid,
      event_type: "RESULT_VALIDATED",
      new_state: "PASS",
      actor: "X",
      correlation_id: `COR_${prod.tid}`,
      metadata: { validation_id: `XVLD_${prod.eid}` },
    });
    const cons = mkConsumer(ctx, [prod]);
    expect(
      errCode(() =>
        resolver(ctx).resolveForConsumer({
          mission: freshMission(ctx),
          task: cons.task,
        }),
      ),
    ).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("B6. canonical validator PASS + RESULT_VALIDATED anchor → consumable", () => {
    const ctx = mkCtx("b6");
    const { prod, cons, entries } = depSetup(ctx);
    expect(entries).toHaveLength(1);
    // The anchor exists and names THIS validation row.
    const v = ctx.store
      .list("execution_validation")
      .find((x) => String(x.execution_id) === prod.eid)!;
    const anchored = ctx.store
      .listEvents("executor_execution", prod.eid)
      .some(
        (e) =>
          String(e.event_type) === "RESULT_VALIDATED" &&
          String(e.new_state) === "PASS" &&
          String(e.correlation_id ?? "") === `COR_${prod.tid}` &&
          String(
            (e.metadata as Record<string, unknown> | undefined)
              ?.validation_id ?? "",
          ) === String(v.validation_id),
      );
    expect(anchored).toBe(true);
    expect(entries[0]!.producer_execution_id).toBe(prod.eid);
  });

  it("B7. restart → anchored producer still consumable", () => {
    const ctx = mkCtx("b7");
    const { cons } = depSetup(ctx);
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const entries2 = new ArtifactDependencyResolver(service2).resolveForConsumer(
      {
        mission: service2.getMission(ctx.missionId),
        task: store2.get("task", cons.tid),
      },
    );
    expect(entries2).toHaveLength(1);
    store2.close();
  });
});

/* ========= C — R1.3 parent-symlink containment in materialization ========= */
describe("R1.3 C — materialization containment", () => {
  const setupC = (ctx: ReturnType<typeof mkCtx>) => {
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    return { prod, gc, entries };
  };

  it("C1. .pair symlink → FAIL, zero bytes outside workspace", () => {
    const ctx = mkCtx("c1");
    const { gc, entries } = setupC(ctx);
    const outside = path.join(ctx.d, "escape");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ctx.workspace, ".pair"));
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readdirSync(outside)).toHaveLength(0);
    expect(
      fs.existsSync(path.join(ctx.workspace, entries[0]!.consumer_relative_path)),
    ).toBe(false);
  });

  it("C2. dependency-artifacts symlink → FAIL, zero bytes outside", () => {
    const ctx = mkCtx("c2");
    const { gc, entries } = setupC(ctx);
    const outside = path.join(ctx.d, "escape");
    fs.mkdirSync(outside);
    const pairDir = path.join(ctx.workspace, ".pair");
    fs.mkdirSync(pairDir);
    fs.symlinkSync(outside, path.join(pairDir, "dependency-artifacts"));
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("C3. per-artifact dir symlink → FAIL, zero bytes outside", () => {
    const ctx = mkCtx("c3");
    const { gc, entries } = setupC(ctx);
    const outside = path.join(ctx.d, "escape");
    fs.mkdirSync(outside);
    // R3.1 — the per-artifact parent dir lives UNDER the consumer scope:
    // derive it from the pinned canonical destination.
    const artDir = path.dirname(
      path.join(ctx.workspace, entries[0]!.consumer_relative_path),
    );
    fs.mkdirSync(path.dirname(artDir), { recursive: true });
    fs.symlinkSync(outside, artDir);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("C4. final destination is a symlink → FAIL, target untouched", () => {
    const ctx = mkCtx("c4");
    const { gc, entries } = setupC(ctx);
    const outside = path.join(ctx.d, "escape");
    fs.mkdirSync(outside);
    const outsideFile = path.join(outside, "victim.txt");
    fs.writeFileSync(outsideFile, "preexisting");
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(outsideFile, dest);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readFileSync(outsideFile)).toEqual(Buffer.from("preexisting"));
  });

  it("C5. normal chain → materialize succeeds", () => {
    const ctx = mkCtx("c5");
    const { prod, gc } = setupC(ctx);
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(
      fs.readFileSync(path.join(ctx.workspace, written[0]!)),
    ).toEqual(prod.bytes);
  });

  it("C6. identical bytes → converge idempotently", () => {
    const ctx = mkCtx("c6");
    const { gc, entries } = setupC(ctx);
    handoffs(ctx).materializeForConsumer(gc.governed);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    const ino = fs.statSync(dest).ino;
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.statSync(dest).ino).toBe(ino);
  });

  it("C7. different existing bytes → FAIL, original preserved", () => {
    const ctx = mkCtx("c7");
    const { gc, entries } = setupC(ctx);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "PREEXISTING");
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readFileSync(dest)).toEqual(Buffer.from("PREEXISTING"));
  });

  it("C8. bytes-fail-pin → verify rejects BEFORE any write", () => {
    const ctx = mkCtx("c8");
    const { gc, entries } = setupC(ctx);
    // Corrupt the retained CAS bytes — the pinned sha no longer verifies.
    const sha = entries[0]!.sha256;
    fs.writeFileSync(
      path.join(ctx.d, "artifacts", "blobs", sha),
      "corrupted",
    );
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.join(ctx.workspace, DEPENDENCY_ARTIFACT_ROOT)))
      .toBe(false);
  });
});

/* ========= D — R1.4 immutable handoff binding + dep-set digest ========= */
describe("R1.4 D — immutable binding authority", () => {
  const setupD = (ctx: ReturnType<typeof mkCtx>) => {
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const hId = canonicalHandoffId(
      gc.gtId,
      entries[0]!.artifact_id,
      entries[0]!.consumer_relative_path,
    );
    return { prod, cons, gc, entries, hId };
  };

  it("D1. mutate handoff row → dispatch-unmulated check rejects", () => {
    const ctx = mkCtx("d1");
    const { gc, hId } = setupD(ctx);
    const h = ctx.store.get(HANDOFF_ENTITY, hId);
    ctx.store.put(HANDOFF_ENTITY, hId, { ...h, sha256: "f".repeat(64) }, h.version);
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D2. mutate governed dep entry → dep_set_digest rejects", () => {
    const ctx = mkCtx("d2");
    const { gc, entries } = setupD(ctx);
    const g = ctx.store.get("governed_task", gc.gtId);
    ctx.store.put(
      "governed_task",
      gc.gtId,
      {
        ...g,
        dependency_artifacts: [
          { ...entries[0]!, sha256: "a".repeat(64) },
        ],
      },
      g.version,
    );
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D3. coherent dual rewrite (governed+handoff+row digests) → pin history rejects", () => {
    const ctx = mkCtx("d3");
    const { gc, entries, hId } = setupD(ctx);
    const g = ctx.store.get("governed_task", gc.gtId);
    const h = ctx.store.get(HANDOFF_ENTITY, hId);
    const newSha = "9".repeat(64);
    // Rewrite BOTH rows coherently: entry sha + digest field + handoff
    // sha + handoff's own recomputed binding_digest. The immutable
    // VALIDATED/PINNED events still record the ORIGINAL digests.
    const entryB = { ...entries[0]!, sha256: newSha };
    ctx.store.put(
      "governed_task",
      gc.gtId,
      {
        ...g,
        dependency_artifacts: [entryB],
        dependency_artifacts_digest: artifactDependencySetDigest([entryB]),
      },
      g.version,
    );
    ctx.store.put(
      HANDOFF_ENTITY,
      hId,
      {
        ...h,
        sha256: newSha,
        binding_digest: handoffBindingDigest({
          ...(h as Record<string, string>),
          sha256: newSha,
          byte_size: Number(h.byte_size),
        } as never),
      },
      h.version,
    );
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
    // Same for the materialization path.
    expect(errCode(() => handoffs(ctx).materializeForConsumer(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D4. mode flip + recomputed row digest → pin history rejects", () => {
    const ctx = mkCtx("d4");
    const { gc, hId } = setupD(ctx);
    const h = ctx.store.get(HANDOFF_ENTITY, hId);
    ctx.store.put(
      HANDOFF_ENTITY,
      hId,
      {
        ...h,
        mode: "REMOTE_FETCH",
        binding_digest: handoffBindingDigest({
          ...(h as Record<string, string>),
          mode: "REMOTE_FETCH",
          byte_size: Number(h.byte_size),
        } as never),
      },
      h.version,
    );
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D5. contract rewrite on handoff row → reject", () => {
    const ctx = mkCtx("d5");
    const { gc, hId } = setupD(ctx);
    const h = ctx.store.get(HANDOFF_ENTITY, hId);
    ctx.store.put(
      HANDOFF_ENTITY,
      hId,
      { ...h, contract: "forged.v9" },
      h.version,
    );
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D6. producer+artifact coherent change → reject", () => {
    const ctx = mkCtx("d6");
    const { gc, entries, hId } = setupD(ctx);
    const g = ctx.store.get("governed_task", gc.gtId);
    const h = ctx.store.get(HANDOFF_ENTITY, hId);
    const e2 = { ...entries[0]!, producer_execution_id: "EXE_other" };
    ctx.store.put(
      "governed_task",
      gc.gtId,
      {
        ...g,
        dependency_artifacts: [e2],
        dependency_artifacts_digest: artifactDependencySetDigest([e2]),
      },
      g.version,
    );
    ctx.store.put(
      HANDOFF_ENTITY,
      hId,
      { ...h, producer_execution_id: "EXE_other" },
      h.version,
    );
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(errCode(() => handoffs(ctx).assertContractUnmutated(governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT");
  });

  it("D7. approval for dep-set A must NOT authorize dep-set B", () => {
    const ctx = mkCtx("d7");
    const gate = new GovernedTaskGate(ctx.service);
    const active = ctx.service.activeRevision(ctx.missionId);
    const taskId = `ATSK_APR_${seq++}`;
    const entriesA: DependencyArtifactEntry[] = [
      {
        artifact_id: "ART_A",
        producer_task_id: "tp",
        producer_governed_task_id: "gtp",
        producer_execution_id: "exe_a",
        producer_executor_id: EX,
        logical_name: "a.txt",
        sha256: sha256Hex(Buffer.from("a")),
        byte_size: 1,
        consumer_relative_path: dependencyConsumerPath(taskId, "ART_A", "a.txt"),
        contract: DEPENDENCY_ARTIFACT_CONTRACT,
      },
    ];
    const entriesB = [
      { ...entriesA[0]!, artifact_id: "ART_B", logical_name: "b.txt",
        consumer_relative_path: dependencyConsumerPath(taskId, "ART_B", "b.txt") },
    ];
    const adapter = {
      executor_id: EX,
      runtime_type: "EXTERNAL",
      qualify: () => ({ qualified: true, dispatch_enabled: true }),
      capabilities: () => ({ capability_ids: ["FILE_OPERATIONS"] }),
    } as never;
    ctx.store.put(
      "task",
      taskId,
      {
        task_id: taskId,
        task_key: `TA${seq}`,
        mission_id: ctx.missionId,
        plan_id: active.plan_id,
        title: "approval",
        task_instruction: "do",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        status: "READY",
        selected_executor: EX,
        metadata: { risk_class: "HIGH" }, // forces needsApproval
        version: 0,
      },
      0,
    );
    const tRow = ctx.store.get("task", taskId);
    const req = (deps: DependencyArtifactEntry[]) => ({
      task_id: taskId,
      task_instruction: "do",
      workspace: ctx.workspace,
      allowed_paths: [ctx.workspace],
      permissions: [],
      correlation_id: `COR_${taskId}`,
      timeout: 60,
      dependency_artifacts: deps,
    });
    const mission = () => ctx.service.getMission(ctx.missionId);
    const go = (deps: DependencyArtifactEntry[]) =>
      (gate as never as {
        createGovernedTaskContinuation(
          a: never, r: never, m: never, t: never, p: never,
        ): { governed_task: Record<string, unknown> };
      }).createGovernedTaskContinuation(
        adapter,
        req(deps) as never,
        mission() as never,
        tRow as never,
        active as never,
      );
    // Approve set A only.
    gate.recordApproval({
      mission_id: ctx.missionId,
      task_id: taskId,
      executor_id: EX,
      approved_by: "op",
      request: req(entriesA) as never,
    });
    // Same task scope with set B → the A approval must NOT cover it.
    expect(errCode(() => go(entriesB))).toBe(
      "FAIL_CLOSED_OPERATOR_APPROVAL_REQUIRED",
    );
    // Approval bound to B's dep-set digest → continuation authorized.
    gate.recordApproval({
      mission_id: ctx.missionId,
      task_id: taskId,
      executor_id: EX,
      approved_by: "op",
      request: req(entriesB) as never,
    });
    const out = go(entriesB);
    expect(out.governed_task.dependency_artifacts_digest).toBe(
      artifactDependencySetDigest(entriesB),
    );
    const ev = ctx.store
      .listEvents("governed_task", String(out.governed_task.governed_task_id))
      .find((e) => String(e.event_type) === "GOVERNED_TASK_VALIDATED")!;
    expect(
      String(
        (ev.metadata as Record<string, unknown>).dependency_artifacts_digest,
      ),
    ).toBe(artifactDependencySetDigest(entriesB));
  });

  it("D8. unchanged contract → binding PASS", () => {
    const ctx = mkCtx("d8");
    const { gc } = setupD(ctx);
    const governed = ctx.store.get("governed_task", gc.gtId);
    expect(() => handoffs(ctx).assertContractUnmutated(governed))
      .not.toThrow();
  });
});

/* ======= E — R1.5 one consume-master seam (real HTTP route) ======= */
describe("R1.5 E — canonical consume-master resolution over HTTP", () => {
  const envKeys = [
    "PAIR_ARTIFACT_UPLOAD_TOKEN",
    "PAIR_BROKER_TOKEN",
    "PAIR_OUTBOX_TOKEN",
  ];
  const withServer = async (
    ctx: ReturnType<typeof mkCtx>,
    env: Record<string, string | undefined>,
    fn: (port: number) => Promise<void>,
  ) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of envKeys) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const server: Server = createMissionControlServer({
      control: ctx.control,
      artifactUploadToken: env.PAIR_ARTIFACT_UPLOAD_TOKEN,
      // R2.4 — the bootstrap resolves the consume-master chain once:
      // artifact token preferred, broker fallback. Ambient env is never
      // consulted inside request handling.
      artifactConsumeToken:
        env.PAIR_ARTIFACT_UPLOAD_TOKEN || env.PAIR_BROKER_TOKEN,
    } as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn((server.address() as { port: number }).port);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
  const fetchArtifact = async (
    port: number,
    cap: string,
    artifactId: string,
  ): Promise<{ status: number; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const rq = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/artifacts/fetch",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-artifact-consume-capability": cap,
          },
        },
        (rs) => {
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("end", () =>
            resolve({ status: rs.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
        },
      );
      rq.on("error", reject);
      rq.end(JSON.stringify({ artifact_id: artifactId }));
    });

  const capUnder = (
    ctx: ReturnType<typeof mkCtx>,
    master: string,
    s: ReturnType<typeof remoteSetup>,
  ) =>
    mintArtifactConsumeCapability(master, {
      mission_id: ctx.missionId,
      task_id: s.cons.tid,
      governed_task_id: s.gc.gtId,
      execution_id: s.gc.eid!,
      executor_id: s.gc.executor,
      dependency_set_digest: artifactDependencySetDigest(s.entries),
      issued_at: utcnow(),
    } as never);

  it("E1. artifact token A + broker B → A-minted capability verifies over HTTP", async () => {
    const ctx = mkCtx("e1");
    const s = remoteSetup(ctx);
    await withServer(
      ctx,
      { PAIR_ARTIFACT_UPLOAD_TOKEN: "ART_MASTER_A", PAIR_BROKER_TOKEN: "BROKER_B" },
      async (port) => {
        const r = await fetchArtifact(
          port,
          capUnder(ctx, "ART_MASTER_A", s),
          s.entries[0]!.artifact_id,
        );
        expect(r.status).toBe(200);
        expect(r.body).toEqual(s.prod.bytes);
      },
    );
  });

  it("E2. cap signed under broker B does NOT verify when artifact token A configured", async () => {
    const ctx = mkCtx("e2");
    const s = remoteSetup(ctx);
    await withServer(
      ctx,
      { PAIR_ARTIFACT_UPLOAD_TOKEN: "ART_MASTER_A", PAIR_BROKER_TOKEN: "BROKER_B" },
      async (port) => {
        const r = await fetchArtifact(
          port,
          capUnder(ctx, "BROKER_B", s),
          s.entries[0]!.artifact_id,
        );
        expect(r.status).toBe(403);
      },
    );
  });

  it("E3. artifact token absent → broker master fallback verifies", async () => {
    const ctx = mkCtx("e3");
    const s = remoteSetup(ctx);
    await withServer(
      ctx,
      { PAIR_ARTIFACT_UPLOAD_TOKEN: undefined, PAIR_BROKER_TOKEN: "BROKER_B" },
      async (port) => {
        const r = await fetchArtifact(
          port,
          capUnder(ctx, "BROKER_B", s),
          s.entries[0]!.artifact_id,
        );
        expect(r.status).toBe(200);
        expect(r.body).toEqual(s.prod.bytes);
      },
    );
  });

  it("E4. neither master configured → lane disabled", async () => {
    const ctx = mkCtx("e4");
    const s = remoteSetup(ctx);
    await withServer(
      ctx,
      { PAIR_ARTIFACT_UPLOAD_TOKEN: undefined, PAIR_BROKER_TOKEN: undefined },
      async (port) => {
        const r = await fetchArtifact(
          port,
          capUnder(ctx, "anything", s),
          s.entries[0]!.artifact_id,
        );
        expect(r.status).toBe(403);
      },
    );
  });

  it("E5. PAIR_OUTBOX_TOKEN is never consume authority", async () => {
    const ctx = mkCtx("e5");
    const s = remoteSetup(ctx);
    await withServer(
      ctx,
      {
        PAIR_ARTIFACT_UPLOAD_TOKEN: undefined,
        PAIR_BROKER_TOKEN: undefined,
        PAIR_OUTBOX_TOKEN: "OUTBOX_X",
      },
      async (port) => {
        const r = await fetchArtifact(
          port,
          capUnder(ctx, "OUTBOX_X", s),
          s.entries[0]!.artifact_id,
        );
        expect(r.status).toBe(403);
      },
    );
  });
});

/* ===== F — R1.6 bounded fetch recipe + ASCII-safe headers ===== */
describe("R1.6 F — remote fetch protocol", () => {
  const capturedPrompt = (deps: DependencyArtifactEntry[]): string => {
    const dirp = dir("prompt");
    let prompt = "";
    const fetchFn = ((
      _method: string,
      _url: string,
      body?: Record<string, unknown>,
      _auth?: string,
    ) => {
      if (body?.prompt) prompt = String(body.prompt);
      return { status: 200, data: { session_id: "s1", url: "u" } };
    }) as never;
    const adapter = new DevinExecutorAdapter({
      journalRoot: path.join(dirp, "j"),
      apiKey: "cog_test",
      fetchFn,
      blockedGraceMs: 60_000,
      taskTimeoutMs: 60_000,
      nowMs: () => 1,
      now: () => "2026-01-01T00:00:00Z",
    });
    const ws = path.join(dirp, "ws");
    fs.mkdirSync(ws);
    const saved = { ...process.env };
    process.env.PAIR_OUTBOX_URL = "http://pair.test";
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = "ART_MASTER_A";
    delete process.env.PAIR_BROKER_TOKEN;
    try {
      adapter.dispatch({
        executor_id: "DEVIN",
        governance_state: "DISPATCH_AUTHORIZED",
        dispatch_enabled: true,
        task_id: "t",
        mission_id: "m",
        governed_task_id: "GT1",
        workspace: ws,
        correlation_id: "c",
        allowed_paths: [ws],
        dependency_artifacts: deps,
        task_instruction: "x",
      } as never);
    } finally {
      process.env = saved as never;
    }
    return prompt;
  };

  const depEntry = (): DependencyArtifactEntry[] => [
    {
      artifact_id: "ART_abc123",
      producer_task_id: "tp",
      producer_governed_task_id: "gtp",
      producer_execution_id: "exe_p",
      producer_executor_id: EX,
      logical_name: "báo cáo kỳ.txt", // Unicode name — recipe-safe
      sha256: "a".repeat(64),
      byte_size: 10,
      consumer_relative_path:
        ".pair/dependency-artifacts/ART_abc123/báo cáo kỳ.txt",
      contract: DEPENDENCY_ARTIFACT_CONTRACT,
    },
  ];

  it("F1. recipe: mkdir parent + real sha256sum + size + bounded retries + quarantine", () => {
    const p = capturedPrompt(depEntry());
    expect(p).toContain("mkdir -p");
    expect(p).toContain("sha256sum");
    expect(p).toContain("wc -c");
    expect(p).toContain("for i in 1 2 3 4 5");
    expect(p).toContain("DEPENDENCY_FETCH_FAILED");
    expect(p).toContain("rm -f");
    expect(p).not.toContain("printf of");
    expect(p).toContain("/api/artifacts/fetch");
  });

  it("F2. unicode logical name lands in the recipe without breaking quoting", () => {
    const p = capturedPrompt(depEntry());
    expect(p).toContain("báo cáo kỳ.txt");
    expect(p).toContain("artifact_id\":\"ART_abc123");
  });

  it("F3. response headers stay ASCII-safe for Unicode names (no raw logical-name header)", async () => {
    const ctx = mkCtx("f3");
    // Producer with a Unicode artifact name via the remote upload lane.
    const prod = mkProducer(ctx, {
      remote: true,
      produces: "báo cáo.txt",
      artifactBytes: Buffer.from("unicode-bytes"),
    });
    const cons = mkConsumer(ctx, [prod], { remote: true, consume: "báo cáo.txt" });
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    const gc = mkGovernedConsumer(ctx, cons, entries, { remote: true, execState: "RUNNING" });
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
    const cap = mintArtifactConsumeCapability("ART_MASTER_A", {
      mission_id: ctx.missionId,
      task_id: cons.tid,
      governed_task_id: gc.gtId,
      execution_id: gc.eid!,
      executor_id: gc.executor,
      dependency_set_digest: artifactDependencySetDigest(entries),
      issued_at: utcnow(),
    } as never);
    const savedA = process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = "ART_MASTER_A";
    const server = createMissionControlServer({
      control: ctx.control,
      artifactUploadToken: "ART_MASTER_A",
    } as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
        (resolve, reject) => {
          const rq = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/artifacts/fetch",
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-artifact-consume-capability": cap,
              },
            },
            (rs) => {
              const chunks: Buffer[] = [];
              rs.on("data", (c: Buffer) => chunks.push(c));
              rs.on("end", () =>
                resolve({
                  status: rs.statusCode ?? 0,
                  headers: rs.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          rq.on("error", reject);
          rq.end(JSON.stringify({ artifact_id: entries[0]!.artifact_id }));
        },
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual(prod.bytes);
      // The raw logical name is never echoed as a header.
      expect(r.headers["x-artifact-logical-name"]).toBeUndefined();
      expect(String(r.headers["x-artifact-sha256"])).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (savedA === undefined) delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
      else process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = savedA;
    }
  });

  it("F4. wrong artifact_id → 403, unpinned never served", async () => {
    const ctx = mkCtx("f4");
    const s = remoteSetup(ctx);
    const savedA = process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = "ART_MASTER_A";
    const server = createMissionControlServer({
      control: ctx.control,
      // R2.4 — injected consume master (bootstrap resolution), never
      // ambient env.
      artifactConsumeToken: "ART_MASTER_A",
    } as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const cap = mintArtifactConsumeCapability("ART_MASTER_A", {
        mission_id: ctx.missionId,
        task_id: s.cons.tid,
        governed_task_id: s.gc.gtId,
        execution_id: s.gc.eid!,
        executor_id: s.gc.executor,
        dependency_set_digest: artifactDependencySetDigest(s.entries),
        issued_at: utcnow(),
      } as never);
      const post = (id: string) =>
        new Promise<number>((resolve, reject) => {
          const rq = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/artifacts/fetch",
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-artifact-consume-capability": cap,
              },
            },
            (rs) => {
              rs.resume();
              rs.on("end", () => resolve(rs.statusCode ?? 0));
            },
          );
          rq.on("error", reject);
          rq.end(JSON.stringify({ artifact_id: id }));
        });
      expect(await post("ART_notpinned")).toBe(403);
      expect(await post(s.entries[0]!.artifact_id)).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (savedA === undefined) delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
      else process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = savedA;
    }
  });
});

/* == R1.7 G — production-path E2E: real MissionRuntime + real HTTP server == */
describe("R1.7 G — production E2E", () => {
  const UPMASTER = "e2e-artifact-master";

  function rtCtx(name: string) {
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
    const planner = (input: { mission: Record<string, unknown> }) => {
      const llm = input.mission?.metadata?.llm_plan as
        | Array<Record<string, unknown>>
        | undefined;
      return { tasks: reconcilePlanDataflow(JSON.parse(JSON.stringify(llm ?? []))).tasks };
    };
    const runtime = new MissionRuntime({
      service, gate, router, adapters: adapters as never, scheduler, approvals,
      reconciliation: recon, recovery, planner: planner as never,
      telegramDeliveryDefaultChatId: "111",
    });
    const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
    const control = new MissionControl({
      service, runtime, supervisor, scheduler, approvals,
      reconciliation: recon, observability: new MissionObservability(service),
      planner: planner as never,
    });
    for (const cap of ["FILE_OPERATIONS", "REASONING", REMOTE_CAP]) {
      service.registerCapability(cap, { risk_class: "LOW" });
    }
    const project = service.createProject({ name, root_location: workspace });
    return {
      d, workspace, store, service, gate, registry, router, recovery, recon,
      approvals, scheduler, runtime, supervisor, control, adapters,
      projectId: String(project.project_id),
    };
  }

  const registerE2EAdapter = (
    ctx: ReturnType<typeof rtCtx>,
    adapter: ExecutorAdapter & { caps: string[] },
  ) => {
    ctx.registry.register({
      executor_id: adapter.executor_id,
      executor_type: "EXTERNAL",
      capabilities: adapter.caps,
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
      capabilities: adapter.caps,
      priority: 50,
      executor_hint: adapter.executor_id,
    });
    ctx.service.routes.registerBinding({
      executor_id: adapter.executor_id,
      route_id: routeId,
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
      capabilities: adapter.caps,
    });
    ctx.adapters.set(adapter.executor_id, adapter);
  };

  const curlPost = (
    port: number,
    p: string,
    headers: Record<string, string>,
    bodyJson: Record<string, unknown>,
  ): { status: number; body: Buffer } => {
    const bodyFile = path.join(ROOT, `req-${n++}.json`);
    const outFile = path.join(ROOT, `res-${n++}.bin`);
    fs.writeFileSync(bodyFile, JSON.stringify(bodyJson));
    const args = ["-s", "-o", outFile, "-w", "%{http_code}", "-X", "POST",
      `http://127.0.0.1:${port}${p}`];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push("-H", "content-type: application/json", "--data-binary", `@${bodyFile}`);
    const status = Number(execFileSync("curl", args, { encoding: "utf8" }).trim());
    const body = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
    return { status, body };
  };

  /**
   * A remote executor speaking the REAL lane: acread1 fetch over HTTP at
   * /api/artifacts/fetch + acap1 upload over HTTP at /api/outbox. Fetch
   * attempts at dispatch land BEFORE the durable exec row exists
   * (execution_unknown → 403); observe() retries see the persisted
   * RUNNING exec → 200 + bytes.
   */
  class HttpRemoteAdapter {
    executor_id = EX_REMOTE;
    caps = [REMOTE_CAP];
    fetchLog: Array<{ phase: string; artifact_id: string; status: number }> = [];
    depBytes = new Map<string, Buffer>();
    uploadLog: Array<{ filename: string; status: number }> = [];
    private tasks = new Map<string, Record<string, unknown>>();
    private produced = new Set<string>();
    constructor(
      public port: number,
      private store: PairEvidenceStore,
    ) {}
    /** The task's declared pair_dataflow.produces — the real remote job's
     *  declared outputs. */
    private producesOf(task: Record<string, unknown>): string[] {
      const row = this.store.tryGet("task", String(task.task_id));
      const df = (row?.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined;
      return (df?.produces as string[]) ?? [];
    }

    private consumeCap(eid: string, task: Record<string, unknown>) {
      return mintArtifactConsumeCapability(UPMASTER, {
        mission_id: task.mission_id,
        task_id: task.task_id,
        governed_task_id: task.governed_task_id,
        execution_id: eid,
        executor_id: this.executor_id,
        dependency_set_digest: artifactDependencySetDigest(
          (task.dependency_artifacts as DependencyArtifactEntry[]) ?? [],
        ),
        issued_at: utcnow(),
      } as never);
    }

    private doFetch(cap: string, artifactId: string, phase: string) {
      const r = curlPost(this.port, "/api/artifacts/fetch",
        { "x-artifact-consume-capability": cap },
        { artifact_id: artifactId });
      this.fetchLog.push({ phase, artifact_id: artifactId, status: r.status });
      return r;
    }

    qualify() { return { qualified: true, dispatch_enabled: true }; }
    capabilities() { return { capability_ids: this.caps }; }

    dispatch(task: Record<string, unknown>) {
      const eid = workerExecutionId(this.executor_id, String(task.governed_task_id));
      this.tasks.set(eid, task);
      const deps = (task.dependency_artifacts ?? []) as DependencyArtifactEntry[];
      if (deps.length) {
        const cap = this.consumeCap(eid, task);
        for (const dep of deps) {
          // R1.7 proof: the durable exec does not exist yet — bounded
          // retries across identical attempts stay execution_unknown.
          this.doFetch(cap, dep.artifact_id, "pre-exec");
          this.doFetch(cap, dep.artifact_id, "pre-exec");
        }
      }
      return { execution_id: eid, status: "RUNNING", run_root: null };
    }

    observe(executionId: string) {
      const task = this.tasks.get(executionId);
      if (task && !this.produced.has(executionId)) {
        this.produced.add(executionId);
        // Exec row is persisted RUNNING now: deps fetch succeeds.
        const deps = (task.dependency_artifacts ?? []) as DependencyArtifactEntry[];
        if (deps.length) {
          const cap = this.consumeCap(executionId, task);
          for (const dep of deps) {
            const r = this.doFetch(cap, dep.artifact_id, "running");
            if (r.status === 200) this.depBytes.set(dep.artifact_id, r.body);
          }
        }
        // Upload declared outputs through the canonical acap1 lane.
        for (const filename of this.producesOf(task)) {
          const bytes = Buffer.from(`content of ${filename}`);
          const cap = mintArtifactCapability(UPMASTER, {
            mission_id: task.mission_id,
            task_id: task.task_id,
            governed_task_id: task.governed_task_id,
            execution_id: executionId,
            executor_id: this.executor_id,
          } as never);
          const r = curlPost(this.port, "/api/outbox",
            { "x-artifact-capability": cap },
            {
              filename,
              mission_id: String(task.mission_id),
              task_id: String(task.task_id),
              data_base64: bytes.toString("base64"),
            });
          this.uploadLog.push({ filename, status: r.status });
        }
      }
      return { status: "COMPLETED" };
    }

    collect_result(executionId: string) {
      // Restart-resilient: fall back to the durable execution row when
      // this adapter instance never saw the dispatch (post-crash settle).
      const t =
        this.tasks.get(executionId) ??
        (this.store.tryGet("executor_execution", executionId) as Record<
          string,
          unknown
        > | null) ??
        {};
      return {
        execution_id: executionId,
        worker_execution_id: executionId,
        mission_id: t.mission_id,
        task_id: t.task_id,
        governed_task_id: t.governed_task_id,
        status: "COMPLETED",
        summary: "remote done",
        artifacts: [],
      };
    }
    collect_artifacts() { return []; }
    cancel() { return { status: "CANCELLED" }; }
    health() { return { state: "READY" }; }
  }

  /** Local executor: reads the materialized dep bytes at dispatch like a
   *  real worker, writes its declared output, and returns the canonical
   *  WorkerResult envelope with declared artifacts for the F1 validator. */
  class LocalWorkerAdapter {
    executor_id = EX;
    caps = ["FILE_OPERATIONS", "REASONING"];
    readAtDispatch = new Map<string, Buffer>();
    private tasks = new Map<string, Record<string, unknown>>();
    constructor(private store: PairEvidenceStore) {}
    private producesOf(task: Record<string, unknown>): string[] {
      const row = this.store.tryGet("task", String(task.task_id));
      const df = (row?.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined;
      return (df?.produces as string[]) ?? [];
    }

    qualify() { return { qualified: true, dispatch_enabled: true }; }
    capabilities() { return { capability_ids: this.caps }; }

    dispatch(task: Record<string, unknown>) {
      const eid = workerExecutionId(this.executor_id, String(task.governed_task_id));
      this.tasks.set(eid, task);
      for (const dep of (task.dependency_artifacts ?? []) as DependencyArtifactEntry[]) {
        const p = path.join(
          String(task.workspace),
          dep.consumer_relative_path,
        );
        this.readAtDispatch.set(dep.artifact_id, fs.readFileSync(p));
      }
      const ws = String(task.workspace);
      for (const name of this.producesOf(task)) {
        fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
        fs.writeFileSync(path.join(ws, name), `content of ${name}`);
      }
      return { execution_id: eid, status: "RUNNING", run_root: null, workspace: ws };
    }
    observe() { return { status: "COMPLETED" }; }
    collect_result(executionId: string) {
      const t =
        this.tasks.get(executionId) ??
        (this.store.tryGet("executor_execution", executionId) as Record<
          string,
          unknown
        > | null) ??
        {};
      const ws = String(t.workspace ?? "");
      const artifacts = this.producesOf(t).map((name) => {
        const b = fs.readFileSync(path.join(ws, name));
        return { path: name, sha256: sha256Hex(b), byte_size: b.length };
      });
      return {
        execution_id: executionId,
        worker_execution_id: executionId,
        mission_id: t.mission_id,
        task_id: t.task_id,
        governed_task_id: t.governed_task_id,
        status: "COMPLETED",
        summary: "done",
        artifacts,
      };
    }
    collect_artifacts() { return []; }
    cancel() { return { status: "CANCELLED" }; }
    health() { return { state: "READY" }; }
  }

  /** A REAL mission-control HTTP server in a SEPARATE OS PROCESS on the
   *  same pair.db — production-shaped: the remote worker's curl fetch and
   *  upload hit a live socket while the local runtime keeps ticking. */
  const WORKER_PATH = new URL("./pair-f2-e2e-server.worker.mts", import.meta.url)
    .pathname;
  const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const startServer = async (ctx: { d: string }) => {
    const child: ChildProcess = spawn(
      TSX,
      [WORKER_PATH, path.join(ctx.d, "pair.db"), UPMASTER],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const to = setTimeout(() => reject(new Error("server worker port timeout")), 30_000);
      child.stdout!.on("data", (c: Buffer) => {
        buf += c.toString();
        const mm = /PORT (\d+)/.exec(buf);
        if (mm) {
          clearTimeout(to);
          resolve(Number(mm[1]));
        }
      });
      child.on("exit", (code) =>
        reject(new Error(`server worker exited ${code} buf=${buf}`)),
      );
    });
    // F5.5 — the simulated deployment HAS the remote ingest lane (the
    // spawned worker serves /api/outbox with UPMASTER); declare it in env
    // exactly like the prod start script does so the structural
    // lane-availability gate sees the same deployment reality.
    const savedEnv = {
      PAIR_OUTBOX_URL: process.env.PAIR_OUTBOX_URL,
      PAIR_ARTIFACT_UPLOAD_TOKEN: process.env.PAIR_ARTIFACT_UPLOAD_TOKEN,
    };
    process.env.PAIR_OUTBOX_URL = `http://127.0.0.1:${port}`;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = UPMASTER;
    return {
      port,
      child: child as ChildProcess,
      close: async () => {
        child.kill("SIGTERM");
        await new Promise<void>((r) => child.on("exit", () => r()));
        for (const k of Object.keys(savedEnv) as Array<keyof typeof savedEnv>) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
      },
    };
  };

  const rt = (ctx: ReturnType<typeof rtCtx>, mid: string) =>
    ctx.store.get("mission_runtime", `MRT_${mid}`);
  function drive(ctx: ReturnType<typeof rtCtx>, mid: string, max = 120) {
    let t = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < max; i++) {
      t += 120_000;
      ctx.runtime.tick(mid, new Date(t).toISOString());
      const s = String(rt(ctx, mid).state);
      if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s))
        return s;
    }
    return String(rt(ctx, mid).state);
  }
  const taskRow = (ctx: ReturnType<typeof rtCtx>, mid: string, key: string) =>
    ctx.service.listTasks(mid).find((t) => t.task_key === key)!;

  it("G1. remote producer → local consumer over real runtime + real HTTP", async () => {
    const ctx = rtCtx("g1");
    const srv = await startServer(ctx);
    try {
      const remote = new HttpRemoteAdapter(srv.port, ctx.store);
      const local = new LocalWorkerAdapter(ctx.store);
      registerE2EAdapter(ctx, remote as never);
      registerE2EAdapter(ctx, local as never);
      const m = ctx.control.startMission({
        project_id: ctx.projectId,
        goal: "g1",
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: [ctx.workspace],
        metadata: {
          llm_plan: [
            { task_key: "T1", title: "produce", task_instruction: "write report.txt containing findings, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: [], metadata: {} },
            { task_key: "T2", title: "consume", task_instruction: "read report.txt and write summary.txt, then reply DONE.", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"], metadata: {} },
          ],
        },
      });
      const mid = String(m.mission_id);
      expect(drive(ctx, mid)).toBe("COMPLETED");
      // Exact pinned bytes materialized and read by the real consumer path.
      const artId = Array.from(local.readAtDispatch.keys())[0]!;
      expect(local.readAtDispatch.get(artId)).toEqual(Buffer.from("content of report.txt"));
      expect(remote.uploadLog).toEqual([{ filename: "report.txt", status: 200 }]);
      // summary.txt became its own canonical F1 artifact.
      const arts = ctx.store.list("artifact");
      expect(arts.map((a) => String(a.logical_name)).sort())
        .toEqual(["report.txt", "summary.txt"]);
      // Exactly one execution each — no duplicate dispatch.
      const execs = ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
      expect(execs).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it("G2. remote consumer fetch lifecycle — pre-exec 403 ×2 then RUNNING 200 over real HTTP", async () => {
    const ctx = rtCtx("g2");
    const srv = await startServer(ctx);
    try {
      const remote = new HttpRemoteAdapter(srv.port, ctx.store);
      registerE2EAdapter(ctx, remote as never);
      const m = ctx.control.startMission({
        project_id: ctx.projectId,
        goal: "g2",
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: [ctx.workspace],
        metadata: {
          llm_plan: [
            { task_key: "T1", title: "produce", task_instruction: "write report.txt containing findings, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: [], metadata: {} },
            { task_key: "T2", title: "consume", task_instruction: "read report.txt and write summary.txt, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: ["T1"], metadata: {} },
          ],
        },
      });
      const mid = String(m.mission_id);
      expect(drive(ctx, mid)).toBe("COMPLETED");
      const pre = remote.fetchLog.filter((f) => f.phase === "pre-exec");
      const run = remote.fetchLog.filter((f) => f.phase === "running");
      expect(pre.map((f) => f.status)).toEqual([403, 403]);
      expect(run.map((f) => f.status)).toEqual([200]);
      expect(remote.depBytes.get(run[0]!.artifact_id)).toEqual(Buffer.from("content of report.txt"));
      expect(remote.uploadLog.map((u) => u.status)).toEqual([200, 200]);
    } finally {
      await srv.close();
    }
  });

  it("G3. restart between producer PASS and consumer dispatch → re-derive from durable state", async () => {
    const ctx = rtCtx("g3");
    const srv = await startServer(ctx);
    const remoteA = new HttpRemoteAdapter(srv.port, ctx.store);
    const localA = new LocalWorkerAdapter(ctx.store);
    registerE2EAdapter(ctx, remoteA as never);
    registerE2EAdapter(ctx, localA as never);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "g3",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: {
        llm_plan: [
          { task_key: "T1", title: "produce", task_instruction: "write report.txt containing findings, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: [], metadata: {} },
          { task_key: "T2", title: "consume", task_instruction: "read report.txt and write summary.txt, then reply DONE.", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"], metadata: {} },
        ],
      },
    });
    const mid = String(m.mission_id);
    // Drive until T1's task is COMPLETED, then "crash". Tasks materialize
    // on the first tick — guard the pre-plan read.
    let t = Date.parse("2026-01-01T00:00:00Z");
    for (
      let i = 0;
      i < 60 && String(taskRow(ctx, mid, "T1")?.status ?? "") !== "COMPLETED";
      i++
    ) {
      t += 120_000;
      ctx.runtime.tick(mid, new Date(t).toISOString());
    }
    expect(String(taskRow(ctx, mid, "T1")?.status)).toBe("COMPLETED");
    await srv.close();

    // Fresh store/control/runtime/adapters on the SAME pair.db — only
    // durable rows/events/CAS survive.
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const registry2 = new ExecutorRegistry(service2);
    const router2 = new MissionRouter(service2, gate2);
    const recovery2 = new RecoveryController(service2);
    const recon2 = new ReconciliationService(service2, new Map());
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const adapters2 = new Map<string, ExecutorAdapter>();
    const remote2 = new HttpRemoteAdapter(srv.port, store2);
    const local2 = new LocalWorkerAdapter(store2);
    const register2 = (adapter: HttpRemoteAdapter | LocalWorkerAdapter) => {
      registry2.register({
        executor_id: adapter.executor_id,
        executor_type: "EXTERNAL",
        capabilities: adapter.caps,
        health_state: "READY",
        status: "ENABLED",
        metadata: {
          routing_priority: 50, transport_type: TRANSPORT_IN_PROCESS,
          qualification_state: "QUALIFIED",
          permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
          workspace_modes: ["EXPLICIT_WORKSPACE"],
          supports_cancel: true, max_concurrency: 4,
        },
      });
      adapters2.set(adapter.executor_id, adapter as never);
    };
    register2(remote2); register2(local2);
    const planner2 = (input: { mission: Record<string, unknown> }) => {
      const llm = input.mission?.metadata?.llm_plan as Array<Record<string, unknown>> | undefined;
      return { tasks: reconcilePlanDataflow(JSON.parse(JSON.stringify(llm ?? []))).tasks };
    };
    const runtime2 = new MissionRuntime({
      service: service2, gate: gate2, router: router2, adapters: adapters2 as never,
      scheduler: scheduler2, approvals: approvals2, reconciliation: recon2,
      recovery: recovery2, planner: planner2 as never,
      telegramDeliveryDefaultChatId: "111",
    });
    const ctx3 = { ...ctx, store: store2, service: service2, runtime: runtime2 };
    // New server instance on the fresh control plane.
    const srv2 = await startServer(ctx3);
    try {
      remote2.port = srv2.port;
      const state = (() => {
        let tt = Date.parse("2026-01-01T06:00:00Z");
        for (let i = 0; i < 120; i++) {
          tt += 120_000;
          runtime2.tick(mid, new Date(tt).toISOString());
          const s = String(store2.get("mission_runtime", `MRT_${mid}`).state);
          if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s)) return s;
        }
        return String(store2.get("mission_runtime", `MRT_${mid}`).state);
      })();
      expect(state).toBe("COMPLETED");
      // T2 may have dispatched pre-crash (localA) or post-restart (local2):
      // whichever ran, it read the exact pinned bytes from the durable
      // materialization — and there is no duplicate dispatch.
      const merged = new Map([...localA.readAtDispatch, ...local2.readAtDispatch]);
      const artId = Array.from(merged.keys())[0]!;
      expect(merged.get(artId)).toEqual(Buffer.from("content of report.txt"));
      const execs = store2.list("executor_execution").filter((e) => e.mission_id === mid);
      expect(execs).toHaveLength(2);
      const t2exec = execs.find((e) => String(e.task_id) === String(taskRow(ctx3, mid, "T2").task_id))!;
      expect(t2exec).toBeTruthy();
    } finally {
      await srv2.close();
      store2.close();
    }
  });

  it("G4. remote non-leaf over HTTP: declared remote→remote edge flows, consumer fetches mid-DAG", async () => {
    const ctx = rtCtx("g4");
    const srv = await startServer(ctx);
    try {
      const remote = new HttpRemoteAdapter(srv.port, ctx.store);
      const local = new LocalWorkerAdapter(ctx.store);
      registerE2EAdapter(ctx, remote as never);
      registerE2EAdapter(ctx, local as never);
      const m = ctx.control.startMission({
        project_id: ctx.projectId,
        goal: "g4",
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: [ctx.workspace],
        metadata: {
          llm_plan: [
            { task_key: "T1", title: "produce", task_instruction: "write report.txt containing findings, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: [], metadata: {} },
            { task_key: "T2", title: "consume", task_instruction: "read report.txt and write summary.txt, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: ["T1"], metadata: {} },
            { task_key: "T3", title: "final", task_instruction: "read summary.txt and write final.txt, then reply DONE.", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"], metadata: {} },
          ],
        },
      });
      const mid = String(m.mission_id);
      expect(drive(ctx, mid)).toBe("COMPLETED");
      // T2 (remote non-leaf) fetched T1's artifact over HTTP.
      const t2fetches = remote.fetchLog.filter((f) => f.phase === "running");
      expect(t2fetches.map((f) => f.status)).toEqual([200]);
      // T3 (local leaf) read T2's remote-produced bytes via materialization.
      const artId = Array.from(local.readAtDispatch.keys())[0]!;
      expect(local.readAtDispatch.get(artId)).toEqual(Buffer.from("content of summary.txt"));
      const names = ctx.store.list("artifact").map((a) => String(a.logical_name)).sort();
      expect(names).toEqual(["final.txt", "report.txt", "summary.txt"]);
      const execs = ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
      expect(execs).toHaveLength(3);
    } finally {
      await srv.close();
    }
  });
});
