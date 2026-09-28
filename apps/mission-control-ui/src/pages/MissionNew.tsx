import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getOperatorId } from "../api";
import { useApi } from "../hooks/useApi";

export function MissionNew() {
  const projects = useApi(() => api.projects());
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const submit = async () => {
    if (!getOperatorId()) {
      setErr("Set an operator id (top-right) first — mutations are operator-bound.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const proj = (projects.data ?? []).find((p) => String(p.project_id) === projectId);
      const m = await api.startMission(goal, projectId, {
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: proj ? [String(proj.root_location)] : undefined,
      });
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
      <p className="muted">Describe the goal in natural language. The governed planner produces the task graph; routing chooses executors — the UI never decides.</p>
      <label>Goal</label>
      <textarea rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. create a manifest file, then a script that prints it" />
      <label>Project</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">— pick a project —</option>
        {(projects.data ?? []).map((p) => (
          <option key={String(p.project_id)} value={String(p.project_id)}>
            {String(p.name)} ({String(p.root_location)})
          </option>
        ))}
      </select>
      {err && <div className="state err">{err}</div>}
      <div className="row">
        <button disabled={busy || !goal.trim() || !projectId} onClick={submit}>{busy ? "Submitting…" : "Submit mission"}</button>
      </div>
    </div>
  );
}
