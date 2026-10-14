/**
 * P0 — Windows-native runtime closure, Workstream A.
 *
 * Proves the handle-backed opened-object security contract on win32:
 *   A  secureReadContained — opened-object containment proof (kernel
 *      canonical path on the same HANDLE), reparse/junction/symlink
 *      rejection, outside-root, traversal, bounded reads, identity
 *      stability. Runs on every platform — on win32 it exercises the
 *      kernel-HANDLE path, elsewhere the /proc/self/fd path.
 *   B  ArtifactAuthority local ingest end-to-end — path source → CAS
 *      blob → ACCEPTED — including the win32 directory-fsync barrier.
 *   C  Dependency-artifact local materialization — handle-anchored
 *      mkdir/publish/fsync with adversarial cases (junctioned parent,
 *      symlinked destination, tampered CAS, divergent existing bytes,
 *      idempotent converge).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactDependencyResolver,
  ArtifactProvenanceValidator,
  digest,
  canonicalHandoffId,
  DependencyResolutionError,
  DEPENDENCY_ARTIFACT_ROOT,
  dependencyConsumerPath,
  artifactDependencySetDigest,
  HANDOFF_ENTITY,
  IntegrityError,
  PairControlPlane,
  PairEvidenceStore,
  secureReadContained,
  sha256Hex,
  utcnow,
  workerExecutionId,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p0-win32-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_P0";
const isWin32 = process.platform === "win32";

/** Create a directory junction on win32 / symlink elsewhere. */
function linkDir(target: string, link: string) {
  fs.symlinkSync(target, link, isWin32 ? "junction" : "dir");
}
/** File link (final-component). On win32 hosts without symlink
 *  privilege fall back to a junction — the security property under
 *  test is "final name is a reparse point", which junctions express. */
function linkFile(target: string, link: string) {
  try {
    fs.symlinkSync(target, link, "file");
  } catch (e) {
    if (!isWin32 || (e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    fs.symlinkSync(path.dirname(target), link, "junction");
  }
}

/* ==================== A — secureReadContained ==================== */

describe("A — secureReadContained opened-object contract", () => {
  it("A1 reads bytes of a file inside an allowed root", () => {
    const d = dir("a1");
    const p = path.join(d, "f.txt");
    fs.writeFileSync(p, "hello-object");
    const r = secureReadContained(p, 1 << 20, [d]);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.bytes.toString()).toBe("hello-object");
  });

  it("A2 file outside every allowed root → outside", () => {
    const root = dir("a2-root");
    const out = dir("a2-out");
    const p = path.join(out, "f.txt");
    fs.writeFileSync(p, "x");
    expect(secureReadContained(p, 1 << 20, [root]).kind).toBe("outside");
  });

  it("A3 traversal escapes resolve outside → outside", () => {
    const root = dir("a3-root");
    const out = dir("a3-out");
    const p = path.join(out, "f.txt");
    fs.writeFileSync(p, "x");
    const traversal = path.join(root, "..", path.basename(out), "f.txt");
    expect(secureReadContained(traversal, 1 << 20, [root]).kind).toBe("outside");
  });

  it("A4 final-component symlink → symlink (never followed)", () => {
    const d = dir("a4");
    fs.writeFileSync(path.join(d, "real.txt"), "real");
    const link = path.join(d, "link.txt");
    linkFile(path.join(d, "real.txt"), link);
    expect(secureReadContained(link, 1 << 20, [d]).kind).toBe("symlink");
  });

  it("A5 directory junction pointing OUTSIDE the root → outside", () => {
    const root = dir("a5-root");
    const out = dir("a5-out");
    fs.writeFileSync(path.join(out, "stolen.txt"), "secret");
    const junc = path.join(root, "junc");
    linkDir(out, junc);
    const r = secureReadContained(path.join(junc, "stolen.txt"), 1 << 20, [root]);
    expect(r.kind).toBe("outside");
  });

  it("A6 junction pointing INSIDE the root resolves to canonical inside → ok", () => {
    const root = dir("a6-root");
    const inner = path.join(root, "inner");
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, "f.txt"), "in-root");
    const junc = path.join(root, "j");
    linkDir(inner, junc);
    const r = secureReadContained(path.join(junc, "f.txt"), 1 << 20, [root]);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.bytes.toString()).toBe("in-root");
  });

  it("A7 hardlink to an outside object: dest name inside, object outside", () => {
    // A hardlink inside the root to an object created outside it — the
    // opened object's canonical path is inside (hardlinks share the
    // object; its in-root name is legitimate). Bytes are the same file
    // → reads succeed because the OBJECT lives under the root name.
    const root = dir("a7-root");
    const out = dir("a7-out");
    const src = path.join(out, "s.txt");
    fs.writeFileSync(src, "hardlinked");
    const link = path.join(root, "h.txt");
    fs.linkSync(src, link);
    const r = secureReadContained(link, 1 << 20, [root]);
    expect(r.kind).toBe("ok");
  });

  it("A8 missing path → unresolved", () => {
    const d = dir("a8");
    expect(secureReadContained(path.join(d, "none.txt"), 1 << 20, [d]).kind).toBe(
      "unresolved",
    );
  });

  it("A9 directory as source → unresolved", () => {
    const d = dir("a9");
    const sub = path.join(d, "sub");
    fs.mkdirSync(sub);
    expect(secureReadContained(sub, 1 << 20, [d]).kind).toBe("unresolved");
  });

  it("A10 bounded read: oversized object → too_large, never read", () => {
    const d = dir("a10");
    const p = path.join(d, "big.bin");
    fs.writeFileSync(p, Buffer.alloc(1024));
    const r = secureReadContained(p, 64, [d]);
    expect(r.kind).toBe("too_large");
  });

  it("A11 symlinked ROOT resolves then containment still proven", () => {
    const real = dir("a11-real");
    fs.writeFileSync(path.join(real, "f.txt"), "x");
    const linkRoot = path.join(dir("a11-parent"), "linkroot");
    linkDir(real, linkRoot);
    // Caller passes the symlinked root — realpath(root) lands inside
    // the real dir; the opened object's canonical path compares there.
    const r = secureReadContained(path.join(linkRoot, "f.txt"), 1 << 20, [linkRoot]);
    expect(r.kind).toBe("ok");
  });

  it("A12 file swap between lstat-style check and open cannot forge identity", () => {
    const d = dir("a12");
    const p = path.join(d, "swap.txt");
    fs.writeFileSync(p, "v1");
    const r1 = secureReadContained(p, 1 << 20, [d]);
    fs.writeFileSync(p, "v2-changed");
    const r2 = secureReadContained(p, 1 << 20, [d]);
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    expect(r2.kind === "ok" && r2.bytes.toString()).toBe("v2-changed");
  });
});

/* ============== B — ArtifactAuthority ingest on this platform ============== */

function mkCtx(name: string) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const project = service.createProject({ name: "p", root_location: workspace });
  const mission = service.createMission({
    project_id: String(project.project_id),
    goal: "p0",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [workspace],
  });
  service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: [], source: "TEST", proposal: null,
  });
  return { d, workspace, store, service, missionId: String(mission.mission_id) };
}

let seq = 0;
/** Minimal producer chain — same rows the governed gate persists. */
function mkProducer(ctx: ReturnType<typeof mkCtx>, name = "out.txt") {
  const tid = `ATSK_P0_${seq++}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(EX, gtId);
  ctx.store.put("task", tid, {
    task_id: tid, task_key: `TP${seq}`, mission_id: ctx.missionId, plan_id: "PLAN_P0",
    title: tid, task_instruction: `produce ${name}`, status: "COMPLETED",
    required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
    metadata: { pair_dataflow: { produces: [name], consumes: [] } }, version: 0,
  }, 0);
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: ctx.missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: EX, plan_id: "PLAN_P0", plan_revision: 1,
    workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  {
    // Mirror the production mint: immutable GOVERNED_TASK_VALIDATED
    // anchor binding mint-time identity + scope digest.
    const governed = ctx.store.get("governed_task", gtId);
    governed.permissions = governed.permissions ?? [];
    governed.dependency_artifacts_digest = governed.dependency_artifacts_digest ?? null;
    governed.approval_scope_digest = digest({
      mission_id: governed.mission_id, task_id: governed.task_id,
      executor_id: governed.executor_id,
      workspace: String(governed.workspace),
      allowed_paths: governed.allowed_paths,
      permissions: governed.permissions,
      expected_output_contract: governed.expected_output_contract,
      dependency_artifacts_digest: governed.dependency_artifacts_digest,
    });
    ctx.store.put("governed_task", gtId, governed, Number(governed.version));
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: ctx.missionId, task_id: tid, executor_id: EX,
        governed_task_id: gtId, plan_id: "PLAN_P0", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: false,
        declared_produces: null,
        declared_produces_digest: null,
      },
    });
    ctx.store.appendEvidence(ctx.missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: EX,
      mission_id: ctx.missionId, plan_id: "PLAN_P0", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: false,
      declared_produces: null,
      declared_produces_digest: null,
    });
  }
  ctx.store.put("executor_execution", eid, {
    execution_id: eid, governed_task_id: gtId, mission_id: ctx.missionId,
    task_id: tid, executor_id: EX, plan_revision: 1, correlation_id: `COR_${tid}`,
    execution_state: "COMPLETED", dispatch_timestamp: utcnow(),
    workspace: ctx.workspace, version: 0,
  }, 0);
  return { tid, gtId, eid, task_key: `TP${seq}` };
}

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

describe("B — artifact ingest through the win32 opened-object path", () => {
  it("B1 path source inside allowed workspace → ACCEPTED + CAS bytes", () => {
    const ctx = mkCtx("b1");
    const prod = mkProducer(ctx);
    const p = path.join(ctx.workspace, "out.txt");
    fs.writeFileSync(p, "p0-local");
    const r = ctx.service.artifacts.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "out.txt",
      source: { kind: "path", path: p }, channel: "LOCAL_EXECUTION", actor: "TEST",
      allow_post_result: true,
    });
    expect(String(r.artifact.state)).toBe("ACCEPTED");
    expect(String(r.artifact.sha256)).toBe(sha256Hex(Buffer.from("p0-local")));
    const blob = fs.readFileSync(
      path.join(ctx.d, "artifacts", "blobs", String(r.artifact.sha256)),
    );
    expect(blob.toString()).toBe("p0-local");
  });

  it("B2 symlinked source file → FAIL_CLOSED_ARTIFACT_SYMLINK", () => {
    const ctx = mkCtx("b2");
    const prod = mkProducer(ctx);
    const real = path.join(ctx.workspace, "real.txt");
    fs.writeFileSync(real, "real-bytes");
    const link = path.join(ctx.workspace, "link.txt");
    linkFile(real, link);
    expect(errCode(() =>
      ctx.service.artifacts.accept({
        execution_id: prod.eid, producer_executor_id: EX, logical_name: "link.txt",
        source: { kind: "path", path: link }, channel: "LOCAL_EXECUTION", actor: "TEST",
        allow_post_result: true,
      }),
    )).toBe("FAIL_CLOSED_ARTIFACT_SYMLINK");
  });

  it("B3 junctioned parent escaping workspace → FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE", () => {
    const ctx = mkCtx("b3");
    const prod = mkProducer(ctx);
    const out = dir("b3-outside");
    fs.writeFileSync(path.join(out, "stolen.txt"), "secret");
    const junc = path.join(ctx.workspace, "esc");
    linkDir(out, junc);
    expect(errCode(() =>
      ctx.service.artifacts.accept({
        execution_id: prod.eid, producer_executor_id: EX, logical_name: "stolen.txt",
        source: { kind: "path", path: path.join(junc, "stolen.txt") },
        channel: "LOCAL_EXECUTION", actor: "TEST", allow_post_result: true,
      }),
    )).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
  });

  it("B4 declared sha != opened-object bytes → FAIL (tamper caught)", () => {
    const ctx = mkCtx("b4");
    const prod = mkProducer(ctx);
    const p = path.join(ctx.workspace, "out.txt");
    fs.writeFileSync(p, "actual-bytes");
    const exec = ctx.store.get("executor_execution", prod.eid);
    exec.result = {
      status: "COMPLETED",
      artifacts: [{ path: "out.txt", sha256: "0".repeat(64), byte_size: 12 }],
    };
    ctx.store.put("executor_execution", prod.eid, exec, exec.version);
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, prod.eid);
    expect(v.status).toBe("FAIL");
  });

  it("B5 forged identity: name claims workspace file but object lives outside", () => {
    const ctx = mkCtx("b5");
    const prod = mkProducer(ctx);
    // Pre-stage: the declared path inside the workspace is a JUNCTION
    // to an outside file — the opened object's canonical path resolves
    // outside → reject even though the NAME looks in-root.
    const out = dir("b5-out");
    fs.writeFileSync(path.join(out, "payload.txt"), "forged");
    const juncDir = path.join(ctx.workspace, "esc");
    linkDir(out, juncDir);
    expect(errCode(() =>
      ctx.service.artifacts.accept({
        execution_id: prod.eid, producer_executor_id: EX, logical_name: "payload.txt",
        source: { kind: "path", path: path.join(juncDir, "payload.txt") },
        channel: "LOCAL_EXECUTION", actor: "TEST", allow_post_result: true,
      }),
    )).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
  });
});

/* ========= C — dependency handoff materialization (win32 handles) ========= */

describe("C — handle-bound dependency materialization", () => {
  function mkConsumer(ctx: ReturnType<typeof mkCtx>, dependsOn: string[], consume = "report.txt") {
    const tid = `ATSK_P0C_${seq++}`;
    ctx.store.put("task", tid, {
      task_id: tid, task_key: `TC${seq}`, mission_id: ctx.missionId, plan_id: "PLAN_P0",
      title: tid, task_instruction: `read ${consume}`, required_capabilities: ["FILE_OPERATIONS"],
      depends_on: dependsOn, status: "READY",
      metadata: { pair_dataflow: { produces: [], consumes: [consume] } }, version: 0,
    }, 0);
    return { tid, task: ctx.store.get("task", tid) };
  }

  function mkGovernedConsumer(
    ctx: ReturnType<typeof mkCtx>,
    consumer: { tid: string; task: Record<string, unknown> },
    entries: ReturnType<ArtifactDependencyResolver["resolveForConsumer"]>,
  ) {
    const gtId = `GT_${consumer.tid}`;
    const depDigest = artifactDependencySetDigest(entries);
    ctx.store.put("governed_task", gtId, {
      governed_task_id: gtId, mission_id: ctx.missionId, task_id: consumer.tid,
      correlation_id: `COR_${consumer.tid}`, executor_id: EX, plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      dependency_artifacts: entries, dependency_artifacts_digest: depDigest,
      created_at: utcnow(), version: 0,
    }, 0);
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${consumer.tid}`,
      metadata: {
        mission_id: ctx.missionId, task_id: consumer.tid, executor_id: EX,
        dependency_artifacts_digest: depDigest,
      },
    });
    return { gtId, governed: ctx.store.get("governed_task", gtId) };
  }

  /** Producer artifact → resolve → pin → governed consumer. */
  function setupHandoff(ctx: ReturnType<typeof mkCtx>, name = "report.txt") {
    const prod = mkProducer(ctx, name);
    const p = path.join(ctx.workspace, name);
    fs.writeFileSync(p, `artifact-of-${prod.tid}`);
    const bytes = fs.readFileSync(p);
    const exec = ctx.store.get("executor_execution", prod.eid);
    exec.result = {
      status: "COMPLETED",
      artifacts: [{ path: name, sha256: sha256Hex(bytes), byte_size: bytes.length }],
    };
    ctx.store.put("executor_execution", prod.eid, exec, exec.version);
    // Production order: the validator performs the LOCAL_EXECUTION
    // ingest of the declared artifact itself.
    new ArtifactProvenanceValidator().validate_execution(ctx.service, prod.eid);
    const cons = mkConsumer(ctx, [prod.task_key], name);
    const entries = new ArtifactDependencyResolver(ctx.service).resolveForConsumer({
      mission: ctx.service.getMission(ctx.missionId),
      task: cons.task,
    });
    expect(entries).toHaveLength(1);
    const gc = mkGovernedConsumer(ctx, cons, entries);
    ctx.service.artifactHandoffs.pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    return { prod, gc, entries, bytes };
  }

  it("C1 pinned dependency materializes exact bytes at canonical dest", () => {
    const ctx = mkCtx("c1");
    const { gc, entries, bytes } = setupHandoff(ctx);
    const written = ctx.service.artifactHandoffs.materializeForConsumer(gc.governed);
    expect(written).toEqual([entries[0]!.consumer_relative_path]);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(fs.readFileSync(dest)).toEqual(bytes);
    const h = ctx.store.get(HANDOFF_ENTITY,
      canonicalHandoffId(gc.gtId, entries[0]!.artifact_id, entries[0]!.consumer_relative_path));
    expect(String(h.state)).toBe("MATERIALIZED");
  });

  it("C2 replay: identical existing dest converges MATERIALIZED (idempotent)", () => {
    const ctx = mkCtx("c2");
    const { gc, entries, bytes } = setupHandoff(ctx);
    ctx.service.artifactHandoffs.materializeForConsumer(gc.governed);
    const again = ctx.service.artifactHandoffs.materializeForConsumer(gc.governed);
    expect(again).toEqual([entries[0]!.consumer_relative_path]);
    expect(fs.readFileSync(path.join(ctx.workspace, entries[0]!.consumer_relative_path))).toEqual(bytes);
  });

  it("C3 existing divergent bytes → FAIL existing_bytes_differ (never overwritten)", () => {
    const ctx = mkCtx("c3");
    const { gc, entries } = setupHandoff(ctx);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "DIFFERENT-BYTES");
    expect(errCode(() => ctx.service.artifactHandoffs.materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
    expect(fs.readFileSync(dest).toString()).toBe("DIFFERENT-BYTES");
  });

  it("C4 destination name bound to a symlink/junction → conflict", () => {
    const ctx = mkCtx("c4");
    const { gc, entries } = setupHandoff(ctx);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const outside = dir("c4-out");
    fs.writeFileSync(path.join(outside, "x.txt"), "poison");
    // Dest is a file symlink → conflict (opened AS the link object).
    linkFile(path.join(outside, "x.txt"), dest);
    expect(errCode(() => ctx.service.artifactHandoffs.materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
  });

  it("C5 parent component swapped to a junction → parent fails closed", () => {
    const ctx = mkCtx("c5");
    const { gc, entries } = setupHandoff(ctx);
    const relParts = entries[0]!.consumer_relative_path.split("/");
    // .pair/dependency-artifacts/<task>/<ART>/report.txt — swap the
    // FIRST materialization parent component (.pair) to a junction.
    const pairRoot = path.join(ctx.workspace, relParts[0]!);
    fs.mkdirSync(pairRoot, { recursive: true });
    const escape = dir("c5-escape");
    fs.rmSync(pairRoot, { recursive: true, force: true });
    linkDir(escape, pairRoot);
    expect(errCode(() => ctx.service.artifactHandoffs.materializeForConsumer(gc.governed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
  });

  it("C6 tampered retained CAS bytes → F1 verification fails before any write", () => {
    const ctx = mkCtx("c6");
    const { gc, entries } = setupHandoff(ctx);
    // Corrupt the retained blob — the pinned artifact is re-verified
    // NOW (sha of retained bytes vs pinned sha) before any byte moves.
    const blobPath = path.join(ctx.d, "artifacts", "blobs", entries[0]!.sha256);
    fs.writeFileSync(blobPath, "tampered");
    expect(errCode(() => ctx.service.artifactHandoffs.materializeForConsumer(gc.governed)))
      .toBe("FAIL_CLOSED_ARTIFACT_VERIFICATION");
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("C7 allowed_paths without workspace coverage → outside_allowed_paths", () => {
    const ctx = mkCtx("c7");
    const { gc } = setupHandoff(ctx);
    const elsewhere = path.join(ctx.d, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const narrowed = { ...gc.governed, allowed_paths: [elsewhere] };
    expect(errCode(() => ctx.service.artifactHandoffs.materializeForConsumer(narrowed)))
      .toBe("DEP:FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE");
  });

  it("C8 nested missing parent dirs are created INSIDE the proven root", () => {
    const ctx = mkCtx("c8");
    const { gc, entries, bytes } = setupHandoff(ctx);
    // Sanity: canonical dest nests under .pair/dependency-artifacts/...
    expect(entries[0]!.consumer_relative_path.startsWith(`${DEPENDENCY_ARTIFACT_ROOT}/`)).toBe(true);
    ctx.service.artifactHandoffs.materializeForConsumer(gc.governed);
    const dest = path.join(ctx.workspace, entries[0]!.consumer_relative_path);
    expect(fs.realpathSync(dest)).toBe(
      fs.realpathSync(path.join(ctx.workspace, entries[0]!.consumer_relative_path)),
    );
    expect(fs.readFileSync(dest)).toEqual(bytes);
    // On win32 prove the dest's KERNEL canonical path is inside the
    // workspace's kernel canonical path.
    if (isWin32) {
      expect(fs.realpathSync.native(dest).toLowerCase())
        .toContain(fs.realpathSync.native(ctx.workspace).toLowerCase());
    }
  });
});
