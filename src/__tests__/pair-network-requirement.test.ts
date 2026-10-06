/**
 * R2 — NETWORK-requirement authority hardening (audit remediation).
 *  (R3 removed the entity-identity channel — this file now exercises the
 *  explicit-host-only authorization surface; R3 adversarial cases live
 *  in pair-network-requirement-r3.test.ts.)
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
import {
  goalRequiresCurrentExternalData,
  llmPlan,
  repairNetworkCapabilityBinding,
  taskRequiresNetworkAccess,
} from "../pair/llm-planner.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import { extractGoalContract } from "../pair/goal-contract.js";
import {
  extractGoalHosts,
  isExternalShapedLocator,
  networkRequirementInternalContradiction,
  parseNetworkRequirementShape,
  requirementLocatorHost,
  resolveFreshTaskNetworkAuthority,
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
  it("A: forged EXTERNAL on a math goal can neither bootstrap NETWORK nor kill a valid task (full production path)", async () => {
    // Planner emits a forged structured requirement for a source the
    // operator goal never named — under the simplified contract the
    // annotation is advisory: it mints nothing and kills nothing.
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
    // Cannot GRANT: no repair, no NETWORK_ACCESS minted from text alone.
    expect(r.warnings).not.toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    expect(t2.required_capabilities).not.toContain("NETWORK_ACCESS");
    // Cannot DENY: the quiet task stays NOT_REQUIRED — no NETWORK gate
    // may reject it on annotation grounds.
    const f = canonFail(() => canon(r.tasks, MATH_GOAL));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // The persisted/legacy path is untouched: the same annotation shape
    // still rejects under pre-simplification provenance.
    const legacy = resolveTaskNetworkAuthority({
      req: EXT_REQ,
      state: "valid",
      goalHosts: extractGoalHosts(MATH_GOAL),
      instructionRequiresNetwork: false,
      goalRequiresExternalData: false,
      instructionMatchesGoalSubject: false,
      instruction: "Compute the square root of 144 and write math.txt.",
      fresh: false,
    });
    expect(legacy.verdict).toBe("INVALID");
    expect(legacy.reason).toBe("UNAUTHORIZED_SOURCE");
  });

  it("B: forged EXTERNAL WITH a NETWORK_ACCESS claim is advisory — the annotation can neither convict nor authorize", async () => {
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
    // A planner NETWORK_ACCESS claim + forged annotation on a quiet task
    // is advisory routing metadata: it can neither authorize network nor
    // convict the task — no NETWORK gate may fire on the fresh path.
    const f = canonFail(() => canon(r.tasks, MATH_GOAL));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // And the claim itself is never auto-elevated to authority either:
    // PAIR's own verdict decides network binding.
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
    expect(f2 === null || !f2.code.includes("NETWORK")).toBe(true);
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
      const hosts = extractGoalHosts(goal);
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
    // …and a math goal in any language: a forged locator is ignored
    // identically — the quiet instruction yields NOT_REQUIRED in every
    // language (the annotation can neither grant nor deny, so nothing
    // is left to authorize or reject on its text).
    for (const goal of [
      "Tính căn bậc hai của 144 và lưu vào math.txt.",
      "Compute sqrt(144) and write math.txt.",
      "144 の平方根を計算して math.txt に書く。",
    ]) {
      const res = resolveFreshTaskNetworkAuthority({
        req: EXT_REQ,
        state: "valid",
        goalHosts: extractGoalHosts(goal),
        instructionRequiresNetwork: false,
        goalRequiresExternalData: goalRequiresCurrentExternalData(goal),
        instructionMatchesGoalSubject: false,
        instruction: "Compute sqrt(144) and write math.txt.",
      });
      expect(res).toMatchObject({ verdict: "NOT_REQUIRED" });
    }
    // …but an INSTRUCTION-named host the goal never authorized is still
    // rejected in every language — the annotation wasn't needed for it.
    const denied = resolveFreshTaskNetworkAuthority({
      req: null,
      state: "missing",
      goalHosts: new Set(["mql5.com"]),
      instructionRequiresNetwork: true,
      goalRequiresExternalData: true,
      instructionMatchesGoalSubject: false,
      instruction: "Fetch https://btc.example/x into n.md.",
    });
    expect(denied).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
  });

  it("E: fresh HTTP planner omitting the field → PAIR derives the requirement itself (advisory contract)", async () => {
    // PLANNER-CONTRACT SIMPLIFICATION: the structured field is optional
    // advisory evidence — a missing field on a fresh emission can never
    // kill a semantically-correct plan. PAIR derives REQUIRED from the
    // fetch-shaped instruction + the goal's own external-data demand.
    const raw = planJson([
      {
        task_key: "T2",
        title: "T2",
        task_instruction:
          "Fetch the latest MQL5 market data from the web into market.md.",
        required_capabilities: ["NETWORK_ACCESS", "REASONING"],
        depends_on: [],
        pair_coverage: ["OBL_001"],
        // no network_requirement — optional under the new contract
      },
    ]);
    const r = await llmPlan(MQL5_GOAL, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MQL5_GOAL));
    // No network-authority rejection (a later gate may still judge).
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("F: fresh malformed/conflict field → degrades to no evidence, PAIR derives authority", async () => {
    // PLANNER-CONTRACT SIMPLIFICATION: a malformed advisory field degrades
    // to 'no structured evidence' — PAIR still derives REQUIRED from the
    // fetch-shaped instruction and binds NETWORK_ACCESS itself.
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
    // sanitize keeps the task carrying the reserved error marker —
    // evidence the defect existed, but no longer a kill.
    expect(r.warnings).toContain("MALFORMED_NETWORK_REQ:T2");
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(
      (t2.metadata as Record<string, unknown>).network_requirement_error,
    ).toBe("MALFORMED");
    // PAIR-owned binding: instruction-derived REQUIRED + authorized →
    // repair binds the capability; the canonical gate does not reject.
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    expect(t2.required_capabilities).toContain("NETWORK_ACCESS");
    const f = canonFail(() => canon(r.tasks, MQL5_GOAL));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    // top-level vs metadata conflict → same degradation: the conflict
    // marker is kept as evidence, then PAIR decides from the
    // instruction (local summarize → NOT_REQUIRED → no network reject).
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
    expect(f2 === null || !f2.code.includes("NETWORK")).toBe(true);
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

  it("H: missing field on fresh emission — PAIR derives REQUIRED from the instruction (same verdict as persisted)", () => {
    const fetchTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["NETWORK_ACCESS", "REASONING"],
      null,
      ["T1"],
    );
    delete (fetchTask as { metadata?: unknown }).metadata;
    const goal = "Research the latest MQL5 market trends online.";
    // Same bytes canonicalize under persisted (LEGACY detectors) AND
    // fresh (PAIR-derived REQUIRED from the fetch-shaped instruction +
    // the goal's own external-data demand) — a missing advisory field
    // can no longer kill a semantically correct plan.
    const fp = canonFail(() => canon([fetchTask], goal, "persisted"));
    expect(fp === null || !fp.code.includes("NETWORK")).toBe(true);
    const f = canonFail(() => canon([fetchTask], goal, "fresh"));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
    const f2 = canonFail(() => canon([fetchTask], goal)); // default = fresh
    expect(f2 === null || !f2.code.includes("NETWORK")).toBe(true);
  });

  it("I: UNKNOWN declaration degrades to no evidence — instruction decides; a fetch task under a non-authorizing goal fails closed", () => {
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
    // UNKNOWN carries no requirement — but the instruction demands a
    // fetch while the goal authorizes nothing → INVALID (the ONLY fresh
    // rejection class), never silently bound and never silently dropped.
    const res = resolveFreshTaskNetworkAuthority({
      req: unknownReq,
      state: "valid",
      goalHosts: new Set(),
      instructionRequiresNetwork: taskRequiresNetworkAccess(
        "Fetch the latest pricing data from the web into data.md.",
      ),
      goalRequiresExternalData: goalRequiresCurrentExternalData(
        "Summarize local notes.",
      ),
      instructionMatchesGoalSubject: false,
      instruction: "Fetch the latest pricing data from the web into data.md.",
    });
    expect(res).toMatchObject({ verdict: "INVALID", reason: "UNAUTHORIZED_SOURCE" });
    const r = repairNetworkCapabilityBinding([t], {
      goal: "Summarize local notes.",
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
    // and the canonical gate rejects it typed.
    const f = canonFail(() => canon([t], "Summarize local notes.", "fresh"));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
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
    // PLANNER-CONTRACT SIMPLIFICATION: a NETWORK_ACCESS claim on a
    // NOT_REQUIRED task is advisory routing metadata, not a rejection.
    const withCap = taskWithReq(
      "T2",
      "Đọc mql5_research.txt và tổng hợp báo cáo.",
      ["REASONING", "NETWORK_ACCESS"],
      LOCAL_REQ,
      ["T1"],
    );
    const f2 = canonFail(() => canon([withCap], "Summarize findings."));
    expect(f2 === null || !f2.code.includes("NETWORK")).toBe(true);
  });

  it("K: locator generality — non-listed TLDs/hosts authorize by goal naming, no TLD list", () => {
    // Arbitrary dotted hosts are never looked up in a TLD vocabulary:
    // they authorize iff the goal itself names them.
    const goal = "Truy cập data.portal-xk.example123 và lưu kết quả vào outbox/d.txt.";
    const hosts = extractGoalHosts(goal);
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
      goalHosts: hosts,
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
    // and a goal-named host authorizes its label-boundary subdomains
    expect(isExternalShapedLocator("api.report.example", new Set(["report.example"]))).toBe(true);
    expect(isExternalShapedLocator("report.example.attacker.org", new Set(["report.example"]))).toBe(false);
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
      goalHosts: new Set(),
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

  it("fieldless fresh emission — PAIR-owned binding elevates via instruction evidence alone", () => {
    const legacyTask = taskWithReq(
      "T2",
      "Fetch the latest MQL5 market data from the web into market.md.",
      ["REASONING"],
      null,
      ["T1"],
    );
    delete (legacyTask as { metadata?: unknown }).metadata;
    // PLANNER-CONTRACT SIMPLIFICATION: a missing advisory field is no
    // longer a repair blocker — PAIR derives REQUIRED from the
    // fetch-shaped instruction + the goal's external-data demand and
    // binds the capability itself (servable executor policy decides).
    const r = repairNetworkCapabilityBinding([legacyTask], {
      goal: "Research the latest MQL5 market trends online.",
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    expect(r.tasks[0].required_capabilities).toContain("NETWORK_ACCESS");
  });
});
