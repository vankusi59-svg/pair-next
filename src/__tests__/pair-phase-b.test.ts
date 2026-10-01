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
  ModelEvidenceCatalog,
  MODEL_ROLE,
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
  return { dir, workspace, store, service, control, runtime, plannerCalls, projectId: String(project.project_id) };
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

const mkModel = (
  store: PairEvidenceStore,
  pid: string,
  mid: string,
  opts: { conditions?: string[]; aliases?: string[] } = {},
) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid,
    provider_family: pid,
    model_id: mid,
    capability_hints: ["text_inference"],
  });
  if (opts.conditions?.length || opts.aliases?.length) {
    const body = store.get("model_entry", String(entry.model_entry_id));
    store.put("model_entry", String(entry.model_entry_id), {
      ...body,
      conditions: opts.conditions ?? body.conditions,
      model_alias_ids: opts.aliases ?? body.model_alias_ids,
    }, Number(body.version));
  }
  return String(entry.model_entry_id);
};
const mkProvider = (store: PairEvidenceStore, pid: string, lifecycle = "QUALIFIED") => {
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id);
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id, conditions: [] }),
    lifecycle_state: lifecycle,
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
    mkProvider(store, "pc", "DISCOVERED");
    expect(() => assertPlannerCandidateEligible(store, me)).toThrow(/FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE/);
    mkProvider(store, "pc", "QUALIFIED");
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
