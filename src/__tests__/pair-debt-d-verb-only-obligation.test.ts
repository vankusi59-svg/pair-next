/**
 * DEBT D — verb-only VI obligation coverage (live EXHAUSTED incident).
 *
 * Goal Contract clause-splitting minted a standalone verb-only VI
 * obligation ("so sánh") — no subject anchors, no external subject
 * keys, no usable content tokens — so `taskCoversObligation`'s
 * subject-evidence branch could NEVER be satisfied (dead obligation →
 * FAIL_CLOSED_PLAN_INCOMPLETE on every plan → re-ask → EXHAUSTED).
 * Fix: when the obligation carries no subject evidence at all AND it
 * exercised a verb class, the same-class verb in the task is sufficient
 * evidence. Obligations that DO name a subject keep the fail-closed
 * subject-evidence requirement.
 */
import { describe, expect, it } from "vitest";
import { extractGoalContract, type GoalContract } from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import { IntegrityError } from "../pair/errors.js";

const INCIDENT_GOAL =
  "Nghiên cứu song song hai phần: một task phân tích xu hướng EA MT5 hiện tại trên mql5.com, một task nghiên cứu các repository EA/algorithmic trading liên quan trên github.com. Mỗi task phải tạo artifact riêng trong outbox/. Sau khi cả hai hoàn tất, một task thứ ba đọc cả hai artifact, so sánh và tạo outbox/opportunity_report.md. Không gửi Telegram.";

function expectCode(fn: () => unknown, code: string): IntegrityError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrityError);
    expect(String((e as IntegrityError).code ?? "")).toBe(code);
    return e as IntegrityError;
  }
  throw new Error(`expected ${code}`);
}

function contractWith(
  obligations: Array<{ id: string; text: string }>,
  deliverables: Array<{ id: string; target: string }> = [],
): GoalContract {
  const base = extractGoalContract(INCIDENT_GOAL);
  return {
    ...base,
    obligations: obligations.map((o) => ({
      id: o.id,
      kind: "obligation",
      text: o.text,
    })),
    deliverables: deliverables.map((d) => ({
      id: d.id,
      kind: "deliverable",
      text: `tạo ${d.target}`,
      target: d.target,
    })),
    constraints: [],
    prohibitions: [],
  };
}

const work = (
  key: string,
  instruction: string,
  caps: string[] = ["REASONING"],
  metadata?: Record<string, unknown>,
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on: [],
  ...(metadata ? { metadata } : {}),
});

describe("DEBT D — verb-only VI obligation coverage", () => {
  it("D1 — 'so sánh' + task có compare verb → PASS (trước: dead obligation)", () => {
    const c = contractWith([{ id: "OBL_001", text: "so sánh" }]);
    const report = assertPlanCoverage(c, [
      work("T1", "So sánh xu hướng EA MT5 hiện tại với các repository liên quan."),
    ]);
    expect(report.rows[0]?.state).toBe("PROVEN");
  });

  it("D2 — 'tóm tắt' + task có summarize verb → PASS", () => {
    const c = contractWith([{ id: "OBL_001", text: "tóm tắt" }]);
    assertPlanCoverage(c, [
      work("T1", "Tóm tắt kết quả nghiên cứu thành các ý chính."),
    ]);
  });

  it("D3 — verb-only VI khác: 'phân tích' + analyze task → PASS", () => {
    const c = contractWith([{ id: "OBL_001", text: "phân tích" }]);
    assertPlanCoverage(c, [
      work("T1", "Phân tích kết quả thu thập được từ nguồn."),
    ]);
  });

  it("D4 — verb-only nhưng task KHÔNG cùng verb class → vẫn FAIL", () => {
    const c = contractWith([{ id: "OBL_001", text: "so sánh" }]);
    expectCode(
      () =>
        assertPlanCoverage(c, [
          work("T1", "Ghi kết quả vào outbox/report.md.", ["FILE_OPERATIONS"]),
        ]),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("D5 — obligation có subject/content + task đúng subject → PASS (fail-closed path giữ nguyên)", () => {
    const c = contractWith([
      { id: "OBL_001", text: "so sánh giá sản phẩm A và giá sản phẩm B" },
    ]);
    assertPlanCoverage(c, [
      work("T1", "So sánh giá sản phẩm A với giá sản phẩm B chi tiết."),
    ]);
  });

  it("D6 — obligation có subject/content nhưng task về subject KHÁC → FAIL", () => {
    const c = contractWith([
      { id: "OBL_001", text: "so sánh giá sản phẩm A và giá sản phẩm B" },
    ]);
    expectCode(
      () =>
        assertPlanCoverage(c, [
          work("T1", "So sánh doanh số khu vực C với khu vực D."),
        ]),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("D7 — bookkeeping task không được claim coverage (invariant giữ nguyên)", () => {
    const c = contractWith([{ id: "OBL_001", text: "so sánh" }]);
    const bk = work(
      "T0",
      "Write the goal to mission_goal.txt, then reply DONE.",
      ["AUTOMATON_TASK_EXECUTION"],
      { pair_coverage: ["OBL_001"] },
    );
    expectCode(
      () =>
        assertPlanCoverage(c, [
          bk,
          work("T1", "So sánh xu hướng EA MT5 với repository github."),
        ]),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("D8 — fabricated coverage map vẫn throw: claim OBL task không thực hiện", () => {
    const c = contractWith([{ id: "OBL_001", text: "so sánh" }]);
    expectCode(
      () =>
        assertPlanCoverage(c, [
          work("T1", "So sánh xu hướng EA MT5 với repository liên quan."),
          work("T2", "Ghi vào outbox/x.md.", ["FILE_OPERATIONS"], {
            pair_coverage: ["OBL_001"],
          }),
        ]),
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });
});

/* ----------------------- incident-level acceptance ----------------------- */

describe("incident acceptance — goal production nguyên văn", () => {
  it("E2E — goal mint đủ hosts + obligation 'so sánh' cover được + plan 3-task pass coverage", () => {
    const contract = extractGoalContract(INCIDENT_GOAL);
    const oblSoSanh = contract.obligations.find((o) => o.text === "so sánh");
    expect(oblSoSanh).toBeDefined();

    // Plan tương đương sol đã emit (3 task — bookkeeping staging lược bỏ).
    const plan = [
      work(
        "T1",
        "Fetch current EA MT5 information exclusively from mql5.com. Phân tích xu hướng EA MT5 hiện tại trên mql5.com. Write findings to outbox/mql5_trends.md, then reply DONE.",
        ["NETWORK_ACCESS", "REASONING"],
      ),
      work(
        "T2",
        "Fetch current repository information exclusively from https://github.com. Nghiên cứu các repository EA/algorithmic trading liên quan trên https://github.com. Write findings to outbox/github_research.md, then reply DONE.",
        ["NETWORK_ACCESS", "REASONING"],
      ),
      work(
        "T3",
        "Read outbox/mql5_trends.md and outbox/github_research.md. So sánh xu hướng EA MT5 hiện tại trên mql5.com với các repository EA/algorithmic trading liên quan trên https://github.com. Write the comparison to outbox/opportunity_report.md, then reply DONE.",
      ),
    ];
    const report = assertPlanCoverage(contract, plan);
    const oblRow = report.rows.find((r) => r.requirement_id === oblSoSanh!.id);
    expect(oblRow?.state).toBe("PROVEN");
    expect(oblRow?.task_keys).toContain("T3");
  });
});
