import { useApi } from "../hooks/useApi";
import { api } from "../api";

type Row = Record<string, unknown>;

function GateTable({ gates }: { gates: Record<string, string> }) {
  return (
    <div className="gates">
      {Object.entries(gates).map(([g, v]) => (
        <span key={g} className={`gate ${v === "PASS" ? "pass" : "fail"}`} title={g}>
          {g.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

export function Providers() {
  const providers = useApi(() => api.providers(), [], 5000);
  const models = useApi(() => api.models(), [], 5000);
  const routes = useApi(() => api.routes(), [], 5000);

  if (providers.loading && !providers.data) return <div className="state">Loading…</div>;
  if (providers.error) return <div className="state err">{String(providers.error)}</div>;

  const provs = (providers.data?.providers ?? []) as Row[];
  const mods = (models.data?.models ?? []) as Row[];
  const routable = (routes.data?.routable_models ?? []) as Row[];
  const decisions = (routes.data?.routing_decisions ?? []) as Row[];

  return (
    <div className="page">
      <h1>Providers &amp; models</h1>

      <section>
        <h2>Providers</h2>
        {provs.length === 0 ? (
          <div className="state empty">No providers discovered yet. Providers appear after governed executor registration.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Provider</th><th>Lifecycle</th><th>Auth</th><th>Credential</th><th>Health</th></tr></thead>
            <tbody>
              {provs.map((p) => (
                <tr key={String(p.provider_id)}>
                  <td className="mono">{String(p.provider_id)}</td>
                  <td>{String(p.lifecycle_state ?? "—")}</td>
                  <td>{String(p.auth_state ?? "—")}</td>
                  <td>
                    <span className={`cred ${p.credential_status === "configured" ? "ok" : "no"}`}>
                      {String(p.credential_status ?? "unavailable")}
                    </span>
                    {p.credential_reference_name ? (
                      <span className="muted mono"> ({String(p.credential_reference_name)})</span>
                    ) : null}
                  </td>
                  <td>{String(p.health_state ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Models</h2>
        {mods.length === 0 ? (
          <div className="state empty">No model entries yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Model</th><th>Family</th><th>Lifecycle</th><th>Conditions</th></tr></thead>
            <tbody>
              {mods.map((m) => (
                <tr key={String(m.model_entry_id)}>
                  <td className="mono">{String(m.model_id)}</td>
                  <td className="mono">{String(m.provider_family)}</td>
                  <td>{String(m.lifecycle_state ?? "—")}</td>
                  <td className="muted">{Array.isArray(m.conditions) ? (m.conditions as string[]).join(", ") || "—" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Route bindings — why a route is or isn't usable</h2>
        {routable.length === 0 ? (
          <div className="state empty">No model bindings. A binding becomes routable when executor, provider, and model gates all pass.</div>
        ) : (
          routable.map((r) => (
            <div key={String(r.binding_id)} className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ margin: "0 0 6px" }}>
                <span className="mono">{String(r.provider_id)} → {String(r.executor_id)}</span>
                <span className={`badge ${r.routable ? "b-ok" : "b-bad"}`}>{r.routable ? "ROUTABLE" : "NOT ROUTABLE"}</span>
              </div>
              <GateTable gates={(r.gates ?? {}) as Record<string, string>} />
              {r.reason_not_routable ? <p className="muted">first failing gate: <b>{String(r.reason_not_routable)}</b></p> : null}
            </div>
          ))
        )}
      </section>

      <section>
        <h2>Recent routing decisions</h2>
        {decisions.length === 0 ? (
          <div className="state empty">No routing decisions yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Decision</th><th>Selected</th><th>Rejected executors</th><th>At</th></tr></thead>
            <tbody>
              {decisions.slice(-20).reverse().map((d) => (
                <tr key={String(d.routing_decision_id ?? d.entity_id)}>
                  <td className="mono">{String(d.routing_decision_id ?? d.entity_id).slice(0, 22)}</td>
                  <td>{String(d.selected_executor ?? "—")}</td>
                  <td className="muted mono">{JSON.stringify(d.rejected_executors ?? d.rejected ?? []).slice(0, 140)}</td>
                  <td className="muted">{String(d.decided_at ?? d.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
