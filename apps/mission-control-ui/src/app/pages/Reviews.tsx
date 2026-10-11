import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { CockpitPayload, ReviewsPage } from "../types";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "../components/states";

/* P15.9-B3 — Objective Reviews (mandate §7): canonical history via
   GET /api/vnext/objectives/:id/reviews?limit= (default 50, max 200),
   newest-first. owner_action_required on rows is HISTORICAL — never
   presented as a fresh pending signal. */

const O_TONE: Record<string, Tone> = {
  TARGET_MET_CANDIDATE: "purple", ACHIEVED: "ok", WAIT: "info",
  GAP: "warn", UNVERIFIED: "unknown", OK: "ok", CONTINUE: "info",
};

type St =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; page: ReviewsPage; bizChecked: string; reqId: string; reqLimit: number }
  | { kind: "mismatch"; objBiz: string }
  | { kind: "error"; err: ApiError };

export function Reviews() {
  const { id = "" } = useParams();
  const { biz } = useSelectedBusiness();
  const [sp, setSp] = useSearchParams();
  const limit = Math.min(Math.max(1, Number(sp.get("limit") || 50) || 50), 200);
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz || !id) return;
    const ctl = new AbortController();
    /* Business isolation: reviews rows carry no business_id, so the
       cockpit read enforces the selected-business context (mandate §6). */
    Promise.all([
      api.objectiveCockpit(id, ctl.signal),
      api.objectiveReviews(id, limit, ctl.signal),
    ])
      .then(([c, r]) => {
        if (ctl.signal.aborted) return;
        const objBiz = String((c.cockpit as CockpitPayload).objective.business_id);
        if (objBiz !== biz) setSt({ kind: "mismatch", objBiz });
        else setSt({ kind: "ready", page: r, bizChecked: objBiz, reqId: id, reqLimit: limit });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, id, limit, tick]);

  const refetch = () => setTick((n) => n + 1);

  if (st.kind === "no-business") {
    return (<><h1>Reviews</h1><EmptyState title="No business selected" detail="Select a business first — review history is rendered inside the selected-business context." /></>);
  }
  if (st.kind === "loading") {
    return (<><h1>Reviews</h1><div className="sub">Loading {id}…</div><div className="need">{[0,1,2].map(i=><div className="nrow" key={i}><Skeleton height={12} width="70%"/></div>)}</div></>);
  }
  if (st.kind === "mismatch") {
    return (<><h1>Reviews</h1><DeniedState detail={`Objective ${id} belongs to business ${st.objBiz}, not the selected ${biz}. No cross-business history is shown.`} /></>);
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <><h1>Reviews</h1><div className="sub">{biz}</div>
        {err.status === 401 ? (
          <ErrorState code={err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={refetch} />
        ) : err.status === 403 ? (
          <DeniedState detail={`${err.detail || "You don't own this objective."} (${err.code})`} />
        ) : (
          <ErrorState code={err.code} detail={err.detail} onRetry={refetch} />
        )}
      </>
    );
  }

  /* R2-F1 — synchronous guard: bind ready history to the requested
     objective id, selected business and limit. Stale history for a
     previous parameter set renders as loading until refetched. */
  if (st.bizChecked !== biz || st.reqId !== id || st.reqLimit !== limit) {
    return (<><h1>Reviews</h1><div className="sub">Loading {id}…</div><div className="need">{[0,1,2].map(i=><div className="nrow" key={i}><Skeleton height={12} width="70%"/></div>)}</div></>);
  }

  const { page } = st;
  return (
    <>
      <div className="sub"><Link to={`/app/objectives/${encodeURIComponent(id)}`}>‹ {id}</Link></div>
      <div className="chead">
        <div>
          <h1>Reviews</h1>
          <div className="sub">
            {page.returned} shown of {page.total} total{page.truncated ? " — truncated" : ""} · newest first · flags are historical (not fresh pending)
          </div>
        </div>
        <label className="sub">limit&nbsp;
          <select
            aria-label="reviews limit"
            value={String(limit)}
            onChange={(e) => setSp({ limit: e.target.value })}
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </label>
      </div>
      {page.truncated ? (
        <div className="trunc" role="alert">Showing the newest {page.returned} of {page.total} reviews — older history exists; raise the limit to see more.</div>
      ) : null}
      {page.reviews.length === 0 ? (
        <EmptyState title="No reviews yet" detail="This objective has no canonical review history." />
      ) : (
        <div className="need">
          {page.reviews.map((r) => (
            <div className="nrow rvrow" key={r.review_id}>
              <StatusBadge tone={O_TONE[r.outcome] ?? "unknown"} label={r.outcome} />
              <span className="tt">{r.review_id}</span>
              <span className="note">
                {String(r.created_at).slice(0, 19).replace("T", " ")} · by {r.created_by}
                {r.recommended_status ? ` · recommends ${r.recommended_status}` : ""}
                {r.wait_reason ? ` · wait: ${r.wait_reason}` : ""}
              </span>
              <span className="note">
                KPI ✓{r.verified_kpi_count} gap{r.gap_kpi_count} unv{r.unverified_kpi_count} · all_met {String(r.all_targets_met)}
              </span>
              <span className="note">
                owner_action {String(r.owner_action_required)} (historical) · decision {r.source_ceo_decision_id ?? "—"} · revision {r.strategy_revision_id ?? "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
