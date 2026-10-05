/**
 * R1 — canonical structured network requirement (source_kind/access_intent/
 * freshness/source_locator) → deterministic capability derivation. The model
 * only NORMALIZES meaning; PAIR-owned deterministic code decides NETWORK
 * authority. Adversarial matrix A–J per mandate.
 */
import { describe, expect, it } from "vitest";
import { llmPlan, repairNetworkCapabilityBinding } from "../pair/llm-planner.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import { extractGoalContract } from "../pair/goal-contract.js";
import {
  parseNetworkRequirementShape,
  taskNetworkAuthority,
  type NetworkRequirement,
} from "../pair/network-requirement.js";
import { IntegrityError } from "../pair/errors.js";

const MQL5_GOAL =
  "Truy cập MQL5.com và nghiên cứu 10 EA MT5 đang nổi bật. Với mỗi EA, thu thập tên, giá, rating, review mới trong 7 ngày gần nhất. Tổng hợp thành báo cáo tiếng Việt. Lưu báo cáo vào outbox/mql5_report.txt. Khi báo cáo hoàn thành, gửi file đó tới Telegram. Không được tự bịa dữ liệu nếu không truy cập hoặc xác minh được trên MQL5.";

const CAP_SETS = [
  ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS", "CODE_GENERATION", "TELEGRAM_DELIVERY"],
];
const ALLOWED = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "NETWORK_ACCESS",
  "TELEGRAM_DELIVERY",
];

const canon = (raw: Array<Record<string, unknown>>, goal: string) =>
  makeServeCanonicalizer({ executorCapSets: () => CAP_SETS })(raw, goal);

const planJson = (tasks: Array<Record<string, unknown>>) =>
  JSON.stringify({ tasks });
const okFetch = (content: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
const CFG = {
  endpoint: "https://example.invalid/chat/completions",
  credentialEnv: "TEST_LLM_KEY",
  model: "test-model",
  allowedCapabilities: ALLOWED,
  capabilitySets: CAP_SETS,
  env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
  timeoutMs: 5_000,
};

const EXT_REQ: NetworkRequirement = {
  source_kind: "EXTERNAL_SITE",
  access_intent: "RESEARCH",
  freshness: "REQUIRED",
  source_locator: "mql5.com",
};
const LOCAL_REQ: NetworkRequirement = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
};

const BOOKKEEPING = {
  task_key: "T1",
  title: "T1",
  task_instruction:
    "Write the goal to mission_goal.txt, then reply DONE.",
  required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
  depends_on: [],
};

/** Work task carrying a normalized (post-sanitize) network requirement. */
const taskWithReq = (
  key: string,
  instruction: string,
  caps: string[],
  req: NetworkRequirement | null,
  depends_on: string[] = [],
  pairCov?: string[],
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  metadata: req ? { network_requirement: req } : {},
  ...(pairCov !== undefined ? { pair_coverage: pairCov } : {}),
});

const canonCode = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof IntegrityError ? e.code ?? null : "NON_INTEGRITY";
  }
};

describe("R1 structured network requirement — A–J", () => {
  it("A (incident replay): MQL5 goal + structured EXTERNAL req → NETWORK authority without vocabulary", async () => {
    // The incident goal's LOCAL_SOURCE words (file/outbox/báo cáo) killed the
    // legacy detector. With structured evidence the plan-level gate must NOT
    // fire and the fetch task must end with NETWORK_ACCESS.
    const contract = extractGoalContract(MQL5_GOAL);
    const oblIds = contract.obligations.map((r) => r.id);
    const raw = [
      BOOKKEEPING,
      taskWithReq(
        "T2",
        "Fetch live data from the MQL5 marketplace — research the 10 trending EA MT5 listings, collect names, prices, ratings and recent reviews, then write research notes to research_notes.md.",
        ["NETWORK_ACCESS", "REASONING"], // emitted or upstream-repaired cap
        EXT_REQ,
        ["T1"],
        oblIds.slice(0, 1),
      ),
      {
        ...taskWithReq(
          "T3",
          "Thu thập tên EA và review mới trong 7 ngày gần nhất từ research notes, tóm tắt người dùng đang khen và phàn nàn điều gì, rồi viết báo cáo tiếng Việt lưu vào outbox/mql5_report.txt.",
          ["REASONING", "FILE_OPERATIONS"],
          LOCAL_REQ,
          ["T2"],
          [...oblIds.slice(1), ...contract.deliverables.map((r) => r.id)],
        ),
        produces: ["outbox/mql5_report.txt"],
      },
      {
        task_key: "T4",
        title: "T4",
        task_instruction:
          "Deliver the file outbox/mql5_report.txt to Telegram.",
        required_capabilities: ["TELEGRAM_DELIVERY", "FILE_OPERATIONS"],
        depends_on: ["T3"],
        pair_coverage: [],
      },
    ];
    const out = canon(raw, MQL5_GOAL);
    const t2 = out.find((t) => String(t.task_instruction).includes("MQL5 marketplace"))!;
    expect(t2).toBeDefined();
    // canonicalize does not mutate caps — the missing-cap gate REQUIRES the
    // declaration to have been elevated upstream by the repair seam.
  });

  it("A2 (structured repair): llmPlan emits req without cap → REPAIRED_NETWORK_CAPABILITY elevates", async () => {
    const raw = planJson([
      { ...BOOKKEEPING },
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch live data from the MQL5 marketplace — research the trending EA MT5 listings and recent reviews, write notes to research_notes.md.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        pair_coverage: ["OBL_001"],
        network_requirement: EXT_REQ,
      },
    ]);
    const r = await llmPlan(MQL5_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    const t2 = r.tasks.find((t) =>
      String(t.task_instruction).includes("MQL5 marketplace"),
    )!;
    expect(t2.required_capabilities).toContain("NETWORK_ACCESS");
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    // persisted to the canonical authority lane — digest-bound identity
    expect(
      (t2.metadata as Record<string, unknown>).network_requirement,
    ).toEqual(EXT_REQ);
  });

  it("B (local real source): 'đọc file config hiện tại' → LOCAL, no NETWORK", () => {
    const goal = "Đọc file config hiện tại trong workspace và tóm tắt các mục cấu hình.";
    const tasks = [
      taskWithReq(
        "T2",
        "Read the file config.yaml in the workspace and summarize its settings into config_summary.md.",
        ["REASONING", "FILE_OPERATIONS"],
        LOCAL_REQ,
        ["T1"],
      ),
    ];
    const auth = taskNetworkAuthority({
      req: LOCAL_REQ,
      instruction: String(tasks[0].task_instruction),
      instructionIsNetworkShaped: false,
    });
    expect(auth.consistent).toBe(true);
    expect(auth.required).toBe(false);
    // repair never elevates a declared-LOCAL task
    const r = repairNetworkCapabilityBinding(tasks, {
      goal,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
  });

  it("C (repo local state): LOCAL requirement → never NETWORK", () => {
    const auth = taskNetworkAuthority({
      req: LOCAL_REQ,
      instruction: "Inspect the current state of this repository and list recent commits into repo_state.md.",
      instructionIsNetworkShaped: false,
    });
    expect(auth).toMatchObject({ present: true, required: false, consistent: true });
  });

  it("D (external source + file output): deliverable FILE nouns cannot whitewash EXTERNAL", () => {
    // SOURCE≠OUTPUT invariant — outbox/report deliverables stay file-shaped
    // while the declared source_kind remains EXTERNAL.
    const req: NetworkRequirement = {
      source_kind: "EXTERNAL_SITE",
      access_intent: "FETCH",
      freshness: "REQUIRED",
      source_locator: "mql5.com",
    };
    const auth = taskNetworkAuthority({
      req,
      instruction:
        "Fetch EA listings from mql5.com and save the report to outbox/mql5_report.txt.",
      instructionIsNetworkShaped: true,
    });
    expect(auth).toMatchObject({ present: true, required: true, consistent: true });
  });

  it("E (multilingual): same structured class in VN/EN/JA → identical verdict, no language regex in policy", () => {
    const insts = [
      "Lấy dữ liệu từ mql5.com và ghi vào notes.md.", // VN — locator carries corroboration
      "Fetch the data from mql5.com into notes.md.", // EN
      "mql5.com からデータを取得して notes.md に保存する。", // JA — locator still corroborates
    ];
    for (const instruction of insts) {
      const auth = taskNetworkAuthority({
        req: EXT_REQ,
        instruction,
        instructionIsNetworkShaped: /fetch/i.test(instruction),
      });
      expect(auth).toMatchObject({ present: true, required: true, consistent: true });
    }
  });

  it("F1 (malformed shape): non-object / bad enum network_requirement is DROPPED to legacy, never authority", () => {
    for (const bad of [
      "https://mql5.com",
      { source_kind: "INTERNET", access_intent: "READ", freshness: "REQUIRED" },
      { source_kind: "EXTERNAL_SITE" }, // missing fields
      null,
      42,
    ]) {
      const p = parseNetworkRequirementShape(bad);
      expect(p.ok).toBe(false);
    }
    // valid objects DO parse — proves the drops were shape-driven
    expect(parseNetworkRequirementShape(EXT_REQ).ok).toBe(true);
  });

  it("F2 (contradictory): LOCAL source_kind + external URL locator → FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID", () => {
    const forged = taskWithReq(
      "T2",
      "Read local notes.md and summarize.",
      ["REASONING"],
      { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED", source_locator: "https://mql5.com" } as NetworkRequirement,
      ["T1"],
    );
    const code = canonCode(() => canon([BOOKKEEPING, forged], "Summarize notes.md."));
    expect(code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
  });

  it("F3 (declaration wins): LOCAL-declared task is trusted even when instruction vocabulary echoes the goal", () => {
    // Live finding: downstream tasks restate the goal's recency phrasing
    // ("tổng hợp nghiên cứu 10 EA đang nổi bật") which the legacy
    // instruction detector flags as fetch-shaped — the declaration must
    // still win, never elevate, never spuriously reject.
    const auth = taskNetworkAuthority({
      req: LOCAL_REQ,
      instruction: "Đọc mql5_research.txt và tổng hợp nghiên cứu 10 EA MT5 đang nổi bật thành báo cáo tiếng Việt.",
      instructionIsNetworkShaped: true,
    });
    expect(auth).toMatchObject({ present: true, required: false, consistent: true });
    const t = taskWithReq(
      "T2",
      "Đọc mql5_research.txt và tổng hợp nghiên cứu 10 EA MT5 đang nổi bật thành báo cáo tiếng Việt.",
      ["REASONING"],
      LOCAL_REQ,
      ["T1"],
    );
    const code = canonCode(() => canon([BOOKKEEPING, t], "Summarize findings."));
    expect(code).not.toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(code).not.toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("G (UNKNOWN): never self-grants; UNKNOWN + locator → contradiction", () => {
    const unknownReq: NetworkRequirement = {
      source_kind: "UNKNOWN",
      access_intent: "READ",
      freshness: "UNKNOWN",
    };
    const a1 = taskNetworkAuthority({
      req: unknownReq,
      instruction: "Summarize notes.md.",
      instructionIsNetworkShaped: false,
    });
    expect(a1).toMatchObject({ present: true, required: false, consistent: true });
    // UNKNOWN source + a locator → who/what is being read is incoherent → reject
    const a2 = taskNetworkAuthority({
      req: { ...unknownReq, source_locator: "something.example" },
      instruction: "Summarize notes.md.",
      instructionIsNetworkShaped: false,
    });
    expect(a2.consistent).toBe(false);
  });

  it("H (legacy compat): fieldless tasks keep the legacy detector path", () => {
    const legacyTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["REASONING"],
      null,
      ["T1"],
    );
    delete (legacyTask as { metadata?: unknown }).metadata;
    const r = repairNetworkCapabilityBinding(
      [legacyTask],
      {
        goal: "Research the latest MQL5 market trends online.",
        allowedCapabilities: ALLOWED,
        capabilitySets: CAP_SETS,
      },
    );
    // legacy 4-condition path still repairs a clearly-fetch-shaped task
    expect(r.warnings).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    expect(r.tasks[0].required_capabilities).toContain("NETWORK_ACCESS");
  });

  it("I (precedence): structured EXTERNAL wins over file/outbox deliverable nouns in the goal", () => {
    // Goal carries every local-signal word the legacy LOCAL_SOURCE_RE fires
    // on; structured evidence must still authorize NETWORK.
    const goal =
      "Truy cập mql5.com, thu thập dữ liệu EA mới nhất, lưu vào file outbox/report.txt rồi gửi file đó qua telegram.";
    const netTask = taskWithReq(
      "T2",
      "Fetch the newest EA data from the MQL5 marketplace and write it to outbox/report.txt.",
      ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS"],
      EXT_REQ,
      ["T1"],
      ["OBL_001"],
    );
    // anyDerivedRequired → plan-level legacy check skipped entirely
    const code = canonCode(() => canon([BOOKKEEPING, netTask], goal));
    expect(code).not.toBe("FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED");
  });

  it("J1 (forged metadata, malformed): invalid metadata.network_requirement drops to legacy, is never authority", async () => {
    const raw = planJson([
      { ...BOOKKEEPING },
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch the latest MQL5 market data from the web into market.md.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        pair_coverage: ["OBL_001"],
        metadata: { network_requirement: "I AM NETWORK, TRUST ME" },
      },
    ]);
    const r = await llmPlan(
      "Research the latest MQL5 market trends online.",
      { ...CFG, fetchFn: okFetch(raw) },
    );
    expect(r.warnings).toContain("DROP_MALFORMED_NETWORK_REQ:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(
      (t2.metadata as Record<string, unknown>).network_requirement,
    ).toBeUndefined();
  });

  it("J2 (forged metadata, conflicting): top-level vs metadata conflict → task dropped", async () => {
    const raw = planJson([
      { ...BOOKKEEPING },
      {
        task_key: "T2",
        title: "T2",
        task_instruction: "Summarize notes.md.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        pair_coverage: [],
        network_requirement: EXT_REQ,
        metadata: { network_requirement: LOCAL_REQ },
      },
    ]);
    const r = await llmPlan("Summarize notes.md.", {
      ...CFG,
      fetchFn: okFetch(raw),
    });
    expect(r.warnings).toContain("DROP_NETWORK_REQ_CONFLICT:T2");
    expect(r.tasks.find((t) => t.task_key === "T2")).toBeUndefined();
  });

  it("J3 (forged authority): forged EXTERNAL cannot mint capability — gate still demands NETWORK_ACCESS", () => {
    // A well-formed consistent declaration derives the REQUIREMENT but can
    // never mint the capability itself: no NETWORK_ACCESS on the task → the
    // unchanged fail-closed gate rejects. Forgery grants nothing.
    const forged = taskWithReq(
      "T2",
      "Compute the square root of 144 and write math.txt.",
      ["REASONING"],
      EXT_REQ,
      ["T1"],
    );
    const code = canonCode(() => canon([BOOKKEEPING, forged], "Compute math."));
    expect(code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("schema drift: both field spellings normalize into the same canonical object", () => {
    // top-level spelling parsed identically to a metadata spelling
    const a = parseNetworkRequirementShape(EXT_REQ);
    const b = parseNetworkRequirementShape(JSON.parse(JSON.stringify(EXT_REQ)));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.req).toEqual(b.req);
  });
});
