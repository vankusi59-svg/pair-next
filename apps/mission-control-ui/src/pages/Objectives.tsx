import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getOperatorId } from "../api";
import { useApi } from "../hooks/useApi";
import type { CanonicalObjective, OperatingPassResult } from "../types";
import { budgetView, listState, showObjectiveDetail, usdToMicrousd } from "../lib/objective-display";

interface KpiRow {
  name: string;
  unit: string;
  direction: string;
  baseline: string;
  target: string;
}

const emptyKpi = (): KpiRow => ({ name: "", unit: "", direction: "AT_LEAST", baseline: "", target: "" });

export function Objectives() {
  const businesses = useApi(() => api.businesses(), [], 15000);
  const [bizId, setBizId] = useState("");
  const objs = useApi(() => (bizId ? api.vnextObjectives(bizId) : Promise.resolve({ objectives: [] })), [bizId], 10000);

  // ---- create form state -------------------------------------------------
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [deadline, setDeadline] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [kpis, setKpis] = useState<KpiRow[]>([]);
  const [constraints, setConstraints] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState<CanonicalObjective | null>(null);
  const [cycle, setCycle] = useState<OperatingPassResult | null>(null);
  // P15.10-A — auto-policy status for the selected objective. Polls
  // the canonical owner-scoped endpoint; a non-owner gets 403 → the
  // block renders "unavailable", never guessed state.
  const policy = useApi(
    () => (selected ? api.autoPolicyStatus(selected.objective_id) : Promise.resolve(null)),
    [selected?.objective_id],
    15000,
  );
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyErr, setPolicyErr] = useState<string | null>(null);
  const [polExpires, setPolExpires] = useState("");
  const [polCeoCalls, setPolCeoCalls] = useState("");
  const [polMissions, setPolMissions] = useState("");
  const [busy, setBusy] = useState(false);
  const [cycleBusy, setCycleBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const list: CanonicalObjective[] = (objs.data?.objectives ?? []) as CanonicalObjective[];

  const splitLines = (s: string) =>
    s.split("\n").map((x) => x.trim()).filter(Boolean);

  const create = async () => {
    if (!getOperatorId()) { setErr("Set an operator id (top-right) first — objectives are operator-bound."); return; }
    const micro = budgetUsd.trim() ? usdToMicrousd(budgetUsd) : undefined;
    if (budgetUsd.trim() && micro == null) { setErr("Budget must be a non-negative USD amount."); return; }
    const kpiRows = kpis.filter((k) => k.name.trim());
    for (const k of kpiRows) {
      if (k.baseline !== "" && !Number.isFinite(Number(k.baseline))) { setErr(`KPI "${k.name}": baseline must be a number.`); return; }
      if (k.target !== "" && !Number.isFinite(Number(k.target))) { setErr(`KPI "${k.name}": target must be a number.`); return; }
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createVnextObjective({
        business_id: bizId,
        title: title.trim() || undefined,
        statement: statement.trim() || undefined,
        deadline: deadline ? new Date(deadline).toISOString() : undefined,
        budget_ceiling_microusd: micro ?? undefined,
        kpis: kpiRows.map((k) => ({
          name: k.name.trim(), unit: k.unit.trim() || undefined,
          direction: k.direction,
          baseline: k.baseline === "" ? undefined : Number(k.baseline),
          target: k.target === "" ? undefined : Number(k.target),
        })),
        hard_constraints: splitLines(constraints),
        success_conditions: splitLines(success),
      });
      setTitle(""); setStatement(""); setDeadline(""); setBudgetUsd("");
      setKpis([]); setConstraints(""); setSuccess("");
      setSelected(created);
      objs.reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCycle = async () => {
    if (!selected) return;
    setCycleBusy(true);
    setErr(null);
    try {
      const out = await api.runCeoCycle(selected.objective_id);
      setCycle(out);
      objs.reload();
      const fresh = await api.vnextObjective(selected.objective_id);
      setSelected(fresh);
    } catch (e) {
      setErr(String(e));
    } finally {
      setCycleBusy(false);
    }
  };

  const bv = budgetView(selected?.budget as { ceiling_microusd?: number; consumed_microusd?: number } | null | undefined);
  const bizState = listState(businesses.data?.businesses ?? null, businesses.error);
  const objState = listState(bizId ? (objs.data?.objectives ?? null) : [], objs.error);

  return (
    <div className="page">
      <h1>Objectives</h1>
      <p className="muted">
        Canonical P15 objectives — an objective binds KPIs, a budget ceiling and a deadline, then the
        CEO operating loop decomposes it into governed workstreams and dispatches delegated missions.
      </p>

      <section className="card">
        <label htmlFor="objbiz">Business</label>
        <select id="objbiz" value={bizId} onChange={(e) => { setBizId(e.target.value); setSelected(null); setCycle(null); }}>
          <option value="">— select business —</option>
          {bizState === "rows" && (businesses.data?.businesses ?? []).map((b) => (
            <option key={String(b.business_id)} value={String(b.business_id)}>
              {String(b.name ?? b.business_id)}
            </option>
          ))}
        </select>
        {bizState === "error" && (
          <div className="state err">
            Failed to load businesses: {String(businesses.error)}{" "}
            <button className="ghost" onClick={() => businesses.reload()}>Retry</button>
          </div>
        )}
        {bizState === "empty" && (
          <div className="state">No businesses yet — create one on the legacy Business page first.</div>
        )}
      </section>

      {bizId && (
        <section className="card">
          <h2>New objective</h2>
          <label htmlFor="otitle">Title</label>
          <input id="otitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grow EA sales on MQL5" />
          <label htmlFor="ostmt">Statement</label>
          <textarea id="ostmt" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)}
            placeholder="What the objective is and why it matters" />
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div>
              <label htmlFor="odl">Deadline (optional)</label>
              <input id="odl" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </div>
            <div>
              <label htmlFor="obudget">Budget ceiling USD (optional)</label>
              <input id="obudget" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} placeholder="500" inputMode="decimal" />
              <div className="muted" style={{ fontSize: 12 }}>
                Leave blank for a <strong>zero-budget</strong> objective: it is created with
                ceiling $0 and cannot dispatch new work until funded.
              </div>
            </div>
          </div>

          <h3>KPIs</h3>
          {kpis.map((k, i) => (
            <div className="row" key={i} style={{ gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <input placeholder="name" value={k.name} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input placeholder="unit" style={{ width: 90 }} value={k.unit} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} />
              <select value={k.direction} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, direction: e.target.value } : x))}>
                <option value="AT_LEAST">AT_LEAST</option>
                <option value="AT_MOST">AT_MOST</option>
                <option value="EXACT">EXACT</option>
              </select>
              <input placeholder="baseline" style={{ width: 100 }} value={k.baseline} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, baseline: e.target.value } : x))} />
              <input placeholder="target" style={{ width: 100 }} value={k.target} onChange={(e) => setKpis(kpis.map((x, j) => j === i ? { ...x, target: e.target.value } : x))} />
              <button className="ghost" onClick={() => setKpis(kpis.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="ghost" onClick={() => setKpis([...kpis, emptyKpi()])}>+ add KPI</button>

          <label htmlFor="ohard">Hard constraints (one per line)</label>
          <textarea id="ohard" rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
          <label htmlFor="osucc">Success conditions (one per line)</label>
          <textarea id="osucc" rows={2} value={success} onChange={(e) => setSuccess(e.target.value)} />

          {err && <div className="state err">{err}</div>}
          <div className="row">
            <button disabled={busy || (!title.trim() && !statement.trim())} onClick={create}>
              {busy ? "Creating…" : "Create objective"}
            </button>
          </div>
        </section>
      )}

      {bizId && objState === "error" && (
        <div className="state err">
          Failed to load objectives: {String(objs.error)}{" "}
          <button className="ghost" onClick={() => objs.reload()}>Retry</button>
        </div>
      )}
      {bizId && objState === "rows" && (
        <table className="tbl">
          <thead>
            <tr><th>objective</th><th>status</th><th>kpis</th><th>deadline</th><th>created</th></tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.objective_id} onClick={() => { setSelected(o); setCycle(null); }} style={{ cursor: "pointer" }}>
                <td>{o.title ?? o.objective_id}</td>
                <td>{o.status}</td>
                <td>{(o.kpis ?? []).length}</td>
                <td className="muted">{o.deadline ? String(o.deadline).slice(0, 10) : "—"}</td>
                <td className="muted">{o.created_at ? String(o.created_at).slice(0, 10) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {bizId && objState === "empty" && (
        <div className="state muted">No canonical objectives yet.</div>
      )}

      {selected && showObjectiveDetail(objState) && (
        <section className="card">
          <h2>{selected.title ?? selected.objective_id}</h2>
          <p className="muted mono">{selected.objective_id} · status {selected.status}</p>
          {selected.statement && <p>{selected.statement}</p>}

          {(selected.kpis ?? []).length > 0 && (
            <table className="tbl">
              <thead><tr><th>kpi</th><th>direction</th><th>baseline</th><th>current</th><th>target</th><th>unit</th></tr></thead>
              <tbody>
                {(selected.kpis ?? []).map((k) => (
                  <tr key={k.kpi_id}>
                    <td>{k.name}</td><td>{k.direction}</td>
                    <td>{String(k.baseline)}</td><td>{k.current === null ? "—" : String(k.current)}</td>
                    <td>{String(k.target)}</td><td className="muted">{k.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted">
            budget: {bv.label}
            {selected.deadline ? ` · deadline ${String(selected.deadline)}` : ""}
          </p>
          {bv.state === "ZERO_BUDGET" && (
            <p className="state">
              Zero-budget objective — CEO cycles will stop at OBJECTIVE_BUDGET_EXHAUSTED
              instead of dispatching new work.
            </p>
          )}
          {bv.state === "BUDGET_EXHAUSTED" && (
            <p className="state">
              Budget exhausted — CEO cycles will stop at OBJECTIVE_BUDGET_EXHAUSTED
              instead of dispatching new work.
            </p>
          )}
          {(selected.hard_constraints ?? []).length > 0 && (
            <p><strong>constraints:</strong> {(selected.hard_constraints ?? []).join(" · ")}</p>
          )}
          {(selected.success_conditions ?? []).length > 0 && (
            <p><strong>success:</strong> {(selected.success_conditions ?? []).join(" · ")}</p>
          )}

          <section className="card" style={{ marginTop: 12 }}>
            <h3>Auto policy (P15.10-A)</h3>
            {policy.error && (
              <p className="state muted">auto policy unavailable for this operator.</p>
            )}
            {!policy.error && policy.data === null && !policy.loading && (
              <p className="state muted">auto policy status unavailable.</p>
            )}
            {!policy.error && policy.data && (() => {
              const ap = policy.data.auto_policy;
              // O2 — stale-projection guard: only render/act on a policy
              // row that provably belongs to the selected objective. A
              // lagging response for the previous selection is never
              // projected onto this one.
              if (!ap || ap.objective_id !== selected?.objective_id) {
                return <p className="state muted">auto policy loading…</p>;
              }
              const act = async (action: string, limits?: import("../types").AutoPolicyStatus["limits"], haltReason?: string) => {
                setPolicyBusy(true); setPolicyErr(null);
                try {
                  await api.autoPolicyControl(selected.objective_id, {
                    action,
                    policy_version: ap.configured ? (ap.policy_version ?? undefined) : undefined,
                    limits,
                    idempotency_key: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    halt_reason: haltReason,
                  });
                  policy.reload();
                } catch (e) { setPolicyErr(e instanceof Error ? e.message : String(e)); }
                finally { setPolicyBusy(false); }
              };
              const caps = ap.limits
                ? [
                    ap.limits.max_ceo_calls != null ? `ceo≤${ap.limits.max_ceo_calls}` : null,
                    ap.limits.max_missions != null ? `missions≤${ap.limits.max_missions}` : null,
                    ap.limits.budget_microusd_cap != null ? `µusd≤${ap.limits.budget_microusd_cap}` : null,
                    ap.limits.max_retries != null ? `retries≤${ap.limits.max_retries}` : null,
                  ].filter(Boolean).join(" ")
                : "";
              const canConfigure = ap.state === "DISABLED" || ap.state === "EXPIRED";
              return (
                <>
                  <p className="muted mono">
                    state {ap.state} · effective {String(ap.effective)}
                    {ap.policy_version != null ? ` · v${ap.policy_version}` : ""}
                    {ap.expires_at ? ` · expires ${String(ap.expires_at)}` : ""}
                  </p>
                  {caps && <p className="muted mono">limits: {caps}</p>}
                  {ap.reasons.length > 0 && (
                    <p className="muted">reasons: {ap.reasons.join(", ")}</p>
                  )}
                  {ap.halt && (
                    <p className="state">HALTED by {ap.halt.actor} at {ap.halt.at} — {ap.halt.reason}</p>
                  )}
                  <p className="muted">
                    driver: {ap.driver_ready ? "integrated" : "not integrated"}
                    {" "}— policy configured does not mean autonomous CEO runs.
                  </p>
                  {canConfigure && (
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <input type="datetime-local" value={polExpires} onChange={(e) => setPolExpires(e.target.value)} />
                      <input placeholder="max CEO calls" value={polCeoCalls} onChange={(e) => setPolCeoCalls(e.target.value)} style={{ width: 110 }} />
                      <input placeholder="max missions" value={polMissions} onChange={(e) => setPolMissions(e.target.value)} style={{ width: 110 }} />
                      <button
                        disabled={policyBusy}
                        onClick={() => {
                          const limits: Record<string, unknown> = {};
                          if (polExpires) limits.expires_at = new Date(polExpires).toISOString();
                          if (polCeoCalls.trim()) limits.max_ceo_calls = Number(polCeoCalls);
                          if (polMissions.trim()) limits.max_missions = Number(polMissions);
                          void act("configure", limits as never);
                        }}
                      >configure</button>
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 8 }}>
                    {ap.state === "DISABLED" && ap.configured && ap.limits && (
                      <button disabled={policyBusy} onClick={() => void act("enable")}>enable</button>
                    )}
                    {ap.state === "ENABLED" && (
                      <button disabled={policyBusy} onClick={() => void act("pause")}>pause</button>
                    )}
                    {ap.state === "PAUSED" && (
                      <button disabled={policyBusy} onClick={() => void act("resume")}>resume</button>
                    )}
                    {(ap.state === "ENABLED" || ap.state === "PAUSED" || ap.state === "HALTED") && (
                      <>
                        <button disabled={policyBusy} onClick={() => void act("disable")}>disable</button>
                        <button disabled={policyBusy} onClick={() => void act("revoke")}>revoke</button>
                      </>
                    )}
                    {(ap.state === "ENABLED" || ap.state === "PAUSED") && (
                      <button disabled={policyBusy} onClick={() => void act("halt", undefined, "operator halt from Objectives UI")}>halt</button>
                    )}
                    {ap.state === "HALTED" && (
                      <button disabled={policyBusy} onClick={() => void act("reset_halt")}>reset halt</button>
                    )}
                  </div>
                  {policyErr && <p className="state">{policyErr}</p>}
                </>
              );
            })()}
          </section>

          <div className="row">
            <button disabled={cycleBusy} onClick={runCycle}>
              {cycleBusy ? "Running CEO cycle…" : "Run one CEO cycle"}
            </button>
          </div>

          {cycle && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3>Outcome: {cycle.outcome}</h3>
              {cycle.detail && <p className="muted">{cycle.detail}</p>}
              <table className="tbl">
                <tbody>
                  {Object.entries(cycle)
                    .filter(([k, v]) => k !== "detail" && v !== undefined && v !== null)
                    .map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono">{k}</td>
                        <td>{k === "mission_id"
                          ? <Link to={`/missions/${String(v)}`}>{String(v)}</Link>
                          : Array.isArray(v) ? v.join(", ") : String(v)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
