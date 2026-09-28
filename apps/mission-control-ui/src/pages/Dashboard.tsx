import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { useLiveRefresh } from "../hooks/eventBus";
import { StateBadge } from "../components/Badge";

export function Dashboard() {
  const missions = useApi(() => api.missions());
  const routing = useApi(() => api.routing());
  const cost = useApi(() => api.cost());
  const approvals = useApi(() => api.approvals());
  useLiveRefresh(missions.reload);
  useLiveRefresh(routing.reload);
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [sortDesc, setSortDesc] = useState(true);

  const list = useMemo(() => {
    let xs = (missions.data?.missions ?? []) as Array<Record<string, unknown>>;
    if (q) {
      const s = q.toLowerCase();
      xs = xs.filter(
        (m) =>
          String(m.mission_id).toLowerCase().includes(s) ||
          String(m.goal).toLowerCase().includes(s),
      );
    }
    if (stateFilter) {
      xs = xs.filter((m) => String(m.runtime_state ?? m.state) === stateFilter);
    }
    return [...xs].sort((a, b) =>
      sortDesc
        ? String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
        : String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
  }, [missions.data, q, stateFilter, sortDesc]);
  const all = (missions.data?.missions ?? []) as Array<Record<string, unknown>>;

  if (missions.loading && !missions.data) return <div className="state">Loading…</div>;
  if (missions.error) return <div className="state err">{String(missions.error)}</div>;
  const running = all.filter((m) => m.runtime_state === "RUNNING");
  const finished = all.filter((m) => ["COMPLETED", "FAILED", "CANCELLED", "ABORTED"].includes(String(m.runtime_state ?? m.state)));

  return (
    <div className="page">
      <h1>Dashboard</h1>

      <section className="cards">
        <div className="card"><div className="k">Missions running</div><div className="v">{running.length}</div></div>
        <div className="card"><div className="k">Missions finished</div><div className="v">{finished.length}</div></div>
        <div className="card"><div className="k">Routable executors</div><div className="v">{(routing.data?.routable ?? []).filter((r) => r.routable === true).length}</div></div>
        <div className="card"><div className="k">Approvals pending</div><div className="v">{approvals.data ? approvals.data.length : "—"}</div></div>
        <div className="card" title="Remote Devin dispatches today vs the PAIR_MAX_REMOTE_TASKS_PER_DAY cap">
          <div className="k">Remote spend (today)</div>
          <div className="v">
            {cost.data ? `${cost.data.remote_dispatches_today}/${cost.data.remote_daily_limit}` : "—"}
            {cost.data?.cost_halt && <span className="badge st-failed" style={{ marginLeft: 6 }}>HALT</span>}
          </div>
        </div>
      </section>

      <section>
        <div className="row">
          <h2 style={{ margin: 0 }}>Missions</h2>
          <input className="filter" placeholder="search id/goal…" aria-label="search missions" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="inline" aria-label="filter state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">all states</option>
            {[...new Set(all.map((m) => String(m.runtime_state ?? m.state ?? "")))].filter(Boolean).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button className="ghost" onClick={() => setSortDesc((v) => !v)} aria-label="toggle sort">
            {sortDesc ? "newest first" : "oldest first"}
          </button>
        </div>
        {list.length === 0 ? (
          <div className="state empty">No missions yet. <Link to="/missions/new">Create the first mission →</Link></div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Mission</th><th>Goal</th><th>State</th><th>Runtime</th><th>Created</th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={String(m.mission_id)}>
                  <td><Link to={`/missions/${String(m.mission_id)}`} className="mono">{String(m.mission_id).slice(0, 18)}…</Link></td>
                  <td className="goal">{String(m.goal)}</td>
                  <td><StateBadge state={String(m.state ?? m.status ?? "")} /></td>
                  <td><StateBadge state={String(m.runtime_state ?? "")} /></td>
                  <td className="muted">{String(m.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Executors</h2>
        <table className="tbl">
          <thead><tr><th>Executor</th><th>Type</th><th>Health</th><th>Qualification</th></tr></thead>
          <tbody>
            {(routing.data?.executors ?? []).map((e) => {
              const desc = (e.descriptor ?? {}) as Record<string, unknown>;
              const meta = (e.metadata ?? {}) as Record<string, unknown>;
              const qual = e.qualification_state ?? desc.qualification_state ?? meta.qualification_state;
              const reasons = ((meta.qualification ?? {}) as Record<string, unknown>).reasons;
              return (
                <tr key={String(e.executor_id ?? e.entity_id)}>
                  <td className="mono">{String(e.executor_id ?? e.entity_id)}</td>
                  <td>{String(e.executor_type ?? "")}</td>
                  <td>{String(e.health_state ?? "—")}</td>
                  <td title={Array.isArray(reasons) ? reasons.join("; ") : undefined}>{String(qual ?? "—")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
