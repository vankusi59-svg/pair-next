import { useParams } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { useLiveRefresh } from "../hooks/eventBus";
import { StateBadge, TaskBadge } from "../components/Badge";
import { DagView } from "../components/Dag";
import { Timeline } from "../components/Timeline";

export function MissionDetail() {
  const { id = "" } = useParams();
  const detail = useApi(() => api.missionDetail(id), [id], 3000);
  const dag = useApi(() => api.missionDag(id), [id], 3000);
  const timeline = useApi(() => api.timeline(id), [id], 3000);
  const evidence = useApi(() => api.evidence(id), [id], 5000);
  useLiveRefresh(detail.reload);
  useLiveRefresh(timeline.reload);

  if (detail.loading && !detail.data) return <div className="state">Loading mission…</div>;
  if (detail.error) return <div className="state err">{String(detail.error)}</div>;
  const d = detail.data;
  if (!d) return <div className="state">Not found.</div>;

  const mission = (d.mission ?? {}) as Record<string, unknown>;
  const runtime = d.runtime as Record<string, unknown> | null;
  const st = String(runtime?.state ?? mission.state ?? "");

  const act = async (a: "pause" | "resume" | "cancel" | "acknowledge") => {
    try {
      await api.missionAction(id, a);
      detail.reload();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="page">
      <h1>Mission <span className="mono">{id.slice(0, 24)}</span></h1>
      <div className="row">
        <StateBadge state={st} />
        {st === "RUNNING" && <button onClick={() => act("pause")}>Pause</button>}
        {st === "PAUSED" && <button onClick={() => act("resume")}>Resume</button>}
        {!["COMPLETED", "FAILED", "CANCELLED", "ABORTED"].includes(st) && (
          <button className="danger" onClick={() => act("cancel")}>Cancel</button>
        )}
        {["COMPLETED", "FAILED", "CANCELLED", "ABORTED"].includes(st) && (
          <button onClick={() => act("acknowledge")}>Acknowledge</button>
        )}
      </div>
      <p className="goal">{String(mission.goal ?? "")}</p>

      <section>
        <h2>Task graph ({d.task_count})</h2>
        <DagView dag={dag.data ?? { nodes: [], edges: [] }} />
      </section>

      <section>
        <h2>Tasks</h2>
        <table className="tbl">
          <thead><tr><th>Key</th><th>Instruction</th><th>Executor</th><th>Status</th></tr></thead>
          <tbody>
            {(d.tasks ?? []).map((t) => (
              <tr key={String(t.task_id)}>
                <td className="mono">{String(t.task_key)}</td>
                <td className="goal">{String(t.task_instruction ?? t.title ?? "")}</td>
                <td>{String(t.selected_executor ?? "—")}</td>
                <td><TaskBadge state={t.status as string} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Executions</h2>
        <table className="tbl">
          <thead><tr><th>Execution</th><th>Executor</th><th>State</th><th>Artifacts</th></tr></thead>
          <tbody>
            {(d.executions ?? []).map((x) => {
              const res = (x.result ?? {}) as Record<string, unknown>;
              const arts = (res.artifacts ?? []) as Array<Record<string, unknown>>;
              return (
                <tr key={String(x.execution_id)}>
                  <td className="mono">{String(x.execution_id).slice(0, 20)}</td>
                  <td>{String(x.executor_id)}</td>
                  <td><TaskBadge state={x.execution_state as string} /></td>
                  <td className="mono">{arts.map((a) => String(a.path)).join(", ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {d.approvals_pending?.length > 0 && (
        <section>
          <h2 className="warn">Pending approvals — operator action required</h2>
          <table className="tbl">
            <tbody>
              {(d.approvals_pending).map((a) => (
                <tr key={String(a.approval_id ?? a.entity_id)}>
                  <td className="mono">{String(a.approval_id ?? a.entity_id)}</td>
                  <td>{String(a.reason ?? a.kind ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Timeline</h2>
        <Timeline entries={timeline.data ?? []} />
      </section>

      <section>
        <h2>Evidence ({evidence.data?.length ?? 0})</h2>
        <table className="tbl">
          <thead><tr><th>Kind</th><th>Entity</th><th>At</th></tr></thead>
          <tbody>
            {(evidence.data ?? []).map((e, i) => (
              <tr key={i}>
                <td>{String(e.kind)}</td>
                <td className="mono">{String(e.entity_id ?? "")}</td>
                <td className="muted">{String(e.created_at ?? "").replace("T", " ").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
