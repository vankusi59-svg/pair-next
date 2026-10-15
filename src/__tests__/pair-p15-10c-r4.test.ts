/**
 * P15.10-C R4 — final readiness & cost proof.
 *
 *  F3 — readiness could report READY while the objective cannot be
 *       claimed. `claim()` enforces WAITING_CONSUMER + pending
 *       generation + next_due + cooldown + authority pins + no active
 *       lease; readiness() now consumes the SAME predicate via
 *       scheduler.claimable() — never a second scheduler in the driver.
 *  F2-A — lineage: a mission with an objective-binding claim whose
 *       canonical lineage is missing/contradictory must fail closed
 *       (FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED), never be treated as a
 *       manual mission that skips the objective cap.
 *  F2-B — pricing identity/amount re-resolved INSIDE the atomic
 *       check-and-reserve txn; a profile edit committed between the
 *       advisory outer read and the txn can never slip a stale price.
 *  F2-C — real cross-connection competition: a sibling reservation
 *       committed before this txn is seen in-txn; two tasks can never
 *       both reserve over the objective cap.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BusinessLayer,
  DRIVER_ACTOR,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  PolicyError,
  CostService,
  WorkforceAllocationService,
  WorkforceService,
  WAKE_STATE,
  providerEntryId,
  CODEX_CLI_PROVIDER_ID,
  writeSchedulerRow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510cr4-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;
let objSeq = 0;

function fresh(name: string, initial = 1_000_000) {
  let t = initial;
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "s.db");
  const store = new PairEvidenceStore(dbPath);
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives, workstreams });
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  const cost = new CostService({ store } as never);
  const bid = `BIZ_R4_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  // AUDIT R1 F4 — the CEO subscription lane is proven independently of
  // executor supply: the canonical codex-cli provider session (AUTH_OK)
  // is environmental state every stack in this file shares.
  const pid = providerEntryId(CODEX_CLI_PROVIDER_ID);
  store.put("provider", pid, {
    provider_id: CODEX_CLI_PROVIDER_ID, entry_id: pid,
    auth_state: "AUTH_OK", lifecycle_state: "QUALIFIED",
    health_state: "READY", probe_state: "PROBED", conditions: [],
  }, 0);
  return { dir, dbPath, store, biz, wf, objectives, workstreams, alloc,
    policy, scheduler, wakeup, cost, bid,
    now: () => t, setNow: (v: number) => { t = v; } };
}

type S = ReturnType<typeof fresh>;

function mkObjective(s: S) {
  const o = s.objectives.create({
    business_id: s.bid, title: "Sell", statement: "s",
    kpis: [{ name: "sales", unit: "u", baseline: 0, target: 10 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000_000,
    operator_id: OP, dedup_key: `r4-${counter}-${++objSeq}`,
  });
  return String(o.objective_id);
}

const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, max_retries: 3, ...extra });

function enable(s: S, oid: string, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: oid, actor: OWNER,
    action: "configure", limits: LIMITS(extra), idempotency_key: `cfg-${Math.random()}` });
  s.policy.control({ objective_id: oid, actor: OWNER,
    action: "enable", policy_version: 1, idempotency_key: `en-${Math.random()}` });
  s.wakeup.tick();
}

const mkAgent = (s: S) => s.biz.createOrgAgent({
  business_id: s.bid, title: `agent ${counter}`,
  department: "ops", operator_id: OP,
});

function missionOnObjective(s: S, oid: string, tag: string,
  opts: { manual?: boolean } = {}) {
  const o = s.objectives.get(oid);
  if (!(s.store.list("workstream_binding") as Array<Record<string, unknown>>)
      .some((b) => String(b.objective_id) === oid)) {
    s.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    mkAgent(s);
  }
  s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
  const allocRow = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
    .filter((a) => String(a.objective_id) === oid).at(-1)!;
  const workItemId = String(allocRow.delegated_child_work_item_id ??
    allocRow.workstream_work_item_id);
  const openId = `OPEN_${tag}_${counter}_${Math.random()}`;
  const mid = `MIS_${tag}_${counter}_${Math.random()}`;
  s.store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId, mission_id: mid,
    // AUDIT R1 F2 — `manual: true` keeps owner provenance: the
    // pricing-pin and cap-race tests exercise objective-cap arithmetic,
    // which binds any lineage; driver-attributed METERED reservations
    // are categorically denied by the autonomous gate.
    created_by: opts.manual ? OWNER : DRIVER_ACTOR,
    business_id: s.bid, project_id: "PRJ_TEST",
    state: "BOUND",
  }, 0);
  s.store.put("mission", mid, {
    mission_id: mid, bound_open_id: openId, metadata: {},
    state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
  }, 0);
  return { missionId: mid, openId, workItemId };
}

const profile = (s: S, refType: "route" | "model" | "executor", refId: string,
  extra: Record<string, unknown>) =>
  s.cost.upsertCostProfile({ ref_type: refType, ref_id: refId,
    billing_mode: "METERED_API", ...extra }, "t");

function reserve(s: S, m: { missionId: string }, taskId: string,
  routeId: string | null, executorId = "CODEX") {
  const mission = s.store.get("mission", m.missionId) as Record<string, unknown>;
  return s.cost.assertAndReserve({
    mission,
    task: { task_id: taskId, selected_route_id: routeId },
    governedTask: { governed_task_id: `GT_${taskId}`, task_id: taskId },
    executorId,
  });
}

function mkDriver(s: S, extra: Record<string, unknown> = {}) {
  // PR #121 — autonomous supply derives from canonical executor rows.
  const executorIds = (extra.executors as string[] | undefined) ?? ["CODEX"];
  for (const eid of executorIds) {
    if (!s.store.tryGet("executor", eid)) {
      s.store.put("executor", eid, {
        executor_id: eid, executor_type: "EXTERNAL", status: "ENABLED",
        health_state: "READY", capabilities: [],
        metadata: { qualification_state: "QUALIFIED" },
      }, 0);
    }
  }
  return new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async () => ({ outcome: "WAITING" }) as never,
    executors: executorIds,
    billingFor: (executorId: string, routeId: string | null) =>
      s.cost.billingFor(executorId, routeId),
    costHaltActive: () => false,
    workerId: "r4-w", bootId: "r4-b",
    now: s.now, heartbeatMs: 0, ceoTimeoutMs: 300_000,
    ...extra,
  });
}

/** Rewrite the canonical queue row through the protected write path —
 *  the same commit-revision machinery every scheduler mutation uses. */
function setQueue(s: S, oid: string, patch: Record<string, unknown>) {
  const q = s.store.get("objective_auto_state", oid) as Record<string, unknown>;
  writeSchedulerRow(s.store, WAKE_STATE, oid, { ...q, ...patch },
    "TEST_PATCH", `r4-test-${Math.random()}`);
}

describe("P15.10-C R4 — final readiness & cost proof", () => {

  /* ---------------- F3: claimable = claim()'s own predicate ---------- */

  it("R4-F3-1 scheduler READY but objective never queued → NO_QUEUE", () => {
    const s = fresh("q1");
    const oid = mkObjective(s);
    s.wakeup.tick(); // cursor READY; this objective was never woken → no queue
    const driver = mkDriver(s);
    const st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.driver_integrated).toBe(true);
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("NO_QUEUE");
    // claim() agrees — same predicate, never drifts
    expect(() => s.scheduler.claim(oid, "w", "b", "op")).toThrow();
  });

  it("R4-F3-2 queue BLOCKED_RETRY_EXHAUSTED → not runnable", () => {
    const s = fresh("q2");
    const oid = mkObjective(s);
    enable(s, oid);
    setQueue(s, oid, { queue_state: "BLOCKED_RETRY_EXHAUSTED" });
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("QUEUE_BLOCKED_RETRY_EXHAUSTED");
  });

  it("R4-F3-3 queue WAITING_EVIDENCE → not runnable", () => {
    const s = fresh("q3");
    const oid = mkObjective(s);
    enable(s, oid);
    setQueue(s, oid, { queue_state: "WAITING_EVIDENCE" });
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("QUEUE_WAITING_EVIDENCE");
  });

  it("R4-F3-4 queue BLOCKED_AUTHORITY → not runnable", () => {
    const s = fresh("q4");
    const oid = mkObjective(s);
    enable(s, oid);
    setQueue(s, oid, { queue_state: "BLOCKED_AUTHORITY" });
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("QUEUE_BLOCKED_AUTHORITY");
  });

  it("R4-F3-5 queue QUARANTINED → not runnable", () => {
    const s = fresh("q5");
    const oid = mkObjective(s);
    enable(s, oid);
    s.scheduler.quarantine(oid, "operator-quarantine");
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("QUEUE_QUARANTINED");
  });

  it("R4-F3-6 next_due in the future → NOT_DUE_YET", () => {
    const s = fresh("q6");
    const oid = mkObjective(s);
    enable(s, oid);
    setQueue(s, oid, { next_due: s.now() + 600_000 });
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("NOT_DUE_YET");
  });

  it("R4-F3-7 pending generation already claimed+settled → NO_PENDING_GENERATION", () => {
    const s = fresh("q7");
    const oid = mkObjective(s);
    enable(s, oid);
    const q = s.store.get("objective_auto_state", oid) as Record<string, unknown>;
    const pending = Number(q.pending_generation);
    setQueue(s, oid, { claimed_generation: pending, settled_generation: pending });
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("NO_PENDING_GENERATION");
  });

  it("R4-F3-8 ACTIVE lease held by another worker → LEASE_HELD", () => {
    const s = fresh("q8");
    const oid = mkObjective(s);
    enable(s, oid);
    s.scheduler.claim(oid, "worker-other", "boot-x", "opportunity-1");
    // past the 30s attempt cooldown so LEASE_HELD — not the transient
    // cooldown — is the reported reason; lease TTL is 60s.
    s.setNow(s.now() + 31_000);
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("LEASE_HELD");
  });

  it("R4-F3-9 driver integrated + objective actually eligible → runnable", () => {
    const s = fresh("q9");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 5_000_000 });
    // AUDIT R1 F2/F4 — autonomous runnable requires the proven
    // subscription lane: ACTIVE SUBSCRIPTION executor profile + the
    // AUTH_OK session seeded in fresh(); metered is never runnable.
    s.cost.upsertCostProfile({ ref_type: "executor", ref_id: "CODEX",
      billing_mode: "SUBSCRIPTION" }, "t");
    const st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.driver_integrated).toBe(true);
    expect(st.objective_runnable).toBe(true);
    expect(st.driver_ready).toBe(true);
    expect(st.driver_missing).toEqual([]);
  });

  it("R4-F3-10 REAL policy expiry — expires_at passes, not a 2999 fixture", () => {
    const s = fresh("q10");
    const oid = mkObjective(s);
    const soon = new Date(s.now() + 30_000).toISOString();
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "configure", limits: LIMITS({ expires_at: soon }),
      idempotency_key: `cfg-x-${Math.random()}` });
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "enable", policy_version: 1, idempotency_key: `en-x-${Math.random()}` });
    // AUDIT R1 F2/F4 — the subscription lane must be proven for the
    // in-window readiness to be runnable (SUBSCRIPTION + AUTH_OK).
    s.cost.upsertCostProfile({ ref_type: "executor", ref_id: "CODEX",
      billing_mode: "SUBSCRIPTION" }, "t");
    s.wakeup.tick();
    let st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(true); // effective while inside window
    s.setNow(s.now() + 31_000); // real expiry: the deadline has passed
    st = s.scheduler.status(oid, OWNER, mkDriver(s).readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("POLICY_NOT_EFFECTIVE");
    const pst = s.policy.status(oid, OWNER);
    expect(pst.effective).toBe(false); // DB evidence: actually expired
  });

  /* ---------------- F2-A: broken lineage never fail-opens ----------- */

  const manualMission = (s: S, tag: string) => {
    const wid = `WI_MAN_${tag}`;
    s.store.put("work_item", wid, {
      work_item_id: wid, business_id: s.bid, project_id: "PRJ_TEST",
      state: "BACKLOG", version: 0,
    }, 0);
    const openId = `OPEN_MAN_${tag}`;
    const mid = `MIS_MAN_${tag}`;
    s.store.put("work_open_binding", openId, {
      open_id: openId, work_item_id: wid, mission_id: mid,
      created_by: "operator:x", business_id: s.bid, project_id: "PRJ_TEST",
      state: "BOUND",
    }, 0);
    s.store.put("mission", mid, {
      mission_id: mid, bound_open_id: openId, metadata: {},
      state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
    }, 0);
    return { missionId: mid };
  };

  it("R4-F2A-1 truly manual mission (no objective anywhere) → reserves fine", () => {
    const s = fresh("f2a1");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    const m = manualMission(s, "a");
    // Manual mission is NOT governed by the objective cap — the
    // business-scope policies still apply, none here → allowed.
    const r = reserve(s, m, "MT1", "RTE_M");
    expect(String(r.status)).toBe("HELD");
    expect(Number(r.reserved_microusd)).toBe(500_000);
  });

  it("R4-F2A-2 bound_open_id set but wob row missing → BROKEN, deny", () => {
    const s = fresh("f2a2");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    s.store.put("mission", "MIS_GHOST", {
      mission_id: "MIS_GHOST", bound_open_id: "OPEN_GONE", metadata: {},
      state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
    }, 0);
    expect(() => reserve(s, { missionId: "MIS_GHOST" }, "GT1", "RTE_M"))
      .toThrowError(/FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED/);
  });

  it("R4-F2A-3 wob → work_item missing AND no allocation → BROKEN, deny", () => {
    const s = fresh("f2a3");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    s.store.put("work_open_binding", "OPEN_ORPHAN", {
      open_id: "OPEN_ORPHAN", work_item_id: "WI_GONE", mission_id: "MIS_ORPHAN",
      created_by: DRIVER_ACTOR, business_id: s.bid, project_id: "PRJ_TEST",
      state: "BOUND",
    }, 0);
    s.store.put("mission", "MIS_ORPHAN", {
      mission_id: "MIS_ORPHAN", bound_open_id: "OPEN_ORPHAN", metadata: {},
      state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
    }, 0);
    expect(() => reserve(s, { missionId: "MIS_ORPHAN" }, "GT2", "RTE_M"))
      .toThrowError(/FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED/);
  });

  it("R4-F2A-4 item claims objective A but allocation only under B → BROKEN", () => {
    const s = fresh("f2a4");
    const oidA = mkObjective(s);
    const oidB = mkObjective(s);
    enable(s, oidA, { budget_microusd_cap: 10_000_000 });
    enable(s, oidB, { budget_microusd_cap: 10_000_000 });
    const m = missionOnObjective(s, oidA, "mism");
    // Tamper: the work_item claims A but the allocation is re-pointed at B.
    const alloc = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
      .filter((a) => String(a.objective_id) === oidA).at(-1)!;
    s.store.put("workforce_allocation", String(alloc.allocation_id),
      { ...alloc, objective_id: oidB }, Number(alloc.version));
    profile(s, "route", "RTE_M", { reserve_microusd: 1_000 });
    expect(() => reserve(s, m, "GT3", "RTE_M"))
      .toThrowError(/FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED/);
  });

  /* ---------------- F2-B: pricing identity inside the txn ----------- */

  it("R4-F2B pricing race: profile edit committed between advisory read and txn is pinned", () => {
    const s = fresh("f2b");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 5_000_000 });
    profile(s, "route", "RTE_P", { reserve_microusd: 100_000 });
    const m = missionOnObjective(s, oid, "p", { manual: true });
    // A second connection updates the price BETWEEN the advisory
    // billingFor() and the atomic txn — injected at immediate() entry.
    const store2 = new PairEvidenceStore(s.dbPath);
    const cost2 = new CostService({ store: store2 } as never);
    const orig = s.store.immediate.bind(s.store);
    (s.store as unknown as { immediate: unknown }).immediate = (fn: () => unknown) => {
      cost2.upsertCostProfile({ ref_type: "route", ref_id: "RTE_P",
        billing_mode: "METERED_API", reserve_microusd: 500_000 }, "t");
      return orig(fn as () => never);
    };
    const r = reserve(s, m, "TP1", "RTE_P");
    // The pinned snapshot must be the NEW price — never the stale one.
    expect(Number(r.reserved_microusd)).toBe(500_000);
    expect(Number(r.profile_reserve_microusd)).toBe(500_000);
  });

  /* ---------------- F2-C: real cross-connection competition --------- */

  it("R4-F2C sibling reservation committed inside the race window is seen in-txn", () => {
    const s = fresh("f2c");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 500_000 });
    profile(s, "route", "RTE_R", { reserve_microusd: 400_000 });
    const m = missionOnObjective(s, oid, "cc", { manual: true });
    const store2 = new PairEvidenceStore(s.dbPath);
    const cost2 = new CostService({ store: store2 } as never);
    // Connection 2 wins the race: it commits its reservation exactly at
    // the moment connection 1 enters its atomic check-and-reserve txn.
    const orig = s.store.immediate.bind(s.store);
    (s.store as unknown as { immediate: unknown }).immediate = (fn: () => unknown) => {
      const mission2 = store2.get("mission", m.missionId) as Record<string, unknown>;
      cost2.assertAndReserve({
        mission: mission2,
        task: { task_id: "TC2", selected_route_id: "RTE_R" },
        governedTask: { governed_task_id: "GT_TC2", task_id: "TC2" },
        executorId: "CODEX",
      });
      return orig(fn as () => never);
    };
    // Connection 1 must see connection 2's committed HELD inside the
    // txn and be denied — never double-reserve past the cap.
    expect(() => reserve(s, m, "TC1", "RTE_R"))
      .toThrowError(/FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED/);
    const held = (s.store.list("cost_reservation") as Array<Record<string, unknown>>)
      .filter((r) => r.status === "HELD");
    expect(held).toHaveLength(1);
    expect(String(held[0]!.governed_task_id)).toBe("GT_TC2");
  });

  it("R4-F2C-2 read-only status projection never creates wake/lease rows", () => {
    const s = fresh("f2c2");
    const oid = mkObjective(s);
    enable(s, oid);
    // AUDIT R1 F2/F4 — runnable requires the proven subscription lane.
    s.cost.upsertCostProfile({ ref_type: "executor", ref_id: "CODEX",
      billing_mode: "SUBSCRIPTION" }, "t");
    const leasesBefore = s.store.list("objective_auto_lease").length;
    const receiptsBefore = s.store.list("objective_auto_receipt").length;
    const r = mkDriver(s).readiness(oid, OWNER);
    expect(r.objective_runnable).toBe(true);
    expect(s.store.list("objective_auto_lease")).toHaveLength(leasesBefore);
    expect(s.store.list("objective_auto_receipt")).toHaveLength(receiptsBefore);
  });
});
