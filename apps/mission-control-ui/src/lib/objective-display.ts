/**
 * P15.7 F2/F3 — pure display semantics for the Objectives page.
 * Extracted so the exact unit/interaction contracts are unit-testable
 * without a DOM harness.
 */

/** USD → integer microusd. Rejects non-finite, negative, or unsafe-integer results. */
export function usdToMicrousd(raw: string): number | null {
  if (!raw.trim()) return null; // blank is "no budget input", not $0 input
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return null;
  const micro = Math.round(v * 1_000_000);
  return Number.isSafeInteger(micro) ? micro : null;
}

export function fmtMicro(micro: unknown): string {
  const v = Number(micro);
  if (!Number.isFinite(v)) return "—";
  return `$${(v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** R3.A — three distinct display states; an exhausted positive budget
 *  is NEVER labeled zero budget. */
export type BudgetState = "ZERO_BUDGET" | "BUDGET_EXHAUSTED" | "AVAILABLE";

export interface BudgetView {
  /** Integer microusd ceiling — P15.1 treats absent budget as 0. */
  ceiling_micro: number;
  consumed_micro: number;
  remaining_micro: number;
  state: BudgetState;
  /** consumed < ceiling — P15.6 exhausts at consumed >= ceiling. */
  can_dispatch: boolean;
  /** Human label — NEVER "uncapped": zero ceiling is a hard bound. */
  label: string;
}

export function budgetView(
  budget: { ceiling_microusd?: unknown; consumed_microusd?: unknown } | null | undefined,
): BudgetView {
  const ceiling = Number(budget?.ceiling_microusd ?? 0);
  const consumed = Number(budget?.consumed_microusd ?? 0);
  const safeCeiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 0;
  const safeConsumed = Number.isFinite(consumed) && consumed > 0 ? consumed : 0;
  const state: BudgetState =
    safeCeiling === 0
      ? "ZERO_BUDGET"
      : safeConsumed >= safeCeiling
        ? "BUDGET_EXHAUSTED"
        : "AVAILABLE";
  const can_dispatch = state === "AVAILABLE";
  const base = `consumed ${fmtMicro(safeConsumed)} / ceiling ${fmtMicro(safeCeiling)}`;
  const label =
    state === "ZERO_BUDGET"
      ? `${base} — zero budget, cannot dispatch new work`
      : state === "BUDGET_EXHAUSTED"
        ? `${base} — budget exhausted, cannot dispatch new work`
        : `${base} (remaining ${fmtMicro(safeCeiling - safeConsumed)})`;
  return {
    ceiling_micro: safeCeiling,
    consumed_micro: safeConsumed,
    remaining_micro: safeCeiling - safeConsumed,
    state,
    can_dispatch,
    label,
  };
}

/** Tri-state for canonical list views — a failed fetch is an error
 *  state with a retry affordance, NEVER an "empty list", and stale
 *  rows are suppressed once a strict read has failed. */
export function listState<T>(
  data: T[] | null,
  error: unknown,
): "loading" | "error" | "empty" | "rows" {
  if (error) return "error";
  if (data === null) return "loading";
  return data.length === 0 ? "empty" : "rows";
}

/** R3.B — when the canonical list read fails, a previously selected
 *  objective's stale detail (and its cycle action) must not surface. */
export function showObjectiveDetail(objState: "loading" | "error" | "empty" | "rows"): boolean {
  return objState !== "error";
}
