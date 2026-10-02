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
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
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
  assertPlanDataflow,
  canonicalDeliveryTaskInstruction,
  classifyTextLanguage,
  deliveryManifest,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  languagePhrase,
  mintTelegramDeliveryRequest,
  pendingTelegramDeliveries,
  reconcilePlanDataflow,
  sha256File,
  transportTelegramDelivery,
  utcnow,
  verifyOutputLanguageContent,
  DELIVERY_TEXT_ARTIFACT,
  PAIR_OUTPUT_LANGUAGE_KEY,
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
      }
    }
    if (b === "CLOBBER" && this.workspace) {
      // The defect-B adversary: the delivery-prep task rewrites the
      // manifested artifact with its own "replacement report".
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, "CLOBBERED — rewritten by the delivery task");
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
    return this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
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
    // .txt is delivered as message text — the wire payload carries the
    // producer's exact bytes (byte-identical, never rewritten).
    expect(String(call.text)).toContain(VI_REPORT);
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

  it("C3. delivery task clobbers the manifested artifact → FAIL CLOSED on identity mismatch, zero TDR", async () => {
    const { ctx, mid } = buildMission(
      "c3-clobber",
      { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE", T4: "WRITE", T5: "CLOBBER" },
      { T4: VI_REPORT },
    );
    const state = drive(ctx, mid);
    expect(state).not.toBe("COMPLETED");
    expect(deliveries(ctx)).toHaveLength(0);
    const ev = evidence(ctx, mid, "DELIVERY_CONTRACT_VIOLATED");
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED",
    );
    const rec = recordingTransport();
    const { sent } = await runTransport(ctx, { transport: rec.transport });
    expect(sent).toEqual([]);
    expect(rec.calls).toHaveLength(0);
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
    expect(JSON.stringify(ev.map((e) => e.payload))).toContain(
      "FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING",
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
    const a = mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_D4", metadata: {} },
      task: t3 as Record<string, unknown>,
      execution: { execution_id: "E1" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
    });
    const b = mintTelegramDeliveryRequest({
      store: ctx.store,
      mission: { mission_id: "M_D4", metadata: {} },
      task: t3 as Record<string, unknown>,
      execution: { execution_id: "E1" },
      outboxDir: path.join(ctx.workspace, "outbox"),
      workspace: ctx.workspace,
      now: utcnow(),
      defaultChatId: "111",
    });
    expect(b).toEqual(a); // idempotent mint on replay
    expect(String(a!.text)).toBe(VI_REPORT);
  });
});
