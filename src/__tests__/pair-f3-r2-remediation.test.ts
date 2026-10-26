/**
 * F3 R2 — FINAL REPLAN COMMIT-RECEIPT AUTHORITY CLOSURE.
 *
 * A semantic digest proves plan MEANING — never WHICH recovery / replan
 * attempt committed a revision. R1's digest-scan adoption is replaced by
 * exact attempt-bound commit identity (pair-replan-commit.v1 on the new
 * mission_plan_revision), exact receipt validation before ACCEPTED, an
 * in-transaction attempt re-read for concurrent resume, and a stronger
 * markCommitted replay contract binding plan_id+revision+semantic digest.
 *
 *   H1–H3 — historical same-digest revisions are NEVER adopted
 *   H4–H6 — exact commit / restart / bound-receipt convergence
 *   H7–H9 — receipt forgery rejected (wrong digest / other recovery /
 *           other attempt)
 *   H10   — concurrent resume: exactly one new revision
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import type {
  RuntimePlanner,
  RuntimePlannerInput,
} from "../pair/mission-runtime.js";
import {
  ApprovalQueue,
  assertReplanCommitReceipt,
  canonicalPlanSemanticDigest,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
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
  replanAttemptId,
  TRANSPORT_IN_PROCESS,
  type ReplanAttemptRecord,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-f3-r2-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
function fakeClock() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return () => new Date((t += 120_000)).toISOString();
}

class ScriptedAdapter implements ExecutorAdapter {
  executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string, caps: string[] = ["FILE_OPERATIONS"]) {
    this.executor_id = id;
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    this.collected[eid] = {
      status: "COMPLETED",
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      summary: "ok",
    };
    return {
      execution_id: eid,
      status: "COMPLETED",
      run_root: null,
      workspace: task.workspace,
    };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? {
      status: "FAILED",
      error: { class: "MISSING" },
    };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
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
const planB = () => ({
  tasks: [
    task("T1", ["FILE_OPERATIONS"], [], "write beta.txt standalone", df(["beta.txt"])),
  ],
});
const planA = () => ({
  tasks: [
    task("T1", ["FILE_OPERATIONS"], [], "write alpha.txt standalone", df(["alpha.txt"])),
  ],
});
const digestB = () =>
  canonicalPlanSemanticDigest(planB().tasks as never[]);

interface PlannerCall {
  reason: string;
  replan_context?: RuntimePlannerInput["replan_context"];
}

function makeCtx(name: string, planner: RuntimePlanner) {
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
  const wrapped: RuntimePlanner = (input) => {
    calls.push({ reason: input.reason, replan_context: input.replan_context });
    return planner(input);
  };
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner: wrapped,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service), planner: wrapped,
  });
  for (const c of ["FILE_OPERATIONS", "REASONING", "AUTOMATON_TASK_EXECUTION"]) {
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
    const routeId = `RTE_${adapter.executor_id}_${n}`;
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
  const startMission = () => {
    const m = control.startMission({
      project_id: String(project.project_id),
      goal: "f3 r2 test mission",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
    });
    return String(m.mission_id);
  };
  const rt = (mid: string) =>
    store.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>;
  const drive = (mid: string, max = 80) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      const s = String(rt(mid).state);
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s))
        return s;
    }
    return String(rt(mid).state);
  };
  const toReplanning = (mid: string) => {
    const clock = fakeClock();
    for (let i = 0; i < 60; i++) {
      runtime.tick(mid, clock());
      if (String(rt(mid).state) === "REPLANNING") return;
    }
    throw new Error(`never reached REPLANNING: ${String(rt(mid).state)}`);
  };
  /** tick until `pred` or throw */
  const tickUntil = (mid: string, pred: () => boolean, max = 40) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime.tick(mid, clock());
      if (pred()) return;
    }
    throw new Error(`predicate never satisfied; state=${String(rt(mid).state)}`);
  };
  const commitReplan = (mid: string, prepared: ReplanAttemptRecord) =>
    (
      runtime as unknown as {
        commitPreparedReplan(
          m: string,
          p: ReplanAttemptRecord,
          l: ReplanAttemptLedger,
        ): void;
      }
    ).commitPreparedReplan(mid, prepared, new ReplanAttemptLedger(store));
  return {
    d, dbPath, workspace, store, service, gate, registry, router, recovery,
    recon, approvals, scheduler, runtime, control, adapters, calls,
    registerAdapter, startMission, rt, drive, toReplanning, tickUntil,
    commitReplan,
    projectId: String(project.project_id),
  };
}

function rebuild(ctx: ReturnType<typeof makeCtx>, planner: RuntimePlanner) {
  const store2 = new PairEvidenceStore(ctx.dbPath);
  const service2 = new PairControlPlane(store2);
  const gate2 = new GovernedTaskGate(service2);
  const recon2 = new ReconciliationService(service2, new Map());
  const approvals2 = new ApprovalQueue(service2);
  const scheduler2 = new MissionScheduler(service2, { mission_concurrency: 2 });
  const recovery2 = new RecoveryController(service2);
  const calls2: PlannerCall[] = [];
  const wrapped: RuntimePlanner = (input) => {
    calls2.push({ reason: input.reason, replan_context: input.replan_context });
    return planner(input);
  };
  const runtime2 = new MissionRuntime({
    service: service2, gate: gate2, router: new MissionRouter(service2, gate2),
    adapters: ctx.adapters, scheduler: scheduler2, approvals: approvals2,
    reconciliation: recon2, recovery: recovery2, planner: wrapped,
  });
  const drive2 = (mid: string, max = 80) => {
    const clock = fakeClock();
    for (let i = 0; i < max; i++) {
      runtime2.tick(mid, clock());
      const s = String(
        (store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>).state,
      );
      if (["ABORTED", "FAILED", "COMPLETED", "WAITING_APPROVAL"].includes(s))
        return s;
    }
    return String(
      (store2.get("mission_runtime", `MRT_${mid}`) as Record<string, unknown>).state,
    );
  };
  return { store2, service2, runtime2, calls2, drive2 };
}

const attempts = (store: PairEvidenceStore, mid: string) =>
  (store.list("replan_attempt") as unknown as ReplanAttemptRecord[])
    .filter((a) => a.mission_id === mid)
    .sort((a, b) => a.attempt_index - b.attempt_index);

/** Invalidate the active plan's first task — the same persisted-mutation
 *  arm the incident suite uses (delivery verb in a non-delivery task). */
const invalidateActiveTask = (
  ctx: ReturnType<typeof makeCtx>,
  mid: string,
) => {
  const activePlanId = String(ctx.service.getMission(mid).plan_id);
  const t = ctx.service
    .listTasks(mid)
    .find((x) => String(x.plan_id) === activePlanId)!;
  ctx.service.updateTask(String(t.task_id), {
    task_instruction:
      `${String(t.task_instruction)} and send the report to Telegram`,
  });
  return t;
};

const mkPrepared = (
  ctx: ReturnType<typeof makeCtx>,
  mid: string,
  candidate: { tasks: Array<Record<string, unknown>> },
  attemptIndex = 0,
) => {
  const ledger = new ReplanAttemptLedger(ctx.store);
  const pend = ctx.rt(mid).pending_recovery as Record<string, unknown>;
  const recoveryId = String(pend.recovery_id);
  return ledger.record({
    mission_id: mid,
    recovery_id: recoveryId,
    failed_plan_semantic_digest: String(
      ctx.store.planRevisions(mid).at(-1)?.plan_semantic_digest,
    ),
    attempt_index: attemptIndex,
    proposal_digest: "test-prepared",
    candidate_plan_semantic_digest: canonicalPlanSemanticDigest(
      candidate.tasks as never[],
    ),
    prepared_tasks: candidate.tasks,
    prepared_proposal: candidate,
    superseded_plan_id: String(ctx.service.getMission(mid).plan_id),
    status: "PREPARED",
  });
};

/* ==================== H — commit-receipt authority ==================== */
describe("F3 R2 — commit receipt is attempt-bound, never digest-only", () => {
  it("H1. THE BUG — historical Plan B, active Plan A, replan proposes Plan B again → NEW revision 3, rev1 never adopted", () => {
    // initial plan = Plan B (rev1); replan candidate = Plan B again.
    const ctx = makeCtx("h1", () => planB());
    const adapter = new ScriptedAdapter("EX_LOCAL");
    ctx.registerAdapter(adapter, ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    // rev1 = Plan B committed through the normal initial-planning seam.
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    expect(ctx.store.planRevisions(mid)).toHaveLength(1);
    const rev1Digest = String(ctx.store.planRevisions(mid)[0].plan_semantic_digest);
    expect(rev1Digest).toBe(digestB());
    // rev2 = Plan A committed as the active plan.
    ctx.service.commitPlan({
      mission_id: mid,
      tasks: planA().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "manual-revision",
      proposal: planA(),
    });
    expect(ctx.store.planRevisions(mid)).toHaveLength(2);
    expect(String(ctx.service.getMission(mid).plan_id)).toBe(
      String(ctx.store.planRevisions(mid)[1].plan_id),
    );
    // Plan A's task is invalidated → PLAN_INVALIDATED → REPLAN →
    // candidate Plan B again (digest == rev1 digest).
    invalidateActiveTask(ctx, mid);
    expect(ctx.drive(mid)).toBe("COMPLETED");

    const revs = ctx.store.planRevisions(mid);
    expect(revs).toHaveLength(3);
    // The third revision is bound to THIS replan attempt — rev1 was
    // never adopted as a receipt.
    const at = attempts(ctx.store, mid);
    expect(at).toHaveLength(1);
    expect(at[0].status).toBe("ACCEPTED");
    const rc = revs[2].replan_commit as Record<string, unknown>;
    expect(String(rc.contract)).toBe("pair-replan-commit.v1");
    expect(String(rc.replan_attempt_id)).toBe(at[0].replan_attempt_id);
    expect(String(rc.recovery_id)).toBe(at[0].recovery_id);
    expect(String(revs[2].plan_semantic_digest)).toBe(digestB());
    // receipt names revision 3 — mission active on revision 3's plan.
    expect(Number(at[0].commit_receipt?.revision)).toBe(3);
    expect(String(at[0].commit_receipt?.plan_id)).toBe(String(revs[2].plan_id));
    expect(String(ctx.service.getMission(mid).plan_id)).toBe(String(revs[2].plan_id));
    // rev1 stays historical (no binding), rev2 tasks superseded.
    expect(revs[0].replan_commit).toBeUndefined();
    const rev2PlanId = String(revs[1].plan_id);
    for (const t of ctx.service.listTasks(mid)) {
      if (String(t.plan_id) === rev2PlanId)
        expect(String(t.status)).toBe("CANCELLED");
    }
    // The new tasks run under rev3's plan — mission completed on it.
    expect(
      ctx.service
        .listTasks(mid)
        .some((t) => String(t.plan_id) === String(revs[2].plan_id)),
    ).toBe(true);
  });

  it("H2. same-digest revision bound to ANOTHER recovery/attempt → ignored, exact candidate committed once", () => {
    const ctx = makeCtx("h2", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    // A revision already exists with the candidate's digest but bound to
    // a DIFFERENT recovery/attempt — it must not be adopted.
    ctx.service.commitPlan({
      mission_id: mid,
      tasks: planB().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: planB(),
      replan_commit: {
        recovery_id: "REC_FOREIGN",
        replan_attempt_id: "RPA_FOREIGN",
        superseded_plan_id: "PLN_FOREIGN",
      },
    });
    const before = ctx.store.planRevisions(mid).length;
    ctx.commitReplan(mid, prepared);
    const revs = ctx.store.planRevisions(mid);
    expect(revs).toHaveLength(before + 1);
    const bound = revs.at(-1)!;
    const rc = bound.replan_commit as Record<string, unknown>;
    expect(String(rc.replan_attempt_id)).toBe(prepared.replan_attempt_id);
    const after = attempts(ctx.store, mid)[0];
    expect(String(after.commit_receipt?.plan_id)).toBe(String(bound.plan_id));
    expect(Number(after.commit_receipt?.revision)).toBe(Number(bound.revision));
  });

  it("H3. MULTIPLE historical revisions sharing the candidate digest → none adopted", () => {
    const ctx = makeCtx("h3", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0); // rev1 = B
    ctx.service.commitPlan({
      mission_id: mid, tasks: planA().tasks,
      source: "AUTOMATON_PLANNER", reason: "manual", proposal: planA(),
    }); // rev2 = A
    ctx.service.commitPlan({
      mission_id: mid, tasks: planB().tasks,
      source: "AUTOMATON_PLANNER", reason: "manual", proposal: planB(),
    }); // rev3 = B (digest again)
    ctx.service.commitPlan({
      mission_id: mid, tasks: planA().tasks,
      source: "AUTOMATON_PLANNER", reason: "manual", proposal: planA(),
    }); // rev4 = A active
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    ctx.commitReplan(mid, prepared);
    const revs = ctx.store.planRevisions(mid);
    expect(revs).toHaveLength(5);
    const bound = revs.at(-1)!;
    const rc = bound.replan_commit as Record<string, unknown>;
    expect(String(rc.replan_attempt_id)).toBe(prepared.replan_attempt_id);
    // Neither rev1 nor rev3 was consumed as the receipt.
    const receipt = attempts(ctx.store, mid)[0].commit_receipt!;
    expect(Number(receipt.revision)).toBe(5);
  });

  it("H4. PREPARED with no commit binding → commit the exact candidate exactly once", () => {
    const ctx = makeCtx("h4", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    const before = ctx.store.planRevisions(mid).length;
    ctx.commitReplan(mid, prepared);
    const revs = ctx.store.planRevisions(mid);
    expect(revs).toHaveLength(before + 1);
    const at = attempts(ctx.store, mid)[0];
    expect(at.status).toBe("ACCEPTED");
    expect(String(at.commit_receipt?.plan_id)).toBe(String(revs.at(-1)!.plan_id));
    expect(
      String((revs.at(-1)!.replan_commit as Record<string, unknown>).replan_attempt_id),
    ).toBe(at.replan_attempt_id);
  });

  it("H5. restart with PREPARED → exact candidate committed once, ZERO planner calls", () => {
    const ctx = makeCtx("h5", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    mkPrepared(ctx, mid, planB());
    ctx.store.close();
    const { store2, calls2, drive2 } = rebuild(ctx, () => planA());
    expect(drive2(mid)).toBe("COMPLETED");
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    const revs = store2.planRevisions(mid);
    expect(revs).toHaveLength(2);
    const rc = revs[1].replan_commit as Record<string, unknown>;
    expect(String(rc.replan_attempt_id)).toBe(
      replanAttemptId(
        String(
          (attempts(store2, mid)[0] as ReplanAttemptRecord).recovery_id,
        ),
        0,
      ),
    );
    store2.close();
  });

  it("H6. exact attempt-bound revision + receipt exist → converge, ZERO second revision", () => {
    const ctx = makeCtx("h6", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    ctx.commitReplan(mid, prepared); // commits revision 2 + ACCEPTED receipt
    const count = ctx.store.planRevisions(mid).length;
    // A second "resume" of the same stale PREPARED snapshot: the attempt
    // re-read inside the txn sees ACCEPTED, verifies the bound receipt,
    // converges — no new revision, same receipt.
    ctx.commitReplan(mid, prepared);
    expect(ctx.store.planRevisions(mid)).toHaveLength(count);
    const at = attempts(ctx.store, mid)[0];
    expect(at.status).toBe("ACCEPTED");
    expect(Number(at.commit_receipt?.revision)).toBe(count);
  });

  it("H7. receipt same plan_id/revision but wrong semantic digest → FAIL_CLOSED (markCommitted)", () => {
    const ctx = makeCtx("h7", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    const ledger = new ReplanAttemptLedger(ctx.store);
    expect(() =>
      ledger.markCommitted(prepared.replan_attempt_id, {
        plan_id: "PLN_ANY",
        revision: 99,
        plan_semantic_digest: "deadbeef".repeat(8),
      }),
    ).toThrowError(/FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT/);
  });

  it("H8. ACCEPTED receipt names a revision bound to ANOTHER recovery → FAIL_CLOSED on converge", () => {
    const ctx = makeCtx("h8", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    // A revision bound to a different recovery, same candidate digest.
    const foreign = ctx.service.commitPlan({
      mission_id: mid,
      tasks: planB().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: planB(),
      replan_commit: {
        recovery_id: "REC_FOREIGN",
        replan_attempt_id: "RPA_FOREIGN",
        superseded_plan_id: "PLN_FOREIGN",
      },
    });
    // Forge an ACCEPTED receipt pointing at the foreign revision (digest
    // matches the candidate so markCommitted's digest check alone can't
    // catch it — the attempt-bound receipt proof must).
    const ledger = new ReplanAttemptLedger(ctx.store);
    ledger.markCommitted(prepared.replan_attempt_id, {
      plan_id: foreign.plan_id,
      revision: foreign.revision,
      plan_semantic_digest: digestB(),
    });
    const accepted = attempts(ctx.store, mid)[0];
    expect(accepted.status).toBe("ACCEPTED");
    expect(() => ctx.commitReplan(mid, accepted)).toThrowError(
      /FAIL_CLOSED_REPLAN_COMMIT_RECEIPT/,
    );
  });

  it("H9. receipt names a revision bound to ANOTHER attempt of the SAME recovery → FAIL_CLOSED", () => {
    const ctx = makeCtx("h9", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB(), 0);
    const pend = ctx.rt(mid).pending_recovery as Record<string, unknown>;
    const otherAttemptId = replanAttemptId(String(pend.recovery_id), 1);
    const foreign = ctx.service.commitPlan({
      mission_id: mid,
      tasks: planB().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: planB(),
      replan_commit: {
        recovery_id: String(pend.recovery_id),
        replan_attempt_id: otherAttemptId,
        superseded_plan_id: String(ctx.service.getMission(mid).plan_id),
      },
    });
    const ledger = new ReplanAttemptLedger(ctx.store);
    ledger.markCommitted(prepared.replan_attempt_id, {
      plan_id: foreign.plan_id,
      revision: foreign.revision,
      plan_semantic_digest: digestB(),
    });
    const accepted = attempts(ctx.store, mid)[0];
    expect(() => ctx.commitReplan(mid, accepted)).toThrowError(
      /FAIL_CLOSED_REPLAN_COMMIT_RECEIPT/,
    );
  });

  it("H10. two concurrent resumes of the same PREPARED attempt → exactly ONE new revision, same ACCEPTED receipt", () => {
    const ctx = makeCtx("h10", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    const before = ctx.store.planRevisions(mid).length;
    // "Process A" commits.
    ctx.commitReplan(mid, prepared);
    // "Process B" held the same stale PREPARED snapshot — the in-txn
    // re-read sees ACCEPTED, verifies the exact bound receipt, converges.
    ctx.commitReplan(mid, prepared);
    const revs = ctx.store.planRevisions(mid);
    expect(revs).toHaveLength(before + 1);
    const at = attempts(ctx.store, mid)[0];
    expect(at.status).toBe("ACCEPTED");
    expect(String(at.commit_receipt?.plan_id)).toBe(String(revs.at(-1)!.plan_id));
    expect(Number(at.commit_receipt?.revision)).toBe(before + 1);
  });
});


/* ============ F3 R3 — receipt self-consistency (3-way digest) ============ */
describe("F3 R3 — ACCEPTED receipt independently re-proven on resume", () => {
  /** Rewrite an attempt row through the CANONICAL store seam — valid
   *  entity hash + version — so only semantic receipt validation can
   *  catch the corruption (no hash-mismatch shortcut). */
  const rewriteAttempt = (
    ctx: ReturnType<typeof makeCtx>,
    attempt: ReplanAttemptRecord,
    mutate: (r: ReplanAttemptRecord) => void,
  ) => {
    const row = ctx.store.get(
      "replan_attempt",
      attempt.replan_attempt_id,
    ) as ReplanAttemptRecord;
    mutate(row);
    ctx.store.put(
      "replan_attempt",
      attempt.replan_attempt_id,
      row as unknown as Record<string, unknown>,
      Number(row.version ?? 0),
    );
  };

  it("R3.1. valid PREPARED → commit → ACCEPTED receipt → assertReplanCommitReceipt PASS", () => {
    const ctx = makeCtx("r3-1", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    ctx.commitReplan(mid, prepared);
    const at = attempts(ctx.store, mid)[0];
    expect(at.status).toBe("ACCEPTED");
    const rev = assertReplanCommitReceipt(
      ctx.store.planRevisions(mid),
      at,
    );
    expect(String(rev.plan_id)).toBe(String(at.commit_receipt?.plan_id));
  });

  it("R3.2. canonically-rewritten receipt digest (same plan_id/revision, WRONG digest) → FAIL_CLOSED on resume", () => {
    const ctx = makeCtx("r3-2", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    ctx.commitReplan(mid, prepared); // valid ACCEPTED
    // Corrupt ONLY the receipt's semantic digest via the canonical
    // seam — plan_id + revision stay correct, entity hash stays valid.
    rewriteAttempt(ctx, prepared, (r) => {
      if (r.commit_receipt) {
        r.commit_receipt = {
          ...r.commit_receipt,
          plan_semantic_digest: "ff".repeat(32),
        };
      }
    });
    const corrupted = attempts(ctx.store, mid)[0];
    expect(corrupted.status).toBe("ACCEPTED");
    expect(() => ctx.commitReplan(mid, corrupted)).toThrowError(
      /FAIL_CLOSED_REPLAN_COMMIT_RECEIPT/,
    );
  });

  it("R3.3. receipt digest correct but revision carries NO attempt binding → FAIL_CLOSED", () => {
    const ctx = makeCtx("r3-3", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    // Commit an UNBOUND same-digest revision, then forge an ACCEPTED
    // receipt naming it (digest matches — only the binding proof fails).
    const unbound = ctx.service.commitPlan({
      mission_id: mid,
      tasks: planB().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: planB(),
    });
    const ledger = new ReplanAttemptLedger(ctx.store);
    ledger.markCommitted(prepared.replan_attempt_id, {
      plan_id: unbound.plan_id,
      revision: unbound.revision,
      plan_semantic_digest: digestB(),
    });
    const at = attempts(ctx.store, mid)[0];
    expect(() => ctx.commitReplan(mid, at)).toThrowError(
      /FAIL_CLOSED_REPLAN_COMMIT_RECEIPT/,
    );
  });

  it("R3.4. receipt digest == revision digest but != candidate digest → FAIL_CLOSED", () => {
    const ctx = makeCtx("r3-4", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB()); // candidate = digestB
    // Revision bound to this attempt but committed over DIFFERENT tasks
    // (digestA) — receipt digest == revision digest, both != candidate.
    const foreignDigest = ctx.service.commitPlan({
      mission_id: mid,
      tasks: planA().tasks,
      source: "AUTOMATON_PLANNER",
      reason: "replan",
      proposal: planA(),
      replan_commit: {
        recovery_id: prepared.recovery_id,
        replan_attempt_id: prepared.replan_attempt_id,
        superseded_plan_id: String(prepared.superseded_plan_id),
      },
    });
    const digestA = String(foreignDigest.plan_semantic_digest);
    expect(digestA).not.toBe(digestB());
    // Forge ACCEPTED receipt consistent with the foreign-digest
    // revision — markCommitted would refuse, so write via the seam.
    rewriteAttempt(ctx, prepared, (r) => {
      r.status = "ACCEPTED";
      r.commit_receipt = {
        plan_id: foreignDigest.plan_id,
        revision: foreignDigest.revision,
        plan_semantic_digest: digestA,
      };
    });
    const at = attempts(ctx.store, mid)[0];
    expect(() => ctx.commitReplan(mid, at)).toThrowError(
      /FAIL_CLOSED_REPLAN_COMMIT_RECEIPT/,
    );
  });

  it("R3.5. valid ACCEPTED stale-resume → converge, ZERO new revision, ZERO planner call", () => {
    const ctx = makeCtx("r3-5", () => planB());
    ctx.registerAdapter(new ScriptedAdapter("EX_LOCAL"), ["FILE_OPERATIONS"]);
    const mid = ctx.startMission();
    ctx.tickUntil(mid, () => ctx.service.listTasks(mid).length > 0);
    invalidateActiveTask(ctx, mid);
    ctx.toReplanning(mid);
    const prepared = mkPrepared(ctx, mid, planB());
    ctx.commitReplan(mid, prepared);
    const count = ctx.store.planRevisions(mid).length;
    ctx.store.close();
    const { store2, calls2, runtime2, drive2 } = rebuild(ctx, () => planA());
    // Stale PREPARED snapshot resume on the rebuilt runtime — the in-txn
    // re-read sees ACCEPTED + proven receipt → converge, zero writes.
    (
      runtime2 as unknown as {
        commitPreparedReplan(
          m: string,
          p: ReplanAttemptRecord,
          l: ReplanAttemptLedger,
        ): void;
      }
    ).commitPreparedReplan(mid, prepared, new ReplanAttemptLedger(store2));
    expect(store2.planRevisions(mid)).toHaveLength(count);
    expect(calls2.filter((c) => c.reason === "replan")).toHaveLength(0);
    expect(drive2(mid)).toBe("COMPLETED");
    expect(store2.planRevisions(mid)).toHaveLength(count);
    store2.close();
  });
});
