/**
 * F2 — Cross-executor canonical artifact handoff (permanent suite).
 *
 *   A  dependency resolution (unique producer, ambiguity, unbound,
 *      cross-mission, remote-producer hard requirement, legacy skip)
 *   B  producer terminal-validation authority (no PASS → not consumable)
 *   C  local materialization (deterministic root, exact bytes, ordering)
 *   D  materialization idempotency (converge / conflict / symlink)
 *   E  destination containment (traversal, absolute, outside root,
 *      allowed_paths, normalize-collision)
 *   F  restart/crash convergence (durable re-read → identical pins)
 *   G  remote consume capability (mint/verify, claim binding)
 *   H  remote byte fetch lifecycle (live fetch, retry, closed, replay)
 *   I  cross-executor matrix (L→L, R→L, L→R, R→R)
 *   J  history/CAS tamper (delete/corrupt/symlink/row/ref → reject)
 *   K  governance pin tamper (post-governance mutation → not dispatchable)
 *   L  legacy/rogue rows (injected ART, foreign-exec history)
 *   M  remote DAG narrowing (declared edge accepted / undeclared rejected)
 *   N  telegram/delivery non-regression (delivery tasks never re-authored)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ArtifactDependencyResolver,
  ArtifactHandoffService,
  ArtifactProvenanceValidator,
  canonicalArtifactId,
  canonicalHandoffId,
  DependencyResolutionError,
  DEPENDENCY_ARTIFACT_CONTRACT,
  digest,
  DEPENDENCY_ARTIFACT_ROOT,
  dependencyConsumerPath,
  artifactDependencySetDigest,
  GovernedTaskGate,
  HANDOFF_ENTITY,
  IntegrityError,
  mintArtifactCapability,
  mintArtifactConsumeCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  reconcilePlanDataflow,
  sha256Hex,
  utcnow,
  validateDependencyArtifactEntry,
  verifyArtifactConsumeCapability,
  workerExecutionId,
  type DependencyArtifactEntry,
} from "../pair/index.js";
import type { ExecutorAdapter } from "../pair/adapter.js";

const ROOT = mkTmpDir("pair-f2-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_F2";
const EX_REMOTE = "EX_REMOTE_F2";
const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const MASTER = "f2-consume-master-secret";

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
    goal: "f2",
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
/**
 * Drive a producer to a canonical terminal PASS the way production does:
 * real task + governed + executor_execution rows, a real artifact write
 * (LOCAL_EXECUTION workspace file, or REMOTE_UPLOAD via the capability
 * ingest lane), then the REAL validator writes execution_validation.
 */
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
  const tid = `ATSK_F2_${seq++}`;
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
      plan_id: "PLAN_F2",
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
      plan_id: "PLAN_F2",
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
  {
    // F5 R1.B — mirror the production mint: every governed task emits the
    // immutable GOVERNED_TASK_VALIDATED anchor binding the mint-time
    // identity + scope digest; remote tasks additionally pin the F5
    // declared-produces contract.
    const governed = ctx.store.get("governed_task", gtId);
    if (opts.remote) {
      governed.expected_output_contract = {
        type: "TASK_RESULT",
        declared_produces: [name],
      };
    }
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
    const declared = opts.remote ? [name] : null;
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
        plan_id: "PLAN_F2", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: !!opts.remote,
        declared_produces: declared,
        declared_produces_digest: declared ? digest(declared) : null,
      },
    });
    ctx.store.appendEvidence(ctx.missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: executor,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: !!opts.remote,
      declared_produces: declared,
      declared_produces_digest: declared ? digest(declared) : null,
    });
  }
  const bytes = opts.artifactBytes === undefined ? Buffer.from(`artifact-of-${tid}`) : opts.artifactBytes;
  // Production order: dispatch persists the live execution FIRST, the
  // worker uploads (remote) / writes the file (local), then the result
  // lands and the validator runs.
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
      // REAL remote ingest lane: execution-scoped capability → canonical
      // ART + retained CAS bytes. The worker-side result stays
      // artifacts:[] — verifyForExecution picks up the accepted upload.
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
      declared = [{ path: name, sha256: sha256Hex(bytes), byte_size: bytes.length }];
    }
  }
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put("executor_execution", eid, {
    ...settled,
    execution_state: opts.pass === false ? "FAILED" : "COMPLETED",
    result: {
      status: opts.pass === false ? "FAILED" : "COMPLETED",
      artifacts: declared,
    },
  }, settled.version);
  if (opts.validate !== false) {
    new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
  }
  return { tid, gtId, eid, executor, name, bytes: bytes ?? Buffer.alloc(0), task_key: key };
}

/** A consumer task row in the SAME plan as `producers`, declaring a
 *  canonical consume edge for `consume` and depending on the producers'
 *  task_keys. */
function mkConsumer(
  ctx: ReturnType<typeof mkCtx>,
  producers: ReturnType<typeof mkProducer>[],
  opts: { consume?: string | string[]; produces?: string[]; remote?: boolean; depends_on?: string[] } = {},
) {
  const tid = `ATSK_C_${seq++}`;
  const key = `TC${seq}`;
  const consumes = Array.isArray(opts.consume)
    ? opts.consume
    : [opts.consume ?? producers[0]?.name ?? "report.txt"];
  const produces = opts.produces ?? [];
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid,
      task_key: key,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2",
      title: key,
      task_instruction: `read ${consumes.join(",")} then reply DONE.`,
      required_capabilities: opts.remote ? [REMOTE_CAP] : ["FILE_OPERATIONS"],
      depends_on: opts.depends_on ?? producers.map((p) => p.task_key),
      status: "READY",
      metadata: { pair_dataflow: { produces, consumes } },
      version: 0,
    },
    0,
  );
  return { tid, task: ctx.store.get("task", tid), task_key: key, consume: consumes[0] };
}

/** Consumer governed task (+ optional live executor_execution) pinned
 *  with `entries` — the shape gate.dispatch produces. */
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
  // Production order (gate.createGovernedTaskContinuation): the governed
  // row + dep-set digest is pinned, then the immutable VALIDATED event
  // records that same digest — the dep_set_history anchor.
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
  return { gtId, eid, governed: ctx.store.get("governed_task", gtId), executor };
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
    // PolicyError and other code-bearing failures collapse to their code.
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string") return code;
    return `OTHER:${String(e)}`;
  }
};

/** A minimal adapter: records dispatch calls and reads the materialized
 *  handoff bytes inside the workspace at dispatch time. */
function stubAdapter(spy: { calls: number; readAtDispatch?: Buffer | null }) {
  return {
    executor_id: EX,
    runtime_type: "EXTERNAL",
    qualify: () => ({ qualified: true, dispatch_enabled: true }),
    dispatch: (task: Record<string, unknown>) => {
      spy.calls++;
      const dep = (task.dependency_artifacts as DependencyArtifactEntry[]) ?? [];
      if (dep.length) {
        const p = path.join(String(task.workspace), dep[0]!.consumer_relative_path);
        spy.readAtDispatch = fs.existsSync(p) ? fs.readFileSync(p) : null;
      }
      return {
        execution_id: workerExecutionId(EX, String(task.governed_task_id)),
        status: "STARTED",
      };
    },
    observe: () => ({ status: "RUNNING" }),
    cancel: () => ({ status: "CANCELLED" }),
    collect_result: () => ({ status: "COMPLETED", artifacts: [] }),
    collect_artifacts: () => [],
    health: () => ({ state: "READY" }),
  } as unknown as ExecutorAdapter;
}

const depSetup = (ctx: ReturnType<typeof mkCtx>, opts: { remote?: boolean; producerRemote?: boolean } = {}) => {
  const prod = mkProducer(ctx, { produces: "report.txt", remote: opts.producerRemote });
  const cons = mkConsumer(ctx, [prod], { remote: opts.remote });
  const entries = resolver(ctx).resolveForConsumer({
    mission: freshMission(ctx),
    task: cons.task,
  });
  return { prod, cons, entries };
};

/* ============================ A — RESOLUTION ============================ */
describe("A — dependency resolution", () => {
  it("A1. declared consume → unique producer predecessor → canonical pinned entry", () => {
    const ctx = mkCtx("a1");
    const { prod, cons, entries } = depSetup(ctx);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.contract).toBe(DEPENDENCY_ARTIFACT_CONTRACT);
    expect(e.artifact_id).toBe(canonicalArtifactId(prod.eid, "report.txt"));
    expect(e.producer_task_id).toBe(prod.tid);
    expect(e.producer_governed_task_id).toBe(prod.gtId);
    expect(e.producer_execution_id).toBe(prod.eid);
    expect(e.producer_executor_id).toBe(EX);
    expect(e.logical_name).toBe("report.txt");
    expect(e.sha256).toBe(sha256Hex(prod.bytes));
    expect(e.byte_size).toBe(prod.bytes.length);
    expect(e.consumer_relative_path).toBe(dependencyConsumerPath(cons.tid, e.artifact_id, "report.txt"));
  });

  it("A2. consume name with no producing predecessor → fail closed", () => {
    const ctx = mkCtx("a2");
    const prod = mkProducer(ctx, { produces: "other.txt" });
    const cons = mkConsumer(ctx, [prod], { consume: "missing.txt" });
    expect(errCode(() =>
      resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A3. two producers of the same name → ambiguous → fail closed", () => {
    const ctx = mkCtx("a3");
    const p1 = mkProducer(ctx, { produces: "dup.txt" });
    const p2 = mkProducer(ctx, { produces: "dup.txt" });
    const cons = mkConsumer(ctx, [p1, p2], { consume: "dup.txt" });
    expect(errCode(() =>
      resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A4. producer NOT in depends_on → not a predecessor → fail closed", () => {
    const ctx = mkCtx("a4");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod], { depends_on: [] });
    expect(errCode(() =>
      resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A8. consume ∩ own-produce with no predecessor → self-shadowed, no handoff", () => {
    const ctx = mkCtx("a8");
    const cons = mkConsumer(ctx, [], {
      consume: "exports/journal-export.json",
      produces: ["exports/journal-export.json"],
      depends_on: [],
    });
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    expect(entries).toHaveLength(0);
  });

  it("A9. consume ∩ own-produce + real depends_on producer → producer still binds", () => {
    const ctx = mkCtx("a9");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod], {
      consume: "report.txt",
      produces: ["report.txt"],
      depends_on: [prod.task_key],
    });
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.producer_task_id).toBe(prod.tid);
  });

  it("A10. self-produced consume skipped but a genuinely unbound consume still fails", () => {
    const ctx = mkCtx("a10");
    const cons = mkConsumer(ctx, [], {
      consume: ["self.txt", "truly-missing.txt"],
      produces: ["self.txt"],
      depends_on: [],
    });
    expect(errCode(() =>
      resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A5. artifact in another mission → never consumable", () => {
    const ctxA = mkCtx("a5a");
    const prod = mkProducer(ctxA, { produces: "report.txt" });
    const ctxB = mkCtx("a5b");
    const cons = mkConsumer(ctxB, [], { consume: "report.txt", depends_on: [prod.task_key] });
    expect(errCode(() =>
      resolver(ctxB).resolveForConsumer({ mission: freshMission(ctxB), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A6. remote producer without canonical artifact → FAIL CLOSED (no path fallback)", () => {
    const ctx = mkCtx("a6");
    const tid = `ATSK_RN_${seq++}`;
    ctx.store.put("task", tid, {
      task_id: tid, task_key: "TPR", mission_id: ctx.missionId, plan_id: "PLAN_F2",
      title: "remote", task_instruction: "make out.txt",
      required_capabilities: [REMOTE_CAP], depends_on: [], status: "COMPLETED",
      metadata: { pair_dataflow: { produces: ["out.txt"], consumes: [] } }, version: 0,
    }, 0);
    const cons = mkConsumer(ctx, [], { consume: "out.txt", depends_on: ["TPR"] });
    expect(errCode(() =>
      resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }),
    )).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("A7. local producer without canonical ART → legacy path edge stays OUT of the contract", () => {
    const ctx = mkCtx("a7");
    // producer declares produces but never landed an artifact (validated
    // with artifacts:[] — legacy path semantics).
    const prod = mkProducer(ctx, { produces: "report.txt", artifactBytes: null });
    const cons = mkConsumer(ctx, [prod]);
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });
});

/* ==================== B — PRODUCER VALIDATION ==================== */
describe("B — producer terminal validation authority", () => {
  it("B1. canonical ART but NO terminal validation → not consumable", () => {
    const ctx = mkCtx("b1");
    // Artifact accepted directly (real F1 seam) but the validator never
    // ran — no execution_validation row exists.
    const prod = mkProducer(ctx, { produces: "report.txt", validate: false });
    const cons = mkConsumer(ctx, [prod]);
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });

  it("B2. producer validation FAIL → not consumable", () => {
    const ctx = mkCtx("b2");
    const prod = mkProducer(ctx, { produces: "report.txt", pass: false });
    const cons = mkConsumer(ctx, [prod]);
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });

  it("B3. PASS row exists but does NOT list the ART → not consumable", () => {
    const ctx = mkCtx("b3");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const v = ctx.store.list("execution_validation")[0]!;
    ctx.store.put("execution_validation", String(v.validation_id),
      { ...v, artifact_ids: ["ART_other"] } as never, v.version);
    const cons = mkConsumer(ctx, [prod]);
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });

  it("B4. PASS + ART listed + F1 verifies NOW → consumable", () => {
    const ctx = mkCtx("b4");
    const { prod, entries } = depSetup(ctx);
    expect(entries).toHaveLength(1);
    const art = ctx.service.artifacts.verifyArtifactForConsumption(
      entries[0]!.artifact_id,
      { execution_id: prod.eid, mission_id: ctx.missionId, task_id: prod.tid },
    );
    expect(String(art.logical_name)).toBe("report.txt");
  });
});

/* ==================== C — LOCAL MATERIALIZATION ==================== */
describe("C — governed local materialization", () => {
  const setupConsumer = (ctx: ReturnType<typeof mkCtx>, opts: { remote?: boolean } = {}) => {
    const { prod, cons, entries } = depSetup(ctx, opts);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    return { prod, cons, gc, entries };
  };

  it("C1. pinned entry materializes exact CAS bytes at the deterministic destination", () => {
    const ctx = mkCtx("c1");
    const { prod, gc, entries } = setupConsumer(ctx);
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(written).toEqual([entries[0]!.consumer_relative_path]);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    const h = ctx.store.get(HANDOFF_ENTITY,
      canonicalHandoffId(gc.gtId, entries[0]!.artifact_id, entries[0]!.consumer_relative_path));
    expect(String(h.state)).toBe("MATERIALIZED");
    expect(String(h.mode)).toBe("LOCAL_MATERIALIZATION");
  });

  it("C2. handoff entity fields + PINNED/MATERIALIZED events", () => {
    const ctx = mkCtx("c2");
    const { gc, entries } = setupConsumer(ctx);
    handoffs(ctx).materializeForConsumer(gc.governed);
    const h = ctx.store.get(HANDOFF_ENTITY,
      canonicalHandoffId(gc.gtId, entries[0]!.artifact_id, entries[0]!.consumer_relative_path));
    expect(String(h.mission_id)).toBe(ctx.missionId);
    expect(String(h.artifact_id)).toBe(entries[0]!.artifact_id);
    expect(String(h.sha256)).toBe(entries[0]!.sha256);
    expect(String(h.producer_execution_id)).toBe(entries[0]!.producer_execution_id);
    expect(String(h.consumer_governed_task_id)).toBe(gc.gtId);
    const types = ctx.store.listEvents(HANDOFF_ENTITY).map((e) => String(e.event_type));
    expect(types).toEqual(expect.arrayContaining([
      "ARTIFACT_HANDOFF_PINNED", "ARTIFACT_HANDOFF_MATERIALIZED",
    ]));
  });

  it("C3. materialization runs BEFORE external dispatch (gate boundary)", () => {
    const ctx = mkCtx("c3");
    const { prod, gc } = setupConsumer(ctx);
    const spy = { calls: 0, readAtDispatch: null as Buffer | null };
    const exec = new GovernedTaskGate(ctx.service).dispatch_governed_task(stubAdapter(spy), gc.gtId);
    expect(spy.calls).toBe(1);
    expect(spy.readAtDispatch).toEqual(prod.bytes);
    expect(String(exec.execution_id)).toBe(workerExecutionId(EX, gc.gtId));
  });

  it("C4. producer source path deleted/corrupted after acceptance → canonical bytes still materialize", () => {
    const ctx = mkCtx("c4");
    const { prod, gc, entries } = setupConsumer(ctx);
    fs.writeFileSync(path.join(ctx.workspace, "report.txt"), "TAMPERED SOURCE");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.readFileSync(path.join(ctx.workspace, written[0]!))).toEqual(prod.bytes);
    expect(entries[0]!.consumer_relative_path.includes("report.txt")).toBe(true);
  });
});

/* ==================== D — MATERIALIZATION IDEMPOTENCY ==================== */
describe("D — materialization idempotency", () => {
  const setupD = (ctx: ReturnType<typeof mkCtx>) => {
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    return { prod, gc, entries };
  };

  it("D1. identical bytes → converge, no rewrite", () => {
    const ctx = mkCtx("d1");
    const { gc, entries } = setupD(ctx);
    handoffs(ctx).materializeForConsumer(gc.governed);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    const st1 = fs.statSync(dest);
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.statSync(dest).ino).toBe(st1.ino);
  });

  it("D2. different bytes at destination → fail closed", () => {
    const ctx = mkCtx("d2");
    const { gc, entries } = setupD(ctx);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "DIFFERENT BYTES");
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
  });

  it("D3. symlink at destination → fail closed", () => {
    const ctx = mkCtx("d3");
    const { gc, entries } = setupD(ctx);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const outside = path.join(ctx.d, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, dest);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
  });
});

/* ==================== E — PATH/CONTAINMENT ==================== */
describe("E — destination containment", () => {
  const entryWithPath = (rel: string): Record<string, unknown> => ({
    artifact_id: "ART_x",
    producer_task_id: "t", producer_governed_task_id: "g",
    producer_execution_id: "e", producer_executor_id: "x",
    logical_name: "n.txt", sha256: "0".repeat(64), byte_size: 1,
    consumer_relative_path: rel, contract: DEPENDENCY_ARTIFACT_CONTRACT,
  });

  it("E1. traversal/absolute/backslash/empty consumer_relative_path → contract reject", () => {
    for (const bad of [
      "../escape.txt",
      `${DEPENDENCY_ARTIFACT_ROOT}/ART/../../e.txt`,
      "/abs/x.txt",
      `${DEPENDENCY_ARTIFACT_ROOT}\\ART\\x.txt`,
      "",
    ]) {
      expect(errCode(() => validateDependencyArtifactEntry(entryWithPath(bad))))
        .toBe("FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT");
    }
  });

  it("E2. consumer_relative_path outside the handoff root → reject", () => {
    expect(errCode(() => validateDependencyArtifactEntry(entryWithPath("other/dir/x.txt"))))
      .toBe("FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT");
  });

  it("E3. same logical name across artifacts → distinct destinations (artifact_id keyed, no collision)", () => {
    expect(dependencyConsumerPath("TASK_C", "ART_A", "x.txt"))
      .not.toBe(dependencyConsumerPath("TASK_C", "ART_B", "x.txt"));
    // R3.1 — distinct consumers of the SAME artifact also get distinct
    // isolated destinations.
    expect(dependencyConsumerPath("TASK_C", "ART_A", "x.txt"))
      .not.toBe(dependencyConsumerPath("TASK_D", "ART_A", "x.txt"));
  });

  it("E4. destination outside allowed_paths → materialization rejects", () => {
    const ctx = mkCtx("e4");
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const narrowed = { ...gc.governed, allowed_paths: [path.join(ctx.workspace, "sub")] };
    expect(errCode(() => handoffs(ctx).materializeForConsumer(narrowed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    void prod;
  });
});

/* ==================== F — RESTART CONVERGENCE ==================== */
describe("F — restart/crash convergence", () => {
  it("F1. reopened store → resolution deterministic; same pins, no re-baseline", () => {
    const ctx = mkCtx("f1");
    const { cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const again = new ArtifactDependencyResolver(service2).resolveForConsumer({
      mission: service2.getMission(ctx.missionId),
      task: store2.get("task", cons.tid),
    });
    expect(again).toEqual(entries);
    service2.artifactHandoffs.pinForGovernedTask(
      store2.get("governed_task", gc.gtId), again, "LOCAL_MATERIALIZATION");
    expect(store2.list(HANDOFF_ENTITY)).toHaveLength(1);
    expect(String(store2.get(HANDOFF_ENTITY,
      canonicalHandoffId(gc.gtId, entries[0]!.artifact_id, entries[0]!.consumer_relative_path)).state))
      .toBe("PINNED");
  });

  it("F2. crash between materialization and dispatch → re-materialization converges to same bytes", () => {
    const ctx = mkCtx("f2");
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    handoffs(ctx).materializeForConsumer(gc.governed);
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const handoff2 = new ArtifactHandoffService(store2, new PairControlPlane(store2).artifacts);
    const written = handoff2.materializeForConsumer(store2.get("governed_task", gc.gtId));
    expect(written).toEqual([entries[0]!.consumer_relative_path]);
    expect(fs.readFileSync(path.join(ctx.workspace, written[0]!))).toEqual(prod.bytes);
  });
});

/* ==================== G — CONSUME CAPABILITY ==================== */
describe("G — remote consume capability", () => {
  const claims = (over: Record<string, unknown> = {}) => ({
    mission_id: "M1", task_id: "T1", governed_task_id: "G1",
    execution_id: "E1", executor_id: "X1",
    dependency_set_digest: "d".repeat(64), issued_at: utcnow(),
    ...over,
  });

  it("G1. mint/verify roundtrip binds all claims; acread1 domain differs from acap1", () => {
    const cap = mintArtifactConsumeCapability(MASTER, claims() as never);
    expect(cap.startsWith("acread1.")).toBe(true);
    const v = verifyArtifactConsumeCapability(MASTER, cap);
    expect(v?.execution_id).toBe("E1");
    expect(v?.dependency_set_digest).toBe("d".repeat(64));
    expect(verifyArtifactConsumeCapability(MASTER, cap.replace("acread1.", "acap1."))).toBeNull();
    expect(verifyArtifactConsumeCapability(MASTER, "garbage")).toBeNull();
  });

  it("G2. forged signature / wrong master / tampered claim → reject", () => {
    const cap = mintArtifactConsumeCapability(MASTER, claims() as never);
    expect(verifyArtifactConsumeCapability("wrong-master", cap)).toBeNull();
    const [payload, sig] = cap.slice("acread1.".length).split(".");
    const tampered = `acread1.${Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
      execution_id: "OTHER",
    })).toString("base64url")}.${sig}`;
    expect(verifyArtifactConsumeCapability(MASTER, tampered)).toBeNull();
  });
});

/* ==================== H — REMOTE FETCH LIFECYCLE ==================== */
describe("H — remote fetch lifecycle", () => {
  const remoteSetup = (
    ctx: ReturnType<typeof mkCtx>,
    opts: { execState?: string | null; result?: boolean; producerRemote?: boolean } = {},
  ) => {
    const { prod, cons, entries } = depSetup(ctx, { remote: true, producerRemote: opts.producerRemote ?? true });
    const gc = mkGovernedConsumer(ctx, cons, entries, { remote: true, execState: opts.execState ?? "RUNNING" });
    if (opts.result && gc.eid) {
      const exec = ctx.store.get("executor_execution", gc.eid);
      ctx.store.put("executor_execution", gc.eid, { ...exec, result: { status: "COMPLETED", artifacts: [] } }, exec.version);
    }
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
    const cap = mintArtifactConsumeCapability(MASTER, {
      mission_id: ctx.missionId, task_id: cons.tid, governed_task_id: gc.gtId,
      execution_id: gc.eid!, executor_id: gc.executor,
      dependency_set_digest: artifactDependencySetDigest(entries),
      issued_at: utcnow(),
    } as never);
    return { prod, cons, gc, entries, cap };
  };

  it("H1. live fetch → exact bytes + FETCHED transition + durable event", () => {
    const ctx = mkCtx("h1");
    const { prod, gc, entries, cap } = remoteSetup(ctx);
    const r = ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id });
    expect(r.bytes).toEqual(prod.bytes);
    const h = ctx.store.get(HANDOFF_ENTITY,
      canonicalHandoffId(gc.gtId, entries[0]!.artifact_id, entries[0]!.consumer_relative_path));
    expect(String(h.state)).toBe("FETCHED");
    const types = ctx.store.listEvents(HANDOFF_ENTITY).map((e) => String(e.event_type));
    expect(types).toContain("ARTIFACT_HANDOFF_FETCHED");
  });

  it("H2. idempotent retry while live → same exact bytes", () => {
    const ctx = mkCtx("h2");
    const { prod, entries, cap } = remoteSetup(ctx);
    const r1 = ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id });
    const r2 = ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id });
    expect(r2.bytes).toEqual(r1.bytes);
    expect(r2.bytes).toEqual(prod.bytes);
  });

  it("H3. fetch before the consumer execution row exists → reject", () => {
    const ctx = mkCtx("h3");
    const prod = mkProducer(ctx, { produces: "out.txt", remote: true });
    const cons = mkConsumer(ctx, [prod], { remote: true, consume: "out.txt" });
    const entries = resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task });
    const gc = mkGovernedConsumer(ctx, cons, entries, { remote: true, execState: null });
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
    const cap = mintArtifactConsumeCapability(MASTER, {
      mission_id: ctx.missionId, task_id: cons.tid, governed_task_id: gc.gtId,
      execution_id: workerExecutionId(EX_REMOTE, gc.gtId), executor_id: EX_REMOTE,
      dependency_set_digest: artifactDependencySetDigest(entries), issued_at: utcnow(),
    } as never);
    expect(errCode(() => ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id })))
      .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("H4. terminal execution → reject; result persisted → reject", () => {
    const ctx = mkCtx("h4");
    const { gc, entries, cap } = remoteSetup(ctx);
    const exec = ctx.store.get("executor_execution", gc.eid!);
    ctx.store.put("executor_execution", gc.eid!, { ...exec, execution_state: "COMPLETED" }, exec.version);
    expect(errCode(() => ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id })))
      .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
    const ctx2 = mkCtx("h4b");
    const s2 = remoteSetup(ctx2, { result: true });
    expect(errCode(() => ctx2.control.fetchArtifactForConsumption(MASTER, s2.cap, { artifact_id: s2.entries[0]!.artifact_id })))
      .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("H5. wrong artifact id with a valid capability → reject", () => {
    const ctx = mkCtx("h5");
    const { cap } = remoteSetup(ctx);
    expect(errCode(() => ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: "ART_notpinned" })))
      .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("H6. wrong claim bindings → reject (mission/task/governed/execution/executor/digest)", () => {
    const ctx = mkCtx("h6");
    const { cons, gc, entries } = remoteSetup(ctx);
    const base = {
      mission_id: ctx.missionId, task_id: cons.tid, governed_task_id: gc.gtId,
      execution_id: gc.eid!, executor_id: gc.executor,
      dependency_set_digest: artifactDependencySetDigest(entries), issued_at: utcnow(),
    };
    for (const mut of [
      { mission_id: "MOTHER" }, { task_id: "TOTHER" }, { governed_task_id: "GOTHER" },
      { execution_id: "EOTHER" }, { executor_id: "EX_OTHER" },
      { dependency_set_digest: "0".repeat(64) },
    ]) {
      const cap = mintArtifactConsumeCapability(MASTER, { ...base, ...mut } as never);
      expect(errCode(() => ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id })))
        .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
    }
  });

  it("H7. dep-set digest binds the pin — post-mint mutation of dependency_artifacts → reject", () => {
    const ctx = mkCtx("h7");
    const { gc, entries, cap } = remoteSetup(ctx);
    ctx.store.put("governed_task", gc.gtId,
      { ...gc.governed, dependency_artifacts: [{ ...entries[0]!, sha256: "1".repeat(64) }] } as never,
      gc.governed.version);
    expect(errCode(() => ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id })))
      .toBe("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED");
  });

  it("H8. fetch lane never exposes host paths — response is bytes + identity only", () => {
    const ctx = mkCtx("h8");
    const { entries, cap } = remoteSetup(ctx);
    const r = ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id });
    const keys = Object.keys(r.artifact);
    expect(keys).not.toContain("workspace");
    expect(JSON.stringify(r.artifact)).not.toContain(ctx.d);
  });
});

/* ==================== I — CROSS-EXECUTOR MATRIX ==================== */
describe("I — cross-executor matrix", () => {
  it("I1. LOCAL → LOCAL materialize", () => {
    const ctx = mkCtx("i1");
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.readFileSync(path.join(ctx.workspace, entries[0]!.consumer_relative_path))).toEqual(prod.bytes);
  });

  it("I2. REMOTE → LOCAL materialize (remote source gone)", () => {
    const ctx = mkCtx("i2");
    const { prod, cons, entries } = depSetup(ctx, { producerRemote: true });
    expect(entries[0]!.producer_executor_id).toBe(EX_REMOTE);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.readFileSync(path.join(ctx.workspace, entries[0]!.consumer_relative_path))).toEqual(prod.bytes);
  });

  it("I3. LOCAL → REMOTE fetch", () => {
    const ctx = mkCtx("i3");
    const { prod, cons, entries } = depSetup(ctx, { remote: true, producerRemote: false });
    const gc = mkGovernedConsumer(ctx, cons, entries, { remote: true, execState: "RUNNING" });
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
    const cap = mintArtifactConsumeCapability(MASTER, {
      mission_id: ctx.missionId, task_id: cons.tid, governed_task_id: gc.gtId,
      execution_id: gc.eid!, executor_id: gc.executor,
      dependency_set_digest: artifactDependencySetDigest(entries), issued_at: utcnow(),
    } as never);
    expect(ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id }).bytes).toEqual(prod.bytes);
  });

  it("I4. REMOTE → REMOTE fetch", () => {
    const ctx = mkCtx("i4");
    const { prod, cons, entries } = depSetup(ctx, { remote: true, producerRemote: true });
    const gc = mkGovernedConsumer(ctx, cons, entries, { remote: true, execState: "RUNNING" });
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "REMOTE_FETCH");
    const cap = mintArtifactConsumeCapability(MASTER, {
      mission_id: ctx.missionId, task_id: cons.tid, governed_task_id: gc.gtId,
      execution_id: gc.eid!, executor_id: gc.executor,
      dependency_set_digest: artifactDependencySetDigest(entries), issued_at: utcnow(),
    } as never);
    expect(ctx.control.fetchArtifactForConsumption(MASTER, cap, { artifact_id: entries[0]!.artifact_id }).bytes).toEqual(prod.bytes);
  });
});

/* ==================== J — HISTORY/CAS TAMPER ==================== */
describe("J — tamper blocks consumption", () => {
  const setupJ = (ctx: ReturnType<typeof mkCtx>) => {
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const art = ctx.service.artifacts.get(entries[0]!.artifact_id)!;
    return { prod, cons, gc, entries, art };
  };

  it("J1. CAS blob deleted → materialization fails closed", () => {
    const ctx = mkCtx("j1");
    const { gc, art } = setupJ(ctx);
    fs.rmSync(path.join(ctx.d, "artifacts", "blobs", String(art.sha256)));
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("J2. CAS blob corrupted → materialization fails closed", () => {
    const ctx = mkCtx("j2");
    const { gc, art } = setupJ(ctx);
    fs.writeFileSync(path.join(ctx.d, "artifacts", "blobs", String(art.sha256)), "corrupt");
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("J3. CAS replaced by symlink to same bytes → materialization fails closed", () => {
    const ctx = mkCtx("j3");
    const { gc, art, prod } = setupJ(ctx);
    const blob = path.join(ctx.d, "artifacts", "blobs", String(art.sha256));
    const evil = path.join(ctx.d, "evil.bin");
    fs.writeFileSync(evil, prod.bytes);
    fs.rmSync(blob);
    fs.symlinkSync(evil, blob);
    expect(errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("J4. ART row sha256 rewritten → re-verification at resolution fails", () => {
    const ctx = mkCtx("j4");
    const { cons, art } = setupJ(ctx);
    const row4 = ctx.store.get("artifact", String(art.artifact_id));
    ctx.store.put("artifact", String(art.artifact_id), { ...row4, sha256: "f".repeat(64) } as never, row4.version);
    expect(errCode(() => resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task })))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("J5. ART storage.ref tampered → resolution fails", () => {
    const ctx = mkCtx("j5");
    const { cons, art } = setupJ(ctx);
    const row5 = ctx.store.get("artifact", String(art.artifact_id));
    ctx.store.put("artifact", String(art.artifact_id),
      { ...row5, storage: { ...(row5.storage as object), ref: "blobs/evil" } } as never, row5.version);
    expect(errCode(() => resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task })))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });

  it("J6. producer identity rewritten → resolution fails", () => {
    const ctx = mkCtx("j6");
    const { cons, art } = setupJ(ctx);
    const row6 = ctx.store.get("artifact", String(art.artifact_id));
    ctx.store.put("artifact", String(art.artifact_id), { ...row6, producer_executor_id: "EVIL" } as never, row6.version);
    expect(errCode(() => resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task })))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
  });
});

/* ==================== K — GOVERNANCE PIN TAMPER ==================== */
describe("K — pin tamper post-governance", () => {
  const setupK = (ctx: ReturnType<typeof mkCtx>) => {
    const { prod, cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    return { prod, gc, entries };
  };

  it("K1. mutating artifact_id/sha256/byte_size/producer_execution_id/consumer_relative_path → NOT dispatch-authorized", () => {
    for (const field of ["artifact_id", "sha256", "byte_size", "producer_execution_id", "consumer_relative_path"] as const) {
      const ctx = mkCtx(`k-${field}`);
      const { gc, entries } = setupK(ctx);
      const mutated = [{
        ...entries[0]!,
        [field]: field === "byte_size" ? entries[0]!.byte_size + 1 : `TAMPERED_${field}`,
      }];
      const row = ctx.store.get("governed_task", gc.gtId);
      ctx.store.put("governed_task", gc.gtId, { ...row, dependency_artifacts: mutated } as never, row.version);
      const spy = { calls: 0 };
      expect(errCode(() => new GovernedTaskGate(ctx.service).dispatch_governed_task(stubAdapter(spy), gc.gtId)))
        .toMatch(/FAIL_CLOSED_(ARTIFACT_HANDOFF|DEPENDENCY_ARTIFACT)/);
      expect(spy.calls).toBe(0);
    }
  });

  it("K2. entry removed after pin → not dispatch-authorized", () => {
    const ctx = mkCtx("k2");
    const { gc } = setupK(ctx);
    const row = ctx.store.get("governed_task", gc.gtId);
    ctx.store.put("governed_task", gc.gtId, { ...row, dependency_artifacts: [] } as never, row.version);
    const spy = { calls: 0 };
    expect(errCode(() => new GovernedTaskGate(ctx.service).dispatch_governed_task(stubAdapter(spy), gc.gtId)))
      .toMatch(/^DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_/);
    expect(spy.calls).toBe(0);
  });

  it("K3. injected contract entries with NO handoff pin → reject", () => {
    const ctx = mkCtx("k3");
    const { cons, entries } = depSetup(ctx);
    const gc = mkGovernedConsumer(ctx, cons, entries); // pin skipped
    const spy = { calls: 0 };
    expect(errCode(() => new GovernedTaskGate(ctx.service).dispatch_governed_task(stubAdapter(spy), gc.gtId)))
      .toMatch(/^DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_/);
    expect(spy.calls).toBe(0);
  });
});

/* ==================== L — LEGACY / ROGUE ==================== */
describe("L — legacy/rogue authority", () => {
  it("L1. injected canonical-looking ART with no acceptance history → not consumable", () => {
    const ctx = mkCtx("l1");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const good = ctx.service.artifacts.get(canonicalArtifactId(prod.eid, "report.txt"))!;
    const rogueId = canonicalArtifactId(prod.eid, "rogue.txt");
    ctx.store.put("artifact", rogueId,
      { ...good, artifact_id: rogueId, logical_name: "rogue.txt" } as never, 0);
    const v = ctx.store.list("execution_validation")[0]!;
    ctx.store.put("execution_validation", String(v.validation_id),
      { ...v, artifact_ids: [...(v.artifact_ids as string[]), rogueId] } as never, v.version);
    const pt = ctx.store.get("task", prod.tid);
    ctx.store.put("task", prod.tid,
      { ...pt, metadata: { pair_dataflow: { produces: ["report.txt", "rogue.txt"], consumes: [] } } } as never, pt.version);
    const cons = mkConsumer(ctx, [prod], { consume: "rogue.txt" });
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });

  it("L2. PASS referencing a foreign execution's ART → not consumable", () => {
    const ctx = mkCtx("l2");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const artId = canonicalArtifactId(prod.eid, "report.txt");
    const v = ctx.store.list("execution_validation")[0]!;
    ctx.store.put("execution_validation", String(v.validation_id),
      { ...v, execution_id: "EXEC_FOREIGN", artifact_ids: [artId] } as never, v.version);
    const cons = mkConsumer(ctx, [prod]);
    expect(resolver(ctx).resolveForConsumer({ mission: freshMission(ctx), task: cons.task }))
      .toEqual([]);
  });
});

/* ==================== M — REMOTE DAG NARROWING ==================== */
describe("M — remote DAG-leaf narrowing", () => {
  const goalTask = { task_key: "T1", title: "goal", task_instruction: "record goal", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [], metadata: {} };
  const remoteProducer = { task_key: "T2", title: "remote produce", task_instruction: "write report.txt containing the findings, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: [], metadata: {} };

  it("M1. remote producer + declared consume edge → plan accepted", () => {
    const plan = reconcilePlanDataflow([
      goalTask,
      remoteProducer,
      { task_key: "T3", title: "consume", task_instruction: "read report.txt and summarize it, then reply DONE.", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"], metadata: {} },
    ]).tasks;
    const t3 = plan.find((t) => t.task_key === "T3")!;
    expect(t3.depends_on).toContain("T2");
    const df = (t3.metadata as Record<string, unknown>).pair_dataflow as { consumes: string[] };
    expect(df.consumes).toContain("report.txt");
  });

  it("M2. remote dep with NO declared consume edge → still FAIL CLOSED", () => {
    expect(errCode(() => reconcilePlanDataflow([
      goalTask,
      remoteProducer,
      { task_key: "T3", title: "consume", task_instruction: "summarize the upstream findings, then reply DONE.", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"], metadata: {} },
    ]))).toBe("FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE");
  });

  it("M3. remote consumer can consume a remote producer via a declared edge", () => {
    const plan = reconcilePlanDataflow([
      goalTask,
      remoteProducer,
      { task_key: "T3", title: "consume", task_instruction: "read report.txt and summarize it, then reply DONE.", required_capabilities: [REMOTE_CAP], depends_on: ["T2"], metadata: {} },
    ]).tasks;
    const df = (plan.find((t) => t.task_key === "T3")!.metadata as Record<string, unknown>).pair_dataflow as { consumes: string[] };
    expect(df.consumes).toContain("report.txt");
  });
});

/* ==================== N — DELIVERY NON-REGRESSION ==================== */
describe("N — delivery non-regression", () => {
  it("N1. TELEGRAM_DELIVERY task is never re-authored through the handoff seam", () => {
    const ctx = mkCtx("n1");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const tid = `ATSK_D_${seq++}`;
    ctx.store.put("task", tid, {
      task_id: tid, task_key: "TD", mission_id: ctx.missionId, plan_id: "PLAN_F2",
      title: "deliver", task_instruction: "deliver", required_capabilities: ["TELEGRAM_DELIVERY"],
      depends_on: [prod.task_key], status: "READY",
      metadata: { pair_dataflow: { produces: [], consumes: ["report.txt"] } }, version: 0,
    }, 0);
    expect(resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx), task: ctx.store.get("task", tid),
    })).toEqual([]);
  });
});
