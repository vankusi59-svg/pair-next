/**
 * F2 R3 — source-review remediation suite (permanent).
 *
 *   A   consumer-isolated dependency destinations — two consumers of the
 *       same artifact in the same workspace get DISTINCT canonical paths
 *       keyed by a deterministic consumer scope derived from canonical
 *       consumer task identity; the pinned consumer_relative_path is the
 *       authority, recomputed and exact-matched at every boundary (R3.1)
 *   B   atomic NO-REPLACE final publication — link() create-if-absent
 *       tied to the SAME proven parent dir object; a raced destination
 *       with identical bytes converges, different bytes fail closed
 *       untouched, symlinks fail closed (R3.2)
 *   C   remote lane — the SAME consumer-isolated path flows into the
 *       fetch recipe, which publishes with ln no-clobber semantics and
 *       converges/fails on an existing target in a real shell (R3 §9-10)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ArtifactDependencyResolver,
  artifactDependencySetDigest,
  ArtifactProvenanceValidator,
  artifactConsumerScope,
  buildDependencyFetchRecipe,
  canonicalHandoffId,
  dependencyConsumerPath,
  DependencyResolutionError,
  DEPENDENCY_ARTIFACT_CONTRACT,
  DEPENDENCY_ARTIFACT_ROOT,
  HANDOFF_ENTITY,
  IntegrityError,
  digest,
  mintArtifactCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  sha256Hex,
  utcnow,
  workerExecutionId,
  type DependencyArtifactEntry,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-f2-r3-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_F2R3";
const EX_REMOTE = "EX_REMOTE_F2R3";
const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const MASTER = "f2r3-consume-master";

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
    goal: "f2r3",
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
  const tid = `ATSK_F2R3_${seq++}`;
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
      plan_id: "PLAN_F2R3",
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
      plan_id: "PLAN_F2R3",
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
    // immutable GOVERNED_TASK_VALIDATED anchor; remote tasks additionally
    // pin the F5 declared-produces contract.
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
    const declaredSet = opts.remote ? [name] : null;
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
        plan_id: "PLAN_F2R3", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: !!opts.remote,
        declared_produces: declaredSet,
        declared_produces_digest: declaredSet
          ? digest(declaredSet)
          : null,
      },
    });
    ctx.store.appendEvidence(ctx.missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: executor,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2R3", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: !!opts.remote,
      declared_produces: declaredSet,
      declared_produces_digest: declaredSet ? digest(declaredSet) : null,
    });
  }
  const bytes =
    opts.artifactBytes === undefined
      ? Buffer.from(`artifact-of-${tid}`)
      : opts.artifactBytes;
  ctx.store.put(
    "executor_execution",
    eid,
    {
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
    },
    0,
  );
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
  opts: { consume?: string[]; remote?: boolean; depends_on?: string[] } = {},
) {
  const tid = `ATSK_CR3_${seq++}`;
  const key = `TC${seq}`;
  const consumes =
    opts.consume ?? producers.map((p) => p.name);
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid,
      task_key: key,
      mission_id: ctx.missionId,
      plan_id: "PLAN_F2R3",
      title: key,
      task_instruction: `read inputs then reply DONE.`,
      required_capabilities: opts.remote ? [REMOTE_CAP] : ["FILE_OPERATIONS"],
      depends_on: opts.depends_on ?? producers.map((p) => p.task_key),
      status: "READY",
      metadata: { pair_dataflow: { produces: [], consumes } },
      version: 0,
    },
    0,
  );
  return { tid, task: ctx.store.get("task", tid), task_key: key, consumes };
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

const resolveConsumer = (
  ctx: ReturnType<typeof mkCtx>,
  cons: ReturnType<typeof mkConsumer>,
) =>
  resolver(ctx).resolveForConsumer({
    mission: freshMission(ctx),
    task: cons.task,
  });

const handoffIdFor = (gtId: string, e: DependencyArtifactEntry) =>
  canonicalHandoffId(gtId, e.artifact_id, e.consumer_relative_path);

/* ============= A — R3.1 consumer-isolated destinations ============= */
describe("R3.1 A — dependency destinations are consumer-isolated", () => {
  /** Two consumers T2,T3 of the SAME canonical artifact in one workspace. */
  const twoConsumers = (ctx: ReturnType<typeof mkCtx>) => {
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const t2 = mkConsumer(ctx, [prod]);
    const t3 = mkConsumer(ctx, [prod]);
    const e2 = resolveConsumer(ctx, t2);
    const e3 = resolveConsumer(ctx, t3);
    const g2 = mkGovernedConsumer(ctx, t2, e2);
    const g3 = mkGovernedConsumer(ctx, t3, e3);
    handoffs(ctx).pinForGovernedTask(g2.governed, e2, "LOCAL_MATERIALIZATION");
    handoffs(ctx).pinForGovernedTask(g3.governed, e3, "LOCAL_MATERIALIZATION");
    return { prod, t2, t3, e2, e3, g2, g3 };
  };
  const abs = (ctx: ReturnType<typeof mkCtx>, rel: string) =>
    path.join(ctx.workspace, rel);

  it("A1. same ART + two consumers → distinct canonical destinations", () => {
    const ctx = mkCtx("a1");
    const { t2, t3, e2, e3 } = twoConsumers(ctx);
    const p2 = e2[0]!.consumer_relative_path;
    const p3 = e3[0]!.consumer_relative_path;
    expect(p2).not.toBe(p3);
    // Both under the canonical root, each inside its OWN consumer scope.
    expect(p2.startsWith(`${DEPENDENCY_ARTIFACT_ROOT}/`)).toBe(true);
    expect(p3.startsWith(`${DEPENDENCY_ARTIFACT_ROOT}/`)).toBe(true);
    expect(p2).toContain(`/${artifactConsumerScope(t2.tid)}/`);
    expect(p3).toContain(`/${artifactConsumerScope(t3.tid)}/`);
    expect(p2).toBe(
      dependencyConsumerPath(t2.tid, e2[0]!.artifact_id, "report.txt"),
    );
    expect(p3).toBe(
      dependencyConsumerPath(t3.tid, e3[0]!.artifact_id, "report.txt"),
    );
  });

  it("A2. T3 materialization never touches T2's (mutated) copy", () => {
    const ctx = mkCtx("a2");
    const { prod, e2, e3, g2, g3 } = twoConsumers(ctx);
    handoffs(ctx).materializeForConsumer(g2.governed);
    handoffs(ctx).materializeForConsumer(g3.governed);
    const dest2 = abs(ctx, e2[0]!.consumer_relative_path);
    const dest3 = abs(ctx, e3[0]!.consumer_relative_path);
    // T2's live input is mutated (e.g. T2's own run rewrote its input).
    fs.writeFileSync(dest2, "t2-local-mutation");
    // T3 re-materializes on ITS OWN isolated path — must converge on the
    // canonical bytes and leave T2's mutation untouched.
    handoffs(ctx).materializeForConsumer(g3.governed);
    expect(fs.readFileSync(dest3)).toEqual(prod.bytes);
    expect(fs.readFileSync(dest2)).toEqual(
      Buffer.from("t2-local-mutation"),
    );
  });

  it("A3. T2 deletes its materialized copy → T3's copy stays intact", () => {
    const ctx = mkCtx("a3");
    const { prod, e2, e3, g2, g3 } = twoConsumers(ctx);
    handoffs(ctx).materializeForConsumer(g2.governed);
    handoffs(ctx).materializeForConsumer(g3.governed);
    fs.rmSync(path.dirname(abs(ctx, e2[0]!.consumer_relative_path)), {
      recursive: true,
      force: true,
    });
    expect(fs.readFileSync(abs(ctx, e3[0]!.consumer_relative_path)))
      .toEqual(prod.bytes);
    void e2;
  });

  it("A4. restart re-derives the SAME destination for T3", () => {
    const ctx = mkCtx("a4");
    const { prod, t3, e3 } = twoConsumers(ctx);
    void prod;
    // Rebuild the control plane on the SAME pair.db — no in-memory state.
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const e3again = new ArtifactDependencyResolver(service2).resolveForConsumer(
      {
        mission: service2.getMission(ctx.missionId),
        task: store2.get("task", t3.tid),
      },
    );
    expect(e3again[0]!.consumer_relative_path).toBe(
      e3[0]!.consumer_relative_path,
    );
    store2.close();
  });

  it("A5. forged consumer_relative_path → every authority boundary rejects", () => {
    const ctx = mkCtx("a5");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod]);
    const entries = resolveConsumer(ctx, cons);
    const forged: DependencyArtifactEntry = {
      ...entries[0]!,
      // a location under the root but NOT this consumer's scope —
      // prefix-contains checks must not let it through
      consumer_relative_path:
        `${DEPENDENCY_ARTIFACT_ROOT}/CT_forgeriescope/` +
        `${entries[0]!.artifact_id}/report.txt`,
    };
    const gc = mkGovernedConsumer(ctx, cons, [forged]);
    // pin recomputes the expected destination from consumer identity —
    // the forged path can never satisfy exact-equality.
    expect(
      errCode(() =>
        handoffs(ctx).pinForGovernedTask(
          gc.governed,
          [forged],
          "LOCAL_MATERIALIZATION",
        ),
      ),
    ).toBe("FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT");
    // materialize must recompute too — the forged pinned entry is
    // rejected by exact-equality BEFORE any handoff lookup or write
    expect(
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
    ).toBe("FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT");
    // and ANOTHER consumer's legitimate path is equally foreign here —
    // scope is bound to THIS consumer's canonical task identity
    const other = mkConsumer(ctx, [prod]);
    const eOther = resolveConsumer(ctx, other);
    const forged2 = {
      ...entries[0]!,
      consumer_relative_path: eOther[0]!.consumer_relative_path,
    };
    expect(
      errCode(() =>
        handoffs(ctx).pinForGovernedTask(
          gc.governed,
          [forged2],
          "LOCAL_MATERIALIZATION",
        ),
      ),
    ).toBe("FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT");
  });

  it("A6. retry/re-governance of the SAME task converges deterministically", () => {
    const ctx = mkCtx("a6");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod]);
    const e1 = resolveConsumer(ctx, cons);
    const e2 = resolveConsumer(ctx, cons); // re-resolution (retry)
    expect(e2[0]!.consumer_relative_path).toBe(
      e1[0]!.consumer_relative_path,
    );
    // scope is pure canonical task identity — bounded, fs-safe, deterministic
    expect(artifactConsumerScope(cons.tid)).toMatch(/^CT_[0-9a-f]{24}$/);
    const gc = mkGovernedConsumer(ctx, cons, e1);
    handoffs(ctx).pinForGovernedTask(gc.governed, e1, "LOCAL_MATERIALIZATION");
    handoffs(ctx).materializeForConsumer(gc.governed);
    const dest = abs(ctx, e1[0]!.consumer_relative_path);
    const ino1 = fs.statSync(dest).ino;
    // retry materializes again — idempotent converge, no rewrite
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.statSync(dest).ino).toBe(ino1);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
  });
});

/* ======== B — R3.2 atomic no-replace publication ======== */
describe("R3.2 B — atomic no-replace publication", () => {
  // the REAL linkSync — captured before any spy replaces fs.linkSync
  const realLinkSync = fs.linkSync.bind(fs);
  const setup = (name: string) => {
    const ctx = mkCtx(name);
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod]);
    const entries = resolveConsumer(ctx, cons);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(
      gc.governed,
      entries,
      "LOCAL_MATERIALIZATION",
    );
    const dest = path.join(
      ctx.workspace,
      entries[0]!.consumer_relative_path,
    );
    return { ctx, prod, entries, gc, dest };
  };

  it("B1. different bytes injected INSIDE the publish seam → FAIL, injected untouched", () => {
    const { ctx, gc, dest } = setup("b1");
    const spy = vi
      .spyOn(fs, "linkSync")
      .mockImplementation(((src: string, dst: string) => {
        // a racing object lands in the window between lstat and publish
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, "raced-in-bytes");
        return realLinkSync(src, dst);
      }) as never);
    try {
      expect(
        errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
      ).toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(dest)).toEqual(Buffer.from("raced-in-bytes"));
  });

  it("B2. exact pinned bytes injected inside the seam → converge, no rewrite", () => {
    const { ctx, prod, gc, dest } = setup("b2");
    let injectedIno = 0;
    const spy = vi
      .spyOn(fs, "linkSync")
      .mockImplementation(((src: string, dst: string) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, prod.bytes);
        injectedIno = fs.statSync(dst).ino;
        return realLinkSync(src, dst);
      }) as never);
    try {
      const written = handoffs(ctx).materializeForConsumer(gc.governed);
      expect(written).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    // converged onto the EXISTING object — never overwritten
    expect(fs.statSync(dest).ino).toBe(injectedIno);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    const hId = handoffIdFor(String(gc.governed.governed_task_id), gc.governed
      .dependency_artifacts![0] as DependencyArtifactEntry);
    expect(String(ctx.store.get(HANDOFF_ENTITY, hId).state)).toBe("MATERIALIZED");
  });

  it("B3. symlink injected at destination → FAIL, symlink + outside target untouched", () => {
    const { ctx, gc, dest } = setup("b3");
    const outside = path.join(ctx.d, "victim.txt");
    fs.writeFileSync(outside, "outside-bytes");
    const spy = vi
      .spyOn(fs, "linkSync")
      .mockImplementation(((src: string, dst: string) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(outside, dst);
        return realLinkSync(src, dst);
      }) as never);
    try {
      expect(
        errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
      ).toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    } finally {
      spy.mockRestore();
    }
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside)).toEqual(Buffer.from("outside-bytes"));
  });

  it("B4. racing materializer that publishes first → second converges", () => {
    const { ctx, prod, gc, dest } = setup("b4");
    let peerIno = 0;
    // simulate the PEER materializer winning the publish race: it lands
    // the exact canonical bytes before our linkSync executes
    const spy = vi
      .spyOn(fs, "linkSync")
      .mockImplementation(((src: string, dst: string) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, prod.bytes);
        peerIno = fs.statSync(dst).ino;
        return realLinkSync(src, dst);
      }) as never);
    try {
      handoffs(ctx).materializeForConsumer(gc.governed);
    } finally {
      spy.mockRestore();
    }
    // the peer's object survived — converge, never replaced
    expect(fs.statSync(dest).ino).toBe(peerIno);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    // and OUR retry converges too — idempotent
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.statSync(dest).ino).toBe(peerIno);
  });

  it("B5. two different consumers of the same ART → distinct destinations, both publish", () => {
    const ctx = mkCtx("b5");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const t2 = mkConsumer(ctx, [prod]);
    const t3 = mkConsumer(ctx, [prod]);
    const e2 = resolveConsumer(ctx, t2);
    const e3 = resolveConsumer(ctx, t3);
    const g2 = mkGovernedConsumer(ctx, t2, e2);
    const g3 = mkGovernedConsumer(ctx, t3, e3);
    handoffs(ctx).pinForGovernedTask(g2.governed, e2, "LOCAL_MATERIALIZATION");
    handoffs(ctx).pinForGovernedTask(g3.governed, e3, "LOCAL_MATERIALIZATION");
    handoffs(ctx).materializeForConsumer(g2.governed);
    handoffs(ctx).materializeForConsumer(g3.governed);
    const d2 = path.join(ctx.workspace, e2[0]!.consumer_relative_path);
    const d3 = path.join(ctx.workspace, e3[0]!.consumer_relative_path);
    expect(d2).not.toBe(d3);
    expect(fs.readFileSync(d2)).toEqual(prod.bytes);
    expect(fs.readFileSync(d3)).toEqual(prod.bytes);
  });

  it("B6. crash after publish before MATERIALIZED → restart converges + repairs state, no rewrite", () => {
    const { ctx, prod, gc, dest } = setup("b6");
    handoffs(ctx).materializeForConsumer(gc.governed);
    const ino = fs.statSync(dest).ino;
    // simulate the crash window: object published, state row still PINNED
    const hId = handoffIdFor(
      String(gc.governed.governed_task_id),
      gc.governed.dependency_artifacts![0] as DependencyArtifactEntry,
    );
    const row = ctx.store.get(HANDOFF_ENTITY, hId);
    ctx.store.put(
      HANDOFF_ENTITY,
      hId,
      { ...row, state: "PINNED" },
      Number(row.version),
    );
    // retry after restart: exact bytes already there → converge + repair
    handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.statSync(dest).ino).toBe(ino); // never rewritten
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    expect(String(ctx.store.get(HANDOFF_ENTITY, hId).state)).toBe("MATERIALIZED");
  });
});

/* ============= C — remote lane: isolated path + ln no-clobber ============= */
describe("R3 C — remote recipe: consumer-isolated path + no-clobber publish", () => {
  const stubEnv = (dirp: string, mode: "ok" | "bad_bytes") => {
    const bin = path.join(dirp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const bytes =
      mode === "bad_bytes" ? "WRONG-BYTES" : "canonical-dependency-bytes";
    fs.writeFileSync(
      path.join(bin, "curl"),
      `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
printf %s "${bytes}" > "$out"
exit 0
`,
    );
    fs.chmodSync(path.join(bin, "curl"), 0o755);
    return bin;
  };

  const entry = (
    consumerTaskId: string,
    name: string,
  ): DependencyArtifactEntry => ({
    artifact_id: "ART_R3C",
    producer_task_id: "tp",
    producer_governed_task_id: "gtp",
    producer_execution_id: "exe_p",
    producer_executor_id: "EX",
    logical_name: name,
    sha256: sha256Hex(Buffer.from("canonical-dependency-bytes")),
    byte_size: Buffer.byteLength("canonical-dependency-bytes"),
    consumer_relative_path: dependencyConsumerPath(
      consumerTaskId,
      "ART_R3C",
      name,
    ),
    contract: DEPENDENCY_ARTIFACT_CONTRACT,
  });

  const runRecipe = (
    dirp: string,
    recipe: string,
    mode: "ok" | "bad_bytes" = "ok",
  ) => {
    const bin = stubEnv(dirp, mode);
    fs.writeFileSync(path.join(dirp, "fetch.sh"), recipe);
    try {
      execFileSync("bash", [path.join(dirp, "fetch.sh")], {
        cwd: dirp,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PAIR_FETCH_BACKOFF: "0",
        },
        stdio: "pipe",
        timeout: 60_000,
      });
      return { code: 0, out: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer };
      return {
        code: err.status ?? -1,
        out: String(err.stdout ?? ""),
      };
    }
  };

  const recipeFor = (e: DependencyArtifactEntry) =>
    buildDependencyFetchRecipe(e, {
      fetchBase: "http://pair.test",
      consumeCapability: "acread1.testcap.sig",
    });

  it("C1. fresh fetch → consumer-isolated path created + exact bytes", () => {
    const d = dir("c1");
    const e = entry("ATSK_REMOTE_C1", "report.txt");
    const r = runRecipe(d, recipeFor(e));
    expect(r.code).toBe(0);
    const target = path.join(d, e.consumer_relative_path);
    expect(e.consumer_relative_path).toContain(
      `/${artifactConsumerScope("ATSK_REMOTE_C1")}/`,
    );
    expect(fs.readFileSync(target)).toEqual(
      Buffer.from("canonical-dependency-bytes"),
    );
  });

  it("C2. existing exact target → converge, no download needed, object untouched", () => {
    const d = dir("c2");
    const e = entry("ATSK_REMOTE_C2", "report.txt");
    const target = path.join(d, e.consumer_relative_path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "canonical-dependency-bytes");
    const ino = fs.statSync(target).ino;
    const r = runRecipe(d, recipeFor(e));
    expect(r.code).toBe(0);
    expect(fs.statSync(target).ino).toBe(ino); // never replaced
  });

  it("C3. existing DIFFERENT bytes → FAIL, existing object untouched", () => {
    const d = dir("c3");
    const e = entry("ATSK_REMOTE_C3", "report.txt");
    const target = path.join(d, e.consumer_relative_path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "someone-elses-bytes");
    const r = runRecipe(d, recipeFor(e));
    expect(r.code).toBe(3);
    expect(r.out).toContain("DEPENDENCY_FETCH_FAILED");
    expect(fs.readFileSync(target)).toEqual(
      Buffer.from("someone-elses-bytes"),
    );
  });

  it("C4. symlink at target → FAIL, symlink + outside target untouched", () => {
    const d = dir("c4");
    const e = entry("ATSK_REMOTE_C4", "report.txt");
    const outside = path.join(d, "victim.txt");
    fs.writeFileSync(outside, "outside-bytes");
    const target = path.join(d, e.consumer_relative_path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    const r = runRecipe(d, recipeFor(e));
    expect(r.code).toBe(3);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside)).toEqual(Buffer.from("outside-bytes"));
  });

  it("C5. download lands bad bytes → quarantine + FAIL, never published", () => {
    const d = dir("c5");
    const e = entry("ATSK_REMOTE_C5", "report.txt");
    const r = runRecipe(d, recipeFor(e), "bad_bytes");
    expect(r.code).toBe(3);
    expect(r.out).toContain("DEPENDENCY_FETCH_FAILED");
    expect(fs.existsSync(path.join(d, e.consumer_relative_path))).toBe(false);
    // bad bytes quarantined — never silently consumed
    const q = `${path.join(d, e.consumer_relative_path)}.quarantine`;
    expect(fs.readFileSync(q)).toEqual(Buffer.from("WRONG-BYTES"));
  });

  it("C6. distinct consumers in the SAME remote workspace → isolated targets", () => {
    const d = dir("c6");
    const ea = entry("ATSK_RA", "report.txt");
    const eb = entry("ATSK_RB", "report.txt");
    expect(ea.consumer_relative_path).not.toBe(eb.consumer_relative_path);
    expect(runRecipe(d, recipeFor(ea)).code).toBe(0);
    expect(runRecipe(d, recipeFor(eb)).code).toBe(0);
    expect(
      fs.readFileSync(path.join(d, ea.consumer_relative_path)),
    ).toEqual(Buffer.from("canonical-dependency-bytes"));
    expect(
      fs.readFileSync(path.join(d, eb.consumer_relative_path)),
    ).toEqual(Buffer.from("canonical-dependency-bytes"));
  });
});
