import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { StateBadge } from "../components/Badge";

export function Dashboard() {
  const health = useApi(() => api.health());
  const missions = useApi(() => api.missions());
  const routing = useApi(() => api.routing());

  if (missions.loading && !missions.data) return <div className="state">Loading…</div>;
  if (missions.error) return <div className="state err">{String(missions.error)}</div>;

  const list = missions.data?.missions ?? [];
  const running = list.filter((m) => m.runtime_state === "RUNNING");
  const finished = list.filter((m) => ["COMPLETED", "FAILED", "CANCELLED", "ABORTED"].includes(String(m.runtime_state ?? m.state)));

  return (
    <div className="page">
      <h1>Dashboard</h1>

      <section className="cards">
        <div className="card"><div className="k">Missions running</div><div className="v">{running.length}</div></div>
        <div className="card"><div className="k">Missions finished</div><div className="v">{finished.length}</div></div>
        <div className="card"><div className="k">Routable executors</div><div className="v">{(routing.data?.routable ?? []).length}</div></div>
        <div className="card"><div className="k">Approvals pending</div><div className="v">{String((health.data as Record<string, unknown>)?.approvals_pending ?? "—")}</div></div>
      </section>

      <section>
        <h2>Missions</h2>
        {list.length === 0 ? (
          <div className="state empty">No missions yet. <Link to="/missions/new">Create the first mission →</Link></div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Mission</th><th>Goal</th><th>State</th><th>Runtime</th><th>Created</th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.mission_id}>
                  <td><Link to={`/missions/${m.mission_id}`} className="mono">{String(m.mission_id).slice(0, 18)}…</Link></td>
                  <td className="goal">{m.goal}</td>
                  <td><StateBadge state={m.state as string} /></td>
                  <td><StateBadge state={m.runtime_state} /></td>
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
            {(routing.data?.executors ?? []).map((e) => (
              <tr key={String(e.executor_id ?? e.entity_id)}>
                <td className="mono">{String(e.executor_id ?? e.entity_id)}</td>
                <td>{String(e.executor_type ?? "")}</td>
                <td>{String(e.health_state ?? "—")}</td>
                <td>{String((e.qualification_state as string) ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
