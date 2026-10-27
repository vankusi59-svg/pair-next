/* objective-intake — deterministic, NON-AUTHORITATIVE draft derivation for
 * the V2 natural-language intake surface.
 *
 * Authority contract (DEVIN_MASTER_MISSION Phase B):
 *   - The draft is a proposal for owner review — never canonical input.
 *   - Every field carries a provenance tag: "explicit" (operator's own words,
 *     mapped 1:1 to the field purpose), "suggested" (derived/mapped by
 *     interpretation), or "unresolved" (nothing usable — owner must supply).
 *   - This module NEVER invents KPIs, numbers, deadlines, currencies, budgets
 *     or permissions. A field is only populated when the goal text or the
 *     bounded interpretation items support it; otherwise it stays null/empty.
 *   - Semantic analysis itself is advisory evidence (P18.6). When the mode is
 *     OFF or the provider is unavailable/malformed, callers use
 *     deriveManualDraft — the manual governed path, identical contract. */
import type { GoalIntentAnalysis, IntentItem } from "./semantic-goal-understanding.js";

export const INTAKE_DRAFT_SCHEMA = "pair.intake-draft.v1";
export const INTAKE_MAX_GOAL = 4000;

export type IntakeProvenance = "explicit" | "suggested" | "unresolved";

export interface IntakeField<T> {
  value: T | null;
  provenance: IntakeProvenance;
  /** Intent item id that grounded the value (evidence, not authority). */
  evidence_item_id: string | null;
}

export interface IntakeKpi {
  /** Operator-visible name — verbatim-derived, never a fabricated metric. */
  name: string;
  direction: "AT_LEAST";
  target: number | null;
  unit: string | null;
  provenance: IntakeProvenance;
  evidence_item_id: string | null;
}

export interface IntakeStatement {
  statement: string;
  provenance: IntakeProvenance;
  evidence_item_id: string | null;
}

export interface IntakeQuestion {
  item_id: string;
  statement: string;
  alternatives: string[];
}

export interface IntakeDraft {
  schema_version: typeof INTAKE_DRAFT_SCHEMA;
  /** Deterministic kind suggestion — the operator always sees the toggle. */
  suggested_kind: "objective" | "mission";
  title: IntakeField<string>;
  statement: IntakeField<string>;
  kpis: IntakeKpi[];
  deadline: IntakeField<string>;
  budget_hint: IntakeField<string>;
  budget_ceiling_microusd: IntakeField<number>;
  currency: IntakeField<string>;
  hard_constraints: IntakeStatement[];
  success_conditions: IntakeStatement[];
  workstreams: IntakeStatement[];
  questions: IntakeQuestion[];
}

const cap = (s: string, n: number): string => {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= n) return t;
  const c = t.slice(0, n - 1);
  return c.replace(/\s+\S*$/, "") + "…";
};

const prov = (i: IntentItem, mapped = false): IntakeProvenance =>
  mapped || i.authority !== "EXPLICIT_OPERATOR" ? "suggested" : "explicit";

const field = <T>(value: T | null, provenance: IntakeProvenance, id: string | null): IntakeField<T> => ({
  value,
  provenance: value === null ? "unresolved" : provenance,
  evidence_item_id: value === null ? null : id,
});

/* First number in a statement — bounded, no units math beyond capture.
 * Accepts "3", "1.5", "500", "100 USD"-style numerals. */
const NUM_RE = /(\d+(?:[.,]\d+)?)/;
const ISO_DATE_RE = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/;
const DM_DATE_RE = /\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/;
const REL_DAYS_RE = /trong\s+(\d{1,3})\s*(ngày|ngay|tuần|tuan|tháng|thang|days?|weeks?|months?)\b/i;
const MAG_SRC = "triệu|tr|nghìn|ngàn|nghin|ngan|tỷ|ty|million|mil|thousand|k|m";
const CUR_SRC = "usd|usdt|\\$|đô|vnd|đ|eur|€";
const MONEY_RE = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*(${MAG_SRC})?\\s*(${CUR_SRC})\\b` +
    `|(${CUR_SRC})\\s*(\\d+(?:[.,]\\d+)?)\\s*(${MAG_SRC})?\\b`,
  "i",
);
const MAGNITUDE: Record<string, number> = {
  "triệu": 1_000_000, tr: 1_000_000, million: 1_000_000, mil: 1_000_000, m: 1_000_000,
  "tỷ": 1_000_000_000, ty: 1_000_000_000,
  "nghìn": 1_000, "ngàn": 1_000, nghin: 1_000, ngan: 1_000, thousand: 1_000, k: 1_000,
};

const num = (s: string): number | null => {
  const m = s.match(NUM_RE);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

const normIso = (y: string, m: string, d: string): string | null => {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
};

const daysOf = (unit: string): number =>
  /tuần|tuan|week/i.test(unit) ? 7 : /tháng|thang|month/i.test(unit) ? 30 : 1;

function extractDeadline(
  items: IntentItem[],
  createdAt: string,
): { value: string | null; provenance: IntakeProvenance; id: string | null } {
  for (const i of items) {
    if (i.category !== "temporal") continue;
    const s = i.statement;
    let m = s.match(ISO_DATE_RE);
    if (m) {
      const v = normIso(m[1], m[2], m[3]);
      if (v) return { value: v, provenance: prov(i), id: i.id };
    }
    m = s.match(DM_DATE_RE);
    if (m) {
      const v = normIso(m[3], m[2], m[1]); /* VN-first: dd/mm/yyyy */
      if (v) return { value: v, provenance: prov(i), id: i.id };
    }
    const r = s.match(REL_DAYS_RE);
    if (r) {
      /* "trong 30 ngày" resolves relative to the analysis timestamp —
         a deterministic derivation (suggested), never an invented date. */
      const base = Date.parse(createdAt);
      if (Number.isFinite(base)) {
        const v = new Date(base + Number(r[1]) * daysOf(r[2]) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return { value: v, provenance: "suggested", id: i.id };
      }
    }
  }
  return { value: null, provenance: "unresolved", id: null };
}

function extractBudget(items: IntentItem[]): {
  hint: { value: string | null; provenance: IntakeProvenance; id: string | null };
  microusd: { value: number | null; provenance: IntakeProvenance; id: string | null };
  currency: { value: string | null; provenance: IntakeProvenance; id: string | null };
} {
  const none = {
    hint: { value: null, provenance: "unresolved" as IntakeProvenance, id: null },
    microusd: { value: null, provenance: "unresolved" as IntakeProvenance, id: null },
    currency: { value: null, provenance: "unresolved" as IntakeProvenance, id: null },
  };
  for (const i of items) {
    if (i.category !== "quantity" && i.category !== "hard_constraint" && i.category !== "requirement") continue;
    const m = i.statement.match(MONEY_RE);
    if (!m) continue;
    const raw = Number((m[1] ?? m[5] ?? "").replace(",", "."));
    if (!Number.isFinite(raw)) continue;
    /* Magnitude words (triệu/nghìn/tỷ/k/m) are part of the source
       quantity — deterministic multiplier, not a derived estimate. */
    const mag = (m[2] ?? m[6] ?? "").toLowerCase();
    const mult = MAGNITUDE[mag] ?? 1;
    const unit = (m[3] ?? m[4] ?? "").toLowerCase();
    const cur = unit === "$" || unit === "usd" || unit === "usdt" || unit === "đô"
      ? "USD"
      : unit === "€" || unit === "eur"
        ? "EUR"
        : "VND";
    return {
      hint: { value: cap(i.statement, 120), provenance: prov(i), id: i.id },
      /* Canonical ceiling is micro-USD — only a USD-denominated amount can
         populate it. Other currencies keep the hint; owner converts. */
      microusd: {
        value: cur === "USD" ? Math.round(raw * mult * 1_000_000) : null,
        provenance: cur === "USD" ? prov(i) : "unresolved",
        id: cur === "USD" ? i.id : null,
      },
      currency: { value: cur, provenance: prov(i), id: i.id },
    };
  }
  return none;
}

const isUnresolved = (i: IntentItem): boolean =>
  i.authority === "UNRESOLVED" ||
  i.category === "missing_information" ||
  i.category === "ambiguity" ||
  i.category === "conflict";

/** Draft from a completed advisory analysis. Pure — no I/O, no authority. */
export function deriveIntakeDraft(analysis: GoalIntentAnalysis): IntakeDraft {
  const items = analysis.items;
  const primary = items.find((i) => i.category === "primary_outcome") ?? null;

  const kpis: IntakeKpi[] = items
    .filter((i) => i.category === "quantity" && !isUnresolved(i) && num(i.statement) !== null)
    .filter((i) => MONEY_RE.test(i.statement) === false)
    .slice(0, 5)
    .map((i) => ({
      name: cap(i.statement, 90),
      direction: "AT_LEAST",
      target: num(i.statement),
      unit: null,
      /* KPI *structure* (name→target decomposition) is inferred even when
         the underlying words are the operator's — always "suggested". */
      provenance: "suggested",
      evidence_item_id: i.id,
    }));

  const budget = extractBudget(items);
  const deadline = extractDeadline(items, analysis.created_at);

  const hardConstraints: IntakeStatement[] = items
    .filter((i) => (i.category === "hard_constraint" || i.category === "prohibition") && !isUnresolved(i))
    .slice(0, 8)
    .map((i) => ({ statement: i.statement, provenance: prov(i), evidence_item_id: i.id }));

  const deliverables = items.filter((i) => i.category === "deliverable" && !isUnresolved(i));
  const successConditions: IntakeStatement[] = deliverables
    .slice(0, 6)
    .map((i) => ({ statement: i.statement, provenance: "suggested", evidence_item_id: i.id }));

  const workstreams: IntakeStatement[] = deliverables
    .slice(0, 5)
    .map((i) => ({ statement: cap(i.statement, 48), provenance: "suggested", evidence_item_id: i.id }));

  const questions: IntakeQuestion[] = items
    .filter(isUnresolved)
    .slice(0, 8)
    .map((i) => ({
      item_id: i.id,
      statement: i.statement,
      alternatives: (i.alternatives ?? []).slice(0, 4),
    }));

  const objectiveSignals =
    (deadline.value !== null ? 1 : 0) +
    (budget.microusd.value !== null || budget.hint.value !== null ? 1 : 0) +
    (kpis.length > 0 ? 1 : 0) +
    (deliverables.length >= 2 ? 1 : 0);

  return {
    schema_version: INTAKE_DRAFT_SCHEMA,
    suggested_kind: objectiveSignals >= 2 ? "objective" : "mission",
    title: field(primary ? cap(primary.statement, 90) : null, primary ? prov(primary) : "unresolved", primary?.id ?? null),
    statement: field(primary ? cap(primary.statement, 500) : null, primary ? prov(primary) : "unresolved", primary?.id ?? null),
    kpis,
    deadline: field(deadline.value, deadline.provenance, deadline.id),
    budget_hint: field(budget.hint.value, budget.hint.provenance, budget.hint.id),
    budget_ceiling_microusd: field(budget.microusd.value, budget.microusd.provenance, budget.microusd.id),
    currency: field(budget.currency.value, budget.currency.provenance, budget.currency.id),
    hard_constraints: hardConstraints,
    success_conditions: successConditions,
    workstreams,
    questions,
  };
}

/** Fallback when interpretation is OFF/unavailable — the manual governed
 *  path. Only the operator's own words are explicit; every structured
 *  field stays unresolved for the owner to fill. */
export function deriveManualDraft(goal: string): IntakeDraft {
  const g = String(goal ?? "").trim().replace(/\s+/g, " ");
  const titleSrc = g.split(/[.!?\n]/).map((s) => s.trim()).find(Boolean) ?? g;
  return {
    schema_version: INTAKE_DRAFT_SCHEMA,
    suggested_kind: "mission",
    title: field(g ? cap(titleSrc, 90) : null, "explicit", null),
    statement: field(g ? cap(g, 500) : null, "explicit", null),
    kpis: [],
    deadline: field<string>(null, "unresolved", null),
    budget_hint: field<string>(null, "unresolved", null),
    budget_ceiling_microusd: field<number>(null, "unresolved", null),
    currency: field<string>(null, "unresolved", null),
    hard_constraints: [],
    success_conditions: [],
    workstreams: [],
    questions: [],
  };
}
