import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { useEventBuffer, useLiveRefresh, streamStatus, onStreamStatus } from "../hooks/eventBus";
import { StateBadge } from "../components/Badge";

type Tab = "events" | "routing" | "recovery" | "evidence";

function fmt(o: unknown, n = 120) {
  const s = typeof o === "string" ? o : JSON.stringify(o);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function Observability() {
  const [tab, setTab] = useState<Tab>("events");
  const [live, setLive] = useState(streamStatus());
  useEffect(() => onStreamStatus(setLive), []);
  return (
    <div className="page">
      <h1>
        Observability{" "}
        <span className={`badge ${live === "open" ? "b-ok" : "b-fail"}`}>
          {live === "open" ? "live" : "reconnecting"}
        </span>
      </h1>
      <div className="tabs">
        {(["events", "routing", "recovery", "evidence"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "events" ? "Event stream" : t === "routing" ? "Routing decisions" : t === "recovery" ? "Recovery decisions" : "Evidence"}
          </button>
        ))}
      </div>
      {tab === "events" && <EventStream />}
      {tab === "routing" && <RoutingExplorer />}
      {tab === "recovery" && <RecoveryExplorer />}
      {tab === "evidence" && <EvidenceExplorer />}
    </div>
  );
}

/* Canonical entity-event journal — live via /api/events (hash-verified rows). */
function EventStream() {
  const events = useEventBuffer();
  const [filter, setFilter] = useState("");
  const rows = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((e) => !filter || e.entity_type.includes(filter) || e.event_type.includes(filter) || e.entity_id.includes(filter)),
    [events, filter],
  );
  return (
    <section>
      <input className="filter" placeholder="filter entity/type/id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <table className="tbl">
        <thead><tr><th>seq</th><th>entity</th><th>event</th><th>new state</th><th>actor</th><th>at</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.event_id}>
              <td className="muted">{e.seq}</td>
              <td className="mono">{e.entity_type}:{String(e.entity_id).slice(0, 16)}</td>
              <td>{e.event_type}</td>
              <td><StateBadge state={e.new_state ?? ""} /></td>
              <td className="muted">{e.actor ?? "—"}</td>
              <td className="muted">{String(e.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="state empty">No events yet — run a mission.</div>}
    </section>
  );
}

function RoutingExplorer() {
  const q = useApi(() => api.routes());
  useLiveRefresh(q.reload);
  const decisions = (q.data?.routing_decisions ?? []) as Array<Record<string, unknown>>;
  const routeDecisions = (q.data?.route_decisions ?? []) as Array<Record<string, unknown>>;
  return (
    <section>
      <h2>Routing decisions ({decisions.length})</h2>
      <table className="tbl">
        <thead><tr><th>mission/task</th><th>executor</th><th>rejected executors</th><th>at</th></tr></thead>
        <tbody>
          {decisions.map((d, i) => (
            <tr key={i}>
              <td className="mono muted">{fmt(d.task_id ?? d.mission_id ?? "—", 40)}</td>
              <td className="mono">{fmt(d.executor_id ?? d.chosen_executor ?? "—")}</td>
              <td className="muted">{fmt(d.rejected_executors ?? d.rejected ?? "—", 160)}</td>
              <td className="muted">{String(d.created_at ?? "").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Route decisions ({routeDecisions.length})</h2>
      <table className="tbl">
        <thead><tr><th>route</th><th>decision</th><th>reason codes</th><th>hard rejections</th><th>at</th></tr></thead>
        <tbody>
          {routeDecisions.map((d, i) => (
            <tr key={i}>
              <td className="mono">{fmt(d.route_id ?? d.binding_id ?? "—", 40)}</td>
              <td>{fmt(d.decision ?? d.outcome ?? "—")}</td>
              <td className="muted">{fmt(d.reason_codes ?? "—", 140)}</td>
              <td className="muted">{fmt(d.hard_rejections ?? "—", 140)}</td>
              <td className="muted">{String(d.created_at ?? "").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {decisions.length + routeDecisions.length === 0 && <div className="state empty">No routing decisions recorded yet.</div>}
    </section>
  );
}

function RecoveryExplorer() {
  const q = useApi(() => api.recovery());
  useLiveRefresh(q.reload);
  const decisions = ((q.data?.decisions ?? []) as Array<Record<string, unknown>>);
  const attempts = ((q.data?.attempts ?? []) as Array<Record<string, unknown>>);
  const scheduled = ((q.data?.scheduled ?? []) as Array<Record<string, unknown>>);
  return (
    <section>
      <h2>Recovery decisions ({decisions.length})</h2>
      <table className="tbl">
        <thead><tr><th>mission</th><th>classification</th><th>action</th><th>detail</th><th>at</th></tr></thead>
        <tbody>
          {decisions.map((d, i) => (
            <tr key={i}>
              <td className="mono muted">{fmt(d.mission_id ?? "—", 30)}</td>
              <td>{fmt(d.classification ?? d.failure_class ?? "—", 60)}</td>
              <td><StateBadge state={String(d.action ?? d.decision ?? "—")} /></td>
              <td className="muted">{fmt(d.reason ?? d.detail ?? "—", 120)}</td>
              <td className="muted">{String(d.created_at ?? "").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Attempts ({attempts.length}) · Scheduled backoff ({scheduled.length})</h2>
      <table className="tbl">
        <thead><tr><th>type</th><th>action</th><th>status</th><th>run at</th></tr></thead>
        <tbody>
          {scheduled.map((s, i) => (
            <tr key={i}>
              <td className="mono">{fmt(s.action_type ?? s.kind ?? "—", 40)}</td>
              <td className="muted">{fmt(s.action ?? s.payload ?? "—", 100)}</td>
              <td><StateBadge state={String(s.status ?? "—")} /></td>
              <td className="muted">{String(s.run_at ?? s.not_before ?? s.created_at ?? "").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {decisions.length + attempts.length + scheduled.length === 0 && <div className="state empty">No recovery activity yet.</div>}
    </section>
  );
}

function EvidenceExplorer() {
  const missions = useApi(() => api.missions());
  const [missionId, setMissionId] = useState("");
  const ev = useApi(
    () => (missionId ? api.evidence(missionId) : Promise.resolve([])),
    [missionId],
    0,
  );
  useLiveRefresh(ev.reload);
  const list = missions.data?.missions ?? [];
  useEffect(() => {
    if (!missionId && list.length) setMissionId(String(list[0].mission_id));
  }, [list, missionId]);
  const rows = (ev.data ?? []) as Array<Record<string, unknown>>;
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ mission_id: missionId, evidence: rows }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `evidence-${missionId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section>
      <div className="row">
        <select value={missionId} onChange={(e) => setMissionId(e.target.value)}>
          {list.map((m) => (
            <option key={m.mission_id} value={m.mission_id}>{String(m.mission_id).slice(0, 24)} — {String(m.goal).slice(0, 40)}</option>
          ))}
        </select>
        <button disabled={!rows.length} onClick={exportJson}>Export evidence JSON</button>
      </div>
      <table className="tbl">
        <thead><tr><th>kind</th><th>payload</th><th>hash</th><th>at</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{fmt(r.kind ?? r.evidence_kind ?? "—", 50)}</td>
              <td className="muted">{fmt(r.payload ?? r, 160)}</td>
              <td className="mono muted">{fmt(r.evidence_hash ?? r.hash ?? "—", 20)}</td>
              <td className="muted">{String(r.created_at ?? "").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missionId && rows.length === 0 && <div className="state empty">No evidence for this mission.</div>}
    </section>
  );
}
