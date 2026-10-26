#!/usr/bin/env node
/**
 * Semantic & Context-Aware Planning V1 — I′ REAL-MODEL E2E.
 *
 * Bounded real-planner verification: 5 live codex-cli planner
 * invocations through the REAL transport (codexPlannerPlan), the REAL
 * canonicalize seam (makeServeCanonicalizer), and the REAL coverage
 * authority (assertPlanCoverage). The advisory envelope is assembled by
 * the REAL PlanningContextService over a REAL BrainContextService stack.
 *
 * Evidence discipline: every case records a typed outcome — never a
 * fabricated PASS. Qualification failure → the whole run records
 * BLOCKED_REAL_MODEL with the probe's typed outcome.
 *
 * Output:
 *   docs/e2e-semantic-v1/REAL_PLANNER_E2E_REPORT.json
 *   docs/e2e-semantic-v1/REAL_PLANNER_E2E_REPORT.md
 */
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
  codexPlannerPlan,
  codexPlannerProbe,
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
  assertPlanCoverage,
  extractGoalContract,
  validatePlanProposal,
} from "../../dist/pair/index.js";

const REPO = "D:/PAIR_NEXT_2410";
const OUT_DIR = path.join(REPO, "docs", "e2e-semantic-v1");
const MODEL = "gpt-6.1-sol";
const TIMEOUT_MS = 120_000;
const OP = "e2e-owner";

const CASES = [
  {
    id: "E2E-1",
    name: "EN outcome goal (Telegram growth, quantity+deadline)",
    goal: "Grow my Telegram channel by 1,000 genuine subscribers within 30 days",
  },
  {
    id: "E2E-2",
    name: "VI equivalent outcome goal",
    goal: "Tăng thêm 1.000 người đăng ký thật cho kênh Telegram của tôi trong vòng 30 ngày",
  },
  {
    id: "E2E-3",
    name: "Conventional research+deliverable goal (regression anchor)",
    goal: "Research the top 3 MQL5 EA frameworks and write report.md",
  },
  {
    id: "E2E-4",
    name: "Bilingual mixed goal (EN verb + VI deadline)",
    goal: "Attract 200 real leads trong vòng 2 tuần",
  },
  {
    id: "E2E-5",
    name: "Prohibition-bearing goal (without bots)",
    goal: "Grow Telegram subscribers without bots or unsolicited messages",
  },
];

/* ---- real canonical stack: business + objective + brain context ---- */

function buildStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-e2e-sem-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: [] });
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
    planExpander: async (input) => ({ input }),
  });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(dir, "artifacts", "blobs") });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const project = service.createProject({ name: "e2e", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
  });
  const planning = new PlanningContextService({ store, objectiveContext: brain });
  const business = biz.createBusiness({
    name: "e2e-biz", project_id: String(project.project_id), operator_id: OP });
  const objective = biz.objectives.create({
    business_id: String(business.business_id),
    title: "channel-growth",
    statement: "Grow the Telegram channel with genuine subscribers.",
    kpis: [{ kpi_id: "KPI_SUBS", name: "subscribers", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1000 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000,
    dedup_key: "e2e-dk", operator_id: OP,
  });
  return { store, planning, objectiveId: String(objective.objective_id),
    businessId: String(business.business_id) };
}

/* ---- one real planner invocation through the governed path ---- */

async function invoke(stack, cse, scratchSub, rejectionContext, providerCounter) {
  const res = await codexPlannerPlan(cse.goal, {
    model: MODEL,
    authorityGoal: cse.goal,
    timeoutMs: TIMEOUT_MS,
    scratchDir: path.join(scratchSub),
    env: process.env,
    allowedCapabilities: SERVE_LLM_PLANNER_CAPS.slice(),
    capabilitySets: [SERVE_LLM_PLANNER_CAPS.slice()],
    planningContextBlock: cse.block,
    rejectionContext: rejectionContext ?? undefined,
    providerCounter,
  });
  return res;
}

function judge(stack, cse, res) {
  const canon = makeServeCanonicalizer({
    executorCapSets: () => [SERVE_LLM_PLANNER_CAPS.slice()],
  });
  let coverageReport = null;
  const outcome = { canonical_tasks: null, verdict: null, code: null, note: null };
  if (!res.tasks.length) {
    outcome.verdict = "NO_TASKS";
    outcome.note = `warnings: ${res.warnings.join("|") || "none"}`;
    return { outcome, coverageReport };
  }
  try {
    const tasks = canon(res.tasks, cse.goal, {
      provenance: "fresh",
      authorityGoal: cse.goal,
      raw_delivery_emission_count: res.raw_delivery_emission_count,
      raw_delivery_emission_state: res.raw_delivery_emission_state,
      coverageSink: (r) => { coverageReport = r; },
    });
    validatePlanProposal({ tasks }, new Set(SERVE_LLM_PLANNER_CAPS));
    outcome.verdict = "CANONICAL_PASS";
    outcome.canonical_tasks = tasks.map((t) => String(t.task_key));
  } catch (e) {
    outcome.verdict = "FAIL_CLOSED";
    outcome.code = e.code ?? String(e).slice(0, 120);
    outcome.note = String(e.message ?? e).slice(0, 240);
  }
  return { outcome, coverageReport };
}

async function runCase(stack, cse, scratchBase) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const providerCounter = { requests: 0 };
  const rounds = [];

  // Advisory envelope per goal — real PlanningContextService over the
  // real BrainContext stack (goal-bound digest reference, scope-sealed).
  const envelope = stack.planning.envelopeFor({
    objective_id: stack.objectiveId,
    business_id: stack.businessId,
    authorityGoal: cse.goal,
    actor: "PAIR_PLANNER",
  });
  const block = renderPlanningContextBlock(envelope);
  cse.block = block;

  // Round 1 — INITIAL invocation.
  let res = await invoke(stack, cse, path.join(scratchBase, `${cse.id}-r1`), null, providerCounter);
  let judged = judge(stack, cse, res);
  rounds.push({
    round: "INITIAL",
    warnings: res.warnings,
    raw_task_keys: res.tasks.map((t) => String(t.task_key ?? "")),
    ...judged.outcome,
    coverage_report: judged.coverageReport,
  });

  // Round 2 — bounded governed retry (P18.2 shape): exactly one re-ask
  // carrying the typed rejection back to the SAME transport. Runs only
  // when round 1 produced a plan the authority rejected.
  if (judged.outcome.verdict === "FAIL_CLOSED" && judged.outcome.code) {
    const rejectionContext = {
      validation_code: String(judged.outcome.code),
      task_warnings: [],
      detail: String(judged.outcome.code),
    };
    res = await invoke(stack, cse, path.join(scratchBase, `${cse.id}-r2`), rejectionContext, providerCounter);
    judged = judge(stack, cse, res);
    rounds.push({
      round: "REASK",
      rejection_context: rejectionContext,
      warnings: res.warnings,
      raw_task_keys: res.tasks.map((t) => String(t.task_key ?? "")),
      ...judged.outcome,
      coverage_report: judged.coverageReport,
    });
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    case_id: cse.id,
    name: cse.name,
    goal: cse.goal,
    started_at: startedAt,
    latency_ms: Date.now() - t0,
    provider_requests: providerCounter.requests,
    contract: {
      obligations: extractGoalContract(cse.goal).obligations.map((o) => o.id),
      deliverables: extractGoalContract(cse.goal).deliverables.map((d) => d.id),
      prohibitions: extractGoalContract(cse.goal).prohibitions.map((p) => p.id),
      deadline: extractGoalContract(cse.goal).deadline?.id ?? null,
    },
    envelope_context_digest: envelope.context_digest,
    envelope_block_bytes: block.length,
    rounds,
    verdict: finalRound.verdict,
    code: finalRound.code ?? null,
  };
}

/* ---- main ---- */

const report = {
  report: "SEMANTIC_CONTEXT_PLANNING_V1_REAL_E2E",
  generated_at: new Date().toISOString(),
  model: MODEL,
  qualification: null,
  cases: [],
  verdict: null,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "pair-e2e-codex-"));

// Gate — real qualification probe first. No fabricated results.
const probe = await codexPlannerProbe({
  model: MODEL, timeoutMs: 60_000, scratchDir: path.join(scratchBase, "probe"),
  env: process.env,
});
report.qualification = probe;
if (probe.outcome !== "AUTH_OK") {
  report.verdict = "BLOCKED_REAL_MODEL";
  report.blocked_reason = `qualification probe outcome=${probe.outcome} detail=${probe.detail}`;
  fs.writeFileSync(path.join(OUT_DIR, "REAL_PLANNER_E2E_REPORT.json"), JSON.stringify(report, null, 2));
  console.log(`BLOCKED_REAL_MODEL — ${report.blocked_reason}`);
  process.exit(2);
}

const stack = buildStack();
for (const cse of CASES) {
  process.stdout.write(`[${cse.id}] ${cse.name}… `);
  try {
    const r = await runCase(stack, cse, scratchBase);
    report.cases.push(r);
    const rs = r.rounds.map((x) => `${x.round}:${x.verdict}`).join(" → ");
    console.log(`${r.verdict} [${rs}] (${r.latency_ms}ms, ${r.provider_requests} req)`);
  } catch (e) {
    report.cases.push({
      case_id: cse.id, name: cse.name, goal: cse.goal,
      rounds: [], verdict: "HARNESS_ERROR", code: String(e).slice(0, 240),
    });
    console.log(`HARNESS_ERROR ${String(e).slice(0, 120)}`);
  }
}
const pass = report.cases.filter((c) => c.verdict === "CANONICAL_PASS").length;
const failClosed = report.cases.filter((c) => c.verdict === "FAIL_CLOSED").length;
report.verdict = failClosed === 0 && pass === CASES.length ? "ALL_CANONICAL_PASS"
  : `${pass}_PASS_${failClosed}_FAIL_CLOSED_${CASES.length - pass - failClosed}_OTHER`;

fs.writeFileSync(
  path.join(OUT_DIR, "REAL_PLANNER_E2E_REPORT.json"),
  JSON.stringify(report, null, 2),
);
const md = [
  "# Semantic & Context-Aware Planning V1 — Real Planner E2E",
  "",
  `Model: ${MODEL} · qualification: ${probe.outcome} (${probe.latency_ms}ms)`,
  `Verdict: **${report.verdict}**`,
  "",
  "| Case | Goal | Rounds | Final | Latency | Requests |",
  "|---|---|---|---|---|---|",
  ...report.cases.map((c) =>
    `| ${c.case_id} | ${String(c.goal).slice(0, 60)} | ${(c.rounds ?? []).map((x) => `${x.round}:${x.verdict}${x.code ? ` (${x.code})` : ""}`).join(" → ") || "—"} | ${c.verdict}${c.code ? ` (${c.code})` : ""} | ${c.latency_ms ?? "—"}ms | ${c.provider_requests ?? "—"} |`),
].join("\n");
fs.writeFileSync(path.join(OUT_DIR, "REAL_PLANNER_E2E_REPORT.md"), md + "\n");
console.log(`\nVERDICT: ${report.verdict}`);
console.log(`Report: ${path.join(OUT_DIR, "REAL_PLANNER_E2E_REPORT.md")}`);
