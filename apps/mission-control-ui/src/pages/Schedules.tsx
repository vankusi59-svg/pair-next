import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getOperatorId } from "../api";
import { useApi } from "../hooks/useApi";

interface Schedule {
  schedule_id: string;
  name: string | null;
  goal: string;
  cron: string;
  enabled: boolean;
  deleted?: boolean;
  next_due_at: string;
  last_fired_at: string | null;
  last_mission_id: string | null;
  last_error: string | null;
  run_count: number;
  operator_id: string;
}

const CRON_EXAMPLES = [
  { label: "mỗi sáng 07:00", value: "0 7 * * *" },
  { label: "mỗi giờ", value: "0 * * * *" },
  { label: "thứ 2 hàng tuần 08:00", value: "0 8 * * 1" },
  { label: "mỗi 30 phút", value: "*/30 * * * *" },
];

export function Schedules() {
  const { data, reload } = useApi(() => api.schedules());
  const projects = useApi(() => api.projects());
  const [goal, setGoal] = useState("");
  const [cron, setCron] = useState("0 7 * * *");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const schedules = ((data?.schedules ?? []) as unknown as Schedule[]).filter((s) => !s.deleted);

  const create = async () => {
    if (!getOperatorId()) {
      setErr("Set an operator id (top-right) first — schedules are operator-bound.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createSchedule({ goal, cron, name: name || undefined, project_id: projectId || undefined });
      setGoal("");
      setName("");
      reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "enable" | "disable" | "delete") => {
    if (!getOperatorId()) {
      setErr("Set an operator id first.");
      return;
    }
    try {
      await api.scheduleAction(id, action);
      reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="page">
      <h1>Schedules</h1>
      <p className="muted">
        Recurring mission triggers — at each due time a canonical mission is submitted with the
        schedule's operator identity, then goes through planner/routing/approvals like a manual one.
        Cron format: <code>min hour day-of-month month day-of-week</code> (UTC).
      </p>

      <section className="card">
        <h2>New schedule</h2>
        <label htmlFor="sname">Name (optional)</label>
        <input id="sname" value={name} onChange={(e) => setName(e.target.value)} placeholder="morning digest" />
        <label htmlFor="sgoal">Goal</label>
        <textarea id="sgoal" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. mỗi sáng tổng hợp 5 tin công nghệ vào file digest.txt" />
        <label htmlFor="scron">Cron</label>
        <input id="scron" className="mono" value={cron} onChange={(e) => setCron(e.target.value)} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {CRON_EXAMPLES.map((c) => (
            <button key={c.value} className="ghost" onClick={() => setCron(c.value)}>{c.label}</button>
          ))}
        </div>
        <label htmlFor="sproj">Project</label>
        <select id="sproj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">— default project —</option>
          {(projects.data ?? []).map((p) => (
            <option key={String(p.project_id)} value={String(p.project_id)}>{String(p.name)}</option>
          ))}
        </select>
        {err && <div className="state err">{err}</div>}
        <div className="row">
          <button disabled={busy || !goal.trim() || !cron.trim()} onClick={create}>
            {busy ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </section>

      <table className="tbl">
        <thead>
          <tr><th>Name / Goal</th><th>Cron</th><th>Next run</th><th>Last run</th><th>Runs</th><th>State</th><th></th></tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.schedule_id}>
              <td className="goal">
                {s.name && <strong>{s.name} — </strong>}
                {s.goal.slice(0, 80)}{s.goal.length > 80 ? "…" : ""}
                {s.last_error && <div className="state err" style={{ marginTop: 4 }}>{s.last_error}</div>}
              </td>
              <td className="mono">{s.cron}</td>
              <td className="mono">{s.enabled ? s.next_due_at?.slice(0, 16).replace("T", " ") : "—"}</td>
              <td className="mono">
                {s.last_fired_at ? s.last_fired_at.slice(0, 16).replace("T", " ") : "—"}
                {s.last_mission_id && (
                  <> · <Link to={`/missions/${s.last_mission_id}`}>mission</Link></>
                )}
              </td>
              <td className="mono">{s.run_count ?? 0}</td>
              <td><span className={`badge st-${s.enabled ? "completed" : "waiting"}`}>{s.enabled ? "ENABLED" : "DISABLED"}</span></td>
              <td className="row" style={{ gap: 4 }}>
                <button className="ghost" onClick={() => act(s.schedule_id, s.enabled ? "disable" : "enable")}>
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button className="danger" onClick={() => act(s.schedule_id, "delete")}>Delete</button>
              </td>
            </tr>
          ))}
          {schedules.length === 0 && (
            <tr><td colSpan={7} className="muted">No schedules yet — create one above.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
