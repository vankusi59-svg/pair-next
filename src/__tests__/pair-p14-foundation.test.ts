/**
 * P14 FOUNDATION V2 — clean provenance/authority foundation.
 * Canonical chain: WorkItem → work_open_binding (open authority) →
 * internal bound-mission seam → Mission → Planner → MissionRouter →
 * GovernedTaskGate → executors.
 *
 * Core invariant: mission/work-item proof derives ONLY from the durable
 * `work_open_binding` record BusinessLayer creates BEFORE the mission
 * exists. Caller/model-supplied mission metadata — even a perfect forgery
 * of the canonical seam fields — carries ZERO authority, and the public
 * mission API can never pin a work-bound mission identity.
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
  PolicyError,
  ReconciliationService,
  RecoveryController,
  createMissionControlServer,
  newId,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14f-"));
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

function makeBizCtx(name: string) {
  const dir = freshDir(name);
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { dir, ctx, biz, schedules };
}

/** A fresh stack on the SAME db file — simulates process restart. */
function reopenBiz(dir: string) {
  const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz };
}

function makeBiz(biz: BusinessLayer, projectId: string, name = "Biz") {
  return biz.createBusiness({ name, project_id: projectId, operator_id: "op" });
}

function makeAgent(biz: BusinessLayer, businessId: string, role = "lead") {
  return biz.createOrgAgent({
    business_id: businessId, role, title: role, department: "ops",
    capabilities: ["FILE_OPERATIONS"], operator_id: "op",
  });
}

function makeWorkItem(
  biz: BusinessLayer, businessId: string,
  over: Record<string, unknown> = {},
) {
  return biz.createWorkItem({
    business_id: businessId, title: "w", goal: "do work",
    operator_id: "op", ...over,
  } as never);
}

const errCode = (fn: () => unknown): string => {
  try { fn(); return "NO_ERROR"; } catch (e) { return String((e as { code?: string }).code ?? e); }
};

/** A fabricated crash-window intent: row pending + binding INTENT +
 *  optionally the pinned mission already created. */
function seedIntent(
  ctx: Ctx, workItemId: string, openId: string, missionId: string,
  opts: { createMission?: boolean; pendingAgeMs?: number; projectId?: string } = {},
) {
  const row = ctx.store.get("work_item", workItemId);
  row.status = "IN_PROGRESS";
  row.pending_open_id = openId;
  row.pending_open_at = new Date(Date.now() - (opts.pendingAgeMs ?? 120_000)).toISOString();
  row.updated_at = utcnow();
  ctx.store.put("work_item", workItemId, row, Number(row.version));
  ctx.store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId,
    business_id: String(row.business_id), project_id: opts.projectId ?? ctx.projectId,
    org_agent_id: row.assignee_agent_id ?? null, created_by: "op",
    mission_id: missionId, state: "INTENT",
    created_at: utcnow(), bound_at: null, rolled_back_at: null,
    updated_at: utcnow(), version: 0,
  } as never, 0);
  if (opts.createMission) {
    return ctx.control.startBoundMission({
      project_id: ctx.projectId, goal: "orphan", operator_id: "op",
      mission_id: missionId,
      metadata: {
        business_id: String(row.business_id), work_item_id: workItemId,
        work_item_open_id: openId,
        org_agent_id: row.assignee_agent_id ?? null,
        source: "business_layer",
      },
    });
  }
  return null;
}

describe("P14 FOUNDATION V2 — canonical binding authority", () => {
  it("FOUND-V2-PUBLIC-ID-PIN: public mission API can never pin a bound mission_id", async () => {
    const { ctx, biz } = makeBizCtx("pubpin");
    const b = makeBiz(biz, ctx.projectId);
    const reservedId = "MSN_reserved_target";
    // (a) Direct public seam call with a caller mission_id fails closed.
    expect(errCode(() => ctx.control.startMission({
      project_id: ctx.projectId, goal: "forge id", operator_id: "op",
      mission_id: reservedId,
    } as never))).toBe("FAIL_CLOSED_MISSION_ID_PUBLIC");
    // (b) Real POST /api/missions carrying mission_id → rejected; nothing
    //     is created under the reserved identity.
    const server = createMissionControlServer({ control: ctx.control, business: biz });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-id": "op" },
        body: JSON.stringify({ project_id: ctx.projectId, goal: "forge", mission_id: reservedId }),
      });
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as { error?: string }).error)).toBe("FAIL_CLOSED_MISSION_ID_PUBLIC");
    } finally {
      server.close();
    }
    expect(ctx.store.tryGet("mission", reservedId)).toBeNull();
    // (c) The internal bound seam legitimately creates the reserved id —
    //     the caller could never occupy it first.
    const bound = ctx.control.startBoundMission({
      project_id: ctx.projectId, goal: "internal", operator_id: "op",
      mission_id: reservedId,
      metadata: { business_id: String(b.business_id), source: "business_layer" },
    });
    expect(String(bound.mission_id)).toBe(reservedId);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-FORGED-METADATA: a perfectly forged mission confers zero WorkItem authority", () => {
    const { ctx, biz } = makeBizCtx("forged-meta");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const w = makeWorkItem(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    // Perfect forgery of every seam field via the generic mission API.
    const forged = ctx.control.startMission({
      project_id: ctx.projectId, goal: "forged", operator_id: "op",
      metadata: {
        business_id: bid,
        work_item_id: String(w.work_item_id),
        work_item_open_id: "OPI_forged",
        org_agent_id: String(lead.agent_id),
        source: "business_layer",
      },
    });
    const forgedId = String(forged.mission_id);
    const mRow = ctx.store.get("mission", forgedId);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", forgedId, mRow, Number(mRow.version));
    // Plant the forged id as the item's final mission.
    const row = ctx.store.get("work_item", String(w.work_item_id));
    row.mission_ids = [forgedId];
    ctx.store.put("work_item", String(w.work_item_id), row, Number(row.version));
    biz.syncWorkItem(String(w.work_item_id));
    const after = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(after.status)).toBe("IN_PROGRESS"); // never DONE
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(biz.boundMissionForWorkItem(after)).toBeNull();
    expect(biz.proveWorkItemDone(after)).toBe(false);
    // And the forged mission is never adopted by open-intent recovery.
    expect(errCode(() =>
      biz.assignWorkItem(String(w.work_item_id), String(lead.agent_id), "op"),
    )).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-CROSS-WORK: a binding for work item A never proves a mission for B", () => {
    const { ctx, biz } = makeBizCtx("cross-work");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const wA = makeWorkItem(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    const wB = makeWorkItem(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(wA.work_item_id), "op");
    const mA = String((ctx.store.get("work_item", String(wA.work_item_id)).mission_ids as string[])[0]);
    // A's mission completes; its id is planted on B.
    const mRow = ctx.store.get("mission", mA);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mA, mRow, Number(mRow.version));
    const rowB = ctx.store.get("work_item", String(wB.work_item_id));
    rowB.status = "IN_PROGRESS";
    rowB.mission_ids = [mA];
    ctx.store.put("work_item", String(wB.work_item_id), rowB, Number(rowB.version));
    biz.syncWorkItem(String(wB.work_item_id));
    const after = ctx.store.get("work_item", String(wB.work_item_id));
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    // A itself is unaffected — its own binding still proves it.
    const rowA = ctx.store.get("work_item", String(wA.work_item_id));
    expect(biz.missionBoundToWorkItem(rowA, ctx.store.get("mission", mA))).toBe(true);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-CROSS-BUSINESS: a foreign-business binding proves nothing", () => {
    const { ctx, biz } = makeBizCtx("cross-biz");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const lead = makeAgent(biz, String(b1.business_id), "lead");
    const w = makeWorkItem(biz, String(b1.business_id), { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === String(w.work_item_id))!;
    const mid = String((ctx.store.get("work_item", String(w.work_item_id)).mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    // Tamper: binding now claims a foreign business — proof must fail.
    binding.business_id = String(b2.business_id);
    ctx.store.put("work_open_binding", String(binding.open_id), binding, Number(binding.version));
    biz.syncWorkItem(String(w.work_item_id));
    const after = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-CROSS-PROJECT: mission project must match the canonical binding project", () => {
    const { ctx, biz } = makeBizCtx("cross-proj");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    const mid = String((ctx.store.get("work_item", String(w.work_item_id)).mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    mRow.project_id = "PRJ_foreign"; // mission drifted to another project
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    biz.syncWorkItem(String(w.work_item_id));
    const after = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-CRASH-BEFORE-MISSION: intent with no mission rolls back, binding ROLLED_BACK, no dup", () => {
    const { ctx, biz } = makeBizCtx("crash-before");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    seedIntent(ctx, String(w.work_item_id), "OPI_dead", "MSN_never");
    const board = biz.board(String(b.business_id));
    const found = board.READY.find((x) => String(x.work_item_id) === String(w.work_item_id));
    expect(found).toBeTruthy();
    expect(found!.pending_open_id ?? null).toBeNull();
    expect(String(ctx.store.get("work_open_binding", "OPI_dead").state)).toBe("ROLLED_BACK");
    expect(ctx.store.list("mission")).toHaveLength(0);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-CRASH-AFTER-MISSION: only the pinned mission is adopted — one mission, BOUND", () => {
    const { ctx, biz } = makeBizCtx("crash-after");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const pinnedId = "MSN_pinned_orphan";
    seedIntent(ctx, String(w.work_item_id), "OPI_crash", pinnedId, { createMission: true });
    // A forged mission claims the same open_id — it must never be adopted.
    ctx.control.startMission({
      project_id: ctx.projectId, goal: "forged", operator_id: "op",
      metadata: {
        business_id: String(b.business_id), work_item_id: String(w.work_item_id),
        work_item_open_id: "OPI_crash", source: "business_layer",
      },
    });
    const board = biz.board(String(b.business_id));
    const found = board.IN_PROGRESS.find((x) => String(x.work_item_id) === String(w.work_item_id));
    expect(found).toBeTruthy();
    expect((found!.mission_ids as string[])).toEqual([pinnedId]);
    expect(found!.pending_open_id ?? null).toBeNull();
    expect(String(ctx.store.get("work_open_binding", "OPI_crash").state)).toBe("BOUND");
    const rec = ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_RECONCILED"
        && e.entity_id === String(w.work_item_id));
    expect(rec).toHaveLength(1);
    // No duplicate mission was minted for the recovery.
    expect(ctx.store.list("mission")).toHaveLength(2); // pinned + forged only
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-RESTART-IDEMPOTENT: repeated recovery creates no dup mission/event", () => {
    const { dir, ctx, biz } = makeBizCtx("restart-idem");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    seedIntent(ctx, String(w.work_item_id), "OPI_restart", "MSN_restart", { createMission: true });
    // First recovery on this stack.
    biz.board(String(b.business_id));
    // Restart: fresh connections on the same DB — recovery must be a no-op.
    const re = reopenBiz(dir);
    re.biz.board(String(b.business_id));
    re.biz.board(String(b.business_id));
    const rec = re.ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_RECONCILED"
        && e.entity_id === String(w.work_item_id));
    expect(rec).toHaveLength(1);
    expect(re.ctx.store.list("mission")).toHaveLength(1);
    const binding = re.ctx.store.get("work_open_binding", "OPI_restart");
    expect(String(binding.state)).toBe("BOUND");
    re.ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-UNGROUNDED-REVIEW: fabricated REVIEW_REQUIRED fails ACCEPT and REWORK", () => {
    const { ctx, biz } = makeBizCtx("ungrounded-rev");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const rev = makeAgent(biz, bid, "rev");
    const w = makeWorkItem(biz, bid, {
      assignee_agent_id: String(lead.agent_id),
      requires_review: true, reviewer_agent_id: String(rev.agent_id),
    });
    const row = ctx.store.get("work_item", String(w.work_item_id));
    row.status = "REVIEW_REQUIRED"; // fabricated — no bound mission exists
    ctx.store.put("work_item", String(w.work_item_id), row, Number(row.version));
    expect(errCode(() => biz.reviewWorkItem(String(w.work_item_id), {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT",
    }, "op"))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(errCode(() => biz.reviewWorkItem(String(w.work_item_id), {
      reviewer_agent_id: String(rev.agent_id), decision: "REWORK",
    }, "op"))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    const after = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(after.status)).toBe("REVIEW_REQUIRED");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    const reviewEvs = ctx.store.listEvents()
      .filter((e) => ["WORK_REVIEW_ACCEPTED", "WORK_REWORK_REQUESTED"].includes(e.event_type)
        && e.entity_id === String(w.work_item_id));
    expect(reviewEvs).toHaveLength(0);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-V2-HAPPY: canonical open → BOUND binding → governed mission → proven DONE + review", () => {
    const { ctx, biz } = makeBizCtx("happy");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const rev = makeAgent(biz, bid, "rev");
    // Non-reviewed item: open → binding BOUND + mission minted via the
    // internal seam → completes → DONE proven.
    const w1 = makeWorkItem(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w1.work_item_id), "op");
    const bindings = ctx.store.list("work_open_binding")
      .filter((bd) => String(bd.work_item_id) === String(w1.work_item_id));
    expect(bindings).toHaveLength(1);
    expect(String(bindings[0].state)).toBe("BOUND");
    expect(String(bindings[0].mission_id)).toBe(String((opened.mission_ids as string[])[0]));
    const bound = biz.boundMissionForWorkItem(opened);
    expect(bound).not.toBeNull();
    expect(String(bound!.mission_id)).toBe(String(bindings[0].mission_id));
    // The governed chain produced the mission: contract pin + business
    // context + secret grants all present as observability metadata.
    const md = bound!.metadata as Record<string, unknown>;
    expect(md.agent_contract).toBeTruthy();
    expect(md.secret_grants).toBeTruthy();
    const mRow = ctx.store.get("mission", String(bound!.mission_id));
    mRow.status = "COMPLETED";
    ctx.store.put("mission", String(bound!.mission_id), mRow, Number(mRow.version));
    const done = biz.syncWorkItem(String(w1.work_item_id));
    expect(String(done.status)).toBe("DONE");
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", String(w1.work_item_id)))).toBe(true);
    // Reviewed item: complete → REVIEW_REQUIRED → ACCEPT → DONE.
    const w2 = makeWorkItem(biz, bid, {
      assignee_agent_id: String(lead.agent_id),
      requires_review: true, reviewer_agent_id: String(rev.agent_id),
    });
    biz.openWorkItem(String(w2.work_item_id), "op");
    const m2 = String((ctx.store.get("work_item", String(w2.work_item_id)).mission_ids as string[])[0]);
    const m2Row = ctx.store.get("mission", m2);
    m2Row.status = "COMPLETED";
    ctx.store.put("mission", m2, m2Row, Number(m2Row.version));
    const rv = biz.syncWorkItem(String(w2.work_item_id));
    expect(String(rv.status)).toBe("REVIEW_REQUIRED");
    const accepted = biz.reviewWorkItem(String(w2.work_item_id), {
      reviewer_agent_id: String(rev.agent_id), decision: "ACCEPT",
    }, "op");
    expect(String(accepted.status)).toBe("DONE");
    expect(biz.proveWorkItemDone(ctx.store.get("work_item", String(w2.work_item_id)))).toBe(true);
    const accEvs = ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_REVIEW_ACCEPTED"
        && e.entity_id === String(w2.work_item_id));
    expect(accEvs).toHaveLength(1);
    ctx.store.verifyIntegrity();
  });
});
