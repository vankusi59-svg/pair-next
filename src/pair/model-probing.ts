/**
 * model-probing — bounded capability probing + qualification (P6).
 *
 * Port of donor model_probing.py semantics (a557df2): tiered probe profiles
 * bound timeout/request/token/cost caps. Tier ≥1 requires an injected
 * probe_fn — no implicit model invocations. Over-cap evidence → CAP_EXCEEDED.
 * Probe evidence feeds qualification; it never grants it directly.
 */

import { newId, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { ModelEvidenceCatalog } from "./model-catalog.js";
import type { PairEvidenceStore } from "./store.js";

export const PROBE_TIERS = [0, 1, 2, 3] as const;

const PROBE_PROFILES: Record<number, Record<string, unknown>> = {
  0: { tier: 0, timeout_s: 0, request_cap: 0, token_cap: 0, cost_cap_usd: 0.0, retry_cap: 0, credential_scope: "NONE", fixture_id: "FIX_T0_CONTRACT_V1" },
  1: { tier: 1, timeout_s: 10, request_cap: 1, token_cap: 64, cost_cap_usd: 0.0, retry_cap: 0, credential_scope: "PROVIDER", fixture_id: "FIX_T1_LIVENESS_V1" },
  2: { tier: 2, timeout_s: 30, request_cap: 3, token_cap: 2048, cost_cap_usd: 0.0, retry_cap: 1, credential_scope: "PROVIDER", fixture_id: "FIX_T2_FEATURE_V1" },
  3: { tier: 3, timeout_s: 120, request_cap: 10, token_cap: 16384, cost_cap_usd: 0.0, retry_cap: 1, credential_scope: "PROVIDER", fixture_id: "FIX_T3_QUALITY_V1" },
};

export const PROBE_RESULTS = new Set([
  "PASS",
  "FAIL",
  "TIMEOUT",
  "ACCESS_DENIED",
  "UNREACHABLE",
  "UNSUPPORTED",
  "CAP_EXCEEDED",
  "RATE_LIMITED",
]);

export function probeProfile(tier: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (!(tier in PROBE_PROFILES)) {
    throw new IntegrityError("FAIL_CLOSED_PROBE_TIER", String(tier));
  }
  return { ...PROBE_PROFILES[tier], ...overrides };
}

export interface ProbeOutput {
  result: string;
  latency_ms?: number;
  capability_evidence?: Record<string, unknown>;
  requests_used?: number;
  tokens_used?: number;
  cost_usd?: number;
}

export type ProbeFn = (entry: Record<string, unknown>, profile: Record<string, unknown>) => Promise<ProbeOutput> | ProbeOutput;

function tier0ContractCheck(entry: Record<string, unknown>): { result: string; evidence: Record<string, unknown> } {
  const problems: string[] = [];
  if (!entry.model_id) problems.push("model_id");
  if (!entry.provider_id) problems.push("provider_id");
  if (!entry.provider_family) problems.push("provider_family");
  if (!entry.identity_digest) problems.push("identity_digest");
  return { result: problems.length ? "FAIL" : "PASS", evidence: { contract_violations: problems } };
}

export async function probeModel(
  store: PairEvidenceStore,
  modelEntryId: string,
  tier: number,
  opts: {
    probeFn?: ProbeFn;
    profile?: Record<string, unknown>;
    capability?: string;
    executorId?: string;
    actor?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const catalog = new ModelEvidenceCatalog(store);
  const entry = catalog.getModel(modelEntryId);
  if (!entry) throw new NotFoundError(`model_entry:${modelEntryId}`);
  if ((entry.conditions as string[]).includes("REMOVED")) {
    throw new IntegrityError("FAIL_CLOSED_MODEL_REMOVED", modelEntryId);
  }
  const profile = opts.profile ?? probeProfile(tier);

  let result: string;
  let evidence: Record<string, unknown>;
  let latencyMs = 0;
  let usage = { requests_used: 0, tokens_used: 0, cost_usd: 0.0 };

  if (tier === 0) {
    const t0 = tier0ContractCheck(entry);
    result = t0.result;
    evidence = t0.evidence;
  } else {
    if (!opts.probeFn) {
      throw new IntegrityError("FAIL_CLOSED_PROBE_NOT_CONFIGURED", `tier=${tier}`);
    }
    const out = await opts.probeFn(entry, profile);
    result = out.result;
    evidence = { ...(out.capability_evidence ?? {}) };
    latencyMs = Number(out.latency_ms ?? 0);
    usage = {
      requests_used: Number(out.requests_used ?? 1),
      tokens_used: Number(out.tokens_used ?? 0),
      cost_usd: Number(out.cost_usd ?? 0.0),
    };
    // Bound enforcement — over-cap evidence is CAP_EXCEEDED, not the claimed result.
    if (
      usage.requests_used > Number(profile.request_cap ?? 0) ||
      usage.tokens_used > Number(profile.token_cap ?? 0) ||
      usage.cost_usd > Number(profile.cost_cap_usd ?? 0)
    ) {
      result = "CAP_EXCEEDED";
      evidence = { cap_violation: usage };
    }
  }

  const receipt = {
    probe_id: newId("PRB"),
    provider_id: entry.provider_id,
    model_entry_id: modelEntryId,
    executor_id: opts.executorId ?? null,
    tier,
    probe_type: opts.capability ?? `TIER_${tier}`,
    requested_capability: opts.capability ?? null,
    result,
    latency_ms: latencyMs,
    started_at: utcnow(),
    completed_at: utcnow(),
    usage,
    capability_evidence: evidence,
    fixture_id: profile.fixture_id,
    evidence_digest: undefined as string | undefined,
  };
  receipt.evidence_digest = undefined;
  return catalog.recordProbeReceipt(receipt);
}

/**
 * Capability-scoped qualification: a model qualifies for a capability only
 * after probe evidence proves it. Probe receipts are inputs; the receipt
 * here is the qualification artifact bound to capability_scope.
 */
export function qualifyModel(
  store: PairEvidenceStore,
  modelEntryId: string,
  opts: {
    capability_scope: string[];
    verifier?: string;
    actor?: string;
  },
): { qualified: boolean; gates: Record<string, string>; receipt?: Record<string, unknown> } {
  const catalog = new ModelEvidenceCatalog(store);
  const entry = catalog.getModel(modelEntryId);
  if (!entry) throw new NotFoundError(`model_entry:${modelEntryId}`);

  const gates: Record<string, string> = {};
  gates.MODEL_EXISTS = "PASS";
  gates.MODEL_NOT_REMOVED = (entry.conditions as string[]).includes("REMOVED") ? "FAIL" : "PASS";
  gates.MODEL_NOT_DEPRECATED = (entry.conditions as string[]).includes("DEPRECATED") ? "FAIL" : "PASS";

  // Phase E R2 §1-§3 — qualification consumes CURRENT-epoch probe evidence
  // only: the receipts referenced by the entry's current probe_receipt_ids
  // window. Historical receipts from a pre-STALE/REMOVED epoch stay
  // persisted but are never consulted here.
  // Phase E R4 §6–§7 — evidence is LATEST-PER-CAPABILITY: the newest
  // receipt in the window applicable to each requested capability must be
  // a PASS that proves the capability. A PASS for an unrelated capability
  // can never revive a failed one, and a superseded PASS cannot outrank a
  // newer FAIL on the same capability.
  const capCurrent = (cap: string) => catalog.probeCurrentForCapability(modelEntryId, cap);
  gates.CURRENT_PROBE_EVIDENCE = opts.capability_scope.every(capCurrent) ? "PASS" : "FAIL";
  for (const cap of opts.capability_scope) {
    gates[`CAPABILITY_${cap.toUpperCase()}`] = capCurrent(cap) ? "PASS" : "FAIL";
  }

  const qualified = Object.values(gates).every((g) => g === "PASS");
  if (!qualified) return { qualified: false, gates };

  const receipt = catalog.issueQualificationReceipt(modelEntryId, {
    capability_scope: opts.capability_scope,
    verifier: opts.verifier ?? "DETERMINISTIC_PROBE_EVIDENCE",
    // The seam derives the minted evidence_refs from the actual covering
    // current PASS receipts; these caller refs are only validated against
    // the current window.
    evidence_refs: opts.capability_scope
      .map((cap) => catalog.latestProbeReceiptForCapability(modelEntryId, cap))
      .filter((r): r is Record<string, unknown> => r != null)
      .map((r) => String(r.probe_id)),
    actor: opts.actor,
  });
  return { qualified: true, gates, receipt };
}
