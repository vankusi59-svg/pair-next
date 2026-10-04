/**
 * pair-pgrammar2-remote-edge.test.ts — P-GRAMMAR2 adversarial tests.
 *
 * §1 prompt hardening: shared planner prompt carries a concrete valid
 *    remote producer→consumer example AND a rejected paraphrase example.
 * §2 bounded repair: one remote dep producing exactly ONE artifact +
 *    consumer missing the path → canonical instruction suffix repair,
 *    evidenced by REPAIRED_REMOTE_DEPENDENT_EDGE; every ambiguity stays
 *    fail-closed (DROP_REMOTE_DEPENDENT).
 * §3 observability: canonicalize throw keeps a bounded VALIDATION_CODE
 *    alongside CANONICAL_VALIDATION_FAILED on the planner attempt.
 * §4 regressions: F2 remote-edge rejection, DSN-1/RPN-1 untouched.
 * Deterministic only — no live calls.
 */
import { describe, expect, it } from "vitest";
import { IntegrityError, runPlannerFailover } from "../pair/index.js";
import {
  detectTelegramDeliveryIntent,
  reconcilePlanDataflow,
} from "../pair/plan-dataflow.js";
import {
  LLM_PLANNER_MAX_INSTRUCTION,
  buildPlannerUserPrompt,
  plannerSystemPrompt,
  sanitizePlan,
} from "../pair/llm-planner.js";

const CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "NETWORK_ACCESS",
  "REMOTE_CLOUD_TASK_EXECUTION",
  "TELEGRAM_DELIVERY",
];
const SETS = [
  ["AUTOMATON_TASK_EXECUTION"],
  ["FILE_OPERATIONS", "REASONING"],
  ["FILE_OPERATIONS", "REASONING", "NETWORK_ACCESS"],
  ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"],
  ["FILE_OPERATIONS", "TELEGRAM_DELIVERY"],
];

const remoteTask = (key: string, producesPath: string) => ({
  task_key: key,
  title: "remote",
  task_instruction: `Research on a remote cloud workspace and write the findings to ${producesPath}, then reply DONE.`,
  required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
  depends_on: [] as string[],
});

const consumer = (
  key: string,
  instruction: string,
  deps: string[],
  caps = ["REASONING", "FILE_OPERATIONS"],
) => ({
  task_key: key,
  title: "consumer",
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on: deps,
});

describe("P-GRAMMAR2 A — prompt hardening", () => {
  it("A1. shared prompt carries a valid remote producer→consumer example", () => {
    const p = plannerSystemPrompt();
    expect(p).toContain("outbox/review.md");
    expect(p).toContain("REMOTE EDGE EXAMPLES");
    expect(p).toContain("depends_on includes T2");
  });

  it("A2. shared prompt carries a rejected paraphrase example", () => {
    const p = plannerSystemPrompt();
    expect(p).toContain("Tổng hợp kết quả từ các nguồn");
    expect(p).toContain("REJECTED");
    expect(p).toContain("never constitute an artifact edge");
  });

  it("A3. one prompt for every transport (user prompt shares the same contract text)", () => {
    const u = buildPlannerUserPrompt("goal x", { allowedCapabilities: CAPS });
    expect(u).toContain("MISSION GOAL");
    expect(plannerSystemPrompt().length).toBeGreaterThan(500);
  });
});

describe("P-GRAMMAR2 B — bounded unambiguous repair", () => {
  it("B1. one remote dep + one produced artifact + missing path → repair, task retained", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer(
          "T2",
          "Tổng hợp kết quả và viết report.md, then reply DONE.",
          ["T1"],
        ),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(warnings).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T2");
    expect(String(tasks[1].task_instruction)).toContain("outbox/review.md");
  });

  it("B2. repaired instruction extracts a real consume edge for the produced artifact", () => {
    const { tasks } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer("T2", "Viết report.md từ kết quả, then reply DONE.", ["T1"]),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(String(tasks[1].task_instruction)).toMatch(
      /Input artifact to read: outbox\/review\.md\./,
    );
  });

  it("B3. partial omission repairs: consumer naming another dep's real artifact keeps that edge and gains the remote one", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        {
          task_key: "T2",
          title: "local",
          task_instruction: "Research patterns and write router_patterns.json, then reply DONE.",
          required_capabilities: ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS"],
          depends_on: [],
        },
        consumer(
          "T3",
          "Read router_patterns.json and write report.md, then reply DONE.",
          ["T1", "T2"],
        ),
      ],
      CAPS,
      6,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
    expect(warnings).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T3");
    const ins = String(tasks[2].task_instruction);
    expect(ins).toContain("router_patterns.json");
    expect(ins).toContain("outbox/review.md");
  });

  it("B4. replay is deterministic/idempotent — same input, same repaired output", () => {
    const mk = () =>
      sanitizePlan(
        [
          remoteTask("T1", "outbox/review.md"),
          consumer("T2", "Tổng hợp, then reply DONE.", ["T1"]),
        ],
        CAPS,
        5,
        SETS,
      );
    const a = mk();
    const b = mk();
    expect(a.tasks).toEqual(b.tasks);
    expect(a.warnings).toEqual(b.warnings);
  });
});

describe("P-GRAMMAR2 C — fail-closed ambiguity", () => {
  it("C1. one remote dep producing TWO artifacts → no repair, dropped", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        {
          task_key: "T1",
          title: "remote",
          task_instruction: "Remote work, write the outputs, then reply DONE.",
          required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
          depends_on: [],
          metadata: {
            pair_dataflow: {
              produces: ["outbox/review.md", "outbox/data.json"],
              consumes: [],
            },
          },
        },
        consumer("T2", "Tổng hợp kết quả, then reply DONE.", ["T1"]),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T2");
    expect(warnings).not.toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T2");
  });

  it("C2. two offending remote deps → no repair", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/a.md"),
        {
          task_key: "T2",
          title: "remote2",
          task_instruction: "Remote work, write outbox/b.md, then reply DONE.",
          required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
          depends_on: [],
        },
        consumer("T3", "Tổng hợp kết quả, then reply DONE.", ["T1", "T2"]),
      ],
      CAPS,
      6,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T3");
    expect(warnings).not.toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T3");
  });

  it("C3. remote dep with zero extracted produces ��� no repair", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        {
          task_key: "T1",
          title: "remote",
          task_instruction: "Do remote work, then reply DONE.",
          required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
          depends_on: [],
        },
        consumer("T2", "Tổng hợp kết quả, then reply DONE.", ["T1"]),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T2");
  });

  it("C4. consumer naming an artifact NO dep produces → no widening/guessing", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer(
          "T2",
          "Read invented_foreign.txt and write report.md, then reply DONE.",
          ["T1"],
        ),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T2");
  });

  it("C5. instruction-budget overflow → no truncation-based repair", () => {
    const filler = "x".repeat(LLM_PLANNER_MAX_INSTRUCTION - 30);
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer("T2", `${filler} read results`, ["T1"]),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1"]);
    expect(warnings).toContain("DROP_REMOTE_DEPENDENT:T2");
  });

  it("C6. ordinary local dependencies unchanged (non-remote dep, no edge needed)", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        {
          task_key: "T1",
          title: "local",
          task_instruction: "Write data.json, then reply DONE.",
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: [],
        },
        consumer("T2", "Use the data, then reply DONE.", ["T1"]),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(warnings.filter((w) => w.startsWith("DROP_REMOTE_DEPENDENT"))).toHaveLength(0);
  });

  it("C7. TELEGRAM_DELIVERY exemption unchanged", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer(
          "T2",
          "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
          ["T1"],
          ["TELEGRAM_DELIVERY", "FILE_OPERATIONS"],
        ),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(warnings).not.toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T2");
    expect(warnings).not.toContain("DROP_REMOTE_DEPENDENT:T2");
  });

  it("C8. consumer already naming the remote artifact → no repair needed, kept", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        consumer(
          "T2",
          "Read outbox/review.md and write report.md, then reply DONE.",
          ["T1"],
        ),
      ],
      CAPS,
      5,
      SETS,
    );
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(warnings).not.toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T2");
    expect(warnings).not.toContain("DROP_REMOTE_DEPENDENT:T2");
  });
});

describe("P-GRAMMAR2 D — typed observability", () => {
  const cand = (id: string) => ({
    model_entry_id: id,
    ref: `p:${id}`,
    provider: "p",
    model: id,
    endpoint: "https://example.test",
    credentialEnv: "ENV_X",
  });
  const okPlan = () => ({
    tasks: [
      {
        task_key: "T1",
        title: "t",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
      },
    ],
    warnings: [] as string[],
  });

  it("D1. typed IntegrityError → VALIDATION_CODE + CANONICAL_VALIDATION_FAILED persisted", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async () => okPlan(),
      assertEligible: () => {},
      canonicalize: (_tasks, c) => {
        if (c.model_entry_id === "A")
          throw new IntegrityError(
            "FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT",
            "secret detail must not persist",
          );
        return _tasks;
      },
    });
    expect(res.winner.model_entry_id).toBe("B");
    const w = res.attempts[0].warnings;
    expect(w).toContain("VALIDATION_CODE:FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
    expect(w).toContain("CANONICAL_VALIDATION_FAILED");
    expect(w.join("|")).not.toContain("secret detail");
  });

  it("D2. untyped error → only CANONICAL_VALIDATION_FAILED, no message/stack leak", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async () => okPlan(),
      assertEligible: () => {},
      canonicalize: (_tasks, c) => {
        if (c.model_entry_id === "A")
          throw new Error("raw db path /home/x/token=sk-abc123");
        return _tasks;
      },
    });
    const w = res.attempts[0].warnings;
    expect(w).toContain("CANONICAL_VALIDATION_FAILED");
    expect(w.some((x) => x.startsWith("VALIDATION_CODE:"))).toBe(false);
    expect(w.join("|")).not.toContain("sk-abc123");
    expect(w.join("|")).not.toContain("/home/x");
  });
});

describe("P-GRAMMAR2 E — regression guards", () => {
  it("E1. F2 remote-edge rejection still drops a non-dep remote consumer", () => {
    const { tasks, warnings } = sanitizePlan(
      [
        remoteTask("T1", "outbox/review.md"),
        {
          task_key: "T2",
          title: "remote2",
          task_instruction: "Remote work, write outbox/other.md, then reply DONE.",
          required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
          depends_on: [],
        },
        consumer("T3", "Read outbox/review.md, then reply DONE.", ["T1", "T2"]),
      ],
      CAPS,
      6,
      SETS,
    );
    // T3 consumes T1's real produce but not T2's → T2 is the ONE
    // offending remote dep producing ONE artifact → bounded repair.
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
    expect(warnings).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T3");
  });

  it("E2. consume edge verified against the dep's OWN produces (equiv spellings stay rejectable elsewhere)", () => {
    const { warnings } = sanitizePlan(
      [
        {
          task_key: "T1",
          title: "local",
          task_instruction: "Write outbox/review.md, then reply DONE.",
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: [],
        },
        remoteTask("T2", "outbox/other.md"),
        consumer("T3", "Read outbox/review.md, then reply DONE.", ["T1", "T2"]),
      ],
      CAPS,
      6,
      SETS,
    );
    expect(warnings).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T3");
  });

  it("E3. LIVE INCIDENT SHAPE — paraphrased aggregation survives sanitize + committed-plan assertPlanDataflow passes", () => {
    // The prod incident: remote T2 wrote outbox/automaton_review.md,
    // local T3 wrote router_patterns.json, and the planner emitted the
    // aggregation task WITHOUT the remote artifact path → sol was
    // rejected 4/4. The repaired consumer must carry a real consume
    // edge and the whole sanitized plan must pass the committed-plan
    // authority unchanged.
    const { tasks, warnings } = sanitizePlan(
      [
        {
          task_key: "T1",
          title: "bookkeeping",
          task_instruction: "Record mission intake, then reply DONE.",
          required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
          depends_on: [],
        },
        remoteTask("T2", "outbox/automaton_review.md"),
        consumer(
          "T3",
          "Research 5 failover patterns for multi-model LLM routers on the web, write router_patterns.json, then reply DONE.",
          [],
          ["FILE_OPERATIONS", "REASONING", "NETWORK_ACCESS"],
        ),
        consumer(
          "T4",
          "Tổng hợp kết quả từ các nguồn nghiên cứu, write report.md, then reply DONE.",
          ["T2", "T3"],
        ),
        {
          task_key: "T5",
          title: "delivery",
          task_instruction:
            "Deliver report.md and outbox/automaton_review.md via telegram, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY", "FILE_OPERATIONS"],
          depends_on: ["T4"],
        },
      ],
      CAPS,
      6,
      SETS,
    );
    expect(warnings).toContain("REPAIRED_REMOTE_DEPENDENT_EDGE:T4");
    const t4 = tasks.find((t) => t.task_key === "T4");
    expect(String(t4?.task_instruction)).toContain("outbox/automaton_review.md");
    // The committed plan passes the canonical reconcile authority the
    // serve canonicalizer applies at commit, with the incident goal's
    // own delivery intent (the goal asks for telegram delivery).
    const intent = detectTelegramDeliveryIntent(
      "...gửi report.md và outbox/automaton_review.md qua telegram",
    );
    expect(() =>
      reconcilePlanDataflow(tasks as never[], { telegramIntent: intent })
    ).not.toThrow();
    const t4After = tasks.find((t) => t.task_key === "T4") as {
      depends_on?: unknown;
    };
    expect(t4After.depends_on).toEqual(["T2", "T3"]);
    expect(tasks.map((t) => t.task_key)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });
});
