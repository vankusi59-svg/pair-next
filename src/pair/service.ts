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
import { canonicalRiskCeiling, canonicalWorkspacePath, newId, pathWithin, planManifestDigest, utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { AgentContractService } from "./agent-contract.js";
import { ArtifactAuthority } from "./artifact-authority.js";
import {
  ArtifactDependencyResolver,
  ArtifactHandoffService,
} from "./artifact-handoff.js";
import { CostService } from "./cost.js";
import { analyzePlanFeasibility, canonicalPlanSemanticDigest } from "./plan-feasibility.js";
import { SecretPolicyService } from "./secret-policy.js";
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
  private _agentContracts: AgentContractService | null = null;
  private _cost: CostService | null = null;
  private _secretPolicies: SecretPolicyService | null = null;
  private _artifacts: ArtifactAuthority | null = null;
  private _artifactResolver: ArtifactDependencyResolver | null = null;
  private _artifactHandoffs: ArtifactHandoffService | null = null;

  constructor(public readonly store: PairEvidenceStore) {}

  /** Lazy canonical route registry (routes + executor_supply_bindings). */
  get routes(): RouteRegistry {
    this._routes ??= new RouteRegistry(this);
    return this._routes;
  }

  /** Lazy canonical P12 agent-execution-contract resolver/enforcer. */
  get agentContracts(): AgentContractService {
    this._agentContracts ??= new AgentContractService(this.store);
    return this._agentContracts;
  }

  /** Lazy canonical P13 cost authority (atomic monetary reservations). */
  get cost(): CostService {
    this._cost ??= new CostService(this, {
      costHaltFile:
        process.env.PAIR_COST_HALT_FILE ??
        path.join(process.env.PAIR_MC_DIR ?? path.join(process.cwd(), ".pair-mc"), "COST_HALT"),
    });
    return this._cost;
  }

  /** Lazy canonical P13 secret-release authority. */
  get secretPolicies(): SecretPolicyService {
    this._secretPolicies ??= new SecretPolicyService(this);
    return this._secretPolicies;
  }

  /** Lazy canonical F1 artifact authority: the ONE ingest seam for
   *  local and remote artifacts plus the content-addressed byte store
   *  (default root: <pair.db dir>/artifacts/blobs — deployment-scoped,
   *  not per-project, so retained bytes survive project churn and stay
   *  co-located with the canonical evidence store). */
  get artifacts(): ArtifactAuthority {
    this._artifacts ??= new ArtifactAuthority(this.store, {
      blobDir: path.join(
        process.env.PAIR_ARTIFACT_DIR ?? path.join(this.store.dbDir, "artifacts"),
        "blobs",
      ),
    });
    return this._artifacts;
  }

  /** Lazy F2 dependency resolver: consumer task → declared dataflow →
   *  validated producer execution → canonical artifact pin. */
  get artifactResolver(): ArtifactDependencyResolver {
    this._artifactResolver ??= new ArtifactDependencyResolver(this);
    return this._artifactResolver;
  }

  /** Lazy F2 handoff service: durable artifact_handoff entity, governed
   *  local materialization, remote fetch authorization. */
  get artifactHandoffs(): ArtifactHandoffService {
    this._artifactHandoffs ??= new ArtifactHandoffService(
      this.store,
      this.artifacts,
    );
    return this._artifactHandoffs;
  }

  createProject(params: { name: string; root_location: string }): Record<string, unknown> {
    const projectId = newId("PRJ");
    const project = {
      project_id: projectId,
      name: params.name,
      root_location: canonicalWorkspacePath(params.root_location),
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
    return this.createMissionInternal(params, null);
  }

  /**
   * INTERNAL bound-mission creation — reachable only from
   * `MissionControl.startBoundMission` (Foundation V2 R2 §2). Identity is
   * derived FROM the validated `work_open_binding` itself — the reserved
   * `binding.mission_id` becomes the mission id and `binding.open_id`
   * becomes the `bound_open_id` origin proof. No caller can supply
   * either string, so the generic path can never manufacture bound
   * authority. A colliding reserved id fails closed on the version-0
   * CAS insert; there is no overwrite/upsert path.
   */
  createBoundMission(
    binding: Record<string, unknown>,
    params: {
      project_id: string;
      goal: string;
      policy_profile?: string;
      granted_permissions?: string[];
      authorized_workspaces?: string[];
      risk_ceiling?: string;
      execution_mode?: string;
      metadata?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    return this.createMissionInternal(params, binding);
  }

  private createMissionInternal(
    params: {
      project_id: string;
      goal: string;
      policy_profile?: string;
      granted_permissions?: string[];
      authorized_workspaces?: string[];
      risk_ceiling?: string;
      execution_mode?: string;
      metadata?: Record<string, unknown>;
    },
    binding: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const project = this.getProject(params.project_id);
    const missionId = binding ? String(binding.mission_id) : newId("MSN");
    const boundOpenId = binding ? String(binding.open_id) : null;
    const authorized = (params.authorized_workspaces ?? [String(project.root_location)]).map(
      (p) => canonicalWorkspacePath(p),
    );
    const canonicalRisk = canonicalRiskCeiling(params.risk_ceiling);
    const canonicalConstraints: string[] = [];
    // R6 — reserved canonical authority fields can never be shadowed by
    // caller-controlled metadata: a conflicting duplicate fails closed, a
    // same-value duplicate is stripped to the single authoritative copy.
    const callerMetadata = { ...(params.metadata ?? {}) } as Record<string, unknown>;
    const reservedAuthority: Array<[string, unknown]> = [
      ["authorized_workspaces", authorized],
      ["risk_ceiling", canonicalRisk],
      ["constraints", canonicalConstraints],
    ];
    for (const [key, canonical] of reservedAuthority) {
      if (!(key in callerMetadata)) continue;
      if (JSON.stringify(callerMetadata[key]) !== JSON.stringify(canonical)) {
        throw new IntegrityError(
          "FAIL_CLOSED_METADATA_AUTHORITY_SHADOWING",
          `metadata.${key} conflicts with canonical mission authority`,
        );
      }
      delete callerMetadata[key];
    }
    const mission = {
      mission_id: missionId,
      project_id: params.project_id,
      goal: params.goal,
      bound_open_id: boundOpenId,
      status: "CREATED",
      plan_id: null,
      plan_state: null,
      policy_profile: params.policy_profile ?? "default",
      granted_permissions: params.granted_permissions ?? [],
      execution_mode: params.execution_mode ?? "GOVERNED",
      created_at: utcnow(),
      metadata: {
        ...callerMetadata,
        authorized_workspaces: authorized,
        risk_ceiling: canonicalRisk,
        constraints: canonicalConstraints,
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

  /** Record a validated proposal as a new active plan revision.
   *  F3 §12 — the commit boundary re-proves structural artifact/dataflow
   *  feasibility on the proposal itself (independent of executor health)
   *  and persists the pair-plan-semantic.v1 digest computed over the
   *  COMMITTED task rows, so the persisted plan is what carries semantic
   *  authority — never a derived approximation. */
  commitPlan(params: {
    mission_id: string;
    tasks: Array<Record<string, unknown>>;
    source: string;
    reason?: string;
    proposal: unknown;
  }): { plan_id: string; revision: number; task_ids: string[] } {
    analyzePlanFeasibility(params.tasks);
    const mission = this.getMission(params.mission_id);
    const revisions = this.store.planRevisions(params.mission_id);
    const revision = revisions.length + 1;
    const planId = newId("PLN");
    const taskIds: string[] = [];
    const committedTasks: Array<Record<string, unknown>> = [];
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
        // R1.2 — selected_executor is routing evidence only: the router
        // overwrites it post-commit, so it is never plan semantics and
        // never enters the semantic digest.
        selected_executor: t.selected_executor ?? null,
        status: "READY",
        metadata: t.metadata ?? {},
        depends_on: t.depends_on ?? [],
        created_at: utcnow(),
        version: 0,
      };
      this.store.put("task", taskId, task, 0);
      committedTasks.push(task);
    }
    const planSemanticDigest = canonicalPlanSemanticDigest(committedTasks);
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
      plan_semantic_digest: planSemanticDigest,
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
      metadata: {
        revision,
        task_ids: taskIds,
        plan_semantic_digest: planSemanticDigest,
        plan_manifest_digest: planManifestDigest({
          mission_id: params.mission_id,
          plan_id: planId,
          revision,
          task_ids: taskIds,
        }),
      },
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

  /**
   * R7 — mission authority is a SNAPSHOT: effective roots come only from
   * the `authorized_workspaces` pinned into the mission at creation
   * (preview → digest → confirm → mission, byte-for-byte). The live
   * project root may provide defaults for NEW previews/missions but must
   * never widen an existing mission. A mission with no valid snapshot gets
   * zero roots — the gate then denies every workspace (fail closed).
   */
  authorizedRoots(missionId: string): string[] {
    const mission = this.getMission(missionId);
    const extra =
      (mission.metadata as Record<string, unknown> | undefined)?.authorized_workspaces;
    const roots = Array.isArray(extra) ? extra.map((p) => canonicalWorkspacePath(p)) : [];
    return [...new Set(roots)];
  }

  isPathAuthorized(candidate: string, missionId: string): boolean {
    return this.authorizedRoots(missionId).some((root) => pathWithin(candidate, root));
  }
}
