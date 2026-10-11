import { useEffect, useState } from "react";
import { ApiError, apiAdmin } from "../../api";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type { CostRead } from "../types";

/* P15.9-B5.5 Scope D — Cost & Usage. Observational read model only: no
   cost-policy/profile mutations, no secret-policy controls, no cost-halt
   changes. remote_dispatches_today counts DEVIN executor_execution
   records for the UTC day — NOT total tokens or money. Monetary values
   are integer micro-USD; conversions are exact and labeled. */

type Row = Record<string, unknown>;
type Sec<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; err: ApiError };

const isObj = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const errOf = (e: unknown): ApiError =>
  e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));

/* micro-USD → exact USD label. R1-F1: only verified integer micro-USD
   amounts within safe numeric bounds convert — null, missing, floats,
   strings, booleans and out-of-range values render "unknown", never $0
   (a noncanonical value is not a price, never fabricated as one). */
const usd = (microusd: unknown): string => {
  if (typeof microusd !== "number" || !Number.isSafeInteger(microusd)) return "unknown";
  const neg = microusd < 0;
  const abs = Math.abs(microusd);
  const dollars = Math.floor(abs / 1e6);
  const frac = String(abs % 1e6).padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}$${dollars}${frac ? "." + frac : ""}`;
};

const field = (r: Row, keys: string[]): string => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return String(r[k]);
  return "—";
};

export function SystemCost() {
  const [cost, setCost] = useState<Sec<CostRead>>({ kind: "loading" });
  const [policies, setPolicies] = useState<Sec<Row[]>>({ kind: "loading" });
  const [profiles, setProfiles] = useState<Sec<Row[]>>({ kind: "loading" });

  useEffect(() => {
    const ctl = new AbortController();
    apiAdmin.cost(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || typeof r.remote_dispatches_today !== "number"
          || typeof r.remote_daily_limit !== "number" || typeof r.cost_halt !== "boolean") {
          setCost({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/cost returned a malformed payload") });
          return;
        }
        setCost({ kind: "ready", data: r });
      })
      .catch((e) => !ctl.signal.aborted && setCost({ kind: "error", err: errOf(e) }));
    apiAdmin.costPolicies(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.cost_policies) || !r.cost_policies.every(isObj)) {
          setPolicies({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/cost-policies returned a malformed payload") });
          return;
        }
        setPolicies({ kind: "ready", data: r.cost_policies });
      })
      .catch((e) => !ctl.signal.aborted && setPolicies({ kind: "error", err: errOf(e) }));
    apiAdmin.costProfiles(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.cost_profiles) || !r.cost_profiles.every(isObj)) {
          setProfiles({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/cost-profiles returned a malformed payload") });
          return;
        }
        setProfiles({ kind: "ready", data: r.cost_profiles });
      })
      .catch((e) => !ctl.signal.aborted && setProfiles({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, []);

  const c = cost.kind === "ready" ? cost.data : null;
  const m = c?.monetary && isObj(c.monetary) ? c.monetary : null;

  return (
    <div className="page">
      <h1>Cost &amp; Usage</h1>
      <p className="sub srcnote">
        Observational read model — <code>GET /api/cost · /api/cost-policies · /api/cost-profiles</code>.
        No mutation controls exist on this page (out of scope for B5.5).
      </p>

      <section className="need" aria-label="remote dispatch guard">
        <h2>Remote dispatch guard</h2>
        {cost.kind === "loading" ? <Skeleton height={60} /> : cost.kind === "error" ? (
          <ErrorState code={cost.err.code} detail={cost.err.detail} />
        ) : (
          <div className="need" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div className="nrow">
              <span className="tt">Remote dispatches today</span>
              <strong>{c!.remote_dispatches_today} / {c!.remote_daily_limit}</strong>
            </div>
            <div className="nrow">
              <span className="tt">Cost halt</span>
              <StatusBadge tone={c!.cost_halt ? "danger" : "ok"} label={c!.cost_halt ? "HALT ACTIVE" : "no halt"} />
            </div>
            <div className="nrow">
              <span className="tt">Active schedules</span>
              <strong>{c!.schedules_active}</strong>
            </div>
          </div>
        )}
        <p className="sub srcnote">
          "Remote dispatches today" counts <strong>DEVIN executor_execution records</strong> in the
          current UTC day — not total model tokens and not monetary spend.
        </p>
      </section>

      <section className="need" aria-label="monetary position">
        <h2>Monetary position (P13)</h2>
        {cost.kind === "loading" ? <Skeleton height={60} /> : cost.kind === "error" ? null : m === null ? (
          <ErrorState code="UNAVAILABLE" detail="No canonical monetary evidence in the cost read — shown as unknown, never fabricated." />
        ) : (
          <>
            <div className="need" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div className="nrow">
                <span className="tt">Reserved (HELD)</span>
                <strong title={`${m.held_microusd ?? "?"} micro-USD — reserved, not settled`}>
                  {usd(m.held_microusd)}
                </strong>
                <span className="note">{Array.isArray(m.reservations_held) ? m.reservations_held.length : 0} reservation(s)</span>
              </div>
              <div className="nrow">
                <span className="tt">Committed</span>
                <strong title={`${m.committed_microusd ?? "?"} micro-USD`}>
                  {usd(m.committed_microusd)}
                </strong>
                <span className="note">{Array.isArray(m.reservations_committed) ? m.reservations_committed.length : 0} reservation(s)</span>
              </div>
              <div className="nrow">
                <span className="tt">Settled</span>
                <strong title={`${m.settled_microusd ?? "?"} micro-USD`}>
                  {usd(m.settled_microusd)}
                </strong>
              </div>
              <div className="nrow">
                <span className="tt">Unpriced dispatches</span>
                <strong>{typeof m.unpriced_dispatches === "number" ? m.unpriced_dispatches : "unknown"}</strong>
              </div>
            </div>
            {isObj(m.billing_mode_breakdown) && Object.keys(m.billing_mode_breakdown).length > 0 ? (
              <p className="sub srcnote">
                billing modes: {Object.entries(m.billing_mode_breakdown).map(([k, v]) => `${k}=${v}`).join(" · ")}
              </p>
            ) : null}
            <p className="sub srcnote">
              Reserved ≠ committed ≠ settled — a reservation is not spent money. Unpriced work has no
              canonical cost and is never estimated here.
            </p>
          </>
        )}
      </section>

      <section className="need" aria-label="cost policies">
        <h2>Cost policies</h2>
        {policies.kind === "loading" ? <Skeleton height={60} /> : policies.kind === "error" ? (
          <ErrorState code={policies.err.code} detail={policies.err.detail} />
        ) : policies.data.length === 0 ? (
          <EmptyState title="No cost policies" detail="The canonical cost_policy collection is empty." />
        ) : (
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Policy</th><th>Business</th><th>Scope type</th><th>Scope id</th><th>Period</th><th>Max limit</th><th>Enabled</th><th>Hard stop</th><th>Warn %</th><th>Status</th><th>Version</th></tr></thead>
            <tbody>
              {policies.data.map((p, i) => (
                <tr key={field(p, ["cost_policy_id"]) !== "—" ? field(p, ["cost_policy_id"]) : String(i)}>
                  <td className="mono">{field(p, ["cost_policy_id"])}</td>
                  <td className="mono">{field(p, ["business_id"])}</td>
                  <td className="mono">{field(p, ["scope_type"])}</td>
                  <td className="mono">{field(p, ["scope_id"])}</td>
                  <td className="mono">{field(p, ["period"])}</td>
                  <td className="mono" title={typeof p.max_microusd === "number" ? `${String(p.max_microusd)} micro-USD` : undefined}>
                    {usd(p.max_microusd)}
                  </td>
                  <td>{p.enabled === undefined ? "—" : p.enabled ? "yes" : "no"}</td>
                  {/* R2-F1: hard_stop is its own canonical boolean — never inferred
                      from enabled/status/limit. Only strict true/false render as
                      yes/no; missing or noncanonical values show "unknown". */}
                  <td>{p.hard_stop === true ? "yes" : p.hard_stop === false ? "no" : "unknown"}</td>
                  <td className="mono">{field(p, ["warning_threshold_pct"])}</td>
                  <td>{field(p, ["status"])}</td>
                  <td className="mono">{field(p, ["version"])}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="need" aria-label="cost profiles">
        <h2>Cost profiles</h2>
        {profiles.kind === "loading" ? <Skeleton height={60} /> : profiles.kind === "error" ? (
          <ErrorState code={profiles.err.code} detail={profiles.err.detail} />
        ) : profiles.data.length === 0 ? (
          <EmptyState title="No cost profiles" detail="The canonical cost_profile collection is empty." />
        ) : (
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Ref</th><th>Billing mode</th><th>Fixed</th><th>Input /Mtok</th><th>Output /Mtok</th><th>Reserve</th><th>Currency</th><th>Status</th><th>Version</th></tr></thead>
            <tbody>
              {profiles.data.map((p, i) => (
                <tr key={field(p, ["cost_profile_id"]) !== "—" ? field(p, ["cost_profile_id"]) : String(i)}>
                  <td className="mono">{field(p, ["ref_type"])}:{field(p, ["ref_id"]).slice(0, 24)}</td>
                  <td>{field(p, ["billing_mode"])}</td>
                  <td className="mono" title={typeof p.fixed_microusd === "number" ? `${String(p.fixed_microusd)} micro-USD` : undefined}>{usd(p.fixed_microusd)}</td>
                  <td className="mono" title={typeof p.input_microusd_per_mtok === "number" ? `${String(p.input_microusd_per_mtok)} micro-USD/Mtok` : undefined}>{usd(p.input_microusd_per_mtok)}</td>
                  <td className="mono" title={typeof p.output_microusd_per_mtok === "number" ? `${String(p.output_microusd_per_mtok)} micro-USD/Mtok` : undefined}>{usd(p.output_microusd_per_mtok)}</td>
                  <td className="mono" title={typeof p.reserve_microusd === "number" ? `${String(p.reserve_microusd)} micro-USD` : undefined}>{usd(p.reserve_microusd)}</td>
                  <td className="mono">{field(p, ["currency"])}</td>
                  <td>{field(p, ["status"])}</td>
                  <td className="mono">{field(p, ["version"])}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
