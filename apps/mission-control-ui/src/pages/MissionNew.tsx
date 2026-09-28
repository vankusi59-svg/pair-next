import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getOperatorId } from "../api";
import { useApi } from "../hooks/useApi";
import { DagView } from "../components/Dag";
import type { Dag } from "../types";

interface PlanTask {
  task_key: string;
  title?: string;
  task_instruction?: string;
  required_capabilities: string[];
  depends_on: string[];
}

function planToDag(tasks: PlanTask[]): Dag {
  return {
    nodes: tasks.map((t) => ({
      task_id: t.task_key,
      task_key: t.task_key,
      title: t.title ?? t.task_key,
      status: "PROPOSED",
    })),
    edges: tasks.flatMap((t) => t.depends_on.map((d) => ({ from: d, to: t.task_key }))),
  };
}

export function MissionNew() {
  const projects = useApi(() => api.projects());
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");
  const [preview, setPreview] = useState<{ tasks: PlanTask[]; digest: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const submitPayload = () => {
    const proj = (projects.data ?? []).find((p) => String(p.project_id) === projectId);
    return {
      project_id: projectId,
      goal,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: proj ? [String(proj.root_location)] : [],
    };
  };

  const doPreview = async () => {
    if (!getOperatorId()) {
      setErr("Set an operator id (top-right) first — preview and submit are operator-bound.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.previewMission(submitPayload());
      setPreview({ tasks: r.plan.tasks as unknown as PlanTask[], digest: r.plan_digest });
    } catch (e) {
      setErr(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      const m = await api.startMission({ ...submitPayload(), confirm_plan: { digest: preview.digest } });
      nav(`/missions/${String(m.mission_id)}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>New mission</h1>
      <p className="muted">
        Submit is two steps: the governed planner proposes a plan, you review it, then confirm —
        the server rejects the submit if the plan digest changed since preview.
      </p>
      <label>Goal</label>
      <textarea rows={5} value={goal} onChange={(e) => { setGoal(e.target.value); setPreview(null); }} placeholder="e.g. record this objective in the workspace" />
      <label>Project</label>
      <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setPreview(null); }}>
        <option value="">— pick a project —</option>
        {(projects.data ?? []).map((p) => (
          <option key={String(p.project_id)} value={String(p.project_id)}>
            {String(p.name)} ({String(p.root_location)})
          </option>
        ))}
      </select>
      {err && <div className="state err">{err}</div>}

      {!preview ? (
        <div className="row">
          <button disabled={busy || !goal.trim() || !projectId} onClick={doPreview}>
            {busy ? "Planning…" : "Preview plan"}
          </button>
        </div>
      ) : (
        <section>
          <h2>Proposed plan — review before it runs</h2>
          <table className="tbl">
            <thead><tr><th>Task</th><th>Instruction</th><th>Capabilities</th><th>Depends on</th></tr></thead>
            <tbody>
              {preview.tasks.map((t) => (
                <tr key={t.task_key}>
                  <td className="mono">{t.task_key} · {t.title}</td>
                  <td className="goal">{t.task_instruction}</td>
                  <td className="mono">{t.required_capabilities.join(", ")}</td>
                  <td className="mono">{t.depends_on.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <DagView dag={planToDag(preview.tasks)} />
          <p className="muted mono">plan digest: {preview.digest.slice(0, 24)}…</p>
          <div className="row">
            <button onClick={doConfirm} disabled={busy}>{busy ? "Submitting…" : "Confirm & run"}</button>
            <button className="danger" onClick={() => setPreview(null)}>Discard</button>
          </div>
        </section>
      )}
    </div>
  );
}
