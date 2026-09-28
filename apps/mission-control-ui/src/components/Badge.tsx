const STATE_STYLE: Record<string, { bg: string; fg: string; hint: string }> = {
  CREATED: { bg: "#334155", fg: "#cbd5e1", hint: "Mission created, queued for planning" },
  PLANNING: { bg: "#475569", fg: "#e2e8f0", hint: "Planner is drafting the task graph" },
  READY: { bg: "#475569", fg: "#e2e8f0", hint: "Plan approved internally, ready to run" },
  RUNNING: { bg: "#1d4ed8", fg: "#dbeafe", hint: "Tasks are dispatching to governed executors" },
  PAUSED: { bg: "#a16207", fg: "#fef3c7", hint: "Paused by operator — no new dispatches" },
  REPLANNING: { bg: "#7c3aed", fg: "#ede9fe", hint: "Runtime is producing a new plan revision" },
  WAITING_APPROVAL: { bg: "#c2410c", fg: "#ffedd5", hint: "Blocked on an operator approval boundary" },
  COMPLETED: { bg: "#15803d", fg: "#dcfce7", hint: "All tasks finished, artifacts validated" },
  FAILED: { bg: "#b91c1c", fg: "#fee2e2", hint: "Mission failed — see timeline/recovery" },
  CANCELLED: { bg: "#6b7280", fg: "#f3f4f6", hint: "Cancelled by operator" },
  ABORTED: { bg: "#7f1d1d", fg: "#fecaca", hint: "Aborted — fail-closed stop" },
};

const TASK_STYLE: Record<string, string> = {
  DISPATCH_AUTHORIZED: "#1d4ed8",
  COMPLETED: "#15803d",
  FAILED: "#b91c1c",
  PENDING: "#334155",
};

export function StateBadge({ state }: { state: string | null | undefined }) {
  const s = String(state ?? "UNKNOWN");
  const c = STATE_STYLE[s] ?? { bg: "#334155", fg: "#cbd5e1", hint: s };
  return (
    <span className="badge" style={{ background: c.bg, color: c.fg }} title={c.hint}>
      {s}
    </span>
  );
}

export function TaskBadge({ state }: { state: string | null | undefined }) {
  const s = String(state ?? "UNKNOWN");
  return (
    <span className="badge" style={{ background: TASK_STYLE[s] ?? "#334155" }} title={s}>
      {s}
    </span>
  );
}
