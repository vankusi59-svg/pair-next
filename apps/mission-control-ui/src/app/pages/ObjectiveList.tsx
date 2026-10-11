import { useEffect, useRef, useState } from "react";
import { api, ApiError, getOperatorId } from "../../api";
import { usdToMicrousd } from "../../lib/objective-display";
import { useSelectedBusiness } from "../AppShell";
import type { CompanyPayload } from "../types";
import {
  DeniedState,
  EmptyState,
  ErrorState,
  Skeleton,
} from "../components/states";
import { EntityCard } from "../components/EntityCard";
import { ConfirmDialog } from "../components/ConfirmDialog";

/* P15.9-B3 — Objective List (mandate §3): owner-scoped canonical list
   via GET /api/vnext/businesses/:id/company only. Never enumerates
   /api/businesses, never uses legacy unscoped vnextObjectives(). */

type LoadState =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CompanyPayload; forBiz: string }
  | { kind: "error"; err: ApiError };

type KpiDraft = { name: string; unit: string; direction: string; baseline: string; target: string };

export function ObjectiveList() {
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<LoadState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [createNote, setCreateNote] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [deadline, setDeadline] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [kpis, setKpis] = useState<KpiDraft[]>([]);
  const [constraints, setConstraints] = useState("");
  const [success, setSuccess] = useState("");
  /* R1-F2 — the pending confirmation is bound to the business that
     was selected when it opened; a biz switch invalidates it, and an
     in-flight result only updates the view it was issued for. */
  const [dlgBiz, setDlgBiz] = useState<string | null>(null);
  const createSeq = useRef(0);
  /* R3-F1 — one dedup_key per LOGICAL creation attempt: the canonical
     authority derives objective_id from (business_id, dedup_key), so
     an identical retry after a lost response must reuse the same key
     to converge on the same objective. The key rotates only when the
     request terms change (a deliberate new operation) and resets on
     confirmed success or business switch. */
  const attemptKey = useRef("");
  const attemptTerms = useRef("");

  const resetForm = () => {
    setTitle(""); setStatement(""); setDeadline(""); setBudgetUsd("");
    setKpis([]); setConstraints(""); setSuccess(""); setFormErr(null);
  };

  useEffect(() => {
    setConfirming(false);
    setDlgBiz(null);
    setCreateNote(null);
    setShowForm(false);
    setBusy(false);
    resetForm();
    createSeq.current++;
    attemptKey.current = "";
    attemptTerms.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz]);

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
  }, [biz, reloadTick]);

  const retry = () => setReloadTick((n) => n + 1);

  const splitLines = (t: string) =>
    t.split("\n").map((l) => l.trim()).filter(Boolean);

  const submitCreate = () => {
    setConfirming(false);
    setFormErr(null);
    if (!dlgBiz || dlgBiz !== biz) { setFormErr("Confirmation was opened for a different business — reopen it."); return; }
    const ctxBiz = dlgBiz;
    const seq = ++createSeq.current;
    const terms = JSON.stringify({ biz: ctxBiz, title, statement, deadline, budgetUsd, kpis, constraints, success });
    if (attemptKey.current === "" || attemptTerms.current !== terms) {
      attemptKey.current = `app-b3-${ctxBiz}-${Date.now()}`;
      attemptTerms.current = terms;
    }
    const op = getOperatorId();
    if (!op) { setFormErr("Set an operator id (top-right) first — objectives are operator-bound."); return; }
    const micro = budgetUsd.trim() ? (usdToMicrousd(budgetUsd) ?? undefined) : undefined;
    if (budgetUsd.trim() && micro == null) {
      setFormErr("Budget must be a non-negative USD amount (safe integer microusd)."); return;
    }
    const rows = kpis.filter((k) => k.name.trim());
    for (const k of rows) {
      if (k.baseline !== "" && !Number.isFinite(Number(k.baseline))) { setFormErr(`KPI "${k.name}": baseline must be a number.`); return; }
      if (k.target !== "" && !Number.isFinite(Number(k.target))) { setFormErr(`KPI "${k.name}": target must be a number.`); return; }
    }
    setBusy(true);
    api
      .createObjectiveApp({
        business_id: ctxBiz,
        title: title.trim() || undefined,
        statement: statement.trim() || undefined,
        deadline: deadline ? new Date(deadline).toISOString() : undefined,
        budget_ceiling_microusd: micro,
        kpis: rows.map((k) => ({
          name: k.name.trim(), unit: k.unit.trim() || undefined, direction: k.direction,
          baseline: k.baseline === "" ? undefined : Number(k.baseline),
          target: k.target === "" ? undefined : Number(k.target),
        })),
        dedup_key: attemptKey.current,
        hard_constraints: splitLines(constraints),
        success_conditions: splitLines(success),
      })
      .then((created) => {
        if (seq !== createSeq.current || ctxBiz !== biz) return; // committed; do not attribute to a different view
        attemptKey.current = "";
        attemptTerms.current = "";
        setBusy(false);
        setShowForm(false);
        resetForm();
        setCreateNote(`Created ${created.objective_id} — refreshing canonical list.`);
        setReloadTick((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (seq !== createSeq.current || ctxBiz !== biz) return;
        setBusy(false);
        setFormErr(e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e));
      });
  };

  const createForm = showForm ? (
    <section className="oform" aria-label="create objective">
      <div className="ofrow"><label htmlFor="nt">Title</label><input id="nt" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grow EA sales" /></div>
      <div className="ofrow"><label htmlFor="ns">Statement</label><textarea id="ns" rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="What the objective must achieve" /></div>
      <div className="ofrow2">
        <div className="ofrow"><label htmlFor="nd">Deadline</label><input id="nd" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
        <div className="ofrow"><label htmlFor="nb">Budget ceiling (USD)</label><input id="nb" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} placeholder="0.00" /></div>
      </div>
      <div className="ofrow">
        <label>KPIs</label>
        {kpis.map((k, i) => (
          <div className="kpirow" key={i}>
            <input placeholder="name" value={k.name} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input placeholder="unit" style={{ width: 80 }} value={k.unit} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} />
            <select aria-label="direction" value={k.direction} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, direction: e.target.value } : x))}>
              <option value="AT_LEAST">AT_LEAST</option><option value="AT_MOST">AT_MOST</option><option value="EXACT">EXACT</option>
            </select>
            <input placeholder="baseline" style={{ width: 90 }} value={k.baseline} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, baseline: e.target.value } : x))} />
            <input placeholder="target" style={{ width: 90 }} value={k.target} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, target: e.target.value } : x))} />
            <button className="ghost" aria-label="remove KPI" onClick={() => setKpis(kpis.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="ghost" onClick={() => setKpis([...kpis, { name: "", unit: "", direction: "AT_LEAST", baseline: "", target: "" }])}>+ add KPI</button>
      </div>
      <div className="ofrow"><label htmlFor="hc">Hard constraints (one per line)</label><textarea id="hc" rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} /></div>
      <div className="ofrow"><label htmlFor="sc">Success conditions (one per line)</label><textarea id="sc" rows={2} value={success} onChange={(e) => setSuccess(e.target.value)} /></div>
      {formErr ? <div className="trunc" role="alert">{formErr}</div> : null}
      <button className="primary" disabled={busy || (!title.trim() && !statement.trim())} onClick={() => { setDlgBiz(biz); setConfirming(true); }}>
        {busy ? "Creating…" : "Create objective"}
      </button>
      <div className="sub">Creates via the canonical POST contract for {biz} — explicit action + confirmation, backend stays authoritative.</div>
    </section>
  ) : null;

  const createDialog = (
    <ConfirmDialog
      open={confirming}
      title="Create objective"
      body={`Create a new canonical objective for ${dlgBiz ?? biz}? This posts the real creation contract — the backend remains authoritative and the list refetches after success.`}
      confirmLabel="Create"
      busy={busy}
      onConfirm={submitCreate}
      onCancel={() => setConfirming(false)}
    />
  );

  if (st.kind === "no-business") {
    return (
      <>
        <h1>Objectives</h1>
        <EmptyState title="No business selected" detail="Enter a business_id in the switcher — access is proven on read (403 = denied)." />
      </>
    );
  }
  if (st.kind === "loading") {
    return (
      <>
        <h1>Objectives</h1>
        <div className="sub">Loading {biz}…</div>
        <div className="ecards">{[0, 1].map((i) => <div className="ecard" key={i}><Skeleton height={14} width="60%" /><Skeleton height={28} /></div>)}</div>
      </>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <>
        <h1>Objectives</h1>
        <div className="sub">{biz}</div>
        {err.status === 403 ? (
          <>
            <DeniedState detail={`${err.detail || "You don't own any objectives in this business."} (${err.code})`} />
            <div className="chead"><div /><button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? "Close form" : "New objective"}</button></div>
            {createForm}
            {createDialog}
          </>
        ) : (
          <ErrorState
            code={err.status === 401 ? (err.code || "UNAUTHORIZED") : err.code}
            detail={err.status === 401 ? "Your credentials were rejected — update the session token and retry." : err.detail}
            onRetry={retry}
          />
        )}
      </>
    );
  }

  /* R2-F1 — synchronous guard: render only data fetched for the
     current selected business; anything else is stale-for-this-view. */
  if (st.forBiz !== biz || String(st.data.business.business_id) !== biz) {
    return (
      <>
        <h1>Objectives</h1>
        <div className="sub">Loading {biz}…</div>
        <div className="ecards">{[0, 1].map((i) => <div className="ecard" key={i}><Skeleton height={14} width="60%" /><Skeleton height={28} /></div>)}</div>
      </>
    );
  }

  const { objectives, counts } = st.data;
  const createdVisible = createNote !== null;

  return (
    <>
      <div className="chead">
        <div>
          <h1>Objectives</h1>
          <div className="sub">
            {counts.objectives_owned} owned{st.data.objectives_truncated ? ` — showing ${counts.objectives_returned}` : ""} · {biz}
          </div>
        </div>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close form" : "New objective"}
        </button>
      </div>

      {st.data.objectives_truncated ? (
        <div className="trunc" role="alert">
          Showing {counts.objectives_returned} of {counts.objectives_owned} owned objectives — counts are exact, the list below is partial.
        </div>
      ) : null}
      {createNote ? <div className="trunc" role="status">{createNote}{objectives.length ? "" : " Not yet visible in the canonical read — it may not be accessible to this operator."}</div> : null}
      {createdVisible && createNote && objectives.length === 0 ? (
        <EmptyState title="Created but not visible" detail="The canonical owner-scoped read returned no objectives — the new objective is not accessible to this operator." />
      ) : null}

      {createForm}

      {objectives.length === 0 && !createNote ? (
        <EmptyState title="No objectives in the returned page" detail={`You own ${counts.objectives_owned} objective(s) here but none were returned in this page.`} />
      ) : (
        <div className="ecards">
          {objectives.map((o) => <EntityCard key={o.objective_id} o={o} />)}
        </div>
      )}

      {createDialog}
    </>
  );
}
