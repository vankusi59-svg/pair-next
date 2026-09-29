/**
 * P9 MissionControl — operator-facing read models + actions.
 *
 * Every action delegates to the canonical authority (MissionRuntime,
 * ApprovalQueue, ReconciliationService, SelfImprovementController,
 * MissionSupervisor). This layer never mutates a DB row directly and never
 * exposes credentials or env dumps — only entity projections.
 */

import fs from "node:fs";
import { verifyBrokerCapability } from "./broker-capability.js";
import { registerSensitiveMaterial } from "./sanitizer.js";
import path from "node:path";
import { IntegrityError, NotFoundError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { MissionSupervisor, WakeReason } from "./mission-supervisor.js";
import type { MissionScheduler } from "./mission-scheduler.js";
import type { MissionScheduleService } from "./mission-schedule.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { MissionObservability } from "./mission-observability.js";
import type { SelfImprovementController } from "./self-improvement.js";
import { projectRoutableExecutors } from "./routing-projection.js";
import { projectRoutableModels } from "./model-routable.js";
import { digest, sha256Hex, utcnow } from "./canonical.js";
import { validatePlanProposal } from "./proposal.js";
import type { RuntimePlanner } from "./mission-runtime.js";

export interface MissionControlDeps {
  service: PairControlPlane;
  runtime: MissionRuntime;
  /** Same planner the runtime uses — required for §4.3 plan preview. */
  planner?: RuntimePlanner;
  /** Advisory retrieval only, mirrors runtime (never authoritative). */
  plannerAdvisor?: { advise(opts: Record<string, unknown>): Record<string, unknown> };
  supervisor: MissionSupervisor;
  scheduler: MissionScheduler;
  approvals: ApprovalQueue;
  reconciliation: ReconciliationService;
  observability: MissionObservability;
  selfmod?: SelfImprovementController;
  /** Recurring mission triggers — cron schedules persisted in pair.db. */
  schedules?: MissionScheduleService;
  /** Runtime-controlled cost halt lever: when this file exists, remote
   *  dispatch is blocked (same effect as PAIR_COST_HALT=1, but flippable
   *  without a restart). */
  costHaltFile?: string;
}

function requireOperator(operatorId: string | undefined): string {
  if (!operatorId || !operatorId.trim()) {
    throw new PolicyError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "mission_control");
  }
  return operatorId;
}

export class MissionControl {
  constructor(private readonly deps: MissionControlDeps) {}

  private get store() {
    return this.deps.service.store;
  }

  /* ---------------- read models ------------------------------------------ */

  projects(): Array<Record<string, unknown>> {
    return this.store.list("project");
  }

  missions(): Array<Record<string, unknown>> {
    return this.store.list("mission").map((m) => {
      const rt = this.store.tryGet("mission_runtime", `MRT_${String(m.mission_id)}`);
      return { ...m, runtime_state: rt ? rt.state : null };
    });
  }

  missionDetail(missionId: string) {
    return this.deps.observability.missionSummary(missionId);
  }

  /** Resolves the project outbox dir for a mission — remote executors push
   *  binary deliverables (charts/screenshots) here via POST /api/outbox so
   *  the delivery pipeline (Telegram bridge) can reach them. Unknown mission
   *  → null (fail-closed: no upload lands outside a known project). */
  missionOutboxDir(missionId: string): string | null {
    const m = this.store.tryGet("mission", missionId) as Record<string, unknown> | null;
    if (!m) return null;
    const prj = this.store.tryGet("project", String(m.project_id ?? "")) as
      | Record<string, unknown>
      | null;
    const root = String(prj?.root_location ?? "");
    return root ? path.join(root, "outbox") : null;
  }

  missionDag(missionId: string) {
    const tasks = this.deps.service.listTasks(missionId);
    return {
      nodes: tasks.map((t) => ({
        task_id: t.task_id,
        task_key: t.task_key,
        title: t.title,
        status: t.status,
        selected_executor: t.selected_executor,
        plan_id: t.plan_id,
        order: t.order,
      })),
      edges: tasks.flatMap((t) =>
        ((t.depends_on as string[]) ?? []).map((dep) => {
          const depTask = tasks.find((d) => d.task_key === dep);
          return { from: depTask?.task_id ?? dep, to: t.task_id };
        }),
      ),
    };
  }

  /* ---- mission workspace files (read-only, path-clamped) ---------------- */

  private missionWorkspaces(missionId: string): string[] {
    const m = this.store.tryGet("mission", missionId) as Record<string, unknown> | null;
    if (!m) throw new NotFoundError(`mission:${missionId}`);
    const ws = ((m.metadata as Record<string, unknown> | undefined)?.authorized_workspaces ??
      m.authorized_workspaces ??
      []) as string[];
    return ws.map(String).map((w) => path.resolve(w));
  }

  /** List files under the mission's authorized workspaces (recursive). */
  workspaceFiles(missionId: string): { files: Array<Record<string, unknown>> } {
    const out: Array<Record<string, unknown>> = [];
    for (const root of this.missionWorkspaces(missionId)) {
      if (!fs.existsSync(root)) continue;
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.isFile()) {
            const st = fs.statSync(p);
            out.push({
              path: path.relative(root, p),
              workspace: root,
              size: st.size,
              modified_at: st.mtime.toISOString(),
            });
          }
        }
      };
      walk(root);
    }
    return { files: out.sort((a, b) => String(a.path).localeCompare(String(b.path))) };
  }

  /**
   * Read one file inside the mission's authorized workspaces. Fail-closed:
   * rejects `..`/absolute escapes, anything outside a workspace, and non-UTF8
   * content; caps output at 256 KB.
   */
  workspaceFile(missionId: string, relPath: string): Record<string, unknown> {
    if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath)) {
      throw new IntegrityError("FAIL_CLOSED_BAD_PATH", String(relPath).slice(0, 80));
    }
    for (const root of this.missionWorkspaces(missionId)) {
      const resolved = path.resolve(root, relPath);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) continue;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
      const buf = fs.readFileSync(resolved);
      const MAX = 256 * 1024;
      const content = buf.slice(0, MAX).toString("utf8");
      if (buf.indexOf(0) !== -1) {
        throw new IntegrityError("FAIL_CLOSED_BINARY_FILE", relPath.slice(0, 80));
      }
      return {
        path: relPath,
        workspace: root,
        size: buf.length,
        sha256: sha256Hex(buf),
        truncated: buf.length > MAX,
        content,
      };
    }
    throw new NotFoundError(`workspace_file:${relPath}`);
  }

  /** §4.1 — canonical entity events after `sinceSeq` (hash-verified on read).
   *  Drives the SSE stream; returns latest_seq so cursors don't regress. */
  eventsSince(sinceSeq = 0): { events: Array<Record<string, unknown>>; latest_seq: number } {
    const all = this.store.listEvents();
    const latest = all.length ? Number(all[all.length - 1].seq ?? 0) : sinceSeq;
    return { events: all.filter((e) => Number(e.seq ?? 0) > sinceSeq), latest_seq: latest };
  }

  timeline(missionId: string) {
    return this.deps.observability.missionTimeline(missionId);
  }

  routing() {
    return {
      routable: projectRoutableExecutors(this.deps.service),
      executors: this.store.list("executor"),
      routes: this.store.list("route"),
      bindings: this.store.list("executor_binding"),
    };
  }

  recovery() {
    return {
      decisions: this.store.list("recovery_decision"),
      attempts: this.store.list("recovery_attempt"),
      scheduled: this.store.list("scheduled_action"),
    };
  }

  /** §4.2 — provider projection; credential status is a flag, never a secret. */
  providers() {
    return {
      providers: this.store.list("provider").map((p) => ({
        ...p,
        credential_status: String(p.auth_state) === "AUTH_OK" ? "configured" : "unavailable",
      })),
      qualifications: this.store.list("provider_qualification"),
    };
  }

  /** §4.2 — model evidence catalog projection. */
  models() {
    return {
      models: this.store.list("model_entry"),
      bindings: this.store.list("model_binding"),
      qualifications: this.store.list("model_qualification"),
    };
  }

  /** §4.2 — routes + bindings + per-binding 13-gate routable projection. */
  routes() {
    return {
      routes: this.store.list("route"),
      model_bindings: this.store.list("model_binding"),
      routable_models: projectRoutableModels(this.deps.service),
      route_decisions: this.store.list("route_decision"),
      routing_decisions: this.store.list("routing_decision"),
    };
  }

  /** §4.2 — 13-gate routable projection for one model entry id. */
  modelRoutable(modelEntryId: string) {
    const model = this.store.tryGet("model_entry", modelEntryId);
    const rows = projectRoutableModels(this.deps.service).filter(
      (r) => r.model_entry_id === modelEntryId,
    );
    return { model, bindings: rows };
  }

  approvals() {
    return this.store.list("approval_request");
  }

  evidence(missionId: string) {
    return this.store
      .list("evidence")
      .filter((e) => e.mission_id === missionId);
  }

  experience() {
    return {
      experiences: this.store.list("experience"),
      advisor_decisions: this.store.list("advisor_decision"),
    };
  }

  selfImprovement() {
    return {
      candidates: this.store.list("selfmod_candidate"),
      validations: this.store.list("selfmod_validation_receipt"),
      promotions: this.store.list("promotion_candidate"),
    };
  }

  health() {
    return this.deps.observability.health();
  }

  metrics() {
    return this.deps.observability.metrics();
  }

  /* ---------------- operator actions -------------------------------------- */

  /**
   * §4.3 plan preview — runs the injected planner + validator on a
   * fabricated mission-shaped input and returns the validated task list
   * with a sha256 digest. Creates NO canonical state.
   */
  previewMission(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
  }): {
    plan: { tasks: Array<Record<string, unknown>> };
    plan_digest: string;
    plan_source: string | null;
    plan_model: string | null;
  } {
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", "mission_control.preview");
    }
    // Planner sees only the mission fields it legitimately reads — the same
    // record shape the runtime will later build from the created entity.
    const pseudoMission: Record<string, unknown> = {
      mission_id: "__preview__",
      project_id: input.project_id,
      goal: input.goal,
      metadata: input.metadata ?? {},
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: input.authorized_workspaces ?? [],
      risk_ceiling: input.risk_ceiling ?? null,
    };
    const proposal = this.deps.planner({ mission: pseudoMission, advice: null, reason: "initial" });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    const plan_digest = digest({
      project_id: input.project_id,
      goal: input.goal,
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: input.authorized_workspaces ?? [],
      risk_ceiling: input.risk_ceiling ?? null,
      tasks,
    });
    return {
      plan: { tasks: tasks as unknown as Array<Record<string, unknown>> },
      plan_digest,
      // Operator-visible provenance of the proposed plan (metadata is
      // operator-supplied; the digest — not this field — is what pins it).
      plan_source: (input.metadata?.plan_source as string | undefined) ?? null,
      plan_model: (input.metadata?.plan_model as string | undefined) ?? null,
    };
  }

  /** Create + queue a mission for orchestration. */
  startMission(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    operator_id?: string;
    /** P14-RB: canonical binding-pinned mission id (business open seam). */
    mission_id?: string;
    /** §4.3 two-step submit: the plan digest returned by previewMission. */
    confirm_plan?: { digest: string };
  }): Record<string, unknown> {
    if (input.confirm_plan?.digest) {
      const preview = this.previewMission(input);
      if (preview.plan_digest !== input.confirm_plan.digest) {
        throw new PolicyError("FAIL_CLOSED_PLAN_DIGEST_MISMATCH", String(input.confirm_plan.digest).slice(0, 16));
      }
    }
    const metadata = { ...(input.metadata ?? {}) } as Record<string, unknown>;
    const boundAgentId = metadata.org_agent_id ? String(metadata.org_agent_id) : null;
    if (boundAgentId) {
      // P12: a mission bound to an org_agent pins its agent execution
      // contract (id/version/digest/policy snapshot) into immutable mission
      // metadata. assertExecutable fails closed on inactive agent,
      // disabled contract, business mismatch, or out-of-scope project.
      try {
        metadata.agent_contract = this.deps.service.agentContracts.pin(boundAgentId, {
          businessId: metadata.business_id ? String(metadata.business_id) : null,
          projectId: input.project_id,
          actor: `operator:${input.operator_id ?? "system"}`,
        });
      } catch (e) {
        // R1 §6: pin-time contract failures are audited as denials before
        // they propagate — inactive agent, disabled contract, business
        // mismatch, project denial, integrity/provenance all land here.
        if (e instanceof PolicyError || e instanceof IntegrityError) {
          this.deps.service.agentContracts.auditDenial(
            (e as { code?: string }).code ?? "FAIL_CLOSED_AGENT_POLICY",
            (e as Error).message,
            { agentId: boundAgentId },
          );
        }
        throw e;
      }
    }
    // P13-R3 §1: canonical business context. When the mission is bound to
    // an org_agent, that agent row is the ONLY authority for
    // business/department scope — caller-supplied business_id/department
    // must match it exactly (mismatch fails closed), and a missing
    // business_id inherits the agent's business so a bound mission can
    // never escape its monetary/secret scope. The resolved context is
    // pinned immutably; downstream governance consumes the pin, not
    // arbitrary caller metadata.
    let canonicalBizId: string | null = null;
    if (boundAgentId) {
      const agent = this.deps.service.store.tryGet("org_agent", boundAgentId) as
        | Record<string, unknown>
        | null;
      if (!agent) {
        throw new IntegrityError("FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH", `agent:${boundAgentId} unknown`);
      }
      canonicalBizId = String(agent.business_id);
      const canonicalDept = agent.department == null ? null : String(agent.department);
      if (metadata.business_id != null && String(metadata.business_id) !== canonicalBizId) {
        throw new IntegrityError(
          "FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH",
          `business_id:${String(metadata.business_id)}!=${canonicalBizId}`,
        );
      }
      if (
        metadata.department != null &&
        canonicalDept != null &&
        String(metadata.department) !== canonicalDept
      ) {
        throw new IntegrityError(
          "FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH",
          `department:${String(metadata.department)}!=${canonicalDept}`,
        );
      }
      metadata.business_id = canonicalBizId;
      if (canonicalDept != null) metadata.department = canonicalDept;
    }
    // P13: pin the mission's credential grant set — a snapshot of every
    // ACTIVE secret_policy of its business (refs + allow-sets + policy
    // provenance, never values). Later expansion never retro-broadens;
    // revocation narrows via the live-policy check at fetch time.
    // R1 §5: business_id must resolve to a REAL business whose canonical
    // project matches the mission's project — a caller cannot mint
    // another business's grants by forging metadata.business_id.
    if (metadata.business_id) {
      const bizId = String(metadata.business_id);
      const biz = this.deps.service.store.tryGet("business", bizId) as
        | Record<string, unknown>
        | null;
      if (!biz) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN", bizId);
      }
      if (String(biz.project_id) !== String(input.project_id)) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_CROSS_BUSINESS", `${bizId}:${String(input.project_id)}`);
      }
      if (boundAgentId && canonicalBizId !== bizId) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_AGENT_REF", boundAgentId);
      }
    }
    metadata.business_context = {
      business_id: metadata.business_id != null ? String(metadata.business_id) : null,
      org_agent_id: boundAgentId,
      department: metadata.department != null ? String(metadata.department) : null,
      project_id: String(input.project_id),
      provenance: boundAgentId ? "org_agent" : "caller",
      pinned_at: utcnow(),
    };
    metadata.secret_grants = this.deps.service.secretPolicies.pinForMission({
      businessId: metadata.business_id ? String(metadata.business_id) : null,
    });
    const mission = this.deps.service.createMission({
      project_id: input.project_id,
      goal: input.goal,
      metadata,
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: input.authorized_workspaces,
      risk_ceiling: input.risk_ceiling,
      mission_id: input.mission_id,
    });
    this.deps.runtime.runtimeEntity(String(mission.mission_id));
    this.deps.supervisor.wake(String(mission.mission_id), "MISSION_CREATED");
    return mission;
  }

  pauseMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.pause(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { detail: "pause" });
    return rt;
  }

  resumeMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.resume(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { operator: op });
    return rt;
  }

  cancelMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    return this.deps.runtime.cancel(missionId, op);
  }

  approve(approvalId: string, operatorId: string | undefined, scope: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    const decision = this.deps.approvals.decide(approvalId, op, "APPROVED", scope, reason);
    const a = this.deps.approvals.get(approvalId);
    if (a.mission_id) {
      this.deps.supervisor.wake(String(a.mission_id), "APPROVAL_GRANTED", {
        approval_id: approvalId,
      });
    }
    return decision;
  }

  deny(approvalId: string, operatorId: string | undefined, scope: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    return this.deps.approvals.decide(approvalId, op, "DENIED", scope, reason);
  }

  /**
   * P13 broker-fetch authority: ordered fail-closed checks for a
   * credential release. Missions, tasks and their binding are canonical
   * facts; the secret_policy + mission pin + current policy intersect
   * decides, and every denial is audited with its reason.
   */
  authorizeCredentialFetch(
    missionId: string,
    taskId: string,
    credentialRef: string,
  ): { granted: boolean; reason: string } {
    const mission = this.deps.service.store.tryGet("mission", missionId);
    if (!mission) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_MISSION_NOT_FOUND");
      return { granted: false, reason: "FAIL_CLOSED_MISSION_NOT_FOUND" };
    }
    const task = this.deps.service.store.tryGet("task", taskId);
    if (!task) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_TASK_NOT_FOUND");
      return { granted: false, reason: "FAIL_CLOSED_TASK_NOT_FOUND" };
    }
    if (String(task.mission_id) !== missionId) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_TASK_NOT_IN_MISSION");
      return { granted: false, reason: "FAIL_CLOSED_TASK_NOT_IN_MISSION" };
    }
    // R1 §3: release is bound to the EXACT canonical task/executor context
    // — the broker request carries only ids; it can never invent routing
    // identity. An unrouted/unbound task cannot receive a secret.
    const executorId = task.selected_executor ? String(task.selected_executor) : null;
    const boundStates = new Set(["ROUTED", "RUNNING"]);
    if (!executorId || !boundStates.has(String(task.status))) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND");
      return { granted: false, reason: "FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND" };
    }
    const decision = this.deps.service.secretPolicies.authorizeRelease({
      mission,
      task,
      credentialRef,
      executorId,
    });
    if (!decision.granted) {
      this.auditSecretDeny(missionId, taskId, credentialRef, decision.reason);
      return { granted: false, reason: decision.reason };
    }
    this.deps.service.store.appendEvidence(missionId, "CREDENTIAL_RELEASE_GRANTED", {
      credential_name: credentialRef,
      task_id: taskId,
      policy_id: decision.policy?.policy_id,
      policy_version: decision.policy?.policy_version,
      executor_id: executorId,
    });
    return { granted: true, reason: "GRANTED" };
  }

  /**
   * R3 §2: /api/broker/fetch entry — the worker credential is a
   * task-scoped HMAC capability, not the master token. Verify the
   * signature server-side, then bind the claims to canonical facts:
   * body identity, the task's selected executor, and — when a governed
   * task exists — its exact governed_task_id. Only then does the normal
   * P13 policy chain (authorizeCredentialFetch) run; a capability never
   * expands policy or P12 authority.
   */
  authorizeBrokerFetch(
    missionId: string,
    taskId: string,
    credentialRef: string,
    capability: string,
    masterSecret: string,
  ): { granted: boolean; reason: string } {
    // R4 §1: the master secret is registered at the verification boundary
    // too, so an echo from a hostile worker is redacted even when minting
    // happened on a different path.
    registerSensitiveMaterial(masterSecret);
    const claims = verifyBrokerCapability(masterSecret, capability);
    if (!claims) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY");
      return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY" };
    }
    if (claims.mission_id !== missionId || claims.task_id !== taskId) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
      return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
    }
    const task = this.deps.service.store.tryGet("task", taskId);
    if (task) {
      const boundExecutor = task.selected_executor ? String(task.selected_executor) : null;
      if (boundExecutor && claims.executor_id !== boundExecutor) {
        this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR");
        return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR" };
      }
      const governed = this.deps.service.store
        .list("governed_task")
        .filter((g) => String(g.task_id) === taskId);
      if (governed.length > 0) {
        const match = governed.some((g) => String(g.governed_task_id) === claims.governed_task_id);
        if (!match) {
          this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
          return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
        }
      } else if (claims.governed_task_id != null) {
        // The claim names a governed task that does not exist canonically.
        this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
        return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
      }
    }
    return this.authorizeCredentialFetch(missionId, taskId, credentialRef);
  }

  private auditSecretDeny(
    missionId: string,
    taskId: string,
    credentialRef: string,
    reason: string,
  ): void {
    try {
      this.deps.service.store.appendEvidence(missionId, "CREDENTIAL_RELEASE_DENIED", {
        credential_name: credentialRef,
        task_id: taskId,
        reason,
      });
    } catch {
      // mission may not exist — audit on the task axis instead
      this.deps.service.store.event({
        entity_type: "task",
        entity_id: taskId,
        event_type: "CREDENTIAL_RELEASE_DENIED",
        actor: "PAIR_SECRET_GOVERNANCE",
        metadata: { credential_name: credentialRef, reason },
      });
    }
  }

  /* ---------------- mission schedules ------------------------------------ */

  schedules(): Array<Record<string, unknown>> {
    return this.deps.schedules?.list() ?? [];
  }

  createSchedule(input: {
    goal: string;
    cron: string;
    project_id?: string;
    name?: string;
    metadata?: Record<string, unknown>;
    operator_id?: string;
  }): Record<string, unknown> {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(input.operator_id);
    return this.deps.schedules.create({ ...input, operator_id: op });
  }

  setScheduleEnabled(id: string, enabled: boolean, operatorId?: string) {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(operatorId);
    return this.deps.schedules.setEnabled(id, enabled, op);
  }

  deleteSchedule(id: string, operatorId?: string) {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(operatorId);
    return this.deps.schedules.remove(id, op);
  }

  /**
   * Fire every due schedule through the canonical startMission path. When an
   * expander is supplied (the serve script's LLM planner seam) each due goal
   * is expanded into a real plan first — scheduled missions get the same plan
   * quality as the UI's Plan & run instead of the minimal template fallback.
   */
  async tickSchedules(
    now?: string,
    expander?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<{ fired: string[]; errors: string[] }> {
    if (!this.deps.schedules) return { fired: [], errors: [] };
    const defaultProject = String(this.store.list("project")[0]?.project_id ?? "");
    return this.deps.schedules.fireDue(
      async (input) => {
        const expanded = expander ? await expander(input as Record<string, unknown>) : input;
        const preview = this.previewMission({
          project_id: (expanded.project_id as string | undefined) || defaultProject,
          goal: String(expanded.goal ?? input.goal),
          metadata: (expanded.metadata ?? input.metadata) as Record<string, unknown> | undefined,
        });
        return this.startMission({
          ...expanded,
          project_id: (expanded.project_id as string | undefined) || defaultProject,
          goal: String(expanded.goal ?? input.goal),
          confirm_plan: { digest: preview.plan_digest },
        });
      },
      now,
    );
  }

  /** Cost-guard read model — remote dispatch usage vs the daily cap. */
  cost(): Record<string, unknown> {
    const today = utcnow().slice(0, 10);
    const todayRemote = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          String(e.executor_id ?? "") === "DEVIN" &&
          String(e.created_at ?? "").startsWith(today),
      );
    const limit = Number(process.env.PAIR_MAX_REMOTE_TASKS_PER_DAY ?? 10);
    return {
      remote_dispatches_today: todayRemote.length,
      remote_daily_limit: limit,
      cost_halt:
        process.env.PAIR_COST_HALT === "1" ||
        (this.deps.costHaltFile ? fs.existsSync(this.deps.costHaltFile) : false),
      schedules_active: this.deps.schedules?.list().filter((s) => s.enabled && !s.deleted).length ?? 0,
      // P13 read model: monetary policies, usage by scope, live
      // reservations, billing-mode breakdown, unpriced dispatches.
      monetary: this.deps.service.cost.position(),
    };
  }

  /* ---------------- P13 cost + secret governance -------------------------- */

  costPolicies(): Array<Record<string, unknown>> {
    return this.deps.service.cost.listCostPolicies();
  }

  costProfiles(): Array<Record<string, unknown>> {
    return this.deps.service.cost.listCostProfiles();
  }

  secretPolicies(): Array<Record<string, unknown>> {
    return this.deps.service.secretPolicies.listPolicies();
  }

  /** R3 §3: create-only — colliding identity fails closed, never a
   *  silent authority rewrite. */
  createCostPolicy(body: Record<string, unknown>, actor: string) {
    return this.deps.service.cost.createCostPolicy(body, actor);
  }

  createCostProfile(body: Record<string, unknown>, actor: string) {
    return this.deps.service.cost.createCostProfile(body, actor);
  }

  upsertCostPolicy(body: Record<string, unknown>, actor: string, expectedVersion?: number) {
    return this.deps.service.cost.upsertCostPolicy(body, actor, expectedVersion);
  }

  updateCostPolicy(body: Record<string, unknown>, actor: string, expectedVersion: number) {
    return this.deps.service.cost.updateCostPolicy(body, actor, expectedVersion);
  }

  upsertCostProfile(body: Record<string, unknown>, actor: string, expectedVersion?: number) {
    return this.deps.service.cost.upsertCostProfile(body, actor, expectedVersion);
  }

  updateCostProfile(body: Record<string, unknown>, actor: string, expectedVersion: number) {
    return this.deps.service.cost.updateCostProfile(body, actor, expectedVersion);
  }

  createSecretPolicy(body: Record<string, unknown>, actor: string) {
    return this.deps.service.secretPolicies.createPolicy(body, actor);
  }

  updateSecretPolicy(policyId: string, body: Record<string, unknown>, expectedVersion: number, actor: string) {
    return this.deps.service.secretPolicies.updatePolicy(policyId, body, expectedVersion, actor);
  }

  revokeSecretPolicy(policyId: string, actor: string) {
    return this.deps.service.secretPolicies.setPolicyStatus(policyId, "REVOKED", actor);
  }

  requestReconciliation(missionId: string, operatorId?: string, executionId?: string) {
    const op = requireOperator(operatorId);
    const receipt = this.deps.reconciliation.reconcile({
      mission_id: missionId,
      execution_id: executionId,
      correlation_id: `operator:${op}`,
    });
    this.deps.supervisor.wake(missionId, "RECONCILIATION_RESULT", {
      operator: op,
      outcome: receipt.outcome,
    });
    return receipt;
  }

  acknowledgeTerminal(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.store.tryGet("mission_runtime", `MRT_${missionId}`);
    if (!rt) throw new PolicyError("FAIL_CLOSED_MISSION_RUNTIME_NOT_FOUND", missionId);
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: `MRT_${missionId}`,
      event_type: "TERMINAL_ACKNOWLEDGED",
      actor: `OPERATOR:${op}`,
      metadata: { mission_id: missionId },
    });
    return rt;
  }

  /** Wake a mission for a scheduler-visible reason. */
  wake(missionId: string, reason: WakeReason, detail: Record<string, unknown> = {}) {
    return this.deps.supervisor.wake(missionId, reason, detail);
  }

  /** Tick all live missions once. */
  tick(now?: string) {
    return this.deps.supervisor.tick(now);
  }

  /* ---------------- promotion actions -------------------------------------- */

  approvePromotion(promotionId: string, operatorId: string | undefined) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.approvePromotion(promotionId, op);
  }

  rejectPromotion(promotionId: string, operatorId: string | undefined, reason: string) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.rejectPromotion(promotionId, reason);
  }
}
