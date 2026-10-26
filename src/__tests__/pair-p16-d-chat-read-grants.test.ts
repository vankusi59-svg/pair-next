/**
 * P16-D — verified read grants for the governed operational-status chat
 * surface (Phase-5 seam: ConversationReadGrantService + scopeForPrincipal
 * wiring inside OperationalQueryService).
 *
 * Proves the authority contract:
 *  - mint lanes: admin credential delegates any declared scope; an owner
 *    claim (operator:<id>) may vouch ONLY scope it can canonically prove
 *    (owner_authority_id objectives / BUSINESS_CREATED businesses) and
 *    only its own operator_ref — foreign vouching fails closed;
 *  - canonical discipline: digest-pinned rows, event anchors, idempotent
 *    mint/control, ENABLED → DISABLED|REVOKED terminal, future expiry;
 *  - enforcement: a granted operator/telegram principal reads exactly the
 *    vouched scope — declared ids and/or the vouched owner's footprint —
 *    never foreign data, never admin/global-infra sections;
 *  - default-deny is unchanged: ungranted, expired, revoked/disabled or
 *    forged-grant principals stay UNVERIFIED_IDENTITY;
 *  - the read path never writes (no rows, no events).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  ConversationReadGrantService,
  ConversationSessionService,
  createMissionControlServer,
  ensureConversationModel,
  IntegrityError,
  MissionControl,
  OperationalQueryService,
  PairControlPlane,
  PairError,
  PairEvidenceStore,
  type ConvReadGrantRow,
  type ConversationPrincipal,
  type OperationalReadSurface,
  type OperatorContextRequest,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p16-d-");
let counter = 0;
const NOW = "2026-10-20T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const OP = "alice";
const OP_REF = `operator:${OP}`;
const FOREIGN = "bob";
const FOREIGN_REF = `operator:${FOREIGN}`;
const TG = "telegram:555000111";

function fresh(name: string, opts: { now?: () => number } = {}) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const grants = new ConversationReadGrantService({ store, now: opts.now ?? (() => NOW_MS) });
  return { store, grants };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PairError) return e.code;
    throw e;
  }
  throw new Error("expected PairError");
}

/* ---------------- canonical seeding -------------------------------- */

/** alice's provable footprint + bob's foreign footprint. */
function seedFootprints(store: PairEvidenceStore) {
  const put = (entity: string, id: string, row: Record<string, unknown>) =>
    store.put(entity, id, { version: 0, ...row }, 0);
  put("business", "BIZ_A", {
    business_id: "BIZ_A", name: "alice co", project_id: "PRJ_1",
    status: "ACTIVE", created_at: NOW,
  });
  store.event({
    entity_type: "business", entity_id: "BIZ_A",
    event_type: "BUSINESS_CREATED", new_state: "ACTIVE",
    actor: OP_REF, metadata: { name: "alice co" },
  });
  put("objective", "OBJ_A", {
    objective_id: "OBJ_A", business_id: "BIZ_A",
    owner_authority_id: OP_REF, title: "alice objective",
    status: "ACTIVE", created_at: NOW,
    budget: { ceiling_microusd: 1000, consumed_microusd: 700 },
  });
  // Foreign: bob owns these — alice can never vouch them.
  put("business", "BIZ_B", {
    business_id: "BIZ_B", name: "bob co", project_id: "PRJ_1",
    status: "ACTIVE", created_at: NOW,
  });
  store.event({
    entity_type: "business", entity_id: "BIZ_B",
    event_type: "BUSINESS_CREATED", new_state: "ACTIVE",
    actor: FOREIGN_REF, metadata: { name: "bob co" },
  });
  put("objective", "OBJ_B", {
    objective_id: "OBJ_B", business_id: "BIZ_B",
    owner_authority_id: FOREIGN_REF, title: "bob objective",
    status: "ACTIVE", created_at: NOW,
    budget: { ceiling_microusd: 50, consumed_microusd: 10 },
  });
  // Missions: MSN_BOUND bound to BIZ_A (alice footprint); MSN_FOREIGN to BIZ_B.
  const mission = (id: string, boundOpenId: string | null) => ({
    mission_id: id, project_id: "PRJ_1", goal: `goal ${id}`,
    bound_open_id: boundOpenId, status: "CREATED", metadata: {}, created_at: NOW,
  });
  put("mission", "MSN_BOUND", mission("MSN_BOUND", "OPI_A"));
  put("mission_runtime", "MRT_MSN_BOUND", { mission_id: "MSN_BOUND", state: "RUNNING", created_at: NOW });
  put("mission", "MSN_FOREIGN", mission("MSN_FOREIGN", "OPI_B"));
  put("mission_runtime", "MRT_MSN_FOREIGN", { mission_id: "MSN_FOREIGN", state: "RUNNING", created_at: NOW });
  put("work_open_binding", "OPI_A", {
    open_id: "OPI_A", mission_id: "MSN_BOUND", work_item_id: "WI_A",
    business_id: "BIZ_A", project_id: "PRJ_1", state: "BOUND", created_at: NOW,
  });
  put("work_open_binding", "OPI_B", {
    open_id: "OPI_B", mission_id: "MSN_FOREIGN", work_item_id: "WI_B",
    business_id: "BIZ_B", project_id: "PRJ_1", state: "BOUND", created_at: NOW,
  });
}

/* ---------------- envelope harness --------------------------------- */

function controlStub(store: PairEvidenceStore): OperationalReadSurface {
  return {
    missions: () =>
      store.list("mission").map((m) => ({
        ...m,
        runtime_state: store.tryGet("mission_runtime", `MRT_${String(m.mission_id)}`)?.state ?? null,
      })),
    providers: () => ({ providers: [], qualifications: [] }),
    routing: () => ({ routable: [], executors: [], routes: [], bindings: [] }),
    approvals: () => store.list("approval_request"),
    health: () => ({}),
    cost: () => ({ remote_dispatches_today: 0, remote_daily_limit: 10, cost_halt: false }),
  };
}

function opsWith(store: PairEvidenceStore, grants: ConversationReadGrantService | null) {
  return new OperationalQueryService({
    store,
    control: controlStub(store),
    now: () => NOW,
    ...(grants ? { readGrants: grants } : {}),
  });
}

function statusReq(
  ops: OperationalQueryService,
  principal: ConversationPrincipal,
  body = "hello",
): Record<string, unknown> {
  return ops.statusForConversation({
    operator_id: principal.operator_id,
    session_id: "CS_1",
    principal,
    latest_message: {
      message_id: "M_1", idempotency_key: null,
      body, seq: 1, created_at: NOW,
    },
    context_tail: [],
  });
}

function unavailFor(env: Record<string, unknown>, section: string): string | null {
  const hit = (env.unavailable as Array<{ section: string; reason: string }>)
    .find((u) => u.section === section);
  return hit?.reason ?? null;
}

/* =====================================================================
 * Service-level authority
 * ===================================================================== */

describe("ConversationReadGrantService — mint lanes", () => {
  it("owner claim mints a digest-pinned grant inside its provable scope; replay is idempotent", () => {
    const { store, grants } = fresh("mint-owner");
    seedFootprints(store);
    const expires = NOW_MS + 60_000;
    const input = {
      actor: OP_REF, actor_kind: "operator" as const,
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: ["BIZ_A"], own_footprint: false },
      expires_at: expires,
      idempotency_key: "g1",
    };
    const r1 = grants.grant(input);
    expect(r1.replayed).toBe(false);
    const g = r1.grant;
    expect(g.state).toBe("ENABLED");
    expect(g.granted_by).toBe(OP_REF);
    expect(g.grant_digest).toMatch(/^[0-9a-f]{64}$/);
    // Canonical event anchor.
    const evs = store.listEvents("conversation_read_grant")
      .filter((e) => e.entity_id === g.grant_id);
    expect(evs.map((e) => String(e.event_type))).toEqual(["CONVERSATION_READ_GRANTED"]);
    // Same dedup key + identical semantics → the stored row, replayed.
    const r2 = grants.grant(input);
    expect(r2.replayed).toBe(true);
    expect(r2.grant.grant_id).toBe(g.grant_id);
    expect(store.list("conversation_read_grant")).toHaveLength(1);
    // Same dedup key + different semantics → fail closed.
    expect(code(() => grants.grant({ ...input, expires_at: expires + 1000 })))
      .toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_IDEMPOTENT_MISMATCH");
  });

  it("owner claim can never vouch foreign scope or a foreign operator_ref", () => {
    const { store, grants } = fresh("mint-foreign");
    seedFootprints(store);
    const base = {
      actor: OP_REF, actor_kind: "operator" as const,
      principal_ref: TG, expires_at: NOW_MS + 60_000,
    };
    // Foreign objective.
    expect(code(() => grants.grant({
      ...base, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
    // Foreign business.
    expect(code(() => grants.grant({
      ...base, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: ["BIZ_B"], own_footprint: false },
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
    // A claim can never vouch another owner's ref — even with in-scope data.
    expect(code(() => grants.grant({
      ...base, operator_ref: FOREIGN_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
    // Zero grants were minted — all rejected before any row.
    expect(store.list("conversation_read_grant")).toHaveLength(0);
  });

  it("admin lane delegates any declared scope; shape/expiry/empty-scope fail closed", () => {
    const { store, grants } = fresh("mint-admin");
    seedFootprints(store);
    const g = grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    }).grant;
    expect(g.granted_by).toBe("admin");
    expect(g.scope.objective_ids).toEqual(["OBJ_B"]);

    // Admin actor kind with a non-admin actor → schema failure.
    expect(code(() => grants.grant({
      actor: OP_REF, actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA");
    // Past / non-finite expiry.
    expect(code(() => grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS - 1,
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_EXPIRY");
    // Empty scope vouches nothing.
    expect(code(() => grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCOPE_EMPTY");
    // Malformed principal/operator refs.
    expect(code(() => grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: "telegram 555", operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA");
    expect(code(() => grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: "telegram:999",
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA");
  });

  it("expiry boundary: expires_at <= now and absurd far-future TTL both fail closed", () => {
    const { store, grants } = fresh("expiry-bound");
    seedFootprints(store);
    const base = {
      actor: OP_REF, actor_kind: "operator" as const,
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
    };
    expect(code(() => grants.grant({ ...base, expires_at: NOW_MS })))
      .toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_EXPIRY");
    // Effectively-permanent delegation exceeds the TTL bound.
    expect(code(() => grants.grant({ ...base, expires_at: NOW_MS + 1e15 })))
      .toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_EXPIRY");
    // expires_at exactly at the read boundary vouches nothing.
    grants.grant({ ...base, expires_at: NOW_MS + 1 });
    // (grant minted while valid — the scope check below re-evaluates `now`
    // through the service clock, which is still NOW_MS → in scope)
    expect(grants.scopeForPrincipal(TG)).not.toBeNull();
  });

  it("dedup replay can never be an existence/metadata oracle for a foreign claim", () => {
    const { store, grants } = fresh("dedup-oracle");
    seedFootprints(store);
    grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: FOREIGN_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
      idempotency_key: "shared-key",
    });
    // A foreign operator claim replaying the same dedup_key hits the
    // authority gate BEFORE the dedup oracle — it learns nothing.
    expect(code(() => grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: FOREIGN_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
      idempotency_key: "shared-key",
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
  });

  it("own_footprint owner mint needs no declared ids — the footprint IS the scope", () => {
    const { store, grants } = fresh("mint-footprint");
    seedFootprints(store);
    const g = grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    }).grant;
    expect(g.scope.own_footprint).toBe(true);
  });
});

describe("ConversationReadGrantService — control + scope resolution", () => {
  it("disable/revoke are terminal + idempotent; authority is granted_by/operator_ref-or-admin", () => {
    const { store, grants } = fresh("control");
    seedFootprints(store);
    const g = grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    }).grant;
    // A foreign operator claim cannot close alice's grant.
    expect(code(() => grants.control(g.grant_id, {
      actor: FOREIGN_REF, actor_kind: "operator", action: "revoke",
    }))).toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
    // The vouched owner (== granted_by here) disables; replay is idempotent.
    const d = grants.control(g.grant_id, { actor: OP_REF, actor_kind: "operator", action: "disable" });
    expect(d.grant.state).toBe("DISABLED");
    expect(d.replayed).toBe(false);
    const d2 = grants.control(g.grant_id, { actor: OP_REF, actor_kind: "operator", action: "disable" });
    expect(d2.replayed).toBe(true);
    const evs = store.listEvents("conversation_read_grant")
      .filter((e) => e.entity_id === g.grant_id)
      .map((e) => String(e.event_type));
    expect(evs).toEqual(["CONVERSATION_READ_GRANTED", "CONVERSATION_READ_GRANT_DISABLED"]);
    // Admin can always revoke.
    const g2 = grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    }).grant;
    const r = grants.control(g2.grant_id, { actor: "admin", actor_kind: "admin", action: "revoke" });
    expect(r.grant.state).toBe("REVOKED");
  });

  it("scopeForPrincipal unions ENABLED+unexpired grants; expired/disabled/forged vouch nothing", () => {
    let now = NOW_MS;
    const { store, grants } = fresh("scope", { now: () => now });
    seedFootprints(store);
    // Grant 1 (admin): declared objective scope.
    grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: now + 60_000,
    });
    // Grant 2 (owner): own footprint.
    grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: now + 60_000,
    });
    // Grant 3: different principal — never vouches TG.
    grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: "telegram:999999", operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: now + 60_000,
    });
    const eff = grants.scopeForPrincipal(TG)!;
    expect(eff.objective_ids).toEqual(["OBJ_A"]);
    expect(eff.operator_refs).toEqual([OP_REF]);
    expect(eff.grant_ids).toHaveLength(2);
    // A forged grant row (valid payload_hash via store.put, invalid
    // grant_digest) is skipped by strict re-proof — it vouches nothing.
    const forged: ConvReadGrantRow = {
      grant_id: "cgr_forged", schema: "pair.os.vnext.conversation-read-grant.v1",
      principal_ref: TG, operator_ref: FOREIGN_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: ["BIZ_B"], own_footprint: true },
      state: "ENABLED", expires_at: now + 60_000,
      granted_by: "admin", granted_at: NOW,
      grant_digest: "0".repeat(64),
      dedup_key: null, disabled_at: null, disabled_by: null,
      revoked_at: null, revoked_by: null, version: 0,
    };
    store.put("conversation_read_grant", forged.grant_id, forged, 0);
    const eff2 = grants.scopeForPrincipal(TG)!;
    expect(eff2.objective_ids).toEqual(["OBJ_A"]); // forged OBJ_B absent
    expect(eff2.operator_refs).toEqual([OP_REF]);  // forged FOREIGN_REF absent
    // Expiry: all real grants lapsed → only the (skipped) forged row remains → null.
    now += 120_000;
    expect(grants.scopeForPrincipal(TG)).toBeNull();
    // status() is read-only and flags expiry instead of writing.
    const st = grants.status({ principal_ref: TG });
    expect(st).toHaveLength(2);
    expect(st.every((g) => g.expired_pending)).toBe(true);
  });

  it("resurrection: a close-then-flipped-back-ENABLED row keeps a valid digest but is still skipped", () => {
    const { store, grants } = fresh("resurrect");
    seedFootprints(store);
    const g = grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    }).grant;
    grants.control(g.grant_id, { actor: OP_REF, actor_kind: "operator", action: "revoke" });
    expect(grants.scopeForPrincipal(TG)).toBeNull();
    // Store-level rewrite flips the row back to ENABLED and re-pins the
    // digest for that state — strict re-proof passes it, but the canonical
    // event chain still records the close: validRows skips the
    // resurrection signature on EVERY path.
    const resurrected = {
      ...g,
      state: "ENABLED",
      revoked_at: null,
      revoked_by: null,
      grant_digest: g.grant_digest, // original ENABLED-state digest re-pins
      version: 2,
    };
    store.put("conversation_read_grant", g.grant_id, resurrected, 2);
    expect(grants.scopeForPrincipal(TG)).toBeNull();
    expect(grants.status({ grant_id: g.grant_id })).toHaveLength(0);
  });
});

/* =====================================================================
 * Envelope enforcement — the UNVERIFIED_IDENTITY seam
 * ===================================================================== */

describe("OperationalQueryService — grant-verified scoped reads", () => {
  it("regression pin: without a grant every non-admin principal stays UNVERIFIED_IDENTITY", () => {
    const { store, grants } = fresh("deny");
    seedFootprints(store);
    const ops = opsWith(store, grants);
    for (const principal of [
      { kind: "operator", operator_id: OP },
      { kind: "telegram", operator_id: TG },
    ] as ConversationPrincipal[]) {
      const env = statusReq(ops, principal, "what is running");
      const u = env.unavailable as Array<{ reason: string }>;
      expect(u.length).toBeGreaterThan(0);
      expect(u.every((x) => x.reason === "UNVERIFIED_IDENTITY")).toBe(true);
      expect(Object.keys(env.sections as object)).toHaveLength(0);
    }
  });

  it("a telegram grant serves exactly the vouched scope — never foreign data, never admin sections", () => {
    const { store, grants } = fresh("serve");
    seedFootprints(store);
    grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    });
    const ops = opsWith(store, grants);
    const tgPrincipal: ConversationPrincipal = { kind: "telegram", operator_id: TG };

    // Declared objective scope → objectives_owned serves OBJ_A only.
    const env = statusReq(ops, tgPrincipal, "hello");
    const owned = (env.sections as Record<string, unknown>).objectives_owned as {
      items: Array<{ objective_id: string }>;
    };
    expect(owned.items.map((o) => o.objective_id)).toEqual(["OBJ_A"]);

    // Vouched scope is mission-empty (no business vouched) — ACTIVE_WORK
    // sections serve bounded emptiness rather than denying.
    const active = statusReq(ops, tgPrincipal, "what is running");
    const missions = ((active.sections as Record<string, unknown>).active_missions as {
      items: Array<{ mission_id: string }>;
    }).items;
    expect(missions).toHaveLength(0);
    expect(unavailFor(active, "active_missions")).toBeNull();

    // Global-infra sections remain INSUFFICIENT_AUTHORITY — a grant can
    // never become admin.
    const prov = statusReq(ops, tgPrincipal, "which model providers are available");
    expect(unavailFor(prov, "providers")).toBe("INSUFFICIENT_AUTHORITY");
    expect(unavailFor(prov, "executors")).toBe("INSUFFICIENT_AUTHORITY");

    // A different telegram chat gets NOTHING — the grant is principal-bound.
    const other = statusReq(ops, { kind: "telegram", operator_id: "telegram:999" }, "hello");
    expect(unavailFor(other, "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
    // An operator principal with the same raw claim id is also not the
    // granted principal_ref.
    const opPrincipal = statusReq(ops, { kind: "operator", operator_id: OP }, "hello");
    expect(unavailFor(opPrincipal, "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
  });

  it("own_footprint grant serves the vouched owner's derived scope incl. binding-chain missions", () => {
    const { store, grants } = fresh("footprint-serve");
    seedFootprints(store);
    grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    });
    const ops = opsWith(store, grants);
    const env = statusReq(ops, { kind: "telegram", operator_id: TG }, "what is running");
    const missions = ((env.sections as Record<string, unknown>).active_missions as {
      items: Array<{ mission_id: string }>;
    }).items.map((m) => m.mission_id);
    // BIZ_A bound mission — inside alice's footprint.
    expect(missions).toContain("MSN_BOUND");
    // Foreign mission — never served.
    expect(missions).not.toContain("MSN_FOREIGN");
    const owned = ((env.sections as Record<string, unknown>).objectives_owned as {
      items: Array<{ objective_id: string }>;
    }).items.map((o) => o.objective_id);
    expect(owned).toEqual(["OBJ_A"]);
  });

  it("declared business scope vouches binding-chain missions; objectives stay declared-only", () => {
    const { store, grants } = fresh("biz-scope");
    seedFootprints(store);
    grants.grant({
      actor: "admin", actor_kind: "admin",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: ["BIZ_B"], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    });
    const ops = opsWith(store, grants);
    const env = statusReq(ops, { kind: "telegram", operator_id: TG }, "what is running");
    const missions = ((env.sections as Record<string, unknown>).active_missions as {
      items: Array<{ mission_id: string }>;
    }).items.map((m) => m.mission_id);
    // Admin delegated BIZ_B reads → its bound mission is in scope.
    expect(missions).toEqual(["MSN_FOREIGN"]);
    // But no objectives were declared → objectives_owned is empty, not denied.
    const owned = ((env.sections as Record<string, unknown>).objectives_owned as {
      items: Array<{ objective_id: string }>;
    }).items;
    expect(owned).toHaveLength(0);
  });

  it("revoked/disabled/expired grants return the principal to UNVERIFIED_IDENTITY", () => {
    let now = NOW_MS;
    const { store, grants } = fresh("lifecycle", { now: () => now });
    seedFootprints(store);
    const live = grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: now + 60_000,
    }).grant;
    const ops = opsWith(store, grants);
    const tg: ConversationPrincipal = { kind: "telegram", operator_id: TG };
    expect((statusReq(ops, tg).sections as Record<string, unknown>).objectives_owned).toBeDefined();
    // Revoke → deny.
    grants.control(live.grant_id, { actor: OP_REF, actor_kind: "operator", action: "revoke" });
    expect(unavailFor(statusReq(ops, tg), "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
    // Fresh grant; then lapse the clock → deny.
    grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: now + 30_000, idempotency_key: "g2",
    });
    now += 60_000;
    expect(unavailFor(statusReq(ops, tg), "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
  });

  it("a forged grant row can never vouch: the principal stays UNVERIFIED_IDENTITY", () => {
    const { store, grants } = fresh("forged");
    seedFootprints(store);
    store.put("conversation_read_grant", "cgr_forged", {
      grant_id: "cgr_forged", schema: "pair.os.vnext.conversation-read-grant.v1",
      principal_ref: TG, operator_ref: FOREIGN_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: ["BIZ_B"], own_footprint: true },
      state: "ENABLED", expires_at: NOW_MS + 60_000,
      granted_by: "admin", granted_at: NOW,
      grant_digest: "f".repeat(64),
      dedup_key: null, disabled_at: null, disabled_by: null,
      revoked_at: null, revoked_by: null, version: 0,
    }, 0);
    const ops = opsWith(store, grants);
    const env = statusReq(ops, { kind: "telegram", operator_id: TG });
    expect(unavailFor(env, "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
    expect(Object.keys(env.sections as object)).toHaveLength(0);
  });

  it("footprint scope covers missions proven through BARE-stored draft ownership", () => {
    const { store, grants } = fresh("footprint-draft");
    seedFootprints(store);
    // conversation_mission_draft.owner_operator_id stores the RAW claim
    // ("alice") — a canonical-only footprint would silently miss it.
    store.put("mission", "MSN_DRAFT", {
      mission_id: "MSN_DRAFT", project_id: "PRJ_1", goal: "drafted",
      bound_open_id: null, status: "CREATED", metadata: {}, created_at: NOW,
    }, 0);
    store.put("mission_runtime", "MRT_MSN_DRAFT", {
      mission_id: "MSN_DRAFT", state: "RUNNING", created_at: NOW,
    }, 0);
    store.put("conversation_mission_draft", "CMD_A", {
      draft_id: "CMD_A", session_id: "CS_a", owner_operator_id: OP,
      mission_id: "MSN_DRAFT", state: "CONFIRMED", created_at: NOW,
    }, 0);
    grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: NOW_MS + 60_000,
    });
    const ops = opsWith(store, grants);
    const env = statusReq(ops, { kind: "telegram", operator_id: TG }, "what is running");
    const missions = ((env.sections as Record<string, unknown>).active_missions as {
      items: Array<{ mission_id: string }>;
    }).items.map((m) => m.mission_id);
    expect(missions).toContain("MSN_DRAFT");
    expect(missions).toContain("MSN_BOUND");
    expect(missions).not.toContain("MSN_FOREIGN");
  });

  it("an unwired readGrants seam keeps every non-admin UNVERIFIED_IDENTITY", () => {
    const { store } = fresh("unwired");
    seedFootprints(store);
    const ops = opsWith(store, null);
    const env = statusReq(ops, { kind: "telegram", operator_id: TG });
    expect(unavailFor(env, "objectives_owned")).toBe("UNVERIFIED_IDENTITY");
  });

  it("the read path performs zero writes — no grant rows, no events, no version churn", () => {
    const { store, grants } = fresh("no-writes");
    seedFootprints(store);
    const g = grants.grant({
      actor: OP_REF, actor_kind: "operator",
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: NOW_MS + 60_000,
    }).grant;
    const ops = opsWith(store, grants);
    const eventCount = store.listEvents("conversation_read_grant").length;
    const version = grants.status({ grant_id: g.grant_id })[0]!.version;
    for (let i = 0; i < 5; i++) {
      statusReq(ops, { kind: "telegram", operator_id: TG });
      grants.scopeForPrincipal(TG);
      grants.status({});
    }
    expect(store.listEvents("conversation_read_grant")).toHaveLength(eventCount);
    expect(store.list("conversation_read_grant")).toHaveLength(1);
    expect(grants.status({ grant_id: g.grant_id })[0]!.version).toBe(version);
  });
});

/* =====================================================================
 * HTTP boundary — grant management routes
 * ===================================================================== */

const TOK = "mc-token-p16d-aaaaaaaaaaaaaaaa";
const ADM = "adm-token-p16d-bbbbbbbbbbbbbbbb";
const servers: Array<{ close: () => void }> = [];

function httpFresh(name: string) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  service.createProject({ name: "p", root_location: workspace });
  const control = new MissionControl({
    service,
    runtime: undefined as never,
    supervisor: undefined as never,
    scheduler: undefined as never,
    approvals: undefined as never,
    reconciliation: undefined as never,
    observability: undefined as never,
    planner: () => ({ tasks: [] }),
  });
  const sessions = new ConversationSessionService(store);
  const grants = new ConversationReadGrantService({ store });
  seedFootprints(store);
  return { store, control, sessions, grants };
}

async function serve(s: ReturnType<typeof httpFresh>) {
  const server = createMissionControlServer({
    control: s.control,
    store: s.store,
    authToken: TOK,
    adminToken: ADM,
    conversation: { sessions: s.sessions, readGrants: s.grants },
  });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server as unknown as { close: () => void });
  return (server.address() as AddressInfo).port;
}

const mcHdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-operator-id": OP,
  authorization: `Bearer ${TOK}`,
  ...extra,
});
const admHdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  // The uniform POST operator-id gate requires the header even on the
  // admin lane (same as admin conversation turns) — its value is unused.
  "x-operator-id": "operator:admin",
  authorization: `Bearer ${ADM}`,
  ...extra,
});
const get = async (port: number, p: string, h?: Record<string, string>) =>
  j(await fetch(`http://127.0.0.1:${port}${p}`, { headers: h ?? mcHdr() }));
const post = async (port: number, p: string, body: Record<string, unknown>, h?: Record<string, string>) =>
  j(await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: h ?? mcHdr(), body: JSON.stringify(body),
  }));
const j = async (r: Response) => ({ status: r.status, body: await r.json() as never });

describe("HTTP — /api/conversations/read-grants", () => {
  it("admin credential mints and reads grants; the mint lives inside the admin boundary", async () => {
    const s = httpFresh("http-admin");
    const port = await serve(s);
    const mint = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
      idempotency_key: "h1",
    }, admHdr());
    expect(mint.status).toBe(200);
    const grant = (mint.body as { grant: ConvReadGrantRow }).grant;
    expect(grant.granted_by).toBe("admin");
    // Replay through the same key → same row.
    const replay = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: grant.expires_at,
      idempotency_key: "h1",
    }, admHdr());
    expect(replay.status).toBe(200);
    expect((replay.body as { grant: ConvReadGrantRow; replayed: boolean }).replayed).toBe(true);
    // Status: admin sees the grant — both the list and the BY-ID route
    // (the by-id GET must sit inside the admin boundary too).
    const st = await get(port, "/api/conversations/read-grants", admHdr());
    expect((st.body as { grants: ConvReadGrantRow[] }).grants).toHaveLength(1);
    const byId = await get(port, `/api/conversations/read-grants/${grant.grant_id}`, admHdr());
    expect(byId.status).toBe(200);
    expect((byId.body as { grants: ConvReadGrantRow[] }).grants[0]!.grant_id).toBe(grant.grant_id);
  });

  it("owner claim mints its own provable scope; foreign scope and foreign operator_ref → 403", async () => {
    const s = httpFresh("http-owner");
    const port = await serve(s);
    // Own objective → minted.
    const ok = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
    });
    expect(ok.status).toBe(200);
    const g = (ok.body as { grant: ConvReadGrantRow }).grant;
    expect(g.granted_by).toBe(OP_REF);
    // Foreign objective → 403, no detail (identity internals must not leak).
    const foreign = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_B"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
    });
    expect(foreign.status).toBe(403);
    expect((foreign.body as { error: string; detail?: string }).error)
      .toBe("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY");
    expect((foreign.body as { detail?: string }).detail).toBeUndefined();
    // Vouching another owner's ref → 403.
    const foreignRef = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: FOREIGN_REF,
      scope: { objective_ids: [], business_ids: [], own_footprint: true },
      expires_at: Date.now() + 60_000,
    });
    expect(foreignRef.status).toBe(403);
    // Missing operator header on the operator lane → fail closed.
    const noHdr = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
    }, mcHdr({ "x-operator-id": "" }));
    expect(noHdr.status).toBe(403);
    expect((noHdr.body as { error: string }).error).toBe("FAIL_CLOSED_OPERATOR_ID_REQUIRED");
  });

  it("control closes the grant; a foreign operator claim cannot close it; status visibility is scoped", async () => {
    const s = httpFresh("http-control");
    const port = await serve(s);
    const mint = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
    });
    const g = (mint.body as { grant: ConvReadGrantRow }).grant;
    // Foreign operator cannot close alice's grant.
    const foreign = await post(port, `/api/conversations/read-grants/${g.grant_id}/revoke`, {},
      mcHdr({ "x-operator-id": FOREIGN }));
    expect(foreign.status).toBe(403);
    // bob also cannot enumerate alice's grants.
    const otherStatus = await get(port, "/api/conversations/read-grants",
      mcHdr({ "x-operator-id": FOREIGN }));
    expect((otherStatus.body as { grants: ConvReadGrantRow[] }).grants).toHaveLength(0);
    // alice sees her own grants.
    const ownStatus = await get(port, "/api/conversations/read-grants");
    expect((ownStatus.body as { grants: ConvReadGrantRow[] }).grants).toHaveLength(1);
    // Owner closes it; replay is idempotent; the grant stops vouching.
    const close = await post(port, `/api/conversations/read-grants/${g.grant_id}/revoke`, {});
    expect(close.status).toBe(200);
    expect((close.body as { grant: ConvReadGrantRow }).grant.state).toBe("REVOKED");
    expect(s.grants.scopeForPrincipal(TG)).toBeNull();
  });

  it("no credentials → 401 on the mint route (general MC gate still applies)", async () => {
    const s = httpFresh("http-anon");
    const port = await serve(s);
    const r = await post(port, "/api/conversations/read-grants", {
      principal_ref: TG, operator_ref: OP_REF,
      scope: { objective_ids: ["OBJ_A"], business_ids: [], own_footprint: false },
      expires_at: Date.now() + 60_000,
    }, { "content-type": "application/json" });
    expect(r.status).toBe(401);
  });
});
