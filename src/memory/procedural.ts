/**
 * Procedural Memory Manager
 *
 * Stores learned procedures (step-by-step instructions) with success/failure tracking.
 * Upserts on procedure name.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ProceduralMemoryEntry, ProceduralStep } from "../types.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("memory.procedural");

type Database = BetterSqlite3.Database;

export class ProceduralMemoryManager {
  constructor(private db: Database) {}

  /**
   * Save a procedure. Upserts on name.
   * Returns the ULID id.
   */
  save(entry: {
    name: string;
    description: string;
    steps: ProceduralStep[];
    /** P17 tenancy binding — writer-asserted; absent = UNSCOPED. */
    scopeBusinessId?: string | null;
    scopeObjectiveId?: string | null;
  }): string {
    const id = ulid();
    try {
      // Scope columns arrive via MIGRATION_V13; tolerate legacy schemas.
      const cols = new Set(
        (this.db.prepare("PRAGMA table_info(procedural_memory)").all() as Array<{ name: string }>)
          .map((c) => c.name),
      );
      const hasScope = cols.has("scope_business_id");
      const columnList = `id, name, description, steps${hasScope ? ", scope_business_id, scope_objective_id" : ""}`;
      const updateTail = hasScope
        ? `,
           scope_business_id = excluded.scope_business_id,
           scope_objective_id = excluded.scope_objective_id`
        : "";
      this.db.prepare(
        `INSERT INTO procedural_memory (${columnList})
         VALUES (${columnList.split(",").map(() => "?").join(", ")})
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           steps = excluded.steps${updateTail},
           updated_at = datetime('now')`,
      ).run(
        ...[
          id,
          entry.name,
          entry.description,
          JSON.stringify(entry.steps),
          ...(hasScope ? [entry.scopeBusinessId ?? null, entry.scopeObjectiveId ?? null] : []),
        ],
      );
    } catch (error) {
      logger.error("Failed to save", error instanceof Error ? error : undefined);
    }
    return id;
  }

  /**
   * Get a procedure by name.
   */
  get(name: string): ProceduralMemoryEntry | undefined {
    try {
      const row = this.db.prepare(
        "SELECT * FROM procedural_memory WHERE name = ?",
      ).get(name) as any | undefined;
      return row ? deserializeProcedural(row) : undefined;
    } catch (error) {
      logger.error("Failed to get", error instanceof Error ? error : undefined);
      return undefined;
    }
  }

  /**
   * Record a success or failure outcome for a named procedure.
   */
  recordOutcome(name: string, success: boolean): void {
    try {
      const column = success ? "success_count" : "failure_count";
      this.db.prepare(
        `UPDATE procedural_memory SET ${column} = ${column} + 1, last_used_at = datetime('now'), updated_at = datetime('now') WHERE name = ?`,
      ).run(name);
    } catch (error) {
      logger.error("Failed to record outcome", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Search procedures by name or description.
   */
  search(query: string): ProceduralMemoryEntry[] {
    try {
      // Escape SQL LIKE wildcards so literal '%' and '_' in the query
      // don't match arbitrary characters.
      const escaped = query.replace(/[%_]/g, (ch) => `\\${ch}`);
      const rows = this.db.prepare(
        `SELECT * FROM procedural_memory
         WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
         ORDER BY success_count DESC, updated_at DESC`,
      ).all(`%${escaped}%`, `%${escaped}%`) as any[];
      return rows.map(deserializeProcedural);
    } catch (error) {
      logger.error("Failed to search", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Delete a procedure by name.
   */
  delete(name: string): void {
    try {
      this.db.prepare("DELETE FROM procedural_memory WHERE name = ?").run(name);
    } catch (error) {
      logger.error("Failed to delete", error instanceof Error ? error : undefined);
    }
  }
}

function deserializeProcedural(row: any): ProceduralMemoryEntry {
  let steps: ProceduralStep[] = [];
  try {
    steps = JSON.parse(row.steps || "[]");
  } catch {
    logger.error("Failed to parse steps for: " + row.name);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
