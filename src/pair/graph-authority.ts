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
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

type Row = Record<string, unknown> & { version: number };

/** Minimal business-layer surface the validators need (avoids a value
 *  cycle with business.ts which consumes these validators). */
export interface GraphAuthorityDeps {
  store: PairEvidenceStore;
  getBusiness(businessId: string): Row;
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
): Record<string, unknown> {
  return {
    schema: "pair.os.vnext.work-decomposition-proposal.v1",
    parent_work_item_id: parentId,
    decomposition_id: decompositionId,
    business_id: businessId,
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
    // Resulting canonical dependency topology must equal the proposal's.
    const edgeDeps = deps.store
      .list("work_graph_edge")
      .filter((e) => String(e.dependent_work_item_id) === cid && String(e.state) === "ACTIVE")
      .map((e) => String(e.dependency_work_item_id))
      .sort();
    const specDeps = [...spec.depends_on].sort();
    if (JSON.stringify(edgeDeps) !== JSON.stringify(specDeps)) {
      fail(`decomposition ${str(dec, "decomposition_row_id")} child ${cid} dep topology drift`);
    }
  }
}
