/**
 * conversation-read-grant.ts — P16-D: canonical VERIFIED READ GRANTS for the
 * governed operational-status chat surface.
 *
 * The boundary problem this closes: `ConversationPrincipal` minted at the
 * request boundary is verified only for `admin` (the separate operational-
 * status credential). `operator` (`x-operator-id` claim) and `telegram`
 * (chat-id equality) are CLAIMS — `OperationalQueryService` correctly denies
 * every scoped section `UNVERIFIED_IDENTITY` for them. This service mints the
 * explicit, canonical authority those claims lack: a `conversation_read_grant`
 * row binds a channel principal to a DECLARED scope — specific objective ids,
 * specific business ids, and/or the vouching owner's own footprint — with an
 * expiry, a revocable/disableable lifecycle, a digest pin, and event anchors.
 *
 * Mint lanes (both are the codebase's existing authority model, nothing new):
 *   - "admin"    — the admin credential minted at the HTTP boundary. Its scope
 *                  IS conversation-status authority, so it may delegate reads.
 *   - "operator" — an `operator:<id>` claim (x-operator-id) — the same claim
 *                  authority the vnext API already accepts for owner actions
 *                  (amend/progress/evidence). An owner claim may vouch ONLY
 *                  scope it can canonically prove: objectives it owns
 *                  (owner_authority_id) and businesses it created
 *                  (BUSINESS_CREATED actor) — or its own_footprint. It can
 *                  never vouch a foreign objective/business, never vouch a
 *                  foreign operator_ref, and never mint anything beyond READ
 *                  authority on canonical rows.
 *
 * What a grant is NOT: it is not sender authentication (a `telegram:<chat>`
 * grant vouches the channel identity claimed at that boundary — never who
 * typed; the effective audience is "any MC-token holder who can present
 * that chat id", exactly the claim contract the telegram ingress uses),
 * it is not admin (grants only ever produce the scoped sections),
 * and it is not a write (the read path stays no-mutation; revocation is the
 * escape hatch and reads carry zero write authority).
 *
 * Enforcement: `OperationalQueryService` resolves `scopeForPrincipal` —
 * ENABLED + unexpired grants whose `principal_ref` matches the minted
 * principal — into the same `OperatorScope` `scopeFor` produces. Tampered
 * rows fail strict re-proof and are skipped (fail closed, never serve).
 */

import { newId, utcnow, digest } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import { IntegrityError } from "./errors.js";

export const CONV_READ_GRANT_ENTITY = "conversation_read_grant";
export const CONV_READ_GRANT_SCHEMA = "pair.os.vnext.conversation-read-grant.v1";

export const CONV_READ_GRANTED_EVENT = "CONVERSATION_READ_GRANTED";
export const CONV_READ_GRANT_DISABLED_EVENT = "CONVERSATION_READ_GRANT_DISABLED";
export const CONV_READ_GRANT_REVOKED_EVENT = "CONVERSATION_READ_GRANT_REVOKED";

export type ConvReadGrantState = "ENABLED" | "DISABLED" | "REVOKED";

/** Upper bound on a grant's lifetime — delegated reads are time-boxed
 *  authority, never effectively-permanent. */
export const MAX_CONV_READ_GRANT_TTL_MS = 90 * 24 * 3600_000;

export interface ConvReadGrantScope {
  /** Explicit objective ids the principal may read (status envelope). */
  objective_ids: string[];
  /** Explicit business ids the principal may read. */
  business_ids: string[];
  /** The operator_ref's own canonical footprint (objectives it owns +
   *  businesses it created + missions it carries) — follows ownership
   *  over time rather than a fixed id list. */
  own_footprint: boolean;
}

export interface ConvReadGrantRow extends Record<string, unknown> {
  grant_id: string;
  schema: string;
  /** The channel principal the grant vouches — the canonical form of the
   *  minted principal: `telegram:<chat_id>` or `operator:<id>`. */
  principal_ref: string;
  /** The canonical owner whose readable scope is vouched — `operator:<id>`.
   *  For own_footprint grants this is the footprint owner; for declared-scope
   *  grants it is recorded for audit even when the admin lane minted it. */
  operator_ref: string;
  scope: ConvReadGrantScope;
  state: ConvReadGrantState;
  /** Epoch ms after which the grant no longer vouches. */
  expires_at: number;
  /** `"admin"` (admin credential) or `operator:<id>` (owner claim). */
  granted_by: string;
  granted_at: string;
  grant_digest: string;
  dedup_key: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  version: number;
}

export interface ConvReadGrantDeps {
  store: PairEvidenceStore;
  now?: () => number;
}

const PRINCIPAL_RE = /^(operator|telegram):[^\s:]+$/;

export function isConvReadPrincipalRef(value: unknown): value is string {
  return typeof value === "string" && PRINCIPAL_RE.test(value);
}

export function isOperatorRef(value: unknown): value is string {
  return typeof value === "string" && /^operator:[^\s:]+$/.test(value);
}

/** The canonical content the digest pins — INCLUDING lifecycle state and
 *  the dedup key, so an in-place row mutation (e.g. flipping REVOKED back
 *  to ENABLED, or rewriting dedup_key to replay under a second identity)
 *  invalidates the pinned digest instead of passing re-proof silently.
 *  Scope is normalized (sorted, deduped) so equivalent vouches digest
 *  identically. */
export function convReadGrantDigest(row: {
  grant_id: string;
  principal_ref: string;
  operator_ref: string;
  scope: ConvReadGrantScope;
  state: string;
  expires_at: number;
  granted_by: string;
  dedup_key: string | null;
}): string {
  return digest({
    schema: CONV_READ_GRANT_SCHEMA,
    grant_id: row.grant_id,
    principal_ref: row.principal_ref,
    operator_ref: row.operator_ref,
    scope: {
      objective_ids: [...new Set(row.scope.objective_ids)].sort(),
      business_ids: [...new Set(row.scope.business_ids)].sort(),
      own_footprint: row.scope.own_footprint,
    },
    state: row.state,
    expires_at: row.expires_at,
    granted_by: row.granted_by,
    dedup_key: row.dedup_key,
  });
}

export function assertConvReadGrantRow(row: ConvReadGrantRow): asserts row is ConvReadGrantRow {
  const fail = (field: string): never => {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", field);
  };
  if (row == null || typeof row !== "object") fail("row");
  if (row.schema !== CONV_READ_GRANT_SCHEMA) fail("schema");
  if (typeof row.grant_id !== "string" || !row.grant_id) fail("grant_id");
  if (!isConvReadPrincipalRef(row.principal_ref)) fail("principal_ref");
  if (!isOperatorRef(row.operator_ref)) fail("operator_ref");
  const s = row.scope;
  if (
    s == null || typeof s !== "object" ||
    !Array.isArray(s.objective_ids) || !s.objective_ids.every((x) => typeof x === "string" && x) ||
    !Array.isArray(s.business_ids) || !s.business_ids.every((x) => typeof x === "string" && x) ||
    typeof s.own_footprint !== "boolean"
  ) fail("scope");
  if (row.state !== "ENABLED" && row.state !== "DISABLED" && row.state !== "REVOKED") fail("state");
  if (typeof row.expires_at !== "number" || !Number.isFinite(row.expires_at)) fail("expires_at");
  if (typeof row.granted_by !== "string" || !row.granted_by) fail("granted_by");
  if (typeof row.granted_at !== "string" || !row.granted_at) fail("granted_at");
  if (typeof row.grant_digest !== "string" || !row.grant_digest) fail("grant_digest");
  if (row.grant_digest !== convReadGrantDigest(row)) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_DIGEST", row.grant_id);
  }
}

export interface ConvReadGrantInput {
  /** Minting authority — `"admin"` (the operational-status admin
   *  credential minted at the HTTP boundary) or the canonical
   *  `operator:<id>` the owner claim resolved to. */
  actor: string;
  actor_kind: "admin" | "operator";
  principal_ref: string;
  operator_ref: string;
  scope: ConvReadGrantScope;
  /** Epoch ms — must be strictly in the future. */
  expires_at: number;
  idempotency_key?: string | null;
  granted_at?: string;
}

export interface ConvReadGrantControlInput {
  actor: string;
  actor_kind: "admin" | "operator";
  action: "disable" | "revoke";
  idempotency_key?: string | null;
}

/** The scope a set of grants vouches — consumed by OperationalQueryService
 *  to build the same OperatorScope scopeFor produces. */
export interface ConvReadGrantEffectiveScope {
  grant_ids: string[];
  /** operator_refs whose own footprint is vouched (own_footprint grants). */
  operator_refs: string[];
  objective_ids: string[];
  business_ids: string[];
}

export class ConversationReadGrantService {
  private readonly store: PairEvidenceStore;
  private readonly now: () => number;

  constructor(deps: ConvReadGrantDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  private rows(): ConvReadGrantRow[] {
    return this.store.list<ConvReadGrantRow>(CONV_READ_GRANT_ENTITY);
  }

  /** Strict rows only — a tampered/forged grant fails closed on ANY path.
   *  Beyond digest re-proof this also skips the RESURRECTION signature:
   *  an ENABLED row whose grant_id already carries a DISABLED/REVOKED
   *  event (the row was closed then flipped back in place — the state
   *  field is digest-pinned, but a store-level rewrite could recompute it;
   *  the append-only event chain still exposes the close). */
  private validRows(): ConvReadGrantRow[] {
    const closed = new Set<string>();
    for (const ev of this.store.listEvents(CONV_READ_GRANT_ENTITY)) {
      if (
        String(ev.event_type) === CONV_READ_GRANT_DISABLED_EVENT ||
        String(ev.event_type) === CONV_READ_GRANT_REVOKED_EVENT
      ) {
        closed.add(String(ev.entity_id));
      }
    }
    return this.rows().filter((r) => {
      try { assertConvReadGrantRow(r); return true; }
      catch { return false; }
    }).filter((r) => !(r.state === "ENABLED" && closed.has(r.grant_id)));
  }

  /** The objectives/businesses the claimed owner ref can canonically prove —
   *  the SAME derivation scopeFor uses (owner_authority_id objectives +
   *  their business_ids + BUSINESS_CREATED actor). An owner-claim mint may
   *  never vouch beyond this set. */
  provableScope(actorRef: string): { objective_ids: Set<string>; business_ids: Set<string> } {
    const objective_ids = new Set<string>();
    const business_ids = new Set<string>();
    for (const o of this.store.list("objective")) {
      if (String(o.owner_authority_id ?? "") === actorRef) {
        objective_ids.add(String(o.objective_id));
        business_ids.add(String(o.business_id));
      }
    }
    for (const ev of this.store.listEvents("business")) {
      if (String(ev.event_type) === "BUSINESS_CREATED" && String(ev.actor ?? "") === actorRef) {
        business_ids.add(String(ev.entity_id));
      }
    }
    return { objective_ids, business_ids };
  }

  /** Mint a verified read grant. Owner claims may vouch only scope they can
   *  canonically prove and only their own operator_ref; admin may vouch any
   *  declared scope. Idempotent: the same dedup_key with identical semantics
   *  replays to the stored row; identical key with different semantics
   *  fails closed. */
  grant(input: ConvReadGrantInput): { grant: ConvReadGrantRow; replayed: boolean } {
    const actor = assertActor(input.actor, input.actor_kind);
    const scope = normalizeScope(input.scope);
    if (!scope.own_footprint && scope.objective_ids.length === 0 && scope.business_ids.length === 0) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCOPE_EMPTY", "scope");
    }
    if (
      typeof input.expires_at !== "number" || !Number.isFinite(input.expires_at) ||
      input.expires_at <= this.now() ||
      input.expires_at > this.now() + MAX_CONV_READ_GRANT_TTL_MS
    ) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_EXPIRY", String(input.expires_at));
    }
    if (!isConvReadPrincipalRef(input.principal_ref)) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", "principal_ref");
    }
    if (!isOperatorRef(input.operator_ref)) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", "operator_ref");
    }

    if (input.actor_kind === "operator") {
      // The owner claim may only vouch itself — never a foreign owner ref —
      // and only scope it can canonically prove ownership over. A claim that
      // cannot prove ownership vouches nothing (fail closed). This runs
      // BEFORE the dedup replay below so a foreign claim can never use an
      // existing dedup_key as an existence/metadata oracle.
      if (actor !== input.operator_ref) {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY", input.operator_ref);
      }
      const provable = this.provableScope(actor);
      for (const oid of scope.objective_ids) {
        if (!provable.objective_ids.has(oid)) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY", oid);
        }
      }
      for (const bid of scope.business_ids) {
        if (!provable.business_ids.has(bid)) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY", bid);
        }
      }
    }

    const dedup = input.idempotency_key ?? null;
    if (dedup !== null) {
      const prior = this.validRows().find((g) => g.dedup_key === dedup);
      if (prior) {
        if (
          prior.principal_ref === input.principal_ref &&
          prior.operator_ref === input.operator_ref &&
          sameScope(prior.scope, scope) &&
          prior.expires_at === input.expires_at
        ) {
          return { grant: prior, replayed: true };
        }
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_IDEMPOTENT_MISMATCH", dedup);
      }
    }

    const grantId = newId("cgr");
    return this.store.immediate(() => {
      const row: ConvReadGrantRow = {
        grant_id: grantId,
        schema: CONV_READ_GRANT_SCHEMA,
        principal_ref: input.principal_ref,
        operator_ref: input.operator_ref,
        scope,
        state: "ENABLED",
        expires_at: input.expires_at,
        granted_by: actor,
        granted_at: input.granted_at ?? utcnow(),
        grant_digest: "",
        dedup_key: dedup,
        disabled_at: null,
        disabled_by: null,
        revoked_at: null,
        revoked_by: null,
        version: 0,
      };
      row.grant_digest = convReadGrantDigest(row);
      const saved = this.store.put(CONV_READ_GRANT_ENTITY, grantId, row, 0) as unknown as ConvReadGrantRow;
      this.store.event({
        entity_type: CONV_READ_GRANT_ENTITY,
        entity_id: grantId,
        event_type: CONV_READ_GRANTED_EVENT,
        actor,
        metadata: {
          grant_id: grantId,
          grant_digest: row.grant_digest,
          principal_ref: row.principal_ref,
          operator_ref: row.operator_ref,
          scope: row.scope,
          expires_at: row.expires_at,
          granted_by: actor,
        },
      });
      return { grant: saved, replayed: false };
    });
  }

  /** Permanently close a grant — DISABLED or REVOKED, both terminal (a new
   *  grant row is required to re-vouch). Authority: admin always; an
   *  operator claim may close only grants it minted or that vouch its own
   *  operator_ref. Idempotent — closing an already-closed row replays. */
  control(grantId: string, input: ConvReadGrantControlInput): { grant: ConvReadGrantRow; replayed: boolean } {
    const actor = assertActor(input.actor, input.actor_kind);
    const row = this.validRows().find((g) => g.grant_id === grantId);
    if (!row) throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_NOT_FOUND", grantId);
    if (input.actor_kind === "operator" && actor !== row.granted_by && actor !== row.operator_ref) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY", grantId);
    }
    if (row.state !== "ENABLED") {
      return { grant: row, replayed: true };
    }
    const state = input.action === "disable" ? "DISABLED" : "REVOKED";
    const eventType = input.action === "disable" ? CONV_READ_GRANT_DISABLED_EVENT : CONV_READ_GRANT_REVOKED_EVENT;
    const atField = input.action === "disable" ? "disabled_at" : "revoked_at";
    const byField = input.action === "disable" ? "disabled_by" : "revoked_by";
    return this.store.immediate(() => {
      const next: ConvReadGrantRow = {
        ...row,
        state,
        [atField]: utcnow(),
        [byField]: actor,
      } as ConvReadGrantRow;
      // Lifecycle is digest-pinned — the close re-pins so a later in-place
      // flip back to ENABLED invalidates re-proof (and the event chain
      // independently exposes the resurrection signature in validRows).
      next.grant_digest = convReadGrantDigest(next);
      const saved = this.store.put(CONV_READ_GRANT_ENTITY, grantId, next) as unknown as ConvReadGrantRow;
      this.store.event({
        entity_type: CONV_READ_GRANT_ENTITY,
        entity_id: grantId,
        event_type: eventType,
        actor,
        new_state: state,
        metadata: {
          grant_id: grantId,
          grant_digest: next.grant_digest,
          prior_digest: row.grant_digest,
          action: input.action,
        },
      });
      return { grant: saved, replayed: false };
    });
  }

  /** Read-only status — no lazy expiry write (reads never mutate);
   *  `expired_pending` flags an ENABLED grant past its expires_at. */
  status(input: { grant_id?: string; principal_ref?: string }): Array<ConvReadGrantRow & { expired_pending: boolean }> {
    const now = this.now();
    return this.validRows()
      .filter((g) => (input.grant_id !== undefined ? g.grant_id === input.grant_id : true))
      .filter((g) => (input.principal_ref !== undefined ? g.principal_ref === input.principal_ref : true))
      .map((g) => ({ ...g, expired_pending: g.state === "ENABLED" && g.expires_at <= now }));
  }

  /** The effective scope a minted principal carries — the union of every
   *  ENABLED + unexpired grant matching `principal_ref`. Returns null when
   *  nothing vouches the principal (the caller stays UNVERIFIED_IDENTITY).
   *  Tampered rows are skipped by strict re-proof — a forged grant can never
   *  vouch; if every row for the principal is forged the result is null. */
  scopeForPrincipal(principal_ref: string): ConvReadGrantEffectiveScope | null {
    const now = this.now();
    const grants = this.validRows().filter(
      (g) => g.principal_ref === principal_ref && g.state === "ENABLED" && g.expires_at > now,
    );
    if (grants.length === 0) return null;
    const objective_ids = new Set<string>();
    const business_ids = new Set<string>();
    const operator_refs = new Set<string>();
    for (const g of grants) {
      for (const oid of g.scope.objective_ids) objective_ids.add(oid);
      for (const bid of g.scope.business_ids) business_ids.add(bid);
      if (g.scope.own_footprint) operator_refs.add(g.operator_ref);
    }
    return {
      grant_ids: grants.map((g) => g.grant_id).sort(),
      operator_refs: [...operator_refs].sort(),
      objective_ids: [...objective_ids].sort(),
      business_ids: [...business_ids].sort(),
    };
  }
}

function assertActor(actor: string, kind: "admin" | "operator"): string {
  if (kind === "admin") {
    if (actor !== "admin") {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", "actor");
    }
    return actor;
  }
  if (!isOperatorRef(actor)) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", "actor");
  }
  return actor;
}

function normalizeScope(scope: ConvReadGrantScope): ConvReadGrantScope {
  const fail = (): never => {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_READ_GRANT_SCHEMA", "scope");
  };
  if (scope == null || typeof scope !== "object") fail();
  const ids = (v: unknown): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail();
    const arr = v as unknown[];
    return [...new Set(arr.map((x) => String(x)).filter(Boolean))].sort();
  };
  return {
    objective_ids: ids(scope.objective_ids),
    business_ids: ids(scope.business_ids),
    own_footprint: scope.own_footprint === true,
  };
}

function sameScope(a: ConvReadGrantScope, b: ConvReadGrantScope): boolean {
  return (
    a.own_footprint === b.own_footprint &&
    JSON.stringify([...new Set(a.objective_ids)].sort()) === JSON.stringify(b.objective_ids) &&
    JSON.stringify([...new Set(a.business_ids)].sort()) === JSON.stringify(b.business_ids)
  );
}
