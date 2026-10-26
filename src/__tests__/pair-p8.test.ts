/**
 * P8 AUTONOMOUS RECOVERY + SELF-IMPROVEMENT GOVERNANCE tests.
 *
 * §36 — 40 required deterministic proofs.
 * §37 — controlled recovery E2E (bounded real dispatch through the gate).
 * §38 — controlled remediation E2E.
 * §39 — self-improvement E2E (isolated worktree, stops before merge).
 *
 * Authority model under test: RecoveryController DECIDES; it never dispatches.
 * SelfImprovementController proposes/tests in disposable worktrees; it never
 * merges into the canonical repo and never expands authority.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  classifyChangedFiles,
  classifyFailure,
  DEFAULT_RECOVERY_POLICY,
  ExecutorRegistry,
  ExperienceService,
  ExperienceVerifier,
  GovernedTaskGate,
  IntegrityError,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ReconciliationService,
  RecoveryController,
  RECOVERY_MATRIX,
  RECOVERY_MATRIX_VERSION,
  SelfImprovementController,
  TRANSPORT_IN_PROCESS,
  digest,
  utcnow,
  validatePlanProposal,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p8-");
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* ------------------------------------------------------------------ */
/* Scripted adapter — deterministic executor whose dispatch sequence is */
/* programmed per test. Still a real ExecutorAdapter: the gate drives   */
/* probe→qualify→dispatch→observe→collect through it.                    */
/* ------------------------------------------------------------------ */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  script: Array<{ status: string; error_class?: string }> = [];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  tasks: Record<string, Record<string, unknown>> = {};
  observeOverride: Record<string, unknown> | null = null;
  dispatchEvidence: { dispatched: boolean; execution_id?: string } | undefined;
  available = true;

  constructor(id: string, script: Array<{ status: string; error_class?: string }>) {
    this.executor_id = id;
    this.script = [...script];
  }

  probe() {
    return { executor_id: this.executor_id, available: this.available, state: this.available ? "READY" : "DEGRADED" };
  }
  qualify() {
    return this.available
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["EXECUTOR_UNAVAILABLE"] };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING"] };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.shift() ?? { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.tasks[eid] = task;
    this.collected[eid] = step.status === "FAILED"
      ? { status: "FAILED", error: { class: step.error_class ?? "PROCESS_EXIT", message: step.error_class ?? "failed" } }
      : { status: step.status, summary: `${this.executor_id} did work` };
    return {
      execution_id: eid,
      status: step.status,
      error: step.error_class ? { class: step.error_class } : undefined,
      run_root: step.status === "RUNNING" ? path.join(ROOT, "run", eid) : null,
      workspace: task.workspace,
    };
  }
  observe(executionId: string) {
    if (this.observeOverride) return this.observeOverride;
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const t = this.tasks[executionId] ?? {};
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return {
      execution_id: executionId,
      mission_id: t.mission_id,
      task_id: t.task_id,
      governed_task_id: t.governed_task_id,
      artifacts: [],
      ...r,
    };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: this.available ? "READY" : "DEGRADED" };
  }
  dispatch_evidence() {
    return this.dispatchEvidence;
  }
}

/* ------------------------------- ctx ------------------------------ */

interface Ctx {
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  gate: GovernedTaskGate;
  registry: ExecutorRegistry;
  router: MissionRouter;
  recovery: RecoveryController;
  recon: ReconciliationService;
  experience: ExperienceService;
  verifier: ExperienceVerifier;
  adapters: Map<string, ExecutorAdapter>;
  capsRegistered: Set<string>;
}

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters);
  const experience = new ExperienceService(service);
  const verifier = new ExperienceVerifier(service, experience);
  return { dir, workspace, store, service, gate, registry, router, recovery, recon, experience, verifier, adapters, capsRegistered: new Set() };
}

function registerScripted(ctx: Ctx, adapter: ScriptedAdapter, opts: { caps?: string[]; priority?: number } = {}) {
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL_ACP",
    capabilities: opts.caps ?? ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: opts.priority ?? 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
    },
  });
  const caps = opts.caps ?? ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION"];
  const routeId = `RTE_${adapter.executor_id}`;
  if (!ctx.service.routes.getRoute(routeId)) {
    ctx.service.routes.registerRoute({
      route_id: routeId,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      direct_callable: true,
      capabilities: caps,
      priority: opts.priority ?? 50,
      executor_hint: adapter.executor_id,
    });
  }
  if (!ctx.service.routes.bindingFor(adapter.executor_id, routeId)) {
    ctx.service.routes.registerBinding({
      executor_id: adapter.executor_id,
      route_id: routeId,
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
      capabilities: caps,
    });
  }
  ctx.adapters.set(adapter.executor_id, adapter);
}

interface MissionSeed {
  missionId: string;
  taskIds: string[];
  revision: number;
}

function seedMission(ctx: Ctx, taskSpecs: Array<Record<string, unknown>> = []): MissionSeed {
  const project = ctx.service.createProject({ name: "p8", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p8 recovery",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  const allCaps = ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "REASONING"];
  for (const c of allCaps) {
    if (!ctx.capsRegistered.has(c)) {
      ctx.service.registerCapability(c, { risk_class: "LOW" });
      ctx.capsRegistered.add(c);
    }
  }
  const specs = taskSpecs.length
    ? taskSpecs
    : [{ task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }];
  const proposal = { tasks: specs };
  const tasks = validatePlanProposal(proposal, new Set(allCaps));
  const committed = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: tasks.map((t) => ({ ...t })),
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const active = ctx.service.activeRevision(String(mission.mission_id));
  return { missionId: String(mission.mission_id), taskIds: committed.task_ids.map(String), revision: Number(active.revision) };
}

function requestFor(ctx: Ctx, m: MissionSeed, idx = 0): Record<string, unknown> {
  return {
    mission_id: m.missionId,
    task_id: m.taskIds[idx],
    plan_revision: m.revision,
    task_instruction: "do governed work",
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: ["FILE_WRITE"],
    requested_tools: ["SHELL_EXECUTION"],
    constraints: [],
    timeout: 30,
    expected_output_contract: { type: "TASK_RESULT", summary: "result" },
    correlation_id: `corr-p8-${idx}`,
  };
}

function seedFailedExecution(ctx: Ctx, missionId: string, taskId: string, executorId: string, errorClass = "TRANSIENT_TRANSPORT") {
  const eid = `EXEC_${digest({ e: Math.random() }).slice(0, 10)}`;
  ctx.store.put("executor_execution", eid, {
    execution_id: eid,
    executor_id: executorId,
    mission_id: missionId,
    task_id: taskId,
    execution_state: "FAILED",
    result_state: "FAILED",
    result: { status: "FAILED", error: { class: errorClass } },
    dispatch_timestamp: utcnow(),
    version: 0,
  }, 0);
  return eid;
}

const ENV = { os: "linux", arch: "x64", node: "v22" };
const V = "PAIR_DETERMINISTIC_VERIFIER_V1";

/** Add a task entity under the mission's current plan revision (canonical task shape). */
function addTask(ctx: Ctx, m: MissionSeed, taskKey: string, caps: string[]): string {
  const mission = ctx.service.getMission(m.missionId);
  const taskId = `TSK_${digest({ k: taskKey, n: Math.random() }).slice(0, 10)}`;
  ctx.store.put("task", taskId, {
    task_id: taskId,
    task_key: taskKey,
    mission_id: m.missionId,
    plan_id: mission.plan_id,
    plan_revision: m.revision,
    order: 99,
    title: taskKey,
    description: taskKey,
    task_instruction: taskKey,
    required_capabilities: caps,
    status: "READY",
    metadata: {},
    depends_on: [],
    created_at: utcnow(),
    version: 0,
  }, 0);
  return taskId;
}

function seedActiveRemediation(ctx: Ctx, opts: { payload?: Record<string, unknown>; executors?: string[] } = {}) {
  const executors = opts.executors ?? ["EX_A"];
  // resolvable evidence ref that mentions the subject executor
  const eid = `EXEC_${digest({ rem: Math.random() }).slice(0, 10)}`;
  ctx.store.put("executor_execution", eid, {
    execution_id: eid,
    executor_id: executors[0],
    mission_id: "MX",
    task_id: "TX",
    execution_state: "COMPLETED",
    result_state: "COMPLETED",
    result: { status: "COMPLETED" },
    dispatch_timestamp: utcnow(),
    version: 0,
  }, 0);
  const exp = ctx.experience.createCandidate({
    type: "REMEDIATION_PAIR",
    source_evidence_refs: [`executor_execution:${eid}`],
    provenance: "test_seeded_remediation",
    evidence_origin: "REAL_EXECUTION",
    compatibility_scope: { executors, environment: ENV },
    payload: { remediation: "retry after fixing env", risk_class: "LOW", ...(opts.payload ?? {}) },
    outcome: "SUCCESS",
    min_support: 1,
  });
  ctx.verifier.verifyAndQualify(String(exp.experience_id), V);
  ctx.verifier.verifyAndActivate(String(exp.experience_id), V);
  return String(exp.experience_id);
}

/* ================================================================== */
/* §36 deterministic tests                                             */
/* ================================================================== */

describe("P8 §36 — failure classification + matrix", () => {
  it("1. classifyFailure maps raw errors to stable classes", () => {
    expect(classifyFailure({ error_class: "ACP_TRANSPORT_CLOSED" })).toBe("TRANSIENT_TRANSPORT");
    expect(classifyFailure({ error_class: "ACP_REQUEST_TIMEOUT" })).toBe("TIMEOUT");
    expect(classifyFailure({ error_class: "GROQ_429_TPD_EXCEEDED" })).toBe("RATE_LIMITED");
    expect(classifyFailure({ error_class: "CODEX_EXIT_1" })).toBe("PROCESS_EXIT");
    expect(classifyFailure({ error_code: "FAIL_CLOSED_CREDENTIAL_MISSING" })).toBe("AUTHENTICATION_FAILURE");
    expect(classifyFailure({ execution_state: "TIMEOUT" })).toBe("TIMEOUT");
    expect(classifyFailure({ execution_state: "FAILED", error_class: "CODEX_EXIT_1" })).toBe("PROCESS_EXIT");
    expect(classifyFailure({ execution_state: "FAILED" })).toBe("UNKNOWN");
    expect(classifyFailure({ error_class: "SOMETHING_NEVER_SEEN" })).toBe("UNKNOWN");

    expect(classifyFailure({
      execution_state: "FAILED",
      result: { status: "FAILED", error: { class: "CODEX_AGENT_REPORTED_FAILURE" }, summary: "Created the scraper, but DNS resolution for www.mql5.com failed." },
    })).toBe("ENVIRONMENT_INCOMPATIBLE");
    expect(classifyFailure({
      execution_state: "FAILED",
      result: { status: "FAILED", error: { class: "AGENT_FAIL", message: "curl: (6) Could not resolve host: x" }, summary: "" },
    })).toBe("ENVIRONMENT_INCOMPATIBLE");
  });

  it("2. matrix covers all 28 failure classes with stable semantic fields", () => {
    // 28 = 26 original + ROUTE_INFEASIBLE (route-local infeasibility split
    // from POLICY_DENIAL — Route Capability Authority & Staleness Closure)
    // + TASK_INFEASIBLE (deterministic executor-reported incapacity — R8).
    expect(Object.keys(RECOVERY_MATRIX).sort()).toHaveLength(28);
    expect(RECOVERY_MATRIX.ROUTE_INFEASIBLE.retry_allowed).toBe(false);
    expect(RECOVERY_MATRIX.ROUTE_INFEASIBLE.actions[0]).toBe("RE_ROUTE");
    expect(RECOVERY_MATRIX.TASK_INFEASIBLE.retry_allowed).toBe(false);
    expect(RECOVERY_MATRIX.TASK_INFEASIBLE.actions[0]).toBe("REPLAN");
    for (const row of Object.values(RECOVERY_MATRIX)) {
      expect(row.actions.length).toBeGreaterThan(0);
      expect(typeof row.retry_allowed).toBe("boolean");
    }
  });

  it("3. every decision is persisted as a receipt with digest + matrix version", () => {
    const ctx = makeCtx("t3");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId,
      task_id: m.taskIds[0],
      failure_class: "TRANSIENT_TRANSPORT",
      executor_id: "EX_A",
      correlation_id: "c1",
    });
    const stored = ctx.store.get("recovery_decision", String(d.recovery_id));
    expect(stored.policy_version).toBe(RECOVERY_MATRIX_VERSION);
    expect(stored.decision_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.selected_action).toBe("RETRY_SAME_ROUTE");
    expect(stored.candidate_actions).toContain("RE_ROUTE");
  });

  it("4. TRANSIENT_TRANSPORT → bounded RETRY_SAME_ROUTE first", () => {
    const ctx = makeCtx("t4");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    expect(d.selected_action).toBe("RETRY_SAME_ROUTE");
    expect(Number(d.backoff_ms)).toBeGreaterThan(0);
  });

  it("5. RATE_LIMITED prefers re-route over blind retry when alternate exists", () => {
    const ctx = makeCtx("t5");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId,
      task_id: m.taskIds[0],
      failure_class: "RATE_LIMITED",
      executor_id: "EX_A",
      eligible_executors: ["EX_A", "EX_B"],
    });
    expect(d.selected_action).toBe("RE_ROUTE");
  });

  it("6. RATE_LIMITED with no alternate falls back to bounded retry", () => {
    const ctx = makeCtx("t6");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "RATE_LIMITED",
      executor_id: "EX_A", eligible_executors: ["EX_A"],
    });
    expect(d.selected_action).toBe("RETRY_SAME_ROUTE");
    expect(d.rejected_actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "RE_ROUTE", reason: "NO_ALTERNATE_ELIGIBLE_EXECUTOR" })]),
    );
  });

  it("7. EXECUTOR_UNAVAILABLE → RE_ROUTE only when alternate eligible", () => {
    const ctx = makeCtx("t7");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "EXECUTOR_UNAVAILABLE",
      executor_id: "EX_A", eligible_executors: ["EX_A", "EX_B"],
    });
    expect(d.selected_action).toBe("RE_ROUTE");
    const d2 = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "EXECUTOR_UNAVAILABLE",
      executor_id: "EX_A", eligible_executors: ["EX_A"],
    });
    expect(d2.selected_action).toBe("RECONCILIATION_REQUIRED");
  });

  it("8. POLICY_DENIAL → ABORT, never retry or reroute", () => {
    const ctx = makeCtx("t8");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "POLICY_DENIAL",
      eligible_executors: ["EX_A", "EX_B"], verified_remediation_ids: ["x"],
    });
    expect(d.selected_action).toBe("ABORT");
    expect(d.candidate_actions).not.toContain("RE_ROUTE");
    expect(d.candidate_actions).not.toContain("RETRY_SAME_ROUTE");
  });

  it("9. PERMISSION_DENIAL → HUMAN_APPROVAL_REQUIRED, never self-escalates", () => {
    const ctx = makeCtx("t9");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "PERMISSION_DENIAL" });
    expect(d.selected_action).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("10. AUTHENTICATION_FAILURE never provisions credentials — human/abort only", () => {
    const ctx = makeCtx("t10");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "AUTHENTICATION_FAILURE" });
    expect(["HUMAN_APPROVAL_REQUIRED", "ABORT"]).toContain(d.selected_action);
  });

  it("11. AMBIGUOUS_DISPATCH → RECONCILIATION_REQUIRED, never blind replay", () => {
    const ctx = makeCtx("t11");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "AMBIGUOUS_DISPATCH",
      eligible_executors: ["EX_A", "EX_B"],
    });
    expect(d.selected_action).toBe("RECONCILIATION_REQUIRED");
  });

  it("12. INTERNAL_RUNTIME_DEFECT may open a self-improvement candidate flag", () => {
    const ctx = makeCtx("t12");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "INTERNAL_RUNTIME_DEFECT" });
    expect(d.selfmod_candidate_eligible).toBe(true);
    expect(["HUMAN_APPROVAL_REQUIRED", "ABORT"]).toContain(d.selected_action);
  });

  it("13. ARTIFACT_VALIDATION_FAILURE never marks success — remediation/replan/abort", () => {
    const ctx = makeCtx("t13");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE" });
    expect(["APPLY_VERIFIED_REMEDIATION", "REPLAN", "ABORT"]).toContain(d.selected_action);
    expect(d.candidate_actions).not.toContain("RETRY_SAME_ROUTE");
  });

  it("14. MODEL_UNAVAILABLE → RE_ROUTE only to already-routable alternate", () => {
    const ctx = makeCtx("t14");
    const m = seedMission(ctx);
    const noAlt = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "MODEL_UNAVAILABLE", executor_id: "EX_A", eligible_executors: ["EX_A"] });
    expect(noAlt.selected_action).not.toBe("RE_ROUTE");
    const alt = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "MODEL_UNAVAILABLE", executor_id: "EX_A", eligible_executors: ["EX_A", "EX_B"] });
    expect(alt.selected_action).toBe("RE_ROUTE");
  });
});

describe("P8 §36 — budgets + loop guards", () => {
  it("15. task attempt ceiling → HUMAN_APPROVAL_REQUIRED", () => {
    const ctx = makeCtx("t15");
    const m = seedMission(ctx);
    for (let i = 0; i < DEFAULT_RECOVERY_POLICY.max_attempts_per_task; i++) {
      ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    }
    const d = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    expect(d.selected_action).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(d.rejected_actions[0].reason).toBe("MAX_RECOVERY_ATTEMPTS_PER_TASK");
  });

  it("16. mission attempt ceiling → ABORT", () => {
    const ctx = makeCtx("t16");
    const policy = { ...DEFAULT_RECOVERY_POLICY, max_attempts_per_task: 100, max_attempts_per_mission: 3 };
    const recovery = new RecoveryController(ctx.service, policy);
    const m = seedMission(ctx, [
      { task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
      { task_key: "T2", title: "t2", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
      { task_key: "T3", title: "t3", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
      { task_key: "T4", title: "t4", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    ]);
    recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[1], failure_class: "TRANSIENT_TRANSPORT" });
    recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[2], failure_class: "TRANSIENT_TRANSPORT" });
    const d = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[3], failure_class: "TRANSIENT_TRANSPORT" });
    expect(d.selected_action).toBe("ABORT");
  });

  it("17. consecutive identical failure signature escalates to human", () => {
    const ctx = makeCtx("t17");
    const policy = { ...DEFAULT_RECOVERY_POLICY, max_attempts_per_task: 10, max_consecutive_identical: 2 };
    const recovery = new RecoveryController(ctx.service, policy);
    const m = seedMission(ctx);
    recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TOOL_FAILURE", executor_id: "EX_A" });
    recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TOOL_FAILURE", executor_id: "EX_A" });
    const d = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TOOL_FAILURE", executor_id: "EX_A" });
    expect(d.selected_action).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(d.rejected_actions[0].reason).toBe("MAX_CONSECUTIVE_IDENTICAL_FAILURES");
  });

  it("18. replan budget enforced per mission", () => {
    const ctx = makeCtx("t18");
    const policy = { ...DEFAULT_RECOVERY_POLICY, max_attempts_per_task: 10, max_replans_per_mission: 1 };
    const recovery = new RecoveryController(ctx.service, policy);
    const m = seedMission(ctx);
    const d1 = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "PLAN_INVALIDATED" });
    expect(d1.selected_action).toBe("REPLAN");
    const d2 = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "PLAN_INVALIDATED" });
    expect(d2.selected_action).toBe("ABORT");
  });

  it("19. backoff is bounded exponential", () => {
    const ctx = makeCtx("t19");
    const m = seedMission(ctx);
    const d1 = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    const d2 = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    expect(Number(d1.backoff_ms)).toBe(DEFAULT_RECOVERY_POLICY.retry_backoff_base_ms);
    expect(Number(d2.backoff_ms)).toBe(DEFAULT_RECOVERY_POLICY.retry_backoff_base_ms * 2);
    const policy = { ...DEFAULT_RECOVERY_POLICY, retry_backoff_base_ms: 100_000 };
    const recovery = new RecoveryController(ctx.service, policy);
    const d3 = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "TRANSIENT_TRANSPORT" });
    expect(Number(d3.backoff_ms)).toBeLessThanOrEqual(policy.retry_backoff_max_ms);
  });

  it("20. recovery disabled → FAIL_CLOSED, no decision persisted", () => {
    const ctx = makeCtx("t20");
    const recovery = new RecoveryController(ctx.service, DEFAULT_RECOVERY_POLICY, { enabled: false });
    const m = seedMission(ctx);
    expect(() => recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "UNKNOWN" })).toThrow(/FAIL_CLOSED_RECOVERY_DISABLED/);
    expect(ctx.store.list("recovery_decision")).toHaveLength(0);
  });

  it("21. rejected actions carry reasons; decision receipt tamper is detected", () => {
    const ctx = makeCtx("t21");
    const m = seedMission(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "EXECUTOR_UNAVAILABLE",
      executor_id: "EX_A", eligible_executors: ["EX_A"],
    });
    expect(d.rejected_actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "RE_ROUTE", reason: "NO_ALTERNATE_ELIGIBLE_EXECUTOR" })]),
    );
    const stored = ctx.store.get("recovery_decision", String(d.recovery_id));
    stored.selected_action = "RETRY_SAME_ROUTE"; // tamper
    expect(() => ctx.store.put("recovery_decision", String(d.recovery_id), stored, Number(stored.version))).not.toThrow();
    // verify-on-read: recompute digest vs stored → mismatch detectable
    const reread = ctx.store.get("recovery_decision", String(d.recovery_id));
    const { decision_digest: _drop, ...body } = reread as Record<string, unknown>;
    expect(digest(body)).not.toBe(reread.decision_digest);
  });
});

describe("P8 §36 — re-route supersede seam", () => {
  it("22. superseded governed task is not re-adopted by the router", () => {
    const ctx = makeCtx("t22");
    const a = new ScriptedAdapter("EX_A", [{ status: "FAILED", error_class: "TRANSIENT_TRANSPORT" }, { status: "COMPLETED" }]);
    registerScripted(ctx, a, { priority: 100 });
    const m = seedMission(ctx);
    const r1 = ctx.router.routeGovernedTask(requestFor(ctx, m), ctx.adapters);
    expect(r1.adopted).toBe(false);
    const gt1 = String(r1.governed_task.governed_task_id);
    // supersede + re-route → fresh governed task
    ctx.recovery.supersedeGovernedTask(gt1, "RCV_TEST");
    const r2 = ctx.router.routeGovernedTask(requestFor(ctx, m), ctx.adapters);
    expect(r2.adopted).toBe(false);
    expect(String(r2.governed_task.governed_task_id)).not.toBe(gt1);
    expect(a.dispatched.length).toBe(2);
    const oldGt = ctx.store.get("governed_task", gt1);
    expect(oldGt.governance_state).toBe("SUPERSEDED_BY_RECOVERY");
  });

  it("23. non-dispatchable governed task cannot be superseded", () => {
    const ctx = makeCtx("t23");
    const m = seedMission(ctx);
    const gtId = `GT_${digest({ x: Math.random() }).slice(0, 8)}`;
    ctx.store.put("governed_task", gtId, {
      governed_task_id: gtId, task_id: m.taskIds[0], mission_id: m.missionId,
      executor_id: "EX_A", plan_revision: m.revision, governance_state: "COMPLETED", version: 0,
    }, 0);
    expect(() => ctx.recovery.supersedeGovernedTask(gtId, "RCV_X")).toThrow(/FAIL_CLOSED_GOVERNED_TASK_NOT_SUPERSEDABLE/);
  });
});

describe("P8 §36 — verified remediation admissibility", () => {
  it("24. ACTIVE compatible REMEDIATION_PAIR is admissible", () => {
    const ctx = makeCtx("t24");
    const expId = seedActiveRemediation(ctx);
    const exp = ctx.recovery.verifyRemediationAdmissible(expId, { environment: ENV, executor_id: "EX_A", risk_ceiling: "HIGH" });
    expect(exp.experience_id).toBe(expId);
  });

  it("25. non-ACTIVE experience is inadmissible", () => {
    const ctx = makeCtx("t25");
    const eid = `EXEC_${digest({ rem: Math.random() }).slice(0, 10)}`;
    ctx.store.put("executor_execution", eid, { execution_id: eid, executor_id: "EX_A", execution_state: "COMPLETED", result: { status: "COMPLETED" }, version: 0 }, 0);
    const exp = ctx.experience.createCandidate({
      type: "REMEDIATION_PAIR", evidence_origin: "REAL_EXECUTION",
      source_evidence_refs: [`executor_execution:${eid}`], provenance: "x",
      payload: { remediation: "x" }, compatibility_scope: { executors: ["EX_A"] },
    });
    expect(() => ctx.recovery.verifyRemediationAdmissible(String(exp.experience_id), {})).toThrow(/FAIL_CLOSED_REMEDIATION_INADMISSIBLE.*EXPERIENCE_ACTIVE/);
  });

  it("26. permission_effect != NONE is inadmissible", () => {
    const ctx = makeCtx("t26");
    const eid = `EXEC_${digest({ rem: Math.random() }).slice(0, 10)}`;
    ctx.store.put("executor_execution", eid, { execution_id: eid, executor_id: "EX_A", execution_state: "COMPLETED", result: { status: "COMPLETED" }, version: 0 }, 0);
    const exp = ctx.experience.createCandidate({
      type: "REMEDIATION_PAIR", evidence_origin: "REAL_EXECUTION",
      source_evidence_refs: [`executor_execution:${eid}`], provenance: "x",
      payload: { remediation: "x" }, compatibility_scope: { executors: ["EX_A"] },
    });
    // force-field a bad record through the store (store allows write; admissibility must catch)
    const stored = ctx.store.get("experience", String(exp.experience_id));
    ctx.store.put("experience", String(exp.experience_id), { ...stored, permission_effect: "GRANT", status: "ACTIVE" }, Number(stored.version));
    expect(() => ctx.recovery.verifyRemediationAdmissible(String(exp.experience_id), {})).toThrow(/PERMISSION_EFFECT_NONE/);
  });

  it("27. stale experience is inadmissible", () => {
    const ctx = makeCtx("t27");
    const expId = seedActiveRemediation(ctx);
    const stored = ctx.store.get("experience", expId);
    ctx.store.put("experience", expId, { ...stored, stale_after: "2000-01-01T00:00:00.000Z" }, Number(stored.version));
    expect(() => ctx.recovery.verifyRemediationAdmissible(expId, {})).toThrow(/NOT_STALE/);
  });

  it("28. incompatible environment is inadmissible", () => {
    const ctx = makeCtx("t28");
    const expId = seedActiveRemediation(ctx);
    expect(() =>
      ctx.recovery.verifyRemediationAdmissible(expId, { environment: { os: "windows", arch: "arm64", node: "v22" } }),
    ).toThrow(/ENVIRONMENT_COMPATIBLE/);
  });

  it("29. credential-expanding remediation payload is inadmissible", () => {
    const ctx = makeCtx("t29");
    const expId = seedActiveRemediation(ctx, { payload: { remediation: "set api_key=sk-xxx to fix" } });
    expect(() => ctx.recovery.verifyRemediationAdmissible(expId, { environment: ENV })).toThrow(/NO_CREDENTIAL_EXPANSION/);
  });

  it("30. APPLY_VERIFIED_REMEDIATION only selected when verified remediation exists", () => {
    const ctx = makeCtx("t30");
    const m = seedMission(ctx);
    const noRem = ctx.recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE" });
    expect(noRem.selected_action).not.toBe("APPLY_VERIFIED_REMEDIATION");
    const expId = seedActiveRemediation(ctx);
    const withRem = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE",
      verified_remediation_ids: [expId],
    });
    expect(withRem.selected_action).toBe("APPLY_VERIFIED_REMEDIATION");
    expect(withRem.remediation_experience_id).toBe(expId);
    expect(withRem.experience_ids_considered).toContain(expId);
  });

  it("31. per-signature remediation budget enforced", () => {
    const ctx = makeCtx("t31");
    const policy = { ...DEFAULT_RECOVERY_POLICY, max_attempts_per_task: 10, max_remediations_per_signature: 1 };
    const recovery = new RecoveryController(ctx.service, policy);
    const m = seedMission(ctx);
    const expId = seedActiveRemediation(ctx);
    const d1 = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE", verified_remediation_ids: [expId] });
    expect(d1.selected_action).toBe("APPLY_VERIFIED_REMEDIATION");
    const d2 = recovery.decide({ mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE", verified_remediation_ids: [expId] });
    expect(d2.selected_action).not.toBe("APPLY_VERIFIED_REMEDIATION");
  });
});

describe("P8 §36 — remediation execution lifecycle", () => {
  it("32. remediation runs as a governed task with receipts", () => {
    const ctx = makeCtx("t32");
    const rem = new ScriptedAdapter("EX_REM", [{ status: "COMPLETED" }]);
    registerScripted(ctx, rem);
    const m = seedMission(ctx);
    const expId = seedActiveRemediation(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE",
      verified_remediation_ids: [expId],
    });
    const { remediation_execution_id, request } = ctx.recovery.proposeRemediationTask({
      mission_id: m.missionId, parent_task_id: m.taskIds[0], recovery_id: String(d.recovery_id),
      experience_id: expId, task_instruction: "re-verify artifact", workspace: ctx.workspace,
      permissions: ["FILE_WRITE"], required_capabilities: ["FILE_OPERATIONS"], plan_revision: m.revision,
    });
    // dispatch through the normal governed chain — no special path
    const taskId = addTask(ctx, m, "REM1", ["FILE_OPERATIONS"]);
    const routed = ctx.router.routeGovernedTask({ ...request, task_id: taskId }, ctx.adapters);
    ctx.recovery.bindRemediationExecution(remediation_execution_id, String(routed.governed_task.governed_task_id), String(routed.execution.execution_id));
    const outcome = ctx.recovery.evaluateRemediationOutcome(remediation_execution_id, "COMPLETED");
    expect(outcome.state).toBe("REMEDIATION_SUCCEEDED");
    expect(ctx.store.get("remediation_execution", remediation_execution_id).governed_task_id).toBeTruthy();
  });

  it("33. failed remediation → REMEDIATION_FAILED, never marks original succeeded", () => {
    const ctx = makeCtx("t33");
    const m = seedMission(ctx);
    const expId = seedActiveRemediation(ctx);
    const d = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE",
      verified_remediation_ids: [expId],
    });
    const { remediation_execution_id } = ctx.recovery.proposeRemediationTask({
      mission_id: m.missionId, parent_task_id: m.taskIds[0], recovery_id: String(d.recovery_id),
      experience_id: expId, task_instruction: "x", workspace: ctx.workspace,
      permissions: ["FILE_WRITE"], required_capabilities: ["FILE_OPERATIONS"], plan_revision: m.revision,
    });
    const outcome = ctx.recovery.evaluateRemediationOutcome(remediation_execution_id, "FAILED");
    expect(outcome.state).toBe("REMEDIATION_FAILED");
    const task = ctx.service.getTask(m.taskIds[0]);
    expect(task.status).not.toBe("COMPLETED");
  });
});

describe("P8 §36 — reconciliation", () => {
  it("34. intent-only → CONFIRMED_NOT_EXECUTED (replayable)", () => {
    const ctx = makeCtx("t34");
    const a = new ScriptedAdapter("EX_A", []);
    registerScripted(ctx, a);
    const m = seedMission(ctx);
    const gtId = `GT_${digest({ x: 1 }).slice(0, 8)}`;
    ctx.store.put("governed_task", gtId, {
      governed_task_id: gtId, task_id: m.taskIds[0], mission_id: m.missionId,
      executor_id: "EX_A", plan_revision: m.revision, governance_state: "DISPATCH_AUTHORIZED", version: 0,
    }, 0);
    ctx.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
      intent_id: `INTENT_${gtId}`, governed_task_id: gtId, executor_id: "EX_A", state: "INTENT_RECORDED", version: 0,
    }, 0);
    const r = ctx.recon.reconcile({ governed_task_id: gtId, mission_id: m.missionId });
    expect(r.outcome).toBe("CONFIRMED_NOT_EXECUTED");
    expect(r.replay_allowed).toBe(true);
  });

  it("35. terminal COMPLETED execution → CONFIRMED_COMPLETED", () => {
    const ctx = makeCtx("t35");
    const m = seedMission(ctx);
    const eid = `EXEC_${digest({ x: 2 }).slice(0, 8)}`;
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, mission_id: m.missionId, task_id: m.taskIds[0], executor_id: "EX_A",
      execution_state: "COMPLETED", result_state: "COMPLETED", result: { status: "COMPLETED" }, version: 0,
    }, 0);
    const r = ctx.recon.reconcile({ execution_id: eid, mission_id: m.missionId });
    expect(r.outcome).toBe("CONFIRMED_COMPLETED");
  });

  it("36. terminal FAILED → CONFIRMED_FAILED; no-result terminal never claims success", () => {
    const ctx = makeCtx("t36");
    const m = seedMission(ctx);
    const eid = `EXEC_${digest({ x: 3 }).slice(0, 8)}`;
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, mission_id: m.missionId, task_id: m.taskIds[0], executor_id: "EX_A",
      execution_state: "FAILED", result_state: "FAILED", version: 0,
    }, 0);
    const r = ctx.recon.reconcile({ execution_id: eid, mission_id: m.missionId });
    expect(r.outcome).toBe("CONFIRMED_FAILED");
    expect(r.replay_allowed).toBe(false);
  });

  it("37. unsettled + run_root + adapter silent → UNKNOWN_SIDE_EFFECT_STATE, never replay", () => {
    const ctx = makeCtx("t37");
    const a = new ScriptedAdapter("EX_A", []);
    a.observeOverride = { status: "LOST" };
    registerScripted(ctx, a);
    const m = seedMission(ctx);
    const eid = `EXEC_${digest({ x: 4 }).slice(0, 8)}`;
    const runRoot = path.join(ctx.dir, "run-root");
    fs.mkdirSync(runRoot, { recursive: true });
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, mission_id: m.missionId, task_id: m.taskIds[0], executor_id: "EX_A",
      governed_task_id: "GT_X", execution_state: "RUNNING", run_root: runRoot, version: 0,
    }, 0);
    const r = ctx.recon.reconcile({ execution_id: eid, mission_id: m.missionId });
    expect(r.outcome).toBe("UNKNOWN_SIDE_EFFECT_STATE");
    expect(r.replay_allowed).toBe(false);
    const stored = ctx.store.get("reconciliation_receipt", String(r.reconciliation_id));
    expect(stored.receipt_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("38. adapter-side dispatch evidence without canonical execution → UNKNOWN", () => {
    const ctx = makeCtx("t38");
    const a = new ScriptedAdapter("EX_A", []);
    a.dispatchEvidence = { dispatched: true, execution_id: "EXEC_GHOST" };
    registerScripted(ctx, a);
    const m = seedMission(ctx);
    const gtId = `GT_${digest({ x: 5 }).slice(0, 8)}`;
    ctx.store.put("governed_task", gtId, {
      governed_task_id: gtId, task_id: m.taskIds[0], mission_id: m.missionId,
      executor_id: "EX_A", plan_revision: m.revision, governance_state: "DISPATCH_AUTHORIZED", version: 0,
    }, 0);
    ctx.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
      intent_id: `INTENT_${gtId}`, governed_task_id: gtId, executor_id: "EX_A", state: "INTENT_RECORDED", version: 0,
    }, 0);
    const r = ctx.recon.reconcile({ governed_task_id: gtId, mission_id: m.missionId });
    expect(r.outcome).toBe("UNKNOWN_SIDE_EFFECT_STATE");
    expect(r.replay_allowed).toBe(false);
  });
});

describe("P8 §36 — restart recovery", () => {
  it("39. restart recovery reconciles unsettled executions + writes checkpoint idempotently", () => {
    const ctx = makeCtx("t39");
    const m = seedMission(ctx);
    const eid = `EXEC_${digest({ x: 6 }).slice(0, 8)}`;
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, mission_id: m.missionId, task_id: m.taskIds[0], executor_id: "EX_A",
      execution_state: "RUNNING", version: 0,
    }, 0);
    const cps = ctx.recovery.planRestartRecovery((execId) =>
      ctx.recon.reconcile({ execution_id: execId, mission_id: m.missionId }),
    );
    expect(cps).toHaveLength(1);
    const cp = cps[0];
    expect(cp.mission_id).toBe(m.missionId);
    expect((cp.unsettled_executions as string[])).toContain(eid);
    expect((cp.reconciliation_receipt_ids as string[]).length).toBe(1);
    // idempotent: same entity id, version bump
    const cps2 = ctx.recovery.planRestartRecovery((execId) =>
      ctx.recon.reconcile({ execution_id: execId, mission_id: m.missionId }),
    );
    expect(cps2[0].checkpoint_id).toBe(cp.checkpoint_id);
    expect(Number(cps2[0].version)).toBeGreaterThanOrEqual(1);
  });
});

describe("P8 §36 — self-improvement governance", () => {
  it("40. transient/external failure classes can never open a candidate", () => {
    const ctx = makeCtx("t40");
    for (const cls of ["RATE_LIMITED", "AUTHENTICATION_FAILURE", "PERMISSION_DENIAL", "PROVIDER_UNAVAILABLE", "POLICY_DENIAL"]) {
      expect(() =>
        ctxSelfmod(ctx).observeWeakness({ weakness_class: cls, signature: `sig:${cls}`, evidence_refs: ["e"], description: "x" }),
      ).toThrow(/FAIL_CLOSED_SELFMOD_WEAKNESS_CLASS_EXCLUDED/);
    }
  });
});

/* ---- selfmod helper ctx ---- */
function ctxSelfmod(ctx: Ctx) {
  return new SelfImprovementController(ctx.service, {
    repoRoot: path.resolve(__dirname, "..", ".."),
    selfmodRoot: path.join(ctx.dir, "selfmod"),
    min_observations: 2,
  });
}

describe("P8 §36 — self-improvement lifecycle guards", () => {
  it("41. structural weakness observed → recurring evidence folds into one candidate", () => {
    const ctx = makeCtx("t41");
    const sm = ctxSelfmod(ctx);
    const c1 = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:normalize-x", evidence_refs: ["e1"], description: "normalize drops empty key" });
    const c2 = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:normalize-x", evidence_refs: ["e2"], description: "normalize drops empty key" });
    expect(c2.change_id).toBe(c1.change_id);
    expect(Number(c2.observation_count)).toBe(2);
    expect(ctx.store.list("selfmod_candidate")).toHaveLength(1);
  });

  it("42. hypothesis requires min observations of verified evidence", () => {
    const ctx = makeCtx("t42");
    const sm = ctxSelfmod(ctx);
    const c = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:y", evidence_refs: ["e1"], description: "x" });
    expect(() => sm.hypothesize(String(c.change_id), { summary: "s", proposed_change: "p", expected_effect: "e" }))
      .toThrow(/FAIL_CLOSED_SELFMOD_INSUFFICIENT_OBSERVATIONS/);
  });

  it("43. classifier marks authority files AUTHORITY_CHANGING — auto path blocked", () => {
    const { change_class } = classifyChangedFiles(["src/pair/gate.ts", "src/pair/recovery-controller.ts"]);
    expect(change_class).toBe("AUTHORITY_CHANGING");
    expect(classifyChangedFiles(["src/pair/experience-advisors.ts"]).change_class).toBe("BEHAVIORAL");
    expect(classifyChangedFiles(["docs/notes.md"]).change_class).toBe("SAFE_INTERNAL");
  });

  it("44. AUTHORITY_CHANGING patch fails the policy gate → REJECTED", () => {
    const ctx = makeCtx("t44");
    const sm = ctxSelfmod(ctx);
    const c = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:z", evidence_refs: ["e1", "e2"], description: "x" });
    const h = sm.hypothesize(String(c.change_id), { summary: "s", proposed_change: "p", expected_effect: "e" });
    sm.proposeChange(String(h.change_id), { intent: "i", target_files: ["src/pair/gate.ts"], approach: "a" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "..", ".."), encoding: "utf8" }).trim();
    const patched = sm.createIsolatedPatch(String(h.change_id), {
      parent_commit: head,
      generator: {
        generator_id: "GEN_A",
        apply: (wt) => {
          // malicious/broad patch: touches a protected authority file
          fs.writeFileSync(path.join(wt, "src/pair/gate.ts"), "// mutated\n" + fs.readFileSync(path.join(wt, "src/pair/gate.ts"), "utf8"));
          return { changed_files: ["src/pair/gate.ts"], summary: "touch gate" };
        },
      },
    });
    expect(patched.change_class).toBe("AUTHORITY_CHANGING");
    const after = sm.validate(String(patched.change_id), { run: () => ({ pass: true, detail: "ok" }) });
    expect(after.status).toBe("REJECTED");
    sm.rollback(String(after.change_id), "cleanup");
  });

  it("45. generator cannot be its own verifier", () => {
    const ctx = makeCtx("t45");
    const sm = ctxSelfmod(ctx);
    const c = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:w", evidence_refs: ["e1", "e2"], description: "x" });
    sm.hypothesize(String(c.change_id), { summary: "s", proposed_change: "p", expected_effect: "e" });
    sm.proposeChange(String(c.change_id), { intent: "i", target_files: ["docs/p8.md"], approach: "a" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "..", ".."), encoding: "utf8" }).trim();
    const patched = sm.createIsolatedPatch(String(c.change_id), {
      parent_commit: head,
      generator: { generator_id: "GEN_A", apply: (wt) => { fs.mkdirSync(path.join(wt, "docs"), { recursive: true }); fs.writeFileSync(path.join(wt, "docs/p8-fixture.md"), "fix\n"); return { changed_files: ["docs/p8-fixture.md"], summary: "doc fix" }; } },
    });
    sm.validate(String(patched.change_id), { run: () => ({ pass: true, detail: "ok" }) });
    expect(() => sm.independentVerify(String(patched.change_id), { verifier_id: "GEN_A", result: "PASS" }))
      .toThrow(/FAIL_CLOSED_SELFMOD_SELF_VERIFICATION/);
    sm.rollback(String(patched.change_id), "cleanup");
  });

  it("46. rejected digest is never re-promotable", () => {
    const ctx = makeCtx("t46");
    const sm = ctxSelfmod(ctx);
    const c = sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:v", evidence_refs: ["e1", "e2"], description: "x" });
    sm.hypothesize(String(c.change_id), { summary: "s", proposed_change: "p", expected_effect: "e" });
    sm.proposeChange(String(c.change_id), { intent: "i", target_files: ["docs/p8.md"], approach: "a" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "..", ".."), encoding: "utf8" }).trim();
    const patched = sm.createIsolatedPatch(String(c.change_id), {
      parent_commit: head,
      generator: { generator_id: "GEN_A", apply: (wt) => { fs.mkdirSync(path.join(wt, "docs"), { recursive: true }); fs.writeFileSync(path.join(wt, "docs/p8-fixture2.md"), "fix\n"); return { changed_files: ["docs/p8-fixture2.md"], summary: "doc" }; } },
    });
    sm.validate(String(patched.change_id), { run: (step) => ({ pass: step !== "typecheck", detail: "fail" }) });
    expect(() =>
      sm.observeWeakness({ weakness_class: "INTERNAL_RUNTIME_DEFECT", signature: "sig:v", evidence_refs: ["e3"], description: "again" }),
    ).toThrow(/FAIL_CLOSED_SELFMOD_REJECTED_DIGEST/);
    sm.rollback(String(patched.change_id), "cleanup");
  });
});

/* ================================================================== */
/* §37 — controlled recovery E2E: real dispatch → failure → retry      */
/* ================================================================== */

describe("P8 §37 — controlled recovery E2E", () => {
  it("real governed dispatch fails TRANSIENT → RETRY decision → supersede → re-route → success, no duplicate side effects", () => {
    const ctx = makeCtx("e2e-recovery");
    // first dispatch fails transiently, retry succeeds
    const a = new ScriptedAdapter("EX_A", [
      { status: "FAILED", error_class: "ACP_TRANSPORT_CLOSED" },
      { status: "COMPLETED" },
    ]);
    registerScripted(ctx, a);
    const m = seedMission(ctx);

    const r1 = ctx.router.routeGovernedTask(requestFor(ctx, m), ctx.adapters);
    const gt1 = String(r1.governed_task.governed_task_id);
    const exec1 = ctx.gate.collect_execution_result(a, String(r1.execution.execution_id));
    expect(exec1.result_state).toBe("FAILED");

    const cls = classifyFailure({ result: exec1.result as Record<string, unknown>, execution_state: String(exec1.execution_state) });
    expect(cls).toBe("TRANSIENT_TRANSPORT");
    const decision = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], execution_id: String(exec1.execution_id),
      governed_task_id: gt1, executor_id: "EX_A", failure_class: cls,
      eligible_executors: ["EX_A"], correlation_id: "corr-p8-0",
    });
    expect(decision.selected_action).toBe("RETRY_SAME_ROUTE");

    // retry path: supersede dead binding → router re-runs all gates → fresh dispatch
    ctx.recovery.supersedeGovernedTask(gt1, String(decision.recovery_id));
    const r2 = ctx.router.routeGovernedTask(requestFor(ctx, m), ctx.adapters);
    expect(r2.adopted).toBe(false);
    const exec2 = ctx.gate.collect_execution_result(a, String(r2.execution.execution_id));
    expect(exec2.result_state).toBe("COMPLETED");

    // exactly two distinct governed tasks + two executions; evidence complete
    const gts = ctx.store.list("governed_task").filter((g) => g.task_id === m.taskIds[0]);
    expect(gts).toHaveLength(2);
    const execs = ctx.store.list("executor_execution").filter((e) => e.task_id === m.taskIds[0]);
    expect(execs).toHaveLength(2);
    expect(a.dispatched).toHaveLength(2);
  });
});

/* ================================================================== */
/* §38 — controlled remediation E2E                                     */
/* ================================================================== */

describe("P8 §38 — controlled remediation E2E", () => {
  it("verified remediation executes as governed task → REMEDIATION_SUCCEEDED → retry allowed", () => {
    const ctx = makeCtx("e2e-remediation");
    const a = new ScriptedAdapter("EX_A", [{ status: "COMPLETED" }, { status: "COMPLETED" }]);
    registerScripted(ctx, a);
    const m = seedMission(ctx);
    const expId = seedActiveRemediation(ctx, { executors: ["EX_A"] });

    const decision = ctx.recovery.decide({
      mission_id: m.missionId, task_id: m.taskIds[0], failure_class: "ARTIFACT_VALIDATION_FAILURE",
      executor_id: "EX_A", verified_remediation_ids: [expId],
    });
    expect(decision.selected_action).toBe("APPLY_VERIFIED_REMEDIATION");

    const { remediation_execution_id, request } = ctx.recovery.proposeRemediationTask({
      mission_id: m.missionId, parent_task_id: m.taskIds[0], recovery_id: String(decision.recovery_id),
      experience_id: expId, task_instruction: "rebuild artifact provenance", workspace: ctx.workspace,
      permissions: ["FILE_WRITE"], required_capabilities: ["FILE_OPERATIONS"], plan_revision: m.revision,
    });
    const taskId = addTask(ctx, m, "REM1", ["FILE_OPERATIONS"]);
    const routed = ctx.router.routeGovernedTask({ ...request, task_id: taskId }, ctx.adapters);
    ctx.recovery.bindRemediationExecution(remediation_execution_id, String(routed.governed_task.governed_task_id), String(routed.execution.execution_id));
    const remExec = ctx.gate.collect_execution_result(a, String(routed.execution.execution_id));
    const outcome = ctx.recovery.evaluateRemediationOutcome(remediation_execution_id, String(remExec.result_state));
    expect(outcome.state).toBe("REMEDIATION_SUCCEEDED");

    // remediation evidence chain complete
    const rec = ctx.store.get("remediation_execution", remediation_execution_id);
    expect(rec.experience_id).toBe(expId);
    expect(rec.execution_id).toBe(String(routed.execution.execution_id));
  });
});

/* ================================================================== */
/* §39 — self-improvement E2E (isolated worktree, STOP before merge)   */
/* ================================================================== */

describe("P8 §39 — self-improvement E2E", () => {
  it("defect fixture → isolated patch → validation → independent verify → promotion candidate (never merged)", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const ctx = makeCtx("e2e-selfmod");
    const sm = ctxSelfmod(ctx);

    const c = sm.observeWeakness({
      weakness_class: "INTERNAL_RUNTIME_DEFECT",
      signature: "sig:doc-placeholder",
      evidence_refs: ["exec-1", "exec-2"],
      description: "fixture doc missing for p8 e2e",
    });
    sm.hypothesize(String(c.change_id), {
      summary: "add fixture doc",
      proposed_change: "create docs/p8-selfmod-fixture.md",
      expected_effect: "docs complete",
    });
    sm.proposeChange(String(c.change_id), { intent: "doc completeness", target_files: ["docs/p8-selfmod-fixture.md"], approach: "add file" });

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const patched = sm.createIsolatedPatch(String(c.change_id), {
      parent_commit: head,
      generator: {
        generator_id: "GEN_FIXTURE",
        apply: (wt) => {
          const p = path.join(wt, "docs/p8-selfmod-fixture.md");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, "# p8 selfmod fixture\n");
          return { changed_files: ["docs/p8-selfmod-fixture.md"], summary: "add fixture doc" };
        },
      },
    });
    expect(patched.change_class).toBe("SAFE_INTERNAL");
    expect(patched.parent_commit).toBe(head);
    // canonical repo untouched
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    expect(status).not.toContain("p8-selfmod-fixture");
    expect(fs.existsSync(String(patched.worktree_path))).toBe(true);

    // deterministic validation runner executing real checks in the worktree
    const runner = {
      run: (step: string, wt: string) => {
        switch (step) {
          case "typecheck":
          case "focused_regression":
          case "full_deterministic_regression": {
            const diffCheck = execFileSync("git", ["-C", wt, "diff", "--check", "HEAD~1"], { encoding: "utf8" });
            return { pass: diffCheck.trim() === "", detail: diffCheck.trim() || "clean" };
          }
          case "security_invariants":
          case "governance_invariants": {
            const files = execFileSync("git", ["-C", wt, "diff", "--name-only", "HEAD~1"], { encoding: "utf8" }).trim().split("\n");
            const { change_class } = classifyChangedFiles(files);
            return { pass: change_class === "SAFE_INTERNAL" || change_class === "BEHAVIORAL", detail: change_class };
          }
          case "credential_leak_scan": {
            const diff = execFileSync("git", ["-C", wt, "diff", "HEAD~1"], { encoding: "utf8" });
            const leak = /api[_-]?key|secret|password|token|sk-[a-z0-9]/i.test(diff);
            return { pass: !leak, detail: leak ? "SECRET_PATTERN" : "clean" };
          }
          default:
            return { pass: false, detail: `unknown step ${step}` };
        }
      },
    };
    const validated = sm.validate(String(patched.change_id), runner);
    expect(validated.status).toBe("VALIDATION");
    expect(validated.validation_pass).toBe(true);

    const verified = sm.independentVerify(String(validated.change_id), { verifier_id: "PAIR_DETERMINISTIC_VERIFIER", result: "PASS" });
    expect(verified.status).toBe("INDEPENDENT_VERIFICATION");

    const promo = sm.createPromotionCandidate(String(verified.change_id));
    expect(promo.approval_required).toBe(true);
    expect(promo.merged).toBe(false);
    expect(promo.rollback_ref).toBe(head);
    expect(promo.promotion_digest).toMatch(/^[0-9a-f]{64}$/);

    // STOP before merge: canonical repo must still not contain the file
    const status2 = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    expect(status2).not.toContain("p8-selfmod-fixture");
    sm.rollback(String(verified.change_id), "e2e cleanup");
    expect(fs.existsSync(String(patched.worktree_path))).toBe(false);
    const rolled = ctx.store.get("selfmod_candidate", String(patched.change_id));
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.rollback).toBeTruthy();
  });
});
