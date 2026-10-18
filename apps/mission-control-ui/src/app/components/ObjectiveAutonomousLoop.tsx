/* ObjectiveAutonomousLoop — live node/edge observability flowchart.

   Renders the pure deriveLoopSnapshot() output as an interactive SVG
   graph: directional edges, state-aware node treatment, zoom/pan/fit,
   click-to-inspect, conditional side branches, and read-only
   scheduler/driver detail panels. All state comes from the injected
   EpRead quartet — nothing is simulated. */

import { useMemo, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import type {
  LoopEdge,
  LoopInputs,
  LoopNodeId,
  LoopNodeState,
  LoopSnapshot,
  LoopVisual,
} from "../lib/objectiveLoop";
import { deriveLoopSnapshot, fmtTs, nodeInspector } from "../lib/objectiveLoop";
import { StatusBadge, type Tone } from "./StatusBadge";

/* ---------------- layout ---------------- */

const NODE_W = 216;
const NODE_H = 44;
const GAP_Y = 58;
const BRANCH_X = 330;
const BRANCH_Y0 = 116; // aligns roughly with the scheduler row

const SPINE_ORDER: LoopNodeId[] = [
  "policy", "wake", "scheduler", "claim", "admission", "pass", "ceo",
  "alloc", "planner", "mission", "exec", "evidence", "review", "settle",
  "continuation",
];

const BRANCH_ORDER: LoopNodeId[] = [
  "br_blocked", "br_waiting", "br_retry", "br_fault", "br_owner",
];

interface Pos { x: number; y: number }

function layoutOf(id: LoopNodeId): Pos {
  const si = SPINE_ORDER.indexOf(id);
  if (si >= 0) return { x: 0, y: si * GAP_Y };
  const bi = BRANCH_ORDER.indexOf(id);
  if (bi >= 0) return { x: BRANCH_X, y: BRANCH_Y0 + bi * GAP_Y };
  return { x: 0, y: 0 };
}

const GRAPH_W = BRANCH_X + NODE_W + 70;
const GRAPH_H = SPINE_ORDER.length * GAP_Y + NODE_H + 10;

function edgePath(e: LoopEdge): string {
  const a = layoutOf(e.from);
  const b = layoutOf(e.to);
  if (e.kind === "spine") {
    const x = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const y2 = b.y;
    const my = y1 + (y2 - y1) / 2;
    return `M ${x} ${y1} C ${x} ${my}, ${b.x + NODE_W / 2} ${my}, ${b.x + NODE_W / 2} ${y2}`;
  }
  if (e.kind === "loop") {
    // continuation → wake, routed along the left gutter
    const x1 = a.x;
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    const gx = a.x - 46;
    return `M ${x1} ${y1} C ${gx} ${y1}, ${gx} ${y2}, ${b.x - 8} ${y2}`;
  }
  // branch — horizontal elbow from source right edge to branch left edge
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mx = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/* ---------------- visual semantics ---------------- */

const VISUAL_TONE: Record<LoopVisual, Tone> = {
  proven: "ok",
  active: "info",
  waiting: "warn",
  blocked: "danger",
  failed: "danger",
  upcoming: "unknown",
  unknown: "unknown",
};

const LEGEND: [LoopVisual, string][] = [
  ["proven", "proven (observed evidence)"],
  ["active", "active (observed now)"],
  ["waiting", "waiting / retry"],
  ["blocked", "blocked"],
  ["failed", "failed / fault"],
  ["upcoming", "not reached / inactive"],
  ["unknown", "unknown / unverified"],
];

const VISUAL_LABEL: Record<LoopVisual, string> = {
  proven: "PROVEN",
  active: "ACTIVE",
  waiting: "WAITING",
  blocked: "BLOCKED",
  failed: "FAILED",
  upcoming: "INACTIVE",
  unknown: "UNKNOWN",
};

/* ---------------- component ---------------- */

interface Vp { k: number; x: number; y: number }

export function ObjectiveAutonomousLoop(props: {
  inputs: LoopInputs;
  nowMs: number;
}) {
  const { inputs, nowMs } = props;
  const snap: LoopSnapshot = useMemo(() => deriveLoopSnapshot(inputs), [inputs]);
  const [selected, setSelected] = useState<LoopNodeId | null>(null);
  const [hideBranches, setHideBranches] = useState(false);
  const [vp, setVp] = useState<Vp>({ k: 1, x: 56, y: 8 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  const shown = snap.nodes.filter(
    (n) => !hideBranches || !n.branch || n.visual !== "upcoming",
  );
  const shownIds = new Set(shown.map((n) => n.id));
  const edges = snap.edges.filter(
    (e) => shownIds.has(e.from) && shownIds.has(e.to),
  );

  const fit = useCallback(() => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(r.width / GRAPH_W, r.height / GRAPH_H, 1.15);
    setVp({
      k,
      x: (r.width - GRAPH_W * k) / 2 + 56 * k,
      y: (r.height - GRAPH_H * k) / 2,
    });
  }, []);

  const onWheel = useCallback((ev: React.WheelEvent) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    setVp((v) => {
      const k2 = Math.min(2.4, Math.max(0.35, v.k * (ev.deltaY < 0 ? 1.12 : 0.9)));
      const s = k2 / v.k;
      return { k: k2, x: px - (px - v.x) * s, y: py - (py - v.y) * s };
    });
  }, []);

  /* Click-vs-drag: pointer capture is only taken once the pointer has
     actually moved (real pan) — a stationary press stays a normal click
     so node onClick still fires. A completed drag suppresses the
     release click so it can't accidentally select a node. */
  const suppressClick = useRef(false);
  const onDown = useCallback((ev: React.PointerEvent) => {
    suppressClick.current = false;
    setVp((v) => {
      drag.current = { px: ev.clientX, py: ev.clientY, vx: v.x, vy: v.y };
      return v;
    });
  }, []);
  const onMove = useCallback((ev: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = ev.clientX - d.px;
    const dy = ev.clientY - d.py;
    if (Math.hypot(dx, dy) < 3) return;
    if (!suppressClick.current) {
      suppressClick.current = true;
      svgRef.current?.setPointerCapture(ev.pointerId);
    }
    setVp((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  }, []);
  const onUp = useCallback(() => {
    drag.current = null;
  }, []);

  const insp = selected ? nodeInspector(snap, selected) : null;

  const fmtAge = (atMs: number | null) =>
    atMs === null ? "—" : `${Math.max(0, Math.round((nowMs - atMs) / 1000))}s ago`;

  return (
    <section className="aloop" aria-label="Autonomous loop observability">
      <div className="aloop-head">
        <h2>Autonomous loop</h2>
        <StatusBadge tone={VISUAL_TONE[snap.headline.visual]} label={snap.headline.label} />
        {snap.headline.detail ? (
          <span className="aloop-head-detail">{snap.headline.detail}</span>
        ) : null}
        {snap.observationVerified === false ? (
          <StatusBadge tone="danger" label="unverified cockpit observation" />
        ) : null}
      </div>

      <div className="aloop-fresh" role="note">
        {snap.freshness.map((f) => (
          <span
            key={f.source}
            className={`aloop-fresh-item ${f.state !== "ok" ? "is-bad" : ""}`}
          >
            {f.source}: {f.state === "ok" ? fmtAge(f.atMs) : f.note ?? f.state}
          </span>
        ))}
        <span className="aloop-fresh-item aloop-fresh-note">
          observations only — not simulated
        </span>
      </div>

      <div className="aloop-body">
        <div className="aloop-canvas">
          <div className="aloop-toolbar">
            <button type="button" onClick={() => setVp((v) => ({ ...v, k: Math.min(2.4, v.k * 1.2) }))}>+</button>
            <button type="button" onClick={() => setVp((v) => ({ ...v, k: Math.max(0.35, v.k / 1.2) }))}>−</button>
            <button type="button" onClick={fit}>fit</button>
            <button
              type="button"
              className={hideBranches ? "on" : ""}
              onClick={() => setHideBranches((v) => !v)}
              title="Hide inactive side branches"
            >
              branches
            </button>
          </div>
          <svg
            ref={svgRef}
            className="aloop-svg"
            viewBox={`0 0 ${GRAPH_W + 80} ${GRAPH_H + 20}`}
            onWheel={onWheel}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            role="img"
            aria-label="Autonomous orchestration flowchart"
          >
            <defs>
              <marker
                id="aloop-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="aloop-arrowhead" />
              </marker>
              <marker
                id="aloop-arrow-active"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="aloop-arrowhead active" />
              </marker>
            </defs>
            <g transform={`translate(${vp.x} ${vp.y}) scale(${vp.k})`}>
              {edges.map((e) => (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(e)}
                  className={`aloop-edge${e.active ? " active" : ""}${e.kind === "branch" ? " branch" : ""}`}
                  markerEnd={`url(#aloop-arrow${e.active ? "-active" : ""})`}
                  fill="none"
                />
              ))}
              {shown.map((n) => (
                <LoopNode
                  key={n.id}
                  n={n}
                  selected={selected === n.id}
                  onClick={() => {
                    if (suppressClick.current) return;
                    setSelected(n.id === selected ? null : n.id);
                  }}
                />
              ))}
            </g>
          </svg>
          <div className="aloop-legend">
            {LEGEND.map(([v, label]) => (
              <span key={v} className="aloop-legend-item">
                <i className={`aloop-dot ns-${v}`} />
                {label}
              </span>
            ))}
          </div>
        </div>

        <aside className="aloop-inspector" aria-label="Node inspector">
          {insp ? (
            <Inspector n={insp} nowMs={nowMs} />
          ) : (
            <p className="aloop-inspector-empty">
              Select a node to inspect its observed evidence.
            </p>
          )}
        </aside>
      </div>

      <LoopPanels inputs={inputs} />
    </section>
  );
}

/* ---------------- node ---------------- */

function LoopNode(props: {
  n: LoopNodeState;
  selected: boolean;
  onClick: () => void;
}) {
  const { n, selected, onClick } = props;
  const p = layoutOf(n.id);
  const status = n.status.length > 30 ? `${n.status.slice(0, 27)}…` : n.status;
  return (
    <g
      className={`aloop-node ns-${n.visual}${selected ? " sel" : ""}${n.branch ? " br" : ""}`}
      transform={`translate(${p.x} ${p.y})`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`${n.title}: ${n.status}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <rect width={NODE_W} height={NODE_H} rx={9} className="aloop-node-rect" />
      <circle cx={13} cy={NODE_H / 2 - 7} r={4.5} className="aloop-dot" />
      <text
        x={24}
        y={NODE_H / 2 - 9}
        className="aloop-node-title"
        fontSize={n.title.length > 17 ? 10.2 : 11}
      >
        {n.title}
      </text>
      <text x={24} y={NODE_H / 2 + 11} className="aloop-node-status">
        {status}
      </text>
      <text x={NODE_W - 8} y={NODE_H - 5} className="aloop-node-tag" textAnchor="end">
        {VISUAL_LABEL[n.visual]}
      </text>
    </g>
  );
}

/* ---------------- inspector ---------------- */

function Inspector(props: { n: LoopNodeState; nowMs: number }) {
  const { n } = props;
  return (
    <div className="aloop-insp-card">
      <div className="aloop-insp-head">
        <strong>{n.title}</strong>
        <StatusBadge tone={VISUAL_TONE[n.visual]} label={n.status} />
      </div>
      {n.detail ? <p className="aloop-insp-detail">{n.detail}</p> : null}
      <table className="aloop-insp-table">
        <tbody>
          {n.evidence.map((e, k) => (
            <tr key={`${e.label}-${k}`}>
              <td>{e.label}</td>
              <td className={e.kind === "absent" ? "aloop-absent" : ""}>
                {e.value}
              </td>
              <td className="aloop-insp-src">
                {e.source}
                {e.kind === "derived" ? " · derived" : e.kind === "absent" ? " · absent" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- read-only detail panels ---------------- */

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="aloop-panel">
      <h3>{props.title}</h3>
      {props.children}
    </div>
  );
}

function Row(props: { k: string; v: React.ReactNode }) {
  return (
    <div className="aloop-row">
      <span className="aloop-row-k">{props.k}</span>
      <span className="aloop-row-v">{props.v ?? "not available"}</span>
    </div>
  );
}

function LoopPanels(props: { inputs: LoopInputs }) {
  const { inputs } = props;
  const s = inputs.scheduler;
  const d = inputs.driver;

  return (
    <div className="aloop-panels">
      <Panel title="Scheduler">
        {s.kind === "ready" ? (
          <>
            <Row k="queue_state" v={s.data.queue_state} />
            <Row k="next_due" v={s.data.next_due === null ? "none scheduled" : fmtTs(s.data.next_due)} />
            <Row k="retry_count" v={s.data.retry_count} />
            <Row k="blocked_reason" v={s.data.blocked_reason} />
            <Row k="wait_kind" v={s.data.wait_kind} />
            <Row k="pending_reasons" v={s.data.pending_reasons?.join(", ") || "none"} />
            <Row k="scheduler_ready" v={String(s.data.scheduler_ready)} />
            <Row k="consumer_ready / driver_ready" v={`${s.data.consumer_ready} / ${s.data.driver_ready}`} />
            <Row k="driver_missing" v={s.data.driver_missing?.join(", ") || "none"} />
            <Row k="lease" v={s.data.lease ? `${s.data.lease.state} · fence ${s.data.lease.fence} · exp ${fmtTs(s.data.lease.expires_at)}` : "none"} />
            <Row k="catchup_state" v={s.data.catchup_state} />
          </>
        ) : s.kind === "error" ? (
          <p className="aloop-err">auto-scheduler read failed — {s.status === null ? s.code : `HTTP ${s.status} · ${s.code}`}</p>
        ) : (
          <p className="aloop-err">auto-scheduler read unavailable</p>
        )}
        {s.kind === "ready" ? (
          <details className="aloop-diag">
            <summary>diagnostics</summary>
            <Row k="pending_generation" v={s.data.pending_generation} />
            <Row k="claimed_generation" v={s.data.claimed_generation} />
            <Row k="checkpoint_digest" v={s.data.checkpoint_digest} />
            <Row k="coalesced_count" v={s.data.coalesced_count} />
            <Row k="source_refs" v={s.data.source_refs?.join(", ") || "none"} />
            <Row k="policy_version" v={s.data.policy_version} />
            <Row k="terms_current" v={String(s.data.terms_current)} />
            <Row k="objective_runnable" v={String(s.data.objective_runnable)} />
            <Row k="owner_action_required" v={String(s.data.owner_action_required)} />
            <Row k="scheduler_mode" v={s.data.scheduler_mode} />
            <Row k="driver_integrated" v={String(s.data.driver_integrated)} />
          </details>
        ) : null}
      </Panel>

      <Panel title="Driver activity">
        {d.kind === "ready" ? (
          <>
            <Row k="enabled" v={String(d.data.enabled)} />
            <Row k="last_outcome" v={d.data.last_outcome} />
            <Row
              k="last_result.fault"
              v={
                d.data.last_result?.fault ? (
                  <StatusBadge tone="danger" label={d.data.last_result.fault} />
                ) : (
                  "none"
                )
              }
            />
            <Row k="last_fence" v={d.data.last_fence} />
            <Row k="lease" v={d.data.lease ? `${d.data.lease.state} · fence ${d.data.lease.fence}` : "none"} />
            <Row k="denials" v={d.data.denials?.length ?? 0} />
          </>
        ) : d.kind === "error" ? (
          <p className="aloop-err">auto-driver read failed — {d.status === null ? d.code : `HTTP ${d.status} · ${d.code}`}</p>
        ) : (
          <p className="aloop-err">auto-driver read unavailable</p>
        )}
        {d.kind === "ready" && d.data.admissions?.length ? (
          <table className="aloop-adm-table">
            <thead>
              <tr><th>fence</th><th>generation</th><th>at</th><th>ceo</th><th>missions</th><th>microusd</th></tr>
            </thead>
            <tbody>
              {d.data.admissions.slice(-8).reverse().map((a, k) => (
                <tr key={`${a.fence}-${a.generation}-${k}`}>
                  <td>{a.fence}</td>
                  <td>{a.generation}</td>
                  <td>{fmtTs(a.at)}</td>
                  <td>{a.usage?.ceo_calls ?? "—"}</td>
                  <td>{a.usage?.missions ?? "—"}</td>
                  <td>{a.usage?.microusd ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {/* R4-F2 — concrete denial records, marked historical. Backend
            bound is already 8; slice again defensively. Recorded order
            is preserved — malformed timestamps render as such, never
            re-ordered on. */}
        {d.kind === "ready" ? (
          d.data.denials?.length ? (
            <>
              <p className="aloop-den-h">
                Recent admission denials <span className="aloop-den-tag">historical</span>
              </p>
              <table className="aloop-adm-table aloop-den-table">
                <thead>
                  <tr><th>at</th><th>fence</th><th>label</th></tr>
                </thead>
                <tbody>
                  {d.data.denials.slice(-8).map((dn, k) => (
                    <tr key={`den-${k}`}>
                      <td>{fmtTs(dn?.at ?? null)}</td>
                      <td>{dn?.fence ?? "—"}</td>
                      <td>{dn?.label ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="aloop-den-empty">no denials recorded</p>
          )
        ) : null}
      </Panel>

      <Panel title="Missions">
        {/* R2-F2 — cockpit observation integrity failure: mission
            statuses stay visible as raw rows but are explicitly marked
            UNVERIFIED; no operational claim is made from them. */}
        {inputs.cockpit.kind === "ready" && inputs.cockpit.data.observation_error ? (
          <p className="aloop-err aloop-msn-unverified">
            <StatusBadge tone="warn" label="UNVERIFIED" />
            {" "}cockpit observation failed — mission data below is raw, not confirmed
          </p>
        ) : null}
        {inputs.cockpit.kind === "ready" && inputs.cockpit.data.missions?.length ? (
          <ul className="aloop-msn-list">
            {inputs.cockpit.data.missions.slice(0, 6).map((m) => (
              <li key={m.mission_id}>
                <Link to={`/app/missions/${m.mission_id}`}>{m.mission_id}</Link>
                {" · "}{m.status}
                {m.runtime_state ? ` · ${m.runtime_state}` : ""}
                {m.bound_open_id ? ` · ${m.bound_open_id}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="aloop-err">
            {inputs.cockpit.kind === "ready" ? "no missions bound" : "mission list unavailable"}
          </p>
        )}
      </Panel>
    </div>
  );
}
