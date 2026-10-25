#!/usr/bin/env node
/**
 * P18.4 live E2E-8 — mint a mission carrying persisted plan authority
 * (metadata.llm_plan), then leave it for the RUNNING Mission Control
 * server's own supervisor to plan/dispatch/settle. Single writer: the
 * server owns the whole lifecycle; this script only performs the same
 * control.startMission the UI's confirm path lands on.
 *
 * Usage: PAIR_MC_DIR=tmp/p184-live node scripts/dev-verification/p184-mint-live-mission.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIR = path.resolve(process.env.PAIR_MC_DIR ?? "tmp/p184-live");
const DIST = path.resolve("dist");

const {
  PairEvidenceStore, PairControlPlane, GovernedTaskGate, MissionRouter,
  MissionRuntime, MissionScheduler, MissionSupervisor, MissionControl,
  MissionObservability, ReconciliationService, RecoveryController,
  ApprovalQueue, CodexCliExecutorAdapter, CODEX_EXECUTOR_ID,
  registerGovernedExecutors,
} = await import(pathToFileURL(path.join(DIST, "pair/index.js")).href);

const dbPath = path.join(DIR, "pair.db");
const wsDir = path.join(DIR, "ws-live");
fs.mkdirSync(wsDir, { recursive: true });

const store = new PairEvidenceStore(dbPath);
const service = new PairControlPlane(store);
const gate = new GovernedTaskGate(service);
const router = new MissionRouter(service, gate);
const recovery = new RecoveryController(service);
const adapters = new Map();
const recon = new ReconciliationService(service, adapters);
const approvals = new ApprovalQueue(service);
const scheduler = new MissionScheduler(service, { mission_concurrency: 4 });
const observability = new MissionObservability(service);
const codex = new CodexCliExecutorAdapter({
  journalRoot: path.join(DIR, "journal-live"), store,
  executable: "node",
  executableArgs: [path.resolve("src/__tests__/fixtures/fake-codex-argv.mjs")],
  envReader: (n) => (n === "CODEX_API_KEY" ? "live-e2e-fixture" : undefined),
});
adapters.set(CODEX_EXECUTOR_ID, codex);
registerGovernedExecutors(service, new Map([[CODEX_EXECUTOR_ID, codex]]), "PAIR_LIVE_E2E");
service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
const runtime = new MissionRuntime({
  service, gate, router, adapters, scheduler, approvals,
  reconciliation: recon, recovery,
  planner: () => ({ tasks: [] }),
});
const sup = new MissionSupervisor(service, runtime, recovery, recon);
const control = new MissionControl({
  service, runtime, supervisor: sup, scheduler, approvals,
  reconciliation: recon, observability,
  planner: () => ({ tasks: [] }),
});
const project = store.list("project")[0];

const m = control.startMission({
  project_id: String(project.project_id),
  goal: "p184 live ops e2e",
  metadata: {
    // Persisted plan authority — the server's serve-planner returns this
    // verbatim (validated downstream). FILE_OPERATIONS tasks route to
    // PAIR_NATIVE — a REAL local executor on this box.
    llm_plan: [
      { task_key: "T1", title: "record the e2e note", task_instruction: "write an operator-visible note file", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
      { task_key: "T2", title: "summarize the note", task_instruction: "summarize the note into a second file", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
    ],
  },
  granted_permissions: ["FILE_WRITE", "FILE_READ"],
  authorized_workspaces: [wsDir],
});
console.log(`MISSION=${String(m.mission_id)}`);
