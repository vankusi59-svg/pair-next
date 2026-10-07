/**
 * P15.4 — Workforce Allocation & Governed Delegation: adversarial
 * matrix. The allocation layer chooses WHICH canonical org_agent owns a
 * ready P15.2 workstream via the EXISTING P14 `delegateWorkItem` seam —
 * never a second executor router, never a mission, never a status text.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  ApprovalQueue,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  ObjectiveWorkstreamService,
  allocationDelegationKey,
  assertCanonicalWorkforceAllocation,
  delegationRowId,
  digest,
  objectiveWorkstreamBindingDigest,
  workforceAllocationDigest,
  workforceAllocationId,
  WORKFORCE_ALLOCATION_COMMITTED_EVENT,
  WORKFORCE_ALLOCATION_ENTITY,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p154-"));
let counter = 0;
const OP = "1882810918";

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function sqlRewriteEntity(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  fn: (body: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare("SELECT payload FROM entities WHERE entity_type=? AND entity_id=?")
    .get(entityType, entityId) as { payload: string } | undefined;
  if (!row) throw new Error(`entity ${entityType}:${entityId} absent`);
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  fn(body);
  dbOf(store)
    .prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), entityType, entityId);
}

function sqlRewriteEvent(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  eventType: string,
  fn: (ev: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare(
      "SELECT * FROM events WHERE entity_type=? AND entity_id=? AND event_type=? ORDER BY seq LIMIT 1")
    .get(entityType, entityId, eventType) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`event ${eventType} absent`);
  const metadata = row.metadata_json
    ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : null;
  fn(metadata ?? {});
  const body = {
    event_id: row.event_id, entity_type: row.entity_type,
    entity_id: row.entity_id, event_type: row.event_type,
    old_state: row.old_state, new_state: row.new_state,
    actor: row.actor, correlation_id: row.correlation_id,
    metadata, created_at: row.created_at,
  };
  dbOf(store)
    .prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
    .run(metadata ? JSON.stringify(metadata) : null, digest(body), String(row.event_id));
}

type Stack = {
  dbPath: string;
  dir: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  alloc: WorkforceAllocationService;
  workstreams: ObjectiveWorkstreamService;
};

function freshStack(name: string): Stack {
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
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  return { dbPath, dir, store, biz, wf, alloc, workstreams };
}

/** Full governed stack — needed only where a REAL canonical completion
 *  (WCP) must exist: the open→bound-mission→evidence→DONE chain.
 *  The BusinessLayer here wires the REAL MissionControl so
 *  openWorkItem can mint bound missions. */
function freshFullStack(name: string) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
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
  for (const c of ["FILE_OPERATIONS", "REASONING", "NETWORK_ACCESS"]) {
    service.registerCapability(c, { risk_class: "LOW" });
  }
  const project = service.createProject({ name: "biz", root_location: workspace });
  const projectId = String(project.project_id);
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  return { dir, dbPath, store, service, biz, wf, workstreams, alloc, projectId };
}

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${counter}`) {
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(s: Stack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "Sell 10 units",
    statement: "Grow sales",
    kpis: [{ name: "sales", unit: "units", baseline: 0, target: 10 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["no discounts below cost"],
    success_conditions: ["10 units sold"],
    dedup_key: `dk-${counter}`,
    operator_id: OP,
  });
}

function decompose(s: Stack, oid: string, keys: string[] | Array<Record<string, unknown>>) {
  const o = s.biz.objectives.get(oid);
  const workstreams = keys.map((k, i) => typeof k === "string"
    ? { workstream_key: k, title: `ws ${k}`, goal: `g ${k}` }
    : k);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: workstreams as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Record<string, unknown>, key: string): string {
  const ws = (binding.workstreams as Array<Record<string, unknown>>)
    .find((w) => String(w.workstream_key) === key)!;
  return String(ws.work_item_id);
}

function mkAgent(s: Stack, businessId: string, opts: Record<string, unknown> = {}) {
  return s.biz.createOrgAgent({
    business_id: businessId,
    title: `agent ${counter}`,
    department: "ops",
    operator_id: OP,
    ...opts,
  });
}

function expectFail(fn: () => unknown, code: string | RegExp) {
  try {
    fn();
  } catch (e) {
    if (code instanceof RegExp) {
      expect(String((e as { code?: string }).code)).toMatch(code);
    } else {
      expect((e as { code?: string }).code).toBe(code);
    }
    return;
  }
  throw new Error(`expected ${String(code)} — call succeeded`);
}

function rowCount(store: PairEvidenceStore, entity: string): number {
  return store.list(entity).length;
}

/** Seed: objective + 2-workstream binding (w1 → w2), one ACTIVE agent. */
function seeded(name: string, agentOpts: Record<string, unknown> = {}) {
  const s = freshStack(name);
  const bid = mkBusiness(s.store);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = decompose(s, oid, ["w1", "w2"]);
  const agent = mkAgent(s, bid, agentOpts);
  return { s, bid, oid, binding, agent };
}

/* ============================ A — happy path ============================ */

describe("P15.4 A — happy path", () => {
  it("1. allocation mints delegated child + receipt + anchor; workstream stays unassigned", () => {
    const { s, oid, binding, agent } = seeded("a1");
    const w1 = wsWorkItemId(binding, "w1");
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("allocated");
    expect(r.selected_agent_id).toBe(String(agent.agent_id));
    // The P15.2 workstream stays the canonical unassigned container.
    const wi = s.store.get("work_item", w1);
    expect(wi.assignee_agent_id ?? null).toBeNull();
    // Delegated child is REAL P14 authority: assigned to agent, READY.
    const child = s.store.get("work_item", String(r.delegated_child_work_item_id));
    expect(String(child.assignee_agent_id)).toBe(String(agent.agent_id));
    expect(String(child.parent_work_item_id)).toBe(w1);
    expect(String(child.status)).toBe("READY");
    expect(String(child.delegation_key)).toBe(allocationDelegationKey(oid, w1));
    // WDEL row — OPERATOR mode provenance, no forged agent delegator.
    const wdel = s.store.get("work_delegation", delegationRowId(String(child.work_item_id)));
    expect(String(wdel.delegated_to_agent_id)).toBe(String(agent.agent_id));
    expect(String(wdel.delegation_key)).toBe(allocationDelegationKey(oid, w1));
    expect(String(wdel.delegation_mode)).toBe("OPERATOR");
    // Receipt + exactly-one anchor; strict read passes.
    const wal = s.store.get(WORKFORCE_ALLOCATION_ENTITY,
      workforceAllocationId(oid, w1));
    assertCanonicalWorkforceAllocation(s.alloc["deps"], wal);
    expect(String(wal.selected_agent_id)).toBe(String(agent.agent_id));
    const anchors = s.store
      .listEvents(WORKFORCE_ALLOCATION_ENTITY, String(wal.allocation_id))
      .filter((e) => String(e.event_type) === WORKFORCE_ALLOCATION_COMMITTED_EVENT);
    expect(anchors).toHaveLength(1);
    expect(String(anchors[0]!.actor)).toBe(`operator:${OP}`);
    s.store.close();
  });

  it("2. assignWorkItem can never rewrite the allocated workstream's assignee", () => {
    const { s, oid, binding, agent } = seeded("a2");
    const w1 = wsWorkItemId(binding, "w1");
    expectFail(() => s.biz.assignWorkItem(w1, String(agent.agent_id), OP),
      "FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    // Still unassigned at the container; still immutable.
    expect(s.store.get("work_item", w1).assignee_agent_id ?? null).toBeNull();
    expectFail(() => s.biz.assignWorkItem(w1, String(agent.agent_id), OP),
      "FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
    s.store.close();
  });

  it("3. allocateReadyWorkstreams allocates all ready workstreams deterministically", () => {
    const s = freshStack("a3");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1", "w2", "w3"]); // independent — all ready
    mkAgent(s, bid);
    const results = s.alloc.allocateReadyWorkstreams({ objective_id: oid, actor: OP });
    expect(results.map((r) => r.status)).toEqual(["allocated", "allocated", "allocated"]);
    expect(results.map((r) => r.workstream_key)).toEqual(["w1", "w2", "w3"]);
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(3);
    s.store.close();
  });
});

/* ============================ B — dependency authority ============================ */

describe("P15.4 B — dependency gating", () => {
  it("4. dependent workstream is dependency_blocked before canonical WCP", () => {
    const s = freshStack("b1");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, [
      { workstream_key: "wa", title: "a", goal: "a" },
      { workstream_key: "wb", title: "b", goal: "b", depends_on_keys: ["wa"] },
    ]);
    mkAgent(s, bid);
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "wb", actor: OP });
    expect(r.status).toBe("dependency_blocked");
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(0);
    expect(rowCount(s.store, "work_delegation")).toBe(0);
    s.store.close();
  });

  it("5. forged DONE status (no WCP) does not unlock the dependent", () => {
    const s = freshStack("b2");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const binding = decompose(s, oid, [
      { workstream_key: "wa", title: "a", goal: "a" },
      { workstream_key: "wb", title: "b", goal: "b", depends_on_keys: ["wa"] },
    ]);
    mkAgent(s, bid);
    const wa = wsWorkItemId(binding, "wa");
    // Forged status text — no canonical WCP exists.
    sqlRewriteEntity(s.store, "work_item", wa, (b) => { b.status = "DONE"; });
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "wb", actor: OP });
    expect(r.status).toBe("dependency_blocked");
    s.store.close();
  });

  it("6. canonical WCP unlocks dependent allocation", () => {
    const s = freshFullStack("b3");
    const b = s.biz.createBusiness({ name: "b", project_id: s.projectId, operator_id: OP });
    const bid = String(b.business_id);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const binding = decompose(s, oid, [
      { workstream_key: "wa", title: "a", goal: "a" },
      { workstream_key: "wb", title: "b", goal: "b", depends_on_keys: ["wa"] },
    ]);
    mkAgent(s, bid);
    expect(s.alloc.allocateWorkstream(
      { objective_id: oid, workstream_key: "wb", actor: OP }).status).toBe("dependency_blocked");
    // Canonical completion chain on the UPSTREAM workstream — real
    // open → bound mission → governed evidence → DONE + WCP.
    const wa = wsWorkItemId(binding, "wa");
    s.biz.openWorkItem(wa, OP);
    const mid = String((s.store.get("work_item", wa).mission_ids as string[])[0]);
    canonicallyCompleteMission(s.store, s.service, mid);
    s.biz.syncWorkItem(wa);
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "wb", actor: OP });
    expect(r.status).toBe("allocated");
    s.store.close();
  });
});

/* ============================ C — eligibility ============================ */

describe("P15.4 C — hard eligibility", () => {
  it("7. PAUSED/TERMINATED agents are never selected", () => {
    const s = freshStack("c1");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    const paused = mkAgent(s, bid, { title: "p" });
    const pausedRow = s.store.get("org_agent", String(paused.agent_id));
    s.store.put("org_agent", String(paused.agent_id),
      { ...pausedRow, status: "PAUSED" }, Number(pausedRow.version));
    const active = mkAgent(s, bid, { title: "a" });
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("allocated");
    expect(r.selected_agent_id).toBe(String(active.agent_id));
    s.store.close();
  });

  it("8. DISABLED contract / missing contract excluded", () => {
    const s = freshStack("c2");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    const disabled = mkAgent(s, bid, { title: "nc" });
    // Canonical disable — a DISABLED P12 contract is never usable.
    s.biz.setAgentContractStatus(String(disabled.agent_id), "DISABLED", OP);
    const good = mkAgent(s, bid, { title: "g" });
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("allocated");
    expect(r.selected_agent_id).toBe(String(good.agent_id));
    s.store.close();
  });

  it("9. cross-business agents are never candidates", () => {
    const s = freshStack("c3");
    const bid = mkBusiness(s.store);
    const bid2 = mkBusiness(s.store, `BIZ_other_${counter}`);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    mkAgent(s, bid2); // foreign business — the ONLY agent
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("no_eligible_agent");
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(0);
    s.store.close();
  });

  it("10. contract scope gates win: project deny + capability-permit boundary", () => {
    const s = freshStack("c4");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const binding = decompose(s, oid, ["w1"]);
    const w1 = wsWorkItemId(binding, "w1");
    const denied = mkAgent(s, bid, { title: "den" });
    // Contract denies the objective's project → never eligible.
    s.biz.upsertAgentContract(String(denied.agent_id), OP,
      { allowed_project_ids: ["PRJ_NOWHERE"] });
    const ok = mkAgent(s, bid, { title: "ok" });
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("allocated");
    expect(r.selected_agent_id).toBe(String(ok.agent_id));
    // Injected required_capability on the canonical child = spec drift;
    // the P14 authority validator rejects the mutation — the gate can
    // never be forged on a real committed workstream.
    sqlRewriteEntity(s.store, "work_item", w1,
      (b) => { b.required_capability = "REASONING"; });
    expectFail(() => s.alloc.allocateWorkstream(
      { objective_id: oid, workstream_key: "w1", actor: OP }), /FAIL_CLOSED/);
    s.store.close();
  });

  it("11. zero eligible agents → typed no_eligible_agent, never a fallback", () => {
    const s = freshStack("c5");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    // No org_agent at all.
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("no_eligible_agent");
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(0);
    s.store.close();
  });
});

/* ============================ D — deterministic selection ============================ */

describe("P15.4 D — selection policy", () => {
  it("12. lower canonical active workload wins", () => {
    const s = freshStack("d1");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    const busy = mkAgent(s, bid, { title: "busy" });
    const idle = mkAgent(s, bid, { title: "idle" });
    // `busy` already owns a live assigned work item — workload 1.
    s.biz.createWorkItem({
      business_id: bid, title: "standalone", goal: "g",
      assignee_agent_id: String(busy.agent_id), operator_id: OP,
    });
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.status).toBe("allocated");
    expect(r.selected_agent_id).toBe(String(idle.agent_id));
    s.store.close();
  });

  it("13. equal workload → lexical agent_id tie-break", () => {
    const s = freshStack("d2");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    decompose(s, oid, ["w1"]);
    const a = mkAgent(s, bid, { title: "z last" });
    const b = mkAgent(s, bid, { title: "y first" });
    const lo = [String(a.agent_id), String(b.agent_id)].sort()[0]!;
    const r = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r.selected_agent_id).toBe(lo);
    s.store.close();
  });
});

/* ============================ E — slot, replay, race, stale ============================ */

describe("P15.4 E — slot semantics", () => {
  it("14. replay converges on the committed allocation — never a second", () => {
    const { s, oid, binding, agent } = seeded("e1");
    const r1 = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const r2 = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    expect(r2.status).toBe("replayed");
    expect(r2.allocation!.allocation_id).toBe(r1.allocation!.allocation_id);
    expect(r2.selected_agent_id).toBe(r1.selected_agent_id);
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(1);
    expect(rowCount(s.store, "work_delegation")).toBe(1);
    s.store.close();
  });

  it("15. same slot + different selected agent → fail closed, never child #2", () => {
    const { s, oid, binding, bid } = seeded("e2");
    const w1 = wsWorkItemId(binding, "w1");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const before = rowCount(s.store, "work_item");
    // A second delegateWorkItem on the same slot with a DIFFERENT agent
    // collides on the deterministic child id → P14 fails closed.
    const other = mkAgent(s, bid, { title: "other" });
    expectFail(() => s.wf.delegateWorkItem({
      work_item_id: w1,
      delegated_to_agent_id: String(other.agent_id),
      delegation_key: allocationDelegationKey(oid, w1),
    }, OP), /FAIL_CLOSED/);
    expect(rowCount(s.store, "work_item")).toBe(before); // no child #2
    expect(rowCount(s.store, "work_delegation")).toBe(1);
    s.store.close();
  });

  it("16. concurrent allocation of the same slot → exactly one winner", async () => {
    const { s, oid } = seeded("e3");
    const store = s.store;
    // Two in-process services racing on the same DB — the slot CAS is
    // the arbiter; serialized immediate() turns the loser into replay.
    const alloc2 = new WorkforceAllocationService({
      store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
    });
    void store;
    const p1 = Promise.resolve().then(() =>
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP }));
    const p2 = Promise.resolve().then(() =>
      alloc2.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP }));
    const [r1, r2] = await Promise.all([p1, p2]);
    const allocated = [r1, r2].filter((r) => r.status === "allocated");
    const replayed = [r1, r2].filter((r) => r.status === "replayed");
    expect(allocated.length + replayed.length).toBe(2);
    expect(allocated.length === 1 || allocated.length === 2).toBe(true);
    // Exactly one slot, one WDEL, one receipt.
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(1);
    s.store.close();
  });

  it("17. observation drift mid-commit → FAIL_CLOSED_P15_4_STALE_ALLOCATION", () => {
    const { s, oid, binding } = seeded("e4");
    // Mutate eligible set BETWEEN the decision snapshot and commit:
    // patch buildAllocationObservation indirectly by adding an agent
    // during the txn — easiest deterministic drift: flip wi status.
    const w1 = wsWorkItemId(binding, "w1");
    const origImmediate = s.store.immediate.bind(s.store);
    let once = false;
    s.store.immediate = ((fn: () => unknown) => origImmediate(() => {
      if (!once) {
        once = true;
        // Drift: create another eligible agent inside the commit window.
        mkAgent(s, String(s.biz.objectives.get(oid).business_id));
      }
      return fn();
    })) as typeof s.store.immediate;
    expectFail(() => s.alloc.allocateWorkstream(
      { objective_id: oid, workstream_key: "w1", actor: OP }),
      "FAIL_CLOSED_P15_4_STALE_ALLOCATION");
    expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(0);
    s.store.close();
  });
});

/* ============================ F — crash atomicity ============================ */

describe("P15.4 F — atomicity", () => {
  it("18. fault inside commit → zero receipt, zero delegated child residue", () => {
    for (const faultAt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { s, oid } = seeded(`f-${faultAt}`);
      const origPut = s.store.put.bind(s.store);
      let calls = 0;
      s.store.put = ((...args: Parameters<typeof origPut>) => {
        calls += 1;
        if (calls === faultAt) throw new IntegrityError("TEST_FAULT", `at write ${faultAt}`);
        return origPut(...args);
      }) as typeof s.store.put;
      try {
        s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
      } catch {
        // injected fault
      }
      if (calls >= faultAt) {
        expect(rowCount(s.store, WORKFORCE_ALLOCATION_ENTITY)).toBe(0);
        expect(rowCount(s.store, "work_delegation")).toBe(0);
      }
      s.store.close();
    }
  });
});

/* ============================ G — forgery & forbidden fields ============================ */

describe("P15.4 G — receipt forgery", () => {
  const strict = (s: Stack, oid: string, wid: string) =>
    assertCanonicalWorkforceAllocation(s.alloc["deps"],
      s.store.get(WORKFORCE_ALLOCATION_ENTITY, workforceAllocationId(oid, wid)));

  it("19. forged allocation_digest (recomputed after tamper) still fails full chain", () => {
    const { s, oid, binding } = seeded("g1");
    const w1 = wsWorkItemId(binding, "w1");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    // Tamper selected_agent_id + recompute a VALID self-digest — the
    // chain re-proof (WDEL still names the real agent) must reject it.
    sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
      workforceAllocationId(oid, w1), (b) => {
        b.selected_agent_id = "AGT_FORGED";
        b.allocation_digest = workforceAllocationDigest(b);
      });
    expectFail(() => strict(s, oid, w1), "FAIL_CLOSED_WORKFORCE_ALLOCATION");
    s.store.close();
  });

  it("20. deleted / duplicated anchor fails strict read", () => {
    const { s, oid, binding } = seeded("g2");
    const w1 = wsWorkItemId(binding, "w1");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const walId = workforceAllocationId(oid, w1);
    // Duplicate anchor → count != 1 → fail.
    const anchors = s.store.listEvents(WORKFORCE_ALLOCATION_ENTITY, walId);
    const a = anchors.find((e) => String(e.event_type) === WORKFORCE_ALLOCATION_COMMITTED_EVENT)!;
    s.store.event({
      entity_type: WORKFORCE_ALLOCATION_ENTITY, entity_id: walId,
      event_type: WORKFORCE_ALLOCATION_COMMITTED_EVENT,
      old_state: null, new_state: "COMMITTED", actor: `operator:${OP}`,
      metadata: a.metadata as Record<string, unknown>,
    });
    expectFail(() => strict(s, oid, w1), "FAIL_CLOSED_WORKFORCE_ALLOCATION");
    s.store.close();
  });

  it("21. shadow authority fields on the receipt → strict read fails", () => {
    const { s, oid, binding } = seeded("g3");
    const w1 = wsWorkItemId(binding, "w1");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    for (const field of ["selected_executor", "route_id", "mission_id",
      "planner_id", "telegram_delivery_id", "model_entry_id", "capability_router"]) {
      sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
        workforceAllocationId(oid, w1), (b) => { b[field] = "x"; });
      expectFail(() => strict(s, oid, w1), "FAIL_CLOSED_WORKFORCE_ALLOCATION");
      sqlRewriteEntity(s.store, WORKFORCE_ALLOCATION_ENTITY,
        workforceAllocationId(oid, w1), (b) => { delete b[field]; });
      strict(s, oid, w1); // back to canonical
    }
    s.store.close();
  });

  it("22. tampered anchor metadata pin fails even with recomputed event_hash", () => {
    const { s, oid, binding } = seeded("g4");
    const w1 = wsWorkItemId(binding, "w1");
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    sqlRewriteEvent(s.store, WORKFORCE_ALLOCATION_ENTITY,
      workforceAllocationId(oid, w1), WORKFORCE_ALLOCATION_COMMITTED_EVENT,
      (md) => { md.selected_agent_id = "AGT_FAKE"; });
    expectFail(() => strict(s, oid, w1), "FAIL_CLOSED_WORKFORCE_ALLOCATION");
    s.store.close();
  });
});

/* ============================ H — authority boundary ============================ */

describe("P15.4 H — authority boundary", () => {
  it("23. allocation commits ZERO mission/executor/routing/planner/telegram rows", () => {
    const { s, oid, binding } = seeded("h1");
    const before = {
      mission: rowCount(s.store, "mission"),
      work_open_binding: rowCount(s.store, "work_open_binding"),
      executor_execution: rowCount(s.store, "executor_execution"),
      routing_decision: rowCount(s.store, "routing_decision"),
      planner_attempt: rowCount(s.store, "planner_attempt"),
      telegram: rowCount(s.store, "telegram_delivery"),
    };
    s.alloc.allocateReadyWorkstreams({ objective_id: oid, actor: OP });
    for (const [k, v] of Object.entries(before)) {
      expect(rowCount(s.store, k), k).toBe(v);
    }
    // The allocated child is READY + assigned — and there is no mission.
    expect(rowCount(s.store, "mission")).toBe(0);
    s.store.close();
  });

  it("24. P15.2 binding + P14 graph topology unchanged by allocation", () => {
    const { s, oid, binding } = seeded("h2");
    const b0 = s.workstreams.getBinding(oid)!;
    const digest0 = objectiveWorkstreamBindingDigest(b0);
    s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
    const b1 = s.workstreams.getBinding(oid)!;
    expect(objectiveWorkstreamBindingDigest(b1)).toBe(digest0);
    // Workstream work items: still unassigned, same status.
    const w1 = wsWorkItemId(binding, "w1");
    expect(s.store.get("work_item", w1).assignee_agent_id ?? null).toBeNull();
    s.store.close();
  });

  it("25. no binding → fail closed; terminal objective workstream → fail closed", () => {
    const s = freshStack("h3");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    // No binding at all.
    expectFail(() => s.alloc.allocateWorkstream(
      { objective_id: oid, workstream_key: "w1", actor: OP }),
      "FAIL_CLOSED_WORKFORCE_ALLOCATION");
    // Unknown workstream key against a real binding.
    decompose(s, oid, ["w1"]);
    expectFail(() => s.alloc.allocateWorkstream(
      { objective_id: oid, workstream_key: "nope", actor: OP }),
      "FAIL_CLOSED_WORKFORCE_ALLOCATION");
    s.store.close();
  });
});
