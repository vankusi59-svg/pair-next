/**
 * ACR-1 — durable reject evidence at the /api/outbox capability seam.
 *
 * Rejects that happen before accept() previously left no audit row, so a
 * remote worker's "sent verbatim" claim could not be disproved. Every
 * capability reject (signature / durable_identity / body-mismatch) now
 * emits exactly ONE append-only ARTIFACT_CAPABILITY_REJECTED event per
 * DISTINCT received capability value — bounded non-secret fields only:
 * stage, sha256 of the received capability, filename, claimed identity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ArtifactAuthority,
  IntegrityError,
  PolicyError,
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  digest,
  mintArtifactCapability,
  sha256Hex,
  utcnow,
  workerExecutionId,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-acr1-");
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
    goal: "acr1 test",
    granted_permissions: ["FILE_WRITE"],
    authorized_workspaces: [workspace],
  });
  return { d, workspace, store, service, authority, control, missionId: String(mission.mission_id) };
}

let producerSeq = 0;
function mkProducer(ctx: ReturnType<typeof mkCtx>, opts: { executor?: string } = {}) {
  const tid = `TSK_${producerSeq++}_${ctx.missionId.slice(-6)}`;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(opts.executor ?? EX, gtId);
  ctx.store.put("task", tid, { task_id: tid, mission_id: ctx.missionId, version: 0 }, 0);
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: ctx.missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: opts.executor ?? EX,
    plan_id: "PLAN_ACR", plan_revision: 1,
    workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  ctx.store.put("executor_execution", eid, {
    execution_id: eid, governed_task_id: gtId, mission_id: ctx.missionId,
    task_id: tid, executor_id: opts.executor ?? EX,
    plan_id: "PLAN_ACR", plan_revision: 1,
    correlation_id: `COR_${tid}`,
    execution_state: "RUNNING", dispatch_timestamp: utcnow(),
    workspace: ctx.workspace, version: 0,
  }, 0);
  return { tid, gtId, eid, executor: opts.executor ?? EX };
}

const cap = (c: { eid: string; gtId: string; tid: string; executor: string; missionId: string }) =>
  mintArtifactCapability(MASTER, {
    mission_id: c.missionId, task_id: c.tid, governed_task_id: c.gtId,
    execution_id: c.eid, executor_id: c.executor,
  });

const rejectEvents = (ctx: ReturnType<typeof mkCtx>) =>
  ctx.store.listEvents("artifact_capability_reject");

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

describe("ACR-1 — capability reject durable evidence", () => {
  it("A1 corrupted signature → reject + exactly one durable event, digest = received capability", () => {
    const ctx = mkCtx("a1");
    const prod = mkProducer(ctx);
    const issued = cap({ ...prod, missionId: ctx.missionId });
    const corrupted = issued.replace(/.$/, issued.endsWith("a") ? "b" : "a");

    const err = capture(() =>
      ctx.control.acceptArtifactUpload(MASTER, corrupted, {
        filename: "data.json",
        mission_id: ctx.missionId,
        task_id: prod.tid,
        bytes: Buffer.from("x"),
      }),
    );
    expect(err).toBeInstanceOf(PolicyError);
    expect(String((err as PolicyError).message)).toContain("CAPABILITY_INVALID");

    const evs = rejectEvents(ctx);
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.event_type).toBe("ARTIFACT_CAPABILITY_REJECTED");
    expect(ev.new_state).toBe("signature");
    const md = ev.metadata as Record<string, unknown>;
    // digest binds the RECEIVED value, not the issued capability
    expect(md.capability_sha256).toBe(sha256Hex(corrupted));
    expect(md.capability_sha256).not.toBe(sha256Hex(issued));
    expect(md.stage).toBe("signature");
    expect(md.filename).toBe("data.json");
    expect(md.claimed_mission_id).toBe(ctx.missionId);
    expect(md.claimed_task_id).toBe(prod.tid);
    expect(ctx.store.list("artifact")).toHaveLength(0);
  });

  it("A2 replayed identical corrupted capability stays bounded — one event per distinct value", () => {
    const ctx = mkCtx("a2");
    const prod = mkProducer(ctx);
    const corrupted = `${cap({ ...prod, missionId: ctx.missionId })}x`;
    const body = { filename: "f", bytes: Buffer.from("x") };
    for (let i = 0; i < 3; i++) {
      expect(capture(() => ctx.control.acceptArtifactUpload(MASTER, corrupted, body)))
        .toBeInstanceOf(PolicyError);
    }
    expect(rejectEvents(ctx)).toHaveLength(1);
    // a DIFFERENT corrupted value mints a second, distinct event
    const corrupted2 = corrupted.slice(0, -1) + (corrupted.endsWith("z") ? "y" : "z");
    expect(capture(() => ctx.control.acceptArtifactUpload(MASTER, corrupted2, body)))
      .toBeInstanceOf(PolicyError);
    expect(rejectEvents(ctx)).toHaveLength(2);
    const digests = rejectEvents(ctx).map(
      (e) => String((e.metadata as Record<string, unknown>).capability_sha256),
    );
    expect(digests).toContain(sha256Hex(corrupted));
    expect(digests).toContain(sha256Hex(corrupted2));
  });

  it("A3 durable_identity reject: valid signature, foreign durable state → stage + claims recorded", () => {
    const ctx = mkCtx("a3");
    const prod = mkProducer(ctx);
    const forged = mintArtifactCapability(MASTER, {
      mission_id: ctx.missionId, task_id: prod.tid, governed_task_id: prod.gtId,
      execution_id: "EXE_DOES_NOT_EXIST", executor_id: prod.executor,
    });
    const err = capture(() =>
      ctx.control.acceptArtifactUpload(MASTER, forged, { filename: "x", bytes: Buffer.from("x") }),
    );
    expect(String((err as PolicyError).message)).toContain("CAPABILITY_MISMATCH");
    const evs = rejectEvents(ctx);
    expect(evs).toHaveLength(1);
    const md = evs[0]!.metadata as Record<string, unknown>;
    expect(md.stage).toBe("durable_identity");
    expect(md.capability_sha256).toBe(sha256Hex(forged));
    // signature-valid claims ARE the recorded identity
    expect(md.claimed_execution_id).toBe("EXE_DOES_NOT_EXIST");
    expect(md.claimed_mission_id).toBe(ctx.missionId);
  });

  it("A4 valid capability → accepted, zero reject events", () => {
    const ctx = mkCtx("a4");
    const prod = mkProducer(ctx);
    const r = ctx.control.acceptArtifactUpload(MASTER, cap({ ...prod, missionId: ctx.missionId }), {
      filename: "ok.txt", mission_id: ctx.missionId, task_id: prod.tid,
      bytes: Buffer.from("ok"),
    });
    expect(String(r.artifact.artifact_id)).toContain("ART_");
    expect(rejectEvents(ctx)).toHaveLength(0);
  });

  it("A5 no secret material persists: raw capability / master / bytes absent everywhere", () => {
    const ctx = mkCtx("a5");
    const prod = mkProducer(ctx);
    const corrupted = `${cap({ ...prod, missionId: ctx.missionId })}!`;
    const leaked = capture(() =>
      ctx.control.acceptArtifactUpload(MASTER, corrupted, {
        filename: "x", bytes: Buffer.from("SECRET-BODY-BYTES"),
      }),
    );
    expect(leaked).toBeInstanceOf(PolicyError);
    const corpus = JSON.stringify({
      events: ctx.store.listEvents(),
      evidence: ctx.store.listEvidence(),
      entities: ["artifact", "executor_execution", "governed_task"].flatMap((t) =>
        ctx.store.list(t)),
    });
    expect(corpus).not.toContain(corrupted);
    expect(corpus).not.toContain(MASTER);
    expect(corpus).not.toContain("SECRET-BODY-BYTES");
    // digest of the received value IS present — that is the evidence
    expect(corpus).toContain(sha256Hex(corrupted));
  });

  it("A6 reject event is immutable-append-only: mutating its metadata trips event-hash verification", () => {
    const ctx = mkCtx("a6");
    const prod = mkProducer(ctx);
    const corrupted = `${cap({ ...prod, missionId: ctx.missionId })}q`;
    expect(capture(() => ctx.control.acceptArtifactUpload(MASTER, corrupted, { filename: "x", bytes: Buffer.from("x") })))
      .toBeInstanceOf(PolicyError);
    const ev = rejectEvents(ctx)[0]!;
    ctx.store.db
      .prepare("UPDATE events SET metadata_json=? WHERE event_id=?")
      .run(JSON.stringify({ stage: "forged" }), String(ev.event_id));
    expect(() => rejectEvents(ctx)).toThrowError(/EVENT_HASH_MISMATCH/);
  });
});
