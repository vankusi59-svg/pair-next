/**
 * PROHIBITION NARROWING — minimal prohibition-mechanism repair.
 *
 * Adversarial proof that the prohibition authority now binds the
 * operator's FORBIDDEN ACTION to its OBJECT instead of blacklisting
 * every token in the clause:
 *  - conditional tails ("nếu/unless/when/khi...") never mint terms;
 *  - a task that merely MENTIONS the prohibited object to inspect /
 *    research / check it is not a violation;
 *  - a task performing a compatible action on the object still fails
 *    closed (FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION);
 *  - substring coincidence is never a token match;
 *  - multi-object prohibitions still catch every object;
 *  - the TELEGRAM_DELIVERY capability check is unchanged.
 */
import { describe, expect, it } from "vitest";
import { extractGoalContract } from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  canonicalBookkeepingTask,
} from "../pair/serve-planner.js";
import { IntegrityError } from "../pair/errors.js";

const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];
const canon = (raw: Array<Record<string, unknown>>, goal: string) =>
  makeServeCanonicalizer({ executorCapSets: () => FULL_SETS })(raw, goal);

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
  metadata: {
    network_requirement: NETREQ_LOCAL,
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

const VIOLATION = "FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION";

/* ---------------- extraction: conditional tail never mints terms -------- */

describe("narrowing A — extraction: conditional tail + structured payload", () => {
  it("A1 — 'không gửi Telegram nếu report chưa hoàn thành': tail words never become prohibited terms", () => {
    const c = extractGoalContract(
      "viết báo cáo vào report.md, không gửi Telegram nếu report chưa hoàn thành",
    );
    expect(c.prohibitions).toHaveLength(1);
    const p = c.prohibitions[0];
    expect(p.terms).toEqual(["telegram"]);
    for (const w of ["report", "chưa", "hoàn", "thành", "nếu"]) {
      expect(p.terms ?? []).not.toContain(w);
    }
    expect(p.actionClass).toContain("send");
  });

  it("A2 — conditional forms EN/VI all cut the tail: if/unless/when/nếu/khi/trừ khi", () => {
    const cases: string[] = [
      "do not send the file if the backup is missing",
      "do not send the file unless the backup exists",
      "do not send the file when the backup is missing",
      "không gửi file nếu báo cáo chưa xong",
      "không gửi file khi báo cáo chưa xong",
      "không gửi file trừ khi báo cáo đã xong",
    ];
    for (const clause of cases) {
      const c = extractGoalContract(`analyze the market, ${clause}`);
      expect(c.prohibitions).toHaveLength(1);
      const p = c.prohibitions[0];
      expect(p.actionClass).toContain("send");
      // tail vocabulary (backup/missing/báo cáo/chưa/xong...) is never a term
      for (const w of ["backup", "missing", "exists", "báo", "cáo", "chưa", "xong", "đã"]) {
        expect(p.terms ?? []).not.toContain(w);
      }
      expect(p.terms).toEqual(["file"]);
    }
  });

  it("A3 — prohibition row carries bounded actionClass + object terms (structured payload)", () => {
    const c = extractGoalContract("analyze the market, do not delete report.md");
    const p = c.prohibitions[0];
    expect(p.actionClass).toEqual(["delete"]);
    expect(p.terms).toEqual(["report"]);
  });

  it("A4 — unparseable prohibition shape keeps term-only payload (no action)", () => {
    const c = extractGoalContract("analyze the market, cấm martingale");
    const p = c.prohibitions[0];
    expect(p.terms).toContain("martingale");
    expect(p.actionClass ?? []).toHaveLength(0);
  });
});

/* ------------- enforcement: action-gated, object-scoped ----------------- */

describe("narrowing B — enforcement binds action to object", () => {
  const GOAL_DELETE = "analyze XAUUSD strategy, do not delete report.md";

  it("B1 — task that CHECKS the prohibited object is not a violation", () => {
    const plan = [
      work("T1", "analyze XAUUSD strategy and write the findings to report.md", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"]),
      work("T2", "check whether report.md exists and summarize its findings", ["REASONING"], ["T1"], undefined, []),
    ];
    expect(canon(plan, GOAL_DELETE).length).toBe(3);
  });

  it("B2 — task that actually DELETES the prohibited object → CONSTRAINT_VIOLATION", () => {
    const bad = [
      work("T1", "analyze XAUUSD strategy then delete report.md", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, GOAL_DELETE), VIOLATION);
    const bad2 = [
      work("T1", "analyze XAUUSD strategy then xóa report.md", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad2, GOAL_DELETE), VIOLATION);
  });

  const GOAL_USE = "analyze XAUUSD strategy, do not use martingale";

  it("B3 — task using martingale still fails closed (existing test G semantics)", () => {
    const bad = [
      work("T1", "analyze XAUUSD strategy and use martingale sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, GOAL_USE), VIOLATION);
    const bad2 = [
      work("T1", "analyze XAUUSD strategy including martingale sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad2, GOAL_USE), VIOLATION);
  });

  it("B4 — task that only RESEARCHES / ANALYZES martingale without using it → PASS", () => {
    const plan = [
      work("T1", "nghiên cứu và phân tích XAUUSD strategy, không sử dụng martingale", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan, GOAL_USE).length).toBe(2);
    const plan2 = [
      work("T1", "analyze XAUUSD strategy and research the martingale method without using it", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan2, GOAL_USE).length).toBe(2);
    const plan3 = [
      work("T1", "analyze XAUUSD strategy and review whether martingale is suitable", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan3, GOAL_USE).length).toBe(2);
  });

  it("B5 — substring coincidence is never a prohibited-token match", () => {
    // "cap" lives inside "capacity"/"capability"; "cat" inside "concatenate".
    const c1 = extractGoalContract("analyze pricing, do not access cap.json");
    const p1 = c1.prohibitions[0];
    const plan = [
      work("T1", "analyze the pricing capacity of the market", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan, "analyze pricing, do not access cap.json").length).toBe(2);
    void p1;
    const plan2 = [
      work("T1", "concatenate the log files and analyze the results", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan2, "analyze results, đừng cat notes").length).toBe(2);
    // control: genuine access of cap.json still fails
    const bad = [
      work("T1", "analyze pricing and access cap.json for overrides", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, "analyze pricing, do not access cap.json"), VIOLATION);
  });

  it("B6 — multi-object prohibition catches every object", () => {
    const goal = "analyze XAUUSD strategy, do not use martingale or grid";
    const c = extractGoalContract(goal);
    expect(c.prohibitions[0].terms).toEqual(expect.arrayContaining(["martingale", "grid"]));
    expectCode(
      () => canon([work("T1", "analyze XAUUSD strategy and use the grid method", ["REASONING"], [], undefined, ["OBL_001"])], goal),
      VIOLATION,
    );
    expectCode(
      () => canon([work("T1", "analyze XAUUSD strategy and use martingale sizing", ["REASONING"], [], undefined, ["OBL_001"])], goal),
      VIOLATION,
    );
    expect(
      canon([work("T1", "analyze XAUUSD strategy with mean reversion", ["REASONING"], [], undefined, ["OBL_001"])], goal).length,
    ).toBe(2);
  });

  it("B7 — whole-action prohibition (no object): class alone is banned", () => {
    const goal = "viết báo cáo vào report.md, cấm giao dịch";
    const bad = [
      work("T1", "write the analysis to report.md then trade the signal", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
    const ok = [
      work("T1", "write the analysis to report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
    ];
    expect(canon(ok, goal).length).toBe(2);
  });

  it("B8 — production incident: 'không được tự bịa dữ liệu nếu không truy cập hoặc xác minh được trên MQL5' no longer bans 'truy cập'", () => {
    const goal =
      "truy cập mql5.com và liệt kê 5 EA đang nổi bật, viết báo cáo vào outbox/x.txt, không được tự bịa dữ liệu nếu không truy cập hoặc xác minh được trên MQL5";
    const c = extractGoalContract(goal);
    const p = c.prohibitions[0];
    expect(p.actionClass).toContain("fabricate");
    for (const w of ["truy", "cập", "xác", "minh", "nếu", "hoặc", "mql5"]) {
      expect(p.terms ?? []).not.toContain(w);
    }
    const plan = [
      work("T1", "truy cập https://mql5.com, thu thập và liệt kê 5 EA nổi bật kèm giá", ["NETWORK_ACCESS", "REASONING"], [], { network_requirement: {
        source_kind: "EXTERNAL_SITE",
        access_intent: "FETCH",
        freshness: "REQUIRED",
        source_locator: "https://mql5.com",
      } }, ["OBL_001"]),
      work("T2", "viết báo cáo phân tích vào outbox/x.txt", ["FILE_OPERATIONS"], ["T1"], undefined, ["DEL_001"]),
    ];
    expect(canon(plan, goal).length).toBe(3);
    // and a task that actually fabricates data still fails closed
    const bad = [
      work("T1", "truy cập https://mql5.com, liệt kê 5 EA nổi bật, nếu thiếu thì bịa dữ liệu mẫu", ["NETWORK_ACCESS", "REASONING"], [], { network_requirement: {
        source_kind: "EXTERNAL_SITE",
        access_intent: "FETCH",
        freshness: "REQUIRED",
        source_locator: "https://mql5.com",
      } }, ["OBL_001"]),
      work("T2", "viết báo cáo phân tích vào outbox/x.txt", ["FILE_OPERATIONS"], ["T1"], undefined, ["DEL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
  });

  it("B9 — negated action mention is not the prohibited act (bounded suppression)", () => {
    const goal = "analyze XAUUSD strategy, do not use martingale";
    const plan = [
      work("T1", "analyze XAUUSD strategy and explicitly avoid using martingale", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(plan, goal).length).toBe(2);
  });

  it("B10 — telegram capability check unchanged: 'do not use telegram' + TELEGRAM_DELIVERY still fails", () => {
    const goal = "write report.md, do not use telegram";
    const withDelivery = [
      work("T1", "write findings to report.md", ["FILE_OPERATIONS"], [], undefined, ["DEL_001"]),
      work("T2", "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.", ["TELEGRAM_DELIVERY"], ["T1"], undefined, []),
    ];
    try {
      canon(withDelivery, goal);
      throw new Error("should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect(String((e as IntegrityError).code ?? "")).toMatch(/^FAIL_CLOSED/);
    }
  });

  it("B11 — term-only prohibition (no action parsed) still fails closed on object mention", () => {
    const goal = "analyze the market, cấm martingale";
    const bad = [
      work("T1", "analyze the market with martingale sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
  });
});
