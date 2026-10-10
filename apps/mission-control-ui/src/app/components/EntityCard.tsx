import { Link } from "react-router-dom";
import type { ObjectiveSummary } from "../types";
import { StatusBadge, type Tone } from "./StatusBadge";
import { KpiBar } from "./KpiBar";

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "unknown",
  PROPOSED: "info",
  RUNNING: "info",
  PAUSED: "warn",
  ACHIEVED: "ok",
  CANCELLED: "unknown",
  FAILED: "danger",
  EXPIRED: "warn",
};

/* *_microusd fields are USD micro-units by contract — always display in
   USD regardless of business.currency (no FX conversion, audit F1). */
export function money(microusd: number): string {
  const v = microusd / 1e6;
  const s = v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2);
  return `$${s}`;
}

/* Objective entity card for the Company Cockpit grid (D.2). Renders the
   canonical summary verbatim; KPI/budget carry their own proven chips. */
export function EntityCard(props: { o: ObjectiveSummary }) {
  const { o } = props;
  const k = o.kpi_summary;
  const b = o.budget;
  const pct = b.ceiling_microusd > 0 ? Math.min(100, (b.consumed_microusd / b.ceiling_microusd) * 100) : 0;
  return (
    <Link className="ecard" to={`/app/objectives/${encodeURIComponent(o.objective_id)}`}>
      <div className="eh">
        <div>
          <div className="t">{o.title || o.objective_id}</div>
          <div className="oid">{o.objective_id}</div>
        </div>
        <StatusBadge tone={STATUS_TONE[o.status] ?? "unknown"} label={o.status} />
      </div>
      <KpiBar total={k.total} met={k.met} gap={k.gap} unverified={k.unverified} proven={k.canonically_proven} />
      <div className="brow">
        <div className="meter" role="img" aria-label={`budget ${pct.toFixed(0)}% consumed`}>
          <span className="m-info" style={{ width: `${pct}%` }} />
        </div>
        <span className="knum">
          {money(b.consumed_microusd)} / {money(b.ceiling_microusd)}
        </span>
        <StatusBadge tone={b.canonically_proven ? "ok" : "unknown"} label={b.canonically_proven ? "proven" : "claimed"} />
      </div>
      <div className="efoot">
        <span>{o.deadline ? `deadline ${String(o.deadline).slice(0, 10)}` : "no deadline"}</span>
        <span>
          {o.latest_review
            ? `last review ${o.latest_review.outcome}${o.latest_review.owner_action_required ? " · needs you" : ""}`
            : "no reviews"}
          {o.review_count > 0 ? ` (${o.review_count})` : ""}
        </span>
      </div>
    </Link>
  );
}
