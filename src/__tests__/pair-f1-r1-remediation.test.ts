/**
 * F1 R1 — permanent adversarial regression suite.
 *
 * Promotes every clean-room-audit counterexample into shipped coverage:
 *   R1-A*  atomic artifact-count authority (multi-connection writers)
 *   R1-B*  real filesystem containment (parent/nested symlink escapes)
 *   R1-C*  bounded HTTP request ingestion (wire-level, pre-materialization)
 *   R1-D*  closed-lifecycle exact replay convergence
 *   R1-E   capability claims ↔ durable identity cross-check
 *   R1-F*  local validator batch atomicity
 *   R1-G*  outbox compat materialization collision / tmp uniqueness
 *   R1-H   no host-path disclosure in canonical API response
 *   R1-I   CAS rename directory-durability (dir fsync executed)
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactAuthority,
  ArtifactProvenanceValidator,
  canonicalArtifactId,
  IntegrityError,
  mintArtifactCapability,
  mintBrokerCapability,
  verifyArtifactCapability,
  verifyBrokerCapability,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  digest,
  sha256Hex,
  utcnow,
  workerExecutionId,
  MAX_ARTIFACT_BYTES,
} from "../pair/index.js";
import { createMissionControlServer } from "../pair/mission-control-server.js";
import type { Server } from "node:http";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f1-r1-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const MASTER = "r1-master";
const EX = "EX_R1";

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
    goal: "r1",
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
  opts: { state?: string; result?: Record<string, unknown> | null } = {},
) {
  const tid = `ATSK_${seq++}`;
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
      executor_id: EX,
      plan_id: "PLAN_ANCHOR",
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
    // F5 R1.B — mirror the production mint anchor for a local task.
    const governed = ctx.store.get("governed_task", gtId);
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
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: ctx.missionId, task_id: tid, executor_id: EX,
        governed_task_id: gtId, plan_id: "PLAN_ANCHOR", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: false,
        declared_produces: null,
        declared_produces_digest: null,
      },
    });
    ctx.store.appendEvidence(ctx.missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: EX,
      mission_id: ctx.missionId,
      plan_id: "PLAN_ANCHOR", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: false,
      declared_produces: null,
      declared_produces_digest: null,
    });
  }
  const exec: Record<string, unknown> = {
    execution_id: eid,
    governed_task_id: gtId,
    mission_id: ctx.missionId,
    task_id: tid,
    executor_id: EX,
    plan_id: "PLAN_ANCHOR",
    plan_revision: 1,
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

/** Run a thunk, return the IntegrityError code or the raw error text
 *  (PolicyError carries its FAIL_CLOSED_* code in the message). */
const run = (f: () => unknown): string => {
  try {
    f();
    return "NO_THROW";
  } catch (e) {
    return e instanceof IntegrityError ? e.code : `NOT_INTEGRITY:${String(e)}`;
  }
};

function capFor(prod: { tid: string; gtId: string; eid: string }, missionId: string) {
  return mintArtifactCapability(MASTER, {
    mission_id: missionId,
    task_id: prod.tid,
    governed_task_id: prod.gtId,
    execution_id: prod.eid,
    executor_id: EX,
  });
}

async function withServer(
  control: MissionControl,
  fn: (port: number) => Promise<void>,
  deps: { outboxToken?: string; artifactUploadToken?: string } = {},
) {
  const server: Server = createMissionControlServer({
    control,
    outboxToken: deps.outboxToken,
    artifactUploadToken: deps.artifactUploadToken,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Raw socket request — needed to control Content-Length / chunking
 *  independently of what fetch() would serialize. */
function rawPost(
  port: number,
  opts: { headers: string[]; bodyChunks: Buffer[]; path?: string },
): Promise<{ status: number; bytes: Buffer; reset: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (status: number, reset: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ status, bytes: Buffer.concat(chunks), reset });
    };
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST ${opts.path ?? "/api/outbox"} HTTP/1.1\r\nHost: 127.0.0.1\r\n${opts.headers.join("\r\n")}\r\n\r\n`,
      );
      for (const c of opts.bodyChunks) sock.write(c);
      sock.end();
    });
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () =>
      done(Number(Buffer.concat(chunks).toString("utf8").slice(9, 12)), false),
    );
    sock.on("close", () => done(0, false));
    // ECONNRESET mid-upload is itself evidence of a bounded abort —
    // the server refused to consume the rest of the stream.
    sock.on("error", (e) => done(-1, String(e).includes("ECONNRESET") || true));
    setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      done(0, false);
    }, 15000);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================ R1-A count race ============================ */
describe("R1-A atomic artifact count authority", () => {
  it("R1-A1 31 existing + 2 concurrent distinct writers → final <=32", () => {
    const ctx = mkCtx("a1");
    const p = mkProducer(ctx);
    for (let i = 0; i < 31; i++) {
      fs.writeFileSync(path.join(ctx.workspace, `s${i}.txt`), `S${i}`);
      ctx.authority.accept({
        execution_id: p.eid,
        producer_executor_id: EX,
        logical_name: `s${i}.txt`,
        source: { kind: "path", path: path.join(ctx.workspace, `s${i}.txt`) },
        channel: "LOCAL_EXECUTION",
        actor: "T",
        allow_post_result: true,
      });
    }
    // A SECOND store connection — a genuinely separate writer sharing
    // the same durable db (process-equivalent concurrency).
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"),
    });
    fs.writeFileSync(path.join(ctx.workspace, "n31.txt"), "N31");
    fs.writeFileSync(path.join(ctx.workspace, "n32.txt"), "N32");
    const acceptArgs = (name: string) => ({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: name,
      source: { kind: "path" as const, path: path.join(ctx.workspace, name) },
      channel: "LOCAL_EXECUTION" as const,
      actor: "T",
      allow_post_result: true,
    });
    // Writer 1 commits first; writer 2's pre-read count (31) is stale —
    // its in-transaction recount sees 32 and must fail closed.
    ctx.authority.accept(acceptArgs("n31.txt"));
    expect(run(() => auth2.accept(acceptArgs("n32.txt")))).toBe(
      "FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED",
    );
    expect(
      ctx.authority.forExecution(p.eid).filter((a) => a.contract === "pair-artifact.v1"),
    ).toHaveLength(32);
    store2.close();
  });

  it("R1-A2 30 existing + 3 concurrent distinct writers → final <=32", () => {
    const ctx = mkCtx("a2");
    const p = mkProducer(ctx);
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(ctx.workspace, `s${i}.txt`), `S${i}`);
      ctx.authority.accept({
        execution_id: p.eid,
        producer_executor_id: EX,
        logical_name: `s${i}.txt`,
        source: { kind: "path", path: path.join(ctx.workspace, `s${i}.txt`) },
        channel: "LOCAL_EXECUTION",
        actor: "T",
        allow_post_result: true,
      });
    }
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"),
    });
    const names = ["w1.txt", "w2.txt", "w3.txt"];
    for (const nm of names) fs.writeFileSync(path.join(ctx.workspace, nm), nm);
    const writers = [ctx.authority, auth2, ctx.authority];
    const results = names.map((nm, i) => {
      try {
        writers[i]!.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: nm,
          source: { kind: "path", path: path.join(ctx.workspace, nm) },
          channel: "LOCAL_EXECUTION",
          actor: "T",
          allow_post_result: true,
        });
        return "ok";
      } catch (e) {
        return e instanceof IntegrityError ? e.code : `NOT_INTEGRITY:${String(e)}`;
      }
    });
    expect(results.filter((r) => r === "ok")).toHaveLength(2);

    expect(results).toContain("FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(32);
    store2.close();
  });

  it("R1-A3 same identity + same bytes on two connections → one authority", () => {
    const ctx = mkCtx("a3");
    const p = mkProducer(ctx);
    fs.writeFileSync(path.join(ctx.workspace, "dup.txt"), "DUP");
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"),
    });
    const args = {
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "dup.txt",
      source: { kind: "path" as const, path: path.join(ctx.workspace, "dup.txt") },
      channel: "LOCAL_EXECUTION" as const,
      actor: "T",
      allow_post_result: true,
    };
    ctx.authority.accept(args);
    const replay = auth2.accept(args);
    expect(replay.replayed).toBe(true);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(1);
    store2.close();
  });

  it("R1-A4 same identity + conflicting bytes → original preserved, conflict fail-closed", () => {
    const ctx = mkCtx("a4");
    const p = mkProducer(ctx);
    fs.writeFileSync(path.join(ctx.workspace, "c.txt"), "ORIGINAL");
    ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "c.txt",
      source: { kind: "path", path: path.join(ctx.workspace, "c.txt") },
      channel: "LOCAL_EXECUTION",
      actor: "T",
      allow_post_result: true,
    });
    const store2 = new PairEvidenceStore(path.join(ctx.d, "pair.db"));
    const auth2 = new ArtifactAuthority(store2, {
      blobDir: path.join(ctx.d, "artifacts", "blobs"),
    });
    expect(
      run(() =>
        auth2.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "c.txt",
          source: { kind: "buffer", bytes: Buffer.from("DIFFERENT") },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
    const row = ctx.authority.forExecution(p.eid)[0]!;
    expect(row.sha256).toBe(sha256Hex(Buffer.from("ORIGINAL")));
    store2.close();
  });
});

/* ====================== R1-B filesystem containment ====================== */
describe("R1-B real filesystem containment", () => {
  it("R1-B1 parent-directory symlink escape rejected at the seam", () => {
    const ctx = mkCtx("b1");
    const outside = dir("b1-out");
    fs.writeFileSync(path.join(outside, "secret.bin"), "SECRET");
    fs.symlinkSync(outside, path.join(ctx.workspace, "linkdir"));
    const p = mkProducer(ctx);
    // lexical allowed_paths check still passes — the SEAM must catch it.
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "linkdir/secret.bin",
          source: {
            kind: "path",
            path: path.join(ctx.workspace, "linkdir", "secret.bin"),
          },
          channel: "LOCAL_EXECUTION",
          actor: "T",
          allow_post_result: true,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
    // and the validator path must never mint it either
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });

  it("R1-B2 nested parent symlink escape rejected", () => {
    const ctx = mkCtx("b2");
    const outside = dir("b2-out");
    fs.mkdirSync(path.join(outside, "deep"), { recursive: true });
    fs.writeFileSync(path.join(outside, "deep", "s.bin"), "SECRET2");
    // ws/a -> outside ; ws/a/deep/s.bin traverses the symlink
    fs.symlinkSync(outside, path.join(ctx.workspace, "a"));
    const p = mkProducer(ctx);
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: p.eid,
          producer_executor_id: EX,
          logical_name: "a/deep/s.bin",
          source: { kind: "path", path: path.join(ctx.workspace, "a", "deep", "s.bin") },
          channel: "LOCAL_EXECUTION",
          actor: "T",
          allow_post_result: true,
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE");
  });

  it("R1-B3 regular file genuinely inside allowed root passes", () => {
    const ctx = mkCtx("b3");
    fs.mkdirSync(path.join(ctx.workspace, "sub"));
    fs.writeFileSync(path.join(ctx.workspace, "sub", "ok.bin"), "OK");
    const p = mkProducer(ctx);
    const acc = ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "sub/ok.bin",
      source: { kind: "path", path: path.join(ctx.workspace, "sub", "ok.bin") },
      channel: "LOCAL_EXECUTION",
      actor: "T",
      allow_post_result: true,
    });
    expect(acc.artifact.sha256).toBe(sha256Hex(Buffer.from("OK")));
  });
});

/* ===================== R1-C bounded HTTP ingestion ====================== */
describe("R1-C bounded HTTP request ingestion", () => {
  it("R1-C1 oversized Content-Length rejected before body materialization", async () => {
    const ctx = mkCtx("c1");
    const prod = mkProducer(ctx);
    await withServer(
      ctx.control,
      async (port) => {
        const res = await rawPost(port, {
          headers: [
            "content-type: application/json",
            `x-artifact-capability: ${capFor(prod, ctx.missionId)}`,
            // lies: claims ~200MB but only sends a small body — the
            // declared length alone must trigger rejection pre-read.
            `content-length: ${MAX_ARTIFACT_BYTES * 3}`,
          ],
          bodyChunks: [Buffer.from("{\"x\":1}")],
        });
        expect(res.status).toBe(413);
      },
      { artifactUploadToken: MASTER },
    );
  });

  it("R1-C2 chunked oversized body rejected during streaming", async () => {
    const ctx = mkCtx("c2");
    const prod = mkProducer(ctx);
    await withServer(
      ctx.control,
      async (port) => {
        const junk = Buffer.alloc(2 * 1024 * 1024, 0x41);
        const chunks: Buffer[] = [];
        // send ~100MB in chunked encoding — bound is ~89.6MB for the
        // capability lane; the server must abort before the end arrives.
        for (let i = 0; i < 50; i++) {
          chunks.push(
            Buffer.from(`${junk.length.toString(16)}\r\n`),
            junk,
            Buffer.from("\r\n"),
          );
        }
        chunks.push(Buffer.from("0\r\n\r\n"));
        const res = await rawPost(port, {
          headers: [
            "content-type: application/json",
            `x-artifact-capability: ${capFor(prod, ctx.missionId)}`,
            "transfer-encoding: chunked",
          ],
          bodyChunks: chunks,
        });
        // 413 = bounded rejection; ECONNRESET mid-upload = the server
        // aborted the stream before the body finished — either way the
        // body was NOT fully materialized.
        expect(res.status === 413 || res.reset).toBe(true);
      },
      { artifactUploadToken: MASTER },
    );
  });

  it("R1-C3 huge junk JSON field rejected by the legacy-lane wire bound", async () => {
    const ctx = mkCtx("c3");
    await withServer(
      ctx.control,
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-outbox-token": "outtok" },
          // ~13MB junk — legacy wire bound is ~11.6MB
          body: JSON.stringify({
            mission_id: ctx.missionId,
            filename: "t.txt",
            junk: "x".repeat(13 * 1024 * 1024),
            data_base64: Buffer.from("t").toString("base64"),
          }),
        });
        expect(res.status).toBe(413);
      },
      { outboxToken: "outtok" },
    );
  });

  it("R1-C4 in-bound body on the capability lane still handled normally", async () => {
    const ctx = mkCtx("c4");
    const prod = mkProducer(ctx);
    await withServer(
      ctx.control,
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-artifact-capability": capFor(prod, ctx.missionId),
          },
          body: JSON.stringify({
            mission_id: ctx.missionId,
            task_id: prod.tid,
            filename: "ok.bin",
            data_base64: Buffer.from("FINE").toString("base64"),
          }),
        });
        expect(res.status).toBe(200);
      },
      { artifactUploadToken: MASTER },
    );
  });
});

/* ==================== R1-D closed-lifecycle replay ====================== */
describe("R1-D closed-lifecycle exact replay", () => {
  it("R1-D1 accepted upload → response lost → execution closes → exact replay converges", async () => {
    const ctx = mkCtx("d1");
    const prod = mkProducer(ctx);
    const cap = capFor(prod, ctx.missionId);
    await withServer(
      ctx.control,
      async (port) => {
        const body = JSON.stringify({
          mission_id: ctx.missionId,
          task_id: prod.tid,
          filename: "report.md",
          data_base64: Buffer.from("# report").toString("base64"),
        });
        const headers = {
          "content-type": "application/json",
          "x-artifact-capability": cap,
        };
        const r1 = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers,
          body,
        });
        expect(r1.status).toBe(200);
        // response 'lost' — the execution now settles/closes
        ctx.store.put(
          "executor_execution",
          prod.eid,
          {
            ...(ctx.store.get("executor_execution", prod.eid) as Record<string, unknown>),
            execution_state: "COMPLETED",
            result: { status: "COMPLETED" },
          },
          1,
        );
        // exact retry MUST converge to the already-minted authority
        const r2 = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers,
          body,
        });
        const j2 = (await r2.json()) as Record<string, unknown>;
        expect(r2.status).toBe(200);
        expect(j2.replayed).toBe(true);
        expect(j2.artifact_id).toBe(canonicalArtifactId(prod.eid, "report.md"));
        expect(ctx.authority.forExecution(prod.eid)).toHaveLength(1);
      },
      { artifactUploadToken: MASTER },
    );
  });

  it("R1-D2 closed execution → NEW artifact rejected", () => {
    const ctx = mkCtx("d2");
    const prod = mkProducer(ctx);
    ctx.authority.accept({
      execution_id: prod.eid,
      producer_executor_id: EX,
      logical_name: "a.txt",
      source: { kind: "buffer", bytes: Buffer.from("A") },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    ctx.store.put(
      "executor_execution",
      prod.eid,
      {
        ...(ctx.store.get("executor_execution", prod.eid) as Record<string, unknown>),
        result: { status: "COMPLETED" },
      },
      1,
    );
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: prod.eid,
          producer_executor_id: EX,
          logical_name: "brand-new.txt",
          source: { kind: "buffer", bytes: Buffer.from("N") },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED");
  });

  it("R1-D3 closed execution → conflicting bytes rejected as REPLAY_CONFLICT", () => {
    const ctx = mkCtx("d3");
    const prod = mkProducer(ctx);
    ctx.authority.accept({
      execution_id: prod.eid,
      producer_executor_id: EX,
      logical_name: "c.txt",
      source: { kind: "buffer", bytes: Buffer.from("ORIG") },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    ctx.store.put(
      "executor_execution",
      prod.eid,
      {
        ...(ctx.store.get("executor_execution", prod.eid) as Record<string, unknown>),
        result: { status: "COMPLETED" },
      },
      1,
    );
    expect(
      run(() =>
        ctx.authority.accept({
          execution_id: prod.eid,
          producer_executor_id: EX,
          logical_name: "c.txt",
          source: { kind: "buffer", bytes: Buffer.from("CONFLICT") },
          channel: "REMOTE_UPLOAD",
          actor: "T",
        }),
      ),
    ).toBe("FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT");
  });
});

/* ================ R1-E capability claims vs durable ===================== */
describe("R1-E capability claims ↔ durable state", () => {
  it("R1-E mutating each claim independently fails closed", () => {
    const ctx = mkCtx("e");
    const prod = mkProducer(ctx);
    const base = {
      mission_id: ctx.missionId,
      task_id: prod.tid,
      governed_task_id: prod.gtId,
      execution_id: prod.eid,
      executor_id: EX,
    };
    const body = { filename: "x.txt", bytes: Buffer.from("x") };
    const mutations: Array<[string, string]> = [
      ["mission_id", "MSN_WRONG"],
      ["task_id", "TSK_WRONG"],
      ["governed_task_id", "GT_WRONG"],
      ["execution_id", "EXE_WRONG"],
      ["executor_id", "EX_WRONG"],
    ];
    for (const [field, bad] of mutations) {
      const forged = mintArtifactCapability(MASTER, { ...base, [field]: bad });
      expect(
        run(() => ctx.control.acceptArtifactUpload(MASTER, forged, body)),
      ).toContain("CAPABILITY_MISMATCH");
    }
    // correct claims still pass
    const ok = mintArtifactCapability(MASTER, base);
    const acc = ctx.control.acceptArtifactUpload(MASTER, ok, body);
    expect(acc.artifact.artifact_id).toBe(canonicalArtifactId(prod.eid, "x.txt"));
  });

  it("R1-E2 capability domain separation preserved", () => {
    const bcap = mintBrokerCapability("r1-master", {
      execution_id: "X",
      executor_id: "E",
      credential: "c",
    });
    expect(verifyArtifactCapability(MASTER, bcap)).toBeNull();
    const prod = { tid: "t", gtId: "g", eid: "e" };
    const acap = mintArtifactCapability(MASTER, {
      mission_id: "m",
      task_id: prod.tid,
      governed_task_id: prod.gtId,
      execution_id: prod.eid,
      executor_id: "x",
    });
    expect(verifyBrokerCapability("r1-master", acap)).toBeNull();
  });
});

/* ==================== R1-F batch atomicity ============================== */
describe("R1-F local validator batch atomicity", () => {
  it("R1-F1 33-artifact batch → validation FAIL + ZERO new ART rows", () => {
    const ctx = mkCtx("f1");
    const arts = Array.from({ length: 33 }, (_, i) => ({
      path: `a${i}.txt`,
      sha256: sha256Hex(Buffer.from(`a${i}.txt`)),
      byte_size: `a${i}.txt`.length,
    }));
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: { status: "COMPLETED", artifacts: arts },
    });
    for (const a of arts) fs.writeFileSync(path.join(ctx.workspace, a.path), a.path);
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(v.artifact_ids).toEqual([]);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });

  it("R1-F2 late batch conflict → FAIL + earlier artifact NOT minted", () => {
    const ctx = mkCtx("f2");
    const p = mkProducer(ctx, { state: "COMPLETED" });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "A");
    fs.writeFileSync(path.join(ctx.workspace, "b.txt"), "B");
    // b.txt already ACCEPTED under DIFFERENT bytes → replay conflict
    ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "b.txt",
      source: { kind: "buffer", bytes: Buffer.from("OTHER-B") },
      channel: "REMOTE_UPLOAD",
      actor: "T",
    });
    ctx.store.put(
      "executor_execution",
      p.eid,
      {
        ...(ctx.store.get("executor_execution", p.eid) as Record<string, unknown>),
        result: {
          status: "COMPLETED",
          artifacts: [
            { path: "a.txt", sha256: sha256Hex(Buffer.from("A")), byte_size: 1 },
            { path: "b.txt", sha256: sha256Hex(Buffer.from("B")), byte_size: 1 },
          ],
        },
      },
      1,
    );
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    // the conflict victim must NOT leave a.txt minted
    expect(
      ctx.authority
        .forExecution(p.eid)
        .filter((a) => a.logical_name === "a.txt"),
    ).toHaveLength(0);
    // the pre-existing remote-upload row persists (it was never part of
    // this batch) — it keeps its own authority
    expect(
      ctx.authority
        .forExecution(p.eid)
        .filter((a) => a.logical_name === "b.txt"),
    ).toHaveLength(1);
  });

  it("R1-F2b injected late storage failure → FAIL + no partial authority", () => {
    const ctx = mkCtx("f2b");
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [
          { path: "a.txt", sha256: sha256Hex(Buffer.from("A")), byte_size: 1 },
          { path: "b.txt", sha256: sha256Hex(Buffer.from("B")), byte_size: 1 },
        ],
      },
    });

    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "A");
    fs.writeFileSync(path.join(ctx.workspace, "b.txt"), "B");
    // fail only the blob-stage tmp open for B's blob
    const orig = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
      const pth = String(args[0]);
      if (pth.includes(".tmp-") && pth.includes(sha256Hex(Buffer.from("B")))) {
        throw new Error("injected blob-write failure");
      }
      return (orig as unknown as (...a: unknown[]) => unknown).apply(fs, args);
    }) as typeof fs.openSync);
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(0);
  });

  it("R1-F3 valid batch → all artifacts atomically accepted", () => {
    const ctx = mkCtx("f3");
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [
          { path: "a.txt", sha256: sha256Hex(Buffer.from("A")), byte_size: 1 },
          { path: "b.txt", sha256: sha256Hex(Buffer.from("B")), byte_size: 1 },
        ],
      },
    });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "A");
    fs.writeFileSync(path.join(ctx.workspace, "b.txt"), "B");
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v.status)).toBe("PASS");
    expect((v.artifact_ids as string[]).sort()).toEqual(
      [
        canonicalArtifactId(p.eid, "a.txt"),
        canonicalArtifactId(p.eid, "b.txt"),
      ].sort(),
    );
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(2);
  });

  it("R1-F4 replay-only valid batch → deterministic PASS, no duplicate authority", () => {
    const ctx = mkCtx("f4");
    const p = mkProducer(ctx, {
      state: "COMPLETED",
      result: {
        status: "COMPLETED",
        artifacts: [
          { path: "a.txt", sha256: sha256Hex(Buffer.from("A")), byte_size: 1 },
        ],
      },
    });
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "A");
    const v1 = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v1.status)).toBe("PASS");
    const v2 = new ArtifactProvenanceValidator().validate_execution(ctx.service, p.eid);
    expect(String(v2.status)).toBe("PASS");
    expect(v2.artifact_ids).toEqual(v1.artifact_ids);
    expect(ctx.authority.forExecution(p.eid)).toHaveLength(1);
  });
});

/* ==================== R1-G outbox compat collision ====================== */
describe("R1-G outbox compat materialization collision", () => {
  it("R1-G1 sanitized-name collision cannot overwrite — distinct dests", async () => {
    const ctx = mkCtx("g1");
    const prod = mkProducer(ctx);
    const cap = capFor(prod, ctx.missionId);
    await withServer(
      ctx.control,
      async (port) => {
        const post = async (filename: string, bytes: string) =>
          fetch(`http://127.0.0.1:${port}/api/outbox`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-artifact-capability": cap,
            },
            body: JSON.stringify({
              mission_id: ctx.missionId,
              task_id: prod.tid,
              filename,
              data_base64: Buffer.from(bytes).toString("base64"),
            }),
          });
        expect((await post("a b.txt", "FIRST")).status).toBe(200);
        expect((await post("a?b.txt", "SECOND")).status).toBe(200);
        const files = fs
          .readdirSync(path.join(ctx.workspace, "outbox"))
          .filter((f) => !f.includes(".tmp-"))
          .sort();
        expect(files).toHaveLength(2);
        const contents = files.map((f) =>
          fs.readFileSync(path.join(ctx.workspace, "outbox", f)).toString("utf8"),
        );
        expect(contents.sort()).toEqual(["FIRST", "SECOND"]);
      },
      { artifactUploadToken: MASTER },
    );
  });

  it("R1-G2 same artifact exact replay → deterministic idempotent materialization", async () => {
    const ctx = mkCtx("g2");
    const prod = mkProducer(ctx);
    const cap = capFor(prod, ctx.missionId);
    await withServer(
      ctx.control,
      async (port) => {
        const post = () =>
          fetch(`http://127.0.0.1:${port}/api/outbox`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-artifact-capability": cap,
            },
            body: JSON.stringify({
              mission_id: ctx.missionId,
              task_id: prod.tid,
              filename: "same.bin",
              data_base64: Buffer.from("SAME").toString("base64"),
            }),
          });
        const [r1, r2] = await Promise.all([post(), post()]);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        const files = fs.readdirSync(path.join(ctx.workspace, "outbox"));
        expect(files.filter((f) => f.endsWith("-same.bin"))).toHaveLength(1);
        expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
        expect(ctx.authority.forExecution(prod.eid)).toHaveLength(1);
      },
      { artifactUploadToken: MASTER },
    );
  });
});

/* ==================== R1-H / R1-I ====================================== */
describe("R1-H canonical API host-path disclosure", () => {
  it("R1-H canonical upload response carries no absolute host path", async () => {
    const ctx = mkCtx("h");
    const prod = mkProducer(ctx);
    await withServer(
      ctx.control,
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/outbox`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-artifact-capability": capFor(prod, ctx.missionId),
          },
          body: JSON.stringify({
            mission_id: ctx.missionId,
            task_id: prod.tid,
            filename: "h.bin",
            data_base64: Buffer.from("H").toString("base64"),
          }),
        });
        const j = (await res.json()) as Record<string, unknown>;
        expect(res.status).toBe(200);
        expect(JSON.stringify(j)).not.toContain(ctx.d);
        expect(j.path).toBeUndefined();
        expect(String(j.storage_ref)).toMatch(/^pair-artifact:\/\/sha256\//);
      },
      { artifactUploadToken: MASTER },
    );
  });
});

describe("R1-I CAS directory durability", () => {
  it("R1-I rename boundary performs a directory fsync", () => {
    const ctx = mkCtx("i");
    const p = mkProducer(ctx);
    fs.writeFileSync(path.join(ctx.workspace, "i.txt"), "I");
    const spy = vi.spyOn(fs, "fsyncSync");
    ctx.authority.accept({
      execution_id: p.eid,
      producer_executor_id: EX,
      logical_name: "i.txt",
      source: { kind: "path", path: path.join(ctx.workspace, "i.txt") },
      channel: "LOCAL_EXECUTION",
      actor: "T",
      allow_post_result: true,
    });
    // file fsync + parent-dir fsync after rename
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
