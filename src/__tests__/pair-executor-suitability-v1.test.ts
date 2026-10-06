/**
 * EXECUTOR_SUITABILITY_V1_ACCOUNT_FIRST + R1 — economic routing layer tests.
 *
 * Policy (src/pair/capability-router.ts):
 *   - CODEX + DEVIN = ACCOUNT_SESSION (default general workforce)
 *   - DEEPSEEK_HARNESS = METERED_API (general-purpose fallback only)
 *   - PAIR_NATIVE = NATIVE (untouched — keeps legacy semantics)
 *   - Ordering inside the hard-eligible set ONLY:
 *       economicTier → suitabilityRank → routing_priority → executor_id
 *   - Suitability = declared task_profile (bounded enum, canonical
 *     metadata.task_profile) else caps-based inference. Preferred ≠
 *     required — a lower-rank executor still serves when the preferred
 *     one fails hard eligibility (R1.A same-task fallback).
 *   - VE advisor pool = hard-eligible ∩ top economic tier ∩ top
 *     suitability rank — VE structurally cannot cross either boundary
 *     (R1.C: no magic-number gap).
 *   - P12 preferredExecutors reorders within its own (tier, rank) segment.
 *   - R1.B: PAIR imposes NO daily task count on DEVIN; PAIR_COST_HALT is
 *     an operator kill switch, not a budget.
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
  EXECUTOR_ECONOMIC_CLASS,
  TASK_PROFILES,
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
  opts: {
    disabled?: string[];
    quota?: Record<string, string>;
    unqualified?: string[];
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

describe("EXECUTOR_SUITABILITY_V1 R1 — mandated pins", () => {
  it("R1.1 small code task: CODEX available → CODEX", () => {
    const ctx = makeCtx("r11");
    registerAll(ctx);
    expect(routeTask(ctx, ["CODE_EDITING"]).selected_executor).toBe("CODEX");
    expect(routeTask(ctx, ["PYTHON_EXECUTION"]).selected_executor).toBe("CODEX");
    expect(routeTask(ctx, ["CODE_EDITING"], { profile: "FOCUSED_LOCAL" }).selected_executor).toBe("CODEX");
  });

  it("R1.2 small code CODEX unavailable → DEVIN iff compatible, else DSH", () => {
    // NETWORK_ACCESS-shaped small work: DEVIN and CODEX both serve it.
    const ctx = makeCtx("r12");
    registerAll(ctx, { disabled: ["CODEX"] });
    expect(
      routeTask(ctx, ["NETWORK_ACCESS"], { profile: "FOCUSED_LOCAL" }).selected_executor,
    ).toBe("DEVIN");
    // pure impl caps DEVIN cannot serve → CODEX unavailable → DSH.
    const d2 = routeTask(ctx, ["CODE_EDITING"]);
    expect(d2.selected_executor).toBe("DEEPSEEK_HARNESS");
  });

  it("R1.3 long research SAME TASK: DEVIN available→DEVIN, unavailable→CODEX", () => {
    // Same canonical task (identical caps + profile); only executor
    // availability differs. DEVIN's set is {REMOTE_*, NETWORK_ACCESS} —
    // NETWORK_ACCESS is the shared lane so both remain hard-eligible.
    const caps = ["NETWORK_ACCESS"];
    const up = makeCtx("r13a");
    registerAll(up);
    expect(routeTask(up, caps, { profile: "LONG_RESEARCH" }).selected_executor).toBe("DEVIN");
    const down = makeCtx("r13b");
    registerAll(down, { disabled: ["DEVIN"] });
    const d = routeTask(down, caps, { profile: "LONG_RESEARCH" });
    expect(d.selected_executor).toBe("CODEX");
    expect(d.eligible_executors).toEqual(["CODEX"]);
  });

  it("R1.4 repo-scale SAME TASK: DEVIN available→DEVIN, unavailable→CODEX", () => {
    const caps = ["NETWORK_ACCESS"];
    const up = makeCtx("r14a");
    registerAll(up);
    expect(routeTask(up, caps, { profile: "REPO_SCALE" }).selected_executor).toBe("DEVIN");
    const down = makeCtx("r14b");
    registerAll(down, { disabled: ["DEVIN"] });
    expect(routeTask(down, caps, { profile: "REPO_SCALE" }).selected_executor).toBe("CODEX");
  });

  it("R1.5 DEVIN credential unavailable → CODEX fallback (dispatch live requalification)", () => {
    const ctx = makeCtx("r15");
    registerAll(ctx);
    // DEVIN registered but its adapter reports not-qualified (credential
    // absent) — dispatch-time requalification must reject it and fall
    // back to CODEX on the SAME task.
    const adapters = new Map([
      [
        "DEVIN",
        {
          qualify: () => ({
            qualified: false,
            dispatch_enabled: false,
            reasons: ["MISSING_CREDENTIAL:PAIR_DEVIN_API_KEY"],
          }),
        },
      ],
      [
        "CODEX",
        {
          qualify: () => ({ qualified: true, dispatch_enabled: true }),
          capabilities: () => ({ capability_ids: CODEX_CAPS }),
        },
      ],
    ]);
    const d = ctx.router.route(
      {
        task_id: "T5",
        required_capabilities: ["NETWORK_ACCESS"],
        metadata: { task_profile: "LONG_RESEARCH" },
      },
      { mode: "DISPATCH", persist: false, adapters: adapters as never },
    );
    expect(d.selected_executor).toBe("CODEX");
    expect(d.eligible_executors).toEqual(["CODEX"]);
  });

  it("R1.6 CODEX + DEVIN unavailable → DSH only when hard-compatible", () => {
    const ctx = makeCtx("r16");
    registerAll(ctx, { disabled: ["CODEX", "DEVIN"] });
    expect(routeTask(ctx, ["CODE_EDITING"]).selected_executor).toBe("DEEPSEEK_HARNESS");
    // network task: DSH lacks NETWORK_ACCESS → nothing eligible.
    expect(routeTask(ctx, ["NETWORK_ACCESS"]).selected_executor).toBeNull();
  });

  it("R1.7 NETWORK_ACCESS hard gate cannot be bypassed by suitability", () => {
    const ctx = makeCtx("r17");
    registerAll(ctx);
    const d = routeTask(ctx, ["NETWORK_ACCESS"], { profile: "LONG_RESEARCH" });
    expect(d.selected_executor).toBe("DEVIN");
    const dsh = (d.rejected_executors as Array<{ executor_id: string }>).find(
      (r) => r.executor_id === "DEEPSEEK_HARNESS",
    );
    expect(dsh).toBeTruthy();
    expect(d.eligible_executors).not.toContain("DEEPSEEK_HARNESS");
  });

  it("R1.8 VE cannot cross suitability rank even with priority delta >1000", () => {
    const ctx = makeCtx("r18");
    registerAll(ctx, { priorities: { CODEX: 1, DEVIN: 2000 } });
    const seen: { eligible: string[] } = { eligible: [] };
    // FOCUSED_LOCAL → CODEX rank 0, DEVIN rank 1 — DEVIN is not in the
    // advisor pool at all, so no score can promote it.
    const d = routeTask(ctx, ["NETWORK_ACCESS"], {
      profile: "FOCUSED_LOCAL",
      advisor: stubbornAdvisor("DEVIN", seen),
    });
    expect(seen.eligible).toEqual(["CODEX"]);
    expect(d.selected_executor).toBe("CODEX");
    // control: same-rank NEUTRAL task — VE CAN reorder inside the pool.
    const d2 = routeTask(ctx, [], { advisor: stubbornAdvisor("DEVIN") });
    expect(d2.selected_executor).toBe("DEVIN");
  });

  it("R1.9 VE cannot cross economic tier", () => {
    const ctx = makeCtx("r19");
    registerAll(ctx);
    const seen: { eligible: string[] } = { eligible: [] };
    const d = routeTask(ctx, ["REASONING"], {
      advisor: stubbornAdvisor("DEEPSEEK_HARNESS", seen),
    });
    expect(seen.eligible).toEqual(["CODEX"]);
    expect(d.selected_executor).toBe("CODEX");
  });

  it("R1.10 P12 preferredExecutors cannot vault DSH above account tier", () => {
    const ctx = makeCtx("r110");
    registerAll(ctx);
    const d = routeTask(ctx, ["REASONING"], { preferredExecutors: ["DEEPSEEK_HARNESS", "CODEX"] });
    expect(d.selected_executor).toBe("CODEX");
    // ... nor vault a lower suitability rank within the account tier:
    const d2 = routeTask(ctx, ["NETWORK_ACCESS"], {
      preferredExecutors: ["CODEX", "DEVIN"],
      profile: "LONG_RESEARCH",
    });
    expect(d2.selected_executor).toBe("DEVIN");
  });

  it("R1.11 hard capability rejection cannot be resurrected", () => {
    const ctx = makeCtx("r111");
    registerAll(ctx);
    const d = routeTask(ctx, ["CODE_EDITING"]);
    expect(d.eligible_executors).not.toContain("DEVIN");
    expect(d.selected_executor).toBe("CODEX");
  });

  it("R1.12 PAIR_NATIVE semantics preserved", () => {
    const ctx = makeCtx("r112");
    registerAll(ctx);
    const d = routeTask(ctx, ["AUTOMATON_TASK_EXECUTION"]);
    expect(d.selected_executor).toBe("PAIR_NATIVE");
    expect(d.eligible_executors).toEqual(["PAIR_NATIVE"]);
  });

  it("R1.13+R1.14 no daily Devin task-count limit exists in the serve stack", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "scripts", "serve-mission-control.mjs"),
      "utf8",
    );
    expect(src).not.toMatch(/PAIR_MAX_REMOTE_TASKS_PER_DAY/);
    expect(src).not.toMatch(/MAX_REMOTE_PER_DAY/);
    expect(src).not.toMatch(/remoteDispatchesToday/);
    // R1.15 — the operator kill switch is preserved, re-framed.
    expect(src).toMatch(/PAIR_COST_HALT/);
    expect(src).toMatch(/REMOTE_EXECUTION_HALT/);
  });

  it("R1.16 remote-cap task with DEVIN down fails closed (no forced local fallback)", () => {
    const ctx = makeCtx("r116");
    registerAll(ctx, { disabled: ["DEVIN"] });
    const d = routeTask(ctx, ["REMOTE_CLOUD_TASK_EXECUTION", "NETWORK_ACCESS"]);
    expect(d.selected_executor).toBeNull();
    expect(d.eligible_executors).toEqual([]);
  });

  it("R1.17 CODEX fallback never inherits fake remote capability", () => {
    const ctx = makeCtx("r117");
    registerAll(ctx, { disabled: ["DEVIN"] });
    const caps = ["NETWORK_ACCESS"];
    const task = { task_id: "T", required_capabilities: caps, metadata: { task_profile: "LONG_RESEARCH" } };
    ctx.router.route(task, { mode: "PLAN", persist: false });
    expect(caps).toEqual(["NETWORK_ACCESS"]);
    // CODEX's descriptor keeps its own declared caps — nothing grafted on.
    const rec = ctx.service.getExecutor("CODEX");
    expect(rec.capabilities).toEqual(CODEX_CAPS);
  });

  it("R1.18 historical routing receipt still verifies after policy-version bump", () => {
    const ctx = makeCtx("r118");
    registerAll(ctx);
    const live = ctx.router.route(
      { task_id: "T1", required_capabilities: ["CODE_EDITING"], metadata: {} },
      { mode: "PLAN", persist: true },
    );
    const record = ctx.store.get("routing_decision", String(live.routing_decision_id));
    expect(ctx.router.verifyDecisionDigest(record)).toBe(true);
    // Simulate a receipt minted under the v1 policy string: digest is
    // recomputed over the stored fields only, so it still verifies.
    const historical = {
      ...record,
      routing_decision_id: "RTE_HIST",
      policy_version: "pair.os.vnext.capability-routing.v1",
    };
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(historical)) {
      if (
        !["routing_decision_id", "timestamp", "decision_digest", "version", "entity_type", "entity_id"].includes(k)
      )
        body[k] = v;
    }
    historical.decision_digest = digest(body);
    delete (historical as Record<string, unknown>).version;
    ctx.store.put("routing_decision", "RTE_HIST", historical);
    expect(ctx.router.verifyDecisionDigest(historical)).toBe(true);
    expect(String(record.policy_version)).toBe("pair.os.vnext.capability-routing.v2");
  });

  it("R1.X receipt records task_suitability + task_profile + economic_policy", () => {
    const ctx = makeCtx("rx");
    registerAll(ctx);
    const d = routeTask(ctx, ["NETWORK_ACCESS"], { profile: "LONG_RESEARCH" });
    expect(d.task_suitability).toBe("DEVIN_PREFERRED");
    expect(d.task_profile).toBe("LONG_RESEARCH");
    expect(d.economic_policy).toBe("ACCOUNT_FIRST");
  });
});

describe("EXECUTOR_SUITABILITY_V1 — classifier + boundary", () => {
  it("taskSuitability caps-based fallback (no profile declared)", () => {
    expect(taskSuitability(new Set(["REMOTE_CLOUD_TASK_EXECUTION"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["NETWORK_ACCESS"]))).toBe("DEVIN_PREFERRED");
    expect(taskSuitability(new Set(["CODE_EDITING", "NETWORK_ACCESS"]))).toBe("CODEX_PREFERRED");
    expect(taskSuitability(new Set(["PYTHON_EXECUTION"]))).toBe("CODEX_PREFERRED");
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

  it("profile overrides caps-based inference (planner-declared nature wins)", () => {
    const ctx = makeCtx("povr");
    registerAll(ctx);
    // impl caps alone → CODEX_PREFERRED; FOCUSED_LOCAL agrees → CODEX.
    // LONG_RESEARCH on impl caps → DEVIN_PREFERRED but DEVIN can't serve
    // them — falls back to CODEX anyway (hint ≠ authority).
    const d = routeTask(ctx, ["CODE_EDITING"], { profile: "LONG_RESEARCH" });
    expect(d.selected_executor).toBe("CODEX");
    expect(d.task_suitability).toBe("DEVIN_PREFERRED");
  });

  it("NEUTRAL empty-cap task without advisor → CODEX (top-tier priority)", () => {
    const ctx = makeCtx("neut");
    registerAll(ctx);
    const d = routeTask(ctx, []);
    expect(d.selected_executor).toBe("CODEX");
    expect(d.eligible_executors.slice(0, 2)).toEqual(["CODEX", "DEVIN"]);
  });

  it("metered-only pool → DSH wins normally", () => {
    const ctx = makeCtx("metered");
    registerAll(ctx, { disabled: ["CODEX", "DEVIN"] });
    expect(routeTask(ctx, ["REASONING"]).selected_executor).toBe("DEEPSEEK_HARNESS");
  });

  it("economic class map — CODEX/DEVIN account, DSH metered, NATIVE native", () => {
    expect(EXECUTOR_ECONOMIC_CLASS.CODEX).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEVIN).toBe("ACCOUNT_SESSION");
    expect(EXECUTOR_ECONOMIC_CLASS.DEEPSEEK_HARNESS).toBe("METERED_API");
    expect(EXECUTOR_ECONOMIC_CLASS.PAIR_NATIVE).toBe("NATIVE");
  });
});
