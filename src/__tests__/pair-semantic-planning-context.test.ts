/**
 * Semantic & Context-Aware Planning V1 — PlanningContextEnvelope suite.
 *
 *   PC-1 — no objective scope → honest typed gaps (OBJECTIVE_SCOPE_ABSENT),
 *          deterministic context_digest, never fabricated sections.
 *   PC-2 — work_item scope contradiction fails closed
 *          FAIL_CLOSED_PLANNING_CONTEXT_SCOPE; unknown work_item fails
 *          closed too.
 *   PC-3 — objective-scoped envelope composes through the owner-gated
 *          brain seam: canonical_facts carries CANONICAL provenance,
 *          advisory carries PROJECTED, missing carries UNVERIFIED.
 *   PC-4 — context_digest stability: identical canonical state → identical
 *          digest across calls (asof/volatile excluded); objective state
 *          change → digest changes. Evidence-class only — never bound
 *          into plan authority.
 *   PC-5 — renderPlanningContextBlock emits the bounded advisory block
 *          with explicit delimiters + provenance header; no operator-goal
 *          text is duplicated inside it.
 *   PC-6 — unwired objectiveContext reader → typed *_NOT_WIRED gaps,
 *          not a fabricated empty section.
 *   PC-7 — replan request-time pin: ReplanGenerationService mints
 *          planning_context {context_digest, block} on the durable row
 *          when the dep is wired; absent dep → null (prior behavior).
 *   PC-8 — beginPlannerRun persists planning_context_digest/block as
 *          run-row evidence (never authority).
 *   PC-9 — the advisory block never reaches authority: the envelope
 *          carries digest references to the operator goal, not a second
 *          copy of the text.
 *
 * Harness mirrors pair-p16-a-brain-context.test.ts — real canonical
 * seams, real BrainContextService composition.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BrainContextService,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  PlanningContextService,
  renderPlanningContextBlock,
  ReplanGenerationService,
  beginPlannerRun,
} from "../pair/index.js";
import { IntegrityError } from "../pair/errors.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-semantic-ctx-"));
let counter = 0;
const OP = "semantic-owner";
const FUTURE = "2999-01-01T00:00:00.000Z";

type FullStack = {
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  brain: BrainContextService;
  planning: PlanningContextService;
  projectId: string;
};

function freshStack(name: string, withBrain = true): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
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
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner,
  });
  const biz = new BusinessLayer({ store, control,
    schedules: new MissionScheduleService(service),
    planExpander: async (input) => ({
      input: {
        ...input,
        metadata: {
          ...(input.metadata as Record<string, unknown> | undefined),
          llm_plan: [{ task_key: "T2", title: "delegated",
            task_instruction: "work", required_capabilities: ["FILE_OPERATIONS"],
            depends_on: [] }],
          plan_source: "LLM", plan_model: "test-planner",
        },
      },
      planner: { planner_run_id: "PLR_TEST", attempts: [], winner: { attempt_no: 1 } },
    }) });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(dir, "artifacts", "blobs") });
  const project = service.createProject({ name: "p", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
  });
  const planning = new PlanningContextService({
    store,
    objectiveContext: withBrain ? brain : undefined,
  });
  return { dir, store, biz, brain, planning, projectId: String(project.project_id) };
}

function mkBusiness(s: FullStack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: FullStack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "grow-channel",
    statement: "Grow the Telegram channel.",
    kpis: [{ kpi_id: "KPI_SUBS", name: "subs", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1000 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: OP,
  });
}

const GOAL = "Grow my Telegram channel by 1,000 genuine subscribers within 30 days.";

describe("Semantic Planning V1 — PlanningContextEnvelope", () => {
  it("PC-1 no objective scope → typed gaps, deterministic digest", () => {
    const s = freshStack("pc1");
    const env = s.planning.envelopeFor({
      project_id: s.projectId,
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    expect(env.schema_version).toBe("pair.planning-context.v1");
    expect(env.scope.objective_id).toBeNull();
    expect(env.unavailable).toContain(
      "OBJECTIVE_SCOPE_ABSENT:no objective bound to this planning request");
    expect(env.sections.operator_input.provenance).toBe("CANONICAL");
    const input = env.authoritative_input;
    expect(input.operator_goal_sha256).toMatch(/^[0-9a-f]{64}$/);
    // contractDigest uses the canonical 32-char truncation convention.
    expect(input.contract_digest).toMatch(/^[0-9a-f]{32}$/);
    // A goal with an explicit deliverable + prohibition yields typed
    // requirements; the growth-only goal legitimately extracts zero
    // (the known lexical gap C′/D′ must close — asserted separately).
    const rich = s.planning.envelopeFor({
      project_id: s.projectId,
      authorityGoal: "Produce file report.md. Do not use bots.",
      actor: "PAIR_PLANNER",
    });
    expect(rich.authoritative_input.requirement_count).toBeGreaterThan(0);
    // Deterministic digest across repeated reads.
    const env2 = s.planning.envelopeFor({
      project_id: s.projectId,
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    expect(env2.context_digest).toBe(env.context_digest);
  });

  it("PC-2 scope contradiction fails closed", () => {
    const s = freshStack("pc2");
    expect(() =>
      s.planning.envelopeFor({
        work_item_id: "WI_MISSING",
        authorityGoal: GOAL,
        actor: "PAIR_PLANNER",
      }),
    ).toThrowError(IntegrityError);
    try {
      s.planning.envelopeFor({
        work_item_id: "WI_MISSING",
        authorityGoal: GOAL,
        actor: "PAIR_PLANNER",
      });
    } catch (e) {
      expect((e as IntegrityError).code).toBe("FAIL_CLOSED_PLANNING_CONTEXT_SCOPE");
    }
  });

  it("PC-3 objective-scoped envelope: canonical/advisory provenance", () => {
    const s = freshStack("pc3");
    const businessId = mkBusiness(s);
    const obj = mkObjective(s, businessId);
    const env = s.planning.envelopeFor({
      objective_id: String(obj.objective_id),
      business_id: businessId,
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    const facts = env.sections.canonical_facts;
    expect(facts.provenance).toBe("CANONICAL");
    const fv = facts.value as Record<string, unknown>;
    expect(String(fv.objective_id)).toBe(String(obj.objective_id));
    expect(env.sections.advisory.provenance).toBe("PROJECTED");
    expect(env.sections.missing.provenance).toBe("UNVERIFIED");
    expect(env.context_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PC-4 digest stable on identical state; tracks canonical change", () => {
    const s = freshStack("pc4");
    const businessId = mkBusiness(s);
    const obj = mkObjective(s, businessId);
    const req = {
      objective_id: String(obj.objective_id),
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    };
    const a = s.planning.envelopeFor(req);
    const b = s.planning.envelopeFor(req);
    expect(b.context_digest).toBe(a.context_digest);
    // A canonical mutation (owner KPI progress) moves the digest —
    // same convention as the brain-context B1 proof.
    s.biz.objectives.recordProgress(String(obj.objective_id), {
      business_id: businessId,
      kpi_id: "KPI_SUBS", value: 0.5,
      evidence: { evidence_key: `ek-${counter++}`, verifier: `operator:${OP}`,
        source: "owner-console" },
      actor: `operator:${OP}`,
    });
    const c = s.planning.envelopeFor(req);
    expect(c.context_digest).not.toBe(a.context_digest);
  });

  it("PC-5 rendered block: advisory delimiters + bounds, no goal echo", () => {
    const s = freshStack("pc5");
    const businessId = mkBusiness(s);
    const obj = mkObjective(s, businessId);
    const env = s.planning.envelopeFor({
      objective_id: String(obj.objective_id),
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    const block = renderPlanningContextBlock(env);
    expect(block).toContain("PLANNING CONTEXT");
    expect(block).toContain("ADVISORY");
    expect(block).toContain("NOT authority");
    expect(block).toContain(env.context_digest);
    // The operator goal text is never duplicated inside the advisory
    // block — the envelope carries digest references only.
    expect(block).not.toContain("Grow my Telegram channel by 1,000");
    expect(block.length).toBeLessThanOrEqual(4096);
    // Unscoped envelope renders the honest empty form ("").
    const unscoped = s.planning.envelopeFor({
      project_id: s.projectId, authorityGoal: GOAL, actor: "PAIR_PLANNER",
    });
    expect(renderPlanningContextBlock(unscoped)).toBe("");
  });

  it("PC-6 unwired objectiveContext → typed NOT_WIRED gaps", () => {
    const s = freshStack("pc6", false);
    const businessId = mkBusiness(s);
    const obj = mkObjective(s, businessId);
    const env = s.planning.envelopeFor({
      objective_id: String(obj.objective_id),
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    expect(env.unavailable).toContain(
      "OBJECTIVE_CONTEXT_NOT_WIRED:objective-context reader absent");
    expect(env.sections.canonical_facts.value).toBeNull();
  });

  it("PC-7 replan request-time pin on durable row", () => {
    const s = freshStack("pc7");
    const gen = new ReplanGenerationService(s.store, {}, s.planning);
    const input = {
      mission: {
        mission_id: "MSN_PC7",
        plan_id: "PLN_1",
        goal: GOAL,
        project_id: s.projectId,
      },
      replan_context: {
        recovery_id: "RCV_PC7",
        failure_signature: null,
        failure_class: "EXECUTION_FAILED",
        failed_task_key: "T1",
        failed_plan_semantic_digest: "abc123",
        rejected_semantic_digests: [],
      },
    };
    try {
      gen.requestCandidate(input as never);
      expect.unreachable("requestCandidate should throw PENDING");
    } catch (e) {
      expect(String((e as IntegrityError).code ?? e)).toMatch(
        /REPLAN_GENERATION_PENDING/);
    }
    const rows = s.store.list("replan_generation") as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const pinned = rows[0].planning_context as
      | { context_digest: string; block: string }
      | null;
    expect(pinned).not.toBeNull();
    expect(pinned!.context_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof pinned!.block).toBe("string");
    // Without the dep the row pins null — identical prior behavior.
    const gen2 = new ReplanGenerationService(s.store);
    const input2 = {
      ...input,
      replan_context: { ...input.replan_context, recovery_id: "RCV_PC7B" },
    };
    try {
      gen2.requestCandidate(input2 as never);
      expect.unreachable();
    } catch (e) {
      expect(String((e as IntegrityError).code ?? e)).toMatch(
        /REPLAN_GENERATION_PENDING/);
    }
    const rows2 = (s.store.list("replan_generation") as Array<Record<string, unknown>>)
      .filter((r) => String(r.recovery_id) === "RCV_PC7B");
    expect(rows2[0].planning_context).toBeNull();
  });

  it("PC-8 planner_run evidence carries digest + bounded block", () => {
    const s = freshStack("pc8");
    const run = beginPlannerRun(s.store, {
      project_id: s.projectId,
      routes: ["codex-cli:test"],
      actor: "PAIR_PLANNER",
      planning_context_digest: "d".repeat(64),
      planning_context_block: "x".repeat(5000),
    });
    expect(String(run.planning_context_digest)).toBe("d".repeat(64));
    // Bounded — the row never carries an unbounded prompt fragment.
    expect(String(run.planning_context_block).length).toBe(4096);
  });

  it("PC-9 envelope carries digests, never a second authority copy", () => {
    const s = freshStack("pc9");
    const env = s.planning.envelopeFor({
      project_id: s.projectId,
      authorityGoal: GOAL,
      actor: "PAIR_PLANNER",
    });
    const raw = JSON.stringify(env);
    expect(raw).not.toContain(GOAL.slice(0, 40));
    expect(env.authoritative_input.operator_goal_sha256).toHaveLength(64);
  });
});
