/**
 * P8 RecoveryController — governed autonomous recovery decision authority.
 *
 * Authority boundary: the controller DECIDES exactly one recovery action and
 * persists a tamper-evident recovery_decision receipt. It never dispatches
 * itself: RETRY_SAME_ROUTE / RE_ROUTE re-enter through MissionRouter +
 * GovernedTaskGate; REPLAN re-enters through the planner + validatePlanProposal;
 * APPLY_VERIFIED_REMEDIATION produces a governed remediation task executed
 * through the same gate. It cannot widen permissions, credentials, workspace,
 * or mark a provider/model/executor qualified — P3/P6 authorities stand.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { PairEvidenceStore } from "./store.js";

export const RECOVERY_MATRIX_VERSION = "pair.os.vnext.recovery-matrix.v1";
export const RECOVERY_SCHEMA = "pair.os.vnext.recovery-decision.v1";

export const FAILURE_CLASSES = [
  "TRANSIENT_TRANSPORT",
  "RATE_LIMITED",
  "AUTHENTICATION_FAILURE",
  "AUTHORIZATION_FAILURE",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_UNHEALTHY",
  "PROVIDER_UNAVAILABLE",
  "MODEL_UNAVAILABLE",
  "TIMEOUT",
  "CANCELLED",
  "POLICY_DENIAL",
  "PERMISSION_DENIAL",
  "WORKSPACE_DENIAL",
  "ARTIFACT_VALIDATION_FAILURE",
  "RESULT_SCHEMA_FAILURE",
  "DEPENDENCY_FAILURE",
  "TOOL_FAILURE",
  "PROCESS_EXIT",
  "AMBIGUOUS_DISPATCH",
  "UNKNOWN_SIDE_EFFECT_STATE",
  "PLAN_INVALIDATED",
  "ENVIRONMENT_INCOMPATIBLE",
  "REMOTE_INPUT_REQUIRED",
  "BUDGET_EXCEEDED",
  "INTERNAL_RUNTIME_DEFECT",
  "UNKNOWN",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RECOVERY_ACTIONS = [
  "RETRY_SAME_ROUTE",
  "RE_ROUTE",
  "REPLAN",
  "APPLY_VERIFIED_REMEDIATION",
  "RECONCILIATION_REQUIRED",
  "HUMAN_APPROVAL_REQUIRED",
  "ABORT",
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

interface MatrixRow {
  actions: RecoveryAction[];
  /** whether RETRY_SAME_ROUTE counts against the retry budget */
  retry_allowed: boolean;
  /** INTERNAL_RUNTIME_DEFECT may spawn a self-improvement candidate */
  may_create_selfmod_candidate?: boolean;
}

export const RECOVERY_MATRIX: Record<FailureClass, MatrixRow> = {
  TRANSIENT_TRANSPORT: { actions: ["RETRY_SAME_ROUTE", "RE_ROUTE", "RECONCILIATION_REQUIRED"], retry_allowed: true },
  RATE_LIMITED: { actions: ["RE_ROUTE", "RETRY_SAME_ROUTE", "HUMAN_APPROVAL_REQUIRED"], retry_allowed: true },
  AUTHENTICATION_FAILURE: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  AUTHORIZATION_FAILURE: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  EXECUTOR_UNAVAILABLE: { actions: ["RE_ROUTE", "RECONCILIATION_REQUIRED", "ABORT"], retry_allowed: false },
  EXECUTOR_UNHEALTHY: { actions: ["RE_ROUTE", "RECONCILIATION_REQUIRED"], retry_allowed: false },
  PROVIDER_UNAVAILABLE: { actions: ["RE_ROUTE", "RETRY_SAME_ROUTE"], retry_allowed: true },
  MODEL_UNAVAILABLE: { actions: ["RE_ROUTE"], retry_allowed: false },
  TIMEOUT: { actions: ["RECONCILIATION_REQUIRED", "RETRY_SAME_ROUTE", "RE_ROUTE"], retry_allowed: true },
  CANCELLED: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  POLICY_DENIAL: { actions: ["ABORT"], retry_allowed: false },
  PERMISSION_DENIAL: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  WORKSPACE_DENIAL: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  ARTIFACT_VALIDATION_FAILURE: { actions: ["APPLY_VERIFIED_REMEDIATION", "REPLAN", "ABORT"], retry_allowed: false },
  RESULT_SCHEMA_FAILURE: { actions: ["RETRY_SAME_ROUTE", "REPLAN"], retry_allowed: true },
  DEPENDENCY_FAILURE: { actions: ["REPLAN", "ABORT"], retry_allowed: false },
  TOOL_FAILURE: { actions: ["RETRY_SAME_ROUTE", "RE_ROUTE"], retry_allowed: true },
  PROCESS_EXIT: { actions: ["RETRY_SAME_ROUTE", "RE_ROUTE"], retry_allowed: true },
  AMBIGUOUS_DISPATCH: { actions: ["RECONCILIATION_REQUIRED"], retry_allowed: false },
  UNKNOWN_SIDE_EFFECT_STATE: { actions: ["RECONCILIATION_REQUIRED", "HUMAN_APPROVAL_REQUIRED"], retry_allowed: false },
  PLAN_INVALIDATED: { actions: ["REPLAN"], retry_allowed: false },
  ENVIRONMENT_INCOMPATIBLE: { actions: ["RE_ROUTE", "REPLAN", "ABORT"], retry_allowed: false },
  // Remote agent settled while waiting on operator input — only a human can
  // unblock it (answer the session, supply a credential), so escalate
  // immediately; retrying just respawns a session that blocks again.
  REMOTE_INPUT_REQUIRED: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  // Operator-set spend cap hit — never auto-retry spending; the human either
  // raises the budget (approve) or stops the mission (abort).
  BUDGET_EXCEEDED: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false },
  INTERNAL_RUNTIME_DEFECT: { actions: ["HUMAN_APPROVAL_REQUIRED", "ABORT"], retry_allowed: false, may_create_selfmod_candidate: true },
  UNKNOWN: { actions: ["RECONCILIATION_REQUIRED", "ABORT"], retry_allowed: false },
};

export interface RecoveryPolicy {
  max_attempts_per_task: number;
  max_attempts_per_mission: number;
  max_replans_per_mission: number;
  max_remediations_per_signature: number;
  max_consecutive_identical: number;
  retry_backoff_base_ms: number;
  retry_backoff_max_ms: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  max_attempts_per_task: 3,
  max_attempts_per_mission: 10,
  max_replans_per_mission: 2,
  max_remediations_per_signature: 2,
  max_consecutive_identical: 3,
  retry_backoff_base_ms: 1000,
  retry_backoff_max_ms: 30_000,
};

const CLASS_RULES: Array<[RegExp, FailureClass]> = [
  [/REMOTE_INPUT_REQUIRED|AWAITING_INPUT|BLOCKED_AWAITING/i, "REMOTE_INPUT_REQUIRED"],
  [/BUDGET_EXCEEDED|COST_HALT|SPEND_LIMIT/i, "BUDGET_EXCEEDED"],
  [/RATE_LIMIT|429|TPD|TPM|QUOTA/i, "RATE_LIMITED"],
  [/AUTH(ENTICATION)?_|CREDENTIAL|UNAUTHORIZED_401|LOGIN/i, "AUTHENTICATION_FAILURE"],
  [/AUTHORIZATION|FORBIDDEN|DENY_BY|403/i, "AUTHORIZATION_FAILURE"],
  [/PERMISSION|ALLOWED_PATH|PATH_OUTSIDE|FILE_ACCESS/i, "PERMISSION_DENIAL"],
  [/WORKSPACE/i, "WORKSPACE_DENIAL"],
  [/POLICY|CAPABILITY_MISMATCH|NOT_DISPATCHABLE|GOVERNANCE/i, "POLICY_DENIAL"],
  [/EXECUTOR_UNAVAILABLE|ADAPTER_NOT_BOUND|SPAWN|EXECUTABLE_NOT_FOUND|ENOENT/i, "EXECUTOR_UNAVAILABLE"],
  [/UNHEALTHY|NOT_READY|HEALTH/i, "EXECUTOR_UNHEALTHY"],
  [/PROVIDER/i, "PROVIDER_UNAVAILABLE"],
  [/MODEL_UNAVAILABLE|MODEL_REMOVED|MODEL_NOT/i, "MODEL_UNAVAILABLE"],
  [/TIMEOUT/i, "TIMEOUT"],
  [/CANCEL/i, "CANCELLED"],
  [/ARTIFACT|PROVENANCE|VALIDATION_FAIL/i, "ARTIFACT_VALIDATION_FAILURE"],
  [/RESULT_SCHEMA|SCHEMA|RESULT_MISSING|MALFORMED/i, "RESULT_SCHEMA_FAILURE"],
  [/DEPENDENCY|DEPENDS_ON/i, "DEPENDENCY_FAILURE"],
  [/TOOL_|TOOLFAIL|MCP/i, "TOOL_FAILURE"],
  [/PROCESS_EXIT|_EXIT_|EXIT_CODE|SIGNAL/i, "PROCESS_EXIT"],
  [/AMBIGUOUS/i, "AMBIGUOUS_DISPATCH"],
  [/UNKNOWN_SIDE_EFFECT/i, "UNKNOWN_SIDE_EFFECT_STATE"],
  [/PLAN_INVALIDATED|REVISION_MISMATCH/i, "PLAN_INVALIDATED"],
  [/ENVIRONMENT|PLATFORM|OS_INCOMPATIBLE/i, "ENVIRONMENT_INCOMPATIBLE"],
  [/INTERNAL|RUNTIME_DEFECT|BUG/i, "INTERNAL_RUNTIME_DEFECT"],
  [/TRANSPORT|ACP_|ECONN|SOCKET|STDIO|RPC|NETWORK/i, "TRANSIENT_TRANSPORT"],
];

/** Executor-environment mismatch signals: the executor ran but its sandbox cannot serve the task (e.g. network blocked). These reroute immediately — retrying the same route cannot help. */
const ENVIRONMENT_INCOMPATIBLE_SIGNAL =
  /ENOTFOUND|EAI_AGAIN|DNS resolution|name resolution|could not resolve|network (is )?(unreachable|blocked|disabled|not allowed|restricted)|ERR_INTERNET|NETWORK_SANDBOX|no route to host/i;

/** Map a raw failure (execution entity, adapter error, or thrown PairError) to a stable class. */
export function classifyFailure(input: {
  execution_state?: string;
  error_class?: string;
  error_code?: string;
  result?: Record<string, unknown> | null;
}): FailureClass {
  const errClass = String(
    input.error_class ??
      input.error_code ??
      (input.result?.error as Record<string, unknown> | undefined)?.class ??
      "",
  );
  const resultObj = input.result as Record<string, unknown> | null | undefined;
  const errorObj = resultObj?.error as Record<string, unknown> | undefined;
  const haystack = [errClass, errorObj?.message, resultObj?.summary, resultObj?.stderr]
    .map((v) => String(v ?? ""))
    .join("\n");
  if (ENVIRONMENT_INCOMPATIBLE_SIGNAL.test(haystack)) return "ENVIRONMENT_INCOMPATIBLE";
  for (const [re, cls] of CLASS_RULES) {
    if (re.test(errClass)) return cls;
  }
  const state = String(input.execution_state ?? input.result?.status ?? "");
  if (state === "TIMEOUT") return "TIMEOUT";
  if (state === "CANCELLED") return "CANCELLED";
  if (state === "FAILED") return errClass ? "PROCESS_EXIT" : "UNKNOWN";
  return "UNKNOWN";
}

export function recoveryDecisionDigest(d: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (["decision_digest", "version", "entity_type", "entity_id", "created_at"].includes(k)) continue;
    body[k] = v;
  }
  return digest(body);
}

interface LedgerCounts {
  attempts_task: number;
  attempts_mission: number;
  replans_mission: number;
  remediations_signature: number;
  consecutive_identical: number;
}

export class RecoveryController {
  constructor(
    private readonly service: PairControlPlane,
    private readonly policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
    private readonly opts: { enabled?: boolean } = {},
  ) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  enabled(): boolean {
    return this.opts.enabled !== false;
  }

  private signatureOf(failureClass: FailureClass, executorId?: string, capability?: string): string {
    return `${failureClass}::${executorId ?? "any"}::${capability ?? "any"}`;
  }

  private ledgerCounts(missionId: string, taskId: string, signature: string): LedgerCounts {
    const decisions = this.store.list("recovery_decision");
    const attempts = this.store.list("recovery_attempt");
    const inMission = decisions.filter((d) => d.mission_id === missionId);
    const inTask = inMission.filter((d) => d.task_id === taskId);
    const consecutive = [...inTask]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .reverse();
    let run = 0;
    for (const d of consecutive) {
      if (String(d.failure_signature) === signature) run += 1;
      else break;
    }
    return {
      attempts_task: attempts.filter((a) => a.task_id === taskId).length,
      attempts_mission: attempts.filter((a) => a.mission_id === missionId).length,
      replans_mission: inMission.filter((d) => d.selected_action === "REPLAN").length,
      remediations_signature: inMission.filter(
        (d) => d.selected_action === "APPLY_VERIFIED_REMEDIATION" && d.failure_signature === signature,
      ).length,
      consecutive_identical: run,
    };
  }

  /**
   * Decide exactly one governed recovery action. Persists a recovery_decision
   * receipt + recovery_attempt row for every non-advisory outcome.
   */
  decide(input: {
    mission_id: string;
    task_id?: string;
    execution_id?: string;
    governed_task_id?: string;
    executor_id?: string;
    route_decision_id?: string;
    capability?: string;
    failure_class?: FailureClass;
    /** raw error for classification when failure_class omitted */
    error?: { code?: string; class?: string };
    execution_state?: string;
    result?: Record<string, unknown> | null;
    /** post-gates eligible executors from the router (re-route feasibility) */
    eligible_executors?: string[];
    /** ACTIVE REMEDIATION_PAIR experience ids, already filtered for compatibility by caller/ExperienceService */
    verified_remediation_ids?: string[];
    risk_class?: string;
    evidence_refs?: string[];
    correlation_id?: string;
    now?: string;
    /**
     * P9: operator-approved budget extensions. An APPROVED RECOVERY_APPROVAL
     * grants a bounded one-off extension recorded by the runtime; the grant
     * itself lives in the approval ledger — this only widens ceilings the
     * operator explicitly approved. Never widens the matrix.
     */
    budget_extension?: { attempts_per_task?: number; attempts_per_mission?: number };
  }): Record<string, unknown> {
    if (!this.enabled()) {
      throw new PolicyError("FAIL_CLOSED_RECOVERY_DISABLED", input.mission_id);
    }
    const policy: RecoveryPolicy = {
      ...this.policy,
      max_attempts_per_task:
        this.policy.max_attempts_per_task + (input.budget_extension?.attempts_per_task ?? 0),
      max_attempts_per_mission:
        this.policy.max_attempts_per_mission + (input.budget_extension?.attempts_per_mission ?? 0),
    };
    const taskId = input.task_id ?? "";
    const failureClass =
      input.failure_class ??
      classifyFailure({
        execution_state: input.execution_state,
        error_code: input.error?.code,
        error_class: input.error?.class,
        result: input.result,
      });
    const signature = this.signatureOf(failureClass, input.executor_id, input.capability);
    const counts = this.ledgerCounts(input.mission_id, taskId, signature);
    const now = input.now ?? utcnow();

    const candidates: RecoveryAction[] = [...RECOVERY_MATRIX[failureClass].actions];
    const rejected: Array<{ action: RecoveryAction; reason: string }> = [];
    let selected: RecoveryAction | null = null;
    const rejectRest = (reason: string) => {
      for (const a of candidates) if (a !== selected) rejected.push({ action: a, reason });
    };

    // Loop/escalation guards run BEFORE the matrix — hard ceilings
    // (ceilings include any operator-approved budget extension).
    if (counts.attempts_task >= policy.max_attempts_per_task) {
      selected = "HUMAN_APPROVAL_REQUIRED";
      rejectRest("MAX_RECOVERY_ATTEMPTS_PER_TASK");
    } else if (counts.attempts_mission >= policy.max_attempts_per_mission) {
      selected = "ABORT";
      rejectRest("MAX_RECOVERY_ATTEMPTS_PER_MISSION");
    } else if (counts.consecutive_identical >= policy.max_consecutive_identical) {
      selected = "HUMAN_APPROVAL_REQUIRED";
      rejectRest("MAX_CONSECUTIVE_IDENTICAL_FAILURES");
    } else {
      for (const action of candidates) {
        if (selected) {
          rejected.push({ action, reason: "LOWER_PRIORITY_THAN_SELECTED" });
          continue;
        }
        switch (action) {
          case "RETRY_SAME_ROUTE": {
            if (!RECOVERY_MATRIX[failureClass].retry_allowed) {
              rejected.push({ action, reason: "RETRY_NOT_ALLOWED_FOR_CLASS" });
            } else if (counts.attempts_task >= policy.max_attempts_per_task) {
              rejected.push({ action, reason: "RETRY_BUDGET_EXHAUSTED" });
            } else {
              selected = action;
            }
            break;
          }
          case "RE_ROUTE": {
            const eligible = input.eligible_executors ?? [];
            const alternates = eligible.filter((e) => e !== input.executor_id);
            if (alternates.length === 0) {
              rejected.push({ action, reason: "NO_ALTERNATE_ELIGIBLE_EXECUTOR" });
            } else {
              selected = action;
            }
            break;
          }
          case "REPLAN": {
            if (counts.replans_mission >= policy.max_replans_per_mission) {
              rejected.push({ action, reason: "MAX_REPLANS_PER_MISSION" });
            } else {
              selected = action;
            }
            break;
          }
          case "APPLY_VERIFIED_REMEDIATION": {
            if (!input.verified_remediation_ids?.length) {
              rejected.push({ action, reason: "NO_ACTIVE_COMPATIBLE_REMEDIATION" });
            } else if (counts.remediations_signature >= policy.max_remediations_per_signature) {
              rejected.push({ action, reason: "MAX_REMEDIATIONS_PER_FAILURE_SIGNATURE" });
            } else {
              selected = action;
            }
            break;
          }
          default:
            selected = action;
        }
      }
    }
    if (!selected) selected = "ABORT";

    const attemptNo = counts.attempts_task + 1;
    const backoffMs =
      selected === "RETRY_SAME_ROUTE"
        ? Math.min(
            policy.retry_backoff_base_ms * 2 ** counts.attempts_task,
            policy.retry_backoff_max_ms,
          )
        : 0;

    const decision: Record<string, unknown> = {
      schema: RECOVERY_SCHEMA,
      recovery_id: newId("RCV"),
      mission_id: input.mission_id,
      task_id: taskId,
      execution_id: input.execution_id ?? null,
      governed_task_id: input.governed_task_id ?? null,
      executor_id: input.executor_id ?? null,
      route_decision_id: input.route_decision_id ?? null,
      failure_class: failureClass,
      failure_signature: signature,
      policy_version: RECOVERY_MATRIX_VERSION,
      attempt_no: attemptNo,
      retry_budget_remaining: Math.max(0, policy.max_attempts_per_task - attemptNo),
      backoff_ms: backoffMs,
      candidate_actions: candidates,
      selected_action: selected,
      rejected_actions: rejected,
      experience_ids_considered: input.verified_remediation_ids ?? [],
      remediation_experience_id:
        selected === "APPLY_VERIFIED_REMEDIATION" ? input.verified_remediation_ids![0] : null,
      evidence_refs: input.evidence_refs ?? (input.execution_id ? [input.execution_id] : []),
      selfmod_candidate_eligible: RECOVERY_MATRIX[failureClass].may_create_selfmod_candidate === true,
      created_at: now,
      correlation_id: input.correlation_id ?? null,
      version: 0,
    };
    decision.decision_digest = recoveryDecisionDigest(decision);
    const saved = this.store.put(
      "recovery_decision",
      String(decision.recovery_id),
      decision,
      0,
    );

    this.store.put(
      "recovery_attempt",
      newId("RATT"),
      {
        recovery_id: decision.recovery_id,
        mission_id: input.mission_id,
        task_id: taskId,
        execution_id: input.execution_id ?? null,
        failure_class: failureClass,
        failure_signature: signature,
        attempt_no: attemptNo,
        selected_action: selected,
        created_at: now,
        version: 0,
      },
      0,
    );

    const eventFor: Record<RecoveryAction, string> = {
      RETRY_SAME_ROUTE: "RECOVERY_RETRY_REQUESTED",
      RE_ROUTE: "RECOVERY_REROUTE_REQUESTED",
      REPLAN: "RECOVERY_REPLAN_REQUESTED",
      APPLY_VERIFIED_REMEDIATION: "RECOVERY_REMEDIATION_REQUESTED",
      RECONCILIATION_REQUIRED: "RECONCILIATION_STARTED",
      HUMAN_APPROVAL_REQUIRED: "RECOVERY_HUMAN_APPROVAL_REQUIRED",
      ABORT: "RECOVERY_ABORTED",
    };
    this.store.event({
      entity_type: "recovery_decision",
      entity_id: String(decision.recovery_id),
      event_type: "RECOVERY_DECISION_CREATED",
      new_state: selected,
      actor: "PAIR_RECOVERY_CONTROLLER",
      correlation_id: input.correlation_id ?? null,
      metadata: { failure_class: failureClass, failure_signature: signature },
    });
    this.store.event({
      entity_type: "recovery_decision",
      entity_id: String(decision.recovery_id),
      event_type: eventFor[selected],
      new_state: selected,
      actor: "PAIR_RECOVERY_CONTROLLER",
      correlation_id: input.correlation_id ?? null,
    });
    return saved;
  }

  /**
   * Supersede a failed governed task so MissionRouter re-routes the task
   * instead of adopting the dead binding. Still not a dispatch: the caller
   * re-enters routeGovernedTask, which re-runs all 12 gates.
   */
  supersedeGovernedTask(governedTaskId: string, recoveryId: string): Record<string, unknown> {
    const gt = this.store.get("governed_task", governedTaskId);
    if (!["DISPATCH_AUTHORIZED", "VALIDATED"].includes(String(gt.governance_state))) {
      throw new IntegrityError("FAIL_CLOSED_GOVERNED_TASK_NOT_SUPERSEDABLE", String(gt.governance_state));
    }
    const next = {
      ...gt,
      governance_state: "SUPERSEDED_BY_RECOVERY",
      superseded_by_recovery: recoveryId,
      version: gt.version,
    };
    const saved = this.store.put("governed_task", governedTaskId, next, Number(gt.version));
    this.store.event({
      entity_type: "governed_task",
      entity_id: governedTaskId,
      event_type: "RECOVERY_SUPERSEDED",
      old_state: String(gt.governance_state),
      new_state: "SUPERSEDED_BY_RECOVERY",
      actor: "PAIR_RECOVERY_CONTROLLER",
      correlation_id: String(gt.correlation_id ?? ""),
      metadata: { recovery_id: recoveryId },
    });
    return saved;
  }

  /**
   * Pre-execution checks for APPLY_VERIFIED_REMEDIATION — the experience must
   * be ACTIVE, compatible, fresh, permission-free, and within risk ceiling.
   * Returns the experience entity when admissible.
   */
  verifyRemediationAdmissible(experienceId: string, input: {
    environment?: Record<string, unknown>;
    executor_id?: string;
    risk_class?: string;
    risk_ceiling?: string;
    now?: string;
  }): Record<string, unknown> {
    const exp = this.store.get("experience", experienceId); // verify-on-read
    const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const checks: Array<[string, boolean]> = [
      ["EXPERIENCE_ACTIVE", exp.status === "ACTIVE"],
      ["TYPE_REMEDIATION_PAIR", exp.type === "REMEDIATION_PAIR"],
      ["PERMISSION_EFFECT_NONE", String(exp.permission_effect) === "NONE"],
      ["NOT_STALE", exp.stale !== true && (!exp.stale_after || String(exp.stale_after) > (input.now ?? utcnow()))],
      [
        "ENVIRONMENT_COMPATIBLE",
        !input.environment ||
          !((exp.compatibility_scope as Record<string, unknown>)?.environment as Record<string, unknown>) ||
          Object.entries(
            ((exp.compatibility_scope as Record<string, unknown>).environment as Record<string, unknown>) ?? {},
          ).every(([k, v]) => input.environment![k] === undefined || input.environment![k] === v),
      ],
      [
        "EXECUTOR_COMPATIBLE",
        !input.executor_id ||
          !Array.isArray((exp.compatibility_scope as Record<string, unknown>)?.executors) ||
          (((exp.compatibility_scope as Record<string, unknown>).executors as string[]) ?? []).includes(input.executor_id),
      ],
      [
        "RISK_WITHIN_CEILING",
        !input.risk_ceiling ||
          RISK_ORDER.indexOf(String((exp.payload as Record<string, unknown>)?.risk_class ?? input.risk_class ?? "LOW")) <=
            RISK_ORDER.indexOf(input.risk_ceiling),
      ],
      ["NO_CREDENTIAL_EXPANSION", JSON.stringify(exp.payload).match(/api_?key|secret|password|credential|token/i) === null],
      ["NO_WORKSPACE_WIDENING", (exp.payload as Record<string, unknown>)?.widen_workspace !== true],
      ["NO_APPROVAL_BYPASS", (exp.payload as Record<string, unknown>)?.bypass_approval !== true],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([c]) => c);
    if (failed.length) {
      throw new PolicyError("FAIL_CLOSED_REMEDIATION_INADMISSIBLE", `${experienceId}:${failed.join(",")}`);
    }
    return exp;
  }

  /**
   * Build a governed remediation task request — the caller submits it through
   * MissionRouter/GovernedTaskGate like any other task. Never a direct shell.
   */
  proposeRemediationTask(params: {
    mission_id: string;
    parent_task_id: string;
    recovery_id: string;
    experience_id: string;
    task_instruction: string;
    workspace: string;
    permissions: string[];
    required_capabilities: string[];
    plan_revision: number;
    correlation_id?: string;
  }): Record<string, unknown> {
    const remExecId = newId("RMED");
    const request = {
      mission_id: params.mission_id,
      parent_task_id: params.parent_task_id,
      plan_revision: params.plan_revision,
      task_instruction: params.task_instruction,
      workspace: params.workspace,
      allowed_paths: [params.workspace],
      permissions: params.permissions,
      requested_tools: params.required_capabilities,
      constraints: [{ kind: "REMEDIATION", recovery_id: params.recovery_id }],
      timeout: 60,
      correlation_id: params.correlation_id ?? newId("CORR"),
      remediation_of: params.parent_task_id,
      recovery_id: params.recovery_id,
      remediation_experience_id: params.experience_id,
      expected_output_contract: { type: "TASK_RESULT", summary: "remediation outcome" },
    };
    this.store.put(
      "remediation_execution",
      remExecId,
      {
        remediation_execution_id: remExecId,
        recovery_id: params.recovery_id,
        mission_id: params.mission_id,
        parent_task_id: params.parent_task_id,
        experience_id: params.experience_id,
        state: "PROPOSED",
        request,
        created_at: utcnow(),
        version: 0,
      },
      0,
    );
    this.store.event({
      entity_type: "remediation_execution",
      entity_id: remExecId,
      event_type: "REMEDIATION_STARTED",
      new_state: "PROPOSED",
      actor: "PAIR_RECOVERY_CONTROLLER",
      correlation_id: request.correlation_id,
    });
    return { remediation_execution_id: remExecId, request };
  }

  /**
   * Record the governed remediation task once dispatched through the normal
   * chain, binding remediation_execution to the governed_task + execution.
   */
  bindRemediationExecution(remediationExecutionId: string, governedTaskId: string, executionId: string): Record<string, unknown> {
    const rec = this.store.get("remediation_execution", remediationExecutionId);
    const next = { ...rec, governed_task_id: governedTaskId, execution_id: executionId, state: "DISPATCHED", version: rec.version };
    return this.store.put("remediation_execution", remediationExecutionId, next, Number(rec.version));
  }

  /** Terminal remediation outcome — never marks the original task succeeded. */
  evaluateRemediationOutcome(remediationExecutionId: string, remediationResultState: string): Record<string, unknown> {
    const rec = this.store.get("remediation_execution", remediationExecutionId);
    const outcome =
      remediationResultState === "COMPLETED"
        ? "REMEDIATION_SUCCEEDED"
        : remediationResultState === "FAILED"
          ? "REMEDIATION_FAILED"
          : remediationResultState === "UNKNOWN"
            ? "RECONCILIATION_REQUIRED"
            : "REMEDIATION_INCONCLUSIVE";
    const next = { ...rec, state: outcome, resolved_at: utcnow(), version: rec.version };
    const saved = this.store.put("remediation_execution", remediationExecutionId, next, Number(rec.version));
    this.store.event({
      entity_type: "remediation_execution",
      entity_id: remediationExecutionId,
      event_type: outcome === "REMEDIATION_SUCCEEDED" ? "REMEDIATION_COMPLETED" : "REMEDIATION_FAILED",
      new_state: outcome,
      actor: "PAIR_RECOVERY_CONTROLLER",
      correlation_id: String(rec.correlation_id ?? ""),
    });
    return saved;
  }

  /**
   * Restart-safe mission recovery: scan non-terminal missions, reconcile
   * unsettled executions, write a checkpoint. Read-only wrt dispatch — it
   * returns state; callers re-enter governed paths.
   */
  planRestartRecovery(reconcile: (executionId: string) => Record<string, unknown>): Array<Record<string, unknown>> {
    const TERMINAL_MISSION = new Set(["COMPLETED", "FAILED", "ABORTED", "CANCELLED"]);
    const TERMINAL_EXEC = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
    const missions = this.store
      .list("mission")
      .filter((m) => !TERMINAL_MISSION.has(String(m.status)));
    const checkpoints: Array<Record<string, unknown>> = [];
    for (const mission of missions) {
      const missionId = String(mission.mission_id);
      const execs = this.store
        .list("executor_execution")
        .filter((e) => e.mission_id === missionId);
      const unsettled = execs.filter((e) => !TERMINAL_EXEC.has(String(e.execution_state)));
      const receipts = unsettled.map((e) => reconcile(String(e.execution_id)));
      const attempts = this.store.list("recovery_attempt").filter((a) => a.mission_id === missionId);
      // A mission that never committed a plan (created but never ticked)
      // must not crash restart rehydration.
      const revisions = this.store.planRevisions(missionId);
      const active = revisions.length
        ? this.service.activeRevision(missionId)
        : { revision: 0, plan_id: "" };
      const checkpointId = `MRCP_${missionId}`;
      const existing = this.store.tryGet("mission_recovery_checkpoint", checkpointId);
      const checkpoint = {
        checkpoint_id: checkpointId,
        mission_id: missionId,
        plan_revision: Number(active?.revision ?? 0),
        unsettled_executions: unsettled.map((e) => String(e.execution_id)),
        reconciliation_receipt_ids: receipts.map((r) => String(r.reconciliation_id)),
        retry_budgets: {
          attempts_used: attempts.length,
          attempts_remaining: Math.max(0, this.policy.max_attempts_per_mission - attempts.length),
        },
        created_at: utcnow(),
        version: Number(existing?.version ?? 0),
      };
      this.store.put(
        "mission_recovery_checkpoint",
        checkpointId,
        checkpoint,
        Number(existing?.version ?? 0),
      );
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }
}
