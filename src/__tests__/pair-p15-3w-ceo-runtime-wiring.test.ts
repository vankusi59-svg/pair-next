/**
 * P15.3W — CEO runtime wiring tests (public composition seam).
 *
 * prove: canonical codex-cli:gpt-6.1-sol resolution through the real
 * catalog/qualification gates; the public seam needs no caller-side
 * model_entry_id; INITIALIZE flows through P15.2 into the P14 graph;
 * zero mission/executor/telegram scope creep; replay converges; and
 * every mis-configured model state fails closed at wiring time.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assignModelRole,
  BusinessLayer,
  canonicalModelId,
  ceoCycleId,
  CeoPlanningCycleService,
  CEO_CODEX_DEFAULT_MODEL,
  CODEX_CLI_PROVIDER_ID,
  createDefaultCeoPlanningCycle,
  digest,
  ensureCodexCliCatalog,
  listModelRoleAssignments,
  ModelEvidenceCatalog,
  MODEL_ROLE,
  modelRoleOf,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  runDefaultCeoCycle,
  WorkforceService,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p153w-"));
let counter = 0;
const OP = "1882810918";

/* ------------------------- fixtures ------------------------- */

function freshStack(name: string) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService({
    store, business: biz, workforce: wf, objectives: biz.objectives });
  return { dbPath, store, biz, wf, objectives: biz.objectives, workstreams };
}

/** Canonical qualification for the codex-cli provider — the same
 *  ProviderCatalog receipt seam the boot path uses. */
function qualifyCodexProvider(store: PairEvidenceStore) {
  const id = providerEntryId(CODEX_CLI_PROVIDER_ID);
  const existing = store.tryGet("provider", id) as Record<string, unknown> | null;
  store.put("provider", id, {
    ...(existing ?? { provider_id: CODEX_CLI_PROVIDER_ID, entry_id: id }),
    lifecycle_state: "QUALIFIED",
    auth_state: "AUTH_OK",
    health_state: "READY",
    conditions: [],
    probe_state: "PROBED",
    provider_type: "LOCAL_CLI",
    protocol_family: "CODEX_CLI",
    endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [],
    credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(
    CODEX_CLI_PROVIDER_ID, { policy_version: "test-policy", actor: "test" });
}

/** Seed the DEFAULT CEO model through the canonical bootstrap seam
 *  (ensureCodexCliCatalog) + qualify it through the canonical model
 *  evidence seams (probe receipt + qualifyModel). No fake authority. */
function seedDefaultCeoModel(store: PairEvidenceStore): string {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  qualifyCodexProvider(store);
  const mcat = new ModelEvidenceCatalog(store);
  mcat.recordProbeReceipt({
    probe_id: `PRB_ceo_default_${counter}`,
    model_entry_id: meId,
    provider_id: CODEX_CLI_PROVIDER_ID,
    result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" },
    latency_ms: 1,
  });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`default model qualification failed: ${JSON.stringify(q.gates)}`);
  return meId;
}

class FakeInvoker implements CeoDecisionInvoker {
  inputs: CeoInvokeInput[] = [];
  private queue: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult)>;
  constructor(...raw: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult)>) {
    this.queue = raw;
  }
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.inputs.push(input);
    const item = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    return typeof item === "function" ? item(input) : {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: item,
    };
  }
}

/** Real-shaped CEO_DECISION output (variant-inapplicable fields null). */
const decisionJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: "pair.ceo-decision.v1",
    decision_kind: "WAIT",
    workstreams: null,
    priority_order: null,
    wait_reason: "AWAITING_PROGRESS",
    summary: null,
    ...over,
  });

const initProposalJson = (keys: string[]) =>
  decisionJson({
    decision_kind: "INITIALIZE_WORKSTREAMS",
    wait_reason: null,
    workstreams: keys.map((k, i) => ({
      workstream_key: k, title: `T-${k}`, goal: `G-${k}`,
      depends_on_keys: i > 0 ? [keys[i - 1]!] : null,
    })),
    priority_order: keys,
    summary: "initialize workstreams",
  });

function mkBusiness(store: PairEvidenceStore) {
  const id = `BIZ_${digest(String(counter)).slice(0, 8)}_${counter}`;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

/** The mandate's real Objective (§F) — EA orders on MQL5. */
function mkEaObjective(objectives: BusinessLayer["objectives"], businessId: string) {
  return objectives.create({
    business_id: businessId,
    title: "Tăng tổng số đơn EA trên MQL5 lên 10 đơn trước 31/10",
    statement: "Tăng tổng số đơn EA trên MQL5 lên 10 đơn. Hiện có 2 đơn.",
    kpis: [{ name: "ea_orders", unit: "orders", baseline: 2, target: 10 }],
    deadline: "2999-10-31T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["Chỉ bán qua MQL5"],
    success_conditions: ["Tổng đơn EA trên MQL5 đạt 10"],
    dedup_key: `dk-${counter}`,
    operator_id: OP,
  });
}

async function expectFail(fn: () => unknown | Promise<unknown>, code: string | RegExp) {
  try {
    await fn();
  } catch (e) {
    const c = String((e as { code?: string }).code ?? "");
    if (code instanceof RegExp) expect(c).toMatch(code);
    else expect(c).toBe(code);
    return;
  }
  throw new Error(`expected ${String(code)} — call succeeded`);
}

/* ============================ F — live-style integration ============================ */

describe("P15.3W F — public runtime wiring seam", () => {
  it("resolves canonical codex-cli:gpt-6.1-sol, runs INITIALIZE through P15.2 → P14, replays", async () => {
    const s = freshStack("f1");
    const me = seedDefaultCeoModel(s.store);
    // Transport-boundary fake ONLY — resolution/wiring is production-real.
    const inv = new FakeInvoker(initProposalJson(["ea-listing", "ea-funnel", "ea-ops"]), decisionJson());
    // THE PUBLIC SEAM — caller passes NO model_entry_id.
    const rt = createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: inv,
    });
    // 1. canonical resolution proof
    expect(rt.model_entry_id).toBe(me);
    expect(rt.model_entry_id).toBe(
      canonicalModelId(CODEX_CLI_PROVIDER_ID, CEO_CODEX_DEFAULT_MODEL));
    expect(rt.transport.provider_id).toBe("codex-cli");
    expect(rt.transport.protocol_family).toBe("CODEX_CLI");
    expect(rt.transport.model_id).toBe(CEO_CODEX_DEFAULT_MODEL);

    const bid = mkBusiness(s.store);
    const o = mkEaObjective(s.objectives, bid);
    const oid = String(o.objective_id);

    // 2. CEO cycle runs through the public wiring seam
    const r = await rt.service.runCycle({ objective_id: oid, actor: OP });
    expect(r.replayed).toBe(false);
    expect(String(r.decision.decision_kind)).toBe("INITIALIZE_WORKSTREAMS");
    // the invoker was handed the resolved canonical transport
    expect(inv.inputs).toHaveLength(1);
    expect(String(inv.inputs[0]!.transport.model_entry_id)).toBe(me);
    expect(String(inv.inputs[0]!.transport.model_id)).toBe(CEO_CODEX_DEFAULT_MODEL);

    // 3+4. INITIALIZE materialized through P15.2 → canonical P14 graph
    const binding = s.workstreams.getBinding(oid)!;
    expect(binding).toBeTruthy();
    const ws = binding.workstreams as Array<Record<string, unknown>>;
    expect(ws.map((w) => String(w.workstream_key)).sort())
      .toEqual(["ea-funnel", "ea-listing", "ea-ops"]);
    const root = s.store.get("work_item", String(binding.root_work_item_id)) as Record<string, unknown>;
    expect(String(root.objective_id)).toBe(oid);
    for (const w of ws) {
      const child = s.store.get("work_item", String(w.work_item_id)) as Record<string, unknown>;
      expect(String(child.status)).toBe("BACKLOG");
      expect(child.assignee_agent_id ?? null).toBeNull();
      expect(String(child.objective_id)).toBe(oid);
    }

    // 5+6+7. zero Mission / executor assignment / Telegram / planner rows
    for (const ent of [
      "mission", "work_open_binding", "executor_execution",
      "planner_attempt", "planner_run", "telegram_delivery", "mission_artifact",
      "model_role_assignment",
    ]) {
      expect(s.store.list(ent), ent).toHaveLength(0);
    }

    // 8+9. P15.3 replay semantics: the post-INITIALIZE observation is a
    // NEW observation (binding now exists) → a new bounded cycle; the
    // model WAITs; a THIRD call on the unchanged observation replays
    // with ZERO additional model calls and no second graph.
    const r2 = await rt.service.runCycle({ objective_id: oid, actor: OP });
    expect(r2.replayed).toBe(false);
    expect(String(r2.decision.decision_kind)).toBe("WAIT");
    expect(inv.inputs).toHaveLength(2);
    const r3 = await rt.service.runCycle({ objective_id: oid, actor: OP });
    expect(r3.replayed).toBe(true);
    expect(String(r3.decision.decision_id)).toBe(String(r2.decision.decision_id));
    expect(s.store.list("objective_workstream_binding")).toHaveLength(1);
    expect(inv.inputs).toHaveLength(2); // ZERO calls for the replay
    s.store.close();
  });

  it("runDefaultCeoCycle one-shot convenience goes through the same seam", async () => {
    const s = freshStack("f2");
    const me = seedDefaultCeoModel(s.store);
    const inv = new FakeInvoker(decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkEaObjective(s.objectives, bid);
    const r = await runDefaultCeoCycle({
      store: s.store, business: s.biz, workforce: s.wf,
      invoker: inv, objective_id: String(o.objective_id), actor: OP,
    });
    expect(r.model_entry_id).toBe(me);
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(inv.inputs).toHaveLength(1);
    s.store.close();
  });
});

/* ============================ G — regression / non-vacuous ============================ */

describe("P15.3W G — wiring fail-closed proofs", () => {
  it("consumes the default model constant even when other codex-cli models exist", () => {
    const s = freshStack("g1");
    const me = seedDefaultCeoModel(s.store);
    // a second, unrelated codex-cli model in the same catalog
    const other = ensureCodexCliCatalog(s.store, "gpt-5.2-other", "t");
    const mcat = new ModelEvidenceCatalog(s.store);
    mcat.recordProbeReceipt({
      probe_id: `PRB_other_${counter}`, model_entry_id: other,
      provider_id: CODEX_CLI_PROVIDER_ID, result: "PASS",
      probe_type: "text_inference", capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
    });
    qualifyModel(s.store, other, { capability_scope: ["text_inference"], actor: "t" });
    const inv = new FakeInvoker(decisionJson());
    const rt = createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: inv });
    expect(rt.model_entry_id).toBe(me);
    expect(rt.model_entry_id).not.toBe(other);
    s.store.close();
  });

  it("missing default model → fail closed", () => {
    const s = freshStack("g2");
    expect(() => createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: new FakeInvoker(decisionJson()),
    })).toThrowError(/FAIL_CLOSED_CEO_MODEL_UNRESOLVED/);
    s.store.close();
  });

  it("ambiguous duplicate canonical model identity → fail closed", () => {
    const s = freshStack("g3");
    seedDefaultCeoModel(s.store);
    // a foreign row claiming the same (provider_id, model_id) identity
    s.store.put("model_entry", "ME_FORGED_DUP", {
      model_entry_id: "ME_FORGED_DUP",
      provider_id: CODEX_CLI_PROVIDER_ID,
      provider_family: CODEX_CLI_PROVIDER_ID,
      model_id: CEO_CODEX_DEFAULT_MODEL,
      lifecycle_state: "QUALIFIED",
      conditions: [],
    } as never, 0);
    expect(() => createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: new FakeInvoker(decisionJson()),
    })).toThrowError(/FAIL_CLOSED_CEO_MODEL_AMBIGUOUS/);
    s.store.close();
  });

  it("wrong provider protocol/endpoint facets → fail closed (non-codex transport)", () => {
    const s = freshStack("g4");
    seedDefaultCeoModel(s.store);
    const id = providerEntryId(CODEX_CLI_PROVIDER_ID);
    const p = s.store.get("provider", id) as Record<string, unknown>;
    s.store.put("provider", id, {
      ...p, protocol_family: "HTTPS_JSON", endpoint_reference: "https://evil.test",
    }, Number(p.version));
    expect(() => createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: new FakeInvoker(decisionJson()),
    })).toThrowError(/FAIL_CLOSED_CEO_NON_CODEX_TRANSPORT/);
    s.store.close();
  });

  it("unqualified default model → fail closed", () => {
    const s = freshStack("g5");
    // cataloged but NOT qualified (no probe receipt, no qualifyModel, no
    // provider qualification) — wiring must refuse it.
    ensureCodexCliCatalog(s.store, CEO_CODEX_DEFAULT_MODEL, "t");
    expect(() => createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: new FakeInvoker(decisionJson()),
    })).toThrowError(/FAIL_CLOSED_CEO_(PROVIDER_INELIGIBLE|MODEL_UNAVAILABLE|MODEL_UNRESOLVED)/);
    s.store.close();
  });

  it("DSH_EXECUTION-assigned default model → P15.3 overlap gate still rejects", () => {
    const s = freshStack("g6");
    const me = seedDefaultCeoModel(s.store);
    assignModelRole(s.store, me, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    expect(() => createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: new FakeInvoker(decisionJson()),
    })).toThrowError(/FAIL_CLOSED_CEO_DSH_OVERLAP/);
    s.store.close();
  });

  it("wiring mints ZERO model_role_assignment and never touches planner authority", () => {
    const s = freshStack("g7");
    seedDefaultCeoModel(s.store);
    const before = listModelRoleAssignments(s.store).length;
    const inv = new FakeInvoker(decisionJson());
    createDefaultCeoPlanningCycle({
      store: s.store, business: s.biz, workforce: s.wf, invoker: inv });
    expect(listModelRoleAssignments(s.store).length).toBe(before);
    expect(s.store.list("planner_run")).toHaveLength(0);
    expect(s.store.list("planner_attempt")).toHaveLength(0);
    s.store.close();
  });

  it("direct CeoPlanningCycleService construction with explicit model_entry_id still works", async () => {
    const s = freshStack("g8");
    const me = seedDefaultCeoModel(s.store);
    const ws = new ObjectiveWorkstreamService({
      store: s.store, business: s.biz, workforce: s.wf, objectives: s.objectives });
    const inv = new FakeInvoker(decisionJson());
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.objectives, workstreams: ws,
      proveWorkItemDone: (r) => s.biz.proveWorkItemDone(r as never),
      invoker: inv, model_entry_id: me,
    });
    const bid = mkBusiness(s.store);
    const o = mkEaObjective(s.objectives, bid);
    const r = await svc.runCycle({ objective_id: String(o.objective_id), actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    s.store.close();
  });

  it("wiring is composition-only: zero new entity types / missions / executors after a cycle", async () => {
    const s = freshStack("g9");
    seedDefaultCeoModel(s.store);
    const inv = new FakeInvoker(decisionJson());
    const bid = mkBusiness(s.store);
    const o = mkEaObjective(s.objectives, bid);
    const r = await runDefaultCeoCycle({
      store: s.store, business: s.biz, workforce: s.wf,
      invoker: inv, objective_id: String(o.objective_id), actor: OP,
    });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(s.store.list("mission")).toHaveLength(0);
    expect(s.store.list("executor_execution")).toHaveLength(0);
    // cycle ids derive from objective+observation only
    expect(String(r.decision.cycle_id)).toBe(
      ceoCycleId(String(o.objective_id), String(r.decision.observation_digest)));
    s.store.close();
  });
});
