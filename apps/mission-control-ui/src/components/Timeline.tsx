import type { TimelineEntry } from "../types";

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (!entries.length) return <div className="muted">No activity yet.</div>;
  return (
    <ol className="timeline">
      {entries.map((e, i) => (
        <li key={i} className={`tl-${e.kind.toLowerCase()}`}>
          <span className="tl-time">{e.at?.replace("T", " ").slice(0, 19) ?? ""}</span>
          <span className="tl-kind">{e.kind}</span>
          <span className="tl-body">
            {e.kind === "EVENT"
              ? `${e.event_type} ${e.entity ?? ""}${e.new_state ? ` → ${e.new_state}` : ""}${e.actor ? ` (${e.actor})` : ""}`
              : `${e.evidence_kind}`}
          </span>
        </li>
      ))}
    </ol>
  );
}
