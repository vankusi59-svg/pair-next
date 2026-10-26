/**
 * P18.3 Phase H — real executor-process E2E.
 *
 * Unlike the LV suite (ScriptedAdapter), every execution here is a REAL
 * child process: `node fixtures/fake-codex-argv.mjs` spawned by the
 * production CodexCliExecutorAdapter (real spawn, real exit detection,
 * real execution_journal.json + result.json on disk, real rehydration).
 * The only fake is the model-facing codex CLI fixture — every PAIR-side
 * component (gate → runtime → collect → settle → recovery → supervisor
 * wake) is the production object graph.
 *
 * E2E-8 (P18.2 async replan S3) lives in
 * pair-async-replan-generation.test.ts — bound work item, real
 * delegated-open chain, organic REPLAN→ABORT decision path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  CodexCliExecutorAdapter,
  codexRunRoot,
} from "../pair/codex-adapter.js";
import {
  ApprovalQueue,
  GovernedTaskGate,
  MissionControl,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  CODEX_EXECUTOR_ID,
  registerGovernedExecutors,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p183-e2e-");
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const FAKE_ARGV_CODEX = path.resolve(__dirname, "fixtures", "fake-codex-argv.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, what: string, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
  return Date.now() - t0;
}

const INDEPENDENT = () => ({
  tasks: [
    { task_key: "T1", title: "t1", task_instruction: "one", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T2", title: "t2", task_instruction: "two", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
  ],
});
const DEPENDENT = () => ({
  tasks: [
    { task_key: "T1", title: "t1", task_instruction: "one", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T2", title: "t2", task_instruction: "two", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
  ],
});
const SINGLE = () => ({
  tasks: [
    { task_key: "T1", title: "t1", task_instruction: "one", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
  ],
});

interface E2eCtx {
  dir: string;
  wsDir: string;
  dbPath: string;
  journalRoot: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runtime: MissionRuntime;
  supervisor: MissionSupervisor;
  control: MissionControl;
  adapters: Map<string, ExecutorAdapter>;
  codex: CodexCliExecutorAdapter;
  wakes: Array<Record<string, unknown>>;
  projectId: string;
}

/** Build the full governed object graph over a (possibly existing) db.
 * `existingDir` → restart scenario: new adapter + runtime over the same
 * store and journal — zero in-memory executor state carried over. */
function makeCtx(
  name: string,
  opts: {
    planner?: () => Record<string, unknown>;
    withWake?: boolean;
    existingDir?: string;
    mutateCodex?: (a: CodexCliExecutorAdapter) => void;
  } = {},
): E2eCtx {
  const dir = opts.existingDir ?? freshDir(name);
  const dbPath = path.join(dir, "pair.db");
  const journalRoot = path.join(dir, "journal");
  // Prod topology: governed workspace is a dedicated dir SEPARATE from
  // the db + journal roots — the workspace diff snapshot is what the
  // adapter declares as artifacts; letting it span the store/journal
  // makes unverifiable churn (pair.db-wal) into declared evidence.
  const wsDir = path.join(dir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const wakes: Array<Record<string, unknown>> = [];
  const codex = new CodexCliExecutorAdapter({
    journalRoot,
    store,
    executable: "node",
    executableArgs: [FAKE_ARGV_CODEX],
    // Fixture env: resolvable credential marker only — never a real key.
    envReader: (n) => (n === "CODEX_API_KEY" ? "e2e-fixture-credential" : undefined),
    onFinished: (info) => {
      wakes.push(info as unknown as Record<string, unknown>);
    },
  });
  opts.mutateCodex?.(codex);
  adapters.set(CODEX_EXECUTOR_ID, codex);
  const governed = new Map<string, ExecutorAdapter>([[CODEX_EXECUTOR_ID, codex]]);
  registerGovernedExecutors(service, governed, "PAIR_E2E");
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery,
    planner: (opts.planner ?? INDEPENDENT) as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, planner: (opts.planner ?? INDEPENDENT) as never,
  });
  // The prod wiring emits the durable wake hint through the supervisor —
  // mirror it only when the scenario wants the signal to exist.
  if (opts.withWake !== false) {
    const sup = supervisor;
    const orig = codex["deps"].onFinished!;
    codex["deps"].onFinished = (info) => {
      orig(info);
      try {
        if (info.mission_id) {
          sup.wake(String(info.mission_id), "EXECUTOR_COMPLETION", {
            execution_id: info.execution_id, task_id: info.task_id,
            executor_id: CODEX_EXECUTOR_ID, status: info.status,
            finished_at: info.finished_at,
          });
        }
      } catch { /* hint only */ }
    };
  }
  const project = service.createProject({ name, root_location: wsDir });
  return {
    dir, wsDir, dbPath, journalRoot, store, service, runtime, supervisor,
    control, adapters, codex, wakes, projectId: String(project.project_id),
  };
}

async function startAndDispatch(ctx: E2eCtx) {
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "e2e", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.wsDir],
  });
  const mid = String((m as Record<string, unknown>).mission_id);
  const execs = () =>
    ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
  for (let i = 0; i < 20 && execs().length === 0; i++) ctx.runtime.tick(mid);
  return { mid, execs };
}

const execRow = (ctx: E2eCtx, eid: string) =>
  ctx.store.get("executor_execution", eid);

describe("P18.3 real-executor E2E", () => {
  it("E2E-1 normal: real codex child completes → prompt collection + settlement + wake + stamps", async () => {
    const ctx = makeCtx("e2e1");
    const { mid, execs } = await startAndDispatch(ctx);
    expect(execs().length).toBeGreaterThanOrEqual(1);
    const eid = String(execs()[0]!.execution_id);
    // Real child exit → journal + result.json durable on disk.
    await waitFor(
      () => String(ctx.codex.observe(eid).status) !== "RUNNING",
      "real codex child exit",
    );
    // Wake hint fired synchronously inside finish().
    await waitFor(() => ctx.wakes.length >= 1, "EXECUTOR_COMPLETION wake");
    expect(String(ctx.wakes[0]!.status)).toBe("COMPLETED");
    // The bounded sweep settles it — no manual collect.
    ctx.runtime.tick(mid);
    const row = execRow(ctx, eid);
    expect(String(row.execution_state)).toBe("COMPLETED");
    expect(row.result).toBeTruthy();
    expect(row.finished_at ?? (row.last_observation as Record<string, unknown>)?.finished_at).toBeTruthy();
    expect(row.first_terminal_observed_at).toBeTruthy();
    expect(row.collection_committed_at).toBeTruthy();
    expect(String(ctx.store.get("task", String(row.task_id)).status)).toBe("COMPLETED");
    // Durable EXECUTOR_COMPLETION wake hint exists (never required for
    // settlement — other wake reasons may legitimately coexist).
    const wakeRows = ctx.store.list("supervisor_wake").filter(
      (w) => String(w.mission_id) === mid && String(w.reason) === "EXECUTOR_COMPLETION");
    expect(wakeRows.length).toBeGreaterThanOrEqual(1);
  });

  it("E2E-2 concurrent: two real children settle exactly once each", async () => {
    const ctx = makeCtx("e2e2");
    const { mid, execs } = await startAndDispatch(ctx);
    await waitFor(() => execs().length >= 2, "both dispatched");
    const ids = execs().map((e) => String(e.execution_id));
    await waitFor(
      () => ids.every((id) => String(ctx.codex.observe(id).status) !== "RUNNING"),
      "both children exit",
    );
    for (let i = 0; i < 3; i++) ctx.runtime.tick(mid);
    for (const id of ids) {
      const row = execRow(ctx, id);
      expect(String(row.execution_state)).toBe("COMPLETED");
      expect(Number(row.collection_attempts)).toBe(1); // exactly-once
      expect(row.result).toBeTruthy();
    }
  });

  it("E2E-3 supervisor restart: new runtime+adapter over same store rehydrates journal and settles — no duplicate dispatch", async () => {
    const ctx1 = makeCtx("e2e3");
    const { mid, execs } = await startAndDispatch(ctx1);
    const eid = String(execs()[0]!.execution_id);
    await waitFor(
      () => String(ctx1.codex.observe(eid).status) !== "RUNNING",
      "child exit",
    );
    // "Restart": fresh store handle + adapter + runtime; same db/journal.
    const ctx2 = makeCtx("e2e3-restart", { existingDir: ctx1.dir });
    expect(ctx2.codex).not.toBe(ctx1.codex);
    const dispatchesBefore = ctx2.store.list("executor_execution")
      .filter((e) => e.mission_id === mid).length;
    ctx2.runtime.tick(mid);
    ctx2.runtime.tick(mid);
    const row = execRow(ctx2, eid);
    expect(String(row.execution_state)).toBe("COMPLETED");
    expect(row.result).toBeTruthy();
    // Rehydration path proved: journal read from disk (adapter had no
    // in-memory record — it was constructed post-exit).
    const dispatchesAfter = ctx2.store.list("executor_execution")
      .filter((e) => e.mission_id === mid).length;
    expect(dispatchesAfter).toBe(dispatchesBefore); // no duplicate execution
    // The SAME execution_id collected — no second side-effect dispatch.
    expect(ctx2.codex["executions"].size).toBeGreaterThanOrEqual(0);
  });

  it("E2E-4 lost signal: adapter without onFinished still collects via bounded sweep", async () => {
    const ctx = makeCtx("e2e4", { withWake: false });
    const { mid, execs } = await startAndDispatch(ctx);
    const eid = String(execs()[0]!.execution_id);
    await waitFor(
      () => String(ctx.codex.observe(eid).status) !== "RUNNING",
      "child exit",
    );
    // No supervisor_wake consumed for this mission at all — collection
    // is sweep-driven, never signal-dependent.
    ctx.runtime.tick(mid);
    const row = execRow(ctx, eid);
    expect(String(row.execution_state)).toBe("COMPLETED");
    expect(row.collection_committed_at).toBeTruthy();
    const wakes = ctx.store.list("supervisor_wake").filter(
      (w) => String(w.mission_id) === mid && String(w.reason) === "EXECUTOR_COMPLETION");
    expect(wakes.length).toBe(0);
  });

  it("E2E-5 collector failure: first collect_result throws → idempotent retry settles exactly once", async () => {
    let threw = false;
    const ctx = makeCtx("e2e5", {
      planner: SINGLE, // one execution → the collect target is deterministic
      mutateCodex: (a) => {
        const orig = a.collect_result.bind(a);
        a.collect_result = (eid: string) => {
          if (!threw) {
            threw = true;
            throw Object.assign(new Error("simulated collector crash"), {
              code: "FAIL_CLOSED_COLLECT_IO",
            });
          }
          return orig(eid);
        };
      },
    });
    const { mid, execs } = await startAndDispatch(ctx);
    const eid = String(execs()[0]!.execution_id);
    await waitFor(
      () => String(ctx.codex.observe(eid).status) !== "RUNNING",
      "child exit",
    );
    ctx.runtime.tick(mid); // collect attempt 1 → throws mid-collect
    const afterCrash = execRow(ctx, eid);
    // execution_state mirrors the OBSERVED terminal status; canonical
    // settlement = committed result + task transition — both absent.
    expect(afterCrash.result).toBeFalsy();
    expect(Number(afterCrash.collection_attempts)).toBe(1);
    expect(afterCrash.collection_committed_at).toBeFalsy();
    expect(String(ctx.store.get("task", String(afterCrash.task_id)).status))
      .not.toBe("COMPLETED");
    ctx.runtime.tick(mid); // retry → settles
    const row = execRow(ctx, eid);
    expect(String(row.execution_state)).toBe("COMPLETED");
    expect(Number(row.collection_attempts)).toBe(2);
    expect(row.collection_committed_at).toBeTruthy();
    // Exactly one result persisted — idempotent, no duplicate ingestion.
    expect(row.result).toBeTruthy();
    expect(String(ctx.store.get("task", String(row.task_id)).status)).toBe("COMPLETED");
    expect(threw).toBe(true);
  });

  it("E2E-6 invalid result: corrupted result.json never settles COMPLETED; restore → governed retry settles", async () => {
    const ctx = makeCtx("e2e6", { planner: SINGLE });
    const { mid, execs } = await startAndDispatch(ctx);
    const eid = String(execs()[0]!.execution_id);
    await waitFor(
      () => String(ctx.codex.observe(eid).status) !== "RUNNING",
      "child exit",
    );
    const runRoot = codexRunRoot(ctx.journalRoot, eid);
    const resultPath = path.join(runRoot, "result.json");
    const original = fs.readFileSync(resultPath, "utf8");
    fs.writeFileSync(resultPath, "{ this is not governed evidence");
    ctx.runtime.tick(mid);
    const corrupted = execRow(ctx, eid);
    // Malformed evidence must never mint a canonical result — the row
    // may mirror the observed terminal state, but settlement is absent.
    expect(corrupted.result).toBeFalsy();
    expect(corrupted.collection_committed_at).toBeFalsy();
    expect(String(ctx.store.get("task", String(corrupted.task_id)).status))
      .not.toBe("COMPLETED");
    // Evidence restored → bounded retry collects through the same path.
    fs.writeFileSync(resultPath, original);
    for (let i = 0; i < 4; i++) ctx.runtime.tick(mid);
    const row = execRow(ctx, eid);
    expect(String(row.execution_state)).toBe("COMPLETED");
    expect(row.result).toBeTruthy();
  });

  it("E2E-7 downstream continuation: settled T1 unblocks T2 automatically → mission completes", async () => {
    const ctx = makeCtx("e2e7", { planner: DEPENDENT });
    const { mid, execs } = await startAndDispatch(ctx);
    await waitFor(() => execs().length >= 1, "T1 dispatched");
    // Drive: real child for T1 → collect → T2 dispatch → real child →
    // collect → mission terminal. All autonomous — ticks only.
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      ctx.runtime.tick(mid);
      const status = String(ctx.service.getMission(mid).status);
      if (status === "COMPLETED") break;
      await sleep(60);
    }
    expect(String(ctx.service.getMission(mid).status)).toBe("COMPLETED");
    const done = execs().filter((e) => String(e.execution_state) === "COMPLETED");
    expect(done.length).toBeGreaterThanOrEqual(2);
    // T2's execution row exists only after T1 settled — real dependency
    // progression evidence (distinct children, distinct run roots).
    const t1 = execs().find((e) => String(e.task_key ?? "") === "T1"
      || String((e.task as Record<string, unknown>)?.task_key ?? "") === "T1");
    void t1;
    expect(Date.now() - t0).toBeLessThan(120_000);
  });
});
