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

export const WORK_ITEM_STATUSES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW_REQUIRED",
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
  BACKLOG: ["READY", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  // READY→READY is the reassign/refresh path; every other self-transition
  // (e.g. IN_PROGRESS→IN_PROGRESS, a duplicate open) is illegal.
  READY: ["READY", "IN_PROGRESS", "BLOCKED", "BACKLOG", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEW_REQUIRED", "DONE", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  // P14: an accepted review completes the node; a rework request returns
  // it to READY for another governed open; cancelled is terminal.
  REVIEW_REQUIRED: ["DONE", "READY", "BLOCKED", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

function assertWorkItemTransition(from: string, to: WorkItemStatus): void {
  if (!(WORK_ITEM_TRANSITIONS[from as WorkItemStatus] ?? []).includes(to)) {
    throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_TRANSITION", `${from} → ${to}`);
  }
}

/** Terminal work-item states — a terminal node can never silently reopen. */
export const TERMINAL_WORK_ITEM_STATUSES = new Set(["DONE", "CANCELLED"]);
/** Work-graph bounds (P14 §6/§7): delegation depth, business-graph size,
 *  children per decomposition — fail closed when exceeded. */
export const WORK_DELEGATION_DEPTH_CAP = Number(process.env.PAIR_WORK_DELEGATION_DEPTH_CAP ?? 5);
export const WORK_GRAPH_NODE_CAP = Number(process.env.PAIR_WORK_GRAPH_NODE_CAP ?? 64);
export const WORK_DECOMPOSE_CHILD_CAP = Number(process.env.PAIR_WORK_DECOMPOSE_CHILD_CAP ?? 16);

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
/** Context notes kept per org_agent; newest kept, oldest trimmed. */
const AGENT_CONTEXT_CAP = 30;
/** How many agent context notes are injected into a new mission goal. */
const AGENT_CONTEXT_INJECT = 5;
const COMMENT_CAP = 200;

function isClaimActive(row: Row, nowIso: string): boolean {
  return Boolean(row.claimed_by) && String(row.claim_expires_at ?? "") > nowIso;
}

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
    /** P14: declared capabilities matched against work_item
     *  required_capability at assign/claim/heartbeat. */
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
      capabilities: (input.capabilities ?? []).map(String),
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
    /** P14 work graph: parent node + dependency edges (same business,
     *  acyclic) — canonical, not caller-fabricated context. */
    parent_work_item_id?: string;
    depends_on?: string[];
    /** Capability an assignee/claimer must declare to work the node. */
    required_capability?: string;
    /** Completion requires a governed review before DONE. */
    requires_review?: boolean;
    reviewer_agent_id?: string;
    /** Delegation provenance (set by WorkforceService only). */
    delegated_from_work_item_id?: string;
    delegated_by_agent_id?: string;
    delegation_reason?: string;
    delegation_depth?: number;
    delegation_key?: string;
    decomposition_id?: string;
    /** Deterministic id — used only by governed delegation/decomposition
     *  so racing materializers collide on the version-0 INSERT instead of
     *  silently duplicating a node. Callers must not set it otherwise. */
    work_item_id?: string;
    operator_id: string;
  }): Row {
    if (!input.operator_id) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_item.create");
    if (!String(input.title ?? "").trim() || !String(input.goal ?? "").trim()) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_FIELDS", "title and goal required");
    }
    this.getBusiness(input.business_id);
    // R1 §1: graph validation + node-cap + insert are one serialized
    // boundary — concurrent creators cannot outrace the cap or validate
    // against a stale graph.
    return this.store.immediate(() => {
    let department = input.department ?? "";
    if (input.assignee_agent_id) {
      const agent = this.store.get("org_agent", input.assignee_agent_id);
      if (String(agent.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${input.business_id}`);
      }
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", String(agent.agent_id));
      }
      // R1 §7: an item never enters READY/BACKLOG assigned to an agent
      // that cannot declare its required capability — admission fails
      // closed here instead of leaving silently-unclaimable work.
      const reqCap0 = input.required_capability ? String(input.required_capability) : null;
      if (reqCap0 && !((agent.capabilities as string[] | undefined) ?? []).includes(reqCap0)) {
        throw new PolicyError(
          "FAIL_CLOSED_WORK_CAPABILITY",
          `assignee lacks required capability ${reqCap0}`,
        );
      }
      department = department || String(agent.department ?? "");
    }
    if (input.objective_id) {
      const obj = this.store.get("objective", input.objective_id);
      if (String(obj.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `objective outside business ${input.business_id}`);
      }
    }
    // P14 work graph: parent + dependency edges are canonical — every
    // reference must resolve inside THIS business and the resulting graph
    // must stay acyclic.
    const dependsOn = [...new Set((input.depends_on ?? []).map(String))];
    if (input.parent_work_item_id) {
      const parent = this.store.get("work_item", input.parent_work_item_id);
      if (String(parent.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_SCOPE", `parent outside business ${input.business_id}`);
      }
    }
    const id = input.work_item_id ?? newId("WI");
    this.assertGraphEdgesLegal(input.business_id, id, dependsOn);
    if (this.listWorkItems(input.business_id).length + 1 > WORK_GRAPH_NODE_CAP) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_BOUND", `business graph exceeds ${WORK_GRAPH_NODE_CAP} nodes`);
    }
    if (input.reviewer_agent_id) {
      const reviewer = this.store.get("org_agent", input.reviewer_agent_id);
      if (String(reviewer.business_id) !== input.business_id) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `reviewer outside business ${input.business_id}`);
      }
    }
    const depsSatisfied = this.depsSatisfiedDeps(input.business_id, dependsOn);
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
      // P14 graph fields — edges point at prerequisites; readiness is
      // reconstructed from canonical dep state, never trusted blindly.
      parent_work_item_id: input.parent_work_item_id ?? null,
      depends_on: dependsOn,
      required_capability: input.required_capability ?? null,
      requires_review: input.requires_review === true,
      reviewer_agent_id: input.reviewer_agent_id ?? null,
      delegated_from_work_item_id: input.delegated_from_work_item_id ?? null,
      delegated_by_agent_id: input.delegated_by_agent_id ?? null,
      delegation_reason: input.delegation_reason ?? null,
      delegation_depth: input.delegation_depth ?? 0,
      delegation_key: input.delegation_key ?? null,
      decomposition_id: input.decomposition_id ?? null,
      blocked_code: null as string | null,
      // READY only when an assignee exists AND prerequisites are already
      // satisfied; otherwise the node waits in BACKLOG (inbox projects
      // WAITING_DEPENDENCY for assigned-but-unsatisfied nodes).
      status: (input.assignee_agent_id && depsSatisfied ? "READY" : "BACKLOG") as WorkItemStatus,
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
    const saved = this.store.put("work_item", id, row, 0);
    this.store.event({
      entity_type: "work_item", entity_id: id, event_type: "WORK_ITEM_CREATED",
      new_state: row.status, actor: `operator:${input.operator_id}`,
      metadata: { business_id: input.business_id, title: input.title, source: row.source },
    });
    return saved;
    });
  }

  listWorkItems(businessId?: string): Row[] {
    const all = this.store.list("work_item");
    return (businessId ? all.filter((w) => String(w.business_id) === businessId) : all)
      .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  /* ---------------- work graph (P14) ---------------- */

  /**
   * Validate dependency edges for a node about to be created/mutated:
   * every referenced node exists in the SAME business, no self-edge, and
   * adding the edges cannot create a cycle. Dependencies point from a node
   * to its prerequisites — a cycle exists iff a prerequisite's ancestor
   * chain reaches back to the new node.
   */
  assertGraphEdgesLegal(businessId: string, nodeId: string, dependsOn: string[]): void {
    if (dependsOn.includes(nodeId)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_CYCLE", `${nodeId} depends on itself`);
    }
    for (const depId of dependsOn) {
      const dep = this.store.tryGet("work_item", depId);
      if (!dep) {
        throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_NODE", `unknown dependency ${depId}`);
      }
      if (String(dep.business_id) !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_SCOPE", `dependency ${depId} outside business ${businessId}`);
      }
      // Walk the dep's ancestor chain; reaching nodeId closes a cycle.
      const seen = new Set<string>();
      const queue = [depId];
      while (queue.length) {
        const curId = queue.pop() as string;
        if (curId === nodeId) {
          throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_CYCLE", `${nodeId} → ${depId} closes a cycle`);
        }
        if (seen.has(curId)) continue;
        seen.add(curId);
        const cur = this.store.tryGet("work_item", curId);
        for (const next of (cur?.depends_on as string[] | undefined) ?? []) queue.push(String(next));
        if (cur?.parent_work_item_id) queue.push(String(cur.parent_work_item_id));
      }
    }
  }

  /** All prerequisites DONE? Missing/foreign dep ids count as unsatisfied
   *  (they cannot exist legally, but never assume). */
  depsSatisfiedDeps(businessId: string, dependsOn: string[]): boolean {
    for (const depId of dependsOn) {
      const dep = this.store.tryGet("work_item", depId);
      if (!dep || String(dep.business_id) !== businessId || String(dep.status) !== "DONE") return false;
    }
    return true;
  }

  depsSatisfied(row: Row): boolean {
    return this.depsSatisfiedDeps(String(row.business_id), (row.depends_on as string[] | undefined) ?? []);
  }

  /**
   * Canonical dependency mutation (P14 §2): the only path that can change a
   * node's edges. Requires the caller's expected_version — versionless
   * mutation is impossible at the storage boundary — and re-validates
   * scope/acyclicity on every write.
   */
  updateWorkItemDeps(
    workItemId: string,
    dependsOn: string[],
    expectedVersion: number | undefined,
    actor: string,
  ): Row {
    if (!actor) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_item.deps");
    // R1 §1: validation + mutation serialize inside one BEGIN IMMEDIATE
    // transaction — two reciprocal edge writes can never interleave past
    // validation to form a canonical cycle.
    return this.store.immediate(() => {
      const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(row.status))) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${String(row.status)} cannot be mutated`);
      }
      const deps = [...new Set(dependsOn.map(String))];
      this.assertGraphEdgesLegal(String(row.business_id), workItemId, deps);
      row.depends_on = deps;
      row.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, row, expectedVersion as number);
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_DEPS_UPDATED",
        actor: `operator:${actor}`, metadata: { depends_on: deps },
      });
      this.propagateDependents(workItemId);
      return saved;
    });
  }

  /**
   * Dependency propagation (P14 §10): when a node reaches a terminal
   * state, update its dependents deterministically —
   *   prereq DONE              → dependents whose deps are now ALL done
   *                            promote BACKLOG→READY (assignee present);
   *   prereq CANCELLED/failed  → dependents BLOCKED with
   *                            DEPENDENCY_FAILED — never executable.
   * Runs recursively so multi-level chains settle in one sweep.
   */
  private propagateDependents(nodeId: string): void {
    const node = this.store.tryGet("work_item", nodeId);
    if (!node) return;
    const businessId = String(node.business_id);
    const nodeDone = String(node.status) === "DONE";
    const nodeFailed = TERMINAL_WORK_ITEM_STATUSES.has(String(node.status)) && !nodeDone;
    for (const dep of this.store.list("work_item")) {
      if (String(dep.business_id) !== businessId) continue;
      const deps = (dep.depends_on as string[] | undefined) ?? [];
      if (!deps.includes(nodeId)) continue;
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(dep.status))) continue;
      if (nodeDone) {
        if (String(dep.status) === "BACKLOG" && this.depsSatisfied(dep) && dep.assignee_agent_id) {
          dep.status = "READY";
          dep.updated_at = utcnow();
          const saved = this.store.put("work_item", String(dep.work_item_id), dep, Number(dep.version));
          this.store.event({
            entity_type: "work_item", entity_id: String(dep.work_item_id), event_type: "WORK_READY",
            old_state: "BACKLOG", new_state: "READY", actor: "PAIR_BUSINESS_LAYER",
            metadata: { prerequisite_done: nodeId },
          });
          this.propagateDependents(String(saved.work_item_id));
        }
      } else if (nodeFailed && String(dep.status) !== "BLOCKED") {
        const from = String(dep.status);
        assertWorkItemTransition(from, "BLOCKED");
        dep.status = "BLOCKED";
        dep.blocked_code = "DEPENDENCY_FAILED";
        dep.updated_at = utcnow();
        const saved = this.store.put("work_item", String(dep.work_item_id), dep, Number(dep.version));
        this.store.event({
          entity_type: "work_item", entity_id: String(dep.work_item_id), event_type: "WORK_BLOCKED",
          old_state: from, new_state: "BLOCKED", actor: "PAIR_BUSINESS_LAYER",
          metadata: { blocked_code: "DEPENDENCY_FAILED", prerequisite_failed: nodeId },
        });
        this.propagateDependents(String(saved.work_item_id));
      }
    }
    // R2 §3/§4: EVERY canonical DONE transition — mission fold, review
    // accept, any future path — re-evaluates a parent parked on
    // CHILD_INCOMPLETE. The parent's own completion propagates through
    // this same seam, so multi-level chains cascade deterministically.
    if (nodeDone && node.parent_work_item_id) {
      this.evaluateParentCompletion(String(node.parent_work_item_id));
    }
  }

  /**
   * R3 §4: restart reconciliation for partial terminal/legacy states.
   * Post-R3 a crash cannot leave half-committed finalization (the whole
   * fold is one transaction), but rows materialized by earlier versions —
   * or a DB restored mid-flight — may carry terminal status without its
   * audit provenance. This sweep repairs, idempotently:
   *   - terminal/REVIEW_REQUIRED item missing its WORK_ITEM_SYNCED event
   *     → runs propagation + context note (dedup-checked) and emits the
   *       missing event with cause=restart_reconcile;
   *   - terminal row still holding claim material → cleared;
   *   - DONE requires_review item missing WORK_REVIEW_ACCEPTED → emits
   *       the reconcile audit marker;
   *   - delegated child missing WORK_DELEGATED → emits it (repair only
   *       when no conflicting audit exists);
   *   - DONE child whose parent sits CHILD_INCOMPLETE → the
   *       propagateDependents hook re-evaluates the parent.
   * The whole repair runs inside one serialized transaction; repeated
   * runs produce no duplicate events, context entries or transitions.
   */
  private reconcileTerminalConsistency(businessId: string): void {
    this.store.immediate(() => {
      const events = this.store.listEvents();
      const syncedStates = new Set(
        events.filter((e) => e.event_type === "WORK_ITEM_SYNCED")
          .map((e) => `${String(e.entity_id)}|${String(e.new_state)}`),
      );
      const reviewed = new Set(
        events.filter((e) => e.event_type === "WORK_REVIEW_ACCEPTED")
          .map((e) => String(e.entity_id)),
      );
      const delegated = new Set(
        events.filter((e) => e.event_type === "WORK_DELEGATED")
          .map((e) => String((e.metadata as Record<string, unknown> | undefined)?.child_work_item_id ?? "")),
      );
      for (const w of this.listWorkItems(businessId)) {
        const st = String(w.status);
        const terminalish = TERMINAL_WORK_ITEM_STATUSES.has(st) || st === "REVIEW_REQUIRED";
        const id = String(w.work_item_id);
        // Delegated child without audit: repaired here ONLY when the row
        // already carries its delegation_key. A keyless legacy row is
        // left for the replay path, which repairs key + event atomically —
        // emitting a keyless event here would conflict-block that replay.
        if (w.delegated_from_work_item_id && w.delegation_key && !delegated.has(id)) {
          this.store.event({
            entity_type: "work_item", entity_id: String(w.delegated_from_work_item_id),
            event_type: "WORK_DELEGATED", actor: "PAIR_RECONCILE",
            metadata: {
              cause: "restart_reconcile",
              delegated_from: w.delegated_by_agent_id ?? null,
              delegated_to: w.assignee_agent_id ?? null,
              child_work_item_id: id,
              delegation_key: w.delegation_key,
            },
          });
          delegated.add(id);
        }
        if (!terminalish) continue;
        let dirty = false;
        if (w.claimed_by || w.claim_token || w.claim_expires_at) {
          w.claimed_by = null;
          w.claim_token = null;
          w.claim_expires_at = null;
          dirty = true;
        }
        if (w.blocked_code && st !== "BLOCKED") {
          w.blocked_code = null;
          dirty = true;
        }
        if (dirty) {
          w.updated_at = utcnow();
          this.store.put("work_item", id, w, Number(w.version));
        }
        if (st === "DONE" && w.requires_review === true && !reviewed.has(id)) {
          this.store.event({
            entity_type: "work_item", entity_id: id, event_type: "WORK_REVIEW_ACCEPTED",
            actor: "PAIR_RECONCILE",
            metadata: { cause: "restart_reconcile", reviewer_agent_id: w.reviewer_agent_id ?? null },
          });
          reviewed.add(id);
        }
        if (!syncedStates.has(`${id}|${st}`)) {
          // Missing sync provenance: re-run effects (propagation is
          // state-gated → idempotent) then emit the reconcile audit.
          this.propagateDependents(id);
          const assignee = w.assignee_agent_id ? String(w.assignee_agent_id) : null;
          if (assignee) {
            try {
              const agentRow = this.store.get("org_agent", assignee);
              const notes = (agentRow.context_notes as Array<Record<string, unknown>> | undefined) ?? [];
              if (!notes.some((n) => String(n.work_item_id) === id && String(n.outcome) === st)) {
                notes.push({
                  at: utcnow(), work_item_id: id,
                  mission_id: String((w.mission_ids as string[] | undefined)?.at(-1) ?? "") || null,
                  outcome: st,
                  note: String(w.result_summary ?? w.title ?? "").slice(0, 300),
                });
                agentRow.context_notes = notes.slice(-AGENT_CONTEXT_CAP);
                this.store.put("org_agent", assignee, agentRow, Number(agentRow.version));
              }
            } catch { /* agent removed — non-fatal */ }
          }
          this.store.event({
            entity_type: "work_item", entity_id: id, event_type: "WORK_ITEM_SYNCED",
            old_state: st, new_state: st, actor: "PAIR_RECONCILE",
            metadata: { cause: "restart_reconcile" },
          });
          syncedStates.add(`${id}|${st}`);
        }
      }
    });
  }

  /**
   * Restart reconstruction (P14 §10/§11): rebuild every node's readiness
   * from canonical dep state — promotes satisfied assigned nodes to READY
   * and re-blocks nodes under failed prerequisites. The terminal-
   * consistency sweep runs first so partial states close before readiness
   * is evaluated. Idempotent; safe to run on every board/heartbeat sweep.
   */
  rebuildReadiness(businessId: string): void {
    this.reconcileTerminalConsistency(businessId);
    for (const w of this.listWorkItems(businessId)) {
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(w.status))) continue;
      const deps = (w.depends_on as string[] | undefined) ?? [];
      // R1 §7: capability admission applies to every non-terminal node —
      // an incapable assignment is never promoted to (or parked at) READY;
      // it lands in explicit BLOCKED_CAPABILITY.
      const reqCapW = w.required_capability ? String(w.required_capability) : null;
      if (
        reqCapW && w.assignee_agent_id &&
        (String(w.status) === "BACKLOG" || String(w.status) === "READY")
      ) {
        const assigneeW = this.store.tryGet("org_agent", String(w.assignee_agent_id));
        const capableW =
          assigneeW && String(assigneeW.status) === "ACTIVE" &&
          ((assigneeW.capabilities as string[] | undefined) ?? []).includes(reqCapW);
        if (!capableW) {
          const fromW = String(w.status);
          w.status = "BLOCKED";
          w.blocked_code = "BLOCKED_CAPABILITY";
          w.updated_at = utcnow();
          this.store.put("work_item", String(w.work_item_id), w, Number(w.version));
          this.store.event({
            entity_type: "work_item", entity_id: String(w.work_item_id), event_type: "WORK_BLOCKED",
            old_state: fromW, new_state: "BLOCKED", actor: "PAIR_BUSINESS_LAYER",
            metadata: { blocked_code: "BLOCKED_CAPABILITY", required_capability: reqCapW, rebuilt: true },
          });
          continue;
        }
      }
      if (deps.length === 0) continue;
      if (!this.depsSatisfied(w)) {
        // Any prerequisite irrecoverably dead → this node is deterministically
        // blocked; otherwise it just keeps waiting.
        const failed = deps.some((depId) => {
          const dep = this.store.tryGet("work_item", depId);
          return dep && String(dep.business_id) === businessId &&
            TERMINAL_WORK_ITEM_STATUSES.has(String(dep.status)) && String(dep.status) !== "DONE";
        });
        if (failed && String(w.status) !== "BLOCKED") {
          const from = String(w.status);
          assertWorkItemTransition(from, "BLOCKED");
          w.status = "BLOCKED";
          w.blocked_code = "DEPENDENCY_FAILED";
          w.updated_at = utcnow();
          this.store.put("work_item", String(w.work_item_id), w, Number(w.version));
          this.store.event({
            entity_type: "work_item", entity_id: String(w.work_item_id), event_type: "WORK_BLOCKED",
            old_state: from, new_state: "BLOCKED", actor: "PAIR_BUSINESS_LAYER",
            metadata: { blocked_code: "DEPENDENCY_FAILED", rebuilt: true },
          });
        }
      } else if (String(w.status) === "BACKLOG" && w.assignee_agent_id) {
        w.status = "READY";
        w.updated_at = utcnow();
        this.store.put("work_item", String(w.work_item_id), w, Number(w.version));
        this.store.event({
          entity_type: "work_item", entity_id: String(w.work_item_id), event_type: "WORK_READY",
          old_state: "BACKLOG", new_state: "READY", actor: "PAIR_BUSINESS_LAYER",
          metadata: { rebuilt: true },
        });
      }
    }
  }

  assignWorkItem(workItemId: string, agentId: string, actor: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const agent = this.store.get("org_agent", agentId);
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${row.business_id}`);
    }
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    const from = String(row.status);
    assertWorkItemTransition(from, "READY");
    // P14 §8: the assignee must declare the capability the node requires.
    const reqCap = row.required_capability ? String(row.required_capability) : null;
    if (reqCap && !((agent.capabilities as string[] | undefined) ?? []).includes(reqCap)) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_CAPABILITY",
        `agent lacks required capability ${reqCap}`,
      );
    }
    // Reassigning an item actively claimed by someone else would strand the
    // new assignee behind a foreign claim — fail closed instead.
    if (isClaimActive(row, utcnow()) && String(row.claimed_by) !== agentId) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_ITEM_CLAIMED",
        `held by ${String(row.claimed_by)} until ${String(row.claim_expires_at)}`,
      );
    }
    row.assignee_agent_id = agentId;
    row.department = row.department || String(agent.department ?? "");
    row.status = "READY";
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_ASSIGNED",
      old_state: from, new_state: "READY", actor: `operator:${actor}`,
      metadata: { assignee_agent_id: agentId },
    });
    return saved;
  }

  /**
   * The single seam where business work enters the governed engine:
   * budget check (fail-closed) → enriched goal → canonical startMission →
   * work_item IN_PROGRESS with mission_id recorded.
   */
  openWorkItem(workItemId: string, operatorId: string): Row {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "work_item.open");
    const row = this.resolvePendingOpenBeforeMutation(workItemId, operatorId);
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
    // P14 §3: executable only when every dependency is DONE — readiness is
    // canonical state, never caller assertion.
    if (!this.depsSatisfied(row)) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_ITEM_DEPENDENCY",
        `unsatisfied prerequisites: ${((row.depends_on as string[] | undefined) ?? []).join(",")}`,
      );
    }
    const business = this.getBusiness(String(row.business_id));
    const agentId = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    const nowIso = utcnow();
    if (isClaimActive(row, nowIso) && String(row.claimed_by) !== agentId) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_ITEM_CLAIMED",
        `held by ${String(row.claimed_by)} until ${String(row.claim_expires_at)}`,
      );
    }
    let agent: Row | null = null;
    if (agentId) {
      agent = this.store.get("org_agent", agentId);
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
      }
    }
    // Durable open intent committed BEFORE mission creation: the transition
    // write is the dedup point, and pending_open_id ties this intent to the
    // mission it creates (metadata.work_item_open_id) so a crash at any
    // boundary can be reconciled instead of silently duplicated or rolled
    // back over a live mission.
    const openId = newId("OPI");
    row.status = "IN_PROGRESS";
    row.pending_open_id = openId;
    row.pending_open_at = utcnow();
    if (agentId) {
      row.claimed_by = agentId;
      row.claim_token = newId("CLM");
      row.claim_expires_at = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    }
    row.updated_at = utcnow();
    this.store.put("work_item", workItemId, row, Number(row.version));

    let reservationId: string | null = null;
    try {
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

      const mission = this.deps.control.startMission({
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
      const missionId = String(mission.mission_id);
      const linked = this.store.get("work_item", workItemId);
      const linkedIds = linked.mission_ids as string[];
      if (!linkedIds.includes(missionId)) linkedIds.push(missionId);
      if (String(linked.pending_open_id ?? "") === openId) {
        linked.pending_open_id = null;
        linked.pending_open_at = null;
      }
      linked.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, linked, Number(linked.version));
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
        const owned = new Set((curRow.mission_ids as string[] | undefined) ?? []);
        const mine = this.store
          .list("mission")
          .some(
            (m) =>
              owned.has(String(m.mission_id)) &&
              String(
                (m.metadata as Record<string, unknown> | undefined)?.work_item_open_id ?? "",
              ) === openId,
          );
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
        cur.status = from as WorkItemStatus;
        cur.claimed_by = null;
        cur.claim_token = null;
        cur.claim_expires_at = null;
        cur.pending_open_id = null;
        cur.pending_open_at = null;
        cur.updated_at = utcnow();
        this.store.put("work_item", workItemId, cur, Number(cur.version));
        this.store.event({
          entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPEN_ROLLED_BACK",
          old_state: "IN_PROGRESS", new_state: from, actor: "PAIR_BUSINESS_LAYER",
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
    const cur = this.store.get("work_item", workItemId);
    cur.status = "READY";
    cur.claimed_by = null;
    cur.claim_token = null;
    cur.claim_expires_at = null;
    cur.pending_open_id = null;
    cur.pending_open_at = null;
    cur.updated_at = utcnow();
    this.store.put("work_item", workItemId, cur, Number(cur.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPEN_ROLLED_BACK",
      old_state: "IN_PROGRESS", new_state: "READY", actor: `pair_reconcile:${actor}`,
      metadata: { open_id: openId, cause: "mutation_gate" },
    });
    this.releaseBudgetReservationForRef(openId);
    return this.store.get("work_item", workItemId);
  }

  /**
   * Link the mission belonging to an open intent back onto its work item.
   * Deterministic and idempotent: returns the repaired row when a mission
   * exists, null when provably none does. Used by the open catch path and
   * by the restart sweep in reconcileOpenIntents.
   */
  private reconcileOpenIntent(workItemId: string, openId: string, actor: string): Row | null {
    const row = this.store.tryGet("work_item", workItemId);
    if (!row) return null;
    const owned = new Set((row.mission_ids as string[] | undefined) ?? []);
    const orphan = this.store
      .list("mission")
      .filter((m) => {
        const md = m.metadata as Record<string, unknown> | undefined;
        if (owned.has(String(m.mission_id))) return false;
        return (
          String(md?.work_item_open_id ?? "") === openId ||
          String(md?.work_item_id ?? "") === workItemId
        );
      })
      .at(-1);
    if (!orphan) return null;
    (row.mission_ids as string[]).push(String(orphan.mission_id));
    row.pending_open_id = null;
    row.pending_open_at = null;
    row.updated_at = utcnow();
    let saved: Row;
    try {
      saved = this.store.put("work_item", workItemId, row, Number(row.version));
    } catch (err) {
      // A racing reconciler may have linked the same mission first — the
      // outcome is identical; return the fresh row instead of throwing.
      const fresh = this.store.get("work_item", workItemId);
      if ((fresh.mission_ids as string[]).includes(String(orphan.mission_id))) {
        return fresh;
      }
      throw err;
    }
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPEN_RECONCILED",
      new_state: String(row.status), actor: `pair_reconcile:${actor}`,
      metadata: { open_id: openId, mission_id: String(orphan.mission_id) },
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
      const last = this.store.tryGet("mission", missionIds[missionIds.length - 1]);
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
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_CANCELLED",
      old_state: from, new_state: "CANCELLED", actor: `operator:${actor}`,
      metadata: { mission_id: cancelledMission },
    });
    // P14 §10: a cancelled prerequisite deterministically blocks dependents.
    this.propagateDependents(workItemId);
    return saved;
  }

  /**
   * Governed review (P14 §9): REVIEW_REQUIRED → DONE (accept) or → READY
   * (rework). The reviewer must be an ACTIVE agent of the same business,
   * and when the node requires review it can never be self-approved by the
   * assignee that produced the unverified result. Review grants the
   * reviewer no execution authority.
   */
  reviewWorkItem(
    workItemId: string,
    input: { reviewer_agent_id: string; decision: "ACCEPT" | "REWORK"; note?: string },
    actor: string,
  ): Row {
    // R1 §4: the decision is an exact enum — missing/unknown values fail
    // closed rather than defaulting to ACCEPT.
    if (input.decision !== "ACCEPT" && input.decision !== "REWORK") {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEW_DECISION",
        `decision must be exactly ACCEPT or REWORK (got ${JSON.stringify(input.decision)})`,
      );
    }
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    if (String(row.status) !== "REVIEW_REQUIRED") {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEW_STATE",
        `${String(row.status)} is not awaiting review`,
      );
    }
    const reviewer = this.store.get("org_agent", input.reviewer_agent_id);
    // R1 §3: a named reviewer binds the decision to that exact canonical
    // agent — any other ACTIVE same-business reviewer is rejected.
    if (row.reviewer_agent_id && String(row.reviewer_agent_id) !== input.reviewer_agent_id) {
      throw new IntegrityError(
        "FAIL_CLOSED_WORK_REVIEWER_MISMATCH",
        `item is configured for reviewer ${String(row.reviewer_agent_id)}`,
      );
    }
    if (String(reviewer.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_REVIEW_SCOPE", `reviewer outside business ${String(row.business_id)}`);
    }
    if (String(reviewer.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", input.reviewer_agent_id);
    }
    if (input.reviewer_agent_id === String(row.assignee_agent_id ?? "")) {
      throw new IntegrityError("FAIL_CLOSED_WORK_REVIEW_SELF", "assignee cannot approve its own result");
    }
    // R1 §5: acceptance cannot fabricate completion while mandatory
    // children are unfinished.
    if (input.decision === "ACCEPT" && !this.mandatoryChildrenComplete(row)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PARENT_INCOMPLETE",
        "mandatory child work is not DONE — parent cannot complete",
      );
    }
    const to: WorkItemStatus = input.decision === "ACCEPT" ? "DONE" : "READY";
    // R3 §3: the decision, its audit event and all dependent effects
    // commit inside one serialized transaction — a fault anywhere rolls
    // back the whole review (child stays REVIEW_REQUIRED, nothing
    // propagates) instead of leaving DONE-without-evidence split-brain.
    return this.store.immediate(() => {
      row.status = to;
      row.updated_at = utcnow();
      if (input.decision === "REWORK") {
        const blockers = (row.blockers as Array<Record<string, unknown>> | undefined) ?? [];
        blockers.push({ reason: `REWORK: ${String(input.note ?? "").slice(0, 300)}`, at: utcnow(), by: input.reviewer_agent_id });
        row.blockers = blockers;
      }
      const saved = this.store.put("work_item", workItemId, row, Number(row.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId,
        event_type: input.decision === "ACCEPT" ? "WORK_REVIEW_ACCEPTED" : "WORK_REWORK_REQUESTED",
        old_state: "REVIEW_REQUIRED", new_state: to, actor: `operator:${actor}`,
        metadata: { reviewer_agent_id: input.reviewer_agent_id, note: String(input.note ?? "").slice(0, 300) },
      });
      if (input.decision === "ACCEPT") this.propagateDependents(workItemId);
      return saved;
    });
  }

  /** Fold the linked mission's terminal state back into the work item. */
  syncWorkItem(workItemId: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, "sync");
    const status = String(row.status);
    if (status !== "IN_PROGRESS") return row;
    const missionIds = (row.mission_ids as string[]) ?? [];
    if (missionIds.length === 0) return row;
    let mission: Row;
    try {
      mission = this.store.get("mission", missionIds[missionIds.length - 1]);
    } catch {
      return row; // mission not persisted yet — leave IN_PROGRESS
    }
    const ms = String(mission.status);
    // P14 §9: when the node requires review, a completed mission parks the
    // work in REVIEW_REQUIRED — DONE only follows governed acceptance.
    const next: WorkItemStatus | null =
      ms === "COMPLETED" ? (row.requires_review === true ? "REVIEW_REQUIRED" : "DONE") :
      ms === "FAILED" ? "BLOCKED" :
      ms === "CANCELLED" ? "CANCELLED" :
      ms === "PAUSED" ? "BLOCKED" : null;
    if (!next) return row;
    // R1 §5: mandatory children are only complete at DONE — a CANCELLED
    // child does not count (the parent must be cancelled explicitly or the
    // child reworked), so a parent never fabricates completion while
    // materialized child work is outstanding.
    if ((next === "DONE" || next === "REVIEW_REQUIRED") && !this.mandatoryChildrenComplete(row)) {
      // Idempotent park: no version churn on repeated sync sweeps.
      if (String(row.blocked_code ?? "") === "CHILD_INCOMPLETE") return row;
      row.blocked_code = "CHILD_INCOMPLETE";
      row.updated_at = utcnow();
      return this.store.put("work_item", workItemId, row, Number(row.version));
    }
    assertWorkItemTransition(status, next);
    return this.finalizeWorkItem(row, status, next, mission, {
      mission_id: missionIds[missionIds.length - 1],
      mission_status: ms,
    });
  }

  /**
   * Canonical completion finalization (R2 §5): ONE implementation of the
   * DONE/REVIEW_REQUIRED fold — status transition, blocked_code clear,
   * claim/token/expiry release, result grounding, CAS write, dependent
   * propagation (which itself re-evaluates a parked parent), assignee
   * context note, and the WORK_ITEM_SYNCED audit event. Concurrent
   * completions converge: a loser of the CAS write re-reads the row and
   * returns the winner's identical terminal state — no duplicate
   * transition, no duplicate event.
   */
  private finalizeWorkItem(
    row: Row,
    from: WorkItemStatus,
    next: WorkItemStatus,
    mission: Row | null,
    meta: Record<string, unknown>,
  ): Row {
    const workItemId = String(row.work_item_id);
    try {
      // R3 §2: every authoritative finalization effect — status/result/
      // claim write, dependency propagation (including parent completion
      // evaluation), agent outcome bookkeeping and the WORK_ITEM_SYNCED
      // audit event — commits inside ONE serialized transaction. A fault
      // anywhere rolls back the whole fold; nothing reaches canonical
      // terminal state with missing provenance.
      return this.store.immediate(() => {
        assertWorkItemTransition(from, next);
        row.status = next;
        row.blocked_code = null;
        row.updated_at = utcnow();
        if (next === "DONE" || next === "BLOCKED" || next === "REVIEW_REQUIRED") {
          const grounded = mission
            ? String(mission.result ?? mission.result_summary ?? "") || null
            : null;
          if (grounded !== null) row.result_summary = grounded;
        }
        row.claimed_by = null;
        row.claim_token = null;
        row.claim_expires_at = null;
        const saved = this.store.put("work_item", workItemId, row, Number(row.version));
        this.propagateDependents(workItemId);
        const assignee = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
        if (assignee) {
          try {
            const agentRow = this.store.get("org_agent", assignee);
            const notes = (agentRow.context_notes as Array<Record<string, unknown>> | undefined) ?? [];
            notes.push({
              at: utcnow(),
              work_item_id: workItemId,
              mission_id: mission ? String(mission.mission_id) : null,
              outcome: next,
              note: String(row.result_summary ?? row.title ?? "").slice(0, 300),
            });
            agentRow.context_notes = notes.slice(-AGENT_CONTEXT_CAP);
            this.store.put("org_agent", assignee, agentRow, Number(agentRow.version));
          } catch { /* agent removed — context drop is non-fatal */ }
        }
        this.store.event({
          entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_SYNCED",
          old_state: from, new_state: next, actor: "PAIR_BUSINESS_LAYER",
          metadata: meta,
        });
        return saved;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        const fresh = this.store.get("work_item", workItemId);
        if (String(fresh.status) === next) return fresh; // converged already
      }
      throw err;
    }
  }

  /**
   * R1 §5: every materialized child (delegation/decomposition) of this
   * node must be DONE before the node itself may complete. CANCELLED
   * children do NOT count as complete — documented fail-closed policy:
   * completion is never fabricated; the parent must be cancelled
   * explicitly or the cancelled child reworked/replaced.
   */
  mandatoryChildrenComplete(parentRow: Row): boolean {
    const pid = String(parentRow.work_item_id);
    return this.store
      .list("work_item")
      .filter((c) => String(c.parent_work_item_id) === pid)
      .every((c) => String(c.status) === "DONE");
  }

  /**
   * R1 §5 / R2 §3-5: when the last mandatory child goes DONE, a parent
   * parked at IN_PROGRESS/CHILD_INCOMPLETE resumes completion through the
   * SAME canonical finalization as syncWorkItem — grounded in the
   * parent's already-completed mission (DONE, or REVIEW_REQUIRED when
   * requires_review). A parked parent always has a completed mission; if
   * it is somehow absent the parent stays parked — completion is never
   * fabricated.
   */
  private evaluateParentCompletion(parentId: string): void {
    if (!parentId) return;
    const parent = this.store.tryGet("work_item", parentId);
    if (!parent) return;
    if (String(parent.status) !== "IN_PROGRESS" || String(parent.blocked_code ?? "") !== "CHILD_INCOMPLETE") return;
    if (!this.mandatoryChildrenComplete(parent)) return;
    const mids = (parent.mission_ids as string[] | undefined) ?? [];
    const mission = mids.length ? this.store.tryGet("mission", mids[mids.length - 1]) : null;
    if (!mission) return;
    const next: WorkItemStatus = parent.requires_review === true ? "REVIEW_REQUIRED" : "DONE";
    this.finalizeWorkItem(parent, "IN_PROGRESS", next, mission, {
      cause: "children_complete",
      mission_id: String(mission.mission_id),
      mission_status: String(mission.status),
    });
  }

  // ---------- work_item collaboration (claim / comment / blocker / artifact) ----------

  /**
   * Atomic checkout: an agent takes the item off the board so no second
   * agent works it concurrently. Fail-closed while another claim is live.
   */
  claimWorkItem(workItemId: string, agentId: string, actor: string): Row & { claim_token: string } {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const agent = this.store.get("org_agent", agentId);
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `claimer outside business ${row.business_id}`);
    }
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    const status = String(row.status);
    if (status === "DONE" || status === "CANCELLED") {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${status} cannot be claimed`);
    }
    const reqCapClaim = row.required_capability ? String(row.required_capability) : null;
    if (reqCapClaim && !((agent.capabilities as string[] | undefined) ?? []).includes(reqCapClaim)) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_CAPABILITY",
        `agent lacks required capability ${reqCapClaim}`,
      );
    }
    const nowIso = utcnow();
    if (isClaimActive(row, nowIso) && String(row.claimed_by) !== agentId) {
      throw new PolicyError(
        "FAIL_CLOSED_WORK_ITEM_CLAIMED",
        `held by ${String(row.claimed_by)} until ${String(row.claim_expires_at)}`,
      );
    }
    const token = newId("CLM");
    row.claimed_by = agentId;
    row.claim_token = token;
    row.claim_expires_at = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    row.updated_at = nowIso;
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_CLAIMED",
      actor: `operator:${actor}`, metadata: { claimed_by: agentId },
    });
    return { ...saved, claim_token: token };
  }

  releaseClaim(workItemId: string, actor: string, claimToken?: string): Row {
    const row = this.resolvePendingOpenBeforeMutation(workItemId, actor);
    const heldBy = row.claimed_by ? String(row.claimed_by) : null;
    // A live claim can only be released with its claim_token — a stale or
    // absent token cannot strip another agent's ownership. Expired claims
    // are releasable without a token (reclaim semantics).
    if (isClaimActive(row, utcnow()) && claimToken !== String(row.claim_token ?? "")) {
      throw new PolicyError(
        "FAIL_CLOSED_CLAIM_TOKEN",
        `live claim held by ${heldBy} — matching claim_token required`,
      );
    }
    row.claimed_by = null;
    row.claim_token = null;
    row.claim_expires_at = null;
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    if (heldBy) {
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_CLAIM_RELEASED",
        actor: `operator:${actor}`, metadata: { released_from: heldBy },
      });
    }
    return saved;
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
      const missionIds = (row.mission_ids as string[] | undefined) ?? [];
      if (missionIds.length > 0) {
        const last = this.store.tryGet("mission", missionIds[missionIds.length - 1]);
        if (last && !TERMINAL_MISSION_STATUSES.has(String(last.status))) {
          this.deps.control.pauseMission(String(last.mission_id), actor);
          pausedMission = String(last.mission_id);
        }
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
    // P14 §10/§11: readiness is always reconstructed from canonical dep
    // state — a restart never resurrects stale queue memory.
    this.rebuildReadiness(businessId);
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
