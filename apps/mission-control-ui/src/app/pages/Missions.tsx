import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiAdmin } from "../../api";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type { MissionRow, RoutingProjection } from "../types";

/* P15.9-B5.3 — Mission Operations list. GET /api/missions is a GLOBAL
   unfiltered listing — never presented as business-scoped. Routing is an
   independent read: unavailable is disclosed, never rendered as zero. */

type St =
  | { kind: "loading" }
  | {
      kind: "ready";
      missions: MissionRow[];
      routing: RoutingProjection | null;
      routingErr: string | null;
    }
  | { kind: "error"; err: ApiError };

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "ABORTED"]);

export function Missions() {
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    setSt({ kind: "loading" });
    (async () => {
      const [mR, rR] = await Promise.allSettled([
        apiAdmin.missions(ctl.signal),
        apiAdmin.routing(ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      /* primary read: envelope AND elements — each row needs a mission_id;
         malformed → fatal, never a fabricated empty list */
      if (mR.status === "rejected") {
        const e = mR.reason;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      const mv = mR.value;
      if (mv === null || typeof mv !== "object" || !Array.isArray(mv.missions)
        || !mv.missions.every((m) => m !== null && typeof m === "object" && m.mission_id != null)) {
        setSt({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/missions returned a malformed payload") });
        return;
      }
      /* routing is a secondary read: any failure → disclosed, never 0 */
      const rv = rR.status === "fulfilled" ? rR.value : null;
      const routingOk = rv !== null && typeof rv === "object" && Array.isArray(rv.routable);
      setSt({
        kind: "ready",
        missions: mv.missions,
        routing: routingOk ? rv : null,
        routingErr: rR.status === "rejected"
          ? (rR.reason instanceof ApiError ? rR.reason.code : "ERROR")
          : !routingOk ? "MALFORMED" : null,
      });
    })();
    return () => ctl.abort();
  }, []);

  const list = useMemo(() => {
    if (st.kind !== "ready") return [];
    let xs = st.missions;
    if (q) {
      const s = q.toLowerCase();
      xs = xs.filter((m) =>
        String(m.mission_id).toLowerCase().includes(s) || String(m.goal ?? "").toLowerCase().includes(s));
    }
    if (stateFilter) xs = xs.filter((m) => String(m.runtime_state ?? m.state ?? "") === stateFilter);
    return [...xs].sort((a, b) =>
      sortDesc
        ? String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
        : String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  }, [st, q, stateFilter, sortDesc]);

  if (st.kind === "error") return <ErrorState code={st.err.code} detail={st.err.detail} />;
  if (st.kind === "loading") {
    return <div className="page"><h1>Mission Operations</h1><Skeleton height={18} /><Skeleton height={200} /></div>;
  }

  const all = st.missions;
  const running = all.filter((m) => m.runtime_state === "RUNNING");
  const finished = all.filter((m) => TERMINAL.has(String(m.runtime_state ?? m.state ?? "")));
  const states = [...new Set(all.map((m) => String(m.runtime_state ?? m.state ?? "")).filter(Boolean))].sort();
  const routable = st.routing ? st.routing.routable.filter((r) => r.routable === true).length : null;

  return (
    <div className="page">
      <h1>Mission Operations</h1>
      <p className="sub srcnote">
        <code>GET /api/missions</code> is a <strong>global, unfiltered listing</strong> — every mission
        on this server. It is NOT scoped to the selected business and the page does not manufacture a
        business filter from goal text or unverified metadata.
      </p>

      <div className="need" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="nrow"><span className="tt">Running</span><strong>{running.length}</strong></div>
        <div className="nrow"><span className="tt">Finished</span><strong>{finished.length}</strong></div>
        <div className="nrow">
          <span className="tt">Routable executors</span>
          {routable === null ? (
            <span className="note">unavailable ({st.routingErr}) — not shown as zero</span>
          ) : (
            <strong>{routable}</strong>
          )}
        </div>
        <div className="nrow">
          <Link className="lnk" to="/app/missions/new">+ New mission (Task Entry)</Link>
        </div>
      </div>

      <div className="need">
        <div className="nrow" style={{ gap: 8 }}>
          <input className="inp" aria-label="search missions" placeholder="search mission_id or goal…"
            value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
          <select className="inp" aria-label="filter runtime state" value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">all runtime states</option>
            {states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="tbtn" onClick={() => setSortDesc((v) => !v)} aria-label="toggle sort">
            {sortDesc ? "newest first" : "oldest first"}
          </button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState title="No missions" detail="The global listing returned zero missions — create one via Task Entry (+ New mission above)." />
      ) : list.length === 0 ? (
        <EmptyState title="No matching missions" detail="Search/filter returned zero rows — the global list itself is non-empty." />
      ) : (
        <div className="need">
          {list.map((m) => {
            const rt = String(m.runtime_state ?? "");
            return (
              <div className="nrow" key={String(m.mission_id)}>
                <Link className="lnk mono" to={`/app/missions/${encodeURIComponent(String(m.mission_id))}`}>
                  {String(m.mission_id).slice(0, 22)}
                </Link>
                <span className="tt" style={{ flex: 1, minWidth: 120 }}>{String(m.goal ?? "")}</span>
                {m.state || m.status ? <StatusBadge tone="info" label={String(m.state ?? m.status)} /> : null}
                <StatusBadge
                  tone={rt === "RUNNING" ? "purple" : TERMINAL.has(rt) ? (rt === "COMPLETED" ? "ok" : "danger") : "info"}
                  label={rt || "—"}
                />
                <span className="note">{String(m.created_at ?? "").replace("T", " ").slice(0, 19)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
