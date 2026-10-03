/**
 * Phase F1 — canonical artifact authority foundation.
 *
 * Proves the ONE-ingest-seam architecture: execution-scoped capability
 * uploads, CAS byte retention, deterministic replay identity, crash-safe
 * staging, bounds, and legacy path-only semantics. Adapter-level truth
 * stays at `result.artifacts` — canonical ART_* rows are PAIR-side
 * authority (§7 remote contract).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactAuthority,
  ArtifactProvenanceValidator,
  canonicalArtifactId,
  IntegrityError,
  MAX_ARTIFACT_BYTES,
  mintArtifactCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  sha256Hex,
  utcnow,
  workerExecutionId,
  ARTIFACT_CONTRACT,
} from "../pair/index.js";
import { createMissionControlServer } from "../pair/mission-control-server.js";
import type { Server } from "node:http";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f1-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const MASTER = "artifact-master-secret";
const EX = "EX_TEST";

function mkCtx(name: string) {
  const d = dir(name);
  const workspace = path.join(d, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const authority = new ArtifactAuthority(store, { blobDir: path.join(d, "artifacts", "blobs") });
  const control = new MissionControl({ service } as never);
  const project = service.createProject({ name: "p", root_location: workspace });
  const mission = service.createMission({
    project_id: String(project.project_id),
    goal: "f1 test",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [workspace],
  });
  return { d, workspace, store, service, authority, control, missionId: String(mission.mission_id) };
}

/** Minimal canonical producer chain — the same rows the governed gate
 *  persists at dispatch (mission/task/governed_task/executor_execution). */
let producerSeq = 0;
function mkProducer(
  ctx: ReturnType<typeof mkCtx>,
  opts: { state?: string; result?: Record<string, unknown> | null; executor?: string } = {},
) {
  const tid = `TSK_${producerSeq++}_${ctx.missionId.slice(-6)}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(opts.executor ?? EX, gtId);
  ctx.store.put("task", tid, { task_id: tid, mission_id: ctx.missionId, version: 0 }, 0);
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: ctx.missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: opts.executor ?? EX,
    workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  const exec: Record<string, unknown> = {
    execution_id: eid, governed_task_id: gtId, mission_id: ctx.missionId,
    task_id: tid, executor_id: opts.executor ?? EX, correlation_id: `COR_${tid}`,
    execution_state: opts.state ?? "RUNNING", dispatch_timestamp: utcnow(),
    workspace: ctx.workspace, version: 0,
  };
  if (opts.result !== undefined && opts.result !== null) exec.result = opts.result;
  ctx.store.put("executor_execution", eid, exec, 0);
  return { tid, gtId, eid, executor: opts.executor ?? EX };
}

const cap = (c: { eid: string; gtId: string; tid: string; executor: string; missionId: string }) =>
  mintArtifactCapability(MASTER, {
    mission_id: c.missionId, task_id: c.tid, governed_task_id: c.gtId,
    execution_id: c.eid, executor_id: c.executor,
  });

const code = (e: unknown) => (e instanceof IntegrityError ? e.code : `NOT_INTEGRITY:${e}`);

async function withServer(
  control: MissionControl,
  fn: (port: number) => Promise<void>,
  opts: { outboxToken?: string; artifactUploadToken?: string } = {},
): Promise<void> {
  const server: Server = createMissionControlServer({
    control,
    outboxToken: opts.outboxToken,
    artifactUploadToken: opts.artifactUploadToken,
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as { port: number }).port;
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => vi.restoreAllMocks());

describe("F1-A local canonical artifact ingest", () => {
  it("A1 validator ingests workspace bytes into CAS + binds full identity", () => {
    const ctx = mkCtx("a1");
    const prod = mkProducer(ctx, {
      state: "COMPLETED",
      result: { status: "COMPLETED", artifacts: [{ path: "out.txt" }] },
    });
    fs.writeFileSync(path.join(ctx.workspace, "out.txt"), "local-bytes-A");
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, prod.eid) as Record<
      string,
      unknown
    >;
    expect(v.status).toBe("PASS");
    const rows = ctx.authority.forExecution(prod.eid);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.mission_id).toBe(ctx.missionId);
    expect(a.task_id).toBe(prod.tid);
    expect(a.governed_task_id).toBe(prod.gtId);
    expect(a.producer_executor_id).toBe(EX);
    expect(a.contract).toBe(ARTIFACT_CONTRACT);
    expect(a.state).toBe("ACCEPTED");
    expect(a.sha256).toBe(sha256Hex(Buffer.from("local-bytes-A")));
    const blob = fs.readFileSync(path.join(ctx.d, "artifacts", "blobs", String(a.sha256)));
    expect(blob.equals(Buffer.from("local-bytes-A"))).toBe(true);
    expect((v.artifact_ids as string[])[0]).toBe(a.artifact_id);
  });

  it("A2 declared sha mismatch → FAIL, no artifact row", () => {
    const ctx = mkCtx("a2");
    const prod = mkProducer(ctx, {
      state: "COMPLETED",
      result: { status: "COMPLETED", artifacts: [{ path: "out.txt", sha256: "0".repeat(64) }] },
    });
    fs.writeFileSync(path.join(ctx.workspace, "out.txt"), "real");
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, prod.eid);
    expect(v.status).toBe("FAIL");
    expect(ctx.authority.forExecution(prod.eid)).toHaveLength(0);
  });

  it("A3 source mutation after acceptance never mutates canonical bytes", () => {
    const ctx = mkCtx("a3");
    const prod = mkProducer(ctx);
    const p = path.join(ctx.workspace, "art.bin");
    fs.writeFileSync(p, "v1");
    const r = ctx.authority.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "art.bin",
      source: { kind: "path", path: p }, channel: "LOCAL_EXECUTION", actor: "TEST",
      allow_post_result: true,
    });
    fs.writeFileSync(p, "v2-mutated");
    const a = r.artifact;
    const blob = fs.readFileSync(path.join(ctx.d, "artifacts", "blobs", String(a.sha256)));
    expect(blob.equals(Buffer.from("v1"))).toBe(true);
    expect(String(a.sha256)).toBe(sha256Hex(Buffer.from("v1")));
  });
});

describe("F1-B remote capability ingest", () => {
  it("B1 valid execution-scoped capability → canonical ART row", () => {
    const ctx = mkCtx("b1");
    const prod = mkProducer(ctx);
    const r = ctx.control.acceptArtifactUpload(MASTER, cap({ ...prod, missionId: ctx.missionId }), {
      filename: "report.pdf",
      mission_id: ctx.missionId,
      task_id: prod.tid,
      bytes: Buffer.from("remote-bytes"),
    });
    expect(r.replayed).toBe(false);
    const a = r.artifact;
    expect(String(a.artifact_id)).toBe(canonicalArtifactId(prod.eid, "report.pdf"));
    expect(a.ingested_via).toBe("REMOTE_UPLOAD");
    expect(fs.existsSync(path.join(ctx.d, "artifacts", "blobs", String(a.sha256)))).toBe(true);
  });

  it("B2 body identity must equal capability claims (mission/task mismatch rejected)", () => {
    const ctx = mkCtx("b2");
    const prod = mkProducer(ctx);
    const c = cap({ ...prod, missionId: ctx.missionId });
    expect(() =>
      ctx.control.acceptArtifactUpload(MASTER, c, {
        filename: "x.txt", mission_id: "MSN_OTHER", task_id: prod.tid, bytes: Buffer.from("x"),
      }),
    ).toThrowError(/CAPABILITY_MISMATCH/);
    expect(ctx.store.list("artifact")).toHaveLength(0);
  });

  it("B3 forged signature / tampered claims rejected", () => {
    const ctx = mkCtx("b3");
    const prod = mkProducer(ctx);
    const c = cap({ ...prod, missionId: ctx.missionId });
    const tampered = c.replace(/.$/, c.endsWith("a") ? "b" : "a");
    expect(() =>
      ctx.control.acceptArtifactUpload(MASTER, tampered, {
        filename: "x.txt", bytes: Buffer.from("x"),
      }),
    ).toThrowError(/CAPABILITY_INVALID/);
  });

  it("B4 wrong executor / wrong execution / terminal execution rejected", () => {
    const ctx = mkCtx("b4");
    const prod = mkProducer(ctx);
    // capability claims a different executor → PRODUCER_MISMATCH
    const badExec = mintArtifactCapability(MASTER, {
      mission_id: ctx.missionId, task_id: prod.tid, governed_task_id: prod.gtId,
      execution_id: prod.eid, executor_id: "EX_OTHER",
    });
    expect(code(
      (() => {
        try {
          ctx.control.acceptArtifactUpload(MASTER, badExec, { filename: "x", bytes: Buffer.from("x") });
        } catch (e) { return e; }
      })(),
    )).toBe("NOT_INTEGRITY:PolicyError: FAIL_CLOSED_ARTIFACT_CAPABILITY_MISMATCH:durable_identity");
    // unknown execution
    const badEid = mintArtifactCapability(MASTER, {
      mission_id: ctx.missionId, task_id: prod.tid, governed_task_id: prod.gtId,
      execution_id: "EXE_UNKNOWN", executor_id: EX,
    });
    expect(code(
      (() => { try { ctx.control.acceptArtifactUpload(MASTER, badEid, { filename: "x", bytes: Buffer.from("x") }); } catch (e) { return e; } })(),
    )).toBe("NOT_INTEGRITY:PolicyError: FAIL_CLOSED_ARTIFACT_CAPABILITY_MISMATCH:durable_identity");
    // terminal execution
    const dead = mkProducer(ctx, { state: "FAILED" });
    expect(code(
      (() => { try { ctx.control.acceptArtifactUpload(MASTER, cap({ ...dead, missionId: ctx.missionId }), { filename: "x", bytes: Buffer.from("x") }); } catch (e) { return e; } })(),
    )).toBe("FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED");
    // result already persisted — remote upload window is closed
    const settled = mkProducer(ctx, { state: "COMPLETED", result: { status: "COMPLETED" } });
    expect(code(
      (() => { try { ctx.control.acceptArtifactUpload(MASTER, cap({ ...settled, missionId: ctx.missionId }), { filename: "x", bytes: Buffer.from("x") }); } catch (e) { return e; } })(),
    )).toBe("FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED");
  });

  it("B5 generic outbox token alone never mints canonical authority", async () => {
    const ctx = mkCtx("b5");
    await withServer(
      ctx.control,
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-outbox-token": "outtok" },
          body: JSON.stringify({
            mission_id: ctx.missionId, task_id: "T", filename: "f.txt",
            data_base64: Buffer.from("legacy").toString("base64"),
          }),
        });
        const j = (await res.json()) as Record<string, unknown>;
        expect(res.status).toBe(200);
        expect(j.canonical).toBe(false);
        expect(ctx.store.list("artifact")).toHaveLength(0);
        // file still landed in the project outbox (storage-only)
        const outbox = fs.readdirSync(path.join(ctx.workspace, "outbox"));
        expect(outbox).toContain("T-f.txt");
      },
      { outboxToken: "outtok", artifactUploadToken: MASTER },
    );
  });

  it("B6 capability upload endpoint → canonical row + outbox materialization", async () => {
    const ctx = mkCtx("b6");
    const prod = mkProducer(ctx);
    await withServer(
      ctx.control,
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-artifact-capability": cap({ ...prod, missionId: ctx.missionId }),
          },
          body: JSON.stringify({
            mission_id: ctx.missionId, task_id: prod.tid, filename: "chart.png",
            data_base64: Buffer.from("PNGDATA").toString("base64"),
          }),
        });
        const j = (await res.json()) as Record<string, unknown>;
        expect(res.status).toBe(200);
        expect(j.artifact_id).toBe(canonicalArtifactId(prod.eid, "chart.png"));
        expect(j.sha256).toBe(sha256Hex(Buffer.from("PNGDATA")));
        // R1.8 — no host path in the response; logical refs only.
        expect(j.path).toBeUndefined();
        expect(String(j.storage_ref)).toBe(`pair-artifact://sha256/${String(j.sha256)}`);
        expect(j.materialized).toBe(true);
        // compat materialization: unique `<taskPrefix>-<frag>-<basename>`
        const outboxFiles = fs.readdirSync(path.join(ctx.workspace, "outbox"));
        expect(outboxFiles).toHaveLength(1);
        expect(outboxFiles[0]!.endsWith("-chart.png")).toBe(true);
        expect(
          fs
            .readFileSync(path.join(ctx.workspace, "outbox", outboxFiles[0]!))
            .equals(Buffer.from("PNGDATA")),
        ).toBe(true);
        // read model
        const list = await fetch(`http://127.0.0.1:${port}/api/artifacts?mission_id=${ctx.missionId}`);
        const jl = (await list.json()) as { artifacts: Array<Record<string, unknown>> };
        expect(jl.artifacts).toHaveLength(1);
        expect(jl.artifacts[0]!.canonical).toBe(true);
        expect(jl.artifacts[0]!.storage_ref).toBe(`pair-artifact://sha256/${j.sha256}`);
      },
      { artifactUploadToken: MASTER },
    );
  });
});

describe("F1-C/D mutation + replay/concurrency", () => {
  it("D1 same upload replayed → idempotent, single ART row", () => {
    const ctx = mkCtx("d1");
    const prod = mkProducer(ctx);
    const c = cap({ ...prod, missionId: ctx.missionId });
    const r1 = ctx.control.acceptArtifactUpload(MASTER, c, { filename: "f.txt", bytes: Buffer.from("same") });
    const r2 = ctx.control.acceptArtifactUpload(MASTER, c, { filename: "f.txt", bytes: Buffer.from("same") });
    expect(r2.replayed).toBe(true);
    expect(r1.artifact.artifact_id).toBe(r2.artifact.artifact_id);
    expect(ctx.store.list("artifact")).toHaveLength(1);
  });

  it("D2 same identity + different bytes → fail closed, original kept", () => {
    const ctx = mkCtx("d2");
    const prod = mkProducer(ctx);
    const c = cap({ ...prod, missionId: ctx.missionId });
    ctx.control.acceptArtifactUpload(MASTER, c, { filename: "f.txt", bytes: Buffer.from("v1") });
    const e = (() => {
      try {
        ctx.control.acceptArtifactUpload(MASTER, c, { filename: "f.txt", bytes: Buffer.from("v2") });
      } catch (x) { return x; }
    })();
    expect(code(e)).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
    const a = ctx.store.list("artifact")[0]!;
    expect(String(a.sha256)).toBe(sha256Hex(Buffer.from("v1")));
  });

  it("D3 concurrent duplicate across separate store connections converges", () => {
    const ctx = mkCtx("d3");
    const prod = mkProducer(ctx);
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, { blobDir: path.join(ctx.d, "artifacts", "blobs") });
    const args = {
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "f.txt",
      source: { kind: "buffer", bytes: Buffer.from("dup") } as const,
      channel: "REMOTE_UPLOAD" as const, actor: "T", allow_post_result: false,
    };
    const r1 = ctx.authority.accept(args);
    const r2 = auth2.accept(args);
    expect(r2.replayed).toBe(true);
    expect(r1.artifact.artifact_id).toBe(r2.artifact.artifact_id);
    expect(ctx.store.list("artifact")).toHaveLength(1);
    store2.close();
  });
});

describe("F1-E crash/restart convergence", () => {
  it("E1 orphan blob .tmp cleaned; blob pre-existence is reused not re-baselined", () => {
    const ctx = mkCtx("e1");
    const prod = mkProducer(ctx);
    const blobDir = path.join(ctx.d, "artifacts", "blobs");
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, `orphan.tmp-1-zzz`), "junk");
    const r = ctx.authority.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "f.txt",
      source: { kind: "buffer", bytes: Buffer.from("data") }, channel: "REMOTE_UPLOAD",
      actor: "T", allow_post_result: false,
    });
    expect(ctx.authority.sweepTmp()).toBe(1);
    expect(fs.existsSync(path.join(blobDir, String(r.artifact.sha256)))).toBe(true);
  });

  it("E2 restart: fresh store + authority reconstruct identical references", () => {
    const ctx = mkCtx("e2");
    const prod = mkProducer(ctx);
    const r1 = ctx.authority.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "f.txt",
      source: { kind: "buffer", bytes: Buffer.from("persist") }, channel: "REMOTE_UPLOAD",
      actor: "T", allow_post_result: false,
    });
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, { blobDir: path.join(ctx.d, "artifacts", "blobs") });
    const rows = auth2.forExecution(prod.eid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.artifact_id).toBe(r1.artifact.artifact_id);
    const r2 = auth2.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "f.txt",
      source: { kind: "buffer", bytes: Buffer.from("persist") }, channel: "REMOTE_UPLOAD",
      actor: "T", allow_post_result: false,
    });
    expect(r2.replayed).toBe(true);
    store2.close();
  });
});

describe("F1-F bounds", () => {
  it("F1 oversized buffer rejected before ingest + evidence written", () => {
    const ctx = mkCtx("f1");
    const prod = mkProducer(ctx);
    const small = new ArtifactAuthority(ctx.store, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"), maxBytes: 16,
    });
    const e = (() => {
      try {
        small.accept({
          execution_id: prod.eid, producer_executor_id: EX, logical_name: "big.bin",
          source: { kind: "buffer", bytes: Buffer.alloc(17, 7) }, channel: "REMOTE_UPLOAD",
          actor: "T", allow_post_result: false,
        });
      } catch (x) { return x; }
    })();
    expect(code(e)).toBe("FAIL_CLOSED_ARTIFACT_TOO_LARGE");
    const rej = ctx.store
      .listEvents("executor_execution", prod.eid)
      .filter((x) => x.event_type === "ARTIFACT_REJECTED");
    expect(rej).toHaveLength(1);
    expect(ctx.store.listEvidence(ctx.missionId).some((x) => x.kind === "ARTIFACT_REJECTED")).toBe(true);
  });

  it("F2 oversized path source rejected WITHOUT any full-file read", () => {
    const ctx = mkCtx("f2");
    const prod = mkProducer(ctx);
    const sparse = path.join(ctx.workspace, "sparse.bin");
    fs.writeFileSync(sparse, "");
    fs.truncateSync(sparse, MAX_ARTIFACT_BYTES + 1);
    const spy = vi.spyOn(fs, "readFileSync");
    const e = (() => {
      try {
        ctx.authority.accept({
          execution_id: prod.eid, producer_executor_id: EX, logical_name: "sparse.bin",
          source: { kind: "path", path: sparse }, channel: "LOCAL_EXECUTION",
          actor: "T", allow_post_result: true,
        });
      } catch (x) { return x; }
    })();
    expect(code(e)).toBe("FAIL_CLOSED_ARTIFACT_TOO_LARGE");
    expect(spy.mock.calls.filter((c) => String(c[0]) === sparse)).toHaveLength(0);
  });

  it("F3 empty + traversal + absolute + backslash names rejected", () => {
    const ctx = mkCtx("f3");
    const prod = mkProducer(ctx);
    const base = {
      execution_id: prod.eid, producer_executor_id: EX, source: { kind: "buffer", bytes: Buffer.from("x") } as const,
      channel: "REMOTE_UPLOAD" as const, actor: "T", allow_post_result: false,
    };
    expect(code((() => { try { ctx.authority.accept({ ...base, logical_name: "../x", }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_NAME_INVALID");
    expect(code((() => { try { ctx.authority.accept({ ...base, logical_name: "/abs/x", }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_NAME_INVALID");
    expect(code((() => { try { ctx.authority.accept({ ...base, logical_name: "a/../b", }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_NAME_INVALID");
    expect(code((() => { try { ctx.authority.accept({ ...base, logical_name: "a\\b", }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_NAME_INVALID");
    expect(code((() => { try { ctx.authority.accept({ ...base, logical_name: "", }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_NAME_INVALID");
    expect(code((() => { try { ctx.authority.accept({ ...base, source: { kind: "buffer", bytes: Buffer.alloc(0) }, logical_name: "e.bin" }); } catch (e) { return e; } })())).toBe("FAIL_CLOSED_ARTIFACT_EMPTY");
  });

  it("F4 per-execution count cap enforced", () => {
    const ctx = mkCtx("f4");
    const prod = mkProducer(ctx);
    const small = new ArtifactAuthority(ctx.store, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"), maxPerExecution: 2,
    });
    for (let i = 0; i < 2; i++) {
      small.accept({
        execution_id: prod.eid, producer_executor_id: EX, logical_name: `f${i}`,
        source: { kind: "buffer", bytes: Buffer.from(`v${i}`) }, channel: "REMOTE_UPLOAD",
        actor: "T", allow_post_result: false,
      });
    }
    const e = (() => {
      try {
        small.accept({
          execution_id: prod.eid, producer_executor_id: EX, logical_name: "f2",
          source: { kind: "buffer", bytes: Buffer.from("v2") }, channel: "REMOTE_UPLOAD",
          actor: "T", allow_post_result: false,
        });
      } catch (x) { return x; }
    })();
    expect(code(e)).toBe("FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED");
    // replay of an existing name never counts against the cap
    const again = small.accept({
      execution_id: prod.eid, producer_executor_id: EX, logical_name: "f0",
      source: { kind: "buffer", bytes: Buffer.from("v0") }, channel: "REMOTE_UPLOAD",
      actor: "T", allow_post_result: false,
    });
    expect(again.replayed).toBe(true);
  });

  it("F5 symlink source rejected (no symlink escape)", () => {
    const ctx = mkCtx("f5");
    const prod = mkProducer(ctx);
    const target = path.join(ctx.workspace, "real.txt");
    fs.writeFileSync(target, "real");
    const link = path.join(ctx.workspace, "link.txt");
    fs.symlinkSync(target, link);
    const e = (() => {
      try {
        ctx.authority.accept({
          execution_id: prod.eid, producer_executor_id: EX, logical_name: "link.txt",
          source: { kind: "path", path: link }, channel: "LOCAL_EXECUTION",
          actor: "T", allow_post_result: true,
        });
      } catch (x) { return x; }
    })();
    expect(code(e)).toBe("FAIL_CLOSED_ARTIFACT_SYMLINK");
  });
});

describe("F1-G legacy semantics", () => {
  it("G1 pre-F1 path-only row stays inspectable, never gains canonical authority", () => {
    const ctx = mkCtx("g1");
    ctx.store.put("artifact", "ART_LEGACY", {
      artifact_id: "ART_LEGACY", execution_id: "EXE_OLD", mission_id: ctx.missionId,
      task_id: "T", path: "out/legacy.txt", sha256: "a".repeat(64), byte_size: 10,
      created_at: utcnow(), version: 0,
    }, 0);
    const proj = ctx.control.artifact("ART_LEGACY")!;
    expect(proj.canonical).toBe(false);
    expect(proj.state).toBe("LEGACY_PATH_ONLY");
    expect(proj.storage_ref).toBeNull();
    expect(ctx.control.artifacts(ctx.missionId)).toHaveLength(1);
  });
});
