/**
 * P4 persistence convergence — ONE governed persistence plane.
 *
 * `PairPersistence` opens a single `pair-next.db` file carrying four
 * explicit namespaces, separated by table ownership:
 *
 *   runtime/*     — Automaton operational tables (identity, turns,
 *                   goals, task_graph, event_stream, heartbeat_*,
 *                   installed_tools, skills, kv, ... )
 *   cognitive/*   — Automaton memory tables (working_memory,
 *                   episodic_memory, semantic_memory, procedural_memory,
 *                   relationship_memory, knowledge_store, session_summaries)
 *                   — NON_AUTHORITATIVE; every model-writable row carries
 *                   trust_class / source_kind / evidence_refs.
 *   canonical/*   — PAIR governed tables owned by PairEvidenceStore
 *                   (entities, events, governed_evidence,
 *                   mission_plan_revisions, experiences)
 *   experience/*  — entity_type "experience" inside the canonical store
 *                   (advisory only, see experience.ts)
 *
 * Both sides share one SQLite file (WAL): AutomatonDatabase applies its
 * schema; PairEvidenceStore applies its canonical schema; table names
 * do not overlap, so canonical ownership is unambiguous — a table is
 * either canonical (entities/events/governed_evidence/mission_plan_revisions)
 * or not. Two better-sqlite3 connections to one WAL file are safe:
 * WAL permits concurrent readers and serializes writers.
 *
 * `PersistenceMigrator` moves an existing split deployment
 * (state.db + pair.db) into the unified file deterministically:
 * per-table copy inside a transaction, integrity checks before and
 * after, an idempotent `persistence_migrations` marker keyed on the
 * source fingerprints, and a trivial rollback path (sources are opened
 * read-only; deleting the target rolls back).
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";

type AutomatonDatabase = ReturnType<typeof createDatabase>;
import { sha256File, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { PairEvidenceStore } from "./store.js";

export const PAIR_NEXT_DB = "pair-next.db";

export type TableClass = "KEEP" | "MERGE" | "MIGRATE" | "DERIVED_ONLY" | "RETIRE";

/**
 * Deterministic migration map. Every Automaton/PAIR table is classified:
 *  KEEP         — copied verbatim into runtime/*
 *  MERGE        — copied into cognitive/* (Layer A, non-authoritative)
 *  MIGRATE      — canonical PAIR tables, copied into canonical/*
 *  DERIVED_ONLY — not a stored table at all (computed views)
 *  RETIRE       — legacy residue, not copied
 */
export const TABLE_CLASSIFICATION: Record<string, TableClass> = {
  // runtime/*
  schema_version: "KEEP",
  identity: "KEEP",
  turns: "KEEP",
  tool_calls: "KEEP",
  heartbeat_entries: "KEEP",
  heartbeat_schedule: "KEEP",
  heartbeat_history: "KEEP",
  wake_events: "KEEP",
  heartbeat_dedup: "KEEP",
  transactions: "KEEP",
  spend_tracking: "KEEP",
  inference_costs: "KEEP",
  model_registry: "KEEP",
  metric_snapshots: "KEEP",
  installed_tools: "KEEP",
  modifications: "KEEP",
  kv: "KEEP",
  skills: "KEEP",
  children: "KEEP",
  child_lifecycle_events: "KEEP",
  discovered_agents_cache: "KEEP",
  onchain_transactions: "KEEP",
  policy_decisions: "KEEP",
  inbox_messages: "KEEP",
  soul_history: "KEEP",
  goals: "KEEP",
  task_graph: "KEEP",
  event_stream: "KEEP",
  // cognitive/* (Layer A — non-authoritative)
  working_memory: "MERGE",
  episodic_memory: "MERGE",
  session_summaries: "MERGE",
  semantic_memory: "MERGE",
  procedural_memory: "MERGE",
  relationship_memory: "MERGE",
  knowledge_store: "MERGE",
  // canonical/* (Layer B — PAIR governed)
  entities: "MIGRATE",
  events: "MIGRATE",
  governed_evidence: "MIGRATE",
  mission_plan_revisions: "MIGRATE",
  experiences: "MIGRATE",
  persistence_migrations: "MIGRATE",
  // legacy residue from the removed Conway social/registry surfaces —
  // schema keeps creating them (harmless, empty); contents are not carried.
  registry: "RETIRE",
  reputation: "RETIRE",
};

export class PairPersistence {
  private constructor(
    public readonly automaton: AutomatonDatabase,
    public readonly store: PairEvidenceStore,
    public readonly dbPath: string,
  ) {}

  /**
   * Open the unified governed database at `<dir>/pair-next.db` (or an
   * explicit path). Both schemas are applied; WAL is on.
   */
  static open(dirOrPath: string): PairPersistence {
    const dbPath = dirOrPath.endsWith(".db") ? dirOrPath : path.join(dirOrPath, PAIR_NEXT_DB);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const automaton = createDatabase(dbPath);
    const store = new PairEvidenceStore(dbPath);
    return new PairPersistence(automaton, store, dbPath);
  }

  close(): void {
    this.store.close();
    this.automaton.close();
  }
}

export interface MigrationReport {
  source_state_db: string;
  source_pair_db: string | null;
  target_db: string;
  tables: Record<string, { class: TableClass; rows: number }>;
  skipped_idempotent: boolean;
  integrity_ok: boolean;
  canonical_verified: boolean;
}

export class PersistenceMigrator {
  /**
   * Migrate legacy `state.db` (+ optional `pair.db`) into `target`.
   * Sources are opened READ-ONLY; target receives all rows under one
   * transaction per table. Re-running is a no-op once the marker for the
   * same source fingerprint exists.
   */
  static migrate(opts: {
    stateDb: string;
    pairDb?: string;
    target: PairPersistence;
  }): MigrationReport {
    const targetDb = opts.target.automaton.raw;
    targetDb.exec(`
      CREATE TABLE IF NOT EXISTS persistence_migrations (
        migration_id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const fingerprintOf = (p: string | undefined) =>
      p && fs.existsSync(p) ? sha256File(p) : "ABSENT";
    const fingerprint = `${fingerprintOf(opts.stateDb)}|${fingerprintOf(opts.pairDb)}`;

    const existing = targetDb
      .prepare("SELECT report FROM persistence_migrations WHERE source_fingerprint = ?")
      .get(fingerprint) as { report: string } | undefined;
    if (existing) {
      const prior = JSON.parse(existing.report) as MigrationReport;
      return { ...prior, skipped_idempotent: true };
    }

    const integrity = (db: Database.Database) =>
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check === "ok";

    const tables: MigrationReport["tables"] = {};
    const copySource = (sourcePath: string, isCanonical: boolean) => {
      if (!fs.existsSync(sourcePath)) return;
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        if (!integrity(source)) {
          throw new IntegrityError("FAIL_CLOSED_SOURCE_INTEGRITY", sourcePath);
        }
        const sourceTables = (
          source
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>
        ).map((t) => t.name);
        for (const table of sourceTables) {
          if (table === "sqlite_sequence") continue;
          const cls =
            TABLE_CLASSIFICATION[table] ??
            (isCanonical ? "MIGRATE" : "KEEP");
          if (cls === "RETIRE" || cls === "DERIVED_ONLY") {
            tables[table] = { class: cls, rows: 0 };
            continue;
          }
          const rows = source.prepare(`SELECT * FROM "${table}"`).all() as Array<
            Record<string, unknown>
          >;
          if (!rows.length) {
            tables[table] = { class: cls, rows: 0 };
            continue;
          }
          const cols = Object.keys(rows[0]);
          const insert = targetDb.prepare(
            `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")})
             VALUES (${cols.map(() => "?").join(",")})`,
          );
          const run = targetDb.transaction(() => {
            for (const row of rows) insert.run(...cols.map((c) => row[c]));
          });
          run();
          tables[table] = { class: cls, rows: rows.length };
        }
      } finally {
        source.close();
      }
    };

    copySource(opts.stateDb, false);
    if (opts.pairDb) copySource(opts.pairDb, true);

    const integrityOk = integrity(targetDb);
    if (!integrityOk) {
      throw new IntegrityError("FAIL_CLOSED_TARGET_INTEGRITY", opts.target.dbPath);
    }
    const canonicalVerified = opts.target.store.verifyIntegrity() !== undefined;

    const report: MigrationReport = {
      source_state_db: opts.stateDb,
      source_pair_db: opts.pairDb ?? null,
      target_db: opts.target.dbPath,
      tables,
      skipped_idempotent: false,
      integrity_ok: integrityOk,
      canonical_verified: canonicalVerified,
    };
    targetDb
      .prepare(
        "INSERT INTO persistence_migrations (migration_id, source_fingerprint, report, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(`PMIG_${Date.now()}`, fingerprint, JSON.stringify(report), utcnow());
    return report;
  }

  /**
   * Rollback: sources were never modified; deleting the target file
   * returns the deployment to its split state.
   */
  static rollback(target: PairPersistence): void {
    const p = target.dbPath;
    target.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${p}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}
