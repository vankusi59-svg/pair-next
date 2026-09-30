/**
 * P14 WORKFORCE V2 PHASE 1 R1 — canonical graph validators.
 *
 * One authority rule (Foundation V2): caller metadata and partial field
 * comparisons never create graph authority. Every canonical graph row is
 * proven by a FULL-CHAIN validator here — used identically at mutation
 * seams (reuse/replay), at openWorkItem (assertGraphAuthority), and at
 * boot reconcile. A row failing its canonical proof is forged/malformed:
 * the affected work item quarantines and never executes.
 *
 * Canonical entities (all written inside one store.immediate() txn):
 *   - `work_graph_edge`    (WGE_<digest>)  dependent → dependency
 *   - `work_delegation`    (WDEL_<child>)  delegation provenance
 *   - `work_decomposition` (WDEC_<parent>) committed child set + proposal
 */
import { digest } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { AgentContractService } from "./agent-contract.js";

type Row = Record<string, unknown> & { version: number };

/** Minimal business-layer surface the validators need (avoids a value
 *  cycle with business.ts which consumes these validators). */
export interface GraphAuthorityDeps {
  store: PairEvidenceStore;
  getBusiness(businessId: string): Row;
  agentContracts: AgentContractService;
}

export function childNodeId(prefix: "DL" | "DC", parentId: string, key: string): string {
  return `${prefix}_${digest(`${prefix}:${parentId}:${key}`).slice(0, 24)}`;
}

/** Deterministic edge id — exactly one edge can ever exist for
 *  (dependent, dependency); a second insert loses the v0-CAS. */
export function edgeId(dependentId: string, dependencyId: string): string {
  return `WGE_${digest(`wge:${dependentId}:${dependencyId}`).slice(0, 20)}`;
}

export function decompositionRowId(parentId: string): string {
  return `WDEC_${parentId}`;
}
export function delegationRowId(childId: string): string {
  return `WDEL_${childId}`;
}
/** Deterministic dependency-set manifest id — exactly one canonical
 *  dependency authority can ever exist per work item. */
export function dependencySetRowId(workItemId: string): string {
  return `WDS_${workItemId}`;
}

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_ROW", detail);
}

function str(row: Record<string, unknown>, field: string): string | null {
  const v = row[field];
  return v === null || v === undefined ? null : String(v);
}

/**
 * Resolved (id-materialized) decomposition child spec — the canonical
 * payload a committed WDEC carries and a proposal digest covers.
 */
export interface ResolvedChildSpec {
  work_item_id: string;
  title: string;
  goal: string;
  assignee_agent_id: string | null;
  requires_review: boolean;
  required_capability: string | null;
  depends_on: string[];
}

/** Canonical proposal identity for a decomposition — digest covers
 *  parent, decomposition_id, business, and the ordered resolved child
 *  specs INCLUDING their resulting dependency topology. Same
 *  decomposition_id + different digest is a conflict, never a replay. */
export function decompositionProposal(
  parentId: string,
  decompositionId: string,
  businessId: string,
  children: ResolvedChildSpec[],
  authorityCeilingAgent: string | null,
  authorityCeiling: AuthorityCeiling | null,
): Record<string, unknown> {
  return {
    schema: "pair.os.vnext.work-decomposition-proposal.v1",
    parent_work_item_id: parentId,
    decomposition_id: decompositionId,
    business_id: businessId,
    authority_ceiling_agent: authorityCeilingAgent,
    authority_ceiling: authorityCeiling,
    children,
  };
}
export function decompositionProposalDigest(proposal: Record<string, unknown>): string {
  return digest(proposal);
}

// ---------------------------------------------------------------------
// work_graph_edge (WGE) — dependent → dependency
// ---------------------------------------------------------------------

/** Full-chain proof that a `work_graph_edge` row is canonical: its key
 *  is the deterministic id of its exact endpoints, both nodes exist,
 *  endpoints share business + canonical project, the stored scope fields
 *  match, and the lifecycle state is valid. Throws on any mismatch. */
export function assertCanonicalEdge(deps: GraphAuthorityDeps, edge: Row): void {
  const dependentId = str(edge, "dependent_work_item_id");
  const dependencyId = str(edge, "dependency_work_item_id");
  if (!dependentId || !dependencyId) fail(`edge missing endpoints ${JSON.stringify(edge.edge_id)}`);
  if (dependentId === dependencyId) fail(`self edge ${dependentId}`);
  if (str(edge, "edge_id") !== edgeId(dependentId, dependencyId)) {
    fail(`edge_id ${str(edge, "edge_id")} != deterministic(${dependentId},${dependencyId})`);
  }
  if (!["ACTIVE", "REVOKED"].includes(String(edge.state))) {
    fail(`edge ${str(edge, "edge_id")} malformed state ${String(edge.state)}`);
  }
  const dependent = deps.store.tryGet("work_item", dependentId) as Row | null;
  const dependency = deps.store.tryGet("work_item", dependencyId) as Row | null;
  if (!dependent) fail(`edge ${str(edge, "edge_id")} missing dependent ${dependentId}`);
  if (!dependency) fail(`edge ${str(edge, "edge_id")} missing dependency ${dependencyId}`);
  if (String(dependent.business_id) !== String(dependency.business_id)) {
    fail(`edge ${str(edge, "edge_id")} cross-business`);
  }
  if (str(edge, "business_id") !== String(dependent.business_id)) {
    fail(`edge ${str(edge, "edge_id")} business mismatch`);
  }
  const business = deps.getBusiness(String(dependent.business_id));
  if (str(edge, "project_id") !== String(business.project_id)) {
    fail(`edge ${str(edge, "edge_id")} project mismatch`);
  }
}

// ---------------------------------------------------------------------
// work_delegation (WDEL) — delegation provenance for one child
// ---------------------------------------------------------------------

/** Full-chain proof that a `work_delegation` row is canonical AND that
 *  the child it claims actually carries matching provenance:
 *  key/delegation_id = WDEL_<child>, child+parent resolve, same business,
 *  canonical project, from/to agents, child assignee == delegated_to,
 *  mode consistency (AGENT: from-agent == parent assignee;
 *  OPERATOR: operator provenance, no from-agent), key/depth/capability
 *  relationships, COMMITTED. */
export function assertCanonicalDelegation(deps: GraphAuthorityDeps, del: Row): void {
  const childId = str(del, "child_work_item_id");
  const parentId = str(del, "parent_work_item_id");
  if (!childId || !parentId) fail(`delegation missing endpoints ${str(del, "delegation_id")}`);
  if (str(del, "delegation_id") !== delegationRowId(childId)) {
    fail(`delegation_id ${str(del, "delegation_id")} != WDEL_${childId}`);
  }
  const child = deps.store.tryGet("work_item", childId) as Row | null;
  const parent = deps.store.tryGet("work_item", parentId) as Row | null;
  if (!child) fail(`delegation ${str(del, "delegation_id")} missing child ${childId}`);
  if (!parent) fail(`delegation ${str(del, "delegation_id")} missing parent ${parentId}`);
  const businessId = str(del, "business_id");
  if (!businessId || String(child.business_id) !== businessId ||
      String(parent.business_id) !== businessId) {
    fail(`delegation ${str(del, "delegation_id")} business mismatch`);
  }
  const business = deps.getBusiness(businessId);
  if (str(del, "project_id") !== String(business.project_id)) {
    fail(`delegation ${str(del, "delegation_id")} project mismatch`);
  }
  const to = str(del, "delegated_to_agent_id");
  if (!to || str(child, "assignee_agent_id") !== to) {
    fail(`delegation ${str(del, "delegation_id")} assignee mismatch`);
  }
  const toAgent = deps.store.tryGet("org_agent", to) as Row | null;
  if (!toAgent || String(toAgent.business_id) !== businessId) {
    fail(`delegation ${str(del, "delegation_id")} target agent mismatch`);
  }
  const mode = String(del.delegation_mode ?? "AGENT");
  if (mode === "AGENT") {
    const from = str(del, "delegated_from_agent_id");
    if (!from || str(child, "delegated_by_agent_id") !== from) {
      fail(`delegation ${str(del, "delegation_id")} delegator mismatch`);
    }
    const fromAgent = deps.store.tryGet("org_agent", from) as Row | null;
    if (!fromAgent || String(fromAgent.business_id) !== businessId) {
      fail(`delegation ${str(del, "delegation_id")} delegator agent mismatch`);
    }
    // Canonical delegator identity: only the parent's own assignee may be
    // recorded as the agent delegating its work (R1 §5).
    if (str(parent, "assignee_agent_id") !== from) {
      fail(`delegation ${str(del, "delegation_id")} delegator is not parent assignee`);
    }
    if (str(del, "delegated_by_operator") !== null) {
      fail(`delegation ${str(del, "delegation_id")} AGENT mode carries operator`);
    }
  } else if (mode === "OPERATOR") {
    if (str(del, "delegated_from_agent_id") !== null ||
        str(child, "delegated_by_agent_id") !== null ||
        !str(del, "delegated_by_operator")) {
      fail(`delegation ${str(del, "delegation_id")} OPERATOR provenance malformed`);
    }
  } else {
    fail(`delegation ${str(del, "delegation_id")} unknown mode ${mode}`);
  }
  // R2 §3 — persisted authority ceiling: AGENT delegations carry the
  // delegator's normalized ceiling snapshot + digest; OPERATOR
  // delegations record explicit nulls (unassigned parent = operator
  // admission rule, no fabricated ceiling).
  const ceilingAgent = str(del, "authority_ceiling_agent");
  const ceiling = del.authority_ceiling as AuthorityCeiling | null | undefined;
  const ceilingDigest = str(del, "authority_ceiling_digest");
  if (ceilingAgent === null) {
    // Unassigned parent at write time — no ceiling is persisted.
    if ((ceiling ?? null) !== null || ceilingDigest !== null) {
      fail(`delegation ${str(del, "delegation_id")} ceiling fields inconsistent`);
    }
  } else {
    // Ceiling must be a self-consistent snapshot digest of that agent.
    // AGENT mode: ceiling source is the delegator. OPERATOR mode: the
    // parent's assignee supplies the ceiling even though it is not the
    // delegator.
    if (!ceiling || typeof ceiling !== "object" || ceiling.agent_id !== ceilingAgent) {
      fail(`delegation ${str(del, "delegation_id")} authority ceiling agent malformed`);
    }
    if (ceilingDigest === null || authorityCeilingDigest(ceiling) !== ceilingDigest) {
      fail(`delegation ${str(del, "delegation_id")} authority ceiling digest mismatch`);
    }
    if (mode === "AGENT" && ceilingAgent !== str(del, "delegated_from_agent_id")) {
      fail(`delegation ${str(del, "delegation_id")} AGENT ceiling not from delegator`);
    }
  }
  if (str(child, "delegated_from_work_item_id") !== parentId ||
      str(child, "parent_work_item_id") !== parentId) {
    fail(`delegation ${str(del, "delegation_id")} child parent back-reference mismatch`);
  }
  if (str(child, "delegation_key") !== str(del, "delegation_key")) {
    fail(`delegation ${str(del, "delegation_id")} key mismatch`);
  }
  const depth = Number(del.depth);
  if (!Number.isInteger(depth) || depth < 1 ||
      Number(child.delegation_depth ?? 0) !== depth ||
      depth !== Number(parent.delegation_depth ?? 0) + 1) {
    fail(`delegation ${str(del, "delegation_id")} depth mismatch`);
  }
  // Capability relationship: the child inherits exactly the parent's
  // required capability — delegation narrows, never expands.
  if (str(child, "required_capability") !== str(parent, "required_capability")) {
    fail(`delegation ${str(del, "delegation_id")} capability relationship broken`);
  }
  if (str(child, "decomposition_id") !== null) {
    fail(`delegation ${str(del, "delegation_id")} child carries conflicting decomposition provenance`);
  }
  if (String(del.state) !== "COMMITTED") {
    fail(`delegation ${str(del, "delegation_id")} state ${String(del.state)}`);
  }
}

// ---------------------------------------------------------------------
// work_decomposition (WDEC) — committed child set + proposal digest
// ---------------------------------------------------------------------

/** Full-chain proof that a `work_decomposition` row is canonical:
 *  key = WDEC_<parent>, parent exists and carries the committed marker,
 *  business + canonical project, COMMITTED, every listed child resolves
 *  with matching parent/business/decomposition back-references, and the
 *  persisted proposal's digest recomputes — with each proposal child
 *  still matching the live child row's spec fields. */
export function assertCanonicalDecomposition(deps: GraphAuthorityDeps, dec: Row): void {
  const parentId = str(dec, "parent_work_item_id");
  if (!parentId) fail("decomposition missing parent");
  if (str(dec, "decomposition_row_id") !== decompositionRowId(parentId)) {
    fail(`decomposition_row_id ${str(dec, "decomposition_row_id")} != WDEC_${parentId}`);
  }
  const parent = deps.store.tryGet("work_item", parentId) as Row | null;
  if (!parent) fail(`decomposition ${str(dec, "decomposition_row_id")} missing parent ${parentId}`);
  const businessId = str(dec, "business_id");
  if (!businessId || String(parent.business_id) !== businessId) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} business mismatch`);
  }
  const business = deps.getBusiness(businessId);
  if (str(dec, "project_id") !== String(business.project_id)) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} project mismatch`);
  }
  if (String(dec.state) !== "COMMITTED") {
    fail(`decomposition ${str(dec, "decomposition_row_id")} state ${String(dec.state)}`);
  }
  if (str(parent, "decomposed_as") !== str(dec, "decomposition_id")) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} parent marker mismatch`);
  }
  const proposal = dec.proposal as Record<string, unknown> | undefined;
  if (!proposal || typeof proposal !== "object") {
    fail(`decomposition ${str(dec, "decomposition_row_id")} missing proposal`);
  }
  if (decompositionProposalDigest(proposal) !== str(dec, "proposal_digest")) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} proposal digest mismatch`);
  }
  if (str(proposal, "decomposition_id") !== str(dec, "decomposition_id") ||
      str(proposal, "parent_work_item_id") !== parentId ||
      str(proposal, "business_id") !== businessId) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} proposal header mismatch`);
  }
  const proposalChildren = proposal.children as ResolvedChildSpec[] | undefined;
  const childIds = dec.child_work_item_ids;
  if (!Array.isArray(childIds) || !childIds.length ||
      !Array.isArray(proposalChildren) || proposalChildren.length !== childIds.length) {
    fail(`decomposition ${str(dec, "decomposition_row_id")} child list malformed`);
  }
  // R2 §3 — committed proposals carry the parent authority ceiling for
  // directly-assigned children (or explicit null for an unassigned
  // parent). The proposal digest covers the whole proposal; here only
  // shape/agency consistency is proven.
  {
    const ceilingAgent = str(proposal, "authority_ceiling_agent");
    const ceiling = proposal.authority_ceiling as Record<string, unknown> | null | undefined;
    if (ceilingAgent !== null) {
      if (!ceiling || typeof ceiling !== "object" ||
          str(ceiling, "agent_id") !== ceilingAgent) {
        fail(`decomposition ${str(dec, "decomposition_row_id")} authority ceiling malformed`);
      }
    } else if (ceiling !== null && ceiling !== undefined) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} ceiling without ceiling agent`);
    }
  }
  for (const [i, cidRaw] of (childIds as unknown[]).entries()) {
    const cid = String(cidRaw);
    const spec = proposalChildren![i]!;
    if (String(spec.work_item_id) !== cid) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} proposal order mismatch @${i}`);
    }
    const child = deps.store.tryGet("work_item", cid) as Row | null;
    if (!child) fail(`decomposition ${str(dec, "decomposition_row_id")} missing child ${cid}`);
    // Child must carry this decomposition's provenance — and nothing else.
    if (str(child, "parent_work_item_id") !== parentId ||
        str(child, "decomposition_id") !== str(dec, "decomposition_id") ||
        String(child.business_id) !== businessId ||
        str(child, "delegated_from_work_item_id") !== null ||
        str(child, "delegated_by_agent_id") !== null ||
        str(child, "delegation_key") !== null ||
        Number(child.delegation_depth ?? 0) !== 0) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} child ${cid} back-reference mismatch`);
    }
    // The live child spec must still equal the committed proposal —
    // payload drift breaks provenance.
    if (str(child, "title") !== spec.title ||
        str(child, "goal") !== spec.goal ||
        str(child, "assignee_agent_id") !== spec.assignee_agent_id ||
        (child.requires_review === true) !== spec.requires_review ||
        str(child, "required_capability") !== spec.required_capability) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} child ${cid} spec drift`);
    }
    // Resulting canonical dependency topology must equal the proposal's —
    // proven via the child's own canonical dependency-set manifest
    // (R2 §1): the manifest is the omission-safe authority; edge scans
    // alone can never prove a set.
    const wds = deps.store.tryGet("work_dependency_set", dependencySetRowId(cid)) as Row | null;
    if (!wds) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} child ${cid} missing dependency manifest`);
    }
    assertCanonicalDependencySet(deps, wds);
    const specDeps = [...spec.depends_on].sort();
    if (JSON.stringify(wds.dependency_work_item_ids) !== JSON.stringify(specDeps)) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} child ${cid} dep topology drift`);
    }
  }
}

// ---------------------------------------------------------------------
// work_dependency_set (WDS) — R2 §1 omission-safe dependency authority
// ---------------------------------------------------------------------

/**
 * Canonical digest of a dependency-set declaration: the work item plus
 * the SORTED ids of its ACTIVE canonical edges and dependency nodes.
 * Ordering is normalized before digesting so equal sets digest equal.
 */
export function dependencySetDigest(
  workItemId: string,
  activeEdgeIds: string[],
  dependencyWorkItemIds: string[],
): string {
  return digest({
    schema: "pair.os.vnext.work-dependency-set.v1",
    work_item_id: workItemId,
    active_edge_ids: [...activeEdgeIds].sort(),
    dependency_work_item_ids: [...dependencyWorkItemIds].sort(),
  });
}

/**
 * Full-chain proof that a `work_dependency_set` manifest is canonical —
 * and that it is the COMPLETE dependency authority for the work item:
 *
 *  - key === WDS_<work_item_id>; the node resolves;
 *  - business/project match the canonical relationship;
 *  - COMMITTED; integer revision ≥ 1;
 *  - stored lists are sorted and digest recompute matches;
 *  - every listed edge id resolves to a row that passes
 *    assertCanonicalEdge with dependent === this item and state ACTIVE;
 *  - the listed edges' dependency set equals dependency_work_item_ids;
 *  - NO other ACTIVE edge claims this item as dependent (extra edge =
 *    forged/malformed — fail closed);
 *  - a listed edge whose payload drifted (endpoints moved) fails
 *    assertCanonicalEdge — the ORIGINAL dependent never loses authority
 *    because an edge row was mutated.
 */
export function assertCanonicalDependencySet(deps: GraphAuthorityDeps, set: Row): void {
  const workItemId = str(set, "work_item_id");
  if (!workItemId) fail("dependency set missing work_item_id");
  if (str(set, "dependency_set_id") !== dependencySetRowId(workItemId)) {
    fail(`dependency_set_id ${str(set, "dependency_set_id")} != WDS_${workItemId}`);
  }
  const node = deps.store.tryGet("work_item", workItemId) as Row | null;
  if (!node) fail(`dependency set ${dependencySetRowId(workItemId)} missing node`);
  const businessId = str(set, "business_id");
  if (!businessId || String(node.business_id) !== businessId) {
    fail(`dependency set ${dependencySetRowId(workItemId)} business mismatch`);
  }
  const business = deps.getBusiness(businessId);
  if (str(set, "project_id") !== String(business.project_id)) {
    fail(`dependency set ${dependencySetRowId(workItemId)} project mismatch`);
  }
  if (String(set.state) !== "COMMITTED") {
    fail(`dependency set ${dependencySetRowId(workItemId)} state ${String(set.state)}`);
  }
  const revision = Number(set.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    fail(`dependency set ${dependencySetRowId(workItemId)} revision ${String(set.revision)}`);
  }
  const edgeIds = set.active_edge_ids;
  const depIds = set.dependency_work_item_ids;
  if (!Array.isArray(edgeIds) || !Array.isArray(depIds)) {
    fail(`dependency set ${dependencySetRowId(workItemId)} lists malformed`);
  }
  const sortedEdgeIds = (edgeIds as unknown[]).map(String);
  const sortedDepIds = (depIds as unknown[]).map(String);
  const isSorted = (xs: string[]) =>
    JSON.stringify(xs) === JSON.stringify([...xs].sort());
  if (!isSorted(sortedEdgeIds) || !isSorted(sortedDepIds)) {
    fail(`dependency set ${dependencySetRowId(workItemId)} lists not canonical-ordered`);
  }
  if (dependencySetDigest(workItemId, sortedEdgeIds, sortedDepIds) !==
      str(set, "dependency_set_digest")) {
    fail(`dependency set ${dependencySetRowId(workItemId)} digest mismatch`);
  }
  const resolvedDeps: string[] = [];
  for (const eid of sortedEdgeIds) {
    const edge = deps.store.tryGet("work_graph_edge", eid) as Row | null;
    if (!edge) {
      fail(`dependency set ${dependencySetRowId(workItemId)} missing expected edge ${eid}`);
    }
    assertCanonicalEdge(deps, edge);
    if (str(edge, "dependent_work_item_id") !== workItemId) {
      fail(`dependency set ${dependencySetRowId(workItemId)} edge ${eid} dependent drifted`);
    }
    if (String(edge.state) !== "ACTIVE") {
      fail(`dependency set ${dependencySetRowId(workItemId)} edge ${eid} not ACTIVE`);
    }
    resolvedDeps.push(str(edge, "dependency_work_item_id")!);
  }
  if (JSON.stringify([...resolvedDeps].sort()) !== JSON.stringify(sortedDepIds)) {
    fail(`dependency set ${dependencySetRowId(workItemId)} endpoint set mismatch`);
  }
  // Omission safety: no ACTIVE edge may exist for this dependent outside
  // the manifest — a forged/extra edge is never silently effective.
  const declared = new Set(sortedEdgeIds);
  for (const e of deps.store.list("work_graph_edge")) {
    if (String(e.dependent_work_item_id) !== workItemId || String(e.state) !== "ACTIVE") continue;
    if (!declared.has(String(e.edge_id))) {
      fail(`dependency set ${dependencySetRowId(workItemId)} extra edge ${String(e.edge_id)}`);
    }
  }
}

// ---------------------------------------------------------------------
// Authority ceiling (R2 §3) — persisted P12 ceiling snapshot + digest
// ---------------------------------------------------------------------

/** Concrete normalized authority sets an agent can currently reach —
 *  resolved from its canonical P12 contract (registered/catalog
 *  universe bounded, minus explicit denies). A non-ACTIVE contract
 *  carries zero effective authority. */
export interface EffectiveAuthority {
  capabilities: Set<string>;
  executors: Set<string>;
  routes: Set<string>;
  /** null = unrestricted (contract allows all projects). */
  projects: Set<string> | null;
  contextScopes: Set<string>;
}

/** Resolve an agent's CURRENT effective P12 authority. A DISABLED (or
 *  otherwise non-ACTIVE) contract resolves to empty authority — R2 §5:
 *  never usable for new admission. */
export function effectiveAuthority(deps: GraphAuthorityDeps, agentId: string): EffectiveAuthority {
  const { contract } = deps.agentContracts.resolve(agentId, { actor: "PAIR_WORK_GRAPH" });
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
  const empty: EffectiveAuthority = {
    capabilities: new Set(), executors: new Set(), routes: new Set(),
    projects: new Set(), contextScopes: new Set(),
  };
  if (String(contract.status) !== "ACTIVE") return empty;
  const registered = deps.agentContracts.registeredCapabilities();
  const capabilities = new Set(
    [...registered].filter((c) =>
      (pol.allowed_capabilities == null || pol.allowed_capabilities.includes(c)) &&
      !(pol.denied_capabilities ?? []).includes(c)),
  );
  const hardExec =
    pol.executor_fallback_allowed === false && (pol.preferred_executor_ids ?? []).length
      ? new Set(pol.preferred_executor_ids!) : null;
  const executors = new Set(
    deps.store.list("executor").map((e) => String(e.executor_id)).filter((id) =>
      (pol.allowed_executor_ids == null || pol.allowed_executor_ids.includes(id)) &&
      (hardExec === null || hardExec.has(id)) &&
      !(pol.denied_executor_ids ?? []).includes(id)),
  );
  const hardRoute =
    pol.route_fallback_allowed === false && (pol.preferred_route_ids ?? []).length
      ? new Set(pol.preferred_route_ids!) : null;
  const routes = new Set(
    deps.store.list("route").map((r) => String(r.route_id)).filter((id) =>
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

/** Normalized persisted ceiling snapshot (all arrays sorted). */
export interface AuthorityCeiling {
  agent_id: string;
  capabilities: string[];
  executors: string[];
  routes: string[];
  projects: string[] | null;
  context_scopes: string[];
}

export function authorityCeilingSnapshot(
  deps: GraphAuthorityDeps,
  agentId: string,
): AuthorityCeiling {
  const a = effectiveAuthority(deps, agentId);
  return {
    agent_id: agentId,
    capabilities: [...a.capabilities].sort(),
    executors: [...a.executors].sort(),
    routes: [...a.routes].sort(),
    projects: a.projects === null ? null : [...a.projects].sort(),
    context_scopes: [...a.contextScopes].sort(),
  };
}

export function authorityCeilingDigest(ceiling: AuthorityCeiling): string {
  return digest({ schema: "pair.os.vnext.authority-ceiling.v1", ...ceiling });
}

export function authorityToCeilingSet(ceiling: AuthorityCeiling): EffectiveAuthority {
  return {
    capabilities: new Set(ceiling.capabilities),
    executors: new Set(ceiling.executors),
    routes: new Set(ceiling.routes),
    projects: ceiling.projects === null ? null : new Set(ceiling.projects),
    contextScopes: new Set(ceiling.context_scopes),
  };
}

/**
 * child ⊆ ceiling across every dimension — capabilities, executors,
 * routes, projects, context scopes. Deny-free sets mean an explicit
 * ceiling deny can never re-appear in the child.
 */
export function assertAuthoritySubset(
  child: EffectiveAuthority,
  ceiling: EffectiveAuthority,
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
  dim(subset(child.capabilities, ceiling.capabilities), "capabilities");
  dim(subset(child.executors, ceiling.executors), "executors");
  dim(subset(child.routes, ceiling.routes), "routes");
  if (ceiling.projects !== null) {
    dim(child.projects !== null && subset(child.projects, ceiling.projects), "projects");
  }
  dim(subset(child.contextScopes, ceiling.contextScopes), "context scopes");
}
