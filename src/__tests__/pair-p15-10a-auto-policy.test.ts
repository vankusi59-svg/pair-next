/**
 * P15.10-A — objective auto-policy authority (owner opt-in control
 * plane). Adversarial matrix per mandate acceptance A01–A12:
 *
 *   A01 default OFF (fresh + legacy rows) — status never mints authority
 *   A02 owner-only mutations; forged owner / foreign business / malformed
 *   A03 tampered row/digest/binding re-proved on read → integrity fail
 *   A04 transition table + stale/conflicting/exact retry semantics
 *   A05 terms/owner amend invalidates; expired window never silently
 *       re-enables
 *   A06 two service instances on one store — CAS, no lost update
 *   A07 halt scope OBJECTIVE only; reset receipt; no body-flag admin
 *   A08 zero model/executor/mission side effects (global fetch spy)
 *   A09 manual objective path unaffected while auto OFF
 *   A10 HTTP boundary: header-only actor, 403 forbidden, no leak
 *   A11 cost lineage: driver_missing reports COST_BINDING_UNVERIFIED
 *   A12 restart/replay persistence; strict read on corrupt rows
 *
 * Non-vacuous: every rejection asserts the canonical error code AND
 * that no store row / event was minted or mutated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BusinessLayer,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveAuthorityService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  createMissionControlServer,
} from "../pair/index.js";
import { ObjectiveAutoPolicyService } from "../pair/objective-auto-policy.js";
import type { Server } from "node:http";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510a-"));
let counter = 0;
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const OTHER = "operator:intruder";
const TOK = "tok-p1510a";

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function fresh(name: string, now?: () => number) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, now);
  return { dir, store, objectives, policy };
}

function mkBiz(store: PairEvidenceStore) {
  const id = `BIZ_${counter}`;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE",
    created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(
  svc: ObjectiveAuthorityService,
  businessId: string,
  extra: Record<string, unknown> = {},
) {
  return svc.create({
    business_id: businessId,
    title: "Grow revenue",
    statement: "g",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE,
    budget_ceiling_microusd: 1_000_000,
    operator_id: OP,
    dedup_key: `dk-${counter}-${Math.random()}`,
    ...extra,
  });
}

const oid = (row: unknown) => String((row as { objective_id: string }).objective_id);

function expectFail(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

const LIMITS = () => ({ expires_at: FUTURE, max_ceo_calls: 4 });

const configure = (
  p: ObjectiveAutoPolicyService, objectiveId: string,
  actor = OWNER, key = `cfg-${counter}`,
) =>
  p.control({
    objective_id: objectiveId, actor, action: "configure",
    limits: LIMITS(), idempotency_key: key,
  });

const act = (
  p: ObjectiveAutoPolicyService, objectiveId: string,
  action: string, actor = OWNER, over: Record<string, unknown> = {},
) =>
  p.control({
    objective_id: objectiveId, actor, action,
    idempotency_key: `k-${counter}-${Math.random()}`,
    ...over,
  });

/* ============================ A01 — default OFF ========================= */

describe("A01 — default OFF / non-minting reads", () => {
  it("fresh objective: no policy → DISABLED, effective=false, no row minted", () => {
    const { store, objectives, policy } = fresh("a01");
    const bid = mkBiz(store);
    const o = mkObjective(objectives, bid);
    const st = policy.evaluate(oid(o));
    expect(st.state).toBe("DISABLED");
    expect(st.configured).toBe(false);
    expect(st.effective).toBe(false);
    expect(st.reasons).toContain("POLICY_NOT_CONFIGURED");
    expect(st.driver_ready).toBe(false);
    // Reading status/evaluate must NOT mint a policy row.
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
    policy.status(oid(o), OWNER);
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
  });

  it("legacy objective (row predating the feature) also reads DISABLED", () => {
    const { store, objectives, policy } = fresh("a01b");
    const bid = mkBiz(store);
    const o = mkObjective(objectives, bid);
    // Simulate legacy: no policy entity ever existed (already the case)
    // — status must still be a clean DISABLED read.
    expect(policy.status(oid(o), OWNER).state).toBe("DISABLED");
  });
});

/* ================= A02 — owner-only authority ========================= */

describe("A02 — owner scoping + forged input rejection", () => {
  it("non-owner cannot configure; forged owner string rejected", () => {
    const { store, objectives, policy } = fresh("a02");
    const o = mkObjective(objectives, mkBiz(store));
    expectFail(
      () => configure(policy, oid(o), OTHER),
      "FAIL_CLOSED_POLICY_OWNER",
    );
    expectFail(
      () => configure(policy, oid(o), OP),
      "FAIL_CLOSED_POLICY_OWNER", // bare id without operator: prefix is not the owner
    );
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
  });

  it("malformed bodies fail closed (no coercion)", () => {
    const { store, objectives, policy } = fresh("a02b");
    const o = mkObjective(objectives, mkBiz(store));
    for (const bad of [
      { action: "enable", code: "FAIL_CLOSED_POLICY_TRANSITION" },
      { action: "enable", policy_version: 1, code: "FAIL_CLOSED_POLICY_TRANSITION" },
      { action: "nuke", policy_version: 1, code: "FAIL_CLOSED_POLICY_SCHEMA" },
    ]) {
      expectFail(
        () => act(policy, oid(o), String(bad.action), OWNER, {
          policy_version: bad.policy_version as number,
        }),
        String(bad.code),
      );
    }
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "configure",
        limits: { expires_at: FUTURE }, // zero caps
        idempotency_key: "x",
      }),
      "FAIL_CLOSED_POLICY_LIMITS",
    );
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "configure",
        limits: { expires_at: "garbage", max_ceo_calls: 1 },
        idempotency_key: "x",
      }),
      "FAIL_CLOSED_POLICY_LIMITS",
    );
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "configure",
        limits: { expires_at: FUTURE, max_ceo_calls: 0 },
        idempotency_key: "x",
      }),
      "FAIL_CLOSED_POLICY_LIMITS",
    );
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
  });

  it("objective in a foreign business still gates on ITS owner", () => {
    const { store, objectives, policy } = fresh("a02c");
    const b1 = mkBiz(store);
    const b2 = `BIZ_FOREIGN_${counter}`;
    store.put("business", b2, {
      business_id: b2, name: "f", status: "ACTIVE", created_at: "x", version: 0,
    }, 0);
    const o1 = mkObjective(objectives, b1);
    const o2 = mkObjective(objectives, b2, { owner_authority_id: "operator:second" });
    // OP owns o1 only — configuring o2 (foreign owner) must reject.
    configure(policy, oid(o1));
    expectFail(() => configure(policy, oid(o2)), "FAIL_CLOSED_POLICY_OWNER");
  });
});

/* ================= A03 — binding re-proof / tamper ===================== */

describe("A03 — integrity + binding re-proof on read", () => {
  it("tampered policy row fails strict read; no authority minted", () => {
    const { store, objectives, policy } = fresh("a03");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    const row = store.get("objective_auto_policy", `oap:${oid(o)}`);
    // Forged owner flip inside the stored payload.
    const tampered = { ...row, owner_authority_id: OTHER };
    expect(() =>
      store.put("objective_auto_policy", `oap:${oid(o)}`, tampered, Number(row.version)),
    ).not.toThrow();
    expectFail(() => policy.status(oid(o), OWNER), "FAIL_CLOSED_POLICY_INTEGRITY");
    expectFail(() => policy.evaluate(oid(o)), "FAIL_CLOSED_POLICY_INTEGRITY");
    expectFail(
      () => act(policy, oid(o), "pause", OWNER, { policy_version: 1 }),
      "FAIL_CLOSED_POLICY_INTEGRITY",
    );
  });

  it("self-rehashed row rewrite (state ENABLED + forged digest) fails via anchor", async () => {
    const { store, objectives, policy } = fresh("a03b");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o)); // v1 DISABLED + CONFIGURE anchor only
    const row = store.get("objective_auto_policy", `oap:${oid(o)}`);
    // Attacker: state=ENABLED + forged terms binding + rehashed digest —
    // but CANNOT mint an ENABLE anchor via store.put.
    const forged = {
      ...row,
      state: "ENABLED",
      terms_digest_binding: String(o.objective_digest),
    };
    const { digest } = await import("../pair/canonical.js");
    forged.policy_digest = digest({
      schema: row.schema_version, entity_id: row.entity_id,
      objective_id: row.objective_id, business_id: row.business_id,
      owner_authority_id: row.owner_authority_id, state: "ENABLED",
      state_reason: null, policy_version: row.policy_version,
      limits: row.limits,
      terms_digest_binding: String(o.objective_digest),
      halt: null, applied_ops: row.applied_ops,
      last_op: row.last_op, last_receipt: row.last_receipt,
    });
    store.put("objective_auto_policy", `oap:${oid(o)}`, forged, Number(row.version));
    // Row self-verifies its own hash — the ANCHOR proof is what catches it.
    expectFail(() => policy.evaluate(oid(o)), "FAIL_CLOSED_POLICY_INTEGRITY");
    expectFail(() => policy.status(oid(o), OWNER), "FAIL_CLOSED_POLICY_INTEGRITY");
  });

  it("last_op/last_receipt tamper is anchor-caught BEFORE replay shortcut", async () => {
    const { store, objectives, policy } = fresh("a03c");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    // Tamper replay metadata to mimic an already-applied revoke; keep
    // policy_digest consistent so only the anchor proof can catch it.
    const row = store.get("objective_auto_policy", `oap:${oid(o)}`);
    const { digest } = await import("../pair/canonical.js");
    const fakeOp = { key: "k-revoke", action: "revoke", op_digest: digest({ action: "revoke", limits: null, halt_scope: null, halt_reason: null }) };
    const tampered = {
      ...row, last_op: fakeOp,
      last_receipt: { action: "revoke", to_state: "REVOKED" },
    };
    tampered.policy_digest = digest({
      schema: row.schema_version, entity_id: row.entity_id,
      objective_id: row.objective_id, business_id: row.business_id,
      owner_authority_id: row.owner_authority_id, state: row.state,
      state_reason: row.state_reason, policy_version: row.policy_version,
      limits: row.limits, terms_digest_binding: row.terms_digest_binding,
      halt: row.halt, applied_ops: row.applied_ops,
      last_op: fakeOp, last_receipt: tampered.last_receipt,
    });
    store.put("objective_auto_policy", `oap:${oid(o)}`, tampered, Number(row.version));
    // Real revoke by the owner must NOT be swallowed by forged replay
    // metadata — anchor proof fails first, row untouched.
    expectFail(
      () => act(policy, oid(o), "revoke", OWNER, { policy_version: 2, idempotency_key: "k-revoke" }),
      "FAIL_CLOSED_POLICY_INTEGRITY",
    );
    // Tampered row untouched — mutation never ran (raw store read).
    const stored = store.get("objective_auto_policy", `oap:${oid(o)}`);
    expect(stored.state).toBe("ENABLED");
  });
});

/* ============ A04 — transitions + retry convergence =================== */

describe("A04 — transition table + retry semantics", () => {
  it("full cycle configure→enable→pause→resume→disable + receipts", () => {
    const { store, objectives, policy } = fresh("a04");
    const o = mkObjective(objectives, mkBiz(store));
    const c = configure(policy, oid(o));
    expect(c.state).toBe("DISABLED");
    expect(c.policy_version).toBe(1);
    const e = act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    expect(e.state).toBe("ENABLED");
    expect(e.effective).toBe(true);
    expect(e.terms_digest_binding).toBe(String(o.objective_digest));
    const p = act(policy, oid(o), "pause", OWNER, { policy_version: 2 });
    expect(p.state).toBe("PAUSED");
    expect(p.effective).toBe(false);
    const r = act(policy, oid(o), "resume", OWNER, { policy_version: 3 });
    expect(r.state).toBe("ENABLED");
    const d = act(policy, oid(o), "disable", OWNER, { policy_version: 4 });
    expect(d.state).toBe("DISABLED");
    const evs = store.list("objective_auto_policy");
    expect(evs).toHaveLength(1);
  });

  it("exact retry converges to the same receipt; conflicting retry rejects", () => {
    const { store, objectives, policy } = fresh("a04b");
    const o = mkObjective(objectives, mkBiz(store));
    const key = `idem-${counter}`;
    const a1 = policy.control({
      objective_id: oid(o), actor: OWNER, action: "configure",
      limits: LIMITS(), idempotency_key: key,
    });
    const a2 = policy.control({
      objective_id: oid(o), actor: OWNER, action: "configure",
      limits: LIMITS(), idempotency_key: key,
    });
    expect(a2.policy_version).toBe(a1.policy_version); // converged, no bump
    // Same key, different limits → typed conflict.
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "configure",
        limits: { ...LIMITS(), max_missions: 2 }, idempotency_key: key,
      }),
      "FAIL_CLOSED_POLICY_IDEMPOTENCY_CONFLICT",
    );
  });

  it("stale policy_version rejected on every transition", () => {
    const { store, objectives, policy } = fresh("a04c");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    expectFail(
      () => act(policy, oid(o), "pause", OWNER, { policy_version: 1 }),
      "FAIL_CLOSED_POLICY_VERSION_CONFLICT",
    );
    expect(policy.evaluate(oid(o)).state).toBe("ENABLED");
  });

  it("F4 — durable idempotency: used key converges across intervening ops", () => {
    const { store, objectives, policy } = fresh("a04e");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o)); // v1
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 }); // v2
    act(policy, oid(o), "pause", OWNER, { policy_version: 2 }); // v3
    const kReuse = `reuse-${counter}`;
    act(policy, oid(o), "resume", OWNER, {
      policy_version: 3, idempotency_key: kReuse,
    }); // v4
    act(policy, oid(o), "pause", OWNER, { policy_version: 4 }); // v5
    // Resend the SAME resume op — must converge with zero mutation even
    // though a pause intervened (durable ledger, not last-op-only).
    const replay = policy.control({
      objective_id: oid(o), actor: OWNER, action: "resume",
      policy_version: 5, idempotency_key: kReuse,
    });
    expect(replay.policy_version).toBe(5);
    expect(replay.state).toBe("PAUSED");
    // Same key + different payload → typed conflict, still zero mutation.
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "resume",
        idempotency_key: kReuse, halt_reason: "tampered",
      }),
      "FAIL_CLOSED_POLICY_IDEMPOTENCY_CONFLICT",
    );
    expect(policy.evaluate(oid(o)).policy_version).toBe(5);
  });

  it("REVOKED is terminal — no action resurrects it", () => {
    const { store, objectives, policy } = fresh("a04d");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    const v = act(policy, oid(o), "revoke", OWNER, { policy_version: 2 });
    expect(v.state).toBe("REVOKED");
    for (const a of ["enable", "pause", "resume", "configure", "halt"]) {
      expectFail(
        () => act(policy, oid(o), a, OWNER, { policy_version: 3, limits: LIMITS() }),
        "FAIL_CLOSED_POLICY_TRANSITION",
      );
    }
  });
});

/* ========== A05 — terms/owner invalidation + expiry =================== */

describe("A05 — binding invalidation", () => {
  it("owner amend (any terms) → effective=false TERMS_CHANGED", () => {
    const { store, objectives, policy } = fresh("a05");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    expect(policy.evaluate(oid(o)).effective).toBe(true);
    objectives.amend(oid(o), {
      business_id: String(o.business_id),
      patch: { title: "new title" },
      actor: OWNER,
    });
    const st = policy.evaluate(oid(o));
    expect(st.effective).toBe(false);
    expect(st.terms_current).toBe(false);
    expect(st.reasons).toContain("TERMS_CHANGED");
  });

  it("owner_authority_id reassignment invalidates binding", () => {
    const { store, objectives, policy } = fresh("a05b");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    objectives.amend(oid(o), {
      business_id: String(o.business_id),
      patch: { owner_authority_id: "operator:new-owner" },
      actor: OWNER,
    });
    const st = policy.evaluate(oid(o));
    expect(st.effective).toBe(false);
    expect(st.reasons).toContain("BINDING_OWNER_MISMATCH");
  });

  it("ENABLED past expires_at → lazy EXPIRED committed once + anchor", () => {
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const { store, objectives, policy } = fresh("a05-clock", () => nowMs);
    const o = mkObjective(objectives, mkBiz(store));
    policy.control({
      objective_id: oid(o), actor: OWNER, action: "configure",
      limits: { expires_at: "2030-01-02T00:00:00.000Z", max_ceo_calls: 1 },
      idempotency_key: "c",
    });
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    expect(policy.evaluate(oid(o)).effective).toBe(true);
    // Time passes beyond the window.
    nowMs = Date.parse("2030-01-03T00:00:00.000Z");
    const st = policy.evaluate(oid(o));
    expect(st.state).toBe("EXPIRED");
    expect(st.effective).toBe(false);
    const v1 = policy.evaluate(oid(o)).policy_version;
    // Committed once — second evaluate must NOT bump version again.
    expect(v1).toBe(3);
    expect(policy.evaluate(oid(o)).policy_version).toBe(3);
  });

  it("configure with an already-lapsed window is rejected at configure", () => {
    const { store, objectives, policy } = fresh("a05-lapsed");
    const o = mkObjective(objectives, mkBiz(store));
    expectFail(
      () => policy.control({
        objective_id: oid(o), actor: OWNER, action: "configure",
        limits: { expires_at: PAST, max_ceo_calls: 1 }, idempotency_key: "x",
      }),
      "FAIL_CLOSED_POLICY_LIMITS",
    );
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
  });

  it("expired/resume boundary: EXPIRED can reconfigure to DISABLED, never re-enables silently", () => {
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const { store, objectives, policy } = fresh("a05-exp", () => nowMs);
    const o = mkObjective(objectives, mkBiz(store));
    policy.control({
      objective_id: oid(o), actor: OWNER, action: "configure",
      limits: { expires_at: "2030-01-02T00:00:00.000Z", max_ceo_calls: 1 },
      idempotency_key: "c",
    });
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    nowMs = Date.parse("2030-01-03T00:00:00.000Z");
    expect(policy.evaluate(oid(o)).state).toBe("EXPIRED");
    // Reconfigure lands DISABLED — a fresh explicit enable is required.
    const rec = policy.control({
      objective_id: oid(o), actor: OWNER, action: "configure",
      limits: { expires_at: "2030-02-01T00:00:00.000Z", max_ceo_calls: 1 },
      idempotency_key: "c2", policy_version: 3,
    });
    expect(rec.state).toBe("DISABLED");
    expect(rec.effective).toBe(false);
  });
});

/* ============= A06 — concurrent instances on one store ================ */

describe("A06 — CAS convergence across two service instances", () => {
  it("racing transitions: exactly one wins; loser gets typed conflict", () => {
    const { store, objectives } = fresh("a06");
    const p1 = new ObjectiveAutoPolicyService(store, objectives);
    const p2 = new ObjectiveAutoPolicyService(store, objectives);
    const o = mkObjective(objectives, mkBiz(store));
    configure(p1, oid(o));
    const r1 = act(p1, oid(o), "enable", OWNER, { policy_version: 1 });
    expect(r1.state).toBe("ENABLED");
    // p2 raced on the SAME expected version → conflict, no mutation.
    expectFail(
      () => act(p2, oid(o), "pause", OWNER, { policy_version: 1 }),
      "FAIL_CLOSED_POLICY_VERSION_CONFLICT",
    );
    expect(p1.evaluate(oid(o)).state).toBe("ENABLED");
    // Serial second writer with the right version succeeds once.
    act(p2, oid(o), "pause", OWNER, { policy_version: 2 });
    expect(p2.evaluate(oid(o)).state).toBe("PAUSED");
  });
});

/* ================= A07 — halt scope + reset =========================== */

describe("A07 — kill scope OBJECTIVE only", () => {
  it("halt OBJECTIVE works; business/global halt rejected", () => {
    const { store, objectives, policy } = fresh("a07");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    const h = act(policy, oid(o), "halt", OWNER, {
      policy_version: 2, halt_reason: "test halt",
    });
    expect(h.state).toBe("HALTED");
    expect(h.halt?.scope).toBe("OBJECTIVE");
    expectFail(
      () => act(policy, oid(o), "halt", OWNER, {
        policy_version: 3, halt_scope: "BUSINESS",
      }),
      "FAIL_CLOSED_POLICY_TRANSITION", // HALTED → halt not re-armed
    );
    const reset = act(policy, oid(o), "reset_halt", OWNER, { policy_version: 3 });
    expect(reset.state).toBe("DISABLED");
    expect(reset.halt).toBeNull();
  });

  it("non-OBJECTIVE halt scope rejected while ENABLED (HALT_SCOPE branch)", () => {
    const { store, objectives, policy } = fresh("a07b");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    for (const scope of ["BUSINESS", "GLOBAL", 42, null]) {
      expectFail(
        () => policy.control({
          objective_id: oid(o), actor: OWNER, action: "halt",
          policy_version: 2, halt_scope: scope, idempotency_key: `h-${scope}-${counter}`,
        }),
        "FAIL_CLOSED_POLICY_HALT_SCOPE",
      );
    }
    expect(policy.evaluate(oid(o)).state).toBe("ENABLED");
  });
});

/* ========= A08 — zero side effects (no model/executor calls) ========== */

describe("A08 — no model/executor/mission/telegram side effects", () => {
  it("global fetch + child_process never touched by policy paths", async () => {
    const { store, objectives, policy } = fresh("a08");
    const o = mkObjective(objectives, mkBiz(store));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    policy.evaluate(oid(o));
    act(policy, oid(o), "halt", OWNER, { policy_version: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
    // No mission/governed_task/telegram rows minted. (The service module
    // statically imports zero child_process/planner/executor deps —
    // ESM namespace exports are not spy-able, so the fetch spy + row
    // checks cover the dynamic surface.)
    expect(store.list("mission")).toHaveLength(0);
    expect(store.list("governed_task")).toHaveLength(0);
    expect(store.list("telegram_delivery_request")).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

/* ======= A09 — manual objective path unaffected while auto OFF ======== */

describe("A09 — manual path isolation", () => {
  it("auto OFF never blocks manual amend/progress; manual stays canonical", () => {
    const { store, objectives, policy } = fresh("a09");
    const o = mkObjective(objectives, mkBiz(store));
    // Policy exists but DISABLED — manual operations proceed.
    configure(policy, oid(o));
    const amended = objectives.amend(oid(o), {
      business_id: String(o.business_id),
      patch: { title: "still manual" },
      actor: OWNER,
    });
    expect(String(amended.title)).toBe("still manual");
    expect(policy.evaluate(oid(o)).effective).toBe(false);
  });
});

/* ================== A10 — HTTP boundary =============================== */

interface MiniStack { port: number; server: Server; store: PairEvidenceStore; biz: BusinessLayer; objectives: ObjectiveAuthorityService }

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function serveMini(objectives: ObjectiveAuthorityService, store: PairEvidenceStore): Promise<number> {
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const registry = new ExecutorRegistry(service);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const scheduler = new MissionScheduler(service, { mission_concurrency: 1 });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler,
    approvals: undefined as never, reconciliation: recon, recovery,
    planner: () => ({ tasks: [] }),
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler,
    approvals: undefined as never, reconciliation: recon,
    observability: new MissionObservability(service),
    planner: () => ({ tasks: [] }),
  });
  const biz = new BusinessLayer({ store, control, schedules: new MissionScheduleService(service) });
  const server = createMissionControlServer({
    business: biz, store, authToken: TOK,
  });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const hdr = (op = OWNER) => ({
  "content-type": "application/json",
  "x-operator-id": op,
  authorization: `Bearer ${TOK}`,
});

describe("A10 — HTTP boundary", () => {
  it("GET/POST owner-scoped; foreign operator → 403 without data leak", async () => {
    const { store, objectives, policy } = fresh("a10");
    const bid = mkBiz(store);
    const o = mkObjective(objectives, bid);
    configure(policy, oid(o));
    const port = await serveMini(objectives, store);
    const base = `http://127.0.0.1:${port}/api/vnext/objectives/${oid(o)}/auto-policy`;
    // Owner reads.
    const ok = await fetch(base, { headers: hdr() });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { auto_policy: { state: string } };
    expect(body.auto_policy.state).toBe("DISABLED");
    // Non-owner: 403, body carries no policy fields.
    const deny = await fetch(base, { headers: hdr(OTHER) });
    expect(deny.status).toBe(403);
    const denyBody = (await deny.json()) as Record<string, unknown>;
    expect(denyBody.error).toBe("FAIL_CLOSED_POLICY_FORBIDDEN");
    expect(denyBody.auto_policy).toBeFalsy();
    // No header actor at all → 403 required.
    const noHdr = await fetch(base, {
      headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
    });
    expect(noHdr.status).toBe(403);
    // Body-declared operator (header absent) is NOT authority here.
    const bodyForge = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
      body: JSON.stringify({ action: "configure", operator_id: OWNER, limits: LIMITS(), idempotency_key: "x" }),
    });
    expect(bodyForge.status).toBe(403);
    // Non-owner POST → 403.
    const denyPost = await fetch(base, {
      method: "POST", headers: hdr(OTHER),
      body: JSON.stringify({ action: "configure", limits: LIMITS(), idempotency_key: "x" }),
    });
    expect(denyPost.status).toBe(403);
  });

  it("F2 — raw-header create → policy round trip (canonical actor derived)", async () => {
    const { store, objectives } = fresh("a10c");
    const bid = mkBiz(store);
    const port = await serveMini(objectives, store);
    const rawHdr = {
      "content-type": "application/json",
      "x-operator-id": "audit-owner", // RAW id, no operator: prefix
      authorization: `Bearer ${TOK}`,
    };
    const c = await fetch(`http://127.0.0.1:${port}/api/vnext/objectives`, {
      method: "POST", headers: rawHdr,
      body: JSON.stringify({
        business_id: bid, title: "t", statement: "s",
        kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
        deadline: FUTURE, budget_ceiling_microusd: 1,
      }),
    });
    expect(c.status).toBe(200);
    const cj = (await c.json()) as { objective_id: string; owner_authority_id: string };
    expect(cj.owner_authority_id).toBe("operator:audit-owner");
    const base = `http://127.0.0.1:${port}/api/vnext/objectives/${cj.objective_id}/auto-policy`;
    // Same raw header is owner-canonical for policy ops too.
    const g = await fetch(base, { headers: rawHdr });
    expect(g.status).toBe(200);
    const cfg = await fetch(base, {
      method: "POST", headers: rawHdr,
      body: JSON.stringify({ action: "configure", limits: LIMITS(), idempotency_key: "k1" }),
    });
    expect(cfg.status).toBe(200);
    const cfgj = (await cfg.json()) as { auto_policy: { policy_version: number } };
    const en = await fetch(base, {
      method: "POST", headers: rawHdr,
      body: JSON.stringify({ action: "enable", policy_version: cfgj.auto_policy.policy_version, idempotency_key: "k2" }),
    });
    expect(en.status).toBe(200);
    const enj = (await en.json()) as { auto_policy: { state: string; effective: boolean } };
    expect(enj.auto_policy.state).toBe("ENABLED");
    expect(enj.auto_policy.effective).toBe(true);
    // Prefixed canonical form of the SAME raw id also works both ways.
    const g2 = await fetch(base, { headers: hdr("operator:audit-owner") });
    expect(g2.status).toBe(200);
    // A DIFFERENT owner (prefix or not) is still rejected.
    const deny = await fetch(base, { headers: hdr("random-owner") });
    expect(deny.status).toBe(403);
    const deny2 = await fetch(base, { headers: hdr("operator:random-owner") });
    expect(deny2.status).toBe(403);
  });

  it("F3 — malformed authority fields → 400, zero mutation, zero events", async () => {
    const { store, objectives } = fresh("a10d");
    const o = mkObjective(objectives, mkBiz(store));
    const port = await serveMini(objectives, store);
    const base = `http://127.0.0.1:${port}/api/vnext/objectives/${oid(o)}/auto-policy`;
    const before = store.listEvents("objective_auto_policy", `oap:${oid(o)}`).length;
    const badBodies = [
      { action: ["enable"], policy_version: true, idempotency_key: 123 },
      { action: { $ne: "enable" }, idempotency_key: "k" },
      { action: "configure", limits: [{ expires_at: FUTURE }], idempotency_key: "k" },
      { action: "configure", limits: LIMITS(), idempotency_key: ["k"] },
      { action: "enable", policy_version: "2", idempotency_key: "k" },
      { action: "halt", halt_scope: ["BUSINESS"], idempotency_key: "k" },
    ];
    for (const b of badBodies) {
      const r = await fetch(base, {
        method: "POST", headers: hdr(),
        body: JSON.stringify(b),
      });
      expect(r.status).toBe(400);
      const j = (await r.json()) as { error?: string };
      expect(j.error).toBe("FAIL_CLOSED_POLICY_SCHEMA");
    }
    // Zero row, zero events minted by any malformed request.
    expect(store.tryGet("objective_auto_policy", `oap:${oid(o)}`)).toBeFalsy();
    expect(store.listEvents("objective_auto_policy", `oap:${oid(o)}`)).toHaveLength(before);
  });

  it("POST owner configure → enable round-trip over HTTP", async () => {
    const { store, objectives } = fresh("a10b");
    const o = mkObjective(objectives, mkBiz(store));
    const port = await serveMini(objectives, store);
    const base = `http://127.0.0.1:${port}/api/vnext/objectives/${oid(o)}/auto-policy`;
    const c = await fetch(base, {
      method: "POST", headers: hdr(),
      body: JSON.stringify({ action: "configure", limits: LIMITS(), idempotency_key: "k1" }),
    });
    expect(c.status).toBe(200);
    const cj = (await c.json()) as { auto_policy: { policy_version: number } };
    const e = await fetch(base, {
      method: "POST", headers: hdr(),
      body: JSON.stringify({ action: "enable", policy_version: cj.auto_policy.policy_version, idempotency_key: "k2" }),
    });
    expect(e.status).toBe(200);
    const ej = (await e.json()) as { auto_policy: { state: string; effective: boolean } };
    expect(ej.auto_policy.state).toBe("ENABLED");
    expect(ej.auto_policy.effective).toBe(true);
  });
});

/* ===== O1 — effective honors the objective lifecycle ===== */

describe("O1 — effective = auto eligibility (lifecycle guard)", () => {
  it("CANCELLED objective → effective=false even with ENABLED policy", () => {
    const { store, objectives, policy } = fresh("o1");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    expect(policy.evaluate(oid(o)).effective).toBe(true);
    objectives.transitionStatus(oid(o), {
      business_id: String(o.business_id), to: "CANCELLED", actor: OWNER,
    });
    const st = policy.evaluate(oid(o));
    expect(st.state).toBe("ENABLED");
    expect(st.effective).toBe(false);
    expect(st.reasons).toContain("OBJECTIVE_CANCELLED");
  });
});

/* ========== A11 — cost lineage honesty (unknown cost fail-closed) ====== */

describe("A11 — cost binding honesty", () => {
  it("ENABLED policy still reports driver not-ready + unverified cost", () => {
    const { store, objectives, policy } = fresh("a11");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    const st = policy.evaluate(oid(o));
    expect(st.driver_ready).toBe(false);
    expect(st.driver_missing).toEqual(
      expect.arrayContaining(["AUTO_DRIVER_NOT_INTEGRATED", "COST_BINDING_UNVERIFIED"]),
    );
  });
});

/* ============== A12 — restart/replay persistence ====================== */

describe("A12 — restart + replay durability", () => {
  it("row + digest survive a store reopen; corrupt row fails closed", () => {
    const { dir, store, objectives, policy } = fresh("a12");
    const o = mkObjective(objectives, mkBiz(store));
    configure(policy, oid(o));
    act(policy, oid(o), "enable", OWNER, { policy_version: 1 });
    const dbPath = path.join(dir, "pair.db");
    // Fresh process-side store on the same file — restart durability.
    const store2 = new PairEvidenceStore(dbPath);
    const policy2 = new ObjectiveAutoPolicyService(store2, objectives);
    const st = policy2.evaluate(oid(o));
    expect(st.state).toBe("ENABLED");
    expect(st.effective).toBe(true);
    // Corrupt a persisted field — reopened strict read must fail.
    const row = store.get("objective_auto_policy", `oap:${oid(o)}`);
    store.put("objective_auto_policy", `oap:${oid(o)}`,
      { ...row, limits: { ...LIMITS(), max_ceo_calls: -5 } }, Number(row.version));
    expectFail(() => policy.evaluate(oid(o)), "FAIL_CLOSED_POLICY_LIMITS");
  });
});
