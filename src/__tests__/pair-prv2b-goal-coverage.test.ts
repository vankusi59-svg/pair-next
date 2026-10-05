/**
 * PRV2-B — Goal Contract + Coverage Authority adversarial matrix A–M.
 *
 * A plan may pin only when every mandatory obligation/deliverable the
 * Goal Contract extracted from the raw operator goal is genuinely covered
 * by a canonical work task, no constraint is contradicted, and no
 * prohibition is invoked. The model's pair_coverage mapping is a proposal
 * — PAIR verifies coverage independently, so lying never helps.
 */
import { describe, expect, it } from "vitest";
import {
  extractGoalContract,
  type GoalContract,
} from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  canonicalBookkeepingTask,
} from "../pair/serve-planner.js";
import { runPlannerFailover } from "../pair/planner-pool.js";
import { IntegrityError } from "../pair/errors.js";

const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];
const canon = (raw: Array<Record<string, unknown>>, goal: string) =>
  makeServeCanonicalizer({ executorCapSets: () => FULL_SETS })(raw, goal);

/** R2 — every fresh work task carries a valid structured network
 *  requirement (LOCAL by default; these fixtures test coverage/constraint
 *  authority, not network authority). */
const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
} as const;
/** Goals in this file name the MQL5 entity → a locator for mql5.com is
 *  operator-authorized (identity-label binding). */
const NETREQ_EXT_MQL5 = {
  source_kind: "EXTERNAL_SITE",
  access_intent: "RESEARCH",
  freshness: "REQUIRED",
  source_locator: "https://www.mql5.com",
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
  metadata: {
    network_requirement: caps.includes("NETWORK_ACCESS")
      ? NETREQ_EXT_MQL5
      : NETREQ_LOCAL,
    ...(metadata ?? {}),
  },
  ...(pairCov !== undefined ? { pair_coverage: pairCov } : {}),
});

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrityError);
    expect(String((e as IntegrityError).code ?? "")).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const GOAL_3OBL =
  "research competitors, compare pricing, propose 3 strategies";
const TASKS_3OBL = [
  work("T1", "research competitors and list their positioning", ["REASONING"], [], undefined, ["OBL_001"]),
  work("T2", "compare the competitors' pricing and positioning", ["REASONING"], ["T1"], undefined, ["OBL_002"]),
  work("T3", "propose 3 sales strategies based on the comparison", ["REASONING"], ["T2"], undefined, ["OBL_003"]),
];

/* ------------------------------ contract ------------------------------ */

describe("PRV2-B contract extraction", () => {
  it("deterministic: same goal → identical contract digest", () => {
    const a = extractGoalContract(GOAL_3OBL);
    const b = extractGoalContract(GOAL_3OBL);
    expect(a.contractDigest).toBe(b.contractDigest);
    expect(a.contractDigest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stable ids + preserved quantities, no invented requirements", () => {
    const c = extractGoalContract(GOAL_3OBL);
    expect(c.obligations.map((r) => r.id)).toEqual(["OBL_001", "OBL_002", "OBL_003"]);
    expect(c.obligations[2].quantity?.min).toBe(3);
    expect(c.deliverables).toHaveLength(0);
    expect(c.constraints).toHaveLength(0);
    expect(c.prohibitions).toHaveLength(0);
  });

  it("L — 'create report.md' mints only DEL_001; no telegram/network/competitor invention", () => {
    const c = extractGoalContract("create report.md");
    expect(c.deliverables.map((r) => r.id)).toEqual(["DEL_001"]);
    expect(c.deliverables[0].target).toBe("report.md");
    expect(c.obligations).toHaveLength(0);
    expect(c.constraints).toHaveLength(0);
    expect(c.prohibitions).toHaveLength(0);
    expect(c.delivery_intent.requested).toBe(false);
  });

  it("conservative incompleteness: unclassifiable clauses mint nothing", () => {
    const c = extractGoalContract("the market is interesting");
    expect(c.obligations).toHaveLength(0);
    expect(c.deliverables).toHaveLength(0);
  });

  it("prohibition + constraint + deadline extraction", () => {
    const c = extractGoalContract(
      "analyze XAUUSD trends, budget <= $50, do not use martingale, deadline Friday",
    );
    expect(c.constraints.length).toBe(1);
    expect(c.constraints[0].maxAmount).toBe(50);
    expect(c.prohibitions.length).toBe(1);
    expect(c.prohibitions[0].terms).toContain("martingale");
    expect(c.deadline?.text).toContain("Friday");
  });

  it("H — explicit telegram request references the existing intent authority", () => {
    const c = extractGoalContract("write report.md and send it via telegram");
    expect(c.delivery_intent.requested).toBe(true);
    // delivery is the intent authority's concern — no obligation minted
    // for the "send" clause itself.
    expect(c.obligations.every((o) => !/telegram/i.test(o.text))).toBe(true);
  });
});

/* --------------------------- coverage seam ---------------------------- */

describe("PRV2-B coverage authority", () => {
  it("A — obligation row no task declares → FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED", () => {
    const only2 = TASKS_3OBL.slice(0, 2);
    expectCode(() => canon(only2, GOAL_3OBL), "FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED");
  });

  it("B — every obligation covered by a valid task → PASS", () => {
    const out = canon(TASKS_3OBL, GOAL_3OBL);
    expect(out.length).toBe(4); // T1 bookkeeping + 3 work
    expect(out[0].task_key).toBe("T1");
  });

  it("C — fabricated pair_coverage mapping can never certify coverage", () => {
    const lying = [
      work("T1", "research competitors and list their positioning", ["REASONING"]),
      work("T2", "compare the competitors' pricing and positioning", ["REASONING"], ["T1"], {
        pair_coverage: ["OBL_003"], // T2 only compares — never proposes
      }),
    ];
    expectCode(() => canon(lying, GOAL_3OBL), "FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("D — named deliverable with no producing task → reject", () => {
    const goal = "create report.md and analyze the data";
    const noProducer = [
      work("T1", "analyze the project data and summarize findings", ["REASONING"], [], undefined, ["OBL_001", "DEL_001"]),
    ];
    expectCode(() => canon(noProducer, goal), "FAIL_CLOSED_PLAN_INCOMPLETE");
    const withProducer = [
      work("T1", "analyze the project data and write findings to report.md", [
        "REASONING",
        "FILE_OPERATIONS",
      ], [], undefined, ["OBL_001", "DEL_001"]),
    ];
    expect(canon(withProducer, goal).length).toBe(2);
  });

  it("E — quantity downgrade rejected; equal-or-greater bound passes", () => {
    const goal = "research at least 20 MQL5 EA products";
    const downgraded = [
      work("T1", "research 5 MQL5 EA products", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(downgraded, goal), "FAIL_CLOSED_PLAN_INCOMPLETE");
    const kept = [
      work("T1", "research at least 20 current MQL5 EAs", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(kept, goal).length).toBe(2);
    const larger = [
      work("T1", "research 25 current MQL5 EA products", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(larger, goal).length).toBe(2);
    const unquantified = [
      work("T1", "research MQL5 EAs", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(unquantified, goal), "FAIL_CLOSED_PLAN_INCOMPLETE");
  });

  it("F — task exceeding an explicit budget ceiling → CONSTRAINT_VIOLATION", () => {
    const goal = "analyze pricing, budget <= $50";
    const over = [
      work("T1", "analyze pricing using up to $100 of api spend", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(
      () => canon(over, goal),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
    const within = [
      work("T1", "analyze pricing within a $40 budget", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(within, goal).length).toBe(2);
  });

  it("G — 'do not use X' prohibition invoked by a task → CONSTRAINT_VIOLATION", () => {
    const goal = "analyze XAUUSD strategy, do not use martingale";
    const bad = [
      work("T1", "analyze XAUUSD strategy including martingale sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(
      () => canon(bad, goal),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("G2 — 'do not use telegram' + TELEGRAM_DELIVERY task is rejected (existing authority + coverage)", () => {
    const goal = "write report.md, do not use telegram";
    const withDelivery = [
      work("T1", "write findings to report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
      work("T2", "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.", ["TELEGRAM_DELIVERY"], ["T1"], undefined, []),
    ];
    // Both seams fail closed — the telegram intent authority rejects a
    // delivery task the goal never requested before coverage even runs.
    try {
      canon(withDelivery, goal);
      throw new Error("should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect(String((e as IntegrityError).code ?? "")).toMatch(/^FAIL_CLOSED/);
    }
  });

  it("H2 — explicit telegram goal: delivery task + producer both required and allowed", () => {
    const goal = "write report.md and send it via telegram";
    const plan = [
      work("T1", "write the findings to outbox/report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
      work("T2", "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.", ["TELEGRAM_DELIVERY"], ["T1"], undefined, []),
    ];
    const out = canon(plan, goal);
    expect(out.length).toBe(3);
  });

  it("I — replan dropping OBL_002 still fails against the SAME contract", () => {
    const contract1 = extractGoalContract(GOAL_3OBL);
    const contract2 = extractGoalContract(GOAL_3OBL);
    expect(contract1.contractDigest).toBe(contract2.contractDigest);
    const replanned = [
      work("T1", "research competitors and list their positioning", ["REASONING"], [], undefined, ["OBL_001"]),
      work("T3", "propose 3 sales strategies based on the comparison", ["REASONING"], [], undefined, ["OBL_003"]),
    ];
    expectCode(() => canon(replanned, GOAL_3OBL), "FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED");
  });

  it("K — bookkeeping can never declare coverage", () => {
    const contract = extractGoalContract(GOAL_3OBL);
    const bk = canonicalBookkeepingTask(GOAL_3OBL) as Record<string, unknown>;
    expectCode(
      () => assertPlanCoverage(contract, [bk]),
      "FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED",
    );
  });

  it("coverage states: budget PROVEN, deadline PRESERVED, unverifiable constraint never PROVEN", () => {
    const contract: GoalContract = extractGoalContract(
      "analyze market, budget <= $50, use only MQL5, in english, deadline Friday",
    );
    const report = assertPlanCoverage(contract, [
      canonicalBookkeepingTask("g") as Record<string, unknown>,
      work("T1", "analyze market within a $20 budget using MQL5 data", ["REASONING"], [], { pair_coverage: ["OBL_001"] }),
    ]);
    const byId = new Map(report.rows.map((r) => [r.requirement_id, r]));
    expect(byId.get("CON_001")?.state).toBe("PROVEN");
    expect(byId.get("CON_002")?.state).toBe("PROVEN");
    expect(byId.get("CON_003")?.state).toBe("PRESERVED");
    expect(byId.get("DDL_001")?.state).toBe("PRESERVED");
  });

  it("M — PRV2-A regression: network authority unweakened", () => {
    const goal = "analyze today's gold price";
    expectCode(
      () => canon([work("T1", "analyze the gold price", ["REASONING"])], goal),
      "FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED",
    );
  });
});

/* -------------------- R1.A — multi-dimension clauses -------------------- */

describe("PRV2-B R1.A — clause dimensions are not mutually exclusive", () => {
  it("R1.A-1: 'research 20 MQL5 EAs by 31/10' mints OBL(min 20) + DDL", () => {
    const c = extractGoalContract("research 20 MQL5 EAs by 31/10");
    expect(c.obligations.map((r) => r.id)).toEqual(["OBL_001"]);
    expect(c.obligations[0].quantity?.min).toBe(20);
    expect(c.deadline?.id).toBe("DDL_001");
    expect(c.deadline?.text).toContain("31/10");
  });

  it("R1.A-2: 'research current EA market, use only MQL5' mints OBL + only-constraint", () => {
    const c = extractGoalContract("research current EA market, use only MQL5");
    expect(c.obligations.length).toBe(1);
    const only = c.constraints.find((r) => r.onlyTerms?.includes("mql5"));
    expect(only).toBeDefined();
  });

  it("R1.A-3: 'research MQL5 EAs only' keeps the research obligation", () => {
    const c = extractGoalContract("research MQL5 EAs only");
    expect(c.obligations.length).toBe(1);
    expect(c.constraints.some((r) => r.onlyTerms?.includes("mql5"))).toBe(true);
  });

  it("R1.A-4: no task covering the research row under a deadline clause → fails closed", () => {
    expectCode(
      () =>
        canon(
          [work("T1", "write a summary of the findings", ["FILE_OPERATIONS"], [], undefined, ["OBL_001"])],
          "research 20 MQL5 EAs by 31/10",
        ),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("R1.A-5: covering the obligation under a deadline clause → PASS", () => {
    const out = canon(
      [work("T1", "research 20 current MQL5 EAs and record findings", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])],
      "research 20 MQL5 EAs by 31/10",
    );
    expect(out.length).toBe(2);
  });

  it("R1.A-6: prohibition still outranks — a forbidden clause never mints an obligation", () => {
    const c = extractGoalContract("analyze pricing, do not use martingale sizing");
    expect(c.prohibitions).toHaveLength(1);
    expect(c.prohibitions[0].terms).toContain("martingale");
    expect(c.obligations.every((o) => !/martingale/i.test(o.text))).toBe(true);
  });

  it("R1.A-7: produce+file-only clause stays DEL-only (no duplicate OBL)", () => {
    const c = extractGoalContract("create report.md");
    expect(c.deliverables.map((r) => r.id)).toEqual(["DEL_001"]);
    expect(c.obligations).toHaveLength(0);
  });
});

/* -------------------- R1.B — `only` constraint contradiction -------------------- */

describe("PRV2-B R1.B — bounded only-constraint contradiction detection", () => {
  const GOAL_ONLY = "research EA market, use only MQL5";

  it("R1.B-1: task invoking the excluded sibling mql4 → CONSTRAINT_VIOLATION", () => {
    expectCode(
      () => canon([work("T1", "research current MQL4 EAs", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])], GOAL_ONLY),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R1.B-2: task honoring only-mql5 → PASS (constraint PROVEN via evidence)", () => {
    const out = canon(
      [work("T1", "research current MQL5 EAs", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])],
      GOAL_ONLY,
    );
    expect(out.length).toBe(2);
  });

  it("R1.B-3: 'MQL5 only' word-order variant binds the same constraint", () => {
    const c = extractGoalContract("research EA market, MQL5 only");
    expect(c.constraints.some((r) => r.onlyTerms?.includes("mql5"))).toBe(true);
    expectCode(
      () => canon([work("T1", "research MQL4 EAs", ["REASONING"], [], undefined, ["OBL_001"])], "research EA market, MQL5 only"),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R1.B-4: only-channel bound — telegram-only goal rejects a slack task", () => {
    const c = extractGoalContract("analyze results, notify only telegram");
    expect(c.constraints.some((r) => r.onlyTerms?.includes("telegram"))).toBe(true);
    expectCode(
      () =>
        canon(
          [
            work("T1", "analyze the results data", ["REASONING"], [], undefined, ["OBL_001"]),
            work("T2", "notify via slack when done", ["REASONING"], ["T1"], undefined, []),
          ],
          "analyze results, notify only telegram",
        ),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R1.B-5: unverifiable only-bound — carried → PROVEN, silently dropped → INCOMPLETE", () => {
    // "use only candlesticks": no enumerable sibling space → never a
    // VIOLATION, but an uncovered bound is still a dropped constraint.
    const carried = assertPlanCoverage(
      extractGoalContract("analyze market, use only candlesticks"),
      [
        canonicalBookkeepingTask("g") as Record<string, unknown>,
        work("T1", "analyze the market using candlesticks", ["REASONING"], [], { pair_coverage: ["OBL_001"] }),
      ],
    );
    expect(carried.rows.find((r) => r.requirement_id === "CON_001")?.state).toBe("PROVEN");
    expectCode(
      () => canon([work("T1", "analyze the market", ["REASONING"], [], undefined, ["OBL_001"])], "analyze market, use only candlesticks"),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("R1.B-6: budget ceiling behavior retained alongside only-constraints", () => {
    const contract = extractGoalContract("analyze market, budget <= $50, use only MQL5");
    expect(contract.constraints).toHaveLength(2);
    const report = assertPlanCoverage(contract, [
      canonicalBookkeepingTask("g") as Record<string, unknown>,
      work("T1", "analyze the market within a $20 budget using MQL5 data", ["REASONING"], [], { pair_coverage: ["OBL_001"] }),
    ]);
    const byId = new Map(report.rows.map((r) => [r.requirement_id, r]));
    expect(byId.get("CON_001")?.state).toBe("PROVEN");
    expect(byId.get("CON_002")?.state).toBe("PROVEN");
  });
});

/* -------------------- R1.C — canonical DSN-1 deliverable equivalence -------------------- */

describe("PRV2-B R1.C — deliverable matching uses canonical artifactNamesEquivalent", () => {
  it("R1.C-1: report.md ↔ report.md and outbox staging alias are equivalent", () => {
    expect(
      canon([work("T1", "write the findings to report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"])], "create report.md").length,
    ).toBe(2);
    expect(
      canon([work("T1", "write the findings to outbox/report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"])], "create report.md").length,
    ).toBe(2);
  });

  it("R1.C-2: two-sided basename is never equivalence — dirA/x.md vs x.md → INCOMPLETE", () => {
    expectCode(
      () =>
        canon(
          [work("T1", "write the findings to reports/internal/report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"])],
          "create report.md",
        ),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("R1.C-3: sibling directories sharing a basename are not equivalent (dirA/X vs dirB/X)", () => {
    expectCode(
      () =>
        canon(
          [work("T1", "write the findings to reports/customer/report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"])],
          "create reports/internal/report.md",
        ),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });
});

/* ------------- R2 — bounded constraints must be carried ------------- */

describe("PRV2-B R2 — a mandatory bounded constraint may not be silently dropped", () => {
  const GOAL_ONLY2 = "research current EA market, use only MQL5";

  it("R2-1: generic covering task never carried the bound → INCOMPLETE", () => {
    expectCode(
      () => canon([work("T1", "research current EA market", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])], GOAL_ONLY2),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("R2-2: sibling task MQL4 → CONSTRAINT_VIOLATION (retained)", () => {
    expectCode(
      () => canon([work("T1", "research current MQL4 EAs", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])], GOAL_ONLY2),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R2-3: covering task carrying MQL5 → PASS", () => {
    expect(
      canon([work("T1", "research current MQL5 EAs", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"])], GOAL_ONLY2).length,
    ).toBe(2);
  });

  it("R2-4: unrelated dummy task mentioning MQL5 does not grant coverage", () => {
    expectCode(
      () =>
        canon(
          [
            work("T1", "research current EA market", ["REASONING", "NETWORK_ACCESS"], [], undefined, ["OBL_001"]),
            work("T2", "write a note mentioning MQL5 once", ["REASONING"], ["T1"], undefined, []),
          ],
          GOAL_ONLY2,
        ),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("R2-5: bookkeeping never satisfies an only-bound", () => {
    const report = () =>
      assertPlanCoverage(extractGoalContract(GOAL_ONLY2), [
        canonicalBookkeepingTask("g") as Record<string, unknown>,
      ]);
    expectCode(report, "FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED");
  });

  it("R2-6: budget — '100 USD' form → CONSTRAINT_VIOLATION", () => {
    expectCode(
      () => canon([work("T1", "analyze pricing using 100 USD", ["REASONING"], [], undefined, ["OBL_001"])], "analyze pricing, budget <= $50"),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R2-7: budget — 'USD 100' form → CONSTRAINT_VIOLATION", () => {
    expectCode(
      () => canon([work("T1", "analyze pricing using USD 100", ["REASONING"], [], undefined, ["OBL_001"])], "analyze pricing, budget <= $50"),
      "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION",
    );
  });

  it("R2-8: budget — task amount within ceiling ($40) → PASS", () => {
    expect(
      canon([work("T1", "analyze pricing within $40", ["REASONING"], [], undefined, ["OBL_001"])], "analyze pricing, budget <= $50").length,
    ).toBe(2);
  });

  it("R2-9: budget with no checkable task amount → PRESERVED, never PROVEN", () => {
    const report = assertPlanCoverage(extractGoalContract("analyze pricing, budget <= $50"), [
      canonicalBookkeepingTask("g") as Record<string, unknown>,
      work("T1", "analyze pricing carefully", ["REASONING"], [], { pair_coverage: ["OBL_001"] }),
    ]);
    expect(report.rows.find((r) => r.requirement_id === "CON_001")?.state).toBe("PRESERVED");
  });
});

/* ------------------------------ failover ------------------------------ */

describe("PRV2-B failover", () => {
  it("J — candidate#1 incomplete fails typed; ONE feedback re-ask, then candidate#2 wins", async () => {
    const candidates = [
      { ref: "c1", provider: "p", model_entry_id: "m1", model: "m1", transport: "http" },
      { ref: "c2", provider: "p", model_entry_id: "m2", model: "m2", transport: "http" },
    ] as never[];
    const canonFn = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
    let call = 0;
    const res = await runPlannerFailover({
      candidates,
      assertEligible: () => {},
      planFn: async () => {
        call++;
        return {
          // P-REASK: candidate#1's corrected re-ask (call 2) still omits
          // the third obligation — a second typed rejection is terminal
          // for the candidate, failover proceeds to c2.
          tasks:
            call === 1 || call === 2
              ? TASKS_3OBL.slice(0, 2) // missing "propose 3 strategies"
              : TASKS_3OBL,
          warnings: [],
        };
      },
      canonicalize: (tasks) => canonFn(tasks, GOAL_3OBL),
    });
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0].outcome).toBe("FAILED");
    expect(res.attempts[0].failure_class).toBe("PLAN_INVALID");
    expect(res.attempts[0].warnings.join("|")).toContain(
      "REASK:FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED",
    );
    expect(res.winner?.route).toBe("c2");
    expect(res.tasks.length).toBe(4);
  });

  it("J2 — the SAME candidate self-corrects on the ONE re-ask and wins", async () => {
    const candidates = [
      { ref: "c1", provider: "p", model_entry_id: "m1", model: "m1", transport: "http" },
      { ref: "c2", provider: "p", model_entry_id: "m2", model: "m2", transport: "http" },
    ] as never[];
    const canonFn = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
    let call = 0;
    const res = await runPlannerFailover({
      candidates,
      assertEligible: () => {},
      planFn: async () => {
        call++;
        return {
          tasks:
            call === 1
              ? TASKS_3OBL.slice(0, 2)
              : TASKS_3OBL, // corrected on the re-ask
          warnings: [],
        };
      },
      canonicalize: (tasks) => canonFn(tasks, GOAL_3OBL),
    });
    // One attempt row: c1's re-ask fixed the coverage defect — c2 never ran.
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0].outcome).toBe("SUCCESS");
    expect(res.attempts[0].warnings.join("|")).toContain(
      "REASK_SUCCEEDED:FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED",
    );
    expect(res.winner?.route).toBe("c1");
    expect(res.tasks.length).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* LIVE REGRESSION — the natural-planner vocabulary must cover natural */
/* obligation verbs. Live incident: goal "research 15 MQL5 ..." was     */
/* planned as "Search the official MQL5 marketplace..." — `search` was  */
/* in no verb class, so the research obligation found no covering task  */
/* → FAIL_CLOSED_PLAN_INCOMPLETE on every planner candidate.            */
/* ------------------------------------------------------------------ */
describe("live-vocab — search/find/browse obligations", () => {
  it("A. 'Search ...' task covers a 'research ...' obligation (anchors + quantity bound)", () => {
    const contract = extractGoalContract(
      "research 15 MQL5 expert advisors on the marketplace",
    );
    const r = assertPlanCoverage(contract, [
      canonicalBookkeepingTask(
        "research 15 MQL5 expert advisors on the marketplace",
      ),
      work(
        "T2",
        "Search the official MQL5 marketplace for the 15 most recent MQL5 expert advisors and collect pricing",
        ["NETWORK_ACCESS", "REASONING"],
        [],
        { pair_coverage: ["OBL_001"] },
      ),
    ]);
    expect(r.rows.find((x) => x.requirement_id === "OBL_001")?.state).toBe(
      "PROVEN",
    );
  });

  it("B. Vietnamese 'tìm' task covers a 'nghiên cứu' obligation", () => {
    const contract = extractGoalContract("nghiên cứu các EA MQL5 mới nhất");
    const r = assertPlanCoverage(contract, [
      canonicalBookkeepingTask("nghiên cứu các EA MQL5 mới nhất"),
      work(
        "T2",
        "tìm các EA MQL5 mới nhất trên marketplace chính thức",
        ["NETWORK_ACCESS", "REASONING"],
        [],
        { pair_coverage: ["OBL_001"] },
      ),
    ]);
    expect(r.rows.find((x) => x.requirement_id === "OBL_001")?.state).toBe(
      "PROVEN",
    );
  });

  it("C. unrelated-subject 'search' still cannot cover the research obligation", () => {
    const contract = extractGoalContract(
      "research 15 MQL5 expert advisors on the marketplace",
    );
    expectCode(
      () =>
        assertPlanCoverage(contract, [
          canonicalBookkeepingTask(
            "research 15 MQL5 expert advisors on the marketplace",
          ),
          work(
            "T2",
            "search the latest gold prices and collect 15 quotes",
            ["NETWORK_ACCESS", "REASONING"],
            [],
            { pair_coverage: ["OBL_001"] },
          ),
        ]),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });
});

/* ------------------------------------------------------------------ */
/* LIVE REGRESSION — the exact multi-gate plan the three planner        */
/* candidates emitted in production. Before the grammar fix, sentence-  */
/* final artifact names made consumes producer-less                     */
/* (FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT) on every attempt.          */
/* ------------------------------------------------------------------ */
describe("live-e2e — production-shaped plan canonicalizes end-to-end", () => {
  const LIVE_GOAL =
    "research 15 MQL5 expert advisors mới nhất trên thị trường, use only " +
    "MQL5 official marketplace listings, so sánh pricing và features, " +
    "viết report.md, gửi qua telegram, budget <= $2, xong trước cuối tuần";
  const LIVE_TASKS = [
    work(
      "T1",
      "Search the official MQL5 marketplace for the 15 most recent Expert " +
        "Advisors. Extract their names, pricing, and key features. Save the " +
        "raw data to market_data.json. Use only official MQL5 listings.",
      ["NETWORK_ACCESS", "REASONING"],
      [],
      undefined,
      ["OBL_001"],
    ),
    work(
      "T2",
      "Read market_data.json. Analyze and compare the pricing and features " +
        "of the 15 Expert Advisors. Ensure all selected items are within the " +
        "$2 budget constraint. Write the comparative analysis to analysis_temp.txt.",
      ["FILE_OPERATIONS", "REASONING"],
      ["T1"],
      undefined,
      ["OBL_002"],
    ),
    work(
      "T3",
      "Read analysis_temp.txt and format the findings into a professional " +
        "report.md file. Ensure the report includes the comparison table and " +
        "summary. Write the final report to outbox/report.md.",
      ["CODE_GENERATION", "FILE_OPERATIONS"],
      ["T2"],
      undefined,
      ["DEL_001"],
    ),
    work(
      "T4",
      "Stage the manifested artifacts from outbox/report.md into the " +
        "telegram delivery pipeline, then reply DONE.",
      ["TELEGRAM_DELIVERY"],
      ["T3"],
      undefined,
      [],
    ),
  ];
  // Production executor capability sets — NETWORK resolves only via
  // CODEX/DEVIN-shaped sets (capability still bounded, just not needed
  // for this gate: canonicalizer checks plan shape, not assignment).
  const PROD_SETS = [
    [
      "CODE_GENERATION",
      "CODE_EDITING",
      "FILE_OPERATIONS",
      "SHELL_EXECUTION",
      "REASONING",
      "TELEGRAM_DELIVERY",
    ],
    [
      "CODE_GENERATION",
      "CODE_EDITING",
      "FILE_OPERATIONS",
      "SHELL_EXECUTION",
      "REASONING",
      "PYTHON_EXECUTION",
      "TELEGRAM_DELIVERY",
      "NETWORK_ACCESS",
    ],
    [
      "REMOTE_CLOUD_TASK_EXECUTION",
      "AUTONOMOUS_CODE_EXECUTION",
      "NETWORK_ACCESS",
    ],
    ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
  ];
  const prodCanon = (raw: Array<Record<string, unknown>>, goal: string) =>
    makeServeCanonicalizer({ executorCapSets: () => PROD_SETS })(raw, goal);

  it("A. the exact emitted plan canonicalizes: dataflow bound, coverage PROVEN", () => {
    const out = prodCanon(LIVE_TASKS, LIVE_GOAL);
    const keys = out.map((t) => String(t.task_key));
    expect(keys).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    // Producer edges bound: T3 consumes market_data.json → depends on T2.
    const t3 = out.find((t) => String(t.task_key) === "T3")!;
    expect(t3.depends_on).toContain("T2");
  });

  it("B. same plan minus the MQL5 carriage still fails closed (R2 preserved)", () => {
    const weakened = LIVE_TASKS.map((t, i) =>
      i === 0
        ? work(
            "T1",
            "Search the marketplace for the 15 most recent Expert " +
              "Advisors and save raw data to market_data.json.",
            ["NETWORK_ACCESS", "REASONING"],
            [],
            undefined,
            ["OBL_001"],
          )
        : t,
    );
    expectCode(
      () => prodCanon(weakened, LIVE_GOAL),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });
});

describe("live-vocab R1 — browse covers research", () => {
  it("A. 'Browse the official MQL5 marketplace...' covers 'research 15 MQL5 EAs'", () => {
    const contract = extractGoalContract("research 15 MQL5 EAs");
    const r = assertPlanCoverage(contract, [
      canonicalBookkeepingTask("research 15 MQL5 EAs"),
      work(
        "T2",
        "Browse the official MQL5 marketplace for 15 MQL5 EAs and collect pricing",
        ["NETWORK_ACCESS", "REASONING"],
        [],
        { pair_coverage: ["OBL_001"] },
      ),
    ]);
    expect(r.rows.find((x) => x.requirement_id === "OBL_001")?.state).toBe(
      "PROVEN",
    );
  });
});
