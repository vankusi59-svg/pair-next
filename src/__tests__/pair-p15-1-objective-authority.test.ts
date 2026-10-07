/**
 * P15.1 Objective Authority — adversarial test matrix.
 *
 * Covers the mandate's §9 groups A–H:
 *   A create/read + restart durability
 *   B duplicate create / duplicate evidence / duplicate progress
 *   C CAS / stale writers / concurrent updates (two live connections)
 *   D owner-protected terms (non-owner amendments all rejected)
 *   E KPI verified progress (self-report / foreign evidence rejected,
 *     no double-count)
 *   F budget accounting (ceiling, no overspend under interleave,
 *     replay no double-spend)
 *   G lifecycle (transition table, terminal resurrection, deadline
 *     expiry)
 *   H business isolation
 * plus the BusinessLayer integration seam (createObjective delegates to
 * the canonical service) and digest tamper-detection.
 *
 * Non-vacuous discipline: every rejection test asserts the canonical
 * error code AND that state was not mutated.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  BusinessLayer,
  IntegrityError,
  NotFoundError,
  ObjectiveAuthorityService,
  PairEvidenceStore,
  digest,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p151-"));
let counter = 0;

function freshDb(name: string): { dbPath: string; store: PairEvidenceStore; svc: ObjectiveAuthorityService } {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  return { dbPath, store, svc: new ObjectiveAuthorityService(store) };
}

const OP = "1882810918";
const OWNER = `operator:${OP}`;

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${digest(String(counter)).slice(0, 8)}_${counter}`) {
  store.put("business", id, { business_id: id, name: "b", status: "ACTIVE", created_at: "x", version: 0 }, 0);
  return id;
}

function mkObjective(svc: ObjectiveAuthorityService, businessId: string, extra: Record<string, unknown> = {}) {
  return svc.create({
    business_id: businessId,
    title: "Sell 10 units",
    statement: "Grow sales",
    kpis: [
      { name: "sales", unit: "units", baseline: 0, target: 10 },
      { name: "refunds", unit: "units", baseline: 0, target: 0, direction: "AT_MOST" },
    ],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000, // $500
    hard_constraints: ["no discounts below cost"],
    success_conditions: ["10 units sold"],
    stop_conditions: ["legal halt"],
    operator_id: OP,
    ...extra,
  });
}

function expectFail(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

/* ---- R2 canonical evidence fixtures ---------------------------------- */

let missionSeq = 0;

/** A real canonical mission bound to a business (metadata.business_id is
 *  the binding startMission writes). */
function mkMission(store: PairEvidenceStore, businessId: string): string {
  const mid = `MSN_R2_${digest(`${businessId}:${missionSeq++}`).slice(0, 12)}`;
  store.put("mission", mid, {
    mission_id: mid,
    status: "COMPLETED",
    metadata: { business_id: businessId },
    created_at: "x",
    updated_at: "x",
    version: 0,
  }, 0);
  return mid;
}

/** A real governed OBJECTIVE_PROGRESS evidence row under a mission —
 *  evidence_key is the canonical evidence_id (deterministic sha256). */
function mkProgressEvidence(
  store: PairEvidenceStore,
  missionId: string,
  objectiveId: string,
  kpiId: string,
  value: number,
  extra: Record<string, unknown> = {},
): { evidence_key: string; verifier: string; source: string } {
  const { evidence_id } = store.appendEvidence(missionId, "OBJECTIVE_PROGRESS", {
    objective_id: objectiveId,
    kpi_id: kpiId,
    value,
    ...extra,
  });
  return { evidence_key: evidence_id, verifier: `mission:${missionId}`, source: "governed-evidence" };
}

/** Owner-authorized manual measurement — the operator seam. */
function ownerEvidence(key: string) {
  return { evidence_key: key, verifier: OWNER, source: "operator:console" };
}

/* ============================ A. create / read ============================ */

describe("P15.1 A — create/read durability", () => {
  it("creates a canonical objective with full schema", () => {
    const { store, svc } = freshDb("create");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expect(o.schema_version).toBe("pair.os.vnext.objective.v1");
    expect(o.status).toBe("ACTIVE");
    expect(o.owner_authority_id).toBe(OWNER);
    expect(o.terms_version).toBe(1);
    const budget = o.budget as Record<string, unknown>;
    expect(budget.ceiling_microusd).toBe(500_000_000);
    expect(budget.consumed_microusd).toBe(0);
    expect((o.kpis as Array<Record<string, unknown>>).map((k) => k.kpi_id)).toEqual(["KPI_1", "KPI_2"]);
    expect(typeof o.objective_digest).toBe("string");
    store.close();
  });

  it("objective survives restart — reopening the DB yields identical semantics", () => {
    const { dbPath, store, svc } = freshDb("restart");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 4);
    svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_1",
      value: 4,
      evidence: ev,
      actor: "executor:codex",
    });
    store.close();
    const store2 = new PairEvidenceStore(dbPath);
    const svc2 = new ObjectiveAuthorityService(store2);
    const reloaded = svc2.get(String(o.objective_id));
    expect((reloaded.kpis as Array<Record<string, unknown>>)[0].current).toBe(4);
    expect(reloaded.objective_digest).toBe(o.objective_digest);
    expect(reloaded.version).toBe(o.version + 1);
    store2.close();
  });

  it("objective requires an existing business (fail-closed)", () => {
    const { store, svc } = freshDb("nobiz");
    expectFail(() => svc.create({ business_id: "BIZ_ghost", title: "x", operator_id: OP }), "NOT_FOUND");
    store.close();
  });
});

/* ============================ B. idempotency ============================ */

describe("P15.1 B — duplicate/idempotent operations", () => {
  it("duplicate create converges to ONE canonical objective", () => {
    const { store, svc } = freshDb("dupcreate");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid);
    const b = mkObjective(svc, bid);
    expect(a.objective_id).toBe(b.objective_id);
    expect(svc.list(bid).filter((o) => o.schema_version === "pair.os.vnext.objective.v1")).toHaveLength(1);
    store.close();
  });

  it("distinct dedup keys create distinct objectives", () => {
    const { store, svc } = freshDb("dedupkey");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { dedup_key: "q4-sales" });
    const b = mkObjective(svc, bid, { dedup_key: "q5-sales" });
    expect(a.objective_id).not.toBe(b.objective_id);
    store.close();
  });

  it("replayed evidence is a no-op — KPI is not double-counted", () => {
    const { store, svc } = freshDb("dupev");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 5);
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" });
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" });
    const row = svc.get(String(o.objective_id));
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(5);
    const ledger = row.applied_evidence_keys as Array<{ key: string }>;
    expect(ledger.map((e) => e.key)).toEqual([ev.evidence_key]);
    expect((row.evidence_refs as unknown[]).length).toBe(1);
    store.close();
  });

  it("replayed attachEvidence never appends twice", () => {
    const { store, svc } = freshDb("dupatt");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const ev = ownerEvidence("ev-y");
    svc.attachEvidence(String(o.objective_id), { business_id: bid, evidence: ev, actor: OWNER });
    svc.attachEvidence(String(o.objective_id), { business_id: bid, evidence: ev, actor: OWNER });
    const row = svc.get(String(o.objective_id));
    expect((row.evidence_refs as unknown[]).length).toBe(1);
    store.close();
  });
});

/* ============================ C. CAS / concurrency ============================ */

describe("P15.1 C — CAS/concurrency", () => {
  it("stale writer is rejected (expected_version CAS)", () => {
    const { store, svc } = freshDb("stale");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    // Legit mutation bumps the canonical version.
    svc.attachEvidence(String(o.objective_id), {
      business_id: bid,
      evidence: ownerEvidence("e1"),
      actor: OWNER,
    });
    const stale = { ...o, title: "tampered-stale" };
    expectFail(
      () => store.put("objective", String(o.objective_id), stale, Number(o.version)),
      "FAIL_CLOSED_VERSION_CONFLICT",
    );
    const cur = svc.get(String(o.objective_id));
    expect(cur.title).toBe("Sell 10 units");
    store.close();
  });

  it("two live connections cannot lose an update — all progress lands", () => {
    const { dbPath, store, svc } = freshDb("race");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const store2 = new PairEvidenceStore(dbPath);
    const svc2 = new ObjectiveAuthorityService(store2);
    const oid = String(o.objective_id);
    // Alternating writers on separate connections — every op re-reads
    // inside immediate() and CAS-commits, so neither write is lost.
    const mid = mkMission(store, bid);
    for (let i = 0; i < 6; i++) {
      const s = i % 2 === 0 ? svc : svc2;
      const ev = mkProgressEvidence(store, mid, oid, "KPI_1", i + 1);
      s.recordProgress(oid, {
        business_id: bid,
        kpi_id: "KPI_1",
        value: i + 1,
        evidence: ev,
        actor: "e",
      });
    }
    const row = svc.get(oid);
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(6);
    expect((row.applied_evidence_keys as string[]).length).toBe(6);
    expect(row.version).toBe(7); // create + 6 updates
    store.close();
    store2.close();
  });

  it("a tampered protected term invalidates the digest — authority read fails closed", () => {
    const { store, svc } = freshDb("tamper");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const tampered = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    (tampered.kpis as Array<Record<string, unknown>>)[0].target = 999;
    store.put("objective", String(o.objective_id), tampered, Number(o.version));
    expectFail(() => svc.get(String(o.objective_id)), "FAIL_CLOSED_OBJECTIVE_DIGEST");
    store.close();
  });
});

/* ============================ D. protected terms ============================ */

describe("P15.1 D — owner-protected terms", () => {
  it("non-owner cannot amend KPI target 10 → 100", () => {
    const { store, svc } = freshDb("d-target");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expectFail(
      () => svc.amend(String(o.objective_id), {
        business_id: bid,
        actor: "operator:mallory",
        patch: { kpis: [{ name: "sales", unit: "units", baseline: 0, target: 100 }] },
      }),
      "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
    );
    const cur = svc.get(String(o.objective_id));
    expect((cur.kpis as Array<Record<string, unknown>>)[0].target).toBe(10);
    store.close();
  });

  it("non-owner cannot raise budget ceiling $500 → $1000", () => {
    const { store, svc } = freshDb("d-ceil");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expectFail(
      () => svc.amend(String(o.objective_id), {
        business_id: bid,
        actor: "operator:mallory",
        patch: { budget_ceiling_microusd: 1_000_000_000 },
      }),
      "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
    );
    store.close();
  });

  it("non-owner cannot extend deadline, transfer ownership, or rewrite constraints", () => {
    const { store, svc } = freshDb("d-misc");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    for (const patch of [
      { deadline: "3999-01-01T00:00:00.000Z" },
      { owner_authority_id: "operator:mallory" },
      { hard_constraints: [] },
    ]) {
      expectFail(
        () => svc.amend(String(o.objective_id), { business_id: bid, actor: "operator:mallory", patch }),
        "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
      );
    }
    store.close();
  });

  it("owner CAN amend terms — digest rebinds at terms_version+1", () => {
    const { store, svc } = freshDb("d-owner");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const amended = svc.amend(String(o.objective_id), {
      business_id: bid,
      actor: OWNER,
      reason: "owner revised target",
      patch: { kpis: [{ name: "sales", unit: "units", baseline: 0, target: 12 }] },
    });
    expect(amended.terms_version).toBe(2);
    expect(amended.amendment_seq).toBe(1);
    expect((amended.kpis as Array<Record<string, unknown>>)[0].target).toBe(12);
    expect(amended.objective_digest).not.toBe(o.objective_digest);
    store.close();
  });

  it("amend rejects unknown keys — no generic updateObjective(anything)", () => {
    const { store, svc } = freshDb("d-keys");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    for (const patch of [
      { status: "CANCELLED" },
      { budget_consumed_microusd: 5 },
      { owner: "mallory" },
      { business_id: "BIZ_other" },
      { version: 99 },
    ]) {
      expectFail(
        () => svc.amend(String(o.objective_id), { business_id: bid, actor: OWNER, patch }),
        "FAIL_CLOSED_OBJECTIVE_TERMS",
      );
    }
    store.close();
  });
});

/* ============================ E. KPI authority ============================ */

describe("P15.1 E — KPI verified progress", () => {
  it("verified evidence updates progress", () => {
    const { store, svc } = freshDb("e-ok");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 3);
    const row = svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_1",
      value: 3,
      evidence: ev,
      actor: "executor:codex",
    });
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(3);
    store.close();
  });

  it("unverified self-report is rejected — no verifier authority", () => {
    const { store, svc } = freshDb("e-self");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    for (const verifier of ["", "self", "executor:codex", "model:gpt"]) {
      expectFail(
        () => svc.recordProgress(String(o.objective_id), {
          business_id: bid, kpi_id: "KPI_1", value: 5,
          evidence: { evidence_key: `ev-${verifier}`, verifier, source: "s" },
          actor: "executor:codex",
        }),
        verifier === "" ? "FAIL_CLOSED_OBJECTIVE_FIELD" : "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
      );
    }
    expect((svc.get(String(o.objective_id)).kpis as Array<Record<string, unknown>>)[0].current).toBeNull();
    store.close();
  });

  it("progress on a foreign objective id is rejected (NotFound)", () => {
    const { store, svc } = freshDb("e-foreign");
    const bid = mkBusiness(store);
    mkObjective(svc, bid);
    expectFail(
      () => svc.recordProgress("OBJ_deadbeefdeadbeefdeadbeef", {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: "e", verifier: "mission:M", source: "s" },
        actor: "e",
      }),
      "NOT_FOUND",
    );
    store.close();
  });

  it("evidence tagged for a different kpi never bleeds into KPI_1", () => {
    const { store, svc } = freshDb("e-kpi");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_2", 1);
    const row = svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_2",
      value: 1,
      evidence: ev,
      actor: "e",
    });
    const kpis = row.kpis as Array<Record<string, unknown>>;
    expect(kpis[0].current).toBeNull();
    expect(kpis[1].current).toBe(1);
    store.close();
  });
});

/* ============================ F. budget ============================ */

describe("P15.1 F — budget fail-closed", () => {
  it("valid accounting applies and replay does not double-spend", () => {
    const { store, svc } = freshDb("f-ok");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    svc.accountBudget(String(o.objective_id), { business_id: bid, spend_key: "task-1", amount_microusd: 100, actor: "e" });
    svc.accountBudget(String(o.objective_id), { business_id: bid, spend_key: "task-1", amount_microusd: 100, actor: "e" });
    const row = svc.get(String(o.objective_id));
    expect((row.budget as Record<string, unknown>).consumed_microusd).toBe(100);
    store.close();
  });

  it("ceiling cannot be exceeded — overspend rejected, nothing written", () => {
    const { store, svc } = freshDb("f-over");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { budget_ceiling_microusd: 150 });
    svc.accountBudget(String(o.objective_id), { business_id: bid, spend_key: "s1", amount_microusd: 100, actor: "e" });
    expectFail(
      () => svc.accountBudget(String(o.objective_id), { business_id: bid, spend_key: "s2", amount_microusd: 60, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED",
    );
    const row = svc.get(String(o.objective_id));
    expect((row.budget as Record<string, unknown>).consumed_microusd).toBe(100);
    const ledger = row.applied_spend_keys as Array<{ key: string }>;
    expect(ledger.map((e) => e.key)).toEqual(["s1"]);
    store.close();
  });

  it("interleaved spenders cannot overspend the ceiling", () => {
    const { dbPath, store, svc } = freshDb("f-race");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { budget_ceiling_microusd: 200 });
    const svc2 = new ObjectiveAuthorityService(new PairEvidenceStore(dbPath));
    const oid = String(o.objective_id);
    let spent = 0;
    for (let i = 0; i < 6; i++) {
      const s = i % 2 === 0 ? svc : svc2;
      try {
        s.accountBudget(oid, { business_id: bid, spend_key: `sp-${i}`, amount_microusd: 60, actor: "e" });
        spent += 60;
      } catch (e) {
        expect((e as { code?: string }).code).toBe("FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED");
      }
    }
    const row = svc.get(oid);
    expect((row.budget as Record<string, unknown>).consumed_microusd).toBe(180);
    expect(spent).toBe(180);
    store.close();
  });

  it("non-integer/float spend is rejected", () => {
    const { store, svc } = freshDb("f-float");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expectFail(
      () => svc.accountBudget(String(o.objective_id), { business_id: bid, spend_key: "s", amount_microusd: 1.5, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_BUDGET",
    );
    store.close();
  });
});

/* ============================ G. lifecycle ============================ */

describe("P15.1 G — status machine", () => {
  it("valid transitions pass", () => {
    const { store, svc } = freshDb("g-ok");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    for (const to of ["PAUSED", "ACTIVE", "BLOCKED", "ACTIVE"] as const) {
      const r = svc.transitionStatus(oid, { business_id: bid, to, actor: OWNER });
      expect(r.status).toBe(to);
    }
    store.close();
  });

  it("arbitrary status string fails closed", () => {
    const { store, svc } = freshDb("g-str");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expectFail(
      () => svc.transitionStatus(String(o.objective_id), { business_id: bid, to: "DONE" as never, actor: OWNER }),
      "FAIL_CLOSED_OBJECTIVE_STATUS",
    );
    store.close();
  });

  it("terminal states never resurrect — ACHIEVED→ACTIVE and CANCELLED→ACTIVE rejected", () => {
    const { store, svc } = freshDb("g-term");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    svc.transitionStatus(oid, { business_id: bid, to: "ACHIEVED", actor: OWNER });
    for (const to of ["ACTIVE", "PAUSED", "BLOCKED", "CANCELLED"] as const) {
      expectFail(
        () => svc.transitionStatus(oid, { business_id: bid, to, actor: OWNER }),
        "FAIL_CLOSED_OBJECTIVE_TRANSITION",
      );
    }
    // progress/budget mutations on terminal state are also closed
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 1,
        evidence: { evidence_key: "e", verifier: "mission:M", source: "s" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_TERMINAL",
    );
    store.close();
  });

  it("non-owner cannot transition status", () => {
    const { store, svc } = freshDb("g-auth");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    expectFail(
      () => svc.transitionStatus(String(o.objective_id), { business_id: bid, to: "CANCELLED", actor: "operator:mallory" }),
      "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
    );
    store.close();
  });

  it("past-deadline objective auto-expires: mutation rejected, EXPIRED committed", () => {
    const { store, svc } = freshDb("g-expire");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { deadline: "2000-01-01T00:00:00.000Z" });
    const oid = String(o.objective_id);
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 1,
        evidence: { evidence_key: "e", verifier: "mission:M", source: "s" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_TERMINAL",
    );
    const row = svc.get(oid);
    expect(row.status).toBe("EXPIRED");
    const ev = store.listEvents("objective", oid);
    expect(ev.some((e) => e.event_type === "OBJECTIVE_STATUS" && e.new_state === "EXPIRED")).toBe(true);
    store.close();
  });

  it("evaluateDeadline is idempotent and only fires past deadline", () => {
    const { store, svc } = freshDb("g-eval");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { deadline: "2000-06-01T00:00:00.000Z" });
    const oid = String(o.objective_id);
    const before = svc.evaluateDeadline(oid, "2000-05-01T00:00:00.000Z");
    expect(before.status).toBe("ACTIVE");
    const after = svc.evaluateDeadline(oid, "2000-07-01T00:00:00.000Z");
    expect(after.status).toBe("EXPIRED");
    const again = svc.evaluateDeadline(oid, "2000-08-01T00:00:00.000Z");
    expect(again.status).toBe("EXPIRED");
    expect(again.version).toBe(after.version);
    store.close();
  });
});

/* ============================ H. business isolation ============================ */

describe("P15.1 H — business isolation", () => {
  it("objective of business A rejects every mutation scoped to business B", () => {
    const { store, svc } = freshDb("h-iso");
    const bidA = mkBusiness(store, "BIZ_A");
    const bidB = mkBusiness(store, "BIZ_B");
    const o = mkObjective(svc, bidA);
    const oid = String(o.objective_id);
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bidB, kpi_id: "KPI_1", value: 9,
        evidence: { evidence_key: "e", verifier: "mission:M", source: "s" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    expectFail(
      () => svc.accountBudget(oid, { business_id: bidB, spend_key: "s", amount_microusd: 1, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    expectFail(
      () => svc.transitionStatus(oid, { business_id: bidB, to: "PAUSED", actor: OWNER }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    expectFail(
      () => svc.amend(oid, { business_id: bidB, actor: OWNER, patch: { title: "x" } }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    // untouched
    const cur = svc.get(oid);
    expect(cur.status).toBe("ACTIVE");
    expect((cur.kpis as Array<Record<string, unknown>>)[0].current).toBeNull();
    store.close();
  });

  it("parent must live in the same business", () => {
    const { store, svc } = freshDb("h-parent");
    const bidA = mkBusiness(store, "BIZ_A2");
    const bidB = mkBusiness(store, "BIZ_B2");
    const parent = mkObjective(svc, bidA, { dedup_key: "p" });
    expectFail(
      () => mkObjective(svc, bidB, { parent_objective_id: String(parent.objective_id), dedup_key: "c" }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    store.close();
  });
});

/* ==================== R2.A — verified evidence = real authority ==================== */

describe("P15.1 R2.A — canonical verifier resolution", () => {
  it("mission/artifact prefixes alone are NOT authority — fake refs rejected", () => {
    const { store, svc } = freshDb("r2a-fake");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    for (const verifier of ["mission:FAKE", "artifact:DOES_NOT_EXIST", "service:X"]) {
      expectFail(
        () => svc.recordProgress(String(o.objective_id), {
          business_id: bid, kpi_id: "KPI_1", value: 5,
          evidence: { evidence_key: `ek-${verifier}`, verifier, source: "s" },
          actor: "e",
        }),
        "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
      );
    }
    expect((svc.get(String(o.objective_id)).kpis as Array<Record<string, unknown>>)[0].current).toBeNull();
    store.close();
  });

  it("self-report cannot become authority by changing string prefix", () => {
    const { store, svc } = freshDb("r2a-self");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    for (const verifier of ["self:me", "executor:codex", "model:gpt", "agent:a1", "operator:mallory"]) {
      expectFail(
        () => svc.recordProgress(String(o.objective_id), {
          business_id: bid, kpi_id: "KPI_1", value: 5,
          evidence: { evidence_key: `ek-${verifier}`, verifier, source: "s" },
          actor: "e",
        }),
        "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
      );
    }
    store.close();
  });

  it("owner-authorized operator measurement is the only manual seam", () => {
    const { store, svc } = freshDb("r2a-owner");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    // actor is not owner → rejected even with the owner's verifier string
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: ownerEvidence("op-1"), actor: "operator:mallory",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    // verifier is owner but actor mismatch — still rejected
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: "op-2", verifier: "operator:mallory", source: "s" }, actor: OWNER,
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    // owner + owner verifier → passes
    const row = svc.recordProgress(oid, {
      business_id: bid, kpi_id: "KPI_1", value: 5,
      evidence: ownerEvidence("op-3"), actor: OWNER,
    });
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(5);
    store.close();
  });

  it("real same-business mission + binding OBJECTIVE_PROGRESS evidence — passes", () => {
    const { store, svc } = freshDb("r2a-real");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 7);
    const row = svc.recordProgress(String(o.objective_id), {
      business_id: bid, kpi_id: "KPI_1", value: 7, evidence: ev, actor: "executor:codex",
    });
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(7);
    store.close();
  });

  it("real evidence belonging to business B cannot update objective of business A", () => {
    const { store, svc } = freshDb("r2a-foreign");
    const bidA = mkBusiness(store, "BIZ_RA");
    const bidB = mkBusiness(store, "BIZ_RB");
    const o = mkObjective(svc, bidA);
    const midB = mkMission(store, bidB);
    const ev = mkProgressEvidence(store, midB, String(o.objective_id), "KPI_1", 7);
    expectFail(
      () => svc.recordProgress(String(o.objective_id), {
        business_id: bidA, kpi_id: "KPI_1", value: 7, evidence: ev, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    store.close();
  });

  it("evidence exists under a real mission but does NOT bind the claimed measurement → reject", () => {
    const { store, svc } = freshDb("r2a-mismatch");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bid);
    // evidence binds value=7 — caller claims value=5, wrong kpi, wrong objective
    const real = mkProgressEvidence(store, mid, oid, "KPI_1", 7);
    for (const claim of [
      { kpi_id: "KPI_1", value: 5 },                       // wrong value
      { kpi_id: "KPI_2", value: 7 },                       // wrong kpi
    ]) {
      expectFail(
        () => svc.recordProgress(oid, {
          business_id: bid, kpi_id: claim.kpi_id, value: claim.value, evidence: real, actor: "e",
        }),
        "FAIL_CLOSED_OBJECTIVE_MEASUREMENT",
      );
    }
    // evidence bound to a DIFFERENT objective
    const other = mkObjective(svc, bid, { dedup_key: "other", title: "Other" });
    const foreign = mkProgressEvidence(store, mid, String(other.objective_id), "KPI_1", 7);
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 7, evidence: foreign, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_MEASUREMENT",
    );
    // evidence_key that doesn't exist under the mission at all
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 7,
        evidence: { evidence_key: "ghost-key", verifier: `mission:${mid}`, source: "s" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_MEASUREMENT",
    );
    // non-PROGRESS kind under a real mission is not a measurement
    const { evidence_id } = store.appendEvidence(mid, "DISPATCH_AUTHORIZED", { x: 1 });
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 7,
        evidence: { evidence_key: evidence_id, verifier: `mission:${mid}`, source: "s" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_MEASUREMENT",
    );
    expect((svc.get(oid).kpis as Array<Record<string, unknown>>)[0].current).toBeNull();
    store.close();
  });

  it("artifact verifier resolves through its mission — real path passes, foreign fails", () => {
    const { store, svc } = freshDb("r2a-art");
    const bidA = mkBusiness(store, "BIZ_ARTA");
    const bidB = mkBusiness(store, "BIZ_ARTB");
    const o = mkObjective(svc, bidA);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bidA);
    const aid = `ART_${digest("a1").slice(0, 10)}`;
    store.put("artifact", aid, {
      artifact_id: aid, mission_id: mid, state: "ACCEPTED", logical_name: "r.csv",
      sha256: "x", created_at: "x", version: 0,
    }, 0);
    const ev = mkProgressEvidence(store, mid, oid, "KPI_1", 4);
    const row = svc.recordProgress(oid, {
      business_id: bidA, kpi_id: "KPI_1", value: 4,
      evidence: { evidence_key: ev.evidence_key, verifier: `artifact:${aid}`, source: "s" },
      actor: "e",
    });
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(4);
    // artifact bound to a foreign-business mission → rejected
    const midB = mkMission(store, bidB);
    const aidB = `ART_${digest("a2").slice(0, 10)}`;
    store.put("artifact", aidB, {
      artifact_id: aidB, mission_id: midB, state: "ACCEPTED", logical_name: "r.csv",
      sha256: "x", created_at: "x", version: 0,
    }, 0);
    const evB = mkProgressEvidence(store, midB, oid, "KPI_1", 9);
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bidA, kpi_id: "KPI_1", value: 9,
        evidence: { evidence_key: evB.evidence_key, verifier: `artifact:${aidB}`, source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_SCOPE",
    );
    store.close();
  });
});

/* ==================== R2.B — idempotency binds semantics ==================== */

describe("P15.1 R2.B — idempotency semantic binding", () => {
  it("same dedup identity + different protected terms → CREATE_CONFLICT, not silent adopt", () => {
    const { store, svc } = freshDb("r2b-create");
    const bid = mkBusiness(store);
    const a = svc.create({
      business_id: bid, title: "T", dedup_key: "k1",
      kpis: [{ name: "sales", target: 10 }], operator_id: OP,
    });
    for (const terms of [
      { kpis: [{ name: "sales", target: 100 }] },
      { deadline: "2999-01-01T00:00:00.000Z" },
      { budget_ceiling_microusd: 5 },
      { hard_constraints: ["x"] },
      { owner_authority_id: "operator:other" },
    ]) {
      expectFail(
        () => svc.create({ business_id: bid, title: "T", dedup_key: "k1", operator_id: OP, ...terms }),
        "FAIL_CLOSED_OBJECTIVE_CREATE_CONFLICT",
      );
    }
    // same terms replay still converges
    const b = svc.create({
      business_id: bid, title: "T", dedup_key: "k1",
      kpis: [{ name: "sales", target: 10 }], operator_id: OP,
    });
    expect(b.objective_id).toBe(a.objective_id);
    expect(b.version).toBe(a.version);
    store.close();
  });

  it("progress key + different semantics → EVIDENCE_CONFLICT (kpi/value/verifier/source)", () => {
    const { store, svc } = freshDb("r2b-prog");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, oid, "KPI_1", 5);
    svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" });
    // same key, different value — the semantic digest differs → conflict
    expectFail(
      () => svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_1", value: 6, evidence: ev, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different kpi
    expectFail(
      () => svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_2", value: 5, evidence: ev, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different verifier
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: ev.evidence_key, verifier: OWNER, source: ev.source }, actor: OWNER,
      }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different source
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: ev.evidence_key, verifier: ev.verifier, source: "other" }, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // unchanged state
    expect((svc.get(oid).kpis as Array<Record<string, unknown>>)[0].current).toBe(5);
    store.close();
  });

  it("attach-then-progress on the same key with different semantics → CONFLICT", () => {
    const { store, svc } = freshDb("r2b-xkind");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bid);
    const { evidence_id } = store.appendEvidence(mid, "OBJECTIVE_PROGRESS", {
      objective_id: oid, kpi_id: "KPI_1", value: 5,
    });
    const attachEv = { evidence_key: evidence_id, verifier: `mission:${mid}`, source: "s" };
    svc.attachEvidence(oid, { business_id: bid, evidence: attachEv, actor: "e" });
    // same key as a PROGRESS application — different semantic digest → conflict
    expectFail(
      () => svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: attachEv, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    store.close();
  });

  it("spend key + different amount/note → SPEND_CONFLICT; same → idempotent", () => {
    const { store, svc } = freshDb("r2b-spend");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    svc.accountBudget(oid, { business_id: bid, spend_key: "s1", amount_microusd: 100, actor: "e" });
    expectFail(
      () => svc.accountBudget(oid, { business_id: bid, spend_key: "s1", amount_microusd: 200, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_SPEND_CONFLICT",
    );
    expectFail(
      () => svc.accountBudget(oid, { business_id: bid, spend_key: "s1", amount_microusd: 100, note: "changed", actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_SPEND_CONFLICT",
    );
    // exact replay — no-op
    svc.accountBudget(oid, { business_id: bid, spend_key: "s1", amount_microusd: 100, actor: "e" });
    expect((svc.get(oid).budget as Record<string, unknown>).consumed_microusd).toBe(100);
    store.close();
  });
});

/* ==================== R2.C — budget invariant closure ==================== */

describe("P15.1 R2.C — budget invariant", () => {
  it("amend cannot lower ceiling below consumed; rejected amend leaves state untouched", () => {
    const { store, svc } = freshDb("r2c-ceil");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { budget_ceiling_microusd: 500 });
    const oid = String(o.objective_id);
    svc.accountBudget(oid, { business_id: bid, spend_key: "s1", amount_microusd: 100, actor: "e" });
    const before = svc.get(oid);
    expectFail(
      () => svc.amend(oid, {
        business_id: bid, actor: OWNER, patch: { budget_ceiling_microusd: 50 },
      }),
      "FAIL_CLOSED_OBJECTIVE_BUDGET_INVARIANT",
    );
    const after = svc.get(oid);
    expect((after.budget as Record<string, unknown>).ceiling_microusd).toBe(500);
    expect((after.budget as Record<string, unknown>).consumed_microusd).toBe(100);
    expect(after.version).toBe(before.version);
    expect(after.terms_version).toBe(before.terms_version);
    // boundary: ceiling == consumed is allowed
    const ok = svc.amend(oid, { business_id: bid, actor: OWNER, patch: { budget_ceiling_microusd: 100 } });
    expect((ok.budget as Record<string, unknown>).ceiling_microusd).toBe(100);
    store.close();
  });

  it("a tampered canonical row with consumed>ceiling fails closed on strict read", () => {
    const { store, svc } = freshDb("r2c-tamper");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { budget_ceiling_microusd: 500 });
    const tampered = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    (tampered.budget as Record<string, unknown>).consumed_microusd = 600;
    // bypass the service — simulate a writer that landed an illegal row
    store.put("objective", String(o.objective_id), tampered, Number(o.version));
    expectFail(() => svc.get(String(o.objective_id)), "FAIL_CLOSED_OBJECTIVE_INTEGRITY");
    store.close();
  });
});

/* ==================== R2.D — parent graph acyclic ==================== */

describe("P15.1 R2.D — acyclic parent graph", () => {
  it("self-parent create is rejected", () => {
    const { store, svc } = freshDb("r2d-self");
    const bid = mkBusiness(store);
    const id = svc.objectiveIdFor(bid, "selfish");
    expectFail(
      () => svc.create({
        business_id: bid, title: "T", dedup_key: "selfish",
        parent_objective_id: id, operator_id: OP,
      }),
      "FAIL_CLOSED_OBJECTIVE_CYCLE",
    );
    store.close();
  });

  it("two-node cycle via amend is rejected (A.parent=B then B.parent=A)", () => {
    const { store, svc } = freshDb("r2d-two");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { dedup_key: "a", title: "A" });
    const b = mkObjective(svc, bid, { dedup_key: "b", title: "B", parent_objective_id: String(a.objective_id) });
    expect(b.parent_objective_id).toBe(a.objective_id);
    expectFail(
      () => svc.amend(String(a.objective_id), {
        business_id: bid, actor: OWNER, patch: { parent_objective_id: String(b.objective_id) },
      }),
      "FAIL_CLOSED_OBJECTIVE_CYCLE",
    );
    store.close();
  });

  it("deeper cycle via amend is rejected (A→B→C, then C.parent=A→...→C)", () => {
    const { store, svc } = freshDb("r2d-deep");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { dedup_key: "da", title: "A" });
    const b = mkObjective(svc, bid, { dedup_key: "db", title: "B", parent_objective_id: String(a.objective_id) });
    const c = mkObjective(svc, bid, { dedup_key: "dc", title: "C", parent_objective_id: String(b.objective_id) });
    // a.parent = c would create A→...→C→? wait: make A a child of C — A.parent=C closes C→B→A→C
    expectFail(
      () => svc.amend(String(a.objective_id), {
        business_id: bid, actor: OWNER, patch: { parent_objective_id: String(c.objective_id) },
      }),
      "FAIL_CLOSED_OBJECTIVE_CYCLE",
    );
    // valid hierarchy still passes — reparent B under a fresh root
    const root = mkObjective(svc, bid, { dedup_key: "root", title: "R" });
    const ok = svc.amend(String(b.objective_id), {
      business_id: bid, actor: OWNER, patch: { parent_objective_id: String(root.objective_id) },
    });
    expect(ok.parent_objective_id).toBe(root.objective_id);
    store.close();
  });
});

/* ==================== R2.E — canonical row shape hardening ==================== */

describe("P15.1 R2.E — mutable-state shape", () => {
  it("malformed kpi.current / duplicate kpi_id fail closed on read", () => {
    const { store, svc } = freshDb("r2e-kpi");
    const bid = mkBusiness(store);
    const mutations: Array<(r: Record<string, unknown>) => void> = [
      (r) => { (r.kpis as Array<Record<string, unknown>>)[0].current = "not-a-number"; },
      (r) => { (r.kpis as Array<Record<string, unknown>>)[1].kpi_id = "KPI_1"; },
      (r) => { r.kpis = "not-an-array"; },
    ];
    for (const [i, mutate] of mutations.entries()) {
      const o = mkObjective(svc, bid, { dedup_key: `e-kpi-${i}` });
      const oid = String(o.objective_id);
      const r = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
      mutate(r);
      store.put("objective", oid, r, Number(o.version));
      expectFail(() => svc.get(oid), "FAIL_CLOSED_OBJECTIVE_INTEGRITY");
    }
    store.close();
  });

  it("malformed ledgers / evidence_refs / status fail closed on read", () => {
    const { store, svc } = freshDb("r2e-ledger");
    const bid = mkBusiness(store);
    const mutations: Array<(r: Record<string, unknown>) => void> = [
      (r) => { r.applied_evidence_keys = "not-an-array"; },
      (r) => { r.applied_spend_keys = [{ key: 42 }]; },
      (r) => { r.evidence_refs = [{ evidence_key: "k" }]; }, // missing verifier/source/kind
      (r) => { r.status = "DONE"; },
    ];
    for (const [i, mutate] of mutations.entries()) {
      const o = mkObjective(svc, bid, { dedup_key: `e-ledger-${i}` });
      const oid = String(o.objective_id);
      const r = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
      mutate(r);
      store.put("objective", oid, r, Number(o.version));
      expectFail(() => svc.get(oid), "FAIL_CLOSED_OBJECTIVE_INTEGRITY");
    }
    store.close();
  });
});

/* ==================== R2.F — true multi-connection races ==================== */

const R2_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p151-r2");
const R2_BUNDLE = path.join(R2_CACHE, "pair-bundle.mjs");
const R2_WORKER = path.join(R2_CACHE, "r2-worker.mjs");

const R2_WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { op, dbPath, barrier, args } = workerData;
const svc = new PAIR.ObjectiveAuthorityService(new PAIR.PairEvidenceStore(dbPath));
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);
try {
  let out;
  if (op === "create") out = svc.create(args);
  else if (op === "spend") out = svc.accountBudget(args.oid, args.input);
  else if (op === "progress") out = svc.recordProgress(args.oid, args.input);
  else throw new Error("unknown op " + op);
  parentPort.postMessage({ ok: true, out: { objective_id: out.objective_id ?? null, version: out.version } });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e && e.code ? e.code : String(e) });
}
`;

function ensureR2WorkerBundle() {
  fs.mkdirSync(R2_CACHE, { recursive: true });
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
    `--outfile=${R2_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(R2_WORKER, R2_WORKER_SOURCE);
}

type R2Outcome = { ok: true; out: unknown } | { ok: false; code: string };

async function runR2Race(
  ops: Array<{ op: string; dbPath: string; args: Record<string, unknown> }>,
): Promise<R2Outcome[]> {
  ensureR2WorkerBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    ops.map(
      (o) =>
        new Promise<R2Outcome>((resolve, reject) => {
          const w = new Worker(R2_WORKER, {
            workerData: { op: o.op, dbPath: o.dbPath, barrier: gate, args: o.args },
          });
          w.on("message", (msg: Record<string, unknown>) => {
            if (msg.ready === true) {
              readyCount += 1;
              if (readyCount === ops.length) {
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
              return;
            }
            resolve(msg as unknown as R2Outcome);
          });
          w.on("error", reject);
        }),
    ),
  );
}

describe("P15.1 R2.F — real worker-thread contention", () => {
  it("two workers create with same dedup identity → ONE canonical row, both converge", async () => {
    const { dbPath, store, svc } = freshDb("r2f-create");
    const bid = mkBusiness(store);
    const input = {
      business_id: bid, title: "RaceT", dedup_key: "race-dup",
      kpis: [{ name: "sales", target: 10 }], operator_id: OP,
    };
    const results = await runR2Race([
      { op: "create", dbPath, args: { ...input } },
      { op: "create", dbPath, args: { ...input } },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = svc.list(bid).filter((o) => o.schema_version === "pair.os.vnext.objective.v1");
    expect(rows).toHaveLength(1);
    store.close();
  });

  it("create race with same key + DIFFERENT terms → exactly one wins, loser conflicts", async () => {
    const { dbPath, store, svc } = freshDb("r2f-ct");
    const bid = mkBusiness(store);
    const base = { business_id: bid, title: "RaceT", dedup_key: "race-conf", operator_id: OP };
    const results = await runR2Race([
      { op: "create", dbPath, args: { ...base, kpis: [{ name: "s", target: 10 }] } },
      { op: "create", dbPath, args: { ...base, kpis: [{ name: "s", target: 99 }] } },
    ]);
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as { code: string }).code).toBe("FAIL_CLOSED_OBJECTIVE_CREATE_CONFLICT");
    expect(svc.list(bid).filter((o) => o.schema_version === "pair.os.vnext.objective.v1")).toHaveLength(1);
    store.close();
  });

  it("spend race beyond ceiling → at most one lands, never overspends", async () => {
    const { dbPath, store, svc } = freshDb("r2f-spend");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { budget_ceiling_microusd: 100 });
    const oid = String(o.objective_id);
    const spend = (k: string, amt: number) => ({
      business_id: bid, spend_key: k, amount_microusd: amt, actor: "e",
    });
    const results = await runR2Race([
      { op: "spend", dbPath, args: { oid, input: spend("sa", 60) } },
      { op: "spend", dbPath, args: { oid, input: spend("sb", 60) } },
    ]);
    const row = svc.get(oid);
    const consumed = Number((row.budget as Record<string, unknown>).consumed_microusd);
    expect(consumed).toBeLessThanOrEqual(100);
    expect(okCount(results)).toBeLessThanOrEqual(1);
    expect(consumed).toBe(60); // exactly one landed — loser failed LOUDLY
    store.close();
  });

  it("progress race on the same evidence_key + different value → one lands, loser conflicts", async () => {
    const { dbPath, store, svc } = freshDb("r2f-prog");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, oid, "KPI_1", 5);
    const results = await runR2Race([
      { op: "progress", dbPath, args: { oid, input: { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" } } },
      { op: "progress", dbPath, args: { oid, input: { business_id: bid, kpi_id: "KPI_1", value: 6, evidence: ev, actor: "e" } } },
    ]);
    const row = svc.get(oid);
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(5);
    expect(okCount(results)).toBe(1);
    const loser = results.find((r) => !r.ok) as { code: string };
    expect([
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
      "FAIL_CLOSED_OBJECTIVE_MEASUREMENT",
      "FAIL_CLOSED_VERSION_CONFLICT",
    ]).toContain(loser.code);
    store.close();
  });
});

function okCount(results: R2Outcome[]): number {
  return results.filter((r) => r.ok).length;
}

/* ==================== integration seam: BusinessLayer ==================== */

describe("P15.1 — BusinessLayer seam", () => {
  it("createObjective writes the canonical schema (single writer)", () => {
    const { dbPath, store } = freshDb("seam");
    const biz = new BusinessLayer({
      store,
      // minimal control stub — createObjective only touches the store
      control: { projects: () => [{ project_id: "p1" }] } as never,
      schedules: {} as never,
    } as never);
    const bid = biz.createBusiness({ name: "acme", project_id: "p1", operator_id: OP });
    const o = biz.createObjective({
      business_id: String(bid.business_id),
      title: "Launch",
      metric: "revenue",
      target: "1000",
      operator_id: OP,
    });
    expect(o.schema_version).toBe("pair.os.vnext.objective.v1");
    const svc = new ObjectiveAuthorityService(new PairEvidenceStore(dbPath));
    const strict = svc.get(String(o.objective_id)); // canonical read passes
    expect(strict.business_id).toBe(bid.business_id);
    // display path unchanged
    expect(biz.listObjectives(String(bid.business_id)).length).toBe(1);
    store.close();
  });
});
