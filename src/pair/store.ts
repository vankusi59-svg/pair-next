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
import { canonicalJson, digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";

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

export interface StoredEntity {
  entity_type: string;
  entity_id: string;
  version: number;
  [key: string]: unknown;
}

export class PairEvidenceStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
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
    `);
  }

  close(): void {
    this.db.close();
  }

  private static assertSecretFree(value: unknown, pathLabel = ""): void {
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
    const row = this.db
      .prepare("SELECT payload, payload_hash FROM entities WHERE entity_type=? AND entity_id=?")
      .get(entityType, entityId) as { payload: string; payload_hash: string } | undefined;
    if (!row) {
      throw new NotFoundError(`${entityType}:${entityId}`);
    }
    const payload = JSON.parse(row.payload) as T;
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
      .prepare("SELECT payload, payload_hash FROM entities WHERE entity_type=?")
      .all(entityType) as Array<{ payload: string; payload_hash: string }>;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload) as T;
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
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const metadata = row.metadata_json ? JSON.parse(String(row.metadata_json)) : null;
      const body = {
        event_id: row.event_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        event_type: row.event_type,
        old_state: row.old_state,
        new_state: row.new_state,
        actor: row.actor,
        correlation_id: row.correlation_id,
        metadata,
        created_at: row.created_at,
      };
      if (digest(body) !== row.event_hash) {
        throw new IntegrityError("FAIL_CLOSED_EVENT_HASH_MISMATCH", String(row.event_id));
      }
      return { ...row, metadata };
    });
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
      const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
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
  }): { revision_id: string; proposal_digest: string } {
    const revisionId = newId("REV");
    const body = {
      revision_id: revisionId,
      mission_id: params.mission_id,
      revision: params.revision,
      plan_id: params.plan_id,
      source: params.source,
      reason: params.reason,
      proposal_digest: digest(params.proposal),
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
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
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
      const payload = JSON.parse(String(row.payload));
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
