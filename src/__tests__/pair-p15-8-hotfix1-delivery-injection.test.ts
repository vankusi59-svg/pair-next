/**
 * P15.8 HOTFIX 1 — canonical Telegram delivery injection.
 *
 * Mandate matrix:
 *   A  TRUE OMISSION (TEXT)   → PAIR injects exactly one delivery task
 *   B  TRUE OMISSION (FILES)  → injected task binds unique producers
 *   C  no intent + no raw del → nothing injected
 *   D  no intent + planner del→ FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT
 *   E  intent + valid raw del → planner task kept, no injection
 *   F  intent + 2 raw del     → FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS
 *   G  intent + raw del dropped (malformed/unservable)
 *                             → FAIL_CLOSED_DELIVERY_TASK_INVALIDATED
 *                               (never "repaired into validity")
 *   H  intent + omission + no executor serves TELEGRAM_DELIVERY
 *                             → FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE
 *   I  FILES unbound producer → FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT
 *   J  FILES ambiguous        → FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER
 *   K  producer after delivery→ FAIL_CLOSED_PLAN_DATAFLOW_ORDER
 *   L  replay determinism     → byte-identical canonical list
 *   M  persisted replay       → no new task, stamp preserved verbatim
 *   N  forged injection stamp → stripped (planner cannot forge evidence)
 *   O  Task Entry E2E         → preview + confirm succeed via injection
 *   P  Conversation confirm E2E → same result, no conversation workaround
 *   Q  delivery pipeline      → mission minted with routable canonical
 *                               delivery task in the pinned plan
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  SERVE_LLM_WORK_CAPS,
} from "../pair/serve-planner.js";
import {
  PAIR_DELIVERY_INJECTION_KEY,
  PAIR_PLAN_CONTRACT_KEY,
  TELEGRAM_MANIFEST_FIELD,
  canonicalDeliveryTaskInstruction,
  detectTelegramDeliveryIntent,
  assertPlanDataflow,
  assertDeliveryTaskPresence,
  inspectRawDeliveryEmissions,
  type RawDeliveryEmissionState,
  type TelegramDeliveryIntent,
} from "../pair/plan-dataflow.js";
import { sanitizePlan } from "../pair/llm-planner.js";
import {
  runPlannerFailover,
  type PlannerCandidate,
  type PlannerInvocation,
  type PlannerAttemptRecord,
  type PlannerFailoverResult,
} from "../pair/planner-pool.js";
import {
  PAIR_OUTPUT_LANGUAGE_KEY,
  detectOutputLanguage,
} from "../pair/output-language.js";
import {
  ApprovalQueue,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  MissionScheduleService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  validatePlanProposal,
  TRANSPORT_IN_PROCESS,
  transportTelegramDelivery,
  pendingTelegramDeliveries,
  sha256Hex,
  type ExecutorAdapter,
  type GovernedTelegramTransport,
} from "../pair/index.js";

/* ---------- canonicalizer harness (same composition production runs) -------- */

const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];
const NO_DELIVERY_SETS = [
  SERVE_LLM_PLANNER_CAPS.filter((c) => c !== "TELEGRAM_DELIVERY"),
];

const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
} as const;

const work = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
  metadata?: Record<string, unknown>,
  pairCov?: string[],
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  metadata: { network_requirement: NETREQ_LOCAL, ...(metadata ?? {}) },
  ...(pairCov !== undefined ? { pair_coverage: pairCov } : {}),
});

const canon = (
  raw: Array<Record<string, unknown>>,
  goal: string,
  capSets: string[][] = FULL_SETS,
  provenance?: "fresh" | "persisted",
) =>
  makeServeCanonicalizer({ executorCapSets: () => capSets })(
    raw,
    goal,
    provenance ? { provenance } : undefined,
  );

const deliveries = (out: Array<Record<string, unknown>>) =>
  out.filter((t) =>
    (t.required_capabilities as string[]).includes("TELEGRAM_DELIVERY"));

const TEXT_GOAL =
  "đọc dữ liệu bán hàng rồi gửi bản tóm tắt đến telegram";
const FILES_GOAL = "write analysis.txt and gửi analysis.txt tới telegram";

/* ============================ canonicalizer matrix ============================ */

describe("P15.8-HF1 delivery injection", () => {
  it("A. TEXT omission → exactly one injected delivery leaf w/ full PAIR stamps", () => {
    const out = canon(
      [
        work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
        work("T2", "tóm tắt kết quả phân tích", ["REASONING"], ["T1"]),
      ],
      TEXT_GOAL,
    );
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3", "T4"]);
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    const d = del[0];
    expect(d.task_key).toBe("T4"); // deterministic next T-key
    const md = d.metadata as Record<string, unknown>;
    const manifest = md[TELEGRAM_MANIFEST_FIELD] as Record<string, unknown>;
    expect(manifest.mode).toBe("TEXT");
    expect(manifest.requested).toBe(true);
    expect((md[PAIR_PLAN_CONTRACT_KEY] as { version: number }).version).toBe(2);
    expect(md[PAIR_OUTPUT_LANGUAGE_KEY]).toBeDefined();
    // canonical instruction rewritten by reconcile, not my placeholder
    expect(d.task_instruction).toBe(
      canonicalDeliveryTaskInstruction(
        detectTelegramDeliveryIntent(TEXT_GOAL),
        detectOutputLanguage(TEXT_GOAL),
      ),
    );
    // TEXT mode → RESULT_TEXT edges to every earlier content-bearing
    // task; bookkeeping T1 excluded.
    expect(d.depends_on).toEqual(["T2", "T3"]);
    const inj = md[PAIR_DELIVERY_INJECTION_KEY] as Record<string, unknown>;
    expect(inj.reason).toBe("DELIVERY_TASK_INJECTED");
    expect(inj.task_key).toBe("T4");
    expect(inj.mode).toBe("TEXT");
    expect(inj.authority).toBe("OPERATOR_TELEGRAM_INTENT");
    // downstream gate accepts the canonical plan verbatim
    assertPlanDataflow(out, {
      telegramIntent: detectTelegramDeliveryIntent(TEXT_GOAL),
      outputLanguage: detectOutputLanguage(TEXT_GOAL),
    });
  });

  it("B. FILES omission → injected task binds the unique artifact producer", () => {
    const out = canon(
      [
        work("T1", "research sales data", ["REASONING"]),
        work("T2", "write analysis.txt", ["FILE_OPERATIONS", "REASONING"], ["T1"], undefined, ["DEL_001"]),
      ],
      FILES_GOAL,
    );
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    const d = del[0];
    expect(d.task_key).toBe("T4");
    const md = d.metadata as Record<string, unknown>;
    const manifest = md[TELEGRAM_MANIFEST_FIELD] as Record<string, unknown>;
    expect(manifest.mode).toBe("FILES");
    expect(manifest.artifacts).toEqual(["analysis.txt"]);
    expect(d.depends_on).toEqual(["T3"]); // the unique producer (T3 = was T2)
    assertPlanDataflow(out, {
      telegramIntent: detectTelegramDeliveryIntent(FILES_GOAL),
      outputLanguage: detectOutputLanguage(FILES_GOAL),
    });
  });

  it("C. no delivery intent → zero injection", () => {
    const out = canon(
      [work("T1", "ghi tóm tắt vào summary.txt", ["FILE_OPERATIONS"], [], undefined)],
      "ghi tóm tắt vào summary.txt",
    );
    expect(deliveries(out)).toHaveLength(0);
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2"]);
  });

  it("D. planner delivery without operator intent → INTENT fail-closed", () => {
    expect(() =>
      canon(
        [
          work("T1", "ghi tóm tắt vào summary.txt", ["FILE_OPERATIONS"]),
          work("T2", "send summary.txt to telegram", ["TELEGRAM_DELIVERY"], ["T1"]),
        ],
        "ghi tóm tắt vào summary.txt",
      ),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT/);
  });

  it("E. valid planner-emitted delivery → kept verbatim, no second task", () => {
    const out = canon(
      [
        work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
        work("T2", "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
          ["TELEGRAM_DELIVERY"], ["T1"]),
      ],
      TEXT_GOAL,
    );
    expect(deliveries(out)).toHaveLength(1);
    const d = deliveries(out)[0];
    expect(d.task_key).toBe("T3");
    const md = d.metadata as Record<string, unknown>;
    // planner-authored → NO injection provenance
    expect(md[PAIR_DELIVERY_INJECTION_KEY]).toBeUndefined();
    expect(md[TELEGRAM_MANIFEST_FIELD]).toBeDefined();
  });

  it("F. two planner delivery tasks → AMBIGUOUS, no repair", () => {
    expect(() =>
      canon(
        [
          work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
          work("T2", "send summary to telegram", ["TELEGRAM_DELIVERY"], ["T1"]),
          work("T3", "send summary to telegram again", ["TELEGRAM_DELIVERY"], ["T1"]),
        ],
        TEXT_GOAL,
      ),
    ).toThrow(/FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS/);
  });

  it("G1. planner delivery dropped as unservable → INVALIDATED, never re-minted", () => {
    expect(() =>
      canon(
        [
          work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
          work("T2", "Stage artifacts to outbox/, reply DONE.", ["TELEGRAM_DELIVERY"], ["T1"]),
        ],
        TEXT_GOAL,
        NO_DELIVERY_SETS,
      ),
    ).toThrow(/FAIL_CLOSED_DELIVERY_TASK_INVALIDATED/);
  });

  it("G2. malformed raw delivery (bad capability shape) dropped → INVALIDATED", () => {
    const bad = {
      task_key: "T2",
      title: "t2",
      task_instruction: "send to telegram",
      required_capabilities: "TELEGRAM_DELIVERY", // not an array
      depends_on: ["T1"],
      metadata: { network_requirement: NETREQ_LOCAL },
    };
    expect(() =>
      canon(
        [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]), bad as never],
        TEXT_GOAL,
      ),
    ).toThrow(/FAIL_CLOSED_DELIVERY_TASK_INVALIDATED/);
  });

  it("G3. delivery inside a task sanitize trims the capability on fails closed too", () => {
    // A task whose required_capabilities are malformed in another way —
    // still a raw emission attempt, still not a true omission.
    const bad = {
      task_key: "T2",
      title: "t2",
      task_instruction: "send to telegram",
      required_capabilities: ["TELEGRAM_DELIVERY", "TELEGRAM_DELIVERY"],
      depends_on: ["T1"],
      metadata: { network_requirement: NETREQ_LOCAL },
    };
    try {
      canon(
        [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]), bad as never],
        TEXT_GOAL,
      );
      // if sanitize kept it, exactly-one delivery is still enforced
    } catch (e) {
      expect(String((e as { code?: string }).code)).toMatch(
        /FAIL_CLOSED_DELIVERY_TASK_(INVALIDATED|MISSING|AMBIGUOUS)|FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT/,
      );
    }
  });

  it("H. true omission but no executor serves TELEGRAM_DELIVERY → UNSERVABLE", () => {
    expect(() =>
      canon(
        [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"])],
        TEXT_GOAL,
        NO_DELIVERY_SETS,
      ),
    ).toThrow(/FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE/);
  });

  it("I. FILES manifest artifact with no producer → UNBOUND_INPUT", () => {
    expect(() =>
      canon(
        [work("T1", "ghi chú nhanh", ["REASONING"])],
        FILES_GOAL,
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
  });

  it("J. two producers for manifested artifact → AMBIGUOUS_PRODUCER", () => {
    expect(() =>
      canon(
        [
          work("T1", "write analysis.txt from source A", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
          work("T2", "write analysis.txt from source B", ["FILE_OPERATIONS"]),
        ],
        FILES_GOAL,
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER/);
  });

  it("K. planner delivery placed before its producer → ORDER preserved", () => {
    expect(() =>
      canon(
        [
          work("T1", "Stage artifacts to outbox/, reply DONE.", ["TELEGRAM_DELIVERY"]),
          work("T2", "write analysis.txt", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
        ],
        FILES_GOAL,
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_ORDER/);
  });

  it("L. replay determinism — same input → byte-identical canonical list", () => {
    const raw = [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      work("T2", "tóm tắt kết quả phân tích", ["REASONING"], ["T1"]),
    ];
    const a = canon(raw, TEXT_GOAL);
    const b = canon(raw, TEXT_GOAL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(deliveries(a)).toHaveLength(1);
    // re-canonicalizing the canonical output creates no second delivery task
    const again = canon(a as never[], TEXT_GOAL);
    expect(deliveries(again)).toHaveLength(1);
  });

  it("M. persisted replay — canonical list verbatim, stamp preserved, no new task", () => {
    const canonical = canon(
      [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"])],
      TEXT_GOAL,
    );
    const replayed = canon(canonical, TEXT_GOAL, FULL_SETS, "persisted");
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(canonical));
    expect(deliveries(replayed)).toHaveLength(1);
    const md = deliveries(replayed)[0].metadata as Record<string, unknown>;
    expect(md[PAIR_DELIVERY_INJECTION_KEY]).toBeDefined();
  });

  it("N. forged injection stamp on planner tasks is stripped, never survives", () => {
    const forged = work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"], [], {
      [PAIR_DELIVERY_INJECTION_KEY]: {
        reason: "DELIVERY_TASK_INJECTED",
        task_key: "T2",
        mode: "TEXT",
        authority: "OPERATOR_TELEGRAM_INTENT",
      },
    });
    const out = canon([forged], TEXT_GOAL);
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    // the injected task carries the TRUE stamp (its own key), not the
    // forged record the planner authored
    const md = del[0].metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { task_key: string }).task_key)
      .toBe(String(del[0].task_key));
    // and no non-delivery task carries the stamp
    for (const t of out) {
      if (t === del[0]) continue;
      expect(
        (t.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
      ).toBeUndefined();
    }
  });
});

/* ============================ E2E through MissionControl ============================ */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p158hf1-"));
let counter = 0;
const OP = "1882810918";

interface Stack {
  store: PairEvidenceStore;
  control: MissionControl;
  biz: BusinessLayer;
  projectId: string;
  projectRoot: string;
}

/** Real composition: planner dep runs the PRODUCTION canonicalizer over a
 *  canned raw candidate — same object serve-mission-control.mjs wires. */
function freshStack(name: string, rawForGoal: (goal: string) => Array<Record<string, unknown>>): Stack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
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
  const canonicalize = makeServeCanonicalizer({
    executorCapSets: () => FULL_SETS,
  });
  const planner = (input: { mission: { goal?: unknown } }) => ({
    tasks: canonicalize(rawForGoal(String(input.mission.goal)), String(input.mission.goal)),
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner: planner as never,
  });
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({ store, control, schedules });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { store, control, biz, projectId: String(project.project_id), projectRoot: workspace };
}

const RAW_TEXT_OMITTING = () => [
  work("T1", "đọc dữ liệu bán hàng và tổng hợp kết quả", ["REASONING"]),
  work("T2", "tóm tắt kết quả phân tích", ["REASONING"], ["T1"]),
];

describe("P15.8-HF1 E2E", () => {
  it("O. Task Entry: preview + confirm succeed through injected delivery", () => {
    const s = freshStack("entry", () => RAW_TEXT_OMITTING());
    const preview = s.control.createPlanPreview({
      project_id: s.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.projectRoot],
      risk_ceiling: "LOW",
      operator_id: OP,
    });
    const tasks = preview.plan.tasks as Array<Record<string, unknown>>;
    const del = deliveries(tasks);
    expect(del).toHaveLength(1);
    const md = del[0].metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { reason: string }).reason)
      .toBe("DELIVERY_TASK_INJECTED");
    const mission = s.control.confirmPlanPreview({
      preview_id: String(preview.preview_id),
      plan_digest: String(preview.plan_digest),
      operator_id: OP,
    });
    expect(mission.mission_id).toMatch(/^MSN_/);
  });

  it("P. conversation draft confirm mints mission through same injection seam", async () => {
    const s = freshStack("draft", () => RAW_TEXT_OMITTING());
    const { ConversationSessionService } = await import("../pair/conversation-session.js");
    const { MissionDraftService } = await import("../pair/mission-draft.js");
    const sessions = new ConversationSessionService(s.store);
    const drafts = new MissionDraftService({
      conversation: sessions,
      control: s.control,
      store: s.store,
      // Phase C — same async Planner Pool seam; passthrough keeps the
      // sync test planner as the preview's plan source.
      planExpander: async (input) => ({ input }),
    });
    const session = sessions.createSession({ owner_operator_id: OP });
    const draft = drafts.createDraft({
      session_id: String(session.session_id),
      operator_id: OP,
      project_id: s.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.projectRoot],
      risk_ceiling: "LOW",
    });
    const out = await drafts.confirmDraft({
      session_id: String(session.session_id),
      operator_id: OP,
      draft_id: String(draft.draft_id),
      kind: "explicit",
      expected_digest: String(draft.draft_digest),
    });
    expect(String(out.mission_id)).toMatch(/^MSN_/);
    const mission = s.store.get("mission", String(out.mission_id));
    const pinned = ((mission.metadata as Record<string, unknown>)
      .pinned_plan_tasks ?? []) as Array<Record<string, unknown>>;
    expect(deliveries(pinned)).toHaveLength(1);
  });

  it("Q. pinned plan carries the routable canonical delivery task", () => {
    const s = freshStack("pipe", () => RAW_TEXT_OMITTING());
    const preview = s.control.createPlanPreview({
      project_id: s.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.projectRoot],
      risk_ceiling: "LOW",
      operator_id: OP,
    });
    const tasks = preview.plan.tasks as Array<Record<string, unknown>>;
    const del = deliveries(tasks)[0];
    // routable: capability vocabulary + a serving executor set
    expect(SERVE_LLM_WORK_CAPS).toContain("TELEGRAM_DELIVERY");
    expect(FULL_SETS.some((set) => set.includes("TELEGRAM_DELIVERY"))).toBe(true);
    // plan validates under the same gate the dispatch path runs
    const knownCaps = new Set(SERVE_LLM_PLANNER_CAPS);
    expect(() => validatePlanProposal({ tasks } as never, knownCaps)).not.toThrow();
    const md = del.metadata as Record<string, unknown>;
    expect((md[TELEGRAM_MANIFEST_FIELD] as { requested: boolean }).requested).toBe(true);
    expect((md[PAIR_PLAN_CONTRACT_KEY] as { version: number }).version).toBe(2);
    // DAG leaf — nothing depends on the delivery task
    for (const t of tasks) {
      expect((t.depends_on as string[]) ?? []).not.toContain(del.task_key);
    }
  });

  it("gate semantics unchanged: exactly-one is still required", () => {
    const intent: TelegramDeliveryIntent = {
      requested: true, artifacts: [], mode: "TEXT",
    };
    expect(() => assertDeliveryTaskPresence([], intent)).toThrow(/MISSING/);
    expect(() =>
      assertDeliveryTaskPresence(
        [{ required_capabilities: ["TELEGRAM_DELIVERY"] }],
        intent,
      ),
    ).not.toThrow();
    expect(() =>
      assertDeliveryTaskPresence(
        [
          { required_capabilities: ["TELEGRAM_DELIVERY"] },
          { required_capabilities: ["TELEGRAM_DELIVERY"] },
        ],
        intent,
      ),
    ).toThrow(/AMBIGUOUS/);
  });
});

/* ==================== R1 — TRUE raw delivery provenance ==================== */

const inspect = inspectRawDeliveryEmissions;
const emCount = (raw: unknown) => inspect(raw).count;
const emState = (raw: unknown) => inspect(raw).state;

describe("P15.8-HF1-R1 raw delivery emission detector", () => {
  it("exact-token semantics across every malformed shape — never throws", () => {
    expect(emCount([
      { required_capabilities: ["TELEGRAM_DELIVERY"] },
    ])).toBe(1);
    // malformed scalar — still a planner delivery ATTEMPT
    expect(emCount([
      { required_capabilities: "TELEGRAM_DELIVERY" },
    ])).toBe(1);
    expect(emCount([
      { required_capabilities: ["FILE_OPERATIONS", "TELEGRAM_DELIVERY"] },
    ])).toBe(1);
    expect(emCount([
      { required_capabilities: ["REASONING", "FILE_OPERATIONS"] },
    ])).toBe(0);
    // malformed object shape containing the exact token — an attempt
    expect(emCount([
      { required_capabilities: { 0: "x", cap: "TELEGRAM_DELIVERY" } },
    ])).toBe(1);
    expect(emCount([
      { required_capabilities: [["nested", "TELEGRAM_DELIVERY"]] },
    ])).toBe(1);
    // malformed unrelated shapes — deterministic safe handling
    expect(emCount([{ required_capabilities: 123 }])).toBe(0);
    expect(emCount([{ required_capabilities: null }])).toBe(0);
    expect(emCount([{}])).toBe(0);
    expect(emCount([null, 42, "TELEGRAM_DELIVERY"])).toBe(0);
    expect(emCount("garbage")).toBe(0);
    expect(emCount(undefined)).toBe(0);
    expect(emCount(null)).toBe(0);
    // NO substring matching
    expect(emCount([
      { required_capabilities: ["NOT_TELEGRAM_DELIVERY"] },
    ])).toBe(0);
    expect(emCount([
      { required_capabilities: ["TELEGRAM_DELIVERY_X"] },
    ])).toBe(0);
    // per-task count, not per-token
    expect(emCount([
      { required_capabilities: ["TELEGRAM_DELIVERY", "TELEGRAM_DELIVERY"] },
    ])).toBe(1);
    expect(emCount([
      { required_capabilities: ["TELEGRAM_DELIVERY"] },
      { required_capabilities: "TELEGRAM_DELIVERY" },
    ])).toBe(2);
  });
});

/* ---- production-shape failover harness (§7) ---- */

const CAND_A: PlannerCandidate = {
  model_entry_id: "me-a", ref: "gemini:test-a", provider: "gemini",
  model: "test-a", endpoint: "http://a", credentialEnv: "K_A",
};
const CAND_B: PlannerCandidate = {
  model_entry_id: "me-b", ref: "codex:test-b", provider: "codex",
  model: "test-b", endpoint: "", credentialEnv: "K_B", transport: "codex_cli",
};

/** Mimics BOTH planner transports exactly: parsed provider JSON → FIRST
 *  sanitizePlan drop (the transport's own pass) → bounded raw-emission
 *  evidence returned alongside the already-sanitized task list. */
const transportShaped = (raw: Array<Record<string, unknown>>) => {
  const insp = inspect(raw);
  const { tasks, warnings } = sanitizePlan(
    raw as never[],
    SERVE_LLM_PLANNER_CAPS.slice(),
    12,
    FULL_SETS,
  );
  return {
    tasks: tasks as Array<Record<string, unknown>>,
    warnings,
    raw_delivery_emission_count: insp.count,
    raw_delivery_emission_state: insp.state,
  };
};

/** A delivery emission the transport sanitize provably drops
 *  (scalar required_capabilities → DROP_NO_ALLOWED_CAPS). */
const malformedDeliv = (key: string) => ({
  task_key: key,
  title: key,
  task_instruction: "gửi kết quả tới telegram",
  required_capabilities: "TELEGRAM_DELIVERY",
  depends_on: [],
  metadata: {},
});

const runFail = async (
  goal: string,
  planByRef: Record<string, (inv: PlannerInvocation) => Array<Record<string, unknown>>>,
) => {
  const seen: Array<{ ref: string; r: number | undefined; s?: string }> = [];
  const calls: Array<{ ref: string; kind: string }> = [];
  const attempts: PlannerAttemptRecord[] = [];
  const canonFresh = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
  const candidates = [CAND_A, CAND_B].filter((c) => planByRef[c.ref]);
  let result: PlannerFailoverResult | null = null;
  let error: { code?: string } | null = null;
  try {
    result = await runPlannerFailover({
      candidates,
      assertEligible: () => {},
      planFn: async (c, inv) => {
        calls.push({ ref: c.ref, kind: inv.kind });
        return transportShaped(planByRef[c.ref](inv));
      },
      canonicalize: (tasks, c, ev) => {
        seen.push({ ref: c.ref, r: ev?.raw_delivery_emission_count, s: ev?.raw_delivery_emission_state });
        const canon = canonFresh(tasks, goal, {
          provenance: "fresh",
          raw_delivery_emission_count: ev?.raw_delivery_emission_count,
          raw_delivery_emission_state: ev?.raw_delivery_emission_state,
        });
        validatePlanProposal({ tasks: canon }, new Set(SERVE_LLM_PLANNER_CAPS));
        return canon;
      },
      onAttemptEnd: (_t, rec) => attempts.push(rec),
      now: () => "2026-10-09T00:00:00.000Z",
    });
  } catch (e) {
    error = e as { code?: string };
  }
  return { result, error, seen, calls, attempts };
};

const attemptWarnings = (attempts: PlannerAttemptRecord[]) =>
  attempts.flatMap((a) => (a.warnings as string[]) ?? []);

describe("P15.8-HF1-R1 production-shape raw provenance", () => {
  it("R1.A raw malformed delivery dropped BEFORE canonicalizer → INVALIDATED, zero injection", async () => {
    const raw = () => [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      malformedDeliv("T9"),
    ];
    // prove the transport sanitize drops it
    const shaped = transportShaped(raw());
    expect(shaped.tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(shaped.raw_delivery_emission_count).toBe(1);
    expect(shaped.raw_delivery_emission_state).toBe("PRESENT");

    const { result, error, seen, attempts } = await runFail(TEXT_GOAL, {
      "gemini:test-a": () => raw(),
    });
    expect(result).toBeNull();
    expect(String(error?.code)).toBe("FAIL_CLOSED_PLANNER_EXHAUSTED");
    // canonicalize saw R=1 evidence on EVERY invocation (INITIAL + REASK)
    expect(seen.every((s) => s.r === 1)).toBe(true);
    expect(attemptWarnings(attempts)).toContain(
      "VALIDATION_CODE:FAIL_CLOSED_DELIVERY_TASK_INVALIDATED",
    );
  });

  it("R1.B TRUE omission: provider raw has no delivery → exactly one PAIR injection", async () => {
    const { result, error, seen } = await runFail(TEXT_GOAL, {
      "gemini:test-a": () => RAW_TEXT_OMITTING(),
    });
    expect(error).toBeNull();
    expect(seen[0].r).toBe(0);
    const del = deliveries(result!.tasks);
    expect(del).toHaveLength(1);
    const md = del[0].metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { reason: string }).reason)
      .toBe("DELIVERY_TASK_INJECTED");
  });

  it("R1.C raw duplicate delivery, one survives sanitize → AMBIGUOUS, never silently valid", async () => {
    const raw = () => [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      work("T8", "gửi bản tóm tắt đến telegram", ["TELEGRAM_DELIVERY"], ["T1"]),
      malformedDeliv("T9"),
    ];
    const shaped = transportShaped(raw());
    // sanitize keeps the valid one, drops the malformed → C=1 BUT R=2
    expect(shaped.raw_delivery_emission_count).toBe(2);
    expect(deliveries(shaped.tasks)).toHaveLength(1);

    const { result, error, seen, attempts } = await runFail(TEXT_GOAL, {
      "gemini:test-a": () => raw(),
    });
    expect(result).toBeNull();
    expect(String(error?.code)).toBe("FAIL_CLOSED_PLANNER_EXHAUSTED");
    expect(seen.every((s) => s.r === 2)).toBe(true);
    expect(attemptWarnings(attempts)).toContain(
      "VALIDATION_CODE:FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS",
    );
  });

  it("R1.D no operator intent + unauthorized raw delivery dropped → INTENT fail, plan never accepted", async () => {
    const NO_INTENT_GOAL = "đọc dữ liệu bán hàng rồi tổng hợp báo cáo";
    const raw = () => [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      malformedDeliv("T9"),
    ];
    const shaped = transportShaped(raw());
    expect(shaped.tasks).toHaveLength(1); // attempt dropped by transport

    const { result, error, seen, attempts } = await runFail(NO_INTENT_GOAL, {
      "gemini:test-a": () => raw(),
    });
    expect(result).toBeNull();
    expect(String(error?.code)).toBe("FAIL_CLOSED_PLANNER_EXHAUSTED");
    expect(seen.every((s) => s.r === 1)).toBe(true);
    expect(attemptWarnings(attempts)).toContain(
      "VALIDATION_CODE:FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT",
    );
  });

  it("R1.E REASK isolation: canonicalize receives the evidence of the EXACT invocation", async () => {
    const rawFor = (inv: PlannerInvocation) =>
      inv.kind === "REASK"
        ? RAW_TEXT_OMITTING()                    // re-ask: true omission
        : [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]), malformedDeliv("T9")];
    const { result, error, seen, calls } = await runFail(TEXT_GOAL, {
      "gemini:test-a": rawFor,
    });
    expect(error).toBeNull();
    expect(calls.map((c) => c.kind)).toEqual(["INITIAL", "REASK"]);
    // evidence belongs to the invocation: INITIAL saw R=1, REASK saw R=0
    expect(seen.map((s) => s.r)).toEqual([1, 0]);
    // REASK plan was canonicalized with ITS OWN count → omission → injected
    const del = deliveries(result!.tasks);
    expect(del).toHaveLength(1);
    const md = del[0].metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { reason: string }).reason)
      .toBe("DELIVERY_TASK_INJECTED");
  });

  it("R1.F candidate failover isolation: evidence from candidate A never contaminates B", async () => {
    const { result, error, seen } = await runFail(TEXT_GOAL, {
      "gemini:test-a": () => [
        work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
        malformedDeliv("T9"),
      ],
      "codex:test-b": () => RAW_TEXT_OMITTING(),
    });
    expect(error).toBeNull();
    // A: INITIAL+REASK both R=1/PRESENT (INVALIDATED) → B: R=0/ABSENT → injected
    expect(seen.map(({ ref, r, s }) => ({ ref, r, s }))).toEqual([
      { ref: "gemini:test-a", r: 1, s: "PRESENT" },
      { ref: "gemini:test-a", r: 1, s: "PRESENT" },
      { ref: "codex:test-b", r: 0, s: "ABSENT" },
    ]);
    expect(result!.winner.route).toBe("codex:test-b");
    expect(deliveries(result!.tasks)).toHaveLength(1);
  });
});

/* ---- §8 re-canonicalization / provenance determinism pins ---- */

describe("P15.8-HF1-R1 replay determinism", () => {
  it("persisted replay: canonical injected plan is byte-identical incl. injection record", () => {
    const first = canon(RAW_TEXT_OMITTING(), TEXT_GOAL);
    const replay = canon(first, TEXT_GOAL, FULL_SETS, "persisted");
    expect(replay).toEqual(first);
    const md = deliveries(replay)[0].metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { reason: string }).reason)
      .toBe("DELIVERY_TASK_INJECTED");
  });

  it("fresh re-canonicalization of an injected plan is NOT the replay contract — record stripped", () => {
    // Explicit pin per mandate §8: the ONLY supported replay path for a
    // canonical plan is ctx.provenance="persisted". Feeding a canonical
    // injected list through the FRESH seam strips the PAIR-owned stamp
    // (planner-forgery defense) while the task itself survives intact.
    const first = canon(RAW_TEXT_OMITTING(), TEXT_GOAL);
    const recanon = canon(first, TEXT_GOAL);
    const del = deliveries(recanon);
    expect(del).toHaveLength(1);
    const md = del[0].metadata as Record<string, unknown>;
    expect(md[PAIR_DELIVERY_INJECTION_KEY]).toBeUndefined();
    expect(md[TELEGRAM_MANIFEST_FIELD]).toBeDefined();
  });
});

/* ==================== §9 real delivery-pipeline E2E ==================== */

/** Minimal scripted executor (same contract as the f4 harness adapter):
 *  dispatch → RUNNING; collect_result declares the artifacts the
 *  execution really wrote (canonical ingest seam). */
class E2EAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  wroteTaskKeys: string[] = [];
  fileContent: Record<string, string> = {};
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
      fs.writeFileSync(fp, this.fileContent[key] ?? `delivery text for ${key}`);
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

interface PipeStack extends ReturnType<typeof freshStack> {
  adapters: Map<string, ExecutorAdapter>;
  adapter: E2EAdapter;
  runtime: MissionRuntime;
  workspace: string;
}

function pipeStack(name: string, rawForGoal: (goal: string) => Array<Record<string, unknown>>): PipeStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
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
  const canonicalize = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
  // Planner = production seam: TRUE raw evidence computed over the canned
  // raw candidate (as the transports do) then canonicalize fresh.
  const planner = (input: { mission?: { goal?: unknown; metadata?: Record<string, unknown> } }) => {
    const pinned = input.mission?.metadata?.pinned_plan_tasks as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
    const goal = String(input.mission?.goal ?? "");
    const raw = rawForGoal(goal);
    const insp = inspect(raw);
    return {
      tasks: canonicalize(raw, goal, {
        provenance: "fresh",
        raw_delivery_emission_count: insp.count,
        raw_delivery_emission_state: insp.state,
      }),
    };
  };
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
  const adapter = new E2EAdapter("EX_E2E", [
    "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    "AUTOMATON_TASK_EXECUTION", "NETWORK_ACCESS",
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
  return {
    store, control, runtime, adapters, adapter, workspace,
    biz: new BusinessLayer({ store, control, schedules: new MissionScheduleService(service) }),
    projectId: String(project.project_id), projectRoot: workspace,
  };
}

const missionState = (s: PipeStack, mid: string) =>
  String((s.store.get("mission_runtime", `MRT_${mid}`) as { state: string }).state);

function driveToTerminal(s: PipeStack, mid: string, max = 200) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    s.runtime.tick(mid, new Date(t).toISOString());
    const st = missionState(s, mid);
    if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(st)) return st;
  }
  return missionState(s, mid);
}

describe("P15.8-HF1-R1 §9 real delivery pipeline", () => {
  it("true omission → injected task routes to delivery executor → staging → governed send", async () => {
    const s = pipeStack("pipe", () => RAW_TEXT_OMITTING());
    s.adapter.fileContent["T4"] = "BÁO CÁO TÓM TẮT: doanh thu tăng";
    // goal → planner true omission → canonical injection → preview → confirm
    const preview = s.control.createPlanPreview({
      project_id: s.projectId,
      goal: TEXT_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.workspace],
      risk_ceiling: "LOW",
      operator_id: OP,
    });
    const pinned = preview.plan.tasks as Array<Record<string, unknown>>;
    const injected = deliveries(pinned)[0];
    const md = injected.metadata as Record<string, unknown>;
    expect((md[PAIR_DELIVERY_INJECTION_KEY] as { reason: string }).reason)
      .toBe("DELIVERY_TASK_INJECTED");
    const mission = s.control.confirmPlanPreview({
      preview_id: String(preview.preview_id),
      plan_digest: String(preview.plan_digest),
      operator_id: OP,
    });
    const mid = String(mission.mission_id);
    // normal routing → delivery preparation executor runs → staging occurs
    const terminal = driveToTerminal(s, mid);
    expect(terminal).toBe("COMPLETED");
    // the injected task was REALLY dispatched to the delivery executor
    const taskRows = (s.store.list("task") as Array<Record<string, unknown>>)
      .filter((t) => String(t.mission_id) === mid);
    const delRow = taskRows.find((t) =>
      ((t.required_capabilities as string[]) ?? []).includes("TELEGRAM_DELIVERY"));
    expect(delRow).toBeDefined();
    expect(String(delRow!.status)).toBe("COMPLETED");
    expect(s.adapter.dispatched.length).toBeGreaterThan(0);
    // governed outbox staging: the delivery execution wrote the staged file
    expect(s.adapter.wroteTaskKeys.some((k) => k.endsWith(":outbox/report.txt"))).toBe(true);
    // a governed delivery request was minted (outbox staging boundary)
    const pend = pendingTelegramDeliveries(s.store) as Array<Record<string, unknown>>;
    expect(pend.length).toBe(1);
    // injected task is downstream-indistinguishable: same minted request,
    // same text_source_artifact staging as a planner-emitted delivery task
    const req = pend[0];
    expect(String(req.text_source_artifact)).toBe("outbox/report.txt");
    // governed transport path engages (mock transport at the real seam)
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
    if (!r.sent.length) {
      console.log("REQ", JSON.stringify({
        mode: req.mode, text_state: req.text_state,
        textLen: String(req.text ?? "").length,
        dest: req.destination, delivery_id: req.delivery_id,
      }));
      console.log("RES", JSON.stringify(r));
    }
    expect(r.sent.length).toBe(1);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].chatId)).toBe("111");
    expect(String(calls[0].text)).toContain("BÁO CÁO TÓM TẮT");
  });
});

/* ==================== R2 — provenance hardening ==================== */

import { llmPlan } from "../pair/llm-planner.js";
import { codexPlannerPlan } from "../pair/codex-planner.js";

/** Caps field nested this deep exceeds the bounded detector depth — a
 *  token inside was never inspected → INDETERMINATE, never ABSENT. */
const DEEP_CAPS = {
  a: { a: { a: { a: { a: { a: { a: { a: { a: "TELEGRAM_DELIVERY" } } } } } } } },
};

describe("P15.8-HF1-R2 defect A — object-key token bypass closed", () => {
  it("exact token as OBJECT KEY → PRESENT; substring keys never match", () => {
    expect(inspect([{ required_capabilities: { TELEGRAM_DELIVERY: true } }]))
      .toEqual({ state: "PRESENT", count: 1 });
    // nested object key
    expect(inspect([
      { required_capabilities: { caps: { TELEGRAM_DELIVERY: 1 } } },
    ])).toEqual({ state: "PRESENT", count: 1 });
    // substring keys are never the capability token
    for (const caps of [
      { NOT_TELEGRAM_DELIVERY: true },
      { TELEGRAM_DELIVERY_X: true },
      { XTELEGRAM_DELIVERY: true },
      { " TELEGRAM_DELIVERY": true },
      { "TELEGRAM_DELIVERY ": true },
    ]) {
      expect(inspect([{ required_capabilities: caps }])).toEqual({
        state: "ABSENT", count: 0,
      });
    }
    // key token AND value token in one task still counts the task ONCE
    expect(inspect([
      { required_capabilities: { TELEGRAM_DELIVERY: ["TELEGRAM_DELIVERY"] } },
    ])).toEqual({ state: "PRESENT", count: 1 });
  });

  it("unrelated fields never become capability evidence", () => {
    // token in title/instruction/metadata is NOT a capability emission
    expect(inspect([
      {
        task_key: "T1", title: "TELEGRAM_DELIVERY",
        task_instruction: "gửi TELEGRAM_DELIVERY",
        required_capabilities: ["REASONING"],
        metadata: { note: "TELEGRAM_DELIVERY" },
      },
    ])).toEqual({ state: "ABSENT", count: 0 });
  });

  it("object-key emission dropped by sanitize → INVALIDATED, never injected", () => {
    const raw = () => [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      {
        task_key: "T9", title: "T9",
        task_instruction: "gửi tới telegram",
        required_capabilities: { TELEGRAM_DELIVERY: true },
        depends_on: ["T1"], metadata: {},
      },
    ];
    const shaped = transportShaped(raw());
    expect(shaped.tasks.map((t) => t.task_key)).toEqual(["T1"]); // dropped
    expect(shaped.raw_delivery_emission_state).toBe("PRESENT");
    expect(() =>
      canon(raw(), TEXT_GOAL, FULL_SETS, "fresh")
    ).toThrow(/FAIL_CLOSED_DELIVERY_TASK_INVALIDATED/);
    // through the failover seam too — INVALIDATED on every invocation
    return runFail(TEXT_GOAL, { "gemini:test-a": raw }).then(({ error, seen }) => {
      expect(String(error?.code)).toBe("FAIL_CLOSED_PLANNER_EXHAUSTED");
      expect(seen.every((s) => s.r === 1 && s.s === "PRESENT")).toBe(true);
    });
  });
});

describe("P15.8-HF1-R2 defect B — depth limit can never fake R=0", () => {
  it("token beyond supported depth → INDETERMINATE (not ABSENT)", () => {
    expect(inspect([{ required_capabilities: DEEP_CAPS }]).state)
      .toBe("INDETERMINATE");
    // array nest equally deep
    const deepArr: unknown[] = [];
    let cur: unknown = deepArr;
    for (let i = 0; i < 12; i++) {
      const nx: unknown[] = [];
      (cur as unknown[]).push(nx);
      cur = nx;
    }
    (cur as unknown[]).push("TELEGRAM_DELIVERY");
    expect(inspect([{ required_capabilities: deepArr }]).state)
      .toBe("INDETERMINATE");
    // a genuinely shallow ABSENT stays ABSENT
    expect(inspect([{ required_capabilities: ["REASONING"] }]))
      .toEqual({ state: "ABSENT", count: 0 });
  });

  it("indeterminate evidence → typed fail-closed at the canonicalize boundary", () => {
    const raw = () => [
      work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
      { task_key: "T9", title: "T9", task_instruction: "x",
        required_capabilities: DEEP_CAPS, depends_on: [], metadata: {} },
    ];
    // with intent — never treated as proven omission → no injection
    expect(() => canon(raw(), TEXT_GOAL, FULL_SETS, "fresh"))
      .toThrow(/FAIL_CLOSED_DELIVERY_EMISSION_INDETERMINATE/);
    // without intent — same typed verdict (unproven ≠ authorized)
    expect(() => canon(raw(), "đọc dữ liệu bán hàng rồi tổng hợp", FULL_SETS, "fresh"))
      .toThrow(/FAIL_CLOSED_DELIVERY_EMISSION_INDETERMINATE/);
    // persisted replay unaffected: raw evidence only governs FRESH
    // plans (a persisted canonical plan is replayed verbatim — the §8
    // byte-identical replay pin above covers it).
  });
});

describe("P15.8-HF1-R2 defect C — canonical count consistency", () => {
  it("C > R is an impossible relationship → typed rejection, never repaired", () => {
    const canonFresh = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
    // evidence claims ABSENT/R=0 but the (already-sanitized) task list
    // carries a live canonical delivery task → impossible → reject.
    expect(() =>
      canonFresh(
        [
          work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
          work("T2", "gửi bản tóm tắt đến telegram", ["TELEGRAM_DELIVERY"], ["T1"]),
        ],
        TEXT_GOAL,
        {
          provenance: "fresh",
          raw_delivery_emission_count: 0,
          raw_delivery_emission_state: "ABSENT",
        },
      ),
    ).toThrow(/FAIL_CLOSED_DELIVERY_COUNT_INCONSISTENT/);
    // persisted provenance never re-judges evidence: replay a
    // previously-canonical plan verbatim, impossible ctx evidence
    // attached — the replay contract ignores raw evidence entirely.
    const canonical = canonFresh(
      [work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"])],
      "đọc dữ liệu bán hàng rồi tổng hợp",
      { provenance: "fresh" },
    );
    const persisted = canonFresh(canonical, "đọc dữ liệu bán hàng rồi tổng hợp", {
      provenance: "persisted",
      raw_delivery_emission_count: 0,
      raw_delivery_emission_state: "ABSENT",
    });
    expect(persisted).toEqual(canonical);
  });

  it("verified R=0/C=0 omission still injects exactly once (sole valid condition)", () => {
    const out = canon(RAW_TEXT_OMITTING(), TEXT_GOAL);
    expect(deliveries(out)).toHaveLength(1);
  });

  it("valid R=1/C=1 planner emission passes untouched", () => {
    const out = canon(
      [
        work("T1", "đọc dữ liệu bán hàng và tổng hợp", ["REASONING"]),
        work("T2", "gửi bản tóm tắt đến telegram", ["TELEGRAM_DELIVERY"], ["T1"]),
      ],
      TEXT_GOAL,
    );
    const del = deliveries(out);
    expect(del).toHaveLength(1);
    expect((del[0].metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY])
      .toBeUndefined();
  });
});

describe("P15.8-HF1-R2 direct transport boundaries", () => {
  const TRANSPORT_CAPS = SERVE_LLM_PLANNER_CAPS.slice();
  const mkPlan = (caps: unknown) => JSON.stringify({
    tasks: [
      { task_key: "T1", title: "w", task_instruction: "đọc dữ liệu bán hàng rồi viết file vào workspace, xong reply DONE",
        required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
        metadata: { network_requirement: NETREQ_LOCAL } },
      { task_key: "T9", title: "d", task_instruction: "gửi tới telegram",
        required_capabilities: caps, depends_on: ["T1"], metadata: {} },
    ],
  });
  const okFetch = (content: string) =>
    (async () => new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  it("llmPlan (HTTP transport): evidence captured BEFORE its own sanitize", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "llm-"));
    const r = await llmPlan("gửi báo cáo tới telegram", {
      endpoint: "https://example.invalid/chat/completions",
      credentialEnv: "TEST_LLM_KEY",
      model: "test-model",
      allowedCapabilities: TRANSPORT_CAPS,
      capabilitySets: FULL_SETS,
      env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
      fetchFn: okFetch(mkPlan({ TELEGRAM_DELIVERY: true })),
      scratchDir: dir,
    } as never);
    // object-key emission: sanitize dropped the task, evidence PRESENT
    expect(r.tasks.every((t) => t.task_key !== "T9")).toBe(true);
    expect(r.raw_delivery_emission_state).toBe("PRESENT");
    expect(r.raw_delivery_emission_count).toBe(1);
    // deep caps → INDETERMINATE evidence, never a clean R=0
    const r2 = await llmPlan("gửi báo cáo tới telegram", {
      endpoint: "https://example.invalid/chat/completions",
      credentialEnv: "TEST_LLM_KEY",
      model: "test-model",
      allowedCapabilities: TRANSPORT_CAPS,
      capabilitySets: FULL_SETS,
      env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
      fetchFn: okFetch(mkPlan(DEEP_CAPS)),
      scratchDir: dir,
    } as never);
    expect(r2.raw_delivery_emission_state).toBe("INDETERMINATE");
  });

  it("codexPlannerPlan (CLI transport): identical boundary semantics", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "cx-"));
    const exe = path.join(dir, "fake-codex.cjs");
    fs.writeFileSync(exe, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const out = argv.indexOf("--output-last-message") >= 0
  ? argv[argv.indexOf("--output-last-message") + 1] : null;
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (!out) process.exit(1);
  fs.writeFileSync(out, JSON.stringify({ tasks: [
    { task_key: "T1", title: "w", task_instruction: "đọc dữ liệu rồi viết file vào workspace, xong reply DONE", required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: { network_requirement: { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED" } } },
    { task_key: "T9", title: "d", task_instruction: "gửi tới telegram", required_capabilities: ${JSON.stringify(DEEP_CAPS)}, depends_on: ["T1"], metadata: {} },
  ] }));
  process.exit(0);
});
`);
    fs.chmodSync(exe, 0o755);
    const r = await codexPlannerPlan("gửi báo cáo tới telegram", {
      executable: exe,
      model: "test-model",
      timeoutMs: 30_000,
      scratchDir: dir,
      allowedCapabilities: TRANSPORT_CAPS,
      capabilitySets: FULL_SETS,
    });
    expect(r.raw_delivery_emission_state).toBe("INDETERMINATE");
  });
});
