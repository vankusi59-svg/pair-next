/**
 * pair-llm-planner.test.ts — P-UI-6 LLM planner proposal tests.
 * Deterministic only: fetchFn injected; no live calls.
 */
import { describe, expect, it } from "vitest";
import { fallbackTasks, llmPlan, sanitizePlan } from "../pair/llm-planner.js";

const CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
];

const CFG = {
  endpoint: "https://example.invalid/chat/completions",
  credentialEnv: "TEST_LLM_KEY",
  model: "test-model",
  allowedCapabilities: CAPS,
  env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
};

const okFetch = (content: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

const VALID_PLAN = JSON.stringify({
  tasks: [
    {
      task_key: "T1",
      title: "record",
      task_instruction: "Write the goal to mission_goal.txt, then reply DONE.",
      required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
      depends_on: [],
    },
    {
      task_key: "T2",
      title: "analyze",
      task_instruction: "Read mission_goal.txt, write analysis.txt, then reply DONE.",
      required_capabilities: ["REASONING"],
      depends_on: ["T1"],
    },
  ],
});

describe("P-UI-6 llm-planner", () => {
  it("returns sanitized LLM tasks on a valid JSON response", async () => {
    const r = await llmPlan("goal", { ...CFG, fetchFn: okFetch(VALID_PLAN) });
    expect(r.source).toBe("LLM");
    expect(r.tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(r.tasks[1].depends_on).toEqual(["T1"]);
  });

  it("extracts JSON wrapped in markdown fences", async () => {
    const r = await llmPlan("goal", { ...CFG, fetchFn: okFetch("```json\n" + VALID_PLAN + "\n```") });
    expect(r.source).toBe("LLM");
    expect(r.tasks).toHaveLength(2);
  });

  it("rejects (empty tasks) on non-JSON output — fail closed, no vacuous T1 plan", async () => {
    const r = await llmPlan("goal", { ...CFG, fetchFn: okFetch("sorry, I cannot") });
    expect(r.source).toBe("FALLBACK");
    expect(r.tasks).toHaveLength(0);
    expect(r.warnings).toContain("LLM_PLAN_NO_JSON");
    expect(r.warnings).toContain("LLM_PLAN_DEGENERATE");
  });

  it("rejects (empty tasks) on HTTP error", async () => {
    const r = await llmPlan("goal", {
      ...CFG,
      fetchFn: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    expect(r.source).toBe("FALLBACK");
    expect(r.tasks).toHaveLength(0);
    expect(r.warnings[0]).toBe("LLM_PLANNER_HTTP_500");
  });

  it("rejects (empty tasks) on request failure/timeout", async () => {
    const r = await llmPlan("goal", {
      ...CFG,
      fetchFn: (async () => {
        throw new Error("boom");
      }) as typeof fetch,
    });
    expect(r.source).toBe("FALLBACK");
    expect(r.tasks).toHaveLength(0);
  });

  it("rejects (empty tasks) when the credential env var is unset", async () => {
    const r = await llmPlan("goal", { ...CFG, env: {} as NodeJS.ProcessEnv, fetchFn: okFetch(VALID_PLAN) });
    expect(r.source).toBe("FALLBACK");
    expect(r.tasks).toHaveLength(0);
    expect(r.warnings).toContain("LLM_PLANNER_NO_CREDENTIAL");
  });

  it("rejects a degenerate plan that only contains the T1 bookkeeping task", async () => {
    const T1_ONLY = JSON.stringify({
      tasks: [
        {
          task_key: "T1",
          title: "record mission goal",
          task_instruction: "write goal to mission_goal.txt, then reply DONE.",
          required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
          depends_on: [],
        },
      ],
    });
    let calls = 0;
    const r = await llmPlan("goal", {
      ...CFG,
      fetchFn: (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: T1_ONLY } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(calls).toBe(2); // replanned once, still degenerate
    expect(r.source).toBe("FALLBACK");
    expect(r.tasks).toHaveLength(0);
    expect(r.warnings).toContain("LLM_PLAN_DEGENERATE");
  });

  it("replans once and accepts the second plan when the first is degenerate", async () => {
    const T1_ONLY = JSON.stringify({
      tasks: [
        {
          task_key: "T1",
          title: "record mission goal",
          task_instruction: "write goal to mission_goal.txt, then reply DONE.",
          required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
          depends_on: [],
        },
      ],
    });
    let calls = 0;
    const r = await llmPlan("goal", {
      ...CFG,
      fetchFn: (async () => {
        calls++;
        const content = calls === 1 ? T1_ONLY : VALID_PLAN;
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(r.source).toBe("LLM");
    expect(r.tasks).toHaveLength(2);
    expect(r.warnings).toContain("LLM_PLAN_DEGENERATE");
  });

  it("drops capabilities outside the whitelist and drops tasks left with none", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        { task_key: "T1", title: "a", task_instruction: "do", required_capabilities: ["REASONING", "HACK_THE_PLANET"], depends_on: [] },
        { task_key: "T2", title: "b", task_instruction: "do", required_capabilities: ["EVIL_CAP"], depends_on: ["T1"] },
      ],
      CAPS,
      5,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].required_capabilities).toEqual(["REASONING"]);
    expect(warnings.some((w) => w.startsWith("DROP_NO_ALLOWED_CAPS"))).toBe(true);
  });

  it("prunes forward/self dependencies — output is acyclic by construction", () => {
    const { tasks } = sanitizePlan(
      [
        { task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: ["T2", "T1"] },
        { task_key: "T2", title: "b", task_instruction: "y", required_capabilities: ["REASONING"], depends_on: [] },
      ],
      CAPS,
      5,
    );
    expect(tasks[0].depends_on).toEqual([]);
    expect(tasks[1].depends_on).toEqual([]);
  });

  it("enforces maxTasks truncation", () => {
    const raw = Array.from({ length: 8 }, (_, i) => ({
      task_key: `T${i + 1}`,
      title: "t",
      task_instruction: "x",
      required_capabilities: ["REASONING"],
      depends_on: [],
    }));
    const { tasks, warnings } = sanitizePlan(raw, CAPS, 3);
    expect(tasks).toHaveLength(3);
    expect(warnings).toContain("MAX_TASKS_TRUNCATED");
  });

  it("rejects bad task_keys and duplicates", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        { task_key: "nope", title: "a", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: [] },
        { task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: [] },
        { task_key: "T1", title: "dup", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: [] },
      ],
      CAPS,
      5,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(warnings.filter((w) => w.startsWith("DROP_INVALID_TASK_KEY"))).toHaveLength(2);
  });

  it("fallbackTasks produce the safe PAIR_NATIVE contract", () => {
    const tasks = fallbackTasks("g");
    const spec = (tasks[0].metadata as Record<string, Record<string, Record<string, unknown>>>)
      .expected_output_contract.worker_spec;
    expect(spec.allowed_ops).toEqual(["write_text_file", "finish"]);
  });

  it("drops tasks whose capability combo no single executor serves", () => {
    const sets = [
      ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION"],
    ];
    // SUITABILITY_V1 — local impl caps on a remote-lane task are normalized
    // away first; a genuinely unservable combo must keep a non-redundant cap
    // (TELEGRAM_DELIVERY) that no single set serves alongside the remote one.
    const caps = ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "TELEGRAM_DELIVERY"];
    const { tasks, warnings } = sanitizePlan(
      [
        { task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
        { task_key: "T2", title: "b", task_instruction: "x", required_capabilities: ["TELEGRAM_DELIVERY", "REMOTE_CLOUD_TASK_EXECUTION"], depends_on: [] },
        { task_key: "T3", title: "c", task_instruction: "x", required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"], depends_on: [] },
      ],
      caps,
      5,
      sets,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T3"]);
    expect(warnings).toContain("DROP_UNSERVABLE_CAPS:T2");
  });

  it("SUITABILITY_V1: strips redundant local impl caps on remote-lane tasks instead of dropping them", () => {
    const sets = [
      ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"],
    ];
    const caps = [
      "FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "REMOTE_CLOUD_TASK_EXECUTION",
      "AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS", "CODE_GENERATION", "SHELL_EXECUTION",
    ];
    const { tasks, warnings } = sanitizePlan(
      [
        // remote cap + redundant local caps → normalized, task survives
        { task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION", "FILE_OPERATIONS", "CODE_GENERATION"], depends_on: [] },
        // NETWORK_ACCESS is NOT redundant — kept alongside the remote cap
        { task_key: "T2", title: "b", task_instruction: "x", required_capabilities: ["AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS", "SHELL_EXECUTION"], depends_on: [] },
      ],
      caps,
      5,
      sets,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(tasks[0].required_capabilities).toEqual(["REMOTE_CLOUD_TASK_EXECUTION"]);
    expect(tasks[1].required_capabilities).toEqual(["AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"]);
    expect(warnings).toContain("NORMALIZED_REMOTE_CAPS:T1");
    expect(warnings).toContain("NORMALIZED_REMOTE_CAPS:T2");
  });

  it("drops tasks that depend on a remote-capability task (remote outputs are not local files)", () => {
    const caps = ["AUTOMATON_TASK_EXECUTION", "REASONING", "REMOTE_CLOUD_TASK_EXECUTION"];
    const sets = [["AUTOMATON_TASK_EXECUTION"], ["REASONING"], ["REMOTE_CLOUD_TASK_EXECUTION"]];
    const { tasks, warnings } = sanitizePlan(
      [
        { task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["AUTOMATON_TASK_EXECUTION"], depends_on: [] },
        { task_key: "T2", title: "b", task_instruction: "x", required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"], depends_on: ["T1"] },
        { task_key: "T3", title: "c", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: ["T2"] },
        { task_key: "T4", title: "d", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: ["T1"] },
      ],
      caps,
      5,
      sets,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2", "T4"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T3");
  });

  it("no capabilitySets → no servability check (backwards compatible)", () => {
    const { tasks, warnings } = sanitizePlan(
      [{ task_key: "T1", title: "a", task_instruction: "x", required_capabilities: ["REASONING"], depends_on: [] }],
      CAPS,
      5,
    );
    expect(tasks).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
