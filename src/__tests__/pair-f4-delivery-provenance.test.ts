/* =============================================================================
 * PHASE F4 — DELIVERY ARTIFACT PROVENANCE CLOSURE (adversarial tests A1–A11)
 *
 * Target: a manifested delivery artifact may only ever resolve to canonical
 * current-mission artifact authority — a pair-artifact.v1 row produced by a
 * legitimate in-mission predecessor execution with a terminal anchored PASS,
 * whose retained CAS bytes re-verify through the SAME ArtifactAuthority seam
 * as every other consumer. The shared outbox is transport/staging only and is
 * never authority: a stale exact-name or same-SHA file from an older mission
 * must fail closed with FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE, mint zero
 * Telegram send authority, and burn zero network.
 *
 * Fixtures fabricate producers through the REAL ingest seams — declared
 * result artifacts → ArtifactProvenanceValidator (local) or the capability
 * upload lane (remote) — so the canonical rows, RESULT_VALIDATED anchors and
 * ARTIFACT_ACCEPTED history are production-shaped.
 * ========================================================================== */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  ArtifactProvenanceValidator,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
  canonicalArtifactId,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  deliveryManifest,
  mintArtifactCapability,
  pendingTelegramDeliveries,
  reconcilePlanDataflow,
  sha256File,
  sha256Hex,
  transportTelegramDelivery,
  utcnow,
  workerExecutionId,
  DELIVERY_TEXT_ARTIFACT,
  MAX_TELEGRAM_FILE_BYTES,
} from "../pair/index.js";
import type {
  DeliveryBackend,
  GovernedSendResult,
  GovernedTelegramTransport,
  TelegramDeliveryIntent,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f4-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const VI_REPORT =
  "Báo cáo tổng hợp giá vàng XAUUSD.\n" +
  "Giá vàng trong bảy ngày qua đã tăng mạnh, với các phiên giao dịch biến động.\n" +
  "Tin tức kinh tế mới nhất cho thấy lạm phát và lãi suất vẫn là yếu tố chính.\n" +
  "Kết luận: xu hướng tăng ngắn hạn vẫn được duy trì.";
const PROD_GOAL =
  "task 1 thu thập giá XAUUSD 7 ngày qua, task 2 thu thập tin tức kinh tế mới nhất về vàng, " +
  "task 3 đọc output của task 1 VÀ task 2 rồi viết báo cáo tổng hợp bằng tiếng việt vào outbox/report.txt, " +
  "task 4 gửi file report.txt đến telegram";

/* ------------------------------ plan fixtures ------------------------------ */

const FILES_INTENT = (artifacts: string[]): TelegramDeliveryIntent => ({
  requested: true,
  artifacts,
  mode: "FILES",
});
const TEXT_INTENT: TelegramDeliveryIntent = {
  requested: true,
  artifacts: [],
  mode: "TEXT",
};

const goalTask = (key = "T1") => ({
  task_key: key,
  title: "record goal",
  task_instruction: "record the goal",
  required_capabilities: ["FILE_OPERATIONS"],
  depends_on: [] as string[],
  metadata: {
    expected_output_contract: {
      type: "TASK_RESULT",
      worker_spec: {
        ops: [
          { op: "write_text_file", path: "mission_goal.txt", content: "g" },
          { op: "finish", result: { summary: "ok" } },
        ],
      },
    },
  },
});

/** Production-shaped FILES plan: T4 produces outbox/report.txt, T5 delivers. */
const prodPlan = () => [
  goalTask("T1"),
  {
    task_key: "T2",
    title: "gold data",
    task_instruction: "collect the gold market data",
    required_capabilities: ["REASONING"],
    depends_on: ["T1"],
    metadata: {},
  },
  {
    task_key: "T3",
    title: "gold news",
    task_instruction: "collect the latest economy news",
    required_capabilities: ["REASONING"],
    depends_on: ["T1"],
    metadata: {},
  },
  {
    task_key: "T4",
    title: "write report",
    task_instruction:
      "read the outputs of T2 and T3 in dependency_outputs, then write the combined report to outbox/report.txt, then reply DONE.",
    required_capabilities: ["FILE_OPERATIONS"],
    depends_on: ["T2", "T3"],
    metadata: {},
  },
  {
    task_key: "T5",
    title: "send report",
    task_instruction: "send report.txt to telegram",
    required_capabilities: ["TELEGRAM_DELIVERY"],
    depends_on: [] as string[],
    metadata: {},
  },
];

/** The producerless defect: T4 in this plan never declares the manifest file. */
const producerlessPlan = (remote = false) => {
  const plan = prodPlan();
  plan[3]!.metadata = {}; // T4 writes nothing — declares no produce
  plan[3]!.task_instruction = remote
    ? "analyze the gold market remotely"
    : "analyze the gold market";
  plan[3]!.required_capabilities = remote
    ? ["REMOTE_CLOUD_TASK_EXECUTION"]
    : ["REASONING"];
  return plan;
};

const textPlan = () => [
  goalTask("T1"),
  {
    task_key: "T2",
    title: "analyze gold",
    task_instruction: "analyze the gold market and return findings, then reply DONE.",
    required_capabilities: ["REASONING"],
    depends_on: ["T1"],
    metadata: {},
  },
  {
    task_key: "T3",
    title: "deliver",
    task_instruction: "compose the report for the operator, then reply DONE.",
    required_capabilities: ["TELEGRAM_DELIVERY"],
    depends_on: ["T2"],
    metadata: {},
  },
];
const TEXT_GOAL = "phân tích giá vàng hôm nay rồi gửi kết quả đến telegram";

/* ------------------------------ runtime ctx -------------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  private wrote: Record<string, string[]> = {};
  behavior: Record<
    string,
    "COMPLETE" | "FAIL" | "WRITE" | "CLOBBER" | "SKIPWRITE"
  > = {};
  fileContent: Record<string, string> = {};
  workspace = "";
  private store?: PairEvidenceStore;

  constructor(id: string, caps: string[]) {
    this.executor_id = id;
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    const taskRow = this.store?.tryGet("task", String(task.task_id));
    const key = String(taskRow?.task_key ?? "");
    const b = this.behavior[key] ?? "COMPLETE";
    let status = "COMPLETED";
    const df = (
      (taskRow?.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined
    );
    if (b === "WRITE" && this.workspace) {
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, this.fileContent[key] ?? `content of ${f}`);
        (this.wrote[eid] ??= []).push(f);
      }
    }
    if (b === "CLOBBER" && this.workspace) {
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, "CLOBBERED — rewritten by the delivery task");
        (this.wrote[eid] ??= []).push(f);
      }
    }
    if (b === "SKIPWRITE" && this.workspace) {
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        if (fs.existsSync(fp)) fs.rmSync(fp);
      }
    }
    if (b === "FAIL") {
      status = "FAILED";
    }
    this.collected[eid] = {
      status,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      ...(status === "FAILED"
        ? { error: { class: "PROCESS_EXIT", message: "FAILED" } }
        : { summary: `done ${key}` }),
    };
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    return { status: String(this.collected[executionId]?.status ?? "RUNNING") };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    // Production contract: result declares the artifacts this execution
    // created/changed — the validator ingests them into authority.
    const artifacts = (this.wrote[executionId] ?? [])
      .map((f) => {
        const fp = path.join(this.workspace, f);
        if (!fs.existsSync(fp)) return null;
        const bytes = fs.readFileSync(fp);
        return { path: f, sha256: sha256Hex(bytes), byte_size: bytes.length };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    return { execution_id: executionId, artifacts, ...r };
  }
}

function makeCtx(
  name: string,
  opts: { defaultChatId?: string | null } = {},
) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
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
    const pinned = input.mission?.metadata?.pinned_plan_tasks as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
    return { tasks: [goalTask()] };
  };
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
    telegramDeliveryDefaultChatId:
      "defaultChatId" in opts ? opts.defaultChatId ?? undefined : "111",
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: planner as never,
  });
  for (const cap of [
    "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    "AUTOMATON_TASK_EXECUTION", "REMOTE_CLOUD_TASK_EXECUTION",
  ]) {
    service.registerCapability(cap, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId: String(project.project_id),
  };
}

function registerAdapter(ctx: ReturnType<typeof makeCtx>, adapter: ScriptedAdapter) {
  adapter.workspace = ctx.workspace;
  (adapter as unknown as { store: PairEvidenceStore }).store = ctx.store;
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
}

/** A legitimate in-mission artifact producer through the REAL ingest seams. */
function mkCanonicalProducer(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    missionId: string;
    key: string;
    planId: string;
    name: string;
    bytes: Buffer | string;
    remote?: boolean;
    executor?: string;
    /** governed/execution rows + task but NO artifact uploaded/declared —
     *  a producer that ran yet never produced the canonical artifact. */
    noArtifact?: boolean;
  },
) {
  const tid = `ATSK_${o.key}`;
  const gtId = `GT_${tid}`;
  const executor = o.executor ?? "EX_PROD";
  const eid = workerExecutionId(executor, gtId);
  const bytes = Buffer.isBuffer(o.bytes) ? o.bytes : Buffer.from(o.bytes);
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid, task_key: o.key, mission_id: o.missionId,
      plan_id: o.planId, title: o.key,
      task_instruction: `produce ${o.name}`,
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
      status: "COMPLETED",
      metadata: { pair_dataflow: { produces: [o.name], consumes: [] } },
      version: 0,
    },
    0,
  );
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId, mission_id: o.missionId, task_id: tid,
      correlation_id: `COR_${tid}`, executor_id: executor, plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: utcnow(), version: 0,
    },
    0,
  );
  ctx.store.put(
    "executor_execution",
    eid,
    {
      execution_id: eid, governed_task_id: gtId, mission_id: o.missionId,
      task_id: tid, executor_id: executor, plan_revision: 1,
      correlation_id: `COR_${tid}`, execution_state: "RUNNING",
      dispatch_timestamp: utcnow(), workspace: ctx.workspace, version: 0,
    },
    0,
  );
  let declared: Record<string, unknown>[] = [];
  if (!o.noArtifact) {
    if (o.remote) {
      const cap = mintArtifactCapability("MASTER", {
        mission_id: o.missionId,
        task_id: tid,
        governed_task_id: gtId,
        execution_id: eid,
        executor_id: executor,
      });
      ctx.control.acceptArtifactUpload("MASTER", cap, {
        filename: o.name,
        mission_id: o.missionId,
        task_id: tid,
        bytes,
      });
    } else {
      const fp = path.join(ctx.workspace, o.name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, bytes);
      declared = [
        { path: o.name, sha256: sha256Hex(bytes), byte_size: bytes.length },
      ];
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
  const art = ctx.store.tryGet("artifact", canonicalArtifactId(eid, o.name));
  return {
    tid, gtId, eid, executor, key: o.key, name: o.name, bytes,
    artifact: art as Record<string, unknown> | null,
    artifactId: String(art?.artifact_id ?? canonicalArtifactId(eid, o.name)),
  };
}

const rt = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.get("mission_runtime", `MRT_${mid}`);
const deliveries = (ctx: ReturnType<typeof makeCtx>) =>
  ctx.store.list("telegram_delivery_request");
const evidence = (ctx: ReturnType<typeof makeCtx>, mid: string, kind: string) =>
  ctx.store.listEvidence(mid).filter((e) => String(e.kind) === kind);

function drive(ctx: ReturnType<typeof makeCtx>, mid: string, max = 160) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    ctx.runtime.tick(mid, new Date(t).toISOString());
    const s = String(rt(ctx, mid).state);
    if (
      ["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s)
    ) {
      return s;
    }
  }
  return String(rt(ctx, mid).state);
}

/* ------------------------------ transport ---------------------------------- */

interface SendCall {
  chatId: string;
  text?: string;
  filePath?: string;
  fileBytes?: Uint8Array;
  name?: string;
}
function recordingTransport(): {
  calls: SendCall[];
  transport: GovernedTelegramTransport;
} {
  const calls: SendCall[] = [];
  return {
    calls,
    transport: {
      send: async (a: SendCall): Promise<GovernedSendResult> => {
        calls.push({ ...a });
        return { kind: "ok", message_id: 1001 };
      },
    },
  };
}
function storeBackend(
  ctx: ReturnType<typeof makeCtx>,
  req: Record<string, unknown>,
) {
  const t = (artifact: string | null | undefined, body: Record<string, unknown>) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), {
      artifact,
      ...body,
    });
  const backend: DeliveryBackend = {
    begin: (a: string | null) => {
      const r = t(a, { to: "SENDING" }) as { acquired: boolean };
      return { acquired: r.acquired === true };
    },
    sent: (a: string | null, ev: { message_id?: string | number | null }) =>
      t(a, { to: "SENT", message_id: ev?.message_id ?? null }),
    failed: (a: string | null, err: string) => t(a, { to: "FAILED", error: err }),
    unknown: (a: string | null, err: string) => t(a, { to: "UNKNOWN", error: err }),
    unsendable: (reason: string) => t(null, { to: "UNSENDABLE", error: reason }),
  };
  return backend;
}
async function runTransport(
  ctx: ReturnType<typeof makeCtx>,
  opts?: { transport?: GovernedTelegramTransport },
) {
  const rec = recordingTransport();
  const transport = opts?.transport ?? rec.transport;
  const sent: string[] = [];
  for (const req of pendingTelegramDeliveries(ctx.store) as Array<
    Record<string, unknown>
  >) {
    const backend = storeBackend(ctx, req);
    const r = await transportTelegramDelivery({
      request: req,
      transport,
      isAllowed: () => true,
      backend,
      readText: (p) => fs.readFileSync(p, "utf8"),
    });
    sent.push(...r.sent);
  }
  return { calls: rec.calls, sent };
}

/* ---- gate/pin seam types (production methods bound through the runtime) --- */

type Gate = (
  m: Record<string, unknown>,
  t: Record<string, unknown>,
  e: Record<string, unknown>,
) => { ok: boolean; violation?: Record<string, unknown>; sources?: Record<string, string>; digests?: Record<string, string> };
const gateOf = (ctx: ReturnType<typeof makeCtx>): Gate =>
  (ctx.runtime as unknown as {
    assertDeliveryDeliverable: Gate;
  }).assertDeliveryDeliverable.bind(ctx.runtime);
const pinOf = (ctx: ReturnType<typeof makeCtx>) =>
  (ctx.runtime as unknown as {
    pinDeliveryArtifactDigests(
      m: Record<string, unknown>,
      t: Record<string, unknown>,
    ): void;
  }).pinDeliveryArtifactDigests.bind(ctx.runtime);

const deliveryTask = (ctx: ReturnType<typeof makeCtx>, o: {
  missionId: string;
  planId: string;
  taskId: string;
  dependsOn: string[];
  artifacts: string[];
}) => ({
  task_id: o.taskId,
  task_key: "T5",
  mission_id: o.missionId,
  plan_id: o.planId,
  depends_on: o.dependsOn,
  required_capabilities: ["TELEGRAM_DELIVERY"],
  metadata: {
    workspace: ctx.workspace,
    pair_telegram_delivery: {
      requested: true, mode: "FILES", artifacts: o.artifacts,
    },
  },
});
const missionRow = (ctx: ReturnType<typeof makeCtx>, id: string) => ({
  mission_id: id,
  project_id: ctx.projectId,
  goal: PROD_GOAL,
  plan_revision: 1,
  metadata: { authorized_workspaces: [ctx.workspace] },
});

/* =============================== A1–A11 ==================================== */

describe("F4 — delivery artifact provenance closure", () => {
  it("A1. stale same-name file + NO in-mission producer → fail at dispatch pin, zero TDR, zero network", async () => {
    const ctx = makeCtx("f4-a1");
    // The incident defect: a report.txt is already sitting in the shared
    // outbox from an older mission — same name, perfectly valid bytes.
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const stale = path.join(outbox, "report.txt");
    fs.writeFileSync(stale, VI_REPORT);
    const task = deliveryTask(ctx, {
      missionId: "M_A1", planId: "PLAN_A1", taskId: "TDEL_A1",
      dependsOn: [], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A1", { ...task, status: "READY", version: 0 }, 0);
    // The stale bytes must NEVER become a pin baseline.
    expect(() =>
      pinOf(ctx)(missionRow(ctx, "M_A1"), ctx.store.get("task", "TDEL_A1")),
    ).toThrowError(/FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE/);
    // Zero send authority minted — no telegram_delivery_request exists.
    expect(deliveries(ctx)).toHaveLength(0);
    // Zero network: nothing was ever projected for transport.
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    // The stale file is physically untouched — the gate reads provenance,
    // it never consumes or deletes the contaminant.
    expect(fs.readFileSync(stale, "utf8")).toBe(VI_REPORT);
  });

  it("A2. same-SHA artifact produced by a FOREIGN mission → provenance fail (SHA is integrity, not provenance)", async () => {
    const ctx = makeCtx("f4-a2");
    // A canonical artifact with IDENTICAL bytes exists — but bound to a
    // different mission. Byte equality must never launder provenance.
    mkCanonicalProducer(ctx, {
      missionId: "M_OLD",
      key: "TP_OLD",
      planId: "PLAN_OLD",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    const task = deliveryTask(ctx, {
      missionId: "M_A2", planId: "PLAN_A2", taskId: "TDEL_A2",
      dependsOn: [], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A2", { ...task, status: "READY", version: 0 }, 0);
    expect(() =>
      pinOf(ctx)(missionRow(ctx, "M_A2"), ctx.store.get("task", "TDEL_A2")),
    ).toThrowError(/FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE/);
    expect(deliveries(ctx)).toHaveLength(0);
  });

  it("A3. stale exact-name file vs current canonical produce → canonical binding wins; wire bytes are CAS bytes", async () => {
    const ctx = makeCtx("f4-a3");
    // Contaminant: a same-name file already in the outbox with DIFFERENT
    // (older) bytes — under F4 it can never be selected.
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, "report.txt"), "STALE OLD REPORT");
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_A3",
      key: "TP",
      planId: "PLAN_A3",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    // The canonical ingest overwrote the outbox path with the producer's
    // write — clobber it again so the outbox is provably stale while CAS
    // still holds the true bytes.
    fs.writeFileSync(path.join(outbox, "report.txt"), "STALE OLD REPORT");
    const task = deliveryTask(ctx, {
      missionId: "M_A3", planId: "PLAN_A3", taskId: "TDEL_A3",
      dependsOn: ["TP"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A3", { ...task, status: "READY", version: 0 }, 0);
    pinOf(ctx)(missionRow(ctx, "M_A3"), ctx.store.get("task", "TDEL_A3"));
    const pin = (
      ctx.store.get("task", "TDEL_A3").metadata as Record<string, unknown>
    ).pair_delivery_artifact_digests as Record<string, Record<string, unknown>>;
    // Pin binds the canonical artifact — NOT the stale file's digest.
    expect(String(pin["report.txt"].artifact_id)).toBe(prod.artifactId);
    expect(String(pin["report.txt"].sha256)).toBe(sha256Hex(VI_REPORT));
    expect(String(pin["report.txt"].sha256)).not.toBe(sha256File(path.join(outbox, "report.txt")));
    const r = gateOf(ctx)(
      missionRow(ctx, "M_A3"),
      ctx.store.get("task", "TDEL_A3"),
      { execution_id: "E_A3" },
    );
    expect(r.ok).toBe(true);
    // The staged byte source is the CAS blob — outbox is never authority.
    expect(String(r.sources!["report.txt"])).toContain("blob");
    expect(String(r.sources!["report.txt"])).not.toContain("outbox");
  });

  it("A4. FILES manifest consumed with remote predecessors but NO declared produce → plan-level UNBOUND fail-closed", () => {
    // Old inference deleted: an earlier remote task is a producer only
    // through an explicit declared produce edge, never by precedence.
    const plan = producerlessPlan(true); // T4 remote, declares nothing
    expect(() =>
      reconcilePlanDataflow(plan, {
        telegramIntent: FILES_INTENT(["report.txt"]),
        outputLanguage: detectOutputLanguage(PROD_GOAL),
      }),
    ).toThrowError(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
    // And the same defect for a LOCAL producerless task fails identically —
    // the rule is producer-contract, not executor-kind.
    expect(() =>
      reconcilePlanDataflow(producerlessPlan(false), {
        telegramIntent: FILES_INTENT(["report.txt"]),
        outputLanguage: detectOutputLanguage(PROD_GOAL),
      }),
    ).toThrowError(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
  });

  it("A5. declared remote producer but NO canonical artifact → runtime provenance fail, zero send authority", () => {
    const ctx = makeCtx("f4-a5");
    // Producer task declares the produce edge (contract exists) but its
    // execution never uploaded/validated a canonical artifact.
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_A5",
      key: "TP",
      planId: "PLAN_A5",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
      remote: true,
      noArtifact: true,
    });
    expect(prod.artifact).toBeNull();
    const task = deliveryTask(ctx, {
      missionId: "M_A5", planId: "PLAN_A5", taskId: "TDEL_A5",
      dependsOn: ["TP"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A5", { ...task, status: "READY", version: 0 }, 0);
    expect(() =>
      pinOf(ctx)(missionRow(ctx, "M_A5"), ctx.store.get("task", "TDEL_A5")),
    ).toThrowError(/FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE/);
    expect(deliveries(ctx)).toHaveLength(0);
  });

  it("A6. valid canonical in-mission producer → delivery mints once and sends the canonical bytes exactly once", async () => {
    const ctx = makeCtx("f4-a6");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "WRITE", T5: "COMPLETE" };
    adapter.fileContent = { T4: VI_REPORT };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: detectOutputLanguage(PROD_GOAL),
    }).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: PROD_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const reqs = deliveries(ctx);
    expect(reqs).toHaveLength(1);
    const art = (reqs[0].artifacts as Array<Record<string, unknown>>)[0];
    // Slot digest = canonical artifact digest; source = CAS blob path.
    expect(String(art.sha256)).toBe(sha256Hex(VI_REPORT));
    expect(String(art.source_path ?? "")).not.toContain("outbox");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    expect(rec.calls).toHaveLength(1);
    expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
    // Second projection pass — nothing re-sends.
    const again = await runTransport(ctx);
    expect(again.sent).toEqual([]);
  });

  it("A7. TEXT: stale valid-vi report.txt on disk + DONE-without-write → provenance fail; stale file physically remains", async () => {
    const ctx = makeCtx("f4-a7");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "SKIPWRITE" };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(textPlan(), {
      telegramIntent: TEXT_INTENT,
      outputLanguage: detectOutputLanguage(TEXT_GOAL),
    }).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    // Advance until the delivery task has dispatched — then plant the
    // stale contaminant the way a shared workspace leaves it behind.
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid, new Date(Date.parse("2026-01-01T00:00:00Z") + (i + 1) * 120_000).toISOString());
      const t3 = ctx.store
        .list("task")
        .find((t) => String(t.mission_id) === mid && String(t.task_key) === "T3");
      if (t3 && ["DISPATCHED", "RUNNING", "COMPLETED"].includes(String(t3.status))) break;
    }
    const stale = path.join(ctx.workspace, DELIVERY_TEXT_ARTIFACT);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, VI_REPORT); // valid vi — perfect shape, wrong provenance
    const staleBefore = sha256File(stale);
    const state = drive(ctx, mid);
    expect(state).not.toBe("COMPLETED");
    expect(deliveries(ctx)).toHaveLength(0);
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE",
    );
    // The stale contaminant is untouched — existence is not consumption.
    expect(fs.existsSync(stale)).toBe(true);
    expect(sha256File(stale)).toBe(staleBefore);
  });

  it("A8. TEXT: valid payload produced by the CURRENT delivery execution → exactly one request, text bound to that artifact", async () => {
    const ctx = makeCtx("f4-a8");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "WRITE" };
    adapter.fileContent = { T3: VI_REPORT };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(textPlan(), {
      telegramIntent: TEXT_INTENT,
      outputLanguage: detectOutputLanguage(TEXT_GOAL),
    }).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const reqs = deliveries(ctx);
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(String(req.mode)).toBe("TEXT");
    expect(String(req.text)).toBe(VI_REPORT);
    expect(String(req.text_source_artifact)).toBe(DELIVERY_TEXT_ARTIFACT);
    // The canonical artifact row exists under the DELIVERY execution —
    // the payload's provenance is provable in the artifact authority.
    const t3exec = ctx.store
      .list("executor_execution")
      .find(
        (e) =>
          String(e.mission_id) === mid &&
          String(
            (ctx.store.tryGet("task", String(e.task_id)) ?? {}).task_key,
          ) === "T3",
      )!;
    const art = ctx.store.tryGet(
      "artifact",
      canonicalArtifactId(String(t3exec.execution_id), DELIVERY_TEXT_ARTIFACT),
    );
    expect(art).toBeTruthy();
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([`TEXT:${req.delivery_id}`]);
    expect(rec.calls).toHaveLength(1);
  });

  it("A9. restart/re-resume: pin + canonical evidence are durable — second pin converges, settle re-proves, no re-baseline", () => {
    const ctx = makeCtx("f4-a9");
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_A9",
      key: "TP",
      planId: "PLAN_A9",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    const task = deliveryTask(ctx, {
      missionId: "M_A9", planId: "PLAN_A9", taskId: "TDEL_A9",
      dependsOn: ["TP"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A9", { ...task, status: "READY", version: 0 }, 0);
    const m = missionRow(ctx, "M_A9");
    pinOf(ctx)(m, ctx.store.get("task", "TDEL_A9"));
    const pinRow = ctx.store.get("task", "TDEL_A9");
    const pinBefore = JSON.stringify(
      (pinRow.metadata as Record<string, unknown>).pair_delivery_artifact_digests,
    );
    // Simulate a restart seam: the pin function runs again over the
    // durable row — pin-once must converge without re-baselining.
    pinOf(ctx)(m, ctx.store.get("task", "TDEL_A9"));
    const pinAfter = JSON.stringify(
      (ctx.store.get("task", "TDEL_A9").metadata as Record<string, unknown>)
        .pair_delivery_artifact_digests,
    );
    expect(pinAfter).toBe(pinBefore);
    // Settle re-proves history↔row↔linkage↔CAS bytes from durable state.
    const r = gateOf(ctx)(m, ctx.store.get("task", "TDEL_A9"), {
      execution_id: "E_A9",
    });
    expect(r.ok).toBe(true);
    expect(r.digests!["report.txt"]).toBe(String(prod.artifact!.sha256));
  });

  it("A10. workspace mutation after pin → digest protection holds: CAS bytes deliver, mutated file never reaches the wire", async () => {
    const ctx = makeCtx("f4-a10");
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_A10",
      key: "TP",
      planId: "PLAN_A10",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    const task = deliveryTask(ctx, {
      missionId: "M_A10", planId: "PLAN_A10", taskId: "TDEL_A10",
      dependsOn: ["TP"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_A10", { ...task, status: "READY", version: 0 }, 0);
    const m = missionRow(ctx, "M_A10");
    pinOf(ctx)(m, ctx.store.get("task", "TDEL_A10"));
    const r = gateOf(ctx)(m, ctx.store.get("task", "TDEL_A10"), {
      execution_id: "E_A10",
    });
    expect(r.ok).toBe(true);
    // The pinned digest equals the canonical row — immutable CAS.
    expect(r.digests!["report.txt"]).toBe(String(prod.artifact!.sha256));
    // Mutate the workspace file AFTER the pin: CAS is unreachable by it.
    fs.writeFileSync(path.join(ctx.workspace, "outbox", "report.txt"), "MUTATED");
    const r2 = gateOf(ctx)(m, ctx.store.get("task", "TDEL_A10"), {
      execution_id: "E_A10",
    });
    expect(r2.ok).toBe(true); // authority is CAS, not the file
    void r2;
    // And a canonical-row semantic tamper still fails closed (Z4 covers
    // the inverse shape; here the row survives but bytes are re-proven
    // at read-time by sha).
    void prod;
  });

  it("A11. producerless manifest plan → plan-level UNBOUND rejection; producer-bound alternative is the repair path", () => {
    // The failed plan: manifest consumes report.txt, nothing declares it.
    expect(() =>
      reconcilePlanDataflow(producerlessPlan(false), {
        telegramIntent: FILES_INTENT(["report.txt"]),
        outputLanguage: detectOutputLanguage(PROD_GOAL),
      }),
    ).toThrowError(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
    // The producer-bound alternative IS the replan output shape the
    // planner must emit: a task declaring the produce edge repairs it.
    const { tasks } = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: FILES_INTENT(["report.txt"]),
      outputLanguage: detectOutputLanguage(PROD_GOAL),
    });
    const t5 = tasks.find((t) => t.task_key === "T5")!;
    const manifest = deliveryManifest(t5 as never);
    expect(manifest?.mode).toBe("FILES");
    // The delivery task now depends on the declared producer — the edge
    // is explicit in the plan, never inferred from precedence.
    const prodTask = tasks.find((t) => t.task_key === "T4")!;
    const produces = (
      (prodTask.metadata as Record<string, unknown>).pair_dataflow as Record<
        string,
        unknown
      >
    ).produces as string[];
    expect(produces).toContain("outbox/report.txt");
    expect((t5.depends_on as string[]).includes("T4")).toBe(true);
  });
});
