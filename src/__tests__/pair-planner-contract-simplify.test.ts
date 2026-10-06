/**
 * PLANNER-CONTRACT SIMPLIFICATION — adversarial proofs per mandate §E.
 *
 *  The planner's model-facing contract narrowed to task_key /
 *  task_instruction / depends_on / required_capabilities (semantic role
 *  only). `network_requirement` and `pair_coverage` are OPTIONAL advisory
 *  hints PAIR owns end-to-end: PAIR derives each task's network verdict
 *  (resolveFreshTaskNetworkAuthority) and derives coverage existentially
 *  (assertPlanCoverage) — planner bookkeeping can never kill a
 *  semantically-correct plan, and can never grant authority.
 *
 *  E1 — the aquascope live incident: zero pair_coverage / zero
 *       network_requirement on the whole plan, still canonicalizes;
 *       Goal Contract obligations + deliverable + telegram intent all
 *       still proven and governed.
 *  E2 — legacy emission shapes (EXTERNAL+null locator, LOCAL+filename
 *       locator, LOCAL+directory locator, UNKNOWN+REQUIRED) degrade to
 *       "no structured evidence" — never a fresh-path kill.
 *  E3 — security/adversarial invariants: planner text cannot enable
 *       network on a denying executor policy, cannot mint Telegram
 *       authority, fabricated coverage cannot satisfy a deliverable,
 *       missing producer / malformed DAG still fail closed.
 */
import { describe, expect, it } from "vitest";
import {
  llmPlan,
  repairNetworkCapabilityBinding,
  goalRequiresCurrentExternalData,
  taskRequiresNetworkAccess,
  instructionSatisfiesGoalSubject,
} from "../pair/llm-planner.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
} from "../pair/serve-planner.js";
import { extractGoalContract } from "../pair/goal-contract.js";
import { assertPlanDataflow } from "../pair/plan-dataflow.js";
import {
  extractGoalHosts,
  resolveFreshTaskNetworkAuthority,
  resolveTaskNetworkAuthority,
  type NetworkRequirement,
} from "../pair/network-requirement.js";
import { IntegrityError } from "../pair/errors.js";

/** Every executor set — full vocabulary, one capable set. */
const CAP_SETS = [
  ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS", "CODE_GENERATION", "TELEGRAM_DELIVERY"],
];
/** A policy where NO executor holds NETWORK_ACCESS — ambient deny. */
const NO_NET_SETS = [["REASONING", "FILE_OPERATIONS", "CODE_GENERATION", "TELEGRAM_DELIVERY"]];
const ALLOWED = SERVE_LLM_PLANNER_CAPS.slice();

const canon = (
  raw: Array<Record<string, unknown>>,
  goal: string,
  capSets: string[][] = CAP_SETS,
  provenance?: "fresh" | "persisted",
) =>
  makeServeCanonicalizer({ executorCapSets: () => capSets })(
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

const canonFail = (fn: () => unknown): { code: string; detail: string } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof IntegrityError) return { code: e.code ?? "?", detail: e.message };
    return { code: "NON_INTEGRITY", detail: String(e) };
  }
};

/** A bare task the NEW contract asks of the model — no metadata fields
 *  beyond the semantic core. */
const bare = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
});

/** The production incident goal, verbatim (2026-10-06 aquascope death). */
const AQUASCOPE_GOAL =
  "Truy cập github.com và xem repository cognitive-engineering-lab/aquascope: đọc README, đếm số star và số issue đang mở, tóm tắt mục đích dự án bằng tiếng Việt. Lưu vào outbox/aquascope_review.txt. Sau khi hoàn thành, gửi file đó tới Telegram.";

describe("E1 — aquascope incident: metadata-free plan canonicalizes", () => {
  const AQUA_PLAN = [
    bare(
      "T1",
      "Truy cập https://github.com/cognitive-engineering-lab/aquascope, đọc README, đếm số star và số issue đang mở, ghi kết quả vào aquascope_source.txt.",
      ["REASONING"], // no NETWORK_ACCESS claim — PAIR binds it
    ),
    bare(
      "T2",
      "Đọc aquascope_source.txt và viết tóm tắt tiếng Việt về mục đích dự án vào outbox/aquascope_review.txt.",
      ["REASONING", "FILE_OPERATIONS"],
      ["T1"],
    ),
    bare(
      "T3",
      "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
      ["TELEGRAM_DELIVERY"],
      ["T2"],
    ),
  ];

  it("zero pair_coverage + zero network_requirement anywhere → plan still pins", () => {
    const contract = extractGoalContract(AQUASCOPE_GOAL);
    expect(contract.obligations.length).toBeGreaterThan(0);
    expect(contract.deliverables.length).toBe(1); // outbox/aquascope_review.txt
    expect(contract.delivery_intent.requested).toBe(true);
    // Production order: PAIR's binding repair runs between the planner's
    // raw emission and canonicalization — the model never names
    // NETWORK_ACCESS, PAIR derives + binds it.
    const repaired = repairNetworkCapabilityBinding(AQUA_PLAN, {
      goal: AQUASCOPE_GOAL,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(repaired.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T1");
    // The exact death mode — candidate dies on placement bookkeeping —
    // is gone: existential coverage + derived network authority carry it.
    const out = canon(repaired.tasks, AQUASCOPE_GOAL);
    expect(out.length).toBe(4); // + PAIR bookkeeping
    // PAIR derived + bound NETWORK_ACCESS onto the fetch task itself.
    const fetchT = out.find((t) =>
      String(t.task_instruction).includes("github.com"),
    )!;
    expect(fetchT.required_capabilities).toContain("NETWORK_ACCESS");
  });

  it("same plan through the HTTP sanitize path: identical outcome", async () => {
    const r = await llmPlan(AQUASCOPE_GOAL, {
      ...CFG,
      fetchFn: okFetch(planJson(AQUA_PLAN)),
    });
    const out = canon(r.tasks, AQUASCOPE_GOAL);
    expect(out.length).toBe(4);
  });
});

describe("E2 — legacy emission shapes degrade to 'no evidence', never kill", () => {
  const MQL5 = "Truy cập mql5.com và nghiên cứu EA đang nổi bật, lưu vào outbox/r.txt.";
  const fetchInstr =
    "Fetch the latest MQL5 EA data into ea_data.md.";

  it("EXTERNAL + null locator (the production gold-mission death shape)", async () => {
    const raw = planJson([
      {
        ...bare("T1", fetchInstr, ["REASONING"]),
        network_requirement: {
          source_kind: "EXTERNAL_SITE",
          access_intent: "RESEARCH",
          freshness: "REQUIRED",
          source_locator: null,
        },
      },
      bare("T2", "Viết tóm tắt vào outbox/r.txt.", ["FILE_OPERATIONS"], ["T1"]),
    ]);
    const r = await llmPlan(MQL5, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MQL5));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("LOCAL + filename locator (gold_inputs.json) — ambiguous token, not a host", async () => {
    const raw = planJson([
      {
        ...bare("T1", "Đọc gold_inputs.json và tổng hợp dữ liệu.", ["FILE_OPERATIONS"]),
        network_requirement: {
          source_kind: "LOCAL",
          access_intent: "READ",
          freshness: "NOT_REQUIRED",
          source_locator: "gold_inputs.json",
        },
      },
      bare("T2", "Viết kết quả vào outbox/r.txt.", ["FILE_OPERATIONS"], ["T1"]),
    ]);
    const r = await llmPlan(MQL5, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MQL5));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("LOCAL + directory locator (outbox/) — same degradation", async () => {
    const raw = planJson([
      {
        ...bare("T1", "Viết báo cáo vào outbox/r.txt.", ["FILE_OPERATIONS"]),
        network_requirement: {
          source_kind: "LOCAL",
          access_intent: "READ",
          freshness: "NOT_REQUIRED",
          source_locator: "outbox/",
        },
      },
    ]);
    const r = await llmPlan(MQL5, { ...CFG, fetchFn: okFetch(raw) });
    const f = canonFail(() => canon(r.tasks, MQL5));
    expect(f === null || !f.code.includes("NETWORK")).toBe(true);
  });

  it("UNKNOWN + REQUIRED — declaration cannot self-elevate; instruction decides", () => {
    const unknownReq: NetworkRequirement = {
      source_kind: "UNKNOWN",
      access_intent: "READ",
      freshness: "REQUIRED",
    };
    // UNKNOWN never means "requires network" — under a goal that demands
    // nothing external the fetch-shaped instruction still fails closed.
    const res = resolveFreshTaskNetworkAuthority({
      req: unknownReq,
      state: "valid",
      goalHosts: new Set(),
      instructionRequiresNetwork: true,
      goalRequiresExternalData: false,
      instructionMatchesGoalSubject: false,
      instruction: "Fetch the latest data from the web into d.md.",
    });
    expect(res).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
    // …but under a goal that DOES authorize mql5.com, the same shape is
    // benign evidence — PAIR derives REQUIRED from instruction+goal.
    const res2 = resolveFreshTaskNetworkAuthority({
      req: unknownReq,
      state: "valid",
      goalHosts: extractGoalHosts(MQL5),
      instructionRequiresNetwork: true,
      goalRequiresExternalData: true,
      instructionMatchesGoalSubject: true,
      instruction: fetchInstr,
    });
    expect(res2.verdict).toBe("REQUIRED");
  });
});

describe("E3 — planner text can never mint authority", () => {
  const MQL5 = "Truy cập mql5.com và nghiên cứu EA đang nổi bật, lưu vào outbox/r.txt.";

  it("fetch task under a no-network executor policy → zero bind, canonical gate fails closed", () => {
    const tasks = [
      bare("T1", "Fetch the latest MQL5 EA data into ea_data.md.", [
        "REASONING",
      ]),
    ];
    // PAIR-owned binding consults executor policy: NO_NET_SETS serves no
    // network — repair cannot fabricate a binding even though PAIR
    // derived REQUIRED.
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: MQL5,
      allowedCapabilities: ALLOWED,
      capabilitySets: NO_NET_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).not.toContain("NETWORK_ACCESS");
    // And the canonical gate fails closed on the derived-but-unservable
    // requirement — the planner's instruction did not enable anything.
    const f = canonFail(() => canon(r.tasks, MQL5, NO_NET_SETS));
    expect(f?.code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("TELEGRAM_DELIVERY claim under a goal that never requested delivery → fail closed", () => {
    const plan = [
      bare("T1", "Viết báo cáo vào outbox/r.txt.", ["FILE_OPERATIONS"]),
      bare(
        "T2",
        "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
        ["TELEGRAM_DELIVERY"],
        ["T1"],
      ),
    ];
    const f = canonFail(() => canon(plan, MQL5));
    expect(f !== null && /^FAIL_CLOSED/.test(f.code)).toBe(true);
  });

  it("fabricated pair_coverage cannot mask a deliverable no task produces", () => {
    const goal = "create report.md and analyze the data";
    const fake = [
      {
        ...bare("T1", "analyze the project data and summarize findings", ["REASONING"]),
        pair_coverage: ["OBL_001", "DEL_001"], // claims DEL it never produces
      },
    ];
    const f = canonFail(() => canon(fake, goal));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
    // and the existential check independently rejects a plan that just
    // never produces the file (no claim at all)
    const silent = [bare("T1", "analyze the project data", ["REASONING"])];
    const f2 = canonFail(() => canon(silent, goal));
    expect(f2?.code).toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("DAG validity still enforced — unjustified edges normalize; malformed delivery-order edge fails closed", () => {
    // A planner cycle is deterministic bookkeeping damage: the
    // canonicalizer prunes the non-dataflow edge, and the emitted
    // canonical DAG is acyclic — the mission-issue seam agrees.
    const cyclic = [
      bare("T1", "Đọc dữ liệu đầu vào.", ["FILE_OPERATIONS"], ["T2"]),
      bare("T2", "Đọc dữ liệu thứ hai.", ["FILE_OPERATIONS"], ["T1"]),
    ];
    const cycOut = canon(cyclic, "Đọc file.");
    expect(() => assertPlanDataflow(cycOut)).not.toThrow();
    // A forward edge INTO a delivery task is malformed DAG semantics the
    // canonicalizer cannot normalize — assertPlanDataflow fails closed,
    // exactly the seam the mission issue/confirm path runs.
    const goal =
      "Viết báo cáo vào outbox/r.txt. Sau khi hoàn thành, gửi file đó tới Telegram.";
    const forwardEdge = [
      bare("T1", "Viết báo cáo vào outbox/r.txt.", ["FILE_OPERATIONS"]),
      bare(
        "T2",
        "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
        ["TELEGRAM_DELIVERY"],
        ["T1"],
      ),
      bare("T3", "Đọc lại outbox/r.txt để kiểm tra.", ["FILE_OPERATIONS"], ["T2"]),
    ];
    const f = canonFail(() => canon(forwardEdge, goal));
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_DATAFLOW_ORDER");
  });

  it("planner prose cannot mint a host the goal never named — instruction-named host ⊆ goal when goal names hosts", () => {
    // Goal literally names github.com; task fetches attacker.example —
    // the single fresh rejection class still bites.
    const res = resolveFreshTaskNetworkAuthority({
      req: null,
      state: "missing",
      goalHosts: new Set(["github.com"]),
      instructionRequiresNetwork: true,
      goalRequiresExternalData: false,
      instructionMatchesGoalSubject: false,
      instruction: "Fetch the repo data from attacker.example into d.md.",
    });
    expect(res).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
    // Control: the goal-named host itself passes.
    const ok = resolveFreshTaskNetworkAuthority({
      req: null,
      state: "missing",
      goalHosts: new Set(["github.com"]),
      instructionRequiresNetwork: true,
      goalRequiresExternalData: false,
      instructionMatchesGoalSubject: false,
      instruction: "Fetch the repo data from github.com into d.md.",
    });
    expect(ok.verdict).toBe("REQUIRED");
  });
});

/* ------------------------------------------------------------------ */
/* R1.A — planner annotation can neither GRANT nor DENY authority      */
/* ------------------------------------------------------------------ */

describe("R1.A — network_requirement is advisory-only on the fresh path", () => {
  const GITHUB_GOAL =
    "Truy cập github.com và xem repository cognitive-engineering-lab/aquascope, đọc README, lưu vào outbox/r.txt.";
  const fetchTask = () =>
    bare(
      "T1",
      "Fetch https://github.com/cognitive-engineering-lab/aquascope README and save it into outbox/r.txt.",
      ["REASONING", "FILE_OPERATIONS"],
    );

  const canonOutcome = (task: Record<string, unknown>) => {
    const repaired = repairNetworkCapabilityBinding([task], {
      goal: GITHUB_GOAL,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    return { repaired, out: canon(repaired.tasks, GITHUB_GOAL) };
  };

  it("A1: semantic task + NO annotation → REQUIRED, PAIR binds, plan pins", () => {
    const { repaired, out } = canonOutcome(fetchTask());
    expect(repaired.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T1");
    const t = out.find((x) =>
      String(x.task_instruction).includes("github.com"),
    )!;
    expect(t.required_capabilities).toContain("NETWORK_ACCESS");
  });

  it("A2: same task + WRONG source_locator annotation → identical outcome (annotation cannot deny)", () => {
    const t = fetchTask();
    t.metadata = {
      network_requirement: {
        source_kind: "EXTERNAL_SITE",
        access_intent: "RESEARCH",
        freshness: "REQUIRED",
        source_locator: "attacker.example",
      },
    };
    const base = canonOutcome(fetchTask());
    const bad = canonOutcome(t);
    expect(bad.repaired.warnings).toEqual(base.repaired.warnings);
    expect(
      bad.out.find((x) =>
        String(x.task_instruction).includes("github.com"),
      )!.required_capabilities,
    ).toEqual(
      base.out.find((x) =>
        String(x.task_instruction).includes("github.com"),
      )!.required_capabilities,
    );
  });

  it("A3: same task + malformed/conflicting annotation → identical outcome", () => {
    const t = fetchTask();
    t.metadata = {
      network_requirement: {
        source_kind: "LOCAL",
        access_intent: "READ",
        freshness: "NOT_REQUIRED",
        source_locator: "https://attacker.example/x",
      },
    };
    const r = canonOutcome(t);
    expect(r.repaired.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T1");
    expect(
      r.out.find((x) =>
        String(x.task_instruction).includes("github.com"),
      )!.required_capabilities,
    ).toContain("NETWORK_ACCESS");
  });

  it("A4: instruction itself names an unauthorized host → still FAIL UNAUTHORIZED_SOURCE", () => {
    const f = canonFail(() =>
      canon(
        [
          bare(
            "T1",
            "Fetch https://attacker.example/x data into d.md.",
            ["REASONING"],
          ),
        ],
        GITHUB_GOAL,
      ),
    );
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
  });

  it("A5: derived-required task under a no-network executor policy → still fails closed", () => {
    const r = repairNetworkCapabilityBinding([fetchTask()], {
      goal: GITHUB_GOAL,
      allowedCapabilities: ALLOWED,
      capabilitySets: NO_NET_SETS,
    });
    expect(r.warnings).toEqual([]);
    const f = canonFail(() => canon(r.tasks, GITHUB_GOAL, NO_NET_SETS));
    expect(f?.code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("annotation cannot GRANT either — silent instruction + REQUIRED annotation → NOT_REQUIRED", () => {
    const res = resolveFreshTaskNetworkAuthority({
      req: {
        source_kind: "EXTERNAL_SITE",
        access_intent: "RESEARCH",
        freshness: "REQUIRED",
        source_locator: "anything.example",
      },
      state: "valid",
      goalHosts: new Set(["github.com"]),
      instructionRequiresNetwork: false,
      goalRequiresExternalData: false,
      instructionMatchesGoalSubject: false,
      instruction: "Tổng hợp dữ liệu vào file result.txt.",
    });
    expect(res.verdict).toBe("NOT_REQUIRED");
  });
});

/* ------------------------------------------------------------------ */
/* R1.B — VI action tokens are never subject evidence                  */
/* ------------------------------------------------------------------ */

describe("R1.B — coverage subject evidence excludes action tokens", () => {
  const canonPlan = (goal: string, instr: string) => {
    const raw = [
      bare("T1", instr, ["REASONING", "FILE_OPERATIONS"]),
    ];
    // Production path: PAIR's binding repair runs before canon.
    const repaired = repairNetworkCapabilityBinding(raw, {
      goal,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    return canonFail(() => canon(repaired.tasks, goal));
  };

  it("B1: 'tóm tắt mục đích dự án' covered by the matching VI task → PASS", () => {
    const f = canonPlan(
      "Tóm tắt mục đích dự án. Lưu vào outbox/s.txt.",
      "Tóm tắt mục đích dự án bằng tiếng Việt và viết vào outbox/s.txt.",
    );
    expect(f).toBeNull();
  });

  it("B2: same verb class, different subject → 'tóm tắt thời tiết Hà Nội' MUST NOT cover", () => {
    const f = canonPlan(
      "Tóm tắt mục đích dự án. Lưu vào outbox/s.txt.",
      "Tóm tắt thời tiết Hà Nội và viết vào outbox/s.txt.",
    );
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("B3: 'phân tích giá vàng' vs 'phân tích giá bitcoin' → MUST NOT cover (anchor mismatch)", () => {
    const f = canonPlan(
      "Phân tích giá vàng. Lưu vào outbox/g.txt.",
      "Phân tích giá bitcoin và lưu vào outbox/g.txt.",
    );
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("B4: 'phân tích giá vàng' vs 'phân tích giá vàng hiện tại' → COVER", () => {
    const f = canonPlan(
      "Phân tích giá vàng. Lưu vào outbox/g.txt.",
      "Phân tích giá vàng hiện tại và lưu vào outbox/g.txt.",
    );
    expect(f).toBeNull();
  });

  it("B5: aquascope obligation still covered by the production-shaped task", () => {
    const contract = extractGoalContract(AQUASCOPE_GOAL);
    const obl = contract.obligations.find((o) =>
      o.text.includes("mục đích"),
    );
    expect(obl).toBeTruthy();
    const f = canonPlan(
      "Tóm tắt mục đích dự án. Lưu vào outbox/aquascope_review.txt.",
      "Đọc dữ liệu nguồn và viết tóm tắt tiếng Việt về mục đích dự án vào outbox/aquascope_review.txt.",
    );
    expect(f).toBeNull();
  });

  it("EN unchanged: 'summarize the report purpose' covered by matching EN task", () => {
    const f = canonPlan(
      "Summarize the report purpose. Save to outbox/r.txt.",
      "Summarize the report purpose and write it to outbox/r.txt.",
    );
    expect(f).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* R2 — final fresh-network rule: plan-level source selection           */
/* ------------------------------------------------------------------ */

describe("R2 — hostless external goal may select its source; named goal stays least-authority", () => {
  const GOLD_GOAL = "Phân tích giá vàng hôm nay.";
  const GITHUB_GOAL2 =
    "Truy cập github.com và xem repository cognitive-engineering-lab/aquascope.";
  const LOCAL_GOAL = "Summarize local report.txt.";

  /** Resolve the fresh verdict exactly the way the canonical gate does. */
  const verdict = (
    goal: string,
    instruction: string,
    req: Record<string, unknown> | null = null,
    state: "missing" | "valid" | "malformed" | "conflict" = "missing",
  ) =>
    resolveFreshTaskNetworkAuthority({
      req: req as never,
      state,
      goalHosts: extractGoalHosts(goal),
      instructionRequiresNetwork: taskRequiresNetworkAccess(instruction),
      goalRequiresExternalData: goalRequiresCurrentExternalData(goal),
      instructionMatchesGoalSubject: instructionSatisfiesGoalSubject(
        instruction,
        goal,
      ),
      instruction,
    });

  it("R2.1 hostless external goal + concrete chosen host → REQUIRED/PASS", () => {
    const v = verdict(
      GOLD_GOAL,
      "Fetch current gold prices from tradingview.com and write gold.txt.",
    );
    expect(v).toMatchObject({ verdict: "REQUIRED", authorized: true });
  });

  it("R2.2 hostless external goal + 'from the web' → REQUIRED/PASS", () => {
    const v = verdict(
      GOLD_GOAL,
      "Fetch current gold prices from the web and write gold.txt.",
    );
    expect(v).toMatchObject({ verdict: "REQUIRED", authorized: true });
  });

  it("R2.3 goal names github.com, task chooses attacker.example → UNAUTHORIZED_SOURCE", () => {
    const v = verdict(
      GITHUB_GOAL2,
      "Fetch repo data from attacker.example into repo.md.",
    );
    expect(v).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
  });

  it("R2.4 goal names github.com, task uses github.com → REQUIRED/PASS", () => {
    const v = verdict(
      GITHUB_GOAL2,
      "Fetch the repository README from github.com into repo.md.",
    );
    expect(v).toMatchObject({ verdict: "REQUIRED", authorized: true });
  });

  it("R2.5 purely local goal + instruction-invented host → UNAUTHORIZED_SOURCE", () => {
    const v = verdict(
      LOCAL_GOAL,
      "Fetch extra data from attacker.example into extra.txt.",
    );
    expect(v).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
  });

  it("R2.6 hostless external goal + chosen host + NO network executor → no repair, fail closed", () => {
    const goal =
      "Phân tích giá vàng hôm nay và lưu báo cáo vào outbox/gold.txt.";
    const tasks = [
      bare(
        "T1",
        "Fetch current gold prices from tradingview.com and write outbox/gold.txt.",
        ["REASONING", "FILE_OPERATIONS"],
      ),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal,
      allowedCapabilities: ALLOWED,
      capabilitySets: NO_NET_SETS,
    });
    expect(r.warnings).toEqual([]); // no executor can serve → zero bind
    const f = canonFail(() => canon(r.tasks, goal, NO_NET_SETS));
    expect(f?.code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
  });

  it("R2.7 wrong/malformed/conflicting annotation changes no R2 verdict", () => {
    const bad = {
      source_kind: "LOCAL",
      access_intent: "READ",
      freshness: "NOT_REQUIRED",
      source_locator: "attacker.example",
    };
    expect(
      verdict(
        GOLD_GOAL,
        "Fetch current gold prices from tradingview.com into g.txt.",
        bad,
        "conflict",
      ).verdict,
    ).toBe("REQUIRED");
    expect(
      verdict(
        GITHUB_GOAL2,
        "Fetch repo data from attacker.example into r.md.",
        bad,
        "valid",
      ).verdict,
    ).toBe("INVALID");
    expect(
      verdict(
        LOCAL_GOAL,
        "Fetch extra data from attacker.example into e.txt.",
        bad,
        "malformed",
      ).verdict,
    ).toBe("INVALID");
  });

  it("R2.8 persisted provenance keeps legacy semantics unchanged", () => {
    const legacy = resolveTaskNetworkAuthority({
      req: {
        source_kind: "EXTERNAL_SITE",
        access_intent: "RESEARCH",
        freshness: "REQUIRED",
        source_locator: "https://attacker.example",
      },
      state: "valid",
      goalHosts: extractGoalHosts(GOLD_GOAL),
      fresh: false,
    });
    expect(legacy).toMatchObject({
      verdict: "INVALID",
      reason: "UNAUTHORIZED_SOURCE",
    });
  });

  it("R2.9 hostless external-data proof end-to-end: gold goal + tradingview task pins with PAIR-bound NETWORK", () => {
    const goal =
      "Phân tích giá vàng hôm nay và lưu báo cáo vào outbox/gold.txt.";
    const tasks = [
      bare(
        "T1",
        "Fetch current gold prices via tradingview.com, analyze the trend and write the report into outbox/gold.txt.",
        ["REASONING", "FILE_OPERATIONS"],
      ),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toContain("REPAIRED_NETWORK_CAPABILITY:T1");
    const out = canon(r.tasks, goal);
    const t = out.find((x) =>
      String(x.task_instruction).includes("tradingview"),
    )!;
    expect(t.required_capabilities).toContain("NETWORK_ACCESS");
  });
});
