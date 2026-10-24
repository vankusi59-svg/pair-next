import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiAdmin, ApiError } from "../../api";
import type { ObjectiveRelation, OrgAgentDuty } from "../../types";
import { StatusBadge, type Tone } from "./StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "./states";
import { ConfirmDialog } from "./ConfirmDialog";

/* P18.1 — Company-level relation graph + duty coverage (Company page).
   businessRelationsApp + businessDutiesApp are the canonical reads —
   nodes/edges are drawn only from returned rows; REVOKED edges hide by
   default behind an explicit toggle. DEPENDS_ON layers by topo-sort
   (upstream one row above dependents); a dependency cycle falls back
   to alphabetical rows, labeled honestly. Edge lifecycle commits
   through relationControlApp; revoke is terminal → ConfirmDialog. The
   UI never sends an owner/actor field — authority is the
   x-operator-id header. */

type ObjLite = { objective_id: string; title?: string | null; status: string };
type CtlAction = "suspend" | "resume" | "revoke";

type Rd<T> =
  | { kind: "loading" }
  | { kind: "ready"; forBiz: string; data: T; atMs: number }
  | { kind: "error"; err: ApiError };

const KIND_TONE: Record<string, Tone> = {
  DEPENDS_ON: "warn",
  CONFLICTS: "danger",
  SUPERSEDES: "info",
};
const STATE_TONE: Record<string, Tone> = {
  ACTIVE: "ok",
  SUSPENDED: "warn",
  REVOKED: "danger",
};

const ERR_HINT: Record<string, string> = {
  FAIL_CLOSED_RELATION_AUTHORITY: "you must own both objectives",
  FAIL_CLOSED_RELATION_BUSINESS: "relations cannot span businesses",
  FAIL_CLOSED_COMPANY_SCOPE: "you don't own any objectives in this business",
};

function describeErr(e: unknown): string {
  if (e instanceof ApiError) {
    const hint = ERR_HINT[e.code];
    if (hint) return `${e.code} — ${hint}${e.detail ? ` (${e.detail})` : ""}`;
    return e.detail ? `${e.code}: ${e.detail}` : e.code;
  }
  return String(e);
}

const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

const fmtD = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  return s.length >= 19 ? s.slice(0, 19).replace("T", " ") : s;
};

/* ---------------- graph layout ---------------- */

const NODE_W = 230;
const NODE_H = 50;
const GAP_X = 56;
const GAP_Y = 96;
const ROW_CHUNK = 4; /* fallback/non-dep rows wrap every 4 nodes */

interface Pos {
  x: number;
  y: number;
}

const STATUS_STROKE: Record<string, string> = {
  DRAFT: "var(--unknown)",
  PROPOSED: "var(--info)",
  RUNNING: "var(--accent)",
  PAUSED: "var(--warn)",
  ACHIEVED: "var(--ok)",
  CANCELLED: "var(--unknown)",
  FAILED: "var(--danger)",
  EXPIRED: "var(--warn)",
};

const EDGE_STYLE: Record<string, { stroke: string; dash?: string; label: string }> = {
  DEPENDS_ON: { stroke: "var(--warn)", label: "waits on" },
  CONFLICTS: { stroke: "var(--danger)", dash: "7 5", label: "conflicts" },
  SUPERSEDES: { stroke: "var(--purple)", dash: "2 4", label: "replaces" },
};

const chunk = (ids: string[], n: number): string[][] => {
  const rows: string[][] = [];
  for (let i = 0; i < ids.length; i += n) rows.push(ids.slice(i, i + n));
  return rows;
};

/* Layered layout on ACTIVE DEPENDS_ON edges only. Semantics: an edge
   from→to reads "from waits on to", so `to` is upstream and must sit
   one row above `from` — the topo direction is to→from. Depth is the
   longest upstream chain. A dependency cycle (some nodes never reach
   indegree 0) falls back to alphabetical rows — reported honestly.
   Objectives untouched by any DEPENDS_ON edge get chunked bottom rows. */
function layoutRows(ids: string[], rels: ObjectiveRelation[]): { rows: string[][]; cyclic: boolean } {
  const present = new Set(ids);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const involved = new Set<string>();
  for (const id of ids) indeg.set(id, 0);
  for (const r of rels) {
    if (r.kind !== "DEPENDS_ON" || r.state !== "ACTIVE") continue;
    const up = r.to_objective_id;
    const down = r.from_objective_id;
    if (!present.has(up) || !present.has(down) || up === down) continue;
    indeg.set(down, (indeg.get(down) ?? 0) + 1);
    const l = adj.get(up);
    if (l) l.push(down);
    else adj.set(up, [down]);
    involved.add(up);
    involved.add(down);
  }
  const depth = new Map<string, number>();
  const q = ids.filter((i) => (indeg.get(i) ?? 0) === 0);
  for (const i of q) depth.set(i, 0);
  const seen = new Set<string>();
  while (q.length) {
    const u = q.shift()!;
    seen.add(u);
    for (const v of adj.get(u) ?? []) {
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1));
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) q.push(v);
    }
  }
  if (seen.size < ids.length) {
    return { rows: chunk([...ids].sort((a, b) => a.localeCompare(b)), ROW_CHUNK), cyclic: true };
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rows: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const id of ids) {
    if (involved.has(id)) rows[depth.get(id) ?? 0]!.push(id);
  }
  const rest = ids.filter((i) => !involved.has(i));
  const out = rows.filter((r) => r.length > 0);
  for (const c of chunk(rest, ROW_CHUNK)) out.push(c);
  return { rows: out, cyclic: false };
}

/* Point where the segment center→target exits the node rect — edges
   start/end at node borders, never under a node. */
function borderPoint(c: { x: number; y: number }, t: { x: number; y: number }): { x: number; y: number } {
  const dx = t.x - c.x;
  const dy = t.y - c.y;
  if (!dx && !dy) return c;
  const kx = dx !== 0 ? (NODE_W / 2 + 3) / Math.abs(dx) : Infinity;
  const ky = dy !== 0 ? (NODE_H / 2 + 3) / Math.abs(dy) : Infinity;
  const k = Math.min(kx, ky);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

function edgeGeom(a: Pos, b: Pos, off: number): { d: string; lx: number; ly: number } {
  const ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
  const bc = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
  const p1 = borderPoint(ac, bc);
  const p2 = borderPoint(bc, ac);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / len) * off;
  const cy = my + (dx / len) * off;
  return { d: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`, lx: cx, ly: cy };
}

/* Parallel edges between the same pair fan out; CONFLICTS is symmetric
   so it groups unordered, the directed kinds group ordered. */
const pairKey = (r: ObjectiveRelation): string =>
  r.kind === "CONFLICTS"
    ? ["CONFLICTS", ...[r.from_objective_id, r.to_objective_id].sort()].join("|")
    : [r.kind, r.from_objective_id, r.to_objective_id].join("|");

export function CompanyRelations(props: {
  businessId: string;
  objectives: ObjLite[];
  onChanged?: () => void;
}): JSX.Element {
  const { businessId } = props;
  const nav = useNavigate();
  const [relSt, setRelSt] = useState<Rd<ObjectiveRelation[]>>({ kind: "loading" });
  const [dutSt, setDutSt] = useState<Rd<OrgAgentDuty[]>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [showRevoked, setShowRevoked] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [dlg, setDlg] = useState<ObjectiveRelation | null>(null);
  const lastRel = useRef(0);
  const lastDut = useRef(0);
  const opSeq = useRef(0);
  const onChangedRef = useRef(props.onChanged);
  onChangedRef.current = props.onChanged;

  /* Business change closes selection/dialogs and bumps the in-flight
     guard — a stale mutation can never attribute to another business. */
  useEffect(() => {
    setSel(null);
    setDlg(null);
    setMutNote(null);
    setMutBusy(false);
    lastRel.current = 0;
    lastDut.current = 0;
    opSeq.current++;
  }, [businessId]);

  /* 8s canonical poll — same abort/newest-wins convention as the
     cockpit read on Objective Detail. */
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, 8000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    /* Silent re-poll: keep each endpoint's last good snapshot for THIS
       business while refetching; collapse to loading only on identity
       change or before the first successful read. */
    setRelSt((prev) =>
      prev.kind === "ready" && prev.forBiz === businessId ? prev : { kind: "loading" },
    );
    setDutSt((prev) =>
      prev.kind === "ready" && prev.forBiz === businessId ? prev : { kind: "loading" },
    );
    if (!businessId) return;
    const ctl = new AbortController();
    apiAdmin
      .businessRelationsApp(businessId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        if (atMs <= lastRel.current) return;
        lastRel.current = atMs;
        setRelSt({
          kind: "ready",
          forBiz: businessId,
          data: arr(r.relations).filter(
            (x) => x !== null && typeof x === "object" && !!x.relation_id,
          ),
          atMs,
        });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        lastRel.current = Date.now();
        setRelSt({
          kind: "error",
          err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)),
        });
      });
    apiAdmin
      .businessDutiesApp(businessId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        if (atMs <= lastDut.current) return;
        lastDut.current = atMs;
        setDutSt({
          kind: "ready",
          forBiz: businessId,
          data: arr(r.duties).filter((x) => x !== null && typeof x === "object" && !!x.duty_id),
          atMs,
        });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        lastDut.current = Date.now();
        setDutSt({
          kind: "error",
          err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)),
        });
      });
    return () => ctl.abort();
  }, [businessId, tick]);

  const relations = relSt.kind === "ready" ? relSt.data : [];
  const duties = dutSt.kind === "ready" ? dutSt.data : [];

  const titleOf = (id: string): string => {
    const o = props.objectives.find((x) => x.objective_id === id);
    return (o && o.title ? String(o.title) : "") || id;
  };
  const statusOf = (id: string): string =>
    props.objectives.find((x) => x.objective_id === id)?.status ?? "—";

  const runCtl = (rel: ObjectiveRelation, action: CtlAction) => {
    const seq = ++opSeq.current;
    setDlg(null);
    setMutBusy(true);
    setMutNote(null);
    apiAdmin
      .relationControlApp(rel.relation_id, action)
      .then((r) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        const rr = r?.relation;
        if (!rr || String(rr.relation_id) !== rel.relation_id) {
          setMutNote(
            `Relation ${action} returned an inconsistent response — canonical list refetched; verify state before retrying.`,
          );
        } else {
          setMutNote(`Relation ${action} committed — canonical list refreshed.`);
        }
        setTick((n) => n + 1);
        onChangedRef.current?.();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`Relation ${action} failed: ${describeErr(e)}`);
      });
  };

  /* Graph model: nodes = listed objectives ∪ endpoints of visible
     edges (an edge referencing an unlisted objective still draws —
     the canonical row exists; fabricating the absence would be the
     lie). */
  const graph = useMemo(() => {
    const shown = relations.filter((r) => showRevoked || r.state !== "REVOKED");
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const o of props.objectives) {
      if (!seen.has(o.objective_id)) {
        seen.add(o.objective_id);
        ids.push(o.objective_id);
      }
    }
    for (const r of shown) {
      for (const id of [r.from_objective_id, r.to_objective_id]) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    const { rows, cyclic } = layoutRows(ids, shown);
    const pos = new Map<string, Pos>();
    let maxCols = 1;
    rows.forEach((row, ri) => {
      if (row.length > maxCols) maxCols = row.length;
      row.forEach((id, ci) => pos.set(id, { x: ci * (NODE_W + GAP_X), y: ri * (NODE_H + GAP_Y) }));
    });
    /* Drawable edges only — a self-referential row still renders in
       the flat table below, just not as a meaningless loop arc. */
    const drawable = shown.filter(
      (r) =>
        r.from_objective_id !== r.to_objective_id &&
        pos.has(r.from_objective_id) &&
        pos.has(r.to_objective_id),
    );
    const groups = new Map<string, number>();
    const total = new Map<string, number>();
    for (const r of drawable) total.set(pairKey(r), (total.get(pairKey(r)) ?? 0) + 1);
    const edges = drawable.map((r) => {
      const k = pairKey(r);
      const i = groups.get(k) ?? 0;
      groups.set(k, i + 1);
      const n = total.get(k) ?? 1;
      const off = (i - (n - 1) / 2) * 26;
      const g = edgeGeom(pos.get(r.from_objective_id)!, pos.get(r.to_objective_id)!, off);
      return { r, d: g.d, lx: g.lx, ly: g.ly };
    });
    return {
      nodes: ids.map((id) => ({ id, p: pos.get(id)! })),
      edges,
      cyclic,
      w: maxCols * (NODE_W + GAP_X),
      h: rows.length * (NODE_H + GAP_Y),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relSt, showRevoked, props.objectives]);

  const selRel = sel ? relations.find((r) => r.relation_id === sel) ?? null : null;

  const relErrBox =
    relSt.kind === "error" ? (
      relSt.err.status === 403 ? (
        <DeniedState detail={`${relSt.err.detail || "You don't own this scope."} (${relSt.err.code})`} />
      ) : (
        <ErrorState
          code={relSt.err.status === 401 ? relSt.err.code || "UNAUTHORIZED" : relSt.err.code}
          detail={
            relSt.err.status === 401
              ? `Your credentials were rejected — update the session token and retry. ${relSt.err.detail}`
              : relSt.err.code.startsWith("FAIL_CLOSED")
                ? `Integrity check failed — possibly-corrupt data was not rendered. ${relSt.err.detail}`
                : relSt.err.detail
          }
          onRetry={() => setTick((n) => n + 1)}
        />
      )
    ) : null;

  return (
    <section aria-label="company relations">
      <h2 className="sech">Objective relations</h2>
      <div className="sub">
        Canonical relation graph for {businessId}. Nodes are objectives; edges are the returned
        relation rows — never fabricated. Click an edge to inspect and control it; click a node to
        open its objective.
      </div>

      {mutNote ? (
        <div className="trunc" role="status">
          {mutNote}
        </div>
      ) : null}

      {relErrBox}

      {relSt.kind !== "error" ? (
        <>
          <div className="actions" style={{ margin: "6px 0 10px", alignItems: "center" }}>
            <label
              style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-2)" }}
            >
              <input
                type="checkbox"
                checked={showRevoked}
                onChange={(e) => setShowRevoked(e.target.checked)}
                style={{ width: "auto", margin: 0 }}
              />
              show revoked edges
            </label>
            <span className="aloop-legend" style={{ margin: 0 }}>
              <span className="aloop-legend-item">
                <i style={{ display: "inline-block", width: 18, borderTop: "2px solid var(--warn)" }} />{" "}
                DEPENDS_ON · waits on
              </span>
              <span className="aloop-legend-item">
                <i
                  style={{
                    display: "inline-block",
                    width: 18,
                    borderTop: "2px dashed var(--danger)",
                  }}
                />{" "}
                CONFLICTS
              </span>
              <span className="aloop-legend-item">
                <i
                  style={{
                    display: "inline-block",
                    width: 18,
                    borderTop: "2px dotted var(--purple)",
                  }}
                />{" "}
                SUPERSEDES · replaces
              </span>
            </span>
          </div>

          {relSt.kind === "loading" ? (
            <Skeleton height={220} />
          ) : graph.nodes.length === 0 ? (
            <EmptyState
              title="No relations — dependencies appear here"
              detail="This business has no canonical objectives or relation edges to draw."
            />
          ) : (
            <div className="aloop-canvas" style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: 10 }}>
              <div style={{ flex: 1, minWidth: 0, overflowX: "auto" }}>
                {graph.cyclic ? (
                  <div className="sub" style={{ margin: "0 0 6px" }}>
                    dependency cycle detected — layout fell back to alphabetical rows; the edge list
                    below stays canonical
                  </div>
                ) : null}
                <svg
                  viewBox={`0 0 ${graph.w} ${graph.h}`}
                  style={{ display: "block", minWidth: Math.min(graph.w, 1400), height: "auto", maxHeight: 640 }}
                  role="img"
                  aria-label="objective relation graph"
                >
                  <defs>
                    {(["DEPENDS_ON", "CONFLICTS", "SUPERSEDES"] as const).map((k) => (
                      <marker
                        key={k}
                        id={`cr-ar-${k}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 0 L 8 4 L 0 8 z" fill={EDGE_STYLE[k].stroke} />
                      </marker>
                    ))}
                  </defs>
                  {graph.edges.map((e) => {
                    const st_ = EDGE_STYLE[e.r.kind] ?? EDGE_STYLE.DEPENDS_ON!;
                    const suspended = e.r.state === "SUSPENDED";
                    return (
                      <g key={e.r.relation_id} opacity={suspended ? 0.45 : 1}>
                        {/* wide invisible hitbox keeps thin edges clickable */}
                        <path
                          d={e.d}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={14}
                          style={{ cursor: "pointer" }}
                          onClick={() => setSel(e.r.relation_id === sel ? null : e.r.relation_id)}
                        >
                          <title>
                            {e.r.kind} {e.r.from_objective_id} → {e.r.to_objective_id} · {e.r.state}
                          </title>
                        </path>
                        <path
                          d={e.d}
                          fill="none"
                          stroke={st_.stroke}
                          strokeWidth={e.r.relation_id === sel ? 2.4 : 1.6}
                          strokeDasharray={
                            suspended ? "4 4" : st_.dash
                          }
                          markerEnd={`url(#cr-ar-${e.r.kind in EDGE_STYLE ? e.r.kind : "DEPENDS_ON"})`}
                          markerStart={
                            e.r.kind === "CONFLICTS" ? `url(#cr-ar-CONFLICTS)` : undefined
                          }
                          pointerEvents="none"
                        />
                        <text
                          x={e.lx}
                          y={e.ly - 5}
                          textAnchor="middle"
                          fill="var(--text-3)"
                          fontSize={9.5}
                          pointerEvents="none"
                        >
                          {e.r.kind}
                        </text>
                      </g>
                    );
                  })}
                  {graph.nodes.map((n) => {
                    const status = statusOf(n.id);
                    const label = titleOf(n.id);
                    return (
                      <g
                        key={n.id}
                        transform={`translate(${n.p.x} ${n.p.y})`}
                        onClick={() => nav(`/app/objectives/${encodeURIComponent(n.id)}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            nav(`/app/objectives/${encodeURIComponent(n.id)}`);
                          }
                        }}
                        role="link"
                        tabIndex={0}
                        aria-label={`open objective ${label}`}
                        style={{ cursor: "pointer" }}
                      >
                        <title>{`${label} (${n.id}) · ${status}`}</title>
                        <rect
                          width={NODE_W}
                          height={NODE_H}
                          rx={9}
                          fill="var(--bg-raised)"
                          stroke={STATUS_STROKE[status] ?? "var(--unknown)"}
                          strokeWidth={1.6}
                        />
                        <text x={12} y={20} fill="var(--text-1)" fontSize={11.5} fontWeight={650}>
                          {label.length > 26 ? `${label.slice(0, 23)}…` : label}
                        </text>
                        <text x={12} y={37} fill="var(--text-3)" fontSize={10}>
                          {status}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {graph.edges.length === 0 && relations.length === 0 ? (
                  <div className="sub" style={{ margin: "6px 0 0" }}>
                    No relations — dependencies appear here. Nodes are shown for context.
                  </div>
                ) : null}
              </div>

              <aside style={{ flex: "0 0 300px", minWidth: 0 }} aria-label="relation detail">
                {selRel ? (
                  <div className="ecard" style={{ cursor: "default" }}>
                    <div className="eh">
                      <div>
                        <div className="t">{selRel.kind}</div>
                        <div className="oid">{selRel.relation_id}</div>
                      </div>
                      <StatusBadge tone={STATE_TONE[selRel.state] ?? "unknown"} label={selRel.state} />
                    </div>
                    <div className="nrow" style={{ padding: "4px 0", border: "none", flexWrap: "wrap" }}>
                      <span className="tt" title={selRel.from_objective_id}>
                        {titleOf(selRel.from_objective_id)}
                      </span>
                      <span className="note" aria-hidden>
                        →
                      </span>
                      <span className="tt" title={selRel.to_objective_id}>
                        {titleOf(selRel.to_objective_id)}
                      </span>
                    </div>
                    <div className="efoot" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                      <span>
                        {EDGE_STYLE[selRel.kind]?.label ?? "relation"} · created {fmtD(selRel.created_at)}
                        {selRel.updated_at ? ` · updated ${fmtD(selRel.updated_at)}` : ""}
                      </span>
                      {selRel.note ? <span>note: {String(selRel.note)}</span> : null}
                      {selRel.relation_digest ? (
                        <span>digest {String(selRel.relation_digest).slice(0, 16)}…</span>
                      ) : null}
                    </div>
                    <div className="actions" style={{ marginTop: 10 }}>
                      {selRel.state === "ACTIVE" ? (
                        <button className="ghost" disabled={mutBusy} onClick={() => runCtl(selRel, "suspend")}>
                          Suspend
                        </button>
                      ) : null}
                      {selRel.state === "SUSPENDED" ? (
                        <button className="ghost" disabled={mutBusy} onClick={() => runCtl(selRel, "resume")}>
                          Resume
                        </button>
                      ) : null}
                      {selRel.state !== "REVOKED" ? (
                        <button className="ghost" disabled={mutBusy} onClick={() => setDlg(selRel)}>
                          Revoke
                        </button>
                      ) : null}
                      <button className="ghost" onClick={() => setSel(null)}>
                        Close
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="aloop-inspector-empty">
                    Select an edge to inspect and control it. Suspended edges render faded; revoked
                    edges are hidden unless "show revoked" is on.
                  </p>
                )}
              </aside>
            </div>
          )}

          <div className="need" aria-label="all relations">
            {relations.length === 0 ? (
              <div className="nrow">
                <span className="note">No relations — dependencies appear here.</span>
              </div>
            ) : null}
            {relations.map((r) => (
              <div className="nrow" key={r.relation_id}>
                <StatusBadge tone={KIND_TONE[r.kind] ?? "unknown"} label={r.kind} />
                <span className="tt" title={r.from_objective_id}>
                  {titleOf(r.from_objective_id)}
                </span>
                <span className="note" aria-hidden>
                  →
                </span>
                <span className="tt" title={r.to_objective_id}>
                  {titleOf(r.to_objective_id)}
                </span>
                <StatusBadge tone={STATE_TONE[r.state] ?? "unknown"} label={r.state} />
                <span className="note">
                  {r.note ? `${String(r.note)} · ` : ""}created {fmtD(r.created_at)}
                </span>
                {r.state === "ACTIVE" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => runCtl(r, "suspend")}>
                    Suspend
                  </button>
                ) : null}
                {r.state === "SUSPENDED" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => runCtl(r, "resume")}>
                    Resume
                  </button>
                ) : null}
                {r.state !== "REVOKED" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => setDlg(r)}>
                    Revoke
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2 className="sech">Duties</h2>
      {dutSt.kind === "error" ? (
        dutSt.err.status === 403 ? (
          <DeniedState detail={`${dutSt.err.detail || "You don't own this scope."} (${dutSt.err.code})`} />
        ) : (
          <ErrorState
            code={dutSt.err.status === 401 ? dutSt.err.code || "UNAUTHORIZED" : dutSt.err.code}
            detail={dutSt.err.detail}
            onRetry={() => setTick((n) => n + 1)}
          />
        )
      ) : dutSt.kind === "loading" ? (
        <div className="need">
          {[0, 1].map((i) => (
            <div className="nrow" key={i}>
              <Skeleton height={12} width="55%" />
            </div>
          ))}
        </div>
      ) : (
        <div className="need" aria-label="duty coverage">
          {duties.length === 0 ? (
            <div className="nrow">
              <span className="note">No duties — agent bindings appear here.</span>
            </div>
          ) : null}
          {duties.map((d) => (
            <div className="nrow" key={d.duty_id}>
              <span className="tt" title={d.org_agent_id}>
                {d.org_agent_id}
              </span>
              <StatusBadge tone={STATE_TONE[d.state] ?? "unknown"} label={d.state} />
              <span className="note">
                covers{" "}
                {arr(d.objective_ids).length === 0
                  ? "no objectives"
                  : arr(d.objective_ids)
                      .map((id) => titleOf(id))
                      .join(" + ")}
                {d.note ? ` · ${String(d.note)}` : ""} · created {fmtD(d.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={dlg !== null}
        title="Revoke relation"
        body={
          dlg
            ? `Revoke ${dlg.kind} ${titleOf(dlg.from_objective_id)} → ${titleOf(dlg.to_objective_id)} (${dlg.relation_id})? Revoking removes this edge's authority permanently — a revoked relation cannot be resumed. The row remains as a tombstone in the canonical list.`
            : ""
        }
        confirmLabel="Revoke relation"
        busy={mutBusy}
        onConfirm={() => {
          if (dlg) runCtl(dlg, "revoke");
        }}
        onCancel={() => setDlg(null)}
      />
    </section>
  );
}
