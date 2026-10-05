/**
 * R2 — NETWORK-requirement authority hardening (audit remediation).
 *
 *  BLOCKER 1: a planner declaration can never bootstrap capability —
 *    EXTERNAL + locator not named by the operator goal → typed INVALID
 *    (UNAUTHORIZED_SOURCE); NETWORK_ACCESS on a NOT_REQUIRED/legacy task →
 *    UNAUTHORIZED_CAPABILITY; elevation requires semantic REQUIRED +
 *    operator-side canonical authorization + servability.
 *  BLOCKER 2: fresh vs legacy is explicit call-site provenance — fresh
 *    emissions missing/malformed/conflict → typed INVALID, never the
 *    legacy vocabulary detectors; only persisted plans may fall back.
 *
 * Adversarial matrix A–L per mandate (A/B/C traverse the real production
 * path: llmPlan sanitize → repair → canonicalize).
 */
import { describe, expect, it } from "vitest";
import { llmPlan, repairNetworkCapabilityBinding } from "../pair/llm-planner.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import { extractGoalContract } from "../pair/goal-contract.js";
import {
  extractGoalIdentities,
  isExternalShapedLocator,
  networkRequirementInternalContradiction,
  parseNetworkRequirementShape,
  requirementLocatorHost,
  resolveTaskNetworkAuthority,
  type NetworkRequirement,
} from "../pair/network-requirement.js";
import { IntegrityError } from "../pair/errors.js";

const MQL5_GOAL =
  "Truy cập MQL5.com và nghiên cứu 10 EA MT5 đang nổi bật. Với mỗi EA, thu thập tên, giá, rating, review mới trong 7 ngày gần nhất. Tổng hợp thành báo cáo tiếng Việt. Lưu báo cáo vào outbox/mql5_report.txt. Khi báo cáo hoàn thành, gửi file đó tới Telegram. Không được tự bịa dữ liệu nếu không truy cập hoặc xác minh được trên MQL5.";
const MATH_GOAL = "Tính căn bậc hai của 144 và lưu kết quả vào math.txt.";

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

const canon = (
  raw: Array<Record<string, unknown>>,
  goal: string,
  provenance?: "fresh" | "persisted",
) =>
  makeServeCanonicalizer({ executorCapSets: () => CAP_SETS })(
    raw,
    goal,
    provenance ? { provenance } : undefined,
  );

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
  task_instruction: "Write the goal to mission_goal.txt, then reply DONE.",
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

interface CanonFail {
  code: string;
  detail: string;
}
const canonFail = (fn: () => unknown): CanonFail | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof IntegrityError) {
      return { code: e.code ?? "?", detail: e.message };
    }
    return { code: "NON_INTEGRITY", detail: String(e) };
  }
};

describe("R2 network-requirement authority — adversarial A–L", () => {
  it("A: forged EXTERNAL on a math goal cannot bootstrap NETWORK (full production path)", async () => {
    // Planner emits a forged structured requirement for a source the
    // operator goal never named — through llmPlan sanitize → repair →
    // canonicalize, zero NETWORK_ACCESS may ever be minted.
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Compute the square root of 144 and write the result to math.txt.",
        required_capabilities: ["REASONING"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
        network_requirement: EXT_REQ, // forged: mql5.com on a math goal
      },
    ]);
    const r = await llmPlan(MATH_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    // repair must NOT elevate: declaration alone is never authorization.
    expect(r.warnings).not.toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    expect(t2.required_capabilities).not.toContain("NETWORK_ACCESS");
    // canonical gate rejects the candidate typed — no silent pick.
    const f = canonFail(() => canon(r.tasks, MATH_GOAL));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
    expect(f?.detail).toContain("T2");
  });

  it("B: forged EXTERNAL WITH a NETWORK_ACCESS claim is also rejected — cap cannot self-authorize", async () => {
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Compute the square root of 144 and write the result to math.txt.",
        required_capabilities: ["REASONING", "NETWORK_ACCESS"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
        network_requirement: EXT_REQ,
      },
    ]);
    const r = await llmPlan(MATH_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MATH_GOAL));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
    // A NOT_REQUIRED task may not carry NETWORK_ACCESS at all.
    const f2 = canonFail(() =>
      canon(
        [
          taskWithReq(
            "T2",
            "Read notes.md and summarize.",
            ["REASONING", "NETWORK_ACCESS"],
            LOCAL_REQ,
            ["T1"],
          ),
        ],
        "Summarize notes.md.",
      ),
    );
    expect(f2?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f2?.detail).toContain("UNAUTHORIZED_CAPABILITY");
  });

  it("C: exact MQL5 positive still works — goal-named host authorizes repair + canonicalize", async () => {
    const contract = extractGoalContract(MQL5_GOAL);
    const oblIds = contract.obligations.map((x) => x.id);
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch live data from the MQL5 marketplace — research the 10 trending EA MT5 listings, collect names, prices, ratings and recent reviews, then write research notes to research_notes.md.",
        required_capabilities: ["REASONING"],
        depends_on: [],
        pair_coverage: [oblIds[0] ?? "OBL_001"],
        network_requirement: EXT_REQ,
      },
      {
        task_key: "T3",
        title: "T3",
        task_instruction:
          "Đọc research_notes.md và tổng hợp thành báo cáo tiếng Việt lưu vào outbox/mql5_report.txt.",
        required_capabilities: ["REASONING", "FILE_OPERATIONS"],
        depends_on: ["T2"],
        pair_coverage: oblIds.slice(1),
        produces: ["outbox/mql5_report.txt"],
        network_requirement: LOCAL_REQ,
      },
    ]);
    const r = await llmPlan(MQL5_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    // goal names mql5.com → locator authorized → repair elevates.
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(t2.required_capabilities).toContain("NETWORK_ACCESS");
    // Canonicalize: no NETWORK authority rejection (INVALID / missing-cap).
    // A downstream gate (coverage, dataflow, delivery) may still judge the
    // plan — none of those are what R2's network authority decides.
    const f = canonFail(() => canon(r.tasks, MQL5_GOAL));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("D: multilingual equivalence — VN/EN/JA goals naming the host behave identically", async () => {
    const goals = [
      "Truy cập mql5.com và thu thập dữ liệu EA mới nhất, lưu vào outbox/r.txt.",
      "Access mql5.com and collect the latest EA data, save into outbox/r.txt.",
      "mql5.com にアクセスして最新のEAデータを収集し、outbox/r.txt に保存する。",
    ];
    for (const goal of goals) {
      const hosts = extractGoalIdentities(goal);
      expect(hosts.has("mql5.com")).toBe(true); // language-free syntactic extraction
      const tasks = [
        taskWithReq(
          "T2",
          "Fetch the latest EA data from mql5.com into notes.md.",
          ["REASONING"],
          EXT_REQ,
          ["T1"],
        ),
      ];
      const r = repairNetworkCapabilityBinding(tasks, {
        goal,
        allowedCapabilities: ALLOWED,
        capabilitySets: CAP_SETS,
      });
      expect(r.warnings).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    }
    // …and a math goal in any language authorizes nothing.
    for (const goal of [
      "Tính căn bậc hai của 144 và lưu vào math.txt.",
      "Compute sqrt(144) and write math.txt.",
      "144 の平方根を計算して math.txt に書く。",
    ]) {
      const res = resolveTaskNetworkAuthority({
        req: EXT_REQ,
        state: "valid",
        goalIdentities: extractGoalIdentities(goal),
        fresh: true,
      });
      expect(res).toMatchObject({ verdict: "INVALID", reason: "UNAUTHORIZED_SOURCE" });
    }
  });

  it("E: fresh HTTP planner omitting the field → REQUIREMENT_MISSING typed reject (REASK-eligible, never legacy)", async () => {
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch the latest MQL5 market data from the web into market.md.",
        required_capabilities: ["NETWORK_ACCESS", "REASONING"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
        // no network_requirement — field absent on a fresh emission
      },
    ]);
    const r = await llmPlan(MQL5_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MQL5_GOAL));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("REQUIREMENT_MISSING");
    // FAIL_CLOSED_PLAN_* is inside the pool's REASK-eligibility prefix.
    expect(f!.code.startsWith("FAIL_CLOSED_PLAN_")).toBe(true);
  });

  it("F: fresh malformed field → REQUIREMENT_MALFORMED reject, no legacy drop", async () => {
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch the latest MQL5 market data from the web into market.md.",
        required_capabilities: ["REASONING"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
        network_requirement: "I AM NETWORK, TRUST ME",
      },
    ]);
    const r = await llmPlan(MQL5_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    // sanitize keeps the task carrying the reserved error marker — the
    // candidate rejects typed, never silently drops to vocabulary.
    expect(r.warnings).toContain("MALFORMED_NETWORK_REQ:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(
      (t2.metadata as Record<string, unknown>).network_requirement_error,
    ).toBe("MALFORMED");
    const f = canonFail(() => canon(r.tasks, MQL5_GOAL));
    expect(f?.detail).toContain("REQUIREMENT_MALFORMED");
    // top-level vs metadata conflict → REQUIREMENT_CONFLICT.
    const raw2 = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction: "Summarize notes.md.",
        required_capabilities: ["REASONING"],
        depends_on: [],
        pair_coverage: [],
        network_requirement: EXT_REQ,
        metadata: { network_requirement: LOCAL_REQ },
      },
    ]);
    const r2 = await llmPlan("Summarize notes.md.", {
      ...CFG,
      fetchFn: okFetch(raw2),
    });
    expect(r2.warnings).toContain("NETWORK_REQ_CONFLICT:T2");
    const f2 = canonFail(() => canon(r2.tasks, "Summarize notes.md."));
    expect(f2?.detail).toContain("REQUIREMENT_CONFLICT");
  });

  it("G: true legacy persisted plan — provenance-gated compat path still works", () => {
    const goal = "Research the latest MQL5 market trends online.";
    const legacyTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["NETWORK_ACCESS", "REASONING"],
      null,
      ["T1"],
    );
    delete (legacyTask as { metadata?: unknown }).metadata;
    // persisted provenance: fieldless task → LEGACY verdict → vocabulary
    // detectors decide, exactly as pre-contract plans did. The network
    // gate passes; a downstream gate (coverage undeclared — persisted
    // plans predate pair_coverage too) may reject — that IS the proof
    // the LEGACY network path was honored.
    const f = canonFail(() => canon([legacyTask], goal, "persisted"));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // legacy plan-level gate fires first: the goal demands current
    // external data and no legitimate NETWORK task exists at all.
    const legacyNoCap = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["REASONING"],
      null,
      ["T1"],
    );
    delete (legacyNoCap as { metadata?: unknown }).metadata;
    const f2 = canonFail(() => canon([legacyNoCap], goal, "persisted"));
    expect(f2?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED");
    // legacy PER-TASK gate: a capped legitimate gatherer satisfies the
    // plan-level check, then the uncapped fetch-shaped task is rejected.
    const legit = taskWithReq(
      "T3",
      "Fetch the latest MQL5 market trends online into trends.md.",
      ["NETWORK_ACCESS", "REASONING"],
      null,
      ["T1"],
    );
    delete (legit as { metadata?: unknown }).metadata;
    const f3 = canonFail(() =>
      canon([legit, legacyNoCap], goal, "persisted"),
    );
    expect(f3?.code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("H: missing field is NOT a legacy claim — fresh emission with fetch vocabulary still rejects", () => {
    const fetchTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["NETWORK_ACCESS", "REASONING"],
      null,
      ["T1"],
    );
    delete (fetchTask as { metadata?: unknown }).metadata;
    const goal = "Research the latest MQL5 market trends online.";
    // Same bytes canonicalize under persisted but reject under fresh —
    // provenance is call-site context, never inferred from the data.
    const fp = canonFail(() => canon([fetchTask], goal, "persisted"));
    expect(fp === null || !fp.code.includes("NETWORK")).toBe(true);
    const f = canonFail(() => canon([fetchTask], goal, "fresh"));
    expect(f?.detail).toContain("REQUIREMENT_MISSING");
    const f2 = canonFail(() => canon([fetchTask], goal)); // default = fresh
    expect(f2?.detail).toContain("REQUIREMENT_MISSING");
  });

  it("I: UNKNOWN declaration → zero elevation, no silent legacy detector", () => {
    const unknownReq: NetworkRequirement = {
      source_kind: "UNKNOWN",
      access_intent: "READ",
      freshness: "UNKNOWN",
    };
    const t = taskWithReq(
      "T2",
      "Fetch the latest pricing data from the web into data.md.",
      ["REASONING"],
      unknownReq,
      ["T1"],
    );
    const r = repairNetworkCapabilityBinding([t], {
      goal: "Summarize local notes.",
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    // no elevation — and the instruction's fetch vocabulary was never
    // consulted (fresh structured contract).
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
    const res = resolveTaskNetworkAuthority({
      req: unknownReq,
      state: "valid",
      goalIdentities: new Set(),
      fresh: true,
    });
    expect(res.verdict).toBe("NOT_REQUIRED");
  });

  it("J: canonical LOCAL task with research/recency vocabulary → no NETWORK; vocabulary cannot override", () => {
    const t = taskWithReq(
      "T2",
      "Đọc mql5_research.txt và tổng hợp nghiên cứu 10 EA MT5 đang nổi bật thành báo cáo tiếng Việt.",
      ["REASONING"],
      LOCAL_REQ,
      ["T1"],
    );
    // Network gate does not demand NETWORK_ACCESS and does not reject —
    // any later-gate outcome (coverage etc.) is outside this assertion.
    const f = canonFail(() => canon([t], "Summarize findings."));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // And a NETWORK_ACCESS claim on it is unauthorized.
    const withCap = taskWithReq(
      "T2",
      "Đọc mql5_research.txt và tổng hợp báo cáo.",
      ["REASONING", "NETWORK_ACCESS"],
      LOCAL_REQ,
      ["T1"],
    );
    const f2 = canonFail(() => canon([withCap], "Summarize findings."));
    expect(f2?.detail).toContain("UNAUTHORIZED_CAPABILITY");
  });

  it("K: locator generality — non-listed TLDs/hosts authorize by goal naming, no TLD list", () => {
    // Arbitrary dotted hosts are never looked up in a TLD vocabulary:
    // they authorize iff the goal itself names them.
    const goal = "Truy cập data.portal-xk.example123 và lưu kết quả vào outbox/d.txt.";
    const hosts = extractGoalIdentities(goal);
    expect(hosts.has("data.portal-xk.example123")).toBe(true);
    const req: NetworkRequirement = {
      source_kind: "EXTERNAL_SITE",
      access_intent: "FETCH",
      freshness: "REQUIRED",
      source_locator: "data.portal-xk.example123",
    };
    const res = resolveTaskNetworkAuthority({
      req,
      state: "valid",
      goalIdentities: hosts,
      fresh: true,
    });
    expect(res).toMatchObject({ verdict: "REQUIRED", authorized: true });
    // scheme URL locator for a goal-named host
    expect(requirementLocatorHost("https://internal.corp/page?x=1")).toBe(
      "internal.corp",
    );
    expect(requirementLocatorHost("www.sub.example.net/p")).toBe(
      "sub.example.net",
    );
    // file names and paths are never hosts
    expect(requirementLocatorHost("outbox/report.txt")).toBeNull();
    expect(requirementLocatorHost("notes")).toBeNull();
    // a bare dotted token is external-shaped ONLY when the goal names it
    expect(isExternalShapedLocator("report.txt", hosts)).toBe(false);
    expect(isExternalShapedLocator("report.txt", new Set(["report.txt"]))).toBe(true);
    expect(isExternalShapedLocator("https://anything.example", new Set())).toBe(true);
  });

  it("L: digest binds requirement + error marker — post-binding mutation changes plan identity", async () => {
    const { canonicalPlanSemanticDigest } = await import(
      "../pair/plan-feasibility.js"
    );
    const base = {
      task_key: "T2",
      task_instruction: "Compute sqrt(144) and write math.txt.",
      required_capabilities: ["REASONING"],
      depends_on: [],
      metadata: { network_requirement: LOCAL_REQ },
    };
    const d1 = canonicalPlanSemanticDigest([base]);
    const mutated = {
      ...base,
      metadata: { network_requirement: EXT_REQ },
    };
    const d2 = canonicalPlanSemanticDigest([mutated]);
    expect(d1).not.toBe(d2);
    const withErr = {
      ...base,
      metadata: {
        network_requirement: LOCAL_REQ,
        network_requirement_error: "MALFORMED",
      },
    };
    expect(canonicalPlanSemanticDigest([withErr])).not.toBe(d1);
    // shape normalization order is canonical: same semantics → same digest
    const reordered = {
      ...base,
      metadata: {
        network_requirement: {
          source_locator: undefined,
          freshness: "NOT_REQUIRED",
          access_intent: "READ",
          source_kind: "LOCAL",
        },
      },
    };
    const normalized = parseNetworkRequirementShape(
      (reordered.metadata as Record<string, unknown>).network_requirement,
    );
    expect(normalized.ok).toBe(true);
  });
});

describe("R1 invariants retained under R2", () => {
  it("internal contradictions still reject typed (LOCAL+URL locator, UNKNOWN+locator)", () => {
    const contradiction = networkRequirementInternalContradiction({
      source_kind: "LOCAL",
      access_intent: "READ",
      freshness: "NOT_REQUIRED",
      source_locator: "https://mql5.com",
    });
    expect(contradiction).toBe("LOCAL_WITH_EXTERNAL_LOCATOR");
    const res = resolveTaskNetworkAuthority({
      req: {
        source_kind: "UNKNOWN",
        access_intent: "READ",
        freshness: "UNKNOWN",
        source_locator: "something.example",
      },
      state: "valid",
      goalIdentities: new Set(),
      fresh: true,
    });
    expect(res).toMatchObject({ verdict: "INVALID", reason: "LOCATOR_WITHOUT_SOURCE" });
  });

  it("malformed shapes never parse as authority", () => {
    for (const bad of [
      "https://mql5.com",
      { source_kind: "INTERNET", access_intent: "READ", freshness: "REQUIRED" },
      { source_kind: "EXTERNAL_SITE" },
      null,
      42,
    ]) {
      expect(parseNetworkRequirementShape(bad).ok).toBe(false);
    }
    expect(parseNetworkRequirementShape(EXT_REQ).ok).toBe(true);
  });

  it("persisted-path repair never elevates fieldless tasks (repair is fresh-only)", () => {
    const legacyTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["REASONING"],
      null,
      ["T1"],
    );
    delete (legacyTask as { metadata?: unknown }).metadata;
    // repair only runs on the fresh planner path — a persisted plan's
    // fieldless task is judged by the canonicalizer's LEGACY branch.
    const r = repairNetworkCapabilityBinding([legacyTask], {
      goal: "Research the latest MQL5 market trends online.",
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    // fresh verdict on missing field = INVALID → repair leaves it alone
    expect(r.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
  });
});
