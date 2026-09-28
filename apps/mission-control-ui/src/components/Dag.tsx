import type { Dag } from "../types";
import { TaskBadge } from "./Badge";

/** Layered DAG layout: x = topo level (Kahn), y = index within level. */
export function DagView({ dag }: { dag: Dag }) {
  const nodes = dag.nodes;
  const edges = dag.edges;
  if (!nodes.length) return <div className="muted">No tasks.</div>;

  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.task_id, 0);
    adj.set(n.task_id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.to) || !indeg.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const level = new Map<string, number>();
  const queue = nodes.filter((n) => indeg.get(n.task_id) === 0).map((n) => n.task_id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nx of adj.get(cur) ?? []) {
      level.set(nx, Math.max(level.get(nx) ?? 0, (level.get(cur) ?? 0) + 1));
      if ((indeg.get(nx) ?? 1) - 1 === 0) queue.push(nx);
      indeg.set(nx, (indeg.get(nx) ?? 1) - 1);
    }
  }
  const levels = new Map<number, string[]>();
  for (const n of nodes) {
    const l = level.get(n.task_id) ?? 0;
    levels.set(l, [...(levels.get(l) ?? []), n.task_id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of levels) ids.forEach((id, i) => pos.set(id, { x: l * 240 + 20, y: i * 92 + 20 }));
  const W = Math.max(...[...levels.keys()]) * 240 + 260;
  const H = Math.max(...[...levels.values()].map((v) => v.length)) * 92 + 40;
  return (
    <div className="dag-wrap">
      <svg width={W} height={H} role="img" aria-label="task dependency graph">
        {edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          return (
            <line
              key={i}
              x1={a.x + 200}
              y1={a.y + 28}
              x2={b.x}
              y2={b.y + 28}
              stroke="#475569"
              strokeWidth={1.5}
              markerEnd="url(#arr)"
            />
          );
        })}
        <defs>
          <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#475569" />
          </marker>
        </defs>
        {nodes.map((n) => {
          const p = pos.get(n.task_id)!;
          return (
            <g key={n.task_id} transform={`translate(${p.x},${p.y})`}>
              <rect width={200} height={56} rx={8} fill="#1e293b" stroke="#334155" />
              <text x={10} y={20} fill="#e2e8f0" fontSize={12} fontWeight={600}>
                {n.task_key}
              </text>
              <text x={10} y={38} fill="#94a3b8" fontSize={10}>
                {n.selected_executor ?? "unrouted"}
              </text>
              <foreignObject x={120} y={30} width={76} height={22}>
                <TaskBadge state={n.status} />
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
