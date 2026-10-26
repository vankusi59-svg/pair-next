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
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
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
  claimTokenDigest,
  createMissionControlServer,
  utcnow,
  workforceMessageDigest,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p14wfv2p2-");
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

/* ========================================================================
 * P14-P2 REMEDIATION R1 — ATOMIC CLAIM ADMISSION + IMMUTABLE PROVENANCE
 * ======================================================================== */

const R1_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p2-r1");
const R1_BUNDLE = path.join(R1_CACHE, "pair-bundle.mjs");
const R1_WORKER = path.join(R1_CACHE, "r1-worker.mjs");

const R1_WORKER_SOURCE = `
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
  return { store, service, control, schedules, biz };
}

async function run() {
  const ctx = makeCtx();
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  if (op === "claim") {
    return { claimed: args.agent, out: ctx.biz.claimWorkItem(args.wid, args.agent, "op") };
  }
  if (op === "assign") {
    return { assigned: args.agent, out: ctx.biz.assignWorkItem(args.wid, args.agent, "op") };
  }
  if (op === "pause") {
    return { paused: args.agent, out: ctx.biz.setOrgAgentStatus(args.agent, "PAUSED", "op") };
  }
  if (op === "disable_contract") {
    return { disabled: args.agent, out: ctx.biz.setAgentContractStatus(args.agent, "DISABLED", "op") };
  }
  if (op === "heartbeat") {
    return { hb: args.agent, out: ctx.biz.heartbeatWorkItem(args.wid, args.agent, args.token, "op") };
  }
  if (op === "deny_project") {
    return {
      denied: args.agent,
      out: ctx.biz.upsertAgentContract(args.agent, "op", { allowed_project_ids: [args.otherProject] }),
    };
  }
  throw new Error("unknown op " + op);
}

run()
  .then((out) => parentPort.postMessage({ ok: true, out }))
  .catch((e) => parentPort.postMessage({
    ok: false, code: (e && e.code) || String(e), message: e && e.message,
  }));
`;

function ensureR1Worker() {
  fs.mkdirSync(R1_CACHE, { recursive: true });
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found under node_modules/.pnpm");
  execFileSync(process.execPath, [
    esbuild,
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${R1_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(R1_WORKER, R1_WORKER_SOURCE);
}

type R1Outcome =
  | { ok: true; out: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/** Genuine multi-process race: N workers on the SAME db file, all
 *  released on one shared Atomics barrier. */
async function r1Race(
  ops: Array<{ op: string; dir: string; dbPath: string; args: Record<string, unknown> }>,
): Promise<R1Outcome[]> {
  ensureR1Worker();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let ready = 0;
  return Promise.all(ops.map((o) => new Promise<R1Outcome>((resolve, reject) => {
    const w = new Worker(R1_WORKER, {
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
      resolve(msg as unknown as R1Outcome);
    });
    w.on("error", reject);
    w.on("exit", (code) => {
      if (!settled) reject(new Error(`worker exited code=${code}`));
    });
  })));
}

/** Final invariant from §2: never ACTIVE lease held by A while assignee is B. */
function assertNoClaimAssignSplit(store: PairEvidenceStore, wid: string) {
  const lease = tryLease(store, wid);
  const row = store.get("work_item", wid) as Record<string, unknown>;
  if (lease && String(lease.state) === "ACTIVE") {
    expect(String(row.assignee_agent_id)).toBe(String(lease.claimant_agent_id));
  }
}

describe("P14-P2 R1 §1-3 — genuine multi-process claim races", () => {
  it("P14-P2-R1-CLAIM-ASSIGN-RACE: claim(A) vs assign(B) — never ACTIVE WCL(A) + assignee B", async () => {
    const { ctx, biz } = makeStack("r1-claim-assign-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const agentB = makeAgent(biz, String(b.business_id), "other");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const dbPath = path.join(ctx.dir, "pair.db");

    const [r1, r2] = await r1Race([
      { op: "claim", dir: ctx.dir, dbPath, args: { wid, agent: String(a.agent_id) } },
      { op: "assign", dir: ctx.dir, dbPath, args: { wid, agent: String(agentB.agent_id) } },
    ]);
    // exactly one outcome wins the admission race; the loser fails closed
    const ok = [r1, r2].filter((r) => r.ok);
    expect(ok.length).toBe(1);
    const fail = [r1, r2].find((r) => !r.ok) as R1Outcome;
    expect(String(fail.code)).toMatch(/^FAIL_CLOSED_|SQLITE_BUSY/);

    const finalStore = new PairEvidenceStore(dbPath);
    assertNoClaimAssignSplit(finalStore, wid);
    const lease = tryLease(finalStore, wid);
    const row = finalStore.get("work_item", wid) as Record<string, unknown>;
    // whichever op won, its effects are complete and canonical
    if (r1.ok) {
      expect(String(lease!.state)).toBe("ACTIVE");
      expect(String(lease!.claimant_agent_id)).toBe(String(a.agent_id));
      expect(String(row.assignee_agent_id)).toBe(String(a.agent_id));
    } else {
      expect(String(row.assignee_agent_id)).toBe(String(agentB.agent_id));
      expect(lease === null || String(lease.state) !== "ACTIVE").toBe(true);
    }
    finalStore.close();
  }, 90_000);

  it("P14-P2-R1-ASSIGN-CLAIM-RACE-INVERSE: seeded live lease — concurrent assign(B) vs heartbeat(A)", async () => {
    const { ctx, biz } = makeStack("r1-assign-claim-inverse");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const agentB = makeAgent(biz, String(b.business_id), "other");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op"); // lease committed first
    const dbPath = path.join(ctx.dir, "pair.db");

    // Genuine two-process race on one barrier: assign(B) must always lose
    // to the seeded live lease; the claimant's heartbeat stays legal.
    const [rAssign, rHb] = await r1Race([
      { op: "assign", dir: ctx.dir, dbPath, args: { wid, agent: String(agentB.agent_id) } },
      { op: "heartbeat", dir: ctx.dir, dbPath, args: { wid, agent: String(a.agent_id), token: String(c.claim_token) } },
    ]);
    expect(rAssign.ok).toBe(false);
    expect(String((rAssign as { code: string }).code)).toBe("FAIL_CLOSED_WORK_ITEM_CLAIMED");
    expect(rHb.ok).toBe(true);

    const finalStore = new PairEvidenceStore(dbPath);
    assertNoClaimAssignSplit(finalStore, wid);
    const row = finalStore.get("work_item", wid) as Record<string, unknown>;
    expect(String(row.assignee_agent_id)).toBe(String(a.agent_id));
    expect(String(tryLease(finalStore, wid)!.state)).toBe("ACTIVE");
    finalStore.close();
  }, 90_000);

  it("P14-P2-R1-CLAIM-PROJECT-REVOKE-RACE: claim(A) vs project-scope denial — in-txn executability closes it", async () => {
    const { ctx, biz } = makeStack("r1-claim-revoke-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const dbPath = path.join(ctx.dir, "pair.db");

    // claim(A) racing a contract update that removes project access:
    // whichever wins first decides — never a lease minted on a revoked
    // scope (assertExecutable is inside the claim txn).
    const [rClaim, rDeny] = await r1Race([
      { op: "claim", dir: ctx.dir, dbPath, args: { wid, agent: String(a.agent_id) } },
      { op: "deny_project", dir: ctx.dir, dbPath, args: { agent: String(a.agent_id), otherProject: "PRJ_other" } },
    ]);

    const finalStore = new PairEvidenceStore(dbPath);
    const lease = tryLease(finalStore, wid);
    if (rClaim.ok) {
      // claim landed before the revoke committed → whole canonical lease
      expect(String(lease!.state)).toBe("ACTIVE");
      expect(leaseEvents(finalStore, "WORK_CLAIM_ACQUIRED", wid)).toHaveLength(1);
    } else {
      // revoke committed first → claim failed closed, nothing minted
      expect(String(rClaim.code)).toMatch(/AGENT_PROJECT_DENIED|CONTRACT|SQLITE_BUSY|FAIL_CLOSED/);
      expect(lease).toBeNull();
    }
    expect(rDeny.ok).toBe(true);
    finalStore.close();
  }, 90_000);

  it("P14-P2-R1-CLAIM-PAUSE-RACE: claim(A) vs pause(A) — committed lease only if agent was ACTIVE at write", async () => {
    const { ctx, biz } = makeStack("r1-claim-pause-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const dbPath = path.join(ctx.dir, "pair.db");

    const [rClaim, rPause] = await r1Race([
      { op: "claim", dir: ctx.dir, dbPath, args: { wid, agent: String(a.agent_id) } },
      { op: "pause", dir: ctx.dir, dbPath, args: { agent: String(a.agent_id) } },
    ]);

    const finalStore = new PairEvidenceStore(dbPath);
    const lease = tryLease(finalStore, wid);
    const agent = finalStore.get("org_agent", String(a.agent_id)) as Record<string, unknown>;
    expect(String(agent.status)).toBe("PAUSED");
    if (rClaim.ok) {
      // claim won the txn before the pause committed → lease is whole + canonical
      expect(String(lease!.state)).toBe("ACTIVE");
      expect(leaseEvents(finalStore, "WORK_CLAIM_ACQUIRED", wid)).toHaveLength(1);
    } else {
      // pause committed first → claim failed closed, no lease minted
      expect(String(rClaim.code)).toMatch(/AGENT_INACTIVE|CONTRACT|SQLITE_BUSY/);
      expect(lease).toBeNull();
    }
    expect(rPause.ok).toBe(true);
    finalStore.close();
  }, 90_000);

  it("P14-P2-R1-CLAIM-CONTRACT-DISABLE-RACE: claim(A) vs contract DISABLED — same atomic semantics", async () => {
    const { ctx, biz } = makeStack("r1-claim-disable-race");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const dbPath = path.join(ctx.dir, "pair.db");

    const [rClaim, rDis] = await r1Race([
      { op: "claim", dir: ctx.dir, dbPath, args: { wid, agent: String(a.agent_id) } },
      { op: "disable_contract", dir: ctx.dir, dbPath, args: { agent: String(a.agent_id) } },
    ]);

    const finalStore = new PairEvidenceStore(dbPath);
    const lease = tryLease(finalStore, wid);
    const contract = finalStore.list("agent_execution_contract")
      .find((x) => String((x as Record<string, unknown>).org_agent_id) === String(a.agent_id)) as Record<string, unknown>;
    expect(String(contract.status)).toBe("DISABLED");
    if (rClaim.ok) {
      expect(String(lease!.state)).toBe("ACTIVE");
      expect(leaseEvents(finalStore, "WORK_CLAIM_ACQUIRED", wid)).toHaveLength(1);
    } else {
      expect(String(rClaim.code)).toMatch(/CONTRACT_DISABLED|AGENT_CONTRACT|SQLITE_BUSY/);
      expect(lease).toBeNull();
    }
    expect(rDis.ok).toBe(true);
    finalStore.close();
  }, 90_000);
});

describe("P14-P2 R1 §4-8 — provenance anchors + read seams + reconcile", () => {
  it("P14-P2-R1-LEASE-TIME-ORDER: hb >= expires_at → PROVENANCE_CORRUPT", () => {
    const { ctx, biz } = makeStack("r1-lease-time-order");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const wid = String(w.work_item_id);
    const c = biz.claimWorkItem(wid, String(a.agent_id), "op");

    // Forge: heartbeat == expiry (violates hb < exp), digest recomputed
    const l = ctx.store.get("work_claim_lease", `WCL_${wid}`) as Record<string, unknown>;
    l.last_heartbeat_at = String(l.expires_at);
    l.lease_digest = claimLeaseDigest(l);
    ctx.store.put("work_claim_lease", `WCL_${wid}`, l, Number(l.version));

    expect(errCode(() => biz.getWorkItemClaim(wid))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
    expect(errCode(() =>
      biz.heartbeatWorkItem(wid, String(a.agent_id), String(c.claim_token), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");

    // malformed (unparseable) timestamp also fails closed
    const l2 = ctx.store.get("work_claim_lease", `WCL_${wid}`) as Record<string, unknown>;
    l2.last_heartbeat_at = "not-a-timestamp";
    l2.lease_digest = claimLeaseDigest(l2);
    ctx.store.put("work_claim_lease", `WCL_${wid}`, l2, Number(l2.version));
    expect(errCode(() => biz.getWorkItemClaim(wid))).toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("P14-P2-R1-MESSAGE-TAMPER-REHASH: recomputed digest still fails — SENT event pins original", () => {
    const { ctx, biz } = makeStack("r1-msg-tamper");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "original body", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);

    // Tamper: new body + CORRECTLY recomputed digest — self-consistent row
    const m2 = ctx.store.get("workforce_message", mid) as Record<string, unknown>;
    m2.body = "forged body";
    m2.message_digest = workforceMessageDigest(m2);
    ctx.store.put("workforce_message", mid, m2, Number(m2.version));

    // Read seam surfaces explicit corruption, never forged content
    const listed = biz.listWorkItemMessages(String(w.work_item_id));
    const corrupt = listed.find((x) => String(x.message_id) === mid)!;
    expect(String(corrupt.state)).toBe("CORRUPT");
    expect(corrupt.body).toBeUndefined();
    expect(errCode(() => biz.ackWorkforceMessage(mid, String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("P14-P2-R1-RECEIPT-FORGED-ACK: row PENDING→ACK without event fails closed", () => {
    const { ctx, biz } = makeStack("r1-rcpt-forge");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    const rid = `WIR_${mid}_${a.agent_id}`;

    // Forge: direct row mutation to ACKNOWLEDGED — no ACK event exists
    const r = ctx.store.get("workforce_message_receipt", rid) as Record<string, unknown>;
    r.status = "ACKNOWLEDGED";
    r.acknowledged_at = utcnow();
    ctx.store.put("workforce_message_receipt", rid, r, Number(r.version));

    const inbox = biz.inboxForAgent(String(a.agent_id));
    const view = inbox.find((x) => String(x.message_id) === mid)!;
    expect(String(view.receipt_status)).toBe("CORRUPT");
    expect(errCode(() => biz.ackWorkforceMessage(mid, String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");
  });

  it("P14-P2-R1-ACK-EVENT-IDEMPOTENT: duplicate ACK creates exactly one event", () => {
    const { ctx, biz } = makeStack("r1-ack-idem");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    const r1 = biz.ackWorkforceMessage(mid, String(a.agent_id), "op");
    const r2 = biz.ackWorkforceMessage(mid, String(a.agent_id), "op");
    expect(String(r1.acknowledged_at)).toBe(String(r2.acknowledged_at));
    const acks = ctx.store.listEvents("workforce_message", mid)
      .filter((e) => String(e.event_type) === "WORKFORCE_MESSAGE_ACKNOWLEDGED");
    expect(acks).toHaveLength(1);
  });

  it("P14-P2-R1-CORRUPT-MESSAGE-READ-FAILS + CORRUPT-RECEIPT-READ-FAILS: seams never surface forged rows", () => {
    const { ctx, biz } = makeStack("r1-corrupt-reads");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m1 = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "msg1", work_item_id: String(w.work_item_id),
    });
    const m2 = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "msg2", work_item_id: String(w.work_item_id),
    });
    const mid1 = String(m1.message_id);
    const mid2 = String(m2.message_id);

    // Corrupt message row: digest mismatch (body edited, digest stale)
    const mm = ctx.store.get("workforce_message", mid1) as Record<string, unknown>;
    mm.body = "tampered";
    ctx.store.put("workforce_message", mid1, mm, Number(mm.version));

    // Corrupt receipt row: recipient mismatch vs deterministic id
    const rid2 = `WIR_${mid2}_${a.agent_id}`;
    const rr = ctx.store.get("workforce_message_receipt", rid2) as Record<string, unknown>;
    rr.status = "BOGUS_STATUS";
    ctx.store.put("workforce_message_receipt", rid2, rr, Number(rr.version));

    // listWorkItemMessages: corrupt message appears only as CORRUPT marker
    const listed = biz.listWorkItemMessages(String(w.work_item_id));
    expect(String(listed.find((x) => String(x.message_id) === mid1)!.state)).toBe("CORRUPT");
    expect(listed.find((x) => String(x.message_id) === mid1)!.body).toBeUndefined();
    // R2 §2: the message row itself is valid but its receipt is corrupt →
    // the whole bundle fails closed (never surfaced as valid data)
    expect(String(listed.find((x) => String(x.message_id) === mid2)!.state)).toBe("CORRUPT");

    // inboxForAgent: corrupt receipt appears as CORRUPT marker on both
    const inbox = biz.inboxForAgent(String(a.agent_id));
    expect(String(inbox.find((x) => String(x.message_id) === mid1)!.receipt_status)).toBe("CORRUPT");
    expect(String(inbox.find((x) => String(x.message_id) === mid2)!.receipt_status)).toBe("CORRUPT");
  });

  it("P14-P2-R1-CORRUPT-RECONCILE-IDEMPOTENT: second reconcile adds no duplicate evidence", () => {
    const { ctx, biz, wf } = makeStack("r1-reconcile-idem");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    const rid = `WIR_${mid}_${a.agent_id}`;

    // Corrupt BOTH the message and its receipt
    const mm = ctx.store.get("workforce_message", mid) as Record<string, unknown>;
    mm.body = "tampered";
    ctx.store.put("workforce_message", mid, mm, Number(mm.version));
    const rr = ctx.store.get("workforce_message_receipt", rid) as Record<string, unknown>;
    rr.status = "BOGUS";
    ctx.store.put("workforce_message_receipt", rid, rr, Number(rr.version));

    const count = () => ctx.store.listEvents()
      .filter((e) => String(e.event_type) === "WORK_COORDINATION_CORRUPT").length;

    wf.reconcileWorkGraph();
    const after1 = count();
    expect(after1).toBe(2); // one per corrupt row
    wf.reconcileWorkGraph();
    wf.reconcileWorkGraph();
    expect(count()).toBe(2); // strictly idempotent — no unbounded duplicates
  });
});

/* ========================================================================
 * P14-P2 REMEDIATION R2 — COLLABORATION PROVENANCE COMPLETENESS
 * ======================================================================== */

import Database from "better-sqlite3";

/** Direct test seam: hard-delete a receipt row (simulates evidence loss). */
function deleteReceiptRow(dbPath: string, receiptId: string) {
  const db = new Database(dbPath);
  db.prepare("DELETE FROM entities WHERE entity_type='workforce_message_receipt' AND entity_id=?")
    .run(receiptId);
  db.close();
}

describe("P14-P2 R2 §1-4 — receipt completeness + ACK pin", () => {
  it("P14-P2-R2-MISSING-RECEIPT-INBOX-CORRUPT: deleted receipt → CORRUPT, never PENDING", () => {
    const { ctx, biz } = makeStack("r2-miss-rcpt-inbox");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    // sanity: canonical state shows PENDING
    expect(String(biz.inboxForAgent(String(a.agent_id))[0].receipt_status)).toBe("PENDING");

    deleteReceiptRow(path.join(ctx.dir, "pair.db"), `WIR_${mid}_${a.agent_id}`);

    const inbox = biz.inboxForAgent(String(a.agent_id));
    const view = inbox.find((x) => String(x.message_id) === mid)!;
    expect(String(view.receipt_status)).toBe("CORRUPT");
    expect(view.corrupt).toBe(true);
    expect(view.body).toBeUndefined(); // never surface the message as valid data
    // ack fails closed — no fabricated receipt
    expect(errCode(() => biz.ackWorkforceMessage(mid, String(a.agent_id), "op")))
      .toMatch(/NOT_FOUND|CORRUPT/);
    // the receipt was NOT recreated
    expect(ctx.store.tryGet("workforce_message_receipt", `WIR_${mid}_${a.agent_id}`)).toBeNull();
  });

  it("P14-P2-R2-MISSING-RECEIPT-MESSAGE-LIST-CORRUPT: list seam also fails closed", () => {
    const { ctx, biz } = makeStack("r2-miss-rcpt-list");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    deleteReceiptRow(path.join(ctx.dir, "pair.db"), `WIR_${mid}_${a.agent_id}`);

    const listed = biz.listWorkItemMessages(String(w.work_item_id));
    const view = listed.find((x) => String(x.message_id) === mid)!;
    expect(String(view.state)).toBe("CORRUPT");
    expect(view.body).toBeUndefined();
  });

  it("P14-P2-R2-MISSING-RECEIPT-RECONCILE-IDEMPOTENT: one evidence, no dup, no fabrication", () => {
    const { ctx, biz, wf } = makeStack("r2-miss-rcpt-recon");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    const rid = `WIR_${mid}_${a.agent_id}`;
    deleteReceiptRow(path.join(ctx.dir, "pair.db"), rid);

    const corrupt = () => ctx.store.listEvents()
      .filter((e) => String(e.event_type) === "WORK_COORDINATION_CORRUPT");

    wf.reconcileWorkGraph();
    expect(corrupt().length).toBe(1); // deterministic evidence on the message
    expect(String(corrupt()[0].entity_id)).toBe(mid);

    wf.reconcileWorkGraph();
    wf.reconcileWorkGraph();
    expect(corrupt().length).toBe(1); // strictly idempotent
    // receipt never fabricated by reconcile
    expect(ctx.store.tryGet("workforce_message_receipt", rid)).toBeNull();

    // restart: reconcile on the reopened stack still emits nothing new
    const second = reopenStack(ctx.dir);
    second.wf.reconcileWorkGraph();
    const corrupt2 = second.ctx.store.listEvents()
      .filter((e) => String(e.event_type) === "WORK_COORDINATION_CORRUPT");
    expect(corrupt2.length).toBe(1);
    expect(second.ctx.store.tryGet("workforce_message_receipt", rid)).toBeNull();
  });

  it("P14-P2-R2-ACK-WRONG-MESSAGE-ID-EVENT-FAILS: malformed ACK event metadata fails", () => {
    const { ctx, biz } = makeStack("r2-ack-wrong-mid");
    const b = makeBiz(biz, ctx.projectId);
    const a = makeAgent(biz, String(b.business_id), "lead");
    const w = makeItem(biz, String(b.business_id), { assignee_agent_id: a.agent_id });
    const m = biz.sendWorkforceMessage({
      business_id: String(b.business_id), sender_type: "OPERATOR",
      sender_operator_id: "op", recipient_agent_id: String(a.agent_id),
      kind: "NOTE", body: "hi", work_item_id: String(w.work_item_id),
    });
    const mid = String(m.message_id);
    const legitAck = biz.ackWorkforceMessage(mid, String(a.agent_id), "op");
    const legitTs = String(legitAck.acknowledged_at);

    // Forge a correctly-hashed second ACK event whose metadata pins a
    // FOREIGN message_id (entity_id still `mid` so it collides on the
    // surface), then point the receipt at the forged timestamp — only the
    // message_id pin in assertCanonicalReceipt can distinguish them.
    ctx.store.event({
      entity_type: "workforce_message", entity_id: mid,
      event_type: "WORKFORCE_MESSAGE_ACKNOWLEDGED",
      actor: `agent:${a.agent_id}`,
      metadata: {
        message_id: "WFM_foreign", // forged pin
        recipient_agent_id: String(a.agent_id),
        acknowledged_at: "2030-01-01T00:00:00.000Z",
        receipt_id: `WIR_${mid}_${a.agent_id}`,
        work_item_id: String(w.work_item_id),
      },
    });
    const rid = `WIR_${mid}_${a.agent_id}`;
    const r = ctx.store.get("workforce_message_receipt", rid) as Record<string, unknown>;
    r.acknowledged_at = "2030-01-01T00:00:00.000Z"; // matches forged event only
    ctx.store.put("workforce_message_receipt", rid, r, Number(r.version));

    // Read seam: receipt fails validation → CORRUPT projection
    const inbox = biz.inboxForAgent(String(a.agent_id));
    const view = inbox.find((x) => String(x.message_id) === mid)!;
    expect(String(view.receipt_status)).toBe("CORRUPT");
    // ack seam: fail closed — no matching canonical ACK event exists
    expect(errCode(() => biz.ackWorkforceMessage(mid, String(a.agent_id), "op")))
      .toBe("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT");

    // restore the real ts → the legit ACK event validates again
    const r2 = ctx.store.get("workforce_message_receipt", rid) as Record<string, unknown>;
    r2.acknowledged_at = legitTs;
    ctx.store.put("workforce_message_receipt", rid, r2, Number(r2.version));
    expect(String(biz.inboxForAgent(String(a.agent_id))
      .find((x) => String(x.message_id) === mid)!.receipt_status))
      .toBe("ACKNOWLEDGED");
  });
});
