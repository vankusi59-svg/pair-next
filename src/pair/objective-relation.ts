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
 * pin state transitions. Reads re-prove exactly like writes (P16-E
 * pattern): digest + storage-key↔payload entity binding + strict
 * objective resolution + bilateral-owner re-check + the FULL event
 * tail (first event must be CREATED with matching identity pins; every
 * STATE hop must be a legal transition chaining from the prior
 * new_state). A digest-recomputed flip, an anchor-borrowed clone, an
 * event-less forge, or a resurrected terminal row is never served.
 *
 * Known bounds (fail-closed, recoverable): amending an endpoint's
 * owner_authority_id invalidates every relation it touches — the
 * bilateral re-check is against CURRENT owners, so the relation
 * silently drops out of the proven set until re-minted under the new
 * owner. CYCLE_DEPTH_CAP bounds total walk WORK (edges visited), not
 * path depth — a pathological graph denser than the cap fails mints/
 * resumes closed rather than scanning forever. `dedup_key` is stored
 * and digest-pinned for audit but replay dedup is keyed on the
 * canonical (from,to,kind) triple — CONFLICTS dedups symmetrically.
 * Reads are O(relation rows + their event tails); a store read-budget
 * trip propagates loudly rather than truncating the proven set.
 * Deletion bound: DELETE of a relation row or its events, followed by
 * a verbatim restore after intervening mints, is bit-indistinguishable
 * from fabrication — it can admit a duplicate or a cycle a strict
 * wedge cannot safely prevent (wedging fabricated-looking rows would
 * let one plant freeze all mints). This lane is dominated by the
 * platform's no-MAC trust bound (digests verify integrity, they do
 * not authenticate the writer).
 *
 * What a relation is NOT (P18-A boundary): minting one changes nothing
 * executable by itself — no admission gate, no scheduling effect, no
 * UI. It is canonical metadata that later seams consume; until then it
 * is inert, owner-visible, and fully reversible.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError, PairError } from "./errors.js";
import {
  assertOwnerAuthorityRef,
  ObjectiveAuthorityService,
} from "./objective-authority.js";
import type { PairEvidenceStore } from "./store.js";

export const OBJECTIVE_RELATION_ENTITY = "objective_relation";
/** P18-C F1 — per-endpoint edge index so the admission gate costs
 *  O(degree), not O(global table). Key shape
 *  `${objectiveId}:${relationId}` — a colon-bounded prefix range
 *  enumerates exactly one objective's edge pointers. Each pointer is
 *  entity-hash-proven and names a relation that is still FULLY
 *  re-proven at read time — a forged pointer can only name a real
 *  canonical edge (gating on it is correct), never fabricate one. */
export const RELATION_INDEX_ENTITY = "objective_relation_index";
const RELATION_INDEX_STATE = "objective_relation_index_state";
/** Rebuild chunk per write call — resumable via the marker cursor so
 *  index migration converges over writes instead of demanding one
 *  giant enumeration inside the caller's proof budget. */
const INDEX_CHUNK = 64;
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
const DEDUP_KEY_CAP = 256;

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

/** Legal STATE hops — a hop outside this set is a forged transition
 *  (REVOKED is terminal: nothing may leave it). */
const RELATION_PAGE = 256;

/** Deterministic code-unit ordering — localeCompare output is
 *  environment-dependent, which would make canonical listings
 *  non-reproducible across machines. */
function byId(a: unknown, b: unknown): number {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const LEGAL_TRANSITIONS = new Set([
  "ACTIVE>SUSPENDED",
  "SUSPENDED>ACTIVE",
  "ACTIVE>REVOKED",
  "SUSPENDED>REVOKED",
]);

export class ObjectiveRelationService {
  private _objectives?: ObjectiveAuthorityService;
  constructor(private readonly store: PairEvidenceStore) {}

  private objective(id: string): Row {
    this._objectives ??= new ObjectiveAuthorityService(this.store);
    try {
      // Strict read — schema + objective_digest re-proof, not a bare
      // hash-consistent payload (a forged endpoint never validates).
      return this._objectives.get(id) as Row;
    } catch (e) {
      // Budget trips and endpoint CORRUPTION are not "unresolvable" —
      // a hash-mismatched objective row is tampering evidence the
      // caller's strict/lenient policy decides on, not a missing
      // endpoint. Only genuine resolution failures convert.
      if (e instanceof IntegrityError &&
          (e.code === "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT" ||
           e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH")) throw e;
      // Store/DB faults (SqliteError & co.) are loud, not "unresolvable".
      if (!(e instanceof PairError)) throw e;
      fail("FAIL_CLOSED_RELATION_OBJECTIVE", `objective ${id} does not resolve`);
    }
  }

  /** Fault taxonomy for provenRow: store/DB faults (non-IntegrityError)
   *  and budget trips are ALWAYS loud — a fault is not "unproven".
   *  Corruption codes (tampered row or event anchor) are loud on the
   *  strict write path — a corrupted-but-real relation excluded from
   *  dedup/acyclicity mints a duplicate or admits a cycle — while
   *  lenient reads treat it as unproven and serve siblings. */
  private rethrowFault(e: unknown, strict: boolean): void {
    if (!(e instanceof IntegrityError)) throw e;
    if (e.code === "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT") throw e;
    if (strict && (e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH" ||
                   e.code === "FAIL_CLOSED_EVENT_HASH_MISMATCH")) throw e;
  }

  /** Re-prove a stored row end-to-end — same bound P16-E established:
   *  the row must be digest-valid, storage-key↔payload identity-bound,
   *  strictly-resolved against current canonical objectives, owner-
   *  consistent with BOTH endpoints NOW, and its event tail must be a
   *  legal chain ending at the row's state. Anything else is unproven
   *  — skipped on reads, TAMPERED on control. */
  private provenRow(row: Row, strict = false): ObjectiveRelationRow | null {
    if (String(row.schema) !== OBJECTIVE_RELATION_SCHEMA) return null;
    if (!RELATION_KINDS.has(row.kind as never)) return null;
    const state = String(row.state);
    if (state !== "ACTIVE" && state !== "SUSPENDED" && state !== "REVOKED") return null;
    if (String(row.relation_digest) !== relationDigest(row)) return null;
    // Storage key must equal the payload's claimed relation_id — a
    // clone planted under a different key can never borrow the
    // victim's event anchors (put injects entity_id; the check is
    // exactly the entityPage binding for list()-enumerated rows).
    if (String(row.entity_id ?? "") !== String(row.relation_id)) return null;
    // Re-prove the scope claim AND bilateral authority against CURRENT
    // canonical state — a forged business pairing or a relation whose
    // consenting owner no longer owns both endpoints never serves.
    try {
      const from = this.objective(String(row.from_objective_id));
      const to = this.objective(String(row.to_objective_id));
      if (String(from.business_id) !== String(row.business_id)) return null;
      if (String(to.business_id) !== String(row.business_id)) return null;
      const createdBy = String(row.created_by ?? "");
      if (createdBy !== String(from.owner_authority_id)) return null;
      if (createdBy !== String(to.owner_authority_id)) return null;
    } catch (e) {
      this.rethrowFault(e, strict);
      return null;
    }
    // A self-relation can never be minted — a fabricated one is never
    // served either.
    if (String(row.from_objective_id) === String(row.to_objective_id)) return null;
    // Event tail must be a legal chain: CREATED first (with identity
    // pins matching the row), then STATE hops that are legal
    // transitions chaining from the prior new_state, ending at the
    // row's current state. A corrupt anchor fails THIS row closed —
    // it must not wedge unrelated relations.
    let events: Row[];
    try {
      events = this.store.listEvents(
        OBJECTIVE_RELATION_ENTITY, String(row.relation_id)) as Row[];
    } catch (e) {
      this.rethrowFault(e, strict);
      return null;
    }
    if (events.length === 0) return null;
    const first = events[0];
    if (first.event_type !== RELATION_CREATED_EVENT) return null;
    if (first.old_state != null) return null; // genesis has no prior
    if (String(first.new_state ?? "") !== "ACTIVE") return null;
    const meta = (first.metadata ?? null) as Row | null;
    if (!meta) return null;
    if (String(meta.business_id ?? "") !== String(row.business_id)) return null;
    if (String(meta.from_objective_id ?? "") !== String(row.from_objective_id)) return null;
    if (String(meta.to_objective_id ?? "") !== String(row.to_objective_id)) return null;
    if (String(meta.kind ?? "") !== String(row.kind)) return null;
    let prevState = "ACTIVE";
    for (let i = 1; i < events.length; i++) {
      const e = events[i];
      if (e.event_type !== RELATION_STATE_EVENT) return null;
      const hop = `${String(e.old_state ?? "")}>${String(e.new_state ?? "")}`;
      if (!LEGAL_TRANSITIONS.has(hop)) return null;
      if (String(e.old_state ?? "") !== prevState) return null;
      prevState = String(e.new_state ?? "");
    }
    if (prevState !== state) return null;
    return row as ObjectiveRelationRow;
  }

  /** Enumerate via entityPage — it binds payload.entity_id to the
   *  actual storage key (+ hash + version) before returning, which is
   *  the binding list()/tryGet() cannot provide: a raw-SQL clone under
   *  key K claiming another relation's identity is rejected by the
   *  page itself (thrown IntegrityError carries the key in .detail —
   *  resume past it; the row never enters the proven set). */
  /** strict=true (write paths): any corrupt row propagates — dedup
   *  and acyclicity must judge over the COMPLETE canonical set or
   *  fail loudly; silently excluding a corrupted-but-real relation
   *  would mint a duplicate or admit a cycle. strict=false (reads):
   *  a corrupt row fails only itself, siblings still serve. */
  private allProven(strict = false): ObjectiveRelationRow[] {
    const out: ObjectiveRelationRow[] = [];
    let after = "";
    let pageSize = RELATION_PAGE;
    for (;;) {
      let page: Row[];
      try {
        page = this.store.entityPage({
          entity_type: OBJECTIVE_RELATION_ENTITY, after_id: after,
          limit: pageSize,
        }) as Row[];
      } catch (e) {
        // Only a hash-mismatch carries the offending key in .detail —
        // anything else (read-budget trips, API misuse) must propagate:
        // silently treating it as "one bad row" would truncate the
        // proven set and defeat dedup/acyclicity upstream.
        if (!(e instanceof IntegrityError) ||
            e.code !== "FAIL_CLOSED_ENTITY_HASH_MISMATCH") throw e;
        if (strict) throw e;
        // A bad row kills its whole page — don't drop the legit rows
        // sharing it: shrink to single-row pages to isolate, then skip
        // the offender (its key is in err.detail; entityPage's own
        // `entity_id > ?` predicate guarantees forward progress for
        // TEXT keys, so no cross-collation comparison is needed). A
        // detail that doesn't advance the cursor means a non-TEXT key
        // (BLOBs sort after all TEXT, so the cursor can never pass) —
        // degrade to the same typed wedge strict mode produces rather
        // than spin forever.
        if (pageSize > 1) { pageSize = 1; continue; }
        const bad = String(e.detail ?? "");
        if (!bad || bad === after) throw e;
        after = bad;
        pageSize = RELATION_PAGE;
        continue;
      }
      if (page.length === 0) break;
      for (const row of page) {
        const proven = this.provenRow(row, strict);
        if (proven) out.push(proven);
      }
      if (page.length < pageSize) break;
      after = String(page[page.length - 1].entity_id);
      pageSize = RELATION_PAGE;
    }
    return out;
  }

  /** DEPENDS_ON acyclicity over non-REVOKED relations (a SUSPENDED edge
   *  stays in the graph — reviving it must not reopen a cycle). */
  private assertAcyclic(
    edges: ObjectiveRelationRow[], fromId: string, toId: string,
  ): void {
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
    // BEGIN IMMEDIATE: dedup/cycle reads and the row+event writes run
    // under the writer lock — a racing mint on another connection
    // serializes instead of passing a stale check (no wedge/orphan).
    return this.store.immediate(() => {
      // Migrate the edge index inside the same writer tx — a bounded
      // chunk per write, converging to authoritative over calls.
      this.ensureIndex();
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
      const proven = this.allProven(true);
      if (kind === "DEPENDS_ON") {
        const edges = proven.filter(
          (r) => r.business_id === businessId &&
            r.kind === "DEPENDS_ON" && r.state !== "REVOKED");
        this.assertAcyclic(edges, fromId, toId);
      }
      // Idempotent replay — checked AFTER authority so a replay can't
      // oracle the relation's existence to a foreign owner. CONFLICTS
      // is a symmetric fact: (B,A,CONFLICTS) IS (A,B,CONFLICTS) — the
      // reverse pair must converge to the same canonical row, never
      // mint a second.
      const existing = proven.find((r) => {
        if (r.kind !== kind || r.state === "REVOKED") return false;
        if (r.from_objective_id === fromId && r.to_objective_id === toId) return true;
        return kind === "CONFLICTS" &&
          r.from_objective_id === toId && r.to_objective_id === fromId;
      });
      if (existing) return existing;

      // dedup_key is audit metadata stored verbatim — validate shape
      // and bound it like `note` (no numbers, no unbounded blobs).
      let dedupKey: string;
      if (input.dedup_key != null) {
        if (typeof input.dedup_key !== "string" ||
            input.dedup_key.length === 0 ||
            [...input.dedup_key].length > DEDUP_KEY_CAP) {
          fail("FAIL_CLOSED_RELATION_FIELDS", "dedup_key");
        }
        dedupKey = input.dedup_key;
      } else {
        dedupKey = digest({ fromId, toId, kind });
      }

      const now = utcnow();
      const row: ObjectiveRelationRow = {
        relation_id: newId("REL"),
        schema: OBJECTIVE_RELATION_SCHEMA,
        business_id: businessId,
        from_objective_id: fromId,
        to_objective_id: toId,
        kind: kind as RelationKind,
        state: "ACTIVE",
        note: input.note != null
          ? [...String(input.note)].slice(0, NOTE_CAP).join("") : null,
        created_by: actor,
        dedup_key: dedupKey,
        created_at: now,
        updated_at: now,
        relation_digest: "",
      };
      row.relation_digest = relationDigest(row);
      const saved = this.store.put(
        OBJECTIVE_RELATION_ENTITY, row.relation_id, { ...row }, 0);
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
      // Index pointers for BOTH endpoints — atomic with the mint so a
      // committed edge is always findable by admissionView once the
      // marker reports built.
      this.indexEdge(row.relation_id, fromId);
      this.indexEdge(row.relation_id, toId);
      // Return the stored row — put injects entity_id/version; dedup
      // replays and control() return the same shape.
      return saved as ObjectiveRelationRow;
    });
  }

  /** Lifecycle: SUSPEND | RESUME | REVOKE — owner-of-both authority,
   *  CAS under the column version, state transition journaled. */
  control(input: {
    relation_id: string;
    action: "SUSPEND" | "RESUME" | "REVOKE";
    actor: string;
  }): ObjectiveRelationRow {
    const actor = assertOwnerAuthorityRef("actor", input.actor);
    const action = String(input.action ?? "");
    // Closed vocabulary — an out-of-set action must never reach the
    // transition map (undefined would be silently persisted + journaled).
    if (action !== "SUSPEND" && action !== "RESUME" && action !== "REVOKE") {
      fail("FAIL_CLOSED_RELATION_ACTION", `unknown action ${action}`);
    }
    return this.store.immediate(() => {
      this.ensureIndex();
      const stored = this.store.tryGet(
        OBJECTIVE_RELATION_ENTITY, String(input.relation_id)) as Row | null;
      if (!stored) {
        fail("FAIL_CLOSED_RELATION_NOT_FOUND", String(input.relation_id));
      }
      // Storage-key binding — tryGet returns the payload, so a row
      // planted under this key claiming a different relation_id must
      // be caught before its borrowed anchors are consulted.
      if (String(stored.entity_id ?? "") !== String(input.relation_id)) {
        fail("FAIL_CLOSED_RELATION_TAMPERED", String(input.relation_id));
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
      const next: Record<string, RelationState | null> = {
        SUSPEND: row.state === "ACTIVE" ? "SUSPENDED" : null,
        RESUME: row.state === "SUSPENDED" ? "ACTIVE" : null,
        REVOKE: row.state !== "REVOKED" ? "REVOKED" : null,
      };
      const target = next[action];
      if (action === "REVOKE" && row.state === "REVOKED") return row; // terminal idempotent
      if (target === null || target === undefined) {
        fail("FAIL_CLOSED_RELATION_STATE",
          `${action} not legal from ${row.state}`);
      }
      if (action === "RESUME" && row.kind === "DEPENDS_ON") {
        // Re-activation re-proves acyclicity — a graph that changed
        // under SUSPENDED must not silently revive into a cycle.
        const edges = this.allProven(true).filter(
          (r) => r.business_id === row.business_id &&
            r.kind === "DEPENDS_ON" && r.state !== "REVOKED");
        this.assertAcyclic(edges, row.from_objective_id, row.to_objective_id);
      }
      const colVersion = (stored as { version?: unknown }).version;
      if (typeof colVersion !== "number" ||
          !Number.isInteger(colVersion) || colVersion < 1) {
        fail("FAIL_CLOSED_RELATION_TAMPERED", "version column unmatchable");
      }
      const updated: ObjectiveRelationRow = {
        ...row,
        state: target,
        updated_at: utcnow(),
      };
      updated.relation_digest = relationDigest(updated);
      const saved = this.store.put(
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
      return saved as ObjectiveRelationRow;
    });
  }

  /** All proven relations where the objective is either endpoint. */
  relationsFor(objectiveId: string): ObjectiveRelationRow[] {
    return this.allProven()
      .filter((r) => r.from_objective_id === objectiveId ||
        r.to_objective_id === objectiveId)
      .sort((a, b) => byId(a.relation_id, b.relation_id));
  }

  /** All proven relations inside the business — the portfolio seam. */
  relationsForBusiness(businessId: string): ObjectiveRelationRow[] {
    return this.allProven()
      .filter((r) => r.business_id === businessId)
      .sort((a, b) => byId(a.relation_id, b.relation_id));
  }

  /** ACTIVE DEPENDS_ON upstream objectives of `objectiveId` — the
   *  seam P18-C admission gating consumes. Zero-write, dedup'd —
   *  forged duplicate edges must not inflate the answer. */
  upstreamOf(objectiveId: string): string[] {
    const out = new Set<string>();
    for (const r of this.allProven()) {
      if (r.kind === "DEPENDS_ON" && r.state === "ACTIVE" &&
          r.from_objective_id === objectiveId) {
        out.add(String(r.to_objective_id));
      }
    }
    return [...out].sort();
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

  /** STRICT admission seam (P18-C): the ACTIVE edge sets an admission
   *  gate must judge — DEPENDS_ON upstreams of the objective (edges it
   *  must wait on) and CONFLICTS partners (either direction). Any
   *  corrupt relation row propagates loudly instead of being silently
   *  excluded — a corrupted-but-real edge can never silently clear an
   *  objective for admission. Semantic unproven-ness (fabrications,
   *  owner amendments) still drops the row — a forged edge can never
   *  gate. Budget trips propagate. Callers judge semantics (upstream
   *  status, lease roster) — this view only proves WHICH edges exist.
   *
   *  Cost is O(degree) once the per-endpoint edge index is built
   *  (ensureIndex, driven by write paths); until the marker reports
   *  built — e.g. a store whose relations pre-date the index — this
   *  falls back to the identical STRICT global enumeration at O(table)
   *  cost. Both paths prove the same complete ACTIVE edge set. */
  admissionView(objectiveId: string): {
    upstream: string[];
    conflicts: string[];
  } {
    if (!this.indexBuilt()) return this.admissionGlobal(objectiveId);
    const upstream = new Set<string>();
    const conflicts = new Set<string>();
    const prefix = `${objectiveId}:`;
    let after = prefix;
    for (;;) {
      const page = this.store.entityPage<Row>({
        entity_type: RELATION_INDEX_ENTITY,
        after_id: after,
        limit: RELATION_PAGE,
        upper_id: prefix + String.fromCharCode(0xffff),
      }) as Row[];
      if (!page.length) break;
      for (const idx of page) {
        const key = String(idx.entity_id);
        const relId = key.slice(prefix.length);
        if (String(idx.relation_id) !== relId ||
            String(idx.objective_id) !== objectiveId) {
          fail("FAIL_CLOSED_RELATION_INDEX",
            `index key/payload mismatch ${key}`);
        }
        let edge: Row;
        try {
          edge = this.store.get(OBJECTIVE_RELATION_ENTITY, relId) as Row;
        } catch (e) {
          // A pointer that resolves to nothing is index inconsistency —
          // corrupted state, not an absent edge: wedge loudly, never
          // silently clear admission.
          if (e instanceof NotFoundError) {
            fail("FAIL_CLOSED_RELATION_INDEX", `dangling index ${key}`);
          }
          throw e;
        }
        const proven = this.provenRow(edge, true);
        if (!proven) { after = key; continue; }
        if (proven.state === "ACTIVE") {
          if (proven.kind === "DEPENDS_ON" &&
              proven.from_objective_id === objectiveId) {
            upstream.add(proven.to_objective_id);
          } else if (proven.kind === "CONFLICTS" &&
              (proven.from_objective_id === objectiveId ||
               proven.to_objective_id === objectiveId)) {
            // Endpoint check mirrors the global path — a planted
            // pointer naming a FOREIGN conflict edge can never
            // fabricate a gate for this objective.
            const other = proven.from_objective_id === objectiveId
              ? proven.to_objective_id : proven.from_objective_id;
            conflicts.add(other);
          }
        }
        after = key;
      }
      if (page.length < RELATION_PAGE) break;
    }
    return { upstream: [...upstream].sort(), conflicts: [...conflicts].sort() };
  }

  /** The strict whole-table enumeration — identical proof set to the
   *  index path, used while the index marker reports un-built. */
  private admissionGlobal(objectiveId: string): {
    upstream: string[];
    conflicts: string[];
  } {
    const upstream = new Set<string>();
    const conflicts = new Set<string>();
    for (const r of this.allProven(true)) {
      if (r.state !== "ACTIVE") continue;
      if (r.kind === "DEPENDS_ON" && r.from_objective_id === objectiveId) {
        upstream.add(r.to_objective_id);
      } else if (r.kind === "CONFLICTS") {
        if (r.from_objective_id === objectiveId) conflicts.add(r.to_objective_id);
        if (r.to_objective_id === objectiveId) conflicts.add(r.from_objective_id);
      }
    }
    return { upstream: [...upstream].sort(), conflicts: [...conflicts].sort() };
  }

  private indexMarker(): Row | null {
    const row = this.store.tryGet(RELATION_INDEX_STATE, "progress") as
      Row | null;
    return row && typeof row === "object" ? row : null;
  }

  private indexBuilt(): boolean {
    return this.indexMarker()?.built === true;
  }

  /** Idempotent pointer write — one index row per (endpoint, edge). */
  private indexEdge(relationId: string, objectiveId: string): void {
    const key = `${objectiveId}:${relationId}`;
    if (this.store.tryGet(RELATION_INDEX_ENTITY, key)) return;
    this.store.put(RELATION_INDEX_ENTITY, key, {
      objective_id: objectiveId,
      relation_id: relationId,
      created_at: utcnow(),
    }, 0);
  }

  /** Resumable STRICT index rebuild — advances at most INDEX_CHUNK
   *  edges per call, persisting the cursor in the marker so migration
   *  converges over write calls rather than demanding one giant
   *  enumeration inside the caller's proof budget. Corruption wedges
   *  the rebuild (and the calling write) loudly — the marker only
   *  reports `built` after the COMPLETE strict set is indexed, so a
   *  partial index is never mistaken for authoritative. Idempotent;
   *  a no-op once built. Call inside a store.immediate writer. */
  ensureIndex(): void {
    const marker = this.indexMarker();
    if (marker?.built === true) return;
    let after = String(marker?.cursor ?? "");
    let built = 0;
    let exhausted = false;
    while (!exhausted && built < INDEX_CHUNK) {
      const page = this.store.entityPage<Row>({
        entity_type: OBJECTIVE_RELATION_ENTITY,
        after_id: after,
        limit: RELATION_PAGE,
      }) as Row[];
      if (!page.length) { exhausted = true; break; }
      let cut = false;
      for (const row of page) {
        const proven = this.provenRow(row, true);
        after = String(row.entity_id);
        if (proven) {
          this.indexEdge(proven.relation_id, proven.from_objective_id);
          this.indexEdge(proven.relation_id, proven.to_objective_id);
          built++;
        }
        if (built >= INDEX_CHUNK) { cut = true; break; }
      }
      // `exhausted` means the FETCH reached the table end AND the whole
      // page was processed — a short page cut mid-way by the chunk cap
      // still holds unprocessed rows; marking built there would drop
      // real edges from the gate forever.
      if (!cut && page.length < RELATION_PAGE) exhausted = true;
    }
    this.store.put(RELATION_INDEX_STATE, "progress", {
      built: exhausted,
      cursor: exhausted ? null : after,
      built_at: exhausted ? utcnow() : null,
      version: Number(marker?.version ?? 0),
    }, Number(marker?.version ?? 0));
  }
}
