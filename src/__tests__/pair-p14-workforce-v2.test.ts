/**
 * P14 WORKFORCE V2 PHASE 1 — governed work graph + delegation core.
 *
 * Invariants under test:
 *  - graph authority comes ONLY from canonical durable rows
 *    (work_graph_edge / work_delegation / work_decomposition) written by
 *    the WorkforceService seams inside one immediate() transaction —
 *    caller metadata and row fields alone carry zero authority;
 *  - no cycles / self-edges / cross-business / cross-project /
 *    missing-node edges;
 *  - decomposition is atomic (restart sees all-or-nothing) and the same
 *    decomposition_id replays idempotently;
 *  - delegation requires ACTIVE same-business agents + capability
 *    narrowing + deterministic single-child semantics;
 *  - a dependency unlocks only on proven DONE (bound COMPLETED mission),
 *    never on status alone;
 *  - child missions open ONLY through the Foundation V2 binding path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  childNodeId,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14wfv2-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const ALL_CAPS = [
  "FILE_OPERATIONS", "NETWORK_ACCESS", "SHELL_EXECUTION", "LLM_INFERENCE",
  "DEVIN_DELEGATION", "CREDENTIAL_ACCESS", "EVIDENCE_WRITE", "PLAN_GOVERNANCE",
  "SELF_MODIFY_CODE", "TELEGRAM_SEND", "BROWSER_USE", "DATA_STORE_WRITE",
];

type PlannerFn = (input: { mission: Record<string, unknown>; reason: string }) => { tasks: Array<Record<string, unknown>> };

type Ctx = ReturnType<typeof makeCtxOn>;
function makeCtxOn(dbPath: string, dir: string, opts: { planner?: PlannerFn } = {}) {
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const planner: PlannerFn =
    opts.planner ??
    (() => ({ tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] }));
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name: "biz", root_location: workspace });
  return { dir, store, service, control, projectId: String(project.project_id) };
}

function makeStack(name: string) {
  const dir = freshDir(name);
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  const wf = new WorkforceService({ store: ctx.store, business: biz });
  return { dir, ctx, biz, wf, schedules };
}

/** A fresh stack on the SAME db file — simulates process restart. */
function reopenStack(dir: string) {
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  const wf = new WorkforceService({ store: ctx.store, business: biz });
  return { ctx, biz, wf };
}

function makeBiz(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

function makeAgent(
  biz: BusinessLayer, businessId: string, role = "lead",
  caps: string[] = ["FILE_OPERATIONS"],
) {
  return biz.createOrgAgent({
    business_id: businessId, role, title: role, department: "ops",
    capabilities: caps, operator_id: "op",
  });
}

function makeItem(biz: BusinessLayer, businessId: string, over: Record<string, unknown> = {}) {
  return biz.createWorkItem({
    business_id: businessId, title: "w", goal: "do work",
    operator_id: "op", ...over,
  } as never);
}

const errCode = (fn: () => unknown): string => {
  try { fn(); return "NO_ERROR"; } catch (e) { return String((e as { code?: string }).code ?? e); }
};

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 — work graph edges", () => {
  it("WFV2-P1-GRAPH-HAPPY: canonical edges + graph projection", () => {
    const { ctx, biz, wf } = makeStack("g-happy");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeItem(biz, String(b.business_id), { title: "A" });
    const c = makeItem(biz, String(b.business_id), { title: "C" });
    const saved = wf.setWorkItemDependencies(
      String(c.work_item_id), [String(a.work_item_id)], Number(c.version), "op");
    expect(String(saved.work_item_id)).toBe(String(c.work_item_id));
    const edges = wf.dependenciesOf(String(c.work_item_id));
    expect(edges).toHaveLength(1);
    expect(String(edges[0].dependency_work_item_id)).toBe(String(a.work_item_id));
    expect(String(edges[0].business_id)).toBe(String(b.business_id));
    expect(String(edges[0].project_id)).toBe(ctx.projectId);
    const g = wf.workGraph(String(b.business_id));
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    const cNode = g.nodes.find((n) => String(n.work_item_id) === String(c.work_item_id))!;
    expect(cNode.dependencies_satisfied).toBe(false);
  });

  it("WFV2-P1-GRAPH-CYCLE: self-edge + transitive cycle fail closed", () => {
    const { ctx, biz, wf } = makeStack("g-cycle");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeItem(biz, String(b.business_id));
    const c = makeItem(biz, String(b.business_id));
    expect(errCode(() =>
      wf.setWorkItemDependencies(String(a.work_item_id), [String(a.work_item_id)], Number(a.version), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_CYCLE");
    wf.setWorkItemDependencies(String(c.work_item_id), [String(a.work_item_id)], Number(c.version), "op");
    // a → c would create c→a→c — dep c transitively reaches a? c depends
    // on a; adding a→c means a depends on c, and c depends on a → cycle.
    expect(errCode(() =>
      wf.setWorkItemDependencies(
        String(a.work_item_id), [String(c.work_item_id)],
        Number(ctx.store.get("work_item", String(a.work_item_id)).version), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_CYCLE");
  });

  it("WFV2-P1-GRAPH-CROSS-BUSINESS: edge to foreign node fails", () => {
    const { ctx, biz, wf } = makeStack("g-xbiz");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const proj2 = ctx.service.createProject({ name: "other", root_location: fs.mkdtempSync(path.join(ctx.dir, "ws2-")) });
    const b2 = makeBiz(biz, String(proj2.project_id), "B2");
    const n1 = makeItem(biz, String(b1.business_id));
    const n2 = makeItem(biz, String(b2.business_id));
    expect(errCode(() =>
      wf.setWorkItemDependencies(
        String(n1.work_item_id), [String(n2.work_item_id)], Number(n1.version), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_SCOPE");
    expect(wf.dependenciesOf(String(n1.work_item_id))).toHaveLength(0);
  });

  it("WFV2-P1-GRAPH-CROSS-PROJECT: different projects (same check) + missing node", () => {
    const { ctx, biz, wf } = makeStack("g-xprj");
    const b = makeBiz(biz, ctx.projectId);
    const n1 = makeItem(biz, String(b.business_id));
    expect(errCode(() =>
      wf.setWorkItemDependencies(String(n1.work_item_id), ["WI_missing"], Number(n1.version), "op"),
    )).toContain("FAIL_CLOSED");
    // stale CAS version also fails closed
    expect(errCode(() =>
      wf.setWorkItemDependencies(String(n1.work_item_id), [], 999, "op"),
    )).toBe("FAIL_CLOSED_VERSION_CONFLICT");
  });
});

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 — decomposition", () => {
  it("WFV2-P1-DECOMPOSE-RACE: same decomposition_id replays idempotently; different id conflicts", () => {
    const { ctx, biz, wf } = makeStack("dec-race");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: ag.agent_id });
    const spec = {
      decomposition_id: "DEC-1",
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(ag.agent_id) },
        { title: "c2", goal: "g2", depends_on_indices: [0] },
      ],
    };
    const r1 = wf.decomposeWorkItem(String(p.work_item_id), spec, "op");
    expect(r1.children).toHaveLength(2);
    // replay identical → same children, no new rows
    const before = ctx.store.list("work_item").length;
    const r2 = wf.decomposeWorkItem(String(p.work_item_id), spec, "op");
    expect(r2.children.map((c) => String(c.work_item_id)).join()).toBe(r1.children.map((c) => String(c.work_item_id)).join());
    expect(ctx.store.list("work_item")).toHaveLength(before);
    expect(ctx.store.list("work_decomposition")).toHaveLength(1);
    // different decomposition on the same parent → conflict
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), { decomposition_id: "DEC-2", children: [{ title: "x", goal: "x" }] }, "op"),
    )).toBe("FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT");
    // children carry canonical context — business derived from parent
    const c1 = r1.children[0];
    expect(String(c1.business_id)).toBe(String(b.business_id));
    expect(String(c1.parent_work_item_id)).toBe(String(p.work_item_id));
    expect(String(c1.decomposition_id)).toBe("DEC-1");
    // sibling dep edge materialized atomically
    const deps2 = wf.dependenciesOf(String(r1.children[1].work_item_id));
    expect(deps2.map((e) => String(e.dependency_work_item_id))).toEqual([String(c1.work_item_id)]);
  });

  it("WFV2-P1-DECOMPOSE-CRASH: mid-txn fault leaves zero partial state", () => {
    const { ctx, biz, wf } = makeStack("dec-crash");
    const b = makeBiz(biz, ctx.projectId);
    const p = makeItem(biz, String(b.business_id));
    // Second child carries an out-of-business assignee → validation throws
    // after the loop would have materialized child 0 — nothing may land.
    const itemsBefore = ctx.store.list("work_item").length;
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), {
        decomposition_id: "DEC-X",
        children: [
          { title: "ok", goal: "g" },
          { title: "bad", goal: "g", assignee_agent_id: "AGT_missing" },
        ],
      }, "op"),
    )).toContain("FAIL_CLOSED");
    expect(ctx.store.list("work_item")).toHaveLength(itemsBefore);
    expect(ctx.store.list("work_decomposition")).toHaveLength(0);
    expect(ctx.store.list("work_graph_edge")).toHaveLength(0);
    expect(String(ctx.store.get("work_item", String(p.work_item_id)).decomposition_id ?? "")).toBe("");
    // forged partial state: a child row claiming DEC-X without the WDEC
    // row is quarantined on reconcile, never adopted.
    ctx.store.put("work_item", "WI_forged", {
      work_item_id: "WI_forged", business_id: String(b.business_id),
      title: "f", goal: "f", status: "BACKLOG", parent_work_item_id: String(p.work_item_id),
      decomposition_id: "DEC-X", created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    const res = wf.reconcileWorkGraph();
    expect(res.quarantined).toEqual(["WI_forged"]);
    expect(String(ctx.store.get("work_item", "WI_forged").blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(errCode(() => biz.openWorkItem("WI_forged", "op"))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });
});

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 — delegation", () => {
  it("WFV2-P1-DELEGATE-HAPPY: child + WDEL row + audit, canonical fields", () => {
    const { ctx, biz, wf } = makeStack("del-happy");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(to.agent_id),
      reason: "split work",
    }, "op");
    expect(String(child.parent_work_item_id)).toBe(String(p.work_item_id));
    expect(String(child.assignee_agent_id)).toBe(String(to.agent_id));
    const del = ctx.store.get("work_delegation", `WDEL_${String(child.work_item_id)}`);
    expect(String(del.state)).toBe("COMMITTED");
    expect(String(del.delegated_to_agent_id)).toBe(String(to.agent_id));
    expect(String(del.business_id)).toBe(String(b.business_id));
    const ev = ctx.store.listEvents("work_item", String(p.work_item_id))
      .filter((e) => e.event_type === "WORK_DELEGATED");
    expect(ev).toHaveLength(1);
    expect(String((ev[0].metadata as Record<string, unknown>).child_work_item_id)).toBe(String(child.work_item_id));
  });

  it("WFV2-P1-DELEGATE-INACTIVE-AGENT: PAUSED target fails closed", () => {
    const { ctx, biz, wf } = makeStack("del-inact2");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    biz.setOrgAgentStatus(String(to.agent_id), "PAUSED", "op");
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_by_agent_id: String(by.agent_id),
        delegated_to_agent_id: String(to.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(ctx.store.list("work_delegation")).toHaveLength(0);
    expect(wf.childrenOf(String(p.work_item_id))).toHaveLength(0);
  });

  it("WFV2-P1-DELEGATE-WRONG-BUSINESS: foreign target fails closed", () => {
    const { ctx, biz, wf } = makeStack("del-xbiz");
    const proj2 = ctx.service.createProject({ name: "p2", root_location: fs.mkdtempSync(path.join(ctx.dir, "w2-")) });
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, String(proj2.project_id), "B2");
    const by = makeAgent(biz, String(b1.business_id), "lead");
    const foreign = makeAgent(biz, String(b2.business_id), "worker");
    const p = makeItem(biz, String(b1.business_id), { assignee_agent_id: by.agent_id });
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_by_agent_id: String(by.agent_id),
        delegated_to_agent_id: String(foreign.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_DELEGATE_SCOPE");
  });

  it("WFV2-P1-DELEGATE-CAPABILITY-WIDEN: delegatee lacking required capability fails", () => {
    const { ctx, biz, wf } = makeStack("del-cap");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const weak = makeAgent(biz, String(b.business_id), "weak", []);
    const p = makeItem(biz, String(b.business_id), {
      assignee_agent_id: by.agent_id,
      required_capability: "SHELL_EXECUTION",
    } as never);
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_by_agent_id: String(by.agent_id),
        delegated_to_agent_id: String(weak.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_CAPABILITY");
    // a delegatee that HAS the capability still succeeds
    const strong = makeAgent(biz, String(b.business_id), "strong", ["SHELL_EXECUTION", "FILE_OPERATIONS"]);
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(strong.agent_id),
    }, "op");
    expect(String(child.required_capability)).toBe("SHELL_EXECUTION");
  });

  it("WFV2-P1-DELEGATE-RACE: same delegation_key is exactly-once across replays", () => {
    const { ctx, biz, wf } = makeStack("del-race");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    const input = {
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(to.agent_id),
      delegation_key: "K1",
    };
    const c1 = wf.delegateWorkItem(input, "op");
    const c2 = wf.delegateWorkItem(input, "op"); // replay
    expect(String(c1.work_item_id)).toBe(String(c2.work_item_id));
    expect(ctx.store.list("work_delegation")).toHaveLength(1);
    expect(wf.childrenOf(String(p.work_item_id))).toHaveLength(1);
  });

  it("WFV2-P1-FORGED-DELEGATION: row fields without WDEL row quarantine", () => {
    const { ctx, biz, wf } = makeStack("del-forge");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    // Forge a "delegated" child directly — fields present, no WDEL row.
    ctx.store.put("work_item", "WI_forged_del", {
      work_item_id: "WI_forged_del", business_id: String(b.business_id),
      title: "f", goal: "f", status: "READY",
      assignee_agent_id: String(to.agent_id),
      parent_work_item_id: String(p.work_item_id),
      delegated_from_work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegation_key: "forged", delegation_depth: 1,
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    const res = wf.reconcileWorkGraph();
    expect(res.quarantined).toEqual(["WI_forged_del"]);
    expect(errCode(() => biz.openWorkItem("WI_forged_del", "op"))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // a forged WDEL row that contradicts the child fields also fails
    ctx.store.put("work_delegation", "WDEL_WI_forged2", {
      delegation_id: "WDEL_WI_forged2", delegation_key: "other",
      parent_work_item_id: String(p.work_item_id), child_work_item_id: "WI_forged2",
      delegated_from_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(to.agent_id),
      depth: 1, business_id: String(b.business_id), project_id: ctx.projectId,
      state: "COMMITTED", created_by: "op", created_at: utcnow(), version: 0,
    }, 0);
    ctx.store.put("work_item", "WI_forged2", {
      work_item_id: "WI_forged2", business_id: String(b.business_id),
      title: "f", goal: "f", status: "READY", assignee_agent_id: String(to.agent_id),
      delegated_from_work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id), delegation_key: "real-key",
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    expect(wf.reconcileWorkGraph().quarantined).toEqual(["WI_forged2"]);
  });
});

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 — dependency gating + child missions", () => {
  it("WFV2-P1-FORGED-DONE-DEPENDENCY: status DONE without proof does not unlock", () => {
    const { ctx, biz, wf } = makeStack("dep-forge");
    const b = makeBiz(biz, ctx.projectId);
    const dep = makeItem(biz, String(b.business_id));
    const child = makeItem(biz, String(b.business_id));
    wf.setWorkItemDependencies(String(child.work_item_id), [String(dep.work_item_id)], Number(child.version), "op");
    // Forge DONE — no bound COMPLETED mission exists.
    const d = ctx.store.get("work_item", String(dep.work_item_id));
    ctx.store.put("work_item", String(dep.work_item_id), { ...d, status: "DONE" }, Number(d.version));
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
  });

  it("WFV2-P1-CHILD-BOUND-MISSION: delegated child opens via binding path only", () => {
    const { ctx, biz, wf } = makeStack("child-bound");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    const opened = biz.openWorkItem(String(child.work_item_id), "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
    const missionIds = (opened.mission_ids as string[]) ?? [];
    expect(missionIds).toHaveLength(1);
    const mission = ctx.store.get("mission", missionIds[0]);
    // the mission carries the bound_open_id origin proof (Foundation V2)
    expect(String(mission.bound_open_id ?? "")).not.toBe("");
    const binding = ctx.store.get("work_open_binding", String(mission.bound_open_id));
    expect(String(binding.state)).toBe("BOUND");
    expect(String(binding.work_item_id)).toBe(String(child.work_item_id));
    expect(String(binding.mission_id)).toBe(String(mission.mission_id));
  });

  it("WFV2-P1-RESTART-IDEMPOTENT: reopen stack, replay decompose, no new rows", () => {
    const first = makeStack("restart");
    const b = makeBiz(first.biz, first.ctx.projectId);
    const ag = makeAgent(first.biz, String(b.business_id));
    const p = makeItem(first.biz, String(b.business_id), { assignee_agent_id: ag.agent_id });
    const r1 = first.wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R",
      children: [{ title: "c1", goal: "g", assignee_agent_id: String(ag.agent_id) }],
    }, "op");
    const ag2 = makeAgent(first.biz, String(b.business_id), "worker");
    first.wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(ag.agent_id),
      delegated_to_agent_id: String(ag2.agent_id),
    }, "op");
    // restart on the same db
    const second = reopenStack(first.dir);
    const counts = {
      items: second.ctx.store.list("work_item").length,
      decs: second.ctx.store.list("work_decomposition").length,
      edges: second.ctx.store.list("work_graph_edge").length,
    };
    // R1 §2: replay is idempotent only for the IDENTICAL proposal
    // (same decomposition_id + same proposal_digest).
    const r2 = second.wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R",
      children: [{ title: "c1", goal: "g", assignee_agent_id: String(ag.agent_id) }],
    }, "op");
    expect(r2.children.map((c) => String(c.work_item_id))).toEqual(
      r1.children.map((c) => String(c.work_item_id)));
    expect(second.ctx.store.list("work_item")).toHaveLength(counts.items);
    expect(second.ctx.store.list("work_decomposition")).toHaveLength(counts.decs);
    expect(second.wf.reconcileWorkGraph().quarantined).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// R1 — canonical provenance + collision + authority narrowing
// ---------------------------------------------------------------------

describe("P14 WFV2-P1 R1 — canonical graph validators + collisions", () => {
  it("WFV2-P1-R1-DECOMP-SAME-ID-DIFFERENT-PAYLOAD: same id + changed spec conflicts", () => {
    const { ctx, biz, wf } = makeStack("r1-diff-payload");
    const b = makeBiz(biz, ctx.projectId);
    const p = makeItem(biz, String(b.business_id));
    wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R1",
      children: [{ title: "a", goal: "g1" }],
    }, "op");
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), {
        decomposition_id: "DEC-R1",
        children: [{ title: "DIFFERENT", goal: "g1" }],
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT");
    // and identical payload still replays
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R1",
      children: [{ title: "a", goal: "g1" }],
    }, "op");
    expect(r.children).toHaveLength(1);
  });

  it("WFV2-P1-R1-DECOMP-PREEXISTING-CHILD-COLLISION: forged DC_* child never adopted", () => {
    const { ctx, biz, wf } = makeStack("r1-preexist");
    const b = makeBiz(biz, ctx.projectId);
    const p = makeItem(biz, String(b.business_id));
    const decompId = "DEC-PRE";
    const collideId = childNodeId("DC", String(p.work_item_id), `${decompId}|0`);
    // Preseed a deterministic-id child whose provenance does NOT match
    // the intended spec (different title + wrong decomposition marker).
    ctx.store.put("work_item", collideId, {
      work_item_id: collideId, business_id: String(b.business_id),
      title: "forged", goal: "forged", status: "BACKLOG",
      parent_work_item_id: String(p.work_item_id), decomposition_id: "DEC-OTHER",
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), {
        decomposition_id: decompId, children: [{ title: "a", goal: "g" }],
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT");
    // no WDEC authority was created around the forged child
    expect(ctx.store.list("work_decomposition")).toHaveLength(0);
    // and exact-match v0 residue (crash-adoption shape) WOULD adopt —
    // prove the check is precise, not blanket.
    const p2 = makeItem(biz, String(b.business_id), { title: "p2" });
    const exact = childNodeId("DC", String(p2.work_item_id), "DEC-OK|0");
    ctx.store.put("work_item", exact, {
      work_item_id: exact, business_id: String(b.business_id),
      title: "a", goal: "g", status: "BACKLOG", source: "decomposition",
      parent_work_item_id: String(p2.work_item_id), decomposition_id: "DEC-OK",
      mission_ids: [], blocked_code: null,
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    }, 0);
    const r = wf.decomposeWorkItem(String(p2.work_item_id), {
      decomposition_id: "DEC-OK", children: [{ title: "a", goal: "g" }],
    }, "op");
    expect(String(r.children[0].work_item_id)).toBe(exact);
    expect(ctx.store.list("work_decomposition")).toHaveLength(1);
  });

  it("WFV2-P1-R1-WDEC-PAYLOAD-MISMATCH: malformed canonical WDEC quarantines", () => {
    const { ctx, biz, wf } = makeStack("r1-wdec-mismatch");
    const b = makeBiz(biz, ctx.projectId);
    const p = makeItem(biz, String(b.business_id));
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-M", children: [{ title: "a", goal: "g" }],
    }, "op");
    const dec = ctx.store.get("work_decomposition", `WDEC_${String(p.work_item_id)}`);
    // Corrupt the canonical row's project scope after commit.
    ctx.store.put("work_decomposition", `WDEC_${String(p.work_item_id)}`,
      { ...dec, project_id: "PRJ_forged" }, Number(dec.version));
    expect(errCode(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(r.children[0].work_item_id))),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(String(
      ctx.store.get("work_item", String(r.children[0].work_item_id)).blocked_code,
    )).toBe("TERMINAL_PROVENANCE_CORRUPT");
    // reconcile also quarantines the parent the malformed row would cover
    expect(wf.reconcileWorkGraph().quarantined).toContain(String(p.work_item_id));
  });

  it("WFV2-P1-R1-WDEL-WRONG-CHILD-ID / WRONG-PROJECT / WRONG-DEPTH: each fails canonical proof", () => {
    const { ctx, biz, wf } = makeStack("r1-wdel-mismatch");
    const b = makeBiz(biz, ctx.projectId);
    const by = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: by.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(by.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    const delId = `WDEL_${String(child.work_item_id)}`;
    const del = ctx.store.get("work_delegation", delId);
    const mutate = (patch: Record<string, unknown>) => {
      const cur = ctx.store.get("work_delegation", delId);
      ctx.store.put("work_delegation", delId,
        { ...del, ...patch, version: Number(cur.version) }, Number(cur.version));
    };
    // wrong child pointer
    mutate({ child_work_item_id: "WI_other" });
    expect(errCode(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // wrong project
    mutate({});
    mutate({ project_id: "PRJ_x" });
    expect(errCode(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // wrong depth
    mutate({});
    mutate({ depth: 7 });
    expect(errCode(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // intact row proves again
    mutate({});
    expect(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))),
    ).not.toThrow();
  });

  it("WFV2-P1-R1-WGE-PAYLOAD-MISMATCH: malformed edge never silently revived", () => {
    const { ctx, biz, wf } = makeStack("r1-wge-mismatch");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeItem(biz, String(b.business_id), { title: "A" });
    const c = makeItem(biz, String(b.business_id), { title: "C" });
    wf.setWorkItemDependencies(
      String(c.work_item_id), [String(a.work_item_id)], Number(c.version), "op");
    const edge = ctx.store.list("work_graph_edge")[0];
    // revoke it, then corrupt the REVOKED row's scope
    let curC = ctx.store.get("work_item", String(c.work_item_id));
    wf.setWorkItemDependencies(String(c.work_item_id), [], Number(curC.version), "op");
    const dead = ctx.store.get("work_graph_edge", String(edge.edge_id));
    expect(String(dead.state)).toBe("REVOKED");
    ctx.store.put("work_graph_edge", String(edge.edge_id),
      { ...dead, project_id: "PRJ_forged" }, Number(dead.version));
    // re-adding the same dep must NOT silently revive the corrupt row —
    // the canonical edge validator fails closed at the authority check
    // (assertGraphAuthority runs before writeEdge ever reaches revive).
    curC = ctx.store.get("work_item", String(c.work_item_id));
    expect(errCode(() =>
      wf.setWorkItemDependencies(
        String(c.work_item_id), [String(a.work_item_id)], Number(curC.version), "op"),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // the authority check outside the txn lands the quarantine durably
    expect(errCode(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(c.work_item_id))),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(String(
      ctx.store.get("work_item", String(c.work_item_id)).blocked_code,
    )).toBe("TERMINAL_PROVENANCE_CORRUPT");
    // corrupt edge was never revived
    expect(String(ctx.store.get("work_graph_edge", String(edge.edge_id)).state))
      .toBe("REVOKED");
  });
});

describe("P14 WFV2-P1 R1 — delegator identity + authority narrowing", () => {
  it("WFV2-P1-R1-DELEGATOR-NOT-PARENT-ASSIGNEE: arbitrary ACTIVE agent cannot claim delegation", () => {
    const { ctx, biz, wf } = makeStack("r1-delegator");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const bAgent = makeAgent(biz, String(b.business_id), "worker");
    const cAgent = makeAgent(biz, String(b.business_id), "reviewer");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_by_agent_id: String(bAgent.agent_id), // NOT the assignee
        delegated_to_agent_id: String(cAgent.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_DELEGATE_AUTHORITY");
    // operator-directed path (no delegated_by) records OPERATOR provenance
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_to_agent_id: String(cAgent.agent_id),
    }, "op");
    const del = ctx.store.get("work_delegation", `WDEL_${String(child.work_item_id)}`);
    expect(String(del.delegation_mode)).toBe("OPERATOR");
    expect(del.delegated_from_agent_id ?? null).toBeNull();
    expect(String(del.delegated_by_operator)).toBe("op");
    expect(() =>
      biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))),
    ).not.toThrow();
  });

  it("WFV2-P1-R1-DELEGATE-AUTHORITY-WIDEN: broader delegatee contract fails closed", () => {
    const { ctx, biz, wf } = makeStack("r1-del-widen");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const wide = makeAgent(biz, String(b.business_id), "worker");
    const narrow = makeAgent(biz, String(b.business_id), "intern");
    // parent assignee's contract is narrow: FILE_OPERATIONS only
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    // delegatee with unconstrained (baseline) authority exceeds it
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_by_agent_id: String(lead.agent_id),
        delegated_to_agent_id: String(wide.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    // delegatee narrowed to a subset works
    biz.upsertAgentContract(String(narrow.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(narrow.agent_id),
    }, "op");
    expect(String(child.assignee_agent_id)).toBe(String(narrow.agent_id));
  });

  it("WFV2-P1-R1-DECOMPOSE-AUTHORITY-WIDEN: assigned child exceeding parent ceiling fails", () => {
    const { ctx, biz, wf } = makeStack("r1-dec-widen");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const wide = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"], denied_capabilities: ["NETWORK_ACCESS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), {
        decomposition_id: "DEC-W",
        children: [{ title: "c", goal: "g", assignee_agent_id: String(wide.agent_id) }],
      }, "op"),
    )).toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect(ctx.store.list("work_item").filter((w) =>
      String(w.parent_work_item_id) === String(p.work_item_id))).toHaveLength(0);
    // unassigned parent: no fabricated ceiling — same-business ACTIVE
    // child with reqCap satisfied is the defined operator admission.
    const p2 = makeItem(biz, String(b.business_id), { title: "unassigned" });
    const r = wf.decomposeWorkItem(String(p2.work_item_id), {
      decomposition_id: "DEC-W2",
      children: [{ title: "c", goal: "g", assignee_agent_id: String(wide.agent_id) }],
    }, "op");
    expect(r.children).toHaveLength(1);
  });

  it("WFV2-P1-R1-HAPPY: valid delegation opens child mission through Foundation V2", () => {
    const { ctx, biz, wf } = makeStack("r1-happy");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(a.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    const opened = biz.openWorkItem(String(child.work_item_id), "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
    const mission = ctx.store.get("mission", String(opened.mission_ids[0]));
    expect(String(mission.bound_open_id ?? "")).not.toBe("");
    const binding = ctx.store.get("work_open_binding", String(mission.bound_open_id));
    expect(String(binding.state)).toBe("BOUND");
    expect(String(binding.work_item_id)).toBe(String(child.work_item_id));
  });
});
