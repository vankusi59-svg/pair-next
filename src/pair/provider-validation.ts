/**
 * provider-validation — access validation + qualification gates (P6).
 *
 * Port of donor provider_validation.py semantics (a557df2): validate access
 * (adapter supports + credential resolvable + optional bounded probe) then
 * qualify only when every gate passes. Any gate failing → not qualified,
 * never routable.
 */

import { IntegrityError, NotFoundError } from "./errors.js";
import { PROVIDER_OK_STATES, ProviderCatalog } from "./provider-catalog.js";
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
    const ref = entry.credential_reference_name;
    if (!ref) return "AUTH_OK"; // provider declares no credential requirement
    return env[String(ref)] ? "AUTH_OK" : "CREDENTIAL_MISSING";
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
        outcome = "UNREACHABLE";
        catalog.recordProbeObservation(providerId, "UNREACHABLE", {
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
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
      probed?: boolean;
      actor?: string;
    } = {},
  ): { qualified: boolean; gates: Record<string, string>; receipt?: Record<string, unknown> } {
    const catalog = this.catalog();
    const entry = catalog.getProvider(providerId);
    if (!entry) throw new NotFoundError(`provider:${providerId}`);
    const env = opts.env ?? (process.env as Record<string, string | undefined>);

    const gates: Record<string, string> = {};
    gates.PROVIDER_EXISTS = "PASS";
    gates.AUTH_ACCEPTABLE =
      ["AUTH_OK", "AUTH_REQUIRED"].includes(String(entry.auth_state)) ||
      this.credentialResolvable(entry, env) === "AUTH_OK"
        ? "PASS"
        : "FAIL";
    gates.PROTOCOL_PROBED = entry.probe_state === "PROBED" || opts.probed === true ? "PASS" : "FAIL";
    gates.HEALTH_ACCEPTABLE = !["UNAVAILABLE", "DOWN"].includes(String(entry.health_state)) ? "PASS" : "FAIL";
    gates.POLICY_PERMITS = !(opts.policyDenyList ?? []).includes(providerId) ? "PASS" : "FAIL";

    const qualified = Object.values(gates).every((g) => g === "PASS");
    if (!qualified) {
      catalog.setLifecycle(providerId, String(entry.lifecycle_state), {
        actor: opts.actor,
        conditions: [...new Set([...(entry.conditions as string[]), "UNQUALIFIED"])],
      });
      return { qualified: false, gates };
    }
    const receipt = catalog.issueQualificationReceipt(providerId, {
      policy_version: opts.policyVersion ?? "P6_POLICY_V1",
      gates,
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
  if (entry.auth_state === "AUTH_FAILED" || entry.auth_state === "ACCESS_DENIED") {
    return { pass: false, reason: `PROVIDER_AUTH_${entry.auth_state}` };
  }
  const conditions = (entry.conditions ?? []) as string[];
  if (conditions.includes("UNQUALIFIED") || conditions.includes("DISABLED")) {
    return { pass: false, reason: "PROVIDER_CONDITION_BLOCKED" };
  }
  return { pass: true };
}
