/**
 * P18.6 — Semantic-First Goal Understanding: unit + governance probes.
 *
 * Proves: interpretation is never authority; deterministic
 * reconciliation classifies confirm/conflict/proposed; ambiguity
 * classes drive the GUARDED confirm gate; the owner-amendment path is
 * the ONLY governed promotion and binds exact evidence; modes gate
 * correctly; cache keys bind goal × context × scope × model; the
 * advisory prompt block is bounded and clearly non-authoritative.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import { PairEvidenceStore } from "../pair/store.js";
import { IntegrityError, PolicyError } from "../pair/errors.js";
import { digest } from "../pair/canonical.js";
import {
  GOAL_INTENT_SCHEMA,
  semanticMode,
  validateIntentItems,
  reconcileIntent,
  classifyAmbiguity,
  renderGoalIntentBlock,
  analyzeGoal,
  goalIntentDigest,
  approveGoalIntentItems,
  verifyGoalIntentApproval,
  assertGuardedIntentConfirmed,
  latestGoalIntentSnapshot,
  INTENT_BLOCK_MAX,
  type GoalIntentAnalysis,
  type IntentItem,
} from "../pair/semantic-goal-understanding.js";
import { beginPlannerRun, createPlanPreview as persistPlanPreview } from "../pair/plan-preview.js";

let tmpN = 0;
function freshStore(): PairEvidenceStore {
  return new PairEvidenceStore(
    path.join(mkTmpDir("pair-sgu-"), `s-${tmpN++}.db`),
  );
}

const SCOPE = {
  business_id: "B1",
  objective_id: "OBJ1",
  work_item_id: "WI1",
  project_id: "P1",
};

function item(p: Partial<IntentItem> & { statement: string }): IntentItem {
  return {
    id: "i1",
    category: "requirement",
    source_span: null,
    authority: "MODEL_INFERRED",
    confidence: "medium",
    ...p,
  };
}

function fakeAnalysis(items: IntentItem[], goal = "grow the telegram channel"): GoalIntentAnalysis {
  const rec = reconcileIntent(items, goal);
  return {
    schema_version: GOAL_INTENT_SCHEMA,
    analysis_digest: goalIntentDigest({ goal, context_digest: null, model: "m", scope: SCOPE }),
    operator_goal_sha256: digest({ operator_goal: goal }),
    context_digest: null,
    scope: SCOPE,
    items,
    reconciliation: rec,
    ambiguity: classifyAmbiguity(rec, items),
    provider: { model: "m", requests: 1, latency_ms: 5, unavailable: [] },
    created_at: new Date().toISOString(),
  };
}

describe("P18.6 — mode gating", () => {
  it("defaults OFF; unknown value fails closed", () => {
    expect(semanticMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(semanticMode({ PAIR_SEMANTIC_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(semanticMode({ PAIR_SEMANTIC_MODE: "guarded" } as NodeJS.ProcessEnv)).toBe("guarded");
    expect(() => semanticMode({ PAIR_SEMANTIC_MODE: "YOLO" } as NodeJS.ProcessEnv)).toThrow(
      IntegrityError,
    );
  });
});

describe("P18.6 — strict schema", () => {
  it("bounds items, clamps spans, defaults authority to MODEL_INFERRED", () => {
    const items = validateIntentItems(
      Array.from({ length: 30 }, (_, i) => ({
        category: "soft_preference",
        statement: `s${i}`,
        confidence: "high",
        authority: "OWNER_APPROVED", // model can never self-mint — ignored
      })),
    );
    expect(items).not.toBeNull();
    expect(items!.length).toBe(24);
    expect(items!.every((i) => i.authority === "MODEL_INFERRED")).toBe(true);
    expect(items![0].id).toBe("i1");
  });
  it("rejects malformed payloads — never coerced", () => {
    expect(validateIntentItems("nope")).toBeNull();
    expect(validateIntentItems([{ category: "BOGUS", statement: "x" }])).toBeNull();
    expect(validateIntentItems([{ category: "entity" }])).toBeNull(); // no statement
    expect(validateIntentItems(null)).toBeNull();
  });
});

describe("P18.6 — deterministic reconciliation", () => {
  it("confirms items supported by explicit contract rows", () => {
    const goal = "Write a setup guide with at least 3 sections";
    const items = [item({ statement: "Write a setup guide with at least 3 sections", category: "deliverable" })];
    const rec = reconcileIntent(items, goal);
    expect(rec.confirmed_ids).toContain("i1");
    expect(items[0].authority).toBe("EXPLICIT_OPERATOR");
  });
  it("detects negation-scope inversion as a typed conflict — contract wins", () => {
    const goal = "Không gửi tin nhắn cho khách hàng hiện tại"; // do NOT message current customers
    const items = [
      item({ id: "i1", category: "requirement", statement: "gửi tin nhắn cho khách hàng hiện tại" }),
    ];
    const rec = reconcileIntent(items, goal);
    expect(rec.conflicts.length).toBeGreaterThan(0);
  });
  it("authority-shaped requirement the contract lacks → PROPOSED_AMENDMENT", () => {
    const goal = "Grow the audience organically";
    const items = [
      item({ id: "i1", category: "requirement", statement: "send telegram broadcast to all users" }),
    ];
    const rec = reconcileIntent(items, goal);
    expect(rec.proposed_ids).toContain("i1");
    expect(items[0].authority).toBe("PROPOSED_AMENDMENT");
  });
  it("ambiguity/missing/conflict items → UNRESOLVED, never authority", () => {
    const items = [
      item({ id: "i1", category: "ambiguity", statement: "unspecified KPI target" }),
      item({ id: "i2", category: "missing_information", statement: "no deadline given", confidence: "high" }),
    ];
    const rec = reconcileIntent(items, "grow audience");
    expect(items.every((i) => i.authority === "UNRESOLVED")).toBe(true);
    expect(rec.confirmed_ids.length).toBe(0);
  });
});

describe("P18.6 — ambiguity classification", () => {
  it("conflicts → AUTHORITY_CRITICAL", () => {
    const goal = "Không gửi tin nhắn cho khách hàng hiện tại";
    const items = [
      item({ id: "i1", category: "requirement", statement: "gửi tin nhắn cho khách hàng hiện tại" }),
    ];
    const rec = reconcileIntent(items, goal);
    const amb = classifyAmbiguity(rec, items);
    expect(amb.class).toBe("AUTHORITY_CRITICAL");
  });
  it("material missing info → MATERIAL; clean → HARMLESS", () => {
    const items = [
      item({ id: "i1", category: "missing_information", statement: "no KPI", confidence: "high" }),
    ];
    const rec = reconcileIntent(items, "grow audience");
    expect(classifyAmbiguity(rec, items).class).toBe("MATERIAL");
    const clean = [item({ id: "i1", category: "primary_outcome", statement: "grow audience reach" })];
    const rec2 = reconcileIntent(clean, "grow audience reach organically");
    expect(classifyAmbiguity(rec2, clean).class).toBe("HARMLESS");
  });
});

describe("P18.6 — advisory render", () => {
  it("bounded ≤4096 with explicit non-authority header", () => {
    const a = fakeAnalysis(
      Array.from({ length: 24 }, (_, i) =>
        item({ id: `i${i + 1}`, statement: `x`.repeat(280), category: "soft_preference" }),
      ),
    );
    const block = renderGoalIntentBlock(a);
    expect(block.length).toBeLessThanOrEqual(INTENT_BLOCK_MAX);
    expect(block).toContain("ADVISORY");
    expect(block).toContain("NOT authority");
    expect(block).toContain(a.analysis_digest);
  });
});

describe("P18.6 — analyzeGoal + cache", () => {
  const goal = "Grow the audience organically";
  const model = "m1";
  const payload = {
    items: [
      { category: "primary_outcome", statement: "grow the audience organically", confidence: "high" },
      { category: "soft_preference", statement: "prefer free solutions", confidence: "medium" },
    ],
  };
  it("one provider request; second call same key is a cache hit", async () => {
    let calls = 0;
    const analyze = async () => {
      calls++;
      return { items: payload.items, latency_ms: 1 };
    };
    const a1 = await analyzeGoal({
      goal, context_digest: "ctx1", contextBlock: null, model, scope: SCOPE, analyze,
    });
    expect("analysis_digest" in a1).toBe(true);
    const a2 = await analyzeGoal({
      goal, context_digest: "ctx1", contextBlock: null, model, scope: SCOPE, analyze,
    });
    expect(calls).toBe(1);
    expect((a2 as GoalIntentAnalysis).analysis_digest).toBe(
      (a1 as GoalIntentAnalysis).analysis_digest,
    );
  });
  it("context drift / different scope / different goal → different key → new call", async () => {
    let calls = 0;
    const analyze = async () => {
      calls++;
      return { items: payload.items, latency_ms: 1 };
    };
    const g2 = `p18-6-cache-drift-${Math.random()}`;
    await analyzeGoal({ goal: g2, context_digest: "c1", contextBlock: null, model, scope: SCOPE, analyze });
    await analyzeGoal({ goal: g2, context_digest: "c2", contextBlock: null, model, scope: SCOPE, analyze });
    await analyzeGoal({
      goal: g2, context_digest: "c1", contextBlock: null, model,
      scope: { ...SCOPE, project_id: "P2" }, analyze,
    });
    await analyzeGoal({ goal: `${g2} again`, context_digest: "c1", contextBlock: null, model, scope: SCOPE, analyze });
    expect(calls).toBe(4); // every identity drift re-analyzes — no stale replay
  });
  it("provider failure → typed unavailable, never fabricated", async () => {
    const out = await analyzeGoal({
      goal: `unavail-${Math.random()}`,
      context_digest: null, contextBlock: null, model, scope: SCOPE,
      analyze: async () => ({ unavailable: "codex:timeout" }),
    });
    expect("unavailable" in out).toBe(true);
    const bad = await analyzeGoal({
      goal: `bad-${Math.random()}`,
      context_digest: null, contextBlock: null, model, scope: SCOPE,
      analyze: async () => ({ items: "garbage", latency_ms: 1 }),
    });
    expect("unavailable" in bad).toBe(true);
  });
});

describe("P18.6 — owner amendment (C3)", () => {
  const SEED_GOAL = 'grow the audience organically';
function seedPreviewWithIntent(analysis: GoalIntentAnalysis) {
    const store = freshStore();
    const run = beginPlannerRun(store, {
      routes: ["codex-cli:m"], actor: "t",
      goal_intent: {
        analysis_digest: analysis.analysis_digest,
        block: "b",
        ambiguity_class: analysis.ambiguity.class,
        status: "analyzed",
        unavailable_reason: null,
        model: "m", provider_id: "codex-cli", provider_requests: 1,
        analysis_ms: 1, from_cache: false,
        source_goal_sha: analysis.operator_goal_sha256,
        context_digest: null, mode: "guarded",
        analysis: analysis as unknown as Record<string, unknown>,
      },
    });
    const goal = SEED_GOAL;
    const row = persistPlanPreview(store, {
      missionInput: {
        project_id: "P1", goal, operator_goal: goal, metadata: {},
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
        operator_id: null,
      },
      effective_input_digest: "eid",
      plan_digest: "pd",
      canonical_tasks: [],
      attempts: [], winner: null,
      planner_run_id: String(run.planner_run_id),
      ttlSeconds: 300,
    });
    return { store, preview: row };
  }

  it("mints a bound approval + amended goal (original preserved verbatim)", () => {
    const analysis = fakeAnalysis([
      item({ id: "i1", category: "soft_preference", statement: "prefer free tools only", authority: "MODEL_INFERRED" }),
      item({ id: "i2", category: "requirement", statement: "send telegram broadcast", authority: "PROPOSED_AMENDMENT" }),
    ], SEED_GOAL);
    const { store, preview } = seedPreviewWithIntent(analysis);
    const approval = approveGoalIntentItems(store, {
      preview_id: String(preview.preview_id),
      base_goal: SEED_GOAL,
      item_ids: ["i2"],
      operator_id: "op1",
    });
    expect(approval.item_statements).toEqual(["send telegram broadcast"]);
    expect(approval.amended_goal).toContain("grow the audience organically");
    expect(approval.amended_goal).toContain("Operator-approved: send telegram broadcast");
    expect(approval.revision_digest.length).toBeGreaterThan(0);
  });
  it("idempotent: same preview+items+analysis → same approval, no duplicate", () => {
    const analysis = fakeAnalysis([
      item({ id: "i1", category: "requirement", statement: "send telegram broadcast", authority: "PROPOSED_AMENDMENT" }),
    ], SEED_GOAL);
    const { store, preview } = seedPreviewWithIntent(analysis);
    const a1 = approveGoalIntentItems(store, {
      preview_id: String(preview.preview_id), base_goal: SEED_GOAL,
      item_ids: ["i1"], operator_id: "op1",
    });
    const a2 = approveGoalIntentItems(store, {
      preview_id: String(preview.preview_id), base_goal: SEED_GOAL,
      item_ids: ["i1"], operator_id: "op1",
    });
    expect(a2.approval_id).toBe(a1.approval_id);
    expect(store.list("goal_intent_approval").length).toBe(1);
  });
  it("rejects: unknown item, EXPLICIT_OPERATOR item, wrong base goal", () => {
    const analysis = fakeAnalysis([
      // matches the contract obligation → reconcileIntent marks
      // EXPLICIT_OPERATOR → not an advisory interpretation →
      // approval must refuse (only advisory items are amendable).
      item({ id: "i1", category: "deliverable", statement: "grow the audience organically" }),
    ], SEED_GOAL);
    const { store, preview } = seedPreviewWithIntent(analysis);
    expect(() =>
      approveGoalIntentItems(store, {
        preview_id: String(preview.preview_id), base_goal: SEED_GOAL,
        item_ids: ["i99"], operator_id: "op1",
      }),
    ).toThrow(IntegrityError);
    expect(() =>
      approveGoalIntentItems(store, {
        preview_id: String(preview.preview_id), base_goal: SEED_GOAL,
        item_ids: ["i1"], operator_id: "op1",
      }),
    ).toThrow(PolicyError);
    expect(() =>
      approveGoalIntentItems(store, {
        preview_id: String(preview.preview_id), base_goal: "a totally different goal",
        item_ids: ["i1"], operator_id: "op1",
      }),
    ).toThrow(IntegrityError);
  });

  it("confirm re-proof: forged/absent approval evidence fails closed", () => {
    const analysis = fakeAnalysis([
      item({ id: "i1", category: "requirement", statement: "send telegram broadcast", authority: "PROPOSED_AMENDMENT" }),
    ], SEED_GOAL);
    const { store, preview } = seedPreviewWithIntent(analysis);
    const approval = approveGoalIntentItems(store, {
      preview_id: String(preview.preview_id), base_goal: SEED_GOAL,
      item_ids: ["i1"], operator_id: "op1",
    });
    // valid ref + matching persisted goal + bound scope/operator → verified
    const ok = verifyGoalIntentApproval(store, {
      mission_input: {
        operator_goal: approval.amended_goal,
        project_id: "P1", operator_id: "op1",
        metadata: { goal_intent_approval: { approval_id: approval.approval_id, revision_digest: approval.revision_digest } },
      },
    });
    expect(ok.approval_id).toBe(approval.approval_id);
    // scope mismatch — approval minted under P1 never replays under P2
    expect(() =>
      verifyGoalIntentApproval(store, {
        mission_input: {
          operator_goal: approval.amended_goal,
          project_id: "P2", operator_id: "op1",
          metadata: { goal_intent_approval: { approval_id: approval.approval_id, revision_digest: approval.revision_digest } },
        },
      }),
    ).toThrow(IntegrityError);
    // operator mismatch — approval binds op1, never satisfies op2
    expect(() =>
      verifyGoalIntentApproval(store, {
        mission_input: {
          operator_goal: approval.amended_goal,
          project_id: "P1", operator_id: "op2",
          metadata: { goal_intent_approval: { approval_id: approval.approval_id, revision_digest: approval.revision_digest } },
        },
      }),
    ).toThrow(IntegrityError);
    // forged approval id
    expect(() =>
      verifyGoalIntentApproval(store, {
        mission_input: {
          operator_goal: approval.amended_goal,
          metadata: { goal_intent_approval: { approval_id: "GIA_forged", revision_digest: approval.revision_digest } },
        },
      }),
    ).toThrow(IntegrityError);
    // goal text swapped → sha mismatch → replay impossible
    expect(() =>
      verifyGoalIntentApproval(store, {
        mission_input: {
          operator_goal: "some other goal",
          metadata: { goal_intent_approval: { approval_id: approval.approval_id, revision_digest: approval.revision_digest } },
        },
      }),
    ).toThrow(IntegrityError);
    // stale revision digest
    expect(() =>
      verifyGoalIntentApproval(store, {
        mission_input: {
          operator_goal: approval.amended_goal,
          metadata: { goal_intent_approval: { approval_id: approval.approval_id, revision_digest: "stale" } },
        },
      }),
    ).toThrow(IntegrityError);
  });
});

describe("P18.6 — GUARDED confirm gate", () => {
  const gi = (over: Record<string, unknown>) => ({
    mode: "guarded", status: "analyzed", ambiguity_class: "HARMLESS", ...over,
  });
  it("guarded MATERIAL/AUTHORITY_CRITICAL → fail closed; approved digest → pass", () => {
    expect(() => assertGuardedIntentConfirmed(gi({ ambiguity_class: "MATERIAL" }), false)).toThrow(
      IntegrityError,
    );
    expect(() => assertGuardedIntentConfirmed(gi({ ambiguity_class: "AUTHORITY_CRITICAL" }), false)).toThrow(
      IntegrityError,
    );
    // A verified owner amendment IS the review act MATERIAL requires.
    expect(() => assertGuardedIntentConfirmed(gi({ ambiguity_class: "MATERIAL" }), true)).not.toThrow();
    // AUTHORITY_CRITICAL = a live contradiction — item approval is not
    // a remedy; only a revised goal clears it (always fail closed).
    expect(() => assertGuardedIntentConfirmed(gi({ ambiguity_class: "AUTHORITY_CRITICAL" }), true)).toThrow(
      IntegrityError,
    );
    expect(() => assertGuardedIntentConfirmed(gi({}), false)).not.toThrow();
  });
  it("guarded unavailable → fail closed; shadow/off evidence never gates", () => {
    expect(() =>
      assertGuardedIntentConfirmed(gi({ status: "unavailable" }), false),
    ).toThrow(IntegrityError);
    expect(() =>
      assertGuardedIntentConfirmed(gi({ mode: "shadow", ambiguity_class: "AUTHORITY_CRITICAL" }), false),
    ).not.toThrow();
    expect(() => assertGuardedIntentConfirmed(null, false)).not.toThrow();
  });
});

describe("P18.6 — replan snapshot pinning", () => {
  it("latestGoalIntentSnapshot resolves the newest analyzed run for the goal", () => {
    const store = freshStore();
    const goal = "unique replan snapshot goal";
    const sha = digest({ operator_goal: goal });
    beginPlannerRun(store, {
      routes: [], actor: "t",
      goal_intent: {
        analysis_digest: "a1", block: "b1", ambiguity_class: "HARMLESS",
        status: "analyzed", unavailable_reason: null, model: "m",
        provider_id: "codex-cli", provider_requests: 1, analysis_ms: 1,
        from_cache: false, source_goal_sha: sha, context_digest: null,
        mode: "guarded",
      },
    });
    const snap = latestGoalIntentSnapshot(store, goal);
    expect(snap).not.toBeNull();
    expect(String(snap!.analysis_digest)).toBe("a1");
    expect(latestGoalIntentSnapshot(store, "different goal")).toBeNull();
  });
});

/* ==================================================================
 * Confirm-gate integration — the REAL MissionControl.confirmPlanPreview
 * seam: a preview pinned under GUARDED interpretation evidence with
 * MATERIAL/AUTHORITY_CRITICAL ambiguity can never confirm; a verified
 * owner amendment produces a new authorized revision whose preview
 * passes the same canonical gates.
 * ================================================================== */
import {
  MissionControl,
  MissionRuntime,
  MissionSupervisor,
  MissionScheduler,
  MissionRouter,
  MissionObservability,
  GovernedTaskGate,
  ApprovalQueue,
  ReconciliationService,
  RecoveryController,
  PairControlPlane,
} from "../pair/index.js";

const TASKS = [
  {
    task_key: "t1",
    title: "t1",
    task_instruction: "research the topic",
    required_capabilities: ["REASONING"],
    depends_on: [],
  },
  {
    task_key: "t2",
    title: "t2",
    task_instruction: "summarize findings",
    required_capabilities: ["REASONING"],
    depends_on: ["t1"],
  },
];

function makeControlCtx() {
  const store = freshStore();
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({ tasks: TASKS.map((t) => ({ ...t })) });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon,
    observability: new MissionObservability(service),
    planner,
  });
  service.registerCapability("REASONING", { risk_class: "LOW" });
  const project = service.createProject({
    name: `sgu-${tmpN}`,
    root_location: mkTmpDir("sgu-ws-"),
  });
  return { store, control, project };
}

function intentRunRow(
  store: PairEvidenceStore,
  goal: string,
  over: Record<string, unknown> = {},
): string {
  const run = beginPlannerRun(store, {
    routes: ["codex-cli:m"], actor: "t",
    goal_intent: {
      analysis_digest: "ad-1", block: "b", ambiguity_class: "MATERIAL",
      status: "analyzed", unavailable_reason: null, model: "m",
      provider_id: "codex-cli", provider_requests: 1, analysis_ms: 1,
      from_cache: false, source_goal_sha: digest({ operator_goal: goal }),
      context_digest: null, mode: "guarded", analysis: null,
      ...(over as object),
    },
  });
  return String(run.planner_run_id);
}

describe("P18.6 — confirm-gate integration (real MissionControl seam)", () => {
  const GOAL = "grow the audience organically within two weeks";

  it("GUARDED MATERIAL ambiguity → confirm fails closed; preview unconsumed", () => {
    const { store, control, project } = makeControlCtx();
    const runId = intentRunRow(store, GOAL);
    const pv = control.createPlanPreview(
      {
        project_id: project.project_id, goal: GOAL,
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      },
      { planner_run_id: runId, attempts: [], winner: null, warnings: [] },
    );
    expect(() =>
      control.confirmPlanPreview({
        preview_id: String(pv.preview_id),
        plan_digest: String(pv.plan_digest),
      }),
    ).toThrow(/FAIL_CLOSED_GOAL_INTENT_AMBIGUITY/);
    const row = store.tryGet("mission_plan_preview", String(pv.preview_id)) as
      | Record<string, unknown>
      | null;
    expect(String(row?.state)).toBe("READY"); // never consumed
  });

  it("GUARDED HARMLESS interpretation → confirm proceeds normally", () => {
    const { store, control, project } = makeControlCtx();
    const runId = intentRunRow(store, GOAL, { ambiguity_class: "HARMLESS" });
    const pv = control.createPlanPreview(
      {
        project_id: project.project_id, goal: GOAL,
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      },
      { planner_run_id: runId, attempts: [], winner: null, warnings: [] },
    );
    const mission = control.confirmPlanPreview({
      preview_id: String(pv.preview_id),
      plan_digest: String(pv.plan_digest),
    });
    expect(String(mission.mission_id)).toMatch(/^MSN_/);
  });

  it("SHADOW-pinned MATERIAL evidence never gates (evidence-only contract)", () => {
    const { store, control, project } = makeControlCtx();
    const runId = intentRunRow(store, GOAL, { mode: "shadow" });
    const pv = control.createPlanPreview(
      {
        project_id: project.project_id, goal: GOAL,
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      },
      { planner_run_id: runId, attempts: [], winner: null, warnings: [] },
    );
    const mission = control.confirmPlanPreview({
      preview_id: String(pv.preview_id),
      plan_digest: String(pv.plan_digest),
    });
    expect(String(mission.mission_id)).toMatch(/^MSN_/);
  });

  it("forged goal_intent_approval metadata → confirm fails closed", () => {
    const { store, control, project } = makeControlCtx();
    const runId = intentRunRow(store, GOAL, { ambiguity_class: "HARMLESS" });
    const pv = control.createPlanPreview(
      {
        project_id: project.project_id, goal: GOAL,
        metadata: {
          goal_intent_approval: { approval_id: "GIA_forged", revision_digest: "x" },
        },
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      },
      { planner_run_id: runId, attempts: [], winner: null, warnings: [] },
    );
    expect(() =>
      control.confirmPlanPreview({
        preview_id: String(pv.preview_id),
        plan_digest: String(pv.plan_digest),
      }),
    ).toThrow(/FAIL_CLOSED_GOAL_INTENT_APPROVAL/);
  });

  it("approve → amended preview → confirm: the governed remediation path is LIVE", () => {
    const { store, control, project } = makeControlCtx();
    // run-1: GUARDED-pinned MATERIAL analysis carrying an approvable item.
    const analysis = fakeAnalysis(
      [item({ id: "i1", category: "missing_information", statement: "no KPI specified", confidence: "high" })],
      GOAL,
    );
    // The approval's scope binds the analysis scope — the amended
    // preview's project must match it at confirm-time re-proof.
    analysis.scope = { ...SCOPE, project_id: String(project.project_id) };
    const run1 = intentRunRow(store, GOAL, {
      analysis_digest: analysis.analysis_digest,
      ambiguity_class: analysis.ambiguity.class,
      analysis: analysis as unknown as Record<string, unknown>,
    });
    const pv1 = control.createPlanPreview(
      {
        project_id: project.project_id, goal: GOAL, operator_id: "op1",
        granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
      },
      { planner_run_id: run1, attempts: [], winner: null, warnings: [] },
    );
    expect(() =>
      control.confirmPlanPreview({ preview_id: String(pv1.preview_id), plan_digest: String(pv1.plan_digest) }),
    ).toThrow(/FAIL_CLOSED_GOAL_INTENT_AMBIGUITY/);
    // Owner approves the ambiguous item → governed amendment minted.
    const approval = approveGoalIntentItems(store, {
      preview_id: String(pv1.preview_id), base_goal: GOAL,
      item_ids: ["i1"], operator_id: "op1",
    });
    // The amended revision re-plans: run-2 analyzed the AMENDED goal —
    // its analysis_digest legitimately differs from the approval's. The
    // audit's dead-code repro: digest-equality gating made the designed
    // remediation path unreachable; a verified approval IS the review
    // act MATERIAL ambiguity requires.
    const run2 = intentRunRow(store, approval.amended_goal, {
      analysis_digest: "ad-amended-2",
      ambiguity_class: "MATERIAL",
      analysis: null,
    });
    const amendedInput = {
      project_id: project.project_id, goal: GOAL,
      operator_goal: approval.amended_goal,
      operator_id: "op1",
      metadata: {
        goal_intent_approval: {
          approval_id: approval.approval_id,
          revision_digest: approval.revision_digest,
          analysis_digest: approval.analysis_digest,
        },
      },
      granted_permissions: [], authorized_workspaces: [], risk_ceiling: "LOW",
    };
    const pv2 = control.createPlanPreview(amendedInput, {
      planner_run_id: run2, attempts: [], winner: null, warnings: [],
    });
    const mission = control.confirmPlanPreview({
      preview_id: String(pv2.preview_id),
      plan_digest: String(pv2.plan_digest),
    });
    expect(String(mission.mission_id)).toMatch(/^MSN_/);
    // Negative — a live contradiction on the amended revision still
    // fails closed even with a verified approval (item approval cannot
    // resolve a contradiction; the remedy is a revised goal).
    const run3 = intentRunRow(store, approval.amended_goal, {
      analysis_digest: "ad-amended-3",
      ambiguity_class: "AUTHORITY_CRITICAL",
      analysis: null,
    });
    const pv3 = control.createPlanPreview({ ...amendedInput }, {
      planner_run_id: run3, attempts: [], winner: null, warnings: [],
    });
    expect(() =>
      control.confirmPlanPreview({ preview_id: String(pv3.preview_id), plan_digest: String(pv3.plan_digest) }),
    ).toThrow(/FAIL_CLOSED_GOAL_INTENT_AMBIGUITY/);
  });
});

describe("P18.6 — replan snapshot scope binding + pin clamps", () => {
  it("snapshot never replays a different project's interpretation", () => {
    const store = freshStore();
    const goal = "cross-project identical goal text";
    const sha = digest({ operator_goal: goal });
    const analysisP1 = fakeAnalysis(
      [item({ id: "i1", category: "primary_outcome", statement: "cross-project identical goal text" })],
      goal,
    );
    beginPlannerRun(store, {
      routes: [], actor: "t",
      goal_intent: {
        analysis_digest: "p1-digest", block: "b", ambiguity_class: "HARMLESS",
        status: "analyzed", unavailable_reason: null, model: "m",
        provider_id: "codex-cli", provider_requests: 1, analysis_ms: 1,
        from_cache: false, source_goal_sha: sha, context_digest: "ctx-p1",
        mode: "guarded", analysis: analysisP1 as unknown as Record<string, unknown>,
      },
    });
    // P1 scope resolves it; P2 scope refuses the P1-scoped snapshot.
    expect(latestGoalIntentSnapshot(store, goal, { project_id: "P1" })?.analysis_digest).toBe("p1-digest");
    expect(latestGoalIntentSnapshot(store, goal, { project_id: "P2" })).toBeNull();
  });

  it("pinPlannerRunGoalIntent clamps evidence + folds provider_requests", async () => {
    const { pinPlannerRunGoalIntent } = await import("../pair/plan-preview.js");
    const store = freshStore();
    const run = beginPlannerRun(store, { routes: [], actor: "t" });
    pinPlannerRunGoalIntent(store, {
      planner_run_id: String(run.planner_run_id),
      goal_intent: {
        analysis_digest: "ad-x",
        block: "x".repeat(9000),
        ambiguity_class: "HARMLESS",
        status: "analyzed",
        unavailable_reason: "r".repeat(500),
        model: "m".repeat(300),
        provider_id: "codex-cli",
        provider_requests: 1.9,
        analysis_ms: 3.7,
        from_cache: false,
        source_goal_sha: "s",
        context_digest: null,
        mode: "guarded",
        analysis: null,
      },
    });
    const row = store.tryGet("planner_run", String(run.planner_run_id)) as Record<string, unknown>;
    const gi = row.goal_intent as Record<string, unknown>;
    expect(String(gi.block).length).toBe(4096);
    expect(String(gi.model).length).toBe(120);
    expect(gi.provider_requests).toBe(1);
    expect(row.provider_requests).toBe(1); // folded into canonical count
  });
});

/* ==================================================================
 * Transport parity + authority-digest isolation.
 * ================================================================== */
import {
  buildPlannerUserPrompt,
} from "../pair/llm-planner.js";
import { SERVE_LLM_PLANNER_CAPS } from "../pair/serve-planner.js";
import { buildCodexPlannerPrompt } from "../pair/codex-planner.js";
import { effectiveInputDigest, planDigest } from "../pair/plan-preview.js";

describe("P18.6 — prompt seam parity", () => {
  const GOAL = "grow the audience organically";
  const BLOCK = "\nSEMANTIC GOAL INTERPRETATION (ADVISORY — NOT authority):\n- soft_preference: prefer free tools [MODEL_INFERRED, high]\n";
  it("both transports render the SAME advisory block before MISSION GOAL", () => {
    const http = buildPlannerUserPrompt(GOAL, {
      allowedCapabilities: SERVE_LLM_PLANNER_CAPS,
      maxTasks: 4,
      semanticIntentBlock: BLOCK,
    });
    const codex = buildCodexPlannerPrompt(GOAL, {
      allowedCapabilities: SERVE_LLM_PLANNER_CAPS,
      maxTasks: 4,
      semanticIntentBlock: BLOCK,
    });
    expect(http.indexOf(BLOCK)).toBeLessThan(http.indexOf("MISSION GOAL"));
    expect(http).toContain("prefer free tools");
    expect(codex).toContain("prefer free tools");
    expect(codex.indexOf(BLOCK)).toBeLessThan(codex.indexOf("MISSION GOAL"));
  });
  it("absent block → prompt byte-identical to the unparametrized call", () => {
    const a = buildPlannerUserPrompt(GOAL, {
      allowedCapabilities: SERVE_LLM_PLANNER_CAPS,
      maxTasks: 4,
    });
    const b = buildPlannerUserPrompt(GOAL, {
      allowedCapabilities: SERVE_LLM_PLANNER_CAPS,
      maxTasks: 4,
      semanticIntentBlock: undefined,
    });
    expect(a).toBe(b);
  });
});

describe("P18.6 — authority digests exclude interpretation evidence", () => {
  it("effective_input_digest / plan_digest are structurally goal-bound only", () => {
    const base = {
      project_id: "P1",
      goal: "grow the audience organically",
      operator_goal: "grow the audience organically",
      granted_permissions: [],
      authorized_workspaces: [] as string[],
      risk_ceiling: "LOW",
    };
    const d1 = effectiveInputDigest(base);
    const d2 = effectiveInputDigest(base);
    expect(d1).toBe(d2);
    // The digest function's contract: interpretation evidence is never
    // a parameter — a pinned block cannot alter the authority binding.
    const pd = planDigest({
      ...base,
      effective_input_digest: d1,
      tasks: TASKS.map((t) => ({ ...t })),
    });
    expect(typeof pd).toBe("string");
    expect(pd.length).toBeGreaterThan(10);
  });
});
