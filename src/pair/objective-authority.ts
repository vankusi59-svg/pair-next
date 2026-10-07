/**
 * P15.1 Objective Authority — canonical governed Objective + KPI model.
 *
 * Turns a natural-language/business objective into durable, auditable
 * governed state. This is authority/state ONLY: no CEO loop, no planner,
 * no router, no executor wiring — those land in P15.2+.
 *
 * Rules carried over from the canonical store invariants:
 * - ONE writer: this service is the only writer of canonical `objective`
 *   rows carrying schema `pair.os.vnext.objective.v1`. (Legacy pre-P15.1
 *   goal-tree rows remain readable via `list`/`BusinessLayer.listObjectives`
 *   but every authority operation fails closed on them.)
 * - Mutability boundary:
 *     A) runtime/progress state — kpi.current, evidence_refs,
 *        budget.consumed_microusd, status — updated ONLY through the
 *        narrow typed seams below.
 *     B) owner-protected terms — owner_authority_id, KPI targets/baselines,
 *        budget ceiling, deadline, hard constraints, success/stop
 *        conditions, title/description/statement, parent — change ONLY via
 *        `amend()` with actor === owner_authority_id.
 * - `objective_digest` binds identity + terms_version + protected terms;
 *   verified on every authority read (same self-consistency contract as
 *   agent-contract.ts).
 * - Dedup: `applied_evidence_keys` / `applied_spend_keys` make evidence
 *   and budget accounting replay-safe; deterministic `objective_id`
 *   (digest of business_id + dedup key) makes duplicate create converge.
 * - Fail-closed everywhere: IntegrityError on any violation; deadline
 *   enforcement commits in its own transaction (expireIfDue) BEFORE any
 *   mutation seam evaluates, so expiry is never rolled back with a
 *   rejected mutation.
 */

import { canonicalJson, digest, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

export const OBJECTIVE_SCHEMA = "pair.os.vnext.objective.v1";
export const OBJECTIVE_ENTITY = "objective";

export const OBJECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "ACHIEVED",
  "INFEASIBLE",
  "EXPIRED",
  "CANCELLED",
] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** Terminal statuses — no transition out, no self-resurrection. */
export const TERMINAL_OBJECTIVE_STATUSES: ReadonlySet<ObjectiveStatus> = new Set([
  "ACHIEVED",
  "INFEASIBLE",
  "EXPIRED",
  "CANCELLED",
]);

const OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, readonly ObjectiveStatus[]> = {
  ACTIVE: ["PAUSED", "BLOCKED", "ACHIEVED", "INFEASIBLE", "EXPIRED", "CANCELLED"],
  PAUSED: ["ACTIVE", "BLOCKED", "ACHIEVED", "INFEASIBLE", "EXPIRED", "CANCELLED"],
  BLOCKED: ["ACTIVE", "PAUSED", "ACHIEVED", "INFEASIBLE", "EXPIRED", "CANCELLED"],
  ACHIEVED: [],
  INFEASIBLE: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const KPI_DIRECTIONS = ["AT_LEAST", "AT_MOST", "EXACT"] as const;
export type KpiDirection = (typeof KPI_DIRECTIONS)[number];

/** Verification-authority kinds accepted on progress/evidence records.
 *  A progress claim without one of these is a self-report — rejected. */
const VERIFIER_KINDS = new Set(["operator", "mission", "service", "artifact"]);

/** On-row dedup ledgers are bounded — an overflow fails closed rather
 *  than letting the row grow without limit. */
const LEDGER_CAP = 4096;
const CONSTRAINT_CAP = 256;

type Row = Record<string, unknown> & { version: number };

export interface ObjectiveKpi {
  kpi_id: string;
  name: string;
  unit: string;
  direction: KpiDirection;
  baseline: number;
  target: number;
  current: number | null;
  last_evidence_key: string | null;
  updated_at: string;
}

export interface ObjectiveEvidence {
  evidence_key: string;
  verifier: string;
  source: string;
  kind: "PROGRESS" | "EVIDENCE";
  kpi_id?: string;
  note?: string;
  attached_at: string;
}

export interface ObjectiveBudget {
  ceiling_microusd: number;
  consumed_microusd: number;
  currency: string;
}

/** Group-B protected terms — everything `amend()` may touch, and nothing
 *  else. This set is the amendment whitelist AND the digest domain. */
const AMENDABLE_KEYS = new Set([
  "title",
  "description",
  "statement",
  "parent_objective_id",
  "metric",
  "target",
  "kpis",
  "deadline",
  "budget_ceiling_microusd",
  "currency",
  "hard_constraints",
  "success_conditions",
  "stop_conditions",
  "owner_authority_id",
]);

function assertStr(field: string, value: unknown, { empty = false } = {}): string {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `${field} invalid`);
  }
  return value;
}

function assertOptStr(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return assertStr(field, value);
}

function assertNum(field: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `${field} must be finite number`);
  }
  return n;
}

/** Integer microusd only — never floats (cost.ts convention). */
function assertMicrousd(field: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_BUDGET", `${field}=${String(value)}`);
  }
  return n;
}

function normalizeStringList(field: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > CONSTRAINT_CAP ||
    value.some((v) => typeof v !== "string" || !v.trim())
  ) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `${field} must be string[] (≤${CONSTRAINT_CAP})`);
  }
  return value.map((v) => String(v).trim());
}

function normalizeDeadline(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const s = assertStr("deadline", value);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `deadline unparseable: ${s}`);
  }
  return new Date(t).toISOString();
}

const KPI_KEYS = new Set([
  "kpi_id",
  "name",
  "unit",
  "direction",
  "baseline",
  "target",
  "current",
  "last_evidence_key",
  "updated_at",
]);

function normalizeKpis(
  value: unknown,
  existing?: Map<string, ObjectiveKpi>,
): ObjectiveKpi[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", "kpis must be an array");
  }
  const out: ObjectiveKpi[] = [];
  const seen = new Set<string>();
  value.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `kpis[${i}] must be an object`);
    }
    for (const k of Object.keys(raw as Record<string, unknown>)) {
      if (!KPI_KEYS.has(k)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `kpis[${i}] unknown field ${k}`);
      }
    }
    const src = raw as Record<string, unknown>;
    const kpiId = src.kpi_id === undefined || src.kpi_id === null || src.kpi_id === ""
      ? `KPI_${i + 1}`
      : assertStr(`kpis[${i}].kpi_id`, src.kpi_id);
    if (seen.has(kpiId)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `duplicate kpi_id ${kpiId}`);
    }
    seen.add(kpiId);
    const direction = String(src.direction ?? "AT_LEAST") as KpiDirection;
    if (!(KPI_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", `kpis[${i}].direction ${direction}`);
    }
    const prior = existing?.get(kpiId);
    // `current` is runtime authority (group A) — never owner-editable via
    // amend; a surviving kpi_id keeps its verified progress, a new one
    // starts null.
    const current = prior ? prior.current : null;
    out.push({
      kpi_id: kpiId,
      name: assertStr(`kpis[${i}].name`, src.name),
      unit: typeof src.unit === "string" ? src.unit : "",
      direction,
      baseline: assertNum(`kpis[${i}].baseline`, src.baseline ?? 0),
      target: assertNum(`kpis[${i}].target`, src.target),
      current,
      last_evidence_key: prior ? prior.last_evidence_key : null,
      updated_at: prior ? String(prior.updated_at) : utcnow(),
    });
  });
  return out;
}

/** Terms identity — the digest domain. Mutable progress/budget/status
 *  fields are deliberately outside it. */
function termsOf(row: Row): Record<string, unknown> {
  const budget = (row.budget ?? {}) as Record<string, unknown>;
  return {
    title: row.title,
    description: row.description,
    statement: row.statement,
    parent_objective_id: row.parent_objective_id,
    metric: row.metric,
    target: row.target,
    kpis: (row.kpis as ObjectiveKpi[]).map((k) => ({
      kpi_id: k.kpi_id,
      name: k.name,
      unit: k.unit,
      direction: k.direction,
      baseline: k.baseline,
      target: k.target,
    })),
    deadline: row.deadline,
    budget_ceiling_microusd: budget.ceiling_microusd,
    currency: budget.currency,
    hard_constraints: row.hard_constraints,
    success_conditions: row.success_conditions,
    stop_conditions: row.stop_conditions,
    owner_authority_id: row.owner_authority_id,
  };
}

export function objectiveDigest(row: {
  objective_id: string;
  business_id: string;
  terms_version: number;
  terms: Record<string, unknown>;
}): string {
  return digest({
    schema: OBJECTIVE_SCHEMA,
    objective_id: row.objective_id,
    business_id: row.business_id,
    terms_version: row.terms_version,
    terms: row.terms,
  });
}

function verifierKind(verifier: string): string {
  const i = verifier.indexOf(":");
  return i > 0 ? verifier.slice(0, i) : "";
}

export class ObjectiveAuthorityService {
  constructor(private readonly store: PairEvidenceStore) {}

  /** Deterministic objective identity: same business + same dedup key →
   *  same id, so a duplicate create converges onto one canonical row. */
  objectiveIdFor(businessId: string, dedupKey: string): string {
    return `OBJ_${digest(`objective:${businessId}:${dedupKey}`).slice(0, 24)}`;
  }

  private defaultDedupKey(input: { title: string; statement?: string | null; description?: string | null }): string {
    return canonicalJson({ title: input.title, statement: input.statement ?? input.description ?? "" });
  }

  /** Strict read: schema + digest + enum/shape validation. Legacy
   *  pre-P15.1 rows (no schema_version) fail closed here. */
  get(objectiveId: string): Row {
    const row = this.store.get(OBJECTIVE_ENTITY, objectiveId);
    this.assertCanonicalRow(row);
    return row;
  }

  /** Display-path list — tolerant: returns rows as stored (legacy
   *  goal-tree rows included); never used for authority decisions. */
  list(businessId?: string): Row[] {
    const all = this.store.list(OBJECTIVE_ENTITY);
    return (businessId ? all.filter((o) => String(o.business_id) === businessId) : all)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  /** Canonical row contract — recomputed digest must self-verify. */
  assertCanonicalRow(row: Row): void {
    if (String(row.schema_version) !== OBJECTIVE_SCHEMA) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_SCHEMA",
        `${String(row.objective_id ?? row.entity_id)}:${String(row.schema_version ?? "absent")}`,
      );
    }
    if (!(OBJECTIVE_STATUSES as readonly string[]).includes(String(row.status))) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `status=${String(row.status)}`);
    }
    const budget = row.budget as Record<string, unknown> | undefined;
    if (!budget || !Number.isInteger(budget.ceiling_microusd) || !Number.isInteger(budget.consumed_microusd) ||
        Number(budget.ceiling_microusd) < 0 || Number(budget.consumed_microusd) < 0) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "budget");
    }
    const tv = Number(row.terms_version);
    if (!Number.isInteger(tv) || tv < 1) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "terms_version");
    }
    const recomputed = objectiveDigest({
      objective_id: String(row.objective_id),
      business_id: String(row.business_id),
      terms_version: tv,
      terms: termsOf(row),
    });
    if (recomputed !== String(row.objective_digest)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_DIGEST", `${String(row.objective_id)}@${tv}`);
    }
  }

  private assertScope(row: Row, businessId: string): void {
    if (String(row.business_id) !== businessId) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_SCOPE",
        `objective ${String(row.objective_id)} in ${String(row.business_id)} != ${businessId}`,
      );
    }
  }

  private assertOwner(row: Row, actor: string): void {
    if (String(row.owner_authority_id) !== actor) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_AUTHORITY",
        `actor ${actor} is not owner ${String(row.owner_authority_id)}`,
      );
    }
  }

  private assertNotTerminal(row: Row): void {
    if (TERMINAL_OBJECTIVE_STATUSES.has(row.status as ObjectiveStatus)) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_TERMINAL",
        `${String(row.objective_id)} is ${String(row.status)}`,
      );
    }
  }

  /**
   * Deadline enforcement runs in its OWN committed transaction BEFORE the
   * caller's mutation: a live objective past deadline converges to EXPIRED
   * even when the mutation itself is rejected (a throw inside the mutation
   * transaction would roll the expiry back). Time expiry is deterministic
   * objective state, not a caller authority op — actor is the authority
   * itself, not whoever happened to call. Idempotent and scope-free.
   */
  private expireIfDue(objectiveId: string, nowIso?: string): void {
    const now = nowIso ?? utcnow();
    const row = this.store.tryGet(OBJECTIVE_ENTITY, objectiveId);
    if (!row) return;
    if (String(row.schema_version) !== OBJECTIVE_SCHEMA) return;
    const deadline = row.deadline ? String(row.deadline) : null;
    const from = String(row.status) as ObjectiveStatus;
    if (!deadline || now <= deadline || TERMINAL_OBJECTIVE_STATUSES.has(from)) return;
    this.store.immediate(() => {
      const fresh = this.get(objectiveId); // strict re-read inside tx
      const f = String(fresh.status) as ObjectiveStatus;
      const d = fresh.deadline ? String(fresh.deadline) : null;
      if (!d || now <= d || TERMINAL_OBJECTIVE_STATUSES.has(f)) return;
      fresh.status = "EXPIRED";
      fresh.status_reason = `deadline ${d} passed`;
      fresh.updated_at = utcnow();
      this.store.put(OBJECTIVE_ENTITY, objectiveId, fresh, Number(fresh.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_STATUS",
        old_state: f,
        new_state: "EXPIRED",
        actor: "PAIR_OBJECTIVE_AUTHORITY",
        metadata: { reason: "deadline_exceeded", deadline: d },
      });
    });
  }

  // ---------- canonical operations ----------

  /**
   * create objective — deterministic id from (business_id, dedup_key):
   * a duplicate create converges onto the single canonical row instead
   * of minting a second objective.
   */
  create(input: {
    business_id: string;
    title?: string;
    description?: string;
    statement?: string;
    parent_objective_id?: string;
    owner_authority_id?: string;
    metric?: string;
    target?: string;
    kpis?: Array<Record<string, unknown>>;
    deadline?: string | null;
    budget_ceiling_microusd?: number;
    currency?: string;
    hard_constraints?: string[];
    success_conditions?: string[];
    stop_conditions?: string[];
    dedup_key?: string;
    operator_id: string;
  }): Row {
    if (!input.operator_id) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.create");
    }
    const businessId = assertStr("business_id", input.business_id);
    // fail-closed: the business must exist for the objective to bind to it.
    this.store.get("business", businessId);
    const title = String(input.title ?? "").trim();
    const statement = String(input.statement ?? "").trim() || null;
    if (!title && !statement) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", "title or statement required");
    }
    const ownerAuthority = input.owner_authority_id
      ? assertStr("owner_authority_id", input.owner_authority_id)
      : `operator:${input.operator_id}`;
    let parentId: string | null = null;
    if (input.parent_objective_id) {
      const parent = this.get(input.parent_objective_id);
      if (String(parent.business_id) !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCOPE", `parent outside business ${businessId}`);
      }
      parentId = input.parent_objective_id;
    }
    // Legacy display fields stay; metric+target without explicit kpis
    // synthesize one KPI when target parses numerically.
    let kpis = normalizeKpis(input.kpis);
    if (!kpis.length && input.metric && input.target !== undefined) {
      const t = Number(input.target);
      if (Number.isFinite(t)) {
        kpis = normalizeKpis([{ name: input.metric, target: t }]);
      }
    }
    const dedupKey = input.dedup_key ?? this.defaultDedupKey({ title, statement, description: input.description });
    const id = this.objectiveIdFor(businessId, dedupKey);
    const row: Row = {
      objective_id: id,
      business_id: businessId,
      owner_authority_id: ownerAuthority,
      title,
      description: String(input.description ?? ""),
      statement,
      parent_objective_id: parentId,
      metric: String(input.metric ?? ""),
      target: String(input.target ?? ""),
      kpis,
      deadline: normalizeDeadline(input.deadline),
      budget: {
        ceiling_microusd: assertMicrousd("budget_ceiling_microusd", input.budget_ceiling_microusd ?? 0),
        consumed_microusd: 0,
        currency: input.currency ? assertStr("currency", input.currency) : "USD",
      },
      hard_constraints: normalizeStringList("hard_constraints", input.hard_constraints),
      success_conditions: normalizeStringList("success_conditions", input.success_conditions),
      stop_conditions: normalizeStringList("stop_conditions", input.stop_conditions),
      status: "ACTIVE" as ObjectiveStatus,
      status_reason: null,
      evidence_refs: [] as ObjectiveEvidence[],
      applied_evidence_keys: [] as string[],
      applied_spend_keys: [] as string[],
      terms_version: 1,
      amendment_seq: 0,
      last_amendment: null,
      schema_version: OBJECTIVE_SCHEMA,
      actor: `operator:${input.operator_id}`,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
    row.objective_digest = objectiveDigest({
      objective_id: id,
      business_id: businessId,
      terms_version: 1,
      terms: termsOf(row),
    });
    try {
      return this.store.immediate(() => {
        const saved = this.store.put(OBJECTIVE_ENTITY, id, row, 0);
        this.store.event({
          entity_type: OBJECTIVE_ENTITY,
          entity_id: id,
          event_type: "OBJECTIVE_CREATED",
          new_state: "ACTIVE",
          actor: `operator:${input.operator_id}`,
          metadata: { business_id: businessId, title, owner_authority_id: ownerAuthority },
        });
        return saved;
      });
    } catch (err) {
      // Duplicate/concurrent create — adopt the canonical winner.
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        return this.get(id);
      }
      throw err;
    }
  }

  /** Verified KPI progress — group-A mutation. `value` is an absolute
   *  verified measurement; the evidence identity dedups replays so the
   *  same evidence can never increment twice. */
  recordProgress(
    objectiveId: string,
    input: {
      business_id: string;
      kpi_id: string;
      value: number;
      evidence: { evidence_key: string; verifier: string; source: string };
      note?: string;
      actor: string;
    },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.progress");
    const businessId = assertStr("business_id", input.business_id);
    const value = assertNum("value", input.value);
    const ev = this.assertEvidence(input.evidence);
    this.expireIfDue(objectiveId);
    return this.store.immediate(() => {
      const row = this.get(objectiveId);
      this.assertScope(row, businessId);
      this.assertNotTerminal(row);
      const keys = row.applied_evidence_keys as string[];
      if (keys.includes(ev.evidence_key)) {
        return row; // replay — idempotent no-op, never double-counts
      }
      const kpis = row.kpis as ObjectiveKpi[];
      const kpi = kpis.find((k) => k.kpi_id === input.kpi_id);
      if (!kpi) {
        throw new NotFoundError(`objective ${objectiveId} kpi ${input.kpi_id}`);
      }
      if (keys.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      const now = utcnow();
      kpi.current = value;
      kpi.last_evidence_key = ev.evidence_key;
      kpi.updated_at = now;
      keys.push(ev.evidence_key);
      (row.evidence_refs as ObjectiveEvidence[]).push({
        ...ev,
        kind: "PROGRESS",
        kpi_id: kpi.kpi_id,
        note: input.note,
        attached_at: now,
      });
      row.updated_at = now;
      const saved = this.store.put(OBJECTIVE_ENTITY, objectiveId, row, Number(row.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_PROGRESS",
        actor: input.actor,
        metadata: {
          kpi_id: kpi.kpi_id,
          value,
          evidence_key: ev.evidence_key,
          verifier: ev.verifier,
        },
      });
      return saved;
    });
  }

  /** Attach verified evidence without a KPI write. */
  attachEvidence(
    objectiveId: string,
    input: {
      business_id: string;
      evidence: { evidence_key: string; verifier: string; source: string };
      note?: string;
      actor: string;
    },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.attachEvidence");
    const businessId = assertStr("business_id", input.business_id);
    const ev = this.assertEvidence(input.evidence);
    this.expireIfDue(objectiveId);
    return this.store.immediate(() => {
      const row = this.get(objectiveId);
      this.assertScope(row, businessId);
      this.assertNotTerminal(row);
      const keys = row.applied_evidence_keys as string[];
      if (keys.includes(ev.evidence_key)) {
        return row;
      }
      if (keys.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      const now = utcnow();
      keys.push(ev.evidence_key);
      (row.evidence_refs as ObjectiveEvidence[]).push({
        ...ev,
        kind: "EVIDENCE",
        note: input.note,
        attached_at: now,
      });
      row.updated_at = now;
      const saved = this.store.put(OBJECTIVE_ENTITY, objectiveId, row, Number(row.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_EVIDENCE_ATTACHED",
        actor: input.actor,
        metadata: { evidence_key: ev.evidence_key, verifier: ev.verifier },
      });
      return saved;
    });
  }

  /** Budget accounting — integer microusd, spend_key dedup, hard ceiling. */
  accountBudget(
    objectiveId: string,
    input: {
      business_id: string;
      spend_key: string;
      amount_microusd: number;
      note?: string;
      actor: string;
    },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.accountBudget");
    const businessId = assertStr("business_id", input.business_id);
    const spendKey = assertStr("spend_key", input.spend_key);
    const amount = assertMicrousd("amount_microusd", input.amount_microusd);
    this.expireIfDue(objectiveId);
    return this.store.immediate(() => {
      const row = this.get(objectiveId);
      this.assertScope(row, businessId);
      this.assertNotTerminal(row);
      const keys = row.applied_spend_keys as string[];
      if (keys.includes(spendKey)) {
        return row; // replay — idempotent, never double-spends
      }
      const budget = row.budget as ObjectiveBudget;
      const next = Number(budget.consumed_microusd) + amount;
      if (next > Number(budget.ceiling_microusd)) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED",
          `${objectiveId}: consumed=${next} ceiling=${budget.ceiling_microusd}`,
        );
      }
      if (keys.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      budget.consumed_microusd = next;
      keys.push(spendKey);
      row.updated_at = utcnow();
      const saved = this.store.put(OBJECTIVE_ENTITY, objectiveId, row, Number(row.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_BUDGET_ACCOUNTED",
        actor: input.actor,
        metadata: { spend_key: spendKey, amount_microusd: amount, consumed_microusd: next },
      });
      return saved;
    });
  }

  /** Owner-authorized status transition — bounded table, terminal states
   *  have no exits. A past-deadline live objective always resolves to
   *  EXPIRED first. */
  transitionStatus(
    objectiveId: string,
    input: { business_id: string; to: ObjectiveStatus; reason?: string; actor: string },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.transition");
    const businessId = assertStr("business_id", input.business_id);
    const to = input.to;
    if (!(OBJECTIVE_STATUSES as readonly string[]).includes(to)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_STATUS", String(to));
    }
    // Past deadline converges to EXPIRED first — the transition table then
    // rejects every other target on its own (EXPIRED is terminal).
    this.expireIfDue(objectiveId);
    return this.store.immediate(() => {
      const row = this.get(objectiveId);
      this.assertScope(row, businessId);
      this.assertOwner(row, input.actor);
      const from = row.status as ObjectiveStatus;
      if (!(OBJECTIVE_TRANSITIONS[from] ?? []).includes(to)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_TRANSITION", `${from} → ${to}`);
      }
      row.status = to;
      row.status_reason = input.reason ?? null;
      row.updated_at = utcnow();
      const saved = this.store.put(OBJECTIVE_ENTITY, objectiveId, row, Number(row.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_STATUS",
        old_state: from,
        new_state: to,
        actor: input.actor,
        metadata: { reason: input.reason ?? null },
      });
      return saved;
    });
  }

  /**
   * Owner-authorized amendment — the ONLY seam that may change protected
   * terms (group B). Patch keys are whitelisted; unknown/protected
   * mutation attempts fail closed. terms_version bumps and the digest is
   * rebound, so any stale pin/derivation provably diverges.
   */
  amend(
    objectiveId: string,
    input: { business_id: string; patch: Record<string, unknown>; reason?: string; actor: string },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.amend");
    const businessId = assertStr("business_id", input.business_id);
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", "patch must be an object");
    }
    for (const k of Object.keys(input.patch)) {
      if (!AMENDABLE_KEYS.has(k)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_TERMS", `not owner-amendable: ${k}`);
      }
    }
    this.expireIfDue(objectiveId);
    return this.store.immediate(() => {
      const row = this.get(objectiveId);
      this.assertScope(row, businessId);
      this.assertOwner(row, input.actor);
      this.assertNotTerminal(row);
      const patch = input.patch;
      if (patch.title !== undefined) row.title = assertStr("title", patch.title).trim();
      if (patch.description !== undefined) row.description = assertStr("description", patch.description, { empty: true });
      if (patch.statement !== undefined) row.statement = assertOptStr("statement", patch.statement);
      if (patch.metric !== undefined) row.metric = assertStr("metric", patch.metric, { empty: true });
      if (patch.target !== undefined) row.target = assertStr("target", patch.target, { empty: true });
      if (patch.parent_objective_id !== undefined) {
        if (patch.parent_objective_id === null || patch.parent_objective_id === "") {
          row.parent_objective_id = null;
        } else {
          const parent = this.get(String(patch.parent_objective_id));
          if (String(parent.business_id) !== businessId) {
            throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCOPE", "parent outside business");
          }
          row.parent_objective_id = String(patch.parent_objective_id);
        }
      }
      if (patch.deadline !== undefined) row.deadline = normalizeDeadline(patch.deadline);
      if (patch.kpis !== undefined) {
        const existing = new Map((row.kpis as ObjectiveKpi[]).map((k) => [k.kpi_id, k]));
        row.kpis = normalizeKpis(patch.kpis, existing);
      }
      const budget = row.budget as ObjectiveBudget;
      if (patch.budget_ceiling_microusd !== undefined) {
        budget.ceiling_microusd = assertMicrousd("budget_ceiling_microusd", patch.budget_ceiling_microusd);
      }
      if (patch.currency !== undefined) budget.currency = assertStr("currency", patch.currency);
      if (patch.hard_constraints !== undefined) row.hard_constraints = normalizeStringList("hard_constraints", patch.hard_constraints);
      if (patch.success_conditions !== undefined) row.success_conditions = normalizeStringList("success_conditions", patch.success_conditions);
      if (patch.stop_conditions !== undefined) row.stop_conditions = normalizeStringList("stop_conditions", patch.stop_conditions);
      if (patch.owner_authority_id !== undefined) row.owner_authority_id = assertStr("owner_authority_id", patch.owner_authority_id);
      row.terms_version = Number(row.terms_version) + 1;
      row.amendment_seq = Number(row.amendment_seq) + 1;
      row.last_amendment = {
        seq: row.amendment_seq,
        by: input.actor,
        reason: input.reason ?? null,
        at: utcnow(),
        keys: Object.keys(patch),
      };
      row.objective_digest = objectiveDigest({
        objective_id: String(row.objective_id),
        business_id: businessId,
        terms_version: Number(row.terms_version),
        terms: termsOf(row),
      });
      row.updated_at = utcnow();
      const saved = this.store.put(OBJECTIVE_ENTITY, objectiveId, row, Number(row.version));
      this.store.event({
        entity_type: OBJECTIVE_ENTITY,
        entity_id: objectiveId,
        event_type: "OBJECTIVE_AMENDED",
        actor: input.actor,
        metadata: {
          seq: row.amendment_seq,
          terms_version: row.terms_version,
          keys: Object.keys(patch),
          reason: input.reason ?? null,
        },
      });
      return saved;
    });
  }

  /**
   * Deterministic deadline evaluation — the seam a future scheduler calls.
   * Idempotent: already-terminal or unexpired objectives return unchanged.
   */
  evaluateDeadline(objectiveId: string, nowIso?: string): Row {
    this.expireIfDue(objectiveId, nowIso);
    return this.get(objectiveId);
  }

  private assertEvidence(ev: unknown): ObjectiveEvidence {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_EVIDENCE", "evidence must be an object");
    }
    const src = ev as Record<string, unknown>;
    const evidenceKey = assertStr("evidence_key", src.evidence_key);
    const verifier = assertStr("verifier", src.verifier);
    if (!VERIFIER_KINDS.has(verifierKind(verifier))) {
      // A progress claim without a recognized verification authority is a
      // self-report — never authority.
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
        `verifier ${verifier}: not in ${[...VERIFIER_KINDS].join("|")}`,
      );
    }
    const source = assertStr("source", src.source);
    const out: ObjectiveEvidence = {
      evidence_key: evidenceKey,
      verifier,
      source,
      kind: "EVIDENCE",
      attached_at: "",
    };
    return out;
  }
}
