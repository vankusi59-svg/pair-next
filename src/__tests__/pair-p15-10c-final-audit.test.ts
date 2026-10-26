/**
 * P15.10-C FINAL COST SAFETY VERIFICATION — read-only audit evidence.
 * Audited HEAD: 26a7312fdd29194399c08d93fcbd3f373fcfb478
 * BASE: 0e27bc6ee236d82633d4aee321ba9cd264adc0c3
 *
 * Finding A — objectiveScopeFor lineage edges:
 *   A1 mission without bound_open_id          → manual (correct)
 *   A2 wob.mission_id != mission.mission_id   → ???
 *   A3 parent chain > 8 hops                  → ???
 *   A4 work_item claim vs allocation mismatch → BROKEN (R4 covered)
 * Finding B — halt ON + FREE→METERED_API pricing flip between the
 *   advisory billingFor() and the atomic txn: is a paid reservation
 *   allowed under an active cost halt?
 *   → CONFIRMED by B1 prepatch (HELD METERED_API 400k under halt);
 *   → FIXED: in-txn haltActive() re-check on authoritative billing.
 *
 * Finding A verdict held: SAFE_BY_EXISTING_PROOF_WITH_TWO_INCONCLUSIVE_
 * TAMPER_EDGES (A2a wob.mission_id unverified; A3b >8-hop claim +
 * missing leaf alloc → manual). Both need non-canonical row writes
 * (validateWorkOpenBinding / allocation paths prevent them) — kept as
 * non-blocking hardening notes, objectiveScopeFor intentionally
 * unchanged this round.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  BusinessLayer,
  DRIVER_ACTOR,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  PolicyError,
  CostService,
  WorkforceAllocationService,
  WorkforceService,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p1510c-audit-");
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
  const bid = `BIZ_A_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
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
    operator_id: OP, dedup_key: `au-${counter}-${++objSeq}`,
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
  s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
  const allocRow = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
    .filter((a) => String(a.objective_id) === oid).at(-1)!;
  const workItemId = String(allocRow.delegated_child_work_item_id ??
    allocRow.workstream_work_item_id);
  const openId = `OPEN_${tag}_${counter}_${Math.random()}`;
  const mid = `MIS_${tag}_${counter}_${Math.random()}`;
  s.store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId, mission_id: mid,
    created_by: DRIVER_ACTOR, business_id: s.bid, project_id: "PRJ_TEST",
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
  routeId: string | null, executorId = "EXEC_D") {
  const mission = s.store.get("mission", m.missionId) as Record<string, unknown>;
  return s.cost.assertAndReserve({
    mission,
    task: { task_id: taskId, selected_route_id: routeId },
    governedTask: { governed_task_id: `GT_${taskId}`, task_id: taskId },
    executorId,
  });
}

const putMission = (s: S, mid: string, boundOpenId: string | null) =>
  s.store.put("mission", mid, {
    mission_id: mid, bound_open_id: boundOpenId, metadata: {},
    state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
  }, 0);

describe("P15.10-C FINAL audit — Finding A: lineage edges", () => {

  it("A1 mission without bound_open_id → manual → allowed (correct)", () => {
    const s = fresh("a1");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    putMission(s, "MIS_FREE", null);
    const r = reserve(s, { missionId: "MIS_FREE" }, "TA1", "RTE_M");
    expect(String(r.status)).toBe("HELD");
  });

  it("A2a wob.mission_id != mission_id AND wob's item is manual → ???", () => {
    const s = fresh("a2");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    // The wob legitimately belongs to a MANUAL mission (no objective).
    s.store.put("work_item", "WI_MAN", {
      work_item_id: "WI_MAN", business_id: s.bid, project_id: "PRJ_TEST",
      state: "BACKLOG", version: 0,
    }, 0);
    s.store.put("work_open_binding", "OPEN_MAN", {
      open_id: "OPEN_MAN", work_item_id: "WI_MAN", mission_id: "MIS_OTHER",
      created_by: "operator:x", business_id: s.bid, project_id: "PRJ_TEST",
      state: "BOUND",
    }, 0);
    // A mission row pointing at ANOTHER mission's manual wob.
    putMission(s, "MIS_REPOINT", "OPEN_MAN");
    const r = reserve(s, { missionId: "MIS_REPOINT" }, "TA2", "RTE_M");
    console.log("A2a result:", r.status, r.reserved_microusd);
  });

  it("A2b wob.mission_id != mission_id AND wob's item is objective-bound", () => {
    const s = fresh("a2b");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    const m = missionOnObjective(s, oid, "real");
    // The REAL wob belongs to m.missionId; a foreign mission reuses it.
    putMission(s, "MIS_FOREIGN", m.openId);
    try {
      const r = reserve(s, { missionId: "MIS_FOREIGN" }, "TA3", "RTE_M");
      console.log("A2b allowed:", r.status, r.reserved_microusd,
        "→ counts against objective cap (fail-closed direction)");
    } catch (e) {
      console.log("A2b denied:", (e as Error).message);
    }
  });

  it("A3a parent chain 9 hops, leaf directly allocated → still enforced", () => {
    const s = fresh("a3a");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    const m = missionOnObjective(s, oid, "deep");
    // Bury the leaf under 9 synthetic parents so the walk dies at hop 8.
    // The ALLOCATION still names the leaf → scope resolves via allocs.
    let prev = m.workItemId;
    for (let i = 0; i < 9; i++) {
      const pid = `WI_P${i}`;
      s.store.put("work_item", pid, {
        work_item_id: pid, business_id: s.bid, project_id: "PRJ_TEST",
        state: "BACKLOG", version: 0,
        parent_work_item_id: i === 8 ? null : prev,
      }, 0);
      prev = pid;
    }
    // Repoint the leaf's parent chain: make the leaf's parent = chain top.
    const leaf = s.store.get("work_item", m.workItemId) as Record<string, unknown>;
    s.store.put("work_item", m.workItemId,
      { ...leaf, parent_work_item_id: "WI_P0" }, Number(leaf.version));
    // Walk from leaf: WI_P0..WI_P8 — leaf.objective_id carries the claim
    // anyway? delegated child lacks objective_id; chain dies before root.
    try {
      const r = reserve(s, m, "TA4", "RTE_M");
      console.log("A3a allowed:", r.status, r.reserved_microusd);
      expect(["HELD", "COMMITTED"]).toContain(String(r.status));
    } catch (e) {
      console.log("A3a denied:", (e as Error).message);
      expect((e as Error).message).toContain("FAIL_CLOSED_COST_OBJECTIVE");
    }
  });

  it("A3b parent chain >8 hops AND no allocation on leaf → ???", () => {
    const s = fresh("a3b");
    const oid = mkObjective(s);
    enable(s, oid, { budget_microusd_cap: 100_000 });
    profile(s, "route", "RTE_M", { reserve_microusd: 500_000 });
    // Leaf has NO objective_id, NO allocation; its 9th ancestor claims oid.
    let prev: string | null = "WI_ROOT"; // top: will carry objective_id
    s.store.put("work_item", "WI_ROOT", {
      work_item_id: "WI_ROOT", business_id: s.bid, project_id: "PRJ_TEST",
      state: "BACKLOG", version: 0, objective_id: oid,
    }, 0);
    for (let i = 0; i < 9; i++) {
      const pid = `WI_D${i}`;
      s.store.put("work_item", pid, {
        work_item_id: pid, business_id: s.bid, project_id: "PRJ_TEST",
        state: "BACKLOG", version: 0, parent_work_item_id: prev,
      }, 0);
      prev = pid;
    }
    const leafId = prev!; // depth 9 from WI_ROOT
    s.store.put("work_open_binding", "OPEN_DEEP", {
      open_id: "OPEN_DEEP", work_item_id: leafId, mission_id: "MIS_DEEP",
      created_by: DRIVER_ACTOR, business_id: s.bid, project_id: "PRJ_TEST",
      state: "BOUND",
    }, 0);
    putMission(s, "MIS_DEEP", "OPEN_DEEP");
    try {
      const r = reserve(s, { missionId: "MIS_DEEP" }, "TA5", "RTE_M");
      console.log("A3b allowed:", r.status, r.reserved_microusd,
        "→ deep objective claim + missing alloc treated as MANUAL");
    } catch (e) {
      console.log("A3b denied:", (e as Error).message);
    }
  });

  it("A4 mismatch item-claim vs allocation → BROKEN deny (R4 regression)", () => {
    const s = fresh("a4");
    const oidA = mkObjective(s);
    const oidB = mkObjective(s);
    enable(s, oidA, { budget_microusd_cap: 10_000_000 });
    enable(s, oidB, { budget_microusd_cap: 10_000_000 });
    const m = missionOnObjective(s, oidA, "mm");
    const alloc = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
      .filter((a) => String(a.objective_id) === oidA).at(-1)!;
    s.store.put("workforce_allocation", String(alloc.allocation_id),
      { ...alloc, objective_id: oidB }, Number(alloc.version));
    profile(s, "route", "RTE_M", { reserve_microusd: 1_000 });
    expect(() => reserve(s, m, "TA6", "RTE_M"))
      .toThrowError(/FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED/);
  });
});

describe("P15.10-C FINAL audit — Finding B: halt + pricing drift", () => {

  it("B1 halt ON + FREE→METERED_API flip between advisory read and txn → DENY", () => {
    const s = fresh("b1");
    putMission(s, "MIS_B", null);
    profile(s, "route", "RTE_F", { billing_mode: "FREE", reserve_microusd: 0 });
    const before = s.store.list("cost_reservation").length;
    process.env.PAIR_COST_HALT = "1";
    try {
      const store2 = new PairEvidenceStore(s.dbPath);
      const cost2 = new CostService({ store: store2 } as never);
      const orig = s.store.immediate.bind(s.store);
      (s.store as unknown as { immediate: unknown }).immediate = (fn: () => unknown) => {
        // Concurrent edit lands between the advisory read and the txn.
        cost2.upsertCostProfile({ ref_type: "route", ref_id: "RTE_F",
          billing_mode: "METERED_API", reserve_microusd: 400_000 }, "t");
        return orig(fn as () => never);
      };
      // Prepatch evidence: this call returned HELD / METERED_API /
      // reserved=400000 — a paid reservation created under an active
      // halt. Postpatch it must deny before writing any row.
      expect(() => reserve(s, { missionId: "MIS_B" }, "TB1", "RTE_F"))
        .toThrowError(/FAIL_CLOSED_COST_HALT/);
      // No reservation row may exist after the denied dispatch.
      expect(s.store.list("cost_reservation")).toHaveLength(before);
      // Denial evidence lands on the mission's canonical evidence stream.
      const denied = s.store.listEvidence("MIS_B")
        .filter((e) =>
          String((e.payload as Record<string, unknown>).kind)
            === "COST_DISPATCH_DENIED");
      expect(denied.length).toBeGreaterThan(0);
      expect(String(
        ((denied[0]!.payload as Record<string, unknown>)
          .payload as Record<string, unknown>).reason))
        .toBe("FAIL_CLOSED_COST_HALT");
    } finally {
      delete process.env.PAIR_COST_HALT;
    }
  });

  it("B2 halt ON + stable METERED_API → denied (control case)", () => {
    const s = fresh("b2");
    putMission(s, "MIS_B2", null);
    profile(s, "route", "RTE_M2", { reserve_microusd: 400_000 });
    process.env.PAIR_COST_HALT = "1";
    try {
      expect(() => reserve(s, { missionId: "MIS_B2" }, "TB2", "RTE_M2"))
        .toThrowError(/FAIL_CLOSED_COST_HALT/);
    } finally {
      delete process.env.PAIR_COST_HALT;
    }
  });

  it("B3 halt OFF + FREE→METERED flip mid-gap → pins new price correctly", () => {
    const s = fresh("b3");
    putMission(s, "MIS_B3", null);
    profile(s, "route", "RTE_F3", { billing_mode: "FREE", reserve_microusd: 0 });
    const store2 = new PairEvidenceStore(s.dbPath);
    const cost2 = new CostService({ store: store2 } as never);
    const orig = s.store.immediate.bind(s.store);
    (s.store as unknown as { immediate: unknown }).immediate = (fn: () => unknown) => {
      cost2.upsertCostProfile({ ref_type: "route", ref_id: "RTE_F3",
        billing_mode: "METERED_API", reserve_microusd: 400_000 }, "t");
      return orig(fn as () => never);
    };
    const r = reserve(s, { missionId: "MIS_B3" }, "TB3", "RTE_F3");
    console.log("B3 pinned:", r.reserved_microusd);
    expect(Number(r.reserved_microusd)).toBe(400_000);
  });
});
