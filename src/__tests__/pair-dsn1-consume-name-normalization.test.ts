/**
 * DSN-1 — consume-name spelling normalization at the prerequisite seam.
 *
 * Incident MSN_01M420PJ: a remote producer declared `outbox/chart.png`,
 * the delivery task consumed `chart.png`. Canonical resolution bound the
 * artifact correctly (X and outbox/<basename> are accepted spellings of
 * one deliverable), but the pre-dispatch local-prerequisite check compared
 * resolved coverage by RAW STRING — the resolved consume was re-checked
 * against the shared workspace, where only CAS held the bytes →
 * FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING → DEPENDENCY_FAILURE → mission
 * FAILED with every artifact legitimately produced and pinned.
 *
 * The remediation compares resolved coverage through the ONE canonical
 * spelling rule (artifactNamesEquivalent — X ≡ outbox/<basename>) and
 * counts the delivery provenance pin (pair_delivery_artifact_digests) as
 * canonical resolution for the delivery lane. An unresolved consume still
 * fails FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING exactly as before.
 *
 *   D1  producer `outbox/X`, consumer `X` — alias binds, prereq exempt,
 *       bytes materialize through the canonical handoff
 *   D2  producer `X`, consumer `outbox/X` — mirror-direction alias binds
 *   D3  unresolved consume still fails the local-path check
 *   D4  remote canonical artifact absent from the shared outbox still
 *       succeeds via handoff (CAS is the byte authority, not the folder)
 *   D5  mixed canonical + legacy consumes — only the legacy one is checked
 *   D6  incident shape: remote `outbox/X` producer + delivery manifest `X`
 *       → pin binds, prereq exempt via pin, no shared-outbox demand
 *   D7  delivery manifest `outbox/X` + producer `X` (mirror direction on
 *       the delivery lane)
 *   D8  equivalent spellings that bound DISTINCT canonical artifacts stay
 *       ambiguous — fail closed, never a lexical pick
 *   D9  a resolved consume never re-checks a stale same-name workspace
 *       file — canonical bytes win, contaminant untouched
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ArtifactDependencyResolver,
  ArtifactProvenanceValidator,
  ApprovalQueue,
  artifactNamesEquivalent,
  canonicalArtifactId,
  DependencyResolutionError,
  digest,
  GovernedTaskGate,
  ExecutorRegistry,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  mintArtifactCapability,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  sha256Hex,
  TRANSPORT_IN_PROCESS,
  utcnow,
  workerExecutionId,
  artifactDependencySetDigest,
  type DependencyArtifactEntry,
} from "../pair/index.js";
import { DeliveryProvenanceBinding } from "../pair/artifact-handoff.js";

const ROOT = mkTmpDir("pair-dsn1-");
let dirSeq = 0;
const freshDir = (name: string) => {
  const p = path.join(ROOT, `${dirSeq++}-${name}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const EX = "EX_DSN1";
const EX_REMOTE = "EX_REMOTE_DSN1";
const REMOTE_CAP = "REMOTE_CLOUD_TASK_EXECUTION";
const MASTER = "dsn1-consume-master-secret";

/* ------------------------------- stack ---------------------------------- */

/** The production wiring — every component built against ONE store so the
 *  runtime's private dispatch-arm seams (requestFor, prerequisiteMissing)
 *  see the same durable rows the resolver and pin wrote. */
function wireStack(name: string, workspace: string, store: PairEvidenceStore) {
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, never>();
  const planner = () => ({ tasks: [] });
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
  for (const cap of [
    "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY", REMOTE_CAP,
  ]) {
    service.registerCapability(cap, { risk_class: "LOW" });
  }
  const project = service.createProject({ name: "p", root_location: workspace });
  return { service, gate, router, recovery, recon, approvals, scheduler, runtime, supervisor, control, projectId: String(project.project_id) };
}

function makeCtx(name: string) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  return { dir, workspace, store, ...wireStack(name, workspace, store) };
}

/* ------------------------------ producer --------------------------------- */

let seq = 0;
/** A canonical producer through the REAL ingest seams: local producers
 *  write the workspace file + declare it in the result; remote producers
 *  upload through the execution-scoped capability lane. Either way the
 *  REAL validator writes the anchored PASS row the resolver requires. */
function mkProducer(
  ctx: ReturnType<typeof makeCtx>,
  opts: {
    taskKey?: string;
    produces?: string | string[];
    artifactBytes?: Buffer | null;
    remote?: boolean;
    missionId?: string;
    planId?: string;
    /** governed/execution/task rows but NO artifact — a producer that ran
     *  yet never produced canonically. */
    noArtifact?: boolean;
  } = {},
) {
  const tid = `ATSK_DSN1_${seq++}`;
  const key = opts.taskKey ?? `TP${seq}`;
  const executor = opts.remote ? EX_REMOTE : EX;
  const gtId = `GT_${tid}`;
  const eid = workerExecutionId(executor, gtId);
  const missionId = opts.missionId ?? "M_DSN1";
  const planId = opts.planId ?? "PLAN_DSN1";
  const produces = Array.isArray(opts.produces)
    ? opts.produces
    : [opts.produces ?? "report.txt"];
  const name = produces[0]!;
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid, task_key: key, mission_id: missionId,
      plan_id: planId, title: key,
      task_instruction: `produce ${produces.join(",")}`,
      required_capabilities: opts.remote ? [REMOTE_CAP] : ["FILE_OPERATIONS"],
      depends_on: [], status: "COMPLETED",
      metadata: { pair_dataflow: { produces, consumes: [] } },
      version: 0,
    },
    0,
  );
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId, mission_id: missionId, task_id: tid,
      correlation_id: `COR_${tid}`, executor_id: executor,
      plan_id: planId, plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: utcnow(), version: 0,
    },
    0,
  );
  {
    // Mirror the production mint: every governed task emits the immutable
    // GOVERNED_TASK_VALIDATED anchor binding mint-time identity + scope
    // digest; remote tasks additionally pin the F5 declared-produces
    // contract.
    const governed = ctx.store.get("governed_task", gtId);
    if (opts.remote) {
      governed.expected_output_contract = {
        type: "TASK_RESULT",
        declared_produces: [...produces].sort(),
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
    const declared = opts.remote ? [...produces].sort() : null;
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: missionId, task_id: tid, executor_id: executor,
        governed_task_id: gtId, plan_id: planId, plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: !!opts.remote,
        declared_produces: declared,
        declared_produces_digest: declared ? digest(declared) : null,
      },
    });
    ctx.store.appendEvidence(missionId, "GOVERNED_TASK_VALIDATED", {
      governed_task_id: gtId, task_id: tid, executor_id: executor,
      mission_id: missionId, plan_id: planId, plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: !!opts.remote,
      declared_produces: declared,
      declared_produces_digest: declared ? digest(declared) : null,
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
      execution_id: eid, governed_task_id: gtId, mission_id: missionId,
      task_id: tid, executor_id: executor, plan_id: planId,
      plan_revision: 1, correlation_id: `COR_${tid}`,
      execution_state: "RUNNING", dispatch_timestamp: utcnow(),
      workspace: ctx.workspace, version: 0,
    },
    0,
  );
  let declared: Record<string, unknown>[] = [];
  if (bytes !== null && !opts.noArtifact) {
    if (opts.remote) {
      const cap = mintArtifactCapability(MASTER, {
        mission_id: missionId, task_id: tid, governed_task_id: gtId,
        execution_id: eid, executor_id: executor,
      });
      for (const p of produces) {
        ctx.control.acceptArtifactUpload(MASTER, cap, {
          filename: p, mission_id: missionId, task_id: tid, bytes,
        });
      }
    } else {
      for (const p of produces) {
        const fp = path.join(ctx.workspace, p);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, bytes);
      }
      declared = produces.map((p) => ({
        path: p, sha256: sha256Hex(bytes), byte_size: bytes.length,
      }));
    }
  }
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put(
    "executor_execution",
    eid,
    {
      ...settled,
      execution_state: "COMPLETED",
      result: { status: "COMPLETED", artifacts: declared },
    },
    settled.version,
  );
  new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
  const art = ctx.store.tryGet("artifact", canonicalArtifactId(eid, name));
  return {
    tid, gtId, eid, executor, key, missionId, planId,
    produces, name, bytes: bytes ?? Buffer.alloc(0),
    artifact: art as Record<string, unknown> | null,
    artifactId: String(art?.artifact_id ?? canonicalArtifactId(eid, name)),
  };
}

/* ------------------------------ consumer --------------------------------- */

/** A local non-delivery consumer task declaring consume edges. */
function mkConsumer(
  ctx: ReturnType<typeof makeCtx>,
  producers: ReturnType<typeof mkProducer>[],
  opts: {
    consume?: string | string[];
    missionId?: string;
    planId?: string;
    dependsOn?: string[];
  } = {},
) {
  const tid = `ATSK_DSN1_C_${seq++}`;
  const key = `TC${seq}`;
  const missionId = opts.missionId ?? producers[0]?.missionId ?? "M_DSN1";
  const planId = opts.planId ?? producers[0]?.planId ?? "PLAN_DSN1";
  const consumes = Array.isArray(opts.consume)
    ? opts.consume
    : [opts.consume ?? producers[0]?.name ?? "report.txt"];
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid, task_key: key, mission_id: missionId,
      plan_id: planId, title: key,
      task_instruction: `read ${consumes.join(",")} then reply DONE.`,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: opts.dependsOn ?? producers.map((p) => p.key),
      status: "READY",
      metadata: { pair_dataflow: { produces: [], consumes } },
      version: 0,
    },
    0,
  );
  return { tid, key, consumes, missionId, planId, task: ctx.store.get("task", tid) };
}

/** A governed consumer row pinned with `entries` — the shape
 *  gate.dispatch produces. */
function mkGovernedConsumer(
  ctx: ReturnType<typeof makeCtx>,
  consumer: ReturnType<typeof mkConsumer>,
  entries: DependencyArtifactEntry[],
) {
  const gtId = `GT_${consumer.tid}`;
  const depDigest = artifactDependencySetDigest(entries);
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId, mission_id: consumer.missionId,
      task_id: consumer.tid, correlation_id: `COR_${consumer.tid}`,
      executor_id: EX, plan_revision: 1, plan_id: consumer.planId,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      dependency_artifacts: entries,
      dependency_artifacts_digest: depDigest,
      created_at: utcnow(), version: 0,
    },
    0,
  );
  ctx.store.event({
    entity_type: "governed_task", entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${consumer.tid}`,
    metadata: {
      mission_id: consumer.missionId, task_id: consumer.tid,
      executor_id: EX, dependency_artifacts_digest: depDigest,
    },
  });
  return { gtId, governed: ctx.store.get("governed_task", gtId) };
}

/** A TELEGRAM_DELIVERY task — the incident's T5 shape: FILES manifest +
 *  consume edges + no produces. */
function mkDeliveryTask(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    missionId: string;
    planId: string;
    dependsOn: string[];
    artifacts: string[];
    consumes?: string[];
  },
) {
  const tid = `TDEL_DSN1_${seq++}`;
  const task = {
    task_id: tid, task_key: `TDL${seq}`, mission_id: o.missionId,
    plan_id: o.planId, title: "deliver",
    task_instruction: `send ${o.artifacts.join(",")} to telegram`,
    required_capabilities: ["TELEGRAM_DELIVERY"],
    depends_on: o.dependsOn, status: "READY",
    metadata: {
      workspace: ctx.workspace,
      pair_telegram_delivery: {
        requested: true, mode: "FILES", artifacts: o.artifacts,
      },
      pair_dataflow: { produces: [], consumes: o.consumes ?? o.artifacts },
    },
    version: 0,
  };
  ctx.store.put("task", tid, task, 0);
  return { tid, task: ctx.store.get("task", tid) };
}

const missionRow = (
  ctx: ReturnType<typeof makeCtx>,
  missionId: string,
) => ({
  mission_id: missionId, project_id: ctx.projectId,
  plan_revision: 1,
  metadata: { authorized_workspaces: [ctx.workspace] },
});

const resolver = (ctx: ReturnType<typeof makeCtx>) =>
  new ArtifactDependencyResolver(ctx.service);
const handoffs = (ctx: ReturnType<typeof makeCtx>) =>
  ctx.service.artifactHandoffs;

/** The two private dispatch-arm seams, driven in the exact order the
 *  runtime runs them: requestFor (pins the delivery digests + resolves
 *  dependency_artifacts) then prerequisiteMissing on the resolved set. */
const requestForOf = (ctx: ReturnType<typeof makeCtx>) =>
  (ctx.runtime as unknown as {
    requestFor(
      m: Record<string, unknown>,
      t: Record<string, unknown>,
    ): Record<string, unknown>;
  }).requestFor.bind(ctx.runtime);
const prereqOf = (ctx: ReturnType<typeof makeCtx>) =>
  (ctx.runtime as unknown as {
    prerequisiteMissing(
      m: Record<string, unknown>,
      t: Record<string, unknown>,
      resolved?: Set<string>,
    ): string | null;
  }).prerequisiteMissing.bind(ctx.runtime);

/** The real dispatch-arm sequence: requestFor → resolved-name set →
 *  prerequisiteMissing. Returns the request (for assertions) and the
 *  missing consume (null = proceed to dispatch). */
const dispatchArmPrereq = (
  ctx: ReturnType<typeof makeCtx>,
  mission: Record<string, unknown>,
  taskId: string,
) => {
  const task = ctx.store.get("task", taskId);
  const request = requestForOf(ctx)(mission, task);
  const resolved = new Set(
    ((request.dependency_artifacts as DependencyArtifactEntry[]) ?? []).map(
      (e) => String(e.logical_name),
    ),
  );
  const missing = prereqOf(ctx)(
    mission,
    ctx.store.get("task", taskId),
    resolved,
  );
  return { request, resolved, missing };
};

const errCode = (f: () => unknown): string => {
  try {
    f();
    return "NO_THROW";
  } catch (e) {
    if (e instanceof DependencyResolutionError) return `DEP:${e.code}`;
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string") return code;
    return `OTHER:${String(e)}`;
  }
};

/* ================================ tests =================================== */

describe("DSN-1 — consume-name spelling normalization", () => {
  it("D1. producer 'outbox/X' + consumer 'X' → resolves, prereq exempt, exact bytes materialize", () => {
    const ctx = makeCtx("d1");
    const prod = mkProducer(ctx, { produces: "outbox/data.json", remote: true });
    const cons = mkConsumer(ctx, [prod], { consume: "data.json" });
    const mission = missionRow(ctx, cons.missionId);
    const entries = resolver(ctx).resolveForConsumer({
      mission, task: cons.task,
    });
    expect(entries).toHaveLength(1);
    // The bound artifact is the producer's canonical outbox-spelled row.
    expect(String(entries[0]!.artifact_id)).toBe(prod.artifactId);
    expect(String(entries[0]!.logical_name)).toBe("outbox/data.json");
    // Pre-fix: prereq compared 'data.json' vs 'outbox/data.json' raw →
    // demanded the file in the workspace → LOCAL_PREREQUISITE_MISSING.
    const { missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(missing).toBeNull();
    // Canonical bytes materialize into the consumer's isolated root.
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(written).toEqual([entries[0]!.consumer_relative_path]);
    const dest = path.join(ctx.workspace, written[0]!);
    expect(fs.readFileSync(dest)).toEqual(prod.bytes);
    expect(String(entries[0]!.consumer_relative_path)).toContain(
      ".pair/dependency-artifacts",
    );
  });

  it("D2. producer 'X' + consumer 'outbox/X' → mirror-direction alias binds", () => {
    const ctx = makeCtx("d2");
    const prod = mkProducer(ctx, { produces: "data.json", remote: true });
    const cons = mkConsumer(ctx, [prod], { consume: "outbox/data.json" });
    const mission = missionRow(ctx, cons.missionId);
    // Pre-fix: producesOf.has('outbox/data.json') was false → unbound_consume.
    const entries = resolver(ctx).resolveForConsumer({
      mission, task: cons.task,
    });
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.artifact_id)).toBe(prod.artifactId);
    expect(String(entries[0]!.logical_name)).toBe("data.json");
    const { missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(missing).toBeNull();
  });

  it("D3. unresolved consume still fails the local-path check", () => {
    const ctx = makeCtx("d3");
    // Producer declares the edge but its execution produced NO canonical
    // artifact — local→local keeps legacy path-only dependency semantics.
    const prod = mkProducer(ctx, {
      produces: "a.txt", artifactBytes: null,
    });
    expect(prod.artifact).toBeNull();
    const cons = mkConsumer(ctx, [prod], { consume: "a.txt" });
    const mission = missionRow(ctx, cons.missionId);
    const entries = resolver(ctx).resolveForConsumer({
      mission, task: cons.task,
    });
    // Local→local with no canonical artifact stays outside the mechanism.
    expect(entries).toEqual([]);
    // ws/a.txt absent → the consume is still genuinely missing.
    const { missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(missing).toBe("a.txt");
    // And when the file DOES exist the legacy path check passes it
    // through — legacy semantics unchanged.
    fs.writeFileSync(path.join(ctx.workspace, "a.txt"), "legacy");
    const again = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(again.missing).toBeNull();
  });

  it("D4. remote canonical artifact absent from shared outbox still succeeds via handoff", () => {
    const ctx = makeCtx("d4");
    const prod = mkProducer(ctx, { produces: "outbox/chart.png", remote: true });
    // The canonical bytes live ONLY in CAS — the shared outbox never
    // receives a copy (exactly the incident's artifact placement).
    expect(fs.existsSync(path.join(ctx.workspace, "outbox"))).toBe(false);
    const cons = mkConsumer(ctx, [prod], { consume: "chart.png" });
    const mission = missionRow(ctx, cons.missionId);
    const { request, missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(missing).toBeNull();
    // The request pins the exact canonical artifact for handoff
    // materialization — not a workspace path, not a same-name file.
    const entries = request.dependency_artifacts as DependencyArtifactEntry[];
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.sha256)).toBe(String(prod.artifact!.sha256));
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    expect(fs.readFileSync(path.join(ctx.workspace, written[0]!))).toEqual(prod.bytes);
    // Nothing leaked into the shared outbox — CAS is the byte authority.
    expect(fs.existsSync(path.join(ctx.workspace, "outbox"))).toBe(false);
  });

  it("D5. mixed canonical + legacy consumes — only the unresolved legacy one is checked", () => {
    const ctx = makeCtx("d5");
    const resolved = mkProducer(ctx, {
      produces: "outbox/chart.png", remote: true, taskKey: "TPR",
    });
    const legacy = mkProducer(ctx, {
      produces: "scratch.txt", artifactBytes: null, taskKey: "TPL",
    });
    const cons = mkConsumer(ctx, [resolved, legacy], {
      consume: ["chart.png", "scratch.txt"],
    });
    const mission = missionRow(ctx, cons.missionId);
    const { request, missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    const entries = request.dependency_artifacts as DependencyArtifactEntry[];
    // Alias consume bound canonically; legacy consume unresolved.
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.artifact_id)).toBe(resolved.artifactId);
    // ONLY the unresolved consume is reported missing.
    expect(missing).toBe("scratch.txt");
    // Provide the legacy file → nothing remains missing.
    fs.writeFileSync(path.join(ctx.workspace, "scratch.txt"), "legacy");
    expect(dispatchArmPrereq(ctx, mission, cons.tid).missing).toBeNull();
  });

  it("D6. incident shape — remote 'outbox/X' producer + delivery manifest 'X': pin binds, prereq exempt via pin", () => {
    const ctx = makeCtx("d6");
    const prod = mkProducer(ctx, {
      produces: "outbox/chart.png", remote: true, taskKey: "T3",
    });
    const del = mkDeliveryTask(ctx, {
      missionId: prod.missionId, planId: prod.planId,
      dependsOn: [prod.key],
      artifacts: ["chart.png"],
      consumes: ["chart.png"],
    });
    const mission = missionRow(ctx, prod.missionId);
    // The real arm: requestFor mints the provenance pin (manifest 'X'
    // binds produce 'outbox/X'), then prereq checks the FRESH task row —
    // the pin IS the canonical resolution for the delivery lane.
    const { request, missing } = dispatchArmPrereq(ctx, mission, del.tid);
    // Delivery tasks get an empty dependency_artifacts list by design —
    // their canonical channel is the pin + CAS snapshot.
    expect(request.dependency_artifacts ?? []).toEqual([]);
    const pin = (
      ctx.store.get("task", del.tid).metadata as Record<string, unknown>
    ).pair_delivery_artifact_digests as Record<string, Record<string, unknown>>;
    expect(String(pin["chart.png"].artifact_id)).toBe(prod.artifactId);
    expect(String(pin["chart.png"].state)).toBe("PINNED");
    expect(String(pin["chart.png"].logical_name)).toBe("outbox/chart.png");
    // Pre-fix: dep_artifacts empty → raw-string compare → consume
    // demanded in the shared outbox → FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING.
    expect(missing).toBeNull();
    // The shared outbox still holds nothing — no staged copy required.
    expect(fs.existsSync(path.join(ctx.workspace, "outbox"))).toBe(false);
  });

  it("D7. delivery manifest 'outbox/X' + producer 'X' — mirror direction on the delivery lane", () => {
    const ctx = makeCtx("d7");
    const prod = mkProducer(ctx, {
      produces: "report.txt", remote: true, taskKey: "T4",
    });
    const del = mkDeliveryTask(ctx, {
      missionId: prod.missionId, planId: prod.planId,
      dependsOn: [prod.key],
      artifacts: ["outbox/report.txt"],
      consumes: ["outbox/report.txt"],
    });
    const mission = missionRow(ctx, prod.missionId);
    // Pre-fix: manifest 'outbox/report.txt' never matched declared produce
    // 'report.txt' → no_producer → FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE.
    const { missing } = dispatchArmPrereq(ctx, mission, del.tid);
    const pin = (
      ctx.store.get("task", del.tid).metadata as Record<string, unknown>
    ).pair_delivery_artifact_digests as Record<string, Record<string, unknown>>;
    expect(String(pin["outbox/report.txt"].artifact_id)).toBe(prod.artifactId);
    expect(String(pin["outbox/report.txt"].state)).toBe("PINNED");
    expect(missing).toBeNull();
  });

  it("D8. equivalent spellings binding DISTINCT canonical artifacts stay ambiguous — fail closed", () => {
    const ctx = makeCtx("d8");
    // One producer execution canonically accepted BOTH spellings — two
    // distinct artifacts that are compatible spellings of one deliverable.
    // The consume can never pick lexically: ambiguity must fail closed.
    const prod = mkProducer(ctx, {
      produces: ["chart.png", "outbox/chart.png"],
      remote: true, taskKey: "TP",
    });
    const cons = mkConsumer(ctx, [prod], { consume: "chart.png" });
    const mission = missionRow(ctx, cons.missionId);
    const code = errCode(() =>
      resolver(ctx).resolveForConsumer({ mission, task: cons.task }),
    );
    expect(code).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
    // And the delivery lane applies the same ambiguity rule.
    const del = mkDeliveryTask(ctx, {
      missionId: prod.missionId, planId: prod.planId,
      dependsOn: [prod.key], artifacts: ["chart.png"], consumes: ["chart.png"],
    });
    const delCode = errCode(() =>
      dispatchArmPrereq(ctx, mission, del.tid),
    );
    expect(delCode).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
  });

  it("D9. resolved consume never consults a stale same-name workspace file", () => {
    const ctx = makeCtx("d9");
    const prod = mkProducer(ctx, { produces: "outbox/data.json", remote: true });
    // A contaminant with the consume's spelling sits in the workspace —
    // wrong bytes, wrong provenance. It must never satisfy the consume.
    fs.writeFileSync(path.join(ctx.workspace, "data.json"), "STALE-BYTES");
    const cons = mkConsumer(ctx, [prod], { consume: "data.json" });
    const mission = missionRow(ctx, cons.missionId);
    const { request, missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    expect(missing).toBeNull();
    const entries = request.dependency_artifacts as DependencyArtifactEntry[];
    expect(String(entries[0]!.sha256)).toBe(String(prod.artifact!.sha256));
    const gc = mkGovernedConsumer(ctx, cons, entries);
    handoffs(ctx).pinForGovernedTask(gc.governed, entries, "LOCAL_MATERIALIZATION");
    const written = handoffs(ctx).materializeForConsumer(gc.governed);
    // The materialized bytes are the canonical CAS bytes — the stale
    // file was never a source, and is physically untouched.
    expect(fs.readFileSync(path.join(ctx.workspace, written[0]!))).toEqual(prod.bytes);
    expect(fs.readFileSync(path.join(ctx.workspace, "data.json"), "utf8")).toBe("STALE-BYTES");
  });

  /* ------------------------- DSN-1 R1 — pairwise equivalence ------------ */

  it("R1.A — same basename in different directories is NOT equivalent (no transitive outbox-alias binding)", () => {
    const ctx = makeCtx("r1a");
    // The mandated truth table — pairwise-direct equivalence only.
    expect(artifactNamesEquivalent("chart.png", "chart.png")).toBe(true);
    expect(artifactNamesEquivalent("chart.png", "outbox/chart.png")).toBe(true);
    expect(artifactNamesEquivalent("outbox/chart.png", "chart.png")).toBe(true);
    expect(artifactNamesEquivalent("dir/chart.png", "outbox/chart.png")).toBe(true);
    expect(artifactNamesEquivalent("outbox/chart.png", "dir/chart.png")).toBe(true);
    expect(artifactNamesEquivalent("dirA/chart.png", "dirB/chart.png")).toBe(false);
    expect(artifactNamesEquivalent("chart.png", "dir/chart.png")).toBe(false);
    expect(
      artifactNamesEquivalent(
        "reports/internal/report.md",
        "reports/customer/report.md",
      ),
    ).toBe(false);
    // Unnormalizable input still fails closed to false.
    expect(artifactNamesEquivalent("a/../b.txt", "outbox/b.txt")).toBe(false);

    // Producer 'reports/internal/report.md' can never satisfy consume
    // 'reports/customer/report.md' — pre-fix both names generated the
    // staged spelling 'outbox/report.md' and INTERSECTED, so the consume
    // bound the unrelated canonical artifact. Now the resolve fails
    // closed as unbound: no producer declares an equivalent name.
    const prod = mkProducer(ctx, {
      produces: "reports/internal/report.md", remote: true, taskKey: "TP",
    });
    const cons = mkConsumer(ctx, [prod], {
      consume: "reports/customer/report.md",
    });
    const mission = missionRow(ctx, cons.missionId);
    const code = errCode(() =>
      resolver(ctx).resolveForConsumer({ mission, task: cons.task }),
    );
    expect(code).toBe("DEP:FAIL_CLOSED_DEPENDENCY_RESOLUTION");
    // And the delivery lane enforces the same non-equivalence: manifest
    // 'reports/customer/report.md' cannot pin produce
    // 'reports/internal/report.md' — the pin mint fails closed too.
    const del = mkDeliveryTask(ctx, {
      missionId: prod.missionId, planId: prod.planId,
      dependsOn: [prod.key],
      artifacts: ["reports/customer/report.md"],
      consumes: ["reports/customer/report.md"],
    });
    const delCode = errCode(() =>
      dispatchArmPrereq(ctx, mission, del.tid),
    );
    expect(delCode).toBe("DEP:FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE");
  });

  it("R1.B — an unrelated resolved artifact cannot exempt a same-basename consume; the legacy check still reports it", () => {
    const ctx = makeCtx("r1b");
    // One consume binds canonically ('dirA/chart.png'); the other
    // ('dirB/chart.png') shares only the basename. Its declared producer
    // produced no canonical artifact → genuinely unresolved.
    const resolved = mkProducer(ctx, {
      produces: "dirA/chart.png", remote: true, taskKey: "TPA",
    });
    const legacy = mkProducer(ctx, {
      produces: "dirB/chart.png", artifactBytes: null, taskKey: "TPB",
    });
    const cons = mkConsumer(ctx, [resolved, legacy], {
      consume: ["dirA/chart.png", "dirB/chart.png"],
    });
    const mission = missionRow(ctx, cons.missionId);
    const { request, missing } = dispatchArmPrereq(ctx, mission, cons.tid);
    const entries = request.dependency_artifacts as DependencyArtifactEntry[];
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.artifact_id)).toBe(resolved.artifactId);
    expect(String(entries[0]!.logical_name)).toBe("dirA/chart.png");
    // Pre-fix: resolved 'dirA/chart.png' generated 'outbox/chart.png' and
    // so did consume 'dirB/chart.png' → set intersection → wrongly
    // exempted → missing null. Pairwise equivalence keeps it unresolved:
    // the legacy local-path check must still run and report it.
    expect(missing).toBe("dirB/chart.png");
    // Providing the legacy file clears it — legacy semantics unchanged.
    fs.mkdirSync(path.join(ctx.workspace, "dirB"), { recursive: true });
    fs.writeFileSync(path.join(ctx.workspace, "dirB", "chart.png"), "legacy");
    expect(dispatchArmPrereq(ctx, mission, cons.tid).missing).toBeNull();
  });
});
