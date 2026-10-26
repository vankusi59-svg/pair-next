/**
 * P7 VERIFIED EXPERIENCE + ADAPTIVE PLANNING/ROUTING tests.
 *
 * 32 required deterministic proofs + controlled adaptive-selection test +
 * feedback loop + replay + rollback. Experience is ADVISORY ONLY: it runs
 * after hard gates and can never create eligibility.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  CapabilityRouter,
  ExperienceExtractor,
  ExperienceService,
  ExperienceVerifier,
  IntegrityError,
  PairControlPlane,
  PairEvidenceStore,
  VerifiedExperiencePlannerAdvisor,
  VerifiedExperienceRoutingAdvisor,
  digest,
  experienceDigest,
  normalizeErrorSignature,
  utcnow,
  validatePlanProposal,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p7-");
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const ENV = { os: "linux", arch: "x64", node: "v22", policy_version: "v1" };

function makeCtx(name: string) {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const experience = new ExperienceService(service);
  const extractor = new ExperienceExtractor(service, experience);
  const verifier = new ExperienceVerifier(service, experience);
  const router = new CapabilityRouter(service);
  const routingAdvisor = new VerifiedExperienceRoutingAdvisor(service, experience);
  const plannerAdvisor = new VerifiedExperiencePlannerAdvisor(service, experience);
  return { dir, store, service, experience, extractor, verifier, router, routingAdvisor, plannerAdvisor };
}

function registerExecutor(
  ctx: ReturnType<typeof makeCtx>,
  executorId: string,
  opts: { health?: string; qualified?: string; status?: string; priority?: number; caps?: string[] } = {},
) {
  ctx.service.registerExecutor({
    executor_id: executorId,
    executor_type: "EXTERNAL_ACP",
    capabilities: opts.caps ?? ["TEXT_INFERENCE"],
    health_state: opts.health ?? "READY",
    status: opts.status ?? "ENABLED",
    metadata: {
      routing_priority: opts.priority ?? 50,
      transport_type: "ACP_STDIO",
      qualification_state: opts.qualified ?? "QUALIFIED",
      permission_modes: ["READ", "WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
    },
  });
}

function seedTask(ctx: ReturnType<typeof makeCtx>, caps = ["TEXT_INFERENCE"]) {
  const project = ctx.service.createProject({ name: "p", root_location: ctx.dir });
  const mission = ctx.service.createMission({ project_id: String(project.project_id), goal: "g" });
  const plan = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: [{ task_key: "T1", title: "t", required_capabilities: caps }],
    source: "test",
    proposal: { tasks: [] },
  });
  return { mission, task: ctx.service.getTask(plan.task_ids[0]) };
}

function seedExecution(
  ctx: ReturnType<typeof makeCtx>,
  executorId: string,
  opts: { status?: string; caps?: string[]; error?: string; route?: boolean } = {},
) {
  const { mission, task } = seedTask(ctx, opts.caps ?? ["TEXT_INFERENCE"]);
  let routeDecisionId: string | undefined;
  if (opts.route) {
    routeDecisionId = `RDEC_${digest({ r: Math.random() }).slice(0, 10)}`;
    ctx.store.put("route_decision", routeDecisionId, {
      decision_id: routeDecisionId,
      selected_executor: executorId,
      capability: (opts.caps ?? ["TEXT_INFERENCE"])[0],
      version: 0,
    }, 0);
  }
  const executionId = `EXEC_${digest({ e: Math.random() }).slice(0, 10)}`;
  ctx.store.put("executor_execution", executionId, {
    execution_id: executionId,
    executor_id: executorId,
    mission_id: mission.mission_id,
    task_id: task.task_id,
    execution_state: opts.status ?? "COMPLETED",
    result_state: opts.status ?? "COMPLETED",
    result: opts.status === "FAILED" ? { status: "FAILED", error: { class: opts.error ?? "ERR" } } : { status: opts.status ?? "COMPLETED" },
    route_decision_id: routeDecisionId,
    dispatch_timestamp: utcnow(),
    version: 0,
  }, 0);
  return { executionId, mission, task, routeDecisionId };
}

const V = "EXPERIENCE_VERIFIER_V1"; // deterministic verifier identity

function promoteActive(ctx: ReturnType<typeof makeCtx>, expId: string) {
  ctx.verifier.verifyAndQualify(expId, V);
  return ctx.verifier.verifyAndActivate(expId, V);
}

describe("P7 — extraction & pipeline (tests 1–5)", () => {
  it("1. Layer-B evidence creates CANDIDATE, not ACTIVE", () => {
    const ctx = makeCtx("t1");
    registerExecutor(ctx, "PAIR_NATIVE");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exps = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV });
    expect(exps.length).toBeGreaterThanOrEqual(1);
    expect(String(exps[0].status)).toBe("CANDIDATE");
    expect(exps[0].observation_count).toBe(1);
  });

  it("2. model-generated memory cannot create ACTIVE experience (auto-quarantined)", () => {
    const ctx = makeCtx("t2");
    registerExecutor(ctx, "PAIR_NATIVE");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exp = ctx.experience.createCandidate({
      type: "EXECUTOR_OBSERVATION",
      source_evidence_refs: [`executor_execution:${executionId}`],
      provenance: "model_summary",
      evidence_origin: "MODEL_GENERATED",
      compatibility_scope: { executors: ["PAIR_NATIVE"] },
      outcome: "SUCCESS",
    });
    expect(String(exp.status)).toBe("QUARANTINED");
    expect(String(exp.quarantine_reason)).toBe("UNVERIFIED_MODEL_OUTPUT");
    const events = ctx.store.listEvents("experience", String(exp.experience_id));
    expect(events.map((e) => e.event_type)).toContain("EXPERIENCE_QUARANTINED");
  });

  it("3. experience with missing evidence ref rejected", () => {
    const ctx = makeCtx("t3");
    expect(() =>
      ctx.experience.createCandidate({
        type: "EXECUTOR_OBSERVATION",
        source_evidence_refs: ["executor_execution:MISSING"],
        provenance: "x",
        compatibility_scope: { executors: ["PAIR_NATIVE"] },
      }),
    ).toThrow(/FAIL_CLOSED_EXPERIENCE_UNRESOLVED_REF/);
  });

  it("4. tampered evidence cannot qualify experience", () => {
    const ctx = makeCtx("t4");
    registerExecutor(ctx, "PAIR_NATIVE");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    // Tamper the evidence row directly in SQL (bypasses hash on write).
    const row = ctx.store.db
      .prepare("SELECT payload FROM entities WHERE entity_type='executor_execution' AND entity_id=?")
      .get(executionId) as { payload: string };
    ctx.store.db
      .prepare("UPDATE entities SET payload=? WHERE entity_type='executor_execution' AND entity_id=?")
      .run(row.payload.replace("COMPLETED", "CORRUPTED"), executionId);
    const res = ctx.verifier.verify(String(exp.experience_id), { verifier_id: V, target: "QUALIFIED" });
    expect(res.pass).toBe(false);
    expect(res.checks.find((c) => c.check === "EVIDENCE_REFS_RESOLVE")!.detail).toContain("TAMPERED");
  });

  it("5. permission_effect != NONE rejected", () => {
    const ctx = makeCtx("t5");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    expect(() =>
      ctx.experience.createCandidate({
        type: "EXECUTOR_OBSERVATION",
        source_evidence_refs: [`executor_execution:${executionId}`],
        provenance: "x",
        permission_effect: "GRANT_WRITE",
      }),
    ).toThrow(/FAIL_CLOSED_EXPERIENCE_PERMISSION_EFFECT/);
  });
});

describe("P7 — candidate isolation & hard gates (tests 6–15)", () => {
  it("6. candidate cannot influence planner advice", () => {
    const ctx = makeCtx("t6");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const receipt = ctx.plannerAdvisor.advise({ goal: "anything", environment: ENV });
    expect((receipt.counts as Record<string, number>).executor_observations).toBe(0);
  });

  it("7. candidate cannot influence routing", () => {
    const ctx = makeCtx("t7");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 90 });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV }); // CANDIDATE
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(decision.selected_executor)).toBe("A_LOW");
    const receipt = ctx.store.get("advisor_decision", String(decision.advisor_decision_id));
    expect((receipt.experience_ids_applied as string[]).length).toBe(0);
  });

  it("8. quarantined experience cannot influence routing", () => {
    const ctx = makeCtx("t8");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 90 });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    ctx.experience.quarantine(String(exp.experience_id), "under review");
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(decision.selected_executor)).toBe("A_LOW");
  });

  it("9. ACTIVE compatible experience may adjust eligible route score", () => {
    const ctx = makeCtx("t9");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const e1 = seedExecution(ctx, "B_HIGH");
    const e2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(e1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(e2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect((receipt.experience_adjustments as Record<string, number>).B_HIGH).toBeGreaterThan(0);
    expect(String(receipt.selected)).toBe("B_HIGH");
  });

  it("10. experience cannot make ineligible (disabled) executor eligible", () => {
    const ctx = makeCtx("t10");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30, status: "DISABLED" });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(decision.selected_executor)).toBe("A_LOW");
    expect((decision.rejected_executors as Array<Record<string, unknown>>)
      .find((r) => r.executor_id === "B_HIGH")).toBeTruthy();
  });

  it("11. experience cannot make unqualified provider eligible", () => {
    const ctx = makeCtx("t11");
    // Provider entity exists but lifecycle REVOKED — positive provider
    // observation must fail verification.
    ctx.store.put("provider", "PRV_dead", {
      provider_id: "dead", entry_id: "PRV_dead", lifecycle_state: "REVOKED",
      version: 0,
    }, 0);
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exp = ctx.experience.createCandidate({
      type: "PROVIDER_MODEL_OBSERVATION",
      source_evidence_refs: [`executor_execution:${executionId}`],
      provenance: "x",
      evidence_origin: "REAL_EXECUTION",
      compatibility_scope: { provider: "PRV_dead" },
      outcome: "SUCCESS",
    });
    const res = ctx.verifier.verify(String(exp.experience_id), { verifier_id: V, target: "QUALIFIED" });
    expect(res.pass).toBe(false);
    expect(res.checks.find((c) => c.check === "PROVIDER_QUALIFIED_NOT_REVOKED")!.pass).toBe(false);
  });

  it("12. experience cannot make unqualified/removed model routable", () => {
    const ctx = makeCtx("t12");
    ctx.store.put("model_entry", "ME_dead", {
      model_entry_id: "ME_dead", model_id: "dead-model", lifecycle_state: "REMOVED", version: 0,
    }, 0);
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exp = ctx.experience.createCandidate({
      type: "PROVIDER_MODEL_OBSERVATION",
      source_evidence_refs: [`executor_execution:${executionId}`],
      provenance: "x",
      evidence_origin: "REAL_EXECUTION",
      compatibility_scope: { model: "dead-model" },
      outcome: "SUCCESS",
    });
    const res = ctx.verifier.verify(String(exp.experience_id), { verifier_id: V, target: "QUALIFIED" });
    expect(res.pass).toBe(false);
    expect(res.checks.find((c) => c.check === "MODEL_QUALIFIED_NOT_REMOVED")!.pass).toBe(false);
  });

  it("13. experience cannot bypass permission denial", () => {
    const ctx = makeCtx("t13");
    registerExecutor(ctx, "B_HIGH", { priority: 10 });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, {
      routingAdvisor: ctx.routingAdvisor,
      requiredPermissions: new Set(["NETWORK_EGRESS"]),
      environment: ENV,
    });
    expect(decision.selected_executor).toBeNull();
    expect(String((decision.rejected_executors as Array<Record<string, unknown>>)[0].reasons)).toContain("PERMISSION_INCOMPATIBLE");
  });

  it("14. experience cannot bypass workspace denial", () => {
    const ctx = makeCtx("t14");
    registerExecutor(ctx, "NOWS", { priority: 10 });
    // strip workspace mode → hard reject despite ACTIVE experience
    const rec = ctx.store.get("executor", "NOWS");
    (rec.metadata as Record<string, unknown>).workspace_modes = ["IN_PROCESS_ONLY"];
    ctx.store.put("executor", "NOWS", rec, Number(rec.version));
    const { executionId } = seedExecution(ctx, "NOWS");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    ctx.experience.qualify(String(exp.experience_id), { verifier_id: V, verifier_result: { pass: true } });
    // qualify works (evidence exists); ACTIVE adds subject-quality check
    const act = ctx.verifier.verify(String(exp.experience_id), { verifier_id: V, target: "ACTIVE" });
    expect(act.pass).toBe(true); // workspace is NOT a verification input
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(decision.selected_executor).toBeNull();
    expect(String((decision.rejected_executors as Array<Record<string, unknown>>)[0].reasons)).toContain("WORKSPACE_INCOMPATIBLE");
  });

  it("15. experience cannot bypass approval requirement", () => {
    const ctx = makeCtx("t15");
    // Advisor output cannot disable or satisfy approvals — receipts carry no
    // approval field and mission risk ceilings are untouched.
    registerExecutor(ctx, "B_HIGH", { priority: 10 });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(decision.selected_executor)).toBe("B_HIGH");
    // receipt exists, decision digests verify, and no approval was minted
    const receipt = ctx.store.get("advisor_decision", String(decision.advisor_decision_id));
    expect(ctx.routingAdvisor.verifyReceipt(receipt)).toBe(true);
    expect(ctx.store.list("approval").length).toBe(0);
  });
});

describe("P7 — cold start / staleness / lifecycle (tests 16–22)", () => {
  it("16. cold-start routing identical to P6 baseline", () => {
    const ctx = makeCtx("t16");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const { task } = seedTask(ctx);
    const withAdvisor = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    const baseline = ctx.router.route(task, { environment: ENV });
    expect(String(withAdvisor.selected_executor)).toBe(String(baseline.selected_executor));
    expect(withAdvisor.eligible_executors).toEqual(baseline.eligible_executors);
    expect(String((ctx.store.get("advisor_decision", String(withAdvisor.advisor_decision_id))).mode)).toBe("BASELINE");
  });

  it("17. stale experience filtered before scoring", () => {
    const ctx = makeCtx("t17");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    ctx.experience.markStale(String(exp.experience_id), "executor version changed");
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect((receipt.experience_ids_applied as string[]).length).toBe(0);
    expect(String(receipt.selected)).toBe("A_LOW");
  });

  it("18. incompatible environment experience filtered", () => {
    const ctx = makeCtx("t18");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const { executionId } = seedExecution(ctx, "B_HIGH");
    const exp = ctx.extractor.fromExecution(executionId, {
      origin: "REAL_EXECUTION",
      environment: { os: "windows" },
    })[0];
    promoteActive(ctx, String(exp.experience_id));
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV, // linux
    });
    expect((receipt.experience_ids_applied as string[]).length).toBe(0);
    expect(String(receipt.selected)).toBe("A_LOW");
  });

  it("19. revoked experience ignored", () => {
    const ctx = makeCtx("t19");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    ctx.experience.revoke(String(exp.experience_id), "operator");
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect(String(receipt.selected)).toBe("A_LOW");
  });

  it("20. superseded experience ignored", () => {
    const ctx = makeCtx("t20");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    ctx.experience.supersede(String(exp.experience_id), "EXP_new");
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect(String(receipt.selected)).toBe("A_LOW");
  });

  it("21. contradictory evidence triggers deterministic contradiction policy", () => {
    const ctx = makeCtx("t21");
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    // new verified failure under same scope → QUARANTINE policy
    const { executionId: failId } = seedExecution(ctx, "B_HIGH", { status: "FAILED", error: "OOM" });
    const out = ctx.experience.recordContradiction(String(exp.experience_id), {
      conflicting_evidence_ref: `executor_execution:${failId}`,
      summary: "executor now fails same capability under same env",
      resolution: "QUARANTINE",
    });
    expect(String(out.status)).toBe("QUARANTINED");
    expect((out.contradictions as unknown[]).length).toBe(1);
    const events = ctx.store.listEvents("experience", String(exp.experience_id));
    expect(events.map((e) => e.event_type)).toContain("EXPERIENCE_CONTRADICTION");
  });

  it("22. duplicate evidence does not double-count", () => {
    const ctx = makeCtx("t22");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const a = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    const again = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    expect(String(again.experience_id)).toBe(String(a.experience_id));
    expect(Number(again.observation_count)).toBe(1);
  });
});

describe("P7 — determinism / rollback / plan reuse (tests 23–26)", () => {
  it("23. replaying same decision yields same winner", () => {
    const ctx = makeCtx("t23");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    const { task } = seedTask(ctx);
    const d1 = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    const d2 = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(d1.selected_executor)).toBe(String(d2.selected_executor));
    const r1 = ctx.store.get("advisor_decision", String(d1.advisor_decision_id));
    const r2 = ctx.store.get("advisor_decision", String(d2.advisor_decision_id));
    expect(r1.final_scores).toEqual(r2.final_scores);
    expect(r1.experience_adjustments).toEqual(r2.experience_adjustments);
  });

  it("24. disabling adaptive advisor restores deterministic baseline", () => {
    const ctx = makeCtx("t24");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    ctx.routingAdvisor.enabled = false;
    const { task } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(decision.selected_executor)).toBe("A_LOW");
    const receipt = ctx.store.get("advisor_decision", String(decision.advisor_decision_id));
    expect(String(receipt.mode)).toBe("BASELINE");
    expect(String(receipt.mode_reason)).toBe("ADVISOR_DISABLED");
    // no data deleted
    expect(String(ctx.experience.get(String(exp.experience_id)).status)).toBe("ACTIVE");
  });

  it("25. PLAN_TEMPLATE reuse still passes current plan validation", () => {
    const ctx = makeCtx("t25");
    const project = ctx.service.createProject({ name: "p", root_location: ctx.dir });
    const mission = ctx.service.createMission({ project_id: String(project.project_id), goal: "g" });
    ctx.service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: [
        { task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"] },
        { task_key: "T2", title: "b", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
      ],
      source: "test",
      proposal: {},
    });
    const exp = ctx.extractor.planTemplate(String(mission.mission_id), 1, { origin: "REAL_EXECUTION" });
    ctx.verifier.verifyAndQualify(String(exp.experience_id), V);
    const { proposal } = ctx.plannerAdvisor.reusePlanTemplate(String(exp.experience_id));
    const validated = validatePlanProposal(proposal, new Set(["FILE_OPERATIONS"]));
    expect(validated.length).toBe(2);
    // reuse commits a NEW plan revision bound to the current mission
    const out = ctx.service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: validated,
      source: "PLAN_TEMPLATE_REUSE",
      proposal,
    });
    expect(out.revision).toBe(2);
    const events = ctx.store.listEvents("experience", String(exp.experience_id));
    expect(events.map((e) => e.event_type)).toContain("PLAN_TEMPLATE_APPLIED");
  });

  it("26. reused plan cannot inherit prior permissions/executors", () => {
    const ctx = makeCtx("t26");
    const project = ctx.service.createProject({ name: "p", root_location: ctx.dir });
    const mission = ctx.service.createMission({
      project_id: String(project.project_id), goal: "g", granted_permissions: ["WRITE"],
    });
    ctx.service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: [{ task_key: "T1", title: "a", required_capabilities: ["FILE_OPERATIONS"], selected_executor: "CODEX", metadata: { permissions: ["NETWORK"] } }],
      source: "test",
      proposal: {},
    });
    const exp = ctx.extractor.planTemplate(String(mission.mission_id), 1, { origin: "REAL_EXECUTION" });
    ctx.verifier.verifyAndQualify(String(exp.experience_id), V);
    const { proposal } = ctx.plannerAdvisor.reusePlanTemplate(String(exp.experience_id));
    expect(JSON.stringify(proposal)).not.toContain("CODEX");
    expect(JSON.stringify(proposal)).not.toContain("NETWORK");
    expect(JSON.stringify(proposal)).not.toContain("selected_executor");
  });
});

describe("P7 — failure/remediation learning (tests 27–28)", () => {
  it("27. FAILURE_SIGNATURE normalization ignores volatile IDs/timestamps", () => {
    const a = normalizeErrorSignature("Write failed /tmp/x_abc123 at 2026-09-27T10:00:00Z id 99F4AB");
    const b = normalizeErrorSignature("write failed /tmp/y_def456 at 2026-10-01T11:00:00Z id A1B2C3");
    expect(a).toBe(b);
    expect(a).not.toContain("abc123");
    expect(a).not.toContain("2026");
  });

  it("28. REMEDIATION_PAIR requires verified successful remediation", () => {
    const ctx = makeCtx("t28");
    const { executionId: failId } = seedExecution(ctx, "PAIR_NATIVE", { status: "FAILED", error: "OOM" });
    const { executionId: stillBad } = seedExecution(ctx, "PAIR_NATIVE", { status: "FAILED", error: "OOM" });
    expect(() =>
      ctx.extractor.remediationPair(failId, stillBad, { origin: "REAL_EXECUTION", remediation: "retry" }),
    ).toThrow(/FAIL_CLOSED_REMEDIATION_NOT_VERIFIED/);
    const { executionId: okId } = seedExecution(ctx, "PAIR_NATIVE");
    const pair = ctx.extractor.remediationPair(failId, okId, { origin: "REAL_EXECUTION", remediation: "retry with smaller batch", environment: ENV });
    expect(String(pair.type)).toBe("REMEDIATION_PAIR");
    expect(String(pair.status)).toBe("CANDIDATE");
  });
});

describe("P7 — scoring bounds / receipts / feedback (tests 29–32)", () => {
  it("29. negative experience lowers preference only within eligible set", () => {
    const ctx = makeCtx("t29");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const { executionId } = seedExecution(ctx, "A_LOW", { status: "FAILED", error: "TIMEOUT" });
    const exp = ctx.experience.createCandidate({
      type: "NEGATIVE_EXPERIENCE",
      source_evidence_refs: [`executor_execution:${executionId}`],
      provenance: "x",
      evidence_origin: "REAL_EXECUTION",
      compatibility_scope: { executors: ["A_LOW"], capabilities: ["TEXT_INFERENCE"], environment: ENV },
      outcome: "FAILURE",
    });
    promoteActive(ctx, String(exp.experience_id));
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect(String(receipt.selected)).toBe("B_HIGH");
    // both were still eligible — negative pressure is a score, not a ban
    expect(receipt.eligible_candidates).toEqual(["A_LOW", "B_HIGH"]);
  });

  it("30. routing advisory receipt digest detects tampering", () => {
    const ctx = makeCtx("t30");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    const receipt = ctx.routingAdvisor.advise({
      eligible: [{ executor_id: "A_LOW", routing_priority: 10 }],
      environment: ENV,
    });
    expect(ctx.routingAdvisor.verifyReceipt(receipt)).toBe(true);
    const tampered = { ...receipt, selected: "CODEX" };
    expect(ctx.routingAdvisor.verifyReceipt(tampered)).toBe(false);
  });

  it("31. provider/model observation cannot directly alter P6 qualification", () => {
    const ctx = makeCtx("t31");
    // model_entry stays DISCOVERED — experience extraction touches only
    // experience entities; P6 lifecycle is never mutated by Layer C.
    ctx.store.put("model_entry", "ME_x", {
      model_entry_id: "ME_x", model_id: "m", lifecycle_state: "DISCOVERED", version: 0,
    }, 0);
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    ctx.store.db
      .prepare("UPDATE entities SET payload=? WHERE entity_type='executor_execution' AND entity_id=?")
      .run(
        JSON.stringify({
          ...ctx.store.get("executor_execution", executionId),
          provider_id: "PRV_x", model_id: "m",
        }).replace(/"payload_hash"[^}]*/g, ""),
        executionId,
      );
    // simpler: write the provider/model fields via a fresh entity
    const { executionId: e2 } = seedExecution(ctx, "PAIR_NATIVE");
    const rec = ctx.store.get("executor_execution", e2);
    rec.provider_id = "PRV_x";
    rec.model_id = "m";
    ctx.store.put("executor_execution", e2, rec, Number(rec.version));
    const exps = ctx.extractor.fromExecution(e2, { origin: "REAL_EXECUTION", environment: ENV });
    expect(exps.some((e) => e.type === "PROVIDER_MODEL_OBSERVATION")).toBe(true);
    const model = ctx.store.get("model_entry", "ME_x");
    expect(String(model.lifecycle_state)).toBe("DISCOVERED");
  });

  it("32. same mission execution cannot influence its own already-made route decision", () => {
    const ctx = makeCtx("t32");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const { task, mission } = seedTask(ctx);
    const decision = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    const before = String(decision.selected_executor);
    const digestBefore = String(decision.decision_digest);
    // execution completes → extraction creates experience → replay the stored
    // decision must be identical (digest + selection unchanged).
    const { executionId } = seedExecution(ctx, "B_HIGH", { route: true });
    ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const stored = ctx.store.get("routing_decision", String(decision.routing_decision_id));
    expect(String(stored.selected_executor)).toBe(before);
    expect(ctx.router.verifyDecisionDigest(stored)).toBe(true);
    expect(String(stored.decision_digest)).toBe(digestBefore);
    void mission;
  });
});

describe("P7 — controlled positive adaptive selection (§28)", () => {
  it("A. two hard-eligible executors: ACTIVE experience flips selection; revoke restores baseline", () => {
    const ctx = makeCtx("adaptive");
    registerExecutor(ctx, "DSH", { priority: 10 });
    registerExecutor(ctx, "CODEX", { priority: 30 });
    const { task } = seedTask(ctx);

    // baseline deterministic: DSH (lower priority wins)
    const base = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(base.selected_executor)).toBe("DSH");
    expect(String(base.adaptive_mode)).toBe("BASELINE");

    // verified CODEX affinity (two real observations satisfy ROUTING_PRIOR
    // min_support=2; EXECUTOR_OBSERVATION also applies)
    const e1 = seedExecution(ctx, "CODEX", { route: true });
    const e2 = seedExecution(ctx, "CODEX", { route: true });
    const extracted = [
      ...ctx.extractor.fromExecution(e1.executionId, { origin: "REAL_EXECUTION", environment: ENV }),
      ...ctx.extractor.fromExecution(e2.executionId, { origin: "REAL_EXECUTION", environment: ENV }),
    ];
    const uniqueIds = [...new Set(extracted.map((e) => String(e.experience_id)))];
    for (const id of uniqueIds) promoteActive(ctx, id);

    const adaptive = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(adaptive.selected_executor)).toBe("CODEX");
    expect(String(adaptive.adaptive_mode)).toBe("ADAPTIVE");
    const receipt = ctx.store.get("advisor_decision", String(adaptive.advisor_decision_id));
    expect([...(receipt.eligible_candidates as string[])].sort()).toEqual(["CODEX", "DSH"]);
    expect((receipt.experience_ids_applied as string[]).length).toBeGreaterThan(0);
    const adj = receipt.experience_adjustments as Record<string, number>;
    expect(adj.CODEX).toBeGreaterThan(0);
    expect(adj.DSH).toBe(0);
    expect(adj.CODEX).toBeLessThanOrEqual(40); // bounded
    // hard gates unchanged — eligible set identical, no candidate added
    expect(adaptive.eligible_executors).toEqual(base.eligible_executors);
    expect(adaptive.rejected_executors).toEqual(base.rejected_executors);

    // revoke → deterministic baseline restored
    for (const id of uniqueIds) ctx.experience.revoke(id, "rollback");
    const after = ctx.router.route(task, { routingAdvisor: ctx.routingAdvisor, environment: ENV });
    expect(String(after.selected_executor)).toBe("DSH");
  });
});

describe("P7 — feedback loop + persistence", () => {
  it("terminal execution → extraction → verify → ACTIVE → later mission consumes advice", () => {
    const ctx = makeCtx("feedback");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const fe1 = seedExecution(ctx, "B_HIGH", { route: true });
    const fe2 = seedExecution(ctx, "B_HIGH", { route: true });
    ctx.extractor.fromExecution(fe1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    ctx.extractor.fromExecution(fe2.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exps = ctx.store.list("experience");
    for (const e of exps) promoteActive(ctx, String(e.experience_id));
    const receipt = ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect((receipt.experience_ids_applied as string[]).length).toBeGreaterThan(0);
    const events = ctx.store.listEvents("advisor_decision").map((e) => String(e.event_type));
    expect(events).toContain("ADAPTIVE_ROUTE_SELECTED");
  });

  it("restart persists experience state + advisor receipts; same snapshot → same decision", () => {
    const ctx = makeCtx("restart");
    registerExecutor(ctx, "A_LOW", { priority: 10 });
    registerExecutor(ctx, "B_HIGH", { priority: 30 });
    const re1 = seedExecution(ctx, "B_HIGH");
    const re2 = seedExecution(ctx, "B_HIGH");
    ctx.extractor.fromExecution(re1.executionId, { origin: "REAL_EXECUTION", environment: ENV });
    const exp = ctx.extractor.fromExecution(re2.executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    promoteActive(ctx, String(exp.experience_id));
    ctx.routingAdvisor.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    const dbPath = path.join(ctx.dir, "pair.db");
    ctx.store.close();
    const store2 = new PairEvidenceStore(dbPath);
    const service2 = new PairControlPlane(store2);
    const exp2 = new ExperienceService(service2);
    const advisor2 = new VerifiedExperienceRoutingAdvisor(service2, exp2);
    const persisted = exp2.get(String(exp.experience_id));
    expect(String(persisted.status)).toBe("ACTIVE");
    expect(store2.list("advisor_decision").length).toBe(1);
    const r2 = advisor2.advise({
      eligible: [
        { executor_id: "A_LOW", routing_priority: 10 },
        { executor_id: "B_HIGH", routing_priority: 30 },
      ],
      environment: ENV,
    });
    expect(String(r2.selected)).toBe("B_HIGH");
    store2.close();
  });

  it("digest field integrity — modified experience payload breaks digest", () => {
    const ctx = makeCtx("digest");
    registerExecutor(ctx, "PAIR_NATIVE");
    const { executionId } = seedExecution(ctx, "PAIR_NATIVE");
    const exp = ctx.extractor.fromExecution(executionId, { origin: "REAL_EXECUTION", environment: ENV })[0];
    const tampered = { ...exp, payload: { hacked: true } };
    expect(experienceDigest(tampered)).not.toBe(String(exp.experience_digest));
    const res = ctx.verifier.verify(String(exp.experience_id), { verifier_id: V, target: "QUALIFIED" });
    expect(res.pass).toBe(true);
  });
});
