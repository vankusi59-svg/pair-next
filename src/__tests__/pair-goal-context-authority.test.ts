/** GOAL/AGENT-CONTEXT AUTHORITY BOUNDARY — regression matrix.
 *
 * boundMissionGoal composes a delegated mission goal as a provenance
 * envelope: `[BUSINESS … | DEPT … | AGENT …]` header + the operator goal
 * + an appended `[AGENT CONTEXT — last N outcomes]` section of history
 * bullets (`- [delegated] …`). Those appended sections are planning
 * context, never operator requirements. On the broken implementation a
 * history bullet leading with a work verb ("Fetch and save GitHub Zen
 * response", "Viết báo cáo …") minted fabricated OBL_x/DEL_x
 * requirements → assertPlanCoverage FAIL_CLOSED_PLAN_INCOMPLETE →
 * PLANNER_RUN_EXHAUSTED → Objective INTEGRITY_FAULT.
 *
 * Contract under test: only the authoritative operator goal may mint
 * obligations, deliverables, constraints, or prohibitions. The
 * distinction is STRUCTURAL (bracketed-header + bullet-body sections
 * after the operator text are machine context), never lexical — no
 * phrase is singled out. The enriched text still reaches the planner
 * prompt verbatim. */
import { describe, expect, it } from "vitest";
import {
  authoritativeGoalText,
  extractGoalContract,
} from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";

const HEADER = "[BUSINESS Demo Co | DEPT ops | AGENT Demo Agent (ops)]";
const GOAL =
  "Send one HTTP GET request to https://api.github.com/zen and save the response body to zen.txt";

const enriched = (notes: string[], goal = GOAL) =>
  `${HEADER}\n${goal}\n\n[AGENT CONTEXT — last ${notes.length} outcomes]\n${notes
    .map((n) => `- ${n}`)
    .join("\n")}`;

const reqs = (goal: string) => {
  const c = extractGoalContract(goal);
  return {
    obligations: c.obligations.map((o) => o.text),
    deliverables: c.deliverables.map((d) => d.target),
    constraints: c.constraints.map((o) => o.text),
    prohibitions: c.prohibitions.map((p) => p.text),
    delivery: c.delivery_intent,
    objective: c.objective,
  };
};

/** The plan the real planner emitted for GOAL — one NETWORK_ACCESS task
 *  that fetches the endpoint and saves zen.txt. Covers exactly the
 *  operator's stated work and nothing else. */
const PLAN = [
  {
    task_id: "T1",
    name: "Fetch and save GitHub Zen",
    task_instruction:
      "Send HTTP GET to https://api.github.com/zen, save body to zen.txt",
    required_capabilities: ["NETWORK_ACCESS"],
  },
];

const covers = (goal: string) => {
  try {
    assertPlanCoverage(extractGoalContract(goal), PLAN);
    return "PASS";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

describe("goal/agent-context authority boundary — bare goals unchanged", () => {
  it("bare operator goal mints exactly its own requirements", () => {
    const r = reqs(GOAL);
    expect(r.obligations).toEqual([]);
    expect(r.deliverables).toEqual(["zen.txt"]);
    expect(r.constraints).toEqual([]);
    expect(r.prohibitions).toEqual([]);
  });

  it("bare operator goal covers the honest plan", () => {
    expect(covers(GOAL)).toBe("PASS");
  });
});

describe("goal/agent-context authority boundary — history notes mint nothing", () => {
  it("enriched goal mints the SAME requirements as the bare goal (non-vacuous: fabricated OBL on baseline)", () => {
    const bare = reqs(GOAL);
    const rich = reqs(
      enriched(["[delegated] Fetch and save GitHub Zen response"]),
    );
    expect(rich).toEqual(bare);
    // non-vacuous: the baseline minted OBL_001 from this note
    expect(rich.obligations).toEqual([]);
  });

  it("enriched goal covers the honest plan — was FAIL_CLOSED_PLAN_INCOMPLETE", () => {
    expect(
      covers(enriched(["[delegated] Fetch and save GitHub Zen response"])),
    ).toBe("PASS");
  });

  it("multiple history notes — EN + VI — mint nothing extra", () => {
    const r = reqs(
      enriched([
        "[delegated] Fetch and save GitHub Zen response",
        "[delegated] Viết báo cáo ngắn và lưu vào out.md",
        "[delegated] Create summary.txt and send it via telegram",
        "[completed] Tạo checklist.md cho release",
      ]),
    );
    expect(r.obligations).toEqual([]);
    expect(r.deliverables).toEqual(["zen.txt"]);
    expect(r.constraints).toEqual([]);
    expect(r.prohibitions).toEqual([]);
    // a note saying "send … via telegram" is a past outcome record,
    // never a delivery request
    expect(r.delivery.requested).toBe(false);
  });

  it("context notes do not turn into the contract objective", () => {
    const r = reqs(enriched(["[delegated] Write README.md"]));
    expect(r.objective).not.toContain("README.md");
    expect(r.objective).not.toContain("AGENT CONTEXT");
    expect(r.objective).not.toContain("BUSINESS");
  });
});

describe("goal/agent-context authority boundary — genuine operator authority preserved", () => {
  it("operator obligations still mint inside an enriched envelope", () => {
    const r = reqs(
      `${HEADER}\nResearch three competitors and write findings.md\n\n[AGENT CONTEXT — last 1 outcomes]\n- [delegated] Fetch pricing page`,
    );
    expect(r.obligations.length).toBeGreaterThan(0);
    expect(r.deliverables).toEqual(["findings.md"]);
  });

  it("operator prohibitions still mint inside an enriched envelope", () => {
    const r = reqs(
      `${HEADER}\nSummarize notes.md. Never delete input.csv\n\n[AGENT CONTEXT — last 1 outcomes]\n- [delegated] Create draft.md`,
    );
    expect(r.prohibitions.length).toBe(1);
    expect(r.deliverables).not.toContain("draft.md");
  });

  it("uncovered genuine operator requirements still fail closed", () => {
    const goal =
      "Send HTTP GET to https://api.github.com/zen, save body to zen.txt, and also create extra.md";
    expect(covers(enriched(["[delegated] Fetch something"], goal))).toBe(
      "FAIL_CLOSED_PLAN_INCOMPLETE",
    );
  });

  it("operator-authored bullet goals keep full authority (no header above them)", () => {
    const r = reqs("- Write a.md\n- Write b.md");
    expect(r.deliverables).toEqual(["a.md", "b.md"]);
  });
});

describe("authoritativeGoalText — structural projection", () => {
  it("strips the provenance header and appended metadata sections", () => {
    expect(
      authoritativeGoalText(
        enriched(["[delegated] x", "[delegated] y"], GOAL),
      ),
    ).toBe(GOAL);
  });

  it("keeps operator bullets in the leading block", () => {
    expect(authoritativeGoalText(`${HEADER}\n- Write a.md`)).toBe(
      "- Write a.md",
    );
  });

  it("drops every trailing bracketed-header bullet section", () => {
    const g = `${GOAL}\n\n[AGENT CONTEXT — last 1 outcomes]\n- [delegated] x\n\n[ROUTINE HINTS]\n- use curl`;
    expect(authoritativeGoalText(g)).toBe(GOAL);
  });

  it("keeps a plain trailing bullet block with no section header", () => {
    const g = `${GOAL}\n\n- Also write extra.md`;
    expect(authoritativeGoalText(g)).toBe(g);
  });
});
