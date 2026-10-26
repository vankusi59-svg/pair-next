/**
 * Phase F5 — REMOTE PRODUCER CANONICAL ARTIFACT CLOSURE.
 *
 * Proves the terminal invariant: when a governed REMOTE task's pinned
 * execution contract carries `expected_output_contract.declared_produces`,
 * execution validation may only reach PASS once EVERY declared logical
 * name resolves to exactly ONE canonical verified artifact identity
 * belonging to THAT execution. Completion prose, remote workspace files,
 * executor claims, filenames and shared-outbox contents grant zero
 * artifact authority.
 *
 * Seams under test:
 *   F5.1 requestFor pins normalized declared_produces into the governed
 *        contract (digest-covered, immutable) — remote tasks only.
 *   F5.2 Devin prompt enumerates mandatory uploads through the existing
 *        execution-scoped acap1 lane; lane-missing fails before spend.
 *   F5.3 ArtifactProvenanceValidator terminal closure gate.
 *   F5.4 settleExecution maps produces-incomplete to typed
 *        DEPENDENCY_FAILURE on the producer task.
 *   F5.5 structural lane feasibility at the governed-request boundary.
 *   F5.6 semantic digest coverage is inherited from F3 (produces already
 *        inside canonicalPlanSemanticDigest) — asserted here end-to-end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  ArtifactProvenanceValidator,
  artifactNamesEquivalent,
  canonicalArtifactId,
  DependencyResolutionError,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  mintArtifactCapability,
  normalizeDeclaredProduces,
  PairControlPlane,
  PairEvidenceStore,
  reconcilePlanDataflow,
  ReconciliationService,
  RecoveryController,
  remoteIngestLaneAvailable,
  sha256Hex,
  TRANSPORT_IN_PROCESS,
  utcnow,
  workerExecutionId,
  DevinExecutorAdapter,
} from "../pair/index.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { digest } from "../pair/canonical.js";

const ROOT = mkTmpDir("pair-f5-");
let n = 0;
const freshDir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const MASTER = "f5-artifact-master";
const EX_REMOTE = "EX_REMOTE_F5";
const EX_LOCAL = "EX_LOCAL_F5";
const OUTBOX_URL = "http://pair.test";

const LANE_ENV = {
  PAIR_OUTBOX_URL: OUTBOX_URL,
  PAIR_ARTIFACT_UPLOAD_TOKEN: MASTER,
} as const;

/* ------------------------------ ctx / stack ------------------------------ */

class ScriptedAdapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatchedTasks: Array<Record<string, unknown>> = [];
  results: Record<string, Record<string, unknown>> = {};
  workspace = "";
  /** Hook invoked inside collect_result BEFORE the result is returned —
   *  tests use it to perform the remote canonical upload at the correct
   *  point in the lifecycle. */
  onCollect?: (executionId: string) => void;
  private wrote: Record<string, string[]> = {};
  behavior: Record<string, "COMPLETE" | "FAIL" | "WRITE" | "SKIPWRITE"> = {};
  fileContent: Record<string, string> = {};
  private store?: PairEvidenceStore;

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
    const eid = `EXEC_${this.executor_id}_${this.dispatchedTasks.length}`;
    this.dispatchedTasks.push(task);
    const taskRow = this.store?.tryGet("task", String(task.task_id));
    const key = String(taskRow?.task_key ?? "");
    const b = this.behavior[key] ?? "COMPLETE";
    let status = "COMPLETED";
    const df = (
      (taskRow?.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined
    );
    if (b === "WRITE" && this.workspace) {
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, this.fileContent[key] ?? `content of ${f}`);
        (this.wrote[eid] ??= []).push(f);
      }
    }
    if (b === "SKIPWRITE" && this.workspace) {
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        if (fs.existsSync(fp)) fs.rmSync(fp);
      }
    }
    if (b === "FAIL") status = "FAILED";
    this.results[eid] = {
      status,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      ...(status === "FAILED"
        ? { error: { class: "PROCESS_EXIT", message: "FAILED" } }
        : { summary: `done ${key}` }),
    };
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe(executionId: string) {
    return { status: String(this.results[executionId]?.status ?? "RUNNING") };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    this.onCollect?.(executionId);
    const r = this.results[executionId] ?? {
      status: "FAILED",
      error: { class: "MISSING" },
    };
    // Remote executions NEVER carry local artifact declarations — remote
    // produces reach canonical authority only through the upload lane.
    const artifacts = (this.wrote[executionId] ?? [])
      .map((f) => {
        const fp = path.join(this.workspace, f);
        if (!fs.existsSync(fp)) return null;
        const bytes = fs.readFileSync(fp);
        return { path: f, sha256: sha256Hex(bytes), byte_size: bytes.length };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    return { execution_id: executionId, artifacts, ...r };
  }
}

function wireStack(
  name: string,
  workspace: string,
  store: PairEvidenceStore,
  opts: { projectId?: string } = {},
) {
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const planner = (input: { mission: Record<string, unknown> }) => {
    const pinned = input.mission?.metadata?.pinned_plan_tasks as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(pinned) && pinned.length) return { tasks: pinned };
    return { tasks: [goalTask()] };
  };
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
    telegramDeliveryDefaultChatId: "111",
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
  const projectId =
    opts.projectId !== undefined
      ? opts.projectId
      : String(service.createProject({ name, root_location: workspace }).project_id);
  return {
    service, gate, registry, router, recovery, recon,
    approvals, scheduler, runtime, supervisor, control, adapters,
    projectId,
  };
}

function makeCtx(name: string) {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  return { dir, workspace, store, ...wireStack(name, workspace, store) };
}

function registerAdapter(
  ctx: ReturnType<typeof makeCtx>,
  adapter: ScriptedAdapter,
) {
  adapter.workspace = ctx.workspace;
  (adapter as unknown as { store: PairEvidenceStore }).store = ctx.store;
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

/* ------------------------------ plan fixtures ---------------------------- */

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

/** T2 remote producer declares produces; T3 local consumer declares the
 *  matching consume edge. */
const remoteProducerPlan = (produces = ["data.json"]) => [
  goalTask("T1"),
  {
    task_key: "T2",
    title: "fetch data",
    task_instruction: `fetch market data and write ${produces.join(",")}, then reply DONE.`,
    required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
    depends_on: ["T1"],
    metadata: {},
  },
  {
    task_key: "T3",
    title: "write report",
    task_instruction:
      `read ${produces.join(",")} and write the report to outbox/report.md, then reply DONE.`,
    required_capabilities: ["FILE_OPERATIONS"],
    depends_on: ["T2"],
    metadata: {},
  },
];

/* ------------------------------ drive helpers ---------------------------- */

const rt = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.get("mission_runtime", `MRT_${mid}`);
const evidence = (ctx: ReturnType<typeof makeCtx>, mid: string, kind: string) =>
  ctx.store.listEvidence(mid).filter((e) => String(e.kind) === kind);
const tasks = (ctx: ReturnType<typeof makeCtx>, mid: string) =>
  ctx.store.list("task").filter((t) => String(t.mission_id) === mid);
const taskByKey = (
  ctx: ReturnType<typeof makeCtx>,
  mid: string,
  key: string,
) => tasks(ctx, mid).find((t) => String(t.task_key) === key);
const executions = (ctx: ReturnType<typeof makeCtx>) =>
  ctx.store.list("executor_execution");
const execForTask = (ctx: ReturnType<typeof makeCtx>, taskId: string) =>
  executions(ctx).find((e) => String(e.task_id) === taskId);
const governedForTask = (ctx: ReturnType<typeof makeCtx>, taskId: string) =>
  ctx.store
    .list("governed_task")
    .find((g) => String(g.task_id) === taskId);

function drive(ctx: ReturnType<typeof makeCtx>, mid: string, max = 160) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    ctx.runtime.tick(mid, new Date(t).toISOString());
    const s = String(rt(ctx, mid).state);
    if (
      ["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"].includes(s)
    ) {
      return s;
    }
  }
  return String(rt(ctx, mid).state);
}

/** One mission start + drive helper with the upload lane env set. */
function startMission(
  ctx: ReturnType<typeof makeCtx>,
  plan: Array<Record<string, unknown>>,
) {
  return ctx.control.startMission({
    project_id: ctx.projectId,
    goal: "f5 remote producer mission",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
    metadata: { pinned_plan_tasks: plan },
  });
}

/** Upload through the ONE canonical remote lane (equivalent to the
 *  remote worker's curl POST /api/outbox). */
function upload(
  ctx: ReturnType<typeof makeCtx>,
  exec: Record<string, unknown>,
  filename: string,
  bytes: Buffer | string,
) {
  const cap = mintArtifactCapability(MASTER, {
    mission_id: String(exec.mission_id),
    task_id: String(exec.task_id),
    governed_task_id: String(exec.governed_task_id),
    execution_id: String(exec.execution_id),
    executor_id: String(exec.executor_id),
  });
  return ctx.control.acceptArtifactUpload(MASTER, cap, {
    filename,
    mission_id: String(exec.mission_id),
    task_id: String(exec.task_id),
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
  });
}

/** Recompute the governed approval-scope digest — mirrors gate.ts mint
 *  order exactly; a drift here means the mutation guard fires. */
function scopeDigest(governed: Record<string, unknown>): string {
  return digest({
    mission_id: governed.mission_id,
    task_id: governed.task_id,
    executor_id: governed.executor_id,
    workspace: String(governed.workspace),
    allowed_paths: governed.allowed_paths,
    permissions: governed.permissions ?? [],
    expected_output_contract: governed.expected_output_contract,
    dependency_artifacts_digest: governed.dependency_artifacts_digest,
  });
}

/** Hand-built remote producer chain (task + governed + execution) —
 *  the same row shapes the governed gate persists at dispatch, with the
 *  F5-pinned declared_produces contract and a correct scope digest. */
let seq = 0;
function mkRemoteProducer(
  ctx: ReturnType<typeof makeCtx>,
  o: {
    produces: string[];
    missionId: string;
    executor?: string;
    contractExtra?: Record<string, unknown>;
    planId?: string;
  },
) {
  const tid = `RTSK_${seq++}_${o.missionId.slice(-4)}`;
  const gtId = `GT_${tid}`;
  const executor = o.executor ?? EX_REMOTE;
  const eid = workerExecutionId(executor, gtId);
  const contract = {
    type: "TASK_RESULT",
    declared_produces: [...o.produces].sort(),
    ...(o.contractExtra ?? {}),
  };
  ctx.store.put(
    "task",
    tid,
    {
      task_id: tid, task_key: `TK_${seq}`, mission_id: o.missionId,
      title: "remote producer",
      task_instruction: "produce remotely",
      required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
      depends_on: [], status: "READY",
      metadata: { pair_dataflow: { produces: o.produces, consumes: [] } },
      version: 0,
    },
    0,
  );
  const governed: Record<string, unknown> = {
    governed_task_id: gtId, mission_id: o.missionId, task_id: tid,
    correlation_id: `COR_${tid}`, executor_id: executor,
    plan_id: o.planId ?? "PLAN_F5", plan_revision: 1,
    workspace: ctx.workspace, allowed_paths: [ctx.workspace],
    permissions: [], dependency_artifacts_digest: null,
    expected_output_contract: contract,
    governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
    created_at: utcnow(), version: 0,
  };
  governed.approval_scope_digest = scopeDigest(governed);
  ctx.store.put("governed_task", gtId, governed, 0);
  // F5 R1.B — emit the immutable GOVERNED_TASK_VALIDATED mint anchor
  // exactly as the gate does (event + evidence), binding the mint-time
  // F5 contract + scope digest.
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: gtId,
    event_type: "GOVERNED_TASK_VALIDATED",
    new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${tid}`,
    metadata: {
      mission_id: o.missionId, task_id: tid, executor_id: executor,
      governed_task_id: gtId,
      plan_id: o.planId ?? "PLAN_F5", plan_revision: 1,
      approval_scope_digest: governed.approval_scope_digest,
      remote_produces_contract: true,
      declared_produces: [...o.produces].sort(),
      declared_produces_digest: digest([...o.produces].sort()),
    },
  });
  ctx.store.appendEvidence(o.missionId, "GOVERNED_TASK_VALIDATED", {
    governed_task_id: gtId, task_id: tid, executor_id: executor,
    mission_id: o.missionId,
    plan_id: o.planId ?? "PLAN_F5", plan_revision: 1,
    approval_scope_digest: governed.approval_scope_digest,
    remote_produces_contract: true,
    declared_produces: [...o.produces].sort(),
    declared_produces_digest: digest([...o.produces].sort()),
  });
  // Execution stays OPEN (RUNNING, no result) — remote uploads may only
  // land while the execution is open; the result is persisted at settle.
  ctx.store.put(
    "executor_execution",
    eid,
    {
      execution_id: eid, governed_task_id: gtId, mission_id: o.missionId,
      task_id: tid, executor_id: executor, correlation_id: `COR_${tid}`,
      plan_id: o.planId ?? "PLAN_F5", plan_revision: 1,
      execution_state: "RUNNING", dispatch_timestamp: utcnow(),
      workspace: ctx.workspace,
      version: 0,
    },
    0,
  );
  return { tid, gtId, eid, executor };
}

/** Persist the remote worker's completion result (after any uploads). */
function completeRemote(ctx: ReturnType<typeof makeCtx>, eid: string) {
  const exec = ctx.store.get("executor_execution", eid);
  ctx.store.put(
    "executor_execution",
    eid,
    {
      ...exec,
      execution_state: "COMPLETED",
      result: { status: "COMPLETED", artifacts: [], summary: "remote done" },
    },
    Number(exec.version),
  );
}

const validate = (ctx: ReturnType<typeof makeCtx>, eid: string) =>
  new ArtifactProvenanceValidator().validate_execution(ctx.service, eid);

const validationRow = (ctx: ReturnType<typeof makeCtx>, eid: string) =>
  ctx.store
    .list("execution_validation")
    .filter((v) => String(v.execution_id) === eid)
    .at(-1) as Record<string, unknown> | undefined;

afterEach(() => vi.restoreAllMocks());

/* ================================ tests ================================== */

describe("F5.1 — declared_produces pinned into the governed contract", () => {
  it("P1. remote task's pair_dataflow.produces is normalized + pinned + digest-covered", () => {
    const ctx = makeCtx("f5-p1");
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
      const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
      registerAdapter(ctx, remote);
      registerAdapter(ctx, local);
      const plan = reconcilePlanDataflow(
        remoteProducerPlan([" data.json ", "b.txt", "data.json"]),
      ).tasks;
      const m = startMission(ctx, plan);
      const mid = String(m.mission_id);
      // Drive until T2 dispatches (its settle will fail — we only need the
      // pinned governed row).
      let t = Date.parse("2026-01-01T00:00:00Z");
      for (let i = 0; i < 40; i++) {
        const t2 = taskByKey(ctx, mid, "T2");
        if (t2 && execForTask(ctx, String(t2.task_id))) break;
        t += 120_000;
        ctx.runtime.tick(mid, new Date(t).toISOString());
      }
      const t2 = taskByKey(ctx, mid, "T2")!;
      const governed = governedForTask(ctx, String(t2.task_id));
      expect(governed).toBeTruthy();
      const contract = governed!.expected_output_contract as Record<
        string,
        unknown
      >;
      // Normalized: trimmed, deduped, sorted.
      expect(contract.declared_produces).toEqual(["b.txt", "data.json"]);
      // Digest-covered: the pinned contract is inside the approval scope.
      expect(String(governed!.approval_scope_digest)).toBe(scopeDigest(governed!));
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });

  it("P2. remote task with NO produces pins an empty declared set; local task is untouched", () => {
    const ctx = makeCtx("f5-p2");
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
      const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
      registerAdapter(ctx, remote);
      registerAdapter(ctx, local);
      // T2 remote produces nothing; T3 local consumes nothing extra.
      const plan = [
        goalTask("T1"),
        {
          task_key: "T2",
          title: "remote analyze",
          task_instruction: "analyze remotely, return findings, then reply DONE.",
          required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
          depends_on: ["T1"],
          metadata: {},
        },
      ];
      const m = startMission(ctx, plan as never);
      const mid = String(m.mission_id);
      let t = Date.parse("2026-01-01T00:00:00Z");
      for (let i = 0; i < 40; i++) {
        const t2 = taskByKey(ctx, mid, "T2");
        if (t2 && execForTask(ctx, String(t2.task_id))) break;
        t += 120_000;
        ctx.runtime.tick(mid, new Date(t).toISOString());
      }
      const t2 = taskByKey(ctx, mid, "T2")!;
      const governed = governedForTask(ctx, String(t2.task_id))!;
      const contract = governed.expected_output_contract as Record<
        string,
        unknown
      >;
      expect(contract.declared_produces).toEqual([]);
      const t1 = taskByKey(ctx, mid, "T1")!;
      const localGoverned = governedForTask(ctx, String(t1.task_id));
      if (localGoverned) {
        const lc = localGoverned.expected_output_contract as Record<
          string,
          unknown
        >;
        expect("declared_produces" in lc).toBe(false);
      }
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });

  it("U1. normalizeDeclaredProduces: dedupe/sort/trim + invalid fails closed", () => {
    const task = { task_id: "TSK_U1" };
    expect(
      normalizeDeclaredProduces([" b.json", "a.json", "a.json", "c.json "], task),
    ).toEqual(["a.json", "b.json", "c.json"]);
    expect(normalizeDeclaredProduces(undefined, task)).toEqual([]);
    expect(normalizeDeclaredProduces([], task)).toEqual([]);
    for (const bad of ["x", 5, [1], [""], [["a"]], { nested: true }]) {
      expect(() => normalizeDeclaredProduces(bad, task)).toThrowError(
        DependencyResolutionError,
      );
      try {
        normalizeDeclaredProduces(bad, task);
        expect.unreachable();
      } catch (e) {
        expect((e as DependencyResolutionError).code).toBe(
          "FAIL_CLOSED_DECLARED_PRODUCES_INVALID",
        );
      }
    }
    const tooMany = Array.from({ length: 33 }, (_, i) => `f${i}.txt`);
    try {
      normalizeDeclaredProduces(tooMany, task);
      expect.unreachable();
    } catch (e) {
      expect((e as DependencyResolutionError).code).toBe(
        "FAIL_CLOSED_DECLARED_PRODUCES_BOUNDS",
      );
    }
  });

  it("U2. remoteIngestLaneAvailable — env matrix", () => {
    expect(remoteIngestLaneAvailable(LANE_ENV as never)).toBe(true);
    expect(
      remoteIngestLaneAvailable({ PAIR_OUTBOX_URL: OUTBOX_URL } as never),
    ).toBe(false);
    expect(
      remoteIngestLaneAvailable({ PAIR_ARTIFACT_UPLOAD_TOKEN: MASTER } as never),
    ).toBe(false);
    expect(
      remoteIngestLaneAvailable({
        PAIR_OUTBOX_URL: "  ",
        PAIR_ARTIFACT_UPLOAD_TOKEN: MASTER,
      } as never),
    ).toBe(false);
    // Broker token is the documented fallback master.
    expect(
      remoteIngestLaneAvailable({
        PAIR_OUTBOX_URL: OUTBOX_URL,
        PAIR_BROKER_TOKEN: "broker",
      } as never),
    ).toBe(true);
  });
});

describe("F5.5 — structural lane feasibility before remote spend", () => {
  it("L1. remote task with produces + NO ingest lane → DEPENDENCY_FAILURE, zero dispatch", () => {
    const ctx = makeCtx("f5-l1");
    delete process.env.PAIR_OUTBOX_URL;
    delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    delete process.env.PAIR_BROKER_TOKEN;
    const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
    const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
    registerAdapter(ctx, remote);
    registerAdapter(ctx, local);
    const plan = reconcilePlanDataflow(remoteProducerPlan(["data.json"])).tasks;
    const m = startMission(ctx, plan);
    const mid = String(m.mission_id);
    const state = drive(ctx, mid);
    // Bounded deterministic failure — never a hang, never a dispatch.
    expect(["FAILED", "ABORTED"]).toContain(state);
    const t2 = taskByKey(ctx, mid, "T2")!;
    // The remote adapter was never asked to spend.
    const t2Exec = executions(ctx).filter(
      (e) => String(e.task_id) === String(t2.task_id),
    );
    expect(t2Exec).toHaveLength(0);
    const decisions = ctx.store
      .list("recovery_decision")
      .filter((d) => String(d.mission_id) === mid);
    expect(decisions.length).toBeGreaterThan(0);
    const ctx0 = decisions[0]!.failure_context as Record<string, unknown>;
    expect(String(ctx0?.failure_class ?? "")).toBe("DEPENDENCY_FAILURE");
    expect(String(ctx0?.dependency_reason)).toBe("REMOTE_PRODUCER_ARTIFACT_MISSING");
  });

  it("L2. lane-missing remote task with EMPTY produces still dispatches (existing behavior)", () => {
    const ctx = makeCtx("f5-l2");
    delete process.env.PAIR_OUTBOX_URL;
    delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    delete process.env.PAIR_BROKER_TOKEN;
    const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
    const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
    registerAdapter(ctx, remote);
    registerAdapter(ctx, local);
    const plan = [
      goalTask("T1"),
      {
        task_key: "T2",
        title: "remote analyze",
        task_instruction: "analyze remotely, then reply DONE.",
        required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const m = startMission(ctx, plan as never);
    const mid = String(m.mission_id);
    const state = drive(ctx, mid);
    expect(state).toBe("COMPLETED");
    const t2 = taskByKey(ctx, mid, "T2")!;
    expect(
      executions(ctx).some((e) => String(e.task_id) === String(t2.task_id)),
    ).toBe(true);
  });
});

describe("F5.2 — Devin prompt mandatory upload enumeration + lane guard", () => {
  let promptSeq = 0;
  const mkAdapter = () =>
    new DevinExecutorAdapter({
      journalRoot: path.join(freshDir(`f5-prompt-${promptSeq++}`), "journal"),
    });

  const buildPrompt = (
    adapter: DevinExecutorAdapter,
    task: Record<string, unknown>,
  ) =>
    (
      adapter as unknown as {
        buildPrompt(t: Record<string, unknown>): string;
      }
    ).buildPrompt(task);

  const remoteTask = (declared: unknown) => ({
    task_id: "TSK_P1",
    mission_id: "MSN_P1",
    governed_task_id: "GT_P1",
    correlation_id: "COR_P1",
    task_instruction: "fetch data",
    workspace: "/tmp/ws",
    allowed_paths: ["/tmp/ws"],
    permissions: [],
    expected_output_contract: {
      type: "TASK_RESULT",
      declared_produces: declared,
    },
  });

  it("Q1. declared produces enumerated verbatim in prompt + BEFORE marker", () => {
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const prompt = buildPrompt(
        mkAdapter(),
        remoteTask(["data.json", "report.md"]),
      );
      expect(prompt).toContain("Required canonical produced artifacts");
      expect(prompt).toContain("- data.json");
      expect(prompt).toContain("- report.md");
      expect(prompt).toContain("BEFORE emitting PAIR_EXECUTION_COMPLETE");
      // The mandatory block uses the acap1 lane header, not a second mechanism.
      expect(prompt).toContain("x-artifact-capability");
      expect(prompt).not.toContain("x-outbox-token");
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });

  it("Q2. declared produces + no ingest lane → prompt build fails closed before spend", () => {
    delete process.env.PAIR_OUTBOX_URL;
    delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    delete process.env.PAIR_BROKER_TOKEN;
    try {
      buildPrompt(mkAdapter(), remoteTask(["data.json"]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect((e as IntegrityError).code).toBe(
        "FAIL_CLOSED_REMOTE_INGEST_LANE_UNAVAILABLE",
      );
    }
  });

  it("Q3. no declared produces → prompt unchanged (no mandatory block)", () => {
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const prompt = buildPrompt(mkAdapter(), remoteTask([]));
      expect(prompt).not.toContain("Required canonical produced artifacts");
      const p2 = buildPrompt(mkAdapter(), {
        ...remoteTask([]),
        expected_output_contract: { type: "TASK_RESULT" },
      });
      expect(p2).not.toContain("Required canonical produced artifacts");
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });
});

describe("F5.3 — terminal declared-produces closure gate", () => {
  it("A. empty declared set → PASS unchanged (existing behavior)", () => {
    const ctx = makeCtx("f5-a");
    const p = mkRemoteProducer(ctx, { produces: [], missionId: "M_A" });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
  });

  it("B. declared + uploaded canonical → PASS + artifact in artifact_ids", () => {
    const ctx = makeCtx("f5-b");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_B" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "payload-bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
    const row = validationRow(ctx, p.eid)!;
    const ids = row.artifact_ids as string[];
    expect(ids).toContain(canonicalArtifactId(p.eid, "data.json"));
    expect(row.declared_produces_digest).toBe(digest(["data.json"]));
    expect(row.remote_produces_missing).toBeUndefined();
  });

  it("C. declared + nothing uploaded → FAIL typed code + bounded evidence", () => {
    const ctx = makeCtx("f5-c");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_C" });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const row = validationRow(ctx, p.eid)!;
    expect(row.status).toBe("FAIL");
    const failures = row.failures as string[];
    expect(failures).toContain("FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json");
    expect(row.remote_produces_missing).toEqual(["data.json"]);
    expect(row.declared_produces_digest).toBe(digest(["data.json"]));
    // Evidence event carries the same bounded context.
    const ev = ctx.store
      .listEvidence("M_C")
      .find((e) => String(e.kind) === "RESULT_VALIDATION")!;
    expect(
      ((ev.payload as Record<string, unknown>).payload as Record<string, unknown>)
        .remote_produces_missing,
    ).toEqual(["data.json"]);
  });

  it("D. two declared, one uploaded → FAIL names ONLY the missing", () => {
    const ctx = makeCtx("f5-d");
    const p = mkRemoteProducer(ctx, {
      produces: ["data.json", "report.md"],
      missionId: "M_D",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "a");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const row = validationRow(ctx, p.eid)!;
    expect(row.remote_produces_missing).toEqual(["report.md"]);
    expect(row.failures).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:report.md"]),
    );
    expect(row.failures).not.toEqual(
      expect.arrayContaining(["FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json"]),
    );
  });

  it("E. same filename uploaded by ANOTHER execution → does not satisfy", () => {
    const ctx = makeCtx("f5-e");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_E" });
    const other = mkRemoteProducer(ctx, {
      produces: ["data.json"],
      missionId: "M_E",
    });
    const otherExec = ctx.store.get("executor_execution", other.eid);
    upload(ctx, otherExec, "data.json", "foreign-bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "data.json",
    ]);
  });

  it("F. same filename present only in shared outbox → does not satisfy", () => {
    const ctx = makeCtx("f5-f");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_F" });
    const outbox = path.join(ctx.dir, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, "data.json"), "stale outbox bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "data.json",
    ]);
  });

  it("G. file present only in the task workspace → does not satisfy", () => {
    const ctx = makeCtx("f5-g");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_G" });
    fs.writeFileSync(path.join(ctx.workspace, "data.json"), "ws bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "data.json",
    ]);
  });

  it("H. canonical artifact under a different task/execution of same mission → does not satisfy", () => {
    const ctx = makeCtx("f5-h");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_H" });
    // Foreign producer in the SAME mission uploads the same name.
    const foreign = mkRemoteProducer(ctx, {
      produces: ["data.json"],
      missionId: "M_H",
    });
    const fexec = ctx.store.get("executor_execution", foreign.eid);
    upload(ctx, fexec, "data.json", "foreign");
    // Validate the foreign execution — it passes; ours still fails.
    completeRemote(ctx, foreign.eid);
    expect(String(validate(ctx, foreign.eid).status)).toBe("PASS");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "data.json",
    ]);
  });

  it("I. accepted row whose retained bytes fail F1 verification → no satisfy", () => {
    const ctx = makeCtx("f5-i");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_I" });
    const exec = ctx.store.get("executor_execution", p.eid);
    const uploaded = upload(ctx, exec, "data.json", "real-bytes") as {
      artifact: Record<string, unknown>;
    };
    // Tamper with the retained canonical bytes post-acceptance.
    const artRow = ctx.store.get(
      "artifact",
      String(uploaded.artifact.artifact_id),
    );
    const blobPath = path.join(
      ctx.dir, "artifacts", "blobs", String(artRow.sha256),
    );
    fs.writeFileSync(blobPath, "tampered");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
  });

  it("J. post-dispatch mutation of declared_produces → FAIL_CLOSED scope mutated", () => {
    const ctx = makeCtx("f5-j");
    const p = mkRemoteProducer(ctx, {
      produces: ["data.json", "report.md"],
      missionId: "M_J",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "a");
    upload(ctx, exec, "report.md", "b");
    // Mutate the pinned contract: drop a declared produce.
    const governed = ctx.store.get("governed_task", p.gtId);
    ctx.store.put(
      "governed_task",
      p.gtId,
      {
        ...governed,
        expected_output_contract: {
          ...(governed.expected_output_contract as Record<string, unknown>),
          declared_produces: ["data.json"],
        },
      },
      Number(governed.version),
    );
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const row = validationRow(ctx, p.eid)!;
    expect(row.failures).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
      ]),
    );
  });

  it("J2. post-dispatch mutation to EMPTY declared set → FAIL_CLOSED (mutation from non-empty to [] can never silently PASS)", () => {
    const ctx = makeCtx("f5-j2");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_J2" });
    const governed = ctx.store.get("governed_task", p.gtId);
    ctx.store.put(
      "governed_task",
      p.gtId,
      {
        ...governed,
        expected_output_contract: {
          ...(governed.expected_output_contract as Record<string, unknown>),
          declared_produces: [],
        },
      },
      Number(governed.version),
    );
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
      ]),
    );
  });

  it("M. duplicate identical upload replay → F1 idempotency, exactly one identity satisfies", () => {
    const ctx = makeCtx("f5-m");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_M" });
    const exec = ctx.store.get("executor_execution", p.eid);
    const first = upload(ctx, exec, "data.json", "same-bytes");
    const second = upload(ctx, exec, "data.json", "same-bytes");
    expect(String(second.artifact_id)).toBe(String(first.artifact_id));
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
  });

  it("N. conflicting upload under same name → F1 REPLAY_CONFLICT rejects; first identity still satisfies", () => {
    const ctx = makeCtx("f5-n");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_N" });
    const exec = ctx.store.get("executor_execution", p.eid);
    const first = upload(ctx, exec, "data.json", "bytes-a");
    try {
      upload(ctx, exec, "data.json", "bytes-b-different");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect((e as IntegrityError).code).toBe(
        "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
      );
    }
    completeRemote(ctx, p.eid);
    // The originally-accepted identity still satisfies the declared produce.
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
    const rows = ctx.service.artifacts
      .forExecution(p.eid)
      .filter((a) => String(a.logical_name) === "data.json");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.artifact_id)).toBe(
      String((first as { artifact: Record<string, unknown> }).artifact.artifact_id),
    );
  });
});

describe("F5.4 — settleExecution recovery classification", () => {
  it("R1. remote producer completes without upload → DEPENDENCY_FAILURE on PRODUCER, consumer never dispatched", () => {
    const ctx = makeCtx("f5-r1");
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
      const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
      registerAdapter(ctx, remote);
      registerAdapter(ctx, local);
      const plan = reconcilePlanDataflow(remoteProducerPlan(["data.json"])).tasks;
      const m = startMission(ctx, plan);
      const mid = String(m.mission_id);
      drive(ctx, mid);
      const t2 = taskByKey(ctx, mid, "T2")!;
      expect(String(t2.status)).toBe("FAILED");
      const t3 = taskByKey(ctx, mid, "T3")!;
      // Consumer never spent.
      expect(
        executions(ctx).some((e) => String(e.task_id) === String(t3.task_id)),
      ).toBe(false);
      const t2Exec = execForTask(ctx, String(t2.task_id))!;
      const vrow = validationRow(ctx, String(t2Exec.execution_id))!;
      expect(vrow.status).toBe("FAIL");
      expect(vrow.remote_produces_missing).toEqual(["data.json"]);
      const decisions = ctx.store
        .list("recovery_decision")
        .filter((d) => String(d.mission_id) === mid);
      expect(decisions.length).toBeGreaterThan(0);
      const fc = decisions[0]!.failure_context as Record<string, unknown>;
      expect(String(fc?.failure_class)).toBe("DEPENDENCY_FAILURE");
      expect(String(fc?.dependency_reason)).toBe("REMOTE_PRODUCER_ARTIFACT_MISSING");
      expect(String(fc?.artifact_name)).toBe("data.json");
      expect(String(fc?.producer_task_id)).toBe(String(t2.task_id));
      expect(String(fc?.source_code)).toBe("FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE");
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });
});

describe("F5 — E2E + restart + handoff", () => {
  it("K. restart after upload, before settlement → fresh validation converges, no duplicate ART row", () => {
    const ctx = makeCtx("f5-k");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_K" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "durably-uploaded");
    completeRemote(ctx, p.eid);
    const before = ctx.service.artifacts.forExecution(p.eid).length;
    // Fresh store handle on the same DB (crash + reopen).
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const v = new ArtifactProvenanceValidator().validate_execution(service2, p.eid);
    expect(String(v.status)).toBe("PASS");
    expect(service2.artifacts.forExecution(p.eid).length).toBe(before);
  });

  it("L. restart after completion marker, before upload → no fabricated PASS", () => {
    const ctx = makeCtx("f5-l");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_L" });
    // Completion marker seen + result persisted — nothing ever uploaded.
    completeRemote(ctx, p.eid);
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const v = new ArtifactProvenanceValidator().validate_execution(service2, p.eid);
    expect(String(v.status)).toBe("FAIL");
  });

  it("O. remote producer → local consumer pins the EXACT canonical bytes", () => {
    const ctx = makeCtx("f5-o");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_O", planId: "PLAN_O" });
    const exec = ctx.store.get("executor_execution", p.eid);
    const uploaded = upload(ctx, exec, "data.json", "exact-consumer-bytes") as Record<string, unknown>;
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    // Consumer task declares the consume edge + depends on the producer.
    ctx.store.put(
      "task",
      "RTSK_CONSUMER_O",
      {
        task_id: "RTSK_CONSUMER_O", task_key: "T3C", mission_id: "M_O",
        title: "consumer", task_instruction: "consume data.json",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [String(p.tid)],
        plan_id: "PLAN_O", status: "READY",
        metadata: {
          pair_dataflow: { produces: [], consumes: ["data.json"] },
        },
        version: 0,
      },
      0,
    );
    const producerTask = ctx.store.get("task", p.tid);
    ctx.store.put(
      "task",
      p.tid,
      { ...producerTask, plan_id: "PLAN_O" },
      Number(producerTask.version),
    );
    const mission = { mission_id: "M_O", plan_revision: 1 };
    const consumer = ctx.store.get("task", "RTSK_CONSUMER_O");
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: mission as never,
      task: consumer,
    });
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(String(e.artifact_id)).toBe(String(uploaded.artifact.artifact_id));
    expect(e.sha256).toBe(sha256Hex(Buffer.from("exact-consumer-bytes")));
    expect(String(e.producer_execution_id)).toBe(p.eid);
  });

  it("Q. remote producer → REMOTE consumer resolves the same canonical pin (acread1 handoff feed)", () => {
    const ctx = makeCtx("f5-q");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_Q", planId: "PLAN_Q" });
    const exec = ctx.store.get("executor_execution", p.eid);
    const uploaded = upload(ctx, exec, "data.json", "remote-consumer-bytes") as Record<string, unknown>;
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    ctx.store.put(
      "task",
      "RTSK_CONSUMER_Q",
      {
        task_id: "RTSK_CONSUMER_Q", task_key: "T3Q", mission_id: "M_Q",
        title: "remote consumer", task_instruction: "consume remotely",
        required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"],
        depends_on: [String(p.tid)],
        plan_id: "PLAN_Q", status: "READY",
        metadata: { pair_dataflow: { produces: [], consumes: ["data.json"] } },
        version: 0,
      },
      0,
    );
    const producerTask = ctx.store.get("task", p.tid);
    ctx.store.put(
      "task",
      p.tid,
      { ...producerTask, plan_id: "PLAN_Q" },
      Number(producerTask.version),
    );
    const consumer = ctx.store.get("task", "RTSK_CONSUMER_Q");
    const entries = ctx.service.artifactResolver.resolveForConsumer({
      mission: { mission_id: "M_Q", plan_revision: 1 } as never,
      task: consumer,
    });
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.artifact_id)).toBe(String(uploaded.artifact.artifact_id));
  });

  it("E2E. full lane: remote producer uploads via canonical lane → PASS binds artifact_id; consumer pins it", () => {
    const ctx = makeCtx("f5-e2e");
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
      const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
      local.behavior = { T3: "WRITE" };
      registerAdapter(ctx, remote);
      registerAdapter(ctx, local);
      const plan = reconcilePlanDataflow(remoteProducerPlan(["data.json"])).tasks;
      // The remote worker performs its canonical upload inside collect_result.
      remote.onCollect = (eid) => {
        const exec = ctx.store.get("executor_execution", eid);
        upload(ctx, exec, "data.json", "remote-produced-bytes");
      };
      const m = startMission(ctx, plan);
      const mid = String(m.mission_id);
      const state = drive(ctx, mid);
      expect(state).toBe("COMPLETED");
      const t2 = taskByKey(ctx, mid, "T2")!;
      const t2Exec = execForTask(ctx, String(t2.task_id))!;
      const vrow = validationRow(ctx, String(t2Exec.execution_id))!;
      expect(vrow.status).toBe("PASS");
      const ids = vrow.artifact_ids as string[];
      expect(ids).toContain(
        canonicalArtifactId(String(t2Exec.execution_id), "data.json"),
      );
      // Consumer governed contract pinned the exact artifact identity.
      const t3 = taskByKey(ctx, mid, "T3")!;
      const g3 = governedForTask(ctx, String(t3.task_id))!;
      const deps = g3.dependency_artifacts as Array<Record<string, unknown>>;
      expect(deps).toHaveLength(1);
      expect(String(deps[0]!.artifact_id)).toBe(ids[0]);
      expect(String(deps[0]!.logical_name)).toBe("data.json");
      // T3 wrote its own produce locally — canonical via LOCAL_EXECUTION.
      const t3Exec = execForTask(ctx, String(t3.task_id))!;
      const v3 = validationRow(ctx, String(t3Exec.execution_id))!;
      expect(v3.status).toBe("PASS");
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });
});

/* ====================== R1 — immutable mint-anchor authority ============= */

const mutateGoverned = (
  ctx: ReturnType<typeof makeCtx>,
  gtId: string,
  fn: (g: Record<string, unknown>) => void,
) => {
  const g = ctx.store.get("governed_task", gtId);
  fn(g);
  ctx.store.put("governed_task", gtId, g, Number(g.version));
};

describe("F5 R1 — immutable mint-time anchor governs F5 binding", () => {
  it("R1-1. declared_produces deleted post-dispatch → FAIL (no legacy downgrade)", () => {
    const ctx = makeCtx("f5r1-1");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R1" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      const c = { ...(g.expected_output_contract as Record<string, unknown>) };
      delete c.declared_produces;
      g.expected_output_contract = c;
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const failures = validationRow(ctx, p.eid)!.failures as string[];
    expect(failures).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces",
      ]),
    );
  });

  it("R1-2. declared_produces set to null → FAIL", () => {
    const ctx = makeCtx("f5r1-2");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R2" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: null,
      };
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    expect(
      validationRow(ctx, p.eid)!.failures as string[],
    ).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:declared_produces",
      ]),
    );
  });

  it("R1-3. declared_produces reshaped to string/object → FAIL", () => {
    for (const shape of ["data.json", { name: "data.json" }]) {
      const ctx = makeCtx(`f5r1-3-${typeof shape === "string" ? "s" : "o"}`);
      const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R3" });
      const exec = ctx.store.get("executor_execution", p.eid);
      upload(ctx, exec, "data.json", "ok");
      mutateGoverned(ctx, p.gtId, (g) => {
        g.expected_output_contract = {
          ...(g.expected_output_contract as Record<string, unknown>),
          declared_produces: shape,
        };
        g.approval_scope_digest = scopeDigest(g);
      });
      completeRemote(ctx, p.eid);
      expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    }
  });

  it("R1-4. declared_produces narrowed [] + row scope digest recomputed → FAIL vs anchor", () => {
    const ctx = makeCtx("f5r1-4");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R4" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: [],
      };
      // Attacker keeps the MUTABLE row self-consistent — the immutable
      // anchor still exposes the drift.
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
      ]),
    );
  });

  it("R1-5. narrowing ['data.json','report.md']→['data.json'] + recompute → FAIL", () => {
    const ctx = makeCtx("f5r1-5");
    const p = mkRemoteProducer(ctx, {
      produces: ["data.json", "report.md"],
      missionId: "M_R5",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "a");
    upload(ctx, exec, "report.md", "b");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: ["data.json"],
      };
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
  });

  it("R1-6. widening declared_produces + recompute → FAIL", () => {
    const ctx = makeCtx("f5r1-6");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R6" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "a");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: ["data.json", "extra.md"],
      };
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
  });

  it("R1-7. coherent rewrite of BOTH approval_scope_digest + governance_digest → FAIL", () => {
    const ctx = makeCtx("f5r1-7");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R7" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: [],
      };
      g.approval_scope_digest = scopeDigest(g);
      g.governance_digest = digest(g);
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract",
      ]),
    );
  });

  it("R1-8. anchor deleted → remote execution can NEVER downgrade to legacy → FAIL", () => {
    const ctx = makeCtx("f5r1-8");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R8" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    // Delete the immutable mint anchor (raw removal — history corruption).
    ctx.store.db
      .prepare(
        "DELETE FROM events WHERE entity_type='governed_task' AND entity_id=? AND event_type='GOVERNED_TASK_VALIDATED'",
      )
      .run(p.gtId);
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_GOVERNED_MINT_ANCHOR:MISSING"]),
    );
  });

  it("R1-9. duplicate/conflicting anchor minted → FAIL (ambiguous authority)", () => {
    const ctx = makeCtx("f5r1-9");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R9" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    // Forge a SECOND competing anchor.
    ctx.store.event({
      entity_type: "governed_task",
      entity_id: p.gtId,
      event_type: "GOVERNED_TASK_VALIDATED",
      new_state: "VALIDATED",
      actor: "FORGERY",
      metadata: {
        mission_id: "M_R9", task_id: p.tid, executor_id: p.executor,
        governed_task_id: p.gtId,
        remote_produces_contract: false,
      },
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_GOVERNED_MINT_ANCHOR:AMBIGUOUS"]),
    );
  });

  it("R1-10. foreign-id forged anchor (different task/executor ids) → FAIL", () => {
    const ctx = makeCtx("f5r1-10");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_RA" });
    // Remove the genuine anchor and mint a forged one whose identity
    // binds a DIFFERENT task/executor — exactly one anchor exists but it
    // does not correspond to this governed task.
    ctx.store.db
      .prepare(
        "DELETE FROM events WHERE entity_type='governed_task' AND entity_id=? AND event_type='GOVERNED_TASK_VALIDATED'",
      )
      .run(p.gtId);
    ctx.store.event({
      entity_type: "governed_task",
      entity_id: p.gtId,
      event_type: "GOVERNED_TASK_VALIDATED",
      new_state: "VALIDATED",
      actor: "FORGERY",
      metadata: {
        mission_id: "M_RA", task_id: "FOREIGN_TASK",
        executor_id: "EX_FOREIGN", governed_task_id: p.gtId,
        remote_produces_contract: true,
        declared_produces: ["data.json"],
        declared_produces_digest: digest(["data.json"]),
      },
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_GOVERNED_MINT_ANCHOR:IDENTITY"]),
    );
  });

  it("R1-11. restart with intact anchor + artifact → PASS exactly once", () => {
    const ctx = makeCtx("f5r1-11");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_RB" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "durable");
    completeRemote(ctx, p.eid);
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const v = new ArtifactProvenanceValidator().validate_execution(service2, p.eid);
    expect(String(v.status)).toBe("PASS");
  });

  it("R1-12. restart with MUTATED row + intact anchor → same FAIL after reopen", () => {
    const ctx = makeCtx("f5r1-12");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_RC" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "durable");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.expected_output_contract = {
        ...(g.expected_output_contract as Record<string, unknown>),
        declared_produces: [],
      };
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const v = new ArtifactProvenanceValidator().validate_execution(service2, p.eid);
    expect(String(v.status)).toBe("FAIL");
  });

  it("R1-13. genuine remote declared_produces:[] from mint stays valid", () => {
    const ctx = makeCtx("f5r1-13");
    const p = mkRemoteProducer(ctx, { produces: [], missionId: "M_RD" });
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("R1-14. LOCAL task — planner-supplied declared_produces cannot mint F5 authority", () => {
    const ctx = makeCtx("f5r1-14");
    const tid = "LT_R14";
    const gtId = `GT_${tid}`;
    const eid = workerExecutionId(EX_LOCAL, gtId);
    ctx.store.put(
      "task",
      tid,
      {
        task_id: tid, task_key: "TK_R14", mission_id: "M_RE",
        title: "local task", task_instruction: "local work",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [], status: "READY",
        metadata: {
          expected_output_contract: {
            type: "TASK_RESULT",
            // A planner-supplied declared_produces must not grant F5
            // binding on a non-remote task — local closure stays the
            // documented legacy semantics.
            declared_produces: ["never-uploaded.json"],
          },
        },
        version: 0,
      },
      0,
    );
    const governed: Record<string, unknown> = {
      governed_task_id: gtId, mission_id: "M_RE", task_id: tid,
      correlation_id: `COR_${tid}`, executor_id: EX_LOCAL,
      plan_id: "PLAN_R14", plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      permissions: [], dependency_artifacts_digest: null,
      expected_output_contract: {
        type: "TASK_RESULT",
        declared_produces: ["never-uploaded.json"],
      },
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: utcnow(), version: 0,
    };
    governed.approval_scope_digest = scopeDigest(governed);
    ctx.store.put("governed_task", gtId, governed, 0);
    // Local mint emits the anchor with remote_produces_contract: false —
    // the planner-supplied field does not become F5 authority.
    ctx.store.event({
      entity_type: "governed_task",
      entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED",
      new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE",
      metadata: {
        mission_id: "M_RE", task_id: tid, executor_id: EX_LOCAL,
        governed_task_id: gtId,
        plan_id: "PLAN_R14", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: false,
        declared_produces: null,
        declared_produces_digest: null,
      },
    });
    ctx.store.put(
      "executor_execution",
      eid,
      {
        execution_id: eid, governed_task_id: gtId, mission_id: "M_RE",
        task_id: tid, executor_id: EX_LOCAL, correlation_id: `COR_${tid}`,
        plan_id: "PLAN_R14", plan_revision: 1,
        execution_state: "COMPLETED",
        result: { status: "COMPLETED", artifacts: [], summary: "done" },
        workspace: ctx.workspace,
        version: 0,
      },
      0,
    );
    const v = validate(ctx, eid);
    // Local task keeps prior semantics — no upload, no declared-produces
    // closure requirement.
    expect(String(v.status)).toBe("PASS");
  });
});

/* ==================== F5 R2 — mint-anchor-first authority ====================
 * R2.A: F5 applicability resolves through execution → governed → exactly-one
 *       GOVERNED_TASK_VALIDATED anchor → remote_produces_contract — never the
 *       mutable task row. R2.B: complete pinned identity incl. plan across
 *       anchor ↔ governed ↔ execution. R2.C: the anchor self-validates its
 *       own declared contract. R2.D: adversarial matrix. R2.E: counterfactual.
 */
const mutateExecution = (
  ctx: ReturnType<typeof makeCtx>,
  eid: string,
  fn: (e: Record<string, unknown>) => void,
) => {
  const e = ctx.store.get("executor_execution", eid);
  fn(e);
  ctx.store.put("executor_execution", eid, e, Number(e.version));
};

/** Replace the genuine anchor with a forged one (event-hash-safe). */
const forgeAnchor = (
  ctx: ReturnType<typeof makeCtx>,
  p: { gtId: string; tid: string; executor: string },
  metadata: Record<string, unknown>,
) => {
  ctx.store.db
    .prepare(
      "DELETE FROM events WHERE entity_type='governed_task' AND entity_id=? AND event_type='GOVERNED_TASK_VALIDATED'",
    )
    .run(p.gtId);
  ctx.store.event({
    entity_type: "governed_task",
    entity_id: p.gtId,
    event_type: "GOVERNED_TASK_VALIDATED",
    new_state: "VALIDATED",
    actor: "PAIR_GOVERNED_TASK_GATE",
    correlation_id: `COR_${p.tid}`,
    metadata,
  });
};

describe("F5 R2 — applicability comes from the immutable mint anchor", () => {
  it("R2-1. remote producer uploads nothing + task caps mutated REMOTE→local pre-settlement → FAIL, no legacy PASS", () => {
    const ctx = makeCtx("f5r2-1");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R21" });
    // Post-dispatch capability rewrite: the mutable task row now claims to
    // be LOCAL. Under the anchor, the execution stays F5-bound forever.
    const task = ctx.store.get("task", p.tid);
    ctx.store.put(
      "task",
      p.tid,
      { ...task, required_capabilities: ["FILE_OPERATIONS"] },
      Number(task.version),
    );
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json",
      ]),
    );
  });

  it("R2-2. remote producer uploads nothing + task row DELETED → F5 authority remains → FAIL", () => {
    const ctx = makeCtx("f5r2-2");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R22" });
    ctx.store.db
      .prepare("DELETE FROM entities WHERE entity_type='task' AND entity_id=?")
      .run(p.tid);
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json",
      ]),
    );
  });

  it("R2-3. unrelated task metadata mutated post-dispatch → applicability unchanged → closure still runs", () => {
    const ctx = makeCtx("f5r2-3");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R23" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    const task = ctx.store.get("task", p.tid);
    ctx.store.put(
      "task",
      p.tid,
      {
        ...task,
        title: "retitled",
        metadata: {
          pair_dataflow: { produces: ["data.json"], consumes: ["mutated.json"] },
          unrelated: "rewritten",
        },
      },
      Number(task.version),
    );
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("R2-4. governed.plan_revision + execution.plan_revision coherently rewritten → FAIL identity", () => {
    const ctx = makeCtx("f5r2-4");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R24" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.plan_revision = 2;
      g.approval_scope_digest = scopeDigest(g);
    });
    mutateExecution(ctx, p.eid, (e) => {
      e.plan_revision = 2;
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_GOVERNED_MINT_ANCHOR:IDENTITY"]),
    );
  });

  it("R2-5. governed.plan_id + plan_revision + execution.plan_revision rewritten + digests recomputed → FAIL vs anchor", () => {
    const ctx = makeCtx("f5r2-5");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R25" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    mutateGoverned(ctx, p.gtId, (g) => {
      g.plan_id = "PLAN_FORGED";
      g.plan_revision = 9;
      g.approval_scope_digest = scopeDigest(g);
    });
    mutateExecution(ctx, p.eid, (e) => {
      e.plan_revision = 9;
      e.plan_id = "PLAN_FORGED";
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining(["FAIL_CLOSED_GOVERNED_MINT_ANCHOR:IDENTITY"]),
    );
  });

  it("R2-6. execution.governed_task_id mutated → FAIL identity", () => {
    const ctx = makeCtx("f5r2-6");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R26" });
    const p2 = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R26" });
    // Rebind the execution to a DIFFERENT genuine governed task: its own
    // mission/task/executor no longer correspond to the loaded governed
    // row — the F1 durable-linkage authority seam fails closed first with
    // typed evidence (the anchor identity seam defends the same invariant
    // when the linkage triple still matches, e.g. forged anchors).
    mutateExecution(ctx, p.eid, (e) => {
      e.governed_task_id = p2.gtId;
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const fs6 = validationRow(ctx, p.eid)!.failures as string[];
    expect(
      fs6.some(
        (f) =>
          f.includes("FAIL_CLOSED_ARTIFACT_VERIFICATION") &&
          f.includes("durable_linkage"),
      ),
    ).toBe(true);
  });

  it("R2-7. execution mission/task/executor mutated → FAIL identity", () => {
    const ctx = makeCtx("f5r2-7");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R27" });
    mutateExecution(ctx, p.eid, (e) => {
      e.mission_id = "M_FOREIGN";
      e.task_id = "TASK_FOREIGN";
      e.executor_id = "EX_FOREIGN";
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    // The mutable execution row contradicting the durable linkage triple
    // fails closed at the F1 artifact authority seam — typed evidence.
    const fs7 = validationRow(ctx, p.eid)!.failures as string[];
    expect(
      fs7.some(
        (f) =>
          f.includes("FAIL_CLOSED_ARTIFACT_VERIFICATION") &&
          f.includes("durable_linkage"),
      ),
    ).toBe(true);
  });

  it("R2-8. anchor declared_produces malformed while digest present → FAIL closed", () => {
    const ctx = makeCtx("f5r2-8");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R28" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    // Forged anchor: declared_produces not normalized (duplicate entries)
    // even though the digest field matches that same malformed array.
    const malformed = ["data.json", "data.json"];
    forgeAnchor(ctx, p, {
      mission_id: "M_R28", task_id: p.tid, executor_id: p.executor,
      governed_task_id: p.gtId,
      plan_id: "PLAN_F5", plan_revision: 1,
      approval_scope_digest: scopeDigest(
        ctx.store.get("governed_task", p.gtId),
      ),
      remote_produces_contract: true,
      declared_produces: malformed,
      declared_produces_digest: digest(malformed),
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_MINT_ANCHOR:DECLARED_PRODUCES",
      ]),
    );
  });

  it("R2-9. anchor declared_produces changed without matching digest → FAIL closed", () => {
    const ctx = makeCtx("f5r2-9");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R29" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    forgeAnchor(ctx, p, {
      mission_id: "M_R29", task_id: p.tid, executor_id: p.executor,
      governed_task_id: p.gtId,
      plan_id: "PLAN_F5", plan_revision: 1,
      approval_scope_digest: scopeDigest(
        ctx.store.get("governed_task", p.gtId),
      ),
      remote_produces_contract: true,
      declared_produces: ["other.json"],
      declared_produces_digest: digest(["data.json"]),
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_GOVERNED_MINT_ANCHOR:DECLARED_PRODUCES",
      ]),
    );
  });

  it("R2-10. anchor array+digest changed coherently → append-only hash-history seam catches", () => {
    const ctx = makeCtx("f5r2-10");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R210" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "ok");
    // Direct event-row rewrite: even a COHERENT anchor forgery cannot
    // update event_hash — reading it back trips the store integrity seam.
    const row = ctx.store.db
      .prepare(
        "SELECT event_id, metadata_json FROM events WHERE entity_type='governed_task' AND entity_id=? AND event_type='GOVERNED_TASK_VALIDATED'",
      )
      .get(p.gtId) as { event_id: string; metadata_json: string };
    const meta = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    meta.declared_produces = ["other.json"];
    meta.declared_produces_digest = digest(["other.json"]);
    ctx.store.db
      .prepare("UPDATE events SET metadata_json=? WHERE event_id=?")
      .run(JSON.stringify(meta), String(row.event_id));
    completeRemote(ctx, p.eid);
    expect(() => validate(ctx, p.eid)).toThrowError(
      /FAIL_CLOSED_EVENT_HASH_MISMATCH/,
    );
  });

  it("R2-11. genuine pre-F5 anchor with no marker → documented legacy semantics preserved", () => {
    const ctx = makeCtx("f5r2-11");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R211" });
    const exec = ctx.store.get("executor_execution", p.eid);
    // Pre-F5 mint: anchor carries ONLY the original identity fields — no
    // marker, no governed_task_id, no plan fields, no scope/declared
    // digests. And the governed row of that era carried no F5 contract.
    forgeAnchor(ctx, p, {
      mission_id: "M_R211", task_id: p.tid, executor_id: p.executor,
      risk_class: "AUTO", approval_required: false,
      dependency_artifacts_digest: null,
    });
    mutateGoverned(ctx, p.gtId, (g) => {
      delete g.expected_output_contract;
      g.approval_scope_digest = scopeDigest(g);
    });
    completeRemote(ctx, p.eid);
    // Legacy semantics: no F5 closure — the remote execution validates on
    // the pre-F5 rules even with zero uploads.
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("R2-12. local anchor marker:false stays non-F5 even if task caps rewritten remote", () => {
    const ctx = makeCtx("f5r2-12");
    // Mint a LOCAL governed chain (marker:false anchor) — the same shape a
    // real local task emits under current code.
    const tid = `LT_R212`;
    const gtId = `GT_${tid}`;
    const eid = workerExecutionId(EX_LOCAL, gtId);
    ctx.store.put(
      "task",
      tid,
      {
        task_id: tid, task_key: "TK_R212", mission_id: "M_R212",
        plan_id: "PLAN_R212", title: "local",
        task_instruction: "local work",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [], status: "COMPLETED",
        metadata: {},
        version: 0,
      },
      0,
    );
    const governed: Record<string, unknown> = {
      governed_task_id: gtId, mission_id: "M_R212", task_id: tid,
      correlation_id: `COR_${tid}`, executor_id: EX_LOCAL,
      plan_id: "PLAN_R212", plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      permissions: [], dependency_artifacts_digest: null,
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: utcnow(), version: 0,
    };
    governed.approval_scope_digest = scopeDigest(governed);
    ctx.store.put("governed_task", gtId, governed, 0);
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: "M_R212", task_id: tid, executor_id: EX_LOCAL,
        governed_task_id: gtId, plan_id: "PLAN_R212", plan_revision: 1,
        approval_scope_digest: governed.approval_scope_digest,
        remote_produces_contract: false,
        declared_produces: null,
        declared_produces_digest: null,
      },
    });
    ctx.store.put(
      "executor_execution",
      eid,
      {
        execution_id: eid, governed_task_id: gtId, mission_id: "M_R212",
        task_id: tid, executor_id: EX_LOCAL, correlation_id: `COR_${tid}`,
        plan_id: "PLAN_R212", plan_revision: 1,
        execution_state: "COMPLETED",
        result: { status: "COMPLETED", artifacts: [], summary: "done" },
        workspace: ctx.workspace, version: 0,
      },
      0,
    );
    // Hostile rewrite: mutable task row now claims REMOTE capability —
    // the marker:false anchor still governs: no F5 closure.
    const task = ctx.store.get("task", tid);
    ctx.store.put(
      "task",
      tid,
      { ...task, required_capabilities: ["REMOTE_CLOUD_TASK_EXECUTION"] },
      Number(task.version),
    );
    expect(String(validate(ctx, eid).status)).toBe("PASS");
  });

  it("R2-13. restart → applicability + identity identical (PASS survives; mutation still fails after reopen)", () => {
    const ctx = makeCtx("f5r2-13");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R213" });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "data.json", "durable");
    completeRemote(ctx, p.eid);
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    expect(
      String(
        new ArtifactProvenanceValidator().validate_execution(service2, p.eid)
          .status,
      ),
    ).toBe("PASS");
    // Same reopened DB, now mutate and re-validate: identical FAIL.
    const g = store2.get("governed_task", p.gtId);
    g.plan_revision = 7;
    g.approval_scope_digest = scopeDigest(g);
    store2.put("governed_task", p.gtId, g, Number(g.version));
    expect(
      String(
        new ArtifactProvenanceValidator().validate_execution(service2, p.eid)
          .status,
      ),
    ).toBe("FAIL");
  });

  it("R2-14. restart post-capability-downgrade → still FAIL (ONCE F5-BOUND, ALWAYS F5-BOUND)", () => {
    const ctx = makeCtx("f5r2-14");
    const p = mkRemoteProducer(ctx, { produces: ["data.json"], missionId: "M_R214" });
    const task = ctx.store.get("task", p.tid);
    ctx.store.put(
      "task",
      p.tid,
      { ...task, required_capabilities: ["FILE_OPERATIONS"] },
      Number(task.version),
    );
    completeRemote(ctx, p.eid);
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const v = new ArtifactProvenanceValidator().validate_execution(service2, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const rows = store2
      .list("execution_validation")
      .filter((r) => String(r.execution_id) === p.eid);
    expect(String(rows.at(-1)!.status)).toBe("FAIL");
    expect(rows.at(-1)!.failures as string[]).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json",
      ]),
    );
  });

  it("R2-E. counterfactual mission: T2 remote produces data.json, caps mutated post-dispatch, zero upload → producer FAILs, T3 never dispatched, no fallback", () => {
    const ctx = makeCtx("f5r2-e");
    process.env.PAIR_OUTBOX_URL = OUTBOX_URL;
    process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = MASTER;
    try {
      const remote = new ScriptedAdapter(EX_REMOTE, ["REMOTE_CLOUD_TASK_EXECUTION"]);
      const local = new ScriptedAdapter(EX_LOCAL, ["FILE_OPERATIONS", "REASONING"]);
      registerAdapter(ctx, remote);
      registerAdapter(ctx, local);
      // Inside the remote collect (post-dispatch, pre-settlement) the task
      // row's capabilities are rewritten to local — the mutable row can no
      // longer downgrade the minted F5 contract.
      remote.onCollect = (eid: string) => {
        const t = remote.results[eid]?.task_id;
        if (!t) return;
        const row = ctx.store.tryGet("task", String(t)) as
          | Record<string, unknown>
          | null;
        if (!row) return;
        ctx.store.put(
          "task",
          String(t),
          { ...row, required_capabilities: ["FILE_OPERATIONS"] },
          Number(row.version),
        );
      };
      const plan = reconcilePlanDataflow(remoteProducerPlan(["data.json"])).tasks;
      const m = startMission(ctx, plan);
      const mid = String(m.mission_id);
      drive(ctx, mid);
      const t2 = taskByKey(ctx, mid, "T2")!;
      const t3 = taskByKey(ctx, mid, "T3")!;
      // T2 terminal validation FAILS at the producer.
      const t2Exec = execForTask(ctx, String(t2.task_id))!;
      const vrow = validationRow(ctx, String(t2Exec.execution_id))!;
      expect(String(vrow.status)).toBe("FAIL");
      expect(vrow.failures as string[]).toEqual(
        expect.arrayContaining([
          "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:data.json",
        ]),
      );
      expect(String(t2.status)).toBe("FAILED");
      // No PASS execution_validation was ever minted for T2.
      expect(
        ctx.store
          .list("execution_validation")
          .filter(
            (v) =>
              String(v.execution_id) === String(t2Exec.execution_id) &&
              String(v.status) === "PASS",
          ),
      ).toHaveLength(0);
      // T3 never dispatched — no shared-workspace/outbox filename fallback.
      expect(
        executions(ctx).some((e) => String(e.task_id) === String(t3.task_id)),
      ).toBe(false);
      // Recovery remains bounded: decisions recorded, mission does not hang.
      const decisions = ctx.store
        .list("recovery_decision")
        .filter((d) => String(d.mission_id) === mid);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.length).toBeLessThanOrEqual(3);
      const fc = decisions[0]!.failure_context as Record<string, unknown>;
      expect(String(fc?.failure_class)).toBe("DEPENDENCY_FAILURE");
    } finally {
      delete process.env.PAIR_OUTBOX_URL;
      delete process.env.PAIR_ARTIFACT_UPLOAD_TOKEN;
    }
  });
});

describe("RPN-1 — canonical DSN-1 name equivalence at the produces gate", () => {
  it("A. exact name unchanged → PASS", () => {
    const ctx = makeCtx("rpn1-a");
    const p = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_RPN_A",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "ea-bytes");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    const row = validationRow(ctx, p.eid)!;
    expect(row.artifact_ids).toEqual(
      expect.arrayContaining([canonicalArtifactId(p.eid, "github_ea.md")]),
    );
    expect(row.remote_produces_missing).toBeUndefined();
  });

  it("B. declared outbox alias + bare remote upload → PASS (live incident)", () => {
    const ctx = makeCtx("rpn1-b");
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_RPN_B",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "ea-bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
    const row = validationRow(ctx, p.eid)!;
    expect(row.remote_produces_missing).toBeUndefined();
    expect(row.artifact_ids).toEqual(
      expect.arrayContaining([canonicalArtifactId(p.eid, "github_ea.md")]),
    );
  });

  it("C. reverse staging spelling → PASS (outbox upload satisfies bare declared)", () => {
    // canonicalArtifactId derives from the UPLOADED logical name.
    expect(artifactNamesEquivalent("github_ea.md", "outbox/github_ea.md")).toBe(
      true,
    );
    const ctx = makeCtx("rpn1-c");
    const p = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_RPN_C",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "outbox/github_ea.md", "ea-bytes");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("D. wrong directories remain different → FAIL", () => {
    const ctx = makeCtx("rpn1-d");
    const p = mkRemoteProducer(ctx, {
      produces: ["reports/internal/report.md"],
      missionId: "M_RPN_D",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "reports/customer/report.md", "other");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "reports/internal/report.md",
    ]);
  });

  it("E. same basename, unrelated directories → FAIL (no basename collapse)", () => {
    const ctx = makeCtx("rpn1-e");
    const p = mkRemoteProducer(ctx, {
      produces: ["dirA/x.md"],
      missionId: "M_RPN_E",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "dirB/x.md", "other");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "dirA/x.md",
    ]);
  });

  it("F. equivalent upstream/consumed artifact cannot satisfy produces claim", () => {
    const ctx = makeCtx("rpn1-f");
    // Upstream producer uploads github_ea.md under ITS OWN execution —
    // that is the consumed/dependency artifact for the remote task.
    const upstream = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_RPN_F",
    });
    const upExec = ctx.store.get("executor_execution", upstream.eid);
    upload(ctx, upExec, "github_ea.md", "upstream-bytes");
    completeRemote(ctx, upstream.eid);
    expect(String(validate(ctx, upstream.eid).status)).toBe("PASS");
    // The remote task declares outbox/github_ea.md but uploads nothing —
    // name equivalence with the dependency artifact never substitutes
    // for producer identity bound to THIS execution.
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_RPN_F",
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "outbox/github_ea.md",
    ]);
  });

  it("G. equivalent name + wrong producer execution → still FAIL (provenance required)", () => {
    const ctx = makeCtx("rpn1-g");
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_RPN_G",
    });
    const foreign = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_RPN_G",
    });
    const fexec = ctx.store.get("executor_execution", foreign.eid);
    upload(ctx, fexec, "github_ea.md", "foreign");
    completeRemote(ctx, foreign.eid);
    expect(String(validate(ctx, foreign.eid).status)).toBe("PASS");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "outbox/github_ea.md",
    ]);
  });

  it("H. live incident shape — declared outbox alias, bare ACCEPTED upload, no recovery reason", () => {
    const ctx = makeCtx("rpn1-h");
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_RPN_H",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "live-ea-bytes");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("PASS");
    const row = validationRow(ctx, p.eid)!;
    expect(row.status).toBe("PASS");
    expect(row.failures).toEqual([]);
    // The RESULT_VALIDATION evidence records no produces gap.
    const ev = ctx.store
      .listEvidence("M_RPN_H")
      .find((e) => String(e.kind) === "RESULT_VALIDATION")!;
    expect(
      (ev.payload as Record<string, unknown>).remote_produces_missing,
    ).toBeUndefined();
  });

  it("I. both spellings uploaded — exact name wins; extra equivalent artifact is an unconstrained extra produce", () => {
    const ctx = makeCtx("rpn1-i");
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_RPN_I",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "a");
    upload(ctx, exec, "outbox/github_ea.md", "b");
    completeRemote(ctx, p.eid);
    // Exact-spelling artifact satisfies the declared name; the extra
    // equivalent-spelling artifact is a surplus produce, not a closure
    // failure.
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toBeUndefined();
  });

  it("J. two declared equivalent spellings each bound by their exact artifact → PASS (no collapse)", () => {
    const ctx = makeCtx("rpn1-j");
    const p = mkRemoteProducer(ctx, {
      produces: ["chart.png", "outbox/chart.png"],
      missionId: "M_RPN_J",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "chart.png", "a");
    upload(ctx, exec, "outbox/chart.png", "b");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toBeUndefined();
  });
});

describe("RPN-1 R1 — injective declared↔artifact binding (one artifact ≠ two slots)", () => {
  it("R1-A. live incident still PASS — declared outbox/X + bare upload X", () => {
    const ctx = makeCtx("rpn1r1-a");
    const p = mkRemoteProducer(ctx, {
      produces: ["outbox/github_ea.md"],
      missionId: "M_R1A",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "ea-bytes");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toBeUndefined();
  });

  it("R1-B. exact unchanged — declared X + upload X → PASS", () => {
    const ctx = makeCtx("rpn1r1-b");
    const p = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_R1B",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "github_ea.md", "ea-bytes");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("R1-C. two declared aliases + two exact artifacts → PASS", () => {
    const ctx = makeCtx("rpn1r1-c");
    const p = mkRemoteProducer(ctx, {
      produces: ["chart.png", "outbox/chart.png"],
      missionId: "M_R1C",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "chart.png", "a");
    upload(ctx, exec, "outbox/chart.png", "b");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("PASS");
  });

  it("R1-D. CRITICAL — one artifact cannot close two declared slots (bare direction)", () => {
    const ctx = makeCtx("rpn1r1-d");
    const p = mkRemoteProducer(ctx, {
      produces: ["chart.png", "outbox/chart.png"],
      missionId: "M_R1D",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "chart.png", "a");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const row = validationRow(ctx, p.eid)!;
    expect(row.remote_produces_missing).toEqual(["outbox/chart.png"]);
    expect(row.failures).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:outbox/chart.png",
      ]),
    );
  });

  it("R1-E. mirror — declared X + outbox/X, only outbox/X uploaded → FAIL names X", () => {
    const ctx = makeCtx("rpn1r1-e");
    const p = mkRemoteProducer(ctx, {
      produces: ["chart.png", "outbox/chart.png"],
      missionId: "M_R1E",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "outbox/chart.png", "b");
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    const row = validationRow(ctx, p.eid)!;
    expect(row.remote_produces_missing).toEqual(["chart.png"]);
    expect(row.failures).toEqual(
      expect.arrayContaining([
        "FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:chart.png",
      ]),
    );
  });

  it("R1-F. foreign/consumed equivalent artifact still satisfies nothing", () => {
    const ctx = makeCtx("rpn1r1-f");
    const foreign = mkRemoteProducer(ctx, {
      produces: ["github_ea.md"],
      missionId: "M_R1F",
    });
    const fexec = ctx.store.get("executor_execution", foreign.eid);
    upload(ctx, fexec, "github_ea.md", "foreign");
    completeRemote(ctx, foreign.eid);
    expect(String(validate(ctx, foreign.eid).status)).toBe("PASS");
    const p = mkRemoteProducer(ctx, {
      produces: ["github_ea.md", "outbox/github_ea.md"],
      missionId: "M_R1F",
    });
    completeRemote(ctx, p.eid);
    const v = validate(ctx, p.eid);
    expect(String(v.status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "github_ea.md",
      "outbox/github_ea.md",
    ]);
  });

  it("R1-G. wrong directories still fail under injective binding", () => {
    const ctx = makeCtx("rpn1r1-g");
    const p = mkRemoteProducer(ctx, {
      produces: ["dirA/x.md"],
      missionId: "M_R1G",
    });
    const exec = ctx.store.get("executor_execution", p.eid);
    upload(ctx, exec, "dirB/x.md", "other");
    completeRemote(ctx, p.eid);
    expect(String(validate(ctx, p.eid).status)).toBe("FAIL");
    expect(validationRow(ctx, p.eid)!.remote_produces_missing).toEqual([
      "dirA/x.md",
    ]);
  });
});
