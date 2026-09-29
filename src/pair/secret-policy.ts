/**
 * P13 secret governance — release authority for installed credentials.
 *
 * The CredentialBroker vault is transport, not authority: a valid broker
 * token alone must never release a secret. This module is the canonical
 * metadata authority: per-credential `secret_policy` rows (references and
 * allow-sets only — never a value), a mission-time grant pin snapshot
 * (`metadata.secret_grants`), and the ordered authorizeRelease() check the
 * broker fetch path consults before any value leaves the vault.
 *
 * Semantics mirror P12: effective secret authority =
 *   mission-pinned grant ∩ current secret policy ∩ canonical mission/task
 *   context. Tightening revokes in-flight releases; expansion never
 *   retro-broadens an old mission. Everything fails closed and audits.
 */
import { digest, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { PairControlPlane } from "./service.js";

export const SECRET_POLICY_SCHEMA = "pair.os.vnext.secret-policy.v1";
export const SECRET_POLICY_STATUSES = ["ACTIVE", "DISABLED", "REVOKED"] as const;
export type SecretPolicyStatus = (typeof SECRET_POLICY_STATUSES)[number];

const SECRET_POLICY_FIELDS = new Set([
  "credential_reference_name",
  "business_id",
  "allowed_agent_ids",
  "allowed_executor_ids",
  "allowed_project_ids",
  "allowed_route_ids",
  "allowed_purpose",
]);

const ALLOW_SETS = [
  "allowed_agent_ids",
  "allowed_executor_ids",
  "allowed_project_ids",
  "allowed_route_ids",
] as const;

export function secretPolicyIdFor(businessId: string, credentialRef: string): string {
  return `SPOL_${digest(`${businessId}:${credentialRef}`).slice(0, 24)}`;
}

/** Canonical digest of a policy's authority-relevant fields (no volatile
 *  bookkeeping — version/updated_at are excluded so digest survives CAS). */
export function secretPolicyDigest(policy: Record<string, unknown>): string {
  return digest({
    schema: SECRET_POLICY_SCHEMA,
    policy_id: policy.policy_id,
    credential_reference_name: policy.credential_reference_name,
    business_id: policy.business_id,
    status: policy.status,
    allowed_agent_ids: policy.allowed_agent_ids ?? null,
    allowed_executor_ids: policy.allowed_executor_ids ?? null,
    allowed_project_ids: policy.allowed_project_ids ?? null,
    allowed_route_ids: policy.allowed_route_ids ?? null,
    allowed_purpose: policy.allowed_purpose ?? null,
    policy_version: policy.policy_version,
  });
}

function normalizeAllowList(value: unknown, field: string): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new IntegrityError("FAIL_CLOSED_SECRET_POLICY_FIELDS", field);
  }
  return value.map(String).sort();
}

export class SecretPolicyService {
  constructor(private readonly service: PairControlPlane) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  /* ---------------- policy CRUD (metadata only, CAS, audited) ------------ */

  createPolicy(
    input: Record<string, unknown>,
    actor: string,
  ): Record<string, unknown> {
    const ref = String(input.credential_reference_name ?? "");
    const businessId = String(input.business_id ?? "");
    if (!ref) throw new IntegrityError("FAIL_CLOSED_SECRET_REF_REQUIRED", "credential_reference_name");
    if (!businessId) throw new IntegrityError("FAIL_CLOSED_SECRET_BUSINESS_REQUIRED", "business_id");
    if (!this.store.tryGet("business", businessId)) {
      throw new IntegrityError("FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN", businessId);
    }
    for (const k of Object.keys(input)) {
      if (!SECRET_POLICY_FIELDS.has(k)) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_POLICY_FIELDS", k);
      }
    }
    for (const f of ALLOW_SETS) normalizeAllowList(input[f], f);
    const id = secretPolicyIdFor(businessId, ref);
    if (this.store.tryGet("secret_policy", id)) {
      // One canonical policy per (business, credential ref) — use update.
      throw new IntegrityError("FAIL_CLOSED_SECRET_POLICY_EXISTS", id);
    }
    const row = {
      schema: SECRET_POLICY_SCHEMA,
      policy_id: id,
      policy_version: 1,
      credential_reference_name: ref,
      business_id: businessId,
      status: "ACTIVE",
      allowed_agent_ids: normalizeAllowList(input.allowed_agent_ids, "allowed_agent_ids"),
      allowed_executor_ids: normalizeAllowList(input.allowed_executor_ids, "allowed_executor_ids"),
      allowed_project_ids: normalizeAllowList(input.allowed_project_ids, "allowed_project_ids"),
      allowed_route_ids: normalizeAllowList(input.allowed_route_ids, "allowed_route_ids"),
      allowed_purpose: input.allowed_purpose ? String(input.allowed_purpose) : null,
      actor,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("secret_policy", id, row, 0);
    this.store.event({
      entity_type: "secret_policy",
      entity_id: id,
      event_type: "SECRET_POLICY_CREATED",
      actor,
      metadata: { credential_reference_name: ref, business_id: businessId },
    });
    return saved;
  }

  /** CAS update of allow-sets/purpose; bumps policy_version. */
  updatePolicy(
    policyId: string,
    patch: Record<string, unknown>,
    expectedVersion: number,
    actor: string,
  ): Record<string, unknown> {
    const cur = this.store.get("secret_policy", policyId);
    for (const k of Object.keys(patch)) {
      if (!SECRET_POLICY_FIELDS.has(k) && k !== "status") {
        throw new IntegrityError("FAIL_CLOSED_SECRET_POLICY_FIELDS", k);
      }
    }
    if (patch.status != null && !SECRET_POLICY_STATUSES.includes(String(patch.status) as SecretPolicyStatus)) {
      throw new IntegrityError("FAIL_CLOSED_SECRET_STATUS", String(patch.status));
    }
    if (
      patch.business_id != null &&
      String(patch.business_id) !== String(cur.business_id)
    ) {
      throw new IntegrityError("FAIL_CLOSED_SECRET_CROSS_BUSINESS", policyId);
    }
    if (
      patch.credential_reference_name != null &&
      String(patch.credential_reference_name) !== String(cur.credential_reference_name)
    ) {
      throw new IntegrityError("FAIL_CLOSED_SECRET_REF_IMMUTABLE", policyId);
    }
    const next: Record<string, unknown> = {
      ...cur,
      allowed_agent_ids:
        patch.allowed_agent_ids !== undefined
          ? normalizeAllowList(patch.allowed_agent_ids, "allowed_agent_ids")
          : cur.allowed_agent_ids,
      allowed_executor_ids:
        patch.allowed_executor_ids !== undefined
          ? normalizeAllowList(patch.allowed_executor_ids, "allowed_executor_ids")
          : cur.allowed_executor_ids,
      allowed_project_ids:
        patch.allowed_project_ids !== undefined
          ? normalizeAllowList(patch.allowed_project_ids, "allowed_project_ids")
          : cur.allowed_project_ids,
      allowed_route_ids:
        patch.allowed_route_ids !== undefined
          ? normalizeAllowList(patch.allowed_route_ids, "allowed_route_ids")
          : cur.allowed_route_ids,
      allowed_purpose:
        patch.allowed_purpose !== undefined
          ? patch.allowed_purpose == null
            ? null
            : String(patch.allowed_purpose)
          : cur.allowed_purpose,
      status: patch.status != null ? String(patch.status) : cur.status,
      policy_version: Number(cur.policy_version) + 1,
      actor,
      updated_at: utcnow(),
      version: Number(cur.version),
    };
    const saved = this.store.put("secret_policy", policyId, next, expectedVersion);
    this.store.event({
      entity_type: "secret_policy",
      entity_id: policyId,
      event_type: String(saved.status) === "REVOKED" ? "SECRET_POLICY_REVOKED" : "SECRET_POLICY_UPDATED",
      actor,
      metadata: {
        credential_reference_name: saved.credential_reference_name,
        policy_version: saved.policy_version,
        status: saved.status,
      },
    });
    return saved;
  }

  /** Revoke/disable a policy by id; future releases fail closed. */
  setPolicyStatus(policyId: string, status: SecretPolicyStatus, actor: string): Record<string, unknown> {
    const cur = this.store.get("secret_policy", policyId);
    return this.updatePolicy(policyId, { status }, Number(cur.version), actor);
  }

  getPolicy(policyId: string): Record<string, unknown> | null {
    return this.store.tryGet("secret_policy", policyId);
  }

  listPolicies(businessId?: string): Array<Record<string, unknown>> {
    const all = this.store.list("secret_policy");
    return businessId ? all.filter((p) => String(p.business_id) === businessId) : all;
  }

  /* ---------------- mission pin ------------------------------------------ */

  /**
   * §23: snapshot every ACTIVE policy of the mission's business into
   * `metadata.secret_grants` at creation. The pin records the resolved
   * allow-sets at pin time + policy provenance — never a secret value.
   * Tightening revokes in-flight releases; expansion never broadens the
   * pinned set (intersect semantics at fetch time).
   */
  pinForMission(input: { businessId: string | null }): Array<Record<string, unknown>> {
    const grants: Array<Record<string, unknown>> = [];
    if (!input.businessId) return grants;
    for (const p of this.listPolicies(input.businessId)) {
      if (String(p.status) !== "ACTIVE") continue;
      grants.push({
        credential_reference_name: String(p.credential_reference_name),
        policy_id: String(p.policy_id),
        policy_version: Number(p.policy_version),
        policy_digest: secretPolicyDigest(p),
        allowed_agent_ids: (p.allowed_agent_ids as string[] | null) ?? null,
        allowed_executor_ids: (p.allowed_executor_ids as string[] | null) ?? null,
        allowed_project_ids: (p.allowed_project_ids as string[] | null) ?? null,
        allowed_route_ids: (p.allowed_route_ids as string[] | null) ?? null,
        allowed_purpose: (p.allowed_purpose as string | null) ?? null,
      });
    }
    return grants.sort((a, b) =>
      String(a.credential_reference_name).localeCompare(String(b.credential_reference_name)),
    );
  }

  /* ---------------- release authority ------------------------------------- */

  /**
   * Ordered fail-closed authorization for a broker fetch. Returns a
   * decision — the caller audits and either releases or denies. A missing
   * pin is a denial, never "all credentials allowed" (§24).
   */
  authorizeRelease(params: {
    mission: Record<string, unknown>;
    task: Record<string, unknown>;
    credentialRef: string;
    executorId: string | null;
  }): { granted: boolean; reason: string; policy?: Record<string, unknown>; grant?: Record<string, unknown> } {
    const { mission, task, credentialRef } = params;
    const executorId = params.executorId ? String(params.executorId) : null;
    const md = (mission.metadata ?? {}) as Record<string, unknown>;
    const grants = (md.secret_grants as Array<Record<string, unknown>> | undefined) ?? [];
    const grant = grants.find(
      (g) => String(g.credential_reference_name) === credentialRef,
    );
    if (!grant) {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_NOT_PINNED" };
    }
    const businessId = String(md.business_id ?? "");
    const policyId = String(grant.policy_id);
    const policy = this.store.tryGet("secret_policy", policyId);
    if (!policy) {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_POLICY_MISSING" };
    }
    // Policy integrity: identity + pinned provenance.
    if (String(policy.credential_reference_name) !== credentialRef) {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_POLICY_MISMATCH" };
    }
    if (String(policy.business_id) !== businessId) {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_CROSS_BUSINESS" };
    }
    if (String(policy.status) !== "ACTIVE") {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_POLICY_REVOKED" };
    }
    // Pin provenance: recompute the digest purely from the pinned
    // snapshot — a tampered/forged grant fails closed here.
    const pinnedDigest = secretPolicyDigest({
      policy_id: grant.policy_id,
      credential_reference_name: grant.credential_reference_name,
      business_id: businessId,
      status: "ACTIVE",
      allowed_agent_ids: grant.allowed_agent_ids,
      allowed_executor_ids: grant.allowed_executor_ids,
      allowed_project_ids: grant.allowed_project_ids,
      allowed_route_ids: grant.allowed_route_ids,
      allowed_purpose: grant.allowed_purpose ?? null,
      policy_version: Number(grant.policy_version),
    });
    if (pinnedDigest !== String(grant.policy_digest)) {
      return { granted: false, reason: "FAIL_CLOSED_SECRET_PIN_PROVENANCE" };
    }
    const agentId = md.org_agent_id ? String(md.org_agent_id) : null;
    const projectId = String(mission.project_id ?? "");
    const routeId = task.selected_route_id ? String(task.selected_route_id) : null;
    // Intersect: pinned ∩ current — both must admit each axis.
    const REASON: Record<string, string> = {
      allowed_agent_ids: "FAIL_CLOSED_SECRET_AGENT_DENIED",
      allowed_executor_ids: "FAIL_CLOSED_SECRET_EXECUTOR_DENIED",
      allowed_project_ids: "FAIL_CLOSED_SECRET_PROJECT_DENIED",
      allowed_route_ids: "FAIL_CLOSED_SECRET_ROUTE_DENIED",
    };
    for (const [field, subject] of [
      ["allowed_agent_ids", agentId],
      ["allowed_executor_ids", executorId],
      ["allowed_project_ids", projectId],
      ["allowed_route_ids", routeId],
    ] as Array<[string, string | null]>) {
      const pinnedSet = grant[field] as string[] | null;
      const currentSet = policy[field] as string[] | null;
      if (pinnedSet != null && (subject == null || !pinnedSet.includes(subject))) {
        return { granted: false, reason: REASON[field] };
      }
      if (currentSet != null && (subject == null || !currentSet.includes(subject))) {
        return { granted: false, reason: REASON[field] };
      }
    }
    // §31: a secret grant never expands P12 — if the bound executor is
    // denied by the agent execution contract, release is denied.
    if (agentId && executorId) {
      let effective: { denied_executor_ids: Set<string> };
      try {
        effective = this.service.agentContracts.effectiveForMission(mission);
      } catch {
        return { granted: false, reason: "FAIL_CLOSED_SECRET_AGENT_POLICY" };
      }
      if ((effective.denied_executor_ids as Set<string>).has(executorId)) {
        return { granted: false, reason: "FAIL_CLOSED_SECRET_EXECUTOR_DENIED" };
      }
    }
    return { granted: true, reason: "GRANTED", policy, grant };
  }
}
