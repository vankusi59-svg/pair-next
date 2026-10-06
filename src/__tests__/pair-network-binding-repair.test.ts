/**
 * NETWORK binding repair — R2 semantics: a task is repaired only when its
 * canonical structured `network_requirement` is semantically REQUIRED AND
 * operator-authorized by the goal (a hostname/URL the goal literally
 * names — R3: no entity-token authorization), with
 * NETWORK_ACCESS allowed and the repaired capability set jointly servable.
 * One shared helper post-sanitize on BOTH planner transports; the canonical
 * network gate stays authoritative.
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
  "Nghiên cứu thị trường mql5.com hiện tại để tìm một cơ hội EA MT5 có tiềm năng thương mại tốt.";
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

/** Structured requirements — the canonical inner object. Emission to a
 *  planner transport writes it top-level; sanitize normalizes it into
 *  metadata; repair + the gate read `metadata.network_requirement`. */
const REQ_MQL5 = {
  source_kind: "EXTERNAL_SITE",
  access_intent: "RESEARCH",
  freshness: "REQUIRED",
  source_locator: "https://www.mql5.com",
};
const REQ_BTC = {
  source_kind: "EXTERNAL_SITE",
  access_intent: "RESEARCH",
  freshness: "REQUIRED",
  source_locator: "https://www.btc.example",
};
const REQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
};

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

const canonFail = (raw: Array<Record<string, unknown>>, goal: string) => {
  try {
    canon(raw, goal);
    return null;
  } catch (e) {
    return { code: String((e as IntegrityError).code), detail: String((e as IntegrityError).message) };
  }
};

const workTask = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
  pairCov?: string[],
  netReq?: Record<string, unknown>,
): Record<string, unknown> => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  ...(pairCov !== undefined ? { pair_coverage: pairCov } : {}),
  // emission form (top-level) AND post-sanitize form (metadata) — the two
  // seams this suite exercises read different homes for the same object.
  ...(netReq
    ? {
        network_requirement: netReq,
        metadata: { network_requirement: netReq },
      }
    : {}),
});

/** Same task as a persisted/legacy plan carried it (fieldless). */
const legacyTask = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
): Record<string, unknown> =>
  workTask(key, instruction, caps, depends_on);

const BOOKKEEPING = workTask(
  "T1",
  "Write the goal to mission_goal.txt, then reply DONE.",
  ["AUTOMATON_TASK_EXECUTION"],
);

const markerFor = (warnings: string[], key: string) =>
  warnings.filter((w) => w === `REPAIRED_NETWORK_CAPABILITY:${key}`);

describe("NETWORK binding repair", () => {
  it("T1 (positive, llm lane): REQUIRED+operator-authorized requirement missing NETWORK_ACCESS is repaired → canonicalizer PASSES", async () => {
    const raw = planJson([
      BOOKKEEPING,
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], ["T1"], ["OBL_001"], REQ_MQL5),
      workTask("T3", "Write findings.txt then reply DONE.", ["FILE_OPERATIONS"], ["T2"], [], REQ_LOCAL),
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
    workTask("T2", FETCH_INSTRUCTION, ["REASONING"], ["T1"], ["OBL_001"], REQ_MQL5),
    workTask("T3", "Write findings.txt then reply DONE.", ["FILE_OPERATIONS"], ["T2"], [], REQ_LOCAL),
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

  it("T3 (unauthorized locator): REQUIRED requirement naming a host the goal never names → ZERO repair", () => {
    const tasks = [
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], [], undefined, REQ_MQL5),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_LOCAL, // XAUUSD — no mql5 host
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0]).toBe(tasks[0]); // untouched identity
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
  });

  it("T4 (evidence union): REQUIRED+authorized requirement elevates a quiet instruction — and a fetch-shaped instruction elevates a wrong LOCAL annotation (PAIR derives, annotation is advisory)", () => {
    // requirement is evidence, not suppression: a valid REQUIRED
    // requirement binds even when the instruction reads local; and under
    // the simplified contract a wrong LOCAL annotation can no longer
    // suppress the instruction's own fetch evidence.
    const quiet = [
      workTask("T2", "Write findings.txt then reply DONE.", ["FILE_OPERATIONS"], [], [], REQ_MQL5),
    ];
    const rQuiet = repairNetworkCapabilityBinding(quiet, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(markerFor(rQuiet.warnings, "T2")).toEqual([
      "REPAIRED_NETWORK_CAPABILITY:T2",
    ]);
    expect(rQuiet.tasks[0].required_capabilities).toEqual([
      "FILE_OPERATIONS",
      "NETWORK_ACCESS",
    ]);
    const loud = [
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], [], [], REQ_LOCAL),
    ];
    const rLoud = repairNetworkCapabilityBinding(loud, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(rLoud.warnings).toEqual(["REPAIRED_NETWORK_CAPABILITY:T2"]);
    expect(rLoud.tasks[0].required_capabilities).toEqual([
      "NETWORK_ACCESS",
      "REASONING",
    ]);
  });

  it("T5 (wrong subject): REQUIRED requirement for a host the goal never authorizes → no repair; INVALID gate still rejects", () => {
    const tasks = [
      workTask(
        "T2",
        "Search the web for the latest BTC news and write btc.md.",
        ["REASONING"],
        [],
        [],
        REQ_BTC,
      ),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET, // names mql5.com — btc.example is unauthorized
      allowedCapabilities: ALLOWED,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
    // canonical authority gate remains authoritative: unauthorized source → INVALID
    const f = canonFail([BOOKKEEPING, ...r.tasks], GOAL_NET);
    expect(f?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(f?.detail).toContain("UNAUTHORIZED_SOURCE");
  });

  it("T6 (unservable): no executor set covers the repaired capability set → NO fabricated repair, fail-closed intact", () => {
    const sparseSets = [
      ["NETWORK_ACCESS"], // network executor without REASONING
      ["REASONING", "FILE_OPERATIONS"], // local executor without NETWORK
    ];
    const tasks = [
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], [], [], REQ_MQL5),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: ALLOWED,
      capabilitySets: sparseSets,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
    // and the canonical gate still fails the task closed
    expect(() => canon([BOOKKEEPING, ...r.tasks], GOAL_NET)).toThrowError(
      IntegrityError,
    );
  });

  it("T7 (capability not allowed): NETWORK_ACCESS absent from allowed vocabulary → no repair", () => {
    const noNetAllowed = ALLOWED.filter((c) => c !== "NETWORK_ACCESS");
    const tasks = [
      workTask("T2", FETCH_INSTRUCTION, ["REASONING"], [], [], REQ_MQL5),
    ];
    const r = repairNetworkCapabilityBinding(tasks, {
      goal: GOAL_NET,
      allowedCapabilities: noNetAllowed,
      capabilitySets: CAP_SETS,
    });
    expect(r.warnings).toEqual([]);
    expect(r.tasks[0].required_capabilities).toEqual(["REASONING"]);
  });

  it("T8 (already correct): task carrying NETWORK_ACCESS → zero repair, zero warning, zero change", () => {
    const tasks = [
      workTask("T2", FETCH_INSTRUCTION, ["NETWORK_ACCESS", "REASONING"], [], [], REQ_MQL5),
    ];
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

  it("T10 (gates still authoritative): the canonical network gate still fires post-repair", () => {
    // (a) REQUIRED+unauthorized locator → INVALID (UNAUTHORIZED_SOURCE)
    const a = canonFail(
      [BOOKKEEPING, workTask("T2", FETCH_INSTRUCTION, ["REASONING"], [], [], REQ_BTC)],
      GOAL_NET,
    );
    expect(a?.code).toBe("FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID");
    expect(a?.detail).toContain("UNAUTHORIZED_SOURCE");
    // (b) NOT_REQUIRED task + a NETWORK claim → advisory claim survives
    // (never an authority grant, never a rejection — PAIR derives the
    // requirement; the claim merely routes to an executor whose own
    // policy holds network)
    const b = canonFail(
      [
        BOOKKEEPING,
        workTask("T2", "Write note.txt then reply DONE.", ["NETWORK_ACCESS", "REASONING"], [], [], REQ_LOCAL),
      ],
      GOAL_LOCAL,
    );
    expect(b === null || !b.code.includes("NETWORK")).toBe(true);
    // (c) missing field on a fresh emission → degrades to 'no evidence'
    const c = canonFail(
      [BOOKKEEPING, legacyTask("T2", "Write note.txt then reply DONE.", ["REASONING"])],
      GOAL_LOCAL,
    );
    expect(c === null || !c.code.includes("NETWORK")).toBe(true);
    // (d) malformed field → same degradation
    const d = canonFail(
      [
        BOOKKEEPING,
        {
          ...workTask("T2", "Write note.txt then reply DONE.", ["REASONING"]),
          metadata: { network_requirement: { source_kind: "PORTAL" } },
        },
      ],
      GOAL_LOCAL,
    );
    expect(d === null || !d.code.includes("NETWORK")).toBe(true);
  });
});
