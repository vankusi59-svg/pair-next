/* P15.9-B2 — canonical /api/vnext/businesses/:id/company payload.
   Mirrors businessCompany() in src/pair/objective-cockpit.ts. */

export interface ObjectiveSummary {
  objective_id: string;
  title: string | null;
  status: string;
  deadline: string | null;
  created_at: string;
  budget: {
    ceiling_microusd: number;
    consumed_microusd: number;
    canonically_proven: boolean;
  };
  kpi_summary: {
    total: number;
    met: number;
    gap: number;
    unverified: number;
    all_targets_met: boolean;
    canonically_proven: boolean;
  };
  latest_review: {
    review_id: string;
    outcome: string;
    /* FRESH pin-checked pending flag — different semantics from the
       historical flag on /reviews rows. */
    owner_action_required: boolean;
    recommended_status: string | null;
    created_at: string;
  } | null;
  review_count: number;
}

export interface CompanyPayload {
  business: {
    business_id: string;
    name: string;
    description: string | null;
    currency: string;
    status: string;
    project_id: string;
    created_at: string;
  };
  objectives: ObjectiveSummary[];
  /* exact totals over ALL owned objectives */
  objectives_total_owned: number;
  objectives_truncated: boolean;
  counts: {
    objectives_owned: number;
    objectives_returned: number;
    targets_met_pending: number;
  };
}

/* ---- P15.9-B3 — canonical Objective Detail payload.
   Mirrors objectiveCockpit() in src/pair/objective-cockpit.ts. */

export interface ReviewRow {
  review_id: string;
  outcome: string;
  /* HISTORICAL flag on this surface — never a fresh pending signal. */
  owner_action_required: boolean;
  recommended_status: string | null;
  wait_reason: string | null;
  binding_id: string;
  review_observation_digest: string;
  source_ceo_decision_id: string | null;
  strategy_revision_id: string | null;
  all_targets_met: boolean;
  verified_kpi_count: number;
  unverified_kpi_count: number;
  gap_kpi_count: number;
  created_by: string;
  created_at: string;
}

export interface ReviewsPage {
  reviews: ReviewRow[];
  total: number;
  returned: number;
  truncated: boolean;
}

export interface CockpitKpi {
  kpi_id: string;
  name: string;
  unit: string;
  direction: string;
  baseline: number;
  current: number | null;
  target: number;
  assessment: string;
  canonically_proven: boolean;
  last_evidence_key: string | null;
  updated_at: string | null;
}

export interface CockpitWorkstream {
  workstream_key: string;
  work_item_id: string;
  workstream_status: string;
  completion_proven: boolean;
  allocation_state: string;
  selected_agent_id: string | null;
  delegated_child: {
    work_item_id: string;
    status: string;
    completion_proven: boolean;
    bound_mission: boolean;
    lifecycle_class: string;
    mission: CockpitMission | null;
  } | null;
}

export interface CockpitMission {
  mission_id: string;
  status: string;
  runtime_state: string | null;
  bound_open_id: string | null;
}

export interface CockpitArtifact {
  artifact_id: string;
  logical_name: string;
  mission_id: string;
  execution_id: string;
  state: string;
  artifact_class: string;
  sha256: string;
  byte_size: number;
  created_at: string;
}

export interface CockpitPayload {
  objective: {
    objective_id: string;
    business_id: string;
    status: string;
    title: string | null;
    statement: string | null;
    description: string | null;
    owner_authority_id: string;
    deadline: string | null;
    currency: string;
    terms_version: number;
    version: number;
    created_at: string;
    budget: {
      ceiling_microusd: number;
      consumed_microusd: number;
      canonically_proven: boolean;
    };
    hard_constraints: unknown[];
    success_conditions: unknown[];
    kpis: CockpitKpi[];
  };
  lifecycle: {
    objective_status: string;
    all_targets_met: boolean;
    latest_review_outcome: string | null;
    /* FRESH actionable signal — the ONLY one allowed on this surface. */
    owner_action_required: boolean;
    recommended_status: string | null;
  };
  binding: { binding_id: string; binding_digest: string } | null;
  observation_error: string | null;
  kpi_summary: {
    all_targets_met: boolean;
    verified_kpi_count: number;
    unverified_kpi_count: number;
    gap_kpi_count: number;
  };
  workstreams: CockpitWorkstream[];
  observer: { active: number; intervention: number; exhausted: number };
  missions: CockpitMission[];
  artifacts: CockpitArtifact[];
  artifacts_truncated: boolean;
  artifacts_dropped_unverified: number;
  latest_review: ReviewRow | null;
  review_count: number;
  auto_policy: {
    configured?: boolean;
    state?: string;
    effective?: boolean;
    reasons?: string[];
    policy_version?: number | null;
    expires_at?: string | null;
    expiry_pending?: boolean;
    limits?: Record<string, unknown>;
  } | null;
  auto_driver: { status: unknown } | null;
}

/* ---- P15.9-B5.1 — AI Workforce payloads.
   Mirrors business.ts org_agent / work_item rows, agent-contract.ts
   inspect(), inboxForAgent() and work-graph.ts workGraph(). */

export interface OrgAgentRow {
  agent_id: string;
  business_id: string;
  title: string;
  department: string;
  role: string;
  reports_to: string | null;
  executor_binding: string | null;
  capabilities: string[];
  status: string; /* ACTIVE | PAUSED | TERMINATED */
  context_notes?: unknown[];
  created_at: string;
  version: number;
}

export interface WorkItemRow {
  work_item_id: string;
  business_id: string;
  title: string;
  goal: string;
  department: string;
  assignee_agent_id: string | null;
  objective_id: string | null;
  routine_id: string | null;
  priority: number;
  source: string;
  required_capability: string | null;
  parent_work_item_id: string | null;
  delegated_from_work_item_id: string | null;
  delegated_by_agent_id: string | null;
  delegation_reason: string | null;
  delegation_depth: number;
  decomposition_id: string | null;
  requires_review: boolean;
  reviewer_agent_id: string | null;
  blocked_code: string | null;
  status: string; /* BACKLOG|READY|IN_PROGRESS|REVIEW_REQUIRED|BLOCKED|DONE|CANCELLED */
  mission_ids: string[];
  claimed_by: string | null;
  claim_expires_at: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  /* server strips claim_token on every non-claim response — never render it */
  claim_token?: string | null;
  dependencies_satisfied?: boolean;
}

export interface AgentContractPolicy {
  allowed_capabilities: string[] | null;
  denied_capabilities: string[];
  allowed_executor_ids: string[] | null;
  denied_executor_ids: string[];
  preferred_executor_ids: string[];
  executor_fallback_allowed: boolean;
  preferred_route_ids: string[];
  denied_route_ids: string[];
  route_fallback_allowed: boolean;
  allowed_project_ids: string[] | null;
  allowed_context_scopes: string[];
}

export interface AgentContractRow {
  contract_id: string;
  org_agent_id: string;
  business_id: string;
  contract_version: number;
  contract_digest: string;
  schema_version?: string;
  status: string; /* ACTIVE | DISABLED */
  policy: AgentContractPolicy;
  version: number;
  updated_at?: string;
}

/* GET /api/org-agents/:id/effective-policy — inspect() shape;
   500 FAIL_CLOSED_AGENT_CONTRACT_MISSING when unmaterialized. */
export interface AgentEffectivePolicy {
  org_agent_id: string;
  agent_status: string;
  business_id: string;
  contract_id: string;
  status: string;
  contract_version: number;
  contract_digest: string;
  policy: AgentContractPolicy;
  version: number;
  updated_at: string;
}

export interface AgentInboxMessage {
  message_id: string;
  business_id: string;
  work_item_id: string | null;
  sender_type: string; /* AGENT | OPERATOR */
  sender_agent_id: string | null;
  sender_operator_id: string | null;
  recipient_agent_id: string;
  kind: string;
  body: string;
  correlation_id: string | null;
  created_at: string;
  receipt_status?: string; /* PENDING | ACKED | CORRUPT */
  state?: string;
  corrupt?: boolean;
}

export interface WorkGraphPayload {
  nodes: WorkItemRow[];
  edges: Array<Record<string, unknown>>;
  delegations: Array<Record<string, unknown>>;
  decompositions: Array<Record<string, unknown>>;
  dependency_sets: Array<Record<string, unknown>>;
}

/* ---- P15.9-B5.2 — legacy admin parity types ---- */

export interface ProjectRow {
  project_id: string;
  name?: string;
  [k: string]: unknown;
}

export interface BusinessRow {
  business_id: string;
  name: string;
  description?: string;
  project_id: string;
  currency?: string;
  status?: string;
  created_at?: string;
  version?: number;
  [k: string]: unknown;
}

/* GET /api/businesses/:id — the canonical detail bundle. */
export interface BusinessDetail {
  business: BusinessRow;
  agents: OrgAgentRow[];
  objectives: LegacyObjectiveRow[];
  board: Record<string, unknown>;
  routines: RoutineRow[];
  budgets: Array<Record<string, unknown>>;
}

export interface RoutineRow {
  routine_id: string;
  business_id: string;
  name: string;
  goal_template: string;
  cron: string;
  department?: string;
  assignee_agent_id?: string | null;
  schedule_id?: string;
  enabled?: boolean;
  created_at?: string;
  version?: number;
  [k: string]: unknown;
}

/* Legacy compat objective (POST /api/objectives) — DISTINCT from the
   canonical vnext objective contract; same store, different API shape. */
export interface LegacyObjectiveRow {
  objective_id: string;
  business_id: string;
  title: string;
  description?: string;
  parent_objective_id?: string | null;
  metric?: string;
  target?: string;
  status?: string;
  created_at?: string;
  [k: string]: unknown;
}

/* ---- P15.9-B5.3 — mission operations / task entry ---- */
export interface MissionRow {
  mission_id: string;
  goal: string;
  state?: string;
  status?: string;
  runtime_state: string | null;
  created_at?: string;
  project_id?: string;
  bound_open_id?: string | null;
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
export interface MissionFileRow {
  path: string;
  workspace?: string;
  size: number;
  modified_at?: string;
  [k: string]: unknown;
}
export interface RoutingProjection {
  routable: Array<Record<string, unknown>>;
  executors: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
}
export interface MissionPreview {
  plan: { tasks: Array<Record<string, unknown>> };
  plan_digest: string;
  preview_id: string;
  plan_source: string | null;
  plan_model: string | null;
}

/* ---- P15.9-B5.5 — system surface row types (canonical payloads,
   passthrough index signatures for unverified fields). ---- */
export interface ScheduleRow {
  schedule_id: string;
  name?: string | null;
  goal?: string;
  cron?: string;
  project_id?: string;
  operator_id?: string;
  enabled?: boolean;
  deleted?: boolean;
  next_due_at?: string | null;
  last_fired_at?: string | null;
  last_mission_id?: string | null;
  last_error?: string | null;
  run_count?: number;
  created_at?: string;
  [k: string]: unknown;
}
export interface MonetaryPosition {
  policies?: Array<Record<string, unknown>>;
  profiles?: Array<Record<string, unknown>>;
  reservations_held?: Array<Record<string, unknown>>;
  reservations_committed?: Array<Record<string, unknown>>;
  held_microusd?: number;
  committed_microusd?: number;
  settled_microusd?: number;
  billing_mode_breakdown?: Record<string, number>;
  unpriced_dispatches?: number;
  cost_halt?: boolean;
  [k: string]: unknown;
}
export interface CostRead {
  remote_dispatches_today: number;
  remote_daily_limit: number;
  cost_halt: boolean;
  schedules_active: number;
  monetary?: MonetaryPosition;
  [k: string]: unknown;
}
