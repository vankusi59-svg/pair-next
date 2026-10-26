/**
 * P15.7 — OPERATOR TRIGGER — HTTP boundary + error-mapping matrix.
 *
 * Convention: the ceo-cycle route composes the REAL P15.6 operating
 * service over a REAL MissionControl stack — FakeInvoker is only ever
 * the CEO transport boundary (same seam as the P15.3W wiring); HTTP
 * callers can never inject hooks/invoker/model. Budget assertions pin
 * exact integer microusd end-to-end.
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ApprovalQueue,
  BusinessLayer,
  CEO_CODEX_DEFAULT_MODEL,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
  CODEX_CLI_PROVIDER_ID,
  createMissionControlServer,
  ensureCodexCliCatalog,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
} from "../pair/index.js";
import {
  budgetView,
  listState,
  showObjectiveDetail,
  usdToMicrousd,
} from "../../apps/mission-control-ui/src/lib/objective-display.js";

const ROOT = mkTmpDir("pair-p157-");
let counter = 0;
const OP = "1882810918";
const TOK = "mc-test-token";
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

interface FullStack {
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  service: PairControlPlane;
  control: MissionControl;
  runtime: MissionRuntime;
  projectId: string;
}

/** Real governed stack — same construction as the live server. */
function freshFullStack(name: string): FullStack {
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
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  const schedules = new MissionScheduleService(service);
  // Phase C — every delegated open plans through the shared async
  // Planner Pool seam; tests stub it with a canonical llm_plan.
  const biz = new BusinessLayer({
    store, control, schedules,
    planExpander: async (input) => ({
      input: {
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          llm_plan: [{ task_id: "T1", title: "t", instructions: "t", required_capabilities: [] }],
          plan_source: "LLM",
        },
      },
    }),
  });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const project = service.createProject({ name: "p", root_location: workspace });
  return { dir, store, biz, wf, workstreams, service, control, runtime,
    projectId: String(project.project_id) };
}

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

function seedDefaultCeoModel(store: PairEvidenceStore): void {
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  qualifyCodexProvider(store);
  const mcat = new ModelEvidenceCatalog(store);
  mcat.recordProbeReceipt({
    probe_id: `PRB_ceo_${counter++}`,
    model_entry_id: meId,
    provider_id: CODEX_CLI_PROVIDER_ID,
    result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" },
    latency_ms: 1,
  });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`model qualification failed: ${JSON.stringify(q.gates)}`);
}

class FakeInvoker implements CeoDecisionInvoker {
  inputs: CeoInvokeInput[] = [];
  private queue: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>;
  constructor(...raw: Array<string | ((i: CeoInvokeInput) => CeoInvokeResult | Promise<CeoInvokeResult>)>) {
    this.queue = raw;
  }
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.inputs.push(input);
    const item = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    const out = typeof item === "function" ? await item(input) : {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: item,
    };
    return out;
  }
}

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

const OWNER = `operator:${OP}`;

const INIT_JSON = (keys: string[] = ["w1", "w2"]) =>
  decisionJson({
    decision_kind: "INITIALIZE_WORKSTREAMS",
    wait_reason: null,
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}`, depends_on_keys: [],
    })),
    priority_order: keys,
    summary: "initialize workstreams",
  });

/* ---------------- HTTP harness ---------------- */

async function serve(
  s: FullStack,
  opts: { invoker?: CeoDecisionInvoker; auth?: boolean; store?: boolean } = {},
) {
  const server = createMissionControlServer({
    control: s.control,
    business: s.biz,
    workforce: s.wf,
    store: opts.store === false ? undefined : s.store,
    authToken: opts.auth === false ? undefined : TOK,
    ceoInvoker: opts.invoker,
  });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const hdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-operator-id": OP,
  authorization: `Bearer ${TOK}`,
  ...extra,
});

const get = (port: number, p: string, h?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: h ?? hdr() });
const post = (port: number, p: string, body: Record<string, unknown>, h?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: h ?? hdr(), body: JSON.stringify(body),
  });

function mkBusiness(s: FullStack): string {
  const b = s.biz.createBusiness({ name: `b${counter}`, project_id: s.projectId, operator_id: OP });
  return String(b.business_id);
}

const OBJ_BODY = (bid: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  business_id: bid,
  title: "Grow EA orders on MQL5",
  statement: "Increase verified EA order count",
  kpis: [{ name: "ea_orders", unit: "orders", direction: "AT_LEAST", baseline: 2, target: 10 }],
  deadline: "2999-01-01T00:00:00.000Z",
  budget_ceiling_microusd: 500_250_000, // exact $500.25 — integer microusd only
  hard_constraints: ["Chỉ bán qua MQL5"],
  success_conditions: ["10 orders"],
  dedup_key: `dk-${counter}`,
  ...over,
});

const missions = (s: FullStack) =>
  s.store.list("mission").map((m) => String(m.mission_id));

/* ============================ TESTS ============================ */

describe("P15.7 §A — canonical objective API", () => {
  it("A1. create → list → detail round-trip via HTTP", async () => {
    const s = freshFullStack("a1");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const created = await post(port, "/api/vnext/objectives", OBJ_BODY(bid)).then((r) => r.json());
    expect(String(created.objective_id)).toMatch(/^OBJ_/);
    expect(created.status).toBe("ACTIVE");
    expect(Number(created.budget.ceiling_microusd)).toBe(500_250_000);
    expect((created.kpis as Array<Record<string, unknown>>)[0].name).toBe("ea_orders");

    const list = await get(port, `/api/vnext/objectives?business_id=${bid}`).then((r) => r.json());
    expect((list.objectives as unknown[]).length).toBe(1);
    expect(String(list.objectives[0].objective_id)).toBe(String(created.objective_id));

    const detail = await get(port, `/api/vnext/objectives/${created.objective_id}`).then((r) => r.json());
    expect(String(detail.objective_id)).toBe(String(created.objective_id));
    expect(detail.objective_digest).toBeTruthy();
    expect(detail.hard_constraints).toEqual(["Chỉ bán qua MQL5"]);
  });

  it("A2. legacy /api/objectives compat — same P15.1 authority, visible via vnext", async () => {
    const s = freshFullStack("a2");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const legacy = await post(port, "/api/objectives",
      { business_id: bid, title: "legacy obj", metric: "orders", target: "5", operator_id: OP }).then((r) => r.json());
    expect(String(legacy.objective_id)).toMatch(/^OBJ_/);

    // Same canonical row is readable through the strict vnext reads —
    // one authority, two transport shapes; no second writer/table.
    const detail = await get(port, `/api/vnext/objectives/${legacy.objective_id}`).then((r) => r.json());
    expect(String(detail.objective_id)).toBe(String(legacy.objective_id));
    const list = await get(port, `/api/vnext/objectives?business_id=${bid}`).then((r) => r.json());
    expect((list.objectives as unknown[]).length).toBe(1);
  });

  it("A3. dedup replay converges; conflicting dedup terms fail closed", async () => {
    const s = freshFullStack("a3");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const first = await post(port, "/api/vnext/objectives", OBJ_BODY(bid, { dedup_key: "dup1" })).then((r) => r.json());
    const replay = await post(port, "/api/vnext/objectives", OBJ_BODY(bid, { dedup_key: "dup1" })).then((r) => r.json());
    expect(String(replay.objective_id)).toBe(String(first.objective_id));

    const conflict = await post(port, "/api/vnext/objectives",
      OBJ_BODY(bid, { dedup_key: "dup1", title: "different title entirely" }));
    expect(conflict.status).toBe(409);
    expect(String((await conflict.json()).error)).toMatch(/^FAIL_CLOSED/);
  });

  it("A4. invalid input mapping: no business → FAIL, no title/statement → FIELD, bad kpi → FIELD", async () => {
    const s = freshFullStack("a4");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const r1 = await post(port, "/api/vnext/objectives", { title: "x" });
    expect(r1.status).toBe(409);
    expect(String((await r1.json()).error)).toMatch(/^FAIL_CLOSED/);

    const r2 = await post(port, "/api/vnext/objectives", { business_id: bid });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toBe("FAIL_CLOSED_OBJECTIVE_FIELD");

    const r3 = await post(port, "/api/vnext/objectives",
      { business_id: bid, title: "t", kpis: [{ bogus: true }] });
    expect(r3.status).toBe(409);
    expect((await r3.json()).error).toBe("FAIL_CLOSED_OBJECTIVE_FIELD");
  });

  it("A5. auth + operator gates: no token → 401; POST without operator → 403", async () => {
    const s = freshFullStack("a5");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const r1 = await fetch(`http://127.0.0.1:${port}/api/vnext/objectives?business_id=${bid}`);
    expect(r1.status).toBe(401);

    const r2 = await post(port, "/api/vnext/objectives", OBJ_BODY(bid),
      { "content-type": "application/json", authorization: `Bearer ${TOK}` });
    expect(r2.status).toBe(403);
    expect((await r2.json()).error).toBe("FAIL_CLOSED_OPERATOR_ID_REQUIRED");
  });

  it("A7. F1 — malformed constraint lists reject with typed 409, zero objective created", async () => {
    const s = freshFullStack("a7");
    const bid = mkBusiness(s);
    const port = await serve(s);

    // Scalar (not an array) — previously silently dropped by the route.
    const rScalar = await post(port, "/api/vnext/objectives",
      OBJ_BODY(bid, { hard_constraints: "Chỉ bán qua MQL5" }));
    expect(rScalar.status).toBe(409);
    expect((await rScalar.json()).error).toBe("FAIL_CLOSED_OBJECTIVE_FIELD");

    // Non-string element — previously String()-coerced into authority.
    const rElem = await post(port, "/api/vnext/objectives",
      OBJ_BODY(bid, { success_conditions: ["ok", 42, null] }));
    expect(rElem.status).toBe(409);
    expect((await rElem.json()).error).toBe("FAIL_CLOSED_OBJECTIVE_FIELD");

    const rEmpty = await post(port, "/api/vnext/objectives",
      OBJ_BODY(bid, { stop_conditions: ["  "] }));
    expect(rEmpty.status).toBe(409);

    // Nothing was minted through the failures.
    expect(s.store.list("objective").length).toBe(0);
    const list = await get(port, `/api/vnext/objectives?business_id=${bid}`).then((r) => r.json());
    expect((list.objectives as unknown[]).length).toBe(0);
  });

  it("A8. F1 — valid constraint arrays round-trip verbatim", async () => {
    const s = freshFullStack("a8");
    const bid = mkBusiness(s);
    const port = await serve(s);

    const created = await post(port, "/api/vnext/objectives", OBJ_BODY(bid, {
      hard_constraints: ["Chỉ bán qua MQL5", "no paid ads"],
      success_conditions: ["10 orders", "refund rate < 5%"],
      stop_conditions: ["2 consecutive failed reviews"],
    }));
    expect(created.status).toBe(200);
    const row = await created.json();
    expect(row.hard_constraints).toEqual(["Chỉ bán qua MQL5", "no paid ads"]);
    expect(row.success_conditions).toEqual(["10 orders", "refund rate < 5%"]);
    expect(row.stop_conditions).toEqual(["2 consecutive failed reviews"]);
  });

  it("A6. corrupt canonical row → strict list/detail reject (never silently serve)", async () => {
    const s = freshFullStack("a6");
    const bid = mkBusiness(s);
    const port = await serve(s);
    const o = s.biz.objectives.create({
      business_id: bid, title: "v", dedup_key: "k1", operator_id: OP });
    const oid = String(o.objective_id);
    // Tamper the stored row: status outside the enum.
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT payload FROM entities WHERE entity_type='objective' AND entity_id=?").get(oid) as { payload: string };
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    body.status = "TAMPERED";
    db.prepare("UPDATE entities SET payload=? WHERE entity_type='objective' AND entity_id=?")
      .run(JSON.stringify(body), oid);

    const list = await get(port, `/api/vnext/objectives?business_id=${bid}`);
    expect(list.status).toBe(409);
    const detail = await get(port, `/api/vnext/objectives/${oid}`);
    expect(detail.status).toBe(409);
  });
});

describe("P15.7 §B — CEO operating trigger", () => {
  async function seededServer(name: string, invoker: CeoDecisionInvoker) {
    const s = freshFullStack(name);
    const bid = mkBusiness(s);
    const o = s.biz.objectives.create({
      business_id: bid, title: "o", statement: "s",
      kpis: [{ name: "ea_orders", unit: "orders", direction: "AT_LEAST", baseline: 2, target: 10 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 500_000_000,
      dedup_key: `dk-${counter}`, operator_id: OP,
    });
    s.biz.createOrgAgent({ business_id: bid, title: "a", department: "ops", operator_id: OP });
    seedDefaultCeoModel(s.store);
    const port = await serve(s, { invoker });
    return { s, oid: String(o.objective_id), bid, port };
  }

  it("B1. fresh pass through real HTTP: INITIALIZE → allocate → open → DISPATCHED + real mission", async () => {
    const { s, oid, port } = await seededServer("b1", new FakeInvoker(INIT_JSON()));
    const r = await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    expect(r.status).toBe(200);
    const out = await r.json() as { outcome: string; mission_id?: string; workstream_key?: string };
    expect(out.outcome).toBe("DISPATCHED");
    expect(String(out.mission_id)).toMatch(/^MSN_/);
    expect(out.workstream_key).toBe("w1");
    // The minted mission is a real canonical bound mission in the store.
    expect(missions(s)).toEqual([String(out.mission_id)]);
    expect(missions(s).length).toBe(1);
  });

  it("B2. in-flight mission → canonically proven AWAITING_EXECUTION via HTTP", async () => {
    const { s, oid, port } = await seededServer("b2", new FakeInvoker(INIT_JSON()));
    await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    const r2 = await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    expect(r2.status).toBe(200);
    const out = await r2.json() as { outcome: string; mission_id?: string };
    expect(out.outcome).toBe("AWAITING_EXECUTION");
    expect(missions(s).length).toBe(1); // no second dispatch
  });

  it("B3. invalid objective → 409 typed error; PAUSED objective → typed OBJECTIVE_NOT_ACTIVE, zero mission", async () => {
    const { s, oid, bid, port } = await seededServer("b3", new FakeInvoker(INIT_JSON()));
    const rBad = await post(port, "/api/vnext/objectives/OBJ_NONEXISTENT/ceo-cycle", {});
    expect(rBad.status).toBe(404); // store.get → NOT_FOUND mapping
    expect((await rBad.json()).error).toBe("NOT_FOUND");

    s.biz.objectives.transitionStatus(oid, { business_id: bid, to: "PAUSED", actor: OWNER });
    const rPaused = await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    expect(rPaused.status).toBe(200);
    expect((await rPaused.json()).outcome).toBe("OBJECTIVE_NOT_ACTIVE");
    expect(missions(s).length).toBe(0);
  });

  it("B4. two concurrent cycle calls → exactly one dispatched mission", async () => {
    const { s, oid, port } = await seededServer("b4", new FakeInvoker(INIT_JSON()));
    const [r1, r2] = await Promise.all([
      post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {}),
      post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {}),
    ]);
    const o1 = await r1.json() as { outcome: string };
    const o2 = await r2.json() as { outcome: string };
    expect([o1.outcome, o2.outcome].sort()).toEqual(["AWAITING_EXECUTION", "DISPATCHED"]);
    expect(missions(s).length).toBe(1);
  });

  it("B5. CEO model unqualified → typed failure on that route only; other endpoints unaffected", async () => {
    const s = freshFullStack("b5");
    const bid = mkBusiness(s);
    // NO seedDefaultCeoModel — provider/model absent.
    const o = s.biz.objectives.create({ business_id: bid, title: "o", dedup_key: "k", operator_id: OP });
    const port = await serve(s, { invoker: new FakeInvoker(INIT_JSON()) });

    const r = await post(port, `/api/vnext/objectives/${o.objective_id}/ceo-cycle`, {});
    expect(r.status).toBe(409);
    expect(String((await r.json()).error)).toMatch(/^FAIL_CLOSED/);

    // Server still serves unrelated endpoints — lazy composition never
    // took the process down.
    const list = await get(port, `/api/vnext/objectives?business_id=${bid}`);
    expect(list.status).toBe(200);
  });

  it("B6. HTTP body cannot inject hooks/invoker/model/executor — service uses wired deps only", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const { s, oid, port } = await seededServer("b6", inv);
    const r = await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {
      hooks: { afterReview: "x" },
      invoker: { malicious: true },
      model_entry_id: "ME_EVIL",
      executor: "EXEC_EVIL",
      actor: "operator:attacker",
    });
    expect(r.status).toBe(200);
    const out = await r.json() as { outcome: string; ceo_decision_id?: string };
    expect(out.outcome).toBe("DISPATCHED");
    // The decision ran through the wired FakeInvoker — its inputs show
    // the server-resolved model transport, never the caller's fields.
    expect(inv.inputs.length).toBeGreaterThan(0);
    expect(String(inv.inputs[0].transport.model_id)).toBe(CEO_CODEX_DEFAULT_MODEL);
    expect(missions(s).length).toBe(1);
  });

  it("B7. lazy service cache: second request reuses the same composed service", async () => {
    const inv = new FakeInvoker(INIT_JSON());
    const { oid, port } = await seededServer("b7", inv);
    await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    const calls = inv.inputs.length;
    const r = await post(port, `/api/vnext/objectives/${oid}/ceo-cycle`, {});
    expect(r.status).toBe(200);
    // Awaiting an in-flight mission consumes NO additional CEO call.
    expect(inv.inputs.length).toBe(calls);
  });
});

describe("P15.7 R2 — display semantics (F2 zero-budget, F3 error states)", () => {
  it("F2-a. usdToMicrousd — exact integer microusd, rejects non-finite/negative/unsafe", () => {
    expect(usdToMicrousd("500.25")).toBe(500_250_000);
    expect(usdToMicrousd("0")).toBe(0);
    expect(usdToMicrousd("1")).toBe(1_000_000);
    expect(usdToMicrousd("0.000001")).toBe(1);
    expect(usdToMicrousd("abc")).toBeNull();
    expect(usdToMicrousd("-1")).toBeNull();
    expect(usdToMicrousd("1e30")).toBeNull(); // unsafe integer → reject, never silent
    expect(usdToMicrousd("")).toBeNull();
  });

  it("F2-b/R3.A. budgetView — three states, exhausted positive is never 'zero budget', never 'uncapped'", () => {
    // Case 1: ceiling = 0 → ZERO_BUDGET
    const absent = budgetView(null);
    expect(absent.state).toBe("ZERO_BUDGET");
    expect(absent.ceiling_micro).toBe(0);
    expect(absent.can_dispatch).toBe(false);
    expect(absent.label).toContain("zero budget");
    expect(absent.label).not.toContain("uncapped");

    const zero = budgetView({ ceiling_microusd: 0, consumed_microusd: 0 });
    expect(zero.state).toBe("ZERO_BUDGET");
    expect(zero.can_dispatch).toBe(false);

    // Case 2: ceiling > 0 && consumed >= ceiling → BUDGET_EXHAUSTED —
    // NEVER labeled zero budget.
    const exhausted = budgetView({ ceiling_microusd: 500_000_000, consumed_microusd: 500_000_000 });
    expect(exhausted.state).toBe("BUDGET_EXHAUSTED");
    expect(exhausted.can_dispatch).toBe(false);
    expect(exhausted.remaining_micro).toBe(0);
    expect(exhausted.label).toContain("exhausted");
    expect(exhausted.label).not.toContain("zero budget");

    const overSpent = budgetView({ ceiling_microusd: 100, consumed_microusd: 500 });
    expect(overSpent.state).toBe("BUDGET_EXHAUSTED");
    expect(overSpent.label).not.toContain("zero budget");

    // Case 3: consumed < ceiling → AVAILABLE
    const live = budgetView({ ceiling_microusd: 500_250_000, consumed_microusd: 100_000_000 });
    expect(live.state).toBe("AVAILABLE");
    expect(live.can_dispatch).toBe(true);
    expect(live.remaining_micro).toBe(400_250_000);
    expect(live.label).not.toContain("zero budget");
    expect(live.label).not.toContain("exhausted");
  });

  it("F3-a. listState — failed fetch is error (never empty); stale rows suppressed", () => {
    expect(listState(null, null)).toBe("loading");
    expect(listState([], null)).toBe("empty");
    expect(listState([{ id: 1 }], null)).toBe("rows");
    // Stale data + error → error wins; rows are not rendered as valid.
    expect(listState([{ id: 1 }], new Error("boom"))).toBe("error");
    expect(listState(null, new Error("boom"))).toBe("error");
  });

  it("F3-b/R3.B — stale detail + cycle action hidden when the list read is in error", () => {
    expect(showObjectiveDetail("error")).toBe(false);
    expect(showObjectiveDetail("rows")).toBe(true);
    expect(showObjectiveDetail("empty")).toBe(true);
    expect(showObjectiveDetail("loading")).toBe(true);
  });
});
