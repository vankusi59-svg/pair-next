/**
 * Financial Policy Rules (automaton-pair fork)
 *
 * The cloud-billing rules (x402, credit transfers, child funding) were
 * removed with the Conway surface. What remains: a daily inference
 * spend cap.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  TreasuryPolicy,
} from "../../types.js";

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Deny inference calls if daily inference cost exceeds maxInferenceDailyCents.
 * Checks spend_tracking table for category 'inference'.
 */
function createInferenceDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.inference_daily_cap",
    description: `Deny inference if daily cost exceeds ${policy.maxInferenceDailyCents} cents`,
    priority: 500,
    appliesTo: { by: "category", categories: ["compute"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // Only apply to inference-related tools
      if (request.tool.name !== "chat" && request.tool.name !== "inference") {
        return null;
      }

      const spendTracker = request.turnContext.sessionSpend;
      const dailyInferenceSpend = spendTracker.getDailySpend("inference");

      if (dailyInferenceSpend >= policy.maxInferenceDailyCents) {
        return deny(
          "financial.inference_daily_cap",
          "INFERENCE_BUDGET_EXCEEDED",
          `Daily inference budget exceeded: ${dailyInferenceSpend} cents spent (max ${policy.maxInferenceDailyCents} cents / $${(policy.maxInferenceDailyCents / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Create all financial policy rules.
 */
export function createFinancialRules(
  treasuryPolicy: TreasuryPolicy,
): PolicyRule[] {
  return [
    createInferenceDailyCapRule(treasuryPolicy),
  ];
}
