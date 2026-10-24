/**
 * org-agent-duty.ts — P18-E: canonical duties binding an org_agent to a
 * declared objective set inside one business.
 *
 * org_agent records are business-scoped: an agent may be selected for
 * work under any objective in its business, but nothing canonical
 * DECLARES that a specific agent's responsibility covers a specific
 * objective set. `org_agent_duty` is that declaration — the staffing
 * fact later seams (P18-F recovery, company E2E) consume to prove an
 * agent's mandate legitimately SPANS the objectives it acts across.
 *
 *   state: ACTIVE → SUSPENDED ⇄ ACTIVE → REVOKED (terminal).
 *
 * Authority: the actor is minted as `operator:<ref>` and must equal the
 * owner_authority_id of EVERY covered objective — a duty spanning N
 * objectives is an N-lateral claim (the bilateral P18-A rule extended);
 * one objective's owner may not impose coverage unilaterally.
 * business_id is derived from the canonical objectives, never asserted
 * — a cross-business duty can never mint. The org_agent must resolve
 * and belong to the derived business.
 *
 * Integrity: digest pins every canonical field (updated_at excluded),
 * OCC on the entities-table version column, lifecycle event anchors
 * pin state transitions. Reads re-prove exactly like writes (P16-E /
 * P18-A pattern): digest + storage-key↔payload entity binding + strict
 * objective resolution for EVERY covered objective + per-objective
 * current-owner re-check + agent resolution + the FULL event tail
 * (CREATED identity pins first, then legal STATE hops ending at the
 * row's state). A digest-recomputed flip, an anchor-borrowed clone, an
 * event-less forge, or a resurrected terminal row is never served.
 *
 * Relations are NOT a precondition: a duty is an authority declaration,
 * not a scheduling fact — the owner may staff an agent over unrelated
 * objectives. Whether the covered objectives are coordinated is a
 * separate question the relation substrate answers.
 *
 * Known bounds (fail-closed, recoverable): amending any covered
 * objective's owner_authority_id invalidates every duty covering it —
 * the owner must re-mint under the new authority. Deleting a covered
 * objective unproves the duty (semantic drop). A corrupt duty row
 * wedges strict write paths and fails closed on reads (siblings still
 * serve); a corrupt index-marker or index-pointer row is treated as
 * unbuilt/skipped under lenient reads (the strict global fallback is
 * complete). A raw-write DELETE of a pointer row can hide a proven
 * duty from that endpoint's index scan — dedup completeness rests on
 * the atomic pointer-mint invariant, the same raw-write bound P18-A
 * documents (the row remains discoverable via its other endpoints'
 * pointers and the global fallback). org_agent.status is deliberately
 * NOT part of the proof — status is runtime-mutable, not authority;
 * executability gates live at the assignment/binding seams. DELETE+
 * verbatim-restore of a row AND its event tail is
 * fabrication-indistinguishable — the store is the integrity boundary.
 *
 * Reads are O(degree) via the dual pointer index once built
 * (O:{objective}:{duty} + A:{agent}:{duty}); until the marker reports
 * built this falls back to the identical strict global enumeration.
 */
import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError, PairError } from "./errors.js";
import {
  assertOwnerAuthorityRef,
  ObjectiveAuthorityService,
} from "./objective-authority.js";
import type { PairEvidenceStore } from "./store.js";

export const ORG_AGENT_DUTY_ENTITY = "org_agent_duty";
export const ORG_AGENT_DUTY_SCHEMA = "pair.os.vnext.org-agent-duty.v1";
/** Per-endpoint duty pointers so reads cost O(degree), not O(table).
 *  Key shape `O:{objectiveId}:{dutyId}` for per-objective reads and
 *  `A:{agentId}:{dutyId}` for per-agent reads — colon-bounded prefix
 *  ranges. Pointers are entity-hash-proven and name duties that are
 *  still FULLY re-proven at read time; a forged pointer can only name
 *  a real canonical duty, never fabricate one. */
export const DUTY_INDEX_ENTITY = "org_agent_duty_index";
const DUTY_INDEX_STATE = "org_agent_duty_index_state";
/** Rebuild chunk per write call — resumable via the marker cursor. */
const INDEX_CHUNK = 64;

export const DUTY_CREATED_EVENT = "ORG_AGENT_DUTY_CREATED";
export const DUTY_STATE_EVENT = "ORG_AGENT_DUTY_STATE";

export type DutyState = "ACTIVE" | "SUSPENDED" | "REVOKED";

const DUTY_PAGE = 256;
const NOTE_CAP = 512;
const DEDUP_KEY_CAP = 256;
/** A duty spanning more objectives than this is malformed — coverage
 *  re-proof cost is proportional to the set. */
const DUTY_OBJECTIVE_CAP = 64;

export interface OrgAgentDutyRow extends Record<string, unknown> {
  duty_id: string;
  schema: string;
  business_id: string;
  org_agent_id: string;
  /** Sorted unique objective ids the duty covers. */
  objective_ids: string[];
  state: DutyState;
  note: string | null;
  created_by: string;
  dedup_key: string;
  created_at: string;
  updated_at: string;
  duty_digest: string;
}

type Row = Record<string, unknown>;

function fail(code: string, detail: string): never {
  throw new IntegrityError(code, detail);
}

export function dutyDigest(d: Record<string, unknown>): string {
  return digest({
    schema: d.schema,
    duty_id: d.duty_id,
    business_id: d.business_id,
    org_agent_id: d.org_agent_id,
    objective_ids: d.objective_ids,
    state: d.state,
    note: d.note ?? null,
    created_by: d.created_by,
    dedup_key: d.dedup_key,
    created_at: d.created_at,
  });
}

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

/** Index keys are `:`-delimited — an endpoint id containing a colon is
 *  unkeyable (a colon-agent's pointers would land inside another
 *  endpoint's prefix range and wedge it forever). Canonical OBJ_/AGT_
 *  ids never contain one; raw-SQL agent rows can. The boundary rejects
 *  colon endpoints at mint AND at reads, provenRow drops any stored row
 *  carrying one — that shape could never have been minted — and
 *  ensureIndex never projects them into pointer rows. */
function keyable(id: unknown): boolean {
  return typeof id === "string" && id !== "" && !id.includes(":");
}

function assertEndpointKey(field: string, id: unknown): void {
  if (!keyable(id)) {
    fail("FAIL_CLOSED_DUTY_FIELDS",
      `${field} must be a non-empty ':'-free string (index-keyed)`);
  }
}

export class OrgAgentDutyService {
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
      fail("FAIL_CLOSED_DUTY_OBJECTIVE", `objective ${id} does not resolve`);
    }
  }

  /** Canonical org_agent resolution — existence + business binding.
   *  org_agent rows carry no canonical digest; the entity's own store
   *  hash + version still binds the row served. A missing agent is a
   *  semantic resolution failure (unproven), corruption and budget
   *  trips stay loud — same taxonomy as objective(). */
  private agent(id: string): Row {
    try {
      return this.store.get("org_agent", id) as Row;
    } catch (e) {
      if (e instanceof IntegrityError &&
          (e.code === "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT" ||
           e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH")) throw e;
      if (!(e instanceof PairError)) throw e;
      fail("FAIL_CLOSED_DUTY_AGENT", `org_agent ${id} does not resolve`);
    }
  }

  /** Fault taxonomy for provenRow: store/DB faults (non-IntegrityError)
   *  and budget trips are ALWAYS loud — a fault is not "unproven".
   *  Corruption codes (tampered row or event anchor) are loud on the
   *  strict write path — a corrupted-but-real duty excluded from dedup
   *  mints a duplicate — while lenient reads treat it as unproven and
   *  serve siblings. */
  private rethrowFault(e: unknown, strict: boolean): void {
    if (!(e instanceof IntegrityError)) throw e;
    if (e.code === "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT") throw e;
    if (strict && (e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH" ||
                   e.code === "FAIL_CLOSED_EVENT_HASH_MISMATCH")) throw e;
  }

  /** Re-prove a stored row end-to-end: digest-valid, storage-key↔
   *  payload identity-bound, every covered objective strictly resolved
   *  against CURRENT canonical state with created_by still owning it,
   *  the agent resolved and same-business, and the event tail a legal
   *  chain ending at the row's state. Anything else is unproven —
   *  skipped on reads, TAMPERED on control. */
  private provenRow(row: Row, strict = false): OrgAgentDutyRow | null {
    if (String(row.schema) !== ORG_AGENT_DUTY_SCHEMA) return null;
    const state = String(row.state);
    if (state !== "ACTIVE" && state !== "SUSPENDED" && state !== "REVOKED") {
      return null;
    }
    if (String(row.duty_digest) !== dutyDigest(row)) return null;
    // Storage key must equal the payload's claimed duty_id — a clone
    // planted under a different key can never borrow the victim's
    // event anchors.
    if (String(row.entity_id ?? "") !== String(row.duty_id)) return null;
    const ids = Array.isArray(row.objective_ids) ? row.objective_ids : null;
    if (!ids || ids.length === 0 || ids.length > DUTY_OBJECTIVE_CAP) return null;
    // Objective set must be sorted-unique — a digest-valid row with an
    // unsorted or duplicated set could never have been minted.
    const normalized = [...new Set(ids.map(String))].sort(byId);
    if (normalized.length !== ids.length) return null;
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i]) !== normalized[i]) return null;
    }
    // Colon endpoints are unkeyable at the index boundary — a stored
    // row carrying one could never have been minted: unproven.
    if (normalized.some((v) => v.includes(":"))) return null;
    if (String(row.org_agent_id ?? "").includes(":")) return null;
    try {
      const createdBy = String(row.created_by ?? "");
      for (const oid of normalized) {
        const obj = this.objective(oid);
        // Scope claim AND current-owner re-proof per endpoint — an
        // owner amendment on ANY covered objective unproves the duty.
        if (String(obj.business_id) !== String(row.business_id)) return null;
        if (createdBy !== String(obj.owner_authority_id)) return null;
      }
      const agent = this.agent(String(row.org_agent_id ?? ""));
      if (String(agent.business_id) !== String(row.business_id)) return null;
      if (String(agent.agent_id) !== String(row.org_agent_id)) return null;
    } catch (e) {
      this.rethrowFault(e, strict);
      return null;
    }
    // Event tail must be a legal chain: CREATED first (with identity
    // pins matching the row), then STATE hops that are legal
    // transitions chaining from the prior new_state, ending at the
    // row's current state.
    let events: Row[];
    try {
      events = this.store.listEvents(
        ORG_AGENT_DUTY_ENTITY, String(row.duty_id)) as Row[];
    } catch (e) {
      this.rethrowFault(e, strict);
      return null;
    }
    if (events.length === 0) return null;
    const first = events[0];
    if (first.event_type !== DUTY_CREATED_EVENT) return null;
    if (first.old_state != null) return null; // genesis has no prior
    if (String(first.new_state ?? "") !== "ACTIVE") return null;
    const meta = (first.metadata ?? null) as Row | null;
    if (!meta) return null;
    if (String(meta.business_id ?? "") !== String(row.business_id)) return null;
    if (String(meta.org_agent_id ?? "") !== String(row.org_agent_id)) return null;
    // Objective-set pin: the CREATED anchor must name exactly the
    // row's coverage — a minted-then-edited set is a forge.
    const metaIds = Array.isArray(meta.objective_ids)
      ? meta.objective_ids.map(String) : null;
    if (!metaIds || metaIds.length !== normalized.length) return null;
    for (let i = 0; i < normalized.length; i++) {
      if (metaIds[i] !== normalized[i]) return null;
    }
    let prevState = "ACTIVE";
    for (let i = 1; i < events.length; i++) {
      const e = events[i];
      if (e.event_type !== DUTY_STATE_EVENT) return null;
      const hop = `${String(e.old_state ?? "")}>${String(e.new_state ?? "")}`;
      if (!LEGAL_TRANSITIONS.has(hop)) return null;
      if (String(e.old_state ?? "") !== prevState) return null;
      prevState = String(e.new_state ?? "");
    }
    if (prevState !== state) return null;
    return row as OrgAgentDutyRow;
  }

  /** Enumerate via entityPage — it binds payload.entity_id to the
   *  actual storage key (+ hash + version) before returning (the
   *  binding list()/tryGet() cannot provide). strict=true (write
   *  paths): any corrupt row propagates — dedup must judge over the
   *  COMPLETE canonical set or fail loudly. strict=false (reads):
   *  a corrupt row fails only itself, siblings still serve. */
  private allProven(strict = false): OrgAgentDutyRow[] {
    const out: OrgAgentDutyRow[] = [];
    let after = "";
    let pageSize = DUTY_PAGE;
    for (;;) {
      let page: Row[];
      try {
        page = this.store.entityPage({
          entity_type: ORG_AGENT_DUTY_ENTITY, after_id: after,
          limit: pageSize,
        }) as Row[];
      } catch (e) {
        // Only a hash-mismatch carries the offending key in .detail —
        // anything else (read-budget trips, API misuse) must propagate:
        // silently treating it as "one bad row" would truncate the
        // proven set and defeat dedup upstream.
        if (!(e instanceof IntegrityError) ||
            e.code !== "FAIL_CLOSED_ENTITY_HASH_MISMATCH") throw e;
        if (strict) throw e;
        // Isolate with single-row pages, then skip the offender via
        // the key in err.detail; a non-advancing cursor (non-TEXT key)
        // degrades to the same typed wedge strict mode produces.
        if (pageSize > 1) { pageSize = 1; continue; }
        const bad = String(e.detail ?? "");
        if (!bad || bad === after) throw e;
        after = bad;
        pageSize = DUTY_PAGE;
        continue;
      }
      if (page.length === 0) break;
      for (const row of page) {
        const proven = this.provenRow(row, strict);
        if (proven) out.push(proven);
      }
      if (page.length < pageSize) break;
      after = String(page[page.length - 1].entity_id);
      pageSize = DUTY_PAGE;
    }
    return out;
  }

  // ---------- pointer index ----------

  private indexMarker(): Row | null {
    const row = this.store.tryGet(DUTY_INDEX_STATE, "progress") as Row | null;
    return row && typeof row === "object" ? row : null;
  }

  /** The marker gates a DERIVED index — an unreadable marker row is
   *  treated as unbuilt so reads fall back to the identical strict
   *  global enumeration instead of wedging (the fallback is complete;
   *  nothing is lost). Non-corruption faults still propagate. */
  private indexBuilt(): boolean {
    try {
      return this.indexMarker()?.built === true;
    } catch (e) {
      if (e instanceof IntegrityError &&
          e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH") return false;
      throw e;
    }
  }

  /** Idempotent pointer write — one index row per (kind, endpoint, duty). */
  private indexEdge(prefix: "O" | "A", endpoint: string, dutyId: string): void {
    const key = `${prefix}:${endpoint}:${dutyId}`;
    if (this.store.tryGet(DUTY_INDEX_ENTITY, key)) return;
    this.store.put(DUTY_INDEX_ENTITY, key, {
      pointer_kind: prefix,
      objective_id: prefix === "O" ? endpoint : null,
      agent_id: prefix === "A" ? endpoint : null,
      duty_id: dutyId,
      created_at: utcnow(),
    }, 0);
  }

  /** Resumable index rebuild — at most INDEX_CHUNK rows per call,
   *  cursor persisted in the marker. The index is a pure table
   *  projection: EVERY entityPage-bound-valid row gets its endpoint
   *  pointers, proven or not — read-time provenRow still drops
   *  unproven rows, so a row only TEMPORARILY unproven at rebuild time
   *  (owner amended away, later amended back) keeps its pointers and
   *  re-authorizes the moment it re-proves. Corrupt rows wedge at the
   *  page level — `built` is set only after the complete bound set is
   *  indexed, never on a chunk-cut short page. Idempotent; a no-op
   *  once built. Call inside a store.immediate writer. */
  ensureIndex(): void {
    let marker: Row | null;
    try {
      marker = this.indexMarker();
    } catch (e) {
      // Corrupt marker → rebuild from scratch; the terminal marker put
      // CAS-conflicts loudly on the still-corrupt physical row.
      if (e instanceof IntegrityError &&
          e.code === "FAIL_CLOSED_ENTITY_HASH_MISMATCH") {
        marker = null;
      } else throw e;
    }
    if (marker?.built === true) return;
    let after = String(marker?.cursor ?? "");
    let processed = 0;
    let exhausted = false;
    while (!exhausted && processed < INDEX_CHUNK) {
      const page = this.store.entityPage<Row>({
        entity_type: ORG_AGENT_DUTY_ENTITY,
        after_id: after,
        limit: DUTY_PAGE,
      }) as Row[];
      if (!page.length) { exhausted = true; break; }
      let cut = false;
      for (const row of page) {
        // Pointers name the STORAGE KEY — entityPage already bound it
        // to the payload; a row whose payload duty_id disagrees is
        // semantically unproven at read time (dead pointer, no auth).
        const dutyId = String(row.entity_id);
        after = dutyId;
        // Unkeyable endpoints (colons — never mintable, never
        // re-provable) get NO pointers: indexing them would mint
        // poison keys inside an innocent endpoint's prefix range and
        // wedge that endpoint permanently. Temporarily-unproven rows
        // keep their pointers; never-provable shapes keep nothing.
        const ids = Array.isArray(row.objective_ids) ? row.objective_ids : [];
        for (const oid of ids) {
          if (keyable(oid)) this.indexEdge("O", String(oid), dutyId);
        }
        const agentEp = row.org_agent_id;
        if (keyable(agentEp)) this.indexEdge("A", String(agentEp), dutyId);
        processed++;
        if (processed >= INDEX_CHUNK) { cut = true; break; }
      }
      // `exhausted` means the FETCH reached the table end AND the whole
      // page was processed — a short page cut mid-way by the chunk cap
      // still holds unprocessed rows; marking built there would drop
      // real duties from the index forever.
      if (!cut && page.length < DUTY_PAGE) exhausted = true;
    }
    this.store.put(DUTY_INDEX_STATE, "progress", {
      built: exhausted,
      cursor: exhausted ? null : after,
      built_at: exhausted ? utcnow() : null,
      version: Number(marker?.version ?? 0),
    }, Number(marker?.version ?? 0));
  }

  /** O(degree) read of proven duties reachable through one pointer
   *  prefix — the index path when built, else strict global fallback.
   *  Every pointer resolves its named duty through provenRow — a
   *  forged or stale pointer names a row that must still fully prove. */
  private provenViaIndex(prefix: "O" | "A", endpoint: string,
    strict: boolean): OrgAgentDutyRow[] {
    const out = new Map<string, OrgAgentDutyRow>();
    const pfx = `${prefix}:${endpoint}:`;
    let after = pfx;
    let pageSize = DUTY_PAGE;
    for (;;) {
      let page: Row[];
      try {
        page = this.store.entityPage<Row>({
          entity_type: DUTY_INDEX_ENTITY,
          after_id: after,
          limit: pageSize,
          upper_id: pfx + String.fromCharCode(0xffff),
        }) as Row[];
      } catch (e) {
        // Corrupt pointer row: strict propagates (dedup can't silently
        // miss); lenient isolates with single-row pages and skips the
        // offender via err.detail — parity with allProven's handling of
        // corrupt duty rows so both paths serve the same answer.
        if (!(e instanceof IntegrityError) ||
            e.code !== "FAIL_CLOSED_ENTITY_HASH_MISMATCH") throw e;
        if (strict) throw e;
        if (pageSize > 1) { pageSize = 1; continue; }
        const bad = String(e.detail ?? "");
        if (!bad || bad === after) throw e;
        after = bad;
        pageSize = DUTY_PAGE;
        continue;
      }
      if (!page.length) break;
      for (const ptr of page) {
        const key = String(ptr.entity_id);
        const dutyId = key.slice(pfx.length);
        // The pointer's own payload must agree with its key — a forged
        // or tampered index row is inconsistency, never an absent duty.
        if (String(ptr.duty_id) !== dutyId ||
            String(ptr.pointer_kind ?? '') !== prefix ||
            String(prefix === 'O' ? ptr.objective_id : ptr.agent_id) !==
              endpoint) {
          fail('FAIL_CLOSED_DUTY_INDEX', `index key/payload mismatch ${key}`);
        }
        let stored: Row;
        try {
          stored = this.store.get(ORG_AGENT_DUTY_ENTITY, dutyId) as Row;
        } catch (e) {
          // A pointer resolving to nothing is index inconsistency —
          // wedge loudly, never silently shrink coverage.
          if (e instanceof NotFoundError) {
            fail('FAIL_CLOSED_DUTY_INDEX', `dangling index ${key}`);
          }
          // Hash-mismatched duty row: strict propagates; lenient drops
          // it like the global path does (siblings still serve).
          if (e instanceof IntegrityError &&
              e.code === 'FAIL_CLOSED_ENTITY_HASH_MISMATCH' && !strict) {
            after = key;
            continue;
          }
          throw e;
        }
        // Storage-key-payload binding — a pointer must never resolve
        // to a key-borrowed row where the global path would wedge.
        if (String(stored.entity_id ?? '') !== dutyId) {
          fail('FAIL_CLOSED_DUTY_INDEX', `key-borrowed duty ${key}`);
        }
        // Endpoint check — a pointer planted under a foreign endpoint
        // key can never bind a duty that does not actually cover it.
        const covers = prefix === 'O'
          ? (Array.isArray(stored.objective_ids)
              ? stored.objective_ids.map(String).includes(endpoint) : false)
          : String(stored.org_agent_id ?? '') === endpoint;
        if (!covers) {
          fail('FAIL_CLOSED_DUTY_INDEX',
            `pointer ${key} mis-binds endpoint ${endpoint}`);
        }
        const proven = this.provenRow(stored, strict);
        if (proven) out.set(String(proven.duty_id), proven);
        after = key;
      }
      // Tail check uses the size actually requested — then isolation
      // restores the full page (a successful single-row page is not
      // the range end).
      const wasShort = page.length < pageSize;
      pageSize = DUTY_PAGE;
      if (wasShort) break;
    }
    return [...out.values()].sort((a, b) => byId(a.duty_id, b.duty_id));
  }

  private provenForEndpoint(prefix: "O" | "A", endpoint: string,
    strict: boolean): OrgAgentDutyRow[] {
    assertEndpointKey("endpoint", endpoint);
    if (this.indexBuilt()) return this.provenViaIndex(prefix, endpoint, strict);
    return this.allProven(strict).filter((d) =>
      prefix === "O"
        ? d.objective_ids.includes(endpoint)
        : d.org_agent_id === endpoint);
  }

  // ---------- writes ----------

  /** Mint a duty. Idempotent per (org_agent, objective-set): an
   *  existing non-terminal duty with the same pair returns itself —
   *  a replayed mint is a semantic no-op, never a duplicate. */
  create(input: {
    org_agent_id: string;
    objective_ids: string[];
    actor: string;
    note?: string | null;
    dedup_key?: string;
  }): OrgAgentDutyRow {
    const actor = assertOwnerAuthorityRef("actor", input.actor);
    const agentId = String(input.org_agent_id ?? "");
    if (!agentId) fail("FAIL_CLOSED_DUTY_FIELDS", "org_agent_id required");
    assertEndpointKey("org_agent_id", agentId);
    const rawIds = Array.isArray(input.objective_ids)
      ? input.objective_ids : null;
    if (!rawIds || !rawIds.length) {
      fail("FAIL_CLOSED_DUTY_FIELDS", "objective_ids must be a non-empty list");
    }
    const objectiveIds = [...new Set(rawIds.map((v) => String(v ?? "")))];
    if (objectiveIds.some((v) => !v)) {
      fail("FAIL_CLOSED_DUTY_FIELDS", "objective_ids contains empty id");
    }
    for (const oid of objectiveIds) assertEndpointKey("objective_ids", oid);
    if (objectiveIds.length > DUTY_OBJECTIVE_CAP) {
      fail("FAIL_CLOSED_DUTY_FIELDS",
        `objective_ids exceeds cap ${DUTY_OBJECTIVE_CAP}`);
    }
    objectiveIds.sort(byId);
    // BEGIN IMMEDIATE: dedup reads and row+event+index writes run under
    // the writer lock — a racing mint on another connection serializes
    // instead of passing a stale check.
    return this.store.immediate(() => {
      this.ensureIndex();
      let businessId = "";
      for (const oid of objectiveIds) {
        const obj = this.objective(oid);
        const biz = String(obj.business_id ?? "");
        if (!biz) fail("FAIL_CLOSED_DUTY_BUSINESS", `objective ${oid} unscoped`);
        if (businessId && biz !== businessId) {
          fail("FAIL_CLOSED_DUTY_BUSINESS",
            "a duty spans objectives of ONE business — cross-business set");
        }
        businessId = biz;
        // N-lateral authority: the actor must own EVERY covered
        // objective — different owners means consent deferred, never
        // silently bypassed.
        if (actor !== String(obj.owner_authority_id ?? "")) {
          fail("FAIL_CLOSED_DUTY_AUTHORITY",
            "actor must be the owner_authority_id of every covered objective");
        }
      }
      const agent = this.agent(agentId);
      if (String(agent.business_id ?? "") !== businessId) {
        fail("FAIL_CLOSED_DUTY_BUSINESS",
          `agent ${agentId} is outside business ${businessId}`);
      }
      // Idempotent replay — checked AFTER authority so a replay can't
      // oracle the duty's existence to a foreign owner. STRICT read of
      // the agent's own duties only (index or global fallback).
      const existing = this.provenForEndpoint("A", agentId, true).find(
        (d) => d.state !== "REVOKED" &&
          d.objective_ids.length === objectiveIds.length &&
          d.objective_ids.every((v, i) => v === objectiveIds[i]));
      if (existing) return existing;

      let dedupKey: string;
      if (input.dedup_key != null) {
        if (typeof input.dedup_key !== "string" ||
            input.dedup_key.length === 0 ||
            [...input.dedup_key].length > DEDUP_KEY_CAP) {
          fail("FAIL_CLOSED_DUTY_FIELDS", "dedup_key");
        }
        dedupKey = input.dedup_key;
      } else {
        dedupKey = digest({ agentId, objectiveIds });
      }
      const now = utcnow();
      const row: OrgAgentDutyRow = {
        duty_id: newId("DUT"),
        schema: ORG_AGENT_DUTY_SCHEMA,
        business_id: businessId,
        org_agent_id: agentId,
        objective_ids: objectiveIds,
        state: "ACTIVE",
        note: input.note != null
          ? [...String(input.note)].slice(0, NOTE_CAP).join("") : null,
        created_by: actor,
        dedup_key: dedupKey,
        created_at: now,
        updated_at: now,
        duty_digest: "",
      };
      row.duty_digest = dutyDigest(row);
      const saved = this.store.put(
        ORG_AGENT_DUTY_ENTITY, row.duty_id, { ...row }, 0);
      this.store.event({
        entity_type: ORG_AGENT_DUTY_ENTITY,
        entity_id: row.duty_id,
        event_type: DUTY_CREATED_EVENT,
        new_state: "ACTIVE",
        actor,
        metadata: {
          business_id: businessId,
          org_agent_id: agentId,
          objective_ids: objectiveIds,
        },
      });
      // Pointers for every covered objective AND the agent — atomic
      // with the mint so a committed duty is always findable once the
      // marker reports built.
      for (const oid of objectiveIds) this.indexEdge("O", oid, row.duty_id);
      this.indexEdge("A", agentId, row.duty_id);
      return saved as OrgAgentDutyRow;
    });
  }

  /** Lifecycle: SUSPEND | RESUME | REVOKE — owner-of-every-covered-
   *  objective authority, CAS under the column version, transition
   *  journaled. */
  control(input: {
    duty_id: string;
    action: "SUSPEND" | "RESUME" | "REVOKE";
    actor: string;
  }): OrgAgentDutyRow {
    const actor = assertOwnerAuthorityRef("actor", input.actor);
    const action = String(input.action ?? "");
    // Closed vocabulary — an out-of-set action must never reach the
    // transition map.
    if (action !== "SUSPEND" && action !== "RESUME" && action !== "REVOKE") {
      fail("FAIL_CLOSED_DUTY_ACTION", `unknown action ${action}`);
    }
    return this.store.immediate(() => {
      this.ensureIndex();
      const stored = this.store.tryGet(
        ORG_AGENT_DUTY_ENTITY, String(input.duty_id)) as Row | null;
      if (!stored) {
        fail("FAIL_CLOSED_DUTY_NOT_FOUND", String(input.duty_id));
      }
      // Storage-key binding — a row planted under this key claiming a
      // different duty_id is caught before its anchors are consulted.
      if (String(stored.entity_id ?? "") !== String(input.duty_id)) {
        fail("FAIL_CLOSED_DUTY_TAMPERED", String(input.duty_id));
      }
      const row = this.provenRow(stored);
      if (!row) {
        fail("FAIL_CLOSED_DUTY_TAMPERED", String(input.duty_id));
      }
      for (const oid of row.objective_ids) {
        const obj = this.objective(oid);
        if (actor !== String(obj.owner_authority_id ?? "")) {
          fail("FAIL_CLOSED_DUTY_AUTHORITY",
            "actor must be the owner_authority_id of every covered objective");
        }
      }
      const next: Record<string, DutyState | null> = {
        SUSPEND: row.state === "ACTIVE" ? "SUSPENDED" : null,
        RESUME: row.state === "SUSPENDED" ? "ACTIVE" : null,
        REVOKE: row.state !== "REVOKED" ? "REVOKED" : null,
      };
      const target = next[action];
      if (action === "REVOKE" && row.state === "REVOKED") return row; // terminal idempotent
      if (target === null || target === undefined) {
        fail("FAIL_CLOSED_DUTY_STATE", `${action} not legal from ${row.state}`);
      }
      const colVersion = (stored as { version?: unknown }).version;
      if (typeof colVersion !== "number" ||
          !Number.isInteger(colVersion) || colVersion < 1) {
        fail("FAIL_CLOSED_DUTY_TAMPERED", "version column unmatchable");
      }
      const updated: OrgAgentDutyRow = {
        ...row,
        state: target,
        updated_at: utcnow(),
      };
      updated.duty_digest = dutyDigest(updated);
      const saved = this.store.put(
        ORG_AGENT_DUTY_ENTITY, row.duty_id, { ...updated }, colVersion);
      this.store.event({
        entity_type: ORG_AGENT_DUTY_ENTITY,
        entity_id: row.duty_id,
        event_type: DUTY_STATE_EVENT,
        old_state: row.state,
        new_state: target,
        actor,
        metadata: { action },
      });
      return saved as OrgAgentDutyRow;
    });
  }

  // ---------- reads ----------

  /** All proven duties covering the objective — lenient: corrupt rows
   *  drop, siblings still serve. O(degree) once the index is built. */
  dutiesForObjective(objectiveId: string): OrgAgentDutyRow[] {
    return this.provenForEndpoint("O", objectiveId, false)
      .filter((d) => d.objective_ids.includes(objectiveId));
  }

  /** All proven duties held by the agent. */
  dutiesForAgent(agentId: string): OrgAgentDutyRow[] {
    return this.provenForEndpoint("A", agentId, false);
  }

  /** The seam later milestones consume: does at least ONE proven ACTIVE
   *  duty bind `agentId` to ALL of `objectiveIds`? Union-of-duties is
   *  deliberately NOT coverage — two narrow duties never combine into
   *  a mandate nobody granted. */
  coveringDuties(agentId: string, objectiveIds: string[]): OrgAgentDutyRow[] {
    // A non-set covers nothing — typed edge, never a raw TypeError.
    if (!Array.isArray(objectiveIds)) return [];
    const wanted = [...new Set(objectiveIds.map(String))];
    if (!wanted.length) return [];
    return this.dutiesForAgent(agentId).filter((d) =>
      d.state === "ACTIVE" && wanted.every((o) => d.objective_ids.includes(o)));
  }

  covers(agentId: string, objectiveIds: string[]): boolean {
    return this.coveringDuties(agentId, objectiveIds).length > 0;
  }
}
