/**
 * Governed canonical-evidence store — PAIR persistence semantics
 * (donor standalone_core/persistence.py + mission_memory.py) over its own
 * SQLite database. This is the ONLY canonical evidence plane; Automaton
 * state.db remains cognitive/runtime memory and is never authoritative.
 *
 * Invariants ported:
 * - payload stored as canonical_json; payload_hash = sha256(canonical_json)
 * - verify-on-read: every read re-hashes and fails closed on mismatch
 * - optimistic version locking on update
 * - append-only governed_evidence table (no update/delete)
 * - events append-only with seq + event_hash
 */

import Database from "better-sqlite3";
import path from "node:path";
import { canonicalJson, digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { BROKER_CAPABILITY_SOURCE } from "./sanitizer.js";

const SECRET_MARKER_KEYS = new Set([
  "api_key",
  "apikey",
  "secret",
  "password",
  "credential",
  "access_token",
  "refresh_token",
  "authorization",
  "private_key",
]);

// P13-R4 §1 defense-in-depth: a raw task-scoped broker capability is
// secret material — it must never persist as an arbitrary string value in
// canonical entities, evidence or events. Non-global regex: .test() stays
// stateless.
const BROKER_CAPABILITY_TEST = new RegExp(BROKER_CAPABILITY_SOURCE);

export interface StoredEntity {
  entity_type: string;
  entity_id: string;
  version: number;
  [key: string]: unknown;
}

/** R6 — canonical SQLite lock-contention detection: ONLY known
 *  transient writer-lock conditions (`SQLITE_BUSY*`, `SQLITE_LOCKED*`).
 *  These mean another connection holds the write lock and the call may
 *  retry on a later tick — bounded convergence, never a defect. Every
 *  other error (hash mismatch, schema, corruption, governance
 *  IntegrityError) continues to fail closed. */
export function isSqliteContentionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = String((e as { code?: unknown }).code ?? "");
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return true;
  }
  const msg = String((e as { message?: unknown }).message ?? "");
  // better-sqlite3's canonical lock-contention messages also surface
  // without a `code` (e.g. re-wrapped errors): "database is locked" is
  // the SQLITE_BUSY text and "database table is locked" SQLITE_LOCKED.
  return /SQLITE_(BUSY|LOCKED)|database (is|table is) locked/i.test(msg);
}

export class PairEvidenceStore {
  readonly db: Database.Database;
  private readBudget: { entities: number; events: number } | null = null;
  /** Directory holding pair.db — canonical deployment root for
   *  co-located durable state (F1 artifact blob store). */
  readonly dbDir: string;

  constructor(dbPath: string) {
    this.dbDir = path.dirname(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Two connections to the same file: a racing writer waits for the
    // winner's commit instead of failing with SQLITE_BUSY — then its
    // conditional UPDATE evaluates against the winner's version and
    // deterministically loses.
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  /** BEGIN IMMEDIATE … COMMIT/ROLLBACK — serializes writers across
   *  connections so count-then-write checks stay atomic. */
  immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        old_state TEXT,
        new_state TEXT,
        actor TEXT NOT NULL,
        correlation_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        event_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS governed_evidence (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        mission_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mission_plan_revisions (
        revision_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pair_events_scope_seq ON events(entity_type, entity_id, seq);
      CREATE INDEX IF NOT EXISTS pair_events_topic_seq ON events(event_type, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS pair_objective_scheduler_revision
        ON events(entity_type, entity_id, json_extract(metadata_json, '$.revision'))
        WHERE event_type = 'OBJECTIVE_AUTO_SCHEDULER_COMMIT';
    `);
  }

  withReadBudget<T>(limits: { entities: number; events: number }, fn: () => T): T {
    for (const n of [limits.entities, limits.events]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 100_000) {
        throw new IntegrityError("FAIL_CLOSED_READ_BUDGET_SCHEMA", "limits");
      }
    }
    if (this.readBudget) return fn();
    this.readBudget = { ...limits };
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new IntegrityError("FAIL_CLOSED_ASYNC_READ_BUDGET", "synchronous scope required");
      }
      return result;
    } finally {
      this.readBudget = null;
    }
  }

  private charge(kind: "entities" | "events", count: number): void {
    if (!this.readBudget) return;
    if (count > this.readBudget[kind]) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT", kind);
    }
    this.readBudget[kind] -= count;
  }

  /** Remaining charged-read budget of the current proof scope, or null
   *  when unscoped. Lets a bounded loop stop speculative work before the
   *  budget trips — exhausting it mid-transaction would roll back
   *  progress that must stay durable. */
  readBudgetRemaining(): { entities: number; events: number } | null {
    return this.readBudget ? { ...this.readBudget } : null;
  }

  private pageLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
      throw new IntegrityError("FAIL_CLOSED_STORE_PAGE_SCHEMA", "limit");
    }
    return limit;
  }

  private verifiedEvent(row: Record<string, unknown>): Record<string, unknown> {
    let metadata: unknown = null;
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(String(row.metadata_json));
      } catch {
        // Unparseable metadata is event corruption — carry the event
        // id so callers can isolate it, never a bare SyntaxError.
        throw new IntegrityError("FAIL_CLOSED_EVENT_HASH_MISMATCH", String(row.event_id));
      }
    }
    const body = {
      event_id: row.event_id, entity_type: row.entity_type, entity_id: row.entity_id,
      event_type: row.event_type, old_state: row.old_state, new_state: row.new_state,
      actor: row.actor, correlation_id: row.correlation_id, metadata, created_at: row.created_at,
    };
    if (digest(body) !== row.event_hash) {
      throw new IntegrityError("FAIL_CLOSED_EVENT_HASH_MISMATCH", String(row.event_id));
    }
    return { ...row, metadata };
  }

  eventPage(input: {
    after_seq: number; limit: number; topics: readonly string[];
    upper_seq?: number; entity_type?: string; entity_id?: string; descending?: boolean;
  }): Array<Record<string, unknown>> {
    const limit = this.pageLimit(input.limit);
    if (!Number.isSafeInteger(input.after_seq) || input.after_seq < 0 ||
        !input.topics.length || input.topics.length > 128 ||
        input.topics.some(t => typeof t !== "string" || !t || t.length > 128) ||
        (input.upper_seq !== undefined && (!Number.isSafeInteger(input.upper_seq) || input.upper_seq < 0))) {
      throw new IntegrityError("FAIL_CLOSED_STORE_PAGE_SCHEMA", "event cursor/topics");
    }
    const where = [`seq > ?`, `event_type IN (${input.topics.map(() => "?").join(",")})`];
    const args: unknown[] = [input.after_seq, ...input.topics];
    if (input.upper_seq !== undefined) { where.push("seq <= ?"); args.push(input.upper_seq); }
    if (input.entity_type) { where.push("entity_type = ?"); args.push(input.entity_type); }
    if (input.entity_id) { where.push("entity_id = ?"); args.push(input.entity_id); }
    const materialize = this.readBudget ? Math.min(limit, this.readBudget.events + 1) : limit;
    args.push(materialize);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")}
      ORDER BY seq ${input.descending ? "DESC" : "ASC"} LIMIT ?`).all(...args) as Record<string, unknown>[];
    this.charge("events", rows.length);
    return rows.map(row => this.verifiedEvent(row));
  }

  getEvent(eventId: string): Record<string, unknown> {
    this.charge("events", 1);
    const row = this.db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError(`event:${eventId}`);
    return this.verifiedEvent(row);
  }

  entityPage<T extends Record<string, unknown> = Record<string, unknown>>(input: {
    entity_type: string; after_id: string; limit: number; upper_id?: string;
  }): Array<T & { version: number }> {
    const limit = this.pageLimit(input.limit);
    const materialize = this.readBudget ? Math.min(limit, this.readBudget.entities + 1) : limit;
    const where = ["entity_type=?", "entity_id>?"];
    const args: unknown[] = [input.entity_type, input.after_id];
    if (input.upper_id !== undefined) { where.push("entity_id<=?"); args.push(input.upper_id); }
    args.push(materialize);
    const rows = this.db.prepare(`SELECT * FROM entities WHERE ${where.join(" AND ")} ORDER BY entity_id LIMIT ?`)
      .all(...args) as Record<string, unknown>[];
    this.charge("entities", rows.length);
    return rows.map(row => {
      let payload: T & { version: number };
      try {
        payload = JSON.parse(String(row.payload)) as T & { version: number };
      } catch {
        // An unparseable payload is corruption like any other — carry
        // the key so paged consumers can isolate-and-skip it.
        throw new IntegrityError("FAIL_CLOSED_ENTITY_HASH_MISMATCH", String(row.entity_id));
      }
      if (digest(payload) !== row.payload_hash || payload.entity_id !== row.entity_id ||
          payload.entity_type !== input.entity_type || payload.version !== row.version) {
        throw new IntegrityError("FAIL_CLOSED_ENTITY_HASH_MISMATCH", String(row.entity_id));
      }
      return payload;
    });
  }

  /** Structural index proof only; callers must also verify the current
   *  commit hash and protected pins before using a scheduler row. */
  schedulerRevisionSummary(entityType: string, entityId: string): {
    count: number; first: number | null; last: number | null; invalid: number;
  } {
    return this.db.prepare(`SELECT COUNT(*) AS count,
      MIN(json_extract(metadata_json,'$.revision')) AS first,
      MAX(json_extract(metadata_json,'$.revision')) AS last,
      COALESCE(SUM(CASE WHEN json_type(metadata_json,'$.revision')='integer'
        AND json_extract(metadata_json,'$.revision')>0 THEN 0 ELSE 1 END),0) AS invalid
      FROM events WHERE entity_type=? AND entity_id=? AND event_type='OBJECTIVE_AUTO_SCHEDULER_COMMIT'`)
      .get(entityType, entityId) as { count: number; first: number | null; last: number | null; invalid: number };
  }

  close(): void {
    this.db.close();
  }

  private static assertSecretFree(value: unknown, pathLabel = ""): void {
    if (typeof value === "string") {
      if (BROKER_CAPABILITY_TEST.test(value)) {
        throw new IntegrityError("FAIL_CLOSED_SENSITIVE_MATERIAL", `${pathLabel}bcap1`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        PairEvidenceStore.assertSecretFree(item, pathLabel);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_MARKER_KEYS.has(key.toLowerCase())) {
          throw new IntegrityError("FAIL_CLOSED_SECRET_FIELD_REJECTED", `${pathLabel}${key}`);
        }
        PairEvidenceStore.assertSecretFree(v, `${pathLabel}${key}.`);
      }
    }
  }

  put<T extends Record<string, unknown>>(
    entityType: string,
    entityId: string,
    payload: T,
    expectedVersion?: number,
  ): T & { entity_type: string; entity_id: string; version: number } {
    PairEvidenceStore.assertSecretFree(payload);
    const version = Number(payload.version ?? 0);
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new IntegrityError(
        "FAIL_CLOSED_VERSION_CONFLICT",
        `${entityType}:${entityId}:expected=${expectedVersion}:got=${version}`,
      );
    }
    const body = {
      ...payload,
      entity_type: entityType,
      entity_id: entityId,
      version: version + 1,
    };
    const text = canonicalJson(body);
    const hash = digest(body);
    const now = utcnow();
    // Atomic compare-and-swap in ONE statement: the version predicate is
    // evaluated under the SQLite writer lock against the latest committed
    // row, so of two racing writers on the same expected version exactly
    // one changes a row; the loser deterministically conflicts.
    const res = this.db
      .prepare(
        `UPDATE entities SET version=?, payload=?, payload_hash=?, updated_at=?
         WHERE entity_type=? AND entity_id=? AND version=?`,
      )
      .run(version + 1, text, hash, now, entityType, entityId, version);
    if (res.changes === 1) return { ...body, version: version + 1 };
    const existing = this.db
      .prepare("SELECT version FROM entities WHERE entity_type=? AND entity_id=?")
      .get(entityType, entityId) as { version: number } | undefined;
    if (existing) {
      throw new IntegrityError(
        "FAIL_CLOSED_VERSION_CONFLICT",
        `${entityType}:${entityId}:stored=${existing.version}:got=${version}`,
      );
    }
    if (version !== 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_VERSION_CONFLICT",
        `${entityType}:${entityId}:absent:expected=${version}`,
      );
    }
    // Absent + version 0 → create. ON CONFLICT DO NOTHING turns a lost
    // create-race into the same deterministic conflict.
    const ins = this.db
      .prepare(
        `INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO NOTHING`,
      )
      .run(entityType, entityId, version + 1, text, hash, now);
    if (ins.changes === 1) return { ...body, version: version + 1 };
    throw new IntegrityError(
      "FAIL_CLOSED_VERSION_CONFLICT",
      `${entityType}:${entityId}:created-elsewhere`,
    );
  }

  get<T extends Record<string, unknown> = Record<string, unknown>>(
    entityType: string,
    entityId: string,
  ): T & { version: number } {
    this.charge("entities", 1);
    const row = this.db
      .prepare("SELECT payload, payload_hash FROM entities WHERE entity_type=? AND entity_id=?")
      .get(entityType, entityId) as { payload: string; payload_hash: string } | undefined;
    if (!row) {
      throw new NotFoundError(`${entityType}:${entityId}`);
    }
    let payload: T;
    try {
      payload = JSON.parse(row.payload) as T;
    } catch {
      throw new IntegrityError(
        "FAIL_CLOSED_ENTITY_HASH_MISMATCH",
        `${entityType}:${entityId}`,
      );
    }
    if (digest(payload) !== row.payload_hash) {
      throw new IntegrityError(
        "FAIL_CLOSED_ENTITY_HASH_MISMATCH",
        `${entityType}:${entityId}`,
      );
    }
    return payload as T & { version: number };
  }

  tryGet<T extends Record<string, unknown> = Record<string, unknown>>(
    entityType: string,
    entityId: string,
  ): (T & { version: number }) | null {
    try {
      return this.get<T>(entityType, entityId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      throw err;
    }
  }

  list<T extends Record<string, unknown> = Record<string, unknown>>(
    entityType: string,
  ): Array<T & { version: number }> {
    const rows = this.db
      .prepare("SELECT payload, payload_hash FROM entities WHERE entity_type=?" + (this.readBudget ? " LIMIT ?" : ""))
      .all(...(this.readBudget ? [entityType, this.readBudget.entities + 1] : [entityType])) as Array<{ payload: string; payload_hash: string }>;
    this.charge("entities", rows.length);
    return rows.map((row) => {
      let payload: T;
      try {
        payload = JSON.parse(row.payload) as T;
      } catch {
        throw new IntegrityError("FAIL_CLOSED_ENTITY_HASH_MISMATCH", entityType);
      }
      if (digest(payload) !== row.payload_hash) {
        throw new IntegrityError("FAIL_CLOSED_ENTITY_HASH_MISMATCH", entityType);
      }
      return payload as T & { version: number };
    });
  }

  event(params: {
    entity_type: string;
    entity_id: string;
    event_type: string;
    old_state?: string | null;
    new_state?: string | null;
    actor: string;
    correlation_id?: string | null;
    metadata?: Record<string, unknown> | null;
  }): string {
    // R4 §1: events are canonical too — no secret material in metadata or
    // state fields.
    PairEvidenceStore.assertSecretFree({
      metadata: params.metadata ?? null,
      old_state: params.old_state ?? null,
      new_state: params.new_state ?? null,
    });
    const eventId = newId("EVT");
    const body = {
      event_id: eventId,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      event_type: params.event_type,
      old_state: params.old_state ?? null,
      new_state: params.new_state ?? null,
      actor: params.actor,
      correlation_id: params.correlation_id ?? null,
      metadata: params.metadata ?? null,
      created_at: utcnow(),
    };
    const hash = digest(body);
    this.db
      .prepare(
        `INSERT INTO events (event_id, entity_type, entity_id, event_type, old_state,
           new_state, actor, correlation_id, metadata_json, created_at, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        body.entity_type,
        body.entity_id,
        body.event_type,
        body.old_state,
        body.new_state,
        body.actor,
        body.correlation_id,
        body.metadata ? canonicalJson(body.metadata) : null,
        body.created_at,
        hash,
      );
    return eventId;
  }

  listEvents(entityType?: string, entityId?: string): Array<Record<string, unknown>> {
    let sql = "SELECT * FROM events";
    const args: string[] = [];
    const conds: string[] = [];
    if (entityType) {
      conds.push("entity_type=?");
      args.push(entityType);
    }
    if (entityId) {
      conds.push("entity_id=?");
      args.push(entityId);
    }
    if (conds.length) {
      sql += " WHERE " + conds.join(" AND ");
    }
    sql += " ORDER BY seq";
    if (this.readBudget) sql += ` LIMIT ${this.readBudget.events + 1}`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    this.charge("events", rows.length);
    return rows.map(row => this.verifiedEvent(row));
  }

  /** seq-cursor page: the SSE delta path must bound its read, never
   *  materialize the whole journal per poll. */
  listEventsSince(sinceSeq: number, limit = 1024): Array<Record<string, unknown>> {
    const lim = this.pageLimit(limit);
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
      throw new IntegrityError("FAIL_CLOSED_STORE_PAGE_SCHEMA", "event cursor");
    }
    const materialize = this.readBudget ? Math.min(lim, this.readBudget.events + 1) : lim;
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(sinceSeq, materialize) as Array<Record<string, unknown>>;
    this.charge("events", rows.length);
    return rows.map(row => this.verifiedEvent(row));
  }

  appendEvidence(
    missionId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): { evidence_id: string; payload_hash: string } {
    PairEvidenceStore.assertSecretFree(payload);
    const evidenceId = newId("EVD");
    const body = { evidence_id: evidenceId, mission_id: missionId, kind, payload };
    this.db
      .prepare(
        `INSERT INTO governed_evidence (evidence_id, mission_id, kind, payload, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(evidenceId, missionId, kind, canonicalJson(body), digest(body), utcnow());
    return { evidence_id: evidenceId, payload_hash: digest(body) };
  }

  listEvidence(missionId?: string): Array<Record<string, unknown>> {
    const rows = (missionId
      ? this.db
          .prepare("SELECT * FROM governed_evidence WHERE mission_id=? ORDER BY seq")
          .all(missionId)
      : this.db.prepare("SELECT * FROM governed_evidence ORDER BY seq").all()) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
      } catch {
        throw new IntegrityError("FAIL_CLOSED_EVIDENCE_HASH_MISMATCH", String(row.evidence_id));
      }
      if (digest(payload) !== row.payload_hash) {
        throw new IntegrityError("FAIL_CLOSED_EVIDENCE_HASH_MISMATCH", String(row.evidence_id));
      }
      return { ...row, payload };
    });
  }

  recordPlanRevision(params: {
    mission_id: string;
    revision: number;
    plan_id: string;
    source: string;
    reason: string;
    proposal: unknown;
    /** F3 — execution-meaning digest (pair-plan-semantic.v1) computed by
     *  commitPlan over the COMMITTED task rows. Separate authority from
     *  proposal_digest (raw planner output provenance): identical planner
     *  proposals can differ semantically and vice-versa. Rejected replan
     *  candidates are never revisions — they live in replan_attempt rows. */
    plan_semantic_digest?: string;
    /** F3 R2 — exact attempt-bound commit identity for replan commits
     *  (pair-replan-commit.v1). Semantic digest alone is NOT a commit
     *  receipt: it proves plan meaning, never WHICH attempt committed
     *  this revision. Absent on non-replan commits. */
    replan_commit?: {
      recovery_id: string;
      replan_attempt_id: string;
      superseded_plan_id: string;
    };
  }): { revision_id: string; proposal_digest: string; plan_semantic_digest?: string } {
    const revisionId = newId("REV");
    const body = {
      revision_id: revisionId,
      mission_id: params.mission_id,
      revision: params.revision,
      plan_id: params.plan_id,
      source: params.source,
      reason: params.reason,
      proposal_digest: digest(params.proposal),
      plan_semantic_digest: params.plan_semantic_digest,
      ...(params.replan_commit
        ? {
            replan_commit: {
              contract: "pair-replan-commit.v1",
              recovery_id: params.replan_commit.recovery_id,
              replan_attempt_id: params.replan_commit.replan_attempt_id,
              superseded_plan_id: params.replan_commit.superseded_plan_id,
            },
          }
        : {}),
      timestamp: utcnow(),
    };
    this.db
      .prepare(
        `INSERT INTO mission_plan_revisions (revision_id, mission_id, revision, payload, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(revisionId, params.mission_id, params.revision, canonicalJson(body), digest(body), utcnow());
    return { revision_id: revisionId, proposal_digest: body.proposal_digest };
  }

  planRevisions(missionId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        "SELECT payload, payload_hash FROM mission_plan_revisions WHERE mission_id=? ORDER BY revision",
      )
      .all(missionId) as Array<{ payload: string; payload_hash: string }>;
    return rows.map((row) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        throw new IntegrityError("FAIL_CLOSED_PLAN_REVISION_HASH_MISMATCH", missionId);
      }
      if (digest(payload) !== row.payload_hash) {
        throw new IntegrityError("FAIL_CLOSED_PLAN_REVISION_HASH_MISMATCH", missionId);
      }
      return payload;
    });
  }

  /** Full-scan integrity check; returns count of verified rows per table. */
  verifyIntegrity(): Record<string, number> {
    return {
      entities: this.listAllRaw("entities").length,
      events: this.listEvents().length,
      governed_evidence: this.listEvidence().length,
      mission_plan_revisions: this.countPlanRevisions(),
    };
  }

  private listAllRaw(table: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(`SELECT entity_type, entity_id, payload, payload_hash FROM ${table}`)
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(row.payload));
      } catch {
        throw new IntegrityError(
          "FAIL_CLOSED_ENTITY_HASH_MISMATCH",
          `${row.entity_type}:${row.entity_id}`,
        );
      }
      if (digest(payload) !== row.payload_hash) {
        throw new IntegrityError(
          "FAIL_CLOSED_ENTITY_HASH_MISMATCH",
          `${row.entity_type}:${row.entity_id}`,
        );
      }
    }
    return rows;
  }

  private countPlanRevisions(): number {
    const rows = this.db
      .prepare("SELECT mission_id FROM mission_plan_revisions")
      .all() as Array<{ mission_id: string }>;
    const missions = new Set(rows.map((r) => r.mission_id));
    let count = 0;
    for (const m of missions) {
      count += this.planRevisions(m).length;
    }
    return count;
  }
}
