/**
 * objective-relation.ts — P18-A: canonical relations BETWEEN objectives
 * in one business — the coordination layer's atomic fact.
 *
 * Until now every objective was an island: work-graph dependency edges
 * may already span objectives inside a business (business.ts only
 * checks business_id equality), but nothing canonical DECLARES that
 * two objectives are related. `objective_relation` is that declaration
 * — the substrate portfolio (P18-B), parallel gating (P18-C), handoff
 * (P18-D), duties (P18-E) and recovery (P18-F) all consume.
 *
 *   kind ∈ DEPENDS_ON  — `from` depends on `to` (upstream): later seams
 *                        gate `from`'s work admission on `to`'s proof.
 *          CONFLICTS   — the two objectives contend (shared resource /
 *                        strategy); later seams serialize them.
 *          SUPERSEDES  — `from` replaces `to` (supersession lineage).
 *
 *   state: ACTIVE → SUSPENDED ⇄ ACTIVE → REVOKED (terminal).
 *
 * Authority: the actor is minted as `operator:<ref>` and must equal the
 * owner_authority_id of BOTH objectives — a relation is a bilateral
 * claim and one side's owner may not impose it unilaterally.
 * Objectives with different owners fail closed (bilateral consent is
 * deferred, not silently bypassed). Everything else is derived, never
 * asserted: business_id comes from the canonical objectives (a
 * cross-business pair can never mint), DEPENDS_ON acyclicity is proven
 * against the live relation graph at mint AND at every resume.
 *
 * Integrity: digest pins every canonical field (updated_at excluded),
 * OCC on the entities-table version column, lifecycle event anchors
 * pin state transitions. Reads re-prove exactly like writes — a
 * digest-recomputed state flip, a foreign pairing, or an event-less
 * forge is never served (P16-E re-proof pattern).
 *
 * What a relation is NOT (P18-A boundary): minting one changes nothing
 * executable by itself — no admission gate, no scheduling effect, no
 * UI. It is canonical metadata that later seams consume; until then it
 * is inert, owner-visible, and fully reversible.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { assertOwnerAuthorityRef } from "./objective-authority.js";
import type { PairEvidenceStore } from "./store.js";

export const OBJECTIVE_RELATION_ENTITY = "objective_relation";
export const OBJECTIVE_RELATION_SCHEMA = "pair.os.vnext.objective-relation.v1";

export const RELATION_CREATED_EVENT = "OBJECTIVE_RELATION_CREATED";
export const RELATION_STATE_EVENT = "OBJECTIVE_RELATION_STATE";

export const RELATION_KINDS = new Set([
  "DEPENDS_ON",
  "CONFLICTS",
  "SUPERSEDES",
] as const);
export type RelationKind = typeof RELATION_KINDS extends Set<infer T> ? T : never;

export type RelationState = "ACTIVE" | "SUSPENDED" | "REVOKED";

/** DEPENDS_ON cycle walk bound — a business's objective graph is small;
 *  deeper chains are malformed, not long. */
const CYCLE_DEPTH_CAP = 128;
const NOTE_CAP = 512;

export interface ObjectiveRelationRow extends Record<string, unknown> {
  relation_id: string;
  schema: string;
  business_id: string;
  /** DEPENDS_ON: downstream (depends on `to`). */
  from_objective_id: string;
  /** DEPENDS_ON: upstream. */
  to_objective_id: string;
  kind: RelationKind;
  state: RelationState;
  note: string | null;
  created_by: string;
  dedup_key: string;
  created_at: string;
  updated_at: string;
  relation_digest: string;
}

type Row = Record<string, unknown>;

function fail(code: string, detail: string): never {
  throw new IntegrityError(code, detail);
}

export function relationDigest(r: Record<string, unknown>): string {
  return digest({
    schema: r.schema,
    relation_id: r.relation_id,
    business_id: r.business_id,
    from_objective_id: r.from_objective_id,
    to_objective_id: r.to_objective_id,
    kind: r.kind,
    state: r.state,
    note: r.note ?? null,
    created_by: r.created_by,
    dedup_key: r.dedup_key,
    created_at: r.created_at,
  });
}

export class ObjectiveRelationService {
  constructor(private readonly store: PairEvidenceStore) {}

  private objective(id: string): Row {
    const row = this.store.tryGet("objective", id) as Row | null;
    if (!row) {
      fail("FAIL_CLOSED_RELATION_OBJECTIVE", `objective ${id} does not resolve`);
    }
    return row;
  }

  /** Row must be digest-valid AND identity-consistent — a raw-forged
   *  payload that re-computed its own digest still fails the entity
   *  binding (relation_id/business consistency are digest-pinned, and
   *  the objectives must still resolve to the pinned business). */
  private provenRow(row: Row): ObjectiveRelationRow | null {
    if (String(row.schema) !== OBJECTIVE_RELATION_SCHEMA) return null;
    if (!RELATION_KINDS.has(row.kind as never)) return null;
    const state = String(row.state);
    if (state !== "ACTIVE" && state !== "SUSPENDED" && state !== "REVOKED") return null;
    if (String(row.relation_digest) !== relationDigest(row)) return null;
    // Re-prove the scope claim — a forged business pairing never serves.
    try {
      const from = this.objective(String(row.from_objective_id));
      const to = this.objective(String(row.to_objective_id));
      if (String(from.business_id) !== String(row.business_id)) return null;
      if (String(to.business_id) !== String(row.business_id)) return null;
    } catch {
      return null;
    }
    // Newest lifecycle event must agree with the row's state — an
    // event-less forge or a state flip without its anchor is unproven.
    const events = this.store.listEvents(
      OBJECTIVE_RELATION_ENTITY, String(row.relation_id));
    const last = events[events.length - 1] as Row | undefined;
    if (!last) return null;
    if (last.event_type === RELATION_CREATED_EVENT) {
      if (state !== "ACTIVE") return null;
    } else if (last.event_type === RELATION_STATE_EVENT) {
      if (String(last.new_state ?? "") !== state) return null;
    } else {
      return null;
    }
    return row as ObjectiveRelationRow;
  }

  private allProven(): ObjectiveRelationRow[] {
    const out: ObjectiveRelationRow[] = [];
    for (const row of this.store.list(OBJECTIVE_RELATION_ENTITY) as Row[]) {
      const proven = this.provenRow(row);
      if (proven) out.push(proven);
    }
    return out;
  }

  /** DEPENDS_ON acyclicity over non-REVOKED relations (a SUSPENDED edge
   *  stays in the graph — reviving it must not reopen a cycle). */
  private assertAcyclic(
    businessId: string, fromId: string, toId: string,
  ): void {
    const edges = this.allProven().filter(
      (r) => r.business_id === businessId &&
        r.kind === "DEPENDS_ON" && r.state !== "REVOKED");
    // Walk upstream from `to`: if `from` is reachable, adding
    // from→to closes a cycle.
    const seen = new Set<string>();
    const stack = [toId];
    let hops = 0;
    while (stack.length) {
      if (++hops > CYCLE_DEPTH_CAP) {
        fail("FAIL_CLOSED_RELATION_CYCLE", `dependency walk exceeded ${CYCLE_DEPTH_CAP}`);
      }
      const cur = stack.pop()!;
      if (cur === fromId) {
        fail("FAIL_CLOSED_RELATION_CYCLE",
          `${fromId} DEPENDS_ON ${toId} closes a cycle`);
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of edges) {
        if (e.from_objective_id === cur) stack.push(e.to_objective_id);
      }
    }
  }

  /** Mint a relation. Idempotent per (from,to,kind): an existing
   *  non-terminal relation with the same triple returns itself —
   *  a replayed mint is a semantic no-op, never a duplicate. */
  create(input: {
    from_objective_id: string;
    to_objective_id: string;
    kind: string;
    actor: string;
    note?: string | null;
    dedup_key?: string;
  }): ObjectiveRelationRow {
    const kind = String(input.kind ?? "");
    if (!RELATION_KINDS.has(kind as never)) {
      fail("FAIL_CLOSED_RELATION_KIND", `unknown kind ${kind}`);
    }
    const actor = assertOwnerAuthorityRef("actor", input.actor);
    const fromId = String(input.from_objective_id ?? "");
    const toId = String(input.to_objective_id ?? "");
    if (!fromId || !toId) {
      fail("FAIL_CLOSED_RELATION_FIELDS", "from/to objective ids required");
    }
    if (fromId === toId) {
      fail("FAIL_CLOSED_RELATION_FIELDS", "self-relation is meaningless");
    }
    const from = this.objective(fromId);
    const to = this.objective(toId);
    const businessId = String(from.business_id ?? "");
    if (String(to.business_id ?? "") !== businessId || !businessId) {
      fail("FAIL_CLOSED_RELATION_BUSINESS",
        "relations live inside one business — cross-business pairing");
    }
    // Bilateral authority: the actor must own BOTH endpoints. Two
    // different owners means consent is needed from both — deferred,
    // not silently bypassed.
    const fromOwner = String(from.owner_authority_id ?? "");
    const toOwner = String(to.owner_authority_id ?? "");
    if (actor !== fromOwner || actor !== toOwner) {
      fail("FAIL_CLOSED_RELATION_AUTHORITY",
        "actor must be the owner_authority_id of both objectives");
    }
    if (kind === "DEPENDS_ON") this.assertAcyclic(businessId, fromId, toId);

    // Idempotent replay — checked AFTER authority so a replay can't
    // oraclescope the relation's existence to a foreign owner.
    const existing = this.allProven().find(
      (r) => r.from_objective_id === fromId &&
        r.to_objective_id === toId && r.kind === kind &&
        r.state !== "REVOKED");
    if (existing) return existing;

    const now = utcnow();
    const row: ObjectiveRelationRow = {
      relation_id: newId("REL"),
      schema: OBJECTIVE_RELATION_SCHEMA,
      business_id: businessId,
      from_objective_id: fromId,
      to_objective_id: toId,
      kind: kind as RelationKind,
      state: "ACTIVE",
      note: input.note != null ? String(input.note).slice(0, NOTE_CAP) : null,
      created_by: actor,
      dedup_key: input.dedup_key ?? digest({ fromId, toId, kind }),
      created_at: now,
      updated_at: now,
      relation_digest: "",
    };
    row.relation_digest = relationDigest(row);
    this.store.put(OBJECTIVE_RELATION_ENTITY, row.relation_id, { ...row }, 0);
    this.store.event({
      entity_type: OBJECTIVE_RELATION_ENTITY,
      entity_id: row.relation_id,
      event_type: RELATION_CREATED_EVENT,
      new_state: "ACTIVE",
      actor,
      metadata: {
        business_id: businessId,
        from_objective_id: fromId,
        to_objective_id: toId,
        kind,
      },
    });
    return row;
  }

  /** Lifecycle: SUSPEND | RESUME | REVOKE — owner-of-both authority,
   *  CAS under the column version, state transition journaled. */
  control(input: {
    relation_id: string;
    action: "SUSPEND" | "RESUME" | "REVOKE";
    actor: string;
  }): ObjectiveRelationRow {
    const actor = assertOwnerAuthorityRef("actor", input.actor);
    const stored = this.store.tryGet(
      OBJECTIVE_RELATION_ENTITY, String(input.relation_id)) as Row | null;
    if (!stored) {
      fail("FAIL_CLOSED_RELATION_NOT_FOUND", String(input.relation_id));
    }
    const row = this.provenRow(stored);
    if (!row) {
      fail("FAIL_CLOSED_RELATION_TAMPERED", String(input.relation_id));
    }
    const from = this.objective(row.from_objective_id);
    const to = this.objective(row.to_objective_id);
    if (actor !== String(from.owner_authority_id) ||
        actor !== String(to.owner_authority_id)) {
      fail("FAIL_CLOSED_RELATION_AUTHORITY",
        "actor must be the owner_authority_id of both objectives");
    }
    const action = input.action;
    const next: Record<typeof action, RelationState | null> = {
      SUSPEND: row.state === "ACTIVE" ? "SUSPENDED" : null,
      RESUME: row.state === "SUSPENDED" ? "ACTIVE" : null,
      REVOKE: row.state !== "REVOKED" ? "REVOKED" : null,
    };
    const target = next[action];
    if (action === "REVOKE" && row.state === "REVOKED") return row; // terminal idempotent
    if (target === null) {
      fail("FAIL_CLOSED_RELATION_STATE",
        `${action} not legal from ${row.state}`);
    }
    if (action === "RESUME" && row.kind === "DEPENDS_ON") {
      // Re-activation re-proves acyclicity — a graph that changed
      // under SUSPENDED must not silently revive into a cycle.
      this.assertAcyclic(row.business_id, row.from_objective_id, row.to_objective_id);
    }
    const colVersion = Number(
      (stored as { version?: unknown }).version ?? NaN);
    if (!Number.isInteger(colVersion) || colVersion < 1) {
      fail("FAIL_CLOSED_RELATION_TAMPERED", "version column unmatchable");
    }
    const updated: ObjectiveRelationRow = {
      ...row,
      state: target,
      updated_at: utcnow(),
    };
    updated.relation_digest = relationDigest(updated);
    this.store.put(
      OBJECTIVE_RELATION_ENTITY, row.relation_id, { ...updated }, colVersion);
    this.store.event({
      entity_type: OBJECTIVE_RELATION_ENTITY,
      entity_id: row.relation_id,
      event_type: RELATION_STATE_EVENT,
      old_state: row.state,
      new_state: target,
      actor,
      metadata: { action },
    });
    return updated;
  }

  /** All proven relations where the objective is either endpoint. */
  relationsFor(objectiveId: string): ObjectiveRelationRow[] {
    return this.allProven()
      .filter((r) => r.from_objective_id === objectiveId ||
        r.to_objective_id === objectiveId)
      .sort((a, b) => String(a.relation_id).localeCompare(String(b.relation_id)));
  }

  /** All proven relations inside the business — the portfolio seam. */
  relationsForBusiness(businessId: string): ObjectiveRelationRow[] {
    return this.allProven()
      .filter((r) => r.business_id === businessId)
      .sort((a, b) => String(a.relation_id).localeCompare(String(b.relation_id)));
  }

  /** ACTIVE DEPENDS_ON upstream objectives of `objectiveId` — the
   *  seam P18-C admission gating consumes. Zero-write. */
  upstreamOf(objectiveId: string): string[] {
    return this.allProven()
      .filter((r) => r.kind === "DEPENDS_ON" && r.state === "ACTIVE" &&
        r.from_objective_id === objectiveId)
      .map((r) => String(r.to_objective_id))
      .sort();
  }

  /** ACTIVE CONFLICTS partners — the parallel seam's exclusion set. */
  conflictsWith(objectiveId: string): string[] {
    const out = new Set<string>();
    for (const r of this.allProven()) {
      if (r.kind !== "CONFLICTS" || r.state !== "ACTIVE") continue;
      if (r.from_objective_id === objectiveId) out.add(r.to_objective_id);
      if (r.to_objective_id === objectiveId) out.add(r.from_objective_id);
    }
    return [...out].sort();
  }
}
