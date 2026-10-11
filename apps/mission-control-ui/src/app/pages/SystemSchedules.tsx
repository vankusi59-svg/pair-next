import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiAdmin, getOperatorId } from "../../api";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { ScheduleRow, ProjectRow } from "../types";

/* P15.9-B5.5 Scope C — Schedules. A schedule mints REAL missions at
   future due times — creation/enable/disable/delete are operationally
   significant: explicit ConfirmDialog, single-flight, no optimistic
   success, canonical refetch, honest ambiguous outcome, no /api/tick.
   The backend list is GLOBAL/unfiltered and mutations accept any
   operator_id (requireOperator — NO per-owner authorization): labeled. */

type Sec<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; err: ApiError };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const errOf = (e: unknown): ApiError =>
  e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));

const CRON_EXAMPLES = [
  { label: "07:00 UTC daily", value: "0 7 * * *" },
  { label: "hourly", value: "0 * * * *" },
  { label: "Mon 08:00 UTC", value: "0 8 * * 1" },
  { label: "every 30 min", value: "*/30 * * * *" },
];

type PendingAction =
  | { kind: "create" }
  | { kind: "enable" | "disable" | "delete"; schedule: ScheduleRow };

export function SystemSchedules() {
  const [sec, setSec] = useState<Sec<ScheduleRow[]>>({ kind: "loading" });
  const [projects, setProjects] = useState<Sec<ProjectRow[]>>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [goal, setGoal] = useState("");
  const [cron, setCron] = useState("0 7 * * *");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setSec({ kind: "loading" });
    apiAdmin.schedules(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!isObj(r) || !Array.isArray(r.schedules)
          || !r.schedules.every((s) => isObj(s) && s.schedule_id != null)) {
          setSec({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/schedules returned a malformed payload") });
          return;
        }
        setSec({ kind: "ready", data: r.schedules });
      })
      .catch((e) => !ctl.signal.aborted && setSec({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, [refresh]);

  useEffect(() => {
    const ctl = new AbortController();
    apiAdmin.projects(ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (!Array.isArray(r) || !r.every((p) => isObj(p) && p.project_id != null)) {
          setProjects({ kind: "error", err: new ApiError(200, "MALFORMED", "GET /api/projects returned a malformed payload") });
          return;
        }
        setProjects({ kind: "ready", data: r });
      })
      .catch((e) => !ctl.signal.aborted && setProjects({ kind: "error", err: errOf(e) }));
    return () => ctl.abort();
  }, []);

  const confirmPending = async () => {
    /* single-flight: one in-flight POST, never aborted mid-flight */
    if (flight.current || !pending) return;
    if (!getOperatorId()) {
      setNote({ tone: "err", text: "Set an operator id (Settings) first — schedule mutations require x-operator-id." });
      setPending(null);
      return;
    }
    flight.current = true;
    setBusy(true);
    setNote(null);
    try {
      if (pending.kind === "create") {
        await apiAdmin.createSchedule({
          goal: goal.trim(), cron: cron.trim(),
          name: name.trim() || undefined, project_id: projectId || undefined,
        });
        setNote({ tone: "ok", text: "Schedule created — canonical list refetched." });
        setGoal(""); setName("");
      } else {
        await apiAdmin.scheduleAction(pending.schedule.schedule_id, pending.kind);
        setNote({ tone: "ok", text: `${pending.kind} applied to ${pending.schedule.schedule_id} — list refetched.` });
      }
      setPending(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      const ae = errOf(e);
      /* honest ambiguous outcome: a POST may have committed server-side;
         never claim failure, never auto-retry. */
      setNote({
        tone: "warn",
        text: `Mutation outcome not confirmed (${ae.code}) — the request may have been applied. The list is refetched from the canonical source; verify before retrying.`,
      });
      setPending(null);
      setRefresh((n) => n + 1);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };

  const rows = sec.kind === "ready" ? sec.data : [];
  const live = rows.filter((s) => s.deleted !== true);
  const deletedCount = rows.length - live.length;
  const createDisabled =
    busy || !goal.trim() || !cron.trim() || (projectId !== "" && projects.kind !== "ready");

  const pendingBody = pending === null ? "" : pending.kind === "create"
    ? `Create a recurring mission schedule. Goal: "${goal.trim().slice(0, 120)}". Cron: ${cron.trim()} (UTC)${projectId ? ` · project ${projectId}` : ""}. At each due time the backend will mint a REAL mission under operator ${getOperatorId() || "?"} — the same governed path as Task Entry.`
    : `${pending.kind.toUpperCase()} schedule ${pending.schedule.schedule_id} (${(pending.schedule.name ?? pending.schedule.goal ?? "").slice(0, 80)}). ${pending.kind === "delete"
        ? "Deletion is destructive — the schedule is marked deleted and will never fire again."
        : pending.kind === "enable"
          ? "Enabling lets the scheduler mint real missions at each due time (UTC)."
          : "Disabling stops future firings; the schedule row remains."}`;

  return (
    <div className="page">
      <h1>Schedules</h1>
      <p className="sub srcnote">
        <code>GET /api/schedules</code> — <strong>global, unfiltered</strong> registry (not "my
        schedules"). Cron semantics are <strong>UTC</strong> — never interpreted in browser or
        Vietnam time. Mutations require any operator id; the backend applies no per-owner check.
      </p>

      <section className="need" aria-label="create schedule">
        <h2>New schedule</h2>
        <div className="nrow" style={{ display: "block" }}>
          <label htmlFor="sname">Name (optional)</label>
          <input id="sname" className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="morning digest" />
          <label htmlFor="sgoal">Goal</label>
          <textarea id="sgoal" className="inp" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. mỗi sáng tổng hợp 5 tin công nghệ vào file digest.txt" />
          <label htmlFor="scron">Cron (UTC)</label>
          <input id="scron" className="inp mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {CRON_EXAMPLES.map((c) => (
              <button key={c.value} className="ghost" onClick={() => setCron(c.value)}>{c.label}</button>
            ))}
          </div>
          <label htmlFor="sproj">Project</label>
          {projects.kind === "error" ? (
            <p className="note">project list unavailable ({projects.err.code}) — explicit project selection is blocked; default-project submission still allowed.</p>
          ) : (
            <select id="sproj" className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— backend default project —</option>
              {projects.kind === "ready" ? projects.data.map((p) => (
                <option key={String(p.project_id)} value={String(p.project_id)}>{String(p.name ?? p.project_id)}</option>
              )) : null}
            </select>
          )}
          {note ? (
            <div className={`state ${note.tone === "err" ? "err" : ""}`} role="status"
              style={{ border: note.tone === "warn" ? "1px solid var(--warn, #b45309)" : undefined, padding: 8 }}>
              {note.text}
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={createDisabled}
              onClick={() => setPending({ kind: "create" })}>
              Create schedule…
            </button>
          </div>
        </div>
      </section>

      <section className="need" aria-label="schedule list">
        <h2>Registry ({live.length})</h2>
        {deletedCount > 0 ? (
          <p className="sub srcnote">{deletedCount} deleted schedule(s) hidden — backend marks them deleted; they never fire again.</p>
        ) : null}
        {sec.kind === "loading" ? <Skeleton height={140} /> : sec.kind === "error" ? (
          <ErrorState code={sec.err.code} detail={sec.err.detail} />
        ) : live.length === 0 ? (
          <EmptyState title="No schedules" detail="The global registry has no active schedules — create one above." />
        ) : (
          <div className="tbl-wrap"><table className="tbl">
            <thead>
              <tr><th>Name / Goal</th><th>Cron (UTC)</th><th>Operator</th><th>Next due</th><th>Last fired</th><th>Runs</th><th>State</th><th></th></tr>
            </thead>
            <tbody>
              {live.map((s) => (
                <tr key={s.schedule_id}>
                  <td className="goal">
                    {s.name ? <strong>{s.name} — </strong> : null}
                    {String(s.goal ?? "").slice(0, 80)}{String(s.goal ?? "").length > 80 ? "…" : ""}
                    {s.last_error ? <div className="state err" style={{ marginTop: 4 }}>{s.last_error}</div> : null}
                  </td>
                  <td className="mono">{s.cron ?? "—"}</td>
                  <td className="mono muted">{s.operator_id ?? "—"}</td>
                  <td className="mono">{s.enabled ? String(s.next_due_at ?? "").slice(0, 16).replace("T", " ") : "—"}</td>
                  <td className="mono">
                    {s.last_fired_at ? String(s.last_fired_at).slice(0, 16).replace("T", " ") : "—"}
                    {s.last_mission_id ? (
                      <> · <Link className="lnk" to={`/app/missions/${encodeURIComponent(String(s.last_mission_id))}`}>mission</Link></>
                    ) : null}
                  </td>
                  <td className="mono">{s.run_count ?? 0}</td>
                  <td><StatusBadge tone={s.enabled ? "ok" : "unknown"} label={s.enabled ? "ENABLED" : "DISABLED"} /></td>
                  <td className="row" style={{ gap: 4 }}>
                    <button className="ghost" disabled={busy}
                      onClick={() => setPending({ kind: s.enabled ? "disable" : "enable", schedule: s })}>
                      {s.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="danger" disabled={busy}
                      onClick={() => setPending({ kind: "delete", schedule: s })}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "create" ? "Confirm schedule creation"
          : pending ? `Confirm ${pending.kind}` : ""}
        body={pendingBody}
        confirmLabel={pending?.kind === "delete" ? "Delete schedule"
          : pending?.kind === "create" ? "Create schedule" : "Apply"}
        busy={busy}
        onConfirm={confirmPending}
        onCancel={() => !busy && setPending(null)}
      />
    </div>
  );
}
