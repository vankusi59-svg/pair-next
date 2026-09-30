/**
 * P14 WORKFORCE V2 PHASE 3 — canonical completion authority.
 *
 * Central invariant under test: NO work item is canonically complete
 * merely because a mutable status field says DONE/COMPLETED. Completion
 * requires the `work_completion` WCP_<id> record — digest-pinned to the
 * bound COMPLETED mission and/or the canonical child set (WDEC ∪ WDEL),
 * immutably anchored by exactly one WORK_ITEM_COMPLETED event, and for
 * review-required items exactly one matching WORK_REVIEW_ACCEPTED event.
 *
 *   - status text, result_summary, mission ids in mutable metadata,
 *     caller input, claim leases, heartbeats, inbox messages and
 *     HANDOFF requests prove NOTHING about completion;
 *   - parent aggregation consumes ONLY the canonical child set — a
 *     forged mirror, a foreign DONE item, or a deleted mirror changes
 *     nothing;
 *   - restart/reconcile continues interrupted finalization exactly once
 *     and never fabricates missions, reviews, or completion evidence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
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
  childSetDigest,
  completionDigest,
  completionRowId,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14wfv2p3-"));
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

const wcpOf = (store: PairEvidenceStore, wid: string) =>
  store.tryGet("work_completion", completionRowId(wid)) as Record<string, unknown> | null;

const anchorEvents = (store: PairEvidenceStore, wid: string) =>
  store.listEvents("work_completion", completionRowId(wid))
    .filter((e) => String(e.event_type) === "WORK_ITEM_COMPLETED");

const acceptEvents = (store: PairEvidenceStore, wid: string) =>
  store.listEvents("work_item", wid)
    .filter((e) => String(e.event_type) === "WORK_REVIEW_ACCEPTED");

/** Direct test seam: hard-delete a work_completion row — simulates
 *  evidence loss between the ACCEPT/anchor and the projection. */
function deleteWcpRow(dbPath: string, wid: string) {
  const db = new Database(dbPath);
  db.prepare("DELETE FROM entities WHERE entity_type='work_completion' AND entity_id=?")
    .run(completionRowId(wid));
  db.close();
}

const corruptEvents = (store: PairEvidenceStore, wid: string) =>
  store.listEvents("work_item", wid)
    .filter((e) => String(e.event_type) === "WORK_PROVENANCE_INCONSISTENT");

/**
 * Drive a leaf item through the full canonical path: open (binding +
 * bound mission), mark the mission COMPLETED, fold. Returns the DONE
 * row (or REVIEW_REQUIRED when the item requires review).
 */
function completeLeaf(
  ctx: ReturnType<typeof makeCtxOn>, biz: BusinessLayer, wid: string,
) {
  biz.openWorkItem(wid, "op");
  const row = ctx.store.get("work_item", wid);
  const mid = String((row.mission_ids as string[])[0]);
  const m = ctx.store.get("mission", mid);
  m.status = "COMPLETED";
  ctx.store.put("mission", mid, m, Number(m.version));
  return biz.syncWorkItem(wid);
}

/** Forge status DONE with zero canonical evidence. */
function forgeDone(ctx: ReturnType<typeof makeCtxOn>, wid: string) {
  const r = ctx.store.get("work_item", wid);
  ctx.store.put("work_item", wid, { ...r, status: "DONE" }, Number(r.version));
}

// =====================================================================

describe("P14-P3 §4 — canonical child completion proof", () => {
  it("P14-P3-CHILD-COMPLETION-REQUIRES-CANONICAL-BINDING: bound-mission chain → DONE+WCP; unbound mission → quarantine", () => {
    const { ctx, biz, wf } = makeStack("child-binding");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_to_agent_id: String(a.agent_id),
    }, "op");
    const cid = String(child.work_item_id);
    const done = completeLeaf(ctx, biz, cid);
    expect(String(done.status)).toBe("DONE");
    // canonical completion record written atomically with the DONE fold
    const wcp = wcpOf(ctx.store, cid)!;
    expect(String(wcp.state)).toBe("COMMITTED");
    const mid = String((ctx.store.get("work_item", cid).mission_ids as string[])[0]);
    expect(String(wcp.mission_id)).toBe(mid);
    expect(String(wcp.bound_open_id)).toBe(
      String(ctx.store.get("mission", mid).bound_open_id));
    expect(anchorEvents(ctx.store, cid)).toHaveLength(1);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", cid))).toBe(true);
    // A bound mission for ANOTHER item can never prove this one.
    const w2 = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    biz.openWorkItem(String(w2.work_item_id), "op");
    const m2 = ctx.store.get("mission",
      String((ctx.store.get("work_item", String(w2.work_item_id)).mission_ids as string[])[0]));
    m2.status = "COMPLETED";
    ctx.store.put("mission", String(m2.mission_id), m2, Number(m2.version));
    const forged = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const fid = String(forged.work_item_id);
    const fr = ctx.store.get("work_item", fid);
    fr.status = "IN_PROGRESS";
    fr.mission_ids = [String(m2.mission_id)];
    ctx.store.put("work_item", fid, fr, Number(fr.version));
    biz.syncWorkItem(fid); // unbound final mission → quarantine, never DONE
    const after = ctx.store.get("work_item", fid);
    expect(String(after.status)).not.toBe("DONE");
    expect(wcpOf(ctx.store, fid)).toBeNull();
  });

  it("P14-P3-STATUS-ONLY-COMPLETION-REJECTED: forged DONE has no completion authority", () => {
    const { ctx, biz, wf } = makeStack("status-only");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const dep = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(dep.work_item_id);
    forgeDone(ctx, wid); // status DONE, no WCP, no mission
    const row = ctx.store.get("work_item", wid);
    expect(biz.proveWorkItemDone(row)).toBe(false);
    // dependency gate does not treat forged DONE as satisfied
    const child = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    wf.setWorkItemDependencies(String(child.work_item_id), [wid],
      Number(ctx.store.get("work_item", String(child.work_item_id)).version), "op");
    expect(errCode(() => biz.openWorkItem(String(child.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
    // reconcile quarantines the forged DONE — no completion is invented
    biz.reconcileWorkLifecycle();
    expect(corruptEvents(ctx.store, wid).length).toBeGreaterThan(0);
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-WRONG-MISSION-BINDING-REJECTED: WCP pinned to a foreign mission fails", () => {
    const { ctx, biz } = makeStack("wrong-mission");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    completeLeaf(ctx, biz, wid);
    // Forge a WCP pinned to a DIFFERENT mission via the store (digest
    // recomputed so payload_hash is self-consistent).
    const other = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    biz.openWorkItem(String(other.work_item_id), "op");
    const mOther = String((ctx.store.get("work_item", String(other.work_item_id)).mission_ids as string[])[0]);
    const wcp = wcpOf(ctx.store, wid)!;
    const tampered = { ...wcp, mission_id: mOther };
    tampered.completion_digest = completionDigest({
      completion_id: String(tampered.completion_id),
      work_item_id: wid,
      business_id: String(tampered.business_id),
      mission_id: mOther,
      bound_open_id: String(tampered.bound_open_id),
      child_work_item_ids: [],
      reviewer_agent_id: null,
    });
    ctx.store.put("work_completion", String(tampered.completion_id), tampered as never, Number(wcp.version));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(false);
    biz.reconcileWorkLifecycle();
    expect(corruptEvents(ctx.store, wid).length).toBeGreaterThan(0);
  });

  it("P14-P3-COMPLETION-TAMPER-REHASH-FAILS: rehashed WCP body cannot beat the immutable anchor", () => {
    const { ctx, biz } = makeStack("tamper-rehash");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    completeLeaf(ctx, biz, wid);
    const wcp = wcpOf(ctx.store, wid)!;
    // Tamper a pinned field AND recompute completion_digest correctly —
    // the immutable anchor event still pins the original digest.
    const tampered = { ...wcp, result_note: "exfil" };
    tampered.completion_digest = completionDigest({
      completion_id: String(wcp.completion_id),
      work_item_id: wid,
      business_id: String(wcp.business_id),
      mission_id: "MIS_forged",
      bound_open_id: String(wcp.bound_open_id),
      child_work_item_ids: [],
      reviewer_agent_id: null,
    });
    tampered.mission_id = "MIS_forged";
    ctx.store.put("work_completion", String(wcp.completion_id), tampered as never, Number(wcp.version));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(false);
    biz.reconcileWorkLifecycle();
    expect(String(ctx.store.get("work_item", wid).blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
  });
});

describe("P14-P3 §5 — review/acceptance lifecycle", () => {
  function reviewableLeaf(ctx: ReturnType<typeof makeCtxOn>, biz: BusinessLayer) {
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const w = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id,
      requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const wid = String(w.work_item_id);
    return { b, a, rev, wid };
  }

  it("P14-P3-REVIEW-REQUIRED-NOT-AUTO-ACCEPTED: completed mission projects REVIEW_REQUIRED, no WCP, no DONE", () => {
    const { ctx, biz } = makeStack("review-gate");
    const { wid } = reviewableLeaf(ctx, biz);
    const folded = completeLeaf(ctx, biz, wid);
    expect(String(folded.status)).toBe("REVIEW_REQUIRED");
    expect(wcpOf(ctx.store, wid)).toBeNull();
    expect(anchorEvents(ctx.store, wid)).toHaveLength(0);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(false);
  });

  it("P14-P3-REVIEW-ACCEPT-CANONICAL: ACCEPT → DONE + WCP pinned to mission+reviewer+digest", () => {
    const { ctx, biz } = makeStack("review-accept");
    const { rev, wid } = reviewableLeaf(ctx, biz);
    completeLeaf(ctx, biz, wid);
    const done = biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT",
    }, "op");
    expect(String(done.status)).toBe("DONE");
    const wcp = wcpOf(ctx.store, wid)!;
    expect(String(wcp.reviewer_agent_id)).toBe(String(rev.agent_id));
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    expect(String(wcp.mission_id)).toBe(mid);
    expect(anchorEvents(ctx.store, wid)).toHaveLength(1);
    expect(acceptEvents(ctx.store, wid)).toHaveLength(1);
    const amd = acceptEvents(ctx.store, wid)[0]!.metadata as Record<string, unknown>;
    expect(String(amd.completion_digest)).toBe(String(wcp.completion_digest));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(true);
  });

  it("P14-P3-REVIEW-ACCEPT-IDEMPOTENT: duplicate ACCEPT replays with no second event; wrong reviewer fails", () => {
    const { ctx, biz } = makeStack("accept-idem");
    const { a, rev, wid } = reviewableLeaf(ctx, biz);
    completeLeaf(ctx, biz, wid);
    biz.reviewWorkItem(wid, { reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    const eventsBefore = acceptEvents(ctx.store, wid).length;
    const replay = biz.reviewWorkItem(wid, { reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    expect(String(replay.status)).toBe("DONE");
    expect(acceptEvents(ctx.store, wid).length).toBe(eventsBefore); // no dup evidence
    expect(ctx.store.list("work_completion")).toHaveLength(1);
    // a different reviewer cannot re-accept under changed authority
    const other = makeAgent(biz, String(ctx.store.get("work_item", wid).business_id), "other");
    expect(errCode(() => biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(other.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_REVIEW_STATE");
    expect(String(a.agent_id)).not.toBe("");
  });

  it("P14-P3-REVIEW-FORGED-DECISION-FAILS: fabricated WCP without canonical ACCEPT event fails closed", () => {
    const { ctx, biz } = makeStack("forged-review");
    const { rev, wid } = reviewableLeaf(ctx, biz);
    const folded = completeLeaf(ctx, biz, wid); // REVIEW_REQUIRED, no WCP
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const openId = String(ctx.store.get("mission", mid).bound_open_id);
    // Forge a full WCP row (self-consistent digest) + DONE status — but
    // no WORK_REVIEW_ACCEPTED event exists to anchor the decision.
    const fields = {
      completion_id: completionRowId(wid),
      work_item_id: wid,
      business_id: String(ctx.store.get("work_item", wid).business_id),
      mission_id: mid,
      bound_open_id: openId,
      child_work_item_ids: [] as string[],
      reviewer_agent_id: String(rev.agent_id),
    };
    ctx.store.put("work_completion", fields.completion_id, {
      ...fields,
      project_id: ctx.projectId,
      child_set_digest: childSetDigest([]),
      completion_digest: completionDigest(fields),
      state: "COMMITTED",
      created_by: "attacker",
      created_at: utcnow(),
      version: 0,
    } as never, 0);
    const row = ctx.store.get("work_item", wid);
    ctx.store.put("work_item", wid, { ...row, status: "DONE" }, Number(row.version));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(false);
    biz.reconcileWorkLifecycle();
    expect(corruptEvents(ctx.store, wid).length).toBeGreaterThan(0);
    expect(String(folded.status)).toBe("REVIEW_REQUIRED");
  });

  it("P14-P3-REWORK-DOES-NOT-REUSE-OLD-COMPLETION-AUTHORITY: REWORK → new attempt → new pinned WCP", () => {
    const { ctx, biz } = makeStack("rework");
    const { rev, wid } = reviewableLeaf(ctx, biz);
    completeLeaf(ctx, biz, wid);
    const mid1 = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const reworked = biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK",
    }, "op");
    expect(String(reworked.status)).toBe("READY");
    expect(ctx.store.listEvents("work_item", wid)
      .filter((e) => String(e.event_type) === "WORK_REWORK_REQUESTED")).toHaveLength(1);
    // The old COMPLETED mission does not satisfy the new attempt.
    expect(wcpOf(ctx.store, wid)).toBeNull();
    // New attempt through the same canonical path → second mission.
    biz.openWorkItem(wid, "op");
    const r2 = ctx.store.get("work_item", wid);
    const mids = r2.mission_ids as string[];
    expect(mids.length).toBe(2);
    const mid2 = mids[1];
    expect(mid2).not.toBe(mid1);
    const m2 = ctx.store.get("mission", mid2);
    m2.status = "COMPLETED";
    ctx.store.put("mission", mid2, m2, Number(m2.version));
    biz.syncWorkItem(wid);
    expect(String(ctx.store.get("work_item", wid).status)).toBe("REVIEW_REQUIRED");
    biz.reviewWorkItem(wid, { reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    const wcp = wcpOf(ctx.store, wid)!;
    // The new completion pins the NEW attempt — the old mission is not
    // replayed into the acceptance.
    expect(String(wcp.mission_id)).toBe(mid2);
    expect(acceptEvents(ctx.store, wid)).toHaveLength(1);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(true);
  });
});

describe("P14-P3 §7-9 — parent aggregation + dependencies", () => {
  function parentWithChildren(
    ctx: ReturnType<typeof makeCtxOn>, biz: BusinessLayer, wf: WorkforceService, n = 2,
  ) {
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const spec = {
      decomposition_id: `DEC-${counter}`,
      children: Array.from({ length: n }, (_, i) => ({
        title: `c${i}`, goal: `g${i}`, assignee_agent_id: String(a.agent_id),
      })),
    };
    const r = wf.decomposeWorkItem(String(p.work_item_id), spec, "op");
    return {
      b, a, p,
      children: r.children.map((c) => String(c.work_item_id)),
    };
  }

  it("P14-P3-PARENT-WAITS-FOR-ALL-REQUIRED-CHILDREN: first child alone never completes the parent", () => {
    const { ctx, biz, wf } = makeStack("parent-waits");
    const { p, children } = parentWithChildren(ctx, biz, wf, 2);
    const pid = String(p.work_item_id);
    completeLeaf(ctx, biz, children[0]);
    const mid = ctx.store.get("work_item", pid);
    expect(String(mid.status)).not.toBe("DONE");
    expect(wcpOf(ctx.store, pid)).toBeNull();
    completeLeaf(ctx, biz, children[1]);
    const after = ctx.store.get("work_item", pid);
    expect(String(after.status)).toBe("DONE");
    const wcp = wcpOf(ctx.store, pid)!;
    expect((wcp.child_work_item_ids as string[]).sort()).toEqual(children.sort());
    expect(anchorEvents(ctx.store, pid)).toHaveLength(1);
  });

  it("P14-P3-PARENT-USES-CANONICAL-CHILD-SET: forged/deleted mirrors cannot change the child set", () => {
    const { ctx, biz, wf } = makeStack("canonical-children");
    const { p, children } = parentWithChildren(ctx, biz, wf, 1);
    const pid = String(p.work_item_id);
    const cid = children[0];
    // Forge the mutable parent mirror: drop the real child and inject
    // an unrelated item's id — the canonical WDEC child set still governs.
    const stray = makeItem(biz, String(ctx.store.get("work_item", pid).business_id));
    const pr = ctx.store.get("work_item", pid);
    ctx.store.put("work_item", pid,
      { ...pr, child_work_item_ids: [String(stray.work_item_id)] }, Number(pr.version));
    // The stray in the mirror is NOT a canonical child — the parent
    // still waits on the real canonical child only.
    biz.evaluateParentCompletion(pid, "op");
    expect(String(ctx.store.get("work_item", pid).status)).not.toBe("DONE");
    completeLeaf(ctx, biz, cid);
    const after = ctx.store.get("work_item", pid);
    expect(String(after.status)).toBe("DONE");
    // The stray was never counted; the canonical child alone sufficed.
    const wcp = wcpOf(ctx.store, pid)!;
    expect(wcp.child_work_item_ids).toEqual([cid]);
    expect(String(ctx.store.get("work_item", String(stray.work_item_id)).status)).not.toBe("DONE");
  });

  it("P14-P3-FOREIGN-CHILD-CANNOT-SATISFY-PARENT: completed items outside the canonical set count for nothing", () => {
    const { ctx, biz, wf } = makeStack("foreign-child");
    const { p, children } = parentWithChildren(ctx, biz, wf, 1);
    const pid = String(p.work_item_id);
    const bid = String(ctx.store.get("work_item", pid).business_id);
    const a = makeAgent(biz, bid, "helper");
    // A genuinely completed item that is NOT a canonical child.
    const foreign = makeItem(biz, bid, { assignee_agent_id: a.agent_id });
    completeLeaf(ctx, biz, String(foreign.work_item_id));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", String(foreign.work_item_id)))).toBe(true);
    biz.evaluateParentCompletion(pid, "op");
    expect(String(ctx.store.get("work_item", pid).status)).not.toBe("DONE");
    // Completing the true canonical child completes the parent.
    completeLeaf(ctx, biz, children[0]);
    expect(String(ctx.store.get("work_item", pid).status)).toBe("DONE");
  });

  it("P14-P3-DEPENDENCY-STATUS-ONLY-DOES-NOT-SATISFY + P14-P3-DEPENDENCY-CANONICAL-COMPLETION-SATISFIES", () => {
    const { ctx, biz, wf } = makeStack("dep-gate");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const dep = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const item = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    wf.setWorkItemDependencies(String(item.work_item_id), [String(dep.work_item_id)],
      Number(ctx.store.get("work_item", String(item.work_item_id)).version), "op");
    // Status-only DONE never satisfies the dependency.
    forgeDone(ctx, String(dep.work_item_id));
    expect(errCode(() => biz.openWorkItem(String(item.work_item_id), "op")))
      .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
    // Undo the forge and complete canonically → dependency unlocks.
    const d = ctx.store.get("work_item", String(dep.work_item_id));
    ctx.store.put("work_item", String(dep.work_item_id),
      { ...d, status: "READY" }, Number(d.version));
    completeLeaf(ctx, biz, String(dep.work_item_id));
    const opened = biz.openWorkItem(String(item.work_item_id), "op");
    expect(String(opened.status)).toBe("IN_PROGRESS");
  });

  it("P14-P3-COMPLETION-CASCADE-IDEMPOTENT: repeated evaluate/cascade adds zero events or rows", () => {
    const { ctx, biz, wf } = makeStack("cascade-idem");
    const { p, children } = parentWithChildren(ctx, biz, wf, 2);
    const pid = String(p.work_item_id);
    for (const c of children) completeLeaf(ctx, biz, c);
    expect(String(ctx.store.get("work_item", pid).status)).toBe("DONE");
    const anchorsBefore = anchorEvents(ctx.store, pid).length;
    const wcpBefore = ctx.store.list("work_completion").length;
    const eventsBefore = ctx.store.listEvents().length;
    // Replay the cascade + parent evaluation — idempotent convergence.
    biz.advanceCompletionCascade(children[0]);
    biz.evaluateParentCompletion(pid, "op");
    biz.reconcileWorkLifecycle();
    expect(anchorEvents(ctx.store, pid)).toHaveLength(anchorsBefore);
    expect(ctx.store.list("work_completion")).toHaveLength(wcpBefore);
    expect(ctx.store.listEvents().length).toBe(eventsBefore);
    expect(String(ctx.store.get("work_item", pid).status)).toBe("DONE");
  });

  it("P14-P3-GRAPH-ASSIGNEE-IMMUTABILITY-PRESERVED: WDEL-governed child cannot be reassigned", () => {
    const { ctx, biz, wf } = makeStack("assignee-immut");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const other = makeAgent(biz, String(b.business_id), "other");
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const child = wf.delegateWorkItem({
      work_item_id: String(p.work_item_id),
      delegated_to_agent_id: String(a.agent_id),
    }, "op");
    expect(errCode(() =>
      biz.assignWorkItem(String(child.work_item_id), String(other.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE");
  });
});

describe("P14-P3 §10/§15 — restart-safe finalization + reconcile", () => {
  it("P14-P3-RESTART-AFTER-MISSION-COMPLETE-BEFORE-FINALIZE: reconcile folds + writes WCP exactly once", () => {
    const { dir, ctx, biz } = makeStack("restart-mission");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    // "Crash" — item still IN_PROGRESS, no sync/fold ran.
    const { biz: biz2 } = reopenStack(dir);
    biz2.reconcileWorkLifecycle();
    const after = biz2.store.get("work_item", wid);
    expect(String(after.status)).toBe("DONE");
    expect(wcpOf(biz2.store, wid)).not.toBeNull();
    expect(anchorEvents(biz2.store, wid)).toHaveLength(1);
    // Second reconcile + third restart: nothing new is created.
    biz2.reconcileWorkLifecycle();
    const { biz: biz3 } = reopenStack(dir);
    biz3.reconcileWorkLifecycle();
    expect(anchorEvents(biz3.store, wid)).toHaveLength(1);
    expect(biz3.store.list("work_completion")).toHaveLength(1);
  });

  it("P14-P3-RESTART-AFTER-CHILD-FINALIZE-BEFORE-PARENT-CASCADE: reconcile resumes the cascade", () => {
    const { dir, ctx, biz, wf } = makeStack("restart-cascade");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-RC",
      children: [{ title: "c1", goal: "g", assignee_agent_id: String(a.agent_id) }],
    }, "op");
    const pid = String(p.work_item_id);
    const cid = String(r.children[0].work_item_id);
    // Child completes via finalize WITHOUT the cascade (simulates a
    // crash between child finalization and parent aggregation).
    biz.openWorkItem(cid, "op");
    const mid = String((ctx.store.get("work_item", cid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    biz.finalizeWorkItem(cid, "op"); // WCP lands; no cascade fired
    expect(wcpOf(ctx.store, cid)).not.toBeNull();
    expect(String(ctx.store.get("work_item", pid).status)).not.toBe("DONE");
    const { biz: biz2, wf: wf2 } = reopenStack(dir);
    biz2.reconcileWorkLifecycle();
    expect(String(biz2.store.get("work_item", pid).status)).toBe("DONE");
    const wcp = wcpOf(biz2.store, pid)!;
    expect(wcp.child_work_item_ids).toEqual([cid]);
    // Idempotent: further reconcile + restart produce nothing new.
    const ev = biz2.store.listEvents().length;
    biz2.reconcileWorkLifecycle();
    reopenStack(dir).biz.reconcileWorkLifecycle();
    expect(biz2.store.listEvents().length).toBe(ev);
  });

  it("P14-P3-RESTART-AFTER-REVIEW-ACCEPT-BEFORE-PROJECTION: committed ACCEPT materializes exactly once", () => {
    const { dir, ctx, biz } = makeStack("restart-accept");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const w = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const wid = String(w.work_item_id);
    completeLeaf(ctx, biz, wid); // → REVIEW_REQUIRED
    biz.reviewWorkItem(wid, { reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    const wcp = wcpOf(ctx.store, wid)!;
    // Inject crash C: ACCEPT event + DONE committed... simulate the
    // alternate half-state (ACCEPT evidence without WCP/projection):
    // remove the WCP row + revert status to REVIEW_REQUIRED.
    deleteWcpRow(path.join(dir, "pair.db"), wid);
    const row = ctx.store.get("work_item", wid);
    ctx.store.put("work_item", wid, { ...row, status: "REVIEW_REQUIRED" }, Number(row.version));
    expect(acceptEvents(ctx.store, wid)).toHaveLength(1);
    const { biz: biz2 } = reopenStack(dir);
    biz2.reconcileWorkLifecycle();
    const after = biz2.store.get("work_item", wid);
    expect(String(after.status)).toBe("DONE");
    const wcp2 = wcpOf(biz2.store, wid)!;
    expect(String(wcp2.reviewer_agent_id)).toBe(String(rev.agent_id));
    expect(acceptEvents(biz2.store, wid)).toHaveLength(1); // no fabricated second ACCEPT
    expect(anchorEvents(biz2.store, wid)).toHaveLength(1);
    expect(biz2.proveWorkItemDone(after)).toBe(true);
    // Idempotent across another restart.
    reopenStack(dir).biz.reconcileWorkLifecycle();
    expect(acceptEvents(biz2.store, wid)).toHaveLength(1);
  });

  it("P14-P3-RECONCILE-DOES-NOT-DUPLICATE-MISSION: reconcile creates no missions/bindings", () => {
    const { dir, ctx, biz } = makeStack("recon-dedup");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const { biz: biz2 } = reopenStack(dir);
    const missionsBefore = biz2.store.list("mission").length;
    const bindingsBefore = biz2.store.list("work_open_binding").length;
    biz2.reconcileWorkLifecycle();
    biz2.reconcileWorkLifecycle();
    expect(biz2.store.list("mission")).toHaveLength(missionsBefore);
    expect(biz2.store.list("work_open_binding")).toHaveLength(bindingsBefore);
    expect(String(biz2.store.get("work_item", wid).status)).toBe("DONE");
  });

  it("P14-P3-RECONCILE-DOES-NOT-FABRICATE-REVIEW: grounded REVIEW_REQUIRED stays gated without ACCEPT", () => {
    const { dir, ctx, biz } = makeStack("recon-review");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const w = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const wid = String(w.work_item_id);
    completeLeaf(ctx, biz, wid); // REVIEW_REQUIRED, grounded
    const { biz: biz2 } = reopenStack(dir);
    biz2.reconcileWorkLifecycle();
    const after = biz2.store.get("work_item", wid);
    // Still gated — no WCP, no DONE, no fabricated ACCEPT.
    expect(String(after.status)).toBe("REVIEW_REQUIRED");
    expect(wcpOf(biz2.store, wid)).toBeNull();
    expect(acceptEvents(biz2.store, wid)).toHaveLength(0);
  });
});

describe("P14-P3 §12 — coordination carries zero completion authority", () => {
  it("P14-P3-HEARTBEAT-DOES-NOT-PROVE-COMPLETION + P14-P3-MESSAGE-DOES-NOT-PROVE-COMPLETION + P14-P3-HANDOFF-DOES-NOT-MUTATE-COMPLETION-AUTHORITY", () => {
    const { ctx, biz, wf } = makeStack("coord-zero");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    // claim + heartbeat + inbox message + HANDOFF — none complete work.
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    biz.heartbeatWorkItem(wid, String(a.agent_id), String(c.claim_token), "op");
    biz.sendWorkforceMessage({
      business_id: String(b.business_id), work_item_id: wid,
      sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(a.agent_id), kind: "STATUS",
      body: "claiming I am done",
    });
    biz.sendWorkforceMessage({
      business_id: String(b.business_id), work_item_id: wid,
      sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(a.agent_id), kind: "HANDOFF_REQUEST",
      body: "handoff please",
    });
    const row = ctx.store.get("work_item", wid);
    expect(String(row.status)).not.toBe("DONE");
    expect(biz.proveWorkItemDone(row)).toBe(false);
    expect(wcpOf(ctx.store, wid)).toBeNull();
    // HANDOFF on a completed item does not mutate its completion either.
    completeLeaf(ctx, biz, wid);
    const digestBefore = String(wcpOf(ctx.store, wid)!.completion_digest);
    biz.sendWorkforceMessage({
      business_id: String(b.business_id), work_item_id: wid,
      sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(a.agent_id), kind: "HANDOFF_REQUEST",
      body: "trying to steal completed work",
    });
    expect(String(wcpOf(ctx.store, wid)!.completion_digest)).toBe(digestBefore);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(true);
  });
});

describe("P14-P3 §15 — corrupt provenance fails closed", () => {
  it("P14-P3-CORRUPT-PROVENANCE-FAILS-CLOSED: a corrupt child WCP blocks the parent; missing WCP blocks the item", () => {
    const { ctx, biz, wf } = makeStack("corrupt-wcp");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-CX",
      children: [{ title: "c1", goal: "g", assignee_agent_id: String(a.agent_id) }],
    }, "op");
    const pid = String(p.work_item_id);
    const cid = String(r.children[0].work_item_id);
    completeLeaf(ctx, biz, cid);
    expect(String(ctx.store.get("work_item", pid).status)).toBe("DONE");
    // Corrupt the child's WCP — parent proof fails closed even though
    // every status field still reads DONE.
    const cwcp = wcpOf(ctx.store, cid)!;
    ctx.store.put("work_completion", String(cwcp.completion_id),
      { ...cwcp, mission_id: "MIS_forged" } as never, Number(cwcp.version));
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", pid))).toBe(false);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", cid))).toBe(false);
    // Deleting the WCP also fails closed — absence is not completion.
    const { ctx: ctx2, biz: biz2 } = makeStack("corrupt-wcp-2");
    const b2 = makeBiz(biz2, ctx2.projectId);
    const a2 = makeAgent(biz2, String(b2.business_id));
    const w2 = makeItem(biz2, String(b2.business_id), { assignee_agent_id: a2.agent_id });
    const wid2 = String(w2.work_item_id);
    completeLeaf(ctx2, biz2, wid2);
    deleteWcpRow(path.join(ctx2.dir, "pair.db"), wid2);
    expect(biz2.proveWorkItemDone(ctx2.store.get("work_item", wid2))).toBe(false);
    biz2.reconcileWorkLifecycle(); // re-materializes (fully provable)
    expect(biz2.proveWorkItemDone(ctx2.store.get("work_item", wid2))).toBe(true);
  });
});

/* ========================================================================
 * P14-P3 §17 — genuine multi-process races (worker_threads, same DB)
 * ======================================================================== */

const P3_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p3");
const P3_BUNDLE = path.join(P3_CACHE, "pair-bundle.mjs");
const P3_WORKER = path.join(P3_CACHE, "p3-worker.mjs");

const P3_WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, dir, barrier, args } = workerData;

function makeCtx() {
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PAIR.PairEvidenceStore(dbPath);
  const service = new PAIR.PairControlPlane(store);
  const gate = new PAIR.GovernedTaskGate(service);
  const router = new PAIR.MissionRouter(service, gate);
  const recovery = new PAIR.RecoveryController(service);
  const recon = new PAIR.ReconciliationService(service, new Map());
  const approvals = new PAIR.ApprovalQueue(service);
  const scheduler = new PAIR.MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map();
  const planner = () => ({ tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }] });
  const runtime = new PAIR.MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new PAIR.MissionSupervisor(service, runtime, recovery, recon);
  const observability = new PAIR.MissionObservability(service);
  const control = new PAIR.MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  const schedules = new PAIR.MissionScheduleService(service);
  const biz = new PAIR.BusinessLayer({ store, control, schedules });
  const wf = new PAIR.WorkforceService({ store, business: biz });
  return { store, service, control, schedules, biz, wf };
}

async function run() {
  const ctx = makeCtx();
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  if (op === "finalize") return { out: ctx.biz.finalizeWorkItem(args.wid, "op") };
  if (op === "evaluate") return { out: ctx.biz.evaluateParentCompletion(args.wid, "op") };
  if (op === "cascade") return { out: ctx.biz.advanceCompletionCascade(args.wid) };
  if (op === "reconcile") return { out: ctx.biz.reconcileWorkLifecycle() };
  if (op === "review") {
    return { out: ctx.biz.reviewWorkItem(args.wid, {
      reviewer_agent_id: args.reviewer, decision: args.decision }, "op") };
  }
  if (op === "open") return { out: ctx.biz.openWorkItem(args.wid, "op") };
  if (op === "cancel") return { out: ctx.biz.cancelWorkItem(args.wid, "op") };
  throw new Error("unknown op " + op);
}

run()
  .then((out) => parentPort.postMessage({ ok: true, out }))
  .catch((e) => parentPort.postMessage({
    ok: false, code: (e && e.code) || String(e), message: e && e.message,
  }));
`;

function ensureP3Worker() {
  fs.mkdirSync(P3_CACHE, { recursive: true });
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found under node_modules/.pnpm");
  execFileSync(esbuild, [
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${P3_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(P3_WORKER, P3_WORKER_SOURCE);
}

type P3Outcome =
  | { ok: true; out: Record<string, unknown> | null }
  | { ok: false; code: string; message: string };

/** Genuine multi-process race: N workers on the SAME db file, all
 *  released on one shared Atomics barrier. */
async function p3Race(
  ops: Array<{ op: string; dir: string; dbPath: string; args: Record<string, unknown> }>,
): Promise<P3Outcome[]> {
  ensureP3Worker();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let ready = 0;
  return Promise.all(ops.map((o) => new Promise<P3Outcome>((resolve, reject) => {
    const w = new Worker(P3_WORKER, {
      workerData: { op: o.op, dbPath: o.dbPath, dir: o.dir, barrier: gate, args: o.args },
    });
    let settled = false;
    w.on("message", (msg: Record<string, unknown>) => {
      if (msg.ready === true) {
        ready += 1;
        if (ready === ops.length) {
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
        }
        return;
      }
      settled = true;
      resolve(msg as unknown as P3Outcome);
    });
    w.on("error", reject);
    w.on("exit", (code) => {
      if (!settled) reject(new Error(`worker exited code=${code}`));
    });
  })));
}

const FINALIZER_LOSS = /^FAIL_CLOSED_|SQLITE_BUSY/;

describe("P14-P3 §17 — genuine races", () => {
  it("P14-P3-ACCEPT-REWORK-RACE-SINGLE-CANONICAL-OUTCOME: ACCEPT vs REWORK — exactly one canonical result", async () => {
    const { ctx, biz } = makeStack("race-accept-rework");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const w = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const wid = String(w.work_item_id);
    completeLeaf(ctx, biz, wid);
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rAccept, rRework] = await p3Race([
      { op: "review", dir: ctx.dir, dbPath, args: { wid, reviewer: String(rev.agent_id), decision: "ACCEPT" } },
      { op: "review", dir: ctx.dir, dbPath, args: { wid, reviewer: String(rev.agent_id), decision: "REWORK" } },
    ]);
    const ok = [rAccept, rRework].filter((r) => r.ok);
    const lost = [rAccept, rRework].filter((r) => !r.ok);
    // Exactly one outcome: winner committed, loser failed closed.
    expect(ok.length).toBe(1);
    expect(lost.length).toBe(1);
    expect(String((lost[0] as { code: string }).code)).toMatch(FINALIZER_LOSS);
    const finalStore = new PairEvidenceStore(dbPath);
    const row = finalStore.get("work_item", wid);
    if (rAccept.ok) {
      expect(String(row.status)).toBe("DONE");
      expect(finalStore.tryGet("work_completion", completionRowId(wid))).not.toBeNull();
      expect(acceptEvents(finalStore, wid)).toHaveLength(1);
      expect(anchorEvents(finalStore, wid)).toHaveLength(1);
    } else {
      expect(String(row.status)).toBe("READY");
      expect(finalStore.tryGet("work_completion", completionRowId(wid))).toBeNull();
      expect(acceptEvents(finalStore, wid)).toHaveLength(0);
      expect(finalStore.listEvents("work_item", wid)
        .filter((e) => String(e.event_type) === "WORK_REWORK_REQUESTED")).toHaveLength(1);
    }
    finalStore.close();
  }, 90_000);

  it("P14-P3-CONCURRENT-FINALIZER-SINGLE-EVIDENCE: two finalizers — one WCP, one anchor", async () => {
    const { ctx, biz } = makeStack("race-finalizers");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const dbPath = path.join(ctx.dir, "pair.db");
    const results = await p3Race([
      { op: "finalize", dir: ctx.dir, dbPath, args: { wid } },
      { op: "finalize", dir: ctx.dir, dbPath, args: { wid } },
    ]);
    // Both may "succeed" (idempotent adoption) or one conflicts — but the
    // durable evidence is exactly one WCP + one anchor event.
    const finalStore = new PairEvidenceStore(dbPath);
    expect(finalStore.list("work_completion")).toHaveLength(1);
    expect(anchorEvents(finalStore, wid)).toHaveLength(1);
    const row = finalStore.get("work_item", wid);
    expect(String(row.status)).toBe("DONE");
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBeGreaterThan(0);
    for (const r of results.filter((x) => !x.ok)) {
      expect(String((r as { code: string }).code)).toMatch(FINALIZER_LOSS);
    }
    finalStore.close();
  }, 90_000);

  it("P14-P3-FINALIZE-VS-RECONCILE: finalize racing reconcile converges to one canonical completion", async () => {
    const { ctx, biz } = makeStack("race-fin-recon");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const dbPath = path.join(ctx.dir, "pair.db");
    await p3Race([
      { op: "finalize", dir: ctx.dir, dbPath, args: { wid } },
      { op: "reconcile", dir: ctx.dir, dbPath, args: {} },
    ]);
    const finalStore = new PairEvidenceStore(dbPath);
    const row = finalStore.get("work_item", wid);
    expect(String(row.status)).toBe("DONE");
    expect(finalStore.list("work_completion")).toHaveLength(1);
    expect(anchorEvents(finalStore, wid)).toHaveLength(1);
    finalStore.close();
  }, 90_000);

  it("P14-P3-DEP-OPEN-VS-FINALIZE: dependency opens only after canonical completion lands", async () => {
    const { ctx, biz, wf } = makeStack("race-dep-open");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const dep = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const item = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const depId = String(dep.work_item_id);
    const itemId = String(item.work_item_id);
    wf.setWorkItemDependencies(itemId, [depId],
      Number(ctx.store.get("work_item", itemId).version), "op");
    biz.openWorkItem(depId, "op");
    const mid = String((ctx.store.get("work_item", depId).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rFin, rOpen] = await p3Race([
      { op: "finalize", dir: ctx.dir, dbPath, args: { wid: depId } },
      { op: "open", dir: ctx.dir, dbPath, args: { wid: itemId } },
    ]);
    const finalStore = new PairEvidenceStore(dbPath);
    const depRow = finalStore.get("work_item", depId);
    expect(String(depRow.status)).toBe("DONE");
    const depWcp = finalStore.tryGet("work_completion", completionRowId(depId));
    if (rOpen.ok) {
      // The open admitted AFTER the completion was canonical — never
      // satisfied by a mission row or status alone.
      expect(depWcp).not.toBeNull();
      const itemRow = finalStore.get("work_item", itemId);
      expect(String(itemRow.status)).toBe("IN_PROGRESS");
    } else {
      expect(String((rOpen as { code: string }).code))
        .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
    }
    finalStore.close();
  }, 90_000);

  it("P14-P3-TWO-PARENT-CASCADES: racing cascades land one parent completion", async () => {
    const { ctx, biz, wf } = makeStack("race-cascades");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const r = wf.decomposeWorkItem(String(p.work_item_id), {
      decomposition_id: "DEC-CASC",
      children: [{ title: "c1", goal: "g", assignee_agent_id: String(a.agent_id) }],
    }, "op");
    const pid = String(p.work_item_id);
    const cid = String(r.children[0].work_item_id);
    completeLeaf(ctx, biz, cid); // first cascade lands parent DONE+WCP
    expect(String(ctx.store.get("work_item", pid).status)).toBe("DONE");
    const dbPath = path.join(ctx.dir, "pair.db");
    await p3Race([
      { op: "cascade", dir: ctx.dir, dbPath, args: { wid: cid } },
      { op: "evaluate", dir: ctx.dir, dbPath, args: { wid: pid } },
    ]);
    const finalStore = new PairEvidenceStore(dbPath);
    expect(finalStore.list("work_completion")).toHaveLength(2); // child + parent
    expect(anchorEvents(finalStore, pid)).toHaveLength(1);
    finalStore.close();
  }, 90_000);

  it("P14-P3-COMPLETION-VS-CANCELLATION: finalize vs cancel — exactly one terminal outcome", async () => {
    const { ctx, biz } = makeStack("race-finalize-cancel");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rFin, rCancel] = await p3Race([
      { op: "finalize", dir: ctx.dir, dbPath, args: { wid } },
      { op: "cancel", dir: ctx.dir, dbPath, args: { wid } },
    ]);
    const finalStore = new PairEvidenceStore(dbPath);
    const row = finalStore.get("work_item", wid);
    const wcp = finalStore.tryGet("work_completion", completionRowId(wid));
    // Whichever landed first is the only terminal outcome — never both.
    if (String(row.status) === "DONE") {
      expect(wcp).not.toBeNull();
      expect(anchorEvents(finalStore, wid)).toHaveLength(1);
    } else {
      expect(String(row.status)).toBe("CANCELLED");
      expect(wcp).toBeNull();
    }
    // The loser may have failed closed or idempotently no-oped — never
    // a second contradictory outcome.
    const statuses = [rFin, rCancel].map((r) => r.ok);
    expect(statuses.filter(Boolean).length).toBeGreaterThan(0);
    finalStore.close();
  }, 90_000);
});
