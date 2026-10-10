import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { CompanyPayload, ObjectiveSummary } from "../types";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import {
  DeniedState,
  EmptyState,
  ErrorState,
  Skeleton,
} from "../components/states";
import { EntityCard, money } from "../components/EntityCard";

/* P15.9-B2 — Company Cockpit (D.2): the owner's "how is the company doing
   and what needs me". Reads ONLY GET /api/vnext/businesses/:id/company.
   Rules carried from the B0 contract:
   - counts.* are EXACT over all owned objectives; status breakdown and
     lists cover only the ≤200 returned summaries and say so.
   - latest_review.owner_action_required is the FRESH pin-checked flag —
     the only pending signal (never a historical review flag).
   - canonically_proven=false renders UNVERIFIED — never MET-as-verified.
   - HALT aggregation + scoped activity feed are API_MISSING — shown as
     unavailable/partial explanations, never fabricated numbers. */

type LoadState =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CompanyPayload }
  | { kind: "error"; err: ApiError };

const BIZ_STATUS: Record<string, Tone> = {
  ACTIVE: "ok",
  PAUSED: "warn",
  SUSPENDED: "danger",
  ARCHIVED: "unknown",
};

function statusBreakdown(objs: ObjectiveSummary[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const o of objs) m.set(o.status, (m.get(o.status) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function Company() {
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<LoadState>({ kind: "loading" });
  const [approvals, setApprovals] = useState<Record<string, unknown>[] | null>(null);
  const [approvalsErr, setApprovalsErr] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  /* Company fetch: keyed on the selected business. Previous data is
     dropped immediately and an abort guard keeps a slower earlier
     response from overwriting the newer business (mandate §1/§4). */
  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    api
      .businessCompany(biz, ctl.signal)
      .then((r) => {
        if (!ctl.signal.aborted) setSt({ kind: "ready", data: r.company });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({
          kind: "error",
          err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)),
        });
      });
    return () => ctl.abort();
  }, [biz, reloadTick]);

  /* Approvals is a GLOBAL unscoped queue (E.6 API_MISSING for a
     business-scoped one) — fetched once, always labeled as global. */
  useEffect(() => {
    let dead = false;
    api
      .approvals()
      .then((a) => !dead && setApprovals(Array.isArray(a) ? a : []))
      .catch(() => !dead && setApprovalsErr(true));
    return () => {
      dead = true;
    };
  }, []);

  const retry = () => setReloadTick((n) => n + 1);

  if (st.kind === "no-business") {
    return (
      <>
        <h1>Company Cockpit</h1>
        <div className="sub">Owner view of one business.</div>
        <EmptyState
          title="No business selected"
          detail="Enter a business_id in the switcher — there is no owner-scoped list, so access is proven on read. A business you don't own shows Access denied."
        />
      </>
    );
  }
  if (st.kind === "loading") {
    return (
      <>
        <h1>Company Cockpit</h1>
        <div className="sub">Loading {biz}…</div>
        <div className="stats">
          {[0, 1, 2].map((i) => (
            <div className="stat" key={i}>
              <Skeleton height={11} width="70%" />
              <Skeleton height={22} width="40%" />
            </div>
          ))}
        </div>
        <div className="ecards">
          {[0, 1].map((i) => (
            <div className="ecard" key={i} style={{ cursor: "default" }}>
              <Skeleton height={14} width="60%" />
              <Skeleton height={11} width="40%" />
              <Skeleton height={28} />
            </div>
          ))}
        </div>
      </>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    const integrity = err.code.startsWith("FAIL_CLOSED");
    return (
      <>
        <h1>Company Cockpit</h1>
        <div className="sub">{biz}</div>
        {err.status === 401 ? (
          <ErrorState
            code={err.code || "UNAUTHORIZED"}
            detail={`Your credentials were rejected — the session token is missing or invalid. Update it in Settings, then retry. ${err.detail}`}
            onRetry={retry}
          />
        ) : err.status === 403 ? (
          <DeniedState
            detail={`${err.detail || "You don't own any objectives in this business."} (${err.code})`}
          />
        ) : (
          <ErrorState
            code={err.code}
            detail={
              integrity
                ? `Integrity check failed — the server refused to return possibly-corrupt data. Nothing was rendered. ${err.detail}`
                : err.detail
            }
            onRetry={retry}
          />
        )}
      </>
    );
  }

  const { business: b, objectives, counts } = st.data;
  const breakdown = statusBreakdown(objectives);
  const pending = objectives.filter((o) => o.latest_review?.owner_action_required === true);
  const recentReviews = objectives
    .filter((o) => o.latest_review)
    .sort((a, b2) => b2.latest_review!.created_at.localeCompare(a.latest_review!.created_at))
    .slice(0, 5);
  const pendingApprovals = (approvals ?? []).filter((a) => String(a.status) === "PENDING");
  const spend = objectives.reduce((s, o) => s + o.budget.consumed_microusd, 0);

  return (
    <>
      <div className="chead">
        <div>
          <h1>{b.name || b.business_id}</h1>
          <div className="sub">{b.description || b.business_id}</div>
        </div>
        <StatusBadge tone={BIZ_STATUS[b.status] ?? "unknown"} label={b.status} />
      </div>

      {st.data.objectives_truncated ? (
        <div className="trunc" role="alert">
          Showing {counts.objectives_returned} of {counts.objectives_owned} owned
          objectives — counts are exact, the list below is partial.
        </div>
      ) : null}

      <div className="stats" aria-label="company stats">
        <div className="stat">
          <div className="k">Objectives owned</div>
          <div className="v">{counts.objectives_owned}</div>
          <div className="n">exact</div>
        </div>
        <div className="stat">
          <div className="k">Pending reviews</div>
          <div className="v">{counts.targets_met_pending}</div>
          <div className="n">exact</div>
        </div>
        <div className="stat">
          <div className="k">Status</div>
          <div className="v" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {breakdown.map(([s, n]) => `${s} ${n}`).join(" · ") || "—"}
          </div>
          <div className="n">of {counts.objectives_returned} returned</div>
        </div>
        <div className="stat">
          <div className="k">Reported spend</div>
          <div className="v" style={{ fontSize: 18, lineHeight: 1.6 }}>
            {money(spend)}
          </div>
          <div className="n">aggregate over {counts.objectives_returned} returned</div>
        </div>
      </div>

      <section className="need" aria-label="needs your attention">
        <div className="h">
          Needs your attention
          {counts.targets_met_pending > 0 ? (
            <span className="cnt">{counts.targets_met_pending}</span>
          ) : null}
        </div>
        {pending.length === 0 && pendingApprovals.length === 0 ? (
          <div className="nrow">
            <span className="note">No pending reviews or approvals visible.</span>
          </div>
        ) : null}
        {pending.map((o) => (
          <div className="nrow" key={o.objective_id}>
            <StatusBadge tone="purple" label={o.latest_review!.outcome} />
            <span className="tt">{o.title || o.objective_id}</span>
            <span className="note">review pending owner sign-off</span>
            <Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}`}>
              open →
            </Link>
          </div>
        ))}
        {pendingApprovals.map((a) => (
          <div className="nrow" key={String(a.approval_id ?? a.entity_id)}>
            <StatusBadge tone="warn" label="approval" />
            <span className="tt">{String(a.reason ?? a.kind ?? a.mission_id ?? "")}</span>
            <span className="note">global queue — not business-scoped</span>
          </div>
        ))}
        {approvalsErr ? (
          <div className="nrow">
            <span className="note">Global approvals queue failed to load — page data unaffected.</span>
          </div>
        ) : null}
        <div className="nrow">
          <StatusBadge tone="unknown" label="policy halts" />
          <span className="note">
            Unavailable — no HALT enumeration exists (API_MISSING). Per-objective
            policy state is visible on each Objective Detail (B3).
          </span>
        </div>
      </section>

      <h2 className="sech">Objectives</h2>
      {objectives.length === 0 ? (
        <EmptyState
          title="No objectives in the returned page"
          detail={`You own ${counts.objectives_owned} objective(s) here but none were returned in this page.`}
        />
      ) : (
        <div className="ecards">
          {objectives.map((o) => (
            <EntityCard key={o.objective_id} o={o} />
          ))}
        </div>
      )}

      <h2 className="sech">Recent reviews</h2>
      <div className="sub" style={{ marginBottom: 8 }}>
        Latest review per objective — not a full activity feed
        (business-scoped feed is API_MISSING).
      </div>
      {recentReviews.length === 0 ? (
        <EmptyState title="No reviews yet" detail="Review history appears here once objectives have been reviewed." />
      ) : (
        <div className="need">
          {recentReviews.map((o) => (
            <div className="nrow" key={o.objective_id}>
              <StatusBadge tone="info" label={o.latest_review!.outcome} />
              <span className="tt">{o.title || o.objective_id}</span>
              <span className="note">{String(o.latest_review!.created_at).slice(0, 19).replace("T", " ")}</span>
              {o.latest_review!.owner_action_required ? (
                <StatusBadge tone="purple" label="needs you" />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
