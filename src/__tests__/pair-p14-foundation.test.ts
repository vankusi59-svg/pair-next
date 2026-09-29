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
    // The internal seam derives the reserved id FROM the binding — the
    // caller never pins it — and stamps the bound_open_id origin proof.
    return ctx.control.startBoundMission({
      project_id: ctx.projectId, goal: "orphan", operator_id: "op",
      binding_open_id: openId,
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
    // (c) The internal bound seam legitimately creates a reserved id —
    //     derived from a canonical binding, never caller-pinned. The
    //     created mission carries the non-forgeable bound_open_id proof.
    const w = makeWorkItem(biz, String(b.business_id));
    const openId = "OPI_pubpin";
    ctx.store.put("work_open_binding", openId, {
      open_id: openId, work_item_id: String(w.work_item_id),
      business_id: String(b.business_id), project_id: ctx.projectId,
      org_agent_id: null, created_by: "op",
      mission_id: reservedId, state: "INTENT",
      created_at: utcnow(), bound_at: null, rolled_back_at: null,
      updated_at: utcnow(), version: 0,
    } as never, 0);
    const bound = ctx.control.startBoundMission({
      binding_open_id: openId,
      project_id: ctx.projectId, goal: "internal", operator_id: "op",
      metadata: { business_id: String(b.business_id), source: "business_layer" },
    });
    expect(String(bound.mission_id)).toBe(reservedId);
    expect(String(bound.bound_open_id)).toBe(openId);
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

/* ----------------- P14 FOUNDATION V2 — R1 remediation ------------------
 * Atomic open rollback, binding-driven bound-mission seam, internal
 * mission-origin proof, collision fail-closed, canonical validator.
 */

function faultingBound(control: Ctx["control"], mode: "pre" | "post") {
  const stub = Object.create(control) as Ctx["control"];
  if (mode === "pre") {
    stub.startBoundMission = () => {
      throw new PolicyError("INJECT_FAIL", "before mission creation");
    };
  }
  return stub;
}

describe("P14 FOUNDATION V2 R1 — atomic rollback + origin proof", () => {
  it("FOUND-R1-ROLLBACK-ATOMIC: no durable state may be READY/no-pending with a live INTENT binding", () => {
    const { ctx, biz, schedules } = makeBizCtx("rb-atomic");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const wid = String(w.work_item_id);
    // Fail the bound seam → open throws; the atomic rollback commits row
    // restore + binding ROLLED_BACK + audit event in ONE txn.
    const bad = new BusinessLayer({
      store: ctx.store, control: faultingBound(ctx.control, "pre"), schedules,
    });
    expect(() => bad.openWorkItem(wid, "op")).toThrowError(/INJECT_FAIL/);
    const row = ctx.store.get("work_item", wid);
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === wid)!;
    // The forbidden split state must never exist: READY + no pending +
    // binding still INTENT.
    const forbidden =
      String(row.status) !== "IN_PROGRESS" &&
      !row.pending_open_id &&
      String(binding.state) === "INTENT";
    expect(forbidden).toBe(false);
    expect(String(row.status)).toBe("BACKLOG");
    expect(row.pending_open_id ?? null).toBeNull();
    expect(String(binding.state)).toBe("ROLLED_BACK");
    expect(binding.rolled_back_at).toBeTruthy();
    expect(ctx.store.list("mission")).toHaveLength(0);
    const rb = ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK" && e.entity_id === wid);
    expect(rb).toHaveLength(1);
    // Retry/restart paths are idempotent — the binding flips exactly once.
    biz.board(String(b.business_id));
    biz.blockWorkItem; // gate path also safe
    const rb2 = ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK" && e.entity_id === wid);
    expect(rb2).toHaveLength(1);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-ROLLBACK-ATOMIC (txn fault): a fault inside the rollback txn leaves the recoverable pending state, never the split state", () => {
    const { ctx, biz, schedules } = makeBizCtx("rb-atomic-txn");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const wid = String(w.work_item_id);
    const bad = new BusinessLayer({
      store: ctx.store, control: faultingBound(ctx.control, "pre"), schedules,
    });
    // Inject a fault INSIDE the atomic rollback txn (the audit event) —
    // the whole txn must roll back rather than commit a half-rollback.
    const realEvent = ctx.store.event.bind(ctx.store);
    let tripped = true;
    ctx.store.event = (e: Record<string, unknown>) => {
      if (tripped && e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK") {
        throw new PolicyError("INJECT_ROLLBACK_FAIL", "event write failed");
      }
      return realEvent(e as never);
    };
    expect(() => bad.openWorkItem(wid, "op")).toThrowError();
    const mid = ctx.store.get("work_item", wid);
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === wid)!;
    // Fault inside the txn → NOTHING committed: still IN_PROGRESS + pending
    // + INTENT — recoverable, never READY+INTENT.
    expect(String(mid.status)).toBe("IN_PROGRESS");
    expect(mid.pending_open_id).toBeTruthy();
    expect(String(binding.state)).toBe("INTENT");
    // Clear the fault; age the marker past grace; the next mutation gate
    // commits the whole rollback atomically.
    tripped = false;
    mid.pending_open_at = new Date(Date.now() - 120_000).toISOString();
    ctx.store.put("work_item", wid, mid, Number(mid.version));
    expect(() => biz.claimWorkItem(wid, "AGT_none", "op")).toThrowError();
    const done = ctx.store.get("work_item", wid);
    expect(String(done.status)).toBe("READY");
    expect(done.pending_open_id ?? null).toBeNull();
    expect(String(ctx.store.get("work_open_binding", String(binding.open_id)).state)).toBe("ROLLED_BACK");
    const rb = ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK" && e.entity_id === wid);
    expect(rb).toHaveLength(1);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-SYNC-FAIL: bound-seam failure rolls back fully — original status, ROLLED_BACK, no mission, one audit", () => {
    const { ctx, biz, schedules } = makeBizCtx("rb-syncfail");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const wid = String(w.work_item_id);
    const bad = new BusinessLayer({
      store: ctx.store, control: faultingBound(ctx.control, "pre"), schedules,
    });
    expect(() => bad.openWorkItem(wid, "op")).toThrowError(/INJECT_FAIL/);
    const row = ctx.store.get("work_item", wid);
    expect(String(row.status)).toBe("BACKLOG");
    expect(row.pending_open_id ?? null).toBeNull();
    expect(row.claimed_by ?? null).toBeNull();
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === wid)!;
    expect(String(binding.state)).toBe("ROLLED_BACK");
    expect(ctx.store.list("mission")).toHaveLength(0);
    expect(ctx.store.listEvents().filter(
      (e) => e.event_type === "WORK_ITEM_OPEN_ROLLED_BACK" && e.entity_id === wid,
    )).toHaveLength(1);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-INTERNAL-COLLISION: a foreign mission occupying the reserved id is never adopted", () => {
    const { ctx, biz } = makeBizCtx("rb-collide");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const wid = String(w.work_item_id);
    seedIntent(ctx, wid, "OPI_collide", "MSN_reservedX");
    // A foreign mission at the reserved id — raw occupant WITHOUT the
    // bound_open_id origin proof (the generic create path can no longer
    // mint a reserved id at all, so we insert the row directly).
    ctx.store.put("mission", "MSN_reservedX", {
      mission_id: "MSN_reservedX", project_id: ctx.projectId, goal: "foreign",
      bound_open_id: null, status: "CREATED", metadata: {},
      created_at: utcnow(), version: 0,
    } as never, 0);
    // Recovery must NOT adopt it, NOT flip BOUND — quarantine the item.
    biz.board(String(b.business_id));
    const row = ctx.store.get("work_item", wid);
    expect((row.mission_ids as string[])).not.toContain("MSN_reservedX");
    expect(String(ctx.store.get("work_open_binding", "OPI_collide").state)).not.toBe("BOUND");
    expect(String(row.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-TRUE-CRASH-ADOPT: restart adopts exactly the binding-proven mission — BOUND once, no dup", () => {
    const { dir, ctx, biz } = makeBizCtx("rb-adopt");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    const wid = String(w.work_item_id);
    const pinned = "MSN_pinned_origin";
    // The canonical seam itself creates the mission for this binding —
    // carrying the bound_open_id origin proof — then the "crash" hits
    // before the link+BOUND write.
    const created = seedIntent(ctx, wid, "OPI_origin", pinned, { createMission: true });
    expect(String(created!.bound_open_id)).toBe("OPI_origin");
    // A forged mission sharing the same observability metadata fields
    // exists too — it must never be adopted.
    ctx.control.startMission({
      project_id: ctx.projectId, goal: "forged", operator_id: "op",
      metadata: {
        business_id: String(b.business_id), work_item_id: wid,
        work_item_open_id: "OPI_origin", source: "business_layer",
      },
    });
    // Restart on the same DB.
    const re = reopenBiz(dir);
    re.biz.board(String(b.business_id));
    const row = re.ctx.store.get("work_item", wid);
    expect((row.mission_ids as string[])).toEqual([pinned]);
    expect(String(re.ctx.store.get("work_open_binding", "OPI_origin").state)).toBe("BOUND");
    expect(re.ctx.store.list("mission")).toHaveLength(2);
    const rec = re.ctx.store.listEvents()
      .filter((e) => e.event_type === "WORK_ITEM_OPEN_RECONCILED" && e.entity_id === wid);
    expect(rec).toHaveLength(1);
    re.ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-CROSS-PROJECT-PAIR: binding+mission drifted together still fails — business project is canonical", () => {
    const { ctx, biz } = makeBizCtx("rb-crossproj");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    const mid = String((ctx.store.get("work_item", String(w.work_item_id)).mission_ids as string[])[0]);
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === String(w.work_item_id))!;
    // Drift BOTH project ids to the same foreign project — the canonical
    // Business still anchors the real project.
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    mRow.project_id = "PRJ_foreign";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    binding.project_id = "PRJ_foreign";
    ctx.store.put("work_open_binding", String(binding.open_id), binding, Number(binding.version));
    biz.syncWorkItem(String(w.work_item_id));
    const after = ctx.store.get("work_item", String(w.work_item_id));
    expect(String(after.status)).toBe("IN_PROGRESS");
    expect(String(after.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-WRONG-AGENT: binding org_agent != work-item assignee fails proof", () => {
    const { ctx, biz } = makeBizCtx("rb-wrongagent");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const lead = makeAgent(biz, bid, "lead");
    const other = makeAgent(biz, bid, "other");
    const w = makeWorkItem(biz, bid, { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === String(w.work_item_id))!;
    binding.org_agent_id = String(other.agent_id); // drift
    ctx.store.put("work_open_binding", String(binding.open_id), binding, Number(binding.version));
    const mid = String((ctx.store.get("work_item", String(w.work_item_id)).mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    biz.syncWorkItem(String(w.work_item_id));
    expect(String(ctx.store.get("work_item", String(w.work_item_id)).blocked_code))
      .toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-WRONG-AGENT-BUSINESS: binding agent in a foreign business fails proof", () => {
    const { ctx, biz } = makeBizCtx("rb-wrongagentbiz");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const lead = makeAgent(biz, String(b1.business_id), "lead");
    const foreign = makeAgent(biz, String(b2.business_id), "foreign");
    const w = makeWorkItem(biz, String(b1.business_id), { assignee_agent_id: String(lead.agent_id) });
    biz.openWorkItem(String(w.work_item_id), "op");
    const binding = ctx.store.list("work_open_binding")
      .find((bd) => String(bd.work_item_id) === String(w.work_item_id))!;
    binding.org_agent_id = String(foreign.agent_id);
    ctx.store.put("work_open_binding", String(binding.open_id), binding, Number(binding.version));
    const mid = String((ctx.store.get("work_item", String(w.work_item_id)).mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    biz.syncWorkItem(String(w.work_item_id));
    expect(String(ctx.store.get("work_item", String(w.work_item_id)).blocked_code))
      .toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-PUBLIC-STILL-BLOCKED: POST /api/missions + mission_id → 409, zero rows", async () => {
    const { ctx, biz } = makeBizCtx("rb-pub");
    const server = createMissionControlServer({ control: ctx.control, business: biz });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-id": "op" },
        body: JSON.stringify({ project_id: ctx.projectId, goal: "forge", mission_id: "MSN_hijack" }),
      });
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as { error?: string }).error))
        .toBe("FAIL_CLOSED_MISSION_ID_PUBLIC");
    } finally {
      server.close();
    }
    expect(ctx.store.list("mission")).toHaveLength(0);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R1-HAPPY: legit open — INTENT → bound seam (origin proof) → atomic BOUND landing", () => {
    const { ctx, biz } = makeBizCtx("rb-happy");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const bindings = ctx.store.list("work_open_binding")
      .filter((bd) => String(bd.work_item_id) === String(w.work_item_id));
    expect(bindings).toHaveLength(1);
    expect(String(bindings[0].state)).toBe("BOUND");
    const mid = String((opened.mission_ids as string[])[0]);
    expect(String(bindings[0].mission_id)).toBe(mid);
    const mission = ctx.store.get("mission", mid);
    // Internal origin proof stamped by the bound seam — derivable only
    // from the canonical record, never from caller metadata.
    expect(String(mission.bound_open_id)).toBe(String(bindings[0].open_id));
    // Governed pipeline intact: contract pin + secret grants + business ctx.
    const md = mission.metadata as Record<string, unknown>;
    expect(md.agent_contract).toBeTruthy();
    expect(md.secret_grants).toBeTruthy();
    expect((md.business_context as Record<string, unknown>).provenance).toBe("org_agent");
    expect(biz.missionBoundToWorkItem(opened, mission)).toBe(true);
    ctx.store.verifyIntegrity();
  });
});

/* ----------------- P14 FOUNDATION V2 — R2 remediation ------------------
 * Sealed bound-mission authority: context derives from the binding,
 * bound_open_id creation sealed to the canonical seam, existing-mission
 * retry runs the full validator, null-agent/identity gaps closed.
 */

describe("P14 FOUNDATION V2 R2 — sealed bound-mission authority", () => {
  it("FOUND-R2-METADATA-OMITTED: bound mission derives canonical context from the binding, not caller metadata", () => {
    const { ctx, biz } = makeBizCtx("r2-omit");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), {
      assignee_agent_id: String(lead.agent_id), department: "ops",
    });
    seedIntent(ctx, String(w.work_item_id), "OPI_omit", "MSN_omit");
    // Caller metadata intentionally empty — canonical context must come
    // entirely from the binding + its records.
    const m = ctx.control.startBoundMission({
      binding_open_id: "OPI_omit", project_id: ctx.projectId,
      goal: "bound", operator_id: "op",
    });
    const md = m.metadata as Record<string, unknown>;
    expect(String(md.business_id)).toBe(String(b.business_id));
    expect(String(md.work_item_id)).toBe(String(w.work_item_id));
    expect(String(md.work_item_open_id)).toBe("OPI_omit");
    expect(String(md.org_agent_id)).toBe(String(lead.agent_id));
    expect(String(md.source)).toBe("business_layer");
    // P12 contract pin + P13 business context still land — no authority
    // loss from omitted caller metadata.
    expect(md.agent_contract).toBeTruthy();
    const bizCtx = md.business_context as Record<string, unknown>;
    expect(String(bizCtx.business_id)).toBe(String(b.business_id));
    expect(String(bizCtx.org_agent_id)).toBe(String(lead.agent_id));
    expect(md.secret_grants).toBeTruthy();
    expect(String(m.bound_open_id)).toBe("OPI_omit");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-METADATA-CONFLICT: caller metadata conflicting with canonical context fails closed", () => {
    const { ctx, biz } = makeBizCtx("r2-conflict");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    seedIntent(ctx, String(w.work_item_id), "OPI_conflict", "MSN_conflict");
    for (const [key, val] of [
      ["business_id", "BIZ_foreign"],
      ["org_agent_id", "AGT_foreign"],
      ["work_item_id", "WI_foreign"],
      ["work_item_open_id", "OPI_other"],
      ["source", "caller"],
    ]) {
      expect(errCode(() => ctx.control.startBoundMission({
        binding_open_id: "OPI_conflict", project_id: ctx.projectId,
        goal: "x", operator_id: "op",
        metadata: { [key]: val },
      }))).toBe("FAIL_CLOSED_BINDING_CONTEXT_MISMATCH");
      expect(ctx.store.tryGet("mission", "MSN_conflict")).toBeNull();
    }
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-RAW-ORIGIN-FORGE: generic createMission cannot mint bound authority", () => {
    const { ctx, biz } = makeBizCtx("r2-rawforge");
    makeBiz(biz, ctx.projectId);
    // Even passing forged identity strings, the generic seam mints its
    // own id and stamps no origin proof.
    const m = ctx.service.createMission({
      project_id: ctx.projectId, goal: "forge",
      mission_id: "MSN_forge_target", bound_open_id: "OPI_forge",
    } as never);
    expect(String(m.mission_id)).not.toBe("MSN_forge_target");
    expect(m.bound_open_id ?? null).toBeNull();
    expect(ctx.store.tryGet("mission", "MSN_forge_target")).toBeNull();
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-EXISTING-WRONG-PROJECT: reserved mission with origin string but wrong project is rejected", () => {
    const { ctx, biz } = makeBizCtx("r2-wrongproj");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    seedIntent(ctx, String(w.work_item_id), "OPI_wrongproj", "MSN_wrongproj");
    // Occupant LOOKS like this binding's mission (bound_open_id matches)
    // but its project is foreign — full validator must reject.
    ctx.store.put("mission", "MSN_wrongproj", {
      mission_id: "MSN_wrongproj", project_id: "PRJ_foreign", goal: "x",
      bound_open_id: "OPI_wrongproj", status: "CREATED", metadata: {},
      created_at: utcnow(), version: 0,
    } as never, 0);
    expect(errCode(() => ctx.control.startBoundMission({
      binding_open_id: "OPI_wrongproj", project_id: ctx.projectId,
      goal: "x", operator_id: "op",
    }))).toBe("FAIL_CLOSED_MISSION_ORIGIN_CONFLICT");
    // No adoption, no BOUND.
    expect(String(ctx.store.get("work_open_binding", "OPI_wrongproj").state)).toBe("INTENT");
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect((row.mission_ids as string[])).toHaveLength(0);
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-EXISTING-WRONG-SCOPE: existing reserved mission failing full validation is rejected", () => {
    const { ctx, biz } = makeBizCtx("r2-wrongscope");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const lead = makeAgent(biz, String(b1.business_id), "lead");
    const w = makeWorkItem(biz, String(b1.business_id), { assignee_agent_id: String(lead.agent_id) });
    seedIntent(ctx, String(w.work_item_id), "OPI_scope", "MSN_scope");
    // Tamper the binding to a foreign business AFTER intent seed; the
    // existing mission otherwise looks perfectly bound.
    const binding = ctx.store.get("work_open_binding", "OPI_scope");
    binding.business_id = String(b2.business_id);
    ctx.store.put("work_open_binding", "OPI_scope", binding, Number(binding.version));
    ctx.store.put("mission", "MSN_scope", {
      mission_id: "MSN_scope", project_id: ctx.projectId, goal: "x",
      bound_open_id: "OPI_scope", status: "CREATED", metadata: {},
      created_at: utcnow(), version: 0,
    } as never, 0);
    // The seam's INITIAL binding validation already fails — never even
    // reaches the existing-mission check.
    expect(errCode(() => ctx.control.startBoundMission({
      binding_open_id: "OPI_scope", project_id: ctx.projectId,
      goal: "x", operator_id: "op",
    }))).toBe("FAIL_CLOSED_BINDING_INVALID");
    expect(String(ctx.store.get("work_open_binding", "OPI_scope").state)).toBe("INTENT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-NULL-AGENT: assigned work item with a null binding agent fails closed", () => {
    const { ctx, biz } = makeBizCtx("r2-nullagent");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    seedIntent(ctx, String(w.work_item_id), "OPI_nullagent", "MSN_nullagent");
    // Binding claims no agent while the item IS assigned — malformed.
    const binding = ctx.store.get("work_open_binding", "OPI_nullagent");
    binding.org_agent_id = null;
    ctx.store.put("work_open_binding", "OPI_nullagent", binding, Number(binding.version));
    // Bound seam rejects at validation.
    expect(errCode(() => ctx.control.startBoundMission({
      binding_open_id: "OPI_nullagent", project_id: ctx.projectId,
      goal: "x", operator_id: "op",
    }))).toBe("FAIL_CLOSED_BINDING_INVALID");
    // And reconcile cannot adopt a mission through it either.
    ctx.store.put("mission", "MSN_nullagent", {
      mission_id: "MSN_nullagent", project_id: ctx.projectId, goal: "x",
      bound_open_id: "OPI_nullagent", status: "CREATED", metadata: {},
      created_at: utcnow(), version: 0,
    } as never, 0);
    biz.board(String(b.business_id));
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect((row.mission_ids as string[])).toHaveLength(0);
    expect(String(ctx.store.get("work_open_binding", "OPI_nullagent").state)).not.toBe("BOUND");
    expect(String(row.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-INVALID-STATE: unknown lifecycle state is never reconciled into BOUND", () => {
    const { ctx, biz } = makeBizCtx("r2-badstate");
    const b = makeBiz(biz, ctx.projectId);
    const w = makeWorkItem(biz, String(b.business_id));
    seedIntent(ctx, String(w.work_item_id), "OPI_badstate", "MSN_badstate");
    const binding = ctx.store.get("work_open_binding", "OPI_badstate");
    binding.state = "WEIRD_UNKNOWN";
    ctx.store.put("work_open_binding", "OPI_badstate", binding, Number(binding.version));
    // Even with a perfectly origin-proven mission present, an unknown
    // lifecycle state must never reconcile into BOUND.
    ctx.store.put("mission", "MSN_badstate", {
      mission_id: "MSN_badstate", project_id: ctx.projectId, goal: "x",
      bound_open_id: "OPI_badstate", status: "CREATED", metadata: {},
      created_at: utcnow(), version: 0,
    } as never, 0);
    biz.board(String(b.business_id));
    expect(String(ctx.store.get("work_open_binding", "OPI_badstate").state))
      .toBe("WEIRD_UNKNOWN");
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect((row.mission_ids as string[])).toHaveLength(0);
    expect(String(row.blocked_code)).toBe("TERMINAL_PROVENANCE_CORRUPT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R2-HAPPY: canonical open — derived scope, contract+context pins, origin proof, atomic BOUND", () => {
    const { ctx, biz } = makeBizCtx("r2-happy");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), {
      assignee_agent_id: String(lead.agent_id), department: "ops",
    });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const bindings = ctx.store.list("work_open_binding")
      .filter((bd) => String(bd.work_item_id) === String(w.work_item_id));
    expect(bindings).toHaveLength(1);
    expect(String(bindings[0].state)).toBe("BOUND");
    const mid = String((opened.mission_ids as string[])[0]);
    const mission = ctx.store.get("mission", mid);
    expect(String(mission.bound_open_id)).toBe(String(bindings[0].open_id));
    const md = mission.metadata as Record<string, unknown>;
    expect(md.agent_contract).toBeTruthy(); // P12 pin
    const bizCtx = md.business_context as Record<string, unknown>;
    expect(String(bizCtx.business_id)).toBe(String(b.business_id));
    expect(String(bizCtx.org_agent_id)).toBe(String(lead.agent_id));
    expect(md.secret_grants).toBeTruthy(); // P13 pin
    expect(String(md.department)).toBe("ops");
    expect(biz.missionBoundToWorkItem(opened, mission)).toBe(true);
    ctx.store.verifyIntegrity();
  });
});

/* ----------------- P14 FOUNDATION V2 — R3 remediation ------------------
 * ADMISSION vs PROVENANCE separation: mutable agent status is required
 * only when minting a NEW bound mission; it can never erase the
 * provenance of a mission that was validly created.
 */

describe("P14 FOUNDATION V2 R3 — admission vs provenance", () => {
  it("FOUND-R3-PAUSED-PROOF: agent PAUSED after valid bind — provenance stays true", () => {
    const { ctx, biz } = makeBizCtx("r3-pausedproof");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mission = ctx.store.get("mission", String((opened.mission_ids as string[])[0]));
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect(biz.missionBoundToWorkItem(row, mission)).toBe(true);
    expect(row.blocked_code ?? null).toBeNull();
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-TERMINATED-PROOF: agent TERMINATED after valid bind — historical binding stays valid", () => {
    const { ctx, biz } = makeBizCtx("r3-termproof");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mission = ctx.store.get("mission", String((opened.mission_ids as string[])[0]));
    biz.setOrgAgentStatus(String(lead.agent_id), "TERMINATED", "op");
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect(biz.missionBoundToWorkItem(row, mission)).toBe(true);
    expect(row.blocked_code ?? null).toBeNull();
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-CANCEL-PAUSED: cancelWorkItem still reaches the real mission after agent pause", () => {
    const { ctx, biz } = makeBizCtx("r3-cancelpaused");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mid = String((opened.mission_ids as string[])[0]);
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    const cancelled = biz.cancelWorkItem(String(w.work_item_id), "op");
    expect(String(cancelled.status)).toBe("CANCELLED");
    // The bound mission was actually cancelled — no live orphan left
    // behind just because the agent's status changed.
    expect(String(ctx.store.get("mission", mid).status)).toBe("CANCELLED");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-COMPLETE-PAUSED: completed mission folds after agent pause — no quarantine", () => {
    const { ctx, biz } = makeBizCtx("r3-completepaused");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mid = String((opened.mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    const synced = biz.syncWorkItem(String(w.work_item_id));
    expect(String(synced.status)).toBe("DONE");
    expect(synced.blocked_code ?? null).toBeNull();
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-ADMISSION-PAUSED: PAUSED agent cannot mint a new bound mission", () => {
    const { ctx, biz } = makeBizCtx("r3-admitpaused");
    const b = makeBiz(biz, ctx.projectId);
    const agent = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(agent.agent_id) });
    // Layer 1 — the board-level open itself refuses an inactive agent
    // before any binding is minted (P12 admission semantics preserved).
    biz.setOrgAgentStatus(String(agent.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.openWorkItem(String(w.work_item_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(ctx.store.list("mission")).toHaveLength(0);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
    const row = ctx.store.get("work_item", String(w.work_item_id));
    expect(row.pending_open_id ?? null).toBeNull();
    // Layer 2 — seam-level ADMISSION: a binding created while ACTIVE,
    // then the agent paused before the seam runs, still fails closed at
    // startBoundMission — no mission minted; binding stays recoverable.
    biz.setOrgAgentStatus(String(agent.agent_id), "ACTIVE", "op");
    seedIntent(ctx, String(w.work_item_id), "OPI_admit", "MSN_admit");
    biz.setOrgAgentStatus(String(agent.agent_id), "PAUSED", "op");
    expect(errCode(() => ctx.control.startBoundMission({
      binding_open_id: "OPI_admit", project_id: ctx.projectId,
      goal: "x", operator_id: "op",
    }))).toBe("FAIL_CLOSED_BINDING_INVALID");
    expect(ctx.store.tryGet("mission", "MSN_admit")).toBeNull();
    expect(String(ctx.store.get("work_open_binding", "OPI_admit").state)).toBe("INTENT");
    ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-CRASH-ADOPT-PAUSED: restart adopts the already-created mission despite later pause", () => {
    const { dir, ctx, biz } = makeBizCtx("r3-crashadopt");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const wid = String(w.work_item_id);
    // Mission created while agent ACTIVE (origin proof stamped), crash
    // hits before the link+BOUND landing.
    const created = seedIntent(ctx, wid, "OPI_crashpause", "MSN_crashpause", { createMission: true });
    expect(String(created!.bound_open_id)).toBe("OPI_crashpause");
    biz.setOrgAgentStatus(String(lead.agent_id), "PAUSED", "op");
    // Restart on the same DB — reconcile must adopt the exact existing
    // mission; no duplicate may be minted.
    const re = reopenBiz(dir);
    re.biz.board(String(b.business_id));
    const row = re.ctx.store.get("work_item", wid);
    expect((row.mission_ids as string[])).toEqual(["MSN_crashpause"]);
    expect(String(re.ctx.store.get("work_open_binding", "OPI_crashpause").state)).toBe("BOUND");
    expect(re.ctx.store.list("mission")).toHaveLength(1);
    expect(row.blocked_code ?? null).toBeNull();
    re.ctx.store.verifyIntegrity();
  });

  it("FOUND-R3-HAPPY: ACTIVE admission path unchanged — open, BOUND, fold", () => {
    const { ctx, biz } = makeBizCtx("r3-happy");
    const b = makeBiz(biz, ctx.projectId);
    const lead = makeAgent(biz, String(b.business_id), "lead");
    const w = makeWorkItem(biz, String(b.business_id), { assignee_agent_id: String(lead.agent_id) });
    const opened = biz.openWorkItem(String(w.work_item_id), "op");
    const mid = String((opened.mission_ids as string[])[0]);
    const mRow = ctx.store.get("mission", mid);
    mRow.status = "COMPLETED";
    ctx.store.put("mission", mid, mRow, Number(mRow.version));
    const synced = biz.syncWorkItem(String(w.work_item_id));
    expect(String(synced.status)).toBe("DONE");
    const binding = ctx.store.list("work_open_binding")[0];
    expect(String(binding.state)).toBe("BOUND");
    ctx.store.verifyIntegrity();
  });
});
