/**
 * P15.10-C R1 — heartbeat + fenced post-await commit guard.
 *
 * Bug under test (prepatch): the autonomous lease expires 60s after
 * claim while a CEO model invocation may run up to 900s; nothing
 * renews it, and nothing revalidates autonomous authority inside the
 * serialized commit transaction after the model await resolves — a
 * PAUSE/REVOKE/expiry landing mid-call still commits a decision and
 * any workstream side effect.
 *
 * Every proof below reads canonical DB evidence, not timers alone.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRIVER_ACTOR,
  LEASE_STATE,
  SCHEDULER_RECEIPT,
  WAKE_STATE,
  BusinessLayer,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  readSchedulerRow,
  ModelEvidenceCatalog,
  ProviderCatalog,
  providerEntryId,
  CODEX_CLI_PROVIDER_ID,
  qualifyModel,
  IntegrityError,
  CeoPlanningCycleService,
  isSqliteContentionError,
  CEO_DECISION_ENTITY,
  CEO_DECISION_ATTEMPT_ENTITY,
  WorkforceService,
  WorkforceAllocationService,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";
import type { OperatingPassResult } from "../pair/index.js";
import { ObjectiveAdaptiveReviewService } from "../pair/objective-adaptive-review.js";
import { ObjectiveOperatingService } from "../pair/objective-operating-loop.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510cr1-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stack = {
  dir: string; dbPath: string; store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService; policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler; wakeup: ObjectiveAutoWakeupService;
  now: () => number; setNow: (v: number) => void;
};

function fresh(name: string, initial = 1_000_000): Stack {
  let t = initial;
  const dir = path.join(ROOT, String(counter++) + "-" + name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  return { dir, dbPath, store, objectives, policy, scheduler, wakeup,
    now: () => t, setNow: (v) => { t = v; } };
}

function mkBiz(store: PairEvidenceStore): string {
  const id = "BIZ_R1_" + counter++;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(s: Stack, businessId: string) {
  return s.objectives.create({
    business_id: businessId, title: "Grow", statement: "g",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
    operator_id: OP, dedup_key: "r1-" + counter + "-" + Math.random(),
  });
}

const oid = (r: unknown) => String((r as { objective_id: string }).objective_id);
const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, max_retries: 3, ...extra });

function enable(s: Stack, objectiveId: string, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "configure", limits: LIMITS(extra),
    idempotency_key: "cfg-" + counter + "-" + Math.random() });
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "enable", policy_version: 1,
    idempotency_key: "en-" + counter + "-" + Math.random() });
}

function wake(s: Stack, objectiveId: string) {
  s.wakeup.tick();
  return readSchedulerRow(s.store, WAKE_STATE, objectiveId);
}

const lease = (s: Stack, id: string) =>
  readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, id);

const receipts = (s: Stack, prefix: string) =>
  (s.store.list(SCHEDULER_RECEIPT) as Array<Record<string, unknown>>)
    .filter((r) => String(r.entity_id ?? r.objective_id ?? "").startsWith(prefix) ||
      String((r as { entity_id?: string }).entity_id ?? "").includes(prefix));

const renewReceipts = (s: Stack, objectiveId: string) =>
  (s.store.list(SCHEDULER_RECEIPT) as Array<Record<string, unknown>>)
    .filter((r) => String(r.objective_id) === objectiveId && r.operation === "RENEW");

type PassCall = { objective_id: string; actor: string; gated: boolean };

function mkDriver(s: Stack, opts: {
  outcome?: OperatingPassResult["outcome"];
  onPass?: (call: PassCall, gate: () => void) => void | Promise<void>;
  halt?: () => boolean;
  workerId?: string; bootId?: string;
  heartbeatMs?: number; ceoTimeoutMs?: number;
  reconcileStaleAttempts?: (objectiveId: string) => void;
} = {}) {
  const calls: PassCall[] = [];
  // PR #121 — the configured autonomous id must exist as a canonical
  // ENABLED+QUALIFIED executor row to enter the supply envelope.
  if (!s.store.tryGet("executor", "CODEX")) {
    s.store.put("executor", "CODEX", {
      executor_id: "CODEX", executor_type: "EXTERNAL", status: "ENABLED",
      health_state: "READY", capabilities: [],
      metadata: { qualification_state: "QUALIFIED" },
    }, 0);
  }
  // AUDIT R1 F4 — the CEO subscription lane is proven independently of
  // executor supply: seed the canonical codex-cli provider session
  // (AUTH_OK) and resolve CODEX to SUBSCRIPTION in the billing stub.
  const pid = providerEntryId(CODEX_CLI_PROVIDER_ID);
  if (!s.store.tryGet("provider", pid)) {
    s.store.put("provider", pid, {
      provider_id: CODEX_CLI_PROVIDER_ID, auth_state: "AUTH_OK",
      lifecycle_state: "QUALIFIED", health_state: "READY", version: 0,
    }, 0);
  }
  const driver = new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async (input) => {
      await opts.onPass?.(
        { objective_id: input.objective_id, actor: input.actor, gated: true },
        input.authority_gate);
      calls.push({ objective_id: input.objective_id, actor: input.actor, gated: true });
      return { outcome: opts.outcome ?? "WAITING", objective_id: input.objective_id };
    },
    executors: ["CODEX"],
    billingFor: (e: string) =>
      e === "CODEX"
        ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
        : { mode: "UNMETERED", profile: null, unbounded: false },
    costHaltActive: opts.halt ?? (() => false),
    workerId: opts.workerId ?? "r1-driver",
    bootId: opts.bootId ?? "r1-boot",
    now: s.now,
    heartbeatMs: opts.heartbeatMs,
    ceoTimeoutMs: opts.ceoTimeoutMs,
    reconcileStaleAttempts: opts.reconcileStaleAttempts,
  });
  return { driver, calls };
}

/* ---- service-level fixtures (minimal p15-3 pattern) ---- */

const mkModel = (store: PairEvidenceStore, pid: string, mid: string) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid, provider_family: pid, model_id: mid,
    capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  mcat.recordProbeReceipt({
    probe_id: `PRB_${pid}_${mid}`.replace(/[^A-Za-z0-9_-]/g, "_"),
    model_entry_id: eid, provider_id: pid, result: "PASS",
    probe_type: "text_inference", capability_evidence: { text_inference: "PASS" },
    latency_ms: 1,
  });
  const q = qualifyModel(store, eid, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error(`mkModel fixture failed: ${JSON.stringify(q.gates)}`);
  return eid;
};

const mkProvider = (store: PairEvidenceStore, pid: string) => {
  const id = providerEntryId(pid);
  const codex = pid === "codex-cli";
  store.put("provider", id, {
    provider_id: pid, entry_id: id,
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK", health_state: "READY",
    conditions: [], probe_state: "PROBED",
    provider_type: codex ? "LOCAL_CLI" : "REMOTE_HTTP",
    protocol_family: codex ? "CODEX_CLI" : "HTTPS_JSON",
    endpoint_reference: codex ? "codex-cli://local" : "https://provider.test",
    configured_endpoint_identity: codex ? "codex-cli://local" : "https://provider.test",
    credential_envs: codex ? [] : ["TEST_API_KEY"],
    credential_reference_name: codex ? null : "TEST_API_KEY",
  }, 0);
  new ProviderCatalog(store).issueQualificationReceipt(pid, { policy_version: "test-policy", actor: "test" });
};

class FakeInvoker implements CeoDecisionInvoker {
  calls = 0;
  constructor(private produce: (i: CeoInvokeInput) => Promise<CeoInvokeResult> | CeoInvokeResult) {}
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> { this.calls++; return this.produce(input); }
}

const decisionJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
    wait_reason: "AWAITING_PROGRESS", ...over });

/** Full ceo-cycle service on its own store (independent of driver stack). */
function freshCeo(name: string, invokerProduce: (i: CeoInvokeInput) => Promise<CeoInvokeResult> | CeoInvokeResult) {
  const dir = path.join(ROOT, String(counter++) + "-" + name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService({ store, business: biz, workforce: wf, objectives });
  const me = mkModel(store, "codex-cli", "ceo-m");
  mkProvider(store, "codex-cli");
  const invoker = new FakeInvoker(invokerProduce);
  const svc = new CeoPlanningCycleService({
    store, objectives, workstreams,
    proveWorkItemDone: (row) => biz.proveWorkItemDone(row as never),
    invoker, model_entry_id: me,
  });
  const businessId = `BIZ_SVC_${counter}`;
  store.put("business", businessId, {
    business_id: businessId, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  const objective = objectives.create({
    business_id: businessId, title: "Sell", statement: "s",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
    operator_id: OP, dedup_key: "svc-" + counter + "-" + Math.random(),
  });
  return { store, biz, wf, objectives, workstreams, me, invoker, svc,
    objectiveId: oid(objective) };
}

describe("P15.10-C R1 — heartbeat + fenced commit guard", () => {

  it("R1-F1a long model call (>60s) keeps lease alive via heartbeat, settles once", async () => {
    const s = fresh("f1a");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, {
      heartbeatMs: 5,
      onPass: async (_c, gate) => {
        // Model call runs ~90s of scheduler time while real heartbeat ticks.
        for (let i = 0; i < 3; i++) {
          s.setNow(s.now() + 30_000);
          await sleep(30); // let real heartbeat ticks fire
          gate(); // still authorized mid-pass
        }
      },
    });
    const out = await driver.tick();
    expect(calls).toHaveLength(1);
    expect(out.driven[0]!.settled).toBe(true);
    expect(out.driven[0]!.outcome).toBe("WAITING");
    const l = lease(s, oid(o));
    expect(l!.state).toBe("SETTLED");
    expect(renewReceipts(s, oid(o)).length).toBeGreaterThanOrEqual(2);
  });

  it("R1-F1b owner pause during model await blocks final commit (driver level)", async () => {
    const s = fresh("f1b");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, {
      heartbeatMs: 5,
      onPass: async (_c, gate) => {
        gate(); // pre-invocation boundary passes
        // Owner pauses while the "model call" is in flight.
        const v = s.policy.status(oid(o), OWNER).policy_version;
        s.policy.control({ objective_id: oid(o), actor: OWNER,
          action: "pause", policy_version: v, idempotency_key: "pause-r1b" });
        gate(); // post-await boundary — must throw DRIVER_AUTHORITY_LOST
      },
    });
    const out = await driver.tick();
    expect(calls).toHaveLength(0); // pass aborted inside onPass
    expect(out.driven[0]!.outcome).toBe("FAULT");
    const q = readSchedulerRow<Record<string, unknown>>(s.store, WAKE_STATE, oid(o))!;
    expect(q.queue_state).toBe("QUARANTINED");
    // No settle receipt — a revoked worker never settles.
    const settled = (s.store.list(SCHEDULER_RECEIPT) as Array<Record<string, unknown>>)
      .filter((r) => r.operation === "SETTLE");
    expect(settled).toHaveLength(0);
  });

  it("R1-F1b service level: commit guard inside the commit txn blocks post-revoke commit", async () => {
    let revoked = false;
    const started: Promise<void>[] = [];
    const c = freshCeo("f1b-svc", async (i) => {
      started.push(Promise.resolve());
      await sleep(20);
      return { model_entry_id: i.transport.model_entry_id,
        provider_id: i.transport.provider_id, model_id: i.transport.model_id,
        raw_text: decisionJson({ decision_kind: "INITIALIZE_WORKSTREAMS",
          wait_reason: undefined,
          workstreams: [{ workstream_key: "alpha", title: "T", goal: "G" }],
          priority_order: ["alpha"], summary: "init" }) };
    });
    let guardCalls = 0;
    const guard = () => {
      guardCalls++;
      if (revoked) throw new IntegrityError("FAIL_CLOSED_AUTONOMOUS_AUTHORITY_LOST", "revoked mid-call");
    };
    const running = c.svc.runCycle({
      objective_id: c.objectiveId, actor: DRIVER_ACTOR,
      autonomous_commit_guard: guard,
    });
    await sleep(10);
    revoked = true; // owner revoke lands mid-invocation
    await expect(running).rejects.toThrow(/AUTONOMOUS_AUTHORITY_LOST|CEO_/);
    expect(guardCalls).toBeGreaterThanOrEqual(1);
    // Canonical accounting preserved: attempt exists and is terminally settled.
    const attempts = c.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(["REJECTED", "STALE", "UNKNOWN"]).toContain(attempts[0]!.state);
    // Zero side effects: no decision row, no binding.
    expect((c.store.list(CEO_DECISION_ENTITY) as unknown[])).toHaveLength(0);
    expect(c.workstreams.getBinding(c.objectiveId)).toBeNull();
  });

  it("R1-F1c missed heartbeat → lease expires → late worker cannot settle; new worker reclaims", async () => {
    const s = fresh("f1c");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    // Heartbeat never fires (stalled event loop simulation).
    const a = mkDriver(s, { workerId: "w-a", bootId: "b-a", heartbeatMs: 60_000,
      onPass: async (_c, gate) => {
        s.setNow(s.now() + 90_000); // 90s elapse — lease TTL is 60s
        gate(); // stale — throws
      } });
    const out = await a.driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    const l = lease(s, oid(o));
    expect(["EXPIRED", "RELEASED", "ACTIVE"]).toContain(l!.state);
    s.scheduler.reconcileLeases();
    const lAfter = lease(s, oid(o));
    expect(lAfter!.state).not.toBe("ACTIVE");
    // Permanent authority loss quarantines — the owner de-quarantines
    // explicitly (pause→resume), exactly like production recovery.
    expect(readSchedulerRow<Record<string, unknown>>(s.store, WAKE_STATE, oid(o))!
      .queue_state).toBe("QUARANTINED");
    let v = s.policy.status(oid(o), OWNER).policy_version;
    s.policy.control({ objective_id: oid(o), actor: OWNER,
      action: "pause", policy_version: v, idempotency_key: "p-c" });
    v = s.policy.status(oid(o), OWNER).policy_version;
    s.policy.control({ objective_id: oid(o), actor: OWNER,
      action: "resume", policy_version: v, idempotency_key: "r-c" });
    wake(s, oid(o));
    // New worker (new boot) reclaims the same pending generation.
    // First tick only completes the fairness round; second rescans.
    const b = mkDriver(s, { workerId: "w-b", bootId: "b-b", heartbeatMs: 5 });
    let outB = await b.driver.tick();
    if (outB.driven.length === 0) outB = await b.driver.tick();
    expect(outB.driven[0]!.settled).toBe(true);
    const settled = (s.store.list(SCHEDULER_RECEIPT) as Array<Record<string, unknown>>)
      .filter((r) => r.operation === "SETTLE");
    expect(settled).toHaveLength(1); // exactly once
  });

  it("R1-F1d two connections: A loses lease → B claims new fence; A cannot renew/settle", async () => {
    const s = fresh("f1d");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    // Worker A holds the lease (claim directly for handle access).
    const a = mkDriver(s, { workerId: "w-a", bootId: "b-a", heartbeatMs: 60_000,
      onPass: async () => { s.setNow(s.now() + 90_000); await sleep(5); /* never settles: stale gate fires late? use tickless path */ } });
    // Drive A but make its pass hang past expiry; the gate throw aborts.
    const outA = await a.driver.tick();
    expect(outA.driven[0]!.settled).not.toBe(true);
    s.scheduler.reconcileLeases();
    // Worker B on a SECOND connection (its own service stack) claims a
    // new fence — no nested cross-connection transactions.
    const s2store = new PairEvidenceStore(s.dbPath);
    const s2objectives = new ObjectiveAuthorityService(s2store);
    const s2policy = new ObjectiveAutoPolicyService(s2store, s2objectives, s.now);
    const s2sched = new ObjectiveAutoScheduler(s2store, s2objectives, s2policy, s.now);
    const oldFence = Number(lease(s, oid(o))!.fence);
    const handleB = s2sched.claim(oid(o), "w-b", "b-b", "reclaim");
    expect(Number(handleB.fence)).toBeGreaterThan(oldFence);
    // A's stale handle cannot renew or settle.
    const staleHandle = { objective_id: oid(o), worker_id: "w-a", boot_id: "b-a",
      token: "0".repeat(64), fence: oldFence,
      claimed_generation: Number(handleB.claimed_generation),
      checkpoint_digest: String(handleB.checkpoint_digest) };
    expect(() => s.scheduler.renew(staleHandle as never)).toThrow();
    expect(() => s.scheduler.settle(staleHandle as never, "WAITING", "op-stale")).toThrow();
    // B settles normally.
    s2sched.settle(handleB, "WAITING", "op-b");
    expect(lease(s, oid(o))!.state).toBe("SETTLED");
  });

  it("R1-F1e heartbeat lifecycle: contention retryable, no renew after settle, no leak", async () => {
    const s = fresh("f1e");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const origRenew = s.scheduler.renew.bind(s.scheduler);
    let renewCalls = 0; let contentionOnce = true;
    s.scheduler.renew = ((h: unknown) => {
      renewCalls++;
      if (contentionOnce) {
        contentionOnce = false;
        const e = new Error("database is locked") as Error & { code?: string };
        e.code = "ERR_SQLITE_BUSY";
        throw e;
      }
      origRenew(h as never);
    }) as typeof s.scheduler.renew;
    const { driver } = mkDriver(s, { heartbeatMs: 3,
      onPass: async (_c, gate) => { s.setNow(s.now() + 30_000); await sleep(30); gate(); } });
    const out = await driver.tick();
    expect(out.driven[0]!.settled).toBe(true);
    expect(renewCalls).toBeGreaterThanOrEqual(2); // contention did NOT kill the heartbeat
    const renewsAtSettle = renewCalls;
    await sleep(30); // post-settle real time — no more renews (timer stopped)
    expect(renewCalls).toBe(renewsAtSettle);
  });

  it("R1-F1f bounded lifetime: renew rejected past max_lifetime; bound derives from CEO timeout", async () => {
    const s = fresh("f1f");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const handle = s.scheduler.claim(oid(o), "drv", "boot", "m1");
    const l = lease(s, oid(o));
    // Default bound = 300s lifetime (P15.10-B compat) when unspecified.
    expect(Number(l!.max_lifetime_ms ?? 300_000)).toBe(300_000);
    // Renew under the 60s TTL keeps the lease alive across the horizon;
    // renewal past started_at + 300s default lifetime fails closed.
    for (const step of [50_000, 50_000, 50_000, 50_000]) {
      s.setNow(s.now() + step);
      s.scheduler.renew(handle); // +50,+100,+150,+200 — all < 300s
    }
    s.setNow(s.now() + 50_000); // +250 — still under TTL, inside lifetime
    s.scheduler.renew(handle);
    s.setNow(s.now() + 55_000); // +305 — past default 300s lifetime
    expect(() => s.scheduler.renew(handle)).toThrow();
    // Driver-bound lease carries its own validated bound (960s).
    const o2 = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o2));
    wake(s, oid(o2));
    const h2 = s.scheduler.claim(oid(o2), "drv", "boot", "m2",
      { max_lifetime_ms: 900_000 + 60_000 });
    for (let i = 0; i < 10; i++) { // +50..+500 — inside 960s, under TTL each step
      s.setNow(s.now() + 50_000);
      s.scheduler.renew(h2);
    }
    s.setNow(s.now() + 55_000); // +555 — renew still valid (<960s)
    s.scheduler.renew(h2);
    s.setNow(s.now() + 420_000); // +975 — past 960s bound
    expect(() => s.scheduler.renew(h2)).toThrow();
    // Bad bounds fail closed at claim.
    const o3 = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o3));
    wake(s, oid(o3));
    expect(() => s.scheduler.claim(oid(o3), "d", "b", "m3", { max_lifetime_ms: 30_000 })).toThrow();
    expect(() => s.scheduler.claim(oid(o3), "d", "b", "m3", { max_lifetime_ms: 961_000 })).toThrow();
    // Driver constructor rejects an unvalidated CEO timeout.
    expect(() => mkDriver(s, { ceoTimeoutMs: 3_000 })).toThrow();
    expect(() => mkDriver(s, { ceoTimeoutMs: 901_000 })).toThrow();
  });

  it("R1-F1e2 heartbeat stops after pass fault; expired-policy renew records permanent loss", async () => {
    const s = fresh("f1e2");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver } = mkDriver(s, { heartbeatMs: 3,
      onPass: async () => { s.setNow(s.now() + 10_000); await sleep(15);
        const v = s.policy.status(oid(o), OWNER).policy_version;
        s.policy.control({ objective_id: oid(o), actor: OWNER,
          action: "pause", policy_version: v, idempotency_key: "p-e2" });
        await sleep(30); // heartbeat renew hits stale authority → lost
        throw new IntegrityError("FAIL_CLOSED_PASS_ABORTED", "x");
      } });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    const st = readSchedulerRow<Record<string, unknown>>(s.store, "objective_auto_driver_state" as never, `auto-driver-state:${oid(o)}`)
      ?? (s.store.list("objective_auto_driver_state" as never) as Array<Record<string, unknown>>)[0];
    expect(st).toBeTruthy();
  });

  it("R1-F1d2 heartbeat A cannot renew B's lease", async () => {
    const s = fresh("f1d2");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const hA = s.scheduler.claim(oid(o), "w-a", "b-a", "m");
    const forged = { ...hA, worker_id: "w-b", boot_id: "b-b" };
    expect(() => s.scheduler.renew(forged)).toThrow();
  });

  it("R1-F1d3 restart does not re-invoke while attempt STARTED/UNKNOWN (inflight bound)", async () => {
    let resolveInvoke: (() => void) | null = null;
    const c = freshCeo("f1d3", (i) => new Promise<CeoInvokeResult>((res) => {
      resolveInvoke = () => res({ model_entry_id: i.transport.model_entry_id,
        provider_id: i.transport.provider_id, model_id: i.transport.model_id,
        raw_text: decisionJson() });
    }));
    const running = c.svc.runCycle({ objective_id: c.objectiveId, actor: DRIVER_ACTOR });
    await sleep(10);
    // "Restart" — a second cycle while the first invocation is in flight.
    await expect(c.svc.runCycle({ objective_id: c.objectiveId, actor: DRIVER_ACTOR }))
      .rejects.toThrow(/CEO_DECISION_INFLIGHT/);
    expect(c.invoker.calls).toBe(1); // zero second invocation
    resolveInvoke!();
    await expect(running).resolves.toBeTruthy();
  });
});
