import { useEffect, useState } from "react";
import { ApiError, apiAdmin } from "../../api";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";

/* P15.9-B5.5 Scope A — Providers & Models. READ-ONLY: no provider/model/
   route registration or mutation, no credential upsert, no synthetic
   routability. Every section is an independent canonical read with its
   own loading/error state — a failed read never fabricates empty data
   in the other sections, and UNKNOWN/missing gate evidence is never
   displayed as PASS. All endpoints are GLOBAL, unfiltered listings. */

type Row = Record<string, unknown>;
type Sec<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; err: ApiError };

const isObj = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const errOf = (e: unknown): ApiError =>
  e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));

function GateTable({ gates }: { gates: Row }) {
  return (
    <div className="gates">
      {Object.entries(gates).map(([g, v]) => (
        <span
          key={g}
          className={`gate ${v === "PASS" ? "pass" : "fail"}`}
          title={`${g}: ${String(v)}`}
        >
          {g.replace(/_/g, " ")}: {String(v)}
        </span>
      ))}
    </div>
  );
}

export function SystemProviders() {
  const [prov, setProv] = useState<Sec<Row[]>>({ kind: "loading" });
  const [quals, setQuals] = useState<Row[]>([]);
  const [mods, setMods] = useState<Sec<Row[]>>({ kind: "loading" });
  const [routes, setRoutes] = useState<Sec<{ routable: Row[]; decisions: Row[] }>>({ kind: "loading" });

  useEffect(() => {
    const ctl = new AbortController();
    apiAdmin.providers(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.providers) || !r.providers.every(isObj)) {
          setProv({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/providers returned a malformed providers collection") });
          return;
        }
        setQuals(Array.isArray(r.qualifications) ? r.qualifications.filter(isObj) : []);
        setProv({ kind: "ready", data: r.providers });
      })
      .catch((e) => !ctl.signal.aborted && setProv({ kind: "error", err: errOf(e) }));
    apiAdmin.models(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.models) || !r.models.every(isObj)) {
          setMods({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/models returned a malformed models collection") });
          return;
        }
        setMods({ kind: "ready", data: r.models });
      })
      .catch((e) => !ctl.signal.aborted && setMods({ kind: "error", err: errOf(e) }));
    apiAdmin.routes(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.routable_models) || !r.routable_models.every(isObj)
          || !Array.isArray(r.routing_decisions) || !r.routing_decisions.every(isObj)) {
          setRoutes({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/routes returned a malformed payload") });
          return;
        }
        setRoutes({ kind: "ready", data: { routable: r.routable_models, decisions: r.routing_decisions } });
      })
      .catch((e) => !ctl.signal.aborted && setRoutes({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, []);

  return (
    <div className="page">
      <h1>Providers &amp; Models</h1>
      <p className="sub srcnote">
        <code>GET /api/providers · /api/models · /api/routes</code> — <strong>global, unfiltered</strong>
        reads. Credential state is configuration metadata, never proof a model is routable — and never
        a secret value.
      </p>

      <section className="need" aria-label="provider catalog">
        <h2>Provider catalog</h2>
        {prov.kind === "loading" ? <Skeleton height={80} /> : prov.kind === "error" ? (
          <ErrorState code={prov.err.code} detail={prov.err.detail} />
        ) : prov.data.length === 0 ? (
          <EmptyState title="No providers" detail="The canonical provider registry is empty — providers appear after governed executor registration." />
        ) : (
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Provider</th><th>Lifecycle</th><th>Auth</th><th>Credential</th><th>Health</th><th>Qualification</th></tr></thead>
            <tbody>
              {prov.data.map((p) => {
                const q = quals.filter((x) => String(x.provider_id) === String(p.provider_id));
                return (
                  <tr key={String(p.provider_id)}>
                    <td className="mono">{String(p.provider_id)}</td>
                    <td>{String(p.lifecycle_state ?? "—")}</td>
                    <td>{String(p.auth_state ?? "—")}</td>
                    <td>
                      <StatusBadge
                        tone={p.credential_status === "configured" ? "ok" : "unknown"}
                        label={String(p.credential_status ?? "unavailable")}
                        title="credential configuration metadata — not routability evidence"
                      />
                      {p.credential_reference_name ? (
                        <span className="muted mono"> ({String(p.credential_reference_name)})</span>
                      ) : null}
                    </td>
                    <td>{String(p.health_state ?? "—")}</td>
                    <td className="muted">
                      {q.length === 0 ? "—" : q.map((x, i) => (
                        <span key={i}>{String(x.state ?? x.qualification ?? x.status ?? "?")} </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="need" aria-label="model catalog">
        <h2>Model catalog</h2>
        {mods.kind === "loading" ? <Skeleton height={80} /> : mods.kind === "error" ? (
          <ErrorState code={mods.err.code} detail={mods.err.detail} />
        ) : mods.data.length === 0 ? (
          <EmptyState title="No model entries" detail="The canonical model registry is empty." />
        ) : (
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Model</th><th>Family</th><th>Lifecycle</th><th>Role</th><th>Conditions</th></tr></thead>
            <tbody>
              {mods.data.map((m) => (
                <tr key={String(m.model_entry_id ?? m.model_id)}>
                  <td className="mono">{String(m.model_id ?? m.model_entry_id)}</td>
                  <td className="mono">{String(m.provider_family ?? "—")}</td>
                  <td>{String(m.lifecycle_state ?? "—")}</td>
                  <td className="mono">{m.model_role != null ? String(m.model_role) : "—"}</td>
                  <td className="muted">{Array.isArray(m.conditions) ? (m.conditions as string[]).join(", ") || "—" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="need" aria-label="route bindings">
        <h2>Route bindings — canonical gate evidence</h2>
        {routes.kind === "loading" ? <Skeleton height={80} /> : routes.kind === "error" ? (
          <ErrorState code={routes.err.code} detail={routes.err.detail} />
        ) : routes.data.routable.length === 0 ? (
          <EmptyState title="No bindings" detail="No model bindings — a binding is routable only when executor, provider and model gates all pass." />
        ) : (
          routes.data.routable.map((r, i) => (
            <div key={String(r.binding_id ?? i)} className="nrow" style={{ display: "block" }}>
              <div className="row" style={{ margin: "0 0 6px" }}>
                <span className="mono">{String(r.provider_id ?? "?")} → {String(r.executor_id ?? "?")}</span>
                <StatusBadge
                  tone={r.routable === true ? "ok" : "danger"}
                  label={r.routable === true ? "ROUTABLE" : "NOT ROUTABLE"}
                />
              </div>
              {isObj(r.gates) && Object.keys(r.gates).length > 0 ? (
                <GateTable gates={r.gates} />
              ) : (
                <p className="muted">no gate evidence — never displayed as PASS</p>
              )}
              {r.reason_not_routable ? (
                <p className="muted">first failing gate: <b>{String(r.reason_not_routable)}</b></p>
              ) : null}
            </div>
          ))
        )}
      </section>

      <section className="need" aria-label="routing decisions">
        <h2>Recent routing decisions</h2>
        {routes.kind === "loading" ? <Skeleton height={60} /> : routes.kind === "error" ? null : routes.data.decisions.length === 0 ? (
          <EmptyState title="No routing decisions" detail="No executor routing decisions recorded yet." />
        ) : (
          <>
            <p className="sub srcnote">bounded subset — latest {Math.min(20, routes.data.decisions.length)} of {routes.data.decisions.length} recorded</p>
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>Decision</th><th>Selected executor</th><th>Rejected</th><th>At</th></tr></thead>
              <tbody>
                {routes.data.decisions.slice(-20).reverse().map((d, i) => (
                  <tr key={String(d.routing_decision_id ?? d.entity_id ?? i)}>
                    <td className="mono">{String(d.routing_decision_id ?? d.entity_id ?? "—").slice(0, 22)}</td>
                    <td>{String(d.selected_executor ?? d.executor_id ?? "—")}</td>
                    <td className="muted mono">{JSON.stringify(d.rejected_executors ?? d.rejected ?? []).slice(0, 140)}</td>
                    <td className="muted">{String(d.decided_at ?? d.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </section>
    </div>
  );
}
