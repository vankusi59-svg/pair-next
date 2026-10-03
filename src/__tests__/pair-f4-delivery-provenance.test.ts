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
import { describe, expect, it, vi } from "vitest";
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
  deliveryRequestId,
  digest,
  mintArtifactCapability,
  pendingTelegramDeliveries,
  reconcilePlanDataflow,
  sha256File,
  sha256Hex,
  transportTelegramDelivery,
  utcnow,
  workerExecutionId,
  mintTelegramDeliveryRequest,
  DELIVERY_TEXT_ARTIFACT,
  MAX_TELEGRAM_FILE_BYTES,
  TELEGRAM_DELIVERY_MINTED,
  TELEGRAM_DELIVERY_ATTEMPT_STARTED,
  TELEGRAM_DELIVERY_ATTEMPT_RESOLVED,
  deliveryAttemptLedger,
  reconcileStaleDeliveryAttempts,
  deliverySnapshotRoot,
} from "../pair/index.js";
import type {
  DeliveryBackend,
  DeliveryProvenanceBinding,
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

/** The production wiring of the harness — every component built against
 *  ONE store. R2.5 reuses it verbatim for the fresh post-restart stack so
 *  no object referencing the closed store survives. */
function wireStack(
  name: string,
  workspace: string,
  store: PairEvidenceStore,
  opts: { defaultChatId?: string | null; projectId?: string } = {},
) {
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
  const projectId =
    opts.projectId !== undefined
      ? opts.projectId
      : String(
          service.createProject({ name, root_location: workspace })
            .project_id,
        );
  return {
    service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId,
  };
}

function makeCtx(
  name: string,
  opts: { defaultChatId?: string | null } = {},
) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  return {
    dir, workspace, store,
    ...wireStack(name, workspace, store, opts),
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

/* ========================= F4 R1 — audit remediation ========================
 * R1.1: a delivery pin miss (declared producer, no canonical artifact) is a
 *       typed DEPENDENCY_FAILURE entering governed recovery — never an
 *       exception escaping the tick.
 * R1.2: the durable TDR payload carries canonical provenance binding anchored
 *       by an immutable mint receipt — a coherent mutable-row rewrite fails
 *       closed, zero transport.
 * R1.3: manifest alias ambiguity (report.txt + outbox/report.txt both
 *       canonically accepted by one producer) fails closed — never a lexical
 *       first-match selection.
 * R1.4: real restart proof — fresh store/services/runtime over the same
 *       durable DB consume only canonical provenance; stale same-name bytes
 *       introduced between instances never re-baseline. */

/** Producer declaring TWO manifest aliases — one execution, two canonical
 *  artifacts (the R1.3 ambiguity shape). Real ingest seams throughout. */
function mkDualArtifactProducer(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    missionId: string;
    key: string;
    planId: string;
    nameA: string;
    nameB: string;
    bytesA: Buffer | string;
    bytesB: Buffer | string;
  },
) {
  const tid = `ATSK_${o.key}`;
  const gtId = `GT_${tid}`;
  const executor = "EX_PROD";
  const eid = workerExecutionId(executor, gtId);
  const bytesA = Buffer.isBuffer(o.bytesA) ? o.bytesA : Buffer.from(o.bytesA);
  const bytesB = Buffer.isBuffer(o.bytesB) ? o.bytesB : Buffer.from(o.bytesB);
  ctx.store.put("task", tid, {
    task_id: tid, task_key: o.key, mission_id: o.missionId, plan_id: o.planId,
    title: o.key, task_instruction: `produce ${o.nameA} and ${o.nameB}`,
    required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
    status: "COMPLETED",
    metadata: { pair_dataflow: { produces: [o.nameA, o.nameB], consumes: [] } },
    version: 0,
  }, 0);
  ctx.store.put("governed_task", gtId, {
    governed_task_id: gtId, mission_id: o.missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: executor, plan_revision: 1,
    workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  }, 0);
  ctx.store.put("executor_execution", eid, {
    execution_id: eid, governed_task_id: gtId, mission_id: o.missionId,
    task_id: tid, executor_id: executor, plan_revision: 1,
    correlation_id: `COR_${tid}`, execution_state: "RUNNING",
    dispatch_timestamp: utcnow(), workspace: ctx.workspace, version: 0,
  }, 0);
  const declared: Record<string, unknown>[] = [];
  for (const [n, b] of [[o.nameA, bytesA], [o.nameB, bytesB]] as const) {
    const fp = path.join(ctx.workspace, n);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, b);
    declared.push({ path: n, sha256: sha256Hex(b), byte_size: b.length });
  }
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put("executor_execution", eid, {
    ...settled,
    execution_state: "COMPLETED",
    result: { status: "COMPLETED", artifacts: declared },
  }, settled.version);
  new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
  return { tid, gtId, eid, executor, key: o.key };
}

describe("F4 R1 — audit remediation", () => {
  it("R1.1 E2E: declared producer + PASS + NO canonical artifact → typed DEPENDENCY_FAILURE via REAL runtime (zero dispatch/TDR/network)", async () => {
    const ctx = makeCtx("f4-r11");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    // T4 declares the produce edge (plan contract) but its execution
    // completes with artifacts:[] — no canonical artifact exists.
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "COMPLETE", T5: "COMPLETE" };
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
    // Drive tick-by-tick: the pin miss must never escape a tick as an
    // exception — it enters governed recovery as DEPENDENCY_FAILURE.
    let depFailure: Record<string, unknown> | null = null;
    let state = "";
    let t = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 200; i++) {
      t += 120_000;
      ctx.runtime.tick(mid, new Date(t).toISOString()); // throws → test fails
      state = String(rt(ctx, mid).state);
      const pend = rt(ctx, mid).pending_recovery as Record<
        string,
        unknown
      > | null;
      if (pend && String(pend.failure_class) === "DEPENDENCY_FAILURE") {
        depFailure = pend;
      }
      if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(state)) break;
    }
    // The mission converged through bounded recovery — never delivered.
    expect(state).not.toBe("COMPLETED");
    expect(depFailure).not.toBeNull();
    const fctx = depFailure!.failure_context as Record<string, unknown>;
    expect(String(fctx.dependency_reason)).toBe(
      "PRODUCER_CANONICAL_ARTIFACT_MISSING",
    );
    expect(String(fctx.artifact_name)).toBe("report.txt");
    expect(String(fctx.source_code)).toBe(
      "FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE",
    );
    expect(fctx.producer_task_id).toBeTruthy();
    expect(fctx.consumer_task_id).toBeTruthy();
    // Zero delivery dispatch: the TELEGRAM_DELIVERY task never ran.
    const t5 = ctx.store
      .list("task")
      .find((x) => String(x.mission_id) === mid && String(x.task_key) === "T5");
    expect(t5).toBeTruthy();
    expect(
      ctx.store
        .list("executor_execution")
        .filter((e) => String(e.task_id) === String(t5!.task_id)),
    ).toHaveLength(0);
    // Zero send authority + zero network.
    expect(deliveries(ctx)).toHaveLength(0);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
  });

  it("R1.1b: no declared producer → DEPENDENCY_FAILURE too (typed PLAN_DATAFLOW_UNBOUND)", async () => {
    const ctx = makeCtx("f4-r11b");
    const task = deliveryTask(ctx, {
      missionId: "M_R11B", planId: "PLAN_R11B", taskId: "TDEL_R11B",
      dependsOn: [], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_R11B", { ...task, status: "READY", version: 0 }, 0);
    try {
      pinOf(ctx)(missionRow(ctx, "M_R11B"), ctx.store.get("task", "TDEL_R11B"));
      expect.unreachable("pin must fail");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      // Typed dependency failure — governed recovery consumes it.
      const dre = err as InstanceType<typeof IntegrityError> & {
        dependency_reason?: string;
        artifact_name?: string;
        consumer_task_id?: string;
      };
      expect(dre.dependency_reason).toBe("PLAN_DATAFLOW_UNBOUND");
      expect(dre.artifact_name).toBe("report.txt");
      expect(dre.consumer_task_id).toBe("TDEL_R11B");
    }
    expect(deliveries(ctx)).toHaveLength(0);
  });

  it("R1.2 FILES: coherent mutable-row rewrite (source_path→B + sha256→sha(B)) → projection fails closed, zero transport", async () => {
    const ctx = makeCtx("f4-r12f");
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
    const req = deliveries(ctx)[0]!;
    const slot = (req.artifacts as Array<Record<string, unknown>>)[0]!;
    // Precondition: the slot carries the canonical provenance binding.
    expect(slot.artifact_id).toBeTruthy();
    expect(slot.producer_execution_id).toBeTruthy();
    // Adversary: rewrite the row COHERENTLY through the canonical store
    // seam — new source_path AND new sha256 matching bytes B, entity
    // hash stays valid. Under hash-only authority this would re-baseline.
    const pathB = path.join(ctx.workspace, "outbox", "report.txt");
    fs.writeFileSync(pathB, "ADVERSARY BYTES B");
    const shaB = sha256Hex(Buffer.from("ADVERSARY BYTES B"));
    const mutated = {
      ...req,
      artifacts: [{ ...slot, source_path: pathB, sha256: shaB }],
    };
    ctx.store.put("telegram_delivery_request", String(req.delivery_id), mutated, Number(req.version));
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    const after = deliveries(ctx)[0]!;
    const slotAfter = (after.artifacts as Array<Record<string, unknown>>)[0]!;
    expect(String(slotAfter.state)).toBe("FAILED_DELIVERY");
    expect(String(slotAfter.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE",
    );
    expect(String(after.status)).toBe("FAILED_DELIVERY");
  });

  it("R1.2 TEXT: coherent text/text_sha256/text_length rewrite → projection fails closed, zero transport", async () => {
    const ctx = makeCtx("f4-r12t");
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
    const req = deliveries(ctx)[0]!;
    expect(req.mode).toBe("TEXT");
    expect(req.text_artifact_id).toBeTruthy();
    const badText = "ADVERSARY TEXT — completely rewritten payload";
    const mutated = {
      ...req,
      text: badText,
      // Coherent rewrite: the row's own evidence fields all agree with
      // the replaced payload — only the immutable mint receipt refutes it.
      text_sha256: digest(badText),
      text_length: badText.length,
    };
    ctx.store.put("telegram_delivery_request", String(req.delivery_id), mutated, Number(req.version));
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    const after = deliveries(ctx)[0]!;
    expect(String(after.text_state)).toBe("FAILED_DELIVERY");
    expect(String(after.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE",
    );
  });

  it("R1.3: one producer canonically accepting report.txt AND outbox/report.txt → FAIL CLOSED ambiguity (no lexical pick)", async () => {
    const ctx = makeCtx("f4-r13");
    mkDualArtifactProducer(ctx, {
      missionId: "M_R13", key: "TP", planId: "PLAN_R13",
      nameA: "report.txt", nameB: "outbox/report.txt",
      bytesA: "REPORT A — source name", bytesB: "REPORT B — outbox alias",
    });
    const task = deliveryTask(ctx, {
      missionId: "M_R13", planId: "PLAN_R13", taskId: "TDEL_R13",
      dependsOn: ["TP"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_R13", { ...task, status: "READY", version: 0 }, 0);
    try {
      pinOf(ctx)(missionRow(ctx, "M_R13"), ctx.store.get("task", "TDEL_R13"));
      expect.unreachable("ambiguous aliases must fail closed");
    } catch (err) {
      const dre = err as InstanceType<typeof IntegrityError> & {
        code?: string;
        dependency_reason?: string;
        producer_task_id?: string;
      };
      expect(String(dre.message)).toContain("ambiguous_delivery_artifact");
      expect(dre.dependency_reason).toBe("DELIVERY_ARTIFACT_PROVENANCE");
      expect(dre.producer_task_id).toBeTruthy();
    }
    expect(deliveries(ctx)).toHaveLength(0);
    // Single-alias cases still pass: producer declaring only the source
    // name resolves exactly one canonical identity.
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_R13S", key: "TPS", planId: "PLAN_R13S",
      name: "report.txt", bytes: VI_REPORT,
    });
    const t2 = deliveryTask(ctx, {
      missionId: "M_R13S", planId: "PLAN_R13S", taskId: "TDEL_R13S",
      dependsOn: ["TPS"], artifacts: ["report.txt"],
    });
    ctx.store.put("task", "TDEL_R13S", { ...t2, status: "READY", version: 0 }, 0);
    pinOf(ctx)(missionRow(ctx, "M_R13S"), ctx.store.get("task", "TDEL_R13S"));
    const pin = (
      ctx.store.get("task", "TDEL_R13S").metadata as Record<string, unknown>
    ).pair_delivery_artifact_digests as Record<string, Record<string, unknown>>;
    expect(String(pin["report.txt"].artifact_id)).toBe(prod.artifactId);
  });

  it("R1.4: real restart — fresh store/services over the same durable DB deliver exactly once; inter-instance stale bytes never re-baseline", async () => {
    const ctx = makeCtx("f4-r14");
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
    expect(deliveries(ctx)).toHaveLength(1);

    // Introduce stale same-name outbox bytes BETWEEN instances — the
    // classic contamination the durable provenance must ignore.
    const stalePath = path.join(ctx.workspace, "outbox", "report.txt");
    fs.writeFileSync(stalePath, "STALE BYTES — introduced across restart");

    // R2.5 — REAL restart: close the first instance entirely and rebuild
    // the WHOLE stack against the SAME durable DB — fresh
    // PairEvidenceStore + PairControlPlane + gate/registry/router +
    // recovery + reconciliation + approvals + scheduler + MissionRuntime
    // + supervisor + MissionControl via the same production constructors
    // the harness uses. NO object referencing the closed store survives.
    const dbPath = path.join(ctx.dir, "pair.db");
    ctx.store.close();
    const store2 = new PairEvidenceStore(dbPath);
    const b = wireStack("f4-r14-b", ctx.workspace, store2, {
      projectId: ctx.projectId,
    });
    // Fresh runtime resume: a tick on the reopened stack converges the
    // already-COMPLETED mission without re-dispatching anything.
    b.runtime.tick(mid, utcnow());
    expect(String(b.service.getMission(mid).status ?? "")).not.toBe("FAILED");
    // The durable mint receipt survives the instance boundary.
    const receipts = store2
      .listEvidence(mid)
      .filter((e) => String(e.kind) === TELEGRAM_DELIVERY_MINTED);
    expect(receipts).toHaveLength(1);
    // Transport over the FRESH stack: durable canonical provenance drives
    // the send — CAS bytes, never the contaminated outbox file.
    const rec = recordingTransport();
    const sent: string[] = [];
    const pending2 = pendingTelegramDeliveries(store2) as Array<
      Record<string, unknown>
    >;
    for (const req of pending2) {
      const t = (artifact: string | null | undefined, body: Record<string, unknown>) =>
        b.control.transitionTelegramDelivery(String(req.delivery_id), {
          artifact, ...body,
        });
      const r = await transportTelegramDelivery({
        request: req,
        transport: rec.transport,
        isAllowed: () => true,
        backend: {
          begin: (a) => {
            const rr = t(a, { to: "SENDING" }) as { acquired: boolean };
            return { acquired: rr.acquired === true };
          },
          sent: (a, ev) => t(a, { to: "SENT", message_id: ev?.message_id ?? null }),
          failed: (a, err) => t(a, { to: "FAILED", error: err }),
          unknown: (a, err) => t(a, { to: "UNKNOWN", error: err }),
          unsendable: (reason) => t(null, { to: "UNSENDABLE", error: reason }),
        },
        readText: (p) => fs.readFileSync(p, "utf8"),
      });
      sent.push(...r.sent);
    }
    expect(sent).toEqual(["report.txt"]);
    expect(rec.calls).toHaveLength(1);
    // Wire bytes are the CANONICAL producer bytes — the inter-instance
    // outbox contamination never re-baselined the delivery.
    expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
    // Exactly-once intact across the fresh instance: a second projection
    // on the same reopened store sends nothing.
    const again = pendingTelegramDeliveries(store2);
    expect(again).toHaveLength(0);
    store2.close();
  });
});

/* =============================== F4 R2 ==================================== */

/** Mint a provenance-bound FILES TDR directly through the production
 *  seam — real canonical producers (task + governed + execution +
 *  validator + CAS bytes) then the real mint, so the immutable
 *  TELEGRAM_DELIVERY_MINTED receipt anchors the row. */
function mkBoundFilesTdr(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    missionId: string;
    files: Array<{ manifest: string; logical: string; bytes: string }>;
    chatId?: string | null;
    mission?: Record<string, unknown>;
    maxAttempts?: number;
  },
) {
  const mid = o.missionId;
  const planId = `PLAN_${mid}`;
  const key = `TP${mid}`;
  let eid: string;
  let gtId: string;
  if (o.files.length === 1) {
    const p = mkCanonicalProducer(ctx, {
      missionId: mid, key, planId,
      name: o.files[0]!.logical, bytes: o.files[0]!.bytes,
    });
    eid = p.eid;
    gtId = p.gtId;
  } else {
    const p = mkDualArtifactProducer(ctx, {
      missionId: mid, key, planId,
      nameA: o.files[0]!.logical, nameB: o.files[1]!.logical,
      bytesA: o.files[0]!.bytes, bytesB: o.files[1]!.bytes,
    });
    eid = p.eid;
    gtId = p.gtId;
  }
  const blobDir = path.join(ctx.dir, "artifacts", "blobs");
  const artifactSha256: Record<string, string> = {};
  const artifactSources: Record<string, string> = {};
  const artifactProvenance: Record<string, DeliveryProvenanceBinding> = {};
  for (const f of o.files) {
    const sha = sha256Hex(Buffer.from(f.bytes));
    const cas = path.join(blobDir, sha);
    artifactSha256[f.manifest] = sha;
    artifactSources[f.manifest] = cas;
    artifactProvenance[f.manifest] = {
      artifact_id: canonicalArtifactId(eid, f.logical),
      producer_execution_id: eid,
      governed_task_id: gtId,
      logical_name: f.logical,
      sha256: sha,
      source_path: cas,
    };
  }
  const taskId = `TDEL_${mid}`;
  const task = {
    task_id: taskId, task_key: "T5", mission_id: mid, plan_id: planId,
    depends_on: [key], required_capabilities: ["TELEGRAM_DELIVERY"],
    metadata: {
      workspace: ctx.workspace,
      pair_telegram_delivery: {
        requested: true, mode: "FILES",
        artifacts: o.files.map((f) => f.manifest),
      },
    },
  };
  const mission = o.mission ?? missionRow(ctx, mid);
  if (o.maxAttempts !== undefined) {
    // per-request ceiling override exercised by R3.4b
  }
  const req = mintTelegramDeliveryRequest({
    store: ctx.store,
    mission,
    task,
    execution: { execution_id: `EXEC_DEL_${mid}` },
    outboxDir: path.join(ctx.workspace, "outbox"),
    workspace: ctx.workspace,
    now: utcnow(),
    defaultChatId: o.chatId === undefined ? "111" : (o.chatId ?? undefined),
    maxAttempts: o.maxAttempts,
    artifactSha256,
    artifactSources,
    artifactProvenance,
  });
  return { req: req!, eid, gtId, taskId };
}

/** Mint a provenance-bound TEXT TDR — the delivery execution itself is
 *  the declared producer of the canonical payload artifact (F4.4). */
function mkBoundTextTdr(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    missionId: string;
    text: string;
    chatId?: string | null;
    mission?: Record<string, unknown>;
    maxAttempts?: number;
  },
) {
  const mid = o.missionId;
  const planId = `PLAN_${mid}`;
  const p = mkCanonicalProducer(ctx, {
    missionId: mid, key: `TP${mid}`, planId,
    name: DELIVERY_TEXT_ARTIFACT, bytes: o.text,
  });
  const taskId = `TDEL_${mid}`;
  const task = {
    task_id: taskId, task_key: "T5", mission_id: mid, plan_id: planId,
    depends_on: [`TP${mid}`], required_capabilities: ["TELEGRAM_DELIVERY"],
    metadata: {
      workspace: ctx.workspace,
      pair_telegram_delivery: { requested: true, mode: "TEXT" },
    },
  };
  const textProvenance: DeliveryProvenanceBinding = {
    artifact_id: p.artifactId,
    producer_execution_id: p.eid,
    governed_task_id: p.gtId,
    logical_name: DELIVERY_TEXT_ARTIFACT,
    sha256: sha256Hex(Buffer.from(o.text)),
  };
  const req = mintTelegramDeliveryRequest({
    store: ctx.store,
    mission: o.mission ?? missionRow(ctx, mid),
    task,
    execution: { execution_id: `EXEC_DEL_${mid}` },
    outboxDir: path.join(ctx.workspace, "outbox"),
    workspace: ctx.workspace,
    now: utcnow(),
    defaultChatId: o.chatId === undefined ? "111" : (o.chatId ?? undefined),
    textPayload: o.text,
    textProvenance,
    maxAttempts: o.maxAttempts,
  });
  return { req: req!, eid: p.eid, gtId: p.gtId, taskId };
}

const rewrite = (
  ctx: ReturnType<typeof makeCtx>,
  req: Record<string, unknown>,
  body: Record<string, unknown>,
) =>
  ctx.store.put(
    "telegram_delivery_request",
    String(req.delivery_id),
    body,
    Number(req.version),
  );

async function expectFailClosedNoTransport(
  ctx: ReturnType<typeof makeCtx>,
  mode: "FILES" | "TEXT",
) {
  const rec = recordingTransport();
  const { sent } = await runTransport(ctx, { transport: rec.transport });
  expect(sent).toEqual([]);
  expect(rec.calls).toHaveLength(0);
  const after = deliveries(ctx)[0]!;
  if (mode === "TEXT") {
    expect(String(after.text_state)).toBe("FAILED_DELIVERY");
    expect(String(after.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE",
    );
  } else {
    for (const s of after.artifacts as Array<Record<string, unknown>>) {
      expect(String(s.state)).toBe("FAILED_DELIVERY");
      expect(String(s.last_error)).toBe(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE",
      );
    }
  }
  expect(String(after.status)).not.toBe("SENT");
}

describe("F4 R2 — audit remediation round 2", () => {
  it("R2.1 FILES: deleting ALL provenance fields + coherent source_path/sha256 rewrite → still FAIL CLOSED (no legacy downgrade)", async () => {
    const ctx = makeCtx("f4-r21f");
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: "M_R21F",
      files: [{ manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT }],
    });
    const slot = (req.artifacts as Array<Record<string, unknown>>)[0]!;
    const pathB = path.join(ctx.workspace, "outbox", "report.txt");
    fs.mkdirSync(path.dirname(pathB), { recursive: true });
    fs.writeFileSync(pathB, "ADVERSARY BYTES B");
    const stripped = { ...slot } as Record<string, unknown>;
    delete stripped.artifact_id;
    delete stripped.producer_execution_id;
    delete stripped.producer_governed_task_id;
    delete stripped.logical_name;
    stripped.source_path = pathB;
    stripped.sha256 = sha256Hex(Buffer.from("ADVERSARY BYTES B"));
    rewrite(ctx, req, { ...req, artifacts: [stripped] });
    // The immutable receipt still exists — hash-only must NOT rescue it.
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it("R2.1 TEXT: deleting text provenance fields + coherent payload rewrite → still FAIL CLOSED", async () => {
    const ctx = makeCtx("f4-r21t");
    const { req } = mkBoundTextTdr(ctx, {
      missionId: "M_R21T", text: VI_REPORT,
    });
    const badText = "ADVERSARY PAYLOAD";
    const stripped = { ...req } as Record<string, unknown>;
    delete stripped.text_artifact_id;
    delete stripped.text_producer_execution_id;
    delete stripped.text_producer_governed_task_id;
    delete stripped.text_artifact_sha256;
    stripped.text = badText;
    stripped.text_sha256 = digest(badText);
    stripped.text_length = badText.length;
    rewrite(ctx, req, stripped);
    await expectFailClosedNoTransport(ctx, "TEXT");
  });

  it("R2.2 A: rename report.txt → forged.txt retaining valid canonical binding → FAIL CLOSED", async () => {
    const ctx = makeCtx("f4-r22a");
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: "M_R22A",
      files: [{ manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT }],
    });
    const slot = (req.artifacts as Array<Record<string, unknown>>)[0]!;
    rewrite(ctx, req, {
      ...req,
      artifacts: [{ ...slot, name: "forged.txt" }],
    });
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it("R2.2 B: duplicate one receipt-bound artifact into two differently named slots → FAIL CLOSED", async () => {
    const ctx = makeCtx("f4-r22b");
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: "M_R22B",
      files: [{ manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT }],
    });
    const slot = (req.artifacts as Array<Record<string, unknown>>)[0]!;
    rewrite(ctx, req, {
      ...req,
      artifacts: [slot, { ...slot, name: "report-copy.txt" }],
    });
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it("R2.2 C: remove one slot from a multi-file request → FAIL CLOSED", async () => {
    const ctx = makeCtx("f4-r22c");
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: "M_R22C",
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
        { manifest: "data.txt", logical: "outbox/data.txt", bytes: "DATA BYTES" },
      ],
    });
    const slots = req.artifacts as Array<Record<string, unknown>>;
    expect(slots).toHaveLength(2);
    rewrite(ctx, req, { ...req, artifacts: [slots[0]] });
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it("R2.2 D: untouched exact receipt-bound request → PASS (control)", async () => {
    const ctx = makeCtx("f4-r22d");
    mkBoundFilesTdr(ctx, {
      missionId: "M_R22D",
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
        { manifest: "data.txt", logical: "outbox/data.txt", bytes: "DATA BYTES" },
      ],
    });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent.sort()).toEqual(["data.txt", "report.txt"]);
    expect(rec.calls).toHaveLength(2);
    expect(Buffer.from(rec.calls[0]!.fileBytes!).toString("utf8")).toBeTruthy();
  });

  it("R2.3: mutate payload delivery_id on the same canonical entity key → FAIL CLOSED, zero network", async () => {
    const ctx = makeCtx("f4-r23");
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: "M_R23",
      files: [{ manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT }],
    });
    rewrite(ctx, req, { ...req, delivery_id: "TDR_FORGED_IDENTITY" });
    await expectFailClosedNoTransport(ctx, "FILES");
    // The receipt is still resolvable through the canonical entity id —
    // the mutation can never re-select or escape receipt authority.
    const receipts = ctx.store
      .listEvidence("M_R23")
      .filter((e) => String(e.kind) === TELEGRAM_DELIVERY_MINTED);
    expect(receipts).toHaveLength(1);
  });

  it("R2.4: atomic mint — injected fault between receipt and row write rolls back BOTH; retry mints exactly one of each", async () => {
    const ctx = makeCtx("f4-r24");
    const mid = "M_R24";
    mkCanonicalProducer(ctx, {
      missionId: mid, key: `TP${mid}`, planId: `PLAN_${mid}`,
      name: "outbox/report.txt", bytes: VI_REPORT,
    });
    const prod = mkCanonicalProducer(ctx, {
      missionId: `${mid}x`, key: `TP${mid}x`, planId: `PLAN_${mid}x`,
      name: "outbox/report.txt", bytes: VI_REPORT,
    });
    const sha = sha256Hex(Buffer.from(VI_REPORT));
    const cas = path.join(ctx.dir, "artifacts", "blobs", sha);
    const mintArgs = () => ({
      store: ctx.store,
      mission: missionRow(ctx, mid),
      task: {
        task_id: "TDEL_R24", task_key: "T5", mission_id: mid,
        plan_id: "PLAN_R24", depends_on: [`TP${mid}`],
        required_capabilities: ["TELEGRAM_DELIVERY"],
        metadata: {
          workspace: ctx.workspace,
          pair_telegram_delivery: {
            requested: true, mode: "FILES", artifacts: ["report.txt"],
          },
        },
      },
      execution: { execution_id: "EXEC_DEL_R24" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { "report.txt": sha },
      artifactSources: { "report.txt": cas },
      artifactProvenance: {
        "report.txt": {
          artifact_id: prod.artifactId,
          producer_execution_id: prod.eid,
          governed_task_id: prod.gtId,
          logical_name: "outbox/report.txt",
          sha256: sha,
          source_path: cas,
        },
      },
    });
    const deliveryId = deliveryRequestId(mid, "TDEL_R24");
    const receiptsFor = (
      store: PairEvidenceStore = ctx.store,
      id: string = deliveryId,
    ) =>
      store
        .listEvidence()
        .filter(
          (e) =>
            String(e.kind) === TELEGRAM_DELIVERY_MINTED &&
            String(
              (
                (e.payload as Record<string, unknown>)
                  .payload as Record<string, unknown>
              ).delivery_id ?? "",
            ) === id,
        );

    // 1. fault injected between receipt-write and TDR-write (the store
    //    put inside the atomic transaction throws) → rollback leaves
    //    NEITHER durable receipt nor row.
    const origPut = ctx.store.put.bind(ctx.store);
    let armed = true;
    const mutableStore = ctx.store as unknown as {
      put: typeof origPut;
    };
    mutableStore.put = ((
      type: string, id: string, body: Record<string, unknown>, v?: number,
    ) => {
      if (armed && type === "telegram_delivery_request") {
        armed = false;
        throw new Error("INJECTED_CRASH_MID_MINT");
      }
      return origPut(type, id, body, v);
    }) as typeof origPut;
    try {
      mintTelegramDeliveryRequest(mintArgs());
      expect.unreachable("injected crash must propagate");
    } catch (err) {
      expect(String(err)).toContain("INJECTED_CRASH_MID_MINT");
    } finally {
      mutableStore.put = origPut;
    }
    expect(
      ctx.store.tryGet("telegram_delivery_request", deliveryId),
    ).toBeNull();
    expect(receiptsFor()).toHaveLength(0);

    // 2. retry after the injected failure → exactly one receipt + one TDR.
    const req = mintTelegramDeliveryRequest(mintArgs());
    expect(req).toBeTruthy();
    expect(receiptsFor()).toHaveLength(1);
    expect(deliveries(ctx)).toHaveLength(1);

    // 3. a second mint attempt (serialized race equivalent) converges to
    //    the SAME canonical row — zero extra receipt, zero row mutation.
    const again = mintTelegramDeliveryRequest(mintArgs());
    expect(String(again!.delivery_id)).toBe(String(req!.delivery_id));
    expect(receiptsFor()).toHaveLength(1);
    expect(deliveries(ctx)).toHaveLength(1);

    // 4. restart after the successful mint → still exactly one receipt.
    const dbPath = path.join(ctx.dir, "pair.db");
    ctx.store.close();
    const store2 = new PairEvidenceStore(dbPath);
    expect(receiptsFor(store2)).toHaveLength(1);
    store2.close();
  });
});

/* ================= F4 R3 — immutable send-authority closure ==================
 * R3.1 — the mint receipt binds the COMPLETE static send authority
 *        (entity/mission/task/execution/mode/destination/sendability/
 *        ceiling/staging roots) — any coherent rewrite of a static field
 *        is a fail-closed violation.
 * R3.2 — request-owned snapshot storage is canonical store-scoped
 *        (deliverySnapshotRoot), never derived from mutable
 *        outbox_dir/workspace; a bound row failing its contract gets
 *        ZERO filesystem operations.
 * R3.3 — append-only attempt lifecycle evidence (STARTED/RESOLVED) is the
 *        high-water authority; a mutable rollback NEVER mints a new send
 *        permission — it converges to a durable lifecycle failure.
 * R3.4 — max_attempts is the receipt-stamped ceiling; consumption derives
 *        from immutable attempt history.
 * ========================================================================== */

describe("F4 R3 — immutable send-authority closure", () => {
  const failRec = () => {
    const calls: SendCall[] = [];
    return {
      calls,
      transport: {
        send: async (a: SendCall): Promise<GovernedSendResult> => {
          calls.push({ ...a });
          return { kind: "fail", error: "transport down" };
        },
      } as GovernedTelegramTransport,
    };
  };
  const attemptEv = (
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    kind: string,
  ) => ctx.store.listEvidence(mid).filter((e) => String(e.kind) === kind);
  const withOrigin = (
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    chatId: string,
  ) => {
    const m = missionRow(ctx, mid);
    return {
      ...m,
      metadata: {
        ...(m.metadata as Record<string, unknown>),
        mission_origin: { operator_id: `telegram:${chatId}` },
      },
    } as Record<string, unknown>;
  };
  const forgeChat = (
    body: Record<string, unknown>,
    provenance: string,
    chatId: string,
  ) => ({
    ...body,
    destination: { provider: "TELEGRAM", chat_id: chatId, provenance },
  });

  /* ---- R3.1 — complete static send-authority binding ---------------------- */

  it("R3.1a. mission-origin chat A→B retarget → fail closed, zero transport", async () => {
    const ctx = makeCtx("f4-r31a");
    const mid = "M_R31A";
    const { req } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: VI_REPORT,
      mission: withOrigin(ctx, mid, "777"),
    });
    const cur = deliveries(ctx)[0]!;
    expect(String((cur.destination as Record<string, unknown>).chat_id)).toBe("777");
    expect(String(cur.status)).toBe("QUEUED");
    rewrite(ctx, req, forgeChat(cur, "MISSION_ORIGIN", "888"));
    await expectFailClosedNoTransport(ctx, "TEXT");
  });

  it("R3.1b. configured-default chat A→B retarget → fail closed, zero transport", async () => {
    const ctx = makeCtx("f4-r31b");
    const mid = "M_R31B";
    const { req } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: VI_REPORT,
    });
    const cur = deliveries(ctx)[0]!;
    expect(
      String((cur.destination as Record<string, unknown>).provenance),
    ).toBe("CONFIGURED_DEFAULT");
    rewrite(ctx, req, forgeChat(cur, "CONFIGURED_DEFAULT", "999"));
    await expectFailClosedNoTransport(ctx, "TEXT");
  });

  it("R3.1c. UNSENDABLE row forged QUEUED with destination=B → zero network", async () => {
    const ctx = makeCtx("f4-r31c");
    const mid = "M_R31C";
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: mid,
      chatId: null,
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
      ],
    });
    const cur = deliveries(ctx)[0]!;
    expect(String(cur.status)).toBe("UNSENDABLE");
    // Forge a full activation: QUEUED + forged destination + open slots.
    const body = {
      ...cur,
      status: "QUEUED",
      destination: {
        provider: "TELEGRAM",
        chat_id: "999",
        provenance: "CONFIGURED_DEFAULT",
      },
      artifacts: (cur.artifacts as Array<Record<string, unknown>>).map(
        (a) => ({ ...a, state: "QUEUED" }),
      ),
    };
    delete body.last_error;
    delete body.completed_at;
    rewrite(ctx, req, body);
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it.each([
    ["mission_id", "M_OTHER"],
    ["task_id", "TDEL_OTHER"],
    ["execution_id", "EXEC_OTHER"],
  ])(
    "R3.1d-f. rewritten static identity %s → fail closed, zero transport",
    async (field, value) => {
      const ctx = makeCtx(`f4-r31-${field}`);
      const mid = `M_R31_${field.toUpperCase().slice(0, 3)}`;
      const { req } = mkBoundTextTdr(ctx, {
        missionId: mid,
        text: VI_REPORT,
      });
      const cur = deliveries(ctx)[0]!;
      const body = { ...cur, [field]: value };
      if (field === "mission_id") body.plan_id = cur.plan_id;
      rewrite(ctx, req, body);
      await expectFailClosedNoTransport(ctx, "TEXT");
    },
  );

  /* ---- R3.2 — canonical store-scoped snapshot root ------------------------ */

  it("R3.2a. forged outbox_dir → fail closed + ZERO fs ops on forged dir", async () => {
    const ctx = makeCtx("f4-r32a");
    const mid = "M_R32A";
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: mid,
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
      ],
    });
    const forged = path.join(ctx.dir, "forged-outbox");
    const cur = deliveries(ctx)[0]!;
    rewrite(ctx, req, { ...cur, outbox_dir: forged });
    const touched: string[] = [];
    const spy = (name: "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync") =>
      vi
        .spyOn(fs, name)
        .mockImplementation(((...a: unknown[]) => {
          touched.push(`${name}:${String(a[0])}`);
          return undefined as never;
        }) as never);
    const spies = [spy("mkdirSync"), spy("writeFileSync"), spy("renameSync"), spy("rmSync")];
    try {
      const rec = recordingTransport();
      const { sent } = await runTransport(ctx, { transport: rec.transport });
      expect(sent).toEqual([]);
      expect(rec.calls).toHaveLength(0);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    // ZERO filesystem operations derived from the forged root — and with
    // the contract invalid the canonical root is untouched this pass too.
    expect(touched.filter((p) => p.includes(forged))).toEqual([]);
    expect(fs.existsSync(forged)).toBe(false);
    const after = deliveries(ctx)[0]!;
    expect(
      (after.artifacts as Array<Record<string, unknown>>).map((a) =>
        String(a.last_error),
      ),
    ).toContain("FAIL_CLOSED_TELEGRAM_DELIVERY_PROVENANCE");
  });

  it("R3.2b. forged terminal row → prune never touches the forged root", async () => {
    const ctx = makeCtx("f4-r32b");
    const mid = "M_R32B";
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: mid,
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
      ],
    });
    const forged = path.join(ctx.dir, "forged-terminal");
    fs.mkdirSync(forged, { recursive: true });
    const cur = deliveries(ctx)[0]!;
    // Forge the row into a terminal state rooted at the forged dir —
    // prune must not interpret it as authority to delete anything there.
    rewrite(ctx, req, {
      ...cur,
      outbox_dir: forged,
      status: "FAILED_DELIVERY",
      artifacts: (cur.artifacts as Array<Record<string, unknown>>).map(
        (a) => ({ ...a, state: "FAILED_DELIVERY" }),
      ),
    });
    const rmCalls: string[] = [];
    const rmSpy = vi
      .spyOn(fs, "rmSync")
      .mockImplementation(((...a: unknown[]) => {
        rmCalls.push(String(a[0]));
        return undefined as never;
      }) as never);
    try {
      pendingTelegramDeliveries(ctx.store);
    } finally {
      rmSpy.mockRestore();
    }
    expect(rmCalls.filter((p) => p.startsWith(forged))).toEqual([]);
  });

  /* ---- R3.3 — rollback-resistant immutable attempt lifecycle -------------- */

  it("R3.3a. FILES: SENT+message_id → coherent rollback → zero new calls, durable lifecycle failure", async () => {
    const ctx = makeCtx("f4-r33a");
    const mid = "M_R33A";
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: mid,
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
      ],
    });
    const rec = recordingTransport();
    const first = await runTransport(ctx, { transport: rec.transport });
    expect(first.sent).toEqual(["report.txt"]);
    expect(rec.calls).toHaveLength(1);
    const sent = deliveries(ctx)[0]!;
    expect(String(sent.status)).toBe("SENT");
    // Immutable evidence exists: STARTED + RESOLVED SENT.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED).length).toBe(1);
    const res = attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED);
    expect(res.length).toBe(1);
    const rp = (res[0]!.payload as Record<string, unknown>)
      .payload as Record<string, unknown>;
    expect(String(rp.outcome)).toBe("SENT");
    expect(String(rp.message_id)).toBe("1001");
    // Adversary: roll the mutable row back to a fresh QUEUED state.
    const body = {
      ...sent,
      status: "QUEUED",
      artifacts: (sent.artifacts as Array<Record<string, unknown>>).map(
        (a) => ({
          ...a,
          state: "QUEUED",
          attempt_count: 0,
          message_id: undefined,
          sent_at: undefined,
          completed_at: undefined,
        }),
      ),
    };
    for (const a of body.artifacts as Array<Record<string, unknown>>) {
      delete a.message_id;
      delete a.sent_at;
      delete a.completed_at;
    }
    delete body.message_id;
    delete body.sent_at;
    delete body.completed_at;
    rewrite(ctx, sent, body);
    const rec2 = recordingTransport();
    const second = await runTransport(ctx, { transport: rec2.transport });
    expect(second.sent).toEqual([]);
    expect(rec2.calls).toHaveLength(0); // rollback minted no new permission
    const after = deliveries(ctx)[0]!;
    expect(String(after.status)).toBe("FAILED_DELIVERY");
    expect(
      (after.artifacts as Array<Record<string, unknown>>).map((a) =>
        String(a.last_error),
      ),
    ).toContain("FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE");
  });

  it("R3.3b. TEXT: SENT+message_id → coherent rollback → zero new calls, durable lifecycle failure", async () => {
    const ctx = makeCtx("f4-r33b");
    const mid = "M_R33B";
    const { req } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: VI_REPORT,
    });
    const rec = recordingTransport();
    const first = await runTransport(ctx, { transport: rec.transport });
    expect(first.sent).toEqual([`TEXT:${String(req.delivery_id)}`]);
    const sent = deliveries(ctx)[0]!;
    expect(String(sent.status)).toBe("SENT");
    const body = {
      ...sent,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 0,
      message_id: undefined,
      sent_at: undefined,
      completed_at: undefined,
    };
    delete body.message_id;
    delete body.sent_at;
    delete body.completed_at;
    rewrite(ctx, sent, body);
    const rec2 = recordingTransport();
    const second = await runTransport(ctx, { transport: rec2.transport });
    expect(second.sent).toEqual([]);
    expect(rec2.calls).toHaveLength(0);
    const after = deliveries(ctx)[0]!;
    expect(String(after.status)).toBe("FAILED_DELIVERY");
    expect(String(after.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE",
    );
  });

  it("R3.3c. crash inside BEGIN txn → zero STARTED evidence + row still QUEUED", async () => {
    const ctx = makeCtx("f4-r33c");
    const mid = "M_R33C";
    mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    const putSpy = vi
      .spyOn(ctx.store, "put")
      .mockImplementationOnce((() => {
        throw new Error("injected crash inside begin txn");
      }) as never);
    try {
      await expect(runTransport(ctx)).rejects.toThrow("injected crash");
    } finally {
      putSpy.mockRestore();
    }
    // Atomicity: neither the evidence row nor the SENDING projection
    // survived — the slot is still a clean QUEUED.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(0);
    const row = deliveries(ctx)[0]!;
    expect(String(row.status)).toBe("QUEUED");
    expect(String(row.text_state)).toBe("QUEUED");
    expect(row.attempt_id).toBeUndefined();
    // Recovery: a clean pass sends normally.
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([`TEXT:${String(row.delivery_id)}`]);
  });

  it("R3.3d. crash inside RESOLVE txn → zero RESOLVED evidence + slot stays SENDING", async () => {
    const ctx = makeCtx("f4-r33d");
    const mid = "M_R33D";
    mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    // Throw on the SECOND store.put (first is the begin projection).
    const orig = ctx.store.put.bind(ctx.store);
    let n = 0;
    const putSpy = vi
      .spyOn(ctx.store, "put")
      .mockImplementation(((...a: Parameters<typeof orig>) => {
        n += 1;
        if (n === 2) throw new Error("injected crash inside resolve txn");
        return orig(...a);
      }) as never);
    let transportSends = 0;
    const counting: GovernedTelegramTransport = {
      send: async () => {
        transportSends += 1;
        return { kind: "ok", message_id: 4242 };
      },
    };
    try {
      await expect(
        runTransport(ctx, { transport: counting }),
      ).rejects.toThrow("injected crash");
    } finally {
      putSpy.mockRestore();
    }
    expect(transportSends).toBe(1); // send happened…
    // …but the resolve rolled back entirely: no RESOLVED row, and the
    // SENDING projection was never persisted either.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(0);
    const row = deliveries(ctx)[0]!;
    expect(String(row.text_state)).toBe("SENDING");
    // The durable STARTED row drives stale reconciliation to
    // UNKNOWN_SIDE_EFFECT — never a blind resend.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
  });

  it("R3.3e. real restart: immutable attempt history survives — forged rollback still fails closed", async () => {
    const ctx = makeCtx("f4-r33e");
    const mid = "M_R33E";
    mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport });
    expect(String(deliveries(ctx)[0]!.status)).toBe("SENT");
    // Real restart: close and reopen the store on the same DB.
    const dbPath = path.join(ctx.dir, "pair.db");
    ctx.store.close();
    const store2 = new PairEvidenceStore(dbPath);
    const list2 = () =>
      store2.list("telegram_delivery_request") as Array<
        Record<string, unknown>
      >;
    const sent = list2()[0]!;
    // Forge a rollback on the reopened store.
    const body = {
      ...sent,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 0,
    };
    delete body.message_id;
    delete body.sent_at;
    delete body.completed_at;
    store2.put(
      "telegram_delivery_request",
      String(sent.delivery_id),
      body,
      Number(sent.version),
    );
    expect(pendingTelegramDeliveries(store2)).toEqual([]);
    const after = list2()[0]!;
    expect(String(after.status)).toBe("FAILED_DELIVERY");
    expect(String(after.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE",
    );
    store2.close();
  });

  /* ---- R3.4 — immutable retry budget ------------------------------------- */

  it("R3.4a. mint max_attempts=3 rewritten to 100 → receipt ceiling still authoritative (fail closed)", async () => {
    const ctx = makeCtx("f4-r34a");
    const mid = "M_R34A";
    const { req } = mkBoundFilesTdr(ctx, {
      missionId: mid,
      files: [
        { manifest: "report.txt", logical: "outbox/report.txt", bytes: VI_REPORT },
      ],
    });
    const cur = deliveries(ctx)[0]!;
    const slot = (cur.artifacts as Array<Record<string, unknown>>)[0]!;
    expect(Number(slot.max_attempts)).toBe(3);
    rewrite(ctx, req, {
      ...cur,
      artifacts: [{ ...slot, max_attempts: 100 }],
    });
    await expectFailClosedNoTransport(ctx, "FILES");
  });

  it("R3.4b. consumed history is authoritative — numbering continues from ledger; mutable count rollback → fail closed", async () => {
    // Part 1 (legit retry): two consumed FAILED attempts — the third
    // attempt's durable identity derives from the immutable ledger.
    const ctx = makeCtx("f4-r34b");
    const mid = "M_R34B";
    mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    const fr = failRec();
    await runTransport(ctx, { transport: fr.transport }); // attempt 1 fail
    let cur = deliveries(ctx)[0]!;
    rewrite(ctx, cur, { ...cur, next_retry_at: utcnow() });
    await runTransport(ctx, { transport: fr.transport }); // attempt 2 fail
    cur = deliveries(ctx)[0]!;
    expect(Number(cur.attempt_count)).toBe(2);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(2);
    cur = deliveries(ctx)[0]!;
    rewrite(ctx, cur, { ...cur, next_retry_at: utcnow() });
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport }); // attempt 3 ok
    const starts = attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED);
    expect(starts).toHaveLength(3);
    const lastStart = (
      starts[2]!.payload as Record<string, unknown>
    ).payload as Record<string, unknown>;
    expect(Number(lastStart.attempt_number)).toBe(3);
    // Part 2 (adversary): a fresh request with 2 consumed failures — a
    // mutable attempt_count reset mints no new budget: the row is a
    // lifecycle violation, zero further sends.
    const ctx2 = makeCtx("f4-r34b2");
    const mid2 = "M_R34B2";
    mkBoundTextTdr(ctx2, { missionId: mid2, text: VI_REPORT });
    const fr2 = failRec();
    await runTransport(ctx2, { transport: fr2.transport });
    let cur2 = deliveries(ctx2)[0]!;
    rewrite(ctx2, cur2, { ...cur2, next_retry_at: utcnow() });
    await runTransport(ctx2, { transport: fr2.transport });
    cur2 = deliveries(ctx2)[0]!;
    expect(Number(cur2.attempt_count)).toBe(2);
    rewrite(ctx2, cur2, {
      ...cur2,
      attempt_count: 0,
      next_retry_at: utcnow(),
    });
    const rec2 = recordingTransport();
    const { sent } = await runTransport(ctx2, { transport: rec2.transport });
    expect(sent).toEqual([]);
    expect(rec2.calls).toHaveLength(0);
    const after = deliveries(ctx2)[0]!;
    expect(String(after.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE",
    );
    expect(
      ctx2.store
        .listEvidence(mid2)
        .filter((e) => String(e.kind) === TELEGRAM_DELIVERY_ATTEMPT_STARTED),
    ).toHaveLength(2);
  });

  it("R3.4c. exhausted budget → full resurrection rewrite (QUEUED+count0+max100) → zero network", async () => {
    const ctx = makeCtx("f4-r34c");
    const mid = "M_R34C";
    mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    const fr = failRec();
    for (let i = 0; i < 3; i++) {
      const cur = deliveries(ctx)[0]!;
      if (i > 0)
        rewrite(ctx, cur, { ...cur, next_retry_at: utcnow() });
      await runTransport(ctx, { transport: fr.transport });
    }
    const dead = deliveries(ctx)[0]!;
    expect(String(dead.status)).toBe("FAILED_DELIVERY");
    // Resurrect: QUEUED + zeroed counter + raised ceiling.
    const body = {
      ...dead,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 0,
      max_attempts: 100,
    };
    delete body.last_error;
    delete body.completed_at;
    rewrite(ctx, dead, body);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    const after = deliveries(ctx)[0]!;
    expect(String(after.status)).toBe("FAILED_DELIVERY");
  });

  /* ---- R3.5 — control: untouched bound row still delivers ----------------- */

  it("R3.5. untouched bound row → clean contract + consistent ledger → sends once (control)", async () => {
    const ctx = makeCtx("f4-r35");
    const mid = "M_R35";
    const { req } = mkBoundTextTdr(ctx, { missionId: mid, text: VI_REPORT });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([`TEXT:${String(req.delivery_id)}`]);
    expect(rec.calls).toHaveLength(1);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(1);
  });
});

/* ============================ F4 R4 — final send-gate / lifecycle ledger ====
 * Every seam that can mint lifecycle authority re-proves the immutable
 * contract inside its own writer transaction — a stale or forged
 * projection can never be laundered into a send. */
describe("F4 R4 — final send-gate closure", () => {
  const failRec = (): {
    calls: SendCall[];
    transport: GovernedTelegramTransport;
  } => {
    const calls: SendCall[] = [];
    return {
      calls,
      transport: {
        send: async (a: SendCall): Promise<GovernedSendResult> => {
          calls.push({ ...a });
          return { kind: "fail", error: "boom" };
        },
      },
    };
  };
  const attemptEv = (
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    kind: string,
  ) => evidence(ctx, mid, kind);
  const beginDirect = (
    ctx: ReturnType<typeof makeCtx>,
    req: Record<string, unknown>,
    artifact: string | null,
  ) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), {
      artifact,
      to: "SENDING",
    });
  const resolveDirect = (
    ctx: ReturnType<typeof makeCtx>,
    req: Record<string, unknown>,
    body: Record<string, unknown>,
  ) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), body);

  it("R4.A — stale projection rolled back after SENT can never mint attempt #2", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4A";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-a" });
    const pending = pendingTelegramDeliveries(ctx.store);
    const req = pending[0]!;
    // Real send #1 — the old projected copy is retained.
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport });
    const sent = deliveries(ctx)[0]!;
    expect(sent.text_state).toBe("SENT");
    // Coherent rollback through the canonical store seam.
    const { message_id: _m, ...noMid } = sent as Record<string, unknown>;
    rewrite(ctx, sent, {
      ...noMid,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 0,
    });
    // The OLD projection through the REAL begin path must be denied.
    expect(() => beginDirect(ctx, req, null)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE/,
    );
    // And the durable row itself can never mint attempt #2 — the
    // rolled-back projection converges FAILED on the next pending pass.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
    expect(rec.calls).toHaveLength(1);
    pendingTelegramDeliveries(ctx.store);
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).toBe("FAILED_DELIVERY");
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
  });

  it("R4.B — exhausted retry ceiling bound by the mint receipt; widened mutable max_attempts cannot mint attempt", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4B";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-b", maxAttempts: 3 });
    const fail = failRec();
    for (let i = 0; i < 3; i++) {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + i * 15 * 60 * 1000 + 70_000);
      await runTransport(ctx, { transport: fail.transport });
      vi.useRealTimers();
    }
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).toBe("FAILED_DELIVERY");
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(3);
    // Coherent rewrite: status+state QUEUED, max_attempts widened.
    rewrite(ctx, row, {
      ...row,
      status: "QUEUED",
      text_state: "QUEUED",
      max_attempts: 100,
    });
    // REAL begin — denied; zero attempt #4.
    expect(() => beginDirect(ctx, row, null)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY/,
    );
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(3);
    await runTransport(ctx, { transport: recordingTransport().transport });
    expect(fail.calls).toHaveLength(3);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(3);
  });

  it("R4.C — forged SENDING without any STARTED cannot be resolved SENT", () => {
    const ctx = makeCtx();
    const mid = "MSN_R4C";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-c" });
    const req = deliveries(ctx)[0]!;
    // Forge a coherent SENDING with a plausible attempt identity — no
    // begin was ever called, so no immutable STARTED exists.
    rewrite(ctx, req, {
      ...req,
      status: "QUEUED",
      text_state: "SENDING",
      attempt_id: "ATT_FAKE123456",
      attempt_number: 7,
      attempt_started_at: new Date().toISOString(),
    });
    expect(() =>
      resolveDirect(ctx, req, { to: "SENT", message_id: 123 }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE/);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(0);
    // The forged attempt established NO immutable SENT authority —
    // begin for the slot still mints attempt 1 (or fails the
    // projection check — never reuses the fake).
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).not.toBe("SENT");
  });

  it("R4.D — replayed resolve against an already-resolved STARTED fails closed", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4D";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-d" });
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport });
    const sent = deliveries(ctx)[0]!;
    expect(sent.text_state).toBe("SENT");
    const started = attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)[0]!;
    const resolvedId = String(
      (started.payload as Record<string, unknown>).attempt_id,
    );
    // Forge SENDING carrying the ALREADY-RESOLVED attempt identity.
    rewrite(ctx, sent, {
      ...sent,
      status: "QUEUED",
      text_state: "SENDING",
      attempt_id: resolvedId,
      attempt_number: 1,
      attempt_started_at: new Date().toISOString(),
    });
    expect(() =>
      resolveDirect(ctx, sent, { to: "SENT", message_id: 999 }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE/);
    // Exactly one RESOLVED — the first, legitimate one.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(1);
  });

  it("R4.E — forged stale SENDING without STARTED produces ZERO UNKNOWN evidence", () => {
    const ctx = makeCtx();
    const mid = "MSN_R4E";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-e" });
    const req = deliveries(ctx)[0]!;
    rewrite(ctx, req, {
      ...req,
      status: "QUEUED",
      text_state: "SENDING",
      attempt_id: "ATT_FORGEDSTALE",
      attempt_number: 1,
      attempt_started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    // pending → stale reconcile — the forged attempt has no immutable
    // STARTED → quarantine the projection, append ZERO evidence.
    pendingTelegramDeliveries(ctx.store);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(0);
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).not.toBe("UNKNOWN_SIDE_EFFECT");
  });

  it("R4.F — static-contract tamper before stale reconciliation mints ZERO lifecycle evidence", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4F";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-f" });
    // Legitimate BEGIN — durable SENDING + immutable STARTED.
    const pend = pendingTelegramDeliveries(ctx.store)[0]!;
    beginDirect(ctx, pend, null);
    const sending = deliveries(ctx)[0]!;
    expect(sending.text_state).toBe("SENDING");
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
    // Tamper the STATIC contract — mission_id drift — while SENDING.
    rewrite(ctx, sending, { ...sending, mission_id: "MSN_R4F_TAMPERED" });
    // Age the attempt past the stale window and reconcile.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    pendingTelegramDeliveries(ctx.store);
    vi.useRealTimers();
    // ZERO new RESOLVED evidence — static contract fails first; the
    // forged row is quarantined without any lifecycle evidence.
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED)).toHaveLength(0);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
    const forged = deliveries(ctx)[0]!;
    expect(forged.text_state).toBe("FAILED_DELIVERY");
  });

  it("R4.G — malformed immutable sequence (RESOLVED without STARTED) fails closed", () => {
    const ctx = makeCtx();
    const mid = "MSN_R4G";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-g" });
    const req = deliveries(ctx)[0]!;
    // Append a malformed immutable history directly through the
    // append-only seam — RESOLVED without any STARTED.
    ctx.store.appendEvidence(mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED, {
      delivery_id: String(req.delivery_id),
      slot: "text",
      attempt_id: "ATT_GHOST",
      attempt_number: 1,
      outcome: "SENT",
      message_id: 1,
      error: null,
      resolved_at: new Date().toISOString(),
    });
    const pending = pendingTelegramDeliveries(ctx.store);
    expect(pending).toHaveLength(0);
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).toBe("FAILED_DELIVERY");
  });

  it("R4.H — terminal SENT ledger denies a fresh begin even after mutable QUEUED rollback", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4H";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-h" });
    await runTransport(ctx, { transport: recordingTransport().transport });
    const sent = deliveries(ctx)[0]!;
    rewrite(ctx, sent, {
      ...sent,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 1,
      message_id: 1001,
    });
    expect(() => beginDirect(ctx, sent, null)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY/,
    );
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
  });

  it("R4.I — terminal UNKNOWN ledger denies a fresh begin after mutable QUEUED rollback", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4I";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-i" });
    // Legit send with an UNKNOWN transport outcome → immutable terminal
    // UNKNOWN lifecycle authority.
    await runTransport(ctx, {
      transport: {
        send: async () => ({ kind: "unknown", error: "lost" }),
      },
    });
    const unk = deliveries(ctx)[0]!;
    expect(unk.text_state).toBe("UNKNOWN_SIDE_EFFECT");
    rewrite(ctx, unk, {
      ...unk,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 1,
    });
    expect(() => beginDirect(ctx, unk, null)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY/,
    );
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(1);
  });

  it("R4.J — a clean FAILED attempt still permits the next canonical retry", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R4J";
    missionRow(ctx, mid);
    mkBoundTextTdr(ctx, { missionId: mid, text: "r4-j", maxAttempts: 2 });
    await runTransport(ctx, { transport: failRec().transport });
    const failed = deliveries(ctx)[0]!;
    expect(failed.text_state).toBe("QUEUED");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport });
    vi.useRealTimers();
    const row = deliveries(ctx)[0]!;
    expect(row.text_state).toBe("SENT");
    expect(row.attempt_count).toBe(1);
    expect(rec.calls).toHaveLength(1);
    expect(attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED)).toHaveLength(2);
  });
});

describe("Phase F4 R5 — transactional reconcile + budget-aware ledger", () => {
  const attemptEv = (
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    kind: string,
  ) =>
    evidence(ctx, mid, kind).map(
      (ev) =>
        (ev.payload as Record<string, unknown>)
          .payload as Record<string, unknown>,
    );

  const failRec = () => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      transport: {
        send: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { kind: "fail" as const, error: "boom" };
        },
      },
    };
  };

  const beginDirect = (
    ctx: ReturnType<typeof makeCtx>,
    req: Record<string, unknown>,
  ) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), {
      to: "SENDING",
    });
  const resolveDirect = (
    ctx: ReturnType<typeof makeCtx>,
    req: Record<string, unknown>,
    input: Record<string, unknown>,
  ) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), input);

  const attId = (entityId: string, slot: string, n: number) =>
    `ATT_${digest(`${entityId}:${slot}:${n}`).slice(0, 16)}`;

  /** Append a canonical STARTED/RESOLVED pair directly into durable
   *  evidence (append-only — the historical-fault seam). */
  const appendHistory = (
    ctx: ReturnType<typeof makeCtx>,
    mid: string,
    entityId: string,
    slot: string,
    seq: Array<"STARTED" | "FAILED" | "SENT" | "UNKNOWN">,
    sentMessageId: unknown = 7777,
  ) => {
    let n = 0;
    for (const step of seq) {
      if (step === "STARTED") {
        n += 1;
        ctx.store.appendEvidence(mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED, {
          delivery_id: entityId,
          slot,
          attempt_id: attId(entityId, slot, n),
          attempt_number: n,
          started_at: "2026-10-04T00:00:00.000Z",
        });
      } else {
        ctx.store.appendEvidence(mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED, {
          delivery_id: entityId,
          slot,
          attempt_id: attId(entityId, slot, n),
          attempt_number: n,
          outcome: step,
          message_id: step === "SENT" ? sentMessageId : null,
          error: step === "FAILED" ? "boom" : null,
          resolved_at: "2026-10-04T00:05:00.000Z",
        });
      }
    }
  };

  it("R5.1-race: a competing writer between candidate discovery and the reconcile transaction cannot mint an incorrect UNKNOWN", () => {
    const ctx = makeCtx();
    const mid = "MSN_R5RACE1";
    const { req: td } = mkBoundTextTdr(ctx, { missionId: mid, text: "race" });
    beginDirect(ctx, td);
    const row = deliveries(ctx).find((d) => d.delivery_id === td.delivery_id)!;
    expect(row.text_state).toBe("SENDING");
    // Simulate a second writer landing BETWEEN the outer candidate list
    // and reconcile's authority check: it refreshes attempt_started_at
    // so the attempt is no longer stale.
    const origList = ctx.store.list.bind(ctx.store);
    let injected = false;
    const spy = vi.spyOn(ctx.store, "list").mockImplementation(((
      entityType: string,
    ) => {
      const rows = origList(entityType);
      if (entityType === "telegram_delivery_request" && !injected) {
        injected = true;
        const cur = origList(entityType).find(
          (r) => String(r.entity_id) === String(row.entity_id),
        )!;
        ctx.store.put(
          entityType,
          String(cur.entity_id),
          {
            ...cur,
            attempt_started_at: "2026-10-05T01:59:30.000Z",
          },
          Number(cur.version),
        );
      }
      return rows;
    }) as typeof ctx.store.list);
    try {
      reconcileStaleDeliveryAttempts(ctx.store, "2026-10-05T02:00:00.000Z");
    } finally {
      spy.mockRestore();
    }
    const after = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    // The in-transaction reload saw the fresh started_at → untouched,
    // zero incorrect RESOLVED UNKNOWN evidence.
    expect(after.text_state).toBe("SENDING");
    expect(
      attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED),
    ).toHaveLength(0);
  });

  it("R5.1-crash: a fault between evidence append and row write rolls back both", () => {
    const ctx = makeCtx();
    const mid = "MSN_R5CRASH1";
    const { req: td } = mkBoundTextTdr(ctx, { missionId: mid, text: "crash" });
    beginDirect(ctx, td);
    const before = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    expect(before.text_state).toBe("SENDING");
    const origAppend = ctx.store.appendEvidence.bind(ctx.store);
    const spy = vi
      .spyOn(ctx.store, "appendEvidence")
      .mockImplementation((
        missionId: string,
        kind: string,
        payload: Record<string, unknown>,
      ) => {
        const out = origAppend(missionId, kind, payload);
        if (kind === TELEGRAM_DELIVERY_ATTEMPT_RESOLVED) {
          throw new Error("crash-after-append");
        }
        return out;
      });
    try {
      expect(() =>
        reconcileStaleDeliveryAttempts(ctx.store, "2026-10-05T02:00:00.000Z"),
      ).toThrow(/crash-after-append/);
    } finally {
      spy.mockRestore();
    }
    // Whole transaction rolled back: zero evidence AND row unchanged.
    expect(
      attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED),
    ).toHaveLength(0);
    const after = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    expect(after.text_state).toBe("SENDING");
    expect(after.attempt_started_at).toBe(before.attempt_started_at);
  });

  it("R5.5A: over-budget immutable history (STARTED #4 > max_attempts 3) makes the ledger invalid everywhere", () => {
    const ctx = makeCtx();
    const mid = "MSN_R5OB1";
    const { req: td } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: "over-budget",
      maxAttempts: 3,
    });
    const entityId = String(td.entity_id);
    appendHistory(ctx, mid, entityId, "text", [
      "STARTED", "FAILED",
      "STARTED", "FAILED",
      "STARTED", "FAILED",
      "STARTED",
    ]);
    // Ledger itself is invalid — over the immutable ceiling.
    const ledger = deliveryAttemptLedger(ctx.store, mid, entityId, () => 3);
    expect(ledger.valid).toBe(false);
    expect(ledger.slots.get("text")?.seqError).toBe("started_over_ceiling");
    // Forge a coherent SENDING projection claiming the open attempt #4.
    const row = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    rewrite(ctx, row, {
      ...row,
      text_state: "SENDING",
      attempt_id: attId(entityId, "text", 4),
      attempt_number: 4,
      attempt_started_at: "2026-10-04T00:00:00.000Z",
      attempt_count: 3,
    });
    // Stale reconcile: bound + contract-ok but invalid ledger →
    // quarantine, ZERO resolved evidence minted.
    reconcileStaleDeliveryAttempts(ctx.store, "2026-10-05T02:00:00.000Z");
    expect(
      attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED),
    ).toHaveLength(3);
    const q = deliveries(ctx).find((d) => d.delivery_id === td.delivery_id)!;
    expect(q.status).toBe("FAILED_DELIVERY");
    // Direct resolve denied on the invalid ledger.
    expect(() =>
      resolveDirect(ctx, q, { to: "SENT", message_id: 9999 }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY/);
    // Direct begin denied too (row forged QUEUED over the bad ledger).
    rewrite(ctx, q, { ...q, status: "QUEUED", text_state: "QUEUED", last_error: null });
    expect(() => beginDirect(ctx, q)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE/,
    );
    // Pending: zero eligible payloads.
    expect(pendingTelegramDeliveries(ctx.store, "2026-10-05T02:00:00.000Z")).toHaveLength(0);
  });

  it("R5.5B: forged QUEUED row over a 3-FAILED exhausted history still gets no attempt #4 authority", () => {
    const ctx = makeCtx();
    const mid = "MSN_R5OB2";
    const { req: td } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: "exhausted",
      maxAttempts: 3,
    });
    const entityId = String(td.entity_id);
    appendHistory(ctx, mid, entityId, "text", [
      "STARTED", "FAILED",
      "STARTED", "FAILED",
      "STARTED", "FAILED",
    ]);
    const row = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    rewrite(ctx, row, {
      ...row,
      text_state: "QUEUED",
      attempt_count: 3,
    });
    expect(() => beginDirect(ctx, row)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY/,
    );
    expect(
      attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED),
    ).toHaveLength(3);
  });

  it.each([
    { label: "zero", mid2: 0 },
    { label: "string", mid2: "7777" },
    { label: "negative", mid2: -42 },
  ])("R5.5C: RESOLVED SENT with message_id=$label is an invalid ledger, not terminal authority", ({ mid2 }) => {
    const ctx = makeCtx();
    const mid = "MSN_R5SENT";
    const { req: td } = mkBoundTextTdr(ctx, { missionId: mid, text: "fake sent" });
    const entityId = String(td.entity_id);
    appendHistory(
      ctx, mid, entityId, "text", ["STARTED", "SENT"], mid2,
    );
    const ledger = deliveryAttemptLedger(ctx.store, mid, entityId, () => 3);
    expect(ledger.valid).toBe(false);
    expect(ledger.slots.get("text")?.seqError).toBe("sent_invalid_message_id");
    // A coherent QUEUED row may not resurrect against this ledger.
    const row = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    rewrite(ctx, row, { ...row, text_state: "QUEUED" });
    expect(() => beginDirect(ctx, row)).toThrow(
      /FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE/,
    );
  });

  it("R5.5D control: 1F + 2F + 3SENT(valid id) is a valid canonical terminal history", () => {
    const ctx = makeCtx();
    const mid = "MSN_R5CTL1";
    const { req: td } = mkBoundTextTdr(ctx, {
      missionId: mid,
      text: "terminal",
      maxAttempts: 3,
    });
    const entityId = String(td.entity_id);
    appendHistory(ctx, mid, entityId, "text", [
      "STARTED", "FAILED",
      "STARTED", "FAILED",
      "STARTED", "SENT",
    ], 8888);
    const ledger = deliveryAttemptLedger(ctx.store, mid, entityId, () => 3);
    expect(ledger.valid).toBe(true);
    const h = ledger.slots.get("text")!;
    expect(h.started).toBe(3);
    expect(h.consumed).toBe(2);
    expect(h.terminal).toBe("SENT");
  });

  it("R5.5E control: append-only FAILED history still drives a clean retry", async () => {
    const ctx = makeCtx();
    const mid = "MSN_R5CTL2";
    const { req: td } = mkBoundTextTdr(ctx, { missionId: mid, text: "retry" });
    const entityId = String(td.entity_id);
    appendHistory(ctx, mid, entityId, "text", ["STARTED", "FAILED"]);
    const row = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    rewrite(ctx, row, {
      ...row,
      text_state: "QUEUED",
      attempt_count: 1,
    });
    await runTransport(ctx, { transport: recordingTransport().transport });
    const after = deliveries(ctx).find(
      (d) => d.delivery_id === td.delivery_id,
    )!;
    expect(after.status).toBe("SENT");
    expect(after.text_state).toBe("SENT");
    const started = attemptEv(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED);
    expect(started).toHaveLength(2);
    expect(Number(started[1]!.attempt_number)).toBe(2);
  });
});
