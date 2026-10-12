/**
 * HOTFIX-D (clean rebuild @ BASE cf2674c) — deterministic template
 * fallback runs through THE governed delivery-injection authority.
 *
 * Incident DL_4d48de10: a delegated WOB-bound mission (no
 * pinned_plan_tasks, no metadata.llm_plan) always lands on the
 * deterministic template fallback inside makeServePlanner — which on
 * BASE emitted T1 bookkeeping + optional T2/T3 work and NEVER a
 * TELEGRAM_DELIVERY task, and never reached the injection seam inside
 * makeServeCanonicalizer. runPlanning's assertPlanDataflow re-proof then
 * threw FAIL_CLOSED_DELIVERY_TASK_MISSING → PLANNING→FAILED.
 *
 * Mandatory matrix (operator mandate §4):
 *   E1  BASE counterfactual — the task list the pre-fix fallback
 *       emitted for the incident goal fails the gate with
 *       FAIL_CLOSED_DELIVERY_TASK_MISSING (reproduced live on cf2674c:
 *       template tasks [[T1 AUTOMATON],[T2 REASONING]] → gate code
 *       MISSING — see .pair-verification/HOTFIX-D-REBUILD-NOTES.md)
 *   E2  delegated goal + TRUE intent → exactly one canonical
 *       TELEGRAM_DELIVERY task, fully stamped, gate passes
 *   E3  injected task binds the real upstream producer (RESULT_TEXT
 *       edge to T2, bookkeeping T1 excluded)
 *   E4  negatives — no intent / unservable / no producer / malformed
 *       emission / denied destination all still fail closed
 *   E5  idempotency — re-plan byte-identical, persisted replay adds
 *       nothing, no duplicate delivery authority/sends
 *   E6  end-to-end delegated mission — objective → workstream →
 *       delegated work item → bound mission → execution → staged
 *       outbox → governed bridge → mocked transport receipt; real
 *       upstream bytes on the wire, exactly once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  assertPlanDataflow,
  bindPlanExternalInputs,
  BusinessLayer,
  canonicalJson,
  canonicalBookkeepingTask,
  detectTelegramDeliveryIntent,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  isDeliveryTask,
  makeServePlanner,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  PAIR_DELIVERY_INJECTION_KEY,
  PAIR_DATAFLOW_ORIGINAL_DEPS,
  PAIR_PLAN_CONTRACT_KEY,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  pendingTelegramDeliveries,
  ReconciliationService,
  RecoveryController,
  SERVE_LLM_PLANNER_CAPS,
  sha256Hex,
  TELEGRAM_MANIFEST_FIELD,
  TRANSPORT_IN_PROCESS,
  transportTelegramDelivery,
  utcnow,
  validatePlanProposal,
  WorkforceAllocationService,
  WorkforceService,
  DSH_EXECUTOR_ID,
  CODEX_EXECUTOR_ID,
  goalRequiresCurrentExternalData,
  PAIR_OUTPUT_LANGUAGE_KEY,
  type ExecutorAdapter,
  type GovernedTelegramTransport,
} from "../pair/index.js";
import { detectOutputLanguage } from "../pair/output-language.js";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-hotfixd-"));
let counter = 0;
let seq = 0;
const OP = "op:test";

const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];
const NO_DELIVERY_SETS = [
  SERVE_LLM_PLANNER_CAPS.filter((c) => c !== "TELEGRAM_DELIVERY"),
];

/** The delegated incident goal shape — operator Telegram intent,
 *  business-layer prefix included. */
const INTENT_GOAL =
  "[BUSINESS PAIR HQ | DEPT GROWTH | AGENT Analyst (research)]\n" +
  "Phân tích thị trường chứng khoán tuần này, tạo bài tóm tắt bằng " +
  "tiếng Việt, sau đó đăng lên kênh Telegram được phép.";
const NO_INTENT_GOAL =
  "[BUSINESS PAIR HQ | DEPT GROWTH]\n" +
  "Phân tích thị trường chứng khoán tuần này, tạo bài tóm tắt bằng tiếng Việt.";
const WS_INTENT_GOAL =
  "Phân tích thị trường chứng khoán tuần này, tạo bài tóm tắt bằng " +
  "tiếng Việt, sau đó đăng lên kênh Telegram được phép.";

const DELEGATED_MD = {
  business_id: "BIZ_1",
  work_item_id: "DL_4d48de10",
  work_item_open_id: "OPI_1",
  org_agent_id: "AGT_1",
  department: "GROWTH",
  source: "business_layer",
};

const plannerInput = (goal: string) =>
  ({
    mission: { goal, metadata: { ...DELEGATED_MD } },
    advice: null,
    reason: "initial",
    input_artifact_sources: [],
  }) as never;

const deliveries = (out: Array<Record<string, unknown>>) =>
  out.filter((t) => isDeliveryTask(t));

/** The EXACT runPlanning gauntlet (mission-runtime.ts:1304–1334):
 *  validate → bind external inputs → assertPlanDataflow. */
const runPlanningGate = (tasks: Array<Record<string, unknown>>, goal: string) => {
  const knownCaps = new Set(SERVE_LLM_PLANNER_CAPS);
  const valid = validatePlanProposal({ tasks } as never, knownCaps);
  bindPlanExternalInputs(valid as never[], []);
  assertPlanDataflow(valid as never[], {
    telegramIntent: detectTelegramDeliveryIntent(goal),
    outputLanguage: detectOutputLanguage(goal),
    external_input_artifacts: [],
  });
  return valid;
};

const errCode = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as { code?: string })?.code ?? "ERR");
  }
};

/** Scripted executor — same contract as the F4/P15.8 E2E adapter:
 *  dispatch→RUNNING, writes each declared `produces` artifact into the
 *  workspace, collect_result re-declares the bytes it really wrote. */
class E2EAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  wroteTaskKeys: string[] = [];
  /** Scripted produce bytes — a string literal, or a DERIVATION read
   *  from the real workspace at dispatch (F4: proves the consumer
   *  actually read the materialized upstream artifact). */
  fileContent: Record<
    string,
    string | ((workspace: string, task: Record<string, unknown>) => string)
  > = {};
  workspace = "";
  store?: PairEvidenceStore;
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
    const df = (taskRow?.metadata as Record<string, unknown> | undefined)
      ?.pair_dataflow as Record<string, unknown> | undefined;
    for (const f of (df?.produces as string[]) ?? []) {
      const fp = path.join(this.workspace, f);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const spec = this.fileContent[key];
      const content =
        typeof spec === "function"
          ? spec(this.workspace, task)
          : (spec ?? `delivery text for ${key}`);
      fs.writeFileSync(fp, content);
      this.wroteTaskKeys.push(`${key}:${f}`);
    }
    const box = (this as { _last?: Record<string, unknown> })._last ??
      ((this as { _last?: Record<string, unknown> })._last = {});
    box[eid] = {
      status: "COMPLETED",
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      summary: `done ${key}`,
    };
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const last = (this as { _last?: Record<string, { status: string }> })._last;
    return { status: String(last?.[executionId]?.status ?? "RUNNING") };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const last = (this as { _last?: Record<string, Record<string, unknown>> })._last;
    const r = last?.[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    const taskRow = this.store?.tryGet("task", String((r as { task_id?: string }).task_id));
    const df = (taskRow?.metadata as Record<string, unknown> | undefined)
      ?.pair_dataflow as Record<string, unknown> | undefined;
    const artifacts = ((df?.produces as string[]) ?? [])
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

const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("spec-bound harness must not call inference");
  },
};
const noopCompute = {
  health: async () => ({ status: "ok" }),
  infer: async () => {
    throw new Error("no compute");
  },
  chat: async () => {
    throw new Error("no compute");
  },
};

/** Full governed stack with THE production `makeServePlanner` planner —
 *  delegated missions exercise the real template fallback, never a
 *  canned plan. governed = the production `governed` map seam
 *  (serve-mission-control.mjs): DSH present → T2 emitted. */
function delegatedStack(
  name: string,
  opts?: { capSets?: string[][]; governed?: Set<string> },
) {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  for (const c of SERVE_LLM_PLANNER_CAPS) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const governed = opts?.governed ?? new Set([DSH_EXECUTOR_ID]);
  const capSets = opts?.capSets ?? FULL_SETS;
  // THE production planner function object — same one
  // serve-mission-control.mjs wires.
  const { planner } = makeServePlanner({
    hasExecutor: (id) => governed.has(id),
    executorCapSets: () => capSets,
    replanProvider: null,
  });
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
  const project = service.createProject({ name: "p", root_location: workspace });
  // PAIR_NATIVE harness — T1's worker_spec is executed by the real
  // native runner through the canonical AUTOMATON_WORKER identity.
  const automatonDb = createDatabase(path.join(d, "automaton.db"));
  const runner = new PairNativeWorkerRunner({
    db: automatonDb.raw,
    config: { name: `hfd-${name}`, logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: `hfd-${name}` } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot: path.join(d, "journal"),
    allowedEditRoot: d,
  });
  const nativeAdapter = new PairNativeExecutorAdapter(runner);
  registry.register({
    executor_id: nativeAdapter.executor_id,
    executor_type: "AUTOMATON_WORKER",
    capabilities: ["AUTOMATON_TASK_EXECUTION"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      qualification_state: "QUALIFIED",
      max_concurrency: 4,
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      routing_priority: 100,
      supports_cancel: true,
    },
  });
  service.routes.seedPairNativeRoute();
  adapters.set(nativeAdapter.executor_id, nativeAdapter);
  // Work executor — serves every non-reserved capability.
  const adapter = new E2EAdapter("EX_D", [
    "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY", "NETWORK_ACCESS",
  ]);
  adapter.workspace = workspace;
  adapter.store = store;
  registry.register({
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
  service.routes.registerRoute({
    route_id: `RTE_${adapter.executor_id}`,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: adapter.caps,
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: `RTE_${adapter.executor_id}`,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: adapter.caps,
  });
  adapters.set(adapter.executor_id, adapter);
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  return {
    d, workspace, store, service, control, runtime, adapters, adapter,
    biz, wf, workstreams, alloc, planner,
    projectId: String(project.project_id),
  };
}

const missionState = (s: ReturnType<typeof delegatedStack>, mid: string) =>
  String((s.store.get("mission_runtime", `MRT_${mid}`) as { state: string }).state);

/** The native (AUTOMATON) adapter completes asynchronously — yield
 *  real event-loop time between ticks so its completion lands. */
async function driveToTerminal(
  s: ReturnType<typeof delegatedStack>,
  mid: string,
  max = 200,
) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    s.runtime.tick(mid, new Date(t).toISOString());
    await new Promise((r) => setTimeout(r, 15));
    const st = missionState(s, mid);
    if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(st)) {
      return st;
    }
  }
  return missionState(s, mid);
}

/* ============================== E1 ============================== */

describe("E1 — BASE reproduction (counterfactual, non-vacuous)", () => {
  it("the pre-fix fallback task shape fails the gate FAIL_CLOSED_DELIVERY_TASK_MISSING", () => {
    // Byte-shape the BASE template emitted for INTENT_GOAL (proven live
    // on cf2674c by the composition repro in HOTFIX-D-REBUILD-NOTES.md):
    // [T1 bookkeeping, T2 dsh w/ verbatim-goal embed] — zero delivery.
    const baseShape: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(INTENT_GOAL),
      {
        task_key: "T2",
        title: "llm analysis (dsh)",
        task_instruction:
          `The workspace contains mission_goal.txt holding the operator's goal: "${INTENT_GOAL}". ` +
          "Produce a genuine deliverable for that goal's subject matter — analyze the topic " +
          "itself (never just restate or describe the goal) — write findings to analysis.txt, " +
          "then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    expect(errCode(() => runPlanningGate(baseShape, INTENT_GOAL)))
      .toBe("FAIL_CLOSED_DELIVERY_TASK_MISSING");
  });
});

/* ============================== E2 ============================== */

describe("E2 — delegated intent goal → exactly one canonical delivery task", () => {
  it("production planner emits T1,T2 + injected T3 with full PAIR stamps; gate passes", () => {
    const s = delegatedStack("e2");
    const proposal = s.planner(plannerInput(INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    };
    const out = proposal.tasks;
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    const d = del[0];
    expect(d.task_key).toBe("T3");
    const md = d.metadata as Record<string, unknown>;
    const inj = md[PAIR_DELIVERY_INJECTION_KEY] as Record<string, unknown>;
    expect(inj.reason).toBe("DELIVERY_TASK_INJECTED");
    expect(inj.task_key).toBe("T3");
    expect(inj.mode).toBe("TEXT");
    expect(inj.authority).toBe("OPERATOR_TELEGRAM_INTENT");
    const manifest = md[TELEGRAM_MANIFEST_FIELD] as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest.mode).toBe("TEXT");
    expect(md[PAIR_PLAN_CONTRACT_KEY]).toBeDefined();
    expect(md[PAIR_OUTPUT_LANGUAGE_KEY]).toBeDefined();
    // instruction rewritten to the canonical delivery form, placeholder gone
    expect(String(d.task_instruction)).not.toContain("Stage the manifested");
    // THE downstream gate — the same assert that killed DL_4d48de10 — passes
    runPlanningGate(out, INTENT_GOAL);
  });
});

/* ============================== E3 ============================== */

describe("E3 — injected task binds the REAL upstream producer", () => {
  it("TEXT-mode delivery depends on content-bearing T2, never on bookkeeping T1", () => {
    const s = delegatedStack("e3");
    const out = (s.planner(plannerInput(INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    const d = deliveries(out)[0];
    // RESULT_TEXT edge derived to T2 (content-bearing); T1 excluded.
    const deps = (d.depends_on as string[]) ?? [];
    expect(deps).toContain("T2");
    expect(deps).not.toContain("T1");
    // repair evidence: declared [] → required [T2] recorded on the task
    const orig = (d.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_ORIGINAL_DEPS] as string[];
    expect(orig).toEqual([]);
    // and T2 keeps its own declared edge — the producer chain is genuine
    const t2 = out.find((t) => t.task_key === "T2")!;
    expect(t2.depends_on).toEqual(["T1"]);
  });
});

/* ============================== E4 ============================== */

describe("E4 — negatives still fail closed (or stay byte-identical)", () => {
  it("E4a no operator intent → zero delivery, template output unchanged", () => {
    const s = delegatedStack("e4a");
    const out = (s.planner(plannerInput(NO_INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(out.map((t) => [t.task_key, t.required_capabilities]))
      .toEqual([
        ["T1", ["AUTOMATON_TASK_EXECUTION"]],
        ["T2", ["REASONING"]],
      ]);
    expect(deliveries(out)).toHaveLength(0);
    runPlanningGate(out, NO_INTENT_GOAL);
  });
  it("E4b intent + no executor serves TELEGRAM_DELIVERY → UNSERVABLE", () => {
    const s = delegatedStack("e4b", { capSets: NO_DELIVERY_SETS });
    expect(errCode(() => s.planner(plannerInput(INTENT_GOAL))))
      .toBe("FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE");
  });
  it("E4c intent + no content-bearing task → NO_PRODUCER (never fabricate)", () => {
    // DSH absent from `governed` → template emits only T1 bookkeeping.
    const s = delegatedStack("e4c", { governed: new Set() });
    expect(errCode(() => s.planner(plannerInput(INTENT_GOAL))))
      .toBe("FAIL_CLOSED_DELIVERY_INJECTION_NO_PRODUCER");
  });
  it("E4d malformed raw delivery emission → existing INVALIDATED authority intact", () => {
    const s = delegatedStack("e4d");
    const canon = (s as never as {
      canonicalizeLlmTasks: ReturnType<typeof makeServePlanner>["canonicalizeLlmTasks"];
    }).canonicalizeLlmTasks ?? makeServePlanner({
      hasExecutor: () => true,
      executorCapSets: () => FULL_SETS,
      replanProvider: null,
    }).canonicalizeLlmTasks;
    const bad = {
      task_key: "T9",
      title: "bad",
      task_instruction: "send to telegram",
      required_capabilities: "TELEGRAM_DELIVERY", // not an array → malformed
      depends_on: [],
      metadata: {},
    };
    expect(errCode(() =>
      canon(
        [
          { task_key: "T1", title: "w", task_instruction: "tổng hợp kết quả", required_capabilities: ["REASONING"], depends_on: [], metadata: {} },
          bad as never,
        ],
        INTENT_GOAL,
        { provenance: "fresh" },
      ),
    )).toBe("FAIL_CLOSED_DELIVERY_TASK_INVALIDATED");
  });
  it("E4e denied destination → UNSENDABLE, zero transport calls", async () => {
    const s = delegatedStack("e4e");
    s.adapter.fileContent["T2"] = "BÁO CÁO: denied-destination case";
    const preview = s.control.createPlanPreview({
      project_id: s.projectId,
      goal: INTENT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.workspace],
      risk_ceiling: "LOW",
      operator_id: OP,
    });
    const mission = s.control.confirmPlanPreview({
      preview_id: String(preview.preview_id),
      plan_digest: String(preview.plan_digest),
      operator_id: OP,
    });
    const mid = String(mission.mission_id);
    expect(await driveToTerminal(s, mid)).toBe("COMPLETED");
    const pend = pendingTelegramDeliveries(s.store) as Array<Record<string, unknown>>;
    expect(pend.length).toBe(1);
    const req = pend[0];
    const calls: unknown[] = [];
    const transport: GovernedTelegramTransport = {
      send: async (a: unknown) => {
        calls.push(a);
        return { kind: "ok", message_id: 1 };
      },
    };
    const backend = {
      begin: (artifact: string | null) => {
        const rr = s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "SENDING" }) as { acquired: boolean };
        return { acquired: rr.acquired === true };
      },
      sent: (artifact: string | null, ev: { message_id?: string | number | null }) =>
        s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "SENT", message_id: ev?.message_id ?? null }),
      failed: (artifact: string | null, err: string) =>
        s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "FAILED", error: err }),
      unknown: (artifact: string | null, err: string) =>
        s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "UNKNOWN", error: err }),
      unsendable: (reason: string) =>
        s.control.transitionTelegramDelivery(String(req.delivery_id), { to: "UNSENDABLE", error: reason }),
    };
    const r = await transportTelegramDelivery({
      request: req,
      transport,
      isAllowed: () => false, // destination denied
      backend,
      readText: (p) => fs.readFileSync(p, "utf8"),
    });
    expect(r.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const after = s.store.tryGet(
      "telegram_delivery_request",
      String(req.delivery_id),
    ) as Record<string, unknown> | null;
    expect(String((after ?? req).status)).toBe("UNSENDABLE");
  });
});

/* ============================== E5 ============================== */

describe("E5 — idempotency", () => {
  it("re-plan on the same input is byte-identical; persisted replay adds nothing", () => {
    const s = delegatedStack("e5");
    const first = (s.planner(plannerInput(INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    const second = (s.planner(plannerInput(INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    // persisted replay through the canonicalize seam (the ONLY replay
    // path for a canonical plan): historical authority, verbatim — no
    // second stamp, no second task.
    // Committed-plan replay = the pinned seam: the stored canonical
    // list returns verbatim (planner never re-derives it) — still one
    // delivery task, no second stamp, still gate-clean.
    const pinnedInput = {
      mission: {
        goal: INTENT_GOAL,
        metadata: { ...DELEGATED_MD, pinned_plan_tasks: first },
      },
      advice: null,
      reason: "initial",
      input_artifact_sources: [],
    } as never;
    const replay = (s.planner(pinnedInput) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(canonicalJson(replay)).toBe(canonicalJson(first));
    expect(deliveries(replay)).toHaveLength(1);
    runPlanningGate(replay, INTENT_GOAL);
  });
});

/* ============================== E6 ============================== */

/** THE real delegated chain: business → objective → workstream whose
 *  goal carries operator Telegram intent → allocation → delegated WOB
 *  child work item → INTENT→BOUND mission mint. Returns mission_id. */
function openDelegatedIntentMission(s: ReturnType<typeof delegatedStack>) {
  const businessId = `BIZ_${seq++}`;
  s.store.put("business", businessId, {
    business_id: businessId,
    name: "pair hq",
    status: "ACTIVE",
    currency: "USD",
    project_id: s.projectId,
    created_at: utcnow(),
    version: 0,
  }, 0);
  const obj = s.biz.objectives.create({
    business_id: businessId,
    title: "obj e6",
    statement: "grow market intel",
    kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: [],
    success_conditions: ["done"],
    dedup_key: `dk-${seq++}`,
    operator_id: OP,
  });
  const objectiveId = String(obj.objective_id);
  s.workstreams.decomposeObjective({
    objective_id: objectiveId,
    expected_objective_version: Number(obj.version),
    expected_terms_version: Number(obj.terms_version),
    expected_objective_digest: String(obj.objective_digest),
    workstreams: [{
      workstream_key: "ws-telegram",
      title: "ws telegram",
      goal: WS_INTENT_GOAL,
    }] as never,
    actor: OP,
  });
  s.biz.createOrgAgent({
    business_id: businessId,
    title: "analyst",
    department: "ops",
    operator_id: OP,
  });
  s.alloc.allocateWorkstream({
    objective_id: objectiveId,
    workstream_key: "ws-telegram",
    actor: OP,
  });
  const wal = s.store.list("workforce_allocation").find(
    (r) => String(r.objective_id) === objectiveId &&
      String(r.workstream_key ?? "") === "ws-telegram",
  )!;
  const childId = String(wal.delegated_child_work_item_id);
  // THE delegated seam: WOB INTENT→BOUND + mission mint (bound id).
  s.biz.openWorkItem(childId, OP);
  const wob = s.store.list("work_open_binding").find(
    (b) => String(b.work_item_id) === childId,
  )!;
  return String(wob.mission_id);
}

/** Drive the minted delivery request through the governed bridge into a
 *  mocked transport; returns the wire calls. Zero real Telegram. */
async function sendMintedDelivery(
  s: ReturnType<typeof delegatedStack>,
): Promise<{ calls: Array<{ chatId: string; text?: string }> }> {
  const pend = pendingTelegramDeliveries(s.store) as Array<Record<string, unknown>>;
  expect(pend.length).toBe(1);
  const req = pend[0];
  const calls: Array<{ chatId: string; text?: string }> = [];
  const transport: GovernedTelegramTransport = {
    send: async (a: { chatId: string; text?: string }) => {
      calls.push(a);
      return { kind: "ok", message_id: 4242 };
    },
  };
  const backend = {
    begin: (artifact: string | null) => {
      const rr = s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "SENDING" }) as { acquired: boolean };
      return { acquired: rr.acquired === true };
    },
    sent: (artifact: string | null, ev: { message_id?: string | number | null }) =>
      s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "SENT", message_id: ev?.message_id ?? null }),
    failed: (artifact: string | null, err: string) =>
      s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "FAILED", error: err }),
    unknown: (artifact: string | null, err: string) =>
      s.control.transitionTelegramDelivery(String(req.delivery_id), { artifact, to: "UNKNOWN", error: err }),
    unsendable: (reason: string) =>
      s.control.transitionTelegramDelivery(String(req.delivery_id), { to: "UNSENDABLE", error: reason }),
  };
  const r = await transportTelegramDelivery({
    request: req,
    transport,
    isAllowed: () => true,
    backend,
    readText: (p) => fs.readFileSync(p, "utf8"),
  });
  expect(r.sent.length).toBe(1);
  return { calls };
}

describe("E6 — end-to-end delegated mission delivers real upstream content once", () => {
  /** The staged report the delivery task produces is DERIVED at
   *  dispatch from the upstream artifact physically present in the
   *  workspace — the dependency handoff — never pre-seeded. */
  const stageFromUpstream = (ws: string) =>
    `BÁO CÁO GỬI TELEGRAM\n\n${fs.readFileSync(path.join(ws, "analysis.txt"), "utf8")}`;

  it("objective → workstream → delegated WOB mission → staged delivery derived from real T2 bytes → mocked receipt", async () => {
    const s = delegatedStack("e6");
    const UPSTREAM = "PHÂN TÍCH SÂU: VN-Index +1.8% nhờ dòng tiền nhóm ngân hàng";
    s.adapter.fileContent["T2"] = UPSTREAM;
    s.adapter.fileContent["T3"] = stageFromUpstream;
    const mid = openDelegatedIntentMission(s);
    expect(await driveToTerminal(s, mid)).toBe("COMPLETED");
    const taskRows = (s.store.list("task") as Array<Record<string, unknown>>)
      .filter((t) => String(t.mission_id) === mid);
    const delRows = taskRows.filter((t) =>
      ((t.required_capabilities as string[]) ?? []).includes("TELEGRAM_DELIVERY"));
    expect(delRows).toHaveLength(1);
    expect(String(delRows[0].status)).toBe("COMPLETED");
    const { calls } = await sendMintedDelivery(s);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].chatId)).toBe("111");
    // REAL handoff proven: the wire payload is built from T2's actual
    // produced artifact bytes (analysis.txt on disk), so it carries the
    // distinct upstream payload — a staged report T3 could only have
    // written by consuming the T2 output.
    expect(fs.readFileSync(path.join(s.workspace, "analysis.txt"), "utf8"))
      .toBe(UPSTREAM);
    const stagedKey = s.adapter.wroteTaskKeys.find((k) => k.startsWith("T3:"))!;
    const stagedPath = path.join(s.workspace, stagedKey.split(":")[1]!);
    expect(fs.readFileSync(stagedPath, "utf8"))
      .toBe(`BÁO CÁO GỬI TELEGRAM\n\n${UPSTREAM}`);
    expect(String(calls[0].text)).toContain(UPSTREAM);
    // no duplicate authority: exactly one delivery task and exactly one
    // delivery request for this mission, terminal SENT — never re-minted.
    const allReqs = (s.store.list("telegram_delivery_request") as Array<Record<string, unknown>>)
      .filter((p) => String(p.mission_id) === mid);
    expect(allReqs).toHaveLength(1);
    expect(String(allReqs[0].status)).toBe("SENT");
  });

  it("E6b negative — a different upstream payload produces a different wire report; the expected one cannot pass", async () => {
    const s = delegatedStack("e6b");
    const DIFFERENT = "DỮ LIỆU KHÁC: thị trường đi ngang, không có điểm nhấn";
    s.adapter.fileContent["T2"] = DIFFERENT;
    s.adapter.fileContent["T3"] = stageFromUpstream;
    const mid = openDelegatedIntentMission(s);
    expect(await driveToTerminal(s, mid)).toBe("COMPLETED");
    const { calls } = await sendMintedDelivery(s);
    expect(calls).toHaveLength(1);
    // The report tracks the REAL upstream bytes — a canned/pre-seeded
    // expected payload would fail here.
    expect(String(calls[0].text)).toContain(DIFFERENT);
    expect(String(calls[0].text)).not.toContain("VN-Index");
    const allReqs = (s.store.list("telegram_delivery_request") as Array<Record<string, unknown>>)
      .filter((p) => String(p.mission_id) === mid);
    expect(allReqs).toHaveLength(1);
    expect(String(allReqs[0].status)).toBe("SENT");
  });
});

/* ============================== E8 — R1-F1 ============================== */

describe("E8 — R1-F1 unique canonical task keys (DSH absent, Codex present)", () => {
  const CODEX_INTENT_GOAL =
    "Viết script Python phân tích dữ liệu mẫu, sau đó đăng lên kênh Telegram được phép.";
  it("T1 bookkeeping + T3 codex + injected delivery takes next FREE key T4 — no duplicate", () => {
    // sanity: the goal really does carry operator intent + codex shape
    // without a current/external-data demand.
    expect(detectTelegramDeliveryIntent(CODEX_INTENT_GOAL).requested).toBe(true);
    expect(goalRequiresCurrentExternalData(CODEX_INTENT_GOAL)).toBe(false);
    const s = delegatedStack("e8", { governed: new Set([CODEX_EXECUTOR_ID]) });
    const out = (s.planner(plannerInput(CODEX_INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    const keys = out.map((t) => t.task_key);
    expect(keys).toEqual(["T1", "T3", "T4"]);
    expect(new Set(keys).size).toBe(keys.length);
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    expect(del[0].task_key).toBe("T4");
    const inj = (del[0].metadata as Record<string, unknown>)[
      PAIR_DELIVERY_INJECTION_KEY] as Record<string, unknown>;
    expect(inj.reason).toBe("DELIVERY_TASK_INJECTED");
    expect(inj.task_key).toBe("T4");
    // DAG correctness: delivery binds the content-bearing codex T3,
    // never bookkeeping T1; T3's own edge list stays empty (no T2).
    const deps = (del[0].depends_on as string[]) ?? [];
    expect(deps).toContain("T3");
    expect(deps).not.toContain("T1");
    const t3 = out.find((t) => t.task_key === "T3")!;
    expect(t3.depends_on).toEqual([]);
    // validation + dataflow gates pass on the unique-key plan
    runPlanningGate(out, CODEX_INTENT_GOAL);
    // deterministic replay: identical input → byte-identical output
    const again = (s.planner(plannerInput(CODEX_INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(canonicalJson(again)).toBe(canonicalJson(out));
    expect(deliveries(again)).toHaveLength(1);
  });
});

/* ============================== E9 — R1-F2 ============================== */

describe("E9 — R1-F2 current/external-data contract on template delivery", () => {
  const CURRENT_INTENT_GOAL =
    "Nghiên cứu giá vàng hôm nay, sau đó đăng lên kênh Telegram được phép.";
  it("intent + current-data demand + no legitimate NETWORK_ACCESS gatherer → FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED", () => {
    expect(goalRequiresCurrentExternalData(CURRENT_INTENT_GOAL)).toBe(true);
    expect(detectTelegramDeliveryIntent(CURRENT_INTENT_GOAL).requested).toBe(true);
    const s = delegatedStack("e9");
    expect(errCode(() => s.planner(plannerInput(CURRENT_INTENT_GOAL))))
      .toBe("FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED");
  });
  it("no-intent + same current-data demand → pre-existing fallback behavior preserved (plans, zero delivery)", () => {
    const NO_INTENT_CURRENT = "Nghiên cứu giá vàng hôm nay.";
    expect(goalRequiresCurrentExternalData(NO_INTENT_CURRENT)).toBe(true);
    const s = delegatedStack("e9b");
    const out = (s.planner(plannerInput(NO_INTENT_CURRENT)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(deliveries(out)).toHaveLength(0);
  });
  it("intent + local-source analysis (no external demand) → delivery plan still issues", () => {
    const LOCAL_INTENT_GOAL =
      "Phân tích dữ liệu trong file báo cáo local, sau đó đăng lên kênh Telegram được phép.";
    expect(goalRequiresCurrentExternalData(LOCAL_INTENT_GOAL)).toBe(false);
    const s = delegatedStack("e9c");
    const out = (s.planner(plannerInput(LOCAL_INTENT_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(deliveries(out)).toHaveLength(1);
    runPlanningGate(out, LOCAL_INTENT_GOAL);
  });
});

/* ============================== E10 — R1-F3 ============================== */

describe("E10 — R1-F3 no-intent template output is byte-identical to BASE", () => {
  // The EXACT BASE (cf2674c) task literals the template emitted for a
  // no-intent goal — verbatim goal embed in T2, canonical codex T3.
  const baseT2 = (goal: string) => ({
    task_key: "T2",
    title: "llm analysis (dsh)",
    task_instruction:
      `The workspace contains mission_goal.txt holding the operator's goal: "${goal}". ` +
      "Produce a genuine deliverable for that goal's subject matter — analyze the topic " +
      "itself (never just restate or describe the goal) — write findings to analysis.txt, " +
      "then reply DONE.",
    required_capabilities: ["REASONING"],
    depends_on: ["T1"],
    metadata: {},
  });
  const baseT3Codex = (deps: string[]) => ({
    task_key: "T3",
    title: "codex step",
    task_instruction:
      "Create codex_out.txt in the workspace containing a short note implementing or summarizing the mission goal, then reply DONE.",
    required_capabilities: ["PYTHON_EXECUTION"],
    depends_on: deps,
    metadata: {},
  });
  const CODEX_NO_INTENT_GOAL = "Viết script Python tính tổng dữ liệu mẫu.";
  const cases: Array<{
    name: string;
    governed: Set<string>;
    goal: string;
    expected: Array<Record<string, unknown>>;
  }> = [
    {
      name: "dsh+codex, codex-matching goal",
      governed: new Set([DSH_EXECUTOR_ID, CODEX_EXECUTOR_ID]),
      goal: CODEX_NO_INTENT_GOAL,
      expected: [undefined as never, baseT2(CODEX_NO_INTENT_GOAL), baseT3Codex(["T2"])],
    },
    {
      name: "dsh only, plain goal",
      governed: new Set([DSH_EXECUTOR_ID]),
      goal: NO_INTENT_GOAL,
      expected: [undefined as never, baseT2(NO_INTENT_GOAL)],
    },
    {
      name: "codex only (no dsh), codex-matching goal — T2 gap",
      governed: new Set([CODEX_EXECUTOR_ID]),
      goal: CODEX_NO_INTENT_GOAL,
      expected: [undefined as never, baseT3Codex([])],
    },
    {
      name: "no governed executor",
      governed: new Set(),
      goal: NO_INTENT_GOAL,
      expected: [undefined as never],
    },
  ];
  for (const c of cases) {
    it(`byte-identical: ${c.name}`, () => {
      const s = delegatedStack(`e10-${c.governed.size}`, { governed: c.governed });
      const out = (s.planner(plannerInput(c.goal)) as {
        tasks: Array<Record<string, unknown>>;
      }).tasks;
      const expected = [canonicalBookkeepingTask(c.goal), ...c.expected.slice(1)];
      expect(canonicalJson(out)).toBe(canonicalJson(expected));
    });
  }
});
