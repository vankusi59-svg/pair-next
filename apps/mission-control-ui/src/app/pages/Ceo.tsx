import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { CockpitPayload, CompanyPayload, ReviewsPage } from "../types";
import type { OperatingPassResult } from "../../types";
import { StatusBadge, ProofChip, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton, UnverifiedPanel } from "../components/states";
import { ConfirmDialog } from "../components/ConfirmDialog";

/* P15.9-B4 — CEO Workspace (D.4/E.3): explains the autonomous layer.
   Objective selector scoped to the selected business's ≤200 company
   summaries (no unscoped enumeration). Cockpit + reviews reads are the
   same canonical projections as Objective Detail. Manual CEO pass =
   POST /ceo-cycle via ConfirmDialog — its RESULT is shown as an
   invocation result (no persistent latest-pass read exists →
   API_MISSING disclosure); it is never rendered as a review outcome. */

const S_TONE: Record<string, Tone> = {
  DRAFT: "unknown", PROPOSED: "info", RUNNING: "info", PAUSED: "warn",
  ACHIEVED: "ok", CANCELLED: "unknown", FAILED: "danger", EXPIRED: "warn",
  BACKLOG: "unknown", IN_PROGRESS: "info", DONE: "ok", BLOCKED: "warn",
  TARGET_MET_CANDIDATE: "purple", WAIT: "info", GAP: "warn", OK: "ok",
  UNVERIFIED: "unknown",
};

type BizSt =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CompanyPayload; forBiz: string }
  | { kind: "error"; err: ApiError };

type ObjSt =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; cockpit: CockpitPayload; reviews: ReviewsPage; forBiz: string; forId: string }
  | { kind: "mismatch"; objBiz: string }
  | { kind: "error"; err: ApiError };

export function Ceo() {
  const { biz } = useSelectedBusiness();
  const [sp, setSp] = useSearchParams();
  const sel = sp.get("objective") ?? "";
  const [st, setSt] = useState<BizSt>({ kind: "loading" });
  const [obj, setObj] = useState<ObjSt>({ kind: "idle" });
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [passResult, setPassResult] = useState<OperatingPassResult | null>(null);
  const [dlgCtx, setDlgCtx] = useState<{ biz: string; oid: string } | null>(null);
  const opSeq = useRef(0);

  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    api
      .businessCompany(biz, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setSt({ kind: "ready", data: r.company, forBiz: biz }); })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, tick]);

  /* Selection change: drop the previous objective's data, pending
     dialog, pass result and in-flight ownership immediately. */
  useEffect(() => {
    setObj({ kind: sel ? "loading" : "idle" });
    setConfirming(false);
    setDlgCtx(null);
    setMutBusy(false);
    setMutNote(null);
    setPassResult(null);
    opSeq.current++;
  }, [biz, sel]);

  useEffect(() => {
    if (!biz || !sel) return;
    const ctl = new AbortController();
    Promise.all([
      api.objectiveCockpit(sel, ctl.signal),
      api.objectiveReviews(sel, 50, ctl.signal),
    ])
      .then(([c, r]) => {
        if (ctl.signal.aborted) return;
        const cp = c.cockpit as CockpitPayload;
        if (String(cp.objective.business_id) !== biz) setObj({ kind: "mismatch", objBiz: cp.objective.business_id });
        else setObj({ kind: "ready", cockpit: cp, reviews: r, forBiz: biz, forId: sel });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setObj({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, sel, tick]);

  const runPass = () => {
    if (!dlgCtx) return;
    const ctx = dlgCtx;
    const seq = ++opSeq.current;
    setConfirming(false);
    setDlgCtx(null);
    setMutBusy(true);
    setMutNote(null);
    api
      .ceoCycleApp(ctx.oid)
      .then((res) => {
        if (seq !== opSeq.current || ctx.biz !== biz || ctx.oid !== sel) return;
        setMutBusy(false);
        setPassResult(res);
        setMutNote("CEO pass committed — invocation result shown below; projections refetched.");
        setTick((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current || ctx.biz !== biz || ctx.oid !== sel) return;
        setMutBusy(false);
        setMutNote(`CEO pass failed: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}`);
      });
  };

  /* Synchronous render-boundary guards (R2 pattern). */
  const comp = st.kind === "ready" && st.forBiz === biz && String(st.data.business.business_id) === biz
    ? st.data : null;
  const oc = obj.kind === "ready" && obj.forBiz === biz && obj.forId === sel &&
    String(obj.cockpit.objective.objective_id) === sel &&
    String(obj.cockpit.objective.business_id) === biz
    ? obj : null;
  const summaries = comp?.objectives ?? [];

  return (
    <>
      <div className="chead">
        <div>
          <h1>CEO Workspace</h1>
          <div className="sub">Explains the autonomous layer for the selected objective — not a control panel.</div>
        </div>
      </div>

      {!biz ? (
        <EmptyState title="No business selected" detail="Select a business first — the workspace is scoped to owned objectives only." />
      ) : st.kind === "loading" || (st.kind === "ready" && !comp) ? (
        <div className="need">{[0, 1].map((i) => <div className="nrow" key={i}><Skeleton height={12} width="60%" /></div>)}</div>
      ) : st.kind === "error" ? (
        st.err.status === 403 ? (
          <DeniedState detail={`${st.err.detail || "No access to this business"} (${st.err.code})`} />
        ) : st.err.status === 401 ? (
          <ErrorState code={st.err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={() => setTick((n) => n + 1)} />
        ) : (
          <ErrorState code={st.err.code} detail={st.err.detail} onRetry={() => setTick((n) => n + 1)} />
        )
      ) : (
        <>
          <div className="ofrow" style={{ maxWidth: 520 }}>
            <label htmlFor="ojsel">Objective</label>
            <select
              id="ojsel"
              aria-label="objective selector"
              value={sel}
              onChange={(e) => setSp(e.target.value ? { objective: e.target.value } : {})}
            >
              <option value="">— choose an owned objective —</option>
              {summaries.map((o) => (
                <option key={o.objective_id} value={o.objective_id}>
                  {(o.title || o.objective_id)} · {o.status}
                </option>
              ))}
            </select>
            {comp?.objectives_truncated ? (
              <div className="sub">Selector lists {summaries.length} of {comp.objectives_total_owned} owned — truncated; open Objective Detail directly for others.</div>
            ) : null}
          </div>

          {sel === "" ? (
            <EmptyState title="No objective selected" detail="Pick an objective to inspect its strategy, workstreams, missions and review timeline." />
          ) : obj.kind === "mismatch" ? (
            <DeniedState detail={`Objective ${sel} belongs to business ${obj.objBiz}, not ${biz}. Switch business to view it.`} />
          ) : obj.kind === "error" ? (
            obj.err.status === 403 ? (
              <DeniedState detail={`${obj.err.detail || "You don't own this objective"} (${obj.err.code})`} />
            ) : obj.err.status === 401 ? (
              <ErrorState code={obj.err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={() => setTick((n) => n + 1)} />
            ) : (
              <ErrorState code={obj.err.code} detail={obj.err.code.startsWith("FAIL_CLOSED") ? `Integrity check failed — not rendered. ${obj.err.detail}` : obj.err.detail} onRetry={() => setTick((n) => n + 1)} />
            )
          ) : oc === null ? (
            <div className="need">{[0, 1, 2].map((i) => <div className="nrow" key={i}><Skeleton height={12} width="60%" /></div>)}</div>
          ) : (
            <CeoObjectiveView
              c={oc!.cockpit}
              reviews={oc!.reviews}
              mutBusy={mutBusy}
              mutNote={mutNote}
              passResult={passResult}
              onPass={() => { setDlgCtx({ biz: biz!, oid: sel }); setConfirming(true); }}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title="Run CEO pass"
        body={`Run a real CEO pass on ${dlgCtx?.oid ?? sel} in ${dlgCtx?.biz ?? biz}? This commits a canonical ceo-cycle — not a simulation. Projections refetch after it lands.`}
        confirmLabel="Run CEO pass"
        busy={mutBusy}
        onConfirm={runPass}
        onCancel={() => { setConfirming(false); setDlgCtx(null); }}
      />
    </>
  );
}

function CeoObjectiveView(props: {
  c: CockpitPayload;
  reviews: ReviewsPage;
  mutBusy: boolean;
  mutNote: string | null;
  passResult: OperatingPassResult | null;
  onPass: () => void;
}) {
  const { c, reviews, mutBusy, mutNote, passResult, onPass } = props;
  const o = c.objective;
  const obsErr = c.observation_error !== null;
  const plan = c.workstreams.length > 0;
  const latest = c.latest_review;
  return (
    <>
      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}
      {obsErr ? (
        <UnverifiedPanel title="Observation failed integrity check" detail={`${c.observation_error} — claims below are unverified.`} />
      ) : null}

      <div className="stats">
        <div className="stat">
          <div className="k">Objective</div>
          <div className="v"><StatusBadge tone={S_TONE[o.status] ?? "unknown"} label={o.status} /></div>
          <div className="sub">{o.title || o.objective_id}</div>
        </div>
        <div className="stat">
          <div className="k">KPI</div>
          <div className="v" style={{ fontSize: 13 }}>
            {c.kpi_summary.verified_kpi_count} verified · {c.kpi_summary.gap_kpi_count} gap · {c.kpi_summary.unverified_kpi_count} unverified
            {c.kpi_summary.all_targets_met ? " · ALL MET" : ""}
          </div>
        </div>
        <div className="stat">
          <div className="k">Strategy</div>
          <div className="v" style={{ fontSize: 13 }}>
            {latest?.strategy_revision_id ? `rev ${latest.strategy_revision_id}` : "—"}
            {latest?.recommended_status ? ` · recommends ${latest.recommended_status}` : ""}
          </div>
        </div>
      </div>

      <div className="actions">
        <button className="primary" disabled={mutBusy} onClick={onPass}>Run CEO pass</button>
        <Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}`}>objective detail →</Link>
        <Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}/reviews`}>all reviews →</Link>
      </div>

      {passResult ? (
        <div className="need" aria-label="latest pass invocation result">
          <div className="h">Latest pass outcome <span className="cnt">invocation result</span></div>
          <div className="nrow">
            <StatusBadge tone={S_TONE[passResult.outcome] ?? "info"} label={passResult.outcome} />
            <span className="note">
              {passResult.mission_id ? `mission ${passResult.mission_id.slice(0, 14)} ` : ""}
              {passResult.ceo_decision_id ? `· decision ${passResult.ceo_decision_id.slice(0, 14)} ` : ""}
              {passResult.review_id ? `· review ${passResult.review_id.slice(0, 14)} ` : ""}
              {passResult.detail ? `· ${passResult.detail}` : ""}
            </span>
          </div>
          <div className="nrow">
            <span className="note">Result of this invocation only — no persistent latest-pass read exists (API_MISSING); history lives in reviews below.</span>
          </div>
        </div>
      ) : null}

      <h2 className="sech">Strategy & workstreams</h2>
      {!plan ? (
        <div className="need"><div className="nrow"><span className="note">No canonical plan binding yet — workstreams appear after the first committed CEO pass.</span></div></div>
      ) : (
        <div className="need">
          {c.workstreams.map((w) => (
            <div className="nrow" key={w.workstream_key}>
              <span className="tt">{w.workstream_key}</span>
              <StatusBadge tone={S_TONE[w.workstream_status] ?? "unknown"} label={w.workstream_status} />
              <ProofChip state={w.completion_proven ? "proven" : "claimed"} />
              <span className="note">
                {w.allocation_state}{w.selected_agent_id ? ` · ${w.selected_agent_id}` : ""}
                {w.delegated_child ? ` → ${w.delegated_child.work_item_id} ${w.delegated_child.status}` : ""}
              </span>
              {w.delegated_child?.mission ? (
                <Link className="go" to={`/missions/${encodeURIComponent(w.delegated_child.mission.mission_id)}`}>
                  {w.delegated_child.mission.mission_id.slice(0, 12)}… {w.delegated_child.mission.status}
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <h2 className="sech">Missions</h2>
      <div className="need">
        {c.missions.length === 0 ? <div className="nrow"><span className="note">No missions bound yet.</span></div> : null}
        {c.missions.map((m) => (
          <div className="nrow" key={m.mission_id}>
            <span className="tt">{m.mission_id}</span>
            <StatusBadge tone={S_TONE[m.status] ?? "unknown"} label={m.status} />
            <span className="note">runtime {m.runtime_state ?? "—"}</span>
            <Link className="go" to={`/missions/${encodeURIComponent(m.mission_id)}`}>open →</Link>
          </div>
        ))}
      </div>

      <h2 className="sech">Decisions & reviews <span className="note">(full decision browsing: API_MISSING — references shown as carried on review rows)</span></h2>
      <div className="need">
        {reviews.reviews.length === 0 ? <div className="nrow"><span className="note">No reviews yet.</span></div> : null}
        {reviews.reviews.map((r) => (
          <div className="nrow rvrow" key={r.review_id}>
            <StatusBadge tone={S_TONE[r.outcome] ?? "unknown"} label={r.outcome} />
            <span className="tt">{r.review_id.slice(0, 18)}</span>
            <span className="note">
              {String(r.created_at).slice(0, 19).replace("T", " ")} · by {r.created_by}
              {r.recommended_status ? ` · recommends ${r.recommended_status}` : ""}
              {r.wait_reason ? ` · wait: ${r.wait_reason}` : ""}
            </span>
            <span className="note">
              decision {r.source_ceo_decision_id ?? "—"} · revision {r.strategy_revision_id ?? "—"} · digest {String(r.review_observation_digest).slice(0, 12)}…
            </span>
            <span className="note">
              KPI ✓{r.verified_kpi_count} gap{r.gap_kpi_count} unv{r.unverified_kpi_count} · owner_action {String(r.owner_action_required)} (historical)
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
