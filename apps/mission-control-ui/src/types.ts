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
