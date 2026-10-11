/**
 * workforce-allocation — P15.4 Workforce Allocation & Governed
 * Delegation.
 *
 * Answers WHICH canonical org_agent owns executable work for each
 * ready P15.2 workstream. It NEVER selects an executor — MissionRouter
 * + CapabilityRouter remain the only executor-selection authority. The
 * P15.2 workstream stays the canonical unassigned container; allocation
 * materializes ONLY through the existing P14 `delegateWorkItem` seam
 * (OPERATOR mode), producing an assigned delegated child. One
 * deterministic allocation slot per workstream — a different selected
 * agent can never mint a second child.
 *
 *   canonical observation (+digest)
 *     → hard eligibility (P12 contract, same business, capability)
 *     → deterministic rank (workload ASC, agent_id ASC)
 *     → ONE atomic txn: re-observe + stale gate + delegateWorkItem +
 *       strict child re-read + allocation receipt + immutable anchor
 *
 * Deterministic only — no LLM, no scheduler, no missions, no executor
 * rows, no Telegram.
 */

import { digest, utcnow } from "./canonical.js";
import {
  assertCanonicalAuthorityBinding,
  assertCanonicalDependencySet,
  assertCanonicalMembership,
  authorityBindingRowId,
  delegationRowId,
  dependencySetRowId,
  membershipRowId,
  type GraphAuthorityDeps,
} from "./graph-authority.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { BusinessLayer } from "./business.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "./business.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import { objectiveWorkstreamBindingDigest } from "./objective-workstream.js";
import type { PairEvidenceStore } from "./store.js";
import type { WorkforceService } from "./work-graph.js";

type Row = Record<string, unknown> & { version: number };

import {
  WORKFORCE_ALLOCATION_ENTITY,
  WORKFORCE_ALLOCATION_SCHEMA,
  WORKFORCE_ALLOCATION_COMMITTED_EVENT,
  ALLOCATION_SELECTION_POLICY,
  workforceAllocationId,
  allocationDelegationKey,
  workforceAllocationDigest,
  assertCanonicalWorkforceAllocationProvenance,
} from "./workforce-allocation-evidence.js";

export {
  WORKFORCE_ALLOCATION_ENTITY,
  WORKFORCE_ALLOCATION_SCHEMA,
  WORKFORCE_ALLOCATION_COMMITTED_EVENT,
  ALLOCATION_SELECTION_POLICY,
  workforceAllocationId,
  allocationDelegationKey,
  workforceAllocationDigest,
  assertCanonicalWorkforceAllocationProvenance,
} from "./workforce-allocation-evidence.js";

function allocFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORKFORCE_ALLOCATION", detail);
}

export interface WorkforceAllocationDeps {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  objectives: ObjectiveAuthorityService;
  workstreams: ObjectiveWorkstreamService;
}

interface Candidate {
  agent_id: string;
  contract_id: string;
  contract_version: number;
  contract_digest: string;
  /** Canonical active workload — non-terminal work items in the same
   *  business already assigned to this agent. */
  active_workload: number;
}

interface AllocationObservation {
  objective_id: string;
  business_id: string;
  binding_id: string;
  binding_digest: string;
  workstream_key: string;
  workstream_work_item_id: string;
  workstream_status: string;
  workstream_version: number;
  dependencies_proven: boolean;
  eligible: Candidate[];
  selection_policy_version: string;
  digest: string;
}

/** Hard eligibility — read-only inspection. `resolve(..., {materialize:
 *  false})` never mints a baseline contract as a side effect; missing /
 *  malformed / disabled contract, wrong business, disallowed project,
 *  non-ACTIVE agent, or capability mismatch all exclude the candidate. */
function probeEligibility(
  deps: WorkforceAllocationDeps,
  agentId: string,
  ctx: { businessId: string; projectId: string; reqCap: string | null; actor: string },
  workloadByAgent: Map<string, number>,
): Candidate | null {
  let resolved: { agent: Row; contract: Row };
  try {
    resolved = deps.business.agentContracts.resolve(agentId, {
      materialize: false, actor: ctx.actor });
  } catch (err) {
    // R2.D — only expected ABSENCE/no-authority means "ineligible".
    // Integrity/provenance corruption (malformed row, digest mismatch,
    // business mismatch, invalid schema/version) must propagate fail
    // closed — it can never silently demote a candidate.
    if (err instanceof NotFoundError ||
        (err as { code?: string }).code === "FAIL_CLOSED_AGENT_CONTRACT_MISSING") {
      return null;
    }
    throw err;
  }
  const { agent, contract } = resolved;
  if (String(agent.business_id) !== ctx.businessId) return null;
  if (String(agent.status) !== "ACTIVE") return null;
  if (String(contract.status) !== "ACTIVE") return null;
  const policy = contract.policy as {
    allowed_project_ids?: string[] | null;
    allowed_capabilities?: string[] | null;
    denied_capabilities?: string[];
  };
  const allowedProjects = policy.allowed_project_ids ?? null;
  if (allowedProjects !== null && !allowedProjects.includes(ctx.projectId)) return null;
  if (ctx.reqCap !== null) {
    const caps = (agent.capabilities as string[] | undefined) ?? [];
    if (!caps.includes(ctx.reqCap)) return null;
    if (policy.allowed_capabilities != null &&
        !policy.allowed_capabilities.includes(ctx.reqCap)) return null;
    if ((policy.denied_capabilities ?? []).includes(ctx.reqCap)) return null;
  }
  return {
    agent_id: String(agent.agent_id),
    contract_id: String(contract.contract_id),
    contract_version: Number(contract.contract_version),
    contract_digest: String(contract.contract_digest),
    active_workload: workloadByAgent.get(String(agent.agent_id)) ?? 0,
  };
}

/** Canonical per-workstream observation — the deterministic digest
 *  pinned into the receipt and re-proved inside the commit txn. Every
 *  field is authority: binding identity, workstream identity/state,
 *  dependency proof, the full eligible-candidate set (identity +
 *  contract revision + workload input), and the policy version. */
function buildAllocationObservation(
  deps: WorkforceAllocationDeps,
  objectiveId: string,
  workstreamKey: string,
  actor: string,
): AllocationObservation {
  const obj = deps.objectives.get(objectiveId); // strict canonical read
  if (String(obj.status) !== "ACTIVE") {
    throw new IntegrityError(
      "FAIL_CLOSED_P15_4_OBJECTIVE_NOT_ACTIVE",
      `objective ${objectiveId} status ${String(obj.status)}`,
    );
  }
  const binding = deps.workstreams.getBinding(objectiveId); // full chain validator
  if (!binding) {
    throw new IntegrityError(
      "FAIL_CLOSED_WORKFORCE_ALLOCATION",
      `objective ${objectiveId} has no canonical workstream binding`,
    );
  }
  const businessId = String(obj.business_id);
  const ws = (binding.workstreams as Array<Record<string, unknown>>).find(
    (w) => String(w.workstream_key) === workstreamKey);
  if (!ws) {
    throw new IntegrityError(
      "FAIL_CLOSED_WORKFORCE_ALLOCATION",
      `workstream ${workstreamKey} is not a member of binding ${String(binding.binding_id)}`,
    );
  }
  const wi = deps.store.get("work_item", String(ws.work_item_id)) as Row;
  if (String(wi.business_id) !== businessId ||
      String(wi.objective_id ?? "") !== objectiveId ||
      String(wi.parent_work_item_id ?? "") !== String(binding.root_work_item_id)) {
    allocFail(`workstream ${workstreamKey} graph identity mismatch`);
  }
  if (TERMINAL_WORK_ITEM_STATUSES.has(String(wi.status))) {
    allocFail(`workstream ${workstreamKey} is terminal (${String(wi.status)})`);
  }
  // B — dependency authority: canonical P14 proof only. Status text,
  //  mirrors, CEO priority, or a merely-existing upstream mission never
  //  unlock allocation.
  const depsProven = deps.workforce.dependenciesProven(wi) === true;
  const projectId = String(deps.business.getBusiness(businessId).project_id);
  // R2.C — canonical workload authority: every counted row must pass
  // the existing P14 graph-authority proof (membership ↔ WDEL/WDEC ↔
  // WDS re-validation). A forged/malformed work_item QUARANTINES and
  // fails the whole allocation closed — it can never silently move the
  // ranking against a clean candidate.
  const workloadByAgent = new Map<string, number>();
  for (const w of deps.business.listWorkItems(businessId)) {
    const assignee = String(w.assignee_agent_id ?? "");
    if (!assignee) continue;
    if (TERMINAL_WORK_ITEM_STATUSES.has(String(w.status))) continue;
    deps.business.assertGraphAuthority(w);
    workloadByAgent.set(assignee, (workloadByAgent.get(assignee) ?? 0) + 1);
  }
  const reqCap = wi.required_capability ? String(wi.required_capability) : null;
  const eligible: Candidate[] = [];
  for (const a of deps.store.list("org_agent") as Row[]) {
    if (String(a.business_id) !== businessId) continue;
    const c = probeEligibility(deps, String(a.agent_id), {
      businessId, projectId, reqCap, actor }, workloadByAgent);
    if (c) eligible.push(c);
  }
  eligible.sort((x, y) =>
    x.active_workload - y.active_workload ||
    x.agent_id.localeCompare(y.agent_id));
  const body = {
    objective_id: objectiveId,
    business_id: businessId,
    binding_id: String(binding.binding_id),
    binding_digest: objectiveWorkstreamBindingDigest(binding),
    workstream_key: workstreamKey,
    workstream_work_item_id: String(wi.work_item_id),
    workstream_status: String(wi.status),
    workstream_version: Number(wi.version),
    dependencies_proven: depsProven,
    eligible,
    selection_policy_version: ALLOCATION_SELECTION_POLICY,
  };
  return { ...body, digest: digest(body) };
}

/** Strict canonical validation of a committed `workforce_allocation`
 *  receipt — exact shape, self-digest, exactly-one immutable anchor
 *  (header + pins), and the full provenance chain re-proved live:
 *  allocation → P15.2 binding → exact workstream → P14 WDEL → exact
 *  delegated child → exact selected org_agent. */
export function assertCanonicalWorkforceAllocation(
  deps: WorkforceAllocationDeps,
  row: Row,
): void {
  // Dependency-free provenance: receipt shape, self-digest,
  // exactly-one immutable committed anchor (header + pins), policy.
  assertCanonicalWorkforceAllocationProvenance(deps.store, row);
  // Re-prove the full provenance chain — the receipt is NEVER a second
  // graph authority.
  const binding = deps.workstreams.getBinding(String(row.objective_id));
  if (!binding) allocFail("binding missing");
  if (String(row.objective_workstream_binding_id) !== String(binding.binding_id) ||
      String(row.objective_workstream_binding_digest) !==
        objectiveWorkstreamBindingDigest(binding)) {
    allocFail("binding identity/digest mismatch");
  }
  if (String(binding.business_id) !== String(row.business_id)) {
    allocFail("binding business mismatch");
  }
  const wsEntry = (binding.workstreams as Array<Record<string, unknown>>).find(
    (w) => String(w.workstream_key) === String(row.workstream_key));
  if (!wsEntry || String(wsEntry.work_item_id) !== String(row.workstream_work_item_id)) {
    allocFail("workstream not bound");
  }
  const parent = deps.store.tryGet(
    "work_item", String(row.workstream_work_item_id)) as Row | null;
  if (!parent || String(parent.business_id) !== String(row.business_id)) {
    allocFail("workstream work item business mismatch");
  }
  // Canonical WDEL — state COMMITTED, OPERATOR mode, and the operator
  // provenance must equal the receipt's creator.
  const wdel = deps.store.tryGet("work_delegation", String(row.delegation_id)) as Row | null;
  if (!wdel) allocFail("delegation missing");
  if (String(row.delegation_id) !== delegationRowId(String(row.delegated_child_work_item_id)) ||
      String(wdel.delegated_to_agent_id ?? "") !== String(row.selected_agent_id) ||
      String(wdel.child_work_item_id ?? "") !== String(row.delegated_child_work_item_id) ||
      String(wdel.parent_work_item_id ?? "") !== String(row.workstream_work_item_id) ||
      String(wdel.delegation_key ?? "") !==
        allocationDelegationKey(String(row.objective_id), String(row.workstream_work_item_id)) ||
      String(wdel.state ?? "") !== "COMMITTED" ||
      String(wdel.delegation_mode ?? "") !== "OPERATOR" ||
      String(wdel.delegated_by_operator ?? "") !== String(row.created_by) ||
      String(wdel.created_by ?? "") !== String(row.created_by) ||
      String(wdel.business_id ?? "") !== String(row.business_id)) {
    allocFail("delegation provenance mismatch");
  }
  const child = deps.store.tryGet(
    "work_item", String(row.delegated_child_work_item_id)) as Row | null;
  if (!child) allocFail("delegated child missing");
  if (String(child.assignee_agent_id ?? "") !== String(row.selected_agent_id) ||
      String(child.parent_work_item_id ?? "") !== String(row.workstream_work_item_id) ||
      String(child.delegation_key ?? "") !==
        allocationDelegationKey(String(row.objective_id), String(row.workstream_work_item_id)) ||
      String(child.business_id ?? "") !== String(row.business_id)) {
    allocFail("child provenance mismatch");
  }
  // R2.B — full P14 canonical re-proof of the delegated child through
  // the existing validators, never partial field compares.
  const gdeps: GraphAuthorityDeps = {
    store: deps.store,
    getBusiness: (b: string) => deps.business.getBusiness(b),
    agentContracts: deps.business.agentContracts,
  };
  const membership = deps.store.tryGet(
    "work_graph_membership", membershipRowId(String(child.work_item_id))) as Row | null;
  if (!membership) allocFail("delegated-child membership missing");
  try {
    assertCanonicalMembership(gdeps, membership);
  } catch (err) {
    allocFail(`membership invalid: ${(err as Error).message}`);
  }
  if (String(membership.membership_type) !== "DELEGATED_CHILD" ||
      String(membership.parent_work_item_id ?? "") !== String(row.workstream_work_item_id) ||
      String(membership.delegation_id ?? "") !== String(row.delegation_id)) {
    allocFail("membership provenance mismatch");
  }
  const wds = deps.store.tryGet(
    "work_dependency_set", dependencySetRowId(String(child.work_item_id))) as Row | null;
  if (!wds) allocFail("delegated-child dependency manifest missing");
  try {
    assertCanonicalDependencySet(gdeps, wds);
  } catch (err) {
    allocFail(`dependency manifest invalid: ${(err as Error).message}`);
  }
  // Authority binding is required only when a ceiling agent exists
  // (OPERATOR allocation on an unassigned container has none by design).
  const wab = deps.store.tryGet(
    "authority_binding", authorityBindingRowId(String(child.work_item_id))) as Row | null;
  if (wdel.authority_ceiling_agent != null) {
    if (!wab) allocFail("authority binding missing for ceiling-bearing delegation");
    try {
      assertCanonicalAuthorityBinding(gdeps, wab);
    } catch (err) {
      allocFail(`authority binding invalid: ${(err as Error).message}`);
    }
  }
  // The selected org_agent must still exist and be same-business.
  const agent = deps.store.get("org_agent", String(row.selected_agent_id));
  if (String(agent.business_id) !== String(row.business_id)) {
    allocFail("selected agent cross-business");
  }
}

export type AllocationStatus =
  | "allocated"
  | "replayed"
  | "dependency_blocked"
  | "no_eligible_agent";

export interface AllocationResult {
  status: AllocationStatus;
  allocation?: Row;
  workstream_key: string;
  delegated_child_work_item_id?: string;
  selected_agent_id?: string;
}

export class WorkforceAllocationService {
  constructor(private readonly deps: WorkforceAllocationDeps) {}

  private get store(): PairEvidenceStore { return this.deps.store; }

  /**
   * Allocate ONE canonical org_agent to one P15.2 workstream through
   * the P14 OPERATOR delegation seam. Idempotent on the committed slot.
   */
  allocateWorkstream(input: {
    objective_id: string;
    workstream_key: string;
    actor: string;
  }): AllocationResult {
    if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "workforce_allocation.allocate");
    }
    const actor = input.actor;
    const objectiveId = String(input.objective_id ?? "");
    const key = String(input.workstream_key ?? "");
    if (!objectiveId || !key) allocFail("objective_id/workstream_key malformed");
    // R2.E — slot resolution first: derive the deterministic WAL id
    // from the canonical binding alone (no admission checks). A
    // committed allocation is historical authority — replay survives
    // later Objective deadline/status/workload changes.
    const binding0 = this.deps.workstreams.getBinding(objectiveId);
    if (!binding0) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORKFORCE_ALLOCATION",
        `objective ${objectiveId} has no canonical workstream binding`,
      );
    }
    const ws0 = (binding0.workstreams as Array<Record<string, unknown>>).find(
      (w) => String(w.workstream_key) === key);
    if (!ws0) {
      allocFail(`workstream ${key} is not a member of binding ${String(binding0.binding_id)}`);
    }
    const workItemId = String(ws0.work_item_id);
    const allocationId = workforceAllocationId(objectiveId, workItemId);
    const prior = this.store.tryGet(WORKFORCE_ALLOCATION_ENTITY, allocationId) as Row | null;
    if (prior) {
      // Replay/adopt only after full provenance validation.
      assertCanonicalWorkforceAllocation(this.deps, prior);
      return {
        status: "replayed", allocation: prior, workstream_key: key,
        delegated_child_work_item_id: String(prior.delegated_child_work_item_id),
        selected_agent_id: String(prior.selected_agent_id),
      };
    }
    // P15.1 deadline semantics, consistent with P15.2/P15.3 admission —
    // new admission only, never blocks replay of the committed slot.
    this.deps.objectives.evaluateDeadline(objectiveId);

    const obs = buildAllocationObservation(this.deps, objectiveId, key, actor);
    if (!obs.dependencies_proven) {
      return { status: "dependency_blocked", workstream_key: key };
    }
    if (obs.eligible.length === 0) {
      return { status: "no_eligible_agent", workstream_key: key };
    }
    const selected = obs.eligible[0]!;

    return this.store.immediate(() => {
      // R2.E — a canonical WAL committed by a concurrent winner converges
      // this loser to replay BEFORE the fresh-observation stale gate.
      const cur = this.store.tryGet(WORKFORCE_ALLOCATION_ENTITY, allocationId) as Row | null;
      if (cur) {
        assertCanonicalWorkforceAllocation(this.deps, cur);
        return {
          status: "replayed" as const, allocation: cur, workstream_key: key,
          delegated_child_work_item_id: String(cur.delegated_child_work_item_id),
          selected_agent_id: String(cur.selected_agent_id),
        };
      }
      // J — re-observe under the commit transaction: binding, workstream
      // state, dependency proof, eligible set, workload inputs must all
      // be identical to the decision snapshot.
      const fresh = buildAllocationObservation(this.deps, objectiveId, key, actor);
      if (fresh.digest !== obs.digest) {
        throw new IntegrityError(
          "FAIL_CLOSED_P15_4_STALE_ALLOCATION",
          `observation drifted for ${key}`,
        );
      }
      // The EXISTING P14 delegation seam — OPERATOR mode (no forged
      // delegated_by_agent_id). The deterministic slot key makes a
      // conflicting same-slot child fail closed inside P14.
      const child = this.deps.workforce.delegateWorkItem(
        {
          work_item_id: obs.workstream_work_item_id,
          delegated_to_agent_id: selected.agent_id,
          delegation_key: allocationDelegationKey(objectiveId, obs.workstream_work_item_id),
          reason: `p15.4:${key}`,
        },
        actor,
      );
      // Strict re-read — the delegated child must carry the exact
      // provenance the receipt is about to pin.
      const childRow = this.store.get("work_item", String(child.work_item_id)) as Row;
      if (String(childRow.assignee_agent_id ?? "") !== selected.agent_id ||
          String(childRow.parent_work_item_id ?? "") !== obs.workstream_work_item_id ||
          String(childRow.delegation_key ?? "") !==
            allocationDelegationKey(objectiveId, obs.workstream_work_item_id)) {
        allocFail("delegated child provenance mismatch");
      }
      const delegation = this.store.tryGet(
        "work_delegation", delegationRowId(String(child.work_item_id))) as Row | null;
      if (!delegation) allocFail("WDEL missing after delegate");
      const body: Record<string, unknown> = {
        schema_version: WORKFORCE_ALLOCATION_SCHEMA,
        allocation_id: allocationId,
        objective_id: objectiveId,
        business_id: obs.business_id,
        objective_workstream_binding_id: obs.binding_id,
        objective_workstream_binding_digest: obs.binding_digest,
        workstream_key: key,
        workstream_work_item_id: obs.workstream_work_item_id,
        selected_agent_id: selected.agent_id,
        delegated_child_work_item_id: String(child.work_item_id),
        delegation_id: String(delegation.delegation_id),
        allocation_observation_digest: obs.digest,
        selection_policy_version: ALLOCATION_SELECTION_POLICY,
        created_by: actor,
        created_at: utcnow(),
        state: "COMMITTED",
        entity_type: WORKFORCE_ALLOCATION_ENTITY,
        entity_id: allocationId,
        version: 0,
      };
      body.allocation_digest = workforceAllocationDigest(body);
      const saved = this.store.put(WORKFORCE_ALLOCATION_ENTITY, allocationId, body as Row, 0);
      this.store.event({
        entity_type: WORKFORCE_ALLOCATION_ENTITY,
        entity_id: allocationId,
        event_type: WORKFORCE_ALLOCATION_COMMITTED_EVENT,
        old_state: null,
        new_state: "COMMITTED",
        actor: `operator:${actor}`,
        metadata: {
          allocation_id: allocationId,
          objective_id: objectiveId,
          objective_workstream_binding_id: obs.binding_id,
          objective_workstream_binding_digest: obs.binding_digest,
          workstream_work_item_id: obs.workstream_work_item_id,
          selected_agent_id: selected.agent_id,
          delegated_child_work_item_id: String(child.work_item_id),
          delegation_id: String(body.delegation_id),
          delegation_mode: "OPERATOR",
          delegated_by_operator: actor,
          allocation_observation_digest: obs.digest,
          allocation_digest: String(body.allocation_digest),
        },
      });
      return {
        status: "allocated" as const,
        allocation: saved,
        workstream_key: key,
        delegated_child_work_item_id: String(child.work_item_id),
        selected_agent_id: selected.agent_id,
      };
    });
  }

  /** Allocate every ready (dependencies-proven, unallocated) workstream
   *  of the objective — deterministic binding order, one canonical
   *  transaction per workstream (never one giant txn across the
   *  objective). Per-workstream results are explicit, never hidden. */
  allocateReadyWorkstreams(input: {
    objective_id: string;
    actor: string;
  }): AllocationResult[] {
    if (typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "workforce_allocation.allocateReady");
    }
    const objectiveId = String(input.objective_id ?? "");
    this.deps.objectives.evaluateDeadline(objectiveId);
    const binding = this.deps.workstreams.getBinding(objectiveId);
    if (!binding) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORKFORCE_ALLOCATION",
        `objective ${objectiveId} has no canonical workstream binding`,
      );
    }
    const results: AllocationResult[] = [];
    for (const w of binding.workstreams as Array<Record<string, unknown>>) {
      results.push(this.allocateWorkstream({
        objective_id: objectiveId,
        workstream_key: String(w.workstream_key),
        actor: input.actor,
      }));
    }
    return results;
  }
}

// Late-bind the full canonical proof into the artifact resolver's
// lineage gate. A static import of this module from artifact-handoff.ts
// would pull business.ts into service.ts's import phase — the existing
// work-completion module-level MISSION_STATUS_TRANSITIONS read crashes
// under that order. The binding carries the SAME function object; the
// resolver fails closed if it is ever absent.
import { bindWorkforceAllocationProver } from "./artifact-handoff.js";
bindWorkforceAllocationProver(assertCanonicalWorkforceAllocation);
