/**
 * F1 — R2 source-review remediation regressions (permanent shipped
 * suite; promoted from the extended clean-room re-audit surface).
 *
 *   R2-A*  R2.1 — containment bound to the SAME opened file object:
 *          parent-symlink swaps after open cannot redirect the fd
 *   R2-B*  R2.2 — ONE byte realization: declared sha/size verified by
 *          the authority on the materialized buffer (no validate-then-
 *          reread double-read)
 *   R2-C*  R2.3 — replay requires a fully canonical F1 prior
 *   R2-D*  R2.4 — governed.executor_id == execution.executor_id
 *   R2-E*  R2.5 — compat writer/resolver share one naming rule
 *   R2-F*  R2.6 — dir-fsync fallback only for documented codes
 *   R2-G*  R2.7 — TRUE multi-process count-race proofs
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactAuthority,
  ArtifactProvenanceValidator,
  compatOutboxBasename,
  IntegrityError,
  mintArtifactCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  sha256Hex,
  utcnow,
  workerExecutionId,
} from "../pair/index.js";
import { resolveDeliveryArtifactPath } from "../pair/telegram-delivery.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f1-r2-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const EX = "EX_R2";

function mkCtx(name: string) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(d, "artifacts", "blobs"),
  });
  const control = new MissionControl({ service } as never);
  const project = service.createProject({ name: "p", root_location: workspace });
  const mission = service.createMission({
    project_id: String(project.project_id),
    goal: "r2",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [workspace],
  });
  return {
    d,
    workspace,
    store,
    service,
    authority,
    control,
    missionId: String(mission.mission_id),
  };
}

let seq = 0;
function mkProducer(
  ctx: ReturnType<typeof mkCtx>,
  opts: { state?: string; result?: Record<string, unknown> | null; governedExecutor?: string } = {},
) {
  const tid = `ATSK_R2_${seq++}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(EX, gtId);
  ctx.store.put("task", tid, { task_id: tid, mission_id: ctx.missionId, version: 0 }, 0);
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId,
      mission_id: ctx.missionId,
      task_id: tid,
      correlation_id: `COR_${tid}`,
      executor_id: opts.governedExecutor ?? EX,
      workspace: ctx.workspace,
      allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true,
      created_at: utcnow(),
      version: 0,
    },
    0,
  );
  const exec: Record<string, unknown> = {
    execution_id: eid,
    governed_task_id: gtId,
    mission_id: ctx.missionId,
    task_id: tid,
    executor_id: EX,
    correlation_id: `COR_${tid}`,
    execution_state: opts.state ?? "RUNNING",
    dispatch_timestamp: utcnow(),
    workspace: ctx.workspace,
    version: 0,
  };
  if (opts.result !== undefined && opts.result !== null) exec.result = opts.result;
  ctx.store.put("executor_execution", eid, exec, 0);
  return { tid, gtId, eid };
}

const blobPath = (ctx: ReturnType<typeof mkCtx>, sha: string) =>
  path.join(ctx.d, "artifacts", "blobs", sha);

const run = (f: () => unknown): string => {
  try {
    f();
    return "NO_THROW";
  } catch (e) {
    return e instanceof IntegrityError ? e.code : `NOT_INTEGRITY:${String(e)}`;
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

/* ==================== R2.1 opened-object containment ===================== */
describe("R2-A opened-object containment binding", () => {
  const acceptPath = (
    ctx: ReturnType<typeof mkCtx>,
    eid: string,
    rel: string,
  ): string =>
    run(() =>
      ctx.authority.accept({
        execution_id: eid,
        producer_executor_id: EX,
        logical_name: rel,
        source: { kind: "path", path: path.join(ctx.workspace, rel) },
        channel: "LOCAL_EXECUTION",
        actor: "T",
        allow_post_result: true,
      }),
    );

  it("R2-A1 parent symlink inside→swapped outside AFTER open still yields inside bytes", () => {
    const ctx = mkCtx("a1");
    const p = mkProducer(ctx);
    const inside = path.join(ctx.workspace, "realdir");
    const outside = path.join(ctx.d, "outside");
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, "f.bin"), "INSIDE-A");
    fs.writeFileSync(path.join(outside, "f.bin"), "OUTSIDE-B");
    fs.symlinkSync(inside, path.join(ctx.workspace, "link"), "dir");
    // After openSync bound the fd to the inside object, swap the link to
    // outside — the open fd cannot be redirected, so INSIDE bytes are
    // the only possible canonical authority.
    const orig = fs.realpathSync;
    let swapped = false;
    vi.spyOn(fs, "realpathSync").mockImplementation(((pth: unknown, ...rest: unknown[]) => {
      if (String(pth).startsWith("/proc/self/fd/") && !swapped) {
        swapped = true;
        fs.unlinkSync(path.join(ctx.workspace, "link"));
        fs.symlinkSync(outside, path.join(ctx.workspace, "link"), "dir");
      }
      return (orig as (...a: unknown[]) => unknown).call(fs, pth, ...rest);
    }) as typeof fs.realpathSync);
    const r = ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "link/f.bin",
      source: { kind: "path", path: path.join(ctx.workspace, "link", "f.bin") },
      channel: "LOCAL_EXECUTION",
      actor: "T",
      allow_post_result: true,
    });
    expect(r.artifact.sha256).toBe(sha256Hex(Buffer.from("INSIDE-A")));
    const blob = blobPath(ctx, String(r.artifact.sha256));
    expect(blob).not.toBeNull();
    expect(fs.readFileSync(blob!).toString()).toBe("INSIDE-A");
  });

  it("R2-A2 parent symlink swapped to OUTSIDE before open → fail closed", () => {
    const ctx = mkCtx("a2");
    const p = mkProducer(ctx);
    const inside = path.join(ctx.d, "inside");
    const outside = path.join(ctx.d, "outside");
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, "f.bin"), "INSIDE-A");
    fs.writeFileSync(path.join(outside, "f.bin"), "OUTSIDE-B");
    fs.symlinkSync(inside, path.join(ctx.workspace, "link"), "dir");
    // swap BEFORE any open — the opened object resolves outside
    fs.unlinkSync(path.join(ctx.workspace, "link"));
    fs.symlinkSync(outside, path.join(ctx.workspace, "link"), "dir");
    expect(acceptPath(ctx, p.eid, "link/f.bin")).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
  });

  it("R2-A3 final file replaced after open → opened original object retained", () => {
    const ctx = mkCtx("a3");
    const p = mkProducer(ctx);
    const f = path.join(ctx.workspace, "f.bin");
    fs.writeFileSync(f, "ORIG-A");
    const orig = fs.realpathSync;
    let swapped = false;
    vi.spyOn(fs, "realpathSync").mockImplementation(((pth: unknown, ...rest: unknown[]) => {
      if (String(pth).startsWith("/proc/self/fd/") && !swapped) {
        swapped = true;
        const repl = path.join(ctx.d, "repl.bin");
        fs.writeFileSync(repl, "REPL-B");
        fs.renameSync(repl, f); // new inode replaces the opened one
      }
      return (orig as (...a: unknown[]) => unknown).call(fs, pth, ...rest);
    }) as typeof fs.realpathSync);
    const code = run(() =>
      ctx.authority.accept({
        execution_id: p.eid,
        producer_executor_id: EX,
        logical_name: "f.bin",
        source: { kind: "path", path: f },
        channel: "LOCAL_EXECUTION",
        actor: "T",
        allow_post_result: true,
      }),
    );
    // the opened ORIGINAL object (inode A) is either the byte authority
    // or the operation fails closed — REPL-B can never be minted.
    if (code === "NO_THROW") {
      const art = ctx.authority.forExecution(p.eid)[0];
      expect(String(art.sha256)).toBe(sha256Hex(Buffer.from("ORIG-A")));
    } else {
      expect(code).toMatch(/^FAIL_CLOSED_ARTIFACT_/);
      expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
    }
  });

  it("R2-A4 static parent symlink outside still rejected; ordinary file passes", () => {
    const ctx = mkCtx("a4");
    const p = mkProducer(ctx);
    const outside = path.join(ctx.d, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "s.bin"), "OUT");
    fs.symlinkSync(outside, path.join(ctx.workspace, "out"), "dir");
    expect(acceptPath(ctx, p.eid, "out/s.bin")).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
    fs.writeFileSync(path.join(ctx.workspace, "ok.bin"), "OK");
    expect(acceptPath(ctx, p.eid, "ok.bin")).toBe("NO_THROW");
  });
});

/* ==================== R2.2 one byte realization ========================= */
describe("R2-B declared bytes == canonical bytes", () => {
  it("R2-B1 declared sha(A) but file mutated to same-size B → FAIL, zero rows", () => {
    const ctx = mkCtx("b1");
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [{ path: "a.txt", sha256: sha256Hex(Buffer.from("AAA")) }],
      },
    });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "BBB"); // same size
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(v.artifact_ids).toEqual([]);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });

  it("R2-B2 declared byte_size drift → FAIL, zero rows", () => {
    const ctx = mkCtx("b2");
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [{ path: "a.txt", byte_size: 3 }],
      },
    });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "AAAA");
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });

  it("R2-B3 valid declaration → PASS and CAS retains exactly those bytes", () => {
    const ctx = mkCtx("b3");
    const payload = "PAIR-VALIDATED-BYTES";
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [
          { path: "a.txt", sha256: sha256Hex(Buffer.from(payload)), byte_size: payload.length },
        ],
      },
    });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), payload);
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("PASS");
    const art = ctx.authority.forExecution(p.eid)[0];
    expect(String(art.sha256)).toBe(sha256Hex(Buffer.from(payload)));
    const blob = blobPath(ctx, String(art.sha256));
    expect(fs.readFileSync(blob!).toString()).toBe(payload);
  });
});

/* ==================== R2.3 canonical prior proof ========================= */
describe("R2-C replay requires canonical prior", () => {
  /** Accept once while RUNNING → corrupt one durable row field → close
   *  execution → replay identical bytes must fail closed. */
  const corruptPrior = (
    ctx: ReturnType<typeof mkCtx>,
    prod: { eid: string },
    mutate: (row: Record<string, unknown>) => void,
  ): string => {
    const bytes = Buffer.from("PRIOR-BYTES");
    const accepted = ctx.authority.accept({
      execution_id: prod.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    const row = ctx.store.get("artifact", String(accepted.artifact.artifact_id)) as Record<string, unknown>;
    mutate(row);
    ctx.store.put("artifact", String(row.artifact_id), row, Number(row.version));
    ctx.store.put(
      "executor_execution",
      prod.eid,
      {
        ...(ctx.store.get("executor_execution", prod.eid) as Record<string, unknown>),
        result: { status: "COMPLETED" },
        execution_state: "COMPLETED",
      },
      Number((ctx.store.get("executor_execution", prod.eid) as Record<string, unknown>).version),
    );
    return run(() =>
      ctx.authority.accept({
        execution_id: prod.eid,
        producer_executor_id: EX,
        logical_name: "a.txt",
        source: { kind: "buffer", bytes },
        channel: "REMOTE_UPLOAD",
        actor: "T",
      }),
    );
  };

  it("R2-C1 prior missing contract → replay fails closed", () => {
    const ctx = mkCtx("c1");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => delete r.contract)).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C2 wrong contract → fail closed", () => {
    const ctx = mkCtx("c2");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => (r.contract = "other.v9"))).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C3 wrong producer_executor_id → fail closed", () => {
    const ctx = mkCtx("c3");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => (r.producer_executor_id = "OTHER"))).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C4 wrong governed_task_id → fail closed", () => {
    const ctx = mkCtx("c4");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => (r.governed_task_id = "GT_OTHER"))).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C5 wrong mission_id → fail closed", () => {
    const ctx = mkCtx("c5");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => (r.mission_id = "MSN_X"))).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C6 wrong logical_name → fail closed", () => {
    const ctx = mkCtx("c6");
    const p = mkProducer(ctx);
    expect(corruptPrior(ctx, p, (r) => (r.logical_name = "zzz.txt"))).toBe(
      "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
    );
  });
  it("R2-C7 storage sha mismatch → fail closed", () => {
    const ctx = mkCtx("c7");
    const p = mkProducer(ctx);
    expect(
      corruptPrior(ctx, p, (r) => {
        (r.storage as Record<string, unknown>).sha256 = "0".repeat(64);
      }),
    ).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
  });
  it("R2-C8 missing CAS blob → fail closed", () => {
    const ctx = mkCtx("c8");
    const p = mkProducer(ctx);
    const bytes = Buffer.from("BLOB-GONE");
    const accepted = ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    fs.unlinkSync(blobPath(ctx, String(accepted.artifact.sha256))!);
    const exRow = ctx.store.get("executor_execution", p.eid) as Record<string, unknown>;
    ctx.store.put(
      "executor_execution",
      p.eid,
      { ...exRow, result: { status: "COMPLETED" }, execution_state: "COMPLETED" },
      Number(exRow.version),
    );
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "a.txt",
          source: { kind: "buffer", bytes },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
  });
  it("R2-C9 corrupt CAS blob → fail closed", () => {
    const ctx = mkCtx("c9");
    const p = mkProducer(ctx);
    const bytes = Buffer.from("BLOB-CORRUPT");
    const accepted = ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    fs.writeFileSync(blobPath(ctx, String(accepted.artifact.sha256))!, "CORRUPTED");
    const exRow = ctx.store.get("executor_execution", p.eid) as Record<string, unknown>;
    ctx.store.put(
      "executor_execution",
      p.eid,
      { ...exRow, result: { status: "COMPLETED" }, execution_state: "COMPLETED" },
      Number(exRow.version),
    );
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "a.txt",
          source: { kind: "buffer", bytes },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
  });
  it("R2-C10 valid canonical prior + same bytes post-close → replay converges", () => {
    const ctx = mkCtx("c10");
    const p = mkProducer(ctx);
    const bytes = Buffer.from("VALID-PRIOR");
    ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    const exRow = ctx.store.get("executor_execution", p.eid) as Record<string, unknown>;
    ctx.store.put(
      "executor_execution",
      p.eid,
      { ...exRow, result: { status: "COMPLETED" }, execution_state: "COMPLETED" },
      Number(exRow.version),
    );
    const r = ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    expect(r.replayed).toBe(true);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(1);
  });
});

/* ==================== R2.4 governed executor linkage ===================== */
describe("R2-D governed↔execution executor linkage", () => {
  it("R2-D1 governed.executor_id contradicts execution.executor_id → direct accept FAIL CLOSED", () => {
    const ctx = mkCtx("d1");
    const p = mkProducer(ctx, { governedExecutor: "DEVIN" });
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "a.txt",
          source: { kind: "buffer", bytes: Buffer.from("X") },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_LINKAGE");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });
  it("R2-D2 same contradiction → capability-bound upload FAIL CLOSED", () => {
    const ctx = mkCtx("d2");
    const p = mkProducer(ctx, { governedExecutor: "DEVIN" });
    const cap = mintArtifactCapability("master", {
      mission_id: ctx.missionId,
      task_id: p.tid,
      governed_task_id: p.gtId,
      execution_id: p.eid,
      executor_id: EX,
    });
    expect(() =>
      ctx.control.acceptArtifactUpload("master", cap, {
        mission_id: ctx.missionId,
        task_id: p.tid,
        filename: "a.txt",
        bytes: Buffer.from("X"),
      }),
    ).toThrowError(/CAPABILITY_MISMATCH/);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });
});

/* ==================== R2.5 shared compat naming rule ===================== */
describe("R2-E compat outbox naming ↔ delivery resolver", () => {
  it("R2-E1 resolver finds compat-materialized file for `a b.txt`", () => {
    const ctx = mkCtx("e1");
    const p = mkProducer(ctx);
    const outboxDir = path.join(ctx.d, "outbox");
    fs.mkdirSync(outboxDir);
    const filename = compatOutboxBasename("a b.txt");
    const frag = "ABCDEF0123456789";
    fs.writeFileSync(path.join(outboxDir, `${p.tid}-${frag}-${filename}`), "DATA");
    const resolved = resolveDeliveryArtifactPath({ outboxDir, name: "a b.txt" });
    expect(resolved).toBe(path.join(outboxDir, `${p.tid}-${frag}-${filename}`));
  });
  it("R2-E2 resolver finds `a?b.txt` compat file", () => {
    const ctx = mkCtx("e2");
    const p = mkProducer(ctx);
    const outboxDir = path.join(ctx.d, "outbox");
    fs.mkdirSync(outboxDir);
    const filename = compatOutboxBasename("a?b.txt");
    fs.writeFileSync(path.join(outboxDir, `${p.tid}-frag-${filename}`), "DATA");
    expect(resolveDeliveryArtifactPath({ outboxDir, name: "a?b.txt" })).toBe(
      path.join(outboxDir, `${p.tid}-frag-${filename}`),
    );
  });
  it("R2-E3 names sanitizing to the same compat basename → resolver fails closed", () => {
    const outboxDir = dir("e3-outbox");
    // two distinct artifacts whose logical basenames collide after sanitize
    fs.writeFileSync(path.join(outboxDir, "t-AAAA-a_b.txt"), "ONE");
    fs.writeFileSync(path.join(outboxDir, "t-BBBB-a_b.txt"), "TWO");
    expect(resolveDeliveryArtifactPath({ outboxDir, name: "a b.txt" })).toBeNull();
    expect(resolveDeliveryArtifactPath({ outboxDir, name: "a?b.txt" })).toBeNull();
  });
});

/* ==================== R2.6 dir fsync fallback classification ============= */
describe("R2-F directory fsync error classification", () => {
  const injectDirFsync = (err: NodeJS.ErrnoException) => {
    const origOpen = fs.openSync;
    const origFsync = fs.fsyncSync;
    vi.spyOn(fs, "openSync").mockImplementation(((pth: unknown, ...rest: unknown[]) => {
      const s = String(pth);
      if (rest.length === 0 || (typeof rest[0] === "number" && (rest[0] & fs.constants.O_DIRECTORY))) {
        throw err;
      }
      return (origOpen as (...a: unknown[]) => unknown).call(fs, pth, ...rest);
    }) as typeof fs.openSync);
    void origFsync;
  };
  const tryAccept = (ctx: ReturnType<typeof mkCtx>, eid: string) =>
    run(() =>
      ctx.authority.accept({
        execution_id: eid,
        producer_executor_id: EX,
        logical_name: "a.txt",
        source: { kind: "buffer", bytes: Buffer.from("BLOB") },
        channel: "REMOTE_UPLOAD",
        actor: "T",
      }),
    );

  it("R2-F1 documented unsupported dir fsync (EINVAL) → fallback, accept ok", () => {
    const ctx = mkCtx("f1");
    const p = mkProducer(ctx);
    injectDirFsync(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    expect(tryAccept(ctx, p.eid)).toBe("NO_THROW");
  });
  it("R2-F2 EIO on dir fsync → FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY", () => {
    const ctx = mkCtx("f2");
    const p = mkProducer(ctx);
    injectDirFsync(Object.assign(new Error("io error"), { code: "EIO" }));
    expect(tryAccept(ctx, p.eid)).toBe("FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });
  it("R2-F3 arbitrary unexpected error → FAIL CLOSED", () => {
    const ctx = mkCtx("f3");
    const p = mkProducer(ctx);
    injectDirFsync(Object.assign(new Error("weird"), { code: "EWEIRD" }));
    expect(tryAccept(ctx, p.eid)).toBe("FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY");
  });
});

/* ==================== R2.7 true multi-process races ====================== */
const WORKER = path.join(__dirname, "fixtures", "f1-worker-accept.cjs");
const DIST_INDEX = path.resolve(__dirname, "..", "..", "dist", "pair", "index.js");

/** Seed `count` canonical artifacts via buffer sources. */
function seedArts(
  ctx: ReturnType<typeof mkCtx>,
  eid: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    ctx.authority.accept({
      execution_id: eid,
      producer_executor_id: EX,
      logical_name: `seed-${i}.bin`,
      source: { kind: "buffer", bytes: Buffer.from(`seed-${i}`) },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
  }
}

describe("R2-G true multi-process count races", () => {
  it("R2-G1 31 + 2 real processes → exactly 32", async () => {
    const ctx = mkCtx("g1");
    const p = mkProducer(ctx);
    seedArts(ctx, p.eid, 31);
    const src1 = path.join(ctx.workspace, "r1.bin");
    const src2 = path.join(ctx.workspace, "r2.bin");
    fs.writeFileSync(src1, "R1");
    fs.writeFileSync(src2, "R2");
    const go = path.join(ctx.d, "go");
    const pending = [
      raceWorker(ctx, p.eid, "r1.bin", src1, go),
      raceWorker(ctx, p.eid, "r2.bin", src2, go),
    ];
    // small settle so both children are blocked on the barrier
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(go, "");
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && String(r.code).includes("COUNT"))).toHaveLength(1);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(32);
  }, 90000);

  it("R2-G2 30 + 3 real processes → exactly 32", async () => {
    const ctx = mkCtx("g2");
    const p = mkProducer(ctx);
    seedArts(ctx, p.eid, 30);
    const files = ["x1.bin", "x2.bin", "x3.bin"].map((f) => {
      const fp = path.join(ctx.workspace, f);
      fs.writeFileSync(fp, f);
      return fp;
    });
    const go = path.join(ctx.d, "go");
    const pending = files.map((f) => raceWorker(ctx, p.eid, path.basename(f), f, go));
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(go, "");
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(32);
  }, 90000);

  it("R2-G3 same identity + same bytes competing → one authority, convergence", async () => {
    const ctx = mkCtx("g3");
    const p = mkProducer(ctx);
    const src1 = path.join(ctx.workspace, "dup1.bin");
    const src2 = path.join(ctx.workspace, "dup2.bin");
    fs.writeFileSync(src1, "SAME");
    fs.writeFileSync(src2, "SAME");
    const go = path.join(ctx.d, "go");
    const pending = [
      raceWorker(ctx, p.eid, "dup.bin", src1, go),
      raceWorker(ctx, p.eid, "dup.bin", src2, go),
    ];
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(go, "");
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(
      ctx.authority.forExecution(p.eid).filter((a) => a.logical_name === "dup.bin"),
    ).toHaveLength(1);
  }, 90000);

  it("R2-G4 same identity + different bytes competing → one authority + conflict", async () => {
    const ctx = mkCtx("g4");
    const p = mkProducer(ctx);
    const src1 = path.join(ctx.workspace, "c1.bin");
    const src2 = path.join(ctx.workspace, "c2.bin");
    fs.writeFileSync(src1, "AAA");
    fs.writeFileSync(src2, "BBB");
    const go = path.join(ctx.d, "go");
    const pending = [
      raceWorker(ctx, p.eid, "conflict.bin", src1, go),
      raceWorker(ctx, p.eid, "conflict.bin", src2, go),
    ];
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(go, "");
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const rows = ctx.authority
      .forExecution(p.eid)
      .filter((a) => a.logical_name === "conflict.bin");
    expect(rows).toHaveLength(1);
    expect(["AAA", "BBB"]).toContain(
      fs.readFileSync(blobPath(ctx, String(rows[0].sha256))!).toString(),
    );
  }, 90000);
});

/** Spawn ONE worker process blocked on `go` file; returns a promise of
 *  its JSON result. */
function raceWorker(
  ctx: ReturnType<typeof mkCtx>,
  eid: string,
  name: string,
  src: string,
  go: string,
): Promise<{ ok: boolean; replayed?: boolean; code?: string }> {
  const out = path.join(ctx.d, `w-${seq++}.json`);
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [
        WORKER,
        DIST_INDEX,
        path.join(ctx.d, "pair.db"),
        path.join(ctx.d, "artifacts", "blobs"),
        eid,
        EX,
        name,
        src,
        go,
        out,
      ],
      { timeout: 60000 },
      () => {
        try {
          resolve(JSON.parse(fs.readFileSync(out, "utf8")));
        } catch {
          resolve({ ok: false, code: "WORKER_NO_RESULT" });
        }
      },
    );
    child.on("error", () => resolve({ ok: false, code: "WORKER_SPAWN_FAIL" }));
  });
}
