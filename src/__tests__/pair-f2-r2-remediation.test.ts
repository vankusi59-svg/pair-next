/**
 * F2 R2 — source-review remediation suite (permanent).
 *
 *   A   remote consumer never falls back to local path semantics —
 *       missing canonical artifact + remote consumer → fail closed;
 *       only local→local keeps legacy (R2.1)
 *   B   PASS validation row must bind durable scope exactly —
 *       mission_id / governed_task_id / non-empty validation_id /
 *       artifact_ids array / governed linkage all still agree (R2.2)
 *   C   fd-bound materialization — the directory OBJECT proven inside
 *       the workspace creates/writes/renames the file; swaps at any
 *       window leave zero bytes outside (R2.3)
 *   D   server uses the injected canonical consume master — ambient env
 *       is never inspected inside request handling (R2.4)
 *   E   remote fetch recipe is shell-safe AND actually exits non-zero —
 *       executed in a real shell with a stubbed curl (R2.5)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactDependencyResolver,
  artifactDependencySetDigest,
  ArtifactProvenanceValidator,
  buildDependencyFetchRecipe,
  createMissionControlServer,
  DependencyResolutionError,
  DEPENDENCY_ARTIFACT_CONTRACT,
  IntegrityError,
  mintArtifactCapability,
  mintArtifactConsumeCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  sha256Hex,
  utcnow,
  workerExecutionId,
  type DependencyArtifactEntry,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f2-r2-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_F2R2";
const EX_REMOTE = "EX_REMOTE_F2R2";
const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const MASTER = "f2r2-consume-master";

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
    goal: "f2r2",
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
  const tid = `ATSK_F2R2_${seq++}`;
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
      plan_id: "PLAN_F2R2",
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
  const tid = `ATSK_CR2_${seq++}`;
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
      plan_id: "PLAN_F2R2",
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

/** Resolve names for a remote consumer — throws DEP:* on any failure. */
const resolveRemote = (
  ctx: ReturnType<typeof mkCtx>,
  cons: ReturnType<typeof mkConsumer>,
) =>
  resolver(ctx).resolveForConsumer({
    mission: freshMission(ctx),
    task: cons.task,
  });

/* ==================== A — R2.1 remote-consumer no local fallback ==================== */
describe("R2.1 A — remote consumer never falls back to local-path semantics", () => {
  it("A1. LOCAL producer canonical PASS ART → REMOTE consumer resolves", () => {
    const ctx = mkCtx("a1");
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    const entries = resolveRemote(ctx, cons);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.producer_execution_id).toBe(prod.eid);
    expect(entries[0]!.sha256).toBe(sha256Hex(prod.bytes));
  });

  it("A2. LOCAL producer artifacts:[] (PASS, no ART) → REMOTE consumer → DEPENDENCY_FAILURE", () => {
    const ctx = mkCtx("a2");
    const prod = mkProducer(ctx, {
      produces: "report.txt",
      artifactBytes: null, // result artifacts:[] — no canonical authority
    });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
    // Zero dispatch side-effect: no governed/exec row for the consumer.
    expect(
      ctx.store
        .list("governed_task")
        .filter((g) => String(g.task_id) === cons.tid),
    ).toHaveLength(0);
  });

  it("A3. LOCAL producer ART exists but validation absent → remote consumer fails", () => {
    const ctx = mkCtx("a3");
    const prod = mkProducer(ctx, { produces: "report.txt", validate: false });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("A4. LOCAL producer validation FAIL → remote consumer fails", () => {
    const ctx = mkCtx("a4");
    const prod = mkProducer(ctx, { produces: "report.txt", pass: false });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("A5. LOCAL producer no ART + LOCAL consumer → legacy path semantics preserved", () => {
    const ctx = mkCtx("a5");
    const prod = mkProducer(ctx, {
      produces: "report.txt",
      artifactBytes: null,
    });
    const cons = mkConsumer(ctx, [prod]); // local
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    expect(entries).toEqual([]); // legacy path dep, not a canonical pin
  });

  it("A6. mixed consumes (one canonical + one local-only) → remote consumer fails the WHOLE resolution", () => {
    const ctx = mkCtx("a6");
    const p1 = mkProducer(ctx, { produces: "a.txt", taskKey: "P1" });
    const p2 = mkProducer(ctx, {
      produces: "b.txt",
      taskKey: "P2",
      artifactBytes: null, // PASS but no canonical ART
    });
    const cons = mkConsumer(ctx, [p1, p2], {
      remote: true,
      consume: ["a.txt", "b.txt"],
      depends_on: [p1.task_key, p2.task_key],
    });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });
});

/* ==================== B — R2.2 PASS row durable scope ==================== */
describe("R2.2 B — PASS validation row must bind durable scope exactly", () => {
  const setup = (name: string) => {
    const ctx = mkCtx(name);
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    const vrow = ctx.store
      .list("execution_validation")
      .find((v) => String(v.execution_id) === prod.eid)!;
    return { ctx, prod, cons, vrow };
  };
  const mutate = (
    ctx: ReturnType<typeof mkCtx>,
    vrow: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) =>
    ctx.store.put(
      "execution_validation",
      String(vrow.validation_id),
      { ...vrow, ...patch },
      Number(vrow.version),
    );

  it("B1. canonical PASS unchanged → consumable", () => {
    const { ctx, cons } = setup("b1");
    expect(resolveRemote(ctx, cons)).toHaveLength(1);
  });

  it("B2. mutate validation.mission_id only → reject", () => {
    const { ctx, cons, vrow } = setup("b2");
    mutate(ctx, vrow, { mission_id: "MISSION_FOREIGN" });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B3. mutate validation.governed_task_id only → reject", () => {
    const { ctx, cons, vrow } = setup("b3");
    mutate(ctx, vrow, { governed_task_id: "GT_FOREIGN" });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B4. empty/missing validation_id → reject", () => {
    const { ctx, cons, vrow } = setup("b4");
    mutate(ctx, vrow, { validation_id: "" });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B5. artifact_ids non-array → reject", () => {
    const { ctx, cons, vrow } = setup("b5");
    mutate(ctx, vrow, { artifact_ids: "ART_x" });
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B6. RESULT_VALIDATED with wrong validation_id → reject", () => {
    const { ctx, prod, cons } = setup("b6");
    // Anchor a DIFFERENT validation row id — the real one loses its anchor.
    const foreign = ctx.store.put(
      "execution_validation",
      `XVLD_foreign_${prod.eid}`,
      {
        validation_id: `XVLD_foreign_${prod.eid}`,
        execution_id: prod.eid,
        governed_task_id: prod.gtId,
        mission_id: ctx.missionId,
        status: "PASS",
        failures: [],
        artifact_count: 0,
        artifact_ids: [],
        created_at: utcnow(),
        version: 0,
      },
      0,
    );
    ctx.store.event({
      entity_type: "executor_execution",
      entity_id: prod.eid,
      event_type: "RESULT_VALIDATED",
      new_state: "PASS",
      actor: "X",
      correlation_id: `COR_${prod.tid}`,
      metadata: { validation_id: String(foreign.validation_id) },
    });
    // Original event still anchors the real row → contradictory PASSes.
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B7. RESULT_VALIDATED under wrong correlation → reject", () => {
    const { ctx, prod, cons } = setup("b7");
    // Rewrite the execution correlation — the recorded event no longer
    // matches the CURRENT durable execution's correlation.
    const exec = ctx.store.get("executor_execution", prod.eid);
    ctx.store.put(
      "executor_execution",
      prod.eid,
      { ...exec, correlation_id: "COR_REWRITTEN" },
      exec.version,
    );
    expect(errCode(() => resolveRemote(ctx, cons))).toBe(
      "DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION",
    );
  });

  it("B8. restart intact → PASS still consumable", () => {
    const { ctx, cons } = setup("b8");
    ctx.store.close();
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const ctx2 = {
      ...ctx,
      store: store2,
      service: new PairControlPlane(store2),
    };
    const mission = ctx2.service.getMission(ctx.missionId);
    const task = ctx2.store.get("task", cons.tid);
    const entries = new ArtifactDependencyResolver(ctx2.service)
      .resolveForConsumer({ mission, task });
    expect(entries).toHaveLength(1);
  });
});

/* ==================== C — R2.3 fd-bound materialization ==================== */
describe("R2.3 C — fd-bound materialization (no check→open race)", () => {
  const setup = (name: string) => {
    const ctx = mkCtx(name);
    const prod = mkProducer(ctx, { produces: "report.txt" });
    const cons = mkConsumer(ctx, [prod]);
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const outside = path.join(ctx.d, "outside");
    fs.mkdirSync(outside);
    return { ctx, prod, entries, gc, outside };
  };
  const destRel = (entries: DependencyArtifactEntry[]) =>
    entries[0]!.consumer_relative_path;

  it("C1. static .pair symlink → fail, zero bytes outside", () => {
    const { ctx, entries, gc, outside } = setup("c1");
    fs.mkdirSync(path.join(ctx.workspace, ".pair"));
    fs.renameSync(
      path.join(ctx.workspace, ".pair"),
      path.join(ctx.workspace, ".pair.orig"),
    );
    fs.symlinkSync(outside, path.join(ctx.workspace, ".pair"));
    expect(
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
    ).toMatch(/HANDOFF_MATERIALIZE|parent/);
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("C2. static dependency-artifacts symlink → fail", () => {
    const { ctx, entries, gc, outside } = setup("c2");
    const pair = path.join(ctx.workspace, ".pair");
    fs.mkdirSync(pair);
    fs.symlinkSync(outside, path.join(pair, "dependency-artifacts"));
    expect(
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
    ).toContain("FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("C3. static ART parent symlink → fail", () => {
    const { ctx, entries, gc, outside } = setup("c3");
    const artDir = path.dirname(
      path.join(ctx.workspace, destRel(entries)),
    );
    fs.mkdirSync(path.dirname(artDir), { recursive: true });
    fs.symlinkSync(outside, artDir);
    expect(
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
    ).toContain("FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("C4. swap ART parent AFTER containment check but BEFORE temp open → zero bytes outside", () => {
    const { ctx, entries, gc, outside } = setup("c4");
    const artDir = path.dirname(path.join(ctx.workspace, destRel(entries)));
    fs.mkdirSync(artDir, { recursive: true });
    // Swap in the exact post-check/pre-open window: intercept the open of
    // the ART dir component (the last ancestor open) and swap it to a
    // symlink → the OPENED object is what is proven, so the swap either
    // fails closed (ELOOP) or lands inside the proven object — never
    // outside.
    const orig = fs.openSync;
    const spy = vi
      .spyOn(fs, "openSync")
      .mockImplementation((p: fs.PathLike, flags?: fs.OpenMode | string | null, mode?: fs.Mode | null) => {
        const ps = String(p);
        if (/^\/proc\/self\/fd\/\d+\/ART_/.test(ps)) {
          fs.renameSync(artDir, artDir + ".orig");
          fs.symlinkSync(outside, artDir);
        }
        return (orig as typeof fs.openSync)(p, flags as never, mode as never);
      });
    try {
      const code = errCode(() =>
        handoffs(ctx).materializeForConsumer(gc.governed),
      );
      // Either fail closed at the opened-object proof, or materialize
      // inside the PROVEN dir — under no outcome does a byte land outside.
      expect(fs.readdirSync(outside)).toHaveLength(0);
      if (code === "NO_THROW") {
        // The proven dir object was the REAL pre-swap dir — bytes must
        // be inside the workspace real path, not the symlink target.
        const realDest = path.join(
          fs.realpathSync(artDir + ".orig"),
          path.basename(destRel(entries)),
        );
        expect(fs.existsSync(realDest)).toBe(true);
      } else {
        expect(code).toContain("FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("C5. swap dependency-artifacts root in the same window → zero bytes outside", () => {
    const { ctx, entries, gc, outside } = setup("c5");
    const depRoot = path.join(ctx.workspace, ".pair", "dependency-artifacts");
    fs.mkdirSync(depRoot, { recursive: true });
    const orig = fs.openSync;
    const spy = vi
      .spyOn(fs, "openSync")
      .mockImplementation((p: fs.PathLike, flags?: fs.OpenMode | string | null, mode?: fs.Mode | null) => {
        const ps = String(p);
        if (/^\/proc\/self\/fd\/\d+\/dependency-artifacts$/.test(ps)) {
          fs.renameSync(depRoot, depRoot + ".orig");
          fs.symlinkSync(outside, depRoot);
        }
        return (orig as typeof fs.openSync)(p, flags as never, mode as never);
      });
    try {
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed));
      expect(fs.readdirSync(outside)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("C6. destination existing through swapped root with identical bytes → must NOT falsely converge", () => {
    const { ctx, prod, entries, gc, outside } = setup("c6");
    // Place the identical bytes OUTSIDE under a fake root, then swap the
    // dependency-artifacts component to that root — converge must never
    // be satisfied by an outside object.
    const fakeArt = path.join(outside, entries[0]!.artifact_id);
    fs.mkdirSync(fakeArt, { recursive: true });
    fs.writeFileSync(
      path.join(fakeArt, path.basename(destRel(entries))),
      prod.bytes,
    );
    const depRoot = path.join(ctx.workspace, ".pair", "dependency-artifacts");
    fs.mkdirSync(path.dirname(depRoot), { recursive: true });
    fs.symlinkSync(outside, depRoot);
    expect(
      errCode(() => handoffs(ctx).materializeForConsumer(gc.governed)),
    ).toContain("FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    // No false converge: handoff never transitions to MATERIALIZED.
    const h = ctx.store.get(
      "artifact_handoff",
      (gc.governed as never as { governed_task_id: string }).governed_task_id
        ? String(
            ctx.store
              .list("artifact_handoff")
              .find((x) =>
                String(x.consumer_governed_task_id) ===
                String(gc.governed.governed_task_id),
              )!.handoff_id,
          )
        : "",
    );
    expect(String(h.state)).toBe("PINNED");
  });

  it("C7. normal materialization → pass", () => {
    const { ctx, prod, entries, gc } = setup("c7");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(written).toEqual([destRel(entries)]);
    expect(
      fs.readFileSync(path.join(ctx.workspace, written[0]!)),
    ).toEqual(prod.bytes);
  });

  it("C8. identical normal object → idempotent converge", () => {
    const { ctx, prod, entries, gc } = setup("c8");
    handoffs(ctx).materializeForConsumer(gc.governed);
    const dest = path.join(ctx.workspace, destRel(entries));
    const before = fs.statSync(dest).mtimeMs;
    const again = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(again).toEqual([destRel(entries)]);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    expect(fs.statSync(dest).mtimeMs).toBe(before); // converge: no rewrite
  });
});

/* ==================== D — R2.4 injected consume master ==================== */
describe("R2.4 D — server uses injected canonical consume master", () => {
  const remoteSetup = (ctx: ReturnType<typeof mkCtx>) => {
    const prod = mkProducer(ctx, {
      produces: "report.txt",
      remote: true,
    });
    const cons = mkConsumer(ctx, [prod], { remote: true });
    const entries = resolver(ctx).resolveForConsumer({
      mission: freshMission(ctx),
      task: cons.task,
    });
    const gc = mkGovernedConsumer(ctx, cons, entries, {
      remote: true,
      execState: "RUNNING",
    });
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

  const post = (port: number, cap: string, artifactId: string) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
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

  const withServer = async (
    deps: Record<string, unknown>,
    env: Record<string, string | undefined>,
    fn: (port: number) => Promise<void>,
  ) => {
    const keys = [
      "PAIR_ARTIFACT_UPLOAD_TOKEN",
      "PAIR_BROKER_TOKEN",
      "PAIR_OUTBOX_TOKEN",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const server: Server = createMissionControlServer(deps as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn((server.address() as { port: number }).port);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  };

  it("D1. injected consume master A with ALL env unset → fetch works", async () => {
    const ctx = mkCtx("d1");
    const s = remoteSetup(ctx);
    await withServer(
      { control: ctx.control, artifactConsumeToken: MASTER },
      {
        PAIR_ARTIFACT_UPLOAD_TOKEN: undefined,
        PAIR_BROKER_TOKEN: undefined,
        PAIR_OUTBOX_TOKEN: undefined,
      },
      async (port) => {
        const r = await post(port, s.cap, s.entries[0]!.artifact_id);
        expect(r.status).toBe(200);
        expect(r.body).toEqual(s.prod.bytes);
      },
    );
  });

  it("D2. injected A while ambient env says B → A remains authority", async () => {
    const ctx = mkCtx("d2");
    const s = remoteSetup(ctx);
    const capB = mintArtifactConsumeCapability("AMBIENT_B", {
      mission_id: ctx.missionId,
      task_id: s.cons.tid,
      governed_task_id: s.gc.gtId,
      execution_id: s.gc.eid!,
      executor_id: s.gc.executor,
      dependency_set_digest: artifactDependencySetDigest(s.entries),
      issued_at: utcnow(),
    } as never);
    await withServer(
      { control: ctx.control, artifactConsumeToken: MASTER },
      { PAIR_ARTIFACT_UPLOAD_TOKEN: "AMBIENT_B" },
      async (port) => {
        expect(
          (await post(port, s.cap, s.entries[0]!.artifact_id)).status,
        ).toBe(200);
        expect(
          (await post(port, capB, s.entries[0]!.artifact_id)).status,
        ).toBe(403);
      },
    );
  });

  it("D3. broker fallback resolved at bootstrap (injected chain result) → works", async () => {
    const ctx = mkCtx("d3");
    const s = remoteSetup(ctx);
    const capB = mintArtifactConsumeCapability("BROKER_B", {
      mission_id: ctx.missionId,
      task_id: s.cons.tid,
      governed_task_id: s.gc.gtId,
      execution_id: s.gc.eid!,
      executor_id: s.gc.executor,
      dependency_set_digest: artifactDependencySetDigest(s.entries),
      issued_at: utcnow(),
    } as never);
    // Bootstrap resolved PAIR_ARTIFACT_UPLOAD_TOKEN||PAIR_BROKER_TOKEN →
    // BROKER_B into the upload slot; consume falls back to it.
    await withServer(
      {
        control: ctx.control,
        artifactUploadToken: "BROKER_B",
      },
      {
        PAIR_ARTIFACT_UPLOAD_TOKEN: undefined,
        PAIR_BROKER_TOKEN: undefined,
      },
      async (port) => {
        const r = await post(port, capB, s.entries[0]!.artifact_id);
        expect(r.status).toBe(200);
        expect(r.body).toEqual(s.prod.bytes);
      },
    );
  });

  it("D4. no injected consume master → lane disabled EVEN with ambient env", async () => {
    const ctx = mkCtx("d4");
    const s = remoteSetup(ctx);
    const capA = mintArtifactConsumeCapability("AMBIENT_A", {
      mission_id: ctx.missionId,
      task_id: s.cons.tid,
      governed_task_id: s.gc.gtId,
      execution_id: s.gc.eid!,
      executor_id: s.gc.executor,
      dependency_set_digest: artifactDependencySetDigest(s.entries),
      issued_at: utcnow(),
    } as never);
    await withServer(
      { control: ctx.control },
      { PAIR_ARTIFACT_UPLOAD_TOKEN: "AMBIENT_A" },
      async (port) => {
        expect(
          (await post(port, capA, s.entries[0]!.artifact_id)).status,
        ).toBe(403);
      },
    );
  });

  it("D5. outbox token is never consume authority", async () => {
    const ctx = mkCtx("d5");
    const s = remoteSetup(ctx);
    const capOut = mintArtifactConsumeCapability("OUTBOX_X", {
      mission_id: ctx.missionId,
      task_id: s.cons.tid,
      governed_task_id: s.gc.gtId,
      execution_id: s.gc.eid!,
      executor_id: s.gc.executor,
      dependency_set_digest: artifactDependencySetDigest(s.entries),
      issued_at: utcnow(),
    } as never);
    await withServer(
      { control: ctx.control, outboxToken: "OUTBOX_X" },
      { PAIR_OUTBOX_TOKEN: "OUTBOX_X" },
      async (port) => {
        expect(
          (await post(port, capOut, s.entries[0]!.artifact_id)).status,
        ).toBe(403);
      },
    );
  });
});

/* ==================== E — R2.5 shell-safe recipe + real failure ==================== */
describe("R2.5 E — fetch recipe executes in a real shell", () => {
  /** A stub curl on PATH: mode controls what -o receives. */
  const stubEnv = (dirp: string, mode: "ok" | "http_fail" | "bad_bytes") => {
    const bin = path.join(dirp, "bin");
    fs.mkdirSync(bin);
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
case "${mode}" in
  http_fail) exit 22 ;;
  *) printf %s "${bytes}" > "$out" ;;
esac
exit 0
`,
    );
    fs.chmodSync(path.join(bin, "curl"), 0o755);
    return bin;
  };

  const entry = (name: string): DependencyArtifactEntry => ({
    artifact_id: "ART_R2E",
    producer_task_id: "tp",
    producer_governed_task_id: "gtp",
    producer_execution_id: "exe_p",
    producer_executor_id: "EX",
    logical_name: name,
    sha256: sha256Hex(Buffer.from("canonical-dependency-bytes")),
    byte_size: Buffer.byteLength("canonical-dependency-bytes"),
    consumer_relative_path: `.pair/dependency-artifacts/ART_R2E/${name}`,
    contract: DEPENDENCY_ARTIFACT_CONTRACT,
  });

  const runRecipe = (
    dirp: string,
    recipe: string,
    mode: "ok" | "http_fail" | "bad_bytes",
  ) => {
    const bin = stubEnv(dirp, mode);
    fs.writeFileSync(path.join(dirp, "fetch.sh"), recipe);
    try {
      execFileSync(
        "bash",
        [path.join(dirp, "fetch.sh")],
        {
          cwd: dirp,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            PAIR_FETCH_BACKOFF: "0",
          },
          stdio: "pipe",
          timeout: 60_000,
        },
      );
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

  it("E1. filename with spaces → exact target written", () => {
    const d = dir("e1");
    const e = entry("report final.txt");
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(r.code).toBe(0);
    const target = path.join(d, e.consumer_relative_path);
    expect(fs.readFileSync(target)).toEqual(
      Buffer.from("canonical-dependency-bytes"),
    );
  });

  it("E2. unicode filename → exact target written", () => {
    const d = dir("e2");
    const e = entry("báo cáo kỳ.txt");
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(r.code).toBe(0);
    expect(
      fs.readFileSync(path.join(d, e.consumer_relative_path)),
    ).toEqual(Buffer.from("canonical-dependency-bytes"));
  });

  it("E3. apostrophe in filename → syntactically safe + exact target", () => {
    const d = dir("e3");
    const e = entry("it's fine.txt");
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(r.code).toBe(0);
    expect(
      fs.readFileSync(path.join(d, e.consumer_relative_path)),
    ).toEqual(Buffer.from("canonical-dependency-bytes"));
  });

  it("E4. shell-significant name cannot inject commands", () => {
    const d = dir("e4");
    const hack = path.join(d, "HACKED");
    const e = entry('a$(touch HACKED);touch HACKED".txt');
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(fs.existsSync(hack)).toBe(false);
    expect(r.code).toBe(0);
    // The literal filename (metachars included) is exactly the target.
    expect(
      fs.existsSync(path.join(d, e.consumer_relative_path)),
    ).toBe(true);
  });

  it("E5. exhausted HTTP retries → non-zero exit + target absent", () => {
    const d = dir("e5");
    const e = entry("report.txt");
    const r = runRecipe(d, recipeFor(e), "http_fail");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DEPENDENCY_FETCH_FAILED ART_R2E");
    expect(fs.existsSync(path.join(d, e.consumer_relative_path))).toBe(
      false,
    );
  });

  it("E6. digest mismatch → non-zero exit + target absent + quarantine kept", () => {
    const d = dir("e6");
    const e = entry("report.txt");
    const r = runRecipe(d, recipeFor(e), "bad_bytes");
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(d, e.consumer_relative_path))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(d, `${e.consumer_relative_path}.quarantine`)),
    ).toBe(true);
  });

  it("E7. size mismatch → non-zero exit + target absent", () => {
    const d = dir("e7");
    const e = {
      ...entry("report.txt"),
      byte_size: Buffer.byteLength("canonical-dependency-bytes") + 5,
    };
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(d, e.consumer_relative_path))).toBe(
      false,
    );
  });

  it("E8. successful fetch → exact target bytes + exit 0", () => {
    const d = dir("e8");
    const e = entry("report.txt");
    const r = runRecipe(d, recipeFor(e), "ok");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("DEPENDENCY_FETCH_FAILED");
    expect(
      fs.readFileSync(path.join(d, e.consumer_relative_path)),
    ).toEqual(Buffer.from("canonical-dependency-bytes"));
  });
});
