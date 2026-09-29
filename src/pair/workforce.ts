/**
 * P14 AUTONOMOUS WORKFORCE — governed work-graph coordination on top of the
 * canonical work_item lifecycle.
 *
 * Architecture rule (mandatory): this service COORDINATES work — it never
 * executes it. There is no second router, dispatcher, execution engine,
 * mission lifecycle, or permission authority here. Every piece of work a
 * heartbeat claims travels the single canonical chain:
 *
 *   work_item (graph node)
 *   → BusinessLayer.openWorkItem (claim + budget + durable open intent)
 *   → MissionControl.startMission → Planner → MissionRouter
 *   → GovernedTaskGate → ExecutorAdapter → canonical evidence
 *
 * The graph lives ON work_item rows (parent_work_item_id / depends_on /
 * delegation provenance) — one canonical work unit, fully durable, audited
 * by the same entity/event store. Read models (workGraph, agentInbox) are
 * projections only: seeing work grants no authority; every existing gate
 * (P12 contract, P13 cost/secret, approvals, budget) still applies at open.
 */
import { createHash } from "node:crypto";
import { IntegrityError, PolicyError } from "./errors.js";
import { utcnow } from "./canonical.js";
import {
  WORK_DECOMPOSE_CHILD_CAP,
  WORK_DELEGATION_DEPTH_CAP,
  WORK_GRAPH_NODE_CAP,
  TERMINAL_WORK_ITEM_STATUSES,
  type BusinessLayer,
} from "./business.js";
import type { PairEvidenceStore } from "./store.js";

type Row = Record<string, unknown> & { version: number };

/** Deterministic node ids: racing materializers collide on the version-0
 *  INSERT — one winner, loser returns the canonical row. Exactly-once
 *  child materialization survives concurrent workers and replays. */
function childNodeId(prefix: "DL" | "DC", parentId: string, key: string): string {
  return `WI_${prefix}_${createHash("sha256").update(`${parentId}|${key}`).digest("hex").slice(0, 20).toUpperCase()}`;
}

export interface WorkforceDeps {
  store: PairEvidenceStore;
  business: BusinessLayer;
}

export interface HeartbeatOutcome {
  agent_id: string;
  opened: Array<{ work_item_id: string; mission_id: string | null }>;
  skipped: Array<{ work_item_id: string; reason: string }>;
}

export class WorkforceService {
  constructor(private readonly deps: WorkforceDeps) {}

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }

  private get business(): BusinessLayer {
    return this.deps.business;
  }

  private node(id: string): Row {
    return this.store.get("work_item", id);
  }

  private agent(id: string): Row {
    return this.store.get("org_agent", id);
  }

  /** Children of a parent node (delegation/decomposition provenance). */
  childrenOf(workItemId: string): Row[] {
    return this.store
      .list("work_item")
      .filter((w) => String(w.parent_work_item_id ?? "") === workItemId);
  }

  /**
   * Canonical graph projection for a business — identifiers and metadata
   * only. Read model: grants no authority.
   */
  workGraph(businessId: string): { nodes: Row[]; edges: Array<{ from: string; to: string }> } {
    const nodes = this.business.listWorkItems(businessId);
    const edges: Array<{ from: string; to: string }> = [];
    for (const n of nodes) {
      for (const dep of (n.depends_on as string[] | undefined) ?? []) {
        edges.push({ from: String(n.work_item_id), to: String(dep) });
      }
      if (n.parent_work_item_id) {
        edges.push({ from: String(n.parent_work_item_id), to: String(n.work_item_id) });
      }
    }
    return { nodes, edges };
  }

  /**
   * Agent inbox read model (§4). READY is computed against canonical dep
   * state at read time; WAITING_DEPENDENCY covers assigned work whose
   * prerequisites are unsatisfied. Projection only — never authority.
   */
  agentInbox(agentId: string): {
    ready: Row[];
    in_progress: Row[];
    blocked: Row[];
    waiting_dependency: Row[];
    review_required: Row[];
    recently_completed: Row[];
  } {
    const agent = this.agent(agentId);
    const businessId = String(agent.business_id);
    // R1 §6: strictly read-only — readiness reconciliation lives on
    // mutation seams (heartbeat/board/recovery); inbox computes against
    // canonical state and must never write or emit events.
    const mine = this.business
      .listWorkItems(businessId)
      .filter((w) => String(w.assignee_agent_id ?? "") === agentId);
    const ready: Row[] = [];
    const inProgress: Row[] = [];
    const blocked: Row[] = [];
    const waiting: Row[] = [];
    const review: Row[] = [];
    const done: Row[] = [];
    for (const w of mine) {
      const st = String(w.status);
      if (st === "READY") {
        (this.business.depsSatisfied(w) ? ready : waiting).push(w);
      } else if (st === "IN_PROGRESS") inProgress.push(w);
      else if (st === "BLOCKED") blocked.push(w);
      else if (st === "REVIEW_REQUIRED") review.push(w);
      else if (st === "BACKLOG") {
        (this.business.depsSatisfied(w) ? ready : waiting).push(w);
      } else if (TERMINAL_WORK_ITEM_STATUSES.has(st)) done.push(w);
    }
    return {
      ready, in_progress: inProgress, blocked,
      waiting_dependency: waiting, review_required: review,
      recently_completed: done.slice(-10),
    };
  }

  /**
   * Workforce assignment (§8): assign to an ACTIVE agent of the same
   * business declaring the node's required capability. When no agent is
   * eligible, the node is marked explicitly BLOCKED/BLOCKED_CAPABILITY —
   * never pretended executable.
   */
  assignWork(workItemId: string, agentId: string, actor: string): Row {
    const row = this.node(workItemId);
    const agent = this.agent(agentId);
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${String(row.business_id)}`);
    }
    return this.business.assignWorkItem(workItemId, agentId, actor);
  }

  /** Pick the least-loaded eligible agent; none → explicit BLOCKED. */
  autoAssign(workItemId: string, actor: string): Row {
    const row = this.node(workItemId);
    const businessId = String(row.business_id);
    if (TERMINAL_WORK_ITEM_STATUSES.has(String(row.status))) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${String(row.status)} cannot be assigned`);
    }
    const reqCap = row.required_capability ? String(row.required_capability) : null;
    const eligible = this.business
      .listOrgAgents(businessId)
      .filter(
        (a) =>
          String(a.status) === "ACTIVE" &&
          (!reqCap || ((a.capabilities as string[] | undefined) ?? []).includes(reqCap)),
      )
      .sort((a, b) => this.liveClaims(String(a.agent_id)) - this.liveClaims(String(b.agent_id)));
    if (eligible.length === 0) {
      const blocked = this.business.blockWorkItem(
        workItemId,
        `BLOCKED_CAPABILITY: no eligible agent${reqCap ? ` for ${reqCap}` : ""}`,
        actor,
      );
      blocked.blocked_code = "BLOCKED_CAPABILITY";
      return this.store.put("work_item", workItemId, blocked, Number(blocked.version));
    }
    return this.business.assignWorkItem(workItemId, String(eligible[0].agent_id), actor);
  }

  private liveClaims(agentId: string): number {
    return this.store
      .list("work_item")
      .filter((w) => String(w.claimed_by ?? "") === agentId && !TERMINAL_WORK_ITEM_STATUSES.has(String(w.status)))
      .length;
  }

  /**
   * Governed delegation (§6): an ACTIVE agent of the business delegates a
   * child node to another ACTIVE agent of the same business. Canonical and
   * audited; bounded by delegation depth and graph size; idempotent via
   * `delegation_key` (or implicit target+reason key). Delegation can never
   * expand authority — the child is an ordinary work item under every
   * existing gate.
   */
  delegateWorkItem(
    input: {
      work_item_id: string;
      delegated_by_agent_id: string;
      delegated_to_agent_id: string;
      reason?: string;
      delegation_key?: string;
    },
    actor: string,
  ): Row {
    const parent = this.node(input.work_item_id);
    const businessId = String(parent.business_id);
    const by = this.agent(input.delegated_by_agent_id);
    const to = this.agent(input.delegated_to_agent_id);
    if (String(by.business_id) !== businessId) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SCOPE", "delegator outside business");
    }
    if (String(to.business_id) !== businessId) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SCOPE", "target outside business");
    }
    if (String(by.status) !== "ACTIVE" || String(to.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", "delegator or target not ACTIVE");
    }
    if (input.delegated_to_agent_id === input.delegated_by_agent_id) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATE_SELF", "cannot delegate to self");
    }
    if (TERMINAL_WORK_ITEM_STATUSES.has(String(parent.status))) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${String(parent.status)} cannot delegate`);
    }
    const depth = Number(parent.delegation_depth ?? 0) + 1;
    if (depth > WORK_DELEGATION_DEPTH_CAP) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DELEGATION_BOUND", `depth ${depth} exceeds cap ${WORK_DELEGATION_DEPTH_CAP}`);
    }
    if (this.business.listWorkItems(businessId).length + 1 > WORK_GRAPH_NODE_CAP) {
      throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_BOUND", `business graph exceeds ${WORK_GRAPH_NODE_CAP} nodes`);
    }
    // Required capability: the delegatee must still satisfy it — delegation
    // narrows, never expands.
    const reqCap = parent.required_capability ? String(parent.required_capability) : null;
    if (reqCap && !((to.capabilities as string[] | undefined) ?? []).includes(reqCap)) {
      throw new PolicyError("FAIL_CLOSED_WORK_CAPABILITY", `delegatee lacks required capability ${reqCap}`);
    }
    // Idempotent + racing-safe: the child's id is a deterministic function
    // of (parent, key) — two workers colliding on the same delegation
    // serialize at the version-0 INSERT; the loser returns the canonical
    // child instead of a duplicate node.
    const key =
      input.delegation_key ??
      `${input.work_item_id}:${input.delegated_to_agent_id}:${String(input.reason ?? "")}`;
    const childId = childNodeId("DL", input.work_item_id, key);
    const prior = this.store.tryGet("work_item", childId);
    if (prior) return prior;
    let child: Row;
    try {
      child = this.business.createWorkItem({
        business_id: businessId,
        title: `[delegated] ${String(parent.title)}`,
        goal: String(parent.goal),
        assignee_agent_id: input.delegated_to_agent_id,
        parent_work_item_id: input.work_item_id,
        required_capability: reqCap ?? undefined,
        requires_review: parent.requires_review === true,
        reviewer_agent_id: parent.reviewer_agent_id ? String(parent.reviewer_agent_id) : undefined,
        delegated_from_work_item_id: input.work_item_id,
        delegated_by_agent_id: input.delegated_by_agent_id,
        delegation_reason: String(input.reason ?? "").slice(0, 500) || undefined,
        delegation_depth: depth,
        source: "delegation",
        work_item_id: childId,
        operator_id: actor,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        return this.node(childId);
      }
      throw err;
    }
    this.store.put("work_item", childId, { ...child, delegation_key: key }, Number(child.version));
    this.store.event({
      entity_type: "work_item", entity_id: input.work_item_id, event_type: "WORK_DELEGATED",
      actor: `operator:${actor}`,
      metadata: {
        delegated_from: input.delegated_by_agent_id,
        delegated_to: input.delegated_to_agent_id,
        child_work_item_id: childId,
        delegation_key: key,
      },
    });
    return child;
  }

  /**
   * Governed decomposition (§7): a proposal (model- or operator-authored)
   * is validated and materialized deterministically. Children inherit the
   * parent's canonical business context — caller-supplied business
   * identity is never trusted. Atomic: all-or-nothing materialization;
   * idempotent: the same decomposition_id returns the existing children.
   */
  decomposeWorkItem(
    workItemId: string,
    input: {
      decomposition_id: string;
      children: Array<{
        title: string;
        goal: string;
        assignee_agent_id?: string;
        /** Indices into `children` — sibling prerequisites. */
        depends_on_indices?: number[];
        requires_review?: boolean;
      }>;
    },
    actor: string,
  ): { parent: Row; children: Row[] } {
    const decompId = String(input.decomposition_id ?? "").trim();
    if (!decompId) throw new IntegrityError("FAIL_CLOSED_WORK_DECOMPOSE", "decomposition_id required");
    if (!Array.isArray(input.children) || input.children.length === 0) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DECOMPOSE", "children required");
    }
    if (input.children.length > WORK_DECOMPOSE_CHILD_CAP) {
      throw new IntegrityError("FAIL_CLOSED_WORK_DECOMPOSE", `>${WORK_DECOMPOSE_CHILD_CAP} children`);
    }
    // R1 §2: claim of the decomposition authority + proposal validation
    // + child materialization + parent binding + evidence are ONE
    // serialized transaction — a crash mid-way rolls back cleanly, a
    // racing different decomposition fails closed with a stable conflict
    // code, and the same decomposition_id replays idempotently.
    return this.store.immediate(() => {
      const parent = this.node(workItemId);
      const businessId = String(parent.business_id);
      // Idempotent: this decomposition already materialized → return it.
      if (String(parent.decomposition_id ?? "") === decompId) {
        return { parent, children: this.childrenOf(workItemId) };
      }
      if (parent.decomposition_id) {
        throw new IntegrityError(
          "FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT",
          `already decomposed as ${String(parent.decomposition_id)}`,
        );
      }
      if (TERMINAL_WORK_ITEM_STATUSES.has(String(parent.status))) {
        throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${String(parent.status)} cannot decompose`);
      }
      if (this.business.listWorkItems(businessId).length + input.children.length > WORK_GRAPH_NODE_CAP) {
        throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_BOUND", `business graph exceeds ${WORK_GRAPH_NODE_CAP} nodes`);
      }
      const reqCap = parent.required_capability ? String(parent.required_capability) : undefined;
      // Validate proposal deterministically before any write: sibling dep
      // indices in range, acyclic by construction (indices point at
      // earlier siblings only), assignees valid ACTIVE agents of the
      // business, and (R1 §7) able to satisfy the inherited capability.
      for (const [i, c] of input.children.entries()) {
        for (const depIdx of c.depends_on_indices ?? []) {
          if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= input.children.length) {
            throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_NODE", `child ${i} dep index ${depIdx}`);
          }
          if (depIdx >= i) {
            throw new IntegrityError("FAIL_CLOSED_WORK_GRAPH_CYCLE", `child ${i} depends on later sibling ${depIdx}`);
          }
        }
        if (c.assignee_agent_id) {
          const ag = this.agent(c.assignee_agent_id);
          if (String(ag.business_id) !== businessId) {
            throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `child ${i} assignee outside business`);
          }
          if (String(ag.status) !== "ACTIVE") {
            throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", c.assignee_agent_id);
          }
          if (reqCap && !((ag.capabilities as string[] | undefined) ?? []).includes(reqCap)) {
            throw new PolicyError(
              "FAIL_CLOSED_WORK_CAPABILITY",
              `child ${i} assignee lacks required capability ${reqCap}`,
            );
          }
        }
      }
      // Deterministic child ids — a retried/raced decomposition
      // materializes the same nodes; the version-0 INSERT makes each
      // write exactly-once.
      const childIds = input.children.map((_, i) => childNodeId("DC", workItemId, `${decompId}|${i}`));
      const children: Row[] = [];
      for (const [i, c] of input.children.entries()) {
        const depIds = (c.depends_on_indices ?? []).map((j) => childIds[j]);
        const existing = this.store.tryGet("work_item", childIds[i]);
        if (existing) {
          children.push(existing);
          continue;
        }
        children.push(
          this.business.createWorkItem({
            business_id: businessId, // canonical context from the parent row
            title: String(c.title),
            goal: String(c.goal),
            assignee_agent_id: c.assignee_agent_id,
            parent_work_item_id: workItemId,
            depends_on: depIds,
            required_capability: reqCap,
            requires_review: c.requires_review === true,
            decomposition_id: decompId,
            source: "decomposition",
            work_item_id: childIds[i],
            operator_id: actor,
          }),
        );
      }
      const cur = this.node(workItemId);
      cur.decomposition_id = decompId;
      cur.updated_at = utcnow();
      const saved = this.store.put("work_item", workItemId, cur, Number(cur.version));
      this.store.event({
        entity_type: "work_item", entity_id: workItemId, event_type: "WORK_DECOMPOSED",
        actor: `operator:${actor}`,
        metadata: { decomposition_id: decompId, child_ids: children.map((c) => String(c.work_item_id)) },
      });
      return { parent: saved, children };
    });
  }

  /**
   * Autonomous heartbeat (§5): an ACTIVE agent inspects its canonical
   * inbox, claims eligible READY work atomically, and opens it through the
   * canonical openWorkItem seam (budget → durable intent → startMission).
   * Deterministic and restart-safe: claims are CAS, opens are deduped by
   * pending_open_id, missions are deduped by the canonical open id, and
   * the existing single-dispatch machinery governs every external action.
   * Failures stop the item cleanly — never broaden, never blind-retry.
   */
  heartbeat(agentId: string, actor: string): HeartbeatOutcome {
    const agent = this.agent(agentId);
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    const businessId = String(agent.business_id);
    // R1 §6: the heartbeat is the mutation seam — reconcile canonical
    // readiness before reading the (read-only) inbox.
    this.business.rebuildReadiness(businessId);
    const outcome: HeartbeatOutcome = { agent_id: agentId, opened: [], skipped: [] };
    const inbox = this.agentInbox(agentId);
    for (const w of inbox.ready) {
      const workItemId = String(w.work_item_id);
      try {
        // Atomic claim first — two racing heartbeats cannot both own it.
        this.business.claimWorkItem(workItemId, agentId, actor);
      } catch (err) {
        outcome.skipped.push({ work_item_id: workItemId, reason: (err as { code?: string }).code ?? String(err) });
        continue;
      }
      try {
        const opened = this.business.openWorkItem(workItemId, `heartbeat:${agentId}`);
        const mids = (opened.mission_ids as string[] | undefined) ?? [];
        outcome.opened.push({
          work_item_id: workItemId,
          mission_id: mids.length ? String(mids[mids.length - 1]) : null,
        });
      } catch (err) {
        outcome.skipped.push({ work_item_id: workItemId, reason: (err as { code?: string }).code ?? String(err) });
      }
    }
    // Fold any terminal mission state back so dependents can progress.
    for (const w of this.business.listWorkItems(businessId)) {
      if (String(w.status) === "IN_PROGRESS") {
        try {
          this.business.syncWorkItem(String(w.work_item_id));
        } catch (err) {
          if ((err as { code?: string }).code !== "FAIL_CLOSED_OPEN_INTENT_ACTIVE") throw err;
        }
      }
    }
    return outcome;
  }
}
