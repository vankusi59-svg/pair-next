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
