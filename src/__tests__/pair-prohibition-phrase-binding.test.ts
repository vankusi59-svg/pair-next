/**
 * PROHIBITION PHRASE BINDING — production-failure repair.
 *
 * Live-stack regression: term-only prohibition enforcement OR-matched
 * every extracted token, so a Vietnamese ban like
 *   "không được hứa lợi nhuận hoặc tư vấn tài chính"
 * minted terms [hứa, lợi, nhuận, vấn, tài, chính] and poisoned EVERY
 * Vietnamese plan through common words (tài liệu, vấn đề, quá trình)
 * → PLAN_CONSTRAINT_VIOLATION on all attempts → planner EXHAUSTED →
 * auto-driver BLOCKED_RETRY_EXHAUSTED.
 *
 * The fix mints `phrases` — connector-delimited object groups —
 * alongside `terms`; enforcement matches the phrase, never a lone
 * token inside it:
 *  - extraction splits object groups on and/or/và/hoặc;
 *  - benign Vietnamese wording no longer violates;
 *  - actually invoking the prohibited phrase still fails closed;
 *  - bounded function-word gaps keep variants caught
 *    ("tư vấn và tài chính" still hits `tư vấn tài chính`);
 *  - a negated mention declares compliance, never performs the act;
 *  - extraction stays deterministic (same input → same contract).
 */
import { describe, expect, it } from "vitest";
import { extractGoalContract } from "../pair/goal-contract.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
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

const GOAL_VI =
  "viết báo cáo phân tích vào report.md, không được hứa lợi nhuận hoặc tư vấn tài chính";

/* ---------------- extraction: phrases minted alongside terms -------- */

describe("phrase-binding A — extraction", () => {
  it("A1 — VI ban mints connector-delimited phrases, terms unchanged, no actionClass", () => {
    const c = extractGoalContract(GOAL_VI);
    expect(c.prohibitions).toHaveLength(1);
    const p = c.prohibitions[0];
    expect(p.phrases).toEqual(["hứa lợi nhuận", "tư vấn tài chính"]);
    // `terms` projection is preserved for capability gates/prompts —
    // every content token still lands there.
    for (const w of ["hứa", "lợi", "nhuận", "vấn", "tài", "chính"]) {
      expect(p.terms ?? []).toContain(w);
    }
    expect(p.actionClass ?? []).toHaveLength(0);
  });

  it("A2 — single-object prohibition mints a single-token phrase", () => {
    const c = extractGoalContract("analyze XAUUSD, do not use martingale");
    const p = c.prohibitions[0];
    expect(p.phrases).toEqual(["martingale"]);
    expect(p.terms).toEqual(["martingale"]);
  });

  it("A3 — extraction is deterministic: same input → same phrases", () => {
    const a = extractGoalContract(GOAL_VI).prohibitions;
    const b = extractGoalContract(GOAL_VI).prohibitions;
    expect(a).toEqual(b);
  });

  it("A4 — 'tự' is a stopword: 'tự bịa dữ liệu' mints object 'dữ liệu'", () => {
    const c = extractGoalContract("không được tự bịa dữ liệu");
    expect(c.prohibitions[0].phrases).toEqual(["dữ liệu"]);
  });
});

/* ---------------- enforcement: the production poison case ----------- */

describe("phrase-binding B — enforcement", () => {
  it("B1 — benign Vietnamese wording no longer violates (the live poison)", () => {
    // Exact failure shape from production: common words tài liệu /
    // vấn đề / quá trình each hit a different single prohibition term.
    const plan = [
      work(
        "T1",
        "đọc tài liệu tham khảo và phân tích vấn đề trong quá trình nghiên cứu rồi viết báo cáo vào report.md",
        ["REASONING"],
        [],
        undefined,
        ["OBL_001","DEL_001"],
      ),
    ];
    expect(canon(plan, GOAL_VI).length).toBe(2);
  });

  it("B2 — task that actually performs the banned act fails closed", () => {
    for (const instr of [
      "viết báo cáo phân tích vào report.md rồi hứa lợi nhuận cho người xem",
      "viết báo cáo phân tích vào report.md và tư vấn tài chính cho khán giả",
      "viết báo cáo phân tích vào report.md, soạn bài tư vấn và tài chính cá nhân",
    ]) {
      const bad = [
        work("T1", instr, ["REASONING"], [], undefined, ["OBL_001","DEL_001"]),
      ];
      expectCode(() => canon(bad, GOAL_VI), VIOLATION);
    }
  });

  it("B3 — negated mention declares compliance, never performs the act", () => {
    const plan = [
      work(
        "T1",
        "đảm bảo không hứa lợi nhuận, luôn nêu rủi ro khi viết báo cáo phân tích vào report.md",
        ["REASONING"],
        [],
        undefined,
        ["OBL_001","DEL_001"],
      ),
    ];
    expect(canon(plan, GOAL_VI).length).toBe(2);
  });

  it("B4 — partial phrase fragments do not satisfy the ban", () => {
    // Lone "tài" / "vấn" / "nhuận" tokens in unrelated wording.
    const plan = [
      work(
        "T1",
        "biên soạn tài liệu hướng dẫn, liệt kê vấn đề thường gặp và ghi chú nhuận theo quý vào report.md",
        ["REASONING"],
        [],
        undefined,
        ["OBL_001","DEL_001"],
      ),
    ];
    expect(canon(plan, GOAL_VI).length).toBe(2);
  });
});

/* ---------------- EN regression spot-checks ------------------------- */

describe("phrase-binding C — English behaviour preserved", () => {
  it("C1 — 'do not use leverage' still blocks use of leverage", () => {
    const goal = "analyze XAUUSD strategy, do not use leverage";
    const bad = [
      work("T1", "analyze XAUUSD strategy and use leverage", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
    const ok = [
      work("T1", "analyze XAUUSD strategy with fixed sizing", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(ok, goal).length).toBe(2);
  });

  it("C2 — 'do not deploy to production' still blocks deploys", () => {
    const goal = "analyze release risk, do not deploy to production";
    const bad = [
      work("T1", "analyze release risk then deploy to production", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
  });

  it("C3 — 'do not delete report.md' blocks delete, passes write", () => {
    const goal = "write summary, do not delete report.md";
    const bad = [
      work("T1", "write summary and delete report.md", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expectCode(() => canon(bad, goal), VIOLATION);
    const ok = [
      work("T1", "write report.md with the weekly summary", ["REASONING"], [], undefined, ["OBL_001"]),
    ];
    expect(canon(ok, goal).length).toBe(2);
  });
});
