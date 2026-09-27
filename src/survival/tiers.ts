/**
 * Survival Tiers
 *
 * Tier thresholds and helpers. In the PAIR fork, the "credit balance"
 * signal is a locally configured budget (AUTOMATON_CREDITS_BALANCE env
 * or config value, in cents) rather than a remote Conway balance.
 */

import type { SurvivalTier } from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Determine the survival tier based on current credits.
 * Thresholds are checked in descending order: high > normal > low_compute > critical > dead.
 *
 * Zero credits = "critical" (broke but alive — can still accept funding, send distress).
 * Only negative balance = "dead".
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.high) return "high";
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (creditsCents >= 0) return "critical";
  return "dead";
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
