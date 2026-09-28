export interface Mission {
  mission_id: string;
  goal: string;
  state: string;
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
