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
import {
  authorityBindingDigest,
  authorityCeilingDigest,
  membershipDigest,
} from "../pair/graph-authority.js";
import {
  assertCanonicalContractRevision,
  contractDigest,
  contractRevisionRowId,
} from "../pair/agent-contract.js";

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
    // Rebaseline — a forged WDEL poisons BOTH endpoints: the claimed child
    // AND the parent it names (the parent's membership can no longer prove
    // its graph participation — the canonical row asserting it is corrupt).
    expect(wf.reconcileWorkGraph().quarantined).toEqual(
      ["WI_forged2", String(p.work_item_id)]);
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

// ---------------------------------------------------------------------
// R2 — dependency-set manifest (WDS) + persisted authority ceiling +
//      open-time subset enforcement + immutable decomposition topology
// ---------------------------------------------------------------------

describe("P14 WFV2-P1 R2 — dependency manifest + authority ceiling", () => {
  const wdsOf = (ctx: Ctx, id: string) =>
    ctx.store.tryGet("work_dependency_set", `WDS_${id}`) as Record<string, unknown> | null;

  it("WFV2-P1-R2-WGE-MOVED-DEPENDENT: edge dependent moved fails closed at open", () => {
    const { ctx, biz, wf } = makeStack("r2-moved-dep");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "lead");
    const a = makeItem(biz, String(b.business_id), { title: "A", assignee_agent_id: ag.agent_id });
    const dep = makeItem(biz, String(b.business_id), { title: "dep" });
    const x = makeItem(biz, String(b.business_id), { title: "X" });
    wf.setWorkItemDependencies(
      String(a.work_item_id), [String(dep.work_item_id)], Number(a.version), "op");
    const edge = ctx.store.list("work_graph_edge")[0];
    // tamper: move the edge's dependent to a different item — A's manifest
    // still lists the edge but the edge no longer claims A.
    ctx.store.put("work_graph_edge", String(edge.edge_id),
      { ...edge, dependent_work_item_id: String(x.work_item_id) }, Number(edge.version));
    expect(errCode(() => biz.openWorkItem(String(a.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(String(ctx.store.get("work_item", String(a.work_item_id)).blocked_code))
      .toBe("TERMINAL_PROVENANCE_CORRUPT");
  });

  it("WFV2-P1-R2-WGE-MISSING-EXPECTED: manifest-listed edge revoked fails closed", () => {
    const { ctx, biz, wf } = makeStack("r2-missing-edge");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "lead");
    const a = makeItem(biz, String(b.business_id), { title: "A", assignee_agent_id: ag.agent_id });
    const dep = makeItem(biz, String(b.business_id), { title: "dep" });
    wf.setWorkItemDependencies(
      String(a.work_item_id), [String(dep.work_item_id)], Number(a.version), "op");
    const edge = ctx.store.list("work_graph_edge")[0];
    // silently revoke the edge outside the canonical seam — manifest
    // still expects it ACTIVE.
    ctx.store.put("work_graph_edge", String(edge.edge_id),
      { ...edge, state: "REVOKED" }, Number(edge.version));
    expect(errCode(() => biz.openWorkItem(String(a.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("WFV2-P1-R2-WGE-EXTRA-ACTIVE: unlisted ACTIVE edge fails closed", () => {
    const { ctx, biz, wf } = makeStack("r2-extra-edge");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "lead");
    const a = makeItem(biz, String(b.business_id), { title: "A", assignee_agent_id: ag.agent_id });
    const dep1 = makeItem(biz, String(b.business_id), { title: "d1" });
    const dep2 = makeItem(biz, String(b.business_id), { title: "d2" });
    wf.setWorkItemDependencies(
      String(a.work_item_id), [String(dep1.work_item_id)], Number(a.version), "op");
    const realEdge = ctx.store.list("work_graph_edge")[0];
    // forge an extra ACTIVE edge A→d2 that the manifest does not list —
    // canonically valid shape, but not in the dependency-set authority.
    const extraId = `WGE_${a.work_item_id}_${dep2.work_item_id}`;
    ctx.store.put("work_graph_edge", extraId, {
      ...realEdge,
      edge_id: extraId,
      dependency_work_item_id: String(dep2.work_item_id),
      version: 0,
    } as never, 0);
    expect(errCode(() => biz.openWorkItem(String(a.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("WFV2-P1-R2-EMPTY-DEPENDENCY-MANIFEST: setDependencies([]) leaves canonical empty set", () => {
    const { ctx, biz, wf } = makeStack("r2-empty-wds");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeItem(biz, String(b.business_id), { title: "A" });
    const dep = makeItem(biz, String(b.business_id), { title: "dep" });
    wf.setWorkItemDependencies(
      String(a.work_item_id), [String(dep.work_item_id)], Number(a.version), "op");
    const cur = ctx.store.get("work_item", String(a.work_item_id));
    wf.setWorkItemDependencies(
      String(a.work_item_id), [], Number(cur.version), "op");
    const wds = wdsOf(ctx, String(a.work_item_id))!;
    expect(wds).not.toBeNull();
    expect(String(wds.state)).toBe("COMMITTED");
    expect(wds.active_edge_ids).toEqual([]);
    expect(wds.dependency_work_item_ids).toEqual([]);
    expect(Number(wds.revision)).toBe(2);
    // canonical authority still passes + proves the empty set
    expect(() => biz.assertGraphAuthority(ctx.store.get("work_item", String(a.work_item_id))))
      .not.toThrow();
    expect(() => biz.assertDependenciesSatisfied(ctx.store.get("work_item", String(a.work_item_id))))
      .not.toThrow();
  });

  it("WFV2-P1-R2-DELEGATE-CONTRACT-WIDEN-AFTER-COMMIT: open fails when delegatee widened", () => {
    const { ctx, biz, wf } = makeStack("r2-del-widen-open");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    // ceiling snapshot persisted on the WDEL row
    const del = ctx.store.get("work_delegation", `WDEL_${child.work_item_id}`);
    expect(String(del.authority_ceiling_agent)).toBe(String(lead.agent_id));
    expect(del.authority_ceiling).not.toBeNull();
    expect(String(del.authority_ceiling_digest ?? "")).not.toBe("");
    // widening the delegatee's contract AFTER commit must not expand the
    // stored child ceiling — open fails before any mission is created.
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS", "NETWORK_ACCESS"] });
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect((ctx.store.get("work_item", String(child.work_item_id))
      .mission_ids as string[] | undefined) ?? []).toHaveLength(0);
  });

  it("WFV2-P1-R2-PARENT-NARROW-AFTER-COMMIT: current parent narrowing applies at open", () => {
    const { ctx, biz, wf } = makeStack("r2-parent-narrow");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    // parent loses FILE_OPERATIONS later — child must narrow too, never
    // keep authority the parent no longer holds.
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["SELF_MODIFY_CODE"] });
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
  });

  it("WFV2-P1-R2-DECOMPOSE-CONTRACT-WIDEN-AFTER-COMMIT: open fails when assignee widened", () => {
    const { ctx, biz, wf } = makeStack("r2-dec-widen-open");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const worker = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(worker.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R2",
      children: [{ title: "c", goal: "g", assignee_agent_id: String(worker.agent_id) }],
    }, "op");
    const child = r.children[0];
    // proposal carries the persisted ceiling + the child has a manifest
    const dec = ctx.store.get("work_decomposition", `WDEC_${p.work_item_id}`);
    const proposal = dec.proposal as Record<string, unknown>;
    expect(String(proposal.authority_ceiling_agent)).toBe(String(lead.agent_id));
    expect(proposal.authority_ceiling).not.toBeNull();
    expect(wdsOf(ctx, String(child.work_item_id))).not.toBeNull();
    biz.upsertAgentContract(String(worker.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS", "BROWSER_USE"] });
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
  });

  it("WFV2-P1-R2-DISABLED-CONTRACT-ADMISSION: DISABLED contract usable for nothing new", () => {
    const { ctx, biz, wf } = makeStack("r2-disabled-contract");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    // provenance stays, but a DISABLED contract can never admit a new
    // mission — open fails before binding.
    biz.setAgentContractStatus(String(to.agent_id), "DISABLED", "op");
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
    // new delegation to a disabled-contract agent fails at admission
    const to2 = makeAgent(biz, String(b.business_id), "intern");
    biz.upsertAgentContract(String(to2.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.setAgentContractStatus(String(to2.agent_id), "DISABLED", "op");
    const p2 = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p2.work_item_id),
        delegated_by_agent_id: String(lead.agent_id),
        delegated_to_agent_id: String(to2.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
    // decomposition direct-assign to a disabled-contract agent also fails
    const p3 = makeItem(biz, String(b.business_id), { title: "p3" });
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p3.work_item_id), {
        decomposition_id: "DEC-DIS",
        children: [{ title: "c", goal: "g", assignee_agent_id: String(to2.agent_id) }],
      }, "op"),
    )).toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
  });

  it("WFV2-P1-R2-DECOMP-DEP-MUTATION-REJECTED: WDEC child topology immutable, no quarantine", () => {
    const { ctx, biz, wf } = makeStack("r2-immutable");
    const b = makeBiz(biz, ctx.projectId);
    const p = makeItem(biz, String(b.business_id), { title: "P" });
    const other = makeItem(biz, String(b.business_id), { title: "other" });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-IMM",
      children: [
        { title: "c1", goal: "g" },
        { title: "c2", goal: "g", depends_on_indices: [0] },
      ],
    }, "op");
    const child = r.children[0];
    const cur = ctx.store.get("work_item", String(child.work_item_id));
    expect(errCode(() =>
      wf.setWorkItemDependencies(
        String(child.work_item_id), [String(other.work_item_id)], Number(cur.version), "op"),
    )).toBe("FAIL_CLOSED_WORK_DECOMPOSITION_TOPOLOGY_IMMUTABLE");
    // rejected operation produced NO quarantine and NO partial writes
    expect(String(
      ctx.store.get("work_item", String(child.work_item_id)).blocked_code ?? "null",
    )).toBe("null");
    const wds = wdsOf(ctx, String(child.work_item_id))!;
    expect(wds.dependency_work_item_ids).toEqual([]);
    // the spec's canonical sibling edge is intact on c2
    const wds2 = wdsOf(ctx, String(r.children[1].work_item_id))!;
    expect(wds2.dependency_work_item_ids).toEqual([String(child.work_item_id)]);
  });

  it("WFV2-P1-R2-DELEGATED-DEP-MUTATION-HAPPY: delegated child deps mutable + manifest updates", () => {
    const { ctx, biz, wf } = makeStack("r2-del-dep-happy");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    // delegated children start with a canonical EMPTY manifest
    const wds0 = wdsOf(ctx, String(child.work_item_id))!;
    expect(wds0.dependency_work_item_ids).toEqual([]);
    const dep = makeItem(biz, String(b.business_id), { title: "dep" });
    const cur = ctx.store.get("work_item", String(child.work_item_id));
    wf.setWorkItemDependencies(
      String(child.work_item_id), [String(dep.work_item_id)], Number(cur.version), "op");
    const wds = wdsOf(ctx, String(child.work_item_id))!;
    expect(Number(wds.revision)).toBe(2);
    expect(wds.dependency_work_item_ids).toEqual([String(dep.work_item_id)]);
    expect(wf.dependenciesProven(ctx.store.get("work_item", String(child.work_item_id))))
      .toBe(false);
    expect(() => biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))))
      .not.toThrow();
  });

  it("WFV2-P1-R2-RESTART: manifests + ceilings survive restart; tamper quarantines", () => {
    const { ctx, biz, wf, dir } = makeStack("r2-restart");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    const second = reopenStack(dir);
    expect(second.wf.reconcileWorkGraph().quarantined).toEqual([]);
    const wds = second.ctx.store.tryGet(
      "work_dependency_set", `WDS_${child.work_item_id}`) as Record<string, unknown> | null;
    expect(wds).not.toBeNull();
    const del = second.ctx.store.get("work_delegation", `WDEL_${child.work_item_id}`);
    expect(del.authority_ceiling).not.toBeNull();
    // tamper the manifest digest on the reopened stack — reconcile must
    // quarantine the work item, never silently rebuild the manifest.
    const cur = second.ctx.store.get("work_dependency_set", `WDS_${child.work_item_id}`);
    second.ctx.store.put("work_dependency_set", `WDS_${child.work_item_id}`,
      { ...cur, dependency_set_digest: "deadbeef" }, Number(cur.version));
    expect(second.wf.reconcileWorkGraph().quarantined)
      .toEqual([String(child.work_item_id)]);
  });
});

// ---------------------------------------------------------------------
// R3 — graph assignee immutability + ceiling-agent executability
// ---------------------------------------------------------------------

describe("P14 WFV2-P1 R3 — assignee immutability + ceiling executability", () => {
  it("WFV2-P1-R3-DELEGATED-CHILD-REASSIGN-REJECT: generic assign cannot rewrite a delegated child", () => {
    const { ctx, biz, wf } = makeStack("r3-del-child-reassign");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const other = makeAgent(biz, String(b.business_id), "other");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    expect(errCode(() =>
      biz.assignWorkItem(String(child.work_item_id), String(other.agent_id), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
    const cur = ctx.store.get("work_item", String(child.work_item_id));
    expect(String(cur.assignee_agent_id)).toBe(String(to.agent_id));
    expect(String(cur.blocked_code ?? "")).toBe(""); // rejection, not quarantine
    expect(() => biz.assertGraphAuthority(cur)).not.toThrow(); // WDEL still valid
  });

  it("WFV2-P1-R3-DECOMPOSED-CHILD-REASSIGN-REJECT: generic assign cannot rewrite a decomposed child", () => {
    const { ctx, biz, wf } = makeStack("r3-dec-child-reassign");
    const b = makeBiz(biz, ctx.projectId);
    const ag = makeAgent(biz, String(b.business_id), "lead");
    const other = makeAgent(biz, String(b.business_id), "other");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: ag.agent_id });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-R3",
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(ag.agent_id) },
        { title: "c2", goal: "g2" },
      ],
    }, "op");
    const childId = String(r.children[0].work_item_id);
    expect(errCode(() =>
      biz.assignWorkItem(childId, String(other.agent_id), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
    const cur = ctx.store.get("work_item", childId);
    expect(String(cur.assignee_agent_id)).toBe(String(ag.agent_id));
    expect(String(cur.blocked_code ?? "")).toBe("");
    expect(() => biz.assertGraphAuthority(cur)).not.toThrow(); // WDEC still valid
  });

  it("WFV2-P1-R3-GRAPH-PARENT-REASSIGN-REJECT: committed ceiling source parent cannot change assignee", () => {
    const { ctx, biz, wf } = makeStack("r3-parent-reassign");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const other = makeAgent(biz, String(b.business_id), "other");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    expect(errCode(() =>
      biz.assignWorkItem(String(p.work_item_id), String(other.agent_id), "op"),
    )).toBe("FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
    const cur = ctx.store.get("work_item", String(p.work_item_id));
    expect(String(cur.assignee_agent_id)).toBe(String(lead.agent_id));
    expect(String(cur.blocked_code ?? "")).toBe("");
    // child provenance remains provable — the rejected write never landed.
    expect(() => biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))))
      .not.toThrow();
  });

  it("WFV2-P1-R3-STANDALONE-ASSIGN-HAPPY: non-graph item assigns and reassigns normally", () => {
    const { ctx, biz } = makeStack("r3-standalone");
    const b = makeBiz(biz, ctx.projectId);
    const a1 = makeAgent(biz, String(b.business_id), "lead");
    const a2 = makeAgent(biz, String(b.business_id), "worker");
    const w = makeItem(biz, String(b.business_id));
    biz.assignWorkItem(String(w.work_item_id), String(a1.agent_id), "op");
    biz.assignWorkItem(String(w.work_item_id), String(a2.agent_id), "op");
    expect(String(ctx.store.get("work_item", String(w.work_item_id)).assignee_agent_id))
      .toBe(String(a2.agent_id));
  });

  it("WFV2-P1-R3-PAUSED-PARENT-DELEGATE-REJECT: PAUSED ceiling agent fails new delegation admission", () => {
    const { ctx, biz, wf } = makeStack("r3-paused-delegate");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    expect(errCode(() =>
      wf.delegateWorkItem({
        work_item_id: String(p.work_item_id),
        delegated_to_agent_id: String(to.agent_id),
      }, "op"),
    )).toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(ctx.store.list("work_delegation")).toHaveLength(0);
    expect(ctx.store.list("work_item")).toHaveLength(1);
  });

  it("WFV2-P1-R3-PAUSED-PARENT-DECOMPOSE-REJECT: PAUSED ceiling agent fails new decomposition admission", () => {
    const { ctx, biz, wf } = makeStack("r3-paused-decompose");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const worker = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    expect(errCode(() =>
      wf.decomposeWorkItem(String(p.work_item_id), {
        decomposition_id: "DEC-PAUSED",
        children: [{ title: "c", goal: "g", assignee_agent_id: String(worker.agent_id) }],
      }, "op"),
    )).toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(ctx.store.list("work_decomposition")).toHaveLength(0);
    expect(ctx.store.list("work_item")).toHaveLength(1);
  });

  it("WFV2-P1-R3-PARENT-PAUSED-AFTER-COMMIT: ceiling agent paused later fails child open", () => {
    const { ctx, biz, wf } = makeStack("r3-paused-after-commit");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_INACTIVE");
    const cur = ctx.store.get("work_item", String(child.work_item_id));
    expect(((cur.mission_ids as string[] | undefined) ?? [])).toHaveLength(0);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
  });

  it("WFV2-P1-R3-PARENT-CONTRACT-DISABLED-AFTER-COMMIT: disabled ceiling contract fails child open", () => {
    const { ctx, biz, wf } = makeStack("r3-contract-disabled");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    biz.setAgentContractStatus(String(lead.agent_id), "DISABLED", "op");
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
    const cur = ctx.store.get("work_item", String(child.work_item_id));
    expect(((cur.mission_ids as string[] | undefined) ?? [])).toHaveLength(0);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
  });

  it("WFV2-P1-R3-OPERATOR-ASSIGNED-PARENT-CEILING: OPERATOR delegation binds parent assignee as ceiling", () => {
    const { ctx, biz, wf } = makeStack("r3-operator-ceiling");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    // OPERATOR mode: no delegated_by_agent_id — the parent's canonical
    // assignee still supplies the persisted ceiling identity.
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    const del = ctx.store.get("work_delegation", `WDEL_${child.work_item_id}`);
    expect(String(del.delegation_mode)).toBe("OPERATOR");
    expect(String(del.authority_ceiling_agent)).toBe(String(lead.agent_id));
    expect(del.authority_ceiling).not.toBeNull();
    // the validator proves the relation, and open applies that exact ceiling
    expect(() => biz.assertGraphAuthority(ctx.store.get("work_item", String(child.work_item_id))))
      .not.toThrow();
    const opened = biz.openWorkItem(String(child.work_item_id), "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
    const mission = ctx.store.get("mission", String(opened.mission_ids[0]));
    expect(String(mission.bound_open_id ?? "")).not.toBe("");
  });
});

  const wgmId = (id: string) => `WGM_${id}`;
  const expectCorrupt = (ctx: Ctx, id: string) =>
    expect(String(ctx.store.get("work_item", id).blocked_code ?? ""))
      .toBe("TERMINAL_PROVENANCE_CORRUPT");
  const wabId = (id: string) => `WAB_${id}`;
  const putVersioned = (
    ctx: Ctx, table: string, key: string, row: Record<string, unknown>,
  ) => {
    const cur = ctx.store.get(table, key);
    ctx.store.put(table, key, { ...row, version: Number(cur.version) }, Number(cur.version));
  };
  const makeTwo = (ctx: Ctx, biz: BusinessLayer, b: Record<string, unknown>) => {
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const to = makeAgent(biz, String(b.business_id), "worker");
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS"] });
    return { lead, to };
  };
  const delegatedChild = (ctx: Ctx, biz: BusinessLayer, wf: WorkforceService, b: Record<string, unknown>, lead: Record<string, unknown>, to: Record<string, unknown>) => {
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op");
    return { p, child };
  };

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 REBASELINE — bidirectional membership + anchored ceiling", () => {

  it("P14RB-P1-DELEGATED-MARKERS-REMOVED: deleted mirrors never degrade a governed child to standalone", () => {
    const { ctx, biz, wf } = makeStack("rb-del-markers");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    // wipe the mutable mirror fields — the inverse-provenance omission
    const cur = ctx.store.get("work_item", childId);
    ctx.store.put("work_item", childId, {
      ...cur,
      parent_work_item_id: null,
      delegated_from_work_item_id: null,
      delegated_by_agent_id: null,
      delegation_key: null,
      delegation_reason: null,
      delegation_depth: 0,
      version: Number(cur.version),
    }, Number(cur.version));
    // never standalone: every authority path fails closed
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
    expect(wf.reconcileWorkGraph().quarantined.length).toBeGreaterThanOrEqual(0);
    // canonical WDEL + WGM still prove governance — nothing was rebuilt
    // from the (now empty) mirror fields.
    expect(ctx.store.get("work_delegation", `WDEL_${childId}`)).toBeTruthy();
    expect(String(ctx.store.get("work_graph_membership", wgmId(childId)).membership_type))
      .toBe("DELEGATED_CHILD");
  });

  it("P14RB-P1-DECOMPOSED-MARKERS-REMOVED: deleted decomposition markers never degrade a child", () => {
    const { ctx, biz, wf } = makeStack("rb-dec-markers");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    const { children } = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "dec-rb",
      children: [{ title: "c1", goal: "g1", assignee_agent_id: String(to.agent_id) }],
    }, "op");
    const childId = String(children[0]!.work_item_id);
    const cur = ctx.store.get("work_item", childId);
    ctx.store.put("work_item", childId, {
      ...cur,
      parent_work_item_id: null,
      decomposition_id: null,
      version: Number(cur.version),
    }, Number(cur.version));
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
    expect(String(ctx.store.get("work_graph_membership", wgmId(childId)).membership_type))
      .toBe("DECOMPOSED_CHILD");
  });

  it("P14RB-P1-WGM-MISSING: canonical rows without membership fail closed", () => {
    const { ctx, biz, wf } = makeStack("rb-wgm-missing");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    // physically remove the membership row — WDEL/WDS/WAB remain
    ctx.store.db.prepare(
      "DELETE FROM entities WHERE entity_type='work_graph_membership' AND entity_id=?",
    ).run(wgmId(childId));
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-P1-WGM-FORGED-STANDALONE: a recomputed standalone membership cannot erase governance", () => {
    const { ctx, biz, wf } = makeStack("rb-wgm-forged");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wgm = ctx.store.get("work_graph_membership", wgmId(childId));
    // forger rewrites membership as STANDALONE and recomputes its digest —
    // even a self-consistent forged row cannot erase canonical authority.
    const forgedFields = {
      membership_type: "STANDALONE",
      parent_work_item_id: null,
      delegation_id: null,
      decomposition_row_id: null,
      dependency_set_id: null,
      authority_binding_id: null,
    };
    putVersioned(ctx, "work_graph_membership", wgmId(childId), {
      ...wgm,
      ...forgedFields,
      membership_digest: membershipDigest(
        childId, String(b.business_id), ctx.projectId, forgedFields),
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-P1-WORK-ITEM-FORGED-GRAPH: painted graph markers on a standalone item fail closed", () => {
    const { ctx, biz, wf } = makeStack("rb-wi-forged");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { p } = delegatedChild(ctx, biz, wf, b, lead, to);
    const item = makeItem(biz, String(b.business_id), { assignee_agent_id: to.agent_id });
    const itemId = String(item.work_item_id);
    // paint delegation mirrors onto a genuinely standalone item
    const cur = ctx.store.get("work_item", itemId);
    ctx.store.put("work_item", itemId, {
      ...cur,
      parent_work_item_id: String(p.work_item_id),
      delegated_from_work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegation_key: "painted",
      delegation_depth: 1,
      version: Number(cur.version),
    }, Number(cur.version));
    expect(errCode(() => biz.openWorkItem(itemId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, itemId);
  });

  it("P14RB-P1-CEILING-SNAPSHOT-TAMPER-REHASH: rehashed broader snapshot cannot expand the ceiling", () => {
    const { ctx, biz, wf } = makeStack("rb-snap-tamper");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    // tamper: broaden the snapshot AND recompute every local digest —
    // the anchored revision + provenance cross-check still catch it.
    const snapshot = {
      ...(wab.authority_snapshot as Record<string, unknown>),
      capabilities: [
        ...((wab.authority_snapshot as { capabilities: string[] }).capabilities),
        "NETWORK_ACCESS",
      ],
    };
    const snapshotDigest = authorityCeilingDigest(snapshot as never);
    putVersioned(ctx, "work_authority_binding", wabId(childId), {
      ...wab,
      authority_snapshot: snapshot,
      authority_snapshot_digest: snapshotDigest,
      binding_digest: authorityBindingDigest({
        work_item_id: childId,
        ceiling_agent_id: String(wab.ceiling_agent_id),
        agent_business_id: String(wab.agent_business_id),
        contract_id: String(wab.contract_id),
        contract_version: Number(wab.contract_version),
        contract_digest: String(wab.contract_digest),
        authority_snapshot_digest: snapshotDigest,
      }),
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-P1-CEILING-CONTRACT-ID-FORGE: a foreign contract id cannot anchor the ceiling", () => {
    const { ctx, biz, wf } = makeStack("rb-cid-forge");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    const foreign = biz.agentContracts.resolve(String(to.agent_id)).contract;
    // point the anchor at ANOTHER agent's contract, carrying its real
    // digest, and recompute the binding digest — the revision anchor
    // still binds org_agent_id/business and rejects it.
    const snapshotDigest = String(wab.authority_snapshot_digest);
    putVersioned(ctx, "work_authority_binding", wabId(childId), {
      ...wab,
      contract_id: String(foreign.contract_id),
      contract_version: Number(foreign.contract_version),
      contract_digest: String(foreign.contract_digest),
      binding_digest: authorityBindingDigest({
        work_item_id: childId,
        ceiling_agent_id: String(wab.ceiling_agent_id),
        agent_business_id: String(wab.agent_business_id),
        contract_id: String(foreign.contract_id),
        contract_version: Number(foreign.contract_version),
        contract_digest: String(foreign.contract_digest),
        authority_snapshot_digest: snapshotDigest,
      }),
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-P1-CEILING-CONTRACT-VERSION-FORGE: a missing or rewound revision cannot anchor the ceiling", () => {
    const { ctx, biz, wf } = makeStack("rb-ver-forge");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    const pinnedV = Number(wab.contract_version);
    // case A — a version that never existed: no revision evidence at all.
    putVersioned(ctx, "work_authority_binding", wabId(childId), {
      ...wab,
      contract_version: pinnedV + 50,
      binding_digest: authorityBindingDigest({
        work_item_id: childId,
        ceiling_agent_id: String(wab.ceiling_agent_id),
        agent_business_id: String(wab.agent_business_id),
        contract_id: String(wab.contract_id),
        contract_version: pinnedV + 50,
        contract_digest: String(wab.contract_digest),
        authority_snapshot_digest: String(wab.authority_snapshot_digest),
      }),
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // case B — rewind to a REAL earlier revision whose narrower policy
    // can never have produced the persisted snapshot. Widen the ceiling
    // contract (v2) and delegate a fresh child so its binding pins v2.
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS", "NETWORK_ACCESS"] });
    const v2 = biz.agentContracts.resolve(String(lead.agent_id)).contract;
    const curV = Number(v2.contract_version);
    const child2 = wf.delegateWorkItem({
      work_item_id: String(child.parent_work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
      delegation_key: "rewind-check",
    }, "op");
    const child2Id = String(child2.work_item_id);
    const wab3 = ctx.store.get("work_authority_binding", wabId(child2Id));
    expect(Number(wab3.contract_version)).toBe(curV);
    const prevRev = ctx.store.get(
      "agent_contract_revision", `ACR_${String(v2.contract_id)}_${curV - 1}`);
    expect(prevRev).not.toBeNull();
    // rewind: previous REAL revision + its real digest + recomputed
    // binding digest — the wider snapshot can never have come from the
    // narrower pinned policy, so the anchor chain rejects it.
    putVersioned(ctx, "work_authority_binding", wabId(child2Id), {
      ...wab3,
      contract_version: curV - 1,
      contract_digest: String(prevRev.contract_digest),
      binding_digest: authorityBindingDigest({
        work_item_id: child2Id,
        ceiling_agent_id: String(wab3.ceiling_agent_id),
        agent_business_id: String(wab3.agent_business_id),
        contract_id: String(wab3.contract_id),
        contract_version: curV - 1,
        contract_digest: String(prevRev.contract_digest),
        authority_snapshot_digest: String(wab3.authority_snapshot_digest),
      }),
    });
    expect(errCode(() => biz.openWorkItem(child2Id, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("P14RB-P1-CEILING-CONTRACT-DIGEST-FORGE: an off-revision digest cannot anchor the ceiling", () => {
    const { ctx, biz, wf } = makeStack("rb-digest-forge");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    putVersioned(ctx, "work_authority_binding", wabId(childId), {
      ...wab,
      contract_digest: "deadbeef".repeat(8),
      binding_digest: authorityBindingDigest({
        work_item_id: childId,
        ceiling_agent_id: String(wab.ceiling_agent_id),
        agent_business_id: String(wab.agent_business_id),
        contract_id: String(wab.contract_id),
        contract_version: Number(wab.contract_version),
        contract_digest: "deadbeef".repeat(8),
        authority_snapshot_digest: String(wab.authority_snapshot_digest),
      }),
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-P1-PARENT-WIDEN-AFTER-COMMIT: widened parent contract never expands the anchored ceiling", () => {
    const { ctx, biz, wf } = makeStack("rb-widen");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    // widen the child's contract past the anchored ceiling → open fails
    // before binding/mission, exactly like the persisted snapshot did.
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: ["FILE_OPERATIONS", "NETWORK_ACCESS"] });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect((ctx.store.get("work_item", childId).mission_ids as string[] | undefined) ?? [])
      .toHaveLength(0);
  });

  it("P14RB-P1-PARENT-NARROW-AFTER-COMMIT: narrowed ceiling narrows the child at open", () => {
    const { ctx, biz, wf } = makeStack("rb-narrow");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: ["SELF_MODIFY_CODE"] });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 R1 — historical authority anchors", () => {
  /** Recompute both WAB local digests after a snapshot tamper — the
   *  sophisticated forger that self-consistent hashing alone cannot
   *  catch; only the WORK_AUTHORITY_BOUND event anchor does. */
  const forgeWab = (
    ctx: Ctx,
    workItemId: string,
    mutate: (snap: Record<string, unknown>) => void,
  ) => {
    const key = wabId(workItemId);
    const cur = ctx.store.get("work_authority_binding", key);
    const forged = JSON.parse(JSON.stringify(cur)) as Record<string, unknown>;
    const snap = forged.authority_snapshot as Record<string, unknown>;
    mutate(snap);
    for (const k of ["capabilities", "executors", "routes", "projects", "context_scopes"]) {
      if (Array.isArray(snap[k])) (snap[k] as string[]).sort();
    }
    forged.authority_snapshot_digest = authorityCeilingDigest(snap as never);
    forged.binding_digest = authorityBindingDigest({
      work_item_id: String(forged.work_item_id),
      ceiling_agent_id: String(forged.ceiling_agent_id),
      agent_business_id: String(forged.agent_business_id),
      contract_id: String(forged.contract_id),
      contract_version: Number(forged.contract_version),
      contract_digest: String(forged.contract_digest),
      authority_snapshot_digest: String(forged.authority_snapshot_digest),
    });
    ctx.store.put(
      "work_authority_binding", key,
      { ...forged, version: cur.version }, cur.version,
    );
  };

  it("P14RB-R1-ACR-POLICY-TAMPER: mutated revision.policy with unchanged digest fails open", () => {
    const { ctx, biz, wf } = makeStack("acr-pol-tamper");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const contract = biz.getAgentContract(String(lead.agent_id));
    const key = contractRevisionRowId(
      String(contract!.contract_id), Number(contract!.contract_version));
    const acr = ctx.store.get("agent_contract_revision", key);
    // Tamper ONLY the policy payload; leave contract_digest untouched —
    // the recomputed digest can never match a policy it no longer covers.
    const pol = JSON.parse(JSON.stringify(acr.policy)) as Record<string, unknown>;
    pol.allowed_capabilities = ["SELF_MODIFY_CODE"];
    putVersioned(ctx, "agent_contract_revision", key, { ...acr, policy: pol });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("P14RB-R1-UNBOUNDED-CAP-DENY-TAMPER: null allow + deny closes over forged snapshot", () => {
    const { ctx, biz, wf } = makeStack("cap-deny");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_capabilities: null, denied_capabilities: ["NETWORK_ACCESS"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_capabilities: null, denied_capabilities: ["NETWORK_ACCESS"] });
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    const snap = wab.authority_snapshot as { capabilities: string[] };
    expect(snap.capabilities).not.toContain("NETWORK_ACCESS");
    forgeWab(ctx, childId, (s) => {
      (s.capabilities as string[]).push("NETWORK_ACCESS");
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("P14RB-R1-UNBOUNDED-EXECUTOR-DENY-TAMPER: denied executor never re-enters snapshot", () => {
    const { ctx, biz, wf } = makeStack("exec-deny");
    const b = makeBiz(biz, ctx.projectId);
    ctx.service.registerExecutor({
      executor_id: "EX_DENIED", executor_kind: "IN_PROCESS", health_state: "HEALTHY",
    });
    const { lead, to } = makeTwo(ctx, biz, b);
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { allowed_executor_ids: null, denied_executor_ids: ["EX_DENIED"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { allowed_executor_ids: null, denied_executor_ids: ["EX_DENIED"] });
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    expect((wab.authority_snapshot as { executors: string[] }).executors)
      .not.toContain("EX_DENIED");
    forgeWab(ctx, childId, (s) => {
      (s.executors as string[]).push("EX_DENIED");
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-R1-ROUTE-DENY-TAMPER: canonical preferred/denied/fallback only", () => {
    const { ctx, biz, wf } = makeStack("route-deny");
    const b = makeBiz(biz, ctx.projectId);
    ctx.service.routes.registerRoute({
      route_id: "RTE_DENIED", route_kind: "IN_PROCESS_RUNTIME", enabled: true,
      eligibility_state: "QUALIFIED", qualification_state: "QUALIFIED",
      direct_callable: true, capabilities: ["FILE_OPERATIONS"], priority: 10,
    });
    const { lead, to } = makeTwo(ctx, biz, b);
    biz.upsertAgentContract(String(lead.agent_id), "op",
      { denied_route_ids: ["RTE_DENIED"] });
    biz.upsertAgentContract(String(to.agent_id), "op",
      { denied_route_ids: ["RTE_DENIED"] });
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    const wab = ctx.store.get("work_authority_binding", wabId(childId));
    expect((wab.authority_snapshot as { routes: string[] }).routes)
      .not.toContain("RTE_DENIED");
    forgeWab(ctx, childId, (s) => {
      (s.routes as string[]).push("RTE_DENIED");
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
  });

  it("P14RB-R1-DYNAMIC-CAPABILITY-AFTER-COMMIT: late capability never retro-expands", () => {
    const { ctx, biz, wf } = makeStack("dyn-cap");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    biz.upsertAgentContract(String(lead.agent_id), "op", { allowed_capabilities: null });
    biz.upsertAgentContract(String(to.agent_id), "op", { allowed_capabilities: null });
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    ctx.service.registerCapability("LATE_CAP_X", { risk_class: "LOW" });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    // Policy failure, not corruption — no quarantine.
    expect(String(ctx.store.get("work_item", childId).blocked_code ?? ""))
      .not.toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(ctx.store.list("mission")).toHaveLength(0);
  });

  it("P14RB-R1-DYNAMIC-EXECUTOR-AFTER-COMMIT: late executor never retro-expands", () => {
    const { ctx, biz, wf } = makeStack("dyn-exec");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    ctx.service.registerExecutor({
      executor_id: "EX_LATE", executor_kind: "IN_PROCESS", health_state: "HEALTHY",
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect(String(ctx.store.get("work_item", childId).blocked_code ?? ""))
      .not.toBe("TERMINAL_PROVENANCE_CORRUPT");
  });

  it("P14RB-R1-DYNAMIC-ROUTE-AFTER-COMMIT: late route never retro-expands", () => {
    const { ctx, biz, wf } = makeStack("dyn-route");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    ctx.service.routes.registerRoute({
      route_id: "RTE_LATE", route_kind: "IN_PROCESS_RUNTIME", enabled: true,
      eligibility_state: "QUALIFIED", qualification_state: "QUALIFIED",
      direct_callable: true, capabilities: ["FILE_OPERATIONS"], priority: 10,
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_AUTHORITY_WIDEN");
    expect(String(ctx.store.get("work_item", childId).blocked_code ?? ""))
      .not.toBe("TERMINAL_PROVENANCE_CORRUPT");
  });

  it("P14RB-R1-WAB-REHASH-HISTORICAL-EVENT: policy-consistent rehash still fails at the anchor", () => {
    const { ctx, biz, wf } = makeStack("wab-rehash");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    biz.upsertAgentContract(String(lead.agent_id), "op", { allowed_capabilities: null });
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const childId = String(child.work_item_id);
    // Forge a NARROWER snapshot — still ⊆ the pinned policy, so the
    // pre-R1 self-hash checks would have passed it; only the immutable
    // WORK_AUTHORITY_BOUND event keeps the original digests.
    forgeWab(ctx, childId, (s) => {
      s.capabilities = (s.capabilities as string[]).filter((c) => c !== "NETWORK_ACCESS");
    });
    expect(errCode(() => biz.openWorkItem(childId, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expectCorrupt(ctx, childId);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
  });

  it("P14RB-R1-LEGACY-CURRENT-CONTRACT-BACKFILL: pre-ACR contract backfills exact current revision", () => {
    const { ctx, biz, wf } = makeStack("legacy-backfill");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const contract = biz.getAgentContract(String(lead.agent_id));
    // Simulate the pre-R1 world: valid contract + journal, no ACR rows.
    ctx.store.db.prepare(
      "DELETE FROM entities WHERE entity_type = 'agent_contract_revision'",
    ).run();
    expect(ctx.store.list("agent_contract_revision")).toHaveLength(0);
    const { child } = delegatedChild(ctx, biz, wf, b, lead, to);
    const backfilled = ctx.store.get("agent_contract_revision",
      contractRevisionRowId(String(contract!.contract_id),
        Number(contract!.contract_version)));
    expect(String(backfilled.contract_digest)).toBe(String(contract!.contract_digest));
    expect(String(backfilled.state)).toBe("COMMITTED");
    const childId = String(child.work_item_id);
    const opened = biz.openWorkItem(childId, "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
    expect((opened.mission_ids as string[]).length).toBe(1);
    expect(ctx.store.list("work_authority_binding")).toHaveLength(1);
  });

  it("P14RB-R1-LEGACY-CONFLICTING-ACR: conflicting revision fails closed, never overwritten", () => {
    const { ctx, biz, wf } = makeStack("legacy-conflict");
    const b = makeBiz(biz, ctx.projectId);
    const { lead, to } = makeTwo(ctx, biz, b);
    const contract = biz.getAgentContract(String(lead.agent_id));
    const key = contractRevisionRowId(
      String(contract!.contract_id), Number(contract!.contract_version));
    const acr = ctx.store.get("agent_contract_revision", key);
    // A self-consistent row over a DIFFERENT policy — its own digest is
    // honest but is not the contract's pinned digest.
    const pol = JSON.parse(JSON.stringify(acr.policy)) as Record<string, unknown>;
    pol.denied_capabilities = ["NETWORK_ACCESS"];
    const forgedDigest = contractDigest({
      contract_id: String(acr.contract_id),
      org_agent_id: String(acr.org_agent_id),
      business_id: String(acr.business_id),
      contract_version: Number(acr.contract_version),
      policy: pol as never,
    });
    putVersioned(ctx, "agent_contract_revision", key,
      { ...acr, policy: pol, contract_digest: forgedDigest });
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: lead.agent_id });
    expect(errCode(() => wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_by_agent_id: String(lead.agent_id),
      delegated_to_agent_id: String(to.agent_id),
    }, "op"))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // Never overwritten, never rebuilt.
    const after = ctx.store.get("agent_contract_revision", key);
    expect(String(after.contract_digest)).toBe(forgedDigest);
    expect(ctx.store.list("work_delegation")).toHaveLength(0);
    expect(ctx.store.list("work_authority_binding")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------

describe("P14 WFV2-P1 R2 — contract revision crash atomicity", () => {
  const reopen = (dir: string) =>
    new PairEvidenceStore(path.join(dir, "pair.db"));
  const acrRows = (store: PairEvidenceStore, cid?: string) =>
    store.list("agent_contract_revision")
      .filter((r) => cid === undefined || String(r.contract_id) === cid);
  const contractEvents = (store: PairEvidenceStore, cid: string) =>
    store.listEvents("agent_execution_contract", cid);
  const contractFor = (store: PairEvidenceStore, agentId: string) =>
    store.list("agent_execution_contract")
      .find((c) => String(c.org_agent_id) === agentId);

  it("P14RB-R2-MATERIALIZE-CRASH-BEFORE-ACR: rollback leaves nothing", () => {
    const { ctx, biz, dir } = makeStack("mat-crash-acr");
    const b = makeBiz(biz, ctx.projectId);
    const put = ctx.store.put.bind(ctx.store);
    (ctx.store as { put: typeof put }).put = (t, id, r, v) => {
      if (t === "agent_contract_revision") throw new Error("INJECTED_CRASH");
      return put(t, id, r, v);
    };
    // Crash inside createOrgAgent's baseline materialize (ACR seam).
    expect(errCode(() => makeAgent(biz, String(b.business_id), "lead")))
      .not.toBe("NO_ERROR");
    (ctx.store as { put: typeof put }).put = put;
    // Reopen: the failed revision left nothing — no contract row, no
    // ACR, no contract journal event. (The org_agent row may remain —
    // a contract materializes lazily on first resolve, by design.)
    const s = reopen(dir);
    expect(s.list("agent_execution_contract")).toHaveLength(0);
    expect(acrRows(s)).toHaveLength(0);
    expect(s.listEvents().filter((e) =>
      String(e.event_type).includes("AGENT_EXECUTION_CONTRACT"))).toHaveLength(0);
    // After the crash a fresh agent materializes cleanly.
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const c = biz.upsertAgentContract(
      String(agent.agent_id), "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    assertCanonicalContractRevision(ctx.store,
      ctx.store.get("agent_contract_revision",
        contractRevisionRowId(String(c.contract_id), Number(c.contract_version))));
  });

  it("P14RB-R2-MATERIALIZE-CRASH-BEFORE-EVENT: materialize itself rolls back", () => {
    const { ctx, biz, dir } = makeStack("mat-crash-evt");
    const b = makeBiz(biz, ctx.projectId);
    const ev = ctx.store.event.bind(ctx.store);
    (ctx.store as { event: typeof ev }).event = (p) => {
      if (String(p.event_type) === "AGENT_EXECUTION_CONTRACT_MATERIALIZED") {
        throw new Error("INJECTED_CRASH");
      }
      return ev(p);
    };
    // Crash inside createOrgAgent's baseline materialize seam.
    expect(errCode(() => makeAgent(biz, String(b.business_id), "lead")))
      .not.toBe("NO_ERROR");
    (ctx.store as { event: typeof ev }).event = ev;
    const s = reopen(dir);
    expect(s.list("agent_execution_contract")).toHaveLength(0);
    expect(acrRows(s)).toHaveLength(0);
    expect(s.listEvents().filter((e) =>
      String(e.event_type).includes("AGENT_EXECUTION_CONTRACT"))).toHaveLength(0);
  });

  it("P14RB-R2-UPDATE-CRASH-BEFORE-ACR: old complete revision stays canonical", () => {
    const { ctx, biz, dir } = makeStack("upd-crash-acr");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const agentId = String(agent.agent_id);
    const c1 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: ["FILE_OPERATIONS"] }); // v1→v2
    const v = Number(c1.version);
    const cv = Number(c1.contract_version);
    const put = ctx.store.put.bind(ctx.store);
    (ctx.store as { put: typeof put }).put = (t, id, r, vv) => {
      if (t === "agent_contract_revision") throw new Error("INJECTED_CRASH");
      return put(t, id, r, vv);
    };
    expect(errCode(() => biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, v,
    ))).not.toBe("NO_ERROR");
    (ctx.store as { put: typeof put }).put = put;
    const s = reopen(dir);
    const c = contractFor(s, agentId)!;
    expect(Number(c.version)).toBe(v);
    expect(Number(c.contract_version)).toBe(cv);
    expect(acrRows(s, String(c.contract_id))
      .map((r) => Number(r.contract_version)).sort((a, z) => a - z))
      .toEqual([1, 2]);
    // retry update on the same db commits one complete next revision
    const c2 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, v);
    expect(Number(c2.contract_version)).toBe(cv + 1);
    const s2 = reopen(dir);
    expect(acrRows(s2, String(c.contract_id))
      .map((r) => Number(r.contract_version)).sort((a, z) => a - z))
      .toEqual([1, 2, 3]);
    expect(contractEvents(s2, String(c.contract_id)).filter(
      (e) => Number(e.metadata?.contract_version) === cv + 1 &&
        String(e.event_type) === "AGENT_EXECUTION_CONTRACT_UPDATED",
    )).toHaveLength(1);
  });

  it("P14RB-R2-UPDATE-CRASH-BEFORE-EVENT: old complete revision stays canonical", () => {
    const { ctx, biz, dir } = makeStack("upd-crash-evt");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const agentId = String(agent.agent_id);
    const c1 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const v = Number(c1.version);
    const ev = ctx.store.event.bind(ctx.store);
    let injected = false;
    (ctx.store as { event: typeof ev }).event = (p) => {
      if (!injected && String(p.event_type) === "AGENT_EXECUTION_CONTRACT_UPDATED") {
        injected = true;
        throw new Error("INJECTED_CRASH");
      }
      return ev(p);
    };
    expect(errCode(() => biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, v,
    ))).not.toBe("NO_ERROR");
    (ctx.store as { event: typeof ev }).event = ev;
    const s = reopen(dir);
    const c = contractFor(s, agentId)!;
    expect(Number(c.version)).toBe(v);
    expect(Number(c.contract_version)).toBe(2);
    expect(acrRows(s, String(c.contract_id))
      .map((r) => Number(r.contract_version)).sort((a, z) => a - z))
      .toEqual([1, 2]);
    expect(contractEvents(s, String(c.contract_id)).filter(
      (e) => Number(e.metadata?.contract_version) === 3,
    )).toHaveLength(0);
  });

  it("P14RB-R2-ATOMIC-MATERIALIZE-HAPPY: baseline contract + ACR + event all exist", () => {
    const { ctx, biz } = makeStack("atomic-mat");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const c = biz.getAgentContract(String(agent.agent_id))!;
    const acr = ctx.store.get("agent_contract_revision",
      contractRevisionRowId(String(c.contract_id), 1));
    expect(String(acr.contract_digest)).toBe(String(c.contract_digest));
    assertCanonicalContractRevision(ctx.store, acr);
    const evs = contractEvents(ctx.store, String(c.contract_id));
    expect(evs.some((e) =>
      String(e.event_type) === "AGENT_EXECUTION_CONTRACT_MATERIALIZED" &&
      Number(e.metadata?.contract_version) === 1 &&
      String(e.metadata?.contract_digest) === String(c.contract_digest),
    )).toBe(true);
  });

  it("P14RB-R2-ATOMIC-UPDATE-HAPPY: vN+1 commits fully; old ACR append-only", () => {
    const { ctx, biz } = makeStack("atomic-upd");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const agentId = String(agent.agent_id);
    const c1 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const c2 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, Number(c1.version));
    expect(Number(c2.contract_version)).toBe(Number(c1.contract_version) + 1);
    const acrs = acrRows(ctx.store, String(c1.contract_id));
    expect(acrs.map((r) => Number(r.contract_version)).sort((a, z) => a - z))
      .toEqual([1, 2, 3]);
    for (const r of acrs) assertCanonicalContractRevision(ctx.store, r);
    const evs = contractEvents(ctx.store, String(c1.contract_id));
    expect(evs.some((e) =>
      String(e.event_type) === "AGENT_EXECUTION_CONTRACT_MATERIALIZED")).toBe(true);
    expect(evs.filter((e) =>
      String(e.event_type) === "AGENT_EXECUTION_CONTRACT_UPDATED")).toHaveLength(2);
  });

  it("P14RB-R2-CONFLICTING-ACR-ON-WRITE: seeded conflicting ACR fails closed, never overwritten", () => {
    const { ctx, biz } = makeStack("conflict-write");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const agentId = String(agent.agent_id);
    const c1 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const nextV = Number(c1.contract_version) + 1;
    const key = contractRevisionRowId(String(c1.contract_id), nextV);
    // Seed a conflicting ACR at the intended next version (self-consistent
    // digest over a DIFFERENT policy — a genuine conflict row).
    const pol = { allowed_capabilities: ["SELF_MODIFY_CODE"] };
    ctx.store.put("agent_contract_revision", key, {
      revision_id: key,
      contract_id: String(c1.contract_id),
      org_agent_id: agentId,
      business_id: String(c1.business_id),
      contract_version: nextV,
      contract_digest: contractDigest({
        contract_id: String(c1.contract_id),
        org_agent_id: agentId,
        business_id: String(c1.business_id),
        contract_version: nextV,
        policy: pol as never,
      }),
      policy: pol,
      status: "ACTIVE",
      state: "COMMITTED",
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    }, 0);
    const v = Number(c1.version);
    expect(errCode(() => biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, v,
    ))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // never overwritten; contract did not partially advance
    const after = ctx.store.get("agent_contract_revision", key);
    expect((after.policy as { allowed_capabilities?: string[] })
      .allowed_capabilities).toEqual(["SELF_MODIFY_CODE"]);
    const c = ctx.store.get("agent_execution_contract", String(c1.contract_id));
    expect(Number(c.contract_version)).toBe(Number(c1.contract_version));
    expect(Number(c.version)).toBe(v);
  });

  it("P14RB-R2-CONCURRENT-UPDATE: exactly one complete revision wins", () => {
    const { ctx, biz } = makeStack("conc-update");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const agentId = String(agent.agent_id);
    const c1 = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const v = Number(c1.version);
    const w = biz.upsertAgentContract(
      agentId, "op", { allowed_capabilities: null }, v);
    const loser = errCode(() => biz.upsertAgentContract(
      agentId, "op", { denied_capabilities: ["NETWORK_ACCESS"] }, v));
    expect(loser).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    const c2v = Number(w.contract_version);
    const acrs = acrRows(ctx.store, String(c1.contract_id))
      .filter((r) => Number(r.contract_version) === c2v);
    expect(acrs).toHaveLength(1); // no orphan ACR
    expect(contractEvents(ctx.store, String(c1.contract_id)).filter(
      (e) => String(e.event_type) === "AGENT_EXECUTION_CONTRACT_UPDATED" &&
        Number(e.metadata?.contract_version) === c2v,
    )).toHaveLength(1); // no orphan event
    assertCanonicalContractRevision(ctx.store, acrs[0]);
  });
});
