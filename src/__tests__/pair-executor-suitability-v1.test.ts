/**
 * EXECUTOR_SUITABILITY_V1_ACCOUNT_FIRST — economic routing layer tests.
 *
 * Policy under test (src/pair/capability-router.ts):
 *   - CODEX + DEVIN = ACCOUNT_SESSION (default general workforce)
 *   - DEEPSEEK_HARNESS = METERED_API (general-purpose fallback only)
 *   - PAIR_NATIVE = NATIVE (untouched — keeps legacy semantics)
 *   - A metered executor must NEVER outrank a hard-eligible account
 *     executor on priority, verified experience, or tie-break.
 *   - Task suitability (capability-based, deterministic):
 *       remote-lane / network-only caps → DEVIN_PREFERRED
 *       local implementation caps      → CODEX_PREFERRED
 *       anything else                  → NEUTRAL
 *   - Verified Experience re-orders only inside the top tier and only
 *     across equal suitability ranks (gap 1000 ≫ MAX_ADJUSTMENT 40).
 *   - P12 preferredExecutors is a per-tier reorder — it cannot vault a
 *     metered executor above a hard-eligible account executor.
 *   - Nothing in this layer admits, removes, or resurrects an executor.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CapabilityRouter,
  PairControlPlane,
  PairEvidenceStore,
  taskSuitability,
  EXECUTOR_ECONOMIC_CLASS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-esv1-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const DEVIN_CAPS = ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"];
const CODEX_CAPS = [
  "CODE_GENERATION", "CODE_EDITING", "FILE_OPERATIONS",
  "SHELL_EXECUTION", "REASONING", "PYTHON_EXECUTION", "TELEGRAM_DELIVERY", "NETWORK_ACCESS",
];
const DSH_CAPS = [
  "CODE_GENERATION", "CODE_EDITING", "FILE_OPERATIONS",
  "SHELL_EXECUTION", "REASONING", "TELEGRAM_DELIVERY",
];
const NATIVE_CAPS = ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"];

// Production priorities (serve-mission-control.mjs) — DSH 40, CODEX 60,
// DEVIN 80, PAIR_NATIVE 100.
const PROD_PRIORITY: Record<string, number> = {
  DEEPSEEK_HARNESS: 40,
  CODEX: 60,
  DEVIN: 80,
  PAIR_NATIVE: 100,
};

const PROD_CAPS: Record<string, string[]> = {
  DEEPSEEK_HARNESS: DSH_CAPS,
  CODEX: CODEX_CAPS,
  DEVIN: DEVIN_CAPS,
  PAIR_NATIVE: NATIVE_CAPS,
};

function makeCtx(name: string) {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  return { dir, store, service, router: new CapabilityRouter(service) };
}

function registerAll(
  ctx: ReturnType<typeof makeCtx>,
  opts: { disabled?: string[]; quota?: Record<string, string>; unqualified?: string[] } = {},
) {
  for (const [id, caps] of Object.entries(PROD_CAPS)) {
    ctx.service.registerExecutor({
      executor_id: id,
      executor_type: "EXTERNAL_ACP",
      capabilities: caps,
      health_state: "READY",
      status: (opts.disabled ?? []).includes(id) ? "DISABLED" : "ENABLED",
      metadata: {
        routing_priority: PROD_PRIORITY[id],
        transport_type: "ACP_STDIO",
        qualification_state: (opts.unqualified ?? []).includes(id) ? "UNQUALIFIED" : "QUALIFIED",
        permission_modes: ["READ", "WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        quota_state: opts.quota?.[id] ?? "AVAILABLE",
      },
    });
  }
}

function routeTask(
  ctx: ReturnType<typeof makeCtx>,
  caps: string[],
  opts: { advisor?: object; preferredExecutors?: string[] } = {},
) {
  const task = {
    task_id: "TSK_TEST",
    mission_id: null,
    required_capabilities: caps,
    metadata: {},
  };
  return ctx.router.route(task, {
    mode: "PLAN",
    persist: false,
    routingAdvisor: opts.advisor as never,
    preferredExecutors: opts.preferredExecutors,
  });
}

/** An advisor that always picks the named executor — proves the economic
 *  tier bounds the advisor even if it actively wants the metered lane. */
const stubbornAdvisor = (pick: string, seen?: { eligible: string[] }) => ({
  advise: (o: { eligible: Array<Record<string, unknown>> }) => {
    if (seen) seen.eligible = o.eligible.map((d) => String(d.executor_id));
    return {
      advisor_decision_id: "ADR_TEST",
      mode: "TEST",
      score_version: "test",
      selected: pick,
    };
  },
});

describe("EXECUTOR_SUITABILITY_V1 — truth table", () => {
  it("S1: small code patch {CODE_EDITING} → CODEX (DSH priority 40 must not win)", () => {
    const ctx = makeCtx("s1");
    registerAll(ctx);
    const d = routeTask(ctx, ["CODE_EDITING"]);
    expect(d.selected_executor).toBe("CODEX");
  });

  it("S2: small python task {PYTHON_EXECUTION} → CODEX", () => {
    const ctx = makeCtx("s2");
    registerAll(ctx);
    const d = routeTask(ctx, ["PYTHON_EXECUTION"]);
    expect(d.selected_executor).toBe("CODEX");
  });

  it("S3: focused regex+tests {CODE_EDITING,CODE_GENERATION} → CODEX", () => {
    const ctx = makeCtx("s3");
    registerAll(ctx);
    const d = routeTask(ctx, ["CODE_EDITING", "CODE_GENERATION"]);
    expect(d.selected_executor).toBe("CODEX");
  });

  it("S4: long multi-source research {REMOTE_CLOUD_TASK_EXECUTION,NETWORK_ACCESS} → DEVIN", () => {
    const ctx = makeCtx("s4");
    registerAll(ctx);
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("S5: MQL5-style multi-source research {AUTONOMOUS_CODE_EXECUTION,NETWORK_ACCESS} → DEVIN", () => {
    const ctx = makeCtx("s5");
    registerAll(ctx);
    const d = routeTask(ctx, ["AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("S6: clone repo + multi-file impl {REMOTE_CLOUD_TASK_EXECUTION,AUTONOMOUS_CODE_EXECUTION} → DEVIN", () => {
    const ctx = makeCtx("s6");
    registerAll(ctx);
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION"]);
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("S7: autonomous repo task {AUTONOMOUS_CODE_EXECUTION} → DEVIN", () => {
    const ctx = makeCtx("s7");
    registerAll(ctx);
    const d = routeTask(ctx, ["AUTONOMOUS_CODE_EXECUTION"]);
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("S8: network-only research {NETWORK_ACCESS} → DEVIN preferred over CODEX", () => {
    const ctx = makeCtx("s8");
    registerAll(ctx);
    const d = routeTask(ctx, ["NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("DEVIN");
    expect(d.eligible_executors).toEqual(["DEVIN", "CODEX"]);
  });

  it("S9: DEVIN disabled → CODEX fallback on network task; remote-cap task has NO forced fallback", () => {
    const ctx = makeCtx("s9");
    registerAll(ctx, { disabled: ["DEVIN"] });
    const d = routeTask(ctx, ["NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("CODEX");
    // remote caps are served ONLY by DEVIN — with DEVIN down there is no
    // eligible executor at all; suitability never widens eligibility.
    const d2 = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"]);
    expect(d2.selected_executor).toBeNull();
    expect(d2.eligible_executors).toEqual([]);
  });

  it("S10: DEVIN quota exhausted → CODEX fallback", () => {
    const ctx = makeCtx("s10");
    registerAll(ctx, { quota: { DEVIN: "EXHAUSTED" } });
    const d = routeTask(ctx, ["NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("CODEX");
  });

  it("S11: DEVIN account unavailable (auth rejected) → CODEX fallback", () => {
    const ctx = makeCtx("s11");
    registerAll(ctx, { unqualified: [] });
    // simulate unavailable via DISABLED on the network task
    const d = routeTask(ctx, ["NETWORK_ACCESS"], {});
    expect(d.selected_executor).toBe("DEVIN");
    const ctx2 = makeCtx("s11b");
    registerAll(ctx2, { disabled: ["DEVIN"] });
    const d2 = routeTask(ctx2, ["NETWORK_ACCESS"]);
    expect(d2.selected_executor).toBe("CODEX");
  });

  it("S12: CODEX unavailable on network task → DEVIN fallback", () => {
    const ctx = makeCtx("s12");
    registerAll(ctx, { disabled: ["CODEX"] });
    const d = routeTask(ctx, ["NETWORK_ACCESS"]);
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("S13: CODEX+DEVIN unavailable on code task → DSH", () => {
    const ctx = makeCtx("s13");
    registerAll(ctx, { disabled: ["CODEX", "DEVIN"] });
    const d = routeTask(ctx, ["CODE_EDITING"]);
    expect(d.selected_executor).toBe("DEEPSEEK_HARNESS");
  });

  it("S14: DSH better priority while CODEX eligible → DSH must NOT win", () => {
    const ctx = makeCtx("s14");
    registerAll(ctx);
    // REASONING is servable by CODEX(60) and DSH(40) — old order picked DSH.
    const d = routeTask(ctx, ["REASONING"]);
    expect(d.selected_executor).toBe("CODEX");
    expect(d.eligible_executors[0]).toBe("CODEX");
    expect(d.eligible_executors).toContain("DEEPSEEK_HARNESS");
  });

  it("S15: advisor demanding DSH while account executor eligible → DSH still loses", () => {
    const ctx = makeCtx("s15");
    registerAll(ctx);
    const seen: { eligible: string[] } = { eligible: [] };
    const d = routeTask(ctx, ["REASONING"], { advisor: stubbornAdvisor("DEEPSEEK_HARNESS", seen) });
    expect(d.selected_executor).toBe("CODEX");
    // the advisor never even saw the metered lane
    expect(seen.eligible).toEqual(["CODEX"]);
  });

  it("S16: capability hard-fail on DEVIN → suitability does not resurrect it", () => {
    const ctx = makeCtx("s16");
    registerAll(ctx);
    const d = routeTask(ctx, ["CODE_EDITING"]);
    expect(d.selected_executor).toBe("CODEX");
    const devinRej = (d.rejected_executors as Array<{ executor_id: string }>).find(
      (r) => r.executor_id === "DEVIN",
    );
    expect(devinRej).toBeTruthy();
    expect(d.eligible_executors).not.toContain("DEVIN");
  });

  it("S17: PAIR_NATIVE preserves its semantics — AUTOMATON_TASK_EXECUTION → PAIR_NATIVE", () => {
    const ctx = makeCtx("s17");
    registerAll(ctx);
    const d = routeTask(ctx, ["AUTOMATON_TASK_EXECUTION"]);
    expect(d.selected_executor).toBe("PAIR_NATIVE");
    expect(d.eligible_executors).toEqual(["PAIR_NATIVE"]);
  });
});

describe("EXECUTOR_SUITABILITY_V1 — adversarial + boundary", () => {
  it("A1: P12 preferredExecutors cannot vault metered DSH above eligible CODEX", () => {
    const ctx = makeCtx("a1");
    registerAll(ctx);
    const d = routeTask(ctx, ["REASONING"], { preferredExecutors: ["DEEPSEEK_HARNESS", "CODEX"] });
    expect(d.selected_executor).toBe("CODEX");
  });

  it("A2: P12 preferred CODEX still leads inside the account tier", () => {
    const ctx = makeCtx("a2");
    registerAll(ctx);
    const d = routeTask(ctx, ["NETWORK_ACCESS"], { preferredExecutors: ["CODEX"] });
    expect(d.selected_executor).toBe("CODEX");
  });

  it("A3: VE advisor may reorder INSIDE the account tier (NEUTRAL task)", () => {
    const ctx = makeCtx("a3");
    registerAll(ctx);
    // {TELEGRAM_DELIVERY} — DEVIN lacks the cap, so use a stub that picks
    // DEVIN on a NEUTRAL task where both are eligible is impossible since
    // DEVIN can't serve REASONING/TELEGRAM. Use empty caps: everyone
    // eligible, NEUTRAL → advisor pick DEVIN must stand.
    const d = routeTask(ctx, [], { advisor: stubbornAdvisor("DEVIN") });
    expect(d.selected_executor).toBe("DEVIN");
  });

  it("A4: NEUTRAL empty-cap task without advisor → account tier first (CODEX by priority)", () => {
    const ctx = makeCtx("a4");
    registerAll(ctx);
    const d = routeTask(ctx, []);
    expect(d.selected_executor).toBe("CODEX");
    expect(d.eligible_executors.slice(0, 2)).toEqual(["CODEX", "DEVIN"]);
  });

  it("A5: metered-only pool (no account executor eligible) → DSH wins normally", () => {
    const ctx = makeCtx("a5");
    registerAll(ctx, { disabled: ["CODEX", "DEVIN"] });
    const d = routeTask(ctx, ["REASONING"]);
    expect(d.selected_executor).toBe("DEEPSEEK_HARNESS");
  });

  it("A6: router does not mutate task required_capabilities (suitability is select-only)", () => {
    const ctx = makeCtx("a6");
    registerAll(ctx);
    const caps = ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"];
    const task = { task_id: "T1", required_capabilities: caps, metadata: {} };
    ctx.router.route(task, { mode: "PLAN", persist: false });
    expect(caps).toEqual(["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"]);
  });

  it("A7: receipt records task_suitability + economic_policy", () => {
    const ctx = makeCtx("a7");
    registerAll(ctx);
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION"]);
    expect(d.task_suitability).toBe("DEVIN_PREFERRED");
    expect(d.economic_policy).toBe("ACCOUNT_FIRST");
  });

  it("A8: taskSuitability classifier truth table", () => {
    expect(taskSuitability(new Set(["REMOTE_CLOUD_TASK_EXECUTION"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["AUTONOMOUS_CODE_EXECUTION", "FILE_OPERATIONS"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["NETWORK_ACCESS"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["CODE_EDITING", "NETWORK_ACCESS"]))).toBe("CODEX_PREFERRED");
    expect(taskSuitability(new Set(["PYTHON_EXECUTION"]))).toBe("CODEX_PREFERRED");
    expect(taskSuitability(new Set(["TELEGRAM_DELIVERY"]))).toBe("NEUTRAL");
    expect(taskSuitability(new Set())).toBe("NEUTRAL");
  });

  it("A9: economic class map — CODEX/DEVIN account, DSH metered, NATIVE native", () => {
    expect(EXECUTOR_ECONOMIC_CLASS.CODEX).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEVIN).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEEPSEEK_HARNESS).toBe("METERED_API");
    expect(EXECUTOR_ECONOMIC_CLASS.PAIR_NATIVE).toBe("NATIVE");
  });

  it("A10: FILE_OPERATIONS-only task — CODEX(account) beats NATIVE+DSH; NATIVE keeps non-account ordering", () => {
    const ctx = makeCtx("a10");
    registerAll(ctx);
    const d = routeTask(ctx, ["FILE_OPERATIONS"]);
    expect(d.selected_executor).toBe("CODEX");
    // non-account tier keeps legacy priority order: DSH(40) above NATIVE(100)
    expect(d.eligible_executors).toEqual(["CODEX", "DEEPSEEK_HARNESS", "PAIR_NATIVE"]);
  });
});
