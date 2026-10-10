import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, apiAdmin } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type { LegacyObjectiveRow, OrgAgentRow, RoutineRow, WorkItemRow } from "../types";

/* P15.9-B5.2 — Workforce Administration (legacy Business-tab parity):
   org-agent creation, work-item creation + open/block/unblock/comment,
   routines create/enable/disable, legacy objective creation — all pinned
   to the SELECTED business with explicit confirmation per mutation. */

type Section<T> = { kind: "ready"; data: T } | { kind: "unavailable"; code: string };

type St =
  | { kind: "no-business" }
  | { kind: "loading" }
  | {
      kind: "ready";
      forBiz: string;
      agents: OrgAgentRow[];
      filteredOut: number;
      items: Section<WorkItemRow[]>;
      routines: Section<RoutineRow[]>;
      objectives: Section<LegacyObjectiveRow[]>;
    }
  | { kind: "error"; err: ApiError };

/* Every mutation dialog pins {op, biz, target, payload} at open —
   invalidated on business change, never retargeted. */
type Dlg =
  | { op: "create-agent"; biz: string; payload: AgentForm }
  | { op: "create-wi"; biz: string; payload: WiForm }
  | { op: "open-wi" | "unblock-wi"; biz: string; target: string; title: string }
  | { op: "block-wi" | "comment-wi"; biz: string; target: string; title: string; text: string }
  | { op: "create-routine"; biz: string; payload: RtForm }
  | { op: "toggle-routine"; biz: string; target: string; enable: boolean; name: string }
  | { op: "create-objective"; biz: string; payload: ObjForm };

type AgentForm = { title: string; department: string; role: string; reports_to: string; executor_binding: string };
type WiForm = { title: string; goal: string; department: string; assignee: string; objective: string; priority: string };
type RtForm = { name: string; goal_template: string; cron: string; department: string; assignee: string };
type ObjForm = { title: string; description: string; metric: string; target: string };

const EMPTY_AGENT: AgentForm = { title: "", department: "", role: "", reports_to: "", executor_binding: "" };
const EMPTY_WI: WiForm = { title: "", goal: "", department: "", assignee: "", objective: "", priority: "50" };
const EMPTY_RT: RtForm = { name: "", goal_template: "", cron: "", department: "", assignee: "" };
const EMPTY_OBJ: ObjForm = { title: "", description: "", metric: "", target: "" };

function dlgTitle(d: Dlg): string {
  switch (d.op) {
    case "open-wi": return "Open work item";
    case "block-wi": return "Block work item";
    case "unblock-wi": return "Unblock work item";
    case "comment-wi": return "Add comment";
    case "toggle-routine": return d.enable ? "Enable routine" : "Disable routine";
    default: return "Confirm creation";
  }
}

function dlgBody(d: Dlg, biz: string): string {
  switch (d.op) {
    case "open-wi":
      return `OPEN ${d.target} ("${d.title}")? HIGH-IMPACT: this commits the canonical openWorkItem trigger — it can start governed mission execution. Backend enforces lifecycle/scope/dependency gates; this UI adds no shortcut around them.`;
    case "block-wi":
      return `BLOCK ${d.target} ("${d.title}") with the reason below? Commits the canonical block mutation (pauses any bound in-flight mission first).`;
    case "unblock-wi":
      return `UNBLOCK ${d.target} ("${d.title}") → READY? Commits the canonical unblock mutation.`;
    case "comment-wi":
      return `Add comment on ${d.target} ("${d.title}")?`;
    case "toggle-routine":
      return `${d.enable ? "ENABLE" : "DISABLE"} routine "${d.name}" (${d.target})? Commits the canonical enable/disable on the underlying mission_schedule.`;
    case "create-agent":
      return `Create agent "${d.payload.title}" in department "${d.payload.department}" for ${biz}? POSTs /api/org-agents — the backend auto-materializes a baseline execution contract.`;
    case "create-wi":
      return `Create work item "${d.payload.title}" in ${biz}? POSTs /api/work-items — created, never auto-opened.`;
    case "create-routine":
      return `Create routine "${d.payload.name}" (${d.payload.cron}) in ${biz}? POSTs /api/routines — compiles into a canonical mission_schedule, enabled by default.`;
    case "create-objective":
      return `Create legacy objective "${d.payload.title}" in ${biz}? POSTs /api/objectives — the LEGACY compat contract, distinct from the canonical vnext Objective UI.`;
  }
}

const WI_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "purple" | "unknown"> = {
  BACKLOG: "unknown", READY: "info", IN_PROGRESS: "purple",
  REVIEW_REQUIRED: "warn", BLOCKED: "danger", DONE: "ok", CANCELLED: "unknown",
};

export function WorkforceAdmin() {
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [agentForm, setAgentForm] = useState<AgentForm>(EMPTY_AGENT);
  const [wiForm, setWiForm] = useState<WiForm>(EMPTY_WI);
  const [rtForm, setRtForm] = useState<RtForm>(EMPTY_RT);
  const [objForm, setObjForm] = useState<ObjForm>(EMPTY_OBJ);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [createdAgent, setCreatedAgent] = useState<string | null>(null);
  const opSeq = useRef(0);
  const lastIdent = useRef<string | null>(null);

  useEffect(() => {
    /* identity change (biz) closes dialogs, clears notes and bumps the
       in-flight guard — a tick refetch must not wipe a committed note */
    const changed = lastIdent.current !== biz;
    if (changed) {
      lastIdent.current = biz;
      setDlg(null);
      setMutNote(null);
      setMutBusy(false);
      setCreatedAgent(null);
      ++opSeq.current;
    }
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    const forBiz = biz;
    (async () => {
      const [agentsR, itemsR, routinesR, objectivesR] = await Promise.allSettled([
        api.orgAgents(ctl.signal),
        api.workItems(forBiz, ctl.signal),
        apiAdmin.routines(forBiz, ctl.signal),
        apiAdmin.legacyObjectives(forBiz, ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      if (agentsR.status === "rejected") {
        const e = agentsR.reason;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      const all = Array.isArray(agentsR.value.agents) ? agentsR.value.agents : [];
      const sect = <I, O>(r: PromiseSettledResult<I>, pick: (v: I) => O | null): Section<O> =>
        r.status === "rejected"
          ? { kind: "unavailable", code: r.reason instanceof ApiError ? r.reason.code : "ERROR" }
          : pick(r.value) === null
            ? { kind: "unavailable", code: "MALFORMED" }
            : { kind: "ready", data: pick(r.value) as O };
      setSt({
        kind: "ready",
        forBiz,
        agents: all.filter((a) => a.business_id === forBiz),
        filteredOut: all.length - all.filter((a) => a.business_id === forBiz).length,
        items: sect(itemsR, (v) => (Array.isArray(v.work_items) ? v.work_items : null)),
        routines: sect(routinesR, (v) => (Array.isArray(v.routines) ? v.routines : null)),
        objectives: sect(objectivesR, (v) => (Array.isArray(v.objectives) ? v.objectives : null)),
      });
    })();
    return () => ctl.abort();
  }, [biz, tick]);

  const note = (s: string) => setMutNote(s);
  const failNote = (e: unknown, what: string) =>
    note(
      e instanceof ApiError
        ? e.status === 0 || e.status >= 500
          ? `${what} result AMBIGUOUS (${e.code}) — may have committed; refetch before retrying. No automatic retry.`
          : `${what} failed: ${e.detail || e.message} (${e.code})`
        : `${what} result AMBIGUOUS — ${String(e)}. Refetch before retrying.`,
    );

  const submit = async () => {
    if (!dlg || mutBusy || dlg.biz !== biz) return;
    const d = dlg;
    const seq = ++opSeq.current;
    setMutBusy(true);
    setMutNote(null);
    try {
      switch (d.op) {
        case "create-agent": {
          const p = d.payload;
          const row = await apiAdmin.createOrgAgent({
            business_id: d.biz, title: p.title.trim(), department: p.department.trim(),
            ...(p.role.trim() ? { role: p.role.trim() } : {}),
            ...(p.reports_to ? { reports_to: p.reports_to } : {}),
            ...(p.executor_binding.trim() ? { executor_binding: p.executor_binding.trim() } : {}),
          });
          if (seq !== opSeq.current) return;
          setCreatedAgent(String(row.agent_id));
          setAgentForm(EMPTY_AGENT);
          note(`Agent created — ${row.agent_id} (baseline contract auto-materialized by the backend)`);
          break;
        }
        case "create-wi": {
          const p = d.payload;
          const row = await apiAdmin.createWorkItem({
            business_id: d.biz, title: p.title.trim(), goal: p.goal.trim(),
            ...(p.department.trim() ? { department: p.department.trim() } : {}),
            ...(p.assignee ? { assignee_agent_id: p.assignee } : {}),
            ...(p.objective ? { objective_id: p.objective } : {}),
            ...(p.priority.trim() !== "" && !Number.isNaN(Number(p.priority)) ? { priority: Number(p.priority) } : {}),
          });
          if (seq !== opSeq.current) return;
          setWiForm(EMPTY_WI);
          note(`Work item created — ${row.work_item_id} (${String(row.status)}; not auto-opened)`);
          break;
        }
        case "open-wi":
          await apiAdmin.workItemAction(d.target, "open");
          if (seq !== opSeq.current) return;
          note(`Open committed for ${d.target} — governed execution trigger accepted by the backend.`);
          break;
        case "block-wi":
          await apiAdmin.workItemAction(d.target, "block", { reason: d.text.trim() });
          if (seq !== opSeq.current) return;
          note(`Blocked ${d.target}.`);
          break;
        case "unblock-wi":
          await apiAdmin.workItemAction(d.target, "unblock");
          if (seq !== opSeq.current) return;
          note(`Unblocked ${d.target} → READY.`);
          break;
        case "comment-wi":
          await apiAdmin.workItemComment(d.target, d.text.trim());
          if (seq !== opSeq.current) return;
          note(`Comment added on ${d.target}.`);
          break;
        case "create-routine": {
          const p = d.payload;
          const row = await apiAdmin.createRoutine({
            business_id: d.biz, name: p.name.trim(), goal_template: p.goal_template.trim(),
            cron: p.cron.trim(),
            ...(p.department.trim() ? { department: p.department.trim() } : {}),
            ...(p.assignee ? { assignee_agent_id: p.assignee } : {}),
          });
          if (seq !== opSeq.current) return;
          setRtForm(EMPTY_RT);
          note(`Routine created — ${row.routine_id} (ENABLED via canonical mission_schedule)`);
          break;
        }
        case "toggle-routine":
          await apiAdmin.routineAction(d.target, d.enable ? "enable" : "disable");
          if (seq !== opSeq.current) return;
          note(`Routine ${d.target} ${d.enable ? "enabled" : "disabled"}.`);
          break;
        case "create-objective": {
          const p = d.payload;
          const row = await apiAdmin.createLegacyObjective({
            business_id: d.biz, title: p.title.trim(),
            ...(p.description.trim() ? { description: p.description.trim() } : {}),
            ...(p.metric.trim() ? { metric: p.metric.trim() } : {}),
            ...(p.target.trim() ? { target: p.target.trim() } : {}),
          });
          if (seq !== opSeq.current) return;
          setObjForm(EMPTY_OBJ);
          note(`Legacy objective created — ${row.objective_id}`);
          break;
        }
      }
      setTick((t) => t + 1);
    } catch (e) {
      if (seq === opSeq.current) failNote(e, d.op.replace(/-/g, " "));
    } finally {
      if (seq === opSeq.current) setMutBusy(false);
    }
    setDlg(null);
  };

  if (st.kind === "no-business") {
    return (
      <EmptyState
        title="No business selected"
        detail="Workforce administration is bound to the selected business — pick one in the switcher first."
      />
    );
  }
  if (st.kind === "error") return <div className="page"><StatusBadge tone="danger" label="ERROR" /><span className="note">{st.err.detail || st.err.code}</span></div>;
  if (st.kind === "loading" || st.forBiz !== biz) {
    return (
      <div className="page"><h1>Workforce Administration</h1><Skeleton height={18} /><Skeleton height={140} /><Skeleton height={200} /></div>
    );
  }

  const activeAgents = st.agents.filter((a) => a.status === "ACTIVE");
  const items = st.items.kind === "ready" ? st.items.data : null;
  const routines = st.routines.kind === "ready" ? st.routines.data : null;
  const objectives = st.objectives.kind === "ready" ? st.objectives.data : null;
  const agentOpts = st.agents;
  const openable = (w: WorkItemRow) => w.status === "BACKLOG" || w.status === "READY";
  const blockable = (w: WorkItemRow) => !["BLOCKED", "DONE", "CANCELLED"].includes(w.status);
  const unblockable = (w: WorkItemRow) => w.status === "BLOCKED";

  return (
    <div className="page">
      <h1>Workforce Administration</h1>
      <p className="sub srcnote">
        Agents come from <code>GET /api/org-agents</code> — a global, unfiltered read filtered
        client-side to <code>{biz}</code> ({st.filteredOut} row(s) of other businesses hidden). This is
        NOT server-side authorization. All mutations POST through existing canonical seams.
      </p>

      {/* ---------- create agent ---------- */}
      <h2 className="sech">Create org agent</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">Title*</span>
          <input className="inp" aria-label="agent title" value={agentForm.title}
            onChange={(e) => setAgentForm((f) => ({ ...f, title: e.target.value }))} placeholder="Backend Engineer" />
        </div>
        <div className="nrow">
          <span className="tt">Department*</span>
          <input className="inp" aria-label="agent department" value={agentForm.department}
            onChange={(e) => setAgentForm((f) => ({ ...f, department: e.target.value }))} placeholder="engineering" />
        </div>
        <div className="nrow">
          <span className="tt">Role</span>
          <input className="inp" aria-label="agent role" value={agentForm.role}
            onChange={(e) => setAgentForm((f) => ({ ...f, role: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Reports to</span>
          <select className="inp" aria-label="reports to" value={agentForm.reports_to}
            onChange={(e) => setAgentForm((f) => ({ ...f, reports_to: e.target.value }))}>
            <option value="">— none —</option>
            {agentOpts.map((a) => (
              <option key={String(a.agent_id)} value={String(a.agent_id)}>{a.title} ({String(a.agent_id).slice(0, 12)}…)</option>
            ))}
          </select>
          <span className="note">only agents of this business are selectable — cross-business reports_to can never be submitted (backend: FAIL_CLOSED_ORG_AGENT_SCOPE)</span>
        </div>
        <div className="nrow">
          <span className="tt">Executor binding</span>
          <input className="inp" aria-label="executor binding" value={agentForm.executor_binding}
            onChange={(e) => setAgentForm((f) => ({ ...f, executor_binding: e.target.value }))} placeholder="codex / devin / …" />
        </div>
        {(!agentForm.title.trim() || !agentForm.department.trim()) ? (
          <div className="nrow"><span className="note">title and department are required.</span></div>
        ) : null}
        <div className="actbar">
          <button className="tbtn" disabled={!agentForm.title.trim() || !agentForm.department.trim()}
            onClick={() => setDlg({ op: "create-agent", biz, payload: { ...agentForm } })}>
            Create agent…
          </button>
        </div>
        {createdAgent ? (
          <div className="nrow">
            <StatusBadge tone="ok" label="CREATED" />
            <Link className="lnk" to={`/app/workforce/${createdAgent}`}>open {createdAgent} in Agent Detail</Link>
          </div>
        ) : null}
      </div>

      {/* ---------- create work item ---------- */}
      <h2 className="sech">Create work item</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">Title*</span>
          <input className="inp" aria-label="work item title" value={wiForm.title}
            onChange={(e) => setWiForm((f) => ({ ...f, title: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Goal*</span>
          <input className="inp" aria-label="work item goal" value={wiForm.goal}
            onChange={(e) => setWiForm((f) => ({ ...f, goal: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Department</span>
          <input className="inp" aria-label="work item department" value={wiForm.department}
            onChange={(e) => setWiForm((f) => ({ ...f, department: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Assignee</span>
          <select className="inp" aria-label="assignee" value={wiForm.assignee}
            onChange={(e) => setWiForm((f) => ({ ...f, assignee: e.target.value }))}>
            <option value="">— unassigned (BACKLOG) —</option>
            {activeAgents.map((a) => (
              <option key={String(a.agent_id)} value={String(a.agent_id)}>{a.title} ({String(a.agent_id).slice(0, 12)}…)</option>
            ))}
          </select>
          <span className="note">same-business ACTIVE agents only (backend: FAIL_CLOSED_WORK_ITEM_SCOPE / AGENT_INACTIVE)</span>
        </div>
        <div className="nrow">
          <span className="tt">Objective</span>
          <select className="inp" aria-label="objective" value={wiForm.objective}
            onChange={(e) => setWiForm((f) => ({ ...f, objective: e.target.value }))}>
            <option value="">— none —</option>
            {(objectives ?? []).map((o) => (
              <option key={String(o.objective_id)} value={String(o.objective_id)}>{o.title} ({String(o.objective_id).slice(0, 12)}…)</option>
            ))}
          </select>
          {objectives === null ? <span className="note">objective list unavailable — leave empty or retry later.</span> : null}
        </div>
        <div className="nrow">
          <span className="tt">Priority</span>
          <input className="inp" aria-label="priority" value={wiForm.priority} style={{ width: 90 }}
            onChange={(e) => setWiForm((f) => ({ ...f, priority: e.target.value.replace(/[^0-9]/g, "") }))} />
        </div>
        {(!wiForm.title.trim() || !wiForm.goal.trim()) ? (
          <div className="nrow"><span className="note">title and goal are required.</span></div>
        ) : null}
        <div className="actbar">
          <button className="tbtn" disabled={!wiForm.title.trim() || !wiForm.goal.trim()}
            onClick={() => setDlg({ op: "create-wi", biz, payload: { ...wiForm } })}>
            Create work item…
          </button>
          <span className="note">a new work item is never auto-opened — open is a separate confirmed governed trigger.</span>
        </div>
      </div>

      {/* ---------- work items ---------- */}
      <h2 className="sech">Work items</h2>
      {st.items.kind === "unavailable" ? (
        <div className="need"><div className="nrow"><StatusBadge tone="warn" label="UNAVAILABLE" />
          <span className="note">work-item read unavailable ({st.items.code}) — not shown as empty.</span></div></div>
      ) : items!.length === 0 ? (
        <EmptyState title="No work items" detail="Create one above — it lands in BACKLOG until assigned/opened." />
      ) : (
        <div className="need">
          {items!.map((w) => (
            <div className="nrow" key={String(w.work_item_id)}>
              <StatusBadge tone={WI_TONE[w.status] ?? "unknown"} label={w.status} />
              <span className="tt">{w.title}</span>
              <code className="note">{String(w.work_item_id)}</code>
              <span className="note">
                {w.assignee_agent_id ? `→ ${String(w.assignee_agent_id).slice(0, 12)}…` : "unassigned"}
                {w.department ? ` · ${w.department}` : ""} · p{String(w.priority ?? 50)}
                {w.blocked_code ? ` · ${w.blocked_code}` : ""}
              </span>
              {openable(w) ? (
                <button className="tbtn" onClick={() => setDlg({ op: "open-wi", biz, target: String(w.work_item_id), title: w.title })}>Open…</button>
              ) : null}
              {blockable(w) ? (
                <button className="tbtn danger" onClick={() => setDlg({ op: "block-wi", biz, target: String(w.work_item_id), title: w.title, text: "" })}>Block…</button>
              ) : null}
              {unblockable(w) ? (
                <button className="tbtn" onClick={() => setDlg({ op: "unblock-wi", biz, target: String(w.work_item_id), title: w.title })}>Unblock…</button>
              ) : null}
              <button className="tbtn" onClick={() => setDlg({ op: "comment-wi", biz, target: String(w.work_item_id), title: w.title, text: "" })}>Comment…</button>
            </div>
          ))}
        </div>
      )}

      {/* ---------- routines ---------- */}
      <h2 className="sech">Routines (legacy parity)</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">Name*</span>
          <input className="inp" aria-label="routine name" value={rtForm.name}
            onChange={(e) => setRtForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Goal template*</span>
          <input className="inp" aria-label="goal template" value={rtForm.goal_template}
            onChange={(e) => setRtForm((f) => ({ ...f, goal_template: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Cron*</span>
          <input className="inp" aria-label="cron" value={rtForm.cron} style={{ width: 200 }}
            onChange={(e) => setRtForm((f) => ({ ...f, cron: e.target.value }))} placeholder="0 9 * * 1-5" />
        </div>
        <div className="nrow">
          <span className="tt">Department</span>
          <input className="inp" aria-label="routine department" value={rtForm.department}
            onChange={(e) => setRtForm((f) => ({ ...f, department: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Assignee</span>
          <select className="inp" aria-label="routine assignee" value={rtForm.assignee}
            onChange={(e) => setRtForm((f) => ({ ...f, assignee: e.target.value }))}>
            <option value="">— none —</option>
            {activeAgents.map((a) => (
              <option key={String(a.agent_id)} value={String(a.agent_id)}>{a.title}</option>
            ))}
          </select>
        </div>
        <div className="actbar">
          <button className="tbtn"
            disabled={!rtForm.name.trim() || !rtForm.goal_template.trim() || !rtForm.cron.trim()}
            onClick={() => setDlg({ op: "create-routine", biz, payload: { ...rtForm } })}>
            Create routine…
          </button>
        </div>
      </div>
      {st.routines.kind === "unavailable" ? (
        <div className="need"><div className="nrow"><StatusBadge tone="warn" label="UNAVAILABLE" />
          <span className="note">routine read unavailable ({st.routines.code}) — not shown as empty.</span></div></div>
      ) : routines!.length === 0 ? (
        <EmptyState title="No routines" detail="No routines exist for this business." />
      ) : (
        <div className="need">
          {routines!.map((r) => (
            <div className="nrow" key={String(r.routine_id)}>
              <StatusBadge tone={r.enabled ? "ok" : "unknown"} label={r.enabled ? "ENABLED" : "DISABLED"} />
              <span className="tt">{r.name}</span>
              <code className="note">{r.cron}</code>
              <span className="note">{r.department || "—"}</span>
              <button className="tbtn"
                onClick={() => setDlg({ op: "toggle-routine", biz, target: String(r.routine_id), enable: !r.enabled, name: r.name })}>
                {r.enabled ? "Disable…" : "Enable…"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---------- legacy objectives ---------- */}
      <h2 className="sech">Legacy objectives (compat API)</h2>
      <p className="sub">
        <code>POST /api/objectives</code> is the LEGACY compat contract — distinct from the canonical
        vnext Objective UI (<Link className="lnk" to="/app/objectives">/app/objectives</Link>). Kept for
        parity with the legacy Business tab; not a replacement.
      </p>
      <div className="need">
        <div className="nrow">
          <span className="tt">Title*</span>
          <input className="inp" aria-label="legacy objective title" value={objForm.title}
            onChange={(e) => setObjForm((f) => ({ ...f, title: e.target.value }))} />
        </div>
        <div className="nrow">
          <span className="tt">Metric / Target</span>
          <input className="inp" aria-label="metric" value={objForm.metric} style={{ width: "45%" }}
            onChange={(e) => setObjForm((f) => ({ ...f, metric: e.target.value }))} placeholder="metric" />
          <input className="inp" aria-label="target" value={objForm.target} style={{ width: "45%" }}
            onChange={(e) => setObjForm((f) => ({ ...f, target: e.target.value }))} placeholder="target" />
        </div>
        <div className="nrow">
          <span className="tt">Description</span>
          <input className="inp" aria-label="objective description" value={objForm.description}
            onChange={(e) => setObjForm((f) => ({ ...f, description: e.target.value }))} />
        </div>
        <div className="actbar">
          <button className="tbtn" disabled={!objForm.title.trim()}
            onClick={() => setDlg({ op: "create-objective", biz, payload: { ...objForm } })}>
            Create legacy objective…
          </button>
        </div>
      </div>
      {st.objectives.kind === "unavailable" ? (
        <div className="need"><div className="nrow"><StatusBadge tone="warn" label="UNAVAILABLE" />
          <span className="note">objective read unavailable ({st.objectives.code}) — not shown as empty.</span></div></div>
      ) : objectives!.length === 0 ? (
        <EmptyState title="No legacy objectives" detail="No legacy objectives exist for this business." />
      ) : (
        <div className="need">
          {objectives!.map((o) => (
            <div className="nrow" key={String(o.objective_id)}>
              <span className="tt">{o.title}</span>
              <code className="note">{String(o.objective_id)}</code>
              {o.metric || o.target ? <span className="note">{String(o.metric ?? "")} → {String(o.target ?? "")}</span> : null}
            </div>
          ))}
        </div>
      )}

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      <ConfirmDialog
        open={dlg !== null && dlg.biz === biz}
        title={dlg ? dlgTitle(dlg) : ""}
        body={dlg ? dlgBody(dlg, biz!) : ""}
        confirmLabel={
          dlg?.op === "open-wi" ? "Open" : dlg?.op === "block-wi" ? "Block" : dlg?.op === "unblock-wi" ? "Unblock"
            : dlg?.op === "toggle-routine" ? (dlg.enable ? "Enable" : "Disable") : "Confirm"
        }
        busy={mutBusy}
        confirmDisabled={
          (dlg?.op === "block-wi" || dlg?.op === "comment-wi") && !dlg.text.trim()
        }
        onConfirm={submit}
        onCancel={() => setDlg(null)}
      >
        {(dlg?.op === "block-wi" || dlg?.op === "comment-wi") ? (
          <input
            className="inp"
            aria-label={dlg.op === "block-wi" ? "block reason" : "comment body"}
            placeholder={dlg.op === "block-wi" ? "reason (required)" : "comment (required)"}
            value={dlg.text}
            onChange={(e) =>
              setDlg((d) => (d && (d.op === "block-wi" || d.op === "comment-wi") ? { ...d, text: e.target.value } : d))
            }
          />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
