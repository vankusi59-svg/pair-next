import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { CockpitPayload } from "../types";
import { StatusBadge, ProofChip, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton, UnverifiedPanel } from "../components/states";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { money } from "../components/EntityCard";

/* P15.9-B3 — Objective Detail (mandate §4/§5): canonical read
   GET /api/vnext/objectives/:id/cockpit only. Fresh pending =
   lifecycle.owner_action_required ONLY; CANDIDATE ≠ ACHIEVED;
   observation_error → UnverifiedPanel; *_microusd always USD. */

type LoadState =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CockpitPayload; forBiz: string; forId: string }
  | { kind: "mismatch"; objBiz: string }
  | { kind: "error"; err: ApiError };

const S_TONE: Record<string, Tone> = {
  DRAFT: "unknown", PROPOSED: "info", RUNNING: "info", PAUSED: "warn",
  ACHIEVED: "ok", CANCELLED: "unknown", FAILED: "danger", EXPIRED: "warn",
  TARGET_MET_CANDIDATE: "purple", MET: "ok", GAP: "warn", UNVERIFIED: "unknown",
  DONE: "ok", COMPLETED: "ok", IN_PROGRESS: "info", BACKLOG: "unknown",
  ENABLED: "ok", DISABLED: "unknown", PAUSED_P: "warn", HALTED: "danger",
  EXPIRED_P: "warn", ACTIVE: "ok", INTERVENTION: "warn", EXHAUSTED: "danger",
};

/* Legal auto-policy transitions mirrored from
   objective-auto-policy.ts TRANSITIONS — controls only appear for
   states the backend accepts; every action still re-validates
   server-side (CAS on policy_version). */
const POLICY_TRANSITIONS: Record<string, string[]> = {
  configure: ["DISABLED", "EXPIRED"],
  enable: ["DISABLED", "PAUSED"],
  pause: ["ENABLED"],
  resume: ["PAUSED"],
  disable: ["ENABLED", "PAUSED", "HALTED"],
  revoke: ["ENABLED", "PAUSED", "DISABLED", "HALTED"],
  halt: ["ENABLED", "PAUSED"],
  reset_halt: ["HALTED"],
};
const POLICY_LABELS: Record<string, string> = {
  configure: "Configure policy", enable: "Enable policy", pause: "Pause policy",
  resume: "Resume policy", disable: "Disable policy", revoke: "Revoke policy",
  halt: "Halt policy (objective scope)", reset_halt: "Reset halt",
};

type DlgCtx =
  | { kind: "ceo"; biz: string; oid: string }
  | { kind: "policy"; action: string; biz: string; oid: string; policyVersion: number | null };

export function ObjectiveDetail() {
  const { id = "" } = useParams();
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<LoadState>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [dlg, setDlg] = useState<DlgCtx | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  /* idempotency keys live per logical operation, keyed by
     action:objective — a retry of the SAME operation reuses the key;
     a different action or a route change gets a fresh one. */
  const idemKeys = useRef<Record<string, string>>({});
  /* Monotonic op token: a resolution whose token is no longer current
     (dialog context invalidated by navigation) never touches this
     view's state — the committed backend mutation stands, but this
     surface does not show it as belonging to a different identity. */
  const opSeq = useRef(0);
  const [polLimits, setPolLimits] = useState({ expires: "", ceo: "", missions: "", budget: "" });

  // Cross-objective isolation: switching objective or business drops
  // any pending dialog, note, and in-flight result ownership.
  useEffect(() => {
    setMutNote(null);
    setDlg(null);
    setMutBusy(false);
    idemKeys.current = {};
    opSeq.current++;
  }, [biz, id]);

  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz || !id) return;
    const ctl = new AbortController();
    api
      .objectiveCockpit(id, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const c = r.cockpit;
        if (String(c.objective.business_id) !== biz) setSt({ kind: "mismatch", objBiz: c.objective.business_id });
        else if (String(c.objective.objective_id) !== id) setSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "Cockpit response identity does not match the requested objective.") });
        else setSt({ kind: "ready", data: c, forBiz: biz, forId: id });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, id, tick]);

  const refetch = () => setTick((n) => n + 1);

  /* Resolve a mutation only while its captured context is still the
     active view. The commit itself is never cancelled — only the
     stale UI attribution is dropped. */
  const settle = (seq: number, ctx: { biz: string; oid: string }, ok: string, failPrefix: string) =>
    (e: unknown, isErr: boolean) => {
      if (seq !== opSeq.current || ctx.biz !== biz || ctx.oid !== id) return;
      setMutBusy(false);
      setMutNote(isErr ? `${failPrefix}: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}` : ok);
      if (!isErr) refetch();
    };

  const runCeo = () => {
    if (!dlg || dlg.kind !== "ceo") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const seq = ++opSeq.current;
    setDlg(null); setMutBusy(true); setMutNote(null);
    api.ceoCycleApp(ctx.oid)
      .then(() => settle(seq, ctx, "CEO pass committed — canonical projection refreshed.", "")(null, false))
      .catch((e: unknown) => settle(seq, ctx, "", "CEO pass failed")(e, true));
  };

  const runPolicy = () => {
    if (!dlg || dlg.kind !== "policy") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const { action, policyVersion } = dlg;
    const seq = ++opSeq.current;
    setDlg(null); setMutBusy(true); setMutNote(null);
    const key = `${action}:${ctx.oid}`;
    if (!idemKeys.current[key]) idemKeys.current[key] = `app-${action}-${ctx.oid}-${Date.now()}`;
    const body: Parameters<typeof api.autoPolicyControlApp>[1] = {
      action,
      idempotency_key: idemKeys.current[key],
    };
    /* CAS: the version captured when the dialog opened. First
       configure on an absent policy is the only call allowed to
       omit policy_version. */
    if (policyVersion !== null) body.policy_version = policyVersion;
    if (action === "halt") {
      body.halt_scope = "OBJECTIVE";
      body.halt_reason = "owner halt via company cockpit";
    }
    if (action === "configure") {
      const limits: { expires_at: string; max_ceo_calls?: number; max_missions?: number; budget_microusd_cap?: number } = {
        expires_at: polLimits.expires ? new Date(polLimits.expires).toISOString() : "",
      };
      if (polLimits.ceo.trim()) limits.max_ceo_calls = Number(polLimits.ceo);
      if (polLimits.missions.trim()) limits.max_missions = Number(polLimits.missions);
      if (polLimits.budget.trim()) limits.budget_microusd_cap = Math.round(Number(polLimits.budget) * 1e6);
      if (!limits.expires_at || (limits.max_ceo_calls === undefined && limits.max_missions === undefined && limits.budget_microusd_cap === undefined)) {
        setMutBusy(false);
        setMutNote("Configure rejected: limits need expires_at plus at least one cap (max_ceo_calls | max_missions | budget_microusd_cap).");
        return;
      }
      body.limits = limits;
    }
    api.autoPolicyControlApp(ctx.oid, body)
      .then(() => {
        delete idemKeys.current[key];
        settle(seq, ctx, `Policy ${action} committed — projection refreshed.`, "")(null, false);
      })
      .catch((e: unknown) => settle(seq, ctx, "", `Policy ${action} failed (same idempotency key kept for retry)`)(e, true));
  };

  if (st.kind === "no-business") {
    return (<><h1>Objective</h1><EmptyState title="No business selected" detail="Select a business first — objective detail is rendered inside the selected-business context." /></>);
  }
  if (st.kind === "loading") {
    return (<><h1>Objective</h1><div className="sub">Loading {id}…</div><div className="stats">{[0,1,2].map(i=><div className="stat" key={i}><Skeleton height={11} width="70%"/><Skeleton height={22} width="40%"/></div>)}</div><Skeleton height={120} /></>);
  }
  if (st.kind === "mismatch") {
    return (<><h1>Objective</h1><DeniedState detail={`Objective ${id} belongs to business ${st.objBiz}, not the selected ${biz}. Switch business to view it — nothing from another business is shown.`} /></>);
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <><h1>Objective</h1><div className="sub">{biz}</div>
        {err.status === 401 ? (
          <ErrorState code={err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={refetch} />
        ) : err.status === 403 ? (
          <DeniedState detail={`${err.detail || "You don't own this objective."} (${err.code})`} />
        ) : (
          <ErrorState code={err.code} detail={err.code.startsWith("FAIL_CLOSED") ? `Integrity check failed — possibly-corrupt data was not rendered. ${err.detail}` : err.detail} onRetry={refetch} />
        )}
      </>
    );
  }

  /* R2-F1 — synchronous identity guard at the render boundary:
     never paint ready data belonging to another route or business.
     Stale-for-this-route data renders the loading state while the
     effect fetch for the current params completes. */
  if (st.forBiz !== biz || st.forId !== id ||
      String(st.data.objective.objective_id) !== id ||
      String(st.data.objective.business_id) !== biz) {
    return (<><h1>Objective</h1><div className="sub">Loading {id}…</div><div className="stats">{[0,1,2].map(i=><div className="stat" key={i}><Skeleton height={11} width="70%"/><Skeleton height={22} width="40%"/></div>)}</div><Skeleton height={120} /></>);
  }

  const c = st.data;
  const o = c.objective;
  const obsErr = c.observation_error !== null;
  const kpisMet = c.kpi_summary.all_targets_met;
  const converging = kpisMet && c.workstreams.some((w) => w.workstream_status === "BACKLOG" || w.workstream_status === "IN_PROGRESS");
  const pol = c.auto_policy;

  return (
    <>
      <div className="chead">
        <div>
          <div className="sub"><Link to="/app/objectives">‹ Objectives</Link> / {o.objective_id}</div>
          <h1>{o.title || o.objective_id}</h1>
          <div className="sub">
            {o.statement || "—"} · deadline {o.deadline ? String(o.deadline).slice(0, 10) : "none"} · owner {o.owner_authority_id} · terms v{o.terms_version} · obj v{o.version} · biz {biz}
          </div>
        </div>
        <StatusBadge tone={S_TONE[o.status] ?? "unknown"} label={o.status} />
      </div>

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      <div className="stats">
        <div className="stat">
          <div className="k">KPI</div>
          <div className="v" style={{ fontSize: 14, lineHeight: 1.6 }}>
            {c.kpi_summary.verified_kpi_count} verified · {c.kpi_summary.gap_kpi_count} gap · {c.kpi_summary.unverified_kpi_count} unverified
          </div>
          <div className="n">{kpisMet ? "all targets met" : "targets open"}</div>
        </div>
        <div className="stat">
          <div className="k">Budget</div>
          <div className="v" style={{ fontSize: 18, lineHeight: 1.6 }}>{money(o.budget.consumed_microusd)} / {money(o.budget.ceiling_microusd)}</div>
          <div className="n">{o.budget.canonically_proven ? "proven" : "claimed — not proven"} · aggregate display only</div>
        </div>
        <div className="stat">
          <div className="k">Lifecycle</div>
          <div className="v" style={{ fontSize: 14, lineHeight: 1.6 }}>
            {o.status}{converging ? " — workstreams still converging" : ""}
            {c.lifecycle.latest_review_outcome ? ` · last review ${c.lifecycle.latest_review_outcome}` : ""}
          </div>
          <div className="n">
            {c.lifecycle.owner_action_required ? "owner action REQUIRED (fresh)" : "no pending owner action"}
            {c.lifecycle.recommended_status ? ` · recommended ${c.lifecycle.recommended_status}` : ""}
          </div>
        </div>
      </div>

      {obsErr ? (
        <UnverifiedPanel title="Observation failed integrity check" detail={`${c.observation_error} — KPI/workstream/budget claims below are shown as unverified claims, never verified evidence.`} />
      ) : null}

      <h2 className="sech">Owner actions</h2>
      <div className="actions">
        <button className="primary" disabled={mutBusy} onClick={() => setDlg({ kind: "ceo", biz: biz!, oid: id })}>Run CEO pass</button>
        {/* Canonical auto-policy controls (B0): only actions legal from
            the current stored state are offered — configure allowed
            when unconfigured; every action still CAS-validates
            server-side. */}
        {(!pol?.configured ? ["configure"] : []).concat(
          pol?.configured
            ? Object.keys(POLICY_TRANSITIONS).filter((a) => POLICY_TRANSITIONS[a].includes(String(pol.state)))
            : [],
        ).map((a) => (
          <button key={a} className="ghost" disabled={mutBusy}
            onClick={() => setDlg({ kind: "policy", action: a, biz: biz!, oid: id, policyVersion: pol?.configured ? (pol.policy_version ?? null) : null })}>
            {POLICY_LABELS[a]}
          </button>
        ))}
        <button className="ghost" disabled title="Owner transition route ships in A2 — disabled, not a fake action">Accept ACHIEVED (A2)</button>
        <button className="ghost" disabled title="Amend route ships in A2 — disabled, not a fake action">Amend objective (A2)</button>
      </div>

      <h2 className="sech">KPIs</h2>
      <div className="need">
        {o.kpis.length === 0 ? <div className="nrow"><span className="note">No KPIs declared.</span></div> : null}
        {o.kpis.map((k) => (
          <div className="nrow" key={k.kpi_id}>
            <span className="tt">{k.name}</span>
            <span className="note">
              {k.current ?? "—"}/{k.target} {k.unit} · {k.direction} · baseline {k.baseline}
            </span>
            <StatusBadge tone={k.canonically_proven ? (S_TONE[k.assessment] ?? "unknown") : "unknown"} label={k.canonically_proven ? k.assessment : "UNVERIFIED"} />
            <ProofChip state={k.canonically_proven ? "proven" : "unverifiable"} />
          </div>
        ))}
      </div>

      <h2 className="sech">Plan & workstreams</h2>
      {obsErr ? (
        <EmptyState title="Workstream state unverified" detail="Observation integrity failed — claims are not rendered as verified." />
      ) : c.binding === null ? (
        <EmptyState title="no canonical plan yet" detail="Pre-binding objective — no CEO plan has bound workstreams." />
      ) : (
        <>
          <div className="sub">binding {c.binding.binding_id} · digest {c.binding.binding_digest.slice(0, 12)}…</div>
          <div className="need">
            {c.workstreams.length === 0 ? <div className="nrow"><span className="note">Binding exists but no workstreams returned.</span></div> : null}
            {c.workstreams.map((w) => (
              <div className="nrow" key={w.workstream_key}>
                <span className="tt">{w.workstream_key}</span>
                <StatusBadge tone={S_TONE[w.workstream_status] ?? "unknown"} label={w.workstream_status} />
                <ProofChip state={w.completion_proven ? "proven" : "claimed"} />
                <span className="note">
                  {w.allocation_state}{w.selected_agent_id ? ` · ${w.selected_agent_id}` : ""}
                  {w.delegated_child ? ` → ${w.delegated_child.work_item_id} ${w.delegated_child.status}` : " (no delegated child)"}
                </span>
                {w.delegated_child?.mission ? (
                  <Link className="go" to={`/missions/${encodeURIComponent(w.delegated_child.mission.mission_id)}`}>
                    {w.delegated_child.mission.mission_id.slice(0, 12)}… {w.delegated_child.mission.status}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="sech">Missions</h2>
      <div className="need">
        {c.missions.length === 0 ? <div className="nrow"><span className="note">No missions bound yet — they appear when the CEO plan delegates work.</span></div> : null}
        {c.missions.map((m) => (
          <div className="nrow" key={m.mission_id}>
            <span className="tt">{m.mission_id}</span>
            <StatusBadge tone={S_TONE[m.status] ?? "unknown"} label={m.status} />
            <span className="note">runtime {m.runtime_state ?? "—"}</span>
            <Link className="go" to={`/missions/${encodeURIComponent(m.mission_id)}`}>open mission →</Link>
          </div>
        ))}
      </div>

      <div className="grid2">
        <section>
          <h2 className="sech">Artifacts{c.artifacts_dropped_unverified > 0 ? ` (+${c.artifacts_dropped_unverified} dropped unverifiable)` : ""}</h2>
          {c.artifacts_truncated ? <div className="sub">Partial list — verified artifacts bounded.</div> : null}
          <div className="need">
            {c.artifacts.length === 0 ? <div className="nrow"><span className="note">No verified artifacts.</span></div> : null}
            {c.artifacts.map((a) => (
              <div className="nrow" key={a.artifact_id}>
                <span className="tt">{a.logical_name}</span>
                <span className="note">{a.artifact_class} · {a.byte_size}B · {a.mission_id.slice(0, 12)}…</span>
                <ProofChip state="proven" />
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2 className="sech">Reviews ({c.review_count})</h2>
          <div className="need">
            {c.latest_review === null ? <div className="nrow"><span className="note">No reviews yet.</span></div> : (
              <div className="nrow">
                <StatusBadge tone={S_TONE[c.latest_review.outcome] ?? "unknown"} label={c.latest_review.outcome} />
                <span className="note">{String(c.latest_review.created_at).slice(0, 19).replace("T", " ")} · historical flag {String(c.latest_review.owner_action_required)}</span>
              </div>
            )}
            <div className="nrow"><Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}/reviews`}>view all reviews →</Link></div>
          </div>
        </section>
      </div>

      <h2 className="sech">Auto policy & driver</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">auto_policy</span>
          {pol === null ? <span className="note">not configured</span> : (
            <>
              <StatusBadge tone={S_TONE[String(pol.state)] ?? "unknown"} label={String(pol.state)} />
              <span className="note">
                v{pol.policy_version ?? "—"} · effective {String(pol.effective)}{pol.expires_at ? ` · expires ${String(pol.expires_at).slice(0, 10)}` : ""}
                {Array.isArray(pol.reasons) && pol.reasons.length ? ` · ${pol.reasons.join(", ")}` : ""}
              </span>
            </>
          )}
          {pol?.expiry_pending ? <StatusBadge tone="warn" label="policy expired — awaiting canonical commit" /> : null}
        </div>
        <div className="nrow">
          <span className="tt">auto_driver</span>
          <span className="note">{c.auto_driver ? `status: ${JSON.stringify(c.auto_driver.status)}` : "not configured"}</span>
        </div>
      </div>

      <ConfirmDialog
        open={dlg?.kind === "ceo"}
        title="Run CEO pass"
        body={`Run a real CEO pass on ${dlg?.kind === "ceo" ? dlg.oid : o.objective_id} in ${dlg?.kind === "ceo" ? dlg.biz : biz}? This commits a canonical ceo-cycle — not a simulation. The projection refetches after it lands.`}
        confirmLabel="Run CEO pass"
        busy={mutBusy}
        onConfirm={runCeo}
        onCancel={() => setDlg(null)}
      />
      <ConfirmDialog
        open={dlg?.kind === "policy"}
        title={dlg?.kind === "policy" ? (POLICY_LABELS[dlg.action] ?? dlg.action) : "Auto policy"}
        body={dlg?.kind === "policy"
          ? `Commit "${dlg.action}" on ${dlg.oid} in ${dlg.biz}?${dlg.policyVersion !== null ? ` CAS on policy_version ${dlg.policyVersion}.` : " First configure on an absent policy — no version required."} Posts the real control contract with a generated idempotency key; projection refetches after commit.`
          : ""}
        confirmLabel={dlg?.kind === "policy" ? `Commit ${dlg.action}` : "Commit"}
        busy={mutBusy}
        onConfirm={runPolicy}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "policy" && dlg.action === "configure" ? (
          <div className="ofrow" aria-label="policy limits">
            <label htmlFor="pex">expires_at (required)</label>
            <input id="pex" type="datetime-local" value={polLimits.expires} onChange={(e) => setPolLimits({ ...polLimits, expires: e.target.value })} />
            <div className="ofrow2">
              <input placeholder="max_ceo_calls" aria-label="max ceo calls" value={polLimits.ceo} onChange={(e) => setPolLimits({ ...polLimits, ceo: e.target.value })} />
              <input placeholder="max_missions" aria-label="max missions" value={polLimits.missions} onChange={(e) => setPolLimits({ ...polLimits, missions: e.target.value })} />
            </div>
            <input placeholder="budget cap (USD)" aria-label="budget cap usd" value={polLimits.budget} onChange={(e) => setPolLimits({ ...polLimits, budget: e.target.value })} />
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
