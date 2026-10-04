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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveWorkTaskBudget,
  resolveWorkTaskBudget,
  buildPlannerUserPrompt,
  plannerSystemPrompt,
  llmPlan,
  sanitizePlan,
  LLM_PLAN_RESERVED_CAPABILITY_WARNING,
  goalRequiresCurrentExternalData,
  taskRequiresNetworkAccess,
  instructionIsDataGathering,
  WORK_TASK_HARD_CEILING,
} from "../pair/llm-planner.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  SERVE_LLM_WORK_CAPS,
  canonicalBookkeepingTask,
} from "../pair/serve-planner.js";
import { CANONICAL_BOOKKEEPING_INSTRUCTION } from "../pair/plan-dataflow.js";
import {
  CapabilityRouter,
  CodexCliExecutorAdapter,
  PairControlPlane,
  PairEvidenceStore,
  validatePlanProposal,
} from "../pair/index.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { IntegrityError } from "../pair/errors.js";

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
    expect(liveData).toContain("NETWORK_ACCESS");
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
      work(
        `T${i + 1}`,
        i === 0
          ? "fetch the latest market prices and news"
          : `step ${i + 1}`,
        i === 0 ? ["NETWORK_ACCESS", "REASONING"] : ["REASONING"],
        i ? [`T${i}`] : [],
      ),
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

/* ---------------- R1.A — AUTOMATON is PAIR-reserved ---------------- */

const RESERVED_CODE = "FAIL_CLOSED_PLAN_RESERVED_CAPABILITY_AUTOMATON_TASK_EXECUTION";

/** reconcilePlanDataflow stamps pair_dataflow bookkeeping onto the injected
 *  T1 — strip it for the "exact canonicalBookkeepingTask(goal)" invariant. */
function stripDataflowAnnotation(task: Record<string, unknown>) {
  const clone = JSON.parse(JSON.stringify(task)) as Record<
    string,
    Record<string, unknown>
  >;
  delete clone.metadata?.pair_dataflow;
  delete clone.metadata?.pair_dataflow_original_deps;
  if (clone.metadata && Object.keys(clone.metadata).length === 0)
    delete clone.metadata;
  return clone;
}

describe("PRV2-A R1.A — reserved AUTOMATON_TASK_EXECUTION", () => {
  const goal = "analyze gold price and write report to report.txt";

  it("R1.A-vocab: work vocabulary excludes AUTOMATON; planner vocabulary keeps it internally", () => {
    expect(SERVE_LLM_WORK_CAPS).not.toContain("AUTOMATON_TASK_EXECUTION");
    expect(SERVE_LLM_PLANNER_CAPS).toContain("AUTOMATON_TASK_EXECUTION");
    expect(SERVE_LLM_PLANNER_CAPS).toContain("NETWORK_ACCESS");
    // every work cap is still a planner cap — nothing else removed
    for (const c of SERVE_LLM_WORK_CAPS)
      expect(SERVE_LLM_PLANNER_CAPS).toContain(c);
  });

  it("R1.A-prompt: ALLOWED_CAPABILITIES shown to the model never lists AUTOMATON", () => {
    const userPrompt = buildPlannerUserPrompt(goal, {
      allowedCapabilities: SERVE_LLM_WORK_CAPS.slice(),
      maxTasks: 4,
    });
    expect(userPrompt).not.toContain("AUTOMATON_TASK_EXECUTION");
    expect(userPrompt).toContain("NETWORK_ACCESS");
    // system prompt reserves it
    expect(plannerSystemPrompt()).toContain("NEVER request AUTOMATON_TASK_EXECUTION");
  });

  it("R1.A-1 (adversarial): mixed [AUTOMATON, FILE_OPERATIONS] 'create report.txt' → typed reject, no strip", () => {
    expect(() =>
      canon(
        [
          work("T1", "create report.txt with findings", [
            "AUTOMATON_TASK_EXECUTION",
            "FILE_OPERATIONS",
          ]),
        ],
        goal,
      ),
    ).toThrowError(IntegrityError);
  });

  it("R1.A-1b: the rejection is the reserved-capability code, not a generic cap error", () => {
    try {
      canon(
        [work("T1", "create report.txt", ["AUTOMATON_TASK_EXECUTION", "FILE_OPERATIONS"])],
        goal,
      );
      expect.unreachable("canonicalize must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect(String((e as IntegrityError).code)).toBe(RESERVED_CODE);
    }
  });

  it("R1.A-2: mixed AUTOMATON task anywhere in the emission fails the whole candidate", () => {
    expect(() =>
      canon(
        [
          work("T1", "research gold drivers", ["REASONING"]),
          work("T2", "write report.txt", [
            "FILE_OPERATIONS",
            "AUTOMATON_TASK_EXECUTION",
          ], ["T1"]),
        ],
        goal,
      ),
    ).toThrowError(IntegrityError);
    // and no partial/sanitized plan survives — the throw IS the outcome
  });

  it("R1.A-3: AUTOMATON + foreign worker_spec (writes other.txt) → typed reject", () => {
    const t = work("T1", "write other.txt", ["AUTOMATON_TASK_EXECUTION"]);
    (t as { metadata: Record<string, unknown> }).metadata = {
      expected_output_contract: {
        worker_spec: {
          ops: [{ op: "write_text_file", path: "other.txt", content: "x" }],
        },
      },
    };
    expect(() => canon([t], goal)).toThrowError(IntegrityError);
  });

  it("R1.A-4: accepted plan still has exactly ONE AUTOMATON task — T1 = canonicalBookkeepingTask(goal)", () => {
    const out = canon(
      [
        work("T1", "research gold price", ["REASONING"]),
        work("T2", "read findings write report.txt", ["FILE_OPERATIONS"], ["T1"]),
      ],
      goal,
    );
    const automatonTasks = out.filter((t) =>
      (t.required_capabilities as string[]).includes("AUTOMATON_TASK_EXECUTION"),
    );
    expect(automatonTasks).toHaveLength(1);
    expect(automatonTasks[0].task_key).toBe("T1");
    expect(stripDataflowAnnotation(automatonTasks[0])).toEqual(
      canonicalBookkeepingTask(goal),
    );
    // zero second bookkeeping worker_spec anywhere else
    for (const t of out.slice(1)) {
      const spec = (
        (t.metadata as Record<string, unknown> | undefined)
          ?.expected_output_contract as Record<string, unknown> | undefined
      )?.worker_spec;
      expect(spec).toBeUndefined();
    }
  });

  it("R1.A-5: model-emitted pure bookkeeping still normalizes (never a second authority)", () => {
    const out = canon([bookkeepingShaped("T1"), work("T2", "do x", ["REASONING"])], goal);
    const automaton = out.filter((t) =>
      (t.required_capabilities as string[]).includes("AUTOMATON_TASK_EXECUTION"),
    );
    expect(automaton).toHaveLength(1);
    expect(stripDataflowAnnotation(automaton[0])).toEqual(
      canonicalBookkeepingTask(goal),
    );
  });

  it("R1.A-6: llmPlan rejects a mixed-AUTOMATON emission with typed warning (failover-eligible)", async () => {
    const MIXED = JSON.stringify({
      tasks: [
        {
          task_key: "T1",
          title: "work",
          task_instruction: "create report.txt then reply DONE.",
          required_capabilities: ["AUTOMATON_TASK_EXECUTION", "FILE_OPERATIONS"],
          depends_on: [],
        },
      ],
    });
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: MIXED } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await llmPlan(goal, {
      endpoint: "https://example.invalid/chat/completions",
      credentialEnv: "TEST_LLM_KEY",
      model: "test-model",
      allowedCapabilities: SERVE_LLM_WORK_CAPS.slice(),
      env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(r.tasks).toHaveLength(0);
    expect(r.warnings[0]).toBe(
      `${LLM_PLAN_RESERVED_CAPABILITY_WARNING}:T1`,
    );
  });

  it("R1.A-7: llmPlan keeps pure bookkeeping-shaped emissions so canonicalize can normalize them", async () => {
    const PLAN = JSON.stringify({
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
          task_instruction: "Write findings to findings.txt, then reply DONE.",
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: ["T1"],
        },
      ],
    });
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: PLAN } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await llmPlan(goal, {
      endpoint: "https://example.invalid/chat/completions",
      credentialEnv: "TEST_LLM_KEY",
      model: "test-model",
      allowedCapabilities: SERVE_LLM_WORK_CAPS.slice(),
      env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
      fetchFn,
    });
    // bookkeeping emission survives sanitize (for normalization), so does the
    // dep reference — canonicalize drops T1 + remaps T2's dep onto injected T1.
    expect(r.tasks.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(r.tasks[1].depends_on).toEqual(["T1"]);
    const out = canon(r.tasks as unknown as Array<Record<string, unknown>>, goal);
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2"]);
    expect(out[1].depends_on).toEqual(["T1"]);
  });
});

/* ---------------- R1.B — NETWORK_ACCESS is a real routing fact ---------------- */

const NET_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-prv2a-r1b-"));
let netCounter = 0;

/** Minimal live adapter whose capability declaration is mutable — stands in
 *  for a dynamic executor (Codex resolves NETWORK_ACCESS per call). */
class LiveCapsAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  qualified = true;
  constructor(id: string, caps: string[]) {
    this.executor_id = id;
    this.caps = caps.slice();
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return this.qualified
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNAVAILABLE"] };
  }
  capabilities() {
    return { capability_ids: [...this.caps] };
  }
  prepare_task(t: Record<string, unknown>) {
    return t;
  }
  dispatch() {
    return { execution_id: `EXEC_${this.executor_id}`, status: "COMPLETED" };
  }
  observe() {
    return { status: "COMPLETED" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result() {
    return { status: "COMPLETED", artifacts: [] };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

function makeRouterCtx(name: string) {
  const dir = path.join(NET_ROOT, `${netCounter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const router = new CapabilityRouter(service);
  return { dir, store, service, router };
}

function registerNetExecutor(
  ctx: ReturnType<typeof makeRouterCtx>,
  executorId: string,
  staticCaps: string[],
  priority = 50,
) {
  ctx.service.registerExecutor({
    executor_id: executorId,
    executor_type: "EXTERNAL",
    capabilities: staticCaps,
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: priority,
      transport_type: "IN_PROCESS",
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      authentication_mode: "AUTHENTICATED",
      max_concurrency: 4,
    },
  });
}

function netTask(caps: string[]) {
  return {
    task_id: "task_net",
    mission_id: "MSN_NET",
    required_capabilities: caps,
    task_instruction: "do x",
  };
}

function routeNet(
  ctx: ReturnType<typeof makeRouterCtx>,
  adapters: Map<string, ExecutorAdapter>,
  caps: string[],
) {
  return ctx.router.route(netTask(caps) as never, {
    adapters,
    mode: "DISPATCH",
    persist: false,
    requiredPermissions: new Set(),
  });
}

describe("PRV2-A R1.B — NETWORK_ACCESS routing authority", () => {
  const DSH_CAPS = [
    "CODE_GENERATION",
    "CODE_EDITING",
    "FILE_OPERATIONS",
    "SHELL_EXECUTION",
    "REASONING",
    "TELEGRAM_DELIVERY",
  ];
  const CODEX_STATIC = [
    "CODE_GENERATION",
    "CODE_EDITING",
    "FILE_OPERATIONS",
    "SHELL_EXECUTION",
    "PYTHON_EXECUTION",
    "REASONING",
    "NETWORK_ACCESS", // registered while ON
  ];
  const DEVIN_CAPS = [
    "REMOTE_CLOUD_TASK_EXECUTION",
    "AUTONOMOUS_CODE_EXECUTION",
    "NETWORK_ACCESS",
    "REASONING",
  ];

  it("B1: DSH-shaped executor is never network-eligible via generic REASONING/SHELL", () => {
    const ctx = makeRouterCtx("b1");
    registerNetExecutor(ctx, "dsh_like", DSH_CAPS, 10); // higher priority
    registerNetExecutor(ctx, "devin_like", DEVIN_CAPS, 50);
    const adapters = new Map<string, ExecutorAdapter>([
      ["dsh_like", new LiveCapsAdapter("dsh_like", DSH_CAPS)],
      ["devin_like", new LiveCapsAdapter("devin_like", DEVIN_CAPS)],
    ]);
    const d = routeNet(ctx, adapters, ["NETWORK_ACCESS", "REASONING"]);
    expect(d.selected_executor).toBe("devin_like");
    const rejected = (d.rejected_executors as Array<{ executor_id: string; reasons: string[] }>) ?? [];
    const dshReject = rejected.find((r) => r.executor_id === "dsh_like");
    expect(dshReject?.reasons.join(",")).toContain("MISSING_CAPABILITIES");
    expect(dshReject?.reasons.join(",")).toContain("NETWORK_ACCESS");
  });

  it("B2: codex-shaped executor with network OFF cannot serve a NETWORK_ACCESS task", () => {
    const ctx = makeRouterCtx("b2");
    // static claim includes NETWORK_ACCESS (it was ON at registration)
    registerNetExecutor(ctx, "codex_like", CODEX_STATIC, 10);
    const codex = new LiveCapsAdapter("codex_like", CODEX_STATIC);
    // PAIR_CODEX_NETWORK=off → live declaration drops it
    codex.caps = CODEX_STATIC.filter((c) => c !== "NETWORK_ACCESS");
    const adapters = new Map<string, ExecutorAdapter>([["codex_like", codex]]);
    const d = routeNet(ctx, adapters, ["NETWORK_ACCESS", "REASONING"]);
    expect(d.selected_executor).toBeNull();
    const rejected = (d.rejected_executors as Array<{ executor_id: string; reasons: string[] }>);
    expect(rejected[0].executor_id).toBe("codex_like");
    expect(rejected[0].reasons).toContain("MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS");
  });

  it("B3: the same executor with network ON becomes eligible (live claim)", () => {
    const ctx = makeRouterCtx("b3");
    registerNetExecutor(ctx, "codex_like", CODEX_STATIC, 10);
    const adapters = new Map<string, ExecutorAdapter>([
      ["codex_like", new LiveCapsAdapter("codex_like", CODEX_STATIC)],
    ]);
    const d = routeNet(ctx, adapters, ["NETWORK_ACCESS", "REASONING"]);
    expect(d.selected_executor).toBe("codex_like");
  });

  it("B4: a network-free task is unaffected — DSH-shaped executor still eligible", () => {
    const ctx = makeRouterCtx("b4");
    registerNetExecutor(ctx, "dsh_like", DSH_CAPS, 10);
    const adapters = new Map<string, ExecutorAdapter>([
      ["dsh_like", new LiveCapsAdapter("dsh_like", DSH_CAPS)],
    ]);
    const d = routeNet(ctx, adapters, ["REASONING"]);
    expect(d.selected_executor).toBe("dsh_like");
  });

  it("B5: real CodexCliExecutorAdapter claims NETWORK_ACCESS live per PAIR_CODEX_NETWORK", () => {
    const dir = path.join(NET_ROOT, "codex-live");
    fs.mkdirSync(dir, { recursive: true });
    let net: string | undefined = "off";
    const envMap: Record<string, string | undefined> = {
      OPENAI_API_KEY: "test-key",
      get PAIR_CODEX_NETWORK() {
        return net;
      },
    };
    const adapter = new CodexCliExecutorAdapter({
      journalRoot: path.join(dir, "journal"),
      executable: "node",
      executableArgs: [
        path.resolve(__dirname, "fixtures", "fake-codex-argv.mjs"),
      ],
      envReader: (n) => (n in envMap ? envMap[n] : process.env[n]),
    });
    const q = adapter.qualify();
    expect(q.qualified).toBe(true);
    const capsOff = adapter.capabilities().capability_ids as string[];
    expect(capsOff).not.toContain("NETWORK_ACCESS");
    net = "on";
    const capsOn = adapter.capabilities().capability_ids as string[];
    expect(capsOn).toContain("NETWORK_ACCESS");
    net = "off";
    expect(adapter.capabilities().capability_ids as string[]).not.toContain(
      "NETWORK_ACCESS",
    );
  });

  it("B6: NETWORK_ACCESS is a registered known capability — a proposal naming it validates", () => {
    const known = new Set(SERVE_LLM_PLANNER_CAPS);
    const out = validatePlanProposal(
      {
        tasks: [
          {
            task_key: "T1",
            title: "fetch",
            required_capabilities: ["NETWORK_ACCESS", "REASONING"],
            depends_on: [],
          },
        ],
      },
      known,
    );
    expect(out).toHaveLength(1);
    expect(out[0].required_capabilities).toContain("NETWORK_ACCESS");
  });
});

/* ---------------- R2 — deterministic network-requirement authority ---------------- */

const PLAN_NET_REQ = "FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED";
const TASK_NET_REQ = "FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED";

function expectIntegrityCode(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable("expected IntegrityError");
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrityError);
    expect(String((e as IntegrityError).code)).toBe(code);
  }
}

describe("PRV2-A R2 — canonical network-requirement gate", () => {
  it("R2-det: conservative detector — currency/online markers required, 'price' alone is not current-data", () => {
    expect(goalRequiresCurrentExternalData("analyze today's gold price")).toBe(true);
    expect(goalRequiresCurrentExternalData("fetch the latest gold and BTC news")).toBe(true);
    expect(goalRequiresCurrentExternalData("tìm tin tức mới nhất về vàng")).toBe(true);
    expect(goalRequiresCurrentExternalData("lấy giá vàng hiện tại")).toBe(true);
    expect(goalRequiresCurrentExternalData("search the web for gold prices")).toBe(true);
    // historical / offline work is unaffected
    expect(goalRequiresCurrentExternalData("analyze gold price and write report to report.txt")).toBe(false);
    expect(goalRequiresCurrentExternalData("analyze historical XAUUSD data and backtest an EA")).toBe(false);
    expect(goalRequiresCurrentExternalData("build a web scraper")).toBe(false);
    expect(goalRequiresCurrentExternalData("build a website dashboard")).toBe(false);
    expect(goalRequiresCurrentExternalData("review the search results stored in results.txt")).toBe(false);
    // task-level
    expect(taskRequiresNetworkAccess("fetch the latest gold price")).toBe(true);
    expect(taskRequiresNetworkAccess("search the web for BTC news")).toBe(true);
    expect(taskRequiresNetworkAccess("tìm giá vàng hôm nay")).toBe(true);
    expect(taskRequiresNetworkAccess("analyze the fetched data")).toBe(false);
    expect(taskRequiresNetworkAccess("review the search results")).toBe(false);
    // legitimacy shape
    expect(instructionIsDataGathering("fetch current gold prices")).toBe(true);
    expect(instructionIsDataGathering("search for the latest news")).toBe(true);
    expect(instructionIsDataGathering("create report.txt")).toBe(false);
    expect(instructionIsDataGathering("think about the market")).toBe(false);
  });

  it("R2-N1 (adversarial): 'analyze today's gold price' + REASONING-only → typed plan reject", () => {
    expectIntegrityCode(
      () =>
        canon(
          [work("T1", "analyze the gold price and write report.txt", ["REASONING"])],
          "analyze today's gold price",
        ),
      PLAN_NET_REQ,
    );
  });

  it("R2-N2: same goal + legitimate NETWORK data-gathering task → canonicalize PASS", () => {
    const out = canon(
      [
        work("T1", "fetch the current gold price from the internet", [
          "NETWORK_ACCESS",
          "REASONING",
        ]),
        work("T2", "write analysis report.txt", ["FILE_OPERATIONS"], ["T1"]),
      ],
      "analyze today's gold price",
    );
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
    expect(out[1].required_capabilities).toContain("NETWORK_ACCESS");
  });

  it("R2-N3: historical/offline goal genuinely needing no current data is unaffected", () => {
    const out = canon(
      [
        work("T1", "analyze historical XAUUSD data", ["REASONING"]),
        work("T2", "write backtest.md", ["FILE_OPERATIONS"], ["T1"]),
      ],
      "analyze historical XAUUSD data and write a backtest note",
    );
    expect(out.map((t) => t.task_key)).toEqual(["T1", "T2", "T3"]);
  });

  it("R2-N4 (adversarial): NETWORK_ACCESS on an unrelated dummy task does NOT satisfy the goal requirement", () => {
    expectIntegrityCode(
      () =>
        canon(
          [
            work("T1", "create report.txt placeholder", [
              "FILE_OPERATIONS",
              "NETWORK_ACCESS",
            ]),
            work("T2", "analyze the gold trend", ["REASONING"], ["T1"]),
          ],
          "analyze today's gold price",
        ),
      PLAN_NET_REQ,
    );
  });

  it("R2-N5 (adversarial): task instruction explicitly requests live fetching but lacks NETWORK → task-level typed reject", () => {
    expectIntegrityCode(
      () =>
        canon(
          [
            work("T1", "fetch the latest gold price and write price.txt", [
              "REASONING",
            ]),
          ],
          "write a price note",
        ),
      TASK_NET_REQ,
    );
  });

  it("R2-N6 (adversarial): NETWORK task without a data-gathering instruction is not legitimate either", () => {
    expectIntegrityCode(
      () =>
        canon(
          [
            work("T1", "think about the market", ["NETWORK_ACCESS", "REASONING"]),
          ],
          "analyze today's gold price",
        ),
      PLAN_NET_REQ,
    );
  });

  it("R2-N7: routing over a valid network plan — DSH ineligible, codex ON eligible, codex OFF rejected, devin eligible", () => {
    const plan = canon(
      [
        work("T1", "fetch the current gold price", ["NETWORK_ACCESS", "REASONING"]),
      ],
      "analyze today's gold price",
    );
    const netCaps = (plan[1].required_capabilities as string[]);
    const ctx = makeRouterCtx("r2n7");
    registerNetExecutor(ctx, "dsh_like", [
      "CODE_GENERATION", "CODE_EDITING", "FILE_OPERATIONS",
      "SHELL_EXECUTION", "REASONING", "TELEGRAM_DELIVERY",
    ], 5);
    registerNetExecutor(ctx, "codex_like", [
      "CODE_GENERATION", "FILE_OPERATIONS", "SHELL_EXECUTION",
      "PYTHON_EXECUTION", "REASONING", "NETWORK_ACCESS",
    ], 10);
    registerNetExecutor(ctx, "devin_like", [
      "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION",
      "NETWORK_ACCESS", "REASONING",
    ], 50);
    const codexOff = new LiveCapsAdapter("codex_like", [
      "CODE_GENERATION", "FILE_OPERATIONS", "SHELL_EXECUTION",
      "PYTHON_EXECUTION", "REASONING",
    ]);
    const adaptersOff = new Map<string, ExecutorAdapter>([
      ["dsh_like", new LiveCapsAdapter("dsh_like", [
        "CODE_GENERATION", "CODE_EDITING", "FILE_OPERATIONS",
        "SHELL_EXECUTION", "REASONING", "TELEGRAM_DELIVERY",
      ])],
      ["codex_like", codexOff],
      ["devin_like", new LiveCapsAdapter("devin_like", [
        "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION",
        "NETWORK_ACCESS", "REASONING",
      ])],
    ]);
    const dOff = routeNet(ctx, adaptersOff, netCaps);
    expect(dOff.selected_executor).toBe("devin_like");
    const rej = dOff.rejected_executors as Array<{ executor_id: string; reasons: string[] }>;
    expect(rej.find((r) => r.executor_id === "dsh_like")!.reasons.join(",")).toContain("NETWORK_ACCESS");
    expect(rej.find((r) => r.executor_id === "codex_like")!.reasons).toContain(
      "MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS",
    );
    // codex ON → eligible
    const adaptersOn = new Map<string, ExecutorAdapter>([
      ["codex_like", new LiveCapsAdapter("codex_like", [
        "CODE_GENERATION", "FILE_OPERATIONS", "SHELL_EXECUTION",
        "PYTHON_EXECUTION", "REASONING", "NETWORK_ACCESS",
      ])],
      ["devin_like", new LiveCapsAdapter("devin_like", [
        "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION",
        "NETWORK_ACCESS", "REASONING",
      ])],
    ]);
    const dOn = routeNet(ctx, adaptersOn, netCaps);
    expect(dOn.selected_executor).toBe("codex_like");
  });
});
