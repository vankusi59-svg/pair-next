/**
 * P14 WORKFORCE V2 PHASE 1 — governed work graph + delegation core.
 *
 * Architecture rule (mandatory): this service COORDINATES work — it never
 * executes it. There is no second router, dispatcher, runtime, planner
 * authority, recovery engine, or permission system here. Every child a
 * graph mutation materializes still travels the single canonical chain:
 *
 *   work_item → BusinessLayer.openWorkItem → work_open_binding
 *   → bound mission → Planner → MissionRouter → GovernedTaskGate
 *   → executors → MissionRuntime
 *
 * Authority model (mirrors Foundation V2): caller metadata can never
 * create graph authority. Graph membership is proven only by canonical
 * durable rows written inside one immediate() transaction:
 *
 *   - `work_graph_edge`   (WGE_<digest>)  dependency: dependent → dep
 *   - `work_delegation`   (WDEL_<child>)  delegation provenance row
 *   - `work_decomposition`(WDEC_<parent>) committed child set
 *
 * Fields mirrored onto work_item rows (parent_work_item_id, delegated_*,
 * delegation_key, decomposition_id) are observability — a row asserting
 * graph membership without the matching canonical row is forged and is
 * quarantined by BusinessLayer.assertGraphAuthority.
 */
import { IntegrityError, PolicyError } from "./errors.js";
import { utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_CORRUPT_CODE,
  type BusinessLayer,
} from "./business.js";
import {
  assertAuthoritySubset,
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  assertCanonicalDependencySet,
  assertCanonicalEdge,
  authorityCeilingDigest,
  authorityCeilingSnapshot,
  childNodeId,
  decompositionProposal,
  decompositionProposalDigest,
  decompositionRowId,
  delegationRowId,
  dependencySetDigest,
  dependencySetRowId,
  edgeId,
  effectiveAuthority,
  type GraphAuthorityDeps,
  type ResolvedChildSpec,
} from "./graph-authority.js";
import {
  WORK_CLAIM_LEASE_TABLE,
  WORKFORCE_MESSAGE_TABLE,
  WORKFORCE_RECEIPT_TABLE,
  assertCanonicalClaimLease,
  assertCanonicalCollaborationBundle,
  assertCanonicalReceipt,
  assertCanonicalWorkforceMessage,
  claimLeaseDigest,
  claimLeaseRowId,
  leaseLiveExpired,
} from "./work-coordination.js";

// R1+R2: deterministic helpers + canonical validators live in
// graph-authority.ts (imported by business.ts too) — re-exported here so
// `index.ts`'s `export * from "./work-graph.js"` keeps them public.
export {
  childNodeId,
  decompositionRowId,
  delegationRowId,
  dependencySetRowId,
  dependencySetDigest,
  edgeId,
  decompositionProposal,
  decompositionProposalDigest,
  authorityCeilingSnapshot,
  authorityCeilingDigest,
  effectiveAuthority,
  assertAuthoritySubset,
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  assertCanonicalDependencySet,
  assertCanonicalEdge,
};

type Row = Record<string, unknown> & { version: number };

/** Work-graph bounds: delegation depth, nodes per business, children per
 *  decomposition — fail closed when exceeded. */
export const WORK_DELEGATION_DEPTH_CAP = Number(process.env.PAIR_WORK_DELEGATION_DEPTH_CAP ?? 8);
export const WORK_GRAPH_NODE_CAP = Number(process.env.PAIR_WORK_GRAPH_NODE_CAP ?? 256);
export const WORK_DECOMPOSE_CHILD_CAP = Number(process.env.PAIR_WORK_DECOMPOSE_CHILD_CAP ?? 16);

export interface WorkforceDeps {
  store: PairEvidenceStore;
  business: BusinessLayer;
}

export class WorkforceService {
  constructor(private readonly deps: WorkforceDeps) {}

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }
  private get business(): BusinessLayer {
    return this.deps.business;
  }
  private get graphDeps(): GraphAuthorityDeps {
    return {
      store: this.store,
      getBusiness: (id) => this.business.getBusiness(id),
      agentContracts: this.business.agentContracts,
    };
  }

  private node(id: string): Row {
    const r = this.store.tryGet("work_item", id) as Row | null;
    if (!r) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_NODE", `unknown work item ${id}`);
    }
    return r;
  }
  private agent(id: string): Row {
    const r = this.store.tryGet("org_agent", id) as Row | null;
    if (!r) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_NODE", `unknown org agent ${id}`);
    }
    return r;
  }

  childrenOf(workItemId: string): Row[] {
    return this.store
      .list("work_item")
      .filter((w) => String(w.parent_work_item_id ?? "") === String(workItemId))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  /** ACTIVE dependency edges where `workItemId` is the dependent. */
  dependenciesOf(workItemId: string): Row[] {
    return this.business.dependencyEdgesOf(workItemId);
  }
  /** ACTIVE dependency edges where `workItemId` is the prerequisite. */
  dependentsOf(workItemId: string): Row[] {
    return this.store.list("work_graph_edge").filter((e) =>
      String(e.dependency_work_item_id) === String(workItemId) &&
      String(e.state) === "ACTIVE");
  }

  /** Read-only graph projection for a business — nodes + canonical edges.
   *  Seeing work grants no authority; every gate still applies at open. */
  workGraph(businessId: string): {
    nodes: Row[];
    edges: Row[];
    delegations: Row[];
    decompositions: Row[];
    dependency_sets: Row[];
  } {
    const nodes = this.business.listWorkItems(businessId);
    const ids = new Set(nodes.map((n) => String(n.work_item_id)));
    const edges = this.store.list("work_graph_edge").filter((e) =>
      ids.has(String(e.dependent_work_item_id)));
    const delegations = this.store.list("work_delegation").filter((d) =>
      String(d.business_id) === businessId);
    const decompositions = this.store.list("work_decomposition").filter((d) =>
      String(d.business_id) === businessId);
    const dependencySets = this.store.list("work_dependency_set").filter((d) =>
      String(d.business_id) === businessId);
    const projected = nodes.map((n) => ({
      ...n,
      dependencies_satisfied: this.dependenciesProven(n),
    }));
    return { nodes: projected, edges, delegations, decompositions, dependency_sets: dependencySets };
  }

  /** Read-model projection of the dep gate — the canonical manifest
   *  decides the set (R2 §2); a governed node whose manifest is missing
   *  while edges claim it is unproven, never "vacuously satisfied". */
  dependenciesProven(node: Row): boolean {
    const id = String(node.work_item_id);
    const wds = this.store.tryGet("work_dependency_set", dependencySetRowId(id)) as Row | null;
    let depIds: string[];
    if (wds) {
      depIds = (wds.dependency_work_item_ids as string[] | undefined) ?? [];
    } else {
      const hasEdges = this.store.list("work_graph_edge")
        .some((e) => String(e.dependent_work_item_id) === id);
      if (hasEdges) return false;
      depIds = [];
    }
    for (const depId of depIds) {
      const dep = this.store.tryGet("work_item", String(depId));
      if (!dep || !this.business.proveWorkItemDone(dep)) return false;
    }
    return true;
  }

  /**
   * The delegatee must satisfy the parent's required capability —
   * delegation narrows, never expands. The capability must be declared
   * on the agent AND permitted by the agent's execution contract
   * (allowed ∩ ¬denied).
   */
  private assertCapability(agent: Row, reqCap: string | null): void {
    if (!reqCap) return;
    const caps = (agent.capabilities as string[] | undefined) ?? [];
    if (!caps.includes(reqCap)) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_CAPABILITY",
        `agent ${String(agent.agent_id)} lacks required capability ${reqCap}`,
      );
    }
    const contract = this.business.agentContracts.get(String(agent.agent_id));
    const pol = (contract?.policy ?? {}) as {
      allowed_capabilities?: string[] | null;
      denied_capabilities?: string[];
    };
    if (pol.allowed_capabilities != null && !pol.allowed_capabilities.includes(reqCap)) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_CAPABILITY",
        `contract denies capability ${reqCap} for ${String(agent.agent_id)}`,
      );
    }
    if ((pol.denied_capabilities ?? []).includes(reqCap)) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_CAPABILITY",
        `contract denies capability ${reqCap} for ${String(agent.agent_id)}`,
      );
    }
  }

  /** Write/refresh the canonical dependency-set manifest for a node —
   *  inside the caller's immediate() txn. The manifest is the omission-
   *  safe authority over the node's dependency edges (R2 §1): an empty
   *  dependency set is still a canonical row, never inferred absence. */
  private writeDependencySet(node: Row, actor: string): Row {
    const workItemId = String(node.work_item_id);
    const edges = this.store.list("work_graph_edge")
      .filter((e) => String(e.dependent_work_item_id) === workItemId &&
        String(e.state) === "ACTIVE");
    const edgeIds = edges.map((e) => String(e.edge_id)).sort();
    const deps = edges.map((e) => String(e.dependency_work_item_id)).sort();
    const prior = this.store.tryGet("work_dependency_set", dependencySetRowId(workItemId)) as Row | null;
    const revision = prior ? Number(prior.revision) + 1 : 1;
    const body = {
      dependency_set_id: dependencySetRowId(workItemId),
      work_item_id: workItemId,
      business_id: String(node.business_id),
      project_id: String(this.business.getBusiness(String(node.business_id)).project_id),
      active_edge_ids: edgeIds,
      dependency_work_item_ids: deps,
      dependency_set_digest: dependencySetDigest(workItemId, edgeIds, deps),
      revision,
      state: "COMMITTED",
      created_by: prior ? String(prior.created_by) : actor,
      created_at: prior ? String(prior.created_at) : utcnow(),
      updated_at: utcnow(),
      version: prior ? Number(prior.version) : 0,
    };
    const saved = this.store.put(
      "work_dependency_set", dependencySetRowId(workItemId), body as Row,
      prior ? Number(prior.version) : 0,
    );
    assertCanonicalDependencySet(this.graphDeps, saved);
    return saved;
  }

  /**
   * Add edge child→dep inside the caller's transaction: fails on
   * missing node, cross-business, cross-project, self-edge; duplicate
   * edges dedupe deterministically (same canonical id). Does NOT check
   * cycles — call assertNoCycle once per mutation.
   */
  private writeEdge(child: Row, depId: string, actor: string): void {
    const dep = this.node(depId); // throws when missing
    if (String(dep.work_item_id) === String(child.work_item_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_CYCLE", "self dependency");
    }
    if (String(dep.business_id) !== String(child.business_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_GRAPH_SCOPE",
        `dependency ${depId} outside business ${String(child.business_id)}`,
      );
    }
    const depBusiness = this.business.getBusiness(String(dep.business_id));
    const childBusiness = this.business.getBusiness(String(child.business_id));
    if (String(depBusiness.project_id) !== String(childBusiness.project_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_GRAPH_SCOPE",
        `dependency ${depId} in project ${String(depBusiness.project_id)}`,
      );
    }
    const id = edgeId(String(child.work_item_id), depId);
    const prior = this.store.tryGet("work_graph_edge", id) as Row | null;
    if (prior) {
      // R1 §3: a deterministic key can never silently carry a different
      // payload — the existing row must pass the FULL canonical validator
      // (endpoints, scope, lifecycle) before it may be reused/revived.
      try {
        assertCanonicalEdge(this.graphDeps, prior);
      } catch (err) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_GRAPH_ROW",
          `existing edge ${id} is malformed: ${(err as Error).message}`,
        );
      }
      if (String(prior.state) === "REVOKED") {
        this.store.put("work_graph_edge", id,
          { ...prior, state: "ACTIVE", updated_at: utcnow() }, Number(prior.version));
      }
      return;
    }
    this.store.put("work_graph_edge", id, {
      edge_id: id,
      dependent_work_item_id: String(child.work_item_id),
      dependency_work_item_id: depId,
      business_id: String(child.business_id),
      project_id: String(childBusiness.project_id),
      state: "ACTIVE",
      created_by: actor,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    } as Row, 0);
  }

  /** Entities are append-only — an edge is REVOKED in place, never
   *  deleted, so the audit trail survives. */
  private revokeEdgesFor(workItemId: string): void {
    for (const e of this.dependenciesOf(workItemId)) {
      this.store.put("work_graph_edge", String(e.edge_id),
        { ...e, state: "REVOKED", updated_at: utcnow() }, Number(e.version));
    }
  }

  /**
   * Cycle check: adding `child → dep` must never let dep transitively
   * depend back on child. Walks the dependency closure of each new dep.
   */
  private assertNoCycle(childId: string, depIds: string[], pendingEdges: Map<string, string[]>): void {
    const adjacency = new Map<string, string[]>();
    for (const e of this.store.list("work_graph_edge")) {
      if (String(e.state) !== "ACTIVE") continue;
      const k = String(e.dependent_work_item_id);
      const arr = adjacency.get(k) ?? [];
      arr.push(String(e.dependency_work_item_id));
      adjacency.set(k, arr);
    }
    for (const [k, v] of pendingEdges) adjacency.set(k, v);
    for (const depId of depIds) {
      const stack = [depId];
      const seen = new Set<string>();
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === childId) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_GRAPH_CYCLE",
            `dependency ${depId} reaches back to ${childId}`,
          );
        }
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const nx of adjacency.get(cur) ?? []) stack.push(nx);
      }
    }
  }

  /**
   * Canonical dependency mutation: the only path that writes
   * `work_graph_edge` rows. Replaces the dependent's edge set inside one
   * immediate() transaction under the row's expected_version CAS — a
   * versionless or stale caller fails closed.
   */
  setWorkItemDependencies(
    workItemId: string,
    depIds: string[],
    expectedVersion: number,
    actor: string,
  ): Row {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_graph.setDeps");
    return this.store.immediate(() => {
      const node = this.node(workItemId);
      this.business.assertWorkItemNotQuarantined(node);
      this.business.assertGraphAuthority(node);
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(node.status))) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_ITEM_STATE",
          `${String(node.status)} cannot change dependencies`,
        );
      }
      // R2 §6 — a WDEC-governed decomposition child's dependency topology
      // is bound by the committed proposal (its digest + the child's
      // dependency-set manifest prove it). A canonical mutation path must
      // never produce provenance-corrupt state, so topology mutation is
      // rejected outright — before any write, with no quarantine.
      if (node.decomposition_id) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_DECOMPOSITION_TOPOLOGY_IMMUTABLE",
          `${workItemId} is a canonical decomposition child — its topology is fixed by the proposal`,
        );
      }
      if (typeof expectedVersion !== "number" || expectedVersion !== Number(node.version)) {
        throw new IntegrityError(
          "FAIL_CLOSED_VERSION_CONFLICT",
          `work_item ${workItemId} expected_version ${expectedVersion} ≠ ${Number(node.version)}`,
        );
      }
      const deduped = [...new Set(depIds.map(String))];
      for (const depId of deduped) this.node(depId); // missing-node edge fails closed
      this.assertNoCycle(workItemId, deduped, new Map());
      this.revokeEdgesFor(workItemId);
      for (const depId of deduped) this.writeEdge(node, depId, actor);
      // R2 §1 — rewrite the canonical dependency-set manifest in the same
      // txn: the manifest is the omission-safe authority; edge rows alone
      // never prove a set (a moved/missing edge must still fail closed).
      this.writeDependencySet(node, actor);
      const cur = { ...node, updated_at: utcnow() };
      const saved = this.store.put("work_item", workItemId, cur, Number(node.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId,
        event_type: "WORK_DEPENDENCIES_SET", actor: `operator:${actor}`,
        metadata: { depends_on: deduped },
      });
      return saved;
    });
  }

  /**
   * Governed delegation (WFV2 §5): parent delegates a child work item to
   * org_agent `to`. The whole mutation — deterministic child, WDEL
   * provenance row, WORK_DELEGATED audit — commits inside ONE immediate()
   * transaction: a fault anywhere leaves nothing.
   *
   * Deterministic child id derived from (parent, delegation_key) makes
   * the same delegation replay idempotently and concurrent duplicates
   * lose the v0-CAS; an existing child must match FULL provenance, never
   * just the id.
   */
  delegateWorkItem(
    input: {
      work_item_id: string;
      /** AGENT mode: the delegator — MUST equal the parent's canonical
       *  assignee_agent_id (R1 §5); a caller cannot name an arbitrary
       *  ACTIVE agent as the delegator of another agent's work.
       *  Omit for OPERATOR mode: operator-directed delegation recorded
       *  with operator provenance (`delegated_by_operator`), no agent
       *  identity is claimed. */
      delegated_by_agent_id?: string;
      delegated_to_agent_id: string;
      reason?: string;
      delegation_key?: string;
    },
    actor: string,
  ): Row {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_graph.delegate");
    return this.store.immediate(() => {
      const parent = this.node(input.work_item_id);
      this.business.assertWorkItemNotQuarantined(parent);
      this.business.assertGraphAuthority(parent);
      const businessId = String(parent.business_id);
      const ceilingAgentId = parent.assignee_agent_id
        ? String(parent.assignee_agent_id) : null;
      const mode: "AGENT" | "OPERATOR" = input.delegated_by_agent_id ? "AGENT" : "OPERATOR";
      let by: Row | null = null;
      if (mode === "AGENT") {
        by = this.agent(input.delegated_by_agent_id!);
        if (String(by.business_id) !== businessId) {
          throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SCOPE", "delegator outside business");
        }
        // Canonical delegator identity (R1 §5): agent-to-agent delegation
        // is valid only FROM the agent canonically assigned the parent —
        // a caller can never label an arbitrary same-business ACTIVE
        // agent as the delegator.
        if (ceilingAgentId === null || input.delegated_by_agent_id !== ceilingAgentId) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_DELEGATE_AUTHORITY",
            "delegated_by must equal the parent's canonical assignee",
          );
        }
        if (String(by.status) !== "ACTIVE") {
          throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", "delegator not ACTIVE");
        }
      }
      const to = this.agent(input.delegated_to_agent_id);
      if (String(to.business_id) !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SCOPE", "target outside business");
      }
      // ADMISSION semantics: new delegation requires the target ACTIVE
      // right now — later PAUSE/TERMINATE cannot retro-forge this proof.
      if (String(to.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", "target not ACTIVE");
      }
      const bizProjectId = String(this.business.getBusiness(businessId).project_id);
      // R2 §5 — a DISABLED P12 contract is never usable authority: new
      // admission resolves CURRENT executability (agent ACTIVE, contract
      // ACTIVE + integrity, business/project scope).
      this.business.agentContracts.assertExecutable(input.delegated_to_agent_id, {
        businessId,
        projectId: bizProjectId,
        actor: `operator:${actor}`,
      });
      // R3 §2 — an agent that cannot itself execute cannot supply an
      // authority ceiling: when the parent's assignee is the ceiling
      // source (AGENT or OPERATOR mode), it must pass current P12
      // admission too — a PAUSED/TERMINATED parent assignee fails closed.
      if (ceilingAgentId !== null) {
        this.business.agentContracts.assertExecutable(ceilingAgentId, {
          businessId,
          projectId: bizProjectId,
          actor: `operator:${actor}`,
        });
      }
      if (by && input.delegated_to_agent_id === String(by.agent_id)) {
        throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SELF", "cannot delegate to self");
      }
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(parent.status))) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_ITEM_STATE",
          `${String(parent.status)} cannot delegate`,
        );
      }
      const depth = Number(parent.delegation_depth ?? 0) + 1;
      if (depth > WORK_DELEGATION_DEPTH_CAP) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_DELEGATION_BOUND",
          `depth ${depth} exceeds cap ${WORK_DELEGATION_DEPTH_CAP}`,
        );
      }
      if (this.business.listWorkItems(businessId).length + 1 > WORK_GRAPH_NODE_CAP) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_GRAPH_BOUND",
          `business graph exceeds ${WORK_GRAPH_NODE_CAP} nodes`,
        );
      }
      const reqCap = parent.required_capability ? String(parent.required_capability) : null;
      this.assertCapability(to, reqCap);
      // R1 §6 — a child mission pins the DELEGATEE's contract, so the
      // delegatee's effective P12 authority must be a subset of the
      // parent assignee's (the authority ceiling). Unassigned parent: no
      // agent-derived authority exists — the operator-admission rule
      // (reqCap + ACTIVE + same business/project, enforced above) is the
      // defined ceiling; none is fabricated.
      if (ceilingAgentId !== null) {
        assertAuthoritySubset(
          effectiveAuthority(this.graphDeps, input.delegated_to_agent_id),
          effectiveAuthority(this.graphDeps, ceilingAgentId),
          `delegate ${input.delegated_to_agent_id}`,
        );
      }
      // R2 §3 — persist the authority ceiling proven at this mutation:
      // the normalized parent-ceiling snapshot + digest travel on the
      // WDEL row, so a later contract change can never retro-widen what
      // this delegation authorized. Null when the parent is unassigned.
      const ceilingSnapshot = ceilingAgentId === null
        ? null : authorityCeilingSnapshot(this.graphDeps, ceilingAgentId);
      const key =
        input.delegation_key ??
        `${input.work_item_id}:${input.delegated_to_agent_id}:${mode}:${String(input.reason ?? "")}`;
      const childId = childNodeId("DL", input.work_item_id, key);
      const prior = this.store.tryGet("work_item", childId);
      if (prior) {
        // Replay of THIS delegation adopts the canonical child only when
        // every provenance field matches; anything else is a forged
        // collision and fails closed.
        const matches =
          String(prior.business_id) === businessId &&
          String(prior.parent_work_item_id ?? "") === input.work_item_id &&
          String(prior.delegated_from_work_item_id ?? "") === input.work_item_id &&
          String(prior.delegated_by_agent_id ?? "") === String(by?.agent_id ?? "") &&
          String(prior.assignee_agent_id ?? "") === input.delegated_to_agent_id &&
          Number(prior.delegation_depth ?? 0) === depth &&
          String(prior.delegation_key ?? "") === key &&
          String(prior.required_capability ?? "") === String(reqCap ?? "");
        if (!matches) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_DELEGATE_CONFLICT",
            `deterministic child ${childId} has mismatched provenance`,
          );
        }
        this.writeDelegationRow(parent, childId, key, mode, by, input.delegated_to_agent_id, depth, actor, ceilingAgentId, ceilingSnapshot);
        // The adopted child must still carry its canonical dependency
        // manifest (empty for a fresh delegation child).
        const wds = this.store.tryGet("work_dependency_set", dependencySetRowId(childId)) as Row | null;
        if (!wds) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_DELEGATE_CONFLICT",
            `deterministic child ${childId} missing dependency manifest`,
          );
        }
        assertCanonicalDependencySet(this.graphDeps, wds);
        return prior;
      }
      const child = this.business.createWorkItem({
        business_id: businessId,
        title: `[delegated] ${String(parent.title)}`,
        goal: String(parent.goal),
        assignee_agent_id: input.delegated_to_agent_id,
        required_capability: reqCap ?? undefined,
        requires_review: parent.requires_review === true,
        reviewer_agent_id: parent.reviewer_agent_id ? String(parent.reviewer_agent_id) : undefined,
        parent_work_item_id: input.work_item_id,
        delegated_from_work_item_id: input.work_item_id,
        delegated_by_agent_id: by ? String(by.agent_id) : undefined,
        delegation_reason: String(input.reason ?? "").slice(0, 500) || undefined,
        delegation_depth: depth,
        delegation_key: key,
        source: "delegation",
        work_item_id: childId,
        operator_id: actor,
      });
      this.writeDelegationRow(parent, childId, key, mode, by, input.delegated_to_agent_id, depth, actor, ceilingAgentId, ceilingSnapshot);
      // R2 §1 — a delegated child starts with a canonical EMPTY
      // dependency set: absence is never inferred, it is proven.
      this.writeDependencySet(child, actor);
      this.store.event({
        entity_type: "work_item", entity_id: input.work_item_id,
        event_type: "WORK_DELEGATED", actor: `operator:${actor}`,
        metadata: {
          delegation_mode: mode,
          delegated_from: by ? String(by.agent_id) : null,
          delegated_by_operator: mode === "OPERATOR" ? actor : null,
          delegated_to: input.delegated_to_agent_id,
          child_work_item_id: childId,
          delegation_key: key,
        },
      });
      return child;
    });
  }

  /** The canonical delegation provenance row — idempotent: an existing
   *  row with identical provenance stands; a conflicting row is corrupt
   *  and fails closed. */
  private writeDelegationRow(
    parent: Row, childId: string, key: string,
    mode: "AGENT" | "OPERATOR",
    by: Row | null, toAgentId: string,
    depth: number, actor: string,
    ceilingAgentId: string | null,
    ceilingSnapshot: ReturnType<typeof authorityCeilingSnapshot> | null,
  ): void {
    const rowId = delegationRowId(childId);
    const body = {
      delegation_id: rowId,
      delegation_key: key,
      delegation_mode: mode,
      parent_work_item_id: String(parent.work_item_id),
      child_work_item_id: childId,
      delegated_from_agent_id: by ? String(by.agent_id) : null,
      delegated_by_operator: mode === "OPERATOR" ? actor : null,
      delegated_to_agent_id: toAgentId,
      depth,
      business_id: String(parent.business_id),
      project_id: String(this.business.getBusiness(String(parent.business_id)).project_id),
      authority_ceiling_agent: ceilingAgentId,
      authority_ceiling: ceilingSnapshot,
      authority_ceiling_digest: ceilingSnapshot === null
        ? null : authorityCeilingDigest(ceilingSnapshot),
      state: "COMMITTED",
      created_by: actor,
      created_at: utcnow(),
      version: 0,
    };
    const existing = this.store.tryGet("work_delegation", rowId) as Row | null;
    if (existing) {
      // R1 §3: the FULL payload must match — a deterministic key can
      // never silently carry different provenance.
      const same =
        String(existing.delegation_id) === rowId &&
        String(existing.child_work_item_id) === childId &&
        String(existing.delegation_key) === key &&
        String(existing.delegation_mode) === mode &&
        String(existing.parent_work_item_id) === body.parent_work_item_id &&
        String(existing.delegated_from_agent_id ?? "") === String(by?.agent_id ?? "") &&
        String(existing.delegated_by_operator ?? "") === String(body.delegated_by_operator ?? "") &&
        String(existing.delegated_to_agent_id) === body.delegated_to_agent_id &&
        Number(existing.depth) === depth &&
        String(existing.business_id) === body.business_id &&
        String(existing.project_id) === body.project_id &&
        String(existing.authority_ceiling_agent ?? "") === String(body.authority_ceiling_agent ?? "") &&
        String(existing.authority_ceiling_digest ?? "") === String(body.authority_ceiling_digest ?? "") &&
        String(existing.state) === "COMMITTED";
      if (!same) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_DELEGATE_CONFLICT",
          `work_delegation ${rowId} has mismatched provenance`,
        );
      }
      return;
    }
    this.store.put("work_delegation", rowId, body as Row, 0);
  }

  /**
   * Governed decomposition (WFV2 §4): materialize children C1..Cn plus a
   * committed `work_decomposition` row inside ONE immediate()
   * transaction — a restart can never observe a partially authoritative
   * graph (either the WDEC row+children+edges all exist, or none do).
   *
   * Children inherit the parent's canonical business context —
   * caller-supplied business/project identity is never consulted.
   * depends_on_indices point at EARLIER siblings only, so acyclicity is
   * guaranteed by construction (plus the standard edge validator).
   * Same decomposition_id replays idempotently; a different one on an
   * already-decomposed parent fails closed.
   */
  decomposeWorkItem(
    workItemId: string,
    input: {
      decomposition_id: string;
      children: Array<{
        title: string;
        goal: string;
        assignee_agent_id?: string;
        depends_on_indices?: number[];
        requires_review?: boolean;
      }>;
    },
    actor: string,
  ): { parent: Row; children: Row[] } {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_graph.decompose");
    const decompId = String(input.decomposition_id ?? "").trim();
    if (!decompId) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DECOMPOSE", "decomposition_id required");
    }
    if (!Array.isArray(input.children) || input.children.length === 0) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DECOMPOSE", "children required");
    }
    if (input.children.length > WORK_DECOMPOSE_CHILD_CAP) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_DECOMPOSE", `>${WORK_DECOMPOSE_CHILD_CAP} children`);
    }
    return this.store.immediate(() => {
      const parent = this.node(workItemId);
      this.business.assertWorkItemNotQuarantined(parent);
      this.business.assertGraphAuthority(parent);
      const businessId = String(parent.business_id);
      const reqCap = parent.required_capability ? String(parent.required_capability) : null;
      const ceilingAgentId = parent.assignee_agent_id
        ? String(parent.assignee_agent_id) : null;
      const childIds = input.children.map((_, i) =>
        childNodeId("DC", workItemId, `${decompId}|${i}`));
      // R1 §2 — canonical proposal identity: the resolved (id-materialized)
      // spec INCLUDING resulting dep topology is what replay compares.
      const resolvedChildren: ResolvedChildSpec[] = input.children.map((c, i) => ({
        work_item_id: childIds[i]!,
        title: String(c.title),
        goal: String(c.goal),
        assignee_agent_id: c.assignee_agent_id ? String(c.assignee_agent_id) : null,
        requires_review: c.requires_review === true,
        required_capability: reqCap,
        depends_on: (c.depends_on_indices ?? []).map((j) => childIds[j]!),
      }));
      // R2 §3 — the authority ceiling for directly-assigned children is
      // the parent assignee's normalized P12 snapshot, persisted on the
      // committed proposal (its digest covers it). Null for an unassigned
      // parent: no agent-derived ceiling is fabricated.
      const ceilingSnapshot = ceilingAgentId === null
        ? null : authorityCeilingSnapshot(this.graphDeps, ceilingAgentId);
      const proposal = decompositionProposal(
        workItemId, decompId, businessId, resolvedChildren,
        ceilingAgentId, ceilingSnapshot);
      const proposalDigest = decompositionProposalDigest(proposal);
      const rowId = decompositionRowId(workItemId);
      const existingDec = this.store.tryGet("work_decomposition", rowId) as Row | null;
      if (existingDec) {
        // Idempotent replay ONLY for the identical committed proposal —
        // same decomposition_id carrying a DIFFERENT payload conflicts
        // deterministically; a malformed canonical row never replays.
        if (String(existingDec.decomposition_id) === decompId &&
            String(existingDec.state) === "COMMITTED" &&
            String(existingDec.proposal_digest ?? "") === proposalDigest) {
          assertCanonicalDecomposition(this.graphDeps, existingDec);
          const ids = (existingDec.child_work_item_ids as string[]) ?? [];
          const children = ids.map((id) => this.node(String(id)));
          return { parent: this.node(workItemId), children };
        }
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT",
          `parent already decomposed as ${String(existingDec.decomposition_id)}`,
        );
      }
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(parent.status))) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_ITEM_STATE",
          `${String(parent.status)} cannot decompose`,
        );
      }
      // R3 §2 — an agent that cannot itself execute cannot supply an
      // authority ceiling: when the parent's assignee is the ceiling
      // source for directly-assigned children it must pass current P12
      // admission too — a PAUSED/TERMINATED parent assignee or a
      // DISABLED contract fails closed on new admission only (a matched
      // replay returned above is a re-read, not an admission).
      if (ceilingAgentId !== null) {
        this.business.agentContracts.assertExecutable(ceilingAgentId, {
          businessId,
          projectId: String(this.business.getBusiness(businessId).project_id),
          actor: `operator:${actor}`,
        });
      }
      if (this.business.listWorkItems(businessId).length + input.children.length > WORK_GRAPH_NODE_CAP) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_GRAPH_BOUND", `business graph exceeds ${WORK_GRAPH_NODE_CAP} nodes`);
      }
      // Validate the whole proposal BEFORE any write: sibling dep indices
      // in range and acyclic by construction (earlier siblings only),
      // assignees are ACTIVE same-business agents satisfying the
      // inherited capability — and (R1 §6) when the parent carries an
      // assignee/authority ceiling, each directly-assigned child's
      // effective authority must be a subset of it.
      const ceilingAuth = ceilingAgentId === null
        ? null : effectiveAuthority(this.graphDeps, ceilingAgentId);
      const bizProjectId = String(this.business.getBusiness(businessId).project_id);
      for (const [i, c] of input.children.entries()) {
        for (const depIdx of c.depends_on_indices ?? []) {
          if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= input.children.length) {
            throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_NODE", `child ${i} dep index ${depIdx}`);
          }
          if (depIdx >= i) {
            throw new IntegrityError(
              "FAIL_CLOSED_WORK_GRAPH_CYCLE", `child ${i} depends on later sibling ${depIdx}`);
          }
        }
        if (c.assignee_agent_id) {
          const ag = this.agent(c.assignee_agent_id);
          if (String(ag.business_id) !== businessId) {
            throw new IntegrityError(
              "FAIL_CLOSED_WORK_ITEM_SCOPE", `child ${i} assignee outside business`);
          }
          if (String(ag.status) !== "ACTIVE") {
            throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", c.assignee_agent_id);
          }
          // R2 §5 — a DISABLED P12 contract is never usable authority for
          // a new direct assignment: current executability is proven at
          // admission, not deferred to mission open.
          this.business.agentContracts.assertExecutable(c.assignee_agent_id, {
            businessId,
            projectId: bizProjectId,
            actor: `operator:${actor}`,
          });
          this.assertCapability(ag, reqCap);
          if (ceilingAuth) {
            assertAuthoritySubset(
              effectiveAuthority(this.graphDeps, c.assignee_agent_id),
              ceilingAuth,
              `decompose child ${i} → ${c.assignee_agent_id}`,
            );
          }
        }
      }
      const children: Row[] = [];
      for (const [i, c] of input.children.entries()) {
        const spec = resolvedChildren[i]!;
        const existing = this.store.tryGet("work_item", childIds[i]!) as Row | null;
        if (existing) {
          // R1 §1 — a deterministic-id collision is never authoritative by
          // the id alone: adopt the existing row ONLY when it is provably
          // this decomposition's own un-committed residue — exactly one
          // store write (version 1 = created, never mutated; store.put
          // stores payload.version+1), fresh status, zero missions/blocks,
          // full spec match, this decomposition's provenance, and no
          // delegation provenance. Anything else conflicts closed.
          const freshStatus = spec.assignee_agent_id ? "READY" : "BACKLOG";
          const adoptable =
            Number(existing.version) === 1 &&
            String(existing.business_id) === businessId &&
            String(existing.parent_work_item_id ?? "") === workItemId &&
            String(existing.decomposition_id ?? "") === decompId &&
            (existing.decomposed_as ?? null) === null &&
            (existing.delegated_from_work_item_id ?? null) === null &&
            (existing.delegated_by_agent_id ?? null) === null &&
            (existing.delegation_key ?? null) === null &&
            Number(existing.delegation_depth ?? 0) === 0 &&
            String(existing.assignee_agent_id ?? "") === String(spec.assignee_agent_id ?? "") &&
            (existing.requires_review === true) === spec.requires_review &&
            String(existing.required_capability ?? "") === String(spec.required_capability ?? "") &&
            String(existing.title) === spec.title &&
            String(existing.goal) === spec.goal &&
            String(existing.status) === freshStatus &&
            String(existing.source ?? "") === "decomposition" &&
            ((existing.mission_ids as string[] | undefined) ?? []).length === 0 &&
            (existing.blocked_code ?? null) === null;
          if (!adoptable) {
            throw new IntegrityError(
              "FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT",
              `deterministic child ${childIds[i]} has mismatched provenance`,
            );
          }
          children.push(existing);
          continue;
        }
        children.push(
          this.business.createWorkItem({
            business_id: businessId,
            title: String(c.title),
            goal: String(c.goal),
            assignee_agent_id: c.assignee_agent_id,
            parent_work_item_id: workItemId,
            required_capability: reqCap ?? undefined,
            requires_review: c.requires_review === true,
            decomposition_id: decompId,
            source: "decomposition",
            work_item_id: childIds[i],
            operator_id: actor,
          }),
        );
      }
      // Sibling dependency edges materialize in the SAME transaction —
      // no window where children exist without their canonical edges.
      const pending = new Map<string, string[]>();
      for (const spec of resolvedChildren) {
        if (spec.depends_on.length) pending.set(spec.work_item_id, spec.depends_on);
      }
      for (const [childId, depIds] of pending) {
        const childRow = this.node(childId);
        for (const depId of depIds) this.writeEdge(childRow, depId, actor);
      }
      // R2 §1 — every child gets its canonical dependency-set manifest
      // in the same txn (an empty set is a canonical row too, never an
      // inferred absence). The manifest is what open/reconcile consume.
      for (const cid of childIds) {
        this.writeDependencySet(this.node(cid), actor);
      }
      const decBody = {
        decomposition_row_id: rowId,
        decomposition_id: decompId,
        parent_work_item_id: workItemId,
        business_id: businessId,
        project_id: String(this.business.getBusiness(businessId).project_id),
        child_work_item_ids: childIds,
        proposal,
        proposal_digest: proposalDigest,
        state: "COMMITTED",
        created_by: actor,
        created_at: utcnow(),
        version: 0,
      };
      this.store.put("work_decomposition", rowId, decBody as Row, 0);
      const cur = this.node(workItemId);
      cur.decomposed_as = decompId;
      cur.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, cur, Number(cur.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId,
        event_type: "WORK_DECOMPOSED", actor: `operator:${actor}`,
        metadata: { decomposition_id: decompId, child_ids: childIds },
      });
      return { parent: saved, children };
    });
  }

  /**
   * Restart-safe graph reconcile: every work_item carrying graph
   * provenance fields must be backed by its canonical row. A forged or
   * incompletely-materialized row is quarantined (fail closed) — restart
   * can never fabricate missing graph evidence.
   */
  reconcileWorkGraph(): { quarantined: string[] } {
    const quarantined = new Set<string>();
    const mark = (id: string | null) => {
      if (!id) return;
      const w = this.store.tryGet("work_item", id) as Row | null;
      if (!w || String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) return;
      this.business.quarantineForReconcile(w, "canonical graph row malformed");
      quarantined.add(id);
    };
    // Canonical rows are themselves proof-checked: a malformed WGE/WDEL/
    // WDEC quarantines the work item it would have authorized — restart
    // can never fabricate or accept corrupt graph evidence (R1 §3/§4).
    for (const e of this.store.list("work_graph_edge")) {
      try {
        assertCanonicalEdge(this.graphDeps, e as Row);
      } catch {
        mark(String(e.dependent_work_item_id ?? ""));
      }
    }
    for (const d of this.store.list("work_delegation")) {
      try {
        assertCanonicalDelegation(this.graphDeps, d as Row);
      } catch {
        mark(String(d.child_work_item_id ?? ""));
      }
    }
    for (const d of this.store.list("work_decomposition")) {
      try {
        assertCanonicalDecomposition(this.graphDeps, d as Row);
      } catch {
        mark(String(d.parent_work_item_id ?? ""));
      }
    }
    // R2 §8 — dependency-set manifests are canonical authority rows too:
    // a malformed WDS quarantines its work item. And a work_item that
    // carries dependency authority (graph provenance fields or any edge
    // rows) must HAVE its manifest — a missing manifest is never
    // rebuilt from mutable live fields, it quarantines.
    for (const m of this.store.list("work_dependency_set")) {
      try {
        assertCanonicalDependencySet(this.graphDeps, m as Row);
      } catch {
        mark(String(m.work_item_id ?? ""));
      }
    }
    // Governed children (delegation/decomposition) always carry a
    // manifest written at admission — absence is corrupt. A parent that
    // merely carries `decomposed_as` is not dependency-governed, so it
    // needs no manifest.
    for (const w of this.store.list("work_item")) {
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      if (!w.delegated_from_work_item_id && !w.decomposition_id) continue;
      const wds = this.store.tryGet(
        "work_dependency_set", dependencySetRowId(String(w.work_item_id))) as Row | null;
      if (!wds) mark(String(w.work_item_id));
    }
    // Any edge claiming a dependent without a canonical manifest is
    // unproven authority — quarantine the dependent, never the edge alone.
    for (const e of this.store.list("work_graph_edge")) {
      const dep = String(e.dependent_work_item_id ?? "");
      const wds = this.store.tryGet("work_dependency_set", dependencySetRowId(dep)) as Row | null;
      if (!wds) mark(dep);
    }
    for (const w of this.store.list("work_item")) {
      if (!this.business.hasGraphFields(w)) continue;
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      try {
        this.business.assertGraphAuthority(w);
      } catch {
        quarantined.add(String(w.work_item_id));
      }
    }
    // P2 §15 — coordination authority reconcile. A malformed WCL
    // quarantines its work item (corrupt coordination authority fails
    // closed for new claim/heartbeat/open decisions). A live lease whose
    // clock has passed is deterministically fenced EXPIRED; safe
    // observability mirrors are repaired FROM the canonical lease —
    // never rebuilt from mutable mirrors alone. A work item's claim
    // mirrors with no lease are legacy phantoms and are cleared.
    const nowIso = utcnow();
    for (const l of this.store.list(WORK_CLAIM_LEASE_TABLE)) {
      try {
        assertCanonicalClaimLease(this.graphDeps, l as Row);
      } catch {
        mark(String(l.work_item_id ?? ""));
        continue;
      }
      const wid = String(l.work_item_id);
      const w = this.store.tryGet("work_item", wid) as Row | null;
      if (!w || String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      const live = String(l.state) === "ACTIVE" && !leaseLiveExpired(l as Row, nowIso);
      const expired = String(l.state) === "ACTIVE" && leaseLiveExpired(l as Row, nowIso);
      const wantBy = live ? String(l.claimant_agent_id) : null;
      const wantExp = live ? String(l.expires_at) : null;
      const mirrorDrift =
        String(w.claimed_by ?? "") !== String(wantBy ?? "") ||
        String(w.claim_expires_at ?? "") !== String(wantExp ?? "") ||
        (w.claim_token !== null && w.claim_token !== undefined);
      if (!expired && !mirrorDrift) continue;
      this.store.immediate(() => {
        const cur = this.store.get(WORK_CLAIM_LEASE_TABLE, String(l.lease_id));
        if (expired && String(cur.state) === "ACTIVE") {
          const next: Row = { ...cur, state: "EXPIRED", updated_at: utcnow() };
          next.lease_digest = claimLeaseDigest(next);
          this.store.put(WORK_CLAIM_LEASE_TABLE, String(cur.lease_id), next, Number(cur.version));
          this.store.event({
            entity_type: "work_item", entity_id: wid,
            event_type: "WORK_CLAIM_EXPIRED",
            actor: "PAIR_WORKFORCE_RECONCILE",
            metadata: {
              lease_id: String(cur.lease_id),
              claimant_agent_id: String(cur.claimant_agent_id),
              lease_epoch: Number(cur.lease_epoch),
            },
          });
        }
        const cw = this.store.get("work_item", wid);
        if (
          String(cw.claimed_by ?? "") !== String(wantBy ?? "") ||
          String(cw.claim_expires_at ?? "") !== String(wantExp ?? "") ||
          (cw.claim_token !== null && cw.claim_token !== undefined)
        ) {
          cw.claimed_by = wantBy;
          cw.claim_expires_at = wantExp;
          cw.claim_token = null;
          cw.updated_at = utcnow();
          this.store.put("work_item", wid, cw, Number(cw.version));
        }
      });
    }
    // Mirrors without a canonical lease are phantom coordination state
    // (legacy claims that cannot be proven, or forged mirrors) — they
    // invalidate safely: cleared, never adopted as authority (§9).
    for (const w of this.store.list("work_item")) {
      const hasMirror =
        Boolean(w.claimed_by) ||
        Boolean(w.claim_expires_at) ||
        (w.claim_token !== null && w.claim_token !== undefined);
      if (!hasMirror) continue;
      if (this.store.tryGet(WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(String(w.work_item_id)))) continue;
      this.store.immediate(() => {
        const cw = this.store.get("work_item", String(w.work_item_id));
        cw.claimed_by = null;
        cw.claim_expires_at = null;
        cw.claim_token = null;
        cw.updated_at = utcnow();
        this.store.put("work_item", String(w.work_item_id), cw, Number(cw.version));
        this.store.event({
          entity_type: "work_item", entity_id: String(w.work_item_id),
          event_type: "WORK_CLAIM_MIRRORS_CLEARED",
          actor: "PAIR_WORKFORCE_RECONCILE",
          metadata: { work_item_id: String(w.work_item_id) },
        });
      });
    }
    // Durable inbox evidence is validated — never fabricated/rebuilt; a
    // malformed message or receipt poisons only coordination audit (the
    // event log), never an existing mission or claim lease. R1 §8 —
    // corruption evidence is appended at most once per row so repeated
    // reconciles are a strict no-op on already-flagged rows.
    const alreadyFlagged = (etype: string, eid: string) =>
      this.store.listEvents(etype, eid).some(
        (e) => String(e.event_type) === "WORK_COORDINATION_CORRUPT");
    for (const m of this.store.list(WORKFORCE_MESSAGE_TABLE)) {
      try {
        // R2 §3 — validate the whole collaboration bundle: a deleted or
        //  corrupt receipt is invisible to a receipts-only sweep, so the
        //  message's deterministic expected receipt must exist and pass.
        assertCanonicalCollaborationBundle(this.graphDeps, m as Row);
      } catch {
        if (!alreadyFlagged(WORKFORCE_MESSAGE_TABLE, String(m.message_id ?? "unknown"))) {
          this.store.event({
            entity_type: WORKFORCE_MESSAGE_TABLE,
            entity_id: String(m.message_id ?? "unknown"),
            event_type: "WORK_COORDINATION_CORRUPT",
            actor: "PAIR_WORKFORCE_RECONCILE",
            metadata: { message_id: String(m.message_id ?? "") },
          });
        }
      }
    }
    for (const r of this.store.list(WORKFORCE_RECEIPT_TABLE)) {
      try {
        assertCanonicalReceipt(this.graphDeps, r as Row);
      } catch {
        if (!alreadyFlagged(WORKFORCE_RECEIPT_TABLE, String(r.receipt_id ?? "unknown"))) {
          this.store.event({
            entity_type: WORKFORCE_RECEIPT_TABLE,
            entity_id: String(r.receipt_id ?? "unknown"),
            event_type: "WORK_COORDINATION_CORRUPT",
            actor: "PAIR_WORKFORCE_RECONCILE",
            metadata: { receipt_id: String(r.receipt_id ?? ""), message_id: String(r.message_id ?? "") },
          });
        }
      }
    }
    return { quarantined: [...quarantined] };
  }
}
