/**
 * F3 — duplicate replan suppression + structured dependency failure
 * context + bounded replan candidates (permanent suite).
 *
 *   C   failure context contract (pending_recovery + decision + taxonomy)
 *   D   duplicate rejection + bounded 2-candidate budget + acceptance
 *   E   restart: durable ledger / pending context / bounded resume
 *   §42 raw proposal vs semantic digest authority
 *   §43 planner replan_context contract
 *   §44 recovery-authority: REPLAN → infeasible → next matrix action
 *   §45 no remote spend on rejected candidates
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import type { RuntimePlannerInput } from "../pair/mission-runtime.js";
import {
  ApprovalQueue,
  canonicalPlanSemanticDigest,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  ReplanAttemptLedger,
  IntegrityError,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f3-rc-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const REMOTE = "REMOTE_CLOUD_TASK_EXECUTION";
const FAR = "2999-01-01T00:00:00Z";
function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  script: Array<{ status: string; error_class?: string }>;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string, script: Array<{ status: string; error_class?: string }> = [], caps: string[] = ["FILE_OPERATIONS"]) {
    this.executor_id = id;
    this.script = [...script];
    this.caps = caps;
  }
  probe() { return { executor_id: this.executor_id, available: true, state: "READY" }; }
  qualify() { return { qualified: true, dispatch_enabled: true }; }
  capabilities() { return { capability_ids: this.caps }; }
  prepare_task(task: Record<string, unknown>) { return task; }
  dispatch(task: Record<string, unknown>) {
    const step = this.script.length ? this.script.shift()! : { status: "COMPLETED" };
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] =
      step.status === "FAILED"
        ? { status: "FAILED", mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, error: { class: step.error_class ?? "RATE_LIMITED", message: step.error_class ?? "failed" } }
        : { status: step.status, mission_id: task.mission_id, task_id: task.task_id, governed_task_id: task.governed_task_id, summary: "ok" };
    return { execution_id: eid, status: step.status, run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() { return { status: "CANCELLED" }; }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() { return []; }
  health() { return { state: "READY" }; }
}

const df = (produces: string[] = [], consumes: string[] = []) => ({
  pair_dataflow: { produces, consumes },
});
const task = (
  key: string,
  caps: string[],
  deps: string[],
  instruction: string,
  metadata: Record<string, unknown> = {},
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on: deps,
  metadata,
});

/** The incident shape: local T1 declares produces "x.txt" but never emits
 *  canonical bytes; remote T2 consumes it → dispatch-time DEPENDENCY_FAILURE
 *  (REMOTE_CONSUMER_ARTIFACT_MISSING), zero remote spend. */
const incidentPlan = () => ({
  tasks: [
    task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"])),
    task("T2", [REMOTE], ["T1"], "read x.txt remotely", df([], ["x.txt"])),
  ],
});
const altPlan = () => ({
  tasks: [task("T1", ["FILE_OPERATIONS"], [], "write summary.txt standalone", df(["summary.txt"]))],
});

interface PlannerCall {
  reason: string;
  replan_context?: RuntimePlannerInput["replan_context"];
  superseded_tasks?: Array<Record<string, unknown>>;
}
function makeCtx(
  name: string,
  planFn: (call: PlannerCall) => { tasks: Array<Record<string, unknown>> },
) {
  const d = dir(name);
  const dbPath = path.join(d, "pair.db");
  const workspace = fs.mkdtempSync(path.join(d, "ws-"));
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const calls: PlannerCall[] = [];
  const planner = (input: RuntimePlannerInput) => {
    calls.push({
      reason: input.reason,
      replan_context: input.replan_context,
      superseded_tasks: input.superseded_tasks,
    });
    return planFn({ reason: input.reason, replan_context: input.replan_context });
  };
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service), planner,
  });
  for (const c of ["FILE_OPERATIONS", "REASONING", REMOTE]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: workspace });
  const registerAdapter = (adapter: ExecutorAdapter, caps: string[]) => {
    registry.register({
      executor_id: adapter.executor_id,
      executor_type: "EXTERNAL",
      capabilities: caps,
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        routing_priority: 50,
        transport_type: TRANSPORT_IN_PROCESS,
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        supports_cancel: true,
        max_concurrency: 4,
      },
    });
    const routeId = `RTE_${adapter.executor_id}`;
    service.routes.registerRoute({
      route_id: routeId,
      route_kind: "IN_PROCESS_RUNTIME",
      enabled: true,
      eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED",
      direct_callable: true,
      capabilities: caps,
      priority: 50,
      executor_hint: adapter.executor_id,
    });
    service.routes.registerBinding({
      executor_id: adapter.executor_id,
      route_id: routeId,
      mechanism: "SPAWN_ENV",
      qualification_state: "QUALIFIED",
      capabilities: caps,
    });
    adapters.set(adapter.executor_id, adapter);
  };
  const projectId = String(project.project_id);
  const projectIdRef = projectId;
  const startMission = () => {
    const m = control.startMission({
      project_id: projectId,
      goal: "f3 test mission",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
    });
    return String(m.mission_id);
  };
  const rt = (mid: string) => store.get("mission_runtime", `MRT_${mid}`);
  const decisions = (mid: string) =>
    store.list("recovery_decision").filter((x) => x.mission_id === mid);
  const drive = (mid: string, max = 60) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      const s = String(rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s)) return s;
    }
    return String(rt(mid).state);
  };
  return {
    d, dbPath, workspace, store, service, gate, registry, router, recovery,
    recon, approvals, scheduler, runtime, control, adapters, calls,
    registerAdapter, startMission, rt, decisions, drive,
    projectId: projectIdRef,
  };
}

/* ============================== C — failure context =================== */

describe("F3 C — structured dependency failure context", () => {
  it("C1+C2+C6. DEPENDENCY_FAILURE persists typed failure_context on decision + pending_recovery", () => {
    const ctx = makeCtx("c1", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const clock = fakeClock();
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid, clock());
      if (String(ctx.rt(mid).state) === "REPLANNING") break;
    }
    // pending_recovery carries the SAME context while the chain is live.
    const rtRow = ctx.rt(mid) as Record<string, unknown>;
    const pend = rtRow.pending_recovery as Record<string, unknown>;
    expect((pend.failure_context as Record<string, unknown>).dependency_reason).toBe(
      "REMOTE_CONSUMER_ARTIFACT_MISSING",
    );
    ctx.drive(mid);
    const [d1] = ctx.decisions(mid);
    expect(d1).toBeTruthy();
    expect(d1.selected_action).toBe("REPLAN");
    const fc = d1.failure_context as Record<string, unknown>;
    expect(fc.contract).toBe("pair-recovery-failure-context.v1");
    expect(fc.failure_class).toBe("DEPENDENCY_FAILURE");
    expect(fc.dependency_reason).toBe("REMOTE_CONSUMER_ARTIFACT_MISSING");
    expect(fc.artifact_name).toBe("x.txt");
    expect(fc.plan_semantic_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(String(fc.task_key)).toBe("T2");
    expect(fc.producer_task_id).toBeTruthy();
    expect(fc.source_code).toBe("FAIL_CLOSED_DEPENDENCY_RESOLUTION");
    // bounded fields only — no stack/path/prose.
    for (const v of Object.values(fc)) {
      expect(String(v)).not.toMatch(/\/home\/|workspace|Error:|at /);
    }
  });

  it("C3. signature binds the root cause — structured ctx adds ::rc_ suffix; same failure+plan → same signature", () => {
    const ctx = makeCtx("c3", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const sigs = ctx.decisions(mid).map((d) => String(d.failure_signature));
    expect(sigs[0]).toMatch(/DEPENDENCY_FAILURE::.*::rc_[0-9a-f]{16}$/);
    // The exhaustion re-decision chains off the SAME root cause.
    expect(new Set(sigs).size).toBe(1);
  });

  it("C5. LOCAL_PREREQUISITE_MISSING context on the missing-workspace-artifact path", () => {
    // Local consumer T2 consumes a.txt — T1 declares produces but the file
    // is absent at dispatch: LOCAL_PREREQUISITE_MISSING.
    const plan = () => ({
      tasks: [
        task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
        task("T2", ["FILE_OPERATIONS"], ["T1"], "read a.txt", df([], ["a.txt"])),
      ],
    });
    const ctx = makeCtx("c5", () => plan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid, 12);
    const fc = ctx.decisions(mid)[0].failure_context as Record<string, unknown>;
    expect(fc.dependency_reason).toBe("LOCAL_PREREQUISITE_MISSING");
    expect(fc.artifact_name).toBe("a.txt");
  });

  it("C8. non-structured failure keeps the LEGACY signature (no ::rc_ suffix)", () => {
    const plan = () => ({
      tasks: [task("T1", ["FILE_OPERATIONS"], [], "do work", df())],
    });
    const ctx = makeCtx("c8", () => plan());
    ctx.registerAdapter(
      new ScriptedAdapter("EX_LOCAL", [{ status: "FAILED", error_class: "RATE_LIMITED" }]),
      ["FILE_OPERATIONS"],
    );
    const mid = ctx.startMission();
    for (let i = 0; i < 8; i++) ctx.runtime.tick(mid, "2026-01-01T00:00:00Z");
    const [d1] = ctx.decisions(mid);
    expect(String(d1.failure_signature)).not.toContain("::rc_");
    const fc = d1.failure_context as Record<string, unknown>;
    expect(fc.contract).toBe("pair-recovery-failure-context.v1");
    expect(fc.dependency_reason).toBeNull();
  });
});

/* ============================== D — duplicate suppression ============= */

describe("F3 D — bounded replan candidates", () => {
  it("D1+D2+D3+D4+D5+§44. same-plan replan ×2 → exhausted → fresh decision → ABORT (DEPENDENCY_FAILURE)", () => {
    const ctx = makeCtx("d1", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const state = ctx.drive(mid);
    expect(state).toBe("ABORTED");
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((a) => a.mission_id === mid)
      .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));
    expect(attempts).toHaveLength(2);
    for (const [i, a] of attempts.entries()) {
      expect(a.status).toBe("REJECTED_DUPLICATE");
      expect(a.attempt_index).toBe(i);
      expect(a.rejection_reason).toBe("PLAN_SEMANTIC_DUPLICATE");
      expect(a.candidate_plan_semantic_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(a.failed_plan_semantic_digest).toBe(a.candidate_plan_semantic_digest);
      expect(a.contract).toBe("pair-replan-attempt.v1");
    }
    // Rejected proposals are NOT plan revisions.
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    // §44 — the recovery_decision chain is the authority: REPLAN then a
    // FRESH decision that rejects REPLAN as infeasible and aborts.
    const [d1, d2] = ctx.decisions(mid);
    expect(d1.selected_action).toBe("REPLAN");
    expect(d2.selected_action).toBe("ABORT");
    const rej = (d2.rejected_actions as Array<{ action: string; reason: string }>).find(
      (r) => r.action === "REPLAN",
    );
    expect(rej?.reason).toContain("FAIL_CLOSED_REPLAN_CANDIDATES_EXHAUSTED");
    // §45 — zero remote spend: no execution row for the failed consumer,
    // and no execution minted by the rejected candidates.
    const tasks = ctx.service.listTasks(mid);
    const consumer = tasks.find((t) => t.task_key === "T2")!;
    const execs = ctx.store
      .list("executor_execution")
      .filter((e) => e.task_id === consumer.task_id);
    expect(execs).toHaveLength(0);
  });

  it("D6+§36. duplicate then ALTERNATIVE → Plan B commits exactly once", () => {
    let call = 0;
    const ctx = makeCtx("d6", ({ reason }) => {
      if (reason === "replan") {
        call += 1;
        return call === 1 ? incidentPlan() : altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const state = ctx.drive(mid);
    expect(state).toBe("COMPLETED");
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((a) => a.mission_id === mid)
      .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));
    expect(attempts.map((a) => a.status)).toEqual(["REJECTED_DUPLICATE", "ACCEPTED"]);
    // One new revision committed — exactly once.
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    expect(String(ctx.service.getMission(mid).plan_revision)).toBe("2");
  });

  it("§42. a DIFFERENT raw proposal with the same semantics is still a duplicate", () => {
    const variant = () => {
      const p = incidentPlan();
      // Same execution semantics, different raw shape — title noise +
      // junk metadata fields that carry no executor contract.
      p.tasks = p.tasks.map((t) => ({
        ...t,
        title: `renamed-${t.task_key}`,
        metadata: { ...(t.metadata as object), noise: "junk", planner_note: "v2" },
      }));
      return p;
    };
    const ctx = makeCtx("s42", ({ reason }) => (reason === "replan" ? variant() : incidentPlan()));
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const [a] = ctx.store.list("replan_attempt").filter((x) => x.mission_id === mid);
    expect(a.status).toBe("REJECTED_DUPLICATE");
    // proposal_digest (raw) differs from the failed plan's raw digest —
    // semantic digest is the authority that caught the re-emission.
    expect(a.proposal_digest).not.toBe(a.candidate_plan_semantic_digest);
  });

  it("§43. second candidate request carries the rejected digest + failure context", () => {
    const ctx = makeCtx("s43", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const replanCalls = ctx.calls.filter((c) => c.reason === "replan");
    expect(replanCalls).toHaveLength(2);
    const [c1, c2] = replanCalls;
    const rc1 = c1.replan_context!;
    expect(rc1.recovery_id).toBeTruthy();
    expect(rc1.failure_class).toBe("DEPENDENCY_FAILURE");
    expect(rc1.dependency_reason).toBe("REMOTE_CONSUMER_ARTIFACT_MISSING");
    expect(rc1.failed_task_key).toBe("T2");
    expect(rc1.failed_plan_semantic_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rc1.rejected_semantic_digests).toEqual([]);
    expect(c2.replan_context!.rejected_semantic_digests).toEqual([
      rc1.failed_plan_semantic_digest,
    ]);
  });

  it("D8. infeasible candidate consumes a slot — REJECTED_FEASIBILITY persisted, no commit", () => {
    const infeasible = () => ({
      tasks: [
        task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
        task("T2", ["FILE_OPERATIONS"], ["T1"], "read z.txt", df([], ["z.txt"])),
      ],
    });
    let call = 0;
    const ctx = makeCtx("d8", ({ reason }) => {
      if (reason === "replan") {
        call += 1;
        return call === 1 ? infeasible() : altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((a) => a.mission_id === mid)
      .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));
    expect(attempts.map((a) => a.status)).toEqual(["REJECTED_FEASIBILITY", "ACCEPTED"]);
    expect(String(attempts[0].rejection_reason)).toMatch(/PLAN_DATAFLOW|PLAN_FEASIBILITY/);
  });
});

/* ============================== E — restart =========================== */

describe("F3 E — restart durability", () => {
  it("E1+E2. rejected ledger + budget survive a store reopen — slot idempotent", () => {
    const d = dir("e1");
    const dbPath = path.join(d, "pair.db");
    const s1 = new PairEvidenceStore(dbPath);
    const l1 = new ReplanAttemptLedger(s1);
    l1.record({
      mission_id: "M1", recovery_id: "RCV_1", attempt_index: 0,
      proposal_digest: "p0", candidate_plan_semantic_digest: "d0",
      status: "REJECTED_DUPLICATE", rejection_reason: "PLAN_SEMANTIC_DUPLICATE",
      failed_plan_semantic_digest: "d0",
    });
    s1.close();
    const s2 = new PairEvidenceStore(dbPath);
    const l2 = new ReplanAttemptLedger(s2);
    expect(l2.attemptsUsed("RCV_1")).toBe(1);
    expect(l2.rejectedCandidateDigests("RCV_1")).toEqual(["d0"]);
    // Slot replay converges (same content) and conflicts fail closed.
    const same = l2.record({
      mission_id: "M1", recovery_id: "RCV_1", attempt_index: 0,
      proposal_digest: "p0", candidate_plan_semantic_digest: "d0",
      status: "REJECTED_DUPLICATE", rejection_reason: "PLAN_SEMANTIC_DUPLICATE",
      failed_plan_semantic_digest: "d0",
    });
    expect(same.replan_attempt_id).toBeTruthy();
    expect(l2.attemptsUsed("RCV_1")).toBe(1);
    expect(() =>
      l2.record({
        mission_id: "M1", recovery_id: "RCV_1", attempt_index: 0,
        candidate_plan_semantic_digest: "DIFFERENT",
        status: "ACCEPTED",
      }),
    ).toThrowError(IntegrityError);
    s2.close();
  });

  it("E3+E4. restart between decision and runReplan — pending context + bounded budget preserved", () => {
    const ctx = makeCtx("e3", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const clock = fakeClock();
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid, clock());
      if (String(ctx.rt(mid).state) === "REPLANNING") break;
    }
    expect(String(ctx.rt(mid).state)).toBe("REPLANNING");
    const decisionCtx = (ctx.decisions(mid)[0].failure_context ?? null) as Record<string, unknown> | null;
    expect(decisionCtx?.dependency_reason).toBe("REMOTE_CONSUMER_ARTIFACT_MISSING");
    ctx.store.close();

    // Restart: reopen the SAME durable store, rebuild every dep, tick on.
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const recon2 = new ReconciliationService(service2, new Map());
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const recovery2 = new RecoveryController(service2);
    const calls2: PlannerCall[] = [];
    const planner2 = (input: RuntimePlannerInput) => {
      calls2.push({ reason: input.reason, replan_context: input.replan_context });
      return incidentPlan();
    };
    const runtime2 = new MissionRuntime({
      service: service2, gate: gate2, router: new MissionRouter(service2, gate2),
      adapters: ctx.adapters, scheduler: scheduler2, approvals: approvals2,
      reconciliation: recon2, recovery: recovery2, planner: planner2,
    });
    // pending_recovery.failure_context survived the restart.
    const rtRow = store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;
    const pend = rtRow.pending_recovery as Record<string, unknown>;
    expect((pend.failure_context as Record<string, unknown>).dependency_reason).toBe(
      "REMOTE_CONSUMER_ARTIFACT_MISSING",
    );
    for (let i = 0; i < 40; i++) {
      runtime2.tick(mid, clock());
      if (String(store2.get("mission_runtime", `MRT_${mid}`).state) === "ABORTED") break;
    }
    expect(String(store2.get("mission_runtime", `MRT_${mid}`).state)).toBe("ABORTED");
    // Bounded: exactly 2 candidates, exactly 2 planner invocations.
    const attempts = store2.list("replan_attempt").filter((a) => a.mission_id === mid);
    expect(attempts).toHaveLength(2);
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(2);
    // Same deterministic plan + same failure → SAME signature across restart.
    const decs = store2.list("recovery_decision").filter((x) => x.mission_id === mid);
    expect(new Set(decs.map((x) => String(x.failure_signature))).size).toBe(1);
    store2.close();
  });
});

/* ================== C1/C2 — typed reasons via resolver seam =========== */
// Unbound consumes and ambiguous producers are rejected at PLAN COMMIT
// (assertPlanArtifactStructure), so the resolver's typed reasons are the
// defense-in-depth seam reachable from row mutation / pre-commit legacy
// plans — prove the taxonomy end-to-end through
// DependencyResolutionError.dependency_reason → failure context.
describe("F3 C — typed dependency_reason taxonomy", () => {
  const mkMission = (
    ctx: ReturnType<typeof makeCtx>,
    planTasks: Array<Record<string, unknown>>,
  ) => {
    const mission = ctx.service.createMission({
      project_id: ctx.projectId,
      goal: "resolver seam",
      granted_permissions: ["FILE_WRITE"],
      authorized_workspaces: [ctx.workspace],
    });
    ctx.service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: planTasks,
      source: "TEST",
      proposal: { tasks: planTasks },
    });
    return ctx.service.getMission(String(mission.mission_id));
  };

  it("C1. unbound consume → PLAN_DATAFLOW_UNBOUND typed reason", () => {
    const ctx = makeCtx("c-unbound", () => ({ tasks: [] }));
    const mission = mkMission(ctx, [
      task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"])),
    ]);
    const planId = String(mission.plan_id);
    const consumer = {
      task_id: "TSK_SYNTH",
      task_key: "TC",
      plan_id: planId,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: ["T1"],
      metadata: df([], ["ghost.txt"]),
    };
    try {
      ctx.service.artifactResolver.resolveForConsumer({
        mission,
        task: consumer,
      });
      expect.unreachable();
    } catch (err) {
      const e = err as { code?: string; dependency_reason?: string };
      expect(e.code).toBe("FAIL_CLOSED_DEPENDENCY_RESOLUTION");
      expect(e.dependency_reason).toBe("PLAN_DATAFLOW_UNBOUND");
    }
  });

  it("C2. ambiguous producer → PLAN_DATAFLOW_AMBIGUOUS typed reason", () => {
    const ctx = makeCtx("c-ambig", () => ({ tasks: [] }));
    // Two producers emitting the same artifact name is legal while
    // NOTHING consumes it — only a consume makes the ambiguity real.
    const mission = mkMission(ctx, [
      task("T1", ["FILE_OPERATIONS"], [], "write x.txt", df(["x.txt"])),
      task("T2", ["FILE_OPERATIONS"], [], "write x.txt too", df(["x.txt"])),
    ]);
    const planId = String(mission.plan_id);
    const consumer = {
      task_id: "TSK_SYNTH",
      task_key: "TC",
      plan_id: planId,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: ["T1", "T2"],
      metadata: df([], ["x.txt"]),
    };
    try {
      ctx.service.artifactResolver.resolveForConsumer({
        mission,
        task: consumer,
      });
      expect.unreachable();
    } catch (err) {
      const e = err as { code?: string; dependency_reason?: string };
      expect(e.dependency_reason).toBe("PLAN_DATAFLOW_AMBIGUOUS");
    }
  });
});

/* ================== D3/D4 — rejection ordering proof ================= */
describe("F3 D — rejection precedes mutation", () => {
  it("D3+D4. duplicate rejection BEFORE old tasks cancelled; approvals untouched", () => {
    const ctx = makeCtx("d34", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const clock = fakeClock();
    for (let i = 0; i < 40; i++) {
      ctx.runtime.tick(mid, clock());
      if (String(ctx.rt(mid).state) === "REPLANNING") break;
    }
    const approvalsBefore = ctx.store.list("approval").length;
    // One tick evaluates a candidate — rejection lands BEFORE any plan
    // mutation: tasks stay in their pre-rejection state on that tick.
    ctx.runtime.tick(mid, clock());
    const attempts = ctx.store.list("replan_attempt").filter((a) => a.mission_id === mid);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0].status).toBe("REJECTED_DUPLICATE");
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const tasksNow = ctx.service.listTasks(mid);
    // Rejected candidates never cancel/supersede the old plan.
    for (const t of tasksNow) {
      expect(String(t.status)).not.toBe("CANCELLED");
      expect(String(t.status)).not.toBe("SUPERSEDED");
    }
    // Approvals supersede only fires on ACCEPT — untouched by rejections.
    expect(ctx.store.list("approval").length).toBe(approvalsBefore);
    ctx.drive(mid);
    expect(String(ctx.rt(mid).state)).toBe("ABORTED");
  });

  it("D7. schema-invalid candidate → REJECTED_INVALID, budget still bounded", () => {
    let call = 0;
    const ctx = makeCtx("d7", ({ reason }) => {
      if (reason === "replan") {
        call += 1;
        if (call === 1) return { tasks: [{ title: "no key" }] } as never;
        return altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const attempts = ctx.store
      .list("replan_attempt")
      .filter((a) => a.mission_id === mid)
      .sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index));
    expect(attempts.map((a) => a.status)).toEqual(["REJECTED_INVALID", "ACCEPTED"]);
    expect(String(attempts[0].rejection_reason)).toMatch(/^FAIL_CLOSED_/);
    // §47 — the accepted revision persists BOTH digests.
    const revs = ctx.store.planRevisions(mid);
    const last = revs[revs.length - 1];
    expect(String(last.plan_semantic_digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(last.proposal_digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(last.proposal_digest).not.toBe(last.plan_semantic_digest);
  });
});

/* ================== C7 + §43 evidence binding ======================== */
describe("F3 §43+§47 — failure context + revision evidence binding", () => {
  it("C7+§43. planner replan_context carries decision signature + superseded tasks; §47 both digests on revision", () => {
    const ctx = makeCtx("s43b", () => incidentPlan());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.drive(mid);
    const [d1] = ctx.decisions(mid);
    const calls = ctx.calls.filter((c) => c.reason === "replan");
    const rc1 = calls[0].replan_context!;
    // The planner sees the DECISION's signature — the same root cause.
    expect(rc1.failure_signature).toBe(String(d1.failure_signature));
    // superseded_tasks = the committed rows of the failed plan.
    expect(calls[0].superseded_tasks).toHaveLength(2);
    expect(calls[0].superseded_tasks!.map((t) => String(t.task_key))).toEqual(["T1", "T2"]);
    // §47 — revision 1 carries both digests.
    const rev = ctx.store.planRevisions(mid)[0];
    expect(String(rev.proposal_digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(rev.plan_semantic_digest)).toMatch(/^[0-9a-f]{64}$/);
    // §48 — attempt rows bind mission/recovery/failed/candidate digests.
    const att = ctx.store.list("replan_attempt").filter((a) => a.mission_id === mid)[0];
    expect(att.recovery_id).toBe(String(d1.recovery_id));
    expect(att.failed_plan_semantic_digest).toBe(
      (d1.failure_context as Record<string, unknown>).plan_semantic_digest,
    );
    expect(String(att.failure_signature)).toBe(String(d1.failure_signature));
  });
});

/* ================== E4 — restart post-accept ======================== */
describe("F3 E — restart after accepted replan", () => {
  it("E4. restart after Plan B commits → no second commit, no new attempt", () => {
    let call = 0;
    const ctx = makeCtx("e4", ({ reason }) => {
      if (reason === "replan") {
        call += 1;
        return call === 1 ? incidentPlan() : altPlan();
      }
      return incidentPlan();
    });
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL", [{ status: "COMPLETED" }, { status: "COMPLETED" }]), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    const clock = fakeClock();
    for (let i = 0; i < 60; i++) {
      ctx.runtime.tick(mid, clock());
      if (ctx.store.planRevisions(mid).length >= 2) break;
    }
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    const attemptsBefore = ctx.store.list("replan_attempt").filter((a) => a.mission_id === mid).length;
    ctx.store.close();
    // Reopen: ticking on the restarted store must not re-run replan or
    // re-commit Plan B.
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const service2 = new PairControlPlane(store2);
    const gate2 = new GovernedTaskGate(service2);
    const recon2 = new ReconciliationService(service2, new Map());
    const approvals2 = new ApprovalQueue(service2);
    const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
    const recovery2 = new RecoveryController(service2);
    const planner2 = (input: RuntimePlannerInput) => incidentPlan();
    const runtime2 = new MissionRuntime({
      service: service2, gate: gate2, router: new MissionRouter(service2, gate2),
      adapters: ctx.adapters, scheduler: scheduler2, approvals: approvals2,
      reconciliation: recon2, recovery: recovery2, planner: planner2,
    });
    for (let i = 0; i < 20; i++) runtime2.tick(mid, clock());
    expect(store2.planRevisions(mid)).toHaveLength(2);
    expect(
      store2.list("replan_attempt").filter((a) => a.mission_id === mid).length,
    ).toBe(attemptsBefore);
    // Old Plan A remote consumer NEVER redispatched.
    const t2s = service2.listTasks(mid).filter((t) => t.task_key === "T2");
    const oldT2 = t2s.find((t) => String(t.status) !== "READY") ?? t2s[0];
    expect(
      store2.list("executor_execution").filter((e) => e.task_id === oldT2?.task_id),
    ).toHaveLength(0);
    store2.close();
  });
});
