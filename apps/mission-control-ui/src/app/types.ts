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
