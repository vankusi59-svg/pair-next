/**
 * P7 LIVE EXPERIENCE test (spec §29): real governed execution → real Layer-B
 * evidence → candidate extraction → deterministic verification → ACTIVE →
 * subsequent governed routing/planning consumes the advice.
 *
 * Uses PAIR_NATIVE (always-real local worker) — no fixtures, no mocks for the
 * evidence path. No manufactured preference: we assert advice was consumed
 * (receipt lists applied experiences), not a forced route flip.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ArtifactProvenanceValidator,
  ExperienceExtractor,
  ExperienceService,
  ExperienceVerifier,
  GovernedTaskGate,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PAIR_NATIVE_EXECUTOR_ID,
  validatePlanProposal,
  VerifiedExperiencePlannerAdvisor,
  VerifiedExperienceRoutingAdvisor,
} from "../pair/index.js";

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

const ROOT = mkTmpDir("pair-p7-live-");
const LIVE_ENV = { os: process.platform, arch: process.arch, node: process.version.split(".")[0] };

function makeCtx(name: string) {
  const dir = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const automaton = createDatabase(path.join(dir, "state.db"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const journalRoot = path.join(dir, "journal");
  const runner = new PairNativeWorkerRunner({
    db: automaton.raw,
    config: { name: "p7-live", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p7-live" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot,
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const gate = new GovernedTaskGate(service);
  const experience = new ExperienceService(service);
  const extractor = new ExperienceExtractor(service, experience);
  const verifier = new ExperienceVerifier(service, experience);
  const routingAdvisor = new VerifiedExperienceRoutingAdvisor(service, experience);
  const plannerAdvisor = new VerifiedExperiencePlannerAdvisor(service, experience);
  const router = new MissionRouter(service, gate, routingAdvisor, LIVE_ENV);
  service.registerExecutor({
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
    },
  });
  service.routes.seedPairNativeRoute();
  return {
    dir, workspace, store, service, gate, adapter, router,
    experience, extractor, verifier, routingAdvisor, plannerAdvisor,
  };
}

const capsRegistered = new Set<string>();
function seedMission(ctx: ReturnType<typeof makeCtx>, instruction: string) {
  const project = ctx.service.createProject({ name: "p7", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p7 live experience",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  ctx.service.transitionMission(String(mission.mission_id), "RUNNING");
  for (const c of ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"]) {
    if (!capsRegistered.has(c)) {
      ctx.service.registerCapability(c, { risk_class: "LOW" });
      capsRegistered.add(c);
    }
  }
  const proposal = {
    tasks: [{
      task_key: "T1",
      title: "live task",
      task_instruction: instruction,
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
      metadata: { risk_class: "LOW" },
    }],
  };
  const tasks = validatePlanProposal(proposal, new Set(["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"]));
  const committed = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks,
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const active = ctx.service.activeRevision(String(mission.mission_id));
  return {
    missionId: String(mission.mission_id),
    taskId: String(committed.task_ids[0]),
    revision: Number(active.revision),
  };
}

function requestFor(ctx: ReturnType<typeof makeCtx>, m: { missionId: string; taskId: string; revision: number }, outName: string) {
  return {
    mission_id: m.missionId,
    task_id: m.taskId,
    plan_revision: m.revision,
    task_instruction: `write ${outName}`,
    workspace: ctx.workspace,
    allowed_paths: [ctx.workspace],
    permissions: ["FILE_WRITE"],
    requested_tools: ["SHELL_EXECUTION", "FILE_OPERATIONS"],
    constraints: [],
    timeout: 300,
    correlation_id: `corr-p7-${Date.now()}`,
    dependency_outputs: [],
    expected_output_contract: {
      type: "TASK_RESULT",
      worker_spec: {
        ops: [
          { op: "write_text_file", path: outName, content: "P7_LIVE", idempotency_class: "WRITE", risk_class: "MEDIUM" },
          { op: "finish", result: { summary: `created ${outName}` }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
        ],
        limits: { max_ops: 4, timeout_seconds: 30 },
        allowed_ops: ["write_text_file", "finish"],
      },
    },
  };
}

async function waitTerminal(adapter: ExecutorAdapter, executionId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) return o;
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never terminal (last=${o.status})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("P7 live experience — real evidence → ACTIVE → advisory consumption", () => {
  it("L1. real PAIR_NATIVE governed execution produces Layer-B evidence", async () => {
    const ctx = makeCtx("l1");
    const m = seedMission(ctx, "write out1");
    const adapters = new Map<string, ExecutorAdapter>([[PAIR_NATIVE_EXECUTOR_ID, ctx.adapter]]);
    const route = ctx.router.routeGovernedTask(requestFor(ctx, m, "out1.txt"), adapters);
    const execution = route.execution as Record<string, unknown>;
    const obs = await waitTerminal(ctx.adapter, String(execution.execution_id));
    expect(String(obs.status)).toBe("COMPLETED");
    ctx.gate.collect_execution_result(ctx.adapter, String(execution.execution_id));
    const v = new ArtifactProvenanceValidator().validate_execution(ctx.service, String(execution.execution_id));
    expect(v.status).toBe("PASS");
    expect(fs.readFileSync(path.join(ctx.workspace, "out1.txt"), "utf8")).toContain("P7_LIVE");

    // L2. real evidence → candidates (EXECUTOR_OBSERVATION + ROUTING_PRIOR)
    const extracted = ctx.extractor.fromExecution(String(execution.execution_id), {
      origin: "REAL_EXECUTION",
      environment: LIVE_ENV,
    });
    expect(extracted.length).toBeGreaterThanOrEqual(2);
    expect(extracted.every((e) => e.status === "CANDIDATE")).toBe(true);
    const execObs = extracted.find((e) => e.type === "EXECUTOR_OBSERVATION")!;
    const prior = extracted.find((e) => e.type === "ROUTING_PRIOR");

    // L3. deterministic verification → QUALIFIED → ACTIVE (real evidence refs)
    const q = ctx.verifier.verifyAndQualify(String(execObs.experience_id), "P7_LIVE_VERIFIER");
    expect(String(q.status)).toBe("QUALIFIED");
    const act = ctx.verifier.verifyAndActivate(String(execObs.experience_id), "P7_LIVE_VERIFIER");
    expect(String(act.status)).toBe("ACTIVE");
    expect(String(act.verifier_id)).toBe("P7_LIVE_VERIFIER");
    // ROUTING_PRIOR with min_support 2 and one observation stays below ACTIVE.
    if (prior) {
      const res = ctx.verifier.verify(String(prior.experience_id), { verifier_id: "P7_LIVE_VERIFIER", target: "ACTIVE" });
      expect(res.pass).toBe(false);
      expect(res.checks.find((c) => c.check === "MIN_SUPPORT")!.pass).toBe(false);
    }

    // L4. subsequent governed routing consumes the ACTIVE experience in advice
    const m2 = seedMission(ctx, "write out2");
    const route2 = ctx.router.routeGovernedTask(requestFor(ctx, m2, "out2.txt"), adapters);
    const rd = route2.routing_decision as Record<string, unknown>;
    expect(String(rd.selected_executor)).toBe(PAIR_NATIVE_EXECUTOR_ID);
    expect(rd.advisor_decision_id).toBeTruthy();
    const receipt = ctx.store.get("advisor_decision", String(rd.advisor_decision_id));
    expect((receipt.experience_ids_applied as string[])).toContain(String(execObs.experience_id));
    expect(receipt.score_version).toBeTruthy();

    // planner advice also consumes it
    const planAdvice = ctx.plannerAdvisor.advise({ goal: "p7 live experience", environment: LIVE_ENV });
    expect((planAdvice.experience_ids_applied as string[])).toContain(String(execObs.experience_id));

    // second real execution completes; no secret values persisted
    const exec2 = route2.execution as Record<string, unknown>;
    await waitTerminal(ctx.adapter, String(exec2.execution_id));
    const blob = JSON.stringify(ctx.store.list("experience")) + JSON.stringify(ctx.store.list("advisor_decision"));
    expect(blob).not.toMatch(/sk-[a-zA-Z0-9]{8,}|gsk_[a-zA-Z0-9]{8,}/);
    expect(blob).not.toContain(String(process.env.GROQ_API_KEY ?? "__never__"));
  }, 240_000);
});
