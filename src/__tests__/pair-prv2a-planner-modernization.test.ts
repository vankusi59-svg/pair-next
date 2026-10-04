/**
 * PRV2-A — Planner Capability Modernization.
 *
 * 1  current-data research goal is no longer hard-coded to remote solely
 *    because it requires Internet;
 * 2  software build goal is no longer forced to REMOTE_CLOUD_TASK_EXECUTION;
 * 3  planner prompt never names/selects an executor;
 * 4  local chart task can remain a compute/code task (no forced remote);
 * 5  bookkeeping task is PAIR-injected even when model emits work only;
 * 6  final canonical keys are deterministic (T1 bookkeeping, T2..Tn work);
 * 7  dependencies are correctly remapped after bookkeeping insertion;
 * 8  planner cannot create duplicate bookkeeping authority;
 * 9  Telegram goal phrasing does not contaminate bookkeeping instruction;
 * 10 simple goal respects small work-task budget;
 * 11 complex goal may exceed the previous 5-task total limit;
 * 12 hard ceiling of 12 work tasks is enforced;
 * (13–16 = the existing suites, exercised in regression.)
 */
import { describe, expect, it } from "vitest";
import {
  deriveWorkTaskBudget,
  resolveWorkTaskBudget,
  buildPlannerUserPrompt,
  plannerSystemPrompt,
  WORK_TASK_HARD_CEILING,
} from "../pair/llm-planner.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  canonicalBookkeepingTask,
} from "../pair/serve-planner.js";
import { CANONICAL_BOOKKEEPING_INSTRUCTION } from "../pair/plan-dataflow.js";

/** One executor covering the whole allowed vocabulary → no task is ever
 *  dropped on joint-servability grounds. */
const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];
const canon = (raw: Array<Record<string, unknown>>, goal: string) =>
  makeServeCanonicalizer({ executorCapSets: () => FULL_SETS })(raw, goal);

const work = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
  metadata?: Record<string, unknown>,
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  ...(metadata ? { metadata } : {}),
});

const bookkeepingShaped = (key: string) =>
  work(key, "Write the goal to mission_goal.txt, then reply DONE.", [
    "AUTOMATON_TASK_EXECUTION",
  ]);

/* ---------------- A/B/C — prompt modernization ---------------- */

describe("PRV2-A prompt", () => {
  const prompt = plannerSystemPrompt();

  it("1. current-data research is no longer hard-coded to remote solely for internet", () => {
    expect(prompt).not.toContain("local executors have NO internet");
    expect(prompt).not.toContain("local executors cannot fetch");
    // the live-data bullet must not order a remote capability
    const liveData = prompt.split("\n").find((l) => l.includes("CURRENT/EXTERNAL DATA"))!;
    expect(liveData).not.toContain("MUST use REMOTE_CLOUD_TASK_EXECUTION");
    expect(liveData).toContain("capabilities sufficient");
    expect(liveData).toContain("Mission Router");
  });

  it("2. software build work is no longer forced to REMOTE_CLOUD_TASK_EXECUTION", () => {
    expect(prompt).not.toContain("CANNOT code real software");
    expect(prompt).not.toContain("produces documentation instead of a product");
    const sw = prompt.split("\n").find((l) => l.includes("SOFTWARE WORK"))!;
    expect(sw).not.toContain("MUST use REMOTE_CLOUD_TASK_EXECUTION");
    expect(sw).toContain("CODE_GENERATION");
    expect(sw).toContain("PYTHON_EXECUTION");
  });

  it("3. planner never names/selects an executor", () => {
    expect(prompt).not.toMatch(/\bDevin\b/);
    expect(prompt).not.toMatch(/\bDSH\b/);
    expect(prompt).not.toMatch(/\bCodex\b/);
    expect(prompt).toContain("router");
    expect(prompt).toContain("never name an executor");
  });

  it("4. a chart from plan-produced data is ordinary compute work, not forced remote", () => {
    const visual = prompt.split("\n").find((l) => l.includes("VISUAL DELIVERABLES"))!;
    expect(visual).toContain("PYTHON_EXECUTION");
    expect(visual).not.toContain("must capture it with its browser");
    // remote-produced visuals still must upload (unchanged dataflow truth)
    expect(visual).toContain("outbox");
  });

  it("D-prompt. model is told to emit work tasks only; AUTOMATON is reserved", () => {
    expect(prompt).not.toContain(
      "Always include a first task T1 that records the goal",
    );
    expect(prompt).toContain("PAIR injects its own bookkeeping task");
    expect(prompt).toContain("NEVER request AUTOMATON_TASK_EXECUTION");
  });

  it("E-prompt. over-planning guidance is present", () => {
    expect(prompt).toContain("distinct deliverable");
    expect(prompt).toContain("capability boundary");
    expect(prompt).toContain("microtasks");
  });
});

/* ---------------- D — PAIR-owned bookkeeping injection ---------------- */

describe("PRV2-A bookkeeping injection", () => {
  const goal = "analyze gold price and write report to report.txt";

  it("5. bookkeeping is injected even when the model emits only work tasks", () => {
    const out = canon(
      [
        work("T1", "research gold price drivers, write findings to findings.txt", ["REASONING"]),
        work("T2", "read findings.txt and write report.txt", ["FILE_OPERATIONS"], ["T1"]),
      ],
      goal,
    );
    expect(out[0].task_key).toBe("T1");
    expect(out[0].required_capabilities).toEqual(["AUTOMATON_TASK_EXECUTION"]);
    expect(out[0].task_instruction).toBe(CANONICAL_BOOKKEEPING_INSTRUCTION);
  });

  it("6. final canonical keys are deterministic: T1 bookkeeping, T2..Tn work", () => {
    const out = canon(
      [
        work("T1", "research x", ["REASONING"]),
        work("T2", "write out.txt", ["FILE_OPERATIONS"], ["T1"]),
        work("T3", "review out.txt", ["REASONING"], ["T2"]),
      ],
      goal,
    );
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(out.slice(1).map((t) => t.task_key)).toEqual(["T2", "T3", "T4"]);
  });

  it("7. dependencies are remapped after insertion (work dep shifts; bookkeeping dep → T1)", () => {
    const out = canon(
      [
        bookkeepingShaped("T1"),
        work("T2", "research drivers", ["REASONING"], ["T1"]),
        work("T3", "write report.txt", ["FILE_OPERATIONS"], ["T2"]),
      ],
      goal,
    );
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
    // old T2 (depended on emitted bookkeeping T1) → new T2 depends on PAIR T1
    expect(out[1].task_key).toBe("T2");
    expect(out[1].depends_on).toEqual(["T1"]);
    // old T3 → new T3 depends on remapped T2
    expect(out[2].depends_on).toEqual(["T2"]);
  });

  it("8. model cannot create duplicate bookkeeping authority", () => {
    const out = canon(
      [
        bookkeepingShaped("T1"),
        bookkeepingShaped("T2"),
        work("T3", "research and write report.txt", ["REASONING", "FILE_OPERATIONS"], ["T1"]),
      ],
      goal,
    );
    const bk = out.filter((t) =>
      (t.required_capabilities as string[]).every(
        (c) => c === "AUTOMATON_TASK_EXECUTION",
      ),
    );
    expect(bk).toHaveLength(1);
    expect(bk[0].task_key).toBe("T1");
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2"]);
  });

  it("8b. bookkeeping-only output → zero usable work → canonicalize rejects", () => {
    expect(canon([bookkeepingShaped("T1")], goal)).toEqual([]);
  });

  it("9. Telegram phrasing in the goal never leaks into bookkeeping instruction", () => {
    const tgGoal = "write analysis.txt and gửi analysis.txt tới telegram";
    const out = canon(
      [
        work("T1", "research and write analysis.txt", ["REASONING"]),
        work(
          "T2",
          "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
          ["TELEGRAM_DELIVERY"],
          ["T1"],
        ),
      ],
      tgGoal,
    );
    expect(out[0].task_instruction).toBe(CANONICAL_BOOKKEEPING_INSTRUCTION);
    expect(out[0].task_instruction).not.toContain("telegram");
    // the goal text lives in the worker_spec payload (verbatim), not the directive
    const spec = (
      (out[0].metadata as Record<string, unknown>)
        .expected_output_contract as Record<string, unknown>
    ).worker_spec as { ops: Array<{ op: string; content?: string }> };
    expect(spec.ops[0].content).toBe(tgGoal);
  });
});

/* ---------------- E — adaptive work-task budget ---------------- */

describe("PRV2-A adaptive budget", () => {
  it("10. simple goal → small budget (≤4 work tasks)", () => {
    expect(deriveWorkTaskBudget("analyze gold price")).toBe(4);
    const raw = Array.from({ length: 6 }, (_, i) =>
      work(`T${i + 1}`, `step ${i + 1}`, ["REASONING"]),
    );
    const out = canon(raw, "analyze gold price");
    expect(out).toHaveLength(5); // T1 bookkeeping + 4 work
    expect(out.slice(1).map((t) => t.task_key)).toEqual(["T2", "T3", "T4", "T5"]);
  });

  it("11. complex goal may exceed the previous 5-task total limit", () => {
    const goal =
      "1. fetch BTC ETH prices 2. fetch gold XAU 3. draw comparison chart " +
      "4. gather latest news 5. analyze correlation 6. write report.md " +
      "7. write summary.md and finally gửi báo cáo tới telegram, " +
      "và đề xuất cải tiến EA strategy";
    expect(deriveWorkTaskBudget(goal)).toBeGreaterThanOrEqual(6);
    const raw = Array.from({ length: 5 }, (_, i) =>
      work(`T${i + 1}`, `step ${i + 1}`, ["REASONING"], i ? [`T${i}`] : []),
    );
    raw.push(
      work(
        "T6",
        "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
        ["TELEGRAM_DELIVERY"],
        ["T5"],
      ),
    );
    const out = canon(raw, goal);
    expect(out.length).toBeGreaterThan(5); // > old 5-task total
    expect(out.slice(1).length).toBeGreaterThan(5);
  });

  it("12. hard ceiling of 12 work tasks is enforced", () => {
    const goal = "x ".repeat(400); // score ≫ complex
    expect(resolveWorkTaskBudget(goal, 999)).toBeLessThanOrEqual(
      WORK_TASK_HARD_CEILING,
    );
    expect(deriveWorkTaskBudget(goal)).toBeLessThanOrEqual(
      WORK_TASK_HARD_CEILING,
    );
    const raw = Array.from({ length: 14 }, (_, i) =>
      work(`T${i + 1}`, `step ${i}`, ["REASONING"], i ? [`T${i}`] : []),
    );
    const out = canon(raw, goal);
    expect(out.slice(1).length).toBeLessThanOrEqual(WORK_TASK_HARD_CEILING);
  });

  it("E-rule. budget derivation is deterministic and bounded", () => {
    const g = "write a report on gold and send it, then analyze results";
    expect(deriveWorkTaskBudget(g)).toBe(deriveWorkTaskBudget(g));
    expect(resolveWorkTaskBudget(g, 2)).toBe(2); // configured cap tightens
    expect(resolveWorkTaskBudget(g, 0)).toBeGreaterThanOrEqual(1);
  });
});

/* ---------------- canonicalBookkeepingTask determinism ---------------- */

describe("PRV2-A canonical bookkeeping task", () => {
  it("is deterministic (pinned plan / replay stable)", () => {
    const a = canonicalBookkeepingTask("g");
    const b = canonicalBookkeepingTask("g");
    expect(a).toEqual(b);
    expect(a.task_instruction).toBe(CANONICAL_BOOKKEEPING_INSTRUCTION);
  });
});
