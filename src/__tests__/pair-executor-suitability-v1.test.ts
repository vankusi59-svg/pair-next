/**
 * EXECUTOR_SUITABILITY_V1_ACCOUNT_FIRST + R2 — economic routing layer tests.
 *
 * Final owner-locked policy:
 *   - CODEX + DEVIN = ACCOUNT_SESSION (default general workforce)
 *   - DEEPSEEK_HARNESS = METERED_API (fallback / exception path only)
 *   - PAIR_NATIVE = NATIVE (untouched)
 *   - Ordering inside the hard-eligible set ONLY:
 *       economicTier → suitabilityRank → routing_priority → executor_id
 *   - task_profile is nature/audit metadata — it NEVER grants execution
 *     authority and NEVER changes the remote/local execution class. A
 *     remote task is one whose required_capabilities carry
 *     REMOTE_CLOUD_TASK_EXECUTION / AUTONOMOUS_CODE_EXECUTION; nothing
 *     else. A NETWORK_ACCESS-only ordinary task is NOT a remote task.
 *   - A genuine remote task with DEVIN down → eligible=∅ → fail-closed
 *     into existing recovery/replan. There is NO forced same-task
 *     DEVIN→CODEX fallback for remote-shaped work.
 *   - VE advisor pool = hard-eligible ∩ top tier ∩ top suitability rank
 *     (structural isolation, no magic gap); P12 reorders within its own
 *     (tier, rank) segment; PAIR imposes no daily Devin task count —
 *     PAIR_COST_HALT is the operator kill switch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CapabilityRouter,
  PairControlPlane,
  PairEvidenceStore,
  digest,
  taskSuitability,
  profileSuitability,
  isRemoteCapabilityTask,
  EXECUTOR_ECONOMIC_CLASS,
  TASK_PROFILES,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-esv2-"));
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
  opts: {
    disabled?: string[];
    quota?: Record<string, string>;
    priorities?: Record<string, number>;
  } = {},
) {
  for (const [id, caps] of Object.entries(PROD_CAPS)) {
    ctx.service.registerExecutor({
      executor_id: id,
      executor_type: "EXTERNAL_ACP",
      capabilities: caps,
      health_state: "READY",
      status: (opts.disabled ?? []).includes(id) ? "DISABLED" : "ENABLED",
      metadata: {
        routing_priority: opts.priorities?.[id] ?? PROD_PRIORITY[id],
        transport_type: "ACP_STDIO",
        qualification_state: "QUALIFIED",
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
  opts: { advisor?: object; preferredExecutors?: string[]; profile?: string } = {},
) {
  const task = {
    task_id: "TSK_TEST",
    mission_id: null,
    required_capabilities: caps,
    metadata: opts.profile ? { task_profile: opts.profile } : {},
  };
  return ctx.router.route(task, {
    mode: "PLAN",
    persist: false,
    routingAdvisor: opts.advisor as never,
    preferredExecutors: opts.preferredExecutors,
  });
}

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

describe("EXECUTOR_SUITABILITY_V1 R2 — mandated truth table", () => {
  it("R2.1 FOCUSED_LOCAL + CODE_EDITING → CODEX", () => {
    const ctx = makeCtx("r21");
    registerAll(ctx);
    expect(routeTask(ctx, ["CODE_EDITING"], { profile: "FOCUSED_LOCAL" }).selected_executor).toBe("CODEX");
    expect(routeTask(ctx, ["CODE_EDITING"]).selected_executor).toBe("CODEX");
    expect(routeTask(ctx, ["PYTHON_EXECUTION"]).selected_executor).toBe("CODEX");
  });

  it("R2.2 FOCUSED_LOCAL CODEX unavailable → DEVIN iff compatible, else DSH", () => {
    const ctx = makeCtx("r22");
    registerAll(ctx, { disabled: ["CODEX"] });
    // shared-lane caps both account executors serve → DEVIN
    expect(
      routeTask(ctx, ["NETWORK_ACCESS"], { profile: "FOCUSED_LOCAL" }).selected_executor,
    ).toBe("DEVIN");
    // impl caps DEVIN cannot serve → DSH
    expect(routeTask(ctx, ["CODE_EDITING"]).selected_executor).toBe("DEEPSEEK_HARNESS");
  });

  it("R2.3 NETWORK_ACCESS-only + REPO_SCALE/LONG_RESEARCH profile → NOT routed to DEVIN by profile", () => {
    const ctx = makeCtx("r23");
    registerAll(ctx);
    // Profile is nature metadata: it cannot lift a shared-capability task
    // into remote preference. Default conservative ordering → CODEX first.
    for (const profile of ["REPO_SCALE", "LONG_RESEARCH", "LONG_AUTONOMOUS", "FOCUSED_LOCAL"]) {
      const d = routeTask(ctx, ["NETWORK_ACCESS"], { profile });
      expect(d.selected_executor).toBe("CODEX");
      expect(d.task_suitability).not.toBe("DEVIN_PREFERRED");
    }
    // caps-only identical task — same answer (profile changes nothing).
    expect(routeTask(ctx, ["NETWORK_ACCESS"]).selected_executor).toBe("CODEX");
  });

  it("R2.4 genuine remote LONG_RESEARCH (REMOTE_CLOUD + NETWORK_ACCESS) → DEVIN", () => {
    const ctx = makeCtx("r24");
    registerAll(ctx);
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"], {
      profile: "LONG_RESEARCH",
    });
    expect(d.selected_executor).toBe("DEVIN");
    expect(d.task_suitability).toBe("DEVIN_PREFERRED");
  });

  it("R2.5 same remote task + DEVIN unavailable → no eligible executor (recovery path)", () => {
    const ctx = makeCtx("r25");
    registerAll(ctx, { disabled: ["DEVIN"] });
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"], {
      profile: "LONG_RESEARCH",
    });
    expect(d.selected_executor).toBeNull();
    expect(d.eligible_executors).toEqual([]);
  });

  it("R2.6 genuine REPO_SCALE remote task → DEVIN", () => {
    const ctx = makeCtx("r26");
    registerAll(ctx);
    for (const cap of ["REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION"]) {
      const d = routeTask(ctx, [cap], { profile: "REPO_SCALE" });
      expect(d.selected_executor).toBe("DEVIN");
    }
  });

  it("R2.7 REPO_SCALE remote task + DEVIN unavailable → fail-closed, NOT fake CODEX fallback", () => {
    const ctx = makeCtx("r27");
    registerAll(ctx, { disabled: ["DEVIN"] });
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION"], { profile: "REPO_SCALE" });
    expect(d.selected_executor).toBeNull();
    expect(d.eligible_executors).not.toContain("CODEX");
  });

  it("R2.8 task_profile cannot grant capability — impl caps never reach DEVIN", () => {
    const ctx = makeCtx("r28");
    registerAll(ctx);
    for (const profile of ["REPO_SCALE", "LONG_RESEARCH", "LONG_AUTONOMOUS"]) {
      const d = routeTask(ctx, ["CODE_EDITING"], { profile });
      expect(d.eligible_executors).not.toContain("DEVIN");
      expect(d.selected_executor).toBe("CODEX");
    }
  });

  it("R2.9/10/11 task_profile cannot flip remote classification — F2/F5 stays capability-based", () => {
    // remote_produces_contract / REMOTE_FETCH vs LOCAL_MATERIALIZATION all
    // hang off isRemoteCapabilityTask = required_capabilities only.
    expect(
      isRemoteCapabilityTask({
        required_capabilities: ["NETWORK_ACCESS"],
        metadata: { task_profile: "REPO_SCALE" },
      }),
    ).toBe(false);
    expect(
      isRemoteCapabilityTask({
        required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
        metadata: { task_profile: "FOCUSED_LOCAL" },
      }),
    ).toBe(true);
    expect(
      isRemoteCapabilityTask({ required_capabilities: ["CODE_EDITING"], metadata: {} }),
    ).toBe(false);
  });

  it("R2.12 DSH cannot vault the account tier", () => {
    const ctx = makeCtx("r212");
    registerAll(ctx);
    const seen: { eligible: string[] } = { eligible: [] };
    // VE advisor pool excludes DSH while an account executor is eligible.
    const d = routeTask(ctx, ["REASONING"], {
      advisor: stubbornAdvisor("DEEPSEEK_HARNESS", seen),
    });
    expect(seen.eligible).toEqual(["CODEX"]);
    expect(d.selected_executor).toBe("CODEX");
    // DSH wins only when it is the only hard-compatible executor.
    const d2 = makeCtx("r212b");
    registerAll(d2, { disabled: ["CODEX", "DEVIN"] });
    expect(routeTask(d2, ["CODE_EDITING"]).selected_executor).toBe("DEEPSEEK_HARNESS");
    expect(routeTask(d2, ["NETWORK_ACCESS"]).selected_executor).toBeNull();
  });

  it("R2.13 VE cannot cross economic tier or suitability rank (delta >1000)", () => {
    const ctx = makeCtx("r213");
    registerAll(ctx, { priorities: { CODEX: 1, DEVIN: 2000 } });
    const seen: { eligible: string[] } = { eligible: [] };
    // FOCUSED_LOCAL → CODEX rank 0; DEVIN is not even in the advisor pool.
    const d = routeTask(ctx, ["NETWORK_ACCESS"], {
      profile: "FOCUSED_LOCAL",
      advisor: stubbornAdvisor("DEVIN", seen),
    });
    expect(seen.eligible).toEqual(["CODEX"]);
    expect(d.selected_executor).toBe("CODEX");
    // control: same-rank NEUTRAL — VE may reorder inside the pool.
    const d2 = routeTask(ctx, [], { advisor: stubbornAdvisor("DEVIN") });
    expect(d2.selected_executor).toBe("DEVIN");
  });

  it("R2.14 P12 preferredExecutors cannot vault tier or rank boundary", () => {
    const ctx = makeCtx("r214");
    registerAll(ctx);
    expect(
      routeTask(ctx, ["REASONING"], { preferredExecutors: ["DEEPSEEK_HARNESS", "CODEX"] })
        .selected_executor,
    ).toBe("CODEX");
    // rank boundary: remote contract → DEVIN preferred; preferring CODEX
    // cannot vault rank-1 above rank-0.
    expect(
      routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION"], {
        preferredExecutors: ["CODEX", "DEVIN"],
      }).selected_executor,
    ).toBe("DEVIN");
  });

  it("R2.15 no daily Devin task-count limit exists in the serve stack", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "scripts", "serve-mission-control.mjs"),
      "utf8",
    );
    expect(src).not.toMatch(/PAIR_MAX_REMOTE_TASKS_PER_DAY/);
    expect(src).not.toMatch(/MAX_REMOTE_PER_DAY/);
    expect(src).not.toMatch(/remoteDispatchesToday/);
  });

  it("R2.16 PAIR_COST_HALT remains the fail-closed kill switch", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "scripts", "serve-mission-control.mjs"),
      "utf8",
    );
    expect(src).toMatch(/PAIR_COST_HALT/);
    expect(src).toMatch(/REMOTE_EXECUTION_HALT/);
  });

  it("R2.X historical v1/v2 routing receipt still verifies after policy bump", () => {
    const ctx = makeCtx("rx18");
    registerAll(ctx);
    const live = ctx.router.route(
      { task_id: "T1", required_capabilities: ["CODE_EDITING"], metadata: {} },
      { mode: "PLAN", persist: true },
    );
    const record = ctx.store.get("routing_decision", String(live.routing_decision_id));
    expect(ctx.router.verifyDecisionDigest(record)).toBe(true);
    const historical = {
      ...record,
      routing_decision_id: "RTE_HIST",
      policy_version: "pair.os.vnext.capability-routing.v1",
    };
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(historical)) {
      if (!["routing_decision_id", "timestamp", "decision_digest", "version", "entity_type", "entity_id"].includes(k))
        body[k] = v;
    }
    historical.decision_digest = digest(body);
    delete (historical as Record<string, unknown>).version;
    ctx.store.put("routing_decision", "RTE_HIST", historical);
    expect(ctx.router.verifyDecisionDigest(historical)).toBe(true);
    expect(String(record.policy_version)).toBe("pair.os.vnext.capability-routing.v2");
  });
});

describe("EXECUTOR_SUITABILITY_V1 R2 — classifier + boundary", () => {
  it("taskSuitability — remote lane → DEVIN, impl lane → CODEX, network-only/else → NEUTRAL", () => {
    expect(taskSuitability(new Set(["REMOTE_CLOUD_TASK_EXECUTION"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["AUTONOMOUS_CODE_EXECUTION", "NETWORK_ACCESS"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["CODE_EDITING", "NETWORK_ACCESS"]))).toBe("CODEX_PREFERRED");
    expect(taskSuitability(new Set(["PYTHON_EXECUTION"]))).toBe("CODEX_PREFERRED");
    // R2: NETWORK_ACCESS alone is ordinary network-capable work, not remote.
    expect(taskSuitability(new Set(["NETWORK_ACCESS"]))).toBe("NEUTRAL");
    expect(taskSuitability(new Set(["TELEGRAM_DELIVERY"]))).toBe("NEUTRAL");
    expect(taskSuitability(new Set())).toBe("NEUTRAL");
  });

  it("profileSuitability maps the bounded enum; unknown → null", () => {
    expect(profileSuitability("LONG_RESEARCH")).toBe("DEVIN_PREFERRED");
    expect(profileSuitability("REPO_SCALE")).toBe("DEVIN_PREFERRED");
    expect(profileSuitability("LONG_AUTONOMOUS")).toBe("DEVIN_PREFERRED");
    expect(profileSuitability("FOCUSED_LOCAL")).toBe("CODEX_PREFERRED");
    expect(profileSuitability("DEVIN")).toBeNull();
    expect(profileSuitability("CODEX")).toBeNull();
    expect(profileSuitability(undefined)).toBeNull();
    expect(TASK_PROFILES.size).toBe(4);
  });

  it("receipt records task_suitability + task_profile + economic_policy", () => {
    const ctx = makeCtx("rx");
    registerAll(ctx);
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION"], { profile: "REPO_SCALE" });
    expect(d.task_suitability).toBe("DEVIN_PREFERRED");
    expect(d.task_profile).toBe("REPO_SCALE");
    expect(d.economic_policy).toBe("ACCOUNT_FIRST");
    // NEUTRAL ordinary task still records its declared profile for audit.
    const d2 = routeTask(ctx, ["NETWORK_ACCESS"], { profile: "LONG_RESEARCH" });
    expect(d2.task_suitability).toBe("NEUTRAL");
    expect(d2.task_profile).toBe("LONG_RESEARCH");
  });

  it("economic class map — CODEX/DEVIN account, DSH metered, NATIVE native", () => {
    expect(EXECUTOR_ECONOMIC_CLASS.CODEX).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEVIN).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEEPSEEK_HARNESS).toBe("METERED_API");
    expect(EXECUTOR_ECONOMIC_CLASS.PAIR_NATIVE).toBe("NATIVE");
  });

  it("PAIR_NATIVE semantics preserved", () => {
    const ctx = makeCtx("nat");
    registerAll(ctx);
    const d = routeTask(ctx, ["AUTOMATON_TASK_EXECUTION"]);
    expect(d.selected_executor).toBe("PAIR_NATIVE");
    expect(d.eligible_executors).toEqual(["PAIR_NATIVE"]);
  });
});
