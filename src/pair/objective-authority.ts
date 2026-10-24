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
 *   agent-contract.ts). Mutable runtime state outside the digest still
 *   satisfies every authority invariant on every read (budget
 *   0<=consumed<=ceiling, KPI shape, ledger shape — R2.C/R2.E).
 * - Verification is resolution, not prefix-matching (R2.A): a verifier
 *   must resolve to canonical authority — owner-authorized operator
 *   measurement, or a real mission/artifact row in the same business
 *   whose governed OBJECTIVE_PROGRESS evidence binds the claimed
 *   objective+kpi+value. Self-reports and non-resolvable kinds fail
 *   closed; "service" outcomes have no canonical verifier today.
 * - Dedup binds semantics (R2.B): `applied_evidence_keys` /
 *   `applied_spend_keys` store {key,digest} — same key + same digest is
 *   an idempotent replay, same key + different digest fails closed.
 *   Deterministic `objective_id` converges duplicate creates only when
 *   protected terms match; a same-id/different-terms create conflicts.
 * - The parent graph is acyclic (bounded deterministic traversal — R2.D).
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

/** Verification-authority kinds recognized on evidence records. The
 *  kind string is only a syntactic shape — it is NEVER authority by
 *  itself (R3.A: store-row existence is persistence integrity, not
 *  domain authority). In P15.1 exactly ONE seam may act:
 *   - operator:<id>  — explicit owner-authorized action: the verifier
 *     must equal owner_authority_id AND the actor must be the owner.
 *     This is the only seam that may attach evidence or move a KPI.
 *  Every other kind — mission:<id>, artifact:<id>, service, self-report,
 *  anything — is parsed only so it can be deterministically rejected by
 *  assertOwnerVerifier: PAIR has no reusable canonical provenance
 *  verifier for missions/artifacts today (R4.B Option A), so they fail
 *  closed rather than pretend verification. A future P15.5
 *  outcome/provenance seam must delegate to real canonical authority,
 *  not reimplement shape checks here.
 */
const VERIFIER_KINDS = new Set(["operator", "mission", "artifact", "kpi-verifier"]);

// P15.10-D — delegated verifier contract: verifier `kpi-verifier:<auth_id>`
// is authority ONLY through the grant+receipt proof in
// objective-kpi-verifier-authority.ts — never through the actor string.
import {
  KPI_VERIFIER_KIND,
  KPI_VERIFIER_WRITER,
  assertKpiVerifierAuthority,
} from "./objective-kpi-verifier-authority.js";

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

/* Refs that must never become an owner_authority_id — String()-coercion
   artifacts minted at any edge (missing header/body, object values).
   Mirror of mission-control-server's OPERATOR_COERCION_ARTIFACTS: the
   canonical layer enforces the shape so NO caller — HTTP or service —
   can mint an unclaimable owner (R2 M1′). */
const OWNER_REF_ARTIFACTS = new Set([
  "", "undefined", "null", "NaN", "Infinity", "[object Object]",
]);

/** Owner authority must be `operator:<ref>` — a whitespace-free,
 *  non-artifact ref. An owner that is not exactly this shape is
 *  permanently UNCLAIMABLE (every actor edge canonicalizes to
 *  operator:<x>, and coercion-artifact refs are rejected there), so
 *  minting one orphans the objective forever — even amend() could not
 *  repair it because assertOwner requires the unreachable actor. */
function assertOwnerAuthorityRef(field: string, value: unknown): string {
  const s = assertStr(field, value);
  const ref = s.startsWith("operator:") ? s.slice("operator:".length) : null;
  if (ref === null || !ref || /\s/.test(ref) || OWNER_REF_ARTIFACTS.has(ref)) {
    throw new IntegrityError(
      "FAIL_CLOSED_OBJECTIVE_FIELD",
      `${field} must be operator:<ref> — a non-canonical owner is permanently unclaimable`,
    );
  }
  return s;
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
  /** R4.A — the immutable create semantic digest is bound INTO the
   *  objective's self-consistency authority: any canonical-row rewrite
   *  of it breaks the digest and strict reads fail closed. Amendments
   *  recompute the digest retaining the exact original value. */
  create_semantic_digest: string;
}): string {
  return digest({
    schema: OBJECTIVE_SCHEMA,
    objective_id: row.objective_id,
    business_id: row.business_id,
    terms_version: row.terms_version,
    terms: row.terms,
    create_semantic_digest: row.create_semantic_digest,
  });
}

function verifierKind(verifier: string): string {
  const i = verifier.indexOf(":");
  return i > 0 ? verifier.slice(0, i) : "";
}

function verifierRef(verifier: string): string {
  const i = verifier.indexOf(":");
  return i > 0 ? verifier.slice(i + 1) : "";
}

/** On-row dedup ledger entry: the application key binds the canonical
 *  semantic digest of what was applied — same key + same semantics is a
 *  replay, same key + different semantics fails closed. */
export interface ObjectiveLedgerEntry {
  key: string;
  digest: string;
}

function ledgerOf(value: unknown): ObjectiveLedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "ledger");
  }
  if (value.length > LEDGER_CAP) {
    throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", "ledger");
  }
  const seen = new Set<string>();
  return value.map((e) => {
    // R3.D — strict runtime shape: only {key, digest} entries with
    // non-empty strings are canonical; a legacy bare string, an empty
    // digest, or a duplicate key (even with the same digest) is malformed
    // canonical state and fails closed.
    if (!e || typeof e !== "object" || Array.isArray(e) ||
        typeof (e as Record<string, unknown>).key !== "string" ||
        !(e as Record<string, unknown>).key ||
        typeof (e as Record<string, unknown>).digest !== "string" ||
        !(e as Record<string, unknown>).digest) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "ledger entry");
    }
    const key = (e as Record<string, unknown>).key as string;
    if (seen.has(key)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `duplicate ledger key ${key}`);
    }
    seen.add(key);
    return e as ObjectiveLedgerEntry;
  });
}

/** Semantic digest of a progress application: same evidence_key bound to
 *  different objective/kpi/value/verifier is NOT a replay — it is a
 *  conflict. Exported so downstream strict proofs (P15.5) reuse the ONE
 *  digest rule rather than duplicating it. */
export function progressSemantics(objectiveId: string, input: {
  kpi_id: string; value: number;
  evidence: { evidence_key: string; verifier: string; source: string };
}): string {
  return digest({
    kind: "PROGRESS",
    objective_id: objectiveId,
    kpi_id: input.kpi_id,
    value: input.value,
    evidence_key: input.evidence.evidence_key,
    verifier: input.evidence.verifier,
    source: input.evidence.source,
  });
}

function evidenceSemantics(objectiveId: string, ev: ObjectiveEvidence): string {
  return digest({
    kind: "EVIDENCE",
    objective_id: objectiveId,
    evidence_key: ev.evidence_key,
    verifier: ev.verifier,
    source: ev.source,
  });
}

export function spendSemantics(objectiveId: string, input: {
  spend_key: string; amount_microusd: number; note?: string;
}): string {
  return digest({
    kind: "SPEND",
    objective_id: objectiveId,
    spend_key: input.spend_key,
    amount_microusd: input.amount_microusd,
    note: input.note ?? null,
  });
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

  /** Canonical row contract — recomputed digest must self-verify AND
   *  mutable runtime state outside the digest must still satisfy every
   *  authority invariant (R2.C + R2.E):
   *   - budget: 0 <= consumed <= ceiling, integer microusd
   *   - kpis: array of well-formed objects, unique kpi_id, finite
   *     baseline/target/current
   *   - ledgers/evidence_refs: bounded, well-formed
   *   - scalar fields: enum status, int versions, non-empty identity
   *  Anything else fails closed — the digest alone does not bless
   *  malformed runtime state. */
  assertCanonicalRow(row: Row): void {
    if (String(row.schema_version) !== OBJECTIVE_SCHEMA) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_SCHEMA",
        `${String(row.objective_id ?? row.entity_id)}:${String(row.schema_version ?? "absent")}`,
      );
    }
    for (const f of ["objective_id", "business_id", "owner_authority_id", "create_semantic_digest"]) {
      assertStr(f, row[f]);
    }
    if (!(OBJECTIVE_STATUSES as readonly string[]).includes(String(row.status))) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `status=${String(row.status)}`);
    }
    if (row.deadline !== null && row.deadline !== undefined) {
      if (typeof row.deadline !== "string" || !Number.isFinite(Date.parse(String(row.deadline)))) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "deadline");
      }
    }
    if (row.parent_objective_id !== null && row.parent_objective_id !== undefined &&
        typeof row.parent_objective_id !== "string") {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "parent_objective_id");
    }
    const budget = row.budget as Record<string, unknown> | undefined;
    if (!budget || typeof budget !== "object" ||
        !Number.isInteger(budget.ceiling_microusd) || !Number.isInteger(budget.consumed_microusd) ||
        Number(budget.ceiling_microusd) < 0 || Number(budget.consumed_microusd) < 0 ||
        Number(budget.consumed_microusd) > Number(budget.ceiling_microusd)) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_INTEGRITY",
        `budget 0<=${String(budget?.consumed_microusd)}<=${String(budget?.ceiling_microusd)} violated`,
      );
    }
    // KPI runtime state is group-A mutable — shape is still authority:
    // a malformed current/duplicate kpi_id would corrupt progress writes.
    if (!Array.isArray(row.kpis)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "kpis");
    }
    const kpiIds = new Set<string>();
    for (const k of row.kpis as unknown[]) {
      if (!k || typeof k !== "object" || Array.isArray(k)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "kpi object");
      }
      const kk = k as Record<string, unknown>;
      assertStr("kpi_id", kk.kpi_id);
      if (kpiIds.has(String(kk.kpi_id))) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `duplicate kpi_id ${String(kk.kpi_id)}`);
      }
      kpiIds.add(String(kk.kpi_id));
      // R3.D — strict runtime shape: baseline/target must be actual JS
      // numbers (numeric strings like "10" are malformed canonical
      // state); current may be null or a real number.
      if (typeof kk.baseline !== "number" || !Number.isFinite(kk.baseline) ||
          typeof kk.target !== "number" || !Number.isFinite(kk.target) ||
          (kk.current !== null && kk.current !== undefined &&
           (typeof kk.current !== "number" || !Number.isFinite(kk.current)))) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `kpi ${String(kk.kpi_id)} numeric`);
      }
    }
    ledgerOf(row.applied_evidence_keys);
    ledgerOf(row.applied_spend_keys);
    if (!Array.isArray(row.evidence_refs)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "evidence_refs");
    }
    for (const e of row.evidence_refs as unknown[]) {
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "evidence_refs entry");
      }
      const ee = e as Record<string, unknown>;
      if (typeof ee.evidence_key !== "string" || !ee.evidence_key ||
          typeof ee.verifier !== "string" || !ee.verifier ||
          typeof ee.source !== "string" || !ee.source) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "evidence_refs fields");
      }
      if (ee.kind !== "PROGRESS" && ee.kind !== "EVIDENCE") {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", `evidence kind ${String(ee.kind)}`);
      }
    }
    const tv = Number(row.terms_version);
    if (!Number.isInteger(tv) || tv < 1 ||
        !Number.isInteger(Number(row.amendment_seq)) || Number(row.amendment_seq) < 0 ||
        !Number.isInteger(Number(row.version)) || Number(row.version) < 0) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_INTEGRITY", "version fields");
    }
    const recomputed = objectiveDigest({
      objective_id: String(row.objective_id),
      business_id: String(row.business_id),
      terms_version: tv,
      terms: termsOf(row),
      create_semantic_digest: String(row.create_semantic_digest ?? ""),
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
   * Bounded deterministic parent-graph walk — the objective hierarchy
   * must be acyclic. Walks the same-business parent chain from
   * `parentId`; reaching `objectiveId` (self-parent or any cycle) fails
   * closed. Bounded at 1024 hops; a missing or foreign-business chain
   * node ends the walk (foreign rows are rejected at the direct-scope
   * check, and a broken chain cannot cycle back through an absent row).
   */
  private assertAcyclicParent(objectiveId: string, parentId: string, businessId: string): void {
    if (parentId === objectiveId) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_CYCLE", `${objectiveId} parent=self`);
    }
    const seen = new Set<string>([objectiveId]);
    let pid: string | null = parentId;
    while (pid) {
      if (seen.has(pid)) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_CYCLE", `${objectiveId} → ${pid}`);
      }
      seen.add(pid);
      if (seen.size > 1024) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_CYCLE", `${objectiveId} chain>1024`);
      }
      const row: Record<string, unknown> | null = this.store.tryGet(OBJECTIVE_ENTITY, pid);
      if (!row || String(row.business_id) !== businessId) return;
      pid = row.parent_objective_id ? String(row.parent_objective_id) : null;
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
    // F10 — canonicalize the operator identity exactly once: raw
    // `alice` → `operator:alice`; an already-canonical `operator:alice`
    // is stored as-is (never double-prefixed). Objectives already
    // persisted under the old double-prefix convention are NOT
    // silently re-aliased — their stored owner stays canonical truth.
    const rawOperator = assertStr("operator_id", input.operator_id);
    // The FINAL owner is shape-gated either way — explicit
    // owner_authority_id AND the operator-derived default. A garbage
    // input at either field mints a permanently-unclaimable row, so
    // both paths run the same canonical gate (R2 M1′).
    const ownerAuthority = assertOwnerAuthorityRef(
      "owner_authority_id",
      input.owner_authority_id
        ? input.owner_authority_id
        : rawOperator.startsWith("operator:")
          ? rawOperator
          : `operator:${rawOperator}`,
    );
    // F11 — the creator actor canonicalizes on the same once-only rule,
    // kept DISTINCT from ownerAuthority: an explicit owner_authority_id
    // must not leak into `actor` (creator ≠ owner is a real contract).
    const creatorActor = rawOperator.startsWith("operator:")
      ? rawOperator
      : `operator:${rawOperator}`;
    const dedupKey = input.dedup_key ?? this.defaultDedupKey({ title, statement, description: input.description });
    const id = this.objectiveIdFor(businessId, dedupKey);
    let parentId: string | null = null;
    if (input.parent_objective_id) {
      // self-parent fails before the parent lookup — the deterministic
      // id makes self-reference detectable even though the row does not
      // exist yet.
      if (input.parent_objective_id === id) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_CYCLE", `${id} parent=self`);
      }
      const parent = this.get(input.parent_objective_id);
      if (String(parent.business_id) !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCOPE", `parent outside business ${businessId}`);
      }
      this.assertAcyclicParent(id, input.parent_objective_id, businessId);
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
      applied_evidence_keys: [] as ObjectiveLedgerEntry[],
      applied_spend_keys: [] as ObjectiveLedgerEntry[],
      terms_version: 1,
      amendment_seq: 0,
      last_amendment: null,
      schema_version: OBJECTIVE_SCHEMA,
      actor: creatorActor,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
    // R3.B + R4.A — immutable create semantics: bound at mint from the
    // ORIGINAL create request terms, never rewritten by amendments, and
    // integrity-bound INTO objective_digest so a direct canonical-row
    // rewrite of it fails strict reads. A replay of the exact original
    // create converges even after legitimate amends; the same dedup
    // identity carrying different terms conflicts.
    row.create_semantic_digest = digest({
      schema_version: OBJECTIVE_SCHEMA,
      kind: "OBJECTIVE_CREATE_SEMANTICS",
      objective_id: id,
      business_id: businessId,
      terms: termsOf(row),
    });
    row.objective_digest = objectiveDigest({
      objective_id: id,
      business_id: businessId,
      terms_version: 1,
      terms: termsOf(row),
      create_semantic_digest: String(row.create_semantic_digest),
    });
    try {
      return this.store.immediate(() => {
        const saved = this.store.put(OBJECTIVE_ENTITY, id, row, 0);
        this.store.event({
          entity_type: OBJECTIVE_ENTITY,
          entity_id: id,
          event_type: "OBJECTIVE_CREATED",
          new_state: "ACTIVE",
          actor: creatorActor,
          metadata: { business_id: businessId, title, owner_authority_id: ownerAuthority },
        });
        return saved;
      });
    } catch (err) {
      // Duplicate/concurrent create — converge against the IMMUTABLE
      // create semantic digest (R3.B): the winner may have since been
      // legitimately amended, so comparing live terms is wrong. Same
      // original-create semantics → exact replay returns the current
      // canonical row; different semantics on the same dedup identity →
      // CREATE_CONFLICT.
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        const winner = this.get(id);
        if (String(winner.create_semantic_digest ?? "") !== String(row.create_semantic_digest)) {
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_CREATE_CONFLICT",
            `${id}: dedup identity reused with different create semantics`,
          );
        }
        return winner;
      }
      throw err;
    }
  }

  /** Verified KPI progress — group-A mutation. `value` is an absolute
   *  verified measurement bound by canonical evidence. P15.1 supports
   *  exactly one verification seam: the explicit owner-authorized
   *  operator measurement (verifier === owner_authority_id, actor ===
   *  owner). Automated mission/artifact KPI progress is DELIBERATELY
   *  fail-closed: PAIR has no canonical business-outcome verifier that
   *  proves a measurement, and generic governed-evidence persistence is
   *  not outcome authority (R3.A). A future bounded outcome-verification
   *  seam (P15.5) must bind business/objective/kpi/value/provenance/
   *  immutable evidence identity before it may mint progress evidence.
   *  The evidence_key ledger binds the full semantic digest — a key
   *  reused with different semantics conflicts fail-closed, never
   *  silently replays or double-counts. */
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
      const ledger = ledgerOf(row.applied_evidence_keys);
      const sem = progressSemantics(objectiveId, { kpi_id: input.kpi_id, value, evidence: ev });
      const prior = ledger.find((e) => e.key === ev.evidence_key);
      if (prior) {
        if (prior.digest === sem) return row; // exact replay — idempotent no-op
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
          `${objectiveId}:${ev.evidence_key} reused with different semantics`,
        );
      }
      const kpis = row.kpis as ObjectiveKpi[];
      const kpi = kpis.find((k) => k.kpi_id === input.kpi_id);
      if (!kpi) {
        throw new NotFoundError(`objective ${objectiveId} kpi ${input.kpi_id}`);
      }
      this.assertOwnerVerifier(row, ev, input.actor, {
        kpi_id: String(kpi.kpi_id),
        value,
      });
      if (ledger.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      const now = utcnow();
      kpi.current = value;
      kpi.last_evidence_key = ev.evidence_key;
      kpi.updated_at = now;
      ledger.push({ key: ev.evidence_key, digest: sem });
      row.applied_evidence_keys = ledger;
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

  /** Attach verified evidence without a KPI write — provenance
   *  referencing, not measurement. The verifier still resolves
   *  canonically (R3.A): a mission must be a canonical mission row (not a
   *  minimally shaped store.put row) with unanimous business provenance;
   *  an artifact must be a canonical ACCEPTED PAIR artifact with
   *  ARTIFACT_ACCEPTED provenance binding artifact_id+execution_id+sha256;
   *  operator attaches are owner-only. The evidence_key must locate a
   *  real governed evidence row under the resolved mission. */
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
      const ledger = ledgerOf(row.applied_evidence_keys);
      const sem = evidenceSemantics(objectiveId, ev);
      const prior = ledger.find((e) => e.key === ev.evidence_key);
      if (prior) {
        if (prior.digest === sem) return row;
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT",
          `${objectiveId}:${ev.evidence_key} reused with different semantics`,
        );
      }
      // R4.B Option A — attach is owner-authorized only: the same
      // owner-authorized seam as KPI progress. PairEvidenceStore
      // persistence integrity is not mission/artifact domain authority;
      // mission:/artifact: and every other verifier kind fail closed
      // until a future phase exposes a reusable canonical provenance
      // verifier. No partial verifier is reimplemented here.
      this.assertOwnerVerifier(row, ev, input.actor);
      if (ledger.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      const now = utcnow();
      ledger.push({ key: ev.evidence_key, digest: sem });
      row.applied_evidence_keys = ledger;
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
      const ledger = ledgerOf(row.applied_spend_keys);
      const sem = spendSemantics(objectiveId, {
        spend_key: spendKey,
        amount_microusd: amount,
        note: input.note,
      });
      const prior = ledger.find((e) => e.key === spendKey);
      if (prior) {
        if (prior.digest === sem) return row; // exact replay — never double-spends
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_SPEND_CONFLICT",
          `${objectiveId}:${spendKey} reused with different semantics`,
        );
      }
      const budget = row.budget as ObjectiveBudget;
      const next = Number(budget.consumed_microusd) + amount;
      if (next > Number(budget.ceiling_microusd)) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_BUDGET_EXCEEDED",
          `${objectiveId}: consumed=${next} ceiling=${budget.ceiling_microusd}`,
        );
      }
      if (ledger.length >= LEDGER_CAP) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_LEDGER_FULL", objectiveId);
      }
      budget.consumed_microusd = next;
      ledger.push({ key: spendKey, digest: sem });
      row.applied_spend_keys = ledger;
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
    input: { business_id: string; patch: Record<string, unknown>; reason?: string; actor: string; idempotency_key?: string },
  ): Row {
    if (!input.actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.amend");
    const businessId = assertStr("business_id", input.business_id);
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", "patch must be an object");
    }
    const patchKeys = Object.keys(input.patch);
    // A patch with no EFFECTIVE key is NOT an amendment — committing
    // it would bump terms_version + rebind objective_digest
    // (invalidating every pinned review/policy grant) while changing
    // nothing. Keys present-but-undefined (service callers can send
    // them; JSON cannot) are vacuous the same way.
    if (!patchKeys.length || patchKeys.every((k) => input.patch[k] === undefined)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_FIELD", "patch must name at least one key");
    }
    for (const k of patchKeys) {
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
      /* Idempotent amend (R2 M2′): recordProgress/attachEvidence dedup
         on evidence_key; amendments had NO anchor — an ambiguous
         retry after a committed-but-lost response would double-commit
         (terms_version +2, every pinned review/policy invalidated
         twice). A caller-supplied idempotency_key replays against the
         LAST committed amendment: same key + same patch digest is an
         idempotent no-op, same key + different patch is a typed
         conflict — never a silent double-commit. Callers that send no
         key (or an empty key — normalized away, never aliased to the
         unkeyed null sentinel) keep the original always-commit
         semantics.
         Dedup window is ONE amendment deep: an older key retried after
         a different amendment committed is treated as a NEW operation
         and re-applies its patch — honest "latest-key replay", not a
         full ledger (bounded ledgers already exist for evidence/spend
         where collisions matter more). Replay is evaluated AFTER
         scope/owner/terminal gates: a foreign or expired caller can
         never probe whether a key committed — authz leaks nothing. */
      const idemKey = input.idempotency_key || undefined;
      if (idemKey !== undefined) {
        const last = (row.last_amendment ?? null) as Record<string, unknown> | null;
        if (last && last.idempotency_key === idemKey) {
          let patchDigest: string;
          try {
            patchDigest = digest(patch);
          } catch {
            // Non-canonical patch values (e.g., NaN reachable only from
            // a service caller — JSON cannot carry them) fail as the
            // typed field error the validators would have produced.
            throw new IntegrityError(
              "FAIL_CLOSED_OBJECTIVE_FIELD",
              "patch contains non-canonical values",
            );
          }
          if (last.patch_digest === patchDigest) {
            return row; // exact replay — never double-commits
          }
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_AMEND_CONFLICT",
            `${objectiveId}: idempotency_key ${idemKey} reused with different patch`,
          );
        }
      }
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
          this.assertAcyclicParent(objectiveId, String(patch.parent_objective_id), businessId);
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
        const ceiling = assertMicrousd("budget_ceiling_microusd", patch.budget_ceiling_microusd);
        // Canonical invariant 0<=consumed<=ceiling must hold after the
        // amendment too — lowering the ceiling below already-consumed
        // spend fails closed and leaves row/version/events unchanged.
        if (ceiling < Number(budget.consumed_microusd)) {
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_BUDGET_INVARIANT",
            `${objectiveId}: ceiling ${ceiling} < consumed ${String(budget.consumed_microusd)}`,
          );
        }
        budget.ceiling_microusd = ceiling;
      }
      if (patch.currency !== undefined) budget.currency = assertStr("currency", patch.currency);
      if (patch.hard_constraints !== undefined) row.hard_constraints = normalizeStringList("hard_constraints", patch.hard_constraints);
      if (patch.success_conditions !== undefined) row.success_conditions = normalizeStringList("success_conditions", patch.success_conditions);
      if (patch.stop_conditions !== undefined) row.stop_conditions = normalizeStringList("stop_conditions", patch.stop_conditions);
      if (patch.owner_authority_id !== undefined) row.owner_authority_id = assertOwnerAuthorityRef("owner_authority_id", patch.owner_authority_id);
      row.terms_version = Number(row.terms_version) + 1;
      row.amendment_seq = Number(row.amendment_seq) + 1;
      row.last_amendment = {
        seq: row.amendment_seq,
        by: input.actor,
        reason: input.reason ?? null,
        at: utcnow(),
        keys: Object.keys(patch),
        idempotency_key: idemKey ?? null,
        patch_digest: digest(patch),
      };
      row.objective_digest = objectiveDigest({
        objective_id: String(row.objective_id),
        business_id: businessId,
        terms_version: Number(row.terms_version),
        terms: termsOf(row),
        create_semantic_digest: String(row.create_semantic_digest),
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

  /** The single supported verification seam in P15.1 (R3.A + R4.B):
   *  the explicit owner-authorized operator action — verifier must equal
   *  owner_authority_id AND the actor must be the owner. PAIR has no
   *  canonical business-outcome verifier capable of proving an automated
   *  KPI measurement, and store-row existence is persistence integrity,
   *  not domain authority — so mission/artifact/service/self-report and
   *  every other verifier kind fails closed for BOTH progress and
   *  attach. No partial mission/artifact verifier is reimplemented here;
   *  a future bounded outcome/provenance-verification seam (P15.5) must
   *  bind business/objective/kpi/value/provenance/immutable evidence
   *  identity before it may mint evidence. */
  private assertOwnerVerifier(
    row: Row,
    ev: ObjectiveEvidence,
    actor: string,
    claim?: { kpi_id?: string; value?: number },
  ): void {
    if (verifierKind(ev.verifier) === "operator" &&
        ev.verifier === String(row.owner_authority_id) &&
        actor === String(row.owner_authority_id)) {
      return;
    }
    // P15.10-D — delegated auto-verification: a real grant + digest-bound
    // receipt prove authority; the writer identity is the ONE canonical
    // writer, never a forged owner string. Same checks run again at the
    // P15.5 strict read.
    if (verifierKind(ev.verifier) === KPI_VERIFIER_KIND) {
      if (actor !== KPI_VERIFIER_WRITER) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
          `actor ${actor} is not the canonical KPI verification writer`,
        );
      }
      assertKpiVerifierAuthority({
        store: this.store,
        objective: row,
        kpi_id: claim?.kpi_id,
        verifier: ev.verifier,
        evidence_key: ev.evidence_key,
        value: claim?.value,
      });
      return;
    }
    throw new IntegrityError(
      "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
      `verifier ${ev.verifier}: automated verification is deliberately fail-closed in P15.1 — only the owner-authorized operator seam is supported`,
    );
  }

  private assertEvidence(ev: unknown): ObjectiveEvidence {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_EVIDENCE", "evidence must be an object");
    }
    const src = ev as Record<string, unknown>;
    const evidenceKey = assertStr("evidence_key", src.evidence_key);
    const verifier = assertStr("verifier", src.verifier);
    if (!VERIFIER_KINDS.has(verifierKind(verifier)) || !verifierRef(verifier)) {
      // A progress claim without a recognized, resolvable verification
      // authority is a self-report — never authority.
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_UNVERIFIED",
        `verifier ${verifier}: not in ${[...VERIFIER_KINDS].join("|")}:<ref>`,
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

/* --------------------------------------------------------------------
 * Canonical budget re-proof — moved here from objective-adaptive-review
 * for AUDIT R2-F2: cost admission must consult the canonical objective
 * budget authority, and cost.ts cannot import the adaptive-review
 * module (its ceo-runtime dependency chain creates an import cycle).
 * objective-authority is a leaf module — the same strict proof now
 * lives beside spendSemantics and is re-exported through
 * objective-adaptive-review for the existing P15.5 callers.
 * ------------------------------------------------------------------ */

function budgetProofFail(detail: string): never {
  // Same fail-closed code the P15.5 adaptive-review caller relies on.
  throw new IntegrityError("FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW", detail);
}

/** Re-prove that `budget.consumed_microusd` on a strict-read Objective is
 *  backed by the immutable canonical spend-event chain, not merely a
 *  field on the row.
 *
 *  - every spend event carries {spend_key, amount_microusd,
 *    consumed_microusd} where consumed equals the cumulative sum;
 *  - the applied_spend_keys ledger mirrors the event chain exactly
 *    (no missing authority, no extra keys);
 *  - each ledger digest equals spendSemantics(objective_id, {spend_key,
 *    amount_microusd}) — the only recognized spend authority;
 *  - the cumulative sum equals the current consumed_microusd.
 *
 *  Any malformed shape, untrusted evidence, or chain mismatch throws —
 *  consumed_microusd cannot affect P15.5/CEO reasoning unproven. */
export function assertCanonicalObjectiveBudget(
  store: PairEvidenceStore,
  objective: Row,
): void {
  const oid = String(objective.objective_id);
  const budget = objective.budget as Record<string, unknown> | undefined;
  if (!budget ||
      !Number.isInteger(budget.ceiling_microusd) ||
      !Number.isInteger(budget.consumed_microusd) ||
      Number(budget.ceiling_microusd) < 0 ||
      Number(budget.consumed_microusd) < 0 ||
      Number(budget.consumed_microusd) > Number(budget.ceiling_microusd)) {
    budgetProofFail(`objective ${oid}: budget shape/ceiling invalid`);
  }
  const rawLedger = objective.applied_spend_keys;
  const ledger: Array<{ key: string; digest: string }> = [];
  if (rawLedger !== undefined && rawLedger !== null) {
    if (!Array.isArray(rawLedger)) {
      budgetProofFail(`objective ${oid}: applied_spend_keys malformed`);
    }
    for (const e of rawLedger as Array<Record<string, unknown>>) {
      if (typeof e !== "object" || e === null ||
          typeof e.key !== "string" || e.key === "" ||
          typeof e.digest !== "string" || e.digest === "") {
        budgetProofFail(`objective ${oid}: applied_spend_keys entry malformed`);
      }
      ledger.push({ key: e.key, digest: e.digest });
    }
  }
  const events = listAccountedSpendEvents(store, oid);
  // Every spend_key is unique and cumulative consumed is monotone
  // consistent through the immutable event chain.
  const byKey = new Map<string, { amount: number; consumed: number }>();
  let running = 0;
  for (const e of events) {
    const md = e.metadata as Record<string, unknown> | null;
    if (!md || typeof md.spend_key !== "string" || md.spend_key === "" ||
        !Number.isInteger(md.amount_microusd) ||
        Number(md.amount_microusd) < 0 ||
        !Number.isInteger(md.consumed_microusd)) {
      budgetProofFail(`objective ${oid}: malformed spend event authority`);
    }
    const key = String(md.spend_key);
    if (byKey.has(key)) {
      budgetProofFail(`objective ${oid}: duplicate spend_key authority ${key}`);
    }
    running += Number(md.amount_microusd);
    if (Number(md.consumed_microusd) !== running) {
      budgetProofFail(
        `objective ${oid}: spend event cumulative mismatch at ${key}`);
    }
    byKey.set(key, { amount: Number(md.amount_microusd), consumed: running });
  }
  if (running !== Number(budget.consumed_microusd)) {
    budgetProofFail(
      `objective ${oid}: consumed=${String(budget.consumed_microusd)} ` +
      `but canonical spend chain totals ${running}`);
  }
  // The ledger must mirror the event chain exactly — no missing spend
  // authority, no extra keys.
  if (ledger.length !== events.length) {
    budgetProofFail(`objective ${oid}: spend ledger/event count mismatch`);
  }
  for (const entry of ledger) {
    const e = byKey.get(entry.key);
    if (!e) {
      budgetProofFail(`objective ${oid}: ledger key ${entry.key} has no spend event`);
    }
    const expected = spendSemantics(oid, {
      spend_key: entry.key,
      amount_microusd: e!.amount,
      // A note is not part of persisted event evidence — a spend that
      // used one cannot be re-proven here and fails closed.
      note: undefined,
    });
    if (entry.digest !== expected) {
      budgetProofFail(`objective ${oid}: spend digest mismatch for ${entry.key}`);
    }
  }
}

function listAccountedSpendEvents(store: PairEvidenceStore, oid: string) {
  // listEvents already orders by the immutable seq column.
  return store.listEvents(OBJECTIVE_ENTITY, oid)
    .filter((e) => String(e.event_type) === "OBJECTIVE_BUDGET_ACCOUNTED");
}
