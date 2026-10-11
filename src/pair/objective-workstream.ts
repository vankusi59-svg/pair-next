/**
 * P15.2 R1 — Objective → governed workstream decomposition.
 *
 * ONE work graph only — P14. This module is a governed bridge, not a
 * subsystem: a typed workstream proposal plus a canonical ACTIVE
 * Objective is materialized into the EXISTING P14 work graph via
 * `WorkforceService.decomposeWorkItem()` — the canonical
 * child/dependency materialization authority (deterministic DC_* ids,
 * bounded children, proposal digest, replay/conflict, atomic
 * children + WDEC + WGE + WDS + membership).
 *
 *   canonical Objective (P15.1 strict read + ACTIVE + pinned snapshot)
 *        ↓
 *   deterministic Objective ROOT work_item (OWI_<digest>) — an
 *   unassigned BACKLOG graph container carrying objective_id, never
 *   executable itself
 *        ↓
 *   normalized workstream proposal (keys + depends_on_keys →
 *   deterministic topological order → depends_on_indices)
 *        ↓
 *   WorkforceService.decomposeWorkItem() → DC_* workstream children
 *   (unassigned BACKLOG, objective_id inherited from root)
 *        ↓
 *   objective_workstream_binding (OWB_<digest>) — the cross-layer
 *   authority receipt pinning the exact Objective snapshot that caused
 *   the decomposition. Zero independent topology authority: it
 *   references the WDEC and is validated against it; P14 remains the
 *   source of truth for topology.
 *
 * STOP — P15.2 creates NO missions, work_open_bindings, executions,
 * dispatches, planner or router calls. Workstreams are deliberately
 * unassigned; allocation/delegation is P15.4. There is NO second graph,
 * no Workstream entity, no LLM, no CEO loop.
 *
 * Atomicity: root create/adopt + decomposeWorkItem + binding commit +
 * anchor event run inside ONE store.immediate() (better-sqlite3 nested
 * transactions become savepoints — inner seams keep their own atomicity
 * under the outer one). A crash anywhere commits nothing; a restart can
 * never observe a partially authoritative bridge.
 *
 * Idempotency: initial decomposition is exactly-once per Objective.
 * Same normalized proposal → replay returns the canonical
 * root/children/binding; a different normalized proposal after commit →
 * FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT. Replay compares the
 * BINDING's commit snapshot — never the Objective's current mutable
 * state — so an exact replay of the original committed decomposition
 * remains adoptable after legitimate amendments.
 */

import { canonicalJson, digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { BusinessLayer } from "./business.js";
import type { WorkforceService } from "./work-graph.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import {
  assertCanonicalDecomposition,
  assertCanonicalDependencySet,
  assertCanonicalMembership,
  decompositionRowId,
  dependencySetRowId,
  membershipRowId,
  type GraphAuthorityDeps,
} from "./graph-authority.js";
import { WORK_DECOMPOSE_CHILD_CAP } from "./work-graph.js";
import { TERMINAL_OBJECTIVE_STATUSES, type ObjectiveStatus } from "./objective-authority.js";

type Row = Record<string, unknown> & { version: number };

export const OBJECTIVE_WORKSTREAM_BINDING_ENTITY = "objective_workstream_binding";
export const OBJECTIVE_WORKSTREAM_BINDING_SCHEMA =
  "pair.os.vnext.objective-workstream-binding.v1";
const OBJECTIVE_WORKSTREAM_PROPOSAL_SCHEMA =
  "pair.os.vnext.objective-workstream-proposal.v1";
/** Root work items created by this seam — observability marker, the
 *  binding + canonical graph rows are the authority. */
export const OBJECTIVE_ROOT_SOURCE = "objective";

/** Deterministic root work-item identity — same Objective always
 *  converges to the same root. */
export function objectiveRootWorkItemId(objectiveId: string): string {
  return `OWI_${digest(`objective-root:${objectiveId}`).slice(0, 24)}`;
}
/** Exactly one binding can ever exist per Objective — initial
 *  decomposition is exactly-once (P15.5 owns adaptive changes). */
export function objectiveWorkstreamBindingId(objectiveId: string): string {
  return `OWB_${digest(`objective-workstream:${objectiveId}`).slice(0, 24)}`;
}
/** Decomposition id bound to the Objective + normalized proposal — a
 *  different proposal under the same root deterministically conflicts
 *  inside P14 as well. */
export function objectiveWorkstreamDecompositionId(
  objectiveId: string,
  normalizedProposalDigest: string,
): string {
  return `OWD_${digest(`${objectiveId}:${normalizedProposalDigest}`).slice(0, 24)}`;
}

/** Canonical self-consistency digest of a binding row — covers every
 *  pinned field; a tampered row fails strict read. Exported so tests
 *  and future read-models can recompute exactly. */
/** Canonical digest of the binding's workstream_key→child map —
 *  pinned in the immutable commit anchor so a key-swap + recomputed
 *  binding_digest cannot pass. */
export function objectiveWorkstreamMapDigest(
  workstreams: Array<Record<string, unknown>>,
): string {
  return digest(workstreams.map((w) => ({
    workstream_key: String(w.workstream_key),
    work_item_id: String(w.work_item_id),
  })));
}

export function objectiveWorkstreamBindingDigest(b: Record<string, unknown>): string {
  return digest({
    schema_version: OBJECTIVE_WORKSTREAM_BINDING_SCHEMA,
    binding_id: b.binding_id,
    objective_id: b.objective_id,
    business_id: b.business_id,
    objective_version_at_commit: b.objective_version_at_commit,
    objective_terms_version: b.objective_terms_version,
    objective_digest: b.objective_digest,
    root_work_item_id: b.root_work_item_id,
    decomposition_row_id: b.decomposition_row_id,
    decomposition_id: b.decomposition_id,
    workstreams: b.workstreams,
    normalized_proposal_digest: b.normalized_proposal_digest,
    state: b.state,
    created_by: b.created_by,
    created_at: b.created_at,
  });
}

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING", detail);
}

// ---------------------------------------------------------------------
// Typed workstream proposal (§4) + deterministic normalization (§5)
// ---------------------------------------------------------------------

export interface WorkstreamSpec {
  workstream_key: string;
  title: string;
  goal: string;
  depends_on_keys?: string[];
}

export interface ObjectiveWorkstreamProposalInput {
  objective_id: string;
  expected_objective_version: number;
  expected_terms_version: number;
  expected_objective_digest: string;
  workstreams: WorkstreamSpec[];
  actor: string;
}

interface NormalizedWorkstream {
  workstream_key: string;
  title: string;
  goal: string;
  depends_on_indices: number[];
}

function proposalFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL", detail);
}

function boundedStr(field: string, v: unknown, cap = 512): string {
  if (typeof v !== "string" || !v.trim() || v.length > cap) {
    proposalFail(`${field} invalid`);
  }
  return v;
}

/**
 * Deterministic compiler: named workstream keys + a dependency relation
 * → validated complete DAG → canonical topological order (Kahn with
 * code-point key-order tie-break) → ordered P14 child specs with
 * depends_on_indices. NOT a second graph — only the deterministic
 * mapping from the proposal into the existing P14 decomposition input.
 * Equivalent semantic proposals normalize identically.
 */
export function normalizeObjectiveWorkstreamProposal(input: {
  objective_id: string;
  workstreams: WorkstreamSpec[];
}): {
  normalized: Record<string, unknown>;
  normalizedProposalDigest: string;
  children: Array<{ title: string; goal: string; depends_on_indices: number[] }>;
} {
  const objectiveId = boundedStr("objective_id", input.objective_id, 256);
  if (!Array.isArray(input.workstreams) || input.workstreams.length === 0) {
    proposalFail("workstreams required");
  }
  if (input.workstreams.length > WORK_DECOMPOSE_CHILD_CAP) {
    proposalFail(`>${WORK_DECOMPOSE_CHILD_CAP} workstreams`);
  }
  const specs: WorkstreamSpec[] = [];
  const seen = new Set<string>();
  for (const [i, w] of input.workstreams.entries()) {
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      proposalFail(`workstream ${i} malformed`);
    }
    const key = boundedStr(`workstream[${i}].workstream_key`, w.workstream_key, 128);
    const title = boundedStr(`workstream[${i}].title`, w.title, 512);
    const goal = boundedStr(`workstream[${i}].goal`, w.goal, 2048);
    if (seen.has(key)) proposalFail(`duplicate workstream_key ${key}`);
    seen.add(key);
    const depsRaw = w.depends_on_keys ?? [];
    if (!Array.isArray(depsRaw)) proposalFail(`workstream ${key} depends_on_keys malformed`);
    const deps: string[] = [];
    for (const d of depsRaw) {
      const dep = boundedStr(`workstream ${key} depends_on_keys entry`, d, 128);
      if (dep === key) proposalFail(`workstream ${key} depends on itself`);
      if (!seen.has(dep) && !input.workstreams.some((x) => x.workstream_key === dep)) {
        proposalFail(`workstream ${key} depends on unknown ${dep}`);
      }
      if (deps.includes(dep)) proposalFail(`workstream ${key} duplicate dependency ${dep}`);
      deps.push(dep);
    }
    specs.push({ workstream_key: key, title, goal, depends_on_keys: deps });
  }
  // Kahn — tie-break by code-point key order so the result is canonical.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of specs) {
    indegree.set(s.workstream_key, (s.depends_on_keys ?? []).length);
    for (const d of s.depends_on_keys ?? []) {
      dependents.set(d, [...(dependents.get(d) ?? []), s.workstream_key]);
    }
  }
  const ready = [...indegree.keys()].filter((k) => indegree.get(k) === 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const order: string[] = [];
  const position = new Map<string, number>();
  while (ready.length) {
    const k = ready.shift()!;
    position.set(k, order.length);
    order.push(k);
    for (const dep of dependents.get(k) ?? []) {
      indegree.set(dep, indegree.get(dep)! - 1);
      if (indegree.get(dep) === 0) {
        // insert in canonical key order
        let i = 0;
        while (i < ready.length && ready[i]! < dep) i++;
        ready.splice(i, 0, dep);
      }
    }
  }
  if (order.length !== specs.length) {
    proposalFail("workstream dependency cycle");
  }
  const byKey = new Map(specs.map((s) => [s.workstream_key, s]));
  const normalizedWorkstreams = order.map((k) => {
    const s = byKey.get(k)!;
    // R2.C — canonicalize dependency keys FIRST: both the stored key
    // list and the derived indices come from the same sorted set, so
    // semantically identical proposals digest identically regardless
    // of dependency list order.
    const canonicalDeps = [...(s.depends_on_keys ?? [])]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      workstream_key: k,
      title: s.title,
      goal: s.goal,
      depends_on_keys: canonicalDeps,
      depends_on_indices: canonicalDeps.map((d) => position.get(d)!),
    };
  });
  const normalized = {
    schema: OBJECTIVE_WORKSTREAM_PROPOSAL_SCHEMA,
    objective_id: objectiveId,
    workstreams: normalizedWorkstreams,
  };
  return {
    normalized,
    normalizedProposalDigest: digest(normalized),
    children: normalizedWorkstreams.map((w) => ({
      title: w.title,
      goal: w.goal,
      depends_on_indices: w.depends_on_indices,
    })),
  };
}

// ---------------------------------------------------------------------
// Canonical binding validator (§7/§12)
// ---------------------------------------------------------------------

export interface ObjectiveWorkstreamDeps {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  objectives: ObjectiveAuthorityService;
}

/**
 * Full-chain proof that an `objective_workstream_binding` row is
 * canonical: strict shape + self-consistency digest + Objective
 * (canonical strict read, same business) + root work item identity +
 * the P14 chain it references (WDEC → children → membership → WDS —
 * delegated to the existing canonical validators, never re-derived).
 * The binding carries ZERO independent topology authority: its
 * workstream map must equal the WDEC's committed child set exactly.
 */
export function assertCanonicalObjectiveWorkstreamBinding(
  deps: ObjectiveWorkstreamDeps,
  row: Row,
): void {
  if (String(row.schema_version) !== OBJECTIVE_WORKSTREAM_BINDING_SCHEMA) {
    fail(`schema ${String(row.schema_version)}`);
  }
  for (const f of [
    "binding_id", "objective_id", "business_id", "objective_digest",
    "root_work_item_id", "decomposition_row_id", "decomposition_id",
    "normalized_proposal_digest", "created_by", "created_at",
  ]) {
    if (typeof row[f] !== "string" || !String(row[f])) {
      fail(`missing ${f}`);
    }
  }
  // R2.E — canonical authority shape requires actual JS integers;
  // numeric strings never coerce through.
  for (const f of [
    "objective_version_at_commit", "objective_terms_version", "version",
  ]) {
    if (typeof row[f] !== "number" || !Number.isInteger(row[f]) || Number(row[f]) < 0) {
      fail(`${f} malformed`);
    }
  }
  if (String(row.state) !== "COMMITTED") fail(`state ${String(row.state)}`);
  if (String(row.binding_id) !== objectiveWorkstreamBindingId(String(row.objective_id))) {
    fail(`binding_id ${String(row.binding_id)} is not deterministic for ${String(row.objective_id)}`);
  }
  if (objectiveWorkstreamBindingDigest(row) !== String(row.binding_digest)) {
    fail("binding_digest mismatch");
  }
  const objectiveId = String(row.objective_id);
  const businessId = String(row.business_id);
  // Objective must exist as canonical P15.1 authority and share the
  // binding's business — the CURRENT digest may legitimately differ
  // from the commit snapshot after amendments (the binding preserves
  // the snapshot; that is the point).
  const objective = deps.objectives.get(objectiveId);
  if (String(objective.business_id) !== businessId) {
    fail(`objective ${objectiveId} business mismatch`);
  }
  deps.business.getBusiness(businessId);
  // Root work item — identity + provenance fields verified, mutable
  // mirror fields never trusted by themselves (the membership row is
  // proven canonically below).
  const rootId = String(row.root_work_item_id);
  if (rootId !== objectiveRootWorkItemId(objectiveId)) {
    fail(`root_work_item_id ${rootId} is not deterministic for ${objectiveId}`);
  }
  const root = deps.store.tryGet("work_item", rootId) as Row | null;
  if (!root) fail(`root work item ${rootId} missing`);
  if (String(root.business_id) !== businessId ||
      String(root.objective_id ?? "") !== objectiveId ||
      String(root.source ?? "") !== OBJECTIVE_ROOT_SOURCE ||
      String(root.decomposed_as ?? "") !== String(row.decomposition_id)) {
    fail(`root ${rootId} identity mismatch`);
  }
  const graphDeps: GraphAuthorityDeps = {
    store: deps.store,
    getBusiness: (id) => deps.business.getBusiness(id),
    agentContracts: deps.business.agentContracts,
  };
  const rootMembership = deps.store.tryGet(
    "work_graph_membership", membershipRowId(rootId)) as Row | null;
  if (!rootMembership) fail(`root ${rootId} missing membership`);
  assertCanonicalMembership(graphDeps, rootMembership);
  // WDEC — the P14 decomposition this binding claims to bridge. Delegate
  // topology proof to the canonical validator; the binding only pins ids.
  const wdec = deps.store.tryGet(
    "work_decomposition", String(row.decomposition_row_id)) as Row | null;
  if (!wdec) fail(`decomposition row ${String(row.decomposition_row_id)} missing`);
  assertCanonicalDecomposition(graphDeps, wdec);
  if (String(wdec.decomposition_id) !== String(row.decomposition_id) ||
      String(wdec.parent_work_item_id) !== rootId ||
      String(wdec.business_id) !== businessId ||
      String(wdec.state) !== "COMMITTED") {
    fail(`decomposition ${String(row.decomposition_row_id)} does not match binding`);
  }
  if (String(row.decomposition_row_id) !== decompositionRowId(rootId)) {
    fail(`decomposition_row_id ${String(row.decomposition_row_id)} malformed`);
  }
  // The decomposition id cryptographically binds the normalized
  // proposal — a forged digest under a valid binding_digest breaks here.
  if (String(row.decomposition_id) !==
      objectiveWorkstreamDecompositionId(objectiveId, String(row.normalized_proposal_digest))) {
    fail("decomposition_id does not bind the normalized proposal digest");
  }
  // R2.A — the immutable commit anchor: EXACTLY ONE
  // OBJECTIVE_WORKSTREAM_COMMITTED event pins the binding's identity
  // fields and the committed workstream map. Events are append-only —
  // a tampered row with a recomputed "valid" digest still fails
  // against the anchored original.
  const anchors = deps.store
    .listEvents(OBJECTIVE_WORKSTREAM_BINDING_ENTITY, String(row.binding_id))
    .filter((e) => String(e.event_type) === "OBJECTIVE_WORKSTREAM_COMMITTED");
  if (anchors.length !== 1) {
    fail(`expected exactly 1 OBJECTIVE_WORKSTREAM_COMMITTED anchor, got ${anchors.length}`);
  }
  // R3.B — the event HEADER itself is bound to the binding's
  // provenance: actor = operator:${created_by}, new_state COMMITTED,
  // old_state null. The append-only hash protects the body; the
  // validator now proves the body represents the same authority.
  if (String(anchors[0]!.actor) !== `operator:${String(row.created_by)}` ||
      String(anchors[0]!.new_state) !== "COMMITTED" ||
      (anchors[0]!.old_state ?? null) !== null) {
    fail("anchor event header does not match binding provenance");
  }
  const md = (anchors[0]!.metadata ?? {}) as Record<string, unknown>;
  const wsRows = (row.workstreams as Array<Record<string, unknown>> | undefined) ?? [];
  const expectedAnchor: Record<string, unknown> = {
    binding_id: String(row.binding_id),
    binding_digest: objectiveWorkstreamBindingDigest(row),
    objective_id: objectiveId,
    business_id: businessId,
    objective_version_at_commit: Number(row.objective_version_at_commit),
    objective_terms_version: Number(row.objective_terms_version),
    objective_digest: String(row.objective_digest),
    root_work_item_id: String(row.root_work_item_id),
    decomposition_row_id: String(row.decomposition_row_id),
    decomposition_id: String(row.decomposition_id),
    normalized_proposal_digest: String(row.normalized_proposal_digest),
    workstream_map_digest: objectiveWorkstreamMapDigest(wsRows),
    workstream_count: wsRows.length,
  };
  for (const [k, v] of Object.entries(expectedAnchor)) {
    if (md[k] !== v) {
      fail(`anchor ${k} mismatch: ${String(md[k])} != ${String(v)}`);
    }
  }
  // Workstream map — must equal the WDEC's committed child set exactly,
  // in the normalized order; each child must be a canonical
  // DECOMPOSED_CHILD carrying the SAME objective_id.
  const ws = row.workstreams;
  if (!Array.isArray(ws)) fail("workstreams malformed");
  const wdecChildren = (wdec.child_work_item_ids as string[] | undefined) ?? [];
  if (ws.length !== wdecChildren.length) {
    fail(`workstream count ${ws.length} != wdec ${wdecChildren.length}`);
  }
  const seenKeys = new Set<string>();
  for (const [i, w] of ws.entries()) {
    if (!w || typeof w !== "object" || Array.isArray(w)) fail(`workstreams[${i}] malformed`);
    const key = String((w as Record<string, unknown>).workstream_key ?? "");
    const cid = String((w as Record<string, unknown>).work_item_id ?? "");
    if (!key || !cid) fail(`workstreams[${i}] missing fields`);
    if (seenKeys.has(key)) fail(`duplicate workstream_key ${key}`);
    seenKeys.add(key);
    if (cid !== wdecChildren[i]) {
      fail(`workstreams[${i}] ${cid} != wdec child ${wdecChildren[i]}`);
    }
    const child = deps.store.tryGet("work_item", cid) as Row | null;
    if (!child) fail(`child ${cid} missing`);
    if (String(child.business_id) !== businessId ||
        String(child.objective_id ?? "") !== objectiveId ||
        String(child.parent_work_item_id ?? "") !== rootId ||
        String(child.decomposition_id ?? "") !== String(row.decomposition_id)) {
      fail(`child ${cid} objective/graph identity mismatch`);
    }
    const membership = deps.store.tryGet(
      "work_graph_membership", membershipRowId(cid)) as Row | null;
    if (!membership) fail(`child ${cid} missing membership`);
    assertCanonicalMembership(graphDeps, membership);
    const wds = deps.store.tryGet(
      "work_dependency_set", dependencySetRowId(cid)) as Row | null;
    if (!wds) fail(`child ${cid} missing dependency set`);
    assertCanonicalDependencySet(graphDeps, wds);
  }
}

// ---------------------------------------------------------------------
// Service — the governed seam (§6/§9/§10)
// ---------------------------------------------------------------------

export class ObjectiveWorkstreamService {
  constructor(private readonly deps: ObjectiveWorkstreamDeps) {}

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }
  private get business(): BusinessLayer {
    return this.deps.business;
  }
  private get workforce(): WorkforceService {
    return this.deps.workforce;
  }
  private get objectives(): ObjectiveAuthorityService {
    return this.deps.objectives;
  }

  /**
   * Materialize an Objective's workstream proposal into the P14 work
   * graph. Exactly-once per Objective; replay/concurency deterministic.
   */
  decomposeObjective(input: ObjectiveWorkstreamProposalInput): {
    binding: Row;
    root: Row;
    children: Row[];
  } {
    // R3.A — actor is runtime authority SHAPE, first check before any
    // deadline evaluation or transaction: a non-string value must never
    // reach a persisted authority row the canonical reader would reject.
    if (typeof input.actor !== "string" ||
        !input.actor.trim() ||
        input.actor.length > 256) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective_workstream.decompose");
    }
    const objectiveId = boundedStr("objective_id", input.objective_id, 256);
    const { normalized, normalizedProposalDigest, children } =
      normalizeObjectiveWorkstreamProposal(input);
    const decompositionId =
      objectiveWorkstreamDecompositionId(objectiveId, normalizedProposalDigest);

    // Deadline semantics come from P15.1 itself — evaluateDeadline
    // commits EXPIRED in its own transaction BEFORE any graph work.
    this.objectives.evaluateDeadline(objectiveId);

    return this.store.immediate(() => {
      // Strict canonical read inside the transaction.
      const obj = this.objectives.get(objectiveId);
      const bindingId = objectiveWorkstreamBindingId(objectiveId);
      const existingBinding = this.store.tryGet(
        OBJECTIVE_WORKSTREAM_BINDING_ENTITY, bindingId) as Row | null;
      if (existingBinding) {
        // Replay/conflict — compare the committed normalized proposal,
        // never the Objective's current mutable terms (the binding
        // preserves the commit snapshot). An exact replay of the
        // original committed decomposition stays readable even after
        // status/version/digest changes (§9/§15) — the admission gates
        // below apply to NEW decomposition only.
        assertCanonicalObjectiveWorkstreamBinding(this.deps, existingBinding);
        if (String(existingBinding.normalized_proposal_digest) === normalizedProposalDigest) {
          const wdec = this.store.get(
            "work_decomposition", String(existingBinding.decomposition_row_id));
          const wchildren = ((wdec.child_work_item_ids as string[]) ?? [])
            .map((id) => this.store.get("work_item", String(id)) as Row);
          return {
            binding: existingBinding,
            root: this.store.get("work_item", String(existingBinding.root_work_item_id)) as Row,
            children: wchildren,
          };
        }
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT",
          `objective ${objectiveId} already decomposed under a different proposal`,
        );
      }
      // NEW admission gates §6 — ACTIVE Objective, canonical business,
      // caller-pinned snapshot must match the row this commit sees.
      if (String(obj.status) !== "ACTIVE" ||
          TERMINAL_OBJECTIVE_STATUSES.has(String(obj.status) as ObjectiveStatus)) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_STATE",
          `objective ${objectiveId} status ${String(obj.status)} is not ACTIVE`,
        );
      }
      const businessId = String(obj.business_id);
      this.business.getBusiness(businessId); // fail-closed: real business
      // R2.E — expected pins must be actual finite integers; a numeric
      // string is not canonical authority shape.
      const snapshotOk =
        typeof input.expected_objective_version === "number" &&
        Number.isInteger(input.expected_objective_version) &&
        typeof input.expected_terms_version === "number" &&
        Number.isInteger(input.expected_terms_version) &&
        input.expected_objective_version === Number(obj.version) &&
        input.expected_terms_version === Number(obj.terms_version) &&
        typeof input.expected_objective_digest === "string" &&
        input.expected_objective_digest === String(obj.objective_digest);
      if (!snapshotOk) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT",
          `stale objective snapshot for ${objectiveId}`,
        );
      }
      // R2.D — orphan-root fail-closed: the commit transaction writes
      // root + decomposition + binding + anchor atomically, so a
      // canonical Objective root can never legitimately exist WITHOUT
      // its binding. An existing OWI_* residue — however "fresh" it
      // looks — is unprovable residue, never adoptable freshness.
      const rootId = objectiveRootWorkItemId(objectiveId);
      const existingRoot = this.store.tryGet("work_item", rootId) as Row | null;
      if (existingRoot) {
        throw new IntegrityError(
          "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_ROOT_CONFLICT",
          `deterministic root ${rootId} exists without a canonical binding`,
        );
      }
      const root = this.business.createWorkItem({
        business_id: businessId,
        title: `[objective] ${String(obj.title)}`,
        goal: String(obj.statement ?? obj.title),
        objective_id: objectiveId,
        source: OBJECTIVE_ROOT_SOURCE,
        work_item_id: rootId,
        operator_id: input.actor,
      });
      // Existing P14 authority — children + WDEC + WGE + WDS + membership
      // materialize inside this same outer transaction.
      let childrenRows: Row[];
      try {
        const dec = this.workforce.decomposeWorkItem(rootId, {
          decomposition_id: decompositionId,
          children,
        }, input.actor);
        childrenRows = dec.children;
      } catch (err) {
        if ((err as IntegrityError).code === "FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT") {
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT",
            `objective ${objectiveId}: existing decomposition is a different proposal`,
          );
        }
        throw err;
      }
      // Cross-layer canonical receipt (§7) — pins the exact snapshot.
      const bindingBody: Record<string, unknown> = {
        schema_version: OBJECTIVE_WORKSTREAM_BINDING_SCHEMA,
        binding_id: bindingId,
        objective_id: objectiveId,
        business_id: businessId,
        objective_version_at_commit: Number(obj.version),
        objective_terms_version: Number(obj.terms_version),
        objective_digest: String(obj.objective_digest),
        root_work_item_id: rootId,
        decomposition_row_id: decompositionRowId(rootId),
        decomposition_id: decompositionId,
        workstreams: (normalized.workstreams as NormalizedWorkstream[])
          .map((w, i) => ({
            workstream_key: w.workstream_key,
            work_item_id: String(childrenRows[i]!.work_item_id),
          })),
        normalized_proposal_digest: normalizedProposalDigest,
        state: "COMMITTED",
        created_by: input.actor,
        created_at: utcnow(),
        version: 0,
      };
      bindingBody.binding_digest = objectiveWorkstreamBindingDigest(bindingBody);
      const binding = this.store.put(
        OBJECTIVE_WORKSTREAM_BINDING_ENTITY, bindingId, bindingBody as Row, 0);
      this.store.event({
        entity_type: OBJECTIVE_WORKSTREAM_BINDING_ENTITY,
        entity_id: bindingId,
        event_type: "OBJECTIVE_WORKSTREAM_COMMITTED",
        new_state: "COMMITTED",
        actor: `operator:${input.actor}`,
        // R2.A — immutable commit anchor: pins every authority field
        // the binding claims (identity fields only — P14 owns topology).
        metadata: {
          binding_id: bindingId,
          binding_digest: String(bindingBody.binding_digest),
          objective_id: objectiveId,
          business_id: businessId,
          objective_version_at_commit: Number(obj.version),
          objective_terms_version: Number(obj.terms_version),
          objective_digest: String(obj.objective_digest),
          root_work_item_id: rootId,
          decomposition_row_id: decompositionRowId(rootId),
          decomposition_id: decompositionId,
          normalized_proposal_digest: normalizedProposalDigest,
          workstream_map_digest: objectiveWorkstreamMapDigest(
            bindingBody.workstreams as Array<Record<string, unknown>>),
          workstream_count: childrenRows.length,
        },
      });
      return { binding, root: this.store.get("work_item", rootId) as Row, children: childrenRows };
    });
  }

  /** Strict read — the canonical binding for an Objective, or null. A
   *  malformed row fails closed, never silently skipped. */
  getBinding(objectiveId: string): Row | null {
    const row = this.store.tryGet(
      OBJECTIVE_WORKSTREAM_BINDING_ENTITY,
      objectiveWorkstreamBindingId(objectiveId)) as Row | null;
    if (!row) return null;
    assertCanonicalObjectiveWorkstreamBinding(this.deps, row);
    return row;
  }
}

// Late-bind the service constructor into the artifact resolver's
// lineage gate (same cycle discipline as workforce-allocation.ts —
// this module imports work-graph.ts which imports business.ts).
import { bindObjectiveWorkstreamCtor } from "./artifact-handoff.js";
bindObjectiveWorkstreamCtor(ObjectiveWorkstreamService);
