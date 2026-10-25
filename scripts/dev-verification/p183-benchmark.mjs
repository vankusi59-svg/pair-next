#!/usr/bin/env node
/**
 * P18.3 Phase I — collection-latency benchmark.
 *
 * Measures REAL child-process completion → canonical settlement latency
 * on the production object graph (fake codex CLI is the only stub; every
 * PAIR component — gate, runtime, collect, settle, artifacts — is real).
 *
 * Usage (run inside a repo root with built dist/):
 *   node scripts/dev-verification/p183-benchmark.mjs \
 *     --scenario normal --trials 8 --limit 60
 *
 * Scenarios:
 *   normal      — 1-task mission; finish→settle latency per trial.
 *   concurrent  — 4-task mission; per-execution finish→settle (throughput).
 *   starvation  — 2-task mission; T1 FAILED→recovery while T2 completes
 *                 mid-recovery (the RC-A/RC-B production incident shape).
 *
 * Durable stamps measured: finished_at → first_terminal_observed_at →
 * collection_committed_at → settled_at → task COMPLETED.
 * Output: JSON summary on stdout (median/p95/worst + per-trial rows).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, /** @type {[string,string][]} */ ([])),
);
const SCENARIO = String(args.scenario ?? "normal");
const TRIALS = Math.max(1, Number(args.trials ?? 8));
const LIMIT_S = Number(args.limit ?? 60);
const TICK_MS = Number(args.tick_ms ?? 250);
const DIST = args.dist ? path.resolve(String(args.dist)) : path.resolve("dist");

const {
  PairEvidenceStore,
  PairControlPlane,
  GovernedTaskGate,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  MissionControl,
  ReconciliationService,
  RecoveryController,
  ApprovalQueue,
  CodexCliExecutorAdapter,
  CODEX_EXECUTOR_ID,
  registerGovernedExecutors,
} = await import(pathToFileURL(path.join(DIST, "pair/index.js")).href);
const { codexRunRoot } = await import(
  pathToFileURL(path.join(DIST, "pair/codex-adapter.js")).href
);
const FAKE = path.resolve("src/__tests__/fixtures/fake-codex-argv.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const parseMs = (iso) => (iso ? Date.parse(String(iso)) : null);

function makeCtx(name, { taskCount = 1, withWake = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p183-bench-${name}-`));
  const wsDir = path.join(dir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });
  const journalRoot = path.join(dir, "journal");
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const wakes = [];
  const codex = new CodexCliExecutorAdapter({
    journalRoot,
    store,
    executable: "node",
    executableArgs: [FAKE],
    envReader: (n) => (n === "CODEX_API_KEY" ? "bench-fixture" : undefined),
    onFinished: (info) => {
      info._t_callback = nowMs();
      wakes.push(info);
      if (withWake && info.mission_id) {
        try {
          sup.wake(String(info.mission_id), "EXECUTOR_COMPLETION", {
            execution_id: info.execution_id,
            task_id: info.task_id,
            executor_id: CODEX_EXECUTOR_ID,
            status: info.status,
            finished_at: info.finished_at,
          });
        } catch { /* hint only */ }
      }
    },
  });
  adapters.set(CODEX_EXECUTOR_ID, codex);
  registerGovernedExecutors(
    service,
    new Map([[CODEX_EXECUTOR_ID, codex]]),
    "PAIR_BENCH",
  );
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const planner = () => ({
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      task_key: `T${i + 1}`,
      title: `t${i + 1}`,
      task_instruction: `task ${i + 1}`,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
    })),
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const sup = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor: sup, scheduler, approvals,
    reconciliation: recon, planner,
  });
  const project = service.createProject({ name: "bench", root_location: wsDir });
  return { dir, wsDir, store, service, runtime, control, codex, wakes, journalRoot, projectId: String(project.project_id) };
}

async function drive(ctx, mid, { failFirst = false } = {}) {
  const execs = () =>
    ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
  const deadline = nowMs() + LIMIT_S * 1000;
  let failedOnce = false;
  while (nowMs() < deadline) {
    const rows = execs();
    if (rows.length) {
      // starvation scenario: force T1's execution terminal-FAILED via a
      // direct journal write? No — real: we can't inject; instead we let
      // the real child complete all tasks (both COMPLETED). Starvation is
      // measured differently below (see runStarvation).
      break;
    }
    ctx.runtime.tick(mid);
    await sleep(TICK_MS);
  }
  return execs;
}

/** Observe adapter-side until a run_root result exists (child exited). */
async function waitChildDone(ctx, eid) {
  const deadline = nowMs() + 30_000;
  while (nowMs() < deadline) {
    if (String(ctx.codex.observe(eid).status) !== "RUNNING") return;
    await sleep(40);
  }
  throw new Error(`child ${eid} never terminal`);
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    median_ms: q(0.5) ?? null,
    p95_ms: q(0.95) ?? null,
    worst_ms: s.length ? s[s.length - 1] : null,
  };
};

async function trialNormal(i) {
  const ctx = makeCtx(`n${i}`, { taskCount: 1 });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const execs = await drive(ctx, mid);
  const eid = String(execs()[0].execution_id);
  const tDispatch = nowMs();
  await waitChildDone(ctx, eid);
  const tFinished = nowMs();
  // Sweep-cadence ticks — the supervisor does this on its own; wake is a
  // hint, never required.
  const deadline = nowMs() + LIMIT_S * 1000;
  let row;
  for (;;) {
    ctx.runtime.tick(mid);
    row = ctx.store.get("executor_execution", eid);
    if (row.result && String(ctx.store.get("task", String(row.task_id)).status) === "COMPLETED") break;
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  const settled = row.result && String(ctx.store.get("task", String(row.task_id)).status) === "COMPLETED";
  return {
    trial: i,
    settled,
    finish_to_first_terminal_observed_ms:
      parseMs(row.first_terminal_observed_at) != null ? parseMs(row.first_terminal_observed_at) - tFinished : null,
    finish_to_collect_committed_ms:
      parseMs(row.collection_committed_at) != null ? parseMs(row.collection_committed_at) - tFinished : null,
    finish_to_settled_ms: settled ? nowMs() - tFinished : null,
    collection_attempts: Number(row.collection_attempts ?? 0),
    dispatch_overhead_ms: tFinished - tDispatch,
  };
}

async function trialConcurrent(i, nTasks = 4) {
  const ctx = makeCtx(`c${i}`, { taskCount: nTasks });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const execs = await drive(ctx, mid);
  const ids = execs().map((e) => String(e.execution_id));
  await Promise.all(ids.map((id) => waitChildDone(ctx, id)));
  const tFinished = nowMs();
  const deadline = nowMs() + LIMIT_S * 1000;
  const rows = () => ids.map((id) => ctx.store.get("executor_execution", id));
  for (;;) {
    ctx.runtime.tick(mid);
    if (rows().every((r) => r.result)) break;
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  return rows().map((r, k) => ({
    trial: i, exec: k,
    settled: Boolean(r.result),
    finish_to_collect_committed_ms:
      parseMs(r.collection_committed_at) != null ? parseMs(r.collection_committed_at) - tFinished : null,
    collection_attempts: Number(r.collection_attempts ?? 0),
  }));
}

/** The RC-A/RC-B incident shape: while a recovery decision is pending on
 *  one task, a sibling execution reaches terminal. Pre-fix runtimes only
 *  observed in-flight executions inside runRunning — a runtime parked in
 *  RECOVERING/WAITING_BACKOFF starved the sibling until the chain drained
 *  (the production 63-minute window). Measure whether T2 settles within
 *  the limit while T1's recovery chain is live. */
async function trialStarvation(i) {
  const ctx = makeCtx(`s${i}`, { taskCount: 2 });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const execs = await drive(ctx, mid);
  const ids = execs().map((e) => String(e.execution_id));
  await Promise.all(ids.map((id) => waitChildDone(ctx, id)));
  // Force the pre-fix starvation window: runtime RUNNING with a pending
  // HUMAN_APPROVAL_REQUIRED recovery for T1 — the apply path parks the
  // runtime in WAITING_APPROVAL (a LIVE state), after which the pre-fix
  // observe loop never runs again (RC-B). Post-fix the hoisted sweep
  // still collects T2. Durable-row surgery mirrors what a real recovery
  // chain leaves behind; it fabricates no execution evidence.
  const rt = ctx.store.list("mission_runtime").find((r) => r.mission_id === mid);
  const t1 = execs()[0];
  ctx.store.put("mission_runtime", String(rt.mission_runtime_id), {
    ...rt,
    state: "RUNNING",
    pending_recovery: {
      recovery_id: "RCV_BENCH_STARVE",
      action: "HUMAN_APPROVAL_REQUIRED",
      task_id: String(t1.task_id),
      execution_id: String(t1.execution_id),
      governed_task_id: String(t1.governed_task_id ?? ""),
      executor_id: CODEX_EXECUTOR_ID,
      failure_class: "EXECUTION_FAILURE",
      backoff_ms: 0,
      infeasible_actions: [],
      failure_context: null,
    },
  }, Number(rt.version));
  const tFinished = nowMs();
  const e2 = execs()[1];
  const deadline = nowMs() + LIMIT_S * 1000;
  let row;
  for (;;) {
    ctx.runtime.tick(mid);
    row = ctx.store.get("executor_execution", String(e2.execution_id));
    if (row.result) break;
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  return {
    trial: i,
    settled: Boolean(row.result),
    finish_to_collect_committed_ms:
      parseMs(row.collection_committed_at) != null
        ? parseMs(row.collection_committed_at) - tFinished
        : null,
    rt_state_at_end: String(ctx.store.list("mission_runtime").find((r) => r.mission_id === mid).state),
  };
}

const out = { scenario: SCENARIO, trials: TRIALS, limit_s: LIMIT_S, tick_ms: TICK_MS, rows: [] };
if (SCENARIO === "normal") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(await trialNormal(i));
  const settledLat = out.rows.map((r) => r.finish_to_settled_ms).filter((x) => x != null);
  const obsLat = out.rows.map((r) => r.finish_to_first_terminal_observed_ms).filter((x) => x != null);
  const colLat = out.rows.map((r) => r.finish_to_collect_committed_ms).filter((x) => x != null);
  out.summary = {
    settled: out.rows.filter((r) => r.settled).length,
    finish_to_first_terminal_observed: stats(obsLat),
    finish_to_collect_committed: stats(colLat),
    finish_to_settled: stats(settledLat),
  };
} else if (SCENARIO === "concurrent") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(...(await trialConcurrent(i)));
  const lat = out.rows.map((r) => r.finish_to_collect_committed_ms).filter((x) => x != null);
  out.summary = {
    settled: out.rows.filter((r) => r.settled).length,
    total_execs: out.rows.length,
    finish_to_collect_committed: stats(lat),
  };
} else if (SCENARIO === "starvation") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(await trialStarvation(i));
  const lat = out.rows.map((r) => r.finish_to_collect_committed_ms).filter((x) => x != null);
  out.summary = {
    settled: out.rows.filter((r) => r.settled).length,
    finish_to_collect_committed: stats(lat),
  };
}
console.log(JSON.stringify(out, null, 1));
