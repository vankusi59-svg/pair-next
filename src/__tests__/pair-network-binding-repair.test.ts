/**
 * NETWORK binding repair — deterministic bounded repair of a fetch-shaped
 * task missing NETWORK_ACCESS. One shared helper post-sanitize on BOTH
 * planner transports; canonical network gates stay authoritative.
 * Adversarial T1–T10 per mandate.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  llmPlan,
  repairNetworkCapabilityBinding,
} from "../pair/llm-planner.js";
import { codexPlannerPlan } from "../pair/codex-planner.js";
import { boundedAttemptWarnings } from "../pair/planner-pool.js";
import { makeServeCanonicalizer } from "../pair/serve-planner.js";
import { IntegrityError } from "../pair/errors.js";

const GOAL_NET =
  "Nghiên cứu thị trường MQL5 hiện tại để tìm một cơ hội EA MT5 có tiềm năng thương mại tốt.";
const GOAL_LOCAL = "Analyze historical XAUUSD data and backtest an EA.";

/** Executor capability universe: one executor serving network+reasoning work. */
const CAP_SETS = [
  ["REASONING", "NETWORK_ACCESS", "FILE_OPERATIONS", "CODE_GENERATION"],
];
const ALLOWED = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "NETWORK_ACCESS",
];

const FETCH_INSTRUCTION =
  "Research the current MQL5 marketplace online, fetch the latest EA MT5 trends from the web, and write market_research.md.";

const planJson = (tasks: Array<Record<string, unknown>>) =>
  JSON.stringify({ tasks });

const okFetch = (content: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

const CFG = {
  endpoint: "https://example.invalid/chat/completions",
  credentialEnv: "TEST_LLM_KEY",
  model: "test-model",
  allowedCapabilities: ALLOWED,
  capabilitySets: CAP_SETS,
  env: { TEST_LLM_KEY: "k" } as NodeJS.ProcessEnv,
  timeoutMs: 5_000,
};

const canon = (raw: Array<Record<string, unknown>>, goal: string) =>
  makeServeCanonicalizer({ executorCapSets: () => CAP_SETS })(raw, goal);

const workTask = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
});

const BOOKKEEPING = workTask(
  "T1",
  "Write the goal to mission_goal.txt, then reply DONE.",
  ["AUTOMATON_TASK_EXECUTION"],
);

const markerFor = (warnings: string[], key: string) =>
  warnings.filter((w) => w === `REPAIRED_NETWORK_CAPABILITY:${key}`);

describe("NETWORK binding repair", () => {
  it("T1 (positive, llm lane): fetch-shaped task missing NETWORK_ACCESS is repaired → canonicalizer PASSES", async () => {
    const raw = planJson([
      BOOKKEEPING,
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], ["T1"]),
      workTask("T3", "Write findings.txt then reply DONE.", ["FILE_OPERATIONS"], ["T2"]),
    ]);
    const r = await llmPlan(GOAL_NET, { ...CFG, fetchFn: okFetch(raw) });
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(t2.required_capabilities).toEqual(["NETWORK_ACCESS", "REASONING"]);
    expect(markerFor(r.warnings, "T2")).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    // canonical gates evaluate the repaired plan and PASS
    const out = canon(r.tasks, GOAL_NET);
    expect(out.length).toBeGreaterThanOrEqual(2);
    const canonNet = out.find((t) =>
      String(t.task_instruction).includes("MQL5 marketplace"),
    )!;
    expect(canonNet.required_capabilities).toEqual(["NETWORK_ACCESS", "REASONING"]);
  });

  it("T2 (codex lane parity): the SAME helper repairs identically on the codex transport", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-netrep-"));
    const exe = path.join(dir, "fake-codex.cjs");
    fs.writeFileSync(
      exe,
      `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--output-last-message") + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  fs.writeFileSync(out, JSON.stringify({ tasks: ${JSON.stringify([
    BOOKKEEPING,
    workTask("T2", FETCH_INSTRUCTION, ["REASONING"], ["T1"]),
    workTask("T3", "Write findings.txt then reply DONE.", ["FILE_OPERATIONS"], ["T2"]),
  ])} }));
  process.exit(0);
});
`,
    );
    fs.chmodSync(exe, 0o755);
    const r = await codexPlannerPlan(GOAL_NET, {
      model: "test-sol",
      executable: exe,
      timeoutMs: 8_000,
      scratchDir: path.join(dir, "scr"),
      env: { ...process.env } as NodeJS.ProcessEnv,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    const t2 = r.tasks.find((t) => t.task_key === "T2")!;
    expect(t2.required_capabilities).toEqual(["NETWORK_ACCESS", "REASONING"]);
    expect(markerFor(r.warnings, "T2")).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    const out = canon(r.tasks, GOAL_NET);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("T3 (local goal): fetch-shaped instruction + local-only goal → ZERO repair", () => {
    const tasks = [workTask("T2", FETCH_INSTRUCTION, ["REASONING"])];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_LOCAL,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0]).toBe(tasks[0]); // untouched identity
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
  });

  it("T4 (non-fetch task): instruction not network-shaped → no capability added", () => {
    const tasks = [workTask("T2", "Analyze fetched_data.csv and write report.txt.", ["REASONING"])];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
  });

  it("T5 (wrong subject): fetch-shaped task about a DIFFERENT subject → no repair; plan-level gate still rejects", () => {
    const tasks = [
      workTask("T2", "Search the web for the latest BTC news and write btc.md.", ["REASONING"]),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET, // MQL5/EA subject
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
    // canonical plan-level gate remains authoritative: no legitimate gatherer → fail
    expect(() => canon([BOOKKEEPING, ...r.tasks], GOAL_NET)).toThrowError(IntegrityError);
    try {
      canon([BOOKKEEPING, ...r.tasks], GOAL_NET);
    } catch (e) {
      expect((e as IntegrityError).code).toBe("FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED");
    }
  });

  it("T6 (unservable): no executor set covers the repaired capability set → NO fabricated repair, fail-closed intact", () => {
    const sparseSets = [
      ["NETWORK_ACCESS"], // network executor without REASONING
      ["REASONING", "FILE_OPERATIONS"], // local executor without NETWORK
    ];
    const tasks = [workTask("T2", FETCH_INSTRUCTION, ["REASONING"])];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: sparseSets,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
    // and the canonical gate still fails the task closed
    expect(() => canon([BOOKKEEPING, ...r.tasks], GOAL_NET)).toThrowError(IntegrityError);
  });

  it("T7 (capability not allowed): NETWORK_ACCESS absent from allowed vocabulary → no repair", () => {
    const noNetAllowed = ALLOWED.filter((c) => c !== "NETWORK_ACCESS");
    const tasks = [workTask("T2", FETCH_INSTRUCTION, ["REASONING"])];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: noNetAllowed,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
  });

  it("T8 (already correct): task carrying NETWORK_ACCESS → zero repair, zero warning, zero change", () => {
    const tasks = [workTask("T2", FETCH_INSTRUCTION, ["NETWORK_ACCESS", "REASONING"])];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0]).toBe(tasks[0]);
  });

  it("T9 (bounded warnings): REPAIRED_NETWORK_CAPABILITY survives >10 earlier unprotected warnings", () => {
    const warnings = [
      ...Array.from({ length: 12 }, (_, i) => `DROP_SOMETHING_${i}:T${i}`),
      "REPAIRED_NETWORK_CAPABILITY:T2",
      "REASK:FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED",
    ];
    const out = boundedAttemptWarnings(warnings);
    expect(out).toContain("REPAIRED_NETWORK_CAPABILITY:T2");
    expect(out).toContain("REASK:FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
    expect(out.length).toBeLessThanOrEqual(12); // protected markers all retained
  });

  it("T10 (gates still authoritative): both existing network gates still fire post-repair", () => {
    // (a) local goal → repair suppressed → task-level gate still rejects the fetch task
    expect(() =>
      canon([BOOKKEEPING, workTask("T2", FETCH_INSTRUCTION, ["REASONING"])], GOAL_LOCAL),
    ).toThrowError(IntegrityError);
    try {
      canon([BOOKKEEPING, workTask("T2", FETCH_INSTRUCTION, ["REASONING"])], GOAL_LOCAL);
    } catch (e) {
      expect((e as IntegrityError).code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
    }
    // (b) current-data goal, one legit NETWORK gatherer + one non-eligible
    //     fetch task (repair skipped: instructionIsDataGathering=false on T3's
    //     non-gathering fetch) → plan-level PASSES, task-level still fires.
    const legitGatherer = workTask(
      "T2",
      "Research the latest MQL5 EA trends online and write research.md.",
      ["NETWORK_ACCESS", "REASONING"],
    );
    const nonEligibleFetch = workTask(
      "T3",
      "Search the web for the latest BTC price today.",
      ["REASONING"],
      ["T2"],
    );
    try {
      canon([BOOKKEEPING, legitGatherer, nonEligibleFetch], GOAL_NET);
      throw new Error("expected task-level gate rejection");
    } catch (e) {
      expect((e as IntegrityError).code).toBe("FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED");
    }
  });
});
