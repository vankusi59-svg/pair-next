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

/* ================= AUDIT R1 — four findings ================= */

describe("R1-F1 — bare 'không' needs structural evidence", () => {
  it("F1.a — 'ngân sách không quá $50' mints a budget constraint, never a prohibition", () => {
    const c = extractGoalContract("analyze XAUUSD strategy, ngân sách không quá $50");
    expect(c.prohibitions).toHaveLength(0);
    expect(c.constraints.length).toBeGreaterThan(0);
    expect(c.constraints.map((r) => r.maxAmount)).toContain(50);
  });

  it("F1.b — 'phân tích EA không có martingale' mints the obligation, prohibition does not swallow it", () => {
    const c = extractGoalContract("phân tích EA không có martingale");
    expect(c.prohibitions).toHaveLength(0);
    expect(c.obligations.length).toBeGreaterThan(0);
  });

  it("F1.c — natural bans still mint: 'không gửi Telegram', 'không xóa report.md', 'không dùng martingale'", () => {
    const a = extractGoalContract("analyze the market, không gửi Telegram");
    expect(a.prohibitions).toHaveLength(1);
    expect(a.prohibitions[0].actionClass).toEqual(["send"]);
    expect(a.prohibitions[0].terms).toContain("telegram");
    const b = extractGoalContract("analyze the market, không xóa report.md");
    expect(b.prohibitions[0].actionClass).toEqual(["delete"]);
    expect(b.prohibitions[0].terms).toContain("report");
    const d = extractGoalContract("analyze the market, không dùng martingale");
    expect(d.prohibitions[0].actionClass).toEqual(["use"]);
    expect(d.prohibitions[0].terms).toContain("martingale");
  });

  it("F1.d — 'đừng' trigger fires (leading-đ boundary fixed): 'đừng gửi telegram' / 'đừng xóa report.md'", () => {
    const a = extractGoalContract("analyze the market, đừng gửi telegram");
    expect(a.prohibitions).toHaveLength(1);
    expect(a.prohibitions[0].actionClass).toEqual(["send"]);
    expect(a.prohibitions[0].terms).toContain("telegram");
    const b = extractGoalContract("analyze the market, đừng xóa report.md");
    expect(b.prohibitions[0].actionClass).toEqual(["delete"]);
    expect(b.prohibitions[0].terms).toContain("report");
    // the most common VI phrasing now enforces at the gate too
    const bad = [
      work("T1", "analyze the market and broadcast the findings on telegram", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, "analyze the market, đừng gửi telegram"), VIOLATION);
  });
});

describe("R1-F2 — negation suppression scope is bounded", () => {
  const GOAL_USE = "analyze XAUUSD strategy, do not use martingale";

  it("F2.a — 'do not analyze first, then use martingale' MUST FAIL (then is a breaker)", () => {
    const bad = [
      work("T1", "analyze XAUUSD strategy; do not analyze first, then use martingale", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, GOAL_USE), VIOLATION);
  });

  it("F2.b — punctuation breaks the window: 'avoid X. then use martingale' fails", () => {
    const bad = [
      work("T1", "analyze XAUUSD strategy, avoid grid. Then use martingale sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, GOAL_USE), VIOLATION);
  });

  it("F2.c — connectives 'but'/'sau đó'/'nhưng' break the window → FAIL", () => {
    for (const instr of [
      "analyze XAUUSD strategy, avoid the hype but use martingale",
      "analyze XAUUSD strategy, tránh grid sau đó use martingale",
      "analyze XAUUSD strategy, tránh grid nhưng vẫn dùng martingale",
    ]) {
      expectCode(
        () => canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_USE),
        VIOLATION,
      );
    }
  });

  it("F2.d — genuine compliance stays suppressed: 'avoid using', 'will not use', 'không sử dụng'", () => {
    for (const instr of [
      "analyze XAUUSD strategy and avoid using martingale",
      "analyze XAUUSD strategy and will not use martingale",
      "phân tích XAUUSD strategy và không sử dụng martingale",
    ]) {
      expect(
        canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_USE).length,
      ).toBe(2);
    }
  });
});

describe("R1-F3 — action regex prefix false-positives gone", () => {
  const GOAL_USE = "analyze XAUUSD strategy, do not use martingale";

  it("F3.a — 'user'/'useful'/'user feedback' never mint the use action", () => {
    for (const instr of [
      "analyze XAUUSD strategy and martingale user feedback",
      "analyze XAUUSD strategy and useful martingale research",
    ]) {
      expect(
        canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_USE).length,
      ).toBe(2);
    }
  });

  it("F3.b — explicit inflections still match: use/using/used/includes/including → FAIL", () => {
    for (const instr of [
      "analyze XAUUSD strategy and use martingale",
      "analyze XAUUSD strategy using martingale sizing",
      "analyze XAUUSD strategy that previously used martingale",
      "analyze XAUUSD strategy including martingale sizing",
    ]) {
      expectCode(
        () => canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_USE),
        VIOLATION,
      );
    }
  });

  it("F3.c — other classes audited: 'orange'≠ran, 'executive'≠execute, 'tradition'≠trade, 'posture'≠post", () => {
    // run-ban goal: 'orange'/'ranging' must not mint execute
    const runGoal = "analyze XAUUSD strategy, do not run backtests";
    expect(
      canon([work("T1", "analyze XAUUSD strategy and orange juice prices", ["REASONING"], [], undefined, ["OBL_001"])], runGoal).length,
    ).toBe(2);
    const execGoal = "analyze XAUUSD strategy, do not execute orders";
    expect(
      canon([work("T1", "analyze XAUUSD strategy for the executive summary", ["REASONING"], [], undefined, ["OBL_001"])], execGoal).length,
    ).toBe(2);
    const tradeGoal = "analyze XAUUSD strategy, do not trade";
    expect(
      canon([work("T1", "analyze XAUUSD strategy and market traditions", ["REASONING"], [], undefined, ["OBL_001"])], tradeGoal).length,
    ).toBe(2);
    const postGoal = "analyze XAUUSD strategy, do not send posts to telegram";
    expect(
      canon([work("T1", "analyze XAUUSD strategy and posture of the market", ["REASONING"], [], undefined, ["OBL_001"])], postGoal).length,
    ).toBe(2);
  });
});

describe("R1-F4 — action classes come from the action phrase, not the object", () => {
  it("F4.a — 'do not delete write.txt' mints delete only; write.txt keeps object identity", () => {
    const c = extractGoalContract("analyze the market, do not delete write.txt");
    const p = c.prohibitions[0];
    expect(p.actionClass).toEqual(["delete"]);
    expect(p.terms).toContain("write");
  });

  it("F4.b — 'write to write.txt' PASSes; 'delete write.txt' FAILs", () => {
    const goal = "analyze XAUUSD strategy, do not delete write.txt";
    const ok = [
      work("T1", "analyze XAUUSD strategy and write findings to write.txt", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(ok, goal).length).toBe(2);
    const bad = [
      work("T1", "analyze XAUUSD strategy then delete write.txt", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
  });

  it("F4.c — 'do not access download folder' does not mint a second download action", () => {
    const c = extractGoalContract("analyze the market, do not access download folder");
    expect(c.prohibitions[0].actionClass).toEqual(["access"]);
    expect(c.prohibitions[0].terms).toEqual(expect.arrayContaining(["download", "folder"]));
    // a task that DOWNLOADS (different action) is not the banned act
    const ok = [
      work("T1", "analyze XAUUSD strategy and download the dataset zip", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(ok, "analyze XAUUSD strategy, do not access download folder").length).toBe(2);
  });

  it("F4.d — real multi-action 'do not delete or modify report.md' is deterministic", () => {
    const c = extractGoalContract("analyze the market, do not delete or modify report.md");
    expect(c.prohibitions[0].actionClass).toEqual(["delete", "modify"]);
    const goal = "analyze XAUUSD strategy, do not delete or modify report.md";
    expectCode(
      () => canon([work("T1", "analyze XAUUSD strategy then delete report.md", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"])], goal),
      VIOLATION,
    );
    expectCode(
      () => canon([work("T1", "analyze XAUUSD strategy then modify report.md", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"])], goal),
      VIOLATION,
    );
    // write is not among the banned classes → still passes
    expect(
      canon([work("T1", "analyze XAUUSD strategy and write findings to report.md", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"])], goal).length,
    ).toBe(2);
  });
});

/* ================= AUDIT R2 — five findings ================= */

describe("R2-F1 — action↔object association is segment-local, not whole-task", () => {
  const GOAL_DEL = "analyze XAUUSD strategy, do not delete report.md";

  it("F1.a — 'check report.md, then delete temp.txt' PASSes; 'check temp.txt, then delete report.md' FAILs", () => {
    const mk = (checkInstr: string) => [
      work("T1", "analyze XAUUSD strategy and write findings to report.md", ["REASONING", "FILE_OPERATIONS"], [], undefined, ["OBL_001"]),
      work("T2", checkInstr, ["REASONING"], ["T1"], undefined, []),
    ];
    expect(canon(mk("check report.md exists, then delete the scratch file"), GOAL_DEL).length).toBe(3);
    expectCode(() => canon(mk("check the scratch file exists, then delete report.md"), GOAL_DEL), VIOLATION);
  });

  it("F1.b — 'review martingale, then use fixed sizing' PASSes; 'review fixed sizing, then use martingale' FAILs", () => {
    const goal = "analyze XAUUSD strategy, do not use martingale";
    const ok = [
      work("T1", "analyze XAUUSD strategy and review martingale setups, then use fixed sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(ok, goal).length).toBe(2);
    const bad = [
      work("T1", "analyze XAUUSD strategy review, then use martingale", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
  });

  it("F1.c — 'use grid and martingale' still FAILs: and/or join an action's object list", () => {
    const bad = [
      work("T1", "analyze XAUUSD strategy and use grid and martingale", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, "analyze XAUUSD strategy, do not use martingale"), VIOLATION);
  });
});

describe("R2-F2 — bare 'không' requires a forbidden-action lead", () => {
  it("F2.a — 'phân tích EA không martingale' keeps the obligation, mints 0 prohibition", () => {
    const c = extractGoalContract("phân tích EA không martingale");
    expect(c.prohibitions).toHaveLength(0);
    expect(c.obligations.length).toBeGreaterThan(0);
  });

  it("F2.b — 'không có martingale' → obligation only; 'không dùng martingale' → obligation + PRO use", () => {
    const a = extractGoalContract("phân tích EA không có martingale");
    expect(a.prohibitions).toHaveLength(0);
    expect(a.obligations.length).toBeGreaterThan(0);
    const b = extractGoalContract("phân tích EA không dùng martingale");
    // the pre-trigger span mints the 'phân tích EA' obligation
    expect(b.obligations.length).toBeGreaterThan(0);
    expect(b.obligations[0].text).toContain("phân tích EA");
    expect(b.prohibitions).toHaveLength(1);
    expect(b.prohibitions[0].actionClass).toEqual(["use"]);
    expect(b.prohibitions[0].terms).toContain("martingale");
    // and it enforces
    expectCode(
      () => canon([work("T1", "phân tích EA và dùng martingale sizing", ["REASONING"], [], undefined, ["OBL_001"])], "phân tích EA không dùng martingale"),
      VIOLATION,
    );
  });

  it("F2.c — natural bans still mint; 'ngân sách không quá $50' is constraint only", () => {
    expect(extractGoalContract("analyze the market, không gửi Telegram").prohibitions).toHaveLength(1);
    expect(extractGoalContract("analyze the market, không xóa report.md").prohibitions).toHaveLength(1);
    const c = extractGoalContract("analyze XAUUSD strategy, ngân sách không quá $50");
    expect(c.prohibitions).toHaveLength(0);
    expect(c.constraints.map((r) => r.maxAmount)).toContain(50);
  });
});

describe("R2-F3 — multi-action prohibitions survive 'and/và' clause splitting", () => {
  it("F3.a — or/and/hoặc/và multi-action forms all mint [delete, modify] end-to-end", () => {
    for (const goal of [
      "do not delete or modify report.md",
      "do not delete and modify report.md",
      "không xóa hoặc sửa report.md",
      "không xóa và sửa report.md",
    ]) {
      const g = `analyze the market, ${goal}`;
      const c = extractGoalContract(g);
      expect(c.prohibitions).toHaveLength(1);
      expect(c.prohibitions[0].actionClass).toEqual(
        expect.arrayContaining(["delete", "modify"]),
      );
      expect(c.prohibitions[0].terms).toContain("report");
      expectCode(
        () => canon([work("T1", "analyze the market and modify report.md", ["REASONING"], [], undefined, ["OBL_001"])], g),
        VIOLATION,
      );
      expectCode(
        () => canon([work("T1", "analyze the market and delete report.md", ["REASONING"], [], undefined, ["OBL_001"])], g),
        VIOLATION,
      );
    }
  });

  it("F3.b — normal 'and' splitting still splits obligations (guard needs a trigger)", () => {
    const c = extractGoalContract("analyze the market and write report.md");
    expect(c.prohibitions).toHaveLength(0);
    expect(c.obligations.length).toBeGreaterThan(0);
    expect(c.deliverables.length).toBeGreaterThan(0); // 'write report.md' still mints DEL
  });
});

describe("R2-F4 — conditional markers are unicode-boundary safe", () => {
  it("F4.a — 'miễn là backup tồn tại, đừng gửi file' mints [send]+{file}; condition never a term", () => {
    const c = extractGoalContract("miễn là backup tồn tại, đừng gửi file");
    expect(c.prohibitions).toHaveLength(1);
    expect(c.prohibitions[0].actionClass).toEqual(["send"]);
    expect(c.prohibitions[0].terms).toEqual(["file"]);
  });

  it("F4.b — every VI marker cuts the tail: trừ khi / nếu / khi / miễn là / trong trường hợp", () => {
    for (const marker of ["trừ khi", "nếu", "khi", "miễn là", "trong trường hợp"]) {
      const c = extractGoalContract(`analyze the market, đừng gửi file ${marker} backup chưa xong`);
      expect(c.prohibitions).toHaveLength(1);
      expect(c.prohibitions[0].terms).toEqual(["file"]);
    }
  });

  it("F4.c — a marker inside a longer token never matches", () => {
    // 'minếu' contains 'nếu' mid-token — no marker, no tail cut
    const c = extractGoalContract("analyze the market, đừng gửi file minếu thiếu");
    expect(c.prohibitions[0].terms).toContain("minếu");
    // 'khinh' contains 'khi' — boundary blocks it
    const c2 = extractGoalContract("analyze the market, đừng gửi file khinh khí");
    expect(c2.prohibitions[0].terms).toContain("khinh");
  });
});

describe("R2-F5 — 'order/ordering' is not a trade act", () => {
  const GOAL_TRADE = "analyze XAUUSD strategy, do not trade";

  it("F5.a — data-ordering prose PASSes: 'order results by score', 'sort and order the candidates'", () => {
    for (const instr of [
      "analyze XAUUSD strategy and order results by score",
      "analyze XAUUSD strategy, sort and order the candidates",
    ]) {
      expect(canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_TRADE).length).toBe(2);
    }
  });

  it("F5.b — real trade acts still FAIL: 'place an order', 'trade/buy/sell XAUUSD'", () => {
    for (const instr of [
      "analyze XAUUSD strategy and place an order",
      "analyze XAUUSD strategy and trade XAUUSD",
      "analyze XAUUSD strategy and buy XAUUSD",
      "analyze XAUUSD strategy and sell XAUUSD",
    ]) {
      expectCode(() => canon([work("T1", instr, ["REASONING"], [], undefined, ["OBL_001"])], GOAL_TRADE), VIOLATION);
    }
  });
});
