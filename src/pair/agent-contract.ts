/**
 * Agent Execution Contract (P12).
 *
 * Turns `org_agent` from an organizational record into an enforceable AI
 * employee execution identity. A contract can only NARROW the existing PAIR
 * authority (capabilities, executors, routes, projects, context scopes) —
 * it never expands GovernedTaskGate authority, executor registration,
 * provider qualification, credential access, or business isolation.
 *
 * effective authority at task execution
 *   = mission's pinned contract policy
 *   ∩ current contract policy
 *   ∩ existing PAIR policy
 *
 * Explicit deny always wins over allow. Exactly one effective contract per
 * org_agent: contract_id is a deterministic digest of the agent id, so a
 * CAS create can produce at most one row and concurrent updaters CAS on
 * `version` — exactly one writer wins, the loser gets the canonical
 * FAIL_CLOSED_VERSION_CONFLICT.
 *
 * Enforcement locations (canonical path only — no second engine):
 *   - MissionControl.startMission: pin contract provenance onto mission
 *     metadata + assert the agent is executable (status/scope/project).
 *   - GovernedTaskGate.create_governed_task: authoritative capability,
 *     executor and project checks using pinned ∩ current ∩ PAIR.
 *   - MissionRouter / RouteSelector: contract constrains executor
 *     candidates and route preferences inside the existing authorities.
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

export const AGENT_CONTRACT_SCHEMA = "pair.os.vnext.agent-execution-contract.v1";
export const AGENT_CONTRACT_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type AgentContractStatus = (typeof AGENT_CONTRACT_STATUSES)[number];

/** Documented context scopes a contract may grant an agent (§15). */
export const CONTEXT_SCOPES = ["business", "project", "agent", "experience"] as const;

export const AGENT_CONTRACT_TABLE = "agent_execution_contract";

type Row = Record<string, unknown> & { version: number };

export interface AgentContractPolicy {
  /** null = no contract-level narrowing (PAIR authority still applies). */
  allowed_capabilities: string[] | null;
  denied_capabilities: string[];
  allowed_executor_ids: string[] | null;
  denied_executor_ids: string[];
  preferred_executor_ids: string[];
  executor_fallback_allowed: boolean;
  preferred_route_ids: string[];
  denied_route_ids: string[];
  route_fallback_allowed: boolean;
  allowed_project_ids: string[] | null;
  allowed_context_scopes: string[];
}

export interface AgentContractPin {
  contract_id: string;
  org_agent_id: string;
  business_id: string;
  contract_version: number;
  contract_digest: string;
  schema_version: string;
  policy: AgentContractPolicy;
}

export interface EffectiveAgentPolicy {
  org_agent_id: string;
  contract_id: string;
  /** Current contract version — revocation follows this. */
  contract_version: number;
  /** Version pinned onto the mission at startMission time. */
  pinned_version: number;
  contract_digest: string;
  /** null = unconstrained; otherwise an allow-set already minus denies. */
  allowed_capabilities: Set<string> | null;
  denied_capabilities: Set<string>;
  allowed_executor_ids: Set<string> | null;
  denied_executor_ids: Set<string>;
  preferred_executor_ids: string[];
  executor_fallback_allowed: boolean;
  preferred_route_ids: string[];
  denied_route_ids: Set<string>;
  route_fallback_allowed: boolean;
  /**
   * Hard executor restriction: when any snapshot (pinned/current) sets
   * `executor_fallback_allowed=false` with a non-empty preferred set, the
   * preferred ids become a hard allow-set — intersection across snapshots
   * (R1 §1). null = no hard restriction.
   */
  restricted_executor_ids: Set<string> | null;
  /**
   * Hard route restriction under `route_fallback_allowed=false`,
   * intersected across snapshots minus the denied union (R1 §3).
   */
  restricted_route_ids: Set<string> | null;
  allowed_project_ids: Set<string> | null;
  allowed_context_scopes: Set<string>;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_FIELDS", `${field} must be string[]`);
  }
  return [...new Set(value.map((v) => String(v).trim()))];
}

function normalizeOptionalStringList(value: unknown, field: string): string[] | null {
  if (value === undefined || value === null) return null;
  return normalizeStringList(value, field);
}

function normalizeBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_FIELDS", `${field} must be boolean`);
  }
  return value;
}

/** Canonical policy keys — anything else fails closed (R1 §5). */
const POLICY_KEYS = new Set([
  "allowed_capabilities",
  "denied_capabilities",
  "allowed_executor_ids",
  "denied_executor_ids",
  "preferred_executor_ids",
  "executor_fallback_allowed",
  "preferred_route_ids",
  "denied_route_ids",
  "route_fallback_allowed",
  "allowed_project_ids",
  "allowed_context_scopes",
]);

/** Fail-closed policy normalization + canonical shape. */
export function normalizeContractPolicy(input: unknown): AgentContractPolicy {
  const src = (input ?? {}) as Record<string, unknown>;
  if (typeof src !== "object" || Array.isArray(src)) {
    throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_FIELDS", "policy must be an object");
  }
  for (const key of Object.keys(src)) {
    if (!POLICY_KEYS.has(key)) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_FIELDS", `unknown policy field ${key}`);
    }
  }
  const policy: AgentContractPolicy = {
    allowed_capabilities: normalizeOptionalStringList(src.allowed_capabilities, "allowed_capabilities"),
    denied_capabilities: normalizeStringList(src.denied_capabilities, "denied_capabilities"),
    allowed_executor_ids: normalizeOptionalStringList(src.allowed_executor_ids, "allowed_executor_ids"),
    denied_executor_ids: normalizeStringList(src.denied_executor_ids, "denied_executor_ids"),
    preferred_executor_ids: normalizeStringList(src.preferred_executor_ids, "preferred_executor_ids"),
    executor_fallback_allowed: normalizeBoolean(src.executor_fallback_allowed, "executor_fallback_allowed", true),
    preferred_route_ids: normalizeStringList(src.preferred_route_ids, "preferred_route_ids"),
    denied_route_ids: normalizeStringList(src.denied_route_ids, "denied_route_ids"),
    route_fallback_allowed: normalizeBoolean(src.route_fallback_allowed, "route_fallback_allowed", true),
    allowed_project_ids: normalizeOptionalStringList(src.allowed_project_ids, "allowed_project_ids"),
    allowed_context_scopes: normalizeStringList(src.allowed_context_scopes, "allowed_context_scopes"),
  };
  for (const scope of policy.allowed_context_scopes) {
    if (!(CONTEXT_SCOPES as readonly string[]).includes(scope)) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_SCOPE_UNKNOWN", scope);
    }
  }
  return policy;
}

/** The digest a contract row/pin must self-consistently carry. */
export function contractDigest(parts: {
  contract_id: string;
  org_agent_id: string;
  business_id: string;
  contract_version: number;
  policy: AgentContractPolicy;
}): string {
  return digest({
    schema: AGENT_CONTRACT_SCHEMA,
    contract_id: parts.contract_id,
    org_agent_id: parts.org_agent_id,
    business_id: parts.business_id,
    contract_version: parts.contract_version,
    policy: parts.policy,
  });
}

export class AgentContractService {
  constructor(private readonly store: PairEvidenceStore) {}

  /** Deterministic id → exactly one contract can ever exist per agent. */
  contractIdFor(orgAgentId: string): string {
    return `AEC_${digest(`agent-execution-contract:${orgAgentId}`).slice(0, 24)}`;
  }

  get(orgAgentId: string): Row | null {
    return this.store.tryGet(AGENT_CONTRACT_TABLE, this.contractIdFor(orgAgentId));
  }

  /** Globally registered PAIR capabilities — contract allow-lists are
   *  bounded by this set (a contract cannot grant what PAIR doesn't know). */
  registeredCapabilities(): Set<string> {
    return new Set(this.store.list("capability").map((c) => String(c.capability_id)));
  }

  /**
   * Baseline contract for an existing-safe-authority agent: no capability /
   * executor / route narrowing, project scope pinned to the agent's own
   * business project, all documented context scopes. A pre-P12
   * `executor_binding` that names a registered executor becomes the
   * first preferred executor — it grants nothing, only reorders within
   * the router's eligible set.
   */
  private baselinePolicy(agent: Row): AgentContractPolicy {
    let projectIds: string[] | null = null;
    const business = this.store.tryGet("business", String(agent.business_id));
    if (business && business.project_id) {
      projectIds = [String(business.project_id)];
    }
    const preferredExecutors: string[] = [];
    const binding = agent.executor_binding ? String(agent.executor_binding) : "";
    if (binding && this.store.tryGet("executor", binding)) {
      preferredExecutors.push(binding);
    }
    return {
      allowed_capabilities: null,
      denied_capabilities: [],
      allowed_executor_ids: null,
      denied_executor_ids: [],
      preferred_executor_ids: preferredExecutors,
      executor_fallback_allowed: true,
      preferred_route_ids: [],
      denied_route_ids: [],
      route_fallback_allowed: true,
      allowed_project_ids: projectIds,
      allowed_context_scopes: [...CONTEXT_SCOPES],
    };
  }

  private buildRow(agent: Row, policy: AgentContractPolicy, version: number, actor: string): Row {
    const contractId = this.contractIdFor(String(agent.agent_id));
    const row: Row = {
      contract_id: contractId,
      org_agent_id: String(agent.agent_id),
      business_id: String(agent.business_id),
      status: "ACTIVE" as AgentContractStatus,
      schema_version: AGENT_CONTRACT_SCHEMA,
      contract_version: version,
      policy,
      contract_digest: contractDigest({
        contract_id: contractId,
        org_agent_id: String(agent.agent_id),
        business_id: String(agent.business_id),
        contract_version: version,
        policy,
      }),
      actor,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
    return row;
  }

  private validatePolicy(policy: AgentContractPolicy): void {
    const registered = this.registeredCapabilities();
    for (const cap of [
      ...(policy.allowed_capabilities ?? []),
      ...policy.denied_capabilities,
    ]) {
      if (!registered.has(cap)) {
        throw new PolicyError("FAIL_CLOSED_AGENT_CAPABILITY_UNKNOWN", cap);
      }
    }
  }

  /**
   * Materialize a baseline contract for a legacy/pre-P12 agent, or create an
   * explicit contract. CAS-create on the deterministic id: concurrent
   * creators race, exactly one wins, the loser adopts the canonical row.
   */
  materialize(agentId: string, actor: string, policy?: Partial<AgentContractPolicy>): Row {
    const agent = this.store.get("org_agent", agentId); // throws if absent
    const existing = this.get(agentId);
    if (existing) return existing;
    const merged = normalizeContractPolicy({ ...this.baselinePolicy(agent), ...(policy ?? {}) });
    this.validatePolicy(merged);
    const row = this.buildRow(agent, merged, 1, actor);
    try {
      const saved = this.store.put(AGENT_CONTRACT_TABLE, String(row.contract_id), row, 0);
      this.store.event({
        entity_type: AGENT_CONTRACT_TABLE,
        entity_id: String(row.contract_id),
        event_type: policy ? "AGENT_EXECUTION_CONTRACT_CREATED" : "AGENT_EXECUTION_CONTRACT_MATERIALIZED",
        new_state: "ACTIVE",
        actor,
        metadata: {
          org_agent_id: agentId,
          business_id: row.business_id,
          contract_version: 1,
          contract_digest: row.contract_digest,
        },
      });
      return saved;
    } catch (err) {
      // Concurrent creator won the CAS — adopt the canonical row.
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        const canonical = this.get(agentId);
        if (canonical) return canonical;
      }
      throw err;
    }
  }

  /**
   * Resolve the canonical {agent, contract}. When `materialize` is true a
   * missing contract is deterministically backfilled (baseline + audit) —
   * never interpreted as unlimited access.
   */
  resolve(agentId: string, opts: { materialize?: boolean; actor?: string } = {}): { agent: Row; contract: Row } {
    const agent = this.store.get("org_agent", agentId);
    let contract = this.get(agentId);
    if (!contract) {
      if (opts.materialize === false) {
        throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_MISSING", agentId);
      }
      contract = this.materialize(agentId, opts.actor ?? "PAIR_AGENT_CONTRACT");
    }
    this.validateContractRow(agent, contract);
    return { agent, contract };
  }

  /**
   * Canonical contract-row validation (R1 §4) — invoked wherever a
   * contract is resolved for authority: deterministic id, agent/business
   * binding, schema, status, version, policy normalization, and
   * self-consistent digest. Any mismatch fails closed.
   */
  private validateContractRow(agent: Row, contract: Row): void {
    if (String(contract.contract_id) !== this.contractIdFor(String(agent.agent_id))) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY", String(contract.contract_id));
    }
    if (String(contract.org_agent_id) !== String(agent.agent_id)) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE", String(agent.agent_id));
    }
    // Business isolation: the contract's business identity is bound to the
    // agent's business at materialization and cannot cross later.
    if (String(contract.business_id) !== String(agent.business_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_CONTRACT_SCOPE",
        `contract business ${String(contract.business_id)} != agent business ${String(agent.business_id)}`,
      );
    }
    if (String(contract.schema_version) !== AGENT_CONTRACT_SCHEMA) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY", String(contract.schema_version));
    }
    if (!(AGENT_CONTRACT_STATUSES as readonly string[]).includes(String(contract.status))) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY", String(contract.status));
    }
    const cv = Number(contract.contract_version);
    if (!Number.isInteger(cv) || cv < 1) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY", String(contract.contract_version));
    }
    const policy = normalizeContractPolicy(contract.policy); // throws on malformed/unknown fields
    const recomputed = contractDigest({
      contract_id: String(contract.contract_id),
      org_agent_id: String(contract.org_agent_id),
      business_id: String(contract.business_id),
      contract_version: cv,
      policy,
    });
    if (recomputed !== String(contract.contract_digest)) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_CONTRACT_DIGEST",
        `${String(contract.contract_id)}@${String(contract.contract_version)}`,
      );
    }
    // Normalized view is what downstream consumers must see.
    contract.policy = policy;
  }

  /** Full executability assertion used at mission-binding time. */
  assertExecutable(
    agentId: string,
    opts: { businessId?: string | null; projectId?: string | null; actor?: string } = {},
  ): { agent: Row; contract: Row } {
    const { agent, contract } = this.resolve(agentId, { actor: opts.actor });
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", `${agentId}:${String(agent.status)}`);
    }
    if (String(contract.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_CONTRACT_DISABLED", agentId);
    }
    if (opts.businessId && String(agent.business_id) !== String(opts.businessId)) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_BUSINESS_MISMATCH",
        `agent ${agentId} in ${String(agent.business_id)} != ${String(opts.businessId)}`,
      );
    }
    const allowedProjects = (contract.policy as AgentContractPolicy).allowed_project_ids;
    if (opts.projectId && allowedProjects !== null && !allowedProjects.includes(String(opts.projectId))) {
      throw new PolicyError("FAIL_CLOSED_AGENT_PROJECT_DENIED", `${agentId}:${String(opts.projectId)}`);
    }
    return { agent, contract };
  }

  /** Immutable provenance snapshot pinned onto mission metadata (§8). */
  pin(agentId: string, opts: { businessId?: string | null; projectId?: string | null; actor?: string } = {}): AgentContractPin {
    const { agent, contract } = this.assertExecutable(agentId, opts);
    const policy = contract.policy as AgentContractPolicy;
    const pin: AgentContractPin = {
      contract_id: String(contract.contract_id),
      org_agent_id: String(agent.agent_id),
      business_id: String(agent.business_id),
      contract_version: Number(contract.contract_version),
      contract_digest: String(contract.contract_digest),
      schema_version: String(contract.schema_version),
      policy,
    };
    // Self-consistency: the pinned digest must be derivable from the pinned
    // fields — callers and the gate recompute it the same way.
    if (contractDigest({ ...pin }) !== pin.contract_digest) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_DIGEST", String(contract.contract_id));
    }
    return pin;
  }

  /**
   * Update a contract policy under CAS. `expected_version` is the caller's
   * observed `version`; mismatch → canonical FAIL_CLOSED_VERSION_CONFLICT.
   */
  update(agentId: string, policyPatch: Partial<AgentContractPolicy>, expectedVersion: number, actor: string): Row {
    const { contract } = this.resolve(agentId, { materialize: false });
    if (Number(contract.version) !== expectedVersion) {
      throw new IntegrityError(
        "FAIL_CLOSED_VERSION_CONFLICT",
        `${String(contract.contract_id)}@${expectedVersion}`,
      );
    }
    const nextVersion = Number(contract.contract_version) + 1;
    const merged = normalizeContractPolicy({
      ...(contract.policy as AgentContractPolicy),
      ...policyPatch,
    });
    this.validatePolicy(merged);
    const next = {
      ...contract,
      contract_version: nextVersion,
      policy: merged,
      contract_digest: contractDigest({
        contract_id: String(contract.contract_id),
        org_agent_id: agentId,
        business_id: String(contract.business_id),
        contract_version: nextVersion,
        policy: merged,
      }),
      actor,
      updated_at: utcnow(),
    };
    const saved = this.store.put(AGENT_CONTRACT_TABLE, String(contract.contract_id), next, Number(contract.version));
    this.store.event({
      entity_type: AGENT_CONTRACT_TABLE,
      entity_id: String(contract.contract_id),
      event_type: "AGENT_EXECUTION_CONTRACT_UPDATED",
      actor,
      metadata: {
        org_agent_id: agentId,
        contract_version: nextVersion,
        contract_digest: next.contract_digest,
      },
    });
    return saved;
  }

  setStatus(agentId: string, status: AgentContractStatus, actor: string): Row {
    if (!AGENT_CONTRACT_STATUSES.includes(status)) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_STATUS", status);
    }
    const { contract } = this.resolve(agentId, { materialize: false });
    const next = { ...contract, status, actor, updated_at: utcnow() };
    const saved = this.store.put(AGENT_CONTRACT_TABLE, String(contract.contract_id), next, Number(contract.version));
    this.store.event({
      entity_type: AGENT_CONTRACT_TABLE,
      entity_id: String(contract.contract_id),
      event_type: status === "DISABLED" ? "AGENT_EXECUTION_CONTRACT_DISABLED" : "AGENT_EXECUTION_CONTRACT_ENABLED",
      old_state: String(contract.status),
      new_state: status,
      actor,
      metadata: { org_agent_id: agentId, contract_version: contract.contract_version },
    });
    return saved;
  }

  /** Pinned snapshot carried on a mission row — digest-verified. */
  private pinnedPolicy(mission: Record<string, unknown>): AgentContractPin | null {
    const md = mission.metadata as Record<string, unknown> | undefined;
    const pin = md?.agent_contract as AgentContractPin | undefined;
    if (!pin) return null;
    if (
      contractDigest({
        contract_id: String(pin.contract_id),
        org_agent_id: String(pin.org_agent_id),
        business_id: String(pin.business_id),
        contract_version: Number(pin.contract_version),
        policy: normalizeContractPolicy(pin.policy),
      }) !== String(pin.contract_digest)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_CONTRACT_DIGEST",
        `${String(pin.contract_id)}@${String(pin.contract_version)}`,
      );
    }
    return pin;
  }

  /**
   * effective = pinned ∩ current ∩ PAIR, deny-wins. Throws (fail closed) on
   * any unresolvable/mismatched provenance.
   */
  effectiveForMission(mission: Record<string, unknown>): EffectiveAgentPolicy {
    const md = (mission.metadata ?? {}) as Record<string, unknown>;
    const agentId = md.org_agent_id ? String(md.org_agent_id) : null;
    if (!agentId) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE", "mission has no org_agent_id");
    }
    const { agent, contract } = this.resolve(agentId, { actor: "PAIR_GOVERNED_TASK_GATE" });
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", `${agentId}:${String(agent.status)}`);
    }
    if (String(contract.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_CONTRACT_DISABLED", agentId);
    }
    const missionBusiness = md.business_id ? String(md.business_id) : null;
    if (missionBusiness && missionBusiness !== String(agent.business_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_BUSINESS_MISMATCH",
        `mission business ${missionBusiness} != agent business ${String(agent.business_id)}`,
      );
    }
    const pin = this.pinnedPolicy(mission);
    // R1 §2: an agent-bound mission reaching governed execution MUST carry
    // its pinned contract provenance — the current contract is never a
    // substitute for immutable pinned evidence.
    if (!pin) {
      throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_PIN_MISSING", String(mission.mission_id));
    }
    {
      if (String(pin.contract_id) !== String(contract.contract_id) || String(pin.org_agent_id) !== agentId) {
        throw new IntegrityError("FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE", String(pin.contract_id));
      }
      if (String(pin.business_id) !== String(agent.business_id)) {
        throw new IntegrityError("FAIL_CLOSED_AGENT_BUSINESS_MISMATCH", String(pin.business_id));
      }
      // A pin naming a version beyond the current contract cannot exist —
      // contract_version only increments; future-pinned provenance is invalid.
      if (Number(pin.contract_version) > Number(contract.contract_version)) {
        throw new IntegrityError(
          "FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE",
          `pinned v${String(pin.contract_version)} > current v${String(contract.contract_version)}`,
        );
      }
    }
    const pinned = pin.policy;
    const current = contract.policy as AgentContractPolicy;

    const mergeAllow = (a: string[] | null | undefined, b: string[] | null | undefined): Set<string> | null => {
      if (a == null && b == null) return null;
      if (a == null) return new Set(b!);
      if (b == null) return new Set(a);
      return new Set(a.filter((x) => b.includes(x)));
    };
    const union = (a: string[] | undefined, b: string[] | undefined): Set<string> =>
      new Set([...(a ?? []), ...(b ?? [])]);

    const registered = this.registeredCapabilities();
    let allowedCaps = mergeAllow(pinned.allowed_capabilities, current.allowed_capabilities);
    const deniedCaps = union(pinned.denied_capabilities, current.denied_capabilities);
    // A contract allow-list can never name what PAIR doesn't register —
    // intersect with the global registry so unknown ids are dead authority.
    if (allowedCaps) {
      allowedCaps = new Set([...allowedCaps].filter((c) => registered.has(c)));
      for (const c of deniedCaps) allowedCaps.delete(c);
    }

    const allowedExecs = mergeAllow(pinned.allowed_executor_ids, current.allowed_executor_ids);
    const deniedExecs = union(pinned.denied_executor_ids, current.denied_executor_ids);
    const allowedProjects = mergeAllow(pinned.allowed_project_ids, current.allowed_project_ids);
    const ctxScopes = new Set(
      pinned.allowed_context_scopes.filter((s) => current.allowed_context_scopes.includes(s)),
    );

    // R1 §1: executor_fallback_allowed=false turns the preferred set into a
    // HARD restriction for that snapshot; effective restriction = pinned ∩
    // current (either may be absent = unconstrained for that snapshot).
    const hardExecSet = (p: AgentContractPolicy): string[] | null =>
      !p.executor_fallback_allowed && p.preferred_executor_ids.length ? p.preferred_executor_ids : null;
    const restrictedExecs = mergeAllow(hardExecSet(pinned), hardExecSet(current));

    const effectiveExecAllow = (id: string): boolean =>
      (allowedExecs === null || allowedExecs.has(id)) &&
      (restrictedExecs === null || restrictedExecs.has(id)) &&
      !deniedExecs.has(id);
    const preferredExecs = current.preferred_executor_ids.filter((id) => effectiveExecAllow(id));

    // R1 §3: route_fallback_allowed=false likewise makes preferred routes a
    // hard restriction per snapshot — intersect pinned ∩ current, then
    // subtract the union of denied routes.
    const hardRouteSet = (p: AgentContractPolicy): string[] | null =>
      !p.route_fallback_allowed && p.preferred_route_ids.length ? p.preferred_route_ids : null;
    const deniedRoutes = union(pinned.denied_route_ids, current.denied_route_ids);
    const restrictedRoutes = mergeAllow(hardRouteSet(pinned), hardRouteSet(current));
    if (restrictedRoutes) for (const r of deniedRoutes) restrictedRoutes.delete(r);
    const preferredRoutes = current.preferred_route_ids.filter((r) => !deniedRoutes.has(r));

    return {
      org_agent_id: agentId,
      contract_id: String(contract.contract_id),
      contract_version: Number(contract.contract_version),
      pinned_version: Number(pin.contract_version),
      contract_digest: String(contract.contract_digest),
      allowed_capabilities: allowedCaps,
      denied_capabilities: deniedCaps,
      allowed_executor_ids: allowedExecs,
      denied_executor_ids: deniedExecs,
      preferred_executor_ids: preferredExecs,
      executor_fallback_allowed: pinned.executor_fallback_allowed && current.executor_fallback_allowed,
      restricted_executor_ids: restrictedExecs,
      preferred_route_ids: preferredRoutes,
      denied_route_ids: deniedRoutes,
      route_fallback_allowed: pinned.route_fallback_allowed && current.route_fallback_allowed,
      restricted_route_ids: restrictedRoutes,
      allowed_project_ids: allowedProjects,
      allowed_context_scopes: ctxScopes,
    };
  }

  /**
   * Deterministic denial: audit event (no sensitive payloads) + typed
   * policy error. The code follows the repo's FAIL_CLOSED_* convention.
   */
  deny(
    code: string,
    detail: string,
    ctx: { missionId?: string; agentId?: string; taskId?: string; contractVersion?: number },
  ): never {
    this.auditDenial(code, detail, ctx);
    throw new PolicyError(code, detail);
  }

  /**
   * Audit-only denial record — used when the fail-closed error is raised
   * inside resolution (agent/contract status, business/digest/provenance)
   * rather than at an explicit deny() site, so every contract-caused
   * rejection is auditable.
   */
  auditDenial(
    code: string,
    detail: string,
    ctx: { missionId?: string; agentId?: string; taskId?: string; contractVersion?: number },
  ): void {
    this.store.event({
      entity_type: "org_agent",
      entity_id: String(ctx.agentId ?? ""),
      event_type: "AGENT_EXECUTION_DENIED",
      actor: "PAIR_AGENT_CONTRACT",
      metadata: {
        mission_id: ctx.missionId ?? null,
        task_id: ctx.taskId ?? null,
        contract_version: ctx.contractVersion ?? null,
        reason: code,
        detail: String(detail).slice(0, 200),
      },
    });
  }

  /** API/debug view: the raw resolved policy for an agent (no secrets). */
  inspect(agentId: string): Record<string, unknown> {
    const { agent, contract } = this.resolve(agentId, { materialize: false });
    return {
      org_agent_id: agentId,
      agent_status: agent.status,
      business_id: contract.business_id,
      contract_id: contract.contract_id,
      status: contract.status,
      contract_version: contract.contract_version,
      contract_digest: contract.contract_digest,
      policy: contract.policy,
      version: contract.version,
      updated_at: contract.updated_at,
    };
  }
}
