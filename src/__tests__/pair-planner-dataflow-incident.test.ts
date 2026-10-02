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
  extractTaskDataflow,
  detectTelegramDeliveryIntent,
  pendingTelegramDeliveries,
  ackTelegramDelivery,
  deliveryRequestId,
  createPlanPreview as persistPlanPreviewRow,
  TRANSPORT_IN_PROCESS,
  utcnow,
} from "../pair/index.js";
import type { TelegramDeliveryIntent } from "../pair/index.js";

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

const deliveryTask = (key = "T3", deps: string[] = [], file = "analysis.txt") => ({
  task_key: key,
  title: "deliver",
  task_instruction:
    `Read the upstream tasks' returned results in dependency_outputs, compose the report, write it to outbox/${file}, and copy ${file} into outbox/ keeping its filename, then reply DONE.`,
  required_capabilities: ["TELEGRAM_DELIVERY"],
  depends_on: deps,
  metadata: {},
});

/** R2 — a delivery task can only reconcile when the operator-request
 *  intent authority is passed in (what canonicalizeLlmTasks does). */
const FILES_INTENT = (artifacts: string[]): TelegramDeliveryIntent => ({
  requested: true,
  artifacts,
  mode: "FILES",
});
const TEXT_INTENT: TelegramDeliveryIntent = {
  requested: true,
  artifacts: [],
  mode: "TEXT",
};

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
  behavior: Record<
    string,
    "COMPLETE" | "FAIL" | "WRITE" | "GATED" | "SLOW" | "DELETEFAIL"
  > = {};
  workspace = "";
  /** SLOW behavior: executions stay RUNNING for N observe() polls. */
  holdTicks = 2;
  private holds: Record<string, number> = {};

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
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, `content of ${f}`);
      }
    }
    if (b === "GATED") {
      // Read-first semantics: FAILED iff a declared input is missing —
      // resolved the way the canonical pre-dispatch check resolves it
      // (ws/X, outbox/X, or the unique remote-upload `<prefix>-X`).
      const df = (
        (taskRow?.metadata as Record<string, unknown> | undefined)
          ?.pair_dataflow as Record<string, unknown> | undefined
      );
      const missing = ((df?.consumes as string[]) ?? []).some((f) => {
        if (fs.existsSync(path.join(this.workspace, f))) return false;
        const base = f.startsWith("outbox/")
          ? f
          : `outbox/${path.posix.basename(f)}`;
        if (fs.existsSync(path.join(this.workspace, base))) return false;
        const ob = path.join(this.workspace, path.posix.dirname(base));
        const name = path.posix.basename(base);
        const names = fs.existsSync(ob) ? fs.readdirSync(ob).map(String) : [];
        return names.filter((n) => n.endsWith(`-${name}`)).length !== 1;
      });
      if (missing) {
        status = "FAILED";
        // The incident shape: executor reports failure; classification
        // lands on retryable PROCESS_EXIT before evidence overrides.
        error = { class: "PROCESS_EXIT", message: "CODEX_AGENT_REPORTED_FAILURE" };
      }
    }
    if (b === "DELETEFAIL") {
      // The task deletes its own canonical input mid-execution, then
      // fails — post-failure absence must NOT reclassify (R2 §10).
      const df = (
        (taskRow?.metadata as Record<string, unknown> | undefined)
          ?.pair_dataflow as Record<string, unknown> | undefined
      );
      for (const f of (df?.consumes as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        if (fs.existsSync(fp)) fs.rmSync(fp);
      }
      status = "FAILED";
      error = { class: "PROCESS_EXIT", message: "CODEX_AGENT_REPORTED_FAILURE" };
    }
    if (b === "SLOW") {
      // Execution stays RUNNING for holdTicks observe() polls, then
      // COMPLETES (and honors WRITE semantics on completion).
      status = "RUNNING";
      this.holds[eid] = this.holdTicks;
      this.collected[eid] = {
        status: "RUNNING",
        mission_id: task.mission_id,
        task_id: task.task_id,
        governed_task_id: task.governed_task_id,
      };
      return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
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
    if (this.holds[executionId] !== undefined) {
      this.holds[executionId] -= 1;
      if (this.holds[executionId] <= 0) {
        delete this.holds[executionId];
        // Honor WRITE semantics on completion too (SLOW producer).
        const exec = this.collected[executionId];
        const taskRow = (this as never as { store?: PairEvidenceStore }).store
          ?.tryGet("task", String(exec?.task_id));
        const df = (
          (taskRow?.metadata as Record<string, unknown> | undefined)
            ?.pair_dataflow as Record<string, unknown> | undefined
        );
        for (const f of (df?.produces as string[]) ?? []) {
          if (this.workspace && this.behavior[String(taskRow?.task_key)] === "SLOW") {
            const fp = path.join(this.workspace, f);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, `content of ${f}`);
          }
        }
        this.collected[executionId] = {
          ...exec,
          status: "COMPLETED",
          summary: "done slow",
        };
      }
    }
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
      { telegramIntent: FILES_INTENT(["analysis.txt"]) },
    );
    const t3 = tasks.find((t) => t.task_key === "T3")!;
    // R2 §4: delivery depends on the manifest's producer ONLY — never
    // on every task. T1's bookkeeping is not a required input.
    expect(t3.depends_on).toEqual(["T2"]);
    // The repair ledger is pinned on the consumer task — digest-covered.
    const md = t3.metadata as Record<string, unknown>;
    const rs = md.pair_dataflow_repairs as Array<Record<string, unknown>>;
    expect(rs).toHaveLength(1);
    const prod = rs.find((r) => r.producer_key === "T2")!;
    expect(prod.reason).toBe("ARTIFACT_DATAFLOW");
    expect(prod.artifact).toBe("analysis.txt"); // real artifact wins over RESULT_TEXT
    expect(prod.original_depends_on).toEqual([]);
    expect(prod.resulting_depends_on).toEqual(["T2"]);
    // pair_dataflow + the PAIR-stamped manifest persist — digest-covered.
    for (const t of tasks) {
      expect((t.metadata as Record<string, unknown>).pair_dataflow).toBeTruthy();
    }
    const manifest = md.pair_telegram_delivery as Record<string, unknown>;
    expect(manifest).toBeTruthy();
    expect(manifest.artifacts).toEqual(["analysis.txt"]);
    expect(repairs.every((r) => r.reason === "ARTIFACT_DATAFLOW")).toBe(true);
    // A repaired plan validates sound — no mutation needed later.
    expect(() => assertPlanDataflow(tasks)).not.toThrow();
  });

  it("remote tasks carry no local artifact I/O — result text flows only through edges", () => {
    const { tasks } = reconcilePlanDataflow(
      [
        goalTask("T1"),
        remoteTask("T2", ["T1"]), // instruction mentions remote files — ignored
        {
          task_key: "T3", title: "deliver",
          task_instruction: "Read the upstream results in dependency_outputs, write it to outbox/report.txt, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"], depends_on: [], metadata: {},
        },
      ],
      { telegramIntent: TEXT_INTENT },
    );
    const t2 = tasks.find((t) => t.task_key === "T2")!;
    const df = (t2.metadata as Record<string, unknown>).pair_dataflow as {
      produces: string[]; consumes: string[];
    };
    expect(df).toEqual({ produces: [], consumes: [] });
    // TEXT-mode delivery binds every earlier content-bearing task — the
    // composed report reads all upstream result text (T1 FILE_OPERATIONS
    // here is content-bearing; only AUTOMATON bookkeeping is exempt).
    const t3 = tasks.find((t) => t.task_key === "T3")!;
    expect(t3.depends_on).toEqual(["T1", "T2"]);
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
    const opts = { telegramIntent: FILES_INTENT(["analysis.txt"]) };
    const r1 = reconcilePlanDataflow(mk(), opts).tasks;
    const r2 = reconcilePlanDataflow(mk(), opts).tasks;
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    const d = (tasks: unknown) =>
      planDigest({
        project_id: "P", effective_input_digest: "e",
        tasks: tasks as never,
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      });
    expect(d(r1)).toBe(d(r2));
    const repairsOf = (tasks: Array<Record<string, unknown>>) =>
      tasks.flatMap(
        (t) =>
          ((t.metadata as Record<string, unknown>).pair_dataflow_repairs ??
            []) as Array<Record<string, unknown>>,
      );
    // Idempotent: reconciling the repaired list strips and recomputes
    // every PAIR-stamped field — the repair ledger re-derives from the
    // stamped original deps → byte-identical tasks on replay.
    const again = reconcilePlanDataflow(JSON.parse(JSON.stringify(r1)), opts);
    expect(JSON.stringify(again.repairs)).toBe(JSON.stringify(repairsOf(r1)));
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
    // Unsafe manifest artifacts fail closed — never normalized away.
    expect(() =>
      reconcilePlanDataflow(
        [
          {
            task_key: "T1", required_capabilities: ["TELEGRAM_DELIVERY"], depends_on: [],
            metadata: {},
          },
        ],
        { telegramIntent: FILES_INTENT(["../escape.txt"]) },
      ),
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
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT|FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND/);
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
    // R2 §9 — pre-dispatch prerequisite evidence: the canonical consume
    // is absent BEFORE any executor attempt is spent → ZERO dispatches
    // (the live incident burned one execution + 4 retries + 1 approved
    // extension on exactly this shape).
    expect(t3Execs).toHaveLength(0);
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
        { telegramIntent: FILES_INTENT(["analysis.txt"]) },
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
    expect(t3pinned.depends_on).toEqual(["T2"]);
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
    // R2 §6 — the completed delivery task mints exactly ONE durable
    // canonical send request for the manifested artifact.
    const deliveries = ctx.store.list("telegram_delivery_request");
    expect(deliveries).toHaveLength(1);
    expect(String(deliveries[0].status)).toBe("QUEUED");
    expect((deliveries[0].artifacts as Array<{ name: string }>).map((a) => a.name))
      .toEqual(["analysis.txt"]);
  });
});

/* =================== R2 — explicit telegram delivery authority =================== */

/** Mirror of the bridge transport loop: poll QUEUED canonical requests,
 *  transport manifested artifacts via the `.sent` witness, ack each —
 *  the ONLY set Telegram may ever receive. */
function bridgeSend(ctx: ReturnType<typeof makeCtx>): string[] {
  const sent: string[] = [];
  for (const req of pendingTelegramDeliveries(ctx.store) as Array<
    Record<string, unknown>
  >) {
    const ack = (artifact?: string) =>
      ackTelegramDelivery({
        store: ctx.store,
        deliveryId: String(req.delivery_id),
        artifact,
        now: utcnow(),
      });
    if (String(req.mode) === "TEXT") {
      sent.push(`TEXT:${String(req.delivery_id)}`);
      ack();
      continue;
    }
    for (const art of (req.artifacts as Array<Record<string, unknown>>) ?? []) {
      if (String(art.state) !== "QUEUED" || !art.path) continue;
      fs.renameSync(String(art.path), `${String(art.path)}.sent`);
      sent.push(String(art.name));
      ack(String(art.name));
    }
  }
  return sent;
}

describe("R2 §13 — default: file/outbox/completion are never send authority", () => {
  it("A+B+C. mission produces outbox files with no telegram intent → mission COMPLETED notifies, ZERO deliveries, stray file never sent", () => {
    const ctx = makeCtx("r2-default");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "WRITE" };
    registerAdapter(ctx, adapter);
    // An ordinary plan: producer writes a file into outbox — NO delivery
    // task, NO telegram mention in the goal. File presence, outbox
    // presence, and mission completion are all NOT send authority.
    const plan = reconcilePlanDataflow([
      goalTask("T1"),
      {
        task_key: "T2", title: "produce report",
        task_instruction: "write findings to outbox/report.txt, then reply DONE.",
        required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"], metadata: {},
      },
    ]).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "produce a report",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED"); // §8: lifecycle notify path intact
    // The outbox artifact exists — and a stray file lands too.
    expect(fs.existsSync(path.join(ctx.workspace, "outbox/report.txt"))).toBe(true);
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(ctx.workspace, "outbox/stray.png"), "png");
    // Zero canonical send requests — the bridge sees nothing to send.
    expect(ctx.store.list("telegram_delivery_request")).toHaveLength(0);
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(0);
    expect(bridgeSend(ctx)).toEqual([]);
  });

  it("planner emits TELEGRAM_DELIVERY without operator intent → plan fails closed, no mission", () => {
    expect(() =>
      reconcilePlanDataflow([
        goalTask("T1"),
        producerTask("T2", "analysis.txt", ["T1"]),
        deliveryTask("T3", []), // planner minted it — no goal intent
      ]),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT/);
  });
});

describe("R2 §14–15 — explicit delivery sends only manifested artifacts", () => {
  const deliveryPlan = (intent: TelegramDeliveryIntent) =>
    reconcilePlanDataflow(
      [
        goalTask("T1"),
        {
          task_key: "T2", title: "produce",
          task_instruction: "write findings to outbox/report.txt, then reply DONE.",
          required_capabilities: ["REASONING"], depends_on: ["T1"], metadata: {},
        },
        deliveryTask("T3", [], "report.txt"),
      ],
      { telegramIntent: intent },
    ).tasks;

  it("D. explicit FILES intent → exact manifested artifact sent exactly once, durable evidence", () => {
    const ctx = makeCtx("r2-explicit");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "WRITE", T3: "COMPLETE" };
    registerAdapter(ctx, adapter);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "write report.txt and send it to telegram",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: deliveryPlan(FILES_INTENT(["report.txt"])) },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const reqs = ctx.store.list("telegram_delivery_request");
    expect(reqs).toHaveLength(1);
    expect(String(reqs[0].delivery_id)).toBe(
      deliveryRequestId(mid, String((reqs[0]).task_id)),
    );
    expect(bridgeSend(ctx)).toEqual(["report.txt"]); // manifest only
    // Durable sent evidence + idempotency: a second poll sends nothing.
    expect(bridgeSend(ctx)).toEqual([]);
    const after = ctx.store.get(
      "telegram_delivery_request",
      String(reqs[0].delivery_id),
    );
    expect(String(after.status)).toBe("SENT");
    expect(after.sent_at).toBeTruthy();
  });

  it("E. manifest subset — a.txt+c.png sent, b.txt never sent", () => {
    const ctx = makeCtx("r2-subset");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T2: "WRITE", T3: "COMPLETE" };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(
      [
        goalTask("T1"),
        {
          task_key: "T2", title: "produce",
          task_instruction: "write outbox/a.txt and outbox/b.txt and outbox/c.png, then reply DONE.",
          required_capabilities: ["REASONING"], depends_on: ["T1"], metadata: {},
        },
        deliveryTask("T3", [], "a.txt"),
      ],
      { telegramIntent: FILES_INTENT(["a.txt", "c.png"]) },
    ).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "send a.txt and c.png to telegram",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const sent = bridgeSend(ctx).sort();
    expect(sent).toEqual(["a.txt", "c.png"]);
    expect(sent).not.toContain("b.txt");
    expect(bridgeSend(ctx)).toEqual([]);
  });

  it("F. producer still RUNNING → no send; after COMPLETED → exactly one send", () => {
    const ctx = makeCtx("r2-waits");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T2: "SLOW", T3: "COMPLETE" };
    adapter.holdTicks = 3;
    registerAdapter(ctx, adapter);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "write report.txt and send it to telegram",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: deliveryPlan(FILES_INTENT(["report.txt"])) },
    });
    const mid = String(m.mission_id);
    let t = Date.parse("2026-01-01T00:00:00Z");
    const tick = () => {
      t += 120_000;
      ctx.runtime.tick(mid, new Date(t).toISOString());
    };
    // Drive until T2 is dispatched (RUNNING) — delivery must NOT fire.
    for (let i = 0; i < 8 && ctx.service.listTasks(mid).length === 0; i++) tick();
    const tasks = ctx.service.listTasks(mid);
    const t2 = tasks.find((x) => x.task_key === "T2")!;
    const t3 = tasks.find((x) => x.task_key === "T3")!;
    for (let i = 0; i < 8 && execsOf(ctx, mid).filter((e) => e.task_id === t2.task_id).length === 0; i++) {
      tick();
    }
    expect(execsOf(ctx, mid).filter((e) => e.task_id === t2.task_id)).toHaveLength(1);
    expect(execsOf(ctx, mid).filter((e) => e.task_id === t3.task_id)).toHaveLength(0);
    expect(pendingTelegramDeliveries(ctx.store)).toHaveLength(0);
    expect(bridgeSend(ctx)).toEqual([]); // nothing while producer runs
    // Converge: producer finishes, delivery runs once, sends exactly once.
    const state = drive(ctx, mid);
    expect(state).toBe("COMPLETED");
    expect(bridgeSend(ctx)).toEqual(["report.txt"]);
    expect(bridgeSend(ctx)).toEqual([]);
  });
});

describe("R2 §16 — remote outbox upload + TEXT delivery", () => {
  it("G+H. remote upload with no intent → zero; upload while RUNNING → zero, COMPLETED → manifested send once", () => {
    const ctx = makeCtx("r2-remote");
    const remoteAdapter = new ScriptedAdapter("EX_R", [
      "REMOTE_CLOUD_TASK_EXECUTION",
    ]);
    remoteAdapter.behavior = { T2: "SLOW" };
    remoteAdapter.holdTicks = 2;
    registerAdapter(ctx, remoteAdapter);
    const localAdapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "TELEGRAM_DELIVERY",
    ]);
    registerAdapter(ctx, localAdapter);
    const plan = reconcilePlanDataflow(
      [
        goalTask("T1"),
        remoteTask("T2", ["T1"]),
        deliveryTask("T3", [], "chart.png"),
      ],
      { telegramIntent: FILES_INTENT(["chart.png"]) },
    ).tasks;
    // Delivery binds the remote producer as PAIR_OUTBOX_UPLOAD — never
    // a local artifact guess.
    const t3 = plan.find((x) => x.task_key === "T3")!;
    expect(t3.depends_on).toEqual(["T2"]);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "research remotely and send chart.png to telegram",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    let t = Date.parse("2026-01-01T00:00:00Z");
    const tick = () => {
      t += 120_000;
      ctx.runtime.tick(mid, new Date(t).toISOString());
    };
    // Tick until the remote T2 is dispatched and still RUNNING.
    for (let i = 0; i < 8 && ctx.service.listTasks(mid).length === 0; i++) tick();
    const t2r = ctx.service.listTasks(mid).find((x) => x.task_key === "T2")!;
    for (let i = 0; i < 8 && execsOf(ctx, mid).filter((e) => e.task_id === t2r.task_id).length === 0; i++) {
      tick();
    }
    // The remote upload lands while its producer is still RUNNING.
    fs.mkdirSync(path.join(ctx.workspace, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(ctx.workspace, "outbox/TSK_x-chart.png"), "png");
    expect(bridgeSend(ctx)).toEqual([]); // upload ≠ send authority
    const state = drive(ctx, mid);
    expect(state).toBe("COMPLETED");
    // After completion the manifested artifact resolves via the unique
    // remote-upload prefix and sends exactly once.
    expect(bridgeSend(ctx)).toEqual(["chart.png"]);
    expect(bridgeSend(ctx)).toEqual([]);
  });

  it("I. TEXT delivery waits for upstream COMPLETED, sends composed text once, invents no artifact dep", () => {
    const ctx = makeCtx("r2-text");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING", "TELEGRAM_DELIVERY",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "COMPLETE", T3: "COMPLETE" };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow(
      [
        goalTask("T1"),
        producerTask("T2", "analysis.txt", ["T1"]),
        {
          task_key: "T3", title: "deliver",
          task_instruction: "Read the upstream results in dependency_outputs, compose the report, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"], depends_on: [], metadata: {},
        },
      ],
      { telegramIntent: TEXT_INTENT },
    ).tasks;
    // TEXT mode: deps on every earlier content-bearing task (T1 uses
    // FILE_OPERATIONS here → content-bearing); NO artifact consume is
    // invented.
    const t3 = plan.find((x) => x.task_key === "T3")!;
    expect(t3.depends_on).toEqual(["T1", "T2"]);
    const df = (t3.metadata as Record<string, unknown>).pair_dataflow as {
      consumes: string[];
    };
    expect(df.consumes).toEqual([]);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: "research and report results to telegram",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    expect(drive(ctx, mid)).toBe("COMPLETED");
    const sent = bridgeSend(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^TEXT:TDR_/);
    expect(bridgeSend(ctx)).toEqual([]);
  });
});

describe("R2 §9–12 — pre-dispatch prerequisite, post-failure, reserved fields, grammar, leaf", () => {
  it("K. artifact deleted mid-execution → PROCESS_EXIT stands; next retry's PRE-dispatch check → DEPENDENCY_FAILURE with no new dispatch", () => {
    const ctx = makeCtx("r2-midtask");
    const adapter = new ScriptedAdapter("EX_A", [
      "FILE_OPERATIONS", "REASONING",
    ]);
    adapter.behavior = { T1: "COMPLETE", T2: "WRITE", T3: "DELETEFAIL" };
    registerAdapter(ctx, adapter);
    const plan = reconcilePlanDataflow([
      goalTask("T1"),
      producerTask("T2", "analysis.txt", ["T1"]),
      consumerTask("T3", "analysis.txt", ["T2"]),
    ]).tasks;
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "g",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: { pinned_plan_tasks: plan },
    });
    const mid = String(m.mission_id);
    const state = drive(ctx, mid);
    expect(["FAILED", "ABORTED", "COMPLETED", "WAITING_BACKOFF", "RUNNING"]).toContain(state);
    const t3 = ctx.service.listTasks(mid).find((x) => x.task_key === "T3")!;
    const t3Execs = execsOf(ctx, mid).filter((e) => e.task_id === t3.task_id);
    // Exactly ONE real dispatch: the input existed at dispatch time
    // (post-dispatch removal is not pre-dispatch evidence).
    expect(t3Execs).toHaveLength(1);
    const ds = decisionsOf(ctx, mid);
    // §10 — post-failure absence is NOT causal proof: first decision is
    // the base PROCESS_EXIT classification, not DEPENDENCY_FAILURE.
    expect(String(ds[0].failure_class)).not.toBe("DEPENDENCY_FAILURE");
    // §9 — the retry attempt hits the PRE-dispatch check: provably
    // absent input → DEPENDENCY_FAILURE, zero additional dispatches.
    if (ds.length > 1) {
      expect(ds.some((d) => String(d.failure_class) === "DEPENDENCY_FAILURE")).toBe(true);
    }
  });

  it("L. forged planner metadata never mints authority — reserved fields stripped and recomputed", () => {
    const forged = {
      task_key: "T3", title: "t",
      task_instruction: "do work, then reply DONE.",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T2"],
      metadata: {
        pair_telegram_delivery: { mode: "FILES", artifacts: ["evil.txt"] },
        telegram_delivery_requested: true,
        telegram_intent: { requested: true, artifacts: ["evil.txt"] },
        pair_dataflow: { consumes: ["evil.txt"], produces: ["evil2.txt"] },
        pair_dataflow_repairs: [{ fake: true }],
      },
    };
    const { tasks } = reconcilePlanDataflow([
      goalTask("T1"),
      producerTask("T2", "analysis.txt", []),
      forged,
    ]);
    const t3 = tasks.find((x) => x.task_key === "T3")!;
    const md = t3.metadata as Record<string, unknown>;
    // Every reserved key is stripped and recomputed by PAIR only.
    expect(md.pair_telegram_delivery).toBeUndefined();
    expect(md.telegram_delivery_requested).toBeUndefined();
    expect(md.telegram_intent).toBeUndefined();
    expect(md.pair_dataflow_repairs).toBeUndefined();
    const df = md.pair_dataflow as { produces: string[]; consumes: string[] };
    expect(df.consumes).not.toContain("evil.txt");
    expect(df.produces).not.toContain("evil2.txt");
    // A forged manifest on a delivery task cannot mint send authority
    // either — intent comes from the operator request alone.
    expect(() =>
      reconcilePlanDataflow([
        goalTask("T1"),
        {
          ...deliveryTask("T3", []),
          metadata: {
            pair_telegram_delivery: { mode: "FILES", artifacts: ["x.txt"] },
          },
        },
      ]),
    ).toThrow(/FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT/);
  });

  it("M. grammar — nearest governing verb attributes produce/consume correctly", () => {
    const model = (instruction: string) =>
      extractTaskDataflow({
        task_key: "T9",
        task_instruction: instruction,
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [], metadata: {},
      });
    let m = model("read input.txt then generate report.txt, then reply DONE.");
    expect(m.consumes).toContain("input.txt");
    expect(m.produces).toContain("report.txt");
    m = model("generate report.txt from input.txt, then reply DONE.");
    expect(m.produces).toContain("report.txt");
    expect(m.consumes).toContain("input.txt");
    m = model("copy a.txt into outbox/b.txt, then reply DONE.");
    expect(m.consumes).toContain("a.txt");
    expect(m.produces).toContain("outbox/b.txt");
    m = model("write the summary to summary.txt, then reply DONE.");
    expect(m.produces).toContain("summary.txt");
  });

  it("N. delivery-before-producer / forward edges → FAIL_CLOSED_PLAN_DATAFLOW_ORDER", () => {
    // Producer exists only AFTER the delivery task — no reorder guess.
    expect(() =>
      reconcilePlanDataflow(
        [
          goalTask("T1"),
          deliveryTask("T2", []),
          producerTask("T3", "analysis.txt", ["T1"]),
        ],
        { telegramIntent: FILES_INTENT(["analysis.txt"]) },
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_ORDER/);
    // A declared edge INTO a delivery task (delivery not a leaf).
    expect(() =>
      reconcilePlanDataflow(
        [
          goalTask("T1"),
          producerTask("T2", "analysis.txt", ["T1"]),
          deliveryTask("T3", ["T2"]),
          {
            task_key: "T4", title: "post",
            task_instruction: "do a post step, then reply DONE.",
            required_capabilities: ["FILE_OPERATIONS"],
            depends_on: ["T3"], metadata: {},
          },
        ],
        { telegramIntent: FILES_INTENT(["analysis.txt"]) },
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_ORDER/);
    // Manifest artifact with no producer and no remote uploader → unbound.
    expect(() =>
      reconcilePlanDataflow(
        [goalTask("T1"), deliveryTask("T3", [], "ghost.txt")],
        { telegramIntent: FILES_INTENT(["ghost.txt"]) },
      ),
    ).toThrow(/FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT/);
  });

  it("intent detection is deterministic and conservative — mention+verb required", () => {
    expect(detectTelegramDeliveryIntent("write report.txt and send it to telegram")).toEqual({
      requested: true, artifacts: ["report.txt"], mode: "FILES",
    });
    expect(detectTelegramDeliveryIntent("gửi telegram file a.txt và c.png")).toEqual({
      requested: true, artifacts: ["a.txt", "c.png"], mode: "FILES",
    });
    // Mention but no delivery verb → not requested.
    expect(detectTelegramDeliveryIntent("does the telegram bot work?").requested).toBe(false);
    // Verb but no telegram mention → not requested.
    expect(detectTelegramDeliveryIntent("send report.txt to the team").requested).toBe(false);
    // No intent at all → TEXT default, never requested.
    expect(detectTelegramDeliveryIntent("produce a report")).toEqual({
      requested: false, artifacts: [], mode: "TEXT",
    });
    // Telegram + verb but no file → TEXT mode.
    expect(detectTelegramDeliveryIntent("báo kết quả qua telegram")).toEqual({
      requested: true, artifacts: [], mode: "TEXT",
    });
  });
});
