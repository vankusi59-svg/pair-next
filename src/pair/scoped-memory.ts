/**
 * P17 — scoped read of Layer-A cognitive memory for the Brain context.
 *
 * The automaton memory tables (semantic_memory, procedural_memory) are
 * NON-AUTHORITATIVE model-writable stores (Layer A — every row carries
 * trust_class/source_kind; P4). P17 adds a tenancy binding
 * (scope_business_id / scope_objective_id, MIGRATION_V13) so a read can
 * be confined to one objective's scope:
 *
 *   - scope_objective_id = <objective>            → objective-private
 *   - scope_business_id = <business>, obj NULL    → business-shared
 *   - both NULL                                  → UNSCOPED — never
 *     admitted to a scoped read (the P16-A cross-scope poisoning
 *     window stays closed)
 *   - any other scope                            → foreign — excluded
 *
 * The writer asserts scope; nothing here TRUSTS it — the scope only
 * narrows which objective's advisory surface a row can reach, so a
 * falsely-scoped row can never read another objective's data (it can
 * only mis-land its own bytes). Rows stay MODEL_HYPOTHESIS advisory:
 * consumers see trust metadata, never canonical truth.
 *
 * Schema-tolerant: a legacy table without the scope columns treats
 * every row as UNSCOPED — nothing is admitted, counts stay honest.
 */
import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

/** Per-table item cap — a Brain section is a bounded projection, not a
 *  memory dump. */
export const SCOPED_MEMORY_LIMIT = 32;

export interface ScopedMemoryEntry {
  kind: "semantic" | "procedural";
  id: string;
  /** semantic: key; procedural: name. */
  name: string;
  /** semantic: category; procedural: null. */
  category: string | null;
  /** semantic: value; procedural: description. */
  content: string;
  confidence: number | null;
  success_count: number | null;
  failure_count: number | null;
  trust_class: string | null;
  source_kind: string | null;
  evidence_refs: string[];
  scope_business_id: string | null;
  scope_objective_id: string | null;
}

export interface ScopedMemoryResult {
  semantic: ScopedMemoryEntry[];
  procedural: ScopedMemoryEntry[];
  /** Rows carrying no tenancy binding — real but never admitted. */
  excluded_unscoped: number;
  /** Rows bound to another business/objective — never admitted. */
  excluded_out_of_scope: number;
}

function columns(db: Database, table: string): Set<string> {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name),
    );
  } catch {
    return new Set();
  }
}

function evidenceRefsOf(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).slice(0, 16) : [];
  } catch {
    return [];
  }
}

/** Content bound — memory values are model-writable free text; the
 *  projection caps each entry so a poisoned blob cannot flood the
 *  Brain's bounded advisory surface. */
const CONTENT_CAP = 512;

export class ScopedMemoryReader {
  constructor(private readonly db: Database) {}

  /** Zero-write scoped recall for one objective's tenancy. */
  scopedFor(scope: { business_id: string; objective_id: string }): ScopedMemoryResult {
    const result: ScopedMemoryResult = {
      semantic: [],
      procedural: [],
      excluded_unscoped: 0,
      excluded_out_of_scope: 0,
    };
    result.semantic = this.readTable("semantic_memory", scope, result);
    result.procedural = this.readTable("procedural_memory", scope, result);
    return result;
  }

  private readTable(
    table: "semantic_memory" | "procedural_memory",
    scope: { business_id: string; objective_id: string },
    result: ScopedMemoryResult,
  ): ScopedMemoryEntry[] {
    const cols = columns(this.db, table);
    if (!cols.has("id")) return []; // table absent — nothing to read
    const hasScope = cols.has("scope_business_id") && cols.has("scope_objective_id");
    const hasTrust = cols.has("trust_class");
    const isSemantic = table === "semantic_memory";
    if (!hasScope) {
      // Legacy schema: every row is UNSCOPED — nothing admitted.
      try {
        result.excluded_unscoped += Number(
          (this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n,
        );
      } catch { /* count is best-effort */ }
      return [];
    }
    // The admission predicate in SQL — a scoped read must be bounded at
    // the query level, not by post-filtering an unbounded SELECT.
    const admit =
      `(scope_objective_id = ? AND (scope_business_id IS NULL OR scope_business_id = ?))` +
      ` OR (scope_objective_id IS NULL AND scope_business_id = ?)`;
    const unscoped = `scope_objective_id IS NULL AND scope_business_id IS NULL`;
    const orderParts = [
      ...(cols.has(isSemantic ? "confidence" : "success_count")
        ? [`${isSemantic ? "confidence" : "success_count"} DESC`]
        : []),
      ...(cols.has("updated_at") ? ["updated_at DESC"] : []),
      "id ASC",
    ];
    const orderBy = `ORDER BY ${orderParts.join(", ")}`;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare(`SELECT * FROM ${table} WHERE ${admit} ${orderBy} LIMIT ?`)
        .all(scope.objective_id, scope.business_id, scope.business_id, SCOPED_MEMORY_LIMIT) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
    // Exclusion counts are honesty metadata — a count failure degrades
    // the note, never the admitted projection itself.
    try {
      result.excluded_unscoped += Number(
        (this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${unscoped}`).get() as { n: number }).n,
      );
      result.excluded_out_of_scope += Number(
        (this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE NOT (${unscoped}) AND NOT (${admit})`)
          .get(scope.objective_id, scope.business_id, scope.business_id) as { n: number }).n,
      );
    } catch { /* counts best-effort */ }
    return rows.map((r) => ({
      kind: isSemantic ? ("semantic" as const) : ("procedural" as const),
      id: String(r.id),
      name: String(isSemantic ? r.key : r.name),
      category: isSemantic ? String(r.category ?? "") || null : null,
      content: String(isSemantic ? r.value : r.description).slice(0, CONTENT_CAP),
      confidence: isSemantic ? Number(r.confidence ?? 1) : null,
      success_count: isSemantic ? null : Number(r.success_count ?? 0),
      failure_count: isSemantic ? null : Number(r.failure_count ?? 0),
      trust_class: hasTrust && r.trust_class != null ? String(r.trust_class) : null,
      source_kind: hasTrust && r.source_kind != null ? String(r.source_kind) : null,
      evidence_refs: hasTrust ? evidenceRefsOf(r.evidence_refs) : [],
      scope_business_id: r.scope_business_id != null ? String(r.scope_business_id) : null,
      scope_objective_id: r.scope_objective_id != null ? String(r.scope_objective_id) : null,
    }));
  }
}
