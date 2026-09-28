/**
 * Minimal PAIR control-plane service for the P2 vertical slice.
 * Owns governed-scope entities in PairEvidenceStore:
 * project / mission / plan / task / approval / policy_profile /
 * capability / runtime_governance.
 *
 * These are governance records bound to Automaton goal/task IDs — the
 * Automaton task-graph remains the runtime WHAT/NEXT authority.
 */

import path from "node:path";
import { newId, pathWithin, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { RouteRegistry } from "./route-registry.js";
import type { PairEvidenceStore } from "./store.js";

export const MISSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  CREATED: ["READY", "CANCELLED"],
  READY: ["RUNNING", "PAUSED", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TASK_DISPATCHABLE_STATES = new Set(["READY", "ROUTED"]);

export class PairControlPlane {
  private _routes: RouteRegistry | null = null;

  constructor(public readonly store: PairEvidenceStore) {}

  /** Lazy canonical route registry (routes + executor_supply_bindings). */
  get routes(): RouteRegistry {
    this._routes ??= new RouteRegistry(this);
    return this._routes;
  }

  createProject(params: { name: string; root_location: string }): Record<string, unknown> {
    const projectId = newId("PRJ");
    const project = {
      project_id: projectId,
      name: params.name,
      root_location: path.resolve(params.root_location),
      created_at: utcnow(),
      version: 0,
    };
    return this.store.put("project", projectId, project, 0);
  }

  getProject(projectId: string): Record<string, unknown> {
    return this.store.get("project", projectId);
  }

  createMission(params: {
    project_id: string;
    goal: string;
    policy_profile?: string;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    execution_mode?: string;
    metadata?: Record<string, unknown>;
  }): Record<string, unknown> {
    const project = this.getProject(params.project_id);
    const missionId = newId("MSN");
    const authorized = (params.authorized_workspaces ?? [String(project.root_location)]).map(
      (p) => path.resolve(p),
    );
    const mission = {
      mission_id: missionId,
      project_id: params.project_id,
      goal: params.goal,
      status: "CREATED",
      plan_id: null,
      plan_state: null,
      policy_profile: params.policy_profile ?? "default",
      granted_permissions: params.granted_permissions ?? [],
      execution_mode: params.execution_mode ?? "GOVERNED",
      created_at: utcnow(),
      metadata: {
        authorized_workspaces: authorized,
        risk_ceiling: params.risk_ceiling ?? "HIGH",
        constraints: [],
        ...(params.metadata ?? {}),
      },
      version: 0,
    };
    const saved = this.store.put("mission", missionId, mission, 0);
    this.store.event({
      entity_type: "mission",
      entity_id: missionId,
      event_type: "MISSION_CREATED",
      new_state: "CREATED",
      actor: "PAIR_CONTROL_PLANE",
    });
    return saved;
  }

  getMission(missionId: string): Record<string, unknown> {
    return this.store.get("mission", missionId);
  }

  transitionMission(missionId: string, to: string, actor = "PAIR_CONTROL_PLANE"): Record<string, unknown> {
    const mission = this.getMission(missionId);
    const from = String(mission.status);
    const allowed = MISSION_STATUS_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_TRANSITION",
        `${from}->${to}`,
      );
    }
    mission.status = to;
    const saved = this.store.put("mission", missionId, mission, Number(mission.version));
    this.store.event({
      entity_type: "mission",
      entity_id: missionId,
      event_type: "MISSION_TRANSITION",
      old_state: from,
      new_state: to,
      actor,
    });
    return saved;
  }

  /** Record a validated proposal as a new active plan revision. */
  commitPlan(params: {
    mission_id: string;
    tasks: Array<Record<string, unknown>>;
    source: string;
    reason?: string;
    proposal: unknown;
  }): { plan_id: string; revision: number; task_ids: string[] } {
    const mission = this.getMission(params.mission_id);
    const revisions = this.store.planRevisions(params.mission_id);
    const revision = revisions.length + 1;
    const planId = newId("PLN");
    const taskIds: string[] = [];
    for (const [index, t] of params.tasks.entries()) {
      const taskId = newId("TSK");
      taskIds.push(taskId);
      const task = {
        task_id: taskId,
        task_key: String(t.task_key ?? `T${index + 1}`),
        mission_id: params.mission_id,
        plan_id: planId,
        order: index,
        title: String(t.title ?? t.task_key ?? taskId),
        description: String(t.description ?? t.title ?? ""),
        task_instruction: String(t.task_instruction ?? t.description ?? t.title ?? ""),
        required_capabilities: t.required_capabilities ?? [],
        selected_executor: t.selected_executor ?? null,
        status: "READY",
        metadata: t.metadata ?? {},
        depends_on: t.depends_on ?? [],
        created_at: utcnow(),
        version: 0,
      };
      this.store.put("task", taskId, task, 0);
    }
    this.store.put(
      "plan",
      planId,
      {
        plan_id: planId,
        mission_id: params.mission_id,
        state: "PLANNED",
        task_ids: taskIds,
        source: params.source,
        created_at: utcnow(),
        version: 0,
      },
      0,
    );
    this.store.recordPlanRevision({
      mission_id: params.mission_id,
      revision,
      plan_id: planId,
      source: params.source,
      reason: params.reason ?? "PLAN_COMMIT",
      proposal: params.proposal,
    });
    mission.plan_id = planId;
    mission.plan_state = "PLANNED";
    mission.plan_revision = revision;
    this.store.put("mission", params.mission_id, mission, Number(mission.version));
    this.store.event({
      entity_type: "mission",
      entity_id: params.mission_id,
      event_type: "MISSION_PLAN_COMMITTED",
      new_state: planId,
      actor: "PAIR_PLAN_VALIDATOR",
      metadata: { revision },
    });
    return { plan_id: planId, revision, task_ids: taskIds };
  }

  getTask(taskId: string): Record<string, unknown> {
    return this.store.get("task", taskId);
  }

  /** Bind the router-selected executor onto the task entity (routing evidence). */
  updateTask(taskId: string, patch: Record<string, unknown>): Record<string, unknown> {
    const task = this.store.get("task", taskId);
    const updated = { ...task, ...patch };
    return this.store.put("task", taskId, updated, Number(task.version));
  }

  registerExecutor(record: Record<string, unknown>, actor = "PAIR_EXECUTOR_REGISTRY"): Record<string, unknown> {
    const executorId = String(record.executor_id ?? "");
    if (!executorId) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_DESCRIPTOR_INCOMPLETE", "executor_id");
    }
    let existing: Record<string, unknown> | null = null;
    try {
      existing = this.store.get("executor", executorId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    const saved = this.store.put(
      "executor",
      executorId,
      { ...record, executor_id: executorId, version: existing ? Number(existing.version) : 0 },
      existing ? Number(existing.version) : 0,
    );
    this.store.event({
      entity_type: "executor",
      entity_id: executorId,
      event_type: existing ? "EXECUTOR_UPDATED" : "EXECUTOR_REGISTERED",
      new_state: String(record.health_state ?? "UNKNOWN"),
      actor,
    });
    return saved;
  }

  getExecutor(executorId: string): Record<string, unknown> {
    return this.store.get("executor", executorId);
  }

  listExecutors(): Array<Record<string, unknown>> {
    return this.store.list("executor");
  }

  listTasks(missionId: string): Array<Record<string, unknown>> {
    return this.store
      .list("task")
      .filter((t) => t.mission_id === missionId)
      .sort((a, b) => Number(a.order) - Number(b.order));
  }

  activeRevision(missionId: string): { revision: number; plan_id: string } {
    const revisions = this.store.planRevisions(missionId);
    if (!revisions.length) {
      throw new IntegrityError("FAIL_CLOSED_PLAN_REVISION_MISSING", missionId);
    }
    const latest = revisions[revisions.length - 1];
    return { revision: Number(latest.revision), plan_id: String(latest.plan_id) };
  }

  registerCapability(capabilityId: string, params: { risk_class?: string; metadata?: Record<string, unknown> } = {}): Record<string, unknown> {
    const existingVersion = this.store.tryGet("capability", capabilityId)?.version ?? 0;
    return this.store.put(
      "capability",
      capabilityId,
      {
        capability_id: capabilityId,
        risk_class: params.risk_class ?? "LOW",
        metadata: params.metadata ?? {},
        version: existingVersion,
      },
      existingVersion,
    );
  }

  setPolicyProfile(name: string, policy: Record<string, unknown>): Record<string, unknown> {
    const existing = this.store.tryGet("policy_profile", name);
    return this.store.put(
      "policy_profile",
      name,
      { name, ...policy, version: existing?.version ?? 0 },
      existing?.version ?? 0,
    );
  }

  getPolicyProfile(name: string): Record<string, unknown> {
    return this.store.tryGet("policy_profile", name) ?? { name };
  }

  setRuntimeGovernance(missionId: string, gov: Record<string, unknown>): Record<string, unknown> {
    const existing = this.store.tryGet("runtime_governance", missionId);
    return this.store.put(
      "runtime_governance",
      missionId,
      { mission_id: missionId, max_retries: 3, ...gov, version: existing?.version ?? 0 },
      existing?.version ?? 0,
    );
  }

  getRuntimeGovernance(missionId: string): Record<string, unknown> {
    return this.store.tryGet("runtime_governance", missionId) ?? { max_retries: 3 };
  }

  authorizedRoots(missionId: string): string[] {
    const mission = this.getMission(missionId);
    const project = this.getProject(String(mission.project_id));
    const extra =
      (mission.metadata as Record<string, unknown> | undefined)?.authorized_workspaces;
    const roots = [String(project.root_location), ...((extra as string[]) ?? [])];
    return [...new Set(roots.map((p) => path.resolve(p)))];
  }

  isPathAuthorized(candidate: string, missionId: string): boolean {
    return this.authorizedRoots(missionId).some((root) => pathWithin(candidate, root));
  }
}
