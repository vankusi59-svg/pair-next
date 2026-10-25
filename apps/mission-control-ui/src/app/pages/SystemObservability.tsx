import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiAdmin } from "../../api";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import {
  useEventBuffer, useLiveRefresh, streamStatus, onStreamStatus,
} from "../../hooks/eventBus";

/* P15.9-B5.5 Scope B — Observability. /api/events is a GLOBAL technical
   event stream — NOT a business-scoped company activity feed, and it is
   never injected into /app/company. All reads reuse the canonical
   endpoints; stale responses are pinned by request identity. */

type Row = Record<string, unknown>;
type Tab = "events" | "routing" | "recovery" | "evidence" | "operations";
type Sec<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; err: ApiError };

const isObj = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const errOf = (e: unknown): ApiError =>
  e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));
const fmt = (o: unknown, n = 120) => {
  const s = typeof o === "string" ? o : JSON.stringify(o);
  return s == null ? "—" : s.length > n ? s.slice(0, n) + "…" : s;
};

function SecError({ sec }: { sec: Sec<unknown> }) {
  return sec.kind === "error" ? <ErrorState code={sec.err.code} detail={sec.err.detail} /> : null;
}

function EventStream() {
  const events = useEventBuffer();
  const [live, setLive] = useState(streamStatus());
  const [filter, setFilter] = useState("");
  useEffect(() => onStreamStatus(setLive), []);
  const rows = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((e) => !filter
          || e.entity_type?.includes(filter)
          || e.event_type?.includes(filter)
          || e.entity_id?.includes(filter)),
    [events, filter],
  );
  return (
    <section className="need" aria-label="global event stream">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <input className="filter inp" placeholder="filter entity/type/id…" aria-label="filter events"
          value={filter} onChange={(e) => setFilter(e.target.value)} />
        <StatusBadge
          tone={live === "open" ? "ok" : "danger"}
          label={live === "open" ? "live" : "reconnecting"}
          title="SSE stream state — 'reconnecting' means the browser is retrying; an empty list then is NOT proof of no activity"
        />
      </div>
      <p className="sub srcnote">
        <strong>global system event stream</strong> — technical entity events, not the
        business-scoped Company Activity Feed. Bounded client buffer ({events.length} held).
      </p>
      {rows.length === 0 ? (
        live === "open" ? (
          <EmptyState title="No events" detail="Stream is connected and the buffer is genuinely empty — no system events received yet." />
        ) : (
          <ErrorState code="STREAM_DISCONNECTED" detail="Event stream is not connected — the empty list is not evidence of no system activity." />
        )
      ) : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>seq</th><th>entity</th><th>event</th><th>new state</th><th>actor</th><th>at</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.event_id}>
                <td className="muted">{e.seq ?? "—"}</td>
                <td className="mono">{e.entity_type}:{String(e.entity_id).slice(0, 16)}</td>
                <td>{e.event_type}</td>
                <td className="mono">{e.new_state ?? "—"}</td>
                <td className="muted">{e.actor ?? "—"}</td>
                <td className="muted">{String(e.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function RoutingExplorer() {
  const [sec, setSec] = useState<Sec<{ decisions: Row[]; routeDecisions: Row[] }>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((t) => t + 1));
  useEffect(() => {
    const ctl = new AbortController();
    setSec({ kind: "loading" });
    apiAdmin.routes(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.routing_decisions) || !r.routing_decisions.every(isObj)
          || !Array.isArray(r.route_decisions) || !r.route_decisions.every(isObj)) {
          setSec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/routes returned a malformed payload") });
          return;
        }
        setSec({ kind: "ready", data: { decisions: r.routing_decisions, routeDecisions: r.route_decisions } });
      })
      .catch((e) => !ctl.signal.aborted && setSec({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, [tick]);
  if (sec.kind === "loading") return <section className="need"><Skeleton height={120} /></section>;
  if (sec.kind === "error") return <section className="need"><SecError sec={sec} /></section>;
  const { decisions, routeDecisions } = sec.data;
  return (
    <section className="need" aria-label="routing explorer">
      <h2>Routing decisions ({decisions.length})</h2>
      {decisions.length === 0 && routeDecisions.length === 0 ? (
        <EmptyState title="No routing decisions" detail="The canonical routing projection is empty." />
      ) : (
        <>
          <div className="tbl-wrap"><table className="tbl">
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
          </table></div>
          <h2>Route decisions ({routeDecisions.length})</h2>
          <div className="tbl-wrap"><table className="tbl">
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
          </table></div>
        </>
      )}
    </section>
  );
}

function RecoveryExplorer() {
  const [sec, setSec] = useState<Sec<{ decisions: Row[]; attempts: Row[]; scheduled: Row[] }>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((t) => t + 1));
  useEffect(() => {
    const ctl = new AbortController();
    setSec({ kind: "loading" });
    apiAdmin.recovery(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.decisions) || !r.decisions.every(isObj)
          || !Array.isArray(r.attempts) || !r.attempts.every(isObj)
          || !Array.isArray(r.scheduled) || !r.scheduled.every(isObj)) {
          setSec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/recovery returned a malformed payload") });
          return;
        }
        setSec({ kind: "ready", data: { decisions: r.decisions, attempts: r.attempts, scheduled: r.scheduled } });
      })
      .catch((e) => !ctl.signal.aborted && setSec({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, [tick]);
  if (sec.kind === "loading") return <section className="need"><Skeleton height={120} /></section>;
  if (sec.kind === "error") return <section className="need"><SecError sec={sec} /></section>;
  const { decisions, attempts, scheduled } = sec.data;
  return (
    <section className="need" aria-label="recovery explorer">
      <h2>Recovery decisions ({decisions.length})</h2>
      <p className="sub srcnote">recovery scheduler actions — <strong>not</strong> operator mission schedules.</p>
      {decisions.length + attempts.length + scheduled.length === 0 ? (
        <EmptyState title="No recovery activity" detail="The canonical recovery projection is empty." />
      ) : (
        <>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>mission</th><th>classification</th><th>action</th><th>detail</th><th>at</th></tr></thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={i}>
                  <td className="mono muted">{fmt(d.mission_id ?? "—", 30)}</td>
                  <td>{fmt(d.classification ?? d.failure_class ?? "—", 60)}</td>
                  <td className="mono">{fmt(d.action ?? d.decision ?? "—")}</td>
                  <td className="muted">{fmt(d.reason ?? d.detail ?? "—", 120)}</td>
                  <td className="muted">{String(d.created_at ?? "").slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <h2>Attempts ({attempts.length}) · Scheduled backoff ({scheduled.length})</h2>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>type</th><th>action</th><th>status</th><th>run at</th></tr></thead>
            <tbody>
              {scheduled.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{fmt(s.action_type ?? s.kind ?? "—", 40)}</td>
                  <td className="muted">{fmt(s.action ?? s.payload ?? "—", 100)}</td>
                  <td className="mono">{fmt(s.status ?? "—")}</td>
                  <td className="muted">{String(s.run_at ?? s.not_before ?? s.created_at ?? "").slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}
    </section>
  );
}

/* P18.4-B — /api/operations rollup: bounded aggregate counts over
   canonical rows. Order is the operator's "what needs attention"
   reading — mission pressure, collection/settlement debt, recovery
   backlog, open barriers, approvals, liveness incident classes. */
const OPS_COUNTS: Array<[string, string]> = [
  ["missions_running", "missions running"],
  ["missions_paused", "missions paused"],
  ["executions_awaiting_collection", "executions awaiting collection"],
  ["executions_committed_unsettled", "executions committed unsettled"],
  ["recoveries_active", "recoveries active"],
  ["recoveries_deferred", "recoveries deferred"],
  ["reconciliation_barriers_open", "reconciliation barriers open"],
  ["approvals_pending", "approvals pending"],
  ["executions_orphan_unobservable", "executions orphan-unobservable"],
  ["executions_never_observed", "executions never observed"],
  ["recovery_blocked_or_escalated", "recovery blocked/escalated"],
  ["work_items_blocked", "work items blocked"],
];
/* Canonical latency chain (persisted timestamps only):
   dispatch → terminal-observed → collect-commit → settled. */
const OPS_LIVENESS: Array<[string, string]> = [
  ["liveness_detect_ms_p50", "detect p50"],
  ["liveness_detect_ms_p95", "detect p95"],
  ["liveness_collect_ms_p50", "collect p50"],
  ["liveness_collect_ms_p95", "collect p95"],
  ["liveness_settle_ms_p50", "settle p50"],
  ["liveness_settle_ms_p95", "settle p95"],
];

function OperationsExplorer() {
  const [sec, setSec] = useState<Sec<Row>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((t) => t + 1));
  useEffect(() => {
    const ctl = new AbortController();
    setSec({ kind: "loading" });
    apiAdmin.operationsOverview(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !isObj(r.operations)) {
          setSec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/operations returned a malformed payload") });
          return;
        }
        setSec({ kind: "ready", data: r.operations });
      })
      .catch((e) => !ctl.signal.aborted && setSec({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, [tick]);
  if (sec.kind === "loading") return <section className="need"><Skeleton height={120} /></section>;
  if (sec.kind === "error") return <section className="need"><SecError sec={sec} /></section>;
  const ops = sec.data;
  const allZero = OPS_COUNTS.every(([k]) => Number(ops[k] ?? 0) === 0);
  return (
    <section className="need" aria-label="operations rollup">
      <h2>Operational pressure</h2>
      <p className="sub srcnote">
        <code>GET /api/operations</code> — bounded aggregate counts over canonical rows;
        nothing inferred, nothing synthesized.
      </p>
      {allZero ? (
        <EmptyState title="No operational pressure" detail="Every aggregate pressure count is zero — no mission, collection, recovery, barrier or approval backlog." />
      ) : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>signal</th><th>count</th></tr></thead>
          <tbody>
            {OPS_COUNTS.map(([k, label]) => (
              <tr key={k}>
                <td className="muted">{label}</td>
                <td className="mono">{Number.isFinite(Number(ops[k])) ? Number(ops[k]) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <h2>Liveness latency</h2>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>chain</th><th>latency</th></tr></thead>
        <tbody>
          {OPS_LIVENESS.map(([k, label]) => (
            <tr key={k}>
              <td className="muted">{label}</td>
              <td className="mono">{Number.isFinite(Number(ops[k])) ? `${Number(ops[k])} ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function EvidenceExplorer() {
  const [msec, setMsec] = useState<Sec<Row[]>>({ kind: "loading" });
  const [missionId, setMissionId] = useState("");
  const [esec, setEsec] = useState<Sec<Row[]> | { kind: "idle" }>({ kind: "idle" });
  const gen = useRef(0);
  const pickedRef = useRef("");

  useEffect(() => {
    const ctl = new AbortController();
    apiAdmin.missions(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.missions) || !r.missions.every(isObj)) {
          setMsec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/missions returned a malformed payload") });
          return;
        }
        setMsec({ kind: "ready", data: r.missions });
      })
      .catch((e) => !ctl.signal.aborted && setMsec({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    if (!missionId) { setEsec({ kind: "idle" }); return; }
    const ctl = new AbortController();
    const g = ++gen.current;
    pickedRef.current = missionId;
    setEsec({ kind: "loading" });
    apiAdmin.missionEvidence(missionId, ctl.signal)
      .then((r) => {
        /* stale-response guard: a late reply for mission A must never
           paint under selected mission B (mandate B4). */
        if (ctl.signal.aborted || g !== gen.current || pickedRef.current !== missionId) return;
        if (!Array.isArray(r) || !r.every(isObj)) {
          setEsec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET evidence returned a malformed payload") });
          return;
        }
        setEsec({ kind: "ready", data: r });
      })
      .catch((e) => {
        if (!ctl.signal.aborted && g === gen.current && pickedRef.current === missionId) {
          setEsec({ kind: "error", err: errOf(e) });
        }
      });
    return () => ctl.abort();
  }, [missionId]);

  const rows = esec.kind === "ready" ? esec.data : [];
  const exportJson = () => {
    /* export only the verified evidence of the CURRENTLY selected
       mission — never a stale payload. */
    const blob = new Blob(
      [JSON.stringify({ mission_id: missionId, evidence: rows }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `evidence-${missionId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="need" aria-label="evidence explorer">
      <h2>Mission evidence</h2>
      <p className="sub srcnote">
        <code>GET /api/missions</code> — <strong>global, unfiltered</strong> mission listing; evidence
        is pinned to the selected mission identity.
      </p>
      {msec.kind === "loading" ? <Skeleton height={40} /> : msec.kind === "error" ? (
        <SecError sec={msec} />
      ) : msec.data.length === 0 ? (
        <EmptyState title="No missions" detail="No missions exist to inspect." />
      ) : (
        <>
          <div className="row" style={{ gap: 8 }}>
            <select className="inp" aria-label="select mission" value={missionId}
              onChange={(e) => setMissionId(e.target.value)}>
              <option value="">— select mission —</option>
              {msec.data.map((m) => (
                <option key={String(m.mission_id)} value={String(m.mission_id)}>
                  {String(m.mission_id).slice(0, 24)} — {String(m.goal ?? "").slice(0, 40)}
                </option>
              ))}
            </select>
            <button className="tbtn" disabled={!missionId || esec.kind !== "ready" || rows.length === 0}
              onClick={exportJson}>Export evidence JSON</button>
          </div>
          {esec.kind === "idle" ? null : esec.kind === "loading" ? (
            <Skeleton height={80} />
          ) : esec.kind === "error" ? (
            <SecError sec={esec} />
          ) : rows.length === 0 ? (
            <EmptyState title="No evidence" detail={`The selected mission ${missionId} has no canonical evidence rows.`} />
          ) : (
            <div className="tbl-wrap"><table className="tbl">
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
            </table></div>
          )}
        </>
      )}
    </section>
  );
}

export function SystemObservability() {
  const [tab, setTab] = useState<Tab>("events");
  const [live, setLive] = useState(streamStatus());
  useEffect(() => onStreamStatus(setLive), []);
  return (
    <div className="page">
      <h1>
        Observability{" "}
        <StatusBadge
          tone={live === "open" ? "ok" : "danger"}
          label={live === "open" ? "live" : "reconnecting"}
        />
      </h1>
      <p className="sub srcnote">
        Global technical observability surface — never business-scoped company activity.
      </p>
      <div className="tabs" role="tablist">
        {(["events", "routing", "recovery", "evidence", "operations"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}>
            {t === "events" ? "Event stream" : t === "routing" ? "Routing" : t === "recovery" ? "Recovery" : t === "evidence" ? "Evidence" : "Operations"}
          </button>
        ))}
      </div>
      {tab === "events" && <EventStream />}
      {tab === "routing" && <RoutingExplorer />}
      {tab === "recovery" && <RecoveryExplorer />}
      {tab === "evidence" && <EvidenceExplorer />}
      {tab === "operations" && <OperationsExplorer />}
    </div>
  );
}
