import { ProofChip } from "./StatusBadge";

/* KPI progress meter for an objective summary (D.2). Segments show the
   assessment split MET / GAP / UNVERIFIED over total KPIs; the proven chip
   reflects canonically_proven verbatim — an unproven summary never reads
   as verified. */
export function KpiBar(props: {
  total: number;
  met: number;
  gap: number;
  unverified: number;
  proven: boolean;
}) {
  const { total, met, gap, unverified, proven } = props;
  if (total <= 0) {
    return (
      <div className="kpibar" aria-label="KPI progress">
        <span className="knum">no KPIs</span>
      </div>
    );
  }
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="kpibar" aria-label="KPI progress">
      <div
        className="meter"
        role="img"
        aria-label={`${met} of ${total} KPIs met${proven ? "" : " (unverified)"}`}
      >
        {met > 0 ? <span className="m-ok" style={{ width: pct(met) }} /> : null}
        {gap > 0 ? <span className="m-gap" style={{ width: pct(gap) }} /> : null}
        {unverified > 0 ? <span className="m-unv" style={{ width: pct(unverified) }} /> : null}
      </div>
      <span className="knum">
        {proven ? `${met}/${total} MET` : "UNVERIFIED"}
      </span>
      <ProofChip state={proven ? "proven" : "unverifiable"} />
    </div>
  );
}
