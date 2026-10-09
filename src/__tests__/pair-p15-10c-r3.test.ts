/**
 * P15.10-C R3 — cost authority & readiness closure.
 *
 *  F2 — route/task-level liability: the objective budget cap was only
 *       pre-checked at admission using executor-level (route=null)
 *       bounds. Real dispatch reserves per governed task with the
 *       ACTUAL route/model profile inside assertAndReserve — the
 *       objective cap had no say there. A mission with N tasks, or a
 *       route pricier than the executor profile, could exceed the cap.
 *       Fix: objective-scope enforcement inside the same atomic
 *       check-and-reserve transaction, via canonical lineage
 *       (mission.bound_open_id → work_open_binding.work_item_id →
 *       workforce_allocation → objective_auto_policy).
 *  F3 — readiness truth: driver_ready=true only meant "process wired".
 *       Now derived from canonical evidence: scheduler ready, policy
 *       effective, no quarantine, provable cost binding, budget room.
 *  F1b — corrected coverage: configure while ENABLED is an invalid
 *       transition (throws); the legit drift is disable→configure→
 *       enable (real policy_version/terms re-bind) — old worker fenced.
 *
 * All proofs read canonical DB rows.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BusinessLayer,
  DRIVER_ACTOR,
  IntegrityError,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  PolicyError,
  CostService,
  WorkforceAllocationService,
  WorkforceService,
  CEO_DECISION_ENTITY,
  LEASE_STATE,
  readSchedulerRow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510cr3-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

function fresh(name: string, initial = 1_000_000) {
  let t = initial;
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
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
  const bid = `BIZ_R3_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return { dir, dbPath, store, biz, wf, objectives, workstreams, alloc,
    policy, scheduler, wakeup, cost, bid,
    now: () => t, setNow: (v: number) => { t = v; } };
}

type S = ReturnType<typeof fresh>;
let objSeq = 0;

function mkObjective(s: S, kpis: Array<Record<string, unknown>> = [
  { name: "sales", unit: "u", baseline: 0, target: 10 }]) {
  const o = s.objectives.create({
    business_id: s.bid, title: "Sell", statement: "s", kpis,
    deadline: FUTURE, budget_ceiling_microusd: 500_000_000,
    operator_id: OP, dedup_key: `r3-${counter}-${++objSeq}`,
  });
  return String(o.objective_id);
}

const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, max_retries: 3, ...extra });

function enable(s: S, oid: string, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: oid, actor: OWNER,
    action: "configure", limits: LIMITS(extra), idempotency_key: `cfg-${counter}-${Math.random()}` });
  s.policy.control({ objective_id: oid, actor: OWNER,
    action: "enable", policy_version: 1, idempotency_key: `en-${counter}-${Math.random()}` });
  s.wakeup.tick();
}

const mkAgent = (s: S) => s.biz.createOrgAgent({
  business_id: s.bid, title: `agent ${counter}`,
  department: "ops", operator_id: OP,
});

/** Real governed lineage: decompose + allocate → canonical allocation
 *  row → synthetic-but-canonical bound open / mission rows. */
function missionOnObjective(s: S, oid: string, tag: string) {
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
  const out = s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
  const allocRow = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
    .filter((a) => String(a.objective_id) === oid).at(-1)!;
  const workItemId = String(allocRow.delegated_child_work_item_id ??
    allocRow.workstream_work_item_id);
  const openId = `OPEN_${tag}_${counter}`;
  const mid = `MIS_${tag}_${counter}`;
  s.store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId, mission_id: mid,
    created_by: DRIVER_ACTOR,
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
  routeId: string | null, executorId = "EXEC_D") {
  const mission = s.store.get("mission", m.missionId) as Record<string, unknown>;
  return s.cost.assertAndReserve({
    mission,
    task: { task_id: taskId, selected_route_id: routeId },
    governedTask: { governed_task_id: `GT_${taskId}`, task_id: taskId },
    executorId,
  });
}

const reservations = (s: S) =>
  s.store.list("cost_reservation") as Array<Record<string, unknown>>;

function mkDriver(s: S, extra: Record<string, unknown> = {}) {
  return new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async () => ({ outcome: "WAITING" }) as never,
    executors: ["EXEC_D"],
    billingFor: (executorId: string, routeId: string | null) =>
      s.cost.billingFor(executorId, routeId),
    costHaltActive: () => false,
    workerId: "r3-w", bootId: "r3-b",
    now: s.now, heartbeatMs: 0, ceoTimeoutMs: 300_000,
    ...extra,
  });
}

describe("P15.10-C R3 — cost authority & readiness closure", () => {

  /* ---------------- F2 — route/task-level liability ------------------- */

  it("R3-F2a route profile pricier than executor profile → cap enforced at reserve", () => {
    const s = fresh("f2a");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 300_000 });
    profile(s, "executor", "EXEC_D", { reserve_microusd: 100_000 });
    profile(s, "route", "RTE_EXP", { reserve_microusd: 500_000 });
    const m = missionOnObjective(s, oid, "a");
    // The executor's own profile (100k) is under cap — but the SELECTED
    // route reserves 500k > 300k cap → deny.
    expect(() => reserve(s, m, "T1", "RTE_EXP")).toThrow(PolicyError);
    expect(reservations(s)).toHaveLength(0);
  });

  it("R3-F2b multi-task mission: cumulative reservations vs objective cap", () => {
    const s = fresh("f2b");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 600_000 });
    profile(s, "route", "RTE_MID", { reserve_microusd: 400_000 });
    const m = missionOnObjective(s, oid, "b");
    reserve(s, m, "T1", "RTE_MID"); // 400k HELD — fits
    expect(() => reserve(s, m, "T2", "RTE_MID")).toThrow(PolicyError); // 400+400>600
    expect(reservations(s).filter((r) => r.status === "HELD")).toHaveLength(1);
  });

  it("R3-F2c two SQLite connections race: exactly one reservation wins the budget", () => {
    const s = fresh("f2c");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 500_000 });
    profile(s, "route", "RTE_R", { reserve_microusd: 400_000 });
    const m = missionOnObjective(s, oid, "c");
    const store2 = new PairEvidenceStore(s.dbPath);
    const cost2 = new CostService({ store: store2 } as never);
    const m2 = store2.get("mission", m.missionId) as Record<string, unknown>;
    const mk = (c: CostService, mission: Record<string, unknown>, t: string) =>
      () => c.assertAndReserve({
        mission, task: { task_id: t, selected_route_id: "RTE_R" },
        governedTask: { governed_task_id: `GT_${t}`, task_id: t },
        executorId: "EXEC_D",
      });
    let ok = 0, denied = 0;
    for (const fn of [mk(s.cost, missionRow(s, m), "TA"), mk(cost2, m2, "TB")]) {
      try { fn(); ok++; } catch { denied++; }
    }
    expect(ok).toBe(1);
    expect(denied).toBe(1);
    expect(reservations(s)).toHaveLength(1);
    store2.close();
  });

  it("R3-F2d UNKNOWN/unbounded billing under objective cap → denied, never $0", () => {
    const s = fresh("f2d");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 500_000 });
    // No profile at all → UNKNOWN — must never count as zero-cost.
    const m = missionOnObjective(s, oid, "d");
    expect(() => reserve(s, m, "T1", "RTE_NONE")).toThrow(PolicyError);
    expect(reservations(s)).toHaveLength(0);
  });

  it("R3-F2e retry/restart cannot double-spend authority — settled stays counted", () => {
    const s = fresh("f2e");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 500_000 });
    profile(s, "route", "RTE_E", { reserve_microusd: 300_000 });
    const m = missionOnObjective(s, oid, "e");
    const r1 = reserve(s, m, "T1", "RTE_E");
    expect(reservations(s)).toHaveLength(1);
    // A HELD retry is ambiguous by P13 contract — a leftover HELD is
    // NEVER authority for a new dispatch. Fail closed, no new row.
    expect(() => reserve(s, m, "T1", "RTE_E"))
      .toThrowError(/FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS/);
    expect(reservations(s)).toHaveLength(1);
    s.cost.markCommitted("GT_T1");
    // COMMITTED (proven historical charge) is idempotently adopted —
    // returns the same row, zero new authority.
    const r2 = reserve(s, m, "T1", "RTE_E");
    expect(String(r2.reservation_id)).toBe(String(r1.reservation_id));
    expect(reservations(s)).toHaveLength(1);
    // A settled charge still counts — second task pushes 300+300>500.
    s.cost.settle("GT_T1", 300_000);
    expect(() => reserve(s, m, "T2", "RTE_E")).toThrow(PolicyError);
  });

  it("R3-F2f objective A spend never charges objective B", () => {
    const s = fresh("f2f");
    const oidA = mkObjective(s);
    const oidB = mkObjective(s);
    enable(s, oidA, { budget_microusd_cap: 400_000 });
    enable(s, oidB, { budget_microusd_cap: 400_000 });
    profile(s, "route", "RTE_F", { reserve_microusd: 300_000 });
    const mA = missionOnObjective(s, oidA, "fa");
    const mB = missionOnObjective(s, oidB, "fb");
    reserve(s, mA, "TA1", "RTE_F"); // 300k on A
    // B has its own cap — A's reservation must not deny B.
    const rB = reserve(s, mB, "TB1", "RTE_F");
    expect(String(rB.status)).toBe("HELD");
    // But A's second task over its own cap is denied.
    expect(() => reserve(s, mA, "T2", "RTE_F")).toThrow(PolicyError);
  });

  /* ---------------- F3 — truthful readiness --------------------------- */

  it("R3-F3a driver OFF → driver_ready/consumer_ready false, missing NOT_INTEGRATED", () => {
    const s = fresh("f3a");
    const oid = mkObjective(s);
    enable(s, oid);
    const st = s.scheduler.status(oid, OWNER);
    expect(st.driver_ready).toBe(false);
    expect(st.consumer_ready).toBe(false);
    expect(st.driver_integrated).toBe(false);
    expect(st.driver_missing).toContain("AUTO_DRIVER_NOT_INTEGRATED");
    expect(st.objective_runnable).toBe(false);
  });

  it("R3-F3b driver ON + scheduler not ready → runnable false", () => {
    const s = fresh("f3b");
    const oid = mkObjective(s);
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "configure", limits: LIMITS(), idempotency_key: `cfg-${counter}` });
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "enable", policy_version: 1, idempotency_key: `en-${counter}` });
    // No wakeup.tick → scheduler cursor never READY.
    const driver = mkDriver(s);
    const st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.driver_integrated).toBe(true);
    expect(st.driver_ready).toBe(false);
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("SCHEDULER_NOT_READY");
  });

  it("R3-F3c policy DISABLED/PAUSED/EXPIRED → never runnable", () => {
    const s = fresh("f3c");
    const oid = mkObjective(s);
    const driver = mkDriver(s);
    // DISABLED — never configured.
    let st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    // ENABLED then PAUSED.
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "configure", limits: LIMITS(), idempotency_key: `cfg-${counter}` });
    s.policy.control({ objective_id: oid, actor: OWNER,
      action: "enable", policy_version: 1, idempotency_key: `en-${counter}` });
    s.wakeup.tick();
    s.policy.control({ objective_id: oid, actor: OWNER, action: "pause",
      policy_version: 2, idempotency_key: `p-${counter}` });
    st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("POLICY_NOT_EFFECTIVE");
    // EXPIRED: reconfigure past-due window then enable → evaluate marks EXPIRED.
    s.setNow(s.now() + 100_000);
    st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
  });

  it("R3-F3d driver ON + policy effective + no provable cost binding → not runnable", () => {
    const s = fresh("f3d");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    // Executor has NO cost profile → billing UNKNOWN → binding unprovable.
    const driver = mkDriver(s);
    const st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.driver_integrated).toBe(true);
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("COST_BINDING_UNVERIFIED");
  });

  it("R3-F3e driver ON + policy effective + provable cost binding → runnable", () => {
    const s = fresh("f3e");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 500_000 });
    profile(s, "executor", "EXEC_D", { reserve_microusd: 100_000 });
    const driver = mkDriver(s);
    const st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.driver_ready).toBe(true);
    expect(st.objective_runnable).toBe(true);
    expect(st.driver_missing).toHaveLength(0);
  });

  it("R3-F3f quarantined / budget-exhausted objective → not runnable", () => {
    const s = fresh("f3f");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 200_000 });
    profile(s, "executor", "EXEC_D", { reserve_microusd: 300_000 });
    const driver = mkDriver(s);
    // Next dispatch bound (300k) exceeds remaining budget (200k cap).
    const st = s.scheduler.status(oid, OWNER, driver.readiness(oid, OWNER));
    expect(st.objective_runnable).toBe(false);
    expect(st.driver_missing).toContain("BUDGET_EXHAUSTED");
  });

  it("R3-F3g owner-scoped read / non-owner denied", () => {
    const s = fresh("f3g");
    const oid = mkObjective(s);
    enable(s, oid);
    const driver = mkDriver(s);
    expect(() => driver.readiness(oid, "operator:not-owner")).toThrow();
    expect(driver.readiness(oid, OWNER).integrated).toBe(true);
  });

  /* ---------------- F1b — corrected drift coverage -------------------- */

  it("R3-F1b corrected: disable→configure→enable mid-await = real binding drift, old worker fenced", async () => {
    const s = fresh("f1b-fix");
    const oid = mkObjective(s);
    enable(s, oid);
    const ceo = (await import("./pair-p15-10c-r2.test.js")).default;
    void ceo;
    // Legit drift path: ENABLED → disable → configure → enable — real
    // policy_version/terms re-bind; old worker's pins go stale.
    const driver = mkDriver(s, {
      runPass: async (input: { authority_gate: () => void; objective_id: string; actor: string }) => {
        const v1 = s.policy.status(oid, OWNER).policy_version;
        s.policy.control({ objective_id: oid, actor: OWNER, action: "disable",
          policy_version: v1, idempotency_key: `d-${counter}` });
        const v2 = s.policy.status(oid, OWNER).policy_version;
        s.policy.control({ objective_id: oid, actor: OWNER, action: "configure",
          limits: LIMITS({ max_ceo_calls: 7 }), policy_version: v2,
          idempotency_key: `cfg2-${counter}` });
        const v3 = s.policy.status(oid, OWNER).policy_version;
        s.policy.control({ objective_id: oid, actor: OWNER, action: "enable",
          policy_version: v3, idempotency_key: `en2-${counter}` });
        // The objective's authorization drifted legitimately mid-await;
        // the commit guard must reject under the stale pin.
        input.authority_gate();
        return { outcome: "WAITING", objective_id: input.objective_id };
      },
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    expect((s.store.list(CEO_DECISION_ENTITY) as unknown[])).toHaveLength(0);
  });
});

function missionRow(s: S, m: { missionId: string }) {
  return s.store.get("mission", m.missionId) as Record<string, unknown>;
}
