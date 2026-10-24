export interface Mission {
  mission_id: string;
  goal: string;
  state?: string;
  status?: string;
  runtime_state: string | null;
  created_at?: string;
  project_id?: string;
  [k: string]: unknown;
}

export interface DagNode {
  task_id: string;
  task_key: string;
  title: string;
  status: string;
  selected_executor?: string | null;
  order?: number;
}

export interface Dag {
  nodes: DagNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface TimelineEntry {
  kind: "EVENT" | "EVIDENCE";
  at: string;
  entity?: string;
  event_type?: string;
  actor?: string;
  new_state?: string;
  evidence_kind?: string;
  payload?: unknown;
}

export interface MissionDetail {
  mission: Record<string, unknown>;
  runtime: Record<string, unknown> | null;
  task_count: number;
  tasks: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  approvals_pending: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface Health {
  [k: string]: unknown;
}

export interface RoutingProjection {
  routable: Array<Record<string, unknown>>;
  executors: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
}

/** P15.7 — canonical P15.1 Objective row (immutable terms + runtime state). */
export interface ObjectiveKpi {
  kpi_id: string;
  name: string;
  unit: string;
  direction: "AT_LEAST" | "AT_MOST" | "EXACT";
  baseline: number;
  target: number;
  current: number | null;
  [k: string]: unknown;
}

export interface CanonicalObjective {
  objective_id: string;
  business_id: string;
  status: string;
  title?: string | null;
  statement?: string | null;
  description?: string | null;
  owner_authority_id?: string;
  deadline?: string | null;
  currency?: string;
  hard_constraints?: string[];
  success_conditions?: string[];
  kpis?: ObjectiveKpi[];
  budget?: { ceiling_microusd?: number; consumed_microusd?: number; [k: string]: unknown } | null;
  created_at?: string;
  version?: number;
  [k: string]: unknown;
}

export interface VnextObjectiveInput {
  business_id: string;
  title?: string;
  statement?: string;
  description?: string;
  deadline?: string | null;
  budget_ceiling_microusd?: number;
  currency?: string;
  kpis?: Array<{
    kpi_id?: string;
    name: string;
    unit?: string;
    direction?: string;
    baseline?: number;
    target?: number;
  }>;
  hard_constraints?: string[];
  success_conditions?: string[];
  dedup_key?: string;
}

/* ---- P15.8-D — conversation layer read models ---- */

export interface ConversationSession {
  session_id: string;
  owner_operator_id: string;
  entry_mode: "CONVERSATION" | "TASK_ENTRY";
  state: "OPEN" | "CLOSED";
  title?: string | null;
  message_count: number;
  next_seq: number;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

export interface ConversationMessage {
  message_id: string;
  session_id: string;
  seq: number;
  role: "operator" | "assistant" | "system";
  body: string;
  created_at: string;
  [k: string]: unknown;
}

export interface ConversationTurnResult {
  message: ConversationMessage;
  reply: ConversationMessage;
  reused: boolean;
  /** P15.8-F — validated model mission proposal: never authority.
   *  `draft` when it materialized canonically, `project_candidates`
   *  when project choice is ambiguous (no draft minted). */
  proposal?: {
    goal: string;
    draft?: MissionDraft;
    project_candidates?: { project_id: string; name: string }[];
    rejected?: string;
  };
}

export interface MissionDraft {
  draft_id: string;
  session_id: string;
  owner_operator_id: string;
  project_id: string;
  goal: string;
  granted_permissions: string[];
  authorized_workspaces: string[] | null;
  risk_ceiling: string | null;
  draft_digest: string;
  state: "PENDING_CONFIRMATION" | "SUBMITTING" | "CONFIRMED" | "REJECTED" | "EXPIRED" | "SUBMISSION_EXPIRED";
  created_at: string;
  expires_at: string;
  supersedes_draft_id?: string | null;
  preview_id?: string | null;
  plan_digest?: string | null;
  mission_id?: string | null;
  [k: string]: unknown;
}

export interface DraftConfirmResult {
  draft: MissionDraft;
  mission_id: string;
  mission: Record<string, unknown>;
  reused: boolean;
}

export interface OperatingPassResult {
  outcome: string;
  objective_id: string;
  owner_action_required?: boolean;
  binding_id?: string;
  workstream_key?: string;
  allocation_id?: string;
  delegated_child_work_item_id?: string;
  mission_id?: string;
  review_id?: string;
  strategy_revision_id?: string;
  ceo_decision_id?: string;
  blocked_workstream_keys?: string[];
  no_eligible_workstream_keys?: string[];
  detail?: string;
}

/** P15.10-A — objective auto-policy canonical status (control plane;
 *  `driver_ready` is always false until a later phase integrates an
 *  auto driver — "configured policy" never means "running autonomy"). */
export interface AutoPolicyStatus {
  objective_id: string;
  configured: boolean;
  state: "DISABLED" | "ENABLED" | "PAUSED" | "REVOKED" | "EXPIRED" | "HALTED";
  effective: boolean;
  reasons: string[];
  policy_version: number | null;
  expires_at: string | null;
  limits: {
    expires_at: string;
    max_ceo_calls?: number;
    max_missions?: number;
    max_retries?: number;
    budget_microusd_cap?: number;
  } | null;
  halt: { scope: string; actor: string; at: string; reason: string } | null;
  owner_authority_id: string;
  business_id: string;
  driver_ready: boolean;
  driver_missing: string[];
  /** Present once an auto-driver is integrated: the driver's own
   *  canonical runnable verdict + integration marker for this
   *  objective — never implied by "a driver process exists". */
  objective_runnable?: boolean;
  driver_integrated?: boolean;
  terms_digest_binding: string | null;
  terms_current: boolean;
}

/* Autonomous-loop observability reads (owner-scoped GETs):
   GET /api/vnext/objectives/:id/auto-scheduler and /auto-driver.
   next_due and lease.expires_at are epoch milliseconds or null;
   admission.at is ISO. Fields arrive as-observed — never fabricated. */
export interface AutoSchedulerStatus {
  objective_id: string;
  scheduler_mode: string;
  scheduler_ready: boolean;
  driver_integrated: boolean;
  consumer_ready: boolean;
  driver_ready: boolean;
  objective_runnable: boolean;
  driver_missing: string[];
  policy_effective: boolean;
  policy_version: number | null;
  terms_current: boolean;
  queue_state: string;
  pending_generation: number | null;
  claimed_generation: number | null;
  checkpoint_digest: string | null;
  pending_reasons: string[];
  coalesced_count: number | null;
  source_refs: string[];
  next_due: number | null;
  wait_kind: string | null;
  retry_count: number;
  blocked_reason: string | null;
  owner_action_required: boolean;
  /* R1-F6 — backend lease expiry is epoch milliseconds or null. */
  lease: { state: string; fence: number | null; expires_at: number | null } | null;
  catchup_state: string | null;
}

export interface AutoDriverAdmission {
  at: string;
  fence: number | null;
  generation: number | null;
  usage: { ceo_calls: number | null; microusd: number | null; missions: number | null } | null;
}

/* R4-F2 — backend recordDenial writes { at: ISO timestamp, fence,
   label }; kept bounded server-side (last 8). Extra keys are tolerated
   for forward compatibility. */
export interface AutoDriverDenial {
  at?: string | null;
  fence?: number | null;
  label?: string | null;
  [k: string]: unknown;
}

export interface AutoDriverStatus {
  objective_id: string;
  enabled: boolean;
  last_outcome: string | null;
  last_result: { fault?: string | null } | null;
  last_fence: number | null;
  admissions: AutoDriverAdmission[];
  denials: AutoDriverDenial[];
  /** P16-E — capability-gap advisory projection (absent when the driver
   *  runs without the gap service wired). OPEN = a durable DRIVER_*
   *  denial classified to an owner-actionable kind; UNVERIFIED = the
   *  canonical row failed re-proof and must not be trusted. */
  capability_gap?: CapabilityGap | null;
  lease: { state: string; fence: number | null; expires_at: number | null } | null;
}

export interface CapabilityGap {
  state: string;
  reason?: string | null;
  objective_id?: string;
  label?: string | null;
  gap_kind?: string | null;
  permanence?: string | null;
  owner_action?: string | null;
  occurrences?: number | null;
  opened_at?: string | null;
  resolved_at?: string | null;
  updated_at?: string | null;
  evidence?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}
