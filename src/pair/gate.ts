/**
 * GovernedTaskGate port (donor standalone_core/governed_task.py).
 *
 * Control-plane boundary only: VALIDATED → DISPATCH_AUTHORIZED → dispatched.
 * It never selects tasks and never drives mission progression — Automaton
 * remains the WHAT/NEXT authority; this gate decides WHETHER a governed
 * dispatch may execute.
 *
 * Invariant: NO governed authorization = NO PAIR_NATIVE dispatch.
 */

import { digest, newId, pathWithin, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import { TASK_DISPATCHABLE_STATES } from "./service.js";
import type { PairEvidenceStore } from "./store.js";
import type { ExecutorAdapter } from "./adapter.js";
import { ArtifactProvenanceValidator } from "./artifact-validation.js";
import { sanitizeUntrustedRemote } from "./sanitizer.js";

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const HIGH_IMPACT_PERMISSIONS = new Set([
  "FILESYSTEM_WRITE_OUTSIDE_WORKSPACE",
  "NETWORK_EGRESS",
  "PROCESS_SPAWN_UNRESTRICTED",
  "CREDENTIAL_READ",
  "SECRETS_ACCESS",
]);
const FORBIDDEN_CONSTRAINTS = new Set([
  "ALLOW_OUTSIDE_WORKSPACE",
  "PERMISSION_EXPANSION",
  "DISABLE_AUDIT",
]);
const AUTO_CONSTRAINTS = [
  "DENY_OUTSIDE_WORKSPACE",
  "NO_SECRET_DUMPING",
  "NO_PERMISSION_EXPANSION"];

const REQUIRED_REQUEST_FIELDS = [
  "mission_id",
  "task_id",
  "plan_revision",
  "task_instruction",
  "workspace",
  "allowed_paths",
  "permissions",
  "constraints",
  "timeout",
  "expected_output_contract",
  "correlation_id",
] as const;

export class GovernedTaskGate {
  constructor(
    private readonly service: PairControlPlane,
    private readonly validator = new ArtifactProvenanceValidator(),
  ) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  /** The full governed authorization check chain. Fail-closed throughout. */
  create_governed_task(
    adapter: ExecutorAdapter,
    request: Record<string, unknown>,
  ): { governed_task: Record<string, unknown> } {
    for (const field of REQUIRED_REQUEST_FIELDS) {
      const v = request[field];
      if (v === undefined || v === null || v === "") {
        throw new IntegrityError(
          "FAIL_CLOSED_GOVERNED_TASK_CONTRACT_INCOMPLETE",
          `missing:${field}`,
        );
      }
    }
    const mission = this.service.getMission(String(request.mission_id));
    if (!["READY", "RUNNING"].includes(String(mission.status))) {
      throw new PolicyError(
        "FAIL_CLOSED_MISSION_NOT_EXECUTABLE",
        String(mission.status),
      );
    }
    const active = this.service.activeRevision(String(mission.mission_id));
    if (Number(request.plan_revision) !== active.revision) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_REVISION_MISMATCH",
        `${request.plan_revision}!=${active.revision}`,
      );
    }
    const task = this.service.getTask(String(request.task_id));
    if (task.mission_id !== mission.mission_id || task.plan_id !== active.plan_id) {
      throw new IntegrityError("FAIL_CLOSED_TASK_NOT_ACTIVE_PLAN", String(task.task_id));
    }
    if (!TASK_DISPATCHABLE_STATES.has(String(task.status))) {
      throw new PolicyError(
        "FAIL_CLOSED_TASK_NOT_DISPATCHABLE",
        String(task.status),
      );
    }
    if (task.selected_executor !== adapter.executor_id) {
      throw new PolicyError(
        "FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH",
        String(task.selected_executor),
      );
    }

    // P12/R2: canonical agent-execution validation — same helper the
    // pre-dispatch boundary re-runs, so the two paths cannot drift.
    this.assertAgentExecutionAllowed(mission, task, adapter.executor_id);
    return this.createGovernedTaskContinuation(adapter, request, mission, task, active);
  }

  /**
   * R2: canonical P12 agent-execution validation — reused by
   * create_governed_task AND the final pre-dispatch boundary so the two
   * enforcement paths cannot drift. Resolution itself fails closed
   * (pin, agent/contract ACTIVE, business, integrity) inside
   * effectiveForMission.
   */
  private assertAgentExecutionAllowed(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
    executorId: string,
  ): void {
    const boundAgentId = (
      (mission.metadata as Record<string, unknown> | undefined)?.org_agent_id
    );
    if (!boundAgentId) return;
    let agentPolicy;
    try {
      agentPolicy = this.service.agentContracts.effectiveForMission(mission);
    } catch (e) {
      if (e instanceof PolicyError || e instanceof IntegrityError) {
        this.service.agentContracts.auditDenial(
          (e as { code?: string }).code ?? "FAIL_CLOSED_AGENT_POLICY",
          (e as Error).message,
          { missionId: String(mission.mission_id), agentId: String(boundAgentId), taskId: String(task.task_id) },
        );
      }
      throw e;
    }
    const denyCtx = {
      missionId: String(mission.mission_id),
      agentId: String(boundAgentId),
      taskId: String(task.task_id),
      contractVersion: agentPolicy.contract_version,
    };
    const requiredCaps = (task.required_capabilities as string[]) ?? [];
    const explicitlyDenied = requiredCaps.filter((c) =>
      agentPolicy.denied_capabilities.has(c),
    );
    if (explicitlyDenied.length) {
      this.service.agentContracts.deny(
        "FAIL_CLOSED_AGENT_CAPABILITY_DENIED",
        `explicit-deny:${explicitlyDenied.sort().join(",")}`,
        denyCtx,
      );
    }
    if (agentPolicy.allowed_capabilities) {
      const deniedCaps = requiredCaps.filter(
        (c) => !agentPolicy.allowed_capabilities!.has(c),
      );
      if (deniedCaps.length) {
        this.service.agentContracts.deny(
          "FAIL_CLOSED_AGENT_CAPABILITY_DENIED",
          deniedCaps.sort().join(","),
          denyCtx,
        );
      }
    }
    const execDenied =
      agentPolicy.denied_executor_ids.has(executorId) ||
      (agentPolicy.allowed_executor_ids !== null &&
        !agentPolicy.allowed_executor_ids.has(executorId)) ||
      (agentPolicy.restricted_executor_ids !== null &&
        !agentPolicy.restricted_executor_ids.has(executorId));
    if (execDenied) {
      this.service.agentContracts.deny(
        "FAIL_CLOSED_AGENT_EXECUTOR_DENIED",
        String(executorId),
        denyCtx,
      );
    }
    const projectId = String(mission.project_id);
    if (
      agentPolicy.allowed_project_ids !== null &&
      !agentPolicy.allowed_project_ids.has(projectId)
    ) {
      this.service.agentContracts.deny(
        "FAIL_CLOSED_AGENT_PROJECT_DENIED",
        projectId,
        denyCtx,
      );
    }
    // Route revalidation: the canonical task carries the bound
    // selected_route_id; a now-denied or out-of-restriction route fails
    // closed. An unbound route has nothing to enforce here.
    const routeId = task.selected_route_id ? String(task.selected_route_id) : null;
    if (routeId) {
      if (agentPolicy.denied_route_ids.has(routeId)) {
        this.service.agentContracts.deny(
          "FAIL_CLOSED_AGENT_ROUTE_DENIED",
          String(routeId),
          denyCtx,
        );
      }
      if (
        agentPolicy.restricted_route_ids !== null &&
        !agentPolicy.restricted_route_ids.has(routeId)
      ) {
        this.service.agentContracts.deny(
          "FAIL_CLOSED_AGENT_ROUTE_RESTRICTED",
          String(routeId),
          denyCtx,
        );
      }
    }
  }

  private createGovernedTaskContinuation(
    adapter: ExecutorAdapter,
    request: Record<string, unknown>,
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
    active: Record<string, unknown>,
  ) {
    const q = adapter.qualify();
    if (!q.qualified) {
      throw new PolicyError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", adapter.executor_id);
    }
    const caps = adapter.capabilities();
    const adapterCaps = new Set(caps.capability_ids as string[]);
    const required = (task.required_capabilities as string[]) ?? [];
    const missing = required.filter((c) => !adapterCaps.has(c));
    if (missing.length) {
      throw new PolicyError(
        "FAIL_CLOSED_CAPABILITY_MISMATCH",
        missing.join(","),
      );
    }

    // Workspace authorization.
    const workspace = String(request.workspace);
    const roots = this.service.authorizedRoots(String(mission.mission_id));
    if (!roots.some((r) => pathWithin(workspace, r))) {
      throw new PolicyError("FAIL_CLOSED_WORKSPACE_UNAUTHORIZED", workspace);
    }
    const allowedPaths = request.allowed_paths as string[];
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
      throw new IntegrityError("FAIL_CLOSED_GOVERNED_TASK_CONTRACT_INCOMPLETE", "allowed_paths");
    }
    for (const p of allowedPaths) {
      if (!pathWithin(p, workspace)) {
        throw new PolicyError("FAIL_CLOSED_ALLOWED_PATH_OUTSIDE_WORKSPACE", p);
      }
      if (!roots.some((r) => pathWithin(p, r))) {
        throw new PolicyError("FAIL_CLOSED_ALLOWED_PATH_UNAUTHORIZED", p);
      }
    }

    // Permissions ⊆ mission granted_permissions.
    const granted = new Set((mission.granted_permissions as string[]) ?? []);
    const requested = (request.permissions as string[]) ?? [];
    const extra = requested.filter((p) => !granted.has(p));
    if (extra.length) {
      throw new PolicyError("FAIL_CLOSED_PERMISSION_EXPANSION", extra.join(","));
    }

    // Tools ⊆ mission allowed_tools (when the mission constrains them).
    const allowedTools =
      ((mission.metadata as Record<string, unknown> | undefined)?.allowed_tools as
        | string[]
        | undefined) ?? null;
    const requestedTools = (request.requested_tools as string[]) ?? [];
    if (allowedTools) {
      const deniedTools = requestedTools.filter((t) => !allowedTools.includes(t));
      if (deniedTools.length) {
        throw new PolicyError("FAIL_CLOSED_TOOL_NOT_ALLOWED", deniedTools.join(","));
      }
    }

    // Constraints: forbidden rejected, safety constraints auto-appended.
    const constraints = new Set((request.constraints as string[]) ?? []);
    for (const c of constraints) {
      if (FORBIDDEN_CONSTRAINTS.has(c)) {
        throw new PolicyError("FAIL_CLOSED_CONSTRAINT_FORBIDDEN", c);
      }
    }
    for (const c of AUTO_CONSTRAINTS) {
      constraints.add(c);
    }

    const timeout = Number(request.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
      throw new IntegrityError("FAIL_CLOSED_TIMEOUT_OUT_OF_RANGE", String(request.timeout));
    }

    const gov = this.service.getRuntimeGovernance(String(mission.mission_id));
    const retryCount = Number(request.retry_count ?? task.retry_count ?? 0);
    const maxRetries = Number(gov.max_retries ?? 3);
    if (retryCount > maxRetries) {
      throw new PolicyError("FAIL_CLOSED_RETRY_BUDGET_EXHAUSTED", `${retryCount}>${maxRetries}`);
    }

    // Risk classification: task capabilities + metadata override.
    const capRisk = required
      .map((c) => {
        const cap = this.store.tryGet("capability", c);
        return String(cap?.risk_class ?? "MEDIUM");
      })
      .reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), "LOW");
    const taskMetaRisk = String(
      ((task.metadata as Record<string, unknown> | undefined)?.risk_class as string) ??
        capRisk,
    );
    const riskClass = taskMetaRisk;
    const riskIdx = RISK_ORDER.indexOf(riskClass);
    if (riskIdx < 0) {
      throw new IntegrityError("FAIL_CLOSED_RISK_CLASS_UNKNOWN", riskClass);
    }
    const ceiling = String(
      ((mission.metadata as Record<string, unknown> | undefined)?.risk_ceiling as string) ??
        "HIGH",
    );
    if (riskIdx > RISK_ORDER.indexOf(ceiling)) {
      throw new PolicyError("FAIL_CLOSED_RISK_CEILING_EXCEEDED", `${riskClass}>${ceiling}`);
    }

    const policy = this.service.getPolicyProfile(String(mission.policy_profile));
    const approvalRequirements = (policy.approval_requirements as string[]) ?? [];
    const needsApproval =
      riskIdx >= RISK_ORDER.indexOf("HIGH") ||
      requested.some((p) => HIGH_IMPACT_PERMISSIONS.has(p)) ||
      approvalRequirements.length > 0;

    const governedTaskId = newId("GTSK");
    const approvalScope = {
      mission_id: mission.mission_id,
      task_id: task.task_id,
      executor_id: adapter.executor_id,
      workspace,
      allowed_paths: allowedPaths,
      permissions: requested,
      expected_output_contract: request.expected_output_contract,
    };
    const scopeDigest = digest(approvalScope);

    let approvalId: string | null = null;
    if (needsApproval) {
      const approval = this.findValidApproval(
        String(mission.mission_id),
        String(task.task_id),
        scopeDigest,
      );
      if (!approval) {
        throw new IntegrityError(
          "FAIL_CLOSED_OPERATOR_APPROVAL_REQUIRED",
          `${task.task_id}:${scopeDigest.slice(0, 16)}`,
        );
      }
      approvalId = String(approval.approval_id);
    }

    const governed = {
      governed_task_id: governedTaskId,
      mission_id: mission.mission_id,
      task_id: task.task_id,
      plan_id: active.plan_id,
      plan_revision: active.revision,
      correlation_id: request.correlation_id,
      executor_id: adapter.executor_id,
      task_instruction: request.task_instruction,
      workspace,
      allowed_paths: allowedPaths,
      permissions: requested,
      constraints: [...constraints],
      requested_tools: (request.requested_tools as string[] | undefined) ?? [],
      dependency_outputs: (request.dependency_outputs as unknown[] | undefined) ?? [],
      timeout,
      expected_output_contract: request.expected_output_contract,
      risk_class: riskClass,
      approval_required: needsApproval,
      approval_id: approvalId,
      approval_scope_digest: scopeDigest,
      governance_state: "VALIDATED",
      dispatch_enabled: false,
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("governed_task", governedTaskId, governed, 0);
    (saved as Record<string, unknown>).governance_digest = digest(saved);
    const resaved = this.store.put(
      "governed_task",
      governedTaskId,
      saved as Record<string, unknown>,
      saved.version,
    );
    this.store.event({
      entity_type: "governed_task",
      entity_id: governedTaskId,
      event_type: "GOVERNED_TASK_VALIDATED",
      new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: String(request.correlation_id),
      metadata: {
        mission_id: mission.mission_id,
        task_id: task.task_id,
        executor_id: adapter.executor_id,
        risk_class: riskClass,
        approval_required: needsApproval,
      },
    });
    this.store.appendEvidence(String(mission.mission_id), "GOVERNED_TASK_VALIDATED", {
      governed_task_id: governedTaskId,
      task_id: task.task_id,
      executor_id: adapter.executor_id,
      approval_scope_digest: scopeDigest,
      approval_id: approvalId,
    });
    return { governed_task: resaved };
  }

  private findValidApproval(
    missionId: string,
    taskId: string,
    scopeDigest: string,
  ): Record<string, unknown> | null {
    const approvals = this.store.list("approval").filter(
      (a) =>
        a.mission_id === missionId &&
        a.task_id === taskId &&
        a.status === "APPROVED",
    );
    return approvals.find((a) => a.approval_scope_digest === scopeDigest) ?? null;
  }

  /** Operator boundary: record an APPROVED approval bound to the scope digest. */
  recordApproval(params: {
    mission_id: string;
    task_id: string;
    executor_id: string;
    approved_by: string;
    request: Record<string, unknown>;
  }): Record<string, unknown> {
    const scope = {
      mission_id: params.mission_id,
      task_id: params.task_id,
      executor_id: params.executor_id,
      workspace: String(params.request.workspace),
      allowed_paths: params.request.allowed_paths,
      permissions: params.request.permissions ?? [],
      expected_output_contract: params.request.expected_output_contract,
    };
    const approvalId = newId("APR");
    const approval = {
      approval_id: approvalId,
      mission_id: params.mission_id,
      task_id: params.task_id,
      executor_id: params.executor_id,
      status: "APPROVED",
      approved_by: params.approved_by,
      approval_scope_digest: digest(scope),
      created_at: utcnow(),
      version: 0,
    };
    const saved = this.store.put("approval", approvalId, approval, 0);
    this.store.event({
      entity_type: "approval",
      entity_id: approvalId,
      event_type: "APPROVAL_RECORDED",
      new_state: "APPROVED",
      actor: params.approved_by,
    });
    return saved;
  }

  authorize_dispatch(
    adapter: ExecutorAdapter,
    governedTaskId: string,
  ): Record<string, unknown> {
    const task = this.store.get("governed_task", governedTaskId);
    if (task.governance_state !== "VALIDATED") {
      throw new IntegrityError(
        "FAIL_CLOSED_GOVERNED_TASK_NOT_VALIDATED",
        String(task.governance_state),
      );
    }
    const q = adapter.qualify();
    if (!q.qualified || !q.dispatch_enabled) {
      throw new PolicyError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", adapter.executor_id);
    }
    task.governance_state = "DISPATCH_AUTHORIZED";
    task.dispatch_enabled = true;
    const saved = this.store.put("governed_task", governedTaskId, task, task.version);
    saved.governance_digest = digest(saved);
    const resaved = this.store.put("governed_task", governedTaskId, saved, saved.version);
    this.store.event({
      entity_type: "governed_task",
      entity_id: governedTaskId,
      event_type: "EXECUTION_PREPARED",
      old_state: "VALIDATED",
      new_state: "DISPATCH_AUTHORIZED",
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: String(task.correlation_id),
    });
    this.store.appendEvidence(String(task.mission_id), "DISPATCH_AUTHORIZED", {
      governed_task_id: governedTaskId,
      executor_id: adapter.executor_id,
    });
    return resaved;
  }

  /**
   * Dispatch a DISPATCH_AUTHORIZED governed task. Records a dedup'ing
   * executor_dispatch_intent, calls adapter.dispatch, persists the
   * executor_execution entity + evidence.
   */
  dispatch_governed_task(
    adapter: ExecutorAdapter,
    governedTaskId: string,
  ): Record<string, unknown> {
    const task = this.store.get("governed_task", governedTaskId);
    if (task.governance_state !== "DISPATCH_AUTHORIZED" || task.dispatch_enabled !== true) {
      throw new IntegrityError(
        "FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED",
        String(task.governance_state),
      );
    }
    if (task.executor_id !== adapter.executor_id) {
      throw new IntegrityError(
        "FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH",
        String(task.executor_id),
      );
    }
    const intentId = `INTENT_${governedTaskId}`;
    const existingIntent = this.store.tryGet("executor_dispatch_intent", intentId);
    if (existingIntent) {
      const state = String(existingIntent.state);
      // R4 §3/§6C: the persisted intent's own payload must match this
      // governed task — a stale/tampered intent fails closed before any
      // adoption or new dispatch. Historical execution bypasses CURRENT
      // contract checks but never identity/provenance checks.
      this.assertIntentIdentity(existingIntent, task, adapter, governedTaskId);
      if (state === "EXECUTION_PERSISTED" && existingIntent.execution_id) {
        // Idempotent re-dispatch: return the existing execution — only
        // after its canonical identity binds to this governed task.
        const exec = this.store.get(
          "executor_execution",
          String(existingIntent.execution_id),
        );
        this.assertExecutionIdentity(
          exec,
          task,
          adapter.executor_id,
          String(existingIntent.execution_id),
          governedTaskId,
        );
        // P13: a proven historical execution reconciles its reservation
        // to COMMITTED — never a new reservation, never a new dispatch.
        this.service.cost.reconcileForTask(governedTaskId, adapter);
        return exec;
      }
      if (state === "INTENT_RECORDED") {
        // Previous dispatch crashed before persisting — consult evidence.
        const evidence = adapter.dispatch_evidence?.(governedTaskId);
        if (evidence?.dispatched) {
          // R3 §3: dispatched proven but no usable execution_id —
          // redispatch could duplicate real side effects. Fail closed;
          // the intent stays INTENT_RECORDED for recovery.
          if (!evidence.execution_id) {
            this.store.appendEvidence(String(task.mission_id), "DISPATCH_EVIDENCE_INCOMPLETE", {
              governed_task_id: governedTaskId,
              executor_id: adapter.executor_id,
            });
            throw new IntegrityError(
              "FAIL_CLOSED_DISPATCH_EVIDENCE_INCOMPLETE",
              governedTaskId,
            );
          }
          const evidenceExecId = String(evidence.execution_id);
          // R4 §4: any pre-existing row under this id is identity-checked
          // before adoption — stale/buggy adapter evidence or an id
          // collision fails closed rather than adopting foreign history.
          const exec = this.reconcileProvenExecution(
            task,
            adapter,
            evidenceExecId,
            governedTaskId,
          );
          // Persist the intent only after local execution evidence is
          // durable; a racing reconciler may already have — adopt its
          // outcome when it names the same execution.
          try {
            this.store.put(
              "executor_dispatch_intent",
              intentId,
              { ...existingIntent, state: "EXECUTION_PERSISTED", execution_id: evidenceExecId },
              existingIntent.version,
            );
          } catch (e) {
            const cur = this.store.get("executor_dispatch_intent", intentId);
            if (
              String(cur.state) !== "EXECUTION_PERSISTED" ||
              String(cur.execution_id) !== evidenceExecId
            ) {
              throw e;
            }
          }
          // P13: proven historical dispatch → COMMIT the reservation.
          this.service.cost.reconcileForTask(governedTaskId, adapter);
          return exec;
        }
      }
    } else {
      this.store.put(
        "executor_dispatch_intent",
        intentId,
        {
          intent_id: intentId,
          governed_task_id: governedTaskId,
          executor_id: adapter.executor_id,
          state: "INTENT_RECORDED",
          created_at: utcnow(),
          version: 0,
        },
        0,
      );
    }

    // P13-R2 §1: reaching here means a NEW adapter.dispatch is being
    // prepared. A COMMITTED/SETTLED cost reservation proves external
    // (monetary) action may already exist, but carries no execution_id
    // to reconstruct — that is an ambiguous historical dispatch and can
    // NEVER authorize another adapter.dispatch. Fail closed.
    const crashGapRes = this.store.tryGet("cost_reservation", `CRSV_${governedTaskId}`);
    if (
      crashGapRes &&
      (String(crashGapRes.status) === "COMMITTED" ||
        String(crashGapRes.status) === "SETTLED")
    ) {
      this.store.appendEvidence(String(task.mission_id), "DISPATCH_EVIDENCE_INCOMPLETE", {
        governed_task_id: governedTaskId,
        executor_id: adapter.executor_id,
        reservation_status: String(crashGapRes.status),
      });
      throw new IntegrityError(
        "FAIL_CLOSED_COST_COMMITTED_EXECUTION_UNRESOLVED",
        governedTaskId,
      );
    }

    // R2: final pre-dispatch authority revalidation — only reached when a
    // NEW adapter.dispatch is about to happen (EXECUTION_PERSISTED and
    // evidence-reconciled intents returned above). Contract tightening
    // since validation/adoption revokes the dispatch here; an already-
    // dispatched execution is a historical fact and never re-checked.
    const predispatchMission = this.service.getMission(String(task.mission_id));
    const predispatchTask = this.service.getTask(String(task.task_id));
    this.assertAgentExecutionAllowed(
      predispatchMission,
      predispatchTask,
      adapter.executor_id,
    );

    // P13: atomic monetary authority — check + HELD reservation inside
    // one transaction, after contract authority and before dispatch.
    this.service.cost.assertAndReserve({
      mission: predispatchMission,
      task: predispatchTask,
      governedTask: task,
      executorId: adapter.executor_id,
    });

    let execution: Record<string, unknown>;
    try {
      execution = adapter.dispatch(task, { actor: "PAIR_GOVERNED_TASK_GATE" });
    } catch (e) {
      // Dispatch outcome is ambiguous unless adapter evidence proves it:
      // proven dispatch → COMMITTED, proven no-dispatch → RELEASED,
      // unknown → stays conservatively HELD for later reconciliation.
      this.service.cost.reconcileForTask(governedTaskId, adapter);
      throw e;
    }
    // P13-R2 §1 durable ordering: canonical executor_execution FIRST,
    // intent EXECUTION_PERSISTED SECOND, evidence THIRD, and only THEN is
    // the money committed. A crash after adapter.dispatch but before the
    // commit below leaves reservation HELD + intent INTENT_RECORDED —
    // ambiguous, recoverable, and never a license to redispatch.
    const executionId = String(execution.execution_id);
    const execEntity = this.store.put(
      "executor_execution",
      executionId,
      {
        execution_id: executionId,
        governed_task_id: governedTaskId,
        mission_id: task.mission_id,
        task_id: task.task_id,
        executor_id: adapter.executor_id,
        plan_revision: task.plan_revision,
        correlation_id: task.correlation_id,
        execution_state: String(execution.status ?? "RUNNING"),
        dispatch_timestamp: utcnow(),
        run_root: execution.run_root,
        workspace: execution.workspace,
        version: 0,
      },
      0,
    );
    const intent = this.store.get("executor_dispatch_intent", intentId);
    this.store.put(
      "executor_dispatch_intent",
      intentId,
      { ...intent, state: "EXECUTION_PERSISTED", execution_id: executionId },
      intent.version,
    );
    this.store.event({
      entity_type: "executor_execution",
      entity_id: executionId,
      event_type: "EXECUTION_DISPATCHED",
      new_state: execEntity.execution_state as string,
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: String(task.correlation_id),
      metadata: { governed_task_id: governedTaskId },
    });
    this.store.appendEvidence(String(task.mission_id), "EXECUTION_DISPATCHED", {
      governed_task_id: governedTaskId,
      execution_id: executionId,
      executor_id: adapter.executor_id,
    });
    this.service.cost.markCommitted(governedTaskId);
    return execEntity;
  }

  /**
   * R4 §3/§6C: the intent entity keyed INTENT_<governedTaskId> must
   * carry a matching governed_task_id and the dispatching executor.
   * Anything else is malformed persisted state — fail closed.
   */
  private assertIntentIdentity(
    intent: Record<string, unknown>,
    task: Record<string, unknown>,
    adapter: ExecutorAdapter,
    governedTaskId: string,
  ): void {
    if (
      String(intent.governed_task_id) === governedTaskId &&
      String(intent.executor_id) === String(adapter.executor_id)
    ) {
      return;
    }
    this.store.appendEvidence(String(task.mission_id), "DISPATCH_INTENT_IDENTITY_MISMATCH", {
      governed_task_id: governedTaskId,
      intent_governed_task_id: String(intent.governed_task_id ?? ""),
      intent_executor_id: String(intent.executor_id ?? ""),
    });
    throw new IntegrityError(
      "FAIL_CLOSED_DISPATCH_INTENT_IDENTITY_MISMATCH",
      governedTaskId,
    );
  }

  /**
   * R4 §2: an executor_execution row is only adoptable when its
   * canonical identity binds to the governed task being recovered.
   * Never trust an execution_id alone (stale adapter evidence, id
   * collisions, malformed local state).
   */
  private assertExecutionIdentity(
    exec: Record<string, unknown>,
    task: Record<string, unknown>,
    executorId: string,
    executionId: string,
    governedTaskId: string,
  ): void {
    const pairs: Array<[string, unknown, unknown]> = [
      ["execution_id", exec.execution_id, executionId],
      ["governed_task_id", exec.governed_task_id, governedTaskId],
      ["mission_id", exec.mission_id, task.mission_id],
      ["task_id", exec.task_id, task.task_id],
      ["executor_id", exec.executor_id, executorId],
      ["plan_revision", exec.plan_revision, task.plan_revision],
      ["correlation_id", exec.correlation_id, task.correlation_id],
    ];
    const mismatch = pairs.find(
      ([, actual, expected]) => String(actual ?? null) !== String(expected ?? null),
    );
    // Workspace only when both sides carry a meaningful value.
    const wsMismatch =
      exec.workspace != null &&
      task.workspace != null &&
      String(exec.workspace) !== String(task.workspace);
    if (!mismatch && !wsMismatch) return;
    const field = mismatch ? mismatch[0] : "workspace";
    this.store.appendEvidence(
      String(task.mission_id),
      "EXECUTION_RECONCILE_IDENTITY_MISMATCH",
      { governed_task_id: governedTaskId, execution_id: executionId, field },
    );
    throw new IntegrityError(
      "FAIL_CLOSED_EXECUTION_RECONCILE_IDENTITY_MISMATCH",
      `${governedTaskId}:${field}`,
    );
  }

  private emitReconciliationEvent(
    exec: Record<string, unknown>,
    task: Record<string, unknown>,
    governedTaskId: string,
  ): void {
    this.store.event({
      entity_type: "executor_execution",
      entity_id: String(exec.execution_id),
      event_type: "EXECUTION_RECONCILED",
      new_state: String(exec.execution_state),
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: String(task.correlation_id),
      metadata: { governed_task_id: governedTaskId },
    });
  }

  private emitReconciliationEvidence(
    exec: Record<string, unknown>,
    task: Record<string, unknown>,
    governedTaskId: string,
  ): void {
    this.store.appendEvidence(String(task.mission_id), "EXECUTION_RECONCILED", {
      governed_task_id: governedTaskId,
      execution_id: String(exec.execution_id),
      executor_id: String(exec.executor_id),
    });
  }

  /**
   * R4 §5: at-least-once repair for a canonical row whose reconciliation
   * audit was lost to a crash. Missing pieces are emitted independently;
   * append-only store conventions make re-emission safe.
   */
  private ensureReconciliationEvidence(
    exec: Record<string, unknown>,
    task: Record<string, unknown>,
    governedTaskId: string,
  ): void {
    const eid = String(exec.execution_id);
    const hasEvent = this.store
      .listEvents("executor_execution", eid)
      .some((e) => String(e.event_type) === "EXECUTION_RECONCILED");
    if (!hasEvent) this.emitReconciliationEvent(exec, task, governedTaskId);
    const hasEvidence = this.store.listEvidence(String(task.mission_id)).some((e) => {
      if (String(e.kind) !== "EXECUTION_RECONCILED") return false;
      const inner = (e.payload as Record<string, unknown> | undefined)?.payload as
        | Record<string, unknown>
        | undefined;
      return String(inner?.governed_task_id) === governedTaskId;
    });
    if (!hasEvidence) this.emitReconciliationEvidence(exec, task, governedTaskId);
  }

  /**
   * R3 §2/§6 + R4 §1/§5: reconstruct the canonical local
   * executor_execution for a proven external dispatch when the local row
   * is absent (crash between external dispatch and persistence).
   * Insert-only CAS — ONLY FAIL_CLOSED_VERSION_CONFLICT adopts the
   * winner's row (after identity validation); every other failure
   * propagates so the intent stays INTENT_RECORDED and recoverable.
   * No fabricated dispatch_timestamp: `reconciled_at` records recovery
   * time only.
   */
  private reconcileProvenExecution(
    task: Record<string, unknown>,
    adapter: ExecutorAdapter,
    executionId: string,
    governedTaskId: string,
  ): Record<string, unknown> {
    const existing = this.store.tryGet("executor_execution", executionId);
    if (existing) {
      this.assertExecutionIdentity(
        existing,
        task,
        adapter.executor_id,
        executionId,
        governedTaskId,
      );
      this.ensureReconciliationEvidence(existing, task, governedTaskId);
      return existing;
    }
    let observed: string | null = null;
    try {
      const ob = adapter.observe?.(executionId);
      if (ob?.status) observed = String(ob.status);
    } catch {
      /* observation unprovable — keep null */
    }
    const entity = {
      execution_id: executionId,
      governed_task_id: String(task.governed_task_id),
      mission_id: task.mission_id,
      task_id: task.task_id,
      executor_id: adapter.executor_id,
      plan_revision: task.plan_revision,
      correlation_id: task.correlation_id,
      execution_state: observed ?? "RUNNING",
      reconciled_from_dispatch_evidence: true,
      reconciled_at: utcnow(),
      workspace: task.workspace,
      version: 0,
    };
    let saved: Record<string, unknown>;
    try {
      saved = this.store.put("executor_execution", executionId, entity, 0);
    } catch (e) {
      // R4 §1: only the insert CAS conflict means "someone else
      // reconciled first". Every other failure propagates — the intent
      // must NOT promote while local state is undefined.
      if ((e as { code?: string }).code !== "FAIL_CLOSED_VERSION_CONFLICT") {
        throw e;
      }
      const row = this.store.get("executor_execution", executionId);
      this.assertExecutionIdentity(
        row,
        task,
        adapter.executor_id,
        executionId,
        governedTaskId,
      );
      this.ensureReconciliationEvidence(row, task, governedTaskId);
      return row;
    }
    // Canonical row durable — now the reconciliation audit MUST persist
    // before the caller promotes the intent. A failure here propagates;
    // the next recovery pass repairs via the adoption branch above.
    this.emitReconciliationEvent(saved, task, governedTaskId);
    this.emitReconciliationEvidence(saved, task, governedTaskId);
    return saved;
  }

  observe_execution(
    adapter: ExecutorAdapter,
    executionId: string,
  ): Record<string, unknown> {
    const execution = this.store.get("executor_execution", executionId);
    // Remote observation text is untrusted — scrub broker material before
    // it becomes canonical (P13-R4 §1).
    const observed = sanitizeUntrustedRemote(adapter.observe(executionId)).value as Record<
      string,
      unknown
    >;
    execution.last_observation = observed;
    if (observed.status && String(observed.status) !== String(execution.execution_state)) {
      execution.execution_state = String(observed.status);
    }
    return this.store.put("executor_execution", executionId, execution, execution.version);
  }

  collect_execution_result(
    adapter: ExecutorAdapter,
    executionId: string,
  ): Record<string, unknown> {
    const execution = this.store.get("executor_execution", executionId);
    let result = adapter.collect_result(executionId);
    // Identity binding: result must name the same governed task / mission / task.
    for (const field of ["mission_id", "task_id", "governed_task_id"]) {
      if (result[field] && String(result[field]) !== String(execution[field])) {
        throw new IntegrityError(
          "FAIL_CLOSED_RESULT_IDENTITY_MISMATCH",
          `${field}:${result[field]}!=${execution[field]}`,
        );
      }
    }
    // P13-R4 §1: untrusted remote output is sanitized BEFORE it becomes
    // canonical — broker capabilities, the master token and released
    // credential values are redacted here; the store layer additionally
    // fails closed on any raw bcap1.* that still reaches it. The redaction
    // audit records counts only, never the value.
    const sanitized = sanitizeUntrustedRemote(result);
    result = sanitized.value as Record<string, unknown>;
    if (sanitized.capability_redactions > 0 || sanitized.secret_redactions > 0) {
      this.store.appendEvidence(String(execution.mission_id), "REMOTE_RESULT_REDACTED", {
        execution_id: executionId,
        capability_redactions: sanitized.capability_redactions,
        secret_redactions: sanitized.secret_redactions,
      });
    }
    execution.result = result;
    // P13 §16: settle the reservation — adapter-proven figures settle
    // exactly; unprovable usage stays COMMITTED at reserved maximum.
    this.service.cost.settleFromResult(String(execution.governed_task_id), result);
    execution.result_state = result.status;
    execution.execution_state = result.status;
    const saved = this.store.put("executor_execution", executionId, execution, execution.version);
    this.store.event({
      entity_type: "executor_execution",
      entity_id: executionId,
      event_type: "RESULT_COLLECTED",
      new_state: String(result.status),
      actor: "PAIR_GOVERNED_TASK_GATE",
      correlation_id: String(execution.correlation_id),
    });
    this.store.appendEvidence(String(execution.mission_id), "RESULT_COLLECTED", {
      execution_id: executionId,
      status: result.status,
      result_digest: digest(result),
    });
    return saved;
  }

  /** Terminal validation: artifact provenance + workspace confinement. */
  validate_execution_result(executionId: string): Record<string, unknown> {
    return this.validator.validate_execution(this.service, executionId);
  }
}
