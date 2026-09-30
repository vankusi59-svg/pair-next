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
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  assertCanonicalEdge,
  childNodeId,
  decompositionProposal,
  decompositionProposalDigest,
  decompositionRowId,
  delegationRowId,
  edgeId,
  type GraphAuthorityDeps,
  type ResolvedChildSpec,
} from "./graph-authority.js";

// R1: deterministic helpers + canonical validators live in
// graph-authority.ts (imported by business.ts too) — re-exported here so
// `index.ts`'s `export * from "./work-graph.js"` keeps them public.
export {
  childNodeId,
  decompositionRowId,
  delegationRowId,
  edgeId,
  decompositionProposal,
  decompositionProposalDigest,
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
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
    return { store: this.store, getBusiness: (id) => this.business.getBusiness(id) };
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
  } {
    const nodes = this.business.listWorkItems(businessId);
    const ids = new Set(nodes.map((n) => String(n.work_item_id)));
    const edges = this.store.list("work_graph_edge").filter((e) =>
      ids.has(String(e.dependent_work_item_id)));
    const delegations = this.store.list("work_delegation").filter((d) =>
      String(d.business_id) === businessId);
    const decompositions = this.store.list("work_decomposition").filter((d) =>
      String(d.business_id) === businessId);
    const projected = nodes.map((n) => ({
      ...n,
      dependencies_satisfied: this.dependenciesProven(n),
    }));
    return { nodes: projected, edges, delegations, decompositions };
  }

  /** True when every canonical dependency edge of the node resolves to a
   *  proven-DONE prerequisite (bound COMPLETED mission + review
   *  acceptance when required — status alone never counts). */
  dependenciesProven(node: Row): boolean {
    for (const e of this.dependenciesOf(String(node.work_item_id))) {
      const dep = this.store.tryGet("work_item", String(e.dependency_work_item_id));
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

  /**
   * R1 §6 — an agent's effective execution authority, resolved from its
   * canonical P12 contract (same semantics as the gate's pinned∩current
   * effective policy, evaluated on the single CURRENT snapshot): the
   * concrete id sets an agent may actually reach. Sets are concrete —
   * `null` allow-list resolves against the registered/catalog universe,
   * minus denies, so subset comparison is exact.
   */
  private effectiveAuthority(agentId: string): {
    capabilities: Set<string>;
    executors: Set<string>;
    routes: Set<string>;
    projects: Set<string> | null;
    contextScopes: Set<string>;
  } {
    const { contract } = this.business.agentContracts.resolve(agentId, {
      actor: "PAIR_WORK_GRAPH",
    });
    const pol = contract.policy as {
      allowed_capabilities?: string[] | null;
      denied_capabilities?: string[];
      allowed_executor_ids?: string[] | null;
      denied_executor_ids?: string[];
      preferred_executor_ids?: string[];
      executor_fallback_allowed?: boolean;
      preferred_route_ids?: string[];
      denied_route_ids?: string[];
      route_fallback_allowed?: boolean;
      allowed_project_ids?: string[] | null;
      allowed_context_scopes?: string[];
    };
    const registered = this.business.agentContracts.registeredCapabilities();
    const capabilities = new Set(
      [...registered].filter((c) =>
        (pol.allowed_capabilities == null || pol.allowed_capabilities.includes(c)) &&
        !(pol.denied_capabilities ?? []).includes(c)),
    );
    const hardExec =
      pol.executor_fallback_allowed === false && (pol.preferred_executor_ids ?? []).length
        ? new Set(pol.preferred_executor_ids!) : null;
    const executors = new Set(
      this.store.list("executor").map((e) => String(e.executor_id)).filter((id) =>
        (pol.allowed_executor_ids == null || pol.allowed_executor_ids.includes(id)) &&
        (hardExec === null || hardExec.has(id)) &&
        !(pol.denied_executor_ids ?? []).includes(id)),
    );
    const hardRoute =
      pol.route_fallback_allowed === false && (pol.preferred_route_ids ?? []).length
        ? new Set(pol.preferred_route_ids!) : null;
    const routes = new Set(
      this.store.list("route").map((r) => String(r.route_id)).filter((id) =>
        (hardRoute === null || hardRoute.has(id)) &&
        !(pol.denied_route_ids ?? []).includes(id)),
    );
    return {
      capabilities,
      executors,
      routes,
      projects: pol.allowed_project_ids == null ? null : new Set(pol.allowed_project_ids),
      contextScopes: new Set(pol.allowed_context_scopes ?? []),
    };
  }

  /**
   * R1 §6 — child/delegatee effective authority must be a SUBSET of the
   * ceiling agent's effective authority in every dimension. Because the
   * sets are already deny-free, a child deny can never widen; an explicit
   * parent deny is automatically preserved (a denied id is absent from
   * the parent's set, so it can never appear in the child's).
   */
  private assertAuthoritySubset(
    child: ReturnType<WorkforceService["effectiveAuthority"]>,
    parent: ReturnType<WorkforceService["effectiveAuthority"]>,
    what: string,
  ): void {
    const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));
    const dim = (ok: boolean, name: string) => {
      if (!ok) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_AUTHORITY_WIDEN",
          `${what}: child ${name} exceeds parent authority`,
        );
      }
    };
    dim(subset(child.capabilities, parent.capabilities), "capabilities");
    dim(subset(child.executors, parent.executors), "executors");
    dim(subset(child.routes, parent.routes), "routes");
    if (parent.projects !== null) {
      dim(child.projects !== null && subset(child.projects, parent.projects), "projects");
    }
    dim(subset(child.contextScopes, parent.contextScopes), "context scopes");
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
        this.assertAuthoritySubset(
          this.effectiveAuthority(input.delegated_to_agent_id),
          this.effectiveAuthority(ceilingAgentId),
          `delegate ${input.delegated_to_agent_id}`,
        );
      }
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
        this.writeDelegationRow(parent, childId, key, mode, by, input.delegated_to_agent_id, depth, actor);
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
      this.writeDelegationRow(parent, childId, key, mode, by, input.delegated_to_agent_id, depth, actor);
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
      const proposal = decompositionProposal(workItemId, decompId, businessId, resolvedChildren);
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
        ? null : this.effectiveAuthority(ceilingAgentId);
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
          this.assertCapability(ag, reqCap);
          if (ceilingAuth) {
            this.assertAuthoritySubset(
              this.effectiveAuthority(c.assignee_agent_id),
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
    for (const w of this.store.list("work_item")) {
      if (!this.business.hasGraphFields(w)) continue;
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      try {
        this.business.assertGraphAuthority(w);
      } catch {
        quarantined.add(String(w.work_item_id));
      }
    }
    return { quarantined: [...quarantined] };
  }
}
