/**
 * provider-validation — access validation + qualification gates (P6).
 *
 * Port of donor provider_validation.py semantics (a557df2): validate access
 * (adapter supports + credential resolvable + optional bounded probe) then
 * qualify only when every gate passes. Any gate failing → not qualified,
 * never routable.
 */

import { IntegrityError, NotFoundError } from "./errors.js";
import {
  PROVIDER_OK_STATES,
  ProviderCatalog,
  providerCredentialResolvable,
  sanitizeDiagnostic,
} from "./provider-catalog.js";
import type { PairEvidenceStore } from "./store.js";

export const PROVIDER_ACCESS_OUTCOMES = new Set([
  "AUTH_OK",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "AUTH_FAILED",
  "UNREACHABLE",
  "UNSUPPORTED_PROTOCOL",
]);

export interface ValidationProbeFn {
  (providerEntry: Record<string, unknown>): Promise<{ outcome: string; latency_ms?: number; detail?: string }>;
}

export class ProviderValidator {
  constructor(private readonly store: PairEvidenceStore) {}

  private catalog() {
    return new ProviderCatalog(this.store);
  }

  /** Credential resolvable = env name declared AND present in env. */
  credentialResolvable(entry: Record<string, unknown>, env: Record<string, string | undefined>): string {
    return providerCredentialResolvable(entry, env);
  }

  async validateAccess(
    providerId: string,
    opts: { env?: Record<string, string | undefined>; probe?: ValidationProbeFn; actor?: string } = {},
  ): Promise<{ outcome: string; entry: Record<string, unknown> }> {
    const catalog = this.catalog();
    const entry = catalog.getProvider(providerId);
    if (!entry) throw new NotFoundError(`provider:${providerId}`);
    const env = opts.env ?? (process.env as Record<string, string | undefined>);

    let outcome = this.credentialResolvable(entry, env);
    if (outcome === "AUTH_OK" && opts.probe) {
      try {
        const res = await opts.probe(entry);
        outcome = res.outcome;
        catalog.recordProbeObservation(providerId, res.outcome === "AUTH_OK" || res.outcome === "ACCESS_OK" ? "PASS" : res.outcome, {
          latency_ms: res.latency_ms,
          detail: res.detail,
          actor: opts.actor,
        });
      } catch (err) {
        // AUDIT R2 F2 — authority-typed failures (FAIL_CLOSED_*) are not
        // probe outcomes: a probe denied by an authority window must
        // never be recorded as UNREACHABLE evidence. Propagate.
        if (String((err as { code?: string })?.code ?? "").startsWith("FAIL_CLOSED_")) {
          throw err;
        }
        outcome = "UNREACHABLE";
        catalog.recordProbeObservation(providerId, "UNREACHABLE", {
          detail: sanitizeDiagnostic(err instanceof Error ? err.message : err) ?? undefined,
          actor: opts.actor,
        });
      }
    }
    const saved = catalog.recordAccessObservation(providerId, outcome, { actor: opts.actor });
    return { outcome, entry: saved };
  }

  /**
   * Provider qualification gates (donor §22): exists + auth acceptable +
   * protocol probe PASS + policy permits. All must hold; any false → not
   * qualified. Issues a qualification receipt bound to the material
   * fingerprint.
   */
  qualify(
    providerId: string,
    opts: {
      env?: Record<string, string | undefined>;
      policyVersion?: string;
      policyDenyList?: string[];
      actor?: string;
    } = {},
  ): { qualified: boolean; gates: Record<string, string>; receipt?: Record<string, unknown> } {
    const catalog = this.catalog();
    const entry = catalog.getProvider(providerId);
    if (!entry) throw new NotFoundError(`provider:${providerId}`);
    const env = opts.env ?? (process.env as Record<string, string | undefined>);

    // Phase E R5 §6–§7 — ONE canonical decision computes the required
    // gate set from durable state + policy input; the same computation
    // backs diagnostics here and the commit seam below, so caller values
    // are never authority (PROTOCOL_PROBED reads durable state only —
    // R2 §5; AUTH_REQUIRED is not acceptable authority — §4).
    const decision = catalog.computeQualificationDecision(providerId, {
      env,
      policyDenyList: opts.policyDenyList,
      policyVersion: opts.policyVersion,
    });
    const gates = decision.gates;
    if (!decision.qualified) {
      catalog.setLifecycle(providerId, String(entry.lifecycle_state), {
        actor: opts.actor,
        conditions: [...new Set([...(entry.conditions as string[]), "UNQUALIFIED"])],
      });
      return { qualified: false, gates };
    }
    const receipt = catalog.issueQualificationReceipt(providerId, {
      policy_version: decision.policy_version,
      env,
      policyDenyList: opts.policyDenyList,
      actor: opts.actor,
    });
    catalog.setLifecycle(providerId, "MODEL_DISCOVERY_ELIGIBLE", { actor: opts.actor });
    return { qualified: true, gates, receipt };
  }
}

export function providerRoutableGate(entry: Record<string, unknown>): { pass: boolean; reason?: string } {
  if (!PROVIDER_OK_STATES.has(String(entry.lifecycle_state))) {
    return { pass: false, reason: `PROVIDER_LIFECYCLE_${entry.lifecycle_state}` };
  }
  // Phase E §4/§6 — only proven current AUTH_OK authorizes work: AUTH_REQUIRED
  // (unresolved credential), UNREACHABLE, CREDENTIAL_MISSING, UNVALIDATED and
  // AUTH_FAILED/ACCESS_DENIED all fail closed.
  if (String(entry.auth_state) !== "AUTH_OK") {
    return { pass: false, reason: `PROVIDER_AUTH_${entry.auth_state}` };
  }
  const conditions = (entry.conditions ?? []) as string[];
  // Phase E R2 §11 — provider-only subset of providerModelEligibility:
  // they must agree on currentness — STALE is not current, not routable.
  if (
    conditions.includes("UNQUALIFIED") ||
    conditions.includes("DISABLED") ||
    conditions.includes("STALE") ||
    conditions.includes("REMOVED")
  ) {
    return { pass: false, reason: "PROVIDER_CONDITION_BLOCKED" };
  }
  return { pass: true };
}
