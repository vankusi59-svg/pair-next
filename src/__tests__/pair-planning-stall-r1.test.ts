/**
 * PAIR_NEXT_PLANNING_STALL_R1 — regression suite for the
 * MSN_01M4D7W8ADPSH0951WCS3NDVPQ incident:
 *
 *   A. "Soạn 3 bài post Telegram…" noun-`post` false-positive in
 *      detectTelegramDeliveryIntent → deterministic assertPlanDataflow
 *      throw → infinite silent PLANNING.
 *   B. MissionSupervisor.tick()'s deliberate per-mission swallow made a
 *      deterministic failure replay forever with zero evidence.
 *
 * Proofs: noun/verb `post` grammar (positive + negative), the exact
 * incident goal through the real runPlanning path, bounded durable
 * retry accounting (restart-safe), deduplicated failure evidence,
 * canonical PLANNING→FAILED / CREATED→FAILED terminalization, sibling
 * isolation, zero executor/telegram side effects.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
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
  PairError,
  PairEvidenceStore,
  PLANNING_MAX_ATTEMPTS,
  ReconciliationService,
  RecoveryController,
  TRANSPORT_IN_PROCESS,
  assertCanonicalMissionLifecycle,
  assertPlanDataflow,
  canonicalBookkeepingTask,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  validatePlanProposal,
} from "../pair/index.js";
import type { RuntimePlanner } from "../pair/mission-runtime.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-ps-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** The exact delegated-mission goal from the incident. */
const INCIDENT_GOAL =
  "Soạn 3 bài post Telegram (hook + chi tiết EA + kêu gọi sớm) và " +
  "1 video script 60 giây giới thiệu Aurum Trace — mỗi asset một file riêng trong workspace";

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  constructor(id: string) {
    this.executor_id = id;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: ["FILE_OPERATIONS"] };
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
      summary: "done",
    };
    return { execution_id: eid, status: "COMPLETED", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    const c = this.collected[executionId];
    return { status: c ? String(c.status) : "RUNNING" };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
    return { execution_id: executionId, artifacts: [], ...r };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

interface Ctx {
  dir: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  adapter: ScriptedAdapter;
  projectId: string;
  plannerCalls: number;
}

function makeCtx(name: string, planner: RuntimePlanner): Ctx {
  const dir = freshDir(name);
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const adapter = new ScriptedAdapter("EX_A");
  registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: ["FILE_OPERATIONS"],
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
  service.routes.registerRoute({
    route_id: "RTE_EX_A",
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: ["FILE_OPERATIONS"],
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: "RTE_EX_A",
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: ["FILE_OPERATIONS"],
  });
  adapters.set(adapter.executor_id, adapter);
  const ctx: Ctx = {
    dir, store, service,
    runtime: null as unknown as MissionRuntime,
    supervisor: null as unknown as MissionSupervisor,
    control: null as unknown as MissionControl,
    adapter, projectId: "", plannerCalls: 0,
  };
  const countingPlanner: RuntimePlanner = (input) => {
    ctx.plannerCalls++;
    return planner(input);
  };
  ctx.runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery,
    planner: countingPlanner,
  });
  ctx.supervisor = new MissionSupervisor(service, ctx.runtime, recovery, recon);
  const observability = new MissionObservability(service);
  ctx.control = new MissionControl({
    service, runtime: ctx.runtime, supervisor: ctx.supervisor,
    scheduler, approvals, reconciliation: recon, observability,
    planner: countingPlanner,
  });
  for (const cap of ["FILE_OPERATIONS", "REASONING", "AUTOMATON_TASK_EXECUTION"]) {
    service.registerCapability(cap, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: dir });
  ctx.projectId = String(project.project_id);
  return ctx;
}

function newMission(ctx: Ctx, goal: string): string {
  const m = ctx.service.createMission({
    project_id: ctx.projectId,
    goal,
    metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.dir],
  });
  return String(m.mission_id);
}

const planningEvents = (ctx: Ctx, mid: string) =>
  ctx.store
    .listEvents("mission_runtime", `MRT_${mid}`)
    .filter((e) => String(e.event_type) === "MISSION_PLANNING_FAILED");

const rtOf = (ctx: Ctx, mid: string) =>
  ctx.store.get("mission_runtime", `MRT_${mid}`);

/* ==================== A — noun-`post` grammar ==================== */

describe("R1.A — `post` is a delivery verb only in verb position", () => {
  it("the exact incident goal requests NO telegram delivery", () => {
    expect(detectTelegramDeliveryIntent(INCIDENT_GOAL)).toEqual({
      requested: false, artifacts: [], mode: "TEXT",
    });
  });

  it.each([
    "Viết bài post Telegram",
    "viết bài post telegram về EA vàng",
    "soạn 3 bài post telegram cho chiến dịch",
    "write a post for telegram",
    "write a telegram post about XAUUSD",
    "draft 5 telegram posts for launch",
    "tạo nội dung post trên telegram",
    "soạn post cho telegram",
    "produce content: telegram post and faq",
  ])("noun: %s → not requested", (goal) => {
    const i = detectTelegramDeliveryIntent(goal);
    expect(i.requested).toBe(false);
    expect(i.artifacts).toEqual([]);
  });

  it.each([
    "post report.txt to Telegram",
    "post it on telegram",
    "analyze then post the summary on telegram",
    "please post a.txt to telegram",
    "vui lòng post report.txt lên telegram",
    "send report.txt to Telegram",
    "gửi report.txt lên Telegram",
    "gửi telegram file a.txt và c.png",
    "đăng bài lên telegram",
    "báo kết quả qua telegram",
    "write report.txt and send it to telegram",
  ])("verb: %s → still requests delivery", (goal) => {
    expect(detectTelegramDeliveryIntent(goal).requested).toBe(true);
  });

  it("negation and mention-only cases unchanged", () => {
    for (const g of [
      "do not send report.txt to Telegram",
      "don't post report.txt to telegram",
      "không cần gửi report.txt lên Telegram",
      "đừng đăng report.txt lên telegram",
      "does the telegram bot work?",
      "send report.txt to the team",
    ]) {
      expect(detectTelegramDeliveryIntent(g).requested).toBe(false);
    }
  });

  it("manifest still parses bounded artifacts for verb-position post", () => {
    expect(
      detectTelegramDeliveryIntent("post a.txt and c.png to telegram"),
    ).toEqual({ requested: true, artifacts: ["a.txt", "c.png"], mode: "FILES" });
  });

  it("full plan-validation regression — incident goal + template-shape plan commits", () => {
    const tasks = [
      canonicalBookkeepingTask(INCIDENT_GOAL),
      {
        task_key: "T2",
        title: "llm analysis",
        task_instruction:
          "The workspace contains mission_goal.txt holding the operator's goal. Produce a genuine deliverable — analyze the topic itself — write findings to analysis.txt, then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const known = new Set(["AUTOMATON_TASK_EXECUTION", "REASONING"]);
    const valid = validatePlanProposal({ tasks }, known);
    // The incident goal detects NO delivery intent → a plan without a
    // delivery task is sound at the canonical commit seam.
    expect(() =>
      assertPlanDataflow(valid as Array<Record<string, unknown>>, {
        telegramIntent: detectTelegramDeliveryIntent(INCIDENT_GOAL),
        outputLanguage: detectOutputLanguage(INCIDENT_GOAL),
      }),
    ).not.toThrow();
  });

  it("explicit delivery goals still REQUIRE a governed delivery task", () => {
    const tasks = [
      canonicalBookkeepingTask("gửi report.txt lên telegram"),
      {
        task_key: "T2", title: "write",
        task_instruction: "write findings to outbox/report.txt, then reply DONE.",
        required_capabilities: ["REASONING"], depends_on: ["T1"], metadata: {},
      },
    ];
    const known = new Set(["AUTOMATON_TASK_EXECUTION", "REASONING"]);
    const valid = validatePlanProposal({ tasks }, known);
    expect(() =>
      assertPlanDataflow(valid as Array<Record<string, unknown>>, {
        telegramIntent: detectTelegramDeliveryIntent("gửi report.txt lên telegram"),
        outputLanguage: detectOutputLanguage("gửi report.txt lên telegram"),
      }),
    ).toThrow();
  });

  it("forged delivery tasks without operator intent remain rejected", () => {
    const tasks = [
      canonicalBookkeepingTask("produce a report"),
      {
        task_key: "T2", title: "deliver",
        task_instruction:
          "compose the upstream results into a report text and deliver it, then reply DONE.",
        required_capabilities: ["TELEGRAM_DELIVERY"],
        depends_on: [], metadata: {},
      },
    ];
    const known = new Set(["AUTOMATON_TASK_EXECUTION", "TELEGRAM_DELIVERY"]);
    const valid = validatePlanProposal({ tasks }, known);
    expect(() =>
      assertPlanDataflow(valid as Array<Record<string, unknown>>, {
        telegramIntent: detectTelegramDeliveryIntent("produce a report"),
        outputLanguage: detectOutputLanguage("produce a report"),
      }),
    ).toThrow();
  });
});

/* ==================== B — durable planning-failure boundary ==================== */

describe("R1.B — planning failures terminalize canonically, never loop silently", () => {
  const detFail = () =>
    new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED", "d");
  const transientFail = () =>
    new IntegrityError("FAIL_CLOSED_PLANNER_EXHAUSTED", "pool gave up");
  const goodPlan = { tasks: [] as Array<Record<string, unknown>> };

  it("deterministic FAIL_CLOSED failure → runtime+mission FAILED on FIRST throw, dedup evidence", () => {
    const ctx = makeCtx("det", () => {
      throw detFail();
    });
    const mid = newMission(ctx, "gửi report.txt lên telegram");
    // The original throw still reaches the caller (pre-boundary contract),
    // but now it is durable + terminalizing, not silently replayed.
    expect(() => ctx.runtime.run(mid)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    const rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("FAILED");
    expect(String(rt.reason)).toContain("planning_failed:");
    const mission = ctx.service.getMission(mid);
    expect(String(mission.status)).toBe("FAILED");
    // Deterministic: exactly ONE planner invocation — no retry burn.
    expect(ctx.plannerCalls).toBe(1);
    // Durable deduplicated evidence: ONE bounded record + ONE event.
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.code)).toBe("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED");
    expect(String(pf.failure_class)).toBe("DETERMINISTIC");
    expect(Number(pf.attempts)).toBe(1);
    expect(planningEvents(ctx, mid)).toHaveLength(1);
    // Canonical lifecycle proof passes: mission FAILED ↔ runtime FAILED,
    // exactly-one legal transitions on both spines.
    expect(() =>
      assertCanonicalMissionLifecycle(ctx.store, mission, "FAILED"),
    ).not.toThrow();
    // Zero side effects: no executor dispatch, no delivery minted.
    expect(ctx.store.list("executor_execution")).toHaveLength(0);
    expect(ctx.store.list("telegram_delivery_request")).toHaveLength(0);
    expect(ctx.adapter.dispatched).toHaveLength(0);
  });

  it("transient failure → bounded retry then FAILED — durable counter, dedup events", () => {
    const ctx = makeCtx("trans", () => {
      throw transientFail();
    });
    const mid = newMission(ctx, "research then write report.txt");
    ctx.runtime.tick(mid); // CREATED → PLANNING (planner not yet called)
    for (let i = 0; i < PLANNING_MAX_ATTEMPTS; i++) {
      expect(() => ctx.runtime.tick(mid)).toThrow(
        /FAIL_CLOSED_PLANNER_EXHAUSTED/,
      );
    }
    const rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("FAILED");
    expect(String(ctx.service.getMission(mid).status)).toBe("FAILED");
    // Bounded: exactly PLANNING_MAX_ATTEMPTS planner calls, no more.
    expect(ctx.plannerCalls).toBe(PLANNING_MAX_ATTEMPTS);
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.failure_class)).toBe("TRANSIENT_CANDIDATE");
    expect(Number(pf.attempts)).toBe(PLANNING_MAX_ATTEMPTS);
    // Dedup: identical code across all attempts → exactly ONE event.
    expect(planningEvents(ctx, mid)).toHaveLength(1);
    ctx.store.close();
  });

  it("non-typed (non-PairError) throw is TRANSIENT_CANDIDATE and bounded", () => {
    const ctx = makeCtx("untyped", () => {
      throw new Error("socket hang up");
    });
    const mid = newMission(ctx, "analyze stuff");
    ctx.runtime.tick(mid); // CREATED → PLANNING
    for (let i = 0; i < PLANNING_MAX_ATTEMPTS; i++) {
      expect(() => ctx.runtime.tick(mid)).toThrow(/socket hang up/);
    }
    const rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("FAILED");
    expect(ctx.plannerCalls).toBe(PLANNING_MAX_ATTEMPTS);
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.code)).toBe("PLANNING_UNCLASSIFIED");
    expect(String(pf.failure_class)).toBe("TRANSIENT_CANDIDATE");
    ctx.store.close();
  });

  it("retry bound persists across restart — counter is durable on the row", () => {
    const ctx = makeCtx("restart", () => {
      throw transientFail();
    });
    const mid = newMission(ctx, "research goal");
    // First tick mints the MRT row + CREATED→PLANNING; each later tick
    // is one durable failed attempt.
    ctx.runtime.tick(mid);
    ctx.supervisor.tick();
    ctx.supervisor.tick();
    let rt = rtOf(ctx, mid);
    let attempts = Number((rt.planning_failure as Record<string, unknown>).attempts);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(PLANNING_MAX_ATTEMPTS);
    expect(String(rt.state)).toBe("PLANNING");
    // "Restart": a NEW MissionRuntime over the same store resumes the
    // SAME durable counter — the bound cannot reset under replay.
    const gate2 = new GovernedTaskGate(ctx.service);
    const router2 = new MissionRouter(ctx.service, gate2);
    const recovery2 = new RecoveryController(ctx.service);
    const recon2 = new ReconciliationService(ctx.service, new Map());
    const approvals2 = new ApprovalQueue(ctx.service);
    const scheduler2 = new MissionScheduler(ctx.service, { mission_concurrency: 2 });
    const runtime2 = new MissionRuntime({
      service: ctx.service, gate: gate2, router: router2,
      adapters: new Map<string, ExecutorAdapter>(),
      scheduler: scheduler2, approvals: approvals2,
      reconciliation: recon2, recovery: recovery2,
      planner: () => {
        ctx.plannerCalls++;
        throw transientFail();
      },
    });
    // Remaining attempt(s) still surface the throw; the durable counter
    // is what bounds the replay across restarts.
    expect(() => runtime2.run(mid)).toThrow(/FAIL_CLOSED_PLANNER_EXHAUSTED/);
    rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("FAILED");
    expect(
      Number((rt.planning_failure as Record<string, unknown>).attempts),
    ).toBe(PLANNING_MAX_ATTEMPTS);
    ctx.store.close();
  });

  it("sibling missions keep progressing while one fails", () => {
    const ctx = makeCtx("siblings", ({ mission }) => {
      if (String(mission.goal).includes("bad")) throw detFail();
      return {
        tasks: [
          {
            task_key: "T1", title: "work",
            task_instruction: "analyze the goal topic, then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: {},
          },
        ],
      };
    });
    const bad = newMission(ctx, "bad goal — deterministic failure");
    const good = newMission(ctx, "good goal — writes analysis");
    ctx.runtime.tick(bad);
    ctx.runtime.tick(good);
    // Direct callers still see the throw; the supervisor isolates it per
    // mission so siblings keep progressing.
    expect(() => ctx.runtime.tick(bad)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    ctx.supervisor.runUntilSettled({ maxSweeps: 50 });
    expect(String(rtOf(ctx, bad).state)).toBe("FAILED");
    expect(String(ctx.service.getMission(bad).status)).toBe("FAILED");
    // The sibling is unaffected — it planned, dispatched, completed.
    expect(String(rtOf(ctx, good).state)).toBe("COMPLETED");
    expect(String(ctx.service.getMission(good).status)).toBe("COMPLETED");
    ctx.store.close();
  });

  it("successful planning on the incident goal commits and completes", () => {
    const ctx = makeCtx("incident-ok", () => ({
      tasks: [
        {
          task_key: "T1", title: "produce",
          task_instruction:
            "produce a genuine deliverable for the goal's subject matter, then reply DONE.",
          required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: {},
        },
      ],
    }));
    const mid = newMission(ctx, INCIDENT_GOAL);
    ctx.runtime.run(mid);
    const rt = rtOf(ctx, mid);
    // With intent correctly NOT requested, the plan commits — the
    // mission leaves PLANNING, dispatches, completes.
    expect(String(rt.state)).toBe("COMPLETED");
    expect(rt.planning_failure ?? null).toBeNull();
    // And no delivery side effects were ever minted for the noun-goal.
    expect(ctx.store.list("telegram_delivery_request")).toHaveLength(0);
    ctx.store.close();
  });

  it("no planner configured → deterministic terminalization (FAIL_CLOSED_NO_PLANNER)", () => {
    const dir = freshDir("noplanner");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const gate = new GovernedTaskGate(service);
    const router = new MissionRouter(service, gate);
    const recovery = new RecoveryController(service);
    const recon = new ReconciliationService(service, new Map());
    const approvals = new ApprovalQueue(service);
    const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
    const runtime = new MissionRuntime({
      service, gate, router, adapters: new Map(), scheduler, approvals,
      reconciliation: recon, recovery, // NO planner
    });
    service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
    const project = service.createProject({ name: "noplanner", root_location: dir });
    const m = service.createMission({
      project_id: String(project.project_id), goal: "anything", metadata: {},
      granted_permissions: ["FILE_WRITE"], authorized_workspaces: [dir],
    });
    const mid = String(m.mission_id);
    expect(() => runtime.run(mid)).toThrow(/FAIL_CLOSED_NO_PLANNER/);
    expect(String(rtOf2(store, mid).state)).toBe("FAILED");
    expect(String(service.getMission(mid).status)).toBe("FAILED");
    const evs = store
      .listEvents("mission_runtime", `MRT_${mid}`)
      .filter((e) => String(e.event_type) === "MISSION_PLANNING_FAILED");
    expect(evs).toHaveLength(1);
    store.close();
  });
});

/* ==================== R2.A — atomic planning terminalization ==================== */

describe("R2.A — terminal pair commits atomically or not at all", () => {
  const detFail = () =>
    new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED", "d");

  const rtTransitions = (ctx: Ctx, mid: string, into: string) =>
    ctx.store
      .listEvents("mission_runtime", `MRT_${mid}`)
      .filter(
        (e) =>
          String(e.event_type) === "MISSION_RUNTIME_TRANSITION" &&
          String(e.new_state) === into,
      );
  const mTransitions = (ctx: Ctx, mid: string, into: string) =>
    ctx.store
      .listEvents("mission", mid)
      .filter(
        (e) =>
          String(e.event_type) === "MISSION_TRANSITION" &&
          String(e.new_state) === into,
      );

  it("fault between terminal transitions → rollback, then consistent FAILED+ABORTED pair", () => {
    const ctx = makeCtx("atomic-fault", () => {
      throw detFail();
    });
    const mid = newMission(ctx, "gửi report.txt lên telegram");
    // Fault injected exactly BETWEEN the two terminal transitions: the
    // runtime side commits-within-transaction, the mission side throws.
    const spy = vi
      .spyOn(ctx.service, "transitionMission")
      .mockImplementationOnce(() => {
        throw new Error("injected mid-pair fault");
      });
    ctx.runtime.tick(mid); // CREATED → PLANNING
    // The original planning error still propagates (caller contract).
    expect(() => ctx.runtime.tick(mid)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    spy.mockRestore();
    const rt = rtOf(ctx, mid);
    const mission = ctx.service.getMission(mid);
    // The FAILED pair rolled back atomically — the canonical ABORTED
    // fallback produced a consistent terminal pair instead.
    expect(String(rt.state)).toBe("ABORTED");
    expect(String(rt.reason)).toContain("planning_failed_fallback:");
    expect(String(mission.status)).toBe("FAILED");
    // The rolled-back runtime FAILED transition left ZERO phantom
    // evidence; exactly one legal transition into each final state.
    expect(rtTransitions(ctx, mid, "FAILED")).toHaveLength(0);
    expect(rtTransitions(ctx, mid, "ABORTED")).toHaveLength(1);
    expect(mTransitions(ctx, mid, "FAILED")).toHaveLength(1);
    // Canonical lifecycle proof holds on the resulting pair.
    expect(() =>
      assertCanonicalMissionLifecycle(ctx.store, mission, "FAILED"),
    ).not.toThrow();
    // Evidence was re-persisted inside the fallback commit, marked
    // with the canonical-fallback terminal class.
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.code)).toBe("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED");
    expect(Number(pf.attempts)).toBe(1);
    expect(String(pf.terminal_class)).toBe("ABORTED_FALLBACK");
    ctx.store.close();
  });

  it("mission concurrently terminalized (CANCELLED) → consistent CANCELLED+ABORTED pair", () => {
    const ctx = makeCtx("concurrent-cancel", () => {
      throw detFail();
    });
    const mid = newMission(ctx, "gửi report.txt lên telegram");
    ctx.runtime.tick(mid); // CREATED → PLANNING
    // Operator cancels while the mission sits in PLANNING — the
    // FAILED-pair commit then cannot legally transition the mission.
    ctx.service.transitionMission(mid, "CANCELLED");
    expect(() => ctx.runtime.tick(mid)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    const rt = rtOf(ctx, mid);
    const mission = ctx.service.getMission(mid);
    // ABORTED pairs with CANCELLED canonically — mission left untouched.
    expect(String(rt.state)).toBe("ABORTED");
    expect(String(mission.status)).toBe("CANCELLED");
    expect(rtTransitions(ctx, mid, "FAILED")).toHaveLength(0);
    expect(rtTransitions(ctx, mid, "ABORTED")).toHaveLength(1);
    expect(() =>
      assertCanonicalMissionLifecycle(ctx.store, mission, "CANCELLED"),
    ).not.toThrow();
    ctx.store.close();
  });

  it("a second mid-pair fault still ends canonically — never an inconsistent pair", () => {
    const ctx = makeCtx("atomic-fault-2", () => {
      throw detFail();
    });
    const mid = newMission(ctx, "gửi report.txt lên telegram");
    // Persistently break mission transitions — even the fallback's
    // mission sync must fail → last-resort EMERGENCY path.
    const spy = vi
      .spyOn(ctx.service, "transitionMission")
      .mockImplementation(() => {
        throw new Error("persistent transition fault");
      });
    ctx.runtime.tick(mid);
    expect(() => ctx.runtime.tick(mid)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    spy.mockRestore();
    const rt = rtOf(ctx, mid);
    const mission = ctx.service.getMission(mid);
    // The fallback transaction rolled back too (its mission-sync call
    // faulted) — the last-resort EMERGENCY row stands. Nothing half-
    // committed: ZERO phantom FAILED transitions on either spine, and
    // the abort is operator-visible forensic evidence.
    expect(String(rt.state)).toBe("ABORTED");
    // Mission could NOT be moved — and nothing claims otherwise: the
    // evidence is explicitly marked as a BLOCKED_TRANSITION degraded
    // terminal, not a proven canonical pairing (R3.A).
    expect(String(mission.status)).toBe("CREATED");
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.terminal_class)).toBe("BLOCKED_TRANSITION");
    expect(String(rt.reason)).toBe(
      "planning_failure_boundary_defect:TRANSITION_FAULT",
    );
    expect(rtTransitions(ctx, mid, "FAILED")).toHaveLength(0);
    expect(mTransitions(ctx, mid, "FAILED")).toHaveLength(0);
    const aborts = ctx.store
      .listEvents("mission_runtime", `MRT_${mid}`)
      .filter((e) => String(e.event_type) === "MISSION_RUNTIME_EMERGENCY_ABORT");
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    // Restart-durable: a fresh store connection over the same DB sees
    // the same degraded terminal marker — no replay, no re-planning.
    const reopened = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const rtAfter = reopened.get("mission_runtime", `MRT_${mid}`);
    expect(String(rtAfter.state)).toBe("ABORTED");
    expect(String(
      (rtAfter.planning_failure as Record<string, unknown>).terminal_class,
    )).toBe("BLOCKED_TRANSITION");
    reopened.close();
    ctx.store.close();
  });
});

/* ==================== R2.B — safe planning failure evidence ==================== */

describe("R2.B — sanitized bounded failure evidence", () => {
  it("capability-token-like codes never persist as canonical codes", () => {
    const ctx = makeCtx("cap-code", () => {
      throw new PairError("FILE_OPERATIONS", "capability token leaked into the code slot");
    });
    const mid = newMission(ctx, "anything");
    ctx.runtime.tick(mid); // CREATED → PLANNING
    expect(() => ctx.runtime.tick(mid)).toThrow(/FILE_OPERATIONS/);
    const rt = rtOf(ctx, mid);
    const pf = rt.planning_failure as Record<string, unknown>;
    // Reporting did not fail — evidence persisted — but the token was
    // not minted into a canonical code slot.
    expect(String(pf.code)).toBe("PLANNING_UNCLASSIFIED");
    expect(String(pf.failure_class)).toBe("TRANSIENT_CANDIDATE");
    expect(Number(pf.attempts)).toBe(1);
    ctx.store.close();
  });

  it("no freeform error text ever persists — canonical fields only (R3.B)", () => {
    const SECRETS = [
      "AKIAIOSFODNN7EXAMPLE", // unlabelled uppercase opaque secret
      "ghp_x9Ab3KlmN8pQr2sTuvW7yZ", // mixed-case token
      "hunter2hunter2hunter2", // sensitive freeform text
    ];
    const ctx = makeCtx("no-freeform", () => {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED",
        `planner exploded: ${SECRETS.join(" ")} ` + "x".repeat(400) + "\x00\x1f",
      );
    });
    const mid = newMission(ctx, "anything");
    ctx.runtime.tick(mid);
    expect(() => ctx.runtime.tick(mid)).toThrow();
    const rt = rtOf(ctx, mid);
    const pf = rt.planning_failure as Record<string, unknown>;
    // The persisted record carries ONLY canonical fields — no message
    // field exists at all; secret-freedom is by construction.
    for (const s of SECRETS) {
      expect(JSON.stringify(pf)).not.toContain(s);
      expect(JSON.stringify(rt)).not.toContain(s);
    }
    expect(pf).not.toHaveProperty("message");
    expect(Object.keys(pf).sort()).toEqual(
      ["attempts", "code", "failure_class", "first_at", "last_at", "terminal_class"].sort(),
    );
    expect(String(pf.code)).toBe("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED");
    expect(String(pf.terminal_class)).toBe("FAILED");
    // Event metadata carries the same canonical-only fields.
    const ev = planningEvents(ctx, mid)[0];
    for (const s of SECRETS) {
      expect(JSON.stringify(ev)).not.toContain(s);
    }
    expect(JSON.stringify(ev)).not.toContain("message");
    ctx.store.close();
  });

  it("fallback inner-error text never persists in rows, events or reasons", () => {
    const SECRET = "sk_live_51AbCDeFgHiJkLmN0pQrStUvWxYz";
    const ctx = makeCtx("fallback-secret", () => {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED",
        "planning blew up",
      );
    });
    const mid = newMission(ctx, "anything");
    // Persistent mission-transition fault whose message carries a
    // secret — reasons + evidence must carry a fixed label only.
    vi.spyOn(ctx.service, "transitionMission").mockImplementation(() => {
      throw new Error(`transition died: Bearer ${SECRET}`);
    });
    ctx.runtime.tick(mid);
    expect(() => ctx.runtime.tick(mid)).toThrow(
      /FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED/,
    );
    const rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("ABORTED");
    // Reason is a fixed-label diagnostic — never the inner message.
    expect(String(rt.reason)).toBe(
      "planning_failure_boundary_defect:TRANSITION_FAULT",
    );
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.terminal_class)).toBe("BLOCKED_TRANSITION");
    expect(pf).not.toHaveProperty("message");
    // Nothing anywhere persisted carries the inner text or the secret.
    for (const s of [SECRET, "transition died", "Bearer"]) {
      expect(JSON.stringify(rt)).not.toContain(s);
    }
    const all = ctx.store.listEvents("mission_runtime", `MRT_${mid}`);
    for (const e of all) {
      expect(JSON.stringify(e)).not.toContain(SECRET);
    }
    ctx.store.close();
  });

  it("dedup is per-code: a code change across attempts emits one event each", () => {
    let n = 0;
    const ctx = makeCtx("code-switch", () => {
      n++;
      // Attempt 1: retryable pool exhaustion; attempt 2: deterministic.
      throw n === 1
        ? new IntegrityError("FAIL_CLOSED_PLANNER_EXHAUSTED", "pool gave up")
        : new IntegrityError("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED", "d");
    });
    const mid = newMission(ctx, "anything");
    ctx.runtime.tick(mid); // CREATED → PLANNING
    expect(() => ctx.runtime.tick(mid)).toThrow(/PLANNER_EXHAUSTED/); // attempt 1
    expect(() => ctx.runtime.tick(mid)).toThrow(/DATAFLOW/); // attempt 2 → terminal
    const rt = rtOf(ctx, mid);
    expect(String(rt.state)).toBe("FAILED");
    // One event per DISTINCT code — exactly two, never a per-tick flood.
    expect(planningEvents(ctx, mid)).toHaveLength(2);
    const pf = rt.planning_failure as Record<string, unknown>;
    expect(String(pf.code)).toBe("FAIL_CLOSED_PLAN_DATAFLOW_DELIVERY_REQUIRED");
    expect(Number(pf.attempts)).toBe(2);
    ctx.store.close();
  });
});

const rtOf2 = (store: PairEvidenceStore, mid: string) =>
  store.get("mission_runtime", `MRT_${mid}`);
