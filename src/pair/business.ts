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
import { newId, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import type { MissionControl } from "./mission-control.js";
import type { MissionScheduleService } from "./mission-schedule.js";

export const WORK_ITEM_STATUSES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
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
  constructor(private readonly deps: BusinessLayerDeps) {}

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
      status: "ACTIVE" as OrgAgentStatus,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("org_agent", id, row, 0);
    this.store.event({
      entity_type: "org_agent", entity_id: id, event_type: "ORG_AGENT_CREATED",
      new_state: "ACTIVE", actor: `operator:${input.operator_id}`,
      metadata: { business_id: input.business_id, department: input.department, title: input.title },
    });
    return saved;
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
    priority?: number;
    source?: string;
    operator_id: string;
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
    const id = newId("WI");
    const row = {
      work_item_id: id,
      business_id: input.business_id,
      title: input.title,
      goal: input.goal,
      department,
      assignee_agent_id: input.assignee_agent_id ?? null,
      priority: input.priority ?? 50,
      source: input.source ?? "manual",
      status: (input.assignee_agent_id ? "READY" : "BACKLOG") as WorkItemStatus,
      mission_ids: [] as string[],
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
  }

  listWorkItems(businessId?: string): Row[] {
    const all = this.store.list("work_item");
    return (businessId ? all.filter((w) => String(w.business_id) === businessId) : all)
      .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  assignWorkItem(workItemId: string, agentId: string, actor: string): Row {
    const row = this.store.get("work_item", workItemId);
    const agent = this.store.get("org_agent", agentId);
    if (String(agent.business_id) !== String(row.business_id)) {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_SCOPE", `assignee outside business ${row.business_id}`);
    }
    if (String(agent.status) !== "ACTIVE") {
      throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
    }
    const from = String(row.status);
    if (from !== "BACKLOG" && from !== "READY" && from !== "BLOCKED") {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${from} cannot be assigned`);
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
    const row = this.store.get("work_item", workItemId);
    const from = String(row.status);
    if (from !== "READY" && from !== "BLOCKED" && from !== "BACKLOG") {
      throw new IntegrityError("FAIL_CLOSED_WORK_ITEM_STATE", `${from} cannot be opened`);
    }
    const business = this.getBusiness(String(row.business_id));
    const agentId = row.assignee_agent_id ? String(row.assignee_agent_id) : null;
    let agent: Row | null = null;
    if (agentId) {
      agent = this.store.get("org_agent", agentId);
      if (String(agent.status) !== "ACTIVE") {
        throw new PolicyError("FAIL_CLOSED_AGENT_INACTIVE", agentId);
      }
    }
    this.enforceBudgets(String(row.business_id), String(row.department ?? ""), agentId);

    const goal =
      `[BUSINESS ${String(business.name)} | DEPT ${String(row.department ?? "-")}` +
      (agent ? ` | AGENT ${String(agent.title)} (${String(agent.role ?? "")})` : "") +
      `]\n${String(row.goal)}`;

    const mission = this.deps.control.startMission({
      project_id: String(business.project_id),
      goal,
      metadata: {
        business_id: String(row.business_id),
        work_item_id: workItemId,
        org_agent_id: agentId,
        department: row.department ?? null,
        source: "business_layer",
      },
      operator_id: operatorId,
    });
    const missionId = String(mission.mission_id);
    row.status = "IN_PROGRESS";
    (row.mission_ids as string[]).push(missionId);
    row.updated_at = utcnow();
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_OPENED",
      old_state: from, new_state: "IN_PROGRESS", actor: `operator:${operatorId}`,
      metadata: { mission_id: missionId, assignee_agent_id: agentId },
    });
    return saved;
  }

  /** Fold the linked mission's terminal state back into the work item. */
  syncWorkItem(workItemId: string): Row {
    const row = this.store.get("work_item", workItemId);
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
    const next: WorkItemStatus | null =
      ms === "COMPLETED" ? "DONE" :
      ms === "FAILED" ? "BLOCKED" :
      ms === "CANCELLED" ? "CANCELLED" :
      ms === "PAUSED" ? "BLOCKED" : null;
    if (!next) return row;
    row.status = next;
    row.updated_at = utcnow();
    if (next === "DONE" || next === "BLOCKED") {
      row.result_summary = String(mission.result ?? mission.result_summary ?? "") || null;
    }
    const saved = this.store.put("work_item", workItemId, row, Number(row.version));
    this.store.event({
      entity_type: "work_item", entity_id: workItemId, event_type: "WORK_ITEM_SYNCED",
      old_state: status, new_state: next, actor: "PAIR_BUSINESS_LAYER",
      metadata: { mission_id: missionIds[missionIds.length - 1], mission_status: ms },
    });
    return saved;
  }

  board(businessId: string): Record<string, Row[]> {
    this.getBusiness(businessId);
    const items = this.listWorkItems(businessId);
    for (const w of items) {
      if (String(w.status) === "IN_PROGRESS") this.syncWorkItem(String(w.work_item_id));
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

  /** Fail-closed budget check before dispatching any business mission. */
  private enforceBudgets(businessId: string, department: string, agentId: string | null): void {
    const policies = this.listBudgetPolicies(businessId).filter((p) => p.enabled !== false);
    if (policies.length === 0) return;
    const missions = this.store.list("mission");
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
      const used = missions.filter((m) => {
        const md = m.metadata as Record<string, unknown> | undefined;
        return String(md?.[key] ?? "") === scopeId && String(m.created_at ?? "") >= since;
      }).length;
      if (used >= Number(p.max_missions)) {
        this.store.event({
          entity_type: "budget_policy", entity_id: String(p.budget_policy_id),
          event_type: "BUDGET_EXCEEDED", actor: "PAIR_BUSINESS_LAYER",
          metadata: { scope_type: scopeType, scope_id: scopeId, used, max_missions: p.max_missions, period: p.period },
        });
        if (p.hard_stop) {
          throw new PolicyError(
            "FAIL_CLOSED_BUDGET_EXCEEDED",
            `${scopeType}:${scopeId} ${used}/${p.max_missions} per ${p.period}`,
          );
        }
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
      metadata: { business_id: input.business_id, routine_source: true },
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

  // ---------- aggregate read ----------

  detail(businessId: string): Record<string, unknown> {
    return {
      business: this.getBusiness(businessId),
      agents: this.listOrgAgents(businessId),
      board: this.board(businessId),
      routines: this.listRoutines(businessId),
      budgets: this.listBudgetPolicies(businessId),
    };
  }
}
