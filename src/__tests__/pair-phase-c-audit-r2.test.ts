/**
 * PHASE C — INDEPENDENT AUDIT R2 REGRESSIONS (PR #113 residual findings).
 *
 * Every test pins the contract one audit finding broke. Written against
 * the pre-fix behavior — each FAILS on the R1 HEAD and passes after the
 * minimal fix.
 *
 *   R2-F1 — the planner cost envelope must cover EVERY provider call a
 *     candidate attempt can initiate. A codex attempt's eligibility
 *     re-proof runs TWICE (pre-INITIAL + pre-REASK) and each may trigger
 *     ONE bounded canonical refresh of up to 2 real provider probes
 *     (validateAccess + probeModel): worst case 2 + 4 = 6 requests —
 *     the legacy (INITIAL + REASK) envelope reserved only 2.
 *   R2-F2 — codex qualification probes must consume the ONE run
 *     deadline: no probe may START at/after it, each probe's timeout is
 *     min()'d to the remaining window, and a FAIL_CLOSED_* authority
 *     error inside a probe must never be recorded as a fabricated
 *     UNREACHABLE probe observation.
 *   R2-F3 — prepareDelegatedPlan must reject a definitely-exhausted
 *     mission-count budget BEFORE the paid planner call via a
 *     non-writing read-only check; the atomic reserveBudget() inside
 *     openWorkItem remains the final authority against races.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalQueue,
  BusinessLayer,
  CODEX_CLI_PROVIDER_ID,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  MODEL_ROLE,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ProviderValidator,
  RecoveryController,
  ReconciliationService,
  assignModelRole,
  beginPlannerRun,
  ensureCodexCliCatalog,
  refreshCodexPlannerQualification,
  runPlannerFailover,
  utcnow,
  type DelegatedPlanExpander,
  type PlannerCandidate,
  type PlannerAttemptRecord,
} from "../pair/index.js";
import * as PAIR from "../pair/index.js";

/** AUDIT R2 F1 — the shared per-candidate provider-request bound the
 *  cost envelope must use. Exported by planner-pool; the pre-fix HEAD
 *  has no such symbol (named-import avoided so each test fails on its
 *  own assertion, never a module link error). */
const plannerCandidateRequestBound =
  (PAIR as Record<string, unknown>).plannerCandidateRequestBound as
    | ((c: { transport?: string }) => number)
    | undefined;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phasec-r2-"));
let counter = 0;
const OP = "1882810918";

const errCode = async (fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String((e as { code?: string })?.code ?? "ERR");
  }
};

/* ============================== R2-F1 ============================== */

const CODEX_CAND: PlannerCandidate = {
  model_entry_id: "ME_C1", ref: "codex-cli:m1", provider: "codex-cli",
  model: "m1", transport: "codex_cli",
} as PlannerCandidate;

describe("R2-F1 — the monetary envelope covers every possible provider call", () => {
  it("a codex attempt can PROVABLY initiate more provider calls than the legacy INITIAL+REASK bound (2)", async () => {
    // Simulate the canonical refresh inside BOTH eligibility re-proofs
    // (pre-INITIAL + pre-REASK): each codex refresh may spawn
    // validateAccess + probeModel — 2 real provider probes. INITIAL and
    // REASK each add one transport call. A canonical rejection routes
    // through the REASK path so BOTH eligibility proofs execute.
    const ended: PlannerAttemptRecord[] = [];
    const code = await errCode(() => runPlannerFailover({
      candidates: [CODEX_CAND],
      // ONE bounded canonical refresh per re-proof = up to 2 probes.
      assertEligible: (_c, providerCounter) => {
        if (providerCounter) providerCounter.requests += 2;
      },
      planFn: async (_c, invocation) => {
        if (invocation.providerCounter) invocation.providerCounter.requests += 1;
        return { tasks: [{ task_key: "T1" }], warnings: [] };
      },
      canonicalize: () => {
        throw new PolicyError("FAIL_CLOSED_PLAN_INVALID", "rejected");
      },
      latencyBudget: () => ({ ceilingMs: 60_000, requestTimeoutMs: 60_000 }),
      onAttemptEnd: (_t, rec) => { ended.push(rec); },
    }));
    expect(code).toBeTruthy();
    // Even ONE eligibility re-proof with refresh = 2 probes + 1 INITIAL
    // = 3 provable calls — already beyond the legacy (INITIAL+REASK=2)
    // envelope; the worst case is 2 re-proofs × 2 probes + 2 calls = 6.
    expect(ended).toHaveLength(1);
    expect(Number(ended[0]!.provider_requests)).toBeGreaterThan(2);
  });

  it("the shared per-candidate request bound: codex = 2 plan calls + 4 refresh probes = 6; HTTP = 3", () => {
    expect(typeof plannerCandidateRequestBound).toBe("function");
    expect(plannerCandidateRequestBound!({ transport: "codex_cli" })).toBe(6);
    expect(plannerCandidateRequestBound!({ transport: "http" })).toBe(3);
    expect(plannerCandidateRequestBound!({})).toBe(3);
  });

  it("admission under a METERED_API profile + objective cap: the bound-priced envelope admits at cap, +1 rejects", async () => {
    const d = path.join(ROOT, `${counter++}-f1c`);
    fs.mkdirSync(d, { recursive: true });
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const service = new PairControlPlane(store);
    const cost = service.cost;
    // METERED_API model profile — bounded via reserve_microusd.
    cost.upsertCostProfile({
      ref_type: "model", ref_id: "ME_C1", billing_mode: "METERED_API",
      reserve_microusd: 100,
    }, "TEST");
    const bound = cost.plannerRequestBoundMicrousd(
      { model_entry_id: "ME_C1", transport: "codex_cli" });
    expect(bound.billing.mode).toBe("METERED_API");
    expect(bound.billing.unbounded).toBe(false);
    expect(bound.per_request_microusd).toBe(100);
    // Objective lineage + cap sized EXACTLY to the worst-case envelope.
    const wi = `WI_${counter}`;
    store.put("work_item", wi, {
      work_item_id: wi, business_id: "BIZ_X", status: "READY",
      created_at: utcnow(), version: 0,
    }, 0);
    const oid = `OBJ_${counter}`;
    store.put("workforce_allocation", `WAL_${counter}`, {
      allocation_id: `WAL_${counter}`, objective_id: oid,
      workstream_work_item_id: wi, delegated_child_work_item_id: wi,
      state: "COMMITTED", created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    store.put("objective_auto_policy", `oap:${oid}`, {
      policy_id: `oap:${oid}`, objective_id: oid,
      limits: { budget_microusd_cap: 600 },
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    const est = bound.per_request_microusd *
      (plannerCandidateRequestBound!({ transport: "codex_cli" }));
    expect(est).toBe(600); // 6 requests × 100µ
    const admitted = cost.admitPlannerInvocation({
      planner_run_id: "PRN_F1", work_item_id: wi, est_microusd: est,
    });
    expect(admitted.scope).toBe("CAPPED");
    // One microUSD over the envelope → the SAME cap rejects.
    expect(await errCode(() => cost.admitPlannerInvocation({
      planner_run_id: "PRN_F1B", work_item_id: wi, est_microusd: est + 1,
    }))).toBe("FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED");
  });
});

/* ============================== R2-F2 ============================== */

type RefreshStack = {
  store: PairEvidenceStore;
  meId: string;
  scratchDir: string;
};

function refreshStack(name: string): RefreshStack {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const scratchDir = path.join(d, "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  // Canonical catalog: codex-cli provider (credential_envs [] → probe
  // path AUTH_OK) + model with the planner role, unqualified so the
  // refresh's re-mint chain has real work.
  const meId = ensureCodexCliCatalog(store, "m-r2", "TEST");
  assignModelRole(store, meId, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "TEST" });
  return { store, meId, scratchDir };
}

/** The codex provider row — entity id is a canonical PRV_<digest>, so
 *  look up by the provider_id field. */
function providerRow(store: PairEvidenceStore): Record<string, unknown> | null {
  return (store.list("provider") as Array<Record<string, unknown>>)
    .find((p) => String(p.provider_id) === CODEX_CLI_PROVIDER_ID) ?? null;
}

const okProbe = () => Promise.resolve(
  { outcome: "AUTH_OK", latency_ms: 1, detail: "ok" });

describe("R2-F2 — codex qualification probes consume the ONE run deadline", () => {
  it("a lapsed run deadline → FAIL_CLOSED_PLANNER_DEADLINE before ANY probe: zero requests, zero fabricated observations", async () => {
    const { store, meId, scratchDir } = refreshStack("f2a");
    const providerCounter = { requests: 0 };
    const probes: number[] = [];
    const code = await errCode(() => refreshCodexPlannerQualification(store, {
      provider_id: CODEX_CLI_PROVIDER_ID,
      model_entry_id: meId,
      model: "m-r2",
      scratchDir,
      timeoutMs: 5_000,
      deadlineMs: Date.now() - 1, // run deadline already passed
      providerCounter,
      probeImpl: async (o) => { probes.push(o.timeoutMs); return okProbe(); },
    }));
    expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
    expect(providerCounter.requests).toBe(0);
    expect(probes).toHaveLength(0);
    // No fabricated probe observation: the provider's probe_state must
    // not carry an UNREACHABLE/result for a probe that never ran.
    const p = providerRow(store);
    expect(String(p?.probe_state ?? "")).not.toContain("UNREACHABLE");
  });

  it("a live-but-tiny deadline bounds each probe timeout to the remaining window", async () => {
    const { store, meId, scratchDir } = refreshStack("f2b");
    const providerCounter = { requests: 0 };
    const probes: number[] = [];
    const deadline = Date.now() + 40;
    await refreshCodexPlannerQualification(store, {
      provider_id: CODEX_CLI_PROVIDER_ID,
      model_entry_id: meId,
      model: "m-r2",
      scratchDir,
      timeoutMs: 5_000,           // configured budget is NOT the authority
      deadlineMs: deadline,       // the run deadline is
      providerCounter,
      probeImpl: async (o) => { probes.push(o.timeoutMs); return okProbe(); },
    });
    // Both refresh probes ran (validateAccess + probeModel), each
    // min()'d against the remaining run window — never the bare config.
    expect(probes.length).toBeGreaterThan(0);
    for (const t of probes) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(40);
    }
  });

  it("a mid-refresh deadline lapse stops the NEXT probe — partial spend is honestly counted, then the run dies typed", async () => {
    const { store, meId, scratchDir } = refreshStack("f2c");
    const providerCounter = { requests: 0 };
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const probes: number[] = [];
      const code = await errCode(() => refreshCodexPlannerQualification(store, {
        provider_id: CODEX_CLI_PROVIDER_ID,
        model_entry_id: meId,
        model: "m-r2",
        scratchDir,
        timeoutMs: 5_000,
        deadlineMs: now + 10, // 10ms of run budget
        providerCounter,
        probeImpl: async (o) => {
          probes.push(o.timeoutMs);
          now += 100; // the first probe consumed the entire window
          return okProbe();
        },
      }));
      expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
      // Probe 1 started inside the window (bounded to ≤10ms); probe 2
      // (probeModel) was denied — the counter honestly recorded only
      // the request that provably initiated.
      expect(probes).toHaveLength(1);
      expect(probes[0]).toBeLessThanOrEqual(10);
      expect(providerCounter.requests).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a FAIL_CLOSED_* authority error inside a validateAccess probe PROPAGATES — never fabricated into UNREACHABLE evidence", async () => {
    const { store } = refreshStack("f2d");
    const validator = new ProviderValidator(store);
    const code = await errCode(() => validator.validateAccess(CODEX_CLI_PROVIDER_ID, {
      probe: async () => {
        throw new IntegrityError("FAIL_CLOSED_PLANNER_DEADLINE", "run deadline");
      },
      actor: "TEST",
    }));
    expect(code).toBe("FAIL_CLOSED_PLANNER_DEADLINE");
    const p = providerRow(store);
    // No UNREACHABLE probe observation for a probe that never ran.
    expect(String(p?.probe_state ?? "")).not.toContain("UNREACHABLE");
  });

  it("the pool threads the run deadline into assertEligible so the refresh seam can consume it", async () => {
    const seen: Array<number | null | undefined> = [];
    // deadlineMs is an ABSOLUTE epoch — a live window so the candidate
    // loop reaches the eligibility seam.
    const dl = Date.now() + 60_000;
    await expect(runPlannerFailover({
      candidates: [{
        model_entry_id: "ME_1", ref: "test:m1", provider: "test",
        model: "m1", endpoint: "http://none", credentialEnv: "K",
      } as PlannerCandidate],
      assertEligible: (_c, _counter, runCtx) => {
        seen.push(runCtx?.deadlineMs);
        return { reject: true as const, failure_class: "MODEL_UNAVAILABLE" as never, reason: "x" };
      },
      planFn: async () => ({ tasks: [], warnings: [] }),
      deadlineMs: dl,
    })).rejects.toThrow();
    expect(seen).toEqual([dl]);
  });
});

/* ============================== R2-F3 ============================== */

function bizStack(name: string, expander?: DelegatedPlanExpander | null) {
  const d = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(path.join(d, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: [] as Array<Record<string, unknown>> });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map() as never, scheduler,
    approvals, reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    schedules: new MissionScheduleService(service), planner: planner as never,
  });
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({
    store, control, schedules,
    ...(expander ? { planExpander: expander } : {}),
  });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { store, service, biz, projectId: String(project.project_id) };
}

function mkItem(s: ReturnType<typeof bizStack>, bid?: string) {
  const b = bid
    ? { business_id: bid }
    : s.biz.createBusiness({
        name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  const wi = s.biz.createWorkItem({
    business_id: String(b.business_id),
    title: "w", goal: "local delegated work", operator_id: OP,
  });
  return { wiId: String(wi.work_item_id), businessId: String(b.business_id) };
}

describe("R2-F3 — the hard-stop mission-count budget is proven BEFORE the paid planner call", () => {
  it("an exhausted hard-stop budget rejects prepareDelegatedPlan — zero planner calls, zero reservation writes", async () => {
    const calls = { n: 0 };
    const s = bizStack("f3a", (async (input: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      calls.n += 1;
      return {
        input: {
          ...input,
          metadata: {
            ...(input.metadata as Record<string, unknown> | undefined),
            llm_plan: [{
              task_key: "T2", title: "delegated", task_instruction: "work",
              required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
            }],
            plan_source: "LLM", plan_model: "test-planner",
          },
        },
        planner: { planner_run_id: "PRN_T", attempts: [], winner: { attempt_no: 1 } },
      };
    }) as DelegatedPlanExpander);
    const { wiId: wi1, businessId } = mkItem(s);
    s.biz.createBudgetPolicy({
      business_id: businessId, scope_type: "business",
      period: "DAY", max_missions: 1, hard_stop: true, operator_id: OP,
    });
    // Consume the single mission slot through the canonical open.
    const prepared1 = await s.biz.prepareDelegatedPlan(wi1, OP);
    expect(calls.n).toBe(1);
    s.biz.openWorkItem(wi1, OP, undefined, { prepared_plan: prepared1 });
    const reservationsBefore = s.store.list("budget_reservation").length;
    // Budget now definitely exhausted: used = 1 mission ≥ max 1.
    const { wiId: wi2 } = mkItem(s, businessId);
    const code = await errCode(() => s.biz.prepareDelegatedPlan(wi2, OP));
    expect(code).toBe("FAIL_CLOSED_BUDGET_EXCEEDED");
    // THE contract: no paid planner call was spent on an item that can
    // never open.
    expect(calls.n).toBe(1);
    // Read-only proof: no budget_reservation row was written by the
    // preflight (openWorkItem's atomic reserve remains the only writer).
    expect(s.store.list("budget_reservation").length).toBe(reservationsBefore);
    // The atomic open stays the final authority — identical typed error.
    expect(await errCode(() => s.biz.openWorkItem(wi2, OP)))
      .toBe("FAIL_CLOSED_BUDGET_EXCEEDED");
  });

  it("budget headroom present → prepare proceeds normally", async () => {
    const calls = { n: 0 };
    const s = bizStack("f3b", (async (input: Record<string, unknown>) => {
      calls.n += 1;
      return {
        input: {
          ...input,
          metadata: {
            llm_plan: [{
              task_key: "T2", title: "delegated", task_instruction: "work",
              required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
            }],
            plan_source: "LLM", plan_model: "test-planner",
          },
        },
        planner: { planner_run_id: "PRN_T2", attempts: [], winner: { attempt_no: 1 } },
      };
    }) as DelegatedPlanExpander);
    const { wiId, businessId } = mkItem(s);
    s.biz.createBudgetPolicy({
      business_id: businessId, scope_type: "business",
      period: "DAY", max_missions: 5, hard_stop: true, operator_id: OP,
    });
    await s.biz.prepareDelegatedPlan(wiId, OP);
    expect(calls.n).toBe(1);
  });
});
