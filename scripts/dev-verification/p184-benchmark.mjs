#!/usr/bin/env node
/**
 * P18.4 Phase I — recovery-integrity benchmark.
 *
 * Complements p183-benchmark.mjs (collection/settle latency). Measures
 * the NEW P18.4 surfaces on the production object graph:
 *
 *   handoff   — deferred→pending handoff latency: queued_at → the tick
 *               that arms pending_recovery, plus wall-time of the
 *               atomic handoff transaction itself.
 *   tickcost  — supervisor tick wall-time with N in-flight executions
 *               (the sweep is the recurring cost center).
 *   writeamp  — durable write amplification per settlement: number of
 *               store.put calls between terminal-observed and settled,
 *               before/after atomic settlement (expected: same or fewer,
 *               because co-committed writes still count individually but
 *               no retry re-puts occur).
 *
 * Usage: node scripts/dev-verification/p184-benchmark.mjs --scenario handoff --trials 6
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
const SCENARIO = String(args.scenario ?? "handoff");
const TRIALS = Math.max(1, Number(args.trials ?? 6));
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

const FAIL = path.resolve("src/__tests__/fixtures/fake-codex-conditional.mjs");
const ARGV = path.resolve("src/__tests__/fixtures/fake-codex-argv.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const parseMs = (iso) => (iso ? Date.parse(String(iso)) : null);

function makeCtx(name, { planner, fixture = ARGV, concurrency = 4 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p184-bench-${name}-`));
  const wsDir = path.join(dir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });
  const journalRoot = path.join(dir, "journal");
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  // writeamp instrumentation — counts canonical writes without touching
  // production code paths.
  let putCount = 0;
  const origPut = store.put.bind(store);
  store.put = (...a) => { putCount++; return origPut(...a); };
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map();
  const recon = new ReconciliationService(service, adapters);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: concurrency });
  const codex = new CodexCliExecutorAdapter({
    journalRoot,
    store,
    executable: "node",
    executableArgs: [fixture],
    envReader: (n) => (n === "CODEX_API_KEY" ? "bench-fixture" : undefined),
  });
  adapters.set(CODEX_EXECUTOR_ID, codex);
  registerGovernedExecutors(service, new Map([[CODEX_EXECUTOR_ID, codex]]), "PAIR_BENCH");
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery,
    planner: planner ?? (() => ({ tasks: [] })),
  });
  const sup = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor: sup, scheduler, approvals,
    reconciliation: recon,
    planner: planner ?? (() => ({ tasks: [] })),
  });
  const project = service.createProject({ name: "bench", root_location: wsDir });
  return {
    dir, wsDir, store, service, runtime, control, codex, journalRoot,
    projectId: String(project.project_id),
    puts: () => putCount,
  };
}

const TWO_FAIL = () => ({
  tasks: [
    { task_key: "T1", title: "t1", task_instruction: "always-fail one", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T2", title: "t2", task_instruction: "always-fail two", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T3", title: "t3", task_instruction: "keepalive", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
  ],
});
const N_TASKS = (n) => () => ({
  tasks: Array.from({ length: n }, (_, i) => ({
    task_key: `T${i + 1}`, title: `t${i + 1}`, task_instruction: `task ${i + 1}`,
    required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
  })),
});

const execs = (ctx, mid) =>
  ctx.store.list("executor_execution").filter((e) => e.mission_id === mid);
const rtRow = (ctx, mid) =>
  ctx.store.list("mission_runtime").find((r) => r.mission_id === mid);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median_ms: q(0.5) ?? null, p95_ms: q(0.95) ?? null, worst_ms: s.length ? s[s.length - 1] : null };
};
async function waitExit(ctx, eid) {
  const deadline = nowMs() + 30_000;
  while (nowMs() < deadline) {
    if (String(ctx.codex.observe(eid).status) !== "RUNNING") return;
    await sleep(30);
  }
  throw new Error(`child ${eid} never terminal`);
}

/** deferred→pending handoff latency: queue both failures, let the first
 *  arm pending, then measure how long the surviving deferred entry takes
 *  to arm once pending frees. Also measures the atomic txn wall-time. */
async function trialHandoff(i) {
  const ctx = makeCtx(`h${i}`, { planner: TWO_FAIL, fixture: FAIL.replace("conditional", "fail") });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench-handoff", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"], authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const deadline = nowMs() + LIMIT_S * 1000;
  while (execs(ctx, mid).length < 2 && nowMs() < deadline) { ctx.runtime.tick(mid); await sleep(TICK_MS); }
  const ids = execs(ctx, mid).map((e) => String(e.execution_id));
  await Promise.all(ids.slice(0, 2).map((id) => waitExit(ctx, id)));
  // Drive until deferred_recovery is populated.
  let rt;
  for (;;) {
    ctx.runtime.tick(mid);
    rt = rtRow(ctx, mid);
    const d = (rt.deferred_recovery ?? []);
    if (d.length > 0 || execs(ctx, mid).filter((e) => e.result).length >= 2) break;
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  const d0 = (rt.deferred_recovery ?? [])[0];
  if (!d0) return { trial: i, handoff_ms: null, note: "no deferred entry formed (drained before arm)" };
  const tQueued = parseMs(d0.queued_at) ?? nowMs();
  // Now drive until THAT entry's task_id shows up in pending_recovery.
  // With born-failing siblings pending frees only in brief windows —
  // the drain arms one entry per tick, so wait the full deadline.
  let handoffMs = null, txnMs = null;
  for (;;) {
    const t0 = nowMs();
    ctx.runtime.tick(mid);
    const t1 = nowMs();
    rt = rtRow(ctx, mid);
    const p = rt.pending_recovery;
    if (p && String(p.task_id) === String(d0.task_id)) {
      handoffMs = parseMs(p.armed_at ?? p.created_at ?? "") != null
        ? parseMs(p.armed_at ?? p.created_at) - tQueued
        : t1 - tQueued;
      txnMs = t1 - t0;
      break;
    }
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  return { trial: i, handoff_ms: handoffMs, handoff_tick_ms: txnMs, queued_at: d0.queued_at };
}

/** Supervisor tick wall-time under in-flight load. */
async function trialTickCost(i, nTasks = 4) {
  const ctx = makeCtx(`t${i}`, { planner: N_TASKS(nTasks) });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench-tick", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"], authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const deadline = nowMs() + LIMIT_S * 1000;
  while (execs(ctx, mid).length < nTasks && nowMs() < deadline) { ctx.runtime.tick(mid); await sleep(TICK_MS); }
  // Children may or may not have exited — tick cost covers the full
  // sweep+collect+recovery evaluation either way.
  const times = [];
  for (let k = 0; k < 20; k++) {
    const t0 = nowMs();
    ctx.runtime.tick(mid);
    times.push(nowMs() - t0);
    await sleep(10);
  }
  return { trial: i, in_flight: nTasks, tick_ms: times };
}

/** Durable writes per settle — count puts from first_terminal_observed
 *  to settled for one execution. */
async function trialWriteAmp(i) {
  const ctx = makeCtx(`w${i}`, { planner: N_TASKS(1) });
  const m = ctx.control.startMission({
    project_id: ctx.projectId, goal: "bench-wa", metadata: {},
    granted_permissions: ["FILE_WRITE", "FILE_READ"], authorized_workspaces: [ctx.wsDir],
  });
  const mid = String(m.mission_id);
  const deadline = nowMs() + LIMIT_S * 1000;
  while (execs(ctx, mid).length < 1 && nowMs() < deadline) { ctx.runtime.tick(mid); await sleep(TICK_MS); }
  const eid = String(execs(ctx, mid)[0].execution_id);
  await waitExit(ctx, eid);
  const base = ctx.puts();
  let row;
  for (;;) {
    ctx.runtime.tick(mid);
    row = ctx.store.get("executor_execution", eid);
    if (row.settle_complete === true || (row.result && row.settled_at)) break;
    if (nowMs() > deadline) break;
    await sleep(TICK_MS);
  }
  return {
    trial: i,
    settled: row.settle_complete === true || Boolean(row.result && row.settled_at),
    puts_during_settle: ctx.puts() - base,
    collection_attempts: Number(row.collection_attempts ?? 0),
  };
}

const out = { scenario: SCENARIO, trials: TRIALS, tick_ms: TICK_MS, rows: [] };
if (SCENARIO === "handoff") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(await trialHandoff(i));
  const lat = out.rows.map((r) => r.handoff_ms).filter((x) => x != null);
  const txn = out.rows.map((r) => r.handoff_tick_ms).filter((x) => x != null);
  out.summary = { armed: lat.length, handoff_latency: stats(lat), handoff_tick_walltime: stats(txn) };
} else if (SCENARIO === "tickcost") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(await trialTickCost(i, Number(args.tasks ?? 4)));
  const all = out.rows.flatMap((r) => r.tick_ms);
  out.summary = { in_flight_per_tick: Number(args.tasks ?? 4), tick_walltime: stats(all) };
} else if (SCENARIO === "writeamp") {
  for (let i = 0; i < TRIALS; i++) out.rows.push(await trialWriteAmp(i));
  const puts = out.rows.map((r) => r.puts_during_settle);
  out.summary = { settled: out.rows.filter((r) => r.settled).length, puts_per_settle: stats(puts) };
}
console.log(JSON.stringify(out, null, 1));
