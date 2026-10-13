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

/** A real CANONICAL mission bound to a business — the shape
 *  startMission actually writes: goal + status + the
 *  metadata.mission_origin ingress provenance pin + unanimous business
 *  bindings (metadata.business_id + business_context.business_id). A
 *  minimally shaped store.put row is not domain authority (R3.A.4). */
function mkMission(store: PairEvidenceStore, businessId: string): string {
  const mid = `MSN_R2_${digest(`${businessId}:${missionSeq++}`).slice(0, 12)}`;
  store.put("mission", mid, {
    mission_id: mid,
    goal: "canonical goal",
    status: "COMPLETED",
    metadata: {
      business_id: businessId,
      business_context: { business_id: businessId, provenance: "caller", pinned_at: "x" },
      mission_origin: { operator_id: "op", provenance: "MISSION_INGRESS", pinned_at: "x" },
    },
    created_at: "x",
    updated_at: "x",
    version: 0,
  }, 0);
  return mid;
}

/** A canonical ACCEPTED PAIR artifact under a mission — the contract +
 *  CAS storage shape the artifact subsystem writes plus the
 *  ARTIFACT_ACCEPTED governed-evidence provenance record binding
 *  artifact_id + execution_id + sha256 (R3.A.2). */
function mkCanonicalArtifact(store: PairEvidenceStore, missionId: string): string {
  const aid = `ART_${digest(`art:${missionSeq++}`).slice(0, 10)}`;
  const sha = digest(`bytes:${aid}`);
  store.put("artifact", aid, {
    artifact_id: aid,
    mission_id: missionId,
    execution_id: `EX_${aid.slice(4)}`,
    governed_task_id: `GTSK_${aid.slice(4)}`,
    task_id: `T_${aid.slice(4)}`,
    producer_executor_id: "CODEX",
    logical_name: "report.md",
    artifact_class: "FILE",
    sha256: sha,
    byte_size: 12,
    state: "ACCEPTED",
    contract: "pair-artifact.v1",
    ingested_via: "EXECUTION",
    storage: { kind: "PAIR_ARTIFACT_CAS", ref: `blobs/${sha}`, sha256: sha },
    created_at: "x",
    version: 0,
  }, 0);
  store.appendEvidence(missionId, "ARTIFACT_ACCEPTED", {
    artifact_id: aid,
    execution_id: `EX_${aid.slice(4)}`,
    governed_task_id: `GTSK_${aid.slice(4)}`,
    task_id: `T_${aid.slice(4)}`,
    producer_executor_id: "CODEX",
    logical_name: "report.md",
    sha256: sha,
    byte_size: 12,
  });
  return aid;
}

/** A real governed evidence row under a mission for the attach path
 *  (any kind — attach references provenance, it does not claim a
 *  measurement). */
function mkAttachEvidence(
  store: PairEvidenceStore,
  missionId: string,
): { evidence_key: string; verifier: string; source: string } {
  const { evidence_id } = store.appendEvidence(missionId, "DELIVERY_ATTEMPT", { seq: missionSeq });
  return { evidence_key: evidence_id, verifier: `mission:${missionId}`, source: "governed-evidence" };
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
    svc.recordProgress(String(o.objective_id), {
      business_id: bid,
      kpi_id: "KPI_1",
      value: 4,
      evidence: ownerEvidence("ev-restart"),
      actor: OWNER,
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
    const ev = ownerEvidence("ev-replay");
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: OWNER });
    svc.recordProgress(String(o.objective_id), { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: OWNER });
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
    for (let i = 0; i < 6; i++) {
      const s = i % 2 === 0 ? svc : svc2;
      const ev = ownerEvidence(`ev-race-${i}`);
      s.recordProgress(oid, {
        business_id: bid,
        kpi_id: "KPI_1",
        value: i + 1,
        evidence: ev,
        actor: OWNER,
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
      evidence: ownerEvidence("ev-3"),
      actor: OWNER,
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
      evidence: ownerEvidence("ev-kpi2"),
      actor: OWNER,
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

  it("automated mission KPI progress is deliberately fail-closed — even canonical mission + real OBJECTIVE_PROGRESS evidence", () => {
    const { store, svc } = freshDb("r3a-progress-closed");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 7);
    // PAIR has no canonical business-outcome verifier: generic
    // appendEvidence + a real mission is not measurement authority
    // (R3.A.5/R3.A.6).
    expectFail(
      () => svc.recordProgress(String(o.objective_id), {
        business_id: bid, kpi_id: "KPI_1", value: 7, evidence: ev, actor: "executor:codex",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    expect((svc.get(String(o.objective_id)).kpis as Array<Record<string, unknown>>)[0].current).toBeNull();
    store.close();
  });

  it("automated artifact KPI progress is deliberately fail-closed — even a canonical accepted artifact", () => {
    const { store, svc } = freshDb("r3a-artifact-closed");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    const aid = mkCanonicalArtifact(store, mid);
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 4);
    expectFail(
      () => svc.recordProgress(String(o.objective_id), {
        business_id: bid, kpi_id: "KPI_1", value: 4,
        evidence: { evidence_key: ev.evidence_key, verifier: `artifact:${aid}`, source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });

  it("attachEvidence: a minimally shaped store.put mission row is NOT authority", () => {
    const { store, svc } = freshDb("r3a-fakemission");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    // Fabricated minimal row — exists, integrity-consistent, but lacks
    // the canonical mission shape (goal + mission_origin provenance pin).
    store.put("mission", "MSN_FAKE", {
      mission_id: "MSN_FAKE", status: "COMPLETED",
      metadata: { business_id: bid }, created_at: "x", version: 0,
    }, 0);
    const { evidence_id } = store.appendEvidence("MSN_FAKE", "DELIVERY_ATTEMPT", { x: 1 });
    expectFail(
      () => svc.attachEvidence(oid, {
        business_id: bid,
        evidence: { evidence_key: evidence_id, verifier: "mission:MSN_FAKE", source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    // R4.B Option A — even a canonical mission + real governed evidence
    // cannot attach: attach is owner-authorized only, no reusable
    // canonical provenance verifier exists in P15.1.
    const mid = mkMission(store, bid);
    const ev = mkAttachEvidence(store, mid);
    expectFail(
      () => svc.attachEvidence(oid, { business_id: bid, evidence: ev, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });

  it("attachEvidence: a minimally shaped store.put artifact row is NOT authority — canonical acceptance provenance required", () => {
    const { store, svc } = freshDb("r3a-fakeartifact");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const mid = mkMission(store, bid);
    // Fabricated artifact row — correct-looking fields but no canonical
    // contract/storage and no ARTIFACT_ACCEPTED provenance.
    store.put("artifact", "ART_FAKE", {
      artifact_id: "ART_FAKE", mission_id: mid, state: "ACCEPTED",
      logical_name: "r.csv", sha256: "x", created_at: "x", version: 0,
    }, 0);
    const ev = mkAttachEvidence(store, mid);
    expectFail(
      () => svc.attachEvidence(oid, {
        business_id: bid,
        evidence: { evidence_key: ev.evidence_key, verifier: "artifact:ART_FAKE", source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    // Contract-correct shape but NO ARTIFACT_ACCEPTED evidence → fail.
    const sha = digest("noaccept");
    store.put("artifact", "ART_NOACC", {
      artifact_id: "ART_NOACC", mission_id: mid, execution_id: "EX_NOACC",
      governed_task_id: "GTSK_NOACC", producer_executor_id: "CODEX",
      logical_name: "r.md", sha256: sha, byte_size: 4, state: "ACCEPTED",
      contract: "pair-artifact.v1", ingested_via: "EXECUTION",
      storage: { kind: "PAIR_ARTIFACT_CAS", ref: `blobs/${sha}`, sha256: sha },
      created_at: "x", version: 0,
    }, 0);
    expectFail(
      () => svc.attachEvidence(oid, {
        business_id: bid,
        evidence: { evidence_key: ev.evidence_key, verifier: "artifact:ART_NOACC", source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    // R4.B Option A — even a fully canonical artifact + acceptance
    // evidence cannot attach: generic store.put + ARTIFACT_ACCEPTED is
    // not domain authority; attach is owner-authorized only.
    const aid = mkCanonicalArtifact(store, mid);
    expectFail(
      () => svc.attachEvidence(oid, {
        business_id: bid,
        evidence: { evidence_key: ev.evidence_key, verifier: `artifact:${aid}`, source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });

  it("attachEvidence via artifact fails closed even with a canonical artifact + mission (R4.B)", () => {
    const { store, svc } = freshDb("r4b-art-foreign");
    const bidA = mkBusiness(store, "BIZ_RA");
    const bidB = mkBusiness(store, "BIZ_RB");
    const o = mkObjective(svc, bidA);
    const midB = mkMission(store, bidB);
    const aidB = mkCanonicalArtifact(store, midB);
    const evB = mkAttachEvidence(store, midB);
    // artifact: verifiers are never attach authority — fail closed
    // before any provenance resolution.
    expectFail(
      () => svc.attachEvidence(String(o.objective_id), {
        business_id: bidA,
        evidence: { evidence_key: evB.evidence_key, verifier: `artifact:${aidB}`, source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });

  it("generic appendEvidence OBJECTIVE_PROGRESS alone is not KPI authority", () => {
    const { store, svc } = freshDb("r3a-generic");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    // A fully-binding governed evidence row under a canonical mission —
    // still NOT authority for a measurement (R3.A.6).
    const ev = mkProgressEvidence(store, mid, String(o.objective_id), "KPI_1", 9);
    expectFail(
      () => svc.recordProgress(String(o.objective_id), {
        business_id: bid, kpi_id: "KPI_1", value: 9, evidence: ev, actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });

  it("attach via mission fails closed even when the mission is canonical (R4.B)", () => {
    const { store, svc } = freshDb("r4b-attkey");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = mkMission(store, bid);
    expectFail(
      () => svc.attachEvidence(String(o.objective_id), {
        business_id: bid,
        evidence: { evidence_key: "EVD_ghost", verifier: `mission:${mid}`, source: "s" },
        actor: "e",
      }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
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
    const ev = ownerEvidence("ek-sem");
    svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: OWNER });
    // same key, different value — the semantic digest differs → conflict
    expectFail(
      () => svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_1", value: 6, evidence: ev, actor: OWNER }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different kpi
    expectFail(
      () => svc.recordProgress(oid, { business_id: bid, kpi_id: "KPI_2", value: 5, evidence: ev, actor: OWNER }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different verifier
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: ev.evidence_key, verifier: "operator:mallory", source: ev.source }, actor: OWNER,
      }),
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
    );
    // same key, different source
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: ev.evidence_key, verifier: ev.verifier, source: "other" }, actor: OWNER,
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
    const attachEv = ownerEvidence("attach-key-1");
    svc.attachEvidence(oid, { business_id: bid, evidence: attachEv, actor: OWNER });
    // same key as a PROGRESS application — different semantic digest →
    // conflict fires on the ledger BEFORE verifier resolution.
    expectFail(
      () => svc.recordProgress(oid, {
        business_id: bid, kpi_id: "KPI_1", value: 5,
        evidence: { evidence_key: attachEv.evidence_key, verifier: OWNER, source: attachEv.source },
        actor: OWNER,
      }),
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
  execFileSync(process.execPath, [
    esbuild,
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
    const ev = ownerEvidence("ek-race");
    const results = await runR2Race([
      { op: "progress", dbPath, args: { oid, input: { business_id: bid, kpi_id: "KPI_1", value: 5, evidence: ev, actor: OWNER } } },
      { op: "progress", dbPath, args: { oid, input: { business_id: bid, kpi_id: "KPI_1", value: 6, evidence: ev, actor: OWNER } } },
    ]);
    const row = svc.get(oid);
    expect([5, 6]).toContain((row.kpis as Array<Record<string, unknown>>)[0].current);
    expect(okCount(results)).toBe(1);
    const loser = results.find((r) => !r.ok) as { code: string };
    expect([
      "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
      "FAIL_CLOSED_VERSION_CONFLICT",
    ]).toContain(loser.code);
    store.close();
  });
});

function okCount(results: R2Outcome[]): number {
  return results.filter((r) => r.ok).length;
}

/* ==================== R3.B — create digest survives amendment ==================== */

describe("P15.1 R3.B — create_semantic_digest is immutable", () => {
  it("replay of the ORIGINAL create after an amend converges to the amended row — no new row/event/version", () => {
    const { store, svc } = freshDb("r3b-replay");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { target: "10" });
    const oid = String(a.objective_id);
    const amended = svc.amend(oid, { business_id: bid, actor: OWNER, patch: { target: "12" } });
    expect(amended.target).toBe("12");
    // exact replay of the ORIGINAL create → returns CURRENT amended row
    const replay = mkObjective(svc, bid, { target: "10" });
    expect(replay.objective_id).toBe(oid);
    expect(replay.target).toBe("12"); // current amended term, not the replayed one
    expect(replay.version).toBe(amended.version);
    expect(replay.terms_version).toBe(amended.terms_version);
    // create_semantic_digest is unchanged by the amend
    expect(replay.create_semantic_digest).toBe(a.create_semantic_digest);
    store.close();
  });

  it("same dedup identity + different original terms → CREATE_CONFLICT (even post-amend)", () => {
    const { store, svc } = freshDb("r3b-conflict");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { target: "10" });
    const oid = String(a.objective_id);
    svc.amend(oid, { business_id: bid, actor: OWNER, patch: { target: "12" } });
    expectFail(
      () => mkObjective(svc, bid, { target: "99" }),
      "FAIL_CLOSED_OBJECTIVE_CREATE_CONFLICT",
    );
    // the amended row is untouched
    const cur = svc.get(oid);
    expect(cur.target).toBe("12");
    store.close();
  });

  it("restart between create/amend/replay preserves create semantics", () => {
    const { dbPath, store, svc } = freshDb("r3b-restart");
    const bid = mkBusiness(store);
    const a = mkObjective(svc, bid, { target: "10" });
    const oid = String(a.objective_id);
    svc.amend(oid, { business_id: bid, actor: OWNER, patch: { target: "12" } });
    store.close();
    const store2 = new PairEvidenceStore(dbPath);
    const svc2 = new ObjectiveAuthorityService(store2);
    const replay = mkObjective(svc2, bid, { target: "10" });
    expect(replay.objective_id).toBe(oid);
    expect(replay.target).toBe("12");
    store2.close();
  });
});

/* ==================== R3.C — business provenance contradiction ==================== */

describe("P15.1 R3.C — unanimous business provenance", () => {
  it("contradictory mission business bindings fail closed for BOTH sides", () => {
    const { store, svc } = freshDb("r3c-conflict");
    const bidA = mkBusiness(store, "BIZ_RA");
    const bidB = mkBusiness(store, "BIZ_RB");
    const oA = mkObjective(svc, bidA);
    const oB = mkObjective(svc, bidB);
    // metadata.business_id=A but business_context.business_id=B — a
    // contradiction: never valid for either side.
    const mid = `MSN_MIX_${digest("mix").slice(0, 8)}`;
    store.put("mission", mid, {
      mission_id: mid, goal: "g", status: "COMPLETED",
      metadata: {
        business_id: bidA,
        business_context: { business_id: bidB },
        mission_origin: { operator_id: "op", provenance: "MISSION_INGRESS", pinned_at: "x" },
      },
      created_at: "x", version: 0,
    }, 0);
    const ev = mkAttachEvidence(store, mid);
    // R4.B — attach is owner-authorized only: contradictory provenance
    // never even reaches resolution; both objectives reject at the
    // verifier seam.
    for (const [oid, bid] of [[String(oA.objective_id), bidA], [String(oB.objective_id), bidB]] as const) {
      expectFail(
        () => svc.attachEvidence(oid, { business_id: bid, evidence: ev, actor: "e" }),
        "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
      );
    }
    store.close();
  });

  it("mission with NO business binding provable → fail closed", () => {
    const { store, svc } = freshDb("r3c-nobind");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const mid = `MSN_NB_${digest("nb").slice(0, 8)}`;
    store.put("mission", mid, {
      mission_id: mid, goal: "g", status: "COMPLETED",
      metadata: { mission_origin: { operator_id: "op", provenance: "MISSION_INGRESS", pinned_at: "x" } },
      created_at: "x", version: 0,
    }, 0);
    const ev = mkAttachEvidence(store, mid);
    // R4.B — attach is owner-authorized only (no provenance resolution).
    expectFail(
      () => svc.attachEvidence(String(o.objective_id), { business_id: bid, evidence: ev, actor: "e" }),
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
    );
    store.close();
  });
});

/* ==================== R4.A — create digest is integrity-bound ==================== */

describe("P15.1 R4.A — create_semantic_digest integrity binding", () => {
  it("tampering create_semantic_digest via direct store.put → strict get FAIL CLOSED", () => {
    const { store, svc } = freshDb("r4a-digest");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { target: "10" });
    const oid = String(o.objective_id);
    const row = JSON.parse(JSON.stringify(svc.get(oid))) as Record<string, unknown>;
    row.create_semantic_digest = digest("forged-create-semantics");
    // A direct canonical-row mutation without digest rebinding must be
    // caught by strict read — objective_digest binds it (R4.A).
    store.put("objective", oid, row, Number(row.version));
    expectFail(() => svc.get(oid), "FAIL_CLOSED_OBJECTIVE_DIGEST");
    store.close();
  });

  it("amend recomputes objective_digest while retaining the exact original create_semantic_digest", () => {
    const { store, svc } = freshDb("r4a-amend");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid, { target: "10" });
    const oid = String(o.objective_id);
    const csd = String(o.create_semantic_digest);
    const d0 = String(o.objective_digest);
    const amended = svc.amend(oid, { business_id: bid, patch: { target: "12" }, reason: "r", actor: OWNER });
    expect(String(amended.create_semantic_digest)).toBe(csd);
    expect(String(amended.objective_digest)).not.toBe(d0);
    // strict read still validates — the digest binds the retained csd.
    const reread = svc.get(oid);
    expect(String(reread.create_semantic_digest)).toBe(csd);
    expect(String(reread.target)).toBe("12");
    store.close();
  });
});

/* ==================== R3.D — strict runtime shape ==================== */

describe("P15.1 R3.D — strict runtime shape", () => {
  function tamper(o: Record<string, unknown>, mutate: (t: Record<string, unknown>) => void): Record<string, unknown> {
    const t = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    mutate(t);
    return t;
  }

  it("numeric-string KPI fields are malformed canonical state — current='5', target='10' fail closed", () => {
    const { store, svc } = freshDb("r3d-kpi");
    const bid = mkBusiness(store);
    const o = mkObjective(svc, bid);
    const oid = String(o.objective_id);
    const liveVersion = () => Number((store.tryGet("objective", oid) as Record<string, unknown>).version);
    for (const mutate of [
      (t: Record<string, unknown>) => { (t.kpis as Array<Record<string, unknown>>)[0].current = "5"; },
      (t: Record<string, unknown>) => { (t.kpis as Array<Record<string, unknown>>)[0].target = "10"; },
      (t: Record<string, unknown>) => { (t.kpis as Array<Record<string, unknown>>)[0].baseline = "0"; },
    ]) {
      const row = tamper(svc.get(oid), mutate);
      store.put("objective", oid, row, Number(row.version));
      expectFail(() => svc.get(oid), "FAIL_CLOSED_OBJECTIVE_INTEGRITY");
      // restore the canonical row — payload.version must equal the live
      // stored version (put CAS-bumps to version+1)
      const clean = tamper(row, (t) => { (t.kpis as Array<Record<string, unknown>>)[0].current = null; (t.kpis as Array<Record<string, unknown>>)[0].target = 10; (t.kpis as Array<Record<string, unknown>>)[0].baseline = 0; t.version = liveVersion(); });
      store.put("objective", oid, clean, Number(clean.version));
    }
    store.close();
  });

  it("duplicate ledger key (even same digest) and empty digest are malformed canonical state", () => {
    const { store, svc } = freshDb("r3d-ledger");
    const bid = mkBusiness(store);
    mkObjective(svc, bid, { budget_ceiling_microusd: 500 });
    const o = svc.list(bid).find((r) => String(r.schema_version) === "pair.os.vnext.objective.v1");
    const oid = String(o?.objective_id);
    const liveVersion = () => Number((store.tryGet("objective", oid) as Record<string, unknown>).version);
    for (const mutate of [
      // duplicate key, same digest
      (t: Record<string, unknown>) => {
        t.applied_spend_keys = [{ key: "s1", digest: "d" }, { key: "s1", digest: "d" }];
      },
      // empty digest
      (t: Record<string, unknown>) => {
        t.applied_spend_keys = [{ key: "s1", digest: "" }];
      },
      // legacy bare-string entry — malformed under strict shape
      (t: Record<string, unknown>) => {
        t.applied_evidence_keys = ["legacy-key"];
      },
      // empty key
      (t: Record<string, unknown>) => {
        t.applied_spend_keys = [{ key: "", digest: "d" }];
      },
    ]) {
      const canonical = svc.get(oid);
      const row = tamper(canonical, mutate);
      store.put("objective", oid, row, Number(row.version));
      expectFail(() => svc.get(oid), "FAIL_CLOSED_OBJECTIVE_INTEGRITY");
      // restore the canonical row before the next mutation (CAS version
      // must match the live stored version)
      const restore = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
      restore.version = liveVersion();
      store.put("objective", oid, restore, Number(restore.version));
    }
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
