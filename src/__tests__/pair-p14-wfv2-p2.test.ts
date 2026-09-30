/**
 * P14 WORKFORCE V2 PHASE 2 — canonical claim lease + heartbeat + durable
 * inbox. Coordination only: leases/messages NEVER grant execution
 * authority — openWorkItem → work_open_binding → bound mission remains
 * the only path to work.
 *
 * Invariants under test:
 *  - claim authority lives in work_claim_lease WCL_<work_item_id> rows —
 *    work_item.claimed_by/claim_expires_at/claim_token are observability
 *    mirrors only (never consulted, never token material);
 *  - raw claim tokens are returned ONLY at claim creation; only their
 *    digest is persisted;
 *  - expiry is deterministic (fenced EXPIRED at reconcile or next
 *    mutation); reclaim mints epoch+1 with a fresh token; a stale token
 *    can never touch a newer epoch;
 *  - heartbeat renews by server-bounded TTL only — no caller TTL, no
 *    rotation, stale epoch/token/expired lease all fail closed;
 *  - lease expiry is NOT executor liveness: no mission cancel/redispatch;
 *  - legacy mirror claims without a WCL are phantoms — cleared, never
 *    adopted, never usable to bypass the lease;
 *  - workforce_message rows are append-only communication; receipts
 *    (WIR_<mid>_<agent>) acknowledge to the exact intended recipient,
 *    idempotently; HANDOFF_REQUEST mutates zero authority;
 *  - restart reconcile re-validates every WCL/message/receipt,
 *    deterministically fences expiry, repairs safe mirrors, is
 *    idempotent, and never fabricates.
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
  claimLeaseDigest,
  createMissionControlServer,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14wfv2p2-"));
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

const leaseOf = (ctx: Ctx["ctx"] | { store: PairEvidenceStore }, wid: string) =>
  (ctx.store.get("work_claim_lease", `WCL_${wid}`) ?? null) as Record<string, unknown> | null;
const tryLease = (store: PairEvidenceStore, wid: string) =>
  store.tryGet("work_claim_lease", `WCL_${wid}`) as Record<string, unknown> | null;

/** Rewind a lease's whole window coherently so it is validly expired —
 *  ordering invariant kept (issued<hb<exp), digest recomputed: this
 *  simulates a lease whose server TTL elapsed, not a forgery. */
function expireLease(store: PairEvidenceStore, wid: string) {
  const l = store.get("work_claim_lease", `WCL_${wid}`) as Record<string, unknown>;
  l.issued_at = "2000-01-01T00:00:00.000Z";
  l.last_heartbeat_at = "2000-01-01T00:00:01.000Z";
  l.expires_at = "2000-01-01T00:00:30.000Z";
  l.lease_digest = claimLeaseDigest(l);
  store.put("work_claim_lease", `WCL_${wid}`, l, Number(l.version));
}

const leaseEvents = (store: PairEvidenceStore, type: string, wid?: string) =>
  store.listEvents().filter((e) => String(e.event_type) === type &&
    (wid === undefined || String(e.entity_id) === wid));

// ---------------------------------------------------------------------

describe("P14-P2 CLAIM — canonical lease creation + eligibility", () => {
  it("P14-P2-CLAIM-HAPPY: assignee claims → one ACTIVE lease, digest-only token, mirror set", () => {
    const { ctx, biz } = makeStack("claim-happy");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    // raw token returned exactly once at creation
    expect(String(c.claim_token)).toMatch(/^CLM_/);
    const lease = leaseOf(ctx, wid)!;
    expect(String(lease.state)).toBe("ACTIVE");
    expect(Number(lease.lease_epoch)).toBe(1);
    expect(String(lease.claimant_agent_id)).toBe(String(a.agent_id));
    // only the digest is persisted — never the raw token
    expect(String(lease.token_digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(lease.token_digest)).not.toBe(String(c.claim_token));
    expect(JSON.stringify(lease)).not.toContain(String(c.claim_token));
    // mirrors are observability only — mirror token stays null
    const row = ctx.store.get("work_item", wid);
    expect(String(row.claimed_by)).toBe(String(a.agent_id));
    expect(row.claim_token ?? null).toBeNull();
    // safe read view exposes no token material at all
    const view = biz.getWorkItemClaim(wid)!;
    expect(view.claim_token).toBeUndefined();
    expect(view.token_digest).toBeUndefined();
    expect(leaseEvents(ctx.store, "WORK_CLAIM_ACQUIRED", wid)).toHaveLength(1);
  });

  it("P14-P2-CLAIM-WRONG-ASSIGNEE: non-assignee cannot claim", () => {
    const { ctx, biz } = makeStack("claim-wrong");
    const b = makeBiz(biz, ctx.projectId);
    const a1 = makeAgent(biz, String(b.business_id), "lead");
    const a2 = makeAgent(biz, String(b.business_id), "other");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a1.agent_id });
    expect(errCode(() => biz.claimWorkItem(String(w.work_item_id), String(a2.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_CLAIM_ASSIGNEE_MISMATCH");
    expect(tryLease(ctx.store, String(w.work_item_id))).toBeNull();
  });

  it("P14-P2-CLAIM-UNASSIGNED: unassigned item cannot be claimed", () => {
    const { ctx, biz } = makeStack("claim-unassigned");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id));
    expect(errCode(() => biz.claimWorkItem(String(w.work_item_id), String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_UNASSIGNED");
    expect(tryLease(ctx.store, String(w.work_item_id))).toBeNull();
  });

  it("P14-P2-CLAIM-CROSS-BUSINESS: claimant in another business fails closed", () => {
    const { ctx, biz } = makeStack("claim-xbiz");
    const b1 = makeBiz(biz, ctx.projectId, "B1");
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const a1 = makeAgent(biz, String(b1.business_id), "lead");
    const foreign = makeAgent(biz, String(b2.business_id), "foreign");
    const w = makeItem(biz, String(b1.business_id), { assignee_agent_id: a1.agent_id });
    expect(errCode(() => biz.claimWorkItem(String(w.work_item_id), String(foreign.agent_id), "op")))
      .toMatch(/^FAIL_CLOSED_AGENT_BUSINESS_MISMATCH|FAIL_CLOSED_WORK_ITEM_CLAIM_ASSIGNEE_MISMATCH$/);
  });

  it("P14-P2-CLAIM-INACTIVE-AGENT: PAUSED claimant fails closed", () => {
    const { ctx, biz } = makeStack("claim-inactive");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    biz.setOrgAgentStatus(String(a.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.claimWorkItem(String(w.work_item_id), String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_INACTIVE");
    expect(tryLease(ctx.store, String(w.work_item_id))).toBeNull();
  });

  it("P14-P2-CLAIM-DISABLED-CONTRACT: disabled contract fails admission", () => {
    const { ctx, biz } = makeStack("claim-contract");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    biz.upsertAgentContract(String(a.agent_id), "op", { allowed_capabilities: ["FILE_OPERATIONS"] });
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    biz.setAgentContractStatus(String(a.agent_id), "DISABLED", "op");
    expect(errCode(() => biz.claimWorkItem(String(w.work_item_id), String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
    expect(tryLease(ctx.store, String(w.work_item_id))).toBeNull();
  });

  it("P14-P2-CLAIM-CONCURRENT-SINGLE-WINNER: two connections race — one lease", () => {
    const { dir, ctx, biz, schedules } = makeStack("claim-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    // second sqlite connection on the same DB — a real concurrent claimant
    const store2 = new PairEvidenceStore(path.join(dir, "pair.db"));
    const biz2 = new BusinessLayer({ store: store2, control: ctx.control, schedules });
    const c1 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expect(String(c1.claim_token)).toMatch(/^CLM_/);
    expect(errCode(() => biz2.claimWorkItem(wid, String(a.agent_id), "op")))
      .toMatch(/FAIL_CLOSED_WORK_ITEM_CLAIM_ALREADY_HELD|FAIL_CLOSED_VERSION_CONFLICT/);
    expect(ctx.store.list("work_claim_lease").filter((l) =>
      String(l.work_item_id) === wid)).toHaveLength(1);
    store2.close();
  });
});

describe("P14-P2 HEARTBEAT — renewal + fencing", () => {
  function claimed(ctx: Ctx["ctx"], biz: BusinessLayer, role = "lead") {
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), role);
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const c = biz.claimWorkItem(String(w.work_item_id), String(a.agent_id), "op");
    return { b, a, wid: String(w.work_item_id), token: String(c.claim_token) };
  }

  it("P14-P2-HEARTBEAT-HAPPY: renews expiry by server TTL, same epoch/token digest", () => {
    const { ctx, biz } = makeStack("hb-happy");
    const { a, wid, token } = claimed(ctx, biz);
    const before = leaseOf(ctx, wid)!;
    const v = biz.heartbeatWorkItem(wid, String(a.agent_id), token, "op");
    const after = leaseOf(ctx, wid)!;
    expect(String(after.state)).toBe("ACTIVE");
    expect(Number(after.lease_epoch)).toBe(1); // no rotation
    expect(String(after.token_digest)).toBe(String(before.token_digest));
    expect(String(v.expires_at)).toBe(String(after.expires_at));
    // safe view — no token fields
    expect(v.claim_token).toBeUndefined();
    expect(v.token_digest).toBeUndefined();
    expect(leaseEvents(ctx.store, "WORK_CLAIM_HEARTBEAT", wid)).toHaveLength(1);
    // mirror tracks renewed expiry
    expect(String(ctx.store.get("work_item", wid).claim_expires_at))
      .toBe(String(after.expires_at));
  });

  it("P14-P2-HEARTBEAT-WRONG-TOKEN: bad token fails closed, lease untouched", () => {
    const { ctx, biz } = makeStack("hb-wrong-token");
    const { a, wid } = claimed(ctx, biz);
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), "CLM_wrong", "op")))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    expect(String(leaseOf(ctx, wid)!.state)).toBe("ACTIVE");
  });

  it("P14-P2-HEARTBEAT-WRONG-AGENT: another agent's heartbeat fails closed", () => {
    const { ctx, biz } = makeStack("hb-wrong-agent");
    const { a, wid, token } = claimed(ctx, biz);
    const other = makeAgent(biz, String(ctx.store.get("work_item", wid).business_id), "other");
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(other.agent_id), token, "op")))
      .toBe("FAIL_CLOSED_WORK_CLAIM_CLAIMANT");
  });

  it("P14-P2-HEARTBEAT-EXPIRED: expired lease fenced EXPIRED, heartbeat fails", () => {
    const { ctx, biz } = makeStack("hb-expired");
    const { a, wid, token } = claimed(ctx, biz);
    expireLease(ctx.store, wid);
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), token, "op")))
      .toBe("FAIL_CLOSED_WORK_CLAIM_EXPIRED");
    expect(String(leaseOf(ctx, wid)!.state)).toBe("EXPIRED");
    expect(leaseEvents(ctx.store, "WORK_CLAIM_EXPIRED", wid)).toHaveLength(1);
  });

  it("P14-P2-HEARTBEAT-STALE-EPOCH: epoch-1 token cannot touch epoch-2 lease", () => {
    const { ctx, biz } = makeStack("hb-stale-epoch");
    const { a, wid, token } = claimed(ctx, biz);
    expireLease(ctx.store, wid);
    const c2 = biz.claimWorkItem(wid, String(a.agent_id), "op"); // epoch 2
    expect(Number(leaseOf(ctx, wid)!.lease_epoch)).toBe(2);
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), token, "op")))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    // new token works
    const v = biz.heartbeatWorkItem(wid, String(a.agent_id), String(c2.claim_token), "op");
    expect(Number(v.lease_epoch)).toBe(2);
  });

  it("P14-P2-HEARTBEAT-PAUSED-AGENT: claimant paused after claim → fail closed", () => {
    const { ctx, biz } = makeStack("hb-paused");
    const { a, wid, token } = claimed(ctx, biz);
    biz.setOrgAgentStatus(String(a.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), token, "op")))
      .toBe("FAIL_CLOSED_AGENT_INACTIVE");
  });

  it("P14-P2-HEARTBEAT-DISABLED-CONTRACT: contract disabled after claim → fail closed", () => {
    const { ctx, biz } = makeStack("hb-contract");
    const { a, wid, token } = claimed(ctx, biz);
    biz.setAgentContractStatus(String(a.agent_id), "DISABLED", "op");
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), token, "op")))
      .toBe("FAIL_CLOSED_AGENT_CONTRACT_DISABLED");
  });
});

describe("P14-P2 RELEASE + RECLAIM", () => {
  it("P14-P2-RELEASE-HAPPY: token release → RELEASED, mirrors cleared, reclaim possible", () => {
    const { ctx, biz } = makeStack("rel-happy");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    biz.releaseClaim(wid, "op", String(c.claim_token));
    expect(String(leaseOf(ctx, wid)!.state)).toBe("RELEASED");
    expect(ctx.store.get("work_item", wid).claimed_by).toBeNull();
    expect(leaseEvents(ctx.store, "WORK_CLAIM_RELEASED", wid)).toHaveLength(1);
    const c2 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expect(Number(leaseOf(ctx, wid)!.lease_epoch)).toBe(2);
    expect(String(c2.claim_token)).not.toBe(String(c.claim_token));
  });

  it("P14-P2-RELEASE-STALE-TOKEN: stale token cannot release a live lease", () => {
    const { ctx, biz } = makeStack("rel-stale");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c1 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expireLease(ctx.store, wid);
    biz.claimWorkItem(wid, String(a.agent_id), "op"); // epoch 2
    expect(errCode(() => biz.releaseClaim(wid, "op", String(c1.claim_token))))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    expect(String(leaseOf(ctx, wid)!.state)).toBe("ACTIVE");
  });

  it("P14-P2-EXPIRE-RECLAIM-NEW-EPOCH: expired → reclaim mints epoch+1 + fresh token", () => {
    const { ctx, biz } = makeStack("expire-reclaim");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c1 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expireLease(ctx.store, wid);
    const c2 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    const lease = leaseOf(ctx, wid)!;
    expect(Number(lease.lease_epoch)).toBe(2);
    expect(String(lease.state)).toBe("ACTIVE");
    expect(String(c2.claim_token)).not.toBe(String(c1.claim_token));
    // the expiry was fenced as a distinct journal step before reclaim
    expect(leaseEvents(ctx.store, "WORK_CLAIM_EXPIRED", wid)).toHaveLength(1);
    expect(leaseEvents(ctx.store, "WORK_CLAIM_ACQUIRED", wid)).toHaveLength(2);
  });

  it("P14-P2-STALE-TOKEN-CANNOT-TOUCH-NEW-LEASE: old token dead everywhere", () => {
    const { ctx, biz } = makeStack("stale-everywhere");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c1 = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expireLease(ctx.store, wid);
    biz.claimWorkItem(wid, String(a.agent_id), "op");
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), String(c1.claim_token), "op")))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    expect(errCode(() => biz.releaseClaim(wid, "op", String(c1.claim_token))))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    expect(String(leaseOf(ctx, wid)!.state)).toBe("ACTIVE");
    expect(Number(leaseOf(ctx, wid)!.lease_epoch)).toBe(2);
  });
});

describe("P14-P2 OPEN INTEGRATION (§8)", () => {
  it("P14-P2-OPEN-NO-CLAIM-FAST-PATH: open works with no claim, mints nothing", () => {
    const { ctx, biz } = makeStack("open-fast");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const out = biz.openWorkItem(wid, "op");
    expect(String(out.status)).toBe("IN_PROGRESS");
    // no hidden claim: no lease row, no mirror token, no bearer minted
    expect(tryLease(ctx.store, wid)).toBeNull();
    const row = ctx.store.get("work_item", wid);
    expect(row.claimed_by ?? null).toBeNull();
    expect(row.claim_token ?? null).toBeNull();
    expect(ctx.store.list("work_open_binding")).toHaveLength(1);
  });

  it("P14-P2-OPEN-MATCHING-CLAIM: assignee-held lease does not block open", () => {
    const { ctx, biz } = makeStack("open-match");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.claimWorkItem(wid, String(a.agent_id), "op");
    const out = biz.openWorkItem(wid, "op");
    expect(String(out.status)).toBe("IN_PROGRESS");
    // lease survives open (coordination ≠ execution consumption)
    expect(String(leaseOf(ctx, wid)!.state)).toBe("ACTIVE");
    expect(ctx.store.list("work_open_binding")).toHaveLength(1);
  });

  it("P14-P2-OPEN-FOREIGN-CLAIM-BLOCKED: foreign live lease fails open closed", () => {
    const { ctx, biz } = makeStack("open-foreign");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const a1 = makeAgent(biz, bid, "lead");
    const a2 = makeAgent(biz, bid, "other");
    const w = makeItem(biz, bid, { assignee_agent_id: a1.agent_id });
    const wid = String(w.work_item_id);
    // forge a canonical-looking lease for a2 — digest recomputed so the
    // row is self-consistent; the validator still proves claimant !=
    // canonical assignee → coordination authority is corrupt → closed
    const row = ctx.store.get("work_item", wid);
    const forged = {
      lease_id: `WCL_${wid}`, work_item_id: wid,
      business_id: bid, project_id: String(b.project_id),
      claimant_agent_id: String(a2.agent_id), lease_epoch: 1,
      token_digest: "0".repeat(64),
      issued_at: "2000-01-01T00:00:00.000Z",
      last_heartbeat_at: "2000-01-01T00:00:01.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      state: "ACTIVE", lease_digest: "",
      created_at: utcnow(), updated_at: utcnow(), version: 0,
    };
    forged.lease_digest = claimLeaseDigest(forged);
    ctx.store.put("work_claim_lease", `WCL_${wid}`, forged, 0);
    expect(errCode(() => biz.openWorkItem(wid, "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
    expect(String(ctx.store.get("work_item", wid).status)).toBe("READY");
    expect(row.claim_token ?? null).toBeNull();
  });

  it("P14-P2-OPEN-DOES-NOT-MINT-HIDDEN-TOKEN: response + rows carry no bearer", () => {
    const { ctx, biz } = makeStack("open-no-token");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const out = biz.openWorkItem(wid, "op");
    expect(JSON.stringify(out)).not.toMatch(/CLM_[0-9A-Z]{20,}/);
    expect(tryLease(ctx.store, wid)).toBeNull();
    expect(ctx.store.get("work_item", wid).claim_token ?? null).toBeNull();
  });

  it("P14-P2-CLAIM-EXPIRY-DOES-NOT-REDISPATCH-LIVE-MISSION: expiry ≠ executor liveness", () => {
    const { ctx, biz } = makeStack("expiry-no-redispatch");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    const out = biz.openWorkItem(wid, "op");
    const missionsBefore = ctx.store.list("mission").map((m) => String(m.mission_id));
    expect(missionsBefore).toHaveLength(1);
    expireLease(ctx.store, wid);
    // fencing happens at the next coordination touch — heartbeat with the
    // old token fences + fails; nothing cancels or redispatches the mission
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a.agent_id), String(c.claim_token), "op")))
      .toBe("FAIL_CLOSED_WORK_CLAIM_EXPIRED");
    const missionsAfter = ctx.store.list("mission");
    expect(missionsAfter.map((m) => String(m.mission_id))).toEqual(missionsBefore);
    expect(String(missionsAfter[0].status)).toBe(String(ctx.store.get("mission", missionsBefore[0]).status));
    expect(String(ctx.store.get("work_item", wid).status)).toBe("IN_PROGRESS");
    expect(String(out.status)).toBe("IN_PROGRESS");
  });
});

describe("P14-P2 LEGACY UPGRADE (§9)", () => {
  function seedLegacy(ctx: Ctx["ctx"], biz: BusinessLayer, byAgent?: string) {
    const b = makeBiz(biz, ctx.projectId);
    const a1 = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a1.agent_id });
    const wid = String(w.work_item_id);
    const row = ctx.store.get("work_item", wid);
    row.claimed_by = byAgent ?? String(a1.agent_id);
    row.claim_token = "CLM_legacy_secret";
    row.claim_expires_at = "2999-01-01T00:00:00.000Z";
    ctx.store.put("work_item", wid, row, Number(row.version));
    return { b, a1, wid };
  }

  it("P14-P2-LEGACY-CLAIM-UPGRADE: phantom mirrors never authority — claim mints epoch-1", () => {
    const { ctx, biz } = makeStack("legacy-upgrade");
    const { a1, wid } = seedLegacy(ctx, biz);
    expect(tryLease(ctx.store, wid)).toBeNull();
    const c = biz.claimWorkItem(wid, String(a1.agent_id), "op");
    const lease = leaseOf(ctx, wid)!;
    expect(Number(lease.lease_epoch)).toBe(1); // fresh, never adopted
    // the legacy "token" can never heartbeat — only the new one can
    expect(errCode(() => biz.heartbeatWorkItem(wid, String(a1.agent_id), "CLM_legacy_secret", "op")))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    const v = biz.heartbeatWorkItem(wid, String(a1.agent_id), String(c.claim_token), "op");
    expect(String(v.state)).toBe("ACTIVE");
  });

  it("P14-P2-LEGACY-RAW-TOKEN-NOT-EXPOSED: mirror token invisible to reads + reconcile clears", () => {
    const { ctx, biz, wf } = makeStack("legacy-no-expose");
    const { wid } = seedLegacy(ctx, biz);
    // claim read surface: no lease → nothing, never the mirror token
    expect(biz.getWorkItemClaim(wid)).toBeNull();
    // legacy token cannot be used as heartbeat authority
    expect(errCode(() =>
      biz.heartbeatWorkItem(wid, String(ctx.store.get("work_item", wid).claimed_by), "CLM_legacy_secret", "op")))
      .toBe("FAIL_CLOSED_WORK_ITEM_NOT_CLAIMED");
    // reconcile invalidates the phantom deterministically
    wf.reconcileWorkGraph();
    const row = ctx.store.get("work_item", wid);
    expect(row.claimed_by).toBeNull();
    expect(row.claim_token).toBeNull();
    expect(row.claim_expires_at).toBeNull();
  });

  it("P14-P2-LEGACY-CLAIM-CANNOT-BYPASS-WCL: phantom foreign mirror cannot block open", () => {
    const { ctx, biz } = makeStack("legacy-no-bypass");
    const { a1, wid } = seedLegacy(ctx, biz);
    const foreign = makeAgent(biz, String(ctx.store.get("work_item", wid).business_id), "foreign");
    // mirror claims a DIFFERENT agent holds it — still no authority
    const row = ctx.store.get("work_item", wid);
    row.claimed_by = String(foreign.agent_id);
    ctx.store.put("work_item", wid, row, Number(row.version));
    const out = biz.openWorkItem(wid, "op");
    expect(String(out.status)).toBe("IN_PROGRESS");
    expect(ctx.store.get("work_item", wid).claim_token).toBeNull();
    expect(String(ctx.store.get("work_item", wid).claimed_by ?? "")).toBe("");
    expect(tryLease(ctx.store, wid)).toBeNull(); // no lease fabricated
    expect(String(a1.agent_id)).not.toBe("");
  });
});

describe("P14-P2 DURABLE INBOX (§10-12)", () => {
  function twoAgents(ctx: Ctx["ctx"], biz: BusinessLayer) {
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "sender");
    const r = makeAgent(biz, String(b.business_id), "recip");
    return { b, a, r, bid: String(b.business_id) };
  }

  it("P14-P2-INBOX-SEND-HAPPY: operator + agent send → COMMITTED msg + PENDING receipt", () => {
    const { ctx, biz } = makeStack("inbox-happy");
    const { a, r, bid } = twoAgents(ctx, biz);
    const w = makeItem(biz, bid, { assignee_agent_id: r.agent_id });
    const m1 = biz.sendWorkforceMessage({
      business_id: bid, work_item_id: String(w.work_item_id),
      sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "REQUEST", body: "pick this up",
    });
    expect(String(m1.state)).toBe("COMMITTED");
    const m2 = biz.sendWorkforceMessage({
      business_id: bid,
      sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "heads up",
    });
    const inbox = biz.inboxForAgent(String(r.agent_id));
    expect(inbox).toHaveLength(2);
    expect(inbox.map((m) => String(m.receipt_status))).toEqual(["PENDING", "PENDING"]);
    expect(String(m2.message_id)).toMatch(/^WFM_/);
    expect(ctx.store.get("workforce_message_receipt",
      `WIR_${m1.message_id}_${r.agent_id}`).status).toBe("PENDING");
  });

  it("P14-P2-INBOX-CROSS-BUSINESS-REJECT: recipient outside business fails closed", () => {
    const { ctx, biz } = makeStack("inbox-xbiz");
    const { bid } = twoAgents(ctx, biz);
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const foreign = makeAgent(biz, String(b2.business_id), "foreign");
    expect(errCode(() => biz.sendWorkforceMessage({
      business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(foreign.agent_id), kind: "NOTE", body: "x",
    }))).toBe("FAIL_CLOSED_MESSAGE_SCOPE");
  });

  it("P14-P2-INBOX-WORK-SCOPE-REJECT: work item outside business fails closed", () => {
    const { ctx, biz } = makeStack("inbox-xwork");
    const { r, bid } = twoAgents(ctx, biz);
    const b2 = makeBiz(biz, ctx.projectId, "B2");
    const wOther = makeItem(biz, String(b2.business_id));
    expect(errCode(() => biz.sendWorkforceMessage({
      business_id: bid, work_item_id: String(wOther.work_item_id),
      sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "x",
    }))).toBe("FAIL_CLOSED_MESSAGE_SCOPE");
  });

  it("P14-P2-INBOX-AGENT-SENDER-INACTIVE: PAUSED sender fails closed", () => {
    const { ctx, biz } = makeStack("inbox-paused");
    const { a, r, bid } = twoAgents(ctx, biz);
    biz.setOrgAgentStatus(String(a.agent_id), "PAUSED", "op");
    expect(errCode(() => biz.sendWorkforceMessage({
      business_id: bid, sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(r.agent_id), kind: "STATUS", body: "x",
    }))).toBe("FAIL_CLOSED_AGENT_INACTIVE");
  });

  it("P14-P2-ACK-HAPPY: recipient ACK flips PENDING→ACKNOWLEDGED + event", () => {
    const { ctx, biz } = makeStack("ack-happy");
    const { r, bid } = twoAgents(ctx, biz);
    const m = biz.sendWorkforceMessage({
      business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "hi",
    });
    const mid = String(m.message_id);
    const rec = biz.ackWorkforceMessage(mid, String(r.agent_id), "op");
    expect(String(rec.status)).toBe("ACKNOWLEDGED");
    expect(rec.acknowledged_at).toBeTruthy();
    const evs = ctx.store.listEvents().filter((e) =>
      String(e.event_type) === "WORKFORCE_MESSAGE_ACKNOWLEDGED" &&
      String(e.entity_id) === mid);
    expect(evs).toHaveLength(1);
    expect(String(biz.inboxForAgent(String(r.agent_id))[0].receipt_status))
      .toBe("ACKNOWLEDGED");
  });

  it("P14-P2-ACK-WRONG-RECIPIENT: non-recipient cannot ack", () => {
    const { ctx, biz } = makeStack("ack-wrong");
    const { a, r, bid } = twoAgents(ctx, biz);
    const m = biz.sendWorkforceMessage({
      business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "hi",
    });
    expect(errCode(() => biz.ackWorkforceMessage(String(m.message_id), String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_MESSAGE_RECIPIENT_MISMATCH");
    expect(ctx.store.get("workforce_message_receipt",
      `WIR_${m.message_id}_${r.agent_id}`).status).toBe("PENDING");
  });

  it("P14-P2-ACK-IDEMPOTENT: duplicate ack is a no-op, one event", () => {
    const { ctx, biz } = makeStack("ack-idem");
    const { r, bid } = twoAgents(ctx, biz);
    const m = biz.sendWorkforceMessage({
      business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "hi",
    });
    const mid = String(m.message_id);
    const r1 = biz.ackWorkforceMessage(mid, String(r.agent_id), "op");
    const r2 = biz.ackWorkforceMessage(mid, String(r.agent_id), "op");
    expect(String(r2.status)).toBe("ACKNOWLEDGED");
    expect(String(r2.acknowledged_at)).toBe(String(r1.acknowledged_at));
    const evs = ctx.store.listEvents().filter((e) =>
      String(e.event_type) === "WORKFORCE_MESSAGE_ACKNOWLEDGED" &&
      String(e.entity_id) === mid);
    expect(evs).toHaveLength(1); // no duplicate evidence
  });

  it("P14-P2-MESSAGE-IMMUTABLE: tampered body/digest fails validation on touch", () => {
    const { ctx, biz } = makeStack("msg-immutable");
    const { r, bid } = twoAgents(ctx, biz);
    const m = biz.sendWorkforceMessage({
      business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op",
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "original",
    });
    const mid = String(m.message_id);
    const row = ctx.store.get("workforce_message", mid);
    row.body = "tampered"; // digest left stale → validator proves mismatch
    ctx.store.put("workforce_message", mid, row, Number(row.version));
    expect(errCode(() => biz.ackWorkforceMessage(mid, String(r.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("P14-P2-HANDOFF-REQUEST-NO-AUTHORITY-MUTATION: handoff is data, nothing moves", () => {
    const { ctx, biz } = makeStack("handoff-noauth");
    const { a, r, bid } = twoAgents(ctx, biz);
    const w = makeItem(biz, bid, { assignee_agent_id: r.agent_id });
    const wid = String(w.work_item_id);
    const before = ctx.store.get("work_item", wid);
    const wgmBefore = ctx.store.list("work_graph_membership").length;
    const m = biz.sendWorkforceMessage({
      business_id: bid, work_item_id: wid,
      sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(r.agent_id), kind: "HANDOFF_REQUEST",
      body: "take over this item",
    });
    expect(String(m.kind)).toBe("HANDOFF_REQUEST");
    const after = ctx.store.get("work_item", wid);
    expect(String(after.assignee_agent_id)).toBe(String(before.assignee_agent_id));
    expect(String(after.status)).toBe(String(before.status));
    expect(tryLease(ctx.store, wid)).toBeNull(); // no claim minted
    expect(ctx.store.list("work_graph_membership")).toHaveLength(wgmBefore);
    expect(ctx.store.list("work_delegation")).toHaveLength(0);
    expect(ctx.store.list("work_open_binding")).toHaveLength(0);
  });
});

describe("P14-P2 RESTART + RECONCILE (§15)", () => {
  it("P14-P2-RESTART-LEASE-PRESERVED: lease + fencing survive restart", () => {
    const { dir, ctx, biz } = makeStack("restart-lease");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    const leaseBefore = leaseOf(ctx, wid)!;
    const second = reopenStack(dir);
    const leaseAfter = leaseOf(second.ctx, wid)!;
    expect(String(leaseAfter.state)).toBe("ACTIVE");
    expect(String(leaseAfter.token_digest)).toBe(String(leaseBefore.token_digest));
    expect(Number(leaseAfter.lease_epoch)).toBe(1);
    // heartbeat still requires the raw token across restart
    expect(errCode(() => second.biz.heartbeatWorkItem(wid, String(a.agent_id), "CLM_wrong", "op")))
      .toBe("FAIL_CLOSED_CLAIM_TOKEN");
    const v = second.biz.heartbeatWorkItem(wid, String(a.agent_id), String(c.claim_token), "op");
    expect(String(v.state)).toBe("ACTIVE");
  });

  it("P14-P2-RESTART-EXPIRED-LEASE-FENCED: restart reconcile fences deterministically", () => {
    const { dir, ctx, biz } = makeStack("restart-expired");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");
    expireLease(ctx.store, wid);
    const second = reopenStack(dir);
    const res = second.wf.reconcileWorkGraph();
    expect(String(leaseOf(second.ctx, wid)!.state)).toBe("EXPIRED");
    expect(res.quarantined).toEqual([]);
    // mirror cleared by reconcile
    expect(second.ctx.store.get("work_item", wid).claimed_by).toBeNull();
    // stale token stays dead after restart
    expect(errCode(() => second.biz.heartbeatWorkItem(wid, String(a.agent_id), String(c.claim_token), "op")))
      .toBe("FAIL_CLOSED_WORK_CLAIM_NOT_ACTIVE");
  });

  it("P14-P2-RESTART-INBOX-PRESERVED: messages + receipts + ack survive restart", () => {
    const { dir, ctx, biz } = makeStack("restart-inbox");
    const b = makeBiz(biz, ctx.projectId);
    const bid = String(b.business_id);
    const a = makeAgent(biz, bid, "sender");
    const r = makeAgent(biz, bid, "recip");
    const m = biz.sendWorkforceMessage({
      business_id: bid, sender_type: "AGENT", sender_agent_id: String(a.agent_id),
      recipient_agent_id: String(r.agent_id), kind: "NOTE", body: "durable",
    });
    const mid = String(m.message_id);
    const second = reopenStack(dir);
    const inbox = second.biz.inboxForAgent(String(r.agent_id));
    expect(inbox).toHaveLength(1);
    expect(String(inbox[0].receipt_status)).toBe("PENDING");
    const rec = second.biz.ackWorkforceMessage(mid, String(r.agent_id), "op");
    expect(String(rec.status)).toBe("ACKNOWLEDGED");
    // reopen again — ack durable, idempotent
    const third = reopenStack(dir);
    const rec2 = third.biz.ackWorkforceMessage(mid, String(r.agent_id), "op");
    expect(String(rec2.status)).toBe("ACKNOWLEDGED");
    expect(String(rec2.acknowledged_at)).toBe(String(rec.acknowledged_at));
  });

  it("P14-P2-RECONCILE-IDEMPOTENT: second reconcile is a strict no-op", () => {
    const { ctx, biz, wf } = makeStack("reconcile-idem");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id));
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    biz.claimWorkItem(wid, String(a.agent_id), "op");
    expireLease(ctx.store, wid);
    const first = wf.reconcileWorkGraph();
    const second = wf.reconcileWorkGraph();
    expect(second.quarantined).toEqual(first.quarantined);
    expect(String(leaseOf(ctx, wid)!.state)).toBe("EXPIRED");
    expect(leaseEvents(ctx.store, "WORK_CLAIM_EXPIRED", wid)).toHaveLength(1);
    // corrupt WCL quarantines its item across restarts
    const w2 = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid2 = String(w2.work_item_id);
    biz.claimWorkItem(wid2, String(a.agent_id), "op");
    const l2 = ctx.store.get("work_claim_lease", `WCL_${wid2}`);
    l2.claimant_agent_id = "AGT_forged"; // digest stale → corrupt
    ctx.store.put("work_claim_lease", `WCL_${wid2}`, l2, Number(l2.version));
    const res = wf.reconcileWorkGraph();
    expect(res.quarantined).toContain(wid2);
    // corrupt coordination authority stays quarantined — idempotent,
    // never healed by further reconciles
    wf.reconcileWorkGraph();
    expect(String(ctx.store.get("work_item", wid2).blocked_code))
      .toBe("TERMINAL_PROVENANCE_CORRUPT");
    expect(errCode(() => biz.openWorkItem(wid2, "op")))
      .toMatch(/^FAIL_CLOSED/);
  });
});

describe("P14-P2 API surface (§13)", () => {
  it("P14-P2-API-TOKEN-NEVER-EXPOSED: raw token only on claim; stripped everywhere else", async () => {
    const dir = freshDir("api-token");
    const ctx = makeCtxOn(path.join(dir, "pair.db"), dir);
    const schedules = new MissionScheduleService(ctx.service);
    const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
    const server = createMissionControlServer({ control: ctx.control, business: biz });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", "x-operator-id": "op" };
    try {
      const rb = await fetch(`${base}/api/businesses`, { method: "POST", headers, body: JSON.stringify({ name: "B", project_id: ctx.projectId }) });
      const bizRow = (await rb.json()) as Record<string, unknown>;
      const bid = String(bizRow.business_id);
      const ra = await fetch(`${base}/api/org-agents`, { method: "POST", headers, body: JSON.stringify({ business_id: bid, title: "A", department: "ops" }) });
      const agent = (await ra.json()) as Record<string, unknown>;
      const aid = String(agent.agent_id);
      const rw = await fetch(`${base}/api/work-items`, { method: "POST", headers, body: JSON.stringify({ business_id: bid, title: "w", goal: "g", assignee_agent_id: aid }) });
      const wi = (await rw.json()) as Record<string, unknown>;
      const wid = String(wi.work_item_id);
      // claim → token in response exactly once
      const rc = await fetch(`${base}/api/work-items/${wid}/claim`, { method: "POST", headers, body: JSON.stringify({ agent_id: aid }) });
      expect(rc.status).toBe(200);
      const claimed = (await rc.json()) as Record<string, unknown>;
      const token = String(claimed.claim_token);
      expect(token).toMatch(/^CLM_/);
      // GET work-items / claim / messages / inbox — token never returns
      const list = await (await fetch(`${base}/api/work-items?business_id=${bid}`, { headers })).json() as { work_items: Record<string, unknown>[] };
      expect(JSON.stringify(list)).not.toContain(token);
      expect(list.work_items[0].claim_token).toBeUndefined();
      const claimView = await (await fetch(`${base}/api/work-items/${wid}/claim`, { headers })).json() as Record<string, unknown>;
      expect(claimView.state).toBe("ACTIVE");
      expect(JSON.stringify(claimView)).not.toContain(token);
      expect(claimView.token_digest).toBeUndefined();
      // heartbeat via HTTP
      const hb = await fetch(`${base}/api/work-items/${wid}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ agent_id: aid, claim_token: token }) });
      expect(hb.status).toBe(200);
      const hbBody = (await hb.json()) as Record<string, unknown>;
      expect(JSON.stringify(hbBody)).not.toContain(token);
      expect(hbBody.token_digest).toBeUndefined();
      // message + inbox + ack via HTTP
      const rm = await fetch(`${base}/api/work-items/${wid}/messages`, { method: "POST", headers, body: JSON.stringify({ business_id: bid, sender_type: "OPERATOR", sender_operator_id: "op", recipient_agent_id: aid, kind: "NOTE", body: "status?" }) });
      expect(rm.status).toBe(200);
      const msg = (await rm.json()) as Record<string, unknown>;
      const inbox = await (await fetch(`${base}/api/org-agents/${aid}/inbox`, { headers })).json() as { messages: Record<string, unknown>[] };
      expect(inbox.messages).toHaveLength(1);
      const ack = await fetch(`${base}/api/workforce/messages/${msg.message_id}/ack`, { method: "POST", headers, body: JSON.stringify({ agent_id: aid }) });
      expect(ack.status).toBe(200);
      expect(String(((await ack.json()) as Record<string, unknown>).status)).toBe("ACKNOWLEDGED");
      // events never leak the token either
      const evs = ctx.store.listEvents();
      expect(JSON.stringify(evs)).not.toContain(token);
      const thread = await (await fetch(`${base}/api/work-items/${wid}/messages`, { headers })).json() as { messages: unknown[] };
      expect(thread.messages).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
