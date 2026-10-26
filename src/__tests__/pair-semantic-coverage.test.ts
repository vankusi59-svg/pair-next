/**
 * Semantic & Context-Aware Planning V1 — D′ coverage semantics.
 * Deterministic matcher extensions: outcome obligations are covered by
 * fulfillment evidence (outcome or fulfill verb class + subject binding
 * + quantity floor), never by preparation-only tasks; thousands-grouped
 * quantities ("1,000" / VI "1.000") count at true magnitude; EN/VI
 * equivalent goals mint equivalent contracts. All checks are
 * deterministic — no model verdict mints coverage.
 */
import { describe, expect, it } from "vitest";
import { extractGoalContract } from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import { IntegrityError } from "../pair/errors.js";

const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
} as const;

const work = (
  key: string,
  instruction: string,
  caps: string[] = ["REASONING"],
  depends_on: string[] = [],
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  metadata: { network_requirement: NETREQ_LOCAL },
});

const GOAL_EN =
  "Grow my Telegram channel by 1,000 genuine subscribers within 30 days";
const GOAL_VI =
  "Tăng thêm 1.000 người đăng ký thật cho kênh Telegram trong vòng 30 ngày";

describe("SEM-COV — outcome obligation coverage", () => {
  it("SC-1 — EN outcome goal mints one obligation with quantity floor 1000 and a deadline", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(1000);
    expect(c.deadline).toBeTruthy();
  });

  it("SC-2 — VI equivalent goal mints the same contract shape (quantity 1000 + deadline)", () => {
    const c = extractGoalContract(GOAL_VI);
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(1000);
    expect(c.deadline).toBeTruthy();
  });

  it("SC-3 — fulfillment task covers the EN outcome obligation", () => {
    const c = extractGoalContract(GOAL_EN);
    const r = assertPlanCoverage(c, [
      work(
        "T1",
        "Execute the authorized Telegram channel growth campaign targeting at least 1,000 genuine subscribers",
      ),
    ]);
    const row = r.rows.find((x) => x.kind === "obligation")!;
    expect(row.state).toBe("PROVEN");
    expect(row.task_keys).toContain("T1");
  });

  it("SC-4 — preparation-only task NEVER covers an outcome obligation (research ≠ fulfillment)", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work(
          "T1",
          "Research Telegram growth strategies and summarize the findings",
        ),
      ]),
    ).toThrowError(IntegrityError);
  });

  it("SC-5 — fulfillment task covers the VI outcome obligation", () => {
    const c = extractGoalContract(GOAL_VI);
    const r = assertPlanCoverage(c, [
      work(
        "T1",
        "Thực hiện chiến dịch tăng trưởng kênh Telegram đạt tối thiểu 1.000 người đăng ký thật",
      ),
    ]);
    const row = r.rows.find((x) => x.kind === "obligation")!;
    expect(row.state).toBe("PROVEN");
  });

  it("SC-6 — quantity floor honors grouped forms: 999 fails, '1,000' passes, VI '1.000' passes", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work("T1", "Grow the Telegram channel by 999 genuine subscribers"),
      ]),
    ).toThrowError(IntegrityError);
    const ok = assertPlanCoverage(c, [
      work("T1", "Grow the Telegram channel by 1,000 genuine subscribers"),
    ]);
    expect(ok.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
    const cv = extractGoalContract(GOAL_VI);
    const okVi = assertPlanCoverage(cv, [
      work(
        "T1",
        "Tăng trưởng kênh Telegram thêm 1.000 người đăng ký thật",
      ),
    ]);
    expect(okVi.rows.find((x) => x.kind === "obligation")!.state).toBe(
      "PROVEN",
    );
  });

  it("SC-7 — 'without' clause mints a prohibition the plan must honor", () => {
    const c = extractGoalContract(
      "Grow Telegram subscribers without bots or unsolicited messages",
    );
    expect(c.prohibitions.length).toBeGreaterThanOrEqual(1);
  });

  it("SC-8 — subject mismatch cannot fabricate outcome coverage", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work(
          "T1",
          "Execute a subscriber growth campaign for the Discord server reaching 5,000 members",
        ),
      ]),
    ).toThrowError(IntegrityError);
  });

  it("SC-9 — mixed EN/VI goal mints obligation + deadline (cross-language comprehension)", () => {
    const c = extractGoalContract("Attract 200 real leads trong vòng 2 tuần");
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(200);
    expect(c.deadline).toBeTruthy();
  });
});
