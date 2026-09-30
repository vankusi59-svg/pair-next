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
  assertCanonicalMissionCompletion,
  childSetDigest,
  completionDigest,
  completionRowId,
  digest,
  proveCanonicalMissionCompletion,
  utcnow,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

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
  // R1: drive the canonical runtime-finalization evidence chain — a
  // bare mission.status flip is a forgery the seams reject.
  canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid2);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
  if (op === "set_agent_status") {
    return { out: ctx.biz.setOrgAgentStatus(args.agentId, args.status, "op") };
  }
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
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

// =====================================================================
// P14-P3 R1 — canonical mission-completion proof + reviewer in-txn
// authority + REWORK basis fencing.

function tamperEventMetadata(
  dbPath: string, eventId: string,
  mutate: (md: Record<string, unknown>) => void,
) {
  const db = new Database(dbPath);
  const row = db.prepare("SELECT * FROM events WHERE event_id=?")
    .get(eventId) as Record<string, unknown>;
  const metadata = row.metadata_json
    ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : null;
  mutate(metadata ?? {});
  const body = {
    event_id: row.event_id, entity_type: row.entity_type,
    entity_id: row.entity_id, event_type: row.event_type,
    old_state: row.old_state, new_state: row.new_state, actor: row.actor,
    correlation_id: row.correlation_id, metadata, created_at: row.created_at,
  };
  db.prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
    .run(JSON.stringify(metadata), digest(body), eventId);
  db.close();
}

function deleteEvents(
  dbPath: string, entityType: string, entityId: string,
  eventType: string, newState?: string,
) {
  const db = new Database(dbPath);
  db.prepare(
    "DELETE FROM events WHERE entity_type=? AND entity_id=? AND event_type=?" +
    (newState ? " AND new_state=?" : ""))
    .run(...(newState ? [entityType, entityId, eventType, newState]
                     : [entityType, entityId, eventType]));
  db.close();
}

/** A requires_review leaf driven to REVIEW_REQUIRED through the real
 *  canonical evidence chain. */
function reviewableLeaf(
  ctx: ReturnType<typeof makeCtxOn>, biz: BusinessLayer,
  businessId: string, assigneeId: string, reviewerId: string,
) {
  const w = makeItem(biz, businessId, {
    assignee_agent_id: assigneeId, requires_review: true,
    reviewer_agent_id: reviewerId,
  });
  const wid = String(w.work_item_id);
  biz.openWorkItem(wid, "op");
  const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
  canonicallyCompleteMission(ctx.store, ctx.service, mid);
  const r = biz.syncWorkItem(wid);
  expect(String(r.status)).toBe("REVIEW_REQUIRED");
  return wid;
}

describe("P14-P3 R1 — canonical mission completion proof", () => {
  it("P14-P3-R1-MISSION-STATUS-ONLY-COMPLETION-REJECTED: bound mission status forged alone → quarantine, never DONE/REVIEW_REQUIRED/WCP", () => {
    const { ctx, biz } = makeStack("r1-status-only");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    // The exact audited defect: a bare status flip on the bound mission.
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
    expect(corruptEvents(ctx.store, wid).length).toBeGreaterThan(0);
    // Reconcile can never promote the forgery either.
    biz.reconcileWorkLifecycle();
    const again = ctx.store.get("work_item", wid);
    expect(String(again.status)).toBe("IN_PROGRESS");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R1-MISSION-COMPLETION-TRANSITION-EVIDENCE-REQUIRED: canonical completion minus the MISSION_TRANSITION→COMPLETED anchor → quarantine", () => {
    const { ctx, biz } = makeStack("r1-miss-trans");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    deleteEvents(path.join(ctx.dir, "pair.db"),
      "mission", mid, "MISSION_TRANSITION", "COMPLETED");
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R1-MISSION-RUNTIME-COMPLETION-EVIDENCE-REQUIRED: canonical completion minus the MISSION_RUNTIME_TRANSITION→COMPLETED anchor → quarantine", () => {
    const { ctx, biz } = makeStack("r1-miss-rt-ev");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    deleteEvents(path.join(ctx.dir, "pair.db"),
      "mission_runtime", `MRT_${mid}`, "MISSION_RUNTIME_TRANSITION", "COMPLETED");
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R1-MISSION-RUNTIME-ROW-TAMPER-FAILS: runtime row mutated back to RUNNING → completion authority collapses, quarantine", () => {
    const { ctx, biz } = makeStack("r1-rt-row");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const rt = ctx.store.get("mission_runtime", `MRT_${mid}`);
    rt.state = "RUNNING";
    ctx.store.put("mission_runtime", `MRT_${mid}`, rt, Number(rt.version));
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R1-MISSION-CANONICAL-SUCCESS-PROVES-WCP: full runtime evidence chain → DONE + WCP pinning the bound mission", () => {
    const { ctx, biz } = makeStack("r1-canonical-ok");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const done = completeLeaf(ctx, biz, wid);
    expect(String(done.status)).toBe("DONE");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const wcp = wcpOf(ctx.store, wid)!;
    expect(String(wcp.mission_id)).toBe(mid);
    expect(String(wcp.state)).toBe("COMMITTED");
    expect(anchorEvents(ctx.store, wid)).toHaveLength(1);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(true);
  });

  it("P14-P3-R1-FORGED-MISSION-CANNOT-SATISFY-DEPENDENCY: forged dep mission leaves the dependency unmet", () => {
    const { ctx, biz, wf } = makeStack("r1-forge-dep");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const dep = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const depId = String(dep.work_item_id);
    const item = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const itemId = String(item.work_item_id);
    wf.setWorkItemDependencies(itemId, [depId],
      Number(ctx.store.get("work_item", itemId).version), "op");
    biz.openWorkItem(depId, "op");
    const mid = String((ctx.store.get("work_item", depId).mission_ids as string[])[0]);
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    // Dependency never satisfied by the forged row — open fails closed.
    expect(errCode(() => biz.openWorkItem(itemId, "op")))
      .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
    biz.syncWorkItem(depId);
    const depRow = ctx.store.get("work_item", depId);
    expect(String(depRow.status)).toBe("IN_PROGRESS");
    expect(String(depRow.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, depId)).toBeNull();
    expect(errCode(() => biz.openWorkItem(itemId, "op")))
      .toBe("FAIL_CLOSED_WORK_DEPENDENCY_UNMET");
  });

  it("P14-P3-R1-FORGED-MISSION-CANNOT-COMPLETE-PARENT: forged child mission never folds the parent", () => {
    const { ctx, biz, wf } = makeStack("r1-forge-parent");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const p = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const pid = String(p.work_item_id);
    const r = wf.decomposeWorkItem(pid, {
      decomposition_id: `DEC-FP-${counter}`,
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(a.agent_id) },
        { title: "c2", goal: "g2", assignee_agent_id: String(a.agent_id) },
      ],
    }, "op");
    const c1id = String(r.children[0].work_item_id);
    const c2id = String(r.children[1].work_item_id);
    const d1 = completeLeaf(ctx, biz, c1id);
    expect(String(d1.status)).toBe("DONE");
    // Forge child c2's bound mission — no canonical evidence.
    biz.openWorkItem(c2id, "op");
    const mid2 = String((ctx.store.get("work_item", c2id).mission_ids as string[])[0]);
    const m2 = ctx.store.get("mission", mid2);
    m2.status = "COMPLETED";
    ctx.store.put("mission", mid2, m2, Number(m2.version));
    const s2 = biz.syncWorkItem(c2id);
    expect(String(s2.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    // The parent can never complete on the forged child.
    biz.syncWorkItem(pid);
    biz.evaluateParentCompletion(pid, "op");
    biz.reconcileWorkLifecycle();
    const parent = ctx.store.get("work_item", pid);
    expect(String(parent.status)).not.toBe("DONE");
    expect(String(parent.status)).not.toBe("REVIEW_REQUIRED");
    expect(wcpOf(ctx.store, pid)).toBeNull();
  });
});

describe("P14-P3 R1 — reviewer in-transaction authority", () => {
  it("P14-P3-R1-ACCEPT-VS-REVIEWER-PAUSE-RACE: pause racing ACCEPT — loser loses, no partial review", async () => {
    const { ctx, biz } = makeStack("r1-accept-pause");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rAccept, rPause] = await p3Race([
      { op: "review", dir: ctx.dir, dbPath,
        args: { wid, reviewer: String(rev.agent_id), decision: "ACCEPT" } },
      { op: "set_agent_status", dir: ctx.dir, dbPath,
        args: { agentId: String(rev.agent_id), status: "PAUSED" } },
    ]);
    const fs2 = new PairEvidenceStore(dbPath);
    const row = fs2.get("work_item", wid);
    if (rAccept.ok) {
      // ACCEPT won while the reviewer was still ACTIVE — canonical.
      expect(String(row.status)).toBe("DONE");
      expect(fs2.tryGet("work_completion", completionRowId(wid))).not.toBeNull();
      expect(acceptEvents(fs2, wid)).toHaveLength(1);
    } else {
      // PAUSE committed first — the in-txn reviewer re-proof fails closed.
      expect(String((rAccept as { code: string }).code)).toBe("FAIL_CLOSED_AGENT_INACTIVE");
      expect(String(row.status)).toBe("REVIEW_REQUIRED");
      expect(fs2.tryGet("work_completion", completionRowId(wid))).toBeNull();
      expect(acceptEvents(fs2, wid)).toHaveLength(0);
      expect(rPause.ok).toBe(true);
    }
    fs2.close();
  }, 90_000);

  it("P14-P3-R1-ACCEPT-VS-REVIEWER-TERMINATE-RACE: terminate racing ACCEPT — loser loses, no partial review", async () => {
    const { ctx, biz } = makeStack("r1-accept-term");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rAccept, rTerm] = await p3Race([
      { op: "review", dir: ctx.dir, dbPath,
        args: { wid, reviewer: String(rev.agent_id), decision: "ACCEPT" } },
      { op: "set_agent_status", dir: ctx.dir, dbPath,
        args: { agentId: String(rev.agent_id), status: "TERMINATED" } },
    ]);
    const fs2 = new PairEvidenceStore(dbPath);
    const row = fs2.get("work_item", wid);
    if (rAccept.ok) {
      expect(String(row.status)).toBe("DONE");
      expect(acceptEvents(fs2, wid)).toHaveLength(1);
    } else {
      expect(String((rAccept as { code: string }).code)).toBe("FAIL_CLOSED_AGENT_INACTIVE");
      expect(String(row.status)).toBe("REVIEW_REQUIRED");
      expect(fs2.tryGet("work_completion", completionRowId(wid))).toBeNull();
      expect(acceptEvents(fs2, wid)).toHaveLength(0);
      expect(rTerm.ok).toBe(true);
    }
    fs2.close();
  }, 90_000);
});

describe("P14-P3 R1 — REWORK basis fencing", () => {
  it("P14-P3-R1-PARENT-REWORK-SAME-BASIS-NOT-REVIEWABLE: REWORK on a container fences the unchanged child basis", () => {
    const { ctx, biz, wf } = makeStack("r1-parent-rework");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const p = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const pid = String(p.work_item_id);
    const r = wf.decomposeWorkItem(pid, {
      decomposition_id: `DEC-PR-${counter}`,
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(a.agent_id) },
        { title: "c2", goal: "g2", assignee_agent_id: String(a.agent_id) },
      ],
    }, "op");
    completeLeaf(ctx, biz, String(r.children[0].work_item_id));
    completeLeaf(ctx, biz, String(r.children[1].work_item_id));
    biz.evaluateParentCompletion(pid, "op");
    expect(String(ctx.store.get("work_item", pid).status)).toBe("REVIEW_REQUIRED");
    biz.reviewWorkItem(pid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    expect(String(ctx.store.get("work_item", pid).status)).toBe("READY");
    // The SAME unchanged child set can never re-ground REVIEW_REQUIRED —
    // the rejected basis is exhausted authority.
    biz.evaluateParentCompletion(pid, "op");
    biz.reconcileWorkLifecycle();
    biz.syncWorkItem(pid);
    const after = ctx.store.get("work_item", pid);
    expect(String(after.status)).toBe("READY");
    expect(wcpOf(ctx.store, pid)).toBeNull();
    // And a second review decision against the rejected basis fails closed.
    const err = errCode(() => biz.reviewWorkItem(pid, {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op"));
    expect(err).not.toBe("NO_ERROR");
    expect(String(ctx.store.get("work_item", pid).status)).toBe("READY");
  });

  it("P14-P3-R1-LEAF-REWORK-OLD-MISSION-NOT-REUSED: leaf REWORK → old mission basis fenced; only a NEW canonical attempt re-enters review", () => {
    const { ctx, biz } = makeStack("r1-leaf-rework");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    const oldMid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    expect(String(ctx.store.get("work_item", wid).status)).toBe("READY");
    // The old bound mission is still canonically COMPLETED — but its basis
    // is rejected: no sync/finalize/reconcile may re-enter REVIEW_REQUIRED.
    biz.finalizeWorkItem(wid, "op");
    biz.reconcileWorkLifecycle();
    expect(String(ctx.store.get("work_item", wid).status)).toBe("READY");
    // A new open/binding/mission attempt creates a DIFFERENT basis — the
    // item can be completed again and re-enters review legitimately.
    biz.openWorkItem(wid, "op");
    const mids = ctx.store.get("work_item", wid).mission_ids as string[];
    const newMid = mids[mids.length - 1];
    expect(String(newMid)).not.toBe(oldMid);
    canonicallyCompleteMission(ctx.store, ctx.service, String(newMid));
    const r = biz.syncWorkItem(wid);
    expect(String(r.status)).toBe("REVIEW_REQUIRED");
    biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    const done = ctx.store.get("work_item", wid);
    expect(String(done.status)).toBe("DONE");
    expect(String(wcpOf(ctx.store, wid)!.mission_id)).toBe(String(newMid));
  });

  it("P14-P3-R1-REWORK-BASIS-PIN-TAMPER-FAILS: tampered rejected-basis pin detected, item quarantines on next evaluation", () => {
    const { ctx, biz } = makeStack("r1-rework-tamper");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    const rework = ctx.store.listEvents("work_item", wid)
      .find((e) => String(e.event_type) === "WORK_REWORK_REQUESTED")!;
    const dbPath = path.join(ctx.dir, "pair.db");
    // Attacker rewrites the rejected-basis pin (consistent event_hash —
    // the semantic digest recompute must still catch it).
    tamperEventMetadata(dbPath, String(rework.event_id), (md) => {
      md.rejected_basis_digest = "deadbeef".repeat(8);
    });
    expect(errCode(() =>
      (biz as unknown as { completionBasis: (r: unknown) => unknown })
        .completionBasis(ctx.store.get("work_item", wid))))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    // And every downstream seam fails closed — the tampered fence can
    // never be used to re-enter REVIEW_REQUIRED from the rejected basis.
    biz.reconcileWorkLifecycle();
    expect(String(ctx.store.get("work_item", wid).status)).toBe("READY");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R1-REWORK-RESTART-PRESERVES-BASIS-FENCE: process restart keeps the rejected basis fenced", () => {
    const { ctx, biz, dir } = makeStack("r1-rework-restart");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    biz.reviewWorkItem(wid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    const { biz: biz2 } = reopenStack(dir);
    biz2.reconcileWorkLifecycle();
    biz2.finalizeWorkItem(wid, "op");
    const { biz: biz3 } = reopenStack(dir);
    biz3.reconcileWorkLifecycle();
    const row = new PairEvidenceStore(path.join(dir, "pair.db")).get("work_item", wid);
    expect(String(row.status)).toBe("READY");
    // A fresh open creates new basis → completion advances legitimately.
    biz3.openWorkItem(wid, "op");
    const mids = new PairEvidenceStore(path.join(dir, "pair.db"))
      .get("work_item", wid).mission_ids as string[];
    const { ctx: ctx3 } = reopenStack(dir);
    canonicallyCompleteMission(ctx3.store, ctx3.service, String(mids[mids.length - 1]));
    const r = biz3.syncWorkItem(wid);
    expect(String(r.status)).toBe("REVIEW_REQUIRED");
  });

  it("P14-P3-R1-ACCEPT-REWORK-RACE-PRESERVES-BASIS-FENCE: concurrent ACCEPT vs REWORK — exactly one decision, REWORK outcome stays fenced", async () => {
    const { ctx, biz } = makeStack("r1-accept-rework-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const wid = reviewableLeaf(ctx, biz, String(b.business_id),
      String(a.agent_id), String(rev.agent_id));
    const dbPath = path.join(ctx.dir, "pair.db");
    const [rAccept, rRework] = await p3Race([
      { op: "review", dir: ctx.dir, dbPath,
        args: { wid, reviewer: String(rev.agent_id), decision: "ACCEPT" } },
      { op: "review", dir: ctx.dir, dbPath,
        args: { wid, reviewer: String(rev.agent_id), decision: "REWORK" } },
    ]);
    const fs2 = new PairEvidenceStore(dbPath);
    const row = fs2.get("work_item", wid);
    const accepts = acceptEvents(fs2, wid).length;
    const reworks = fs2.listEvents("work_item", wid)
      .filter((e) => String(e.event_type) === "WORK_REWORK_REQUESTED").length;
    // Exactly one canonical decision committed.
    expect(accepts + reworks).toBe(1);
    if (rAccept.ok) {
      expect(String(row.status)).toBe("DONE");
      expect(fs2.tryGet("work_completion", completionRowId(wid))).not.toBeNull();
      expect(rRework.ok).toBe(false);
    } else {
      // REWORK won — the fence is active: nothing re-grounds review on
      // the rejected basis.
      expect(String(row.status)).toBe("READY");
      expect(accepts).toBe(0);
      expect(fs2.tryGet("work_completion", completionRowId(wid))).toBeNull();
      // biz owns another connection on the same db file — same authority.
      biz.reconcileWorkLifecycle();
      biz.evaluateParentCompletion(wid, "op");
      expect(String(fs2.get("work_item", wid).status)).toBe("READY");
      expect(rAccept.ok).toBe(false);
    }
    fs2.close();
  }, 90_000);
});

// =====================================================================
// P14-P3 R2 — result-validation authority + REWORK event self-consistency
// =====================================================================

/** Direct test seam: hard-delete an entity row. */
function deleteRow(dbPath: string, entityType: string, entityId: string) {
  const db = new Database(dbPath);
  db.prepare("DELETE FROM entities WHERE entity_type=? AND entity_id=?")
    .run(entityType, entityId);
  db.close();
}

/** The single canonical execution of mission mid's task tid. */
function executionOf(ctx: ReturnType<typeof makeCtxOn>, mid: string, tid: string) {
  return ctx.store.list("executor_execution").find((x) =>
    String(x.mission_id) === mid && String(x.task_id) === tid)!;
}

describe("P14-P3 R2 — result-validation authority", () => {
  it("P14-P3-R2-MISSING-EXECUTION-VALIDATION-FAILS: execution COMPLETED but no execution_validation PASS → quarantine, no WCP", () => {
    const { ctx, biz } = makeStack("r2-missing-validation");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    // Strip the result-validation authority: XVLD row + its RESULT_VALIDATED anchor.
    const exec = ctx.store.list("executor_execution")
      .find((x) => String(x.mission_id) === mid)!;
    const eid = String(exec.execution_id);
    for (const v of ctx.store.list("execution_validation")
        .filter((v) => String(v.execution_id) === eid)) {
      deleteRow(path.join(ctx.dir, "pair.db"), "execution_validation", String(v.validation_id));
    }
    deleteEvents(path.join(ctx.dir, "pair.db"),
      "executor_execution", eid, "RESULT_VALIDATED");
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R2-FAILED-EXECUTION-VALIDATION-FAILS: validation status FAIL can never establish mission success", () => {
    const { ctx, biz } = makeStack("r2-failed-validation");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const exec = ctx.store.list("executor_execution")
      .find((x) => String(x.mission_id) === mid)!;
    const v = ctx.store.list("execution_validation")
      .find((v) => String(v.execution_id) === String(exec.execution_id))!;
    ctx.store.put("execution_validation", String(v.validation_id),
      { ...v, status: "FAIL" }, Number(v.version));
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R2-FOREIGN-VALIDATION-ID-FAILS: RESULT_VALIDATED pinning a foreign validation_id → quarantine", () => {
    const { ctx, biz } = makeStack("r2-foreign-validation");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const exec = ctx.store.list("executor_execution")
      .find((x) => String(x.mission_id) === mid)!;
    const ev = ctx.store.listEvents("executor_execution", String(exec.execution_id))
      .find((e) => String(e.event_type) === "RESULT_VALIDATED")!;
    // Rehash-valid forged event — pins a validation id that is not this
    // execution's canonical PASS row.
    tamperEventMetadata(path.join(ctx.dir, "pair.db"), String(ev.event_id),
      (md) => { md.validation_id = "XVLD_FOREIGN"; });
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R2-FOREIGN-GOVERNED-TASK-FAILS: execution bound to a governed task of a foreign mission → quarantine", () => {
    const { ctx, biz } = makeStack("r2-foreign-gt");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const exec = ctx.store.list("executor_execution")
      .find((x) => String(x.mission_id) === mid)!;
    const gt = ctx.store.get("governed_task", String(exec.governed_task_id));
    ctx.store.put("governed_task", String(gt.governed_task_id),
      { ...gt, mission_id: "MSN_FOREIGN" }, Number(gt.version));
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R2-FORGED-TASK-COMPLETED-EVENT-FAILS: TASK_COMPLETED with a correlation bound to no validated execution → quarantine", () => {
    const { ctx, biz } = makeStack("r2-forged-task-ev");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const tid = String(ctx.store.list("task")
      .find((t) => String(t.mission_id) === mid)!.task_id);
    deleteEvents(path.join(ctx.dir, "pair.db"), "task", tid, "TASK_COMPLETED");
    // Forge a well-formed TASK_COMPLETED whose correlation matches no
    // governed validated execution.
    ctx.store.event({
      entity_type: "task", entity_id: tid,
      event_type: "TASK_COMPLETED", new_state: "COMPLETED",
      actor: "PAIR_MISSION_RUNTIME", correlation_id: "COR_FORGED",
    });
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(wcpOf(ctx.store, wid)).toBeNull();
  });

  it("P14-P3-R2-VALIDATED-GOVERNED-EXECUTION-PROVES-MISSION: full governed chain passes the canonical mission proof", () => {
    const { ctx, biz } = makeStack("r2-canonical-proven");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.openWorkItem(wid, "op");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    canonicallyCompleteMission(ctx.store, ctx.service, mid);
    const m = ctx.store.get("mission", mid);
    // The governed chain itself is the proof — every pin bound to the
    // exact mission/task/plan/execution/validation identities.
    expect(proveCanonicalMissionCompletion(ctx.store, m)).toBe(true);
    expect(() => assertCanonicalMissionCompletion(ctx.store, m)).not.toThrow();
    const after = biz.syncWorkItem(wid);
    expect(String(after.status)).toBe("DONE");
  });

  it("P14-P3-R2-VALIDATED-MISSION-PROVES-WCP: governed validated mission mints the canonical WCP", () => {
    const { ctx, biz } = makeStack("r2-canonical-wcp");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const done = completeLeaf(ctx, biz, wid);
    expect(String(done.status)).toBe("DONE");
    const mid = String((ctx.store.get("work_item", wid).mission_ids as string[])[0]);
    const wcp = wcpOf(ctx.store, wid)!;
    expect(String(wcp.mission_id)).toBe(mid);
    expect(anchorEvents(ctx.store, wid)).toHaveLength(1);
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", wid))).toBe(true);
  });
});

describe("P14-P3 R2 — REWORK event self-consistency + advanced basis", () => {
  it("P14-P3-R2-REWORK-EVENT-PINS-CANONICAL-CHILD-SET: the immutable REWORK event self-validates (child ids + digests)", () => {
    const { ctx, biz, wf } = makeStack("r2-rework-selfcontained");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const p = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const pid = String(p.work_item_id);
    const r = wf.decomposeWorkItem(pid, {
      decomposition_id: `DEC-R2SC-${counter}`,
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(a.agent_id) },
        { title: "c2", goal: "g2", assignee_agent_id: String(a.agent_id) },
      ],
    }, "op");
    const childIds = r.children.map((c) => String(c.work_item_id)).sort();
    for (const c of childIds) completeLeaf(ctx, biz, c);
    biz.evaluateParentCompletion(pid, "op");
    biz.reviewWorkItem(pid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    // The canonical REWORK event is self-contained AND self-validating:
    // canonical-sorted child ids, matching set digest, present basis pins.
    const evs = ctx.store.listEvents("work_item", pid)
      .filter((e) => String(e.event_type) === "WORK_REWORK_REQUESTED");
    expect(evs).toHaveLength(1);
    const md = evs[0]!.metadata as Record<string, unknown>;
    expect(md.child_work_item_ids).toEqual(childIds);
    expect(String(md.child_set_digest)).toBe(childSetDigest(childIds));
    expect(typeof md.rejected_child_basis_digest).toBe("string");
    expect(typeof md.rejected_basis_digest).toBe("string");
    // A malformed REWORK event (missing child-id pin) fails closed —
    // never silently ignored: the canonical basis evaluator throws on
    // the corrupt pin, and every downstream seam refuses to re-ground
    // review or completion on it.
    tamperEventMetadata(path.join(ctx.dir, "pair.db"), String(evs[0]!.event_id),
      (m) => { delete m.child_work_item_ids; });
    expect(errCode(() =>
      (biz as unknown as { completionBasis: (r: unknown) => unknown })
        .completionBasis(ctx.store.get("work_item", pid))))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    biz.reconcileWorkLifecycle();
    biz.evaluateParentCompletion(pid, "op");
    expect(String(ctx.store.get("work_item", pid).status)).toBe("READY");
    expect(wcpOf(ctx.store, pid)).toBeNull();
  });

  it("P14-P3-R2-PARENT-REWORK-ADVANCED-CHILD-BASIS-REVIEWABLE: a new canonical child completion unfences the parent — both directions hold", () => {
    const { ctx, biz, wf, dir } = makeStack("r2-advanced-basis");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const a2 = makeAgent(biz, String(b.business_id), "delegatee");
    const rev = makeAgent(biz, String(b.business_id), "reviewer");
    const p = makeItem(biz, String(b.business_id), {
      assignee_agent_id: a.agent_id, requires_review: true,
      reviewer_agent_id: String(rev.agent_id),
    });
    const pid = String(p.work_item_id);
    const r = wf.decomposeWorkItem(pid, {
      decomposition_id: `DEC-ADV-${counter}`,
      children: [
        { title: "c1", goal: "g1", assignee_agent_id: String(a.agent_id) },
        { title: "c2", goal: "g2", assignee_agent_id: String(a.agent_id) },
      ],
    }, "op");
    const c1 = String(r.children[0].work_item_id);
    const c2 = String(r.children[1].work_item_id);
    completeLeaf(ctx, biz, c1);
    completeLeaf(ctx, biz, c2);
    biz.evaluateParentCompletion(pid, "op");
    expect(String(ctx.store.get("work_item", pid).status)).toBe("REVIEW_REQUIRED");
    biz.reviewWorkItem(pid, {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK" }, "op");
    const reworkEvents = () => ctx.store.listEvents("work_item", pid)
      .filter((e) => String(e.event_type) === "WORK_REWORK_REQUESTED");
    expect(reworkEvents()).toHaveLength(1);
    const rejectedBasis = String(
      (reworkEvents()[0]!.metadata as Record<string, unknown>).rejected_basis_digest);
    // Same unchanged child basis stays fenced.
    biz.evaluateParentCompletion(pid, "op");
    biz.syncWorkItem(pid);
    expect(String(ctx.store.get("work_item", pid).status)).toBe("READY");
    expect(wcpOf(ctx.store, pid)).toBeNull();
    // A NEW canonical child (delegation — the supported additive edge,
    // no graph revision) completes under its own fresh authority: the
    // child basis digest advances past the rejected basis.
    const c3 = wf.delegateWorkItem({
      work_item_id: pid,
      delegated_to_agent_id: String(a2.agent_id),
      delegation_key: `DL-ADV-${counter}`,
      reason: "rework-followup",
    }, "op");
    const c3id = String(c3.work_item_id);
    const c3folded = completeLeaf(ctx, biz, c3id);
    // A delegated child inherits the parent's review policy — it is
    // legitimately complete only after the canonical review seam.
    expect(String(c3folded.status)).toBe("REVIEW_REQUIRED");
    biz.reviewWorkItem(c3id, {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    expect(String(ctx.store.get("work_item", c3id).status)).toBe("DONE");
    expect(wcpOf(ctx.store, c3id)).not.toBeNull();
    biz.evaluateParentCompletion(pid, "op");
    const advanced = ctx.store.get("work_item", pid);
    expect(String(advanced.status)).toBe("REVIEW_REQUIRED");
    // Reaching REVIEW_REQUIRED is itself the proof the live basis
    // digest differs from the pinned rejected basis — basis.rejected
    // would have fenced every evaluation above.
    expect(rejectedBasis).not.toBe("");
    // Restart preserves the unfence semantics — no dup evidence.
    const re = reopenStack(dir);
    re.biz.reconcileWorkLifecycle();
    const afterRestart = re.ctx.store.get("work_item", pid);
    expect(String(afterRestart.status)).toBe("REVIEW_REQUIRED");
    for (const cid of [c1, c2, c3id]) {
      expect(anchorEvents(re.ctx.store, cid)).toHaveLength(1);
    }
    expect(reworkEvents()).toHaveLength(1);
    // And the advanced basis accepts review canonically — exactly once.
    re.biz.reviewWorkItem(pid, {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT" }, "op");
    expect(String(re.ctx.store.get("work_item", pid).status)).toBe("DONE");
    expect(anchorEvents(re.ctx.store, pid)).toHaveLength(1);
    expect(acceptEvents(re.ctx.store, pid)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P14-P3 R3 — canonical plan manifest omission safety (audited R2 gaps).
// The task authority is the active plan's own `task_ids` manifest — never
// a task-table scan: missing declared tasks (omission), drifted declared
// tasks (mission_id / plan_id), and injected undeclared tasks all fail
// closed; so do a missing/foreign active plan row and forged plan-commit
// evidence.
// ---------------------------------------------------------------------------

/** A leaf whose bound mission completed canonically over a 2-task plan. */
function twoTaskCompletedLeaf(label: string) {
  const { ctx, biz } = makeStack(label);
  const b = makeBiz(biz, ctx.projectId);
  const a = makeAgent(biz, String(b.business_id), "lead");
  const w = makeItem(biz, String(b.business_id), {
    title: label, assignee_agent_id: String(a.agent_id) });
  const wid = String(w.work_item_id);
  biz.openWorkItem(wid, "op");
  const mid = String(
    (ctx.store.get("work_item", wid).mission_ids as string[]).at(-1));
  canonicallyCompleteMission(ctx.store, ctx.service, mid, { tasks: 2 });
  const planId = String(ctx.service.activeRevision(mid).plan_id);
  const declared = (ctx.store.get("plan", planId).task_ids as string[])
    .map(String);
  const dbPath = path.join(ctx.dir, "pair.db");
  return { ctx, biz, wid, mid, planId, declared, dbPath };
}

/** The completion proof fails AND no work surface advances (no
 *  REVIEW_REQUIRED / DONE / WCP — the item quarantines). */
function expectMissionProofFailsClosed(
  ctx: ReturnType<typeof makeCtxOn>,
  biz: ReturnType<typeof makeStack>["biz"],
  wid: string, mid: string,
) {
  expect(proveCanonicalMissionCompletion(
    ctx.store, ctx.store.get("mission", mid))).toBe(false);
  biz.syncWorkItem(wid);
  const row = ctx.store.get("work_item", wid);
  expect(["REVIEW_REQUIRED", "DONE"]).not.toContain(String(row.status));
  expect(String(row.blocked_code ?? "")).toBe("TERMINAL_PROVENANCE_CORRUPT");
  expect(wcpOf(ctx.store, wid)).toBeNull();
}

describe("P14-P3 R3 — canonical plan manifest omission safety", () => {
  it("P14-P3-R3-MISSING-DECLARED-PLAN-TASK-FAILS: a hard-deleted declared task voids mission completion", () => {
    const { ctx, biz, wid, mid, declared, dbPath } =
      twoTaskCompletedLeaf("r3-omit");
    deleteRow(dbPath, "task", declared[1]!);
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-DECLARED-TASK-PLAN-DRIFT-FAILS: a declared task claiming a foreign plan fails closed", () => {
    const { ctx, biz, wid, mid, declared } =
      twoTaskCompletedLeaf("r3-plandrift");
    const t = ctx.store.get("task", declared[0]!);
    t.plan_id = "PLN_FOREIGN";
    ctx.store.put("task", declared[0]!, t, Number(t.version));
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-DECLARED-TASK-MISSION-DRIFT-FAILS: a declared task claiming a foreign mission fails closed", () => {
    const { ctx, biz, wid, mid, declared } =
      twoTaskCompletedLeaf("r3-missiondrift");
    const t = ctx.store.get("task", declared[1]!);
    t.mission_id = "MSN_FOREIGN";
    ctx.store.put("task", declared[1]!, t, Number(t.version));
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-UNDECLARED-EXTRA-TASK-FAILS: an injected task claiming the active mission+plan fails closed", () => {
    const { ctx, biz, wid, mid, planId } =
      twoTaskCompletedLeaf("r3-inject");
    ctx.store.put("task", "TSK_INJECTED", {
      task_id: "TSK_INJECTED", task_key: "TX",
      mission_id: mid, plan_id: planId, order: 2,
      title: "injected", task_instruction: "i",
      status: "COMPLETED", created_at: utcnow(), version: 0 }, 0);
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-MISSING-ACTIVE-PLAN-ROW-FAILS: deleting the active plan row fails closed", () => {
    const { ctx, biz, wid, mid, planId, dbPath } =
      twoTaskCompletedLeaf("r3-noplan");
    deleteRow(dbPath, "plan", planId);
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-FOREIGN-ACTIVE-PLAN-ROW-FAILS: a plan row claiming a foreign mission fails closed", () => {
    const { ctx, biz, wid, mid, planId } =
      twoTaskCompletedLeaf("r3-foreignplan");
    const plan = ctx.store.get("plan", planId);
    plan.mission_id = "MSN_FOREIGN";
    ctx.store.put("plan", planId, plan, Number(plan.version));
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-PLAN-COMMIT-EVIDENCE-MISMATCH-FAILS: forged commit-anchor metadata fails closed", () => {
    const { ctx, biz, wid, mid, dbPath } =
      twoTaskCompletedLeaf("r3-commitforge");
    const anchor = ctx.store.listEvents("mission", mid)
      .find((e) => String(e.event_type) === "MISSION_PLAN_COMMITTED")!;
    tamperEventMetadata(dbPath, String(anchor.event_id),
      (m) => { m.revision = 999; });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R3-PLAN-TASK-MANIFEST-COMPLETE-PASSES: an intact multi-task manifest completes and mints WCP", () => {
    const { ctx, biz, wid, mid, declared } =
      twoTaskCompletedLeaf("r3-complete");
    expect(declared.length).toBe(2);
    expect(proveCanonicalMissionCompletion(
      ctx.store, ctx.store.get("mission", mid))).toBe(true);
    biz.syncWorkItem(wid);
    expect(String(ctx.store.get("work_item", wid).status)).toBe("DONE");
    const wcp = wcpOf(ctx.store, wid);
    expect(wcp).not.toBeNull();
    expect(String(wcp!.mission_id)).toBe(mid);
    // Re-validation stays clean — the manifest resolves identically.
    biz.reconcileWorkLifecycle();
    expect(String(ctx.store.get("work_item", wid).status)).toBe("DONE");
  });
});

// ---------------------------------------------------------------------------
// P14-P3 R4 — immutable plan-manifest anchor + omission-safe revision
// history. The complete task manifest is pinned inside the immutable
// MISSION_PLAN_COMMITTED event (task_ids + recomputed manifest digest);
// mutating plan.task_ids after commit can never satisfy the pin. The
// revision history must stay in exact bijection with the commit anchors
// — deleting the latest revision row cannot roll history backward.
// ---------------------------------------------------------------------------

/** Direct test seam: hard-delete a mission_plan_revisions row. */
function deletePlanRevisionRow(dbPath: string, missionId: string, revision: number) {
  const db = new Database(dbPath);
  db.prepare(
    "DELETE FROM mission_plan_revisions WHERE mission_id=? AND revision=?")
    .run(missionId, revision);
  db.close();
}

/** Two-task canonical mission; `extraRevisions` older committed plans. */
function revisedCompletedLeaf(label: string, extraRevisions = 0) {
  const { ctx, biz } = makeStack(label);
  const b = makeBiz(biz, ctx.projectId);
  const a = makeAgent(biz, String(b.business_id), "lead");
  const w = makeItem(biz, String(b.business_id), {
    title: label, assignee_agent_id: String(a.agent_id) });
  const wid = String(w.work_item_id);
  biz.openWorkItem(wid, "op");
  const mid = String(
    (ctx.store.get("work_item", wid).mission_ids as string[]).at(-1));
  const priorPlanIds: string[] = [];
  for (let i = 0; i < extraRevisions; i++) {
    const pr = ctx.service.commitPlan({
      mission_id: mid,
      tasks: [{ task_key: `OLD${i + 1}`, title: "old",
        task_instruction: "old", required_capabilities: [],
        depends_on: [] }],
      source: "TEST_CANONICAL", reason: "prior-revision",
      proposal: { ok: true } });
    priorPlanIds.push(pr.plan_id);
  }
  canonicallyCompleteMission(ctx.store, ctx.service, mid, { tasks: 2 });
  const planId = String(ctx.service.activeRevision(mid).plan_id);
  const declared = (ctx.store.get("plan", planId).task_ids as string[])
    .map(String);
  const dbPath = path.join(ctx.dir, "pair.db");
  return { ctx, biz, wid, mid, planId, declared, dbPath, priorPlanIds };
}

const mutatePlan = (
  ctx: ReturnType<typeof makeCtxOn>, planId: string,
  mutate: (plan: Record<string, unknown>) => void,
) => {
  const plan = ctx.store.get("plan", planId);
  mutate(plan);
  ctx.store.put("plan", planId, plan, Number(plan.version));
};

describe("P14-P3 R4 — immutable plan manifest + revision history", () => {
  it("P14-P3-R4-PLAN-MANIFEST-SHRINK-AFTER-TASK-DELETE-FAILS: shrunk manifest cannot satisfy the committed pin", () => {
    const { ctx, biz, wid, mid, planId, declared, dbPath } =
      revisedCompletedLeaf("r4-shrink");
    deleteRow(dbPath, "task", declared[1]!);
    mutatePlan(ctx, planId, (p) => { p.task_ids = [declared[0]]; });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-PLAN-MANIFEST-REORDER-FAILS: reordered task_ids diverge from the committed pin", () => {
    const { ctx, biz, wid, mid, planId, declared } =
      revisedCompletedLeaf("r4-reorder");
    mutatePlan(ctx, planId, (p) => {
      p.task_ids = [declared[1], declared[0]]; });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-PLAN-MANIFEST-EXPAND-FAILS: an added task id diverges from the committed pin", () => {
    const { ctx, biz, wid, mid, planId, declared } =
      revisedCompletedLeaf("r4-expand");
    mutatePlan(ctx, planId, (p) => {
      p.task_ids = [...declared, "TSK_LATE_ADD"]; });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-PLAN-MANIFEST-DIGEST-TAMPER-FAILS: forged manifest digest fails recompute", () => {
    const { ctx, biz, wid, mid, dbPath } =
      revisedCompletedLeaf("r4-digest");
    const anchor = ctx.store.listEvents("mission", mid)
      .find((e) => String(e.event_type) === "MISSION_PLAN_COMMITTED")!;
    tamperEventMetadata(dbPath, String(anchor.event_id),
      (m) => { m.plan_manifest_digest = "deadbeef".repeat(8); });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-PLAN-MANIFEST-INTACT-PASSES: committed manifest intact → completes + WCP", () => {
    const { ctx, biz, wid, mid } = revisedCompletedLeaf("r4-intact");
    expect(proveCanonicalMissionCompletion(
      ctx.store, ctx.store.get("mission", mid))).toBe(true);
    biz.syncWorkItem(wid);
    expect(String(ctx.store.get("work_item", wid).status)).toBe("DONE");
    expect(wcpOf(ctx.store, wid)).not.toBeNull();
  });

  it("P14-P3-R4-LATEST-PLAN-REVISION-DELETION-FAILS: deleting the latest revision row cannot roll history back", () => {
    const { ctx, biz, wid, mid, priorPlanIds, dbPath } =
      revisedCompletedLeaf("r4-delrev", 1);
    // Revisions: 1 (prior) + 2 (active). Delete the latest row AND roll
    // the mission pins back — the surviving rev-2 commit anchor still
    // proves the later plan existed.
    deletePlanRevisionRow(dbPath, mid, 2);
    const m = ctx.store.get("mission", mid);
    m.plan_id = priorPlanIds[0];
    m.plan_revision = 1;
    ctx.store.put("mission", mid, m, Number(m.version));
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-REVISION-WITHOUT-COMMIT-EVENT-FAILS: a history entry with no commit anchor fails closed", () => {
    const { ctx, biz, wid, mid } = revisedCompletedLeaf("r4-norev");
    ctx.store.recordPlanRevision({
      mission_id: mid, revision: 3, plan_id: "PLN_NEVER_COMMITTED",
      source: "FORGED_HISTORY", reason: "forge",
      proposal: { forged: true } });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-COMMIT-EVENT-WITHOUT-REVISION-FAILS: a commit anchor with no revision row fails closed", () => {
    const { ctx, biz, wid, mid } = revisedCompletedLeaf("r4-noev");
    ctx.store.event({
      entity_type: "mission", entity_id: mid,
      event_type: "MISSION_PLAN_COMMITTED", new_state: "PLN_GHOST",
      actor: "PAIR_PLAN_VALIDATOR",
      metadata: { revision: 9, task_ids: ["TSK_G"],
        plan_manifest_digest: "deadbeef".repeat(8) } });
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });

  it("P14-P3-R4-ACTIVE-REVISION-MUST-BE-HIGHEST-COMMITTED: mission pins rolled back to an older revision fail", () => {
    const { ctx, biz, wid, mid, priorPlanIds } =
      revisedCompletedLeaf("r4-rollback", 1);
    const m = ctx.store.get("mission", mid);
    m.plan_id = priorPlanIds[0];
    m.plan_revision = 1;
    ctx.store.put("mission", mid, m, Number(m.version));
    expectMissionProofFailsClosed(ctx, biz, wid, mid);
  });
});
