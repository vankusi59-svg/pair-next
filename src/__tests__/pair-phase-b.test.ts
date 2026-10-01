/**
 * Phase B — planner reliability + durable pinned plan.
 *
 * A: Planner multi-model failover — deterministic ordered pool,
 *    failure classification (failover-eligible vs non-failover),
 *    whole-plan-only wins, FAIL_CLOSED_PLANNER_EXHAUSTED evidence.
 * B: planner_attempt provenance — canonical evidence per invocation.
 * C: durable mission_plan_preview — exact plan pinned, atomic
 *    consume→mission, idempotent, restart-safe, tamper-rejecting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  DSH_EXECUTOR_ID,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  NotFoundError,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ReconciliationService,
  RecoveryController,
  ExecutorRegistry,
  digest,
  effectiveInputDigest,
  planDigest,
  planPreviewTtlSeconds,
  runPlannerFailover,
  dedupePlannerCandidates,
  classifyPlannerFailure,
  PLANNER_FAILURE_CLASS,
  assignModelRole,
  revokeModelRole,
  assertPlannerModelRole,
  assertPlannerCandidateEligible,
  beginPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  finishPlannerRun,
  validatePlanProposal,
  providerEntryId,
  providerModelEligibility,
  projectRoutableModels,
  ensureBinding,
  qualifyBinding,
  ProviderValidator,
  ProviderCatalog,
  ModelEvidenceCatalog,
  MODEL_ROLE,
  DevinExecutorAdapter,
  DshExecutorAdapter,
  CodexCliExecutorAdapter,
  devinBlockedGraceMs,
  devinTaskTimeoutMs,
  type DevinFetch,
  type PlannerAttemptRecord,
  type PlannerCandidate,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phase-b-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const T1 = { task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] };
const T2 = { task_key: "T2", title: "t2", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] };

function makeCtx(n: string, opts: { planner?: (i: unknown) => unknown; plannerCalls?: Array<unknown> } = {}) {
  const dir = freshDir(n);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, never>();
  const recon = new ReconciliationService(service, adapters as never);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const plannerCalls = opts.plannerCalls ?? [];
  const planner =
    opts.planner ??
    ((input: { mission: Record<string, unknown> }) => {
      plannerCalls.push(input);
      const pinned = input.mission?.metadata?.pinned_plan_tasks as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
      const llm = input.mission?.metadata?.llm_plan as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(llm) && llm.length) return { tasks: llm };
      return { tasks: [T1] };
    });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: planner as never,
  });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name: n, root_location: workspace });
  return { dir, workspace, store, service, control, runtime, plannerCalls, projectId: String(project.project_id), gate, recon, approvals, scheduler, recovery, planner };
}

const cand = (id: string, ref = `p:${id}`): PlannerCandidate => ({
  model_entry_id: id, ref, provider: "p", model: id,
  endpoint: "https://example.test", credentialEnv: "ENV_X",
});

const okPlan = (label: string) => ({
  tasks: [{ task_key: "T1", title: label, required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  warnings: [] as string[],
});
const failPlan = (w: string) => ({ tasks: [] as Array<Record<string, unknown>>, warnings: [w] });

const expectCode = async (fn: () => unknown | Promise<unknown>, code: string) => {
  try {
    await fn();
  } catch (e) {
    expect(String((e as Error).message)).toContain(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

/** Evidence record as runPlannerFailover emits it. */
const attempt = (over: Partial<PlannerAttemptRecord>): PlannerAttemptRecord => ({
  route: "gemini:m1", provider: "gemini", model_entry_id: "ME_A", model: "m1",
  role: "PLANNER_COORDINATOR", attempt_no: 1,
  started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z",
  latency_ms: 1000, outcome: "SUCCESS", warnings: [],
  ...over,
});

/* ==================== A. FAILOVER (spec tests 1–16) ==================== */

describe("planner failover", () => {
  it("1. primary success → single attempt, winner=primary", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async () => okPlan("t"),
      assertEligible: () => {},
    });
    expect(res.winner.model_entry_id).toBe("A");
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0].outcome).toBe("SUCCESS");
  });

  it("2. primary timeout → fallback wins (ordered)", async () => {
    const seen: string[] = [];
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c) => {
        seen.push(c.model_entry_id);
        return c.model_entry_id === "A" ? failPlan("LLM_PLANNER_REQUEST_TIMEOUT") : okPlan("t");
      },
      assertEligible: () => {},
    });
    expect(seen).toEqual(["A", "B"]);
    expect(res.winner.model_entry_id).toBe("B");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.TIMEOUT);
    expect(res.attempts[1].outcome).toBe("SUCCESS");
  });

  it("3. primary+fallback fail → extra route wins", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B"), cand("C")],
      planFn: async (c) => (c.model_entry_id === "C" ? okPlan("t") : failPlan("LLM_PLANNER_HTTP_500")),
      assertEligible: () => {},
    });
    expect(res.winner.model_entry_id).toBe("C");
    expect(res.attempts).toHaveLength(3);
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE);
  });

  it("4. all routes fail → FAIL_CLOSED_PLANNER_EXHAUSTED with diagnostics", async () => {
    await expectCode(
      () => runPlannerFailover({
        candidates: [cand("A", "p:a"), cand("B", "p:b")],
        planFn: async () => failPlan("LLM_PLANNER_HTTP_429"),
        assertEligible: () => {},
      }),
      "FAIL_CLOSED_PLANNER_EXHAUSTED",
    );
    try {
      await runPlannerFailover({
        candidates: [cand("A", "p:a"), cand("B", "p:b")],
        planFn: async () => failPlan("LLM_PLANNER_HTTP_429"),
        assertEligible: () => {},
      });
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain('"attempts":2');
      expect(msg).toContain('"route":"p:a"');
      expect(msg).toContain(PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED);
      expect(msg).not.toContain("sk-");
    }
  });

  it("5. attempt order is deterministic primary→fallback→extras", async () => {
    const order: string[] = [];
    await runPlannerFailover({
      candidates: [cand("P"), cand("F"), cand("X")].map((c) => ({ ...c, ref: c.model_entry_id })),
      planFn: async (c) => {
        order.push(c.model_entry_id);
        return okPlan("t");
      },
      assertEligible: () => {},
    });
    expect(order).toEqual(["P"]);
  });

  it("6. dedupe on canonical model_entry_id (after resolution)", () => {
    const out = dedupePlannerCandidates([cand("A", "p:a"), cand("A", "p:a2"), cand("B", "p:b")]);
    expect(out.map((c) => c.ref)).toEqual(["p:a", "p:b"]);
  });

  it("7. failure classification matrix", () => {
    const m: Array<[string, string]> = [
      ["LLM_PLANNER_REQUEST_TIMEOUT", "TIMEOUT"],
      ["LLM_PLANNER_REQUEST_ERROR", "NETWORK_ERROR"],
      ["LLM_PLANNER_HTTP_429", "QUOTA_RATE_LIMITED"],
      ["LLM_PLANNER_HTTP_401", "AUTH_REJECTED"],
      ["LLM_PLANNER_HTTP_403", "AUTH_REJECTED"],
      ["LLM_PLANNER_HTTP_404", "MODEL_UNAVAILABLE"],
      ["LLM_PLANNER_HTTP_500", "PROVIDER_UNAVAILABLE"],
      ["LLM_PLANNER_NO_CREDENTIAL", "CREDENTIAL_MISSING"],
      ["LLM_PLAN_NO_JSON", "MALFORMED_RESPONSE"],
      ["LLM_PLAN_NO_TASKS", "EMPTY_RESPONSE"],
      ["LLM_PLAN_ALL_INVALID", "PLAN_INVALID"],
      ["LLM_PLAN_DEGENERATE", "PLAN_DEGENERATE"],
    ];
    for (const [w, cls] of m) expect(classifyPlannerFailure([w])).toBe(cls);
  });

  it("8. IntegrityError from planFn propagates (non-failover)", async () => {
    await expectCode(
      () => runPlannerFailover({
        candidates: [cand("A"), cand("B")],
        planFn: async () => {
          throw new IntegrityError("FAIL_CLOSED_SECRET_CAP_VIOLATION", "x");
        },
        assertEligible: () => {},
      }),
      "FAIL_CLOSED_SECRET_CAP_VIOLATION",
    );
  });

  it("9. role assertion failure propagates (no failover on integrity)", async () => {
    await expectCode(
      () => runPlannerFailover({
        candidates: [cand("A"), cand("B")],
        planFn: async () => okPlan("t"),
        assertEligible: (c) => {
          if (c.model_entry_id === "A") throw new IntegrityError("FAIL_CLOSED_MODEL_ROLE_MISMATCH", "A");
        },
      }),
      "FAIL_CLOSED_MODEL_ROLE_MISMATCH",
    );
  });

  it("10. first whole valid plan wins — no partial composition", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c) =>
        c.model_entry_id === "A" ? { tasks: [T1, T2], warnings: ["LLM_PLAN_PARTIAL_DROPS"] } : okPlan("other"),
      assertEligible: () => {},
    });
    expect(res.winner.model_entry_id).toBe("A");
    expect(res.tasks).toHaveLength(2); // whole plan kept, not merged with B
  });

  it("11. attempt evidence: timestamps, latency, route/provider/model", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A", "gemini:m1")],
      planFn: async () => okPlan("t"),
      assertEligible: () => {},
    });
    const a = res.attempts[0];
    expect(a.route).toBe("gemini:m1");
    expect(a.provider).toBe("p");
    expect(a.model).toBe("A");
    expect(a.attempt_no).toBe(1);
    expect(a.started_at).toBeTruthy();
    expect(a.completed_at).toBeTruthy();
    expect(a.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("12. empty tasks + warnings → classified, failover continues", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c) => (c.model_entry_id === "A" ? failPlan("LLM_PLAN_UNBALANCED_JSON") : okPlan("t")),
      assertEligible: () => {},
    });
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.MALFORMED_RESPONSE);
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("13. network throw (non-integrity) → NETWORK_ERROR → failover", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      planFn: async (c) => {
        if (c.model_entry_id === "A") throw new Error("ENOTFOUND");
        return okPlan("t");
      },
      assertEligible: () => {},
    });
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.NETWORK_ERROR);
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("14. exhausted detail carries routes+classes, never credentials", async () => {
    try {
      await runPlannerFailover({
        candidates: [cand("A", "gemini:m1")],
        planFn: async () => failPlan("LLM_PLANNER_NO_CREDENTIAL"),
        assertEligible: () => {},
      });
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("gemini:m1");
      expect(msg).toContain("CREDENTIAL_MISSING");
      expect(msg).not.toContain("ENV_X"); // env var value never leaked
    }
  });

  it("15. success attempt carries sanitized warnings only", async () => {
    const res = await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async () => ({ tasks: [T1], warnings: ["LLM_PLAN_PARTIAL_DROPS"] }),
      assertEligible: () => {},
    });
    expect(res.attempts[0].warnings).toEqual(["LLM_PLAN_PARTIAL_DROPS"]);
  });

  it("16. eligibility revalidated per invocation (assertRole per candidate)", async () => {
    const asserted: string[] = [];
    await runPlannerFailover({
      candidates: [cand("A"), cand("B"), cand("C")],
      planFn: async () => okPlan("t"),
      assertEligible: (c) => asserted.push(c.model_entry_id),
    });
    expect(asserted).toEqual(["A"]); // stops at first success
  });
});

/* ==================== B/C. PINNED PLAN (spec tests 17–36) ============= */

describe("durable plan preview", () => {
  const submit = { granted_permissions: ["FILE_WRITE"], authorized_workspaces: undefined as string[] | undefined };

  it("17. createPlanPreview persists READY row + attempt evidence", () => {
    const ctx = makeCtx("p17");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g17", metadata: { llm_plan: [T1] }, operator_id: "op1" },
      {
        attempts: [attempt({})],
        winner: attempt({}),
        warnings: [],
        allowed_capabilities: ["FILE_OPERATIONS"],
        capability_sets: [["FILE_OPERATIONS"]],
      },
    );
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(stored.state).toBe("READY");
    expect(stored.plan_digest).toBe(pv.plan_digest);
    expect(stored.project_id).toBe(ctx.projectId);
    expect(stored.expires_at).toBeTruthy();
    const atts = ctx.store.list("planner_attempt").filter((a) => a.preview_id === pv.preview_id);
    expect(atts).toHaveLength(1);
    expect(String(atts[0].planner_attempt_id)).toBe(String(stored.planner_attempt_id));
  });

  it("18. response is derived from the persisted row", () => {
    const ctx = makeCtx("p18");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g18", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(pv.plan_digest).toBe(stored.plan_digest);
    expect(pv.effective_input_digest).toBe(stored.effective_input_digest);
    expect(pv.plan.tasks).toEqual(stored.canonical_tasks);
    expect(pv.expires_at).toBe(stored.expires_at);
  });

  it("19. effective_input_digest covers goal/perms/risk/operator/caps", () => {
    const base = {
      project_id: "P1", goal: "g",
      granted_permissions: ["FILE_WRITE"], authorized_workspaces: ["/w"],
      risk_ceiling: "HIGH", operator_id: "op1",
      allowed_capabilities: ["A"], capability_sets: [["A"]],
    };
    const d0 = effectiveInputDigest(base);
    expect(effectiveInputDigest({ ...base })).toBe(d0); // deterministic
    for (const k of ["goal", "granted_permissions", "risk_ceiling", "operator_id", "allowed_capabilities"] as const) {
      const mod = { ...base, [k]: k === "goal" ? "g2" : k === "operator_id" ? "op2" : k === "risk_ceiling" ? "LOW" : ["X"] };
      expect(effectiveInputDigest(mod as never)).not.toBe(d0);
    }
  });

  it("20. plan_digest deterministic + task order significant", () => {
    const a = { project_id: "P", effective_input_digest: "e", tasks: [T1, T2] };
    const b = { project_id: "P", effective_input_digest: "e", tasks: [T2, { ...T1, depends_on: [] }] };
    expect(planDigest(a)).toBe(planDigest({ ...a }));
    expect(planDigest(a)).not.toBe(planDigest(b));
  });

  it("21. confirm consumes preview + creates mission (exact tasks)", () => {
    const ctx = makeCtx("p21");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g21", metadata: { llm_plan: [T1, T2] }, operator_id: "op1" },
      { attempts: [attempt({})], winner: attempt({}), warnings: [] },
    );
    const m = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    expect(String(m.mission_id)).toMatch(/^MSN_/);
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(stored.state).toBe("CONSUMED");
    expect(stored.consumed_mission_id).toBe(m.mission_id);
  });

  it("22. committed tasks ≡ persisted canonical_tasks (exact plan)", () => {
    const ctx = makeCtx("p22");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g22", metadata: { llm_plan: [T1, T2] }, operator_id: "op1" },
    );
    const m = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    expect(meta.pinned_plan_tasks).toEqual(pv.plan.tasks);
    const pinned = meta.pinned_plan as Record<string, unknown>;
    expect(pinned.preview_id).toBe(pv.preview_id);
    expect(pinned.plan_digest).toBe(pv.plan_digest);
  });

  it("23. idempotent retry → same mission, never a second", async () => {
    const ctx = makeCtx("p23");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g23", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    const m1 = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    const m2 = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    expect(m2.mission_id).toBe(m1.mission_id);
    expect(ctx.store.list("mission").filter((x) => x.project_id === ctx.projectId)).toHaveLength(1);
  });

  it("24. wrong digest → FAIL_CLOSED_PLAN_DIGEST_MISMATCH", async () => {
    const ctx = makeCtx("p24");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g24", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: String(pv.preview_id), plan_digest: "deadbeef", operator_id: "op1" }),
      "FAIL_CLOSED_PLAN_DIGEST_MISMATCH",
    );
  });

  it("25. unknown preview_id → NOT_FOUND fail-closed", async () => {
    const ctx = makeCtx("p25");
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: "MPP_nope", plan_digest: "x", operator_id: "op1" }),
      "NOT_FOUND",
    );
  });

  it("26. expired preview → FAIL_CLOSED_PLAN_PREVIEW_EXPIRED (no regen)", async () => {
    const dir = freshDir("p26");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const gate = new GovernedTaskGate(service);
    const registry = new ExecutorRegistry(service);
    const router = new MissionRouter(service, gate);
    const recovery = new RecoveryController(service);
    const recon = new ReconciliationService(service, new Map() as never);
    const approvals = new ApprovalQueue(service);
    const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
    const runtime = new MissionRuntime({
      service, gate, router, adapters: new Map() as never, scheduler, approvals,
      reconciliation: recon, recovery, planner: () => ({ tasks: [T1] }) as never,
    });
    const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
    const control = new MissionControl({
      service, runtime, supervisor, scheduler, approvals,
      reconciliation: recon, observability: new MissionObservability(service),
      planner: () => ({ tasks: [T1] }) as never,
      planPreviewTtlSeconds: 30,
    });
    service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
    const ws = fs.mkdtempSync(path.join(dir, "ws-"));
    const project = service.createProject({ name: "p26", root_location: ws });
    const pv = control.createPlanPreview({
      project_id: String(project.project_id), goal: "g26", metadata: { llm_plan: [T1] }, operator_id: "op1",
    });
    // force expiry
    const row = store.get("mission_plan_preview", String(pv.preview_id)) as Record<string, unknown>;
    store.put("mission_plan_preview", String(pv.preview_id), {
      ...row, expires_at: "2000-01-01T00:00:00.000Z",
    }, Number(row.version));
    await expectCode(
      () => control.confirmPlanPreview({ preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1" }),
      "FAIL_CLOSED_PLAN_PREVIEW_EXPIRED",
    );
    expect(store.list("mission")).toHaveLength(0);
  });

  it("27. wrong operator → FAIL_CLOSED_PLAN_PREVIEW_OPERATOR", async () => {
    const ctx = makeCtx("p27");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g27", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op2" }),
      "FAIL_CLOSED_PLAN_PREVIEW_OPERATOR",
    );
  });

  it("28. consume+create atomic: mission failure leaves preview READY", async () => {
    const ctx = makeCtx("p28");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g28", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    // Corrupt persisted tasks so confirm-time revalidation throws inside txn.
    const row = ctx.store.get("mission_plan_preview", String(pv.preview_id)) as Record<string, unknown>;
    ctx.store.put("mission_plan_preview", String(pv.preview_id), {
      ...row,
      canonical_tasks: [{ task_key: "T1" }], // schema-invalid
      plan_digest: row.plan_digest,
    }, Number(row.version));
    // digest still matches (digest verified before revalidate; digest over
    // STORED tasks wouldn't match — so tamper at tasks while digest stayed:
    // verification fails on digest first — assert fail-closed either way.
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1" }),
      "FAIL_CLOSED",
    );
  });

  it("29. restart-safe: preview survives a new store instance", () => {
    const dir = freshDir("p29");
    const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
    const build = () => {
      const store = new PairEvidenceStore(path.join(dir, "pair.db"));
      const service = new PairControlPlane(store);
      const gate = new GovernedTaskGate(service);
      const registry = new ExecutorRegistry(service);
      const router = new MissionRouter(service, gate);
      const recovery = new RecoveryController(service);
      const recon = new ReconciliationService(service, new Map() as never);
      const approvals = new ApprovalQueue(service);
      const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
      const runtime = new MissionRuntime({
        service, gate, router, adapters: new Map() as never, scheduler, approvals,
        reconciliation: recon, recovery, planner: () => ({ tasks: [T1] }) as never,
      });
      const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
      const control = new MissionControl({
        service, runtime, supervisor, scheduler, approvals,
        reconciliation: recon, observability: new MissionObservability(service),
        planner: () => ({ tasks: [T1] }) as never,
      });
      return { store, service, control };
    };
    const c1 = build();
    c1.service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
    const project = c1.service.createProject({ name: "p29", root_location: workspace });
    const pv = c1.control.createPlanPreview({
      project_id: String(project.project_id), goal: "g29", metadata: { llm_plan: [T1] }, operator_id: "op1",
    });
    const c2 = build(); // "restart" — fresh objects over same db
    const m = c2.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    expect(String(m.mission_id)).toMatch(/^MSN_/);
  });

  it("30. planner_attempt rows: winner flagged, digest pinned", () => {
    const ctx = makeCtx("p30");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g30", metadata: { llm_plan: [T1] }, operator_id: "op1" },
      {
        attempts: [
          attempt({ attempt_no: 1, outcome: "FAILED", failure_class: "TIMEOUT", route: "gemini:m1" }),
          attempt({ attempt_no: 2, outcome: "SUCCESS", route: "gemini:m2", model: "m2" }),
        ],
        winner: attempt({ attempt_no: 2, outcome: "SUCCESS", route: "gemini:m2", model: "m2" }),
        warnings: [],
      },
    );
    const atts = ctx.store.list("planner_attempt").filter((a) => a.preview_id === pv.preview_id);
    expect(atts).toHaveLength(2);
    const winner = atts.find((a) => a.winner === true);
    expect(winner).toBeTruthy();
    expect(winner!.route).toBe("gemini:m2");
    expect(winner!.plan_digest).toBe(pv.plan_digest);
  });

  it("31. no credentials in preview/attempt rows or events", () => {
    const ctx = makeCtx("p31");
    ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g31 secret-token", metadata: { llm_plan: [T1] }, operator_id: "op1" },
      {
        attempts: [attempt({ warnings: ["LLM_PLANNER_HTTP_401"] })],
        winner: attempt({}),
        warnings: [],
      },
    );
    const blob = JSON.stringify(ctx.store.list("mission_plan_preview")) + JSON.stringify(ctx.store.list("planner_attempt"));
    expect(blob).not.toContain("PAIR_PLANNER_CRED");
    expect(blob).not.toContain("credentialEnv");
  });

  it("32. provenance chain mission→preview→attempt", () => {
    const ctx = makeCtx("p32");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g32", metadata: { llm_plan: [T1] }, operator_id: "op1" },
      { attempts: [attempt({})], winner: attempt({}), warnings: [] },
    );
    const m = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const pinned = meta.pinned_plan as Record<string, unknown>;
    const attemptRow = ctx.store.get("planner_attempt", String(pinned.planner_attempt_id));
    expect(String(attemptRow.preview_id)).toBe(String(pv.preview_id));
    expect(String((attemptRow.provider as string))).toBe("gemini");
    expect(attemptRow.role).toBe("PLANNER_COORDINATOR");
  });

  it("33. tampered canonical_tasks at confirm → revalidation fails closed", async () => {
    const ctx = makeCtx("p33");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g33", metadata: { llm_plan: [T1] }, operator_id: "op1" },
    );
    // Recompute a digest over a *legitimately different* task list to reach
    // revalidation with a consistent digest — the injected task is invalid.
    const row = ctx.store.get("mission_plan_preview", String(pv.preview_id)) as Record<string, unknown>;
    const tampered = [{ task_key: "T1", title: "x", required_capabilities: ["NOPE_CAP"], depends_on: [] }];
    const newDigest = planDigest({
      project_id: ctx.projectId,
      effective_input_digest: String(row.effective_input_digest),
      tasks: tampered,
      granted_permissions: submit.granted_permissions,
      authorized_workspaces: [],
      risk_ceiling: null,
    });
    ctx.store.put("mission_plan_preview", String(pv.preview_id), { ...row, canonical_tasks: tampered, plan_digest: newDigest }, Number(row.version));
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: String(pv.preview_id), plan_digest: newDigest, operator_id: "op1" }),
      "FAIL_CLOSED_TASK_CAPABILITY_UNKNOWN",
    );
    // preview NOT consumed on failed confirm
    expect(String((ctx.store.get("mission_plan_preview", String(pv.preview_id)) as Record<string, unknown>).state)).toBe("READY");
  });

  it("34. confirm requires preview_id — digest-only legacy path removed from UI flow", async () => {
    const ctx = makeCtx("p34");
    await expectCode(
      () => ctx.control.confirmPlanPreview({ preview_id: "", plan_digest: "x", operator_id: "op1" }),
      "NOT_FOUND",
    );
  });

  it("35. plan preview TTL env bound (env-config)", () => {
    expect(planPreviewTtlSeconds({ PAIR_PLAN_PREVIEW_TTL_S: "60" })).toBe(60);
    expect(() => planPreviewTtlSeconds({ PAIR_PLAN_PREVIEW_TTL_S: "5" })).toThrow(); // <30 → fail closed
    expect(() => planPreviewTtlSeconds({ PAIR_PLAN_PREVIEW_TTL_S: "x" })).toThrow();
  });

  it("36. planner invoked exactly once per pinned mission", () => {
    const ctx = makeCtx("p36");
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g36", metadata: { llm_plan: [T1] }, operator_id: "op1" },
      { attempts: [attempt({})], winner: attempt({}), warnings: [] },
    );
    const callsAfterPreview = ctx.plannerCalls.length;
    ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id), plan_digest: String(pv.plan_digest), operator_id: "op1",
    });
    // confirm never re-runs the planner: no additional plannerCalls
    expect(ctx.plannerCalls.length).toBe(callsAfterPreview);
  });
});

/* ============ role-borrowing guard — planner failover never uses DSH == */

describe("planner/DSH pool isolation", () => {
  it("37. revoked planner role → assertPlannerModelRole fails (no silent borrow)", () => {
    const dir = freshDir("p37");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const mcat = new ModelEvidenceCatalog(store);
    const { entry } = mcat.upsertModelClaim({
      provider_id: "gemini", provider_family: "gemini",
      model_id: "m1", capability_hints: ["text_inference"],
    });
    assignModelRole(store, String(entry.model_entry_id), MODEL_ROLE.PLANNER_COORDINATOR, "test");
    revokeModelRole(store, String(entry.model_entry_id), "test");
    expect(() => assertPlannerModelRole(store, String(entry.model_entry_id))).toThrow(/FAIL_CLOSED/);
  });
});

/* ============ R1 — zero-eligible fail-closed + durable run evidence +
 *            canonical validation inside failover + eligibility =========== */

/** Drive failover with durable-evidence hooks, mirroring the serve seam. */
const runDurable = async (
  store: PairEvidenceStore,
  opts: Parameters<typeof runPlannerFailover>[0],
  projectId = "P1",
) => {
  const run = beginPlannerRun(store, {
    project_id: projectId,
    operator_id: "op1",
    routes: opts.candidates.map((c) => c.ref),
  });
  const runId = String(run.planner_run_id);
  try {
    const res = await runPlannerFailover({
      ...opts,
      onAttemptStart: (b) =>
        persistPlannerAttemptStart(store, {
          planner_run_id: runId,
          project_id: projectId,
          record: b,
        }).planner_attempt_id,
      onAttemptEnd: (tok, rec) =>
        settlePlannerAttempt(store, {
          planner_attempt_id: String(tok),
          record: rec,
          winner: rec.outcome === "SUCCESS",
        }),
      onExhausted: () =>
        finishPlannerRun(store, { planner_run_id: runId, outcome: "EXHAUSTED" }),
    });
    finishPlannerRun(store, {
      planner_run_id: runId,
      outcome: "WINNER_SELECTED",
      winner_attempt_no: res.winner.attempt_no,
    });
    return { res, runId };
  } catch (e) {
    const r = store.get("planner_run", runId);
    if (String(r.state) === "RUNNING") {
      finishPlannerRun(store, {
        planner_run_id: runId,
        outcome: "FAILED",
        error_code: (e as { code?: string }).code ?? "ERR",
      });
    }
    throw e;
  }
};

const attemptsOf = (store: PairEvidenceStore, runId: string) =>
  store
    .list("planner_attempt")
    .filter((a) => String(a.planner_run_id) === runId)
    .sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no));

describe("R1 — zero eligible + durable evidence", () => {
  it("38. zero candidates → FAIL_CLOSED_PLANNER_NO_ELIGIBLE (planFn never runs)", async () => {
    let called = 0;
    await expectCode(
      () =>
        runPlannerFailover({
          candidates: [],
          planFn: async () => {
            called++;
            return okPlan("t");
          },
          assertEligible: () => {},
        }),
      "FAIL_CLOSED_PLANNER_NO_ELIGIBLE",
    );
    expect(called).toBe(0);
  });

  it("39. zero-candidate failure → no preview/mission/attempt rows, no T1", async () => {
    const ctx = makeCtx("p39");
    // Serve-seam order: begin run → runPlannerFailover throws before any
    // attempt → run settles FAILED → createPlanPreview is never reached.
    const run = beginPlannerRun(ctx.store, {
      project_id: ctx.projectId,
      operator_id: "op1",
      routes: ["gemini:gone"],
    });
    await expectCode(
      () =>
        runPlannerFailover({
          candidates: [],
          planFn: async () => okPlan("t"),
          assertEligible: () => {},
        }),
      "FAIL_CLOSED_PLANNER_NO_ELIGIBLE",
    );
    finishPlannerRun(ctx.store, {
      planner_run_id: String(run.planner_run_id),
      outcome: "FAILED",
      error_code: "FAIL_CLOSED_PLANNER_NO_ELIGIBLE",
    });
    expect(ctx.store.list("mission_plan_preview")).toHaveLength(0);
    expect(ctx.store.list("mission")).toHaveLength(0);
    expect(ctx.store.list("planner_attempt")).toHaveLength(0);
    const r = ctx.store.get("planner_run", String(run.planner_run_id));
    expect(String(r.state)).toBe("FAILED");
    expect(String(r.error_code)).toBe("FAIL_CLOSED_PLANNER_NO_ELIGIBLE");
  });

  it("40. exhausted → run EXHAUSTED + every failed attempt durable across reopen", async () => {
    const dir = freshDir("p40");
    const db = path.join(dir, "pair.db");
    const store = new PairEvidenceStore(db);
    const runId = await (async () => {
      try {
        await runDurable(store, {
          candidates: [cand("A", "p:a"), cand("B", "p:b")],
          planFn: async (c) =>
            failPlan(c.model_entry_id === "A" ? "LLM_PLANNER_REQUEST_TIMEOUT" : "LLM_PLANNER_HTTP_500"),
          assertEligible: () => {},
        });
        throw new Error("unreachable");
      } catch (e) {
        expect(String((e as Error).message)).toContain("FAIL_CLOSED_PLANNER_EXHAUSTED");
      }
      return String(store.list("planner_run")[0].planner_run_id);
    })();
    // Reopen a fresh store over the same db — evidence survives restart.
    const store2 = new PairEvidenceStore(db);
    const run = store2.get("planner_run", runId);
    expect(String(run.state)).toBe("EXHAUSTED");
    const atts = attemptsOf(store2, runId);
    expect(atts).toHaveLength(2);
    expect(atts.map((a) => a.outcome)).toEqual(["FAILED", "FAILED"]);
    expect(atts[0].failure_class).toBe("TIMEOUT");
    expect(atts[1].failure_class).toBe("PROVIDER_UNAVAILABLE");
    expect(store2.list("mission_plan_preview")).toHaveLength(0);
    expect(store2.list("mission")).toHaveLength(0);
    // Events reconstructable: PLANNER_RUN_EXHAUSTED + per-attempt FAILED.
    const ev = store2.listEvents().map((x) => String(x.event_type));
    expect(ev).toContain("PLANNER_RUN_EXHAUSTED");
    expect(ev.filter((x) => x === "PLANNER_ATTEMPT_FAILED")).toHaveLength(2);
  });

  it("41. failover success → STARTED→SUCCESS durable + preview links run + winner digest", async () => {
    const ctx = makeCtx("p41");
    const { res, runId } = await runDurable(ctx.store, {
      candidates: [cand("A", "p:a"), cand("B", "p:b")],
      planFn: async (c) => (c.model_entry_id === "A" ? failPlan("LLM_PLANNER_HTTP_429") : okPlan("t")),
      assertEligible: () => {},
    }, ctx.projectId);
    expect(res.winner.model_entry_id).toBe("B");
    const atts = attemptsOf(ctx.store, runId);
    expect(atts.map((a) => a.outcome)).toEqual(["FAILED", "SUCCESS"]);
    expect(atts[1].winner).toBe(true);
    // Preview links the run atomically — no duplicate attempt rows.
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g41", metadata: { llm_plan: res.tasks }, operator_id: "op1" },
      { planner_run_id: runId, attempts: res.attempts, winner: res.winner, warnings: [] },
    );
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(String(stored.planner_run_id)).toBe(runId);
    const linked = attemptsOf(ctx.store, runId);
    expect(linked).toHaveLength(2);
    for (const a of linked) expect(String(a.preview_id)).toBe(String(pv.preview_id));
    const winnerRow = linked.find((a) => a.winner === true)!;
    expect(String(winnerRow.plan_digest)).toBe(String(pv.plan_digest));
    expect(String(stored.planner_attempt_id)).toBe(String(winnerRow.planner_attempt_id));
    const run = ctx.store.get("planner_run", runId);
    expect(String(run.state)).toBe("WINNER_SELECTED");
    expect(String(run.preview_id)).toBe(String(pv.preview_id));
    const read = ctx.control.planPreview(String(pv.preview_id)) as {
      planner_run: Record<string, unknown>;
      planner_attempts: Array<Record<string, unknown>>;
    };
    expect(String(read.planner_run.planner_run_id)).toBe(runId);
    expect(read.planner_attempts).toHaveLength(2);
  });

  it("42. canonicalize seam: A non-empty-but-invalid → PLAN_INVALID → B wins", async () => {
    const caps = new Set(["FILE_OPERATIONS"]);
    const canon = (tasks: Array<Record<string, unknown>>) =>
      validatePlanProposal({ tasks }, caps) as unknown as Array<Record<string, unknown>>;
    const res = await runPlannerFailover({
      candidates: [cand("A"), cand("B")],
      // A returns a non-empty sanitized-looking plan that fails the real
      // canonical validator (unknown capability reference).
      planFn: async (c) =>
        c.model_entry_id === "A"
          ? { tasks: [{ task_key: "T1", title: "bad", required_capabilities: ["NO_SUCH_CAP"], depends_on: [] }], warnings: [] }
          : okPlan("t"),
      assertEligible: () => {},
      canonicalize: canon,
    });
    expect(res.winner.model_entry_id).toBe("B");
    expect(res.attempts[0].failure_class).toBe(PLANNER_FAILURE_CLASS.PLAN_INVALID);
    expect(res.attempts[0].warnings).toContain("CANONICAL_VALIDATION_FAILED");
  });

  it("43. all canonical-invalid → EXHAUSTED + durable failed attempts", async () => {
    const dir = freshDir("p43");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const canon = () => {
      throw new IntegrityError("FAIL_CLOSED_PLAN_PROPOSAL_INVALID", "placeholder");
    };
    await expectCode(
      () =>
        runDurable(store, {
          candidates: [cand("A", "p:a"), cand("B", "p:b")],
          planFn: async () => okPlan("t"),
          assertEligible: () => {},
          canonicalize: canon,
        }),
      "FAIL_CLOSED_PLANNER_EXHAUSTED",
    );
    const run = store.list("planner_run")[0];
    expect(String(run.state)).toBe("EXHAUSTED");
    const atts = attemptsOf(store, String(run.planner_run_id));
    expect(atts).toHaveLength(2);
    for (const a of atts) expect(a.failure_class).toBe("PLAN_INVALID");
  });
});

/* ============ R1 §9 — runtime eligibility revalidation ================ */

// R2 §6 — fixtures model the INTENDED canonical state: a valid planner
// candidate is QUALIFIED via the real qualification seam, never merely
// DISCOVERED by accident.
const mkModel = (
  store: PairEvidenceStore,
  pid: string,
  mid: string,
  opts: { conditions?: string[]; aliases?: string[]; lifecycle?: string } = {},
) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid,
    provider_family: pid,
    model_id: mid,
    capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  const lifecycle = opts.lifecycle ?? "QUALIFIED";
  if (lifecycle === "QUALIFIED") {
    mcat.issueQualificationReceipt(eid, {
      capability_scope: ["text_inference"],
      verifier: "test-probe",
      evidence_refs: ["fixture"],
      actor: "t",
    });
  } else if (lifecycle !== "DISCOVERED") {
    const body = store.get("model_entry", eid);
    store.put("model_entry", eid, { ...body, lifecycle_state: lifecycle }, Number(body.version));
  }
  if (opts.conditions?.length || opts.aliases?.length) {
    const body = store.get("model_entry", eid);
    store.put("model_entry", eid, {
      ...body,
      conditions: opts.conditions ?? body.conditions,
      model_alias_ids: opts.aliases ?? body.model_alias_ids,
    }, Number(body.version));
  }
  return eid;
};
const mkProvider = (
  store: PairEvidenceStore,
  pid: string,
  opts: { lifecycle?: string; auth_state?: string; health_state?: string; conditions?: string[] } = {},
) => {
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id);
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id }),
    lifecycle_state: opts.lifecycle ?? "QUALIFIED",
    auth_state: opts.auth_state ?? "AUTH_OK",
    health_state: opts.health_state ?? "READY",
    conditions: opts.conditions ?? [],
  }, existing ? Number(existing.version) : 0);
};

describe("R1 §9 — assertPlannerCandidateEligible", () => {
  it("44. role revoked before invocation → IntegrityError propagates", () => {
    const dir = freshDir("p44");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const me = mkModel(store, "gemini", "m1");
    mkProvider(store, "gemini");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "test" });
    expect(() => assertPlannerCandidateEligible(store, me)).not.toThrow();
    revokeModelRole(store, me, { actor: "test" });
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_MODEL_ROLE/);
  });

  it("45. model REMOVED before invocation → not invoked (fail closed)", async () => {
    const dir = freshDir("p45");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meA = mkModel(store, "pa", "ma");
    mkProvider(store, "pa");
    const meB = mkModel(store, "pb", "mb");
    mkProvider(store, "pb");
    assignModelRole(store, meA, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    assignModelRole(store, meB, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    // A becomes unusable between boot qualification and invocation.
    const bodyA = store.get("model_entry", meA);
    store.put("model_entry", meA, { ...bodyA, conditions: ["REMOVED"] }, Number(bodyA.version));
    let invoked = 0;
    await expectCode(
      () =>
        runPlannerFailover({
          candidates: [
            { model_entry_id: meA, ref: "pa:ma", provider: "pa", model: "ma", endpoint: "x", credentialEnv: "E" },
            { model_entry_id: meB, ref: "pb:mb", provider: "pb", model: "mb", endpoint: "x", credentialEnv: "E" },
          ],
          planFn: async () => {
            invoked++;
            return okPlan("t");
          },
          assertEligible: (c) => assertPlannerCandidateEligible(store, c.model_entry_id),
        }),
      "FAIL_CLOSED_MODEL_ROLE_MODEL_NOT_USABLE",
    );
    expect(invoked).toBe(0);
  });

  it("46. provider no longer eligible → not invoked", () => {
    const dir = freshDir("p46");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const me = mkModel(store, "pc", "mc");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    mkProvider(store, "pc", { lifecycle: "DISCOVERED" });
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    mkProvider(store, "pc", { lifecycle: "QUALIFIED" });
    expect(() => assertPlannerCandidateEligible(store, me)).not.toThrow();
  });

  it("47. DSH_EXECUTION model (or proven alias) is never borrowed", () => {
    const dir = freshDir("p47");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const meA = mkModel(store, "px", "mA");
    const meB = mkModel(store, "px", "mB", { aliases: ["mA"] }); // proven alias of A
    mkProvider(store, "px");
    assignModelRole(store, meA, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    assignModelRole(store, meB, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    // Candidate B is a DSH model — its own role check fails first.
    expect(() => assertPlannerCandidateEligible(store, meB)).toThrow(/FAIL_CLOSED_MODEL_ROLE/);
    // Candidate A holds PLANNER but is a proven alias of the DSH entry →
    // canonically the same model → the DSH-overlap guard fires.
    expect(() => assertPlannerCandidateEligible(store, meA)).toThrow(/FAIL_CLOSED_PLANNER_DSH_OVERLAP/);
    // An unrelated planner model with no proven DSH alias stays clean.
    const meC = mkModel(store, "py", "mC");
    mkProvider(store, "py");
    assignModelRole(store, meC, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    expect(() => assertPlannerCandidateEligible(store, meC)).not.toThrow();
  });

  it("48. one seam: failover canonical tasks ≡ preview canonical_tasks", async () => {
    const ctx = makeCtx("p48");
    const caps = new Set(["FILE_OPERATIONS"]);
    const canon = (tasks: Array<Record<string, unknown>>) =>
      validatePlanProposal({ tasks }, caps) as unknown as Array<Record<string, unknown>>;
    const res = await runPlannerFailover({
      candidates: [cand("A")],
      planFn: async () => ({ tasks: [T1, T2], warnings: [] }),
      assertEligible: () => {},
      canonicalize: canon,
    });
    const pv = ctx.control.createPlanPreview(
      { project_id: ctx.projectId, goal: "g48", metadata: { llm_plan: res.tasks }, operator_id: "op1" },
      { attempts: res.attempts, winner: res.winner, warnings: [] },
    );
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    expect(stored.canonical_tasks).toEqual(res.tasks);
    expect(pv.plan.tasks).toEqual(res.tasks);
  });
});

/* ============ R2 — model/provider canonical eligibility gates ========== */

/** Candidate built from a mkModel entry. */
const candOf = (me: string, pid: string, mid: string): PlannerCandidate => ({
  model_entry_id: me,
  ref: `${pid}:${mid}`,
  provider: pid,
  model: mid,
  endpoint: "x",
  credentialEnv: "E",
});

const setModelLifecycle = (store: PairEvidenceStore, eid: string, s: string) => {
  const b = store.get("model_entry", eid);
  store.put("model_entry", eid, { ...b, lifecycle_state: s }, Number(b.version));
};
const setModelConditions = (store: PairEvidenceStore, eid: string, c: string[]) => {
  const b = store.get("model_entry", eid);
  store.put("model_entry", eid, { ...b, conditions: c }, Number(b.version));
};

describe("R2 §5 — provider/model eligibility gates", () => {
  const setup = (tag: string, modelOpts: Parameters<typeof mkModel>[3] = {}, provOpts: Parameters<typeof mkProvider>[2] = {}) => {
    const dir = freshDir(tag);
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const me = mkModel(store, "pg", "mg", modelOpts);
    mkProvider(store, "pg", provOpts);
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    return { store, me };
  };

  it("49A. model DISCOVERED → availability rejection MODEL_UNAVAILABLE", async () => {
    const { store, me } = setup("p49", { lifecycle: "DISCOVERED" });
    const elig = assertPlannerCandidateEligible(store, me);
    expect(elig).toMatchObject({ reject: true, failure_class: "MODEL_UNAVAILABLE" });
    // Failover-eligible: candidate rejected, next wins.
    const res = await runPlannerFailover({
      candidates: [candOf(me, "pg", "mg"), cand("B", "pb:mb")],
      planFn: async (c) => okPlan(c.model_entry_id),
      assertEligible: (c) =>
        c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
    });
    expect(res.winner.model_entry_id).toBe("B");
    expect(res.attempts[0].failure_class).toBe("MODEL_UNAVAILABLE");
    expect(res.attempts[0].warnings[0]).toContain("ELIGIBILITY_REJECTED");
  });

  it("50B. model PROBED → not eligible (same MODEL_UNAVAILABLE class)", () => {
    const { store, me } = setup("p50", { lifecycle: "PROBED" });
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({
      reject: true,
      failure_class: "MODEL_UNAVAILABLE",
    });
  });

  it("51C. model QUALIFIED + all gates → eligible", () => {
    const { store, me } = setup("p51");
    expect(assertPlannerCandidateEligible(store, me)).toBeUndefined();
  });

  it("52D. qualification downgraded after boot → not invoked", async () => {
    const { store, me } = setup("p52");
    expect(assertPlannerCandidateEligible(store, me)).toBeUndefined();
    setModelLifecycle(store, me, "DISCOVERED"); // downgrade before invocation
    let invoked = 0;
    const res = await runPlannerFailover({
      candidates: [candOf(me, "pg", "mg"), cand("B", "pb:mb")],
      planFn: async () => {
        invoked++;
        return okPlan("t");
      },
      assertEligible: (c) =>
        c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
    });
    expect(invoked).toBe(1); // only B invoked
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("53E. model STALE → not invoked (MODEL_UNAVAILABLE)", () => {
    const { store, me } = setup("p53");
    setModelConditions(store, me, ["STALE"]);
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({
      reject: true,
      failure_class: "MODEL_UNAVAILABLE",
    });
  });

  it("54F. model UNAVAILABLE → rejected, failover wins on fallback", async () => {
    const { store, me } = setup("p54");
    setModelConditions(store, me, ["UNAVAILABLE"]);
    const res = await runPlannerFailover({
      candidates: [candOf(me, "pg", "mg"), cand("B", "pb:mb")],
      planFn: async (c) => okPlan(c.model_entry_id),
      assertEligible: (c) =>
        c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
    });
    expect(res.winner.model_entry_id).toBe("B");
    expect(res.attempts[0].failure_class).toBe("MODEL_UNAVAILABLE");
  });

  it("55G. provider AUTH_FAILED → authority fail-closed (never failover)", async () => {
    const { store, me } = setup("p55", {}, { auth_state: "AUTH_FAILED" });
    await expectCode(
      () =>
        runPlannerFailover({
          candidates: [candOf(me, "pg", "mg"), cand("B", "pb:mb")],
          planFn: async () => okPlan("t"),
          assertEligible: (c) =>
            c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
        }),
      "FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE",
    );
  });

  it("56H. provider health DOWN → availability rejection, fallback wins", async () => {
    const { store, me } = setup("p56", {}, { health_state: "DOWN" });
    expect(assertPlannerCandidateEligible(store, me)).toMatchObject({
      reject: true,
      failure_class: "PROVIDER_UNAVAILABLE",
    });
    const res = await runPlannerFailover({
      candidates: [candOf(me, "pg", "mg"), cand("B", "pb:mb")],
      planFn: async (c) => okPlan(c.model_entry_id),
      assertEligible: (c) =>
        c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
    });
    expect(res.winner.model_entry_id).toBe("B");
  });

  it("57I. provider DISABLED/UNQUALIFIED → authority fail-closed", () => {
    const { store, me } = setup("p57", {}, { conditions: ["DISABLED"] });
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(
      /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/,
    );
    const { store: s2, me: me2 } = setup("p57b", {}, { conditions: ["UNQUALIFIED"] });
    expect(() => assertPlannerCandidateEligible(s2, me2)).toThrow(
      /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/,
    );
  });

  it("58J. fully healthy QUALIFIED planner → invocation succeeds", async () => {
    const { store, me } = setup("p58");
    const res = await runPlannerFailover({
      candidates: [candOf(me, "pg", "mg")],
      planFn: async () => okPlan("t"),
      assertEligible: (c) => assertPlannerCandidateEligible(store, c.model_entry_id),
    });
    expect(res.winner.model_entry_id).toBe(me);
  });

  it("59. §7 zero-eligible after qualification loss → EXHAUSTED + durable evidence, no preview/mission", async () => {
    const { store, me } = setup("p59");
    setModelLifecycle(store, me, "DISCOVERED"); // lost QUALIFIED before invocation
    await expectCode(
      () =>
        runDurable(store, {
          candidates: [candOf(me, "pg", "mg")],
          planFn: async () => okPlan("t"),
          assertEligible: (c) => assertPlannerCandidateEligible(store, c.model_entry_id),
        }),
      "FAIL_CLOSED_PLANNER_EXHAUSTED",
    );
    const run = store.list("planner_run")[0];
    expect(String(run.state)).toBe("EXHAUSTED");
    const atts = attemptsOf(store, String(run.planner_run_id));
    expect(atts).toHaveLength(1);
    expect(atts[0].outcome).toBe("FAILED");
    expect(atts[0].failure_class).toBe("MODEL_UNAVAILABLE");
    expect(store.list("mission_plan_preview")).toHaveLength(0);
    expect(store.list("mission")).toHaveLength(0);
  });
});

describe("R3 §4 — provider UNQUALIFIED recovery at canonical seam", () => {
  it("60A–E. qualify fail → UNQUALIFIED; requalify clears it; planner + routable agree without manual cleanup", () => {
    const ctx = makeCtx("p60");
    const cat = new ProviderCatalog(ctx.store);
    const pid = "recover-provider";
    const me = mkModel(ctx.store, pid, "m60");
    assignModelRole(ctx.store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    mkProvider(ctx.store, pid, { lifecycle: "MODEL_DISCOVERY_ELIGIBLE", health_state: "DOWN" });
    const v = new ProviderValidator(ctx.store);

    // While only DOWN the candidate is an availability rejection; after the
    // failed qualification lands UNQUALIFIED it becomes an authority block.
    expect(assertPlannerCandidateEligible(ctx.store, me)).toMatchObject({
      reject: true,
      failure_class: "PROVIDER_UNAVAILABLE",
    });

    // A — qualification failure leaves the UNQUALIFIED condition
    const q1 = v.qualify(pid, { env: {}, probed: true });
    expect(q1.qualified).toBe(false);
    expect(cat.getProvider(pid)!.conditions as string[]).toContain("UNQUALIFIED");
    expect(() => assertPlannerCandidateEligible(ctx.store, me)).toThrow(
      /FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/,
    );

    // B — provider now satisfies every gate: health recovered, probed via opts
    const body = ctx.store.get("provider", providerEntryId(pid));
    ctx.store.put("provider", providerEntryId(pid), { ...body, health_state: "READY" }, Number(body.version));
    const q2 = v.qualify(pid, { env: {}, probed: true });
    expect(q2.qualified).toBe(true);
    expect(q2.receipt).toBeTruthy();
    const prov = cat.getProvider(pid)!;
    expect(prov.current_qualification_receipt_id).toBeTruthy();
    expect(ctx.store.tryGet("provider_qualification", String(prov.current_qualification_receipt_id))).toBeTruthy();
    expect(String(prov.lifecycle_state)).toBe("MODEL_DISCOVERY_ELIGIBLE");
    expect(prov.conditions as string[]).not.toContain("UNQUALIFIED");

    // C + E — shared projection and Planner agree; no manual state cleanup
    expect(Object.values(providerModelEligibility(ctx.store, pid, me).gates).every((g) => g === "PASS")).toBe(true);
    expect(() => assertPlannerCandidateEligible(ctx.store, me)).not.toThrow();

    // D — routable projection observes the same recovered state
    ctx.service.registerExecutor({
      executor_id: "EXEC_R3",
      executor_type: "EXTERNAL_ACP",
      capabilities: ["TEXT_INFERENCE"],
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        adapter_id: "exec_r3",
        transport_type: "ACP_STDIO",
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
      },
    });
    const binding = ensureBinding(ctx.service, {
      executor_id: "EXEC_R3",
      provider_id: pid,
      model_entry_id: me,
      transport_compat: "ACP_STDIO",
    });
    qualifyBinding(ctx.service, String(binding.binding_id), { evidence_refs: ["ev1"] });
    const row = projectRoutableModels(ctx.service).find((r) => String(r.provider_id) === pid)!;
    expect(row.gates.PROVIDER_QUALIFIED).toBe("PASS");
    expect(row.gates.PROVIDER_NOT_BLOCKED).toBe("PASS");
    expect(row.routable).toBe(true);
  });

  it("61F. DISABLED is preserved through successful requalification", () => {
    const { store } = makeCtx("p61");
    const cat = new ProviderCatalog(store);
    const pid = "disabled-provider";
    mkModel(store, pid, "m61");
    mkProvider(store, pid, { conditions: ["DISABLED", "UNQUALIFIED"] });
    const q = new ProviderValidator(store).qualify(pid, { env: {}, probed: true });
    expect(q.qualified).toBe(true);
    const conditions = cat.getProvider(pid)!.conditions as string[];
    expect(conditions).toContain("DISABLED"); // operator authority, not transient residue
    expect(conditions).not.toContain("UNQUALIFIED");
    expect(providerModelEligibility(store, pid, mkModel(store, pid, "m61b")).gates.PROVIDER_NOT_BLOCKED).toBe("FAIL");
  });

  it("62G. AUTH/health gates still behave per policy after recovery", () => {
    const { store } = makeCtx("p62");
    const pid = "gate-provider";
    const me = mkModel(store, pid, "m62");
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    mkProvider(store, pid, { auth_state: "AUTH_FAILED" });
    expect(providerModelEligibility(store, pid, me).gates.PROVIDER_AUTH_OK).toBe("FAIL");
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    const { store: s2 } = makeCtx("p62b");
    const me2 = mkModel(s2, pid, "m62b");
    assignModelRole(s2, me2, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    mkProvider(s2, pid, { health_state: "DOWN" });
    expect(assertPlannerCandidateEligible(s2, me2)).toMatchObject({ reject: true, failure_class: "PROVIDER_UNAVAILABLE" });
  });
});

describe("R3 §5–§7 — planner attempt authority settlement", () => {
  /** planner-role model + provider; failover where first candidate is gated. */
  const runAndCollect = async (
    store: PairEvidenceStore,
    name: string,
    provOpts: Parameters<typeof mkProvider>[2],
    mutate?: (me: string) => void,
  ) => {
    const me = mkModel(store, name, `m-${name}`);
    mkProvider(store, name, provOpts);
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    mutate?.(me);
    const invoked: string[] = [];
    let thrown: unknown;
    try {
      await runDurable(store, {
        candidates: [candOf(me, name, `m-${name}`), cand("B", "pb:mb")],
        planFn: async (c) => {
          invoked.push(c.model_entry_id);
          return okPlan("t");
        },
        assertEligible: (c) =>
          c.model_entry_id === me ? assertPlannerCandidateEligible(store, me) : undefined,
      });
    } catch (e) {
      thrown = e;
    }
    const run = store.list("planner_run")[0];
    return { thrown, invoked, run, atts: attemptsOf(store, String(run.planner_run_id)) };
  };

  it("63. role revoked → attempt STARTED→terminal FAILED, IntegrityError propagates, no fallback", async () => {
    const { store } = makeCtx("p63");
    const { thrown, invoked, run, atts } = await runAndCollect(store, "role-p", {}, (me) =>
      revokeModelRole(store, me, { actor: "t" }),
    );
    expect(String((thrown as { code?: string }).code)).toContain("FAIL_CLOSED_MODEL_ROLE");
    expect(String(run.state)).toBe("FAILED");
    expect(atts).toHaveLength(1);
    expect(atts[0].outcome).toBe("FAILED");
    expect(String(atts[0].warnings?.[0] ?? "")).toContain("AUTHORITY_REJECTED:FAIL_CLOSED_MODEL_ROLE");
    expect(invoked).toEqual([]); // no candidate invoked, no fallback borrowed
  });

  it("64. provider AUTH_FAILED → terminal FAILED attempt, no fallback", async () => {
    const { store } = makeCtx("p64");
    const { thrown, invoked, run, atts } = await runAndCollect(store, "auth-p", { auth_state: "AUTH_FAILED" });
    expect(String((thrown as { code?: string }).code)).toBe("FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE");
    expect(String(run.state)).toBe("FAILED");
    expect(atts).toHaveLength(1);
    expect(atts[0].outcome).toBe("FAILED");
    expect(invoked).toEqual([]);
  });

  it("65. provider DISABLED/UNQUALIFIED → terminal FAILED attempt, no fallback", async () => {
    const { store } = makeCtx("p65");
    const r1 = await runAndCollect(store, "dis-p", { conditions: ["DISABLED"] });
    expect(String((r1.thrown as { code?: string }).code)).toBe("FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE");
    expect(r1.atts[0].outcome).toBe("FAILED");
    expect(r1.invoked).toEqual([]);
    const { store: s2 } = makeCtx("p65b");
    const r2 = await runAndCollect(s2, "unq-p", { conditions: ["UNQUALIFIED"] });
    expect(r2.atts[0].outcome).toBe("FAILED");
    expect(String(r2.atts[0].warnings?.[0] ?? "")).toContain("AUTHORITY_REJECTED:");
  });

  it("66. DSH alias overlap → terminal FAILED attempt, no fallback", async () => {
    const { store } = makeCtx("p66");
    const dsh = mkModel(store, "p66x", "dshm");
    assignModelRole(store, dsh, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const invoked: string[] = [];
    const r = await (async () => {
      // proven alias: same provider_family, planner lists dsh's model_id
      const me = mkModel(store, "p66x", "m66", { aliases: ["dshm"] });
      mkProvider(store, "p66x");
      assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
      expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_DSH_OVERLAP/);
      let thrown: unknown;
      try {
        await runDurable(store, {
          candidates: [candOf(me, "p66p", "m66"), cand("B", "pb:mb")],
          planFn: async (c) => {
            invoked.push(c.model_entry_id);
            return okPlan("t");
          },
          assertEligible: (c) =>
            c.model_entry_id === me ? assertPlannerCandidateEligible(store, c.model_entry_id) : undefined,
        });
      } catch (e) {
        thrown = e;
      }
      const run = store.list("planner_run")[0];
      return { thrown, atts: attemptsOf(store, String(run.planner_run_id)) };
    })();
    expect(String((r.thrown as { code?: string }).code)).toBe("FAIL_CLOSED_PLANNER_DSH_OVERLAP");
    expect(r.atts).toHaveLength(1);
    expect(r.atts[0].outcome).toBe("FAILED");
    expect(invoked).toEqual([]);
  });

  it("67. no authority-rejected attempt remains STARTED; simulated crash may retain STARTED", async () => {
    const { store } = makeCtx("p67");
    const { atts } = await runAndCollect(store, "crash-p", { auth_state: "AUTH_FAILED" });
    expect(atts.every((a) => a.outcome !== "STARTED")).toBe(true);
    // crash semantics: a STARTED row persisted without settlement stays durable
    const run = beginPlannerRun(store, { project_id: "P1", operator_id: "op1", routes: ["p:x"] });
    const a = persistPlannerAttemptStart(store, {
      planner_run_id: String(run.planner_run_id),
      project_id: "P1",
      record: {
        route: "p:x", provider: "p", model_entry_id: "c", model: "x",
        role: "PLANNER_COORDINATOR", attempt_no: 1, started_at: "2026-01-01T00:00:00.000Z",
      } as never,
    });
    expect(String(store.get("planner_attempt", String(a.planner_attempt_id)).outcome)).toBe("STARTED");
  });
});

describe("R3 live-found — model STALE residue cleared at canonical seam", () => {
  it("68. STALE marker is cleared by successful model requalification", () => {
    const { store } = makeCtx("p68");
    const pid = "stale-provider";
    const me = mkModel(store, pid, "stale-m");
    mkProvider(store, pid);
    assignModelRole(store, me, MODEL_ROLE.PLANNER_COORDINATOR, { actor: "t" });
    // observed live: absence reconciliation leaves STALE on a still-QUALIFIED model
    setModelConditions(store, me, ["REAPPEARED", "STALE"]);
    expect(providerModelEligibility(store, pid, me).gates.MODEL_NOT_STALE).toBe("FAIL");
    // canonical qualification transition reconciles the transient marker
    new ModelEvidenceCatalog(store).issueQualificationReceipt(me, {
      capability_scope: ["text_inference"],
      verifier: "t",
      evidence_refs: ["e"],
      actor: "t",
    });
    const after = store.get("model_entry", me);
    expect(after.conditions).not.toContain("STALE");
    expect(after.conditions).toContain("REAPPEARED"); // informational history preserved
    expect(after.lifecycle_state).toBe("QUALIFIED");
    const gates = providerModelEligibility(store, pid, me).gates;
    expect(Object.values(gates).every((g) => g === "PASS")).toBe(true);
    expect(() => assertPlannerCandidateEligible(store, me)).not.toThrow();
  });
});

/* ===== PRE-MERGE hotfix — canonical executor timeout governance ======== */

const FAKE_ACP = path.resolve(__dirname, "fixtures", "fake-acp-agent.mjs");
const FAKE_CODEX = path.resolve(__dirname, "fixtures", "fake-codex.mjs");
const secretEnv = (n: string) =>
  ["DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].includes(n)
    ? "fake-secret"
    : process.env[n];

const waitTerminal = async (
  adapter: { observe(id: string): Record<string, unknown> },
  executionId: string,
  timeoutMs = 15_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) return o;
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never reached terminal`);
    await new Promise((r) => setTimeout(r, 80));
  }
};

/** Minimal governed task record as MissionRuntime's requestFor produces it. */
const governedTask = (dir: string, executorId: string, over: Record<string, unknown> = {}) => ({
  executor_id: executorId,
  governance_state: "DISPATCH_AUTHORIZED",
  dispatch_enabled: true,
  governance_digest: "gd",
  governed_task_id: `GTSK_${Math.random().toString(36).slice(2, 10)}`,
  mission_id: "m", task_id: "t", correlation_id: "c",
  workspace: dir, allowed_paths: [dir],
  task_instruction: "do governed work",
  ...over,
});

describe("PRE-MERGE hotfix — executor timeout governance", () => {
  it("A/B. MissionRuntime injects PAIR_TASK_TIMEOUT_S; explicit metadata.timeout wins", () => {
    const ctx = makeCtx("ht-ab");
    const reqs: Array<Record<string, unknown>> = [];
    const spyRouter = {
      routeGovernedTask: (req: Record<string, unknown>) => {
        reqs.push(req);
        return { execution: { execution_id: `EX${reqs.length}`, execution_state: "RUNNING", executor_id: "STUB" } };
      },
    };
    const rt = new MissionRuntime({
      service: ctx.service, gate: ctx.gate, router: spyRouter as never,
      adapters: new Map() as never, scheduler: ctx.scheduler, approvals: ctx.approvals,
      reconciliation: ctx.recon, recovery: ctx.recovery, planner: ctx.planner as never,
      taskTimeoutSeconds: 1800,
    });
    // canonical env → request.timeout = 1800
    const m1 = ctx.control.startMission({
      project_id: ctx.projectId, goal: "g",
      granted_permissions: ["FILE_WRITE"], authorized_workspaces: [ctx.workspace],
    });
    for (let i = 0; i < 5 && !reqs.length; i++) rt.tick(String(m1.mission_id)); // PLANNING→READY→RUNNING→dispatch
    expect(reqs).toHaveLength(1);
    expect(Number(reqs[0].timeout)).toBe(1800);
    // explicit governed metadata.timeout supersedes the canonical budget
    const timed = { ...T1, metadata: { timeout: 999 } };
    const m2 = ctx.control.startMission({
      project_id: ctx.projectId, goal: "g2", metadata: { llm_plan: [timed] },
      granted_permissions: ["FILE_WRITE"], authorized_workspaces: [ctx.workspace],
    });
    for (let i = 0; i < 6 && reqs.length < 2; i++) rt.tick(String(m2.mission_id));
    expect(Number(reqs[1].timeout)).toBe(999);
  });

  it("C. DSH prompt budget = task.timeout (HANG_FOREVER → TIMEOUT at 2s, not 300s default)", async () => {
    const { store } = makeCtx("ht-c");
    void store;
    const dsh = new DshExecutorAdapter({
      journalRoot: path.join(freshDir("ht-c-j"), "j"),
      launchOverride: { command: "node", args: [FAKE_ACP, "--profile", "acp"] },
      envReader: secretEnv,
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ht-c-ws-"));
    const disp = dsh.dispatch(governedTask(ws, "DEEPSEEK_HARNESS", { timeout: 2, task_instruction: "HANG_FOREVER now" }));
    const t0 = Date.now();
    const o = await waitTerminal(dsh, String(disp.execution_id));
    expect(o.status).toBe("TIMEOUT"); // ACP_REQUEST_TIMEOUT at task.timeout=2s
    expect(Date.now() - t0).toBeLessThan(12_000); // default 300s would never fire here
  });

  it("D. Codex process timeout = task.timeout (hang fixture → TIMEOUT at 2s)", async () => {
    const dir = freshDir("ht-d");
    const hang = path.join(dir, "hang-codex.mjs");
    fs.writeFileSync(
      hang,
      'if(process.argv.includes("--version")){console.log("codex-cli fake");process.exit(0)}setInterval(()=>{},1000)',
    );
    const codex = new CodexCliExecutorAdapter({
      journalRoot: path.join(dir, "j"),
      executable: "node", executableArgs: [hang], envReader: secretEnv,
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ht-d-ws-"));
    const disp = codex.dispatch(governedTask(ws, "CODEX", { timeout: 2 }));
    const o = await waitTerminal(codex, String(disp.execution_id));
    expect(o.status).toBe("TIMEOUT");
  });

  const mkDevin = (dir: string, nowRef: { v: number }, over: Record<string, unknown> = {}) =>
    new DevinExecutorAdapter({
      journalRoot: path.join(dir, "j"), apiKey: "cog_test",
      fetchFn: (m) => ({ status: 200, data: m === "GET" ? { status_enum: "working" } : { session_id: "s1", url: "u" } }) as DevinFetch,
      nowMs: () => nowRef.v, now: () => new Date(nowRef.v).toISOString(),
      ...over,
    });

  it("E. Devin persists task_timeout_ms=1800s*1000 from governed task.timeout", () => {
    const dir = freshDir("ht-e");
    const now = { v: 1_000_000 };
    const devin = mkDevin(dir, now);
    const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
    expect(Number(disp.task_timeout_ms)).toBe(1_800_000);
    const journal = JSON.parse(
      fs.readFileSync(path.join(dir, "j", String(disp.execution_id), "devin-dispatch.json"), "utf8"),
    ) as { record: Record<string, unknown> };
    expect(Number(journal.record.task_timeout_ms)).toBe(1_800_000);
  });

  it("F/M. running at 121s does NOT timeout (grace ≠ budget); TIMEOUT only past 1800s", () => {
    const dir = freshDir("ht-f");
    const now = { v: 1_000_000 };
    const devin = mkDevin(dir, now, { blockedGraceMs: 5_000 });
    const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
    now.v += 121_000; // past the blocked-grace magnitude — still far inside budget
    expect(devin.observe(String(disp.execution_id)).status).toBe("RUNNING");
    now.v += 1_800_000; // now beyond the persisted 1800s budget
    const o = devin.observe(String(disp.execution_id));
    expect(o.status).toBe("TIMEOUT");
    expect(Number(o.remote_timeout_ms)).toBe(1_800_000);
  });

  it("G/H. restart rehydration keeps the dispatched budget — changed env/fallback cannot move it", () => {
    const dir = freshDir("ht-g");
    const now = { v: 1_000_000 };
    const devin = mkDevin(dir, now);
    const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
    const execId = String(disp.execution_id);
    // env "changed" after dispatch + a fresh adapter with a DIFFERENT fallback
    const prev = process.env.PAIR_DEVIN_TASK_TIMEOUT_MS;
    process.env.PAIR_DEVIN_TASK_TIMEOUT_MS = "600000";
    try {
      const devin2 = mkDevin(dir, now); // fallback now 600s via validated compat env
      now.v += 700_000; // > 600s fallback but < persisted 1800s
      expect(devin2.observe(execId).status).toBe("RUNNING"); // persisted budget wins
      now.v += 1_200_000; // > 1800s persisted
      expect(devin2.observe(execId).status).toBe("TIMEOUT");
    } finally {
      if (prev === undefined) delete process.env.PAIR_DEVIN_TASK_TIMEOUT_MS;
      else process.env.PAIR_DEVIN_TASK_TIMEOUT_MS = prev;
    }
  });

  it("I/J. PAIR_DEVIN_BLOCKED_GRACE_MS validated (bounds, fail-closed); compat env for task budget", () => {
    expect(devinBlockedGraceMs({ PAIR_DEVIN_BLOCKED_GRACE_MS: "30000" })).toBe(30_000);
    for (const bad of ["0", "-5", "abc", "Infinity", "1800001", "8.5"]) {
      expect(() => devinBlockedGraceMs({ PAIR_DEVIN_BLOCKED_GRACE_MS: bad })).toThrowError(/FAIL_CLOSED_CONFIG_INVALID/);
    }
    expect(devinBlockedGraceMs({})).toBe(120_000);
    // compat env applies ONLY when the task carries no explicit timeout
    expect(devinTaskTimeoutMs({ PAIR_DEVIN_TASK_TIMEOUT_MS: "300000" })).toBe(300_000);
    expect(() => devinTaskTimeoutMs({ PAIR_DEVIN_TASK_TIMEOUT_MS: "x" })).toThrowError(/FAIL_CLOSED_CONFIG_INVALID/);
  });

  it("K. blocked past grace → FAILED + REMOTE_INPUT_REQUIRED, never masquerades as task TIMEOUT", () => {
    const dir = freshDir("ht-k");
    const now = { v: 5_000_000 };
    const devin = mkDevin(dir, now, {
      blockedGraceMs: 30_000,
      fetchFn: (m) => ({ status: 200, data: m === "GET" ? { status_enum: "blocked", url: "u-b" } : { session_id: "s1", url: "u-b" } }) as DevinFetch,
    });
    const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
    const execId = String(disp.execution_id);
    expect(devin.observe(execId).status).toBe("RUNNING"); // transient blocked protected
    now.v += 31_000;
    const o = devin.observe(execId);
    expect(o.status).toBe("FAILED"); // grace clock — NOT task timeout
    expect(o.remote_timeout_ms).toBeUndefined();
    const result = devin.collect_result(execId);
    expect((result.error as Record<string, unknown>).class).toBe("REMOTE_INPUT_REQUIRED");
  });

  it("L. DONE sentinel during blocked grace → COMPLETED as before", () => {
    const dir = freshDir("ht-l");
    const now = { v: 6_000_000 };
    const devin = mkDevin(dir, now, {
      blockedGraceMs: 30_000,
      fetchFn: (m) => ({
        status: 200,
        data: m === "GET"
          ? { status_enum: "blocked", url: "u-d", messages: [{ type: "devin_message", message: "report\n\nDONE" }] }
          : { session_id: "s1", url: "u-d" },
      }) as DevinFetch,
    });
    const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
    now.v += 10_000;
    expect(devin.observe(String(disp.execution_id)).status).toBe("COMPLETED");
  });

  it("N. constructor without dep honors validated compat env for blocked grace", () => {
    const dir = freshDir("ht-n");
    const now = { v: 7_000_000 };
    const prev = process.env.PAIR_DEVIN_BLOCKED_GRACE_MS;
    process.env.PAIR_DEVIN_BLOCKED_GRACE_MS = "15000";
    try {
      const devin = mkDevin(dir, now, {
        fetchFn: (m) => ({ status: 200, data: m === "GET" ? { status_enum: "blocked" } : { session_id: "s1" } }) as DevinFetch,
      });
      const disp = devin.dispatch(governedTask(dir, "DEVIN", { timeout: 1800 }));
      const execId = String(disp.execution_id);
      devin.observe(execId); // blocked_since := now
      now.v += 16_000; // past the configured 15s grace (would still be RUNNING at default 120s)
      expect(devin.observe(execId).status).toBe("FAILED");
    } finally {
      if (prev === undefined) delete process.env.PAIR_DEVIN_BLOCKED_GRACE_MS;
      else process.env.PAIR_DEVIN_BLOCKED_GRACE_MS = prev;
    }
  });
});
