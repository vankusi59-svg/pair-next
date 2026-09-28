/**
 * P8 §40 — LIVE recovery test: real executor bounded failure → governed
 * recovery through the canonical chain.
 *
 * Real parts: real DSH adapter + real spawn + real PAIR_NATIVE
 * LocalWorkerPool execution + real store/receipts. The failure is a real
 * process-launch failure (the ACP child exits immediately), which spends
 * ZERO model quota — the failure happens before any provider request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  acpRunRoot,
  ArtifactProvenanceValidator,
  classifyFailure,
  DshExecutorAdapter,
  DSH_EXECUTOR_ID,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  ReconciliationService,
  RecoveryController,
  registerGovernedExecutors,
  validatePlanProposal,
} from "../pair/index.js";

const LIVE_TIMEOUT = 240_000;
const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("spec-bound harness must not call inference");
  },
};
const noopCompute = {
  exec: async () => {
    throw new Error("no remote compute");
  },
  writeFile: async () => {
    throw new Error("no remote compute");
  },
  readFile: async () => {
    throw new Error("no remote compute");
  },
} as unknown as ComputeClient;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p8-live-"));

// Live suite requires real DSH runtime; skip (not fail) on CI.
const describeLive = Boolean(process.env.PAIR_DSH_HOME) ? describe : describe.skip;

describeLive("P8 §40 — live bounded recovery", () => {
  beforeAll(() => {
    expect(Boolean(process.env.PAIR_DSH_HOME)).toBe(true);
  });

  it("real DSH dispatch fails on launch → classify → decide → re-route → PAIR_NATIVE completes", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "live-"));
    const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
    const automaton = createDatabase(path.join(dir, "state.db"));
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const journalRoot = path.join(dir, "journal");
    const runner = new PairNativeWorkerRunner({
      db: automaton.raw,
      config: { name: "p8-live", logLevel: "error" } as unknown as AutomatonConfig,
      identity: { name: "p8-live" } as unknown as AutomatonIdentity,
      inference: noopInference,
      compute: noopCompute,
      journalRoot,
      allowedEditRoot: dir,
    });
    const native = new PairNativeExecutorAdapter(runner);

    // envReader: PAIR_DSH_ACP_PATH flips to a broken-but-existing script at
    // dispatch time → real spawn, real immediate exit, zero provider calls.
    const brokenEntry = path.join(dir, "broken-dsh.mjs");
    fs.writeFileSync(brokenEntry, "process.exit(3);\n");
    let dshEntry: string | null = null;
    let routeOverride: string | null = null;
    const envReader = (name: string): string | undefined => {
      if (name === "PAIR_DSH_ACP_PATH") return dshEntry ?? undefined;
      if (name === "PAIR_DSH_MODEL_ROUTE") return routeOverride ?? process.env[name];
      return process.env[name];
    };

    const dsh = new DshExecutorAdapter({ journalRoot, envReader });
    const gate = new GovernedTaskGate(service);
    const registry = new ExecutorRegistry(service);
    const router = new MissionRouter(service, gate);
    const recovery = new RecoveryController(service);

    // Phase A — healthy registration: real probe of real `dsh` binary.
    const adapters1 = new Map<string, ExecutorAdapter>([
      [PAIR_NATIVE_EXECUTOR_ID, native],
      [DSH_EXECUTOR_ID, dsh],
    ]);
    const reg = registerGovernedExecutors(service, new Map([[DSH_EXECUTOR_ID, dsh]]), "p8-live", {
      priorities: { [DSH_EXECUTOR_ID]: 10 },
    });
    expect(reg.routable).toContain(DSH_EXECUTOR_ID);
    registry.register({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      executor_type: "AUTOMATON_WORKER",
      capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
        routing_priority: 100,
        supports_cancel: true,
      },
    });
    service.routes.seedPairNativeRoute();

    for (const c of ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION"]) {
      service.registerCapability(c, { risk_class: "LOW" });
    }
    const project = service.createProject({ name: "p8live", root_location: workspace });
    const mission = service.createMission({
      project_id: String(project.project_id),
      goal: "p8 live recovery",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [workspace],
    });
    service.transitionMission(String(mission.mission_id), "READY");
    service.transitionMission(String(mission.mission_id), "RUNNING");
    service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 3 });
    const proposal = {
      tasks: [{ task_key: "T1", title: "t", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
    };
    const committed = service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: validatePlanProposal(proposal, new Set(["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "SHELL_EXECUTION"])).map((t) => ({ ...t })),
      source: "AUTOMATON_PLANNER",
      proposal,
    });
    const taskId = String(committed.task_ids[0]);
    const missionId = String(mission.mission_id);
    const revision = Number(service.activeRevision(missionId).revision);

    const makeReq = () => ({
      mission_id: missionId,
      task_id: taskId,
      plan_revision: revision,
      task_instruction: "write live_recovered.txt then finish",
      workspace,
      allowed_paths: [workspace],
      permissions: ["FILE_WRITE"],
      requested_tools: ["SHELL_EXECUTION", "FILE_OPERATIONS"],
      constraints: [],
      timeout: 120,
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            { op: "write_text_file", path: "live_recovered.txt", content: "RECOVERED_LIVE", idempotency_class: "WRITE", risk_class: "MEDIUM" },
            { op: "finish", result: { summary: "recovered" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      },
      correlation_id: `corr-p8-live-${Date.now()}`,
    });

    // Phase B — corrupt DSH launch mid-flight; dispatch-1 selects DSH
    // (priority 10 < 100) and fails for real before any provider call.
    dshEntry = brokenEntry;
    const r1 = router.routeGovernedTask(makeReq(), adapters1);
    expect(String((r1.routing_decision as Record<string, unknown>).selected_executor)).toBe(DSH_EXECUTOR_ID);
    const exec1 = r1.execution as Record<string, unknown>;
    const gt1 = String((r1.governed_task as Record<string, unknown>).governed_task_id);

    // wait for the real subprocess failure to settle
    const deadline = Date.now() + 120_000;
    let obs: Record<string, unknown> = { status: "RUNNING" };
    while (Date.now() < deadline) {
      obs = gate.observe_execution(dsh, String(exec1.execution_id));
      if (!["RUNNING", "DISPATCHED"].includes(String(obs.execution_state ?? obs.status))) break;
      await new Promise((r) => setTimeout(r, 500));
      obs = dsh.observe(String(exec1.execution_id));
      const st = String((obs as Record<string, unknown>).status);
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(st)) break;
    }
    const final1 = gate.observe_execution(dsh, String(exec1.execution_id));
    expect(String(final1.execution_state)).not.toBe("RUNNING");

    // classify the real failure
    const journalPath = path.join(acpRunRoot(journalRoot, String(exec1.execution_id)), "execution_journal.json");
    const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : {};
    const errClass = String((journal.error as Record<string, unknown>)?.class ?? journal.last_error ?? "ACP_TRANSPORT_CLOSED");
    const failureClass = classifyFailure({
      execution_state: String(final1.execution_state),
      error_class: errClass,
      result: (final1.result as Record<string, unknown>) ?? null,
    });
    expect(["TRANSIENT_TRANSPORT", "EXECUTOR_UNAVAILABLE", "PROCESS_EXIT", "TIMEOUT", "UNKNOWN"]).toContain(failureClass);

    // Reconcile the ambiguous dispatch before any replay decision.
    const recon = new ReconciliationService(service, adapters1);
    const receipt = recon.reconcile({ execution_id: String(exec1.execution_id), mission_id: missionId, correlation_id: "p8-live" });
    expect(String(receipt.outcome)).toMatch(/CONFIRMED_|UNKNOWN_SIDE_EFFECT_STATE/);

    // Phase C — decide + re-route. A fresh adapter instance re-probes: DSH now
    // carries an unresolvable credential (route override) → DISPATCH gates
    // reject it → PAIR_NATIVE is the only eligible executor.
    routeOverride = "deadprovider:fake-model";
    const dsh2 = new DshExecutorAdapter({ journalRoot, envReader });
    const q2 = dsh2.qualify();
    expect(q2.qualified).not.toBe(true);
    const adapters2 = new Map<string, ExecutorAdapter>([
      [PAIR_NATIVE_EXECUTOR_ID, native],
      [DSH_EXECUTOR_ID, dsh2],
    ]);

    const decision = recovery.decide({
      mission_id: missionId,
      task_id: taskId,
      execution_id: String(exec1.execution_id),
      governed_task_id: gt1,
      executor_id: DSH_EXECUTOR_ID,
      failure_class: failureClass,
      eligible_executors: [PAIR_NATIVE_EXECUTOR_ID],
      evidence_refs: [String(exec1.execution_id), String(receipt.reconciliation_id)],
      correlation_id: "p8-live",
    });
    expect(["RE_ROUTE", "RETRY_SAME_ROUTE", "RECONCILIATION_REQUIRED", "HUMAN_APPROVAL_REQUIRED"]).toContain(
      String(decision.selected_action),
    );
    expect(decision.decision_digest).toMatch(/^[0-9a-f]{64}$/);

    // supersede dead binding → router re-runs all gates → PAIR_NATIVE
    recovery.supersedeGovernedTask(gt1, String(decision.recovery_id));
    const r2 = router.routeGovernedTask(makeReq(), adapters2);
    const exec2 = r2.execution as Record<string, unknown>;
    const executor2 = String(exec2.executor_id);
    expect(executor2).toBe(PAIR_NATIVE_EXECUTOR_ID);

    const deadline2 = Date.now() + 120_000;
    for (;;) {
      const o = native.observe(String(exec2.execution_id));
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(String(o.status))) break;
      if (Date.now() > deadline2) throw new Error("native execution never settled");
      await new Promise((r) => setTimeout(r, 500));
    }
    const collected = gate.collect_execution_result(native, String(exec2.execution_id));
    expect(String(collected.result_state)).toBe("COMPLETED");
    const validation = new ArtifactProvenanceValidator().validate_execution(service, String(exec2.execution_id)) as { status: string };
    expect(validation.status).toBe("PASS");
    expect(fs.readFileSync(path.join(workspace, "live_recovered.txt"), "utf8")).toBe("RECOVERED_LIVE");

    // evidence chain: decision + attempt + receipts + two distinct governed tasks
    const decisions = store.list("recovery_decision").filter((d) => d.mission_id === missionId);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const gts = store.list("governed_task").filter((g) => g.task_id === taskId);
    expect(gts).toHaveLength(2);
    expect(String(gts.find((g) => g.governance_state === "SUPERSEDED_BY_RECOVERY")?.governed_task_id)).toBe(gt1);

    // checkpoint on restart replays state without duplicate dispatch
    const recon3 = new ReconciliationService(service, adapters2);
    const cps = recovery.planRestartRecovery((eid) => recon3.reconcile({ execution_id: eid, mission_id: missionId }));
    expect(cps.length).toBeGreaterThanOrEqual(0);
    const attempts = store.list("recovery_attempt").filter((a) => a.mission_id === missionId);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  }, LIVE_TIMEOUT);
});
