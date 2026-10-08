/**
 * P15.4 workforce allocation — canonical EVIDENCE leaf.
 *
 * Zero business/service imports: this module holds the immutable
 * receipt primitives (entity name, schema, committed-anchor event,
 * deterministic ids, self-digest) plus the dependency-free portion of
 * the canonical provenance proof (receipt shape → self-digest →
 * exactly-one committed anchor with full pin match).
 *
 * The heavier chain re-proof (binding → workstream → WDEL → child →
 * agent) stays in `workforce-allocation.ts`'s
 * `assertCanonicalWorkforceAllocation`, which composes this proof.
 * `BusinessLayer.openWorkItem` consumes this leaf directly for the
 * objective-admission lineage check without importing the service
 * module (which imports business.ts — a runtime cycle).
 */
import { digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

type Row = Record<string, unknown> & { version: number };

export const WORKFORCE_ALLOCATION_ENTITY = "workforce_allocation";
export const WORKFORCE_ALLOCATION_SCHEMA = "pair.os.vnext.workforce-allocation.v1";
export const WORKFORCE_ALLOCATION_COMMITTED_EVENT = "WORKFORCE_ALLOCATION_COMMITTED";
/** The deterministic selection policy this module implements —
 *  pinned into every receipt + the observation digest. */
export const ALLOCATION_SELECTION_POLICY = "p15.4-r1.workload-lexical";

function allocFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORKFORCE_ALLOCATION", detail);
}

/** Deterministic receipt id — one per (objective, workstream) slot. */
export function workforceAllocationId(objectiveId: string, workItemId: string): string {
  return `WAL_${digest(`workforce-allocation:${objectiveId}:${workItemId}`).slice(0, 24)}`;
}

/** The deterministic P14 delegation key = the WORKSTREAM ALLOCATION
 *  SLOT (§H) — never agent-dependent, so a changed selection after a
 *  crash/retry collides on the SAME deterministic child id instead of
 *  minting a second delegated child. */
export function allocationDelegationKey(objectiveId: string, workItemId: string): string {
  return `p15.4:${objectiveId}:${workItemId}`;
}

/** Self-consistency digest over every authority field the receipt
 *  claims — tampering any field invalidates the row. */
export function workforceAllocationDigest(b: Record<string, unknown>): string {
  return digest({
    allocation_id: b.allocation_id,
    objective_id: b.objective_id,
    business_id: b.business_id,
    objective_workstream_binding_id: b.objective_workstream_binding_id,
    objective_workstream_binding_digest: b.objective_workstream_binding_digest,
    workstream_key: b.workstream_key,
    workstream_work_item_id: b.workstream_work_item_id,
    selected_agent_id: b.selected_agent_id,
    delegated_child_work_item_id: b.delegated_child_work_item_id,
    delegation_id: b.delegation_id,
    allocation_observation_digest: b.allocation_observation_digest,
    selection_policy_version: b.selection_policy_version,
    created_by: b.created_by,
    created_at: b.created_at,
    state: b.state,
  });
}

const WORKFORCE_ALLOCATION_ALLOWED_FIELDS = new Set([
  "schema_version", "allocation_id", "objective_id", "business_id",
  "objective_workstream_binding_id", "objective_workstream_binding_digest",
  "workstream_key", "workstream_work_item_id", "selected_agent_id",
  "delegated_child_work_item_id", "delegation_id",
  "allocation_observation_digest", "selection_policy_version",
  "created_by", "created_at", "state", "allocation_digest",
  "entity_type", "entity_id", "version",
]);

/** P15.6 R4 — the dependency-free canonical provenance proof of a
 *  workforce allocation receipt: exact field allowlist, create-only
 *  version, deterministic id, self-digest, and exactly-one immutable
 *  `WORKFORCE_ALLOCATION_COMMITTED` anchor whose header and every pin
 *  agree with the row. Mutable row fields alone are NEVER authority —
 *  a rewrite (even a coherent re-hash) fails against the immutable
 *  anchor pins. The full service-level validator additionally re-proves
 *  the binding → workstream → WDEL → child → agent chain. */
export function assertCanonicalWorkforceAllocationProvenance(
  store: PairEvidenceStore,
  row: Row,
): void {
  for (const k of Object.keys(row)) {
    if (!WORKFORCE_ALLOCATION_ALLOWED_FIELDS.has(k)) {
      allocFail(`unknown field ${k}`);
    }
  }
  if (String(row.schema_version ?? "") !== WORKFORCE_ALLOCATION_SCHEMA) allocFail("schema_version");
  if (String(row.entity_type ?? "") !== WORKFORCE_ALLOCATION_ENTITY) allocFail("entity_type");
  if (String(row.entity_id ?? "") !== String(row.allocation_id ?? "")) allocFail("entity_id");
  // create-only immutable receipt — a rewrite loses authority.
  if (Number(row.version) !== 1) allocFail(`version ${String(row.version)}`);
  for (const f of [
    "allocation_id", "objective_id", "business_id",
    "objective_workstream_binding_id", "objective_workstream_binding_digest",
    "workstream_key", "workstream_work_item_id", "selected_agent_id",
    "delegated_child_work_item_id", "delegation_id",
    "allocation_observation_digest", "selection_policy_version",
    "created_by", "created_at", "allocation_digest",
  ] as const) {
    if (typeof row[f] !== "string" || !(row[f] as string)) allocFail(`${f} malformed`);
  }
  if (String(row.state) !== "COMMITTED") allocFail(`state ${String(row.state)}`);
  if (String(row.allocation_id) !==
      workforceAllocationId(String(row.objective_id), String(row.workstream_work_item_id))) {
    allocFail("allocation_id not deterministic");
  }
  if (workforceAllocationDigest(row) !== String(row.allocation_digest)) {
    allocFail("allocation_digest mismatch");
  }
  // Exactly-one anchor — header AND pins.
  const anchors = store
    .listEvents(WORKFORCE_ALLOCATION_ENTITY, String(row.allocation_id))
    .filter((e) => String(e.event_type) === WORKFORCE_ALLOCATION_COMMITTED_EVENT);
  if (anchors.length !== 1) allocFail(`expected 1 anchor, got ${anchors.length}`);
  const a = anchors[0]!;
  if (String(a.actor) !== `operator:${String(row.created_by)}` ||
      String(a.new_state) !== "COMMITTED" ||
      (a.old_state ?? null) !== null) {
    allocFail("anchor header mismatch");
  }
  const md = (a.metadata ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries({
    allocation_id: String(row.allocation_id),
    objective_id: String(row.objective_id),
    objective_workstream_binding_id: String(row.objective_workstream_binding_id),
    objective_workstream_binding_digest: String(row.objective_workstream_binding_digest),
    workstream_work_item_id: String(row.workstream_work_item_id),
    selected_agent_id: String(row.selected_agent_id),
    delegated_child_work_item_id: String(row.delegated_child_work_item_id),
    delegation_id: String(row.delegation_id),
    delegation_mode: "OPERATOR",
    delegated_by_operator: String(row.created_by),
    allocation_observation_digest: String(row.allocation_observation_digest),
    allocation_digest: String(row.allocation_digest),
  })) {
    if (md[k] !== v) allocFail(`anchor ${k} mismatch`);
  }
  // The pinned policy version is itself authority.
  if (String(row.selection_policy_version) !== ALLOCATION_SELECTION_POLICY) {
    allocFail(`selection_policy_version ${String(row.selection_policy_version)}`);
  }
}
