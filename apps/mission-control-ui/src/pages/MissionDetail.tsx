import { useParams } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks/useApi";
import { useLiveRefresh } from "../hooks/eventBus";
import { StateBadge, TaskBadge } from "../components/Badge";
import { DagView } from "../components/Dag";
import { Timeline } from "../components/Timeline";
import { toast } from "../components/Toast";

export function MissionDetail() {
  const { id = "" } = useParams();
  const detail = useApi(() => api.missionDetail(id), [id], 3000);
  const dag = useApi(() => api.missionDag(id), [id], 3000);
  const timeline = useApi(() => api.timeline(id), [id], 3000);
  const evidence = useApi(() => api.evidence(id), [id], 5000);
  const files = useApi(() => api.missionFiles(id), [id], 4000);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  useLiveRefresh(detail.reload);
  useLiveRefresh(timeline.reload);
  useLiveRefresh(files.reload);

  const openFile = async (p: string) => {
    setFileErr(null);
    try {
      const f = await api.missionFile(id, p);
      setFileView({ path: f.path, content: f.content, truncated: f.truncated });
    } catch (e) {
      setFileView(null);
      setFileErr(String(e));
    }
  };

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
      toast(`${a} accepted`, "ok");
      detail.reload();
    } catch (e) {
      toast(String(e), "err");
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

      <section>
        <h2>Workspace files</h2>
        {(files.data?.files ?? []).length === 0 ? (
          <p className="muted">No files in the mission workspace yet.</p>
        ) : (
          <table className="tbl">
            <thead><tr><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>
              {(files.data?.files ?? []).map((f) => (
                <tr key={String(f.path)}>
                  <td className="mono">
                    <a href="#" onClick={(e) => { e.preventDefault(); void openFile(String(f.path)); }}>
                      {String(f.path)}
                    </a>
                  </td>
                  <td className="muted">{Number(f.size)} B</td>
                  <td className="muted">{String(f.modified_at ?? "").replace("T", " ").slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {fileErr && <div className="state err">{fileErr}</div>}
        {fileView && (
          <div className="card" style={{ marginTop: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong className="mono">{fileView.path}</strong>
              <button onClick={() => setFileView(null)}>close</button>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", marginTop: 8 }}>
              {fileView.content}
            </pre>
            {fileView.truncated && <p className="muted">… truncated at 256 KB</p>}
          </div>
        )}
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
