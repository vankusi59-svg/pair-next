#!/usr/bin/env node
/**
 * P18.4 live-stack E2E-8 helper — drives a REAL canonical mission
 * (runtime + gate + collect + settle + recovery) against the SAME
 * pair.db the live Mission Control server is projecting. The server
 * then renders genuinely canonical execution-health and recovery-ops
 * state in the UI — no model spend, no fabricated rows.
 *
 * Produces a mission with, over ~20s of driven ticks:
 *  - one SETTLED execution (real fixture child)
 *  - one born-failing execution → armed pending_recovery
 *  - a second failure → deferred_recovery entry + recovery history
 *  - backoff/approval state where the chain reaches it
 *
 * Usage: PAIR_MC_DIR=tmp/p184-live node scripts/dev-verification/p184-live-mission.mjs
 * (server must already be running against the same pair.db)
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIR = path.resolve(process.env.PAIR_MC_DIR ?? "tmp/p184-live");
const DIST = path.resolve("dist");
const FIX = path.resolve("src/__tests__/fixtures/fake-codex-conditional.mjs");

const {
  PairEvidenceStore, PairControlPlane, GovernedTaskGate, MissionRouter,
  MissionRuntime, MissionScheduler, MissionSupervisor, MissionControl,
  MissionObservability, ReconciliationService, RecoveryController,
  ApprovalQueue, CodexCliExecutorAdapter, CODEX_EXECUTOR_ID,
  registerGovernedExecutors,
} = await import(pathToFileURL(path.join(DIST, "pair/index.js")).href);

const dbPath = path.join(DIR, "pair.db");
if (!fs.existsSync(dbPath)) throw new Error(`no pair.db at ${dbPath} — start the MC server first`);

const wsDir = path.join(DIR, "ws-live");
fs.mkdirSync(wsDir, { recursive: true });
const journalRoot = path.join(DIR, "journal-live");

const store = new PairEvidenceStore(dbPath);
const service = new PairControlPlane(store);
const gate = new GovernedTaskGate(service);
const router = new MissionRouter(service, gate);
const recovery = new RecoveryController(service);
const adapters = new Map();
const recon = new ReconciliationService(service, adapters);
const approvals = new ApprovalQueue(service);
const scheduler = new MissionScheduler(service, { mission_concurrency: 4 });
const codex = new CodexCliExecutorAdapter({
  journalRoot, store, executable: "node", executableArgs: [FIX],
  envReader: (n) => (n === "CODEX_API_KEY" ? "live-e2e-fixture" : undefined),
});
adapters.set(CODEX_EXECUTOR_ID, codex);
registerGovernedExecutors(service, new Map([[CODEX_EXECUTOR_ID, codex]]), "PAIR_LIVE_E2E");
service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
const planner = () => ({
  tasks: [
    { task_key: "T1", title: "settle cleanly", task_instruction: "record baseline", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T2", title: "fail into recovery", task_instruction: "always-fail recovery path", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T3", title: "fail into deferred", task_instruction: "always-fail deferred path", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
  ],
});
const runtime = new MissionRuntime({
  service, gate, router, adapters, scheduler, approvals,
  reconciliation: recon, recovery, planner,
});
const sup = new MissionSupervisor(service, runtime, recovery, recon);
const observability = new MissionObservability(service);
const control = new MissionControl({
  service, runtime, supervisor: sup, scheduler, approvals,
  reconciliation: recon, observability, planner,
});
const project = store.list("project")[0] ?? service.createProject({ name: "live-e2e", root_location: wsDir });

const m = control.startMission({
  project_id: String(project.project_id), goal: "p184 live e2e", metadata: {},
  granted_permissions: ["FILE_WRITE", "FILE_READ"], authorized_workspaces: [wsDir],
});
const mid = String(m.mission_id);
console.log(`MISSION=${mid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Drive ~25s of ticks — enough for T1 settle + T2 arm + T3 defer while
// the always-fail siblings churn the recovery cycle.
for (let i = 0; i < 55; i++) {
  runtime.tick(mid);
  const rt = store.get("mission_runtime", `MRT_${mid}`);
  const def = (rt?.deferred_recovery ?? []).length;
  if (rt?.pending_recovery && def >= 1 && i > 6) break;
  await sleep(400);
}
const rt = store.get("mission_runtime", `MRT_${mid}`);
const ex = store.list("executor_execution").filter((e) => e.mission_id === mid);
console.log(JSON.stringify({
  mission_id: mid,
  runtime_state: rt?.state,
  pending: rt?.pending_recovery != null,
  deferred: (rt?.deferred_recovery ?? []).length,
  executions: ex.map((e) => ({
    id: String(e.execution_id), state: e.execution_state,
    settled: e.settle_complete === true, result: e.result != null,
  })),
}, null, 1));
// Leave the mission live — the server UI inspects real canonical state.
process.exit(0);
