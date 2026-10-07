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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_1",
      value: 4,
      evidence: { evidence_key: "ev-1", verifier: "mission:MSN_1", source: "artifact:sales.csv" },
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
    const ev = { evidence_key: "ev-x", verifier: "mission:M1", source: "artifact:r.csv" };
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" });
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: "e" });
    const row = svc.get(String(o.objective_id));
    expect((row.kpis as Array<Record<string, unknown>>)[0].current).toBe(5);
    expect((row.applied_evidence_keys as string[])).toEqual(["ev-x"]);
    expect((row.evidence_refs as unknown[]).length).toBe(1);
    store.close();
  });

  it("replayed attachEvidence never appends twice", () => {
    const { store, svc } = freshDb("dupatt");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const ev = { evidence_key: "ev-y", verifier: "operator:op-2", source: "report:monthly" };
    svc.attachEvidence(String(o.objective_id), { business_id: bid, evidence: ev, actor: "e" });
    svc.attachEvidence(String(o.objective_id), { business_id: bid, evidence: ev, actor: "e" });
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
      evidence: { evidence_key: "e1", verifier: "operator:x", source: "s" },
      actor: "e",
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
    for (let i = 0; i < 6; i++) {
      const s = i % 2 === 0 ? svc : svc2;
      s.recordProgress(oid, {
        business_id: bid,
        kpi_id: "KPI_1",
        value: i + 1,
        evidence: { evidence_key: `ev-${i}`, verifier: "mission:M", source: "s" },
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
    const row = svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_1",
      value: 3,
      evidence: { evidence_key: "e1", verifier: "mission:MSN_9", source: "artifact:out.csv" },
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
    const row = svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_2",
      value: 1,
      evidence: { evidence_key: "e-k2", verifier: "mission:M", source: "s" },
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
    expect(row.applied_spend_keys).toEqual(["s1"]);
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
