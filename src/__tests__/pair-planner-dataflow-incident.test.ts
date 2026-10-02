/**
 * Incident R1 — planner data-flow soundness + deterministic missing-input
 * recovery closure.
 *
 * Live incident MSN_01M3XA44P4P2PEMEJZT8KNTJH3: the LLM planner emitted a
 * TELEGRAM_DELIVERY task with depends_on:[] — it dispatched at t=0 while
 * the producer of its input artifact was still RUNNING, failed with
 * CODEX_AGENT_REPORTED_FAILURE, and the retry-blind PROCESS_EXIT class
 * burned the whole attempt budget (incl. one approved extension) before
 * the mission FAILED. Two defects closed here:
 *
 *   A — canonical deterministic plan data-flow authority
 *       (src/pair/plan-dataflow.ts): consumed artifacts require a unique
 *       earlier producer edge; missing edges are injected with durable
 *       repair evidence BEFORE plan_digest/preview pin; unbound/ambiguous/
 *       backward producers fail closed (PLAN_INVALID failover material).
 *   B — evidence-based recovery classification: a retryable failure on a
 *       task whose canonical pair_dataflow.consumes artifact is absent is
 *       DEPENDENCY_FAILURE (non-retryable → REPLAN/ABORT). No canonical
 *       consumes evidence → the base class stands (no fabrication).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
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
  ExecutorRegistry,
  planDigest,
  reconcilePlanDataflow,
  assertPlanDataflow,
  normalizeArtifactPath,
  createPlanPreview as persistPlanPreviewRow,
  TRANSPORT_IN_PROCESS,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-dataflow-r1-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* ------------------------------ plan fixtures ------------------------------ */

const goalTask = (key = "T1") => ({
  task_key: key,
  title: "record goal",
  task_instruction: "record the goal",
  required_capabilities: ["FILE_OPERATIONS"],
  depends_on: [] as string[],
  metadata: {
    expected_output_contract: {
      type: "TASK_RESULT",
      worker_spec: {
        ops: [
          { op: "write_text_file", path: "mission_goal.txt", content: "g" },
          { op: "finish", result: { summary: "ok" } },
        ],
      },
    },
  },
});

const producerTask = (key = "T2", file = "analysis.txt", deps: string[] = ["T1"]) => ({
  task_key: key,
  title: `produce ${file}`,
  task_instruction: `write findings to ${file}, then reply DONE.`,
  required_capabilities: ["REASONING"],
  depends_on: deps,
  metadata: {},
});

const consumerTask = (key = "T3", file = "analysis.txt", deps: string[] = []) => ({
  task_key: key,
  title: `consume ${file}`,
  task_instruction: `read ${file} and summarize it into summary.txt, then reply DONE.`,
  required_capabilities: ["FILE_OPERATIONS"],
  depends_on: deps,
  metadata: {},
});

const deliveryTask = (key = "T3", deps: string[] = []) => ({
  task_key: key,
  title: "deliver",
  task_instruction:
    "Read the upstream tasks' returned results in dependency_outputs, compose the report, write it to outbox/report.txt, and copy analysis.txt into outbox/ keeping its filename, then reply DONE.",
  required_capabilities: ["TELEGRAM_DELIVERY"],
  depends_on: deps,
  metadata: {},
});

const remoteTask = (key = "T2", deps: string[] = ["T1"]) => ({
  task_key: key,
  title: "remote research",
  task_instruction: "research mql5 ea trends remotely, return findings, then reply DONE.",
  required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
  depends_on: deps,
  metadata: {},
});

/* ------------------------------ runtime ctx -------------------------------- */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  collected: Record<string, Record<string, unknown>> = {};
  /** task_key → behavior; default COMPLETED */
  behavior: Record<string, "COMPLETE" | "FAIL" | "WRITE" | "GATED"> = {};
  workspace = "";

  constructor(id: string, caps: string[]) {
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
    const taskRow = (this as never as { store?: PairEvidenceStore }).store
      ?.tryGet("task", String(task.task_id));
    const key = String(taskRow?.task_key ?? "");
    const b = this.behavior[key] ?? "COMPLETE";
    let status = "COMPLETED";
    let error: Record<string, unknown> | undefined;
    if (b === "WRITE" && this.workspace) {
      // Producer honors its canonical contract on disk.
      const df = (
        (taskRow?.metadata as Record<string, unknown> | undefined)
          ?.pair_dataflow as Record<string, unknown> | undefined
      );
      for (const f of (df?.produces as string[]) ?? []) {
        fs.writeFileSync(path.join(this.workspace, f), `content of ${f}`);
      }
    }
    if (b === "GATED") {
      // Read-first semantics: FAILED iff a declared input is missing —
      // the same "missing prerequisite" the real executor reported.
      const df = (
        (taskRow?.metadata as Record<string, unknown> | undefined)
          ?.pair_dataflow as Record<string, unknown> | undefined
      );
      const missing = ((df?.consumes as string[]) ?? []).some(
        (f) => !fs.existsSync(path.join(this.workspace, f)),
      );
      if (missing) {
        status = "FAILED";
        // The incident shape: executor reports failure; classification
        // lands on retryable PROCESS_EXIT before evidence overrides.
        error = { class: "PROCESS_EXIT", message: "CODEX_AGENT_REPORTED_FAILURE" };
      }
    }
    if (b === "FAIL") {
      status = "FAILED";
      error = { class: "PROCESS_EXIT", message: "CODEX_AGENT_REPORTED_FAILURE" };
    }
    this.collected[eid] = {
      status,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      ...(error ? { error } : { summary: `done ${key}` }),
    };
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    return { status: String(this.collected[executionId]?.status ?? "RUNNING") };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    return this.collected[executionId] ?? { status: "FAILED", error: { class: "MISSING" } };
  }
  collect_artifacts() {
    return [];
  }
  health() {
    return { state: "READY" };
  }
}

function makeCtx(name: string, opts: { planner?: (i: never) => unknown } = {}) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
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
  const planner =
    opts.planner ??
    ((input: { mission: Record<string, unknown> }) => {
      // Mirror the serve planner seam: pinned > llm_plan (reconciled
      // through the same canonical data-flow authority) > template.
      const pinned = input.mission?.metadata?.pinned_plan_tasks as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
      const llm = input.mission?.metadata?.llm_plan as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(llm) && llm.length) {
        return { tasks: reconcilePlanDataflow(JSON.parse(JSON.stringify(llm))).tasks };
      }
      return { tasks: [goalTask()] };
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
  for (const cap of [
    "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    "AUTOMATON_TASK_EXECUTION", "REMOTE_CLOUD_TASK_EXECUTION",
  ]) {
    service.registerCapability(cap, { risk_class: "LOW" });
  }
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId: String(project.project_id),
  };
}

function registerAdapter(ctx: ReturnType<typeof makeCtx>, adapter: ScriptedAdapter) {
  adapter.workspace = ctx.workspace;
  (adapter as never as { store: PairEvidenceStore }).store = ctx.store;
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: adapter.caps,
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
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: adapter.caps,
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: adapter.caps,
  });
  ctx.adapters.set(adapter.executor_id, adapter);
}

const rt = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.get("mission_runtime", `MRT_${mid}`);
const decisionsOf = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.list("recovery_decision").filter((d) => d.mission_id === mid);
const execsOf = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);

function drive(ctx: ReturnType<typeof makeCtx>, mid: string, max = 120) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    ctx.runtime.tick(mid, new Date(t).toISOString());
    const s = String(rt(ctx, mid).state);
    if (["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s)) return s;
  }
  return String(rt(ctx, mid).state);
}

/* =================== A. RECONCILE — edge injection =================== */

describe("R1 A–G — plan data-flow reconciliation", () => {
  it("A. incident shape — consumer with empty depends_on gets producer edge + durable evidence", () => {
    const raw = [
      goalTask("T1"),
      producerTask("T2", "analysis.txt", []),
      deliveryTask("T3", []),
    ];
    const { tasks, repairs } = reconcilePlanDataflow(
      JSON.parse(JSON.stringify(raw)),
    );
    const t3 = tasks.find((t) => t.task_key === "T3")!;
    expect(t3.depends_on).toEqual(["T1", "T2"]);
    // The repair ledger is pinned on the consumer task — digest-covered.
    const md = t3.metadata as Record<string, unknown>;
    const rs = md.pair_dataflow_repairs as Array<Record<string, unknown>>;
    expect(rs.length).toBeGreaterThanOrEqual(2);
    const prod = rs.find((r) => r.producer_key === "T2")!;
    expect(prod.reason).toBe("ARTIFACT_DATAFLOW");
    expect(prod.artifact).toBe("analysis.txt"); // real artifact wins over RESULT_TEXT
    expect(prod.original_depends_on).toEqual([]);
    expect(prod.resulting_depends_on).toEqual(["T1", "T2"]);
    // pair_dataflow persisted on every canonical task.
    for (const t of tasks) {
      expect((t.metadata as Record<string, unknown>).pair_dataflow).toBeTruthy();
    }
    expect(repairs.every((r) => r.reason === "ARTIFACT_DATAFLOW")).toBe(true);
    // A repaired plan validates sound — no mutation needed later.
    expect(() => assertPlanDataflow(tasks)).not.toThrow();
  });

  it("remote tasks carry no local artifact I/O — result text flows only through edges", () => {
    const { tasks } = reconcilePlanDataflow([
      goalTask("T1"),
      remoteTask("T2", ["T1"]), // instruction mentions remote files — ignored
      {
        task_key: "T3", title: "deliver",
        task_instruction: "Read the upstream results in dependency_outputs, write it to outbox/report.txt, then reply DONE.",
        required_capabilities: ["TELEGRAM_DELIVERY"], depends_on: [], metadata: {},
      },
    ]);
    const t2 = tasks.find((t) => t.task_key === "T2")!;
    const df = (t2.metadata as Record<string, unknown>).pair_dataflow as {
      produces: string[]; consumes: string[];
    };
    expect(df).toEqual({ produces: [], consumes: [] });
    // Remote files never land locally: a local consumer of a remote-only
    // artifact is unbound → fail closed (the incident's alternate shape).
    expect(() =>
      reconcilePlanDataflow([
        goalTask("T1"),
        remoteTask("T2", ["T1"]),
        consumerTask("T3", "analysis.txt", []),
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
  });

  it("B. declared producer edge → no duplicate injection, no repair for it", () => {
    const { tasks } = reconcilePlanDataflow([
      goalTask("T1"),
      producerTask("T2", "analysis.txt", []),
      consumerTask("T3", "analysis.txt", ["T2"]),
    ]);
    const t3 = tasks.find((t) => t.task_key === "T3")!;
    expect(t3.depends_on).toEqual(["T2"]);
    expect(
      (t3.metadata as Record<string, unknown>).pair_dataflow_repairs,
    ).toBeUndefined();
  });

  it("C. fan-out B‖C → D — both producers wired, B/C stay parallel", () => {
    const { tasks } = reconcilePlanDataflow([
      goalTask("T1"),
      producerTask("T2", "a.txt", []),
      producerTask("T3", "b.txt", []),
      {
        task_key: "T4",
        title: "merge",
        task_instruction: "read a.txt and read b.txt, write merged to m.txt, then reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
    ]);
    const t2 = tasks.find((t) => t.task_key === "T2")!;
    const t3 = tasks.find((t) => t.task_key === "T3")!;
    const t4 = tasks.find((t) => t.task_key === "T4")!;
    // Producers are never serialized as a shortcut — they stay independent.
    expect(t2.depends_on).toEqual([]);
    expect(t3.depends_on).toEqual([]);
    expect(t4.depends_on).toEqual(["T2", "T3"]);
  });

  it("D. consumed artifact with no producer → FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT", () => {
    expect(() =>
      reconcilePlanDataflow([
        goalTask("T1"),
        consumerTask("T3", "missing.txt", []),
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
  });

  it("E. two earlier producers of the same artifact → FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER", () => {
    expect(() =>
      reconcilePlanDataflow([
        producerTask("T2", "dup.txt", []),
        producerTask("T3", "dup.txt", []),
        consumerTask("T4", "dup.txt", []),
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER/);
  });

  it("F. producer only AFTER the consumer → FAIL_CLOSED_PLAN_DATAFLOW_ORDER (no reorder guess)", () => {
    expect(() =>
      reconcilePlanDataflow([
        consumerTask("T2", "late.txt", []),
        producerTask("T3", "late.txt", []),
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_ORDER/);
    // A declared cycle is equally unsound at the pure validator.
    expect(() =>
      assertPlanDataflow([
        { task_key: "T1", required_capabilities: [], depends_on: ["T2"], metadata: {} },
        { task_key: "T2", required_capabilities: [], depends_on: ["T1"], metadata: {} },
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW/);
  });

  it("G. repair is deterministic + idempotent — same input → same tasks → same digest", () => {
    const mk = () => JSON.parse(JSON.stringify([
      goalTask("T1"),
      producerTask("T2", "analysis.txt", []),
      deliveryTask("T3", []),
    ]));
    const r1 = reconcilePlanDataflow(mk()).tasks;
    const r2 = reconcilePlanDataflow(mk()).tasks;
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    const d = (tasks: unknown) =>
      planDigest({
        project_id: "P", effective_input_digest: "e",
        tasks: tasks as never,
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      });
    expect(d(r1)).toBe(d(r2));
    // Idempotent: reconciling the repaired list changes nothing.
    const again = reconcilePlanDataflow(JSON.parse(JSON.stringify(r1)));
    expect(again.repairs).toHaveLength(0);
    expect(JSON.stringify(again.tasks)).toBe(JSON.stringify(r1));
  });

  it("absolute / traversal / ambiguous paths are never artifacts", () => {
    expect(normalizeArtifactPath("/tmp/x.txt")).toBeNull();
    expect(normalizeArtifactPath("../x.txt")).toBeNull();
    expect(normalizeArtifactPath("a/../x.txt")).toBeNull();
    expect(normalizeArtifactPath("C:\\x.txt")).toBeNull();
    expect(normalizeArtifactPath("outbox/")).toBeNull();
    expect(normalizeArtifactPath("~/x.txt")).toBeNull();
    expect(normalizeArtifactPath("outbox/report.txt")).toBe("outbox/report.txt");
    expect(normalizeArtifactPath("analysis.txt")).toBe("analysis.txt");
    // Unsafe declared paths fail closed — never normalized away silently.
    expect(() =>
      reconcilePlanDataflow([
        {
          task_key: "T1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
          metadata: { pair_dataflow: { consumes: ["../escape.txt"] } },
        },
      ]),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_PATH/);
  });
});

/* =================== H. LEGACY PREVIEW FAIL-CLOSED =================== */

describe("R1 H — legacy READY preview with unsound DAG", () => {
  it("confirm fails closed: FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND, preview not consumed, no mission", () => {
    const ctx = makeCtx("legacy-preview");
    const unsound = [
      producerTask("T1", "analysis.txt", []),
      deliveryTask("T2", []), // delivery missing the producer edge
    ];
    // Persist a READY preview exactly as a pre-R1 build would have written
    // it — digests computed over the UNSOUND task list.
    const eid = "eid-legacy";
    const pd = planDigest({
      project_id: ctx.projectId, effective_input_digest: eid,
      tasks: unsound as never,
      granted_permissions: [], authorized_workspaces: [ctx.workspace],
      risk_ceiling: "LOW",
    });
    const row = persistPlanPreviewRow(ctx.store, {
      missionInput: {
        project_id: ctx.projectId, goal: "legacy", metadata: {},
        granted_permissions: [], authorized_workspaces: [ctx.workspace],
        risk_ceiling: "LOW", operator_id: null,
      },
      effective_input_digest: eid,
      plan_digest: pd,
      canonical_tasks: unsound as never,
      attempts: [],
      winner: null,
    });
    const before = ctx.store.get("mission_plan_preview", String(row.preview_id));
    expect(() =>
      ctx.control.confirmPlanPreview({
        preview_id: String(row.preview_id),
        plan_digest: pd,
      }),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND/);
    const after = ctx.store.get("mission_plan_preview", String(row.preview_id));
    expect(after.state).toBe("READY");
    expect(after.plan_digest).toBe(String(before.plan_digest));
    expect(after.consumed_mission_id ?? null).toBeNull();
    expect(ctx.store.list("mission")).toHaveLength(0);
  });
});

/* =================== RECOVERY CLASSIFICATION =================== */

describe("R1 recovery — proven missing prerequisite → DEPENDENCY_FAILURE", () => {
  const failingConsumerPlan = () =>
    reconcilePlanDataflow([
      goalTask("T1"),
      producerTask("T2", "analysis.txt", ["T1"]),
      consumerTask("T3", "analysis.txt", ["T2"]),
    ]).tasks;

  it("C+D. consumed artifact absent at settle → DEPENDENCY_FAILURE, no retry burn, no approval", () => {
    const ctx = makeCtx("dep-fail");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "AUTOMATON_TASK_EXECUTION",
    ]);
    // Producer "completes" but never lands the artifact — consumer's
    // canonical input is provably absent at settle time.
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "GATED" };
    registerAdapter(ctx, adapter);
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "g",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { llm_plan: failingConsumerPlan() },
    });
    const mid = String(m.mission_id);
    const state = drive(ctx, mid);
    expect(["FAILED", "ABORTED", "COMPLETED"]).toContain(state);
    const t3 = ctx.service.listTasks(mid).find((t) => t.task_key === "T3")!;
    const t3Execs = execsOf(ctx, mid).filter((e) => e.task_id === t3.task_id);
    // Incident budget: the missing-input failure burned ONE execution —
    // never a RETRY_SAME_ROUTE/RE_ROUTE burn loop like the live incident.
    expect(t3Execs).toHaveLength(1);
    const ds = decisionsOf(ctx, mid);
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.some((d) => d.failure_class === "DEPENDENCY_FAILURE")).toBe(true);
    // DEPENDENCY_FAILURE actions are REPLAN/ABORT — no retry, no human ask.
    expect(
      ds.every(
        (d) => !["RETRY_SAME_ROUTE", "RE_ROUTE"].includes(String(d.selected_action)),
      ),
    ).toBe(true);
    expect(
      ctx.store.list("approval_request").filter((a) => a.mission_id === mid),
    ).toHaveLength(0);
  });

  it("A+B. failure without canonical consumes evidence → base class stands (PROCESS_EXIT retries)", () => {
    const ctx = makeCtx("generic-fail");
    const adapter = new ScriptedAdapter("EX_A", ["FILE_OPERATIONS"]);
    registerAdapter(ctx, adapter);
    // A task with NO consumed artifacts — generic PROCESS_EXIT-shaped
    // failure (executor reports a failure class string with no canonical
    // input evidence) must NOT be fabricated into DEPENDENCY_FAILURE.
    adapter.behavior = { T1: "FAIL" };
    const plain = [
      {
        task_key: "T1", title: "t", task_instruction: "do work, reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"], depends_on: [], metadata: {},
      },
    ];
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "g",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { llm_plan: reconcilePlanDataflow(plain) },
    });
    const mid = String(m.mission_id);
    // Drive until the first failure settles into its recovery decision.
    let ds = decisionsOf(ctx, mid);
    for (let i = 0; i < 20 && ds.length === 0; i++) {
      ctx.runtime.tick(mid, new Date(Date.parse("2999-01-01T00:00:00Z") + i * 60_000).toISOString());
      ds = decisionsOf(ctx, mid);
    }
    expect(ds.length).toBe(1);
    expect(String(ds[0].failure_class)).not.toBe("DEPENDENCY_FAILURE");
    // The retryable matrix applies — a bounded retry is scheduled.
    expect(["RETRY_SAME_ROUTE", "RE_ROUTE"]).toContain(String(ds[0].selected_action));
  });
});

/* =================== E2E — incident mission, repaired plan =================== */

describe("R1 E2E — incident shape converges through the repaired plan", () => {
  it("planner omits the delivery dep → reconcile injects it pre-preview → delivery waits for producer → exactly once, no retries/approvals", () => {
    const rawUnsound = [
      goalTask("T1"),
      producerTask("T2", "analysis.txt", ["T1"]),
      deliveryTask("T3", []), // the live bug: no declared edge
    ];
    // Same canonical seam serve-mission-control uses: the failover
    // canonicalize callback reconciles BEFORE validation/pin.
    const planner = () => ({
      tasks: reconcilePlanDataflow(
        JSON.parse(JSON.stringify(rawUnsound)),
      ).tasks,
    });
    const ctx = makeCtx("e2e-incident", { planner: planner as never });
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "AUTOMATON_TASK_EXECUTION",
      "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "WRITE", T3: "GATED" };
    registerAdapter(ctx, adapter);

    // Preview path: raw proposal unsound, pinned plan repaired.
    const pv = ctx.control.createPlanPreview({
      project_id: ctx.projectId, goal: "g", operator_id: "op1",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
    });
    const stored = ctx.store.get("mission_plan_preview", String(pv.preview_id));
    const t3pinned = (stored.canonical_tasks as Array<Record<string, unknown>>)
      .find((t) => t.task_key === "T3")!;
    expect(t3pinned.depends_on).toEqual(["T1", "T2"]);
    expect(
      (t3pinned.metadata as Record<string, unknown>).pair_dataflow_repairs,
    ).toBeTruthy();

    const m = ctx.control.confirmPlanPreview({
      preview_id: String(pv.preview_id),
      plan_digest: String(pv.plan_digest),
      operator_id: "op1",
    });
    const mid = String(m.mission_id);
    const state = drive(ctx, mid);
    // Delivery's check: analysis.txt must exist by the time T3 runs —
    // the repaired edge made the producer run first.
    expect(state).toBe("COMPLETED");
    const tasks = ctx.service.listTasks(mid);
    const order = adapter.dispatched.map((eid) => {
      const exec = execsOf(ctx, mid).find((e) => e.execution_id === eid)!;
      const t = tasks.find((x) => x.task_id === exec.task_id)!;
      return t.task_key;
    });
    expect(order.indexOf("T3")).toBeGreaterThan(order.indexOf("T2"));
    for (const t of tasks) {
      expect(
        execsOf(ctx, mid).filter((e) => e.task_id === t.task_id),
      ).toHaveLength(1); // exactly once
    }
    expect(decisionsOf(ctx, mid)).toHaveLength(0); // zero spurious recovery
    expect(
      ctx.store.list("approval_request").filter((a) => a.mission_id === mid),
    ).toHaveLength(0);
  });
});
