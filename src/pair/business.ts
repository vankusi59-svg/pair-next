/**
 * P-BIZ business layer — the "one-person business" skeleton on top of the
 * governed mission engine.
 *
 * Model (ported from the Paperclip/autocomp pattern, kept canonical):
 *   business ── org_agent (role, department, reports_to) ── work_item
 *            ── routine (compiles to mission_schedule) ── budget_policy
 *
 * Design rules:
 * - Every entity lives in the canonical store (entities + events) — audit
 *   trail identical to missions. No shadow state.
 * - The ONLY way a work item does work is openWorkItem() → MissionControl
 *   .startMission() — the canonical governed path (planner + digest +
 *   scheduler + recovery). Business entities never dispatch side effects.
 * - budget_policy is fail-closed: when a hard-stop policy for the scope
 *   (agent → department → business) is exceeded, openWorkItem throws
 *   FAIL_CLOSED_BUDGET_EXCEEDED and records BUDGET_EXCEEDED.
 * - Money/outbound boundaries stay in the approval queue — business layer
 *   only decides WHICH mission runs, never bypasses approvals.
 */
import { IntegrityError, PolicyError } from "./errors.js";
import { digest, newId, utcnow } from "./canonical.js";
import {
  AgentContractService,
  type AgentContractPolicy,
  type AgentContractStatus,
} from "./agent-contract.js";
import type { PairEvidenceStore } from "./store.js";
import type { MissionControl } from "./mission-control.js";
import type { MissionScheduleService } from "./mission-schedule.js";
import { validateWorkOpenBinding } from "./work-open-binding.js";
import {
  assertAuthoritySubset,
  assertCanonicalDecomposition,
  assertCanonicalDelegation,
  assertCanonicalDependencySet,
  assertCanonicalEdge,
  assertCanonicalMembership,
  authorityBindingRowId,
  authorityToCeilingSet,
  decompositionRowId,
  delegationRowId,
  dependencySetRowId,
  effectiveAuthority,
  membershipDigest,
  membershipRowId,
  type AuthorityCeiling,
  type GraphAuthorityDeps,
  type MembershipFields,
} from "./graph-authority.js";
import {
  WORK_CLAIM_LEASE_TABLE,
  WORKFORCE_MESSAGE_TABLE,
  WORKFORCE_RECEIPT_TABLE,
  WORK_MESSAGE_KINDS,
  assertCanonicalClaimLease,
  assertCanonicalCollaborationBundle,
  assertCanonicalReceipt,
  assertCanonicalWorkforceMessage,
  claimExpiredError,
  claimLeaseDigest,
  claimLeaseRowId,
  claimTokenDigest,
  leaseLiveExpired,
  receiptRowId,
  safeLeaseView,
  workforceMessageDigest,
} from "./work-coordination.js";
import {
  WORK_COMPLETED_EVENT,
  WORK_COMPLETION_TABLE,
  WORK_REVIEW_ACCEPTED_EVENT,
  assertCanonicalWorkCompletion,
  canonicalChildIdsOf,
  canonicalParentIdsOf,
  childBasisDigest,
  childSetDigest,
  completionBasisDigest,
  completionDigest,
  completionRowId,
  proveCanonicalMissionCompletion,
  proveWorkItemComplete,
  rejectedCompletionBases,
} from "./work-completion.js";

export const WORK_ITEM_STATUSES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "DONE",
  "CANCELLED",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const ORG_AGENT_STATUSES = ["ACTIVE", "PAUSED", "TERMINATED"] as const;
export type OrgAgentStatus = (typeof ORG_AGENT_STATUSES)[number];

export const BUDGET_PERIODS = ["DAY", "WEEK", "MONTH"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_SCOPES = ["business", "department", "agent"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * Legal work-item transitions. DONE/CANCELLED are terminal — there is no
 * way back into execution except the governed reopen path (openWorkItem
 * from BLOCKED/READY/BACKLOG → IN_PROGRESS).
 */
const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  // DONE/REVIEW_REQUIRED on the pre-execution states are reachable ONLY
  // through the Phase-3 finalize seam (canonical child-set aggregation),
  // never through any caller-facing transition.
  BACKLOG: ["READY", "IN_PROGRESS", "BLOCKED", "CANCELLED", "DONE", "REVIEW_REQUIRED"],
  // READY→READY is the reassign/refresh path; every other self-transition
  // (e.g. IN_PROGRESS→IN_PROGRESS, a duplicate open) is illegal.
  READY: ["READY", "IN_PROGRESS", "BLOCKED", "BACKLOG", "CANCELLED", "DONE", "REVIEW_REQUIRED"],
  IN_PROGRESS: ["BLOCKED", "DONE", "CANCELLED", "REVIEW_REQUIRED"],
  // REVIEW_REQUIRED → DONE only via reviewWorkItem ACCEPT, → READY via
  // REWORK; BLOCKED/CANCELLED remain available as safety operations.
  REVIEW_REQUIRED: ["DONE", "READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED", "DONE", "REVIEW_REQUIRED"],
  DONE: [],
  CANCELLED: [],
};

/** Fail-closed marker for a row whose canonical provenance is corrupt —
 *  hard-quarantines the item out of every authority path. */
export const WORK_CORRUPT_CODE = "TERMINAL_PROVENANCE_CORRUPT";

function assertWorkItemTransition(from: string, to: WorkItemStatus): void {
  if (!(WORK_ITEM_TRANSITIONS[from as WorkItemStatus] ?? []).includes(to)) {
    throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_TRANSITION", `${from} → ${to}`);
  }
}

/** How long a work-item claim stays valid before another agent may take over. */
const CLAIM_TTL_MS = Number(process.env.PAIR_WORK_ITEM_CLAIM_MS ?? 30 * 60 * 1000);
/** Grace before a pending open intent may be reconciled — must exceed the
 *  longest legitimate in-flight open so a live open is never repaired
 *  mid-flight. */
const OPEN_RECONCILE_GRACE_MS = Number(process.env.PAIR_OPEN_RECONCILE_GRACE_MS ?? 60_000);
/** A HELD budget reservation stops counting after this long — covers the
 *  crash gap between reserve and mission create. */
const RESERVATION_TTL_MS = Number(process.env.PAIR_BUDGET_RESERVATION_MS ?? 10 * 60 * 1000);
const TERMINAL_MISSION_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** Terminal work-item statuses — no transition out exists. */
export const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(["DONE", "CANCELLED"]);
/** Context notes kept per org_agent; newest kept, oldest trimmed. */
const AGENT_CONTEXT_CAP = 30;
/** How many agent context notes are injected into a new mission goal. */
const AGENT_CONTEXT_INJECT = 5;
const COMMENT_CAP = 200;

/** (P2) Mutable work_item claim fields are observability mirrors only —
 *  never consulted as authority; kept for API/dashboard readability. */

export interface BusinessLayerDeps {
  store: PairEvidenceStore;
  control: MissionControl;
  schedules: MissionScheduleService;
}

type Row = Record<string, unknown> & { version: number };

function periodStart(period: BudgetPeriod, now: Date): string {
  if (period === "DAY") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (period === "MONTH") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
  // WEEK: ISO week starts Monday.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString();
}

export class BusinessLayer {
  private _agentContracts: AgentContractService | null = null;

  constructor(private readonly deps: BusinessLayerDeps) {
    // Routines are business-originated work: a schedule fire carrying
    // metadata.business_id must pass the same mission-count budget gate as
    // a manual open, via a durable reservation settled on outcome.
    this.deps.schedules.preflight = (input) => {
      const md = (input.metadata ?? {}) as Record<string, unknown>;
      const businessId = String(md.business_id ?? "");
      if (!businessId) return null;
      // Ref identity is the specific OCCURRENCE, not the schedule — a
      // reservation for SCHED:X must never settle SCHED:Y's accounting
      // (R4 §8). Legacy `schedule:<id>` rows are repaired/flagged by
      // MissionScheduleService.reconcileScheduleReservations.
      const refId = md.schedule_occurrence_id
        ? `schedule-occurrence:${String(md.schedule_occurrence_id)}`
        : `schedule:${String(md.schedule_id ?? "")}`;
      const rid = this.reserveBudget(
        businessId,
        String(md.department ?? ""),
        md.org_agent_id ? String(md.org_agent_id) : null,
        refId,
      );
      if (!rid) return null;
      return {
        settle: (consumed: boolean) =>
          consumed ? this.consumeBudgetReservation(rid) : this.releaseBudgetReservation(rid),
      };
    };
  }

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }

  // ---------- business ----------

  createBusiness(input: {
    name: string;
    project_id: string;
    description?: string;
    currency?: string;
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "business.create");
    if (!String(input.name ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_BUSINESS_NAME", "business name required");
    }
    const projOk = this.deps.control.projects().some((p) => String(p.project_id) === input.project_id);
    if (!projOk) {
      throw new IntegrityError("FAIL_CLOSED_BUSINESS_PROJECT", `unknown project_id: ${input.project_id}`);
    }
    const id = newId("BIZ");
    const row = {
      business_id: id,
      name: input.name,
      description: input.description ?? "",
      project_id: input.project_id,
      currency: input.currency ?? "USD",
      status: "ACTIVE",
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("business", id, row, 0);
    this.store.event({
      entity_type: "business", entity_id: id, event_type: "BUSINESS_CREATED",
      new_state: "ACTIVE", actor: `operator:${input.operator_id}`,
      metadata: { name: input.name },
    });
    return saved;
  }

  listBusinesses(): Row[] {
    return this.store.list("business").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  getBusiness(id: string): Row {
    return this.store.get("business", id);
  }

  // ---------- org_agent ----------

  createOrgAgent(input: {
    business_id: string;
    title: string;
    department: string;
    role?: string;
    reports_to?: string;
    executor_binding?: string;
    /** Declared capabilities this agent can take (work-graph admission
     *  narrows against them and the agent's execution contract). */
    capabilities?: string[];
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "org_agent.create");
    if (!String(input.title ?? "").trim() || !String(input.department ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_ORG_AGENT_FIELDS", "title and department required");
    }
    this.getBusiness(input.business_id); // fail-closed: agent needs a real business
    if (input.reports_to) {
      const mgr = this.store.get("org_agent", input.reports_to);
      if (String(mgr.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_ORG_AGENT_SCOPE", `reports_to ${input.reports_to} is outside business ${input.business_id}`);
      }
    }
    const id = newId("AGT");
    const row = {
      agent_id: id,
      business_id: input.business_id,
      title: input.title,
      department: input.department,
      role: input.role ?? "",
      reports_to: input.reports_to ?? null,
      executor_binding: input.executor_binding ?? null,
      capabilities: input.capabilities ?? [],
      status: "ACTIVE" as OrgAgentStatus,
      context_notes: [] as Array<Record<string, unknown>>,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("org_agent", id, row, 0);
    this.store.event({
      entity_type: "org_agent", entity_id: id, event_type: "ORG_AGENT_CREATED",
      new_state: "ACTIVE", actor: `operator:${input.operator_id}`,
      metadata: { business_id: input.business_id, department: input.department, title: input.title },
    });
    // P12: every new org_agent receives a baseline execution contract — an
    // agent without a contract must never mean unrestricted access.
    this.agentContracts.materialize(id, `operator:${input.operator_id}`);
    return saved;
  }

  /** P12 canonical agent-execution-contract service (same store). */
  get agentContracts(): AgentContractService {
    this._agentContracts ??= new AgentContractService(this.store);
    return this._agentContracts;
  }

  // ---------- agent execution contract (P12) ----------

  /** Read the canonical contract (null when not yet materialized). */
  getAgentContract(agentId: string): Row | null {
    return this.agentContracts.get(agentId);
  }

  /**
   * Create-or-update an agent's contract under CAS. With `policy` the
   * contract is materialized with that policy (or updated under
   * `expected_version`); without it the baseline is materialized.
   */
  upsertAgentContract(
    agentId: string,
    actor: string,
    policy?: Record<string, unknown>,
    expectedVersion?: number,
  ): Row {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "agent_contract.upsert");
    this.store.get("org_agent", agentId); // fail-closed identity check
    const existing = this.agentContracts.get(agentId);
    if (!existing) {
      return this.agentContracts.materialize(
        agentId,
        `operator:${actor}`,
        policy as Partial<AgentContractPolicy> | undefined,
      );
    }
    if (policy === undefined) return existing;
    return this.agentContracts.update(
      agentId,
      policy as Partial<AgentContractPolicy>,
      expectedVersion ?? Number(existing.version),
      `operator:${actor}`,
    );
  }

  setAgentContractStatus(agentId: string, status: AgentContractStatus, actor: string): Row {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "agent_contract.status");
    this.store.get("org_agent", agentId); // fail-closed identity check
    return this.agentContracts.setStatus(agentId, status, `operator:${actor}`);
  }

  /** Operator view: resolved contract + agent status (no secrets). */
  inspectAgentPolicy(agentId: string): Row {
    return this.agentContracts.inspect(agentId) as Row;
  }

  listOrgAgents(businessId?: string): Row[] {
    const all = this.store.list("org_agent");
    return (businessId ? all.filter((a) => String(a.business_id) === businessId) : all)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  setOrgAgentStatus(agentId: string, status: OrgAgentStatus, actor: string): Row {
    if (!ORG_AGENT_STATUSES.includes(status)) {
      throw new IntegrityError("FAIL_CLOSED_ORG_AGENT_STATUS", status);
    }
    const row = this.store.get("org_agent", agentId);
    const from = String(row.status);
    row.status = status;
    const saved = this.store.put("org_agent", agentId, row, Number(row.version));
    this.store.event({
      entity_type: "org_agent", entity_id: agentId, event_type: "ORG_AGENT_STATUS",
      old_state: from, new_state: status, actor: `operator:${actor}`,
    });
    return saved;
  }

  // ---------- work_item ----------

  createWorkItem(input: {
    business_id: string;
    title: string;
    goal: string;
    department?: string;
    assignee_agent_id?: string;
    objective_id?: string;
    priority?: number;
    source?: string;
    requires_review?: boolean;
    reviewer_agent_id?: string;
    operator_id: string;
    /* Internal work-graph fields (P14 Workforce V2 Phase 1): written only
     * by the WorkforceService graph seams (decompose/delegate) — never
     * accepted from the public work-item API handler. A row carrying
     * graph fields is authoritative ONLY when backed by the canonical
     * work_delegation / work_decomposition row (assertGraphAuthority). */
    work_item_id?: string;
    parent_work_item_id?: string;
    required_capability?: string;
    delegated_from_work_item_id?: string;
    delegated_by_agent_id?: string;
    delegation_reason?: string;
    delegation_depth?: number;
    delegation_key?: string;
    decomposition_id?: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_item.create");
    if (!String(input.title ?? "").trim() || !String(input.goal ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_FIELDS", "title and goal required");
    }
    this.getBusiness(input.business_id);
    let department = input.department ?? "";
    if (input.assignee_agent_id) {
      const agent = this.store.get("org_agent", input.assignee_agent_id);
      if (String(agent.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${input.business_id}`);
      }
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", String(agent.agent_id));
      }
      department = department || String(agent.department ?? "");
    }
    if (input.reviewer_agent_id) {
      const rev = this.store.get("org_agent", input.reviewer_agent_id);
      if (String(rev.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `reviewer outside business ${input.business_id}`);
      }
      if (String(rev.agent_id) === String(input.assignee_agent_id ?? "")) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", "reviewer cannot be the assignee");
      }
    }
    if (input.objective_id) {
      const obj = this.store.get("objective", input.objective_id);
      if (String(obj.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `objective outside business ${input.business_id}`);
      }
    }
    const id = input.work_item_id ?? newId("WI");
    const row = {
      work_item_id: id,
      business_id: input.business_id,
      title: input.title,
      goal: input.goal,
      department,
      assignee_agent_id: input.assignee_agent_id ?? null,
      objective_id: input.objective_id ?? null,
      routine_id: null as string | null,
      priority: input.priority ?? 50,
      source: input.source ?? "manual",
      required_capability: input.required_capability ?? null,
      parent_work_item_id: input.parent_work_item_id ?? null,
      decomposed_as: null,
      delegated_from_work_item_id: input.delegated_from_work_item_id ?? null,
      delegated_by_agent_id: input.delegated_by_agent_id ?? null,
      delegation_reason: input.delegation_reason ?? null,
      delegation_depth: input.delegation_depth ?? 0,
      delegation_key: input.delegation_key ?? null,
      decomposition_id: input.decomposition_id ?? null,
      requires_review: input.requires_review === true,
      reviewer_agent_id: input.reviewer_agent_id ?? null,
      blocked_code: null as string | null,
      status: (input.assignee_agent_id ? "READY" : "BACKLOG") as WorkItemStatus,
      mission_ids: [] as string[],
      claimed_by: null as string | null,
      claim_token: null as string | null,
      claim_expires_at: null as string | null,
      comments: [] as Array<Record<string, unknown>>,
      blockers: [] as Array<Record<string, unknown>>,
      artifacts: [] as Array<Record<string, unknown>>,
      result_summary: null,
      created_at: utcnow(),
      updated_at: utcnow(),
      version: 0,
    };
    // Work item + its canonical membership row commit atomically — the
    // item can never exist without its bidirectional authority record.
    return this.store.immediate(() => {
      const saved = this.store.put("work_item", id, row, 0);
      this.writeGraphMembership(saved, {
        membership_type: "STANDALONE",
        parent_work_item_id: null,
        delegation_id: null,
        decomposition_row_id: null,
        dependency_set_id: null,
        authority_binding_id: null,
      });
      this.store.event({
        entity_type: "work_item", entity_id: id, event_type: "WORK_ITEM_CREATED",
        new_state: row.status, actor: `operator:${input.operator_id}`,
        metadata: { business_id: input.business_id, title: input.title, source: row.source },
      });
      return saved;
    });
  }

  /** Write the canonical `work_graph_membership` row for a work item —
   *  create (v0) or CAS-bump in place; called only inside the mutation
   *  seams' immediate() transaction so membership can never diverge from
   *  the canonical rows it points at. */
  writeGraphMembership(item: Row, fields: MembershipFields): Row {
    const id = String(item.work_item_id);
    const business = this.getBusiness(String(item.business_id));
    const existing = this.store.tryGet(
      "work_graph_membership", membershipRowId(id)) as Row | null;
    const row = {
      membership_id: membershipRowId(id),
      work_item_id: id,
      business_id: String(item.business_id),
      project_id: String(business.project_id),
      ...fields,
      membership_digest: membershipDigest(
        id, String(item.business_id), String(business.project_id), fields),
      state: "COMMITTED",
      created_at: existing ? String(existing.created_at) : utcnow(),
      updated_at: utcnow(),
      version: existing ? Number(existing.version) : 0,
    };
    return this.store.put(
      "work_graph_membership", membershipRowId(id), row,
      existing ? Number(existing.version) : 0);
  }

  // ---------- canonical provenance (Foundation V2) ----------
  //
  // `work_open_binding` is the durable canonical authority record the
  // business layer creates BEFORE the mission it pins exists. It
  // authoritatively binds open_id / work_item_id / business_id /
  // project_id / org_agent / created_by / lifecycle state / reserved
  // mission_id / CAS version. Mission metadata may MIRROR these values
  // for observability, but proof derives only from the binding — caller
  // or model supplied metadata can never itself constitute authority.

  /** Is mission `m` canonically bound to work item `row`? Proof requires
   *  the mission to carry the internal origin proof `bound_open_id`
   *  (writable only by the internal bound-mission seam — never settable
   *  from caller metadata) whose BOUND `work_open_binding` validates the
   *  FULL canonical chain: reserved mission_id, work item, business,
   *  business.project, binding project, mission project, assignee and
   *  org-agent scope (V2 R1 §5). */
  missionBoundToWorkItem(row: Row, m: Row): boolean {
    const mids = (row.mission_ids as string[] | undefined) ?? [];
    if (!mids.includes(String(m.mission_id))) return false;
    const openId = String(m.bound_open_id ?? "");
    if (!openId) return false; // no internal origin proof → not bound
    const binding = this.store.tryGet("work_open_binding", openId) as Row | null;
    if (!binding) return false;
    return validateWorkOpenBinding(this.store, binding, {
      forWorkItem: row,
      forMission: m,
      requireState: "BOUND",
      // PROVENANCE: a mission validly bound earlier stays bound even if
      // its agent is PAUSED/TERMINATED later (R3 §3).
      mode: "PROVENANCE",
    }).ok;
  }

  /** The row's last mission when it is canonically bound, else null. */
  boundMissionForWorkItem(row: Row): Row | null {
    const mids = (row.mission_ids as string[] | undefined) ?? [];
    if (!mids.length) return null;
    const m = this.store.tryGet("mission", String(mids[mids.length - 1]));
    return m && this.missionBoundToWorkItem(row, m) ? m : null;
  }

  /** Is this row's DONE canonically proven? Status alone NEVER counts —
   *  P3: proof requires a fully validated `work_completion` record
   *  (bound COMPLETED mission pin and/or canonical child-set pin,
   *  review evidence pin, immutable anchor event). A forged DONE, a
   *  tampered digest, a missing anchor, a foreign child — all fail. */
  proveWorkItemDone(row: Row): boolean {
    return proveWorkItemComplete(this.graphAuthorityDeps(), row);
  }

  /** Read-only completion view for API seams — the row itself plus its
   *  canonical completion record when it exists (validated or not — the
   *  proof bit is always recomputed, never trusted from state). */
  workCompletionFor(workItemId: string): {
    work_item: Row;
    canonically_complete: boolean;
    completion: Row | null;
  } {
    const w = this.store.get("work_item", workItemId);
    return {
      work_item: w,
      canonically_complete: this.proveWorkItemDone(w),
      completion: this.store.tryGet(
        WORK_COMPLETION_TABLE, completionRowId(workItemId)) as Row | null,
    };
  }

  // ---------- P14 Workforce V2 Phase 3 — completion lifecycle ----------

  /**
   * Completion basis for `row`: which canonical requirements are met.
   *  - missionDone: null = no bound mission (container); true = bound
   *    mission CANONICALLY COMPLETED (transition + runtime + task
   *    evidence — a bare COMPLETED status is a forgery, not a basis);
   *    false = pending/failed/unbound/unproven.
   *  - childIds: the canonical child set (WDEC ∪ WDEL), sorted; empty
   *    for a leaf.
   *  - childrenDone: every canonical child has a valid WCP.
   *  - ready: leaf → missionDone; container → childrenDone && children
   *    exist; mixed → missionDone && childrenDone.
   *  - basisDigest: identity of the authority a review decision would
   *    be made against (bound mission attempt + each canonical child's
   *    current completion-record digest).
   *  - rejected: this exact basis was already rejected by a REWORK —
   *    it may never ground REVIEW_REQUIRED/DONE again; authority must
   *    advance to a different basis first.
   * Throws (corrupt canonical child rows) — callers decide quarantine.
   */
  private completionBasis(row: Row): {
    ready: boolean;
    mission: Row | null;
    childIds: string[];
    basisDigest: string;
    rejected: boolean;
  } {
    const deps = this.graphAuthorityDeps();
    const wid = String(row.work_item_id);
    const childIds = canonicalChildIdsOf(deps, wid);
    let childrenDone = true;
    for (const cid of childIds) {
      const child = this.store.tryGet("work_item", cid) as Row | null;
      if (!child || !proveWorkItemComplete(deps, child)) childrenDone = false;
    }
    const mission = this.boundMissionForWorkItem(row);
    const missionDone = mission === null
      ? null : proveCanonicalMissionCompletion(this.store, mission);
    const basisDigest = completionBasisDigest({
      mission_id: mission ? String(mission.mission_id) : null,
      bound_open_id:
        mission ? String(mission.bound_open_id ?? "") || null : null,
      child_basis_digest: childBasisDigest(this.store, childIds),
    });
    const rejected = rejectedCompletionBases(this.store, wid).has(basisDigest);
    const ready = childrenDone &&
      (missionDone === true || (missionDone === null && childIds.length > 0));
    return { ready, mission, childIds, basisDigest, rejected };
  }

  /** Basis that never throws — corrupt child rows evaluate unready. */
  private completionBasisSafe(row: Row): ReturnType<BusinessLayer["completionBasis"]> {
    try {
      return this.completionBasis(row);
    } catch {
      return {
        ready: false, mission: null, childIds: [],
        basisDigest: "", rejected: false,
      };
    }
  }

  /**
   * Write the canonical `work_completion` record + its immutable
   * `WORK_ITEM_COMPLETED` anchor inside the caller's immediate() txn.
   * Idempotent: an existing WCP must pass the full validator to be
   * adopted; a conflicting row fails closed.
   */
  private writeCompletionRecord(
    item: Row,
    pins: {
      mission_id: string | null;
      bound_open_id: string | null;
      child_work_item_ids: string[];
      reviewer_agent_id: string | null;
    },
    actor: string,
  ): Row {
    const wid = String(item.work_item_id);
    const cid = completionRowId(wid);
    const existing = this.store.tryGet(WORK_COMPLETION_TABLE, cid) as Row | null;
    if (existing) {
      // Replay/adopt only when the existing record is fully canonical.
      assertCanonicalWorkCompletion(this.graphAuthorityDeps(), existing);
      return existing;
    }
    const childIds = [...pins.child_work_item_ids].sort();
    const fields = {
      completion_id: cid,
      work_item_id: wid,
      business_id: String(item.business_id),
      mission_id: pins.mission_id,
      bound_open_id: pins.bound_open_id,
      child_work_item_ids: childIds,
      reviewer_agent_id: pins.reviewer_agent_id,
    };
    const body = {
      ...fields,
      project_id: String(this.getBusiness(String(item.business_id)).project_id),
      child_set_digest: childSetDigest(childIds),
      completion_digest: completionDigest(fields),
      state: "COMMITTED",
      created_by: actor,
      created_at: utcnow(),
      version: 0,
    } as unknown as Row;
    this.store.put(WORK_COMPLETION_TABLE, cid, body, 0);
    // Immutable anchor — pins every completion authority field so a
    // later row mutation / digest rehash / forged replay still fails.
    // The event log is append-only: a re-materialized row (restart /
    // reconcile after row loss) must adopt an identical surviving
    // anchor rather than emit a second one — the canonical validator
    // requires exactly one.
    const anchors = this.store.listEvents(WORK_COMPLETION_TABLE, cid)
      .filter((e) => String(e.event_type) === WORK_COMPLETED_EVENT);
    let anchored = false;
    for (const e of anchors) {
      const amd = (e.metadata ?? {}) as Record<string, unknown>;
      if (
        String(amd.work_item_id ?? "") === wid
        && String(amd.completion_digest ?? "") === String(body.completion_digest)
        && String(amd.mission_id ?? "") === String(pins.mission_id ?? "")
        && String(amd.bound_open_id ?? "") === String(pins.bound_open_id ?? "")
        && String(amd.child_set_digest ?? "") === String(body.child_set_digest)
        && String(amd.reviewer_agent_id ?? "") === String(pins.reviewer_agent_id ?? "")
      ) anchored = true;
    }
    if (!anchored) {
      this.store.event({
        entity_type: WORK_COMPLETION_TABLE, entity_id: cid,
        event_type: WORK_COMPLETED_EVENT, actor,
        metadata: {
          work_item_id: wid,
          mission_id: pins.mission_id,
          bound_open_id: pins.bound_open_id,
          child_set_digest: String(body.child_set_digest),
          reviewer_agent_id: pins.reviewer_agent_id,
          completion_digest: String(body.completion_digest),
        },
      });
    }
    // Self-validate when the record is complete on its own; a
    // reviewer-pinned WCP also requires the WORK_REVIEW_ACCEPTED event
    // the caller is about to append — it validates after that event.
    if (pins.reviewer_agent_id === null) {
      assertCanonicalWorkCompletion(this.graphAuthorityDeps(), body);
    }
    return body;
  }

  /**
   * The single canonical finalization seam. Called inside a caller's
   * immediate() txn with the row already re-read in-txn. Requires the
   * completion basis to be ready and non-review (review items finalize
   * only through reviewWorkItem ACCEPT). Writes WCP + anchor + DONE +
   * lease release atomically; idempotent across finalize/reconcile
   * replay — a second caller sees the existing WCP and stands down.
   */
  private finalizeWorkItemInTxn(cur: Row, actor: string): Row | null {
    const wid = String(cur.work_item_id);
    if (TERMINAL_WORK_ITEM_STATUSES.has(String(cur.status))) return cur;
    if (String(cur.blocked_code ?? "") === WORK_CORRUPT_CODE) return null;
    const existing = this.store.tryGet(
      WORK_COMPLETION_TABLE, completionRowId(wid)) as Row | null;
    if (existing) {
      assertCanonicalWorkCompletion(this.graphAuthorityDeps(), existing);
      return cur;
    }
    const basis = this.completionBasis(cur);
    if (!basis.ready || basis.rejected) return null;
    if (cur.requires_review === true) return null; // review gates finality
    assertWorkItemTransition(String(cur.status), "DONE");
    const from = String(cur.status);
    const mission = basis.mission;
    const lease = this.store.tryGet(
      WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(wid)) as Row | null;
    if (lease && String(lease.state) === "ACTIVE") {
      this.transitionLease(lease, "RELEASED", actor, { work_item_id: wid });
    }
    cur.status = "DONE";
    cur.claimed_by = null;
    cur.claim_token = null;
    cur.claim_expires_at = null;
    if (mission) {
      cur.result_summary = String(mission.result ?? mission.result_summary ?? "") || null;
    }
    cur.updated_at = utcnow();
    // The DONE row lands before the WCP so the completion validator
    // sees the final state inside this same txn.
    const saved = this.store.put("work_item", wid, cur, Number(cur.version));
    this.writeCompletionRecord(saved, {
      mission_id: mission ? String(mission.mission_id) : null,
      bound_open_id: mission ? String(mission.bound_open_id ?? "") || null : null,
      child_work_item_ids: basis.childIds,
      reviewer_agent_id: null,
    }, actor);
    this.store.event({
      entity_type: "work_item", entity_id: wid, event_type: "WORK_ITEM_SYNCED",
      old_state: from, new_state: "DONE", actor,
      metadata: { finalized: true },
    });
    return saved;
  }

  /**
   * Public finalization seam — used by the cascade and by reconcile.
   * Whole decision re-derived inside one immediate(): idempotent, CAS
   * serialized, single canonical winner across concurrent finalizers.
   */
  finalizeWorkItem(workItemId: string, actor: string): Row {
    return this.store.immediate(() => {
      const cur = this.store.get("work_item", workItemId);
      const done = this.finalizeWorkItemInTxn(cur, actor);
      if (done && String(done.status) === "DONE") return done;
      return cur;
    });
  }

  /**
   * Parent aggregation (P3 §7-8): a parent completes only when every
   * canonical child (WDEC ∪ WDEL — never mutable arrays) has a valid
   * WCP AND the parent's own bound mission (when it executed) is
   * COMPLETED. A ready non-review parent finalizes atomically (DONE +
   * WCP + anchor); a review-required parent projects REVIEW_REQUIRED
   * and awaits a canonical ACCEPT.
   */
  evaluateParentCompletion(parentId: string, actor: string): boolean {
    const parent = this.store.tryGet("work_item", parentId) as Row | null;
    if (!parent) return false;
    if (TERMINAL_WORK_ITEM_STATUSES.has(String(parent.status))) return true;
    if (String(parent.blocked_code ?? "") === WORK_CORRUPT_CODE) return false;
    if (this.store.tryGet(WORK_COMPLETION_TABLE, completionRowId(parentId))) return true;
    const basis = this.completionBasisSafe(parent);
    // A rejected basis is exhausted authority: the parent may re-enter
    // REVIEW_REQUIRED only after the canonical child set / bound attempt
    // has advanced to a digest different from the rejected one.
    if (!basis.ready || basis.rejected || basis.childIds.length === 0) return false;
    if (parent.requires_review === true) {
      if (String(parent.status) === "REVIEW_REQUIRED") return false;
      // Project the review gate — no WCP until a canonical ACCEPT lands.
      this.store.immediate(() => {
        const cur = this.store.get("work_item", parentId);
        if (String(cur.status) === "REVIEW_REQUIRED" ||
            TERMINAL_WORK_ITEM_STATUSES.has(String(cur.status))) return;
        assertWorkItemTransition(String(cur.status), "REVIEW_REQUIRED");
        const from = String(cur.status);
        cur.status = "REVIEW_REQUIRED";
        cur.updated_at = utcnow();
        this.store.put("work_item", parentId, cur, Number(cur.version));
        this.store.event({
          entity_type: "work_item", entity_id: parentId,
          event_type: "WORK_ITEM_SYNCED", old_state: from,
          new_state: "REVIEW_REQUIRED", actor,
          metadata: { review_basis: "canonical_children_complete" },
        });
      });
      return false;
    }
    const done = this.finalizeWorkItem(parentId, actor);
    return String(done.status) === "DONE";
  }

  /**
   * Completion cascade (P3 §8): walk canonical parents upward — each
   * parent re-derives its own basis inside its own immediate() txn, so
   * propagation is deterministic, idempotent, crash-safe and bounded
   * to the acyclic canonical graph (visited-set + depth-bounded queue).
   */
  advanceCompletionCascade(workItemId: string, actor = "PAIR_WORKFORCE_CASCADE"): void {
    const deps = this.graphAuthorityDeps();
    const seen = new Set<string>([workItemId]);
    const queue: string[] = [workItemId];
    while (queue.length) {
      const wid = queue.shift()!;
      let parents: string[] = [];
      try {
        parents = canonicalParentIdsOf(deps, wid);
      } catch {
        continue; // corrupt graph rows — reconcile quarantines
      }
      for (const pid of parents) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        let progressed = false;
        try {
          progressed = this.evaluateParentCompletion(pid, actor);
        } catch {
          continue;
        }
        if (progressed) queue.push(pid);
      }
    }
  }

  /**
   * Restart-safe lifecycle reconcile (P3 §10/§15): continues exactly the
   * lifecycle work already authorized — nothing fabricated.
   *  - every WCP row is re-validated; a malformed one quarantines its item
   *  - IN_PROGRESS items fold a terminal bound mission (syncWorkItem)
   *  - parents re-evaluate canonical aggregation (resumes interrupted
   *    cascades exactly once — WCP dedupe)
   *  - REVIEW_REQUIRED ungrounded → quarantine (fabricated state)
   *  - DONE without WCP: materialize the authorized derived record when
   *    the basis + (review) evidence fully prove it; else quarantine —
   *    a status-only DONE is forged completion.
   */
  reconcileWorkLifecycle(): void {
    const deps = this.graphAuthorityDeps();
    // 1. canonical completion rows validate; corrupt → quarantine owner
    for (const wcp of this.store.list(WORK_COMPLETION_TABLE)) {
      try {
        assertCanonicalWorkCompletion(deps, wcp as Row);
      } catch {
        const w = this.store.tryGet(
          "work_item", String(wcp.work_item_id ?? "")) as Row | null;
        if (w) this.quarantineWorkItem(w, "work_completion row malformed");
      }
    }
    // 2. fold pending IN_PROGRESS items (materializes authorized
    //    completion projections: DONE+WCP or REVIEW_REQUIRED)
    for (const w of this.store.list("work_item")) {
      if (String(w.status) !== "IN_PROGRESS") continue;
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      try {
        this.syncWorkItem(String(w.work_item_id));
      } catch { /* next sweep retries — never forced */ }
    }
    // 3. resume interrupted parent aggregation/cascade
    for (const w of this.store.list("work_item")) {
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(w.status))) continue;
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      let childIds: string[] = [];
      try {
        childIds = canonicalChildIdsOf(deps, String(w.work_item_id));
      } catch {
        this.quarantineForReconcile(w as Row, "canonical child set corrupt");
        continue;
      }
      if (!childIds.length) continue;
      try {
        this.evaluateParentCompletion(String(w.work_item_id), "PAIR_RECONCILE");
      } catch { /* stays pending — next reconcile retries */ }
    }
    // 4. fabricated REVIEW_REQUIRED quarantines; DONE without canonical
    //    completion is either materialized (provable) or quarantined.
    for (const w of this.store.list("work_item") as Row[]) {
      if (String(w.blocked_code ?? "") === WORK_CORRUPT_CODE) continue;
      const wid = String(w.work_item_id);
      if (String(w.status) === "REVIEW_REQUIRED") {
        const basis = this.completionBasisSafe(w);
        if (!basis.ready || basis.rejected) {
          this.quarantineWorkItem(
            w, basis.rejected
              ? "REVIEW_REQUIRED re-entered on rejected basis"
              : "ungrounded REVIEW_REQUIRED");
          continue;
        }
        // Crash boundary C: a canonical ACCEPT committed its evidence
        // but the DONE projection (and WCP) never landed. Rebuild the
        // candidate record and materialize ONLY when an ACCEPT event
        // pins this exact digest — nothing is fabricated.
        const mission = basis.mission;
        for (const e of this.store.listEvents("work_item", wid)) {
          if (String(e.event_type) !== WORK_REVIEW_ACCEPTED_EVENT ||
              String(e.old_state ?? "") !== "REVIEW_REQUIRED" ||
              String(e.new_state ?? "") !== "DONE") continue;
          const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
          const fields = {
            completion_id: completionRowId(wid),
            work_item_id: wid,
            business_id: String(w.business_id),
            mission_id: mission ? String(mission.mission_id) : null,
            bound_open_id:
              mission ? String(mission.bound_open_id ?? "") || null : null,
            child_work_item_ids: basis.childIds,
            reviewer_agent_id: md.reviewer_agent_id
              ? String(md.reviewer_agent_id) : null,
          };
          if (fields.reviewer_agent_id === null) continue;
          if (String(md.mission_id ?? "") !== String(fields.mission_id ?? "") ||
              String(md.bound_open_id ?? "") !== String(fields.bound_open_id ?? "") ||
              String(md.child_set_digest ?? "") !== childSetDigest(basis.childIds) ||
              String(md.completion_digest ?? "") !== completionDigest(fields)) {
            continue;
          }
          // The event authorizes this exact record — materialize it
          // plus the DONE projection; validate inside the txn so a
          // mismatched anchor aborts instead of persisting a bad row.
          try {
            this.store.immediate(() => {
              const cur = this.store.get("work_item", wid);
              if (String(cur.status) !== "REVIEW_REQUIRED") return;
              cur.status = "DONE";
              cur.updated_at = utcnow();
              const savedRow = this.store.put(
                "work_item", wid, cur, Number(cur.version));
              const wcp = this.writeCompletionRecord(
                savedRow, fields, "PAIR_RECONCILE");
              assertCanonicalWorkCompletion(this.graphAuthorityDeps(), wcp);
            });
          } catch {
            this.quarantineWorkItem(
              w, "interrupted review-accept projection failed materialization");
          }
          break;
        }
        continue;
      }
      if (String(w.status) !== "DONE") continue;
      if (this.store.tryGet(WORK_COMPLETION_TABLE, completionRowId(wid))) continue;
      // Derive-only materialization: every pin must already exist as
      // canonical evidence — nothing is invented.
      const basis = this.completionBasisSafe(w);
      const mission = basis.mission;
      const missionOk = mission !== null &&
        proveCanonicalMissionCompletion(this.store, mission);
      if (!basis.ready || basis.rejected ||
          (!missionOk && basis.childIds.length === 0)) {
        this.quarantineWorkItem(w, basis.rejected
          ? "DONE materialization on rejected basis"
          : "DONE without canonical completion basis");
        continue;
      }
      const fields = {
        completion_id: completionRowId(wid),
        work_item_id: wid,
        business_id: String(w.business_id),
        mission_id: mission ? String(mission.mission_id) : null,
        bound_open_id: mission ? String(mission.bound_open_id ?? "") || null : null,
        child_work_item_ids: basis.childIds,
        reviewer_agent_id: null as string | null,
      };
      if (w.requires_review === true) {
        // The ACCEPT event must pin this exact completion digest — an
        // ACCEPT for different authority cannot validate this record.
        const accepts = this.store.listEvents("work_item", wid).filter((e) => {
          if (String(e.event_type) !== WORK_REVIEW_ACCEPTED_EVENT ||
              String(e.old_state ?? "") !== "REVIEW_REQUIRED" ||
              String(e.new_state ?? "") !== "DONE") return false;
          const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
          return String(md.mission_id ?? "") === String(fields.mission_id ?? "") &&
            String(md.bound_open_id ?? "") === String(fields.bound_open_id ?? "") &&
            String(md.child_set_digest ?? "") === childSetDigest(basis.childIds) &&
            String(md.reviewer_agent_id ?? "") !== "";
        });
        let reviewer: string | null = null;
        for (const e of accepts) {
          const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
          fields.reviewer_agent_id = String(md.reviewer_agent_id);
          if (String(md.completion_digest ?? "") === completionDigest(fields)) {
            reviewer = String(md.reviewer_agent_id);
            break;
          }
        }
        fields.reviewer_agent_id = reviewer;
        if (reviewer === null) {
          this.quarantineWorkItem(w, "DONE without canonical review acceptance");
          continue;
        }
      }
      try {
        this.store.immediate(() => {
          const cur = this.store.get("work_item", wid);
          if (this.store.tryGet(WORK_COMPLETION_TABLE, completionRowId(wid))) return;
          const wcp = this.writeCompletionRecord(cur, fields, "PAIR_RECONCILE");
          assertCanonicalWorkCompletion(this.graphAuthorityDeps(), wcp);
        });
      } catch {
        this.quarantineWorkItem(
          w, "interrupted completion projection failed materialization");
      }
    }
  }

  /** Quarantine a row live — corrupt rows are non-executable and
   *  non-progressable until explicit governed repair. Idempotent. */
  private quarantineWorkItem(row: Row, detail: string): void {
    const id = String(row.work_item_id);
    const marked = this.store.listEvents().some((e) =>
      e.event_type === "WORK_PROVENANCE_INCONSISTENT" && String(e.entity_id) === id);
    if (!marked) {
      this.store.event({
        entity_type: "work_item", entity_id: id, event_type: "WORK_PROVENANCE_INCONSISTENT",
        old_state: String(row.status), new_state: String(row.status), actor: "PAIR_RECONCILE",
        metadata: { cause: "ungrounded_provenance", detail },
      });
    }
    if (String(row.blocked_code ?? "") !== WORK_CORRUPT_CODE) {
      row.blocked_code = WORK_CORRUPT_CODE;
      row.updated_at = utcnow();
      this.store.put("work_item", id, row, Number(row.version));
    }
  }

  /** Centralized hard-quarantine guard for every authority-bearing path. */
  assertWorkItemNotQuarantined(row: Row): void {
    if (String(row.blocked_code ?? "") === WORK_CORRUPT_CODE) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_PROVENANCE_CORRUPT",
        `work item ${String(row.work_item_id)} quarantined — canonical provenance corrupt`,
      );
    }
  }

  // ---------- work graph authority (P14 Workforce V2 Phase 1) ----------
  //
  // Graph relationships are canonical durable rows: `work_graph_edge`
  // (dependency), `work_delegation` (delegation provenance) and
  // `work_decomposition` (committed child set) entities written only by
  // the WorkforceService seams inside a single immediate() transaction.
  // Graph fields mirrored on a work_item row are observability — they
  // prove nothing without the matching canonical row. A row asserting
  // graph membership without that backing is forged → quarantined.

  /** Canonical ACTIVE `work_graph_edge` rows pointing at this node's
   *  prerequisites (dependent_work_item_id === this row). Revoked edges
   *  never gate. */
  dependencyEdgesOf(workItemId: string): Row[] {
    return this.store.list("work_graph_edge").filter((e) =>
      String(e.dependent_work_item_id) === String(workItemId) &&
      String(e.state ?? "ACTIVE") === "ACTIVE");
  }

  /** Does the row carry work-graph provenance fields at all? */
  hasGraphFields(row: Row): boolean {
    return Boolean(
      row.parent_work_item_id || row.delegated_from_work_item_id ||
      row.delegated_by_agent_id || row.delegation_key ||
      row.decomposition_id || row.decomposed_as ||
      Number(row.delegation_depth ?? 0) > 0,
    );
  }

  /**
   * Graph-field authority check: every graph membership claimed on the
   * row must be backed by its canonical row.
   *  - delegated_from_work_item_id ⇒ `work_delegation` WDEL_<child> with
   *    matching parent / from / to / key / business;
   *  - decomposition_id ⇒ `work_decomposition` WDEC_<parent> listing this
   *    row under the same decomposition_id / business;
   *  - a bare parent_work_item_id with neither → forged.
   * Violations quarantine the row and fail closed — a forged row never
   * executes.
   */
  /** Canonical graph-authority validator context — shared deps for the
   *  full-chain validators (work graph + contract service for authority
   *  ceilings). */
  private graphAuthorityDeps(): GraphAuthorityDeps {
    return {
      store: this.store,
      getBusiness: (b: string) => this.getBusiness(b),
      agentContracts: this.agentContracts,
    };
  }

  assertGraphAuthority(row: Row): void {
    const id = String(row.work_item_id);
    const deps = this.graphAuthorityDeps();
    const corrupt = (reason: string): never => {
      this.quarantineWorkItem(row, reason);
      throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", `${reason} on ${id}`);
    };
    // Rebaseline — bidirectional authority via `work_graph_membership`.
    // Direction 1 (item → canonical): an item carrying graph mirror
    // markers must be backed by a governed membership type that itself
    // re-proves the WDEL/WDEC/WDS/WAB chain. Direction 2 (canonical →
    // item): committed graph rows must be matched by membership — an
    // item can never degrade to "standalone" because its mutable mirror
    // fields were deleted or altered.
    const membership = this.store.tryGet(
      "work_graph_membership", membershipRowId(id)) as Row | null;
    if (membership) {
      try {
        assertCanonicalMembership(deps, membership);
      } catch (err) {
        corrupt(`membership invalid: ${(err as Error).message}`);
      }
    } else {
      const claimsGraph = Boolean(
        row.delegated_from_work_item_id || row.delegated_by_agent_id ||
        row.delegation_key || row.decomposition_id ||
        row.parent_work_item_id || row.decomposed_as);
      if (claimsGraph) {
        corrupt("item claims graph provenance without canonical membership");
      }
      const canonicalRowsExist =
        this.store.tryGet("work_delegation", delegationRowId(id)) !== null ||
        this.store.tryGet("work_decomposition", decompositionRowId(id)) !== null ||
        this.store.list("work_delegation").some((d) =>
          String(d.parent_work_item_id) === id && String(d.state) === "COMMITTED") ||
        this.store.list("work_decomposition").some((d) =>
          ((d.child_work_item_ids as string[] | undefined) ?? []).includes(id));
      if (canonicalRowsExist) {
        corrupt("canonical graph rows govern item without membership");
      }
    }
    // Dependency edges claiming this node as dependent must each be
    // canonical — a malformed WGE row (even REVOKED) quarantines its
    // dependent; it can never be silently revived.
    for (const e of this.store.list("work_graph_edge")) {
      if (String(e.dependent_work_item_id) !== id) continue;
      try {
        assertCanonicalEdge(deps, e as Row);
      } catch (err) {
        corrupt(`dependency edge invalid: ${(err as Error).message}`);
      }
    }
    // R2 §1/§2 — dependency authority is manifest-driven: the canonical
    // `work_dependency_set` WDS_<id> is the omission-safe proof of this
    // node's dependency set. "No matching WGE rows" NEVER proves "no
    // dependencies" — only the manifest does.
    const wds = this.store.tryGet("work_dependency_set", dependencySetRowId(id)) as Row | null;
    if (wds) {
      try {
        assertCanonicalDependencySet(deps, wds);
      } catch (err) {
        corrupt(`dependency-set manifest invalid: ${(err as Error).message}`);
      }
    } else {
      const claimsEdge = this.store.list("work_graph_edge")
        .some((e) => String(e.dependent_work_item_id) === id);
      if (claimsEdge) {
        corrupt("dependency edges without canonical dependency-set manifest");
      }
      // Canonically-governed children (delegation/decomposition) always
      // carry a manifest — its absence is corrupt, never rebuilt from
      // mutable live fields (R2 §8).
      if (row.delegated_from_work_item_id || row.decomposition_id) {
        corrupt("governed child missing canonical dependency-set manifest");
      }
    }
  }

  /**
   * Quarantine entry for canonical-row validation failures discovered by
   * `WorkforceService.reconcileWorkGraph` (the work item the malformed
   * canonical row would have authorized).
   */
  quarantineForReconcile(row: Row, reason: string): void {
    this.quarantineWorkItem(row, reason);
  }

  /**
   * Dependency gate (WFV2 §7): every canonical `work_graph_edge`
   * prerequisite of this row must be proven DONE — bound mission
   * COMPLETED (+ review acceptance when required), never status alone.
   * A forged DONE (status flipped without mission evidence) or a
   * quarantined dependency fails closed.
   */
  assertDependenciesSatisfied(row: Row): void {
    const id = String(row.work_item_id);
    // R2 §2 — the dependency set to satisfy comes from the canonical
    // manifest, not a WGE scan. A missing manifest with live edge rows
    // is corrupt (quarantine); a missing manifest on a governed child is
    // corrupt; a manifest proves the complete set — including empty.
    const wds = this.store.tryGet("work_dependency_set", dependencySetRowId(id)) as Row | null;
    let depIds: string[] = [];
    if (wds) {
      try {
        assertCanonicalDependencySet(this.graphAuthorityDeps(), wds);
      } catch (err) {
        this.quarantineWorkItem(row, `dependency-set manifest invalid: ${(err as Error).message}`);
        throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", `manifest corrupt on ${id}`);
      }
      depIds = wds.dependency_work_item_ids as string[];
    } else {
      const hasEdges = this.store.list("work_graph_edge")
        .some((e) => String(e.dependent_work_item_id) === id);
      if (hasEdges || row.delegated_from_work_item_id || row.decomposition_id) {
        this.quarantineWorkItem(row, "missing canonical dependency-set manifest");
        throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", `manifest missing on ${id}`);
      }
    }
    for (const depId of depIds) {
      const dep = this.store.tryGet("work_item", String(depId));
      const done = dep !== null &&
        String(dep.blocked_code ?? "") !== WORK_CORRUPT_CODE &&
        this.proveWorkItemDone(dep);
      if (!done) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_DEPENDENCY_UNMET",
          `dependency ${String(depId)} of ${id} not proven DONE`,
        );
      }
    }
  }

  /**
   * R2 §4 — open-time authority-ceiling enforcement for graph-governed
   * children: the child's CURRENT P12 authority must remain a subset of
   * the ceiling persisted at delegation/decomposition commit AND of the
   * CURRENT parent ceiling agent's authority (later revocations narrow,
   * never broaden). A contract widened after commit fails closed BEFORE
   * any mission is created. The child's own contract must also be
   * currently executable — a DISABLED contract is never usable authority
   * (R2 §5); provenance rows may stay historically valid, admission uses
   * the live one.
   */
  private assertChildAuthorityCeiling(row: Row): void {
    const childAgentId = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    if (!childAgentId) return; // unassigned rows pin no contract authority
    const business = this.getBusiness(String(row.business_id));
    // Current executability: agent ACTIVE, contract ACTIVE+integrity,
    // business/project scope — DISABLED fails closed here.
    this.agentContracts.assertExecutable(childAgentId, {
      businessId: String(row.business_id),
      projectId: String(business.project_id),
      actor: "PAIR_GRAPH_OPEN",
    });
    const deps = this.graphAuthorityDeps();
    const childAuth = effectiveAuthority(deps, childAgentId);
    const checkAgainst = (
      ceiling: AuthorityCeiling | null | undefined,
      what: string,
    ) => {
      if (!ceiling) return;
      assertAuthoritySubset(childAuth, authorityToCeilingSet(ceiling), what);
    };
    // R3 §3 — the parent authority identity comes from the PERSISTED
    // graph authority (WDEL.authority_ceiling_agent /
    // WDEC.proposal.authority_ceiling_agent), never re-discovered from
    // the mutable parent.assignee_agent_id. That exact agent must be
    // executable CURRENTLY (PAUSED/TERMINATED agent or DISABLED contract
    // fails closed before any binding/mission) and the child's current
    // authority must remain inside its CURRENT authority — a narrowed
    // ceiling narrows the child, a widened one cannot retro-expand past
    // the persisted snapshot.
    const currentCeilingNarrowing = (
      ceilingAgent: string | null | undefined,
      what: string,
    ) => {
      if (!ceilingAgent) return;
      this.agentContracts.assertExecutable(ceilingAgent, {
        businessId: String(row.business_id),
        projectId: String(business.project_id),
        actor: "PAIR_GRAPH_OPEN",
      });
      assertAuthoritySubset(childAuth, effectiveAuthority(deps, ceilingAgent), what);
    };
    if (row.delegated_from_work_item_id || row.decomposition_id) {
      // Rebaseline — the persisted ceiling comes from the canonical
      // `work_authority_binding` (anchored to P12 revision evidence),
      // never re-discovered from mutable parent fields. Membership
      // validation already proved binding ↔ provenance equality.
      const binding = this.store.tryGet(
        "work_authority_binding",
        authorityBindingRowId(String(row.work_item_id))) as Row | null;
      checkAgainst(
        binding?.authority_snapshot as AuthorityCeiling | null | undefined,
        `governed child ${String(row.work_item_id)}`);
      currentCeilingNarrowing(
        binding ? String(binding.ceiling_agent_id) : null,
        `governed child ${String(row.work_item_id)} vs current ceiling authority`);
    }
  }

  listWorkItems(businessId?: string): Row[] {
    const all = this.store.list("work_item");
    return (businessId ? all.filter((w) => String(w.business_id) === businessId) : all)
      .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  assignWorkItem(workItemId: string, agentId: string, actor: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    this.assertWorkItemNotQuarantined(row);
    // R3 §1 — canonical graph participation must hold before any
    // assignment decision; a malformed row quarantines rather than being
    // silently reassigned over.
    this.assertGraphAuthority(row);
    // Once committed graph authority binds an assignee/ceiling identity,
    // generic assignment can never rewrite it (Phase 1 has no graph
    // revisioning): delegated children (WDEL binds delegated_to),
    // decomposition children (WDEC proposal binds the spec), and any
    // parent captured as a committed ceiling source.
    if (String(row.assignee_agent_id ?? "") !== agentId) {
      // Canonical membership decides graph-binding — never mutable mirror
      // fields (rebaseline §1/§2): anything but STANDALONE participation
      // means committed graph authority pinned the assignee/ceiling.
      const membership = this.store.tryGet(
        "work_graph_membership", membershipRowId(workItemId)) as Row | null;
      const graphBound =
        membership !== null && String(membership.membership_type) !== "STANDALONE";
      if (graphBound) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE",
          `graph-bound assignee on ${workItemId} — committed delegation/decomposition authority`,
        );
      }
    }
    const agent = this.store.get("org_agent", agentId);
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${row.business_id}`);
    }
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    const from = String(row.status);
    assertWorkItemTransition(from, "READY");
    // P2 R1 §2 — ONE canonical assignment transaction: the work item,
    //  the assignee-immutability rule, the agent, the transition and the
    //  live-lease gate are all re-proved on current rows inside this
    //  immediate() and the assignment CAS is committed together — no
    //  interleaving can produce ACTIVE WCL(A) with assignee B.
    return this.store.immediate(() => {
      const cur = this.store.get("work_item", workItemId);
      this.assertWorkItemNotQuarantined(cur);
      this.assertGraphAuthority(cur);
      if (String(cur.assignee_agent_id ?? "") !== agentId) {
        const membership = this.store.tryGet(
          "work_graph_membership", membershipRowId(workItemId)) as Row | null;
        const graphBound =
          membership !== null && String(membership.membership_type) !== "STANDALONE";
        if (graphBound) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE",
            `graph-bound assignee on ${workItemId} — committed delegation/decomposition authority`,
          );
        }
      }
      const curAgent = this.store.get("org_agent", agentId);
      if (String(curAgent.business_id) !== String(cur.business_id)) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${String(cur.business_id)}`);
      }
      if (String(curAgent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
      }
      const curFrom = String(cur.status);
      assertWorkItemTransition(curFrom, "READY");
      this.leaseGateInTxn(cur, agentId, "PAIR_BUSINESS_LAYER");
      cur.assignee_agent_id = agentId;
      cur.department = cur.department || String(curAgent.department ?? "");
      cur.status = "READY";
      cur.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, cur, Number(cur.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_ASSIGNED",
        old_state: curFrom, new_state: "READY", actor: `operator:${actor}`,
        metadata: { assignee_agent_id: agentId },
      });
      return saved;
    });
  }

  /**
   * The single seam where business work enters the governed engine:
   * budget check (fail-closed) → enriched goal → canonical startMission →
   * work_item IN_PROGRESS with mission_id recorded.
   */
  openWorkItem(workItemId: string, operatorId: string): Row {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_item.open");
    const row = this.resolvePendingOpenBeforeMutation(workItemId, operatorId);
    this.assertWorkItemNotQuarantined(row);
    // WFV2 §5/§7: graph provenance + dependency gating at the single
    // canonical open seam — forged rows and unmet dependencies never
    // reach binding/mission creation.
    this.assertGraphAuthority(row);
    this.assertDependenciesSatisfied(row);
    // R2 §4 — persisted-ceiling ∩ current-parent ∩ current-child
    // authority must still hold at open, before any binding/mission is
    // created. A contract widened after delegation/decomposition commit
    // fails closed here, and a DISABLED contract is never usable.
    this.assertChildAuthorityCeiling(row);
    // A previous linked mission still live forbids a replacement — the
    // governed path is pause/cancel/resume/reconcile, not a second dispatch.
    const priorMissionIds = (row.mission_ids as string[] | undefined) ?? [];
    if (priorMissionIds.length > 0) {
      const last = this.store.tryGet("mission", priorMissionIds[priorMissionIds.length - 1]);
      if (last && !TERMINAL_MISSION_STATUSES.has(String(last.status))) {
        throw new PolicyError(
          "FAIL_CLOSED_MISSION_ACTIVE",
          `linked mission ${String(last.mission_id)} still ${String(last.status)} — cancel/resume/reconcile first`,
        );
      }
    }
    const from = String(row.status);
    assertWorkItemTransition(from, "IN_PROGRESS");
    const business = this.getBusiness(String(row.business_id));
    const agentId = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    // P2 §8 — canonical coordination gate: a LIVE lease held by an agent
    // other than the canonical assignee fails closed; a live lease held
    // BY the assignee or no claim at all both proceed (open never mints
    // a hidden bearer token — claim is coordination, not execution).
    this.assertNoForeignLiveLease(row, agentId);
    let agent: Row | null = null;
    if (agentId) {
      agent = this.store.get("org_agent", agentId);
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
      }
    }
    // Durable open intent committed BEFORE mission creation: the transition
    // write is the dedup point, and the canonical `work_open_binding`
    // record ties this intent to the mission it will create — the binding
    // PINS the mission_id up front, so mission metadata remains pure
    // observability and can never itself constitute authority (V2 §2-3).
    const openId = newId("OPI");
    const missionId = newId("MSN");
    row.status = "IN_PROGRESS";
    row.pending_open_id = openId;
    row.pending_open_at = utcnow();
    // P2 §8 — open mints NO bearer token: claimed_by/claim_expires_at
    // stay observability mirrors of the canonical lease only.
    row.updated_at = utcnow();
    this.store.put("work_item", workItemId, row, Number(row.version));

    let reservationId: string | null = null;
    try {
      // The canonical open authority record — created BEFORE the mission
      // it reserves exists. Identity/ownership are established here, not
      // by anything a caller could submit through mission metadata.
      this.store.put("work_open_binding", openId, {
        open_id: openId,
        work_item_id: workItemId,
        business_id: String(row.business_id),
        project_id: String(business.project_id),
        org_agent_id: agentId,
        created_by: operatorId,
        mission_id: missionId,
        state: "INTENT",
        created_at: utcnow(), bound_at: null, rolled_back_at: null,
        updated_at: utcnow(),
        version: 0,
      } as Row, 0);
      reservationId = this.reserveBudget(String(row.business_id), String(row.department ?? ""), agentId, openId);

      // P12 §15: context injection respects the contract's
      // allowed_context_scopes — "business" gates the org prefix, "agent"
      // gates agent identity + outcome notes. Baseline grants all scopes,
      // so unmodified contracts see identical goals.
      const ctxScopes = agentId
        ? new Set(
            (this.agentContracts.resolve(agentId).contract.policy as AgentContractPolicy)
              .allowed_context_scopes,
          )
        : new Set<string>();
      const notes = ctxScopes.has("agent")
        ? (((agent?.context_notes as Array<Record<string, unknown>> | undefined) ?? [])
            .slice(-AGENT_CONTEXT_INJECT)
            .map((n) => `- ${String(n.note)}`))
        : [];
      const goal =
        (ctxScopes.has("business") || !agentId
          ? `[BUSINESS ${String(business.name)} | DEPT ${String(row.department ?? "-")}` +
            (agent && ctxScopes.has("agent")
              ? ` | AGENT ${String(agent.title)} (${String(agent.role ?? "")})`
              : "") +
            `]\n`
          : "") +
        `${String(row.goal)}` +
        (notes.length ? `\n\n[AGENT CONTEXT — last ${notes.length} outcomes]\n${notes.join("\n")}` : "");

      // Internal bound-mission seam: the mission identity is DERIVED
      // from the canonical binding (binding_open_id), never accepted as
      // an arbitrary pin — the seam loads + validates the binding itself
      // and stamps the non-forgeable `bound_open_id` origin proof on the
      // mission (V2 R1 §2-§3). Metadata mirrors observability only.
      const mission = this.deps.control.startBoundMission({
        binding_open_id: openId,
        project_id: String(business.project_id),
        goal,
        metadata: {
          business_id: String(row.business_id),
          work_item_id: workItemId,
          work_item_open_id: openId,
          org_agent_id: agentId,
          department: row.department ?? null,
          source: "business_layer",
        },
        operator_id: operatorId,
      });
      if (String(mission.mission_id) !== missionId) {
        // Defensive: a bound create that ignored the pinned id would
        // orphan this binding — fail the whole intent rather than drift.
        throw new IntegrityError("FAIL_CLOSED_MISSION_PIN", "startBoundMission did not honor the pinned mission_id");
      }
      // Atomically link the row AND flip the binding to BOUND — the two
      // can never disagree across a crash boundary (V2 §5).
      const saved = this.store.immediate(() => {
        const linked = this.store.get("work_item", workItemId);
        const linkedIds = linked.mission_ids as string[];
        if (!linkedIds.includes(missionId)) linkedIds.push(missionId);
        if (String(linked.pending_open_id ?? "") === openId) {
          linked.pending_open_id = null;
          linked.pending_open_at = null;
        }
        linked.updated_at = utcnow();
        const linkedSaved = this.store.put("work_item", workItemId, linked, Number(linked.version));
        const binding = this.store.get("work_open_binding", openId);
        binding.state = "BOUND";
        binding.bound_at = utcnow();
        binding.updated_at = utcnow();
        this.store.put("work_open_binding", openId, binding, Number(binding.version));
        return linkedSaved;
      });
      if (reservationId) this.consumeBudgetReservation(reservationId);
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPENED",
        old_state: from, new_state: "IN_PROGRESS", actor: `operator:${operatorId}`,
        metadata: { mission_id: missionId, assignee_agent_id: agentId, open_id: openId },
      });
      return saved;
    } catch (err) {
      // Correctness cannot depend on the crash window size: find the mission
      // this intent created (work_item_open_id). Found → link it and count
      // the open as successful (the canonical mission exists and is wired).
      // Not found → the intent never dispatched: release the reservation and
      // return the item to its pre-open state, audited.
      const repaired = this.reconcileOpenIntent(workItemId, openId, operatorId);
      if (repaired) {
        if (reservationId) this.consumeBudgetReservation(reservationId);
        return repaired;
      }
      // A concurrent reconciler may already have linked this intent's mission
      // and cleared the marker — then the open DID land exactly once and a
      // lost CAS race is not a failed open. Any other error still propagates.
      const curRow = this.store.tryGet("work_item", workItemId);
      if (
        curRow &&
        (err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT"
      ) {
        // V2: ownership is proven by the binding-pinned id, never by
        // scanning mission metadata a caller could have forged.
        const mine = ((curRow.mission_ids as string[] | undefined) ?? []).includes(missionId);
        if (mine) {
          if (reservationId) this.consumeBudgetReservation(reservationId);
          return curRow;
        }
      }
      if (reservationId) this.releaseBudgetReservation(reservationId);
      const cur = this.store.tryGet("work_item", workItemId);
      if (
        cur && String(cur.status) === "IN_PROGRESS" &&
        String(cur.pending_open_id ?? "") === openId &&
        (cur.mission_ids as string[]).length === priorMissionIds.length
      ) {
        // Atomic rollback (V2 R1 §1): row restore + pending/claim clears +
        // binding INTENT→ROLLED_BACK + audit event commit in ONE txn — no
        // crash boundary can leave READY/no-pending work with a live INTENT.
        this.rollbackOpenIntentAtomic(workItemId, openId, from as WorkItemStatus, {
          actor: "PAIR_BUSINESS_LAYER",
          metadata: { open_id: openId, error: String((err as { message?: string })?.message ?? err) },
        });
      }
      throw err;
    }
  }

  /**
   * Canonical mutation gate: before ANY business operation that changes
   * execution-related state, resolve a pending open intent first.
   *   mission found    → link it atomically; if it is terminal, fold state
   *                      via syncWorkItem so the caller sees true state;
   *   no mission,      → deterministic audited rollback to READY;
   *    beyond grace
   *   no mission,      → fail closed FAIL_CLOSED_OPEN_INTENT_ACTIVE — the
   *    within grace      open may still be in flight; mutation must retry.
   * pending_open_id is never silently erased. Returns the fresh row.
   */
  private resolvePendingOpenBeforeMutation(workItemId: string, actor: string): Row {
    const row = this.store.get("work_item", workItemId);
    const openId = row.pending_open_id ? String(row.pending_open_id) : null;
    if (!openId) return row;
    const linked = this.reconcileOpenIntent(workItemId, openId, actor);
    if (linked) {
      const mids = (linked.mission_ids as string[]);
      const m = this.store.tryGet("mission", mids[mids.length - 1]);
      if (m && TERMINAL_MISSION_STATUSES.has(String(m.status))) {
        this.syncWorkItem(workItemId);
      }
      return this.store.get("work_item", workItemId);
    }
    const openedAt = Date.parse(String(row.pending_open_at ?? row.updated_at));
    const inFlight = Number.isFinite(openedAt) && Date.now() - openedAt < OPEN_RECONCILE_GRACE_MS;
    if (inFlight) {
      throw new PolicyError(
        "FAIL_CLOSED_OPEN_INTENT_ACTIVE",
        `pending open intent ${openId} within in-flight window — retry shortly`,
      );
    }
    this.rollbackOpenIntentAtomic(workItemId, openId, "READY", {
      actor: `pair_reconcile:${actor}`,
      metadata: { open_id: openId, cause: "mutation_gate" },
    });
    this.releaseBudgetReservationForRef(openId);
    return this.store.get("work_item", workItemId);
  }

  /**
   * Atomic open-intent rollback (V2 R1 §1): the work-item restore, the
   * pending_open clear, claim release, the binding INTENT→ROLLED_BACK
   * flip and the canonical WORK_ITEM_OPEN_ROLLED_BACK audit event commit
   * in ONE `store.immediate()` — no crash boundary may leave a
   * READY/no-pending item with a live INTENT binding. Idempotent: a
   * second call finds nothing to restore and emits nothing.
   */
  private rollbackOpenIntentAtomic(
    workItemId: string,
    openId: string,
    toStatus: WorkItemStatus,
    audit: { actor: string; metadata: Record<string, unknown> },
  ): void {
    this.store.immediate(() => {
      let changed = false;
      const cur = this.store.get("work_item", workItemId);
      if (
        String(cur.status) === "IN_PROGRESS" &&
        String(cur.pending_open_id ?? "") === openId
      ) {
        cur.status = toStatus;
        // P2: mirrors track the canonical lease — a live lease keeps its
        // mirror after rollback; a phantom mirror is cleared.
        const lease = this.store.tryGet(
          WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(workItemId)) as Row | null;
        const live = lease && String(lease.state) === "ACTIVE";
        cur.claimed_by = live ? String(lease.claimant_agent_id) : null;
        cur.claim_token = null;
        cur.claim_expires_at = live ? String(lease.expires_at) : null;
        cur.pending_open_id = null;
        cur.pending_open_at = null;
        cur.updated_at = utcnow();
        this.store.put("work_item", workItemId, cur, Number(cur.version));
        changed = true;
      }
      const binding = this.store.tryGet("work_open_binding", openId);
      if (binding && String(binding.state) === "INTENT") {
        binding.state = "ROLLED_BACK";
        binding.rolled_back_at = utcnow();
        binding.updated_at = utcnow();
        this.store.put("work_open_binding", openId, binding, Number(binding.version));
        changed = true;
      }
      if (changed) {
        this.store.event({
          entity_type: "work_item", entity_id: workItemId,
          event_type: "WORK_ITEM_OPEN_ROLLED_BACK",
          old_state: "IN_PROGRESS", new_state: toStatus,
          actor: audit.actor,
          metadata: audit.metadata,
        });
      }
      return changed;
    });
  }

  /**
   * Link the mission belonging to an open intent back onto its work item.
   * V2 §6: discovery is driven ONLY by the canonical `work_open_binding`
   * — its pinned mission_id is the single authority for what this intent
   * was allowed to create. Mission metadata is never scanned for linkage,
   * so a forged mission claiming an open_id can never be adopted.
   */
  private reconcileOpenIntent(workItemId: string, openId: string, actor: string): Row | null {
    const row = this.store.tryGet("work_item", workItemId);
    if (!row) return null;
    const binding = this.store.tryGet("work_open_binding", openId);
    if (!binding || String(binding.work_item_id) !== workItemId) {
      // No canonical binding (legacy intent or a forged open id) →
      // nothing may be linked for this intent.
      return null;
    }
    if (String(binding.state) === "ROLLED_BACK") return null;
    const missionId = String(binding.mission_id ?? "");
    const mission = missionId ? this.store.tryGet("mission", missionId) : null;
    if (!mission) {
      if (String(binding.state) === "BOUND") {
        // BOUND but the mission row is gone — the record itself is
        // corrupt; fail closed, never guess a replacement.
        this.quarantineWorkItem(row, `binding ${openId} BOUND but mission ${missionId} missing`);
        return row;
      }
      return null; // INTENT, mission never landed — caller decides grace/rollback
    }
    // Collision / origin check (V2 R1 §4): a mission occupying the
    // reserved id WITHOUT this binding's internal origin proof is a
    // foreign occupant — never adopt, never flip BOUND; quarantine.
    if (String(mission.bound_open_id ?? "") !== openId) {
      this.quarantineWorkItem(
        row,
        `binding ${openId} reserved mission ${missionId} but the occupant lacks canonical origin proof`,
      );
      return row;
    }
    // Fully landed already (BOUND + linked + marker cleared): nothing to
    // repair — a null keeps the open catch path honest about whether the
    // failure was inside the landing window or after it.
    if (
      String(binding.state) === "BOUND" &&
      ((row.mission_ids as string[] | undefined) ?? []).includes(missionId) &&
      !row.pending_open_id
    ) {
      return null;
    }
    // Canonical binding validation before adoption (V2 R1 §5): the whole
    // chain — work item, business, project pair, org-agent scope — must
    // hold, in addition to the origin proof above.
    if (
      !validateWorkOpenBinding(this.store, binding, {
        forWorkItem: row,
        forMission: mission,
        // PROVENANCE: crash-after-create adoption may land while the
        // agent is already PAUSED — the mission was created under a
        // valid admission; only provenance is being proven (R3 §6).
        mode: "PROVENANCE",
      }).ok
    ) {
      this.quarantineWorkItem(row, `binding ${openId} failed canonical validation during reconcile`);
      return row;
    }
    // The binding's own mission exists and is proven: link the row and
    // flip INTENT→BOUND atomically (a crash between mission creation and
    // the bound write is the only window this repairs — never a metadata
    // guess).
    let saved: Row;
    try {
      saved = this.store.immediate(() => {
        const fresh = this.store.get("work_item", workItemId);
        const ids = fresh.mission_ids as string[];
        if (!ids.includes(missionId)) ids.push(missionId);
        fresh.pending_open_id = null;
        fresh.pending_open_at = null;
        fresh.updated_at = utcnow();
        const linked = this.store.put("work_item", workItemId, fresh, Number(fresh.version));
        const b = this.store.get("work_open_binding", openId);
        if (String(b.state) !== "BOUND") {
          b.state = "BOUND";
          b.bound_at = utcnow();
          b.updated_at = utcnow();
          this.store.put("work_open_binding", openId, b, Number(b.version));
        }
        return linked;
      });
    } catch (err) {
      // A racing reconciler may have linked the same mission first — the
      // outcome is identical; return the fresh row instead of throwing.
      const fresh = this.store.get("work_item", workItemId);
      if ((fresh.mission_ids as string[]).includes(missionId)) return fresh;
      throw err;
    }
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPEN_RECONCILED",
      new_state: String(saved.status), actor: `pair_reconcile:${actor}`,
      metadata: { open_id: openId, mission_id: missionId },
    });
    return saved;
  }

  /**
   * Restart sweep: repair IN_PROGRESS items whose pending open intent is
   * older than the grace window — either the mission exists (link it) or
   * the intent provably never dispatched (roll back to READY, audited).
   */
  private reconcileOpenIntents(businessId: string): void {
    for (const w of this.listWorkItems(businessId)) {
      if (!w.pending_open_id) continue;
      try {
        this.resolvePendingOpenBeforeMutation(String(w.work_item_id), "sweep");
      } catch (err) {
        if ((err as { code?: string }).code !== "FAIL_CLOSED_OPEN_INTENT_ACTIVE") throw err;
      }
    }
  }

  /** True governed cancellation: cancel the live linked mission through
   *  MissionControl, then drop the item to CANCELLED. A BACKLOG/READY/BLOCKED
   *  item has no live mission — it is cancelled directly. */
  cancelWorkItem(workItemId: string, actor: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const from = String(row.status);
    assertWorkItemTransition(from, "CANCELLED");
    const missionIds = (row.mission_ids as string[] | undefined) ?? [];
    let cancelledMission: string | null = null;
    if (missionIds.length > 0) {
      // V2: mission-control actions may touch only the mission the
      // canonical binding proves belongs to THIS work item — a corrupt
      // mission_ids entry can never cancel another item's mission.
      const last = this.boundMissionForWorkItem(row);
      if (last && !TERMINAL_MISSION_STATUSES.has(String(last.status))) {
        this.deps.control.cancelMission(String(last.mission_id), actor);
        cancelledMission = String(last.mission_id);
      }
    }
    row.status = "CANCELLED";
    row.claimed_by = null;
    row.claim_token = null;
    row.claim_expires_at = null;
    row.pending_open_id = null;
    row.pending_open_at = null;
    row.updated_at = utcnow();
    // P2: cancel revokes the canonical coordination lease in the same
    // transaction as the work-item transition + audit event.
    const saved = this.store.immediate(() => {
      const lease = this.store.tryGet(
        WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(workItemId)) as Row | null;
      if (lease && String(lease.state) === "ACTIVE") {
        this.transitionLease(lease, "REVOKED", actor, { work_item_id: workItemId });
      }
      const s = this.store.put("work_item", workItemId, row, Number(row.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_CANCELLED",
        old_state: from, new_state: "CANCELLED", actor: `operator:${actor}`,
        metadata: { mission_id: cancelledMission },
      });
      return s;
    });
    return saved;
  }

  /** Fold the linked mission's terminal state back into the work item.
   *  V2: only a mission proven by the canonical binding may fold into
   *  work-item state — a foreign/forged mission id can never mark this
   *  item DONE, REVIEW_REQUIRED, BLOCKED or CANCELLED (§4/§7). */
  syncWorkItem(workItemId: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, "sync");
    const status = String(row.status);
    if (status !== "IN_PROGRESS") return row;
    if (String(row.blocked_code ?? "") === WORK_CORRUPT_CODE) return row;
    const missionIds = (row.mission_ids as string[]) ?? [];
    if (missionIds.length === 0) return row;
    let mission: Row;
    try {
      mission = this.store.get("mission", missionIds[missionIds.length - 1]);
    } catch {
      return row; // mission not persisted yet — leave IN_PROGRESS
    }
    if (!this.missionBoundToWorkItem(row, mission)) {
      // The final mission id does not belong to this work item — fold
      // nothing; quarantine so no authority path treats it as progress.
      this.quarantineWorkItem(row, `unbound mission ${String(mission.mission_id)} referenced by ${workItemId}`);
      return this.store.get("work_item", workItemId);
    }
    const ms = String(mission.status);
    // P3 §4/§7 — a COMPLETED mission alone never completes the item: the
    // completion basis must be ready (canonical child set proven too).
    // R1 — mission.status = "COMPLETED" is a mutable claim, not proof:
    // the fold requires the canonical mission-completion evidence chain
    // (transition + runtime + per-task execution evidence). A forged
    // status with no finalization evidence quarantines — it can never
    // project REVIEW_REQUIRED/DONE, mint a WCP, or satisfy a parent.
    // Review-required items project REVIEW_REQUIRED only once the basis
    // is fully ready AND the exact basis was not already REWORK-rejected.
    let basis: ReturnType<BusinessLayer["completionBasis"]> | null = null;
    if (ms === "COMPLETED") {
      if (!proveCanonicalMissionCompletion(this.store, mission)) {
        this.quarantineWorkItem(row, `mission ${String(mission.mission_id)} COMPLETED without canonical runtime evidence`);
        return this.store.get("work_item", workItemId);
      }
      try {
        basis = this.completionBasis(row);
      } catch (e) {
        if (e instanceof IntegrityError) {
          this.quarantineWorkItem(
            row, `corrupt completion provenance for ${workItemId}: ${(e as Error).message}`);
          return this.store.get("work_item", workItemId);
        }
        throw e;
      }
    }
    const next: WorkItemStatus | null =
      ms === "COMPLETED"
        ? (basis!.ready && !basis!.rejected
            ? (row.requires_review === true ? "REVIEW_REQUIRED" : "DONE")
            : null)
      : ms === "FAILED" ? "BLOCKED" :
      ms === "CANCELLED" ? "CANCELLED" :
      ms === "PAUSED" ? "BLOCKED" : null;
    if (!next) return row;
    assertWorkItemTransition(status, next);
    row.status = next;
    row.updated_at = utcnow();
    if (next === "DONE" || next === "BLOCKED" || next === "REVIEW_REQUIRED") {
      row.result_summary = String(mission.result ?? mission.result_summary ?? "") || null;
    }
    // P2: terminal fold releases the canonical lease in the same txn;
    // mirrors track the lease (cleared only when no live lease).
    // P3: DONE writes the canonical work_completion record + immutable
    // anchor in the SAME transaction — a crash can never split the
    // status projection from its completion evidence.
    const saved = this.store.immediate(() => {
      const lease = this.store.tryGet(
        WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(workItemId)) as Row | null;
      const leaseActive = lease && String(lease.state) === "ACTIVE";
      if (leaseActive && (next === "DONE" || next === "CANCELLED")) {
        this.transitionLease(lease, "RELEASED", "PAIR_BUSINESS_LAYER", { work_item_id: workItemId });
      }
      const liveLease = lease && String(lease.state) === "ACTIVE" &&
        !(next === "DONE" || next === "CANCELLED");
      row.claimed_by = liveLease ? String(lease.claimant_agent_id) : null;
      row.claim_token = null;
      row.claim_expires_at = liveLease ? String(lease.expires_at) : null;
      const savedRow = this.store.put("work_item", workItemId, row, Number(row.version));
      if (next === "DONE") {
        this.writeCompletionRecord(savedRow, {
          mission_id: String(mission.mission_id),
          bound_open_id: String(mission.bound_open_id ?? "") || null,
          child_work_item_ids: basis?.childIds ?? [],
          reviewer_agent_id: null,
        }, "PAIR_BUSINESS_LAYER");
      }
      return savedRow;
    });
    // Feed the outcome back into the assignee's persistent context — the
    // agent "remembers" what it did across missions.
    const assignee = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    if (assignee) {
      try {
        const agentRow = this.store.get("org_agent", assignee);
        const notes = (agentRow.context_notes as Array<Record<string, unknown>> | undefined) ?? [];
        notes.push({
          at: utcnow(),
          work_item_id: workItemId,
          mission_id: missionIds[missionIds.length - 1],
          outcome: next,
          note: String(row.result_summary ?? row.title ?? "").slice(0, 300),
        });
        agentRow.context_notes = notes.slice(-AGENT_CONTEXT_CAP);
        this.store.put("org_agent", assignee, agentRow, Number(agentRow.version));
      } catch { /* agent removed — context drop is non-fatal */ }
    }
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_SYNCED",
      old_state: status, new_state: next, actor: "PAIR_BUSINESS_LAYER",
      metadata: { mission_id: missionIds[missionIds.length - 1], mission_status: ms },
    });
    // P3 §8 — a landed final completion propagates upward: canonical
    // parents re-derive their own basis inside their own txns.
    if (next === "DONE") this.advanceCompletionCascade(workItemId);
    return saved;
  }

  // ---------- work_item collaboration (claim / comment / blocker / artifact) ----------

  /**
   * P2 §2-§4 — canonical claim lease. One `work_claim_lease`
   * (WCL_<work_item_id>) is the ONLY coordination authority; the mutable
   * work_item claim fields are observability mirrors. The lease row,
   * mirror update and WORK_CLAIM_ACQUIRED event commit in ONE
   * store.immediate() — crash leaves old lease or new lease, never
   * partial. Only the token DIGEST is persisted; the raw token is
   * returned once here and nowhere else ever.
   */
  claimWorkItem(workItemId: string, agentId: string, actor: string): Row & { claim_token: string } {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    this.assertWorkItemNotQuarantined(row);
    this.assertGraphAuthority(row);
    const status = String(row.status);
    if (TERMINAL_WORK_ITEM_STATUSES.has(status)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${status} cannot be claimed`);
    }
    // P2 §3 eligibility order: claimant must exist in the same business
    // and be ACTIVE/executable before assignee matching.
    const agent = this.store.get("org_agent", agentId);
    const business = this.getBusiness(String(row.business_id));
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_AGENT_BUSINESS_MISMATCH",
        `claimant ${agentId} not in business ${String(row.business_id)}`,
      );
    }
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    // A claim never assigns: assigned items may only be claimed by their
    // canonical assignee; unassigned items need the explicit assign seam
    // first.
    const assignee = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    if (!assignee) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_ITEM_UNASSIGNED",
        `${workItemId} has no assignee — assign before claiming`,
      );
    }
    if (assignee !== agentId) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_ITEM_CLAIM_ASSIGNEE_MISMATCH",
        `${workItemId} is assigned to ${assignee}, not ${agentId}`,
      );
    }
    // P12 executability for claim admission: contract ACTIVE + same
    // business + allowed project.
    this.agentContracts.assertExecutable(agentId, {
      businessId: String(row.business_id),
      projectId: String(business.project_id),
    });
    const nowIso = utcnow();
    const leaseId = claimLeaseRowId(workItemId);
    const out = this.store.immediate(() => {
      // R1 §1/§3 — decisive claim admission is re-proved on the CURRENT
      //  rows inside this write transaction: the preflight above is fast
      //  error reporting only, never authority. A concurrent assign /
      //  pause / terminate / contract-disable / project revocation can
      //  never race through this gate.
      const cur0 = this.store.get("work_item", workItemId);
      this.assertWorkItemNotQuarantined(cur0);
      this.assertGraphAuthority(cur0);
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(cur0.status))) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_ITEM_STATE", `${String(cur0.status)} cannot be claimed`);
      }
      const curAgent = this.store.get("org_agent", agentId);
      const curBusiness = this.getBusiness(String(cur0.business_id));
      if (String(curAgent.business_id) !== String(cur0.business_id)) {
        throw new IntegrityError(
          "FAIL_CLOSED_AGENT_BUSINESS_MISMATCH",
          `claimant ${agentId} not in business ${String(cur0.business_id)}`,
        );
      }
      if (String(curAgent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
      }
      const curAssignee = cur0.assignee_agent_id ? String(cur0.assignee_agent_id) : null;
      if (!curAssignee) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_ITEM_UNASSIGNED",
          `${workItemId} has no assignee — assign before claiming`,
        );
      }
      if (curAssignee !== agentId) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_ITEM_CLAIM_ASSIGNEE_MISMATCH",
          `${workItemId} is assigned to ${curAssignee}, not ${agentId}`,
        );
      }
      this.agentContracts.assertExecutable(agentId, {
        businessId: String(cur0.business_id),
        projectId: String(curBusiness.project_id),
      });
      const lease = this.store.tryGet(WORK_CLAIM_LEASE_TABLE, leaseId) as Row | null;
      if (lease) assertCanonicalClaimLease(this.coordDeps(), lease);
      if (lease && String(lease.state) === "ACTIVE") {
        if (!leaseLiveExpired(lease, nowIso)) {
          if (String(lease.claimant_agent_id) === agentId) {
            // Never silently rotate a live holder's token — heartbeat is
            // the renewal path (P2 §4).
            throw new PolicyError(
              "FAIL_CLOSED_WORK_ITEM_CLAIM_ALREADY_HELD",
              `${workItemId} lease ${leaseId} already held by ${agentId} until ${String(lease.expires_at)}`,
            );
          }
          throw new PolicyError(
            "FAIL_CLOSED_WORK_ITEM_CLAIMED",
            `${workItemId} held by ${String(lease.claimant_agent_id)} until ${String(lease.expires_at)}`,
          );
        }
        this.transitionLease(lease, "EXPIRED", actor, { work_item_id: workItemId });
      }
      const curLease = this.store.tryGet(WORK_CLAIM_LEASE_TABLE, leaseId) as Row | null;
      const epoch = curLease ? Number(curLease.lease_epoch) + 1 : 1;
      const token = newId("CLM");
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
      const next: Row = {
        lease_id: leaseId,
        work_item_id: workItemId,
        business_id: String(cur0.business_id),
        project_id: String(curBusiness.project_id),
        claimant_agent_id: agentId,
        lease_epoch: epoch,
        token_digest: claimTokenDigest(token),
        issued_at: nowIso,
        last_heartbeat_at: nowIso,
        expires_at: expiresAt,
        state: "ACTIVE",
        lease_digest: "",
        created_at: curLease ? String(curLease.created_at) : nowIso,
        updated_at: nowIso,
        version: curLease ? Number(curLease.version) : 0,
      };
      next.lease_digest = claimLeaseDigest(next);
      this.store.put(WORK_CLAIM_LEASE_TABLE, leaseId, next, curLease ? Number(curLease.version) : 0);
      // Observability mirrors only — never authority, never token material.
      const cur = this.store.get("work_item", workItemId);
      cur.claimed_by = agentId;
      cur.claim_token = null;
      cur.claim_expires_at = expiresAt;
      cur.updated_at = nowIso;
      const saved = this.store.put("work_item", workItemId, cur, Number(cur.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_CLAIM_ACQUIRED",
        actor: `operator:${actor}`,
        metadata: { lease_id: leaseId, claimant_agent_id: agentId, lease_epoch: epoch, expires_at: expiresAt },
      });
      return { saved, token };
    });
    return { ...out.saved, claim_token: out.token };
  }

  /**
   * P2 §5 — heartbeat: "this agent still owns the coordination lease".
   * Renews expiry by the server-bounded CLAIM_TTL_MS only; never rotates
   * the token; never implies executor liveness. Validates the canonical
   * lease, claimant, token digest, epoch, expiry and CURRENT P12
   * executability — all inside one immediate transaction.
   */
  heartbeatWorkItem(workItemId: string, agentId: string, claimToken: string, actor: string): Row {
    const row = this.store.get("work_item", workItemId);
    this.assertWorkItemNotQuarantined(row);
    const business = this.getBusiness(String(row.business_id));
    const leaseId = claimLeaseRowId(workItemId);
    const out = this.store.immediate(() => {
      // R1 §3 — quarantine + lease state re-proved inside the write txn.
      this.assertWorkItemNotQuarantined(this.store.get("work_item", workItemId));
      const lease = this.store.tryGet(WORK_CLAIM_LEASE_TABLE, leaseId) as Row | null;
      if (!lease) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_NOT_CLAIMED", `${workItemId} has no claim lease`);
      }
      assertCanonicalClaimLease(this.coordDeps(), lease);
      if (String(lease.state) !== "ACTIVE") {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_CLAIM_NOT_ACTIVE",
          `lease ${leaseId} is ${String(lease.state)}`,
        );
      }
      if (String(lease.claimant_agent_id) !== agentId) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_CLAIM_CLAIMANT",
          `lease ${leaseId} held by ${String(lease.claimant_agent_id)}`,
        );
      }
      if (claimTokenDigest(String(claimToken ?? "")) !== String(lease.token_digest)) {
        throw new PolicyError("FAIL_CLOSED_CLAIM_TOKEN", `lease ${leaseId} token mismatch`);
      }
      const nowIso = utcnow();
      if (leaseLiveExpired(lease, nowIso)) {
        // Fence first, then report expiry — the transition COMMITS so the
        // stale holder never sees a nominally ACTIVE row again.
        this.transitionLease(lease, "EXPIRED", actor, { work_item_id: workItemId });
        return claimExpiredError(leaseId);
      }
      this.agentContracts.assertExecutable(agentId, {
        businessId: String(row.business_id),
        projectId: String(business.project_id),
      });
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
      const next: Row = {
        ...lease,
        last_heartbeat_at: nowIso,
        expires_at: expiresAt,
        updated_at: nowIso,
      };
      next.lease_digest = claimLeaseDigest(next);
      const saved = this.store.put(WORK_CLAIM_LEASE_TABLE, leaseId, next, Number(lease.version));
      const cur = this.store.get("work_item", workItemId);
      cur.claimed_by = agentId;
      cur.claim_token = null;
      cur.claim_expires_at = expiresAt;
      cur.updated_at = nowIso;
      this.store.put("work_item", workItemId, cur, Number(cur.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_CLAIM_HEARTBEAT",
        actor: `operator:${actor}`,
        metadata: { lease_id: leaseId, claimant_agent_id: agentId, lease_epoch: Number(lease.lease_epoch), expires_at: expiresAt },
      });
      return safeLeaseView(saved) as Row;
    });
    if (out instanceof PolicyError) throw out;
    return out;
  }

  /**
   * P2 §7 — release on canonical lease authority. A live lease requires
   * the matching raw token; an expired lease is deterministically EXPIRED;
   * release is idempotent on terminal/none. Never reassigns anything.
   */
  releaseClaim(workItemId: string, actor: string, claimToken?: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const leaseId = claimLeaseRowId(workItemId);
    return this.store.immediate(() => {
      const lease = this.store.tryGet(WORK_CLAIM_LEASE_TABLE, leaseId) as Row | null;
      if (lease) assertCanonicalClaimLease(this.coordDeps(), lease);
      const nowIso = utcnow();
      const hadMirror = Boolean(row.claimed_by);
      if (lease && String(lease.state) === "ACTIVE" && !leaseLiveExpired(lease, nowIso)) {
        if (claimTokenDigest(String(claimToken ?? "")) !== String(lease.token_digest)) {
          throw new PolicyError(
            "FAIL_CLOSED_CLAIM_TOKEN",
            `live lease ${leaseId} held by ${String(lease.claimant_agent_id)} — matching claim_token required`,
          );
        }
        this.transitionLease(lease, "RELEASED", actor, { work_item_id: workItemId });
      } else if (lease && String(lease.state) === "ACTIVE" && leaseLiveExpired(lease, nowIso)) {
        this.transitionLease(lease, "EXPIRED", actor, { work_item_id: workItemId });
      }
      const cur = this.store.get("work_item", workItemId);
      cur.claimed_by = null;
      cur.claim_token = null;
      cur.claim_expires_at = null;
      cur.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, cur, Number(cur.version));
      if (!lease && hadMirror) {
        // Phantom-mirror release (no canonical lease): transitionLease
        // already journaled the canonical case — this covers the rest.
        this.store.event({
          entity_type: "work_item", entity_id: workItemId, event_type: "WORK_CLAIM_RELEASED",
          actor: `operator:${actor}`,
          metadata: { lease_id: null, released_from: null },
        });
      }
      return saved;
    });
  }

  /** Safe lease metadata for reads — never token material (§13). R1 §7:
   *  the canonical lease is validated before any metadata is returned —
   *  a corrupt WCL is never surfaced as valid claim state. */
  getWorkItemClaim(workItemId: string): Record<string, unknown> | null {
    const lease = this.store.tryGet(WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(workItemId)) as Row | null;
    if (lease) assertCanonicalClaimLease(this.coordDeps(), lease);
    return lease ? safeLeaseView(lease) : null;
  }

  /**
   * P2 §8 — canonical coordination gate for seams that must not proceed
   * while a DIFFERENT agent holds a live lease (open/assign). A live
   * lease held by `agentId` (or no lease) passes; an expired lease is
   * deterministically fenced EXPIRED before the seam continues; stale
   * mirrors without a WCL row are legacy phantoms and are invalidated.
   */
  private assertNoForeignLiveLease(row: Row, agentId: string | null): void {
    const workItemId = String(row.work_item_id);
    const saved = this.store.immediate(() => {
      // R1 §2 — the lease is read + validated INSIDE this txn; no stale
      //  snapshot is ever carried across the commit boundary.
      const cur = this.store.get("work_item", workItemId);
      const mirrorChanged = this.leaseGateInTxn(cur, agentId, "PAIR_BUSINESS_LAYER");
      return mirrorChanged
        ? this.store.put("work_item", workItemId, cur, Number(cur.version))
        : null;
    });
    // Sync ONLY the mirror fields the gate owns, and only when the gate
    // itself wrote — a full-row resync would defeat the caller's own
    // expected-version CAS (a concurrent mutation seen here would then be
    // silently overwritten instead of conflicting, e.g. two opens both
    // landing pending_open_id).
    if (saved) {
      row.claimed_by = saved.claimed_by;
      row.claim_expires_at = saved.claim_expires_at;
      row.claim_token = saved.claim_token;
      row.version = saved.version;
    }
  }

  /**
   * In-txn lease gate (R1 §2): reads + validates the CURRENT WCL on
   *  `cur`, fences a lapsed ACTIVE lease to EXPIRED, rejects a live
   *  foreign claimant, and repairs `cur`'s mirror fields in place (the
   *  caller owns the work_item write). Returns true when mirrors changed.
   *  Caller must already be inside store.immediate().
   */
  private leaseGateInTxn(cur: Row, agentId: string | null, actor: string): boolean {
    const workItemId = String(cur.work_item_id);
    const lease = this.store.tryGet(
      WORK_CLAIM_LEASE_TABLE, claimLeaseRowId(workItemId)) as Row | null;
    if (lease) assertCanonicalClaimLease(this.coordDeps(), lease);
    const nowIso = utcnow();
    if (lease && String(lease.state) === "ACTIVE") {
      if (leaseLiveExpired(lease, nowIso)) {
        this.transitionLease(lease, "EXPIRED", actor, { work_item_id: workItemId });
      } else if (String(lease.claimant_agent_id) !== String(agentId ?? "")) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_ITEM_CLAIMED",
          `held by ${String(lease.claimant_agent_id)} until ${String(lease.expires_at)}`,
        );
      }
    }
    const live = lease && String(lease.state) === "ACTIVE" && !leaseLiveExpired(lease, nowIso);
    const wantsBy = live ? String(lease!.claimant_agent_id) : null;
    const wantsExp = live ? String(lease!.expires_at) : null;
    const drift =
      String(cur.claimed_by ?? "") !== String(wantsBy ?? "") ||
      String(cur.claim_expires_at ?? "") !== String(wantsExp ?? "") ||
      (cur.claim_token !== null && cur.claim_token !== undefined);
    if (!drift) return false;
    const hadPhantom =
      Boolean(cur.claimed_by) || (cur.claim_token !== null && cur.claim_token !== undefined);
    cur.claimed_by = wantsBy;
    cur.claim_expires_at = wantsExp;
    cur.claim_token = null;
    cur.updated_at = nowIso;
    if (hadPhantom && !live) {
      this.store.event({
        entity_type: "work_item", entity_id: workItemId,
        event_type: "WORK_CLAIM_MIRRORS_CLEARED",
        actor: `PAIR_${actor.startsWith("PAIR_") ? actor.slice(5) : actor}`,
        metadata: { work_item_id: workItemId, lease_id: lease ? String(lease.lease_id) : null },
      });
    }
    return true;
  }

  private coordDeps(): GraphAuthorityDeps {
    return {
      store: this.store,
      getBusiness: (id: string) => this.getBusiness(id),
      agentContracts: this.agentContracts,
    };
  }

  /** In-txn lease state transition: digest recompute + CAS + audit event.
   *  Caller must already be inside store.immediate(). */
  private transitionLease(
    lease: Row, to: "RELEASED" | "EXPIRED" | "REVOKED", actor: string,
    meta: Record<string, unknown>,
  ): Row {
    const next: Row = { ...lease, state: to, updated_at: utcnow() };
    next.lease_digest = claimLeaseDigest(next);
    const saved = this.store.put(
      WORK_CLAIM_LEASE_TABLE, String(lease.lease_id), next, Number(lease.version));
    this.store.event({
      entity_type: "work_item", entity_id: String(lease.work_item_id),
      event_type: `WORK_CLAIM_${to}`,
      actor: `operator:${actor}`,
      metadata: {
        lease_id: String(lease.lease_id),
        claimant_agent_id: String(lease.claimant_agent_id),
        lease_epoch: Number(lease.lease_epoch),
        ...meta,
      },
    });
    return saved;
  }

  // ---------- P2: durable inbox / collaboration (§10-§12) ----------

  /**
   * Append-only workforce message. Communication only — body is data,
   * never authority: cannot mutate assignee/WGM/WDEL/WDEC/WDS/WAB/claims,
   * satisfy dependencies, or execute work. Message + PENDING receipt +
   * event commit atomically.
   */
  sendWorkforceMessage(input: {
    business_id: string;
    work_item_id?: string | null;
    sender_type: "AGENT" | "OPERATOR";
    sender_agent_id?: string | null;
    sender_operator_id?: string | null;
    recipient_agent_id: string;
    kind: string;
    body: string;
    correlation_id?: string | null;
  }): Row {
    if (!input.business_id) {
      throw new IntegrityError("FAIL_CLOSED_MESSAGE_SCOPE", "business_id required");
    }
    this.getBusiness(input.business_id);
    if (!WORK_MESSAGE_KINDS.has(String(input.kind))) {
      throw new IntegrityError("FAIL_CLOSED_MESSAGE_KIND", String(input.kind));
    }
    if (!String(input.body ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_MESSAGE_BODY", "body required");
    }
    const recipient = this.store.get("org_agent", String(input.recipient_agent_id));
    if (String(recipient.business_id) !== String(input.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_MESSAGE_SCOPE", "recipient outside business");
    }
    let workItem: Row | null = null;
    if (input.work_item_id) {
      workItem = this.store.get("work_item", String(input.work_item_id));
      if (String(workItem.business_id) !== String(input.business_id)) {
        throw new IntegrityError("FAIL_CLOSED_MESSAGE_SCOPE", "work item outside business");
      }
      this.assertWorkItemNotQuarantined(workItem);
      this.assertGraphAuthority(workItem);
    }
    if (input.sender_type === "AGENT") {
      if (!input.sender_agent_id) {
        throw new IntegrityError("FAIL_CLOSED_MESSAGE_SENDER", "sender_agent_id required");
      }
      const sender = this.store.get("org_agent", String(input.sender_agent_id));
      if (String(sender.business_id) !== String(input.business_id)) {
        throw new IntegrityError("FAIL_CLOSED_MESSAGE_SCOPE", "sender outside business");
      }
      if (String(sender.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", String(input.sender_agent_id));
      }
    } else if (input.sender_type === "OPERATOR") {
      if (!String(input.sender_operator_id ?? "").trim()) {
        throw new IntegrityError("FAIL_CLOSED_MESSAGE_SENDER", "sender_operator_id required");
      }
    } else {
      throw new IntegrityError("FAIL_CLOSED_MESSAGE_SENDER", String(input.sender_type));
    }
    const messageId = newId("WFM");
    const now = utcnow();
    const msg: Row = {
      message_id: messageId,
      business_id: input.business_id,
      work_item_id: input.work_item_id ?? null,
      sender_type: input.sender_type,
      sender_agent_id: input.sender_agent_id ?? null,
      sender_operator_id: input.sender_operator_id ?? null,
      recipient_agent_id: String(input.recipient_agent_id),
      kind: String(input.kind),
      body: String(input.body),
      correlation_id: input.correlation_id ?? null,
      created_at: now,
      message_digest: "",
      state: "COMMITTED",
      updated_at: now,
      version: 0,
    };
    msg.message_digest = workforceMessageDigest(msg);
    return this.store.immediate(() => {
      const saved = this.store.put(WORKFORCE_MESSAGE_TABLE, messageId, msg, 0);
      const rid = receiptRowId(messageId, String(input.recipient_agent_id));
      this.store.put(WORKFORCE_RECEIPT_TABLE, rid, {
        receipt_id: rid,
        message_id: messageId,
        recipient_agent_id: String(input.recipient_agent_id),
        status: "PENDING",
        acknowledged_at: null,
        created_at: now,
        updated_at: now,
        version: 0,
      } as Row, 0);
      // R1 §5 — the append-only SENT event pins every canonical field +
      //  the message digest (never the body): a later tamper that even
      //  recomputes the row digest still fails against this anchor.
      this.store.event({
        entity_type: WORKFORCE_MESSAGE_TABLE, entity_id: messageId,
        event_type: "WORKFORCE_MESSAGE_SENT",
        actor: input.sender_type === "AGENT"
          ? `agent:${String(input.sender_agent_id)}`
          : `operator:${String(input.sender_operator_id)}`,
        metadata: {
          message_id: messageId,
          business_id: input.business_id,
          work_item_id: input.work_item_id ?? null,
          sender_type: String(input.sender_type),
          sender_agent_id: input.sender_agent_id ?? null,
          sender_operator_id: input.sender_operator_id ?? null,
          recipient_agent_id: String(input.recipient_agent_id),
          kind: String(input.kind),
          correlation_id: input.correlation_id ?? null,
          message_digest: msg.message_digest,
          receipt_id: rid,
          receipt_created_at: now,
        },
      });
      return saved;
    });
  }

  listWorkItemMessages(workItemId: string): Row[] {
    this.store.get("work_item", workItemId);
    const deps = this.coordDeps();
    // R1 §7 — a corrupt row is never surfaced as valid inbox data: it is
    //  replaced by an explicit corruption projection (no body content).
    return this.store.list(WORKFORCE_MESSAGE_TABLE)
      .filter((m) => String(m.work_item_id) === workItemId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((m) => {
        try {
          // R2 §2 — validate the whole bundle: message + its canonical
          //  receipt must both exist and pass. Absence of the receipt is
          //  corruption, never a synthesized PENDING.
          assertCanonicalCollaborationBundle(deps, m);
          return m;
        } catch {
          return {
            message_id: m.message_id, work_item_id: m.work_item_id,
            state: "CORRUPT", corrupt: true,
            version: Number(m.version ?? 0),
          } as Row;
        }
      });
  }

  /** Durable agent inbox: messages + their receipt status. */
  inboxForAgent(agentId: string): Row[] {
    this.store.get("org_agent", agentId);
    const deps = this.coordDeps();
    return this.store.list(WORKFORCE_MESSAGE_TABLE)
      .filter((m) => String(m.recipient_agent_id) === agentId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((m) => {
        try {
          // R2 §1-§2 — a canonical message REQUIRES its exact canonical
          //  receipt. Missing/corrupt receipt → explicit CORRUPT
          //  projection; a missing receipt is never read as PENDING.
          const receipt = assertCanonicalCollaborationBundle(deps, m);
          return { ...m, receipt_status: String(receipt.status) };
        } catch {
          return {
            message_id: m.message_id, state: "CORRUPT",
            receipt_status: "CORRUPT", corrupt: true,
            version: Number(m.version ?? 0),
          } as Row;
        }
      });
  }

  /** ACK — exact intended recipient only; idempotent; rewrites nothing. */
  ackWorkforceMessage(messageId: string, agentId: string, actor: string): Row {
    const msg = this.store.get(WORKFORCE_MESSAGE_TABLE, messageId);
    assertCanonicalWorkforceMessage(this.coordDeps(), msg);
    if (String(msg.recipient_agent_id) !== agentId) {
      throw new PolicyError(
        "FAIL_CLOSED_MESSAGE_RECIPIENT_MISMATCH",
        `message ${messageId} is for ${String(msg.recipient_agent_id)}, not ${agentId}`,
      );
    }
    const rid = receiptRowId(messageId, agentId);
    return this.store.immediate(() => {
      const receipt = this.store.get(WORKFORCE_RECEIPT_TABLE, rid);
      assertCanonicalReceipt(this.coordDeps(), receipt);
      if (String(receipt.status) === "ACKNOWLEDGED") return receipt; // idempotent
      const ackedAt = utcnow();
      const next = {
        ...receipt, status: "ACKNOWLEDGED",
        acknowledged_at: ackedAt, updated_at: ackedAt,
      };
      const saved = this.store.put(WORKFORCE_RECEIPT_TABLE, rid, next, Number(receipt.version));
      // R1 §6 — the ACK event pins the exact acked fields; a forged
      //  ACKNOWLEDGED row without this anchor is provenance-corrupt.
      this.store.event({
        entity_type: WORKFORCE_MESSAGE_TABLE, entity_id: messageId,
        event_type: "WORKFORCE_MESSAGE_ACKNOWLEDGED",
        actor: `agent:${agentId}`,
        metadata: {
          message_id: messageId,
          recipient_agent_id: agentId,
          acknowledged_at: ackedAt,
          receipt_id: rid,
          work_item_id: msg.work_item_id ?? null,
        },
      });
      return saved;
    });
  }

  commentOnWorkItem(workItemId: string, author: string, body: string): Row {
    if (!String(body ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_COMMENT", "comment body required");
    }
    const row = this.store.get("work_item", workItemId);
    const comments = (row.comments as Array<Record<string, unknown>> | undefined) ?? [];
    comments.push({ author, body: String(body).slice(0, 4000), at: utcnow() });
    row.comments = comments.slice(-COMMENT_CAP);
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_COMMENT",
      actor: `operator:${author}`, metadata: { author },
    });
    return saved;
  }

  blockWorkItem(workItemId: string, reason: string, actor: string): Row {
    if (!String(reason ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_BLOCKER", "blocker reason required");
    }
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const from = String(row.status);
    assertWorkItemTransition(from, "BLOCKED");
    // Blocking an in-flight item first pauses its mission through the
    // canonical facade — the board never claims "not working" while real
    // work is still running underneath.
    let pausedMission: string | null = null;
    if (from === "IN_PROGRESS") {
      // V2: pause only a canonically bound mission — a corrupt link can
      // never pause another item's work.
      const last = this.boundMissionForWorkItem(row);
      if (last && !TERMINAL_MISSION_STATUSES.has(String(last.status))) {
        this.deps.control.pauseMission(String(last.mission_id), actor);
        pausedMission = String(last.mission_id);
      }
    }
    const blockers = (row.blockers as Array<Record<string, unknown>> | undefined) ?? [];
    blockers.push({ reason: String(reason).slice(0, 2000), at: utcnow(), by: actor });
    row.blockers = blockers;
    row.status = "BLOCKED";
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_BLOCKED",
      old_state: from, new_state: "BLOCKED", actor: `operator:${actor}`,
      metadata: { reason: String(reason).slice(0, 300), mission_paused: pausedMission },
    });
    return saved;
  }

  /**
   * Foundation V2 §10 — minimal review grounding. A REVIEW_REQUIRED
   * item may be decided ONLY when its state provably derives from its
   * own bound COMPLETED mission; a fabricated REVIEW_REQUIRED
   * quarantines and fails both ACCEPT and REWORK without creating any
   * review-decision evidence.
   */
  reviewWorkItem(
    workItemId: string,
    input: { reviewer_agent_id: string; decision: string },
    actor: string,
  ): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    this.assertWorkItemNotQuarantined(row);
    const decision = String(input.decision ?? "");
    if (decision !== "ACCEPT" && decision !== "REWORK") {
      throw new IntegrityError("FAIL_CLOSED_WORK_REVIEW_DECISION", `invalid decision ${decision}`);
    }
    // P3 §5 — duplicate ACCEPT replays idempotently ONLY against the
    // identical canonical completion: same reviewer identity AND a WCP
    // that still fully validates. Any other ACCEPT on a DONE item —
    // different reviewer, divergent basis — fails closed; replay after
    // authority changed can never match the pinned digest.
    if (String(row.status) === "DONE" && decision === "ACCEPT") {
      const wcp = this.store.tryGet(
        WORK_COMPLETION_TABLE, completionRowId(workItemId)) as Row | null;
      if (wcp) {
        try {
          assertCanonicalWorkCompletion(this.graphAuthorityDeps(), wcp);
        } catch (err) {
          throw new IntegrityError(
            "FAIL_CLOSED_WORK_PROVENANCE_CORRUPT",
            `completion record invalid: ${(err as Error).message}`,
          );
        }
        if (String(wcp.reviewer_agent_id) === String(input.reviewer_agent_id)) {
          return row; // exact replay — no second decision event
        }
      }
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEW_STATE",
        `DONE is terminal — ACCEPT cannot replay under changed authority`,
      );
    }
    if (String(row.status) !== "REVIEW_REQUIRED") {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEW_STATE",
        `${String(row.status)} is not awaiting review`,
      );
    }
    // P3 — the REVIEW_REQUIRED must be grounded in the canonical
    // completion basis (bound COMPLETED mission for a leaf; the full
    // proven child set ± own mission for a parent). An ungrounded state
    // quarantines and fails both ACCEPT and REWORK without creating any
    // review-decision evidence.
    const basis = this.completionBasisSafe(row);
    if (!basis.ready || basis.rejected) {
      this.quarantineWorkItem(row, basis.rejected
        ? `review attempted on REWORK-rejected basis for ${workItemId}`
        : `review attempted on ungrounded REVIEW_REQUIRED for ${workItemId}`);
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_PROVENANCE_CORRUPT",
        `review requires canonical completion basis for ${workItemId}`,
      );
    }
    const reviewer = this.store.get("org_agent", input.reviewer_agent_id);
    if (String(reviewer.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_REVIEWER_SCOPE", "reviewer outside business");
    }
    if (String(reviewer.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", String(reviewer.agent_id));
    }
    if (String(reviewer.agent_id) === String(row.assignee_agent_id ?? "")) {
      throw new PolicyError("FAIL_CLOSED_WORK_SELF_REVIEW", "reviewer cannot be the assignee");
    }
    if (row.reviewer_agent_id && String(row.reviewer_agent_id) !== String(reviewer.agent_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEWER_MISMATCH",
        `named reviewer is ${String(row.reviewer_agent_id)}`,
      );
    }
    const from = String(row.status);
    // Decision + WCP + anchors commit atomically — a crash can never
    // split the reviewed state from its canonical evidence.
    const saved = this.store.immediate(() => {
      const cur = this.store.get("work_item", workItemId);
      // In-txn re-check: a concurrent ACCEPT/REWORK that already
      // committed leaves no REVIEW_REQUIRED to decide on (ACCEPT-vs-
      // REWORK race → exactly one canonical outcome).
      if (String(cur.status) !== "REVIEW_REQUIRED") {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_REVIEW_STATE",
          `${String(cur.status)} is not awaiting review`,
        );
      }
      // In-txn re-proof: the basis must still hold at commit time and
      // must not be one a REWORK already rejected.
      const curBasis = this.completionBasisSafe(cur);
      if (!curBasis.ready || curBasis.rejected) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_PROVENANCE_CORRUPT",
          `review basis changed under ${workItemId}`,
        );
      }
      // R1 §2 — reviewer authority is re-proven inside the commit txn:
      // the outside checks are fast-path only. A reviewer PAUSED or
      // TERMINATED between preflight and commit loses the decision.
      const curReviewer = this.store.tryGet(
        "org_agent", input.reviewer_agent_id) as Row | null;
      if (!curReviewer ||
          String(curReviewer.business_id) !== String(cur.business_id)) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_REVIEWER_SCOPE", "reviewer outside business");
      }
      if (String(curReviewer.status) !== "ACTIVE") {
        throw new PolicyError(
          "FAIL_CLOSED_AGENT_INACTIVE", String(curReviewer.agent_id));
      }
      if (String(curReviewer.agent_id) === String(cur.assignee_agent_id ?? "")) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_SELF_REVIEW", "reviewer cannot be the assignee");
      }
      if (cur.reviewer_agent_id &&
          String(cur.reviewer_agent_id) !== String(curReviewer.agent_id)) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_REVIEWER_MISMATCH",
          `named reviewer is ${String(cur.reviewer_agent_id)}`);
      }
      const mission = curBasis.mission;
      let completionDigestPinned: string | null = null;
      let replayedAccept = false;
      if (decision === "ACCEPT") {
        const childIds = curBasis.childIds;
        const fields = {
          completion_id: completionRowId(workItemId),
          work_item_id: workItemId,
          business_id: String(cur.business_id),
          mission_id: mission ? String(mission.mission_id) : null,
          bound_open_id:
            mission ? String(mission.bound_open_id ?? "") || null : null,
          child_work_item_ids: childIds,
          reviewer_agent_id: String(curReviewer.agent_id),
        };
        const candidateDigest = completionDigest(fields);
        // A committed ACCEPT pinning this exact completion (crash C:
        // evidence landed, projection didn't) — replay materializes the
        // pinned WCP + DONE and appends NO second ACCEPT event.
        const alreadyAccepted = this.store.listEvents("work_item", workItemId)
          .some((e) => {
            if (String(e.event_type) !== WORK_REVIEW_ACCEPTED_EVENT ||
                String(e.old_state ?? "") !== "REVIEW_REQUIRED" ||
                String(e.new_state ?? "") !== "DONE") return false;
            const md = (e.metadata as Record<string, unknown> | undefined) ?? {};
            return String(md.reviewer_agent_id ?? "") === String(curReviewer.agent_id) &&
              String(md.mission_id ?? "") === String(fields.mission_id ?? "") &&
              String(md.bound_open_id ?? "") === String(fields.bound_open_id ?? "") &&
              String(md.child_set_digest ?? "") === childSetDigest(childIds) &&
              String(md.completion_digest ?? "") === candidateDigest;
          });
        if (alreadyAccepted) {
          replayedAccept = true;
          const wcp = this.writeCompletionRecord(cur, fields, `operator:${actor}`);
          completionDigestPinned = String(wcp.completion_digest);
          cur.status = "DONE";
        } else {
          const wcp = this.writeCompletionRecord(cur, fields, `operator:${actor}`);
          completionDigestPinned = String(wcp.completion_digest);
          cur.status = "DONE";
        }
      } else {
        cur.status = "READY";
        cur.blockers = [];
      }
      cur.updated_at = utcnow();
      const savedCur = this.store.put("work_item", workItemId, cur, Number(cur.version));
      if (!replayedAccept) {
        this.store.event({
          entity_type: "work_item", entity_id: workItemId,
          event_type: decision === "ACCEPT" ? WORK_REVIEW_ACCEPTED_EVENT : "WORK_REWORK_REQUESTED",
          old_state: from,
          new_state: String(savedCur.status),
          actor: `operator:${actor}`,
          metadata: {
            reviewer_agent_id: String(curReviewer.agent_id),
            decision,
            mission_id: mission ? String(mission.mission_id) : null,
            bound_open_id: mission ? String(mission.bound_open_id ?? "") || null : null,
            child_work_item_ids: curBasis.childIds,
            child_set_digest: childSetDigest(curBasis.childIds),
            completion_digest: completionDigestPinned,
            // REWORK fences exactly this basis: the item may re-enter
            // REVIEW_REQUIRED only after completion authority advances
            // to a different basis digest — a new bound open/binding/
            // mission attempt, or a canonical child whose completion
            // record itself advanced (new WCP under a new attempt).
            rejected_child_basis_digest: decision === "REWORK"
              ? childBasisDigest(this.store, curBasis.childIds) : null,
            rejected_basis_digest:
              decision === "REWORK" ? curBasis.basisDigest : null,
          },
        });
      }
      if (decision === "ACCEPT") {
        // The review-pinned WCP validates only now that its ACCEPT
        // evidence exists inside the same txn.
        let wcp = this.store.get(
          WORK_COMPLETION_TABLE, completionRowId(workItemId));
        assertCanonicalWorkCompletion(this.graphAuthorityDeps(), wcp);
      }
      return savedCur;
    });
    if (decision === "ACCEPT") this.advanceCompletionCascade(workItemId);
    return saved;
  }

  unblockWorkItem(workItemId: string, actor: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    assertWorkItemTransition(String(row.status), "READY");
    row.blockers = [];
    row.status = "READY";
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_UNBLOCKED",
      old_state: "BLOCKED", new_state: "READY", actor: `operator:${actor}`,
    });
    return saved;
  }

  attachWorkItemArtifact(
    workItemId: string,
    artifact: { name: string; uri: string; content_type?: string },
    actor: string,
  ): Row {
    if (!String(artifact.name ?? "").trim() || !String(artifact.uri ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_ARTIFACT", "artifact name and uri required");
    }
    const row = this.store.get("work_item", workItemId);
    const artifacts = (row.artifacts as Array<Record<string, unknown>> | undefined) ?? [];
    artifacts.push({
      name: String(artifact.name).slice(0, 300),
      uri: String(artifact.uri).slice(0, 2000),
      content_type: artifact.content_type ?? null,
      at: utcnow(),
      by: actor,
    });
    row.artifacts = artifacts;
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_ARTIFACT",
      actor: `operator:${actor}`, metadata: { name: artifact.name },
    });
    return saved;
  }

  board(businessId: string): Record<string, Row[]> {
    this.getBusiness(businessId);
    this.reconcileOpenIntents(businessId);
    this.syncRoutineWorkItems(businessId);
    const items = this.listWorkItems(businessId);
    for (const w of items) {
      if (String(w.status) !== "IN_PROGRESS") continue;
      try {
        this.syncWorkItem(String(w.work_item_id));
      } catch (err) {
        // In-flight pending open intent — skip this tick; the reconcile
        // sweep or the opener's own catch path resolves it.
        if ((err as { code?: string }).code !== "FAIL_CLOSED_OPEN_INTENT_ACTIVE") throw err;
      }
    }
    const cols: Record<string, Row[]> = {};
    for (const s of WORK_ITEM_STATUSES) cols[s] = [];
    for (const w of this.listWorkItems(businessId)) {
      (cols[String(w.status)] ?? cols.BACKLOG).push(w);
    }
    return cols;
  }

  // ---------- budget_policy ----------

  createBudgetPolicy(input: {
    business_id: string;
    scope_type: BudgetScope;
    scope_id?: string;
    period: BudgetPeriod;
    max_missions: number;
    hard_stop?: boolean;
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "budget.create");
    this.getBusiness(input.business_id);
    if (!BUDGET_SCOPES.includes(input.scope_type)) {
      throw new IntegrityError("FAIL_CLOSED_BUDGET_SCOPE", String(input.scope_type));
    }
    if (!BUDGET_PERIODS.includes(input.period)) {
      throw new IntegrityError("FAIL_CLOSED_BUDGET_PERIOD", String(input.period));
    }
    if (!(input.max_missions > 0)) {
      throw new IntegrityError("FAIL_CLOSED_BUDGET_MAX", String(input.max_missions));
    }
    const scopeId =
      input.scope_type === "business" ? input.business_id : String(input.scope_id ?? "");
    if (!scopeId) throw new IntegrityError("FAIL_CLOSED_BUDGET_SCOPE_ID", "scope_id required");
    // Scope must resolve inside this business: agent scopes reference a real
    // org_agent of the business; department scopes must exist among its
    // agents. Fail closed on cross-business or dangling references.
    if (input.scope_type === "agent") {
      const ag = this.store.get("org_agent", scopeId);
      if (String(ag.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_BUDGET_SCOPE", `agent scope ${scopeId} outside business ${input.business_id}`);
      }
    }
    if (input.scope_type === "department") {
      const ok = this.listOrgAgents(input.business_id).some((a) => String(a.department) === scopeId);
      if (!ok) {
        throw new IntegrityError("FAIL_CLOSED_BUDGET_SCOPE", `department ${scopeId} has no agents in business ${input.business_id}`);
      }
    }
    const id = newId("BDG");
    const row = {
      budget_policy_id: id,
      business_id: input.business_id,
      scope_type: input.scope_type,
      scope_id: scopeId,
      period: input.period,
      max_missions: input.max_missions,
      hard_stop: input.hard_stop !== false,
      enabled: true,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("budget_policy", id, row, 0);
    this.store.event({
      entity_type: "budget_policy", entity_id: id, event_type: "BUDGET_POLICY_CREATED",
      new_state: "ENABLED", actor: `operator:${input.operator_id}`,
      metadata: { scope_type: input.scope_type, scope_id: scopeId, period: input.period, max_missions: input.max_missions },
    });
    return saved;
  }

  listBudgetPolicies(businessId?: string): Row[] {
    const all = this.store.list("budget_policy");
    return businessId ? all.filter((b) => String(b.business_id) === businessId) : all;
  }

  /**
   * Atomic budget gate: inside one BEGIN IMMEDIATE transaction, count
   * consumed missions plus HELD reservations for each applicable scope, and
   * — when under every limit — insert a HELD reservation in the same commit.
   * Two concurrent opens therefore serialize: the second sees the first's
   * reservation and fails closed. The reservation is settled on outcome
   * (consume on mission create / release on failure / TTL on crash), so a
   * rejected or crashed intent never permanently consumes capacity.
   * Returns the reservation id, or null when no policies apply.
   */
  private reserveBudget(
    businessId: string,
    department: string,
    agentId: string | null,
    refId: string,
  ): string | null {
    const policies = this.listBudgetPolicies(businessId).filter((p) => p.enabled !== false);
    if (policies.length === 0) return null;
    // The check + reservation insert is atomic inside the transaction; the
    // BUDGET_EXCEEDED audit event must be written OUTSIDE it — an event
    // written in the same txn is rolled back with the refusal.
    const result = this.store.immediate(() => {
      this.expireBudgetReservations();
      const missions = this.store.list("mission");
      const held = this.store.list("budget_reservation").filter((r) => String(r.status) === "HELD");
      const exceeded: Array<Record<string, unknown>> = [];
      let hardStop: { meta: Record<string, unknown>; detail: string } | null = null;
      for (const p of policies) {
        const scopeType = String(p.scope_type);
        const scopeId = String(p.scope_id);
        const applies =
          (scopeType === "business" && scopeId === businessId) ||
          (scopeType === "department" && scopeId === department) ||
          (scopeType === "agent" && scopeId === agentId);
        if (!applies) continue;
        const since = periodStart(p.period as BudgetPeriod, new Date());
        const key =
          scopeType === "agent" ? "org_agent_id" : scopeType === "department" ? "department" : "business_id";
        const usedMissions = missions.filter((m) => {
          const md = m.metadata as Record<string, unknown> | undefined;
          return String(md?.[key] ?? "") === scopeId && String(m.created_at ?? "") >= since;
        }).length;
        const usedHeld = held.filter((r) => {
          const match =
            scopeType === "business"
              ? String(r.business_id) === scopeId
              : scopeType === "department"
                ? String(r.business_id) === businessId && String(r.department) === scopeId
                : String(r.agent_id) === scopeId;
          return match && String(r.created_at ?? "") >= since;
        }).length;
        const used = usedMissions + usedHeld;
        if (used >= Number(p.max_missions)) {
          const meta = {
            budget_policy_id: String(p.budget_policy_id),
            scope_type: scopeType, scope_id: scopeId, used,
            max_missions: p.max_missions, period: p.period,
          };
          if (p.hard_stop) {
            hardStop = { meta, detail: `${scopeType}:${scopeId} ${used}/${p.max_missions} per ${p.period}` };
            break;
          }
          exceeded.push(meta);
        }
      }
      if (hardStop) return { rid: null, exceeded, hardStop };
      const rid = newId("BRS");
      const row = {
        reservation_id: rid,
        business_id: businessId,
        department: department || null,
        agent_id: agentId,
        status: "HELD",
        ref_id: refId,
        created_at: utcnow(),
        expires_at: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
        version: 0,
      };
      this.store.put("budget_reservation", rid, row, 0);
      return { rid, exceeded, hardStop: null };
    });
    for (const meta of result.exceeded.concat(result.hardStop ? [result.hardStop.meta] : [])) {
      this.store.event({
        entity_type: "budget_policy", entity_id: String(meta.budget_policy_id),
        event_type: "BUDGET_EXCEEDED", actor: "PAIR_BUSINESS_LAYER",
        metadata: {
          scope_type: meta.scope_type, scope_id: meta.scope_id, used: meta.used,
          max_missions: meta.max_missions, period: meta.period,
        },
      });
    }
    if (result.hardStop) {
      throw new PolicyError("FAIL_CLOSED_BUDGET_EXCEEDED", result.hardStop.detail);
    }
    return result.rid;
  }

  private consumeBudgetReservation(reservationId: string): void {
    const row = this.store.tryGet("budget_reservation", reservationId);
    if (!row || String(row.status) !== "HELD") return;
    row.status = "CONSUMED";
    row.updated_at = utcnow();
    this.store.put("budget_reservation", reservationId, row, Number(row.version));
  }

  private releaseBudgetReservation(reservationId: string): void {
    const row = this.store.tryGet("budget_reservation", reservationId);
    if (!row || String(row.status) !== "HELD") return;
    row.status = "RELEASED";
    row.updated_at = utcnow();
    this.store.put("budget_reservation", reservationId, row, Number(row.version));
  }

  private releaseBudgetReservationForRef(refId: string): void {
    for (const r of this.store.list("budget_reservation")) {
      if (String(r.ref_id) === refId && String(r.status) === "HELD") {
        this.releaseBudgetReservation(String(r.reservation_id));
      }
    }
  }

  /** Crash-gap repair: a HELD reservation past its TTL never produced a
   *  mission — release it so capacity isn't permanently consumed. */
  private expireBudgetReservations(): void {
    const now = utcnow();
    for (const r of this.store.list("budget_reservation")) {
      if (String(r.status) === "HELD" && String(r.expires_at ?? "") <= now) {
        r.status = "RELEASED";
        r.updated_at = utcnow();
        this.store.put("budget_reservation", String(r.reservation_id), r, Number(r.version));
      }
    }
  }

  // ---------- routine (compiles to mission_schedule) ----------

  createRoutine(input: {
    business_id: string;
    name: string;
    goal_template: string;
    cron: string;
    department?: string;
    assignee_agent_id?: string;
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "routine.create");
    if (!String(input.name ?? "").trim() || !String(input.goal_template ?? "").trim() || !String(input.cron ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_ROUTINE_FIELDS", "name, goal_template and cron required");
    }
    const business = this.getBusiness(input.business_id);
    let department = input.department ?? "";
    if (input.assignee_agent_id) {
      const agent = this.store.get("org_agent", input.assignee_agent_id);
      if (String(agent.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_ROUTINE_SCOPE", `assignee outside business ${input.business_id}`);
      }
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", String(agent.agent_id));
      }
      department = department || String(agent.department ?? "");
    }
    // Compile: the routine's recurring fire goes through the canonical
    // mission_schedule + tickSchedules path (digest + auto-expand included).
    const goal =
      `[ROUTINE ${input.name} | BUSINESS ${String(business.name)} | DEPT ${department || "-"}]\n` +
      input.goal_template;
    const sched = this.deps.schedules.create({
      goal,
      cron: input.cron,
      project_id: String(business.project_id),
      name: input.name,
      operator_id: input.operator_id,
      metadata: {
        business_id: input.business_id,
        department,
        org_agent_id: input.assignee_agent_id ?? null,
        routine_source: true,
      },
    });
    const id = newId("RTN");
    const row = {
      routine_id: id,
      business_id: input.business_id,
      name: input.name,
      goal_template: input.goal_template,
      cron: input.cron,
      department,
      assignee_agent_id: input.assignee_agent_id ?? null,
      schedule_id: String(sched.schedule_id),
      enabled: true,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("routine", id, row, 0);
    this.store.event({
      entity_type: "routine", entity_id: id, event_type: "ROUTINE_CREATED",
      new_state: "ENABLED", actor: `operator:${input.operator_id}`,
      metadata: { business_id: input.business_id, cron: input.cron, schedule_id: sched.schedule_id },
    });
    return saved;
  }

  listRoutines(businessId?: string): Row[] {
    const all = this.store.list("routine");
    return businessId ? all.filter((r) => String(r.business_id) === businessId) : all;
  }

  setRoutineEnabled(routineId: string, enabled: boolean, actor: string): Row {
    const row = this.store.get("routine", routineId);
    this.deps.schedules.setEnabled(String(row.schedule_id), enabled, actor);
    row.enabled = enabled;
    const saved = this.store.put("routine", routineId, row, Number(row.version));
    this.store.event({
      entity_type: "routine", entity_id: routineId, event_type: enabled ? "ROUTINE_ENABLED" : "ROUTINE_DISABLED",
      new_state: enabled ? "ENABLED" : "DISABLED", actor: `operator:${actor}`,
    });
    return saved;
  }

  /**
   * Project every schedule-fired routine mission onto the board as a
   * work_item (source=routine) so recurring work is visible and auditable
   * alongside manual work. Missions carry metadata.schedule_id; each gets
   * at most one work_item (deduped by mission membership in mission_ids).
   */
  private syncRoutineWorkItems(businessId: string): void {
    const routines = this.listRoutines(businessId);
    if (routines.length === 0) return;
    const bySchedule = new Map<string, Row>();
    for (const r of routines) bySchedule.set(String(r.schedule_id), r);
    const covered = new Set<string>();
    for (const w of this.store.list("work_item")) {
      for (const mid of (w.mission_ids as string[] | undefined) ?? []) covered.add(String(mid));
    }
    for (const m of this.store.list("mission")) {
      const md = m.metadata as Record<string, unknown> | undefined;
      const schedId = String(md?.schedule_id ?? "");
      const routine = bySchedule.get(schedId);
      const missionId = String(m.mission_id);
      if (!routine || covered.has(missionId)) continue;
      // Business isolation: a mission that references this routine's
      // schedule must also carry this business_id — corrupted or
      // foreign-business metadata never projects onto this board.
      if (String(md?.business_id ?? "") !== String(routine.business_id)) continue;
      const ms = String(m.status);
      const status: WorkItemStatus =
        ms === "COMPLETED" ? "DONE" :
        ms === "FAILED" ? "BLOCKED" :
        ms === "CANCELLED" ? "CANCELLED" :
        ms === "PAUSED" ? "BLOCKED" : "IN_PROGRESS";
      // Deterministic projection identity: the work-item id derives from
      // the mission id, so two concurrent projectors (restarts, parallel
      // board() calls, two connections) compute the same id — the loser's
      // create hits the atomic CAS and is treated as already-covered.
      const id = `WI_RT_${digest("routine-work-item:" + missionId).slice(0, 24)}`;
      const row = {
        work_item_id: id,
        business_id: businessId,
        title: `${String(routine.name)} run ${String(m.created_at).slice(0, 10)}`,
        goal: String(routine.goal_template),
        department: String(routine.department ?? ""),
        assignee_agent_id: routine.assignee_agent_id ?? null,
        objective_id: null,
        routine_id: String(routine.routine_id),
        priority: 50,
        source: "routine",
        status,
        mission_ids: [missionId],
        claimed_by: null,
        claim_token: null,
        claim_expires_at: null,
        comments: [],
        blockers: [],
        artifacts: [],
        result_summary: String(m.result ?? m.result_summary ?? "") || null,
        created_at: String(m.created_at ?? utcnow()),
        updated_at: utcnow(),
        version: 0,
      };
      try {
        this.store.put("work_item", id, row, 0);
      } catch (err) {
        // Concurrent projector already created this projection — the
        // deterministic id made the collision deterministic, not a duplicate.
        if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT" ||
            String((err as { message?: string })?.message ?? err).includes("FAIL_CLOSED_VERSION_CONFLICT")) {
          covered.add(missionId);
          continue;
        }
        throw err;
      }
      this.store.event({
        entity_type: "work_item", entity_id: id, event_type: "WORK_ITEM_CREATED",
        new_state: status, actor: "PAIR_BUSINESS_LAYER",
        metadata: { routine_id: routine.routine_id, mission_id: missionId, source: "routine" },
      });
      covered.add(missionId);
    }
  }

  // ---------- objective (goal tree) ----------

  createObjective(input: {
    business_id: string;
    title: string;
    description?: string;
    parent_objective_id?: string;
    metric?: string;
    target?: string;
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "objective.create");
    if (!String(input.title ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_TITLE", "objective title required");
    }
    this.getBusiness(input.business_id);
    if (input.parent_objective_id) {
      const parent = this.store.get("objective", input.parent_objective_id);
      if (String(parent.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_SCOPE", `parent outside business ${input.business_id}`);
      }
    }
    const id = newId("OBJ");
    const row = {
      objective_id: id,
      business_id: input.business_id,
      title: input.title,
      description: input.description ?? "",
      parent_objective_id: input.parent_objective_id ?? null,
      metric: input.metric ?? "",
      target: input.target ?? "",
      status: "ACTIVE",
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("objective", id, row, 0);
    this.store.event({
      entity_type: "objective", entity_id: id, event_type: "OBJECTIVE_CREATED",
      new_state: "ACTIVE", actor: `operator:${input.operator_id}`,
      metadata: { business_id: input.business_id, title: input.title },
    });
    return saved;
  }

  listObjectives(businessId?: string): Row[] {
    const all = this.store.list("objective");
    return (businessId ? all.filter((o) => String(o.business_id) === businessId) : all)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  // ---------- aggregate read ----------

  detail(businessId: string): Record<string, unknown> {
    return {
      business: this.getBusiness(businessId),
      agents: this.listOrgAgents(businessId),
      objectives: this.listObjectives(businessId),
      board: this.board(businessId),
      routines: this.listRoutines(businessId),
      budgets: this.listBudgetPolicies(businessId),
    };
  }
}
