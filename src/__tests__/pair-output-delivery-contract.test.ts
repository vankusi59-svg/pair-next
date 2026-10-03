/**
 * OUTPUT LANGUAGE + DELIVERY CONTENT AUTHORITY CLOSURE — remediation
 * regression suite.
 *
 * Live incident: goal "…viết báo cáo tổng hợp bằng tiếng việt vào
 * outbox/report.txt, task 4 gửi file report.txt đến telegram" delivered
 * an ENGLISH report.txt to Telegram. Three contract defects closed:
 *
 *   A — canonical output language (src/pair/output-language.ts): the
 *       operator-facing language is a PAIR-owned authority derived from
 *       the effective goal (explicit directive > dominant goal language
 *       > undetermined), stamped onto the delivery task at the
 *       canonical reconcile seam (digest-covered), replay-verified, and
 *       RE-DERIVED from the goal at the delivery gate — never
 *       planner-forgeable.
 *   B — FILES mode is transport-only: the delivery task stages the
 *       manifested artifact byte-identically; its SHA-256 is pinned at
 *       dispatch, re-verified at the settle gate before mint, pinned
 *       into the TDR slot, and re-verified at the bridge projection —
 *       mutation anywhere fails closed with zero network calls.
 *   C — TEXT mode has exactly one canonical payload source: the content
 *       of outbox/report.txt the delivery task was contracted to write.
 *       An execution acknowledgement ("DONE") is never the deliverable.
 *   D — language verification gate at settle: a manifested textual
 *       deliverable that classifies to a DIFFERENT language than the
 *       canonical code fails closed (DELIVERY_CONTRACT_VIOLATED
 *       evidence + governed recovery), never minting send authority.
 */

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
  IntegrityError,
  canonicalArtifactId,
  mintArtifactCapability,
  workerExecutionId,
  assertOutputLanguageAuthority,
  assertPlanDataflow,
  canonicalDeliveryTaskInstruction,
  classifyTextLanguage,
  boundedFileSha256,
  deliveryManifest,
  deliverySnapshotRoot,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  digest,
  languagePhrase,
  materializeDeliveryTextPayload,
  mintTelegramDeliveryRequest,
  pendingTelegramDeliveries,
  reconcilePlanDataflow,
  sha256File,
  sha256Hex,
  transportTelegramDelivery,
  utcnow,
  verifyOutputLanguageContent,
  DELIVERY_TEXT_ARTIFACT,
  MAX_TELEGRAM_FILE_BYTES,
  MAX_TEXT_BYTES,
  PAIR_OUTPUT_LANGUAGE_KEY,
  PAIR_PLAN_CONTRACT_KEY,
  PAIR_PLAN_CONTRACT_VERSION,
} from "../pair/index.js";
import type {
  DeliveryBackend,
  GovernedSendResult,
  GovernedTelegramTransport,
  TelegramDeliveryIntent,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-out-contract-"));
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
const EN_REPORT =
  "Gold price summary report. The XAUUSD price moved higher over the last week " +
  "and the latest market news shows inflation and rates remain the main drivers. " +
  "Conclusion: the short term uptrend continues.";

/* ------------------------------ plan fixtures ------------------------------ */

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

/** The exact production goal from the mandate. */
const PROD_GOAL =
  "task 1 thu thập giá XAUUSD 7 ngày qua, task 2 thu thập tin tức kinh tế mới nhất về vàng, " +
  "task 3 đọc output của task 1 VÀ task 2 rồi viết báo cáo tổng hợp bằng tiếng việt vào outbox/report.txt, " +
  "task 4 gửi file report.txt đến telegram";

/** Production-shaped plan: two research tasks fan out, the report task
 *  joins them and writes outbox/report.txt, the delivery task delivers
 *  the manifested file. */
const prodPlan = () => [
  goalTask("T1"),
  {
    task_key: "T2",
    title: "collect XAUUSD price data",
    task_instruction: "collect the XAUUSD price history for the last 7 days and summarize findings, then reply DONE.",
    required_capabilities: ["REASONING"],
    depends_on: ["T1"],
    metadata: {},
  },
  {
    task_key: "T3",
    title: "collect latest gold news",
    task_instruction: "collect the latest economic news about gold and summarize findings, then reply DONE.",
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
    title: "deliver report",
    task_instruction: "deliver the report file, then reply DONE.",
    required_capabilities: ["TELEGRAM_DELIVERY"],
    depends_on: [],
    metadata: {},
  },
];

/* ------------------------------ runtime ctx -------------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  /** execution_id → workspace-relative files the execution actually
   *  wrote — declared in collect_result the same way the production
   *  adapter's finish() workspace-diff declares them. */
  private wrote: Record<string, string[]> = {};
  /** task_key → behavior; default COMPLETED */
  behavior: Record<
    string,
    "COMPLETE" | "FAIL" | "WRITE" | "CLOBBER" | "SKIPWRITE"
  > = {};
  /** task_key → text written into every produces file for WRITE. */
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
    let error: Record<string, unknown> | undefined;
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
      // The defect-B adversary: the delivery-prep task rewrites the
      // manifested artifact with its own "replacement report".
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, "CLOBBERED — rewritten by the delivery task");
        (this.wrote[eid] ??= []).push(f);
      }
    }
    if (b === "SKIPWRITE" && this.workspace) {
      // Claims DONE without writing its contracted produces artifacts.
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        if (fs.existsSync(fp)) fs.rmSync(fp);
      }
    }
    if (b === "FAIL") {
      status = "FAILED";
      error = { class: "PROCESS_EXIT", message: "CODEX_AGENT_REPORTED_FAILURE" };
    }
    this.collected[eid] = {
      status,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      ...(error ? { error } : { summary: `done ${key}` }),
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
    // Canonical WorkerResult carries the full PAIR identity — merge the
    // execution id the same way production adapters bind it.
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    // Production contract: the result declares the artifacts THIS
    // execution created/changed ({path, sha256, byte_size}) — the
    // validator ingests them into canonical authority.
    const artifacts = (this.wrote[executionId] ?? [])
      .map((f) => {
        const fp = path.join(this.workspace, f);
        if (!fs.existsSync(fp)) return null;
        const bytes = fs.readFileSync(fp);
        return {
          path: f,
          sha256: sha256Hex(bytes),
          byte_size: bytes.length,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    return { execution_id: executionId, artifacts, ...r };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

function makeCtx(
  name: string,
  opts: {
    planner?: (i: never) => unknown;
    defaultChatId?: string | null;
    maxAttempts?: number;
  } = {},
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
  const planner =
    opts.planner ??
    ((input: { mission: Record<string, unknown> }) => {
      const pinned = input.mission?.metadata?.pinned_plan_tasks as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
      return { tasks: [goalTask()] };
    });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
    telegramDeliveryDefaultChatId:
      "defaultChatId" in opts ? opts.defaultChatId ?? undefined : "111",
    telegramDeliveryMaxAttempts: opts.maxAttempts,
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

/* ----------------- F4 canonical-producer fixture seam ---------------------- */

/** Fabricate a legitimate in-mission artifact producer through the REAL
 *  production seams: task row (produces declaration) → governed task →
 *  executor_execution COMPLETED with the declared artifact contract →
 *  ArtifactProvenanceValidator (local ingest) or the capability upload
 *  lane (remote ingest). The canonical artifact row + RESULT_VALIDATED
 *  anchor + ARTIFACT_ACCEPTED history it emits are exactly what
 *  resolveDeliveryArtifact / verifyArtifactForConsumption re-prove. */
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
    pass?: boolean;
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
      task_id: tid,
      task_key: o.key,
      mission_id: o.missionId,
      plan_id: o.planId,
      title: o.key,
      task_instruction: `produce ${o.name}`,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
      status: "COMPLETED",
      metadata: {
        pair_dataflow: { produces: [o.name], consumes: [] },
      },
      version: 0,
    },
    0,
  );
  ctx.store.put(
    "governed_task",
    gtId,
    {
      governed_task_id: gtId,
      mission_id: o.missionId,
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
  ctx.store.put(
    "executor_execution",
    eid,
    {
      execution_id: eid,
      governed_task_id: gtId,
      mission_id: o.missionId,
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
  const settled = ctx.store.get("executor_execution", eid);
  ctx.store.put(
    "executor_execution",
    eid,
    {
      ...settled,
      execution_state: o.pass === false ? "FAILED" : "COMPLETED",
      result: {
        status: o.pass === false ? "FAILED" : "COMPLETED",
        artifacts: declared,
      },
    },
    settled.version,
  );
  new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);
  const art = ctx.store.tryGet(
    "artifact",
    canonicalArtifactId(eid, o.name),
  );
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
const taskByKey = (ctx: ReturnType<typeof makeCtx>, mid: string, key: string) =>
  ctx.store
    .list("task")
    .find((t) => String(t.mission_id) === mid && String(t.task_key) === key);

function drive(ctx: ReturnType<typeof makeCtx>, mid: string, max = 160) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    ctx.runtime.tick(mid, new Date(t).toISOString());
    const s = String(rt(ctx, mid).state);
    if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s)) {
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

function recordingTransport(opts?: {
  fail?: Set<string>;
  explode?: Set<string>;
  noMid?: Set<string>;
}): { calls: SendCall[]; transport: GovernedTelegramTransport } {
  const calls: SendCall[] = [];
  return {
    calls,
    transport: {
      send: async (a: SendCall): Promise<GovernedSendResult> => {
        calls.push({ ...a });
        const key = a.name ?? "TEXT";
        if (opts?.explode?.has(key)) throw new Error("socket died mid-send");
        if (opts?.fail?.has(key)) return { kind: "fail", error: "400 Bad Request" };
        if (opts?.noMid?.has(key)) return { kind: "ok" };
        return { kind: "ok", message_id: 1001 };
      },
    },
  };
}

function storeBackend(
  ctx: ReturnType<typeof makeCtx>,
  req: Record<string, unknown>,
  now?: string,
) {
  const t = (artifact: string | null | undefined, body: Record<string, unknown>) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), {
      artifact,
      ...(now ? { now } : {}),
      ...body,
    });
  return {
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
}

async function runTransport(
  ctx: ReturnType<typeof makeCtx>,
  opts?: { transport?: GovernedTelegramTransport; now?: string },
) {
  const rec = recordingTransport();
  const transport = opts?.transport ?? rec.transport;
  const sent: string[] = [];
  for (const req of pendingTelegramDeliveries(ctx.store, opts?.now) as Array<
    Record<string, unknown>
  >) {
    const backend = storeBackend(ctx, req, opts?.now);
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

/* =================== A. canonical output-language authority =================== */

describe("A — detectOutputLanguage: canonical derivation", () => {
  it("A1. explicit directive 'bằng tiếng việt' → vi / GOAL_DIRECTIVE", () => {
    const ol = detectOutputLanguage(PROD_GOAL);
    expect(ol.code).toBe("vi");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
    expect(String(ol.evidence.directive)).toMatch(/tiếng việt/i);
  });
  it("A2. 'bằng tiếng anh' directive → en", () => {
    expect(detectOutputLanguage("phân tích giá vàng, viết báo cáo bằng tiếng anh").code).toBe("en");
  });
  it("A3. 'in English' directive → en", () => {
    expect(detectOutputLanguage("collect gold data and write the report in English").code).toBe("en");
  });
  it("A4. dominant goal language without directive → vi / GOAL_LANGUAGE", () => {
    const ol = detectOutputLanguage("phân tích giá vàng XAUUSD hôm nay và tóm tắt xu hướng thị trường");
    expect(ol.code).toBe("vi");
    expect(ol.authority).toBe("GOAL_LANGUAGE");
  });
  it("A5. English-dominant goal → en / GOAL_LANGUAGE", () => {
    const ol = detectOutputLanguage(
      "collect the latest gold market prices and write a summary report for the operator",
    );
    expect(ol.code).toBe("en");
    expect(ol.authority).toBe("GOAL_LANGUAGE");
  });
  it("A6. no directive, undetectable language → UNDETERMINED (no invented authority)", () => {
    const ol = detectOutputLanguage("12345 !!!");
    expect(ol.code).toBeNull();
    expect(ol.authority).toBe("UNDETERMINED");
  });
  it("A7. explicit directive beats dominant goal language", () => {
    const ol = detectOutputLanguage(
      "thu thập giá vàng và tin tức kinh tế mới nhất, viết báo cáo bằng tiếng anh",
    );
    expect(ol.code).toBe("en");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
  });
  it("A8. classifyTextLanguage: vi / en / ja / undetermined", () => {
    expect(classifyTextLanguage(VI_REPORT)).toBe("vi");
    expect(classifyTextLanguage(EN_REPORT)).toBe("en");
    expect(classifyTextLanguage("今日のゴールド価格をまとめたレポートです")).toBe("ja");
    expect(classifyTextLanguage("x")).toBeNull();
  });
  it("A9. verifyOutputLanguageContent: match / mismatch / unprovable", () => {
    expect(verifyOutputLanguageContent(VI_REPORT, "vi").ok).toBe(true);
    const bad = verifyOutputLanguageContent(EN_REPORT, "vi");
    expect(bad.ok).toBe(false);
    expect(bad.detected).toBe("en");
    expect(verifyOutputLanguageContent("123", "vi").ok).toBe(true); // unprovable → not a violation
    expect(verifyOutputLanguageContent(EN_REPORT, null).ok).toBe(true); // no canonical code
  });
});

describe("B — canonical stamp, forge resistance, replay", () => {
  const ol = () => detectOutputLanguage(PROD_GOAL);
  it("B1. reconcile stamps pair_output_language on the delivery task + producer contract suffix", () => {
    const { tasks } = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: ol(),
    });
    const t5 = tasks.find((t) => t.task_key === "T5")!;
    const stamped = (t5.metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] as {
      code: string; authority: string;
    };
    expect(stamped.code).toBe("vi");
    expect(stamped.authority).toBe("GOAL_DIRECTIVE");
    // Producer of the manifested text artifact carries the PAIR contract.
    const t4 = tasks.find((t) => t.task_key === "T4")!;
    expect(String(t4.task_instruction)).toContain("PAIR OUTPUT LANGUAGE CONTRACT");
    expect(String(t4.task_instruction)).toContain("Vietnamese (vi)");
    // Intermediate tasks keep mandate-E freedom — no contract suffix.
    const t2 = tasks.find((t) => t.task_key === "T2")!;
    expect(String(t2.task_instruction)).not.toContain("PAIR OUTPUT LANGUAGE CONTRACT");
    // The stamp exists only on the delivery task.
    for (const t of tasks) {
      if (t.task_key === "T5") continue;
      expect((t.metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY]).toBeUndefined();
    }
  });
  it("B2. planner metadata cannot forge/widen the authority", () => {
    const forged = prodPlan();
    (forged[4].metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] = {
      code: "en", authority: "OPERATOR", evidence: { fake: true },
    };
    const { tasks } = reconcilePlanDataflow(forged, {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: ol(),
    });
    const stamped = (tasks[4].metadata as Record<string, unknown>)[
      PAIR_OUTPUT_LANGUAGE_KEY
    ] as { code: string };
    expect(stamped.code).toBe("vi"); // stripped + re-stamped canonically
  });
  it("B3. reconcile replay is byte-identical (idempotent suffix strip)", () => {
    const first = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: ol(),
    }).tasks;
    const replay = reconcilePlanDataflow(JSON.parse(JSON.stringify(first)), {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: ol(),
    }).tasks;
    expect(replay).toEqual(first);
  });
  it("B4. assertPlanDataflow re-proves the stamp; forged/mismatched stamps fail closed", () => {
    const tasks = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
      outputLanguage: ol(),
    }).tasks;
    // Clean replay passes.
    expect(() =>
      assertPlanDataflow(JSON.parse(JSON.stringify(tasks)), {
        telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
        outputLanguage: ol(),
      }),
    ).not.toThrow();
    // Tampered stamp on the delivery task fails closed.
    const tampered = JSON.parse(JSON.stringify(tasks));
    (tampered.find((t: Record<string, unknown>) => t.task_key === "T5")!
      .metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] = {
      code: "en", authority: "GOAL_DIRECTIVE", evidence: { directive: "in english" },
    };
    expect(() =>
      assertPlanDataflow(tampered, {
        telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
        outputLanguage: ol(),
      }),
    ).toThrowError(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
    // The reserved key on a NON-delivery task is forged authority.
    const forged = JSON.parse(JSON.stringify(tasks));
    (forged.find((t: Record<string, unknown>) => t.task_key === "T4")!
      .metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] = ol();
    expect(() =>
      assertPlanDataflow(forged, {
        telegramIntent: detectTelegramDeliveryIntent(PROD_GOAL),
        outputLanguage: ol(),
      }),
    ).toThrowError(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
  });
  it("B5. FILES instruction is transport-only — never composes/rewrites content", () => {
    const ins = canonicalDeliveryTaskInstruction(FILES_INTENT(["report.txt"]), ol());
    expect(ins).toContain("STAGING ONLY");
    expect(ins).toContain("report.txt");
    expect(ins).toMatch(/byte-identical|UNCHANGED/i);
    // No composition directive — staging only, never an authored report.
    expect(ins).not.toContain("Compose the final");
    expect(ins).not.toContain("compose the final operator-facing report");
    // And never points at report.txt as an implicit scratch output.
    expect(ins).not.toContain("write it to outbox/");
    // TEXT mode still composes — into the canonical payload artifact.
    const textIns = canonicalDeliveryTaskInstruction(TEXT_INTENT, ol());
    expect(textIns).toContain(DELIVERY_TEXT_ARTIFACT);
    expect(textIns).toContain("Vietnamese (vi)");
    // UNDETERMINED falls back to goal-language phrasing — never invented.
    const undet = canonicalDeliveryTaskInstruction(TEXT_INTENT, {
      code: null, authority: "UNDETERMINED", evidence: {},
    });
    expect(undet).toContain(languagePhrase(null));
  });
});

/* =================== C. production-goal E2E regression =================== */

describe("C — exact production goal, FILES mode end-to-end", () => {
  const buildMission = (name: string, behaviors: Record<string, string>, content?: Record<string, string>) => {
    const ctx = makeCtx(name);
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = behaviors as never;
    adapter.fileContent = content ?? {};
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
    return { ctx, adapter, mid: String(m.mission_id) };
  };

  it("C1. full happy path — vi authority, transport-only staging, identity pinned through to the bridge", async () => {
    const { ctx, adapter, mid } = buildMission(
      "c1-happy",
      { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "WRITE", T5: "COMPLETE" },
      { T4: VI_REPORT },
    );
    expect(drive(ctx, mid)).toBe("COMPLETED");

    // Canonical language = vi on the delivery task.
    const t5 = taskByKey(ctx, mid, "T5")!;
    const stamped = (t5.metadata as Record<string, unknown>)[
      PAIR_OUTPUT_LANGUAGE_KEY
    ] as { code: string; authority: string };
    expect(stamped).toMatchObject({ code: "vi", authority: "GOAL_DIRECTIVE" });
    // The producer received the PAIR language contract.
    const t4 = taskByKey(ctx, mid, "T4")!;
    expect(String(t4.task_instruction)).toContain("PAIR OUTPUT LANGUAGE CONTRACT");
    // The delivery task's instruction is transport-only.
    expect(String(t5.task_instruction)).toContain("STAGING ONLY");
    expect(String(t5.task_instruction)).not.toContain("Compose the final");

    // Artifact identity pinned at dispatch equals the producer bytes.
    const pin = ((t5.metadata as Record<string, unknown>)
      .pair_delivery_artifact_digests as Record<string, { sha256: string }>);
    const producerSha = sha256File(path.join(ctx.workspace, "outbox", "report.txt"));
    expect(pin["report.txt"].sha256).toBe(producerSha);
    expect(fs.readFileSync(path.join(ctx.workspace, "outbox", "report.txt"), "utf8")).toBe(VI_REPORT);

    // Exactly one TDR, FILES mode, manifest = exactly report.txt,
    // identity pinned into the slot.
    const reqs = deliveries(ctx);
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(req.mode).toBe("FILES");
    const arts = req.artifacts as Array<Record<string, unknown>>;
    expect(arts.map((a) => a.name)).toEqual(["report.txt"]);
    expect(String(arts[0].sha256)).toBe(producerSha);

    // The bridge receives exactly that artifact — filename + bytes —
    // exactly once; a second poll sends nothing (no duplicates).
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call.name).toBe("report.txt");
    // R2.3/R3 — FILES is artifact transport: the wire payload is the
    // digest-pinned FILE itself (document upload), never text — and
    // the bytes handed to the uploader hash to the TDR slot digest.
    expect(call.text).toBeUndefined();
    expect(call.fileBytes).toBeTruthy();
    expect(sha256Hex(Buffer.from(call.fileBytes!))).toBe(String(arts[0].sha256));
    expect(Buffer.from(call.fileBytes!).toString("utf8")).toContain(VI_REPORT);
    const again = await runTransport(ctx);
    expect(again.sent).toEqual([]);
    void adapter;
  });

  it("C2. wrong-language manifested report → FAIL CLOSED pre-mint, zero TDR, zero network", async () => {
    const { ctx, mid } = buildMission(
      "c2-wrong-lang",
      { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "WRITE", T5: "COMPLETE" },
      { T4: EN_REPORT },
    );
    const state = drive(ctx, mid);
    expect(state).not.toBe("COMPLETED");
    // Zero send authority was ever minted.
    expect(deliveries(ctx)).toHaveLength(0);
    // Durable violation evidence.
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH",
    );
    // The delivery task failed and went to governed recovery.
    expect(
      ["FAILED", "CANCELLED"].includes(String(taskByKey(ctx, mid, "T5")!.status)),
    ).toBe(true);
    // Proof: zero network — nothing was ever projected for transport.
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
  });

  it("C3. delivery task clobbers the outbox file — canonical CAS bytes still deliver the producer's content (F4: the file is never authority)", async () => {
    const { ctx, mid } = buildMission(
      "c3-clobber",
      { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "WRITE", T5: "CLOBBER" },
      { T4: VI_REPORT },
    );
    // F4 — the outbox file is transport/staging only: a workspace
    // clobber by the delivery task can never reach the retained CAS
    // object the pin binds. Delivery must succeed with the PRODUCER's
    // verified bytes — not fail, and never with the clobbered bytes.
    const state = drive(ctx, mid);
    expect(state).toBe("COMPLETED");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(
      VI_REPORT,
    );
  });

  it("C4. post-mint mutation → bridge-side digest guard fails closed, zero network calls", async () => {
    const ctx = makeCtx("c4-postmint");
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    const fp = path.join(ctx.workspace, "outbox", "report.txt");
    fs.writeFileSync(fp, VI_REPORT);
    const sha = sha256File(fp);
    const req = mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_C4", metadata: {} },
      task: {
        task_id: "T9",
        metadata: {
          pair_telegram_delivery: {
            requested: true, mode: "FILES", artifacts: ["report.txt"],
          },
        },
      },
      execution: { execution_id: "E_C4" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { "report.txt": sha },
      artifactSources: { "report.txt": fp },
    }) as Record<string, unknown>;
    expect(String((req.artifacts as Array<Record<string, unknown>>)[0].sha256)).toBe(sha);
    // Mutation between mint and send.
    fs.writeFileSync(fp, "tampered after mint");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0); // zero network call burned
    const after = ctx.store.get("telegram_delivery_request", String(req.delivery_id));
    const art = (after.artifacts as Array<Record<string, unknown>>)[0];
    expect(art.state).toBe("FAILED_DELIVERY");
    expect(String(art.last_error)).toContain("FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST");
  });
});

/* =================== D. TEXT canonical payload =================== */

describe("D — TEXT mode: exactly one canonical payload source", () => {
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

  it("D1. TDR text is the composed artifact content — never the 'DONE' acknowledgement", async () => {
    const ctx = makeCtx("d1-text-payload");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    // T3 returns summary "done T3" but writes the real report file —
    // the TDR must carry the FILE content, not the summary.
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
    expect(String(reqs[0].mode)).toBe("TEXT");
    expect(String(reqs[0].text)).toBe(VI_REPORT);
    expect(String(reqs[0].text)).not.toContain("done");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^TEXT:TDR_/);
    expect(String(rec.calls[0].text)).toContain(VI_REPORT);
  });

  it("D2. wrong-language TEXT payload fails closed pre-mint — zero TDR, zero network", async () => {
    const ctx = makeCtx("d2-text-wronglang");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "WRITE" };
    adapter.fileContent = { T3: EN_REPORT }; // English payload, vi canonical
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
    expect(drive(ctx, mid)).not.toBe("COMPLETED");
    expect(deliveries(ctx)).toHaveLength(0);
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH",
    );
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
  });

  it("D3. TEXT task that returns DONE without writing the payload fails closed — 'DONE' is never the deliverable", async () => {
    const ctx = makeCtx("d3-text-done");
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
    expect(drive(ctx, mid)).not.toBe("COMPLETED");
    // No TDR minted: DONE could not become the payload.
    expect(deliveries(ctx)).toHaveLength(0);
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    // F4.4 — "report.txt exists" is never proof; the execution wrote
    // nothing and no in-mission producer contract exists → provenance.
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE",
    );
  });

  it("D4. restart/replay preserves canonical language + payload authority", async () => {
    // Persisted canonical tasks round-tripped through JSON (a restart's
    // reload boundary) replay-verify against the goal-derived authority.
    const plan = reconcilePlanDataflow(textPlan(), {
      telegramIntent: TEXT_INTENT,
      outputLanguage: detectOutputLanguage(TEXT_GOAL),
    }).tasks;
    const reloaded = JSON.parse(JSON.stringify(plan));
    expect(() =>
      assertPlanDataflow(reloaded, {
        telegramIntent: detectTelegramDeliveryIntent(TEXT_GOAL),
        outputLanguage: detectOutputLanguage(TEXT_GOAL),
      }),
    ).not.toThrow();
    const t3 = reloaded.find((t: Record<string, unknown>) => t.task_key === "T3")!;
    const stamped = (t3.metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] as {
      code: string;
    };
    expect(stamped.code).toBe("vi");
    // And mint is still deterministic/idempotent on the persisted shape.
    const ctx = makeCtx("d4-replay");
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.workspace, DELIVERY_TEXT_ARTIFACT),
      VI_REPORT,
    );
    const mintArgs = {
      store: ctx.store,
      mission: { mission_id: "M_D4", metadata: {} },
      task: t3 as Record<string, unknown>,
      execution: { execution_id: "E1" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      textPayload: VI_REPORT,
    };
    const a = mintTelegramDeliveryRequest(mintArgs);
    const b = mintTelegramDeliveryRequest(mintArgs);
    expect(b).toEqual(a); // idempotent mint on replay
    expect(String(a!.text)).toBe(VI_REPORT);
  });
});

/* =================== R1 — independent-audit remediation =================== */

const r1TextPlan = () => [
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
const R1_TEXT_GOAL = "phân tích giá vàng hôm nay rồi gửi kết quả đến telegram";

describe("R1.1 — TEXT validation binds the exact wire payload", () => {
  it("T1. English first 3500 chars + Vietnamese tail: file-level gate would pass vi while the wire payload is English — now the PAYLOAD is validated and it fails closed, zero TDR", async () => {
    const ctx = makeCtx("r11-trunc");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "WRITE" };
    const bypass = EN_REPORT.repeat(16) + "\n" + VI_REPORT.repeat(6);
    // The defect: the old gate validated the WHOLE FILE (→ vi), while the
    // minted wire payload was the first MAX_TEXT_BYTES (→ en).
    expect(classifyTextLanguage(bypass)).toBe("vi");
    expect(materializeDeliveryTextPayload(bypass)).toHaveLength(MAX_TEXT_BYTES);
    expect(classifyTextLanguage(materializeDeliveryTextPayload(bypass))).toBe("en");
    adapter.fileContent = { T3: bypass };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(r1TextPlan(), {
      telegramIntent: TEXT_INTENT,
      outputLanguage: detectOutputLanguage(R1_TEXT_GOAL),
    }).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: R1_TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).not.toBe("COMPLETED");
    expect(deliveries(ctx)).toHaveLength(0);
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    const payload = JSON.stringify(ev.map((e) => e.payload));
    expect(payload).toContain("FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH");
    expect(payload).toContain('"detected_language":"en"');
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
  });

  it("T2. whitespace normalization cannot diverge: TDR.text === materializeDeliveryTextPayload(raw file), byte-exact", () => {
    const ctx = makeCtx("r11-normalize");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "WRITE" };
    const raw = `\n\n   ${VI_REPORT}\n\n   `;
    adapter.fileContent = { T3: raw };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(r1TextPlan(), {
      telegramIntent: TEXT_INTENT,
      outputLanguage: detectOutputLanguage(R1_TEXT_GOAL),
    }).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: R1_TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const req = deliveries(ctx)[0];
    const materialized = materializeDeliveryTextPayload(raw);
    expect(materialized).toBe(VI_REPORT);
    // VALIDATED PAYLOAD === TDR PAYLOAD — bound digest/length/source.
    expect(String(req.text)).toBe(materialized);
    expect(String(req.text_sha256)).toBe(digest(materialized));
    expect(Number(req.text_length)).toBe(materialized.length);
    expect(String(req.text_source_artifact)).toBe(DELIVERY_TEXT_ARTIFACT);
  });

  it("T3. mint never re-reads the source: file content ≠ bound payload → TDR carries the bound payload; post-mint file mutation cannot alter it", async () => {
    const ctx = makeCtx("r11-noread");
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.workspace, DELIVERY_TEXT_ARTIFACT),
      "content that must NEVER reach the wire",
    );
    const req = mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R11", metadata: {} },
      task: {
        task_id: "T3",
        metadata: {
          pair_telegram_delivery: { requested: true, mode: "TEXT", artifacts: [] },
        },
      },
      execution: { execution_id: "E_R11" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      textPayload: VI_REPORT,
    }) as Record<string, unknown>;
    expect(String(req.text)).toBe(VI_REPORT); // bound payload, not file bytes
    // Mutation AFTER mint cannot alter the wire payload — the file is
    // never consulted again.
    fs.writeFileSync(
      path.join(ctx.workspace, DELIVERY_TEXT_ARTIFACT),
      "MUTATED AFTER MINT — must not leak",
    );
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toHaveLength(1);
    expect(String(rec.calls[0].text)).toContain(VI_REPORT);
    expect(String(rec.calls[0].text)).not.toContain("MUTATED");
  });

  it("T4. unbound TEXT mint (no gate payload) fails closed — mint cannot fabricate a payload", () => {
    const ctx = makeCtx("r11-unbound");
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(ctx.workspace, DELIVERY_TEXT_ARTIFACT), VI_REPORT);
    const base = {
      store: ctx.store,
      mission: { mission_id: "M_U", metadata: {} },
      task: {
        task_id: "T3",
        metadata: {
          pair_telegram_delivery: { requested: true, mode: "TEXT", artifacts: [] },
        },
      },
      execution: { execution_id: "E_U" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
    };
    for (const bad of [undefined, ""] as Array<string | undefined>) {
      expect(() =>
        mintTelegramDeliveryRequest({ ...base, textPayload: bad }),
      ).toThrow(/FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_UNBOUND/);
    }
    expect(deliveries(ctx)).toHaveLength(0);
  });
});

describe("R1.2 — FILES digest authority is mandatory", () => {
  const filesMintBase = (ctx: ReturnType<typeof makeCtx>) => ({
    store: ctx.store,
    mission: { mission_id: "M_F", metadata: {} },
    task: {
      task_id: "T3",
      metadata: {
        pair_telegram_delivery: {
          requested: true, mode: "FILES", artifacts: ["a.txt", "b.txt"],
        },
      },
    },
    execution: { execution_id: "E_F" },
    outboxDir: path.join(ctx.workspace, "outbox"),
    workspace: ctx.workspace,
    now: utcnow(),
    defaultChatId: "111",
  });

  it("F1. direct FILES mint without / with incomplete / malformed digest map → rejected", () => {
    const ctx = makeCtx("r12-mint-digest");
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    const sha = digest("A");
    // no map at all
    expect(() => mintTelegramDeliveryRequest(filesMintBase(ctx)))
      .toThrow(/FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST/);
    // incomplete map
    expect(() =>
      mintTelegramDeliveryRequest({
        ...filesMintBase(ctx),
        artifactSha256: { "a.txt": sha },
      }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST/);
    // malformed digest
    expect(() =>
      mintTelegramDeliveryRequest({
        ...filesMintBase(ctx),
        artifactSha256: { "a.txt": sha, "b.txt": "not-a-sha" },
      }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST/);
    // null digest
    expect(() =>
      mintTelegramDeliveryRequest({
        ...filesMintBase(ctx),
        artifactSha256: { "a.txt": sha, "b.txt": null as never },
      }),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST/);
    expect(deliveries(ctx)).toHaveLength(0);
    // complete map mints — every slot carries its canonical SHA-256.
    const ok = mintTelegramDeliveryRequest({
      ...filesMintBase(ctx),
      artifactSha256: { "a.txt": sha, "b.txt": digest("B") },
    }) as Record<string, unknown>;
    for (const a of ok.artifacts as Array<Record<string, unknown>>) {
      expect(String(a.sha256)).toMatch(/^[0-9a-f]{64}$/i);
    }
  });

  it("F2. persisted hashless FILES TDR (pre-R1 mint) → zero network calls, deterministic FAILED_DELIVERY", async () => {
    const ctx = makeCtx("r12-hashless-tdr");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, "a.txt"), "A"); // file EXISTS — still no authority
    ctx.store.put("telegram_delivery_request", "TDR_LEGACY", {
      delivery_id: "TDR_LEGACY",
      mission_id: "M_L",
      task_id: "T_L",
      execution_id: "E_L",
      mode: "FILES",
      artifacts: [{ name: "a.txt", state: "QUEUED", attempt_count: 0, max_attempts: 3 }],
      text: null,
      destination: { provider: "TELEGRAM", chat_id: "111" },
      outbox_dir: outbox,
      workspace: ctx.workspace,
      status: "QUEUED",
      created_at: utcnow(),
    });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    const req = ctx.store.get("telegram_delivery_request", "TDR_LEGACY");
    const art = (req.artifacts as Array<Record<string, unknown>>)[0];
    expect(art.state).toBe("FAILED_DELIVERY");
    expect(String(art.last_error)).toBe("FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST");
    expect(String(req.status)).toBe("FAILED_DELIVERY");
  });

  it("F3. pre-upgrade in-flight execution with no dispatch pin → fail closed at settle, never silently re-baselines current bytes", () => {
    const ctx = makeCtx("r12-nopin");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, "report.txt"), VI_REPORT);
    const m = {
      mission_id: "M_NOPIN",
      project_id: ctx.projectId,
      goal: PROD_GOAL,
      metadata: { authorized_workspaces: [ctx.workspace] },
    };
    const exec = { execution_id: "E_NOPIN" };
    const task = {
      task_id: "TX",
      task_key: "T5",
      required_capabilities: ["TELEGRAM_DELIVERY"],
      metadata: {
        workspace: ctx.workspace,
        pair_telegram_delivery: {
          requested: true, mode: "FILES", artifacts: ["report.txt"],
        },
      },
    };
    const gate = (ctx.runtime as unknown as {
      assertDeliveryDeliverable(
        mission: Record<string, unknown>,
        task: Record<string, unknown>,
        execution: Record<string, unknown>,
      ): { ok: boolean; violation?: Record<string, unknown> };
    }).assertDeliveryDeliverable.bind(ctx.runtime);
    // No pin at all → PIN_MISSING — the gate does NOT adopt the current
    // file hash as the baseline even though the bytes sit right there.
    const noPin = gate(m, task, exec) as { ok: boolean; violation: Record<string, unknown> };
    expect(noPin.ok).toBe(false);
    expect(String(noPin.violation.code)).toBe("FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING");
    // Pin row exists but the artifact entry is absent → PIN_MISSING.
    const partial = gate(m, {
      ...task,
      metadata: { ...task.metadata, pair_delivery_artifact_digests: {} },
    }, exec) as { ok: boolean; violation: Record<string, unknown> };
    expect(partial.ok).toBe(false);
    expect(String(partial.violation.code)).toBe("FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING");
    // Pin entry with a null/malformed digest → PIN_MISSING (no authority).
    const malformed = gate(m, {
      ...task,
      metadata: {
        ...task.metadata,
        pair_delivery_artifact_digests: {
          "report.txt": { path: null, sha256: null },
        },
      },
    }, exec) as { ok: boolean; violation: Record<string, unknown> };
    expect(malformed.ok).toBe(false);
    expect(String(malformed.violation.code)).toBe("FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING");
    // F4.1 — a pin carrying a valid sha256 but NO canonical artifact
    // binding (artifact_id + producer_execution_id) is provenance-blind:
    // even though the bytes sit in the outbox it must fail closed.
    const noBinding = gate(m, {
      ...task,
      metadata: {
        ...task.metadata,
        pair_delivery_artifact_digests: {
          "report.txt": {
            path: null,
            sha256: sha256File(path.join(outbox, "report.txt")),
          },
        },
      },
    }, exec) as { ok: boolean; violation: Record<string, unknown> };
    expect(noBinding.ok).toBe(false);
    expect(String(noBinding.violation.code)).toBe("FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE");
    // Control case — a pin bound to a REAL canonical artifact whose
    // producer is a legitimate dep-predecessor task in this mission.
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_NOPIN",
      key: "TP",
      planId: "PLAN_GATE",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    const good = gate(m, {
      ...task,
      plan_id: "PLAN_GATE",
      depends_on: ["TP"],
      metadata: {
        ...task.metadata,
        pair_delivery_artifact_digests: {
          "report.txt": {
            path: null,
            state: "PINNED",
            artifact_id: prod.artifactId,
            producer_execution_id: prod.eid,
            logical_name: prod.name,
            sha256: sha256Hex(prod.bytes),
          },
        },
      },
    }, exec) as { ok: boolean; sources: Record<string, string> };
    expect(good.ok).toBe(true);
    // The staged source is the CAS blob — never the outbox path.
    expect(String(good.sources["report.txt"])).not.toContain("outbox");
  });
});

describe("R1.3 — new plans must carry digest-covered language authority", () => {
  const r1FilesPlan = () =>
    reconcilePlanDataflow(prodPlan(), {
      telegramIntent: FILES_INTENT(["report.txt"]),
      outputLanguage: detectOutputLanguage(PROD_GOAL),
    }).tasks;
  const deliveryTask = (tasks: Array<Record<string, unknown>>) =>
    tasks.find((t) => t.task_key === "T5")!;
  const expectedLang = () => detectOutputLanguage(PROD_GOAL);
  const intent = () => detectTelegramDeliveryIntent(PROD_GOAL);

  it("P1. new-contract delivery task carries pair_plan_contract{version} + matching stamp → assert passes", () => {
    const plan = r1FilesPlan();
    const md = deliveryTask(plan).metadata as Record<string, unknown>;
    expect((md[PAIR_PLAN_CONTRACT_KEY] as Record<string, unknown>).version)
      .toBe(PAIR_PLAN_CONTRACT_VERSION);
    expect((md[PAIR_OUTPUT_LANGUAGE_KEY] as { code: string }).code).toBe("vi");
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).not.toThrow();
  });

  it("P2. new-contract plan MISSING the language stamp → FAIL CLOSED", () => {
    const plan = r1FilesPlan();
    delete (deliveryTask(plan).metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY];
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
  });

  it("P3. stamped≠expected on a new-contract plan → FAIL (tampered authority)", () => {
    const plan = r1FilesPlan();
    (deliveryTask(plan).metadata as Record<string, unknown>)[PAIR_OUTPUT_LANGUAGE_KEY] =
      { ...expectedLang(), code: "en" };
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
  });

  it("P4. plan-contract marker on a NON-delivery task → forged, FAIL", () => {
    const plan = r1FilesPlan();
    (plan[0].metadata as Record<string, unknown>)[PAIR_PLAN_CONTRACT_KEY] = {
      version: PAIR_PLAN_CONTRACT_VERSION,
    };
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
  });

  it("P5. R2.2 — marker absence is not legacy provenance: no-marker delivery plan → FAIL (forced replan)", () => {
    const plan = r1FilesPlan();
    const md = deliveryTask(plan).metadata as Record<string, unknown>;
    delete md[PAIR_OUTPUT_LANGUAGE_KEY];
    delete md[PAIR_PLAN_CONTRACT_KEY];
    // Pre-contract-shaped tasks are rejected at EVERY validation
    // boundary — there is no tolerated absence anymore.
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
    // A no-marker plan carrying a WRONG stamp also fails.
    md[PAIR_OUTPUT_LANGUAGE_KEY] = { ...expectedLang(), code: "en" };
    expect(() =>
      assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
  });

  it("P6. unknown/malformed plan-contract version → FAIL CLOSED (no authority)", () => {
    for (const v of [999, "x", null, -1]) {
      const plan = r1FilesPlan();
      (deliveryTask(plan).metadata as Record<string, unknown>)[PAIR_PLAN_CONTRACT_KEY] =
        { version: v };
      expect(() =>
        assertPlanDataflow(plan, { telegramIntent: intent(), outputLanguage: expectedLang() }),
      ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
    }
  });

  it("P7. reconcile strips a planner-forged marker — authority is re-stamped only by PAIR", () => {
    const forged = prodPlan();
    (forged[4].metadata as Record<string, unknown>)[PAIR_PLAN_CONTRACT_KEY] = { version: 777 };
    const plan = reconcilePlanDataflow(forged, {
      telegramIntent: FILES_INTENT(["report.txt"]),
      outputLanguage: expectedLang(),
    }).tasks;
    const md = deliveryTask(plan).metadata as Record<string, unknown>;
    expect((md[PAIR_PLAN_CONTRACT_KEY] as Record<string, unknown>).version)
      .toBe(PAIR_PLAN_CONTRACT_VERSION);
    // Reloaded through JSON (a restart's reload boundary): still passes.
    const reloaded = JSON.parse(JSON.stringify(plan));
    expect(() =>
      assertPlanDataflow(reloaded, { telegramIntent: intent(), outputLanguage: expectedLang() }),
    ).not.toThrow();
  });
});

describe("R1.4 — language directives are output-scoped", () => {
  it("L1. 'Read the sources in Vietnamese and write the final report in English.' → en", () => {
    const ol = detectOutputLanguage(
      "Read the sources in Vietnamese and write the final report in English.",
    );
    expect(ol.code).toBe("en");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
  });
  it("L2. 'Read English sources and write the final report in Vietnamese.' → vi", () => {
    const ol = detectOutputLanguage(
      "Read English sources and write the final report in Vietnamese.",
    );
    expect(ol.code).toBe("vi");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
  });
  it("L3. source-scoped mention mints nothing — dominant goal language decides", () => {
    const ol = detectOutputLanguage("the sources are in Vietnamese, summarize them");
    expect(ol.authority).toBe("GOAL_LANGUAGE");
    expect(ol.code).toBe("en"); // goal is English-dominant
  });
  it("L4. vi source + vi output stays vi; source directive cannot become authority", () => {
    const ol = detectOutputLanguage(
      "đọc nguồn tiếng anh rồi viết báo cáo bằng tiếng việt",
    );
    expect(ol.code).toBe("vi");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
  });
  it("L5. genuinely conflicting output directives → UNDETERMINED, never a regex-order pick", () => {
    const ol = detectOutputLanguage(
      "write the report in English and also write it in Vietnamese",
    );
    expect(ol.code).toBeNull();
    expect(ol.authority).toBe("UNDETERMINED");
    expect(String(ol.evidence.detector)).toBe("conflicting_output_directives");
  });
  it("L6. exact production Vietnamese goal remains vi", () => {
    const ol = detectOutputLanguage(PROD_GOAL);
    expect(ol.code).toBe("vi");
    expect(ol.authority).toBe("GOAL_DIRECTIVE");
  });
});

/* =================== INDEPENDENT RE-AUDIT R2 =================== */

describe("R2.1 — legacy TEXT TDRs are quarantined, never migrated", () => {
  const putTextReq = (
    ctx: ReturnType<typeof makeCtx>,
    id: string,
    body: Record<string, unknown>,
  ) =>
    ctx.store.put("telegram_delivery_request", id, {
      delivery_id: id,
      mission_id: "M_L1",
      task_id: "T_L1",
      execution_id: "E_L1",
      mode: "TEXT",
      artifacts: [],
      destination: {
        provider: "TELEGRAM",
        chat_id: "111",
        provenance: "CONFIGURED_DEFAULT",
      },
      outbox_dir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      status: "QUEUED",
      text_state: "QUEUED",
      attempt_count: 0,
      max_attempts: 3,
      created_at: utcnow(),
      ...body,
    });

  const validEvidence = (text: string) => ({
    text,
    text_sha256: digest(text),
    text_length: text.length,
    text_source_artifact: DELIVERY_TEXT_ARTIFACT,
  });

  it("Q1. legacy 'DONE' TDR with no evidence → FAILED_DELIVERY, zero network, payload never re-baselined", async () => {
    const ctx = makeCtx("r2-q1");
    putTextReq(ctx, "TDR_Q1", { text: "DONE" });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0); // zero network
    const req = ctx.store.get("telegram_delivery_request", "TDR_Q1");
    expect(req.status).toBe("FAILED_DELIVERY");
    expect(req.text_state).toBe("FAILED_DELIVERY");
    expect(String(req.last_error)).toBe("FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE");
    // Terminal — never projected again.
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(0);
    // No migration: the raw persisted payload is untouched.
    expect(req.text).toBe("DONE");
    expect(req.text_sha256).toBeUndefined();
  });

  it("Q2-Q5. malformed evidence matrix → every variant fails closed, zero network", async () => {
    const ctx = makeCtx("r2-q2");
    const base = validEvidence("the real report");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["TDR_Q2", { ...base, text_sha256: null }], // missing sha
      ["TDR_Q3", { ...base, text_sha256: digest("different bytes") }], // wrong sha
      ["TDR_Q4", { ...base, text_length: 9999 }], // wrong length
      ["TDR_Q5", { ...base, text_source_artifact: "outbox/other.txt" }], // wrong source
      ["TDR_Q6", { ...base, text: "" }], // empty payload
    ];
    for (const [id, body] of cases) putTextReq(ctx, id, body);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    for (const [id] of cases) {
      const req = ctx.store.get("telegram_delivery_request", id);
      expect(req.status).toBe("FAILED_DELIVERY");
      expect(String(req.last_error)).toBe("FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE");
    }
  });

  it("Q6. valid new-era TEXT TDR → projects and sends normally", async () => {
    const ctx = makeCtx("r2-q6v");
    putTextReq(ctx, "TDR_Q6V", validEvidence("the composed report"));
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["TEXT:TDR_Q6V"]);
    expect(rec.calls).toHaveLength(1);
    expect(String(rec.calls[0].text)).toContain("the composed report");
    const req = ctx.store.get("telegram_delivery_request", "TDR_Q6V");
    expect(req.status).toBe("SENT");
  });
});

describe("R2.2 — plan-contract provenance is authoritative", () => {
  const r2FilesPlan = () =>
    reconcilePlanDataflow(prodPlan(), {
      telegramIntent: FILES_INTENT(["report.txt"]),
      outputLanguage: detectOutputLanguage(PROD_GOAL),
    }).tasks;

  it("V1. persisted preview carries container-level plan_contract_version (outside task metadata)", () => {
    const ctx = makeCtx("r2-v1", {
      planner: (() => ({ tasks: r2FilesPlan() })) as never,
    });
    const pv = ctx.control.createPlanPreview({
      project_id: ctx.projectId,
      goal: PROD_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      operator_id: "op1",
    });
    const row = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(row.plan_contract_version).toBe(PAIR_PLAN_CONTRACT_VERSION);
  });

  it("V2. confirm carries the contract version into pinned_plan provenance", () => {
    const ctx = makeCtx("r2-v2", {
      planner: (() => ({ tasks: r2FilesPlan() })) as never,
    });
    const pv = ctx.control.createPlanPreview({
      project_id: ctx.projectId,
      goal: PROD_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      operator_id: "op1",
    });
    const m = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id),
      plan_digest: String(pv.plan_digest),
      operator_id: "op1",
    });
    const pinned = (m.metadata as Record<string, unknown>).pinned_plan as Record<
      string,
      unknown
    >;
    expect(pinned.plan_contract_version).toBe(PAIR_PLAN_CONTRACT_VERSION);
  });

  it("V3. persisted pre-contract preview (no version, no marker) → confirm FAIL CLOSED (forced re-preview)", () => {
    const ctx = makeCtx("r2-v3");
    // A pre-v2-shaped persisted row: no container version, no task
    // marker — indistinguishable from a bypassed fresh plan.
    const legacyTasks = reconcilePlanDataflow(prodPlan(), {
      telegramIntent: FILES_INTENT(["report.txt"]),
    }).tasks;
    ctx.store.put("mission_plan_preview", "MPP_OLD", {
      preview_id: "MPP_OLD",
      state: "READY",
      project_id: ctx.projectId,
      mission_input: {
        project_id: ctx.projectId,
        goal: PROD_GOAL,
        metadata: {},
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: [ctx.workspace],
        risk_ceiling: "LOW",
        operator_id: "op1",
      },
      effective_input_digest: "legacy",
      plan_digest: "legacydigest",
      canonical_tasks: legacyTasks,
      planner_attempt_id: null,
      planner: null,
      consumed_mission_id: null,
      created_at: utcnow(),
      expires_at: "2999-01-01T00:00:00Z",
      version: 0,
    });
    expect(() =>
      ctx.control.confirmPlanPreview({
        preview_id: "MPP_OLD",
        plan_digest: "legacydigest",
        operator_id: "op1",
      }),
    ).toThrow(/FAIL_CLOSED_OUTPUT_LANGUAGE_AUTHORITY/);
    expect(ctx.store.list("mission")).toHaveLength(0); // forced replan — nothing committed
  });

  it("V4. a fresh plan bypassing reconcile (manifest but no contract marker) → FAIL CLOSED at commit", () => {
    const ctx = makeCtx("r2-v4");
    // Operator-pinned tasks where the delivery task carries its manifest
    // but was never stamped under the contract era — marker absence is
    // NOT proof of legacy: it is missing authority.
    const bypass = prodPlan();
    (bypass[4].metadata as Record<string, unknown>).pair_telegram_delivery = {
      requested: true,
      mode: "FILES",
      artifacts: ["report.txt"],
    };
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: PROD_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: bypass },
    });
    // First tick: CREATED → PLANNING. The planning tick fails closed —
    // marker absence is missing authority, not legacy provenance.
    expect(() => drive(ctx, String(m.mission_id), 3)).toThrow(/missing_plan_contract/);
    expect(ctx.store.list("telegram_delivery_request")).toHaveLength(0);
  });
});

describe("R2.3 — FILES artifacts hit the network as the pinned bytes", () => {
  const mintFiles = (
    ctx: ReturnType<typeof makeCtx>,
    file: string,
    content: string,
  ) => {
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, file);
    fs.writeFileSync(fp, content);
    const sha = sha256File(fp);
    return mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R23", metadata: {} },
      task: {
        task_id: "T_R23",
        metadata: {
          pair_telegram_delivery: {
            requested: true,
            mode: "FILES",
            artifacts: [file],
          },
        },
      },
      execution: { execution_id: "E_R23" },
      outboxDir: outbox,
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { [file]: sha },
      artifactSources: { [file]: fp },
    }) as Record<string, unknown>;
  };

  it("W1. report.txt transports as a FILE (document), never text — whitespace preserved", async () => {
    const ctx = makeCtx("r2-w1");
    const content = `\n\n  ${VI_REPORT}\n\n`;
    const req = mintFiles(ctx, "report.txt", content);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    const call = rec.calls[0];
    expect(call.text).toBeUndefined();
    expect(call.filePath).toBeTruthy();
    // R3 — the uploader receives the verified BYTES, not a path to
    // re-read: leading/trailing whitespace preserved, byte-identical.
    expect(call.fileBytes).toBeTruthy();
    expect(Buffer.from(call.fileBytes!).toString("utf8")).toBe(content);
    expect(sha256Hex(Buffer.from(call.fileBytes!))).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("W2. a >3600-char .txt is preserved in full (no truncation)", async () => {
    const ctx = makeCtx("r2-w2");
    const content = EN_REPORT.repeat(60); // ~13k chars — past the old 3600 cut
    mintFiles(ctx, "report.txt", content);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    const wire = Buffer.from(rec.calls[0].fileBytes!).toString("utf8");
    expect(wire).toBe(content);
    expect(wire.length).toBe(content.length);
  });

  it("W3. mutation after projection cannot alter transmitted bytes (TOCTOU closed)", async () => {
    const ctx = makeCtx("r2-w3");
    const req = mintFiles(ctx, "report.txt", VI_REPORT);
    // Project first (digest verified + snapshot pinned), THEN mutate the
    // source — the wire bytes must still be the authorized snapshot.
    const projected = pendingTelegramDeliveries(ctx.store);
    expect(projected).toHaveLength(1);
    const source = path.join(ctx.workspace, "outbox", "report.txt");
    fs.writeFileSync(source, "MUTATED AFTER PROJECTION");
    const rec = recordingTransport();
    const r = await transportTelegramDelivery({
      request: projected[0],
      transport: rec.transport,
      isAllowed: () => true,
      backend: storeBackend(ctx, projected[0]),
    });
    expect(r.sent).toEqual(["report.txt"]);
    const wire = Buffer.from(rec.calls[0].fileBytes!).toString("utf8");
    expect(wire).toBe(VI_REPORT); // the pinned snapshot, not the mutation
    expect(sha256Hex(Buffer.from(rec.calls[0].fileBytes!))).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("W4. snapshot pins bytes under .delivery-snapshots; a tampered snapshot never reaches the network", async () => {
    const ctx = makeCtx("r2-w4");
    const req = mintFiles(ctx, "report.txt", VI_REPORT);
    const projected = pendingTelegramDeliveries(ctx.store);
    expect(projected).toHaveLength(1);
    const snapPath = String(
      (projected[0].artifacts as Array<Record<string, unknown>>)[0].path,
    );
    expect(snapPath).toContain(".delivery-snapshots");
    // The snapshot hashes to the authorized slot digest.
    expect(sha256File(snapPath)).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
    // Tamper the snapshot post-projection → transport skips the slot
    // entirely (no claim, no network call).
    fs.writeFileSync(snapPath, "tampered snapshot");
    const rec = recordingTransport();
    const r = await transportTelegramDelivery({
      request: projected[0],
      transport: rec.transport,
      isAllowed: () => true,
      backend: storeBackend(ctx, projected[0]),
    });
    expect(r.sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    // Next projection re-verifies the source and re-pins → heals and
    // sends exactly the authorized bytes once.
    const rec2 = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec2.transport });
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec2.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
  });

  it("W5. binary artifacts still transport as documents — lifecycle unchanged", async () => {
    const ctx = makeCtx("r2-w5");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    fs.writeFileSync(path.join(outbox, "chart.png"), png);
    const sha = sha256File(path.join(outbox, "chart.png"));
    mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R25", metadata: {} },
      task: {
        task_id: "T_R25",
        metadata: {
          pair_telegram_delivery: {
            requested: true,
            mode: "FILES",
            artifacts: ["chart.png"],
          },
        },
      },
      execution: { execution_id: "E_R25" },
      outboxDir: outbox,
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { "chart.png": sha },
      artifactSources: { "chart.png": path.join(outbox, "chart.png") },
    });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["chart.png"]);
    const call = rec.calls[0];
    expect(call.filePath).toBeTruthy();
    expect(Buffer.from(call.fileBytes!)).toEqual(png);
    const req = ctx.store.list("telegram_delivery_request")[0];
    expect(req.status).toBe("SENT");
  });
});

describe("R3 — hashed bytes ARE the network bytes (post-verification TOCTOU closed)", () => {
  const mintFiles2 = (
    ctx: ReturnType<typeof makeCtx>,
    file: string,
    content: string | Buffer,
  ) => {
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, file);
    fs.writeFileSync(fp, content);
    const sha = sha256File(fp);
    return mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R3", metadata: {} },
      task: {
        task_id: "T_R3",
        metadata: {
          pair_telegram_delivery: {
            requested: true,
            mode: "FILES",
            artifacts: [file],
          },
        },
      },
      execution: { execution_id: "E_R3" },
      outboxDir: outbox,
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { [file]: sha },
      artifactSources: { [file]: fp },
    }) as Record<string, unknown>;
  };

  it("X1. ADVERSARIAL: snapshot mutated AFTER byte materialization+verify — wire bytes are still the authorized original", async () => {
    const ctx = makeCtx("r3-x1");
    const req = mintFiles2(ctx, "report.txt", VI_REPORT);
    const projected = pendingTelegramDeliveries(ctx.store);
    expect(projected).toHaveLength(1);
    const snapPath = String(
      (projected[0].artifacts as Array<Record<string, unknown>>)[0].path,
    );
    // The mutation lands in the exact remaining window — AFTER the
    // transport's read+digest verification, inside the claim itself.
    // With R3 the sender holds the verified BUFFER, so bytes B on disk
    // can never replace bytes A on the wire.
    const inner = storeBackend(ctx, projected[0]);
    const backend: DeliveryBackend = {
      ...inner,
      begin: (a: string | null) => {
        fs.writeFileSync(snapPath, "MUTATED BETWEEN VERIFY AND SEND");
        return inner.begin(a);
      },
    };
    const rec = recordingTransport();
    const r = await transportTelegramDelivery({
      request: projected[0],
      transport: rec.transport,
      isAllowed: () => true,
      backend,
    });
    expect(r.sent).toEqual(["report.txt"]);
    const call = rec.calls[0];
    // F/G — the captured upload bytes are the authorized original and
    // hash to the TDR slot digest.
    expect(call.fileBytes).toBeTruthy();
    expect(Buffer.from(call.fileBytes!).toString("utf8")).toBe(VI_REPORT);
    expect(sha256Hex(Buffer.from(call.fileBytes!))).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("X2. .md stays a file/document — digest-verified bytes, never text", async () => {
    const ctx = makeCtx("r3-x2");
    const md = "# Báo cáo\n\n- điểm 1\n- điểm 2\n";
    mintFiles2(ctx, "report.md", md);
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.md"]);
    const call = rec.calls[0];
    expect(call.text).toBeUndefined();
    expect(call.filePath).toBeTruthy();
    expect(Buffer.from(call.fileBytes!).toString("utf8")).toBe(md);
  });

  it("X3. retention: a SENT slot's snapshot is pruned on the next projection pass", async () => {
    const ctx = makeCtx("r3-x3");
    mintFiles2(ctx, "report.txt", VI_REPORT);
    const projected = pendingTelegramDeliveries(ctx.store);
    const snapPath = String(
      (projected[0].artifacts as Array<Record<string, unknown>>)[0].path,
    );
    expect(fs.existsSync(snapPath)).toBe(true);
    const rec = recordingTransport();
    await runTransport(ctx, { transport: rec.transport });
    // Terminal (SENT) → the staged bytes are removed; the slot sha256
    // remains the durable identity evidence.
    pendingTelegramDeliveries(ctx.store);
    expect(fs.existsSync(snapPath)).toBe(false);
    const req = ctx.store.list("telegram_delivery_request")[0];
    expect(req.status).toBe("SENT");
    expect(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    ).toMatch(/^[0-9a-f]{64}$/i);
  });
});

describe("R4 — snapshot-first retry authority + bounded size + tmp cleanup", () => {
  const mintR4 = (
    ctx: ReturnType<typeof makeCtx>,
    file: string,
    content: string | Buffer,
  ) => {
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, file);
    fs.writeFileSync(fp, content);
    const sha = sha256File(fp);
    return mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R4", metadata: {} },
      task: {
        task_id: "T_R4",
        metadata: {
          pair_telegram_delivery: {
            requested: true,
            mode: "FILES",
            artifacts: [file],
          },
        },
      },
      execution: { execution_id: "E_R4" },
      outboxDir: outbox,
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { [file]: sha },
      artifactSources: { [file]: fp },
    }) as Record<string, unknown>;
  };

  const snapOf = (ctx: ReturnType<typeof makeCtx>, deliveryId: string, name: string) =>
    path.join(
      deliverySnapshotRoot(ctx.store),
      `${deliveryId}-${name}`.replace(/[^A-Za-z0-9._-]/g, "_"),
    );

  it("Y1. definite send failure → source DELETED → retry sends the retained authorized snapshot", async () => {
    const ctx = makeCtx("r4-y1");
    const req = mintR4(ctx, "report.txt", VI_REPORT);
    // First projection pins the snapshot; first send fails definitely.
    const projected = pendingTelegramDeliveries(ctx.store);
    expect(projected).toHaveLength(1);
    const rec1 = recordingTransport({ fail: new Set(["report.txt"]) });
    const r1 = await transportTelegramDelivery({
      request: projected[0],
      transport: rec1.transport,
      isAllowed: () => true,
      backend: storeBackend(ctx, projected[0]),
    });
    expect(r1.sent).toEqual([]);
    // Slot is back to QUEUED with backoff; now the source vanishes.
    fs.rmSync(path.join(ctx.workspace, "outbox", "report.txt"));
    const later = new Date(Date.now() + 120_000).toISOString();
    const rec2 = recordingTransport();
    const { sent } = await runTransport(ctx, {
      transport: rec2.transport,
      now: later,
    });
    // The retained snapshot is the retry authority — original bytes ship.
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec2.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
    expect(sha256Hex(Buffer.from(rec2.calls[0].fileBytes!))).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("Y2. definite send failure → source MUTATED to bytes B → retry still sends snapshot A", async () => {
    const ctx = makeCtx("r4-y2");
    mintR4(ctx, "report.txt", VI_REPORT);
    const projected = pendingTelegramDeliveries(ctx.store);
    const rec1 = recordingTransport({ fail: new Set(["report.txt"]) });
    await transportTelegramDelivery({
      request: projected[0],
      transport: rec1.transport,
      isAllowed: () => true,
      backend: storeBackend(ctx, projected[0]),
    });
    fs.writeFileSync(
      path.join(ctx.workspace, "outbox", "report.txt"),
      "MUTATED SOURCE BYTES B",
    );
    const later = new Date(Date.now() + 120_000).toISOString();
    const rec2 = recordingTransport();
    const { sent } = await runTransport(ctx, {
      transport: rec2.transport,
      now: later,
    });
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec2.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
  });

  it("Y3. restart shape: persisted QUEUED TDR + valid retained snapshot + missing source → snapshot reused", async () => {
    const ctx = makeCtx("r4-y3");
    const req = mintR4(ctx, "report.txt", VI_REPORT);
    // First pass pins the snapshot (nothing transported yet).
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(1);
    // Simulate restart: the workspace producer file is gone, only the
    // persisted TDR + retained snapshot remain.
    fs.rmSync(path.join(ctx.workspace, "outbox", "report.txt"));
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
    expect(sha256Hex(Buffer.from(rec.calls[0].fileBytes!))).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("Y4. wrong-digest snapshot is never sent — reconstruction only from a sha-matching source", async () => {
    const ctx = makeCtx("r4-y4");
    const req = mintR4(ctx, "report.txt", VI_REPORT);
    const id = String(req.delivery_id);
    const snap = snapOf(ctx, id, "report.txt");
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(1);
    // Corrupt the retained snapshot — it must never be trusted.
    fs.writeFileSync(snap, "corrupted snapshot bytes");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    // Source still matches canonical sha → reconstruction is allowed.
    expect(sent).toEqual(["report.txt"]);
    expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
    expect(sha256File(snap)).toBe(
      String((req.artifacts as Array<Record<string, unknown>>)[0].sha256),
    );
  });

  it("Y5. wrong-digest snapshot + mutated source → durable failure, zero network", async () => {
    const ctx = makeCtx("r4-y5");
    const req = mintR4(ctx, "report.txt", VI_REPORT);
    const id = String(req.delivery_id);
    const snap = snapOf(ctx, id, "report.txt");
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(1);
    fs.writeFileSync(snap, "corrupted");
    fs.writeFileSync(
      path.join(ctx.workspace, "outbox", "report.txt"),
      "mutated source",
    );
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
    const after = ctx.store.get("telegram_delivery_request", id);
    expect(after.status).toBe("FAILED_DELIVERY");
    const failedArt = (after.artifacts as Array<Record<string, unknown>>)[0];
    expect(failedArt.state).toBe("FAILED_DELIVERY");
    expect(String(failedArt.last_error)).toContain("FAIL_CLOSED_TELEGRAM_ARTIFACT");
  });

  it("Y6. size bound: exactly at maximum → permitted; max+1 → durable terminal failure, 0 begin, 0 network, never repolled", async () => {
    const ctx = makeCtx("r4-y6");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    // Exactly at the bound → allowed.
    const okBuf = Buffer.alloc(MAX_TELEGRAM_FILE_BYTES, 0x61);
    fs.writeFileSync(path.join(outbox, "big-ok.txt"), okBuf);
    const shaOk = sha256File(path.join(outbox, "big-ok.txt"));
    mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_Y6A", metadata: {} },
      task: {
        task_id: "T_Y6A",
        metadata: {
          pair_telegram_delivery: {
            requested: true, mode: "FILES", artifacts: ["big-ok.txt"],
          },
        },
      },
      execution: { execution_id: "E_Y6A" },
      outboxDir: outbox,
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { "big-ok.txt": shaOk },
      artifactSources: { "big-ok.txt": path.join(outbox, "big-ok.txt") },
    });
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["big-ok.txt"]);
    expect(rec.calls[0].fileBytes!.length).toBe(MAX_TELEGRAM_FILE_BYTES);

    // max + 1 byte → durable terminal failure.
    const ctx2 = makeCtx("r4-y6b");
    const outbox2 = path.join(ctx2.workspace, "outbox");
    fs.mkdirSync(outbox2, { recursive: true });
    const bigBuf = Buffer.alloc(MAX_TELEGRAM_FILE_BYTES + 1, 0x62);
    fs.writeFileSync(path.join(outbox2, "big.txt"), bigBuf);
    const shaBig = sha256File(path.join(outbox2, "big.txt"));
    const req2 = mintTelegramDeliveryRequest({
      store: ctx2.store,
      mission: { mission_id: "M_Y6B", metadata: {} },
      task: {
        task_id: "T_Y6B",
        metadata: {
          pair_telegram_delivery: {
            requested: true, mode: "FILES", artifacts: ["big.txt"],
          },
        },
      },
      execution: { execution_id: "E_Y6B" },
      outboxDir: outbox2,
      workspace: ctx2.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { "big.txt": shaBig },
      artifactSources: { "big.txt": path.join(outbox2, "big.txt") },
    }) as Record<string, unknown>;
    const rec2 = recordingTransport();
    const r2 = await runTransport(ctx2, { transport: rec2.transport });
    expect(r2.sent).toEqual([]);
    expect(rec2.calls).toHaveLength(0); // zero network, zero begin
    const after = ctx2.store.get(
      "telegram_delivery_request",
      String(req2.delivery_id),
    );
    expect(after.status).toBe("FAILED_DELIVERY");
    const art = (after.artifacts as Array<Record<string, unknown>>)[0];
    expect(String(art.last_error)).toBe(
      "FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE",
    );
    expect(art.state).toBe("FAILED_DELIVERY");
    expect(art.attempt_started_at).toBeUndefined(); // never claimed
    // Second poll does not attempt it again.
    const again = await runTransport(ctx2, { transport: rec2.transport });
    expect(again.sent).toEqual([]);
    expect(rec2.calls).toHaveLength(0);
  }, 30000);

  it("Y7. orphan <snap>.tmp cleaned with terminal lifecycle; empty dir removed", async () => {
    const ctx = makeCtx("r4-y7");
    const req = mintR4(ctx, "report.txt", VI_REPORT);
    const id = String(req.delivery_id);
    const snap = snapOf(ctx, id, "report.txt");
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(1);
    // Crash-shaped artifact: a stale staging tmp beside the snapshot.
    fs.writeFileSync(`${snap}.tmp`, "orphan tmp");
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual(["report.txt"]);
    // Terminal (SENT) → next pass removes snapshot AND its orphan tmp.
    pendingTelegramDeliveries(ctx.store);
    expect(fs.existsSync(snap)).toBe(false);
    expect(fs.existsSync(`${snap}.tmp`)).toBe(false);
    expect(
      fs.existsSync(deliverySnapshotRoot(ctx.store)),
    ).toBe(false);
  });
});

describe("R5 — true stat-first bounded file authority (no unbounded read)", () => {
  const MAX = MAX_TELEGRAM_FILE_BYTES;
  const fakeSha = "a".repeat(64);

  /** sparse MAX+1 file — allocated on disk lazily, NEVER in memory. */
  const sparseOversize = (fp: string) => {
    fs.writeFileSync(fp, "");
    fs.truncateSync(fp, MAX + 1);
  };
  /** every readFileSync call on `fp`, with the byte-length it returned */
  const readsOf = (
    spy: ReturnType<typeof vi.spyOn>,
    fp: string,
  ): number[] =>
    (spy.mock.calls as Array<[unknown, ...unknown[]]>)
      .map((c, i) => ({ arg: c[0], i }))
      .filter(({ arg }) => String(arg) === fp)
      .map(({ i }) =>
        Buffer.isBuffer(spy.mock.results[i].value)
          ? (spy.mock.results[i].value as Buffer).length
          : String(spy.mock.results[i].value).length,
      );

  const mintZ = (
    ctx: ReturnType<typeof makeCtx>,
    file: string,
    sha: string,
  ) =>
    mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_R5", metadata: {} },
      task: {
        task_id: "T_R5",
        metadata: {
          pair_telegram_delivery: {
            requested: true, mode: "FILES", artifacts: [file],
          },
        },
      },
      execution: { execution_id: "E_R5" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
      artifactSha256: { [file]: sha },
      // F4.3 — the stamped canonical byte source; the outbox path is
      // used here only as the CAS-path stand-in for the fixture.
      artifactSources: { [file]: path.join(ctx.workspace, "outbox", file) },
    }) as Record<string, unknown>;

  it("Z1. projection source MAX+1 → FAILED TOO_LARGE with ZERO full-file read", async () => {
    const ctx = makeCtx("r5-z1");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, "big.txt");
    sparseOversize(fp);
    mintZ(ctx, "big.txt", fakeSha);
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      const projected = pendingTelegramDeliveries(ctx.store);
      expect(projected).toHaveLength(0);
      const rec = recordingTransport();
      const { sent } = await runTransport(ctx, { transport: rec.transport });
      expect(sent).toEqual([]);
      expect(rec.calls).toHaveLength(0);
    } finally {
      // The oversized file was NEVER fully materialized.
      expect(readsOf(spy, fp)).toEqual([]);
      spy.mockRestore();
    }
    const after = ctx.store.get(
      "telegram_delivery_request",
      String(deliveries(ctx)[0].delivery_id),
    );
    const art = (after.artifacts as Array<Record<string, unknown>>)[0];
    expect(art.state).toBe("FAILED_DELIVERY");
    expect(art.last_error).toBe("FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE");
  });

  it("Z2. oversized retained snapshot → rejected by stat before ANY read; reconstruction still allowed from valid source", async () => {
    const ctx = makeCtx("r5-z2");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, "report.txt");
    fs.writeFileSync(fp, VI_REPORT);
    const req = mintZ(ctx, "report.txt", sha256File(fp));
    // First pass stages a small valid snapshot.
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(1);
    const snap = path.join(
      deliverySnapshotRoot(ctx.store),
      `${String(req.delivery_id)}-report.txt`.replace(/[^A-Za-z0-9._-]/g, "_"),
    );
    expect(fs.existsSync(snap)).toBe(true);
    // Crash-shaped: the retained snapshot is now an oversized sparse file.
    sparseOversize(snap);
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      const rec = recordingTransport();
      const { sent } = await runTransport(ctx, { transport: rec.transport });
      expect(sent).toEqual(["report.txt"]); // rebuilt from valid source
      expect(Buffer.from(rec.calls[0].fileBytes!).toString("utf8")).toBe(VI_REPORT);
      // No readFileSync ever materialized the oversized snapshot: the
      // only snapPath read allowed is the post-rename verify of the
      // freshly re-staged small file.
      for (const len of readsOf(spy, snap)) expect(len).toBeLessThanOrEqual(MAX);
    } finally {
      spy.mockRestore();
    }
  });

  it("Z3. dispatch pin on oversized canonical artifact → TOO_LARGE state, never re-reads the workspace file", () => {
    const ctx = makeCtx("r5-z3");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, "big.txt");
    // A legit in-mission producer whose canonical artifact exceeds the
    // Telegram bound (but sits under the CAS bound): real bytes through
    // the real ingest seam.
    mkCanonicalProducer(ctx, {
      missionId: "M_Z3",
      key: "TP",
      planId: "PLAN_Z3",
      name: "outbox/big.txt",
      bytes: Buffer.alloc(MAX_TELEGRAM_FILE_BYTES + 1, 0x62),
    });
    ctx.store.put("task", "T_Z3", {
      task_id: "T_Z3",
      task_key: "T5",
      mission_id: "M_Z3",
      plan_id: "PLAN_Z3",
      depends_on: ["TP"],
      required_capabilities: ["TELEGRAM_DELIVERY"],
      metadata: {
        workspace: ctx.workspace,
        pair_telegram_delivery: {
          requested: true, mode: "FILES", artifacts: ["big.txt"],
        },
      },
    });
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      (
        ctx.runtime as unknown as {
          pinDeliveryArtifactDigests(
            m: Record<string, unknown>,
            t: Record<string, unknown>,
          ): void;
        }
      ).pinDeliveryArtifactDigests(
        { project_id: ctx.projectId, mission_id: "M_Z3", plan_revision: 1, metadata: {} },
        ctx.store.get("task", "T_Z3"),
      );
      // The pin must never re-materialize the workspace file itself.
      expect(readsOf(spy, fp)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const pin = (
      ctx.store.get("task", "T_Z3").metadata as Record<string, unknown>
    ).pair_delivery_artifact_digests as Record<
      string,
      { path: string | null; sha256: string | null; state: string }
    >;
    expect(pin["big.txt"].state).toBe("TOO_LARGE");
    expect(pin["big.txt"].sha256).toBeNull();
  });

  it("Z4. settle-time canonical row tampered after pin → PROVENANCE violation, ZERO full-file read, zero mint", () => {
    const ctx = makeCtx("r5-z4");
    const outbox = path.join(ctx.workspace, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    const fp = path.join(outbox, "report.txt");
    fs.writeFileSync(fp, VI_REPORT);
    const prod = mkCanonicalProducer(ctx, {
      missionId: "M_Z4",
      key: "TP",
      planId: "PLAN_Z4",
      name: "outbox/report.txt",
      bytes: VI_REPORT,
    });
    const task = {
      task_id: "T_Z4",
      plan_id: "PLAN_Z4",
      depends_on: ["TP"],
      required_capabilities: ["TELEGRAM_DELIVERY"],
      metadata: {
        workspace: ctx.workspace,
        pair_telegram_delivery: {
          requested: true, mode: "FILES", artifacts: ["report.txt"],
        },
        pair_delivery_artifact_digests: {
          "report.txt": {
            path: null,
            state: "PINNED",
            artifact_id: prod.artifactId,
            producer_execution_id: prod.eid,
            logical_name: prod.name,
            sha256: sha256Hex(prod.bytes),
          },
        },
      },
    };
    // Semantic tamper through the canonical seam: the row's sha is
    // rewritten with a valid entity hash — binding re-proof must catch it.
    const row = ctx.store.get("artifact", prod.artifactId) as Record<string, unknown>;
    ctx.store.put("artifact", prod.artifactId, {
      ...row,
      sha256: "0".repeat(64),
    }, Number(row.version));
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      const r = (
        ctx.runtime as unknown as {
          assertDeliveryDeliverable(
            m: Record<string, unknown>,
            t: Record<string, unknown>,
            e: Record<string, unknown>,
          ): { ok: boolean; violation?: Record<string, unknown> };
        }
      ).assertDeliveryDeliverable(
        {
          project_id: ctx.projectId,
          mission_id: "M_Z4",
          metadata: {},
          goal: "viết báo cáo bằng tiếng việt",
        },
        task,
        { execution_id: "E_Z4" },
      );
      expect(r.ok).toBe(false);
      expect(String(r.violation?.code)).toBe(
        "FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE",
      );
      expect(readsOf(spy, fp)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(deliveries(ctx)).toHaveLength(0); // zero TDR minted
  });

  it("Z5. pin recorded TOO_LARGE → settle reports precise reason, not generic missing-pin", () => {
    const ctx = makeCtx("r5-z5");
    const fp = path.join(ctx.workspace, "outbox", "big.txt");
    const task = {
      task_id: "T_Z5",
      required_capabilities: ["TELEGRAM_DELIVERY"],
      metadata: {
        workspace: ctx.workspace,
        pair_telegram_delivery: {
          requested: true, mode: "FILES", artifacts: ["big.txt"],
        },
        pair_delivery_artifact_digests: {
          "big.txt": { path: fp, sha256: null, state: "TOO_LARGE" },
        },
      },
    };
    const r = (
      ctx.runtime as unknown as {
        assertDeliveryDeliverable(
          m: Record<string, unknown>,
          t: Record<string, unknown>,
          e: Record<string, unknown>,
        ): { ok: boolean; violation?: Record<string, unknown> };
      }
    ).assertDeliveryDeliverable(
      { project_id: ctx.projectId, metadata: {}, goal: "write a report" },
      task,
      { execution_id: "E_Z5" },
    );
    expect(r.ok).toBe(false);
    expect(String(r.violation?.code)).toBe(
      "FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE",
    );
  });
});
