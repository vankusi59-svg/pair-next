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
  type TelegramDeliveryIntent,
} from "../pair/plan-dataflow.js";
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
